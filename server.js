/**
 * MSTAF CORE - server.js (Render-ready)
 * - Upload -> print_jobs queue (Print-O-Matic)
 * - Twilio SMS webhook (x-www-form-urlencoded)
 * - SAFE DB migrations (adds columns if missing)
 * - IMPORTANT: uses job_id / id_text for string IDs; never writes to integer id
 *
 * ✅ PHASE A INTEGRATED:
 * - Credits helper functions + customer/ledger helpers
 * - /jobs returns ONLY paid jobs (no payment = no print)
 * - /debug/customer/:phone endpoint
 * - /sms flow:
 *    MMS creates job -> needs_details
 *    Details -> awaiting_confirm + estimate
 *    CONFIRM -> deduct credits -> paid
 */

require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

// ===== Middleware =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Uploads folder + public access =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// ===== Database =====
const DATABASE_URL = process.env.DATABASE_URL;
const DB_SSL = (process.env.DB_SSL || "true").toLowerCase() !== "false"; // default true

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DB_SSL ? { rejectUnauthorized: false } : false,
    })
  : null;

// ===== Helpers =====
function nowIso() {
  return new Date().toISOString();
}

function makeJobId() {
  return `print_${crypto.randomBytes(10).toString("hex")}`;
}

function requireDb(req, res) {
  if (!pool) {
    res.status(500).json({
      ok: false,
      error: "DATABASE_URL is not set. DB is not configured on this service.",
    });
    return false;
  }
  return true;
}

// =====================================
// ✅ PHASE A (A) — CREDITS HELPERS
// =====================================
function normalizePhone(phone) {
  if (!phone) return null;
  // expects +1... already. If not, you can add logic later.
  return phone.trim();
}

function creditsRate(colorMode) {
  return String(colorMode || "BW").toUpperCase() === "COLOR" ? 2 : 1;
}

function computeCredits({ colorMode = "BW", pages = 1, copies = 1 }) {
  const rate = creditsRate(colorMode);
  const p = Math.max(1, parseInt(pages, 10) || 1);
  const c = Math.max(1, parseInt(copies, 10) || 1);
  return rate * p * c;
}

async function ensureCustomer(pool, phone_e164) {
  const q = `
    INSERT INTO customers (phone_e164, credits_balance)
    VALUES ($1, 0)
    ON CONFLICT (phone_e164) DO UPDATE SET updated_at = NOW()
    RETURNING phone_e164, credits_balance
  `;
  const r = await pool.query(q, [phone_e164]);
  return r.rows[0];
}

async function addCredits(pool, phone_e164, delta, reason, ref = null) {
  await pool.query("BEGIN");
  try {
    await ensureCustomer(pool, phone_e164);

    const upd = await pool.query(
      `UPDATE customers
       SET credits_balance = credits_balance + $2, updated_at = NOW()
       WHERE phone_e164 = $1
       RETURNING credits_balance`,
      [phone_e164, delta]
    );

    await pool.query(
      `INSERT INTO credit_ledger (phone_e164, delta, reason, ref)
       VALUES ($1,$2,$3,$4)`,
      [phone_e164, delta, reason, ref]
    );

    await pool.query("COMMIT");
    return upd.rows[0].credits_balance;
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
}

async function deductCreditsIfEnough(pool, phone_e164, cost, reason, ref = null) {
  await pool.query("BEGIN");
  try {
    await ensureCustomer(pool, phone_e164);

    const balRow = await pool.query(
      `SELECT credits_balance FROM customers WHERE phone_e164 = $1 FOR UPDATE`,
      [phone_e164]
    );
    const bal = balRow.rows[0]?.credits_balance ?? 0;
    if (bal < cost) {
      await pool.query("ROLLBACK");
      return { ok: false, balance: bal };
    }

    const newBalRow = await pool.query(
      `UPDATE customers
       SET credits_balance = credits_balance - $2, updated_at = NOW()
       WHERE phone_e164 = $1
       RETURNING credits_balance`,
      [phone_e164, cost]
    );

    await pool.query(
      `INSERT INTO credit_ledger (phone_e164, delta, reason, ref)
       VALUES ($1,$2,$3,$4)`,
      [phone_e164, -cost, reason, ref]
    );

    await pool.query("COMMIT");
    return { ok: true, balance: newBalRow.rows[0].credits_balance };
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
}

// ===== Multer (multipart/form-data) =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base = crypto.randomBytes(8).toString("hex");
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// =====================================
// ===== DB INIT + SAFE MIGRATIONS ======
// =====================================
async function initDbIfPossible() {
  if (!pool) {
    console.log("[DB] DATABASE_URL missing. Skipping DB init.");
    return;
  }

  const migrations = [
    // ---- print_jobs ----
    `CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      job_id TEXT,
      printer_id TEXT,
      status TEXT DEFAULT 'queued',
      pages INTEGER,
      copies INTEGER,
      color TEXT,
      source TEXT,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_base64 TEXT,
      file_url TEXT,
      id_text TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,

    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS job_id TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS pages INTEGER;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS copies INTEGER;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS color TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS source TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_base64 TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS meta JSONB;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;`,
    `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;`,

    `CREATE INDEX IF NOT EXISTS idx_print_jobs_printer_status_created
      ON print_jobs (printer_id, status, created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_print_jobs_job_id ON print_jobs (job_id);`,
    `CREATE INDEX IF NOT EXISTS idx_print_jobs_id_text ON print_jobs (id_text);`,

    // ---- customers ----
    `CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      phone_e164 TEXT UNIQUE NOT NULL,
      credits_balance INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,

    // ---- credit_ledger ----
    `CREATE TABLE IF NOT EXISTS credit_ledger (
      id SERIAL PRIMARY KEY,
      phone_e164 TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_credit_ledger_phone_created
      ON credit_ledger (phone_e164, created_at DESC);`,
  ];

  try {
    console.log("[DB] Running migrations...");
    for (const sql of migrations) {
      await pool.query(sql);
    }

    // Backfill: keep id_text populated for old numeric rows
    await pool.query(`
      UPDATE print_jobs
      SET id_text = COALESCE(id_text, id::text)
      WHERE id_text IS NULL;
    `);

    console.log("[DB] Migrations complete.");
  } catch (err) {
    console.error("[DB] Migration error:", err.message);
  }
}

// =====================================
// ===== DB FUNCTIONS (job_id first) ====
// =====================================

async function dbInsertJob({
  jobId,
  printerId,
  fromPhone,
  fileUrl,
  fileName,
  mimeType,
  source,
  meta,
  status = "needs_details",
  pages = null,
  copies = null,
  color = null,
}) {
  if (!pool) throw new Error("DB not configured");

  const q = `
    INSERT INTO print_jobs (
      job_id,
      id_text,
      printer_id,
      status,
      source,
      from_phone,
      file_name,
      mime_type,
      file_url,
      pages,
      copies,
      color,
      meta,
      created_at,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
    RETURNING
      COALESCE(job_id, id_text, id::text) AS id,
      id AS numeric_id,
      job_id,
      id_text,
      printer_id,
      status,
      source,
      from_phone,
      file_name,
      mime_type,
      file_url,
      pages,
      copies,
      color,
      created_at,
      updated_at,
      meta;
  `;

  const vals = [
    jobId,
    jobId, // keep id_text aligned too
    printerId || null,
    status || "needs_details",
    source || "upload",
    fromPhone || null,
    fileName || null,
    mimeType || null,
    fileUrl || null,
    pages,
    copies,
    color,
    meta || null,
  ];

  const r = await pool.query(q, vals);
  return r.rows[0];
}

/**
 * ✅ PHASE A (B) — Fetch ONLY paid jobs for printer (no payment = no print)
 */
async function dbGetNextJobs({ printerId, limit = 10 }) {
  if (!pool) throw new Error("DB not configured");

  const q = `
    SELECT
      COALESCE(job_id, id_text, id::text) AS id,
      id AS numeric_id,
      job_id,
      id_text,
      printer_id,
      status,
      pages,
      copies,
      color,
      source,
      from_phone,
      file_name,
      mime_type,
      file_base64,
      file_url,
      created_at,
      updated_at,
      meta
    FROM print_jobs
    WHERE printer_id = $1
      AND status = 'paid'
    ORDER BY created_at ASC NULLS LAST
    LIMIT $2;
  `;

  const r = await pool.query(q, [printerId, limit]);
  return r.rows;
}

async function dbUpdateStatus({ anyId, status }) {
  if (!pool) throw new Error("DB not configured");

  const q = `
    UPDATE print_jobs
    SET status = $1,
        updated_at = NOW()
    WHERE job_id = $2
       OR id_text = $2
       OR id::text = $2
    RETURNING
      COALESCE(job_id, id_text, id::text) AS id,
      id AS numeric_id,
      job_id,
      id_text,
      printer_id,
      status,
      pages,
      copies,
      color,
      source,
      from_phone,
      file_name,
      mime_type,
      file_url,
      created_at,
      updated_at,
      meta;
  `;

  const r = await pool.query(q, [status, anyId]);
  return r.rows[0] || null;
}

async function dbUpdateJobDetails({ anyId, pages, copies, color, status, metaPatch }) {
  if (!pool) throw new Error("DB not configured");

  const q = `
    UPDATE print_jobs
    SET pages = COALESCE($1, pages),
        copies = COALESCE($2, copies),
        color = COALESCE($3, color),
        status = COALESCE($4, status),
        meta = COALESCE(meta, '{}'::jsonb) || COALESCE($5::jsonb, '{}'::jsonb),
        updated_at = NOW()
    WHERE job_id = $6
       OR id_text = $6
       OR id::text = $6
    RETURNING
      COALESCE(job_id, id_text, id::text) AS id,
      id AS numeric_id,
      job_id,
      id_text,
      printer_id,
      status,
      pages,
      copies,
      color,
      source,
      from_phone,
      file_name,
      mime_type,
      file_url,
      created_at,
      updated_at,
      meta;
  `;
  const r = await pool.query(q, [
    pages ?? null,
    copies ?? null,
    color ?? null,
    status ?? null,
    metaPatch ? JSON.stringify(metaPatch) : null,
    anyId,
  ]);
  return r.rows[0] || null;
}

async function dbGetLatestJobForPhone(phone, statuses) {
  if (!pool) throw new Error("DB not configured");
  const q = `
    SELECT
      COALESCE(job_id, id_text, id::text) AS id,
      id AS numeric_id,
      job_id,
      id_text,
      printer_id,
      status,
      pages,
      copies,
      color,
      source,
      from_phone,
      file_name,
      mime_type,
      file_url,
      created_at,
      updated_at,
      meta
    FROM print_jobs
    WHERE from_phone = $1
      AND status = ANY($2)
    ORDER BY created_at DESC
    LIMIT 1;
  `;
  const r = await pool.query(q, [phone, statuses]);
  return r.rows[0] || null;
}

// =====================================
// ============ ROUTES ==================
// =====================================

// Root
app.get("/", (req, res) => {
  res.json({ ok: true, service: "mstaf-core", time: nowIso() });
});

// Health
app.get("/health", async (req, res) => {
  const out = {
    ok: true,
    service: "mstaf-core",
    time: nowIso(),
    host: os.hostname(),
    pid: process.pid,
    dbConfigured: !!pool,
    BUILD_MARK: "PHASE_A_CREDITS_LOCK_V1",
  };

  if (pool) {
    try {
      const r = await pool.query("SELECT 1 AS ok;");
      out.dbOk = r.rows?.[0]?.ok === 1;
    } catch (e) {
      out.dbOk = false;
      out.dbError = e.message;
    }
  }

  res.json(out);
});

// Debug instance
app.get("/debug/instance", (req, res) => {
  res.json({
    pid: process.pid,
    host: os.hostname(),
    time: nowIso(),
    BUILD_MARK: "PHASE_A_CREDITS_LOCK_V1",
  });
});

// Debug DB columns
app.get("/debug/db/columns", async (req, res) => {
  if (!requireDb(req, res)) return;

  try {
    const q = `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'print_jobs'
      ORDER BY ordinal_position;
    `;
    const r = await pool.query(q);
    res.json({ ok: true, table: "print_jobs", columns: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Debug DB migrate
app.post("/debug/db/migrate", async (req, res) => {
  if (!requireDb(req, res)) return;

  try {
    await initDbIfPossible();
    res.json({ ok: true, migrated: true, time: nowIso() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ✅ PHASE A (C) — Customer debug endpoint
app.get("/debug/customer/:phone", async (req, res) => {
  if (!requireDb(req, res)) return;
  try {
    const phone = normalizePhone(req.params.phone);
    const r = await pool.query(
      `SELECT phone_e164, credits_balance, created_at, updated_at
       FROM customers WHERE phone_e164 = $1`,
      [phone]
    );
    res.json({ ok: true, customer: r.rows[0] || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Upload endpoint
// POST /api/upload (multipart/form-data)
// fields: printerId, from (or from_phone), file=@...
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const printerId = (req.body.printerId || req.body.printer_id || "").trim();
    const fromPhone = normalizePhone(req.body.from || req.body.from_phone || "");

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded. Use form field name: file" });
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured (DATABASE_URL missing)" });

    const jobId = makeJobId();
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    // ✅ Payment flow default: needs_details -> awaiting_confirm -> paid
    const job = await dbInsertJob({
      jobId,
      printerId,
      fromPhone: fromPhone || null,
      fileUrl,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      source: "upload",
      status: "needs_details",
      meta: {
        stored_filename: req.file.filename,
        size: req.file.size,
      },
    });

    res.json({ ok: true, job });
  } catch (e) {
    console.error("[UPLOAD] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get jobs for a printer
// GET /jobs?printerId=PP-USA-001&limit=10
app.get("/jobs", async (req, res) => {
  try {
    const printerId = (req.query.printerId || req.query.printer_id || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "10", 10) || 10, 50);

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured" });

    // ✅ PAID ONLY
    const jobs = await dbGetNextJobs({ printerId, limit });
    res.json({ ok: true, printerId, count: jobs.length, jobs });
  } catch (e) {
    console.error("[JOBS] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Update job status
// PATCH /jobs/:id  body: { status: "printing" | "done" | "failed" | ... }
app.patch("/jobs/:id", async (req, res) => {
  try {
    const anyId = (req.params.id || "").trim();
    const status = (req.body.status || "").trim();

    if (!anyId) return res.status(400).json({ ok: false, error: "Missing id" });
    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured" });

    const updated = await dbUpdateStatus({ anyId, status });
    if (!updated) return res.status(404).json({ ok: false, error: "Job not found" });

    res.json({ ok: true, job: updated });
  } catch (e) {
    console.error("[PATCH JOB] error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================
// ===== Twilio SMS/MMS Webhook =====
// =====================================
// POST /sms  (Twilio sends x-www-form-urlencoded)
//
// FLOW:
// 1) MMS/media -> create job (needs_details)
// 2) User replies: "COLOR 3 pages 2 copies" -> awaiting_confirm + estimate
// 3) User replies: "CONFIRM" -> deduct credits -> paid
app.post("/sms", async (req, res) => {
  try {
    const MessagingResponse = twilio.twiml.MessagingResponse;
    const twiml = new MessagingResponse();

    if (!pool) {
      twiml.message("MSTAF: Database not configured. Please try again later.");
      return res.type("text/xml").send(twiml.toString());
    }

    const from = normalizePhone(req.body.From || "");
    const bodyRaw = (req.body.Body || "").trim();
    const body = bodyRaw.toUpperCase();

    const numMedia = parseInt(req.body.NumMedia || "0", 10) || 0;
    const mediaUrls = [];
    for (let i = 0; i < numMedia; i++) {
      const u = req.body[`MediaUrl${i}`];
      if (u) mediaUrls.push(u);
    }

    // Ensure customer exists
    const cust = await ensureCustomer(pool, from);

    // Helpers: parse details
    function parseDetails(text) {
      const t = String(text || "").toUpperCase();
      const colorMode = t.includes("COLOR") ? "COLOR" : (t.includes("BW") || t.includes("B/W") || t.includes("BLACK")) ? "BW" : null;

      // pages: "PAGES 3" or "3 PAGES"
      let pages = null;
      let copies = null;

      const mPages1 = t.match(/PAGES?\s*[:=]?\s*(\d+)/);
      const mPages2 = t.match(/(\d+)\s*PAGES?/);
      if (mPages1) pages = parseInt(mPages1[1], 10);
      else if (mPages2) pages = parseInt(mPages2[1], 10);

      const mCopies1 = t.match(/COPIES?\s*[:=]?\s*(\d+)/);
      const mCopies2 = t.match(/(\d+)\s*COPIES?/);
      if (mCopies1) copies = parseInt(mCopies1[1], 10);
      else if (mCopies2) copies = parseInt(mCopies2[1], 10);

      return {
        colorMode,
        pages: pages || null,
        copies: copies || null,
      };
    }

    // 1) If MMS/media received: create a job -> needs_details
    if (mediaUrls.length > 0) {
      const printerId = (process.env.DEFAULT_PRINTER_ID || "PP-USA-001").trim();
      const jobId = makeJobId();

      const job = await dbInsertJob({
        jobId,
        printerId,
        fromPhone: from,
        fileUrl: mediaUrls[0], // note: Twilio media URLs may require auth; stored for now.
        fileName: null,
        mimeType: null,
        source: "twilio",
        status: "needs_details",
        meta: { mediaUrls },
      });

      twiml.message(
        `MSTAF: File received ✅\nJob: ${job.id}\nNow reply with printing details like:\n` +
          `"COLOR 3 pages 2 copies"\n(or "BW 1 page 1 copy")`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // 2) Handle CONFIRM
    if (body === "CONFIRM" || body === "YES" || body === "OK") {
      const job = await dbGetLatestJobForPhone(from, ["awaiting_confirm"]);
      if (!job) {
        twiml.message("MSTAF: No job awaiting confirmation. Send your document/photo first.");
        return res.type("text/xml").send(twiml.toString());
      }

      const colorMode = job.color || "BW";
      const pages = job.pages || 1;
      const copies = job.copies || 1;
      const cost = computeCredits({ colorMode, pages, copies });

      const pay = await deductCreditsIfEnough(pool, from, cost, "print_job_paid", job.id);

      if (!pay.ok) {
        twiml.message(
          `MSTAF: Not enough credits ❌\n` +
            `Cost: ${cost} credits\n` +
            `Your balance: ${pay.balance} credits\n` +
            `Please top up credits, then reply CONFIRM again.`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      await dbUpdateStatus({ anyId: job.id, status: "paid" });

      twiml.message(
        `MSTAF: Payment successful ✅\n` +
          `Job is now PAID and will be printed.\n` +
          `Cost: ${cost} credits\n` +
          `New balance: ${pay.balance} credits`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // 3) Handle CANCEL
    if (body === "CANCEL" || body === "STOPJOB") {
      const job = await dbGetLatestJobForPhone(from, ["needs_details", "awaiting_confirm"]);
      if (!job) {
        twiml.message("MSTAF: No active job to cancel.");
        return res.type("text/xml").send(twiml.toString());
      }
      await dbUpdateStatus({ anyId: job.id, status: "cancelled" });
      twiml.message(`MSTAF: Job cancelled ✅ (Job: ${job.id})`);
      return res.type("text/xml").send(twiml.toString());
    }

    // 4) Otherwise treat as details reply (pages/copies/color)
    const activeJob = await dbGetLatestJobForPhone(from, ["needs_details", "awaiting_confirm"]);
    if (!activeJob) {
      twiml.message(
        `MSTAF: Send your document/photo to print.\n` +
          `Then I will ask for details (COLOR/BW, pages, copies).\n` +
          `Your balance: ${cust.credits_balance} credits`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // If already awaiting_confirm and user sends details again, we allow updating estimate.
    const details = parseDetails(bodyRaw);

    const mergedColor = details.colorMode || activeJob.color || "BW";
    const mergedPages = details.pages || activeJob.pages || null;
    const mergedCopies = details.copies || activeJob.copies || null;

    if (!mergedPages || !mergedCopies) {
      twiml.message(
        `MSTAF: I need your print details.\n` +
          `Reply like: "COLOR 3 pages 2 copies"\n` +
          `Current: color=${mergedColor}, pages=${mergedPages || "?"}, copies=${mergedCopies || "?"}`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    const cost = computeCredits({ colorMode: mergedColor, pages: mergedPages, copies: mergedCopies });

    const updatedJob = await dbUpdateJobDetails({
      anyId: activeJob.id,
      pages: mergedPages,
      copies: mergedCopies,
      color: mergedColor,
      status: "awaiting_confirm",
      metaPatch: { estimated_credits: cost },
    });

    // Refresh balance (no deduction yet)
    const balRow = await pool.query(`SELECT credits_balance FROM customers WHERE phone_e164=$1`, [from]);
    const bal = balRow.rows[0]?.credits_balance ?? 0;

    twiml.message(
      `MSTAF: Confirm your print ✅\n` +
        `Job: ${updatedJob.id}\n` +
        `Mode: ${mergedColor}\nPages: ${mergedPages}\nCopies: ${mergedCopies}\n` +
        `Estimated cost: ${cost} credits\n` +
        `Your balance: ${bal} credits\n\n` +
        `Reply CONFIRM to pay & print.\nReply CANCEL to cancel.`
    );

    return res.type("text/xml").send(twiml.toString());
  } catch (e) {
    console.error("[TWILIO] error:", e);
    res.status(500).send("Error");
  }
});

// =====================================
// ===== Start Server =====
// =====================================
const PORT = process.env.PORT || 10000;

initDbIfPossible().finally(() => {
  app.listen(PORT, () => {
    console.log(`MSTAF CORE listening on port ${PORT}`);
  });
});
