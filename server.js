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
const UPLOAD_DIR = path.resolve("uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use("/uploads", express.static(UPLOAD_DIR));

// ===== MULTER SETUP =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = (file.originalname || "file")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(-80);
    cb(null, `${Date.now()}_${safe}`);
  }
});

const upload = multer({ storage });

// ===== WHATSAPP CONFIG =====
const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ===== SIMPLE SESSION STORE =====
const sessions = new Map();

// ===== HELPERS =====
function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, {});
  }
  return sessions.get(from);
}

function resetSession(from) {
  sessions.delete(from);
}
function detectIntent(text = "") {
  text = text.toLowerCase();

  if (text.includes("laminate")) return "LAMINATE";
  if (text.includes("print")) return "PRINT";
  if (text.includes("id")) return "ID";
  if (text.includes("edit")) return "EDIT";

  if (text.includes("mechanic")) return "MECHANIC";
  if (text.includes("ride")) return "RIDE";
  if (text.includes("apartment") || text.includes("rent")) return "APARTMENT";

  return null;
}

function getReferral(type) {
  if (type === "MECHANIC") {
    return process.env.AUTO_MECHANIC_CONTACTS || "+1 000-000-0000";
  }
  if (type === "RIDE") {
    return process.env.RIDE_TO_WORK_CONTACTS || "+1 000-000-0000";
  }
  if (type === "APARTMENT") {
    return process.env.APARTMENT_CONTACTS || "+1 000-000-0000";
  }
}
async function sendMessage(to, text) {
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

app.get("/webhook", (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === verify_token) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
})
// ===== WHATSAPP MESSAGE HANDLER =====
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;

    let text = "";
    if (type === "text") {
      text = message.text.body;
    }

    const lower = (text || "").toLowerCase().trim();

    // ===== HELLO MENU =====
    if (["hi", "hello", "start", "menu"].includes(lower)) {
      await sendMessage(
        from,
        `Hello 👋 Welcome to PATAPATA Print-O-Matic

What would you like to do?

1 - Print
2 - Laminate
3 - Image Editing
4 - Video Editing
5 - ID Photo

Or type:
🚗 ride to work
🔧 find mechanic
🏠 rent apartment`
      );
      return res.sendStatus(200);
    }

    // ===== RIDE / MECHANIC / APARTMENT =====
    if (lower.includes("ride")) {
      await sendMessage(from, `🚗 Ride Service:\n+1 862 230 6637`);
      return res.sendStatus(200);
    }

    if (lower.includes("mechanic")) {
      await sendMessage(from, `🔧 Auto Mechanic:\n+1 862 230 6637`);
      return res.sendStatus(200);
    }

    if (lower.includes("apartment") || lower.includes("rent")) {
      await sendMessage(from, `🏠 Apartment Rentals:\n+1 862 230 6637`);
      return res.sendStatus(200);
    }

    // ===== FILE RECEIVED =====
    if (["image", "document", "video", "audio"].includes(type)) {
      await sendMessage(
        from,
        `✅ File received successfully!

What would you like to do with your file?

1 - Print
2 - Laminate
3 - Image Editing
4 - Video Editing
5 - ID Photo`
      );
      return res.sendStatus(200);
    }

    // ===== MENU SELECTION =====
    if (lower === "1") {
      await sendMessage(
        from,
        "🖨 Printing selected.\n\nReply YES to proceed to checkout."
      );
      return res.sendStatus(200);
    }

    if (lower === "2") {
      await sendMessage(
        from,
        "📄 Laminating selected.\nLetter $1.50\nLegal $2.00\nTabloid $3.00\n\nReply YES to continue."
      );
      return res.sendStatus(200);
    }

    if (lower === "3") {
      await sendMessage(
        from,
        "🎨 Image Editing selected.\n\nSend your instructions (e.g., background removal, enhancement)."
      );
      return res.sendStatus(200);
    }

    if (lower === "4") {
      await sendMessage(
        from,
        "🎥 Video Editing selected.\n\nSend your instructions."
      );
      return res.sendStatus(200);
    }

    if (lower === "5") {
      await sendMessage(
        from,
        "🪪 ID Photo selected.\n\nSend your photo and instructions."
      );
      return res.sendStatus(200);
    }

    // ===== YES → CHECKOUT =====
    if (lower === "yes") {
      await sendMessage(
        from,
     2   "🛒 Checkout:\nhttps://www.patapata.us/cart/52221221437739:1\n\nIf you have not uploaded your file yet, please send it now."
      );
      return res.sendStatus(200);
    }

    // ===== DEFAULT RESPONSE =====
    await sendMessage(
      from,
      "Hello 👋 Send *hello* to start or upload your file."
    );

    return res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.sendStatus(500);
  }
});
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
