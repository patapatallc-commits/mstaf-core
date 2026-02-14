require("dotenv").config();

const express = require("express");
const multer = require("multer");
const { Pool } = require("pg");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json());
app.use(cors());

// =========================
// DATABASE
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// =========================
// HEALTH CHECK
// =========================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// =========================
// FILE STORAGE
// =========================
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const unique = crypto.randomBytes(6).toString("hex");
    cb(null, unique + "-" + file.originalname);
  }
});

const upload = multer({ storage });

// Serve uploaded files
app.use("/uploads", express.static(uploadDir));

// =========================
// SAFE MIGRATION
// =========================
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT,
      printer_id TEXT,
      service_type TEXT,
      file_name TEXT,
      file_url TEXT,
      mime_type TEXT,
      paper_size TEXT,
      color_mode TEXT,
      pages INTEGER,
      copies INTEGER,
      instructions TEXT,
      status TEXT DEFAULT 'queued',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}
ensureTables();

// =========================
// UPLOAD ROUTE
// =========================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const {
      printerId,
      serviceType,
      paperSize,
      colorMode,
      pages,
      copies,
      instructions
    } = req.body;

    const jobId = "print_" + crypto.randomBytes(6).toString("hex");
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    let status = "queued";

    if (serviceType === "edit_image" || serviceType === "edit_video") {
      status = "awaiting_editor";
    }

    await pool.query(
      `
      INSERT INTO print_jobs
      (id_text, printer_id, service_type, file_name, file_url, mime_type,
       paper_size, color_mode, pages, copies, instructions, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `,
      [
        jobId,
        printerId || "PP-USA-001",
        serviceType || "print",
        req.file.originalname,
        fileUrl,
        req.file.mimetype,
        paperSize || "A4",
        colorMode || "bw",
        pages ? parseInt(pages) : null,
        copies ? parseInt(copies) : 1,
        instructions || null,
        status
      ]
    );

    console.log("UPLOAD SUCCESS:", jobId);

    res.json({
      success: true,
      jobId,
      status,
      serviceType,
      fileUrl
    });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// =========================
// PRINTER POLLING ROUTE
// =========================
app.get("/jobs", async (req, res) => {
  try {
    const printerId = req.query.printerId;
    const limit = parseInt(req.query.limit || "10", 10);

    if (!printerId) {
      return res.status(400).json({ error: "printerId required" });
    }

    const { rows } = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
        AND service_type = 'print'
        AND status IN ('queued','paid')
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [printerId, limit]
    );

    res.json(rows);
  } catch (err) {
    console.error("JOBS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch jobs" });
  }
});

// =========================
// UPDATE JOB STATUS
// =========================
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body;

    await pool.query(
      `UPDATE print_jobs SET status=$1 WHERE id_text=$2`,
      [status, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
