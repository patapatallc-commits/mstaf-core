/**
 * MSTAF CORE - server.js (Render-ready)
 * ✅ Print-O-Matic + Editing Services (Shopify upload form)
 *
 * Endpoints:
 *  - GET  /health
 *  - POST /api/upload            (multipart/form-data)  ✅ accepts serviceType + print/edit fields
 *  - GET  /jobs?printerId=...    ✅ returns ONLY printable jobs (paid + serviceType=print)
 *  - POST /jobs/:idText/status   ✅ worker updates status: printing/printed/error
 *  - GET  /admin/edit-jobs       ✅ (basic) list edit_image/edit_video jobs (for future dashboard)
 *
 * Notes:
 *  - Editing jobs are stored but NOT returned to printer worker.
 *  - serviceType + instructions + edit/video fields are stored inside meta JSON.
 *  - Uses safe DB migrations (adds columns if missing).
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// =========================
// CONFIG
// =========================
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL");
  process.exit(1);
}

const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "") ||
  "https://mstaf-core-1.onrender.com";

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// (Optional) Basic admin protection for edit jobs listing
const ADMIN_KEY = process.env.ADMIN_KEY || "";
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return next(); // if not set, allow
  const k = req.headers["x-admin-key"] || req.query.admin_key;
  if (k !== ADMIN_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

// =========================
// Postgres
// =========================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

// =========================
// Safe migrations
// =========================
async function colExists(table, col) {
  const r = await pool.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = $1 AND column_name = $2
    LIMIT 1
  `,
    [table, col]
  );
  return r.rowCount > 0;
}

async function ensureSchema() {
  // Create table if missing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add columns if missing (id_text = string id; id remains integer)
  const adds = [
    ["id_text", "TEXT"],
    ["printer_id", "TEXT"],
    ["from_phone", "TEXT"],
    ["file_name", "TEXT"],
    ["mime_type", "TEXT"],
    ["file_url", "TEXT"],
    ["status", "TEXT"],
    ["pages", "INT"],
    ["copies", "INT"],
    ["color", "BOOLEAN"],
    ["source", "TEXT"],
    ["meta", "JSONB"],
  ];

  for (const [col, type] of adds) {
    const exists = await colExists("print_jobs", col);
    if (!exists) {
      await pool.query(`ALTER TABLE print_jobs ADD COLUMN ${col} ${type};`);
      console.log("✅ Added column:", col);
    }
  }

  // Helpful indexes (safe)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_id ON print_jobs(printer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_id_text ON print_jobs(id_text);`);

  console.log("✅ DB schema ready");
}
ensureSchema().catch((e) => console.error("❌ ensureSchema failed:", e));

// =========================
// Upload handling (multer)
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "") || "";
    const safeBase = (path.basename(file.originalname || "upload", ext) || "upload")
      .replace(/[^\w\-\.]+/g, "_")
      .slice(0, 80);
    const stamp = Date.now();
    cb(null, `${stamp}-${crypto.randomBytes(5).toString("hex")}-${safeBase}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB (keep small on Render). For large videos use fileLink.
  },
});

// Serve uploads
app.use("/uploads", express.static(UPLOAD_DIR));

// =========================
// Helpers
// =========================
function boolFromColorMode(colorMode) {
  // Shopify form sends "bw" or "color"
  return String(colorMode || "").toLowerCase() === "color";
}

function intOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.trunc(n));
}

function makeJobId() {
  return `print_${crypto.randomBytes(8).toString("hex")}`;
}

// =========================
// Routes
// =========================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * POST /api/upload
 * multipart/form-data fields expected:
 * - printerId (required)
 * - file (required)
 * - serviceType: print | edit_image | edit_video (optional; default print)
 * - print fields: paperSize, colorMode, copies, pages
 * - edit fields: instructions, fileLink, editLevel, deliverFormat, phone
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || "").trim();
    if (!printerId) return res.status(400).json({ error: "printerId is required" });
    if (!req.file) return res.status(400).json({ error: "file is required" });

    const serviceType = (req.body.serviceType || "print").trim(); // print | edit_image | edit_video
    const copies = intOrNull(req.body.copies) || 1;
    const pages = intOrNull(req.body.pages); // optional
    const color = boolFromColorMode(req.body.colorMode);
    const paperSize = (req.body.paperSize || "A4").trim();

    const instructions = (req.body.instructions || "").trim();
    const fileLink = (req.body.fileLink || "").trim();
    const editLevel = (req.body.editLevel || "basic").trim();
    const deliverFormat = (req.body.deliverFormat || "").trim();
    const phone = (req.body.phone || "").trim();

    const fileUrl = `${PUBLIC_BASE_URL}/uploads/${encodeURIComponent(req.file.filename)}`;

    const idText = makeJobId();

    // ✅ IMPORTANT:
    // - print jobs should be "paid" to be picked by worker (your worker polls only paid)
    // - edit jobs should NOT be printed; store as "submitted"
    const status = serviceType === "print" ? "paid" : "submitted";

    const meta = {
      serviceType,
      paperSize,
      colorMode: color ? "color" : "bw",
      copies,
      pages,
      instructions,
      fileLink,
      editLevel,
      deliverFormat,
      phone,
    };

    await pool.query(
      `
      INSERT INTO print_jobs
        (id_text, printer_id, file_name, mime_type, file_url, status, pages, copies, color, source, meta)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `,
      [
        idText,
        printerId,
        req.file.originalname || req.file.filename,
        req.file.mimetype || "application/octet-stream",
        fileUrl,
        status,
        pages,
        copies,
        color,
        "mstaf",
        meta,
      ]
    );

    return res.json({
      success: true,
      jobId: idText,
      message: "Uploaded successfully",
      serviceType,
      status,
      fileUrl,
    });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    return res.status(500).json({ error: "upload_failed", detail: String(e.message || e) });
  }
});

/**
 * GET /jobs?printerId=PP-USA-001&limit=5
 * ✅ returns ONLY printable jobs:
 * - printer_id matches
 * - status = 'paid'
 * - meta.serviceType == 'print' (or meta missing -> treat as print)
 */
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").trim();
    if (!printerId) return res.status(400).json({ error: "printerId is required" });

    const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 50);

    const r = await pool.query(
      `
      SELECT
        id_text,
        printer_id,
        status,
        pages,
        copies,
        color,
        source,
        created_at,
        file_name,
        mime_type,
        file_url,
        meta
      FROM print_jobs
      WHERE printer_id = $1
        AND status = 'paid'
        AND (
          (meta->>'serviceType') IS NULL
          OR (meta->>'serviceType') = 'print'
        )
      ORDER BY created_at ASC
      LIMIT $2
    `,
      [printerId, limit]
    );

    // Worker expects a simplified shape (matches your current worker.js)
    const out = r.rows.map((row) => ({
      idText: row.id_text,
      printer_id: row.printer_id,
      status: row.status,
      pages: row.pages || 1,
      copies: row.copies || 1,
      color: !!row.color,
      source: row.source,
      created_at: row.created_at,
      file_name: row.file_name,
      mime_type: row.mime_type,
      fileUrl: row.file_url,
      meta: row.meta || {},
    }));

    res.json(out);
  } catch (e) {
    console.error("GET /jobs ERROR:", e);
    res.status(500).json({ error: "jobs_failed", detail: String(e.message || e) });
  }
});

/**
 * POST /jobs/:idText/status
 * Body: { status: "printing" | "printed" | "error" }
 */
app.post("/jobs/:idText/status", async (req, res) => {
  try {
    const idText = (req.params.idText || "").trim();
    const status = (req.body.status || "").trim();
    if (!idText) return res.status(400).json({ error: "missing idText" });
    if (!status) return res.status(400).json({ error: "missing status" });

    const r = await pool.query(
      `
      UPDATE print_jobs
      SET status = $1
      WHERE id_text = $2
      RETURNING id_text, status
    `,
      [status, idText]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "job_not_found" });
    res.json({ success: true, jobId: r.rows[0].id_text, status: r.rows[0].status });
  } catch (e) {
    console.error("POST /jobs/:id/status ERROR:", e);
    res.status(500).json({ error: "status_update_failed", detail: String(e.message || e) });
  }
});

/**
 * ✅ Basic list for editing jobs (for your future mobile dashboard)
 * GET /admin/edit-jobs
 * Headers: x-admin-key: <ADMIN_KEY>  (optional if ADMIN_KEY is set)
 */
app.get("/admin/edit-jobs", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);

    const r = await pool.query(
      `
      SELECT
        id_text,
        printer_id,
        status,
        created_at,
        file_name,
        mime_type,
        file_url,
        meta
      FROM print_jobs
      WHERE (meta->>'serviceType') IN ('edit_image','edit_video')
      ORDER BY created_at DESC
      LIMIT $1
    `,
      [limit]
    );

    res.json(
      r.rows.map((x) => ({
        idText: x.id_text,
        status: x.status,
        created_at: x.created_at,
        file_name: x.file_name,
        fileUrl: x.file_url,
        meta: x.meta || {},
      }))
    );
  } catch (e) {
    console.error("GET /admin/edit-jobs ERROR:", e);
    res.status(500).json({ error: "edit_jobs_failed", detail: String(e.message || e) });
  }
});

// Root
app.get("/", (req, res) => {
  res.type("text").send("MSTAF CORE is running. Try /health");
});

// =========================
// Start
// =========================
app.listen(PORT, () => {
  console.log(`✅ MSTAF CORE listening on ${PORT}`);
  console.log(`PUBLIC_BASE_URL: ${PUBLIC_BASE_URL}`);
});
