/**
 * MSTAF Core (Render) - server.js (FULL REPLACEMENT)
 * - Dashboard auth accepts header OR ?key=
 * - Dashboard refresh uses key in query + never hangs
 * - Worker polling + status updates
 * - Upload endpoint creates print job and returns file link
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;

// Public base URL (Render)
const BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`;

// Auth keys
const DASHBOARD_KEY = String(process.env.DASHBOARD_KEY || "").trim();

// Worker key can come from either env var (compat)
const WORKER_KEY =
  String(process.env.WORKER_KEY || "").trim() ||
  String(process.env.PRINTER_KEY || "").trim();

// Default printer_id (worker can pass printer_id too)
const DEFAULT_PRINTER_ID = String(process.env.PRINTER_ID || "PP-USA-001").trim();

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

// ---------- UPLOADS ----------
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = (file.originalname || "file")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(-80);
    cb(null, `${Date.now()}_${Math.random().toString(16).slice(2)}_${safe}`);
  },
});

const upload = multer({ storage });

// Serve uploaded files
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "1h" }));

// ---------- HELPERS ----------
function requireWorkerAuth(req, res, next) {
  const provided = String(
    req.headers["x-worker-key"] ||
      req.headers["x-printer-key"] ||
      ""
  ).trim();

  if (!WORKER_KEY) {
    return res.status(500).json({ error: "Server WORKER_KEY/PRINTER_KEY not configured" });
  }
  if (provided !== WORKER_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ✅ FIX: accept dashboard key from header OR query (?key=)
function requireDashboardAuth(req, res, next) {
  const provided = String(
    req.headers["x-dashboard-key"] ||
      req.query.key || // ✅ allow ?key=...
      ""
  ).trim();

  if (!DASHBOARD_KEY) {
    return res.status(500).json({ error: "Server DASHBOARD_KEY not configured" });
  }
  if (provided !== DASHBOARD_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Costs (your rules)
function calcUnitPrice(colorMode) {
  const m = String(colorMode || "").toLowerCase();
  // "bw", "black", "blackwhite", etc
  if (m.includes("bw") || m.includes("black")) return 0.25;
  return 0.5; // color
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// ---------- HEALTH ----------
app.get("/", (req, res) => res.status(200).send("MSTAF Core is running ✅"));
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: r.rows?.[0]?.ok === 1, base_url: BASE_URL });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- CREATE PRINT JOB (UPLOAD) ----------
// Form-data fields expected (flexible):
// - printer_id (optional, default DISPATCH or a printer)
// - paper_size, color_mode, copies, pages
// - customer_name, customer_email, country, city, notes
app.post("/api/print-jobs", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const printer_id = String(req.body.printer_id || "DISPATCH").trim(); // default route to DISPATCH
    const paper_size = String(req.body.paper_size || "A4").trim();
    const color_mode = String(req.body.color_mode || "BW").trim();

    const copies = num(req.body.copies, 1);
    const pages = num(req.body.pages, 1);

    const customer_name = String(req.body.customer_name || "").trim();
    const customer_email = String(req.body.customer_email || "").trim();
    const country = String(req.body.country || "").trim();
    const city = String(req.body.city || "").trim();
    const notes = String(req.body.notes || "").trim();

    const file_url = `${BASE_URL}/uploads/${encodeURIComponent(req.file.filename)}`;
    const original_name = String(req.file.originalname || "").trim();

    const unit = calcUnitPrice(color_mode);
    const total_cost = Number((unit * pages * copies).toFixed(2));

    // Create row (keep it simple and tolerant)
    // Requires a table named print_jobs. Common columns used here:
    // id SERIAL PK, status TEXT, printer_id TEXT, file_url TEXT, original_name TEXT,
    // paper_size TEXT, color_mode TEXT, copies INT, pages INT,
    // total_cost NUMERIC, customer_name TEXT, customer_email TEXT,
    // country TEXT, city TEXT, notes TEXT, created_at TIMESTAMP DEFAULT NOW()
    const q = `
      INSERT INTO print_jobs
        (status, printer_id, file_url, original_name, paper_size, color_mode, copies, pages, total_cost,
         customer_name, customer_email, country, city, notes)
      VALUES
        ('pending', $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13)
      RETURNING *;
    `;

    const values = [
      printer_id,
      file_url,
      original_name,
      paper_size,
      color_mode,
      copies,
      pages,
      total_cost,
      customer_name,
      customer_email,
      country,
      city,
      notes,
    ];

    const created = await pool.query(q, values);

    res.status(201).json({
      ok: true,
      job: created.rows[0],
      file_url,
      pricing: { unit_price: unit, pages, copies, total_cost },
    });
  } catch (e) {
    res.status(500).json({ error: e.message, hint: "Check print_jobs table columns/schema." });
  }
});

// ---------- WORKER: CLAIM NEXT JOB ----------
app.get("/api/worker/next", requireWorkerAuth, async (req, res) => {
  const printer_id = String(req.query.printer_id || DEFAULT_PRINTER_ID).trim();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Use SKIP LOCKED to prevent two workers grabbing same job
    const sel = await client.query(
      `
      SELECT *
      FROM print_jobs
      WHERE status = 'pending'
        AND printer_id = $1
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1;
      `,
      [printer_id]
    );

    if (sel.rowCount === 0) {
      await client.query("COMMIT");
      return res.json({ ok: true, job: null });
    }

    const job = sel.rows[0];

    // Mark as printing immediately (prevents loops)
    const upd = await client.query(
      `
      UPDATE print_jobs
      SET status = 'printing'
      WHERE id = $1
      RETURNING *;
      `,
      [job.id]
    );

    await client.query("COMMIT");

    res.json({ ok: true, job: upd.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- WORKER: UPDATE JOB STATUS ----------
app.post("/api/worker/jobs/:id/status", requireWorkerAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const status = String(req.body.status || "").trim(); // done / error / printing
    const error_message = String(req.body.error_message || "").trim();

    if (!status) return res.status(400).json({ error: "Missing status" });

    // Keep schema-tolerant: only update fields that usually exist
    const r = await pool.query(
      `
      UPDATE print_jobs
      SET status = $2,
          error_message = NULLIF($3, '')
      WHERE id = $1
      RETURNING *;
      `,
      [id, status, error_message]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "Job not found" });

    res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- DASHBOARD: LIST JOBS ----------
app.get("/api/dashboard/jobs", requireDashboardAuth, async (req, res) => {
  try {
    const printer_id = String(req.query.printer_id || "DISPATCH").trim();
    const limit = Math.min(num(req.query.limit, 50), 200);

    const r = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
      `,
      [printer_id, limit]
    );

    res.json({ ok: true, jobs: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- DASHBOARD UI ----------
app.get("/dashboard", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>MSTAF Dashboard</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#0b1220;color:#e5e7eb}
    .wrap{max-width:1100px;margin:0 auto;padding:24px}
    .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
    input,select,button{padding:10px 12px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#e5e7eb}
    button{cursor:pointer}
    .card{background:#0f172a;border:1px solid #1f2a44;border-radius:14px;padding:14px}
    .muted{color:#94a3b8}
    table{width:100%;border-collapse:collapse;margin-top:12px;font-size:14px}
    th,td{border-bottom:1px solid #1f2a44;padding:10px;text-align:left;vertical-align:top}
    a{color:#93c5fd}
    .err{color:#fca5a5;white-space:pre-wrap}
    .ok{color:#86efac}
  </style>
</head>
<body>
  <div class="wrap">
    <h2 style="margin:0 0 6px 0;">MSTAF Dashboard</h2>
    <div class="muted" style="margin-bottom:16px;">Jobs viewer (DISPATCH / printer queues)</div>

    <div class="card">
      <div class="bar">
        <label class="muted">Printer</label>
        <select id="printer">
          <option value="DISPATCH">DISPATCH</option>
          <option value="${DEFAULT_PRINTER_ID}">${DEFAULT_PRINTER_ID}</option>
        </select>

        <label class="muted">Limit</label>
        <input id="limit" type="number" value="50" min="1" max="200" style="width:110px"/>

        <button id="refresh">Refresh</button>
        <span id="status" class="muted">Loading…</span>
      </div>

      <div id="error" class="err"></div>
      <div id="table"></div>
    </div>
  </div>

<script>
  // Read key from URL: /dashboard?key=...
  const params = new URLSearchParams(location.search);
  const DASH_KEY = params.get("key") || "";

  const printerEl = document.getElementById("printer");
  const limitEl = document.getElementById("limit");
  const statusEl = document.getElementById("status");
  const errorEl = document.getElementById("error");
  const tableEl = document.getElementById("table");
  const refreshBtn = document.getElementById("refresh");

  function esc(s){ return String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  function renderJobs(jobs){
    if(!Array.isArray(jobs) || jobs.length === 0){
      tableEl.innerHTML = "<div class='muted'>0 jobs</div>";
      return;
    }
    const rows = jobs.map(j => {
      const file = j.file_url ? "<a href='"+esc(j.file_url)+"' target='_blank'>file</a>" : "";
      return "<tr>" +
        "<td>"+esc(j.id)+"</td>" +
        "<td>"+esc(j.status)+"</td>" +
        "<td>"+esc(j.printer_id)+"</td>" +
        "<td>"+esc(j.paper_size || "")+" / "+esc(j.color_mode || "")+"</td>" +
        "<td>"+esc(j.copies || "")+" / "+esc(j.pages || "")+"</td>" +
        "<td>"+esc(j.total_cost ?? "")+"</td>" +
        "<td>"+file+"</td>" +
        "<td>"+esc(j.created_at || "")+"</td>" +
      "</tr>";
    }).join("");

    tableEl.innerHTML =
      "<table>" +
      "<thead><tr>" +
      "<th>ID</th><th>Status</th><th>Printer</th><th>Mode</th><th>Copies/Pages</th><th>Cost</th><th>File</th><th>Created</th>" +
      "</tr></thead>" +
      "<tbody>"+rows+"</tbody></table>";
  }

  async function load(){
    errorEl.textContent = "";
    statusEl.textContent = "Loading…";

    const printer_id = printerEl.value;
    const limit = Number(limitEl.value || 50);

    if(!DASH_KEY){
      statusEl.textContent = "";
      errorEl.textContent = "Missing dashboard key. Open: /dashboard?key=YOUR_KEY";
      return;
    }

    // ✅ FIX: send key via query param (and also header for compatibility)
    const url = "/api/dashboard/jobs?printer_id=" + encodeURIComponent(printer_id) +
                "&limit=" + encodeURIComponent(limit) +
                "&key=" + encodeURIComponent(DASH_KEY);

    try{
      const r = await fetch(url, { headers: { "x-dashboard-key": DASH_KEY } });
      const data = await r.json().catch(() => ({}));

      statusEl.textContent = "";
      if(!r.ok){
        errorEl.textContent = "Error " + r.status + ": " + JSON.stringify(data);
        tableEl.innerHTML = "";
        return;
      }

      renderJobs(data.jobs || data || []);
      statusEl.textContent = "Loaded";
      statusEl.className = "ok";
      setTimeout(()=>{ statusEl.className="muted"; }, 900);
    }catch(err){
      statusEl.textContent = "";
      errorEl.textContent = "Fetch error: " + (err?.message || err);
      tableEl.innerHTML = "";
    }
  }

  refreshBtn.addEventListener("click", load);
  printerEl.addEventListener("change", load);

  load();
</script>
</body>
</html>
  `);
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`MSTAF Core listening on ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
});
