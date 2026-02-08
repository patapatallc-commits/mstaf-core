/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * - Upload endpoint: POST /api/upload (multipart/form-data)
 * - Printer polling: GET /jobs?printerId=PP-USA-001&limit=5   (PAID ONLY)
 * - Admin: GET /admin/jobs/recent?limit=10  (x-admin-key)
 * - Admin: POST /admin/jobs/:id/force-paid (x-admin-key)
 * - Uses Postgres if DATABASE_URL is set, otherwise in-memory fallback
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

// Optional Postgres (pg)
let pg = null;
try { pg = require("pg"); } catch (e) { pg = null; }

const app = express();

// Twilio uses x-www-form-urlencoded; we also accept JSON
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------- CONFIG --------------------
const ADMIN_KEY = process.env.MSTAF_ADMIN_KEY || "MSTAF_ADMIN_2026_SECURE_KEY";
const SERVICE_NAME = process.env.SERVICE_NAME || "mstaf-core-1";

// Uploads folder + public access
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").slice(0, 16) || "";
    const name = `upl_${Date.now()}_${crypto.randomBytes(6).toString("hex")}${ext}`;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// In-memory fallback
const mem = { jobs: [] };

// Postgres pool (if available)
let pool = null;
if (pg && process.env.DATABASE_URL) {
  const { Pool } = pg;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// -------------------- DB MIGRATIONS --------------------
async function ensureDb() {
  if (!pool) return;

  // Create base table if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      printer_id TEXT,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_url TEXT,
      status TEXT DEFAULT 'needs_details',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      paid_at TIMESTAMPTZ
    );
  `);

  // Add columns used across versions
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS job_id TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS details JSONB;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS error TEXT;`).catch(() => {});

  // Backfill: ensure id_text and job_id are never null
  await pool.query(`
    UPDATE print_jobs
    SET id_text = COALESCE(id_text, job_id, 'print_' || md5(random()::text))
    WHERE id_text IS NULL;
  `).catch(() => {});

  await pool.query(`
    UPDATE print_jobs
    SET job_id = COALESCE(job_id, id_text)
    WHERE job_id IS NULL;
  `).catch(() => {});

  // Try to enforce NOT NULL on job_id if possible (safe best-effort)
  await pool.query(`ALTER TABLE print_jobs ALTER COLUMN job_id SET NOT NULL;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ALTER COLUMN id_text SET NOT NULL;`).catch(() => {});

  // Helpful uniqueness (best-effort)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_job_id_uq ON print_jobs(job_id);`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_id_text_uq ON print_jobs(id_text);`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS print_jobs_printer_status_idx ON print_jobs(printer_id, status, created_at);`).catch(() => {});
}

// Call migrations at startup (best-effort)
ensureDb().catch((e) => console.error("DB INIT ERROR:", e));

// -------------------- HELPERS --------------------
function nowISO() { return new Date().toISOString(); }

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

function normalizeLimit(v, def = 10, max = 50) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) return def;
  return Math.min(n, max);
}

function buildPublicFileUrl(req, filename) {
  // Render/proxies sometimes provide x-forwarded-proto
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").toString();
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}/uploads/${encodeURIComponent(filename)}`;
}

function makeJobId() {
  return `print_${crypto.randomBytes(8).toString("hex")}`;
}

// Insert job into DB or memory
async function insertJob(job) {
  // job: {id_text, job_id, printer_id, from_phone, file_name, mime_type, file_url, status}
  if (!pool) {
    const row = { ...job, created_at: nowISO(), updated_at: nowISO() };
    mem.jobs.unshift(row);
    return row;
  }

  // IMPORTANT: do NOT insert into serial id. Use id_text + job_id.
  const result = await pool.query(
    `
    INSERT INTO print_jobs (
      job_id,
      id_text,
      printer_id,
      from_phone,
      file_name,
      mime_type,
      file_url,
      status,
      created_at,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
    RETURNING
      job_id, id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at, paid_at;
    `,
    [
      job.job_id,
      job.id_text,
      job.printer_id,
      job.from_phone || null,
      job.file_name,
      job.mime_type,
      job.file_url,
      job.status
    ]
  );

  return result.rows[0];
}

async function updateJobStatus(id, status) {
  if (!pool) {
    const j = mem.jobs.find(x => x.id_text === id || x.job_id === id);
    if (!j) return null;
    j.status = status;
    j.updated_at = nowISO();
    if (status === "paid") j.paid_at = nowISO();
    return j;
  }

  const result = await pool.query(
    `
    UPDATE print_jobs
    SET status = $2,
        updated_at = NOW(),
        paid_at = CASE WHEN $2 = 'paid' THEN NOW() ELSE paid_at END
    WHERE id_text = $1 OR job_id = $1
    RETURNING job_id, id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at, paid_at;
    `,
    [id, status]
  );
  return result.rows[0] || null;
}

async function getRecentJobs(limit = 10) {
  if (!pool) return mem.jobs.slice(0, limit);

  const result = await pool.query(
    `
    SELECT job_id, id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at, paid_at
    FROM print_jobs
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return result.rows;
}

async function getPaidJobsForPrinter(printerId, limit = 5) {
  if (!pool) {
    return mem.jobs
      .filter(j => j.printer_id === printerId && j.status === "paid")
      .slice(0, limit);
  }

  const result = await pool.query(
    `
    SELECT job_id, id_text, printer_id, from_phone, file_name, mime_type, file_url, status, created_at, updated_at, paid_at
    FROM print_jobs
    WHERE printer_id = $1 AND status = 'paid'
    ORDER BY created_at ASC
    LIMIT $2
    `,
    [printerId, limit]
  );
  return result.rows;
}

// -------------------- ROUTES --------------------

// Basic health/info
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    host: os.hostname(),
    time: new Date().toISOString(),
    db: pool ? "postgres" : "memory"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    host: os.hostname(),
    time: new Date().toISOString(),
    db: pool ? "postgres" : "memory"
  });
});

// Debug instance
app.get("/debug/instance", (req, res) => {
  res.json({
    pid: process.pid,
    host: os.hostname(),
    time: new Date().toISOString()
  });
});

/**
 * Upload (multipart/form-data)
 * Form fields:
 * - printerId: "PP-USA-001"
 * - from: "+18628372173"
 * - file: <binary>
 *
 * Creates a job with status: needs_details
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || "").toString().trim();
    const from = (req.body.from || "").toString().trim();

    if (!printerId) {
      return res.status(400).json({ ok: false, error: "Missing printerId" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Missing file" });
    }

    const idText = makeJobId();
    const jobId = idText; // Keep them the same to satisfy either schema

    const fileUrl = buildPublicFileUrl(req, req.file.filename);

    const job = {
      id_text: idText,
      job_id: jobId,
      printer_id: printerId,
      from_phone: from || null,
      file_name: req.file.originalname || req.file.filename,
      mime_type: req.file.mimetype || "application/octet-stream",
      file_url: fileUrl,
      status: "needs_details"
    };

    const saved = await insertJob(job);

    return res.json({
      ok: true,
      message: "Queued print job (needs_details)",
      job: saved
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Upload failed",
      details: err?.message || String(err)
    });
  }
});

/**
 * Printer queue (PAID ONLY)
 * GET /jobs?printerId=PP-USA-001&limit=5
 */
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").toString().trim();
    const limit = normalizeLimit(req.query.limit, 5, 50);

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const jobs = await getPaidJobsForPrinter(printerId, limit);
    return res.json({ ok: true, printerId, jobs });
  } catch (err) {
    console.error("JOBS ERROR:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch jobs" });
  }
});

// Paid queue count
app.get("/jobs/count", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").toString().trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const jobs = await getPaidJobsForPrinter(printerId, 50);
    return res.json({ ok: true, printerId, count: jobs.length });
  } catch (err) {
    console.error("COUNT ERROR:", err);
    return res.status(500).json({ ok: false, error: "Failed to count jobs" });
  }
});

// -------------------- ADMIN --------------------

// Recent jobs
app.get("/admin/jobs/recent", requireAdmin, async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit, 10, 50);
    const jobs = await getRecentJobs(limit);
    res.json({ ok: true, jobs });
  } catch (err) {
    console.error("ADMIN RECENT ERROR:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch recent jobs" });
  }
});

// Force-paid (printer test, no credit deduction)
app.post("/admin/jobs/:id/force-paid", requireAdmin, async (req, res) => {
  try {
    const id = (req.params.id || "").toString().trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    const updated = await updateJobStatus(id, "paid");
    if (!updated) return res.status(404).json({ ok: false, error: "Job not found" });

    res.json({ ok: true, message: "Job forced to PAID", job: updated });
  } catch (err) {
    console.error("FORCE PAID ERROR:", err);
    res.status(500).json({ ok: false, error: "Failed to force paid" });
  }
});

// Set status (admin)
app.post("/admin/jobs/:id/status", requireAdmin, async (req, res) => {
  try {
    const id = (req.params.id || "").toString().trim();
    const status = (req.body.status || "").toString().trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    const updated = await updateJobStatus(id, status);
    if (!updated) return res.status(404).json({ ok: false, error: "Job not found" });

    res.json({ ok: true, job: updated });
  } catch (err) {
    console.error("SET STATUS ERROR:", err);
    res.status(500).json({ ok: false, error: "Failed to update status" });
  }
});

// -------------------- START --------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] listening on port ${PORT} | db=${pool ? "postgres" : "memory"}`);
});

