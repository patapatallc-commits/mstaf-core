const express = require("express");
const axios = require("axios");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

const uploadsDir = path.resolve("uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(express.json({ limit: "20mb" }));
app.use(cors());
app.use("/uploads", express.static(uploadsDir));const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, Date.now() + "-" + safeName);
  },
});

const upload = multer({ storage });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

initDb().catch((err) => {
  console.error("Database init error:", err);
});app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "MSTAF backend is running",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
  });
});app.post("/contacts", async (req, res) => {
  try {
    const { name, phone, email, notes } = req.body;

    const result = await pool.query(
      `
      INSERT INTO contacts (name, phone, email, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [name, phone, email, notes]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to create contact",
    });
  }
});

app.get("/contacts", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM contacts
      ORDER BY created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to fetch contacts",
    });
  }
});app.get("/contacts/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM messages
      WHERE contact_id = $1
      ORDER BY created_at ASC
      `,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to fetch messages",
    });
  }
});app.post("/contacts/:id/messages", async (req, res) => {
  try {
    const { id } = req.params;
    const { direction, body } = req.body;

    const result = await pool.query(
      `
      INSERT INTO messages (contact_id, direction, body)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [id, direction || "outbound", body]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to create message",
    });
  }
});app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded",
      });
    }

    res.json({
      ok: true,
      filename: req.file.filename,
      url: `/uploads/${req.file.filename}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Upload failed",
    });
  }
});app.post("/send-sms", async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        error: "Missing to or message",
      });
    }

    res.json({
      ok: true,
      provider: "placeholder",
      to,
      message,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to send SMS",
    });
  }
app.post("/whatsapp-webhook", async (req, res) => {
  try {
    console.log("WhatsApp webhook received:", req.body);

    res.json({
      ok: true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Webhook failed",
    });
  }
});app.post("/ai-reply", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        error: "Missing message",
      });
    }

    res.json({
      ok: true,
      reply: "AI reply placeholder",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "AI reply failed",
    });
  }
app.post("/ai-reply", async (req, res) => {  console.log(`Server running on port ${PORT}`);
});
}