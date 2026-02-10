/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * - Upload endpoint: POST /api/upload (multipart/form-data)
 * - Printer polling: GET /jobs/next?printerId=PP-USA-001
 * - Count endpoint: GET /jobs/count?printerId=PP-USA-001
 * - Update status: POST /jobs/:jobId/status
 * - Public file hosting: /uploads/<filename>
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

// ---- Postgres (Render) ----
let Pool = null;
try {
  ({ Pool } = require("pg"));
} catch (e) {
  Pool = null;
}

const app = express();

// Twilio + JSON safety
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- Uploads folder ----
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// Store files on disk
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^\w.\-]/g, "_");
    const stamp = Date.now();
    cb(null, `${stamp}_${safeName}`);
  }
});
const upload = multer({ storage });

// ---- DB connection ----
const DATABASE_URL = process.env.DATABASE_URL || "";
const hasDb = !!(Pool && DATABASE_URL);

const pool = hasDb
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

// ---- Auto-migrate schema ----
async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE,
      printer_id TEXT NOT NULL,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_url TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status_created
    ON print_jobs (printer_id, status, created_at);
  `);
}

// Call on boot
ensureSchema().catch((e) => console.error("SCHEMA INIT ERROR:", e));

// ---- Helpers ----
function baseUrlFromReq(req) {
  // Prefer explicit BASE_URL if you set it in Render env
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "http").toString();
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ---- Health / debug ----
app.get("/health", (req, res) => {
  res.json({ ok: true, time: nowIso(), host: os.hostname(), db: !!pool });
});

app.get("/debug/instance", (req, res) => {
  res.json({
    pid: process.pid,
    host: os.hostname(),
    time: nowIso()
  });
});

// =====================================================
// ✅ FIXED UPLOAD ROUTE (job_id ALWAYS CREATED + INSERTED)
// =====================================================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({ ok: false, error: "DATABASE_URL not set / DB not available" });
    }

    const printerId = (req.body.printerId || "").trim();
    const from = (req.body.from || "").trim();

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file" });

    // ✅ This is the fix: job_id generated and used in INSERT
    const jobId = `print_${crypto.randomBytes(8).toString("hex")}`;

    const baseUrl = baseUrlFromReq(req);
    const fileUrl = `${baseUrl}/uploads/${encodeURIComponent(req.file.filename)}`;

    const q = `
      INSERT INTO print_jobs (
        job_id,
        printer_id,
        from_phone,
        file_name,
        mime_type,
        file_url,
        status,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,'queued', NOW())
      RETURNING id, job_id, printer_id, status, file_url, file_name, mime_type, created_at;
    `;

    const r = await pool.query(q, [
      jobId,
      printerId,
      from,
      req.file.originalname,
      req.file.mimetype,
      fileUrl
    ]);

    return res.json({
      ok: true,
      message: "Queued print job",
      job: {
        id: r.rows[0].id,
        jobId: r.rows[0].job_id,
        printerId: r.rows[0].printer_id,
        status: r.rows[0].status,
        fileUrl: r.rows[0].file_url,
        fileName: r.rows[0].file_name,
        mimeType: r.rows[0].mime_type,
        createdAt: r.rows[0].created_at
      }
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// =====================================================
// Printer worker route: claim next job
// GET /jobs/next?printerId=PP-USA-001
// =====================================================
app.get("/jobs/next", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DB not available" });

    const printerId = (req.query.printerId || "").toString().trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    // Atomically claim the oldest queued job for this printer
    const q = `
      WITH next_job AS (
        SELECT id
        FROM print_jobs
        WHERE printer_id = $1 AND status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE print_jobs
      SET status = 'processing', updated_at = NOW()
      WHERE id IN (SELECT id FROM next_job)
      RETURNING id, job_id, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at;
    `;

    const r = await pool.query(q, [printerId]);

    if (r.rows.length === 0) {
      return res.json({ ok: true, job: null });
    }

    return res.json({ ok: true, job: r.rows[0] });
  } catch (err) {
    console.error("NEXT JOB ERROR:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// List jobs (optional, helpful)
app.get("/jobs", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DB not available" });

    const printerId = (req.query.printerId || "").toString().trim();
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

    const q = printerId
      ? `SELECT * FROM print_jobs WHERE printer_id=$1 ORDER BY created_at DESC LIMIT $2`
      : `SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT $1`;

    const r = printerId
      ? await pool.query(q, [printerId, limit])
      : await pool.query(q, [limit]);

    res.json({ ok: true, jobs: r.rows });
  } catch (err) {
    console.error("LIST JOBS ERROR:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Count endpoint
app.get("/jobs/count", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DB not available" });

    const printerId = (req.query.printerId || "").toString().trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const q = `SELECT status, COUNT(*)::int AS count FROM print_jobs WHERE printer_id=$1 GROUP BY status`;
    const r = await pool.query(q, [printerId]);

    const byStatus = {};
    for (const row of r.rows) byStatus[row.status] = row.count;

    res.json({ ok: true, printerId, byStatus });
  } catch (err) {
    console.error("COUNT ERROR:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Worker updates status: completed/failed/etc
app.post("/jobs/:jobId/status", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DB not available" });

    const jobId = (req.params.jobId || "").trim();
    const status = (req.body.status || "").trim();

    if (!jobId) return res.status(400).json({ ok: false, error: "Missing jobId" });
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    const q = `
      UPDATE print_jobs
      SET status=$2, updated_at=NOW()
      WHERE job_id=$1
      RETURNING job_id, status, updated_at;
    `;

    const r = await pool.query(q, [jobId, status]);

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Job not found" });
    }

    res.json({ ok: true, job: r.rows[0] });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ---- Start server ----
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`MSTAF CORE listening on port ${PORT}`);
});

