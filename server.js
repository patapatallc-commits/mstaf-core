function getExtFromMime(mimeType = "") {
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/aac": ".aac",
    "application/pdf": ".pdf"
  };
  return map[mimeType] || "";
}

function safeBaseName(name = "upload") {
  return String(name).replace(/[^\w.\-]+/g, "_");
}

async function downloadWhatsAppMediaToUploads(mediaId, fallbackName, mimeType, req) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token || !mediaId) return "";

  const metaUrl = `https://graph.facebook.com/v23.0/${mediaId}`;
  const metaResp = await axios.get(metaUrl, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const downloadUrl = metaResp?.data?.url;
  const finalMimeType = metaResp?.data?.mime_type || mimeType || "";
  if (!downloadUrl) return "";

  const ext =
    getExtFromMime(finalMimeType) ||
    getExtFromMime(mimeType) ||
    "";

  const baseName = safeBaseName(fallbackName || mediaId || "upload");
  const finalName = `${Date.now()}_${baseName}${ext && !baseName.endsWith(ext) ? ext : ""}`;
  const fullPath = path.join("/opt/render/project/src/uploads", finalName);

  const fileResp = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  fs.writeFileSync(fullPath, Buffer.from(fileResp.data));

  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `${req.protocol}://${req.get("host")}`;

  return `${base}/uploads/${encodeURIComponent(finalName)}`;
}

const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});
// Ensure uploads folder exists


// Multer storage

const uploadsDir = path.resolve("uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
 destination: (req, file, cb) => {
  cb(null, "/opt/render/project/src/uploads");
},
  filename: (req, file, cb) => {
    const safeName = Date.now() + "-" + (file.originalname || "upload").replace(/[^\w.\-]+/g, "_");
    cb(null, safeName);
  }
});

const upload = multer({ storage });
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "20mb" }));
const cors = require("cors");

app.use(cors({
  origin: [
    "https://patapata.us",
    "https://www.patapata.us",
    "https://patapata.myshopify.com"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-worker-key", "x-dashboard-key"],
  credentials: false
}));

app.options("*", cors());


const UPLOADS_PATH = "/opt/render/project/src/uploads";

app.use("/uploads", express.static(UPLOADS_PATH, {
  fallthrough: false,
  extensions: ["jpg", "png", "jpeg", "pdf", "mp4", "ogg"]
}));

app.get("/uploads/:file", (req, res) => {
  const filePath = require("path").join(UPLOADS_PATH, req.params.file);
  res.sendFile(filePath);
});
const PORT = process.env.PORT || 10000;

// =========================
// WHATSAPP SEND MESSAGE
// =========================
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (err) {
    console.error("Send message error:", err.response?.data || err.message);
  }
}

// =========================
// IN-MEMORY SESSIONS
// =========================
const sessions = new Map();

function createSession() {
  return {
    stage: "MENU",
    selectedService: null,
    printSpec: {},
    laminateSpec: {},
    pendingFile: null,
    lastServiceJobId: null
  };
}

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, createSession());
  }
  return sessions.get(from);
}

function resetSession(from) {
  sessions.set(from, createSession());
}

// =========================
// MENUS
// =========================
function serviceMenu() {
  return `1 - Print
2 - Laminate
3 - ID Photo
4 - Image Editing
5 - Video Editing
6 - Lesson / Homework
7 - Talk to Agent
8 - Find Auto Mechanic
9 - Need Ride to Work
10 - Shared Apartment / Rent`;
}

function printSizeMenuText() {
  return `Print selected.

Choose paper size:
1 - A4
2 - A3
3 - Letter
4 - Legal
5 - Tabloid
6 - Card`;
}

function printColorMenuText() {
  return `Choose color:
1 - Black & White
2 - Color`;
}

function laminateSizeMenuText() {
  return `Laminate selected.

Choose laminate size:
1 - Letter
2 - Legal
3 - Tabloid`;
}

// =========================
// SHOPIFY VARIANT HELPERS
// =========================
const SHOPIFY_VARIANTS = {
  PRINT_A4_BW: process.env.SHOPIFY_VARIANT_PRINT_A4_BW || "52221221273899",
  PRINT_A4_COLOR: process.env.SHOPIFY_VARIANT_PRINT_A4_COLOR || "52221221437739",

  PRINT_A3_BW: process.env.SHOPIFY_VARIANT_PRINT_A3_BW || "",
  PRINT_A3_COLOR: process.env.SHOPIFY_VARIANT_PRINT_A3_COLOR || "",

  PRINT_LETTER_BW: process.env.SHOPIFY_VARIANT_PRINT_LETTER_BW || "",
  PRINT_LETTER_COLOR: process.env.SHOPIFY_VARIANT_PRINT_LETTER_COLOR || "",

  PRINT_LEGAL_BW: process.env.SHOPIFY_VARIANT_PRINT_LEGAL_BW || "",
  PRINT_LEGAL_COLOR: process.env.SHOPIFY_VARIANT_PRINT_LEGAL_COLOR || "",

  PRINT_TABLOID_BW: process.env.SHOPIFY_VARIANT_PRINT_TABLOID_BW || "",
  PRINT_TABLOID_COLOR: process.env.SHOPIFY_VARIANT_PRINT_TABLOID_COLOR || "",

  PRINT_CARD_BW: process.env.SHOPIFY_VARIANT_PRINT_CARD_BW || "",
  PRINT_CARD_COLOR: process.env.SHOPIFY_VARIANT_PRINT_CARD_COLOR || "",

  LAMINATE_LETTER: process.env.SHOPIFY_VARIANT_LAMINATE_LETTER || "",
  LAMINATE_LEGAL: process.env.SHOPIFY_VARIANT_LAMINATE_LEGAL || "",
  LAMINATE_TABLOID: process.env.SHOPIFY_VARIANT_LAMINATE_TABLOID || ""
};
// =========================
// AFRICA / NIGERIA PRICING
// =========================
function getNigeriaPrintPrice({ paper_size = "A4", color_mode = "BW", pages = 1, copies = 1 }) {
  const p = String(paper_size || "A4").toUpperCase();
  const c = String(color_mode || "BW").toUpperCase();
  const qty = Math.max(1, Number(pages || 1)) * Math.max(1, Number(copies || 1));

  let unit = 0;

  if (p === "A4" || p === "LETTER") {
    unit = c === "COLOR" ? 300 : 100;
  } else if (p === "A3") {
    unit = c === "COLOR" ? 500 : 200;
  } else if (p === "CARD") {
    unit = c === "COLOR" ? 1000 : 500;
  } else {
    unit = c === "COLOR" ? 300 : 100;
  }

  return {
    qty,
    unit,
    total: qty * unit
  };
}

function getNigeriaServicePrice(serviceType) {
  const map = {
    ID_CARD: 2000,
    IMAGE_BASIC: 500,
    IMAGE_BG_REMOVE: 700,
    IMAGE_ENHANCE: 1000,
    IMAGE_ADVANCED: 1000,
    VIDEO_SHORT: 1000,
    VIDEO_SOCIAL: 1000,
    VIDEO_STANDARD: 1000,
    VIDEO_ADVANCED: 1000
  };

  return map[String(serviceType || "").toUpperCase()] || 1000;
}

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString("en-NG");
}

function getNigeriaPricingText({ service_type = "PRINTING", paper_size = "A4", color_mode = "BW", pages = 1, copies = 1 }) {
  const s = String(service_type || "PRINTING").toUpperCase();

  if (s === "PRINTING") {
    const pricing = getNigeriaPrintPrice({ paper_size, color_mode, pages, copies });

    return `🇳🇬 Africa / Nigeria Pricing

Paper Size: ${paper_size}
Color Mode: ${color_mode === "COLOR" ? "Color" : "Black & White"}
Pages: ${pages}
Copies: ${copies}

Estimated Qty: ${pricing.qty}
Unit Price: ${formatNaira(pricing.unit)}
Estimated Total: ${formatNaira(pricing.total)}`;
  }

  const price = getNigeriaServicePrice(s);

  return `🇳🇬 Africa / Nigeria Pricing

Service: ${s.replaceAll("_", " ")}
Estimated Price: ${formatNaira(price)}`;
}

function paymentOptionMenuText() {
  return `

Choose payment option:

1. Shopify Checkout (USD)
2. Africa Payment (₦ Nigeria Pricing)
3. Continue with Agent

Reply with 1, 2, or 3.`;
}
function buildShopifyCartUrl(variantId, quantity) {
  if (!variantId) return "";
  return `https://www.patapata.us/cart/${variantId}:${quantity}`;
}

function getPrintVariantId(paperSize, color) {
  const isColor = color === "color";

  if (paperSize === "A4") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_A4_COLOR : SHOPIFY_VARIANTS.PRINT_A4_BW;
  }
  if (paperSize === "A3") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_A3_COLOR : SHOPIFY_VARIANTS.PRINT_A3_BW;
  }
  if (paperSize === "LETTER") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_LETTER_COLOR : SHOPIFY_VARIANTS.PRINT_LETTER_BW;
  }
  if (paperSize === "LEGAL") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_LEGAL_COLOR : SHOPIFY_VARIANTS.PRINT_LEGAL_BW;
  }
  if (paperSize === "TABLOID") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_TABLOID_COLOR : SHOPIFY_VARIANTS.PRINT_TABLOID_BW;
  }
  if (paperSize === "CARD") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_CARD_COLOR : SHOPIFY_VARIANTS.PRINT_CARD_BW;
  }

  return "";
}

function getLaminateVariantId(paperSize) {
  if (paperSize === "LETTER") return SHOPIFY_VARIANTS.LAMINATE_LETTER;
  if (paperSize === "LEGAL") return SHOPIFY_VARIANTS.LAMINATE_LEGAL;
  if (paperSize === "TABLOID") return SHOPIFY_VARIANTS.LAMINATE_TABLOID;
  return "";
}

// =========================
// WEBHOOK VERIFY
// =========================
app.get("/webhook", (req, res) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || process.env.WEBHOOK_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});
// =========================
// WEBHOOK RECEIVE
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

    const lower = text.toLowerCase().trim();
    // ==============================
    // WHATSAPP MEDIA / EXTRA NOTES HELPERS
    // ==============================
    const tableColumns = await getPrintJobsColumns().catch(() => new Set());

    async function createJobFromMedia({
      printerId,
      queueType,
      serviceType,
      mediaId,
      originalName,
      mimeType,
      paperSize = "",
      colorMode = "",
      copies = 1,
      pages = 1,
      instructions = ""
    }) {
      const fileUrl = await downloadWhatsAppMediaToUploads(
        mediaId,
        originalName || "upload",
        mimeType || "",
        req
      );

      if (!fileUrl) {
        throw new Error("Failed to save WhatsApp media");
      }

      const cols = [];
      const vals = [];
      const params = [];

      function addCol(name, value) {
        if (tableColumns.has(name)) {
          cols.push(name);
          params.push(value);
          vals.push(`$${params.length}`);
        }
      }

      addCol("printer_id", printerId);
      addCol("queue_type", queueType);
      addCol("file_url", fileUrl);
      addCol("original_name", originalName || "upload");
      addCol("mime_type", mimeType || "");
      addCol("status", "pending");
      addCol("service_type", serviceType || "SERVICE");
      addCol("paper_size", paperSize || null);
      addCol("color_mode", colorMode || null);
      addCol("copies", parseInt(copies, 10) || 1);
      addCol("pages", parseInt(pages, 10) || 1);
      addCol("customer_phone", from || null);
      addCol("instructions", instructions || null);

      const sql = `
        INSERT INTO print_jobs (${cols.join(", ")})
        VALUES (${vals.join(", ")})
        RETURNING *
      `;

      const result = await pool.query(sql, params);
      return result.rows[0] || null;
    }

    async function attachAudioToExistingJob(jobId, mediaId, mimeType) {
      if (!jobId || !mediaId) return null;

      const audioUrl = await downloadWhatsAppMediaToUploads(
        mediaId,
        `instruction_${jobId}`,
        mimeType || "audio/ogg",
        req
      );

      if (!audioUrl) return null;

      if (!tableColumns.has("instruction_audio_url")) return null;

      const result = await pool.query(
        `
        UPDATE print_jobs
        SET instruction_audio_url = $1
        WHERE id = $2
        RETURNING *
        `,
        [audioUrl, jobId]
      );

      return result.rows[0] || null;
    }

    async function attachTextToExistingJob(jobId, textValue) {
      if (!jobId || !textValue || !tableColumns.has("instructions")) return null;

      const result = await pool.query(
        `
        UPDATE print_jobs
        SET instructions = CASE
          WHEN instructions IS NULL OR instructions = '' THEN $1
          ELSE instructions || E'\\n\\n' || $1
        END
        WHERE id = $2
        RETURNING *
        `,
        [textValue, jobId]
      );

      return result.rows[0] || null;
    }

    // =========================
    // MEDIA CAPTURE
    // =========================
    if (
      type === "image" ||
      type === "document" ||
      type === "video" ||
      type === "audio"
    ) {
      const mediaObj =
        type === "image"
          ? message.image
          : type === "document"
          ? message.document
          : type === "audio"
          ? message.audio
          : message.video;

      session.pendingFile = {
        type,
        media_id: mediaObj?.id || "",
        mime_type: mediaObj?.mime_type || "",
        filename:
          mediaObj?.filename ||
          (type === "image"
            ? "image"
            : type === "document"
            ? "document"
            : type === "audio"
            ? "audio"
            : "video")
      };

      // PRINT FILE ARRIVED
      if (
        session.stage === "PRINT_WAITING_FILE" &&
        (type === "image" || type === "document")
      ) {
        const job = await createJobFromMedia({
          printerId: DEFAULT_PRINTER_ID,
          queueType: "WORKER",
          serviceType: "PRINT",
          mediaId: mediaObj?.id,
          originalName: mediaObj?.filename || "print_file",
          mimeType: mediaObj?.mime_type || "",
          paperSize: session.printSpec?.paper_size || "",
          colorMode: session.printSpec?.color || "bw",
          copies: session.printSpec?.copies || 1,
          pages: session.printSpec?.pages || 1
        });

        session.lastServiceJobId = job?.id || null;
        session.stage = "PRINT_FILE_UPLOADED_ACTION";

        await sendMessage(
          from,
          `✅ File received and added to print queue.

Reply:
1 - Continue with Agent
2 - Checkout`
        );
        return res.sendStatus(200);
      }

      // LAMINATE FILE ARRIVED
      if (
        session.stage === "LAMINATE_WAITING_FILE" &&
        (type === "image" || type === "document")
      ) {
        const job = await createJobFromMedia({
          printerId: DISPATCH_QUEUE_ID,
          queueType: "DISPATCH",
          serviceType: "LAMINATE",
          mediaId: mediaObj?.id,
          originalName: mediaObj?.filename || "laminate_file",
          mimeType: mediaObj?.mime_type || "",
          paperSize: session.laminateSpec?.paper_size || "",
          colorMode: "bw",
          copies: session.laminateSpec?.copies || 1,
          pages: 1
        });

        session.lastServiceJobId = job?.id || null;
        session.stage = "LAMINATE_FILE_UPLOADED_ACTION";

        await sendMessage(
          from,
          `📄 Document received successfully and added to dispatch queue.

Choose payment option:
1 - Shopify Checkout
2 - Africa Payment`
        );
        return res.sendStatus(200);
      }

      // AGENT SERVICE FILE ARRIVED
      if (session.stage === "SERVICE_WAITING_UPLOAD") {
        const job = await createJobFromMedia({
          printerId: AGENT_QUEUE_ID,
          queueType: "AGENT",
          serviceType: session.selectedService || "SERVICE",
          mediaId: mediaObj?.id,
          originalName: mediaObj?.filename || "service_file",
          mimeType: mediaObj?.mime_type || "",
          copies: 1,
          pages: 1
        });

        session.lastServiceJobId = job?.id || null;
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";

        await sendMessage(
          from,
          `✅ Your file has been received and added to the Agent queue.

Please send any extra instruction now by text or voice note.`
        );
        return res.sendStatus(200);
      }

      // PRINT INSTRUCTIONS AUDIO
      if (
  (session.stage === "PRINT_WAITING_INSTRUCTIONS" ||
    session.stage === "SERVICE_WAITING_EXTRA_NOTES") &&
  type === "audio"
) {
        if (session.lastServiceJobId) {
          await attachAudioToExistingJob(
            session.lastServiceJobId,
            mediaObj?.id,
            mediaObj?.mime_type || "audio/ogg"
          );
        }

        await sendMessage(
          from,
          `✅ Your voice instruction has been received and attached to your print job.

Our team will review your request and contact you shortly on WhatsApp.`
        );
        session.stage = "MENU";
        return res.sendStatus(200);
      }

      // LAMINATE EXTRA AUDIO
      if (session.stage === "LAMINATE_WAITING_FILE" && type === "audio") {
        await sendMessage(
          from,
          "✅ Your laminate voice instruction has been received. Please now upload the document to laminate."
        );
        return res.sendStatus(200);
      }

      // ID PHOTO FILE ARRIVED
      if (session.stage === "IDPHOTO_WAITING_UPLOAD" && type === "image") {
        const job = await createJobFromMedia({
          printerId: AGENT_QUEUE_ID,
          queueType: "AGENT",
          serviceType: "ID_PHOTO",
          mediaId: mediaObj?.id,
          originalName: mediaObj?.filename || "id_photo",
          mimeType: mediaObj?.mime_type || "image/jpeg",
          copies: 1,
          pages: 1
        });

        session.lastServiceJobId = job?.id || null;
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";

        await sendMessage(
          from,
          `✅ ID photo received and added to Agent queue.

Please send your instruction now as text or voice note.

Example:
- passport size
- white background
- 2 copies
- standard US size`
        );
        return res.sendStatus(200);
      }

      // IMAGE EDIT FILE ARRIVED
      if (session.stage === "IMAGE_EDIT_WAITING_UPLOAD" && type === "image") {
        const job = await createJobFromMedia({
          printerId: AGENT_QUEUE_ID,
          queueType: "AGENT",
          serviceType: "IMAGE_EDIT",
          mediaId: mediaObj?.id,
          originalName: mediaObj?.filename || "image_edit",
          mimeType: mediaObj?.mime_type || "image/jpeg",
          copies: 1,
          pages: 1
        });

        session.lastServiceJobId = job?.id || null;
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";

        await sendMessage(
          from,
          `✅ Image received and added to Agent queue.

Please send your instruction now as text or voice note.

Example:
- remove background
- enhance quality
- add text
- resize for social media`
        );
        return res.sendStatus(200);
      }

      // VIDEO EDIT FILE ARRIVED
      if (session.stage === "VIDEO_EDIT_WAITING_UPLOAD" && type === "video") {
        const job = await createJobFromMedia({
          printerId: AGENT_QUEUE_ID,
          queueType: "AGENT",
          serviceType: "VIDEO_EDIT",
          mediaId: mediaObj?.id,
          originalName: mediaObj?.filename || "video_edit",
          mimeType: mediaObj?.mime_type || "video/mp4",
          copies: 1,
          pages: 1
        });

        session.lastServiceJobId = job?.id || null;
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";

        await sendMessage(
          from,
          `✅ Video received and added to Agent queue.

Please send your instruction now as text or voice note.

Example:
- trim video
- add text
- merge clips
- improve sound`
        );
        return res.sendStatus(200);
      }

      // LESSON / HOMEWORK FILE ARRIVED
      if (
        session.stage === "LESSON_WAITING_UPLOAD" &&
        (type === "document" || type === "image" || type === "audio")
      ) {
        const job = await createJobFromMedia({
          printerId: AGENT_QUEUE_ID,
          queueType: "AGENT",
          serviceType: "LESSON_HOMEWORK",
          mediaId: mediaObj?.id,
          originalName: mediaObj?.filename || "lesson_homework",
          mimeType: mediaObj?.mime_type || "",
          copies: 1,
          pages: 1
        });

        session.lastServiceJobId = job?.id || null;
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";

        await sendMessage(
          from,
          `✅ Lesson / Homework file received and added to Agent queue.

Please send any extra instruction now as text or voice note.

Our team will contact you shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }
    }

    // =========================
    // GREETING / RESET
    // =========================
    if (
      type === "text" &&
      ["hi", "hello", "hey", "menu", "start"].includes(lower)
    ) {
      resetSession(from);

      await sendMessage(
        from,
        `Hello 👋 Welcome to PATAPATA Print-O-Matic

${serviceMenu()}`
      );
      return res.sendStatus(200);
    }

    // =========================
    // MENU
    // =========================
    if (session.stage === "MENU") {
      if (lower === "1") {
        session.selectedService = "PRINT";
        session.stage = "PRINT_SELECT_SIZE";
        await sendMessage(from, printSizeMenuText());
        return res.sendStatus(200);
      }

      if (lower === "2") {
        session.selectedService = "LAMINATE";
        session.stage = "LAMINATE_SELECT_SIZE";
        await sendMessage(from, laminateSizeMenuText());
        return res.sendStatus(200);
      }

      if (lower === "3") {
        session.selectedService = "ID_PHOTO";
        session.stage = "IDPHOTO_WAITING_UPLOAD";
        await sendMessage(
          from,
          `📸 ID Photo selected.

Please upload your photo now.

You can also type extra instructions or send a voice note.

Our team will review your request and provide pricing shortly.`
        );
        return res.sendStatus(200);
      }

      if (lower === "4") {
        session.selectedService = "IMAGE_EDIT";
        session.stage = "IMAGE_EDIT_WAITING_UPLOAD";
        await sendMessage(
          from,
          `🖼️ Image Editing selected.

Please upload your image now and tell us what you would like us to do.

You can type instructions or send a voice note.

Our team will review your request and contact you shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }

      if (lower === "5") {
        session.selectedService = "VIDEO_EDIT";
        session.stage = "VIDEO_EDIT_WAITING_UPLOAD";
        await sendMessage(
          from,
          `🎬 Video Editing selected.

Please upload your video now and tell us what you would like us to do.

You can type instructions or send a voice note.

Our team will review your request and contact you shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }

      if (lower === "6") {
        session.selectedService = "LESSON_HOMEWORK";
        session.stage = "LESSON_WAITING_UPLOAD";
        await sendMessage(
          from,
          `📚 Lesson / Homework selected.

Please upload your file or send your instructions now.

Our team will review your request and contact you shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }

      if (lower === "7") {
        session.selectedService = "AGENT";
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        await sendMessage(
          from,
          `👨‍💼 Talk to Agent selected.

Please type your request now.

Our Agent team will contact you shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }

      if (lower === "8") {
        session.selectedService = "MECHANIC";
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        await sendMessage(
          from,
          `🔧 Auto Mechanic request received.

Please send your location and the type of issue with your vehicle.

Our team will connect you with a nearby mechanic shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }

      if (lower === "9") {
        session.selectedService = "RIDE_TO_WORK";
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        await sendMessage(
          from,
          `🚗 Ride to Work selected.

Please send your pickup location and destination.

Our team will contact you shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }

      if (lower === "10") {
        session.selectedService = "APARTMENT";
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        await sendMessage(
          from,
          `🏠 Shared Apartment / Rent selected.

Please send your preferred location and budget.

Our team will contact you shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }

      await sendMessage(from, serviceMenu());
      return res.sendStatus(200);
    }

    // =========================
    // PRINT SIZE
    // =========================
    if (session.stage === "PRINT_SELECT_SIZE") {
      const sizeMap = {
        "1": "A4",
        "2": "A3",
        "3": "LETTER",
        "4": "LEGAL",
        "5": "TABLOID",
        "6": "CARD"
      };

      const size = sizeMap[lower];
      if (!size) {
        await sendMessage(from, "Reply 1–6");
        return res.sendStatus(200);
      }

      session.printSpec.paper_size = size;
      session.stage = "PRINT_SELECT_COLOR";

      await sendMessage(from, printColorMenuText());
      return res.sendStatus(200);
    }

    // =========================
    // PRINT COLOR
    // =========================
    if (session.stage === "PRINT_SELECT_COLOR") {
      if (lower === "1") {
        session.printSpec.color = "bw";
      } else if (lower === "2") {
        session.printSpec.color = "color";
      } else {
        await sendMessage(from, "Reply 1 or 2");
        return res.sendStatus(200);
      }

      session.stage = "PRINT_SELECT_COPIES";
      await sendMessage(from, "How many copies?");
      return res.sendStatus(200);
    }

    // =========================
    // PRINT COPIES
    // =========================
    if (session.stage === "PRINT_SELECT_COPIES") {
      const copies = parseInt(lower, 10);

      if (!copies || copies < 1) {
        await sendMessage(from, "Reply with a valid number of copies.");
        return res.sendStatus(200);
      }

      session.printSpec.copies = copies;
      session.stage = "PRINT_SELECT_PAGES";

      await sendMessage(from, "How many pages?");
      return res.sendStatus(200);
    }

    // =========================
    // PRINT PAGES
    // =========================
    if (session.stage === "PRINT_SELECT_PAGES") {
      const pages = parseInt(lower, 10);

      if (!pages || pages < 1) {
        await sendMessage(from, "Reply with a valid number of pages.");
        return res.sendStatus(200);
      }

      session.printSpec.pages = pages;
      session.stage = "PRINT_WAITING_FILE";

      await sendMessage(
        from,
        `✅ Print details saved.

Please upload your document or image now.

After upload, you will choose:
1 - Continue with Agent
2 - Checkout`
      );
      return res.sendStatus(200);
    }

    // =========================
    // PRINT WAITING FOR FILE
    // =========================
    if (session.stage === "PRINT_WAITING_FILE") {
      await sendMessage(
        from,
        `Please upload your document or image first.

After upload, you will choose:
1 - Continue with Agent
2 - Checkout`
      );
      return res.sendStatus(200);
    }

    // =========================
    // PRINT FILE ACTION
    // =========================
    if (session.stage === "PRINT_FILE_UPLOADED_ACTION") {
      if (lower === "1") {
        session.stage = "PRINT_WAITING_INSTRUCTIONS";

        await sendMessage(
          from,
          `✅ Your ${session.printSpec?.paper_size || "print"} request has been forwarded to our Agent team.

Please send any instructions now by text or voice.

Our team will review your request and contact you shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }

      if (lower === "2") {
        session.stage = "PRINT_PAYMENT_CHOICE";

        const paperSize = session.printSpec?.paper_size || "A4";
        const color = (session.printSpec?.color || "bw").toUpperCase();
        const quantity = session.printSpec?.copies || 1;

        const variantId = getPrintVariantId(paperSize, color);
        const checkoutUrl = buildShopifyCartUrl(variantId, quantity);
        const africaUrl = "https://www.patapata.us/pages/africa-payment";

await sendMessage(
  from,
  `✅ File received and added to print queue.

Choose option:

1 - Continue with Agent
2 - Checkout (Shopify / Africa)

--- Pricing Guide ---

🇺🇸 USA (Shopify):
• A4 B/W: $0.10
• A4 Color: $0.50

🇳🇬 Nigeria (Africa Payment):

📄 Photocopy
• Black & White: ₦50
• Colored: ₦200

📱 Printout from Phone
• Black & White: ₦200
• Colored: ₦200

🆔 ID Card
• ₦2,000

📜 Letter Printing
• Black & White: ₦500
• Colored: ₦1,000

🎨 Designing
• ₦1,000

💳 Printing on Card
• ₦300

📎 Binding (Tying)
• ₦300

✏️ Editing
• ₦500

📠 Scanning & Sending
• Scanning: ₦200
• Sending: ₦200

🎉 Birthday Cards
• Design: ₦500
• Printing: ₦500

📸 Passport Photographs
• 4 Copies: ₦500
• 8 Copies: ₦1,000

Reply with 1 or 2.`
);
        return res.sendStatus(200);
      }

      await sendMessage(
        from,
        `Reply:
1 - Continue with Agent
2 - Checkout`
      );
      return res.sendStatus(200);
    }

    // =========================
    // PRINT AGENT INSTRUCTIONS
    // =========================
    if (session.stage === "PRINT_WAITING_INSTRUCTIONS") {
      if (type === "text" && text.trim()) {
        await sendMessage(
          from,
          `✅ Your ${session.printSpec?.paper_size || "print"} instructions have been received and sent to our Agent team.

Our team will contact you shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }

      if (type === "audio") {
        await sendMessage(
          from,
          `✅ Your voice instruction for your ${session.printSpec?.paper_size || "print"} request has been received and sent to our Agent team.

Our team will contact you shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }

      await sendMessage(
        from,
        "Please send your instruction as text or voice note."
      );
      return res.sendStatus(200);
    }

    // =========================
    // PRINT PAYMENT CHOICE
    // =========================
    if (session.stage === "PRINT_PAYMENT_CHOICE") {
      const paperSize = session.printSpec?.paper_size || "A4";
      const color = (session.printSpec?.color || "bw").toUpperCase();
      const quantity = session.printSpec?.copies || 1;

      const variantId = getPrintVariantId(paperSize, color);
      const checkoutUrl = buildShopifyCartUrl(variantId, quantity);
      const africaUrl = "https://www.patapata.us/pages/africa-payment";

      if (lower === "1") {
        await sendMessage(
          from,
          `✅ Shopify checkout selected.

Complete your payment here:
${checkoutUrl || "Not configured yet"}

After payment, reply here if you need any help.`
        );
        session.stage = "MENU";
        return res.sendStatus(200);
      }
if (lower === "2") {
  await sendMessage(
    from,
    `🌍 Africa Payment (Nigeria Selected)

💰 Price List:
• A4 B/W: ₦100 per page
• A4 Color: ₦500 per page

👉 Complete your payment here:
${africaUrl}

📩 After payment, our team will process your job immediately.`
  );

  session.stage = "MENU";
  return res.sendStatus(200);
}
      await sendMessage(
        from,
        `Please reply with:

1 - Shopify Checkout
2 - Africa Payment`
      );
      return res.sendStatus(200);
    }   

    // =========================
    // LAMINATE SIZE
    // =========================
    if (session.stage === "LAMINATE_SELECT_SIZE") {
      const sizeMap = {
        "1": "LETTER",
        "2": "LEGAL",
        "3": "TABLOID"
      };

      const size = sizeMap[lower];
      if (!size) {
        await sendMessage(from, "Reply 1–3");
        return res.sendStatus(200);
      }

      session.laminateSpec.paper_size = size;
      session.stage = "LAMINATE_SELECT_COPIES";

      await sendMessage(from, "How many copies?");
      return res.sendStatus(200);
    }

    // =========================
    // LAMINATE COPIES
    // =========================
    if (session.stage === "LAMINATE_SELECT_COPIES") {
      const copies = parseInt(lower, 10);

      if (!copies || copies < 1) {
        await sendMessage(from, "Reply with a valid number of copies.");
        return res.sendStatus(200);
      }

      session.laminateSpec.copies = copies;
      session.stage = "LAMINATE_WAITING_FILE";

      await sendMessage(
        from,
        `✅ Laminate details saved.

Please upload your document now.

You can also add extra instructions by text or voice.`
      );
      return res.sendStatus(200);
    }

    // =========================
    // LAMINATE FILE ACTION
    // =========================
    if (session.stage === "LAMINATE_FILE_UPLOADED_ACTION") {
      const paperSize = session.laminateSpec?.paper_size || "LETTER";
      const quantity = session.laminateSpec?.copies || 1;
      const variantId = getLaminateVariantId(paperSize);
      const checkoutUrl = buildShopifyCartUrl(variantId, quantity);
      const africaUrl = "https://www.patapata.us/pages/africa-payment";

      if (lower === "1") {
        await sendMessage(from, `🛒 Shopify Checkout:\n${checkoutUrl || "Not configured yet"}`);
        return res.sendStatus(200);
      }

      if (lower === "2") {
        await sendMessage(from, `🌍 Africa Payment:\n${africaUrl}`);
        return res.sendStatus(200);
      }

      await sendMessage(
        from,
        `Reply with:
1 - Shopify Checkout
2 - Africa Payment`
      );
      return res.sendStatus(200);
    }
    // =========================
    // GENERIC EXTRA NOTES
    // =========================
    if (session.stage === "SERVICE_WAITING_EXTRA_NOTES") {
      if (type === "text" && lower) {
        if (session.lastServiceJobId) {
          await attachTextToExistingJob(session.lastServiceJobId, text.trim());
        }

        await sendMessage(
          from,
          `✅ Your message has been received and attached to your job.

Our team will contact you shortly on WhatsApp.`
        );
        session.stage = "MENU";
        return res.sendStatus(200);
      }

      if (type === "audio") {
        if (session.lastServiceJobId && message.audio?.id) {
          await attachAudioToExistingJob(
            session.lastServiceJobId,
            message.audio.id,
            message.audio?.mime_type || "audio/ogg"
          );
        }

        await sendMessage(
          from,
          `✅ Your voice note has been received and attached to your job.

Our team will contact you shortly on WhatsApp.`
        );
        session.stage = "MENU";
        return res.sendStatus(200);
      }

      await sendMessage(
        from,
        `Please reply with one of the options below:

${serviceMenu()}`
      );
      return res.sendStatus(200);
    }

  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message || err);
    return res.sendStatus(200);
  }
});

  
// ========================
// HEALTH
// ========================

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
app.get("/api/worker/next", async (req, res) => {
  try {
    const workerKey = req.headers["x-worker-key"];
    const printerId = String(req.query.printer_id || "").trim();

    if (!workerKey || workerKey !== process.env.WORKER_KEY) {
      return res.status(403).json({ ok: false, error: "Unauthorized" });
    }

    if (!printerId) {
      return res.json({ ok: true, job: null });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM jobs
      WHERE status = 'pending'
        AND printer_id = $1
      ORDER BY id ASC
      LIMIT 1
      `,
      [printerId]
    );

    const job = result.rows[0];

    if (!job) {
      return res.json({ ok: true, job: null });
    }

    await pool.query(
      `UPDATE jobs SET status = 'printing' WHERE id = $1`,
      [job.id]
    );

    return res.json({ ok: true, job });
  } catch (err) {
    console.error("WORKER NEXT ERROR:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/worker/jobs/:id/status", async (req, res) => {
  try {
    const workerKey = req.headers["x-worker-key"];
    const jobId = req.params.id;
    const status = String(req.body.status || "").trim();
    const errorMessage = String(req.body.error_message || "").trim();

    if (!workerKey || workerKey !== process.env.WORKER_KEY) {
      return res.status(403).json({ ok: false, error: "Unauthorized" });
    }

    if (!jobId || !status) {
      return res.status(400).json({ ok: false, error: "Missing job id or status" });
    }

    await pool.query(
      `
      UPDATE jobs
      SET status = $1
      WHERE id = $2
      `,
      [status, jobId]
    );

    if (errorMessage) {
      console.error(`JOB ${jobId} ERROR: ${errorMessage}`);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("WORKER STATUS ERROR:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});
// =============================
// DASHBOARD (WORKER VIEW)
// =============================
// =========================
// DASHBOARD (WORKER + AGENT VIEW)
// =========================
/******************************************************************
 * WORKER + AGENT DASHBOARD START
 ******************************************************************/

const DASHBOARD_KEY = process.env.DASHBOARD_KEY || process.env.SYSTEM_KEY || "MSTAF123";
const DEFAULT_PRINTER_ID = process.env.DEFAULT_PRINTER_ID || "PP-USA-001";
const A3_PRINTER_ID = process.env.A3_PRINTER_ID || "PP-USA-A3-001";
const CARD_PRINTER_ID = process.env.CARD_PRINTER_ID || "PP-USA-CARD-001";
const DISPATCH_QUEUE_ID = process.env.DISPATCH_QUEUE_ID || "DISPATCH";
const AGENT_QUEUE_ID = process.env.AGENT_QUEUE_ID || "AGENT";

function requireDashboardKey(req, res, next) {
  const key =
    req.headers["x-dashboard-key"] ||
    req.query.key ||
    req.body?.dashboard_key;

  // TEMP: allow access for testing
  if (!key) {
    console.log("No dashboard key provided — allowing for now");
    return next();
  }

  if (key !== DASHBOARD_KEY) {
    console.log("Invalid dashboard key:", key);
    return res.status(401).send("Unauthorized dashboard key");
  }

  next();
}

function escapeHtml(v = "") {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isPdf(job) {
  const name = (job.original_name || "").toLowerCase();
  const mime = (job.mime_type || "").toLowerCase();
  const url = (job.file_url || "").toLowerCase();
  return mime.includes("pdf") || name.endsWith(".pdf") || url.endsWith(".pdf");
}

function isVideo(job) {
  const mime = (job.mime_type || "").toLowerCase();
  const name = (job.original_name || "").toLowerCase();
  return mime.startsWith("video/") ||
    [".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"].some(ext => name.endsWith(ext));
}

function isAudio(job) {
  const mime = (job.mime_type || "").toLowerCase();
  const name = (job.original_name || "").toLowerCase();
  return mime.startsWith("audio/") ||
    [".mp3", ".wav", ".ogg", ".opus", ".m4a", ".aac"].some(ext => name.endsWith(ext));
}

function getNigeriaStates() {
  return [
    ["Abia", "AB"], ["Adamawa", "AD"], ["Akwa Ibom", "AK"], ["Anambra", "AN"],
    ["Bauchi", "BA"], ["Bayelsa", "BY"], ["Benue", "BE"], ["Borno", "BO"],
    ["Cross River", "CR"], ["Delta", "DE"], ["Ebonyi", "EB"], ["Edo", "ED"],
    ["Ekiti", "EK"], ["Enugu", "EN"], ["FCT Abuja", "FC"], ["Gombe", "GO"],
    ["Imo", "IM"], ["Jigawa", "JI"], ["Kaduna", "KD"], ["Kano", "KN"],
    ["Katsina", "KT"], ["Kebbi", "KE"], ["Kogi", "KG"], ["Kwara", "KW"],
    ["Lagos", "LA"], ["Nasarawa", "NA"], ["Niger", "NI"], ["Ogun", "OG"],
    ["Ondo", "ON"], ["Osun", "OS"], ["Oyo", "OY"], ["Plateau", "PL"],
    ["Rivers", "RI"], ["Sokoto", "SO"], ["Taraba", "TA"], ["Yobe", "YO"],
    ["Zamfara", "ZA"]
  ];
}

function getPrinterRegistry() {
  const printers = [
    {
      country: "USA",
      state: "United States Hub",
      code: "USA",
      printers: [
        { id: DEFAULT_PRINTER_ID, label: "USA A4 / Letter Hub Printer" },
        { id: A3_PRINTER_ID || CARD_PRINTER_ID, label: "USA A3 / Card Special Printer" }
      ]
    }
  ];

  for (const [state, code] of getNigeriaStates()) {
    printers.push({
      country: "Nigeria",
      state,
      code,
      printers: [
        { id: `PP-NG-${code}-A4-001`, label: `${state} A4 Hub Printer` },
        { id: `PP-NG-${code}-SP-001`, label: `${state} A3 / Card Special Printer` }
      ]
    });
  }

  return printers;
}

async function sendWhatsAppText(to, body) {
  try {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId || !to || !body) {
      return { ok: false, error: "Missing WhatsApp credentials or parameters" };
    }

    const url = `https://graph.facebook.com/v23.0/${phoneNumberId}/messages`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body }
      })
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: data };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Optional safe column helper
 */
async function getPrintJobsColumns() {
  const q = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'print_jobs'
  `);
  return new Set(q.rows.map(r => r.column_name));
}

/**
 * Main jobs API
 */
app.get("/api/dashboard/jobs", requireDashboardKey, async (req, res) => {
  try {
    const {
      status = "",
      q = "",
      queue = "",
      printer_id = "",
      limit = "100"
    } = req.query;

    const params = [];
    const where = [];

    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    if (queue === "agent") {
      params.push(AGENT_QUEUE_ID);
      where.push(`(printer_id = $${params.length} OR queue_type = 'AGENT')`);
    } else if (queue === "dispatch") {
      params.push(DISPATCH_QUEUE_ID);
      where.push(`(printer_id = $${params.length} OR queue_type = 'DISPATCH')`);
    } else if (queue === "worker") {
      where.push(`(
        COALESCE(queue_type, '') <> 'AGENT'
        AND COALESCE(queue_type, '') <> 'DISPATCH'
      )`);
    }

    if (printer_id) {
      params.push(printer_id);
      where.push(`printer_id = $${params.length}`);
    }

    if (q) {
      params.push(`%${q}%`);
      where.push(`(
        COALESCE(original_name, '') ILIKE $${params.length}
        OR COALESCE(file_url, '') ILIKE $${params.length}
        OR COALESCE(instructions, '') ILIKE $${params.length}
        OR COALESCE(customer_phone, '') ILIKE $${params.length}
        OR COALESCE(printer_id, '') ILIKE $${params.length}
        OR COALESCE(service_type, '') ILIKE $${params.length}
      )`);
    }

    params.push(Math.min(parseInt(limit, 10) || 100, 300));

    const sql = `
      SELECT *
      FROM print_jobs
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id DESC
      LIMIT $${params.length}
    `;

    const result = await pool.query(sql, params);
    res.json({ ok: true, jobs: result.rows, printers: getPrinterRegistry() });
  } catch (err) {
    console.error("Dashboard jobs error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Route job to printer/queue
 */
app.post("/api/dashboard/jobs/:id/route", requireDashboardKey, express.json(), async (req, res) => {
  try {
    const id = req.params.id;
    const target_printer_id = req.body?.printer_id || DISPATCH_QUEUE_ID;
    const queue_type =
      target_printer_id === AGENT_QUEUE_ID
        ? "AGENT"
        : target_printer_id === DISPATCH_QUEUE_ID
          ? "DISPATCH"
          : "WORKER";

    const result = await pool.query(
      `
      UPDATE print_jobs
      SET printer_id = $1,
          queue_type = $2,
          status = CASE WHEN status = 'completed' THEN status ELSE 'pending' END
      WHERE id = $3
      RETURNING *
      `,
      [target_printer_id, queue_type, id]
    );

    res.json({ ok: true, job: result.rows[0] || null });
  } catch (err) {
    console.error("Dashboard route error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Mark job
 */
app.post("/api/dashboard/jobs/:id/mark", requireDashboardKey, express.json(), async (req, res) => {
  try {
    const id = req.params.id;
    const status = req.body?.status || "pending";

    const allowed = new Set(["pending", "claimed", "printing", "completed", "failed"]);
    if (!allowed.has(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }

    const result = await pool.query(
      `
      UPDATE print_jobs
      SET status = $1
      WHERE id = $2
      RETURNING *
      `,
      [status, id]
    );

    res.json({ ok: true, job: result.rows[0] || null });
  } catch (err) {
    console.error("Dashboard mark error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * WhatsApp reply from dashboard
 */
app.post("/api/dashboard/jobs/:id/reply", requireDashboardKey, express.json(), async (req, res) => {
  try {
    const id = req.params.id;
    const message = String(req.body?.message || "").trim();

    if (!message) {
      return res.status(400).json({ ok: false, error: "Message required" });
    }

    const jobResult = await pool.query(`SELECT * FROM print_jobs WHERE id = $1 LIMIT 1`, [id]);
    const job = jobResult.rows[0];

    if (!job) {
      return res.status(404).json({ ok: false, error: "Job not found" });
    }

    const phone =
      job.customer_phone ||
      job.whatsapp_number ||
      job.phone ||
      null;

    if (!phone) {
      return res.status(400).json({ ok: false, error: "No WhatsApp number found on this job" });
    }

    const sendResult = await sendWhatsAppText(phone, message);
    if (!sendResult.ok) {
      return res.status(500).json({ ok: false, error: sendResult.error });
    }

    res.json({ ok: true, sent: true });
  } catch (err) {
    console.error("Dashboard reply error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Manual dashboard upload to queue
 */
// PUBLIC SHOPIFY UPLOAD (NO DASHBOARD KEY)
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    const {
      service_type = "PRINTING",
      instructions = "",
      paper_size = "A4",
      color_mode = "BW",
      copies = "1",
      pages = "1",
      laminating_type = "NONE",
      laminating_qty = "0",
      laminating_note = ""
    } = req.body;

    if (!file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    // Save job to DB (reuse your existing logic if you have one)
    const result = await pool.query(`
      INSERT INTO jobs (
        status,
        printer_id,
        file_url,
        original_name,
        paper_size,
        color_mode,
        copies,
        pages,
        service_type,
        instructions
      )
      VALUES ('pending', $1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      "PP-USA-001",
      "/uploads/" + file.filename,
      file.originalname,
      paper_size,
      color_mode,
      copies,
      pages,
      service_type,
      instructions
    ]);

    return res.json({
      ok: true,
      id: result.rows[0].id,
      file_url: "/uploads/" + file.filename,
      routing: "Standard Printer (PP-USA-001)"
    });

  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/api/dashboard/manual-upload", requireDashboardKey, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const {
      service_type = "SERVICE",
      instructions = "",
      customer_phone = "",
      queue_type = "AGENT",
      paper_size = "",
      color_mode = "BW",
      copies = "1",
      pages = "1"
    } = req.body;

    if (!file) {
      return res.status(400).json({ ok: false, error: "File required" });
    }

    const base =
      process.env.PUBLIC_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      `${req.protocol}://${req.get("host")}`;

    const fileUrl = `${base}/uploads/${encodeURIComponent(file.filename)}`;
    const mimeType = file.mimetype || "";
    const ext = (file.originalname || "").split(".").pop() || "";

    const targetPrinterId =
      queue_type === "AGENT"
        ? AGENT_QUEUE_ID
        : queue_type === "DISPATCH"
          ? DISPATCH_QUEUE_ID
          : DEFAULT_PRINTER_ID;

    const columns = await getPrintJobsColumns();

    const insertCols = [];
    const insertVals = [];
    const params = [];

    function addCol(name, value) {
      if (columns.has(name)) {
        insertCols.push(name);
        params.push(value);
        insertVals.push(`$${params.length}`);
      }
    }

    addCol("printer_id", targetPrinterId);
    addCol("file_url", fileUrl);
    addCol("original_name", file.originalname || "upload");
    addCol("mime_type", mimeType);
    addCol("file_ext", ext);
    addCol("status", "pending");
    addCol("service_type", service_type);
    addCol("queue_type", queue_type);
    addCol("instructions", instructions || null);
    addCol("customer_phone", customer_phone || null);
    addCol("paper_size", paper_size || null);
    addCol("color_mode", color_mode || "BW");
    addCol("copies", parseInt(copies, 10) || 1);
    addCol("pages", parseInt(pages, 10) || 1);

    const sql = `
      INSERT INTO print_jobs (${insertCols.join(", ")})
      VALUES (${insertVals.join(", ")})
      RETURNING *
    `;

    const result = await pool.query(sql, params);
    res.json({ ok: true, job: result.rows[0] || null });
  } catch (err) {
    console.error("Manual dashboard upload error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Dashboard page
 */
app.get("/worker-dashboard", requireDashboardKey, async (req, res) => {
  const key = encodeURIComponent(req.query.key || "");
  const printers = getPrinterRegistry();

  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>MSTAF Worker & Agent Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root{
      --bg:#08111f;
      --panel:#0e1a2f;
      --panel2:#13233f;
      --line:rgba(255,255,255,.08);
      --text:#eef5ff;
      --muted:#a8b7d1;
      --gold:#ffcc4d;
      --blue:#42a5ff;
      --green:#2dd36f;
      --red:#ff6b6b;
      --purple:#a56dff;
      --cyan:#18d2d9;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      background:
        radial-gradient(circle at top right, rgba(66,165,255,.22), transparent 26%),
        radial-gradient(circle at top left, rgba(255,204,77,.14), transparent 24%),
        linear-gradient(180deg, #07101d 0%, #091425 100%);
      color:var(--text);
      font-family:Inter, Arial, sans-serif;
    }
    .wrap{max-width:1600px;margin:0 auto;padding:20px}
    .hero{
      display:grid;
      grid-template-columns: 1.3fr .7fr;
      gap:18px;
      margin-bottom:18px;
    }
    .heroCard,.stats,.panel,.sidePanel,.uploadPanel{
      background:linear-gradient(180deg, rgba(19,35,63,.95), rgba(10,19,35,.97));
      border:1px solid var(--line);
      border-radius:22px;
      box-shadow:0 20px 60px rgba(0,0,0,.32);
    }
    .heroCard{padding:24px}
    .heroTitle{
      font-size:30px;font-weight:800;letter-spacing:.2px;margin-bottom:8px;
    }
    .heroSub{color:var(--muted);line-height:1.6}
    .badgeRow{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
    .badge{
      padding:10px 14px;border-radius:999px;
      background:rgba(255,255,255,.05);
      border:1px solid rgba(255,255,255,.08);
      color:#fff;font-size:13px;font-weight:700;
    }
    .stats{
      padding:18px;
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:12px;
      align-content:start;
    }
    .stat{
      padding:16px;border-radius:18px;background:rgba(255,255,255,.04);
      border:1px solid rgba(255,255,255,.06);
    }
    .stat .k{font-size:28px;font-weight:800;margin-top:6px}
    .toolbar{
      display:grid;
      grid-template-columns:1fr auto auto auto auto;
      gap:12px;
      margin-bottom:18px;
    }
    .toolbar input,.toolbar select,.toolbar button,.uploadPanel input,.uploadPanel select,.uploadPanel textarea{
      width:100%;
      background:#0c1730;
      color:#fff;
      border:1px solid rgba(255,255,255,.1);
      border-radius:14px;
      padding:12px 14px;
      outline:none;
    }
    .toolbar button,.btn{
      cursor:pointer;
      font-weight:800;
      border:none;
      background:linear-gradient(90deg, var(--blue), #74b9ff);
      color:#04111f;
    }
    .btn.secondary{background:linear-gradient(90deg, var(--gold), #ffd76e)}
    .btn.green{background:linear-gradient(90deg, #2dd36f, #68e89b)}
    .btn.red{background:linear-gradient(90deg, #ff6b6b, #ff8d8d)}
    .btn.purple{background:linear-gradient(90deg, var(--purple), #c19aff); color:white;}
    .btn.dark{background:linear-gradient(90deg, #2f3f5f, #4b618c); color:#fff;}
    .main{
      display:grid;
      grid-template-columns:1.25fr .75fr;
      gap:18px;
      align-items:start;
    }
    .panel{padding:16px}
    .sidePanel,.uploadPanel{padding:16px}
    .tabs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
    .tab{
      padding:10px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.08);
      background:rgba(255,255,255,.04);cursor:pointer;font-weight:800;
    }
    .tab.active{background:linear-gradient(90deg, var(--gold), #ffd76e); color:#07111d}
    .jobGrid{display:grid;gap:16px}
    .jobCard{
      border:1px solid rgba(255,255,255,.08);
      border-radius:22px;
      overflow:hidden;
      background:linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02));
    }
    .jobHead{
      padding:16px;
      display:flex;justify-content:space-between;gap:12px;align-items:flex-start;
      border-bottom:1px solid rgba(255,255,255,.08);
      background:linear-gradient(90deg, rgba(255,204,77,.12), rgba(66,165,255,.09));
    }
    .jobTitle{font-size:18px;font-weight:800}
    .meta{color:var(--muted);font-size:13px;line-height:1.5}
    .pill{
      display:inline-block;padding:7px 10px;border-radius:999px;font-size:12px;font-weight:800;
      margin-left:6px;
    }
    .pill.pending{background:#ffe7a0;color:#4c3900}
    .pill.claimed{background:#b8e3ff;color:#003459}
    .pill.printing{background:#d1c0ff;color:#321a73}
    .pill.completed{background:#bdf4cf;color:#0e4c23}
    .pill.failed{background:#ffc2c2;color:#5e1010}
    .jobBody{
      padding:16px;
      display:grid;
      grid-template-columns:1.1fr .9fr;
      gap:16px;
    }
    .previewBox,.detailBox{
      background:rgba(0,0,0,.18);
      border:1px solid rgba(255,255,255,.06);
      border-radius:18px;
      padding:14px;
    }
    iframe,video,audio,img{
      width:100%;
      border-radius:14px;
      background:#000;
    }
    iframe{height:420px;border:none}
    video{max-height:420px}
    img{max-height:420px;object-fit:contain;background:#0a101a}
    .noPreview{
      min-height:220px;display:flex;align-items:center;justify-content:center;
      color:var(--muted);text-align:center;border:1px dashed rgba(255,255,255,.12);border-radius:14px;
      padding:20px;
    }
    .detailRow{display:grid;grid-template-columns:130px 1fr;gap:10px;margin-bottom:10px}
    .detailRow b{color:#ffd76e}
    .insBox,.replyBox,.noteBox{
      margin-top:14px;
      padding:12px;
      border-radius:14px;
      background:rgba(255,255,255,.04);
      border:1px solid rgba(255,255,255,.06);
    }
    textarea.reply{
      width:100%;min-height:100px;resize:vertical;
      margin-top:10px;background:#08111f;color:#fff;border:1px solid rgba(255,255,255,.1);
      border-radius:12px;padding:12px;
    }
    .actionRow{
      display:flex;flex-wrap:wrap;gap:8px;margin-top:14px
    }
    .routeRow{
      display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:14px
    }
    .sidePanel h3,.uploadPanel h3,.panel h3{margin:4px 0 14px 0}
    .printerList{display:grid;gap:10px;max-height:520px;overflow:auto;padding-right:4px}
    .printerGroup{
      border:1px solid rgba(255,255,255,.07);
      border-radius:16px;padding:12px;background:rgba(255,255,255,.03)
    }
    .printerState{font-weight:800;margin-bottom:6px}
    .printerItem{
      color:var(--muted);font-size:13px;line-height:1.5;padding-left:8px
    }
    .uploadPanel form{display:grid;gap:10px}
    .muted{color:var(--muted)}
    .topLinks{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
    .topLinks a{
      color:#07111d;text-decoration:none;background:linear-gradient(90deg,#ffd76e,#ffcc4d);
      padding:10px 14px;border-radius:12px;font-weight:800
    }
    .small{font-size:12px;color:var(--muted)}
    .emptyState{
      padding:30px;
      text-align:center;
      color:var(--muted);
      border:1px dashed rgba(255,255,255,.1);
      border-radius:18px;
      background:rgba(255,255,255,.02);
    }
    a.fileLink{color:#8fd1ff;text-decoration:none;font-weight:700}
    a.fileLink:hover{text-decoration:underline}
    @media (max-width: 1100px){
      .hero,.main,.jobBody,.toolbar{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div class="heroCard">
        <div class="heroTitle">PATAPATA MSTAF — Worker & Agent Command Dashboard</div>
        <div class="heroSub">
          Manage worker print jobs, agent service jobs, videos, images, PDFs, audio instructions, customer notes, WhatsApp replies, and routing from one clean control center.
        </div>
        <div class="badgeRow">
          <div class="badge">PDF Preview</div>
          <div class="badge">Image Preview</div>
          <div class="badge">Video Window</div>
          <div class="badge">Audio Playback</div>
          <div class="badge">Text Instructions</div>
          <div class="badge">WhatsApp Reply</div>
          <div class="badge">USA + Nigeria Routing</div>
        </div>
        <div class="topLinks">
          <a href="/worker-dashboard?key=${key}">Open Main Dashboard</a>
          <a href="/api/dashboard/jobs?key=${key}" target="_blank">Open Jobs API</a>
        </div>
      </div>

      <div class="stats" id="statsBox">
        <div class="stat"><div>All Jobs</div><div class="k" id="s_all">0</div></div>
        <div class="stat"><div>Pending</div><div class="k" id="s_pending">0</div></div>
        <div class="stat"><div>Printing / Claimed</div><div class="k" id="s_working">0</div></div>
        <div class="stat"><div>Completed</div><div class="k" id="s_completed">0</div></div>
      </div>
    </div>

    <div class="toolbar">
      <input id="q" placeholder="Search name, phone, instructions, service, queue..." />
      <select id="status">
        <option value="">All Status</option>
        <option value="pending">Pending</option>
        <option value="claimed">Claimed</option>
        <option value="printing">Printing</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
      </select>
      <select id="queue">
        <option value="">All Queues</option>
        <option value="worker">Worker Queue</option>
        <option value="agent">Agent Queue</option>
        <option value="dispatch">Dispatch Queue</option>
      </select>
      <button class="btn secondary" onclick="loadJobs()">Refresh</button>
      <button class="btn" onclick="toggleUpload()">Manual Upload</button>
    </div>

    <div id="uploadPanel" class="uploadPanel" style="display:none; margin-bottom:18px;">
      <h3>Manual Dashboard Upload</h3>
      <form id="manualUploadForm">
        <input type="file" name="file" required />
        <select name="queue_type">
          <option value="AGENT">Send to Agent Queue</option>
          <option value="DISPATCH">Send to Dispatch Queue</option>
          <option value="WORKER">Send to Worker Queue</option>
        </select>
        <input name="service_type" placeholder="Service type e.g. PRINT, VIDEO_EDIT, IMAGE_EDIT, SERVICE" value="SERVICE" />
        <input name="customer_phone" placeholder="Customer WhatsApp number e.g. 15551234567" />
        <input name="paper_size" placeholder="Paper size e.g. A4, Letter, A3" />
        <input name="color_mode" placeholder="Color mode e.g. BW or COLOR" value="BW" />
        <input name="copies" type="number" min="1" value="1" />
        <input name="pages" type="number" min="1" value="1" />
        <textarea name="instructions" placeholder="Type text instruction here"></textarea>
        <button class="btn green" type="submit">Upload Job to Dashboard</button>
        <div class="small">Supports PDF, images, video, audio, and documents.</div>
      </form>
    </div>

    <div class="main">
      <div class="panel">
        <div class="tabs">
          <div class="tab active" onclick="setQueueTab('')" id="tab_all">All Jobs</div>
          <div class="tab" onclick="setQueueTab('worker')" id="tab_worker">Workers</div>
          <div class="tab" onclick="setQueueTab('agent')" id="tab_agent">Agents</div>
          <div class="tab" onclick="setQueueTab('dispatch')" id="tab_dispatch">Dispatch</div>
        </div>
        <div id="jobGrid" class="jobGrid"></div>
      </div>

      <div style="display:grid; gap:18px;">
        <div class="sidePanel">
          <h3>USA + Nigeria Printer Registry</h3>
          <div class="printerList">
            ${printers.map(group => `
              <div class="printerGroup">
                <div class="printerState">${escapeHtml(group.country)} — ${escapeHtml(group.state)}</div>
                ${group.printers.map(p => `
                  <div class="printerItem">• ${escapeHtml(p.label)}<br><span class="small">${escapeHtml(p.id)}</span></div>
                `).join("")}
              </div>
            `).join("")}
          </div>
        </div>

        <div class="sidePanel">
          <h3>Worker Notes</h3>
          <div class="muted">
            • Use <b>Claimed</b> when a worker picks a job.<br><br>
            • Use <b>Printing</b> when the print or edit is in progress.<br><br>
            • Use <b>Completed</b> after delivery / finished edit / finished print.<br><br>
            • Agent jobs route to <b>${escapeHtml(AGENT_QUEUE_ID)}</b>.<br><br>
            • Dispatch jobs route to <b>${escapeHtml(DISPATCH_QUEUE_ID)}</b>.<br><br>
            • File preview depends on valid <b>file_url</b> and <b>mime_type</b>.
          </div>
        </div>
      </div>
    </div>
  </div>

<script>
  const DASHBOARD_KEY = ${JSON.stringify(req.query.key || "")};
  let currentQueue = "";

  function toggleUpload() {
    const el = document.getElementById("uploadPanel");
    el.style.display = el.style.display === "none" ? "block" : "none";
  }

  function setQueueTab(queue) {
    currentQueue = queue;
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tab_" + (queue || "all")).classList.add("active");
    document.getElementById("queue").value = queue;
    loadJobs();
  }

  async function api(path, options = {}) {
    const finalUrl = path + (path.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(DASHBOARD_KEY);
    const res = await fetch(finalUrl, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  function summarize(jobs) {
    const all = jobs.length;
    const pending = jobs.filter(j => j.status === "pending").length;
    const completed = jobs.filter(j => j.status === "completed").length;
    const working = jobs.filter(j => j.status === "printing" || j.status === "claimed").length;
    document.getElementById("s_all").textContent = all;
    document.getElementById("s_pending").textContent = pending;
    document.getElementById("s_completed").textContent = completed;
    document.getElementById("s_working").textContent = working;
  }

  function statusPill(status = "") {
    const s = String(status || "pending").toLowerCase();
    return '<span class="pill ' + s + '">' + s.toUpperCase() + '</span>';
  }

  function h(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isPdf(job) {
    const name = (job.original_name || "").toLowerCase();
    const mime = (job.mime_type || "").toLowerCase();
    const url = (job.file_url || "").toLowerCase();
    return mime.includes("pdf") || name.endsWith(".pdf") || url.endsWith(".pdf");
  }

  function isVideo(job) {
    const mime = (job.mime_type || "").toLowerCase();
    const name = (job.original_name || "").toLowerCase();
    const url = (job.file_url || "").toLowerCase();
    return mime.startsWith("video/") || [".mp4",".mov",".avi",".mkv",".webm",".m4v"].some(ext => name.endsWith(ext) || url.endsWith(ext));
  }

  function isAudio(job) {
    const mime = (job.mime_type || "").toLowerCase();
    const name = (job.original_name || "").toLowerCase();
    const url = (job.file_url || "").toLowerCase();
    return mime.startsWith("audio/") || [".mp3",".wav",".ogg",".opus",".m4a",".aac"].some(ext => name.endsWith(ext) || url.endsWith(ext));
  }

  function isImage(job) {
    const mime = (job.mime_type || "").toLowerCase();
    const name = (job.original_name || "").toLowerCase();
    const url = (job.file_url || "").toLowerCase();
    return mime.startsWith("image/") || [".jpg",".jpeg",".png",".webp",".gif"].some(ext => name.endsWith(ext) || url.endsWith(ext));
  }

  function normalizeUrl(url) {
    if (!url) return "";
    if (String(url).startsWith("http://") || String(url).startsWith("https://")) return url;
    return url;
  }

  function renderPreview(job) {
    const fileUrl = normalizeUrl(job.file_url || "");
    if (!fileUrl) {
      return '<div class="noPreview">No uploaded file found for this job.</div>';
    }

    if (isPdf(job)) {
      return '<iframe src="' + h(fileUrl) + '"></iframe>';
    }

    if (isVideo(job)) {
      return '<video controls preload="metadata" playsinline>' +
        '<source src="' + h(fileUrl) + '" type="' + h(job.mime_type || "video/mp4") + '">' +
        'Your browser cannot play this video.' +
      '</video>';
    }

    if (isAudio(job)) {
      return '<div class="noteBox"><b>Audio File</b><br><span class="small">' + h(job.original_name || "audio") + '</span></div>' +
        '<audio controls preload="metadata">' +
        '<source src="' + h(fileUrl) + '" type="' + h(job.mime_type || "audio/mpeg") + '">' +
        'Your browser cannot play this audio.' +
      '</audio>';
    }

    if (isImage(job)) {
      return '<img src="' + h(fileUrl) + '" alt="Uploaded image" />';
    }

    return '<div class="noPreview">Preview not available for this file type.<br><br><a class="fileLink" href="' + h(fileUrl) + '" target="_blank">Open file</a></div>';
  }

  function renderInstructions(job) {
    const parts = [];

    if (job.instructions) {
      parts.push('<div class="insBox"><b>Text Instruction</b><br>' + h(job.instructions).replace(/\\n/g, "<br>") + '</div>');
    }

    if (job.notes) {
      parts.push('<div class="insBox"><b>Notes</b><br>' + h(job.notes).replace(/\\n/g, "<br>") + '</div>');
    }

    if (job.error_message) {
      parts.push('<div class="insBox"><b>Error / Status Note</b><br>' + h(job.error_message).replace(/\\n/g, "<br>") + '</div>');
    }

    if (!parts.length) {
      parts.push('<div class="insBox"><b>Text Instruction</b><br><span class="small">No saved text instruction on this job yet.</span></div>');
    }

if (!parts.length) {
  parts.push('<div class="insBox"><b>Text Instruction</b><br><span class="small">No saved text instruction on this job yet.</span></div>');
}

// ✅ SAFE VOICE PLAYER (no crash)
if (job.instruction_audio_url) parts.push('<div class="insBox"><b>🎧 Voice Instruction</b><br><audio controls style="width:100%;margin-top:5px;"><source src="' + job.instruction_audio_url + '" type="audio/ogg"></audio></div>');

return parts.join("");

    return parts.join("");
  }

  function routeOptions(job, printers) {
    const current = job.printer_id || "";
    let html = "";

    html += '<option value="PP-USA-001"' + (current === "PP-USA-001" ? " selected" : "") + '>USA A4 / Letter Hub</option>';
    html += '<option value="PP-USA-A3-001"' + (current === "PP-USA-A3-001" ? " selected" : "") + '>USA A3 / Card Special</option>';
    html += '<option value="AGENT"' + (current === "AGENT" ? " selected" : "") + '>Agent Queue</option>';
    html += '<option value="DISPATCH"' + (current === "DISPATCH" ? " selected" : "") + '>Dispatch Queue</option>';

    (printers || []).forEach(group => {
      (group.printers || []).forEach(p => {
        if (["PP-USA-001", "PP-USA-A3-001", "AGENT", "DISPATCH"].includes(p.id)) return;
        html += '<option value="' + h(p.id) + '"' + (current === p.id ? " selected" : "") + '>' + h(p.label) + '</option>';
      });
    });

    return html;
  }

  function renderJob(job, printers) {
    const fileUrl = job.file_url || "";
    const title = job.original_name || job.service_type || ("Job #" + job.id);
    return \`
      <div class="jobCard">
        <div class="jobHead">
          <div>
            <div class="jobTitle">Job #\${h(job.id)} — \${h(title)}</div>
            <div class="meta">
              Queue: \${h(job.queue_type || "WORKER")} |
              Printer: \${h(job.printer_id || "-")} |
              Service: \${h(job.service_type || "-")}
              \${statusPill(job.status)}
            </div>
          </div>
          <div class="meta" style="text-align:right">
            Phone: \${h(job.customer_phone || "-")}<br>
            Paper: \${h(job.paper_size || "N/A")}<br>
            Color: \${h(job.color_mode || "BW")}<br>
            Copies: \${h(job.copies || 1)}
          </div>
        </div>

        <div class="jobBody">
          <div class="previewBox">
            \${renderPreview(job)}
          </div>

          <div class="detailBox">
            <div class="detailRow"><b>File URL</b><div>\${fileUrl ? '<a class="fileLink" href="' + h(fileUrl) + '" target="_blank">Open file</a>' : '<span class="small">No file</span>'}</div></div>
            <div class="detailRow"><b>Original Name</b><div>\${h(job.original_name || "-")}</div></div>
            <div class="detailRow"><b>MIME Type</b><div>\${h(job.mime_type || "-")}</div></div>
            <div class="detailRow"><b>Pages</b><div>\${h(job.pages || 1)}</div></div>
            <div class="detailRow"><b>Created</b><div>\${h(job.created_at || "-")}</div></div>
            <div class="detailRow"><b>Customer</b><div>\${h(job.customer_phone || "-")}</div></div>

            \${renderInstructions(job)}

            <div class="routeRow">
              <select id="route_\${h(job.id)}">
                \${routeOptions(job, printers)}
              </select>
              <button class="btn dark" onclick="routeJob('\${h(job.id)}')">Route</button>
            </div>

            <div class="actionRow">
              <button class="btn secondary" onclick="markJob('\${h(job.id)}','claimed')">Claim</button>
              <button class="btn purple" onclick="markJob('\${h(job.id)}','printing')">Start</button>
              <button class="btn green" onclick="markJob('\${h(job.id)}','completed')">Complete</button>
              <button class="btn red" onclick="markJob('\${h(job.id)}','failed')">Fail</button>
            </div>

            <div class="replyBox">
              <b>Reply on WhatsApp</b>
              <textarea id="reply_\${h(job.id)}" class="reply" placeholder="Type your update to the customer here..."></textarea>
              <div class="actionRow">
                <button class="btn" onclick="replyJob('\${h(job.id)}')">Send Reply</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    \`;
  }

  async function loadJobs() {
    try {
      const q = document.getElementById("q").value.trim();
      const status = document.getElementById("status").value;
      const queue = document.getElementById("queue").value || currentQueue;

      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (status) params.set("status", status);
      if (queue) params.set("queue", queue);

      const data = await api("/api/dashboard/jobs?" + params.toString());
      const jobs = data.jobs || [];
      const printers = data.printers || [];

      summarize(jobs);

      const grid = document.getElementById("jobGrid");
      if (!jobs.length) {
        grid.innerHTML = '<div class="emptyState">No jobs found for the selected filter.</div>';
        return;
      }

      grid.innerHTML = jobs.map(job => renderJob(job, printers)).join("");
    } catch (err) {
      document.getElementById("jobGrid").innerHTML =
        '<div class="emptyState">Dashboard load failed: ' + h(err.message) + '</div>';
    }
  }

  async function markJob(id, status) {
    try {
      await api("/api/dashboard/jobs/" + id + "/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      loadJobs();
    } catch (err) {
      alert("Mark failed: " + err.message);
    }
  }

  async function routeJob(id) {
    try {
      const printer_id = document.getElementById("route_" + id).value;
      await api("/api/dashboard/jobs/" + id + "/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printer_id })
      });
      loadJobs();
    } catch (err) {
      alert("Route failed: " + err.message);
    }
  }

  async function replyJob(id) {
    try {
      const message = document.getElementById("reply_" + id).value.trim();
      if (!message) return alert("Type a message first.");
      await api("/api/dashboard/jobs/" + id + "/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      alert("WhatsApp reply sent.");
      document.getElementById("reply_" + id).value = "";
    } catch (err) {
      alert("Reply failed: " + err.message);
    }
  }

  document.getElementById("q").addEventListener("input", () => loadJobs());
  document.getElementById("status").addEventListener("change", () => loadJobs());
  document.getElementById("queue").addEventListener("change", () => loadJobs());

  document.getElementById("manualUploadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(e.target);
      const res = await fetch("/api/dashboard/manual-upload?key=" + encodeURIComponent(DASHBOARD_KEY), {
        method: "POST",
        body: fd
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed");
      alert("Dashboard upload created successfully.");
      e.target.reset();
      loadJobs();
    } catch (err) {
      alert("Manual upload failed: " + err.message);
    }
  });

  loadJobs();
  function mediaIsPlaying() {
  return [...document.querySelectorAll("video, audio")].some(
    el => !el.paused && !el.ended
  );
}

let isUserTyping = false;

document.addEventListener("focusin", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
    isUserTyping = true;
  }
});

document.addEventListener("focusout", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
    isUserTyping = false;
  }
});

setInterval(() => {
  if (mediaIsPlaying()) return;
  if (isUserTyping) return;
  loadJobs();
}, 8000);
</script>
</body>
</html>`);
});
 

/******************************************************************
 * WORKER + AGENT DASHBOARD END
 ******************************************************************/

   

 
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
