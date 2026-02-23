"use strict";

/**
 * MSTAF Core Server — Stable Upload + Worker Printing + Auto DB Migration + Dispatch APIs
 *
 * Key fixes:
 * - Auto-migrate existing DB schema (adds missing columns like price) WITHOUT psql access.
 * - Worker can poll EITHER /api/worker/next OR /api/worker/next-job (compatibility).
 * - Always returns a valid fileUrl (never undefined) from stored file_id.
 * - No top-level await (Render deploy safe).
 *
 * Required env (Render):
 * - DATABASE_URL
 * - WORKER_KEY  (same value as worker .env WORKER_KEY / PRINTER_KEY)
 *
 * Optional:
 * - PUBLIC_BASE_URL or BASE_URL (recommended: https://mstaf-core-1.onrender.com)
 * - DEFAULT_AUTO_PRINTER_ID (default: PP-USA-001)
 * - DASHBOARD_KEY (for dispatch endpoints auth)
 * - DISPATCH_LINK_SECRET (defaults to WORKER_KEY)
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

// -------------------- Middleware --------------------
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// -------------------- ENV --------------------
const PORT = process.env.PORT || 10000;

const WORKER_KEY = process.env.WORKER_KEY || process.env.PRINTER_KEY || "";
const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "";
const DEFAULT_AUTO_PRINTER_ID = process.env.DEFAULT_AUTO_PRINTER_ID || "PP-USA-001";

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");
const DISPATCH_LINK_SECRET = process.env.DISPATCH_LINK_SECRET || WORKER_KEY || "change_me_secret";

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is missing.");
  process.exit(1);
}
if (!WORKER_KEY) {
  console.error("FATAL: WORKER_KEY (or PRINTER_KEY) is missing.");
  process.exit(1);
}

// -------------------- DB --------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL.includes("render.com") || process.env.PGSSLMODE === "require"
      ? { rejectUnauthorized: false }
      : false,
});

// -------------------- Helpers --------------------
function baseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return `${req.protocol}://${req.get("host")}`;
}

function requireWorkerAuth(req, res, next) {
  const key = req.headers["x-worker-key"] || req.headers["x-printer-key"] || "";
  if (!key || key !== WORKER_KEY) return res.status(401).json({ ok: false, error: "Unauthorized worker" });
  next();
}

function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_KEY) return res.status(401).json({ ok: false, error: "Dashboard auth not configured" });

  const headerKey = req.headers["x-dashboard-key"] || req.headers["x-admin-key"] || "";
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (headerKey === DASHBOARD_KEY || bearer === DASHBOARD_KEY) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized (dashboard)" });
}

function normalizePaper(v) {
  const s = String(v || "A4").trim().toUpperCase();
  if (s.includes("CARD")) return "CARD";
  if (s === "A3") return "A3";
  if (s.includes("LETTER")) return "LETTER";
  return "A4";
}

function normalizeColor(v) {
  const s = String(v || "bw").trim().toLowerCase();
  return s === "color" ? "color" : "bw";
}

function normalizeServiceType(v) {
  const s = String(v || "print").trim().toLowerCase();
  return s || "print";
}

// pricing rules you requested
function computePrice({ pages, copies, colorMode }) {
  const p = Math.max(Number(pages || 1), 1);
  const c = Math.max(Number(copies || 1), 1);
  const perPage = String(colorMode || "bw") === "color" ? 0.5 : 0.25;
  return Number((p * c * perPage).toFixed(2));
}

function isAutoPrintable({ serviceType, paperSize }) {
  if (String(serviceType || "print").toLowerCase() !== "print") return false;
  const p = String(paperSize || "A4").toUpperCase();
  if (p === "A3" || p === "CARD") return false;
  return true;
}

function makeToken(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", DISPATCH_LINK_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  try {
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig) return null;
    const expected = crypto.createHmac("sha256", DISPATCH_LINK_SECRET).update(payload).digest("base64url");
    if (expected !== sig) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function safeQuery(sql) {
  try {
    await pool.query(sql);
  } catch (e) {
    console.error("ensureSchema SQL failed:", e.message, "SQL:", sql);
  }
}

/**
 * ✅ Auto schema creation + migration
 * Works even if you cannot run psql.
 */
async function ensureSchema() {
  // Files table
  await safeQuery(`
    CREATE TABLE IF NOT EXISTS files (
      id BIGSERIAL PRIMARY KEY,
      original_name TEXT,
      mime_type TEXT,
      size_bytes BIGINT,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // print_jobs table
  await safeQuery(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id BIGSERIAL PRIMARY KEY,
      status TEXT,
      printer_id TEXT,
      service_type TEXT,
      paper_size TEXT,
      color_mode TEXT,
      pages INTEGER,
      copies INTEGER,
      price NUMERIC(10,2),
      instructions TEXT,
      customer_email TEXT,
      customer_city TEXT,
      customer_country TEXT,
      file_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      error_message TEXT
    );
  `);

  // ✅ MIGRATE: add missing columns safely
  const alters = [
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS service_type TEXT`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paper_size TEXT`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS color_mode TEXT`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS pages INTEGER`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS copies INTEGER`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS price NUMERIC(10,2)`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS instructions TEXT`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS customer_email TEXT`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS customer_city TEXT`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS customer_country TEXT`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_id BIGINT`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS error_message TEXT`,
  ];
  for (const sql of alters) await safeQuery(sql);

  // Defaults for existing rows
  await safeQuery(`UPDATE print_jobs SET status='queued' WHERE status IS NULL;`);
  await safeQuery(`UPDATE print_jobs SET printer_id='${DEFAULT_AUTO_PRINTER_ID}' WHERE printer_id IS NULL;`);
  await safeQuery(`UPDATE print_jobs SET service_type='print' WHERE service_type IS NULL;`);
  await safeQuery(`UPDATE print_jobs SET paper_size='A4' WHERE paper_size IS NULL;`);
  await safeQuery(`UPDATE print_jobs SET color_mode='bw' WHERE color_mode IS NULL;`);
  await safeQuery(`UPDATE print_jobs SET pages=1 WHERE pages IS NULL;`);
  await safeQuery(`UPDATE print_jobs SET copies=1 WHERE copies IS NULL;`);
  await safeQuery(`UPDATE print_jobs SET price=0.00 WHERE price IS NULL;`);

  // Indexes
  await safeQuery(`CREATE INDEX IF NOT EXISTS idx_print_jobs_status_created ON print_jobs(status, created_at);`);
  await safeQuery(`CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status ON print_jobs(printer_id, status, created_at);`);

  // dispatch queue table
  await safeQuery(`
    CREATE TABLE IF NOT EXISTS dispatch_queue (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT,
      copy_index INTEGER NOT NULL DEFAULT 2,
      assigned_printer_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      customer_email TEXT,
      secure_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await safeQuery(`CREATE INDEX IF NOT EXISTS idx_dispatch_status_created ON dispatch_queue(status, created_at DESC);`);
  await safeQuery(`CREATE INDEX IF NOT EXISTS idx_dispatch_job ON dispatch_queue(job_id);`);
}

// -------------------- Routes --------------------
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/**
 * Shopify upload endpoint (multipart/form-data)
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file" });

    const printerId = String(req.body.printerId || req.body.printer_id || DEFAULT_AUTO_PRINTER_ID).trim();
    const paperSize = normalizePaper(req.body.paperSize || req.body.paper_size);
    const colorMode = normalizeColor(req.body.colorMode || req.body.color_mode || req.body.color);
    const pages = Math.max(Number(req.body.pages || 1), 1);
    const copies = Math.max(Number(req.body.copies || 1), 1);
    const serviceType = normalizeServiceType(req.body.serviceType || req.body.service_type);

    const instructions = String(req.body.instructions || req.body.details || "");
    const customerEmail = req.body.email || req.body.customer_email || null;
    const customerCity = req.body.city || req.body.customer_city || null;
    const customerCountry = req.body.country || req.body.customer_country || null;

    const price = computePrice({ pages, copies, colorMode });

    // Save file
    const fileIns = await pool.query(
      `INSERT INTO files(original_name, mime_type, size_bytes, data)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.file.originalname, req.file.mimetype, req.file.size, req.file.buffer]
    );
    const fileId = fileIns.rows[0].id;

    // Create job
    const status = isAutoPrintable({ serviceType, paperSize }) ? "queued" : "dispatch";

    const jobIns = await pool.query(
      `INSERT INTO print_jobs(
        status, printer_id, service_type, paper_size, color_mode,
        pages, copies, price, instructions,
        customer_email, customer_city, customer_country,
        file_id, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,
        $10,$11,$12,
        $13,NOW(),NOW()
      ) RETURNING id`,
      [
        status,
        printerId,
        serviceType,
        paperSize,
        colorMode,
        pages,
        copies,
        price,
        instructions,
        customerEmail,
        customerCity,
        customerCountry,
        fileId,
      ]
    );

    const jobId = jobIns.rows[0].id;

    // Dispatch queue entries for copy #2..N
    if (copies > 1) {
      for (let i = 2; i <= copies; i++) {
        await pool.query(
          `INSERT INTO dispatch_queue(job_id, copy_index, status, created_at, updated_at)
           VALUES ($1,$2,'pending',NOW(),NOW())`,
          [jobId, i]
        );
      }
    }

    // Public preview link
    const token = makeToken({ jobId, fileId, ts: Date.now() });
    const publicFileUrl = `${baseUrl(req)}/api/public/file/${encodeURIComponent(token)}`;

    const routing =
      status === "queued"
        ? `Standard Printer (${printerId})`
        : "Dashboard Dispatch Required (A3/CARD/Editing)";

    return res.json({
      ok: true,
      jobId,
      routing,
      price,
      paperSize,
      colorMode,
      pages,
      copies,
      fileUrl: publicFileUrl,
    });
  } catch (e) {
    console.error("POST /api/upload error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Backward-compatible alias if Shopify calls this:
app.post("/api/print/upload", upload.single("file"), (req, res) => {
  req.url = "/api/upload";
  app._router.handle(req, res);
});

/**
 * Public file link for preview (no worker key)
 */
app.get("/api/public/file/:token", async (req, res) => {
  try {
    const payload = verifyToken(req.params.token);
    if (!payload || !payload.fileId) return res.status(401).send("Invalid link");

    const maxAgeMs = Number(process.env.PUBLIC_LINK_MAXAGE_MS || 7 * 24 * 60 * 60 * 1000);
    if (payload.ts && Date.now() - payload.ts > maxAgeMs) return res.status(401).send("Link expired");

    const r = await pool.query(`SELECT original_name, mime_type, data FROM files WHERE id=$1`, [payload.fileId]);
    const file = r.rows[0];
    if (!file) return res.status(404).send("File not found");

    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${String(file.original_name || "file").replace(/"/g, "")}"`);
    return res.send(file.data);
  } catch (e) {
    console.error("GET /api/public/file/:token error:", e);
    return res.status(500).send("Server error");
  }
});

/**
 * Worker secure file download endpoint
 */
app.get("/api/files/:fileId", requireWorkerAuth, async (req, res) => {
  try {
    const fileId = Number(req.params.fileId);
    const r = await pool.query(`SELECT original_name, mime_type, data FROM files WHERE id=$1`, [fileId]);
    const file = r.rows[0];
    if (!file) return res.status(404).json({ ok: false, error: "File not found" });

    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${String(file.original_name || "file").replace(/"/g, "")}"`);
    return res.send(file.data);
  } catch (e) {
    console.error("GET /api/files/:fileId error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Internal handler for "next job" (used by both routes)
 */
async function handleWorkerNext(req, res) {
  try {
    const printerId = String(req.query.printerId || DEFAULT_AUTO_PRINTER_ID).trim();

    const r = await pool.query(
      `
      SELECT * FROM print_jobs
      WHERE printer_id = $1
        AND service_type = 'print'
        AND paper_size NOT IN ('A3','CARD')
        AND status IN ('queued','pending')
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [printerId]
    );

    const jobRow = r.rows[0];
    if (!jobRow) return res.json({ ok: true, job: null });

    // mark printing immediately to prevent loops
    await pool.query(`UPDATE print_jobs SET status='printing', updated_at=NOW() WHERE id=$1`, [jobRow.id]);

    if (!jobRow.file_id) {
      await pool.query(
        `UPDATE print_jobs SET status='error', error_message=$2, updated_at=NOW() WHERE id=$1`,
        [jobRow.id, "Missing file_id on job"]
      );
      return res.json({ ok: false, error: "job_missing_file_id", jobId: jobRow.id });
    }

    // Always generate a real file URL (never undefined)
    const fileUrl = `${baseUrl(req)}/api/files/${jobRow.file_id}`;

    return res.json({
      ok: true,
      job: {
        id: jobRow.id,
        printerId: jobRow.printer_id,
        paperSize: jobRow.paper_size,
        colorMode: jobRow.color_mode,
        pages: jobRow.pages,
        copies: 1, // auto print copy #1 only
        price: jobRow.price,
        instructions: jobRow.instructions || "",
        fileId: jobRow.file_id,
        fileUrl,
        file_url: fileUrl,
      },
    });
  } catch (e) {
    console.error("GET worker next error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

/**
 * Worker: get next job (NEW)
 */
app.get("/api/worker/next", requireWorkerAuth, handleWorkerNext);

/**
 * Worker: get next job (OLD compatibility)
 */
app.get("/api/worker/next-job", requireWorkerAuth, handleWorkerNext);

app.post("/api/worker/done", requireWorkerAuth, async (req, res) => {
  try {
    const jobId = Number(req.body.jobId);
    if (!jobId) return res.status(400).json({ ok: false, error: "Missing jobId" });

    await pool.query(`UPDATE print_jobs SET status='done', updated_at=NOW() WHERE id=$1`, [jobId]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/worker/done error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/worker/error", requireWorkerAuth, async (req, res) => {
  try {
    const jobId = Number(req.body.jobId);
    const msg = String(req.body.error || "Unknown error");
    if (!jobId) return res.status(400).json({ ok: false, error: "Missing jobId" });

    await pool.query(`UPDATE print_jobs SET status='error', error_message=$2, updated_at=NOW() WHERE id=$1`, [
      jobId,
      msg,
    ]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/worker/error error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// -------------------- Dispatch Dashboard APIs --------------------
app.get("/api/dispatch/queue", requireDashboardAuth, async (req, res) => {
  try {
    const status = String(req.query.status || "pending");
    const limit = Math.min(Number(req.query.limit || 200), 500);

    const r = await pool.query(
      `
      SELECT dq.*, pj.paper_size, pj.color_mode, pj.pages, pj.price, pj.instructions, pj.customer_email
      FROM dispatch_queue dq
      LEFT JOIN print_jobs pj ON pj.id = dq.job_id
      WHERE dq.status = $1
      ORDER BY dq.created_at DESC
      LIMIT $2
      `,
      [status, limit]
    );

    return res.json({ ok: true, count: r.rows.length, items: r.rows });
  } catch (e) {
    console.error("GET /api/dispatch/queue error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/dispatch/assign", requireDashboardAuth, async (req, res) => {
  try {
    const dispatchId = Number(req.body.dispatchId);
    const printerId = String(req.body.printerId || "").trim();
    if (!dispatchId || !printerId) return res.status(400).json({ ok: false, error: "dispatchId and printerId required" });

    const r = await pool.query(
      `UPDATE dispatch_queue
       SET assigned_printer_id=$1, status='assigned', updated_at=NOW()
       WHERE id=$2
       RETURNING *`,
      [printerId, dispatchId]
    );

    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "Not found" });
    return res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    console.error("POST /api/dispatch/assign error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/dispatch/email", requireDashboardAuth, async (req, res) => {
  try {
    const dispatchId = Number(req.body.dispatchId);
    const email = String(req.body.email || "").trim();
    if (!dispatchId || !email) return res.status(400).json({ ok: false, error: "dispatchId and email required" });

    const dq = await pool.query(`SELECT * FROM dispatch_queue WHERE id=$1`, [dispatchId]);
    const item = dq.rows[0];
    if (!item) return res.status(404).json({ ok: false, error: "Dispatch item not found" });

    const pj = await pool.query(`SELECT * FROM print_jobs WHERE id=$1`, [item.job_id]);
    const job = pj.rows[0];
    if (!job || !job.file_id) return res.status(400).json({ ok: false, error: "Job file missing" });

    const token = makeToken({ jobId: job.id, fileId: job.file_id, ts: Date.now() });
    const link = `${baseUrl(req)}/api/public/file/${encodeURIComponent(token)}`;

    await pool.query(
      `UPDATE dispatch_queue SET customer_email=$1, secure_token=$2, status='emailed', updated_at=NOW() WHERE id=$3`,
      [email, token, dispatchId]
    );

    return res.json({ ok: true, email, link, note: "Email sending not configured; link generated." });
  } catch (e) {
    console.error("POST /api/dispatch/email error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// -------------------- Startup (NO top-level await) --------------------
(async () => {
  try {
    await ensureSchema();
    console.log("✅ MSTAF Core schema ready");
  } catch (e) {
    console.error("FATAL: ensureSchema failed:", e);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`✅ MSTAF Core running on port ${PORT}`);
    console.log("✅ PUBLIC_BASE_URL:", PUBLIC_BASE_URL || "(auto)");
    console.log("✅ WORKER_KEY:", WORKER_KEY ? "(set)" : "(missing)");
    console.log("✅ DEFAULT_AUTO_PRINTER_ID:", DEFAULT_AUTO_PRINTER_ID);
    console.log("✅ DASHBOARD auth:", DASHBOARD_KEY ? "(set)" : "(not set)");
  });
})();
