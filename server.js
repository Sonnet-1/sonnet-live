require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ------------------------ Twilio TwiML: start bidirectional stream ------------------------ */
app.post("/voice", (req, res) => {
  const wsUrl = process.env.WS_PUBLIC_URL || `wss://${req.headers.host}/twilio-stream`;
  res.type("text/xml").send(
    `<Response>
       <Say voice="alice">Connecting you now.</Say>
       <Connect><Stream url="${wsUrl}" /></Connect>
     </Response>`
  );
});

/* ------------------------ Tiny audio helpers (no external deps) ------------------------ */
// µ-law decode → PCM16 (returns Int16Array)
function muLawDecode(u8) {
  const out = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    let u = 255 - u8[i];
    let sign = (u & 0x80) ? -1 : 1;
    u &= 0x7f;
    let t = ((u << 2) + 33) << 2;
    out[i] = sign * (t < 32768 ? t : 32767);
  }
  return out;
}
// PCM16 → µ-law (expects Int16Array); returns Uint8Array
function muLawEncode(pcm) {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = Math.max(-32768, Math.min(32767, pcm[i]));
    let sign = s < 0 ? 0x80 : 0x00;
    s = Math.abs(s);
    s = s + 132; // bias
    let log = 0;
    let tmp = s >> 3;
    while (tmp) { log++; tmp >>= 1; }
    let mant = (s >> (log + 3)) & 0x0f;
    let u = ~(sign | (log << 4) | mant) & 0xff;
    out[i] = u;
  }
  return out;
}
// simple linear resampler between 8k/16k/24k
function resampleLinear(pcm, inRate, outRate) {
  if (inRate === outRate) return pcm;
  const ratio = outRate / inRate;
  const out = new Int16Array(Math.floor(pcm.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = srcPos - i0;
    out[i] = (pcm[i0] * (1 - frac) + pcm[i1] * frac) | 0;
  }
  return out;
}
// base64 helpers
const b64ToU8 = (b64) => Uint8Array.from(Buffer.from(b64, "base64"));
const pcm16ToBase64 = (i16) => Buffer.from(new Int16Array(i16).buffer).toString("base64");

/* ------------------------ OpenAI Realtime helper ------------------------ */
function connectOpenAI() {
  const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  return new WebSocket(url, { headers });
}

/* ------------------------ WebSocket bridge ------------------------ */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-stream" });

wss.on("connection", (twilioWS) => {
  console.log("🔌 Twilio stream connected");
  twilioWS.binaryType = "arraybuffer";

  const openaiWS = connectOpenAI();
  openaiWS.binaryType = "arraybuffer";

  // state for buffering AI audio before sending to Twilio
  let aiSpeaking = false;

  openaiWS.on("open", () => {
    console.log("🟢 OpenAI Realtime connected");
    const sessionUpdate = {
      type: "session.update",
      session: {
        // keep output in pcm16 24000 for quality; we’ll downsample + mulaw for Twilio
        output_audio_format: "pcm_s16le_24000",
        instructions:
          "You are a warm, concise receptionist for a pediatric dental & orthodontics office. Keep answers under 2 sentences. Pause when the caller speaks."
      }
    };
    openaiWS.send(JSON.stringify(sessionUpdate));
  });

  openaiWS.on("message", (data) => {
    // OpenAI sends JSON events and raw audio frames (as binary) depending on event type.
    // We’ll handle JSON “response.audio.delta” and “response.completed”.
    try {
      // If it parses as JSON, check for events
      const msg = JSON.parse(data.toString());
      const t = msg.type;
      if (t === "response.audio.delta" && msg.delta) {
        // delta is base64 PCM16 @ 24k
        const pcm24k = new Int16Array(Buffer.from(msg.delta, "base64").buffer);
        // downsample to 8k for Twilio and encode as µ-law
        const pcm8k = resampleLinear(pcm24k, 24000, 8000);
        const ulaw = muLawEncode(pcm8k);
        const payloadB64 = Buffer.from(ulaw).toString("base64");
        // send to Twilio as media
        twilioWS.send(JSON.stringify({ event: "media", media: { payload: payloadB64 } }));
        aiSpeaking = true;
      } else if (t === "response.completed") {
        // mark end of AI turn
        twilioWS.send(JSON.stringify({ event: "mark", mark: { name: "ai_done" } }));
        aiSpeaking = false;
      }
      return;
    } catch {
      // binary frames etc. ignore
    }
  });

  openaiWS.on("close", () => console.log("🔴 OpenAI Realtime closed"));
  openaiWS.on("error", (e) => console.log("⚠️ OpenAI error", e?.message || e));

  // From Twilio → to OpenAI
  twilioWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.event) {
        case "start":
          console.log("▶️ stream start", msg.streamSid, msg.start?.callSid);
          break;
        case "media": {
          // Twilio media: base64 µ-law @ 8k
          const ulaw = b64ToU8(msg.media.payload);
          const pcm8k = muLawDecode(ulaw);
          const pcm16k = resampleLinear(pcm8k, 8000, 16000); // input buffer at 16k is fine
          const b64 = pcm16ToBase64(pcm16k);
          // append to OpenAI audio buffer
          openaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
          // When we have enough, trigger a response (simple heuristic)
          if (!aiSpeaking && pcm16k.length > 0) {
            openaiWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
          }
          break;
        }
        case "stop":
          console.log("⏹️ stream stop");
          try { openaiWS.close(); } catch {}
          break;
      }
    } catch {
      /* ignore non-JSON frames */
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

app.get("/", (_req, res) => res.send("Sonnet live voice server OK"));
server.listen(process.env.PORT || 8080, () =>
  console.log("Sonnet live voice server running on port " + (process.env.PORT || 8080))
);
