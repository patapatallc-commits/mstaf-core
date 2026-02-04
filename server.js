/**
 * MSTAF CORE - server.js (Twilio SMS/MMS first)
 * - Works on Render/Heroku-style host
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
// ===== TEMP DB VERIFY (READ-ONLY) =====
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// =====================================
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
// ===== COUNT JOBS (must be above /jobs list route) =====
app.get("/jobs/count", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").trim();
    if (!printerId) {
      return res.status(400).json({ ok: false, error: "printerId is required" });
    }

    // Postgres path
    if (typeof pool !== "undefined" && pool?.query) {
      const r = await pool.query(
        "SELECT COUNT(*)::int AS count FROM print_jobs WHERE printer_id = $1",
        [printerId]
      );
      return res.json({ ok: true, printerId, count: r.rows[0].count });
    }

    // In-memory fallback
    if (typeof jobs !== "undefined" && Array.isArray(jobs)) {
      const count = jobs.filter(j => j.printerId === printerId).length;
      return res.json({ ok: true, printerId, count });
    }

    return res.status(500).json({ ok: false, error: "No job store found" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
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
// ================================
// PRINT-O-MATIC: Create a job
// POST /jobs
// ================================
app.post("/jobs", async (req, res) => {
  try {
    const {
      printerId = "PP-USA-001",
      fileUrl = null,
      pages = 1,
      copies = 1,
      color = "BW",
      customerPhone = null,
      meta = {}
    } = req.body || {};

    const status = "queued";

    const metaOut = {
      ...meta,
      pages,
      copies,
      color,
      customerPhone
    };

    const q = `
      INSERT INTO print_jobs (printer_id, status, file_url, meta)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;

    const result = await pool.query(q, [
      printerId,
      status,
      fileUrl,
      metaOut
    ]);

    return res.json({
      success: true,
      job: result.rows[0]
    });
  } catch (err) {
    console.error("POST /jobs ERROR:", err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
// ================================
// PRINT-O-MATIC: Update job status
// PATCH /jobs/:id/status
// ================================
app.patch("/jobs/:id/status", async (req, res) => {
  try {
    const id = req.params.id;
    const { status, meta = {} } = req.body || {};

    const allowed = new Set(["queued", "printing", "completed", "failed"]);
    const normalized = String(status || "").toLowerCase();
    if (!allowed.has(normalized)) {
      return res.status(400).json({
        success: false,
        error: "Invalid status. Use queued|printing|completed|failed."
      });
    }

    const q = `
      UPDATE print_jobs
      SET status = $2,
          meta = COALESCE(meta, '{}'::jsonb) || $3::jsonb
      WHERE id = $1
      RETURNING *;
    `;

    const result = await pool.query(q, [id, normalized, meta]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Job not found"
      });
    }

    return res.json({
      success: true,
      job: result.rows[0]
    });
  } catch (err) {
    console.error("PATCH /jobs/:id/status ERROR:", err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
// ================================
// PRINT-O-MATIC: Jobs queue (Postgres)
// GET /jobs?printerId=PP-USA-001
// ================================
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "PP-USA-001").trim();
    const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);

    const q = `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1 AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT $2;
    `;

    const result = await pool.query(q, [printerId, limit]);

    return res.json({
      success: true,
      printerId,
      count: result.rows.length,
      jobs: result.rows
    });
  } catch (err) {
    console.error("GET /jobs ERROR:", err);
    return res.status(500).json({
      success: false,
      error: err.message
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
