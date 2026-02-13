/**
 * MSTAF CORE - Stable Print-O-Matic Server (Render)
 * - /health
 * - /api/upload (multipart)
 * - /jobs (printer polling)
 * - /jobs/:id/status (printer status updates)
 *
 * ✅ Self-healing DB migrations:
 *   - Creates print_jobs if missing
 *   - Adds missing columns if older schema exists
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
  // Create table if not exists (canonical schema)
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

  // Ensure required columns exist (for older deployments)
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
  ];

  for (const [c, t] of adds) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await colExists("print_jobs", c);
    if (!exists) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(`ALTER TABLE print_jobs ADD COLUMN ${c} ${t};`);
    }
  }

  // Make sure at least one identifier column is populated for old rows
  // (If id_text is null but job_id exists, keep as-is; if both null, set id_text from id)
  await pool.query(`
    UPDATE print_jobs
    SET id_text = COALESCE(id_text, job_id, CONCAT('print_', id::text)),
        updated_at = NOW()
    WHERE id_text IS NULL;
  `);

  // Optional: unique index on id_text (safe)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'print_jobs_id_text_uq'
      ) THEN
        CREATE UNIQUE INDEX print_jobs_id_text_uq ON print_jobs (id_text);
      END IF;
    END $$;
  `);
}

// Run at startup (but also we call it inside routes for safety)
ensurePrintJobsSchema().catch((e) => console.error("Schema init error:", e));

// ----------------------------
// Helpers
// ----------------------------
function baseUrl(req) {
  // Prefer Render external url if set, else derive from request
  const envUrl = (process.env.RENDER_EXTERNAL_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`.replace(/\/$/, "");
}

function logErr(tag, err) {
  console.error(`❌ ${tag}`, {
    message: err?.message,
    stack: err?.stack,
    code: err?.code,
    detail: err?.detail,
  });
}

// ----------------------------
// Health
// ----------------------------
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      db: true,
      now: new Date().toISOString(),
      base_url: baseUrl(req),
    });
  } catch (e) {
    logErr("HEALTH", e);
    res.status(500).json({ ok: false, db: false });
  }
});

// ----------------------------
// Upload (multipart)
// NOTE: This version stores file bytes only in DB? No.
// We store metadata + a URL placeholder. You likely already have file storage elsewhere.
// If you already store uploads somewhere, keep your existing upload storage logic.
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

    // IMPORTANT:
    // If you already upload files to /uploads or cloud, set file_url to the real public URL.
    // For now we create a placeholder URL (you can replace later).
    const fileUrl = `${baseUrl(req)}/uploads/${idText}/${encodeURIComponent(req.file.originalname)}`;

    await pool.query(
      `
      INSERT INTO print_jobs
        (id_text, job_id, printer_id, from_phone, file_url, file_name, mime_type, status, copies, paper_size, color_type, created_at, updated_at)
      VALUES
        ($1,     $2,    $3,        $4,        $5,       $6,        $7,       'queued', $8,     $9,        $10,       NOW(),     NOW())
      `,
      [
        idText,
        idText, // keep both for backward compatibility
        printerId,
        phone,
        fileUrl,
        req.file.originalname,
        req.file.mimetype,
        copies,
        paperSize,
        colorType,
      ]
    );

    res.json({
      ok: true,
      jobId: idText,
      id_text: idText,
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
// Printer polling
// ----------------------------
app.get("/jobs", async (req, res) => {
  try {
    await ensurePrintJobsSchema();

    const printerId = (req.query.printerId || "").trim();
    if (!printerId) return res.status(400).json({ error: "Missing printerId" });

    // For testing: include queued + paid.
    // For production later: change to AND status='paid'
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
