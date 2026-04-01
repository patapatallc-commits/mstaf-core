const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false"
    ? false
    : { rejectUnauthorized: false }
});
const VOICE_NOTE_HINT = "You can type or send a voice note, and we will continue from there.";
const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

const PORT = process.env.PORT || 10000;

// =========================
// PATHS / STATIC
// =========================
const UPLOAD_DIR = path.resolve(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

// =========================
// MULTER
// =========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = String(file.originalname || "file")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(-120);

    cb(null, `${Date.now()}_${Math.random().toString(16).slice(2)}_${safe}`);
  }
});
const upload = multer({ storage });

// =========================
// ENV / CONFIG
// =========================
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN ||
  process.env.VERIFY_TOKEN ||
  "";

const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "";
const WORKER_KEY = process.env.WORKER_KEY || process.env.PRINTER_KEY || "";
const PRINTER_KEY = process.env.PRINTER_KEY || process.env.WORKER_KEY || "";

const DEFAULT_PRINTER_ID = process.env.DEFAULT_PRINTER_ID || "PP-USA-001";
const A3_PRINTER_ID = process.env.A3_PRINTER_ID || "PP-USA-A3-001";
const CARD_PRINTER_ID = process.env.CARD_PRINTER_ID || "PP-USA-CARD-001";
const DISPATCH_QUEUE_ID = process.env.DISPATCH_QUEUE_ID || "DISPATCH";
const AGENT_QUEUE_ID = process.env.AGENT_QUEUE_ID || "AGENT";

const BASE_URL =
  (process.env.BASE_URL || process.env.SERVER_BASE || "").replace(/\/+$/, "") || "";

// =========================
// CONTACTS / LINKS
// =========================
const CONTACTS = {
  RIDE: process.env.RIDE_TO_WORK_CONTACTS || "+1 862 230 6637",
  MECHANIC: process.env.AUTO_MECHANIC_CONTACTS || "+1 862 230 6637",
  APARTMENT: process.env.APARTMENT_CONTACTS || "+1 862 230 6637",
  SHIPPING: process.env.SHIPPING_CONTACTS || "+1 862 230 6637"
};

const LINKS = {
  HOW_TO_UPLOAD:
    process.env.HOW_TO_UPLOAD_LINK || "https://www.patapata.us/pages/how-to-upload",
  AFRICA_PAYMENT:
    process.env.AFRICA_PAYMENT_LINK || "https://www.patapata.us/pages/africa-payment",
  WHATSAPP_BOT:
    process.env.WHATSAPP_BOT_LINK || "https://wa.me/18622306637"
};

// =========================
// SHOPIFY VARIANT IDS
// Known IDs from your setup are hardcoded.
// Unknown ones are env-driven to avoid wrong checkout.
// =========================
const SHOPIFY_VARIANTS = {
  PRINT_A4_BW: process.env.SHOPIFY_VARIANT_PRINT_A4_BW || "52221221273899",
  PRINT_A4_COLOR: process.env.SHOPIFY_VARIANT_PRINT_A4_COLOR || "52221221437739",

  PRINT_A3_BW: process.env.SHOPIFY_VARIANT_PRINT_A3_BW || "52591931719979",
  PRINT_A3_COLOR: process.env.SHOPIFY_VARIANT_PRINT_A3_COLOR || "52591931883819",
  PRINT_LETTER_BW: process.env.SHOPIFY_VARIANT_PRINT_LETTER_BW || "",
  PRINT_LETTER_COLOR: process.env.SHOPIFY_VARIANT_PRINT_LETTER_COLOR || "",
  PRINT_LEGAL_BW: process.env.SHOPIFY_VARIANT_PRINT_LEGAL_BW || "",
  PRINT_LEGAL_COLOR: process.env.SHOPIFY_VARIANT_PRINT_LEGAL_COLOR || "",
  PRINT_TABLOID_BW: process.env.SHOPIFY_VARIANT_PRINT_TABLOID_BW || "",
  PRINT_TABLOID_COLOR: process.env.SHOPIFY_VARIANT_PRINT_TABLOID_COLOR || "",

  LAMINATE_LETTER: process.env.SHOPIFY_VARIANT_LAMINATE_LETTER || "10307335749931",
  LAMINATE_LEGAL: process.env.SHOPIFY_VARIANT_LAMINATE_LEGAL || "10307335881003",
  LAMINATE_TABLOID: process.env.SHOPIFY_VARIANT_LAMINATE_TABLOID || "10307335946539",

  ID_PHOTO: process.env.SHOPIFY_VARIANT_ID_PHOTO || "10307335323947",

  IMAGE_EDIT_BASIC: process.env.SHOPIFY_VARIANT_IMAGE_EDIT_BASIC || "52581935939883",
  IMAGE_EDIT_BG: process.env.SHOPIFY_VARIANT_IMAGE_EDIT_BG || "52581935972651",
  IMAGE_EDIT_ENHANCE: process.env.SHOPIFY_VARIANT_IMAGE_EDIT_ENHANCE || "52581936005419",
  IMAGE_EDIT_ADVANCED: process.env.SHOPIFY_VARIANT_IMAGE_EDIT_ADVANCED || "52581936038187",

  VIDEO_EDIT_SHORT: process.env.SHOPIFY_VARIANT_VIDEO_EDIT_SHORT || "52582037061931",
  VIDEO_EDIT_SOCIAL: process.env.SHOPIFY_VARIANT_VIDEO_EDIT_SOCIAL || "52582037094699",
  VIDEO_EDIT_STANDARD: process.env.SHOPIFY_VARIANT_VIDEO_EDIT_STANDARD || "52582037127467",
  VIDEO_EDIT_ADVANCED: process.env.SHOPIFY_VARIANT_VIDEO_EDIT_ADVANCED || "52582037160235"
};

// =========================
// PRICING
// =========================
const PRINT_PRICING = {
  A4: { bw: 0.1, color: 0.5 },
  LETTER: { bw: 0.1, color: 0.5 },
  LEGAL: { bw: 0.12, color: 0.6 },
  A3: { bw: 1.5, color: 3.0 },
  TABLOID: { bw: 1.5, color: 3.0 }
};

const LAMINATE_PRICING = {
  LETTER: 1.5,
  LEGAL: 2.0,
  TABLOID: 3.0
};

// =========================
// PRINTER REGISTRY
// =========================
const NIGERIA_STATES = [
  { name: "ABIA", code: "AB" },
  { name: "ADAMAWA", code: "AD" },
  { name: "AKWA IBOM", code: "AK" },
  { name: "ANAMBRA", code: "AN" },
  { name: "BAUCHI", code: "BA" },
  { name: "BAYELSA", code: "BY" },
  { name: "BENUE", code: "BE" },
  { name: "BORNO", code: "BO" },
  { name: "CROSS RIVER", code: "CR" },
  { name: "DELTA", code: "DE" },
  { name: "EBONYI", code: "EB" },
  { name: "EDO", code: "ED" },
  { name: "EKITI", code: "EK" },
  { name: "ENUGU", code: "EN" },
  { name: "GOMBE", code: "GO" },
  { name: "IMO", code: "IM" },
  { name: "JIGAWA", code: "JI" },
  { name: "KADUNA", code: "KD" },
  { name: "KANO", code: "KN" },
  { name: "KATSINA", code: "KT" },
  { name: "KEBBI", code: "KE" },
  { name: "KOGI", code: "KO" },
  { name: "KWARA", code: "KW" },
  { name: "LAGOS", code: "LA" },
  { name: "NASARAWA", code: "NA" },
  { name: "NIGER", code: "NI" },
  { name: "OGUN", code: "OG" },
  { name: "ONDO", code: "ON" },
  { name: "OSUN", code: "OS" },
  { name: "OYO", code: "OY" },
  { name: "PLATEAU", code: "PL" },
  { name: "RIVERS", code: "RI" },
  { name: "SOKOTO", code: "SO" },
  { name: "TARABA", code: "TA" },
  { name: "YOBE", code: "YO" },
  { name: "ZAMFARA", code: "ZA" },
  { name: "FCT", code: "FC" }
];

function buildPrinterRegistry() {
  const registry = [
    { id: DEFAULT_PRINTER_ID, label: "USA Hub Printer", type: "A4", country: "USA" },
    { id: A3_PRINTER_ID, label: "USA A3 Printer", type: "A3", country: "USA" },
    { id: CARD_PRINTER_ID, label: "USA Card Printer", type: "CARD", country: "USA" },
    { id: DISPATCH_QUEUE_ID, label: "Dispatch Queue", type: "QUEUE", country: "SYSTEM" },
    { id: AGENT_QUEUE_ID, label: "Agent Queue", type: "QUEUE", country: "SYSTEM" }
  ];

  for (const state of NIGERIA_STATES) {
    registry.push({
      id: `PP-NG-${state.code}-A4-001`,
      label: `${state.name} A4 Printer`,
      type: "A4",
      country: "NIGERIA",
      state: state.name
    });
    registry.push({
      id: `PP-NG-${state.code}-SP-001`,
      label: `${state.name} Special Printer`,
      type: "SPECIAL",
      country: "NIGERIA",
      state: state.name
    });
  }

  return registry;
}

const PRINTERS = buildPrinterRegistry();

// =========================
// MEMORY STORES
// =========================
const sessions = new Map();
const jobs = [];
let jobCounter = 1;

// =========================
// HELPERS
// =========================
function nowIso() {
  return new Date().toISOString();
}

function normalizeText(text = "") {
  return String(text || "").trim().toLowerCase();
}

function safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function money(value = 0) {
  return Number(value || 0).toFixed(2);
}

function publicFileUrl(relativeUrl = "") {
  if (!relativeUrl) return "";
  if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
  if (BASE_URL) return `${BASE_URL}${relativeUrl.startsWith("/") ? "" : "/"}${relativeUrl}`;
  return relativeUrl;
}

function createEmptySession() {
  return {
    stage: null,
    selectedService: null,
    learningType: null,
    pendingFile: null,
    lastJobId: null,
    printSpec: {
      paper_size: "",
      color_mode: "",
      copies: 1,
      pages: 1
    },
    laminateSpec: {
      paper_size: "",
      copies: 1
    }
  };
}

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, createEmptySession());
  }
  return sessions.get(from);
}

function resetSession(from) {
  sessions.set(from, createEmptySession());
}

function isGreeting(text = "") {
  const lower = normalizeText(text);
  return ["hi", "hello", "hey", "start", "menu"].includes(lower);
}

function serviceMenuText(hasFile = false) {
  return `${hasFile ? "✅ File received successfully!\n\n" : ""}What would you like to do${hasFile ? " with your file" : ""}?

1 - Print
2 - Laminate
3 - Image Editing
4 - Video Editing
5 - ID Photo
6 - Lesson / Homework / Quiz / Transcript
7 - Need Shipping

Or type:
🚗 Ride to work
🔧 Find mechanic
🏠 Rent apartment`;
}

function learningMenuText() {
  return `📚 Learning Mode

What do you want?

1 - Generate Transcript
2 - Create Quiz
3 - Explain Lesson
4 - Solve Homework`;
}

function printSizeMenuText() {
  return `🖨 Printing selected.

Choose paper size:

1 - A4
2 - A3
3 - Letter
4 - Legal
5 - Tabloid`;
}

function printColorMenuText() {
  return `Choose color mode:

1 - Black & White
2 - Color`;
}

function laminateSizeMenuText() {
  return `📄 Laminating selected.

Choose laminate type:

1 - Standard / Letter — $1.50
2 - Legal — $2.00
3 - Tabloid — $3.00`;
}

function detectReferralIntent(text = "") {
  const lower = normalizeText(text);
  if (lower.includes("ride")) return "RIDE";
  if (lower.includes("mechanic")) return "MECHANIC";
  if (lower.includes("apartment") || lower.includes("rent")) return "APARTMENT";
  if (lower.includes("shipping")) return "SHIPPING";
  return null;
}

function mapSelectionToService(text = "") {
  const lower = normalizeText(text);

  if (lower === "1") return "PRINT";
  if (lower === "2") return "LAMINATE";
  if (lower === "3") return "IMAGE_EDIT";
  if (lower === "4") return "VIDEO_EDIT";
  if (lower === "5") return "ID_PHOTO";
  if (lower === "6") return "LEARNING";
  if (lower === "7") return "SHIPPING";

  if (lower === "print") return "PRINT";
  if (lower === "laminate") return "LAMINATE";
  if (lower === "image editing") return "IMAGE_EDIT";
  if (lower === "video editing") return "VIDEO_EDIT";
  if (lower === "id photo") return "ID_PHOTO";
  if (lower === "learning") return "LEARNING";
  if (lower === "shipping" || lower === "need shipping") return "SHIPPING";

  return null;
}

function parseCountFromText(text = "", fallback = 1) {
  const m = String(text).match(/\d+/);
  return m ? Math.max(1, safeInt(m[0], fallback)) : fallback;
}

function chooseRouteForJob(input = {}) {
  const service = String(input.service || "");
  const paperSize = String(input.paper_size || "").toUpperCase();
  const explicitPrinter = input.printer_id || "";

  if (explicitPrinter) return explicitPrinter;

  if (service === "IMAGE_EDIT" || service === "VIDEO_EDIT" || service === "ID_PHOTO" || service === "LEARNING") {
    return AGENT_QUEUE_ID;
  }

  if (service === "SHIPPING" || service === "LAMINATE") {
    return DISPATCH_QUEUE_ID;
  }

  if (paperSize === "A3" || paperSize === "TABLOID") {
    return A3_PRINTER_ID;
  }

  if (paperSize === "CARD") {
    return CARD_PRINTER_ID;
  }

  if (service === "PRINT") {
    return DEFAULT_PRINTER_ID;
  }

  return DISPATCH_QUEUE_ID;
}

function estimatePrintCost({ paper_size = "A4", color_mode = "bw", copies = 1, pages = 1 }) {
  const size = String(paper_size || "A4").toUpperCase();
  const color = normalizeText(color_mode) === "color" ? "color" : "bw";
  const rate = PRINT_PRICING[size]?.[color] || PRINT_PRICING.A4[color];
  return Number((rate * safeInt(copies, 1) * safeInt(pages, 1)).toFixed(2));
}

function estimateLaminateCost({ paper_size = "LETTER", copies = 1 }) {
  const size = String(paper_size || "LETTER").toUpperCase();
  const rate = LAMINATE_PRICING[size] || LAMINATE_PRICING.LETTER;
  return Number((rate * safeInt(copies, 1)).toFixed(2));
}

function buildShopifyCartUrl(variantId, qty = 1) {
  if (!variantId) return LINKS.HOW_TO_UPLOAD;
  return `https://www.patapata.us/cart/${variantId}:${Math.max(1, safeInt(qty, 1))}`;
}

function normalizePaperSize(value = "") {
  const raw = String(value || "").trim().toUpperCase();

  if (raw === "A4") return "A4";
  if (raw === "A3") return "A3";
  if (raw === "LETTER") return "LETTER";
  if (raw === "LEGAL") return "LEGAL";
  if (raw === "TABLOID") return "TABLOID";
  if (raw === "CARD" || raw === "ID" || raw === "ID_CARD") return "CARD";

  return raw;
}

function normalizeColorMode(value = "") {
  const raw = String(value || "").trim().toLowerCase();

  if (raw === "color" || raw === "colour") return "COLOR";
  return "BW";
}

function getPrintVariantId({ paper_size = "", color_mode = "" }) {
  const size = normalizePaperSize(paper_size);
  const color = normalizeColorMode(color_mode);

  const map = {
    A4_BW: SHOPIFY_VARIANTS.PRINT_A4_BW,
    A4_COLOR: SHOPIFY_VARIANTS.PRINT_A4_COLOR,
    A3_BW: SHOPIFY_VARIANTS.PRINT_A3_BW,
    A3_COLOR: SHOPIFY_VARIANTS.PRINT_A3_COLOR,
    LETTER_BW: SHOPIFY_VARIANTS.PRINT_LETTER_BW,
    LETTER_COLOR: SHOPIFY_VARIANTS.PRINT_LETTER_COLOR,
    LEGAL_BW: SHOPIFY_VARIANTS.PRINT_LEGAL_BW,
    LEGAL_COLOR: SHOPIFY_VARIANTS.PRINT_LEGAL_COLOR,
    TABLOID_BW: SHOPIFY_VARIANTS.PRINT_TABLOID_BW,
    TABLOID_COLOR: SHOPIFY_VARIANTS.PRINT_TABLOID_COLOR,
    CARD_BW: SHOPIFY_VARIANTS.PRINT_CARD_BW,
    CARD_COLOR: SHOPIFY_VARIANTS.PRINT_CARD_COLOR
  };

  return map[`${size}_${color}`] || "";
}

function getLaminateVariantId(paper_size = "") {
  const size = normalizePaperSize(paper_size);

  const map = {
    LETTER: SHOPIFY_VARIANTS.LAMINATE_LETTER,
    LEGAL: SHOPIFY_VARIANTS.LAMINATE_LEGAL,
    TABLOID: SHOPIFY_VARIANTS.LAMINATE_TABLOID
  };

  return map[size] || "";
}

async function createOrUpdateJob(from, session, patch = {}) {
  const existing = session.lastJobId ? jobs.find(j => j.id === session.lastJobId) : null;

  const merged = {
    customer_phone: from,
    service: patch.service || session.selectedService || existing?.service || "",
    printer_id:
      patch.printer_id ||
      existing?.printer_id ||
      chooseRouteForJob({
        service: patch.service || session.selectedService || existing?.service || "",
        paper_size: patch.paper_size || existing?.paper_size || ""
      }),
    file: patch.file || session.pendingFile || existing?.file || null,
    status: patch.status || existing?.status || "pending",
    instructions: patch.instructions !== undefined
  ? patch.instructions
  : existing?.instructions || "",
    instruction_audio_url:
      patch.instruction_audio_url !== undefined
        ? patch.instruction_audio_url
        : existing?.instruction_audio_url || "",
    instruction_audio:
      patch.instruction_audio !== undefined
        ? patch.instruction_audio
        : existing?.instruction_audio || null,
    shipping_details:
      patch.shipping_details !== undefined
        ? patch.shipping_details
        : existing?.shipping_details || "",
    learning_type:
      patch.learning_type !== undefined
        ? patch.learning_type
        : existing?.learning_type || session.learningType || "",
    paper_size:
      patch.paper_size !== undefined ? patch.paper_size : existing?.paper_size || "",
    color_mode:
      patch.color_mode !== undefined ? patch.color_mode : existing?.color_mode || "",
    copies:
      patch.copies !== undefined ? safeInt(patch.copies, 1) : safeInt(existing?.copies, 1),
    pages:
      patch.pages !== undefined ? safeInt(patch.pages, 1) : safeInt(existing?.pages, 1),
    unit_price:
      patch.unit_price !== undefined ? Number(patch.unit_price || 0) : Number(existing?.unit_price || 0),
    total_cost:
      patch.total_cost !== undefined ? Number(patch.total_cost || 0) : Number(existing?.total_cost || 0),
    notes: patch.notes !== undefined ? patch.notes : existing?.notes || "",
    error_message:
      patch.error_message !== undefined ? patch.error_message : existing?.error_message || ""
  };

  if (existing) {
    Object.assign(existing, merged, { updated_at: nowIso() });
    return existing;
  }

  const job = {
    id: jobCounter++,
    public_job_id: `MSTAF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...merged
  };

  jobs.unshift(job);
  await pool.query(
  `INSERT INTO print_jobs
  (public_job_id, printer_id, file_url, original_name, paper_size, color_mode, copies, pages, total_cost, status, instructions, customer_phone, service, created_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [
    job.public_job_id || "",
    job.printer_id || "",
    job.file?.url || job.file_url || "",
    job.file?.original_name || job.original_name || "",
    job.paper_size || "",
    job.color_mode || "",
    Number(job.copies || 1),
    Number(job.pages || 1),
    Number(job.total || job.total_cost || 0),
    job.status || "pending",
    job.instructions || "",
    job.customer_phone || "",
    job.service || "",
    job.created_at || new Date().toISOString()
  ]
);
  session.lastJobId = job.id;
  return job;
}

function authDashboard(req) {
  if (!DASHBOARD_KEY) return true;
  const key = req.headers["x-dashboard-key"] || req.query.key || "";
  return key === DASHBOARD_KEY;
}

function authWorker(req) {
  if (!WORKER_KEY && !PRINTER_KEY) return true;
  const key =
    req.headers["x-worker-key"] ||
    req.headers["x-printer-key"] ||
    req.query.key ||
    "";
  return key === WORKER_KEY || key === PRINTER_KEY;
}

async function sendMessage(to, text) {
  if (!TOKEN || !PHONE_ID) {
    console.warn("WhatsApp TOKEN or PHONE_ID missing. Message not sent.");
    return;
  }

  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

async function downloadWhatsAppMedia(mediaId) {
  if (!mediaId || !TOKEN) return null;

  try {
    const metaResp = await axios.get(`https://graph.facebook.com/v18.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    const mediaUrl = metaResp.data?.url;
    const mimeType = metaResp.data?.mime_type || "application/octet-stream";
    if (!mediaUrl) return null;

    const extMap = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
      "audio/ogg": ".ogg",
      "audio/mpeg": ".mp3",
      "audio/mp4": ".m4a",
      "application/pdf": ".pdf",
      "application/msword": ".doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx"
    };

    const ext = extMap[mimeType] || "";
    const filename = `${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);

    const mediaResp = await axios.get(mediaUrl, {
      responseType: "stream",
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filepath);
      mediaResp.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    const relative = `/uploads/${filename}`;

    return {
      mediaId,
      mimeType,
      filename,
      filepath,
      url: relative,
      publicUrl: publicFileUrl(relative)
    };
  } catch (err) {
    console.error("Media download failed:", err.response?.data || err.message);
    return null;
  }
}

function isPrintableFile(file) {
  if (!file) return false;
  const type = String(file.type || "");
  const mime = String(file.mime_type || "");
  if (type === "video" || mime.startsWith("video")) return false;
  if (type === "audio" || mime.startsWith("audio")) return false;
  return true;
}

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getPrinterOptionsHtml(selected = "") {
  return PRINTERS.map((p) => {
    const s = String(p.id) === String(selected) ? "selected" : "";
    return `<option value="${esc(p.id)}" ${s}>${esc(p.id)}</option>`;
  }).join("");
}

function renderFilePreview(job) {
  const url = job?.file?.url || job?.file_url || "";
  const mime = String(job?.file?.mime_type || job?.mime_type || "");
  const name = job?.file?.filename || job?.original_name || "file";

  if (!url) {
    return `
      <div class="media-box">
        <div class="media-title">File</div>
        <div class="media-text">No file attached</div>
      </div>
    `;
  }

  if (mime.startsWith("image/")) {
    return `
      <div class="media-box">
        <div class="media-title">File Preview</div>
        <img class="preview" src="${esc(url)}" alt="${esc(name)}" />
        <a class="open-link" target="_blank" rel="noopener" href="${esc(url)}">Open File</a>
      </div>
    `;
  }

  if (mime.startsWith("video/")) {
    return `
      <div class="media-box">
        <div class="media-title">Video Preview</div>
        <video class="preview" controls src="${esc(url)}"></video>
        <a class="open-link" target="_blank" rel="noopener" href="${esc(url)}">Open File</a>
      </div>
    `;
  }

  if (mime === "application/pdf") {
    return `
      <div class="media-box">
        <div class="media-title">File Preview</div>
        <div class="media-text">Document attached and ready.</div>
        <a class="open-link" target="_blank" rel="noopener" href="${esc(url)}">Open File</a>
      </div>
    `;
  }

  return `
    <div class="media-box">
      <div class="media-title">File</div>
      <div class="media-text">${esc(name)}</div>
      <a class="open-link" target="_blank" rel="noopener" href="${esc(url)}">Open File</a>
    </div>
  `;
}

function renderAudioPreview(job) {
  if (!job.instruction_audio_url) return "";

  return `
    <div class="media-box">
      <div class="media-title">Instruction Audio</div>
      <audio controls preload="metadata" src="${esc(job.instruction_audio_url)}"></audio>
      <a class="open-link" target="_blank" rel="noopener" href="${esc(job.instruction_audio_url)}">Open Audio</a>
    </div>
  `;
}


// =========================
// ROOT / HEALTH / DEBUG
// =========================
app.get("/", (req, res) => {
  res.send("PATAPATA MSTAF server is running.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mstaf-core",
    queues: {
      default_printer_id: DEFAULT_PRINTER_ID,
      a3_printer_id: A3_PRINTER_ID,
      card_printer_id: CARD_PRINTER_ID,
      dispatch_queue_id: DISPATCH_QUEUE_ID,
      agent_queue_id: AGENT_QUEUE_ID
    },
    printers: PRINTERS.length
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    now: nowIso(),
    base_url: BASE_URL || null,
    printers_count: PRINTERS.length
  });
});

app.get("/debug", (req, res) => {
  res.json({
    ok: true,
    NOW: nowIso(),
    base_url: BASE_URL || null,
    uploads_dir: UPLOAD_DIR,
    jobs_count: jobs.length,
    printers_count: PRINTERS.length
  });
});

// =========================
// UPLOAD / JOB CREATE
// =========================
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No file uploaded" });
  }

  const relativeUrl = `/uploads/${req.file.filename}`;

  return res.json({
    ok: true,
    file_url: relativeUrl,
    public_file_url: publicFileUrl(relativeUrl),
    original_name: req.file.originalname
  });
});

app.post("/api/print-jobs", upload.single("file"), (req, res) => {
  try {
    const service = String(req.body.service_type || req.body.serviceType || "PRINT").toUpperCase();
    const paper_size = String(req.body.paper_size || req.body.paperSize || "").toUpperCase();
    const color_mode = normalizeText(req.body.color_mode || req.body.colorMode || "bw");
    const copies = safeInt(req.body.copies, 1);
    const pages = safeInt(req.body.pages, 1);

    let unit_price = 0;
    let total_cost = 0;

    if (service === "PRINT") {
      unit_price = PRINT_PRICING[paper_size]?.[color_mode === "color" ? "color" : "bw"] || 0;
      total_cost = estimatePrintCost({ paper_size, color_mode, copies, pages });
    } else if (service === "LAMINATE") {
      unit_price = LAMINATE_PRICING[paper_size] || 0;
      total_cost = estimateLaminateCost({ paper_size, copies });
    }

    const file = req.file
      ? {
          type: "document",
          url: `/uploads/${req.file.filename}`,
          filename: req.file.filename,
          mime_type: req.file.mimetype
        }
      : null;

    const job = {
      id: jobCounter++,
      public_job_id: `MSTAF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      customer_phone: String(req.body.customer_phone || req.body.phone || ""),
      customer_name: String(req.body.customer_name || ""),
      customer_email: String(req.body.customer_email || ""),
      service,
      printer_id: chooseRouteForJob({ service, paper_size }),
      file,
      status: "pending",
       instructions: String(req.body.instructions || ""),
      instruction_audio_url: "",
      instruction_audio: null,
      shipping_details: "",
      learning_type: "",
      paper_size,
      color_mode,
      copies,
      pages,
      unit_price,
      total_cost,
      notes: String(req.body.notes || ""),
      error_message: "",
      created_at: nowIso(),
      updated_at: nowIso()
    };

    jobs.unshift(job);
    res.json({ ok: true, job });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Failed to create job" });
  }
});

app.get("/jobs", (req, res) => {
  res.json({ ok: true, count: jobs.length, jobs });
});

app.get("/api/printers", (req, res) => {
  res.json({ ok: true, count: PRINTERS.length, printers: PRINTERS });
});

// =========================
// DASHBOARD / DISPATCH / WORKER APIs
// =========================
app.get("/api/dashboard/jobs", (req, res) => {
  if (!authDashboard(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const printer_id = String(req.query.printer_id || "").trim();
  const status = normalizeText(req.query.status || "");
  const q = normalizeText(req.query.q || "");

  let filtered = [...jobs];

  if (printer_id) {
    filtered = filtered.filter((j) => String(j.printer_id || "") === printer_id);
  }

  if (status) {
    filtered = filtered.filter((j) => normalizeText(j.status || "") === status);
  }

  if (q) {
    filtered = filtered.filter((j) =>
      [
        j.id,
        j.public_job_id,
        j.service,
        j.printer_id,
        j.customer_phone,
        j.instructions,
        j.shipping_details,
        j.error_message,
        j.learning_type,
        j.file?.filename,
        j.file?.url,
        j.paper_size,
        j.color_mode
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }

  res.json({ ok: true, count: filtered.length, jobs: filtered });
});

app.post("/api/dashboard/jobs/:id/route", (req, res) => {
  if (!authDashboard(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const job = jobs.find((j) => j.id === Number(req.params.id));
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  const printer_id = String(req.body.printer_id || "").trim();
  if (!printer_id) {
    return res.status(400).json({ ok: false, error: "printer_id is required" });
  }

  Object.assign(job, {
    printer_id,
    status: "pending",
    error_message: "",
    updated_at: nowIso()
  });

  res.json({ ok: true, job });
});

app.post("/api/dashboard/jobs/:id/mark", (req, res) => {
  if (!authDashboard(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const job = jobs.find((j) => j.id === Number(req.params.id));
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  Object.assign(job, {
    status: String(req.body.status || job.status),
    error_message: String(req.body.error_message || ""),
    updated_at: nowIso()
  });

  res.json({ ok: true, job });
});

app.get("/api/dispatch/queue", (req, res) => {
  if (!authDashboard(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const queue = jobs.filter((j) => j.printer_id === DISPATCH_QUEUE_ID);
  res.json({ ok: true, count: queue.length, jobs: queue });
});

app.post("/api/dispatch/assign", (req, res) => {
  if (!authDashboard(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const { id, printer_id } = req.body || {};
  const job = jobs.find((j) => j.id === Number(id));

  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  if (!printer_id) {
    return res.status(400).json({ ok: false, error: "printer_id is required" });
  }

  Object.assign(job, {
    printer_id: String(printer_id),
    status: "pending",
    error_message: "",
    updated_at: nowIso()
  });

  res.json({ ok: true, job });
});

app.get("/api/worker/next", (req, res) => {
  if (!authWorker(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const requestedPrinterId =
    String(req.query.printer_id || req.headers["x-printer-id"] || "").trim();

  let nextJob = null;

  if (requestedPrinterId) {
    nextJob = jobs.find(
      (j) => j.status === "pending" && String(j.printer_id || "") === requestedPrinterId
    );
  } else {
    nextJob = jobs.find(
      (j) =>
        j.status === "pending" &&
        j.printer_id !== DISPATCH_QUEUE_ID &&
        j.printer_id !== AGENT_QUEUE_ID
    );
  }

  if (!nextJob) {
    return res.status(200).json({ ok: true, job: null, message: "No pending jobs" });
  }

  nextJob.status = "printing";
  nextJob.updated_at = nowIso();
  res.json({ ok: true, job: nextJob });
});

app.post("/api/worker/jobs/:id/status", (req, res) => {
  const allow = authWorker(req) || authDashboard(req);
  if (!allow) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const job = jobs.find((j) => j.id === Number(req.params.id));
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  job.status = String(req.body.status || job.status);
  job.error_message = String(req.body.error_message || "");
  job.updated_at = nowIso();

  res.json({ ok: true, job });
});

app.post("/api/worker/status", (req, res) => {
  const allow = authWorker(req) || authDashboard(req);
  if (!allow) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const job = jobs.find((j) => j.id === Number(req.body.jobId));
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  job.status = String(req.body.status || job.status);
  job.error_message = String(req.body.error_message || "");
  job.updated_at = nowIso();

  res.json({ ok: true, job });
});

// =========================
// WEBHOOK VERIFY
// =========================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});// =========================
// WHATSAPP WEBHOOK
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;
    const session = getSession(from);

    let text = "";
    if (type === "text") {
      text = message.text?.body || "";
    }
    const lower = normalizeText(text);

    // -------------------------
    // Greeting
    // -------------------------
    if (type === "text" && isGreeting(text)) {
      resetSession(from);
      await sendMessage(from, `Hello 👋 Welcome to PATAPATA Print-O-Matic

Send your PDF, image, document, video, or audio.

${serviceMenuText(false)}`);
      return res.sendStatus(200);
    }

    // -------------------------
    // Referral flows
    // -------------------------
    const referral = type === "text" ? detectReferralIntent(text) : null;

    if (referral === "RIDE") {
      await sendMessage(from, `🚗 Ride to Work\nCall ${CONTACTS.RIDE}`);
      return res.sendStatus(200);
    }
    if (referral === "MECHANIC") {
      await sendMessage(from, `🔧 Auto Mechanic\nCall ${CONTACTS.MECHANIC}`);
      return res.sendStatus(200);
    }
    if (referral === "APARTMENT") {
      await sendMessage(from, `🏠 Apartment Rental\nCall ${CONTACTS.APARTMENT}`);
      return res.sendStatus(200);
    }

    // -------------------------
    // Incoming media
    // -------------------------
    let downloadedFile = null;

    if (["image", "document", "video", "audio"].includes(type)) {
      const mediaId =
        message.document?.id ||
        message.image?.id ||
        message.video?.id ||
        message.audio?.id ||
        "";

      downloadedFile = await downloadWhatsAppMedia(mediaId);

      if (downloadedFile) {
  const savedMedia = {
    type,
    url: downloadedFile.publicUrl || downloadedFile.url,
    filename: downloadedFile.filename,
    mime_type: downloadedFile.mimeType
  };

  if (type === "audio") {
    session.pendingInstructionAudio = savedMedia;
  } else {
    session.pendingFile = savedMedia;
  }
}
      // ===============================
// FILE RECEIVED → ASK WHAT TO DO
// ===============================
if (type === "image" || type === "document") {

  // Only trigger if not already in a specific flow
  if (!session.stage || session.stage === "START") {

    session.stage = "FILE_RECEIVED";

    await sendMessage(
      from,
      `✅ File received successfully.

What would you like to do with this file?

Reply:
1 - Print
2 - Laminate
3 - ID Photo
4 - Image Editing
5 - Video Editing`
    );

    return res.sendStatus(200);
  }
}
    // -------------------------
    // Audio as instruction
    // -------------------------
    if (type === "audio") {
  const job = createOrUpdateJob(from, session, {
    service: session.selectedService || "PRINT",
    instruction_audio_url: session.pendingInstructionAudio?.url || "",
    instruction_audio: session.pendingInstructionAudio || null
  });

  session.pendingInstructionAudio = null;
}

  if (session.stage === "LEARNING_WAITING_INPUT") {
    job.service = "LEARNING";
    job.learning_type = session.learningType || "";
    job.printer_id = AGENT_QUEUE_ID;
    job.updated_at = nowIso();

    await sendMessage(
      from,
      `✅ Learning audio received.

Type: ${job.learning_type || "LEARNING"}

Our agent will review it and continue here on WhatsApp.`
    );
    return res.sendStatus(200);
  }
if (session.stage === "PRINT_WAITING_FILE" && (type === "image" || type === "document")) {
  session.stage = "PRINT_WAITING_INSTRUCTIONS";

  await sendMessage(
    from,
    `✅ File received successfully.

Send any special print instructions (optional).
You can type or send a voice note.`
  );

  return res.sendStatus(200);
}
  if (session.stage === "LAMINATE_WAITING_CHAT") {
    await sendMessage(
      from,
      `✅ Laminating audio instruction received and attached to Job #${job.id}.`
    );
    return res.sendStatus(200);
  }

  if (session.stage === "IMAGE_EDIT_WAITING_FILE" && (type === "image" || type === "document")) {
  const job = createOrUpdateJob(from, session, {
    service: "IMAGE_EDIT",
    printer_id: AGENT_QUEUE_ID,
    file_url: session.pendingFile?.url || "",
    mime_type: session.pendingFile?.mime_type || "",
    original_name: session.pendingFile?.filename || "",
    total_cost: 0
  });

  await sendMessage(
    from,
    `🖼️ Image received and attached to Job #${job.id}.\n\nPlease type your instructions or send a voice note, and we will continue from there.`
  );

  return res.sendStatus(200);
}
     if (session.stage === "VIDEO_EDIT_WAITING_FILE" && (type === "video" || type === "document")) {
  const job = createOrUpdateJob(from, session, {
    service: "VIDEO_EDIT",
    printer_id: AGENT_QUEUE_ID,
    file_url: session.pendingFile?.url || "",
    mime_type: session.pendingFile?.mime_type || "",
    original_name: session.pendingFile?.filename || ""
  });

  await sendMessage(
    from,
   `Video received and attached to Job #${job.id}.\n\nPlease type your instructions or send a voice note, and we will continue from there.`
  );
  return res.sendStatus(200);
}

  if (session.stage === "ID_PHOTO_WAITING_FILE") {
    await sendMessage(
  from,
  `✅ ID photo audio instruction received and attached to Job #${job.id}.

Our team is reviewing your request and will share the pricing shortly.`
);
    return res.sendStatus(200);
  }

  await sendMessage(
  from,
  `✅ Voice note received and attached to your request.

Our team will review it and get back to you shortly.`
);
  return res.sendStatus(200);
}

    // -------------------------
    // Main service selection
    // -------------------------
    if (
  type === "text" &&
  (
    !session.stage ||
    session.stage === "MENU" ||
    isGreeting(text)
  )
) {
      const service = mapSelectionToService(text);

      if (service === "PRINT") {
        session.selectedService = "PRINT";
        session.stage = "PRINT_SELECT_SIZE";
        await sendMessage(from, printSizeMenuText());
        return res.sendStatus(200);
      }

      if (service === "LAMINATE") {
        session.selectedService = "LAMINATE";
        session.stage = "LAMINATE_SELECT_SIZE";
        await sendMessage(from, laminateSizeMenuText());
        return res.sendStatus(200);
      }

      if (service === "IMAGE_EDIT") {
        session.selectedService = "IMAGE_EDIT";
        session.stage = "IMAGE_EDIT_WAITING_FILE";
        await sendMessage(from, `🖼️ Image Editing selected.

Please upload your image and tell us what you would like us to do.

You can type instructions or send a voice note.`);
        return res.sendStatus(200);
      }

      if (service === "VIDEO_EDIT") {
        session.selectedService = "VIDEO_EDIT";
        session.stage = "VIDEO_EDIT_WAITING_FILE";
        await sendMessage(from, `🎥 Video Editing selected.

Upload video and send your instructions.
You can also send a voice note.`);
        return res.sendStatus(200);
      }

      if (service === "ID_PHOTO") {
        session.selectedService = "ID_PHOTO";
        session.stage = "ID_PHOTO_WAITING_FILE";
        await sendMessage(from, `🪪 ID Photo selected.

Upload your photo and send your instructions.`);
        return res.sendStatus(200);
      }

      if (service === "LEARNING") {
        session.selectedService = "LEARNING";
        session.stage = "LEARNING_MENU";
        await sendMessage(from, learningMenuText());
        return res.sendStatus(200);
      }

      if (service === "SHIPPING") {
        session.selectedService = "SHIPPING";
        session.stage = "SHIPPING_WAITING_DETAILS";
        await sendMessage(from, `📦 Need Shipping selected.

Please send:
- pickup or delivery
- item type
- destination city/state
- quantity/weight if known

You can type details or send a voice note.`);
        return res.sendStatus(200);
      }
    }

    // -------------------------
    // Learning submenu
    // -------------------------
    if (type === "text" && session.stage === "LEARNING_MENU") {
      if (lower === "1") session.learningType = "TRANSCRIPT";
      else if (lower === "2") session.learningType = "QUIZ";
      else if (lower === "3") session.learningType = "EXPLAIN";
      else if (lower === "4") session.learningType = "HOMEWORK";
      else {
        await sendMessage(from, "Please reply with 1, 2, 3, or 4.");
        return res.sendStatus(200);
      }

      session.stage = "LEARNING_WAITING_INPUT";
      await sendMessage(from, `📚 ${session.learningType} selected.

Now send:
- text
- file
- or voice note`);
      return res.sendStatus(200);
    }

    if (session.stage === "LEARNING_WAITING_INPUT") {
      const job = createOrUpdateJob(from, session, {
        service: "LEARNING",
        learning_type: session.learningType || "",
        instructions: type === "text" ? text : "[Learning file uploaded]",
        printer_id: AGENT_QUEUE_ID
      });

      await sendMessage(from, `✅ Learning request received.

Type: ${job.learning_type}
Job ID: ${job.id}

Our agent will continue here on WhatsApp.`);
      return res.sendStatus(200);
    }

    // -------------------------
    // Print flow
    // -------------------------
    if (type === "text" && session.stage === "PRINT_SELECT_SIZE") {
      const sizeMap = {
        "1": "A4",
        "2": "A3",
        "3": "LETTER",
        "4": "LEGAL",
        "5": "TABLOID"
      };

      const size = sizeMap[lower];
      if (!size) {
        await sendMessage(from, "Reply with 1, 2, 3, 4, or 5 for paper size.");
        return res.sendStatus(200);
      }

      session.printSpec.paper_size = size;
      session.stage = "PRINT_SELECT_COLOR";
      await sendMessage(from, printColorMenuText());
      return res.sendStatus(200);
    }

    if (type === "text" && session.stage === "PRINT_SELECT_COLOR") {
      let color = "";
      if (lower === "1") color = "bw";
      if (lower === "2") color = "color";

      if (!color) {
        await sendMessage(from, "Reply with 1 for Black & White or 2 for Color.");
        return res.sendStatus(200);
      }

      session.printSpec.color_mode = color;
      session.stage = "PRINT_SELECT_COPIES";
      await sendMessage(from, "How many copies?");
      return res.sendStatus(200);
    }

    if (type === "text" && session.stage === "PRINT_SELECT_COPIES") {
      const copies = parseCountFromText(text, 1);
      session.printSpec.copies = copies;
      session.stage = "PRINT_SELECT_PAGES";
      await sendMessage(from, "How many pages?");
      return res.sendStatus(200);
    }

    if (type === "text" && session.stage === "PRINT_SELECT_PAGES") {
      const pages = parseCountFromText(text, 1);
      session.printSpec.pages = pages;

      const normalizedSize = normalizePaperSize(session.printSpec.paper_size);
const normalizedColor = normalizeColorMode(session.printSpec.color_mode);

const unitPrice =
  PRINT_PRICING[normalizedSize]?.[
    normalizedColor === "COLOR" ? "color" : "bw"
  ] || 0;

const total =
  normalizedSize === "A3"
    ? unitPrice * session.printSpec.copies
    : estimatePrintCost(session.printSpec);
      const variantId = getPrintVariantId({
  paper_size: session.printSpec.paper_size,
  color_mode: session.printSpec.color_mode
});

console.log("PRINT DEBUG:", {
  paper_size: session.printSpec.paper_size,
  color_mode: session.printSpec.color_mode,
  variantId
});
      const checkoutLink = buildShopifyCartUrl(
  variantId,
  session.printSpec.copies
);

      const job = createOrUpdateJob(from, session, {
        service: "PRINT",
        paper_size: session.printSpec.paper_size,
        color_mode: session.printSpec.color_mode,
        copies: session.printSpec.copies,
        pages: session.printSpec.pages,
        file_url: session.pendingFile?.url || "",
mime_type: session.pendingFile?.mime_type || "",
original_name: session.pendingFile?.filename || "",
        unit_price: unitPrice,
        total_cost: total,
        printer_id: chooseRouteForJob({
          service: "PRINT",
          paper_size: session.printSpec.paper_size
        }),
        
instructions: "",

       
  file_url: session.pendingFile?.type !== "audio" ? (session.pendingFile?.url || "") : "",
  mime_type: session.pendingFile?.type !== "audio" ? (session.pendingFile?.mime_type || "") : "",
  original_name: session.pendingFile?.type !== "audio" ? (session.pendingFile?.filename || "") : "",
  instruction_audio_url: session.pendingFile?.type === "audio" ? (session.pendingFile?.url || "") : "",
  instruction_audio: session.pendingFile?.type === "audio" ? session.pendingFile : null
});

      session.stage = "PRINT_CONFIRM";

      let extraLine = variantId
        ? "Reply:\n1 - Pay on Shopify now\n2 - Continue here on WhatsApp"
        : "A direct Shopify checkout is not set yet for this print option.\nReply:\n2 - Continue here on WhatsApp";

      await sendMessage(
        from,
        `🖨 Your print order

Size: ${job.paper_size}
Color: ${job.color_mode === "color" ? "Color" : "Black & White"}
Copies: ${job.copies}
Pages: ${job.pages}
Unit Price: $${money(job.unit_price)}
Total: $${money(job.total_cost)}

${variantId ? `Checkout:\n${checkoutLink}\n\n` : ""}${extraLine}`
      );
      return res.sendStatus(200);
    }

    if (type === "text" && session.stage === "PRINT_CONFIRM") {
      if (lower === "1") {
        const variantId = getPrintVariantId(session.printSpec);
        const checkoutLink = buildShopifyCartUrl(
  variantId,
  session.printSpec.copies
);
        await sendMessage(from, `🛒 Print checkout:\n${checkoutLink}`);
        return res.sendStatus(200);
      }

      if (lower === "2") {
  session.stage = "PRINT_WAITING_FILE";
  await sendMessage(
    from,
    `📎 Please upload your document, PDF, or image for printing.

You can attach it from your phone gallery or files.

Once uploaded, we will continue with your print order.`
  );
  return res.sendStatus(200);
}
      }
if (
  session.stage === "PRINT_WAITING_INSTRUCTIONS" &&
  ((type === "text" && text && text.trim()) || type === "audio")
) {
  const job = createOrUpdateJob(from, session, {
    service: "PRINT",
    printer_id: session.printer_id || DEFAULT_PRINTER_ID,
    file_url: session.pendingFile?.url || "",
    mime_type: session.pendingFile?.mime_type || "",
    original_name: session.pendingFile?.filename || "",
    total_cost: session.total_cost || 0,
    customer_phone: from
  });

  await sendMessage(
    from,
    `✅ Print instruction received and attached to Job #${job.id}.\n\nOur team will continue processing your print order shortly.`
  );

  return res.sendStatus(200);
}
    // -------------------------
    // Laminate flow
    // -------------------------
    if (type === "text" && session.stage === "LAMINATE_SELECT_SIZE") {
      const sizeMap = {
        "1": "LETTER",
        "2": "LEGAL",
        "3": "TABLOID"
      };

      const size = sizeMap[lower];
      if (!size) {
        await sendMessage(from, "Reply with 1, 2, or 3 for laminate type.");
        return res.sendStatus(200);
      }

      session.laminateSpec.paper_size = size;
      session.stage = "LAMINATE_SELECT_COPIES";
      await sendMessage(from, "How many copies?");
      return res.sendStatus(200);
    }

    if (type === "text" && session.stage === "LAMINATE_SELECT_COPIES") {
      const copies = parseCountFromText(text, 1);
      session.laminateSpec.copies = copies;

      const unitPrice = LAMINATE_PRICING[session.laminateSpec.paper_size] || 0;
      const total = estimateLaminateCost(session.laminateSpec);
      const variantId = getLaminateVariantId(session.laminateSpec.paper_size);

console.log("LAMINATE DEBUG:", {
  paper_size: session.laminateSpec.paper_size,
  variantId,
  copies: session.laminateSpec.copies
});

const checkoutLink = buildShopifyCartUrl(
  variantId,
  session.laminateSpec.copies
);

      const job = createOrUpdateJob(from, session, {
        service: "LAMINATE",
        paper_size: session.laminateSpec.paper_size,
        copies: session.laminateSpec.copies,
        pages: 1,
        color_mode: "",
        unit_price: unitPrice,
        total_cost: total,
        printer_id: DISPATCH_QUEUE_ID
      });

      session.stage = "LAMINATE_CONFIRM";

      await sendMessage(
        from,
        `📄 Your laminating order

Type: ${job.paper_size}
Quantity: ${job.copies}
Unit Price: $${money(job.unit_price)}
Total: $${money(job.total_cost)}

Checkout:
${checkoutLink}

Reply:
1 - Pay on Shopify now
2 - Continue here on WhatsApp`
      );
      return res.sendStatus(200);
    }

    if (type === "text" && session.stage === "LAMINATE_CONFIRM") {
      if (lower === "1") {
  const variantId = getLaminateVariantId(session.laminateSpec.paper_size);

  console.log("LAMINATE CHECKOUT DEBUG:", {
    paper_size: session.laminateSpec.paper_size,
    variantId,
    copies: session.laminateSpec.copies
  });

  if (!variantId) {
    await sendMessage(
      from,
      `⚠️ Laminating checkout is not properly linked yet for ${session.laminateSpec.paper_size}.

Please continue here on WhatsApp or contact support.`
    );
    return res.sendStatus(200);
  }

  const checkoutLink = buildShopifyCartUrl(
    variantId,
    session.laminateSpec.copies
  );

  await sendMessage(from, `🛒 Laminate checkout:\n${checkoutLink}`);
  return res.sendStatus(200);
}

      if (lower === "2") {
        session.stage = "LAMINATE_WAITING_CHAT";
        await sendMessage(
  from,
  `Send your laminating instructions here.
${VOICE_NOTE_HINT}`
);
        return res.sendStatus(200);
      }
    }

    // -------------------------
    // Generic service files
    // -------------------------
    if (downloadedFile && type !== "audio" && session.selectedService === "IMAGE_EDIT") {
      const job = createOrUpdateJob(from, session, {
        service: "IMAGE_EDIT",
        file: session.pendingFile,
        printer_id: AGENT_QUEUE_ID,
        total_cost: 0
      });

      await sendMessage(
  from,
  `Image received and attached to Job #${job.id}.\n\nPlease type your instructions or send a voice note, and we will continue from there.`
);
return res.sendStatus(200);
    }

    if (downloadedFile && type !== "audio" && session.selectedService === "VIDEO_EDIT") {
      const job = createOrUpdateJob(from, session, {
        service: "VIDEO_EDIT",
        file: session.pendingFile,
        printer_id: AGENT_QUEUE_ID,
        total_cost: 0
      });

      await sendMessage(
  from,
  `✅ Video received for editing.
Job ID: ${job.id}

${VOICE_NOTE_HINT}`
);
      return res.sendStatus(200);
    }

    if (downloadedFile && session.selectedService === "ID_PHOTO") {
      const job = createOrUpdateJob(from, session, {
        service: "ID_PHOTO",
        file: session.pendingFile,
        printer_id: AGENT_QUEUE_ID,
        total_cost: 0
      });

      await sendMessage(
  from,
  `✅ Photo received for ID service.
Job ID: ${job.id}

${VOICE_NOTE_HINT}`
);
      return res.sendStatus(200);
    }

    if (downloadedFile && session.selectedService === "PRINT" && !isPrintableFile(session.pendingFile)) {
      await sendMessage(from, `⚠️ Video or audio cannot be printed.
Please upload a PDF, document, or image.`);
      return res.sendStatus(200);
    }

    if (downloadedFile && session.selectedService === "LAMINATE" && !isPrintableFile(session.pendingFile)) {
      await sendMessage(from, `⚠️ Video or audio cannot be laminated.
Please upload a document or image file.`);
      return res.sendStatus(200);
    }

    // -------------------------
    // Shipping
    // -------------------------
    if (type === "text" && session.stage === "SHIPPING_WAITING_DETAILS") {
      const job = createOrUpdateJob(from, session, {
        service: "SHIPPING",
        shipping_details: text,
        printer_id: DISPATCH_QUEUE_ID
      });

      await sendMessage(from, `✅ Shipping request received.
Job ID: ${job.id}

We will continue here on WhatsApp.`);
      return res.sendStatus(200);
    }

    // -------------------------
    // Text instructions for existing jobs
    // -------------------------
    if (
      type === "text" &&
      ["PRINT_WAITING_INSTRUCTIONS", "LAMINATE_WAITING_CHAT"].includes(session.stage)
    ) {
      const job = createOrUpdateJob(from, session, {
        instructions: text
      });

      await sendMessage(from, `✅ Instruction saved to Job #${job.id}.`);
    return res.sendStatus(200);
    }

    if (
      type === "text" &&
      ["IMAGE_EDIT_WAITING_FILE", "VIDEO_EDIT_WAITING_FILE", "ID_PHOTO_WAITING_FILE"].includes(session.stage)
    ) {
      const job = createOrUpdateJob(from, session, {
        service: session.selectedService,
        instructions: text,
        printer_id: AGENT_QUEUE_ID
      });
 if (session.stage === "VIDEO_EDIT_WAITING_FILE") {
  await sendMessage(
    from,
    `Instruction received and attached to Job #${job.id}.\n\nOur editing team is now reviewing your video and instructions.\n\nPricing details will be shared with you shortly.`
  );
  return res.sendStatus(200);
}

await sendMessage(from, `Instruction saved to Job #${job.id}.`);
return res.sendStatus(200);
    }

    // fallback
    await sendMessage(from, serviceMenuText(false));
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    return res.sendStatus(200);
  }
});
app.post("/api/dashboard/jobs/:id/message", async (req, res) => {
  try {
    if (!authDashboard(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const job = jobs.find((j) => j.id === Number(req.params.id));
    if (!job) {
      return res.status(404).json({ ok: false, error: "Job not found" });
    }

    const to = job.customer_phone || job.phone || "";
    const message = String(req.body.message || "").trim();

    if (!to) {
      return res.status(400).json({ ok: false, error: "No customer phone on this job" });
    }

    if (!message) {
      return res.status(400).json({ ok: false, error: "Message is required" });
    }

    await sendMessage(to, message);

    job.last_worker_message = message;
    job.last_worker_message_at = nowIso();
    job.updated_at = nowIso();

    return res.json({ ok: true, sent_to: to });
  } catch (err) {
    console.error("dashboard send message error:", err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: "Failed to send message" });
  }
});
// =========================
// DASHBOARD PAGES
// =========================
function renderDashboardPage(title, key) {
  const cards = jobs
    .map((j) => {
      const statusClass =
        j.status === "completed" || j.status === "done"
          ? "done"
          : j.status === "error"
          ? "error"
          : j.status === "printing"
          ? "printing"
          : "pending";

      return `
        <div class="card">
          <div class="top">
            <div>
              <div class="job-title">Job #${esc(j.id)} <span class="public-id">${esc(j.public_job_id)}</span></div>
              <div class="service">${esc(j.service || "")}</div>
            </div>
            <div class="status ${statusClass}">${esc(j.status || "pending")}</div>
          </div>
<div style="margin-top:12px;padding-top:10px;border-top:1px solid #ddd;">
  <div style="font-weight:700;margin-bottom:6px;">Send WhatsApp Message</div>

  <textarea
    id="msg-${j.id}"
    placeholder="Type message to customer..."
    style="width:100%;min-height:80px;padding:10px;border-radius:8px;border:1px solid #ccc;box-sizing:border-box;"
  ></textarea>

  <button
    onclick="sendJobMessage(${j.id})"
    style="margin-top:8px;padding:10px 14px;border:none;border-radius:8px;cursor:pointer;background:#111;color:#fff;"
  >
    Send WhatsApp Message
  </button>
</div>
          <div class="grid">
            <div><span class="label">Customer</span><span class="value">${esc(j.customer_phone || "")}</span></div>
            <div><span class="label">Route</span><span class="value">${esc(j.printer_id || "")}</span></div>
            <div><span class="label">Paper / Type</span><span class="value">${esc(j.paper_size || "-")}</span></div>
            <div><span class="label">Color</span><span class="value">${esc(j.color_mode || "-")}</span></div>
            <div><span class="label">Copies</span><span class="value">${esc(j.copies || 1)}</span></div>
            <div><span class="label">Pages</span><span class="value">${esc(j.pages || 1)}</span></div>
            <div><span class="label">Unit Price</span><span class="value">$${money(j.unit_price || 0)}</span></div>
            <div><span class="label">Total</span><span class="value">$${money(j.total_cost || 0)}</span></div>
            <div><span class="label">Learning</span><span class="value">${esc(j.learning_type || "-")}</span></div>
            <div><span class="label">Created</span><span class="value">${esc(j.created_at || "")}</span></div>
          </div>

          <div class="panel">
            <div class="panel-title">Instructions</div>
            <div class="panel-body">${esc(j.instructions || "None")}</div>
          </div>

          <div class="panel">
            <div class="panel-title">Shipping</div>
            <div class="panel-body">${esc(j.shipping_details || "None")}</div>
          </div>

          ${renderFilePreview(j)}
          ${renderAudioPreview(j)}

          <form class="route-form" method="POST" action="/dashboard/route?key=${encodeURIComponent(key || "")}">
            <input type="hidden" name="id" value="${esc(j.id)}" />
            <select name="printer_id">${getPrinterOptionsHtml(j.printer_id)}</select>
            <button type="submit">Route</button>
          </form>

          <div class="actions">
            <form method="POST" action="/dashboard/mark?key=${encodeURIComponent(key || "")}">
              <input type="hidden" name="id" value="${esc(j.id)}" />
              <input type="hidden" name="status" value="completed" />
              <button class="done-btn">Done</button>
            </form>

            <form method="POST" action="/dashboard/mark?key=${encodeURIComponent(key || "")}">
              <input type="hidden" name="id" value="${esc(j.id)}" />
              <input type="hidden" name="status" value="printing" />
              <button class="print-btn">Printing</button>
            </form>

            <form method="POST" action="/dashboard/mark?key=${encodeURIComponent(key || "")}">
              <input type="hidden" name="id" value="${esc(j.id)}" />
              <input type="hidden" name="status" value="pending" />
              <button class="pending-btn">Pending</button>
            </form>

            <form method="POST" action="/dashboard/mark?key=${encodeURIComponent(key || "")}">
              <input type="hidden" name="id" value="${esc(j.id)}" />
              <input type="hidden" name="status" value="error" />
              <button class="error-btn">Error</button>
            </form>
          </div>
        </div>
      `;
    })
    .join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <title>${esc(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #09111f;
      color: #fff;
    }
    .wrap {
      padding: 20px;
    }
    .hero {
      font-size: 34px;
      font-weight: 800;
      margin-bottom: 8px;
    }
    .sub {
      color: #aab6cc;
      margin-bottom: 18px;
    }
    .nav {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }
    .nav a {
      color: #fff;
      text-decoration: none;
      background: #18263b;
      border: 1px solid #2b3a52;
      padding: 10px 14px;
      border-radius: 10px;
      font-weight: 700;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 18px;
    }
    .card {
      background: linear-gradient(180deg, #111b2e, #0c1424);
      border: 1px solid #2b3a52;
      border-radius: 18px;
      padding: 16px;
      box-shadow: 0 10px 24px rgba(0,0,0,0.25);
    }
    .top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .job-title {
      font-size: 24px;
      font-weight: 800;
    }
    .public-id {
      display: block;
      font-size: 12px;
      color: #8ea2c1;
      margin-top: 4px;
    }
    .service {
      font-size: 18px;
      font-weight: 800;
      margin-top: 6px;
      color: #fff;
    }
    .status {
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 12px;
      text-transform: uppercase;
      font-weight: 800;
    }
    .status.pending { background: #5c4514; color: #ffd982; }
    .status.printing { background: #183d79; color: #badaff; }
    .status.done { background: #17422c; color: #b8ffce; }
    .status.error { background: #5a1f28; color: #ffc8cf; }

    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0,1fr));
      gap: 10px 14px;
      margin-bottom: 14px;
    }
    .label {
      display: block;
      font-size: 12px;
      color: #9db0cf;
      margin-bottom: 4px;
    }
    .value {
      display: block;
      font-size: 16px;
      font-weight: 700;
      word-break: break-word;
    }
    .panel, .media-box {
      margin-top: 12px;
      background: #152238;
      border: 1px solid #2b3a52;
      border-radius: 14px;
      padding: 12px;
    }
    .panel-title, .media-title {
      font-size: 13px;
      text-transform: uppercase;
      color: #9db0cf;
      font-weight: 800;
      margin-bottom: 8px;
    }
    .panel-body, .media-text {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.45;
    }
    .preview {
      width: 100%;
      max-height: 280px;
      object-fit: contain;
      border-radius: 12px;
      background: #0a0f18;
      border: 1px solid #2b3a52;
    }
    audio {
      width: 100%;
      margin-top: 8px;
    }
    .open-link {
      display: inline-block;
      margin-top: 10px;
      color: #8cc7ff;
      font-weight: 700;
      text-decoration: none;
    }
    .route-form {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      margin-top: 14px;
    }
    .route-form select,
    .route-form button {
      border-radius: 10px;
      border: 1px solid #2b3a52;
      padding: 10px 12px;
    }
    .route-form select {
      background: #0c1424;
      color: #fff;
    }
    .route-form button {
      background: #2f72ff;
      color: white;
      font-weight: 800;
      cursor: pointer;
    }
    .actions {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-top: 12px;
    }
    .actions form button {
      width: 100%;
      border: 0;
      border-radius: 10px;
      padding: 12px 10px;
      font-weight: 800;
      cursor: pointer;
    }
    .done-btn { background: #1fc15b; color: white; }
    .print-btn { background: #285fd0; color: white; }
    .pending-btn { background: #7b5d1d; color: #fff2bf; }
    .error-btn { background: #d9394d; color: white; }

    @media (max-width: 700px) {
      .grid { grid-template-columns: 1fr; }
      .actions { grid-template-columns: 1fr 1fr; }
      .route-form { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">${esc(title)}</div>
    <div class="sub">Structured worker / agent dashboard with pricing, file preview, audio, routing, and status controls.</div>

    <div class="nav">
      <a href="/dashboard?key=${encodeURIComponent(key || "")}">Main</a>
      <a href="/dispatch?key=${encodeURIComponent(key || "")}">Dispatch</a>
      <a href="/agent?key=${encodeURIComponent(key || "")}">Agent</a>
      <a href="/printer?key=${encodeURIComponent(key || "")}">Printer</a>
    </div>

    <div class="cards">
      ${cards || "<div>No jobs yet.</div>"}
    </div>
  </div>
  <script>
  async function sendJobMessage(jobId) {
    const el = document.getElementById("msg-" + jobId);
    const message = ((el && el.value) || "").trim();

    if (!message) {
      alert("Type a message first.");
      return;
    }

    const key = new URLSearchParams(window.location.search).get("key") || "";

    try {
      const res = await fetch(
        "/api/dashboard/jobs/" + jobId + "/message?key=" + encodeURIComponent(key),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ message: message })
        }
      );

      const data = await res.json();

      if (!res.ok || !data.ok) {
        alert(data.error || "Failed to send message");
        return;
      }

      alert("✅ WhatsApp message sent!");
      el.value = "";
    } catch (err) {
      alert("Network error. Try again.");
      console.error(err);
    }
  }
</script>
</body>
</html>
`;
}

app.get("/dashboard", (req, res) => {
  const key = String(req.query.key || "");
  if (DASHBOARD_KEY && key !== DASHBOARD_KEY) {
    return res.status(401).send("Unauthorized");
  }
  res.send(renderDashboardPage("MSTAF Worker / Agent Dashboard", key));
});

app.get("/printer", (req, res) => {
  const key = String(req.query.key || "");
  if (DASHBOARD_KEY && key !== DASHBOARD_KEY) {
    return res.status(401).send("Unauthorized");
  }
  res.send(renderDashboardPage("MSTAF Printer Dashboard", key));
});

app.get("/dispatch", (req, res) => {
  const key = String(req.query.key || "");
  if (DASHBOARD_KEY && key !== DASHBOARD_KEY) {
    return res.status(401).send("Unauthorized");
  }
  res.send(renderDashboardPage("MSTAF Dispatch Dashboard", key));
});

app.get("/agent", (req, res) => {
  const key = String(req.query.key || "");
  if (DASHBOARD_KEY && key !== DASHBOARD_KEY) {
    return res.status(401).send("Unauthorized");
  }
  res.send(renderDashboardPage("MSTAF Agent Dashboard", key));
});

app.post("/dashboard/route", express.urlencoded({ extended: true }), (req, res) => {
  const key = String(req.query.key || "");
  if (DASHBOARD_KEY && key !== DASHBOARD_KEY) {
    return res.status(401).send("Unauthorized");
  }

  const job = jobs.find((j) => j.id === Number(req.body.id));
  if (job) {
    job.printer_id = String(req.body.printer_id || job.printer_id);
    job.status = "pending";
    job.error_message = "";
    job.updated_at = nowIso();
  }

  res.redirect(`/dashboard?key=${encodeURIComponent(key)}`);
});

app.post("/dashboard/mark", express.urlencoded({ extended: true }), (req, res) => {
  const key = String(req.query.key || "");
  if (DASHBOARD_KEY && key !== DASHBOARD_KEY) {
    return res.status(401).send("Unauthorized");
  }

  const job = jobs.find((j) => j.id === Number(req.body.id));
  if (job) {
    job.status = String(req.body.status || job.status);
    job.updated_at = nowIso();
    if (job.status !== "error") job.error_message = "";
  }

  res.redirect(`/dashboard?key=${encodeURIComponent(key)}`);
});

// =========================
// START
// =========================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
