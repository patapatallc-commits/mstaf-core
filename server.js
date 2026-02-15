/**
 * MSTAF CORE - Print-O-Matic Server (Render)
 * Fix: public /uploads serving so worker can download files (no more 404).
 *
 * Endpoints:
 * - GET  /health
 * - POST /api/upload   (multipart/form-data) -> creates job
 * - GET  /jobs?printerId=PP-USA-001&limit=5&key=WORKER_KEY
 * - POST /jobs/:id/status   { status, printed_text?, error?, details? }  (requires key)
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 10000;

// Your worker key (what worker.js uses in ?key=...)
const WORKER_KEY = process.env.WORKER_KEY || "ppk_7mQ9vK2xR8sN1zT4pL6aJ0";

// Public base URL (IMPORTANT for file_url)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "https://mstaf-core-1.onrender.com";

// Printer default (optional)
const DEFAULT_PRINTER_ID = process.env.DEFAULT_PRINTER_ID || "PP-USA-001";

// -------------------- MIDDLEWARE --------------------
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// -------------------- UPLOADS (LOCAL) --------------------
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

// Serve uploaded files publicly
app.use("/uploads", express.static(uploadDir));

// Multer storage
const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, uploadDir);
  },
  filename: function (_req, file, cb) {
    const safeName = (file.originalname || "file")
      .replace(/[^\w.\-]+/g, "_")
      .slice(0, 120);
    cb(null, `${Date.now()}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// -------------------- DATABASE --------------------
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing in Render env vars.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function ensureSchema() {
  // Create table if missing (superset columns to avoid future errors)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT,
      printer_id TEXT,
      status TEXT DEFAULT 'queued',

      file_name TEXT,
      mime_type TEXT,
      file_url TEXT,
      file_base64 TEXT,

      pages INT DEFAULT 1,
      copies INT DEFAULT 1,
      color BOOLEAN DEFAULT false,
      color_type TEXT,          -- e.g. BW / COLOR
      paper_size TEXT,          -- A4/A3/etc

      source TEXT DEFAULT 'mstaf',
      service_type TEXT DEFAULT 'print',
      instructions TEXT,
      note TEXT,

      paid BOOLEAN DEFAULT false,
      is_paid BOOLEAN DEFAULT false,
      paid_at TIMESTAMPTZ,

      meta JSONB,
      details TEXT,
      error TEXT,
      printed_text TEXT,

      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Patch columns if older schema exists
  const addCol = async (name, type) => {
    await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS ${name} ${type};`);
  };

  await addCol("id_text", "TEXT");
  await addCol("printer_id", "TEXT");
  await addCol("status", "TEXT");
  await addCol("file_name", "TEXT");
  await addCol("mime_type", "TEXT");
  await addCol("file_url", "TEXT");
  await addCol("file_base64", "TEXT");
  await addCol("pages", "INT DEFAULT 1");
  await addCol("copies", "INT DEFAULT 1");
  await addCol("color", "BOOLEAN DEFAULT false");
  await addCol("color_type", "TEXT");
  await addCol("paper_size", "TEXT");
  await addCol("source", "TEXT");
  await addCol("service_type", "TEXT");
  await addCol("instructions", "TEXT");
  await addCol("note", "TEXT");
  await addCol("paid", "BOOLEAN DEFAULT false");
  await addCol("is_paid", "BOOLEAN DEFAULT false");
  await addCol("paid_at", "TIMESTAMPTZ");
  await addCol("meta", "JSONB");
  await addCol("details", "TEXT");
  await addCol("error", "TEXT");
  await addCol("printed_text", "TEXT");
  await addCol("created_at", "TIMESTAMPTZ DEFAULT NOW()");
  await addCol("updated_at", "TIMESTAMPTZ DEFAULT NOW()");
}

function requireWorkerKey(req, res, next) {
  const key = req.query.key || req.headers["x-worker-key"];
  if (key !== WORKER_KEY) {
    return res.status(401).json({ ok: false, error: "Invalid worker key" });
  }
  next();
}

function normalizeInt(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeBool(val, fallback) {
  if (val === true || val === "true" || val === 1 || val === "1") return true;
  if (val === false || val === "false" || val === 0 || val === "0") return false;
  return fallback;
}

function makeIdText() {
  return crypto.randomBytes(12).toString("hex");
}

// -------------------- ROUTES --------------------
app.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({
      ok: true,
      db: r.rows?.[0]?.ok === 1,
      base: PUBLIC_BASE_URL,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Upload endpoint (web form / Shopify)
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printer_id = (req.body.printer_id || req.body.printerId || DEFAULT_PRINTER_ID || "").trim();
    const pages = normalizeInt(req.body.pages, 1);
    const copies = normalizeInt(req.body.copies, 1);
    const color = normalizeBool(req.body.color, false);
    const color_type = (req.body.color_type || req.body.colorType || "").trim() || (color ? "COLOR" : "BW");
    const paper_size = (req.body.paper_size || req.body.paperSize || "").trim() || "A4";
    const service_type = (req.body.service_type || req.body.serviceType || "print").trim();
    const instructions = (req.body.instructions || "").trim();
    const note = (req.body.note || "").trim();

    // paid/is_paid
    const paid = normalizeBool(req.body.paid, false);
    const is_paid = normalizeBool(req.body.is_paid, paid);

    // file info
    const file = req.file;
    if (!file) {
      return res.status(400).json({ ok: false, error: "No file uploaded (field name must be 'file')" });
    }

    const file_name = file.filename; // saved name
    const mime_type = file.mimetype || null;

    // IMPORTANT: file_url uses PUBLIC_BASE_URL + /uploads/<file_name>
    const file_url = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/uploads/${encodeURIComponent(file_name)}`;

    const id_text = makeIdText();

    const meta = {
      original_name: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      paper_size,
      color_type,
      source: "mstaf",
    };

    const insert = await pool.query(
      `
      INSERT INTO print_jobs
        (id_text, printer_id, status, file_name, mime_type, file_url, pages, copies, color, color_type, paper_size,
         source, service_type, instructions, note, paid, is_paid, meta)
      VALUES
        ($1,$2,'queued',$3,$4,$5,$6,$7,$8,$9,$10,$11,'mstaf',$12,$13,$14,$15,$16,$17)
      RETURNING id, id_text, printer_id, status, file_name, file_url, pages, copies, color, color_type, paper_size, service_type, created_at;
      `,
      [
        id_text,
        printer_id,
        file_name,
        mime_type,
        file_url,
        pages,
        copies,
        color,
        color_type,
        paper_size,
        service_type,
        instructions,
        note,
        paid,
        is_paid,
        meta,
      ]
    );

    return res.json({ ok: true, job: insert.rows[0] });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Worker polling endpoint
app.get("/jobs", requireWorkerKey, async (req, res) => {
  try {
    const printerId = (req.query.printerId || req.query.printer_id || "").toString().trim();
    const limit = Math.min(normalizeInt(req.query.limit, 5), 20);

    if (!printerId) {
      return res.status(400).json({ ok: false, error: "Missing printerId" });
    }

    // Only return jobs that are ready to be processed
    const q = await pool.query(
      `
      SELECT id, id_text, printer_id, status, file_name, mime_type, file_url, pages, copies, color, color_type, paper_size,
             source, service_type, instructions, note, paid, is_paid, meta, created_at, updated_at
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued','paid','authorized_awaiting_file')
      ORDER BY created_at ASC
      LIMIT $2;
      `,
      [printerId, limit]
    );

    return res.json({ ok: true, jobs: q.rows });
  } catch (e) {
    console.error("JOBS GET ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Worker status update
app.post("/jobs/:id/status", requireWorkerKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const status = (req.body.status || "").toString().trim();
    const printed_text = req.body.printed_text ?? req.body.printedText ?? null;
    const error = req.body.error ?? null;
    const details = req.body.details ?? null;

    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "Invalid id" });
    }
    if (!status) {
      return res.status(400).json({ ok: false, error: "Missing status" });
    }

    const upd = await pool.query(
      `
      UPDATE print_jobs
      SET status = $2,
          printed_text = COALESCE($3, printed_text),
          error = COALESCE($4, error),
          details = COALESCE($5, details),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, status, updated_at;
      `,
      [id, status, printed_text, error, details]
    );

    if (upd.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Job not found" });
    }
    return res.json({ ok: true, job: upd.rows[0] });
  } catch (e) {
    console.error("STATUS POST ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Default root
app.get("/", (_req, res) => {
  res.type("text").send("MSTAF CORE is running. Try /health");
});

// -------------------- START --------------------
(async () => {
  try {
    await ensureSchema();
    app.listen(PORT, () => {
      console.log(`✅ MSTAF CORE listening on port ${PORT}`);
      console.log(`✅ PUBLIC_BASE_URL=${PUBLIC_BASE_URL}`);
      console.log(`✅ Serving uploads from ${uploadDir} at /uploads`);
    });
  } catch (e) {
    console.error("❌ Failed to start:", e);
    process.exit(1);
  }
})();
