// MSTAF Core - Stable starter for Render
// WhatsApp webhook disabled (Meta WhatsApp still pending)
// Twilio SMS webhook enabled at /sms

if (process.env.NODE_ENV !== "production") {
  try {
    require("dotenv").config();
  } catch (e) {
    // ignore if dotenv not installed
  }
}

const express = require("express");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.post("/sms", (req, res) => {
  console.log("✅ /sms HIT from Twilio");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  res.status(200).send("OK");
});

// Helpers
function escapeXml(unsafe = "") {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Home
app.get("/", (req, res) => {
  res.status(200).send("MSTAF Core is running ✅");
});

// Health check (Render uses this)
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// WhatsApp webhook DISABLED for now (Meta pending)
app.post("/webhook", (req, res) => {
  return res.sendStatus(200);
});

// ✅ Twilio SMS webhook (use this NOW while WhatsApp is pending)
app.post("/sms", (req, res) => {
  const text = (req.body.Body || "").trim();
  const upper = text.toUpperCase();

  let reply =
    'Hi 👋 Welcome to MSTAF.\nTry:\n• MSTAF TELEVISION\n• MSTAF LAPTOP\n• MSTAF UPLOAD';

  if (upper.startsWith("MSTAF UPLOAD")) {
    reply =
      "✅ MSTAF UPLOAD received.\nPlease send:\n1) Product photo\n2) Price\n3) Store name + address\n4) Country/City";
  } else if (upper.startsWith("MSTAF ")) {
    const query = text.substring(5).trim();
    reply = `🔎 Searching MSTAF for: ${query}\n\n(Next: connect a database so you get prices + store addresses.)`;
  }

  // Twilio expects XML (TwiML)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(reply)}</Message>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Start server (Render requires PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MSTAF Core running on port ${PORT}`);
});
