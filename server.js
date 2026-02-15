/**
 * MSTAF CORE - Stable Print-O-Matic Server (Render)
 * Fully fixed:
 * - Correct INSERT column/value count
 * - Public /uploads static route
 * - Worker polling
 * - Status updates
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

const WORKER_KEY =
  process.env.WORKER_KEY || "ppk_7mQ9vK2xR8sN1zT4pL6aJ0";

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  "https://mstaf-core-1.onrender.com";

const DEFAULT_PRINTER_ID =
  process.env.DEFAULT_PRINTER_ID || "PP-USA-001";

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

// ==================== UPLOADS ====================
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.use("/uploads", express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({ storage });

// ==================== DATABASE ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==================== UTIL ====================
function makeIdText() {
  return crypto.randomBytes(12).toString("hex");
}

function requireWorkerKey(req, res, next) {
  const key = req.query.key;
  if (key !== WORKER_KEY) {
    return res.status(401).json({ ok: false, error: "Invalid worker key" });
  }
  next();
}

// ==================== ROUTES ====================

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ==================== UPLOAD ====================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const printer_id =
      req.body.printer_id || DEFAULT_PRINTER_ID;

    const pages = parseInt(req.body.pages || 1);
    const copies = parseInt(req.body.copies || 1);
    const color =
      req.body.color === "true" ||
      req.body.color === true;

    const color_type =
      req.body.color_type || (color ? "COLOR" : "BW");

    const paper_size =
      req.body.paper_size || "A4";

    const service_type =
      req.body.service_type || "print";

    const instructions =
      req.body.instructions || null;

    const note = req.body.note || null;

    const paid =
      req.body.paid === "true" ||
      req.body.paid === true;

    const is_paid =
      req.body.is_paid === "true" ||
      req.body.is_paid === true ||
      paid;

    const file_name = req.file.filename;
    const mime_type = req.file.mimetype;

    const file_url =
      `${PUBLIC_BASE_URL}/uploads/${encodeURIComponent(file_name)}`;

    const id_text = makeIdText();

    const meta = {
      original_name: req.file.originalname,
      size: req.file.size,
    };

    const result = await pool.query(
      `
      INSERT INTO print_jobs
      (
        id_text,
        printer_id,
        status,
        file_name,
        mime_type,
        file_url,
        pages,
        copies,
        color,
        color_type,
        paper_size,
        source,
        service_type,
        instructions,
        note,
        paid,
        is_paid,
        meta
      )
      VALUES
      (
        $1,$2,'queued',$3,$4,$5,
        $6,$7,$8,$9,$10,
        'mstaf',$11,$12,$13,
        $14,$15,$16
      )
      RETURNING id, status, file_url;
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

    res.json({ ok: true, job: result.rows[0] });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// ==================== WORKER POLL ====================
app.get("/jobs", requireWorkerKey, async (req, res) => {
  try {
    const printerId = req.query.printerId;

    const jobs = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
      AND status IN ('queued','paid','authorized_awaiting_file')
      ORDER BY created_at ASC
      LIMIT 5;
      `,
      [printerId]
    );

    res.json({ ok: true, jobs: jobs.rows });
  } catch (err) {
    console.error("JOB FETCH ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

// ==================== STATUS UPDATE ====================
app.post("/jobs/:id/status", requireWorkerKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const status = req.body.status;
    const printed_text = req.body.printed_text || null;
    const error = req.body.error || null;
    const details = req.body.details || null;

    const upd = await pool.query(
      `
      UPDATE print_jobs
      SET status = $2,
          printed_text = COALESCE($3, printed_text),
          error = COALESCE($4, error),
          details = COALESCE($5, details),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, status;
      `,
      [id, status, printed_text, error, details]
    );

    res.json({ ok: true, job: upd.rows[0] });
  } catch (err) {
    console.error("STATUS ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log("MSTAF CORE running on port", PORT);
});
