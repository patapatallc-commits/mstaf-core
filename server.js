/**
 * MSTAF CORE - Print-O-Matic Stable Server
 * - Upload endpoint
 * - Jobs polling
 * - Update job status
 * - TEMP debug route to mark job as paid
 */

require("dotenv").config();

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ======================
// DATABASE
// ======================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ======================
// FILE STORAGE
// ======================

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(6).toString("hex");
    cb(null, unique + "_" + file.originalname);
  },
});

const upload = multer({ storage });

// ======================
// HEALTH CHECK
// ======================

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ======================
// UPLOAD ROUTE
// ======================

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const jobId = `print_${crypto.randomBytes(8).toString("hex")}`;

    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    await pool.query(
      `
      INSERT INTO print_jobs (
        id_text,
        printer_id,
        from_phone,
        file_name,
        mime_type,
        file_url,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,'queued')
      `,
      [
        jobId,
        "PP-USA-001",
        req.body.phone || "",
        req.file.originalname,
        req.file.mimetype,
        fileUrl,
      ]
    );

    res.json({
      success: true,
      status: "queued",
      jobId,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ======================
// GET JOBS FOR PRINTER
// ======================

app.get("/jobs", async (req, res) => {
  try {
    const printerId = req.query.printerId;

    const { rows } = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
      AND status = 'paid'
      ORDER BY created_at ASC
      LIMIT 5
      `,
      [printerId]
    );

    res.json(rows);
  } catch (err) {
    console.error("JOBS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch jobs" });
  }
});

// ======================
// UPDATE JOB STATUS
// ======================

app.post("/jobs/:id/status", async (req, res) => {
  try {
    const id = req.params.id;
    const status = req.body.status;

    await pool.query(
      "UPDATE print_jobs SET status = $1 WHERE id_text = $2",
      [status, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// ======================
// TEMP DEBUG ROUTE
// ======================
// Use only for testing

app.get("/debug/mark-paid/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const result = await pool.query(
      "UPDATE print_jobs SET status = 'paid' WHERE id_text = $1 RETURNING *",
      [id]
    );

    if (result.rowCount === 0) {
      return res.json({ success: false, message: "Job not found" });
    }

    res.json({
      success: true,
      message: "Job marked as paid",
      job: result.rows[0],
    });
  } catch (err) {
    console.error("DEBUG MARK PAID ERROR:", err);
    res.status(500).json({ error: "Failed to mark paid" });
  }
});

// ======================
// STATIC FILE SERVING
// ======================

app.use("/uploads", express.static(uploadDir));

// ======================
// START SERVER
// ======================

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`MSTAF Core running on port ${PORT}`);
});
