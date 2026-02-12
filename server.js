/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * - Health: GET /health
 * - Upload: POST /api/upload (multipart/form-data)
 * - Serve files: GET /uploads/:filename
 * - Printer polling: GET /jobs?printerId=PP-USA-001
 * - Count: GET /jobs/count?printerId=PP-USA-001
 * - Update status: POST /jobs/:id/status
 * - Debug: POST /debug/mark-paid/:id (for testing)
 *
 * IMPORTANT:
 * ✅ file_url uses BASE_URL env (no hardcoded old Render domains)
 */

if (process.env.NODE_ENV !== "production") {
  try { require("dotenv").config(); } catch (e) {}
}

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

// Optional Postgres
let pg = null;
try { pg = require("pg"); } catch (e) { pg = null; }

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// =========================
// CONFIG
// =========================
const BASE_URL = (process.env.BASE_URL || "https://mstaf-core.onrender.com").replace(/\/$/, "");
const PORT = process.env.PORT || 10000;

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Serve uploads publicly so worker can download file_url
app.use("/uploads", express.static(UPLOADS_DIR));

// =========================
// DB / In-memory fallback
// =========================
const useDb = !!(process.env.DATABASE_URL && pg);

let pool = null;
let memJobs = []; // fallback

if (useDb) {
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });
}

// Safe bootstrap (create table if missing)
async function ensureSchema() {
  if (!useDb) return;

  // Create print_jobs table (minimal columns needed)
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
      paid BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Ensure columns exist (safe)
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paid BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'queued';`);

  // Unique index on id_text (safe)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'print_jobs_id_text_unique'
      ) THEN
        CREATE UNIQUE INDEX print_jobs_id_text_unique ON print_jobs (id_text);
      END IF;
    END$$;
  `);
}

function nowIso() {
  return new Date().toISOString();
}

function makeJobId() {
  return `print_${crypto.randomBytes(8).toString("hex")}`;
}

// =========================
// Multer (disk storage)
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safe = (file.originalname || "upload")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 140);
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage });

// =========================
// ROUTES
// =========================
app.get("/health", async (req, res) => {
  try {
    if (useDb) {
      const r = await pool.query("SELECT NOW() as now");
      return res.json({ ok: true, db: true, now: r.rows[0].now, base_url: BASE_URL });
    }
    return res.json({ ok: true, db: false, now: nowIso(), base_url: BASE_URL });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Upload -> create job
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || req.query.printerId || "PP-USA-001").toString();
    const fromPhone = (req.body.from || req.body.phone || "").toString();

    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const filename = req.file.filename;
    const fileUrl = `${BASE_URL}/uploads/${filename}`; // ✅ THIS IS THE CRITICAL FIX

    const jobId = makeJobId();

    if (useDb) {
      await pool.query(
        `
        INSERT INTO print_jobs
          (id_text, printer_id, from_phone, file_name, mime_type, file_url, status, paid, updated_at)
        VALUES
          ($1,$2,$3,$4,$5,$6,'queued',false,NOW())
        `,
        [jobId, printerId, fromPhone, req.file.originalname, req.file.mimetype, fileUrl]
      );
    } else {
      memJobs.push({
        id_text: jobId,
        printer_id: printerId,
        from_phone: fromPhone,
        file_name: req.file.originalname,
        mime_type: req.file.mimetype,
        file_url: fileUrl,
        status: "queued",
        paid: false,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
    }

    res.json({
      ok: true,
      message: "Queued print job",
      job: {
        id_text: jobId,
        printerId,
        file_name: req.file.originalname,
        mime_type: req.file.mimetype,
        file_url: fileUrl,
        status: "queued",
        paid: false,
      },
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ ok: false, error: "Upload failed", detail: String(err) });
  }
});

// Printer polls ONLY PAID jobs
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "PP-USA-001").toString();
    const limit = Math.min(parseInt(req.query.limit || "10", 10) || 10, 50);

    if (useDb) {
      const r = await pool.query(
        `
        SELECT id_text, printer_id, from_phone, file_name, mime_type, file_url, status, paid, created_at
        FROM print_jobs
        WHERE printer_id = $1
          AND paid = true
          AND status IN ('paid','queued','awaiting_print','printing')
        ORDER BY created_at ASC
        LIMIT $2
        `,
        [printerId, limit]
      );
      return res.json({ ok: true, jobs: r.rows });
    }

    const jobs = memJobs
      .filter(j => j.printer_id === printerId && j.paid === true && ["paid","queued","awaiting_print","printing"].includes(j.status))
      .slice(0, limit);

    res.json({ ok: true, jobs });
  } catch (e) {
    console.error("GET /jobs ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/jobs/count", async (req, res) => {
  try {
    const printerId = (req.query.printerId || "PP-USA-001").toString();

    if (useDb) {
      const r = await pool.query(
        `
        SELECT COUNT(*)::int AS count
        FROM print_jobs
        WHERE printer_id = $1
          AND paid = true
          AND status IN ('paid','queued','awaiting_print','printing')
        `,
        [printerId]
      );
      return res.json({ ok: true, count: r.rows[0].count });
    }

    const count = memJobs.filter(j => j.printer_id === printerId && j.paid === true && ["paid","queued","awaiting_print","printing"].includes(j.status)).length;
    res.json({ ok: true, count });
  } catch (e) {
    console.error("GET /jobs/count ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Update status (worker calls this)
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const id = req.params.id;
    const status = (req.body.status || "").toString();
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    if (useDb) {
      const r = await pool.query(
        `
        UPDATE print_jobs
        SET status = $1, updated_at = NOW()
        WHERE id_text = $2
        RETURNING id_text, status, updated_at
        `,
        [status, id]
      );
      if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "Job not found" });
      return res.json({ ok: true, job: r.rows[0] });
    }

    const j = memJobs.find(x => x.id_text === id);
    if (!j) return res.status(404).json({ ok: false, error: "Job not found" });
    j.status = status;
    j.updated_at = nowIso();
    res.json({ ok: true, job: j });
  } catch (e) {
    console.error("POST /jobs/:id/status ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Debug: mark job paid (so printer can pick it up)
app.post("/debug/mark-paid/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (useDb) {
      const r = await pool.query(
        `
        UPDATE print_jobs
        SET paid = true, status = 'paid', updated_at = NOW()
        WHERE id_text = $1
        RETURNING id_text, paid, status
        `,
        [id]
      );
      if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "Job not found" });
      return res.json({ ok: true, job: r.rows[0] });
    }

    const j = memJobs.find(x => x.id_text === id);
    if (!j) return res.status(404).json({ ok: false, error: "Job not found" });
    j.paid = true;
    j.status = "paid";
    j.updated_at = nowIso();
    res.json({ ok: true, job: j });
  } catch (e) {
    console.error("POST /debug/mark-paid/:id ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// =========================
// STARTUP
// =========================
(async () => {
  try {
    await ensureSchema();
    app.listen(PORT, () => {
      console.log("MSTAF CORE listening on port", PORT);
      console.log("BASE_URL =", BASE_URL);
      console.log("UPLOADS_DIR =", UPLOADS_DIR);
      console.log("DB =", useDb ? "Postgres" : "In-memory");
    });
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();
