require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔥 VERY IMPORTANT — SERVE UPLOADS PUBLICLY
app.use("/uploads", express.static("uploads"));

// ================= DB =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= STORAGE =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads");
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "_" + crypto.randomBytes(6).toString("hex");
    cb(null, unique + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

// ================= HEALTH =================
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ================= UPLOAD =================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = req.body.printer_id || "PP-USA-001";

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const jobId = "print_" + crypto.randomBytes(8).toString("hex");

    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

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
      [
        jobId,
        printerId,
        req.file.originalname,
        req.file.mimetype,
        fileUrl,
      ]
    );

    res.json({ ok: true, job_id: jobId, file_url: fileUrl });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

// ================= GET JOBS (FOR WORKER) =================
app.get("/jobs", async (req, res) => {
  try {
    const printerId = req.query.printerId;
    const limit = parseInt(req.query.limit || "5", 10);

    const q = `
      SELECT id_text, printer_id, file_url, file_name, mime_type, status, created_at
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued','paid')
        AND file_url IS NOT NULL
        AND file_url <> ''
      ORDER BY created_at ASC
      LIMIT $2
    `;

    const { rows } = await pool.query(q, [printerId, limit]);

    res.json({
      ok: true,
      printer_id: printerId,
      count: rows.length,
      jobs: rows,
    });

  } catch (err) {
    console.error("JOBS ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

// ================= UPDATE STATUS =================
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const idText = req.params.id;
    const { status } = req.body;

    await pool.query(
      `UPDATE print_jobs SET status=$1, updated_at=NOW() WHERE id_text=$2`,
      [status, idText]
    );

    res.json({ ok: true });

  } catch (err) {
    console.error("STATUS ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

// ================= DEBUG =================
app.get("/debug/jobs", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT 20`
  );
  res.json({ ok: true, count: rows.length, jobs: rows });
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("MSTAF CORE RUNNING ON PORT", PORT);
});

