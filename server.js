/**
 * MSTAF Core (Render + Shopify Upload + Worker Queue + Dashboard Dispatch)
 * - Express API for uploads + print queue
 * - Worker polling endpoint (claims jobs safely)
 * - Secure file serving via token
 * - Dispatch queue + short link /d/:id redirect
 * - FIXES: single startup wrapper + proper Render PORT binding
 */

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

/* ----------------------------- ENV / CONSTANTS ---------------------------- */

const DATABASE_URL = process.env.DATABASE_URL;

// Render assigns PORT dynamically. Keep fallback for local dev.
const PORT = Number(process.env.PORT || 10000);

// Keys
const WORKER_KEY = (process.env.WORKER_KEY || process.env.PRINTER_KEY || "").trim();
const DASHBOARD_KEY = (process.env.DASHBOARD_KEY || "").trim();

const DEFAULT_AUTO_PRINTER_ID = (process.env.DEFAULT_AUTO_PRINTER_ID || "PP-USA-001").trim();

// Base URL (used to build public links)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").trim().replace(/\/$/, "");

// Dispatch secret (for tokens)
const DISPATCH_LINK_SECRET = (process.env.DISPATCH_LINK_SECRET || WORKER_KEY || "change_me_secret").trim();

/* ----------------------------- HARD REQUIREMENTS --------------------------- */

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is missing.");
  process.exit(1);
}
if (!WORKER_KEY) {
  console.error("FATAL: WORKER_KEY (or PRINTER_KEY) is missing.");
  process.exit(1);
}
if (!DASHBOARD_KEY) {
  console.error("FATAL: DASHBOARD_KEY is missing.");
  process.exit(1);
}

/* --------------------------------- DB POOL -------------------------------- */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

/* --------------------------------- MIDDLEWARE ----------------------------- */

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* --------------------------------- STORAGE -------------------------------- */

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer disk storage
const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname || "").slice(0, 10);
    const name = crypto.randomBytes(16).toString("hex") + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

/* ------------------------------- HELPERS ---------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function randToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function safeBaseUrl(req) {
  // Prefer ENV; fallback to request origin.
  const envBase = PUBLIC_BASE_URL;
  if (envBase) return envBase;

  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function requireWorkerKey(req, res, next) {
  const key =
    (req.headers["x-worker-key"] || req.headers["x-printer-key"] || req.query.worker_key || "")
      .toString()
      .trim();
  if (!key || key !== WORKER_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized worker" });
  }
  next();
}

function requireDashboardKey(req, res, next) {
  const key =
    (req.headers["x-dashboard-key"] || req.query.dashboard_key || "").toString().trim();
  if (!key || key !== DASHBOARD_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized dashboard" });
  }
  next();
}

// Pricing (as you specified)
function calcPrice({ colorMode, copies, pages }) {
  const isColor = (colorMode || "").toLowerCase().includes("color");
  const perPage = isColor ? 0.5 : 0.25;
  const c = Number(copies || 1) || 1;
  const p = Number(pages || 1) || 1;
  return Number((perPage * c * p).toFixed(2));
}

// A3 / CARD should go to dashboard/manual dispatch (not auto printer)
function shouldAutoPrint(paperSize) {
  const ps = (paperSize || "").toUpperCase();
  if (ps === "A3") return false;
  if (ps === "CARD") return false;
  return true;
}

// Build dispatch secure token
function buildDispatchToken(dispatchId) {
  const h = crypto.createHmac("sha256", DISPATCH_LINK_SECRET);
  h.update(String(dispatchId));
  return h.digest("hex").slice(0, 32); // short token
}

function buildDispatchLink(req, dispatchId) {
  const base = safeBaseUrl(req);
  return `${base}/d/${dispatchId}`;
}

/* ------------------------------- SCHEMA ----------------------------------- */

async function ensureSchema() {
  // Keep it safe + idempotent.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      status TEXT NOT NULL DEFAULT 'pending',  -- pending | printing | done | error | dispatched
      printer_id TEXT NOT NULL DEFAULT '${DEFAULT_AUTO_PRINTER_ID}',

      paper_size TEXT DEFAULT 'A4',
      color_mode TEXT DEFAULT 'BW',
      copies INT NOT NULL DEFAULT 1,
      pages INT NOT NULL DEFAULT 1,

      instructions TEXT,
      customer_name TEXT,
      customer_email TEXT,
      customer_country TEXT,
      customer_city TEXT,

      original_name TEXT,
      mime_type TEXT,
      stored_name TEXT,

      secure_token TEXT UNIQUE,
      public_url TEXT,

      price NUMERIC(10,2) NOT NULL DEFAULT 0,

      claimed_at TIMESTAMPTZ,
      done_at TIMESTAMPTZ,
      error_message TEXT
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_print_jobs_status_printer
    ON print_jobs(status, printer_id, created_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_queue (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'pending', -- pending | dispatched | done
      job_id BIGINT REFERENCES print_jobs(id) ON DELETE SET NULL,
      email TEXT,
      note TEXT,
      secure_token TEXT UNIQUE
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_status_created
    ON dispatch_queue(status, created_at);
  `);
}

/* ------------------------------- ROUTES ----------------------------------- */

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: nowIso() });
});

/**
 * Public file access (secure_token)
 * GET /api/public/file/:token
 */
app.get("/api/public/file/:token", async (req, res) => {
  try {
    const token = (req.params.token || "").trim();
    if (!token) return res.status(400).send("Missing token");

    const r = await pool.query(
      `SELECT stored_name, mime_type, original_name
       FROM print_jobs
       WHERE secure_token = $1
       LIMIT 1`,
      [token]
    );

    if (r.rows.length === 0) return res.status(404).send("File not found");

    const row = r.rows[0];
    const filePath = path.join(UPLOAD_DIR, row.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).send("File missing on server");

    res.setHeader("Content-Type", row.mime_type || "application/octet-stream");
    // inline view; browser can download if needed
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${(row.original_name || "file").replace(/"/g, "")}"`
    );

    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error("GET /api/public/file/:token error:", e);
    return res.status(500).send("Server error");
  }
});

/**
 * Shopify upload -> creates print job
 * POST /api/upload (multipart)
 * fields: file, printerId, paperSize, colorMode, copies, pages, instructions, name, email, country, city
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, error: "File required" });

    const printerId = (req.body.printerId || DEFAULT_AUTO_PRINTER_ID).toString().trim();
    const paperSize = (req.body.paperSize || "A4").toString().trim();
    const colorMode = (req.body.colorMode || "BW").toString().trim();
    const copies = Number(req.body.copies || 1) || 1;
    const pages = Number(req.body.pages || 1) || 1;

    const instructions = (req.body.instructions || "").toString();
    const customer_name = (req.body.name || req.body.customerName || "").toString();
    const customer_email = (req.body.email || "").toString();
    const customer_country = (req.body.country || "").toString();
    const customer_city = (req.body.city || "").toString();

    const secure_token = randToken(18);
    const public_url = `${safeBaseUrl(req)}/api/public/file/${secure_token}`;

    const auto = shouldAutoPrint(paperSize);
    const status = auto ? "pending" : "pending"; // still pending, but dashboard will dispatch
    const assignedPrinter = auto ? printerId : printerId; // keep original; dashboard decides later

    const price = calcPrice({ colorMode, copies, pages });

    const insert = await pool.query(
      `INSERT INTO print_jobs
        (status, printer_id, paper_size, color_mode, copies, pages,
         instructions, customer_name, customer_email, customer_country, customer_city,
         original_name, mime_type, stored_name,
         secure_token, public_url, price, updated_at)
       VALUES
        ($1,$2,$3,$4,$5,$6,
         $7,$8,$9,$10,$11,
         $12,$13,$14,
         $15,$16,$17, NOW())
       RETURNING id, secure_token, public_url, status, printer_id, paper_size, color_mode, copies, pages, price`,
      [
        status,
        assignedPrinter,
        paperSize,
        colorMode,
        copies,
        pages,
        instructions,
        customer_name,
        customer_email,
        customer_country,
        customer_city,
        f.originalname || null,
        f.mimetype || null,
        f.filename || null,
        secure_token,
        public_url,
        price,
      ]
    );

    const job = insert.rows[0];

    // If NOT auto-print paper type, create a dispatch record so dashboard can generate link
    if (!auto) {
      const dq = await pool.query(
        `INSERT INTO dispatch_queue (status, job_id, email, note, secure_token, updated_at)
         VALUES ('pending', $1, $2, $3, $4, NOW())
         RETURNING id`,
        [
          job.id,
          customer_email || null,
          `PaperSize=${paperSize} ColorMode=${colorMode} Copies=${copies} Pages=${pages}`,
          buildDispatchToken(job.id),
        ]
      );

      job.dispatchId = dq.rows[0].id;
      job.dispatchLink = buildDispatchLink(req, dq.rows[0].id);
    }

    return res.json({ ok: true, job });
  } catch (e) {
    console.error("POST /api/upload error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Worker: poll next job for a printer
 * GET /api/worker/next?printerId=PP-USA-001
 * - claims job by setting status=printing and claimed_at
 */
app.get("/api/worker/next", requireWorkerKey, async (req, res) => {
  try {
    const printerId = (req.query.printerId || DEFAULT_AUTO_PRINTER_ID).toString().trim();

    // claim next pending job safely
    const claim = await pool.query(
      `
      WITH next_job AS (
        SELECT id
        FROM print_jobs
        WHERE status = 'pending'
          AND printer_id = $1
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE print_jobs
      SET status = 'printing',
          claimed_at = NOW(),
          updated_at = NOW()
      WHERE id IN (SELECT id FROM next_job)
      RETURNING *
      `,
      [printerId]
    );

    if (claim.rows.length === 0) {
      return res.json({ ok: true, job: null });
    }

    const job = claim.rows[0];
    return res.json({ ok: true, job });
  } catch (e) {
    console.error("GET /api/worker/next error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Worker: update job status
 * POST /api/worker/job/:id/status
 * body: { status: 'done'|'error', errorMessage? }
 */
app.post("/api/worker/job/:id/status", requireWorkerKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid id" });

    const status = (req.body.status || "").toString().trim();
    const errorMessage = (req.body.errorMessage || "").toString();

    if (!["done", "error"].includes(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }

    const q = await pool.query(
      `
      UPDATE print_jobs
      SET status = $1,
          done_at = CASE WHEN $1 = 'done' THEN NOW() ELSE done_at END,
          error_message = CASE WHEN $1 = 'error' THEN $2 ELSE NULL END,
          updated_at = NOW()
      WHERE id = $3
      RETURNING id, status
      `,
      [status, errorMessage || null, id]
    );

    if (q.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });
    return res.json({ ok: true, job: q.rows[0] });
  } catch (e) {
    console.error("POST /api/worker/job/:id/status error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* ------------------------- DASHBOARD / DISPATCH APIs ----------------------- */

/**
 * Dashboard list jobs
 * GET /api/dashboard/jobs?status=pending
 */
app.get("/api/dashboard/jobs", requireDashboardKey, async (req, res) => {
  try {
    const status = (req.query.status || "").toString().trim();
    const where = status ? "WHERE status = $1" : "";
    const args = status ? [status] : [];

    const q = await pool.query(
      `
      SELECT id, created_at, updated_at, status, printer_id,
             paper_size, color_mode, copies, pages,
             instructions, customer_name, customer_email, customer_country, customer_city,
             public_url, price, claimed_at, done_at, error_message
      FROM print_jobs
      ${where}
      ORDER BY created_at DESC
      LIMIT 300
      `,
      args
    );

    res.json({ ok: true, jobs: q.rows });
  } catch (e) {
    console.error("GET /api/dashboard/jobs error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Dashboard: mark job dispatched / reassign printer
 * POST /api/dashboard/job/:id/dispatch
 * body: { printerId, status? }
 */
app.post("/api/dashboard/job/:id/dispatch", requireDashboardKey, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid id" });

    const printerId = (req.body.printerId || "").toString().trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "printerId required" });

    const q = await pool.query(
      `
      UPDATE print_jobs
      SET printer_id = $1,
          status = 'pending',
          updated_at = NOW()
      WHERE id = $2
      RETURNING id, printer_id, status
      `,
      [printerId, id]
    );

    if (q.rows.length === 0) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, job: q.rows[0] });
  } catch (e) {
    console.error("POST /api/dashboard/job/:id/dispatch error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Dashboard: create a dispatch short link for a dispatch_queue item
 * POST /api/dispatch/link  (protected)
 * body: { dispatchId, email? }
 */
app.post("/api/dispatch/link", requireDashboardKey, async (req, res) => {
  try {
    const dispatchId = Number(req.body.dispatchId);
    const email = (req.body.email || "").toString().trim() || null;

    if (!Number.isFinite(dispatchId)) {
      return res.status(400).json({ ok: false, error: "dispatchId required" });
    }

    const q = await pool.query(
      `SELECT id, job_id, status, secure_token FROM dispatch_queue WHERE id = $1 LIMIT 1`,
      [dispatchId]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "dispatch not found" });
    }

    // optionally store email
    if (email) {
      await pool.query(
        `UPDATE dispatch_queue SET email = $1, updated_at = NOW() WHERE id = $2`,
        [email, dispatchId]
      );
    }

    const link = buildDispatchLink(req, dispatchId);
    return res.json({ ok: true, dispatchId, email, link });
  } catch (e) {
    console.error("POST /api/dispatch/link error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Short link route:
 * GET /d/:id  -> redirects to secure file token of that dispatch's job
 */
app.get("/d/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).send("Invalid link");

    const q = await pool.query(
      `
      SELECT dq.id, dq.status, pj.secure_token
      FROM dispatch_queue dq
      LEFT JOIN print_jobs pj ON pj.id = dq.job_id
      WHERE dq.id = $1
      LIMIT 1
      `,
      [id]
    );

    if (q.rows.length === 0) return res.status(404).send("Link not found");
    const row = q.rows[0];
    if (!row.secure_token) return res.status(404).send("File not found");

    return res.redirect(`/api/public/file/${row.secure_token}`);
  } catch (e) {
    console.error("GET /d/:id error:", e);
    return res.status(500).send("Server error");
  }
});

/* ------------------------------- STARTUP ---------------------------------- */
/**
 * CRITICAL: only ONE startup wrapper in the whole file.
 * This prevents the "Unexpected token }" issue you were seeing.
 */
(async () => {
  try {
    await ensureSchema();
    console.log("✅ MSTAF Core schema ready");
  } catch (e) {
    console.error("FATAL: ensureSchema failed:", e);
    process.exit(1);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ MSTAF Core running on port ${PORT}`);
    console.log("✅ PUBLIC_BASE_URL:", PUBLIC_BASE_URL || "(auto)");
    console.log("✅ WORKER_KEY:", WORKER_KEY ? "(set)" : "(missing)");
    console.log("✅ DEFAULT_AUTO_PRINTER_ID:", DEFAULT_AUTO_PRINTER_ID);
    console.log("✅ DASHBOARD auth:", DASHBOARD_KEY ? "(set)" : "(not set)");
  });
})();
