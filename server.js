/**
 * MSTAF CORE - server.js (Print-O-Matic + Worker Queue) ✅ COMPLETE REPLACEMENT
 * Works on Render.
 *
 * ✅ Key Fixes Included:
 * 1) POST /jobs/next?printerId=PP-USA-001   (worker claims next queued job)
 * 2) POST /api/upload                       (uploads file + ALWAYS creates queued job)
 *
 * Endpoints:
 * - GET  /health
 * - POST /sms                     (Twilio inbound safe stub)
 * - POST /api/upload              (multipart/form-data: printerId, from, file)
 * - GET  /jobs?printerId=...
 * - GET  /jobs/count?printerId=...
 * - POST /jobs/next?printerId=... (worker claims job)
 * - POST /jobs/:jobId/status      (mark printing/done/failed)
 * - GET  /debug/instance
 *
 * Notes:
 * - Uses Postgres if DATABASE_URL is set.
 * - Auto-creates print_jobs table if missing.
 * - Serves uploaded files at /uploads/<filename>
 */

if (process.env.NODE_ENV !== "production") {
  try { require("dotenv").config(); } catch (e) {}
}

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

// -------------------- App --------------------
const app = express();

// Twilio posts x-www-form-urlencoded. Also accept JSON.
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------- Uploads folder --------------------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Serve uploads publicly
app.use("/uploads", express.static(uploadsDir));

// Multer config (store file on disk)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const safeExt = ext && ext.length <= 10 ? ext : "";
    cb(null, `mstaf_${Date.now()}_${crypto.randomBytes(8).toString("hex")}${safeExt}`);
  }
});
const upload = multer({ storage });

// -------------------- Optional Postgres --------------------
let pool = null;

async function initDbIfAvailable() {
  if (!process.env.DATABASE_URL) {
    console.log("DB: DATABASE_URL not set, running WITHOUT Postgres (limited mode).");
    return;
  }

  let pg;
  try {
    pg = require("pg");
  } catch (e) {
    console.log("DB: pg not installed, running WITHOUT Postgres.");
    return;
  }

  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // Create table if missing
  const createSql = `
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT UNIQUE,
      printer_id TEXT NOT NULL,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_url TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status_created
      ON print_jobs (printer_id, status, created_at);
  `;

  await pool.query(createSql);
  console.log("DB: connected + print_jobs ensured");
}

// -------------------- Helpers --------------------
function publicBaseUrl(req) {
  // Prefer explicit BASE_URL if you set it in Render env
  if (process.env.BASE_URL && /^https?:\/\//i.test(process.env.BASE_URL)) return process.env.BASE_URL.replace(/\/+$/, "");
  // Otherwise build from request
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function makeJobId() {
  return `print_${crypto.randomBytes(10).toString("hex")}`;
}

// -------------------- Debug --------------------
app.get("/debug/instance", (req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    host: os.hostname(),
    time: new Date().toISOString()
  });
});

// -------------------- Health --------------------
app.get("/health", async (req, res) => {
  try {
    let db = "disabled";
    if (pool) {
      await pool.query("SELECT 1");
      db = "connected";
    }
    res.json({ ok: true, host: os.hostname(), time: new Date().toISOString(), db });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

// -------------------- Twilio inbound (safe stub) --------------------
app.post("/sms", async (req, res) => {
  // Keep it simple: acknowledge inbound so Twilio doesn't retry.
  // You can later expand to create jobs via SMS, etc.
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
});

// -------------------- Upload + AUTO-QUEUE JOB --------------------
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || req.body.printer_id || "").toString().trim();
    const from = (req.body.from || req.body.from_phone || "").toString().trim();
    const providedJobId = (req.body.job_id || req.body.jobId || "").toString().trim();

    if (!printerId) return res.status(400).json({ ok: false, error: "printerId required" });
    if (!req.file) return res.status(400).json({ ok: false, error: "No file upload" });

    const base = publicBaseUrl(req);
    const fileUrl = `${base}/uploads/${req.file.filename}`;
    const fileName = req.file.originalname || req.file.filename;
    const mimeType = req.file.mimetype || "application/octet-stream";

    if (!pool) {
      // No DB means we can upload but cannot queue persistent jobs.
      return res.json({
        ok: true,
        queued: false,
        attached: false,
        fileUrl,
        fileName,
        mimeType,
        note: "Uploaded, but DATABASE_URL not set so job cannot be queued."
      });
    }

    // If job_id provided, attach to that job if it exists; else create a new one.
    let jobIdText = providedJobId || makeJobId();

    // Check if provided job exists (when job_id is sent)
    if (providedJobId) {
      const check = await pool.query(
        `SELECT id, id_text FROM print_jobs WHERE id_text = $1 LIMIT 1`,
        [providedJobId]
      );
      if (check.rowCount === 0) {
        // Create it (instead of failing)
        await pool.query(
          `
          INSERT INTO print_jobs (id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,'queued',NOW(),NOW())
          `,
          [jobIdText, printerId, from, fileName, mimeType, fileUrl]
        );
      } else {
        // Update existing job with file info and re-queue if needed
        await pool.query(
          `
          UPDATE print_jobs
          SET printer_id=$2, from_phone=$3, file_name=$4, mime_type=$5, file_url=$6,
              status = CASE WHEN status IN ('done','failed') THEN 'queued' ELSE status END,
              updated_at=NOW()
          WHERE id_text=$1
          `,
          [jobIdText, printerId, from, fileName, mimeType, fileUrl]
        );
      }
    } else {
      // No job_id provided → ALWAYS create a new queued job
      await pool.query(
        `
        INSERT INTO print_jobs (id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'queued',NOW(),NOW())
        `,
        [jobIdText, printerId, from, fileName, mimeType, fileUrl]
      );
    }

    // Return the queued job
    const out = await pool.query(
      `SELECT id_text, printer_id, from_phone, file_name, mime_type, file_url, status
       FROM print_jobs WHERE id_text=$1 LIMIT 1`,
      [jobIdText]
    );

    const job = out.rows[0] || {
      id_text: jobIdText,
      printer_id: printerId,
      from_phone: from,
      file_name: fileName,
      mime_type: mimeType,
      file_url: fileUrl,
      status: "queued"
    };

    return res.json({
      ok: true,
      message: "Queued print job",
      job: {
        job_id: job.id_text,
        printerId: job.printer_id,
        from: job.from_phone,
        fileName: job.file_name,
        mimeType: job.mime_type,
        fileUrl: job.file_url,
        status: job.status
      }
    });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// -------------------- List jobs --------------------
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").toString().trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "printerId required" });

    if (!pool) return res.json({ ok: true, jobs: [] });

    const r = await pool.query(
      `SELECT id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at
       FROM print_jobs
       WHERE printer_id=$1
       ORDER BY created_at DESC
       LIMIT 50`,
      [printerId]
    );

    res.json({
      ok: true,
      jobs: r.rows.map(j => ({
        job_id: j.id_text,
        printerId: j.printer_id,
        from: j.from_phone,
        fileName: j.file_name,
        mimeType: j.mime_type,
        fileUrl: j.file_url,
        status: j.status,
        createdAt: j.created_at,
        updatedAt: j.updated_at
      }))
    });
  } catch (e) {
    console.error("JOBS LIST ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// -------------------- Count jobs --------------------
app.get("/jobs/count", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").toString().trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "printerId required" });

    if (!pool) return res.json({ ok: true, printerId, queued: 0, printing: 0, done: 0, failed: 0 });

    const r = await pool.query(
      `
      SELECT
        SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status='printing' THEN 1 ELSE 0 END) AS printing,
        SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
      FROM print_jobs
      WHERE printer_id=$1
      `,
      [printerId]
    );

    const row = r.rows[0] || {};
    res.json({
      ok: true,
      printerId,
      queued: Number(row.queued || 0),
      printing: Number(row.printing || 0),
      done: Number(row.done || 0),
      failed: Number(row.failed || 0)
    });
  } catch (e) {
    console.error("JOBS COUNT ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// -------------------- Worker claims next queued job --------------------
// Worker calls: POST /jobs/next?printerId=PP-USA-001
app.post("/jobs/next", async (req, res) => {
  try {
    const printerId = (req.query.printerId || req.body.printerId || "").toString().trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "printerId required" });
    if (!pool) return res.json({ ok: true, job: null });

    // Claim the oldest queued job for this printer
    const q = `
      UPDATE print_jobs
      SET status='printing', updated_at=NOW()
      WHERE id = (
        SELECT id FROM print_jobs
        WHERE printer_id=$1 AND status='queued'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id_text, printer_id, from_phone, file_name, mime_type, file_url, status;
    `;
    const r = await pool.query(q, [printerId]);

    if (r.rowCount === 0) return res.json({ ok: true, job: null });

    const j = r.rows[0];
    return res.json({
      ok: true,
      job: {
        job_id: j.id_text,
        printer_id: j.printer_id,
        from_phone: j.from_phone,
        file_name: j.file_name,
        mime_type: j.mime_type,
        file_url: j.file_url,
        status: j.status
      }
    });
  } catch (e) {
    console.error("JOBS NEXT ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// -------------------- Update job status --------------------
// Worker calls: POST /jobs/:jobId/status  with JSON { status: "done" }
app.post("/jobs/:jobId/status", async (req, res) => {
  try {
    const jobId = (req.params.jobId || "").toString().trim();
    const status = (req.body.status || "").toString().trim();

    if (!jobId) return res.status(400).json({ ok: false, error: "jobId required" });
    if (!status) return res.status(400).json({ ok: false, error: "status required" });
    if (!pool) return res.json({ ok: true });

    await pool.query(
      `UPDATE print_jobs SET status=$2, updated_at=NOW() WHERE id_text=$1`,
      [jobId, status]
    );

    res.json({ ok: true, job_id: jobId, status });
  } catch (e) {
    console.error("STATUS UPDATE ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// -------------------- Start --------------------
const PORT = process.env.PORT || 10000;

initDbIfAvailable()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MSTAF CORE listening on port ${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Startup DB init failed:", e);
    // Still start server even if DB init fails (health will show db_error)
    app.listen(PORT, () => {
      console.log(`MSTAF CORE listening on port ${PORT} (DB init failed)`);
    });
  });
