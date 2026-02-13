/**
 * MSTAF CORE - COMPLETE STABLE SERVER
 * Print-O-Matic Production Build
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// DATABASE
// ===============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ===============================
// AUTO CREATE TABLE IF NOT EXISTS
// ===============================
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT UNIQUE NOT NULL,
      printer_id TEXT NOT NULL,
      file_url TEXT NOT NULL,
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
ensureTables();

// ===============================
// HEALTH
// ===============================
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      db: true,
      now: new Date().toISOString(),
      base_url: process.env.RENDER_EXTERNAL_URL || "https://mstaf-core.onrender.com",
    });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// ===============================
// FILE STORAGE (TEMP MEMORY)
// ===============================
const upload = multer({ storage: multer.memoryStorage() });

// ===============================
// UPLOAD ROUTE
// ===============================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const printerId = req.body.printerId || "PP-USA-001";
    const copies = parseInt(req.body.copies || "1", 10);
    const paperSize = req.body.paperSize || "A4";
    const colorType = req.body.colorType || "BW";

    const jobId = "print_" + crypto.randomBytes(8).toString("hex");

    // In production you would upload to cloud storage.
    // For now we simulate a public file URL endpoint.
    const fileUrl = `${process.env.RENDER_EXTERNAL_URL || "https://mstaf-core.onrender.com"}/download/${jobId}`;

    await pool.query(
      `
      INSERT INTO print_jobs
      (id_text, printer_id, file_url, file_name, mime_type, copies, paper_size, color_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        jobId,
        printerId,
        fileUrl,
        req.file.originalname,
        req.file.mimetype,
        copies,
        paperSize,
        colorType,
      ]
    );

    res.json({ success: true, jobId });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ===============================
// FAKE DOWNLOAD ENDPOINT (TEMP)
// ===============================
app.get("/download/:id", (req, res) => {
  res.status(404).send("File storage not yet configured.");
});

// ===============================
// AGENT POLL ROUTE
// ===============================
app.get("/jobs", async (req, res) => {
  try {
    const printerId = req.query.printerId;
    if (!printerId) return res.status(400).json({ error: "Missing printerId" });

    const result = await pool.query(
      `
      SELECT id_text, printer_id, file_url, file_name,
             mime_type, status, copies, paper_size, color_type
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued','paid')
      ORDER BY created_at ASC
      LIMIT 5
      `,
      [printerId]
    );

    res.json(result.rows);
  } catch (e) {
    console.error("GET JOBS ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// ===============================
// AGENT STATUS UPDATE
// ===============================
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const jobId = req.params.id;
    const { status, note } = req.body;

    if (!status) return res.status(400).json({ error: "Missing status" });

    const result = await pool.query(
      `
      UPDATE print_jobs
      SET status = $1,
          note = $2,
          updated_at = NOW()
      WHERE id_text = $3
      RETURNING id_text, status
      `,
      [status, note || "", jobId]
    );

    if (result.rowCount === 0)
      return res.status(404).json({ error: "Job not found" });

    res.json({ success: true });
  } catch (e) {
    console.error("STATUS UPDATE ERROR:", e);
    res.status(500).json({ error: "Server error" });
  }
});

// ===============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("MSTAF CORE RUNNING ON PORT", PORT);
});

