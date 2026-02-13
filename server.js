require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

const PRINTER_KEY = process.env.PRINTER_KEY || "";

// ✅ IMPORTANT: use persistent disk folder when provided
const UPLOAD_DIR = (process.env.UPLOAD_DIR || "").trim() || path.join(__dirname, "uploads");

// middleware
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "x-printer-key"] }));

// ensure upload dir exists
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ✅ Serve uploads from the same folder we save into
app.use("/uploads", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = (file.originalname || "file").replace(/[^\w.\-]+/g, "_");
    cb(null, `${Date.now()}_${safeName}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

async function runMigrations() {
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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status_created
    ON print_jobs (printer_id, status, created_at DESC);
  `);
}

function makeJobId() {
  return `print_${Math.floor(Date.now() / 1000)}${crypto.randomBytes(3).toString("hex")}`;
}
function normalizeCopies(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 100 ? n : 1;
}
function normalizePaperSize(v) {
  const s = String(v || "").toUpperCase();
  return s.includes("LETTER") ? "LETTER" : "A4";
}
function normalizeColorType(v) {
  const s = String(v || "").toLowerCase();
  return s.includes("color") ? "COLOR" : "BW";
}
function requirePrinterKey(req, res) {
  if (!PRINTER_KEY) return true;
  const k = req.headers["x-printer-key"] || "";
  if (k !== PRINTER_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized printer" });
    return false;
  }
  return true;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, upload_dir: UPLOAD_DIR, time: new Date().toISOString() });
});

// ✅ upload creates printable job (queued)
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || "PP-USA-001").trim();
    const phone = (req.body.phone || "").trim();
    const copies = normalizeCopies(req.body.copies);
    const paperSize = normalizePaperSize(req.body.paperSize);
    const colorType = normalizeColorType(req.body.colorType);

    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const jobId = makeJobId();
    const relativeFileUrl = `/uploads/${req.file.filename}`;

    await pool.query(
      `
      INSERT INTO print_jobs (
        id_text, printer_id, from_phone,
        file_name, mime_type, file_url,
        copies, paper_size, color_type,
        status, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',NOW(),NOW())
      `,
      [jobId, printerId, phone, req.file.originalname, req.file.mimetype, relativeFileUrl, copies, paperSize, colorType]
    );

    res.json({ ok: true, jobId, printerId, file_url: relativeFileUrl });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ✅ worker polls queued/paid
app.get("/jobs", async (req, res) => {
  try {
    if (!requirePrinterKey(req, res)) return;

    const printerId = (req.query.printerId || "").trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "printerId required" });

    const { rows } = await pool.query(
      `
      SELECT id_text, printer_id, file_url, copies, paper_size, color_type, status, created_at
      FROM print_jobs
      WHERE printer_id=$1 AND status IN ('queued','paid')
      ORDER BY created_at ASC
      LIMIT 20
      `,
      [printerId]
    );

    res.json(rows);
  } catch (e) {
    console.error("JOBS ERROR:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ✅ worker updates status
app.post("/jobs/:id_text/status", async (req, res) => {
  try {
    if (!requirePrinterKey(req, res)) return;

    const idText = (req.params.id_text || "").trim();
    const status = (req.body.status || "").trim();
    if (!idText || !status) return res.status(400).json({ ok: false, error: "id_text and status required" });

    const r = await pool.query(
      `UPDATE print_jobs SET status=$1, updated_at=NOW() WHERE id_text=$2`,
      [status, idText]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "Job not found" });

    res.json({ ok: true, id_text: idText, status });
  } catch (e) {
    console.error("STATUS ERROR:", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

(async () => {
  await runMigrations();
  app.listen(PORT, () => console.log(`✅ mstaf-core running on ${PORT} | uploads: ${UPLOAD_DIR}`));
})();
