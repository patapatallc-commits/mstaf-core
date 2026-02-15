/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * ✅ Upload (POST /api/upload)
 * ✅ Serve uploads correctly on Render (/uploads)
 * ✅ Worker auth (X-Worker-Key)
 * ✅ Printer polling (GET /jobs/next?printerId=...)
 * ✅ Status update (POST /jobs/:id/status)
 * ✅ Debug uploads (GET /debug/uploads)
 * ✅ Admin dashboard (GET /dashboard?key=...)
 * ✅ Editor dashboard (GET /editor?key=...)
 * ✅ Customer instructions stored + shown
 * ✅ Routing: printer worker only pulls print jobs; editor sees edit jobs
 */

"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// --------------------
// Config / ENV
// --------------------
const PORT = process.env.PORT || 10000;

// Worker auth (already working—do not change)
const WORKER_KEY = process.env.WORKER_KEY || "";

// Dashboard keys (Option B)
const ADMIN_KEY = process.env.ADMIN_KEY || process.env.MSTAF_ADMIN_KEY || "";
const EDITOR_KEY = process.env.EDITOR_KEY || "";

// Optional default printer id
const DEFAULT_PRINTER_ID = process.env.PRINTER_ID || "PP-USA-001";

// Postgres
const DATABASE_URL = process.env.DATABASE_URL || "";

// --------------------
// Middleware
// --------------------
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// --------------------
// Postgres
// --------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// Ensure DB table exists (lightweight bootstrap)
async function ensureSchema() {
  const sql = `
  CREATE TABLE IF NOT EXISTS print_jobs (
    id SERIAL PRIMARY KEY,
    id_text TEXT,
    printer_id TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    service_type TEXT DEFAULT 'print',
    paper_size TEXT DEFAULT 'A4',
    color_type TEXT DEFAULT 'bw',
    copies INT NOT NULL DEFAULT 1,
    pages INT NOT NULL DEFAULT 1,
    customer_instructions TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Backward-safe: add instructions column if table existed before without it
  ALTER TABLE print_jobs
    ADD COLUMN IF NOT EXISTS customer_instructions TEXT;

  -- Helpful index
  CREATE INDEX IF NOT EXISTS idx_print_jobs_queue
    ON print_jobs (printer_id, status, created_at);

  CREATE INDEX IF NOT EXISTS idx_print_jobs_service
    ON print_jobs (service_type, status, created_at);
  `;
  await pool.query(sql);
}

ensureSchema().catch((e) => console.error("SCHEMA INIT ERROR:", e));

// --------------------
// Uploads directory (Render-safe) ✅
// --------------------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve uploads from absolute path ✅
app.use("/uploads", express.static(uploadsDir));

// Debug route to prove files exist on Render ✅
app.get("/debug/uploads", (req, res) => {
  try {
    const files = fs.readdirSync(uploadsDir);
    res.json({
      ok: true,
      uploadsDir,
      count: files.length,
      files: files.slice(0, 50),
    });
  } catch (err) {
    res.json({ ok: false, uploadsDir, error: String(err) });
  }
});

// --------------------
// Multer storage (MUST match uploadsDir) ✅
// --------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = String(file.originalname || "file")
      .replace(/[^\w.\-()]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");

    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({ storage });

// --------------------
// Helpers
// --------------------
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.get("host");
  return `${proto}://${host}`;
}

function requireWorkerAuth(req, res, next) {
  // Worker must send: X-Worker-Key: <secret>
  if (!WORKER_KEY) {
    console.warn("⚠️ WORKER_KEY is not set. Worker auth is effectively disabled.");
    return next();
  }

  const key = req.header("x-worker-key") || "";
  if (key !== WORKER_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized worker" });
  }
  next();
}

// Dashboard auth via ?key=... or header x-dashboard-key
function requireKey(expectedKey) {
  return (req, res, next) => {
    const key = (req.query.key || req.headers["x-dashboard-key"] || "").toString().trim();
    if (!expectedKey || expectedKey.length < 10) {
      return res.status(500).send("Server missing required key (ADMIN_KEY / EDITOR_KEY).");
    }
    if (key !== expectedKey) return res.status(401).send("Unauthorized");
    next();
  };
}

function isEditingService(serviceType) {
  const t = (serviceType || "").toString().toLowerCase();
  // matches: photo_edit, video_edit, editing, image editing, etc.
  return t.includes("edit");
}

function isPrintService(serviceType) {
  const t = (serviceType || "").toString().toLowerCase();
  // Treat blank as print for backward compatibility
  if (!t) return true;
  return !t.includes("edit") && (t === "print" || t.includes("print"));
}

function escapeHtml(s = "") {
  return s
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderJobsPage(title, jobs, role) {
  const rows = jobs
    .map((j) => {
      const instructions = j.customer_instructions || "";
      const fileUrl = j.file_url || "";
      const status = j.status || "queued";
      const created = j.created_at || "";
      const service = (j.service_type || "").toString();
      const paper = j.paper_size || "";
      const color = j.color_type || "";
      const copies = j.copies ?? "";
      const pages = j.pages ?? "";
      const id = j.id_text || j.id || "";
      const printer = j.printer_id || "";

      return `
        <tr>
          <td>${escapeHtml(id)}</td>
          <td>${escapeHtml(service)}</td>
          <td>${escapeHtml(status)}</td>
          <td>${escapeHtml(printer)}</td>
          <td>${escapeHtml(`${paper} • ${color} • copies:${copies} • pages:${pages}`)}</td>
          <td style="max-width:420px; white-space:pre-wrap;">${escapeHtml(instructions)}</td>
          <td>${fileUrl ? `<a href="${escapeHtml(fileUrl)}" target="_blank">Open file</a>` : ""}</td>
          <td>${escapeHtml(created)}</td>
        </tr>
      `;
    })
    .join("");

  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body{font-family:Arial,system-ui; margin:18px; background:#0b1220; color:#e9eefc;}
      .card{background:#121c33; border:1px solid #223154; border-radius:12px; padding:16px; box-shadow:0 8px 22px rgba(0,0,0,.25);}
      h1{margin:0 0 10px 0; font-size:20px;}
      .meta{opacity:.85; margin-bottom:12px; font-size:13px;}
      table{width:100%; border-collapse:collapse; overflow:hidden; border-radius:10px;}
      th,td{padding:10px; border-bottom:1px solid #223154; vertical-align:top; font-size:13px;}
      th{background:#182648; text-align:left;}
      a{color:#8ab4ff;}
      .pill{display:inline-block; padding:2px 8px; border-radius:999px; background:#1f2f57; border:1px solid #2b3d6c; font-size:12px;}
      .hint{opacity:.8; margin-top:10px; font-size:12px;}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${escapeHtml(title)} <span class="pill">${escapeHtml(role)}</span></h1>
      <div class="meta">Jobs shown: <b>${jobs.length}</b> • Refresh to update</div>
      <table>
        <thead>
          <tr>
            <th>Job ID</th>
            <th>Service</th>
            <th>Status</th>
            <th>Printer</th>
            <th>Specs</th>
            <th>Customer Instructions</th>
            <th>File</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          ${rows || `<tr><td colspan="8">No jobs found.</td></tr>`}
        </tbody>
      </table>
      <div class="hint">
        Tip: Print jobs show as <b>print</b>. Editing jobs show as <b>photo_edit</b> / <b>video_edit</b>.
      </div>
    </div>
  </body>
  </html>`;
}

// --------------------
// Routes
// --------------------
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({
      ok: true,
      db: r.rows?.[0]?.ok === 1,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "DB not reachable", details: String(e) });
  }
});

/**
 * Admin dashboard (you only)
 * GET /dashboard?key=ADMIN_KEY (or MSTAF_ADMIN_KEY)
 */
app.get("/dashboard", requireKey(ADMIN_KEY), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM print_jobs
      ORDER BY created_at DESC
      LIMIT 200
    `);
    res.setHeader("Content-Type", "text/html");
    res.send(renderJobsPage("MSTAF Admin Dashboard", rows, "ADMIN"));
  } catch (e) {
    console.error("dashboard error:", e);
    res.status(500).send("Dashboard error");
  }
});

/**
 * Editor dashboard (editors only)
 * GET /editor?key=EDITOR_KEY
 */
app.get("/editor", requireKey(EDITOR_KEY), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *
      FROM print_jobs
      ORDER BY created_at DESC
      LIMIT 200
    `);
    const editorRows = rows.filter((j) => isEditingService(j.service_type));
    res.setHeader("Content-Type", "text/html");
    res.send(renderJobsPage("MSTAF Editor Dashboard", editorRows, "EDITOR"));
  } catch (e) {
    console.error("editor error:", e);
    res.status(500).send("Editor page error");
  }
});

/**
 * Upload job (Shopify / Web portal)
 * multipart/form-data:
 * - file: (required)
 * - printerId (optional)
 * - copies (optional)
 * - pages (optional)
 * - paper_size (optional: A4/A3/Letter/etc)
 * - color_type (optional: bw/color)
 * - service_type (optional: print / photo_edit / video_edit)
 * - instructions / customer_instructions (optional)
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const printerId = (req.body.printerId || DEFAULT_PRINTER_ID).trim();
    const copies = Math.max(1, parseInt(req.body.copies || "1", 10) || 1);
    const pages = Math.max(1, parseInt(req.body.pages || "1", 10) || 1);
    const paperSize = (req.body.paper_size || "A4").trim();
    const colorType = (req.body.color_type || "bw").trim();
    const serviceType = (req.body.service_type || "print").trim();

    const instructionsRaw =
      (req.body.customer_instructions ||
        req.body.instructions ||
        req.body.note ||
        req.body.notes ||
        "").toString();

    // keep instructions length sane
    const customerInstructions = instructionsRaw.slice(0, 3000);

    const baseUrl = getBaseUrl(req);
    const fileUrl = `${baseUrl}/uploads/${encodeURIComponent(req.file.filename)}`;
    const idText = `PP-${Date.now()}`;

    const insertSql = `
      INSERT INTO print_jobs
        (id_text, printer_id, file_url, file_name, status, service_type, paper_size, color_type, copies, pages, customer_instructions)
      VALUES
        ($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10)
      RETURNING *;
    `;

    const result = await pool.query(insertSql, [
      idText,
      printerId,
      fileUrl,
      req.file.filename,
      serviceType,
      paperSize,
      colorType,
      copies,
      pages,
      customerInstructions,
    ]);

    const job = result.rows[0];

    res.json({
      ok: true,
      job_id: job.id,
      id_text: job.id_text,
      printer_id: job.printer_id,
      file_url: job.file_url,
      file_name: job.file_name,
      copies: job.copies,
      pages: job.pages,
      paper_size: job.paper_size,
      color_type: job.color_type,
      service_type: job.service_type,
      customer_instructions: job.customer_instructions || "",
      status: job.status,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

/**
 * Worker polling: get next queued PRINT job only
 * GET /jobs/next?printerId=PP-USA-001
 *
 * IMPORTANT: This prevents editor jobs from going to the printer.
 */
app.get("/jobs/next", async (req, res) => {
  try {
    const printerId = (req.query.printerId || DEFAULT_PRINTER_ID).trim();

    // Oldest queued PRINT job only
    const q = `
      SELECT *
      FROM print_jobs
      WHERE printer_id=$1
        AND status='queued'
        AND (
          service_type IS NULL
          OR service_type = 'print'
          OR service_type ILIKE '%print%'
        )
        AND service_type NOT ILIKE '%edit%'
      ORDER BY created_at ASC
      LIMIT 1;
    `;
    const r = await pool.query(q, [printerId]);

    if (!r.rows.length) {
      return res.json({ ok: true, job: null });
    }

    const job = r.rows[0];

    return res.json({
      ok: true,
      job: {
        id: job.id,
        id_text: job.id_text,
        printer_id: job.printer_id,
        file_url: job.file_url,
        file_name: job.file_name,
        copies: job.copies,
        pages: job.pages,
        paper_size: job.paper_size,
        color_type: job.color_type,
        service_type: job.service_type,
        customer_instructions: job.customer_instructions || "",
        status: job.status,
      },
    });
  } catch (err) {
    console.error("JOBS NEXT ERROR:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Optional list endpoint
 * GET /jobs?printerId=...&status=queued
 */
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || DEFAULT_PRINTER_ID).trim();
    const status = (req.query.status || "").trim();

    const params = [printerId];
    let where = "printer_id=$1";

    if (status) {
      params.push(status);
      where += ` AND status=$${params.length}`;
    }

    const q = `
      SELECT *
      FROM print_jobs
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT 50;
    `;

    const r = await pool.query(q, params);
    res.json({ ok: true, jobs: r.rows });
  } catch (err) {
    console.error("JOBS LIST ERROR:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * Worker status update
 * POST /jobs/:id/status
 * headers: X-Worker-Key: <secret>
 * body: { status: "printing" | "done" | "error" }
 */
app.post("/jobs/:id/status", requireWorkerAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid job id" });

    const status = String(req.body.status || "").trim();
    const allowed = new Set(["queued", "printing", "done", "error"]);
    if (!allowed.has(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }

    const q = `
      UPDATE print_jobs
      SET status=$1, updated_at=NOW()
      WHERE id=$2
      RETURNING *;
    `;
    const r = await pool.query(q, [status, id]);

    if (!r.rows.length) return res.status(404).json({ ok: false, error: "Job not found" });

    res.json({ ok: true, job: r.rows[0] });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Root
app.get("/", (req, res) => {
  res.send("MSTAF CORE is running ✅");
});

// --------------------
// Start
// --------------------
app.listen(PORT, () => {
  console.log(`MSTAF CORE listening on port ${PORT}`);
  console.log(`Uploads dir: ${uploadsDir}`);
});
