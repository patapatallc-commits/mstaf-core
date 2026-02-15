/**
 * MSTAF CORE - Print-O-Matic Server (Render)
 * - Health: GET /health
 * - Upload: POST /api/upload (multipart/form-data)
 * - Serve uploads: GET /uploads/:filename
 * - Printer polling: GET /jobs?printerId=PP-USA-001&limit=5&key=ppk_xxx
 * - Status update: POST /jobs/:id/status  (x-api-key or ?key)
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

// ------------------- ENV -------------------
const PORT = process.env.PORT || 3000;
const BASE_URL =
  (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").trim() ||
  `http://localhost:${PORT}`;

// Printer auth key (shared secret between worker + server)
const PRINTER_API_KEY = (process.env.PRINTER_API_KEY || "").trim();

// ------------------- APP -------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// ------------------- UPLOADS DIR -------------------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Serve uploaded files
app.use("/uploads", express.static(uploadsDir, { fallthrough: false }));

// ------------------- DB -------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL && process.env.DATABASE_URL.includes("render.com")
      ? { rejectUnauthorized: false }
      : false,
});

async function ensureSchema() {
  // Minimal schema needed for printing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT,
      printer_id TEXT,
      status TEXT DEFAULT 'queued',
      file_url TEXT,
      file_name TEXT,
      copies INT DEFAULT 1,
      pages INT DEFAULT 1,
      paper_size TEXT,
      color_type TEXT,
      source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      error TEXT,
      meta JSONB DEFAULT '{}'::jsonb
    );
  `);

  // Helpful indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_printer ON print_jobs(printer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);`);
}
ensureSchema().catch((e) => console.error("Schema ensure error:", e));

// ------------------- PRINTER AUTH (fixes 401) -------------------
function getIncomingKey(req) {
  const qKey = (req.query.key || "").toString().trim();
  const hKey =
    (req.headers["x-api-key"] || req.headers["x-printer-key"] || "")
      .toString()
      .trim();
  return qKey || hKey;
}

function requirePrinterKey(req, res, next) {
  // If no key set on server, don't block (but warn)
  if (!PRINTER_API_KEY) {
    console.warn("WARNING: PRINTER_API_KEY is not set on server env.");
    return next();
  }

  const incoming = getIncomingKey(req);
  if (!incoming || incoming !== PRINTER_API_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
      hint: "Provide key via ?key=... or header x-api-key",
    });
  }
  next();
}

// ------------------- MULTER -------------------
const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (_req, file, cb) {
    // Keep filename but make it safe + unique
    const safe = (file.originalname || "file")
      .replace(/[^\w.\- ]+/g, "")
      .replace(/\s+/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage });

// ------------------- ROUTES -------------------
app.get("/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, now: r.rows[0].now, baseUrl: BASE_URL });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Upload endpoint used by Shopify/web form
 * Expects multipart form-data:
 * - file: upload file
 * Optional fields:
 * - printerId, copies, pages, paper_size, color_type, source
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const printerId = (req.body.printerId || req.body.printer_id || "PP-USA-001").toString().trim();
    const copies = Math.max(1, parseInt(req.body.copies || "1", 10) || 1);
    const pages = Math.max(1, parseInt(req.body.pages || "1", 10) || 1);
    const paper_size = (req.body.paper_size || req.body.paperSize || null);
    const color_type = (req.body.color_type || req.body.colorType || "BW");

    // Build a URL the worker can download
    const fileUrl = `${BASE_URL.replace(/\/$/, "")}/uploads/${encodeURIComponent(req.file.filename)}`;

    const id_text = `print_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;

    const insert = await pool.query(
      `
      INSERT INTO print_jobs
        (id_text, printer_id, status, file_url, file_name, copies, pages, paper_size, color_type, source, meta)
      VALUES
        ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *;
      `,
      [
        id_text,
        printerId,
        fileUrl,
        req.file.originalname,
        copies,
        pages,
        paper_size,
        color_type,
        (req.body.source || "web").toString(),
        req.body.meta ? JSON.parse(req.body.meta) : {},
      ]
    );

    res.json({ ok: true, job: insert.rows[0] });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Printer poll endpoint (PROTECTED)
 * Worker calls:
 * GET /jobs?printerId=PP-USA-001&limit=5&key=ppk_...
 */
app.get("/jobs", requirePrinterKey, async (req, res) => {
  try {
    const printerId = (req.query.printerId || req.query.printer_id || "").toString().trim();
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "5", 10) || 5));

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    // Return queued jobs first (oldest first)
    const q = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued', 'printing')
      ORDER BY created_at ASC
      LIMIT $2;
      `,
      [printerId, limit]
    );

    res.json({ ok: true, jobs: q.rows });
  } catch (e) {
    console.error("JOBS ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Worker status update (PROTECTED)
 * POST /jobs/:id/status
 * Body: { status: "printing" | "done" | "error", error?: "...", details?: "..."}
 * Key via x-api-key or ?key
 */
app.post("/jobs/:id/status", requirePrinterKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid job id" });

    const status = (req.body.status || "").toString().trim();
    const error = req.body.error ? String(req.body.error) : null;

    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    const upd = await pool.query(
      `
      UPDATE print_jobs
      SET status = $1,
          error = $2,
          updated_at = NOW()
      WHERE id = $3
      RETURNING *;
      `,
      [status, error, id]
    );

    if (upd.rowCount === 0) return res.status(404).json({ ok: false, error: "Job not found" });

    res.json({ ok: true, job: upd.rows[0] });
  } catch (e) {
    console.error("STATUS UPDATE ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ------------------- START -------------------
app.listen(PORT, () => {
  console.log(`MSTAF CORE listening on :${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`Uploads: ${uploadsDir}`);
  if (!PRINTER_API_KEY) console.log("WARNING: PRINTER_API_KEY is empty (printer endpoints not protected).");
});
