/**
 * MSTAF Core - Server.js (Stable)
 * - Upload endpoint for Shopify (multipart)
 * - Defensive DB insert (won't crash if columns missing)
 * - Worker polling endpoint (fixes 404)
 * - Public file links (customerFileUrl)
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;

// Prefer explicit BASE_URL; fallback to Render hostname if present
const BASE_URL =
  (process.env.BASE_URL && process.env.BASE_URL.trim()) ||
  (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.trim()) ||
  "https://mstaf-core-1.onrender.com";

const WORKER_KEY =
  process.env.WORKER_KEY ||
  process.env.PRINTER_KEY ||
  process.env.WORKER_SECRET ||
  "";

// DB
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

// ---------- Middleware ----------
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow Shopify + browsers. If origin is missing (curl/postman), allow.
      if (!origin) return cb(null, true);
      const ok =
        origin.includes("myshopify.com") ||
        origin.includes("patapata.us") ||
        origin.includes("shopify.com") ||
        origin.includes("render.com");
      return cb(null, ok);
    },
    credentials: false,
  })
);

// Multer in-memory upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ---------- Helpers ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toInt(v, fallback = 1) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(s)) return true;
  if (["false", "0", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function safeJsonString(input, fallbackObj = {}) {
  // If already object, stringify it.
  if (input && typeof input === "object") {
    try {
      return JSON.stringify(input);
    } catch {
      return JSON.stringify(fallbackObj);
    }
  }

  const s = String(input ?? "").trim();
  if (!s) return JSON.stringify(fallbackObj);

  // If it's a JSON string, accept it.
  try {
    JSON.parse(s);
    return s;
  } catch {
    // Not JSON; wrap into JSON safely
    return JSON.stringify({ ...fallbackObj, raw: s });
  }
}

function randToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function uuidLike() {
  // quick uuid v4-ish (good enough for IDs)
  return crypto.randomUUID ? crypto.randomUUID() : randToken(16);
}

// Cache columns and types so we can do defensive inserts
let _schemaCache = {
  at: 0,
  ttlMs: 60_000,
  tables: {}, // { print_jobs: { colName: { data_type, udt_name } } }
};

async function getTableSchema(tableName) {
  const now = Date.now();
  if (_schemaCache.tables[tableName] && now - _schemaCache.at < _schemaCache.ttlMs) {
    return _schemaCache.tables[tableName];
  }

  const q = `
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = $1
  `;
  const { rows } = await pool.query(q, [tableName]);

  const schema = {};
  for (const r of rows) {
    schema[r.column_name] = { data_type: r.data_type, udt_name: r.udt_name };
  }

  _schemaCache = {
    at: now,
    ttlMs: _schemaCache.ttlMs,
    tables: { ..._schemaCache.tables, [tableName]: schema },
  };

  return schema;
}

function pickExistingColumns(schema, obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (schema[k]) out[k] = v;
  }
  return out;
}

function buildInsert(table, schema, data) {
  const cols = Object.keys(data);
  const vals = Object.values(data);

  // Build placeholders, with JSON casting when needed
  const placeholders = cols.map((c, i) => {
    const t = schema[c];
    const isJson = t && (t.data_type === "json" || t.data_type === "jsonb");
    return isJson ? `$${i + 1}::jsonb` : `$${i + 1}`;
  });

  const sql = `
    INSERT INTO ${table} (${cols.join(", ")})
    VALUES (${placeholders.join(", ")})
    RETURNING *
  `;
  return { sql, vals };
}

function buildUpdate(table, schema, data, whereClause, whereVals) {
  const cols = Object.keys(data);
  const vals = Object.values(data);

  const sets = cols.map((c, i) => {
    const t = schema[c];
    const isJson = t && (t.data_type === "json" || t.data_type === "jsonb");
    return isJson ? `${c} = $${i + 1}::jsonb` : `${c} = $${i + 1}`;
  });

  const sql = `
    UPDATE ${table}
    SET ${sets.join(", ")}
    WHERE ${whereClause}
    RETURNING *
  `;
  return { sql, vals: [...vals, ...whereVals] };
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

// ---------- Routes ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Public job status (optional)
app.get("/public/job/:publicJobId", async (req, res) => {
  try {
    const publicJobId = String(req.params.publicJobId || "").trim();
    if (!publicJobId) return res.status(400).json({ ok: false, error: "Missing publicJobId" });

    const schema = await getTableSchema("print_jobs");
    if (!schema.public_job_id) {
      return res.status(404).json({ ok: false, error: "Public job feature not enabled (missing column public_job_id)" });
    }

    const { rows } = await pool.query(
      `SELECT id, status, pages, copies, created_at, updated_at, printer_id
       FROM print_jobs
       WHERE public_job_id = $1
       LIMIT 1`,
      [publicJobId]
    );

    if (!rows[0]) return res.status(404).json({ ok: false, error: "Not found" });
    return res.json({ ok: true, job: rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
});

// Public file download (secure token)
app.get("/public/file/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).send("Missing token");

    const schema = await getTableSchema("print_jobs");

    // Prefer public_file_token column, fallback to customer_file_url token match (if any)
    if (!schema.public_file_token) {
      return res.status(404).send("Public file feature not enabled (missing column public_file_token)");
    }

    const colsNeeded = ["file_base64", "mime_type", "file_name", "original_name"];
    for (const c of colsNeeded) {
      if (!schema[c]) {
        // Don't hard fail; file_base64 is required
      }
    }

    const { rows } = await pool.query(
      `SELECT file_base64, mime_type, file_name, original_name
       FROM print_jobs
       WHERE public_file_token = $1
       LIMIT 1`,
      [token]
    );

    if (!rows[0]) return res.status(404).send("Not found");

    const b64 = rows[0].file_base64;
    if (!b64) return res.status(404).send("File missing");

    const mime = rows[0].mime_type || "application/octet-stream";
    const name = rows[0].original_name || rows[0].file_name || "file";

    const buf = Buffer.from(b64, "base64");
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${String(name).replace(/"/g, "")}"`);
    return res.send(buf);
  } catch (e) {
    return res.status(500).send("Server error");
  }
});

// ---------- Upload handler (used by both routes) ----------
async function handleUpload(req, res) {
  try {
    const schema = await getTableSchema("print_jobs");

    // File
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const originalName = file.originalname || "upload";
    const mimeType = file.mimetype || "application/octet-stream";
    const fileBase64 = file.buffer.toString("base64");

    // Inputs
    const printerId = String(req.body.printerId || "PP-USA-001").trim();
    const pages = toInt(req.body.pages, 1);
    const copies = toInt(req.body.copies, 1);

    // IMPORTANT: DB column 'color' is BOOLEAN
    const colorBool = toBool(req.body.color, false);

    const source = String(req.body.source || "shopify").trim();

    // details/meta may be JSON in DB. We will always send JSON string safely.
    const detailsJson = safeJsonString(req.body.details, {
      serviceType: "print",
      paperSize: "A4",
      notes: "",
    });

    const metaJson = safeJsonString(req.body.meta, {
      ua: req.headers["user-agent"] || "",
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "",
    });

    // Public link tokens
    const publicJobId = uuidLike();
    const publicFileToken = randToken(24);
    const customerFileUrl = `${BASE_URL.replace(/\/$/, "")}/public/file/${publicFileToken}`;
    const fileExt = (originalName.split(".").pop() || "").toLowerCase();

    // Build data object with many possible columns; we'll keep only existing cols.
    const now = new Date().toISOString();

    const desired = {
      printer_id: printerId,
      status: "queued",
      pages,
      copies,
      color: colorBool, // boolean
      source,

      // common fields in your table
      created_at: now,
      updated_at: now,
      file_name: originalName,       // some schemas use file_name
      original_name: originalName,   // newer
      mime_type: mimeType,
      file_base64: fileBase64,
      details: detailsJson,          // JSON safe
      meta: metaJson,                // JSON safe

      // new safe columns (if exist)
      file_ext: fileExt,
      customer_file_url: customerFileUrl,
      public_job_id: publicJobId,
      public_file_token: publicFileToken,
    };

    const data = pickExistingColumns(schema, desired);

    // Must include at least printer_id, status, file_base64
    if (!data.printer_id) data.printer_id = printerId;
    if (!data.status) data.status = "queued";
    if (!data.file_base64 && schema.file_base64) data.file_base64 = fileBase64;

    const { sql, vals } = buildInsert("print_jobs", schema, data);
    const { rows } = await pool.query(sql, vals);

    const job = rows[0];

    // Return customer file link + jobId
    return res.json({
      ok: true,
      jobId: job?.id,
      status: job?.status || "queued",
      customerFileUrl: schema.public_file_token ? customerFileUrl : null,
      publicJobId: schema.public_job_id ? publicJobId : null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
}

// Main upload endpoint
app.post("/api/upload", upload.single("file"), handleUpload);

// Compatibility route (old Shopify HTML)
app.post("/api/print-jobs/upload", upload.single("file"), handleUpload);

// ---------- Worker endpoints ----------
/**
 * Worker polls this:
 * GET /api/worker/next?printerId=PP-USA-001
 * Auth header: x-worker-key: <WORKER_KEY>
 */
app.get("/api/worker/next", requireWorkerAuth, async (req, res) => {
  const printerId = String(req.query.printerId || "").trim();
  if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

  const client = await pool.connect();
  try {
    const schema = await getTableSchema("print_jobs");

    await client.query("BEGIN");

    // Lock and pick the next queued job for this printer
    const q = `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1 AND status = 'queued'
      ORDER BY created_at ASC NULLS LAST, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const { rows } = await client.query(q, [printerId]);

    if (!rows[0]) {
      await client.query("COMMIT");
      return res.json({ ok: true, job: null });
    }

    const job = rows[0];

    // Mark as printing before returning (prevents loops)
    const upd = pickExistingColumns(schema, {
      status: "printing",
      updated_at: new Date().toISOString(),
    });

    if (Object.keys(upd).length > 0) {
      const { sql, vals } = buildUpdate(
        "print_jobs",
        schema,
        upd,
        "id = $" + (Object.keys(upd).length + 1),
        [job.id]
      );
      await client.query(sql, vals);
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
        color: job.color === true, // boolean
        file_name: job.original_name || job.file_name || "file",
        mime_type: job.mime_type || "application/octet-stream",
        file_base64: job.file_base64, // worker needs this to print
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

/**
 * Worker reports status:
 * POST /api/worker/update
 * Body: { id, status, error }
 */
app.post("/api/worker/update", requireWorkerAuth, async (req, res) => {
  try {
    const id = toInt(req.body.id, 0);
    const status = String(req.body.status || "").trim();
    const errorMsg = String(req.body.error || "").trim();

    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    const schema = await getTableSchema("print_jobs");

    // Update fields safely
    const now = new Date().toISOString();

    // If meta is JSON/JSONB, wrap worker error info as JSON
    const workerMeta = safeJsonString(
      { worker_update: { status, error: errorMsg || null, at: now } },
      { worker_update: { status, error: errorMsg || null, at: now } }
    );

    const desired = {
      status,
      updated_at: now,
      meta: workerMeta,
    };

    const data = pickExistingColumns(schema, desired);

    const { sql, vals } = buildUpdate(
      "print_jobs",
      schema,
      data,
      "id = $" + (Object.keys(data).length + 1),
      [id]
    );

    const { rows } = await pool.query(sql, vals);
    return res.json({ ok: true, job: rows[0] || null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log("✅ MSTAF Core running on port", PORT);
  console.log("✅ BASE_URL:", BASE_URL);
  console.log("✅ WORKER_KEY:", WORKER_KEY ? "(set)" : "(missing)");
});
