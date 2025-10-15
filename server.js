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

/* -------------------------- Tiny audio helpers -------------------------- */
// base64 helpers
const b64ToU8 = (b64) => Uint8Array.from(Buffer.from(b64, "base64"));
const i16ToB64 = (i16) => Buffer.from(new Int16Array(i16).buffer).toString("base64");

// µ-law decode → PCM16
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
// PCM16 → µ-law
function muLawEncode(pcm) {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = Math.max(-32768, Math.min(32767, pcm[i]));
    const sign = s < 0 ? 0x80 : 0x00;
    s = Math.abs(s) + 132; // bias
    let log = 0;
    for (let tmp = s >> 3; tmp; tmp >>= 1) log++;
    const mant = (s >> (log + 3)) & 0x0f;
    out[i] = ~(sign | (log << 4) | mant) & 0xff;
  }
  return out;
}
// linear resample between 8k / 16k / 24k
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

/* ----------------------- OpenAI Realtime connection ---------------------- */
function connectOpenAI() {
  const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  return new WebSocket(url, { headers });
}

/* --------------------------- WS bridge server ---------------------------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-stream" });

wss.on("connection", (twilioWS) => {
  console.log("🔌 Twilio stream connected");
  twilioWS.binaryType = "arraybuffer";

  let streamSid = null;        // Twilio requires this on outbound media
  let aiSpeaking = false;      // basic turn-taking
  let requestedThisTurn = false;

  const openaiWS = connectOpenAI();
  openaiWS.binaryType = "arraybuffer";

  openaiWS.on("open", () => {
    console.log("🟢 OpenAI Realtime connected");
    const sessionUpdate = {
      type: "session.update",
      session: {
        output_audio_format: "pcm_s16le_24000", // high quality; we'll downsample to 8k µ-law
        instructions:
          "You are a warm, concise receptionist for a pediatric dental and orthodontics office in Ponte Vedra, Florida. Keep answers under two sentences. Pause when the caller speaks."
      }
    };
    openaiWS.send(JSON.stringify(sessionUpdate));
  });

  // Handle OpenAI JSON events (audio deltas, completed)
  openaiWS.on("message", (data) => {
    // OpenAI messages are JSON (sometimes include base64 audio delta)
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const t = msg?.type;

    if (t === "response.audio.delta" && msg.delta) {
      // AI speaking chunk: base64 PCM16 @ 24k
      const pcm24k = new Int16Array(Buffer.from(msg.delta, "base64").buffer);
      const pcm8k = resampleLinear(pcm24k, 24000, 8000);
      const ulaw = muLawEncode(pcm8k);
      if (streamSid) {
        twilioWS.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: Buffer.from(ulaw).toString("base64") }
        }));
        twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "ai_chunk" } }));
      }
      aiSpeaking = true;
    } else if (t === "response.completed") {
      aiSpeaking = false;
      requestedThisTurn = false;
      if (streamSid) {
        twilioWS.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "ai_done" } }));
      }
    }
  });

  openaiWS.on("close", () => console.log("🔴 OpenAI Realtime closed"));
  openaiWS.on("error", (e) => console.log("⚠️ OpenAI error", e?.message || e));

  // From Twilio → OpenAI
  twilioWS.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || msg.streamSid || null;
      console.log("▶️ stream start", streamSid, msg.start?.callSid);
      return;
    }

    if (msg.event === "media") {
      // Incoming µ-law/8k → PCM16/8k → upsample to 16k → feed buffer
      const ulaw = b64ToU8(msg.media.payload);
      const pcm8k = muLawDecode(ulaw);
      const pcm16k = resampleLinear(pcm8k, 8000, 16000);
      const b64 = i16ToB64(pcm16k);
      openaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));

      // Ask for a response (once per turn)
      if (!aiSpeaking && !requestedThisTurn) {
        openaiWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } }));
        requestedThisTurn = true;
      }
      return;
    }

    if (msg.event === "mark") {
      // marks we send come back from Twilio when played — optional to log
      // console.log("mark played", msg?.mark?.name);
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

app.get("/", (_req, res) => res.send("Sonnet live voice server OK"));
server.listen(process.env.PORT || 8080, () =>
  console.log("Sonnet live voice server running on port " + (process.env.PORT || 8080))
);
