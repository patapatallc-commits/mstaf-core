/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * - Uses Render Disk for uploads: /mnt/data/uploads
 * - Serves uploads publicly: GET /uploads/<filename>
 * - Upload endpoint: POST /api/upload (multipart/form-data)
 * - Worker polling: GET /jobs?printerId=PP-USA-001
 * - Worker status update: POST /jobs/:id_text/status
 * - Health: GET /health
 */

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// --------------------
// CONFIG
// --------------------
const PORT = process.env.PORT || 3000;

// IMPORTANT: For Render Disk, you mounted /mnt/data
const DISK_MOUNT = process.env.DISK_MOUNT || "/mnt/data";
const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(DISK_MOUNT, "uploads"); // /mnt/data/uploads

// Public base URL (Render)
const BASE_URL = (process.env.BASE_URL || "https://mstaf-core-1.onrender.com").replace(/\/$/, "");

// Worker security (optional but recommended)
const PRINTER_KEY = process.env.PRINTER_KEY || ""; // set in Render env
const PRINTER_ID_DEFAULT = process.env.PRINTER_ID || "PP-USA-001";

// Make sure upload folder exists
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// --------------------
// DB
// --------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

// --------------------
// MIDDLEWARE
// --------------------
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS (optional; safe for Shopify page)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-printer-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Serve uploaded files publicly
app.use("/uploads", express.static(UPLOAD_ROOT));

// --------------------
// MULTER (store directly on disk)
// --------------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_ROOT);
  },
  filename: function (req, file, cb) {
    // keep extension
    const ext = path.extname(file.originalname || "");
    const safeExt = ext.length <= 10 ? ext : "";
    const name = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}${safeExt}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB (adjust as needed)
});

// --------------------
// DB MIGRATIONS (SAFE)
// --------------------
async function ensureSchema() {
  // create table if missing
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
      meta JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // add missing columns safely
  const addCol = async (col, type) => {
    await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS ${col} ${type};`);
  };

  await addCol("id_text", "TEXT");
  await addCol("printer_id", "TEXT");
  await addCol("from_phone", "TEXT");
  await addCol("file_name", "TEXT");
  await addCol("mime_type", "TEXT");
  await addCol("file_url", "TEXT");
  await addCol("status", "TEXT DEFAULT 'queued'");
  await addCol("meta", "JSONB DEFAULT '{}'::jsonb");
  await addCol("created_at", "TIMESTAMPTZ DEFAULT NOW()");
  await addCol("updated_at", "TIMESTAMPTZ DEFAULT NOW()");

  // index for worker polling
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status ON print_jobs(printer_id, status);`);
}

ensureSchema()
  .then(() => console.log("✅ DB schema ready"))
  .catch((e) => console.error("❌ DB schema error", e));

// --------------------
// HELPERS
// --------------------
function requirePrinterKey(req, res, next) {
  if (!PRINTER_KEY) return next(); // if you didn't set one, skip enforcement
  const key = req.headers["x-printer-key"];
  if (!key || key !== PRINTER_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized_printer" });
  }
  next();
}

function nowIso() {
  return new Date().toISOString();
}

// --------------------
// ROUTES
// --------------------

// Health
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      db: true,
      diskMount: DISK_MOUNT,
      uploadRoot: UPLOAD_ROOT,
      baseUrl: BASE_URL,
      printerKeySet: !!PRINTER_KEY,
      time: nowIso(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

// ✅ Shopify / Web upload endpoint
// Expects multipart/form-data with field name: "file"
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    // printerId can be passed by Shopify page; fallback to default
    const printerId = (req.body.printerId || PRINTER_ID_DEFAULT || "").trim();

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "no_file_uploaded" });
    }

    const filename = req.file.filename; // saved name
    const fileUrl = `${BASE_URL}/uploads/${encodeURIComponent(filename)}`;

    const jobId = `print_${crypto.randomBytes(8).toString("hex")}`;

    // IMPORTANT: file_url is always inserted
    await pool.query(
      `
      INSERT INTO print_jobs (
        id_text,
        printer_id,
        file_name,
        mime_type,
        file_url,
        status,
        meta,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      `,
      [
        jobId,
        printerId,
        req.file.originalname || filename,
        req.file.mimetype || "application/octet-stream",
        fileUrl,
        "queued",
        JSON.stringify({
          source: "web_upload",
          storedName: filename,
          size: req.file.size,
        }),
      ]
    );

    return res.json({
      ok: true,
      id_text: jobId,
      printer_id: printerId,
      file_url: fileUrl,
      stored_as: filename,
      status: "queued",
    });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Worker polling: returns queued jobs only
app.get("/jobs", requirePrinterKey, async (req, res) => {
  try {
    const printerId = (req.query.printerId || PRINTER_ID_DEFAULT || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "5", 10), 20);

    const { rows } = await pool.query(
      `
      SELECT id_text, printer_id, file_name, mime_type, file_url, status, meta, created_at
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued')
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [printerId, limit]
    );

    res.json({ ok: true, printerId, jobs: rows });
  } catch (e) {
    console.error("JOBS ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Worker: mark status (printing/printed/download_error/etc.)
app.post("/jobs/:id_text/status", requirePrinterKey, async (req, res) => {
  try {
    const idText = req.params.id_text;
    const status = (req.body.status || "").trim();
    const metaPatch = req.body.meta || {};

    if (!idText) return res.status(400).json({ ok: false, error: "missing_id_text" });
    if (!status) return res.status(400).json({ ok: false, error: "missing_status" });

    const { rowCount } = await pool.query(
      `
      UPDATE print_jobs
      SET status = $2,
          meta = COALESCE(meta, '{}'::jsonb) || $3::jsonb,
          updated_at = NOW()
      WHERE id_text = $1
      `,
      [idText, status, JSON.stringify(metaPatch)]
    );

    if (!rowCount) return res.status(404).json({ ok: false, error: "job_not_found" });
    res.json({ ok: true, id_text: idText, status });
  } catch (e) {
    console.error("STATUS UPDATE ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Simple debug list (optional)
app.get("/debug/jobs", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id_text, printer_id, status, file_url, created_at FROM print_jobs ORDER BY created_at DESC LIMIT 20`
  );
  res.json({ ok: true, rows });
});

// --------------------
app.listen(PORT, () => {
  console.log(`✅ MSTAF CORE running on port ${PORT}`);
  console.log(`✅ Upload root: ${UPLOAD_ROOT}`);
  console.log(`✅ Public uploads: ${BASE_URL}/uploads/<file>`);
});
