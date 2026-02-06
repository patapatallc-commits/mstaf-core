// redeploy bump

/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * - Twilio SMS/MMS inbound webhook: POST /sms
 * - Upload endpoint: POST /api/upload (multipart/form-data)
 * - Printer polling: GET /jobs?printerId=PP-USA-001
 * - Count endpoint: GET /jobs/count?printerId=PP-USA-001
 * - Update status: POST /jobs/:id/status
 * - Uses Postgres if DATABASE_URL is set, otherwise in-memory fallback
 */

if (process.env.NODE_ENV !== "production") {
  try { require("dotenv").config(); } catch (e) {}
}

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const os = require("os");

// Optional Postgres (pg)
let pg = null;
try {
  pg = require("pg");
} catch (e) {2
  pg = null;
}

const app = express();

// IMPORTANT for Twilio (form-encoded) + JSON
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 10000;
const DEFAULT_PRINTER_ID = process.env.DEFAULT_PRINTER_ID || "PP-USA-001";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
// ------------------------------------------------

// -------------------- DEBUG ---------------------
app.get("/health", (req, res) => res.status(200).send("OK"));

app.get("/debug/instance", (req, res) => {
  res.json({
    pid: process.pid,
    host: os.hostname(),
    time: new Date().toISOString(),
    node_env: process.env.NODE_ENV || "unknown",
    using_db: Boolean(process.env.DATABASE_URL && pg),
    public_base_url: PUBLIC_BASE_URL || null
  });
});
// ------------------------------------------------

// -------------------- STORAGE -------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB
  }
});

// In-memory fallback queue (if DB not available)
const memoryJobs = []; // {id, printer_id, from_phone, file_name, mime_type, file_base64, status, created_at, updated_at}

// -------------------- DB LAYER ------------------
let pool = null;

function canUseDb() {
  return Boolean(process.env.DATABASE_URL && pg);
}

async function initDbIfPossible() {
  if (!canUseDb()) return false;

  const { Pool } = pg;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
  });

  // Create minimal base table if it doesn't exist (works for old + new DBs)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      printer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ✅ FORCE SAFE MIGRATIONS (fixes your "file_name does not exist" error)
  const migrations = [
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_base64 TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;`
  ];

  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (e) {
      console.warn("[DB MIGRATION WARNING]", e?.message || e);
    }
  }

  // Ensure updated_at is populated for older rows
  await pool.query(`
    UPDATE print_jobs
    SET updated_at = COALESCE(updated_at, created_at, NOW())
    WHERE updated_at IS NULL;
  `);

  // Index (safe)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status_created
    ON print_jobs (printer_id, status, created_at);
  `);

  console.log("[DB] Auto-migration complete");
  return true;
}





  return true;
}

function newId(prefix = "job") {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

async function dbInsertJob(job) {
  const sql = `
    INSERT INTO print_jobs (id, printer_id, from_phone, file_name, mime_type, file_base64, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `;
  await pool.query(sql, [
    job.id,
    job.printer_id,
    job.from_phone || null,
    job.file_name || null,
    job.mime_type || null,
    job.file_base64 || null,
    job.status || "QUEUED"
  ]);
}

async function dbGetNextJobs(printerId, limit = 5) {
  const sql = `
    SELECT id, printer_id, from_phone, file_name, mime_type, file_base64, status, created_at, updated_at
    FROM print_jobs
    WHERE printer_id = $1 AND status = 'QUEUED'
    ORDER BY created_at ASC
    LIMIT $2
  `;
  const { rows } = await pool.query(sql, [printerId, limit]);
  return rows;
}

async function dbCountQueued(printerId) {
  const sql = `SELECT COUNT(*)::int AS count FROM print_jobs WHERE printer_id = $1 AND status = 'QUEUED'`;
  const { rows } = await pool.query(sql, [printerId]);
  return rows?.[0]?.count ?? 0;
}

async function dbUpdateStatus(id, status) {
  const sql = `
    UPDATE print_jobs
    SET status = $1, updated_at = NOW()
    WHERE id = $2
    RETURNING id, printer_id, status, updated_at
  `;
  const { rows } = await pool.query(sql, [status, id]);
  return rows?.[0] || null;
}

// -------------------- FALLBACK (MEMORY) ---------
function memInsertJob(job) {
  memoryJobs.push({
    ...job,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
}

function memGetNextJobs(printerId, limit = 5) {
  return memoryJobs
    .filter(j => j.printer_id === printerId && j.status === "QUEUED")
    .slice(0, limit);
}

function memCountQueued(printerId) {
  return memoryJobs.filter(j => j.printer_id === printerId && j.status === "QUEUED").length;
}

function memUpdateStatus(id, status) {
  const j = memoryJobs.find(x => x.id === id);
  if (!j) return null;
  j.status = status;
  j.updated_at = new Date().toISOString();
  return { id: j.id, printer_id: j.printer_id, status: j.status, updated_at: j.updated_at };
}

// Unified wrappers (DB if available, else memory)
async function insertJob(job) {
  if (canUseDb() && pool) return dbInsertJob(job);
  return memInsertJob(job);
}

async function getNextJobs(printerId, limit = 5) {
  if (canUseDb() && pool) return dbGetNextJobs(printerId, limit);
  return memGetNextJobs(printerId, limit);
}

async function countQueued(printerId) {
  if (canUseDb() && pool) return dbCountQueued(printerId);
  return memCountQueued(printerId);
}

async function updateStatus(id, status) {
  if (canUseDb() && pool) return dbUpdateStatus(id, status);
  return memUpdateStatus(id, status);
}

// -------------------- ROUTES --------------------

// 1) Upload endpoint (PowerShell curl)
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || req.query.printerId || DEFAULT_PRINTER_ID).toString().trim();
    const fromPhone = (req.body.from || req.query.from || "").toString().trim();

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded. Use form field name: file" });
    }

    const fileName = req.file.originalname || `upload_${Date.now()}`;
    const mimeType = req.file.mimetype || "application/octet-stream";
    const base64 = req.file.buffer.toString("base64");

    const job = {
      id: newId("print"),
      printer_id: printerId,
      from_phone: fromPhone,
      file_name: fileName,
      mime_type: mimeType,
      file_base64: base64,
      status: "QUEUED"
    };

    await insertJob(job);

    return res.json({
      ok: true,
      message: "Queued print job",
      job: {
        id: job.id,
        printerId: job.printer_id,
        fileName: job.file_name,
        mimeType: job.mime_type,
        status: job.status
      }
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({ ok: false, error: "Upload failed", detail: String(err?.message || err) });
  }
});

// 2) Printer polls jobs (returns base64 so printer can print)
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || DEFAULT_PRINTER_ID).toString().trim();
    const limit = Math.min(parseInt(req.query.limit || "5", 10) || 5, 20);

    const jobs = await getNextJobs(printerId, limit);

    return res.json({
      ok: true,
      printerId,
      count: jobs.length,
      jobs: jobs.map(j => ({
        id: j.id,
        printerId: j.printer_id,
        from: j.from_phone || null,
        fileName: j.file_name || null,
        mimeType: j.mime_type || null,
        fileBase64: j.file_base64 || null,
        status: j.status,
        createdAt: j.created_at,
        updatedAt: j.updated_at
      }))
    });
  } catch (err) {
    console.error("JOBS GET ERROR:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch jobs", detail: String(err?.message || err) });
  }
});

// 3) Count queued jobs (fast)
app.get("/jobs/count", async (req, res) => {
  try {
    const printerId = (req.query.printerId || DEFAULT_PRINTER_ID).toString().trim();
    const count = await countQueued(printerId);
    return res.json({ ok: true, printerId, queued: count });
  } catch (err) {
    console.error("COUNT ERROR:", err);
    return res.status(500).json({ ok: false, error: "Failed to count jobs", detail: String(err?.message || err) });
  }
});

// 4) Update job status (printer calls this after it starts/finishes)
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const id = req.params.id;
    const status = (req.body.status || req.query.status || "").toString().trim().toUpperCase();

    const allowed = new Set(["QUEUED", "PRINTING", "DONE", "FAILED"]);
    if (!allowed.has(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status", allowed: Array.from(allowed) });
    }

    const updated = await updateStatus(id, status);
    if (!updated) return res.status(404).json({ ok: false, error: "Job not found" });

    return res.json({ ok: true, job: updated });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    return res.status(500).json({ ok: false, error: "Failed to update status", detail: String(err?.message || err) });
  }
});

// 5) Twilio inbound SMS/MMS webhook
app.post("/sms", async (req, res) => {
  try {
    const from = (req.body.From || "").toString();
    const body = (req.body.Body || "").toString().trim();
    const numMedia = parseInt(req.body.NumMedia || "0", 10) || 0;

    const msg =
      numMedia > 0
        ? `MSTAF received your message + ${numMedia} attachment(s). Upload processing can be connected next.`
        : `MSTAF received: "${body}"`;

    res.set("Content-Type", "text/xml");
    return res.send(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(msg)}</Message>
</Response>`
    );
  } catch (err) {
    console.error("TWILIO /sms ERROR:", err);
    res.set("Content-Type", "text/xml");
    return res.status(200).send(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Sorry — MSTAF had an error processing that message.</Message>
</Response>`
    );
  }
});

// 6) Root
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "mstaf-core",
    endpoints: ["/health", "/debug/instance", "POST /api/upload", "GET /jobs", "GET /jobs/count", "POST /jobs/:id/status", "POST /sms"]
  });
});

// -------------------- HELPERS -------------------
function escapeXml(unsafe) {
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// -------------------- STARTUP -------------------
(async () => {
  try {
    const dbOk = await initDbIfPossible();
    console.log(`[BOOT] DB enabled: ${dbOk ? "YES" : "NO (using memory queue)"}`);
  } catch (e) {
    console.error("[BOOT] DB init failed, using memory queue:", e);
    pool = null;
  }

  app.listen(PORT, () => {
    console.log(`MSTAF Core listening on port ${PORT}`);
  });
})();

