/**
 * MSTAF CORE - Print-O-Matic server.js (Render-ready)
 * Permanent Fix:
 * - Web uploads create jobs as 'queued'
 * - Worker polling returns jobs in ('queued','paid')
 * - Correct /uploads serving and worker download URLs
 * - POST /jobs/:id_text/status endpoint
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// =========================
// CONFIG
// =========================
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").trim(); // optional
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

// If you want to protect printer polling later, set PRINTER_KEY + require header x-printer-key
const PRINTER_KEY = process.env.PRINTER_KEY || "";

// =========================
// MIDDLEWARE
// =========================
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-printer-key"],
  })
);

// Ensure uploads folder exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Serve uploads publicly for worker downloads
app.use("/uploads", express.static(UPLOAD_DIR));

// =========================
// MULTER (disk storage)
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = (file.originalname || "file").replace(/[^\w.\-]+/g, "_");
    const stamp = Date.now();
    cb(null, `${stamp}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// =========================
// DB MIGRATIONS (safe)
// =========================
async function runMigrations() {
  // Create table if missing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT,
      printer_id TEXT,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_url TEXT,
      copies INTEGER DEFAULT 1,
      paper_size TEXT DEFAULT 'A4',
      color_type TEXT DEFAULT 'BW',
      status TEXT DEFAULT 'queued',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add missing columns safely
  const addCol = async (colSql) => {
    try {
      await pool.query(colSql);
    } catch (e) {
      // ignore "already exists"
    }
  };

  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`);
  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`);
  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`);
  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`);
  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`);
  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`);
  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS copies INTEGER DEFAULT 1;`);
  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paper_size TEXT DEFAULT 'A4';`);
  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS color_type TEXT DEFAULT 'BW';`);
  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'queued';`);
  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
  await addCol(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`);

  // Helpful index
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status_created
    ON print_jobs (printer_id, status, created_at DESC);
  `);

  // Ensure id_text not null for new jobs (we generate)
}

// =========================
// HELPERS
// =========================
function makeJobId() {
  return `print_${Math.floor(Date.now() / 1000)}${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeColorType(v) {
  const s = String(v || "").toLowerCase();
  if (s.includes("color")) return "COLOR";
  return "BW";
}

function normalizePaperSize(v) {
  const s = String(v || "").toUpperCase();
  if (s.includes("LETTER")) return "LETTER";
  return "A4";
}

function normalizeCopies(v) {
  const n = parseInt(v, 10);
  if (Number.isFinite(n) && n > 0 && n < 100) return n;
  return 1;
}

function buildPublicUrl(req, relativePath) {
  // If you set PUBLIC_BASE_URL=https://mstaf-core-1.onrender.com it will use that.
  const base =
    BASE_URL ||
    `${req.protocol}://${req.get("host")}`; // Render host
  return `${base}${relativePath}`;
}

function requirePrinterKey(req, res) {
  if (!PRINTER_KEY) return true; // not enforced
  const k = req.headers["x-printer-key"] || "";
  if (k !== PRINTER_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized printer" });
    return false;
  }
  return true;
}

// =========================
// ROUTES
// =========================
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "mstaf-core", time: new Date().toISOString() });
});

/**
 * Upload endpoint for Shopify / web portal
 * POST /api/upload (multipart/form-data)
 * fields: file, phone, printerId, copies, paperSize, colorType
 *
 * Permanent fix: creates job with status = 'queued'
 * Worker will fetch it because /jobs returns ('queued','paid')
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || "PP-USA-001").trim();
    const phone = (req.body.phone || "").trim();
    const copies = normalizeCopies(req.body.copies);
    const paperSize = normalizePaperSize(req.body.paperSize);
    const colorType = normalizeColorType(req.body.colorType);

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const jobId = makeJobId();

    // Relative file_url used by worker: /uploads/<filename>
    const relativeFileUrl = `/uploads/${req.file.filename}`;
    const publicFileUrl = buildPublicUrl(req, relativeFileUrl);

    // ✅ Permanent fix: status = queued (printable)
    await pool.query(
      `
      INSERT INTO print_jobs (
        id_text, printer_id, from_phone,
        file_name, mime_type, file_url,
        copies, paper_size, color_type,
        status, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
      `,
      [
        jobId,
        printerId,
        phone,
        req.file.originalname,
        req.file.mimetype,
        relativeFileUrl,
        copies,
        paperSize,
        colorType,
        "queued",
      ]
    );

    // If browser form POST wants redirect, allow it:
    const redirect = (req.body.redirect || "").trim();
    if (redirect) {
      const url = new URL(redirect);
      url.searchParams.set("ok", "1");
      url.searchParams.set("jobId", jobId);
      return res.redirect(url.toString());
    }

    return res.json({
      ok: true,
      jobId,
      printerId,
      copies,
      paperSize,
      colorType,
      file_url: publicFileUrl,
      file_path: relativeFileUrl,
      status: "queued",
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * Worker polling
 * GET /jobs?printerId=PP-USA-001
 * Returns jobs that are printable:
 * ✅ queued OR paid
 */
app.get("/jobs", async (req, res) => {
  try {
    if (!requirePrinterKey(req, res)) return;

    const printerId = (req.query.printerId || "").trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "printerId required" });

    const limit = Math.min(parseInt(req.query.limit || "10", 10) || 10, 50);

    const { rows } = await pool.query(
      `
      SELECT id_text, printer_id, from_phone, file_name, mime_type, file_url,
             copies, paper_size, color_type, status, created_at
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued','paid')
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [printerId, limit]
    );

    // Return file_url as relative; worker will build BASE_URL + file_url
    return res.json(rows);
  } catch (err) {
    console.error("JOBS ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/**
 * Worker updates status
 * POST /jobs/:id_text/status
 * body: { status: "printed" | "error" | ... }
 */
app.post("/jobs/:id_text/status", async (req, res) => {
  try {
    if (!requirePrinterKey(req, res)) return;

    const idText = (req.params.id_text || "").trim();
    const status = (req.body.status || "").trim();

    if (!idText) return res.status(400).json({ ok: false, error: "id_text required" });
    if (!status) return res.status(400).json({ ok: false, error: "status required" });

    const { rowCount } = await pool.query(
      `
      UPDATE print_jobs
      SET status = $1, updated_at = NOW()
      WHERE id_text = $2
      `,
      [status, idText]
    );

    if (!rowCount) return res.status(404).json({ ok: false, error: "Job not found" });

    return res.json({ ok: true, id_text: idText, status });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// =========================
// STARTUP
// =========================
(async () => {
  try {
    await runMigrations();
    console.log("✅ DB migrations ok");

    app.listen(PORT, () => {
      console.log(`✅ MSTAF CORE running on port ${PORT}`);
      console.log(`✅ Uploads served at /uploads`);
    });
  } catch (e) {
    console.error("❌ Startup error:", e);
    process.exit(1);
  }
})();

