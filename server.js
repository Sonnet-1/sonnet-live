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
  res.type("text/xml").send(
    `<Response>
       <Say voice="alice">Hi from Sonnet. Your webhook is working.</Say>
       <Pause length="1"/>
       <Say>Goodbye.</Say>
     </Response>`
  );
});
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-stream" });

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

