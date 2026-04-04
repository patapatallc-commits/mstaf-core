const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "20mb" }));

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
    pendingFile: null
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

    const lower = text.toLowerCase().trim();

    // =========================
    // MEDIA CAPTURE
    // =========================
    if (type === "image" || type === "document" || type === "audio" || type === "video") {
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

      // ID PHOTO / IMAGE / VIDEO / LESSON AUDIO OR FILE
      if (session.stage === "IDPHOTO_WAITING_UPLOAD") {
        await sendMessage(
          from,
          `✅ ID photo file received.

Our team is reviewing your request and will provide pricing shortly.`
        );
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        return res.sendStatus(200);
      }

      if (session.stage === "IMAGE_EDIT_WAITING_UPLOAD") {
        await sendMessage(
          from,
          `✅ Image received.

Our editing team is reviewing your request and will contact you shortly on WhatsApp.`
        );
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        return res.sendStatus(200);
      }

      if (session.stage === "VIDEO_EDIT_WAITING_UPLOAD") {
        await sendMessage(
          from,
          `✅ Video received.

Our editing team is reviewing your request and will contact you shortly on WhatsApp.`
        );
        // SAVE TO DASHBOARD
try {
  const pending = session.pendingFile || {};

  const fileName =
    pending.filename ||
    pending.media_id ||
    "uploaded-file";

  const mimeType = pending.mime_type || "";
  const mediaId = pending.media_id || "";
  const fileUrl = mediaId ? `whatsapp-media:${mediaId}` : "";

  const instructions =
    session.instructions ||
    session.caption ||
    "Service request";

  await pool.query(
    `
    INSERT INTO print_jobs (
      customer_phone,
      file_url,
      original_name,
      mime_type,
      paper_size,
      color_mode,
      copies,
      status,
      instructions,
      notes
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `,
    [
      from,
      fileUrl,
      fileName,
      mimeType,
      "SERVICE",
      "AGENT",
      1,
      "pending",
      instructions,
      `agent_queue|type=${type}|media_id=${mediaId}`
    ]
  );

} catch (err) {
  console.error("Save error:", err);
}
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        return res.sendStatus(200);
      }

      if (session.stage === "LESSON_WAITING_UPLOAD") {
        await sendMessage(
          from,
          `✅ Your lesson or homework file has been received.

Our team will review it and contact you shortly on WhatsApp.`
        );
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";
        return res.sendStatus(200);
      }
    }

    // =========================
    // GREETING / RESET
    // =========================
    if (["hi", "hello", "hey", "menu", "start"].includes(lower)) {
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
        return res.sendStatus(200);
      }

      if (type === "audio") {
        await sendMessage(
          from,
          `✅ Your voice note has been received.

Our team will contact you shortly on WhatsApp.`
        );
        return res.sendStatus(200);
      }

      await sendMessage(
        from,
        "Please send your message as text or voice note."
      );
      return res.sendStatus(200);
    }

    // =========================
    // DEFAULT FALLBACK
    // =========================
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



 
 

// =========================
// HEALTH
// =========================
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
app.get("/dashboard", async (req, res) => {
  const key = req.query.key;

  if (key !== process.env.DASHBOARD_KEY) {
    return res.status(403).send("Unauthorized");
  }

  try {
    const result = await pool.query(`
      SELECT * FROM print_jobs
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT 100
    `);

    const jobs = result.rows || [];
    const sentFlag = req.query.sent;

    const escapeHtml = (value) =>
      String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    const notice =
      sentFlag === "1"
        ? `
          <div class="notice success">
            ✅ WhatsApp reply sent successfully.
          </div>
        `
        : sentFlag === "0"
        ? `
          <div class="notice error">
            ❌ Failed to send WhatsApp reply.
          </div>
        `
        : "";

    const isAgentJob = (j) => {
      const paper = String(j.paper_size || "").toUpperCase();
      const color = String(j.color_mode || "").toUpperCase();
      const notes = String(j.notes || "").toLowerCase();
      return (
        paper === "SERVICE" ||
        color === "AGENT" ||
        notes.includes("agent_queue") ||
        notes.includes("type=image") ||
        notes.includes("type=video") ||
        notes.includes("type=audio") ||
        notes.includes("type=document")
      );
    };

    const printJobs = jobs.filter((j) => !isAgentJob(j));
    const agentJobs = jobs.filter((j) => isAgentJob(j));
    const pendingJobs = jobs.filter((j) => String(j.status || "").toLowerCase() === "pending");
    const completedJobs = jobs.filter((j) => String(j.status || "").toLowerCase() === "completed");

    const getStatusClass = (status) => {
      const s = String(status || "").toLowerCase();
      if (s === "completed") return "status-completed";
      if (s === "printing") return "status-printing";
      if (s === "failed") return "status-failed";
      return "status-pending";
    };

    const buildFileDisplay = (job) => {
      const raw = String(job.file_url || "").trim();
      if (!raw) {
        return `<span class="muted">No file</span>`;
      }

      if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("/")) {
        return `<a class="file-link" href="${escapeHtml(raw)}" target="_blank">Open file</a>`;
      }

      if (raw.startsWith("whatsapp-media:")) {
        const mediaId = raw.replace("whatsapp-media:", "");
        return `
          <div class="media-pill">WhatsApp media saved</div>
          <div class="meta-line"><strong>Media ID:</strong> ${escapeHtml(mediaId)}</div>
        `;
      }

      return `<span class="muted">${escapeHtml(raw)}</span>`;
    };

    const buildJobCard = (j, queueLabel) => {
      const phone = String(j.customer_phone || j.phone_number || j.whatsapp_number || "").trim();
      const safePhone = escapeHtml(phone);
      const instructions = escapeHtml(j.instructions || "None");
      const originalName = escapeHtml(j.original_name || "");
      const mimeType = escapeHtml(j.mime_type || "");
      const notes = escapeHtml(j.notes || "");
      const paperSize = escapeHtml(j.paper_size || "");
      const colorMode = escapeHtml(j.color_mode || "");
      const copies = escapeHtml(j.copies || "");
      const createdAt = j.created_at ? escapeHtml(new Date(j.created_at).toLocaleString()) : "";
      const title = queueLabel === "AGENT" ? "Agent Job" : "Print Job";

      return `
        <div class="job-card">
          <div class="job-top">
            <div>
              <div class="job-id">${title} #${escapeHtml(j.id)}</div>
              <div class="job-sub">
                <span class="queue-tag ${queueLabel === "AGENT" ? "queue-agent" : "queue-print"}">
                  ${queueLabel}
                </span>
                <span class="status-tag ${getStatusClass(j.status)}">
                  ${escapeHtml(j.status || "pending")}
                </span>
              </div>
            </div>
          </div>

          <div class="job-grid">
            <div class="info-block">
              <div class="label">Customer Phone</div>
              <div class="value">${safePhone || '<span class="muted">Not saved</span>'}</div>
            </div>

            <div class="info-block">
              <div class="label">Paper / Service</div>
              <div class="value">${paperSize || '<span class="muted">—</span>'}</div>
            </div>

            <div class="info-block">
              <div class="label">Color / Queue</div>
              <div class="value">${colorMode || '<span class="muted">—</span>'}</div>
            </div>

            <div class="info-block">
              <div class="label">Copies</div>
              <div class="value">${copies || '<span class="muted">—</span>'}</div>
            </div>

            <div class="info-block">
              <div class="label">Filename</div>
              <div class="value">${originalName || '<span class="muted">Not available</span>'}</div>
            </div>

            <div class="info-block">
              <div class="label">Mime Type</div>
              <div class="value">${mimeType || '<span class="muted">Not available</span>'}</div>
            </div>
          </div>

          <div class="full-block">
            <div class="label">Instructions</div>
            <div class="value">${instructions}</div>
          </div>

          <div class="full-block">
            <div class="label">File</div>
            <div class="value">${buildFileDisplay(j)}</div>
          </div>

          ${
            createdAt
              ? `
            <div class="full-block">
              <div class="label">Created</div>
              <div class="value">${createdAt}</div>
            </div>
          `
              : ""
          }

          ${
            notes
              ? `
            <div class="full-block">
              <div class="label">Notes</div>
              <div class="value notes-box">${notes}</div>
            </div>
          `
              : ""
          }

          <div class="reply-box">
            <div class="reply-title">Send WhatsApp Reply</div>
            <form method="POST" action="/dashboard/send-reply">
              <input type="hidden" name="key" value="${escapeHtml(String(key))}">
              <input type="hidden" name="to" value="${safePhone}">

              <textarea
                name="message"
                placeholder="Type your message to the customer here..."
              >Hello, your job #${escapeHtml(j.id)} is being reviewed.</textarea>

              <button type="submit" ${phone ? "" : "disabled"}>
                ${phone ? "Send WhatsApp Reply" : "Phone Not Saved"}
              </button>
            </form>
          </div>
        </div>
      `;
    };

    const printCards = printJobs.length
      ? printJobs.map((j) => buildJobCard(j, "PRINT")).join("")
      : `<div class="empty-box">No print jobs found.</div>`;

    const agentCards = agentJobs.length
      ? agentJobs.map((j) => buildJobCard(j, "AGENT")).join("")
      : `<div class="empty-box">No agent/editing jobs found.</div>`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>MSTAF Worker Dashboard</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: Arial, sans-serif;
            background:
              radial-gradient(circle at top left, #edf4ff 0%, #f8fafc 35%, #eef2ff 100%);
            color: #111827;
          }

          .wrap {
            max-width: 1400px;
            margin: 0 auto;
            padding: 24px;
          }

          .hero {
            background: linear-gradient(135deg, #111827, #1d4ed8, #0f766e);
            color: #fff;
            border-radius: 22px;
            padding: 28px;
            box-shadow: 0 20px 50px rgba(0,0,0,0.16);
            margin-bottom: 22px;
          }

          .hero h1 {
            margin: 0 0 8px;
            font-size: 34px;
            line-height: 1.1;
          }

          .hero p {
            margin: 0;
            opacity: 0.95;
            font-size: 15px;
          }

          .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px;
            margin: 22px 0;
          }

          .stat-card {
            background: rgba(255,255,255,0.95);
            border: 1px solid rgba(255,255,255,0.7);
            border-radius: 18px;
            padding: 18px;
            box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
          }

          .stat-label {
            font-size: 13px;
            color: #475569;
            margin-bottom: 8px;
          }

          .stat-value {
            font-size: 30px;
            font-weight: 700;
          }

          .notice {
            padding: 16px 18px;
            border-radius: 14px;
            margin-bottom: 20px;
            font-weight: 600;
          }

          .notice.success {
            background: #dcfce7;
            color: #166534;
            border: 1px solid #bbf7d0;
          }

          .notice.error {
            background: #fee2e2;
            color: #991b1b;
            border: 1px solid #fecaca;
          }

          .section {
            margin-top: 26px;
          }

          .section-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 14px;
          }

          .section-head h2 {
            margin: 0;
            font-size: 24px;
          }

          .section-badge {
            background: #e0e7ff;
            color: #3730a3;
            border-radius: 999px;
            padding: 8px 12px;
            font-size: 12px;
            font-weight: 700;
          }

          .cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(390px, 1fr));
            gap: 18px;
          }

          .job-card {
            background: rgba(255,255,255,0.96);
            border: 1px solid #e2e8f0;
            border-radius: 22px;
            padding: 20px;
            box-shadow: 0 14px 40px rgba(15, 23, 42, 0.08);
          }

          .job-top {
            display: flex;
            align-items: start;
            justify-content: space-between;
            margin-bottom: 16px;
          }

          .job-id {
            font-size: 24px;
            font-weight: 800;
            margin-bottom: 8px;
          }

          .job-sub {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
          }

          .queue-tag,
          .status-tag,
          .media-pill {
            display: inline-block;
            border-radius: 999px;
            padding: 7px 11px;
            font-size: 12px;
            font-weight: 700;
          }

          .queue-print { background: #dbeafe; color: #1d4ed8; }
          .queue-agent { background: #f3e8ff; color: #7c3aed; }

          .status-pending { background: #fef3c7; color: #92400e; }
          .status-printing { background: #dbeafe; color: #1d4ed8; }
          .status-completed { background: #dcfce7; color: #166534; }
          .status-failed { background: #fee2e2; color: #991b1b; }

          .media-pill {
            background: #ede9fe;
            color: #6d28d9;
            margin-bottom: 8px;
          }

          .job-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
            margin-bottom: 14px;
          }

          .info-block,
          .full-block,
          .reply-box {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 16px;
            padding: 14px;
          }

          .full-block { margin-bottom: 12px; }
          .reply-box { margin-top: 14px; }

          .label {
            font-size: 12px;
            font-weight: 700;
            color: #475569;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            margin-bottom: 7px;
          }

          .value {
            font-size: 15px;
            line-height: 1.5;
            word-break: break-word;
          }

          .muted {
            color: #64748b;
          }

          .notes-box {
            white-space: pre-wrap;
          }

          .file-link {
            color: #2563eb;
            text-decoration: none;
            font-weight: 700;
          }

          .file-link:hover {
            text-decoration: underline;
          }

          .meta-line {
            font-size: 13px;
            color: #475569;
          }

          .reply-title {
            font-size: 18px;
            font-weight: 800;
            margin-bottom: 10px;
          }

          textarea {
            width: 100%;
            min-height: 110px;
            border: 1px solid #cbd5e1;
            border-radius: 14px;
            padding: 14px;
            resize: vertical;
            font-size: 14px;
            font-family: Arial, sans-serif;
            background: #fff;
          }

          button {
            margin-top: 12px;
            border: none;
            border-radius: 14px;
            padding: 12px 18px;
            font-size: 14px;
            font-weight: 700;
            cursor: pointer;
            background: linear-gradient(135deg, #111827, #1d4ed8);
            color: #fff;
            box-shadow: 0 10px 24px rgba(29, 78, 216, 0.22);
          }

          button:disabled {
            cursor: not-allowed;
            opacity: 0.6;
            background: #94a3b8;
            box-shadow: none;
          }

          .empty-box {
            background: rgba(255,255,255,0.96);
            border: 1px dashed #cbd5e1;
            border-radius: 18px;
            padding: 20px;
            color: #64748b;
          }

          @media (max-width: 860px) {
            .job-grid {
              grid-template-columns: 1fr;
            }

            .hero h1 {
              font-size: 28px;
            }

            .cards {
              grid-template-columns: 1fr;
            }
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="hero">
            <h1>🖨️ MSTAF Worker Dashboard</h1>
            <p>Monitor print jobs, review editing requests, and reply to customers on WhatsApp from one place.</p>
          </div>

          ${notice}

          <div class="stats">
            <div class="stat-card">
              <div class="stat-label">Total Jobs</div>
              <div class="stat-value">${jobs.length}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Pending Jobs</div>
              <div class="stat-value">${pendingJobs.length}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Print Queue</div>
              <div class="stat-value">${printJobs.length}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Agent Queue</div>
              <div class="stat-value">${agentJobs.length}</div>
            </div>
          </div>

          <div class="section">
            <div class="section-head">
              <h2>🖨️ Print Queue</h2>
              <div class="section-badge">${printJobs.length} jobs</div>
            </div>
            <div class="cards">
              ${printCards}
            </div>
          </div>

          <div class="section">
            <div class="section-head">
              <h2>🎨 Agent / Editing Queue</h2>
              <div class="section-badge">${agentJobs.length} jobs</div>
            </div>
            <div class="cards">
              ${agentCards}
            </div>
          </div>

          <div class="section">
            <div class="section-head">
              <h2>✅ Completed Snapshot</h2>
              <div class="section-badge">${completedJobs.length} completed</div>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    res.send(html);
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send("Server error");
  }
});

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
   

 
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
