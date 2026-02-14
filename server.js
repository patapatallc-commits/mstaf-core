/**
 * MSTAF CORE - server.js (Render-ready)
 * ✅ Fixes Shopify "Failed to fetch" (CORS + OPTIONS preflight)
 * ✅ Uploads to Cloudinary (permanent file_url)
 * ✅ Worker-friendly job polling + status update
 * ✅ FIXED: removed duplicate UNIQUE constraint migration that crashed deploy (42P07)
 *
 * ENV REQUIRED:
 * - DATABASE_URL
 * - ADMIN_KEY
 * - CLOUDINARY_CLOUD_NAME
 * - CLOUDINARY_API_KEY
 * - CLOUDINARY_API_SECRET
 *
 * OPTIONAL:
 * - PORT
 * - ALLOWED_ORIGINS (comma-separated)
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;

// --------------------
// App + DB + Cloudinary
// --------------------
const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "",
  api_key: process.env.CLOUDINARY_API_KEY || "",
  api_secret: process.env.CLOUDINARY_API_SECRET || "",
});

const ADMIN_KEY = process.env.ADMIN_KEY || "MSTAF_ADMIN_2026_SECURE_KEY";

// --------------------
// CORS (FIXES Shopify "Failed to fetch")
// --------------------
const defaultOrigins = ["https://patapata.us", "https://www.patapata.us"];

const envOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = envOrigins.length ? envOrigins : defaultOrigins;

app.use(
  cors({
    origin: function (origin, cb) {
      // allow server-to-server calls, curl, Render health checks
      if (!origin) return cb(null, true);

      if (allowedOrigins.includes(origin)) return cb(null, true);

      // Do NOT crash server; just block this request
      return cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-key", "x-printer-key"],
    maxAge: 86400,
  })
);

// Handle preflight for all routes
app.options("*", cors());

// Body parsing
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// --------------------
// Multer (memory upload)
// --------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// --------------------
// DB migrations (safe)
// --------------------
async function ensureSchema() {
  // Create table with id_text UNIQUE baked in (no extra constraint needed)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT UNIQUE,
      printer_id TEXT,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_url TEXT,
      paper_size TEXT,
      copies INTEGER DEFAULT 1,
      color_type TEXT,
      status TEXT DEFAULT 'queued',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Safe adds (do NOT try to add UNIQUE constraint again)
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paper_size TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS copies INTEGER DEFAULT 1;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS color_type TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'queued';`);
  await pool.query(
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`
  );
  await pool.query(
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`
  );

  // ✅ NOTE:
  // We intentionally DO NOT add any constraint here.
  // The old "ADD CONSTRAINT print_jobs_id_text_unique" is what caused 42P07 crash.
}

// --------------------
// Helpers
// --------------------
function requireAdmin(req, res) {
  const key = req.query.admin_key || req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) {
    res.status(403).json({ error: "forbidden" });
    return false;
  }
  return true;
}

// --------------------
// Routes
// --------------------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Debug: list jobs
app.get("/debug/jobs", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, id_text, printer_id, file_name, mime_type, file_url, paper_size, copies, color_type, status, created_at
       FROM print_jobs
       ORDER BY created_at DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: String(e.message || e) });
  }
});

/**
 * Upload endpoint called by Shopify page JS
 * - multipart/form-data with file field: "file"
 * - optional fields: printerId, paperSize, copies, colorType
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "no_file" });

    const printerId = (req.body.printerId || "PP-USA-001").trim();
    const paperSize = (req.body.paperSize || "A4").trim();
    const copies = Math.max(1, parseInt(req.body.copies || "1", 10) || 1);
    const colorType = (req.body.colorType || "Color").trim();

    // Validate Cloudinary env early (clear error)
    if (
      !process.env.CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET
    ) {
      return res.status(500).json({
        error: "cloudinary_env_missing",
        detail:
          "Missing CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET in Render Environment.",
      });
    }

    // Cloudinary upload (permanent URL)
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "auto",
          folder: "printomatic",
          overwrite: false,
        },
        (err, result) => {
          if (err) return reject(err);
          resolve(result);
        }
      );
      stream.end(file.buffer);
    });

    const fileUrl = uploadResult.secure_url;
    const jobId = `print_${crypto.randomBytes(8).toString("hex")}`;

    await pool.query(
      `
      INSERT INTO print_jobs (
        id_text,
        printer_id,
        file_name,
        mime_type,
        file_url,
        paper_size,
        copies,
        color_type,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued')
      `,
      [jobId, printerId, file.originalname, file.mimetype, fileUrl, paperSize, copies, colorType]
    );

    res.json({
      ok: true,
      job_id: jobId,
      file_url: fileUrl,
      printer_id: printerId,
      paper_size: paperSize,
      copies,
      color_type: colorType,
    });
  } catch (e) {
    res.status(500).json({ error: "upload_failed", detail: String(e.message || e) });
  }
});

// Worker polling: get queued jobs for a printer
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").trim();
    if (!printerId) return res.status(400).json({ error: "missing_printerId" });

    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit || "1", 10) || 1));

    const { rows } = await pool.query(
      `
      SELECT id_text AS job_id, printer_id, file_name, mime_type, file_url, paper_size, copies, color_type, status, created_at
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued','paid')
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [printerId, limit]
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: String(e.message || e) });
  }
});

// Worker updates status
app.post("/jobs/:jobId/status", async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const status = (req.body.status || "").trim();

    const allowed = new Set([
      "queued",
      "paid",
      "printing",
      "printed",
      "shipped",
      "done",
      "error",
      "failed",
    ]);
    if (!allowed.has(status)) return res.status(400).json({ error: "invalid_status" });

    await pool.query(
      `
      UPDATE print_jobs
      SET status = $1, updated_at = NOW()
      WHERE id_text = $2
      `,
      [status, jobId]
    );

    res.json({ ok: true, job_id: jobId, status });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: String(e.message || e) });
  }
});

// --------------------
// Start
// --------------------
const PORT = process.env.PORT || 10000;

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MSTAF CORE running on port ${PORT}`);
      console.log("Allowed origins:", allowedOrigins);
    });
  })
  .catch((e) => {
    console.error("Schema init failed:", e);
    process.exit(1);
  });

