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

  if (session.stage === "PRINT_WAITING_FILE") {
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
        session.stage = "LAMINATE_SELECT_SIZE":
        await sendMessage(from, laminateSizeMenuText());
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
      resetSession(from);
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
