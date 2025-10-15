require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
function connectOpenAI() {
  const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  return new WebSocket(url, { headers });
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-stream" });
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

  twilioWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "start") {
        console.log("▶️ stream start", msg.streamSid, msg.start?.callSid, msg.start?.from);
      } else if (msg.event === "stop") {
        console.log("⏹️ stream stop");
      }
    } catch {}
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
  console.log("🔌 Twilio stream connected");

  twilioWS.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // You’ll see events: "start", "media", "mark", "dtmf", "stop"
      if (msg.event === "start") {
        console.log("▶️ stream start", msg.streamSid, msg.start?.callSid, msg.start?.from);
      } else if (msg.event === "media") {
        // media.payload is base64 audio frames
      } else if (msg.event === "stop") {
        console.log("⏹️ stream stop");
      }
    } catch {
      // ignore
    }
  });

  twilioWS.on("close", () => console.log("🔌 Twilio stream closed"));
  twilioWS.on("error", () => console.log("⚠️ Twilio stream error"));
});

function connectOpenAI() {
  const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  return new WebSocket(url, { headers });
}

wss.on("connection", (twilioWS) => {
  const openaiWS = connectOpenAI();

  openaiWS.on("open", () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions:
          "You are a warm, concise receptionist. Greet quickly, respond in short natural sentences, and pause to listen."
      }
    };
    openaiWS.send(JSON.stringify(sessionUpdate));
  });

  twilioWS.on("message", (data) => {
    if (openaiWS.readyState === 1) openaiWS.send(data);
  });

  openaiWS.on("message", (data) => {
    if (twilioWS.readyState === 1) twilioWS.send(data);
  });

  const close = () => {
    twilioWS.close();
    openaiWS.close();
  };
  twilioWS.on("close", close);
  openaiWS.on("close", close);
  twilioWS.on("error", close);
  openaiWS.on("error", close);
});

app.get("/", (_req, res) => res.send("Sonnet live voice server OK"));
server.listen(process.env.PORT || 8080, () =>
  console.log("Sonnet live voice server running on port " + (process.env.PORT || 8080))
);

