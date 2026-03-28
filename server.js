const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ===== UPLOAD FOLDER =====
const UPLOAD_DIR = path.resolve(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

// ===== MULTER SETUP =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = (file.originalname || "file")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(-90);

    cb(null, `${Date.now()}_${Math.random().toString(16).slice(2)}_${safe}`);
  }
});

const upload = multer({ storage });

// ===== WHATSAPP CONFIG =====
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// ===== CONTACTS =====
const CONTACTS = {
  RIDE: process.env.RIDE_TO_WORK_CONTACTS || "+1 862 230 6637",
  MECHANIC: process.env.AUTO_MECHANIC_CONTACTS || "+1 862 230 6637",
  APARTMENT: process.env.APARTMENT_CONTACTS || "+1 862 230 6637",
  SHIPPING: process.env.SHIPPING_CONTACTS || "+1 862 230 6637"
};

// ===== SIMPLE SESSION STORE =====
const sessions = new Map();

// ===== SIMPLE IN-MEMORY JOB STORE =====
// This fixes worker.js 404 by giving your worker something to poll.
// Later you can reconnect this to PostgreSQL without changing the bot flow.
let jobCounter = 1;
const jobs = [];

// ===== HELPERS =====
function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {
      stage: null,
      selectedService: null,
      pendingFile: null,
      lastJobId: null,
      lastMenuShownAt: null
    });
  }
  return sessions.get(from);
}

function resetSession(from) {
  sessions.set(from, {
    stage: null,
    selectedService: null,
    pendingFile: null,
    lastJobId: null,
    lastMenuShownAt: null
  });
}

function normalizeText(text = "") {
  return String(text || "").trim().toLowerCase();
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

function createJob(from, session, extra = {}) {
  const job = {
    id: jobCounter++,
    customer_phone: from,
    service: session.selectedService || null,
    file: session.pendingFile || null,
    status: "pending",
    instructions: extra.instructions || "",
    shipping_details: extra.shippingDetails || "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  jobs.unshift(job);
  session.lastJobId = job.id;
  return job;
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
    const metaResp = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`
        }
      }
    );

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
      headers: {
        Authorization: `Bearer ${TOKEN}`
      }
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

// ===== BASIC HEALTH =====
app.get("/", (req, res) => {
  res.send("PATAPATA MSTAF server is running.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "mstaf-whatsapp-bot" });
});

// ===== OPTIONAL MANUAL UPLOAD =====
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

// ===== WORKER COMPATIBILITY ROUTES =====
// This fixes the current worker.js 404 error.
app.get("/api/worker/next", (req, res) => {
  const nextJob = jobs.find((j) => j.status === "pending");

  if (!nextJob) {
    return res.status(200).json({ ok: true, job: null, message: "No pending jobs" });
  }

  nextJob.status = "printing";
  nextJob.updated_at = new Date().toISOString();

  return res.json({
    ok: true,
    job: nextJob
  });
});

app.post("/api/worker/jobs/:id/status", (req, res) => {
  const id = Number(req.params.id);
  const { status, error_message } = req.body || {};

  const job = jobs.find((j) => j.id === id);
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  job.status = status || job.status;
  job.error_message = error_message || "";
  job.updated_at = new Date().toISOString();

  return res.json({ ok: true, job });
});

app.post("/api/worker/status", (req, res) => {
  const { jobId, status, error_message } = req.body || {};
  const id = Number(jobId);

  const job = jobs.find((j) => j.id === id);
  if (!job) {
    return res.status(404).json({ ok: false, error: "Job not found" });
  }

  job.status = status || job.status;
  job.error_message = error_message || "";
  job.updated_at = new Date().toISOString();

  return res.json({ ok: true, job });
});

app.get("/jobs", (req, res) => {
  res.json({ ok: true, count: jobs.length, jobs });
});

// ===== WEBHOOK VERIFY =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ===== WHATSAPP MESSAGE HANDLER =====
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

    // ===== HANDLE GREETING =====
    if (type === "text" && isGreeting(lower)) {
      resetSession(from);
      const freshSession = getSession(from);
      freshSession.lastMenuShownAt = Date.now();

      await sendMessage(
        from,
        `Hello 👋 Welcome to PATAPATA Print-O-Matic\n\n${serviceMenuText(false)}`
      );
      return res.sendStatus(200);
    }

    // ===== HANDLE RIDE / MECHANIC / APARTMENT / SHIPPING REFERRAL =====
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
        `📦 Need Shipping selected.\n\nPlease send your shipping details:\n- pickup or delivery\n- item type\n- destination city/state\n- quantity/weight if known`
      );
      return res.sendStatus(200);
    }

    // ===== FILE RECEIVED =====
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

      session.stage = "awaiting_service";
      session.selectedService = null;

      await sendMessage(from, serviceMenuText(true));
      return res.sendStatus(200);
    }

    // ===== HANDLE MENU SELECTION =====
    if (type === "text") {
      const service = mapSelectionToService(lower);

      if (service) {
        session.selectedService = service;

        if (service === "PRINT") {
          session.stage = "print_selected";
          createJob(from, session, {});
          await sendMessage(
            from,
            `🖨 Printing selected.\n\nReply YES to proceed to checkout.\n\nYou can also reply with copies/pages if you want, for example:\n2 copies, 5 pages`
          );
          return res.sendStatus(200);
        }

        if (service === "LAMINATE") {
          session.stage = "laminate_selected";
          createJob(from, session, {});
          await sendMessage(
            from,
            `📄 Laminating selected.\n\nPrices:\nLetter $1.50\nLegal $2.00\nTabloid $3.00\n\nReply YES to continue to checkout or send your size and quantity.`
          );
          return res.sendStatus(200);
        }

        if (service === "IMAGE_EDIT") {
  if (!session.pendingFile) {
    session.stage = "awaiting_file_for_image";
    await sendMessage(
      from,
      "🎨 Image Editing selected.\n\nPlease upload your image file first, then send your instructions.\nExample: Change the sides of the image to blue."
    );
    return res.sendStatus(200);
  }

  session.stage = "awaiting_instructions";
  await sendMessage(
    from,
    "🎨 Image Editing selected.\n\nYour file is already received.\nNow send your instructions.\nExample: Change the sides of the image to blue."
  );
  return res.sendStatus(200);
}

        if (service === "VIDEO_EDIT") {
  if (!session.pendingFile) {
    session.stage = "awaiting_file_for_video";
    await sendMessage(
      from,
      "🎥 Video Editing selected.\n\nPlease upload your video file first, then send your instructions.\nExample: Edit the background and change the front colors to red."
    );
    return res.sendStatus(200);
  }

  session.stage = "awaiting_instructions";
  await sendMessage(
    from,
    "🎥 Video Editing selected.\n\nYour file is already received.\nNow send your instructions.\nExample: Edit the background and change the front colors to red."
  );
  return res.sendStatus(200);
}

        if (service === "ID_PHOTO") {
          session.stage = "awaiting_instructions";
          await sendMessage(
            from,
            "🪪 ID Photo selected.\n\nSend your instructions now.\nExample: Passport size, white background, 4 copies."
          );
          return res.sendStatus(200);
        }

        if (service === "SHIPPING") {
          session.stage = "awaiting_shipping_details";
          await sendMessage(
            from,
            `📦 Need Shipping selected.\n\nPlease send your shipping details:\n- pickup or delivery\n- item type\n- destination city/state\n- quantity/weight if known`
          );
          return res.sendStatus(200);
        }
      }
    }

    // ===== YES → CHECKOUT =====
    if (type === "text" && lower === "yes") {
      if (session.selectedService === "PRINT") {
        await sendMessage(
          from,
          "🛒 Printing checkout:\nhttps://www.patapata.us/cart/52221221437739:1\n\nIf you have not uploaded your file yet, send it here now."
        );
        session.stage = "checkout_shared";
        return res.sendStatus(200);
      }

      if (session.selectedService === "LAMINATE") {
        await sendMessage(
          from,
          "🛒 Laminating checkout:\nhttps://www.patapata.us/pages/how-to-upload\n\nSend your size and quantity if you want us to prepare the order details for you."
        );
        session.stage = "checkout_shared";
        return res.sendStatus(200);
      }

      await sendMessage(
        from,
        "✅ Okay. Send your file or details here and I will continue."
      );
      return res.sendStatus(200);
    }

    // ===== HANDLE INSTRUCTIONS AFTER IMAGE / VIDEO / ID SELECTION =====
    if (type === "text" && session.stage === "awaiting_instructions") {
      const instructions = text.trim();

      const job = createJob(from, session, { instructions });
      session.stage = "instruction_received";

      let label = "service";
      if (session.selectedService === "IMAGE_EDIT") label = "image editing";
      if (session.selectedService === "VIDEO_EDIT") label = "video editing";
      if (session.selectedService === "ID_PHOTO") label = "ID photo";

      await sendMessage(
        from,
        `✅ Your ${label} instructions have been received successfully.\n\nJob ID: ${job.id}\n\nWe have sent it to the dashboard/agent for processing.\n\nYou can send another file anytime or type hello for the menu.`
      );
      return res.sendStatus(200);
    }

    // ===== HANDLE SHIPPING DETAILS =====
    if (type === "text" && session.stage === "awaiting_shipping_details") {
      const shippingDetails = text.trim();
      const job = createJob(from, session, { shippingDetails });
      session.stage = "shipping_received";

      await sendMessage(
        from,
        `✅ Your shipping request has been received successfully.\n\nJob ID: ${job.id}\n\nWe will review the details and reply here on WhatsApp with the cost or next step.\n\nYou can also call ${CONTACTS.SHIPPING} if urgent.`
      );
      return res.sendStatus(200);
    }

    // ===== HANDLE POST-CALL FOLLOW-UP =====
    if (type === "text" && session.stage === "referral_shared") {
      await sendMessage(
        from,
        "✅ Message received.\n\nPlease send the details discussed on the call, and we will continue with the pricing or next step here on WhatsApp."
      );
      session.stage = "awaiting_followup_details";
      return res.sendStatus(200);
    }

    if (type === "text" && session.stage === "awaiting_followup_details") {
      const job = createJob(from, session, { instructions: text.trim() });
      session.stage = "followup_received";

      await sendMessage(
        from,
        `✅ Your follow-up details have been received.\n\nJob ID: ${job.id}\n\nWe will reply here on WhatsApp with the cost or next step.`
      );
      return res.sendStatus(200);
    }

    // ===== DEFAULT RESPONSE =====
    await sendMessage(
      from,
      "Hello 👋 Send hello to start, or upload your file."
    );
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
