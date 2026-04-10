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
  const fullPath = path.join(uploadsDir, finalName);

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
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
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
const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
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
// ===============================
// UNIVERSAL MEDIA HANDLER (FIX)
// ===============================
if (["image", "video", "document", "audio"].includes(type)) {
  try {
    const mediaObj =
      message.image ||
      message.video ||
      message.document ||
      message.audio;

    if (!mediaObj?.id) {
      return res.sendStatus(200);
    }

    const mimeType = mediaObj.mime_type || "";
    const ext =
      mimeType.includes("jpeg") ? "jpg" :
      mimeType.includes("png") ? "png" :
      mimeType.includes("mp4") ? "mp4" :
      mimeType.includes("pdf") ? "pdf" :
      mimeType.includes("ogg") ? "ogg" :
      mimeType.includes("mp3") ? "mp3" :
      "bin";

    // Get media URL
    const meta = await axios.get(
      `https://graph.facebook.com/v23.0/${mediaObj.id}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
        }
      }
    );

    const mediaUrl = meta.data.url;

    // Download file
    const fileRes = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
      }
    });

    const filename = `${Date.now()}_${type}.${ext}`;
    const filePath = path.join(uploadsDir, filename);

    await fs.promises.writeFile(filePath, fileRes.data);

    const fileUrl = `${BASE_URL}/uploads/${filename}`;

    // ===============================
    // IF JOB EXISTS → ATTACH TO IT
    // ===============================
    if (session.lastServiceJobId) {
      if (type === "audio") {
        await pool.query(
          `UPDATE print_jobs
           SET instruction_audio_url = $1
           WHERE id = $2`,
          [fileUrl, session.lastServiceJobId]
        );

        await sendMessage(
          from,
          "Voice instruction received. Our team will contact you soon."
        );

      } else {
        await pool.query(
          `UPDATE print_jobs
           SET file_url = $1
           WHERE id = $2`,
          [fileUrl, session.lastServiceJobId]
        );

        await sendMessage(
          from,
          "File updated successfully."
        );
      }

      return res.sendStatus(200);
    }

    // ===============================
    // OTHERWISE → CREATE NEW JOB
    // ===============================
    const result = await pool.query(
      `INSERT INTO print_jobs (
        status,
        printer_id,
        file_url,
        original_name,
        mime_type,
        service_type,
        copies,
        pages,
        total_cost
      ) VALUES (
        'pending',
        'AGENT',
        $1,
        $2,
        $3,
        'general_upload',
        1,
        1,
        0
      )
      RETURNING id`,
      [
        fileUrl,
        filename,
        mimeType
      ]
    );

    session.lastServiceJobId = result.rows[0].id;

    await sendMessage(
      from,
      "Upload received successfully. Please send instructions (text or voice note)."
    );

    return res.sendStatus(200);

  } catch (err) {
    console.error("MEDIA HANDLER ERROR:", err);
    return res.sendStatus(200);
  }
}
    const lower = text.toLowerCase().trim();

    // ==============================
    // EXTRA NOTES RECEIVED (VIDEO / LESSON / SERVICE)
    // ==============================
    if (
      session.stage === "SERVICE_WAITING_EXTRA_NOTES" &&
      (type === "text" || type === "audio")
    ) {
      session.stage = "MENU";

      await sendMessage(
        from,
        `✅ Instruction received.

Our Agent team will contact you soon on WhatsApp.`
      );

      return res.sendStatus(200);
    }

    // =========================
    // MEDIA CAPTURE
    // =========================
    if (
      (type === "image" || type === "document" || type === "video") ||
      (type === "audio" && session.stage !== "SERVICE_WAITING_EXTRA_NOTES")
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
        session.stage = "PRINT_FILE_UPLOADED_ACTION";

        await sendMessage(
          from,
          `✅ File received.

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
        session.stage = "LAMINATE_FILE_UPLOADED_ACTION";

        await sendMessage(
          from,
          `📄 Document received successfully.

Choose payment option:
1 - Shopify Checkout
2 - Africa Payment`
        );
        return res.sendStatus(200);
      }

      // AGENT SERVICE FILE ARRIVED
      if (session.stage === "SERVICE_WAITING_UPLOAD") {
        await sendMessage(
          from,
          `✅ Your file has been received.

Our team is reviewing your request and will contact you shortly on WhatsApp.`
        );
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        return res.sendStatus(200);
      }

      // PRINT INSTRUCTIONS AUDIO
      if (session.stage === "PRINT_WAITING_INSTRUCTIONS" && type === "audio") {
        await sendMessage(
          from,
          `✅ Your voice instruction has been received and sent to our Agent team.

Our team will review your request and contact you shortly on WhatsApp.`
        );
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
        await sendMessage(
          from,
          `✅ ID photo received.

Please send your instruction now as text or voice note.

Example:
- passport size
- white background
- 2 copies
- standard US size`
        );
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        return res.sendStatus(200);
      }

      // IMAGE EDIT FILE ARRIVED
      if (session.stage === "IMAGE_EDIT_WAITING_UPLOAD" && type === "image") {
        await sendMessage(
          from,
          `✅ Image received.

Please send your instruction now as text or voice note.

Example:
- remove background
- enhance quality
- add text
- resize for social media`
        );
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        return res.sendStatus(200);
      }

      // VIDEO EDIT FILE ARRIVED
      if (session.stage === "VIDEO_EDIT_WAITING_UPLOAD" && type === "video") {
        await sendMessage(
          from,
          `✅ Video received.

Please send your instruction now as text or voice note.

Example:
- trim video
- add text
- merge clips
- improve sound`
        );
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        return res.sendStatus(200);
      }

      // LESSON / HOMEWORK FILE ARRIVED
      if (
        session.stage === "LESSON_WAITING_UPLOAD" &&
        (type === "document" || type === "image" || type === "audio")
      ) {
        await sendMessage(
          from,
          `✅ Lesson / Homework file received.

Please send any extra instruction now as text or voice note.

Our team will contact you shortly on WhatsApp.`
        );
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
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
        const color = session.printSpec?.color || "bw";
        const quantity = session.printSpec?.copies || 1;

        const variantId = getPrintVariantId(paperSize, color);
        const checkoutUrl = buildShopifyCartUrl(variantId, quantity);
        const africaUrl = "https://www.patapata.us/pages/africa-payment";

        await sendMessage(
          from,
          `Choose payment option:

1 - Shopify Checkout
2 - Africa Payment

Shopify:
${checkoutUrl || "Not configured yet"}

Africa Payment:
${africaUrl}`
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
      const color = session.printSpec?.color || "bw";
      const quantity = session.printSpec?.copies || 1;

      const variantId = getPrintVariantId(paperSize, color);
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
        await sendMessage(
          from,
          `✅ Your message has been received.

Our team will contact you shortly on WhatsApp.`
        );
        session.stage = "MENU";
        return res.sendStatus(200);
      }

      if (type === "audio") {
        await sendMessage(
          from,
          `✅ Your voice note has been received.

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

    await sendMessage(
      from,
      `Please reply with one of the options below:

${serviceMenu()}`
    );
    return res.sendStatus(200);

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
  const key = req.query.key || req.headers["x-dashboard-key"] || req.body?.dashboard_key;
  if (key !== DASHBOARD_KEY) {
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
app.get("/dashboard", requireDashboardKey, async (req, res) => {
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
      --panel:#0e1a2b;
      --panel2:#13233f;
      --line:rgba(255,255,255,.08);
      --text:#eef5ff;
      --muted:#a8b7d1;
      --gold:#ffcc4d;
      --blue:#42a5ff;
      --green:#2dd36f;
      --red:#ff5d73;
      --orange:#ff9f43;
      --shadow:0 10px 30px rgba(0,0,0,.25);
      --radius:18px;
    }

    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:Arial,Helvetica,sans-serif;
      background:
        radial-gradient(circle at top right, rgba(66,165,255,.16), transparent 30%),
        radial-gradient(circle at top left, rgba(255,204,77,.14), transparent 25%),
        linear-gradient(180deg, #08111f 0%, #0b1730 100%);
      color:var(--text);
    }

    .wrap{
      max-width:1400px;
      margin:0 auto;
      padding:20px;
    }

    .hero{
      display:flex;
      justify-content:space-between;
      gap:18px;
      align-items:center;
      flex-wrap:wrap;
      background:linear-gradient(135deg, rgba(255,204,77,.12), rgba(66,165,255,.10));
      border:1px solid var(--line);
      border-radius:24px;
      padding:22px;
      box-shadow:var(--shadow);
      margin-bottom:18px;
    }

    .hero h1{
      margin:0 0 8px;
      font-size:28px;
    }

    .hero p{
      margin:0;
      color:var(--muted);
      line-height:1.45;
    }

    .hero .badge{
      display:inline-flex;
      align-items:center;
      gap:8px;
      padding:10px 14px;
      border-radius:999px;
      background:rgba(255,255,255,.06);
      border:1px solid var(--line);
      color:var(--gold);
      font-weight:bold;
    }

    .panel{
      background:rgba(14,26,43,.96);
      border:1px solid var(--line);
      border-radius:var(--radius);
      box-shadow:var(--shadow);
    }

    .toolbar{
      display:grid;
      grid-template-columns:1.2fr .9fr .9fr .9fr .9fr auto;
      gap:12px;
      padding:16px;
      margin-bottom:16px;
    }

    .toolbar input,
    .toolbar select,
    .toolbar button,
    textarea{
      width:100%;
      border-radius:12px;
      border:1px solid rgba(255,255,255,.12);
      background:#0b1730;
      color:var(--text);
      padding:12px 14px;
      outline:none;
    }

    .toolbar button,
    .btn{
      cursor:pointer;
      font-weight:bold;
      transition:.18s ease;
    }

    .toolbar button:hover,
    .btn:hover{
      transform:translateY(-1px);
      opacity:.95;
    }

    .tabs{
      display:flex;
      gap:10px;
      padding:0 16px 16px;
      flex-wrap:wrap;
    }

    .tab{
      border:none;
      background:#10203d;
      color:var(--text);
      padding:10px 16px;
      border-radius:999px;
      cursor:pointer;
      border:1px solid rgba(255,255,255,.08);
      font-weight:bold;
    }

    .tab.active{
      background:linear-gradient(135deg, var(--gold), #ffb347);
      color:#111;
    }

    .stats{
      display:grid;
      grid-template-columns:repeat(5,1fr);
      gap:14px;
      margin-bottom:16px;
    }

    .cardStat{
      padding:16px;
      border-radius:18px;
      background:rgba(14,26,43,.96);
      border:1px solid var(--line);
      box-shadow:var(--shadow);
    }

    .cardStat .label{
      color:var(--muted);
      font-size:13px;
      margin-bottom:8px;
    }

    .cardStat .value{
      font-size:24px;
      font-weight:bold;
    }

    .manualBox{
      padding:16px;
      margin-bottom:18px;
    }

    .manualGrid{
      display:grid;
      grid-template-columns:1fr 1fr 1fr 1fr auto;
      gap:12px;
      align-items:end;
    }

    .jobs{
      display:grid;
      gap:16px;
    }

    .job{
      display:grid;
      grid-template-columns:320px 1fr;
      gap:16px;
      padding:16px;
      border:1px solid var(--line);
      border-radius:20px;
      background:linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
    }

    .preview{
      background:#07111f;
      border:1px solid rgba(255,255,255,.08);
      border-radius:16px;
      min-height:240px;
      display:flex;
      align-items:center;
      justify-content:center;
      overflow:hidden;
      position:relative;
      padding:10px;
    }

    .preview img,
    .preview video,
    .preview iframe{
      width:100%;
      max-height:420px;
      border-radius:12px;
      object-fit:contain;
      background:#000;
    }

    .preview .missing{
      text-align:center;
      color:#ffd1d8;
      line-height:1.5;
      padding:18px;
    }

    .details{
      display:grid;
      gap:12px;
    }

    .topRow{
      display:flex;
      justify-content:space-between;
      gap:12px;
      flex-wrap:wrap;
      align-items:flex-start;
    }

    .title{
      font-size:20px;
      font-weight:bold;
      margin-bottom:6px;
      word-break:break-word;
    }

    .sub{
      color:var(--muted);
      font-size:13px;
      line-height:1.5;
      word-break:break-word;
    }

    .pillRow{
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      margin-top:8px;
    }

    .pill{
      padding:7px 10px;
      border-radius:999px;
      font-size:12px;
      font-weight:bold;
      border:1px solid rgba(255,255,255,.08);
      background:#10203d;
    }

    .pending{ color:#111; background:var(--gold); }
    .printing{ color:#fff; background:var(--blue); }
    .done{ color:#fff; background:var(--green); }
    .error{ color:#fff; background:var(--red); }
    .dispatch{ color:#111; background:var(--orange); }

    .metaGrid{
      display:grid;
      grid-template-columns:repeat(3,1fr);
      gap:10px;
    }

    .meta{
      background:#0b1730;
      border:1px solid rgba(255,255,255,.08);
      border-radius:14px;
      padding:12px;
    }

    .meta .k{
      color:var(--muted);
      font-size:12px;
      margin-bottom:6px;
    }

    .meta .v{
      font-weight:bold;
      word-break:break-word;
    }

    .section{
      background:#0b1730;
      border:1px solid rgba(255,255,255,.08);
      border-radius:14px;
      padding:12px;
    }

    .section h4{
      margin:0 0 8px;
      font-size:14px;
      color:var(--gold);
    }

    .section .txt{
      color:#e7eefc;
      line-height:1.55;
      white-space:pre-wrap;
      word-break:break-word;
    }

    .actions{
      display:flex;
      flex-wrap:wrap;
      gap:10px;
    }

    .btn{
      border:none;
      padding:11px 14px;
      border-radius:12px;
      font-size:13px;
    }

    .btn-blue{ background:var(--blue); color:#fff; }
    .btn-green{ background:var(--green); color:#fff; }
    .btn-red{ background:var(--red); color:#fff; }
    .btn-gold{ background:var(--gold); color:#111; }
    .btn-orange{ background:var(--orange); color:#111; }
    .btn-dark{ background:#13233f; color:#fff; border:1px solid rgba(255,255,255,.08); }

    .replyBox{
      display:grid;
      gap:10px;
    }

    .replyRow{
      display:grid;
      grid-template-columns:1fr auto;
      gap:10px;
    }

    .small{
      font-size:12px;
      color:var(--muted);
    }

    .empty{
      padding:40px 20px;
      text-align:center;
      color:var(--muted);
      background:rgba(14,26,43,.96);
      border:1px solid var(--line);
      border-radius:18px;
    }

    .footerGap{ height:20px; }

    @media (max-width:1100px){
      .toolbar{ grid-template-columns:1fr 1fr 1fr; }
      .manualGrid{ grid-template-columns:1fr 1fr; }
      .stats{ grid-template-columns:repeat(2,1fr); }
      .job{ grid-template-columns:1fr; }
      .metaGrid{ grid-template-columns:1fr 1fr; }
    }

    @media (max-width:700px){
      .toolbar{ grid-template-columns:1fr; }
      .manualGrid{ grid-template-columns:1fr; }
      .stats{ grid-template-columns:1fr; }
      .metaGrid{ grid-template-columns:1fr; }
      .replyRow{ grid-template-columns:1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div>
        <h1>MSTAF Worker & Agent Dashboard</h1>
        <p>View jobs, preview uploads, send customer replies, route work, start printing, complete jobs, flag errors, and keep dashboard visibility even when a file is missing on the server.</p>
      </div>
      <div class="badge">Secure Dashboard</div>
    </div>

    <div class="stats" id="stats"></div>

    <div class="panel">
      <div class="toolbar">
        <input id="q" placeholder="Search by file, customer, email, notes, service..." />
        <select id="status">
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="printing">Printing</option>
          <option value="done">Done</option>
          <option value="error">Error</option>
        </select>
        <select id="queue">
          <option value="">All Queues / Printers</option>
          <option value="AGENT">AGENT</option>
          <option value="DISPATCH">DISPATCH</option>
          ${printers.map(p => `<option value="${String(p.id).replace(/"/g, "&quot;")}">${String(p.id)}</option>`).join("")}
        </select>
        <select id="sort">
          <option value="newest">Newest First</option>
          <option value="oldest">Oldest First</option>
          <option value="status">Status</option>
          <option value="service">Service</option>
        </select>
        <select id="limit">
          <option value="20">20 Jobs</option>
          <option value="50" selected>50 Jobs</option>
          <option value="100">100 Jobs</option>
          <option value="200">200 Jobs</option>
        </select>
        <button id="reloadBtn">Reload</button>
      </div>

      <div class="tabs">
        <button class="tab active" data-tab="all">All Jobs</button>
        <button class="tab" data-tab="worker">Workers</button>
        <button class="tab" data-tab="agent">Agents</button>
        <button class="tab" data-tab="dispatch">Dispatch</button>
      </div>
    </div>

    <div class="panel manualBox">
      <h3 style="margin-top:0">Manual Dashboard Upload</h3>
      <div class="manualGrid">
        <div>
          <div class="small">Customer Name</div>
          <input id="mu_name" placeholder="Customer name" />
        </div>
        <div>
          <div class="small">Customer Email</div>
          <input id="mu_email" placeholder="Customer email" />
        </div>
        <div>
          <div class="small">Service Type</div>
          <select id="mu_service">
            <option value="print">print</option>
            <option value="image_editing">image_editing</option>
            <option value="video_editing">video_editing</option>
            <option value="laminating">laminating</option>
            <option value="id_photo">id_photo</option>
          </select>
        </div>
        <div>
          <div class="small">Queue / Printer</div>
          <select id="mu_printer">
            <option value="PP-USA-001">PP-USA-001</option>
            <option value="AGENT">AGENT</option>
            <option value="DISPATCH">DISPATCH</option>
            ${printers.map(p => `<option value="${String(p.id).replace(/"/g, "&quot;")}">${String(p.id)}</option>`).join("")}
          </select>
        </div>
        <div>
          <input id="mu_file" type="file" />
        </div>
      </div>
      <div style="margin-top:12px; display:grid; grid-template-columns:1fr auto; gap:12px;">
        <textarea id="mu_notes" rows="3" placeholder="Notes / instructions"></textarea>
        <button class="btn btn-gold" id="manualUploadBtn">Upload</button>
      </div>
    </div>

    <div id="jobs" class="jobs"></div>
    <div class="footerGap"></div>
  </div>

<script>
const DASHBOARD_KEY = "${key}";
const API_HEADERS = { "x-dashboard-key": decodeURIComponent(DASHBOARD_KEY) };

let currentTab = "all";
let allJobs = [];

function esc(v){
  return String(v ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}

function formatDate(v){
  if(!v) return "—";
  try { return new Date(v).toLocaleString(); }
  catch { return String(v); }
}

function money(v){
  const n = Number(v || 0);
  if (Number.isNaN(n)) return String(v ?? "—");
  return "$" + n.toFixed(2);
}

function isImage(url, mime){
  const s = String(url || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  return m.startsWith("image/") || /\\.(jpg|jpeg|png|gif|webp|bmp|svg)(\\?|$)/.test(s);
}

function isVideo(url, mime){
  const s = String(url || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  return m.startsWith("video/") || /\\.(mp4|webm|ogg|mov|m4v)(\\?|$)/.test(s);
}

function isAudio(url, mime){
  const s = String(url || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  return m.startsWith("audio/") || /\\.(mp3|wav|ogg|m4a|aac|opus)(\\?|$)/.test(s);
}

function isPdf(url, mime){
  const s = String(url || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  return m.includes("pdf") || /\\.pdf(\\?|$)/.test(s);
}

function statusClass(v){
  if (v === "pending") return "pending";
  if (v === "printing") return "printing";
  if (v === "done") return "done";
  if (v === "error") return "error";
  return "dispatch";
}

function tabMatch(job){
  const pid = String(job.printer_id || "").toUpperCase();
  if(currentTab === "all") return true;
  if(currentTab === "agent") return pid === "AGENT";
  if(currentTab === "dispatch") return pid === "DISPATCH";
  if(currentTab === "worker") return pid !== "AGENT" && pid !== "DISPATCH";
  return true;
}

function buildPreview(job){
  const fileUrl = job.file_url || "";
  const mime = job.mime_type || "";

  if (!fileUrl) {
    return '<div class="missing"><strong>No file URL saved</strong><br>This job exists in the dashboard, but no file URL was stored for preview.</div>';
  }

  const safeUrl = esc(fileUrl);

  if (isImage(fileUrl, mime)) {
    return \`
      <div style="width:100%">
        <img src="\${safeUrl}" alt="preview" onerror="this.parentNode.innerHTML='<div class=&quot;missing&quot;><strong>File missing on server</strong><br>The job still exists in the dashboard, but the upload file is no longer available at this URL.</div>'" />
      </div>\`;
  }

  if (isVideo(fileUrl, mime)) {
    return \`
      <div style="width:100%">
        <video controls preload="metadata" onerror="this.parentNode.innerHTML='<div class=&quot;missing&quot;><strong>Video file missing on server</strong><br>The dashboard still has the job record, but the actual file cannot be loaded.</div>'">
          <source src="\${safeUrl}" type="\${esc(mime || "video/mp4")}">
        </video>
      </div>\`;
  }

  if (isAudio(fileUrl, mime)) {
    return \`
      <div style="width:100%; text-align:center">
        <audio controls style="width:100%" onerror="this.parentNode.innerHTML='<div class=&quot;missing&quot;><strong>Audio file missing on server</strong><br>This job is saved, but the audio file cannot be loaded.</div>'">
          <source src="\${safeUrl}" type="\${esc(mime || "audio/mpeg")}">
        </audio>
      </div>\`;
  }

  if (isPdf(fileUrl, mime)) {
    return \`
      <div style="width:100%">
        <iframe src="\${safeUrl}" onerror="this.parentNode.innerHTML='<div class=&quot;missing&quot;><strong>PDF preview unavailable</strong><br>Use Open File below. If that also fails, the file is missing on the server.</div>'"></iframe>
      </div>\`;
  }

  return \`
    <div class="missing">
      <strong>No inline preview for this file type</strong><br>
      Use the Open File button below to view or download it.
    </div>\`;
}

function renderStats(jobs){
  const total = jobs.length;
  const pending = jobs.filter(j => j.status === "pending").length;
  const printing = jobs.filter(j => j.status === "printing").length;
  const done = jobs.filter(j => j.status === "done").length;
  const error = jobs.filter(j => j.status === "error").length;

  document.getElementById("stats").innerHTML = \`
    <div class="cardStat"><div class="label">Total Jobs</div><div class="value">\${total}</div></div>
    <div class="cardStat"><div class="label">Pending</div><div class="value">\${pending}</div></div>
    <div class="cardStat"><div class="label">Printing</div><div class="value">\${printing}</div></div>
    <div class="cardStat"><div class="label">Done</div><div class="value">\${done}</div></div>
    <div class="cardStat"><div class="label">Error</div><div class="value">\${error}</div></div>
  \`;
}

function renderJobs(){
  const q = document.getElementById("q").value.trim().toLowerCase();
  const status = document.getElementById("status").value;
  const queue = document.getElementById("queue").value;
  const sort = document.getElementById("sort").value;

  let jobs = [...allJobs]
    .filter(tabMatch)
    .filter(job => !status || String(job.status || "") === status)
    .filter(job => !queue || String(job.printer_id || "") === queue)
    .filter(job => {
      if (!q) return true;
      const hay = [
        job.id, job.original_name, job.customer_name, job.customer_email,
        job.notes, job.instructions, job.service_type, job.file_url,
        job.printer_id, job.paper_size, job.color_mode
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });

  if (sort === "oldest") {
    jobs.sort((a,b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  } else if (sort === "status") {
    jobs.sort((a,b) => String(a.status || "").localeCompare(String(b.status || "")));
  } else if (sort === "service") {
    jobs.sort((a,b) => String(a.service_type || "").localeCompare(String(b.service_type || "")));
  } else {
    jobs.sort((a,b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }

  const box = document.getElementById("jobs");

  if (!jobs.length) {
    box.innerHTML = '<div class="empty">No jobs found for this filter.</div>';
    return;
  }

  box.innerHTML = jobs.map(job => {
    const fileUrl = job.file_url || "";
    const audioUrl = job.instruction_audio_url || "";
    const routeOptions = [
      "PP-USA-001",
      "AGENT",
      "DISPATCH",
      ...Array.from(new Set(${JSON.stringify(printers.map(p => String(p.id)))}))
    ].filter(Boolean).map(v => \`<option value="\${esc(v)}">\${esc(v)}</option>\`).join("");

    return \`
      <div class="job">
        <div class="preview">
          \${buildPreview(job)}
        </div>

        <div class="details">
          <div class="topRow">
            <div>
              <div class="title">\${esc(job.original_name || job.service_type || "Untitled job")}</div>
              <div class="sub">
                Job ID: <strong>\${esc(job.id)}</strong><br>
                Created: \${esc(formatDate(job.created_at))}<br>
                File URL: \${fileUrl ? \`<a style="color:#8fc7ff" href="\${esc(fileUrl)}" target="_blank" rel="noopener">Open in new tab</a>\` : "—"}
              </div>
              <div class="pillRow">
                <span class="pill \${statusClass(job.status)}">\${esc(job.status || "unknown")}</span>
                <span class="pill">\${esc(job.service_type || "—")}</span>
                <span class="pill">\${esc(job.printer_id || "—")}</span>
                <span class="pill">\${esc(job.paper_size || "—")}</span>
                <span class="pill">\${esc(job.color_mode || "—")}</span>
              </div>
            </div>

            <div class="actions">
              <button class="btn btn-dark" onclick="copyText('\${esc(fileUrl)}')">Copy File URL</button>
              \${fileUrl ? \`<a class="btn btn-dark" style="text-decoration:none; display:inline-flex; align-items:center" href="\${esc(fileUrl)}" target="_blank" rel="noopener">Open File</a>\` : ""}
            </div>
          </div>

          <div class="metaGrid">
            <div class="meta"><div class="k">Customer Name</div><div class="v">\${esc(job.customer_name || "—")}</div></div>
            <div class="meta"><div class="k">Customer Email</div><div class="v">\${esc(job.customer_email || "—")}</div></div>
            <div class="meta"><div class="k">Country / City</div><div class="v">\${esc([job.country, job.city].filter(Boolean).join(" / ") || "—")}</div></div>
            <div class="meta"><div class="k">Copies</div><div class="v">\${esc(job.copies || "—")}</div></div>
            <div class="meta"><div class="k">Pages</div><div class="v">\${esc(job.pages || "—")}</div></div>
            <div class="meta"><div class="k">Total Cost</div><div class="v">\${esc(money(job.total_cost))}</div></div>
          </div>

          <div class="section">
            <h4>Notes / Instructions</h4>
            <div class="txt">\${esc(job.notes || job.instructions || "No notes provided.")}</div>
          </div>

          \${audioUrl ? \`
            <div class="section">
              <h4>Instruction Audio</h4>
              <audio controls style="width:100%">
                <source src="\${esc(audioUrl)}">
              </audio>
            </div>\` : ""}

          <div class="section">
            <h4>Route Job</h4>
            <div style="display:grid; grid-template-columns:1fr auto; gap:10px;">
              <select id="route_\${esc(job.id)}">\${routeOptions}</select>
              <button class="btn btn-orange" onclick="routeJob('\${esc(job.id)}')">Route</button>
            </div>
          </div>

          <div class="actions">
            <button class="btn btn-blue" onclick="markJob('\${esc(job.id)}','printing')">Claim / Start</button>
            <button class="btn btn-green" onclick="markJob('\${esc(job.id)}','done')">Complete</button>
            <button class="btn btn-red" onclick="failJobPrompt('\${esc(job.id)}')">Fail</button>
          </div>

          <div class="section">
            <h4>Reply to Customer on WhatsApp</h4>
            <div class="replyBox">
              <div class="replyRow">
                <textarea id="reply_\${esc(job.id)}" rows="3" placeholder="Type customer reply here..."></textarea>
                <button class="btn btn-gold" onclick="sendReply('\${esc(job.id)}')">Send Reply</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    \`;
  }).join("");
}

async function loadJobs(){
  try{
    const limit = document.getElementById("limit").value || "50";
    const q = encodeURIComponent(document.getElementById("q").value || "");
    const status = encodeURIComponent(document.getElementById("status").value || "");
    const queue = encodeURIComponent(document.getElementById("queue").value || "");
    const url = \`/api/dashboard/jobs?limit=\${limit}&q=\${q}&status=\${status}&printer_id=\${queue}\`;

    const res = await fetch(url, { headers: API_HEADERS });
    const data = await res.json();

    allJobs = Array.isArray(data.jobs) ? data.jobs : (Array.isArray(data) ? data : []);
    renderStats(allJobs);
    renderJobs();
  }catch(err){
    console.error(err);
    document.getElementById("jobs").innerHTML = '<div class="empty">Failed to load jobs.</div>';
  }
}

async function routeJob(id){
  const printerId = document.getElementById("route_" + id).value;
  try{
    const res = await fetch("/api/dashboard/jobs/" + encodeURIComponent(id) + "/route", {
      method: "POST",
      headers: { ...API_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ printer_id: printerId })
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || "Route failed");
    await loadJobs();
    alert("Job routed successfully.");
  }catch(err){
    alert(err.message || "Route failed.");
  }
}

async function markJob(id, status){
  try{
    const res = await fetch("/api/dashboard/jobs/" + encodeURIComponent(id) + "/mark", {
      method: "POST",
      headers: { ...API_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || "Status update failed");
    await loadJobs();
    alert("Job updated.");
  }catch(err){
    alert(err.message || "Status update failed.");
  }
}

async function failJobPrompt(id){
  const msg = prompt("Enter failure reason:");
  if (msg === null) return;
  try{
    const res = await fetch("/api/dashboard/jobs/" + encodeURIComponent(id) + "/mark", {
      method: "POST",
      headers: { ...API_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "error", error_message: msg })
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || "Fail update failed");
    await loadJobs();
    alert("Job marked as error.");
  }catch(err){
    alert(err.message || "Fail update failed.");
  }
}

async function sendReply(id){
  const text = document.getElementById("reply_" + id).value.trim();
  if(!text) return alert("Please type a reply first.");

  try{
    const res = await fetch("/api/dashboard/jobs/" + encodeURIComponent(id) + "/reply", {
      method: "POST",
      headers: { ...API_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ message: text })
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || "Reply failed");
    document.getElementById("reply_" + id).value = "";
    alert("Reply sent.");
  }catch(err){
    alert(err.message || "Reply failed.");
  }
}

async function manualUpload(){
  const fileInput = document.getElementById("mu_file");
  if(!fileInput.files || !fileInput.files[0]) return alert("Choose a file first.");

  const fd = new FormData();
  fd.append("file", fileInput.files[0]);
  fd.append("customer_name", document.getElementById("mu_name").value || "");
  fd.append("customer_email", document.getElementById("mu_email").value || "");
  fd.append("service_type", document.getElementById("mu_service").value || "print");
  fd.append("printer_id", document.getElementById("mu_printer").value || "PP-USA-001");
  fd.append("notes", document.getElementById("mu_notes").value || "");

  try{
    const res = await fetch("/api/dashboard/manual-upload", {
      method: "POST",
      headers: API_HEADERS,
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || "Manual upload failed");
    fileInput.value = "";
    document.getElementById("mu_notes").value = "";
    await loadJobs();
    alert("Manual upload successful.");
  }catch(err){
    alert(err.message || "Manual upload failed.");
  }
}

function copyText(v){
  navigator.clipboard.writeText(v || "").then(() => {
    alert("Copied.");
  }).catch(() => {
    alert("Copy failed.");
  });
}

document.getElementById("reloadBtn").addEventListener("click", loadJobs);
document.getElementById("manualUploadBtn").addEventListener("click", manualUpload);
document.getElementById("q").addEventListener("input", renderJobs);
document.getElementById("status").addEventListener("change", loadJobs);
document.getElementById("queue").addEventListener("change", loadJobs);
document.getElementById("sort").addEventListener("change", renderJobs);
document.getElementById("limit").addEventListener("change", loadJobs);

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentTab = btn.dataset.tab;
    renderJobs();
  });
});

loadJobs();
</script>
</body>
</html>`);
});
 

/******************************************************************
 * WORKER + AGENT DASHBOARD END
 ******************************************************************/



   
          
app.use(express.urlencoded({ extended: true }));

app.post("/dashboard/send-reply", async (req, res) => {
  const { key, to, message } = req.body;

  if (key !== process.env.DASHBOARD_KEY) {
    return res.status(403).send("Unauthorized");
  }

  if (!to || !message || !message.trim()) {
    return res.status(400).send("Missing phone number or message.");
  }

  try {
    await sendMessage(to, message.trim());
    return res.redirect(`/dashboard?key=${encodeURIComponent(key)}&sent=1`);
  } catch (err) {
    console.error("Dashboard reply send error:", err.response?.data || err.message || err);
    return res.redirect(`/dashboard?key=${encodeURIComponent(key)}&sent=0`);
  }
});
   

 
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
