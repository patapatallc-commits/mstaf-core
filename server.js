require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.use(express.json());

/* ===========================
   CONFIG
=========================== */

const PORT = process.env.PORT || 10000;
const PRINTER_KEY = process.env.PRINTER_KEY || "";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ===========================
   CORS (for Shopify)
=========================== */

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ===========================
   FILE STORAGE
=========================== */

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const unique = Date.now() + "_" + file.originalname;
    cb(null, unique);
  },
});

const upload = multer({ storage });

/* ===========================
   DB MIGRATION
=========================== */

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY
    )
  `);

  const cols = [
    "id_text TEXT",
    "printer_id TEXT",
    "status TEXT",
    "file_name TEXT",
    "file_url TEXT",
    "mime_type TEXT",
    "pages INTEGER DEFAULT 1",
    "copies INTEGER DEFAULT 1",
    "color BOOLEAN DEFAULT false",
    "service_type TEXT",
    "instructions TEXT",
    "created_at TIMESTAMP DEFAULT NOW()",
    "is_paid BOOLEAN DEFAULT true"
  ];

  for (const col of cols) {
    const colName = col.split(" ")[0];
    await pool.query(`
      ALTER TABLE print_jobs
      ADD COLUMN IF NOT EXISTS ${col};
    `);
  }
}

/* ===========================
   HEALTH
=========================== */

app.get("/health", async (_, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "ok" });
  } catch {
    res.json({ ok: false, db: "error" });
  }
});

/* ===========================
   UPLOAD ROUTE
=========================== */

app.post("/api/upload", upload.any(), async (req, res) => {
  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const file = req.files[0];
    const jobId = "print_" + crypto.randomBytes(8).toString("hex");

    const printerId = req.body.printerId || "PP-USA-001";
    const pages = parseInt(req.body.pages || "1", 10);
    const copies = parseInt(req.body.copies || "1", 10);
    const color = req.body.colorMode === "color";
    const serviceType = req.body.serviceType || "print";
    const instructions = req.body.instructions || null;

    const fileUrl =
      `${req.protocol}://${req.get("host")}/uploads/${file.filename}`;

    await pool.query(
      `
      INSERT INTO print_jobs
      (id_text, printer_id, status, file_name, file_url, mime_type,
       pages, copies, color, service_type, instructions, is_paid)
      VALUES
      ($1,$2,'paid',$3,$4,$5,$6,$7,$8,$9,$10,true)
      `,
      [
        jobId,
        printerId,
        file.originalname,
        fileUrl,
        file.mimetype,
        pages,
        copies,
        color,
        serviceType,
        instructions,
      ]
    );

    res.json({ ok: true, id_text: jobId });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

/* ===========================
   JOB POLLING (SECURE)
=========================== */

app.get("/jobs", async (req, res) => {
  try {
    const key =
      req.headers["x-printer-key"] ||
      req.query.key;

    if (!PRINTER_KEY || key !== PRINTER_KEY) {
      return res.status(401).json({ ok: false, error: "Invalid printer key" });
    }

    const printerId = req.query.printerId;
    const limit = parseInt(req.query.limit || "5", 10);

    const { rows } = await pool.query(
      `
      SELECT *
      FROM print_jobs
      WHERE printer_id = $1
      AND status = 'paid'
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [printerId, limit]
    );

    res.json(rows);
  } catch (err) {
    console.error("JOBS ERROR:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch jobs" });
  }
});

/* ===========================
   JOB STATUS UPDATE
=========================== */

app.post("/jobs/:id/status", async (req, res) => {
  try {
    const key =
      req.headers["x-printer-key"] ||
      req.query.key;

    if (!PRINTER_KEY || key !== PRINTER_KEY) {
      return res.status(401).json({ ok: false, error: "Invalid printer key" });
    }

    const { id } = req.params;
    const { status } = req.body;

    await pool.query(
      `UPDATE print_jobs SET status=$1 WHERE id_text=$2`,
      [status, id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("STATUS UPDATE ERROR:", err);
    res.status(500).json({ ok: false });
  }
});

/* ===========================
   STATIC FILES
=========================== */

app.use("/uploads", express.static(uploadDir));

/* ===========================
   START SERVER
=========================== */

ensureTables().then(() => {
  app.listen(PORT, () => {
    console.log("MSTAF Core running on port", PORT);
  });
});

