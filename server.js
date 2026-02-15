/**
 * MSTAF CORE - Print-O-Matic Server (Render)
 * Fixes included:
 *  ✅ Worker auth: accepts WORKER_KEY OR PRINTER_KEY (fixes 401 Invalid worker key)
 *  ✅ /jobs only returns printable jobs (queued/paid + is_paid=true + file_url not null)
 *  ✅ Robust DB insert with fallback SQL variants (prevents "INSERT has more expressions than target columns")
 *  ✅ Serves /uploads as static for worker downloads
 *  ✅ Optional Cloudinary support (if CLOUDINARY_URL is set)
 */

"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Pool } = require("pg");

// Optional (only used if CLOUDINARY_URL is set)
let cloudinary = null;
try {
  cloudinary = require("cloudinary").v2;
} catch (_) {}

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------- ENV --------------------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

// Accept either env var (backward compatible)
const WORKER_KEY =
  process.env.WORKER_KEY ||
  process.env.PRINTER_KEY ||
  "ppk_7mQ9vK2xR8sN1zT4pL6aJ0";

const ADMIN_KEY =
  process.env.MSTAF_ADMIN_KEY ||
  process.env.ADMIN_KEY ||
  "";

// Optional Cloudinary
const CLOUDINARY_URL = process.env.CLOUDINARY_URL || "";
if (CLOUDINARY_URL && cloudinary) {
  cloudinary.config({ cloudinary_url: CLOUDINARY_URL });
}

// -------------------- DB --------------------
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing in environment variables.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes("render.com")
    ? { rejectUnauthorized: false }
    : undefined,
});

// -------------------- UPLOADS (LOCAL) --------------------
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Serve uploads publicly
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "1h" }));

// Multer storage
const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (_req, file, cb) {
    const safeOriginal = (file.originalname || "file")
      .replace(/[^\w.\-]+/g, "_");
    const stamp = Date.now();
    cb(null, `${stamp}_${safeOriginal}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// -------------------- HELPERS --------------------
function nowIso() {
  return new Date().toISOString();
}

function publicUploadUrl(req, filename) {
  // Always use Render public URL if available, else build from request
  const base =
    process.env.PUBLIC_BASE_URL ||
    `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/${filename}`;
}

function toBoolColor(value) {
  // Frontend may send "COLOR"/"BW" or true/false
  if (typeof value === "boolean") return value;
  const v = String(value || "").toLowerCase();
  if (v.includes("color") && !v.includes("b")) return true;
  if (v === "true" || v === "1") return true;
  return false;
}

function normalizeColorType(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  // keep "B/W" as-is if sent
  if (v.toLowerCase().includes("bw") || v.toLowerCase().includes("b/w")) return "B/W";
  if (v.toLowerCase().includes("black")) return "B/W";
  if (v.toLowerCase().includes("color")) return "COLOR";
  return v;
}

function verifyWorker(req, res, next) {
  const key =
    req.query.key ||
    req.headers["x-worker-key"] ||
    req.headers["x-printer-key"] ||
    req.body?.key;

  if (!key || key !== WORKER_KEY) {
    return res.status(401).json({ ok: false, error: "Invalid worker key" });
  }
  next();
}

function verifyAdmin(req, res, next) {
  if (!ADMIN_KEY) return res.status(403).json({ ok: false, error: "Admin key not configured" });
  const key =
    req.query.adminKey ||
    req.headers["x-admin-key"] ||
    req.body?.adminKey;
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Invalid admin key" });
  }
  next();
}

// Robust insert with fallback variants to avoid schema mismatch errors.
async function insertPrintJob(job) {
  // job fields we may have
  const {
    printer_id,
    status,
    pages,
    copies,
    color,
    color_type,
    paper_size,
    service_type,
    instructions,
    from_phone,
    file_name,
    mime_type,
    file_url,
    is_paid,
    paid,
    meta,
  } = job;

  const candidates = [
    {
      name: "wide_insert",
      sql: `
        INSERT INTO print_jobs
          (printer_id, status, pages, copies, color, color_type, paper_size, service_type,
           instructions, from_phone, file_name, mime_type, file_url, is_paid, paid, meta, created_at, updated_at)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())
        RETURNING *;
      `,
      params: [
        printer_id, status, pages, copies, color, color_type, paper_size, service_type,
        instructions, from_phone, file_name, mime_type, file_url, is_paid, paid, meta,
      ],
    },
    {
      name: "medium_insert",
      sql: `
        INSERT INTO print_jobs
          (printer_id, status, pages, copies, color, paper_size, service_type,
           instructions, file_name, mime_type, file_url, is_paid, paid, created_at, updated_at)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
        RETURNING *;
      `,
      params: [
        printer_id, status, pages, copies, color, paper_size, service_type,
        instructions, file_name, mime_type, file_url, is_paid, paid,
      ],
    },
    {
      name: "minimal_insert",
      sql: `
        INSERT INTO print_jobs
          (printer_id, status, pages, copies, file_name, mime_type, file_url, is_paid, created_at, updated_at)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
        RETURNING *;
      `,
      params: [
        printer_id, status, pages, copies, file_name, mime_type, file_url, is_paid,
      ],
    },
  ];

  let lastErr = null;
  for (const c of candidates) {
    try {
      const r = await pool.query(c.sql, c.params);
      return r.rows[0];
    } catch (err) {
      lastErr = err;
      console.error(`INSERT failed (${c.name}):`, err.message);
    }
  }
  throw lastErr || new Error("Insert failed");
}

// -------------------- ROUTES --------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: nowIso() });
});

// Admin: quick status peek
app.get("/admin/jobs/recent", verifyAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    const r = await pool.query(
      `SELECT id, printer_id, status, file_name, file_url, is_paid, paid, created_at, updated_at
       FROM print_jobs
       ORDER BY id DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, jobs: r.rows });
  } catch (e) {
    console.error("admin recent jobs error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Upload endpoint used by Shopify page:
 * POST /api/upload (multipart/form-data)
 * fields (optional): printerId, pages, copies, color_mode/color, color_type, paper_size, service_type, instructions, from_phone
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const printerId = (req.body.printerId || req.body.printer_id || "PP-USA-001").toString().trim();
    const pages = Math.max(1, Number(req.body.pages || 1));
    const copies = Math.max(1, Number(req.body.copies || 1));

    const color = toBoolColor(req.body.color || req.body.color_mode || req.body.colorMode);
    const colorType = normalizeColorType(req.body.color_type || req.body.colorType || (color ? "COLOR" : "B/W"));
    const paperSize = (req.body.paper_size || req.body.paperSize || "A4").toString().trim();
    const serviceType = (req.body.service_type || req.body.serviceType || "print").toString().trim();
    const instructions = (req.body.instructions || "").toString().trim();
    const fromPhone = (req.body.from_phone || req.body.phone || null);

    // Upload to Cloudinary if configured, else serve from /uploads
    let fileUrl = null;

    if (CLOUDINARY_URL && cloudinary) {
      const uploadRes = await cloudinary.uploader.upload(file.path, {
        resource_type: "auto",
        folder: "mstaf_uploads",
        public_id: `${Date.now()}_${path.parse(file.filename).name}`,
      });
      fileUrl = uploadRes.secure_url;
      // Remove local file to save disk
      try { fs.unlinkSync(file.path); } catch (_) {}
    } else {
      fileUrl = publicUploadUrl(req, file.filename);
    }

    // IMPORTANT: Shopify uploads should be treated as paid/ready
    const job = await insertPrintJob({
      printer_id: printerId,
      status: "queued",
      pages,
      copies,
      color,
      color_type: colorType,
      paper_size: paperSize,
      service_type: serviceType,
      instructions,
      from_phone: fromPhone,
      file_name: file.originalname || file.filename,
      mime_type: file.mimetype || null,
      file_url: fileUrl,
      is_paid: true,
      paid: true,
      meta: JSON.stringify({
        source: "shopify",
        uploaded_at: nowIso(),
      }),
    });

    return res.json({ ok: true, job });
  } catch (err) {
    console.error("POST /api/upload error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
});

/**
 * Worker polling:
 * GET /jobs?printerId=PP-USA-001&limit=5&key=...
 * Returns ONLY printable jobs (queued/paid, paid=true, file_url not null).
 */
app.get("/jobs", verifyWorker, async (req, res) => {
  try {
    const printerId = (req.query.printerId || req.query.printer_id || "").toString().trim();
    const limit = Math.max(1, Math.min(20, Number(req.query.limit || 5)));

    if (!printerId) {
      return res.status(400).json({ ok: false, error: "Missing printerId" });
    }

    // Only printable jobs:
    // - status queued or paid
    // - is_paid true (or paid true fallback)
    // - file_url exists
    const r = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued','paid')
        AND file_url IS NOT NULL
        AND (
          is_paid = true OR paid = true
        )
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [printerId, limit]
    );

    return res.json({ ok: true, jobs: r.rows });
  } catch (err) {
    console.error("GET /jobs error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Worker status update:
 * POST /jobs/:id/status?key=...
 * body: { status, printed_text?, error?, details? }
 */
app.post("/jobs/:id/status", verifyWorker, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = (req.body.status || "").toString().trim();
    const printed_text = req.body.printed_text ?? null;
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
  } catch (err) {
    console.error("POST /jobs/:id/status error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// -------------------- START --------------------
app.listen(PORT, () => {
  console.log(`✅ MSTAF CORE listening on port ${PORT}`);
  console.log(`✅ WORKER_KEY auth enabled (WORKER_KEY or PRINTER_KEY).`);
  console.log(`✅ /uploads served from ${UPLOAD_DIR}`);
});
