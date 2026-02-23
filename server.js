/**
 * MSTAF Core - Server.js (Auto Print + Human Dispatch Dashboard)
 *
 * Features:
 * ✅ Upload endpoints:
 *    - POST /api/upload
 *    - POST /api/print-jobs/upload (compat)
 * ✅ Copies split:
 *    - copy #1 auto prints on PP-USA-001 (queued)
 *    - copies #2..N -> dispatch_pending (dashboard queue)
 * ✅ Worker endpoints:
 *    - GET  /api/worker/next?printerId=PP-USA-001
 *    - POST /api/worker/update
 * ✅ Dashboard:
 *    - GET /dashboard  (Basic Auth)
 *    - APIs:
 *        GET  /api/dashboard/dispatch-queue
 *        POST /api/dashboard/assign-printer
 *        POST /api/dashboard/send-email-link
 * ✅ Safe DB writes:
 *    - only write columns that exist
 *    - safe boolean for color
 *    - safe JSON for details/meta
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");

// Optional email (SMTP)
let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch (_) {
  // If not installed, email endpoint will return a clear error.
}

const app = express();

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;

const BASE_URL =
  (process.env.BASE_URL && process.env.BASE_URL.trim()) ||
  (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.trim()) ||
  "https://mstaf-core-1.onrender.com";

const WORKER_KEY = (process.env.WORKER_KEY || process.env.PRINTER_KEY || "").trim();

const DASH_USER = (process.env.DASHBOARD_USER || "").trim();
const DASH_PASS = (process.env.DASHBOARD_PASS || "").trim();

const DEFAULT_AUTO_PRINTER_ID = (process.env.DEFAULT_AUTO_PRINTER_ID || "PP-USA-001").trim();

// Email env (optional)
const SMTP_HOST = (process.env.SMTP_HOST || "").trim();
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = (process.env.SMTP_USER || "").trim();
const SMTP_PASS = (process.env.SMTP_PASS || "").trim();
const SMTP_FROM = (process.env.SMTP_FROM || "Patapata Print <no-reply@patapata.us>").trim();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

// ---------------- MIDDLEWARE ----------------
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

app.use(
  cors({
    origin: (origin, cb) => cb(null, true),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-worker-key", "x-printer-key", "authorization"],
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------------- HELPERS ----------------
function toInt(v, fallback = 1) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "on", "color"].includes(s)) return true;
  if (["false", "0", "no", "n", "off", "bw", "b&w", "black"].includes(s)) return false;
  return fallback;
}

function safeJsonValue(input, fallbackObj = {}) {
  // Returns a VALID JSON string always.
  if (input && typeof input === "object") {
    try {
      return JSON.stringify(input);
    } catch {
      return JSON.stringify(fallbackObj);
    }
  }
  const s = String(input ?? "").trim();
  if (!s) return JSON.stringify(fallbackObj);
  try {
    JSON.parse(s);
    return s;
  } catch {
    return JSON.stringify({ ...fallbackObj, raw: s });
  }
}

function randToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}
function uuidLike() {
  return crypto.randomUUID ? crypto.randomUUID() : randToken(16);
}

function requireWorkerAuth(req, res, next) {
  const got =
    req.headers["x-worker-key"] ||
    req.headers["x-printer-key"] ||
    req.headers["authorization"];
  const token = String(got ?? "").replace(/^bearer\s+/i, "").trim();
  if (!WORKER_KEY || token !== WORKER_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized worker" });
  }
  next();
}

// Basic Auth for dashboard
function requireDashboardAuth(req, res, next) {
  if (!DASH_USER || !DASH_PASS) {
    return res.status(500).send("Dashboard auth not configured. Set DASHBOARD_USER and DASHBOARD_PASS.");
  }
  const header = req.headers.authorization || "";
  if (!header.toLowerCase().startsWith("basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MSTAF Dashboard"');
    return res.status(401).send("Authentication required.");
  }
  const b64 = header.split(" ")[1] || "";
  const [u, p] = Buffer.from(b64, "base64").toString("utf8").split(":");
  if (u !== DASH_USER || p !== DASH_PASS) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MSTAF Dashboard"');
    return res.status(401).send("Invalid credentials.");
  }
  // store who dispatched
  req._dashUser = u;
  next();
}

// ---- schema cache ----
let schemaCache = { at: 0, ttl: 60_000, tables: {} };

async function getSchema(table) {
  const now = Date.now();
  if (schemaCache.tables[table] && now - schemaCache.at < schemaCache.ttl) return schemaCache.tables[table];

  const { rows } = await pool.query(
    `SELECT column_name, data_type, udt_name
     FROM information_schema.columns
     WHERE table_name = $1`,
    [table]
  );

  const schema = {};
  for (const r of rows) schema[r.column_name] = { data_type: r.data_type, udt_name: r.udt_name };

  schemaCache = { ...schemaCache, at: now, tables: { ...schemaCache.tables, [table]: schema } };
  return schema;
}

function pickExisting(schema, obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (schema[k]) out[k] = v;
  return out;
}

function placeholderFor(schema, col, idx) {
  const t = schema[col];
  const isJson = t && (t.data_type === "json" || t.data_type === "jsonb");
  return isJson ? `$${idx}::jsonb` : `$${idx}`;
}

function buildInsertSQL(table, schema, data) {
  const cols = Object.keys(data);
  const vals = Object.values(data);
  const placeholders = cols.map((c, i) => placeholderFor(schema, c, i + 1));
  const sql = `INSERT INTO ${table} (${cols.join(", ")})
               VALUES (${placeholders.join(", ")})
               RETURNING *`;
  return { sql, vals };
}

function buildUpdateSQL(table, schema, data, whereCol, whereVal) {
  const cols = Object.keys(data);
  const vals = Object.values(data);
  const sets = cols.map((c, i) => `${c} = ${placeholderFor(schema, c, i + 1)}`);
  const sql = `UPDATE ${table}
               SET ${sets.join(", ")}
               WHERE ${whereCol} = $${cols.length + 1}
               RETURNING *`;
  return { sql, vals: [...vals, whereVal] };
}

// ---------------- ROUTES ----------------
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Public secure file download (if enabled)
app.get("/public/file/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).send("Missing token");

    const schema = await getSchema("print_jobs");
    if (!schema.public_file_token) return res.status(404).send("Public file not enabled (missing public_file_token)");

    const { rows } = await pool.query(
      `SELECT file_base64, mime_type, original_name, file_name
       FROM print_jobs
       WHERE public_file_token = $1
       LIMIT 1`,
      [token]
    );

    if (!rows[0]?.file_base64) return res.status(404).send("Not found");

    const mime = rows[0].mime_type || "application/octet-stream";
    const name = rows[0].original_name || rows[0].file_name || "file";

    const buf = Buffer.from(rows[0].file_base64, "base64");
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${String(name).replace(/"/g, "")}"`);
    return res.send(buf);
  } catch (e) {
    return res.status(500).send("Server error");
  }
});

// ---------- UPLOAD HANDLER ----------
async function handleUpload(req, res) {
  const client = await pool.connect();
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const schema = await getSchema("print_jobs");

    const now = new Date().toISOString();
    const groupId = uuidLike();

    const printerId = String(req.body.printerId || DEFAULT_AUTO_PRINTER_ID).trim();

    // IMPORTANT: pages/copies come from Shopify; we split copies
    const pages = toInt(req.body.pages, 1);
    const copiesTotal = toInt(req.body.copies, 1);

    const colorBool = toBool(req.body.color, false);

    const originalName = file.originalname || "upload";
    const mimeType = file.mimetype || "application/octet-stream";
    const fileBase64 = file.buffer.toString("base64");

    // Location (no zip needed)
    const customerCountry = String(req.body.customerCountry || req.body.country || "").trim();
    const customerCity = String(req.body.customerCity || req.body.city || "").trim();
    const customerRegion = String(req.body.customerRegion || req.body.region || req.body.state || "").trim();

    const detailsJson = safeJsonValue(req.body.details, {
      serviceType: req.body.serviceType || "Printing",
      paperSize: req.body.paperSize || "A4",
      instructions: req.body.instructions || "",
    });

    const metaJson = safeJsonValue(req.body.meta, {
      source: req.body.source || "shopify",
      ua: req.headers["user-agent"] || "",
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "",
    });

    // Public link token (optional columns)
    const publicFileToken = randToken(24);
    const customerFileUrl = `${BASE_URL.replace(/\/$/, "")}/public/file/${publicFileToken}`;

    await client.query("BEGIN");

    // Create AUTO job: copy_index = 1, copies_total = N, copies = 1 (always one)
    const autoDesired = {
      job_group_id: groupId,
      copy_index: 1,
      copies_total: copiesTotal,

      printer_id: printerId,     // auto print on local printer
      status: "queued",
      dispatch_status: "auto_print",

      pages,
      copies: 1,                 // print only 1 here (we split copies)
      color: colorBool,

      file_name: originalName,
      original_name: originalName,
      mime_type: mimeType,
      file_base64: fileBase64,

      details: detailsJson,
      meta: metaJson,

      customer_country: customerCountry,
      customer_city: customerCity,
      customer_region: customerRegion,

      public_file_token: publicFileToken,
      customer_file_url: customerFileUrl,

      source: String(req.body.source || "shopify").trim(),
      created_at: now,
      updated_at: now,
    };

    const autoData = pickExisting(schema, autoDesired);
    const { sql: autoSql, vals: autoVals } = buildInsertSQL("print_jobs", schema, autoData);
    const autoIns = await client.query(autoSql, autoVals);
    const autoJob = autoIns.rows[0];

    // Create DISPATCH jobs: copy_index = 2..N, status=dispatch_pending, copies=1
    if (copiesTotal > 1) {
      for (let i = 2; i <= copiesTotal; i++) {
        const dispatchDesired = {
          job_group_id: groupId,
          copy_index: i,
          copies_total: copiesTotal,

          // Not assigned to a printer yet
          assigned_printer_id: null,
          status: "dispatch_pending",
          dispatch_status: "dispatch_pending",

          pages,
          copies: 1,
          color: colorBool,

          file_name: originalName,
          original_name: originalName,
          mime_type: mimeType,
          file_base64: fileBase64,

          details: detailsJson,
          meta: metaJson,

          customer_country: customerCountry,
          customer_city: customerCity,
          customer_region: customerRegion,

          public_file_token: publicFileToken,
          customer_file_url: customerFileUrl,

          source: String(req.body.source || "shopify").trim(),
          created_at: now,
          updated_at: now,
        };

        const dispatchData = pickExisting(schema, dispatchDesired);
        const { sql: dSql, vals: dVals } = buildInsertSQL("print_jobs", schema, dispatchData);
        await client.query(dSql, dVals);
      }
    }

    await client.query("COMMIT");

    return res.json({
      ok: true,
      jobId: autoJob?.id,
      jobGroupId: groupId,
      status: autoJob?.status || "queued",
      copiesTotal,
      customerFileUrl: schema.public_file_token ? customerFileUrl : null,
      note:
        copiesTotal > 1
          ? `Copy 1 printing now. Copies 2..${copiesTotal} sent to Dispatch Queue.`
          : "Printing now.",
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  } finally {
    client.release();
  }
}

app.post("/api/upload", upload.single("file"), handleUpload);
app.post("/api/print-jobs/upload", upload.single("file"), handleUpload);

// ---------- WORKER: NEXT JOB ----------
app.get("/api/worker/next", requireWorkerAuth, async (req, res) => {
  const printerId = String(req.query.printerId || "").trim();
  if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

  const client = await pool.connect();
  try {
    const schema = await getSchema("print_jobs");

    await client.query("BEGIN");

    // Only queued jobs for this printer_id
    const { rows } = await client.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
        AND status = 'queued'
      ORDER BY created_at ASC NULLS LAST, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
      `,
      [printerId]
    );

    if (!rows[0]) {
      await client.query("COMMIT");
      return res.json({ ok: true, job: null });
    }

    const job = rows[0];

    // Mark printing before returning (prevents loops)
    if (schema.status) {
      const upd = pickExisting(schema, {
        status: "printing",
        updated_at: new Date().toISOString(),
      });
      if (Object.keys(upd).length > 0) {
        const { sql, vals } = buildUpdateSQL("print_jobs", schema, upd, "id", job.id);
        await client.query(sql, vals);
      }
    }

    await client.query("COMMIT");

    return res.json({
      ok: true,
      job: {
        id: job.id,
        printer_id: job.printer_id,
        status: "printing",
        pages: job.pages || 1,
        copies: job.copies || 1,
        color: job.color === true,
        file_name: job.original_name || job.file_name || "file",
        mime_type: job.mime_type || "application/octet-stream",
        file_base64: job.file_base64,
        details: job.details ?? null,
      },
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  } finally {
    client.release();
  }
});

// ---------- WORKER: UPDATE ----------
app.post("/api/worker/update", requireWorkerAuth, async (req, res) => {
  try {
    const id = toInt(req.body.id, 0);
    const status = String(req.body.status || "").trim();
    const errorMsg = String(req.body.error || "").trim();

    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    const schema = await getSchema("print_jobs");

    const metaPatch = safeJsonValue(
      { worker_update: { status, error: errorMsg || null, at: new Date().toISOString() } },
      { worker_update: { status, error: errorMsg || null, at: new Date().toISOString() } }
    );

    const desired = {
      status,
      updated_at: new Date().toISOString(),
      meta: metaPatch,
    };

    const data = pickExisting(schema, desired);
    const { sql, vals } = buildUpdateSQL("print_jobs", schema, data, "id", id);
    const { rows } = await pool.query(sql, vals);

    return res.json({ ok: true, job: rows[0] || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
});

// ---------------- DASHBOARD UI ----------------
app.get("/dashboard", requireDashboardAuth, (req, res) => {
  // Minimal HTML dashboard (no frameworks)
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>MSTAF Dispatch Dashboard</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0b1220;color:#e5e7eb;margin:0;}
    .wrap{max-width:1100px;margin:0 auto;padding:18px 14px 60px;}
    .top{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px;}
    .brand{font-weight:900;font-size:18px;letter-spacing:.02em;}
    .pill{background:#111b33;border:1px solid rgba(255,255,255,.08);padding:8px 10px;border-radius:999px;font-size:12px;color:#cbd5e1;}
    .card{background:#0f1a33;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:14px;}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between;}
    button{background:#facc15;color:#111827;border:0;border-radius:12px;padding:10px 12px;font-weight:900;cursor:pointer}
    button.secondary{background:#38bdf8}
    button:disabled{opacity:.6;cursor:not-allowed}
    input{background:#0b1220;border:1px solid rgba(255,255,255,.12);color:#e5e7eb;border-radius:12px;padding:10px 10px;min-width:220px}
    table{width:100%;border-collapse:separate;border-spacing:0 10px;margin-top:10px}
    td,th{text-align:left;font-size:13px;padding:10px}
    th{color:#93c5fd;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
    tr{background:#0b1220;border:1px solid rgba(255,255,255,.08)}
    tr td:first-child{border-top-left-radius:14px;border-bottom-left-radius:14px}
    tr td:last-child{border-top-right-radius:14px;border-bottom-right-radius:14px}
    a{color:#93c5fd;text-decoration:underline;word-break:break-all}
    .muted{color:#94a3b8}
    .status{font-weight:800}
    .small{font-size:12px;color:#94a3b8}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    @media(max-width:900px){.grid2{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="brand">PATAPATA • MSTAF Dispatch Dashboard</div>
      <div class="pill">Logged in: ${String(req._dashUser || "").replace(/</g,"&lt;")}</div>
    </div>

    <div class="card">
      <div class="row">
        <div>
          <div style="font-weight:900;font-size:16px;">Dispatch Queue (copies 2+)</div>
          <div class="small">Assign to printer OR email secure link. Auto-print copy #1 is not shown here.</div>
        </div>
        <div class="row">
          <button id="refreshBtn" class="secondary">Refresh</button>
        </div>
      </div>

      <div id="msg" class="small" style="margin-top:10px;"></div>

      <div style="overflow:auto;">
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Copy</th>
              <th>Location</th>
              <th>File</th>
              <th>Specs</th>
              <th>Assign Printer</th>
              <th>Email Link</th>
            </tr>
          </thead>
          <tbody id="tbody">
            <tr><td colspan="7" class="muted">Loading...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

<script>
  async function api(path, opts){
    const res = await fetch(path, opts);
    const text = await res.text();
    let data = null;
    try{ data = JSON.parse(text); }catch(e){}
    if(!res.ok){
      throw new Error((data && (data.error||data.details)) ? (data.error||data.details) : text);
    }
    return data || {};
  }

  function safeJsonParse(v){
    if(!v) return null;
    if(typeof v === "object") return v;
    try{ return JSON.parse(v); }catch(e){ return null; }
  }

  function esc(s){ return String(s||"").replace(/[&<>"]/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }

  async function load(){
    const msg = document.getElementById("msg");
    const tbody = document.getElementById("tbody");
    msg.textContent = "Loading queue...";
    tbody.innerHTML = '<tr><td colspan="7" class="muted">Loading...</td></tr>';

    try{
      const data = await api("/api/dashboard/dispatch-queue");
      const items = data.items || [];
      msg.textContent = items.length ? ("Found " + items.length + " dispatch job(s).") : "Queue is empty.";
      if(!items.length){
        tbody.innerHTML = '<tr><td colspan="7" class="muted">No pending dispatch jobs.</td></tr>';
        return;
      }

      tbody.innerHTML = items.map(it=>{
        const det = safeJsonParse(it.details) || {};
        const paper = det.paperSize || det.paper || "";
        const svc = det.serviceType || "";
        const instr = det.instructions || det.notes || "";

        const loc = [it.customer_city, it.customer_region, it.customer_country].filter(Boolean).join(", ");
        const specs = [
          svc ? ("Svc: " + svc) : null,
          paper ? ("Paper: " + paper) : null,
          "Pages: " + (it.pages||1),
          "Color: " + (it.color ? "Yes" : "No"),
          instr ? ("Instr: " + instr) : null
        ].filter(Boolean).join(" • ");

        const fileLink = it.customer_file_url ? '<a href="'+esc(it.customer_file_url)+'" target="_blank" rel="noopener">Open file link</a>' : esc(it.original_name || it.file_name || "file");

        return \`
          <tr>
            <td><span class="status">#\${esc(it.id)}</span><div class="small muted">Group: \${esc(it.job_group_id || "")}</div></td>
            <td>\${esc(it.copy_index || "")}/\${esc(it.copies_total || "")}</td>
            <td>\${loc ? esc(loc) : '<span class="muted">Not provided</span>'}</td>
            <td>\${fileLink}</td>
            <td>\${esc(specs)}</td>
            <td>
              <div class="grid2">
                <input id="p_\${it.id}" placeholder="Printer ID (e.g. PP-NG-LAG-001)" />
                <button onclick="assignPrinter(\${it.id})">Assign</button>
              </div>
            </td>
            <td>
              <div class="grid2">
                <input id="e_\${it.id}" placeholder="Email address" />
                <button onclick="sendEmail(\${it.id})">Send</button>
              </div>
            </td>
          </tr>
        \`;
      }).join("");
    } catch(e){
      msg.textContent = "Error: " + e.message;
      tbody.innerHTML = '<tr><td colspan="7" class="muted">Failed to load queue.</td></tr>';
    }
  }

  async function assignPrinter(id){
    const p = document.getElementById("p_"+id).value.trim();
    if(!p){ alert("Enter a Printer ID"); return; }
    try{
      await api("/api/dashboard/assign-printer", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ id, printerId: p })
      });
      alert("Assigned to printer: " + p);
      load();
    }catch(e){
      alert("Assign failed: " + e.message);
    }
  }

  async function sendEmail(id){
    const email = document.getElementById("e_"+id).value.trim();
    if(!email){ alert("Enter an email"); return; }
    try{
      await api("/api/dashboard/send-email-link", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ id, email })
      });
      alert("Email sent to: " + email);
      load();
    }catch(e){
      alert("Email failed: " + e.message);
    }
  }

  document.getElementById("refreshBtn").addEventListener("click", load);
  load();
</script>
</body>
</html>`);
});

// ---------------- DASHBOARD APIs ----------------
app.get("/api/dashboard/dispatch-queue", requireDashboardAuth, async (req, res) => {
  try {
    const schema = await getSchema("print_jobs");

    // Show only dispatch_pending jobs
    const { rows } = await pool.query(
      `SELECT id, job_group_id, copy_index, copies_total, status, dispatch_status,
              pages, copies, color,
              file_name, original_name, customer_file_url,
              customer_country, customer_city, customer_region,
              details, created_at
       FROM print_jobs
       WHERE status = 'dispatch_pending'
       ORDER BY created_at ASC NULLS LAST, id ASC
       LIMIT 200`
    );

    return res.json({ ok: true, items: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
});

app.post("/api/dashboard/assign-printer", requireDashboardAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = toInt(req.body.id, 0);
    const printerId = String(req.body.printerId || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const schema = await getSchema("print_jobs");
    await client.query("BEGIN");

    // Update dispatch job: assign printer and set status queued so that printer's worker can pick it
    const desired = {
      assigned_printer_id: printerId,
      printer_id: printerId,              // IMPORTANT: worker selects by printer_id
      status: "queued",
      dispatch_status: "assigned_printer",
      dispatched_by: req._dashUser || "",
      dispatched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const data = pickExisting(schema, desired);
    const { sql, vals } = buildUpdateSQL("print_jobs", schema, data, "id", id);
    const { rows } = await client.query(sql, vals);

    await client.query("COMMIT");
    return res.json({ ok: true, job: rows[0] || null });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  } finally {
    client.release();
  }
});

function getMailer() {
  if (!nodemailer) return null;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

app.post("/api/dashboard/send-email-link", requireDashboardAuth, async (req, res) => {
  try {
    const id = toInt(req.body.id, 0);
    const email = String(req.body.email || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
    if (!email) return res.status(400).json({ ok: false, error: "Missing email" });

    const mailer = getMailer();
    if (!mailer) {
      return res.status(500).json({
        ok: false,
        error: "Email not configured",
        details:
          "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (and ensure nodemailer is installed).",
      });
    }

    const schema = await getSchema("print_jobs");

    const { rows } = await pool.query(
      `SELECT id, customer_file_url, public_file_token, original_name, file_name, customer_country, customer_city, customer_region
       FROM print_jobs
       WHERE id = $1
       LIMIT 1`,
      [id]
    );

    if (!rows[0]) return res.status(404).json({ ok: false, error: "Job not found" });

    let link = rows[0].customer_file_url || "";
    if (!link && rows[0].public_file_token) {
      link = `${BASE_URL.replace(/\/$/, "")}/public/file/${rows[0].public_file_token}`;
    }
    if (!link) {
      return res.status(500).json({
        ok: false,
        error: "No public link available",
        details: "Ensure public_file_token/customer_file_url columns exist and are being set.",
      });
    }

    const name = rows[0].original_name || rows[0].file_name || "file";
    const loc = [rows[0].customer_city, rows[0].customer_region, rows[0].customer_country].filter(Boolean).join(", ");

    await mailer.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: `Print File Link (${name})`,
      text:
        `Here is the secure file link:\n\n${link}\n\n` +
        (loc ? `Customer location: ${loc}\n\n` : "") +
        `Job ID: ${id}\n\nPatapata Print-O-Matic`,
    });

    // Mark job as emailed (still not printed unless someone assigns it)
    const desired = {
      assigned_email: email,
      dispatch_status: "emailed",
      dispatched_by: req._dashUser || "",
      dispatched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const data = pickExisting(schema, desired);
    const { sql, vals } = buildUpdateSQL("print_jobs", schema, data, "id", id);
    const upd = await pool.query(sql, vals);

    return res.json({ ok: true, job: upd.rows[0] || null, sentTo: email, link });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
});

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log("✅ MSTAF Core running on port", PORT);
  console.log("✅ BASE_URL:", BASE_URL);
  console.log("✅ WORKER_KEY:", WORKER_KEY ? "(set)" : "(missing)");
  console.log("✅ DEFAULT_AUTO_PRINTER_ID:", DEFAULT_AUTO_PRINTER_ID);
  console.log("✅ DASHBOARD auth:", DASH_USER ? "(set)" : "(missing)");
});
