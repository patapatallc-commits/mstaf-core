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
  const st = String(serviceType || "").toLowerCase();
  const ps = String(paperSize || "").toUpperCase();

  // Only auto-print real A4 printing jobs
  if (st !== "print" && st !== "printing") return false;
  if (ps !== "A4" && ps !== "LETTER") return false;

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
  try { console.log("UPLOAD BODY:", req.body);
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file" });

    const printerId = String(req.body.printerId || req.body.printer_id || DEFAULT_AUTO_PRINTER_ID).trim();
    let detailsObj = {};
try {
  if (req.body.details) {
    detailsObj = JSON.parse(req.body.details);
  }
} catch (e) {
  console.log("Failed to parse details JSON");
}

const paperSize = normalizePaper(
  req.body.paperSize ||
  req.body.paper_size ||
  detailsObj.paperSize
);

const serviceType = normalizeServiceType(
  req.body.serviceType ||
  req.body.service_type ||
  detailsObj.serviceType
);

const colorMode = normalizeColor(
  req.body.colorMode ||
  req.body.color_mode ||
  req.body.color
);

const pages = Math.max(Number(req.body.pages || 1), 1);
const copies = Math.max(Number(req.body.copies || 1), 1);

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
const autoPrintable = (status === "queued");
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

    // ✅ DISPATCH QUEUE CREATION (FIX)
// If NOT auto-printable (A3/CARD/Editing), put ALL copies (1..copies) into dispatch_queue as pending.
// If auto-printable (A4 print), auto-print copy #1 and dispatch only copy #2..copies.
// ✅ DISPATCH QUEUE CREATION (FIX)
if (!autoPrintable) {
  // A3 / CARD / Editing → ALL copies go to dispatch queue
  for (let i = 1; i <= copies; i++) {
    await pool.query(
      `INSERT INTO dispatch_queue(job_id, copy_index, status, created_at, updated_at)
       VALUES ($1,$2,'pending',NOW(),NOW())`,
      [jobId, i]
    );
  }
} else if (copies > 1) {
  // A4 auto-print → only copies 2..N go to dispatch
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
app.get("/dashboard", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>MSTAF Worker Dashboard</title>
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#0b1220;color:#e5e7eb;margin:0}
    .wrap{max-width:1200px;margin:0 auto;padding:24px}
    .card{background:#0f1a33;border:1px solid #223055;border-radius:14px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
    h1{margin:0 0 10px;font-size:22px}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}
    input,select,button{border-radius:10px;border:1px solid #2a3a66;background:#0b1633;color:#e5e7eb;padding:10px 12px}
    button{cursor:pointer;border:0;background:#facc15;color:#111827;font-weight:800}
    button.secondary{background:#1f2a44;color:#e5e7eb;border:1px solid #2a3a66}
    table{width:100%;border-collapse:collapse;margin-top:12px}
    th,td{border-bottom:1px solid #223055;padding:10px;text-align:left;font-size:13px;vertical-align:top}
    th{color:#93c5fd;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
    .pill{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;border:1px solid #2a3a66}
    .ok{color:#34d399}.bad{color:#fb7185}
    .small{font-size:12px;color:#a3b1d6}
    a{color:#93c5fd}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>✅ MSTAF Worker Dashboard (Dispatch Queue)</h1>
      <div class="small">Shows copy #2+ jobs routed to humans. Requires DASHBOARD_KEY.</div>

      <div class="row">
        <button class="secondary" onclick="setKey()">Set/Change Key</button>
        <label class="small">Status:</label>
        <select id="status">
          <option value="pending">pending</option>
          <option value="claimed">claimed</option>
          <option value="assigned">assigned</option>
          <option value="emailed">emailed</option>
          <option value="done">done</option>
        </select>
        <button onclick="load()">Refresh</button>
        <span id="msg" class="small"></span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Dispatch</th>
            <th>Job</th>
            <th>Copy</th>
            <th>Specs</th>
            <th>Customer</th>
            <th>Instructions</th>
            <th>Assigned Printer</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="tb"></tbody>
      </table>
    </div>
  </div>

<script>
const BASE = location.origin;

function getKey(){
  return localStorage.getItem("DASH_KEY") || "";
}
function setKey(){
  const v = prompt("Enter DASHBOARD_KEY (from Render env):", getKey() || "");
  if (v !== null) localStorage.setItem("DASH_KEY", v.trim());
}

async function api(path, method="GET", body=null){
  const key = getKey();
  if(!key) throw new Error("Missing DASHBOARD_KEY. Click Set/Change Key.");
  const opts = { method, headers: { "x-dashboard-key": key } };
  if(body){
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, opts);
  const t = await r.text();
  let j; try{ j = JSON.parse(t); }catch{ j = { ok:false, raw:t }; }
  if(!r.ok) throw new Error((j && j.error) ? j.error : ("HTTP "+r.status));
  return j;
}

function esc(s){ return String(s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

async function load(){
  const msg = document.getElementById("msg");
  msg.textContent = "Loading...";
  msg.className = "small";
  const status = document.getElementById("status").value;
  try{
    const j = await api("/api/dispatch/queue?status=" + encodeURIComponent(status) + "&limit=200");
    render(j.items || []);
    msg.textContent = "Loaded " + (j.count || 0) + " items";
  }catch(e){
    msg.textContent = "Error: " + e.message;
    msg.className = "small bad";
  }
}

function render(items){
  const tb = document.getElementById("tb");
  tb.innerHTML = "";
  for(const it of items){
    const specs = \`\${esc(it.paper_size)} / \${esc(it.color_mode)} / pages:\${esc(it.pages)} / $ \${esc(it.price)}\`;
    const cust = \`\${esc(it.customer_city||"")} \${esc(it.customer_country||"")}<div class="small">\${esc(it.customer_email||"")}</div>\`;
    const instr = \`<div class="small">\${esc(it.instructions||"")}</div>\`;
    const assigned = esc(it.assigned_printer_id||"");
    const agent = (it.agent_name||it.agent_location) ? \`<div class="small">Agent: \${esc(it.agent_name||"")} (\${esc(it.agent_location||"")})</div>\` : "";
    const row = document.createElement("tr");
    row.innerHTML = \`
      <td><span class="pill">\${esc(it.status)}</span><div class="small">#\${esc(it.id)}</div>\${agent}</td>
      <td>#\${esc(it.job_id)}</td>
      <td>\${esc(it.copy_index)}</td>
      <td>\${specs}</td>
      <td>\${cust}</td>
      <td>\${instr}</td>
      <td><div class="small">\${assigned || "-"}</div></td>
      <td>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input style="width:180px" id="p_\${it.id}" placeholder="Printer ID (e.g. PP-NG-LAG-001)" value="\${assigned}"/>
          <button onclick="assign(\${it.id})">Assign</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <input style="width:180px" id="e_\${it.id}" placeholder="Email for link" value="\${esc(it.customer_email||"")}"/>
          <button class="secondary" onclick="sendLink(\${it.id})">Create Link</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <input style="width:180px" id="n_\${it.id}" placeholder="Notes (optional)"/>
          <button class="secondary" onclick="done(\${it.id})">Mark Done</button>
        </div>
      </td>
    \`;
    tb.appendChild(row);
  }
}

async function assign(dispatchId){
  const printerId = document.getElementById("p_"+dispatchId).value.trim();
  if(!printerId) return alert("Enter printer ID");
  await api("/api/dispatch/assign","POST",{dispatchId, printerId});
  await load();
}

async function sendLink(dispatchId){
  const email = document.getElementById("e_"+dispatchId).value.trim();
  if(!email) return alert("Enter email");
  const r = await api("/api/dispatch/email","POST",{dispatchId, email});
  alert("Secure link generated:\\n" + r.link);
  await load();
}

async function done(dispatchId){
  const notes = document.getElementById("n_"+dispatchId).value.trim();
  await api("/api/dispatch/done","POST",{dispatchId, notes});
  await load();
}

setKey();
load();
</script>
</body>
</html>`);
});
app.get("/agent", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>MSTAF Agent Dashboard</title>
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#0b1220;color:#e5e7eb;margin:0}
    .wrap{max-width:1100px;margin:0 auto;padding:24px}
    .card{background:#0f1a33;border:1px solid #223055;border-radius:14px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
    h1{margin:0 0 10px;font-size:22px}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}
    input,select,button{border-radius:10px;border:1px solid #2a3a66;background:#0b1633;color:#e5e7eb;padding:10px 12px}
    button{cursor:pointer;border:0;background:#34d399;color:#06251a;font-weight:900}
    button.secondary{background:#1f2a44;color:#e5e7eb;border:1px solid #2a3a66}
    table{width:100%;border-collapse:collapse;margin-top:12px}
    th,td{border-bottom:1px solid #223055;padding:10px;text-align:left;font-size:13px;vertical-align:top}
    th{color:#93c5fd;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
    .small{font-size:12px;color:#a3b1d6}
    .pill{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;border:1px solid #2a3a66}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>🧑🏽‍💼 MSTAF Agent Dashboard</h1>
      <div class="small">Agents claim pending dispatch items and coordinate printing. Uses DASHBOARD_KEY for now.</div>

      <div class="row">
        <button class="secondary" onclick="setKey()">Set/Change Key</button>
        <input id="agentName" placeholder="Your name (agent)" style="width:220px"/>
        <input id="agentLoc" placeholder="City, Country" style="width:220px"/>
        <button onclick="load()">Refresh</button>
        <span id="msg" class="small"></span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Dispatch</th>
            <th>Job</th>
            <th>Copy</th>
            <th>Specs</th>
            <th>Customer</th>
            <th>Instructions</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="tb"></tbody>
      </table>
    </div>
  </div>

<script>
const BASE = location.origin;
function getKey(){ return localStorage.getItem("DASH_KEY") || ""; }
function setKey(){
  const v = prompt("Enter DASHBOARD_KEY (from Render env):", getKey() || "");
  if (v !== null) localStorage.setItem("DASH_KEY", v.trim());
}
async function api(path, method="GET", body=null){
  const key = getKey();
  if(!key) throw new Error("Missing DASHBOARD_KEY. Click Set/Change Key.");
  const opts = { method, headers: { "x-dashboard-key": key } };
  if(body){
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, opts);
  const t = await r.text();
  let j; try{ j = JSON.parse(t); }catch{ j = { ok:false, raw:t }; }
  if(!r.ok) throw new Error((j && j.error) ? j.error : ("HTTP "+r.status));
  return j;
}
function esc(s){ return String(s||"").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

async function load(){
  const msg = document.getElementById("msg");
  msg.textContent = "Loading...";
  try{
    const j = await api("/api/dispatch/queue?status=pending&limit=200");
    render(j.items || []);
    msg.textContent = "Loaded " + (j.count || 0) + " pending items";
  }catch(e){
    msg.textContent = "Error: " + e.message;
  }
}

function render(items){
  const tb = document.getElementById("tb");
  tb.innerHTML = "";
  for(const it of items){
    const specs = \`\${esc(it.paper_size)} / \${esc(it.color_mode)} / pages:\${esc(it.pages)} / $ \${esc(it.price)}\`;
    const cust = \`\${esc(it.customer_city||"")} \${esc(it.customer_country||"")}<div class="small">\${esc(it.customer_email||"")}</div>\`;
    const instr = \`<div class="small">\${esc(it.instructions||"")}</div>\`;
    const row = document.createElement("tr");
    row.innerHTML = \`
      <td><span class="pill">\${esc(it.status)}</span><div class="small">#\${esc(it.id)}</div></td>
      <td>#\${esc(it.job_id)}</td>
      <td>\${esc(it.copy_index)}</td>
      <td>\${specs}</td>
      <td>\${cust}</td>
      <td>\${instr}</td>
      <td>
        <input id="notes_\${it.id}" placeholder="Notes (optional)" style="width:220px"/>
        <div style="margin-top:8px">
          <button onclick="claim(\${it.id})">Claim</button>
        </div>
      </td>
    \`;
    tb.appendChild(row);
  }
}

async function claim(dispatchId){
  const agentName = document.getElementById("agentName").value.trim();
  const agentLocation = document.getElementById("agentLoc").value.trim();
  const notes = document.getElementById("notes_"+dispatchId).value.trim();

  if(!agentName || !agentLocation) return alert("Enter your name and location first.");

  await api("/api/dispatch/claim","POST",{dispatchId, agentName, agentLocation, notes});
  alert("Claimed. Now a worker can Assign printer or Email link.");
  await load();
}

setKey();
load();
</script>
</body>
</html>`);
});
// -------------------- Startup (NO top-level await) --------------------
// ===============================
// DASHBOARD AUTH (x-dashboard-key)
// ===============================
function requireDashboardKey(req, res, next) {
  const key = req.headers["x-dashboard-key"];
  const expected = process.env.DASHBOARD_KEY;

  if (!expected) {
    return res.status(500).json({ ok: false, error: "DASHBOARD_KEY not set on server" });
  }

  if (!key || key !== expected) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

// ===============================
// DISPATCH LINK ROUTES
// ===============================
function buildDispatchLink({ dispatchId, email }) {
  const base = process.env.PUBLIC_BASE_URL || "https://mstaf-core-1.onrender.com";
  const params = new URLSearchParams();
  params.set("dispatchId", String(dispatchId));
  if (email) params.set("email", String(email));
  return `${base}/dispatch?${params.toString()}`;
}

app.post("/api/dispatch/create-link", requireDashboardKey, (req, res) => {
  const { dispatchId, email } = req.body || {};
  if (!dispatchId) {
    return res.status(400).json({ ok: false, error: "dispatchId required" });
  }
  const link = buildDispatchLink({ dispatchId, email });
  return res.json({ ok: true, dispatchId, email: email || null, link });
});

app.post("/api/dispatch/link", requireDashboardKey, (req, res) => {
  const { dispatchId, email } = req.body || {};
  if (!dispatchId) {
    return res.status(400).json({ ok: false, error: "dispatchId required" });
  }
  const link = buildDispatchLink({ dispatchId, email });
  return res.json({ ok: true, dispatchId, email: email || null, link });
});
app.post("/api/dispatch/link", requireDashboardKey, (req, res) => {
  const { dispatchId, email } = req.body || {};
  if (!dispatchId) {
    return res.status(400).json({ ok: false, error: "dispatchId required" });
  }
  const link = buildDispatchLink({ dispatchId, email });
  return res.json({ ok: true, dispatchId, email: email || null, link });
});


// ✅ Short dispatch link: /d/:id  -> redirects to secure token file link
app.get("/d/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).send("Invalid link");
    }

    const q = await pool.query(
      `SELECT id, status, secure_token
       FROM dispatch_queue
       WHERE id = $1
       LIMIT 1`,
      [id]
    );

    if (q.rows.length === 0) {
      return res.status(404).send("Link not found");
    }

    const row = q.rows[0];

    if (String(row.status || "").toLowerCase() === "done") {
      return res.status(410).send("This link has expired.");
    }

    if (!row.secure_token) {
      return res.status(404).send("Secure token missing.");
    }

    return res.redirect(`/api/public/file/${row.secure_token}`);
  } catch (e) {
    console.error("GET /d/:id error:", e);
    return res.status(500).send("Server error");
  }
});
    if (q.rows.length === 0) return res.status(404).send("Link not found");

    const row = q.rows[0];

    if (String(row.status || "").toLowerCase() === "done") {
      return res.status(410).send("This link has expired.");
    }

    if (!row.secure_token) {
      return res.status(404).send("Secure token missing.");
    }

    return res.redirect(`/api/public/file/${row.secure_token}`);
  } catch (e) {
    console.error("GET /d/:id error:", e);
    return res.status(500).send("Server error");
  }
});

// ------------------ Startup ------------------
(async () => {
  try {
    await ensureSchema();
    console.log("✅ MSTAF Core schema ready");
  } catch (e) {
    console.error("FATAL: ensureSchema failed:", e);
    process.exit(1);
  }

  const PORT = Number(process.env.PORT || 10000);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ MSTAF Core running on port ${PORT}`);
    console.log("✅ PUBLIC_BASE_URL:", PUBLIC_BASE_URL || "(auto)");
    console.log("✅ WORKER_KEY:", WORKER_KEY ? "(set)" : "(missing)");
    console.log("✅ DEFAULT_AUTO_PRINTER_ID:", DEFAULT_AUTO_PRINTER_ID);
    console.log("✅ DASHBOARD auth:", DASHBOARD_KEY ? "(set)" : "(not set)");
  });
})();
