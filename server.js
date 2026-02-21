/**
 * MSTAF Core Server (Render) - Stable + Defensive DB Writes
 * - Upload print job (Shopify form or API)
 * - Worker pulls next job, server marks as printing before returning
 * - Worker updates status done/error
 * - Public file link returned after upload (customerFileUrl)
 *
 * IMPORTANT: DB schema safe:
 * - Uses file_name (NOT original_name) because your table already has file_name.
 * - Uses schema-aware insert/update so missing columns will never crash the API.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL env var");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

// If you're serving behind Render, set your public base URL like:
// BASE_URL=https://mstaf-core-1.onrender.com
const BASE_URL =
  (process.env.BASE_URL || "").trim() ||
  (process.env.RENDER_EXTERNAL_URL || "").trim() ||
  ""; // if empty, we will still return relative links

// Worker key can come from either env var:
const WORKER_KEY = (process.env.WORKER_KEY || process.env.PRINTER_KEY || "").trim();

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Multer: in-memory upload (we store base64 in DB because your table has file_base64)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ---------- Helpers ----------
function nowIso() {
  return new Date().toISOString();
}

function randToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

function isTruthy(x) {
  return x === true || x === "true" || x === "1" || x === 1;
}

// Read worker key from either header name
function getWorkerKeyFromReq(req) {
  return (
    (req.headers["x-worker-key"] || "").toString().trim() ||
    (req.headers["x-printer-key"] || "").toString().trim()
  );
}

function requireWorkerAuth(req, res, next) {
  // If no WORKER_KEY configured, allow (but log) — you can enforce by setting WORKER_KEY env var.
  if (!WORKER_KEY) {
    console.warn("⚠️ WORKER_KEY/PRINTER_KEY not set. Worker endpoints are NOT protected.");
    return next();
  }
  const k = getWorkerKeyFromReq(req);
  if (!k || k !== WORKER_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized worker" });
  }
  next();
}

async function getTableColumns(tableName) {
  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [tableName]
  );
  return new Set(rows.map((r) => r.column_name));
}

function pickExistingCols(payload, colsSet) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (colsSet.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

async function safeInsert(tableName, payload) {
  const colsSet = await getTableColumns(tableName);
  const data = pickExistingCols(payload, colsSet);

  const keys = Object.keys(data);
  if (keys.length === 0) {
    throw new Error(`safeInsert: no matching columns found for ${tableName}`);
  }

  const vals = keys.map((k) => data[k]);
  const colsSql = keys.map((k) => `"${k}"`).join(", ");
  const paramsSql = keys.map((_, i) => `$${i + 1}`).join(", ");

  const sql = `INSERT INTO "${tableName}" (${colsSql}) VALUES (${paramsSql}) RETURNING *`;
  return pool.query(sql, vals);
}

async function safeUpdateById(tableName, id, payload) {
  const colsSet = await getTableColumns(tableName);
  const data = pickExistingCols(payload, colsSet);

  const keys = Object.keys(data);
  if (keys.length === 0) {
    // nothing to update, return current row
    return pool.query(`SELECT * FROM "${tableName}" WHERE id=$1`, [id]);
  }

  const sets = keys.map((k, i) => `"${k}"=$${i + 2}`).join(", ");
  const vals = [id, ...keys.map((k) => data[k])];

  const sql = `UPDATE "${tableName}" SET ${sets} WHERE id=$1 RETURNING *`;
  return pool.query(sql, vals);
}

function safeJsonParse(maybeJson, fallback = null) {
  if (maybeJson == null) return fallback;
  if (typeof maybeJson === "object") return maybeJson;
  try {
    return JSON.parse(maybeJson);
  } catch {
    return fallback;
  }
}

function buildPublicFileUrl(token) {
  const path = `/public/file/${token}`;
  if (!BASE_URL) return path;
  return `${BASE_URL}${path}`;
}

// ---------- Routes ----------
app.get("/", (req, res) => res.json({ ok: true, service: "mstaf-core-1", time: nowIso() }));
app.get("/health", (req, res) => res.json({ ok: true, time: nowIso() }));

/**
 * SHOPIFY / FORM UPLOAD ENDPOINT
 * Expects multipart/form-data:
 * - file (pdf/jpg/png)
 * - printerId
 * - pages
 * - copies
 * - color (color / bw)
 * - details (instructions)
 * - source (shopify)
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const printerId = (req.body.printerId || req.body.printer_id || "PP-USA-001").toString().trim();
    const pages = Number(req.body.pages || 1) || 1;
    const copies = Number(req.body.copies || 1) || 1;
    const color = (req.body.color || "bw").toString().trim(); // "color" or "bw"
    const source = (req.body.source || "shopify").toString().trim();
    const details = (req.body.details || req.body.instructions || "").toString();

    // Your DB has file_name, mime_type, file_base64
    const file_name = (file.originalname || "upload").toString();
    const mime_type = (file.mimetype || "application/octet-stream").toString();
    const file_base64 = file.buffer.toString("base64");

    // Public access token/job id (won't crash if columns don't exist)
    const public_job_id = randToken(10);
    const public_file_token = randToken(18);

    // Store token also inside meta for fallback if columns don't exist
    const metaObj = {
      source,
      uploaded_at: nowIso(),
      public_job_id,
      public_file_token,
    };

    const payload = {
      printer_id: printerId,
      status: "queued",
      pages,
      copies,
      color,
      source,
      file_name,
      mime_type,
      file_base64,
      details,
      updated_at: nowIso(),
      meta: JSON.stringify(metaObj),
      public_job_id,        // inserted if column exists
      public_file_token,    // inserted if column exists
      customer_file_url: buildPublicFileUrl(public_file_token), // inserted if column exists
    };

    const inserted = await safeInsert("print_jobs", payload);
    const job = inserted.rows[0];

    // Always return a link even if db doesn't have customer_file_url column
    const customerFileUrl = buildPublicFileUrl(public_file_token);

    return res.json({
      ok: true,
      jobId: job.id,
      printerId,
      status: job.status,
      customerFileUrl,
      publicJobId: public_job_id,
    });
  } catch (e) {
    console.error("❌ /api/upload error:", e);
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
});

/**
 * JSON UPLOAD ENDPOINT (optional)
 * Accepts JSON:
 * { printerId, fileName, mimeType, fileBase64, pages, copies, color, details, source }
 */
app.post("/api/upload-json", async (req, res) => {
  try {
    const {
      printerId = "PP-USA-001",
      fileName = "upload.pdf",
      mimeType = "application/pdf",
      fileBase64,
      pages = 1,
      copies = 1,
      color = "bw",
      details = "",
      source = "api",
    } = req.body || {};

    if (!fileBase64) {
      return res.status(400).json({ ok: false, error: "fileBase64 is required" });
    }

    const public_job_id = randToken(10);
    const public_file_token = randToken(18);

    const metaObj = { source, uploaded_at: nowIso(), public_job_id, public_file_token };

    const payload = {
      printer_id: printerId,
      status: "queued",
      pages: Number(pages) || 1,
      copies: Number(copies) || 1,
      color: (color || "bw").toString(),
      source: (source || "api").toString(),
      file_name: fileName.toString(),
      mime_type: mimeType.toString(),
      file_base64: fileBase64.toString(),
      details: details.toString(),
      updated_at: nowIso(),
      meta: JSON.stringify(metaObj),
      public_job_id,
      public_file_token,
      customer_file_url: buildPublicFileUrl(public_file_token),
    };

    const inserted = await safeInsert("print_jobs", payload);
    const job = inserted.rows[0];

    return res.json({
      ok: true,
      jobId: job.id,
      printerId: job.printer_id,
      status: job.status,
      customerFileUrl: buildPublicFileUrl(public_file_token),
      publicJobId: public_job_id,
    });
  } catch (e) {
    console.error("❌ /api/upload-json error:", e);
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
});

/**
 * WORKER: Get next job for a printer
 * - Auth: x-worker-key OR x-printer-key
 * - Query: ?printerId=PP-USA-001
 * Behavior:
 * - Finds oldest queued job for that printer
 * - Marks it "printing" BEFORE returning (prevents reprint loops)
 */
app.get("/api/worker/next", requireWorkerAuth, async (req, res) => {
  try {
    const printerId = (req.query.printerId || req.query.printer_id || "").toString().trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "printerId is required" });

    // Grab next queued job
    const { rows } = await pool.query(
      `SELECT *
       FROM print_jobs
       WHERE printer_id = $1 AND status = 'queued'
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      [printerId]
    );

    if (rows.length === 0) return res.json({ ok: true, job: null });

    const job = rows[0];

    // Mark as printing before returning
    const updated = await safeUpdateById("print_jobs", job.id, {
      status: "printing",
      updated_at: nowIso(),
    });

    const updatedJob = updated.rows[0] || job;

    // Provide both base64 and a public link (worker can choose)
    // Token might be in columns or in meta
    const metaObj = safeJsonParse(updatedJob.meta, {});
    const token =
      updatedJob.public_file_token ||
      metaObj.public_file_token ||
      null;

    return res.json({
      ok: true,
      job: {
        id: updatedJob.id,
        printer_id: updatedJob.printer_id,
        status: updatedJob.status,
        pages: updatedJob.pages,
        copies: updatedJob.copies,
        color: updatedJob.color,
        file_name: updatedJob.file_name,
        mime_type: updatedJob.mime_type,
        file_base64: updatedJob.file_base64, // existing workflow
        details: updatedJob.details,
        customerFileUrl: token ? buildPublicFileUrl(token) : null,
      },
    });
  } catch (e) {
    console.error("❌ /api/worker/next error:", e);
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
});

/**
 * WORKER: Update job status
 * Body: { id, status, error }
 * status: printing | done | error
 */
app.post("/api/worker/update", requireWorkerAuth, async (req, res) => {
  try {
    const { id, status, error } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "id is required" });
    if (!status) return res.status(400).json({ ok: false, error: "status is required" });

    const payload = {
      status: status.toString(),
      updated_at: nowIso(),
    };

    // If your table has "details", we can append error text there safely
    if (status === "error" && error) {
      // Do not overwrite existing details if not desired; store in meta if possible
      const { rows } = await pool.query(`SELECT meta, details FROM print_jobs WHERE id=$1`, [id]);
      const current = rows[0] || {};
      const metaObj = safeJsonParse(current.meta, {}) || {};
      metaObj.last_error = error.toString();
      metaObj.error_at = nowIso();

      payload.meta = JSON.stringify(metaObj);

      // optionally append to details
      const existingDetails = (current.details || "").toString();
      payload.details = existingDetails
        ? `${existingDetails}\n\n[ERROR] ${error.toString()}`
        : `[ERROR] ${error.toString()}`;
    }

    const updated = await safeUpdateById("print_jobs", id, payload);
    return res.json({ ok: true, job: updated.rows[0] });
  } catch (e) {
    console.error("❌ /api/worker/update error:", e);
    return res.status(500).json({ ok: false, error: "Server error", details: e.message });
  }
});

/**
 * PUBLIC: Download file by token (customerFileUrl)
 * Works even if you don't have public_file_token column:
 * - checks public_file_token column if present
 * - else checks meta.public_file_token
 */
app.get("/public/file/:token", async (req, res) => {
  try {
    const token = (req.params.token || "").toString().trim();
    if (!token) return res.status(400).send("Missing token");

    // Try direct column match first
    let jobRow = null;

    // Check if column exists before querying it (avoid SQL error)
    const cols = await getTableColumns("print_jobs");
    if (cols.has("public_file_token")) {
      const q1 = await pool.query(
        `SELECT id, file_name, mime_type, file_base64, meta
         FROM print_jobs
         WHERE public_file_token = $1
         ORDER BY id DESC
         LIMIT 1`,
        [token]
      );
      jobRow = q1.rows[0] || null;
    }

    // Fallback: search meta text if needed (meta may be JSON text)
    if (!jobRow) {
      const q2 = await pool.query(
        `SELECT id, file_name, mime_type, file_base64, meta
         FROM print_jobs
         WHERE meta::text ILIKE $1
         ORDER BY id DESC
         LIMIT 1`,
        [`%${token}%`]
      );

      const candidate = q2.rows[0] || null;
      if (candidate) {
        const metaObj = safeJsonParse(candidate.meta, {});
        if (metaObj && metaObj.public_file_token === token) jobRow = candidate;
      }
    }

    if (!jobRow) return res.status(404).send("File not found");

    const fileName = jobRow.file_name || "download";
    const mimeType = jobRow.mime_type || "application/octet-stream";
    const base64 = jobRow.file_base64;

    if (!base64) return res.status(404).send("File missing");

    const buf = Buffer.from(base64, "base64");
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    return res.send(buf);
  } catch (e) {
    console.error("❌ /public/file/:token error:", e);
    return res.status(500).send("Server error");
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ mstaf-core-1 listening on port ${PORT}`);
  if (BASE_URL) console.log(`✅ BASE_URL = ${BASE_URL}`);
  console.log(`✅ WORKER_KEY set? ${WORKER_KEY ? "YES" : "NO"}`);
});
