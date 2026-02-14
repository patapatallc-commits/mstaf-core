/**
 * MSTAF CORE - server.js (Render-ready, Print-O-Matic stable)
 *
 * ✅ Fixes the “empty file_url queued loop” permanently:
 * - /jobs ONLY returns jobs with:
 *    status IN ('paid','queued')
 *    AND file_url IS NOT NULL
 *    AND file_url <> ''
 *
 * ✅ Upload route inserts DB row ONLY AFTER file is saved and file_url is built.
 *
 * Endpoints:
 * - GET  /health
 * - POST /api/upload              (multipart/form-data, field: file)
 * - GET  /jobs?printerId=PP-USA-001&limit=10
 * - POST /jobs/:id_text/status    (JSON: { status })
 * - GET  /debug/jobs              (admin optional)
 * - Static: /uploads/<filename>
 */

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// Render / proxy-safe
app.set("trust proxy", 1);

// Body parsers
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// =========================
// CONFIG
// =========================
const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL in env.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();

// Base URL (best: set PUBLIC_BASE_URL on Render to your service URL)
function getBaseUrl(req) {
  const envBase = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (envBase) return envBase;
  // fallback: use incoming request host
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}

// =========================
// UPLOADS SETUP
// =========================
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use("/uploads", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeOriginal = (file.originalname || "upload").replace(/[^\w.\-]+/g, "_");
    const ext = path.extname(safeOriginal);
    const base = path.basename(safeOriginal, ext);
    const stamp = Date.now();
    const rnd = crypto.randomBytes(6).toString("hex");
    cb(null, `${base}_${stamp}_${rnd}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// =========================
// DB MIGRATIONS (SAFE)
// =========================
async function ensureSchema() {
  // Minimal columns required for Print-O-Matic
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT UNIQUE,
      printer_id TEXT,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_url TEXT,
      status TEXT DEFAULT 'queued',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Add missing columns safely (for older deployments)
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);

  // Try to enforce uniqueness on id_text (ignore if already exists)
  try {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_id_text_uq ON print_jobs(id_text);`);
  } catch (e) {
    console.warn("⚠️ Could not create unique index (ok):", e.message);
  }

  console.log("✅ DB schema ensured.");
}

ensureSchema().catch((e) => {
  console.error("❌ Schema ensure failed:", e);
  process.exit(1);
});

// =========================
// HELPERS
// =========================
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return next(); // if not set, allow
  const key = (req.query.admin_key || req.headers["x-admin-key"] || "").toString().trim();
  if (key && key === ADMIN_KEY) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized (admin key required)" });
}

function nowSql() {
  return new Date().toISOString();
}

// =========================
// ROUTES
// =========================
app.get("/health", (req, res) => res.json({ ok: true, ts: nowSql() }));

/**
 * Upload -> saves file -> inserts job ONLY AFTER file exists -> returns job_id + file_url
 * multipart/form-data:
 * - file: required
 * - printer_id: optional (defaults PP-USA-001)
 * - from_phone: optional
 * - status: optional (defaults queued)
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printer_id || req.query.printer_id || "PP-USA-001").toString().trim();
    const fromPhone = (req.body.from_phone || "").toString().trim();
    const status = (req.body.status || "queued").toString().trim();

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded. Use form-data field name: file" });
    }

    // ✅ Build file_url ONLY AFTER multer has written the file
    const baseUrl = getBaseUrl(req);
    const fileUrl = `${baseUrl}/uploads/${encodeURIComponent(req.file.filename)}`;

    const jobId = `print_${crypto.randomBytes(8).toString("hex")}`;

    await pool.query(
      `
      INSERT INTO print_jobs (
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
      `,
      [jobId, printerId, fromPhone, req.file.originalname || req.file.filename, req.file.mimetype || "", fileUrl, status]
    );

    return res.json({
      ok: true,
      id_text: jobId,
      printer_id: printerId,
      status,
      file_name: req.file.originalname || req.file.filename,
      mime_type: req.file.mimetype || "",
      file_url: fileUrl,
    });
  } catch (e) {
    console.error("❌ /api/upload error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * ✅ Worker polling route
 * GET /jobs?printerId=PP-USA-001&limit=10
 *
 * IMPORTANT FIX:
 *  - status IN ('paid','queued')
 *  - file_url IS NOT NULL AND file_url <> ''
 */
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || req.query.printer_id || "PP-USA-001").toString().trim();
    const limit = Math.min(parseInt(req.query.limit || "10", 10) || 10, 50);

    const q = `
      SELECT id_text, printer_id, file_url, file_name, mime_type, status, created_at
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('paid','queued')
        AND file_url IS NOT NULL
        AND file_url <> ''
      ORDER BY created_at ASC
      LIMIT $2
    `;

    const r = await pool.query(q, [printerId, limit]);
    return res.json({ ok: true, printer_id: printerId, count: r.rows.length, jobs: r.rows });
  } catch (e) {
    console.error("❌ /jobs error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Update job status
 * POST /jobs/:id_text/status
 * body: { status: "printed" | "error" | ... }
 */
app.post("/jobs/:id_text/status", async (req, res) => {
  try {
    const idText = (req.params.id_text || "").toString().trim();
    const status = (req.body.status || "").toString().trim();
    if (!idText) return res.status(400).json({ ok: false, error: "Missing id_text" });
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    const r = await pool.query(
      `
      UPDATE print_jobs
      SET status = $1, updated_at = NOW()
      WHERE id_text = $2
      RETURNING id_text, status, updated_at
      `,
      [status, idText]
    );

    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "Job not found" });
    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    console.error("❌ status update error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Debug: list latest jobs (admin optional)
 * GET /debug/jobs?admin_key=...
 */
app.get("/debug/jobs", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id_text, printer_id, status, file_name, mime_type, file_url, created_at, updated_at
      FROM print_jobs
      ORDER BY created_at DESC
      LIMIT 50
    `);
    return res.json({ ok: true, count: r.rows.length, jobs: r.rows });
  } catch (e) {
    console.error("❌ /debug/jobs error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Root
app.get("/", (req, res) => {
  res.type("text").send("MSTAF CORE is running. Try /health, /debug/jobs, /jobs, /api/upload");
});

app.listen(PORT, () => {
  console.log(`✅ MSTAF CORE listening on port ${PORT}`);
});

