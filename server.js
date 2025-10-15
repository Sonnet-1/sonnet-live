require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/**
 * Twilio hits this to start the call. We return TwiML that opens a
 * bidirectional media stream to our /twilio-stream WebSocket.
 */
app.post("/voice", (req, res) => {
  const wsUrl = process.env.WS_PUBLIC_URL || `wss://${req.headers.host}/twilio-stream`;
  res.type("text/xml").send(
    `<Response>
       <Say voice="alice">Connecting you now.</Say>
       <Connect>
         <Stream url="${wsUrl}" />
       </Connect>
     </Response>`
  );
});

/** Helper: open an OpenAI Realtime WS session */
function connectOpenAI() {
  const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  return new WebSocket(url, { headers });
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-stream" });

/**
 * Handle one live call stream from Twilio.
 * (For now we only verify connections and log events.)
 */
wss.on("connection", (twilioWS) => {
  console.log("🔌 Twilio stream connected");

  const openaiWS = connectOpenAI();

  openaiWS.on("open", () => {
    console.log("🟢 OpenAI Realtime connected");
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions:
          "You are a warm, concise receptionist. Keep replies under two sentences and stop talking when the caller speaks."
      }
    };
    openaiWS.send(JSON.stringify(sessionUpdate));
  });

  openaiWS.on("close", () => console.log("🔴 OpenAI Realtime closed"));
  openaiWS.on("error", (e) => console.log("⚠️ OpenAI error", e?.message || e));

  // Log Twilio stream lifecycle
  twilioWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "start") {
        console.log("▶️ stream start", msg.streamSid, msg.start?.callSid, msg.start?.from);
      } else if (msg.event === "stop") {
        console.log("⏹️ stream stop");
      }
    } catch {
      // ignore non-JSON pings
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
