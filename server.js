/**
 * MSTAF CORE - Print-O-Matic (Render + Persistent Disk)
 * Permanent Fix:
 *  - Save uploads to Render Disk: /mnt/data/uploads
 *  - Serve /uploads/* from disk so downloads never 404 after deploy/restart
 *  - Secure printer polling with PRINTER_KEY
 *
 * Routes:
 *  - GET  /health
 *  - POST /api/upload        (multipart/form-data: file + printerId/copies/paperSize/colorType/phone)
 *  - GET  /jobs?printerId=PP-USA-001&limit=10   (requires x-printer-key)
 *  - POST /jobs/:idText/status                  (requires x-printer-key)
 *  - GET  /uploads/...                          (public file serving from disk)
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

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// =============================
// ENV
// =============================
const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || "https://mstaf-core-1.onrender.com").replace(/\/$/, "");
const PRINTER_KEY = process.env.PRINTER_KEY || ""; // must match worker + Render env
const DATABASE_URL = process.env.DATABASE_URL;

// Disk mount path chosen on Render UI:
const DISK_MOUNT = process.env.DISK_MOUNT_PATH || "/mnt/data";

// Where we persist uploads:
const UPLOAD_ROOT = path.posix.join(DISK_MOUNT, "uploads"); // e.g. /mnt/data/uploads

// Ensure upload root exists
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// =============================
// DB
// =============================
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing in Render Environment.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function safeMigrate() {
  // Create table if missing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT UNIQUE,
      printer_id TEXT,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_path TEXT,
      file_url TEXT,
      copies INTEGER DEFAULT 1,
      paper_size TEXT DEFAULT 'A4',
      color_type TEXT DEFAULT 'BW',
      status TEXT DEFAULT 'queued',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Ensure columns exist (safe)
  const cols = [
    ["id_text", "TEXT"],
    ["printer_id", "TEXT"],
    ["from_phone", "TEXT"],
    ["file_name", "TEXT"],
    ["mime_type", "TEXT"],
    ["file_path", "TEXT"],
    ["file_url", "TEXT"],
    ["copies", "INTEGER DEFAULT 1"],
    ["paper_size", "TEXT DEFAULT 'A4'"],
    ["color_type", "TEXT DEFAULT 'BW'"],
    ["status", "TEXT DEFAULT 'queued'"],
    ["created_at", "TIMESTAMPTZ DEFAULT NOW()"],
    ["updated_at", "TIMESTAMPTZ DEFAULT NOW()"],
  ];

  for (const [name, type] of cols) {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name='print_jobs'
          AND column_name='${name}'
        ) THEN
          ALTER TABLE print_jobs ADD COLUMN ${name} ${type};
        END IF;
      END $$;
    `);
  }

  // Helpful index
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status_created
    ON print_jobs (printer_id, status, created_at DESC);
  `);

  console.log("✅ DB migrations OK");
}

safeMigrate().catch((e) => {
  console.error("❌ Migration failed:", e);
  process.exit(1);
});

// =============================
// Printer Auth middleware
// =============================
function requirePrinterKey(req, res, next) {
  if (!PRINTER_KEY) {
    return res.status(500).json({ ok: false, error: "PRINTER_KEY not configured" });
  }
  const key = req.headers["x-printer-key"];
  if (!key || key !== PRINTER_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized printer" });
  }
  next();
}

// =============================
// Upload handling (memory -> disk)
// =============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

function sanitizeFileName(name) {
  // Keep it safe for disk paths
  return (name || "file")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 180);
}

// =============================
// Serve uploads from disk (public)
// Supports:
//   /uploads/<jobId>/<filename>
//   /uploads/<flatFilename>  (legacy)
// =============================
app.use("/uploads", express.static(UPLOAD_ROOT, {
  fallthrough: true,
  maxAge: "1h",
}));

// Extra fallback for legacy paths or if express.static doesn't catch:
app.get("/uploads/*", (req, res) => {
  const rel = req.params[0] || "";
  const fileOnDisk = path.posix.join(UPLOAD_ROOT, rel);
  if (fs.existsSync(fileOnDisk)) return res.sendFile(fileOnDisk);

  return res.status(404).send("Not Found");
});

// =============================
// Routes
// =============================
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({
      ok: true,
      db: r.rows?.[0]?.ok === 1,
      uploadRoot: UPLOAD_ROOT,
      diskMount: DISK_MOUNT,
      baseUrl: BASE_URL,
      printerKeySet: Boolean(PRINTER_KEY),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/upload
 * multipart/form-data:
 *  - file (required)
 *  - printerId (required)
 *  - copies (optional)
 *  - paperSize (optional)
 *  - colorType (optional)
 *  - phone (optional)
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || "").trim();
    const copies = parseInt(req.body.copies || "1", 10) || 1;
    const paperSize = (req.body.paperSize || "A4").trim();
    const colorType = (req.body.colorType || "BW").trim();
    const fromPhone = (req.body.phone || "").trim();

    if (!printerId) return res.status(400).json({ ok: false, error: "printerId is required" });
    if (!req.file) return res.status(400).json({ ok: false, error: "file is required" });

    const idText = `print_${crypto.randomBytes(8).toString("hex")}`;
    const safeName = sanitizeFileName(req.file.originalname);

    // Primary storage path: /mnt/data/uploads/<idText>/<filename>
    const jobDir = path.posix.join(UPLOAD_ROOT, idText);
    fs.mkdirSync(jobDir, { recursive: true });

    const filePath = path.posix.join(jobDir, safeName);
    fs.writeFileSync(filePath, req.file.buffer);

    // Public URL used by worker
    const fileUrl = `${BASE_URL}/uploads/${idText}/${encodeURIComponent(safeName)}`;

    // ALSO write a legacy flat filename (optional but helps older jobs):
    // /mnt/data/uploads/<timestamp>_<filename>
    const legacyName = `${Date.now()}_${safeName}`;
    const legacyPath = path.posix.join(UPLOAD_ROOT, legacyName);
    try {
      fs.writeFileSync(legacyPath, req.file.buffer);
    } catch (_) {}

    await pool.query(
      `
      INSERT INTO print_jobs
        (id_text, printer_id, from_phone, file_name, mime_type, file_path, file_url, copies, paper_size, color_type, status, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued', NOW())
      `,
      [
        idText,
        printerId,
        fromPhone,
        safeName,
        req.file.mimetype || "",
        filePath,
        fileUrl,
        copies,
        paperSize,
        colorType,
      ]
    );

    return res.json({
      ok: true,
      jobId: idText,
      printerId,
      copies,
      paperSize,
      colorType,
      fileUrl,
    });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /jobs?printerId=PP-USA-001&limit=10
 * Requires x-printer-key
 * Returns queued jobs only
 */
app.get("/jobs", requirePrinterKey, async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "10", 10) || 10, 25);

    if (!printerId) return res.status(400).json({ ok: false, error: "printerId is required" });

    const r = await pool.query(
      `
      SELECT id_text, printer_id, from_phone, file_name, mime_type, file_url,
             copies, paper_size, color_type, status, created_at
      FROM print_jobs
      WHERE printer_id = $1
        AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [printerId, limit]
    );

    return res.json({ ok: true, jobs: r.rows });
  } catch (e) {
    console.error("JOBS ERROR:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /jobs/:idText/status
 * body: { status: "printing" | "done" | "print_error" | "download_error" }
 * Requires x-printer-key
 */
app.post("/jobs/:idText/status", requirePrinterKey, async (req, res) => {
  try {
    const idText = (req.params.idText || "").trim();
    const status = (req.body.status || "").trim();

    if (!idText) return res.status(400).json({ ok: false, error: "idText required" });
    if (!status) return res.status(400).json({ ok: false, error: "status required" });

    const r = await pool.query(
      `
      UPDATE print_jobs
      SET status = $2, updated_at = NOW()
      WHERE id_text = $1
      RETURNING id_text, status
      `,
      [idText, status]
    );

    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "job not found" });
    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    console.error("STATUS ERROR:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// =============================
// Start
// =============================
app.listen(PORT, () => {
  console.log("====================================");
  console.log("✅ MSTAF CORE running");
  console.log("PORT:", PORT);
  console.log("BASE_URL:", BASE_URL);
  console.log("DISK_MOUNT:", DISK_MOUNT);
  console.log("UPLOAD_ROOT:", UPLOAD_ROOT);
  console.log("PRINTER_KEY set:", Boolean(PRINTER_KEY));
  console.log("====================================");
});
