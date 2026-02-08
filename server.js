/**
 * MSTAF CORE - server.js (Render-ready, Print-O-Matic Stable)
 * - Twilio SMS/MMS inbound webhook: POST /sms (optional)
 * - Upload endpoint: POST /api/upload (multipart/form-data)
 * - Public printer polling: GET /jobs?printerId=PP-USA-001&limit=5  (PAID-only queue)
 * - Admin: GET /admin/jobs/recent?limit=10  (requires x-admin-key)
 * - Admin: POST /admin/jobs/:id/force-paid (requires x-admin-key)
 * - Uses Postgres if DATABASE_URL is set; falls back to in-memory if not
 *
 * ENV VARS (Render -> Environment):
 *   DATABASE_URL=postgresql://...
 *   ADMIN_KEY=MSTAF_ADMIN_2026_SECURE_KEY
 *   PUBLIC_BASE_URL=https://mstaf-core-1.onrender.com   (optional; auto-detected)
 *   NODE_ENV=production
 */

if (process.env.NODE_ENV !== "production") {
  try { require("dotenv").config(); } catch (e) {}
}

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const path = require("path");

// Optional Twilio (only if installed + used)
let twilio = null;
try { twilio = require("twilio"); } catch (e) { twilio = null; }

const app = express();

// Twilio sends x-www-form-urlencoded; we support both
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------- CONFIG --------------------
const ADMIN_KEY = process.env.ADMIN_KEY || "MSTAF_ADMIN_2026_SECURE_KEY";
const PORT = process.env.PORT || 3000;

// Base URL (for file_url). Prefer explicit env; else infer from request.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

// -------------------- UPLOADS (local disk) --------------------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// serve: /uploads/<filename>
app.use("/uploads", express.static(uploadsDir));

// Multer: store on disk
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || "");
    const safeExt = ext && ext.length <= 10 ? ext : "";
    cb(null, `job_${Date.now()}_${crypto.randomBytes(6).toString("hex")}${safeExt}`);
  }
});
const upload = multer({ storage });

// -------------------- OPTIONAL POSTGRES --------------------
let Pool = null;
let pool = null;

try {
  ({ Pool } = require("pg"));
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
} catch (e) {
  pool = null;
}

// -------------------- IN-MEMORY FALLBACK --------------------
const mem = {
  jobs: [] // each: {id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at}
};

function nowISO() {
  return new Date().toISOString();
}

function clampInt(n, min, max, fallback) {
  const x = parseInt(n, 10);
  if (Number.isNaN(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized (missing/invalid x-admin-key)" });
  }
  next();
}

async function dbInit() {
  if (!pool) return;

  // Create table if missing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT UNIQUE NOT NULL,
      printer_id TEXT NOT NULL,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_url TEXT,
      status TEXT NOT NULL DEFAULT 'needs_details',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Ensure columns exist (safe adds)
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;`).catch(() => {});

  // Backfill id_text if needed (only if column existed but nulls)
  await pool.query(`
    UPDATE print_jobs
    SET id_text = COALESCE(id_text, 'print_' || md5(random()::text))
    WHERE id_text IS NULL;
  `).catch(() => {});
}

// -------------------- HELPERS (DB + MEM) --------------------
async function insertJob(job) {
  // job: {id_text, printer_id, from_phone, file_name, mime_type, file_url, status}
  if (!pool) {
    const row = {
      ...job,
      created_at: nowISO(),
      updated_at: nowISO()
    };
    mem.jobs.unshift(row);
    return row;
  }

  // IMPORTANT: do NOT insert into serial id. Use id_text instead.
  const result = await pool.query(
    `
    INSERT INTO print_jobs (
      id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
    RETURNING
      id_text, printer_id, from_phone, file_name, mime_type, file_url, status,
      created_at, updated_at;
    `,
    [
      job.id_text,
      job.printer_id,
      job.from_phone || null,
      job.file_name || null,
      job.mime_type || null,
      job.file_url || null,
      job.status || "needs_details"
    ]
  );
  return result.rows[0];
}

async function getRecentJobs(limit) {
  if (!pool) return mem.jobs.slice(0, limit);

  const result = await pool.query(
    `
    SELECT id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at
    FROM print_jobs
    ORDER BY created_at DESC
    LIMIT $1;
    `,
    [limit]
  );
  return result.rows;
}

async function setJobStatus(id_text, status) {
  if (!pool) {
    const j = mem.jobs.find(x => x.id_text === id_text);
    if (!j) return null;
    j.status = status;
    j.updated_at = nowISO();
    return j;
  }

  const result = await pool.query(
    `
    UPDATE print_jobs
    SET status = $2, updated_at = NOW()
    WHERE id_text = $1
    RETURNING id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at;
    `,
    [id_text, status]
  );
  return result.rows[0] || null;
}

async function getPaidQueue(printerId, limit) {
  if (!pool) {
    return mem.jobs
      .filter(j => j.printer_id === printerId && String(j.status).toLowerCase() === "paid")
      .slice(0, limit);
  }

  const result = await pool.query(
    `
    SELECT id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at
    FROM print_jobs
    WHERE printer_id = $1 AND LOWER(status) = 'paid'
    ORDER BY created_at ASC
    LIMIT $2;
    `,
    [printerId, limit]
  );
  return result.rows;
}

// -------------------- ROUTES --------------------

// Health
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "mstaf-core-1",
    host: os.hostname(),
    time: nowISO(),
    db: pool ? "postgres" : "memory"
  });
});

// Debug instance
app.get("/debug/instance", (req, res) => {
  res.json({
    pid: process.pid,
    host: os.hostname(),
    time: nowISO()
  });
});

// STEP 1: Upload a file => create job with status needs_details
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || "").trim();
    const from = (req.body.from || "").trim();

    if (!printerId) {
      return res.status(400).json({ ok: false, error: "Missing printerId" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Missing file field (multipart) named 'file'" });
    }

    const jobId = `print_${crypto.randomBytes(8).toString("hex")}`;

    // Build public file URL
    const base =
      PUBLIC_BASE_URL ||
      `${req.protocol}://${req.get("host")}`;

    const fileUrl = `${base}/uploads/${encodeURIComponent(req.file.filename)}`;

    const job = await insertJob({
      id_text: jobId,
      printer_id: printerId,
      from_phone: from || null,
      file_name: req.file.originalname || null,
      mime_type: req.file.mimetype || null,
      file_url: fileUrl,
      status: "needs_details"
    });

    return res.json({
      ok: true,
      message: "Queued print job (needs_details)",
      job: {
        id: job.id_text,
        printerId: job.printer_id,
        from: job.from_phone,
        fileName: job.file_name,
        mimeType: job.mime_type,
        fileUrl: job.file_url,
        status: job.status,
        createdAt: job.created_at
      }
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({ ok: false, error: "Upload failed", details: String(err.message || err) });
  }
});

// STEP 2: Admin list recent jobs (get job id)
app.get("/admin/jobs/recent", requireAdmin, async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 1, 50, 10);
    const rows = await getRecentJobs(limit);
    res.json({
      ok: true,
      limit,
      jobs: rows.map(r => ({
        id: r.id_text,
        printerId: r.printer_id,
        from: r.from_phone,
        fileName: r.file_name,
        mimeType: r.mime_type,
        fileUrl: r.file_url,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }))
    });
  } catch (err) {
    console.error("ADMIN RECENT ERROR:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch recent jobs", details: String(err.message || err) });
  }
});

// STEP 3: Admin force job to PAID (printer test, no credit deduction)
app.post("/admin/jobs/:id/force-paid", requireAdmin, async (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing job id" });

    const updated = await setJobStatus(id, "paid");
    if (!updated) return res.status(404).json({ ok: false, error: "Job not found" });

    res.json({
      ok: true,
      message: "Job forced to PAID",
      job: {
        id: updated.id_text,
        printerId: updated.printer_id,
        status: updated.status,
        updatedAt: updated.updated_at
      }
    });
  } catch (err) {
    console.error("FORCE-PAID ERROR:", err);
    res.status(500).json({ ok: false, error: "Failed to force paid", details: String(err.message || err) });
  }
});

// STEP 4: Printer queue (PAID ONLY)
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const limit = clampInt(req.query.limit, 1, 50, 5);
    const rows = await getPaidQueue(printerId, limit);

    res.json({
      ok: true,
      printerId,
      limit,
      jobs: rows.map(r => ({
        id: r.id_text,
        printerId: r.printer_id,
        from: r.from_phone,
        fileName: r.file_name,
        mimeType: r.mime_type,
        fileUrl: r.file_url,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }))
    });
  } catch (err) {
    console.error("JOBS QUEUE ERROR:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch jobs queue", details: String(err.message || err) });
  }
});

// Optional: update status (useful later for printer)
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const id = (req.params.id || "").trim();
    const status = (req.body.status || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing job id" });
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    const updated = await setJobStatus(id, status);
    if (!updated) return res.status(404).json({ ok: false, error: "Job not found" });

    res.json({
      ok: true,
      message: "Status updated",
      job: {
        id: updated.id_text,
        printerId: updated.printer_id,
        status: updated.status,
        updatedAt: updated.updated_at
      }
    });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ ok: false, error: "Failed to update status", details: String(err.message || err) });
  }
});

// Optional Twilio webhook (safe to keep even if unused)
app.post("/sms", async (req, res) => {
  try {
    // If you’re not using Twilio yet, just acknowledge.
    // You can expand this later for opt-ins, credits, etc.
    const from = req.body.From || req.body.from || "";
    const body = req.body.Body || req.body.body || "";
    const numMedia = parseInt(req.body.NumMedia || "0", 10) || 0;

    console.log("TWILIO INBOUND:", { from, body, numMedia });

    // Respond TwiML only if twilio module is available (not required)
    if (twilio) {
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message("MSTAF received your message. (System online)");
      res.type("text/xml").send(twiml.toString());
    } else {
      res.json({ ok: true, message: "Received (Twilio lib not installed)", from, body, numMedia });
    }
  } catch (err) {
    console.error("TWILIO /sms ERROR:", err);
    res.status(500).json({ ok: false, error: "Twilio webhook error", details: String(err.message || err) });
  }
});

// -------------------- START --------------------
(async () => {
  try {
    await dbInit();
    console.log("DB init OK:", pool ? "postgres" : "memory");
  } catch (e) {
    console.error("DB init failed. Running with fallback if possible:", e);
    // If postgres init fails, we can still run in memory (pool exists but broken).
    // To force memory, unset DATABASE_URL in Render until DB is ready.
  }

  app.listen(PORT, () => {
    console.log(`MSTAF CORE listening on port ${PORT}`);
  });
})();

