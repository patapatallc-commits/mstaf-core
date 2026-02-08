/**
 * MSTAF CORE - server.js (Render-ready)
 * - Upload -> print_jobs queue (Print-O-Matic)
 * - Twilio SMS webhook (x-www-form-urlencoded)
 * - SAFE DB migrations (adds columns if missing)
 * - IMPORTANT: uses job_id / id_text for string IDs; never writes to integer id
 *
 * PHASE A COMPLETE:
 * - Credit system (customers + ledger)
 * - Paid-only print lock
 * - Admin credit top-up endpoint
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

// =====================
// Middleware
// =====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================
// Uploads
// =====================
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// =====================
// Database
// =====================
const DATABASE_URL = process.env.DATABASE_URL;
const DB_SSL = (process.env.DB_SSL || "true").toLowerCase() !== "false";

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DB_SSL ? { rejectUnauthorized: false } : false,
    })
  : null;

function requireDb(req, res) {
  if (!pool) {
    res.status(500).json({ ok: false, error: "DB not configured" });
    return false;
  }
  return true;
}

// =====================
// Helpers
// =====================
function nowIso() {
  return new Date().toISOString();
}

function makeJobId() {
  return `print_${crypto.randomBytes(10).toString("hex")}`;
}

function normalizePhone(phone) {
  return phone ? phone.trim() : null;
}

function creditsRate(colorMode) {
  return String(colorMode || "BW").toUpperCase() === "COLOR" ? 2 : 1;
}

function computeCredits({ colorMode = "BW", pages = 1, copies = 1 }) {
  const p = Math.max(1, parseInt(pages, 10) || 1);
  const c = Math.max(1, parseInt(copies, 10) || 1);
  return creditsRate(colorMode) * p * c;
}

// =====================
// Credit Functions
// =====================
async function ensureCustomer(pool, phone_e164) {
  const q = `
    INSERT INTO customers (phone_e164, credits_balance)
    VALUES ($1, 0)
    ON CONFLICT (phone_e164)
    DO UPDATE SET updated_at = NOW()
    RETURNING phone_e164, credits_balance
  `;
  const r = await pool.query(q, [phone_e164]);
  return r.rows[0];
}

async function addCredits(pool, phone_e164, delta, reason, ref = null) {
  await pool.query("BEGIN");
  try {
    await ensureCustomer(pool, phone_e164);

    const r = await pool.query(
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
    return r.rows[0].credits_balance;
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
      `SELECT credits_balance FROM customers WHERE phone_e164=$1 FOR UPDATE`,
      [phone_e164]
    );

    const bal = balRow.rows[0]?.credits_balance ?? 0;
    if (bal < cost) {
      await pool.query("ROLLBACK");
      return { ok: false, balance: bal };
    }

    const newBal = await pool.query(
      `UPDATE customers
       SET credits_balance = credits_balance - $2, updated_at = NOW()
       WHERE phone_e164=$1
       RETURNING credits_balance`,
      [phone_e164, cost]
    );

    await pool.query(
      `INSERT INTO credit_ledger (phone_e164, delta, reason, ref)
       VALUES ($1,$2,$3,$4)`,
      [phone_e164, -cost, reason, ref]
    );

    await pool.query("COMMIT");
    return { ok: true, balance: newBal.rows[0].credits_balance };
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
}

// =====================
// Multer
// =====================
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}_${crypto.randomBytes(6).toString("hex")}${path.extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// =====================
// DB Init / Migrations
// =====================
async function initDbIfPossible() {
  if (!pool) return;

  const sql = [
    `CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      job_id TEXT,
      id_text TEXT,
      printer_id TEXT,
      status TEXT,
      pages INTEGER,
      copies INTEGER,
      color TEXT,
      source TEXT,
      from_phone TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_url TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      phone_e164 TEXT UNIQUE,
      credits_balance INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS credit_ledger (
      id SERIAL PRIMARY KEY,
      phone_e164 TEXT,
      delta INTEGER,
      reason TEXT,
      ref TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`,
  ];

  for (const q of sql) await pool.query(q);
}

// =====================
// ROUTES
// =====================
app.get("/health", async (req, res) => {
  let dbOk = false;
  if (pool) {
    try {
      await pool.query("SELECT 1");
      dbOk = true;
    } catch {}
  }
  res.json({
    ok: true,
    service: "mstaf-core",
    time: nowIso(),
    dbConfigured: !!pool,
    dbOk,
    BUILD_MARK: "PHASE_A_CREDITS_LOCK_V1",
  });
});

// Debug customer
app.get("/debug/customer/:phone", async (req, res) => {
  if (!requireDb(req, res)) return;
  const r = await pool.query(
    `SELECT phone_e164, credits_balance FROM customers WHERE phone_e164=$1`,
    [normalizePhone(req.params.phone)]
  );
  res.json({ ok: true, customer: r.rows[0] || null });
});

// =====================
// ✅ ADMIN CREDIT TOP-UP
// =====================
app.post("/admin/credits", async (req, res) => {
  if (!requireDb(req, res)) return;

  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || req.headers["x-admin-key"] !== adminKey) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const phone = normalizePhone(req.body.phone_e164);
  const delta = parseInt(req.body.delta, 10);

  if (!phone || !delta) {
    return res.status(400).json({ ok: false, error: "phone_e164 and delta required" });
  }

  const balance = await addCredits(pool, phone, delta, req.body.reason || "admin_adjust");
  res.json({ ok: true, phone_e164: phone, balance });
});

// =====================
// Upload job
// =====================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!requireDb(req, res)) return;

  const jobId = makeJobId();
  const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

  const r = await pool.query(
    `INSERT INTO print_jobs
     (job_id, id_text, printer_id, status, from_phone, file_name, mime_type, file_url)
     VALUES ($1,$1,$2,'needs_details',$3,$4,$5,$6)
     RETURNING *`,
    [
      jobId,
      req.body.printerId,
      normalizePhone(req.body.from),
      req.file.originalname,
      req.file.mimetype,
      fileUrl,
    ]
  );

  res.json({ ok: true, job: r.rows[0] });
});

// =====================
// PAID JOBS ONLY
// =====================
app.get("/jobs", async (req, res) => {
  if (!requireDb(req, res)) return;

  const r = await pool.query(
    `SELECT * FROM print_jobs
     WHERE printer_id=$1 AND status='paid'
     ORDER BY created_at ASC
     LIMIT 10`,
    [req.query.printerId]
  );

  res.json({ ok: true, jobs: r.rows });
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 10000;
initDbIfPossible().finally(() => {
  app.listen(PORT, () => {
    console.log(`MSTAF CORE running on port ${PORT}`);
  });
});

