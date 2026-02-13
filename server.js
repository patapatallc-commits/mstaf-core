/**
 * MSTAF CORE - Stable Print-O-Matic Server (Render)
 * ✅ DB-backed uploads (no filesystem dependency)
 * - /health
 * - /api/upload (multipart) -> stores file bytes in Postgres
 * - /uploads/:id/:filename -> streams file bytes from Postgres (agent downloads here)
 * - /jobs?printerId=PP-USA-001 -> returns queued+paid jobs
 * - /jobs/:id/status -> agent status updates
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

// ----------------------------
// Postgres
// ----------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

function baseUrl(req) {
  const envUrl = (process.env.RENDER_EXTERNAL_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`.replace(/\/$/, "");
}

async function colExists(table, col) {
  const r = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2
     LIMIT 1`,
    [table, col]
  );
  return r.rowCount > 0;
}

async function ensurePrintJobsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      id_text TEXT,
      job_id TEXT,
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

  const adds = [
    ["id_text", "TEXT"],
    ["job_id", "TEXT"],
    ["printer_id", "TEXT"],
    ["from_phone", "TEXT"],
    ["file_url", "TEXT"],
    ["file_name", "TEXT"],
    ["mime_type", "TEXT"],
    ["status", "TEXT DEFAULT 'queued'"],
    ["copies", "INTEGER DEFAULT 1"],
    ["paper_size", "TEXT DEFAULT 'A4'"],
    ["color_type", "TEXT DEFAULT 'BW'"],
    ["note", "TEXT"],
    ["created_at", "TIMESTAMP DEFAULT NOW()"],
    ["updated_at", "TIMESTAMP DEFAULT NOW()"],
    // ✅ DB-backed file bytes
    ["file_blob", "BYTEA"],
  ];

  for (const [c, t] of adds) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await colExists("print_jobs", c);
    if (!exists) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`ALTER TABLE print_jobs ADD COLUMN ${c} ${t};`);
    }
  }

  await pool.query(`
    UPDATE print_jobs
    SET id_text = COALESCE(id_text, job_id, CONCAT('print_', id::text)),
        updated_at = NOW()
    WHERE id_text IS NULL;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'print_jobs_id_text_uq') THEN
        CREATE UNIQUE INDEX print_jobs_id_text_uq ON print_jobs (id_text);
      END IF;
    END $$;
  `);
}

function logErr(tag, err) {
  console.error(`❌ ${tag}`, {
    message: err?.message,
    stack: err?.stack,
    code: err?.code,
    detail: err?.detail,
  });
}

ensurePrintJobsSchema().catch((e) => logErr("Schema init", e));

// ----------------------------
// Health
// ----------------------------
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: true, now: new Date().toISOString(), base_url: baseUrl(req) });
  } catch (e) {
    logErr("HEALTH", e);
    res.status(500).json({ ok: false, db: false });
  }
});

// ----------------------------
// Upload (multipart -> stores bytes in DB)
// ----------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    await ensurePrintJobsSchema();

    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const printerId = (req.body.printerId || "PP-USA-001").trim();
    const phone = (req.body.phone || "").trim();
    const copies = Math.max(parseInt(req.body.copies || "1", 10) || 1, 1);
    const paperSize = (req.body.paperSize || "A4").trim();
    const colorType = (req.body.colorType || "BW").trim();

    const idText = `print_${crypto.randomBytes(8).toString("hex")}`;

    // ✅ file URL that is ALWAYS downloadable (served from DB)
    const safeName = encodeURIComponent(req.file.originalname || `${idText}.bin`);
    const fileUrl = `${baseUrl(req)}/uploads/${idText}/${safeName}`;

    await pool.query(
      `
      INSERT INTO print_jobs
        (id_text, job_id, printer_id, from_phone, file_url, file_name, mime_type, file_blob,
         status, copies, paper_size, color_type, created_at, updated_at)
      VALUES
        ($1,     $2,    $3,        $4,        $5,       $6,        $7,       $8,
         'queued', $9,     $10,      $11,       NOW(),     NOW())
      `,
      [
        idText,
        idText,
        printerId,
        phone,
        fileUrl,
        req.file.originalname,
        req.file.mimetype,
        req.file.buffer,
        copies,
        paperSize,
        colorType,
      ]
    );

    res.json({
      ok: true,
      jobId: idText,
      printerId,
      copies,
      paperSize,
      colorType,
      file_url: fileUrl,
    });
  } catch (e) {
    logErr("UPLOAD", e);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ----------------------------
// Serve upload from DB
// ----------------------------
app.get("/uploads/:id/:filename", async (req, res) => {
  try {
    await ensurePrintJobsSchema();

    const id = (req.params.id || "").trim();
    if (!id) return res.status(400).send("Missing id");

    const r = await pool.query(
      `
      SELECT file_blob, mime_type, file_name
      FROM print_jobs
      WHERE id_text = $1 OR job_id = $1
      LIMIT 1
      `,
      [id]
    );

    if (r.rowCount === 0) return res.status(404).send("Not found");
    const row = r.rows[0];

    if (!row.file_blob) return res.status(404).send("File missing");

    res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
    // download name (optional)
    const downloadName = row.file_name || "file";
    res.setHeader("Content-Disposition", `inline; filename="${downloadName.replace(/"/g, "")}"`);

    return res.status(200).send(row.file_blob);
  } catch (e) {
    logErr("GET /uploads", e);
    res.status(500).send("Server error");
  }
});

// ----------------------------
// Printer polling
// TEST MODE: returns queued + paid
// ----------------------------
app.get("/jobs", async (req, res) => {
  try {
    await ensurePrintJobsSchema();

    const printerId = (req.query.printerId || "").trim();
    if (!printerId) return res.status(400).json({ error: "Missing printerId" });

    const r = await pool.query(
      `
      SELECT
        COALESCE(id_text, job_id) AS id_text,
        printer_id,
        file_url,
        file_name,
        mime_type,
        status,
        copies,
        paper_size,
        color_type,
        created_at
      FROM print_jobs
      WHERE printer_id = $1
        AND COALESCE(status,'queued') IN ('queued','paid')
      ORDER BY created_at ASC
      LIMIT 10
      `,
      [printerId]
    );

    res.json(r.rows);
  } catch (e) {
    logErr("GET /jobs", e);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------------------
// Status update from agent
// ----------------------------
app.post("/jobs/:id/status", async (req, res) => {
  try {
    await ensurePrintJobsSchema();

    const id = (req.params.id || "").trim();
    const status = (req.body.status || "").trim();
    const note = (req.body.note || "").trim();

    if (!id) return res.status(400).json({ error: "Missing id" });
    if (!status) return res.status(400).json({ error: "Missing status" });

    const r = await pool.query(
      `
      UPDATE print_jobs
      SET status = $1,
          note = $2,
          updated_at = NOW()
      WHERE id_text = $3 OR job_id = $3
      RETURNING COALESCE(id_text, job_id) AS id_text, status
      `,
      [status, note, id]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "Job not found" });

    res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    logErr("POST /jobs/:id/status", e);
    res.status(500).json({ error: "Server error" });
  }
});

// ----------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("✅ MSTAF CORE running on port", PORT));

