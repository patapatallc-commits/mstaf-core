"use strict";

/**
 * MSTAF Core Server (Render) — Stable Print + File URL Fix + Dispatch APIs
 *
 * KEY FIX:
 * - Worker was receiving jobs with fileUrl=undefined -> cannot download -> cannot print.
 * - This server stores uploaded files in Postgres (BYTEA) and ALWAYS returns a secure download URL.
 *
 * DOES NOT REQUIRE S3.
 * Worker downloads from: /api/files/:fileId?token=...
 *
 * ENV VARS REQUIRED:
 * - DATABASE_URL (Render Postgres)
 * - WORKER_KEY (for worker auth)
 *
 * OPTIONAL:
 * - BASE_URL or PUBLIC_BASE_URL (if not set, server builds from request host)
 * - DEFAULT_AUTO_PRINTER_ID (e.g. PP-USA-001)
 * - DASHBOARD_KEY (for dashboard auth)
 * - DISPATCH_LINK_SECRET (defaults to WORKER_KEY if not set)
 * - SMTP_* (only if you want /api/dispatch/email to actually send email)
 *
 * Notes:
 * - Files stored in Postgres can increase DB size. For production scale, move to S3 later.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();

// ---------- Basic Middleware ----------
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// Multer: store upload in memory then write to Postgres
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB (adjust if needed)
});

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;

const WORKER_KEY = process.env.WORKER_KEY || process.env.PRINTER_KEY || "";
const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "";
const DEFAULT_AUTO_PRINTER_ID = process.env.DEFAULT_AUTO_PRINTER_ID || "PP-USA-001";

const PUBLIC_BASE_URL =
  (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "").replace(/\/$/, "");

const DISPATCH_LINK_SECRET =
  process.env.DISPATCH_LINK_SECRET || WORKER_KEY || "fallback_secret_change_me";

// ---------- DB ----------
if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is missing.");
  process.exit(1);
}
if (!WORKER_KEY) {
  console.error("FATAL: WORKER_KEY (or PRINTER_KEY) is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_URL.includes("render.com") || process.env.PGSSLMODE === "require"
      ? { rejectUnauthorized: false }
      : false,
});

// ---------- Helpers ----------
function baseUrlFromReq(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return `${req.protocol}://${req.get("host")}`;
}

function requireWorkerAuth(req, res, next) {
  const key = req.headers["x-worker-key"] || req.headers["x-printer-key"] || "";
  if (!key || key !== WORKER_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized worker" });
  }
  next();
}

function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_KEY) {
    return res.status(401).json({ ok: false, error: "Dashboard auth not configured" });
  }
  const headerKey = req.headers["x-dashboard-key"] || req.headers["x-admin-key"] || "";
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (headerKey === DASHBOARD_KEY || bearer === DASHBOARD_KEY) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized (dashboard)" });
}

function hmacToken(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", DISPATCH_LINK_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  try {
    const [payload, sig] = String(token || "").split(".");
    if (!payload || !sig) return null;
    const expected = crypto
      .createHmac("sha256", DISPATCH_LINK_SECRET)
      .update(payload)
      .digest("base64url");
    if (expected !== sig) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function ensureSchema() {
  // We create ONLY tables we control. This avoids “missing column” crashes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id BIGSERIAL PRIMARY KEY,
      original_name TEXT,
      mime_type TEXT,
      size_bytes BIGINT,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued', -- queued | printing | done | error | dispatch
      printer_id TEXT NOT NULL DEFAULT '${DEFAULT_AUTO_PRINTER_ID}',
      service_type TEXT NOT NULL DEFAULT 'print', -- print | edit | etc
      paper_size TEXT NOT NULL DEFAULT 'A4', -- A4 | LETTER | A3 | CARD
      color_mode TEXT NOT NULL DEFAULT 'bw', -- bw | color
      pages INTEGER NOT NULL DEFAULT 1,
      copies INTEGER NOT NULL DEFAULT 1,
      price NUMERIC(10,2) NOT NULL DEFAULT 0.00,
      instructions TEXT,
      customer_email TEXT,
      customer_city TEXT,
      customer_country TEXT,
      file_id BIGINT REFERENCES files(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_print_jobs_status_created ON print_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status ON print_jobs(printer_id, status, created_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatch_queue (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT REFERENCES print_jobs(id),
      copy_index INTEGER NOT NULL DEFAULT 2,
      assigned_printer_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | assigned | emailed | done
      customer_email TEXT,
      secure_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_status_created ON dispatch_queue(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dispatch_job ON dispatch_queue(job_id);
  `);
}

// Price helper (your rules)
function computePrice({ pages, copies, colorMode }) {
  const p = Math.max(Number(pages || 1), 1);
  const c = Math.max(Number(copies || 1), 1);
  const perPage = String(colorMode || "bw").toLowerCase() === "color" ? 0.5 : 0.25;
  return Number((p * c * perPage).toFixed(2));
}

function normalizePaper(p) {
  const v = String(p || "A4").trim().toUpperCase();
  if (v.includes("CARD")) return "CARD";
  if (v === "A3") return "A3";
  if (v.includes("LETTER")) return "LETTER";
  return "A4";
}

function normalizeColor(m) {
  const v = String(m || "bw").trim().toLowerCase();
  return v === "color" ? "color" : "bw";
}

function isAutoPrintable(job) {
  // Auto print only standard sizes for copy #1
  // A3/CARD or non-print services go to dispatch/dashboard
  const paper = String(job.paper_size || "").toUpperCase();
  const st = String(job.service_type || "print").toLowerCase();
  if (st !== "print") return false;
  if (paper === "A3" || paper === "CARD") return false;
  return true;
}

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- Upload Endpoint (Shopify) ----------
// This accepts multipart/form-data with "file" field.
// It creates file row + print job row.
// Returns jobId + customer preview link + routing.
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, error: "Missing file" });

    const printerId = (req.body.printerId || req.body.printer_id || DEFAULT_AUTO_PRINTER_ID).trim();
    const paperSize = normalizePaper(req.body.paperSize || req.body.paper_size || "A4");
    const colorMode = normalizeColor(req.body.colorMode || req.body.color_mode || "bw");
    const pages = Math.max(Number(req.body.pages || 1), 1);
    const copies = Math.max(Number(req.body.copies || 1), 1);

    const instructions = req.body.instructions || req.body.details || "";
    const customerEmail = req.body.email || req.body.customer_email || null;
    const customerCity = req.body.city || req.body.customer_city || null;
    const customerCountry = req.body.country || req.body.customer_country || null;

    const price = computePrice({ pages, copies, colorMode });

    // Save file in Postgres
    const fileInsert = await pool.query(
      `INSERT INTO files(original_name, mime_type, size_bytes, data)
       VALUES ($1,$2,$3,$4)
       RETURNING id`,
      [f.originalname, f.mimetype, f.size, f.buffer]
    );
    const fileId = fileInsert.rows[0].id;

    // Create job
    const jobInsert = await pool.query(
      `INSERT INTO print_jobs(
        status, printer_id, service_type, paper_size, color_mode,
        pages, copies, price, instructions,
        customer_email, customer_city, customer_country,
        file_id, updated_at
      ) VALUES (
        'queued', $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11,
        $12, NOW()
      )
      RETURNING *`,
      [
        printerId,
        (req.body.serviceType || req.body.service_type || "print").toLowerCase(),
        paperSize,
        colorMode,
        pages,
        copies,
        price,
        instructions,
        customerEmail,
        customerCity,
        customerCountry,
        fileId,
      ]
    );
    const job = jobInsert.rows[0];

    // If copies > 1, create dispatch queue rows for copy #2..N (human dispatch)
    if (copies > 1) {
      for (let i = 2; i <= copies; i++) {
        await pool.query(
          `INSERT INTO dispatch_queue(job_id, copy_index, status)
           VALUES ($1, $2, 'pending')`,
          [job.id, i]
        );
      }
    }

    // If not auto-printable (A3/CARD/edit), move job to dispatch
    let routing = `Standard Printer (${printerId})`;
    if (!isAutoPrintable(job)) {
      await pool.query(`UPDATE print_jobs SET status='dispatch', updated_at=NOW() WHERE id=$1`, [
        job.id,
      ]);
      routing = "Dashboard Dispatch Required (A3/CARD/Editing)";
    }

    // Customer preview link (public)
    const token = hmacToken({ jobId: job.id, fileId, ts: Date.now() });
    const publicLink = `${baseUrlFromReq(req)}/api/public/file/${token}`;

    return res.json({
      ok: true,
      jobId: job.id,
      routing,
      price,
      paperSize,
      colorMode,
      pages,
      copies,
      fileUrl: publicLink,
    });
  } catch (e) {
    console.error("POST /api/upload error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Backward compatible route name if your Shopify HTML uses /api/print/upload etc.
app.post("/api/print/upload", upload.single("file"), (req, res) => {
  // forward to /api/upload logic by calling next handler
  // simplest: rewrite URL and call the upload handler again is messy; instead:
  req.url = "/api/upload";
  app._router.handle(req, res);
});

// ---------- Public file link for customers (no auth) ----------
// Token includes fileId
app.get("/api/public/file/:token", async (req, res) => {
  try {
    const payload = verifyToken(req.params.token);
    if (!payload || !payload.fileId) return res.status(401).send("Invalid link");

    // optional expiry (7 days)
    const maxAgeMs = Number(process.env.PUBLIC_LINK_MAXAGE_MS || 7 * 24 * 60 * 60 * 1000);
    if (payload.ts && Date.now() - payload.ts > maxAgeMs) return res.status(401).send("Link expired");

    const r = await pool.query(`SELECT id, original_name, mime_type, data FROM files WHERE id=$1`, [
      payload.fileId,
    ]);
    const file = r.rows[0];
    if (!file) return res.status(404).send("File not found");

    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${(file.original_name || "file").replace(/"/g, "")}"`
    );
    return res.send(file.data);
  } catch (e) {
    console.error("GET /api/public/file/:token error:", e);
    return res.status(500).send("Server error");
  }
});

// ---------- Secure file download for workers/dashboard ----------
app.get("/api/files/:fileId", requireWorkerAuth, async (req, res) => {
  try {
    const fileId = Number(req.params.fileId);
    const r = await pool.query(`SELECT original_name, mime_type, data FROM files WHERE id=$1`, [
      fileId,
    ]);
    const file = r.rows[0];
    if (!file) return res.status(404).json({ ok: false, error: "File not found" });

    res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${(file.original_name || "file").replace(/"/g, "")}"`
    );
    return res.send(file.data);
  } catch (e) {
    console.error("GET /api/files/:fileId error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- Worker: next job ----------
app.get("/api/worker/next", requireWorkerAuth, async (req, res) => {
  try {
    const printerId = String(req.query.printerId || DEFAULT_AUTO_PRINTER_ID).trim();

    // Fetch next printable job
    const r = await pool.query(
      `
      SELECT * FROM print_jobs
      WHERE status = 'queued'
        AND printer_id = $1
        AND service_type = 'print'
        AND paper_size NOT IN ('A3','CARD')
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [printerId]
    );

    const jobRow = r.rows[0];
    if (!jobRow) {
      return res.json({ ok: true, job: null });
    }

    // Mark printing immediately to prevent duplicates
    await pool.query(`UPDATE print_jobs SET status='printing', updated_at=NOW() WHERE id=$1`, [
      jobRow.id,
    ]);

    // ✅ ALWAYS provide a valid fileUrl
    if (!jobRow.file_id) {
      await pool.query(
        `UPDATE print_jobs SET status='error', error_message=$2, updated_at=NOW() WHERE id=$1`,
        [jobRow.id, "Missing file_id on job"]
      );
      return res.json({ ok: false, error: "job_missing_file" });
    }

    const token = hmacToken({ jobId: jobRow.id, fileId: jobRow.file_id, ts: Date.now() });
    const fileUrl = `${baseUrlFromReq(req)}/api/files/${jobRow.file_id}?token=${encodeURIComponent(
      token
    )}`;

    // Worker expects fileUrl or file_url
    const job = {
      id: jobRow.id,
      printerId: jobRow.printer_id,
      paperSize: jobRow.paper_size,
      colorMode: jobRow.color_mode,
      pages: jobRow.pages,
      copies: jobRow.copies,
      price: jobRow.price,
      instructions: jobRow.instructions || "",
      fileId: jobRow.file_id,
      fileUrl,
      file_url: fileUrl,
    };

    return res.json({ ok: true, job });
  } catch (e) {
    console.error("GET /api/worker/next error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- Worker: mark done ----------
app.post("/api/worker/done", requireWorkerAuth, async (req, res) => {
  try {
    const jobId = Number(req.body.jobId);
    if (!jobId) return res.status(400).json({ ok: false, error: "Missing jobId" });

    await pool.query(`UPDATE print_jobs SET status='done', updated_at=NOW() WHERE id=$1`, [jobId]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/worker/done error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- Worker: mark error ----------
app.post("/api/worker/error", requireWorkerAuth, async (req, res) => {
  try {
    const jobId = Number(req.body.jobId);
    const msg = String(req.body.error || "Unknown error");
    if (!jobId) return res.status(400).json({ ok: false, error: "Missing jobId" });

    await pool.query(
      `UPDATE print_jobs SET status='error', error_message=$2, updated_at=NOW() WHERE id=$1`,
      [jobId, msg]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/worker/error error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- Dispatch Dashboard APIs ----------
app.get("/api/dispatch/queue", requireDashboardAuth, async (req, res) => {
  try {
    const status = String(req.query.status || "pending");
    const limit = Math.min(Number(req.query.limit || 200), 500);

    const r = await pool.query(
      `
      SELECT dq.*, pj.paper_size, pj.color_mode, pj.pages, pj.copies, pj.price, pj.instructions
      FROM dispatch_queue dq
      LEFT JOIN print_jobs pj ON pj.id = dq.job_id
      WHERE dq.status = $1
      ORDER BY dq.created_at DESC
      LIMIT $2
      `,
      [status, limit]
    );

    return res.json({ ok: true, count: r.rows.length, items: r.rows });
  } catch (e) {
    console.error("GET /api/dispatch/queue error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.post("/api/dispatch/assign", requireDashboardAuth, async (req, res) => {
  try {
    const dispatchId = Number(req.body.dispatchId);
    const printerId = String(req.body.printerId || "").trim();
    if (!dispatchId || !printerId) {
      return res.status(400).json({ ok: false, error: "dispatchId and printerId required" });
    }

    const r = await pool.query(
      `
      UPDATE dispatch_queue
      SET assigned_printer_id=$1, status='assigned', updated_at=NOW()
      WHERE id=$2
      RETURNING *
      `,
      [printerId, dispatchId]
    );

    if (!r.rows[0]) return res.status(404).json({ ok: false, error: "Not found" });
    return res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    console.error("POST /api/dispatch/assign error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Email endpoint: safe stub (won’t break your server if SMTP not set)
app.post("/api/dispatch/email", requireDashboardAuth, async (req, res) => {
  try {
    const dispatchId = Number(req.body.dispatchId);
    const email = String(req.body.email || "").trim();
    if (!dispatchId || !email) {
      return res.status(400).json({ ok: false, error: "dispatchId and email required" });
    }

    const d = await pool.query(`SELECT * FROM dispatch_queue WHERE id=$1`, [dispatchId]);
    const item = d.rows[0];
    if (!item) return res.status(404).json({ ok: false, error: "dispatch item not found" });

    const job = await pool.query(`SELECT * FROM print_jobs WHERE id=$1`, [item.job_id]);
    const jobRow = job.rows[0];
    if (!jobRow || !jobRow.file_id) {
      return res.status(400).json({ ok: false, error: "Job file missing" });
    }

    const token = hmacToken({ jobId: jobRow.id, fileId: jobRow.file_id, ts: Date.now() });
    const link = `${baseUrlFromReq(req)}/api/public/file/${token}`;

    await pool.query(
      `UPDATE dispatch_queue SET customer_email=$1, secure_token=$2, status='emailed', updated_at=NOW() WHERE id=$3`,
      [email, token, dispatchId]
    );

    // If SMTP is configured later, you can implement actual sending.
    // For now we return the link safely.
    return res.json({ ok: true, email, link, note: "SMTP sending not configured; link generated." });
  } catch (e) {
    console.error("POST /api/dispatch/email error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- Start ----------
(async () => {
  try {
    await ensureSchema();
    console.log("✅ MSTAF Core schema ready");
  } catch (e) {
    console.error("FATAL: ensureSchema failed:", e);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`✅ MSTAF Core running on port ${PORT}`);
    console.log("✅ BASE_URL:", PUBLIC_BASE_URL || "(auto)");
    console.log("✅ WORKER_KEY:", WORKER_KEY ? "(set)" : "(missing)");
    console.log("✅ DEFAULT_AUTO_PRINTER_ID:", DEFAULT_AUTO_PRINTER_ID);
    console.log("✅ DASHBOARD auth:", DASHBOARD_KEY ? "(set)" : "(not set)");
  });
})();
