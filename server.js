/**
 * MSTAF CORE - Cloudinary Stable Version
 * - Health route
 * - Shopify upload endpoint
 * - Cloudinary permanent storage
 * - CORS locked to patapata.us
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const crypto = require("crypto");

const app = express();

app.use(express.json());

/* -----------------------------
   CORS
------------------------------ */

const allowedOrigins = [
  "https://patapata.us",
  "https://www.patapata.us",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

/* -----------------------------
   Health Check
------------------------------ */

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* -----------------------------
   Cloudinary Config
------------------------------ */

// If CLOUDINARY_URL exists, SDK auto-reads it
if (!process.env.CLOUDINARY_URL) {
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    console.error("Cloudinary environment missing.");
  } else {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }
}

/* -----------------------------
   Multer (Memory Storage)
------------------------------ */

const upload = multer({
  storage: multer.memoryStorage(),
});

/* -----------------------------
   Upload Route
------------------------------ */

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    // Check Cloudinary env
    const hasCloudinaryUrl = !!process.env.CLOUDINARY_URL;
    const hasCloudinaryParts =
      !!process.env.CLOUDINARY_CLOUD_NAME &&
      !!process.env.CLOUDINARY_API_KEY &&
      !!process.env.CLOUDINARY_API_SECRET;

    if (!hasCloudinaryUrl && !hasCloudinaryParts) {
      return res.status(500).json({
        error: "cloudinary_env_missing",
        detail:
          "Missing CLOUDINARY_URL OR CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET in Render.",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const uniqueName = `print_${crypto.randomBytes(8).toString("hex")}`;

    const result = await cloudinary.uploader.upload_stream(
      {
        folder: "printomatic",
        public_id: uniqueName,
        resource_type: "auto",
        overwrite: false,
      },
      (error, result) => {
        if (error) {
          console.error("Cloudinary error:", error);
          return res.status(500).json({
            error: "upload_failed",
            detail: error.message,
          });
        }

        return res.json({
          success: true,
          file_url: result.secure_url,
          public_id: result.public_id,
        });
      }
    );

    // Pipe buffer into Cloudinary
    result.end(req.file.buffer);
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({
      error: "upload_failed",
      detail: err.message,
    });
  }
});

/* -----------------------------
   Start Server
------------------------------ */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`MSTAF CORE running on port ${PORT}`);
});
