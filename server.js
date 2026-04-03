const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
require("dotenv").config();
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;
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
const sessions = new Map();

function createSession() {
  return {
    stage: "MENU",
    selectedService: null,
    printSpec: {},
    laminateSpec: {}
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
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;
    const session = getSession(from);

    let text = "";
    if (type === "text") {
      text = message.text.body;
    }

    const lower = (text || "").toLowerCase().trim();
// =====================
// FILE UPLOAD CAPTURE
// =====================
if (type === "image" || type === "document") {
  const mediaObj = type === "image" ? message.image : message.document;

  session.pendingFile = {
    type,
    media_id: mediaObj?.id || "",
    mime_type: mediaObj?.mime_type || "",
    filename: mediaObj?.filename || (type === "image" ? "image" : "document")
  };

if (session.stage === "LAMINATE_WAITING_INSTRUCTIONS") {
  session.stage = "LAMINATE_FILE_UPLOADED_ACTION";

  await sendMessage(
    from,
    `📄 Document received successfully.

Choose payment option:
1 - Shopify Checkout
2 - Africa Payment
  );

  return res.sendStatus(200);
}
  if (session.stage === "PRINT_WAITING_FILE") {
    session.stage = "PRINT_FILE_UPLOADED_ACTION";

    await sendMessage(
      from,
      `✅ File received.

Reply:
1 - Continue with Agent
2 - 2 - Checkout
    

    return res.sendStatus(200);
  }
}
    // ======================
    // GREETING
    // ======================
    if (["hi", "hello", "hey"].includes(lower)) {
      resetSession(from);

      await sendMessage(
        from,
        `Hello 👋 Welcome to PATAPATA Print-O-Matic

${serviceMenu()}`
      );

      return res.sendStatus(200);
    }

    // ======================
    // MENU SELECTION
    // ======================
    if (session.stage === "MENU") {
      if (lower === "1") {
        session.stage = "PRINT_SELECT_SIZE";
        await sendMessage(from, printSizeMenuText());
        return res.sendStatus(200);
      }

      if (lower === "2") {
        session.stage = "LAMINATE_SELECT_SIZE";
        await sendMessage(from, laminateSizeMenuText());
        return res.sendStatus(200);
      }
if (session.stage === "PRINT_WAITING_INSTRUCTIONS") {
  if (type === "text") {
    await sendMessage(
      from,
      "✅ Your print instructions have been received and sent to the Agent."
    );
    return res.sendStatus(200);
  }

  if (type === "audio") {
    await sendMessage(
      from,
      "✅ Your voice instruction has been received and sent to the Agent."
    );
    return res.sendStatus(200);
  }

  await sendMessage(
    from,
    "Please send your instruction as text or voice note."
  );
  return res.sendStatus(200);
}
      await sendMessage(from, serviceMenu());
      return res.sendStatus(200);
    }
        // ======================
    // PRINT SIZE
    // ======================
    if (session.stage === "PRINT_SELECT_SIZE") {
      const map = {
        "1": "A4",
        "2": "A3",
        "3": "LETTER",
        "4": "LEGAL",
        "5": "TABLOID",
        "6": "CARD"
      };

      const size = map[lower];

      if (!size) {
        await sendMessage(from, "Reply 1–6");
        return res.sendStatus(200);
      }

      session.printSpec.paper_size = size;
      session.stage = "PRINT_SELECT_COLOR";

      await sendMessage(from, printColorMenuText());
      return res.sendStatus(200);
    }

    // ======================
    // PRINT COLOR
    // ======================
    if (session.stage === "PRINT_SELECT_COLOR") {
      if (lower === "1") session.printSpec.color = "bw";
      else if (lower === "2") session.printSpec.color = "color";
      else {
        await sendMessage(from, "Reply 1 or 2");
        return res.sendStatus(200);
      }

      session.stage = "PRINT_SELECT_COPIES";
      await sendMessage(from, "How many copies?");
      return res.sendStatus(200);
    }

    // ======================
// COPIES
// ======================
if (session.stage === "PRINT_SELECT_COPIES") {
  session.printSpec.copies = parseInt(lower, 10) || 1;

  session.stage = "PRINT_SELECT_PAGES";
  await sendMessage(from, "How many pages?");
  return res.sendStatus(200);
}

// ======================
// PRINT PAGES
// ======================
if (session.stage === "PRINT_SELECT_PAGES") {
  session.printSpec.pages = parseInt(lower, 10) || 1;

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
        if (session.stage === "LAMINATE_SELECT_SIZE") {
      const map = {
        "1": "LETTER",
        "2": "LEGAL",
        "3": "TABLOID"
      };

      const size = map[lower];

      if (!size) {
        await sendMessage(from, "Reply 1–3");
        return res.sendStatus(200);
      }

      session.laminateSpec.paper_size = size;

      await sendMessage(from, "How many copies?");
      session.stage = "LAMINATE_SELECT_COPIES";
      return res.sendStatus(200);
    }
    if (session.stage === "LAMINATE_SELECT_COPIES") {
  const copies = parseInt(lower, 10);

  if (!copies || copies < 1) {
    await sendMessage(from, "Reply with a valid number of copies.");
    return res.sendStatus(200);
  }

  session.laminateSpec.copies = copies;
  session.stage = "LAMINATE_WAITING_INSTRUCTIONS";

  await sendMessage(
    from,
    "✅ Laminate details saved.\n\nPlease upload your document now. You can also add extra instructions by text or voice."
  );
  return res.sendStatus(200);
}
if (session.stage === "PRINT_FILE_UPLOADED_ACTION") {
  if (lower === "1") {
    session.stage = "PRINT_WAITING_INSTRUCTIONS";
    await sendMessage(
  from,
  `✅ Your request has been forwarded to our Agent team.

Please send any instructions now by text or voice.

Our team will review your request and contact you shortly on WhatsApp.`
);
  if (lower === "2") {
  const selectedColor =
  session.printSpec?.color || session.printSpec?.color_mode || "bw";

const isColor = selectedColor === "color";

const bwVariant = process.env.SHOPIFY_VARIANT_PRINT_A4_BW || "52221221273899";
const colorVariant = process.env.SHOPIFY_VARIANT_PRINT_A4_COLOR || "52221221437739";

const variantId = isColor ? colorVariant : bwVariant;
const quantity = session.printSpec?.copies || 1;

const checkoutUrl = `https://www.patapata.us/cart/${variantId}:${quantity}`;

  session.stage = "PRINT_PAYMENT_CHOICE";

  await sendMessage(
    from,
    `Choose payment option:

1 - Shopify Checkout
2 - Africa Payment

Shopify:
${checkoutUrl}

Africa Payment:
https://www.patapata.us/pages/africa-payment`
  );

  return res.sendStatus(200);
}
// =======================
// PAYMENT CHOICE HANDLER
// =======================
if (session.stage === "PRINT_PAYMENT_CHOICE") {
  const selectedColor =
  session.printSpec?.color || session.printSpec?.color_mode || "bw";

const isColor = selectedColor === "color";

const bwVariant = process.env.SHOPIFY_VARIANT_PRINT_A4_BW || "52221221273899";
const colorVariant = process.env.SHOPIFY_VARIANT_PRINT_A4_COLOR || "52221221437739";

const variantId = isColor ? colorVariant : bwVariant;
const quantity = session.printSpec?.copies || 1;

const checkoutUrl = `https://www.patapata.us/cart/${variantId}:${quantity}`;
const africaUrl = "https://www.patapata.us/pages/africa-payment";

  if (lower === "1") {
    await sendMessage(from, `🛒 Shopify Checkout:\n${checkoutUrl}`);
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


// 🔻 EXISTING FALLBACK (leave this)
await sendMessage(from, "Reply with 1 or 2.");
return res.sendStatus(200);
  await sendMessage(from, "Reply with 1 or 2.");
  return res.sendStatus(200);
}
    await sendMessage(from, serviceMenu());
    return res.sendStatus(200);

  } catch (err) {
    console.error(err);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
