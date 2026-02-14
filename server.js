require("dotenv").config();

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const { Pool } = require("pg");
const cloudinary = require("cloudinary").v2;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// Cloudinary config
// =========================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const CLOUDINARY_FOLDER = (process.env.CLOUDINARY_FOLDER || "printomatic").trim();

// =========================
// DB
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// =========================
// Multer (memory) — no local disk
// =========================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB (adjust if you want)
});

// =========================
// Helpers
// =========================
function makeJobId() {
  return `print_${crypto.randomBytes(8).toString("hex")}`;
}

function cloudinaryUploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}

// =========================
// Health
// =========================
app.get("/health", (req, res) => res.json({ ok: true }));

// =========================
// Upload endpoint (Shopify / web)
// POST /api/upload  multipart/form-data  file=<...>
// =========================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printer_id || "PP-USA-001").trim();

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    // Create job id
    const jobId = makeJobId();

    // Upload to Cloudinary
    const original = req.file.originalname || "upload";
    const ext = path.extname(original).toLowerCase();
    const base = path.basename(original, ext);

    // Cloudinary resource_type:
    // - images: resource_type "image"
    // - pdf/doc/etc: resource_type "raw" is safest
    const isImage = (req.file.mimetype || "").startsWith("image/");
    const resourceType = isImage ? "image" : "raw";

    const publicId = `${CLOUDINARY_FOLDER}/${jobId}_${base}`.replace(/[^\w\-\/]/g, "_");

    const result = await cloudinaryUploadBuffer(req.file.buffer, {
      resource_type: resourceType,
      public_id: publicId,
      overwrite: true,
    });

    // Permanent HTTPS URL for worker download
    const fileUrl = result.secure_url;

    // Insert into DB (only after we have a real URL)
    await pool.query(
      `
      INSERT INTO print_jobs (
        id_text,
        printer_id,
        file_name,
        mime_type,
        file_url,
        status,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,'queued',NOW())
      `,
      [jobId, printerId, original, req.file.mimetype, fileUrl]
    );

    return res.json({
      ok: true,
      job_id: jobId,
      file_url: fileUrl,
      printer_id: printerId,
      status: "queued",
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

// =========================
// Jobs for worker
// =========================
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "").trim();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "5", 10), 50));

    const q = `
      SELECT id_text, printer_id, file_url, file_name, mime_type, status, created_at
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('paid','queued')
        AND file_url IS NOT NULL
        AND file_url <> ''
      ORDER BY created_at ASC
      LIMIT $2
    `;

    const { rows } = await pool.query(q, [printerId, limit]);

    return res.json({
      ok: true,
      printer_id: printerId,
      count: rows.length,
      jobs: rows,
    });
  } catch (err) {
    console.error("JOBS ERROR:", err);
    return res.status(500).json({ ok: false });
  }
});

// =========================
// Status update from worker
// =========================
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const idText = req.params.id;
    const status = (req.body.status || "").trim();
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    await pool.query(
      `UPDATE print_jobs SET status=$1, updated_at=NOW() WHERE id_text=$2`,
      [status, idText]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("STATUS ERROR:", err);
    return res.status(500).json({ ok: false });
  }
});

// =========================
// Debug
// =========================
app.get("/debug/jobs", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id_text, printer_id, status, file_url, file_name, mime_type, created_at, updated_at
     FROM print_jobs
     ORDER BY created_at DESC
     LIMIT 50`
  );
  res.json({ ok: true, count: rows.length, jobs: rows });
});

// =========================
// Start
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("MSTAF CORE RUNNING ON PORT", PORT));

