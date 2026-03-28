const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

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
      .slice(-90);

    cb(null, `${Date.now()}_${Math.random().toString(16).slice(2)}_${safe}`);
  }
});
const upload = multer({ storage });

// =========================
// ENV / CONFIG
// =========================
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const DASHBOARD_KEY = process.env.DASHBOARD_KEY || "";
const WORKER_KEY = process.env.WORKER_KEY || process.env.PRINTER_KEY || "";
const PRINTER_KEY = process.env.PRINTER_KEY || process.env.WORKER_KEY || "";

const DEFAULT_PRINTER_ID = process.env.DEFAULT_PRINTER_ID || "PP-USA-001";
const A3_PRINTER_ID = process.env.A3_PRINTER_ID || "PP-USA-A3-001";
const CARD_PRINTER_ID = process.env.CARD_PRINTER_ID || "PP-USA-CARD-001";
const DISPATCH_QUEUE_ID = process.env.DISPATCH_QUEUE_ID || "DISPATCH";
const AGENT_QUEUE_ID = process.env.AGENT_QUEUE_ID || "AGENT";

const CONTACTS = {
  RIDE: process.env.RIDE_TO_WORK_CONTACTS || "+1 862 230 6637",
  MECHANIC: process.env.AUTO_MECHANIC_CONTACTS || "+1 862 230 6637",
  APARTMENT: process.env.APARTMENT_CONTACTS || "+1 862 230 6637",
  SHIPPING: process.env.SHIPPING_CONTACTS || "+1 862 230 6637"
};

const LINKS = {
  PRINT_CHECKOUT:
    process.env.PRINT_CHECKOUT_LINK || "https://www.patapata.us/cart/52221221437739:1",
  LAMINATE_CHECKOUT:
    process.env.LAMINATE_CHECKOUT_LINK || "https://www.patapata.us/pages/how-to-upload",
  HOW_TO_UPLOAD:
    process.env.HOW_TO_UPLOAD_LINK || "https://www.patapata.us/pages/how-to-upload"
};

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

function isGreeting(text = "") {
  const lower = normalizeText(text);
  return ["hi", "hello", "hey", "start", "menu"].includes(lower);
}

function createEmptySession() {
  return {
    stage: null,
    selectedService: null,
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
6 - Need Shipping

Or type:
🚗 Ride to work
🔧 Find mechanic
🏠 Rent apartment`;
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
  if (lower === "6" || lower.includes("need shipping") || lower === "shipping") return "SHIPPING";

  return null;
}

function safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function chooseRouteForJob(input = {}) {
  const service = String(input.service || "");
  const paperSize = String(input.paper_size || input.paperSize || "").toUpperCase();
  const explicitPrinter = input.printer_id || input.printerId || "";

  if (explicitPrinter) return explicitPrinter;

  if (service === "IMAGE_EDIT" || service === "VIDEO_EDIT" || service === "ID_PHOTO") {
    return AGENT_QUEUE_ID;
  }

  if (service === "SHIPPING") {
    return DISPATCH_QUEUE_ID;
  }

  if (paperSize === "A3" || paperSize === "TABLOID" || paperSize === "CARD" || service === "CARD") {
    return DISPATCH_QUEUE_ID;
  }

  if (service === "LAMINATE") {
    return DISPATCH_QUEUE_ID;
  }

  if (service === "PRINT") {
    return DEFAULT_PRINTER_ID;
  }

  return DISPATCH_QUEUE_ID;
}

function createJob(from, session, extra = {}) {
  const service = extra.service || session.selectedService || null;
  const paper_size = extra.paper_size || extra.paperSize || null;
  const printer_id = chooseRouteForJob({
    service,
    paper_size,
    printer_id: extra.printer_id
  });

  const job = {
    id: jobCounter++,
    public_job_id: `MSTAF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    customer_phone: from || extra.customer_phone || "",
    customer_name: extra.customer_name || "",
    customer_email: extra.customer_email || "",
    service,
    printer_id,
    file: extra.file || session.pendingFile || null,
    status: extra.status || "pending",

    instructions: extra.instructions || "",
    instruction_audio_url: extra.instructionAudioUrl || "",
    instruction_audio: extra.instructionAudio || null,

    shipping_details: extra.shippingDetails || "",
    paper_size,
    color_mode: extra.color_mode || extra.colorMode || "",
    copies: safeInt(extra.copies, 1),
    pages: safeInt(extra.pages, 1),
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
  const key = req.headers["x-worker-key"] || req.headers["x-printer-key"] || req.query.key || "";
  return key === WORKER_KEY || key === PRINTER_KEY;
}

function dashboardKeySuffix() {
  return DASHBOARD_KEY ? `?key=${encodeURIComponent(DASHBOARD_KEY)}` : "";
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
      "application/pdf": ".pdf"
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
      url: `/uploads/${filename}`
    };
  } catch (err) {
    console.error("Media download failed:", err.response?.data || err.message);
    return null;
  }
}

function renderStatusBadge(status = "") {
  const s = String(status);
  if (s === "completed" || s === "done") return "badge done";
  if (s === "printing") return "badge live";
  if (s === "error") return "badge error";
  return "badge";
}

// =========================
// HEALTH / ROOT
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
    }
  });
});

// =========================
// MANUAL UPLOAD
// =========================
app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "No file uploaded" });
  }

  return res.json({
    ok: true,
    file_url: `/uploads/${req.file.filename}`,
    original_name: req.file.originalname
  });
});

// =========================
// JOB LIST / DEBUG
// =========================
app.get("/jobs", (req, res) => {
  res.json({ ok: true, count: jobs.length, jobs });
});

// =========================
// DASHBOARD DATA API
// =========================
app.get("/api/dashboard/jobs", (req, res) => {
  if (!authDashboard(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const printer_id = String(req.query.printer_id || "").trim();
  const status = String(req.query.status || "").trim().toLowerCase();
  const q = normalizeText(req.query.q || "");

  let filtered = [...jobs];

  if (printer_id) {
    filtered = filtered.filter((j) => String(j.printer_id || "") === printer_id);
  }

  if (status) {
    filtered = filtered.filter((j) => normalizeText(j.status) === status);
  }

  if (q) {
    filtered = filtered.filter((j) =>
      [
        j.public_job_id,
        j.service,
        j.printer_id,
        j.customer_phone,
        j.instructions,
        j.shipping_details,
        j.error_message,
        j.file?.filename,
        j.file?.url
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

  return res.json({ ok: true, job });
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
  return res.json({ ok: true, job });
});

// =========================
// DISPATCH API
// =========================
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

  return res.json({ ok: true, job });
});

// =========================
// WORKER API
// =========================
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

  return res.json({ ok: true, job: nextJob });
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
  return res.json({ ok: true, job });
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

  return res.json({ ok: true, job });
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
});

// =========================
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

    // GREETING
    if (type === "text" && isGreeting(lower)) {
      resetSession(from);
      const freshSession = getSession(from);
      freshSession.lastMenuShownAt = Date.now();

      await sendMessage(from, `Hello 👋 Welcome to PATAPATA Print-O-Matic\n\n${serviceMenuText(false)}`);
      return res.sendStatus(200);
    }

    // REFERRAL FLOWS
    const referralIntent = type === "text" ? detectReferralIntent(lower) : null;

    if (referralIntent === "RIDE") {
      session.selectedService = "RIDE";
      session.stage = "referral_shared";
      await sendMessage(
        from,
        `🚗 Ride to Work:\nCall ${CONTACTS.RIDE}\n\nAfter your call, reply here on WhatsApp and we can continue chatting with you about the cost or next step.`
      );
      return res.sendStatus(200);
    }

    if (referralIntent === "MECHANIC") {
      session.selectedService = "MECHANIC";
      session.stage = "referral_shared";
      await sendMessage(
        from,
        `🔧 Auto Mechanic:\nCall ${CONTACTS.MECHANIC}\n\nAfter your call, reply here on WhatsApp and we can continue chatting with you about the cost or next step.`
      );
      return res.sendStatus(200);
    }

    if (referralIntent === "APARTMENT") {
      session.selectedService = "APARTMENT";
      session.stage = "referral_shared";
      await sendMessage(
        from,
        `🏠 Apartment Rentals:\nCall ${CONTACTS.APARTMENT}\n\nAfter your call, reply here on WhatsApp and we can continue chatting with you here if needed.`
      );
      return res.sendStatus(200);
    }

    if (referralIntent === "SHIPPING") {
      session.selectedService = "SHIPPING";
      session.stage = "awaiting_shipping_details";
      await sendMessage(
        from,
        `📦 Need Shipping selected.\n\nPlease send your shipping details:\n- pickup or delivery\n- item type\n- destination city/state\n- quantity/weight if known\n\nYou can type the details or send a voice note.`
      );
      return res.sendStatus(200);
    }

    // PRINT / LAMINATE PAY OR CHAT
    if (type === "text" && lower === "1") {
      if (session.stage === "print_selected") {
        await sendMessage(
          from,
          `🛒 Printing payment:\n${LINKS.PRINT_CHECKOUT}\n\nAfter payment, reply here on WhatsApp if you want us to continue with your order.`
        );
        session.stage = "checkout_shared";
        return res.sendStatus(200);
      }

      if (session.stage === "laminate_selected") {
        await sendMessage(
          from,
          `🛒 Laminating payment:\n${LINKS.LAMINATE_CHECKOUT}\n\nAfter payment, reply here on WhatsApp if you want us to continue with your order.`
        );
        session.stage = "checkout_shared";
        return res.sendStatus(200);
      }
    }

    if (type === "text" && lower === "2") {
      if (session.stage === "print_selected") {
        session.stage = "awaiting_followup_details";
        await sendMessage(
          from,
          `✅ Okay.\n\nPlease send your print details here on WhatsApp, such as copies, pages, color mode, paper size, delivery/pickup, or any special instructions.\n\nYou can type the instruction or send a voice note.\n\nOur team will reply here with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "laminate_selected") {
        session.stage = "awaiting_followup_details";
        await sendMessage(
          from,
          `✅ Okay.\n\nPlease send your laminating details here on WhatsApp, such as size, quantity, and any special instructions.\n\nYou can type the instruction or send a voice note.\n\nOur team will reply here with the cost or next step.`
        );
        return res.sendStatus(200);
      }
    }

    // AUDIO AS INSTRUCTION / DETAILS
    if (type === "audio") {
      const mediaId = message.audio?.id;
      const downloaded = await downloadWhatsAppMedia(mediaId);

      if (session.stage === "awaiting_instructions") {
        const job = createJob(from, session, {
          instructions: "[Audio instruction received via WhatsApp voice note]",
          instructionAudioUrl: downloaded?.url || "",
          instructionAudio: downloaded || null
        });

        session.stage = "instruction_received";

        let label = "service";
        if (session.selectedService === "IMAGE_EDIT") label = "image editing";
        if (session.selectedService === "VIDEO_EDIT") label = "video editing";
        if (session.selectedService === "ID_PHOTO") label = "ID photo";

        await sendMessage(
          from,
          `✅ Your ${label} audio instruction has been received successfully.\n\nJob ID: ${job.id}\n\nOur agent will review it and reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "awaiting_followup_details") {
        const job = createJob(from, session, {
          instructions: "[Audio follow-up instruction received via WhatsApp voice note]",
          instructionAudioUrl: downloaded?.url || "",
          instructionAudio: downloaded || null,
          printer_id:
            session.selectedService === "PRINT"
              ? DEFAULT_PRINTER_ID
              : session.selectedService === "LAMINATE"
              ? DISPATCH_QUEUE_ID
              : undefined
        });

        session.stage = "followup_received";

        await sendMessage(
          from,
          `✅ Your audio details have been received.\n\nJob ID: ${job.id}\n\nWe will reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "awaiting_shipping_details") {
        const job = createJob(from, session, {
          shippingDetails: "[Audio shipping details received via WhatsApp voice note]",
          instructionAudioUrl: downloaded?.url || "",
          instructionAudio: downloaded || null,
          service: "SHIPPING",
          printer_id: DISPATCH_QUEUE_ID
        });

        session.stage = "shipping_received";

        await sendMessage(
          from,
          `✅ Your shipping audio details have been received successfully.\n\nJob ID: ${job.id}\n\nWe will review the details and reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }
    }

    // FILE RECEIVED
    if (["image", "document", "video", "audio"].includes(type)) {
      let mediaId = null;

      if (type === "image") mediaId = message.image?.id;
      if (type === "document") mediaId = message.document?.id;
      if (type === "video") mediaId = message.video?.id;
      if (type === "audio") mediaId = message.audio?.id;

      const downloaded = await downloadWhatsAppMedia(mediaId);

      session.pendingFile = {
        type,
        media_id: mediaId,
        url: downloaded?.url || null,
        filename: downloaded?.filename || null,
        mime_type: downloaded?.mimeType || null
      };

      if (session.stage === "awaiting_file_for_image" && session.selectedService === "IMAGE_EDIT") {
        session.stage = "awaiting_instructions";
        await sendMessage(
          from,
          `✅ Your image file has been received.\n\nNow send your instructions.\nYou can type the instruction or send a voice note.\n\nAfter review, our agent will reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "awaiting_file_for_video" && session.selectedService === "VIDEO_EDIT") {
        session.stage = "awaiting_instructions";
        await sendMessage(
          from,
          `✅ Your video file has been received.\n\nNow send your instructions.\nYou can type the instruction or send a voice note.\n\nAfter review, our agent will reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "awaiting_file_for_id" && session.selectedService === "ID_PHOTO") {
        session.stage = "awaiting_instructions";
        await sendMessage(
          from,
          `✅ Your photo has been received.\n\nNow send your instructions.\nYou can type the instruction or send a voice note.\n\nAfter review, our agent will reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "awaiting_file_for_print" && session.selectedService === "PRINT") {
        createJob(from, session, {
          service: "PRINT",
          printer_id: DEFAULT_PRINTER_ID
        });
        session.stage = "print_selected";
        await sendMessage(
          from,
          `🖨 Printing selected.\n\nYour file has been received.\n\nReply with:\n1 - Pay on Shopify now\n2 - Chat here on WhatsApp for assistance, pricing, or special instructions`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "awaiting_file_for_laminate" && session.selectedService === "LAMINATE") {
        createJob(from, session, {
          service: "LAMINATE",
          printer_id: DISPATCH_QUEUE_ID
        });
        session.stage = "laminate_selected";
        await sendMessage(
          from,
          `📄 Laminating selected.\n\nYour file has been received.\n\nPrices:\nLetter $1.50\nLegal $2.00\nTabloid $3.00\n\nReply with:\n1 - Pay on Shopify now\n2 - Chat here on WhatsApp for assistance or special instructions`
        );
        return res.sendStatus(200);
      }

      session.stage = "awaiting_service";
      session.selectedService = null;

      await sendMessage(from, serviceMenuText(true));
      return res.sendStatus(200);
    }

    // YES CHECKOUT
    if (type === "text" && lower === "yes") {
      if (session.selectedService === "PRINT") {
        await sendMessage(
          from,
          `🛒 Printing payment:\n${LINKS.PRINT_CHECKOUT}\n\nAfter payment, reply here on WhatsApp if you want us to continue with your order.`
        );
        session.stage = "checkout_shared";
        return res.sendStatus(200);
      }

      if (session.selectedService === "LAMINATE") {
        await sendMessage(
          from,
          `🛒 Laminating payment:\n${LINKS.LAMINATE_CHECKOUT}\n\nAfter payment, reply here on WhatsApp if you want us to continue with your order.`
        );
        session.stage = "checkout_shared";
        return res.sendStatus(200);
      }

      await sendMessage(from, "✅ Okay. Send your file or details here and I will continue.");
      return res.sendStatus(200);
    }

    // MENU SELECTION
    if (type === "text") {
      const service = mapSelectionToService(lower);

      if (service) {
        session.selectedService = service;

        if (service === "PRINT") {
          if (!session.pendingFile) {
            session.stage = "awaiting_file_for_print";
            await sendMessage(
              from,
              `🖨 Printing selected.\n\nPlease upload your file first.\n\nAfter upload, you can:\n1 - Pay on Shopify now\n2 - Chat here on WhatsApp for assistance, pricing, or special instructions`
            );
            return res.sendStatus(200);
          }

          createJob(from, session, { service: "PRINT", printer_id: DEFAULT_PRINTER_ID });
          session.stage = "print_selected";

          await sendMessage(
            from,
            `🖨 Printing selected.\n\nYour file/details have been received.\n\nReply with:\n1 - Pay on Shopify now\n2 - Chat here on WhatsApp for assistance, pricing, or special instructions`
          );
          return res.sendStatus(200);
        }

        if (service === "LAMINATE") {
          if (!session.pendingFile) {
            session.stage = "awaiting_file_for_laminate";
            await sendMessage(
              from,
              `📄 Laminating selected.\n\nPlease upload your file first.\n\nAfter upload, you can:\n1 - Pay on Shopify now\n2 - Chat here on WhatsApp for assistance or special instructions`
            );
            return res.sendStatus(200);
          }

          createJob(from, session, { service: "LAMINATE", printer_id: DISPATCH_QUEUE_ID });
          session.stage = "laminate_selected";

          await sendMessage(
            from,
            `📄 Laminating selected.\n\nPrices:\nLetter $1.50\nLegal $2.00\nTabloid $3.00\n\nReply with:\n1 - Pay on Shopify now\n2 - Chat here on WhatsApp for assistance or special instructions\n\nYou can also send your size and quantity by text or voice note.`
          );
          return res.sendStatus(200);
        }

        if (service === "IMAGE_EDIT") {
          if (!session.pendingFile) {
            session.stage = "awaiting_file_for_image";
            await sendMessage(
              from,
              `🎨 Image Editing selected.\n\nPlease upload your image file first, then send your instructions.\nYou can type the instruction or send a voice note.`
            );
            return res.sendStatus(200);
          }

          session.stage = "awaiting_instructions";
          await sendMessage(
            from,
            `🎨 Image Editing selected.\n\nYour image file has been received.\nNow send your instructions.\n\nYou can type the instruction or send a voice note.\n\nAfter review, our agent will reply here on WhatsApp with the cost or next step.`
          );
          return res.sendStatus(200);
        }

        if (service === "VIDEO_EDIT") {
          if (!session.pendingFile) {
            session.stage = "awaiting_file_for_video";
            await sendMessage(
              from,
              `🎥 Video Editing selected.\n\nPlease upload your video file first, then send your instructions.\nYou can type the instruction or send a voice note.`
            );
            return res.sendStatus(200);
          }

          session.stage = "awaiting_instructions";
          await sendMessage(
            from,
            `🎥 Video Editing selected.\n\nYour video file has been received.\nNow send your instructions.\n\nYou can type the instruction or send a voice note.\n\nAfter review, our agent will reply here on WhatsApp with the cost or next step.`
          );
          return res.sendStatus(200);
        }

        if (service === "ID_PHOTO") {
          if (!session.pendingFile) {
            session.stage = "awaiting_file_for_id";
            await sendMessage(
              from,
              `🪪 ID Photo selected.\n\nPlease upload your photo first, then send your instructions.\n\nYou can type the instruction or send a voice note.`
            );
            return res.sendStatus(200);
          }

          session.stage = "awaiting_instructions";
          await sendMessage(
            from,
            `🪪 ID Photo selected.\n\nYour photo has been received.\nNow send your instructions.\n\nYou can type the instruction or send a voice note.\n\nAfter review, our agent will reply here on WhatsApp with the cost or next step.`
          );
          return res.sendStatus(200);
        }

        if (service === "SHIPPING") {
          session.stage = "awaiting_shipping_details";
          await sendMessage(
            from,
            `📦 Need Shipping selected.\n\nPlease send your shipping details:\n- pickup or delivery\n- item type\n- destination city/state\n- quantity/weight if known\n\nYou can type the details or send a voice note.`
          );
          return res.sendStatus(200);
        }
      }
    }

    // TEXT INSTRUCTIONS
    if (type === "text" && session.stage === "awaiting_instructions") {
      const job = createJob(from, session, { instructions: text.trim() });
      session.stage = "instruction_received";

      let label = "service";
      if (session.selectedService === "IMAGE_EDIT") label = "image editing";
      if (session.selectedService === "VIDEO_EDIT") label = "video editing";
      if (session.selectedService === "ID_PHOTO") label = "ID photo";

      await sendMessage(
        from,
        `✅ Your ${label} file and instructions have been received successfully.\n\nJob ID: ${job.id}\n\nOur agent will review it and reply here on WhatsApp with the cost or next step.`
      );
      return res.sendStatus(200);
    }

    // TEXT SHIPPING DETAILS
    if (type === "text" && session.stage === "awaiting_shipping_details") {
      const job = createJob(from, session, {
        service: "SHIPPING",
        shippingDetails: text.trim(),
        printer_id: DISPATCH_QUEUE_ID
      });
      session.stage = "shipping_received";

      await sendMessage(
        from,
        `✅ Your shipping request has been received successfully.\n\nJob ID: ${job.id}\n\nWe will review the details and reply here on WhatsApp with the cost or next step.`
      );
      return res.sendStatus(200);
    }

    // TEXT FOLLOWUP
    if (type === "text" && session.stage === "referral_shared") {
      await sendMessage(
        from,
        `✅ Message received.\n\nPlease send the details discussed on the call.\n\nYou can type the details or send a voice note, and we will continue with the pricing or next step here on WhatsApp.`
      );
      session.stage = "awaiting_followup_details";
      return res.sendStatus(200);
    }

    if (type === "text" && session.stage === "awaiting_followup_details") {
      const targetPrinter =
        session.selectedService === "PRINT"
          ? DEFAULT_PRINTER_ID
          : session.selectedService === "LAMINATE"
          ? DISPATCH_QUEUE_ID
          : DISPATCH_QUEUE_ID;

      const job = createJob(from, session, {
        instructions: text.trim(),
        printer_id: targetPrinter
      });

      session.stage = "followup_received";

      await sendMessage(
        from,
        `✅ Your details have been received.\n\nJob ID: ${job.id}\n\nWe will reply here on WhatsApp with the cost or next step.`
      );
      return res.sendStatus(200);
    }

    // DEFAULT
    await sendMessage(from, "Hello 👋 Send hello to start, or upload your file.");
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    return res.sendStatus(500);
  }
});

// =========================
// DASHBOARD HTML
// =========================
function renderDashboardPage(title, initialFilterPrinterId = "") {
  const key = dashboardKeySuffix();

  return `
  <html>
  <head>
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        font-family: Arial, sans-serif;
        background: #f3f4f6;
        color: #111827;
      }
      .topbar {
        background: #111827;
        color: white;
        padding: 16px 22px;
        font-size: 28px;
        font-weight: 700;
      }
      .subbar {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
        background: white;
        padding: 14px 22px;
        border-bottom: 1px solid #e5e7eb;
      }
      .subbar a {
        text-decoration: none;
        color: #111827;
        padding: 10px 12px;
        border-radius: 8px;
        background: #f3f4f6;
        font-weight: 600;
      }
      .subbar input, .subbar select {
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid #d1d5db;
      }
      .container {
        padding: 22px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: 18px;
      }
      .card {
        background: white;
        border-radius: 14px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.06);
        padding: 18px;
      }
      .muted {
        color: #6b7280;
      }
      .badge {
        display: inline-block;
        padding: 6px 10px;
        border-radius: 999px;
        background: #e5e7eb;
        font-size: 12px;
        font-weight: 700;
      }
      .badge.done { background: #dcfce7; color: #166534; }
      .badge.error { background: #fee2e2; color: #991b1b; }
      .badge.live { background: #dbeafe; color: #1d4ed8; }
      .row {
        margin-bottom: 8px;
        word-break: break-word;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }
      button, .btnlink {
        padding: 9px 12px;
        border-radius: 8px;
        border: none;
        cursor: pointer;
        font-weight: 700;
      }
      .btn-done { background: #16a34a; color: white; }
      .btn-error { background: #dc2626; color: white; }
      .btn-route { background: #2563eb; color: white; }
      .btn-open {
        background: #111827;
        color: white;
        text-decoration: none;
        display: inline-block;
      }
      .route-row {
        display: flex;
        gap: 8px;
        margin-top: 10px;
        flex-wrap: wrap;
      }
      select.route-select {
        min-width: 180px;
      }
      img.preview {
        max-width: 220px;
        max-height: 220px;
        border-radius: 10px;
        display: block;
        object-fit: cover;
        border: 1px solid #e5e7eb;
      }
      video.preview {
        width: 100%;
        max-width: 320px;
        border-radius: 10px;
        display: block;
        background: #000;
      }
      audio {
        width: 100%;
        max-width: 320px;
      }
      .empty {
        background: white;
        padding: 24px;
        border-radius: 14px;
      }
      .section-title {
        font-size: 14px;
        font-weight: 700;
        margin: 12px 0 6px;
      }
    </style>
  </head>
  <body>
    <div class="topbar">🖨 MSTAF Worker / Agent Dashboard</div>

    <div class="subbar">
      <a href="/dashboard${key}">Main</a>
      <a href="/dispatch${key}">Dispatch</a>
      <a href="/agent${key}">Agent</a>
      <a href="/printer${key}">Printer</a>

      <input id="q" placeholder="Search jobs">
      <select id="status">
        <option value="">All status</option>
        <option value="pending">pending</option>
        <option value="printing">printing</option>
        <option value="completed">completed</option>
        <option value="error">error</option>
      </select>

      <select id="printerFilter">
        <option value="">All routes</option>
        <option value="${DEFAULT_PRINTER_ID}">${DEFAULT_PRINTER_ID}</option>
        <option value="${A3_PRINTER_ID}">${A3_PRINTER_ID}</option>
        <option value="${CARD_PRINTER_ID}">${CARD_PRINTER_ID}</option>
        <option value="${DISPATCH_QUEUE_ID}">${DISPATCH_QUEUE_ID}</option>
        <option value="${AGENT_QUEUE_ID}">${AGENT_QUEUE_ID}</option>
      </select>

      <button onclick="loadJobs()">Refresh</button>
    </div>

    <div class="container">
      <div id="meta" class="muted" style="margin-bottom:12px;"></div>
      <div id="jobsWrap"><div class="empty">Loading jobs...</div></div>
    </div>

    <script>
      const DASH_KEY = ${JSON.stringify(DASHBOARD_KEY)};
      const INITIAL_PRINTER_ID = ${JSON.stringify(initialFilterPrinterId)};

      function headers() {
        return DASH_KEY ? { "x-dashboard-key": DASH_KEY, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
      }

      function esc(v) {
        return String(v == null ? "" : v)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      function mediaHTML(job) {
        if (!job.file || !job.file.url) return "";
        const mime = String(job.file.mime_type || "");
        const url = job.file.url;

        if (mime.startsWith("image")) {
          return '<div class="section-title">File Preview</div><img class="preview" src="' + url + '">';
        }
        if (mime.startsWith("video")) {
          return '<div class="section-title">Video Preview</div><video class="preview" controls preload="metadata" src="' + url + '"></video><div style="margin-top:8px;"><a class="btnlink btn-open" target="_blank" href="' + url + '">Open Video</a></div>';
        }
        return '<div class="section-title">File</div><a class="btnlink btn-open" target="_blank" href="' + url + '">📎 Open File</a>';
      }

      function audioHTML(job) {
        if (!job.instruction_audio_url) return "";
        const url = job.instruction_audio_url;
        return '<div class="section-title">Audio Instruction</div><audio controls preload="metadata" src="' + url + '"></audio><div style="margin-top:8px;"><a class="btnlink btn-open" target="_blank" href="' + url + '">Open Audio</a></div>';
      }

      async function routeJob(id) {
        const select = document.getElementById("route_" + id);
        const printer_id = select.value;
        if (!printer_id) return;

        await fetch("/api/dashboard/jobs/" + id + "/route", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ printer_id })
        });

        loadJobs();
      }

      async function markJob(id, status) {
        const error_message = status === "error" ? "Manual error from dashboard" : "";
        await fetch("/api/dashboard/jobs/" + id + "/mark", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ status, error_message })
        });

        loadJobs();
      }

      async function loadJobs() {
        const q = document.getElementById("q").value || "";
        const status = document.getElementById("status").value || "";
        let printer_id = document.getElementById("printerFilter").value || "";

        if (INITIAL_PRINTER_ID && !printer_id) {
          printer_id = INITIAL_PRINTER_ID;
          document.getElementById("printerFilter").value = INITIAL_PRINTER_ID;
        }

        const params = new URLSearchParams();
        if (q) params.set("q", q);
        if (status) params.set("status", status);
        if (printer_id) params.set("printer_id", printer_id);

        const res = await fetch("/api/dashboard/jobs?" + params.toString(), {
          headers: DASH_KEY ? { "x-dashboard-key": DASH_KEY } : {}
        });
        const data = await res.json();

        const meta = document.getElementById("meta");
        const wrap = document.getElementById("jobsWrap");

        meta.innerHTML = "Showing " + (data.count || 0) + " job(s)";

        if (!data.jobs || !data.jobs.length) {
          wrap.innerHTML = '<div class="empty">No jobs found.</div>';
          return;
        }

        wrap.innerHTML = '<div class="grid">' + data.jobs.map(job => {
          const statusClass =
            job.status === "completed" || job.status === "done" ? "badge done" :
            job.status === "printing" ? "badge live" :
            job.status === "error" ? "badge error" : "badge";

          return \`
            <div class="card">
              <div class="row"><strong>Job ID:</strong> \${esc(job.id)} <span class="\${statusClass}">\${esc(job.status)}</span></div>
              <div class="row"><strong>Public ID:</strong> \${esc(job.public_job_id || "")}</div>
              <div class="row"><strong>Service:</strong> \${esc(job.service || "")}</div>
              <div class="row"><strong>Route:</strong> \${esc(job.printer_id || "")}</div>
              <div class="row"><strong>Customer:</strong> \${esc(job.customer_phone || "")}</div>
              <div class="row"><strong>Instructions:</strong> \${esc(job.instructions || "None")}</div>
              <div class="row"><strong>Shipping:</strong> \${esc(job.shipping_details || "None")}</div>
              <div class="row"><strong>Error:</strong> \${esc(job.error_message || "None")}</div>
              <div class="row muted"><strong>Created:</strong> \${esc(job.created_at || "")}</div>

              \${mediaHTML(job)}
              \${audioHTML(job)}

              <div class="route-row">
                <select id="route_\${job.id}" class="route-select">
                  <option value="">Route job...</option>
                  <option value="${DEFAULT_PRINTER_ID}">${DEFAULT_PRINTER_ID}</option>
                  <option value="${A3_PRINTER_ID}">${A3_PRINTER_ID}</option>
                  <option value="${CARD_PRINTER_ID}">${CARD_PRINTER_ID}</option>
                  <option value="${DISPATCH_QUEUE_ID}">${DISPATCH_QUEUE_ID}</option>
                  <option value="${AGENT_QUEUE_ID}">${AGENT_QUEUE_ID}</option>
                </select>
                <button class="btn-route" onclick="routeJob(\${job.id})">Route</button>
              </div>

              <div class="actions">
                <button class="btn-done" onclick="markJob(\${job.id}, 'completed')">✅ Done</button>
                <button class="btn-error" onclick="markJob(\${job.id}, 'error')">❌ Error</button>
                <button onclick="markJob(\${job.id}, 'pending')">↩ Pending</button>
                <button onclick="markJob(\${job.id}, 'printing')">🖨 Printing</button>
              </div>
            </div>
          \`;
        }).join("") + "</div>";
      }

      loadJobs();
      setInterval(loadJobs, 5000);
    </script>
  </body>
  </html>
  `;
}

// =========================
// DASHBOARD ROUTES
// =========================
app.get("/dashboard", (req, res) => {
  if (!authDashboard(req)) {
    return res.status(401).send("Unauthorized");
  }
  res.send(renderDashboardPage("MSTAF Dashboard", ""));
});

app.get("/dispatch", (req, res) => {
  if (!authDashboard(req)) {
    return res.status(401).send("Unauthorized");
  }
  res.send(renderDashboardPage("MSTAF Dispatch", DISPATCH_QUEUE_ID));
});

app.get("/agent", (req, res) => {
  if (!authDashboard(req)) {
    return res.status(401).send("Unauthorized");
  }
  res.send(renderDashboardPage("MSTAF Agent", AGENT_QUEUE_ID));
});

app.get("/printer", (req, res) => {
  if (!authDashboard(req)) {
    return res.status(401).send("Unauthorized");
  }
  res.send(renderDashboardPage("MSTAF Printer", DEFAULT_PRINTER_ID));
});

// =========================
// START
// =========================
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
