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

After upload, choose:
1 - Continue with Agent
2 - Checkout`
);
return res.sendStatus(200);  
       
      }
// =========================
// LAMINATE FILE ACTION
// =========================
if (session.stage === "LAMINATE_FILE_UPLOADED_ACTION") {
  if (lower === "1") {
    session.stage = "LAMINATE_WAITING_INSTRUCTIONS";

    await sendMessage(
      from,
      `✅ Your ${session.laminateSpec?.paper_size || "laminate"} laminate request has been forwarded to our Agent team.

Please send any instructions now by text or voice.

Our team will contact you shortly on WhatsApp.`
    );
    return res.sendStatus(200);
  }

  if (lower === "2") {
    session.stage = "LAMINATE_PAYMENT_CHOICE";

    const paperSize = session.laminateSpec?.paper_size || "LETTER";
    const quantity = session.laminateSpec?.copies || 1;
    const variantId = getLaminateVariantId(paperSize);
    const checkoutUrl = buildShopifyCartUrl(variantId, quantity);
    const africaUrl = "https://www.patapata.us/pages/africa-payment";

    await sendMessage(
      from,
      `Choose payment option:

1 - Shopify Checkout
2 - Africa Payment

Shopify:
${checkoutUrl || `Not configured yet for ${paperSize} Laminate`}

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
// LAMINATE AGENT INSTRUCTIONS
// =========================
if (session.stage === "LAMINATE_WAITING_INSTRUCTIONS") {
  if (type === "text") {
    await sendMessage(
      from,
      `✅ Your ${session.laminateSpec?.paper_size || "laminate"} laminate instruction has been received and sent to our Agent team.

Our team will contact you shortly on WhatsApp.`
    );
    return res.sendStatus(200);
  }

  if (type === "audio") {
    await sendMessage(
      from,
      `✅ Your voice instruction for your ${session.laminateSpec?.paper_size || "laminate"} laminate request has been received and sent to our Agent team.

Our team will contact you shortly on WhatsApp.`
    );
    return res.sendStatus(200);
  }

  await sendMessage(
    from,
    "Please send your laminate instruction as text or voice note."
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
    // =========================
// LAMINATE FILE ACTION (FIXED FLOW)
// =========================
if (session.stage === "LAMINATE_FILE_UPLOADED_ACTION") {
  if (lower === "1") {
    session.stage = "LAMINATE_WAITING_INSTRUCTIONS";

    await sendMessage(
      from,
      `✅ Your ${session.laminateSpec?.paper_size || "laminate"} laminate request has been forwarded to our Agent team.

Please send any instructions now by text or voice.

Our team will contact you shortly on WhatsApp.`
    );
    return res.sendStatus(200);
  }

  if (lower === "2") {
    session.stage = "LAMINATE_PAYMENT_CHOICE";

    await sendMessage(
      from,
      `Choose payment option:

1 - Shopify Checkout
2 - Africa Payment`
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

// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
