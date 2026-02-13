/**
 * MSTAF CORE - Stable Print-O-Matic Server
 * - /health
 * - /api/upload
 * - /jobs
 * - /jobs/:id/status
 * - Serves /uploads publicly
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

// =============================
// Ensure uploads folder exists
// =============================
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ✅ THIS FIXES YOUR 404 DOWNLOAD ISSUE
app.use("/uploads", express.static(UPLOAD_DIR));

// =============================
// Postgres
// =============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false"
    ? false
    : { rejectUnauthorized: false },
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT UNIQUE,
      printer_id TEXT,
      from_phone TEXT,
      file_url TEXT,
      file_name TEXT,
      mime_type TEXT,
      status TEXT DEFAULT 'queued',
      copies INTEGER DEFAULT 1,
      paper_size TEXT DEFAULT 'A4',
      color_type TEXT DEFAULT 'BW',
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

ensureSchema().catch(console.error);

// =============================
// Health
// =============================
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      db: true,
      now: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// =============================
// Upload
// =============================
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + "_" + file.originalname;
    cb(null, unique);
  },
});

const upload = multer({ storage });

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const idText = "print_" + crypto.randomBytes(8).toString("hex");

    const fileUrl =
      `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    await pool.query(
      `
      INSERT INTO print_jobs
      (id_text, printer_id, from_phone, file_url, file_name, mime_type, status, copies)
      VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)
      `,
      [
        idText,
        req.body.printerId || "PP-USA-001",
        req.body.phone || "",
        fileUrl,
        req.file.originalname,
        req.file.mimetype,
        req.body.copies || 1,
      ]
    );

    res.json({ ok: true, jobId: idText, file_url: fileUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Upload failed" });
  }
});

// =============================
// Jobs polling
// =============================
app.get("/jobs", async (req, res) => {
  try {
    const printerId = req.query.printerId;
    if (!printerId)
      return res.status(400).json({ error: "Missing printerId" });

    const r = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued','paid')
      ORDER BY created_at ASC
      `,
      [printerId]
    );

    res.json(r.rows);
  } catch (e) {
    console.error("GET /jobs error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// =============================
// Status update
// =============================
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const id = req.params.id;
    const { status, note } = req.body;

    await pool.query(
      `
      UPDATE print_jobs
      SET status=$1, note=$2, updated_at=NOW()
      WHERE id_text=$3
      `,
      [status, note || "", id]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("Status update error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// =============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 MSTAF CORE running on port", PORT)
);

