/**
 * MSTAF CORE - Stable Print-O-Matic Server
 * - Upload -> print_jobs
 * - Printer polling -> GET /jobs
 * - Health check
 * - Safe string job IDs (id_text)
 */

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ==============================
// DATABASE
// ==============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ==============================
// BASIC HEALTH CHECK
// ==============================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ==============================
// FILE UPLOAD CONFIG
// ==============================
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + "-" + file.originalname);
  },
});

const upload = multer({ storage });

// Ensure uploads folder exists
const fs = require("fs");
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// ==============================
// UPLOAD ROUTE
// ==============================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = req.body.printerId || "PP-USA-001";

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const jobId = `print_${crypto.randomBytes(8).toString("hex")}`;

    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    await pool.query(
      `
      INSERT INTO print_jobs (
        id_text,
        printer_id,
        file_name,
        mime_type,
        file_url,
        status
      )
      VALUES ($1,$2,$3,$4,$5,'paid')
      `,
      [
        jobId,
        printerId,
        req.file.originalname,
        req.file.mimetype,
        fileUrl,
      ]
    );

    res.json({
      success: true,
      jobId,
      message: "Uploaded successfully",
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ==============================
// SERVE UPLOADED FILES
// ==============================
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ==============================
// PRINTER POLLING ENDPOINT
// ==============================
app.get("/jobs", async (req, res) => {
  try {
    const { printerId, limit = 5 } = req.query;

    if (!printerId) {
      return res.status(400).json({ error: "printerId required" });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
        AND status = 'paid'
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [printerId, limit]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("JOBS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch jobs" });
  }
});

// ==============================
// UPDATE JOB STATUS
// ==============================
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    await pool.query(
      `
      UPDATE print_jobs
      SET status = $1
      WHERE id_text = $2
      `,
      [status, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// ==============================
// START SERVER
// ==============================
app.listen(PORT, () => {
  console.log(`MSTAF CORE running on port ${PORT}`);
});
