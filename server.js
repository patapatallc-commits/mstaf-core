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
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;

    const session = getSession(from);

    let text = "";

    if (type === "text") {
      text = message.text.body;
    }

    // ===== AUTO DETECT =====
    const intent = detectIntent(text);

    if (intent === "MECHANIC" || intent === "RIDE" || intent === "APARTMENT") {
      const contact = getReferral(intent);
      await sendMessage(
        from,
        `📞 Contact: ${contact}\nCall directly for assistance.`
      );
      return res.sendStatus(200);
    }

    // ===== FILE HANDLING =====
    if (
      type === "document" ||
      type === "image" ||
      type === "video" ||
      type === "audio"
    ) {
      const mediaId =
        message[type]?.id || message.document?.id;

      const media = await axios.get(
        `https://graph.facebook.com/v18.0/${mediaId}`,
        {
          headers: { Authorization: `Bearer ${TOKEN}` }
        }
      );

      const url = media.data.url;

      const fileRes = await axios.get(url, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        responseType: "arraybuffer"
      });

      const ext =
        type === "audio"
          ? ".ogg"
          : type === "video"
          ? ".mp4"
          : type === "image"
          ? ".jpg"
          : ".pdf";

      const filename = `${Date.now()}${ext}`;
      const filepath = path.join(UPLOAD_DIR, filename);

      fs.writeFileSync(filepath, fileRes.data);

      const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${filename}`;

      session.file = fileUrl;

      await sendMessage(
        from,
        `✅ File received!\n\nWhat would you like to do?\n1 - Print\n2 - Laminate\n3 - Edit\n4 - ID`
      );

      return res.sendStatus(200);
    }

    // ===== CONTINUE FLOW =====
    if (text === "1") {
      await sendMessage(from, "🖨 Printing selected.");
      return res.sendStatus(200);
    }

    if (text === "2") {
      await sendMessage(
        from,
        "📄 Laminating:\nLetter $1.50\nLegal $2.00\nTabloid $3.00\n\nProceed to checkout?"
      );
      return res.sendStatus(200);
    }

    if (text === "yes") {
      await sendMessage(
        from,
        "💳 Checkout:\nhttps://www.patapata.us/cart/52221221437739:1"
      );
      return res.sendStatus(200);
    }

    // ===== DEFAULT =====
    await sendMessage(
      from,
      `Hello 👋 Welcome to PATAPATA Print-O-Matic

Send your PDF, image, video, or audio.

We support:
🖨 Printing
📄 Laminating
🎨 Editing
🎥 Video Editing
🚗 Ride to work
🔧 Auto mechanic
🏠 Apartment rental`
    );

    res.sendStatus(200);
  } catch (err) {
    console.error(err.message);
    res.sendStatus(500);
  }
});
app.get("/webhook", (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === verify_token) {
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
