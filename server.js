/**
 * MSTAF CORE - Production Stable Version
 * - Fixes Shopify upload CORS
 * - Accepts any multipart file field
 * - Secure printer polling (header or ?key=)
 * - Safe auto DB migrations
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
// CORS FIX (Shopify → Render)
// =======================
const ALLOWED_ORIGINS = new Set([
  "https://patapata.us",
  "https://www.patapata.us",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, x-printer-key"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

// =======================
// CONFIG
// =======================
const PORT = process.env.PORT || 10000;
const PRINTER_KEY = (process.env.PRINTER_KEY || "").trim();
const ONLY_PRINT_PAID =
  String(process.env.ONLY_PRINT_PAID || "false").toLowerCase() === "true";

// =======================
// DATABASE
// =======================
if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

// =======================
// UPLOAD STORAGE
// =======================
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use("/uploads", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({ storage });

// =======================
// SAFE AUTO MIGRATION
// =======================
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY
    );
  `);

  const columns = [
    "id_text TEXT",
    "printer_id TEXT",
    "service_type TEXT",
    "file_name TEXT",
    "file_url TEXT",
    "mime_type TEXT",
    "paper_size TEXT",
    "color_mode TEXT",
    "pages INTEGER",
    "copies INTEGER",
    "instructions TEXT",
    "status TEXT",
    "is_paid BOOLEAN",
    "created_at TIMESTAMP DEFAULT NOW()",
  ];

  for (const col of columns) {
    await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS ${col};`);
  }

  await pool.query(`ALTER TABLE print_jobs ALTER COLUMN copies SET DEFAULT 1;`);
  await pool.query(`ALTER TABLE print_jobs ALTER COLUMN status SET DEFAULT 'queued';`);
  await pool.query(`ALTER TABLE print_jobs ALTER COLUMN is_paid SET DEFAULT FALSE;`);

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

  await pool.query(`ALTER TABLE print_jobs DROP COLUMN IF EXISTS job_id;`);

  console.log("DB migration complete");
}

// =======================
// SECURITY
// =======================
function requirePrinterKey(req, res, next) {
  if (!PRINTER_KEY) return next();

  const headerKey = (req.headers["x-printer-key"] || "").trim();
  const queryKey = (req.query.key || "").trim();
  const provided = headerKey || queryKey;

  if (!provided || provided !== PRINTER_KEY) {
    return res.status(401).json({ ok: false, error: "Invalid printer key" });
  }

  next();
}

// =======================
// HELPERS
// =======================
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
  await pool.query("SELECT 1");
  res.json({ ok: true, db: "ok" });
});

// ===== FIXED UPLOAD ROUTE =====
app.post("/api/upload", upload.any(), async (req, res) => {
  try {
    console.log("UPLOAD HIT:", {
      origin: req.headers.origin,
      contentType: req.headers["content-type"],
      files: (req.files || []).length,
    });

    const f = req.files && req.files[0] ? req.files[0] : null;

    if (!f) {
      return res.status(400).json({
        ok: false,
        error: "No file received."
      });
    }

    const printerId = req.body.printerId || "PP-USA-001";
    const serviceType = normalizeServiceType(req.body.serviceType);

    const idText = makeJobId();
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${f.filename}`;

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
        status,
        is_paid
      )
      VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)
      `,
      [
        idText,
        printerId,
        serviceType,
        f.originalname,
        fileUrl,
        f.mimetype,
        isPaid,
      ]
    );

    res.json({ ok: true, id_text: idText });

  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// PRINTER POLLING
// =======================
app.get("/jobs", requirePrinterKey, async (req, res) => {
  const printerId = req.query.printerId;
  const { rows } = await pool.query(
    `
    SELECT *
    FROM print_jobs
    WHERE printer_id = $1
      AND status IN ('queued','paid')
    ORDER BY created_at ASC
    `,
    [printerId]
  );
  res.json(rows);
});

// =======================
// START SERVER
// =======================
ensureTables()
  .then(() => {
    console.log("Server ready");
    app.listen(PORT, () =>
      console.log("Listening on port", PORT)
    );
  })
  .catch((err) => {
    console.error("DB init failed", err);
    process.exit(1);
  });
