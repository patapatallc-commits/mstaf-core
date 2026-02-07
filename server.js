/**
 * MSTAF CORE - server.js (Render-ready)
 * - Upload -> print_jobs queue (Print-O-Matic)
 * - Twilio SMS webhook (x-www-form-urlencoded)
 * - SAFE DB migrations (adds columns if missing)
 * - IMPORTANT: uses job_id / id_text for string IDs; never writes to integer id
 */

require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

// ===== Middleware =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Uploads folder + public access =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// ===== Database =====
const DATABASE_URL = process.env.DATABASE_URL;
const DB_SSL = (process.env.DB_SSL || "true").toLowerCase() !== "false"; // default true

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DB_SSL ? { rejectUnauthorized: false } : false,
    })
  : null;

// ===== Helpers =====
function nowIso() {
  return new Date().toISOString();
}

function makeJobId() {
  return `print_${crypto.randomBytes(10).toString("hex")}`;
}

function requireDb(req, res) {
  if (!pool) {
    res.status(500).json({
      ok: false,
      error: "DATABASE_URL is not set. DB is not configured on this service.",
    });
    return false;
  }
  return true;
}

// ===== Multer (multipart/form-data) =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base = crypto.randomBytes(8).toString("hex");
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// =====================================
// ===== DB INIT + SAFE MIGRATIONS ======
// =====================================
async function initDbIfPossible() {
  if (!pool) {
    console.log("[DB] DATABASE_URL missing. Skipping DB init.");
    return;
  }

  // We keep this CREATE TABLE broad enough for new installs.
  // If your table already exists, this will not destroy anything.
  const migrations = [
    `CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      job_id TEXT,
      printer_id TEXT,
      status TEXT DEFAULT 'queued',
      pages INTEGER,
      copies INTEGER,
      color TEXT,
      source TEXT,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_base64 TEXT,
      file_url TEXT,
      id_text TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,

    // Add missing columns safely (your DB already has many of these — IF NOT EXISTS makes it safe)
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS job_id TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS pages INTEGER;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS copies INTEGER;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS color TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS source TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_base64 TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS meta JSONB;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;`,

    // Indexes (safe)
    `CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status_created
      ON print_jobs (printer_id, status, created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_print_jobs_job_id ON print_jobs (job_id);`,
    `CREATE INDEX IF NOT EXISTS idx_print_jobs_id_text ON print_jobs (id_text);`,
  ];

  try {
    console.log("[DB] Running migrations...");
    for (const sql of migrations) {
      await pool.query(sql);
    }

    // Backfill: keep id_text populated for old numeric rows
    await pool.query(`
      UPDATE print_jobs
      SET id_text = COALESCE(id_text, id::text)
      WHERE id_text IS NULL;
    `);

    console.log("[DB] Migrations complete.");
  } catch (err) {
    console.error("[DB] Migration error:", err.message);
  }
}

// =====================================
// ===== DB FUNCTIONS (job_id first) ====
// =====================================

/**
 * Insert a job.
 * IMPORTANT: We NEVER insert into integer "id".
 * We store string identifiers in job_id (and id_text for compatibility).
 */
async function dbInsertJob({
  jobId,
  printerId,
  fromPhone,
  fileUrl,
  fileName,
  mimeType,
  source,
  meta,
}) {
  if (!pool) throw new Error("DB not configured");

  const q = `
    INSERT INTO print_jobs (
      job_id,
      id_text,
      printer_id,
      status,
      source,
      from_phone,
      file_name,
      mime_type,
      file_url,
      meta,
      created_at,
      updated_at
    )
    VALUES ($1,$2,$3,'queued',$4,$5,$6,$7,$8,$9,NOW(),NOW())
    RETURNING
      COALESCE(job_id, id_text, id::text) AS id,
      id AS numeric_id,
      job_id,
      id_text,
      printer_id,
      status,
      source,
      from_phone,
      file_name,
      mime_type,
      file_url,
      created_at,
      updated_at,
      meta;
  `;

  const vals = [
    jobId,
    jobId, // keep id_text aligned too
    printerId || null,
    source || "upload",
    fromPhone || null,
    fileName || null,
    mimeType || null,
    fileUrl || null,
    meta || null,
  ];

  const r = await pool.query(q, vals);
  return r.rows[0];
}

/**
 * Fetch queued/retry jobs for a printer.
 */
async function dbGetNextJobs({ printerId, limit = 10 }) {
  if (!pool) throw new Error("DB not configured");

  const q = `
    SELECT
      COALESCE(job_id, id_text, id::text) AS id,
      id AS numeric_id,
      job_id,
      id_text,
      printer_id,
      status,
      pages,
      copies,
      color,
      source,
      from_phone,
      file_name,
      mime_type,
      file_base64,
      file_url,
      created_at,
      updated_at,
      meta
    FROM print_jobs
    WHERE printer_id = $1
      AND COALESCE(status,'queued') IN ('queued','retry')
    ORDER BY created_at ASC NULLS LAST
    LIMIT $2;
  `;

  const r = await pool.query(q, [printerId, limit]);
  return r.rows;
}

/**
 * Update status by id (accepts job_id OR id_text OR numeric id as string).
 */
async function dbUpdateStatus({ anyId, status }) {
  if (!pool) throw new Error("DB not configured");

  const q = `
    UPDATE print_jobs
    SET status = $1,
        updated_at = NOW()
    WHERE job_id = $2
       OR id_text = $2
       OR id::text = $2
    RETURNING
      COALESCE(job_id, id_text, id::text) AS id,
      id AS numeric_id,
      job_id,
      id_text,
      printer_id,
      status,
      source,
      from_phone,
      file_name,
      mime_type,
      file_url,
      created_at,
      updated_at,
      meta;
  `;

  const r = await pool.query(q, [status, anyId]);
  return r.rows[0] || null;
}

// =====================================
// ============ ROUTES ==================
// =====================================

// Root
app.get("/", (req, res) => {
  res.json({ ok: true, service: "mstaf-core", time: nowIso() });
});

// Health
app.get("/health", async (req, res) => {
  const out = {
    ok: true,
    service: "mstaf-core",
    time: nowIso(),
    host: os.hostname(),
    pid: process.pid,
    dbConfigured: !!pool,
    BUILD_MARK: "JOB_ID_SAFE_INSERT_V1",
  };

  if (pool) {
    try {
      const r = await pool.query("SELECT 1 AS ok;");
      out.dbOk = r.rows?.[0]?.ok === 1;
    } catch (e) {
      out.dbOk = false;
      out.dbError = e.message;
    }
  }

  res.json(out);
});

// Debug instance
app.get("/debug/instance", (req, res) => {
  res.json({
    pid: process.pid,
    host: os.hostname(),
    time: nowIso(),
    BUILD_MARK: "JOB_ID_SAFE_INSERT_V1",
  });
});

// Debug DB columns
app.get("/debug/db/columns", async (req, res) => {
  if (!requireDb(req, res)) return;

  try {
    const q = `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'print_jobs'
      ORDER BY ordinal_position;
    `;
    const r = await pool.query(q);
    res.json({ ok: true, table: "print_jobs", columns: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Debug DB migrate
app.post("/debug/db/migrate", async (req, res) => {
  if (!requireDb(req, res)) return;

  try {
    await initDbIfPossible();
    res.json({ ok: true, migrated: true, time: nowIso() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Upload endpoint
// POST /api/upload (multipart/form-data)
// fields: printerId, from (or from_phone), file=@...
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || req.body.printer_id || "").trim();
    const fromPhone = (req.body.from || req.body.from_phone || "").trim();

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded. Use form field name: file" });
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured (DATABASE_URL missing)" });

    const jobId = makeJobId();
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    const job = await dbInsertJob({
      jobId,
      printerId,
      fromPhone,
      fileUrl,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      source: "upload",
      meta: {
        stored_filename: req.file.filename,
        size: req.file.size,
      },
    });

    res.json({ ok: true, job });
  } catch (e) {
    console.error("[UPLOAD] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get jobs for a printer
// GET /jobs?printerId=PP-USA-001&limit=10
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || req.query.printer_id || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "10", 10) || 10, 50);

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured" });

    const jobs = await dbGetNextJobs({ printerId, limit });
    res.json({ ok: true, printerId, count: jobs.length, jobs });
  } catch (e) {
    console.error("[JOBS] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Update job status
// PATCH /jobs/:id  body: { status: "printing" | "done" | "failed" | ... }
app.patch("/jobs/:id", async (req, res) => {
  try {
    const anyId = (req.params.id || "").trim();
    const status = (req.body.status || "").trim();

    if (!anyId) return res.status(400).json({ ok: false, error: "Missing id" });
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured" });

    const updated = await dbUpdateStatus({ anyId, status });
    if (!updated) return res.status(404).json({ ok: false, error: "Job not found" });

    res.json({ ok: true, job: updated });
  } catch (e) {
    console.error("[PATCH JOB] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// ===== Twilio SMS/MMS Webhook =====
// =====================================
// POST /sms  (Twilio sends x-www-form-urlencoded)
app.post("/sms", async (req, res) => {
  try {
    const MessagingResponse = twilio.twiml.MessagingResponse;
    const twiml = new MessagingResponse();

    const from = req.body.From || "";
    const body = (req.body.Body || "").trim();

    const numMedia = parseInt(req.body.NumMedia || "0", 10) || 0;
    const mediaUrls = [];
    for (let i = 0; i < numMedia; i++) {
      const u = req.body[`MediaUrl${i}`];
      if (u) mediaUrls.push(u);
    }

    let msg = `MSTAF received your message.`;
    if (body) msg += ` You said: "${body}"`;
    if (mediaUrls.length) msg += ` (Media received: ${mediaUrls.length})`;

    twiml.message(msg);
    res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("[TWILIO] error:", e);
    res.status(500).send("Error");
  }
});

// =====================================
// ===== Start Server =====
// =====================================
const PORT = process.env.PORT || 10000;

initDbIfPossible().finally(() => {
  app.listen(PORT, () => {
    console.log(`MSTAF CORE listening on port ${PORT}`);
  });
});

