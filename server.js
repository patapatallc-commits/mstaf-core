/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * ✅ Stores file bytes in DB (file_base64)
 * ✅ Worker downloads via: GET /jobs/:id/file (auth with WORKER_KEY)
 * ✅ Worker polls via: GET /jobs/next?printerId=PP-USA-001 (auth)
 * ✅ Status updates via: POST /jobs/:id/status (auth)
 */

"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const WORKER_KEY = process.env.WORKER_KEY || "";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL env var");
  process.exit(1);
}

// ---------- DB ----------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function ensureSchema() {
  // Keep schema flexible and safe for repeated deploys
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      printer_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',

      -- file data
      file_name TEXT,
      file_mime TEXT,
      file_base64 TEXT,

      -- optional original URL (legacy / debugging)
      original_url TEXT,

      -- job options
      paper_size TEXT,
      color_mode TEXT,
      copies INT,
      pages INT,
      service_type TEXT,

      -- customer / notes
      customer_name TEXT,
      customer_phone TEXT,
      notes TEXT
    );
  `);

  // Helpful index for polling
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_print_jobs_poll
    ON print_jobs (printer_id, status, created_at);
  `);
}

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json({ limit: "5mb" })); // JSON routes (not file uploads)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

function requireWorkerAuth(req, res, next) {
  // Accept either x-worker-key or Authorization: Bearer <key>
  const headerKey = req.headers["x-worker-key"];
  const auth = req.headers["authorization"];
  const bearer = auth && auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;

  const key = (headerKey || bearer || "").trim();

  if (!WORKER_KEY) {
    return res.status(500).json({ ok: false, error: "Server missing WORKER_KEY" });
  }
  if (!key || key !== WORKER_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized worker" });
  }
  next();
}

function toBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

function normalizeBase64(b64) {
  if (!b64) return null;
  // Strip data URL prefix if present
  const m = String(b64).match(/^data:.*?;base64,(.*)$/i);
  return m ? m[1] : String(b64);
}

function safeInt(v, fallback = null) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- ROUTES ----------
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Upload endpoint (used by your Shopify page form)
 * Expects multipart/form-data:
 *  - file (PDF/image)
 *  - printerId
 *  - paperSize
 *  - colorMode
 *  - copies
 *  - pages
 *  - serviceType
 *  - customerName, customerPhone, notes
 */
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ ok: false, error: "No file uploaded (field name must be 'file')" });
    }

    const printerId = (req.body.printerId || req.body.printer_id || "").trim();
    if (!printerId) {
      return res.status(400).json({ ok: false, error: "Missing printerId" });
    }

    const paperSize = (req.body.paperSize || req.body.paper_size || "A4").trim();
    const colorMode = (req.body.colorMode || req.body.color_mode || "color").trim();
    const copies = safeInt(req.body.copies, 1) ?? 1;
    const pages = safeInt(req.body.pages, null);
    const serviceType = (req.body.serviceType || req.body.service_type || "print").trim();

    const customerName = (req.body.customerName || req.body.customer_name || "").trim();
    const customerPhone = (req.body.customerPhone || req.body.customer_phone || "").trim();
    const notes = (req.body.notes || "").trim();

    const fileBase64 = toBase64(file.buffer);
    const fileName = file.originalname || `upload-${Date.now()}.bin`;
    const fileMime = file.mimetype || "application/octet-stream";

    const insert = await pool.query(
      `
      INSERT INTO print_jobs
        (printer_id, status, file_name, file_mime, file_base64, paper_size, color_mode, copies, pages, service_type,
         customer_name, customer_phone, notes, original_url)
      VALUES
        ($1, 'queued', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL)
      RETURNING id, created_at
      `,
      [
        printerId,
        fileName,
        fileMime,
        fileBase64,
        paperSize,
        colorMode,
        copies,
        pages,
        serviceType,
        customerName,
        customerPhone,
        notes,
      ]
    );

    res.json({
      ok: true,
      job: {
        id: insert.rows[0].id,
        printer_id: printerId,
        status: "queued",
        file_name: fileName,
        file_mime: fileMime,
        paper_size: paperSize,
        color_mode: colorMode,
        copies,
        pages,
        service_type: serviceType,
        created_at: insert.rows[0].created_at,
      },
      message: "Upload received. Worker will print when it polls.",
    });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Worker polling: get next queued job for printer
 * GET /jobs/next?printerId=PP-USA-001
 * Auth required
 */
app.get("/jobs/next", requireWorkerAuth, async (req, res) => {
  try {
    const printerId = (req.query.printerId || req.query.printer_id || "").trim();
    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    const q = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
        AND status IN ('queued','retry')
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [printerId]
    );

    if (q.rowCount === 0) return res.json({ ok: true, job: null });

    const job = q.rows[0];

    // Mark as "processing" immediately so multiple workers don't grab it
    await pool.query(
      `UPDATE print_jobs SET status='processing' WHERE id=$1 AND status IN ('queued','retry')`,
      [job.id]
    );

    // IMPORTANT: worker will download bytes from /jobs/:id/file
    res.json({
      ok: true,
      job: {
        id: job.id,
        printer_id: job.printer_id,
        status: "processing",
        file_name: job.file_name,
        file_mime: job.file_mime,
        paper_size: job.paper_size,
        color_mode: job.color_mode,
        copies: job.copies,
        pages: job.pages,
        service_type: job.service_type,
        customer_name: job.customer_name,
        customer_phone: job.customer_phone,
        notes: job.notes,
        created_at: job.created_at,
      },
    });
  } catch (e) {
    console.error("JOBS NEXT ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Worker file download (authorized)
 * GET /jobs/:id/file
 * Returns raw file bytes from DB file_base64
 */
app.get("/jobs/:id/file", requireWorkerAuth, async (req, res) => {
  try {
    const id = String(req.params.id).trim();
    const q = await pool.query(
      `SELECT file_name, file_mime, file_base64, original_url FROM print_jobs WHERE id=$1`,
      [id]
    );

    if (q.rowCount === 0) return res.status(404).json({ ok: false, error: "Job not found" });

    const row = q.rows[0];
    const b64 = normalizeBase64(row.file_base64);

    if (!b64) {
      // If you still had legacy URL-only jobs, you can see this clearly now
      return res.status(500).json({
        ok: false,
        error: "file_base64 is empty for this job. Re-upload the file (DB must store bytes).",
        original_url: row.original_url || null,
      });
    }

    const buf = Buffer.from(b64, "base64");

    res.setHeader("Content-Type", row.file_mime || "application/octet-stream");
    // Force a filename so SumatraPDF prints correctly
    const name = row.file_name || `job-${id}.bin`;
    res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/"/g, "")}"`);

    res.send(buf);
  } catch (e) {
    console.error("JOB FILE ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Worker status update
 * POST /jobs/:id/status  (auth)
 * body: { status: "printed" | "failed" | "processing" | "retry", error?: "...", meta?: {...} }
 */
app.post("/jobs/:id/status", requireWorkerAuth, async (req, res) => {
  try {
    const id = String(req.params.id).trim();
    const status = (req.body.status || "").trim();
    const error = (req.body.error || "").trim();

    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    // Store error in notes if provided (simple + safe)
    if (error) {
      await pool.query(
        `UPDATE print_jobs SET status=$1, notes=COALESCE(notes,'') || $2 WHERE id=$3`,
        [status, `\n[WORKER ERROR] ${error}`, id]
      );
    } else {
      await pool.query(`UPDATE print_jobs SET status=$1 WHERE id=$2`, [status, id]);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("STATUS UPDATE ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Optional: list jobs (admin/debug)
 * GET /jobs?printerId=PP-USA-001&limit=50
 */
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || req.query.printer_id || "").trim();
    const limit = Math.min(Math.max(safeInt(req.query.limit, 50) || 50, 1), 200);

    const q = printerId
      ? await pool.query(
          `SELECT id, created_at, printer_id, status, file_name, file_mime, paper_size, color_mode, copies, pages, service_type
           FROM print_jobs
           WHERE printer_id=$1
           ORDER BY created_at DESC
           LIMIT $2`,
          [printerId, limit]
        )
      : await pool.query(
          `SELECT id, created_at, printer_id, status, file_name, file_mime, paper_size, color_mode, copies, pages, service_type
           FROM print_jobs
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit]
        );

    res.json({ ok: true, jobs: q.rows });
  } catch (e) {
    console.error("JOBS LIST ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- START ----------
(async () => {
  try {
    await ensureSchema();
    app.listen(PORT, () => {
      console.log(`✅ MSTAF CORE listening on :${PORT}`);
    });
  } catch (e) {
    console.error("❌ Startup error:", e);
    process.exit(1);
  }
})();
