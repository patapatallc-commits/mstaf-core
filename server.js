/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * - Health: GET /health
 * - Upload: POST /api/upload (multipart/form-data)
 * - Printer polling: GET /jobs?printerId=PP-USA-001&limit=5
 * - Update status: POST /jobs/:id/status
 *
 * DB rules:
 * - Do NOT insert into serial id
 * - Always set job_id + id_text (same value)
 * - Auto-migrate missing columns (paid_at, job_id, etc.)
 * - Backfill old rows where job_id / id_text are NULL
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

// Optional Postgres (pg)
let Pool = null;
try {
  ({ Pool } = require("pg"));
} catch (e) {
  Pool = null;
}

const app = express();

// IMPORTANT: Twilio + JSON safe
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
// -------------------- PRINTER KEY AUTH --------------------
function requirePrinterKey(req, res, next) {
  const required = process.env.PRINTER_KEY;

  // Safety: if not configured, do not block
  if (!required) return next();

  const got =
    req.header("x-printer-key") ||
    req.query.printerKey ||
    "";

  if (!got || got !== required) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized: invalid printer key"
    });
  }

  next();
}

// Uploads folder + public access
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

const upload = multer({ dest: uploadsDir });

// DB pool (Render)
let pool = null;
if (process.env.DATABASE_URL && Pool) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// ---------- HELPERS ----------
function nowISO() {
  return new Date().toISOString();
}
function makeJobId() {
  return `print_${crypto.randomBytes(8).toString("hex")}`;
}

// ---------- AUTO MIGRATION ----------
async function ensureDb() {
  if (!pool) return;

  // Ensure table exists at least with serial id
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY
    )
  `);

  // Columns (safe if already exist)
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS job_id TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'queued';`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`).catch(() => {});

  // Backfill any old rows that violate NOT NULL expectations in your DB
  // - id_text must exist
  // - job_id must exist
  await pool.query(`
    UPDATE print_jobs
    SET
      id_text = COALESCE(id_text, 'print_' || md5(random()::text)),
      job_id  = COALESCE(job_id, id_text, 'print_' || md5(random()::text))
    WHERE id_text IS NULL OR job_id IS NULL
  `).catch(() => {});
}

// Run at boot
ensureDb().catch(() => {});

// ---------- ROUTES ----------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mstaf-core-1",
    host: os.hostname(),
    time: nowISO(),
    db: pool ? "postgres" : "memory"
  });
});

// Upload -> creates queued job (needs_details is for your later flow; queued is fine for now)
app.post("/api/upload", requirePrinterKey, upload.single("file"), async (req, res) => {

  try {
    const { printerId, from } = req.body;

    if (!printerId) {
      return res.status(400).json({ ok: false, error: "Missing printerId" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Missing file" });
    }

    const jobId = makeJobId();
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    // Memory fallback (if DB not connected)
    if (!pool) {
      return res.json({
        ok: true,
        message: "Queued print job",
        job: {
          job_id: jobId,
          id_text: jobId,
          printer_id: printerId,
          from_phone: from || null,
          file_name: req.file.originalname,
          mime_type: req.file.mimetype,
          file_url: fileUrl,
          status: "queued",
          created_at: nowISO()
        }
      });
    }

    // Ensure migrations exist (extra safety on cold boots)
    await ensureDb();

    // IMPORTANT: never insert into serial id
    // Always set BOTH job_id and id_text (same value)
    const result = await pool.query(
      `
      INSERT INTO print_jobs (
        job_id,
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
      VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',NULL,NOW(),NOW())
      RETURNING
        job_id, id_text, printer_id, from_phone, file_name, mime_type, file_url, status, paid_at, created_at, updated_at
      `,
      [
        jobId,
        jobId,
        printerId,
        from || null,
        req.file.originalname,
        req.file.mimetype,
        fileUrl
      ]
    );

    return res.json({
      ok: true,
      message: "Queued print job",
      job: result.rows[0]
    });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Upload failed",
      details: err.message
    });
  }
});

// Printer poll: return jobs for printer
app.get("/jobs", async (req, res) => {
  try {
    const { printerId, limit } = req.query;
    const lim = Math.min(parseInt(limit || "20", 10), 50);

    if (!printerId) {
      return res.status(400).json({ ok: false, error: "Missing printerId" });
    }
    if (!pool) return res.json({ ok: true, jobs: [] });

    const r = await pool.query(
      `
      SELECT job_id, id_text, printer_id, from_phone, file_name, mime_type, file_url, status, paid_at, created_at, updated_at
      FROM print_jobs
      WHERE printer_id = $1
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [printerId, lim]
    );

    return res.json({ ok: true, jobs: r.rows });
  } catch (err) {
    console.error("JOBS ERROR:", err);
    return res.status(500).json({ ok: false, error: "Jobs fetch failed", details: err.message });
  }
});

// Update status by job id_text (same as job_id)
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const id = req.params.id;

    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });
    if (!pool) return res.json({ ok: true });

    await pool.query(
      `UPDATE print_jobs SET status=$1, updated_at=NOW() WHERE id_text=$2 OR job_id=$2`,
      [status, id]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("STATUS ERROR:", err);
    return res.status(500).json({ ok: false, error: "Status update failed", details: err.message });
  }
});
// ==================== ADMIN (protected) ====================
function requireAdmin(req, res, next) {
  const keyFromHeader = req.headers["x-admin-key"];

  // Accept any of these env var names (so it never breaks again)
  const configuredKey =
    process.env.MSTAF_ADMIN_KEY ||
    process.env.MSTAF_ADMIN ||
    process.env.ADMIN_KEY ||
    process.env.X_ADMIN_KEY;

  if (!configuredKey) {
    return res.status(503).json({ ok: false, error: "Admin key not configured" });
  }

  if (!keyFromHeader || keyFromHeader !== configuredKey) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}


app.get("/admin/jobs/recent", requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);

  try {
    const r = await pool.query(
      `
      SELECT job_id, id_text, printer_id, from_phone, file_name, mime_type, file_url,
             status, paid_at, created_at, updated_at
      FROM print_jobs
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );
    return res.json({ ok: true, jobs: r.rows });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "admin recent failed",
      details: String(e.message || e)
    });
  }
});

app.post("/admin/jobs/:id/force-paid", requireAdmin, async (req, res) => {
  const id = req.params.id;

  try {
    const r = await pool.query(
      `
      UPDATE print_jobs
      SET status='paid', paid_at=NOW(), updated_at=NOW()
      WHERE job_id=$1 OR id_text=$1
      RETURNING job_id, id_text, status, paid_at, updated_at
      `,
      [id]
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Job not found" });
    }

    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "force-paid failed",
      details: String(e.message || e)
    });
  }
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MSTAF CORE running on port ${PORT}`));


