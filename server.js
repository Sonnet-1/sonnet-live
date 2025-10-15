require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ---------- Twilio webhook ---------- */
app.post("/voice", (req, res) => {
  const wsUrl = process.env.WS_PUBLIC_URL || `wss://${req.headers.host}/twilio-stream`;
  res.type("text/xml").send(
    `<Response>
       <Say voice="alice">Connecting you now.</Say>
       <Connect><Stream url="${wsUrl}"/></Connect>
     </Response>`
  );
});

/* ---------- Helpers ---------- */
const b64ToBuf = (b64) => Buffer.from(b64, "base64");

// Create Int16Array view with correct byteOffset/length
const bufToI16 = (buf) => new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);

// linear resample between 8k / 16k / 24k (Int16 in/out)
function resampleLinear(pcm, inRate, outRate) {
  if (inRate === outRate) return pcm;
  const ratio = outRate / inRate;
  const out = new Int16Array(Math.floor(pcm.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = src - i0;
    out[i] = (pcm[i0] * (1 - frac) + pcm[i1] * frac) | 0;
  }
  return out;
}

/* ----- G.711 μ-law encode/decode (standard, clean) ----- */
function muLawEncode(pcm) {
  const MU = 255;
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = Math.max(-32768, Math.min(32767, pcm[i]));
    const sign = s < 0 ? 0x80 : 0x00;
    s = Math.abs(s);

    // Convert from 16-bit linear PCM to μ-law.
    s = s + 132; // bias
    if (s > 32767) s = 32767;

    // Find exponent and mantissa
    let exponent = 7;
    for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (s >> ((exponent === 0 ? 1 : exponent) + 3)) & 0x0f;

    const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
    out[i] = ulawByte;
  }
  return out;
}

function muLawDecode(ulaw) {
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) {
    let u = ~ulaw[i];
    const sign = u & 0x80;
    let exponent = (u >> 4) & 0x07;
    let mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << (exponent === 0 ? 0 : exponent - 1);
    out[i] = sign ? -sample : sample;
  }
  return out;
}

/* ----- Twilio send helper: chunk into 20ms frames (160 bytes @ 8kHz) ----- */
function sendUlawToTwilio(twilioWS, streamSid, ulaw) {
  if (!streamSid || !twilioWS || twilioWS.readyState !== 1) return;
  const FRAME_BYTES = 160; // 20ms of 8kHz μ-law audio
  for (let off = 0; off < ulaw.length; off += FRAME_BYTES) {
    const slice = ulaw.subarray(off, Math.min(off + FRAME_BYTES, ulaw.length));
    const payloadB64 = Buffer.from(slice).toString("base64");
    if (twilioWS.readyState === 1) {
      twilioWS.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: payloadB64 }
      }));
    }
  }
}

/* ---------- OpenAI Realtime ---------- */
function connectOpenAI() {
  const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  return new WebSocket(url, { headers });
}

/* ---------- Bridge server ---------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-stream" });

wss.on("connection", (twilioWS) => {
  console.log("🔌 Twilio stream connected");
  twilioWS.binaryType = "arraybuffer";

  let streamSid = null;
  let aiSpeaking = false;
  let requestedThisTurn = false;
  let debounceTimer = null;

  const openaiWS = connectOpenAI();
  openaiWS.binaryType = "arraybuffer";

  openaiWS.on("open", () => {
    console.log("🟢 OpenAI Realtime connected");

    const sessionUpdate = {
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-4o-realtime-preview",
        instructions:
          "You are a warm, concise receptionist for a pediatric dental & orthodontics office in Ponte Vedra, Florida. Keep answers under two sentences and pause when the caller speaks."
      }
    };
    openaiWS.send(JSON.stringify(sessionUpdate));

    // Brief greeting so we can hear output audio
    openaiWS.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Hello, thanks for calling. How can I help today?" }
    }));
  });

  /* ----- OpenAI -> Twilio (downlink audio) ----- */
  openaiWS.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const t = msg?.type;

      if (t && !String(t).includes("input_audio_buffer")) {
        // Debug logging to see the event mix
        console.log("🔈 OpenAI event:", t, Object.keys(msg || {}));
      }

      // Handle audio deltas (two possible field names)
      if ((t === "response.output_audio.delta" && msg.delta) ||
          (t === "response.audio.delta" && msg.delta)) {
        const audioBuf = b64ToBuf(msg.delta);                // base64 -> Buffer
        const pcm24 = bufToI16(audioBuf);                    // Buffer -> Int16Array view
        const pcm8 = resampleLinear(pcm24, 24000, 8000);     // 24k -> 8k
        const ulaw = muLawEncode(pcm8);                      // PCM -> μ-law
        sendUlawToTwilio(twilioWS, streamSid, ulaw);         // chunked send
        aiSpeaking = true;
        return;
      }

      if (t === "response.completed") {
        aiSpeaking = false;
        requestedThisTurn = false;
        return;
      }
    } catch {
      // non-JSON frames ignored
    }
  });

  openaiWS.on("close", () => console.log("🔴 OpenAI Realtime closed"));
  openaiWS.on("error", (e) => console.log("⚠️ OpenAI error", e?.message || e));

  /* ----- Twilio -> OpenAI (uplink audio) ----- */
  twilioWS.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || msg.streamSid || null;
      console.log("▶️ stream start", streamSid, msg.start?.callSid);

      // keepalive ping (optional)
      const ping = setInterval(() => {
        if (twilioWS.readyState === 1 && streamSid) {
          twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "ping" } }));
        }
      }, 5000);
      twilioWS.on("close", () => clearInterval(ping));
      twilioWS.on("error", () => clearInterval(ping));
      return;
    }

    if (msg.event === "media") {
      // Twilio -> μ-law/8k base64
      const ulaw = new Uint8Array(b64ToBuf(msg.media.payload));
      const pcm8 = muLawDecode(ulaw);
      const pcm16 = resampleLinear(pcm8, 8000, 16000);               // 8k -> 16k for input
      const b64 = Buffer.from(new Int16Array(pcm16).buffer).toString("base64");

      if (openaiWS?.readyState === 1) {
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (openaiWS.readyState !== 1) return;
          openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          if (!aiSpeaking && !requestedThisTurn) {
            openaiWS.send(JSON.stringify({ type: "response.create", response: {} }));
            requestedThisTurn = true;
          }
        }, 200); // commit after brief pause
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("⏹️ stream stop");
      try { openaiWS.close(); } catch {}
      return;
    }
  });

  twilioWS.on("close", () => {
    console.log("🔌 Twilio stream closed");
    try { openaiWS.close(); } catch {}
  });
  twilioWS.on("error", () => {
    console.log("⚠️ Twilio stream error");
    try { openaiWS.close(); } catch {}
  });
});

/* ---------- Server start ---------- */
app.get("/", (_req, res) => res.send("Sonnet live voice server OK"));
server.listen(process.env.PORT || 8080, () =>
  console.log("Sonnet live voice server running on port " + (process.env.PORT || 8080))
);
