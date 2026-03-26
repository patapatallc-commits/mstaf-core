require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { Pool } = require("pg");
const axios = require("axios");

const app = express();

/* ---------------- ENV ---------------- */
const PORT = process.env.PORT || 10000;

const BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`;

const DASHBOARD_KEY = String(process.env.DASHBOARD_KEY || "").trim();
const WORKER_KEY =
  String(process.env.WORKER_KEY || "").trim() ||
  String(process.env.PRINTER_KEY || "").trim();

const DEFAULT_PRINTER_ID = String(process.env.PRINTER_ID || "PP-USA-001").trim();
const A3_PRINTER_ID = String(process.env.A3_PRINTER_ID || "PP-USA-A3-001").trim();
const CARD_PRINTER_ID = String(process.env.CARD_PRINTER_ID || "PP-USA-CARD-001").trim();
const DISPATCH_QUEUE_ID = String(process.env.DISPATCH_QUEUE_ID || "DISPATCH").trim();
const AGENT_QUEUE_ID = String(process.env.AGENT_QUEUE_ID || "AGENT").trim();

const VERIFY_TOKEN = String(
  process.env.WHATSAPP_VERIFY_TOKEN || "PATAPATA_MSTAF_WEBHOOK"
).trim();

const WHATSAPP_PHONE_NUMBER_ID = String(
  process.env.WHATSAPP_PHONE_NUMBER_ID || ""
).trim();

const WHATSAPP_ACCESS_TOKEN = String(
  process.env.WHATSAPP_ACCESS_TOKEN || ""
).trim();

/* legacy env only for warning/debug; NOT used for auth */
const LEGACY_WHATSAPP_TOKEN = String(process.env.WHATSAPP_TOKEN || "").trim();

/* ---------------- OPTIONAL LINKS / MODES ---------------- */
const SHOPIFY_CHECKOUT_LINK = String(
  process.env.SHOPIFY_CHECKOUT_LINK || "https://www.patapata.us"
).trim();

const AFRICA_PAYMENT_PORTAL = String(
  process.env.AFRICA_PAYMENT_PORTAL ||
    "https://www.patapata.us/pages/africa-payment-portal"
).trim();

const LESSON_ACCESS_MODE = String(
  process.env.LESSON_ACCESS_MODE || "enrolled_only"
)
  .trim()
  .toLowerCase();

/* ---------------- MIDDLEWARE ---------------- */
app.use(cors());
app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));

/* ---------------- DB ---------------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

/* ---------------- UPLOADS ---------------- */
const uploadsDir = path.resolve(process.cwd(), "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "1h" }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const original = file.originalname || "file";
    const safe = original.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-90);
    cb(null, `${Date.now()}_${Math.random().toString(16).slice(2)}_${safe}`);
  },
});

const upload = multer({ storage });

/* ---------------- HELPERS ---------------- */
function safeTrim(v) {
  return String(v ?? "").trim();
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[m];
  });
}

function calcUnitPrice(colorMode) {
  const m = String(colorMode || "").toLowerCase();
  if (m.includes("bw") || m.includes("black")) return 0.25;
  return 0.5;
}

function normalizeServiceType(v) {
  const s = safeTrim(v).toLowerCase();

  if (!s) return "PRINT";
  if (s.includes("laminat")) return "LAMINATING";
  if (s.includes("id") && s.includes("card")) return "ID_CARD_PRINTING";
  if (s.includes("id") && s.includes("photo")) return "ID_PHOTO";
  if (s.includes("video")) return "VIDEO_EDITING";
  if (s.includes("image")) return "IMAGE_EDITING";
  if (s.includes("edit")) return "EDITING";
  if (s.includes("homework")) return "HOMEWORK";
  if (s.includes("transcript")) return "TRANSCRIPT";
  if (s.includes("lesson")) return "LESSON";
  if (s.includes("quiz")) return "QUIZ";
  if (s.includes("card")) return "CARD_PRINTING";
  return s.toUpperCase();
}

function requireWorkerAuth(req, res, next) {
  const provided = safeTrim(
    req.headers["x-worker-key"] ||
      req.headers["x-printer-key"] ||
      req.query.key ||
      req.query.worker_key ||
      req.query.printer_key ||
      ""
  );

  if (!WORKER_KEY) {
    return res.status(500).json({ error: "Server WORKER_KEY/PRINTER_KEY not configured" });
  }

  if (provided !== WORKER_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function requireDashboardAuth(req, res, next) {
  const provided = safeTrim(req.headers["x-dashboard-key"] || req.query.key || "");

  if (!DASHBOARD_KEY) {
    return res.status(500).json({ error: "Server DASHBOARD_KEY not configured" });
  }

  if (provided !== DASHBOARD_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function appendLine(parts, label, value) {
  const v = safeTrim(value);
  if (v) parts.push(`${label}: ${v}`);
}

function appendUrlLine(parts, label, value) {
  const v = safeTrim(value);
  if (/^https?:\/\//i.test(v)) {
    parts.push(`${label}: ${v}`);
  }
}

function buildCombinedInstructions(data) {
  const parts = [];

  if (safeTrim(data.instructions)) {
    parts.push(safeTrim(data.instructions));
  }

  if (safeTrim(data.laminating_type) && safeTrim(data.laminating_type).toUpperCase() !== "NONE") {
    parts.push(`Laminating Type: ${safeTrim(data.laminating_type)}`);
  }

  if (Number(data.laminating_qty) > 0) {
    parts.push(`Laminating Qty: ${Number(data.laminating_qty)}`);
  }

  if (safeTrim(data.laminating_note)) {
    parts.push(`Laminating Note: ${safeTrim(data.laminating_note)}`);
  }

  appendUrlLine(parts, "Video Link", data.video_link);
  appendUrlLine(parts, "Embedded Video Link", data.embed_link);
  appendUrlLine(parts, "Reference Link", data.reference_link);

  return parts.filter(Boolean).join("\n");
}

function buildCombinedNotes(data) {
  const parts = [];

  if (safeTrim(data.notes)) {
    parts.push(safeTrim(data.notes));
  }

  if (!safeTrim(data.instructions) && safeTrim(data.laminating_note)) {
    parts.push(`Laminating Note: ${safeTrim(data.laminating_note)}`);
  }

  appendLine(parts, "Customer Name", data.customer_name);
  appendLine(parts, "Customer Email", data.customer_email);
  appendUrlLine(parts, "Video Link", data.video_link);
  appendUrlLine(parts, "Embedded Video Link", data.embed_link);
  appendUrlLine(parts, "Reference Link", data.reference_link);

  return parts.filter(Boolean).join("\n");
}

function formatAxiosError(error) {
  if (error?.response?.data) {
    try {
      return JSON.stringify(error.response.data);
    } catch (_) {
      return String(error.response.data);
    }
  }

  if (error?.response?.status) {
    return `HTTP ${error.response.status}`;
  }

  return error?.message || "Unknown error";
}

/* ---------------- WHATSAPP HELPERS ---------------- */
async function sendWhatsAppText(to, body) {
  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WhatsApp credentials are not configured");
  }

  const url = `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };

  try {
    const { data } = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    return data;
  } catch (error) {
    const metaError = formatAxiosError(error);
    console.error("WhatsApp send error:", metaError);
    throw error;
  }
}

async function getWhatsAppMediaUrl(mediaId) {
  if (!WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WhatsApp access token is not configured");
  }

  const url = `https://graph.facebook.com/v18.0/${mediaId}`;

  try {
    const { data } = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      },
    });
    return data?.url || "";
  } catch (error) {
    console.error("WhatsApp media URL error:", formatAxiosError(error));
    throw error;
  }
}

async function downloadWhatsAppMedia(mediaId) {
  if (!mediaId) throw new Error("Missing WhatsApp mediaId");
  if (!WHATSAPP_ACCESS_TOKEN) throw new Error("WhatsApp access token is not configured");

  const mediaUrl = await getWhatsAppMediaUrl(mediaId);
  if (!mediaUrl) throw new Error("Could not resolve WhatsApp media URL");

  try {
    const { data } = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      },
    });

    return Buffer.from(data);
  } catch (error) {
    console.error("WhatsApp media download error:", formatAxiosError(error));
    throw error;
  }
}

function saveWhatsAppFile(fileBuffer, ext = "bin") {
  const safeExt = String(ext || "bin").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
  const filename = `wa_${Date.now()}_${Math.random().toString(16).slice(2)}.${safeExt}`;
  const filePath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(filePath, fileBuffer);

  return {
    filename,
    filePath,
    fileUrl: `${BASE_URL}/uploads/${encodeURIComponent(filename)}`,
  };
}

async function createWhatsAppJob({
  from,
  service_type,
  savedFile,
  original_name = "",
  paper_size = "A4",
  color_mode = "BW",
  copies = 1,
  pages = 1,
  instructions = "",
  notes = "",
}) {
  const printer_id = routeQueue({
    printer_id: "",
    paper_size,
    service_type,
  });

  const unit = calcUnitPrice(color_mode);
  const total_cost = Number((unit * pages * copies).toFixed(2));

  const q = `
    INSERT INTO print_jobs
      (
        status,
        printer_id,
        file_url,
        original_name,
        paper_size,
        color_mode,
        copies,
        pages,
        total_cost,
        customer_name,
        customer_email,
        country,
        city,
        notes,
        instructions,
        service_type
      )
    VALUES
      (
        'pending',
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15
      )
    RETURNING *;
  `;

  const values = [
    printer_id,
    savedFile.fileUrl,
    original_name || savedFile.filename,
    paper_size,
    color_mode,
    copies,
    pages,
    total_cost,
    `WhatsApp ${from}`,
    "",
    "",
    "",
    notes,
    instructions,
    service_type,
  ];

  const created = await pool.query(q, values);
  return created.rows[0];
}

/* ---------------- PRINTER REGISTRY ---------------- */
const NG_STATE_CODES = [
  ["Abia", "AB"],
  ["Adamawa", "AD"],
  ["Akwa Ibom", "AK"],
  ["Anambra", "AN"],
  ["Bauchi", "BA"],
  ["Bayelsa", "BY"],
  ["Benue", "BE"],
  ["Borno", "BO"],
  ["Cross River", "CR"],
  ["Delta", "DE"],
  ["Ebonyi", "EB"],
  ["Edo", "ED"],
  ["Ekiti", "EK"],
  ["Enugu", "EN"],
  ["Gombe", "GO"],
  ["Imo", "IM"],
  ["Jigawa", "JI"],
  ["Kaduna", "KD"],
  ["Kano", "KN"],
  ["Katsina", "KT"],
  ["Kebbi", "KB"],
  ["Kogi", "KG"],
  ["Kwara", "KW"],
  ["Lagos", "LA"],
  ["Nasarawa", "NA"],
  ["Niger", "NI"],
  ["Ogun", "OG"],
  ["Ondo", "ON"],
  ["Osun", "OS"],
  ["Oyo", "OY"],
  ["Plateau", "PL"],
  ["Rivers", "RI"],
  ["Sokoto", "SO"],
  ["Taraba", "TA"],
  ["Yobe", "YO"],
  ["Zamfara", "ZA"],
];

function buildPrinterRegistry() {
  const printers = [];

  printers.push({
    id: DISPATCH_QUEUE_ID,
    label: "DISPATCH — Manual Routing Queue",
    kind: "queue",
  });

  printers.push({
    id: AGENT_QUEUE_ID,
    label: "AGENT — Image/Video Editing Queue",
    kind: "queue",
  });

  printers.push({
    id: DEFAULT_PRINTER_ID,
    label: `USA — A4 Hub Printer (Default) (${DEFAULT_PRINTER_ID})`,
    kind: "printer",
    country: "USA",
  });

  printers.push({
    id: A3_PRINTER_ID,
    label: `USA — A3 Printer (${A3_PRINTER_ID})`,
    kind: "printer",
    country: "USA",
  });

  printers.push({
    id: CARD_PRINTER_ID,
    label: `USA — CARD Printer (${CARD_PRINTER_ID})`,
    kind: "printer",
    country: "USA",
  });

  for (const [name, code] of NG_STATE_CODES) {
    const a4 = `PP-NG-${code}-A4-001`;
    const sp = `PP-NG-${code}-SP-001`;

    printers.push({
      id: a4,
      label: `Nigeria — ${name} A4 Hub (${a4})`,
      kind: "printer",
      country: "Nigeria",
      state: name,
    });

    printers.push({
      id: sp,
      label: `Nigeria — ${name} SPECIAL A3/CARD (${sp})`,
      kind: "printer",
      country: "Nigeria",
      state: name,
    });
  }

  return printers;
}

const PRINTERS = buildPrinterRegistry();
const PRINTER_BY_ID = new Map(PRINTERS.map((p) => [p.id, p]));

/* ---------------- ROUTING LOGIC ---------------- */
function routeQueue({ printer_id, paper_size, service_type }) {
  const requested = safeTrim(printer_id);
  if (requested) return requested;

  const svc = normalizeServiceType(service_type);
  const ps = safeTrim(paper_size).toUpperCase();

  if (
    svc === "IMAGE_EDITING" ||
    svc === "VIDEO_EDITING" ||
    svc === "EDITING" ||
    svc === "LESSON" ||
    svc === "QUIZ" ||
    svc === "HOMEWORK" ||
    svc === "TRANSCRIPT"
  ) {
    return AGENT_QUEUE_ID;
  }

  if (
    svc === "LAMINATING" ||
    svc === "ID_CARD_PRINTING" ||
    svc === "ID_PHOTO" ||
    svc === "CARD_PRINTING"
  ) {
    return DISPATCH_QUEUE_ID;
  }

  if (ps === "A3" || ps.includes("CARD")) {
    return DISPATCH_QUEUE_ID;
  }

  return DEFAULT_PRINTER_ID;
}

function normalizeUploadBody(body = {}) {
  return {
    paper_size: safeTrim(body.paper_size || body.paperSize || body.size || "A4"),
    color_mode: safeTrim(body.color_mode || body.colorMode || body.printType || "BW"),
    copies: num(body.copies || body.quantity || 1, 1),
    pages: num(body.pages || body.pageCount || 1, 1),
    service_type: normalizeServiceType(
      body.service_type || body.serviceType || body.service || "PRINT"
    ),
    instructions: safeTrim(body.instructions || body.instruction || body.message || ""),
    customer_name: safeTrim(body.customer_name || body.customerName || body.name || ""),
    customer_email: safeTrim(body.customer_email || body.customerEmail || body.email || ""),
    country: safeTrim(body.country || ""),
    city: safeTrim(body.city || ""),
    notes: safeTrim(body.notes || body.note || ""),
    printer_id: safeTrim(body.printer_id || body.printerId || ""),

    laminating_type: safeTrim(body.laminating_type || body.lamination_type || "NONE"),
    laminating_qty: num(body.laminating_qty || body.lamination_qty || 0, 0),
    laminating_note: safeTrim(body.laminating_note || body.lamination_note || ""),

    video_link: safeTrim(
      body.video_link ||
        body.video_url ||
        body.videoUrl ||
        body.video_hyperlink ||
        body.videoHyperlink ||
        ""
    ),
    embed_link: safeTrim(
      body.embed_link ||
        body.embedded_video_link ||
        body.embedded_content_link ||
        body.embed_url ||
        body.embedUrl ||
        ""
    ),
    reference_link: safeTrim(
      body.reference_link ||
        body.reference_url ||
        body.hyperlink ||
        body.link ||
        ""
    ),
  };
}

/* ---------------- HEALTH ---------------- */
app.get("/", (req, res) => res.status(200).send("MSTAF Core is running ✅"));

app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({
      ok: true,
      db: r.rows?.[0]?.ok === 1,
      base_url: BASE_URL,
      printer_count: PRINTERS.length,
      whatsapp: {
        phone_number_id_configured: Boolean(WHATSAPP_PHONE_NUMBER_ID),
        access_token_configured: Boolean(WHATSAPP_ACCESS_TOKEN),
        legacy_whatsapp_token_detected: Boolean(LEGACY_WHATSAPP_TOKEN),
      },
      defaults: {
        DEFAULT_PRINTER_ID,
        A3_PRINTER_ID,
        CARD_PRINTER_ID,
        DISPATCH_QUEUE_ID,
        AGENT_QUEUE_ID,
      },
      services: [
        "PRINT",
        "CARD_PRINTING",
        "IMAGE_EDITING",
        "VIDEO_EDITING",
        "EDITING",
        "LAMINATING",
        "ID_CARD_PRINTING",
        "ID_PHOTO",
        "LESSON",
        "QUIZ",
        "HOMEWORK",
        "TRANSCRIPT",
      ],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({
      ok: true,
      db: r.rows?.[0]?.ok === 1,
      base_url: BASE_URL,
      printer_count: PRINTERS.length,
      whatsapp: {
        phone_number_id_configured: Boolean(WHATSAPP_PHONE_NUMBER_ID),
        access_token_configured: Boolean(WHATSAPP_ACCESS_TOKEN),
        legacy_whatsapp_token_detected: Boolean(LEGACY_WHATSAPP_TOKEN),
      },
      defaults: {
        DEFAULT_PRINTER_ID,
        A3_PRINTER_ID,
        CARD_PRINTER_ID,
        DISPATCH_QUEUE_ID,
        AGENT_QUEUE_ID,
      },
      services: [
        "PRINT",
        "CARD_PRINTING",
        "IMAGE_EDITING",
        "VIDEO_EDITING",
        "EDITING",
        "LAMINATING",
        "ID_CARD_PRINTING",
        "ID_PHOTO",
        "LESSON",
        "QUIZ",
        "HOMEWORK",
        "TRANSCRIPT",
      ],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/debug", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({
      ok: true,
      message: "MSTAF debug route working",
      now: r.rows?.[0]?.now || null,
      base_url: BASE_URL,
      whatsapp: {
        phone_number_id_configured: Boolean(WHATSAPP_PHONE_NUMBER_ID),
        access_token_configured: Boolean(WHATSAPP_ACCESS_TOKEN),
        legacy_whatsapp_token_detected: Boolean(LEGACY_WHATSAPP_TOKEN),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------------- CREATE PRINT JOB (UPLOAD) ---------------- */
async function createPrintJobHandler(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const normalized = normalizeUploadBody(req.body);

    const paper_size = normalized.paper_size || "A4";
    const color_mode = normalized.color_mode || "BW";
    const copies = Math.max(1, num(normalized.copies, 1));
    const pages = Math.max(1, num(normalized.pages, 1));
    const service_type = normalized.service_type || "PRINT";
    const customer_name = normalized.customer_name || "";
    const customer_email = normalized.customer_email || "";
    const country = normalized.country || "";
    const city = normalized.city || "";
    const requested_printer_id = normalized.printer_id || "";

    const instructions = buildCombinedInstructions(normalized);
    const notes = buildCombinedNotes(normalized);

    const printer_id = routeQueue({
      printer_id: requested_printer_id,
      paper_size,
      service_type,
    });

    const file_url = `${BASE_URL}/uploads/${encodeURIComponent(req.file.filename)}`;
    const original_name = safeTrim(req.file.originalname || "");

    const unit = calcUnitPrice(color_mode);
    const total_cost = Number((unit * pages * copies).toFixed(2));

    const q = `
      INSERT INTO print_jobs
        (
          status,
          printer_id,
          file_url,
          original_name,
          paper_size,
          color_mode,
          copies,
          pages,
          total_cost,
          customer_name,
          customer_email,
          country,
          city,
          notes,
          instructions,
          service_type
        )
      VALUES
        (
          'pending',
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, $15
        )
      RETURNING *;
    `;

    const values = [
      printer_id,
      file_url,
      original_name,
      paper_size,
      color_mode,
      copies,
      pages,
      total_cost,
      customer_name,
      customer_email,
      country,
      city,
      notes,
      instructions,
      service_type,
    ];

    const created = await pool.query(q, values);

    return res.status(201).json({
      ok: true,
      job: created.rows[0],
      file_url,
      pricing: {
        unit_price: unit,
        pages,
        copies,
        total_cost,
      },
      routed_to: printer_id,
      service_type,
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message,
      hint: "If your table is missing instructions/service_type columns, add them or remove from INSERT.",
    });
  }
}

app.post("/api/print-jobs", upload.single("file"), createPrintJobHandler);
app.post("/api/upload", upload.single("file"), createPrintJobHandler);

/* ---------------- WORKER: CLAIM NEXT JOB ---------------- */
async function claimNextJob(req, res) {
  const printer_id = safeTrim(req.query.printer_id || DEFAULT_PRINTER_ID);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sel = await client.query(
      `
      SELECT *
      FROM print_jobs
      WHERE status = 'pending'
        AND printer_id = $1
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1;
      `,
      [printer_id]
    );

    if (sel.rowCount === 0) {
      await client.query("COMMIT");
      return res.json({ ok: true, job: null });
    }

    const job = sel.rows[0];

    const upd = await client.query(
      `
      UPDATE print_jobs
      SET status = 'printing'
      WHERE id = $1
      RETURNING *;
      `,
      [job.id]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, job: upd.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
}

app.get("/api/worker/next", requireWorkerAuth, claimNextJob);
app.get("/worker/next", requireWorkerAuth, claimNextJob);

/* ---------------- WORKER: UPDATE JOB STATUS ---------------- */
app.post("/api/worker/jobs/:id/status", requireWorkerAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const status = safeTrim(req.body.status || "");
    const error_message = safeTrim(req.body.error_message || "");

    if (!status) return res.status(400).json({ error: "Missing status" });

    const r = await pool.query(
      `
      UPDATE print_jobs
      SET status = $2,
          error_message = NULLIF($3, '')
      WHERE id = $1
      RETURNING *;
      `,
      [id, status, error_message]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "Job not found" });
    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/worker/status", requireWorkerAuth, async (req, res) => {
  try {
    const id = Number(req.body.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const status = safeTrim(req.body.status || "");
    const error_message = safeTrim(req.body.error_message || "");

    if (!status) return res.status(400).json({ error: "Missing status" });

    const r = await pool.query(
      `
      UPDATE print_jobs
      SET status = $2,
          error_message = NULLIF($3, '')
      WHERE id = $1
      RETURNING *;
      `,
      [id, status, error_message]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "Job not found" });
    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    console.error("legacy /api/worker/status error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ---------------- DASHBOARD API: LIST JOBS ---------------- */
app.get("/api/dashboard/jobs", requireDashboardAuth, async (req, res) => {
  try {
    const printer_id = safeTrim(req.query.printer_id || DISPATCH_QUEUE_ID);
    const limit = Math.min(Math.max(1, num(req.query.limit, 50)), 200);
    const status = safeTrim(req.query.status || "");
    const q = safeTrim(req.query.q || "");

    const where = ["printer_id = $1"];
    const params = [printer_id];
    let idx = 2;

    if (status) {
      where.push(`status = $${idx++}`);
      params.push(status);
    }

    if (q) {
      where.push(`(
        CAST(id AS TEXT) ILIKE $${idx} OR
        COALESCE(original_name,'') ILIKE $${idx} OR
        COALESCE(customer_email,'') ILIKE $${idx} OR
        COALESCE(customer_name,'') ILIKE $${idx} OR
        COALESCE(instructions,'') ILIKE $${idx} OR
        COALESCE(notes,'') ILIKE $${idx} OR
        COALESCE(service_type,'') ILIKE $${idx} OR
        COALESCE(file_url,'') ILIKE $${idx}
      )`);
      params.push(`%${q}%`);
      idx++;
    }

    params.push(limit);

    const r = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${idx};
      `,
      params
    );

    return res.json({ ok: true, jobs: r.rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/jobs", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, status, printer_id, original_name, copies, pages, total_cost, created_at, service_type
      FROM print_jobs
      ORDER BY created_at DESC
      LIMIT 50
    `);
    return res.json({ ok: true, jobs: r.rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------------- DASHBOARD API: ROUTE / DELETE / MARK ---------------- */
app.post("/api/dashboard/jobs/:id/route", requireDashboardAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const to_printer_id = safeTrim(req.body.to_printer_id || "");

    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    if (!to_printer_id) return res.status(400).json({ error: "Missing to_printer_id" });
    if (!PRINTER_BY_ID.has(to_printer_id)) {
      return res.status(400).json({ error: "Unknown printer/queue id" });
    }

    const r = await pool.query(
      `
      UPDATE print_jobs
      SET printer_id = $2,
          status = 'pending',
          error_message = NULL
      WHERE id = $1
      RETURNING *;
      `,
      [id, to_printer_id]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "Job not found" });
    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/dashboard/jobs/:id/mark", requireDashboardAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = safeTrim(req.body.status || "");
    const error_message = safeTrim(req.body.error_message || "");

    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
    if (!status) return res.status(400).json({ error: "Missing status" });

    const r = await pool.query(
      `
      UPDATE print_jobs
      SET status = $2,
          error_message = NULLIF($3, '')
      WHERE id = $1
      RETURNING *;
      `,
      [id, status, error_message]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "Job not found" });
    return res.json({ ok: true, job: r.rows[0] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/dashboard/jobs/:id/delete", requireDashboardAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const r = await pool.query(`DELETE FROM print_jobs WHERE id = $1 RETURNING id;`, [id]);

    if (r.rowCount === 0) return res.status(404).json({ error: "Job not found" });
    return res.json({ ok: true, deleted: r.rows[0].id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* ---------------- DASHBOARD UI ---------------- */
function dashboardHtml({ initialPrinter }) {
  const options = PRINTERS.map(
    (p) => `<option value="${escHtml(p.id)}">${escHtml(p.label)}</option>`
  ).join("");

  const initialPrinterSafe = JSON.stringify(initialPrinter || DISPATCH_QUEUE_ID);
  const routeOptionsJson = JSON.stringify(
    PRINTERS.map((p) => ({ id: p.id, label: p.label }))
  );

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>MSTAF Worker + Agent Dashboard</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#071225;color:#e5e7eb}
    .wrap{max-width:1360px;margin:0 auto;padding:24px}
    .top{display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
    .card{background:rgba(15,23,42,.9);border:1px solid #1f2a44;border-radius:16px;padding:14px}
    input,select,button{padding:10px 12px;border-radius:12px;border:1px solid #334155;background:#0b1730;color:#e5e7eb}
    button{cursor:pointer}
    .muted{color:#94a3b8}
    .err{color:#fca5a5;white-space:pre-wrap}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
    th,td{border-bottom:1px solid #1f2a44;padding:10px;text-align:left;vertical-align:top}
    a{color:#93c5fd}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid #334155;color:#cbd5e1;font-size:12px}
    .actions{display:flex;gap:8px;flex-wrap:wrap}
    .btn-sm{padding:7px 10px;border-radius:10px}
    .danger{border-color:#7f1d1d}
    .file-links{display:flex;flex-direction:column;gap:6px}
    .text-wrap{white-space:pre-wrap;word-break:break-word}
    .mini{font-size:11px;color:#94a3b8;margin-bottom:4px}
  </style>
</head>
<body>
  <div class="wrap">
    <h2 style="margin:0 0 6px 0;">MSTAF Worker + Agent Dashboard</h2>
    <div class="muted" style="margin-bottom:16px;">
      DISPATCH routing • printers • editing queue • Nigeria hubs
      <span style="float:right" class="muted">
        Auto: A4→${escHtml(DEFAULT_PRINTER_ID)} • A3/CARD/LAMINATING/ID CARD→${escHtml(DISPATCH_QUEUE_ID)} • IMAGE/VIDEO/LESSON→${escHtml(AGENT_QUEUE_ID)}
      </span>
    </div>

    <div class="card">
      <div class="top">
        <div>
          <div class="muted" style="margin-bottom:6px;">Queue/Printer</div>
          <select id="printer" style="min-width:520px;max-width:520px">${options}</select>
        </div>

        <div>
          <div class="muted" style="margin-bottom:6px;">Status</div>
          <select id="status">
            <option value="">All</option>
            <option value="pending">pending</option>
            <option value="printing">printing</option>
            <option value="done">done</option>
            <option value="error">error</option>
          </select>
        </div>

        <div style="flex:1;min-width:240px">
          <div class="muted" style="margin-bottom:6px;">Search</div>
          <input id="q" placeholder="id, name, email, filename, instructions, links..." style="width:100%"/>
        </div>

        <div>
          <div class="muted" style="margin-bottom:6px;">Limit</div>
          <input id="limit" type="number" value="50" min="1" max="200" style="width:110px"/>
        </div>

        <div class="row">
          <button id="refresh">Refresh</button>
          <label class="muted"><input id="auto" type="checkbox" style="transform:scale(1.1);margin-right:6px"/> Auto-refresh</label>
          <span id="loadState" class="muted">Idle</span>
        </div>
      </div>

      <div id="error" class="err"></div>
      <div id="table"></div>
    </div>
  </div>

<script>
  const urlParams = new URLSearchParams(location.search);
  const DASH_KEY = urlParams.get("key") || "";

  const printerEl = document.getElementById("printer");
  const statusEl = document.getElementById("status");
  const qEl = document.getElementById("q");
  const limitEl = document.getElementById("limit");
  const refreshBtn = document.getElementById("refresh");
  const autoEl = document.getElementById("auto");
  const errorEl = document.getElementById("error");
  const tableEl = document.getElementById("table");
  const loadStateEl = document.getElementById("loadState");

  function esc(s){
    return String(s ?? "").replace(/[&<>"']/g, m => ({
      "&":"&amp;",
      "<":"&lt;",
      ">":"&gt;",
      "\\"":"&quot;",
      "'":"&#39;"
    }[m]));
  }

  function isVideoFilename(name){
    return /\\.(mp4|mov|avi|mkv|webm|m4v|3gp)$/i.test(String(name || ""));
  }

  function linkifyText(s){
    const raw = String(s ?? "");
    if(!raw) return "";
    const escaped = esc(raw);
    return escaped.replace(/(https?:\\/\\/[^\\s<]+)/gi, function(url){
      return "<a href='" + url + "' target='_blank' rel='noopener noreferrer'>" + url + "</a>";
    });
  }

  function extractUrlsFromText(s){
    const txt = String(s ?? "");
    const matches = txt.match(/https?:\\/\\/[^\\s]+/gi) || [];
    const uniq = [];
    const seen = new Set();
    for (const m of matches) {
      if (!seen.has(m)) {
        seen.add(m);
        uniq.push(m);
      }
    }
    return uniq;
  }

  const INITIAL_PRINTER = ${initialPrinterSafe};
  printerEl.value = INITIAL_PRINTER;

  let timer = null;

  function apiUrl(path){
    const sep = path.includes("?") ? "&" : "?";
    return path + sep + "key=" + encodeURIComponent(DASH_KEY);
  }

  async function apiPost(path, body){
    const r = await fetch(apiUrl(path), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dashboard-key": DASH_KEY
      },
      body: JSON.stringify(body || {})
    });

    const data = await r.json().catch(() => ({}));
    if(!r.ok) throw new Error("HTTP " + r.status + ": " + JSON.stringify(data));
    return data;
  }

  function renderJobs(jobs){
    if(!Array.isArray(jobs) || jobs.length === 0){
      tableEl.innerHTML = "<div class='muted'>0 jobs</div>";
      return;
    }

    const routeOptions = ${routeOptionsJson};

    const rows = jobs.map(j => {
      const fileLinks = [];

      const mainFileLabel =
        (String(j.service_type || "").toUpperCase() === "VIDEO_EDITING" || isVideoFilename(j.original_name))
          ? "Open Video"
          : "Open File";

      if (j.file_url) {
        fileLinks.push(
          "<a href='" + esc(j.file_url) + "' target='_blank' rel='noopener noreferrer'>" + esc(mainFileLabel) + "</a>"
        );
      }

      const textUrls = [
        ...extractUrlsFromText(j.instructions || ""),
        ...extractUrlsFromText(j.notes || "")
      ];

      const uniqueUrls = [];
      const seenUrls = new Set(j.file_url ? [String(j.file_url)] : []);

      for (const u of textUrls) {
        if (!seenUrls.has(u)) {
          seenUrls.add(u);
          uniqueUrls.push(u);
        }
      }

      uniqueUrls.forEach((u, idx) => {
        const isVid =
          /\\.(mp4|mov|avi|mkv|webm|m4v|3gp)(\\?|#|$)/i.test(u) ||
          String(j.service_type || "").toUpperCase() === "VIDEO_EDITING";

        fileLinks.push(
          "<a href='" + esc(u) + "' target='_blank' rel='noopener noreferrer'>" +
          esc(isVid ? ("Open Video Link " + (idx + 1)) : ("Open Link " + (idx + 1))) +
          "</a>"
        );
      });

      const file =
        fileLinks.length
          ? "<div class='file-links'>" + fileLinks.join("") + "</div>"
          : "<span class='muted'>—</span>";

      const instrRaw = String(j.instructions || "");
      const notesRaw = String(j.notes || "");
      const svc = esc(j.service_type || "");
      const who = [j.customer_name, j.customer_email].filter(Boolean).map(esc).join("<br/>");
      const loc = [j.city, j.country].filter(Boolean).map(esc).join(", ");

      const routeSel =
        "<select data-route='" + esc(j.id) + "'>" +
        routeOptions.map(p =>
          "<option value='" + esc(p.id) + "' " + (p.id === j.printer_id ? "selected" : "") + ">" +
          esc(p.label) +
          "</option>"
        ).join("") +
        "</select>";

      const actions =
        "<div class='actions'>" +
          "<button class='btn-sm' data-move='" + esc(j.id) + "'>Route</button>" +
          "<button class='btn-sm' data-done='" + esc(j.id) + "'>Done</button>" +
          "<button class='btn-sm' data-err='" + esc(j.id) + "'>Error</button>" +
          "<button class='btn-sm danger' data-del='" + esc(j.id) + "'>Delete</button>" +
        "</div>";

      const instructionsBlock = instrRaw
        ? "<div class='text-wrap'>" + linkifyText(instrRaw) + "</div>"
        : "<span class='muted'>—</span>";

      const notesBlock = notesRaw
        ? "<div class='text-wrap'>" + linkifyText(notesRaw) + "</div>"
        : "<span class='muted'>—</span>";

      return "<tr>" +
        "<td><div><b>" + esc(j.id) + "</b></div><div class='pill'>" + esc(j.status) + "</div></td>" +
        "<td>" + esc(j.printer_id) + "</td>" +
        "<td>" + esc(j.paper_size || "") + " / " + esc(j.color_mode || "") + "<br/><span class='muted'>" + svc + "</span></td>" +
        "<td>" + esc(j.copies || "") + " / " + esc(j.pages || "") + "<br/><span class='muted'>₦/$ " + esc(j.total_cost ?? "") + "</span></td>" +
        "<td>" + file + "<br/><span class='muted'>" + esc(j.original_name || "") + "</span></td>" +
        "<td>" + (who || "<span class='muted'>—</span>") + "<br/><span class='muted'>" + (loc || "") + "</span></td>" +
        "<td style='min-width:320px;max-width:420px'>" +
          "<div class='mini'>Instructions / Laminating Note</div>" +
          instructionsBlock +
          "<div class='mini' style='margin-top:8px'>Notes / Extra Links</div>" +
          notesBlock +
        "</td>" +
        "<td style='min-width:360px'>" + routeSel + "<br/>" + actions + "</td>" +
      "</tr>";
    }).join("");

    tableEl.innerHTML =
      "<table>" +
      "<thead><tr>" +
      "<th>ID/Status</th><th>Queue/Printer</th><th>Mode</th><th>Copies/Pages</th><th>File / Video</th><th>Customer</th><th>Instructions / Notes</th><th>Actions</th>" +
      "</tr></thead>" +
      "<tbody>" + rows + "</tbody></table>";

    document.querySelectorAll("[data-move]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-move");
        const sel = document.querySelector("[data-route='" + CSS.escape(id) + "']");
        const to = sel ? sel.value : "";
        if(!to) return;

        loadStateEl.textContent = "Routing...";
        try {
          await apiPost("/api/dashboard/jobs/" + encodeURIComponent(id) + "/route", { to_printer_id: to });
          await load();
        } catch(e) {
          errorEl.textContent = String(e.message || e);
        } finally {
          loadStateEl.textContent = "Idle";
        }
      });
    });

    document.querySelectorAll("[data-done]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-done");
        loadStateEl.textContent = "Marking done...";
        try {
          await apiPost("/api/dashboard/jobs/" + encodeURIComponent(id) + "/mark", { status: "done" });
          await load();
        } catch(e) {
          errorEl.textContent = String(e.message || e);
        } finally {
          loadStateEl.textContent = "Idle";
        }
      });
    });

    document.querySelectorAll("[data-err]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-err");
        const msg = prompt("Error message (optional):", "");
        loadStateEl.textContent = "Marking error...";
        try {
          await apiPost("/api/dashboard/jobs/" + encodeURIComponent(id) + "/mark", {
            status: "error",
            error_message: msg || ""
          });
          await load();
        } catch(e) {
          errorEl.textContent = String(e.message || e);
        } finally {
          loadStateEl.textContent = "Idle";
        }
      });
    });

    document.querySelectorAll("[data-del]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-del");
        if(!confirm("Delete job #" + id + " ?")) return;

        loadStateEl.textContent = "Deleting...";
        try {
          await apiPost("/api/dashboard/jobs/" + encodeURIComponent(id) + "/delete", {});
          await load();
        } catch(e) {
          errorEl.textContent = String(e.message || e);
        } finally {
          loadStateEl.textContent = "Idle";
        }
      });
    });
  }

  async function load(){
    errorEl.textContent = "";

    if(!DASH_KEY){
      errorEl.textContent = "Missing dashboard key. Open: /dashboard?key=YOUR_KEY";
      tableEl.innerHTML = "";
      return;
    }

    loadStateEl.textContent = "Loading...";

    const printer_id = printerEl.value;
    const limit = Number(limitEl.value || 50);
    const status = statusEl.value;
    const q = qEl.value || "";

    const url =
      "/api/dashboard/jobs?printer_id=" + encodeURIComponent(printer_id) +
      "&limit=" + encodeURIComponent(limit) +
      (status ? "&status=" + encodeURIComponent(status) : "") +
      (q ? "&q=" + encodeURIComponent(q) : "");

    try {
      const r = await fetch(apiUrl(url), {
        headers: { "x-dashboard-key": DASH_KEY }
      });

      const data = await r.json().catch(() => ({}));
      if(!r.ok) throw new Error("HTTP " + r.status + ": " + JSON.stringify(data));

      renderJobs(data.jobs || []);
      loadStateEl.textContent = "Idle";
    } catch(e) {
      loadStateEl.textContent = "Idle";
      errorEl.textContent = String(e.message || e);
      tableEl.innerHTML = "";
    }
  }

  function setAuto(on){
    if(timer) clearInterval(timer);
    timer = null;
    if(on) timer = setInterval(load, 4000);
  }

  refreshBtn.addEventListener("click", load);
  printerEl.addEventListener("change", load);
  statusEl.addEventListener("change", load);
  qEl.addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
  autoEl.addEventListener("change", () => setAuto(autoEl.checked));

  load();
</script>
</body>
</html>`;
}

app.get("/dashboard", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(
    dashboardHtml({
      initialPrinter: safeTrim(req.query.printer_id || DISPATCH_QUEUE_ID),
    })
  );
});

app.get("/worker", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(dashboardHtml({ initialPrinter: DISPATCH_QUEUE_ID }));
});

app.get("/agent", (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(dashboardHtml({ initialPrinter: AGENT_QUEUE_ID }));
});

/* ---------------- SERVICES LIST ---------------- */
app.get("/api/services", (req, res) => {
  res.json({
    ok: true,
    services: [
      "Document Printing",
      "Photo Printing",
      "A3 Printing",
      "A4 Printing",
      "Black & White Printing",
      "Color Printing",
      "Card Printing",
      "Large Format Printing",
      "Editing Services",
      "Image Editing",
      "Video Editing",
      "Laminating",
      "ID Card Printing",
      "ID Photo",
      "Lessons / Courses",
      "Quiz",
      "Homework Submission",
      "Transcript Submission",
    ],
  });
});

/* ---------------- SMART WHATSAPP SESSION STATE ---------------- */
global.processedWhatsAppMessageIds =
  global.processedWhatsAppMessageIds || new Map();

global.whatsAppSessions =
  global.whatsAppSessions || new Map();

function getWhatsAppSession(from) {
  const existing = global.whatsAppSessions.get(from) || {
    state: "idle",
    data: {},
    lastFile: null,
    updatedAt: Date.now(),
  };
  existing.updatedAt = Date.now();
  global.whatsAppSessions.set(from, existing);
  return existing;
}

function setWhatsAppSession(from, patch = {}) {
  const current = getWhatsAppSession(from);
  const next = {
    ...current,
    ...patch,
    data: {
      ...(current.data || {}),
      ...(patch.data || {}),
    },
    updatedAt: Date.now(),
  };
  global.whatsAppSessions.set(from, next);
  return next;
}

function resetWhatsAppSession(from) {
  global.whatsAppSessions.set(from, {
    state: "idle",
    data: {},
    lastFile: null,
    updatedAt: Date.now(),
  });
}

function cleanupWhatsAppSessions() {
  const TTL = 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [key, session] of global.whatsAppSessions.entries()) {
    if (now - Number(session?.updatedAt || 0) > TTL) {
      global.whatsAppSessions.delete(key);
    }
  }
}

function getFileExtFromMimeOrName(mime, filename, fallback = "bin") {
  const nameExt = path.extname(String(filename || "")).replace(".", "").toLowerCase();
  if (nameExt) return nameExt;

  const m = String(mime || "").toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("word")) return "docx";
  if (m.includes("document")) return "docx";
  if (m.includes("jpeg")) return "jpg";
  if (m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("quicktime")) return "mov";
  return fallback;
}

function isGreetingText(text) {
  const t = safeTrim(text).toLowerCase();
  return ["hi", "hello", "hey", "hallo", "menu", "start"].includes(t);
}

function isBackCommand(text) {
  const t = safeTrim(text).toLowerCase();
  return t === "0" || t === "back" || t === "menu" || t === "main menu";
}

function looksLikeAfricaPaymentProof(text) {
  const t = safeTrim(text).toLowerCase();
  return Boolean(t);
}

function getMainMenuText() {
  return (
    "Hello 👋 Welcome to PATAPATA MSTAF\n\n" +
    "I can help you with printing, laminating, ID photo, editing, lessons, quizzes, homework, transcripts, and payments.\n\n" +
    "Reply with a number:\n\n" +
    "1 - Print Documents / Images\n" +
    "2 - Laminating\n" +
    "3 - ID Photo\n" +
    "4 - Image Editing\n" +
    "5 - Video Editing\n" +
    "6 - Lessons / Courses\n" +
    "7 - Prices\n" +
    "8 - Talk to Agent\n" +
    "9 - Africa Local Payment Option\n\n" +
    "You can also send your PDF, image, document, video, transcript, or homework here directly.\n\n" +
    "For T-Shirt, Mug, or Towel design printing, please contact the Agent with your instructions for pricing."
  );
}

function getFileServiceMenuText() {
  return (
    "✅ File received successfully.\n\n" +
    "What would you like to do with this file?\n\n" +
    "Reply with a number:\n\n" +
    "1 - Print\n" +
    "2 - Laminate\n" +
    "3 - ID Photo\n" +
    "4 - Image Editing\n" +
    "5 - Video Editing\n" +
    "6 - Lesson / Homework / Transcript\n" +
    "7 - Talk to Agent\n" +
    "9 - Africa Local Payment Option"
  );
}

function getLessonMenuText() {
  return (
    "📘 LESSON / COURSE MENU\n\n" +
    "Reply with a number:\n\n" +
    "1 - Get Lesson Video\n" +
    "2 - Get Quiz\n" +
    "3 - Get Quiz Answers\n" +
    "4 - Submit Homework\n" +
    "5 - Submit Transcript / Assignment\n" +
    "6 - Talk to Course Support\n" +
    "7 - Back to Main Menu"
  );
}

function getLessonPaymentText() {
  return (
    "💳 Lesson access requires payment.\n\n" +
    "Reply:\n" +
    "1 - Pay with Shopify\n" +
    "2 - Africa Local Payment\n" +
    "3 - Talk to Agent"
  );
}

function getShopifyPaymentText() {
  return (
    "✅ Order Confirmed\n\n" +
    "Please complete payment here:\n" +
    `${SHOPIFY_CHECKOUT_LINK}\n\n` +
    "After payment, your request will be processed immediately."
  );
}

function getAfricaPaymentText() {
  return (
    "🌍 Africa Local Payment Selected\n\n" +
    "Please complete your payment here:\n" +
    `${AFRICA_PAYMENT_PORTAL}\n\n` +
    "After payment, reply with your payment reference or proof of payment."
  );
}

function getPricesText() {
  return (
    "💵 PATAPATA MSTAF Prices\n\n" +
    "Printing:\n" +
    "• A4 Black & White — $0.25/page\n" +
    "• A4 Color — $0.50/page\n\n" +
    "Laminating:\n" +
    "• Letter — $1.50\n" +
    "• Legal — $2.00\n" +
    "• Tabloid — $3.00\n\n" +
    "Custom Merchandise:\n" +
    "• T-Shirt design printing — Contact Agent for pricing\n" +
    "• Mug design printing — Contact Agent for pricing\n" +
    "• Towel design printing — Contact Agent for pricing\n\n" +
    "For ID Photo, Image Editing, Video Editing, Lessons, Homework, Transcript, T-Shirt, Mug, or Towel design printing, contact Agent with your instructions for pricing."
  );
}

function buildAgentPromptText() {
  return (
    "👨‍💼 Talk to Agent selected.\n\n" +
    "Please send your message now and an agent will assist you.\n\n" +
    "For T-Shirt, Mug, or Towel design printing, include:\n" +
    "• Item type\n" +
    "• Quantity\n" +
    "• Design details\n" +
    "• Print side(s)\n" +
    "• Deadline\n\n" +
    "We will review it and give you pricing."
  );
}

function getTextFromMessage(message) {
  if (!message) return "";
  if (message.type === "text") return safeTrim(message.text?.body || "");
  if (message.button?.text) return safeTrim(message.button.text);
  if (message.interactive?.button_reply?.title) {
    return safeTrim(message.interactive.button_reply.title);
  }
  if (message.interactive?.list_reply?.title) {
    return safeTrim(message.interactive.list_reply.title);
  }
  return "";
}

async function notifyAgentRequest({
  from,
  category,
  text,
  session,
}) {
  const notes = [
    `WhatsApp sender: ${from}`,
    `Agent Category: ${category || "GENERAL"}`,
    text ? `Message: ${text}` : "",
    session?.lastFile?.fileUrl ? `Attached File: ${session.lastFile.fileUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const instructions = [
    `Agent support request from WhatsApp`,
    category ? `Category: ${category}` : "",
    session?.lastFile?.filename ? `Original File: ${session.lastFile.filename}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const pseudoFile = session?.lastFile || {
    filename: "agent_request.txt",
    fileUrl: "",
  };

  try {
    await pool.query(
      `
      INSERT INTO print_jobs
        (
          status,
          printer_id,
          file_url,
          original_name,
          paper_size,
          color_mode,
          copies,
          pages,
          total_cost,
          customer_name,
          customer_email,
          country,
          city,
          notes,
          instructions,
          service_type
        )
      VALUES
        (
          'pending',
          $1, $2, $3, 'A4', 'COLOR', 1, 1, 0,
          $4, '', '', '', $5, $6, 'EDITING'
        )
      `,
      [
        AGENT_QUEUE_ID,
        pseudoFile.fileUrl || "",
        pseudoFile.filename || "agent_request.txt",
        `WhatsApp ${from}`,
        notes,
        instructions,
      ]
    );
  } catch (error) {
    console.error("notifyAgentRequest insert error:", error.message);
  }

  return "✅ Your message has been sent to an agent. We will reply soon.";
}

async function createWhatsAppServiceJob({
  from,
  serviceType,
  session,
  detailsText = "",
}) {
  const lastFile = session?.lastFile;
  if (!lastFile?.fileUrl) {
    throw new Error("No uploaded file found in session");
  }

  let paperSize = "A4";
  let colorMode = "BW";
  let copies = 1;
  let pages = 1;

  if (serviceType === "IMAGE_EDITING" || serviceType === "VIDEO_EDITING" || serviceType === "ID_PHOTO") {
    colorMode = "COLOR";
  }

  if (serviceType === "LAMINATING" || serviceType === "ID_PHOTO") {
    paperSize = "A4";
  }

  const notes = [
    `WhatsApp sender: ${from}`,
    session?.data?.paymentChoice ? `Payment Choice: ${session.data.paymentChoice}` : "",
    session?.data?.customerMessage ? `Customer Message: ${session.data.customerMessage}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const instructions = [
    `WhatsApp ${serviceType} request`,
    detailsText || "",
  ]
    .filter(Boolean)
    .join("\n");

  const job = await createWhatsAppJob({
    from,
    service_type: serviceType,
    savedFile: lastFile,
    original_name: lastFile.filename || "whatsapp_file",
    paper_size: paperSize,
    color_mode: colorMode,
    copies,
    pages,
    instructions,
    notes,
  });

  return job;
}

async function handleLessonGateOrContinue(from, nextStateAfterPayment, payload) {
  if (LESSON_ACCESS_MODE === "paid_access") {
    setWhatsAppSession(from, {
      state: "await_lesson_payment_choice",
      data: {
        nextStateAfterPayment,
        lessonPayload: payload || {},
      },
    });
    await sendWhatsAppText(from, getLessonPaymentText());
    return true;
  }
  return false;
}

async function completeLessonAction(from, actionKey, payload = {}, session) {
  const textBits = [];

  if (actionKey === "lesson_video") {
    textBits.push("🎬 Lesson video request received.");
  } else if (actionKey === "quiz") {
    textBits.push("📝 Quiz request received.");
  } else if (actionKey === "quiz_answers") {
    textBits.push("✅ Quiz answers request received.");
  }

  if (payload?.details) {
    textBits.push("");
    textBits.push(payload.details);
  }

  try {
    await pool.query(
      `
      INSERT INTO print_jobs
        (
          status,
          printer_id,
          file_url,
          original_name,
          paper_size,
          color_mode,
          copies,
          pages,
          total_cost,
          customer_name,
          customer_email,
          country,
          city,
          notes,
          instructions,
          service_type
        )
      VALUES
        (
          'pending',
          $1, '', $2, 'A4', 'COLOR', 1, 1, 0,
          $3, '', '', '', $4, $5, $6
        )
      `,
      [
        AGENT_QUEUE_ID,
        `${actionKey}.txt`,
        `WhatsApp ${from}`,
        `WhatsApp sender: ${from}`,
        payload?.details || "",
        actionKey === "lesson_video" ? "LESSON" : "QUIZ",
      ]
    );
  } catch (error) {
    console.error("completeLessonAction insert error:", error.message);
  }

  resetWhatsAppSession(from);
  await sendWhatsAppText(from, textBits.join("\n"));
}

async function handleHomeworkOrTranscriptSubmission(from, typeLabel, detailsText, session) {
  if (!session?.lastFile?.fileUrl) {
    resetWhatsAppSession(from);
    await sendWhatsAppText(from, "No file was found for this submission. Please send the file again.");
    return;
  }

  const serviceType = typeLabel === "HOMEWORK" ? "HOMEWORK" : "TRANSCRIPT";

  try {
    const job = await createWhatsAppJob({
      from,
      service_type: serviceType,
      savedFile: session.lastFile,
      original_name: session.lastFile.filename || `${serviceType.toLowerCase()}.bin`,
      paper_size: "A4",
      color_mode: "COLOR",
      copies: 1,
      pages: 1,
      instructions: `${typeLabel} submission\n${detailsText || ""}`.trim(),
      notes: `WhatsApp sender: ${from}`,
    });

    resetWhatsAppSession(from);
    await sendWhatsAppText(
      from,
      `✅ ${typeLabel === "HOMEWORK" ? "Homework" : "Transcript / assignment"} submitted successfully.\n\nSubmission Job #${job.id} has been added to our system.`
    );
  } catch (error) {
    console.error("handleHomeworkOrTranscriptSubmission error:", error.message);
    resetWhatsAppSession(from);
    await sendWhatsAppText(
      from,
      `Your ${typeLabel === "HOMEWORK" ? "homework" : "transcript / assignment"} was received, but there was an issue saving it. Please contact Agent.`
    );
  }
}

async function handleMainMenuChoice(from, choice) {
  switch (choice) {
    case "1":
      setWhatsAppSession(from, { state: "await_print_details" });
      await sendWhatsAppText(
        from,
        "🖨️ Print selected.\n\nPlease reply with your print details in one message:\n• Paper size (A4, Letter, A3)\n• Color or B&W\n• Copies\n• Pages\n• Delivery or pickup\n\nExample:\nA4, Color, 2 copies, 5 pages, pickup"
      );
      return;

    case "2":
      setWhatsAppSession(from, { state: "await_laminate_details" });
      await sendWhatsAppText(
        from,
        "📎 Laminating selected.\n\nPlease reply with:\n• Size (Letter, Legal, Tabloid)\n• Quantity\n• Pickup or delivery"
      );
      return;

    case "3":
      setWhatsAppSession(from, { state: "await_id_details" });
      await sendWhatsAppText(
        from,
        "🪪 ID Photo selected.\n\nPlease send or reply with:\n• Country or ID type\n• Background color needed\n• Passport style or custom size"
      );
      return;

    case "4":
      setWhatsAppSession(from, { state: "await_image_edit_details" });
      await sendWhatsAppText(
        from,
        "🖼️ Image Editing selected.\n\nPlease describe what you want:\n• Background removal\n• Retouch\n• Resize\n• Product photo edit\n• Custom design"
      );
      return;

    case "5":
      setWhatsAppSession(from, { state: "await_video_edit_details" });
      await sendWhatsAppText(
        from,
        "🎬 Video Editing selected.\n\nPlease describe:\n• Type of video\n• What edit you want\n• Duration\n• Platform (TikTok, Instagram, YouTube, etc.)"
      );
      return;

    case "6":
      setWhatsAppSession(from, { state: "await_lesson_menu" });
      await sendWhatsAppText(from, getLessonMenuText());
      return;

    case "7":
      resetWhatsAppSession(from);
      await sendWhatsAppText(from, getPricesText());
      return;

    case "8":
      setWhatsAppSession(from, { state: "await_agent_message" });
      await sendWhatsAppText(from, buildAgentPromptText());
      return;

    case "9":
      setWhatsAppSession(from, { state: "await_africa_payment_choice" });
      await sendWhatsAppText(from, getAfricaPaymentText());
      return;

    default:
      resetWhatsAppSession(from);
      await sendWhatsAppText(from, getMainMenuText());
  }
}

async function handleFileServiceChoice(from, choice, session) {
  switch (choice) {
    case "1":
      setWhatsAppSession(from, { state: "await_print_details" });
      await sendWhatsAppText(
        from,
        "🖨️ Print selected for your file.\n\nPlease reply with:\n• Paper size\n• Color or B&W\n• Copies\n• Pages\n• Pickup or delivery"
      );
      return;

    case "2":
      setWhatsAppSession(from, { state: "await_laminate_details" });
      await sendWhatsAppText(
        from,
        "📎 Laminate selected for your file.\n\nPlease reply with:\n• Size\n• Quantity\n• Pickup or delivery"
      );
      return;

    case "3":
      setWhatsAppSession(from, { state: "await_id_details" });
      await sendWhatsAppText(
        from,
        "🪪 ID Photo selected.\n\nPlease reply with the ID/photo requirement details."
      );
      return;

    case "4":
      setWhatsAppSession(from, { state: "await_image_edit_details" });
      await sendWhatsAppText(
        from,
        "🖼️ Image Editing selected.\n\nPlease describe the image edit you want."
      );
      return;

    case "5":
      setWhatsAppSession(from, { state: "await_video_edit_details" });
      await sendWhatsAppText(
        from,
        "🎬 Video Editing selected.\n\nPlease describe the video edit you want."
      );
      return;

    case "6":
      setWhatsAppSession(from, { state: "await_lesson_menu" });
      await sendWhatsAppText(from, getLessonMenuText());
      return;

    case "7":
      setWhatsAppSession(from, { state: "await_agent_message" });
      await sendWhatsAppText(from, buildAgentPromptText());
      return;

    case "9":
      setWhatsAppSession(from, { state: "await_africa_payment_choice" });
      await sendWhatsAppText(from, getAfricaPaymentText());
      return;

    default:
      await sendWhatsAppText(from, getFileServiceMenuText());
      return;
  }
}

async function handleLessonMenuChoice(from, choice) {
  switch (choice) {
    case "1":
      setWhatsAppSession(from, { state: "await_lesson_video_details" });
      await sendWhatsAppText(
        from,
        "🎬 Get Lesson Video selected.\n\nPlease reply with:\n• Course name\n• Lesson title or week\n• Student name"
      );
      return;

    case "2":
      setWhatsAppSession(from, { state: "await_quiz_details" });
      await sendWhatsAppText(
        from,
        "📝 Get Quiz selected.\n\nPlease reply with:\n• Course name\n• Quiz title or week\n• Student name"
      );
      return;

    case "3":
      setWhatsAppSession(from, { state: "await_quiz_answers_details" });
      await sendWhatsAppText(
        from,
        "✅ Get Quiz Answers selected.\n\nPlease reply with:\n• Course name\n• Quiz title or week\n• Student name"
      );
      return;

    case "4":
      setWhatsAppSession(from, { state: "await_homework_file" });
      await sendWhatsAppText(
        from,
        "📤 Submit Homework selected.\n\nPlease send your homework file now."
      );
      return;

    case "5":
      setWhatsAppSession(from, { state: "await_transcript_file" });
      await sendWhatsAppText(
        from,
        "📄 Submit Transcript / Assignment selected.\n\nPlease send your transcript or assignment file now."
      );
      return;

    case "6":
      setWhatsAppSession(from, { state: "await_course_support_message" });
      await sendWhatsAppText(
        from,
        "🎓 Course Support selected.\n\nPlease send your support message now."
      );
      return;

    case "7":
      resetWhatsAppSession(from);
      await sendWhatsAppText(from, getMainMenuText());
      return;

    default:
      await sendWhatsAppText(from, getLessonMenuText());
      return;
  }
}

async function handleServiceConfirmState(from, text, session, serviceType, successLabel) {
  if (text === "1") {
    try {
      const detailsFieldMap = {
        PRINT: "printDetails",
        LAMINATING: "laminateDetails",
        ID_PHOTO: "idDetails",
        IMAGE_EDITING: "imageEditDetails",
        VIDEO_EDITING: "videoEditDetails",
      };

      const detailsText = safeTrim(session?.data?.[detailsFieldMap[serviceType]] || "");

      if (session?.lastFile?.fileUrl) {
        const job = await createWhatsAppServiceJob({
          from,
          serviceType,
          session,
          detailsText,
        });

        resetWhatsAppSession(from);
        await sendWhatsAppText(
          from,
          `✅ ${successLabel} request confirmed.\n\nJob #${job.id} has been added to our system.`
        );
        return;
      }

      if (serviceType === "PRINT" || serviceType === "LAMINATING" || serviceType === "ID_PHOTO") {
        resetWhatsAppSession(from);
        await sendWhatsAppText(
          from,
          `✅ ${successLabel} details received.\n\nPlease send your file now so we can continue.`
        );
        return;
      }

      resetWhatsAppSession(from);
      await sendWhatsAppText(
        from,
        `✅ ${successLabel} request confirmed.\n\nPlease send the related file now if needed, or contact Agent for help.`
      );
      return;
    } catch (error) {
      console.error("handleServiceConfirmState error:", error.message);
      resetWhatsAppSession(from);
      await sendWhatsAppText(from, "There was an issue creating your request. Please try again or contact Agent.");
      return;
    }
  }

  if (text === "2") {
    setWhatsAppSession(from, {
      data: {
        paymentChoice: "SHOPIFY",
      },
    });
    resetWhatsAppSession(from);
    await sendWhatsAppText(from, getShopifyPaymentText());
    return;
  }

  if (text === "3") {
    setWhatsAppSession(from, {
      state: "await_africa_payment_choice",
      data: {
        paymentChoice: "AFRICA_LOCAL_PAYMENT",
      },
      lastFile: session?.lastFile || null,
    });
    await sendWhatsAppText(from, getAfricaPaymentText());
    return;
  }

  if (text === "4") {
    setWhatsAppSession(from, {
      state: "await_agent_message",
      lastFile: session?.lastFile || null,
      data: {
        ...session?.data,
      },
    });
    await sendWhatsAppText(from, buildAgentPromptText());
    return;
  }

  if (text === "5") {
    resetWhatsAppSession(from);
    await sendWhatsAppText(from, getMainMenuText());
    return;
  }

  await sendWhatsAppText(from, "Reply with 1, 2, 3, 4, or 5.");
}

async function handleIncomingText(from, textRaw) {
  cleanupWhatsAppSessions();

  const text = safeTrim(textRaw);
  const session = getWhatsAppSession(from);

  if (!text) {
    await sendWhatsAppText(from, getMainMenuText());
    return;
  }

  if (isBackCommand(text)) {
    resetWhatsAppSession(from);
    await sendWhatsAppText(from, getMainMenuText());
    return;
  }

  if (isGreetingText(text) && (!session.state || session.state === "idle")) {
    resetWhatsAppSession(from);
    await sendWhatsAppText(from, getMainMenuText());
    return;
  }

  switch (session.state) {
    case "idle":
      await handleMainMenuChoice(from, text);
      return;

    case "await_service_choice":
      await handleFileServiceChoice(from, text, session);
      return;

    case "await_print_details":
      setWhatsAppSession(from, {
        state: "await_print_confirm",
        data: { printDetails: text },
      });
      await sendWhatsAppText(
        from,
        `✅ Print details received:\n\n${text}\n\nReply:\n1 - Confirm\n2 - Shopify Payment\n3 - Africa Local Payment\n4 - Talk to Agent\n5 - Cancel`
      );
      return;

    case "await_print_confirm":
      await handleServiceConfirmState(from, text, session, "PRINT", "Print");
      return;

    case "await_laminate_details":
      setWhatsAppSession(from, {
        state: "await_laminate_confirm",
        data: { laminateDetails: text },
      });
      await sendWhatsAppText(
        from,
        `✅ Laminating details received:\n\n${text}\n\nReply:\n1 - Confirm\n2 - Shopify Payment\n3 - Africa Local Payment\n4 - Talk to Agent\n5 - Cancel`
      );
      return;

    case "await_laminate_confirm":
      await handleServiceConfirmState(from, text, session, "LAMINATING", "Laminating");
      return;

    case "await_id_details":
      setWhatsAppSession(from, {
        state: "await_id_confirm",
        data: { idDetails: text },
      });
      await sendWhatsAppText(
        from,
        `✅ ID Photo details received:\n\n${text}\n\nReply:\n1 - Confirm\n2 - Shopify Payment\n3 - Africa Local Payment\n4 - Talk to Agent\n5 - Cancel`
      );
      return;

    case "await_id_confirm":
      await handleServiceConfirmState(from, text, session, "ID_PHOTO", "ID Photo");
      return;

    case "await_image_edit_details":
      setWhatsAppSession(from, {
        state: "await_image_edit_confirm",
        data: { imageEditDetails: text },
      });
      await sendWhatsAppText(
        from,
        `✅ Image editing details received:\n\n${text}\n\nReply:\n1 - Confirm\n2 - Shopify Payment\n3 - Africa Local Payment\n4 - Talk to Agent\n5 - Cancel`
      );
      return;

    case "await_image_edit_confirm":
      await handleServiceConfirmState(from, text, session, "IMAGE_EDITING", "Image editing");
      return;

    case "await_video_edit_details":
      setWhatsAppSession(from, {
        state: "await_video_edit_confirm",
        data: { videoEditDetails: text },
      });
      await sendWhatsAppText(
        from,
        `✅ Video editing details received:\n\n${text}\n\nReply:\n1 - Confirm\n2 - Shopify Payment\n3 - Africa Local Payment\n4 - Talk to Agent\n5 - Cancel`
      );
      return;

    case "await_video_edit_confirm":
      await handleServiceConfirmState(from, text, session, "VIDEO_EDITING", "Video editing");
      return;

    case "await_lesson_menu":
      await handleLessonMenuChoice(from, text);
      return;

    case "await_lesson_video_details": {
      const gated = await handleLessonGateOrContinue(from, "lesson_video", { details: text });
      if (gated) return;
      await completeLessonAction(from, "lesson_video", { details: text }, session);
      return;
    }

    case "await_quiz_details": {
      const gated = await handleLessonGateOrContinue(from, "quiz", { details: text });
      if (gated) return;
      await completeLessonAction(from, "quiz", { details: text }, session);
      return;
    }

    case "await_quiz_answers_details": {
      const gated = await handleLessonGateOrContinue(from, "quiz_answers", { details: text });
      if (gated) return;
      await completeLessonAction(from, "quiz_answers", { details: text }, session);
      return;
    }

    case "await_homework_details":
      await handleHomeworkOrTranscriptSubmission(from, "HOMEWORK", text, session);
      return;

    case "await_transcript_details":
      await handleHomeworkOrTranscriptSubmission(from, "TRANSCRIPT", text, session);
      return;

    case "await_course_support_message": {
      const responseText = await notifyAgentRequest({
        from,
        category: "COURSE_SUPPORT",
        text,
        session,
      });
      resetWhatsAppSession(from);
      await sendWhatsAppText(from, responseText);
      return;
    }

    case "await_agent_message": {
      const responseText = await notifyAgentRequest({
        from,
        category: "AGENT_SUPPORT",
        text,
        session,
      });
      resetWhatsAppSession(from);
      await sendWhatsAppText(from, responseText);
      return;
    }

    case "await_africa_payment_choice":
      if (looksLikeAfricaPaymentProof(text)) {
        try {
          const responseText = await notifyAgentRequest({
            from,
            category: "AFRICA_PAYMENT_PROOF",
            text: `Payment proof/reference: ${text}`,
            session,
          });
          resetWhatsAppSession(from);
          await sendWhatsAppText(
            from,
            `✅ Africa payment update received.\n\n${responseText}`
          );
          return;
        } catch (error) {
          console.error("await_africa_payment_choice error:", error.message);
          resetWhatsAppSession(from);
          await sendWhatsAppText(
            from,
            "Your payment reference was received, but there was an issue forwarding it. Please contact Agent."
          );
          return;
        }
      }
      await sendWhatsAppText(from, getAfricaPaymentText());
      return;

    case "await_lesson_payment_choice":
      if (text === "1") {
        resetWhatsAppSession(from);
        await sendWhatsAppText(from, getShopifyPaymentText());
        return;
      }
      if (text === "2") {
        setWhatsAppSession(from, {
          state: "await_africa_payment_choice",
          data: {
            paymentChoice: "AFRICA_LOCAL_PAYMENT",
          },
        });
        await sendWhatsAppText(from, getAfricaPaymentText());
        return;
      }
      if (text === "3") {
        setWhatsAppSession(from, {
          state: "await_agent_message",
        });
        await sendWhatsAppText(from, buildAgentPromptText());
        return;
      }
      await sendWhatsAppText(from, getLessonPaymentText());
      return;

    default:
      resetWhatsAppSession(from);
      await sendWhatsAppText(from, getMainMenuText());
      return;
  }
}

async function handleIncomingWhatsAppFile(from, fileInfo, currentState) {
  cleanupWhatsAppSessions();

  if (!fileInfo?.fileUrl) {
    await sendWhatsAppText(from, "The file was received, but there was an issue saving it. Please resend.");
    return;
  }

  if (currentState === "await_homework_file") {
    setWhatsAppSession(from, {
      state: "await_homework_details",
      lastFile: fileInfo,
    });
    await sendWhatsAppText(
      from,
      "✅ Homework file received successfully.\n\nPlease reply with:\n• Course name\n• Student name\n• Week or lesson\n• Any note for the instructor"
    );
    return;
  }

  if (currentState === "await_transcript_file") {
    setWhatsAppSession(from, {
      state: "await_transcript_details",
      lastFile: fileInfo,
    });
    await sendWhatsAppText(
      from,
      "✅ Transcript / assignment file received successfully.\n\nPlease reply with:\n• Course name\n• Student name\n• What this file is for\n• Any extra note"
    );
    return;
  }

  setWhatsAppSession(from, {
    state: "await_service_choice",
    lastFile: fileInfo,
  });

  await sendWhatsAppText(from, getFileServiceMenuText());
}

/* ---------------- WhatsApp / Meta Webhook ---------------- */
app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verified successfully");
      return res.status(200).send(challenge);
    }

    console.log("❌ Webhook verification failed");
    return res.sendStatus(403);
  } catch (error) {
    console.error("GET /webhook error:", error?.message || error);
    return res.sendStatus(500);
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    console.log("📩 Incoming webhook:", JSON.stringify(req.body, null, 2));

    if (!value) return res.sendStatus(200);

    if (value.statuses) {
      console.log("🚫 Ignoring status event");
      return res.sendStatus(200);
    }

    if (!value.messages || value.messages.length === 0) {
      console.log("🚫 No incoming messages");
      return res.sendStatus(200);
    }

    const message = value.messages[0];
    const from = String(message.from || "").trim();
    const displayPhone = String(value.metadata?.display_phone_number || "").replace(/\D/g, "");
    const messageId = String(message.id || "").trim();

    if (!from) {
      console.log("🚫 Missing sender");
      return res.sendStatus(200);
    }

    if (displayPhone && from === displayPhone) {
      console.log("🚫 Ignoring self-message");
      return res.sendStatus(200);
    }

    const DEDUP_TTL = 10 * 60 * 1000;

    for (const [key, ts] of global.processedWhatsAppMessageIds.entries()) {
      if (Date.now() - ts > DEDUP_TTL) {
        global.processedWhatsAppMessageIds.delete(key);
      }
    }

    if (messageId && global.processedWhatsAppMessageIds.has(messageId)) {
      console.log("Duplicate message ignored:", messageId);
      return res.sendStatus(200);
    }

    if (messageId) {
      global.processedWhatsAppMessageIds.set(messageId, Date.now());
    }

    console.log("Processing message from:", from, "type:", message.type);

    const session = getWhatsAppSession(from);

    if (message.type === "text") {
      const text = getTextFromMessage(message);
      await handleIncomingText(from, text);
      return res.sendStatus(200);
    }

    if (message.type === "image") {
      const mediaId = message.image?.id;
      const mimeType = message.image?.mime_type || "image/jpeg";
      const ext = getFileExtFromMimeOrName(mimeType, "image", "jpg");

      if (!mediaId) {
        await sendWhatsAppText(from, "Image received, but media ID was missing.");
        return res.sendStatus(200);
      }

      const fileBuffer = await downloadWhatsAppMedia(mediaId);
      const saved = saveWhatsAppFile(fileBuffer, ext);

      const fileInfo = {
        kind: "image",
        filename: saved.filename,
        originalName: "image",
        mimeType,
        mediaId,
        filePath: saved.filePath,
        fileUrl: saved.fileUrl,
      };

      console.log("Image saved:", saved.filePath);
      await handleIncomingWhatsAppFile(from, fileInfo, session.state);
      return res.sendStatus(200);
    }

    if (message.type === "document") {
      const mediaId = message.document?.id;
      const fileName = safeTrim(message.document?.filename || "");
      const mimeType = message.document?.mime_type || "";
      const ext = getFileExtFromMimeOrName(mimeType, fileName, "pdf");

      if (!mediaId) {
        await sendWhatsAppText(from, "Document received, but media ID was missing.");
        return res.sendStatus(200);
      }

      const fileBuffer = await downloadWhatsAppMedia(mediaId);
      const saved = saveWhatsAppFile(fileBuffer, ext);

      const fileInfo = {
        kind: "document",
        filename: fileName || saved.filename,
        originalName: fileName || saved.filename,
        mimeType,
        mediaId,
        filePath: saved.filePath,
        fileUrl: saved.fileUrl,
      };

      console.log("Document saved:", saved.filePath);
      await handleIncomingWhatsAppFile(from, fileInfo, session.state);
      return res.sendStatus(200);
    }

    if (message.type === "video") {
      const mediaId = message.video?.id;
      const mimeType = message.video?.mime_type || "video/mp4";
      const ext = getFileExtFromMimeOrName(mimeType, "video", "mp4");

      if (!mediaId) {
        await sendWhatsAppText(from, "Video received, but media ID was missing.");
        return res.sendStatus(200);
      }

      const fileBuffer = await downloadWhatsAppMedia(mediaId);
      const saved = saveWhatsAppFile(fileBuffer, ext);

      const fileInfo = {
        kind: "video",
        filename: saved.filename,
        originalName: saved.filename,
        mimeType,
        mediaId,
        filePath: saved.filePath,
        fileUrl: saved.fileUrl,
      };

      console.log("Video saved:", saved.filePath);
      await handleIncomingWhatsAppFile(from, fileInfo, session.state);
      return res.sendStatus(200);
    }

    await sendWhatsAppText(
      from,
      "✅ Message received.\n\nI currently support text, PDF, Word file, image, and video uploads.\n\nReply with:\n1 - Main Menu\n8 - Talk to Agent"
    );
    return res.sendStatus(200);
  } catch (error) {
    console.error("❌ Webhook error:", formatAxiosError(error));
    return res.sendStatus(200);
  }
});

/* ---------------- START ---------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MSTAF Core listening on ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`Printers loaded: ${PRINTERS.length}`);
  console.log(
    `WhatsApp configured: phone_id=${Boolean(WHATSAPP_PHONE_NUMBER_ID)} access_token=${Boolean(WHATSAPP_ACCESS_TOKEN)}`
  );

  if (LEGACY_WHATSAPP_TOKEN) {
    console.warn(
      "⚠️ Legacy WHATSAPP_TOKEN env detected. Remove it from Render. This server uses only WHATSAPP_ACCESS_TOKEN."
    );
  }
});
