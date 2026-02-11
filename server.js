/**
 * MSTAF CORE - Print-O-Matic Server (Render-ready)
 * - Shopify Upload: POST /api/upload (multipart/form-data)
 * - Public files: GET /uploads/<filename>
 * - Printer claim: GET/POST /jobs/next?printerId=PP-USA-001
 * - Update status: POST /jobs/:id/status
 * - List jobs: GET /jobs?printerId=PP-USA-001
 * - Count: GET /jobs/count?printerId=PP-USA-001
 * - Health: GET /health
 *
 * Supports:
 *  - serviceType: print | image_edit | video_edit
 *  - paperSize: A4 | Letter | Legal
 *  - copies: number
 *  - colorMode: bw | color
 *  - editNotes: text
 *
 * IMPORTANT:
 *  - Auto-print worker should only claim status='queued'
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

// --------------------
// CONFIG
// --------------------
const PORT = process.env.PORT || 3000;

const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || "https://mstaf-core-1.onrender.com").replace(/\/$/, "");

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined
});

// --------------------
// MIDDLEWARE
// --------------------
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ CORS FIX for Shopify page fetch()
app.use(
  cors({
    origin: ["https://patapata.us", "https://www.patapata.us"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

// Serve uploads publicly
app.use("/uploads", express.static(UPLOAD_DIR));

// Multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    // safe unique filename
    const ext = path.extname(file.originalname || "");
    const base = path
      .basename(file.originalname || "file", ext)
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 60);

    const stamp = Date.now().toString();
    const rand = crypto.randomBytes(6).toString("hex");
    cb(null, `${stamp}_${rand}_${base}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB
});

// --------------------
// SAFE DB MIGRATIONS
// --------------------
async function ensureSchema() {
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
      status TEXT DEFAULT 'queued',
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add missing columns safely
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS details TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;`);

  // Helpful index
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status_created
                    ON print_jobs (printer_id, status, created_at);`);
}

ensureSchema()
  .then(() => console.log("✅ DB schema ready"))
  .catch((e) => console.error("❌ DB schema error:", e));

// --------------------
// ROUTES
// --------------------
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, time: new Date().toISOString(), db: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, db: false });
  }
});

/**
 * Upload endpoint used by Shopify page
 * POST /api/upload (multipart/form-data)
 * fields:
 *  - printerId (required)
 *  - from (optional)
 *  - serviceType: print | image_edit | video_edit
 *  - paperSize, copies, colorMode, editNotes
 * file field:
 *  - file
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const {
      printerId,
      from,
      serviceType,
      paperSize,
      copies,
      colorMode,
      editNotes
    } = req.body;

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file" });

    const idText = `print_${crypto.randomBytes(8).toString("hex")}`;

    const fileUrl = `${PUBLIC_BASE_URL}/uploads/${req.file.filename}`;

    // Determine service + status
    const svcRaw = (serviceType || "print").toLowerCase();
    const isVideo = (req.file.mimetype || "").startsWith("video/");

    let status = "queued";
    let normalizedSvc = "print";

    if (svcRaw === "image_edit") {
      status = "editing_required";
      normalizedSvc = "image_edit";
    } else if (svcRaw === "video_edit" || isVideo) {
      status = "video_editing_required";
      normalizedSvc = "video_edit";
    }

    // Save options in details JSON string
    const detailsObj = {
      serviceType: normalizedSvc,
      paperSize: paperSize || null,
      copies: copies ? Number(copies) : 1,
      colorMode: colorMode || null,
      editNotes: editNotes || null
    };
    const detailsJson = JSON.stringify(detailsObj);

    await pool.query(
      `
      INSERT INTO print_jobs
        (id_text, printer_id, from_phone, file_name, mime_type, file_url, status, details, created_at, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
      `,
      [
        idText,
        printerId,
        from || null,
        req.file.originalname,
        req.file.mimetype,
        fileUrl,
        status,
        detailsJson
      ]
    );

    res.json({
      ok: true,
      message: "Submitted",
      job: {
        id_text: idText,
        job_id: idText,
        printerId,
        status,
        service_type: normalizedSvc,
        file_url: fileUrl
      }
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Claim next queued job for a printer
 * Supports GET or POST:
 *   /jobs/next?printerId=PP-USA-001
 */
async function handleJobsNext(req, res) {
  try {
    const printerId = req.query.printerId || req.body?.printerId;
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    // Only claim queued jobs (auto-print)
    const result = await pool.query(
      `
      UPDATE print_jobs
      SET status='printing', updated_at=NOW()
      WHERE id = (
        SELECT id
        FROM print_jobs
        WHERE printer_id=$1 AND status='queued'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
      `,
      [printerId]
    );

    if (result.rowCount === 0) return res.json({ ok: true, job: null });

    const job = result.rows[0];

    res.json({
      ok: true,
      job: {
        id_text: job.id_text,
        job_id: job.id_text,
        printer_id: job.printer_id,
        file_url: job.file_url,
        status: job.status,
        details: job.details ? safeParse(job.details) : null
      }
    });
  } catch (err) {
    console.error("JOBS NEXT ERROR:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

app.get("/jobs/next", handleJobsNext);
app.post("/jobs/next", handleJobsNext);

/**
 * Update job status by id_text
 * POST /jobs/:id/status
 * body: { status: "done" | "failed" | ..., details?: "..." }
 */
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const idText = req.params.id;
    const { status, details } = req.body || {};
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    await pool.query(
      `
      UPDATE print_jobs
      SET status=$1, details=COALESCE($2, details), updated_at=NOW()
      WHERE id_text=$3
      `,
      [status, details || null, idText]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * List jobs for a printer
 * GET /jobs?printerId=PP-USA-001
 */
app.get("/jobs", async (req, res) => {
  try {
    const { printerId } = req.query;
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const result = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id=$1
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [printerId]
    );

    res.json({ ok: true, jobs: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Count jobs by status for a printer
 * GET /jobs/count?printerId=PP-USA-001
 */
app.get("/jobs/count", async (req, res) => {
  try {
    const { printerId } = req.query;
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const result = await pool.query(
      `
      SELECT status, COUNT(*)::int AS count
      FROM print_jobs
      WHERE printer_id=$1
      GROUP BY status
      `,
      [printerId]
    );

    const byStatus = {};
    for (const row of result.rows) byStatus[row.status] = row.count;

    res.json({ ok: true, printerId, byStatus });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --------------------
// HELPERS
// --------------------
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// --------------------
app.listen(PORT, () => {
  console.log(`✅ MSTAF CORE running on port ${PORT}`);
});

