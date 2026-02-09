/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * - Twilio SMS/MMS inbound webhook: POST /sms
 * - Shopify webhook (authorized job): POST /shopify/webhook
 * - Upload endpoint: POST /api/upload (multipart/form-data)
 * - Printer polling: GET /jobs?printerId=PP-USA-001
 * - Count endpoint: GET /jobs/count?printerId=PP-USA-001
 * - Update status: POST /jobs/:id/status
 * - Uses Postgres if DATABASE_URL is set, otherwise in-memory fallback
 *
 * ✅ PATCH INCLUDED:
 * Part A: ensureDb() makes file_url nullable (DROP NOT NULL)
 * Part B: Shopify webhook INSERT includes file_url as NULL
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

let pg = null;
try { pg = require("pg"); } catch (e) { pg = null; }

const app = express();

// IMPORTANT for Twilio (form-encoded) + JSON
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------- Uploads folder + public access --------------------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const name = `mstaf_${Date.now()}_${crypto.randomBytes(6).toString("hex")}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage });

// -------------------- Optional Postgres --------------------
let pool = null;
if (pg && process.env.DATABASE_URL) {
  const { Pool } = pg;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("render.com")
      ? { rejectUnauthorized: false }
      : undefined
  });
}

const USE_DB = !!pool;

// -------------------- In-memory fallback --------------------
const mem = {
  jobs: [] // { id, id_text, printer_id, from_phone, status, meta, paper_size, color_mode, copies, file_url, created_at, updated_at }
};

// -------------------- Helpers --------------------
function nowIso() { return new Date().toISOString(); }

function safeJsonParse(s, fallback = {}) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function getPublicBaseUrl(req) {
  // Prefer explicit env var if provided (best practice)
  const base = process.env.PUBLIC_BASE_URL;
  if (base && typeof base === "string") return base.replace(/\/+$/, "");
  // Fallback to request host (works behind Render too)
  return `${req.protocol}://${req.get("host")}`.replace(/\/+$/, "");
}

function normalizePhone(input) {
  if (!input) return null;
  const s = String(input).trim();
  // Keep as-is if already looks like +E164
  if (s.startsWith("+") && s.length >= 8) return s;
  // Otherwise return raw (you can harden later)
  return s;
}

// -------------------- DB Migration --------------------
async function ensureDb() {
  if (!USE_DB) return;

  // Create table if missing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      job_id TEXT,
      id_text TEXT,
      printer_id TEXT,
      from_phone TEXT,
      status TEXT DEFAULT 'queued',
      meta JSONB DEFAULT '{}'::jsonb,
      paper_size TEXT,
      color_mode TEXT,
      copies INTEGER DEFAULT 1,
      file_url TEXT,
      file_name TEXT,
      mime_type TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add columns if older schema is missing them (safe idempotent)
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS job_id TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'queued';`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paper_size TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS color_mode TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS copies INTEGER DEFAULT 1;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`).catch(() => {});

  // ✅ Part A — Auto-migration: remove NOT NULL from file_url
  // Put after file_url column add (done above)
  await pool.query(`ALTER TABLE print_jobs ALTER COLUMN file_url DROP NOT NULL;`).catch(() => {});

  // Helpful indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_printer ON print_jobs (printer_id);`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs (status);`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_job_id ON print_jobs (job_id);`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_id_text ON print_jobs (id_text);`).catch(() => {});
}

// -------------------- Debug/Health --------------------
app.get("/health", async (req, res) => {
  try {
    if (USE_DB) {
      await pool.query("SELECT 1;");
    }
    res.json({
      ok: true,
      host: os.hostname(),
      time: nowIso(),
      db: USE_DB ? "connected" : "memory"
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/debug/instance", (req, res) => {
  res.json({
    pid: process.pid,
    host: os.hostname(),
    time: nowIso(),
    db: USE_DB ? "postgres" : "memory"
  });
});

// -------------------- Twilio inbound (simple placeholder) --------------------
app.post("/sms", async (req, res) => {
  // Twilio sends x-www-form-urlencoded
  const from = normalizePhone(req.body.From);
  const body = (req.body.Body || "").trim();
  const numMedia = Number(req.body.NumMedia || 0);

  // You can wire MSTAF logic here later.
  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>✅ MSTAF received: ${body || "(no text)"}${numMedia ? " + media" : ""}</Message></Response>`);
});

// -------------------- Shopify webhook (Authorized job creation) --------------------
/**
 * Expecting JSON body with a phone + printing options inside metadata.
 * Your PowerShell test should hit this endpoint.
 */
app.post("/shopify/webhook", async (req, res) => {
  try {
    const meta = req.body || {};
    const phone = normalizePhone(meta.phone || meta.customer_phone || meta.from_phone || meta?.customer?.phone);
    const printerId = meta.printer_id || meta.printerId || "PP-USA-001";

    // Basic parse for options (customize to your Shopify payload format)
    const parsed = {
      paper: meta.paper_size || meta.paper || "LETTER",
      color: meta.color_mode || meta.color || "COLOR",
      copies: Number(meta.copies || 1)
    };

    const jobId = `job_${crypto.randomBytes(8).toString("hex")}`;

    if (USE_DB) {
      // ✅ Part B — Shopify webhook insert: include file_url as NULL
      await pool.query(
        `
        INSERT INTO print_jobs (
          job_id,
          id_text,
          printer_id,
          from_phone,
          status,
          meta,
          paper_size,
          color_mode,
          copies,
          file_url,
          created_at,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
        `,
        [
          jobId,
          jobId,
          printerId,
          phone,
          "authorized_awaiting_file",
          JSON.stringify(meta),
          parsed.paper,
          parsed.color,
          parsed.copies,
          null
        ]
      );
    } else {
      mem.jobs.push({
        id: mem.jobs.length + 1,
        job_id: jobId,
        id_text: jobId,
        printer_id: printerId,
        from_phone: phone,
        status: "authorized_awaiting_file",
        meta,
        paper_size: parsed.paper,
        color_mode: parsed.color,
        copies: parsed.copies,
        file_url: null,
        created_at: nowIso(),
        updated_at: nowIso()
      });
    }

    res.json({ ok: true, created_count: 1, job_id: jobId });
  } catch (e) {
    console.error("SHOPIFY WEBHOOK ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------------------- Upload endpoint --------------------
/**
 * Uploads a file and returns a public URL.
 * Later we will add: update an existing job_id with this file_url.
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const base = getPublicBaseUrl(req);
    const fileUrl = `${base}/uploads/${encodeURIComponent(req.file.filename)}`;

    res.json({
      ok: true,
      fileUrl,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype
    });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------------------- Jobs endpoints --------------------
app.get("/jobs", async (req, res) => {
  const printerId = req.query.printerId || "PP-USA-001";
  try {
    if (USE_DB) {
      const r = await pool.query(
        `
        SELECT *
        FROM print_jobs
        WHERE printer_id = $1
        ORDER BY created_at DESC
        LIMIT 50
        `,
        [printerId]
      );
      res.json({ ok: true, jobs: r.rows });
    } else {
      const jobs = mem.jobs.filter(j => j.printer_id === printerId).slice(-50).reverse();
      res.json({ ok: true, jobs });
    }
  } catch (e) {
    console.error("GET JOBS ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/jobs/count", async (req, res) => {
  const printerId = req.query.printerId || "PP-USA-001";
  try {
    if (USE_DB) {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS count FROM print_jobs WHERE printer_id = $1`,
        [printerId]
      );
      res.json({ ok: true, printerId, count: r.rows[0].count });
    } else {
      const count = mem.jobs.filter(j => j.printer_id === printerId).length;
      res.json({ ok: true, printerId, count });
    }
  } catch (e) {
    console.error("COUNT ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/jobs/:id/status", async (req, res) => {
  const id = req.params.id;
  const status = (req.body.status || "").trim();
  if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

  try {
    if (USE_DB) {
      // Accept either numeric id or id_text/job_id
      const isNumeric = /^[0-9]+$/.test(id);

      const r = isNumeric
        ? await pool.query(
            `UPDATE print_jobs SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
            [status, Number(id)]
          )
        : await pool.query(
            `UPDATE print_jobs SET status = $1, updated_at = NOW() WHERE id_text = $2 OR job_id = $2 RETURNING *`,
            [status, id]
          );

      if (!r.rows.length) return res.status(404).json({ ok: false, error: "Job not found" });
      res.json({ ok: true, job: r.rows[0] });
    } else {
      const job = mem.jobs.find(j => String(j.id) === String(id) || j.id_text === id || j.job_id === id);
      if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
      job.status = status;
      job.updated_at = nowIso();
      res.json({ ok: true, job });
    }
  } catch (e) {
    console.error("STATUS UPDATE ERROR:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------------------- Boot --------------------
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await ensureDb();
  } catch (e) {
    console.error("ensureDb FAILED:", e);
  }

  app.listen(PORT, () => {
    console.log(`✅ MSTAF Print-O-Matic server running on port ${PORT}`);
    console.log(`✅ DB mode: ${USE_DB ? "Postgres" : "In-memory"}`);
  });
})();
