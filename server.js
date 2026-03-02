/**
 * MSTAF Core (Render) - server.js (FULL REPLACEMENT - PRINTER REGISTRY EDITION)
 * Keeps your current working pipeline and adds:
 * - Full printer registry (USA + Nigeria 36 states, 2 each)
 * - Instructions + Service Type in dashboards
 * - Dispatch actions (route/mark/delete/email) for worker & agent flows
 * - Option 5 routing: A4 auto-print, A3/CARD dispatch, IMAGE/VIDEO -> AGENT
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

const BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`;

const DASHBOARD_KEY = String(process.env.DASHBOARD_KEY || "").trim();

const WORKER_KEY =
  String(process.env.WORKER_KEY || "").trim() ||
  String(process.env.PRINTER_KEY || "").trim();

// Default USA printer used for auto-print A4
const DEFAULT_PRINTER_ID = String(process.env.PRINTER_ID || "PP-USA-001").trim();

// Optional USA printers (can be overridden by ENV)
const A3_PRINTER_ID = String(process.env.A3_PRINTER_ID || "PP-USA-A3-001").trim();
const CARD_PRINTER_ID = String(process.env.CARD_PRINTER_ID || "PP-USA-CARD-001").trim();
const AGENT_QUEUE_ID = String(process.env.AGENT_QUEUE_ID || "AGENT").trim();

// ---------- PRINTER REGISTRY (USA + NIGERIA 36 STATES) ----------
/**
 * Each entry:
 * { id: "PP-...", name: "Friendly display name", country: "USA|NG", region: "State/City", type: "A4|A3|CARD|SPECIAL|QUEUE|AGENT" }
 *
 * - Nigeria has 2 printers per state:
 *    A4: PP-NG-XX-A4-001
 *    SPECIAL (A3/CARD): PP-NG-XX-SP-001
 */
const PRINTERS = (() => {
  const list = [];

  // Core queues
  list.push({ id: "DISPATCH", name: "DISPATCH — Manual Routing Queue", country: "SYS", region: "GLOBAL", type: "QUEUE" });
  list.push({ id: AGENT_QUEUE_ID, name: "AGENT — Image/Video Editing Queue", country: "SYS", region: "GLOBAL", type: "AGENT" });

  // USA printers
  list.push({ id: DEFAULT_PRINTER_ID, name: `USA — A4 Hub Printer (Default) (${DEFAULT_PRINTER_ID})`, country: "USA", region: "USA", type: "A4" });
  list.push({ id: A3_PRINTER_ID, name: `USA — A3 Printer (${A3_PRINTER_ID})`, country: "USA", region: "USA", type: "A3" });
  list.push({ id: CARD_PRINTER_ID, name: `USA — CARD Printer (${CARD_PRINTER_ID})`, country: "USA", region: "USA", type: "CARD" });

  // Nigeria states with 2 printers each
  const states = [
    ["Abia","AB"],
    ["Adamawa","AD"],
    ["Akwa Ibom","AK"],
    ["Anambra","AN"],
    ["Bauchi","BA"],
    ["Bayelsa","BY"],
    ["Benue","BE"],
    ["Borno","BO"],
    ["Cross River","CR"],
    ["Delta","DE"],
    ["Ebonyi","EB"],
    ["Edo","ED"],
    ["Ekiti","EK"],
    ["Enugu","EN"],
    ["Gombe","GO"],
    ["Imo","IM"],
    ["Jigawa","JI"],
    ["Kaduna","KD"],
    ["Kano","KN"],
    ["Katsina","KT"],
    ["Kebbi","KE"],
    ["Kogi","KG"],
    ["Kwara","KW"],
    ["Lagos","LA"],
    ["Nasarawa","NA"],
    ["Niger","NI"],
    ["Ogun","OG"],
    ["Ondo","ON"],
    ["Osun","OS"],
    ["Oyo","OY"],
    ["Plateau","PL"],
    ["Rivers","RI"],
    ["Sokoto","SO"],
    ["Taraba","TA"],
    ["Yobe","YO"],
    ["Zamfara","ZA"],
  ];

  for (const [state, code] of states) {
    const a4 = `PP-NG-${code}-A4-001`;
    const sp = `PP-NG-${code}-SP-001`; // SPECIAL: A3/CARD
    list.push({ id: a4, name: `Nigeria — ${state} A4 Hub (${a4})`, country: "NG", region: state, type: "A4" });
    list.push({ id: sp, name: `Nigeria — ${state} SPECIAL A3/CARD (${sp})`, country: "NG", region: state, type: "SPECIAL" });
  }

  return list;
})();

function getPrinterIds() {
  // Return unique IDs in stable order
  const seen = new Set();
  const ids = [];
  for (const p of PRINTERS) {
    if (!p?.id) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    ids.push(p.id);
  }
  return ids;
}

function getPrinterNameMap() {
  const m = {};
  for (const p of PRINTERS) m[p.id] = p.name || p.id;
  return m;
}

const PRINTER_NAME = getPrinterNameMap();

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

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
      .slice(-120);
    cb(null, `${Date.now()}_${Math.random().toString(16).slice(2)}_${safe}`);
  },
});
const upload = multer({ storage });
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "1h" }));

// ---------- HELPERS ----------
function requireWorkerAuth(req, res, next) {
  const provided = String(req.headers["x-worker-key"] || req.headers["x-printer-key"] || "").trim();
  if (!WORKER_KEY) return res.status(500).json({ error: "Server WORKER_KEY/PRINTER_KEY not configured" });
  if (provided !== WORKER_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function requireDashboardAuth(req, res, next) {
  const provided = String(req.headers["x-dashboard-key"] || req.query.key || "").trim();
  if (!DASHBOARD_KEY) return res.status(500).json({ error: "Server DASHBOARD_KEY not configured" });
  if (provided !== DASHBOARD_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function calcUnitPrice(colorMode) {
  const m = String(colorMode || "").toLowerCase();
  if (m.includes("bw") || m.includes("black")) return 0.25;
  return 0.5;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function upperTrim(v, fallback = "") {
  const s = String(v ?? "").trim();
  return s ? s.toUpperCase() : fallback;
}

function safeTrim(v) {
  return String(v ?? "").trim();
}

// Option 5 routing + editing queues
function routeQueue({ printer_id, paper_size, service_type }) {
  const explicit = safeTrim(printer_id);
  if (explicit) return explicit;

  const st = upperTrim(service_type, "PRINT"); // PRINT / IMAGE_EDITING / VIDEO_EDITING
  const size = upperTrim(paper_size, "A4");    // A4 / A3 / CARD / LETTER

  // Editing work goes to agents
  if (st === "IMAGE_EDITING" || st === "VIDEO_EDITING") return AGENT_QUEUE_ID;

  // Print routing
  if (size === "A4" || size === "LETTER") return DEFAULT_PRINTER_ID; // auto print
  if (size === "A3" || size === "CARD") return "DISPATCH";           // manual dispatch
  return "DISPATCH";
}

// ---------- HEALTH ----------
app.get("/", (req, res) => res.status(200).send("MSTAF Core is running ✅"));

app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({
      ok: true,
      db: r.rows?.[0]?.ok === 1,
      base_url: BASE_URL,
      printer_count: PRINTERS.length,
      defaults: { DEFAULT_PRINTER_ID, A3_PRINTER_ID, CARD_PRINTER_ID, AGENT_QUEUE_ID },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- CREATE JOB (UPLOAD) ----------
app.post("/api/print-jobs", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const service_type = upperTrim(req.body.service_type, "PRINT");
    const paper_size = upperTrim(req.body.paper_size, "A4");
    const color_mode = upperTrim(req.body.color_mode, "BW");

    const copies = num(req.body.copies, 1);
    const pages = num(req.body.pages, 1);

    const customer_name = safeTrim(req.body.customer_name);
    const customer_email = safeTrim(req.body.customer_email);
    const country = safeTrim(req.body.country);
    const city = safeTrim(req.body.city);

    const notes = safeTrim(req.body.notes);
    const instructions = safeTrim(req.body.instructions);

    const file_url = `${BASE_URL}/uploads/${encodeURIComponent(req.file.filename)}`;
    const original_name = safeTrim(req.file.originalname);

    const unit = service_type === "PRINT" ? calcUnitPrice(color_mode) : 0;
    const total_cost = Number((unit * pages * copies).toFixed(2));

    const printer_id = routeQueue({
      printer_id: req.body.printer_id,
      paper_size,
      service_type,
    });

    const qNew = `
      INSERT INTO print_jobs
        (status, printer_id, file_url, original_name, paper_size, color_mode, copies, pages, total_cost,
         customer_name, customer_email, country, city, notes, instructions, service_type)
      VALUES
        ('pending', $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15)
      RETURNING *;
    `;

    const vNew = [
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
      instructions,
      service_type,
    ];

    let created;
    try {
      created = await pool.query(qNew, vNew);
    } catch (e) {
      const qOld = `
        INSERT INTO print_jobs
          (status, printer_id, file_url, original_name, paper_size, color_mode, copies, pages, total_cost,
           customer_name, customer_email, country, city, notes)
        VALUES
          ('pending', $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13)
        RETURNING *;
      `;
      const vOld = [
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
      created = await pool.query(qOld, vOld);
    }

    return res.status(201).json({
      ok: true,
      job: created.rows[0],
      file_url,
      routing: { printer_id, service_type, paper_size },
      pricing: { unit_price: unit, pages, copies, total_cost },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, hint: "Check print_jobs table columns/schema." });
  }
});

// ---------- WORKER: CLAIM NEXT JOB ----------
app.get("/api/worker/next", requireWorkerAuth, async (req, res) => {
  const printer_id = safeTrim(req.query.printer_id || DEFAULT_PRINTER_ID);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

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
    return res.json({ ok: true, job: upd.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- WORKER: UPDATE JOB STATUS ----------
app.post("/api/worker/jobs/:id/status", requireWorkerAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const status = safeTrim(req.body.status);
    const error_message = safeTrim(req.body.error_message);

    if (!status) return res.status(400).json({ error: "Missing status" });

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
    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------- WORKER: LEGACY STATUS ENDPOINT (compat) ----------
app.post("/api/worker/status", requireWorkerAuth, async (req, res) => {
  try {
    const id = Number(req.body.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const status = safeTrim(req.body.status);
    const error_message = safeTrim(req.body.error_message);

    if (!status) return res.status(400).json({ error: "Missing status" });

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
    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    console.error("legacy /api/worker/status error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- DASHBOARD API: LIST JOBS ----------
app.get("/api/dashboard/jobs", requireDashboardAuth, async (req, res) => {
  try {
    const printer_id = safeTrim(req.query.printer_id || "DISPATCH");
    const limit = Math.min(num(req.query.limit, 50), 200);
    const status = safeTrim(req.query.status);
    const q = safeTrim(req.query.q);

    const where = [`printer_id = $1`];
    const params = [printer_id];
    let idx = 2;

    if (status) {
      where.push(`status = $${idx++}`);
      params.push(status);
    }
    if (q) {
      where.push(`(
        CAST(id AS TEXT) ILIKE $${idx}
        OR COALESCE(original_name,'') ILIKE $${idx}
        OR COALESCE(customer_email,'') ILIKE $${idx}
        OR COALESCE(customer_name,'') ILIKE $${idx}
        OR COALESCE(notes,'') ILIKE $${idx}
        OR COALESCE(instructions,'') ILIKE $${idx}
        OR COALESCE(service_type,'') ILIKE $${idx}
      )`);
      params.push(`%${q}%`);
      idx++;
    }

    const sql = `
      SELECT *
      FROM print_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx};
    `;
    params.push(limit);

    const r = await pool.query(sql, params);
    return res.json({ ok: true, jobs: r.rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------- DASHBOARD API: ROUTE JOB ----------
app.post("/api/dashboard/jobs/:id/route", requireDashboardAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const printer_id = safeTrim(req.body.printer_id);
    if (!printer_id) return res.status(400).json({ error: "Missing printer_id" });

    const status = safeTrim(req.body.status || "pending");

    const r = await pool.query(
      `UPDATE print_jobs
       SET printer_id=$2, status=$3, updated_at=NOW()
       WHERE id=$1
       RETURNING id, printer_id, status;`,
      [id, printer_id, status]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "Job not found" });
    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    console.error("route job error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- DASHBOARD API: SET STATUS ----------
app.post("/api/dashboard/jobs/:id/status", requireDashboardAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const status = safeTrim(req.body.status);
    if (!status) return res.status(400).json({ error: "Missing status" });

    const r = await pool.query(
      `UPDATE print_jobs
       SET status=$2, updated_at=NOW()
       WHERE id=$1
       RETURNING id, status;`,
      [id, status]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "Job not found" });
    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    console.error("set status error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- DASHBOARD API: EMAIL ----------
app.post("/api/dashboard/jobs/:id/email", requireDashboardAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const email = safeTrim(req.body.email);
    if (!email) return res.status(400).json({ error: "Missing email" });

    try {
      const r = await pool.query(
        `UPDATE print_jobs
         SET status='emailed', customer_email=$2, updated_at=NOW()
         WHERE id=$1
         RETURNING id, status, customer_email;`,
        [id, email]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: "Job not found" });
      return res.json({ ok: true, job: r.rows[0] });
    } catch {
      const r2 = await pool.query(
        `UPDATE print_jobs
         SET status='emailed', updated_at=NOW()
         WHERE id=$1
         RETURNING id, status;`,
        [id]
      );
      if (r2.rowCount === 0) return res.status(404).json({ error: "Job not found" });
      return res.json({ ok: true, job: r2.rows[0] });
    }
  } catch (e) {
    console.error("email job error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- DASHBOARD API: DELETE JOB ----------
app.delete("/api/dashboard/jobs/:id", requireDashboardAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const r = await pool.query(`DELETE FROM print_jobs WHERE id=$1 RETURNING id;`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: "Job not found" });

    return res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    console.error("delete job error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------- DASHBOARD UI ----------
function dashboardHtml({ initialPrinter }) {
  const printerIds = getPrinterIds();

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>MSTAF Worker/Agent Dashboard</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#0b1220;color:#e5e7eb}
    .wrap{max-width:1280px;margin:0 auto;padding:22px}
    .muted{color:#94a3b8}
    .card{background:#0f172a;border:1px solid #1f2a44;border-radius:14px;padding:14px}
    .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
    input,select,button{padding:10px 12px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#e5e7eb}
    button{cursor:pointer}
    button.primary{border-color:#2563eb}
    button.danger{border-color:#ef4444}
    .pill{display:inline-block;padding:4px 10px;border-radius:999px;border:1px solid #334155;font-size:12px}
    .pill.pending{border-color:#f59e0b}
    .pill.printing{border-color:#38bdf8}
    .pill.done{border-color:#22c55e}
    .pill.error{border-color:#ef4444}
    .pill.editing{border-color:#a78bfa}
    .pill.emailed{border-color:#f472b6}
    .pill.canceled{border-color:#64748b}
    table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px}
    th,td{border-bottom:1px solid #1f2a44;padding:9px;text-align:left;vertical-align:top}
    a{color:#93c5fd}
    .err{color:#fca5a5;white-space:pre-wrap}
    .ok{color:#86efac}
    .instructions{max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .nowrap{white-space:nowrap}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    .small{padding:7px 10px;border-radius:10px;font-size:12px}
    .topline{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topline">
      <div>
        <h2 style="margin:0 0 6px 0;">MSTAF Worker + Agent Dashboard</h2>
        <div class="muted">DISPATCH routing • printers • editing queue • Nigeria hubs</div>
      </div>
      <div class="muted">Auto: A4→${DEFAULT_PRINTER_ID} • A3/CARD→DISPATCH • IMAGE/VIDEO→${AGENT_QUEUE_ID}</div>
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="bar">
        <label class="muted">Queue/Printer</label>
        <select id="printer">
          ${printerIds.map(id => `<option value="${id}">${(PRINTER_NAME[id] || id).replace(/</g,"&lt;")}</option>`).join("")}
        </select>

        <label class="muted">Status</label>
        <select id="statusFilter">
          <option value="">All</option>
          <option value="pending">pending</option>
          <option value="printing">printing</option>
          <option value="done">done</option>
          <option value="editing">editing</option>
          <option value="emailed">emailed</option>
          <option value="error">error</option>
          <option value="canceled">canceled</option>
        </select>

        <label class="muted">Search</label>
        <input id="q" placeholder="id, name, email, filename, instructions..." style="width:300px" />

        <label class="muted">Limit</label>
        <input id="limit" type="number" value="50" min="1" max="200" style="width:110px"/>

        <button id="refresh" class="primary">Refresh</button>

        <label class="muted nowrap"><input id="auto" type="checkbox" style="margin-right:8px;transform:scale(1.1)"/>Auto-refresh</label>
        <span id="status" class="muted">Loading…</span>
      </div>

      <div id="error" class="err"></div>
      <div id="table"></div>
    </div>
  </div>

<script>
  const params = new URLSearchParams(location.search);
  const DASH_KEY = params.get("key") || "";

  const printerEl = document.getElementById("printer");
  const statusFilterEl = document.getElementById("statusFilter");
  const qEl = document.getElementById("q");
  const limitEl = document.getElementById("limit");
  const statusEl = document.getElementById("status");
  const errorEl = document.getElementById("error");
  const tableEl = document.getElementById("table");
  const refreshBtn = document.getElementById("refresh");
  const autoEl = document.getElementById("auto");

  const DEFAULT_PRINTER_ID = ${JSON.stringify(DEFAULT_PRINTER_ID)};
  const A3_PRINTER_ID = ${JSON.stringify(A3_PRINTER_ID)};
  const CARD_PRINTER_ID = ${JSON.stringify(CARD_PRINTER_ID)};
  const AGENT_QUEUE_ID = ${JSON.stringify(AGENT_QUEUE_ID)};
  const PRINTER_NAME = ${JSON.stringify(PRINTER_NAME)};

  function esc(s){ return String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function pill(status){
    const s = String(status || "").toLowerCase();
    const cls = ["pending","printing","done","error","editing","emailed","canceled"].includes(s) ? s : "";
    return "<span class='pill "+cls+"'>"+esc(s || "")+"</span>";
  }

  function queueName(id){ return PRINTER_NAME[id] || id; }

  function isActionQueue(){
    // Workers dispatch from DISPATCH or AGENT queues
    const q = printerEl.value;
    return q === "DISPATCH" || q === AGENT_QUEUE_ID;
  }

  async function apiFetch(url, opts){
    const o = opts || {};
    o.headers = Object.assign({ "x-dashboard-key": DASH_KEY }, o.headers || {});
    const r = await fetch(url, o);
    const data = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error("HTTP " + r.status + ": " + JSON.stringify(data));
    return data;
  }

  async function routeJob(id, printerId){
    await apiFetch("/api/dashboard/jobs/" + id + "/route?key=" + encodeURIComponent(DASH_KEY), {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ printer_id: printerId, status: "pending" })
    });
    load();
  }

  async function setStatus(id, st){
    await apiFetch("/api/dashboard/jobs/" + id + "/status?key=" + encodeURIComponent(DASH_KEY), {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ status: st })
    });
    load();
  }

  async function emailJob(id){
    const email = prompt("Enter email address to send to:", "");
    if(!email) return;
    await apiFetch("/api/dashboard/jobs/" + id + "/email?key=" + encodeURIComponent(DASH_KEY), {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ email })
    });
    load();
  }

  async function deleteJob(id){
    if(!confirm("Delete job " + id + "? This cannot be undone.")) return;
    await apiFetch("/api/dashboard/jobs/" + id + "?key=" + encodeURIComponent(DASH_KEY), { method:"DELETE" });
    load();
  }

  function renderJobs(jobs){
    if(!Array.isArray(jobs) || jobs.length === 0){
      tableEl.innerHTML = "<div class='muted'>0 jobs</div>";
      return;
    }

    const showActions = isActionQueue();

    const head =
      "<thead><tr>" +
        "<th>ID</th><th>Status</th><th>Queue</th><th>Service</th><th>Mode</th><th>Copies/Pages</th><th>Cost</th><th>File</th><th>Instructions</th><th>Created</th>" +
        (showActions ? "<th>Actions</th>" : "") +
      "</tr></thead>";

    const rows = jobs.map(j => {
      const file = j.file_url ? "<a href='"+esc(j.file_url)+"' target='_blank'>file</a>" : "";
      const service = j.service_type ? String(j.service_type) : "PRINT";
      const mode = (j.paper_size || "") + " / " + (j.color_mode || "");
      const instr = j.instructions || "";
      const instrCell = "<td class='instructions' title='"+esc(instr)+"'>"+esc(instr)+"</td>";

      let actions = "";
      if(showActions){
        actions =
          "<td><div class='actions'>" +
            "<button class='small' onclick='routeJob("+j.id+", "+JSON.stringify(DEFAULT_PRINTER_ID)+")'>Send USA A4</button>" +
            "<button class='small' onclick='routeJob("+j.id+", "+JSON.stringify(A3_PRINTER_ID)+")'>Send USA A3</button>" +
            "<button class='small' onclick='routeJob("+j.id+", "+JSON.stringify(CARD_PRINTER_ID)+")'>Send USA CARD</button>" +
            "<button class='small' onclick='routeJob("+j.id+", \"DISPATCH\")'>To DISPATCH</button>" +
            "<button class='small' onclick='routeJob("+j.id+", "+JSON.stringify(AGENT_QUEUE_ID)+")'>To AGENT</button>" +
            "<button class='small' onclick='setStatus("+j.id+", \"editing\")'>Editing</button>" +
            "<button class='small' onclick='setStatus("+j.id+", \"done\")'>Done</button>" +
            "<button class='small' onclick='setStatus("+j.id+", \"canceled\")'>Cancel</button>" +
            "<button class='small' onclick='emailJob("+j.id+")'>Email</button>" +
            "<button class='small danger' onclick='deleteJob("+j.id+")'>Delete</button>" +
          "</div></td>";
      }

      return "<tr>" +
        "<td>"+esc(j.id)+"</td>" +
        "<td>"+pill(j.status)+"</td>" +
        "<td>"+esc(queueName(j.printer_id))+"</td>" +
        "<td>"+esc(service)+"</td>" +
        "<td>"+esc(mode)+"</td>" +
        "<td>"+esc(j.copies || "")+" / "+esc(j.pages || "")+"</td>" +
        "<td>"+esc(j.total_cost ?? "")+"</td>" +
        "<td>"+file+"</td>" +
        instrCell +
        "<td class='nowrap'>"+esc(j.created_at || "")+"</td>" +
        actions +
      "</tr>";
    }).join("");

    tableEl.innerHTML = "<table>" + head + "<tbody>"+rows+"</tbody></table>";
  }

  let timer = null;

  async function load(){
    errorEl.textContent = "";
    statusEl.textContent = "Loading…";
    statusEl.className = "muted";

    if(!DASH_KEY){
      statusEl.textContent = "";
      errorEl.textContent = "Missing dashboard key. Open: /dashboard?key=YOUR_KEY";
      tableEl.innerHTML = "";
      return;
    }

    const printer_id = printerEl.value;
    const limit = Number(limitEl.value || 50);
    const st = statusFilterEl.value;
    const q = qEl.value.trim();

    let url = "/api/dashboard/jobs?printer_id=" + encodeURIComponent(printer_id) +
              "&limit=" + encodeURIComponent(limit) +
              "&key=" + encodeURIComponent(DASH_KEY);

    if(st) url += "&status=" + encodeURIComponent(st);
    if(q) url += "&q=" + encodeURIComponent(q);

    try{
      const data = await apiFetch(url);
      renderJobs(data.jobs || []);
      statusEl.textContent = "Loaded";
      statusEl.className = "ok";
      setTimeout(()=>{ statusEl.className="muted"; }, 900);
    }catch(err){
      statusEl.textContent = "";
      errorEl.textContent = "Error: " + (err?.message || err);
      tableEl.innerHTML = "";
    }
  }

  function setAuto(on){
    if(timer){ clearInterval(timer); timer = null; }
    if(on) timer = setInterval(load, 5000);
  }

  refreshBtn.addEventListener("click", load);
  printerEl.addEventListener("change", load);
  statusFilterEl.addEventListener("change", load);
  autoEl.addEventListener("change", () => setAuto(autoEl.checked));

  // Set initial queue
  printerEl.value = ${JSON.stringify(initialPrinter || "DISPATCH")};
  load();
</script>
</body>
</html>`;
}

// Main dashboard
app.get("/dashboard", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(dashboardHtml({ initialPrinter: safeTrim(req.query.printer_id) || "DISPATCH" }));
});

// Convenience pages
app.get("/worker", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(dashboardHtml({ initialPrinter: "DISPATCH" }));
});
app.get("/agent", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(dashboardHtml({ initialPrinter: AGENT_QUEUE_ID }));
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`MSTAF Core listening on ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`Printers loaded: ${PRINTERS.length}`);
});
