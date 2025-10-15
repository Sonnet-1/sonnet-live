require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ---------- TwiML: open a Twilio Media Stream to our WS endpoint ---------- */
app.post("/voice", (req, res) => {
  const wsUrl = process.env.WS_PUBLIC_URL || `wss://${req.headers.host}/twilio-stream`;
  res.type("text/xml").send(
    `<Response>
       <Say voice="alice">Connecting you now.</Say>
       <Connect><Stream url="${wsUrl}"/></Connect>
     </Response>`
  );
});

/* -------------------------- CONFIG -------------------------- */
const ECHO_TEST = false; // set to true for audio echo only (no AI)

/* -------------------------- HELPERS -------------------------- */
const b64ToU8 = (b64) => Uint8Array.from(Buffer.from(b64, "base64"));
const i16ToB64 = (i16) => Buffer.from(new Int16Array(i16).buffer).toString("base64");

function safeSend(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function muLawDecode(u8) {
  const out = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    let u = 255 - u8[i];
    const sign = (u & 0x80) ? -1 : 1;
    u &= 0x7f;
    let t = ((u << 2) + 33) << 2;
    out[i] = sign * (t < 32768 ? t : 32767);
  }
  return out;
}

function muLawEncode(pcm) {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = Math.max(-32768, Math.min(32767, pcm[i]));
    const sign = s < 0 ? 0x80 : 0x00;
    s = Math.abs(s) + 132;
    let log = 0;
    for (let tmp = s >> 3; tmp; tmp >>= 1) log++;
    const mant = (s >> (log + 3)) & 0x0f;
    out[i] = ~(sign | (log << 4) | mant) & 0xff;
  }
  return out;
}

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

/* ----------------------- OpenAI Realtime ---------------------- */
function connectOpenAI() {
  const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  return new WebSocket(url, { headers });
}

/* --------------------------- WS bridge ---------------------------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-stream" });

wss.on("connection", (twilioWS) => {
  console.log("🔌 Twilio stream connected");
  twilioWS.binaryType = "arraybuffer";

  let streamSid = null;
  let aiSpeaking = false;
  let requestedThisTurn = false;
  let debounceTimer = null;

  const openaiWS = ECHO_TEST ? null : connectOpenAI();
  if (openaiWS) openaiWS.binaryType = "arraybuffer";

  if (openaiWS) {
   openaiWS.on("open", () => {
  console.log("🟢 OpenAI Realtime connected");

  // Minimal, valid session payload
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

  // Ask the model to speak; put voice ONLY on the response
  openaiWS.send(JSON.stringify({
    type: "response.create",
    response: {
      instructions: "Hello, thanks for calling. How can I help today?",
      voice: "alloy"
    }
  }));
});

    openaiWS.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const t = msg?.type;

        if (t && !String(t).includes("input_audio_buffer")) {
          console.log("🔈 OpenAI event:", t, Object.keys(msg || {}));
          if (t === "error" && msg.error) {
            console.log("❌ OpenAI error detail:", JSON.stringify(msg.error));
          }
        }

        // Handle both possible audio output formats
        if (t === "response.output_audio.delta" && msg.audio) {
          const pcm24k = new Int16Array(Buffer.from(msg.audio, "base64").buffer);
          const pcm8k = resampleLinear(pcm24k, 24000, 8000);
          const ulaw = muLawEncode(pcm8k);
          if (streamSid) {
            safeSend(twilioWS, { event: "media", streamSid, media: { payload: Buffer.from(ulaw).toString("base64") } });
          }
          aiSpeaking = true;
          return;
        }

        if (t === "response.completed") {
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
  }

  // Twilio -> (echo) or -> OpenAI
  twilioWS.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || msg.streamSid || null;
      console.log("▶️ stream start", streamSid, msg.start?.callSid);

      const ping = setInterval(() => {
        if (twilioWS.readyState === 1 && streamSid) {
          safeSend(twilioWS, { event: "mark", streamSid, mark: { name: "ping" } });
        }
      }, 5000);
      twilioWS.on("close", () => clearInterval(ping));
      twilioWS.on("error", () => clearInterval(ping));
      return;
    }

    if (msg.event === "media") {
      const ulaw = b64ToU8(msg.media.payload);
      const pcm8k = muLawDecode(ulaw);

      if (ECHO_TEST) {
        if (streamSid) {
          safeSend(twilioWS, { event: "media", streamSid, media: { payload: Buffer.from(ulaw).toString("base64") } });
        }
        return;
      }

      if (!openaiWS || openaiWS.readyState !== 1) return;

      const pcm16k = resampleLinear(pcm8k, 8000, 16000);
      const b64 = i16ToB64(pcm16k);
      openaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (openaiWS.readyState !== 1) return;
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        if (!aiSpeaking && !requestedThisTurn) {
          openaiWS.send(JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio"],
              speech: { voice: "alloy" }
            }
          }));
          requestedThisTurn = true;
        }
      }, 200);
      return;
    }

    if (msg.event === "stop") {
      console.log("⏹️ stream stop");
      try { if (openaiWS) openaiWS.close(); } catch {}
      return;
    }
  });

  twilioWS.on("close", () => {
    console.log("🔌 Twilio stream closed");
    try { if (openaiWS) openaiWS.close(); } catch {}
  });
  twilioWS.on("error", () => {
    console.log("⚠️ Twilio stream error");
    try { if (openaiWS) openaiWS.close(); } catch {}
  });
});

/* ------------------------------ start server ----------------------------- */
app.get("/", (_req, res) => res.send("Sonnet live voice server OK"));
server.listen(process.env.PORT || 8080, () =>
  console.log("Sonnet live voice server running on port " + (process.env.PORT || 8080))
);
