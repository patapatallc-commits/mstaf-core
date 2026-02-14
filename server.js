/**
 * MSTAF CORE - server.js (Render-ready, Print-O-Matic Stable)
 * - Health: GET /health
 * - Upload: POST /api/upload (multipart/form-data)
 * - Printer polling:
 *    - GET /jobs?printerId=PP-USA-001   (returns queued/paid jobs)
 *    - GET /jobs/next?printerId=PP-USA-001 (returns single next job)
 * - Status update: POST /jobs/:id_text/status
 *
 * ✅ Includes SAFE auto-migrations on startup:
 * - Ensures print_jobs table exists
 * - Adds missing columns (including service_type) via ALTER TABLE IF NOT EXISTS
 * - Adds sane defaults and backfills
 *
 * ✅ Security:
 * - Worker can authenticate with header: x-printer-key
 * - Browser testing can authenticate with query: ?key=YOUR_PRINTER_KEY
 */

require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// =======================
// CONFIG
// =======================
const PORT = process.env.PORT || 10000;

// Printer security key (set on Render → Environment)
const PRINTER_KEY = (process.env.PRINTER_KEY || "").trim();

// If true: /jobs returns only is_paid=true jobs.
// If false: queued jobs are printable immediately (good for testing)
const ONLY_PRINT_PAID =
  String(process.env.ONLY_PRINT_PAID || "false").toLowerCase() === "true";

// =======================
// DATABASE
// =======================
if (!process.env.DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL env var on Render.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

// =======================
// UPLOADS (local disk)
// =======================
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Serve uploads publicly so worker can download
app.use("/uploads", express.static(UPLOAD_DIR));

// Multer store on disk
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const stamp = Date.now();
    cb(null, `${stamp}_${safe}`);
  },
});
const upload = multer({ storage });

// =======================
// SAFE AUTO-MIGRATIONS
// =======================
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY
    );
  `);

  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS service_type TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`);

  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`);

  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paper_size TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS color_mode TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS pages INTEGER;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS copies INTEGER;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS instructions TEXT;`);

  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS is_paid BOOLEAN;`);

  await pool.query(
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`
  );

  // Defaults + backfills
  await pool.query(`ALTER TABLE print_jobs ALTER COLUMN copies SET DEFAULT 1;`);
  await pool.query(`UPDATE print_jobs SET copies = 1 WHERE copies IS NULL;`);

  await pool.query(`ALTER TABLE print_jobs ALTER COLUMN status SET DEFAULT 'queued';`);
  await pool.query(`UPDATE print_jobs SET status = 'queued' WHERE status IS NULL;`);

  await pool.query(`ALTER TABLE print_jobs ALTER COLUMN is_paid SET DEFAULT FALSE;`);
  await pool.query(`UPDATE print_jobs SET is_paid = FALSE WHERE is_paid IS NULL;`);

  // Backfill id_text for legacy rows, then enforce NOT NULL + unique index
  await pool.query(`
    UPDATE print_jobs
    SET id_text = CONCAT('legacy_', id)
    WHERE id_text IS NULL;
  `);

  await pool.query(`ALTER TABLE print_jobs ALTER COLUMN id_text SET NOT NULL;`);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_id_text_uidx
    ON print_jobs (id_text);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS print_jobs_printer_status_idx
    ON print_jobs (printer_id, status, created_at);
  `);

  // Remove older wrong schema column if present
  await pool.query(`ALTER TABLE print_jobs DROP COLUMN IF EXISTS job_id;`);

  console.log("✅ DB migrations complete: print_jobs ensured (includes service_type)");
}

// =======================
// SECURITY (UPDATED)
// =======================
function requirePrinterKey(req, res, next) {
  // If no key configured, allow
  if (!PRINTER_KEY) return next();

  // Worker header
  const headerKey = (req.headers["x-printer-key"] || "").toString().trim();

  // Browser test query: ?key=...
  const queryKey = (req.query.key || "").toString().trim();

  const providedKey = headerKey || queryKey;

  if (!providedKey || providedKey !== PRINTER_KEY) {
    return res.status(401).json({ ok: false, error: "Invalid printer key" });
  }

  next();
}

// =======================
// HELPERS
// =======================
function absoluteBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function makeJobId() {
  return `print_${crypto.randomBytes(8).toString("hex")}`;
}

function normalizeServiceType(v) {
  const x = String(v || "print").toLowerCase().trim();
  if (["print", "image_edit", "video_edit"].includes(x)) return x;
  return "print";
}

// =======================
// ROUTES
// =======================
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      service: "mstaf-core",
      db: "ok",
      only_print_paid: ONLY_PRINT_PAID,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "DB not reachable" });
  }
});

// Upload: multipart/form-data
// fields supported:
// - file (required)
// - printerId (optional) default PP-USA-001
// - serviceType (optional) print|image_edit|video_edit
// - paperSize, colorMode, pages, copies, instructions (optional)
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const printerId = String(req.body.printerId || "PP-USA-001").trim();
    const serviceType = normalizeServiceType(req.body.serviceType);

    const paperSize = req.body.paperSize ? String(req.body.paperSize) : null;
    const colorMode = req.body.colorMode ? String(req.body.colorMode) : null;

    const pages = req.body.pages ? parseInt(req.body.pages, 10) : null;
    const copies = req.body.copies ? parseInt(req.body.copies, 10) : 1;
    const instructions = req.body.instructions ? String(req.body.instructions) : null;

    const idText = makeJobId();
    const fileUrl = `${absoluteBaseUrl(req)}/uploads/${encodeURIComponent(req.file.filename)}`;

    // Queue immediately unless you force paid-only
    const isPaid = ONLY_PRINT_PAID ? false : true;

    await pool.query(
      `
      INSERT INTO print_jobs (
        id_text,
        printer_id,
        service_type,
        file_name,
        file_url,
        mime_type,
        paper_size,
        color_mode,
        pages,
        copies,
        instructions,
        status,
        is_paid
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12)
      `,
      [
        idText,
        printerId,
        serviceType,
        req.file.originalname,
        fileUrl,
        req.file.mimetype,
        paperSize,
        colorMode,
        Number.isFinite(pages) ? pages : null,
        Number.isFinite(copies) ? copies : 1,
        instructions,
        isPaid,
      ]
    );

    res.json({
      ok: true,
      id_text: idText,
      printer_id: printerId,
      service_type: serviceType,
      file_url: fileUrl,
      is_paid: isPaid,
      status: "queued",
    });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

// Printer polling (list)
app.get("/jobs", requirePrinterKey, async (req, res) => {
  try {
    const printerId = String(req.query.printerId || "").trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const paidClause = ONLY_PRINT_PAID ? `AND is_paid = TRUE` : ``;

    const { rows } = await pool.query(
      `
      SELECT
        id_text,
        printer_id,
        service_type,
        file_name,
        file_url,
        mime_type,
        paper_size,
        color_mode,
        pages,
        copies,
        instructions,
        status,
        is_paid,
        created_at
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued','paid')
        ${paidClause}
      ORDER BY created_at ASC
      LIMIT 25
      `,
      [printerId]
    );

    res.json(rows);
  } catch (e) {
    console.error("JOBS ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Jobs failed" });
  }
});

// Printer polling (single next job)
app.get("/jobs/next", requirePrinterKey, async (req, res) => {
  try {
    const printerId = String(req.query.printerId || "").trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const paidClause = ONLY_PRINT_PAID ? `AND is_paid = TRUE` : ``;

    const { rows } = await pool.query(
      `
      SELECT
        id_text,
        printer_id,
        service_type,
        file_name,
        file_url,
        mime_type,
        paper_size,
        color_mode,
        pages,
        copies,
        instructions,
        status,
        is_paid,
        created_at
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued','paid')
        ${paidClause}
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [printerId]
    );

    if (!rows.length) return res.json({ ok: true, job: null });
    res.json({ ok: true, job: rows[0] });
  } catch (e) {
    console.error("JOBS/NEXT ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Jobs next failed" });
  }
});

// Worker updates job status
// POST /jobs/:id_text/status { status: "printing"|"printed"|"error", notes?: "...", pages?: n }
app.post("/jobs/:id_text/status", requirePrinterKey, async (req, res) => {
  try {
    const idText = String(req.params.id_text || "").trim();
    if (!idText) return res.status(400).json({ ok: false, error: "Missing id_text" });

    const status = String(req.body.status || "").trim().toLowerCase();
    const allowed = new Set(["queued", "paid", "printing", "printed", "completed", "error", "failed"]);
    if (!allowed.has(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }

    const notes = req.body.notes ? String(req.body.notes) : null;
    const pages = req.body.pages ? parseInt(req.body.pages, 10) : null;

    if (Number.isFinite(pages)) {
      await pool.query(
        `
        UPDATE print_jobs
        SET status = $1,
            pages = COALESCE($2, pages)
        WHERE id_text = $3
        `,
        [status, pages, idText]
      );
    } else {
      await pool.query(
        `
        UPDATE print_jobs
        SET status = $1
        WHERE id_text = $2
        `,
        [status, idText]
      );
    }

    if (notes) console.log("JOB NOTE:", idText, notes);

    res.json({ ok: true, id_text: idText, status });
  } catch (e) {
    console.error("STATUS UPDATE ERROR:", e);
    res.status(500).json({ ok: false, error: e.message || "Status update failed" });
  }
});

// =======================
// STARTUP (CRITICAL)
// =======================
ensureTables()
  .then(() => {
    console.log("✅ DB ready");
    app.listen(PORT, () => console.log("✅ Server running on port", PORT));
  })
  .catch((err) => {
    console.error("❌ DB init failed", err);
    process.exit(1);
  });

