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
const multer = require("multer");
const path = require("path");
const fs = require("fs");




const app = express();   // 👈 KEEP THIS
// ===== Middleware =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Uploads folder + public access =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Public access: /uploads/<filename>
app.use("/uploads", express.static(uploadsDir));
// ===== JOB QUEUE (simple JSON file) =====
const jobsFile = path.join(__dirname, "jobs.json");

function readJobs() {
  try {
    if (!fs.existsSync(jobsFile)) return [];
    const raw = fs.readFileSync(jobsFile, "utf8");
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.log("jobs.json read error:", e.message);
    return [];
  }
}

function writeJobs(jobs) {
  const tmp = jobsFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2), "utf8");
  fs.renameSync(tmp, jobsFile);
}

function makeJobId() {
  return `JOB-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * IMPORTANT:
 * Twilio sends webhooks as application/x-www-form-urlencoded
 * So we must include express.urlencoded(...)
 */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// ===== FILE UPLOAD SETUP (MSTAF UPLOAD / PRINT) =====
const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safeName =
      Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
    cb(null, safeName);
  }
});

const upload = multer({ storage });

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
// ===== FILE UPLOAD ENDPOINT =====
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const printerId = String(req.body.printerId || "").trim();
if (!printerId) {
  return res.status(400).json({
    success: false,
    error: "printerId is required"
  });
}

const jobs = readJobs();

const job = {
  id: String(Date.now()),
  printerId,
  filename: req.file.filename,
  fileUrl: `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`,
  status: "queued",
  createdAt: new Date().toISOString(),
  completedAt: null
};

jobs.push(job);
writeJobs(jobs);

return res.json({
  success: true,
  filename: req.file.filename,
  fileUrl: job.fileUrl,
  job
});
});
/**
 * List jobs by printerId (simple queue)
 * GET /jobs?printerId=PP-USA-001
 */
app.get("/jobs", (req, res) => {
  try {
    const { printerId } = req.query;

    if (!printerId) {
      return res.status(400).json({
        success: false,
        error: "printerId is required"
      });
    }

    const uploadsDir = path.join(__dirname, "uploads");

    if (!fs.existsSync(uploadsDir)) {
      return res.json({
        success: true,
        count: 0,
        jobs: []
      });
    }

    const files = fs.readdirSync(uploadsDir);

    // Only files that contain this printerId
    const jobs = files
      .filter(name => name.includes(printerId))
      .map(name => ({
        printerId,
        filename: name,
        url: `/uploads/${name}`
      }));

    return res.json({
      success: true,
      count: jobs.length,
      jobs
    });

  } catch (e) {
    console.error("Jobs list error:", e);
    return res.status(500).json({
      success: false,
      error: "Server error reading jobs"
    });
  }
});
// ✅ List jobs (optionally filter by printerId)
app.get("/jobs", (req, res) => {
  try {
    const printerId = (req.query.printerId || "").trim();
    const jobs = readJobs();

    const filtered = printerId
      ? jobs.filter(j => (j.printerId || "").trim() === printerId)
      : jobs;

    return res.json({
      success: true,
      count: filtered.length,
      jobs: filtered
    });
  } catch (e) {
    console.log("Jobs list error:", e.message);
    return res.status(500).json({
      success: false,
      error: "Server error reading jobs."
    });
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
