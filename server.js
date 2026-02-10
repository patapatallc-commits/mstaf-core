/**
 * MSTAF CORE – Print-O-Matic Stable Server
 * Render-safe, DB-safe, Worker-safe
 */

if (process.env.NODE_ENV !== "production") {
  try { require("dotenv").config(); } catch {}
}

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

let Pool;
try {
  ({ Pool } = require("pg"));
} catch {
  Pool = null;
}

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

/* ---------------- DB ---------------- */
let pool = null;

if (process.env.DATABASE_URL && Pool) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

/* Auto-create table (SAFE) */
async function ensureTable() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT UNIQUE,
      printer_id TEXT,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_url TEXT,
      status TEXT DEFAULT 'queued',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
ensureTable().catch(console.error);

/* ---------------- Uploads ---------------- */
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use("/uploads", express.static(uploadsDir));

const upload = multer({ dest: uploadsDir });

/* ---------------- Health ---------------- */
app.get("/health", async (req, res) => {
  try {
    if (pool) await pool.query("SELECT 1");
    res.json({
      ok: true,
      host: os.hostname(),
      time: new Date().toISOString(),
      db: pool ? "connected" : "disabled"
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------------- Debug ---------------- */
app.get("/debug/instance", (req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    host: os.hostname(),
    time: new Date().toISOString()
  });
});

/* ---------------- Upload ---------------- */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const { printerId, from } = req.body;
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const jobId = `print_${crypto.randomBytes(8).toString("hex")}`;
    const fileUrl = `/uploads/${req.file.filename}`;

    if (pool) {
      await pool.query(
        `
        INSERT INTO print_jobs
        (id_text, printer_id, from_phone, file_name, mime_type, file_url, status)
        VALUES ($1,$2,$3,$4,$5,$6,'queued')
        `,
        [
          jobId,
          printerId,
          from,
          req.file.originalname,
          req.file.mimetype,
          fileUrl
        ]
      );
    }

    res.json({
      ok: true,
      message: "Queued print job",
      job: { job_id: jobId, status: "queued" }
    });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------------- Jobs list ---------------- */
app.get("/jobs", async (req, res) => {
  const { printerId } = req.query;
  if (!pool) return res.json({ ok: true, jobs: [] });

  const r = await pool.query(
    `SELECT * FROM print_jobs WHERE printer_id=$1 ORDER BY created_at ASC`,
    [printerId]
  );

  res.json({ ok: true, jobs: r.rows });
});

/* ---------------- Claim next job ---------------- */
app.post("/jobs/next", async (req, res) => {
  const { printerId } = req.query;
  if (!pool) return res.json({ ok: true, job: null });

  const r = await pool.query(
    `
    UPDATE print_jobs
    SET status='printing'
    WHERE id = (
      SELECT id FROM print_jobs
      WHERE printer_id=$1 AND status='queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
    `,
    [printerId]
  );

  res.json({ ok: true, job: r.rows[0] || null });
});

/* ---------------- Mark done ---------------- */
app.post("/jobs/:id/status", async (req, res) => {
  if (!pool) return res.json({ ok: true });

  await pool.query(
    `UPDATE print_jobs SET status='done' WHERE id_text=$1`,
    [req.params.id]
  );

  res.json({ ok: true });
});

/* ---------------- Start ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MSTAF CORE running on port ${PORT}`);
});

