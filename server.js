require("dotenv").config();
const express = require("express");
const axios = require("axios");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


const PORT = process.env.PORT || 3000;

/**
 * 1) Webhook verification (Meta calls this once to verify)
 * Callback URL will be: https://YOUR-DOMAIN/webhook
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});
// ===============================
// TWILIO SMS/MMS WEBHOOK (PRIMARY)
// Twilio will POST incoming SMS here
// Callback URL will be: https://YOUR-RENDER-URL/twilio
// ===============================
app.post("/twilio", async (req, res) => {
  try {
    const from = req.body.From || "";
    const body = (req.body.Body || "").trim();
    const upper = body.toUpperCase();

    // Build TwiML response
     const twiml = new twilio.twiml.MessagingResponse();

    // Basic routing
    if (upper.startsWith("MSTAF UPLOAD")) {
      twiml.message(
        "✅ MSTAF UPLOAD received.\n\nPlease send:\n1) Product photo (MMS)\n2) Price\n3) Store name + address\n4) Country/City"
      );
    } else if (upper.startsWith("MSTAF ")) {
      const query = body.substring(5).trim();
      twiml.message(
        `🔎 Searching MSTAF for: ${query}\n\n(Next: we connect a database so you get prices + store addresses.)`
      );
    } else if (upper === "MSTAF") {
      twiml.message(
        "Hi 👋 Welcome to MSTAF.\n\nTry:\nMSTAF TELEVISION\nMSTAF LAPTOP\nMSTAF UPLOAD"
      );
    } else {
      twiml.message(
        "Type MSTAF to start.\nExample: MSTAF TELEVISION"
      );
    }

    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("Twilio webhook error:", err);
    return res.status(200).send("OK");
  }
});

/**
 * 2) Webhook receiver (Meta sends messages here)
 */
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from; // WhatsApp user phone (wa_id)
    const text = msg.text?.body?.trim() || "";
    const upper = text.toUpperCase();

    if (upper.startsWith("MSTAF UPLOAD")) {
      await sendText(
        from,
        "✅ MSTAF UPLOAD received.\nPlease send:\n1) Product photo\n2) Price\n3) Store name + address\n4) Country/City"
      );
    } else if (upper.startsWith("MSTAF ")) {
      const query = text.substring(5).trim();
      await sendText(
        from,
        `🔎 Searching MSTAF for: ${query}\n\n(Next: we connect a database so you get prices + store addresses.)`
      );
    } else {
      await sendText(
        from,
        "Hi 👋 Welcome to MSTAF.\n\nTry:\n• MSTAF TELEVISION\n• MSTAF LAPTOP\n• MSTAF UPLOAD"
      );
    }

    return res.sendStatus(200);
  } catch
