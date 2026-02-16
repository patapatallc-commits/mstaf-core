/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * - Health: GET /health
 * - Upload: POST /api/upload (multipart/form-data)
 * - Printer polling:
 *    - GET /jobs?printerId=PP-USA-001
 *    - GET /jobs/next?printerId=PP-USA-001
 * - Status update:
 *    - POST /jobs/:id/status
 *
 * Fix included:
 * ✅ Always writes id_text (UUID) so Postgres NOT NULL constraint never fails.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");

// Cloudinary optional (recommended for Render)
let cloudinary = null;
try {
  cloudinary = require("cloudinary").v2;
  // Support either CLOUDINARY_URL or the 3 var method
  if (process.env.CLOUDINARY_URL) {
    cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
  } else if (
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  } else {
    cloudinary = null;
  }
} catch (e) {
  cloudinary = null;
}

const app = express();

// For normal JSON routes
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS (open for your Shopify page)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Multer memory upload (then to Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// Printer routing
const PRINTER_DEFAULT = process.env.PRINTER_DEFAULT || "PP-USA-001";
const PRINTER_A3 = process.env.PRINTER_A3 || "PP-USA-A3-001";
const PRINTER_CARD = process.env.PRINTER_CARD || "PP-USA-CARD-001";

function pickPrinterId({ printer_id, paper_size, print_format }) {
  // If client sends printer_id already, respect it (unless empty)
  const incoming = (printer_id || "").trim();
  if (incoming) return incoming;

  const pf = (print_format || "").trim();
  const ps = (paper_size || "").trim();

  // Priority routing (Card > A3 > Default)
  if (pf.toLowerCase() === "card") return PRINTER_CARD;
  if (ps.toUpperCase() === "A3") return PRINTER_A3;
  return PRINTER_DEFAULT;
}

// Postgres
if (!process.env.DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL env var");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

// Ensure schema (safe + minimal; does not drop anything)
async function ensureSchema() {
  const client = await pool.connect();
  try {
    // Enable pgcrypto if possible (non-fatal if permissions block it)
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
    } catch (_) {}

    await client.query(`
      CREATE TABLE IF NOT EXISTS print_jobs (
        id BIGSERIAL PRIMARY KEY,
        id_text TEXT UNIQUE,
        printer_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        service_type TEXT NOT NULL DEFAULT 'Print',
        paper_size TEXT DEFAULT 'A4',
        color_mode TEXT DEFAULT 'bw',
        print_format TEXT DEFAULT 'Document',
        pages INT DEFAULT 1,
        copies INT DEFAULT 1,
        instructions TEXT,
        file_url TEXT,
        original_filename TEXT,
        mime_type TEXT,
        file_bytes BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        claimed_at TIMESTAMPTZ,
        claimed_by TEXT,
        error TEXT
      );
    `);

    // Make sure id_text exists + is not-null friendly
    // 1) fill nulls if any exist
    await client.query(`
      UPDATE print_jobs
      SET id_text = COALESCE(id_text, gen_random_uuid()::text)
      WHERE id_text IS NULL;
    `).catch(() => { /* ignore if gen_random_uuid not available */ });

    // 2) If gen_random_uuid isn't available, fallback update via app code (handled during inserts)
    // 3) Do not force NOT NULL here (your DB already has it). We simply guarantee insert always supplies it.
  } finally {
    client.release();
  }
}

// Cloudinary upload helper
async function uploadToCloudinary(buffer, filename, mimeType) {
  if (!cloudinary) {
    throw new Error(
      "Cloudinary is not configured. Set CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET."
    );
  }

  const base64 = buffer.toString("base64");
  const dataUri = `data:${mimeType};base64,${base64}`;

  const isVideo = (mimeType || "").startsWith("video/");
  const resource_type = isVideo ? "video" : "auto";

  const result = await cloudinary.uploader.upload(dataUri, {
    resource_type,
    folder: process.env.CLOUDINARY_FOLDER || "mstaf_uploads",
    public_id: `${Date.now()}_${(filename || "upload").replace(/\s+/g, "_")}`,
    overwrite: false,
  });

  return {
    url: result.secure_url || result.url,
    resource_type: result.resource_type,
  };
}

// Health
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).send("OK");
  } catch (e) {
    res.status(500).send("DB_ERROR");
  }
});

// Upload endpoint used by Shopify page
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    // File is required for Print; for editing you still accept file
    const f = req.file;
    if (!f) {
      return res.status(400).json({ ok: false, error: "No file uploaded (field name must be 'file')." });
    }

    // Fields (from Shopify widget)
    const paper_size = (req.body.paper_size || "A4").toString();
    const color_mode = (req.body.color_mode || "bw").toString();
    const print_format = (req.body.print_format || "Document").toString();
    const service_type = (req.body.service_type || "Print").toString();
    const pages = parseInt(req.body.pages || "1", 10) || 1;
    const copies = parseInt(req.body.copies || "1", 10) || 1;
    const instructions = (req.body.instructions || "").toString();
    const printer_id = pickPrinterId({
      printer_id: req.body.printer_id,
      paper_size,
      print_format,
    });

    // ✅ Always generate id_text so NOT NULL constraint never fails
    const id_text = crypto.randomUUID();

    // Upload file to Cloudinary (same idea as your earlier setup)
    const { url: file_url } = await uploadToCloudinary(f.buffer, f.originalname, f.mimetype);

    // Insert into DB
    const q = `
      INSERT INTO print_jobs (
        id_text, printer_id, status,
        service_type, paper_size, color_mode, print_format,
        pages, copies, instructions,
        file_url, original_filename, mime_type, file_bytes,
        created_at, updated_at
      )
      VALUES (
        $1, $2, 'queued',
        $3, $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12, $13,
        now(), now()
      )
      RETURNING *
    `;

    const params = [
      id_text,
      printer_id,
      service_type,
      paper_size,
      color_mode,
      print_format,
      pages,
      copies,
      instructions,
      file_url,
      f.originalname || null,
      f.mimetype || null,
      f.size || null,
    ];

    const result = await pool.query(q, params);
    const job = result.rows[0];

    return res.status(200).json({
      ok: true,
      job: {
        id: job.id,
        id_text: job.id_text,
        printer_id: job.printer_id,
        status: job.status,
        file_url: job.file_url,
        pages: job.pages,
        copies: job.copies,
        paper_size: job.paper_size,
        color_mode: job.color_mode,
        print_format: job.print_format,
        service_type: job.service_type,
      },
    });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    return res.status(500).json({ ok: false, error: e.message || "Upload failed" });
  }
});

// List queued jobs for a printer (worker can use this)
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || PRINTER_DEFAULT).toString();
    const limit = Math.min(parseInt(req.query.limit || "10", 10) || 10, 50);

    const q = `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued', 'processing')
      ORDER BY created_at ASC
      LIMIT $2
    `;
    const r = await pool.query(q, [printerId, limit]);
    res.json({ ok: true, jobs: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get next queued job & mark it processing (recommended for worker)
app.get("/jobs/next", async (req, res) => {
  const client = await pool.connect();
  try {
    const printerId = (req.query.printerId || PRINTER_DEFAULT).toString();
    const claimedBy = (req.query.claimedBy || req.headers["x-printer-id"] || "").toString() || null;

    await client.query("BEGIN");

    // Lock one queued job
    const pick = await client.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
        AND status = 'queued'
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
      `,
      [printerId]
    );

    if (pick.rows.length === 0) {
      await client.query("COMMIT");
      return res.json({ ok: true, job: null });
    }

    const job = pick.rows[0];

    const upd = await client.query(
      `
      UPDATE print_jobs
      SET status='processing',
          claimed_at=now(),
          claimed_by=$2,
          updated_at=now()
      WHERE id = $1
      RETURNING *
      `,
      [job.id, claimedBy]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, job: upd.rows[0] });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// Update job status (worker calls this)
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const id = req.params.id; // may be numeric id or id_text
    const status = (req.body.status || "").toString();
    const error = (req.body.error || "").toString();
    const claimedBy = (req.body.claimed_by || req.headers["x-printer-id"] || "").toString() || null;

    if (!status) {
      return res.status(400).json({ ok: false, error: "Missing status" });
    }

    const isNumeric = /^[0-9]+$/.test(id);

    const q = isNumeric
      ? `
        UPDATE print_jobs
        SET status=$2,
            error = NULLIF($3,''),
            claimed_by = COALESCE($4, claimed_by),
            updated_at=now()
        WHERE id=$1
        RETURNING *
      `
      : `
        UPDATE print_jobs
        SET status=$2,
            error = NULLIF($3,''),
            claimed_by = COALESCE($4, claimed_by),
            updated_at=now()
        WHERE id_text=$1
        RETURNING *
      `;

    const r = await pool.query(q, [id, status, error, claimedBy]);

    if (r.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Job not found" });
    }

    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Start
const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ MSTAF Core listening on ${PORT}`);
      console.log(`✅ Health: /health`);
      console.log(`✅ Upload: POST /api/upload`);
      console.log(`✅ Next job: GET /jobs/next?printerId=${PRINTER_DEFAULT}`);
    });
  })
  .catch((e) => {
    console.error("❌ Schema init failed:", e);
    process.exit(1);
  });
