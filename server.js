require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

// =====================
// CONFIG
// =====================

const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// =====================
// MIDDLEWARE
// =====================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔥 CORS FIX FOR SHOPIFY
app.use(cors({
  origin: [
    "https://patapata.us",
    "https://www.patapata.us"
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// =====================
// HEALTH CHECK
// =====================

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================
// UPLOAD ROUTE
// =====================

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const { printerId, from } = req.body;
    if (!printerId) {
      return res.status(400).json({ ok: false, error: "Missing printerId" });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Missing file" });
    }

    const idText = "print_" + Date.now().toString(36);
    const fileUrl = `https://mstaf-core-1.onrender.com/uploads/${req.file.originalname}`;

    await pool.query(
      `
      INSERT INTO print_jobs
      (id_text, printer_id, from_phone, file_name, mime_type, file_url, status)
      VALUES ($1,$2,$3,$4,$5,$6,'queued')
      `,
      [
        idText,
        printerId,
        from || null,
        req.file.originalname,
        req.file.mimetype,
        fileUrl
      ]
    );

    res.json({
      ok: true,
      message: "Queued print job",
      job: {
        id_text: idText,
        job_id: idText,
        printerId,
        status: "queued",
        file_url: fileUrl
      }
    });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================
// CLAIM NEXT JOB
// =====================

app.get("/jobs/next", async (req, res) => {
  try {
    const { printerId } = req.query;
    if (!printerId) {
      return res.status(400).json({ ok: false, error: "Missing printerId" });
    }

    const result = await pool.query(
      `
      UPDATE print_jobs
      SET status = 'printing'
      WHERE id = (
        SELECT id
        FROM print_jobs
        WHERE printer_id = $1
          AND status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
      `,
      [printerId]
    );

    if (result.rowCount === 0) {
      return res.json({ ok: true, job: null });
    }

    const job = result.rows[0];

    res.json({
      ok: true,
      job: {
        id_text: job.id_text,
        job_id: job.id_text,
        printer_id: job.printer_id,
        file_url: job.file_url,
        status: job.status
      }
    });

  } catch (err) {
    console.error("JOBS NEXT ERROR:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================
// UPDATE STATUS
// =====================

app.post("/jobs/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, details } = req.body;

    await pool.query(
      `
      UPDATE print_jobs
      SET status=$1, details=$2, updated_at=NOW()
      WHERE id_text=$3
      `,
      [status, details || null, id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================
// LIST JOBS
// =====================

app.get("/jobs", async (req, res) => {
  try {
    const { printerId } = req.query;
    const result = await pool.query(
      `
      SELECT * FROM print_jobs
      WHERE printer_id=$1
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [printerId]
    );

    res.json({ ok: true, jobs: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================
// JOB COUNTS
// =====================

app.get("/jobs/count", async (req, res) => {
  try {
    const { printerId } = req.query;

    const result = await pool.query(
      `
      SELECT status, COUNT(*) 
      FROM print_jobs
      WHERE printer_id=$1
      GROUP BY status
      `,
      [printerId]
    );

    const byStatus = {};
    result.rows.forEach(r => {
      byStatus[r.status] = parseInt(r.count);
    });

    res.json({ ok: true, printerId, byStatus });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================

app.listen(PORT, () => {
  console.log("MSTAF CORE running on port", PORT);
});


