/**
 * MSTAF CORE - server.js (Twilio SMS/MMS first) + Print-O-Matic
 * - Works on Render/Heroku-style host
 * - Correctly parses Twilio x-www-form-urlencoded webhooks
 * - Provides health + debug routes
 * - Handles upload -> print_jobs queue
 * - SAFE DB migration: adds id_text TEXT and uses it for new jobs
 */

require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const app = express();

// ===== Middleware =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Uploads folder + public access =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Public access: /uploads/<filename>
app.use("/uploads", express.static(uploadsDir));

// ===== Database (PostgreSQL) =====
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
const DB_SSL = (process.env.DB_SSL || "true").toLowerCase() !== "false"; // default true

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DB_SSL ? { rejectUnauthorized: false } : false,
    })
  : null;

// ===== Helpers =====
function makePrintId() {
  // print_<random>
  return `print_${crypto.randomBytes(10).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
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

// ===== Multer for file uploads =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    // keep original extension, unique name
    const ext = path.extname(file.originalname || "");
    const base = crypto.randomBytes(8).toString("hex");
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

// =====================================
// ===== DB INIT + MIGRATIONS (SAFE) =====
// =====================================
async function initDbIfPossible() {
  if (!pool) {
    console.log("[DB] DATABASE_URL missing. Skipping DB init.");
    return;
  }

  // Core table (id remains INT if it already exists in your DB)
  // IMPORTANT: We do NOT drop or alter id type here (safe).
  const migrations = [
    `CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      printer_id TEXT NOT NULL,
      "from" TEXT,
      file_url TEXT,
      filename TEXT,
      mime_type TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,

    // ✅ SAFE FIX: add id_text TEXT for string ids like print_xxx
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`,

    // Extra columns that are useful (safe adds)
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS meta JSONB;`,

    // Helpful indexes (safe)
    `CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status_created
      ON print_jobs (printer_id, status, created_at);`,

    `CREATE INDEX IF NOT EXISTS idx_print_jobs_id_text
      ON print_jobs (id_text);`,
  ];

  try {
    console.log("[DB] Running migrations...");
    for (const sql of migrations) {
      await pool.query(sql);
    }

    // ✅ Backfill id_text from numeric id (safe)
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
// ===== DB FUNCTIONS (use id_text) =====
// =====================================

async function dbInsertJob({ id, printerId, from, fileUrl, filename, mimeType, meta }) {
  if (!pool) throw new Error("DB not configured");

  const q = `
    INSERT INTO print_jobs
      (id_text, printer_id, "from", file_url, filename, mime_type, status, created_at, updated_at, meta)
    VALUES
      ($1, $2, $3, $4, $5, $6, 'queued', NOW(), NOW(), $7)
    RETURNING
      id_text AS id, printer_id, "from", file_url, filename, mime_type, status, created_at, updated_at, meta;
  `;

  const vals = [id, printerId, from || null, fileUrl || null, filename || null, mimeType || null, meta || null];
  const r = await pool.query(q, vals);
  return r.rows[0];
}

async function dbGetNextJobs({ printerId, limit = 10 }) {
  if (!pool) throw new Error("DB not configured");

  const q = `
    SELECT
      id_text AS id,
      printer_id,
      "from",
      file_url,
      filename,
      mime_type,
      status,
      created_at,
      updated_at,
      meta
    FROM print_jobs
    WHERE printer_id = $1
      AND status IN ('queued','retry')
    ORDER BY created_at ASC
    LIMIT $2;
  `;
  const r = await pool.query(q, [printerId, limit]);
  return r.rows;
}

async function dbUpdateStatus({ id, status }) {
  if (!pool) throw new Error("DB not configured");

  const q = `
    UPDATE print_jobs
    SET status = $1,
        updated_at = NOW()
    WHERE id_text = $2
    RETURNING
      id_text AS id, printer_id, "from", file_url, filename, mime_type, status, created_at, updated_at, meta;
  `;
  const r = await pool.query(q, [status, id]);
  return r.rows[0] || null;
}

// =====================================
// ===== Routes =====
// =====================================

// Health
app.get("/health", async (req, res) => {
  const out = {
    ok: true,
    service: "mstaf-core",
    time: nowIso(),
    host: os.hostname(),
    pid: process.pid,
    dbConfigured: !!pool,
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
  });
});

// Debug DB columns (shows current columns)
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

// Debug DB migrate (runs initDbIfPossible on demand)
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
// POST /api/upload  (multipart/form-data)
// fields: printerId, from, file=@...
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || "").trim();
    const from = (req.body.from || "").trim();

    if (!printerId) {
      return res.status(400).json({ ok: false, error: "Missing printerId" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }
    if (!pool) {
      return res.status(500).json({ ok: false, error: "DB not configured (DATABASE_URL missing)" });
    }

    const id = makePrintId();
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    const job = await dbInsertJob({
      id,
      printerId,
      from,
      fileUrl,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      meta: {
        stored_filename: req.file.filename,
        size: req.file.size,
      },
    });

    return res.json({ ok: true, job });
  } catch (e) {
    console.error("[UPLOAD] error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Get jobs for a printer
// GET /jobs?printerId=PP-USA-001&limit=10
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").trim();
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
    const id = (req.params.id || "").trim();
    const status = (req.body.status || "").trim();

    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured" });

    const updated = await dbUpdateStatus({ id, status });
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

    // MMS media
    const numMedia = parseInt(req.body.NumMedia || "0", 10) || 0;
    const mediaUrls = [];
    for (let i = 0; i < numMedia; i++) {
      const u = req.body[`MediaUrl${i}`];
      if (u) mediaUrls.push(u);
    }

    // Simple response for now (you can plug in MSTAF logic here)
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

// Root
app.get("/", (req, res) => {
  res.json({ ok: true, service: "mstaf-core", time: nowIso() });
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

