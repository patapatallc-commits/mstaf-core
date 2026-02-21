/**
 * MSTAF Core - Server.js (Worker + Upload Stable)
 * - Shopify upload (multipart) -> creates print_jobs row
 * - Worker polling endpoint (GET /api/worker/next?printerId=...)
 * - Worker update endpoint (POST /api/worker/update)
 * - Defensive DB writes (only writes columns that exist)
 * - Safe boolean + JSON handling (prevents 500 errors)
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;

const BASE_URL =
  (process.env.BASE_URL && process.env.BASE_URL.trim()) ||
  (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.trim()) ||
  "https://mstaf-core-1.onrender.com";

const WORKER_KEY =
  (process.env.WORKER_KEY || process.env.PRINTER_KEY || process.env.WORKER_SECRET || "").trim();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

// ---------------- MIDDLEWARE ----------------
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Allow Shopify + browsers; safe permissive fallback
app.use(
  cors({
    origin: (origin, cb) => cb(null, true),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-worker-key", "x-printer-key", "authorization"],
  })
);

// Multer: in-memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
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
  if (["false", "0", "no", "n", "off", "bw", "b&w", "black", "blackwhite"].includes(s)) return false;
  return fallback;
}

function safeJsonValue(input, fallbackObj = {}) {
  // returns a JSON string ALWAYS (valid JSON)
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
    return s; // already valid JSON string
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

// ---- schema cache (fast + defensive) ----
let schemaCache = { at: 0, ttl: 60_000, tables: {} };

async function getSchema(table) {
  const now = Date.now();
  if (schemaCache.tables[table] && now - schemaCache.at < schemaCache.ttl) {
    return schemaCache.tables[table];
  }

  const { rows } = await pool.query(
    `
    SELECT column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = $1
  `,
    [table]
  );

  const schema = {};
  for (const r of rows) schema[r.column_name] = { data_type: r.data_type, udt_name: r.udt_name };

  schemaCache = {
    ...schemaCache,
    at: now,
    tables: { ...schemaCache.tables, [table]: schema },
  };

  return schema;
}

function pickExisting(schema, obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (schema[k]) out[k] = v;
  }
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
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Public secure file download (if enabled columns exist)
app.get("/public/file/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(400).send("Missing token");

    const schema = await getSchema("print_jobs");
    if (!schema.public_file_token) return res.status(404).send("Public file not enabled");

    const { rows } = await pool.query(
      `SELECT file_base64, mime_type, original_name, file_name
       FROM print_jobs
       WHERE public_file_token = $1
       LIMIT 1`,
      [token]
    );

    if (!rows[0] || !rows[0].file_base64) return res.status(404).send("Not found");

    const mime = rows[0].mime_type || "application/octet-stream";
    const name = rows[0].original_name || rows[0].file_name || "file";

    const buf = Buffer.from(rows[0].file_base64, "base64");
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${String(name).replace(/"/g, "")}"`);
    res.send(buf);
  } catch (e) {
    res.status(500).send("Server error");
  }
});

// ---------- UPLOAD HANDLER (shared) ----------
async function handleUpload(req, res) {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const schema = await getSchema("print_jobs");

    const printerId = String(req.body.printerId || "PP-USA-001").trim();
    const pages = toInt(req.body.pages, 1);
    const copies = toInt(req.body.copies, 1);

    // DB expects boolean in most setups
    const colorBool = toBool(req.body.color, false);

    const originalName = file.originalname || "upload";
    const mimeType = file.mimetype || "application/octet-stream";
    const fileBase64 = file.buffer.toString("base64");

    // Always safe JSON strings
    const detailsJson = safeJsonValue(req.body.details, {
      serviceType: req.body.serviceType || "print",
      paperSize: req.body.paperSize || "A4",
      instructions: req.body.instructions || "",
    });

    const metaJson = safeJsonValue(req.body.meta, {
      ua: req.headers["user-agent"] || "",
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "",
      source: req.body.source || "shopify",
    });

    const publicJobId = uuidLike();
    const publicFileToken = randToken(24);
    const customerFileUrl = `${BASE_URL.replace(/\/$/, "")}/public/file/${publicFileToken}`;

    const desired = {
      printer_id: printerId,
      status: "queued",
      pages,
      copies,
      color: colorBool,
      source: String(req.body.source || "shopify").trim(),

      file_name: originalName,
      original_name: originalName,
      mime_type: mimeType,
      file_base64: fileBase64,

      details: detailsJson,
      meta: metaJson,

      public_job_id: publicJobId,
      public_file_token: publicFileToken,
      customer_file_url: customerFileUrl,

      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const data = pickExisting(schema, desired);

    // minimal safety: keep required columns if they exist
    if (schema.printer_id && !data.printer_id) data.printer_id = printerId;
    if (schema.status && !data.status) data.status = "queued";
    if (schema.file_base64 && !data.file_base64) data.file_base64 = fileBase64;

    const { sql, vals } = buildInsertSQL("print_jobs", schema, data);
    const { rows } = await pool.query(sql, vals);

    const job = rows[0];

    res.json({
      ok: true,
      jobId: job?.id,
      status: job?.status || "queued",
      customerFileUrl: schema.public_file_token ? customerFileUrl : null,
      publicJobId: schema.public_job_id ? publicJobId : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
}

// Shopify upload endpoints
app.post("/api/upload", upload.single("file"), handleUpload);
app.post("/api/print-jobs/upload", upload.single("file"), handleUpload);

// ---------- WORKER: NEXT JOB ----------
/**
 * GET /api/worker/next?printerId=PP-USA-001
 * headers: x-worker-key OR x-printer-key
 */
app.get("/api/worker/next", requireWorkerAuth, async (req, res) => {
  const printerId = String(req.query.printerId || "").trim();
  if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

  const client = await pool.connect();
  try {
    const schema = await getSchema("print_jobs");

    await client.query("BEGIN");

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

    // mark printing before returning (prevents reprint loop)
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
    try {
      await client.query("ROLLBACK");
    } catch {}
    res.status(500).json({ ok: false, error: "Server error", details: e.message });
  } finally {
    client.release();
  }
});

// ---------- WORKER: UPDATE STATUS ----------
/**
 * POST /api/worker/update
 * body: { id, status, error }
 */
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

    res.json({ ok: true, job: rows[0] || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
});

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log("✅ MSTAF Core running on port", PORT);
  console.log("✅ BASE_URL:", BASE_URL);
  console.log("✅ WORKER_KEY:", WORKER_KEY ? "(set)" : "(missing)");
});
