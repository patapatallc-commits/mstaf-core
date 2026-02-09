/**
 * MSTAF CORE - Print-O-Matic Stable Server (Render)
 * - Health: GET /health
 * - Upload (printer/agent): POST /api/upload (multipart/form-data)
 * - Public Upload (customers): POST /public/upload (multipart/form-data)
 * - Printer polling: GET /jobs?printerId=PP-USA-001&limit=5
 * - Update status: POST /jobs/:id/status
 * - Admin recent: GET /admin/jobs/recent
 * - Admin force paid: POST /admin/jobs/:id/force-paid
 * - Shopify paid webhook: POST /webhooks/shopify/orders-paid (RAW BODY)
 *
 * DB rules:
 * - Do NOT insert into serial id
 * - Always set job_id + id_text (same value)
 * - Auto-migrate missing columns
 * - Backfill old rows where job_id / id_text are NULL
 */

if (process.env.NODE_ENV !== "production") {
  try { require("dotenv").config(); } catch (e) {}
}

const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs");

// Optional Postgres (pg)
let Pool = null;
try { ({ Pool } = require("pg")); } catch (e) { Pool = null; }

const app = express();

/**
 * ✅ CRITICAL SHOPIFY FIX
 * Shopify HMAC verification MUST use the raw request body.
 * Register RAW parser ONLY for /webhooks/shopify/*
 * BEFORE express.json() middleware.
 */
app.use("/webhooks/shopify", express.raw({ type: "application/json" }));

// Normal parsers for all other routes (Twilio + JSON safe)
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// -------------------- PRINTER KEY AUTH --------------------
function requirePrinterKey(req, res, next) {
  const required = process.env.PRINTER_KEY;
  if (!required) return next();

  const got = req.header("x-printer-key") || req.query.printerKey || "";
  if (!got || got !== required) {
    return res.status(401).json({ ok: false, error: "Unauthorized: invalid printer key" });
  }
  next();
}

// -------------------- ADMIN KEY AUTH --------------------
function requireAdmin(req, res, next) {
  const keyFromHeader = req.headers["x-admin-key"];
  const configuredKey =
    process.env.MSTAF_ADMIN_KEY ||
    process.env.MSTAF_ADMIN ||
    process.env.ADMIN_KEY ||
    process.env.X_ADMIN_KEY;

  if (!configuredKey) {
    return res.status(503).json({ ok: false, error: "Admin key not configured" });
  }

  if (!keyFromHeader || keyFromHeader !== configuredKey) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

// Uploads folder + public access
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

const upload = multer({ dest: uploadsDir });

// Memory fallback storage
const JOBS = [];

// DB pool (Render)
let pool = null;
if (process.env.DATABASE_URL && Pool) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// ---------- HELPERS ----------
function nowISO() {
  return new Date().toISOString();
}
function makeJobId() {
  return `print_${crypto.randomBytes(8).toString("hex")}`;
}

// ---------- AUTO MIGRATION ----------
async function ensureDb() {
  if (!pool) return;

  // Ensure table exists at least with serial id
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY
    )
  `);

  // Core columns
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS job_id TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS id_text TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_id TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS from_phone TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_name TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS mime_type TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS file_url TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'queued';`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`).catch(() => {});

  // Needed for customer upload + Shopify
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS details JSONB;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS meta JSONB;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS paper_size TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS color_mode TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS copies INTEGER;`).catch(() => {});

  // Backfill old rows
  await pool.query(`
    UPDATE print_jobs
    SET
      id_text = COALESCE(id_text, 'print_' || md5(random()::text)),
      job_id  = COALESCE(job_id, id_text, 'print_' || md5(random()::text))
    WHERE id_text IS NULL OR job_id IS NULL
  `).catch(() => {});
}

// Run at boot
ensureDb().catch(() => {});

// ---------- ROUTES ----------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mstaf-core-1",
    host: os.hostname(),
    time: nowISO(),
    db: pool ? "postgres" : "memory"
  });
});

// =============================
// Public Upload (CUSTOMERS)
// No printer key required here.
// =============================
app.post("/public/upload", upload.single("file"), async (req, res) => {
  try {
    const { printerId, copies, paper, color } = req.body;

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file" });

    const copiesNum = Math.min(Math.max(parseInt(copies || "1", 10) || 1, 1), 50);
    const paperVal = (paper || "letter").toLowerCase();
    const colorVal = (color || "color").toLowerCase();

    const details = {
      copies: copiesNum,
      paper: ["letter", "a4", "legal"].includes(paperVal) ? paperVal : "letter",
      color: ["color", "bw"].includes(colorVal) ? colorVal : "color"
    };

    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
    const jobIdText = makeJobId();

    let job = null;

    if (pool) {
      await ensureDb();

      const q = `
        INSERT INTO print_jobs (
          job_id, id_text, printer_id, from_phone,
          file_name, mime_type, file_url,
          status, details, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,NOW(),NOW())
        RETURNING *
      `;
      const vals = [
        jobIdText,
        jobIdText,
        printerId,
        null,
        req.file.originalname,
        req.file.mimetype,
        fileUrl,
        JSON.stringify(details)
      ];
      const r = await pool.query(q, vals);
      job = r.rows[0];
    } else {
      job = {
        job_id: jobIdText,
        id_text: jobIdText,
        printer_id: printerId,
        from_phone: null,
        file_name: req.file.originalname,
        mime_type: req.file.mimetype,
        file_url: fileUrl,
        status: "queued",
        details,
        created_at: nowISO(),
        updated_at: nowISO()
      };
      JOBS.push(job);
    }

    res.json({ ok: true, message: "Queued print job", job });
  } catch (err) {
    console.error("PUBLIC UPLOAD ERROR:", err);
    res.status(500).json({ ok: false, error: "Server error", details: String(err.message || err) });
  }
});

// Upload -> creates queued job (printer/agent)
app.post("/api/upload", requirePrinterKey, upload.single("file"), async (req, res) => {
  try {
    const { printerId, from } = req.body;

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file" });

    const jobId = makeJobId();
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    if (!pool) {
      const job = {
        job_id: jobId,
        id_text: jobId,
        printer_id: printerId,
        from_phone: from || null,
        file_name: req.file.originalname,
        mime_type: req.file.mimetype,
        file_url: fileUrl,
        status: "queued",
        created_at: nowISO()
      };
      JOBS.push(job);
      return res.json({ ok: true, message: "Queued print job", job });
    }

    await ensureDb();

    const result = await pool.query(
      `
      INSERT INTO print_jobs (
        job_id, id_text, printer_id, from_phone,
        file_name, mime_type, file_url,
        status, paid_at, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',NULL,NOW(),NOW())
      RETURNING job_id, id_text, printer_id, from_phone, file_name, mime_type, file_url, status, paid_at, created_at, updated_at
      `,
      [jobId, jobId, printerId, from || null, req.file.originalname, req.file.mimetype, fileUrl]
    );

    return res.json({ ok: true, message: "Queued print job", job: result.rows[0] });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({ ok: false, error: "Upload failed", details: String(err.message || err) });
  }
});

// Printer poll: return jobs for printer
app.get("/jobs", async (req, res) => {
  try {
    const { printerId, limit } = req.query;
    const lim = Math.min(parseInt(limit || "20", 10), 50);

    if (!printerId) return res.status(400).json({ ok: false, error: "Missing printerId" });

    if (!pool) {
      const jobs = JOBS.filter(j => j.printer_id === printerId).slice(0, lim);
      return res.json({ ok: true, jobs });
    }

    const r = await pool.query(
      `
      SELECT job_id, id_text, printer_id, from_phone, file_name, mime_type, file_url,
             status, paid_at, created_at, updated_at, details, meta, paper_size, color_mode, copies
      FROM print_jobs
      WHERE printer_id = $1
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [printerId, lim]
    );

    return res.json({ ok: true, jobs: r.rows });
  } catch (err) {
    console.error("JOBS ERROR:", err);
    return res.status(500).json({ ok: false, error: "Jobs fetch failed", details: String(err.message || err) });
  }
});

// Update status by job id_text (same as job_id)
app.post("/jobs/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const id = req.params.id;

    if (!status) return res.status(400).json({ ok: false, error: "Missing status" });

    if (!pool) {
      const j = JOBS.find(x => x.id_text === id || x.job_id === id);
      if (j) j.status = status;
      return res.json({ ok: true });
    }

    await pool.query(
      `UPDATE print_jobs SET status=$1, updated_at=NOW() WHERE id_text=$2 OR job_id=$2`,
      [status, id]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("STATUS ERROR:", err);
    return res.status(500).json({ ok: false, error: "Status update failed", details: String(err.message || err) });
  }
});

// ==================== ADMIN (protected) ====================
app.get("/admin/jobs/recent", requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);

  try {
    if (!pool) return res.json({ ok: true, jobs: JOBS.slice(-limit).reverse() });

    const r = await pool.query(
      `
      SELECT job_id, id_text, printer_id, from_phone, file_name, mime_type, file_url,
             status, paid_at, created_at, updated_at, details, meta, paper_size, color_mode, copies
      FROM print_jobs
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );
    return res.json({ ok: true, jobs: r.rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "admin recent failed", details: String(e.message || e) });
  }
});

app.post("/admin/jobs/:id/force-paid", requireAdmin, async (req, res) => {
  const id = req.params.id;

  try {
    if (!pool) return res.status(501).json({ ok: false, error: "DB not enabled" });

    const r = await pool.query(
      `
      UPDATE print_jobs
      SET status='paid', paid_at=NOW(), updated_at=NOW()
      WHERE job_id=$1 OR id_text=$1
      RETURNING job_id, id_text, status, paid_at, updated_at
      `,
      [id]
    );

    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "Job not found" });

    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "force-paid failed", details: String(e.message || e) });
  }
});

// ===============================
// Shopify Orders Paid Webhook (RAW BODY)
// ===============================
function verifyShopifyHmacRaw(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) throw new Error("Missing SHOPIFY_WEBHOOK_SECRET");

  // req.body is Buffer because of app.use("/webhooks/shopify", express.raw(...))
  const rawBody = req.body;
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(hmacHeader, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseVariantTitle(variantTitle) {
  if (!variantTitle || typeof variantTitle !== "string") return null;

  // Expected: "A4 / Black & White / 10 Copies"
  const parts = variantTitle.split("/").map(s => s.trim());
  if (parts.length !== 3) return null;

  const paper = parts[0];
  const colorRaw = parts[1].toLowerCase();
  const copiesRaw = parts[2];

  const color =
    colorRaw.includes("black") ? "bw" :
    colorRaw === "color" ? "color" :
    null;

  const m = copiesRaw.match(/(\d+)/);
  const copies = m ? parseInt(m[1], 10) : null;

  if (!paper || !color || !Number.isInteger(copies) || copies <= 0) return null;
  return { paper, color, copies };
}

function getOrderPhone(order) {
  return (
    order?.shipping_address?.phone ||
    order?.billing_address?.phone ||
    order?.customer?.phone ||
    order?.phone ||
    null
  );
}

async function shopifyOrdersPaidHandler(req, res) {
  try {
    const ok = verifyShopifyHmacRaw(req);
    if (!ok) return res.status(401).send("Invalid HMAC");

    const order = JSON.parse(req.body.toString("utf8"));

    if ((order.financial_status || "").toLowerCase() !== "paid") {
      return res.status(200).send("Ignored (not paid)");
    }

    const printerId = process.env.DEFAULT_PRINTER_ID || "PP-USA-001";
    const orderId = order.id;
    const orderName = order.name || null;
    const email = order.email || order?.customer?.email || null;
    const phone = getOrderPhone(order);

    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    if (lineItems.length === 0) return res.status(200).json({ ok: true, created_count: 0 });

    if (!pool) return res.status(501).json({ ok: false, error: "DB not enabled" });

    await ensureDb();

    const created = [];

    for (const li of lineItems) {
      const variantTitle =
        li.variant_title ||
        (typeof li.name === "string" && li.name.includes(" - ")
          ? li.name.split(" - ").slice(1).join(" - ")
          : null);

      const parsed = parseVariantTitle(variantTitle);
      if (!parsed) continue;

      // ✅ IMPORTANT: job_id is NOT NULL in your DB, so always set job_id + id_text
      const jobId = `shopify_${orderId}_${li.id}_${crypto.randomBytes(4).toString("hex")}`;

      const meta = {
        source: "shopify",
        order_id: orderId,
        order_name: orderName,
        line_item_id: li.id,
        product_id: li.product_id || null,
        variant_id: li.variant_id || null,
        variant_title: variantTitle,
        quantity: li.quantity || 1,
        customer_email: email,
        customer_phone: phone
      };

      await pool.query(
        `
        INSERT INTO print_jobs (
          job_id,
          id_text,
          printer_id,
          from_phone,
          status,
          meta,
          paper_size,
          color_mode,
          copies,
          created_at,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
        `,
        [
          jobId,
          jobId,
          printerId,
          phone,
          "authorized_awaiting_file",
          JSON.stringify(meta),
          parsed.paper,
          parsed.color,
          parsed.copies
        ]
      );

      created.push({ jobId, ...parsed });
    }

    return res.status(200).json({ ok: true, created_count: created.length, created });
  } catch (err) {
    console.error("SHOPIFY WEBHOOK ERROR:", err);
    return res.status(500).send("Webhook error");
  }
}

// Do NOT put express.raw() here (already applied via app.use above)
app.post("/webhooks/shopify/orders-paid", shopifyOrdersPaidHandler);
app.post("/webhooks/shopify/order_paid", shopifyOrdersPaidHandler);

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MSTAF CORE running on port ${PORT}`));
