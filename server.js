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
const { google } = require("googleapis");

// ✅ Google Sheets auth (Render Secret File)
const auth = new google.auth.GoogleAuth({
  keyFile: "/etc/secrets/google-service-account.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// ✅ Sheet config (set in Render Environment Variables)
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_TAB || "Sheet1";

// ✅ Helper: append a row to Google Sheets
async function appendJobToSheet(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [row],
    },
  });
}


const app = express();
app.use(express.json());

// ✅ Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "MSTAF Core",
    time: new Date().toISOString(),
  });
});

app.use(express.urlencoded({ extended: true }));
app.post("/sms", async (req, res) => {
  // Respond immediately to Twilio
  res.status(200).send("OK");

  try {
    const from = req.body.From || "";
    const to = req.body.To || "";
    const body = (req.body.Body || "").trim();
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    const mediaUrl = numMedia > 0 ? req.body.MediaUrl0 : "";
    const mediaType = numMedia > 0 ? req.body.MediaContentType0 : "";

    const now = new Date();
    const jobId = `JOB-${now.getTime()}`;

    // Row matches your Sheet columns
    const row = [
      jobId,
      now.toISOString(),
      from,
      to,
      body,
      mediaUrl,
      mediaType,
      "PENDING",
    ];

    await appendJobToSheet(row);
    console.log("✅ Job saved to Google Sheets:", jobId);
  } catch (err) {
    console.error("❌ Failed to write to sheet:", err);
  }
});

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
