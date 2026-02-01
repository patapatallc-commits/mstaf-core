/**
 * MSTAF CORE - server.js (Twilio SMS/MMS first)
 * - Works on Render/Heroku-style hosts
 * - Correctly parses Twilio x-www-form-urlencoded webhooks
 * - Provides health + debug routes
 * - Handles SMS + MMS (media URLs)
 */

require("dotenv").config();

const express = require("express");
const twilio = require("twilio");

const app = express();

/**
 * IMPORTANT:
 * Twilio sends webhooks as application/x-www-form-urlencoded
 * So we must include express.urlencoded(...)
 */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/** Basic health check (Render uses this to confirm your service is alive) */
app.get("/", (req, res) => {
  res.status(200).send("✅ MSTAF CORE is running");
});

/** Optional: quick env check (safe — does not reveal secrets) */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mstaf-core",
    hasTwilioSid: Boolean(process.env.TWILIO_ACCOUNT_SID),
    hasTwilioAuthToken: Boolean(process.env.TWILIO_AUTH_TOKEN),
    hasTwilioNumber: Boolean(process.env.TWILIO_PHONE_NUMBER),
  });
});

/** Debug: list active routes */
app.get("/routes", (req, res) => {
  try {
    const routes = [];
    app._router.stack.forEach((m) => {
      if (m.route && m.route.path) {
        routes.push({
          path: m.route.path,
          methods: Object.keys(m.route.methods).join(",").toUpperCase(),
        });
      }
    });
    res.json({ routes });
  } catch (e) {
    res.json({ routes: [], note: "Route listing not available." });
  }
});

/**
 * (Recommended) Twilio request signature validation
 * If you don't want validation yet, set:
 *   TWILIO_VALIDATE_WEBHOOKS=false
 */
function shouldValidateTwilio() {
  const v = (process.env.TWILIO_VALIDATE_WEBHOOKS || "true").toLowerCase();
  return v !== "false";
}

function validateTwilioRequest(req) {
  // Only validate if enabled and we have auth token.
  if (!shouldValidateTwilio()) return true;
  if (!process.env.TWILIO_AUTH_TOKEN) return true;

  // Twilio sends signature in header:
  const signature = req.headers["x-twilio-signature"];
  if (!signature) return false;

  // Build the full URL Twilio called (Render/Proxy safe)
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "")
    .split(",")[0]
    .trim();
  const url = `${proto}://${host}${req.originalUrl}`;

  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    req.body
  );
}

/**
 * Twilio SMS/MMS inbound webhook
 * Configure in Twilio Console:
 * Phone Number > Messaging > "A MESSAGE COMES IN"
 *   https://YOUR-RENDER-URL/sms
 */
app.post("/sms", (req, res) => {
  try {
    // Validate Twilio signature (optional but recommended)
    const isValid = validateTwilioRequest(req);
    if (!isValid) {
      return res.status(403).send("Forbidden (invalid Twilio signature)");
    }

    const from = req.body.From || "";
    const to = req.body.To || "";
    const body = (req.body.Body || "").trim();
    const numMedia = parseInt(req.body.NumMedia || "0", 10);

    // Collect media URLs if MMS
    const media = [];
    for (let i = 0; i < numMedia; i++) {
      const url = req.body[`MediaUrl${i}`];
      const contentType = req.body[`MediaContentType${i}`];
      if (url) media.push({ url, contentType });
    }

    // ---- MSTAF logic placeholder ----
    // For now we just acknowledge + show what we received.
    let reply = `✅ MSTAF received your message.\n\nFrom: ${from}\nTo: ${to}\nText: ${body || "(no text)"}`;

    if (media.length > 0) {
      reply += `\n\n📎 Media received (${media.length}):\n`;
      media.forEach((m, idx) => {
        reply += `${idx + 1}) ${m.contentType || "file"}\n${m.url}\n`;
      });
      reply += `\nNext: We will connect this to MSTAF PRINT / MSTAF UPLOAD logic.`;
    } else {
      reply += `\n\nTip: Send an image (MMS) to test upload flow.`;
    }

    // Respond to Twilio with TwiML
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);

    res.type("text/xml");
    return res.status(200).send(twiml.toString());
  } catch (err) {
    console.error("❌ /sms error:", err);
    return res.status(500).send("Server error");
  }
});

/**
 * Optional: Twilio Status Callback endpoint
 * You can set this as Status Callback URL when sending outbound messages later.
 */
app.post("/twilio/status", (req, res) => {
  try {
    // Typically no need to validate, but you can if you want:
    // const isValid = validateTwilioRequest(req);
    // if (!isValid) return res.status(403).send("Forbidden");

    const payload = {
      MessageSid: req.body.MessageSid,
      MessageStatus: req.body.MessageStatus,
      To: req.body.To,
      From: req.body.From,
      ErrorCode: req.body.ErrorCode,
      ErrorMessage: req.body.ErrorMessage,
    };

    console.log("📌 Twilio Status:", payload);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(200).json({ ok: true });
  }
});

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json({ ok: false, message: "Not Found" });
});

/**
 * Start server
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ MSTAF CORE listening on port ${PORT}`);
});
