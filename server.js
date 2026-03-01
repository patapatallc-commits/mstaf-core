/**
 * MSTAF Server.js (Full Replacement)
 * - Upload route decides printer_id using RULES:
 *   Auto-print ONLY if: serviceType=print/printing AND paperSize=A4/LETTER AND NOT CARD
 *   Else -> printer_id="DISPATCH"
 *
 * - Worker next route only returns jobs for real auto printer AND A4/LETTER
 * - Worker safety endpoint to dispatch a job if it ever slips through
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

const BASE_URL =
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`;

const DEFAULT_AUTO_PRINTER_ID = process.env.DEFAULT_AUTO_PRINTER_ID || "PP-USA-001";
const WORKER_KEY = process.env.WORKER_KEY || process.env.PRINTER_KEY || "";
const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "";

// ---------- DB ----------
if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL in env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- Uploads folder ----------
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// serve uploads
app.use("/uploads", express.static(UPLOAD_DIR));

// Multer (multipart form-data)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const name = crypto.randomBytes(16).toString("hex") + ext;
    cb(null, name);
  },
});
const upload = multer({ storage });

// ---------- Helpers ----------
function requireWorkerAuth(req, res, next) {
  // Accept either header
  const k1 = req.headers["x-worker-key"];
  const k2 = req.headers["x-printer-key"];
  const provided = String(k1 || k2 || "").trim();

  // Allow single-key OR multi-key list
  const single = String(process.env.WORKER_KEY || process.env.PRINTER_KEY || "").trim();
  const list = String(process.env.WORKER_KEYS || "").trim();

  const allowed = new Set(
    [single, ...list.split(",")]
      .map((s) => String(s || "").trim())
      .filter(Boolean)
  );

  // Helpful log in Render logs (does NOT print the key)
  if (!allowed.size) {
    console.log("❌ WORKER auth: no keys configured (WORKER_KEY/PRINTER_KEY/WORKER_KEYS)");
    return res.status(500).json({ error: "Server WORKER key not configured" });
  }

  if (!allowed.has(provided)) {
    console.log("❌ WORKER auth failed:", {
      providedLen: provided.length,
      allowedCount: allowed.size,
      headerUsed: k1 ? "x-worker-key" : (k2 ? "x-printer-key" : "none"),
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function requireDashboardAuth(req, res, next) {
  const provided = String(req.headers["x-dashboard-key"] || "").trim();
  if (!DASHBOARD_KEY) return res.status(500).json({ error: "Server DASHBOARD_KEY not configured" });
  if (provided !== DASHBOARD_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function ensureSchema() {
  // Safe "IF NOT EXISTS" only (won't delete/alter your existing data)
  const sql = `
  CREATE TABLE IF NOT EXISTS print_jobs (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    status TEXT DEFAULT 'pending',
    printer_id TEXT DEFAULT 'DISPATCH',
    service_type TEXT DEFAULT 'print',
    paper_size TEXT DEFAULT 'A4',
    color_mode TEXT DEFAULT '',
    copies INT DEFAULT 1,
    pages INT DEFAULT 1,
    cost_cents INT DEFAULT 0,
    notes JSONB DEFAULT '{}'::jsonb,
    file_url TEXT DEFAULT '',
    file_path TEXT DEFAULT '',
    original_name TEXT DEFAULT '',
    mime_type TEXT DEFAULT '',
    error_message TEXT DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_print_jobs_printer ON print_jobs(printer_id);
  `;
  await pool.query(sql);
  console.log("✅ DB schema ensured");
}

function normalizeServiceType(body) {
  return String(body.serviceType || body.service_type || "print").toLowerCase().trim();
}

function normalizePaperSize(body) {
  return String(body.paperSize || body.paper_size || "A4").toUpperCase().trim();
}

function normalizeColorMode(body) {
  return String(body.colorMode || body.color_mode || "").toUpperCase().trim();
}

function parseIntSafe(v, fallback) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---------- Routes ----------
app.get("/", (_req, res) => {
  res.status(200).send("MSTAF Server OK");
});

/**
 * ✅ /api/upload
 * Supports multipart "file" upload from Shopify form.
 * Inserts job with correct printer_id routing:
 * - Auto-print only: serviceType=print/printing AND paperSize=A4/LETTER AND NOT CARD
 * - Else -> DISPATCH
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded (field name must be 'file')" });

    // normalize inputs
    const serviceType = normalizeServiceType(req.body);
    const paperSize = normalizePaperSize(req.body);
    const colorMode = normalizeColorMode(req.body);

    const copies = parseIntSafe(req.body.copies, 1);
    const pages = parseIntSafe(req.body.pages, 1);

    // dispatch-only cases
    const isEditing = serviceType === "edit" || serviceType === "editing";
    const isA3 = paperSize === "A3";
    const isCard =
      paperSize === "CARD" ||
      paperSize === "BUSINESS CARD" ||
      paperSize === "CARD ";

    const isAutoPrintable =
      !isEditing &&
      !isA3 &&
      !isCard &&
      (serviceType === "print" || serviceType === "printing") &&
      (paperSize === "A4" || paperSize === "LETTER");

    // IMPORTANT: only auto assign printer when auto-printable
    const printerIdToUse = isAutoPrintable ? DEFAULT_AUTO_PRINTER_ID : "DISPATCH";

    const fileUrl = `${BASE_URL}/uploads/${file.filename}`;

    // keep ALL extra fields in notes JSON so nothing breaks
    const notes = {
      ...req.body,
      serviceType,
      paperSize,
      colorMode,
      isAutoPrintable,
      routedPrinterId: printerIdToUse,
    };

    const insertSql = `
      INSERT INTO print_jobs
      (status, printer_id, service_type, paper_size, color_mode, copies, pages, notes, file_url, file_path, original_name, mime_type)
      VALUES
      ('pending', $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
      RETURNING *
    `;

    const params = [
      printerIdToUse,
      serviceType,
      paperSize,
      colorMode,
      copies,
      pages,
      JSON.stringify(notes),
      fileUrl,
      file.path,
      file.originalname || "",
      file.mimetype || "",
    ];

    const result = await pool.query(insertSql, params);
    const job = result.rows[0];

    return res.status(200).json({
      ok: true,
      job,
      file_url: fileUrl,
      printer_id: printerIdToUse,
      auto_print: isAutoPrintable,
    });
  } catch (err) {
    console.error("❌ /api/upload error:", err);
    return res.status(500).json({ error: "Upload failed", details: String(err.message || err) });
  }
});

/**
 * ✅ GET /api/worker/next
 * Worker polls this to get next job.
 *
 * HARD FILTER:
 * - status='pending'
 * - printer_id must match real printer (PP-USA-001)
 * - paper_size IN ('A4','LETTER')
 * - service_type IN ('print','printing')
 * - NOT CARD (extra safe)
 */
app.get("/api/worker/next", requireWorkerAuth, async (req, res) => {
  try {
    const printerId = String(req.query.printer_id || DEFAULT_AUTO_PRINTER_ID).trim();

    const sql = `
      SELECT *
      FROM print_jobs
      WHERE status='pending'
        AND printer_id = $1
        AND UPPER(COALESCE(paper_size,'')) IN ('A4','LETTER')
        AND LOWER(COALESCE(service_type,'')) IN ('print','printing')
        AND UPPER(COALESCE(paper_size,'')) <> 'CARD'
      ORDER BY created_at ASC
      LIMIT 1
    `;

    const r = await pool.query(sql, [printerId]);
    if (r.rows.length === 0) return res.status(204).send();

    const job = r.rows[0];

    // Mark printing BEFORE returning (prevents reprint loops)
    await pool.query(
      `UPDATE print_jobs SET status='printing' WHERE id=$1 AND status='pending'`,
      [job.id]
    );

    // re-read updated job
    const rr = await pool.query(`SELECT * FROM print_jobs WHERE id=$1`, [job.id]);
    return res.status(200).json(rr.rows[0]);
  } catch (err) {
    console.error("❌ /api/worker/next error:", err);
    return res.status(500).json({ error: "Worker next failed", details: String(err.message || err) });
  }
});

/**
 * ✅ POST /api/worker/update
 * Worker updates job status: done/error/printing
 */
app.post("/api/worker/update", requireWorkerAuth, async (req, res) => {
  try {
    const { id, status, error_message } = req.body || {};
    if (!id) return res.status(400).json({ error: "Missing id" });

    const safeStatus = String(status || "").toLowerCase().trim();
    if (!["printing", "done", "error", "pending"].includes(safeStatus)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const msg = String(error_message || "").slice(0, 2000);

    const sql = `
      UPDATE print_jobs
      SET status=$2,
          error_message = CASE WHEN $2='error' THEN $3 ELSE error_message END
      WHERE id=$1
      RETURNING *
    `;
    const r = await pool.query(sql, [id, safeStatus, msg]);
    return res.status(200).json({ ok: true, job: r.rows[0] });
  } catch (err) {
    console.error("❌ /api/worker/update error:", err);
    return res.status(500).json({ error: "Worker update failed", details: String(err.message || err) });
  }
});

/**
 * ✅ POST /api/worker/:id/dispatch
 * Worker can move any slipped job to DISPATCH (NO dashboard key needed)
 * This is the "SECOND FIX" safety path.
 */
app.post("/api/worker/:id/dispatch", requireWorkerAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const sql = `
      UPDATE print_jobs
      SET printer_id='DISPATCH',
          status='pending'
      WHERE id=$1
      RETURNING *
    `;
    const r = await pool.query(sql, [id]);
    return res.status(200).json({ ok: true, job: r.rows[0] });
  } catch (err) {
    console.error("❌ /api/worker/:id/dispatch error:", err);
    return res.status(500).json({ error: "Dispatch failed", details: String(err.message || err) });
  }
});

// ---------- Dashboard helpers (JSON) ----------
/**
 * List DISPATCH queue (pending)
 */
app.get("/api/dashboard/dispatch/pending", requireDashboardAuth, async (_req, res) => {
  try {
    const sql = `
      SELECT *
      FROM print_jobs
      WHERE status='pending'
        AND printer_id='DISPATCH'
      ORDER BY created_at DESC
      LIMIT 200
    `;
    const r = await pool.query(sql);
    res.status(200).json({ ok: true, jobs: r.rows });
  } catch (err) {
    console.error("❌ dispatch pending error:", err);
    res.status(500).json({ error: "Dashboard list failed", details: String(err.message || err) });
  }
});

/**
 * (Optional) Dashboard can route a DISPATCH job to a specific printer
 */
app.post("/api/dashboard/job/:id/assign", requireDashboardAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const printerId = String(req.body.printerId || "").trim();
    if (!printerId) return res.status(400).json({ error: "Missing printerId" });

    const sql = `
      UPDATE print_jobs
      SET printer_id=$2
      WHERE id=$1
      RETURNING *
    `;
    const r = await pool.query(sql, [id, printerId]);
    res.status(200).json({ ok: true, job: r.rows[0] });
  } catch (err) {
    console.error("❌ assign error:", err);
    res.status(500).json({ error: "Assign failed", details: String(err.message || err) });
  }
});
// ============================
// Health + Dashboard (RESTORE)
// ============================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// List jobs for dashboard (DISPATCH + blocked)
app.get("/api/dashboard/jobs", requireDashboardAuth, async (req, res) => {
  try {
    const printerId = String(req.query.printer_id || "DISPATCH").trim().toUpperCase();
    const limit = Math.min(parseInt(req.query.limit || "100", 10) || 100, 500);

    // NOTE: adjust column names if yours differ
    const sql = `
      SELECT id, created_at, status, printer_id, paper_size, color_mode, copies, file_url, error_message
      FROM print_jobs
      WHERE (printer_id = $1 OR status = 'blocked')
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const { rows } = await pool.query(sql, [printerId, limit]);
    res.json({ ok: true, printer_id: printerId, count: rows.length, rows });
  } catch (e) {
    console.error("dashboard/jobs error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Basic HTML dashboard page (uses ?key=YOUR_DASHBOARD_KEY)
app.get("/dashboard", async (req, res) => {
  // allow key via query string for browser access
  const key = String(req.query.key || "").trim();
  if (!process.env.DASHBOARD_KEY) return res.status(500).send("Server DASHBOARD_KEY not configured");
  if (key !== process.env.DASHBOARD_KEY) return res.status(401).send("Unauthorized (missing/invalid key)");

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>MSTAF Dashboard</title>
  <style>
    body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;padding:20px}
    .row{border:1px solid #ddd;border-radius:10px;padding:12px;margin:10px 0}
    .meta{color:#555;font-size:13px}
    code{background:#f4f4f4;padding:2px 6px;border-radius:6px}
    button{padding:8px 12px;border-radius:10px;border:1px solid #ccc;cursor:pointer}
  </style>
</head>
<body>
  <h2>MSTAF Dispatch Dashboard</h2>
  <div class="meta">Showing <code>DISPATCH</code> + <code>blocked</code> jobs</div>
  <p>
    <button onclick="loadJobs()">Refresh</button>
  </p>
  <div id="out">Loading...</div>

<script>
  const DASH_KEY = const DASH_KEY = ${JSON.stringify(key)};
  async function loadJobs(){
    const out = document.getElementById('out');
    out.innerHTML = "Loading...";
    const r = await fetch("/api/dashboard/jobs?printer_id=DISPATCH&limit=200", {
      headers: { "x-dashboard-key": DASH_KEY }
    });
    const j = await r.json();
    if(!j.ok){ out.innerHTML = "<pre>"+JSON.stringify(j,null,2)+"</pre>"; return; }
    out.innerHTML = j.rows.map(row => {
      return \`
        <div class="row">
          <div><b>ID:</b> \${row.id} &nbsp; <b>Status:</b> \${row.status} &nbsp; <b>Printer:</b> \${row.printer_id}</div>
          <div class="meta">
            <b>Paper:</b> \${row.paper_size || ""} &nbsp;
            <b>Color:</b> \${row.color_mode || ""} &nbsp;
            <b>Copies:</b> \${row.copies || 1} &nbsp;
            <b>Created:</b> \${row.created_at || ""}
          </div>
          \${row.file_url ? \`<div class="meta"><a href="\${row.file_url}" target="_blank">Open file</a></div>\` : ""}
          \${row.error_message ? \`<div class="meta"><b>Error:</b> \${row.error_message}</div>\` : ""}
        </div>
      \`;
    }).join("");
  }
  loadJobs();
</script>
</body>
</html>
  `);
});
// ---------- Start ----------
(async () => {
  try {
    await ensureSchema();
    app.listen(PORT, () => console.log(`✅ Server running on ${BASE_URL} (port ${PORT})`));
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
})();
