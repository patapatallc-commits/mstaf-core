/**
 * MSTAF CORE – Print-O-Matic Stable Server
 * Render-ready | PostgreSQL auto-migrate | Safe uploads
 */

if (process.env.NODE_ENV !== "production") {
  try { require("dotenv").config(); } catch (e) {}
}

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

// ---------- OPTIONAL POSTGRES ----------
let Pool = null;
try {
  ({ Pool } = require("pg"));
} catch (e) {}

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- STORAGE ----------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({ dest: uploadsDir });

// ---------- DATABASE ----------
let pool = null;
if (process.env.DATABASE_URL && Pool) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// ---------- AUTO-MIGRATION ----------
async function ensureDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY
    )
  `);

  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`).catch(()=>{});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'queued';`).catch(()=>{});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;`).catch(()=>{});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`).catch(()=>{});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`).catch(()=>{});

  // Backfill id_text if missing
  await pool.query(`
    UPDATE print_jobs
    SET id_text = COALESCE(id_text, 'print_' || md5(random()::text))
    WHERE id_text IS NULL
  `).catch(()=>{});
}

ensureDb();

// ---------- HEALTH ----------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mstaf-core-1",
    host: os.hostname(),
    time: new Date().toISOString(),
    db: pool ? "postgres" : "memory"
  });
});

// ---------- UPLOAD ----------
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const { printerId, from } = req.body;
    if (!req.file) {
      return res.status(400).json({ ok:false, error:"No file uploaded" });
    }

    const jobId = `print_${crypto.randomBytes(8).toString("hex")}`;
    const fileUrl = `/uploads/${req.file.filename}`;

    if (!pool) {
      return res.json({
        ok: true,
        job: { id_text: jobId, status: "queued", file_url: fileUrl }
      });
    }

    const result = await pool.query(
      `
      INSERT INTO print_jobs (
        id_text,
        printer_id,
        from_phone,
        file_name,
        mime_type,
        file_url,
        status,
        paid_at,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,'queued',NULL,NOW(),NOW())
      RETURNING id_text, printer_id, status, file_url, created_at
      `,
      [
        jobId,
        printerId,
        from || null,
        req.file.originalname,
        req.file.mimetype,
        fileUrl
      ]
    );

    res.json({ ok:true, job: result.rows[0] });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({
      ok:false,
      error:"Upload failed",
      details: err.message
    });
  }
});

// ---------- JOB POLLING ----------
app.get("/jobs", async (req, res) => {
  const { printerId } = req.query;
  if (!pool) return res.json([]);

  const r = await pool.query(
    `SELECT * FROM print_jobs WHERE printer_id=$1 ORDER BY created_at ASC`,
    [printerId]
  );
  res.json(r.rows);
});

// ---------- STATUS UPDATE ----------
app.post("/jobs/:id/status", async (req, res) => {
  const { status } = req.body;
  if (!pool) return res.json({ ok:true });

  await pool.query(
    `UPDATE print_jobs SET status=$1, updated_at=NOW() WHERE id_text=$2`,
    [status, req.params.id]
  );
  res.json({ ok:true });
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MSTAF CORE running on port ${PORT}`);
});


