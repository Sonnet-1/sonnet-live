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

/* ---------- Feature flags ---------- */
const USE_ELEVENLABS = true; // << turn EL streaming voice on/off

/* ---------- Helpers ---------- */
const b64ToBuf = (b64) => Buffer.from(b64, "base64");
const bufToI16 = (buf) => new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);

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

/* ----- G.711 μ-law encode/decode ----- */
function muLawEncode(pcm) {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = Math.max(-32768, Math.min(32767, pcm[i]));
    const sign = s < 0 ? 0x80 : 0x00;
    s = Math.abs(s) + 132;
    if (s > 32767) s = 32767;
    let exponent = 7;
    for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    const mantissa = (s >> ((exponent === 0 ? 1 : exponent) + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
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

/* ----- Twilio media sender: 20ms μ-law chunks (160 bytes @ 8kHz) ----- */
function sendUlawToTwilio(twilioWS, streamSid, ulaw) {
  if (!streamSid || !twilioWS || twilioWS.readyState !== 1) return;
  const FRAME_BYTES = 160;
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

/* ---------- ElevenLabs TTS (streaming) ---------- */
/* We request μ-law 8k if supported; if PCM comes back, we resample+encode. */
async function speakWithElevenLabs({ text, twilioWS, streamSid }) {
  const apiKey = process.env.sk_359a89e9f4491c06c7880b18c71a82f63fce132083811694;
  const voiceId = process.env.BlUZNLlNS79wwp12qYPm;
  if (!apiKey || !voiceId || !text) return;

  // Try to request μ-law 8k directly for zero-conversion playback
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
  const body = {
    text,
    // Lower numbers = more streaming/smaller chunks; tune as desired
    optimize_streaming_latency: 3,
    // Some accounts support 'ulaw_8000'; if not, service may return another format
    output_format: "ulaw_8000"
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!r.ok || !r.body) {
    console.log("⚠️ ElevenLabs stream failed:", r.status, await r.text().catch(() => ""));
    return;
  }

  const ctype = (r.headers.get("content-type") || "").toLowerCase();
  // Stream chunks as they arrive
  const reader = r.body.getReader();
  let leftover = Buffer.alloc(0);

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    // If we got μ-law bytes already, just forward in 160-byte frames.
    if (ctype.includes("ulaw") || ctype.includes("mulaw") || ctype.includes("x-mulaw")) {
      const bytes = new Uint8Array(value);
      sendUlawToTwilio(twilioWS, streamSid, bytes);
      continue;
    }

    // Otherwise, assume raw PCM (often 16k). Join with any leftover partial frame.
    // We’ll treat it as Int16, resample -> μ-law, then send.
    const buf = Buffer.concat([leftover, Buffer.from(value)]);
    const evenBytes = buf.length - (buf.length % 2);
    const frame = buf.subarray(0, evenBytes);
    leftover = buf.subarray(evenBytes);

    if (frame.length >= 2) {
      const i16 = bufToI16(frame);
      // guess common case: 16k PCM from TTS
      const pcm8 = resampleLinear(i16, 16000, 8000);
      const ulaw = muLawEncode(pcm8);
      sendUlawToTwilio(twilioWS, streamSid, ulaw);
    }
  }

  // Flush any small leftover (optional)
  if (leftover.length >= 2) {
    const i16 = bufToI16(leftover);
    const pcm8 = resampleLinear(i16, 16000, 8000);
    const ulaw = muLawEncode(pcm8);
    sendUlawToTwilio(twilioWS, streamSid, ulaw);
  }
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

  // Buffer for assistant transcript (we’ll speak this with ElevenLabs)
  let assistantTextBuffer = "";

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
          "You are a receptionist for a hospitality company in the greater orlando area that serves Disney guests with luxury rv rentals. Keep answers under two sentences and pause when the caller speaks."
      }
    };
    openaiWS.send(JSON.stringify(sessionUpdate));

    // Brief greeting to kick things off (we’ll still speak via EL)
    openaiWS.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Hello, This is Max at Kissimmee Orlando RV. How can I help today?" }
    }));
  });

  /* ----- OpenAI -> (ElevenLabs or Twilio) ----- */
  openaiWS.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const t = msg?.type;

      if (t && !String(t).includes("input_audio_buffer")) {
        console.log("🔈 OpenAI event:", t, Object.keys(msg || {}));
      }

      // Accumulate assistant text transcript as it streams
      if (t === "response.output_audio_transcript.delta" && msg.delta) {
        assistantTextBuffer += msg.delta;
        return;
      }

      // If you're *not* using ElevenLabs, you could forward OpenAI audio directly:
      if (!USE_ELEVENLABS) {
        if ((t === "response.output_audio.delta" && msg.delta) ||
            (t === "response.audio.delta" && msg.delta)) {
          const audioBuf = b64ToBuf(msg.delta);
          const pcm24 = bufToI16(audioBuf);
          const pcm8 = resampleLinear(pcm24, 24000, 8000);
          const ulaw = muLawEncode(pcm8);
          sendUlawToTwilio(twilioWS, streamSid, ulaw);
          aiSpeaking = true;
          return;
        }
      }

      if (t === "response.completed") {
        // Speak the collected assistant text with ElevenLabs
        if (USE_ELEVENLABS && assistantTextBuffer.trim()) {
          aiSpeaking = true;
          try {
            await speakWithElevenLabs({
              text: assistantTextBuffer.trim(),
              twilioWS,
              streamSid
            });
          } catch (e) {
            console.log("⚠️ ElevenLabs playback error:", e?.message || e);
          }
        }
        assistantTextBuffer = "";
        aiSpeaking = false;
        requestedThisTurn = false;
        return;
      }
    } catch {
      // ignore non-JSON frames
    }
  });

  openaiWS.on("close", () => console.log("🔴 OpenAI Realtime closed"));
  openaiWS.on("error", (e) => console.log("⚠️ OpenAI error", e?.message || e));

  /* ----- Twilio -> OpenAI ----- */
  twilioWS.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || msg.streamSid || null;
      console.log("▶️ stream start", streamSid, msg.start?.callSid);

      // keepalive mark
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
      const pcm16 = resampleLinear(pcm8, 8000, 16000); // 8k -> 16k input
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
        }, 200);
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
