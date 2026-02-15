/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * ✅ Upload (POST /api/upload)
 * ✅ Serve uploads correctly on Render (/uploads)
 * ✅ Worker auth (X-Worker-Key)
 * ✅ Printer polling (GET /jobs/next?printerId=...)
 * ✅ Status update (POST /jobs/:id/status)
 * ✅ Debug uploads (GET /debug/uploads)
 */

"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// --------------------
// Config / ENV
// --------------------
const PORT = process.env.PORT || 10000;

// Set this in Render ENV:
// WORKER_KEY = (any long secret)
const WORKER_KEY = process.env.WORKER_KEY || "";

// Optional default printer id
const DEFAULT_PRINTER_ID = process.env.PRINTER_ID || "PP-USA-001";

// Postgres
const DATABASE_URL = process.env.DATABASE_URL || "";

// --------------------
// Middleware
// --------------------
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// --------------------
// Postgres
// --------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// Ensure DB table exists (lightweight bootstrap)
async function ensureSchema() {
  const sql = `
  CREATE TABLE IF NOT EXISTS print_jobs (
    id SERIAL PRIMARY KEY,
    id_text TEXT,
    printer_id TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    service_type TEXT DEFAULT 'print',
    paper_size TEXT DEFAULT 'A4',
    color_type TEXT DEFAULT 'bw',
    copies INT NOT NULL DEFAULT 1,
    pages INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Helpful index
  CREATE INDEX IF NOT EXISTS idx_print_jobs_queue
    ON print_jobs (printer_id, status, created_at);
  `;
  await pool.query(sql);
}

ensureSchema().catch((e) => console.error("SCHEMA INIT ERROR:", e));

// --------------------
// Uploads directory (Render-safe) ✅
// --------------------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploads from absolute path ✅
app.use("/uploads", express.static(uploadsDir));

// Debug route to prove files exist on Render ✅
app.get("/debug/uploads", (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir);
    res.json({
      ok: true,
      uploadsDir,
      count: files.length,
      files: files.slice(0, 50),
    });
  } catch (err) {
    res.json({ ok: false, uploadsDir, error: String(err) });
  }
});

// --------------------
// Multer storage (MUST match uploadsDir) ✅
// --------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    // sanitize filename to avoid URL/FS issues
    const safe = String(file.originalname || "file")
      .replace(/[^\w.\-()]+/g, "_") // replace spaces + weird chars with _
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({ storage });

// --------------------
// Helpers
// --------------------
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.get("host");
  return `${proto}://${host}`;
}

function requireWorkerAuth(req, res, next) {
  // Worker must send: X-Worker-Key: <secret>
  if (!WORKER_KEY) {
    // If you forget to set WORKER_KEY, we keep running but warn you.
    console.warn("⚠️ WORKER_KEY is not set. Worker auth is effectively disabled.");
    return next();
  }

  const key = req.header("x-worker-key") || "";
  if (key !== WORKER_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized worker" });
  }
  next();
}

// --------------------
// Routes
// --------------------
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({
      ok: true,
      db: r.rows?.[0]?.ok === 1,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "DB not reachable", details: String(e) });
  }
});

/**
 * Upload job (Shopify / Web portal)
 * multipart/form-data:
 * - file: (required)
 * - printerId (optional)
 * - copies (optional)
 * - pages (optional)
 * - paper_size (optional: A4/A3/Letter/etc)
 * - color_type (optional: bw/color)
 * - service_type (optional: print / photo_edit / video_edit)
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const printerId = (req.body.printerId || DEFAULT_PRINTER_ID).trim();
    const copies = Math.max(1, parseInt(req.body.copies || "1", 10) || 1);
    const pages = Math.max(1, parseInt(req.body.pages || "1", 10) || 1);
    const paperSize = (req.body.paper_size || "A4").trim();
    const colorType = (req.body.color_type || "bw").trim();
    const serviceType = (req.body.service_type || "print").trim();

    const baseUrl = getBaseUrl(req);

    // IMPORTANT: encode filename in URL ✅
    const fileUrl = `${baseUrl}/uploads/${encodeURIComponent(req.file.filename)}`;

    // id_text is a friendly public id if you want (optional)
    const idText = `PP-${Date.now()}`;

    const insertSql = `
      INSERT INTO print_jobs
        (id_text, printer_id, file_url, file_name, status, service_type, paper_size, color_type, copies, pages)
      VALUES
        ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9)
      RETURNING *;
    `;

    const result = await pool.query(insertSql, [
      idText,
      printerId,
      fileUrl,
      req.file.filename,
      serviceType,
      paperSize,
      colorType,
      copies,
      pages,
    ]);

    const job = result.rows[0];

    res.json({
      ok: true,
      job_id: job.id,
      id_text: job.id_text,
      printer_id: job.printer_id,
      file_url: job.file_url,
      file_name: job.file_name,
      copies: job.copies,
      pages: job.pages,
      paper_size: job.paper_size,
      color_type: job.color_type,
      service_type: job.service_type,
      status: job.status,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

/**
 * Worker polling: get next queued job
 * GET /jobs/next?printerId=PP-USA-001
 */
app.get("/jobs/next", async (req, res) => {
  try {
    const printerId = (req.query.printerId || DEFAULT_PRINTER_ID).trim();

    // get oldest queued
    const q = `
      SELECT *
      FROM print_jobs
      WHERE printer_id=$1 AND status='queued'
      ORDER BY created_at ASC
      LIMIT 1;
    `;
    const r = await pool.query(q, [printerId]);

    if (!r.rows.length) {
      return res.json({ ok: true, job: null });
    }

    const job = r.rows[0];

    // Return job without changing status (your worker already posts "printing")
    return res.json({
      ok: true,
      job: {
        id: job.id,
        id_text: job.id_text,
        printer_id: job.printer_id,
        file_url: job.file_url,
        file_name: job.file_name,
        copies: job.copies,
        pages: job.pages,
        paper_size: job.paper_size,
        color_type: job.color_type,
        service_type: job.service_type,
        status: job.status,
      },
    });
  } catch (err) {
    console.error("JOBS NEXT ERROR:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Optional list endpoint
 * GET /jobs?printerId=...&status=queued
 */
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || DEFAULT_PRINTER_ID).trim();
    const status = (req.query.status || "").trim();

    const params = [printerId];
    let where = "printer_id=$1";

    if (status) {
      params.push(status);
      where += ` AND status=$${params.length}`;
    }

    const q = `
      SELECT *
      FROM print_jobs
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT 50;
    `;

    const r = await pool.query(q, params);
    res.json({ ok: true, jobs: r.rows });
  } catch (err) {
    console.error("JOBS LIST ERROR:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Worker status update
 * POST /jobs/:id/status
 * headers: X-Worker-Key: <secret>
 * body: { status: "printing" | "done" | "error", message?: "..." }
 */
app.post("/jobs/:id/status", requireWorkerAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid job id" });

    const status = String(req.body.status || "").trim();
    const allowed = new Set(["queued", "printing", "done", "error"]);
    if (!allowed.has(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }

    const q = `
      UPDATE print_jobs
      SET status=$1, updated_at=NOW()
      WHERE id=$2
      RETURNING *;
    `;
    const r = await pool.query(q, [status, id]);

    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Job not found" });

    res.json({ ok: true, job: r.rows[0] });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Root
app.get("/", (req, res) => {
  res.send("MSTAF CORE is running ✅");
});

// --------------------
// Start
// --------------------
app.listen(PORT, () => {
  console.log(`MSTAF CORE listening on port ${PORT}`);
  console.log(`Uploads dir: ${uploadsDir}`);
});
