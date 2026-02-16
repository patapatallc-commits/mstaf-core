/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * ✅ Health:            GET  /health
 * ✅ Upload (Web form): POST /api/upload   (multipart/form-data)
 * ✅ Serve uploads:     GET  /uploads/:file
 * ✅ Worker polling:    GET  /jobs/next?printerId=PP-USA-001
 * ✅ Status updates:    POST /jobs/:id/status   (worker auth)
 * ✅ List jobs:         GET  /jobs?printerId=PP-USA-001&status=queued
 *
 * NEW (Safe Routing):
 * - If paper_size=A3  => printer_id = PP-USA-A3-001
 * - If print_format=Card => printer_id = PP-USA-CARD-001
 * - Else default => PP-USA-001
 *
 * Backward compatible:
 * - Accepts both x-worker-key and x-printer-key headers
 * - Accepts body fields in multiple names (paperSize/paper_size, printFormat/print_format, etc.)
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

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;

const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
// If BASE_URL is empty, we still return relative URLs; worker uses full file_url stored in DB.
// Recommended: set BASE_URL=https://mstaf-core-1.onrender.com in Render env.

const WORKER_KEY = process.env.WORKER_KEY || process.env.PRINTER_KEY || "";

// Default printer queue (your Epson A4/LTR worker)
const DEFAULT_PRINTER_ID = process.env.DEFAULT_PRINTER_ID || "PP-USA-001";

// Upload storage
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads");

// PostgreSQL
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL env var");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL_DISABLE === "1" ? false : { rejectUnauthorized: false },
});

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Ensure uploads directory exists
try {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch (e) {
  console.error("❌ Cannot create uploads dir:", e.message);
  process.exit(1);
}

// Serve uploaded files
app.use("/uploads", express.static(UPLOADS_DIR));

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safeOriginal = String(file.originalname || "file")
      .replace(/[^\w.\-]+/g, "_")
      .slice(0, 160);

    const ext = path.extname(safeOriginal) || "";
    const base = safeOriginal.replace(ext, "");
    const stamp = Date.now();
    cb(null, `${stamp}_${base}${ext}`);
  },
});
const upload = multer({ storage });

// ---------- DB MIGRATION (SAFE) ----------
async function ensureSchema() {
  // Create table if missing, add columns if missing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      printer_id TEXT NOT NULL DEFAULT '${DEFAULT_PRINTER_ID}',
      copies INTEGER NOT NULL DEFAULT 1,
      pages INTEGER NOT NULL DEFAULT 1,
      paper_size TEXT,
      color_type TEXT,
      print_format TEXT,
      instructions TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      error TEXT
    );
  `);

  // Add missing columns (idempotent)
  const addCol = async (name, typeSql) => {
    await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS ${name} ${typeSql};`);
  };

  await addCol("printer_id", `TEXT NOT NULL DEFAULT '${DEFAULT_PRINTER_ID}'`);
  await addCol("copies", "INTEGER NOT NULL DEFAULT 1");
  await addCol("pages", "INTEGER NOT NULL DEFAULT 1");
  await addCol("paper_size", "TEXT");
  await addCol("color_type", "TEXT");
  await addCol("print_format", "TEXT");
  await addCol("instructions", "TEXT");
  await addCol("created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await addCol("updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await addCol("error", "TEXT");
}

// Keep updated_at fresh
async function touchUpdatedAt(id) {
  await pool.query(`UPDATE print_jobs SET updated_at = NOW() WHERE id = $1`, [id]);
}

// ---------- AUTH (WORKER) ----------
function getWorkerKeyFromReq(req) {
  const a = req.headers["x-worker-key"];
  const b = req.headers["x-printer-key"];
  const c = req.headers["x-api-key"];
  return String(a || b || c || "");
}

function requireWorkerAuth(req, res, next) {
  // If WORKER_KEY is not set, we still allow (dev mode)
  if (!WORKER_KEY) return next();

  const got = getWorkerKeyFromReq(req);
  if (!got || got !== WORKER_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized worker" });
  }
  next();
}

// ---------- PRINTER ROUTING (NEW) ----------
function resolvePrinterIdFromRequest(body = {}) {
  const paperSizeRaw = body.paper_size ?? body.paperSize ?? body.size ?? body.paper ?? "A4";
  const printFormatRaw = body.print_format ?? body.printFormat ?? body.format ?? "Document";

  const paperSize = String(paperSizeRaw).trim().toUpperCase();
  const printFormat = String(printFormatRaw).trim().toLowerCase(); // document/card

  let printerId = DEFAULT_PRINTER_ID;

  // A3 routes to A3 queue
  if (paperSize === "A3") printerId = "PP-USA-A3-001";

  // Card routes to Card queue (overrides A3 if selected)
  if (printFormat === "card") printerId = "PP-USA-CARD-001";

  return printerId;
}

function buildPublicFileUrl(req, filename) {
  // Prefer explicit BASE_URL if set, else infer from request
  const base =
    BASE_URL ||
    `${req.protocol}://${req.get("host")}`.replace(/\/+$/, "");
  return `${base}/uploads/${encodeURIComponent(filename)}`;
}

// ---------- ROUTES ----------
app.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: !!r?.rows?.[0]?.ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Upload from Shopify web form
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.filename) {
      return res.status(400).json({ ok: false, error: "Missing file" });
    }

    // Read fields (support multiple names)
    const copies = Math.max(1, Number(req.body.copies ?? req.body.copy ?? 1) || 1);
    const pages = Math.max(1, Number(req.body.pages ?? req.body.pageCount ?? 1) || 1);

    const paper_size = String(req.body.paper_size ?? req.body.paperSize ?? "A4");
    const color_type = String(req.body.color_type ?? req.body.colorType ?? req.body.color ?? "BW");
    const print_format = String(req.body.print_format ?? req.body.printFormat ?? "Document");
    const instructions = String(req.body.instructions ?? req.body.note ?? req.body.notes ?? "");

    // NEW: route to printer queues safely
    const printer_id = resolvePrinterIdFromRequest(req.body);

    const file_name = file.filename;
    const file_url = buildPublicFileUrl(req, file.filename);

    const insert = await pool.query(
      `
      INSERT INTO print_jobs
        (file_name, file_url, copies, pages, status, printer_id, paper_size, color_type, print_format, instructions)
      VALUES
        ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [file_name, file_url, copies, pages, printer_id, paper_size, color_type, print_format, instructions]
    );

    const job = insert.rows[0];
    res.json({ ok: true, job, file_url, printer_id });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// List jobs (optional admin)
app.get("/jobs", async (req, res) => {
  try {
    const printerId = String(req.query.printerId || req.query.printer_id || "");
    const status = String(req.query.status || "");

    const where = [];
    const vals = [];
    let i = 1;

    if (printerId) {
      where.push(`printer_id = $${i++}`);
      vals.push(printerId);
    }
    if (status) {
      where.push(`status = $${i++}`);
      vals.push(status);
    }

    const sql = `
      SELECT *
      FROM print_jobs
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY id DESC
      LIMIT 200
    `;

    const r = await pool.query(sql, vals);
    res.json({ ok: true, jobs: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Worker fetch next job
app.get("/jobs/next", requireWorkerAuth, async (req, res) => {
  try {
    const printerId = String(req.query.printerId || req.query.printer_id || DEFAULT_PRINTER_ID);

    // Pick oldest queued job for that printer
    const r = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1 AND status = 'queued'
      ORDER BY id ASC
      LIMIT 1
      `,
      [printerId]
    );

    const job = r.rows[0] || null;
    res.json({ ok: true, job });
  } catch (e) {
    console.error("NEXT JOB ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Worker updates job status
app.post("/jobs/:id/status", requireWorkerAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body.status || "").trim();
    const error = req.body.error ? String(req.body.error).slice(0, 1000) : null;

    if (!id || !status) {
      return res.status(400).json({ ok: false, error: "Missing id or status" });
    }

    await pool.query(
      `
      UPDATE print_jobs
      SET status = $1,
          error = COALESCE($2, error),
          updated_at = NOW()
      WHERE id = $3
      `,
      [status, error, id]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("STATUS UPDATE ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// (Optional) Simple admin view route to confirm server up
app.get("/", (_req, res) => {
  res.type("text").send(
    "MSTAF CORE is running. Endpoints: /health, /api/upload, /jobs, /jobs/next, /jobs/:id/status, /uploads/:file"
  );
});

// ---------- START ----------
ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ MSTAF CORE listening on port ${PORT}`);
      console.log(`✅ Uploads dir: ${UPLOADS_DIR}`);
      console.log(`✅ Default printer queue: ${DEFAULT_PRINTER_ID}`);
      console.log(`✅ Worker key: ${WORKER_KEY ? "(set)" : "(missing - dev mode)"}`);
    });
  })
  .catch((e) => {
    console.error("❌ Schema init failed:", e);
    process.exit(1);
  });
