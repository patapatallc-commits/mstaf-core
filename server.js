const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

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

const CONTACTS = {
  RIDE: process.env.RIDE_TO_WORK_CONTACTS || "+1 862 230 6637",
  MECHANIC: process.env.AUTO_MECHANIC_CONTACTS || "+1 862 230 6637",
  APARTMENT: process.env.APARTMENT_CONTACTS || "+1 862 230 6637",
  SHIPPING: process.env.SHIPPING_CONTACTS || "+1 862 230 6637"
};

const LINKS = {
  PRINT_CHECKOUT:
    process.env.PRINT_CHECKOUT_LINK ||
    "https://www.patapata.us/cart/52221221437739:1",
  LAMINATE_CHECKOUT:
    process.env.LAMINATE_CHECKOUT_LINK ||
    "https://www.patapata.us/pages/how-to-upload",
  HOW_TO_UPLOAD:
    process.env.HOW_TO_UPLOAD_LINK ||
    "https://www.patapata.us/pages/how-to-upload",
  AFRICA_PAYMENT:
    process.env.AFRICA_PAYMENT_LINK ||
    "https://www.patapata.us/pages/africa-payment",
  WHATSAPP_BOT:
    process.env.WHATSAPP_BOT_LINK || "https://wa.me/18622306637"
};

const PRINT_PRICING = {
  bw: Number(process.env.PRICE_BW || 0.1),
  color: Number(process.env.PRICE_COLOR || 0.5)
};

const LAMINATE_PRICING = {
  LETTER: Number(process.env.LAMINATE_LETTER || 1.5),
  LEGAL: Number(process.env.LAMINATE_LEGAL || 2.0),
  TABLOID: Number(process.env.LAMINATE_TABLOID || 3.0)
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

function publicFileUrl(relativeUrl = "") {
  if (!relativeUrl) return "";
  if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
  if (BASE_URL) return `${BASE_URL}${relativeUrl.startsWith("/") ? "" : "/"}${relativeUrl}`;
  return relativeUrl;
}

function isGreeting(text = "") {
  const lower = normalizeText(text);
  return ["hi", "hello", "hey", "start", "menu"].includes(lower);
}

function createEmptySession() {
  return {
    stage: null,
    selectedService: null,
    learningType: null,
    pendingFile: null,
    lastJobId: null,
    lastMenuShownAt: null
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
4 - Solve Homework

You can send text, upload a file, or send a voice note depending on what you need.`;
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

  if (lower === "1" || lower.includes("print")) return "PRINT";
  if (lower === "2" || lower.includes("laminate")) return "LAMINATE";
  if (lower === "3" || lower.includes("image editing") || lower === "image edit") return "IMAGE_EDIT";
  if (lower === "4" || lower.includes("video editing") || lower === "video edit") return "VIDEO_EDIT";
  if (lower === "5" || lower.includes("id photo") || lower === "id") return "ID_PHOTO";
  if (lower === "6" || lower.includes("lesson") || lower.includes("homework") || lower.includes("quiz") || lower.includes("transcript")) return "LEARNING";
  if (lower === "7" || lower.includes("need shipping") || lower === "shipping") return "SHIPPING";

  return null;
}

function parsePrintDetails(text = "") {
  const lower = normalizeText(text);

  let copies = 1;
  let pages = 1;
  let paper_size = "";
  let color_mode = "";

  const copiesMatch = lower.match(/(\d+)\s*cop(y|ies)/);
  if (copiesMatch) copies = safeInt(copiesMatch[1], 1);

  const pagesMatch = lower.match(/(\d+)\s*page(s)?/);
  if (pagesMatch) pages = safeInt(pagesMatch[1], 1);

  if (lower.includes("a4")) paper_size = "A4";
  else if (lower.includes("a3")) paper_size = "A3";
  else if (lower.includes("letter")) paper_size = "LETTER";
  else if (lower.includes("legal")) paper_size = "LEGAL";
  else if (lower.includes("tabloid")) paper_size = "TABLOID";
  else if (lower.includes("card")) paper_size = "CARD";

  if (
    lower.includes("black and white") ||
    lower.includes("b&w") ||
    lower.includes("bw")
  ) {
    color_mode = "bw";
  } else if (lower.includes("color") || lower.includes("colour")) {
    color_mode = "color";
  }

  return { copies, pages, paper_size, color_mode };
}

function estimatePrintCost({ pages = 1, copies = 1, color_mode = "bw" } = {}) {
  const rate = normalizeText(color_mode) === "color" ? PRINT_PRICING.color : PRINT_PRICING.bw;
  return Number((safeInt(pages, 1) * safeInt(copies, 1) * rate).toFixed(2));
}

function estimateLaminateCost({ paper_size = "LETTER", copies = 1 } = {}) {
  const size = String(paper_size || "LETTER").toUpperCase();
  const rate = LAMINATE_PRICING[size] || LAMINATE_PRICING.LETTER;
  return Number((safeInt(copies, 1) * rate).toFixed(2));
}

function chooseRouteForJob(input = {}) {
  const service = String(input.service || "");
  const paperSize = String(input.paper_size || input.paperSize || "").toUpperCase();
  const explicitPrinter = input.printer_id || input.printerId || "";

  if (explicitPrinter) return explicitPrinter;

  if (service === "IMAGE_EDIT" || service === "VIDEO_EDIT" || service === "ID_PHOTO" || service === "LEARNING") {
    return AGENT_QUEUE_ID;
  }

  if (service === "SHIPPING") {
    return DISPATCH_QUEUE_ID;
  }

  if (service === "LAMINATE") {
    return DISPATCH_QUEUE_ID;
  }

  if (paperSize === "A3" || paperSize === "TABLOID") {
    return A3_PRINTER_ID;
  }

  if (paperSize === "CARD" || service === "CARD") {
    return CARD_PRINTER_ID;
  }

  if (service === "PRINT") {
    return DEFAULT_PRINTER_ID;
  }

  return DISPATCH_QUEUE_ID;
}

function getPrinterOptionsHtml(selected = "") {
  return PRINTERS.map((p) => {
    const isSelected = String(p.id) === String(selected) ? "selected" : "";
    return `<option value="${p.id}" ${isSelected}>${p.id}</option>`;
  }).join("");
}

function upsertJobForSession(from, session, extra = {}) {
  const existing = session.lastJobId
    ? jobs.find((j) => j.id === Number(session.lastJobId))
    : null;

  const mergedFile = extra.file || session.pendingFile || existing?.file || null;
  const service = extra.service || session.selectedService || existing?.service || null;
  const paper_size = extra.paper_size || extra.paperSize || existing?.paper_size || null;
  const color_mode = extra.color_mode || extra.colorMode || existing?.color_mode || "";
  const copies =
    extra.copies !== undefined ? safeInt(extra.copies, 1) : safeInt(existing?.copies, 1);
  const pages =
    extra.pages !== undefined ? safeInt(extra.pages, 1) : safeInt(existing?.pages, 1);
  const printer_id =
    extra.printer_id ||
    existing?.printer_id ||
    chooseRouteForJob({
      service,
      paper_size
    });

  const total_cost =
    service === "LAMINATE"
      ? estimateLaminateCost({ paper_size, copies })
      : service === "PRINT"
      ? estimatePrintCost({ pages, copies, color_mode })
      : safeInt(existing?.total_cost, 0);

  if (existing) {
    Object.assign(existing, {
      customer_phone: from || existing.customer_phone || "",
      customer_name: extra.customer_name || existing.customer_name || "",
      customer_email: extra.customer_email || existing.customer_email || "",
      service,
      printer_id,
      file: mergedFile,
      status: extra.status || existing.status || "pending",
      instructions:
        extra.instructions !== undefined ? extra.instructions : existing.instructions || "",
      instruction_audio_url:
        extra.instructionAudioUrl !== undefined
          ? extra.instructionAudioUrl
          : existing.instruction_audio_url || "",
      instruction_audio:
        extra.instructionAudio !== undefined
          ? extra.instructionAudio
          : existing.instruction_audio || null,
      shipping_details:
        extra.shippingDetails !== undefined
          ? extra.shippingDetails
          : existing.shipping_details || "",
      learning_type:
        extra.learningType !== undefined
          ? extra.learningType
          : existing.learning_type || session.learningType || "",
      paper_size,
      color_mode,
      copies,
      pages,
      notes: extra.notes !== undefined ? extra.notes : existing.notes || "",
      error_message:
        extra.error_message !== undefined
          ? extra.error_message
          : existing.error_message || "",
      total_cost,
      updated_at: nowIso()
    });

    return existing;
  }

  const job = {
    id: jobCounter++,
    public_job_id: `MSTAF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    customer_phone: from || extra.customer_phone || "",
    customer_name: extra.customer_name || "",
    customer_email: extra.customer_email || "",
    service,
    printer_id,
    file: mergedFile,
    status: extra.status || "pending",
    instructions: extra.instructions || "",
    instruction_audio_url: extra.instructionAudioUrl || "",
    instruction_audio: extra.instructionAudio || null,
    shipping_details: extra.shippingDetails || "",
    learning_type: extra.learningType || session.learningType || "",
    paper_size,
    color_mode,
    copies,
    pages,
    total_cost,
    notes: extra.notes || "",
    error_message: "",
    created_at: nowIso(),
    updated_at: nowIso()
  };

  jobs.unshift(job);
  session.lastJobId = job.id;
  return job;
}

function findJob(id) {
  return jobs.find((j) => j.id === Number(id));
}

function updateJob(job, patch = {}) {
  Object.assign(job, patch, { updated_at: nowIso() });
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

    return {
      mediaId,
      mimeType,
      filename,
      filepath,
      url: `/uploads/${filename}`,
      publicUrl: publicFileUrl(`/uploads/${filename}`)
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

function renderFilePreview(job) {
  if (!job.file || !job.file.url) {
    return `
      <div class="panel">
        <div class="panel-title">File</div>
        <div class="instruction">No file attached</div>
      </div>
    `;
  }

  const mime = String(job.file.mime_type || "");
  const url = job.file.url;

  if (mime.startsWith("image")) {
    return `
      <div class="panel">
        <div class="panel-title">File Preview</div>
        <img class="preview" src="${url}" alt="file preview" />
        <div class="media-links">
          <a class="btnlink" target="_blank" href="${url}">Open File</a>
        </div>
      </div>
    `;
  }

  if (mime.startsWith("video")) {
    return `
      <div class="panel">
        <div class="panel-title">File Preview</div>
        <video class="preview" controls preload="metadata" src="${url}"></video>
        <div class="media-links">
          <a class="btnlink" target="_blank" href="${url}">Open File</a>
        </div>
      </div>
    `;
  }

  return `
    <div class="panel">
      <div class="panel-title">File Preview</div>
      <div class="instruction">File attached and ready.</div>
      <div class="media-links">
        <a class="btnlink" target="_blank" href="${url}">Open File</a>
      </div>
    </div>
  `;
}

function renderAudioPreview(job) {
  if (!job.instruction_audio_url) return "";

  return `
    <div class="panel">
      <div class="panel-title">Audio Instruction</div>
      <audio controls preload="metadata" src="${job.instruction_audio_url}"></audio>
      <div class="media-links">
        <a class="btnlink" target="_blank" href="${job.instruction_audio_url}">Open Audio</a>
      </div>
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
    printers: PRINTERS
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
// UPLOAD / PRINT-JOBS
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
    const file = req.file
      ? {
          type: "document",
          url: `/uploads/${req.file.filename}`,
          publicUrl: publicFileUrl(`/uploads/${req.file.filename}`),
          filename: req.file.filename,
          mime_type: req.file.mimetype
        }
      : null;

    const service = String(req.body.service_type || req.body.serviceType || "PRINT").toUpperCase();
    const paper_size = String(req.body.paper_size || req.body.paperSize || "").toUpperCase();
    const color_mode = String(req.body.color_mode || req.body.colorMode || "").toLowerCase();
    const copies = safeInt(req.body.copies, 1);
    const pages = safeInt(req.body.pages, 1);

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
      total_cost:
        service === "LAMINATE"
          ? estimateLaminateCost({ paper_size, copies })
          : service === "PRINT"
          ? estimatePrintCost({ pages, copies, color_mode })
          : 0,
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

  const job = findJob(req.params.id);
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  const printer_id = String(req.body.printer_id || "").trim();
  if (!printer_id) {
    return res.status(400).json({ ok: false, error: "printer_id is required" });
  }

  updateJob(job, {
    printer_id,
    status: "pending",
    error_message: ""
  });

  res.json({ ok: true, job });
});

app.post("/api/dashboard/jobs/:id/mark", (req, res) => {
  if (!authDashboard(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const job = findJob(req.params.id);
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  const status = String(req.body.status || "").trim() || job.status;
  const error_message = String(req.body.error_message || "").trim();

  updateJob(job, { status, error_message });
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
  const job = findJob(id);

  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  if (!printer_id) {
    return res.status(400).json({ ok: false, error: "printer_id is required" });
  }

  updateJob(job, {
    printer_id: String(printer_id),
    status: "pending",
    error_message: ""
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

  updateJob(nextJob, { status: "printing" });
  res.json({ ok: true, job: nextJob });
});

app.post("/api/worker/jobs/:id/status", (req, res) => {
  const allow = authWorker(req) || authDashboard(req);
  if (!allow) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const job = findJob(req.params.id);
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  const status = String(req.body.status || "").trim() || job.status;
  const error_message = String(req.body.error_message || "").trim();

  updateJob(job, { status, error_message });
  res.json({ ok: true, job });
});

app.post("/api/worker/status", (req, res) => {
  const allow = authWorker(req) || authDashboard(req);
  if (!allow) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const job = findJob(req.body.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  updateJob(job, {
    status: String(req.body.status || "").trim() || job.status,
    error_message: String(req.body.error_message || "").trim()
  });

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
// WEBHOOK (MAIN BOT LOGIC)
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const type = message.type;

    const session = getSession(from);

    let text = "";

    if (type === "text") {
      text = message.text.body;
    }

    // =========================
    // HANDLE MEDIA (IMAGE/DOC/VIDEO/AUDIO)
    // =========================
    let incomingFile = null;

    if (
      type === "document" ||
      type === "image" ||
      type === "video" ||
      type === "audio"
    ) {
      const mediaId =
        message[type]?.id ||
        message.document?.id ||
        message.image?.id ||
        message.video?.id ||
        message.audio?.id;

      const downloaded = await downloadWhatsAppMedia(mediaId);

      if (downloaded) {
        incomingFile = {
          type,
          url: downloaded.publicUrl,
          filename: downloaded.filename,
          mime_type: downloaded.mimeType,
          mediaId: downloaded.mediaId
        };

        session.pendingFile = incomingFile;

        // If AUDIO → treat as instruction automatically
        if (type === "audio") {
          upsertJobForSession(from, session, {
            instructionAudioUrl: incomingFile.url,
            instructionAudio: incomingFile
          });

          await sendMessage(
            from,
            "🎤 Voice instruction received.\n\nYou can continue or select a service."
          );
        }
      }
    }

    // =========================
    // GREETING (DO NOT BREAK FLOW)
    // =========================
    if (isGreeting(text) && !session.stage) {
      await sendMessage(
        from,
        `Hello 👋 Welcome to PATAPATA Print-O-Matic

Send your PDF, image, document, video, or audio.

Or choose a service below 👇

${serviceMenuText()}`
      );
      return res.sendStatus(200);
    }

    // =========================
    // REFERRALS (RIDE / MECHANIC / RENT)
    // =========================
    const referral = detectReferralIntent(text);

    if (referral) {
      if (referral === "RIDE") {
        await sendMessage(
          from,
          `🚗 Ride to Work

Call: ${CONTACTS.RIDE}`
        );
      }

      if (referral === "MECHANIC") {
        await sendMessage(
          from,
          `🔧 Auto Mechanic

Call: ${CONTACTS.MECHANIC}`
        );
      }

      if (referral === "APARTMENT") {
        await sendMessage(
          from,
          `🏠 Apartment Rental

Call: ${CONTACTS.APARTMENT}`
        );
      }

      return res.sendStatus(200);
    }

    // =========================
    // SERVICE SELECTION
    // =========================
    const selectedService = mapSelectionToService(text);

    if (selectedService) {
      session.selectedService = selectedService;

      // LEARNING MODE
      if (selectedService === "LEARNING") {
        session.stage = "LEARNING_MENU";

        await sendMessage(from, learningMenuText());
        return res.sendStatus(200);
      }

      // SHIPPING
      if (selectedService === "SHIPPING") {
        session.stage = "SHIPPING_DETAILS";

        await sendMessage(
          from,
          `📦 Shipping Request

Please enter your delivery details:

Name, Address, City, Country`
        );
        return res.sendStatus(200);
      }

      // NORMAL SERVICES
      session.stage = "SERVICE_SELECTED";

      await sendMessage(
        from,
        `✅ ${selectedService} selected.

You can:
• Upload file
• Send instructions (text or voice)

Then confirm to proceed.`
      );

      return res.sendStatus(200);
    }

    // =========================
    // LEARNING MENU FLOW
    // =========================
    if (session.stage === "LEARNING_MENU") {
      const choice = normalizeText(text);

      if (choice === "1") session.learningType = "TRANSCRIPT";
      if (choice === "2") session.learningType = "QUIZ";
      if (choice === "3") session.learningType = "EXPLAIN";
      if (choice === "4") session.learningType = "HOMEWORK";

      if (!session.learningType) {
        await sendMessage(from, "Please select 1–4.");
        return res.sendStatus(200);
      }

      session.stage = "LEARNING_INPUT";

      await sendMessage(
        from,
        `📚 ${session.learningType} selected.

Send:
• Text
• File
• Voice note

We will process it for you.`
      );

      return res.sendStatus(200);
    }

    if (session.stage === "LEARNING_INPUT") {
      const job = upsertJobForSession(from, session, {
        service: "LEARNING",
        instructions: text,
        learningType: session.learningType
      });

      await sendMessage(
        from,
        `✅ Learning request received.

Type: ${session.learningType}

Your request is being processed by an agent.`
      );

      return res.sendStatus(200);
    }

    // =========================
    // SHIPPING DETAILS
    // =========================
    if (session.stage === "SHIPPING_DETAILS") {
      const job = upsertJobForSession(from, session, {
        service: "SHIPPING",
        shippingDetails: text
      });

      await sendMessage(
        from,
        `📦 Shipping request received.

Our agent will contact you shortly.`
      );

      return res.sendStatus(200);
    }

    // =========================
    // PRINT / LAMINATE DETAILS
    // =========================
    if (session.selectedService === "PRINT") {
      const parsed = parsePrintDetails(text);

      const job = upsertJobForSession(from, session, {
        service: "PRINT",
        ...parsed,
        instructions: text
      });

      await sendMessage(
        from,
        `🖨 Print job updated

Pages: ${job.pages}
Copies: ${job.copies}
Size: ${job.paper_size || "Not set"}
Color: ${job.color_mode || "Not set"}

💰 Estimated: $${job.total_cost}

Checkout:
${LINKS.PRINT_CHECKOUT}`
      );

      return res.sendStatus(200);
    }

    if (session.selectedService === "LAMINATE") {
      const parsed = parsePrintDetails(text);

      const job = upsertJobForSession(from, session, {
        service: "LAMINATE",
        ...parsed,
        instructions: text
      });

      await sendMessage(
        from,
        `🧾 Lamination updated

Copies: ${job.copies}
Size: ${job.paper_size || "LETTER"}

💰 Estimated: $${job.total_cost}

Proceed:
${LINKS.LAMINATE_CHECKOUT}`
      );

      return res.sendStatus(200);
    }

    // =========================
    // FILE RECEIVED WITHOUT SERVICE
    // =========================
    if (incomingFile && !session.selectedService) {
      await sendMessage(from, serviceMenuText(true));
      return res.sendStatus(200);
    }

    // =========================
    // DEFAULT FALLBACK
    // =========================
    await sendMessage(from, serviceMenuText());

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    return res.sendStatus(200);
  }
});

// =========================
// DASHBOARD UI (FIXED)
// =========================
app.get("/dashboard", (req, res) => {
  const key = req.query.key || "";
  if (DASHBOARD_KEY && key !== DASHBOARD_KEY) {
    return res.status(401).send("Unauthorized");
  }

  const rows = jobs
    .map(
      (j) => `
<tr>
<td>${j.id}</td>
<td>${j.service}</td>
<td>${j.printer_id}</td>
<td>${j.status}</td>
<td>${j.learning_type || ""}</td>
<td>${j.instructions || ""}</td>
<td>${j.shipping_details || ""}</td>
<td>${j.total_cost}</td>
<td>
  <form method="POST" action="/dashboard/route?key=${key}">
    <input type="hidden" name="id" value="${j.id}" />
    <select name="printer_id">
      ${getPrinterOptionsHtml(j.printer_id)}
    </select>
    <button>Route</button>
  </form>
</td>
<td>
  ${renderFilePreview(j)}
  ${renderAudioPreview(j)}
</td>
</tr>
`
    )
    .join("");

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>MSTAF Dashboard</title>
<style>
body { font-family: Arial; background:#111; color:#fff; }
table { width:100%; border-collapse:collapse; }
td, th { border:1px solid #333; padding:8px; }
.panel { margin-top:10px; }
.preview { max-width:200px; }
</style>
</head>
<body>
<h2>MSTAF Dashboard</h2>
<table>
<tr>
<th>ID</th>
<th>Service</th>
<th>Printer</th>
<th>Status</th>
<th>Learning</th>
<th>Instructions</th>
<th>Shipping</th>
<th>Cost</th>
<th>Route</th>
<th>Media</th>
</tr>
${rows}
</table>
</body>
</html>
`);
});

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
