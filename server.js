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

// ===== LINKS =====
const LINKS = {
  PRINT_CHECKOUT: process.env.PRINT_CHECKOUT_LINK || "https://www.patapata.us/cart/52221221437739:1",
  LAMINATE_CHECKOUT: process.env.LAMINATE_CHECKOUT_LINK || "https://www.patapata.us/pages/how-to-upload"
};

// ===== SIMPLE SESSION STORE =====
const sessions = new Map();

// ===== SIMPLE IN-MEMORY JOB STORE =====
let jobCounter = 1;
const jobs = [];

// ===== HELPERS =====
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
    instruction_audio_url: extra.instructionAudioUrl || "",
    instruction_audio: extra.instructionAudio || null,

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
        `Hello 👋 Welcome to PATAPATA Print-O-Matic

${serviceMenuText(false)}`
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
        `🚗 Ride to Work:
Call ${CONTACTS.RIDE}

After your call, reply here on WhatsApp and we can continue chatting with you about the cost or next step.`
      );
      return res.sendStatus(200);
    }

    if (referralIntent === "MECHANIC") {
      session.selectedService = "MECHANIC";
      session.stage = "referral_shared";
      await sendMessage(
        from,
        `🔧 Auto Mechanic:
Call ${CONTACTS.MECHANIC}

After your call, reply here on WhatsApp and we can continue chatting with you about the cost or next step.`
      );
      return res.sendStatus(200);
    }

    if (referralIntent === "APARTMENT") {
      session.selectedService = "APARTMENT";
      session.stage = "referral_shared";
      await sendMessage(
        from,
        `🏠 Apartment Rentals:
Call ${CONTACTS.APARTMENT}

After your call, reply here on WhatsApp and we can continue chatting with you here if needed.`
      );
      return res.sendStatus(200);
    }

    if (referralIntent === "SHIPPING") {
      session.selectedService = "SHIPPING";
      session.stage = "awaiting_shipping_details";
      await sendMessage(
        from,
        `📦 Need Shipping selected.

Please send your shipping details:
- pickup or delivery
- item type
- destination city/state
- quantity/weight if known`
      );
      return res.sendStatus(200);
    }

    // ===== PAY / CHAT OPTION FOR PRINT & LAMINATE =====
    if (type === "text" && lower === "1") {
      if (session.stage === "print_selected") {
        await sendMessage(
          from,
          `🛒 Printing payment:
${LINKS.PRINT_CHECKOUT}

After payment, reply here on WhatsApp if you want us to continue with your order.`
        );
        session.stage = "checkout_shared";
        return res.sendStatus(200);
      }

      if (session.stage === "laminate_selected") {
        await sendMessage(
          from,
          `🛒 Laminating payment:
${LINKS.LAMINATE_CHECKOUT}

After payment, reply here on WhatsApp if you want us to continue with your order.`
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
          `✅ Okay.

Please send your print details here on WhatsApp, such as copies, pages, color mode, paper size, delivery/pickup, or any special instructions.

You can type the instruction or send a voice note.

Our team will reply here with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "laminate_selected") {
        session.stage = "awaiting_followup_details";
        await sendMessage(
          from,
          `✅ Okay.

Please send your laminating details here on WhatsApp, such as size, quantity, and any special instructions.

You can type the instruction or send a voice note.

Our team will reply here with the cost or next step.`
        );
        return res.sendStatus(200);
      }
    }

    // ===== AUDIO INSTRUCTION HANDLER =====
    // This is the key new feature:
    // if bot is already waiting for instruction/details and user sends a voice note,
    // save it as instruction_audio_url and create the job.
    if (type === "audio") {
      const mediaId = message.audio?.id;
      const downloaded = await downloadWhatsAppMedia(mediaId);

      // AUDIO AS EDIT / ID INSTRUCTION
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
          `✅ Your ${label} audio instruction has been received successfully.

Job ID: ${job.id}

Our agent will review it and reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      // AUDIO AS PRINT / LAMINATE / REFERRAL FOLLOW-UP DETAILS
      if (session.stage === "awaiting_followup_details") {
        const job = createJob(from, session, {
          instructions: "[Audio follow-up instruction received via WhatsApp voice note]",
          instructionAudioUrl: downloaded?.url || "",
          instructionAudio: downloaded || null
        });

        session.stage = "followup_received";

        await sendMessage(
          from,
          `✅ Your audio details have been received.

Job ID: ${job.id}

We will reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      // AUDIO AS SHIPPING DETAILS
      if (session.stage === "awaiting_shipping_details") {
        const job = createJob(from, session, {
          shippingDetails: "[Audio shipping details received via WhatsApp voice note]",
          instructionAudioUrl: downloaded?.url || "",
          instructionAudio: downloaded || null
        });

        session.stage = "shipping_received";

        await sendMessage(
          from,
          `✅ Your shipping audio details have been received successfully.

Job ID: ${job.id}

We will review the details and reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }
    }

    // ===== GENERAL FILE RECEIVED =====
    // image/document/video are treated as main files
    // audio only reaches here when it was NOT meant as an instruction
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
          `✅ Your image file has been received.

Now send your instructions.
You can type the instruction or send a voice note.

After review, our agent will reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "awaiting_file_for_video" && session.selectedService === "VIDEO_EDIT") {
        session.stage = "awaiting_instructions";
        await sendMessage(
          from,
          `✅ Your video file has been received.

Now send your instructions.
You can type the instruction or send a voice note.

After review, our agent will reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "awaiting_file_for_id" && session.selectedService === "ID_PHOTO") {
        session.stage = "awaiting_instructions";
        await sendMessage(
          from,
          `✅ Your photo has been received.

Now send your instructions.
Example: Passport size, white background, 4 copies.

You can type the instruction or send a voice note.

After review, our agent will reply here on WhatsApp with the cost or next step.`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "awaiting_file_for_print" && session.selectedService === "PRINT") {
        createJob(from, session, {});
        session.stage = "print_selected";
        await sendMessage(
          from,
          `🖨 Printing selected.

Your file has been received.

Reply with:
1 - Pay on Shopify now
2 - Chat here on WhatsApp for assistance, pricing, or special instructions`
        );
        return res.sendStatus(200);
      }

      if (session.stage === "awaiting_file_for_laminate" && session.selectedService === "LAMINATE") {
        createJob(from, session, {});
        session.stage = "laminate_selected";
        await sendMessage(
          from,
          `📄 Laminating selected.

Your file has been received.

Prices:
Letter $1.50
Legal $2.00
Tabloid $3.00

Reply with:
1 - Pay on Shopify now
2 - Chat here on WhatsApp for assistance or special instructions`
        );
        return res.sendStatus(200);
      }

      session.stage = "awaiting_service";
      session.selectedService = null;

      await sendMessage(from, serviceMenuText(true));
      return res.sendStatus(200);
    }

    // ===== YES CHECKOUT =====
    if (type === "text" && lower === "yes") {
      if (session.selectedService === "PRINT") {
        await sendMessage(
          from,
          `🛒 Printing payment:
${LINKS.PRINT_CHECKOUT}

After payment, reply here on WhatsApp if you want us to continue with your order.`
        );
        session.stage = "checkout_shared";
        return res.sendStatus(200);
      }

      if (session.selectedService === "LAMINATE") {
        await sendMessage(
          from,
          `🛒 Laminating payment:
${LINKS.LAMINATE_CHECKOUT}

After payment, reply here on WhatsApp if you want us to continue with your order.`
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

    // ===== HANDLE MENU SELECTION =====
    if (type === "text") {
      const service = mapSelectionToService(lower);

      if (service) {
        session.selectedService = service;

        if (service === "PRINT") {
          if (!session.pendingFile) {
            session.stage = "awaiting_file_for_print";
            await sendMessage(
              from,
              `🖨 Printing selected.

Please upload your file first.

After upload, you can:
1 - Pay on Shopify now
2 - Chat here on WhatsApp for assistance, pricing, or special instructions`
            );
            return res.sendStatus(200);
          }

          createJob(from, session, {});
          session.stage = "print_selected";

          await sendMessage(
            from,
            `🖨 Printing selected.

Your file/details have been received.

Reply with:
1 - Pay on Shopify now
2 - Chat here on WhatsApp for assistance, pricing, or special instructions`
          );
          return res.sendStatus(200);
        }

        if (service === "LAMINATE") {
          if (!session.pendingFile) {
            session.stage = "awaiting_file_for_laminate";
            await sendMessage(
              from,
              `📄 Laminating selected.

Please upload your file first.

After upload, you can:
1 - Pay on Shopify now
2 - Chat here on WhatsApp for assistance or special instructions`
            );
            return res.sendStatus(200);
          }

          createJob(from, session, {});
          session.stage = "laminate_selected";

          await sendMessage(
            from,
            `📄 Laminating selected.

Prices:
Letter $1.50
Legal $2.00
Tabloid $3.00

Reply with:
1 - Pay on Shopify now
2 - Chat here on WhatsApp for assistance or special instructions

You can also send your size and quantity by text or voice note.`
          );
          return res.sendStatus(200);
        }

        if (service === "IMAGE_EDIT") {
          if (!session.pendingFile) {
            session.stage = "awaiting_file_for_image";
            await sendMessage(
              from,
              `🎨 Image Editing selected.

Please upload your image file first, then send your instructions.
You can type the instruction or send a voice note.`
            );
            return res.sendStatus(200);
          }

          session.stage = "awaiting_instructions";
          await sendMessage(
            from,
            `🎨 Image Editing selected.

Your image file has been received.
Now send your instructions.

You can type the instruction or send a voice note.

After review, our agent will reply here on WhatsApp with the cost or next step.`
          );
          return res.sendStatus(200);
        }

        if (service === "VIDEO_EDIT") {
          if (!session.pendingFile) {
            session.stage = "awaiting_file_for_video";
            await sendMessage(
              from,
              `🎥 Video Editing selected.

Please upload your video file first, then send your instructions.
You can type the instruction or send a voice note.`
            );
            return res.sendStatus(200);
          }

          session.stage = "awaiting_instructions";
          await sendMessage(
            from,
            `🎥 Video Editing selected.

Your video file has been received.
Now send your instructions.

You can type the instruction or send a voice note.

After review, our agent will reply here on WhatsApp with the cost or next step.`
          );
          return res.sendStatus(200);
        }

        if (service === "ID_PHOTO") {
          if (!session.pendingFile) {
            session.stage = "awaiting_file_for_id";
            await sendMessage(
              from,
              `🪪 ID Photo selected.

Please upload your photo first, then send your instructions.

You can type the instruction or send a voice note.`
            );
            return res.sendStatus(200);
          }

          session.stage = "awaiting_instructions";
          await sendMessage(
            from,
            `🪪 ID Photo selected.

Your photo has been received.
Now send your instructions.

You can type the instruction or send a voice note.

After review, our agent will reply here on WhatsApp with the cost or next step.`
          );
          return res.sendStatus(200);
        }

        if (service === "SHIPPING") {
          session.stage = "awaiting_shipping_details";
          await sendMessage(
            from,
            `📦 Need Shipping selected.

Please send your shipping details:
- pickup or delivery
- item type
- destination city/state
- quantity/weight if known

You can type the details or send a voice note.`
          );
          return res.sendStatus(200);
        }
      }
    }

    // ===== TEXT INSTRUCTIONS AFTER IMAGE / VIDEO / ID =====
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
        `✅ Your ${label} file and instructions have been received successfully.

Job ID: ${job.id}

Our agent will review it and reply here on WhatsApp with the cost or next step.`
      );
      return res.sendStatus(200);
    }

    // ===== TEXT SHIPPING DETAILS =====
    if (type === "text" && session.stage === "awaiting_shipping_details") {
      const shippingDetails = text.trim();
      const job = createJob(from, session, { shippingDetails });
      session.stage = "shipping_received";

      await sendMessage(
        from,
        `✅ Your shipping request has been received successfully.

Job ID: ${job.id}

We will review the details and reply here on WhatsApp with the cost or next step.

You can also call ${CONTACTS.SHIPPING} if urgent.`
      );
      return res.sendStatus(200);
    }

    // ===== TEXT FOLLOW-UP DETAILS =====
    if (type === "text" && session.stage === "referral_shared") {
      await sendMessage(
        from,
        `✅ Message received.

Please send the details discussed on the call.

You can type the details or send a voice note, and we will continue with the pricing or next step here on WhatsApp.`
      );
      session.stage = "awaiting_followup_details";
      return res.sendStatus(200);
    }

    if (type === "text" && session.stage === "awaiting_followup_details") {
      const job = createJob(from, session, { instructions: text.trim() });
      session.stage = "followup_received";

      await sendMessage(
        from,
        `✅ Your details have been received.

Job ID: ${job.id}

We will reply here on WhatsApp with the cost or next step.`
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
app.get("/dashboard", (req, res) => {
  res.send(`
    <html>
    <head>
      <title>MSTAF Dashboard</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #f4f6f9;
          padding: 20px;
        }

        h1 {
          margin-bottom: 20px;
        }

        .job {
          background: #fff;
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 20px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.08);
        }

        .row {
          margin-bottom: 6px;
        }

        .label {
          font-weight: bold;
        }

        .preview {
          margin-top: 10px;
        }

        img {
          max-width: 300px;
          border-radius: 8px;
          display: block;
        }

        video {
          max-width: 400px;
          border-radius: 8px;
          display: block;
        }

        audio {
          width: 300px;
          margin-top: 8px;
        }

        .btn {
          margin-top: 12px;
          padding: 8px 12px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
        }

        .done {
          background: #16a34a;
          color: white;
        }

        .error {
          background: #dc2626;
          color: white;
          margin-left: 8px;
        }

        .empty {
          background: white;
          padding: 20px;
          border-radius: 10px;
        }
      </style>
    </head>

    <body>
      <h1>🖨 MSTAF Worker / Agent Dashboard</h1>
      <div id="jobs">Loading jobs...</div>

      <script>
        async function loadJobs() {
          const container = document.getElementById('jobs');

          try {
            const res = await fetch('/jobs');
            const data = await res.json();

            container.innerHTML = '';

            if (!data.jobs || data.jobs.length === 0) {
              container.innerHTML = '<div class="empty">No jobs available</div>';
              return;
            }

            data.jobs.forEach(job => {
              const div = document.createElement('div');
              div.className = 'job';

              let preview = '';

              if (job.file && job.file.url) {
                if (job.file.mime_type && job.file.mime_type.startsWith('image')) {
                  preview = '<img src="' + job.file.url + '">';
                } else if (job.file.mime_type && job.file.mime_type.startsWith('video')) {
                  preview = '<video controls src="' + job.file.url + '"></video>';
                } else {
                  preview = '<a href="' + job.file.url + '" target="_blank">📎 View File</a>';
                }
              }

              let audio = '';
              if (job.instruction_audio_url) {
                audio = '<audio controls src="' + job.instruction_audio_url + '"></audio>';
              }

              div.innerHTML =
                '<div class="row"><span class="label">Job ID:</span> ' + job.id + '</div>' +
                '<div class="row"><span class="label">Service:</span> ' + job.service + '</div>' +
                '<div class="row"><span class="label">Status:</span> ' + job.status + '</div>' +
                '<div class="row"><span class="label">Instructions:</span> ' + (job.instructions || 'None') + '</div>' +
                '<div class="preview">' + preview + '</div>' +
                '<div>' + audio + '</div>' +
                '<button class="btn done" onclick="markDone(' + job.id + ')">✅ Done</button>' +
                '<button class="btn error" onclick="markError(' + job.id + ')">❌ Error</button>';

              container.appendChild(div);
            });

          } catch (err) {
            container.innerHTML = '<div class="empty">Failed to load jobs</div>';
          }
        }

        async function markDone(id) {
          await fetch('/api/worker/jobs/' + id + '/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'completed' })
          });
          loadJobs();
        }

        async function markError(id) {
          await fetch('/api/worker/jobs/' + id + '/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'error' })
          });
          loadJobs();
        }

        loadJobs();
        setInterval(loadJobs, 5000);
      </script>
    </body>
    </html>
  `);
});
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
