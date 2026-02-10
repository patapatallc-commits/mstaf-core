/**
 * MSTAF CORE - Print-O-Matic Server (Render)
 * - Upload endpoint: POST /api/upload (multipart/form-data)
 * - Printer polling: GET /jobs/next?printerId=PP-USA-001
 * - List jobs: GET /jobs?printerId=PP-USA-001
 * - Count endpoint: GET /jobs/count?printerId=PP-USA-001
 * - Update status: POST /jobs/:jobId/status
 * - Public file hosting: /uploads/<filename>
 *
 * IMPORTANT:
 * This server uses DB column: id_text (your DB already shows id_text in records).
 * It returns job_id as an alias = id_text for compatibility.
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

const { Pool } = require("pg");

const app = express();

// Twilio-style + JSON safe
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- Uploads folder ----------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// Store files on disk
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^\w.\-]/g, "_");
    cb(null, `${Date.now()}_${safeName}`);
  }
});
const upload = multer({ storage });

// ---------- DB ----------
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------- Helpers ----------
function baseUrlFromReq(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "http").toString();
  const host = req.headers.host;
  return `${proto}://${host}`;
}

async function ensureSchema() {
  // Create table if missing using the schema your DB output shows (id_text + file_url)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT NOT NULL UNIQUE,
      printer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      file_url TEXT,
      mime_type TEXT,
      file_name TEXT,
      from_phone TEXT,
      details TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status_created
    ON print_jobs (printer_id, status, created_at);
  `);
}

ensureSchema().catch((e) => console.error("SCHEMA INIT ERROR:", e));

// ---------- Health ----------
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, time: new Date().toISOString(), host: os.hostname(), db: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, db: false });
  }
});

app.get("/debug/instance", (req, res) => {
  res.json({ pid: process.pid, host: os.hostname(), time: new Date().toISOString() });
});

// =====================================================
// ✅ Upload: POST /api/upload
// - Inserts id_text (job id string) NOT NULL
// - Stores file_url in DB
// - Returns job_id alias for compatibility
// =====================================================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || "").trim();
    const from = (req.body.from || "").trim();

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file" });

    const jobId = `print_${crypto.randomBytes(8).toString("hex")}`;

    const baseUrl = baseUrlFromReq(req);
    const fileUrl = `${baseUrl}/uploads/${encodeURIComponent(req.file.filename)}`;

    const q = `
      INSERT INTO print_jobs (
        id_text, printer_id, status, file_url, mime_type, file_name, from_phone, updated_at
      )
      VALUES ($1,$2,'queued',$3,$4,$5,$6,NOW())
      RETURNING id, id_text, printer_id, status, file_url, created_at;
    `;

    const r = await pool.query(q, [
      jobId,
      printerId,
      fileUrl,
      req.file.mimetype,
      req.file.originalname,
      from
    ]);

    const row = r.rows[0];

    res.json({
      ok: true,
      message: "Queued print job",
      job: {
        id: row.id,
        id_text: row.id_text,
        job_id: row.id_text,          // 👈 alias for compatibility
        printer_id: row.printer_id,
        printerId: row.printer_id,    // extra convenience
        status: row.status,
        file_url: row.file_url,
        fileUrl: row.file_url,
        created_at: row.created_at
      }
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// =====================================================
// ✅ Worker claim: GET /jobs/next?printerId=PP-USA-001
// - Claims oldest queued job for that printer
// - Sets status to 'printing'
// - Returns job fields using id_text + file_url
// - Also returns job_id alias = id_text
// =====================================================
app.get("/jobs/next", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").toString().trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

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
      SET status = 'printing', updated_at = NOW()
      WHERE id IN (SELECT id FROM next_job)
      RETURNING id, id_text, printer_id, status, file_url, mime_type, file_name, from_phone, created_at, updated_at;
    `;

    const r = await pool.query(q, [printerId]);

    if (r.rows.length === 0) {
      return res.json({ ok: true, job: null });
    }

    const row = r.rows[0];

    return res.json({
      ok: true,
      job: {
        id: row.id,
        id_text: row.id_text,
        job_id: row.id_text,        // 👈 alias
        printer_id: row.printer_id,
        file_url: row.file_url,
        mime_type: row.mime_type,
        file_name: row.file_name,
        from_phone: row.from_phone,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at
      }
    });
  } catch (err) {
    console.error("JOBS NEXT ERROR:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// List jobs (helps debugging)
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").toString().trim();
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);

    const q = printerId
      ? `SELECT * FROM print_jobs WHERE printer_id=$1 ORDER BY created_at DESC LIMIT $2`
      : `SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT $1`;

    const r = printerId
      ? await pool.query(q, [printerId, limit])
      : await pool.query(q, [limit]);

    // Add job_id alias to each row for compatibility
    const jobs = r.rows.map(j => ({
      ...j,
      job_id: j.id_text
    }));

    res.json({ ok: true, jobs });
  } catch (err) {
    console.error("LIST JOBS ERROR:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// Count by status
app.get("/jobs/count", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").toString().trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const r = await pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM print_jobs
       WHERE printer_id=$1
       GROUP BY status`,
      [printerId]
    );

    const byStatus = {};
    for (const row of r.rows) byStatus[row.status] = row.count;

    res.json({ ok: true, printerId, byStatus });
  } catch (err) {
    console.error("COUNT ERROR:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// =====================================================
// Update status: POST /jobs/:jobId/status
// Accepts jobId = id_text (or job_id alias)
// Body: { "status": "done"|"failed"|..., "details": "..." }
// =====================================================
app.post("/jobs/:jobId/status", async (req, res) => {
  try {
    const jobId = (req.params.jobId || "").toString().trim();
    const status = (req.body.status || "").toString().trim();
    const details = req.body.details ? String(req.body.details) : null;

    if (!jobId) return res.status(400).json({ ok: false, error: "Missing jobId" });
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    const q = `
      UPDATE print_jobs
      SET status=$2,
          details = COALESCE($3, details),
          updated_at=NOW()
      WHERE id_text=$1
      RETURNING id, id_text, printer_id, status, details, updated_at;
    `;

    const r = await pool.query(q, [jobId, status, details]);

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Job not found" });
    }

    const row = r.rows[0];
    res.json({
      ok: true,
      job: {
        id: row.id,
        id_text: row.id_text,
        job_id: row.id_text,      // alias
        printer_id: row.printer_id,
        status: row.status,
        details: row.details,
        updated_at: row.updated_at
      }
    });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`MSTAF CORE listening on port ${PORT}`);
});

