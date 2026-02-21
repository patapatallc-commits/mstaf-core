/**
 * MSTAF Print-O-Matic Server (Express) — Stable + Customer File Link After Upload
 * - Shopify uploads file => creates print job in Postgres
 * - Returns file link to customer immediately (fileUrl + customerViewUrl)
 * - Worker polls /api/worker/next-job to get next job
 * - Worker downloads file via /api/worker/jobs/:id/file?token=...
 * - Worker updates status: queued -> printing -> done/error
 *
 * Notes:
 * - Uses local disk storage on Render (ephemeral). If you redeploy, files can be lost.
 *   If you need permanent storage, we can switch to S3/R2 later without changing endpoints.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Pool } = require("pg");

// -------------------- Config --------------------
const PORT = process.env.PORT || 10000;

// IMPORTANT: keep your existing Render URL in CLIENT_ORIGIN if you use it.
// If you don't know it, leave as "*" for now (less secure).
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";

// Worker auth keys (keep compatibility)
const WORKER_KEY =
  process.env.WORKER_KEY ||
  process.env.PRINTER_KEY ||
  "";

// Used to sign download links (set this in Render env)
const FILE_TOKEN_SECRET =
  process.env.FILE_TOKEN_SECRET || "change_me_in_render_env";

// Folder where uploads are stored (Render local disk; ephemeral)
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");

// Ensure upload dir exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

// -------------------- Helpers --------------------
function nowIso() {
  return new Date().toISOString();
}

function safeInt(v, fallback = 1) {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeStr(v, fallback = "") {
  const s = (v ?? "").toString().trim();
  return s.length ? s : fallback;
}

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function signFileToken(jobId) {
  // token includes timestamp to allow rotation later if you want
  const ts = Date.now();
  const raw = `${jobId}:${ts}:${FILE_TOKEN_SECRET}`;
  const sig = sha256(raw).slice(0, 32);
  return `${ts}.${sig}`;
}

function verifyFileToken(jobId, token, maxAgeMs = 1000 * 60 * 60 * 24) {
  // 24 hours default validity
  try {
    const [tsStr, sig] = String(token || "").split(".");
    const ts = parseInt(tsStr, 10);
    if (!ts || !sig) return false;
    if (Date.now() - ts > maxAgeMs) return false;

    const raw = `${jobId}:${ts}:${FILE_TOKEN_SECRET}`;
    const expected = sha256(raw).slice(0, 32);
    return expected === sig;
  } catch (e) {
    return false;
  }
}

function getBaseUrl(req) {
  // Uses X-Forwarded-Proto on Render
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function workerAuthOk(req) {
  // Accept BOTH headers for compatibility
  const h1 = safeStr(req.headers["x-worker-key"]);
  const h2 = safeStr(req.headers["x-printer-key"]);
  const provided = h1 || h2;
  return WORKER_KEY && provided && provided === WORKER_KEY;
}

// Optional: routing (A3/CARD to other printers)
function resolvePrinterId({ printerId, paperSize }) {
  // Keep your current printerId by default
  // Add overrides using env vars if you want
  // e.g. A3_PRINTER_ID=PP-USA-A3-001, CARD_PRINTER_ID=PP-USA-CARD-001
  const p = safeStr(paperSize).toUpperCase();
  if (p === "A3" && process.env.A3_PRINTER_ID) return process.env.A3_PRINTER_ID;
  if ((p === "CARD" || p === "CARDSTOCK") && process.env.CARD_PRINTER_ID) return process.env.CARD_PRINTER_ID;
  return safeStr(printerId, "PP-USA-001");
}

// Cost logic you requested previously: BW $0.25, Color $0.50 (per page)
function computePrintCost({ colorMode, pages, copies }) {
  const mode = safeStr(colorMode, "bw").toLowerCase();
  const rate = mode === "color" ? 0.50 : 0.25;
  return Number((rate * pages * copies).toFixed(2));
}

// -------------------- Multer (file upload) --------------------
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    // Keep original extension
    const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
    const id = crypto.randomBytes(8).toString("hex");
    cb(null, `upload_${Date.now()}_${id}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// -------------------- App --------------------
const app = express();
app.use(cors({ origin: CLIENT_ORIGIN === "*" ? true : CLIENT_ORIGIN }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Health
app.get("/", (req, res) => {
  res.json({ ok: true, service: "mstaf-print-server", time: nowIso() });
});

// -------------------- DB init (safe) --------------------
async function ensureTables() {
  // Creates tables if missing, without breaking existing setups.
  // If you already have these tables/columns, Postgres will ignore IF NOT EXISTS / ALTER IF.
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS print_jobs (
        id SERIAL PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued',
        printer_id TEXT NOT NULL DEFAULT 'PP-USA-001',
        paper_size TEXT NOT NULL DEFAULT 'A4',
        color_mode TEXT NOT NULL DEFAULT 'bw',
        copies INT NOT NULL DEFAULT 1,
        pages INT NOT NULL DEFAULT 1,
        instructions TEXT DEFAULT '',
        service_type TEXT DEFAULT 'print',
        original_name TEXT DEFAULT '',
        stored_name TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        file_mime TEXT DEFAULT '',
        file_size BIGINT DEFAULT 0,
        print_cost NUMERIC(10,2) DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        printed_at TIMESTAMP
      );
    `);

    // Add columns only if missing (won't break)
    await client.query(`
      ALTER TABLE print_jobs
      ADD COLUMN IF NOT EXISTS customer_file_token TEXT DEFAULT '';
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_print_jobs_printer ON print_jobs(printer_id);
    `);
  } finally {
    client.release();
  }
}

ensureTables().catch((e) => {
  console.error("DB init error:", e);
});

// -------------------- Shopify Upload Endpoint --------------------
/**
 * POST /api/print-jobs/upload
 * multipart/form-data:
 * - file
 * - printerId
 * - paperSize (A4, Letter, A3, CARD)
 * - colorMode (bw, color)
 * - copies (int)
 * - pages (int)
 * - instructions (text)
 * - serviceType (print, photo_editing, video_editing, etc)
 *
 * Returns:
 * - jobId
 * - fileUrl (clickable link)
 * - customerViewUrl (simple HTML view with file link)
 * - estimatedCost
 */
app.post("/api/print-jobs/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const paperSize = safeStr(req.body.paperSize, "A4");
    const colorMode = safeStr(req.body.colorMode, "bw");
    const copies = safeInt(req.body.copies, 1);
    const pages = safeInt(req.body.pages, 1);
    const instructions = safeStr(req.body.instructions, "");
    const serviceType = safeStr(req.body.serviceType, "print");

    const requestedPrinterId = safeStr(req.body.printerId, "PP-USA-001");
    const printerId = resolvePrinterId({ printerId: requestedPrinterId, paperSize });

    const cost = computePrintCost({ colorMode, pages, copies });

    const originalName = safeStr(req.file.originalname, "");
    const storedName = safeStr(req.file.filename, "");
    const storedPath = safeStr(req.file.path, "");
    const fileMime = safeStr(req.file.mimetype, "");
    const fileSize = Number(req.file.size || 0);

    // Create job + token for customer file link
    const client = await pool.connect();
    let job;
    try {
      const insert = await client.query(
        `
        INSERT INTO print_jobs
        (status, printer_id, paper_size, color_mode, copies, pages, instructions, service_type,
         original_name, stored_name, stored_path, file_mime, file_size, print_cost, customer_file_token)
        VALUES
        ('queued', $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, '')
        RETURNING *
        `,
        [
          printerId,
          paperSize,
          colorMode,
          copies,
          pages,
          instructions,
          serviceType,
          originalName,
          storedName,
          storedPath,
          fileMime,
          fileSize,
          cost,
        ]
      );

      job = insert.rows[0];

      // token unique per job (store in DB)
      const token = signFileToken(job.id);
      await client.query(
        `UPDATE print_jobs SET customer_file_token=$1, updated_at=NOW() WHERE id=$2`,
        [token, job.id]
      );
      job.customer_file_token = token;
    } finally {
      client.release();
    }

    const baseUrl = getBaseUrl(req);

    // File link customer can click (secured by token)
    const fileUrl = `${baseUrl}/api/public/jobs/${job.id}/file?token=${encodeURIComponent(job.customer_file_token)}`;
    // A simple page that shows the file link + job status
    const customerViewUrl = `${baseUrl}/public/job/${job.id}?token=${encodeURIComponent(job.customer_file_token)}`;

    return res.json({
      ok: true,
      jobId: job.id,
      status: job.status,
      printerId: job.printer_id,
      paperSize: job.paper_size,
      colorMode: job.color_mode,
      copies: job.copies,
      pages: job.pages,
      estimatedCost: Number(job.print_cost),
      fileUrl,
      customerViewUrl,
    });
  } catch (e) {
    console.error("Upload error:", e);
    return res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

// Public simple HTML view (customer-friendly)
app.get("/public/job/:id", async (req, res) => {
  try {
    const id = safeInt(req.params.id, 0);
    const token = safeStr(req.query.token, "");
    if (!id || !token) return res.status(400).send("Missing job or token");

    const client = await pool.connect();
    try {
      const r = await client.query(`SELECT * FROM print_jobs WHERE id=$1`, [id]);
      if (!r.rows.length) return res.status(404).send("Job not found");
      const job = r.rows[0];

      // validate token equals stored token (stronger than just verifying signature)
      if (token !== job.customer_file_token) return res.status(403).send("Invalid token");

      const baseUrl = getBaseUrl(req);
      const fileUrl = `${baseUrl}/api/public/jobs/${job.id}/file?token=${encodeURIComponent(token)}`;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1"/>
            <title>Print Job #${job.id}</title>
            <style>
              body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:18px;max-width:720px;margin:0 auto}
              .card{border:1px solid #e5e7eb;border-radius:14px;padding:16px}
              .row{display:flex;gap:10px;flex-wrap:wrap}
              .pill{background:#f3f4f6;border-radius:999px;padding:6px 10px;font-size:13px}
              a{word-break:break-all}
              .btn{display:inline-block;margin-top:10px;background:#2563eb;color:#fff;text-decoration:none;padding:10px 12px;border-radius:10px}
            </style>
          </head>
          <body>
            <h2>✅ Your Upload is Ready</h2>
            <div class="card">
              <div class="row">
                <div class="pill">Job ID: ${job.id}</div>
                <div class="pill">Status: ${job.status}</div>
                <div class="pill">Paper: ${job.paper_size}</div>
                <div class="pill">Mode: ${job.color_mode}</div>
                <div class="pill">Copies: ${job.copies}</div>
                <div class="pill">Pages: ${job.pages}</div>
              </div>
              <p style="margin-top:12px;margin-bottom:6px;"><b>Your File Link:</b></p>
              <a href="${fileUrl}" target="_blank" rel="noopener">Open / Download Uploaded File</a>
              <br/>
              <a class="btn" href="${fileUrl}" target="_blank" rel="noopener">Open File</a>
              <p style="margin-top:12px;"><b>Estimated Cost:</b> $${Number(job.print_cost).toFixed(2)}</p>
            </div>
          </body>
        </html>
      `);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("Customer view error:", e);
    res.status(500).send("Server error");
  }
});

// Public file access for customer (token-gated)
app.get("/api/public/jobs/:id/file", async (req, res) => {
  try {
    const id = safeInt(req.params.id, 0);
    const token = safeStr(req.query.token, "");
    if (!id || !token) return res.status(400).json({ ok: false, error: "Missing id/token" });

    const client = await pool.connect();
    try {
      const r = await client.query(`SELECT stored_path, original_name, file_mime, customer_file_token FROM print_jobs WHERE id=$1`, [id]);
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });

      const job = r.rows[0];
      if (token !== job.customer_file_token) return res.status(403).json({ ok: false, error: "Invalid token" });

      const fp = job.stored_path;
      if (!fp || !fs.existsSync(fp)) return res.status(404).json({ ok: false, error: "File missing on server" });

      res.setHeader("Content-Type", job.file_mime || "application/octet-stream");
      // inline so customer can view
      res.setHeader("Content-Disposition", `inline; filename="${(job.original_name || `job_${id}`).replace(/"/g, "")}"`);
      return fs.createReadStream(fp).pipe(res);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("Public file error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// -------------------- Worker Endpoints --------------------

// Worker polls next job for its printerId
// GET /api/worker/next-job?printerId=PP-USA-001
app.get("/api/worker/next-job", async (req, res) => {
  try {
    if (!workerAuthOk(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const printerId = safeStr(req.query.printerId, "PP-USA-001");
    const client = await pool.connect();

    try {
      // Find oldest queued job for this printer
      const r = await client.query(
        `
        SELECT * FROM print_jobs
        WHERE status='queued' AND printer_id=$1
        ORDER BY id ASC
        LIMIT 1
        `,
        [printerId]
      );

      if (!r.rows.length) return res.json({ ok: true, job: null });

      const job = r.rows[0];

      // Mark as "printing" BEFORE worker prints (prevents reprint loops)
      await client.query(
        `UPDATE print_jobs SET status='printing', updated_at=NOW() WHERE id=$1`,
        [job.id]
      );

      // Provide worker a short-lived token (use signature verify OR reuse customer token)
      // We'll generate a separate worker token using signature check
      const workerToken = signFileToken(job.id);

      const baseUrl = getBaseUrl(req);
      const downloadUrl = `${baseUrl}/api/worker/jobs/${job.id}/file?token=${encodeURIComponent(workerToken)}`;

      return res.json({
        ok: true,
        job: {
          id: job.id,
          printerId: job.printer_id,
          paperSize: job.paper_size,
          colorMode: job.color_mode,
          copies: job.copies,
          pages: job.pages,
          serviceType: job.service_type,
          instructions: job.instructions,
          originalName: job.original_name,
          printCost: Number(job.print_cost),
          downloadUrl,
          // helpful for debugging
          createdAt: job.created_at,
        },
      });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("next-job error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Worker downloads job file
app.get("/api/worker/jobs/:id/file", async (req, res) => {
  try {
    if (!workerAuthOk(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const id = safeInt(req.params.id, 0);
    const token = safeStr(req.query.token, "");
    if (!id || !token) return res.status(400).json({ ok: false, error: "Missing id/token" });

    if (!verifyFileToken(id, token, 1000 * 60 * 60 * 6)) {
      // 6 hours worker token validity
      return res.status(403).json({ ok: false, error: "Invalid/expired token" });
    }

    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT stored_path, original_name, file_mime FROM print_jobs WHERE id=$1`,
        [id]
      );
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });

      const job = r.rows[0];
      const fp = job.stored_path;
      if (!fp || !fs.existsSync(fp)) return res.status(404).json({ ok: false, error: "File missing on server" });

      res.setHeader("Content-Type", job.file_mime || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${(job.original_name || `job_${id}`).replace(/"/g, "")}"`);
      return fs.createReadStream(fp).pipe(res);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("worker file error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Worker updates job status
// POST /api/worker/jobs/:id/status  { status: "done"|"error", errorMessage?: "" }
app.post("/api/worker/jobs/:id/status", async (req, res) => {
  try {
    if (!workerAuthOk(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const id = safeInt(req.params.id, 0);
    const status = safeStr(req.body.status, "");
    const errorMessage = safeStr(req.body.errorMessage, "");

    if (!id || !status) return res.status(400).json({ ok: false, error: "Missing id/status" });

    const client = await pool.connect();
    try {
      if (status === "done") {
        await client.query(
          `UPDATE print_jobs SET status='done', updated_at=NOW(), printed_at=NOW() WHERE id=$1`,
          [id]
        );
      } else if (status === "error") {
        // Keep error message in instructions field suffix to avoid schema changes
        const suffix = errorMessage ? `\n\n[WORKER ERROR] ${errorMessage}` : `\n\n[WORKER ERROR] Unknown error`;
        await client.query(
          `UPDATE print_jobs SET status='error', updated_at=NOW(), instructions=COALESCE(instructions,'') || $2 WHERE id=$1`,
          [id, suffix]
        );
      } else {
        await client.query(
          `UPDATE print_jobs SET status=$2, updated_at=NOW() WHERE id=$1`,
          [id, status]
        );
      }
      return res.json({ ok: true });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("status update error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Optional: customer status check (token-gated)
app.get("/api/public/jobs/:id/status", async (req, res) => {
  try {
    const id = safeInt(req.params.id, 0);
    const token = safeStr(req.query.token, "");
    if (!id || !token) return res.status(400).json({ ok: false, error: "Missing id/token" });

    const client = await pool.connect();
    try {
      const r = await client.query(`SELECT id,status,print_cost,printer_id,paper_size,color_mode,copies,pages,created_at,updated_at FROM print_jobs WHERE id=$1`, [id]);
      if (!r.rows.length) return res.status(404).json({ ok: false, error: "Not found" });

      // Compare to stored token to keep it private
      const t = await client.query(`SELECT customer_file_token FROM print_jobs WHERE id=$1`, [id]);
      if (!t.rows.length || token !== t.rows[0].customer_file_token) {
        return res.status(403).json({ ok: false, error: "Invalid token" });
      }

      return res.json({ ok: true, job: r.rows[0] });
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("public status error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`MSTAF server running on port ${PORT}`);
});
