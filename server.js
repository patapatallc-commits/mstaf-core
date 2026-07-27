function getExtFromMime(mimeType = "") {
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
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
  const fullPath = path.join("/opt/render/project/src/uploads", finalName);

  const fileResp = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  fs.writeFileSync(fullPath, Buffer.from(fileResp.data));
  return buildUploadUrl(req, finalName);
}

  
// Canonical public origin for every customer-facing Printo link.
// Do not allow an old Render environment value or request hostname to leak
// mstaf-core-1.onrender.com into WhatsApp shares, previews, media, or result pages.
const PRINTO_BRANDED_PUBLIC_ORIGIN = "https://studio.patapata.us";

function getConfiguredPublicOrigin(_req) {
  return PRINTO_BRANDED_PUBLIC_ORIGIN;
}

   function buildUploadUrl(req, finalName) {
  return `${getConfiguredPublicOrigin(req)}/uploads/${encodeURIComponent(finalName)}`;
}

const multer = require("multer");
// const path already exists above
const fs = require("fs");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  // Keep the Basic database from being flooded by dashboard/media requests.
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  allowExitOnIdle: false
});

// Prevent an idle PostgreSQL connection error from crashing the entire Node process.
// node-postgres removes the failed client from the pool automatically; logging the
// error here allows Render to keep serving requests instead of returning a 502.
pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", {
    message: err?.message || String(err),
    code: err?.code || "",
    severity: err?.severity || "",
    detail: err?.detail || ""
  });
});

const TRANSIENT_PG_CODES = new Set([
  "57P03", // cannot_connect_now
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "53300", // too_many_connections
  "55000"
]);

function isTransientPostgresError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return (
    TRANSIENT_PG_CODES.has(code) ||
    message.includes("connection terminated unexpectedly") ||
    message.includes("connection ended unexpectedly") ||
    message.includes("the database system is starting up") ||
    message.includes("cannot connect now") ||
    message.includes("timeout expired")
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryWithRetry(text, values = [], options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 5));
  const baseDelayMs = Math.max(100, Number(options.baseDelayMs || 500));
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await pool.query(text, values);
    } catch (error) {
      lastError = error;
      if (!isTransientPostgresError(error) || attempt >= attempts) {
        throw error;
      }

      const delayMs = Math.min(5000, baseDelayMs * (2 ** (attempt - 1)));
      console.warn(
        `Transient PostgreSQL error; retrying query (${attempt}/${attempts}) in ${delayMs}ms:`,
        error?.code || "",
        error?.message || error
      );
      await wait(delayMs);
    }
  }

  throw lastError;
}
// Ensure uploads folder exists
const path = require("path");

// Multer storage

const uploadsDir = path.resolve("uploads");
const generatedDir = path.resolve("generated");
const templatesDir = path.resolve("templates");
const masterVideosDir = path.resolve("master-videos");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(generatedDir)) {
  fs.mkdirSync(generatedDir, { recursive: true });
}
if (!fs.existsSync(templatesDir)) {
  fs.mkdirSync(templatesDir, { recursive: true });
}
if (!fs.existsSync(masterVideosDir)) {
  fs.mkdirSync(masterVideosDir, { recursive: true });
}

const storage = multer.diskStorage({
 destination: (req, file, cb) => {
  cb(null, uploadsDir);
},
  filename: (req, file, cb) => {
    const safeName = Date.now() + "_" + String(file.originalname || "upload").replace(/[^a-zA-Z0-9._-]+/g, "_");
    cb(null, safeName);
  }
});

const upload = multer({ storage });

// Premium tribute uploads use Render's local disk only as a temporary work area.
// The original introduction video is compressed to a short 720p MP4, then the
// compressed bytes are stored permanently in PostgreSQL. Temporary files are deleted.
const PREMIUM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PREMIUM_VIDEO_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const PREMIUM_VIDEO_STORED_MAX_BYTES = 40 * 1024 * 1024;
const PREMIUM_VIDEO_MAX_SECONDS = 60;
const PREMIUM_MUSIC_MAX_BYTES = 30 * 1024 * 1024;
const PREMIUM_FINAL_VIDEO_MAX_BYTES = 70 * 1024 * 1024;

// Printo Studio uses one universal credit wallet for every creation service.
// Each verified phone number receives 100 welcome credits only once.
const PRINTO_FREE_CREDITS = 100;
const PRINTO_MONTHLY_CREDIT_ALLOCATION = 100;
const PRINTO_CREATION_CREDIT_COSTS = Object.freeze({
  standard: 20,
  premium_video: 25,
  premium_multi_image: 50
});
const PRINTO_CREATION_CREDIT_COST = PRINTO_CREATION_CREDIT_COSTS.standard;

// The $4.99 Shopify Standard product always purchases exactly one Standard
// creation. Never trust a customer-editable URL value for the credit amount.
const PRINTO_STANDARD_SINGLE_PURCHASE_CREDITS =
  PRINTO_CREATION_CREDIT_COSTS.standard;

function normalizePrintoCreationType(value = "standard") {
  const normalized = String(value || "standard")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (["premium", "premium_video", "premium_tribute"].includes(normalized)) {
    return "premium_video";
  }
  if (["multi_image", "premium_multi_image", "premium_multiimage"].includes(normalized)) {
    return "premium_multi_image";
  }
  return "standard";
}

function getPrintoCreationCreditCost(value = "standard") {
  return PRINTO_CREATION_CREDIT_COSTS[normalizePrintoCreationType(value)];
}

// Render's smaller instances may need more than five minutes to encode a
// full-length Premium tribute video. Allow each long FFmpeg stage up to 20 minutes.
const PREMIUM_RENDER_STAGE_TIMEOUT_MS = 20 * 60 * 1000;

const premiumTempDir = path.join(uploadsDir, "premium-temp");
if (!fs.existsSync(premiumTempDir)) {
  fs.mkdirSync(premiumTempDir, { recursive: true });
}

const premiumTempStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, premiumTempDir),
  filename: (_req, file, cb) => {
    const safe = safeBaseName(file.originalname || "premium-upload").slice(-120);
    cb(null, `${Date.now()}_${crypto.randomBytes(6).toString("hex")}_${safe}`);
  }
});

const premiumUpload = multer({
  storage: premiumTempStorage,
  limits: {
    fileSize: PREMIUM_VIDEO_UPLOAD_MAX_BYTES,
    files: 2,
    fields: 20
  },
  fileFilter: (_req, file, cb) => {
    const fieldName = String(file.fieldname || "");
    const mime = String(file.mimetype || "").toLowerCase();

    if (fieldName === "recipientPhoto" && !mime.startsWith("image/")) {
      return cb(new Error("The recipient photo must be an image file."));
    }

    if (fieldName === "introVideo" && !mime.startsWith("video/")) {
      return cb(new Error("The personal introduction must be a video file."));
    }

    if (!["recipientPhoto", "introVideo"].includes(fieldName)) {
      return cb(new Error("Unexpected Premium upload field."));
    }

    return cb(null, true);
  }
});

const premiumMusicUpload = multer({
  storage: premiumTempStorage,
  limits: { fileSize: PREMIUM_MUSIC_MAX_BYTES, files: 1, fields: 5 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "").toLowerCase();
    const ext = path.extname(String(file.originalname || "")).toLowerCase();
    const allowedExtensions = new Set([
      ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"
    ]);
    const mimeLooksAudio =
      mime.startsWith("audio/") ||
      mime === "application/octet-stream" ||
      mime === "application/x-mpegurl";

    if (!mimeLooksAudio && !allowedExtensions.has(ext)) {
      return cb(new Error(
        "The tribute music must be an MP3, WAV, M4A, AAC, OGG, OPUS, or FLAC audio file."
      ));
    }
    return cb(null, true);
  }
});
const express = require("express");
const axios = require("axios");
const { execFile } = require("child_process");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

// After studio.patapata.us is connected and verified in Render, set
// HIDE_RENDER_HOST=true. Browser page visits to the Render hostname will then
// move to the branded domain, while APIs, webhooks and media routes keep working.
app.use((req, res, next) => {
  const hideRenderHost = String(process.env.HIDE_RENDER_HOST || "").toLowerCase() === "true";
  const host = String(req.get("host") || "").toLowerCase();
  const isRenderHost = host.endsWith(".onrender.com");
  const isBrowserPage = req.method === "GET" && ![
    "/api/", "/webhook", "/webhooks/", "/uploads/", "/generated/",
    "/premium-media/", "/health", "/api/health"
  ].some((prefix) => req.path === prefix || req.path.startsWith(prefix));

  if (hideRenderHost && isRenderHost && isBrowserPage) {
    return res.redirect(302, `${getConfiguredPublicOrigin(req)}${req.originalUrl}`);
  }
  return next();
});


// /uploads is served by the safe route below; do not use express.static here.
app.use("/generated", express.static(generatedDir));

app.get("/greeting-assets/birthday-v2.png", (req, res) => {
  const assetPath = path.join(
    __dirname,
    "templates",
    "birthday",
    "Birthday_Image_V2.png"
  );

  if (!fs.existsSync(assetPath)) {
    return res.status(404).send("Birthday preview image not found.");
  }

  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.sendFile(assetPath);
});

app.use(express.static("public"));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use(express.json({
  limit: "20mb",
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));
// Accept normal HTML form submissions as a reliable fallback when browser JavaScript is blocked or cached.
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
const cors = require("cors");

app.use(cors({
  origin: [
    "https://patapata.us",
    "https://www.patapata.us",
    "https://studio.patapata.us",
    "https://patapata.myshopify.com"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-worker-key", "x-dashboard-key", "x-printo-customer-id", "x-printo-customer-key"],
  credentials: false
}));

app.options("*", cors());


// /uploads is served by the safe route below; do not use express.static here.

app.get("/uploads/:file", (req, res) => {
  const safeFileName = path.basename(String(req.params.file || ""));
  const filePath = path.join(uploadsDir, safeFileName);

  if (!safeFileName || !fs.existsSync(filePath)) {
    return res.status(404).send("Uploaded file is no longer available.");
  }

  return res.sendFile(filePath);
});
const PORT = process.env.PORT || 10000;
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || process.env.PATAPATA_PHONE || "18622306637";
// Always use the real branded Studio address in customer-facing links.
// This prevents old Render or Shopify environment values from sending users
// to mstaf-core-1.onrender.com or the Shopify storefront.
const PRINTO_BRANDED_STUDIO_BASE_URL = `${PRINTO_BRANDED_PUBLIC_ORIGIN}/greetings`;
const PRINTO_STUDIO_URL = PRINTO_BRANDED_STUDIO_BASE_URL;

function buildBrandedPrintoStudioUrl(language = "en") {
  const safeLanguage = ["en", "es", "fr", "de", "pt", "ar", "zh"].includes(
    String(language || "en").toLowerCase()
  )
    ? String(language || "en").toLowerCase()
    : "en";

  return `${PRINTO_BRANDED_STUDIO_BASE_URL}?lang=${encodeURIComponent(safeLanguage)}`;
}

// The final "create your own" link in a WhatsApp share opens the PATAPATA
// Shopify storefront, where Printo Studio is now available in the main menu.
// Greeting watch/share links continue to use the finished branded /g/ page.
const PRINTO_SHOPIFY_STOREFRONT_URL =
  process.env.PRINTO_SHOPIFY_STOREFRONT_URL ||
  "https://www.patapata.us";

function buildPrintoShopifyMenuUrl(language = "en") {
  const safeLanguage = ["en", "es", "fr", "de", "pt", "ar", "zh"].includes(
    String(language || "en").toLowerCase()
  )
    ? String(language || "en").toLowerCase()
    : "en";

  const storefrontBase = String(PRINTO_SHOPIFY_STOREFRONT_URL)
    .trim()
    .replace(/\/+$/, "");

  return `${storefrontBase}/?lang=${encodeURIComponent(safeLanguage)}`;
}
const GREETING_AFRICA_PAYMENT_URL =
  process.env.GREETING_AFRICA_PAYMENT_URL ||
  "https://www.patapata.us/pages/africa-payment";
const GREETING_SHOPIFY_PAYMENT_URL =
  process.env.GREETING_SHOPIFY_URL ||
  "https://www.patapata.us/products/printo-standard-personalized-video-greeting";

const PRINTO_SINGLE_CREATION_URL = process.env.PRIINTO_SINGLE_CREATION_URL || process.env.PRINTO_SINGLE_CREATION_URL || GREETING_SHOPIFY_PAYMENT_URL;
const PRINTO_STANDARD_MONTHLY_SUBSCRIPTION_URL = process.env.PRINTO_STANDARD_MONTHLY_SUBSCRIPTION_URL || "https://www.patapata.us/collections/printo-subscriptions";
const PRINTO_STANDARD_SIX_MONTH_SUBSCRIPTION_URL = process.env.PRINTO_STANDARD_SIX_MONTH_SUBSCRIPTION_URL || "https://www.patapata.us/collections/printo-subscriptions";
const PRINTO_STANDARD_YEARLY_SUBSCRIPTION_URL = process.env.PRINTO_STANDARD_YEARLY_SUBSCRIPTION_URL || "https://www.patapata.us/collections/printo-subscriptions";
const PRINTO_MONTHLY_SUBSCRIPTION_URL = process.env.PRINTO_MONTHLY_SUBSCRIPTION_URL || "https://www.patapata.us/collections/printo-subscriptions";
const PRINTO_SIX_MONTH_SUBSCRIPTION_URL = process.env.PRINTO_SIX_MONTH_SUBSCRIPTION_URL || "https://www.patapata.us/collections/printo-subscriptions";
const PRINTO_YEARLY_SUBSCRIPTION_URL = process.env.PRINTO_YEARLY_SUBSCRIPTION_URL || "https://www.patapata.us/collections/printo-subscriptions";
const PRINTO_STANDARD_SUBSCRIPTION_PRICES = { monthly: 9.99, six_months: 49.99, yearly: 89.99 };
const PRINTO_SUBSCRIPTION_PRICES = { monthly: 9.99, six_months: 49.99, yearly: 89.99 };

function getPrintoStudioMenuFooter(language = "en") {
  const labels = {
    en: "↩️ Back to Printo Studio",
    es: "↩️ Volver a Printo Studio",
    fr: "↩️ Retour à Printo Studio",
    de: "↩️ Zurück zu Printo Studio",
    pt: "↩️ Voltar ao Printo Studio",
    ar: "↩️ العودة إلى استوديو برينتو",
    zh: "↩️ 返回 Printo Studio"
  };

  return `${labels[language] || labels.en}:\n${buildBrandedPrintoStudioUrl(language)}`;
}

function isNumberedWhatsAppMenu(text = "") {
  const matches = String(text || "").match(
    /(?:^|\n)\s*(?:0|[1-9]\d*)\s*(?:[-.)]|\.)\s+/g
  );

  return Array.isArray(matches) && matches.length >= 2;
}

function appendPrintoStudioLinkToMenu(text = "", language = "en") {
  const body = String(text || "").trim();
  const footerMarkers = [
    "Back to Printo Studio",
    "Volver a Printo Studio",
    "Retour à Printo Studio",
    "Zurück zu Printo Studio",
    "Voltar ao Printo Studio",
    "العودة إلى استوديو برينتو",
    "返回 Printo Studio"
  ];

  if (
    !body ||
    !isNumberedWhatsAppMenu(body) ||
    footerMarkers.some((marker) => body.includes(marker))
  ) {
    return body;
  }

  return `${body}\n\n${getPrintoStudioMenuFooter(language)}`;
}

// =========================
// WHATSAPP SEND MESSAGE
// =========================
async function sendMessage(to, text) {
  try {
    const language = sessions.get(String(to))?.language || "en";
    const finalText = appendPrintoStudioLinkToMenu(text, language);

    await axios.post(
      `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        text: { body: finalText }
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
     language: "en",
    selectedService: null,
    printSpec: {},
    laminateSpec: {},
    pendingFile: null,
    lastServiceJobId: null,
    greetingSpec: {}
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
function serviceMenu(language = "en") {
  const menus = {
    en: `📌 Choose a service number.

Example: 1, 4, 15

1 - Print
2 - Laminate
3 - ID Photo
4 - Image Editing
5 - Video Editing
6 - Lesson / Homework
7 - Talk to Agent
8 - Find Auto Mechanic
9 - Need Ride to Work
10 - Shared Apartment / Rent
11 - Need Indoor or Outdoor Helper
12 - Custom T-Shirt Print
13 - Job Search / Submit CV
14 - Job Opportunities
15 - Hire a Worker
16 - Community Alert
17 - Trusted Suppliers
18 - Buy Land for Use or Resell
19 - Currency Exchange
20 - Social Media Creator
21 - Buy & Resell Auto
22 - Car Loan / Auto Financing
23 - Car Insurance
24 - Car Rental Services
25 - Mobile App Development
26 - Hotel Reservation
27 - Home Security Technician
28 - Locksmith
29 - AI Flyer & Poster Design
30 - AI Cartoon Video Creation
31 - AI Social Media Content
32 - Resume / CV Creation
33 - Shipping / Delivery
34 - Helper Services
35 - Book App Tester
36 - Solar Installation
37 - Work Maintenance`,

    es: `📌 Elige un número de servicio.

Ejemplo: 1, 4, 15

1 - Imprimir
2 - Laminar
3 - Foto de identificación
4 - Edición de imagen
5 - Edición de video
6 - Lección / Tarea
7 - Hablar con un agente
8 - Buscar mecánico
9 - Transporte al trabajo
10 - Apartamento compartido / Renta
11 - Ayudante interior o exterior
12 - Camiseta personalizada
13 - Buscar trabajo / Enviar CV
14 - Oportunidades de trabajo
15 - Contratar trabajador
16 - Alerta comunitaria
17 - Proveedores confiables
18 - Comprar terreno
19 - Cambio de moneda
20 - Creador de redes sociales
21 - Comprar y revender autos
22 - Préstamo de auto / Financiamiento
23 - Seguro de auto
24 - Servicios de alquiler de autos
25 - Desarrollo de aplicaciones móviles
26 - Reserva de hotel
27 - Técnico de seguridad para el hogar
28 - Cerrajero
29 - Diseño de flyer / póster con IA
30 - Creación de video cartoon con IA
31 - Contenido para redes sociales con IA
32 - Creación de CV / Resume
33 - Envío / Entrega
34 - Servicios de ayudante
35 - Reservar probador de app
36 - Instalación solar
37 - Mantenimiento de trabajo`,

    fr: `📌 Choisissez un numéro de service.

Exemple : 1, 4, 15

1 - Imprimer
2 - Plastifier
3 - Photo d'identité
4 - Retouche d'image
5 - Montage vidéo
6 - Leçon / Devoirs
7 - Parler à un agent
8 - Trouver un mécanicien
9 - Trajet au travail
10 - Appartement partagé / Location
11 - Aide intérieure ou extérieure
12 - T-shirt personnalisé
13 - Recherche d'emploi / Envoyer CV
14 - Offres d'emploi
15 - Embaucher un travailleur
16 - Alerte communautaire
17 - Fournisseurs fiables
18 - Acheter un terrain
19 - Change de monnaie
20 - Créateur de réseaux sociaux
21 - Acheter et revendre des autos
22 - Prêt auto / Financement
23 - Assurance auto
24 - Services de location de voiture
25 - Développement d'application mobile
26 - Réservation d'hôtel
27 - Technicien en sécurité résidentielle
28 - Serrurier
29 - Création de flyer / affiche IA
30 - Création de vidéo cartoon IA
31 - Contenu réseaux sociaux IA
32 - Création de CV / résumé
33 - Expédition / Livraison
34 - Services d'aide
35 - Réserver un testeur d'application
36 - Installation solaire
37 - Maintenance de travail`,

    de: `📌 Wählen Sie eine Servicenummer.

Beispiel: 1, 4, 15

1 - Drucken
2 - Laminieren
3 - Passfoto
4 - Bildbearbeitung
5 - Videobearbeitung
6 - Unterricht / Hausaufgaben
7 - Mit Agent sprechen
8 - Automechaniker finden
9 - Fahrt zur Arbeit
10 - WG / Miete
11 - Innen- oder Außenhilfe
12 - T-Shirt-Druck
13 - Jobsuche / Lebenslauf senden
14 - Jobangebote
15 - Arbeiter einstellen
16 - Gemeinschaftsalarm
17 - Vertrauenswürdige Lieferanten
18 - Land kaufen
19 - Geldwechsel
20 - Social-Media-Ersteller
21 - Autos kaufen und weiterverkaufen
22 - Autokredit / Finanzierung
23 - Autoversicherung
24 - Autovermietung
25 - Mobile-App-Entwicklung
26 - Hotelreservierung
27 - Haussicherheitstechniker
28 - Schlüsseldienst
29 - KI-Flyer- und Posterdesign
30 - KI-Cartoon-Videoerstellung
31 - KI-Social-Media-Inhalte
32 - Lebenslauf-Erstellung
33 - Versand / Lieferung
34 - Helfer-Services
35 - App-Tester buchen
36 - Solarinstallation
37 - Arbeitswartung`,

    pt: `📌 Escolha um número de serviço.

Exemplo: 1, 4, 15

1 - Imprimir
2 - Laminar
3 - Foto de identificação
4 - Edição de imagem
5 - Edição de vídeo
6 - Aula / Tarefa
7 - Falar com agente
8 - Encontrar mecânico
9 - Transporte para trabalho
10 - Apartamento compartilhado / Aluguel
11 - Ajudante interno ou externo
12 - Camiseta personalizada
13 - Procurar emprego / Enviar CV
14 - Oportunidades de emprego
15 - Contratar trabalhador
16 - Alerta comunitário
17 - Fornecedores confiáveis
18 - Comprar terreno
19 - Câmbio
20 - Criador de mídia social
21 - Comprar e revender carros
22 - Empréstimo de carro / Financiamento
23 - Seguro de carro
24 - Serviços de aluguel de carros
25 - Desenvolvimento de aplicativo móvel
26 - Reserva de hotel
27 - Técnico de segurança residencial
28 - Chaveiro
29 - Design de flyer / pôster com IA
30 - Criação de vídeo cartoon com IA
31 - Conteúdo de mídia social com IA
32 - Criação de currículo / CV
33 - Envio / Entrega
34 - Serviços de ajudante
35 - Reservar testador de aplicativo
36 - Instalação solar
37 - Manutenção de trabalho`,

    ar: `📌 اختر رقم الخدمة.

مثال: 1، 4، 15

1 - طباعة
2 - تغليف حراري
3 - صورة هوية
4 - تعديل الصور
5 - تعديل الفيديو
6 - درس / واجب
7 - التحدث مع موظف
8 - البحث عن ميكانيكي
9 - مواصلة إلى العمل
10 - سكن مشترك / إيجار
11 - مساعد داخلي أو خارجي
12 - طباعة تيشيرت
13 - البحث عن عمل / إرسال السيرة الذاتية
14 - فرص عمل
15 - توظيف عامل
16 - تنبيه مجتمعي
17 - موردون موثوقون
18 - شراء أرض
19 - تحويل العملات
20 - منشئ محتوى
21 - شراء وإعادة بيع السيارات
22 - قرض سيارة / تمويل
23 - تأمين السيارات
24 - خدمات تأجير السيارات
25 - تطوير تطبيقات الجوال
26 - حجز فندق
27 - فني أمن المنازل
28 - صانع أقفال
29 - تصميم منشور / بوستر بالذكاء الاصطناعي
30 - إنشاء فيديو كرتون بالذكاء الاصطناعي
31 - محتوى وسائل التواصل بالذكاء الاصطناعي
32 - إنشاء السيرة الذاتية
33 - الشحن / التوصيل
34 - خدمات المساعدة
35 - حجز مختبر تطبيق
36 - تركيب الطاقة الشمسية
37 - صيانة الأعمال`,

    zh: `📌 请选择服务编号。

示例：1、4、15

1 - 打印
2 - 覆膜
3 - 证件照
4 - 图片编辑
5 - 视频编辑
6 - 课程 / 作业
7 - 联系客服
8 - 查找汽车修理工
9 - 上班接送
10 - 合租公寓 / 租房
11 - 室内或室外帮工
12 - 定制 T 恤打印
13 - 找工作 / 提交简历
14 - 工作机会
15 - 雇用工人
16 - 社区警报
17 - 可信供应商
18 - 购买土地自用或转售
19 - 货币兑换
20 - 社交媒体创作者
21 - 买卖 / 转售汽车
22 - 汽车贷款 / 汽车融资
23 - 汽车保险
24 - 汽车租赁服务
25 - 手机应用开发
26 - 酒店预订
27 - 家庭安防技术员
28 - 锁匠服务
29 - AI 传单 / 海报设计
30 - AI 卡通视频制作
31 - AI 社交媒体内容
32 - 简历 / CV 制作
33 - 运输 / 配送
34 - 帮工服务
35 - 预约应用测试员
36 - 太阳能安装
37 - 工作维护`
  };

  return menus[language] || menus.en;
}

// =========================
// MOBILE APP SERVICE HELPERS
// =========================
function normalizeMobileAppText(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/print-o-matic/g, "printomatic")
    .replace(/printo/g, "printo")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLanguageFromAppMessage(rawText = "") {
  const original = String(rawText || "");
  const match = original.match(/^\s*Language\s*:\s*(en|es|fr|de|pt|ar|zh)\s*\n+/i);

  if (!match) {
    return {
      language: "",
      text: original
    };
  }

  return {
    language: match[1].toLowerCase(),
    text: original.replace(match[0], "").trim()
  };
}

function detectMobileAppService(text = "") {
  const v = normalizeMobileAppText(text);

  if (!v) return null;

  if (
    v.includes("buy printo music") ||
    v.includes("printo music") ||
    v.includes("comprar música") ||
    v.includes("acheter de la musique") ||
    v.includes("printo musik kaufen") ||
    v.includes("comprar música printo") ||
    v.includes("شراء موسيقى") ||
    v.includes("购买 printo 音乐")
  ) {
    return "PRINTO_MUSIC";
  }

  if (
    v.includes("greeting video card") ||
    v.includes("video greeting") ||
    v.includes("greeting card") ||
    v.includes("tarjeta de video") ||
    v.includes("carte vidéo") ||
    v.includes("grußvideo") ||
    v.includes("cartão de vídeo") ||
    v.includes("بطاقة فيديو") ||
    v.includes("祝福视频")
  ) {
    return "GREETING_CARD";
  }

  if (
    v.includes("personalized printo video") ||
    v.includes("personalised printo video") ||
    v.includes("video personalizado") ||
    v.includes("vidéo printo personnalisée") ||
    v.includes("personalisiertes printo video") ||
    v.includes("vídeo printo personalizado") ||
    v.includes("فيديو printo") ||
    v.includes("个性化 printo 视频")
  ) {
    return "PERSONALIZED_PRINTO_VIDEO";
  }

  if (
    v.includes("ai video creation") ||
    v.includes("creación de video con ia") ||
    v.includes("création vidéo ia") ||
    v.includes("ki-videoerstellung") ||
    v.includes("criação de vídeo com ia") ||
    v.includes("إنشاء فيديو بالذكاء") ||
    v.includes("ai 视频制作")
  ) {
    return "AI_VIDEO_CREATION";
  }

  if (
    v.includes("music or voice") ||
    v.includes("music & voice") ||
    v.includes("music and voice") ||
    v.includes("música o voz") ||
    v.includes("musique ou de voix") ||
    v.includes("musik- oder sprach") ||
    v.includes("música ou voz") ||
    v.includes("موسيقى أو صوت") ||
    v.includes("音乐或语音")
  ) {
    return "MUSIC_VOICE_STUDIO";
  }

  if (
    v.includes("digital downloads") ||
    v.includes("descargas digitales") ||
    v.includes("téléchargements numériques") ||
    v.includes("digitale downloads") ||
    v.includes("downloads digitais") ||
    v.includes("تنزيلات رقمية") ||
    v.includes("数字下载")
  ) {
    return "DIGITAL_SERVICES_DOWNLOADS";
  }

  if (
    v.includes("printomatic services") ||
    v.includes("printomatic") ||
    v.includes("print-o-matic services") ||
    v.includes("servicios print-o-matic") ||
    v.includes("services print-o-matic") ||
    v.includes("serviços print-o-matic") ||
    v.includes("خدمات print-o-matic") ||
    v.includes("print-o-matic 服务")
  ) {
    return "PRINTOMATIC_SERVICES";
  }

  return null;
}

function mobileAppServicePromptText(language = "en", serviceType = "AGENT_REQUEST") {
  const prompts = {
    PRINTO_MUSIC: {
      en: `🎵 Printo Music selected.\n\nPlease tell us what you want:\n• Buy a Printo song, beat, instrumental, or album\n• License music for video/social media\n• Request a custom song or jingle\n\nYou may send text, voice note, file, photo, or link.`,
      es: `🎵 Música de Printo seleccionada.\n\nDíganos lo que necesita:\n• Comprar una canción, beat, instrumental o álbum de Printo\n• Licenciar música para video/redes sociales\n• Solicitar una canción o jingle personalizado\n\nPuede enviar texto, nota de voz, archivo, foto o enlace.`,
      fr: `🎵 Musique Printo sélectionnée.\n\nDites-nous ce dont vous avez besoin :\n• Acheter une chanson, un beat, un instrumental ou un album Printo\n• Utiliser la musique pour vidéo/réseaux sociaux\n• Demander une chanson ou un jingle personnalisé\n\nVous pouvez envoyer texte, vocal, fichier, photo ou lien.`,
      de: `🎵 Printo Musik ausgewählt.\n\nBitte sagen Sie uns, was Sie möchten:\n• Printo Song, Beat, Instrumental oder Album kaufen\n• Musik für Video/Social Media lizenzieren\n• Einen eigenen Song oder Jingle anfragen\n\nSie können Text, Sprachnachricht, Datei, Foto oder Link senden.`,
      pt: `🎵 Música Printo selecionada.\n\nDiga o que você deseja:\n• Comprar música, beat, instrumental ou álbum Printo\n• Licenciar música para vídeo/redes sociais\n• Solicitar música ou jingle personalizado\n\nVocê pode enviar texto, áudio, arquivo, foto ou link.`,
      ar: `🎵 تم اختيار موسيقى Printo.\n\nيرجى إخبارنا بما تريد:\n• شراء أغنية أو إيقاع أو موسيقى أو ألبوم Printo\n• استخدام الموسيقى للفيديو أو وسائل التواصل\n• طلب أغنية أو إعلان صوتي مخصص\n\nيمكنك إرسال نص أو صوت أو ملف أو صورة أو رابط.`,
      zh: `🎵 已选择 Printo 音乐。\n\n请告诉我们您需要什么：\n• 购买 Printo 歌曲、节拍、伴奏或专辑\n• 为视频/社交媒体授权音乐\n• 定制歌曲或广告歌\n\n您可以发送文字、语音、文件、图片或链接。`
    },
    AI_VIDEO_CREATION: {
      en: `🎬 AI Video Creation selected.\n\nPlease describe the video you want. Include style, length, character, text, voice, and where you want to post it. You may also send photos, videos, audio, or links.`,
      es: `🎬 Creación de video con IA seleccionada.\n\nDescriba el video que desea. Incluya estilo, duración, personaje, texto, voz y dónde desea publicarlo. También puede enviar fotos, videos, audio o enlaces.`,
      fr: `🎬 Création vidéo IA sélectionnée.\n\nDécrivez la vidéo souhaitée : style, durée, personnage, texte, voix et plateforme de publication. Vous pouvez aussi envoyer photos, vidéos, audio ou liens.`,
      de: `🎬 KI-Videoerstellung ausgewählt.\n\nBeschreiben Sie das gewünschte Video: Stil, Länge, Figur, Text, Stimme und Plattform. Sie können auch Fotos, Videos, Audio oder Links senden.`,
      pt: `🎬 Criação de vídeo com IA selecionada.\n\nDescreva o vídeo desejado. Inclua estilo, duração, personagem, texto, voz e onde deseja publicar. Você também pode enviar fotos, vídeos, áudio ou links.`,
      ar: `🎬 تم اختيار إنشاء فيديو بالذكاء الاصطناعي.\n\nصف الفيديو الذي تريده: الأسلوب، المدة، الشخصية، النص، الصوت، ومكان النشر. يمكنك أيضًا إرسال صور أو فيديوهات أو صوت أو روابط.`,
      zh: `🎬 已选择 AI 视频制作。\n\n请描述您想要的视频：风格、时长、角色、文字、声音以及发布平台。您也可以发送照片、视频、音频或链接。`
    },
    MUSIC_VOICE_STUDIO: {
      en: `🎤 Music & Voice Studio selected.\n\nPlease tell us what you need: song, jingle, voice-over, voice clone, sound effect, or audio cleanup. You may send lyrics, script, audio, video, or voice note.`,
      es: `🎤 Estudio de música y voz seleccionado.\n\nDíganos qué necesita: canción, jingle, voz en off, clonación de voz, efecto de sonido o limpieza de audio. Puede enviar letra, guion, audio, video o nota de voz.`,
      fr: `🎤 Studio musique et voix sélectionné.\n\nDites-nous ce dont vous avez besoin : chanson, jingle, voix off, clonage vocal, effet sonore ou nettoyage audio. Vous pouvez envoyer paroles, script, audio, vidéo ou vocal.`,
      de: `🎤 Musik- & Sprachstudio ausgewählt.\n\nBitte sagen Sie uns, was Sie brauchen: Song, Jingle, Voice-over, Stimmklon, Soundeffekt oder Audioreinigung. Sie können Text, Skript, Audio, Video oder Sprachnachricht senden.`,
      pt: `🎤 Estúdio de música e voz selecionado.\n\nDiga o que você precisa: música, jingle, narração, clonagem de voz, efeito sonoro ou limpeza de áudio. Você pode enviar letra, roteiro, áudio, vídeo ou mensagem de voz.`,
      ar: `🎤 تم اختيار استوديو الموسيقى والصوت.\n\nأخبرنا بما تحتاجه: أغنية، إعلان صوتي، تعليق صوتي، استنساخ صوت، مؤثرات صوتية أو تنظيف صوت. يمكنك إرسال كلمات أو نص أو صوت أو فيديو أو رسالة صوتية.`,
      zh: `🎤 已选择音乐与语音工作室。\n\n请告诉我们您需要什么：歌曲、广告歌、配音、声音克隆、音效或音频清理。您可以发送歌词、脚本、音频、视频或语音。`
    },
    DEFAULT: {
      en: `✅ Service selected.\n\nPlease type the details of what you need. You may also send a photo, video, document, audio, or voice note. A Printo team member will review it and reply here on WhatsApp.`,
      es: `✅ Servicio seleccionado.\n\nEscriba los detalles de lo que necesita. También puede enviar foto, video, documento, audio o nota de voz. Un miembro del equipo Printo revisará y responderá aquí en WhatsApp.`,
      fr: `✅ Service sélectionné.\n\nÉcrivez les détails de ce dont vous avez besoin. Vous pouvez aussi envoyer photo, vidéo, document, audio ou vocal. Un membre de l'équipe Printo répondra ici sur WhatsApp.`,
      de: `✅ Service ausgewählt.\n\nBitte schreiben Sie die Details. Sie können auch Foto, Video, Dokument, Audio oder Sprachnachricht senden. Ein Printo-Teammitglied antwortet hier auf WhatsApp.`,
      pt: `✅ Serviço selecionado.\n\nDigite os detalhes do que você precisa. Você também pode enviar foto, vídeo, documento, áudio ou mensagem de voz. Um membro da equipe Printo responderá aqui no WhatsApp.`,
      ar: `✅ تم اختيار الخدمة.\n\nاكتب تفاصيل ما تحتاجه. يمكنك أيضًا إرسال صورة أو فيديو أو مستند أو صوت أو رسالة صوتية. سيراجع فريق Printo طلبك ويرد هنا على واتساب.`,
      zh: `✅ 已选择服务。\n\n请写下您需要的详细信息。您也可以发送照片、视频、文件、音频或语音消息。Printo 团队成员会在 WhatsApp 上回复您。`
    }
  };

  return pickText(language, prompts[serviceType] || prompts.DEFAULT);
}

function printSizeMenuText(language = "en") {
  return pickText(language, {
    en: `Print selected.

Choose paper size:
1 - A4
2 - A3
3 - Letter
4 - Legal
5 - Tabloid
6 - Card`,
    es: `Impresión seleccionada.

Elige el tamaño de papel:
1 - A4
2 - A3
3 - Carta
4 - Legal
5 - Tabloide
6 - Tarjeta`,
    fr: `Impression sélectionnée.

Choisissez le format papier :
1 - A4
2 - A3
3 - Lettre
4 - Legal
5 - Tabloïd
6 - Carte`,
    de: `Drucken ausgewählt.

Wählen Sie die Papiergröße:
1 - A4
2 - A3
3 - Letter
4 - Legal
5 - Tabloid
6 - Karte`,
    pt: `Impressão selecionada.

Escolha o tamanho do papel:
1 - A4
2 - A3
3 - Carta
4 - Legal
5 - Tabloide
6 - Cartão`,
    ar: `تم اختيار الطباعة.

اختر حجم الورق:
1 - A4
2 - A3
3 - Letter
4 - Legal
5 - Tabloid
6 - Card`,
    zh: `已选择打印。

请选择纸张尺寸：
1 - A4
2 - A3
3 - Letter
4 - Legal
5 - Tabloid
6 - 卡片`
  });
}
function printColorMenuText(language = "en") {
  return pickText(language, {
    en: `Choose color:
1 - Black & White
2 - Color`,
    es: `Elige color:
1 - Blanco y negro
2 - Color`,
    fr: `Choisissez la couleur :
1 - Noir et blanc
2 - Couleur`,
    de: `Farbe wählen:
1 - Schwarzweiß
2 - Farbe`,
    pt: `Escolha a cor:
1 - Preto e branco
2 - Colorido`,
    ar: `اختر اللون:
1 - أبيض وأسود
2 - ملون`,
    zh: `请选择颜色：
1 - 黑白
2 - 彩色`
  });
}
function laminateSizeMenuText(language = "en") {
  return pickText(language, {
    en: `Laminate selected.

Choose laminate size:
1 - A4
2 - Letter
3 - Legal
4 - Tabloid

Africa Laminating Prices:
• A4: ₦300
• Letter: ₦300
• Legal: ₦300
• Tabloid: ₦500`,
    es: `Laminado seleccionado.

Elige el tamaño de laminado:
1 - A4
2 - Carta
3 - Legal
4 - Tabloide

Precios de laminado en África:
• A4: ₦300
• Carta: ₦300
• Legal: ₦300
• Tabloide: ₦500`,
    fr: `Plastification sélectionnée.

Choisissez le format :
1 - A4
2 - Lettre
3 - Legal
4 - Tabloïd

Prix de plastification en Afrique :
• A4 : ₦300
• Lettre : ₦300
• Legal : ₦300
• Tabloïd : ₦500`,
    de: `Laminieren ausgewählt.

Wählen Sie die Laminiergröße:
1 - A4
2 - Letter
3 - Legal
4 - Tabloid

Afrika Laminierpreise:
• A4: ₦300
• Letter: ₦300
• Legal: ₦300
• Tabloid: ₦500`,
    pt: `Laminação selecionada.

Escolha o tamanho:
1 - A4
2 - Carta
3 - Legal
4 - Tabloide

Preços de laminação na África:
• A4: ₦300
• Carta: ₦300
• Legal: ₦300
• Tabloide: ₦500`,
    ar: `تم اختيار التغليف الحراري.

اختر حجم التغليف:
1 - A4
2 - Letter
3 - Legal
4 - Tabloid

أسعار التغليف في أفريقيا:
• A4: ₦300
• Letter: ₦300
• Legal: ₦300
• Tabloid: ₦500`,
    zh: `已选择覆膜。

请选择覆膜尺寸：
1 - A4
2 - Letter
3 - Legal
4 - Tabloid

非洲覆膜价格：
• A4: ₦300
• Letter: ₦300
• Legal: ₦300
• Tabloid: ₦500`
  });
}

// =========================
// MULTILINGUAL MESSAGE HELPERS
// =========================
function pickText(language = "en", texts = {}) {
  const lang = language || "en";
  return texts[lang] || texts.en || "";
}

function welcomeText(language = "en") {
  return pickText(language, {
    en: "Hello 👋 Welcome to PATAPATA Print-O-Matic Services",
    es: "Hola 👋 Bienvenido a PATAPATA Print-O-Matic Services",
    fr: "Bonjour 👋 Bienvenue chez PATAPATA Print-O-Matic Services",
    de: "Hallo 👋 Willkommen bei PATAPATA Print-O-Matic Services",
    pt: "Olá 👋 Bem-vindo ao PATAPATA Print-O-Matic Services",
    ar: "مرحبًا 👋 أهلاً بك في PATAPATA Print-O-Matic Services",
    zh: "您好 👋 欢迎使用 PATAPATA Print-O-Matic Services"
  });
}

function selectedText(language = "en", serviceName = "") {
  return pickText(language, {
    en: `✅ Selected: ${serviceName}`,
    es: `✅ Seleccionado: ${serviceName}`,
    fr: `✅ Sélectionné : ${serviceName}`,
    de: `✅ Ausgewählt: ${serviceName}`,
    pt: `✅ Selecionado: ${serviceName}`,
    ar: `✅ تم الاختيار: ${serviceName}`,
    zh: `✅ 已选择：${serviceName}`
  });
}

function printSetupCompleteText(language = "en", spec = {}) {
  const colorText = spec.color_mode === "COLOR"
    ? pickText(language, { en: "Color", es: "Color", fr: "Couleur", de: "Farbe", pt: "Colorido", ar: "ملون", zh: "彩色" })
    : pickText(language, { en: "Black & White", es: "Blanco y negro", fr: "Noir et blanc", de: "Schwarzweiß", pt: "Preto e branco", ar: "أبيض وأسود", zh: "黑白" });

  return pickText(language, {
    en: `✅ Print setup complete.

Paper: ${spec.paper_size}
Color: ${colorText}
Copies: ${spec.copies}
Pages: ${spec.pages}

Please upload your PDF, image, or document now.`,

    es: `✅ Configuración de impresión completada.

Papel: ${spec.paper_size}
Color: ${colorText}
Copias: ${spec.copies}
Páginas: ${spec.pages}

Por favor sube tu PDF, imagen o documento ahora.`,

    fr: `✅ Configuration d'impression terminée.

Papier : ${spec.paper_size}
Couleur : ${colorText}
Copies : ${spec.copies}
Pages : ${spec.pages}

Veuillez télécharger votre PDF, image ou document maintenant.`,

    de: `✅ Druckeinrichtung abgeschlossen.

Papier: ${spec.paper_size}
Farbe: ${colorText}
Kopien: ${spec.copies}
Seiten: ${spec.pages}

Bitte laden Sie jetzt Ihre PDF-Datei, Ihr Bild oder Ihr Dokument hoch.`,

    pt: `✅ Configuração de impressão concluída.

Papel: ${spec.paper_size}
Cor: ${colorText}
Cópias: ${spec.copies}
Páginas: ${spec.pages}

Envie agora seu PDF, imagem ou documento.`,

    ar: `✅ اكتمل إعداد الطباعة.

الورق: ${spec.paper_size}
اللون: ${colorText}
النسخ: ${spec.copies}
الصفحات: ${spec.pages}

يرجى رفع ملف PDF أو صورة أو مستند الآن.`,
    zh: `✅ 打印设置已完成。

纸张：${spec.paper_size}
颜色：${colorText}
份数：${spec.copies}
页数：${spec.pages}

请现在上传您的 PDF、图片或文档。`
  });
}

function laminateSetupCompleteText(language = "en", spec = {}) {
  return pickText(language, {
    en: `✅ Laminate setup complete.

Size: ${spec.size}
Quantity: ${spec.quantity}

Please upload your file/image now.`,

    es: `✅ Configuración de laminado completada.

Tamaño: ${spec.size}
Cantidad: ${spec.quantity}

Por favor sube tu archivo/imagen ahora.`,

    fr: `✅ Configuration de plastification terminée.

Format : ${spec.size}
Quantité : ${spec.quantity}

Veuillez télécharger votre fichier/image maintenant.`,

    de: `✅ Laminiereinrichtung abgeschlossen.

Größe: ${spec.size}
Menge: ${spec.quantity}

Bitte laden Sie jetzt Ihre Datei/Ihr Bild hoch.`,

    pt: `✅ Configuração de laminação concluída.

Tamanho: ${spec.size}
Quantidade: ${spec.quantity}

Envie agora seu arquivo/imagem.`,

    ar: `✅ اكتمل إعداد التغليف الحراري.

الحجم: ${spec.size}
الكمية: ${spec.quantity}

يرجى رفع الملف/الصورة الآن.`,
    zh: `✅ 覆膜设置已完成。

尺寸：${spec.size}
数量：${spec.quantity}

请现在上传您的文件/图片。`
  });
}

function printFileReceivedText(language = "en", details = {}) {
  const colorText = details.colorMode === "COLOR"
    ? pickText(language, { en: "Color", es: "Color", fr: "Couleur", de: "Farbe", pt: "Colorido", ar: "ملون", zh: "彩色" })
    : pickText(language, { en: "Black & White", es: "Blanco y negro", fr: "Noir et blanc", de: "Schwarzweiß", pt: "Preto e branco", ar: "أبيض وأسود", zh: "黑白" });

  const checkout = details.checkoutUrl || pickText(language, {
    en: "Checkout link not available for this paper/color yet.",
    es: "El enlace de pago aún no está disponible para este papel/color.",
    fr: "Le lien de paiement n'est pas encore disponible pour ce papier/couleur.",
    de: "Der Checkout-Link ist für dieses Papier/diese Farbe noch nicht verfügbar.",
    pt: "O link de pagamento ainda não está disponível para este papel/cor.",
    ar: "رابط الدفع غير متاح بعد لهذا الورق/اللون.",
    zh: "此纸张/颜色的付款链接暂时不可用。"
  });

  return pickText(language, {
    en: `✅ File received and added to print queue.

Paper: ${details.paperSize}
Color: ${colorText}
Copies: ${details.copies}
Pages: ${details.pages}

Shopify Checkout:
${checkout}

Africa Payment:
https://www.patapata.us/pages/africa-payment

Reply:
1 - I paid with Shopify
2 - I paid with Africa Payment
3 - Continue with Agent`,

    es: `✅ Archivo recibido y agregado a la cola de impresión.

Papel: ${details.paperSize}
Color: ${colorText}
Copias: ${details.copies}
Páginas: ${details.pages}

Pago Shopify:
${checkout}

Pago África:
https://www.patapata.us/pages/africa-payment

Responde:
1 - Pagué con Shopify
2 - Pagué con Pago África
3 - Continuar con agente`,

    fr: `✅ Fichier reçu et ajouté à la file d'impression.

Papier : ${details.paperSize}
Couleur : ${colorText}
Copies : ${details.copies}
Pages : ${details.pages}

Paiement Shopify :
${checkout}

Paiement Afrique :
https://www.patapata.us/pages/africa-payment

Répondez :
1 - J'ai payé avec Shopify
2 - J'ai payé avec Paiement Afrique
3 - Continuer avec un agent`,

    de: `✅ Datei erhalten und zur Druckwarteschlange hinzugefügt.

Papier: ${details.paperSize}
Farbe: ${colorText}
Kopien: ${details.copies}
Seiten: ${details.pages}

Shopify-Zahlung:
${checkout}

Afrika-Zahlung:
https://www.patapata.us/pages/africa-payment

Antworten:
1 - Ich habe mit Shopify bezahlt
2 - Ich habe mit Afrika-Zahlung bezahlt
3 - Mit Agent fortfahren`,

    pt: `✅ Arquivo recebido e adicionado à fila de impressão.

Papel: ${details.paperSize}
Cor: ${colorText}
Cópias: ${details.copies}
Páginas: ${details.pages}

Pagamento Shopify:
${checkout}

Pagamento África:
https://www.patapata.us/pages/africa-payment

Responda:
1 - Paguei com Shopify
2 - Paguei com Pagamento África
3 - Continuar com agente`,

    ar: `✅ تم استلام الملف وإضافته إلى قائمة الطباعة.

الورق: ${details.paperSize}
اللون: ${colorText}
النسخ: ${details.copies}
الصفحات: ${details.pages}

دفع Shopify:
${checkout}

دفع أفريقيا:
https://www.patapata.us/pages/africa-payment

رد:
1 - دفعت عبر Shopify
2 - دفعت عبر دفع أفريقيا
3 - المتابعة مع موظف`,
    zh: `✅ 文件已收到，并已加入打印队列。

纸张：${details.paperSize}
颜色：${colorText}
份数：${details.copies}
页数：${details.pages}

Shopify 付款：
${checkout}

非洲付款：
https://www.patapata.us/pages/africa-payment

回复：
1 - 我已通过 Shopify 付款
2 - 我已通过非洲付款
3 - 继续联系客服`
  });
}

function laminateFileReceivedText(language = "en", details = {}) {
  const checkout = details.checkoutUrl || pickText(language, {
    en: "Checkout link not available for this laminate size yet.",
    es: "El enlace de pago aún no está disponible para este tamaño de laminado.",
    fr: "Le lien de paiement n'est pas encore disponible pour ce format de plastification.",
    de: "Der Checkout-Link ist für diese Laminiergröße noch nicht verfügbar.",
    pt: "O link de pagamento ainda não está disponível para este tamanho de laminação.",
    ar: "رابط الدفع غير متاح بعد لحجم التغليف هذا.",
    zh: "此覆膜尺寸的付款链接暂时不可用。"
  });

  return pickText(language, {
    en: `✅ Laminate file received.

Size: ${details.size}
Quantity: ${details.quantity}

Shopify Checkout:
${checkout}

Africa Payment:
https://www.patapata.us/pages/africa-payment

Reply:
1 - I paid with Shopify
2 - I paid with Africa Payment
3 - Continue with Agent`,

    es: `✅ Archivo de laminado recibido.

Tamaño: ${details.size}
Cantidad: ${details.quantity}

Pago Shopify:
${checkout}

Pago África:
https://www.patapata.us/pages/africa-payment

Responde:
1 - Pagué con Shopify
2 - Pagué con Pago África
3 - Continuar con agente`,

    fr: `✅ Fichier de plastification reçu.

Format : ${details.size}
Quantité : ${details.quantity}

Paiement Shopify :
${checkout}

Paiement Afrique :
https://www.patapata.us/pages/africa-payment

Répondez :
1 - J'ai payé avec Shopify
2 - J'ai payé avec Paiement Afrique
3 - Continuer avec un agent`,

    de: `✅ Laminierdatei erhalten.

Größe: ${details.size}
Menge: ${details.quantity}

Shopify-Zahlung:
${checkout}

Afrika-Zahlung:
https://www.patapata.us/pages/africa-payment

Antworten:
1 - Ich habe mit Shopify bezahlt
2 - Ich habe mit Afrika-Zahlung bezahlt
3 - Mit Agent fortfahren`,

    pt: `✅ Arquivo de laminação recebido.

Tamanho: ${details.size}
Quantidade: ${details.quantity}

Pagamento Shopify:
${checkout}

Pagamento África:
https://www.patapata.us/pages/africa-payment

Responda:
1 - Paguei com Shopify
2 - Paguei com Pagamento África
3 - Continuar com agente`,

    ar: `✅ تم استلام ملف التغليف.

الحجم: ${details.size}
الكمية: ${details.quantity}

دفع Shopify:
${checkout}

دفع أفريقيا:
https://www.patapata.us/pages/africa-payment

رد:
1 - دفعت عبر Shopify
2 - دفعت عبر دفع أفريقيا
3 - المتابعة مع موظف`,
    zh: `✅ 覆膜文件已收到。

尺寸：${details.size}
数量：${details.quantity}

Shopify 付款：
${checkout}

非洲付款：
https://www.patapata.us/pages/africa-payment

回复：
1 - 我已通过 Shopify 付款
2 - 我已通过非洲付款
3 - 继续联系客服`
  });
}

function paymentChoiceInvalidText(language = "en") {
  return pickText(language, {
    en: `Please choose:

1 - I paid with Shopify
2 - I paid with Africa Payment
3 - Continue with Agent`,
    es: `Por favor elige:

1 - Pagué con Shopify
2 - Pagué con Pago África
3 - Continuar con agente`,
    fr: `Veuillez choisir :

1 - J'ai payé avec Shopify
2 - J'ai payé avec Paiement Afrique
3 - Continuer avec un agent`,
    de: `Bitte wählen Sie:

1 - Ich habe mit Shopify bezahlt
2 - Ich habe mit Afrika-Zahlung bezahlt
3 - Mit Agent fortfahren`,
    pt: `Escolha:

1 - Paguei com Shopify
2 - Paguei com Pagamento África
3 - Continuar com agente`,
    ar: `يرجى الاختيار:

1 - دفعت عبر Shopify
2 - دفعت عبر دفع أفريقيا
3 - المتابعة مع موظف`,
    zh: `请选择：

1 - 我已通过 Shopify 付款
2 - 我已通过非洲付款
3 - 继续联系客服`
  });
}



function botText(key, language = "en", vars = {}) {
  const dict = {
    landing_received: {
      en: `✅ Your request has been received by PATAPATA Print-O-Matic Services.

Service: ${vars.service || "SERVICE"}

A worker will review it and reply to you shortly here on WhatsApp.

You may now send your file, photo, video, document, or voice instruction.`,
      es: `✅ Su solicitud fue recibida por PATAPATA Print-O-Matic Services.

Servicio: ${vars.service || "SERVICIO"}

Un trabajador la revisará y le responderá pronto aquí en WhatsApp.

Ahora puede enviar su archivo, foto, video, documento o instrucción de voz.`,
      fr: `✅ Votre demande a été reçue par PATAPATA Print-O-Matic Services.

Service : ${vars.service || "SERVICE"}

Un agent l'examinera et vous répondra bientôt ici sur WhatsApp.

Vous pouvez maintenant envoyer votre fichier, photo, vidéo, document ou instruction vocale.`,
      de: `✅ Ihre Anfrage wurde von PATAPATA Print-O-Matic Services erhalten.

Service: ${vars.service || "SERVICE"}

Ein Mitarbeiter prüft sie und antwortet Ihnen in Kürze hier auf WhatsApp.

Sie können jetzt Ihre Datei, Ihr Foto, Video, Dokument oder Ihre Sprachanweisung senden.`,
      pt: `✅ Sua solicitação foi recebida pela PATAPATA Print-O-Matic Services.

Serviço: ${vars.service || "SERVIÇO"}

Um trabalhador analisará e responderá em breve aqui no WhatsApp.

Agora você pode enviar seu arquivo, foto, vídeo, documento ou instrução de voz.`,
      ar: `✅ تم استلام طلبك من PATAPATA Print-O-Matic Services.

الخدمة: ${vars.service || "SERVICE"}

سيقوم أحد الموظفين بمراجعته والرد عليك قريبًا هنا على واتساب.

يمكنك الآن إرسال ملف أو صورة أو فيديو أو مستند أو تعليمات صوتية.`,
      zh: `✅ PATAPATA Print-O-Matic Services 已收到您的请求。

服务：${vars.service || "服务"}

工作人员会审核，并很快在 WhatsApp 上回复您。

您现在可以发送文件、照片、视频、文档或语音说明。`
    },
    id_photo_upload: { en: "📸 ID Photo selected. Please upload your photo now.", es: "📸 Foto de identificación seleccionada. Suba su foto ahora.", fr: "📸 Photo d'identité sélectionnée. Veuillez télécharger votre photo maintenant.", de: "📸 Passfoto ausgewählt. Bitte laden Sie jetzt Ihr Foto hoch.", pt: "📸 Foto de identificação selecionada. Envie sua foto agora.", ar: "📸 تم اختيار صورة الهوية. يرجى رفع صورتك الآن.", zh: "📸 已选择证件照。请现在上传您的照片。" },
    image_edit_menu: { en: `🖼️ Image Editing selected.

Choose image editing type:

1 - Basic Image Edit
2 - Background Removal
3 - Product Photo Enhancement
4 - Advanced Image Editing

Reply with 1, 2, 3, or 4.`, es: `🖼️ Edición de imagen seleccionada.

Elija el tipo de edición:

1 - Edición básica
2 - Eliminación de fondo
3 - Mejora de foto de producto
4 - Edición avanzada

Responda con 1, 2, 3 o 4.`, fr: `🖼️ Retouche d'image sélectionnée.

Choisissez le type de retouche :

1 - Retouche de base
2 - Suppression d'arrière-plan
3 - Amélioration de photo produit
4 - Retouche avancée

Répondez avec 1, 2, 3 ou 4.`, de: `🖼️ Bildbearbeitung ausgewählt.

Wählen Sie die Art der Bildbearbeitung:

1 - Einfache Bildbearbeitung
2 - Hintergrund entfernen
3 - Produktfoto verbessern
4 - Erweiterte Bildbearbeitung

Antworten Sie mit 1, 2, 3 oder 4.`, pt: `🖼️ Edição de imagem selecionada.

Escolha o tipo de edição:

1 - Edição básica
2 - Remoção de fundo
3 - Melhoria de foto de produto
4 - Edição avançada

Responda com 1, 2, 3 ou 4.`, ar: `🖼️ تم اختيار تعديل الصور.

اختر نوع التعديل:

1 - تعديل أساسي
2 - إزالة الخلفية
3 - تحسين صورة المنتج
4 - تعديل متقدم

رد بـ 1 أو 2 أو 3 أو 4.`, zh: `🖼️ 已选择图片编辑。

请选择图片编辑类型：

1 - 基础图片编辑
2 - 去除背景
3 - 产品照片增强
4 - 高级图片编辑

请回复 1、2、3 或 4。` },
    video_edit_menu: { en: `🎬 Video Editing selected.

Choose video editing type:

1 - Short Video Edit
2 - Social Media Video Edit
3 - Standard Video Edit
4 - Advanced Video Edit

Reply with 1, 2, 3, or 4.`, es: `🎬 Edición de video seleccionada.

Elija el tipo de edición:

1 - Video corto
2 - Video para redes sociales
3 - Edición estándar
4 - Edición avanzada

Responda con 1, 2, 3 o 4.`, fr: `🎬 Montage vidéo sélectionné.

Choisissez le type de montage :

1 - Vidéo courte
2 - Vidéo réseaux sociaux
3 - Montage standard
4 - Montage avancé

Répondez avec 1, 2, 3 ou 4.`, de: `🎬 Videobearbeitung ausgewählt.

Wählen Sie die Videobearbeitung:

1 - Kurzvideo
2 - Social-Media-Video
3 - Standard-Video
4 - Fortgeschrittenes Video

Antworten Sie mit 1, 2, 3 oder 4.`, pt: `🎬 Edição de vídeo selecionada.

Escolha o tipo de edição:

1 - Vídeo curto
2 - Vídeo para redes sociais
3 - Vídeo padrão
4 - Vídeo avançado

Responda com 1, 2, 3 ou 4.`, ar: `🎬 تم اختيار تعديل الفيديو.

اختر نوع تعديل الفيديو:

1 - فيديو قصير
2 - فيديو لوسائل التواصل
3 - فيديو عادي
4 - فيديو متقدم

رد بـ 1 أو 2 أو 3 أو 4.`, zh: `🎬 已选择视频编辑。

请选择视频编辑类型：

1 - 短视频编辑
2 - 社交媒体视频编辑
3 - 标准视频编辑
4 - 高级视频编辑

请回复 1、2、3 或 4。` },
    copies_question: { en: "How many copies do you want?", es: "¿Cuántas copias deseas?", fr: "Combien de copies voulez-vous ?", de: "Wie viele Kopien möchten Sie?", pt: "Quantas cópias você deseja?", ar: "كم عدد النسخ التي تريدها؟", zh: "您需要多少份？" },
    pages_question: { en: "How many pages are in the document?", es: "¿Cuántas páginas tiene el documento?", fr: "Combien de pages contient le document ?", de: "Wie viele Seiten hat das Dokument?", pt: "Quantas páginas tem o documento?", ar: "كم عدد صفحات المستند؟", zh: "文档共有多少页？" },
    laminate_quantity_question: { en: "How many documents/pages do you want laminated?", es: "¿Cuántos documentos/páginas desea laminar?", fr: "Combien de documents/pages voulez-vous plastifier ?", de: "Wie viele Dokumente/Seiten möchten Sie laminieren?", pt: "Quantos documentos/páginas você deseja laminar?", ar: "كم عدد المستندات/الصفحات التي تريد تغليفها؟", zh: "您要覆膜多少份文件/页面？" },
    menu_invalid: { en: `Please reply with one of the options below:

${serviceMenu(language)}`, es: `Responda con una de las opciones siguientes:

${serviceMenu(language)}`, fr: `Veuillez répondre avec l'une des options ci-dessous :

${serviceMenu(language)}`, de: `Bitte antworten Sie mit einer der folgenden Optionen:

${serviceMenu(language)}`, pt: `Responda com uma das opções abaixo:

${serviceMenu(language)}`, ar: `يرجى الرد بأحد الخيارات أدناه:

${serviceMenu(language)}`, zh: `请回复以下其中一个选项：

${serviceMenu(language)}` }
  };
  return pickText(language, dict[key] || dict.menu_invalid);
}


// =========================
// DIGITAL SERVICES & DOWNLOADS
// =========================
function digitalServicesMenuText(language = "en") {
  return pickText(language, {
    en: `🛍️ Printo Digital Services & Downloads

Choose a category:

1 - 🎁 Free Downloads
2 - 💼 Business Templates
3 - 🎨 Flyers & Logos
4 - 📄 CV / Resume Templates
5 - 🎓 Courses & Study Notes
6 - 🎬 Video Editing Assets
7 - 🤖 AI Tools & Prompts
8 - 🧾 Forms & Documents
9 - 🎵 Music & Sound Effects
10 - 📚 eBooks
0 - Back to Main Menu

Reply with a number.`,
    es: `🛍️ Servicios digitales y descargas de Printo

Elige una categoría:

1 - 🎁 Descargas gratis
2 - 💼 Plantillas de negocios
3 - 🎨 Flyers y logos
4 - 📄 Plantillas de CV / Resume
5 - 🎓 Cursos y apuntes de estudio
6 - 🎬 Recursos para edición de video
7 - 🤖 Herramientas y prompts de IA
8 - 🧾 Formularios y documentos
9 - 🎵 Música y efectos de sonido
10 - 📚 eBooks
0 - Volver al menú principal

Responde con un número.`,
    fr: `🛍️ Services numériques et téléchargements Printo

Choisissez une catégorie :

1 - 🎁 Téléchargements gratuits
2 - 💼 Modèles business
3 - 🎨 Flyers et logos
4 - 📄 Modèles de CV / résumé
5 - 🎓 Cours et notes d'étude
6 - 🎬 Ressources de montage vidéo
7 - 🤖 Outils et prompts IA
8 - 🧾 Formulaires et documents
9 - 🎵 Musique et effets sonores
10 - 📚 eBooks
0 - Retour au menu principal

Répondez avec un numéro.`,
    de: `🛍️ Printo Digitale Dienste & Downloads

Wählen Sie eine Kategorie:

1 - 🎁 Kostenlose Downloads
2 - 💼 Business-Vorlagen
3 - 🎨 Flyer & Logos
4 - 📄 Lebenslauf-Vorlagen
5 - 🎓 Kurse & Lernnotizen
6 - 🎬 Video-Bearbeitungs-Assets
7 - 🤖 KI-Tools & Prompts
8 - 🧾 Formulare & Dokumente
9 - 🎵 Musik & Soundeffekte
10 - 📚 eBooks
0 - Zurück zum Hauptmenü

Antworten Sie mit einer Nummer.`,
    pt: `🛍️ Serviços digitais e downloads Printo

Escolha uma categoria:

1 - 🎁 Downloads grátis
2 - 💼 Modelos de negócios
3 - 🎨 Flyers e logos
4 - 📄 Modelos de currículo / CV
5 - 🎓 Cursos e notas de estudo
6 - 🎬 Recursos de edição de vídeo
7 - 🤖 Ferramentas e prompts de IA
8 - 🧾 Formulários e documentos
9 - 🎵 Música e efeitos sonoros
10 - 📚 eBooks
0 - Voltar ao menu principal

Responda com um número.`,
    ar: `🛍️ خدمات وتنزيلات Printo الرقمية

اختر الفئة:

1 - 🎁 تنزيلات مجانية
2 - 💼 قوالب أعمال
3 - 🎨 منشورات وشعارات
4 - 📄 قوالب السيرة الذاتية
5 - 🎓 دورات وملاحظات دراسية
6 - 🎬 ملفات تحرير الفيديو
7 - 🤖 أدوات وموجهات الذكاء الاصطناعي
8 - 🧾 نماذج ومستندات
9 - 🎵 موسيقى ومؤثرات صوتية
10 - 📚 كتب إلكترونية
0 - العودة إلى القائمة الرئيسية

رد برقم.`,
    zh: `🛍️ Printo 数字服务和下载

请选择类别：

1 - 🎁 免费下载
2 - 💼 商业模板
3 - 🎨 传单和标志
4 - 📄 简历 / CV 模板
5 - 🎓 课程和学习资料
6 - 🎬 视频编辑素材
7 - 🤖 AI 工具和提示词
8 - 🧾 表格和文件
9 - 🎵 音乐和音效
10 - 📚 电子书
0 - 返回主菜单

请回复编号。`
  });
}

function digitalServiceSelectedText(language = "en", category = "") {
  return pickText(language, {
    en: `✅ Digital Services selected: ${category}\n\nPlease type what you need. You may also send a file, photo, link, document, or voice note.\n\nA Printo team member will review it and reply here on WhatsApp.`,
    es: `✅ Servicio digital seleccionado: ${category}\n\nEscriba lo que necesita. También puede enviar archivo, foto, enlace, documento o nota de voz.\n\nUn miembro del equipo Printo lo revisará y responderá aquí en WhatsApp.`,
    fr: `✅ Service numérique sélectionné : ${category}\n\nVeuillez écrire ce dont vous avez besoin. Vous pouvez aussi envoyer un fichier, une photo, un lien, un document ou un message vocal.\n\nUn membre de l'équipe Printo l'examinera et répondra ici sur WhatsApp.`,
    de: `✅ Digitaler Dienst ausgewählt: ${category}\n\nBitte schreiben Sie, was Sie benötigen. Sie können auch Datei, Foto, Link, Dokument oder Sprachnachricht senden.\n\nEin Printo-Teammitglied prüft es und antwortet hier auf WhatsApp.`,
    pt: `✅ Serviço digital selecionado: ${category}\n\nDigite o que você precisa. Você também pode enviar arquivo, foto, link, documento ou mensagem de voz.\n\nUm membro da equipe Printo analisará e responderá aqui no WhatsApp.`,
    ar: `✅ تم اختيار خدمة رقمية: ${category}\n\nيرجى كتابة ما تحتاجه. يمكنك أيضًا إرسال ملف أو صورة أو رابط أو مستند أو رسالة صوتية.\n\nسيقوم أحد أعضاء فريق Printo بالمراجعة والرد هنا على واتساب.`,
    zh: `✅ 已选择数字服务：${category}\n\n请写下您需要的内容。您也可以发送文件、照片、链接、文档或语音消息。\n\nPrinto 团队成员会审核并在 WhatsApp 上回复您。`
  });
}

function getDigitalCategoryName(choice, language = "en") {
  const categories = {
    "1": { en: "Free Downloads", es: "Descargas gratis", fr: "Téléchargements gratuits", de: "Kostenlose Downloads", pt: "Downloads grátis", ar: "تنزيلات مجانية", zh: "免费下载" },
    "2": { en: "Business Templates", es: "Plantillas de negocios", fr: "Modèles business", de: "Business-Vorlagen", pt: "Modelos de negócios", ar: "قوالب أعمال", zh: "商业模板" },
    "3": { en: "Flyers & Logos", es: "Flyers y logos", fr: "Flyers et logos", de: "Flyer & Logos", pt: "Flyers e logos", ar: "منشورات وشعارات", zh: "传单和标志" },
    "4": { en: "CV / Resume Templates", es: "Plantillas de CV / Resume", fr: "Modèles de CV / résumé", de: "Lebenslauf-Vorlagen", pt: "Modelos de currículo / CV", ar: "قوالب السيرة الذاتية", zh: "简历 / CV 模板" },
    "5": { en: "Courses & Study Notes", es: "Cursos y apuntes", fr: "Cours et notes d'étude", de: "Kurse & Lernnotizen", pt: "Cursos e notas de estudo", ar: "دورات وملاحظات دراسية", zh: "课程和学习资料" },
    "6": { en: "Video Editing Assets", es: "Recursos para edición de video", fr: "Ressources de montage vidéo", de: "Video-Bearbeitungs-Assets", pt: "Recursos de edição de vídeo", ar: "ملفات تحرير الفيديو", zh: "视频编辑素材" },
    "7": { en: "AI Tools & Prompts", es: "Herramientas y prompts de IA", fr: "Outils et prompts IA", de: "KI-Tools & Prompts", pt: "Ferramentas e prompts de IA", ar: "أدوات وموجهات الذكاء الاصطناعي", zh: "AI 工具和提示词" },
    "8": { en: "Forms & Documents", es: "Formularios y documentos", fr: "Formulaires et documents", de: "Formulare & Dokumente", pt: "Formulários e documentos", ar: "نماذج ومستندات", zh: "表格和文件" },
    "9": { en: "Music & Sound Effects", es: "Música y efectos de sonido", fr: "Musique et effets sonores", de: "Musik & Soundeffekte", pt: "Música e efeitos sonoros", ar: "موسيقى ومؤثرات صوتية", zh: "音乐和音效" },
    "10": { en: "eBooks", es: "eBooks", fr: "eBooks", de: "eBooks", pt: "eBooks", ar: "كتب إلكترونية", zh: "电子书" }
  };
  const c = categories[String(choice)] || null;
  return c ? pickText(language, c) : "";
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

LAMINATE_LETTER: process.env.SHOPIFY_VARIANT_LAMINATE_LETTER || "10307335749931",
LAMINATE_LEGAL: process.env.SHOPIFY_VARIANT_LAMINATE_LEGAL || "10307335881003",
LAMINATE_TABLOID: process.env.SHOPIFY_VARIANT_LAMINATE_TABLOID || "10307335946539",
  // ==========================
// IMAGE EDITING
// ==========================
IMAGE_BASIC: process.env.SHOPIFY_VARIANT_IMAGE_BASIC || "52581935939883",
IMAGE_BG_REMOVAL: process.env.SHOPIFY_VARIANT_IMAGE_BG_REMOVAL || "52581935972651",
IMAGE_ENHANCEMENT: process.env.SHOPIFY_VARIANT_IMAGE_ENHANCEMENT || "52581936005419",
IMAGE_ADVANCED: process.env.SHOPIFY_VARIANT_IMAGE_ADVANCED || "52581936038187",
  // VIDEO EDITING
VIDEO_SHORT: process.env.SHOPIFY_VARIANT_VIDEO_SHORT || "52582037061931",
VIDEO_SOCIAL: process.env.SHOPIFY_VARIANT_VIDEO_SOCIAL || "52582037094699",
VIDEO_STANDARD: process.env.SHOPIFY_VARIANT_VIDEO_STANDARD || "52582037127467",
VIDEO_ADVANCED: process.env.SHOPIFY_VARIANT_VIDEO_ADVANCED || "52582037160235",
  ID_PRINT: process.env.SHOPIFY_VARIANT_ID_PRINT || "52746952278315",
  GREETING_STANDARD: process.env.SHOPIFY_VARIANT_GREETING_STANDARD || "",
  GREETING_PREMIUM: process.env.SHOPIFY_VARIANT_GREETING_PREMIUM || "",
};

// =========================
// AFRICA / NIGERIA PRICING
// =========================
function getNigeriaPrintPrice({ paper_size = "A4", color_mode = "BW", pages = 1, copies = 1 }) {
  const p = String(paper_size || "A4").toUpperCase();
  const c = String(color_mode || "BW").toUpperCase();
  const qty = Math.max(1, Number(pages || 1)) * Math.max(1, Number(copies || 1));

  let unit = 0;

  if (p === "A4" || p === "LETTER") {
    unit = c === "COLOR" ? 300 : 100;
  } else if (p === "A3") {
    unit = c === "COLOR" ? 500 : 200;
  } else if (p === "CARD") {
    unit = c === "COLOR" ? 1000 : 500;
  } else {
    unit = c === "COLOR" ? 300 : 100;
  }

  return {
    qty,
    unit,
    total: qty * unit
  };
}

function getNigeriaServicePrice(serviceType) {
  const map = {
    ID_CARD: 2000,
    IMAGE_BASIC: 500,
    IMAGE_BG_REMOVE: 700,
    IMAGE_ENHANCE: 1000,
    IMAGE_ADVANCED: 1000,
    VIDEO_SHORT: 1000,
    VIDEO_SOCIAL: 1000,
    VIDEO_STANDARD: 1000,
    VIDEO_ADVANCED: 1000,
    GREETING_CARD: 2000,
    GREETING_STANDARD: 2000,
    GREETING_PREMIUM: 5000
  };

  return map[String(serviceType || "").toUpperCase()] || 1000;
}

function formatNaira(amount) {
  return "₦" + Number(amount || 0).toLocaleString("en-NG");
}

function getNigeriaPricingText({ service_type = "PRINTING", paper_size = "A4", color_mode = "BW", pages = 1, copies = 1 }) {
  const s = String(service_type || "PRINTING").toUpperCase();

  if (s === "PRINTING") {
    const pricing = getNigeriaPrintPrice({ paper_size, color_mode, pages, copies });

    return `🇳🇬 Africa / Nigeria Pricing

Paper Size: ${paper_size}
Color Mode: ${color_mode === "COLOR" ? "Color" : "Black & White"}
Pages: ${pages}
Copies: ${copies}

Estimated Qty: ${pricing.qty}
Unit Price: ${formatNaira(pricing.unit)}
Estimated Total: ${formatNaira(pricing.total)}`;
  }

  const price = getNigeriaServicePrice(s);

  return `🇳🇬 Africa / Nigeria Pricing

Service: ${s.replaceAll("_", " ")}
Estimated Price: ${formatNaira(price)}`;
}

function paymentOptionMenuText() {
  return `

Choose payment option:

1. Shopify Checkout (USD)
2. Africa Payment (₦ Nigeria Pricing)
3. Continue with Agent

Reply with 1, 2, or 3.`;
}
function buildShopifyCartUrl(variantId, quantity) {
  if (!variantId) return "";
  return `https://www.patapata.us/cart/${variantId}:${quantity}`;
}

function getPrintVariantId(paperSize, color) {
  const normalizedPaperSize = String(paperSize || "A4").trim().toUpperCase();
  const normalizedColor = String(color || "BW").trim().toUpperCase();
  const isColor = normalizedColor === "COLOR";

  if (normalizedPaperSize === "A4") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_A4_COLOR : SHOPIFY_VARIANTS.PRINT_A4_BW;
  }
  if (normalizedPaperSize === "A3") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_A3_COLOR : SHOPIFY_VARIANTS.PRINT_A3_BW;
  }
  if (normalizedPaperSize === "LETTER") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_LETTER_COLOR : SHOPIFY_VARIANTS.PRINT_LETTER_BW;
  }
  if (normalizedPaperSize === "LEGAL") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_LEGAL_COLOR : SHOPIFY_VARIANTS.PRINT_LEGAL_BW;
  }
  if (normalizedPaperSize === "TABLOID") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_TABLOID_COLOR : SHOPIFY_VARIANTS.PRINT_TABLOID_BW;
  }
  if (normalizedPaperSize === "CARD") {
    return isColor ? SHOPIFY_VARIANTS.PRINT_CARD_COLOR : SHOPIFY_VARIANTS.PRINT_CARD_BW;
  }

  return "";
}

function getLaminateVariantId(size) {
  if (!size) return "";

  const s = String(size).trim().toUpperCase();

  if (s === "A4" || s === "LETTER") return SHOPIFY_VARIANTS.LAMINATE_LETTER;
  if (s === "LEGAL") return SHOPIFY_VARIANTS.LAMINATE_LEGAL;
  if (s === "TABLOID") return SHOPIFY_VARIANTS.LAMINATE_TABLOID;

  return "";
}



// =========================
// PRINTO GREETING ACCESS / CREDITS
// =========================
function normalizeGreetingIdentity(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function makeGreetingCustomerKey(value = "") {
  const normalized = normalizeGreetingIdentity(value);
  if (!normalized) return "";

  return `g_${crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")}`;
}


function readPrintoCookie(req, name) {
  const cookieHeader = String(req?.headers?.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch (_) {
      return part.slice(index + 1).trim();
    }
  }
  return "";
}

function setPrintoAccountCookie(res, customerKey) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `printo_customer_key=${encodeURIComponent(customerKey)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`
  );
}

function getGreetingCustomerIdentity(req, body = {}, whatsappPhone = "") {
  const directCustomerKey = String(
    body.customerKey ||
    body.customer_key ||
    req.headers["x-printo-customer-key"] ||
    readPrintoCookie(req, "printo_customer_key") ||
    ""
  ).trim();

  if (/^g_[a-f0-9]{64}$/i.test(directCustomerKey)) {
    return {
      customerKey: directCustomerKey,
      identitySource: "customer_key",
      contactPhone: String(
        whatsappPhone ||
        body.customerPhone ||
        body.customer_phone ||
        body.phone ||
        body.whatsapp ||
        ""
      ).replace(/\D+/g, "")
    };
  }

  const supplied =
    body.customerId ||
    body.customer_id ||
    body.deviceId ||
    body.device_id ||
    body.customerPhone ||
    body.customer_phone ||
    body.phone ||
    body.whatsapp ||
    body.email ||
    req.headers["x-printo-customer-id"] ||
    whatsappPhone ||
    "";

  if (supplied) {
    const source = whatsappPhone
      ? "whatsapp"
      : body.customerPhone || body.customer_phone || body.phone || body.whatsapp
        ? "phone"
        : body.email
          ? "email"
          : body.customerId || body.customer_id || body.deviceId || body.device_id
            ? "device"
            : "header";

    return {
      customerKey: makeGreetingCustomerKey(`${source}:${supplied}`),
      identitySource: source,
      contactPhone: String(
        whatsappPhone ||
        body.customerPhone ||
        body.customer_phone ||
        body.phone ||
        body.whatsapp ||
        ""
      ).replace(/\D+/g, "")
    };
  }

  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  const ip = forwarded || req.ip || req.socket?.remoteAddress || "unknown";
  const userAgent = String(req.headers["user-agent"] || "unknown");

  return {
    customerKey: makeGreetingCustomerKey(`network:${ip}:${userAgent}`),
    identitySource: "network_fallback",
    contactPhone: ""
  };
}

let printoAccountSchemaReadyPromise = null;

// Keep account login independent from the much larger video/media migrations.
// Login and registration only need the customer account and credit-wallet tables.
// Running every Standard/Premium media ALTER TABLE before each login can block or
// fail authentication when a media migration has a problem.
async function ensurePrintoAccountTables() {
  if (printoAccountSchemaReadyPromise) {
    return printoAccountSchemaReadyPromise;
  }

  printoAccountSchemaReadyPromise = (async () => {
    await queryWithRetry(`
      CREATE TABLE IF NOT EXISTS greeting_customer_access (
        customer_key TEXT PRIMARY KEY,
        contact_phone TEXT NOT NULL DEFAULT '',
        free_used BOOLEAN NOT NULL DEFAULT FALSE,
        paid_credits INTEGER NOT NULL DEFAULT 0 CHECK (paid_credits >= 0),
        free_credits_granted BOOLEAN NOT NULL DEFAULT FALSE,
        total_generated INTEGER NOT NULL DEFAULT 0 CHECK (total_generated >= 0),
        last_generation_source TEXT NOT NULL DEFAULT '',
        last_generated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryWithRetry(`
      CREATE TABLE IF NOT EXISTS greeting_customer_accounts (
        email TEXT PRIMARY KEY,
        customer_key TEXT UNIQUE NOT NULL,
        pin_salt TEXT NOT NULL,
        pin_hash TEXT NOT NULL,
        phone_e164 TEXT,
        phone_verified_at TIMESTAMPTZ,
        account_type TEXT NOT NULL DEFAULT 'legacy_email',
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        last_failed_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      )
    `);

    await queryWithRetry(`ALTER TABLE greeting_customer_accounts ADD COLUMN IF NOT EXISTS phone_e164 TEXT`);
    await queryWithRetry(`ALTER TABLE greeting_customer_accounts ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ`);
    await queryWithRetry(`ALTER TABLE greeting_customer_accounts ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'legacy_email'`);
    await queryWithRetry(`ALTER TABLE greeting_customer_accounts ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0`);
    await queryWithRetry(`ALTER TABLE greeting_customer_accounts ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`);
    await queryWithRetry(`ALTER TABLE greeting_customer_accounts ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMPTZ`);
    await queryWithRetry(`
      CREATE UNIQUE INDEX IF NOT EXISTS greeting_customer_accounts_phone_unique
      ON greeting_customer_accounts(phone_e164)
      WHERE phone_e164 IS NOT NULL AND phone_e164 <> ''
    `);

    // This registry survives account recreation and permanently records whether
    // the one-time welcome credits were already issued to a verified phone.
    await queryWithRetry(`
      CREATE TABLE IF NOT EXISTS greeting_verified_phones (
        phone_e164 TEXT PRIMARY KEY,
        customer_key TEXT UNIQUE NOT NULL,
        first_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        welcome_credits_granted BOOLEAN NOT NULL DEFAULT FALSE,
        account_created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Browser verification starts with a random challenge. The customer sends
    // that challenge from their own WhatsApp number to the existing Printo bot.
    // Only Meta-signed webhook requests can confirm a challenge.
    await queryWithRetry(`
      CREATE TABLE IF NOT EXISTS greeting_phone_verification_challenges (
        challenge_hash TEXT PRIMARY KEY,
        phone_e164 TEXT NOT NULL,
        request_ip_hash TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at TIMESTAMPTZ NOT NULL,
        confirmed_at TIMESTAMPTZ,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryWithRetry(`
      CREATE INDEX IF NOT EXISTS greeting_phone_verification_phone_idx
      ON greeting_phone_verification_challenges(phone_e164, created_at DESC)
    `);
    await queryWithRetry(`
      CREATE INDEX IF NOT EXISTS greeting_phone_verification_ip_idx
      ON greeting_phone_verification_challenges(request_ip_hash, created_at DESC)
    `);

    await queryWithRetry(`ALTER TABLE greeting_customer_access ADD COLUMN IF NOT EXISTS free_credits_granted BOOLEAN NOT NULL DEFAULT FALSE`);
    await queryWithRetry(`ALTER TABLE greeting_customer_access ALTER COLUMN paid_credits SET DEFAULT 0`);
    await queryWithRetry(`ALTER TABLE greeting_customer_access ALTER COLUMN free_credits_granted SET DEFAULT FALSE`);
    await queryWithRetry(`ALTER TABLE greeting_customer_access ADD COLUMN IF NOT EXISTS subscription_plan TEXT NOT NULL DEFAULT 'free'`);
    await queryWithRetry(`ALTER TABLE greeting_customer_access ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'inactive'`);
    await queryWithRetry(`ALTER TABLE greeting_customer_access ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ`);
    await queryWithRetry(`ALTER TABLE greeting_customer_access ADD COLUMN IF NOT EXISTS subscription_renews_at TIMESTAMPTZ`);
    await queryWithRetry(`ALTER TABLE greeting_customer_access ADD COLUMN IF NOT EXISTS subscription_term_months INTEGER NOT NULL DEFAULT 0`);
    await queryWithRetry(`ALTER TABLE greeting_customer_access ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ`);
    await queryWithRetry(`ALTER TABLE greeting_customer_access ADD COLUMN IF NOT EXISTS next_credit_release_at TIMESTAMPTZ`);
    await queryWithRetry(`ALTER TABLE greeting_customer_access ADD COLUMN IF NOT EXISTS monthly_credit_amount INTEGER NOT NULL DEFAULT 0`);
    await queryWithRetry(`ALTER TABLE greeting_customer_access ADD COLUMN IF NOT EXISTS membership_order_reference TEXT NOT NULL DEFAULT ''`);

  })().catch((error) => {
    // Permit a later request to retry after a temporary database failure.
    printoAccountSchemaReadyPromise = null;
    throw error;
  });

  return printoAccountSchemaReadyPromise;
}

let greetingAccessTablesReady = false;

async function ensureGreetingAccessTables() {
  if (greetingAccessTablesReady) return;

  await ensurePrintoAccountTables();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS greeting_payment_events (
      event_key TEXT PRIMARY KEY,
      customer_key TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'manual',
      credits INTEGER NOT NULL DEFAULT 1 CHECK (credits > 0),
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS greeting_payment_events_customer_idx
    ON greeting_payment_events(customer_key)
  `);

  // Persist Standard greeting jobs and finished media in PostgreSQL so Render
  // deploys/restarts cannot erase customer videos or leave credits stranded.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS standard_greeting_videos (
      greeting_id TEXT PRIMARY KEY,
      job_id TEXT UNIQUE NOT NULL,
      customer_key TEXT NOT NULL,
      recipient_name TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      personal_message TEXT NOT NULL DEFAULT '',
      spoken_text TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'en',
      file_name TEXT NOT NULL DEFAULT '',
      video_data BYTEA,
      video_mime TEXT NOT NULL DEFAULT 'video/mp4',
      poster_data BYTEA,
      poster_mime TEXT NOT NULL DEFAULT 'image/jpeg',
      share_poster_data BYTEA,
      share_poster_mime TEXT NOT NULL DEFAULT 'image/jpeg',
      status TEXT NOT NULL DEFAULT 'pending',
      render_error TEXT NOT NULL DEFAULT '',
      credit_source TEXT NOT NULL DEFAULT '',
      credits_used INTEGER NOT NULL DEFAULT 20,
      refunded BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // CREATE TABLE IF NOT EXISTS does not add columns to an older table.
  // Upgrade every Standard greeting column before any insert, index, dashboard
  // lookup, render-status lookup, or media request can use it.
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS greeting_id TEXT`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS job_id TEXT`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS customer_key TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS recipient_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS sender_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS personal_message TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS spoken_text TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en'`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS file_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS video_data BYTEA`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS video_mime TEXT NOT NULL DEFAULT 'video/mp4'`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS poster_data BYTEA`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS poster_mime TEXT NOT NULL DEFAULT 'image/jpeg'`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS share_poster_data BYTEA`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS share_poster_mime TEXT NOT NULL DEFAULT 'image/jpeg'`);

  // Older deployments created the media columns as NOT NULL because rows were
  // inserted only after a video finished. The current crash-safe workflow must
  // first insert a pending job, then attach the video/posters after FFmpeg
  // succeeds. Relax those legacy constraints before any pending row is inserted.
  await pool.query(`ALTER TABLE standard_greeting_videos ALTER COLUMN video_data DROP NOT NULL`);
  await pool.query(`ALTER TABLE standard_greeting_videos ALTER COLUMN poster_data DROP NOT NULL`);
  await pool.query(`ALTER TABLE standard_greeting_videos ALTER COLUMN share_poster_data DROP NOT NULL`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS render_error TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS credit_source TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS credits_used INTEGER NOT NULL DEFAULT 20`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS refunded BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE standard_greeting_videos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  // Backfill identifiers on any rows created by an earlier schema version.
  await pool.query(`
    UPDATE standard_greeting_videos
    SET greeting_id = 'legacy-' || md5(random()::text || clock_timestamp()::text || ctid::text)
    WHERE greeting_id IS NULL OR BTRIM(greeting_id) = ''
  `);
  await pool.query(`
    UPDATE standard_greeting_videos
    SET job_id = greeting_id
    WHERE job_id IS NULL OR BTRIM(job_id) = ''
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS standard_greeting_videos_greeting_id_uidx
    ON standard_greeting_videos(greeting_id)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS standard_greeting_videos_job_id_uidx
    ON standard_greeting_videos(job_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS standard_greeting_videos_customer_idx
    ON standard_greeting_videos(customer_key, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS standard_greeting_videos_status_idx
    ON standard_greeting_videos(status)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS premium_greeting_orders (
      order_id TEXT PRIMARY KEY,
      customer_key TEXT NOT NULL,
      contact_phone TEXT NOT NULL DEFAULT '',
      customer_email TEXT NOT NULL DEFAULT '',
      recipient_name TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      personal_message TEXT NOT NULL,
      song_style TEXT NOT NULL DEFAULT '',
      tribute_notes TEXT NOT NULL DEFAULT '',
      recipient_photo_url TEXT NOT NULL DEFAULT '',
      intro_video_url TEXT NOT NULL DEFAULT '',
      recipient_photo_data BYTEA,
      recipient_photo_mime TEXT NOT NULL DEFAULT '',
      recipient_photo_name TEXT NOT NULL DEFAULT '',
      intro_video_data BYTEA,
      intro_video_mime TEXT NOT NULL DEFAULT '',
      intro_video_name TEXT NOT NULL DEFAULT '',
      intro_video_duration_seconds NUMERIC NOT NULL DEFAULT 0,
      intro_video_original_bytes BIGINT NOT NULL DEFAULT 0,
      intro_video_stored_bytes BIGINT NOT NULL DEFAULT 0,
      tribute_music_data BYTEA,
      tribute_music_mime TEXT NOT NULL DEFAULT '',
      tribute_music_name TEXT NOT NULL DEFAULT '',
      tribute_music_url TEXT NOT NULL DEFAULT '',
      voice_script TEXT NOT NULL DEFAULT '',
      final_video_data BYTEA,
      final_video_mime TEXT NOT NULL DEFAULT '',
      final_video_name TEXT NOT NULL DEFAULT '',
      final_video_url TEXT NOT NULL DEFAULT '',
      render_status TEXT NOT NULL DEFAULT 'not_started',
      render_error TEXT NOT NULL DEFAULT '',
      media_token TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'payment_required',
      payment_provider TEXT NOT NULL DEFAULT '',
      payment_reference TEXT NOT NULL DEFAULT '',
      shopify_order_id TEXT NOT NULL DEFAULT '',
      dashboard_job_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Upgrade existing databases without deleting any Premium orders.
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS recipient_photo_data BYTEA`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS recipient_photo_mime TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS recipient_photo_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS intro_video_data BYTEA`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS intro_video_mime TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS intro_video_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS intro_video_duration_seconds NUMERIC NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS intro_video_original_bytes BIGINT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS intro_video_stored_bytes BIGINT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS tribute_music_data BYTEA`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS tribute_music_mime TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS tribute_music_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS tribute_music_url TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS voice_script TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS final_video_data BYTEA`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS final_video_mime TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS final_video_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS final_video_url TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS render_status TEXT NOT NULL DEFAULT 'not_started'`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS render_error TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS media_token TEXT NOT NULL DEFAULT ''`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS premium_greeting_orders_customer_idx
    ON premium_greeting_orders(customer_key)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS premium_greeting_orders_status_idx
    ON premium_greeting_orders(status)
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS premium_greeting_orders_media_token_idx
    ON premium_greeting_orders(media_token)
    WHERE media_token <> ''
  `);

  greetingAccessTablesReady = true;
}

async function syncPremiumDashboardProductionStatus() {
  // Restore Premium production links on existing dashboard jobs after deploys.
  // This also covers older orders whose dashboard_job_id was not saved.
  await pool.query(`
    UPDATE print_jobs AS job
    SET instructions = COALESCE(job.instructions, '') ||
        E'\n\n🎵 CUSTOM TRIBUTE MUSIC READY\n' || premium.tribute_music_url,
        updated_at = NOW()
    FROM premium_greeting_orders AS premium
    WHERE premium.tribute_music_data IS NOT NULL
      AND COALESCE(premium.tribute_music_url, '') <> ''
      AND COALESCE(job.instructions, '') NOT LIKE '%🎵 CUSTOM TRIBUTE MUSIC READY%'
      AND (
        (COALESCE(premium.dashboard_job_id, '') <> ''
          AND job.id::text = premium.dashboard_job_id)
        OR COALESCE(job.instructions, '') ILIKE '%' || premium.order_id || '%'
      )
  `);

  await pool.query(`
    UPDATE print_jobs AS job
    SET instructions = COALESCE(job.instructions, '') ||
        E'\n\n🎬 FINISHED PREMIUM VIDEO\n' || premium.final_video_url,
        updated_at = NOW()
    FROM premium_greeting_orders AS premium
    WHERE premium.final_video_data IS NOT NULL
      AND COALESCE(premium.final_video_url, '') <> ''
      AND COALESCE(job.instructions, '') NOT LIKE '%🎬 FINISHED PREMIUM VIDEO%'
      AND (
        (COALESCE(premium.dashboard_job_id, '') <> ''
          AND job.id::text = premium.dashboard_job_id)
        OR COALESCE(job.instructions, '') ILIKE '%' || premium.order_id || '%'
      )
  `);
}

async function ensureGreetingCustomerRow(customerKey, contactPhone = "") {
  if (!customerKey) {
    throw new Error("Greeting customer identity is required.");
  }

  await pool.query(
    `
    INSERT INTO greeting_customer_access (
      customer_key,
      contact_phone,
      paid_credits,
      free_credits_granted,
      created_at,
      updated_at
    )
    VALUES ($1, $2, 0, FALSE, NOW(), NOW())
    ON CONFLICT (customer_key)
    DO UPDATE SET
      contact_phone = CASE
        WHEN EXCLUDED.contact_phone <> '' THEN EXCLUDED.contact_phone
        ELSE greeting_customer_access.contact_phone
      END,
      updated_at = NOW()
    `,
    [customerKey, String(contactPhone || "").replace(/\D+/g, "")]
  );
}

async function getGreetingAccessStatus(customerKey, contactPhone = "") {
  await ensureGreetingCustomerRow(customerKey, contactPhone);

  const result = await pool.query(
    `
    SELECT
      customer_key,
      contact_phone,
      free_used,
      paid_credits,
      free_credits_granted,
      total_generated,
      last_generation_source,
      last_generated_at,
      subscription_plan,
      subscription_status,
      subscription_started_at,
      subscription_renews_at,
      subscription_term_months,
      subscription_ends_at,
      next_credit_release_at,
      monthly_credit_amount
    FROM greeting_customer_access
    WHERE customer_key = $1
    `,
    [customerKey]
  );

  const row = result.rows[0] || {};
  const creditBalance = Number(row.paid_credits || 0);

  return {
    customerKey,
    contactPhone: row.contact_phone || "",
    freeAvailable: creditBalance >= PRINTO_CREATION_CREDIT_COST,
    freeUsed: creditBalance < PRINTO_FREE_CREDITS,
    freeCreditsGranted: Boolean(row.free_credits_granted),
    paidCredits: creditBalance,
    creditBalance,
    creationCost: PRINTO_CREATION_CREDIT_COST,
    remainingCreations: Math.floor(creditBalance / PRINTO_CREATION_CREDIT_COST),
    totalGenerated: Number(row.total_generated || 0),
    lastGenerationSource: row.last_generation_source || "",
    lastGeneratedAt: row.last_generated_at || null,
    subscriptionPlan: row.subscription_plan || "free",
    subscriptionStatus: row.subscription_status || "inactive",
    subscriptionStartedAt: row.subscription_started_at || null,
    subscriptionRenewsAt: row.subscription_renews_at || null,
    subscriptionTermMonths: Number(row.subscription_term_months || 0),
    subscriptionEndsAt: row.subscription_ends_at || null,
    nextCreditReleaseAt: row.next_credit_release_at || null,
    monthlyCreditAmount: Number(row.monthly_credit_amount || 0),
    creationCosts: PRINTO_CREATION_CREDIT_COSTS,
    remainingByService: {
      standard: Math.floor(creditBalance / PRINTO_CREATION_CREDIT_COSTS.standard),
      premiumVideo: Math.floor(creditBalance / PRINTO_CREATION_CREDIT_COSTS.premium_video),
      premiumMultiImage: Math.floor(creditBalance / PRINTO_CREATION_CREDIT_COSTS.premium_multi_image)
    }
  };
}

async function reserveGreetingGenerationAccess(customerKey, contactPhone = "", creationType = "standard") {
  const normalizedCreationType = normalizePrintoCreationType(creationType);
  const creditCost = getPrintoCreationCreditCost(normalizedCreationType);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO greeting_customer_access (
        customer_key,
        contact_phone,
        paid_credits,
        free_credits_granted,
        created_at,
        updated_at
      )
      VALUES ($1, $2, 0, FALSE, NOW(), NOW())
      ON CONFLICT (customer_key)
      DO UPDATE SET
        contact_phone = CASE
          WHEN EXCLUDED.contact_phone <> '' THEN EXCLUDED.contact_phone
          ELSE greeting_customer_access.contact_phone
        END,
        updated_at = NOW()
      `,
      [customerKey, String(contactPhone || "").replace(/\D+/g, "")]
    );

    const paidResult = await client.query(
      `
      UPDATE greeting_customer_access
      SET
        paid_credits = paid_credits - $2,
        free_used = TRUE,
        total_generated = total_generated + 1,
        last_generation_source = 'credits:' || $3,
        last_generated_at = NOW(),
        updated_at = NOW()
      WHERE customer_key = $1
        AND paid_credits >= $2
      RETURNING *
      `,
      [customerKey, creditCost, normalizedCreationType]
    );

    if (paidResult.rows[0]) {
      await client.query("COMMIT");
      const row = paidResult.rows[0];
      const creditBalance = Number(row.paid_credits || 0);

      return {
        allowed: true,
        source: "credits",
        creationType: normalizedCreationType,
        customerKey,
        creditsUsed: creditCost,
        paidCredits: creditBalance,
        creditBalance,
        remainingCreations: Math.floor(creditBalance / creditCost),
        totalGenerated: Number(row.total_generated || 0)
      };
    }

    const statusResult = await client.query(
      `SELECT paid_credits, total_generated FROM greeting_customer_access WHERE customer_key = $1`,
      [customerKey]
    );
    await client.query("COMMIT");
    const row = statusResult.rows[0] || {};
    const creditBalance = Number(row.paid_credits || 0);

    return {
      allowed: false,
      source: "payment_required",
      creationType: normalizedCreationType,
      customerKey,
      paidCredits: creditBalance,
      creditBalance,
      creditsNeeded: Math.max(creditCost - creditBalance, 0),
      remainingCreations: Math.floor(creditBalance / creditCost),
      totalGenerated: Number(row.total_generated || 0)
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function refundGreetingGenerationAccess(customerKey, source = "", creditsUsed = PRINTO_CREATION_CREDIT_COST) {
  if (!customerKey || source !== "credits") return;
  const safeCreditsUsed = Math.max(1, Number(creditsUsed) || PRINTO_CREATION_CREDIT_COST);

  await pool.query(
    `
    UPDATE greeting_customer_access
    SET
      paid_credits = paid_credits + $2,
      total_generated = GREATEST(total_generated - 1, 0),
      last_generation_source = '',
      last_generated_at = NULL,
      updated_at = NOW()
    WHERE customer_key = $1
    `,
    [customerKey, safeCreditsUsed]
  );
}



const STANDARD_GREETING_VIDEO_MAX_BYTES = 25 * 1024 * 1024;

async function createStandardGreetingGeneration({
  greetingId,
  jobId,
  customerKey,
  recipientName = "",
  senderName = "",
  personalMessage = "",
  language = "en",
  creditSource = "credits",
  creditsUsed = PRINTO_CREATION_CREDIT_COST
}) {
  await queryWithRetry(
    `
    INSERT INTO standard_greeting_videos (
      greeting_id, job_id, customer_key, recipient_name, sender_name,
      personal_message, language, status, credit_source, credits_used,
      refunded, created_at, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,FALSE,NOW(),NOW())
    ON CONFLICT (greeting_id)
    DO UPDATE SET
      job_id = EXCLUDED.job_id,
      customer_key = EXCLUDED.customer_key,
      recipient_name = EXCLUDED.recipient_name,
      sender_name = EXCLUDED.sender_name,
      personal_message = EXCLUDED.personal_message,
      language = EXCLUDED.language,
      status = 'pending',
      render_error = '',
      credit_source = EXCLUDED.credit_source,
      credits_used = EXCLUDED.credits_used,
      refunded = FALSE,
      updated_at = NOW()
    `,
    [
      greetingId,
      jobId,
      customerKey,
      String(recipientName || ""),
      String(senderName || ""),
      String(personalMessage || ""),
      String(language || "en"),
      String(creditSource || ""),
      Math.max(1, Number(creditsUsed) || PRINTO_CREATION_CREDIT_COST)
    ]
  );
}

async function updateStandardGreetingStatus(greetingId, status, renderError = "") {
  if (!greetingId) return;
  await queryWithRetry(
    `UPDATE standard_greeting_videos
     SET status = $2, render_error = $3, updated_at = NOW()
     WHERE greeting_id = $1`,
    [greetingId, String(status || "pending"), String(renderError || "")]
  );
}

async function failStandardGreetingGeneration({ greetingId, error = "Generation failed." }) {
  if (!greetingId) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT customer_key, credit_source, credits_used, refunded, status
       FROM standard_greeting_videos
       WHERE greeting_id = $1
       FOR UPDATE`,
      [greetingId]
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return;
    }

    if (row.status !== "ready" && !row.refunded && row.credit_source === "credits") {
      const credits = Math.max(1, Number(row.credits_used) || PRINTO_CREATION_CREDIT_COST);
      await client.query(
        `UPDATE greeting_customer_access
         SET paid_credits = paid_credits + $2,
             total_generated = GREATEST(total_generated - 1, 0),
             last_generation_source = '',
             last_generated_at = NULL,
             updated_at = NOW()
         WHERE customer_key = $1`,
        [row.customer_key, credits]
      );
    }

    if (row.status !== "ready") {
      await client.query(
        `UPDATE standard_greeting_videos
         SET status = 'failed', render_error = $2, refunded = TRUE, updated_at = NOW()
         WHERE greeting_id = $1`,
        [greetingId, String(error || "Generation failed.")]
      );
    }
    await client.query("COMMIT");
  } catch (errorObject) {
    await client.query("ROLLBACK").catch(() => {});
    throw errorObject;
  } finally {
    client.release();
  }
}

async function completeStandardGreetingGeneration({
  greetingId,
  fileName,
  outputPath,
  posterPath = "",
  sharePosterPath = "",
  spokenText = ""
}) {
  const stat = await fs.promises.stat(outputPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error("The finished Standard video is empty.");
  }
  if (stat.size > STANDARD_GREETING_VIDEO_MAX_BYTES) {
    throw new Error("The finished Standard video is too large for permanent storage.");
  }

  const videoData = await fs.promises.readFile(outputPath);
  const posterData = posterPath && fs.existsSync(posterPath)
    ? await fs.promises.readFile(posterPath)
    : null;
  const sharePosterData = sharePosterPath && fs.existsSync(sharePosterPath)
    ? await fs.promises.readFile(sharePosterPath)
    : null;

  const result = await queryWithRetry(
    `UPDATE standard_greeting_videos
     SET file_name = $2,
         spoken_text = $3,
         video_data = $4,
         video_mime = 'video/mp4',
         poster_data = $5,
         poster_mime = 'image/jpeg',
         share_poster_data = $6,
         share_poster_mime = 'image/jpeg',
         status = 'ready',
         render_error = '',
         refunded = FALSE,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE greeting_id = $1
     RETURNING greeting_id`,
    [greetingId, String(fileName || "Printo-Greeting.mp4"), String(spokenText || ""), videoData, posterData, sharePosterData]
  );

  if (!result.rows[0]) {
    throw new Error("The Standard greeting database record was not found.");
  }
}

async function updateStandardGreetingSharePoster(greetingId, sharePosterPath) {
  if (!greetingId || !sharePosterPath || !fs.existsSync(sharePosterPath)) return;
  const sharePosterData = await fs.promises.readFile(sharePosterPath);
  await queryWithRetry(
    `UPDATE standard_greeting_videos
     SET share_poster_data = $2, share_poster_mime = 'image/jpeg', updated_at = NOW()
     WHERE greeting_id = $1 AND status = 'ready'`,
    [greetingId, sharePosterData]
  );
}

async function getStandardGreetingMetadata(greetingId) {
  const result = await queryWithRetry(
    `SELECT greeting_id, job_id, customer_key, recipient_name, sender_name,
            personal_message, spoken_text, language, file_name, status,
            render_error, created_at, completed_at,
            (video_data IS NOT NULL) AS has_video,
            (poster_data IS NOT NULL) AS has_poster,
            (share_poster_data IS NOT NULL) AS has_share_poster
     FROM standard_greeting_videos
     WHERE greeting_id = $1
     LIMIT 1`,
    [String(greetingId || "")]
  );
  return result.rows[0] || null;
}

async function getStandardGreetingJobById(jobId) {
  const result = await queryWithRetry(
    `SELECT greeting_id, job_id, status, render_error, recipient_name,
            sender_name, language, created_at, completed_at
     FROM standard_greeting_videos
     WHERE job_id = $1
     LIMIT 1`,
    [String(jobId || "")]
  );
  return result.rows[0] || null;
}

async function listStandardGreetingVideos(customerKey) {
  const result = await queryWithRetry(
    `SELECT greeting_id, recipient_name, sender_name, personal_message,
            language, created_at, completed_at
     FROM standard_greeting_videos
     WHERE customer_key = $1 AND status = 'ready' AND video_data IS NOT NULL
     ORDER BY COALESCE(completed_at, created_at) DESC
     LIMIT 100`,
    [customerKey]
  );
  return result.rows.map((row) => ({
    id: row.greeting_id,
    toName: row.recipient_name || "",
    fromName: row.sender_name || "",
    message: row.personal_message || "",
    language: row.language || "en",
    createdAt: row.completed_at || row.created_at || null,
    resultUrl: `/g/${encodeURIComponent(row.greeting_id)}`,
    downloadUrl: `/download/g/${encodeURIComponent(row.greeting_id)}`
  }));
}

async function refundInterruptedStandardGreetingGenerations() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pending = await client.query(
      `SELECT greeting_id, customer_key, credit_source, credits_used, refunded
       FROM standard_greeting_videos
       WHERE status IN ('pending','preparing','queued','rendering','finalizing')
       FOR UPDATE`
    );

    for (const row of pending.rows) {
      if (!row.refunded && row.credit_source === "credits") {
        const credits = Math.max(1, Number(row.credits_used) || PRINTO_CREATION_CREDIT_COST);
        await client.query(
          `UPDATE greeting_customer_access
           SET paid_credits = paid_credits + $2,
               total_generated = GREATEST(total_generated - 1, 0),
               last_generation_source = '',
               last_generated_at = NULL,
               updated_at = NOW()
           WHERE customer_key = $1`,
          [row.customer_key, credits]
        );
      }
      await client.query(
        `UPDATE standard_greeting_videos
         SET status = 'failed',
             render_error = 'Render was interrupted by a server restart. Credits were restored.',
             refunded = TRUE,
             updated_at = NOW()
         WHERE greeting_id = $1`,
        [row.greeting_id]
      );
    }
    await client.query("COMMIT");
    if (pending.rowCount) {
      console.log(`Restored credits for ${pending.rowCount} interrupted Standard greeting job(s).`);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function sendDatabaseBufferWithRange(req, res, buffer, contentType, downloadName = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(404).send("Media is unavailable.");
  }
  const fileSize = buffer.length;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("Content-Type", contentType || "application/octet-stream");
  if (downloadName) {
    res.setHeader("Content-Disposition", `attachment; filename="${String(downloadName).replace(/[\r\n\"]/g, "_")}"`);
  }

  const range = String(req.headers.range || "");
  if (!range) {
    res.setHeader("Content-Length", fileSize);
    return res.end(buffer);
  }

  const match = range.match(/bytes=(\d*)-(\d*)/i);
  if (!match) {
    res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
    return res.end();
  }
  const start = match[1] ? Number(match[1]) : 0;
  const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
  const end = Math.min(requestedEnd, fileSize - 1);
  if (!Number.isFinite(start) || start < 0 || start >= fileSize || end < start) {
    res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
    return res.end();
  }
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", end - start + 1);
  return res.end(buffer.subarray(start, end + 1));
}


async function grantGreetingPaidCredits({
  customerKey,
  contactPhone = "",
  credits = PRINTO_CREATION_CREDIT_COST,
  provider = "manual",
  eventKey = "",
  payload = {}
}) {
  if (!customerKey) {
    throw new Error("Greeting customer key is required.");
  }

  const safeCredits = Math.max(1, Math.min(10000, Number(credits) || PRINTO_CREATION_CREDIT_COST));
  const safeEventKey =
    String(eventKey || "").trim() ||
    `${provider}:${customerKey}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO greeting_customer_access (
        customer_key,
        contact_phone,
        created_at,
        updated_at
      )
      VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (customer_key)
      DO UPDATE SET
        contact_phone = CASE
          WHEN EXCLUDED.contact_phone <> '' THEN EXCLUDED.contact_phone
          ELSE greeting_customer_access.contact_phone
        END,
        updated_at = NOW()
      `,
      [customerKey, String(contactPhone || "").replace(/\D+/g, "")]
    );

    const eventResult = await client.query(
      `
      INSERT INTO greeting_payment_events (
        event_key,
        customer_key,
        provider,
        credits,
        payload,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
      ON CONFLICT (event_key) DO NOTHING
      RETURNING event_key
      `,
      [
        safeEventKey,
        customerKey,
        String(provider || "manual"),
        safeCredits,
        JSON.stringify(payload || {})
      ]
    );

    if (!eventResult.rows[0]) {
      const duplicateStatusResult = await client.query(
        `
        SELECT
          contact_phone,
          free_used,
          paid_credits,
          total_generated
        FROM greeting_customer_access
        WHERE customer_key = $1
        `,
        [customerKey]
      );

      await client.query("COMMIT");
      const duplicateRow = duplicateStatusResult.rows[0] || {};

      return {
        ok: true,
        duplicate: true,
        eventKey: safeEventKey,
        status: {
          customerKey,
          contactPhone: duplicateRow.contact_phone || "",
          freeAvailable: !duplicateRow.free_used,
          freeUsed: Boolean(duplicateRow.free_used),
          paidCredits: Number(duplicateRow.paid_credits || 0),
          totalGenerated: Number(duplicateRow.total_generated || 0)
        }
      };
    }

    const creditResult = await client.query(
      `
      UPDATE greeting_customer_access
      SET
        paid_credits = paid_credits + $2,
        updated_at = NOW()
      WHERE customer_key = $1
      RETURNING *
      `,
      [customerKey, safeCredits]
    );

    await client.query("COMMIT");
    const row = creditResult.rows[0] || {};

    return {
      ok: true,
      duplicate: false,
      eventKey: safeEventKey,
      creditsAdded: safeCredits,
      status: {
        customerKey,
        contactPhone: row.contact_phone || "",
        freeAvailable: !row.free_used,
        freeUsed: Boolean(row.free_used),
        paidCredits: Number(row.paid_credits || 0),
        totalGenerated: Number(row.total_generated || 0)
      }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}


function addMonthsUtc(dateValue, months) {
  const date = new Date(dateValue);
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + Number(months || 0));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDay));
  return date;
}

async function activatePrintoMembership({
  customerKey,
  contactPhone = "",
  plan = "monthly",
  termMonths = 1,
  orderReference = "",
  payload = {}
}) {
  const safeTermMonths = Math.max(1, Math.min(12, Number(termMonths) || 1));
  const safePlan = String(plan || "monthly").toLowerCase();
  const now = new Date();
  const endsAt = addMonthsUtc(now, safeTermMonths);
  const nextReleaseAt = addMonthsUtc(now, 1);

  const creditResult = await grantGreetingPaidCredits({
    customerKey,
    contactPhone,
    credits: PRINTO_MONTHLY_CREDIT_ALLOCATION,
    provider: "shopify_membership",
    eventKey: `membership:${orderReference || customerKey}:month:1`,
    payload: { ...payload, membershipPlan: safePlan, termMonths: safeTermMonths }
  });

  await pool.query(
    `
    UPDATE greeting_customer_access
    SET subscription_plan = $2,
        subscription_status = 'active',
        subscription_started_at = NOW(),
        subscription_renews_at = $3,
        subscription_term_months = $4,
        subscription_ends_at = $3,
        next_credit_release_at = $5,
        monthly_credit_amount = $6,
        membership_order_reference = $7,
        updated_at = NOW()
    WHERE customer_key = $1
    `,
    [
      customerKey,
      safePlan,
      endsAt.toISOString(),
      safeTermMonths,
      nextReleaseAt.toISOString(),
      PRINTO_MONTHLY_CREDIT_ALLOCATION,
      String(orderReference || "")
    ]
  );

  return { ...creditResult, plan: safePlan, termMonths: safeTermMonths, endsAt, nextReleaseAt };
}

async function releaseDuePrintoMembershipCredits() {
  const client = await pool.connect();
  let released = 0;
  try {
    await client.query("BEGIN");
    const due = await client.query(
      `
      SELECT customer_key, contact_phone, subscription_plan, subscription_ends_at,
             next_credit_release_at, monthly_credit_amount, membership_order_reference
      FROM greeting_customer_access
      WHERE subscription_status = 'active'
        AND next_credit_release_at IS NOT NULL
        AND next_credit_release_at <= NOW()
      FOR UPDATE SKIP LOCKED
      `
    );

    for (const row of due.rows) {
      const endsAt = row.subscription_ends_at ? new Date(row.subscription_ends_at) : null;
      let releaseAt = new Date(row.next_credit_release_at);
      const amount = Math.max(1, Number(row.monthly_credit_amount || PRINTO_MONTHLY_CREDIT_ALLOCATION));

      while (releaseAt <= new Date() && (!endsAt || releaseAt < endsAt)) {
        const eventKey = `membership:${row.membership_order_reference || row.customer_key}:${releaseAt.toISOString().slice(0, 10)}`;
        const event = await client.query(
          `INSERT INTO greeting_payment_events(event_key, customer_key, provider, credits, payload, created_at)
           VALUES($1,$2,'membership_monthly_release',$3,$4::jsonb,NOW())
           ON CONFLICT(event_key) DO NOTHING RETURNING event_key`,
          [eventKey, row.customer_key, amount, JSON.stringify({ plan: row.subscription_plan, releaseAt })]
        );
        if (event.rows[0]) {
          await client.query(
            `UPDATE greeting_customer_access SET paid_credits = paid_credits + $2, updated_at = NOW() WHERE customer_key = $1`,
            [row.customer_key, amount]
          );
          released += 1;
        }
        releaseAt = addMonthsUtc(releaseAt, 1);
      }

      const expired = Boolean(endsAt && new Date() >= endsAt);
      await client.query(
        `UPDATE greeting_customer_access
         SET next_credit_release_at = $2,
             subscription_status = CASE WHEN $3 THEN 'expired' ELSE subscription_status END,
             updated_at = NOW()
         WHERE customer_key = $1`,
        [row.customer_key, expired ? null : releaseAt.toISOString(), expired]
      );
    }

    await client.query("COMMIT");
    return released;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function getShopifyLineItemText(order = {}) {
  return (Array.isArray(order.line_items) ? order.line_items : [])
    .map((item) => `${item.title || ""} ${item.name || ""} ${item.variant_title || ""}`)
    .join(" ")
    .toLowerCase();
}

function detectPrintoMembershipPurchase(order = {}) {
  const text = getShopifyLineItemText(order);
  if (!text.includes("printto premium") && !text.includes("printo premium")) return null;
  if (text.includes("annual") || text.includes("1-year") || text.includes("1 year")) {
    return { plan: "annual", termMonths: 12 };
  }
  if (text.includes("6-month") || text.includes("6 month")) {
    return { plan: "six_month", termMonths: 6 };
  }
  if (text.includes("monthly")) {
    return { plan: "monthly", termMonths: 1 };
  }
  return null;
}

function appendUrlParameters(baseUrl, params = {}) {
  try {
    const url = new URL(baseUrl);

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value) !== "") {
        url.searchParams.set(key, String(value));
      }
    });

    return url.toString();
  } catch (_error) {
    const query = new URLSearchParams(
      Object.entries(params).reduce((acc, [key, value]) => {
        if (value !== undefined && value !== null && String(value) !== "") {
          acc[key] = String(value);
        }
        return acc;
      }, {})
    ).toString();

    return query
      ? `${baseUrl}${String(baseUrl).includes("?") ? "&" : "?"}${query}`
      : baseUrl;
  }
}

function encodeShopifyCartProperties(properties = {}) {
  return Buffer.from(JSON.stringify(properties), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildGreetingPaymentLinks({
  customerKey,
  templateId = "birthday",
  contactPhone = ""
} = {}) {
  const phone = String(contactPhone || "").replace(/\D+/g, "");
  const credits = String(PRINTO_STANDARD_SINGLE_PURCHASE_CREDITS);
  const packageName = "GREETING_STANDARD";

  // A cart permalink preserves both order attributes and line-item properties.
  // The line-item properties are Base64 URL-encoded JSON per Shopify's current
  // cart-permalink format. This keeps the paid order tied to the logged-in
  // Printo account even after the customer moves through Shopify checkout.
  const cartBase =
    buildGreetingCheckoutUrl("STANDARD", 1) ||
    GREETING_SHOPIFY_PAYMENT_URL;

  const lineItemProperties = encodeShopifyCartProperties({
    "Greeting Customer Key": customerKey || "",
    "Greeting Template": templateId || "birthday",
    "Greeting Package": packageName,
    "Greeting Credits": credits,
    "Greeting Phone": phone
  });

  const shopify = appendUrlParameters(cartBase, {
    properties: lineItemProperties,
    "attributes[Greeting Customer Key]": customerKey || "",
    "attributes[Greeting Template]": templateId || "birthday",
    "attributes[Greeting Package]": packageName,
    "attributes[Greeting Credits]": credits,
    "attributes[Greeting Phone]": phone,
    ref: "printo-standard-credit"
  });

  const africa = appendUrlParameters(GREETING_AFRICA_PAYMENT_URL, {
    greeting_customer_key: customerKey || "",
    greeting_template: templateId || "birthday",
    greeting_package: packageName,
    greeting_credits: credits,
    greeting_phone: phone
  });

  return { shopify, africa };
}

function makePremiumOrderId() {
  return `PPM-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function getPremiumShopifyBaseUrl() {
  const explicit = String(process.env.GREETING_PREMIUM_SHOPIFY_URL || "").trim();
  if (explicit) return explicit;
  return buildGreetingCheckoutUrl("PREMIUM", 1);
}

function buildPremiumPaymentLinks({
  orderId,
  customerKey,
  contactPhone = ""
} = {}) {
  const phone = String(contactPhone || "").replace(/\D+/g, "");
  const common = {
    premium_order_id: orderId || "",
    greeting_customer_key: customerKey || "",
    greeting_package: "GREETING_PREMIUM",
    greeting_phone: phone
  };

  const premiumShopifyBase = getPremiumShopifyBaseUrl();
  const shopify = premiumShopifyBase
    ? appendUrlParameters(premiumShopifyBase, {
        ...common,
        "attributes[Premium Order ID]": orderId || "",
        "attributes[Greeting Customer Key]": customerKey || "",
        "attributes[Greeting Package]": "GREETING_PREMIUM",
        "attributes[Greeting Phone]": phone
      })
    : "";

  const africa = appendUrlParameters(GREETING_AFRICA_PAYMENT_URL, common);
  return { shopify, africa };
}


function getPublicBaseUrl(req) {
  return getConfiguredPublicOrigin(req);
}

function buildPremiumMediaUrl(req, orderId, mediaToken, kind) {
  const allowedKinds = new Set(["photo", "video", "music", "final"]);
  const safeKind = allowedKinds.has(String(kind || "").toLowerCase())
    ? String(kind).toLowerCase()
    : "photo";
  return `${getPublicBaseUrl(req)}/premium-media/${encodeURIComponent(orderId)}/${safeKind}?token=${encodeURIComponent(mediaToken)}`;
}

function sendPremiumMediaBuffer(req, res, media) {
  const data = Buffer.isBuffer(media.data) ? media.data : Buffer.from(media.data || []);
  if (!data.length) return res.status(404).send("Premium media not found.");

  const mime = String(media.mime || "application/octet-stream");
  const defaultName = mime.startsWith("video/")
    ? "premium-video.mp4"
    : mime.startsWith("audio/")
      ? "tribute-music.mp3"
      : "recipient-photo.jpg";
  const fileName = safeBaseName(media.name || defaultName);

  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  if (mime.startsWith("video/")) {
    res.setHeader("Accept-Ranges", "bytes");
    const range = String(req.headers.range || "");

    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) {
        res.setHeader("Content-Range", `bytes */${data.length}`);
        return res.status(416).end();
      }

      const start = match[1] ? Number(match[1]) : 0;
      const requestedEnd = match[2] ? Number(match[2]) : data.length - 1;
      const end = Math.min(requestedEnd, data.length - 1);

      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= data.length) {
        res.setHeader("Content-Range", `bytes */${data.length}`);
        return res.status(416).end();
      }

      const chunk = data.subarray(start, end + 1);
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${data.length}`);
      res.setHeader("Content-Length", String(chunk.length));
      return res.end(chunk);
    }
  }

  res.setHeader("Content-Length", String(data.length));
  return res.end(data);
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.error("Temporary Premium file cleanup failed:", error.message);
  }
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: options.timeout || 180000,
      maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
      ...options
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      return resolve({ stdout, stderr });
    });
  });
}

async function probeMediaDurationSeconds(filePath) {
  const { stdout } = await execFilePromise("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ], { timeout: 30000, maxBuffer: 1024 * 1024 });

  const duration = Number(String(stdout || "").trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("The personalized voice duration could not be read.");
  }
  return duration;
}

async function probePremiumMedia(filePath) {
  const { stdout } = await execFilePromise("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=codec_type",
    "-of", "json",
    filePath
  ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });

  const parsed = JSON.parse(stdout || "{}");
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  return {
    duration: Number(parsed?.format?.duration || 0),
    size: Number(parsed?.format?.size || 0),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    hasVideo: streams.some((stream) => stream.codec_type === "video")
  };
}

async function compressPremiumIntroductionVideo(inputPath, outputPath) {
  const source = await probePremiumMedia(inputPath);
  if (!source.hasVideo) throw new Error("The introduction file does not contain a valid video stream.");
  if (!Number.isFinite(source.duration) || source.duration <= 0) {
    throw new Error("The introduction video duration could not be read.");
  }
  if (source.duration > PREMIUM_VIDEO_MAX_SECONDS + 0.25) {
    throw new Error(`Introduction video must be ${PREMIUM_VIDEO_MAX_SECONDS} seconds or shorter.`);
  }

  const common = [
    "-y", "-nostdin", "-loglevel", "error",
    "-i", inputPath,
    "-t", String(Math.min(source.duration, PREMIUM_VIDEO_MAX_SECONDS)),
    "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "96k",
    "-ar", "44100",
    "-ac", "2",
    "-movflags", "+faststart"
  ];

  await execFilePromise("ffmpeg", [...common, "-crf", "27", outputPath], {
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024
  });

  let outputSize = fs.statSync(outputPath).size;
  if (outputSize > PREMIUM_VIDEO_STORED_MAX_BYTES) {
    const secondPass = `${outputPath}.smaller.mp4`;
    await execFilePromise("ffmpeg", [...common, "-crf", "31", secondPass], {
      timeout: 240000,
      maxBuffer: 8 * 1024 * 1024
    });
    safeUnlink(outputPath);
    fs.renameSync(secondPass, outputPath);
    outputSize = fs.statSync(outputPath).size;
  }

  if (outputSize > PREMIUM_VIDEO_STORED_MAX_BYTES) {
    throw new Error("The compressed introduction video is still too large. Please upload a shorter video.");
  }

  return {
    duration: source.duration,
    originalBytes: source.size || fs.statSync(inputPath).size,
    storedBytes: outputSize,
    mime: "video/mp4",
    name: "introduction-video.mp4"
  };
}

function buildPremiumVoiceScript(order = {}) {
  const recipient = String(order.recipient_name || "the recipient").trim();
  const sender = String(order.sender_name || "someone special").trim();
  const message = String(order.personal_message || "Wishing you happiness, good health, and a beautiful celebration.").trim();
  return `Hello ${recipient}. Printo Studio has created this special personal tribute for you. ${message} With love from ${sender}.`;
}

async function generatePrintoPremiumVoice({ order, outputPath }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const text = buildPremiumVoiceScript(order);

  if (!apiKey || !voiceId) {
    return { ok: false, reason: "missing_elevenlabs_config", text };
  }

  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        text,
        model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
        voice_settings: {
          stability: Number(process.env.ELEVENLABS_STABILITY || 0.5),
          similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.75),
          style: Number(process.env.ELEVENLABS_STYLE || 0.2),
          use_speaker_boost: true
        }
      },
      {
        responseType: "arraybuffer",
        timeout: 60000,
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg"
        }
      }
    );
    fs.writeFileSync(outputPath, Buffer.from(response.data));
    return { ok: true, outputPath, text };
  } catch (error) {
    console.error("Premium voice generation failed:", error.response?.data || error.message);
    return { ok: false, reason: "voice_generation_failed", error: error.message, text };
  }
}

function findPremiumDefaultMusic() {
  const candidates = [
    path.join(__dirname, "templates", "premium", "premium_demo_music.mp3"),
    path.join(__dirname, "templates", "premium", "premium_demo_music.m4a"),
    path.join(__dirname, "templates", "birthday", "birthday_audio.m4a"),
    path.join(__dirname, "templates", "birthday", "music.mp3")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function createPremiumGreetingDashboardJob({
  orderId,
  customerKey,
  contactPhone,
  customerEmail,
  recipientName,
  senderName,
  personalMessage,
  songStyle,
  tributeNotes,
  recipientPhotoUrl,
  introVideoUrl,
  introVideoMime,
  recipientPhotoMime,
  shopifyUrl,
  africaUrl,
  language = "en",
  introDuration = 0,
  originalVideoBytes = 0,
  storedVideoBytes = 0
}) {
  const instructions = `PRINTO PREMIUM PERSONAL TRIBUTE ORDER

Premium order ID: ${orderId}
Customer key: ${customerKey}
Payment status: AWAITING PAYMENT
Language: ${language}

Recipient: ${recipientName}
Sender: ${senderName}
Phone: ${contactPhone || "Not provided"}
Email: ${customerEmail || "Not provided"}

Personal message:
${personalMessage}

Requested tribute song style:
${songStyle || "Worker to discuss with customer"}

Story / memories / song notes:
${tributeNotes || "Worker to discuss with customer"}

Recipient photo:
${recipientPhotoUrl || "Not uploaded"}

Personal introduction video:
${introVideoUrl || "Not uploaded"}

Introduction processing:
Duration: ${Number(introDuration || 0).toFixed(1)} seconds
Original upload: ${Math.round(Number(originalVideoBytes || 0) / 1024 / 1024)} MB
Stored compressed MP4: ${Math.round(Number(storedVideoBytes || 0) / 1024 / 1024)} MB

Custom tribute music:
Upload the completed song from this dashboard, then render the complete Premium video. The music will loop or extend continuously to the final Printo screen.

Shopify Premium Checkout:
${shopifyUrl || "Premium Shopify product not configured yet"}

Africa Payment:
${africaUrl || GREETING_AFRICA_PAYMENT_URL}

NEXT ACTION FOR WORKER:
1. Confirm payment before production.
2. Review the photo and introduction video.
3. Contact the customer for any missing tribute-song details.
4. Prepare and deliver the finished premium Printo tribute video.`;

  try {
    const primaryFileUrl = introVideoUrl || recipientPhotoUrl || "";
    const primaryMime = introVideoUrl
      ? introVideoMime || "video/mp4"
      : recipientPhotoMime || "image/jpeg";

    const result = await pool.query(
      `
      INSERT INTO print_jobs (
        printer_id,
        queue_type,
        status,
        service_type,
        customer_name,
        customer_email,
        customer_phone,
        original_name,
        file_url,
        mime_type,
        instructions,
        copies,
        pages,
        total_cost,
        created_at,
        updated_at
      )
      VALUES ($1, 'AGENT', 'pending', 'GREETING_PREMIUM', $2, $3, $4, $5, $6, $7, $8, 1, 1, 0, NOW(), NOW())
      RETURNING *
      `,
      [
        process.env.AGENT_QUEUE_ID || "AGENT",
        senderName || recipientName || "Premium Greeting Customer",
        customerEmail || "",
        contactPhone || "",
        `Printo Premium Tribute - ${recipientName}`,
        primaryFileUrl,
        primaryMime,
        instructions
      ]
    );

    return result.rows[0] || null;
  } catch (error) {
    console.error("Premium greeting dashboard job insert failed:", error);
    return null;
  }
}

async function markPremiumOrderPaid({
  orderId,
  provider,
  paymentReference = "",
  shopifyOrderId = "",
  payload = {}
}) {
  if (!orderId) throw new Error("Premium order ID is required.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT * FROM premium_greeting_orders WHERE order_id = $1 FOR UPDATE`,
      [orderId]
    );
    const order = found.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return { ok: false, missing: true };
    }

    if (String(order.status || "").toLowerCase() === "paid") {
      await client.query("COMMIT");
      return { ok: true, duplicate: true, order };
    }

    const updated = await client.query(
      `
      UPDATE premium_greeting_orders
      SET status = 'paid',
          payment_provider = $2,
          payment_reference = $3,
          shopify_order_id = $4,
          paid_at = NOW(),
          updated_at = NOW()
      WHERE order_id = $1
      RETURNING *
      `,
      [
        orderId,
        String(provider || "manual"),
        String(paymentReference || ""),
        String(shopifyOrderId || "")
      ]
    );

    if (order.dashboard_job_id) {
      await client.query(
        `
        UPDATE print_jobs
        SET instructions = COALESCE(instructions, '') || $2,
            updated_at = NOW()
        WHERE id::text = $1::text
        `,
        [
          String(order.dashboard_job_id),
          `\n\n✅ PREMIUM PAYMENT CONFIRMED\nProvider: ${provider || "manual"}\nReference: ${paymentReference || shopifyOrderId || "Not supplied"}\nConfirmed at: ${new Date().toISOString()}`
        ]
      );
    }

    await client.query("COMMIT");
    return { ok: true, duplicate: false, order: updated.rows[0], payload };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function verifyShopifyWebhookSignature(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || "";
  const provided = String(req.headers["x-shopify-hmac-sha256"] || "");

  if (!secret || !provided || !req.rawBody) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("base64");

  const left = Buffer.from(digest);
  const right = Buffer.from(provided);

  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getShopifyNoteAttribute(order = {}, names = []) {
  const wanted = new Set(names.map((name) => String(name).toLowerCase()));
  const candidates = [];

  if (Array.isArray(order.note_attributes)) {
    candidates.push(...order.note_attributes);
  }

  for (const item of Array.isArray(order.line_items) ? order.line_items : []) {
    if (Array.isArray(item?.properties)) candidates.push(...item.properties);
    if (Array.isArray(item?.custom_attributes)) candidates.push(...item.custom_attributes);
  }

  const match = candidates.find((item) =>
    wanted.has(String(item?.name || item?.key || "").toLowerCase())
  );

  return String(match?.value || "").trim();
}

function getStandardGreetingShopifyQuantity(order = {}) {
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  const configuredVariantId = String(SHOPIFY_VARIANTS.GREETING_STANDARD || "").trim();
  let quantity = 0;

  for (const item of lineItems) {
    const itemVariantId = String(item?.variant_id || item?.variant?.id || "").trim();
    const title = `${item?.title || ""} ${item?.name || ""} ${item?.variant_title || ""}`
      .toLowerCase();

    const isConfiguredVariant =
      Boolean(configuredVariantId) && itemVariantId === configuredVariantId;
    const isNamedStandardGreeting =
      title.includes("printo") &&
      (title.includes("greeting card") ||
        title.includes("personalized video greeting") ||
        title.includes("standard greeting")) &&
      !title.includes("premium") &&
      !title.includes("subscription");

    if (isConfiguredVariant || isNamedStandardGreeting) {
      quantity += Math.max(1, Number(item?.quantity || 1));
    }
  }

  // The Printo checkout link also marks the order explicitly. This fallback is
  // useful when Shopify omits a configured variant ID from a test payload.
  if (quantity === 0) {
    const packageName = getShopifyNoteAttribute(order, [
      "Greeting Package",
      "greeting_package",
      "Printo Greeting Package"
    ]).toUpperCase();
    if (packageName === "GREETING_STANDARD") quantity = 1;
  }

  return Math.min(100, Math.max(0, quantity));
}

// =========================
// PRINTO GREETING STUDIO
// =========================
const GREETING_TEMPLATES = [
  { id: "birthday", emoji: "🎂", name: "Birthday Greeting", occasion: "Birthday", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "anniversary", emoji: "❤️", name: "Anniversary Greeting", occasion: "Anniversary", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "wedding", emoji: "💍", name: "Wedding Greeting", occasion: "Wedding", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "engagement", emoji: "💎", name: "Engagement Greeting", occasion: "Engagement", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "new-baby", emoji: "👶", name: "New Baby Greeting", occasion: "New Baby", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "baby-shower", emoji: "🍼", name: "Baby Shower Greeting", occasion: "Baby Shower", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "child-dedication", emoji: "🙏", name: "Child Dedication Greeting", occasion: "Child Dedication", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "graduation", emoji: "🎓", name: "Graduation Greeting", occasion: "Graduation", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "housewarming", emoji: "🏡", name: "Housewarming Greeting", occasion: "Housewarming", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "new-job-promotion", emoji: "💼", name: "New Job / Promotion Greeting", occasion: "New Job / Promotion", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "congratulations", emoji: "🎉", name: "Congratulations Greeting", occasion: "Congratulations", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "get-well-soon", emoji: "🙏", name: "Get Well Soon Greeting", occasion: "Get Well Soon", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "sympathy-condolence", emoji: "🌹", name: "Sympathy / Condolence Greeting", occasion: "Sympathy / Condolence", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "retirement", emoji: "🎉", name: "Retirement Greeting", occasion: "Retirement", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "christmas", emoji: "🎄", name: "Christmas Greeting", occasion: "Christmas", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "new-year", emoji: "🎆", name: "New Year Greeting", occasion: "New Year", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "easter", emoji: "🐣", name: "Easter Greeting", occasion: "Easter", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "islamic-celebration", emoji: "🌙", name: "Islamic Celebration Greeting", occasion: "Islamic Celebration (Eid)", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "thanksgiving", emoji: "🦃", name: "Thanksgiving Greeting", occasion: "Thanksgiving", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "mothers-day", emoji: "🌸", name: "Mother's Day Greeting", occasion: "Mother's Day", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "fathers-day", emoji: "👔", name: "Father's Day Greeting", occasion: "Father's Day", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "valentines-day", emoji: "💖", name: "Valentine's Day Greeting", occasion: "Valentine's Day", masterVideo: "master.mp4", priceLabel: "Standard" },
  { id: "business", emoji: "💼", name: "Business Greeting", occasion: "Business Greeting", masterVideo: "master.mp4", priceLabel: "Premium" },
  { id: "grand-opening", emoji: "📢", name: "Grand Opening Greeting", occasion: "Grand Opening", masterVideo: "master.mp4", priceLabel: "Premium" },
  { id: "employee-appreciation", emoji: "🏆", name: "Employee Appreciation Greeting", occasion: "Employee Appreciation", masterVideo: "master.mp4", priceLabel: "Premium" },
  { id: "award-achievement", emoji: "🎖️", name: "Award & Achievement Greeting", occasion: "Award & Achievement", masterVideo: "master.mp4", priceLabel: "Premium" },
  { id: "cultural-festival", emoji: "🥁", name: "Cultural Festival Greeting", occasion: "Cultural Festival", masterVideo: "master.mp4", priceLabel: "Premium" }
];


const GREETING_TRANSLATIONS = {
  "birthday": { en: "Birthday", es: "Cumpleaños", fr: "Anniversaire", de: "Geburtstag", pt: "Aniversário", ar: "عيد الميلاد", zh: "生日" },
  "anniversary": { en: "Anniversary", es: "Aniversario", fr: "Anniversaire de mariage", de: "Jahrestag", pt: "Aniversário de casamento", ar: "ذكرى سنوية", zh: "纪念日" },
  "wedding": { en: "Wedding", es: "Boda", fr: "Mariage", de: "Hochzeit", pt: "Casamento", ar: "زفاف", zh: "婚礼" },
  "engagement": { en: "Engagement", es: "Compromiso", fr: "Fiançailles", de: "Verlobung", pt: "Noivado", ar: "خطوبة", zh: "订婚" },
  "new-baby": { en: "New Baby", es: "Nuevo bebé", fr: "Nouveau bébé", de: "Neues Baby", pt: "Novo bebê", ar: "مولود جديد", zh: "新生宝宝" },
  "baby-shower": { en: "Baby Shower", es: "Fiesta de bebé", fr: "Fête prénatale", de: "Babyparty", pt: "Chá de bebê", ar: "حفل استقبال المولود", zh: "迎婴派对" },
  "child-dedication": { en: "Child Dedication", es: "Dedicación infantil", fr: "Présentation de l’enfant", de: "Kindersegnung", pt: "Dedicação infantil", ar: "تكريس الطفل", zh: "儿童奉献礼" },
  "graduation": { en: "Graduation", es: "Graduación", fr: "Remise de diplôme", de: "Abschlussfeier", pt: "Formatura", ar: "تخرج", zh: "毕业" },
  "housewarming": { en: "Housewarming", es: "Inauguración de casa", fr: "Crémaillère", de: "Einweihung", pt: "Casa nova", ar: "منزل جديد", zh: "乔迁" },
  "new-job-promotion": { en: "New Job / Promotion", es: "Nuevo trabajo / Ascenso", fr: "Nouveau poste / Promotion", de: "Neuer Job / Beförderung", pt: "Novo emprego / Promoção", ar: "وظيفة جديدة / ترقية", zh: "新工作 / 晋升" },
  "congratulations": { en: "Congratulations", es: "Felicitaciones", fr: "Félicitations", de: "Herzlichen Glückwunsch", pt: "Parabéns", ar: "تهانينا", zh: "祝贺" },
  "get-well-soon": { en: "Get Well Soon", es: "Que te mejores pronto", fr: "Bon rétablissement", de: "Gute Besserung", pt: "Melhoras", ar: "الشفاء العاجل", zh: "早日康复" },
  "sympathy-condolence": { en: "Sympathy / Condolence", es: "Pésame / Condolencias", fr: "Soutien / Condoléances", de: "Mitgefühl / Beileid", pt: "Solidariedade / Condolências", ar: "تعاطف / تعزية", zh: "慰问 / 哀悼" },
  "retirement": { en: "Retirement", es: "Jubilación", fr: "Retraite", de: "Ruhestand", pt: "Aposentadoria", ar: "تقاعد", zh: "退休" },
  "christmas": { en: "Christmas", es: "Navidad", fr: "Noël", de: "Weihnachten", pt: "Natal", ar: "عيد الميلاد المجيد", zh: "圣诞节" },
  "new-year": { en: "New Year", es: "Año Nuevo", fr: "Nouvel An", de: "Neujahr", pt: "Ano Novo", ar: "رأس السنة", zh: "新年" },
  "easter": { en: "Easter", es: "Pascua", fr: "Pâques", de: "Ostern", pt: "Páscoa", ar: "عيد القيامة", zh: "复活节" },
  "islamic-celebration": { en: "Islamic Celebration (Eid)", es: "Celebración islámica (Eid)", fr: "Célébration islamique (Aïd)", de: "Islamisches Fest (Eid)", pt: "Celebração islâmica (Eid)", ar: "احتفال إسلامي (العيد)", zh: "伊斯兰节庆（开斋节）" },
  "thanksgiving": { en: "Thanksgiving", es: "Día de Acción de Gracias", fr: "Action de grâce", de: "Erntedankfest", pt: "Dia de Ação de Graças", ar: "عيد الشكر", zh: "感恩节" },
  "mothers-day": { en: "Mother's Day", es: "Día de la Madre", fr: "Fête des Mères", de: "Muttertag", pt: "Dia das Mães", ar: "عيد الأم", zh: "母亲节" },
  "fathers-day": { en: "Father's Day", es: "Día del Padre", fr: "Fête des Pères", de: "Vatertag", pt: "Dia dos Pais", ar: "عيد الأب", zh: "父亲节" },
  "valentines-day": { en: "Valentine's Day", es: "Día de San Valentín", fr: "Saint-Valentin", de: "Valentinstag", pt: "Dia dos Namorados", ar: "عيد الحب", zh: "情人节" },
  "business": { en: "Business Greeting", es: "Saludo empresarial", fr: "Vœux professionnels", de: "Geschäftsgruß", pt: "Saudação empresarial", ar: "تهنئة أعمال", zh: "商务祝福" },
  "grand-opening": { en: "Grand Opening", es: "Gran inauguración", fr: "Grande ouverture", de: "Große Eröffnung", pt: "Grande inauguração", ar: "الافتتاح الكبير", zh: "盛大开业" },
  "employee-appreciation": { en: "Employee Appreciation", es: "Reconocimiento al empleado", fr: "Reconnaissance des employés", de: "Mitarbeiteranerkennung", pt: "Reconhecimento do funcionário", ar: "تقدير الموظفين", zh: "员工表彰" },
  "award-achievement": { en: "Award & Achievement", es: "Premio y logro", fr: "Prix et réussite", de: "Auszeichnung & Leistung", pt: "Prêmio e conquista", ar: "جائزة وإنجاز", zh: "奖项与成就" },
  "cultural-festival": { en: "Cultural Festival", es: "Festival cultural", fr: "Festival culturel", de: "Kulturfestival", pt: "Festival cultural", ar: "مهرجان ثقافي", zh: "文化节" }
};

function getGreetingLocalizedOccasion(templateOrId, language = "en") {
  const lang = ["en", "es", "fr", "de", "pt", "ar", "zh"].includes(language) ? language : "en";
  const id = typeof templateOrId === "string"
    ? templateOrId
    : (templateOrId && templateOrId.id) || "birthday";
  const labels = GREETING_TRANSLATIONS[id] || {};
  const template = GREETING_TEMPLATES.find((item) => item.id === id);
  return labels[lang] || labels.en || (template ? template.occasion : "Greeting");
}

function getGreetingLocalizedDescription(templateOrId, language = "en") {
  const occasion = getGreetingLocalizedOccasion(templateOrId, language);
  return pickText(language, {
    en: `Create a personalized Printo video greeting for ${occasion}.`,
    es: `Crea un saludo de video Printo personalizado para ${occasion}.`,
    fr: `Créez un message vidéo Printo personnalisé pour ${occasion}.`,
    de: `Erstellen Sie einen persönlichen Printo-Videogruß für ${occasion}.`,
    pt: `Crie uma saudação em vídeo Printo personalizada para ${occasion}.`,
    ar: `أنشئ تهنئة فيديو Printo مخصصة بمناسبة ${occasion}.`,
    zh: `为${occasion}制作个性化 Printo 祝福视频。`
  });
}

function getGreetingTemplate(templateId = "birthday") {
  const id = String(templateId || "birthday").trim().toLowerCase();
  return GREETING_TEMPLATES.find((item) => item.id === id) || GREETING_TEMPLATES[0];
}

function greetingStudioMenuText(language = "en") {
  const headings = {
    en: ["🎬 Printo Greeting Studio", "Create personalized animated Printo video greeting cards.", "Choose the occasion:", "Reply with only the occasion number.", "You do NOT need to use | or /. The bot will ask one question at a time."],
    es: ["🎬 Estudio de Saludos Printo", "Crea tarjetas de video animadas personalizadas de Printo.", "Elige la ocasión:", "Responde solo con el número de la ocasión.", "No necesitas usar | ni /. El bot preguntará paso a paso."],
    fr: ["🎬 Studio de Vœux Printo", "Créez des cartes vidéo animées personnalisées avec Printo.", "Choisissez l'occasion :", "Répondez uniquement avec le numéro.", "Vous n'avez pas besoin d'utiliser | ou /. Le bot posera les questions une par une."],
    de: ["🎬 Printo Grußstudio", "Erstellen Sie personalisierte animierte Printo-Video-Grußkarten.", "Wählen Sie den Anlass:", "Antworten Sie nur mit der Nummer.", "Sie müssen | oder / nicht verwenden. Der Bot fragt Schritt für Schritt."],
    pt: ["🎬 Estúdio de Saudações Printo", "Crie cartões de vídeo animados personalizados com Printo.", "Escolha a ocasião:", "Responda apenas com o número.", "Você não precisa usar | ou /. O bot perguntará uma coisa de cada vez."],
    ar: ["🎬 استوديو تهاني Printo", "أنشئ بطاقات تهنئة فيديو متحركة ومخصصة مع Printo.", "اختر المناسبة:", "رد برقم المناسبة فقط.", "لا تحتاج إلى استخدام | أو /. سيطرح البوت سؤالاً واحدًا في كل مرة."],
    zh: ["🎬 Printo 祝福工作室", "创建个性化 Printo 动画视频贺卡。", "请选择场合：", "请只回复编号。", "不需要使用 | 或 /。机器人会一步一步询问。"]
  };
  const h = headings[language] || headings.en;
  const options = GREETING_TEMPLATES.map((item, index) => `${index + 1} - ${item.emoji} ${getGreetingLocalizedOccasion(item, language)}`).join("\n");
  return `${h[0]}\n\n${h[1]}\n\n${h[2]}\n${options}\n\n${h[3]}\n\n${h[4]}`;
}

function greetingQuestionText(language = "en", key = "recipient", spec = {}) {
  const occasion = getGreetingLocalizedOccasion(spec.templateId || "birthday", language) || spec.occasion || "Greeting";
  const questions = {
    recipient: {
      en: `✅ ${occasion} selected.

Who is receiving the greeting card?

Please type the recipient's name only.

Example: Mary`,
      es: `✅ ${occasion} seleccionado.

¿Quién recibirá la tarjeta?

Escriba solo el nombre del destinatario.

Ejemplo: Mary`,
      fr: `✅ ${occasion} sélectionné.

Qui reçoit la carte de vœux ?

Veuillez écrire uniquement le nom du destinataire.

Exemple : Mary`,
      de: `✅ ${occasion} ausgewählt.

Wer erhält die Grußkarte?

Bitte geben Sie nur den Namen des Empfängers ein.

Beispiel: Mary`,
      pt: `✅ ${occasion} selecionado.

Quem receberá o cartão?

Digite apenas o nome do destinatário.

Exemplo: Mary`,
      ar: `✅ تم اختيار ${occasion}.

من سيستلم بطاقة التهنئة؟

اكتب اسم المستلم فقط.

مثال: Mary`,
      zh: `✅ 已选择 ${occasion}。

谁会收到这张贺卡？

请只输入收件人姓名。

示例：Mary`
    },
    sender: {
      en: `Great. Who is sending the greeting?

Please type the sender's name only.

Example: John`,
      es: `Bien. ¿Quién envía la tarjeta?

Escriba solo el nombre del remitente.

Ejemplo: John`,
      fr: `Très bien. Qui envoie la carte ?

Veuillez écrire uniquement le nom de l'expéditeur.

Exemple : John`,
      de: `Gut. Wer sendet die Grußkarte?

Bitte geben Sie nur den Namen des Absenders ein.

Beispiel: John`,
      pt: `Ótimo. Quem está enviando o cartão?

Digite apenas o nome do remetente.

Exemplo: John`,
      ar: `جيد. من يرسل التهنئة؟

اكتب اسم المرسل فقط.

مثال: John`,
      zh: `很好。谁发送这张贺卡？

请只输入发送人姓名。

示例：John`
    },
    message: {
      en: `Perfect.

Please type the exact greeting message you want Printo to use.

Example:
Wishing you joy, good health, and many more happy years.`,
      es: `Perfecto.

Escriba el mensaje exacto que desea que Printo use.

Ejemplo:
Te deseo alegría, buena salud y muchos años felices más.`,
      fr: `Parfait.

Veuillez écrire le message exact que vous voulez que Printo utilise.

Exemple :
Je te souhaite joie, bonne santé et beaucoup d'années heureuses.`,
      de: `Perfekt.

Bitte schreiben Sie die genaue Nachricht, die Printo verwenden soll.

Beispiel:
Ich wünsche dir Freude, Gesundheit und viele glückliche Jahre.`,
      pt: `Perfeito.

Digite a mensagem exata que deseja que o Printo use.

Exemplo:
Desejo alegria, boa saúde e muitos anos felizes.`,
      ar: `ممتاز.

اكتب رسالة التهنئة بالضبط كما تريد أن يستخدمها Printo.

مثال:
أتمنى لك الفرح والصحة الجيدة والمزيد من السنوات السعيدة.`,
      zh: `很好。

请输入您希望 Printo 使用的准确祝福语。

示例：
祝你快乐、健康，并拥有更多幸福的岁月。`
    }
  };

  return pickText(language, questions[key] || questions.recipient);
}

function getGreetingOccasionFromInput(input = "") {
  const value = String(input || "").trim().toLowerCase();
  const aliases = {
    "birth day": "birthday", "xmas": "christmas", "eid": "islamic-celebration",
    "islamic celebration": "islamic-celebration", "islam celebration": "islamic-celebration",
    "new baby": "new-baby", "baby shower": "baby-shower", "child dedication": "child-dedication",
    "new year": "new-year", "new job": "new-job-promotion", "promotion": "new-job-promotion",
    "new job / promotion": "new-job-promotion", "get well": "get-well-soon", "get well soon": "get-well-soon",
    "sympathy": "sympathy-condolence", "condolence": "sympathy-condolence", "sympathy / condolence": "sympathy-condolence",
    "mother's day": "mothers-day", "mothers day": "mothers-day", "father's day": "fathers-day", "fathers day": "fathers-day",
    "valentine's day": "valentines-day", "valentines day": "valentines-day", "business greeting": "business",
    "grand opening": "grand-opening", "employee appreciation": "employee-appreciation",
    "award & achievement": "award-achievement", "award and achievement": "award-achievement",
    "cultural festival": "cultural-festival", "culture festival": "cultural-festival", "traditional festival": "cultural-festival"
  };

  let template = null;
  const number = Number.parseInt(value, 10);
  if (Number.isInteger(number) && number >= 1 && number <= GREETING_TEMPLATES.length) {
    template = GREETING_TEMPLATES[number - 1];
  } else {
    const normalizedId = aliases[value] || value.replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    template = GREETING_TEMPLATES.find((item) =>
      item.id === normalizedId ||
      item.occasion.toLowerCase() === value ||
      item.name.toLowerCase() === value
    );
  }

  if (!template) return null;
  return {
    occasion: template.occasion,
    templateId: template.id,
    packageType: template.priceLabel.toUpperCase() === "PREMIUM" ? "PREMIUM" : "STANDARD"
  };
}

function parseGreetingRequest(rawText = "") {
  const normalized = String(rawText || "")
    .replace(/\r?\n+/g, " | ")
    .replace(/[\/;,]+/g, " | ");

  const parts = normalized
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length >= 4) {
    return {
      occasion: parts[0],
      recipientName: parts[1],
      senderName: parts[2],
      message: parts.slice(3).join(" | ")
    };
  }

  return {
    occasion: "",
    recipientName: "",
    senderName: "",
    message: String(rawText || "").trim()
  };
}

function getGreetingVariantId(packageType = "STANDARD") {
  const type = String(packageType || "STANDARD").toUpperCase();
  if (type === "PREMIUM") return SHOPIFY_VARIANTS.GREETING_PREMIUM;
  return SHOPIFY_VARIANTS.GREETING_STANDARD;
}

function buildGreetingCheckoutUrl(packageType = "STANDARD", quantity = 1) {
  const variantId = getGreetingVariantId(packageType);
  return buildShopifyCartUrl(variantId, Math.max(1, parseInt(quantity, 10) || 1));
}

function buildGreetingDownloadUrl(req, fileName) {
  const base = getConfiguredPublicOrigin(req);

  return `${base}/generated/${encodeURIComponent(fileName)}`;
}

function escapeHtml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function createGreetingDownloadRecord(req, {
  templateId = "birthday",
  occasion = "Birthday",
  recipientName = "",
  senderName = "",
  message = "",
  language = "en"
} = {}) {
  const template = getGreetingTemplate(templateId || occasion);
  const greetingId = `PG-${Date.now()}`;
  const safeFileName = `${greetingId}_${safeBaseName(template.id)}.html`;
  const outputPath = path.join(generatedDir, safeFileName);

  const safeGreetingId = escapeHtml(greetingId);
  const safeOccasion = escapeHtml(occasion || template.occasion);
  const safeTemplate = escapeHtml(template.id);
  const safeRecipient = escapeHtml(recipientName);
  const safeSender = escapeHtml(senderName);
  const safeLanguage = escapeHtml(language || "en");
  const safeMessage = escapeHtml(message).replace(/\n/g, "<br />");
  const whatsappSupportUrl = `https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(
    `Hello Printo Studio, I need help with greeting order ${greetingId}.`
  )}`;

  const content = `<!doctype html>
<html lang="${safeLanguage}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Printo Greeting Order ${safeGreetingId}</title>
  <style>
    :root {
      --blue: #0b63ce;
      --dark: #05081d;
      --yellow: #ffd21f;
      --green: #25d366;
      --soft: #f3f7ff;
      --text: #172033;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: linear-gradient(135deg, var(--blue), #05265f);
      color: var(--text);
      min-height: 100vh;
      padding: 22px;
    }
    .page {
      max-width: 900px;
      margin: 0 auto;
    }
    .hero {
      background: var(--dark);
      color: white;
      border-radius: 28px;
      padding: 30px 22px;
      text-align: center;
      border: 3px solid var(--yellow);
      box-shadow: 0 20px 50px rgba(0,0,0,.25);
    }
    .brand-mark {
      width: 96px;
      height: 96px;
      border-radius: 24px;
      margin: 0 auto 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: radial-gradient(circle at top left, #24c6ff, #7f2cff 45%, #ff8b24 78%, #ffd21f);
      font-size: 56px;
      font-weight: 900;
      color: white;
      box-shadow: 0 0 28px rgba(255,210,31,.45);
    }
    h1 {
      margin: 0;
      font-size: 34px;
      line-height: 1.1;
    }
    .hero p {
      margin: 10px auto 0;
      max-width: 650px;
      color: #dbe8ff;
      font-size: 16px;
      line-height: 1.5;
    }
    .status-strip {
      margin-top: 18px;
      display: inline-flex;
      gap: 8px;
      align-items: center;
      background: var(--yellow);
      color: #111;
      padding: 10px 16px;
      border-radius: 999px;
      font-weight: 900;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
      margin-top: 22px;
    }
    .card {
      background: white;
      border-radius: 24px;
      padding: 22px;
      border: 2px solid rgba(255,210,31,.9);
      box-shadow: 0 14px 35px rgba(0,0,0,.16);
    }
    .card.full { grid-column: 1 / -1; }
    .label {
      color: #5d6b86;
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .06em;
      margin-bottom: 7px;
    }
    .value {
      font-size: 22px;
      font-weight: 900;
      color: var(--blue);
      word-break: break-word;
    }
    .message-box {
      background: var(--soft);
      border-left: 6px solid var(--yellow);
      border-radius: 16px;
      padding: 18px;
      font-size: 18px;
      line-height: 1.55;
      color: #172033;
    }
    .timeline {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-top: 12px;
    }
    .step {
      background: var(--soft);
      border-radius: 18px;
      padding: 14px;
      text-align: center;
      font-weight: 800;
      min-height: 92px;
    }
    .step .icon {
      font-size: 24px;
      display: block;
      margin-bottom: 8px;
    }
    .step.active {
      background: #fff6ca;
      border: 2px solid var(--yellow);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 18px;
    }
    .btn {
      appearance: none;
      border: none;
      border-radius: 16px;
      padding: 14px 18px;
      font-size: 16px;
      font-weight: 900;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
    }
    .btn.primary {
      background: var(--yellow);
      color: #111;
    }
    .btn.whatsapp {
      background: var(--green);
      color: white;
    }
    .btn.disabled {
      background: #d9e1ef;
      color: #66738d;
      cursor: not-allowed;
    }
    .footer {
      color: #eaf2ff;
      text-align: center;
      margin: 22px 0 8px;
      font-weight: 800;
    }
    @media (max-width: 720px) {
      body { padding: 14px; }
      h1 { font-size: 28px; }
      .grid { grid-template-columns: 1fr; }
      .timeline { grid-template-columns: 1fr 1fr; }
      .card { padding: 18px; }
      .value { font-size: 20px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div class="brand-mark">P</div>
      <h1>Greeting Order Received</h1>
      <p>Your Printo Greeting Studio order has been received. We are preparing your personalized greeting video details and payment confirmation.</p>
      <div class="status-strip">✅ Order Status: Received / Processing</div>
    </section>

    <section class="grid">
      <div class="card">
        <div class="label">Greeting ID</div>
        <div class="value">${safeGreetingId}</div>
      </div>

      <div class="card">
        <div class="label">Occasion</div>
        <div class="value">${safeOccasion}</div>
      </div>

      <div class="card">
        <div class="label">Recipient</div>
        <div class="value">${safeRecipient || "Not provided"}</div>
      </div>

      <div class="card">
        <div class="label">Sender</div>
        <div class="value">${safeSender || "Not provided"}</div>
      </div>

      <div class="card">
        <div class="label">Template</div>
        <div class="value">${safeTemplate}</div>
      </div>

      <div class="card">
        <div class="label">Language</div>
        <div class="value">${safeLanguage}</div>
      </div>

      <div class="card full">
        <div class="label">Greeting Message</div>
        <div class="message-box">${safeMessage || "No message provided yet."}</div>
      </div>

      <div class="card full">
        <div class="label">Order Progress</div>
        <div class="timeline">
          <div class="step"><span class="icon">✅</span>Order received</div>
          <div class="step active"><span class="icon">🔄</span>Preparing video</div>
          <div class="step"><span class="icon">⏳</span>Rendering MP4</div>
          <div class="step"><span class="icon">📥</span>Ready to download</div>
        </div>

        <div class="actions">
          <span class="btn disabled">⬇️ MP4 download activates when ready</span>
          <a class="btn whatsapp" href="${whatsappSupportUrl}">📲 Contact Printo on WhatsApp</a>
          <a class="btn primary" href="https://www.patapata.us/pages/africa-payment">💳 Africa Payment</a>
        </div>
      </div>

      <div class="card full">
        <div class="label">Next Step</div>
        <div class="message-box">
          Please complete payment and send your receipt on WhatsApp. After confirmation, the Printo team will continue the greeting video process. When automatic MP4 rendering is enabled and the master video template is ready, this order can be connected to the final video download.
        </div>
      </div>
    </section>

    <div class="footer">Powered by Patapata LLC • Printo Greeting Studio</div>
  </main>
</body>
</html>`;

  fs.writeFileSync(outputPath, content, "utf8");

  return {
    greetingId,
    template,
    fileName: safeFileName,
    downloadUrl: buildGreetingDownloadUrl(req, safeFileName)
  };
}

function getFfmpegPath() {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

function textForDrawtext(value = "") {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\n/g, " ")
    .slice(0, 180);
}

function wrapGreetingMessage(message = "", maxChars = 34, maxLines = 3) {
  const words = String(message || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines) break;
    } else {
      current = next;
    }
  }

  if (current && lines.length < maxLines) lines.push(current);
  return lines.join("\\n");
}

function buildGreetingVideoName(spec = {}) {
  const templateId = safeBaseName(spec.templateId || "birthday");
  const recipient = safeBaseName(spec.recipientName || "recipient").slice(0, 32);
  return `PG-${Date.now()}_${templateId}_${recipient}.mp4`;
}

function getGreetingTemplateDir(templateId = "birthday") {
  const template = getGreetingTemplate(templateId);
  return path.join(templatesDir, template.id);
}

function getGreetingTemplateAssets(templateId = "birthday") {
  const template = getGreetingTemplate(templateId);
  const templateDir = getGreetingTemplateDir(template.id);

  // New production location:
  // templates/birthday/frame.png
  // templates/birthday/printo.png
  // templates/birthday/master.mp4
  const framePath = path.join(templateDir, "frame.png");
  const printoPath = path.join(templateDir, "printo.png");
  const masterPath = path.join(templateDir, template.masterVideo || "master.mp4");

  // Backward compatibility with the older master-videos folder.
  const legacyMasterPath = path.join(masterVideosDir, template.masterVideo || "master.mp4");

  return {
    template,
    templateDir,
    framePath,
    printoPath,
    masterPath: fs.existsSync(masterPath) ? masterPath : legacyMasterPath,
    hasFrame: fs.existsSync(framePath),
    hasPrinto: fs.existsSync(printoPath),
    hasMaster: fs.existsSync(masterPath) || fs.existsSync(legacyMasterPath)
  };
}

function getGreetingVideoPlacement(templateId = "birthday") {
  // Frame currently used for birthday is 1536x1024.
  // These values place the Printo dance inside the central black video box.
  // They can be overridden later with environment variables without code changes.
  const id = String(templateId || "birthday").toLowerCase();

  if (id === "birthday") {
    return {
      width: Number(process.env.BIRTHDAY_VIDEO_W || 650),
      height: Number(process.env.BIRTHDAY_VIDEO_H || 420),
      x: Number(process.env.BIRTHDAY_VIDEO_X || 445),
      y: Number(process.env.BIRTHDAY_VIDEO_Y || 335),
      toX: Number(process.env.BIRTHDAY_TO_X || 145),
      toY: Number(process.env.BIRTHDAY_TO_Y || 285),
      fromX: Number(process.env.BIRTHDAY_FROM_X || 1225),
      fromY: Number(process.env.BIRTHDAY_FROM_Y || 310),
      messageX: Number(process.env.BIRTHDAY_MESSAGE_X || 110),
      messageY: Number(process.env.BIRTHDAY_MESSAGE_Y || 520)
    };
  }

  return {
    width: 650,
    height: 420,
    x: 445,
    y: 335,
    toX: 145,
    toY: 285,
    fromX: 1225,
    fromY: 310,
    messageX: 110,
    messageY: 520
  };
}

function buildGreetingDrawTextFilter(spec = {}, placement = {}) {
  const recipientName = textForDrawtext(spec.recipientName || "");
  const senderName = textForDrawtext(spec.senderName || "");
  const messageText = textForDrawtext(wrapGreetingMessage(spec.message || "", 25, 4));

  return [
    `drawtext=text='${recipientName}':x=${placement.toX}:y=${placement.toY}:fontsize=48:fontcolor=0xD83A8F:borderw=2:bordercolor=white`,
    `drawtext=text='${senderName}':x=${placement.fromX}:y=${placement.fromY}:fontsize=44:fontcolor=0x6B32C9:borderw=2:bordercolor=white`,
    `drawtext=text='${messageText}':x=${placement.messageX}:y=${placement.messageY}:fontsize=30:fontcolor=0x392081:borderw=1:bordercolor=white:line_spacing=9`
  ].join(",");
}

async function renderGreetingVideo(req, spec = {}) {
  const assets = getGreetingTemplateAssets(spec.templateId || spec.occasion || "birthday");
  const template = assets.template;

  if (!assets.hasMaster) {
    return {
      ok: false,
      reason: "missing_master_video",
      message: `Missing master video. Add master.mp4 inside templates/${template.id}/.`,
      template,
      assets
    };
  }

  const outputFileName = buildGreetingVideoName({ ...spec, templateId: template.id });
  const outputPath = path.join(generatedDir, outputFileName);

  // If frame.png exists, render the full Printo Greeting Studio card:
  // frame.png as background + master.mp4 placed into the center video window + text names.
  // If frame.png is missing, keep the older behavior and draw text directly on the video.
  if (assets.hasFrame) {
    const placement = getGreetingVideoPlacement(template.id);
    const drawTextFilter = buildGreetingDrawTextFilter(spec, placement);

    const filterComplex = [
      `[1:v]scale=${placement.width}:${placement.height}:force_original_aspect_ratio=decrease,pad=${placement.width}:${placement.height}:(ow-iw)/2:(oh-ih)/2:black[video]`,
      `[0:v][video]overlay=${placement.x}:${placement.y}:shortest=1[framed]`,
      `[framed]${drawTextFilter}[vout]`
    ].join(";");

    const args = [
      "-y",
      "-loop", "1",
      "-i", assets.framePath,
      "-i", assets.masterPath,
      "-filter_complex", filterComplex,
      "-map", "[vout]",
      "-map", "1:a?",
      "-shortest",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      outputPath
    ];

    await new Promise((resolve, reject) => {
      execFile(getFfmpegPath(), args, { timeout: 180000 }, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          return reject(error);
        }
        resolve();
      });
    });

    return {
      ok: true,
      template,
      fileName: outputFileName,
      downloadUrl: buildGreetingDownloadUrl(req, outputFileName),
      outputPath,
      usedFrame: true,
      assets
    };
  }

  const titleText = textForDrawtext(`Happy ${spec.occasion || template.occasion}, ${spec.recipientName || ""}!`);
  const messageText = textForDrawtext(wrapGreetingMessage(spec.message || ""));
  const senderText = textForDrawtext(`From ${spec.senderName || "Printo"}`);
  const brandText = textForDrawtext("Created with Printo Greeting Studio");

  const drawFilter = [
    `drawtext=text='${titleText}':x=(w-text_w)/2:y=h*0.16:fontsize=52:fontcolor=white:borderw=4:bordercolor=black`,
    `drawtext=text='${messageText}':x=(w-text_w)/2:y=h*0.34:fontsize=34:fontcolor=white:borderw=3:bordercolor=black:line_spacing=10`,
    `drawtext=text='${senderText}':x=(w-text_w)/2:y=h*0.62:fontsize=38:fontcolor=white:borderw=3:bordercolor=black`,
    `drawtext=text='${brandText}':x=(w-text_w)/2:y=h*0.88:fontsize=24:fontcolor=white:borderw=2:bordercolor=black`
  ].join(",");

  const args = [
    "-y",
    "-i", assets.masterPath,
    "-vf", drawFilter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level", "4.0",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputPath
  ];

  await new Promise((resolve, reject) => {
    execFile(getFfmpegPath(), args, { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve();
    });
  });

  return {
    ok: true,
    template,
    fileName: outputFileName,
    downloadUrl: buildGreetingDownloadUrl(req, outputFileName),
    outputPath,
    usedFrame: false,
    assets
  };
}

async function tryRenderGreetingVideoForWhatsApp(req, from, session, spec = {}) {
  try {
    const renderResult = await renderGreetingVideo(req, spec);

    if (!renderResult.ok) {
      return {
        ok: false,
        message: `

🎬 Video rendering is ready, but the master video is not uploaded yet.
${renderResult.message}

For now, use the Greeting Order Portal link:
${spec.downloadUrl || "Download link already created."}`
      };
    }

    session.greetingSpec = {
      ...(session.greetingSpec || {}),
      videoDownloadUrl: renderResult.downloadUrl,
      videoFileName: renderResult.fileName
    };

    if (session.lastServiceJobId) {
      await attachTextToExistingJob(
        session.lastServiceJobId,
        `Greeting Studio MP4 generated: ${renderResult.downloadUrl}`
      );
    }

    return {
      ok: true,
      message: `

🎉 Your personalized Printo greeting video is ready!

📥 Download MP4:
${renderResult.downloadUrl}

📱 You can share this video on WhatsApp, Facebook, Instagram, and TikTok.

Thank you for using Printo Greeting Studio.`
    };
  } catch (err) {
    console.error("Greeting MP4 render failed:", err.stderr || err.message);
    return {
      ok: false,
      message: `

⚠️ The greeting order was received, but automatic MP4 rendering could not complete yet. A Printo team member will continue it.

Greeting Order Portal:
${spec.downloadUrl || "Download link already created."}`
    };
  }
}

function greetingPaymentPromptText(spec = {}, language = "en") {
  const paymentLinks =
    spec.paymentLinks ||
    buildGreetingPaymentLinks({
      customerKey: spec.customerKey,
      templateId: spec.templateId || "birthday",
      contactPhone: spec.customerPhone || ""
    });

  return pickText(language, {
    en: `💳 Payment is required for this greeting.

Your first free Printo video greeting has already been used.

Occasion: ${spec.occasion || "Birthday"}
Recipient: ${spec.recipientName || ""}
Sender: ${spec.senderName || ""}

Choose a payment method:

1 - Shopify Payment
${paymentLinks.shopify}

2 - Africa Payment
${paymentLinks.africa}

3 - Continue with Agent

The next video will not be created until payment is confirmed.
After confirmation, return to Printo Studio and generate the greeting again.`,

    es: `💳 Se requiere pago para este saludo.

Ya utilizó su primer saludo de video Printo gratis.

Ocasión: ${spec.occasion || "Cumpleaños"}
Destinatario: ${spec.recipientName || ""}
Remitente: ${spec.senderName || ""}

Elija un método de pago:

1 - Pago Shopify
${paymentLinks.shopify}

2 - Pago África
${paymentLinks.africa}

3 - Continuar con un agente

El próximo video no se creará hasta que se confirme el pago.
Después de la confirmación, vuelva a Printo Studio y genere el saludo de nuevo.`,

    fr: `💳 Un paiement est requis pour ce message.

Votre première carte vidéo Printo gratuite a déjà été utilisée.

Occasion : ${spec.occasion || "Anniversaire"}
Destinataire : ${spec.recipientName || ""}
Expéditeur : ${spec.senderName || ""}

Choisissez un mode de paiement :

1 - Paiement Shopify
${paymentLinks.shopify}

2 - Paiement Afrique
${paymentLinks.africa}

3 - Continuer avec un agent

La prochaine vidéo ne sera pas créée avant confirmation du paiement.
Après confirmation, revenez à Printo Studio et générez à nouveau la carte.`,

    de: `💳 Für diesen Gruß ist eine Zahlung erforderlich.

Ihr erster kostenloser Printo-Videogruß wurde bereits verwendet.

Anlass: ${spec.occasion || "Geburtstag"}
Empfänger: ${spec.recipientName || ""}
Absender: ${spec.senderName || ""}

Wählen Sie eine Zahlungsmethode:

1 - Shopify-Zahlung
${paymentLinks.shopify}

2 - Afrika-Zahlung
${paymentLinks.africa}

3 - Mit einem Mitarbeiter fortfahren

Das nächste Video wird erst nach bestätigter Zahlung erstellt.
Kehren Sie danach zu Printo Studio zurück und erstellen Sie den Gruß erneut.`,

    pt: `💳 É necessário pagamento para esta saudação.

Sua primeira saudação de vídeo Printo gratuita já foi usada.

Ocasião: ${spec.occasion || "Aniversário"}
Destinatário: ${spec.recipientName || ""}
Remetente: ${spec.senderName || ""}

Escolha uma forma de pagamento:

1 - Pagamento Shopify
${paymentLinks.shopify}

2 - Pagamento África
${paymentLinks.africa}

3 - Continuar com um agente

O próximo vídeo não será criado até que o pagamento seja confirmado.
Depois da confirmação, volte ao Printo Studio e gere a saudação novamente.`,

    ar: `💳 يلزم الدفع لإنشاء هذه التهنئة.

لقد استخدمت أول بطاقة فيديو مجانية من Printo.

المناسبة: ${spec.occasion || "عيد الميلاد"}
المستلم: ${spec.recipientName || ""}
المرسل: ${spec.senderName || ""}

اختر طريقة الدفع:

1 - الدفع عبر Shopify
${paymentLinks.shopify}

2 - الدفع في أفريقيا
${paymentLinks.africa}

3 - المتابعة مع موظف

لن يتم إنشاء الفيديو التالي حتى يتم تأكيد الدفع.
بعد التأكيد، ارجع إلى استوديو Printo وأنشئ التهنئة مرة أخرى.`,

    zh: `💳 此贺卡需要付款。

您的第一张免费 Printo 视频贺卡已经使用。

场合：${spec.occasion || "生日"}
收件人：${spec.recipientName || ""}
发件人：${spec.senderName || ""}

请选择付款方式：

1 - Shopify 付款
${paymentLinks.shopify}

2 - 非洲付款
${paymentLinks.africa}

3 - 联系客服

付款确认前不会生成下一段视频。
确认后，请返回 Printo Studio 再次生成贺卡。`
  });
}

function isGreetingShopifyChoice(value = "") {
  const v = String(value || "").trim().toLowerCase();
  return v === "1" || v.includes("shopify");
}

function isGreetingAfricaChoice(value = "") {
  const v = String(value || "").trim().toLowerCase();
  return v === "2" || v.includes("africa") || v.includes("naira") || v.includes("₦");
}

function isGreetingAgentChoice(value = "") {
  const v = String(value || "").trim().toLowerCase();
  return v === "3" || v.includes("agent") || v.includes("person") || v.includes("human");
}

async function handleGreetingPaymentChoice({ req, from, text, session, spec = {} }) {
  const choice = String(text || "").trim();

  session.greetingSpec = {
    ...(session.greetingSpec || {}),
    ...(spec || {})
  };

  const finalSpec = session.greetingSpec || {};
  const paymentLinks =
    finalSpec.paymentLinks ||
    buildGreetingPaymentLinks({
      customerKey: finalSpec.customerKey,
      templateId: finalSpec.templateId || "birthday",
      contactPhone: from
    });

  finalSpec.paymentLinks = paymentLinks;
  session.greetingSpec = finalSpec;

  async function safeAttach(note) {
    try {
      if (session.lastServiceJobId) {
        await attachTextToExistingJob(session.lastServiceJobId, note);
      }
    } catch (err) {
      console.error("Greeting payment note attach skipped:", err.message);
    }
  }

  if (isGreetingShopifyChoice(choice)) {
    await safeAttach(
      `Greeting Studio payment required. Shopify selected. Customer key: ${finalSpec.customerKey || "not available"}`
    );

    session.stage = "GREETING_AWAITING_PAYMENT";
    session.selectedService = "GREETING_CARD";

    await sendMessage(
      from,
      `✅ Shopify Payment selected.

Complete payment here:
${paymentLinks.shopify}

Your greeting will remain locked until payment is confirmed.

After payment confirmation, return to Printo Studio and tap Generate again.

If you need help, reply here and a worker will assist you.`
    );

    return true;
  }

  if (isGreetingAfricaChoice(choice)) {
    await safeAttach(
      `Greeting Studio payment required. Africa Payment selected. Customer key: ${finalSpec.customerKey || "not available"}`
    );

    session.stage = "GREETING_AWAITING_PAYMENT";
    session.selectedService = "GREETING_CARD";

    await sendMessage(
      from,
      `✅ Africa Payment selected.

Complete payment here:
${paymentLinks.africa}

Send your payment receipt here on WhatsApp.

Your greeting will remain locked until a worker confirms the payment.
After confirmation, return to Printo Studio and tap Generate again.`
    );

    return true;
  }

  if (isGreetingAgentChoice(choice)) {
    await safeAttach(
      `Greeting Studio payment assistance requested. Customer key: ${finalSpec.customerKey || "not available"}`
    );

    session.stage = "GREETING_AWAITING_PAYMENT";
    session.selectedService = "GREETING_CARD";

    await sendMessage(
      from,
      `✅ A worker will help you with payment.

Your greeting will not be generated until payment is confirmed.

Customer reference:
${finalSpec.customerKey || "Not available"}

Please send your question or payment receipt here on WhatsApp.`
    );

    return true;
  }

  return false;
}

async function createGreetingDashboardJob({
  templateId,
  occasion,
  recipientName,
  senderName,
  message,
  language,
  customerName,
  customerEmail,
  customerPhone,
  checkoutUrl,
  downloadUrl,
  status = "pending",
  accessNote = ""
}) {
  const accessSection = accessNote ? `\n\n${accessNote}` : "";
  const instructions = `PRINTO GREETING STUDIO

Occasion: ${occasion}
Template: ${templateId}
Recipient: ${recipientName}
Sender: ${senderName}
Language: ${language || "en"}

Message:
${message}

Checkout:
${checkoutUrl || "Not configured"}

Download:
${downloadUrl || "Not generated yet"}${accessSection}`;

  try {
    const result = await pool.query(
      `
      INSERT INTO print_jobs (
        printer_id,
        queue_type,
        status,
        service_type,
        customer_name,
        customer_email,
        customer_phone,
        original_name,
        instructions,
        copies,
        pages,
        total_cost,
        created_at,
        updated_at
      )
      VALUES ($1, 'AGENT', $2, 'GREETING_CARD', $3, $4, $5, $6, $7, 1, 1, 0, NOW(), NOW())
      RETURNING *
      `,
      [
        process.env.AGENT_QUEUE_ID || "AGENT",
        status,
        customerName || senderName || "",
        customerEmail || "",
        customerPhone || "",
        `Printo Greeting - ${occasion}`,
        instructions
      ]
    );

    return result.rows[0] || null;
  } catch (err) {
    console.error("Greeting dashboard job insert skipped:", err.message);
    return null;
  }
}

app.get("/api/greeting-studio/health", (req, res) => {
  res.json({
    ok: true,
    service: "Printo Greeting Studio",
    status: "ready"
  });
});

app.get("/api/greeting-studio/templates", (req, res) => {
  res.json({
    ok: true,
    templates: GREETING_TEMPLATES
  });
});

app.get("/api/greeting-studio/assets/:templateId?", (req, res) => {
  const templateId = req.params.templateId || "birthday";
  const assets = getGreetingTemplateAssets(templateId);

  res.json({
    ok: true,
    template: assets.template,
    templateDir: assets.templateDir,
    assets: {
      frame: assets.hasFrame,
      printo: assets.hasPrinto,
      master: assets.hasMaster
    },
    expectedFiles: [
      `templates/${assets.template.id}/frame.png`,
      `templates/${assets.template.id}/printo.png`,
      `templates/${assets.template.id}/master.mp4`
    ]
  });
});


function isGreetingAdminAuthorized(req) {
  const expected =
    process.env.DASHBOARD_KEY ||
    process.env.SYSTEM_KEY ||
    process.env.WORKER_KEY ||
    "";

  const provided =
    req.headers["x-dashboard-key"] ||
    req.headers["x-worker-key"] ||
    req.query.key ||
    req.body?.dashboard_key ||
    "";

  return Boolean(expected && provided === expected);
}

app.post("/api/greeting/access/status", async (req, res) => {
  try {
    const identity = getGreetingCustomerIdentity(req, req.body || {});
    const status = await getGreetingAccessStatus(
      identity.customerKey,
      identity.contactPhone
    );
    const payment = buildGreetingPaymentLinks({
      customerKey: identity.customerKey,
      templateId: req.body?.templateId || "birthday",
      contactPhone: identity.contactPhone
    });

    return res.json({
      ok: true,
      identitySource: identity.identitySource,
      customerKey: identity.customerKey,
      freeAvailable: status.freeAvailable,
      freeUsed: status.freeUsed,
      freeCreditsGranted: status.freeCreditsGranted,
      paidCredits: status.paidCredits,
      creditBalance: status.creditBalance,
      creationCost: status.creationCost,
      remainingCreations: status.remainingCreations,
      totalGenerated: status.totalGenerated,
      paymentRequired: status.creditBalance < PRINTO_CREATION_CREDIT_COSTS.standard,
      creationCosts: PRINTO_CREATION_CREDIT_COSTS,
      remainingByService: status.remainingByService,
      payment
    });
  } catch (error) {
    console.error("Greeting access status error:", error);
    return res.status(500).json({
      ok: false,
      error: "Could not check greeting access."
    });
  }
});


function normalizePrintoAccountEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizePrintoPhone(value = "") {
  let digits = String(value || "").trim().replace(/[^0-9]+/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 8 || digits.length > 15) return "";
  return `+${digits}`;
}

function printoPhoneDigits(value = "") {
  return String(normalizePrintoPhone(value) || "").replace(/\D+/g, "");
}

function maskPrintoPhone(value = "") {
  const normalized = normalizePrintoPhone(value);
  if (!normalized) return "";
  const digits = normalized.slice(1);
  if (digits.length <= 6) return normalized;
  return `+${digits.slice(0, 3)}••••${digits.slice(-3)}`;
}

function validatePrintoPin(value = "") {
  return /^\d{4,8}$/.test(String(value || "").trim());
}

function hashPrintoPin(pin, salt) {
  return crypto.scryptSync(String(pin), String(salt), 64).toString("hex");
}

function safePinMatch(pin, salt, storedHash) {
  try {
    const actual = Buffer.from(hashPrintoPin(pin, salt), "hex");
    const expected = Buffer.from(String(storedHash || ""), "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function getPrintoWhatsAppAppSecret() {
  return String(
    process.env.META_APP_SECRET ||
    process.env.WHATSAPP_APP_SECRET ||
    process.env.FACEBOOK_APP_SECRET ||
    ""
  ).trim();
}

function verifyPrintoWhatsAppWebhookSignature(req) {
  const secret = getPrintoWhatsAppAppSecret();
  const provided = String(req.headers["x-hub-signature-256"] || "").trim();
  if (!secret || !provided || !req.rawBody) return false;

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex")}`;

  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hashPrintoPhoneChallenge(token = "") {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getPrintoRequestIpHash(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.ip || req.socket?.remoteAddress || "unknown";
  const salt =
    getPrintoWhatsAppAppSecret() ||
    String(process.env.DASHBOARD_KEY || process.env.SYSTEM_KEY || "printo-phone-verification");
  return crypto.createHmac("sha256", salt).update(String(ip)).digest("hex");
}

function makePrintoPhoneInternalEmail(phoneE164 = "") {
  const suffix = crypto.createHash("sha256").update(String(phoneE164)).digest("hex").slice(0, 40);
  return `phone-${suffix}@accounts.printo.local`;
}

app.post("/api/customer/account/phone/start", async (req, res) => {
  try {
    await ensurePrintoAccountTables();

    if (!getPrintoWhatsAppAppSecret()) {
      return res.status(503).json({
        ok: false,
        setupRequired: true,
        error: "Phone verification is being configured. Please try again shortly."
      });
    }

    const phone = normalizePrintoPhone(req.body?.phone);
    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Enter a valid phone number with country code, for example +1 862 230 6637."
      });
    }

    const existing = await queryWithRetry(
      `SELECT customer_key FROM greeting_customer_accounts WHERE phone_e164 = $1 LIMIT 1`,
      [phone]
    );
    if (existing.rows[0]) {
      return res.status(409).json({
        ok: false,
        accountExists: true,
        error: "An account already exists for this verified phone number. Please log in."
      });
    }

    const ipHash = getPrintoRequestIpHash(req);
    await queryWithRetry(`
      DELETE FROM greeting_phone_verification_challenges
      WHERE created_at < NOW() - INTERVAL '2 days'
    `);

    const limits = await queryWithRetry(
      `
      SELECT
        COUNT(*) FILTER (WHERE phone_e164 = $1 AND created_at > NOW() - INTERVAL '1 hour') AS phone_hour,
        MAX(created_at) FILTER (WHERE phone_e164 = $1) AS last_phone_request,
        COUNT(*) FILTER (WHERE request_ip_hash = $2 AND created_at > NOW() - INTERVAL '1 hour') AS ip_hour
      FROM greeting_phone_verification_challenges
      `,
      [phone, ipHash]
    );
    const limitRow = limits.rows[0] || {};
    const phoneHour = Number(limitRow.phone_hour || 0);
    const ipHour = Number(limitRow.ip_hour || 0);
    const lastPhoneRequest = limitRow.last_phone_request
      ? new Date(limitRow.last_phone_request).getTime()
      : 0;
    const secondsSinceLast = lastPhoneRequest
      ? Math.floor((Date.now() - lastPhoneRequest) / 1000)
      : 9999;

    if (secondsSinceLast < 60) {
      return res.status(429).json({
        ok: false,
        retryAfter: 60 - secondsSinceLast,
        error: `Please wait ${60 - secondsSinceLast} seconds before requesting another verification.`
      });
    }
    if (phoneHour >= 5 || ipHour >= 15) {
      return res.status(429).json({
        ok: false,
        error: "Too many verification attempts. Please wait one hour and try again."
      });
    }

    const challengeToken = crypto.randomBytes(24).toString("base64url");
    const challengeHash = hashPrintoPhoneChallenge(challengeToken);

    await queryWithRetry(
      `
      INSERT INTO greeting_phone_verification_challenges (
        challenge_hash, phone_e164, request_ip_hash, status,
        expires_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, 'pending', NOW() + INTERVAL '10 minutes', NOW(), NOW())
      `,
      [challengeHash, phone, ipHash]
    );

    const verificationMessage = `PRINTO VERIFY ${challengeToken}`;
    const whatsappUrl =
      `https://wa.me/${encodeURIComponent(String(SUPPORT_PHONE).replace(/\D+/g, ""))}` +
      `?text=${encodeURIComponent(verificationMessage)}`;

    return res.json({
      ok: true,
      challengeToken,
      whatsappUrl,
      maskedPhone: maskPrintoPhone(phone),
      expiresInSeconds: 600
    });
  } catch (error) {
    console.error("Printo phone verification start error:", error);
    return res.status(500).json({ ok: false, error: "Could not start phone verification." });
  }
});

app.post("/api/customer/account/phone/status", async (req, res) => {
  try {
    await ensurePrintoAccountTables();
    const token = String(req.body?.challengeToken || "").trim();
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) {
      return res.status(400).json({ ok: false, error: "Invalid verification session." });
    }

    const result = await queryWithRetry(
      `
      SELECT phone_e164, status, expires_at, confirmed_at, used_at
      FROM greeting_phone_verification_challenges
      WHERE challenge_hash = $1
      LIMIT 1
      `,
      [hashPrintoPhoneChallenge(token)]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(404).json({ ok: false, error: "Verification session not found." });
    }

    const expired = new Date(row.expires_at).getTime() <= Date.now();
    if (expired && row.status === "pending") {
      await queryWithRetry(
        `UPDATE greeting_phone_verification_challenges SET status = 'expired', updated_at = NOW() WHERE challenge_hash = $1`,
        [hashPrintoPhoneChallenge(token)]
      );
    }

    return res.json({
      ok: true,
      confirmed: !expired && row.status === "confirmed" && !row.used_at,
      used: Boolean(row.used_at) || row.status === "used",
      expired,
      maskedPhone: maskPrintoPhone(row.phone_e164)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Could not check phone verification." });
  }
});

app.post("/api/customer/account/register", async (req, res) => {
  let client;
  try {
    await ensurePrintoAccountTables();
    client = await pool.connect();
    const phone = normalizePrintoPhone(req.body?.phone);
    const pin = String(req.body?.pin || "").trim();
    const challengeToken = String(req.body?.challengeToken || "").trim();

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "Enter a valid phone number with country code."
      });
    }
    if (!validatePrintoPin(pin)) {
      return res.status(400).json({ ok: false, error: "PIN must contain 4 to 8 numbers." });
    }
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(challengeToken)) {
      return res.status(400).json({ ok: false, error: "Verify this phone number through WhatsApp first." });
    }

    const challengeHash = hashPrintoPhoneChallenge(challengeToken);
    await client.query("BEGIN");

    const challengeResult = await client.query(
      `
      SELECT phone_e164, status, expires_at, used_at
      FROM greeting_phone_verification_challenges
      WHERE challenge_hash = $1
      FOR UPDATE
      `,
      [challengeHash]
    );
    const challenge = challengeResult.rows[0];
    if (
      !challenge ||
      challenge.phone_e164 !== phone ||
      challenge.status !== "confirmed" ||
      challenge.used_at ||
      new Date(challenge.expires_at).getTime() <= Date.now()
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "Phone verification is incomplete or expired. Please verify again."
      });
    }

    const registryResult = await client.query(
      `SELECT phone_e164, customer_key, welcome_credits_granted
       FROM greeting_verified_phones
       WHERE phone_e164 = $1
       FOR UPDATE`,
      [phone]
    );
    const registry = registryResult.rows[0];
    if (!registry) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Phone verification could not be confirmed." });
    }

    const existing = await client.query(
      `SELECT customer_key FROM greeting_customer_accounts
       WHERE phone_e164 = $1 OR customer_key = $2
       LIMIT 1`,
      [phone, registry.customer_key]
    );
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        accountExists: true,
        error: "This verified phone number already has a Printo account. Please log in."
      });
    }

    const customerKey = registry.customer_key;
    const internalEmail = makePrintoPhoneInternalEmail(phone);
    const salt = crypto.randomBytes(16).toString("hex");
    const pinHash = hashPrintoPin(pin, salt);
    const welcomeAlreadyGranted = Boolean(registry.welcome_credits_granted);
    const welcomeCredits = welcomeAlreadyGranted ? 0 : PRINTO_FREE_CREDITS;

    await client.query(
      `
      INSERT INTO greeting_customer_accounts (
        email, customer_key, pin_salt, pin_hash,
        phone_e164, phone_verified_at, account_type,
        created_at, last_login_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), 'verified_phone', NOW(), NOW())
      `,
      [internalEmail, customerKey, salt, pinHash, phone]
    );

    await client.query(
      `
      INSERT INTO greeting_customer_access (
        customer_key, contact_phone, paid_credits,
        free_credits_granted, created_at, updated_at
      )
      VALUES ($1, $2, $3, TRUE, NOW(), NOW())
      ON CONFLICT (customer_key)
      DO UPDATE SET
        contact_phone = EXCLUDED.contact_phone,
        paid_credits = CASE
          WHEN $3 > 0 THEN GREATEST(greeting_customer_access.paid_credits, $3)
          ELSE greeting_customer_access.paid_credits
        END,
        free_credits_granted = TRUE,
        updated_at = NOW()
      `,
      [customerKey, printoPhoneDigits(phone), welcomeCredits]
    );

    await client.query(
      `
      UPDATE greeting_verified_phones
      SET welcome_credits_granted = TRUE,
          account_created_at = COALESCE(account_created_at, NOW()),
          updated_at = NOW()
      WHERE phone_e164 = $1
      `,
      [phone]
    );
    await client.query(
      `
      UPDATE greeting_phone_verification_challenges
      SET status = 'used', used_at = NOW(), updated_at = NOW()
      WHERE challenge_hash = $1
      `,
      [challengeHash]
    );

    await client.query("COMMIT");
    const status = await getGreetingAccessStatus(customerKey, printoPhoneDigits(phone));
    setPrintoAccountCookie(res, customerKey);
    return res.json({
      ok: true,
      phone,
      maskedPhone: maskPrintoPhone(phone),
      customerKey,
      customerId: phone,
      welcomeCreditsAdded: welcomeCredits,
      ...status
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Printo verified-phone registration error:", error);
    return res.status(500).json({ ok: false, error: "Could not create the phone-verified account." });
  } finally {
    if (client) client.release();
  }
});

app.post("/api/customer/account/login", async (req, res) => {
  try {
    await ensurePrintoAccountTables();
    const phone = normalizePrintoPhone(req.body?.phone);
    const legacyEmail = normalizePrintoAccountEmail(req.body?.email || req.body?.legacyEmail);
    const pin = String(req.body?.pin || "").trim();

    if (!validatePrintoPin(pin)) {
      return res.status(400).json({ ok: false, error: "Enter your phone number and 4–8 number PIN." });
    }

    let found;
    if (phone) {
      found = await queryWithRetry(
        `SELECT email, customer_key, pin_salt, pin_hash, phone_e164, account_type,
                failed_login_attempts, locked_until
         FROM greeting_customer_accounts
         WHERE phone_e164 = $1
         LIMIT 1`,
        [phone]
      );
    } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(legacyEmail)) {
      // Transition path only for accounts created before verified-phone signup.
      found = await queryWithRetry(
        `SELECT email, customer_key, pin_salt, pin_hash, phone_e164, account_type,
                failed_login_attempts, locked_until
         FROM greeting_customer_accounts
         WHERE email = $1
         LIMIT 1`,
        [legacyEmail]
      );
    } else {
      return res.status(400).json({
        ok: false,
        error: "Enter a valid phone number with country code and your PIN."
      });
    }

    const account = found.rows[0];
    if (account?.locked_until && new Date(account.locked_until).getTime() > Date.now()) {
      const minutes = Math.max(1, Math.ceil((new Date(account.locked_until).getTime() - Date.now()) / 60000));
      return res.status(429).json({
        ok: false,
        error: `Too many incorrect PIN attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`
      });
    }

    if (!account || !safePinMatch(pin, account.pin_salt, account.pin_hash)) {
      if (account) {
        await queryWithRetry(
          `
          UPDATE greeting_customer_accounts
          SET failed_login_attempts = failed_login_attempts + 1,
              last_failed_login_at = NOW(),
              locked_until = CASE
                WHEN failed_login_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes'
                ELSE locked_until
              END
          WHERE customer_key = $1
          `,
          [account.customer_key]
        );
      }
      return res.status(401).json({ ok: false, error: "Incorrect phone number or PIN." });
    }

    await queryWithRetry(
      `
      UPDATE greeting_customer_accounts
      SET last_login_at = NOW(),
          failed_login_attempts = 0,
          locked_until = NULL,
          last_failed_login_at = NULL
      WHERE customer_key = $1
      `,
      [account.customer_key]
    );

    const publicPhone = normalizePrintoPhone(account.phone_e164 || "");
    const status = await getGreetingAccessStatus(account.customer_key, printoPhoneDigits(publicPhone));
    setPrintoAccountCookie(res, account.customer_key);
    return res.json({
      ok: true,
      phone: publicPhone,
      maskedPhone: maskPrintoPhone(publicPhone),
      email: account.account_type === "legacy_email" ? account.email : "",
      customerKey: account.customer_key,
      customerId: publicPhone || account.email,
      legacyAccount: account.account_type === "legacy_email",
      ...status
    });
  } catch (error) {
    console.error("Printo account login error:", {
      message: error?.message || String(error),
      code: error?.code || "",
      detail: error?.detail || "",
      constraint: error?.constraint || ""
    });
    return res.status(500).json({
      ok: false,
      error: "Login service is temporarily unavailable. Please try again in a moment."
    });
  }
});

app.get("/api/customer/account/status", async (req, res) => {
  try {
    await ensurePrintoAccountTables();
    const identity = getGreetingCustomerIdentity(req, {});
    if (identity.identitySource !== "customer_key") {
      return res.status(401).json({ ok: false, loginRequired: true, error: "Please log in." });
    }
    const account = await queryWithRetry(
      `SELECT email, phone_e164, account_type
       FROM greeting_customer_accounts
       WHERE customer_key = $1
       LIMIT 1`,
      [identity.customerKey]
    );
    const row = account.rows[0];
    if (!row) {
      return res.status(401).json({ ok: false, loginRequired: true, error: "Please log in." });
    }
    const phone = normalizePrintoPhone(row.phone_e164 || "");
    const status = await getGreetingAccessStatus(identity.customerKey, printoPhoneDigits(phone));
    setPrintoAccountCookie(res, identity.customerKey);
    return res.json({
      ok: true,
      phone,
      maskedPhone: maskPrintoPhone(phone),
      email: row.account_type === "legacy_email" ? row.email : "",
      customerId: phone || row.email,
      legacyAccount: row.account_type === "legacy_email",
      customerKey: identity.customerKey,
      ...status
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Could not load the account." });
  }
});

async function requirePrintoAccountPage(req, res, next) {
  const returnTo = String(req.originalUrl || "/greetings");
  const loginUrl = `/customer-login?next=${encodeURIComponent(returnTo)}`;

  try {
    await ensurePrintoAccountTables();
    const customerKey = String(readPrintoCookie(req, "printo_customer_key") || "").trim();

    if (!/^g_[a-f0-9]{64}$/i.test(customerKey)) {
      return res.redirect(302, loginUrl);
    }

    const account = await queryWithRetry(
      `SELECT email, phone_e164, account_type
       FROM greeting_customer_accounts
       WHERE customer_key = $1
       LIMIT 1`,
      [customerKey]
    );

    if (!account.rows[0]) {
      return res.redirect(302, loginUrl);
    }

    req.printoAccount = {
      customerKey,
      phone: normalizePrintoPhone(account.rows[0].phone_e164 || ""),
      email: account.rows[0].account_type === "legacy_email" ? account.rows[0].email : ""
    };
    return next();
  } catch (error) {
    console.error("Printo protected page login check failed:", error);
    return res.redirect(302, loginUrl);
  }
}

app.get("/customer-login", (req, res) => {
  const next = String(req.query.next || "/greetings");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/greetings";
  return res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Printo Account</title><style>
*{box-sizing:border-box}body{margin:0;font-family:Arial;background:linear-gradient(160deg,#071b61,#0b63ce);min-height:100vh;color:#fff;padding:20px}
.wrap{max-width:590px;margin:28px auto}.head{text-align:center}.card{background:#fff;color:#102a72;border-radius:22px;padding:22px;box-shadow:0 18px 50px rgba(0,0,0,.35)}
.tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}.tabs button{border:0;border-radius:12px;padding:13px;font-weight:900;cursor:pointer}
.tabs .active{background:#123faa;color:#fff}.tabs button:not(.active){background:#e8efff;color:#123faa}
label{display:block;font-weight:900;margin:13px 0 7px}input{width:100%;padding:13px;border:2px solid #cbd5e1;border-radius:12px;font-size:17px}
.verifyBox{background:#edf7ff;border:2px solid #71b7ff;border-radius:14px;padding:14px;margin-top:14px}.verifyBtn{width:100%;border:0;border-radius:12px;padding:14px;background:#25D366;color:#073b1a;font-size:17px;font-weight:900;cursor:pointer}.verifyBtn:disabled{opacity:.6}
.submit{width:100%;margin-top:18px;border:0;border-radius:13px;padding:15px;background:linear-gradient(90deg,#7b2cbf,#d63384);color:#fff;font-size:18px;font-weight:900;cursor:pointer}.submit:disabled{opacity:.5;cursor:not-allowed}
.status{min-height:28px;text-align:center;margin-top:12px;font-weight:800;line-height:1.45}.note{background:#fff4b8;border:2px solid #ffd21f;border-radius:13px;padding:13px;line-height:1.5}.back{display:block;text-align:center;color:#ffd21f;font-weight:900;text-decoration:none;margin-top:16px}.small{font-size:13px;line-height:1.45;color:#475569}.legacy{margin-top:14px;text-align:center}.legacy button{border:0;background:transparent;color:#123faa;text-decoration:underline;font-weight:900;cursor:pointer}.hidden{display:none!important}.verified{color:#087a35}.error{color:#b42318}.waFallback{display:inline-block;margin-top:9px;font-weight:900;color:#123faa}
</style></head><body><main class="wrap"><div class="head"><h1>⭐ Printo Account</h1><p>Use one verified WhatsApp phone number for one Printo account.</p></div>
<div class="card"><div class="note">🎁 A verified phone number receives the 100 welcome credits only once. Invented email addresses can no longer create free-credit accounts.</div>
<div class="tabs"><button id="registerTab" class="active" type="button">Create Account</button><button id="loginTab" type="button">Log In</button></div>
<form id="accountForm"><input id="mode" type="hidden" value="register">
<div id="phoneGroup"><label>WhatsApp Phone Number</label><input id="phone" type="tel" autocomplete="tel" required placeholder="+1 862 230 6637"><div class="small">Include the country code. The number must be connected to WhatsApp.</div></div>
<div id="verifyBox" class="verifyBox"><button id="verifyBtn" class="verifyBtn" type="button">✅ Verify Number with WhatsApp</button><div id="verifyStatus" class="status">Tap the button, send the prepared message in WhatsApp, then return here.</div><a id="waFallback" class="waFallback hidden" target="_blank" rel="noopener">Open WhatsApp verification</a></div>
<div id="legacyGroup" class="hidden"><label>Existing Email Address</label><input id="legacyEmail" type="email" autocomplete="email"><div class="small">Only for an account created before phone verification was introduced.</div></div>
<label>PIN Number</label><input id="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" autocomplete="current-password" required placeholder="4–8 numbers">
<button id="submit" class="submit" type="submit" disabled>Create Account & Receive 100 Credits</button><div id="status" class="status"></div></form>
<div id="legacyLink" class="legacy hidden"><button id="legacyToggle" type="button">Existing old email account? Log in here</button></div></div>
<a class="back" href="/greetings">← Return to Printo Studio</a></main>
<script>
const next=${JSON.stringify(safeNext)};
const form=document.getElementById('accountForm'),mode=document.getElementById('mode'),submit=document.getElementById('submit'),statusBox=document.getElementById('status'),registerTab=document.getElementById('registerTab'),loginTab=document.getElementById('loginTab'),phoneInput=document.getElementById('phone'),pinInput=document.getElementById('pin'),verifyBox=document.getElementById('verifyBox'),verifyBtn=document.getElementById('verifyBtn'),verifyStatus=document.getElementById('verifyStatus'),waFallback=document.getElementById('waFallback'),legacyLink=document.getElementById('legacyLink'),legacyToggle=document.getElementById('legacyToggle'),legacyGroup=document.getElementById('legacyGroup'),legacyEmail=document.getElementById('legacyEmail');
let challengeToken='',verifiedPhone='',pollTimer=null,legacyMode=false;
function stopPolling(){if(pollTimer){clearInterval(pollTimer);pollTimer=null;}}
function resetVerification(){stopPolling();challengeToken='';verifiedPhone='';verifyBtn.disabled=false;verifyStatus.className='status';verifyStatus.textContent='Tap the button, send the prepared message in WhatsApp, then return here.';waFallback.classList.add('hidden');waFallback.removeAttribute('href');if(mode.value==='register')submit.disabled=true;}
function selectMode(value){mode.value=value;registerTab.classList.toggle('active',value==='register');loginTab.classList.toggle('active',value==='login');verifyBox.classList.toggle('hidden',value!=='register');legacyLink.classList.toggle('hidden',value!=='login');legacyGroup.classList.add('hidden');legacyMode=false;legacyToggle.textContent='Existing old email account? Log in here';phoneInput.required=true;legacyEmail.required=false;submit.textContent=value==='register'?'Create Account & Receive 100 Credits':'Log In to My Account';submit.disabled=value==='register';statusBox.textContent='';resetVerification();}
registerTab.onclick=()=>selectMode('register');loginTab.onclick=()=>selectMode('login');
legacyToggle.onclick=()=>{legacyMode=!legacyMode;legacyGroup.classList.toggle('hidden',!legacyMode);document.getElementById('phoneGroup').classList.toggle('hidden',legacyMode);legacyEmail.required=legacyMode;phoneInput.required=!legacyMode;legacyToggle.textContent=legacyMode?'Use phone-number login instead':'Existing old email account? Log in here';};
phoneInput.addEventListener('input',()=>{if(phoneInput.value!==verifiedPhone)resetVerification();});
async function pollVerification(){if(!challengeToken)return;try{const response=await fetch('/api/customer/account/phone/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challengeToken})});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Could not check verification.');if(data.confirmed){stopPolling();verifiedPhone=phoneInput.value;verifyStatus.className='status verified';verifyStatus.textContent='✅ Phone number verified. Choose your PIN and create the account.';verifyBtn.disabled=true;submit.disabled=false;}else if(data.expired||data.used){stopPolling();verifyStatus.className='status error';verifyStatus.textContent='❌ Verification expired. Tap Verify Number with WhatsApp again.';verifyBtn.disabled=false;submit.disabled=true;}}catch(_){}}
verifyBtn.onclick=async()=>{resetVerification();verifyBtn.disabled=true;verifyStatus.textContent='Preparing WhatsApp verification...';let popup=null;try{popup=window.open('about:blank','_blank');const response=await fetch('/api/customer/account/phone/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:phoneInput.value})});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Could not start verification.');challengeToken=String(data.challengeToken||'');waFallback.href=data.whatsappUrl;waFallback.classList.remove('hidden');verifyStatus.textContent='WhatsApp is opening. Send the prepared PRINTO VERIFY message, then return to this page.';if(popup)popup.location=data.whatsappUrl;else window.location.href=data.whatsappUrl;pollTimer=setInterval(pollVerification,2000);pollVerification();}catch(error){if(popup)popup.close();verifyStatus.className='status error';verifyStatus.textContent='❌ '+error.message;verifyBtn.disabled=false;}};
form.addEventListener('submit',async(e)=>{e.preventDefault();if(mode.value==='register'&&!challengeToken){statusBox.textContent='❌ Verify your WhatsApp phone number first.';return;}submit.disabled=true;statusBox.textContent=mode.value==='register'?'Creating your verified account...':'Logging in...';try{const payload={pin:pinInput.value};if(mode.value==='register'){payload.phone=phoneInput.value;payload.challengeToken=challengeToken;}else if(legacyMode){payload.email=legacyEmail.value;}else{payload.phone=phoneInput.value;}const response=await fetch('/api/customer/account/'+mode.value,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Account request failed');localStorage.setItem('printoGreetingCustomerKey',String(data.customerKey));localStorage.setItem('printoGreetingCustomerId',String(data.customerId||data.phone||data.email||''));if(data.phone)localStorage.setItem('printoGreetingCustomerPhone',String(data.phone));else localStorage.removeItem('printoGreetingCustomerPhone');if(data.email)localStorage.setItem('printoGreetingCustomerEmail',String(data.email));else localStorage.removeItem('printoGreetingCustomerEmail');statusBox.className='status verified';statusBox.textContent='✅ Success. Opening Printo Studio...';window.location.href=next;}catch(error){statusBox.className='status error';statusBox.textContent='❌ '+error.message;}finally{if(mode.value==='login'||verifiedPhone)submit.disabled=false;}});
</script></body></html>`);
});

app.get("/api/credits/:customerId", async (req, res) => {
  try {
    const identity = getGreetingCustomerIdentity(req, {
      customerId: req.params.customerId,
      customerPhone: req.query.phone || "",
      email: req.query.email || ""
    });
    const status = await getGreetingAccessStatus(identity.customerKey, identity.contactPhone);
    return res.json({ ok: true, ...status });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Could not load credits." });
  }
});

app.post("/api/credits/use", async (req, res) => {
  try {
    const identity = getGreetingCustomerIdentity(req, req.body || {});
    const creationType = normalizePrintoCreationType(req.body?.creationType || req.body?.serviceType || "standard");
    const reservation = await reserveGreetingGenerationAccess(identity.customerKey, identity.contactPhone, creationType);
    return res.status(reservation.allowed ? 200 : 402).json({
      ok: reservation.allowed,
      paymentRequired: !reservation.allowed,
      creationType,
      creationCost: getPrintoCreationCreditCost(creationType),
      ...reservation
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "Could not use credits." });
  }
});

app.post("/api/greeting/payment/approve", async (req, res) => {
  try {
    if (!isGreetingAdminAuthorized(req)) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const body = req.body || {};
    const providedCustomerKey = String(
      body.customerKey || body.customer_key || ""
    ).trim();
    const hasExplicitIdentity = Boolean(
      providedCustomerKey ||
      body.customerId ||
      body.customer_id ||
      body.deviceId ||
      body.device_id ||
      body.customerPhone ||
      body.customer_phone ||
      body.phone ||
      body.whatsapp ||
      body.email
    );

    if (!hasExplicitIdentity) {
      return res.status(400).json({
        ok: false,
        error: "customerKey, customerId, customerPhone, or email is required."
      });
    }

    const identity = providedCustomerKey
      ? {
          customerKey: providedCustomerKey,
          contactPhone: String(
            body.customerPhone ||
            body.customer_phone ||
            body.phone ||
            ""
          ).replace(/\D+/g, "")
        }
      : getGreetingCustomerIdentity(req, body);

    const result = await grantGreetingPaidCredits({
      customerKey: identity.customerKey,
      contactPhone: identity.contactPhone,
      credits: body.credits || PRINTO_CREATION_CREDIT_COST,
      provider: body.provider || "manual",
      eventKey:
        body.reference ||
        body.eventKey ||
        body.event_key ||
        `manual:${identity.customerKey}:${Date.now()}`,
      payload: body
    });

    if (identity.contactPhone) {
      await sendMessage(
        identity.contactPhone,
        `✅ Your Printo Greeting Studio payment has been confirmed.

You now have ${result.status?.paidCredits ?? PRINTO_CREATION_CREDIT_COST} Printo credits.

Each creation uses ${PRINTO_CREATION_CREDIT_COST} credits.

Return to Printo Studio and tap Generate to create your next greeting:
${buildBrandedPrintoStudioUrl("en")}`
      );
    }

    return res.json({
      ok: true,
      customerKey: identity.customerKey,
      result
    });
  } catch (error) {
    console.error("Greeting payment approval error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Could not approve greeting payment."
    });
  }
});

app.post("/api/greeting/premium/payment/approve", async (req, res) => {
  try {
    if (!isGreetingAdminAuthorized(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const orderId = String(
      req.body?.orderId || req.body?.order_id || req.body?.premiumOrderId || ""
    ).trim();
    if (!orderId) {
      return res.status(400).json({
        ok: false,
        error: "Premium order ID is required."
      });
    }

    const result = await markPremiumOrderPaid({
      orderId,
      provider: req.body?.provider || "africa_manual",
      paymentReference:
        req.body?.reference || req.body?.paymentReference || `manual:${orderId}:${Date.now()}`,
      payload: req.body || {}
    });

    if (result.missing) {
      return res.status(404).json({ ok: false, error: "Premium order not found." });
    }

    const order = result.order || {};
    if (order.contact_phone && !result.duplicate) {
      await sendMessage(
        order.contact_phone,
        `✅ Your Printo Premium Tribute payment has been confirmed.\n\nOrder: ${orderId}\n\nA Printo worker will review your photo, introduction video, message, and tribute-song details and contact you here on WhatsApp.`
      );
    }

    return res.json({ ok: true, orderId, result });
  } catch (error) {
    console.error("Premium payment approval error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Could not approve premium payment."
    });
  }
});

app.post("/webhooks/shopify/orders-paid", async (req, res) => {
  const webhookMeta = {
    webhookId: String(req.headers["x-shopify-webhook-id"] || "unknown"),
    topic: String(req.headers["x-shopify-topic"] || "orders/paid"),
    shopDomain: String(req.headers["x-shopify-shop-domain"] || "unknown"),
    apiVersion: String(req.headers["x-shopify-api-version"] || "unknown"),
    hasSignature: Boolean(req.headers["x-shopify-hmac-sha256"]),
    hasRawBody: Boolean(req.rawBody && req.rawBody.length)
  };

  console.log("Shopify orders-paid webhook received", webhookMeta);

  try {
    if (!verifyShopifyWebhookSignature(req)) {
      console.error("Shopify webhook signature verification failed", webhookMeta);
      return res.status(401).send("Invalid Shopify webhook signature.");
    }

    console.log("Shopify webhook signature verified", webhookMeta);

    const order = req.body || {};
    const financialStatus = String(order.financial_status || "").toLowerCase();
    const orderReference =
      order.id ||
      order.admin_graphql_api_id ||
      order.order_number ||
      order.name ||
      "unknown";

    if (!["paid", "partially_paid"].includes(financialStatus)) {
      console.log("Shopify order-payment webhook ignored: order is not paid", {
        ...webhookMeta,
        orderReference,
        financialStatus: financialStatus || "missing"
      });

      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Order is not paid."
      });
    }

    const greetingPackage = String(
      getShopifyNoteAttribute(order, [
        "Greeting Package",
        "greeting_package",
        "Printo Greeting Package"
      ]) || order.greeting_package || ""
    ).trim().toUpperCase();

    const premiumOrderId = String(
      getShopifyNoteAttribute(order, [
        "Premium Order ID",
        "premium_order_id",
        "Printo Premium Order ID"
      ]) || order.premium_order_id || ""
    ).trim();

    if (premiumOrderId || greetingPackage === "GREETING_PREMIUM") {
      if (!premiumOrderId) {
        console.log("Premium Shopify order ignored: premium order ID missing", {
          ...webhookMeta,
          orderReference
        });
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "Premium order ID is missing."
        });
      }

      const premiumResult = await markPremiumOrderPaid({
        orderId: premiumOrderId,
        provider: "shopify",
        paymentReference: String(order.name || order.order_number || orderReference),
        shopifyOrderId: String(orderReference),
        payload: order
      });

      if (premiumResult.missing) {
        console.log("Premium Shopify payment ignored: order record not found", {
          ...webhookMeta,
          orderReference,
          premiumOrderId
        });
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "Premium order record not found."
        });
      }

      const premiumOrder = premiumResult.order || {};
      if (premiumOrder.contact_phone && !premiumResult.duplicate) {
        await sendMessage(
          premiumOrder.contact_phone,
          `✅ Shopify payment confirmed for your Printo Premium Tribute.\n\nOrder: ${premiumOrderId}\n\nA Printo worker will review your uploaded photo, introduction video, personal message, and tribute-song details and contact you here on WhatsApp.`
        );
      }

      console.log("Premium Shopify payment confirmed", {
        ...webhookMeta,
        orderReference,
        premiumOrderId,
        duplicate: Boolean(premiumResult.duplicate)
      });

      return res.status(200).json({
        ok: true,
        premium: true,
        orderId: premiumOrderId,
        duplicate: Boolean(premiumResult.duplicate)
      });
    }

    const membershipPurchase = detectPrintoMembershipPurchase(order);
    if (membershipPurchase) {
      const membershipEmail = String(order.email || order.customer?.email || "").trim().toLowerCase();
      const membershipCustomerKey =
        getShopifyNoteAttribute(order, [
          "Greeting Customer Key",
          "greeting_customer_key",
          "Printo Greeting Customer Key"
        ]) ||
        String(order.greeting_customer_key || "").trim() ||
        (membershipEmail ? makeGreetingCustomerKey(`email:${membershipEmail}`) : "");

      if (!membershipCustomerKey) {
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "Membership customer identity is missing."
        });
      }

      const membershipPhone = String(order.phone || order.customer?.phone || "").replace(/\D+/g, "");
      const membershipResult = await activatePrintoMembership({
        customerKey: membershipCustomerKey,
        contactPhone: membershipPhone,
        plan: membershipPurchase.plan,
        termMonths: membershipPurchase.termMonths,
        orderReference: String(orderReference),
        payload: order
      });

      if (membershipPhone && !membershipResult.duplicate) {
        await sendMessage(
          membershipPhone,
          `✅ Your Printo ${membershipPurchase.plan.replace("_", " ")} membership is active.\n\n100 universal Printo credits have been added now. Another 100 credits will be released each month while the membership term remains active.\n\n${PRINTO_STUDIO_URL}`
        );
      }

      return res.status(200).json({
        ok: true,
        membership: true,
        customerKey: membershipCustomerKey,
        result: membershipResult
      });
    }

    const customerKey =
      getShopifyNoteAttribute(order, [
        "Greeting Customer Key",
        "greeting_customer_key",
        "Printo Greeting Customer Key"
      ]) ||
      String(order.greeting_customer_key || "").trim();

    const contactPhone =
      getShopifyNoteAttribute(order, [
        "Greeting Phone",
        "greeting_phone",
        "Printo Greeting Phone"
      ]) ||
      String(order.phone || order.customer?.phone || "").replace(/\D+/g, "");

    const standardGreetingQuantity = getStandardGreetingShopifyQuantity(order);

    if (!customerKey) {
      console.log(
        "Shopify test/order ignored: no greeting customer key was attached",
        {
          ...webhookMeta,
          orderReference,
          financialStatus,
          orderName: String(order.name || "")
        }
      );

      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "No greeting customer key was attached to the order."
      });
    }

    if (standardGreetingQuantity < 1) {
      console.log("Shopify paid order ignored: no Standard Printo greeting product was found", {
        ...webhookMeta,
        orderReference,
        orderName: String(order.name || "")
      });
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "No Standard Printo greeting product was found."
      });
    }

    // The paid credit amount is derived only from the verified Shopify product
    // quantity. A buyer cannot increase credits by editing URL parameters.
    const requestedCredits =
      PRINTO_STANDARD_SINGLE_PURCHASE_CREDITS * standardGreetingQuantity;

    const result = await grantGreetingPaidCredits({
      customerKey,
      contactPhone,
      credits: requestedCredits,
      provider: "shopify",
      eventKey: `shopify:${orderReference}`,
      payload: order
    });

    console.log(
      result.duplicate
        ? "Shopify greeting payment already processed; duplicate ignored"
        : "Shopify greeting credit added successfully",
      {
        ...webhookMeta,
        orderReference,
        credits: requestedCredits,
        duplicate: Boolean(result.duplicate),
        customerKeySuffix: String(customerKey).slice(-8)
      }
    );

    if (contactPhone && !result.duplicate) {
      await sendMessage(
        contactPhone,
        `✅ Shopify payment confirmed.

${requestedCredits} Printo credits have been added to your account.

Return to Printo Studio and tap Generate:
${buildBrandedPrintoStudioUrl("en")}`
      );
    }

    return res.status(200).json({
      ok: true,
      customerKey,
      result
    });
  } catch (error) {
    console.error("Shopify greeting payment webhook error", {
      ...webhookMeta,
      message: error?.message || String(error),
      stack: error?.stack || ""
    });

    return res.status(500).json({
      ok: false,
      error: "Greeting payment webhook failed."
    });
  }
});

app.post("/api/greeting-studio/create", async (req, res) => {
  try {
    const {
      templateId = "birthday",
      occasion,
      recipientName,
      senderName,
      message,
      language = "en",
      customerName = "",
      customerEmail = "",
      customerPhone = "",
      packageType = "STANDARD"
    } = req.body || {};

    if (!recipientName || !senderName || !message) {
      return res.status(400).json({
        ok: false,
        error: "Missing recipientName, senderName, or message."
      });
    }

    const customerIdentity = getGreetingCustomerIdentity(req, req.body || {});
    if (customerIdentity.identitySource !== "customer_key") {
      return res.status(401).json({
        ok: false,
        loginRequired: true,
        error: "Please log in to your Printo account before opening a greeting order."
      });
    }
    const registeredAccount = await queryWithRetry(
      `SELECT email, phone_e164 FROM greeting_customer_accounts WHERE customer_key = $1 LIMIT 1`,
      [customerIdentity.customerKey]
    );
    if (!registeredAccount.rows[0]) {
      return res.status(401).json({
        ok: false,
        loginRequired: true,
        error: "Your Printo login has expired. Please log in again."
      });
    }

    const template = getGreetingTemplate(templateId || occasion);
    const greetingId = `PG-${Date.now()}`;
    const checkoutUrl = buildGreetingCheckoutUrl(packageType, 1);

    const job = await createGreetingDashboardJob({
      templateId: template.id,
      occasion: occasion || template.occasion,
      recipientName,
      senderName,
      message,
      language,
      customerName,
      customerEmail,
      customerPhone,
      checkoutUrl,
      status: "pending"
    });

    res.json({
      ok: true,
      greetingId,
      job_id: job?.id || null,
      service_type: "GREETING_CARD",
      template,
      occasion: occasion || template.occasion,
      recipientName,
      senderName,
      message,
      language,
      packageType,
      checkoutUrl,
      africaPaymentUrl: "https://www.patapata.us/pages/africa-payment",
      status: "created",
      next_step: "payment"
    });
  } catch (err) {
    console.error("Greeting Studio create error:", err);
    res.status(500).json({
      ok: false,
      error: "Failed to create greeting request."
    });
  }
});

app.post("/api/greeting-studio/render", async (req, res) => {
  let accessReservation = null;
  let customerIdentity = null;
  let birthdayJobId = "";
  let birthdayResponseSent = false;

  try {
    const {
      templateId = "birthday",
      occasion,
      recipientName,
      senderName,
      message,
      language = "en",
      customerEmail = "",
      customerPhone = ""
    } = req.body || {};

    if (!recipientName || !senderName || !message) {
      return res.status(400).json({
        ok: false,
        error: "Missing recipientName, senderName, or message."
      });
    }

    customerIdentity = getGreetingCustomerIdentity(req, req.body || {});
    if (customerIdentity.identitySource !== "customer_key") {
      return res.status(401).json({
        ok: false,
        loginRequired: true,
        error: "Please log in to your Printo account before generating."
      });
    }
    const registeredAccount = await queryWithRetry(
      `SELECT email FROM greeting_customer_accounts WHERE customer_key = $1 LIMIT 1`,
      [customerIdentity.customerKey]
    );
    if (!registeredAccount.rows[0]) {
      return res.status(401).json({
        ok: false,
        loginRequired: true,
        error: "Your Printo login has expired. Please log in again."
      });
    }
    await ensureGreetingAccessTables();

    accessReservation = await reserveGreetingGenerationAccess(
      customerIdentity.customerKey,
      customerPhone || customerIdentity.contactPhone
    );

    if (!accessReservation.allowed) {
      const payment = buildGreetingPaymentLinks({
        customerKey: customerIdentity.customerKey,
        templateId,
        contactPhone: customerPhone || customerIdentity.contactPhone
      });

      const paymentJob = await createGreetingDashboardJob({
        templateId,
        occasion: occasion || templateId,
        recipientName,
        senderName,
        message,
        language,
        customerEmail,
        customerPhone: customerPhone || customerIdentity.contactPhone,
        checkoutUrl: payment.shopify,
        downloadUrl: "",
        status: "pending",
        accessNote: `PAYMENT REQUIRED BEFORE GENERATION

Customer key: ${customerIdentity.customerKey}
Identity source: ${customerIdentity.identitySource}
Shopify: ${payment.shopify}
Africa Payment: ${payment.africa}`
      });

      return res.status(402).json({
        ok: false,
        paymentRequired: true,
        error:
          "You need 20 credits to create another greeting. Buy more credits, then try again.",
        customerKey: customerIdentity.customerKey,
        identitySource: customerIdentity.identitySource,
        job_id: paymentJob?.id || null,
        access: accessReservation,
        payment
      });
    }

    const template = getGreetingTemplate(templateId || occasion);
    const record = createGreetingDownloadRecord(req, {
      templateId: template.id,
      occasion: occasion || template.occasion,
      recipientName,
      senderName,
      message,
      language
    });

    const renderResult = await renderGreetingVideo(req, {
      templateId: template.id,
      occasion: occasion || template.occasion,
      recipientName,
      senderName,
      message,
      language,
      downloadUrl: record.downloadUrl
    });

    if (!renderResult.ok) {
      await refundGreetingGenerationAccess(
        customerIdentity.customerKey,
        accessReservation.source
      );

      accessReservation = null;
    }

    const job = await createGreetingDashboardJob({
      templateId: template.id,
      occasion: occasion || template.occasion,
      recipientName,
      senderName,
      message,
      language,
      customerEmail,
      customerPhone,
      downloadUrl: renderResult.ok ? renderResult.downloadUrl : record.downloadUrl,
      status: renderResult.ok ? "completed" : "pending"
    });

    return res.json({
      ok: true,
      greetingId: record.greetingId,
      job_id: job?.id || null,
      status: renderResult.ok ? "mp4_rendered" : "record_created_master_missing",
      template,
      downloadUrl: renderResult.ok ? renderResult.downloadUrl : record.downloadUrl,
      recordDownloadUrl: record.downloadUrl,
      videoDownloadUrl: renderResult.ok ? renderResult.downloadUrl : "",
      note: renderResult.ok ? "MP4 greeting video rendered." : renderResult.message,
      customerKey: customerIdentity.customerKey,
      access: renderResult.ok
        ? {
            source: accessReservation.source,
            paidCreditsRemaining: accessReservation.paidCredits
          }
        : {
            restored: true,
            reason: "Video was not rendered."
          }
    });
  } catch (err) {
    if (accessReservation?.allowed && customerIdentity?.customerKey) {
      await refundGreetingGenerationAccess(
        customerIdentity.customerKey,
        accessReservation.source
      ).catch((refundError) => {
        console.error("Greeting access refund failed:", refundError);
      });
    }

    console.error("Greeting Studio render error:", err.stderr || err.message || err);
    return res.status(500).json({
      ok: false,
      error: "Failed to render greeting video."
    });
  }
});


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
    if (type === "text") text = message.text?.body || "";

    // Mobile app messages arrive like:
    // Language: en
    // I want to buy Printo music.
    // This keeps the user's selected app language inside the WhatsApp session.
    if (type === "text" && text) {
      const appLanguageMessage = extractLanguageFromAppMessage(text);
      if (appLanguageMessage.language) {
        session.language = appLanguageMessage.language;
        text = appLanguageMessage.text;
      }
    }

    const lower = String(text || "").toLowerCase().trim();

    const phoneVerificationMatch = String(text || "")
      .trim()
      .match(/^PRINTO\s+VERIFY\s+([A-Za-z0-9_-]{20,80})$/i);

    if (type === "text" && phoneVerificationMatch) {
      if (!verifyPrintoWhatsAppWebhookSignature(req)) {
        console.error("Rejected unsigned Printo phone verification webhook.");
        return res.sendStatus(401);
      }

      const challengeToken = phoneVerificationMatch[1];
      const challengeHash = hashPrintoPhoneChallenge(challengeToken);
      const senderPhone = normalizePrintoPhone(from);
      let client;

      try {
        await ensurePrintoAccountTables();
        client = await pool.connect();
        await client.query("BEGIN");
        const confirmed = await client.query(
          `
          UPDATE greeting_phone_verification_challenges
          SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW()
          WHERE challenge_hash = $1
            AND phone_e164 = $2
            AND status = 'pending'
            AND used_at IS NULL
            AND expires_at > NOW()
          RETURNING phone_e164
          `,
          [challengeHash, senderPhone]
        );

        if (!confirmed.rows[0]) {
          await client.query("ROLLBACK");
          await sendMessage(
            from,
            "❌ This Printo verification request is invalid, expired, or belongs to another phone number. Return to Printo Studio and start verification again."
          );
          return res.sendStatus(200);
        }

        const customerKey = makeGreetingCustomerKey(`phone:${senderPhone}`);
        await client.query(
          `
          INSERT INTO greeting_verified_phones (
            phone_e164, customer_key, first_verified_at, last_verified_at, updated_at
          )
          VALUES ($1, $2, NOW(), NOW(), NOW())
          ON CONFLICT (phone_e164)
          DO UPDATE SET
            last_verified_at = NOW(),
            updated_at = NOW()
          `,
          [senderPhone, customerKey]
        );
        await client.query("COMMIT");

        await sendMessage(
          from,
          "✅ Your phone number is verified for Printo Studio. Return to the browser page, choose your PIN, and finish creating your account."
        );
        return res.sendStatus(200);
      } catch (verificationError) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Printo inbound phone verification failed:", verificationError);
        return res.sendStatus(500);
      } finally {
        if (client) client.release();
      }
    }
    if (
  type === "text" &&
  ["hello", "hi", "hey", "menu", "start"].includes(lower)
) {
  const previousLanguage = session.language || "en";
  resetSession(from);
  const freshSession = getSession(from);
  freshSession.language = previousLanguage;
  freshSession.stage = "MENU";

  await sendMessage(
    from,
    `${welcomeText(freshSession.language)}

${serviceMenu(freshSession.language)}`
  );

  return res.sendStatus(200);
}
    const langMatch = lower.match(/lang=(en|es|fr|de|pt|ar|zh)/);

if (langMatch) {
  session.language = langMatch[1];
  session.stage = "MENU";

 await sendMessage(
  from,
  `${welcomeText(session.language)}

${serviceMenu(session.language)}`
);

  return res.sendStatus(200);
}


// ===== DIRECT WORKER ROUTING FOR NON-AUTOMATED GREETING CARDS =====
if (
  type === "text" &&
  lower.includes("card_personalization_agent")
) {
  const selectedCardMatch = String(text || "").match(
    /Selected card:\s*(.+)/i
  );
  const selectedCard = selectedCardMatch?.[1]?.trim() || "Greeting Video Card";

  const job = await createGreetingDashboardJob({
    templateId: "worker-personalization",
    occasion: selectedCard,
    recipientName: "To be provided",
    senderName: "To be provided",
    message: String(text || "").trim(),
    language: session.language,
    customerName: "",
    customerPhone: from,
    checkoutUrl: "",
    downloadUrl: "",
    status: "pending",
    accessNote: `DIRECT WORKER PERSONALIZATION REQUEST

This greeting card does not yet use automatic personalization.
A worker must collect the recipient name, sender name, personal message, and payment choice.`
  });

  session.selectedService = "GREETING_CARD_AGENT";
  session.lastServiceJobId = job?.id || null;
  session.pendingFile = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(
    from,
    pickText(session.language, {
      en: `✅ Your ${selectedCard} personalization request has been sent directly to a worker.

Please type the recipient name, sender name, and personal message. You may also send a voice note.

A worker will reply here on WhatsApp.`,
      es: `✅ Su solicitud de personalización de ${selectedCard} fue enviada directamente a un trabajador.

Escriba el nombre del destinatario, el remitente y el mensaje personal. También puede enviar una nota de voz.

Un trabajador responderá aquí en WhatsApp.`,
      fr: `✅ Votre demande de personnalisation ${selectedCard} a été envoyée directement à un agent.

Écrivez le nom du destinataire, de l'expéditeur et le message personnel. Vous pouvez aussi envoyer un message vocal.

Un agent répondra ici sur WhatsApp.`,
      de: `✅ Ihre Personalisierungsanfrage für ${selectedCard} wurde direkt an einen Mitarbeiter gesendet.

Geben Sie Empfängername, Absendername und persönliche Nachricht ein. Sie können auch eine Sprachnachricht senden.

Ein Mitarbeiter antwortet hier auf WhatsApp.`,
      pt: `✅ Sua solicitação de personalização de ${selectedCard} foi enviada diretamente a um trabalhador.

Digite o nome do destinatário, remetente e a mensagem pessoal. Você também pode enviar uma mensagem de voz.

Um trabalhador responderá aqui no WhatsApp.`,
      ar: `✅ تم إرسال طلب تخصيص ${selectedCard} مباشرة إلى أحد الموظفين.

اكتب اسم المستلم واسم المرسل والرسالة الشخصية. يمكنك أيضًا إرسال رسالة صوتية.

سيرد الموظف هنا على واتساب.`,
      zh: `✅ 您的 ${selectedCard} 个性化请求已直接发送给工作人员。

请输入收件人姓名、发件人姓名和个人留言。您也可以发送语音消息。

工作人员会在 WhatsApp 上回复您。`
    })
  );

  return res.sendStatus(200);
}

// ===== DIRECT HANDLER FOR PRINTO MOBILE APP SERVICES =====
// Handles WhatsApp messages sent from index.tsx service cards.
if (type === "text") {
  const mobileAppService = detectMobileAppService(text);

  if (mobileAppService === "DIGITAL_SERVICES_DOWNLOADS") {
    session.selectedService = "DIGITAL_SERVICES_DOWNLOADS";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "DIGITAL_SERVICES_MENU";
    await sendMessage(from, digitalServicesMenuText(session.language));
    return res.sendStatus(200);
  }

  if (mobileAppService === "GREETING_CARD" || mobileAppService === "PERSONALIZED_PRINTO_VIDEO") {
    session.selectedService = "GREETING_CARD";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.greetingSpec = {};
    session.stage = "GREETING_OCCASION";
    await sendMessage(from, greetingStudioMenuText(session.language));
    return res.sendStatus(200);
  }

  if (mobileAppService === "PRINTOMATIC_SERVICES") {
    session.selectedService = null;
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "MENU";
    await sendMessage(
      from,
      `${welcomeText(session.language)}\n\n${serviceMenu(session.language)}`
    );
    return res.sendStatus(200);
  }

  if (mobileAppService === "PRINTO_MUSIC" || mobileAppService === "AI_VIDEO_CREATION" || mobileAppService === "MUSIC_VOICE_STUDIO") {
    session.selectedService = mobileAppService;
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    await sendMessage(from, mobileAppServicePromptText(session.language, mobileAppService));
    return res.sendStatus(200);
  }
}


// ===== DIRECT HANDLER FOR DIGITAL SERVICES FROM MOBILE APP / MAIN MENU =====
if (
  type === "text" &&
  (
    lower.includes("service=digital_downloads") ||
    lower.includes("digital_downloads") ||
    lower.includes("digital services") ||
    lower.includes("digital store")
  )
) {
  session.selectedService = "DIGITAL_SERVICES_DOWNLOADS";
  session.lastServiceJobId = null;
  session.pendingFile = null;
  session.stage = "DIGITAL_SERVICES_MENU";
  await sendMessage(from, digitalServicesMenuText(session.language));
  return res.sendStatus(200);
}


// ===== DIRECT HANDLER FOR PRINTO GREETING STUDIO =====
if (
  type === "text" &&
  (
    lower.includes("service=greeting_studio") ||
    lower.includes("greeting studio") ||
    lower.includes("video greeting") ||
    lower.includes("greeting card")
  )
) {
  session.selectedService = "GREETING_CARD";
  session.lastServiceJobId = null;
  session.pendingFile = null;
  session.greetingSpec = {};
  session.stage = "GREETING_OCCASION";
  await sendMessage(from, greetingStudioMenuText(session.language));
  return res.sendStatus(200);
}

// ===== PRINTO GREETING STUDIO STEP-BY-STEP FLOW =====
// Customers can either answer one question at a time OR send everything together.
// Supported full formats:
// Birthday | Mary | John | Wishing you joy and blessings
// Birthday/Mary/John/Wishing you joy and blessings
if (
  type === "text" &&
  (
    session.selectedService === "GREETING_CARD" ||
    ["GREETING_STUDIO", "GREETING_OCCASION", "GREETING_RECIPIENT", "GREETING_SENDER", "GREETING_MESSAGE", "GREETING_PAYMENT", "GREETING_AWAITING_PAYMENT"].includes(session.stage)
  )
) {
  session.greetingSpec = session.greetingSpec || {};

  if (lower === "0" || lower === "cancel" || lower === "back") {
    session.selectedService = null;
    session.greetingSpec = {};
    session.stage = "MENU";
    await sendMessage(from, serviceMenu(session.language));
    return res.sendStatus(200);
  }

  async function finishGreetingDetailsAndAskPayment(spec) {
    const customerIdentity = getGreetingCustomerIdentity(req, {}, from);

    const paymentLinks = buildGreetingPaymentLinks({
      customerKey: customerIdentity.customerKey,
      templateId: spec.templateId || "birthday",
      contactPhone: from
    });

    const downloadRecord = createGreetingDownloadRecord(req, {
      templateId: spec.templateId || "birthday",
      occasion: spec.occasion || "Birthday",
      recipientName: spec.recipientName,
      senderName: spec.senderName,
      message: spec.message,
      language: session.language
    });

    const accessReservation = await reserveGreetingGenerationAccess(
      customerIdentity.customerKey,
      from
    );

    const finalSpec = {
      ...session.greetingSpec,
      ...spec,
      greetingId: downloadRecord.greetingId,
      templateId: downloadRecord.template.id,
      downloadUrl: downloadRecord.downloadUrl,
      generatedFileName: downloadRecord.fileName,
      checkoutUrl: paymentLinks.shopify,
      paymentLinks,
      customerKey: customerIdentity.customerKey,
      customerPhone: from,
      accessSource: accessReservation.source
    };

    const job = await createGreetingDashboardJob({
      templateId: finalSpec.templateId || "birthday",
      occasion: finalSpec.occasion || "Birthday",
      recipientName: finalSpec.recipientName,
      senderName: finalSpec.senderName,
      message: finalSpec.message,
      language: session.language,
      customerPhone: from,
      checkoutUrl: paymentLinks.shopify,
      downloadUrl: finalSpec.downloadUrl,
      status: accessReservation.allowed ? "processing" : "pending"
    });

    session.greetingSpec = finalSpec;
    session.selectedService = "GREETING_CARD";
    session.lastServiceJobId = job?.id || null;

    if (!accessReservation.allowed) {
      session.stage = "GREETING_PAYMENT";

      if (session.lastServiceJobId) {
        await attachTextToExistingJob(
          session.lastServiceJobId,
          `Payment required before generation. Customer key: ${customerIdentity.customerKey}`
        );
      }

      await sendMessage(
        from,
        greetingPaymentPromptText(finalSpec, session.language)
      );

      return res.sendStatus(200);
    }

    session.stage = "GREETING_RENDERING";

    const renderResult = await tryRenderGreetingVideoForWhatsApp(
      req,
      from,
      session,
      finalSpec
    );

    if (!renderResult.ok) {
      await refundGreetingGenerationAccess(
        customerIdentity.customerKey,
        accessReservation.source
      );

      session.stage = "DONE";
      session.selectedService = null;

      if (session.lastServiceJobId) {
        await attachTextToExistingJob(
          session.lastServiceJobId,
          `Greeting render failed. ${accessReservation.source} access was restored.`
        );
      }

      await sendMessage(
        from,
        `${renderResult.message}

Your ${
          accessReservation.source === "free" ? "free greeting" : "paid greeting credit"
        } was restored because the video was not created.`
      );

      return res.sendStatus(200);
    }

    session.stage = "DONE";
    session.selectedService = null;

    const accessMessage =
      accessReservation.source === "free"
        ? pickText(session.language, {
            en: "🎁 Your first personalized Printo video greeting is FREE.",
            es: "🎁 Su primer saludo de video Printo personalizado es GRATIS.",
            fr: "🎁 Votre première carte vidéo Printo personnalisée est GRATUITE.",
            de: "🎁 Ihr erster personalisierter Printo-Videogruß ist KOSTENLOS.",
            pt: "🎁 Sua primeira saudação de vídeo Printo personalizada é GRÁTIS.",
            ar: "🎁 أول تهنئة فيديو مخصصة من Printo مجانية.",
            zh: "🎁 您的第一张个性化 Printo 视频贺卡免费。"
          })
        : pickText(session.language, {
            en: "✅ One paid greeting credit was used.",
            es: "✅ Se utilizó un crédito de saludo pagado.",
            fr: "✅ Un crédit de carte payant a été utilisé.",
            de: "✅ Ein bezahltes Grußguthaben wurde verwendet.",
            pt: "✅ Um crédito de saudação pago foi usado.",
            ar: "✅ تم استخدام رصيد تهنئة مدفوع.",
            zh: "✅ 已使用一个付费贺卡额度。"
          });

    await sendMessage(from, `${accessMessage}${renderResult.message}`);
    return res.sendStatus(200);
  }

  if (session.stage === "GREETING_STUDIO" || session.stage === "GREETING_OCCASION") {
    const parsedFullRequest = parseGreetingRequest(text);

    // Accept full details sent in one message, including slash format.
    if (
      parsedFullRequest.occasion &&
      parsedFullRequest.recipientName &&
      parsedFullRequest.senderName &&
      parsedFullRequest.message
    ) {
      const selectedOccasion =
        getGreetingOccasionFromInput(parsedFullRequest.occasion) ||
        getGreetingOccasionFromInput("birthday") ||
        { occasion: parsedFullRequest.occasion, templateId: "birthday", packageType: "STANDARD" };

      return await finishGreetingDetailsAndAskPayment({
        ...selectedOccasion,
        occasion: selectedOccasion.occasion || parsedFullRequest.occasion,
        recipientName: parsedFullRequest.recipientName,
        senderName: parsedFullRequest.senderName,
        message: parsedFullRequest.message
      });
    }

    const selectedOccasion = getGreetingOccasionFromInput(text);

    if (!selectedOccasion) {
      await sendMessage(from, greetingStudioMenuText(session.language));
      return res.sendStatus(200);
    }

    session.greetingSpec = {
      ...session.greetingSpec,
      ...selectedOccasion
    };
    session.stage = "GREETING_RECIPIENT";

    await sendMessage(from, greetingQuestionText(session.language, "recipient", session.greetingSpec));
    return res.sendStatus(200);
  }

  if (session.stage === "GREETING_RECIPIENT") {
    const recipientName = String(text || "").trim();

    if (!recipientName || recipientName.length < 2) {
      await sendMessage(from, "Please type the recipient's name.");
      return res.sendStatus(200);
    }

    session.greetingSpec.recipientName = recipientName;
    session.stage = "GREETING_SENDER";

    await sendMessage(from, greetingQuestionText(session.language, "sender", session.greetingSpec));
    return res.sendStatus(200);
  }

  if (session.stage === "GREETING_SENDER") {
    const senderName = String(text || "").trim();

    if (!senderName || senderName.length < 2) {
      await sendMessage(from, "Please type the sender's name.");
      return res.sendStatus(200);
    }

    session.greetingSpec.senderName = senderName;
    session.stage = "GREETING_MESSAGE";

    await sendMessage(from, greetingQuestionText(session.language, "message", session.greetingSpec));
    return res.sendStatus(200);
  }

  if (session.stage === "GREETING_MESSAGE") {
    const greetingMessage = String(text || "").trim();

    if (!greetingMessage || greetingMessage.length < 3) {
      await sendMessage(from, "Please type the greeting message you want Printo to use.");
      return res.sendStatus(200);
    }

    const spec = {
      ...session.greetingSpec,
      message: greetingMessage
    };

    return await finishGreetingDetailsAndAskPayment(spec);
  }

  if (session.stage === "GREETING_AWAITING_PAYMENT") {
    const customerMessage = String(text || "").trim();

    if (customerMessage && session.lastServiceJobId) {
      await attachTextToExistingJob(
        session.lastServiceJobId,
        `Customer payment/receipt message: ${customerMessage}`
      );
    }

    await sendMessage(
      from,
      pickText(session.language, {
        en: `✅ Your payment message has been received.

A worker will verify the payment. No new greeting video will be generated until payment is confirmed.

After confirmation, return to Printo Studio and tap Generate again.`,
        es: `✅ Su mensaje de pago fue recibido.

Un trabajador verificará el pago. No se generará otro video hasta que se confirme el pago.

Después de la confirmación, vuelva a Printo Studio y pulse Generar de nuevo.`,
        fr: `✅ Votre message de paiement a été reçu.

Un agent vérifiera le paiement. Aucune nouvelle vidéo ne sera générée avant confirmation.

Après confirmation, revenez à Printo Studio et appuyez de nouveau sur Générer.`,
        de: `✅ Ihre Zahlungsnachricht wurde empfangen.

Ein Mitarbeiter prüft die Zahlung. Vor der Bestätigung wird kein neues Video erstellt.

Kehren Sie danach zu Printo Studio zurück und tippen Sie erneut auf Erstellen.`,
        pt: `✅ Sua mensagem de pagamento foi recebida.

Um trabalhador verificará o pagamento. Nenhum novo vídeo será gerado antes da confirmação.

Depois da confirmação, volte ao Printo Studio e toque em Gerar novamente.`,
        ar: `✅ تم استلام رسالة الدفع.

سيقوم موظف بالتحقق من الدفع. لن يتم إنشاء فيديو جديد قبل تأكيد الدفع.

بعد التأكيد، ارجع إلى استوديو Printo واضغط على إنشاء مرة أخرى.`,
        zh: `✅ 已收到您的付款信息。

工作人员会核实付款。付款确认前不会生成新视频。

确认后，请返回 Printo Studio 再次点击生成。`
      })
    );

    return res.sendStatus(200);
  }

  if (session.stage === "GREETING_PAYMENT") {
    const spec = session.greetingSpec || {};
    const handledPaymentChoice = await handleGreetingPaymentChoice({ req, from, text, session, spec });
    if (handledPaymentChoice) {
      return res.sendStatus(200);
    }

    if (isGreetingShopifyChoice(text)) {
      const checkoutUrl = spec.checkoutUrl || buildGreetingCheckoutUrl(spec.packageType || "STANDARD", 1);

      if (session.lastServiceJobId) {
        await attachTextToExistingJob(
          session.lastServiceJobId,
          "Greeting Studio payment choice: Shopify Checkout selected by customer"
        );
      }

      session.stage = "DONE";

      await sendMessage(
        from,
        checkoutUrl
          ? `✅ Shopify Checkout selected.

Please complete payment here:
${checkoutUrl}

Your Greeting Order Portal:
${spec.downloadUrl || "Download link already created."}

After payment, please send your payment receipt here on WhatsApp for confirmation.

A Printo team member will confirm the order and continue the greeting card video process.`
          : `✅ Shopify Checkout selected.

Shopify Greeting Studio checkout is coming next.

Your Greeting Order Portal:
${spec.downloadUrl || "Download link already created."}

For now, please use Africa Payment or continue with an agent.

Reply with number only:
2 - Africa Payment
3 - Continue with Agent`
      );

      return res.sendStatus(200);
    }

    if (isGreetingAfricaChoice(text)) {
      if (session.lastServiceJobId) {
        await attachTextToExistingJob(
          session.lastServiceJobId,
          "Greeting Studio payment choice: Africa Payment selected by customer"
        );
      }

      session.stage = "DONE";

      await sendMessage(
        from,
        `✅ Africa Payment selected for Printo Greeting Studio.

Please complete payment here:
https://www.patapata.us/pages/africa-payment

After payment, please send your payment receipt here on WhatsApp for confirmation.

Your Greeting Order Portal:
${spec.downloadUrl || "Download link already created."}

A Printo team member will confirm the order and continue the greeting card video process.`
      );

      return res.sendStatus(200);
    }

    if (isGreetingAgentChoice(text)) {
      if (session.lastServiceJobId) {
        await attachTextToExistingJob(
          session.lastServiceJobId,
          "Greeting Studio payment choice: Continue with Agent selected by customer"
        );
      }

      session.stage = "DONE";

      await sendMessage(
        from,
        `✅ Continue with Agent selected.

Your Greeting Order Portal:
${spec.downloadUrl || "Download link already created."}

A Printo team member will review your Greeting Studio order and reply here shortly.`
      );

      return res.sendStatus(200);
    }

    await sendMessage(from, `Please reply with number only:

1 - Shopify Checkout (coming next)
2 - Africa Payment
3 - Continue with Agent

To start over, type 39.`);
    return res.sendStatus(200);
  }
}

// ===== DIRECT HANDLER FOR NEW SERVICES 33–37 =====
// This catches the new service numbers immediately so they work from the main menu
// and also avoids the message being ignored if the session stage was not reset.
if (type === "text" && ["33", "34", "35", "36", "37"].includes(lower)) {
  const newServiceMap = {
    "33": {
      serviceType: "SHIPPING_DELIVERY",
      prompt: {
        en: `🚚 Shipping / Delivery selected.

Please type the details in your own words.

Include:
• Pickup location
• Delivery destination
• Item type and quantity
• Preferred pickup/delivery date and time
• Sender and receiver phone number
• Any special instruction

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
        es: `🚚 Envío / Entrega seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Lugar de recogida
• Destino de entrega
• Tipo de artículo y cantidad
• Fecha y hora preferidas de recogida/entrega
• Teléfono del remitente y del receptor
• Cualquier instrucción especial

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
        fr: `🚚 Expédition / Livraison sélectionnée.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Lieu de collecte
• Destination de livraison
• Type d'article et quantité
• Date et heure souhaitées pour la collecte/livraison
• Numéro de téléphone de l'expéditeur et du destinataire
• Toute instruction spéciale

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
        de: `🚚 Versand / Lieferung ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Abholort
• Lieferziel
• Artikeltyp und Menge
• Gewünschtes Abhol-/Lieferdatum und Uhrzeit
• Telefonnummer von Absender und Empfänger
• Besondere Anweisungen

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
        pt: `🚚 Envio / Entrega selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Local de retirada
• Destino da entrega
• Tipo de item e quantidade
• Data e horário preferidos para retirada/entrega
• Telefone do remetente e do destinatário
• Qualquer instrução especial

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
        ar: `🚚 تم اختيار الشحن / التوصيل.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• موقع الاستلام
• وجهة التوصيل
• نوع السلعة والكمية
• التاريخ والوقت المفضلان للاستلام/التوصيل
• رقم هاتف المرسل والمستلم
• أي تعليمات خاصة

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
        zh: `🚚 已选择运输 / 配送。

请用您自己的话填写详细信息。

请包括：
• 取件地点
• 配送目的地
• 物品类型和数量
• 首选取件/配送日期和时间
• 寄件人和收件人电话号码
• 任何特殊说明

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
      }
    },
    "34": {
      serviceType: "HELPER_SERVICES",
      prompt: {
        en: `🧰 Helper Services selected.

Please type the details in your own words.

Include:
• Type of helper needed
• Indoor, outdoor, moving, cleaning, store, office, or general work
• Your location
• Preferred date and time
• How many helpers are needed

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
        es: `🧰 Servicios de ayudante seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Tipo de ayudante necesario
• Trabajo interior, exterior, mudanza, limpieza, tienda, oficina o trabajo general
• Su ubicación
• Fecha y hora preferidas
• Cuántos ayudantes necesita

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
        fr: `🧰 Services d'aide sélectionnés.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Type d'aide nécessaire
• Travail intérieur, extérieur, déménagement, nettoyage, magasin, bureau ou travail général
• Votre position
• Date et heure souhaitées
• Nombre d'aides nécessaires

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
        de: `🧰 Helfer-Services ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Art der benötigten Hilfe
• Innenarbeit, Außenarbeit, Umzug, Reinigung, Laden, Büro oder allgemeine Arbeit
• Ihren Standort
• Gewünschtes Datum und Uhrzeit
• Wie viele Helfer benötigt werden

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
        pt: `🧰 Serviços de ajudante selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Tipo de ajudante necessário
• Trabalho interno, externo, mudança, limpeza, loja, escritório ou trabalho geral
• Sua localização
• Data e horário preferidos
• Quantos ajudantes são necessários

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
        ar: `🧰 تم اختيار خدمات المساعدة.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• نوع المساعدة المطلوبة
• عمل داخلي أو خارجي أو نقل أو تنظيف أو متجر أو مكتب أو عمل عام
• موقعك
• التاريخ والوقت المفضلان
• عدد المساعدين المطلوبين

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
        zh: `🧰 已选择帮工服务。

请用您自己的话填写详细信息。

请包括：
• 需要的帮工类型
• 室内、室外、搬家、清洁、商店、办公室或普通工作
• 您的位置
• 首选日期和时间
• 需要多少名帮工

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
      }
    },
    "35": {
      serviceType: "BOOK_APP_TESTER",
      prompt: {
        en: `📱 Book App Tester selected.

Please type the details in your own words.

Include:
• App name or link
• Android, iPhone, or both
• What you want tested
• Preferred testing date/time
• Any login details or instructions if needed

You may also send screenshots, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
        es: `📱 Reservar probador de app seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Nombre o enlace de la app
• Android, iPhone o ambos
• Qué desea probar
• Fecha/hora preferida para la prueba
• Datos de acceso o instrucciones si son necesarios

También puede enviar capturas, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
        fr: `📱 Réserver un testeur d'application sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Nom ou lien de l'application
• Android, iPhone ou les deux
• Ce que vous voulez tester
• Date/heure souhaitée pour le test
• Identifiants ou instructions si nécessaire

Vous pouvez aussi envoyer captures d'écran, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
        de: `📱 App-Tester buchen ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• App-Name oder Link
• Android, iPhone oder beides
• Was getestet werden soll
• Gewünschtes Testdatum und Uhrzeit
• Login-Daten oder Anweisungen, falls nötig

Sie können auch Screenshots, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
        pt: `📱 Reservar testador de aplicativo selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Nome ou link do aplicativo
• Android, iPhone ou ambos
• O que você quer testar
• Data/horário preferido para o teste
• Dados de login ou instruções, se necessário

Você também pode enviar capturas de tela, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
        ar: `📱 تم اختيار حجز مختبر تطبيق.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• اسم التطبيق أو الرابط
• Android أو iPhone أو كلاهما
• ما الذي تريد اختباره
• التاريخ والوقت المفضلان للاختبار
• بيانات تسجيل الدخول أو التعليمات إذا لزم الأمر

يمكنك أيضًا إرسال لقطات شاشة أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
        zh: `📱 已选择预约应用测试员。

请用您自己的话填写详细信息。

请包括：
• 应用名称或链接
• Android、iPhone 或两者都要
• 您想测试的内容
• 首选测试日期/时间
• 如需要，请提供登录信息或说明

您也可以发送截图、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
      }
    },
    "36": {
      serviceType: "SOLAR_INSTALLATION",
      prompt: {
        en: `☀️ Solar Installation selected.

Please type the details in your own words.

Include:
• Home, office, shop, farm, or project location
• What you want solar to power
• Your current electricity issue
• Preferred date/time for inspection
• Budget range if available

You may also send pictures, videos, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
        es: `☀️ Instalación solar seleccionada.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Casa, oficina, tienda, granja o ubicación del proyecto
• Qué desea alimentar con energía solar
• Su problema eléctrico actual
• Fecha/hora preferida para inspección
• Presupuesto si está disponible

También puede enviar fotos, videos, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
        fr: `☀️ Installation solaire sélectionnée.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Maison, bureau, magasin, ferme ou lieu du projet
• Ce que vous voulez alimenter avec le solaire
• Votre problème électrique actuel
• Date/heure souhaitée pour l'inspection
• Budget si disponible

Vous pouvez aussi envoyer photos, vidéos, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
        de: `☀️ Solarinstallation ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Zuhause, Büro, Geschäft, Farm oder Projektstandort
• Was mit Solarstrom betrieben werden soll
• Ihr aktuelles Stromproblem
• Gewünschtes Datum/Uhrzeit für Besichtigung
• Budgetrahmen, falls vorhanden

Sie können auch Bilder, Videos, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
        pt: `☀️ Instalação solar selecionada.

Digite os detalhes com suas próprias palavras.

Inclua:
• Casa, escritório, loja, fazenda ou local do projeto
• O que você deseja alimentar com energia solar
• Seu problema atual de eletricidade
• Data/horário preferido para inspeção
• Faixa de orçamento, se disponível

Você também pode enviar fotos, vídeos, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
        ar: `☀️ تم اختيار تركيب الطاقة الشمسية.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• المنزل أو المكتب أو المتجر أو المزرعة أو موقع المشروع
• ما الذي تريد تشغيله بالطاقة الشمسية
• مشكلة الكهرباء الحالية لديك
• التاريخ والوقت المفضلان للفحص
• نطاق الميزانية إن وجد

يمكنك أيضًا إرسال صور أو فيديوهات أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
        zh: `☀️ 已选择太阳能安装。

请用您自己的话填写详细信息。

请包括：
• 家庭、办公室、商店、农场或项目位置
• 您想用太阳能供电的设备
• 您目前的用电问题
• 首选检查日期/时间
• 如有预算范围请填写

您也可以发送图片、视频、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
      }
    },
    "37": {
      serviceType: "WORK_MAINTENANCE",
      prompt: {
        en: `🛠️ Work Maintenance selected.

Please type the details in your own words.

Include:
• Type of maintenance needed
• Home, office, shop, equipment, electrical, plumbing, cleaning, or general work
• Your location
• Preferred date and time
• Urgent or regular service

You may also send pictures, videos, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
        es: `🛠️ Mantenimiento de trabajo seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Tipo de mantenimiento necesario
• Casa, oficina, tienda, equipo, electricidad, plomería, limpieza o trabajo general
• Su ubicación
• Fecha y hora preferidas
• Servicio urgente o regular

También puede enviar fotos, videos, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
        fr: `🛠️ Maintenance de travail sélectionnée.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Type de maintenance nécessaire
• Maison, bureau, magasin, équipement, électricité, plomberie, nettoyage ou travail général
• Votre position
• Date et heure souhaitées
• Service urgent ou régulier

Vous pouvez aussi envoyer photos, vidéos, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
        de: `🛠️ Arbeitswartung ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Art der benötigten Wartung
• Zuhause, Büro, Geschäft, Gerät, Elektrik, Sanitär, Reinigung oder allgemeine Arbeit
• Ihren Standort
• Gewünschtes Datum und Uhrzeit
• Dringender oder regulärer Service

Sie können auch Bilder, Videos, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
        pt: `🛠️ Manutenção de trabalho selecionada.

Digite os detalhes com suas próprias palavras.

Inclua:
• Tipo de manutenção necessária
• Casa, escritório, loja, equipamento, elétrica, encanamento, limpeza ou trabalho geral
• Sua localização
• Data e horário preferidos
• Serviço urgente ou regular

Você também pode enviar fotos, vídeos, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
        ar: `🛠️ تم اختيار صيانة الأعمال.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• نوع الصيانة المطلوبة
• منزل أو مكتب أو متجر أو معدات أو كهرباء أو سباكة أو تنظيف أو عمل عام
• موقعك
• التاريخ والوقت المفضلان
• خدمة عاجلة أو عادية

يمكنك أيضًا إرسال صور أو فيديوهات أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
        zh: `🛠️ 已选择工作维护。

请用您自己的话填写详细信息。

请包括：
• 需要的维护类型
• 家庭、办公室、商店、设备、电气、管道、清洁或普通工作
• 您的位置
• 首选日期和时间
• 紧急服务或普通服务

您也可以发送图片、视频、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
      }
    }
  };

  const selected = newServiceMap[lower];
  session.selectedService = selected.serviceType;
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(from, pickText(session.language, selected.prompt));
  return res.sendStatus(200);
}

// ===== LANDING PAGE WHATSAPP REQUESTS → WORKER DASHBOARD =====
if (
  lower.includes("upload and print") ||
  lower.includes("print-o-matic") ||
  lower.includes("lamination") ||
  lower.includes("image editing") ||
  lower.includes("video editing") ||
  lower.includes("submit cv") ||
  lower.includes("shipping") ||
  lower.includes("delivery") ||
  lower.includes("helper") ||
  lower.includes("book app tester") ||
  lower.includes("app tester") ||
  lower.includes("solar installation") ||
  lower.includes("solar") ||
  lower.includes("work maintenance") ||
  lower.includes("maintenance") ||
  lower.includes("digital services") ||
  lower.includes("digital store") ||
  lower.includes("digital downloads") ||
  lower.includes("service=digital_downloads")
) {
  let serviceType = "WHATSAPP_REQUEST";

  if (lower.includes("upload") || lower.includes("print")) {
    serviceType = "PRINT";
  } else if (lower.includes("lamination")) {
    serviceType = "LAMINATING";
  } else if (lower.includes("image editing")) {
    serviceType = "IMAGE_EDITING";
  } else if (lower.includes("video editing")) {
    serviceType = "VIDEO_EDITING";
  } else if (lower.includes("submit cv")) {
    serviceType = "JOB_APPLICATION";
  } else if (lower.includes("shipping") || lower.includes("delivery")) {
    serviceType = "SHIPPING_DELIVERY";
  } else if (lower.includes("helper")) {
    serviceType = "HELPER_SERVICES";
  } else if (lower.includes("book app tester") || lower.includes("app tester")) {
    serviceType = "BOOK_APP_TESTER";
  } else if (lower.includes("solar installation") || lower.includes("solar")) {
    serviceType = "SOLAR_INSTALLATION";
  } else if (lower.includes("work maintenance") || lower.includes("maintenance")) {
    serviceType = "WORK_MAINTENANCE";
  } else if (lower.includes("digital services") || lower.includes("digital store") || lower.includes("digital downloads") || lower.includes("service=digital_downloads")) {
    serviceType = "DIGITAL_SERVICES_DOWNLOADS";
  }

  await pool.query(
    `INSERT INTO print_jobs
      (status, printer_id, service_type, instructions, customer_phone, original_name, copies, pages, total_cost, created_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
    [
      "pending",
      serviceType === "PRINT" ? DEFAULT_PRINTER_ID : AGENT_QUEUE_ID,
      serviceType,
      text,
      from,
      "WhatsApp Landing Request",
      1,
      1,
      0
    ]
  );

  await sendMessage(
    from,
    botText("landing_received", session.language, { service: serviceType.replaceAll("_", " ") })
  );

  return res.sendStatus(200);
}
    const tableColumns = await getPrintJobsColumns().catch(() => new Set());

    async function createJobFromMedia({
      printerId,
      queueType,
      serviceType,
      mediaId,
      originalName,
      mimeType,
      paperSize = "",
      colorMode = "",
      copies = 1,
      pages = 1,
      instructions = ""
    }) {
      const fileUrl = await downloadWhatsAppMediaToUploads(
        mediaId,
        originalName || "upload",
        mimeType || "",
        req
      );

      if (!fileUrl) throw new Error("Failed to save WhatsApp media");

      const cols = [];
      const vals = [];
      const params = [];

      function addCol(name, value) {
        if (tableColumns.has(name)) {
          cols.push(name);
          params.push(value);
          vals.push(`$${params.length}`);
        }
      }

      addCol("printer_id", printerId);
      addCol("queue_type", queueType);
      addCol("file_url", fileUrl);
      addCol("original_name", originalName || "upload");
      addCol("mime_type", mimeType || "");
      addCol("status", "pending");
      addCol("service_type", serviceType || "SERVICE");
      addCol("paper_size", paperSize || null);
      addCol("color_mode", colorMode || null);
      addCol("copies", parseInt(copies, 10) || 1);
      addCol("pages", parseInt(pages, 10) || 1);
      addCol("customer_phone", from || null);
      addCol("instructions", instructions || null);

      const result = await pool.query(
        `INSERT INTO print_jobs (${cols.join(", ")})
         VALUES (${vals.join(", ")})
         RETURNING *`,
        params
      );

      return result.rows[0] || null;
    }

    async function attachTextToExistingJob(jobId, textValue) {
      if (!jobId || !textValue || !tableColumns.has("instructions")) return null;

      const result = await pool.query(
        `
        UPDATE print_jobs
        SET instructions = CASE
          WHEN instructions IS NULL OR instructions = '' THEN $1
          ELSE instructions || E'\n\n--------------------\n' || $1
        END,
        updated_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [textValue, jobId]
      );

      return result.rows[0] || null;
    }

    async function attachAudioToExistingJob(jobId, mediaId, mimeType) {
      if (!jobId || !mediaId || !tableColumns.has("instruction_audio_url")) return null;

      const audioUrl = await downloadWhatsAppMediaToUploads(
        mediaId,
        `instruction_${jobId}`,
        mimeType || "audio/ogg",
        req
      );

      if (!audioUrl) return null;

      const result = await pool.query(
        `
        UPDATE print_jobs
        SET instruction_audio_url = $1,
            updated_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [audioUrl, jobId]
      );

      return result.rows[0] || null;
    }
async function attachMediaToExistingJob(jobId, mediaId, originalName, mimeType) {
  if (!jobId || !mediaId) return null;

  const fileUrl = await downloadWhatsAppMediaToUploads(
    mediaId,
    originalName || `media_${jobId}`,
    mimeType || "",
    req
  );

  if (!fileUrl) return null;

  const result = await pool.query(
    `
    UPDATE print_jobs
    SET file_url = $1,
        original_name = $2,
        mime_type = $3,
        updated_at = NOW()
    WHERE id = $4
    RETURNING *
    `,
    [fileUrl, originalName || "customer_upload", mimeType || "", jobId]
  );

  return result.rows[0] || null;
}
    async function createTextOnlyServiceJob(serviceType, instructionsText) {
      const result = await pool.query(
        `
        INSERT INTO print_jobs (
          printer_id,
          queue_type,
          status,
          service_type,
          customer_phone,
          instructions,
          created_at,
          updated_at
        )
        VALUES ($1, 'AGENT', 'pending', $2, $3, $4, NOW(), NOW())
        RETURNING *
        `,
        [AGENT_QUEUE_ID, serviceType, from || "", instructionsText || ""]
      );

      return result.rows[0] || null;
    }


    if (session.stage === "DIGITAL_SERVICES_MENU" && type === "text") {
      if (lower === "0" || lower === "menu" || lower === "back") {
        session.stage = "MENU";
        await sendMessage(from, `${welcomeText(session.language)}

${serviceMenu(session.language)}`);
        return res.sendStatus(200);
      }

      const selectedDigitalCategory = getDigitalCategoryName(lower, session.language);
      if (!selectedDigitalCategory) {
        await sendMessage(from, digitalServicesMenuText(session.language));
        return res.sendStatus(200);
      }

      session.selectedService = "DIGITAL_SERVICES_DOWNLOADS";
      session.digitalCategory = selectedDigitalCategory;
      session.pendingFile = null;
      session.lastServiceJobId = null;
      session.stage = "SERVICE_WAITING_EXTRA_NOTES";

      await createTextOnlyServiceJob(
        "DIGITAL_SERVICES_DOWNLOADS",
        `Digital Services category selected: ${selectedDigitalCategory}`
      ).then((job) => {
        if (job?.id) session.lastServiceJobId = job.id;
      }).catch((err) => console.error("Digital service job create error:", err.message));

      await sendMessage(from, digitalServiceSelectedText(session.language, selectedDigitalCategory));
      return res.sendStatus(200);
    }

    if (type === "text" && ["hi", "hello", "hey", "menu", "start"].includes(lower)) {
      const previousLanguage = session.language || "en";
      resetSession(from);
      const freshSession = getSession(from);
      freshSession.language = previousLanguage;
      freshSession.stage = "MENU";

      await sendMessage(
        from,
        `${welcomeText(freshSession.language)}

${serviceMenu(freshSession.language)}`
      );
      return res.sendStatus(200);
    }
if (session.stage === "MENU") {
  if (lower === "1") {
    session.selectedService = "PRINT";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "PRINT_SELECT_SIZE";
    await sendMessage(from, printSizeMenuText(session.language));
    return res.sendStatus(200);
  }

  if (lower === "2") {
    session.selectedService = "LAMINATE";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.laminateSpec = {};
    session.stage = "LAMINATE_WAITING_SIZE";
    await sendMessage(from, laminateSizeMenuText(session.language));
    return res.sendStatus(200);
  }

  if (lower === "3") {
    session.selectedService = "ID_PHOTO";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "IDPHOTO_WAITING_UPLOAD";
    await sendMessage(from, botText("id_photo_upload", session.language));
    return res.sendStatus(200);
  }

  if (lower === "4") {
    session.selectedService = "IMAGE_EDIT";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "IMAGE_EDIT_SELECT_TYPE";
    await sendMessage(from, botText("image_edit_menu", session.language));
    return res.sendStatus(200);
  }

  if (lower === "5") {
    session.selectedService = "VIDEO_EDIT";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "VIDEO_EDIT_SELECT_TYPE";
    await sendMessage(from, botText("video_edit_menu", session.language));
    return res.sendStatus(200);
  }

  if (lower === "6") {
    session.selectedService = "LESSON_HOMEWORK";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "LESSON_WAITING_UPLOAD";
    await sendMessage(from, {
  en: "📚 Lesson / Homework selected. Please upload your file now.",
  es: "📚 Lección / Tarea seleccionada. Por favor suba su archivo ahora.",
  fr: "📚 Leçon / Devoir sélectionné. Veuillez télécharger votre fichier maintenant.",
  de: "📚 Unterricht / Hausaufgabe ausgewählt. Bitte laden Sie jetzt Ihre Datei hoch.",
  pt: "📚 Aula / Trabalho selecionado. Faça upload do seu arquivo agora.",
  ar: "📚 تم اختيار الدرس / الواجب. يرجى رفع الملف الآن.",
  zh: "📚 已选择课程 / 作业。请现在上传您的文件。"
}[session.language || "en"]);
    return res.sendStatus(200);
  }

  if (lower === "7") {
    session.selectedService = "TALK_TO_AGENT";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    await sendMessage(from, pickText(session.language, {
      en: "👨‍💼 Talk to Agent selected. Please type your request now.",
      es: "👨‍💼 Hablar con un agente seleccionado. Escriba su solicitud ahora.",
      fr: "👨‍💼 Parler à un agent sélectionné. Veuillez écrire votre demande maintenant.",
      de: "👨‍💼 Mit Agent sprechen ausgewählt. Bitte schreiben Sie jetzt Ihre Anfrage.",
      pt: "👨‍💼 Falar com agente selecionado. Digite sua solicitação agora.",
      ar: "👨‍💼 تم اختيار التحدث مع موظف. يرجى كتابة طلبك الآن.",
      zh: "👨‍💼 已选择联系客服。请现在输入您的请求。"
    }));
    return res.sendStatus(200);
  }

  if (lower === "8") {
    session.selectedService = "AUTO_MECHANIC";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    await sendMessage(from, {
  en: "👨‍🔧 Please send your location, vehicle type, and the problem.",
  es: "👨‍🔧 Por favor envíe su ubicación, tipo de vehículo y el problema.",
  fr: "👨‍🔧 Veuillez envoyer votre position, le type de véhicule et le problème.",
  de: "👨‍🔧 Bitte senden Sie Ihren Standort, Fahrzeugtyp und das Problem.",
  pt: "👨‍🔧 Envie sua localização, tipo de veículo e o problema.",
  ar: "👨‍🔧 يرجى إرسال موقعك ونوع المركبة والمشكلة.",
  zh: "👨‍🔧 请发送您的位置、车辆类型和问题。"
}[session.language || "en"]);
    return res.sendStatus(200);
  }

  if (lower === "9") {
    session.selectedService = "RIDE_TO_WORK";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    await sendMessage(from, {
  en: "🚘 Please send pickup location, destination, date, and time.",
  es: "🚘 Envíe el lugar de recogida, destino, fecha y hora.",
  fr: "🚘 Veuillez envoyer le lieu de prise en charge, la destination, la date et l'heure.",
  de: "🚘 Bitte senden Sie Abholort, Zielort, Datum und Uhrzeit.",
  pt: "🚘 Envie o local de partida, destino, data e hora.",
  ar: "🚘 يرجى إرسال موقع الاستلام والوجهة والتاريخ والوقت.",
  zh: "🚘 请发送上车地点、目的地、日期和时间。"
}[session.language || "en"]);
    return res.sendStatus(200);
  }

  if (lower === "10") {
    session.selectedService = "SHARED_APARTMENT_RENT";
    session.lastServiceJobId = null;
    session.pendingFile = null;
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    await sendMessage(from, pickText(session.language, {
      en: "🏠 Please send preferred location, budget, and move-in date.",
      es: "🏠 Envíe la ubicación preferida, presupuesto y fecha de mudanza.",
      fr: "🏠 Veuillez envoyer le lieu préféré, le budget et la date d'emménagement.",
      de: "🏠 Bitte senden Sie den bevorzugten Standort, das Budget und das Einzugsdatum.",
      pt: "🏠 Envie a localização preferida, orçamento e data de mudança.",
      ar: "🏠 يرجى إرسال الموقع المفضل والميزانية وتاريخ الانتقال.",
      zh: "🏠 请发送首选位置、预算和入住日期。"
    }));
    return res.sendStatus(200);
  }

  if (lower === "11") {
  session.selectedService = "INDOOR_OUTDOOR_HELPER";
  session.lastServiceJobId = null;
  session.pendingFile = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🧰 Indoor / Outdoor Helper selected.

Please type the details in your own words.

Include:
• Type of helper needed
• Indoor or outdoor work
• Your location
• Preferred date and time

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.
`,
es: `🧰 Ayudante interior / exterior seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Tipo de ayudante necesario
• Trabajo interior o exterior
• Su ubicación
• Fecha y hora preferidas

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se pondrá en contacto con usted por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.
`,
fr: `🧰 Aide intérieure / extérieure sélectionnée.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Type d'aide nécessaire
• Travail intérieur ou extérieur
• Votre position
• Date et heure souhaitées

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.
`,
de: `🧰 Innen- / Außenhilfe ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Art der benötigten Hilfe
• Innen- oder Außenarbeit
• Ihren Standort
• Gewünschtes Datum und Uhrzeit

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze über WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.
`,
 pt: `🧰 Ajudante interno / externo selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Tipo de ajudante necessário
• Trabalho interno ou externo
• Sua localização
• Data e horário preferidos

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato com você pelo WhatsApp em breve.

Para voltar ao menu principal a qualquer momento, digite Hello.
`,
ar: `🧰 تم اختيار مساعد داخلي / خارجي.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• نوع المساعد المطلوب
• عمل داخلي أو خارجي
• موقعك
• التاريخ والوقت المفضلان

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

  سيتواصل معك فريقنا قريبًا عبر واتساب.
  
للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.
`,
zh: `🧰 已选择室内 / 室外帮工。

请用您自己的话填写详细信息。

请包括：
• 需要的帮工类型
• 室内或室外工作
• 您的位置
• 首选日期和时间

您也可以发送图片、链接、文件或语音消息。

我们的团队将很快通过 WhatsApp 与您联系。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "12") {
    session.selectedService = "TSHIRT_PRINT";
    session.pendingFile = null;
  session.lastServiceJobId = null;
    session.stage = "TSHIRT_SELECT_SIZE";

    await sendMessage(from, pickText(session.language, {
      en: `👕 Custom T-Shirt Printing selected.

Please choose a T-shirt size:

S - Small
M - Medium
L - Large
XL - Extra Large
XXL - Double XL

Reply with S, M, L, XL, or XXL.`,
      es: `👕 Camiseta personalizada seleccionada.

Elija una talla:

S - Pequeña
M - Mediana
L - Grande
XL - Extra grande
XXL - Doble XL

Responda con S, M, L, XL o XXL.`,
      fr: `👕 Impression de T-shirt personnalisée sélectionnée.

Choisissez une taille :

S - Petit
M - Moyen
L - Grand
XL - Très grand
XXL - Double XL

Répondez avec S, M, L, XL ou XXL.`,
      de: `👕 Benutzerdefinierter T-Shirt-Druck ausgewählt.

Bitte wählen Sie eine T-Shirt-Größe:

S - Klein
M - Mittel
L - Groß
XL - Extra groß
XXL - Doppel XL

Antworten Sie mit S, M, L, XL oder XXL.`,
      pt: `👕 Camiseta personalizada selecionada.

Escolha um tamanho:

S - Pequeno
M - Médio
L - Grande
XL - Extra grande
XXL - Duplo XL

Responda com S, M, L, XL ou XXL.`,
      ar: `👕 تم اختيار طباعة تيشيرت مخصص.

اختر مقاس التيشيرت:

S - صغير
M - متوسط
L - كبير
XL - كبير جدًا
XXL - كبير جدًا مزدوج

رد بـ S أو M أو L أو XL أو XXL.`,
      zh: `👕 已选择定制 T 恤打印。

请选择 T 恤尺码：

S - 小号
M - 中号
L - 大号
XL - 加大号
XXL - 双加大号

请回复 S、M、L、XL 或 XXL。`
    }));
    return res.sendStatus(200);
  }
  if (lower === "13") {
  session.selectedService = "JOB_APPLICATION";
  session.lastServiceJobId = null;
  session.pendingFile = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(from, pickText(session.language, {
    en: `💼 Job Search / Submit CV selected.

Please type the details in your own words.

Include:
• Job role you want
• Your location
• Your experience or skills
• Full-time, part-time, remote, or contract
• Best contact time

You may also upload your CV/resume, documents, links, pictures, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `💼 Buscar trabajo / Enviar CV seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Puesto de trabajo que desea
• Su ubicación
• Su experiencia o habilidades
• Tiempo completo, medio tiempo, remoto o contrato
• Mejor hora de contacto

También puede subir su CV, documentos, enlaces, fotos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `💼 Recherche d'emploi / Envoyer CV sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Poste recherché
• Votre emplacement
• Votre expérience ou vos compétences
• Temps plein, temps partiel, à distance ou contrat
• Meilleur moment pour vous contacter

Vous pouvez aussi envoyer votre CV, documents, liens, photos ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `💼 Jobsuche / Lebenslauf senden ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Gewünschte Stelle
• Ihren Standort
• Ihre Erfahrung oder Fähigkeiten
• Vollzeit, Teilzeit, Remote oder Vertrag
• Beste Kontaktzeit

Sie können auch Ihren Lebenslauf, Dokumente, Links, Bilder oder Sprachnachrichten hochladen.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `💼 Procurar emprego / Enviar CV selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Cargo desejado
• Sua localização
• Sua experiência ou habilidades
• Tempo integral, meio período, remoto ou contrato
• Melhor horário para contato

Você também pode enviar seu currículo, documentos, links, fotos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `💼 تم اختيار البحث عن عمل / إرسال السيرة الذاتية.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• الوظيفة التي تريدها
• موقعك
• خبرتك أو مهاراتك
• دوام كامل أو جزئي أو عن بعد أو عقد
• أفضل وقت للتواصل

يمكنك أيضًا رفع السيرة الذاتية أو المستندات أو الروابط أو الصور أو الرسائل الصوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `💼 已选择找工作 / 提交简历。

请用您自己的话填写详细信息。

请包括：
• 您想要的职位
• 您的位置
• 您的经验或技能
• 全职、兼职、远程或合同
• 最佳联系时间

您也可以上传简历、文件、链接、图片或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}

if (lower === "14") {
  session.selectedService = "JOB_OPPORTUNITIES";
  session.lastServiceJobId = null;
  session.pendingFile = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(from, pickText(session.language, {
    en: `💼 Job Opportunities selected.

Please type the details in your own words.

Include:
• Type of job or profession you want
• Your location
• Your skills or experience
• Availability
• Best contact time

You may also send your CV/resume, documents, links, pictures, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `💼 Oportunidades de trabajo seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Tipo de trabajo o profesión que desea
• Su ubicación
• Sus habilidades o experiencia
• Disponibilidad
• Mejor hora de contacto

También puede enviar su CV, documentos, enlaces, fotos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `💼 Offres d'emploi sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Type de travail ou profession souhaitée
• Votre emplacement
• Vos compétences ou votre expérience
• Disponibilité
• Meilleur moment pour vous contacter

Vous pouvez aussi envoyer votre CV, documents, liens, photos ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `💼 Jobangebote ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Gewünschter Job oder Beruf
• Ihren Standort
• Ihre Fähigkeiten oder Erfahrung
• Verfügbarkeit
• Beste Kontaktzeit

Sie können auch Ihren Lebenslauf, Dokumente, Links, Bilder oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `💼 Oportunidades de emprego selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Tipo de trabalho ou profissão desejada
• Sua localização
• Suas habilidades ou experiência
• Disponibilidade
• Melhor horário para contato

Você também pode enviar seu currículo, documentos, links, fotos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `💼 تم اختيار فرص عمل.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• نوع العمل أو المهنة المطلوبة
• موقعك
• مهاراتك أو خبرتك
• التوفر
• أفضل وقت للتواصل

يمكنك أيضًا إرسال السيرة الذاتية أو المستندات أو الروابط أو الصور أو الرسائل الصوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `💼 已选择工作机会。

请用您自己的话填写详细信息。

请包括：
• 您想要的工作或职业类型
• 您的位置
• 您的技能或经验
• 可工作时间
• 最佳联系时间

您也可以发送简历、文件、链接、图片或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}

if (lower === "15") {
  session.selectedService = "HIRE_WORKER";
  session.lastServiceJobId = null;
  session.pendingFile = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(from, pickText(session.language, {
    en: `👷 HIRE A WORKER

Please describe the worker you need.

Examples:
- Graphic designer
- Electrician
- Plumber
- Video editor
- Carpenter

You can also send voice note.`,
    es: `👷 CONTRATAR TRABAJADOR

Describa el trabajador que necesita.

Ejemplos:
- Diseñador gráfico
- Electricista
- Plomero
- Editor de video
- Carpintero

También puede enviar una nota de voz.`,
    fr: `👷 EMBAUCHER UN TRAVAILLEUR

Veuillez décrire le travailleur dont vous avez besoin.

Exemples :
- Graphiste
- Électricien
- Plombier
- Monteur vidéo
- Menuisier

Vous pouvez aussi envoyer une note vocale.`,
    de: `👷 ARBEITER EINSTELLEN

Bitte beschreiben Sie den Arbeiter, den Sie benötigen.

Beispiele:
- Grafikdesigner
- Elektriker
- Klempner
- Videoeditor
- Tischler

Sie können auch eine Sprachnachricht senden.`,
    pt: `👷 CONTRATAR TRABALHADOR

Descreva o trabalhador de que você precisa.

Exemplos:
- Designer gráfico
- Eletricista
- Encanador
- Editor de vídeo
- Carpinteiro

Você também pode enviar uma mensagem de voz.`,
    ar: `👷 توظيف عامل

يرجى وصف العامل الذي تحتاجه.

أمثلة:
- مصمم جرافيك
- كهربائي
- سباك
- محرر فيديو
- نجار

يمكنك أيضًا إرسال رسالة صوتية.`,
    zh: `👷 雇用工人

请描述您需要的工人。

例如：
- 平面设计师
- 电工
- 水管工
- 视频编辑
- 木工

您也可以发送语音说明。`
  }));

  return res.sendStatus(200);
}

if (lower === "16") {
  session.selectedService = "COMMUNITY_ALERT";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "COMMUNITY_ALERT_WAITING";

  await sendMessage(from, pickText(session.language, {
    en: `🚨 COMMUNITY ALERT

Please send:

• Picture/video of incident
• Description
• Location

This information will be reviewed before broadcasting.`,
    es: `🚨 ALERTA COMUNITARIA

Envíe:

• Foto/video del incidente
• Descripción
• Ubicación

Esta información será revisada antes de publicarse.`,
    fr: `🚨 ALERTE COMMUNAUTAIRE

Veuillez envoyer :

• Photo/vidéo de l'incident
• Description
• Lieu

Ces informations seront vérifiées avant toute diffusion.`,
    de: `🚨 GEMEINSCHAFTSALARM

Bitte senden Sie:

• Foto/Video des Vorfalls
• Beschreibung
• Standort

Diese Informationen werden vor der Veröffentlichung geprüft.`,
    pt: `🚨 ALERTA COMUNITÁRIO

Envie:

• Foto/vídeo do incidente
• Descrição
• Localização

Essas informações serão analisadas antes da divulgação.`,
    ar: `🚨 تنبيه مجتمعي

يرجى إرسال:

• صورة/فيديو للحادث
• وصف
• الموقع

سيتم مراجعة هذه المعلومات قبل النشر.`,
    zh: `🚨 社区警报

请发送：

• 事件图片/视频
• 描述
• 位置

这些信息将在发布前进行审核。`
  }));

  return res.sendStatus(200);
}

if (lower === "17") {
  session.selectedService = "TRUSTED_SUPPLIERS";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(from, pickText(session.language, {
    en: `🏪 Trusted Suppliers selected.

Please type the details in your own words.

Include:
• Product or supplier category needed
• Quantity or estimated order size
• Your location or delivery destination
• Budget or target price
• Preferred delivery date

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🏪 Proveedores confiables seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Producto o categoría de proveedor necesaria
• Cantidad o tamaño estimado del pedido
• Su ubicación o destino de entrega
• Presupuesto o precio objetivo
• Fecha de entrega preferida

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🏪 Fournisseurs fiables sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Produit ou catégorie de fournisseur souhaité
• Quantité ou taille estimée de la commande
• Votre position ou destination de livraison
• Budget ou prix souhaité
• Date de livraison souhaitée

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🏪 Vertrauenswürdige Lieferanten ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Benötigtes Produkt oder Lieferantenkategorie
• Menge oder geschätzte Bestellgröße
• Ihren Standort oder Lieferziel
• Budget oder Zielpreis
• Gewünschtes Lieferdatum

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🏪 Fornecedores confiáveis selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Produto ou categoria de fornecedor necessária
• Quantidade ou tamanho estimado do pedido
• Sua localização ou destino de entrega
• Orçamento ou preço desejado
• Data de entrega preferida

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🏪 تم اختيار موردين موثوقين.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• المنتج أو فئة المورد المطلوبة
• الكمية أو حجم الطلب المتوقع
• موقعك أو وجهة التسليم
• الميزانية أو السعر المطلوب
• تاريخ التسليم المفضل

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🏪 已选择可信供应商。

请用您自己的话填写详细信息。

请包括：
• 需要的产品或供应商类别
• 数量或预计订单规模
• 您的位置或送货目的地
• 预算或目标价格
• 首选送货日期

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}

if (lower === "18") {
  session.selectedService = "BUY_LAND_RESELL";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(from, pickText(session.language, {
    en: `🏞️ Buy Land for Use or Resell selected.

Please type what you need in your own words.
Example:
I want land in Nigeria for resale. My budget is ₦5 million.

Send your details below:

You can also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🏞️ Comprar terreno para usar o revender seleccionado.

Por favor escriba lo que necesita con sus propias palabras.
Ejemplo:
Quiero un terreno en Nigeria para reventa. Mi presupuesto es de ₦5 millones.

Envíe sus detalles a continuación:

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🏞️ Achat de terrain pour usage ou revente sélectionné.

Veuillez décrire vos besoins avec vos propres mots.
Exemple :
Je veux un terrain au Nigeria pour la revente. Mon budget est de ₦5 millions.

Envoyez vos informations ci-dessous :

Vous pouvez également envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🏞️ Land zum Nutzen oder Weiterverkaufen ausgewählt.

Bitte beschreiben Sie Ihren Bedarf mit Ihren eigenen Worten.
Beispiel:
Ich möchte Land in Nigeria zum Weiterverkaufen. Mein Budget beträgt ₦5 Millionen.

Senden Sie Ihre Angaben unten:

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🏞️ Comprar terreno para usar ou revender selecionado.

Por favor descreva o que você precisa com suas próprias palavras.
Exemplo:
Quero um terreno na Nigéria para revenda. Meu orçamento é de ₦5 milhões.

Envie seus detalhes abaixo:

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🏞️ تم اختيار شراء أرض للاستخدام أو إعادة البيع.

يرجى كتابة ما تحتاجه بكلماتك الخاصة.
مثال:
أريد أرضًا في نيجيريا لإعادة البيع. ميزانيتي ₦5 ملايين.

أرسل التفاصيل الخاصة بك أدناه:

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🏞️ 已选择购买土地自用或转售。

请用您自己的话描述您的需求。
示例：
我想在尼日利亚购买土地用于转售，预算为₦500万。

请在下方发送您的详细信息：

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}

if (lower === "19") {
  session.selectedService = "CURRENCY_EXCHANGE";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(from, pickText(session.language, {
    en: `💱 Currency Exchange selected.

Please type what you need in your own words.
Example:
I have USD and need Nigerian Naira. Amount: $5,000. Location: New Jersey.

Send your details below:

You can also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `💱 Cambio de moneda seleccionado.

Por favor escriba lo que necesita con sus propias palabras.
Ejemplo:
Tengo dólares y necesito naira nigeriana. Monto: $5,000. Ubicación: New Jersey.

Envíe sus detalles a continuación:

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `💱 Change de monnaie sélectionné.

Veuillez décrire vos besoins avec vos propres mots.
Exemple :
J'ai des dollars américains et j'ai besoin de nairas nigérians. Montant : 5 000 $. Lieu : New Jersey.

Envoyez vos informations ci-dessous :

Vous pouvez également envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `💱 Geldwechsel ausgewählt.

Bitte beschreiben Sie Ihren Bedarf mit Ihren eigenen Worten.
Beispiel:
Ich habe US-Dollar und brauche nigerianische Naira. Betrag: 5.000 $. Standort: New Jersey.

Senden Sie Ihre Angaben unten:

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `💱 Câmbio selecionado.

Por favor descreva o que você precisa com suas próprias palavras.
Exemplo:
Tenho dólares e preciso de naira nigeriana. Valor: US$ 5.000. Localização: New Jersey.

Envie seus detalhes abaixo:

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `💱 تم اختيار تحويل العملات.

يرجى كتابة ما تحتاجه بكلماتك الخاصة.
مثال:
لدي دولارات وأحتاج إلى نايرا نيجيرية. المبلغ: 5,000 دولار. الموقع: نيوجيرسي.

أرسل التفاصيل الخاصة بك أدناه:

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `💱 已选择货币兑换。

请用您自己的话描述您的需求。
示例：
我有美元，需要兑换成尼日利亚奈拉。金额：5,000美元。位置：新泽西。

请在下方发送您的详细信息：

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}

if (lower === "20") {
  session.selectedService = "SOCIAL_MEDIA_CREATOR";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(from, pickText(session.language, {
    en: `📱 Social Media Creator selected.

Please type the details in your own words.

Include:
• Type of content you need
• Platform such as TikTok, Instagram, Facebook, or YouTube
• Topic, product, or business name
• Sample, idea, or brand style
• Preferred deadline

You may also send pictures, videos, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `📱 Creador de redes sociales seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Tipo de contenido que necesita
• Plataforma como TikTok, Instagram, Facebook o YouTube
• Tema, producto o nombre del negocio
• Muestra, idea o estilo de marca
• Fecha límite preferida

También puede enviar fotos, videos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `📱 Créateur de réseaux sociaux sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Type de contenu souhaité
• Plateforme comme TikTok, Instagram, Facebook ou YouTube
• Sujet, produit ou nom de l'entreprise
• Exemple, idée ou style de marque
• Date limite souhaitée

Vous pouvez aussi envoyer des photos, vidéos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `📱 Social-Media-Ersteller ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Art des benötigten Inhalts
• Plattform wie TikTok, Instagram, Facebook oder YouTube
• Thema, Produkt oder Firmenname
• Beispiel, Idee oder Markenstil
• Gewünschte Frist

Sie können auch Bilder, Videos, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `📱 Criador de mídia social selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Tipo de conteúdo necessário
• Plataforma como TikTok, Instagram, Facebook ou YouTube
• Tema, produto ou nome da empresa
• Exemplo, ideia ou estilo da marca
• Prazo preferido

Você também pode enviar fotos, vídeos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `📱 تم اختيار منشئ محتوى وسائل التواصل.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• نوع المحتوى المطلوب
• المنصة مثل TikTok أو Instagram أو Facebook أو YouTube
• الموضوع أو المنتج أو اسم العمل
• مثال أو فكرة أو أسلوب العلامة التجارية
• الموعد النهائي المفضل

يمكنك أيضًا إرسال صور أو فيديوهات أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `📱 已选择社交媒体创作者。

请用您自己的话填写详细信息。

请包括：
• 需要的内容类型
• 平台，例如 TikTok、Instagram、Facebook 或 YouTube
• 主题、产品或商家名称
• 样例、想法或品牌风格
• 首选完成时间

您也可以发送图片、视频、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}

if (lower === "21") {
  session.selectedService = "BUY_RESELL_AUTO";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(from, pickText(session.language, {
    en: `🚘 Buy & Resell Auto selected.
Please type the details in your own words.

Include details like:
• Vehicle make, model, and year
• Buy, sell, or resell
• Budget or asking price
• Location

Example:
I want to buy a 2015 Toyota Camry for resale. My budget is $6,000. Location: Newark, New Jersey.

Send your details below:

You can also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🚘 Comprar y revender autos seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya detalles como:
• Marca, modelo y año del vehículo
• Comprar, vender o revender
• Presupuesto o precio solicitado
• Ubicación

Ejemplo:
Quiero comprar un Toyota Camry 2015 para revender. Mi presupuesto es de $6,000. Ubicación: Newark, New Jersey.

Envíe sus detalles a continuación:

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🚘 Achat et revente automobile sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez des détails comme :
• Marque, modèle et année du véhicule
• Acheter, vendre ou revendre
• Budget ou prix demandé
• Lieu

Exemple :
Je veux acheter une Toyota Camry 2015 pour la revente. Mon budget est de 6 000 $. Lieu : Newark, New Jersey.

Envoyez vos informations ci-dessous :

Vous pouvez également envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🚘 Autos kaufen und weiterverkaufen ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Geben Sie Details an wie:
• Fahrzeugmarke, Modell und Baujahr
• Kaufen, verkaufen oder weiterverkaufen
• Budget oder Preisvorstellung
• Standort

Beispiel:
Ich möchte einen Toyota Camry 2015 zum Weiterverkaufen kaufen. Mein Budget beträgt 6.000 $. Standort: Newark, New Jersey.

Senden Sie Ihre Angaben unten:

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🚘 Comprar e revender carros selecionado.

Por favor escreva os detalhes com suas próprias palavras.

Inclua detalhes como:
• Marca, modelo e ano do veículo
• Comprar, vender ou revender
• Orçamento ou preço pedido
• Localização

Exemplo:
Quero comprar um Toyota Camry 2015 para revenda. Meu orçamento é de US$ 6.000. Localização: Newark, New Jersey.

Envie seus detalhes abaixo:

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🚘 تم اختيار شراء وإعادة بيع السيارات.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر تفاصيل مثل:
• ماركة السيارة والموديل والسنة
• شراء أو بيع أو إعادة بيع
• الميزانية أو السعر المطلوب
• الموقع

مثال:
أريد شراء Toyota Camry 2015 لإعادة البيع. ميزانيتي 6,000 دولار. الموقع: نيوارك، نيوجيرسي.

أرسل التفاصيل الخاصة بك أدناه:

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🚘 已选择买卖 / 转售汽车。

请用您自己的话填写详细信息。

请包括以下信息：
• 车辆品牌、型号和年份
• 购买、出售或转售
• 预算或要价
• 位置

示例：
我想购买一辆 2015 年 Toyota Camry 用于转售，预算为 6,000 美元。位置：新泽西纽瓦克。

请在下方发送您的详细信息：

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}

if (lower === "22") {
  session.selectedService = "CAR_LOAN_FINANCING";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🚗💰 Car Loan / Auto Financing selected.

Please type the details in your own words.

Include details like:
• Your location or country
• Vehicle make, model, and year
• Loan amount or budget
• Employment or income status
• Best contact time

Example:
I need a car loan for a 2018 Toyota Corolla. My budget is $12,000. I work full-time. Location: New Jersey.

Send your details below:

You can also send pictures, links, documents, or voice notes.

PATAPATA will connect you with approved providers. Provider commission is handled by the provider, not the customer.`,
    es: `🚗💰 Préstamo de auto / Financiamiento seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya detalles como:
• Su ubicación o país
• Marca, modelo y año del vehículo
• Monto del préstamo o presupuesto
• Estado laboral o de ingresos
• Mejor hora de contacto

Ejemplo:
Necesito un préstamo para un Toyota Corolla 2018. Mi presupuesto es de $12,000. Trabajo tiempo completo. Ubicación: New Jersey.

Envíe sus detalles a continuación:

También puede enviar fotos, enlaces, documentos o notas de voz.

PATAPATA lo conectará con proveedores aprobados. La comisión la paga el proveedor, no el cliente.`,
    fr: `🚗💰 Prêt auto / Financement sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez des détails comme :
• Votre lieu ou pays
• Marque, modèle et année du véhicule
• Montant du prêt ou budget
• Situation professionnelle ou revenus
• Meilleur moment pour vous contacter

Exemple :
J'ai besoin d'un prêt auto pour une Toyota Corolla 2018. Mon budget est de 12 000 $. Je travaille à temps plein. Lieu : New Jersey.

Envoyez vos informations ci-dessous :

Vous pouvez également envoyer des photos, liens, documents ou messages vocaux.

PATAPATA vous mettra en relation avec des fournisseurs approuvés. La commission est payée par le fournisseur, pas par le client.`,
    de: `🚗💰 Autokredit / Finanzierung ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Geben Sie Details an wie:
• Ihr Standort oder Land
• Fahrzeugmarke, Modell und Baujahr
• Kreditbetrag oder Budget
• Beschäftigungs- oder Einkommensstatus
• Beste Kontaktzeit

Beispiel:
Ich brauche einen Autokredit für einen Toyota Corolla 2018. Mein Budget beträgt 12.000 $. Ich arbeite Vollzeit. Standort: New Jersey.

Senden Sie Ihre Angaben unten:

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

PATAPATA verbindet Sie mit geprüften Anbietern. Die Provision wird vom Anbieter bezahlt, nicht vom Kunden.`,
    pt: `🚗💰 Empréstimo de carro / Financiamento selecionado.

Por favor escreva os detalhes com suas próprias palavras.

Inclua detalhes como:
• Sua localização ou país
• Marca, modelo e ano do veículo
• Valor do empréstimo ou orçamento
• Situação de emprego ou renda
• Melhor horário para contato

Exemplo:
Preciso de um empréstimo para um Toyota Corolla 2018. Meu orçamento é de US$ 12.000. Trabalho em tempo integral. Localização: New Jersey.

Envie seus detalhes abaixo:

Você também pode enviar fotos, links, documentos ou mensagens de voz.

A PATAPATA conectará você a provedores aprovados. A comissão é paga pelo provedor, não pelo cliente.`,
    ar: `🚗💰 تم اختيار قرض سيارة / تمويل.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر تفاصيل مثل:
• موقعك أو بلدك
• ماركة السيارة والموديل والسنة
• مبلغ القرض أو الميزانية
• حالة العمل أو الدخل
• أفضل وقت للتواصل

مثال:
أحتاج إلى قرض سيارة لـ Toyota Corolla 2018. ميزانيتي 12,000 دولار. أعمل بدوام كامل. الموقع: نيوجيرسي.

أرسل التفاصيل الخاصة بك أدناه:

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

ستوصلك PATAPATA بمقدمي خدمات معتمدين. العمولة يدفعها مقدم الخدمة وليس العميل.`,
    zh: `🚗💰 已选择汽车贷款 / 汽车融资。

请用您自己的话填写详细信息。

请包括以下信息：
• 您的位置或国家
• 车辆品牌、型号和年份
• 贷款金额或预算
• 就业或收入情况
• 最佳联系时间

示例：
我需要为一辆 2018 年 Toyota Corolla 申请汽车贷款。预算为 12,000 美元。我是全职工作。位置：新泽西。

请在下方发送您的详细信息：

您也可以发送图片、链接、文件或语音消息。

PATAPATA 会为您连接已审核的服务商。服务商佣金由服务商承担，不由客户承担。`
  }));
  return res.sendStatus(200);
}

if (lower === "23") {
  session.selectedService = "CAR_INSURANCE";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🛡️ Car Insurance selected.

Please type the details in your own words.

Include:
• Your location or country
• Vehicle make, model, and year
• Current insurance status
• Coverage needed
• Best contact time

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🛡️ Seguro de auto seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Su ubicación o país
• Marca, modelo y año del vehículo
• Estado actual del seguro
• Cobertura necesaria
• Mejor hora de contacto

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🛡️ Assurance auto sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Votre emplacement ou pays
• Marque, modèle et année du véhicule
• Statut actuel de l'assurance
• Couverture souhaitée
• Meilleur moment pour vous contacter

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🛡️ Autoversicherung ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Ihr Standort oder Land
• Fahrzeugmarke, Modell und Baujahr
• Aktueller Versicherungsstatus
• Benötigte Deckung
• Beste Kontaktzeit

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🛡️ Seguro de carro selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Sua localização ou país
• Marca, modelo e ano do veículo
• Status atual do seguro
• Cobertura necessária
• Melhor horário para contato

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🛡️ تم اختيار تأمين السيارات.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• موقعك أو بلدك
• ماركة السيارة وموديلها وسنتها
• حالة التأمين الحالية
• التغطية المطلوبة
• أفضل وقت للتواصل

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🛡️ 已选择汽车保险。

请用您自己的话填写详细信息。

请包括：
• 您的位置或国家
• 车辆品牌、型号和年份
• 当前保险状态
• 需要的保险范围
• 最佳联系时间

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "24") {
  session.selectedService = "CAR_RENTAL";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🚙 Car Rental Services selected.

Please type the details in your own words.

Include:
• Pickup city or location
• Rental start and return date
• Vehicle type needed
• Driver needed or self-drive
• Budget range

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🚙 Servicios de alquiler de autos seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Ciudad o lugar de recogida
• Fecha de inicio y devolución
• Tipo de vehículo necesario
• Con conductor o sin conductor
• Rango de presupuesto

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🚙 Services de location de voiture sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Ville ou lieu de prise en charge
• Date de début et de retour
• Type de véhicule souhaité
• Avec chauffeur ou sans chauffeur
• Fourchette de budget

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🚙 Autovermietung ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Abholstadt oder Standort
• Start- und Rückgabedatum
• Benötigter Fahrzeugtyp
• Mit Fahrer oder Selbstfahrer
• Budgetrahmen

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🚙 Serviços de aluguel de carros selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Cidade ou local de retirada
• Data de início e devolução
• Tipo de veículo necessário
• Com motorista ou sem motorista
• Faixa de orçamento

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🚙 تم اختيار خدمات تأجير السيارات.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• مدينة أو موقع الاستلام
• تاريخ البداية والإرجاع
• نوع السيارة المطلوبة
• مع سائق أو قيادة ذاتية
• نطاق الميزانية

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🚙 已选择汽车租赁服务。

请用您自己的话填写详细信息。

请包括：
• 取车城市或地点
• 租车开始和归还日期
• 需要的车辆类型
• 需要司机或自驾
• 预算范围

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "25") {
  session.selectedService = "MOBILE_APP_DEVELOPMENT";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `📱 Mobile App Development selected.

Please type the details in your own words.

Include:
• Your location
• App idea or business type
• Android, iPhone, or both
• Main features needed
• Budget range and timeline

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `📱 Desarrollo de aplicaciones móviles seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Su ubicación
• Idea de la app o tipo de negocio
• Android, iPhone o ambos
• Funciones principales necesarias
• Presupuesto y tiempo estimado

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `📱 Développement d'application mobile sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Votre emplacement
• Idée d'application ou type d'entreprise
• Android, iPhone ou les deux
• Fonctionnalités principales souhaitées
• Budget et délai

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `📱 Mobile-App-Entwicklung ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Ihr Standort
• App-Idee oder Geschäftstyp
• Android, iPhone oder beides
• Benötigte Hauptfunktionen
• Budget und Zeitplan

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `📱 Desenvolvimento de aplicativo móvel selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Sua localização
• Ideia do aplicativo ou tipo de negócio
• Android, iPhone ou ambos
• Principais recursos necessários
• Orçamento e prazo

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `📱 تم اختيار تطوير تطبيقات الجوال.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• موقعك
• فكرة التطبيق أو نوع العمل
• أندرويد أو آيفون أو كلاهما
• الميزات الرئيسية المطلوبة
• الميزانية والجدول الزمني

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `📱 已选择手机应用开发。

请用您自己的话填写详细信息。

请包括：
• 您的位置
• 应用想法或业务类型
• Android、iPhone 或两者都要
• 所需主要功能
• 预算和时间安排

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "26") {
  session.selectedService = "HOTEL_RESERVATION";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🏨 Hotel Reservation selected.

Please type the details in your own words.

Include:
• Destination city or country
• Check-in and check-out dates
• Number of guests
• Room type or hotel preference
• Budget range and best contact time

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🏨 Reserva de hotel seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Ciudad o país de destino
• Fechas de entrada y salida
• Número de huéspedes
• Tipo de habitación o preferencia de hotel
• Presupuesto y mejor hora de contacto

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🏨 Réservation d'hôtel sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Ville ou pays de destination
• Dates d'arrivée et de départ
• Nombre de voyageurs
• Type de chambre ou préférence d'hôtel
• Budget et meilleur moment pour vous contacter

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🏨 Hotelreservierung ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Zielstadt oder Zielland
• Check-in- und Check-out-Datum
• Anzahl der Gäste
• Zimmertyp oder Hotelwunsch
• Budget und beste Kontaktzeit

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🏨 Reserva de hotel selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Cidade ou país de destino
• Datas de check-in e check-out
• Número de hóspedes
• Tipo de quarto ou preferência de hotel
• Orçamento e melhor horário para contato

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🏨 تم اختيار حجز فندق.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• مدينة أو بلد الوجهة
• تاريخ الوصول والمغادرة
• عدد الضيوف
• نوع الغرفة أو الفندق المفضل
• الميزانية وأفضل وقت للتواصل

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🏨 已选择酒店预订。

请用您自己的话填写详细信息。

请包括：
• 目的地城市或国家
• 入住和退房日期
• 客人人数
• 房型或酒店偏好
• 预算和最佳联系时间

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "27") {
  session.selectedService = "HOME_SECURITY_TECHNICIAN";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🏠🔐 Home Security Technician selected.

Please type the details in your own words.

Include:
• Your location
• Type of security service needed
• House, office, store, or warehouse
• Preferred service date and time

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🏠🔐 Técnico de seguridad para el hogar seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Su ubicación
• Tipo de servicio de seguridad necesario
• Casa, oficina, tienda o almacén
• Fecha y hora preferidas del servicio

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🏠🔐 Technicien en sécurité résidentielle sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Votre emplacement
• Type de service de sécurité nécessaire
• Maison, bureau, magasin ou entrepôt
• Date et heure souhaitées

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🏠🔐 Haussicherheitstechniker ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Ihr Standort
• Benötigte Sicherheitsdienstleistung
• Haus, Büro, Geschäft oder Lager
• Gewünschtes Datum und Uhrzeit

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🏠🔐 Técnico de segurança residencial selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Sua localização
• Tipo de serviço de segurança necessário
• Casa, escritório, loja ou armazém
• Data e horário preferidos

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🏠🔐 تم اختيار فني أمن المنازل.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• موقعك
• نوع خدمة الأمن المطلوبة
• منزل أو مكتب أو متجر أو مستودع
• التاريخ والوقت المفضلان للخدمة

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🏠🔐 已选择家庭安防技术员。

请用您自己的话填写详细信息。

请包括：
• 您的位置
• 所需安防服务类型
• 住宅、办公室、商店或仓库
• 首选服务日期和时间

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "28") {
  session.selectedService = "LOCKSMITH";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🔑 Locksmith selected.

Please type the details in your own words.

Include:
• Your location
• Lock issue or service needed
• House, office, store, or vehicle
• Emergency or scheduled service

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🔑 Cerrajero seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Su ubicación
• Problema de cerradura o servicio necesario
• Casa, oficina, tienda o vehículo
• Servicio de emergencia o programado

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🔑 Serrurier sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Votre emplacement
• Problème ou service de serrure nécessaire
• Maison, bureau, magasin ou véhicule
• Service d'urgence ou programmé

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🔑 Schlüsseldienst ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Ihr Standort
• Schlossproblem oder benötigter Service
• Haus, Büro, Geschäft oder Fahrzeug
• Notfall oder geplanter Service

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🔑 Chaveiro selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Sua localização
• Problema da fechadura ou serviço necessário
• Casa, escritório, loja ou veículo
• Serviço de emergência ou agendado

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🔑 تم اختيار صانع أقفال.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• موقعك
• مشكلة القفل أو الخدمة المطلوبة
• منزل أو مكتب أو متجر أو سيارة
• خدمة طارئة أو مجدولة

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🔑 已选择锁匠。

请用您自己的话填写详细信息。

请包括：
• 您的位置
• 锁具问题或所需服务
• 住宅、办公室、商店或车辆
• 紧急服务或预约服务

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}


if (lower === "29") {
  session.selectedService = "AI_FLYER_POSTER";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🤖🎨 AI Flyer & Poster Design selected.

Please type the details in your own words.

Include:
• Business, event, or product name
• Text you want on the flyer/poster
• Colors or style you prefer
• Size needed: Facebook, Instagram, WhatsApp Status, print flyer, etc.
• Deadline and best contact time

You may also send logos, pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🤖🎨 Diseño de flyer / póster con IA seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Nombre del negocio, evento o producto
• Texto que desea en el flyer/póster
• Colores o estilo preferido
• Tamaño necesario: Facebook, Instagram, Estado de WhatsApp, flyer impreso, etc.
• Fecha límite y mejor hora de contacto

También puede enviar logos, fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🤖🎨 Création de flyer / affiche IA sélectionnée.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Nom de l'entreprise, de l'événement ou du produit
• Texte à mettre sur le flyer/l'affiche
• Couleurs ou style souhaités
• Format nécessaire : Facebook, Instagram, statut WhatsApp, flyer imprimé, etc.
• Date limite et meilleur moment pour vous contacter

Vous pouvez aussi envoyer des logos, photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🤖🎨 KI-Flyer- und Posterdesign ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Geschäfts-, Event- oder Produktname
• Text für den Flyer/das Poster
• Gewünschte Farben oder Stil
• Benötigte Größe: Facebook, Instagram, WhatsApp-Status, Druckflyer usw.
• Deadline und beste Kontaktzeit

Sie können auch Logos, Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🤖🎨 Design de flyer / pôster com IA selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Nome do negócio, evento ou produto
• Texto para colocar no flyer/pôster
• Cores ou estilo preferido
• Tamanho necessário: Facebook, Instagram, Status do WhatsApp, flyer impresso, etc.
• Prazo e melhor horário para contato

Você também pode enviar logos, fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🤖🎨 تم اختيار تصميم منشور / بوستر بالذكاء الاصطناعي.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• اسم النشاط أو الحدث أو المنتج
• النص المطلوب على المنشور/البوستر
• الألوان أو الأسلوب المفضل
• المقاس المطلوب: Facebook أو Instagram أو حالة WhatsApp أو منشور للطباعة وغيرها
• الموعد النهائي وأفضل وقت للتواصل

يمكنك أيضًا إرسال الشعارات أو الصور أو الروابط أو المستندات أو الرسائل الصوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🤖🎨 已选择 AI 传单 / 海报设计。

请用您自己的话填写详细信息。

请包括：
• 商家、活动或产品名称
• 您想放在传单/海报上的文字
• 喜欢的颜色或风格
• 需要的尺寸：Facebook、Instagram、WhatsApp 状态、打印传单等
• 截止时间和最佳联系时间

您也可以发送 logo、图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "30") {
  session.selectedService = "AI_CARTOON_VIDEO";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🤖🎬 AI Cartoon Video Creation selected.

Please type the details in your own words.

Include:
• Cartoon character idea or name
• What the character should say
• Male or female voice
• Video length: 15 sec, 30 sec, 1 min, etc.
• Style: funny, birthday, business ad, church, real estate, kids story, etc.
• Music or dance preference, if any

You may also send pictures, logos, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🤖🎬 Creación de video cartoon con IA seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Idea o nombre del personaje
• Lo que el personaje debe decir
• Voz masculina o femenina
• Duración: 15 seg, 30 seg, 1 min, etc.
• Estilo: divertido, cumpleaños, anuncio de negocio, iglesia, bienes raíces, historia infantil, etc.
• Música o baile preferido, si tiene

También puede enviar fotos, logos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🤖🎬 Création de vidéo cartoon IA sélectionnée.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Idée ou nom du personnage cartoon
• Ce que le personnage doit dire
• Voix masculine ou féminine
• Durée : 15 s, 30 s, 1 min, etc.
• Style : drôle, anniversaire, publicité, église, immobilier, histoire pour enfants, etc.
• Musique ou danse souhaitée, si besoin

Vous pouvez aussi envoyer des photos, logos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🤖🎬 KI-Cartoon-Videoerstellung ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Cartoon-Figur-Idee oder Name
• Was die Figur sagen soll
• Männliche oder weibliche Stimme
• Videolänge: 15 Sek., 30 Sek., 1 Min. usw.
• Stil: lustig, Geburtstag, Geschäftswerbung, Kirche, Immobilien, Kindergeschichte usw.
• Musik- oder Tanzwunsch, falls vorhanden

Sie können auch Bilder, Logos, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🤖🎬 Criação de vídeo cartoon com IA selecionada.

Digite os detalhes com suas próprias palavras.

Inclua:
• Ideia ou nome do personagem
• O que o personagem deve dizer
• Voz masculina ou feminina
• Duração: 15 seg, 30 seg, 1 min, etc.
• Estilo: engraçado, aniversário, anúncio de negócio, igreja, imóveis, história infantil, etc.
• Preferência de música ou dança, se houver

Você também pode enviar fotos, logos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🤖🎬 تم اختيار إنشاء فيديو كرتون بالذكاء الاصطناعي.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• فكرة أو اسم الشخصية الكرتونية
• ماذا يجب أن تقول الشخصية
• صوت ذكر أو أنثى
• مدة الفيديو: 15 ثانية أو 30 ثانية أو دقيقة وغيرها
• الأسلوب: مضحك أو عيد ميلاد أو إعلان تجاري أو كنيسة أو عقار أو قصة أطفال وغيرها
• تفضيل الموسيقى أو الرقص إن وجد

يمكنك أيضًا إرسال الصور أو الشعارات أو الروابط أو المستندات أو الرسائل الصوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🤖🎬 已选择 AI 卡通视频制作。

请用您自己的话填写详细信息。

请包括：
• 卡通角色想法或名字
• 角色需要说的话
• 男声或女声
• 视频长度：15 秒、30 秒、1 分钟等
• 风格：搞笑、生日、商业广告、教会、房地产、儿童故事等
• 是否需要音乐或跳舞

您也可以发送图片、logo、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "31") {
  session.selectedService = "AI_SOCIAL_MEDIA_CONTENT";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🤖📱 AI Social Media Content selected.

Please type the details in your own words.

Include:
• Business, product, service, or event name
• What you want to promote
• Platform: Facebook, Instagram, TikTok, WhatsApp, YouTube, etc.
• Tone: professional, funny, emotional, luxury, urgent, etc.
• Any phone number, link, or location to include

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🤖📱 Contenido para redes sociales con IA seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Nombre del negocio, producto, servicio o evento
• Qué desea promocionar
• Plataforma: Facebook, Instagram, TikTok, WhatsApp, YouTube, etc.
• Tono: profesional, divertido, emocional, lujo, urgente, etc.
• Teléfono, enlace o ubicación para incluir

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🤖📱 Contenu réseaux sociaux IA sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Nom de l'entreprise, du produit, du service ou de l'événement
• Ce que vous voulez promouvoir
• Plateforme : Facebook, Instagram, TikTok, WhatsApp, YouTube, etc.
• Ton : professionnel, drôle, émotionnel, luxe, urgent, etc.
• Numéro, lien ou lieu à inclure

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🤖📱 KI-Social-Media-Inhalte ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Geschäfts-, Produkt-, Service- oder Eventname
• Was Sie bewerben möchten
• Plattform: Facebook, Instagram, TikTok, WhatsApp, YouTube usw.
• Ton: professionell, lustig, emotional, luxuriös, dringend usw.
• Telefonnummer, Link oder Standort zum Einfügen

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🤖📱 Conteúdo de mídia social com IA selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Nome do negócio, produto, serviço ou evento
• O que deseja promover
• Plataforma: Facebook, Instagram, TikTok, WhatsApp, YouTube, etc.
• Tom: profissional, engraçado, emocional, luxo, urgente, etc.
• Telefone, link ou localização para incluir

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🤖📱 تم اختيار محتوى وسائل التواصل بالذكاء الاصطناعي.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• اسم النشاط أو المنتج أو الخدمة أو الحدث
• ما الذي تريد الترويج له
• المنصة: Facebook أو Instagram أو TikTok أو WhatsApp أو YouTube وغيرها
• الأسلوب: احترافي أو مضحك أو عاطفي أو فاخر أو عاجل وغيرها
• رقم الهاتف أو الرابط أو الموقع لإضافته

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🤖📱 已选择 AI 社交媒体内容。

请用您自己的话填写详细信息。

请包括：
• 商家、产品、服务或活动名称
• 您想推广的内容
• 平台：Facebook、Instagram、TikTok、WhatsApp、YouTube 等
• 语气：专业、搞笑、感人、高端、紧急等
• 需要加入的电话号码、链接或位置

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "32") {
  session.selectedService = "AI_RESUME_CV";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🤖📄 Resume / CV Creation selected.

Please type the details in your own words.

Include:
• Job position you want
• Work experience
• Education
• Skills
• Country or job market you are applying for
• Any old CV/resume, if available

You may also send documents, pictures, links, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🤖📄 Creación de CV / Resume seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Puesto que desea
• Experiencia laboral
• Educación
• Habilidades
• País o mercado laboral donde aplica
• CV anterior, si tiene

También puede enviar documentos, fotos, enlaces o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🤖📄 Création de CV / résumé sélectionnée.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Poste souhaité
• Expérience professionnelle
• Formation
• Compétences
• Pays ou marché d'emploi visé
• Ancien CV, si disponible

Vous pouvez aussi envoyer des documents, photos, liens ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🤖📄 Lebenslauf-Erstellung ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Gewünschte Stelle
• Berufserfahrung
• Ausbildung
• Fähigkeiten
• Land oder Arbeitsmarkt, für den Sie sich bewerben
• Alter Lebenslauf, falls vorhanden

Sie können auch Dokumente, Bilder, Links oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🤖📄 Criação de currículo / CV selecionada.

Digite os detalhes com suas próprias palavras.

Inclua:
• Cargo desejado
• Experiência profissional
• Educação
• Habilidades
• País ou mercado de trabalho onde vai se candidatar
• Currículo antigo, se tiver

Você também pode enviar documentos, fotos, links ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🤖📄 تم اختيار إنشاء السيرة الذاتية.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• الوظيفة التي تريدها
• الخبرة العملية
• التعليم
• المهارات
• الدولة أو سوق العمل الذي تقدم فيه
• سيرة ذاتية قديمة إن وجدت

يمكنك أيضًا إرسال مستندات أو صور أو روابط أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🤖📄 已选择简历 / CV 制作。

请用您自己的话填写详细信息。

请包括：
• 您想申请的职位
• 工作经验
• 教育背景
• 技能
• 申请的国家或就业市场
• 如有旧简历也可以发送

您也可以发送文件、图片、链接或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}





  await sendMessage(from, serviceMenu(session.language));
  return res.sendStatus(200);
}
    if (session.stage === "HIRE_WORKER_MENU" && type === "text") {
  const workerRequest = text.trim();

  const job = await createTextOnlyServiceJob(
    "HIRE_WORKER",
    `Worker needed: ${workerRequest}`
  );

  session.lastServiceJobId = job?.id || null;
  session.stage = "MENU";

  await sendMessage(from, pickText(session.language, {
    en: `✅ Your worker request has been received.

Worker needed: ${workerRequest}

Our team will review available workers and contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `✅ Su solicitud de trabajador ha sido recibida.

Trabajador necesario: ${workerRequest}

Nuestro equipo revisará los trabajadores disponibles y se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `✅ Votre demande de travailleur a été reçue.

Travailleur recherché : ${workerRequest}

Notre équipe vérifiera les travailleurs disponibles et vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `✅ Ihre Arbeiter-Anfrage wurde erhalten.

Benötigter Arbeiter: ${workerRequest}

Unser Team prüft verfügbare Arbeiter und kontaktiert Sie in Kürze per WhatsApp.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `✅ Sua solicitação de trabalhador foi recebida.

Trabalhador necessário: ${workerRequest}

Nossa equipe verificará trabalhadores disponíveis e entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `✅ تم استلام طلب العامل.

العامل المطلوب: ${workerRequest}

سيقوم فريقنا بمراجعة العمال المتاحين والتواصل معك قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `✅ 您的工人请求已收到。

所需工人：${workerRequest}

我们的团队会查看可用工人，并很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}
    if (session.stage === "JOB_OPPORTUNITIES_MENU" && type === "text") {
  const roleMap = {
    "1": "Graphic Designer",
    "2": "Print Operator",
    "3": "Delivery Driver",
    "4": "Video Editor",
    "5": "Customer Support"
  };

  const selectedRole = roleMap[lower];

  if (!selectedRole) {
    await sendMessage(from, pickText(session.language, {
      en: `Please choose a valid role:

1 - Graphic Designer
2 - Print Operator
3 - Delivery Driver
4 - Video Editor
5 - Customer Support`,
      es: `Elija un puesto válido:

1 - Diseñador gráfico
2 - Operador de impresión
3 - Repartidor
4 - Editor de video
5 - Atención al cliente`,
      fr: `Choisissez un poste valide :

1 - Graphiste
2 - Opérateur d'impression
3 - Chauffeur-livreur
4 - Monteur vidéo
5 - Service client`,
      de: `Bitte wählen Sie eine gültige Stelle:

1 - Grafikdesigner
2 - Druckoperator
3 - Lieferfahrer
4 - Videoeditor
5 - Kundendienst`,
      pt: `Escolha uma função válida:

1 - Designer gráfico
2 - Operador de impressão
3 - Motorista de entrega
4 - Editor de vídeo
5 - Atendimento ao cliente`,
      ar: `يرجى اختيار وظيفة صحيحة:

1 - مصمم جرافيك
2 - مشغل طباعة
3 - سائق توصيل
4 - محرر فيديو
5 - خدمة عملاء`,
      zh: `请选择有效职位：

1 - 平面设计师
2 - 打印操作员
3 - 送货司机
4 - 视频编辑
5 - 客户服务`
    }));

    return res.sendStatus(200);
  }

  const job = await createTextOnlyServiceJob(
    "JOB_OPPORTUNITIES",
    `Job application for: ${selectedRole}`
  );

  session.lastServiceJobId = job?.id || null;
  session.stage = "MENU";

  await sendMessage(from, pickText(session.language, {
    en: `✅ Your job interest has been received.

Selected Role: ${selectedRole}

Our recruitment team will contact you shortly on WhatsApp with available opportunities.

To return to the main menu anytime, type Hello.`,
    es: `✅ Su interés laboral ha sido recibido.

Puesto seleccionado: ${selectedRole}

Nuestro equipo de reclutamiento se comunicará pronto por WhatsApp con oportunidades disponibles.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `✅ Votre intérêt pour un emploi a été reçu.

Poste sélectionné : ${selectedRole}

Notre équipe de recrutement vous contactera bientôt sur WhatsApp avec les opportunités disponibles.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `✅ Ihr Interesse an einer Stelle wurde erhalten.

Ausgewählte Stelle: ${selectedRole}

Unser Rekrutierungsteam kontaktiert Sie in Kürze per WhatsApp mit verfügbaren Möglichkeiten.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `✅ Seu interesse em emprego foi recebido.

Função selecionada: ${selectedRole}

Nossa equipe de recrutamento entrará em contato em breve pelo WhatsApp com oportunidades disponíveis.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `✅ تم استلام اهتمامك بالوظيفة.

الوظيفة المختارة: ${selectedRole}

سيتواصل معك فريق التوظيف قريبًا عبر واتساب بالفرص المتاحة.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `✅ 您的求职意向已收到。

选择职位：${selectedRole}

我们的招聘团队会很快通过 WhatsApp 联系您并提供可用机会。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}
    
    if (session.stage === "COMMUNITY_ALERT_WAITING" && type === "text") {
  const alertText = text.trim();

  const job = await createTextOnlyServiceJob(
    "COMMUNITY_ALERT",
    `Community Alert: ${alertText}`
  );

  session.lastServiceJobId = job?.id || null;
  session.stage = "MENU";

  await sendMessage(from, pickText(session.language, {
    en: `🚨 Community alert received.

Our moderation team will review the report before broadcasting it to the community.

To return to the main menu anytime, type Hello.

Thank you for helping keep the community safe.`,
    es: `🚨 Alerta comunitaria recibida.

Nuestro equipo de moderación revisará el reporte antes de publicarlo en la comunidad.

Para volver al menú principal en cualquier momento, escriba Hello.

Gracias por ayudar a mantener segura la comunidad.`,
    fr: `🚨 Alerte communautaire reçue.

Notre équipe de modération examinera le rapport avant toute diffusion à la communauté.

Pour revenir au menu principal à tout moment, tapez Hello.

Merci d'aider à protéger la communauté.`,
    de: `🚨 Gemeinschaftsalarm erhalten.

Unser Moderationsteam prüft die Meldung, bevor sie an die Gemeinschaft gesendet wird.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.

Danke, dass Sie helfen, die Gemeinschaft sicher zu halten.`,
    pt: `🚨 Alerta comunitário recebido.

Nossa equipe de moderação analisará o relatório antes de divulgá-lo à comunidade.

Para voltar ao menu principal a qualquer momento, digite Hello.

Obrigado por ajudar a manter a comunidade segura.`,
    ar: `🚨 تم استلام التنبيه المجتمعي.

سيراجع فريق الإشراف البلاغ قبل نشره للمجتمع.

شكرًا لمساعدتك في الحفاظ على أمان المجتمع.`,
    zh: `🚨 社区警报已收到。

我们的审核团队会先审核报告，然后再向社区发布。

如需随时返回主菜单，请输入 Hello。

感谢您帮助维护社区安全。`
  }));

  return res.sendStatus(200);
}
    if (session.stage === "COMMUNITY_ALERT_WAITING_DETAILS" && type === "text") {
  const alertDetails = text.trim();

  if (session.lastServiceJobId) {
    await attachTextToExistingJob(
      session.lastServiceJobId,
      `Community alert details: ${alertDetails}`
    );
  }

  session.stage = "MENU";

  await sendMessage(from, pickText(session.language, {
    en: `✅ Community alert details received.

Our moderation team will review the media and details before any community broadcast.

To return to the main menu anytime, type Hello.

Thank you for helping keep the community safe.`,
    es: `✅ Detalles de alerta comunitaria recibidos.

Nuestro equipo de moderación revisará los medios y detalles antes de cualquier publicación comunitaria.

Para volver al menú principal en cualquier momento, escriba Hello.

Gracias por ayudar a mantener segura la comunidad.`,
    fr: `✅ Détails de l'alerte communautaire reçus.

Notre équipe de modération examinera les médias et les détails avant toute diffusion.

Pour revenir au menu principal à tout moment, tapez Hello.

Merci d'aider à protéger la communauté.`,
    de: `✅ Details zum Gemeinschaftsalarm erhalten.

Unser Moderationsteam prüft Medien und Details vor jeder Veröffentlichung in der Gemeinschaft.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.

Danke, dass Sie helfen, die Gemeinschaft sicher zu halten.`,
    pt: `✅ Detalhes do alerta comunitário recebidos.

Nossa equipe de moderação analisará a mídia e os detalhes antes de qualquer divulgação.

Para voltar ao menu principal a qualquer momento, digite Hello.

Obrigado por ajudar a manter a comunidade segura.`,
    ar: `✅ تم استلام تفاصيل التنبيه المجتمعي.

سيراجع فريق الإشراف الوسائط والتفاصيل قبل أي نشر مجتمعي.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.

شكرًا لمساعدتك في الحفاظ على أمان المجتمع.`,
    zh: `✅ 社区警报详情已收到。

我们的审核团队会在任何社区发布前审核媒体和详情。

如需随时返回主菜单，请输入 Hello。

感谢您帮助维护社区安全。`
  }));

  return res.sendStatus(200);
}
    if (session.stage === "COMMUNITY_ALERT_WAITING_DETAILS" && type === "audio") {

  if (session.lastServiceJobId && message.audio?.id) {
    await attachAudioToExistingJob(
      session.lastServiceJobId,
      message.audio.id,
      message.audio.mime_type || "audio/ogg"
    );
  }

  session.stage = "MENU";

  await sendMessage(from, pickText(session.language, {
    en: `✅ Community alert voice note received.

Our moderation team will review the media and voice details before any community broadcast.

To return to the main menu anytime, type Hello.

Thank you for helping keep the community safe.`,
    es: `✅ Nota de voz de alerta comunitaria recibida.

Nuestro equipo de moderación revisará los medios y la voz antes de cualquier publicación comunitaria.

Para volver al menú principal en cualquier momento, escriba Hello.

Gracias por ayudar a mantener segura la comunidad.`,
    fr: `✅ Note vocale d'alerte communautaire reçue.

Notre équipe de modération examinera les médias et les détails vocaux avant toute diffusion.

Pour revenir au menu principal à tout moment, tapez Hello.

Merci d'aider à protéger la communauté.`,
    de: `✅ Sprachnachricht zum Gemeinschaftsalarm erhalten.

Unser Moderationsteam prüft Medien und Sprachnotizen vor jeder Veröffentlichung.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.

Danke, dass Sie helfen, die Gemeinschaft sicher zu halten.`,
    pt: `✅ Mensagem de voz do alerta comunitário recebida.

Nossa equipe de moderação analisará a mídia e a voz antes de qualquer divulgação.

Para voltar ao menu principal a qualquer momento, digite Hello.

Obrigado por ajudar a manter a comunidade segura.`,
    ar: `✅ تم استلام الرسالة الصوتية للتنبيه المجتمعي.

سيراجع فريق الإشراف الوسائط والتفاصيل الصوتية قبل أي نشر.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.

شكرًا لمساعدتك في الحفاظ على أمان المجتمع.`,
    zh: `✅ 社区警报语音已收到。

我们的审核团队会在任何社区发布前审核媒体和语音详情。

如需随时返回主菜单，请输入 Hello。

感谢您帮助维护社区安全。`
  }));

  return res.sendStatus(200);
}
    if (session.stage === "SUPPLIER_CATEGORY" && type === "text") {
  const supplierMap = {
    "1": "Printing Materials",
    "2": "Electrical Materials",
    "3": "Building Materials",
    "4": "Fashion Materials",
    "5": "Computer Accessories"
  };

  const selectedCategory = supplierMap[lower];

  if (!selectedCategory) {
    await sendMessage(from, pickText(session.language, {
      en: `Please choose a valid supplier category:

1 - Printing Materials
2 - Electrical Materials
3 - Building Materials
4 - Fashion Materials
5 - Computer Accessories`,
      es: `Elija una categoría de proveedor válida:

1 - Materiales de impresión
2 - Materiales eléctricos
3 - Materiales de construcción
4 - Materiales de moda
5 - Accesorios de computadora`,
      fr: `Choisissez une catégorie de fournisseur valide :

1 - Matériel d'impression
2 - Matériel électrique
3 - Matériaux de construction
4 - Matériel de mode
5 - Accessoires informatiques`,
      de: `Bitte wählen Sie eine gültige Lieferantenkategorie:

1 - Druckmaterialien
2 - Elektromaterialien
3 - Baumaterialien
4 - Modematerialien
5 - Computerzubehör`,
      pt: `Escolha uma categoria de fornecedor válida:

1 - Materiais de impressão
2 - Materiais elétricos
3 - Materiais de construção
4 - Materiais de moda
5 - Acessórios de computador`,
      ar: `يرجى اختيار فئة مورد صحيحة:

1 - مواد الطباعة
2 - مواد كهربائية
3 - مواد البناء
4 - مواد الأزياء
5 - ملحقات الكمبيوتر`,
      zh: `请选择有效的供应商类别：

1 - 打印材料
2 - 电气材料
3 - 建筑材料
4 - 时尚材料
5 - 电脑配件`
    }));

    return res.sendStatus(200);
  }

  const job = await createTextOnlyServiceJob(
    "TRUSTED_SUPPLIERS",
    `Supplier category requested: ${selectedCategory}`
  );

  session.lastServiceJobId = job?.id || null;
  session.stage = "MENU";

  await sendMessage(from, pickText(session.language, {
    en: `🏪 Trusted Suppliers

Category selected: ${selectedCategory}

Our team will send you verified supplier recommendations shortly.

To return to the main menu anytime, type Hello.

We are also setting up referral tracking so workmen can buy materials from trusted companies with proper monitoring.`,
    es: `🏪 Proveedores confiables

Categoría seleccionada: ${selectedCategory}

Nuestro equipo le enviará pronto recomendaciones de proveedores verificados.

Para volver al menú principal en cualquier momento, escriba Hello.

También estamos configurando seguimiento de referidos para que los trabajadores compren materiales de empresas confiables con monitoreo adecuado.`,
    fr: `🏪 Fournisseurs fiables

Catégorie sélectionnée : ${selectedCategory}

Notre équipe vous enverra bientôt des recommandations de fournisseurs vérifiés.

Pour revenir au menu principal à tout moment, tapez Hello.

Nous mettons aussi en place un suivi des recommandations afin que les travailleurs achètent auprès d'entreprises fiables avec un bon contrôle.`,
    de: `🏪 Vertrauenswürdige Lieferanten

Ausgewählte Kategorie: ${selectedCategory}

Unser Team sendet Ihnen in Kürze geprüfte Lieferantenempfehlungen.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.

Wir richten außerdem Empfehlungsverfolgung ein, damit Handwerker Materialien von vertrauenswürdigen Firmen mit ordentlicher Überwachung kaufen können.`,
    pt: `🏪 Fornecedores confiáveis

Categoria selecionada: ${selectedCategory}

Nossa equipe enviará recomendações de fornecedores verificados em breve.

Para voltar ao menu principal a qualquer momento, digite Hello.

Também estamos configurando rastreamento de indicação para que trabalhadores comprem materiais de empresas confiáveis com monitoramento adequado.`,
    ar: `🏪 موردون موثوقون

الفئة المختارة: ${selectedCategory}

سيرسل لك فريقنا توصيات لموردين موثوقين قريبًا.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.

نقوم أيضًا بإعداد تتبع الإحالات حتى يتمكن العمال من شراء المواد من شركات موثوقة مع متابعة مناسبة.`,
    zh: `🏪 可信供应商

已选择类别：${selectedCategory}

我们的团队会很快发送经过验证的供应商推荐。

如需随时返回主菜单，请输入 Hello。

我们也在设置推荐跟踪，以便工人可以从可信公司购买材料并进行适当监督。`
  }));

  return res.sendStatus(200);
}


if (lower === "33") {
  session.selectedService = "SHIPPING_DELIVERY";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🚚 Shipping / Delivery selected.

Please type the details in your own words.

Include:
• Pickup location
• Delivery destination
• Item type and quantity
• Preferred pickup/delivery date and time
• Sender and receiver phone number
• Any special instruction

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🚚 Envío / Entrega seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Lugar de recogida
• Destino de entrega
• Tipo de artículo y cantidad
• Fecha y hora preferidas de recogida/entrega
• Teléfono del remitente y del receptor
• Cualquier instrucción especial

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🚚 Expédition / Livraison sélectionnée.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Lieu de collecte
• Destination de livraison
• Type d'article et quantité
• Date et heure souhaitées pour la collecte/livraison
• Numéro de téléphone de l'expéditeur et du destinataire
• Toute instruction spéciale

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🚚 Versand / Lieferung ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Abholort
• Lieferziel
• Artikeltyp und Menge
• Gewünschtes Abhol-/Lieferdatum und Uhrzeit
• Telefonnummer von Absender und Empfänger
• Besondere Anweisungen

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🚚 Envio / Entrega selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Local de retirada
• Destino da entrega
• Tipo de item e quantidade
• Data e horário preferidos para retirada/entrega
• Telefone do remetente e do destinatário
• Qualquer instrução especial

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🚚 تم اختيار الشحن / التوصيل.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• موقع الاستلام
• وجهة التوصيل
• نوع السلعة والكمية
• التاريخ والوقت المفضلان للاستلام/التوصيل
• رقم هاتف المرسل والمستلم
• أي تعليمات خاصة

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🚚 已选择运输 / 配送。

请用您自己的话填写详细信息。

请包括：
• 取件地点
• 配送目的地
• 物品类型和数量
• 首选取件/配送日期和时间
• 寄件人和收件人电话号码
• 任何特殊说明

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "34") {
  session.selectedService = "HELPER_SERVICE";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🧰 Helper Services selected.

Please type the details in your own words.

Include:
• Type of helper needed
• Indoor, outdoor, moving, cleaning, store, office, or general work
• Your location
• Preferred date and time
• How many helpers are needed

You may also send pictures, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🧰 Servicios de ayudante seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Tipo de ayudante necesario
• Trabajo interior, exterior, mudanza, limpieza, tienda, oficina o trabajo general
• Su ubicación
• Fecha y hora preferidas
• Cuántos ayudantes necesita

También puede enviar fotos, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🧰 Services d'aide sélectionnés.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Type d'aide nécessaire
• Travail intérieur, extérieur, déménagement, nettoyage, magasin, bureau ou travail général
• Votre emplacement
• Date et heure souhaitées
• Nombre d'aides nécessaires

Vous pouvez aussi envoyer des photos, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🧰 Helfer-Services ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Art der benötigten Hilfe
• Innen, außen, Umzug, Reinigung, Geschäft, Büro oder allgemeine Arbeit
• Ihren Standort
• Gewünschtes Datum und Uhrzeit
• Wie viele Helfer benötigt werden

Sie können auch Bilder, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🧰 Serviços de ajudante selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Tipo de ajudante necessário
• Trabalho interno, externo, mudança, limpeza, loja, escritório ou trabalho geral
• Sua localização
• Data e horário preferidos
• Quantos ajudantes são necessários

Você também pode enviar fotos, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🧰 تم اختيار خدمات المساعدة.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• نوع المساعدة المطلوبة
• عمل داخلي أو خارجي أو نقل أو تنظيف أو متجر أو مكتب أو عمل عام
• موقعك
• التاريخ والوقت المفضلان
• عدد المساعدين المطلوبين

يمكنك أيضًا إرسال صور أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🧰 已选择帮工服务。

请用您自己的话填写详细信息。

请包括：
• 需要的帮工类型
• 室内、室外、搬家、清洁、商店、办公室或普通工作
• 您的位置
• 首选日期和时间
• 需要多少名帮工

您也可以发送图片、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "35") {
  session.selectedService = "BOOK_APP_TESTER";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `📱 Book App Tester selected.

Please type the details in your own words.

Include:
• App name
• Google Play tester link or app download link
• Number of testers needed
• Country or location preference
• Testing instructions
• Preferred start date

You may also send screenshots, links, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `📱 Reservar probador de app seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Nombre de la app
• Enlace de prueba de Google Play o enlace de descarga
• Número de probadores necesarios
• País o ubicación preferida
• Instrucciones de prueba
• Fecha preferida de inicio

También puede enviar capturas, enlaces, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `📱 Réserver un testeur d'application sélectionné.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Nom de l'application
• Lien de test Google Play ou lien de téléchargement
• Nombre de testeurs nécessaires
• Pays ou emplacement préféré
• Instructions de test
• Date de début souhaitée

Vous pouvez aussi envoyer des captures d'écran, liens, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `📱 App-Tester buchen ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• App-Name
• Google-Play-Testlink oder Download-Link
• Anzahl der benötigten Tester
• Land oder bevorzugter Standort
• Testanweisungen
• Gewünschtes Startdatum

Sie können auch Screenshots, Links, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `📱 Reservar testador de aplicativo selecionado.

Digite os detalhes com suas próprias palavras.

Inclua:
• Nome do aplicativo
• Link de teste do Google Play ou link de download
• Número de testadores necessários
• País ou localização preferida
• Instruções de teste
• Data preferida para começar

Você também pode enviar capturas de tela, links, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `📱 تم اختيار حجز مختبر تطبيق.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• اسم التطبيق
• رابط اختبار Google Play أو رابط تحميل التطبيق
• عدد المختبرين المطلوب
• الدولة أو الموقع المفضل
• تعليمات الاختبار
• تاريخ البدء المفضل

يمكنك أيضًا إرسال لقطات شاشة أو روابط أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `📱 已选择预约应用测试员。

请用您自己的话填写详细信息。

请包括：
• 应用名称
• Google Play 测试链接或应用下载链接
• 需要的测试人数
• 国家或地区偏好
• 测试说明
• 首选开始日期

您也可以发送截图、链接、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "36") {
  session.selectedService = "SOLAR_INSTALLATION";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `☀️ Solar Installation selected.

Please type the details in your own words.

Include:
• Property location
• Home, office, store, farm, or other site
• What you want to power
• Current electricity problem
• Preferred installation date
• Your budget if available

You may also send pictures, videos, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `☀️ Instalación solar seleccionada.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Ubicación de la propiedad
• Casa, oficina, tienda, granja u otro lugar
• Lo que desea alimentar con energía
• Problema actual de electricidad
• Fecha preferida de instalación
• Su presupuesto si está disponible

También puede enviar fotos, videos, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `☀️ Installation solaire sélectionnée.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Emplacement de la propriété
• Maison, bureau, magasin, ferme ou autre site
• Ce que vous voulez alimenter
• Problème électrique actuel
• Date d'installation souhaitée
• Votre budget si disponible

Vous pouvez aussi envoyer des photos, vidéos, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `☀️ Solarinstallation ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Standort der Immobilie
• Haus, Büro, Geschäft, Farm oder anderer Standort
• Was mit Strom versorgt werden soll
• Aktuelles Stromproblem
• Gewünschtes Installationsdatum
• Ihr Budget, falls vorhanden

Sie können auch Bilder, Videos, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `☀️ Instalação solar selecionada.

Digite os detalhes com suas próprias palavras.

Inclua:
• Localização do imóvel
• Casa, escritório, loja, fazenda ou outro local
• O que você quer alimentar com energia
• Problema atual de eletricidade
• Data preferida para instalação
• Seu orçamento, se disponível

Você também pode enviar fotos, vídeos, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `☀️ تم اختيار تركيب الطاقة الشمسية.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• موقع العقار
• منزل أو مكتب أو متجر أو مزرعة أو موقع آخر
• ما الذي تريد تشغيله بالطاقة
• مشكلة الكهرباء الحالية
• تاريخ التركيب المفضل
• ميزانيتك إن وجدت

يمكنك أيضًا إرسال صور أو فيديوهات أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `☀️ 已选择太阳能安装。

请用您自己的话填写详细信息。

请包括：
• 房产位置
• 住宅、办公室、商店、农场或其他地点
• 您想供电的设备
• 当前用电问题
• 首选安装日期
• 如有预算，请填写

您也可以发送图片、视频、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (lower === "37") {
  session.selectedService = "WORK_MAINTENANCE";
  session.pendingFile = null;
  session.lastServiceJobId = null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🛠️ Work Maintenance selected.

Please type the details in your own words.

Include:
• Type of maintenance needed
• Home, office, store, machine, electrical, plumbing, cleaning, or general repair
• Your location
• Problem description
• Preferred date and time
• Whether it is urgent

You may also send pictures, videos, documents, or voice notes.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `🛠️ Mantenimiento de trabajo seleccionado.

Por favor escriba los detalles con sus propias palabras.

Incluya:
• Tipo de mantenimiento necesario
• Casa, oficina, tienda, máquina, electricidad, plomería, limpieza o reparación general
• Su ubicación
• Descripción del problema
• Fecha y hora preferidas
• Si es urgente

También puede enviar fotos, videos, documentos o notas de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🛠️ Maintenance de travail sélectionnée.

Veuillez écrire les détails avec vos propres mots.

Incluez :
• Type de maintenance nécessaire
• Maison, bureau, magasin, machine, électricité, plomberie, nettoyage ou réparation générale
• Votre emplacement
• Description du problème
• Date et heure souhaitées
• Si c'est urgent

Vous pouvez aussi envoyer des photos, vidéos, documents ou messages vocaux.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🛠️ Arbeitswartung ausgewählt.

Bitte schreiben Sie die Details mit Ihren eigenen Worten.

Bitte angeben:
• Art der benötigten Wartung
• Haus, Büro, Geschäft, Maschine, Elektrik, Sanitär, Reinigung oder allgemeine Reparatur
• Ihren Standort
• Beschreibung des Problems
• Gewünschtes Datum und Uhrzeit
• Ob es dringend ist

Sie können auch Bilder, Videos, Dokumente oder Sprachnachrichten senden.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🛠️ Manutenção de trabalho selecionada.

Digite os detalhes com suas próprias palavras.

Inclua:
• Tipo de manutenção necessária
• Casa, escritório, loja, máquina, elétrica, encanamento, limpeza ou reparo geral
• Sua localização
• Descrição do problema
• Data e horário preferidos
• Se é urgente

Você também pode enviar fotos, vídeos, documentos ou mensagens de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🛠️ تم اختيار صيانة الأعمال.

يرجى كتابة التفاصيل بكلماتك الخاصة.

اذكر:
• نوع الصيانة المطلوبة
• منزل أو مكتب أو متجر أو آلة أو كهرباء أو سباكة أو تنظيف أو إصلاح عام
• موقعك
• وصف المشكلة
• التاريخ والوقت المفضلان
• هل الأمر عاجل

يمكنك أيضًا إرسال صور أو فيديوهات أو مستندات أو رسائل صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `🛠️ 已选择工作维护。

请用您自己的话填写详细信息。

请包括：
• 需要的维护类型
• 家庭、办公室、商店、机器、电工、水管、清洁或普通维修
• 您的位置
• 问题描述
• 首选日期和时间
• 是否紧急

您也可以发送图片、视频、文件或语音消息。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}


   if (session.stage === "PRINT_SELECT_SIZE" && type === "text") {
  const sizeMap = {
    "1": "A4",
    "2": "A3",
    "3": "LETTER",
    "4": "LEGAL",
    "5": "TABLOID",
    "6": "CARD"
  };

  const selectedSize = sizeMap[lower];

  if (!selectedSize) {
    await sendMessage(from, printSizeMenuText(session.language));
    return res.sendStatus(200);
  }

  session.printSpec.paper_size = selectedSize;
  session.stage = "PRINT_SELECT_COLOR";

  await sendMessage(from, printColorMenuText(session.language));
  return res.sendStatus(200);
}

if (session.stage === "PRINT_SELECT_COLOR" && type === "text") {
  const colorMap = {
    "1": "BW",
    "2": "COLOR"
  };

  const selectedColor = colorMap[lower];

  if (!selectedColor) {
    await sendMessage(from, printColorMenuText(session.language));
    return res.sendStatus(200);
  }

  session.printSpec.color_mode = selectedColor;
  session.stage = "PRINT_WAITING_COPIES";

  await sendMessage(from, botText("copies_question", session.language));
  return res.sendStatus(200);
}

if (session.stage === "PRINT_WAITING_COPIES" && type === "text") {
  const copies = parseInt(lower, 10);

  if (!copies || copies < 1) {
    await sendMessage(from, pickText(session.language, {
      en: "Please type a valid number of copies, for example: 1, 2, 5, or 10.",
      es: "Por favor escriba un número válido de copias, por ejemplo: 1, 2, 5 o 10.",
      fr: "Veuillez saisir un nombre valide de copies, par exemple : 1, 2, 5 ou 10.",
      de: "Bitte geben Sie eine gültige Anzahl von Kopien ein, zum Beispiel: 1, 2, 5 oder 10.",
      pt: "Digite um número válido de cópias, por exemplo: 1, 2, 5 ou 10.",
      ar: "يرجى إدخال عدد صحيح من النسخ، مثل: 1 أو 2 أو 5 أو 10.",
      zh: "请输入有效的份数，例如：1、2、5 或 10。"
    }));
    return res.sendStatus(200);
  }

  session.printSpec.copies = copies;
  session.stage = "PRINT_WAITING_PAGES";

  await sendMessage(from, botText("pages_question", session.language));
  return res.sendStatus(200);
}

if (session.stage === "PRINT_WAITING_PAGES" && type === "text") {
  const pages = parseInt(lower, 10);

  if (!pages || pages < 1) {
    await sendMessage(from, {
  en: "Please type a valid page count, for example: 1, 2, 5, or 10.",
  es: "Por favor escriba una cantidad válida de páginas, por ejemplo: 1, 2, 5 o 10.",
  fr: "Veuillez saisir un nombre valide de pages, par exemple : 1, 2, 5 ou 10.",
  de: "Bitte geben Sie eine gültige Seitenanzahl ein, zum Beispiel: 1, 2, 5 oder 10.",
  pt: "Digite uma quantidade válida de páginas, por exemplo: 1, 2, 5 ou 10.",
  ar: "يرجى إدخال عدد صحيح للصفحات، مثل: 1 أو 2 أو 5 أو 10."
}[session.language || "en"]);
    return res.sendStatus(200);
  }

  session.printSpec.pages = pages;
  session.stage = "PRINT_WAITING_UPLOAD";

  await sendMessage(from, printSetupCompleteText(session.language, session.printSpec));

  return res.sendStatus(200);
} 
    if (session.stage === "LAMINATE_WAITING_SIZE" && type === "text") {
  const sizeMap = {
    "1": "A4",
    "2": "LETTER",
    "3": "LEGAL",
    "4": "TABLOID"
  };

  const selectedSize = sizeMap[lower];

  if (!selectedSize) {
    await sendMessage(from, laminateSizeMenuText(session.language));
    return res.sendStatus(200);
  }

  session.laminateSpec.size = selectedSize;
  session.stage = "LAMINATE_WAITING_QUANTITY";

  await sendMessage(from, botText("laminate_quantity_question", session.language));
  return res.sendStatus(200);
}

if (session.stage === "LAMINATE_WAITING_QUANTITY" && type === "text") {
  const quantity = parseInt(lower, 10);

  if (!quantity || quantity < 1) {
    await sendMessage(from, {
  en: "Please type a valid quantity, for example: 1, 2, 5, or 10.",
  es: "Por favor escriba una cantidad válida, por ejemplo: 1, 2, 5 o 10.",
  fr: "Veuillez saisir une quantité valide, par exemple : 1, 2, 5 ou 10.",
  de: "Bitte geben Sie eine gültige Menge ein, zum Beispiel: 1, 2, 5 oder 10.",
  pt: "Digite uma quantidade válida, por exemplo: 1, 2, 5 ou 10.",
  ar: "يرجى إدخال كمية صحيحة، مثل: 1 أو 2 أو 5 أو 10."
}[session.language || "en"]);
    return res.sendStatus(200);
  }

  session.laminateSpec.quantity = quantity;
  session.stage = "LAMINATE_WAITING_FILE";

  await sendMessage(from, laminateSetupCompleteText(session.language, session.laminateSpec));

  return res.sendStatus(200);
}
if (session.stage === "JOB_SELECT_ROLE" && type === "text") {
  const roleMap = {
    "1": "Graphic Designer",
    "2": "Print Machine Operator",
    "3": "Customer Support Agent",
    "4": "Delivery Driver",
    "5": "Video Editor"
  };

  const role = roleMap[lower];

  if (!role) {
    await sendMessage(from, pickText(session.language, {
    en: "Please reply with 1, 2, 3, 4, or 5.",
    es: "Por favor responda con 1, 2, 3, 4 o 5.",
    fr: "Veuillez répondre avec 1, 2, 3, 4 ou 5.",
    de: "Bitte antworten Sie mit 1, 2, 3, 4 oder 5.",
    pt: "Responda com 1, 2, 3, 4 ou 5.",
    ar: "يرجى الرد بـ 1 أو 2 أو 3 أو 4 أو 5.",
    zh: "请回复 1、2、3、4 或 5。"
  }));
    return res.sendStatus(200);
  }

  session.jobRole = role;
  session.stage = "JOB_WAITING_CV";

  await sendMessage(from, pickText(session.language, {
    en: `✅ Selected Role: ${role}

Please upload your CV (PDF or document).

You can also send a voice note with additional information.`,
    es: `✅ Puesto seleccionado: ${role}

Suba su CV (PDF o documento).

También puede enviar una nota de voz con información adicional.`,
    fr: `✅ Poste sélectionné : ${role}

Veuillez télécharger votre CV (PDF ou document).

Vous pouvez aussi envoyer une note vocale avec des informations supplémentaires.`,
    de: `✅ Ausgewählte Stelle: ${role}

Bitte laden Sie Ihren Lebenslauf hoch (PDF oder Dokument).

Sie können auch eine Sprachnachricht mit zusätzlichen Informationen senden.`,
    pt: `✅ Função selecionada: ${role}

Envie seu currículo (PDF ou documento).

Você também pode enviar uma mensagem de voz com informações adicionais.`,
    ar: `✅ الوظيفة المختارة: ${role}

يرجى رفع سيرتك الذاتية (PDF أو مستند).

يمكنك أيضًا إرسال رسالة صوتية بمعلومات إضافية.`,
    zh: `✅ 已选择职位：${role}

请上传您的简历（PDF 或文档）。

您也可以发送语音说明补充信息。`
  }));

  return res.sendStatus(200);
}
if (session.stage === "IMAGE_EDIT_SELECT_TYPE" && type === "text") {
  const imageMap = {
    "1": ["Basic Image Edit", SHOPIFY_VARIANTS.IMAGE_BASIC],
    "2": ["Background Removal", SHOPIFY_VARIANTS.IMAGE_BG_REMOVAL],
    "3": ["Product Photo Enhancement", SHOPIFY_VARIANTS.IMAGE_ENHANCEMENT],
    "4": ["Advanced Image Editing", SHOPIFY_VARIANTS.IMAGE_ADVANCED]
  };

  const selected = imageMap[lower];
  if (!selected) {
    await sendMessage(from, pickText(session.language, {
    en: "Reply 1, 2, 3, or 4.",
    es: "Responda 1, 2, 3 o 4.",
    fr: "Répondez 1, 2, 3 ou 4.",
    de: "Antworten Sie mit 1, 2, 3 oder 4.",
    pt: "Responda 1, 2, 3 ou 4.",
    ar: "رد بـ 1 أو 2 أو 3 أو 4.",
    zh: "请回复 1、2、3 或 4。"
  }));
    return res.sendStatus(200);
  }

  session.imageEditType = selected[0];
  session.stage = "IMAGE_EDIT_WAITING_UPLOAD";

  await sendMessage(from, pickText(session.language, {
    en: `✅ Selected: ${selected[0]}

Shopify Checkout:
${buildShopifyCartUrl(selected[1], 1)}

Africa Payment:
https://www.patapata.us/pages/africa-payment

Please upload your image now.`,
    es: `✅ Seleccionado: ${selected[0]}

Pago Shopify:
${buildShopifyCartUrl(selected[1], 1)}

Pago África:
https://www.patapata.us/pages/africa-payment

Suba su imagen ahora.`,
    fr: `✅ Sélectionné : ${selected[0]}

Paiement Shopify :
${buildShopifyCartUrl(selected[1], 1)}

Paiement Afrique :
https://www.patapata.us/pages/africa-payment

Veuillez télécharger votre image maintenant.`,
    de: `✅ Ausgewählt: ${selected[0]}

Shopify-Zahlung:
${buildShopifyCartUrl(selected[1], 1)}

Afrika-Zahlung:
https://www.patapata.us/pages/africa-payment

Bitte laden Sie jetzt Ihr Bild hoch.`,
    pt: `✅ Selecionado: ${selected[0]}

Pagamento Shopify:
${buildShopifyCartUrl(selected[1], 1)}

Pagamento África:
https://www.patapata.us/pages/africa-payment

Envie sua imagem agora.`,
    ar: `✅ تم الاختيار: ${selected[0]}

دفع Shopify:
${buildShopifyCartUrl(selected[1], 1)}

دفع أفريقيا:
https://www.patapata.us/pages/africa-payment

يرجى رفع الصورة الآن.`,
    zh: `✅ 已选择：${selected[0]}

Shopify 付款：
${buildShopifyCartUrl(selected[1], 1)}

非洲付款：
https://www.patapata.us/pages/africa-payment

请现在上传您的图片。`
  }));
  return res.sendStatus(200);
}

if (session.stage === "VIDEO_EDIT_SELECT_TYPE" && type === "text") {
  const videoMap = {
    "1": ["Short Video Edit", SHOPIFY_VARIANTS.VIDEO_SHORT],
    "2": ["Social Media Video Edit", SHOPIFY_VARIANTS.VIDEO_SOCIAL],
    "3": ["Standard Video Edit", SHOPIFY_VARIANTS.VIDEO_STANDARD],
    "4": ["Advanced Video Edit", SHOPIFY_VARIANTS.VIDEO_ADVANCED]
  };

  const selected = videoMap[lower];
  if (!selected) {
    await sendMessage(from, pickText(session.language, {
    en: "Reply 1, 2, 3, or 4.",
    es: "Responda 1, 2, 3 o 4.",
    fr: "Répondez 1, 2, 3 ou 4.",
    de: "Antworten Sie mit 1, 2, 3 oder 4.",
    pt: "Responda 1, 2, 3 ou 4.",
    ar: "رد بـ 1 أو 2 أو 3 أو 4.",
    zh: "请回复 1、2、3 或 4。"
  }));
    return res.sendStatus(200);
  }

  session.videoEditType = selected[0];
  session.videoVariantId = selected[1];
  session.stage = "VIDEO_EDIT_WAITING_UPLOAD";

  await sendMessage(from, pickText(session.language, {
    en: `✅ Selected: ${selected[0]}

Shopify Checkout:
${buildShopifyCartUrl(selected[1], 1)}

Africa Payment:
https://www.patapata.us/pages/africa-payment

Please upload your video now.`,
    es: `✅ Seleccionado: ${selected[0]}

Pago Shopify:
${buildShopifyCartUrl(selected[1], 1)}

Pago África:
https://www.patapata.us/pages/africa-payment

Suba su video ahora.`,
    fr: `✅ Sélectionné : ${selected[0]}

Paiement Shopify :
${buildShopifyCartUrl(selected[1], 1)}

Paiement Afrique :
https://www.patapata.us/pages/africa-payment

Veuillez télécharger votre vidéo maintenant.`,
    de: `✅ Ausgewählt: ${selected[0]}

Shopify-Zahlung:
${buildShopifyCartUrl(selected[1], 1)}

Afrika-Zahlung:
https://www.patapata.us/pages/africa-payment

Bitte laden Sie jetzt Ihr Video hoch.`,
    pt: `✅ Selecionado: ${selected[0]}

Pagamento Shopify:
${buildShopifyCartUrl(selected[1], 1)}

Pagamento África:
https://www.patapata.us/pages/africa-payment

Envie seu vídeo agora.`,
    ar: `✅ تم الاختيار: ${selected[0]}

دفع Shopify:
${buildShopifyCartUrl(selected[1], 1)}

دفع أفريقيا:
https://www.patapata.us/pages/africa-payment

يرجى رفع الفيديو الآن.`,
    zh: `✅ 已选择：${selected[0]}

Shopify 付款：
${buildShopifyCartUrl(selected[1], 1)}

非洲付款：
https://www.patapata.us/pages/africa-payment

请现在上传您的视频。`
  }));
  return res.sendStatus(200);
}

if (session.stage === "TSHIRT_SELECT_SIZE" && type === "text") {
  const rawSize = text.trim().toLowerCase();

  const sizeMap = {
    s: "Small",
    small: "Small",
    m: "Medium",
    medium: "Medium",
    l: "Large",
    large: "Large",
    xl: "Extra Large",
    "extra large": "Extra Large",
    xxl: "Double XL",
    "double xl": "Double XL"
  };

  const size = sizeMap[rawSize];

  if (!size) {
    await sendMessage(from, pickText(session.language, {
    en: "Please reply with Small, Medium, Large, XL, or XXL.",
    es: "Responda con Small, Medium, Large, XL o XXL.",
    fr: "Répondez avec Small, Medium, Large, XL ou XXL.",
    de: "Bitte antworten Sie mit Small, Medium, Large, XL oder XXL.",
    pt: "Responda com Small, Medium, Large, XL ou XXL.",
    ar: "يرجى الرد بـ Small أو Medium أو Large أو XL أو XXL.",
    zh: "请回复 Small、Medium、Large、XL 或 XXL。"
  }));
    return res.sendStatus(200);
  }

  session.tshirtSize = size;
  session.stage = "TSHIRT_WAITING_TEXT";

  await sendMessage(from, pickText(session.language, {
    en: `✅ Size selected: ${size}

Please type the text you want printed on your T-shirt.

You can also include:
- Shirt color
- Print color
- Front or back placement

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `✅ Talla seleccionada: ${size}

Escriba el texto que desea imprimir en su camiseta.

También puede incluir:
- Color de la camiseta
- Color de impresión
- Ubicación delantera o trasera

Nuestro equipo se comunicará pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `✅ Taille sélectionnée : ${size}

Tapez le texte à imprimer sur votre T-shirt.

Vous pouvez aussi inclure :
- Couleur du T-shirt
- Couleur d'impression
- Emplacement devant ou dos

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `✅ Größe ausgewählt: ${size}

Bitte geben Sie den Text ein, der auf Ihr T-Shirt gedruckt werden soll.

Sie können auch angeben:
- T-Shirt-Farbe
- Druckfarbe
- Vorder- oder Rückseite

Unser Team kontaktiert Sie bald per WhatsApp.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `✅ Tamanho selecionado: ${size}

Digite o texto que deseja imprimir na camiseta.

Você também pode incluir:
- Cor da camisa
- Cor da impressão
- Frente ou costas

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `✅ تم اختيار المقاس: ${size}

يرجى كتابة النص الذي تريد طباعته على التيشيرت.

يمكنك أيضًا إضافة:
- لون التيشيرت
- لون الطباعة
- مكان الطباعة أمامي أو خلفي

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `✅ 已选择尺码：${size}

请输入您想印在 T 恤上的文字。

您也可以包含：
- 衣服颜色
- 印刷颜色
- 正面或背面位置

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));
  return res.sendStatus(200);
}

if (session.stage === "TSHIRT_WAITING_TEXT" && type === "text") {
  const designText = text.trim();

  const job = await createTextOnlyServiceJob(
    "TSHIRT_PRINT",
    `Size: ${session.tshirtSize}\nDesign: ${designText}`
  );

  session.lastServiceJobId = job?.id || null;

  await sendMessage(from, pickText(session.language, {
    en: `👕 Your T-shirt request has been received.

Size: ${session.tshirtSize}
Design: ${designText}

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `👕 Su solicitud de camiseta fue recibida.

Talla: ${session.tshirtSize}
Diseño: ${designText}

Nuestro equipo se comunicará pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `👕 Votre demande de T-shirt a été reçue.

Taille : ${session.tshirtSize}
Design : ${designText}

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `👕 Ihre T-Shirt-Anfrage wurde erhalten.

Größe: ${session.tshirtSize}
Design: ${designText}

Unser Team kontaktiert Sie bald per WhatsApp.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `👕 Sua solicitação de camiseta foi recebida.

Tamanho: ${session.tshirtSize}
Design: ${designText}

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `👕 تم استلام طلب التيشيرت الخاص بك.

المقاس: ${session.tshirtSize}
التصميم: ${designText}

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `👕 您的 T 恤请求已收到。

尺码：${session.tshirtSize}
设计：${designText}

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));

  session.stage = "MENU";
  return res.sendStatus(200);
}

if (session.stage === "SERVICE_WAITING_EXTRA_NOTES") {
  if (type === "text" && lower) {
    if (session.lastServiceJobId) {
      await attachTextToExistingJob(session.lastServiceJobId, text.trim());
    } else {
      const job = await createTextOnlyServiceJob(
        session.selectedService || "AGENT_REQUEST",
        text.trim()
      );
      session.lastServiceJobId = job?.id || null;
    }

   await sendMessage(from, pickText(session.language, {
  en: "✅ Text instruction received. Thanks.",
  es: "✅ Instrucción de texto recibida. Gracias.",
  fr: "✅ Instruction texte reçue. Merci.",
  de: "✅ Textanweisung erhalten. Danke.",
  pt: "✅ Instrução de texto recebida. Obrigado.",
  ar: "✅ تم استلام التعليمات النصية. شكرًا.",
  zh: "✅ 已收到文字说明。谢谢。"
}));
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    return res.sendStatus(200);
  }

  if (type === "audio" && message.audio?.id) {
    if (!session.lastServiceJobId) {
      const job = await createTextOnlyServiceJob(
        session.selectedService || "AGENT_REQUEST",
        "Voice instruction"
      );
      session.lastServiceJobId = job?.id || null;
    }

    await attachAudioToExistingJob(
      session.lastServiceJobId,
      message.audio.id,
      message.audio?.mime_type || "audio/ogg"
    );

    await sendMessage(from, pickText(session.language, {
      en: "✅ Voice note received. You can also send photo, document, video, or text instruction.",
      es: "✅ Nota de voz recibida. También puede enviar foto, documento, video o instrucción de texto.",
      fr: "✅ Note vocale reçue. Vous pouvez aussi envoyer une photo, un document, une vidéo ou une instruction texte.",
      de: "✅ Sprachnachricht erhalten. Sie können auch Foto, Dokument, Video oder Textanweisung senden.",
      pt: "✅ Nota de voz recebida. Você também pode enviar foto, documento, vídeo ou instrução de texto.",
      ar: "✅ تم استلام الرسالة الصوتية. يمكنك أيضًا إرسال صورة أو مستند أو فيديو أو تعليمات نصية.",
      zh: "✅ 已收到语音说明。您也可以发送照片、文档、视频或文字说明。"
    }));
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    return res.sendStatus(200);
  }

  if (type === "image" || type === "document" || type === "video") {
    const mediaObj =
      type === "image"
        ? message.image
        : type === "document"
        ? message.document
        : message.video;

    if (session.lastServiceJobId) {
      await attachMediaToExistingJob(
        session.lastServiceJobId,
        mediaObj?.id,
        mediaObj?.filename || `${session.selectedService || "service"}_${type}_upload`,
        mediaObj?.mime_type || ""
      );
    } else {
      const job = await createJobFromMedia({
        printerId: AGENT_QUEUE_ID,
        queueType: "AGENT",
        serviceType: session.selectedService || "AGENT_REQUEST",
        mediaId: mediaObj?.id,
        originalName: mediaObj?.filename || `${session.selectedService || "service"}_${type}_upload`,
        mimeType: mediaObj?.mime_type || "",
        instructions: `Customer uploaded ${type} for ${session.selectedService || "service request"}`
      });

      session.lastServiceJobId = job?.id || null;
    }

    await sendMessage(from, pickText(session.language, {
      en: `✅ ${type} received. You can also send text instruction or voice note.`,
      es: `✅ ${type} recibido. También puede enviar instrucciones de texto o nota de voz.`,
      fr: `✅ ${type} reçu. Vous pouvez aussi envoyer une instruction texte ou une note vocale.`,
      de: `✅ ${type} erhalten. Sie können auch Textanweisungen oder eine Sprachnachricht senden.`,
      pt: `✅ ${type} recebido. Você também pode enviar instrução de texto ou nota de voz.`,
      ar: `✅ تم استلام ${type}. يمكنك أيضًا إرسال تعليمات نصية أو رسالة صوتية.`,
      zh: `✅ 已收到 ${type}。您也可以发送文字说明或语音说明。`
    }));
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    return res.sendStatus(200);
  }

  await sendMessage(from, pickText(session.language, {
    en: "Please send text, voice note, photo, video, or document.",
    es: "Envíe texto, nota de voz, foto, video o documento.",
    fr: "Veuillez envoyer un texte, une note vocale, une photo, une vidéo ou un document.",
    de: "Bitte senden Sie Text, Sprachnachricht, Foto, Video oder Dokument.",
    pt: "Envie texto, nota de voz, foto, vídeo ou documento.",
    ar: "يرجى إرسال نص أو رسالة صوتية أو صورة أو فيديو أو مستند.",
    zh: "请发送文字、语音、照片、视频或文档。"
  }));
  return res.sendStatus(200);
}

    if (type === "image" || type === "document" || type === "video" || type === "audio") {
      const mediaObj =
        type === "image"
          ? message.image
          : type === "document"
          ? message.document
          : type === "audio"
          ? message.audio
          : message.video;
      if (session.stage === "COMMUNITY_ALERT_WAITING" && (type === "image" || type === "video" || type === "document" || type === "audio")) {
  const job = await createJobFromMedia({
    printerId: AGENT_QUEUE_ID,
    queueType: "AGENT",
    serviceType: "COMMUNITY_ALERT",
    mediaId: mediaObj?.id,
    originalName: mediaObj?.filename || "community_alert_upload",
    mimeType: mediaObj?.mime_type || "",
    instructions: "Community alert media submitted for moderation review"
  });

  session.lastServiceJobId = job?.id || null;
  session.stage = "COMMUNITY_ALERT_WAITING_DETAILS";

  await sendMessage(from, pickText(session.language, {
    en: `🚨 Community alert media received.

Please now send ANY of the following:

• What happened
• Location
• Time/date if known
• Voice note explanation

You may send text, voice note, or both.

Our moderation team will review everything before any community broadcast.

To return to the main menu anytime, type Hello.`,
    es: `🚨 Medio de alerta comunitaria recibido.

Ahora envíe cualquiera de lo siguiente:

• Qué ocurrió
• Ubicación
• Hora/fecha si la sabe
• Explicación por nota de voz

Puede enviar texto, nota de voz o ambos.

Nuestro equipo de moderación revisará todo antes de cualquier difusión comunitaria.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `🚨 Média d'alerte communautaire reçu.

Veuillez maintenant envoyer l'un des éléments suivants :

• Ce qui s'est passé
• Lieu
• Heure/date si connue
• Explication vocale

Vous pouvez envoyer un texte, une note vocale ou les deux.

Notre équipe de modération examinera tout avant toute diffusion communautaire.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `🚨 Medien zum Gemeinschaftsalarm erhalten.

Bitte senden Sie jetzt eine der folgenden Angaben:

• Was passiert ist
• Standort
• Uhrzeit/Datum, falls bekannt
• Erklärung per Sprachnachricht

Sie können Text, Sprachnachricht oder beides senden.

Unser Moderationsteam prüft alles vor einer Veröffentlichung.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `🚨 Mídia de alerta comunitário recebida.

Agora envie qualquer uma das informações abaixo:

• O que aconteceu
• Localização
• Hora/data se souber
• Explicação por áudio

Você pode enviar texto, áudio ou ambos.

Nossa equipe de moderação analisará tudo antes de qualquer divulgação.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `🚨 تم استلام وسائط التنبيه المجتمعي.

يرجى الآن إرسال أي مما يلي:

• ماذا حدث
• الموقع
• الوقت/التاريخ إن وجد
• شرح برسالة صوتية

يمكنك إرسال نص أو رسالة صوتية أو كليهما.

سيقوم فريق المراجعة بفحص كل شيء قبل أي نشر مجتمعي.`,
    zh: `🚨 已收到社区警报媒体。

请现在发送以下任意信息：

• 发生了什么
• 位置
• 时间/日期（如知道）
• 语音说明

您可以发送文字、语音或两者都发送。

我们的审核团队会在任何社区发布前审核全部内容。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}
      if (session.stage === "PRINT_WAITING_UPLOAD") {
  const paperSize = session.printSpec?.paper_size || "A4";
  const colorMode = session.printSpec?.color_mode || "BW";
  const copies = session.printSpec?.copies || 1;
  const pages = session.printSpec?.pages || 1;

  const job = await createJobFromMedia({
    printerId: DEFAULT_PRINTER_ID,
    queueType: "WORKER",
    serviceType: "PRINTING",
    mediaId: mediaObj?.id,
    originalName: mediaObj?.filename || "print_upload",
    mimeType: mediaObj?.mime_type || "",
    paperSize,
    colorMode,
    copies,
    pages
  });

  session.lastServiceJobId = job?.id || null;
  session.stage = "PRINT_PAYMENT_CHOICE";

  const variantId = getPrintVariantId(paperSize, colorMode);
  const checkoutUrl = buildShopifyCartUrl(variantId, copies);

  await sendMessage(
    from,
    printFileReceivedText(session.language, { paperSize, colorMode, copies, pages, checkoutUrl })
  );

  return res.sendStatus(200);
}

if (session.stage === "LAMINATE_WAITING_FILE") {
  const size = session.laminateSpec?.size || "LETTER";
  const quantity = session.laminateSpec?.quantity || 1;

  const job = await createJobFromMedia({
    printerId: DISPATCH_QUEUE_ID,
    queueType: "DISPATCH",
    serviceType: "LAMINATING",
    mediaId: mediaObj?.id,
    originalName: mediaObj?.filename || "laminate_upload",
    mimeType: mediaObj?.mime_type || "",
    copies: quantity,
    pages: 1,
    instructions: `Laminate size: ${size}\nQuantity: ${quantity}`
  });

  session.lastServiceJobId = job?.id || null;
  session.stage = "PRINT_PAYMENT_CHOICE";

  const variantId = getLaminateVariantId(size);
  const checkoutUrl = buildShopifyCartUrl(variantId, quantity);

  await sendMessage(
    from,
    laminateFileReceivedText(session.language, { size, quantity, checkoutUrl })
  );

  return res.sendStatus(200);
}
      if (session.stage === "JOB_WAITING_CV") {
  const job = await createJobFromMedia({
    printerId: AGENT_QUEUE_ID,
    queueType: "AGENT",
    serviceType: "JOB_APPLICATION",
    mediaId: mediaObj?.id,
    originalName: mediaObj?.filename || "cv_upload",
    mimeType: mediaObj?.mime_type || "application/pdf"
  });

  session.lastServiceJobId = job?.id || null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(from, pickText(session.language, {
    en: `✅ CV received for ${session.jobRole}

You can now send:
• Text instruction
• OR voice note

Our team will review and contact you shortly.

To return to the main menu anytime, type Hello.`,
    es: `✅ CV recibido para ${session.jobRole}

Ahora puede enviar:
• Instrucción de texto
• O nota de voz

Nuestro equipo revisará y le contactará pronto.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `✅ CV reçu pour ${session.jobRole}

Vous pouvez maintenant envoyer :
• Instruction texte
• OU note vocale

Notre équipe examinera et vous contactera bientôt.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `✅ Lebenslauf für ${session.jobRole} erhalten

Sie können jetzt senden:
• Textanweisung
• ODER Sprachnachricht

Unser Team prüft es und kontaktiert Sie bald.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `✅ Currículo recebido para ${session.jobRole}

Agora você pode enviar:
• Instrução em texto
• OU mensagem de voz

Nossa equipe analisará e entrará em contato em breve.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `✅ تم استلام السيرة الذاتية لـ ${session.jobRole}

يمكنك الآن إرسال:
• تعليمات نصية
• أو رسالة صوتية

سيقوم فريقنا بالمراجعة والتواصل معك قريبًا.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `✅ 已收到 ${session.jobRole} 的简历

您现在可以发送：
• 文字说明
• 或语音说明

我们的团队会审核并很快联系您。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}

      if (session.stage === "IMAGE_EDIT_WAITING_UPLOAD") {
        const job = await createJobFromMedia({
          printerId: AGENT_QUEUE_ID,
          queueType: "AGENT",
          serviceType: session.imageEditType || "IMAGE_EDIT",
          mediaId: mediaObj?.id,
          originalName: mediaObj?.filename || "image_edit",
          mimeType: mediaObj?.mime_type || "image/jpeg"
        });

        session.lastServiceJobId = job?.id || null;
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";

        await sendMessage(from, pickText(session.language, {
  en: `✅ Image received.

Please send your instruction now as text or voice note.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
  es: `✅ Imagen recibida.

Envíe ahora sus instrucciones por texto o nota de voz.

Nuestro equipo se comunicará pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
  fr: `✅ Image reçue.

Veuillez envoyer vos instructions maintenant par texte ou note vocale.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
  de: `✅ Bild erhalten.

Bitte senden Sie jetzt Ihre Anweisung als Text oder Sprachnachricht.

Unser Team kontaktiert Sie bald per WhatsApp.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
  pt: `✅ Imagem recebida.

Envie agora sua instrução por texto ou mensagem de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
  ar: `✅ تم استلام الصورة.

يرجى إرسال تعليماتك الآن كنص أو رسالة صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
  zh: `✅ 图片已收到。

请现在通过文字或语音发送说明。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
}));
        return res.sendStatus(200);
      }
if (session.stage === "LESSON_WAITING_UPLOAD") {
  const job = await createJobFromMedia({
    printerId: AGENT_QUEUE_ID,
    queueType: "AGENT",
    serviceType: "LESSON_HOMEWORK",
    mediaId: mediaObj?.id,
    originalName: mediaObj?.filename || "lesson_homework",
    mimeType: mediaObj?.mime_type || "",
    copies: 1,
    pages: 1
  });

  session.lastServiceJobId = job?.id || null;
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(from, pickText(session.language, {
    en: `✅ Lesson / Homework file received.

Please send your instruction now as text or voice note.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
    es: `✅ Archivo de lección / tarea recibido.

Envíe ahora sus instrucciones por texto o nota de voz.

Nuestro equipo se comunicará pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
    fr: `✅ Fichier de leçon / devoir reçu.

Veuillez envoyer vos instructions maintenant par texte ou note vocale.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
    de: `✅ Unterrichts- / Hausaufgabendatei erhalten.

Bitte senden Sie jetzt Ihre Anweisung als Text oder Sprachnachricht.

Unser Team kontaktiert Sie bald per WhatsApp.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
    pt: `✅ Arquivo de aula / tarefa recebido.

Envie agora sua instrução por texto ou mensagem de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
    ar: `✅ تم استلام ملف الدرس / الواجب.

يرجى إرسال تعليماتك الآن كنص أو رسالة صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
    zh: `✅ 课程 / 作业文件已收到。

请现在通过文字或语音发送说明。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
  }));

  return res.sendStatus(200);
}
      if (session.stage === "VIDEO_EDIT_WAITING_UPLOAD" && type === "video") {
        const job = await createJobFromMedia({
          printerId: AGENT_QUEUE_ID,
          queueType: "AGENT",
          serviceType: session.videoEditType || "VIDEO_EDIT",
          mediaId: mediaObj?.id,
          originalName: mediaObj?.filename || "video_edit",
          mimeType: mediaObj?.mime_type || "video/mp4"
        });

        session.lastServiceJobId = job?.id || null;
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";

        await sendMessage(from, pickText(session.language, {
  en: `✅ Video received.

Please send your instruction now as text or voice note.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
  es: `✅ Video recibido.

Envíe ahora sus instrucciones por texto o nota de voz.

Nuestro equipo se comunicará pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
  fr: `✅ Vidéo reçue.

Veuillez envoyer vos instructions maintenant par texte ou note vocale.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
  de: `✅ Video erhalten.

Bitte senden Sie jetzt Ihre Anweisung als Text oder Sprachnachricht.

Unser Team kontaktiert Sie bald per WhatsApp.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
  pt: `✅ Vídeo recebido.

Envie agora sua instrução por texto ou mensagem de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
  ar: `✅ تم استلام الفيديو.

يرجى إرسال تعليماتك الآن كنص أو رسالة صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
  zh: `✅ 视频已收到。

请现在通过文字或语音发送说明。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
}));
        return res.sendStatus(200);
      }

      if (session.stage === "IDPHOTO_WAITING_UPLOAD" && type === "image") {
        const job = await createJobFromMedia({
          printerId: AGENT_QUEUE_ID,
          queueType: "AGENT",
          serviceType: "ID_PHOTO",
          mediaId: mediaObj?.id,
          originalName: mediaObj?.filename || "id_photo",
          mimeType: mediaObj?.mime_type || "image/jpeg"
        });

        session.lastServiceJobId = job?.id || null;
        session.stage = "SERVICE_WAITING_EXTRA_NOTES";

        await sendMessage(from, pickText(session.language, {
  en: `✅ ID photo received.

Please send your instruction now as text or voice note.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
  es: `✅ Foto de identificación recibida.

Envíe ahora sus instrucciones por texto o nota de voz.

Nuestro equipo se comunicará pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
  fr: `✅ Photo d'identité reçue.

Veuillez envoyer vos instructions maintenant par texte ou note vocale.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
  de: `✅ Passfoto erhalten.

Bitte senden Sie jetzt Ihre Anweisung als Text oder Sprachnachricht.

Unser Team kontaktiert Sie bald per WhatsApp.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
  pt: `✅ Foto de identificação recebida.

Envie agora sua instrução por texto ou mensagem de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
  ar: `✅ تم استلام صورة الهوية.

يرجى إرسال تعليماتك الآن كنص أو رسالة صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
  zh: `✅ 证件照已收到。

请现在通过文字或语音发送说明。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
}));
        return res.sendStatus(200);
      }
    }
if (session.stage === "PRINT_PAYMENT_CHOICE" && type === "text") {
  if (lower === "1") {
    if (session.lastServiceJobId) {
      await attachTextToExistingJob(session.lastServiceJobId, "Payment choice: Shopify payment marked as paid by customer");
    }

    session.stage = "DONE";

    await sendMessage(from, pickText(session.language, {
      en: `✅ Shopify payment noted.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
      es: `✅ Pago de Shopify registrado.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
      fr: `✅ Paiement Shopify noté.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
      de: `✅ Shopify-Zahlung notiert.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
      pt: `✅ Pagamento Shopify registrado.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
      ar: `✅ تم تسجيل دفع Shopify.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
      zh: `✅ Shopify 付款已记录。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
    }));

    return res.sendStatus(200);
  }

  if (lower === "2") {
    if (session.lastServiceJobId) {
      await attachTextToExistingJob(session.lastServiceJobId, "Payment choice: Africa Payment marked as paid by customer");
    }

    session.stage = "DONE";

    await sendMessage(from, pickText(session.language, {
      en: `✅ Africa Payment noted.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
      es: `✅ Pago África registrado.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
      fr: `✅ Paiement Afrique noté.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
      de: `✅ Afrika-Zahlung notiert.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
      pt: `✅ Pagamento África registrado.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
      ar: `✅ تم تسجيل دفع أفريقيا.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
      zh: `✅ 非洲付款已记录。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
    }));

    return res.sendStatus(200);
  }

  if (lower === "3") {
    if (session.lastServiceJobId) {
      await attachTextToExistingJob(session.lastServiceJobId, "Payment choice: Continue with Agent");
    }

    session.stage = "SERVICE_WAITING_EXTRA_NOTES";

    await sendMessage(from, pickText(session.language, {
      en: `👨‍💼 Continue with Agent selected.

Please send any additional instruction as text or voice note.

Our team will contact you shortly on WhatsApp.

To return to the main menu anytime, type Hello.`,
      es: `👨‍💼 Continuar con agente seleccionado.

Envíe cualquier instrucción adicional como texto o nota de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.

Para volver al menú principal en cualquier momento, escriba Hello.`,
      fr: `👨‍💼 Continuer avec un agent sélectionné.

Veuillez envoyer toute instruction supplémentaire par texte ou note vocale.

Notre équipe vous contactera bientôt sur WhatsApp.

Pour revenir au menu principal à tout moment, tapez Hello.`,
      de: `👨‍💼 Mit Agent fortfahren ausgewählt.

Bitte senden Sie zusätzliche Anweisungen als Text oder Sprachnachricht.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.

Um jederzeit zum Hauptmenü zurückzukehren, schreiben Sie Hello.`,
      pt: `👨‍💼 Continuar com agente selecionado.

Envie qualquer instrução adicional por texto ou nota de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.

Para voltar ao menu principal a qualquer momento, digite Hello.`,
      ar: `👨‍💼 تم اختيار المتابعة مع موظف.

يرجى إرسال أي تعليمات إضافية كنص أو رسالة صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.

للعودة إلى القائمة الرئيسية في أي وقت، اكتب Hello.`,
      zh: `👨‍💼 已选择继续联系客服。

请通过文字或语音发送任何补充说明。

我们的团队会很快通过 WhatsApp 联系您。

如需随时返回主菜单，请输入 Hello。`
    }));

    return res.sendStatus(200);
  }

  await sendMessage(from, paymentChoiceInvalidText(session.language));

  return res.sendStatus(200);
}
  // Only show menu if already in MENU stage
else if (session.stage === "MENU") {
  await sendMessage(from, botText("menu_invalid", session.language));

  return res.sendStatus(200);
}

// Otherwise do nothing (prevent override)
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
app.post("/api/worker/jobs/:id/status", express.json(), async (req, res) => {
  try {
    const workerKey = req.headers["x-worker-key"];
    const jobId = req.params.id;
    const status = String(req.body?.status || "").trim().toLowerCase();
    const errorMessage = String(req.body?.error_message || "").trim();

    const validKeys = [
      process.env.WORKER_KEY,
      process.env.PRINTER_KEY,
      process.env.SYSTEM_KEY,
      process.env.DASHBOARD_KEY
    ].filter(Boolean);

    if (!workerKey || !validKeys.includes(workerKey)) {
      return res.status(403).json({ ok: false, error: "Unauthorized" });
    }

    const allowed = new Set(["printing", "completed", "failed"]);

    if (!allowed.has(status)) {
      return res.status(400).json({ ok: false, error: "Invalid status" });
    }

    const result = await pool.query(
      `
      UPDATE print_jobs
      SET status = $1,
          error_message = CASE
            WHEN $2 <> '' THEN $2
            ELSE error_message
          END,
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
      `,
      [status, errorMessage, jobId]
    );

    return res.json({ ok: true, job: result.rows[0] || null });

  } catch (err) {
    console.error("WORKER STATUS ERROR:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
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
  const key =
    req.headers["x-dashboard-key"] ||
    req.query.key ||
    req.body?.dashboard_key;

  // TEMP: allow access for testing
  if (!key) {
    console.log("No dashboard key provided — allowing for now");
    return next();
  }

  if (key !== DASHBOARD_KEY) {
    console.log("Invalid dashboard key:", key);
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
app.get("/dashboard", (req, res) => {
  const key = req.query.key;

  if (!key || key !== process.env.DASHBOARD_KEY) {
    return res.status(403).send("Access denied");
  }

  res.send(renderDashboardHtml());
});

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
  where.push(`(queue_type = 'AGENT' OR printer_id = $${params.length + 1})`);
  params.push(AGENT_QUEUE_ID);

} else if (queue === "dispatch") {
  where.push(`(queue_type = 'DISPATCH' OR printer_id = $${params.length + 1})`);
  params.push(DISPATCH_QUEUE_ID);

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
  SELECT
    id,
    printer_id,
    queue_type,
    status,
    file_url,
    original_name,
    paper_size,
    color_mode,
    copies,
    pages,
    instructions,
    instruction_audio_url,
    service_type,
    customer_phone,
    customer_name,
    customer_email,
    mime_type,
    created_at,
    updated_at
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
const customerSession = getSession(phone);
customerSession.selectedService = job.service_type || "SERVICE";
customerSession.lastServiceJobId = job.id;
customerSession.pendingFile = null;
customerSession.stage = "SERVICE_WAITING_EXTRA_NOTES";
    res.json({ ok: true, sent: true });
  } catch (err) {
    console.error("Dashboard reply error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Manual dashboard upload to queue
 */
// PUBLIC SHOPIFY UPLOAD (NO DASHBOARD KEY)
// ==============================
// PUBLIC SHOPIFY UPLOAD (WITH INSTRUCTIONS)
// ==============================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const {
      paper_size = "A4",
      color_mode = "BW",
      copies = "1",
      pages = "1",
      instructions = "",
      customer_name = "",
      customer_email = "",
      customer_phone = ""
    } = req.body;

    const normalizedPaperSize = String(paper_size || "A4").toUpperCase();
    const normalizedColorMode = String(color_mode || "BW").toUpperCase();
    const copiesNum = Math.max(1, parseInt(copies, 10) || 1);
    const pagesNum = Math.max(1, parseInt(pages, 10) || 1);

    const fileUrl = buildUploadUrl(req, file.filename);

    // Default printer routing
    let printerId = DEFAULT_PRINTER_ID;

    if (normalizedPaperSize === "A3") {
      printerId = A3_PRINTER_ID;
    }

    if (normalizedPaperSize === "CARD") {
      printerId = CARD_PRINTER_ID;
    }

    // ==============================
    // SAVE JOB TO DB (WITH INSTRUCTIONS)
    // ==============================
    const result = await pool.query(
      `
      INSERT INTO print_jobs (
        printer_id,
        status,
        file_url,
        original_name,
        paper_size,
        color_mode,
        copies,
        pages,
        instructions,
        customer_name,
        customer_email,
        customer_phone,
        created_at,
        updated_at
      )
      VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
      RETURNING *
      `,
      [
        printerId,
        fileUrl,
        file.originalname || file.filename,
        normalizedPaperSize,
        normalizedColorMode,
        copiesNum,
        pagesNum,
        instructions || "",
        customer_name || "",
        customer_email || "",
        customer_phone || ""
      ]
    );

    const job = result.rows[0];

    // ==============================
    // SUCCESS RESPONSE
    // ==============================
    return res.json({
      ok: true,
      job_id: job.id,
      file_url: fileUrl,
      instructions: job.instructions
    });

  } catch (err) {
    console.error("Shopify upload error:", err);
    return res.status(500).json({ ok: false, error: "Upload failed" });
  }
});

/**
 * Dashboard page
 */
app.post("/api/dashboard/manual-upload", requireDashboardKey, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
 const {
  customer_name = "",
  customer_phone = "",
  instructions = ""
} = req.body;
    if (!file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const fileUrl = buildUploadUrl(req, file.filename);

    const result = await pool.query(
      `
      INSERT INTO print_jobs (
        printer_id,
        queue_type,
        status,
        file_url,
        original_name,
        mime_type,
        customer_name,
customer_phone,
instructions,
        created_at,
        updated_at
      )
     VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING *
      `,
[
  DEFAULT_PRINTER_ID,
  "AGENT",
  fileUrl,
  file.originalname || file.filename,
  file.mimetype || "",
  customer_name,
  customer_phone,
  instructions
]
    );

    return res.json({ ok: true, job: result.rows[0] });
  } catch (err) {
    console.error("Manual upload error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
// ============================
// MANUAL DASHBOARD UPLOAD
// ============================
app.post("/api/dashboard/manual-upload", requireDashboardKey, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    const {
      customer_phone = "",
      service_type = "SERVICE",
      instructions = "",
      queue_type = "AGENT",
      paper_size = "",
      color_mode = "BW",
      copies = "1",
      pages = "1"
    } = req.body;

    if (!file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const normalizedQueue =
      queue_type === "WORKER"
        ? "WORKER"
        : queue_type === "DISPATCH"
        ? "DISPATCH"
        : "AGENT";

    const printerId =
      normalizedQueue === "WORKER"
        ? DEFAULT_PRINTER_ID
        : normalizedQueue === "DISPATCH"
        ? DISPATCH_QUEUE_ID
        : AGENT_QUEUE_ID;

    const fileUrl = buildUploadUrl(req, file.filename);

    const result = await pool.query(
      `
      INSERT INTO print_jobs (
        printer_id,
        queue_type,
        status,
        file_url,
        original_name,
        mime_type,
        customer_phone,
        service_type,
        instructions,
        paper_size,
        color_mode,
        copies,
        pages,
        created_at,
        updated_at
      )
      VALUES (
        $1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW()
      )
      RETURNING *
      `,
      [
        printerId,
        normalizedQueue,
        fileUrl,
        file.originalname || file.filename,
        file.mimetype || "",
        customer_phone,
        service_type,
        instructions,
        paper_size,
        color_mode,
        copies,
        pages
      ]
    );

    res.json({ ok: true, job: result.rows[0] });

  } catch (err) {
    console.error("Manual upload error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/worker-dashboard", requireDashboardKey, async (req, res) => {
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
      --panel:#0e1a2f;
      --panel2:#13233f;
      --line:rgba(255,255,255,.08);
      --text:#eef5ff;
      --muted:#a8b7d1;
      --gold:#ffcc4d;
      --blue:#42a5ff;
      --green:#2dd36f;
      --red:#ff6b6b;
      --purple:#a56dff;
      --cyan:#18d2d9;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      background:
        radial-gradient(circle at top right, rgba(66,165,255,.22), transparent 26%),
        radial-gradient(circle at top left, rgba(255,204,77,.14), transparent 24%),
        linear-gradient(180deg, #07101d 0%, #091425 100%);
      color:var(--text);
      font-family:Inter, Arial, sans-serif;
    }
    .wrap{max-width:1600px;margin:0 auto;padding:20px}
    .hero{
      display:grid;
      grid-template-columns: 1.3fr .7fr;
      gap:18px;
      margin-bottom:18px;
    }
    .heroCard,.stats,.panel,.sidePanel,.uploadPanel{
      background:linear-gradient(180deg, rgba(19,35,63,.95), rgba(10,19,35,.97));
      border:1px solid var(--line);
      border-radius:22px;
      box-shadow:0 20px 60px rgba(0,0,0,.32);
    }
    .heroCard{padding:24px}
    .heroTitle{
      font-size:30px;font-weight:800;letter-spacing:.2px;margin-bottom:8px;
    }
    .heroSub{color:var(--muted);line-height:1.6}
    .badgeRow{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}
    .badge{
      padding:10px 14px;border-radius:999px;
      background:rgba(255,255,255,.05);
      border:1px solid rgba(255,255,255,.08);
      color:#fff;font-size:13px;font-weight:700;
    }
    .stats{
      padding:18px;
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:12px;
      align-content:start;
    }
    .stat{
      padding:16px;border-radius:18px;background:rgba(255,255,255,.04);
      border:1px solid rgba(255,255,255,.06);
    }
    .stat .k{font-size:28px;font-weight:800;margin-top:6px}
    .toolbar{
      display:grid;
      grid-template-columns:1fr auto auto auto auto;
      gap:12px;
      margin-bottom:18px;
    }
    .toolbar input,.toolbar select,.toolbar button,.uploadPanel input,.uploadPanel select,.uploadPanel textarea{
      width:100%;
      background:#0c1730;
      color:#fff;
      border:1px solid rgba(255,255,255,.1);
      border-radius:14px;
      padding:12px 14px;
      outline:none;
    }
    .toolbar button,.btn{
      cursor:pointer;
      font-weight:800;
      border:none;
      background:linear-gradient(90deg, var(--blue), #74b9ff);
      color:#04111f;
    }
    .btn.secondary{background:linear-gradient(90deg, var(--gold), #ffd76e)}
    .btn.green{background:linear-gradient(90deg, #2dd36f, #68e89b)}
    .btn.red{background:linear-gradient(90deg, #ff6b6b, #ff8d8d)}
    .btn.purple{background:linear-gradient(90deg, var(--purple), #c19aff); color:white;}
    .btn.dark{background:linear-gradient(90deg, #2f3f5f, #4b618c); color:#fff;}
    .main{
      display:grid;
      grid-template-columns:1.25fr .75fr;
      gap:18px;
      align-items:start;
    }
    .panel{padding:16px}
    .sidePanel,.uploadPanel{padding:16px}
    .tabs{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
    .tab{
      padding:10px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.08);
      background:rgba(255,255,255,.04);cursor:pointer;font-weight:800;
    }
    .tab.active{background:linear-gradient(90deg, var(--gold), #ffd76e); color:#07111d}
    .jobGrid{display:grid;gap:16px}
    .jobCard{
      border:1px solid rgba(255,255,255,.08);
      border-radius:22px;
      overflow:hidden;
      background:linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02));
    }
    .jobHead{
      padding:16px;
      display:flex;justify-content:space-between;gap:12px;align-items:flex-start;
      border-bottom:1px solid rgba(255,255,255,.08);
      background:linear-gradient(90deg, rgba(255,204,77,.12), rgba(66,165,255,.09));
    }
    .jobTitle{font-size:18px;font-weight:800}
    .meta{color:var(--muted);font-size:13px;line-height:1.5}
    .pill{
      display:inline-block;padding:7px 10px;border-radius:999px;font-size:12px;font-weight:800;
      margin-left:6px;
    }
    .pill.pending{background:#ffe7a0;color:#4c3900}
    .pill.claimed{background:#b8e3ff;color:#003459}
    .pill.printing{background:#d1c0ff;color:#321a73}
    .pill.completed{background:#bdf4cf;color:#0e4c23}
    .pill.failed{background:#ffc2c2;color:#5e1010}
    .jobBody{
      padding:16px;
      display:grid;
      grid-template-columns:1.1fr .9fr;
      gap:16px;
    }
    .previewBox,.detailBox{
      background:rgba(0,0,0,.18);
      border:1px solid rgba(255,255,255,.06);
      border-radius:18px;
      padding:14px;
    }
    iframe,video,audio,img{
      width:100%;
      border-radius:14px;
      background:#000;
    }
    iframe{height:420px;border:none}
    video{max-height:420px}
    img{max-height:420px;object-fit:contain;background:#0a101a}
    .noPreview{
      min-height:220px;display:flex;align-items:center;justify-content:center;
      color:var(--muted);text-align:center;border:1px dashed rgba(255,255,255,.12);border-radius:14px;
      padding:20px;
    }
    .detailRow{display:grid;grid-template-columns:130px 1fr;gap:10px;margin-bottom:10px}
    .detailRow b{color:#ffd76e}
    .insBox,.replyBox,.noteBox{
      margin-top:14px;
      padding:12px;
      border-radius:14px;
      background:rgba(255,255,255,.04);
      border:1px solid rgba(255,255,255,.06);
    }
    textarea.reply{
      width:100%;min-height:100px;resize:vertical;
      margin-top:10px;background:#08111f;color:#fff;border:1px solid rgba(255,255,255,.1);
      border-radius:12px;padding:12px;
    }
    .actionRow{
      display:flex;flex-wrap:wrap;gap:8px;margin-top:14px
    }
    .routeRow{
      display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:14px
    }
    .sidePanel h3,.uploadPanel h3,.panel h3{margin:4px 0 14px 0}
    .printerList{display:grid;gap:10px;max-height:520px;overflow:auto;padding-right:4px}
    .printerGroup{
      border:1px solid rgba(255,255,255,.07);
      border-radius:16px;padding:12px;background:rgba(255,255,255,.03)
    }
    .printerState{font-weight:800;margin-bottom:6px}
    .printerItem{
      color:var(--muted);font-size:13px;line-height:1.5;padding-left:8px
    }
    .uploadPanel form{display:grid;gap:10px}
    .muted{color:var(--muted)}
    .topLinks{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
    .topLinks a{
      color:#07111d;text-decoration:none;background:linear-gradient(90deg,#ffd76e,#ffcc4d);
      padding:10px 14px;border-radius:12px;font-weight:800
    }
    .small{font-size:12px;color:var(--muted)}
    .emptyState{
      padding:30px;
      text-align:center;
      color:var(--muted);
      border:1px dashed rgba(255,255,255,.1);
      border-radius:18px;
      background:rgba(255,255,255,.02);
    }
    a.fileLink{color:#8fd1ff;text-decoration:none;font-weight:700}
    a.fileLink:hover{text-decoration:underline}
    @media (max-width: 1100px){
      .hero,.main,.jobBody,.toolbar{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div class="heroCard">
        <div class="heroTitle">PATAPATA MSTAF — Worker & Agent Command Dashboard</div>
        <div class="heroSub">
          Manage worker print jobs, agent service jobs, videos, images, PDFs, audio instructions, customer notes, WhatsApp replies, and routing from one clean control center.
        </div>
        <div class="badgeRow">
          <div class="badge">PDF Preview</div>
          <div class="badge">Image Preview</div>
          <div class="badge">Video Window</div>
          <div class="badge">Audio Playback</div>
          <div class="badge">Text Instructions</div>
          <div class="badge">WhatsApp Reply</div>
          <div class="badge">USA + Nigeria Routing</div>
        </div>
        <div class="topLinks">
          <a href="/worker-dashboard?key=${key}">Open Main Dashboard</a>
          <a href="/api/dashboard/jobs?key=${key}" target="_blank">Open Jobs API</a>
        </div>
      </div>

      <div class="stats" id="statsBox">
        <div class="stat"><div>All Jobs</div><div class="k" id="s_all">0</div></div>
        <div class="stat"><div>Pending</div><div class="k" id="s_pending">0</div></div>
        <div class="stat"><div>Printing / Claimed</div><div class="k" id="s_working">0</div></div>
        <div class="stat"><div>Completed</div><div class="k" id="s_completed">0</div></div>
      </div>
    </div>

    <div class="toolbar">
      <input id="q" placeholder="Search name, phone, instructions, service, queue..." />
      <select id="status">
        <option value="">All Status</option>
        <option value="pending">Pending</option>
        <option value="claimed">Claimed</option>
        <option value="printing">Printing</option>
        <option value="completed">Completed</option>
        <option value="failed">Failed</option>
      </select>
      <select id="queue">
        <option value="">All Queues</option>
        <option value="worker">Worker Queue</option>
        <option value="agent">Agent Queue</option>
        <option value="dispatch">Dispatch Queue</option>
      </select>
      <button class="btn secondary" onclick="loadJobs()">Refresh</button>
      <button class="btn" onclick="toggleUpload()">Manual Upload</button>
    </div>

    <div id="uploadPanel" class="uploadPanel" style="display:none; margin-bottom:18px;">
      <h3>Manual Dashboard Upload</h3>
      <form id="manualUploadForm">
        <input type="file" name="file" required />
        <select name="queue_type">
          <option value="AGENT">Send to Agent Queue</option>
          <option value="DISPATCH">Send to Dispatch Queue</option>
          <option value="WORKER">Send to Worker Queue</option>
        </select>
        <input name="service_type" placeholder="Service type e.g. PRINT, VIDEO_EDIT, IMAGE_EDIT, SERVICE" value="SERVICE" />
        <input name="customer_phone" placeholder="Customer WhatsApp number e.g. 15551234567" />
        <input name="paper_size" placeholder="Paper size e.g. A4, Letter, A3" />
        <input name="color_mode" placeholder="Color mode e.g. BW or COLOR" value="BW" />
        <input name="copies" type="number" min="1" value="1" />
        <input name="pages" type="number" min="1" value="1" />
        <textarea name="instructions" placeholder="Type text instruction here"></textarea>
        <button class="btn green" type="submit">Upload Job to Dashboard</button>
        <div class="small">Supports PDF, images, video, audio, and documents.</div>
      </form>
    </div>

    <div class="main">
      <div class="panel">
        <div class="tabs">
          <div class="tab active" onclick="setQueueTab('')" id="tab_all">All Jobs</div>
          <div class="tab" onclick="setQueueTab('worker')" id="tab_worker">Workers</div>
          <div class="tab" onclick="setQueueTab('agent')" id="tab_agent">Agents</div>
          <div class="tab" onclick="setQueueTab('dispatch')" id="tab_dispatch">Dispatch</div>
        </div>
        <div id="jobGrid" class="jobGrid"></div>
      </div>

      <div style="display:grid; gap:18px;">
        <div class="sidePanel">
          <h3>USA + Nigeria Printer Registry</h3>
          <div class="printerList">
            ${printers.map(group => `
              <div class="printerGroup">
                <div class="printerState">${escapeHtml(group.country)} — ${escapeHtml(group.state)}</div>
                ${group.printers.map(p => `
                  <div class="printerItem">• ${escapeHtml(p.label)}<br><span class="small">${escapeHtml(p.id)}</span></div>
                `).join("")}
              </div>
            `).join("")}
          </div>
        </div>

        <div class="sidePanel">
          <h3>Worker Notes</h3>
          <div class="muted">
            • Use <b>Claimed</b> when a worker picks a job.<br><br>
            • Use <b>Printing</b> when the print or edit is in progress.<br><br>
            • Use <b>Completed</b> after delivery / finished edit / finished print.<br><br>
            • Agent jobs route to <b>${escapeHtml(AGENT_QUEUE_ID)}</b>.<br><br>
            • Dispatch jobs route to <b>${escapeHtml(DISPATCH_QUEUE_ID)}</b>.<br><br>
            • File preview depends on valid <b>file_url</b> and <b>mime_type</b>.
          </div>
        </div>
      </div>
    </div>
  </div>

<script>
  const DASHBOARD_KEY = ${JSON.stringify(req.query.key || "")};
  let currentQueue = "";
  let isPremiumFilePickerOpen = false;
  let isUploadingPremiumMusic = false;
  let isRenderingPremiumVideo = false;

  function premiumWorkIsActive() {
    return isPremiumFilePickerOpen || isUploadingPremiumMusic || isRenderingPremiumVideo;
  }

  function toggleUpload() {
    const el = document.getElementById("uploadPanel");
    el.style.display = el.style.display === "none" ? "block" : "none";
  }

  function setQueueTab(queue) {
    currentQueue = queue;
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tab_" + (queue || "all")).classList.add("active");
    document.getElementById("queue").value = queue;
    loadJobs();
  }

  async function api(path, options = {}) {
    const finalUrl = path + (path.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(DASHBOARD_KEY);
    const res = await fetch(finalUrl, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  async function uploadPremiumMusic(orderId, input) {
    isPremiumFilePickerOpen = false;
    const file = input && input.files ? input.files[0] : null;
    if (!file) {
      isUploadingPremiumMusic = false;
      return;
    }

    isUploadingPremiumMusic = true;

    if (file.size > 30 * 1024 * 1024) {
      alert("Tribute music must be 30 MB or smaller.");
      input.value = "";
      isUploadingPremiumMusic = false;
      return;
    }

    const chooseButton = Array.from(document.querySelectorAll(".premiumMusicChooseButton")).find(
      (node) => String(node.dataset.orderId || "") === String(orderId || "")
    ) || null;
    const statusNode = Array.from(document.querySelectorAll(".premiumMusicStatus")).find(
      (node) => String(node.dataset.orderId || "") === String(orderId || "")
    ) || null;
    const originalLabel = chooseButton ? chooseButton.textContent : "🎵 Upload Custom Music";
    let uploadSucceeded = false;

    if (chooseButton) {
      chooseButton.disabled = true;
      chooseButton.textContent = "⏳ Uploading music...";
    }
    if (statusNode) statusNode.textContent = "Uploading " + file.name + "...";

    try {
      const fd = new FormData();
      fd.append("orderId", orderId);
      fd.append("tributeMusic", file, file.name);

      console.log("Starting Premium music upload", { orderId, name: file.name, bytes: file.size, type: file.type });

      const response = await fetch(
        "/api/greeting/premium/music?key=" + encodeURIComponent(DASHBOARD_KEY) +
          "&orderId=" + encodeURIComponent(orderId),
        { method: "POST", body: fd, credentials: "same-origin" }
      );
      const rawText = await response.text();
      let data = {};
      try { data = rawText ? JSON.parse(rawText) : {}; } catch (_) {}
      if (!response.ok || !data.ok) {
        throw new Error(data.error || rawText || ("Music upload failed with HTTP " + response.status));
      }

      uploadSucceeded = true;
      if (chooseButton) chooseButton.textContent = "✅ Replace Tribute Music";
      if (statusNode) {
        statusNode.textContent = "✅ " + (data.musicName || file.name) +
          " stored (" + (Number(data.storedBytes || file.size) / 1024 / 1024).toFixed(1) + " MB)";
      }
      const renderButton = Array.from(document.querySelectorAll(".premiumRenderButton")).find(
        (node) => String(node.dataset.orderId || "") === String(orderId || "")
      ) || null;
      if (renderButton) {
        renderButton.disabled = false;
        renderButton.removeAttribute("title");
      }
      alert(
        "✅ Custom tribute music uploaded successfully.\\n\\n" +
        "File: " + (data.musicName || file.name) + "\\n" +
        "Duration: " + Number(data.durationSeconds || 0).toFixed(0) + " seconds.\\n" +
        "You may now render the complete Premium video."
      );
      isUploadingPremiumMusic = false;
      await loadJobs();
    } catch (error) {
      console.error("Premium music upload failed", error);
      if (statusNode) statusNode.textContent = "❌ " + error.message;
      alert("Premium music upload failed: " + error.message);
    } finally {
      isUploadingPremiumMusic = false;
      isPremiumFilePickerOpen = false;
      input.value = "";
      if (chooseButton) {
        chooseButton.disabled = false;
        if (!uploadSucceeded) chooseButton.textContent = originalLabel;
      }
    }
  }

  function submitPremiumMusicForm(event, orderId) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();

    const form = event && event.currentTarget ? event.currentTarget : null;
    const input = form ? form.querySelector(".premiumMusicInput") : null;
    if (!input || !input.files || !input.files[0]) {
      alert("Choose the completed Suno tribute music file first.");
      return false;
    }

    uploadPremiumMusic(orderId, input);
    return false;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitForPremiumRender(orderId, button, oldText) {
    const startedAt = Date.now();
    let consecutiveStatusErrors = 0;

    while (true) {
      await delay(10000);

      try {
        const status = await api(
          "/api/greeting/premium/render-status?orderId=" + encodeURIComponent(orderId)
        );
        consecutiveStatusErrors = 0;

        const state = String(status.renderStatus || status.status || "").toLowerCase();
        const elapsedSeconds = Math.max(
          0,
          Math.round((Date.now() - startedAt) / 1000)
        );

        if (button) {
          button.textContent = state === "queued"
            ? "⏳ Render queued..."
            : "🎬 Rendering... " + elapsedSeconds + "s";
        }

        if (state === "completed") {
          alert(
            "✅ Premium video completed. Duration: " +
            Number(status.totalDuration || 0).toFixed(0) +
            " seconds."
          );
          if (status.finalVideoUrl) {
            window.open(status.finalVideoUrl, "_blank", "noopener");
          }
          await loadJobs();
          return;
        }

        if (state === "failed") {
          throw new Error(status.renderError || "Premium video rendering failed.");
        }
      } catch (error) {
        const message = String(error?.message || error || "");
        if (
          message.toLowerCase().includes("rendering failed") ||
          message.toLowerCase().includes("premium video rendering failed")
        ) {
          throw error;
        }

        // Temporary 502/503/network interruptions must not turn an active render
        // into a false failure message. Keep monitoring and let the server recover.
        consecutiveStatusErrors += 1;
        if (button) {
          button.textContent = consecutiveStatusErrors >= 3
            ? "⏳ Server reconnecting — render continues..."
            : "🎬 Rendering — checking status...";
        }
        await delay(Math.min(30000, consecutiveStatusErrors * 5000));
      }
    }
  }

  async function renderPremiumOrder(orderId, button) {
    if (!orderId) return;
    const confirmed = confirm(
      "Render the complete Premium video now? The music will play continuously to the final Printo screen."
    );
    if (!confirmed) return;

    isRenderingPremiumVideo = true;
    const oldText = button ? button.textContent : "🎬 Render Complete Video";
    if (button) {
      button.disabled = true;
      button.textContent = "⏳ Starting render...";
    }

    try {
      // Always request a fresh render from the worker dashboard. A completed
      // video may have been created with an older template or timing setup.
      const data = await api("/api/greeting/premium/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, force: true })
      });

      if (button) {
        button.textContent = data.status === "queued"
          ? "⏳ Render queued..."
          : "🎬 Rendering in progress...";
      }

      await waitForPremiumRender(orderId, button, oldText);
    } catch (error) {
      const message = String(error?.message || error || "");
      if (message.toLowerCase().includes("still running")) {
        if (button) button.textContent = "🎬 Rendering — monitoring...";
        await waitForPremiumRender(orderId, button, oldText);
      } else {
        alert("Premium render failed: " + message);
      }
    } finally {
      isRenderingPremiumVideo = false;
      if (button) {
        button.disabled = false;
        button.textContent = oldText;
      }
    }
  }

  function findPremiumMusicInput(orderId) {
    return Array.from(document.querySelectorAll(".premiumMusicInput")).find(
      (node) => String(node.dataset.orderId || "") === String(orderId || "")
    ) || null;
  }

  document.addEventListener("change", (event) => {
    const input = event.target && event.target.classList &&
      event.target.classList.contains("premiumMusicInput")
      ? event.target
      : null;
    if (input) uploadPremiumMusic(input.dataset.orderId || "", input);
  });

  window.addEventListener("focus", () => {
    if (!isPremiumFilePickerOpen) return;
    setTimeout(() => {
      const selectedFileExists = Array.from(
        document.querySelectorAll(".premiumMusicInput")
      ).some((input) => input.files && input.files.length > 0);

      if (!selectedFileExists && !isUploadingPremiumMusic) {
        isPremiumFilePickerOpen = false;
      }
    }, 700);
  });

  document.addEventListener("click", (event) => {
    const chooseButton = event.target.closest && event.target.closest(".premiumMusicChooseButton");
    if (chooseButton) {
      event.preventDefault();
      const orderId = chooseButton.dataset.orderId || "";
      const input = findPremiumMusicInput(orderId);
      if (!input) {
        alert("Music upload control was not found. Refresh the dashboard and try again.");
        return;
      }

      const statusNode = Array.from(document.querySelectorAll(".premiumMusicStatus")).find(
        (node) => String(node.dataset.orderId || "") === String(orderId)
      ) || null;

      if (statusNode) statusNode.textContent = "Choose the completed Suno audio file...";
      isPremiumFilePickerOpen = true;
      input.value = "";
      input.click();
      return;
    }

    const button = event.target.closest && event.target.closest(".premiumRenderButton");
    if (button && !button.hasAttribute("onclick")) {
      renderPremiumOrder(button.dataset.orderId || "", button);
    }
  });

  function summarize(jobs) {
    const all = jobs.length;
    const pending = jobs.filter(j => j.status === "pending").length;
    const completed = jobs.filter(j => j.status === "completed").length;
    const working = jobs.filter(j => j.status === "printing" || j.status === "claimed").length;
    document.getElementById("s_all").textContent = all;
    document.getElementById("s_pending").textContent = pending;
    document.getElementById("s_completed").textContent = completed;
    document.getElementById("s_working").textContent = working;
  }

  function statusPill(status = "") {
    const s = String(status || "pending").toLowerCase();
    return '<span class="pill ' + s + '">' + s.toUpperCase() + '</span>';
  }

  function h(v) {
    return String(v == null ? "" : v)
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
    const url = (job.file_url || "").toLowerCase();
    return mime.startsWith("video/") || [".mp4",".mov",".avi",".mkv",".webm",".m4v"].some(ext => name.endsWith(ext) || url.endsWith(ext));
  }

  function isAudio(job) {
    const mime = (job.mime_type || "").toLowerCase();
    const name = (job.original_name || "").toLowerCase();
    const url = (job.file_url || "").toLowerCase();
    return mime.startsWith("audio/") || [".mp3",".wav",".ogg",".opus",".m4a",".aac"].some(ext => name.endsWith(ext) || url.endsWith(ext));
  }

  function isImage(job) {
    const mime = (job.mime_type || "").toLowerCase();
    const name = (job.original_name || "").toLowerCase();
    const url = (job.file_url || "").toLowerCase();
    return mime.startsWith("image/") || [".jpg",".jpeg",".png",".webp",".gif"].some(ext => name.endsWith(ext) || url.endsWith(ext));
  }

  function normalizeUrl(url) {
    if (!url) return "";
    if (String(url).startsWith("http://") || String(url).startsWith("https://")) return url;
    return url;
  }

  function renderPreview(job) {
    const fileUrl = normalizeUrl(job.file_url || "");
    if (!fileUrl) {
      return '<div class="noPreview">No uploaded file found for this job.</div>';
    }

    if (isPdf(job)) {
      return '<iframe src="' + h(fileUrl) + '"></iframe>';
    }

    if (isVideo(job)) {
      return '<video controls preload="metadata" playsinline>' +
        '<source src="' + h(fileUrl) + '" type="' + h(job.mime_type || "video/mp4") + '">' +
        'Your browser cannot play this video.' +
      '</video>';
    }

    if (isAudio(job)) {
      return '<div class="noteBox"><b>Audio File</b><br><span class="small">' + h(job.original_name || "audio") + '</span></div>' +
        '<audio controls preload="metadata">' +
        '<source src="' + h(fileUrl) + '" type="' + h(job.mime_type || "audio/mpeg") + '">' +
        'Your browser cannot play this audio.' +
      '</audio>';
    }

    if (isImage(job)) {
      return '<img src="' + h(fileUrl) + '" alt="Uploaded image" />';
    }

    return '<div class="noPreview">Preview not available for this file type.<br><br><a class="fileLink" href="' + h(fileUrl) + '" target="_blank">Open file</a></div>';
  }

  function renderInstructionText(value) {
    const lines = String(value || "").split("\\n");
    return lines.map((line) => {
      const trimmed = String(line || "").trim();
      if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
        return '<a class="fileLink" href="' + h(trimmed) + '" target="_blank" rel="noopener noreferrer">Open uploaded file</a>';
      }
      return h(line);
    }).join("<br>");
  }

  function extractLabeledInstructionUrl(job, label) {
    const combined = [job.instructions || "", job.notes || "", job.error_message || ""].join("\\n");
    const lines = combined.split("\\n");
    const wanted = String(label || "").trim().toLowerCase() + ":";

    for (let index = 0; index < lines.length; index += 1) {
      if (String(lines[index] || "").trim().toLowerCase() !== wanted) continue;
      const possibleUrl = String(lines[index + 1] || "").trim();
      if (possibleUrl.startsWith("https://") || possibleUrl.startsWith("http://")) {
        return possibleUrl;
      }
    }

    return "";
  }

  function renderPremiumAssetLinks(job) {
    if (String(job.service_type || "").toUpperCase() !== "GREETING_PREMIUM") return "";

    const photoUrl = extractLabeledInstructionUrl(job, "Recipient photo");
    const videoUrl = extractLabeledInstructionUrl(job, "Personal introduction video");
    const orderId = extractPremiumOrderId(job);
    const combined = [job.instructions || "", job.notes || "", job.error_message || ""].join("\\n");
    const urls = combined.match(/https?:\\/\\/[^\\s<]+/g) || [];
    const musicUrl = urls.find((url) => url.includes("/premium-media/") && url.includes("/music?")) || "";
    const finalUrl = urls.find((url) => url.includes("/premium-media/") && url.includes("/final?")) || "";
    const buttons = [];

    if (photoUrl) {
      buttons.push('<a class="fileLink" href="' + h(photoUrl) + '" target="_blank" rel="noopener noreferrer">📸 Open Recipient Photo</a>');
    }
    if (videoUrl) {
      buttons.push('<a class="fileLink" href="' + h(videoUrl) + '" target="_blank" rel="noopener noreferrer">🎥 Play Introduction Video</a>');
    }
    if (musicUrl) {
      buttons.push('<a class="fileLink" href="' + h(musicUrl) + '" target="_blank" rel="noopener noreferrer">🎵 Play Tribute Music</a>');
    }
    if (finalUrl) {
      buttons.push('<a class="fileLink" href="' + h(finalUrl) + '" target="_blank" rel="noopener noreferrer">🎬 Play Finished Premium Video</a>');
    }
    if (orderId) {
      const uploadLabel = musicUrl ? "✅ Replace Tribute Music" : "🎵 Upload Tribute Music";
      buttons.push(
        '<span class="premiumMusicForm" data-order-id="' + h(orderId) + '" ' +
        'style="display:inline-flex;gap:7px;align-items:center;flex-wrap:wrap;">' +
          '<input class="premiumMusicInput" data-order-id="' + h(orderId) + '" name="tributeMusic" type="file" ' +
          'accept=".mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,audio/*" ' +
          'style="display:none;">' +
          '<button type="button" class="btn secondary premiumMusicChooseButton" data-order-id="' + h(orderId) + '">' + uploadLabel + '</button>' +
        '</span>'
      );
      buttons.push('<span class="small premiumMusicStatus" data-order-id="' + h(orderId) + '">' + (musicUrl ? '✅ Tribute music stored' : 'Choose the Suno song, then click Upload Tribute Music') + '</span>');
      buttons.push('<button type="button" class="btn premiumRenderButton" data-order-id="' + h(orderId) + '" onclick="renderPremiumOrder(&quot;' + h(orderId) + '&quot;, this); return false;"' + (musicUrl ? '' : ' disabled title="Upload tribute music first"') + '>🎬 Re-render Complete Video</button>');
    }

    if (!buttons.length) {
      return '<div class="insBox"><b>Premium Production</b><br><span class="small">No Premium assets were found on this job.</span></div>';
    }

    return '<div class="insBox"><b>Premium Production</b><br><div class="actionRow" style="margin-top:10px;">' + buttons.join(' ') + '</div><div class="small" style="margin-top:8px;">The introduction plays first. The uploaded Suno tribute song starts immediately afterward and continues to the final Printo screen.</div></div>';
  }

  function renderInstructions(job) {
    const parts = [];

    if (job.instructions) {
      parts.push('<div class="insBox"><b>Text Instruction</b><br>' + renderInstructionText(job.instructions) + '</div>');
    }

    if (job.notes) {
      parts.push('<div class="insBox"><b>Notes</b><br>' + renderInstructionText(job.notes) + '</div>');
    }

    if (job.error_message) {
      parts.push('<div class="insBox"><b>Error / Status Note</b><br>' + renderInstructionText(job.error_message) + '</div>');
    }

    if (!parts.length) {
      parts.push('<div class="insBox"><b>Text Instruction</b><br><span class="small">No saved text instruction on this job yet.</span></div>');
    }

if (!parts.length) {
  parts.push('<div class="insBox"><b>Text Instruction</b><br><span class="small">No saved text instruction on this job yet.</span></div>');
}

// ✅ SAFE VOICE PLAYER (no crash)
if (job.instruction_audio_url) parts.push('<div class="insBox"><b>🎧 Voice Instruction</b><br><audio controls style="width:100%;margin-top:5px;"><source src="' + job.instruction_audio_url + '" type="audio/ogg"></audio></div>');

return parts.join("");

    return parts.join("");
  }

  function routeOptions(job, printers) {
    const current = job.printer_id || "";
    let html = "";

    html += '<option value="PP-USA-001"' + (current === "PP-USA-001" ? " selected" : "") + '>USA A4 / Letter Hub</option>';
    html += '<option value="PP-USA-A3-001"' + (current === "PP-USA-A3-001" ? " selected" : "") + '>USA A3 / Card Special</option>';
    html += '<option value="AGENT"' + (current === "AGENT" ? " selected" : "") + '>Agent Queue</option>';
    html += '<option value="DISPATCH"' + (current === "DISPATCH" ? " selected" : "") + '>Dispatch Queue</option>';

    (printers || []).forEach(group => {
      (group.printers || []).forEach(p => {
        if (["PP-USA-001", "PP-USA-A3-001", "AGENT", "DISPATCH"].includes(p.id)) return;
        html += '<option value="' + h(p.id) + '"' + (current === p.id ? " selected" : "") + '>' + h(p.label) + '</option>';
      });
    });

    return html;
  }

  function extractGreetingCustomerKey(job) {
    const combined = [
      job.instructions || "",
      job.notes || "",
      job.error_message || ""
    ].join("\\n");

    const match = combined.match(/Customer key:\\s*(g_[a-f0-9]{64})/i);
    return match ? match[1] : "";
  }

  function extractPremiumOrderId(job) {
    const combined = [
      job.instructions || "",
      job.notes || "",
      job.error_message || ""
    ].join("\\n");
    const match = combined.match(/(?:Premium order ID:\\s*)?(PPM-[A-Z0-9-]+)/i);
    return match ? match[1] : "";
  }

  function renderJob(job, printers) {
    const fileUrl = job.file_url || "";
    const title = job.original_name || job.service_type || ("Job #" + job.id);
    const greetingCustomerKey = extractGreetingCustomerKey(job);
    const greetingApprovalButton =
      String(job.service_type || "").toUpperCase() === "GREETING_CARD" &&
      greetingCustomerKey
        ? '<button class="btn green" onclick="approveGreetingCredit(&quot;' +
          h(greetingCustomerKey) +
          '&quot;,&quot;' +
          h(job.customer_phone || "") +
          '&quot;,&quot;' +
          h(job.id || "") +
          '&quot;)">Approve Greeting Payment</button>'
        : "";
    const premiumOrderId = extractPremiumOrderId(job);
    const premiumApprovalButton =
      String(job.service_type || "").toUpperCase() === "GREETING_PREMIUM" && premiumOrderId
        ? '<button class="btn green" onclick="approvePremiumPayment(&quot;' +
          h(premiumOrderId) +
          '&quot;,&quot;' +
          h(job.id || "") +
          '&quot;)">Approve Premium Payment</button>'
        : "";
    return \`
      <div class="jobCard">
        <div class="jobHead">
          <div>
            <div class="jobTitle">Job #\${h(job.id)} — \${h(title)}</div>
            <div class="meta">
              Queue: \${h(job.queue_type || "WORKER")} |
              Printer: \${h(job.printer_id || "-")} |
              Service: \${h(job.service_type || "-")}
              \${statusPill(job.status)}
            </div>
          </div>
          <div class="meta" style="text-align:right">
            Phone: \${h(job.customer_phone || "-")}<br>
            Paper: \${h(job.paper_size || "N/A")}<br>
            Color: \${h(job.color_mode || "BW")}<br>
            Copies: \${h(job.copies || 1)}
          </div>
        </div>

        <div class="jobBody">
          <div class="previewBox">
            \${renderPreview(job)}
          </div>

          <div class="detailBox">
            <div class="detailRow"><b>File URL</b><div>\${fileUrl ? '<a class="fileLink" href="' + h(fileUrl) + '" target="_blank">Open file</a>' : '<span class="small">No file</span>'}</div></div>
            <div class="detailRow"><b>Original Name</b><div>\${h(job.original_name || "-")}</div></div>
            <div class="detailRow"><b>MIME Type</b><div>\${h(job.mime_type || "-")}</div></div>
            <div class="detailRow"><b>Pages</b><div>\${h(job.pages || 1)}</div></div>
            <div class="detailRow"><b>Created</b><div>\${h(job.created_at || "-")}</div></div>
            <div class="detailRow"><b>Customer</b><div>\${h(job.customer_phone || "-")}</div></div>

            \${renderInstructions(job)}
            \${renderPremiumAssetLinks(job)}

            <div class="routeRow">
              <select id="route_\${h(job.id)}">
                \${routeOptions(job, printers)}
              </select>
              <button class="btn dark" onclick="routeJob('\${h(job.id)}')">Route</button>
            </div>

            <div class="actionRow">
              <button class="btn secondary" onclick="markJob('\${h(job.id)}','claimed')">Claim</button>
              <button class="btn purple" onclick="markJob('\${h(job.id)}','printing')">Start</button>
              <button class="btn green" onclick="markJob('\${h(job.id)}','completed')">Complete</button>
              <button class="btn red" onclick="markJob('\${h(job.id)}','failed')">Fail</button>
              \${greetingApprovalButton}
              \${premiumApprovalButton}
            </div>

            <div class="replyBox">
              <b>Reply on WhatsApp</b>
              <textarea id="reply_\${h(job.id)}" class="reply" placeholder="Type your update to the customer here..."></textarea>
              <div class="actionRow">
                <button class="btn" onclick="replyJob('\${h(job.id)}')">Send Reply</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    \`;
  }

  async function loadJobs() {
    const grid = document.getElementById("jobGrid");
    try {
      if (grid) {
        grid.innerHTML = '<div class="emptyState">Loading jobs...</div>';
      }

      const q = (document.getElementById("q")?.value || "").trim();
      const status = document.getElementById("status")?.value || "";
      const queue = document.getElementById("queue")?.value || currentQueue || "";

      const params = new URLSearchParams();
      params.set("key", DASHBOARD_KEY);
      params.set("_", String(Date.now()));
      if (q) params.set("q", q);
      if (status) params.set("status", status);
      if (queue) params.set("queue", queue);

      const response = await fetch("/api/dashboard/jobs?" + params.toString(), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });

      const rawText = await response.text();
      let data = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (_error) {
        throw new Error("Jobs API returned invalid JSON: " + rawText.slice(0, 180));
      }

      if (!response.ok || data.ok === false) {
        throw new Error(data.error || ("Jobs API failed with HTTP " + response.status));
      }

      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      const printers = Array.isArray(data.printers) ? data.printers : [];

      summarize(jobs);

      if (!grid) return;
      if (!jobs.length) {
        grid.innerHTML = '<div class="emptyState">No jobs found for the selected filter.</div>';
        return;
      }

      const cards = jobs.map((job) => {
        try {
          return renderJob(job || {}, printers);
        } catch (renderError) {
          console.error("Job card render failed", job, renderError);
          return '<div class="jobCard"><div class="jobHead"><div class="jobTitle">Job #' +
            h(job?.id || "Unknown") +
            '</div></div><div class="jobBody"><div class="emptyState">This job could not be displayed: ' +
            h(renderError.message || String(renderError)) +
            '</div></div></div>';
        }
      });

      grid.innerHTML = cards.join("");
    } catch (err) {
      console.error("Worker dashboard load failed", err);
      document.getElementById("s_all").textContent = "0";
      document.getElementById("s_pending").textContent = "0";
      document.getElementById("s_completed").textContent = "0";
      document.getElementById("s_working").textContent = "0";
      if (grid) {
        grid.innerHTML = '<div class="emptyState">Dashboard load failed: ' + h(err.message || String(err)) + '</div>';
      }
    }
  }

  async function markJob(id, status) {
    try {
      await api("/api/dashboard/jobs/" + id + "/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      loadJobs();
    } catch (err) {
      alert("Mark failed: " + err.message);
    }
  }

  async function routeJob(id) {
    try {
      const printer_id = document.getElementById("route_" + id).value;
      await api("/api/dashboard/jobs/" + id + "/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ printer_id })
      });
      loadJobs();
    } catch (err) {
      alert("Route failed: " + err.message);
    }
  }

  async function approveGreetingCredit(customerKey, customerPhone, jobId) {
    try {
      if (!customerKey) {
        return alert("Greeting customer key was not found on this job.");
      }

      const confirmed = confirm(
        "Confirm payment and add one greeting credit for this customer?"
      );
      if (!confirmed) return;

      const data = await api("/api/greeting/payment/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerKey,
          customerPhone,
          credits: 1,
          provider: "africa_manual",
          reference:
            "africa:job:" + (jobId || customerKey)
        })
      });

      alert(
        "Greeting payment approved. Available paid credits: " +
        (data.result?.status?.paidCredits ?? 1)
      );
      loadJobs();
    } catch (err) {
      alert("Greeting payment approval failed: " + err.message);
    }
  }

  async function approvePremiumPayment(orderId, jobId) {
    try {
      if (!orderId) return alert("Premium order ID was not found on this job.");
      const confirmed = confirm(
        "Confirm Africa/manual payment for premium order " + orderId + "?"
      );
      if (!confirmed) return;
      const data = await api("/api/greeting/premium/payment/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          provider: "africa_manual",
          reference: "africa:premium:job:" + (jobId || orderId)
        })
      });
      alert(
        data.result?.duplicate
          ? "This premium payment was already approved."
          : "Premium payment approved. The worker can begin production."
      );
      loadJobs();
    } catch (err) {
      alert("Premium payment approval failed: " + err.message);
    }
  }

  async function replyJob(id) {
    try {
      const message = document.getElementById("reply_" + id).value.trim();
      if (!message) return alert("Type a message first.");
      await api("/api/dashboard/jobs/" + id + "/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      alert("WhatsApp reply sent.");
      document.getElementById("reply_" + id).value = "";
    } catch (err) {
      alert("Reply failed: " + err.message);
    }
  }

  function initializeWorkerDashboard() {
    const qInput = document.getElementById("q");
    const statusSelect = document.getElementById("status");
    const queueSelect = document.getElementById("queue");
    const manualUploadForm = document.getElementById("manualUploadForm");

    qInput?.addEventListener("input", () => loadJobs());
    statusSelect?.addEventListener("change", () => loadJobs());
    queueSelect?.addEventListener("change", () => loadJobs());

    manualUploadForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const fd = new FormData(e.target);
        const res = await fetch("/api/dashboard/manual-upload?key=" + encodeURIComponent(DASHBOARD_KEY), {
          method: "POST",
          body: fd,
          credentials: "same-origin"
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Upload failed");
        alert("Dashboard upload created successfully.");
        e.target.reset();
        await loadJobs();
      } catch (err) {
        alert("Manual upload failed: " + err.message);
      }
    });

    window.addEventListener("error", (event) => {
      const grid = document.getElementById("jobGrid");
      if (grid && !grid.children.length) {
        grid.innerHTML = '<div class="emptyState">Dashboard JavaScript error: ' + h(event.message || "Unknown error") + '</div>';
      }
    });

    loadJobs();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeWorkerDashboard, { once: true });
  } else {
    initializeWorkerDashboard();
  }
  function mediaIsPlaying() {
  return [...document.querySelectorAll("video, audio")].some(
    el => !el.paused && !el.ended
  );
}

let isUserTyping = false;

document.addEventListener("focusin", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
    isUserTyping = true;
  }
});

document.addEventListener("focusout", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
    isUserTyping = false;
  }
});

setInterval(() => {
  if (mediaIsPlaying()) return;
  if (isUserTyping) return;
  if (premiumWorkIsActive()) return;
  loadJobs();
}, 8000);
</script>
</body>
</html>`);
});
 

/******************************************************************
 * WORKER + AGENT DASHBOARD END
 ******************************************************************/

  

app.get("/api/greeting/birthday/assets", (req, res) => {
  const base = path.join(__dirname, "templates", "birthday");

  res.json({
    frame: require("fs").existsSync(path.join(base, "frame.png")),
    printo: require("fs").existsSync(path.join(base, "printo.png")),
    master: require("fs").existsSync(path.join(base, "master.mp4")),
    audio: require("fs").existsSync(path.join(base, "birthday_audio.m4a")),
    folder: base
  });
});

 function buildGeneratedUrl(req, fileName) {
  const base = getConfiguredPublicOrigin(req);

  return `${base}/generated/${encodeURIComponent(fileName)}`;
}

function safeGreetingText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "’")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteDrawtextText(value = "") {
  return `'${safeGreetingText(value)}'`;
}

function wrapGreetingName(value = "") {
  const normalized = String(value || "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return ["", ""];

  const words = normalized.split(" ").filter(Boolean);

  // Keep a single long name whole; responsive font sizing will make it fit.
  if (words.length === 1) {
    return [normalized, ""];
  }

  // Choose the most balanced split without breaking words.
  let bestFirst = words[0];
  let bestSecond = words.slice(1).join(" ");
  let bestDifference = Math.abs(
    Array.from(bestFirst).length - Array.from(bestSecond).length
  );

  for (let i = 1; i < words.length; i += 1) {
    const first = words.slice(0, i).join(" ");
    const second = words.slice(i).join(" ");
    const difference = Math.abs(
      Array.from(first).length - Array.from(second).length
    );

    if (difference < bestDifference) {
      bestFirst = first;
      bestSecond = second;
      bestDifference = difference;
    }
  }

  return [bestFirst, bestSecond];
}

function getGreetingNameFontSize(lines = []) {
  const longestLine = Math.max(
    0,
    ...lines.map((line) => Array.from(String(line || "")).length)
  );

  // Short names appear large and prominent. Longer names shrink only as needed.
  if (longestLine <= 5) return 34;
  if (longestLine <= 7) return 31;
  if (longestLine <= 9) return 28;
  if (longestLine <= 11) return 25;
  if (longestLine <= 13) return 22;
  if (longestLine <= 15) return 19;
  if (longestLine <= 17) return 17;
  if (longestLine <= 19) return 15;
  if (longestLine <= 21) return 13;
  return 11;
}

function getGreetingMessageLayout(value = "") {
  const messageLength = Array.from(String(value || "").trim()).length;

  let maxLines;
  let fontSize;
  let lineGap;

  if (messageLength <= 35) {
    maxLines = 2;
    fontSize = 34;
    lineGap = 42;
  } else if (messageLength <= 60) {
    maxLines = 3;
    fontSize = 29;
    lineGap = 36;
  } else if (messageLength <= 90) {
    maxLines = 4;
    fontSize = 25;
    lineGap = 32;
  } else if (messageLength <= 120) {
    maxLines = 6;
    fontSize = 21;
    lineGap = 28;
  } else if (messageLength <= 150) {
    maxLines = 7;
    fontSize = 18;
    lineGap = 25;
  } else if (messageLength <= 180) {
    maxLines = 8;
    fontSize = 15;
    lineGap = 23;
  } else if (messageLength <= 205) {
    maxLines = 9;
    fontSize = 11;
    lineGap = 19;
  } else {
    maxLines = 10;
    fontSize = 10;
    lineGap = 18;
  }

  const lines = wrapCompleteGreetingMessage(value, maxLines);
  const usedLines = Math.max(
    1,
    lines.filter((line) => String(line || "").trim()).length
  );

  // Keep every message centered vertically inside the safe text area.
  const safeTop = 1088;
  // Stop well above the purple heart decoration.
  const safeBottom = 1248;
  const blockHeight = (usedLines - 1) * lineGap;
  const startY = Math.round(
    safeTop + Math.max(0, (safeBottom - safeTop - blockHeight) / 2)
  );

  return {
    lines: [...lines, ...Array(Math.max(0, 10 - lines.length)).fill("")].slice(0, 10),
    fontSize,
    lineGap,
    startY,
    usedLines,
    messageLength
  };
}

function wrapCompleteGreetingMessage(value = "", maxLines = 9) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return Array(maxLines).fill("");

  const chars = Array.from(normalized);
  const target = Math.max(1, Math.ceil(chars.length / maxLines));
  const lines = [];
  let remaining = normalized;

  while (remaining && lines.length < maxLines) {
    const slotsLeft = maxLines - lines.length;
    const remainingChars = Array.from(remaining);

    if (slotsLeft === 1) {
      lines.push(remaining);
      remaining = "";
      break;
    }

    const ideal = Math.max(target, Math.ceil(remainingChars.length / slotsLeft));
    let cut = Math.min(ideal, remainingChars.length);

    // Prefer ending at a nearby space, but never lose characters.
    const searchStart = Math.max(1, cut - 5);
    const searchEnd = Math.min(remainingChars.length - 1, cut + 5);
    let bestSpace = -1;

    for (let i = searchEnd; i >= searchStart; i -= 1) {
      if (remainingChars[i] === " ") {
        bestSpace = i;
        break;
      }
    }

    if (bestSpace > 0) cut = bestSpace;

    const line = remainingChars.slice(0, cut).join("").trim();
    lines.push(line);
    remaining = remainingChars.slice(cut).join("").trim();
  }

  while (lines.length < maxLines) lines.push("");
  return lines.slice(0, maxLines);
}

function wrapBirthdayMessage(value = "", maxChars = 28, maxLines = 5) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  const words = normalized.split(" ").filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (Array.from(next).length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);

  // Split an unusually long word safely by Unicode characters.
  const fitted = [];
  for (const line of lines) {
    const chars = Array.from(line);
    if (chars.length <= maxChars) {
      fitted.push(line);
    } else {
      for (let i = 0; i < chars.length; i += maxChars) {
        fitted.push(chars.slice(i, i + maxChars).join(""));
      }
    }
  }

  const result = fitted.slice(0, maxLines);
  while (result.length < maxLines) result.push("");
  return result;
}

const BIRTHDAY_NAME_MAX = 24;
const BIRTHDAY_MESSAGE_MAX = 220;

function limitGreetingInput(value = "", maxLength = 80) {
  return Array.from(
    String(value || "")
      .replace(/\s+/g, " ")
      .trim()
  ).slice(0, maxLength).join("");
}


function normalizeSpeechComparisonText(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureSpeechSentence(value = "") {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return /[.!?。！？]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function buildPrintoBirthdayVoiceText({ recipientName, senderName, message }) {
  const cleanRecipient = String(recipientName || "").replace(/\s+/g, " ").trim();
  const cleanSender = String(senderName || "").replace(/\s+/g, " ").trim();
  const cleanMessage = String(message || "").replace(/\s+/g, " ").trim();
  const comparisonMessage = normalizeSpeechComparisonText(cleanMessage);
  const comparisonRecipient = normalizeSpeechComparisonText(cleanRecipient);

  const birthdayOpeners = [
    "happy birthday",
    "feliz cumpleanos",
    "joyeux anniversaire",
    "alles gute zum geburtstag",
    "herzlichen gluckwunsch zum geburtstag",
    "feliz aniversario",
    "عيد ميلاد سعيد",
    "生日快乐"
  ];

  const messageAlreadyStartsWithBirthday = birthdayOpeners.some((opener) =>
    comparisonMessage.startsWith(normalizeSpeechComparisonText(opener))
  );
  const messageAlreadyMentionsRecipient = Boolean(
    comparisonRecipient && comparisonMessage.includes(comparisonRecipient)
  );

  let spokenGreeting;
  if (messageAlreadyStartsWithBirthday) {
    // The customer's message already says Happy Birthday. Speak the recipient
    // once, but do not insert a second automatic Happy Birthday.
    spokenGreeting = messageAlreadyMentionsRecipient
      ? ensureSpeechSentence(cleanMessage)
      : ensureSpeechSentence(`${cleanRecipient}, ${cleanMessage}`);
  } else {
    spokenGreeting = ensureSpeechSentence(`Happy Birthday, ${cleanRecipient}. ${cleanMessage}`);
  }

  return `${spokenGreeting} ${ensureSpeechSentence(`This greeting is from ${cleanSender}`)}`.trim();
}

async function generatePrintoBirthdayVoice({ recipientName, senderName, message, outputPath }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    console.log("Printo voice skipped: ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID is missing.");
    return { ok: false, reason: "missing_elevenlabs_config" };
  }

  const voiceText = buildPrintoBirthdayVoiceText({ recipientName, senderName, message });

  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        text: voiceText,
        model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
        voice_settings: {
          stability: Number(process.env.ELEVENLABS_STABILITY || 0.5),
          similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.75),
          style: Number(process.env.ELEVENLABS_STYLE || 0.2),
          use_speaker_boost: true
        }
      },
      {
        responseType: "arraybuffer",
        timeout: 60000,
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg"
        }
      }
    );

    fs.writeFileSync(outputPath, Buffer.from(response.data));
    return { ok: true, outputPath, text: voiceText };
  } catch (err) {
    console.error("Printo ElevenLabs voice generation failed:", err.response?.data || err.message);
    return { ok: false, reason: "voice_generation_failed", error: err.message };
  }
}

function buildGreetingResultUrl(req, videoUrl, toName = "", fromName = "", posterUrl = "", language = "en") {
  const base = getConfiguredPublicOrigin(req);

  const params = new URLSearchParams({
    video: videoUrl,
    to: String(toName || ""),
    from: String(fromName || ""),
    poster: String(posterUrl || ""),
    lang: String(language || "en")
  });

  return `${base}/greeting-result?${params.toString()}`;
}

function createShortGreetingId() {
  const timePart = Date.now().toString(36).slice(-6);
  const randomPart = Math.random().toString(36).slice(2, 6);
  return `${timePart}${randomPart}`;
}

function buildShortGreetingUrl(req, greetingId = "") {
  const base = String(
    getConfiguredPublicOrigin(req)
  ).replace(/\/$/, "");

  return `${base}/g/${encodeURIComponent(greetingId)}`;
}

function getGreetingMetadataPath(greetingId = "") {
  const safeId = String(greetingId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(generatedDir, `${safeId}.json`);
}

function saveGreetingMetadata(greetingId, metadata = {}) {
  const metadataPath = getGreetingMetadataPath(greetingId);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
  return metadataPath;
}

function loadGreetingMetadata(greetingId) {
  try {
    const metadataPath = getGreetingMetadataPath(greetingId);
    if (!fs.existsSync(metadataPath)) return null;
    return JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  } catch (error) {
    console.error("Greeting metadata read failed:", error);
    return null;
  }
}


// =========================
// BIRTHDAY BACKGROUND RENDER JOBS
// =========================
const birthdayJobDir = path.join(generatedDir, "birthday-jobs");
if (!fs.existsSync(birthdayJobDir)) {
  fs.mkdirSync(birthdayJobDir, { recursive: true });
}

// Keep Standard greeting rendering inside the memory available on smaller Render
// instances. Only one birthday FFmpeg pipeline is allowed to run at a time, and
// the finished card is rendered at a phone-friendly 768x1152 resolution.
const BIRTHDAY_RENDER_WIDTH = 768;
const BIRTHDAY_RENDER_HEIGHT = 1152;
const BIRTHDAY_RENDER_SCALE = BIRTHDAY_RENDER_WIDTH / 1024;
let birthdayRenderQueueTail = Promise.resolve();
let birthdayRenderQueueDepth = 0;

function scaleBirthdayRenderValue(value) {
  return Math.max(1, Math.round(Number(value || 0) * BIRTHDAY_RENDER_SCALE));
}

async function runBirthdayRenderQueued(jobId, task) {
  birthdayRenderQueueDepth += 1;
  const queuePosition = birthdayRenderQueueDepth;

  if (queuePosition > 1) {
    saveBirthdayJobStatus(jobId, {
      status: "queued",
      progress: 24,
      message: `Your video is number ${queuePosition} in the safe render queue.`
    });
  }

  const run = birthdayRenderQueueTail
    .catch(() => {})
    .then(async () => {
      saveBirthdayJobStatus(jobId, {
        status: "rendering",
        progress: 30,
        message: "Printo is rendering your video with memory-safe settings."
      });
      return task();
    });

  birthdayRenderQueueTail = run.catch(() => {});

  try {
    return await run;
  } finally {
    birthdayRenderQueueDepth = Math.max(0, birthdayRenderQueueDepth - 1);
  }
}

function createBirthdayJobId() {
  return `bday_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function getBirthdayJobPath(jobId = "") {
  const safeId = String(jobId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(birthdayJobDir, `${safeId}.json`);
}

function saveBirthdayJobStatus(jobId, patch = {}) {
  const jobPath = getBirthdayJobPath(jobId);
  let current = {};
  try {
    if (fs.existsSync(jobPath)) current = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  } catch (error) {
    console.error("Birthday job status read failed:", error.message);
  }
  const next = {
    ...current,
    ...patch,
    jobId,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(jobPath, JSON.stringify(next, null, 2));
  return next;
}

function loadBirthdayJobStatus(jobId) {
  try {
    const jobPath = getBirthdayJobPath(jobId);
    if (!fs.existsSync(jobPath)) return null;
    return JSON.parse(fs.readFileSync(jobPath, "utf8"));
  } catch (error) {
    console.error("Birthday job status load failed:", error.message);
    return null;
  }
}

function buildBirthdayProgressUrl(req, jobId, language = "en") {
  const base = String(
    getConfiguredPublicOrigin(req)
  ).replace(/\/$/, "");
  return `${base}/birthday-progress/${encodeURIComponent(jobId)}?lang=${encodeURIComponent(language)}`;
}

app.post("/api/greeting/birthday/generate", async (req, res) => {
  console.log("[Birthday Generate] Request received", {
    customerId: req.body?.customerId || req.get("x-printo-customer-id") || "",
    language: req.body?.language || "en",
    hasRecipient: Boolean(String(req.body?.to || "").trim()),
    hasSender: Boolean(String(req.body?.from || "").trim()),
    messageLength: String(req.body?.message || "").length
  });
  let accessReservation = null;
  let customerIdentity = null;
  let birthdayJobId = "";
  let birthdayResponseSent = false;
  let birthdayGreetingId = "";
  let birthdayGenerationRecordCreated = false;
  let birthdayVoicePath = "";
  let birthdayPersonalizedFramePath = "";

  try {
    console.log("Birthday generator request received:", req.body);

    const requestLanguage = ["en", "es", "fr", "de", "pt", "ar", "zh"].includes(String(req.body.language || req.body.lang || "en").toLowerCase())
      ? String(req.body.language || req.body.lang || "en").toLowerCase()
      : "en";
    const toNameRaw = limitGreetingInput(req.body.to || "Mary", BIRTHDAY_NAME_MAX);
    const fromNameRaw = limitGreetingInput(req.body.from || "John", BIRTHDAY_NAME_MAX);
    const messageRaw = limitGreetingInput(
      req.body.message || "Wishing you happiness, laughter, and a wonderful celebration!",
      BIRTHDAY_MESSAGE_MAX
    );

    const toNameLines = wrapGreetingName(toNameRaw);
    const fromNameLines = wrapGreetingName(fromNameRaw);

    const longestToLine = Math.max(
      ...toNameLines.map((line) => Array.from(line || "").length),
      0
    );
    const longestFromLine = Math.max(
      ...fromNameLines.map((line) => Array.from(line || "").length),
      0
    );

    const toFontSize = getGreetingNameFontSize(toNameLines);
    const fromFontSize = getGreetingNameFontSize(fromNameLines);

    const messageLayout = getGreetingMessageLayout(messageRaw);
    const messageLines = messageLayout.lines;
    const messageLength = messageLayout.messageLength;
    const messageFontSize = messageLayout.fontSize;
    const messageLineGap = messageLayout.lineGap;
    const messageStartY = messageLayout.startY;

    const toUsedLines = toNameLines.filter((line) => String(line || "").trim()).length;
    const fromUsedLines = fromNameLines.filter((line) => String(line || "").trim()).length;
    const toNameStartY = toUsedLines <= 1 ? 500 : 478;
    const fromNameStartY = fromUsedLines <= 1 ? 500 : 478;
    const nameLineGap = 40;

    const birthdayDir = path.join(__dirname, "templates", "birthday");
    const birthdayV2FramePath = path.join(birthdayDir, "Birthday_Image_V2.png");
    const legacyFramePath = path.join(birthdayDir, "frame.png");
    const framePath = fs.existsSync(birthdayV2FramePath)
      ? birthdayV2FramePath
      : legacyFramePath;
    const masterPath = path.join(birthdayDir, "master.mp4");
    // Use the same Printo theme finder as the studio music player so the
    // generator supports birthday_audio.m4a, birthday_audio.mp3, music.mp3,
    // theme.mp3, printo-theme.mp3, or PRINTO_THEME_FILE.
    const audioPath = findPrintoThemeFile();
    const hasBirthdayMusic = Boolean(audioPath && fs.existsSync(audioPath));

    console.log("Birthday frame path:", framePath, fs.existsSync(framePath));
    console.log("Birthday master path:", masterPath, fs.existsSync(masterPath));
    console.log("Birthday music path:", audioPath || "NOT FOUND", hasBirthdayMusic);

    if (
      !fs.existsSync(framePath) ||
      !fs.existsSync(masterPath)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Birthday template assets missing. Birthday_Image_V2.png (or frame.png) and master.mp4 are required."
      });
    }

    // Never charge credits or create an incomplete voice-only card when the
    // promised Printo background music asset is unavailable.
    if (!hasBirthdayMusic) {
      return res.status(503).json({
        ok: false,
        error: "Printo birthday music is temporarily unavailable. No credits were used."
      });
    }

    customerIdentity = getGreetingCustomerIdentity(req, req.body || {});
    if (customerIdentity.identitySource !== "customer_key") {
      return res.status(401).json({
        ok: false,
        loginRequired: true,
        error: "Please log in to your Printo account before generating."
      });
    }
    const registeredAccount = await queryWithRetry(
      `SELECT email FROM greeting_customer_accounts WHERE customer_key = $1 LIMIT 1`,
      [customerIdentity.customerKey]
    );
    if (!registeredAccount.rows[0]) {
      return res.status(401).json({
        ok: false,
        loginRequired: true,
        error: "Your Printo login has expired. Please log in again."
      });
    }

    // Confirm that the persistent Standard-video schema is fully upgraded
    // before credits are reserved for this generation.
    await ensureGreetingAccessTables();

    accessReservation = await reserveGreetingGenerationAccess(
      customerIdentity.customerKey,
      customerIdentity.contactPhone,
      "standard"
    );

    if (!accessReservation.allowed) {
      const payment = buildGreetingPaymentLinks({
        customerKey: customerIdentity.customerKey,
        templateId: "birthday",
        contactPhone: customerIdentity.contactPhone
      });

      const paymentJob = await createGreetingDashboardJob({
        templateId: "birthday",
        occasion: "Birthday",
        recipientName: toNameRaw,
        senderName: fromNameRaw,
        message: messageRaw,
        language: requestLanguage,
        customerName: fromNameRaw,
        customerPhone: customerIdentity.contactPhone,
        checkoutUrl: payment.shopify,
        downloadUrl: "",
        status: "pending",
        accessNote: `PAYMENT REQUIRED BEFORE GENERATION

Customer key: ${customerIdentity.customerKey}
Identity source: ${customerIdentity.identitySource}
Shopify: ${payment.shopify}
Africa Payment: ${payment.africa}`
      });

      return res.status(402).json({
        ok: false,
        paymentRequired: true,
        error:
          "You need 20 credits to create another greeting. Buy more credits, then try again.",
        customerKey: customerIdentity.customerKey,
        identitySource: customerIdentity.identitySource,
        job_id: paymentJob?.id || null,
        access: accessReservation,
        payment
      });
    }

    birthdayJobId = createBirthdayJobId();
    birthdayGreetingId = createShortGreetingId();
    await createStandardGreetingGeneration({
      greetingId: birthdayGreetingId,
      jobId: birthdayJobId,
      customerKey: customerIdentity.customerKey,
      recipientName: toNameRaw,
      senderName: fromNameRaw,
      personalMessage: messageRaw,
      language: requestLanguage,
      creditSource: accessReservation.source,
      creditsUsed: accessReservation.creditsUsed
    });
    birthdayGenerationRecordCreated = true;
    const progressUrl = buildBirthdayProgressUrl(req, birthdayJobId, requestLanguage);
    saveBirthdayJobStatus(birthdayJobId, {
      status: "queued",
      progress: 5,
      message: "Your Printo birthday video is queued.",
      customerKey: customerIdentity?.customerKey || "",
      customerId: String(req.body.customerId || req.headers["x-printo-customer-id"] || ""),
      recipientName: toNameRaw,
      senderName: fromNameRaw,
      language: requestLanguage,
      greetingId: birthdayGreetingId,
      createdAt: new Date().toISOString()
    });

    res.status(202).json({
      ok: true,
      queued: true,
      jobId: birthdayJobId,
      greetingId: birthdayGreetingId,
      progressUrl,
      statusUrl: `/api/greeting/birthday/jobs/${encodeURIComponent(birthdayJobId)}`,
      customerKey: customerIdentity?.customerKey || ""
    });
    birthdayResponseSent = true;

    saveBirthdayJobStatus(birthdayJobId, {
      status: "preparing",
      progress: 12,
      message: "Preparing your personalized voice and video."
    });

    const fileName = `birthday_${Date.now()}.mp4`;
    const outputPath = path.join(generatedDir, fileName);
    const voicePath = path.join(generatedDir, `birthday_voice_${Date.now()}.mp3`);
    birthdayVoicePath = voicePath;

    const voiceResult = await generatePrintoBirthdayVoice({
      recipientName: toNameRaw,
      senderName: fromNameRaw,
      message: messageRaw,
      outputPath: voicePath
    });
    const hasPrintoVoice = Boolean(voiceResult.ok && fs.existsSync(voicePath));
    if (!hasPrintoVoice) {
      await failStandardGreetingGeneration({
        greetingId: birthdayGreetingId,
        error: "Personalized voice could not be created."
      });
      accessReservation = null;
      saveBirthdayJobStatus(birthdayJobId, {
        status: "failed",
        progress: 100,
        error: "Personalized voice could not be created.",
        message: "Printo could not create the personalized voice. Your 20 credits were restored."
      });
      return;
    }

    // The finished video must be long enough for the entire ElevenLabs speech.
    // The previous fixed 10-second output cut off longer names and messages.
    let birthdayVoiceDurationSeconds = 0;
    try {
      birthdayVoiceDurationSeconds = await probeMediaDurationSeconds(voicePath);
    } catch (durationError) {
      console.warn("Birthday voice duration probe failed; using a safe text estimate:", durationError.message);
      birthdayVoiceDurationSeconds = Math.max(
        8,
        String(voiceResult.text || "").length / 12
      );
    }

    const birthdayVoiceDelaySeconds = 0.4;
    const birthdayVoiceTailSeconds = 1.0;
    const birthdayOutputDuration = Math.min(
      60,
      Math.max(
        10,
        Math.ceil((birthdayVoiceDurationSeconds + birthdayVoiceDelaySeconds + birthdayVoiceTailSeconds) * 10) / 10
      )
    );
    const birthdayVoiceDelayMs = Math.round(birthdayVoiceDelaySeconds * 1000);
    const birthdayMusicFadeOutStart = Math.max(0, birthdayOutputDuration - 0.8).toFixed(2);
    const birthdayDurationText = birthdayOutputDuration.toFixed(2);

    // Memory-safe Printo Birthday production layout.
    // First, burn all text into one still image. Then the video stage only has
    // to scale and overlay two video sources instead of running many drawtext
    // filters on every frame. All FFmpeg stages are serialized by the queue.
    const s = scaleBirthdayRenderValue;
    const renderToFontSize = Math.max(18, s(toFontSize));
    const renderFromFontSize = Math.max(18, s(fromFontSize));
    const renderMessageFontSize = Math.max(14, s(messageFontSize));
    const renderNameLineGap = s(nameLineGap);
    const renderMessageLineGap = s(messageLineGap);
    const personalizedFrameFilter =
      `scale=${BIRTHDAY_RENDER_WIDTH}:${BIRTHDAY_RENDER_HEIGHT},` +
      `drawbox=x=${s(42)}:y=${s(404)}:w=${s(180)}:h=${s(250)}:color=#f9e7c9@0.96:t=fill,` +
      `drawbox=x=${s(802)}:y=${s(404)}:w=${s(180)}:h=${s(250)}:color=#f9e7c9@0.96:t=fill,` +
      `drawtext=text=${quoteDrawtextText(toNameLines[0])}:x=${s(42)}+(${s(180)}-text_w)/2:y=${s(toNameStartY)}:fontsize=${renderToFontSize}:fontcolor=#d6333f:borderw=2:bordercolor=white@0.45,` +
      `drawtext=text=${quoteDrawtextText(toNameLines[1])}:x=${s(42)}+(${s(180)}-text_w)/2:y=${s(toNameStartY) + renderNameLineGap}:fontsize=${renderToFontSize}:fontcolor=#d6333f:borderw=2:bordercolor=white@0.45,` +
      `drawtext=text='♥':x=${s(42)}+(${s(180)}-text_w)/2:y=${s(590)}:fontsize=${Math.max(18, s(28))}:fontcolor=#d6333f:borderw=1:bordercolor=white@0.35,` +
      `drawtext=text=${quoteDrawtextText(fromNameLines[0])}:x=${s(802)}+(${s(180)}-text_w)/2:y=${s(fromNameStartY)}:fontsize=${renderFromFontSize}:fontcolor=#7b2cbf:borderw=2:bordercolor=white@0.45,` +
      `drawtext=text=${quoteDrawtextText(fromNameLines[1])}:x=${s(802)}+(${s(180)}-text_w)/2:y=${s(fromNameStartY) + renderNameLineGap}:fontsize=${renderFromFontSize}:fontcolor=#7b2cbf:borderw=2:bordercolor=white@0.45,` +
      `drawtext=text='♥':x=${s(802)}+(${s(180)}-text_w)/2:y=${s(590)}:fontsize=${Math.max(18, s(28))}:fontcolor=#7b2cbf:borderw=1:bordercolor=white@0.35,` +
      `drawtext=text=${quoteDrawtextText(messageLines[0])}:x=${s(218)}+(${s(590)}-text_w)/2:y=${s(messageStartY) + (0 * renderMessageLineGap)}:fontsize=${renderMessageFontSize}:fontcolor=#2f267f:borderw=1:bordercolor=white@0.35,` +
      `drawtext=text=${quoteDrawtextText(messageLines[1])}:x=${s(218)}+(${s(590)}-text_w)/2:y=${s(messageStartY) + (1 * renderMessageLineGap)}:fontsize=${renderMessageFontSize}:fontcolor=#2f267f:borderw=1:bordercolor=white@0.35,` +
      `drawtext=text=${quoteDrawtextText(messageLines[2])}:x=${s(218)}+(${s(590)}-text_w)/2:y=${s(messageStartY) + (2 * renderMessageLineGap)}:fontsize=${renderMessageFontSize}:fontcolor=#2f267f:borderw=1:bordercolor=white@0.35,` +
      `drawtext=text=${quoteDrawtextText(messageLines[3])}:x=${s(218)}+(${s(590)}-text_w)/2:y=${s(messageStartY) + (3 * renderMessageLineGap)}:fontsize=${renderMessageFontSize}:fontcolor=#2f267f:borderw=1:bordercolor=white@0.35,` +
      `drawtext=text=${quoteDrawtextText(messageLines[4])}:x=${s(218)}+(${s(590)}-text_w)/2:y=${s(messageStartY) + (4 * renderMessageLineGap)}:fontsize=${renderMessageFontSize}:fontcolor=#2f267f:borderw=1:bordercolor=white@0.35,` +
      `drawtext=text=${quoteDrawtextText(messageLines[5])}:x=${s(218)}+(${s(590)}-text_w)/2:y=${s(messageStartY) + (5 * renderMessageLineGap)}:fontsize=${renderMessageFontSize}:fontcolor=#2f267f:borderw=1:bordercolor=white@0.35,` +
      `drawtext=text=${quoteDrawtextText(messageLines[6])}:x=${s(218)}+(${s(590)}-text_w)/2:y=${s(messageStartY) + (6 * renderMessageLineGap)}:fontsize=${renderMessageFontSize}:fontcolor=#2f267f:borderw=1:bordercolor=white@0.35,` +
      `drawtext=text=${quoteDrawtextText(messageLines[7])}:x=${s(218)}+(${s(590)}-text_w)/2:y=${s(messageStartY) + (7 * renderMessageLineGap)}:fontsize=${renderMessageFontSize}:fontcolor=#2f267f:borderw=1:bordercolor=white@0.35,` +
      `drawtext=text=${quoteDrawtextText(messageLines[8])}:x=${s(218)}+(${s(590)}-text_w)/2:y=${s(messageStartY) + (8 * renderMessageLineGap)}:fontsize=${renderMessageFontSize}:fontcolor=#2f267f:borderw=1:bordercolor=white@0.35,` +
      `drawtext=text=${quoteDrawtextText(messageLines[9])}:x=${s(218)}+(${s(590)}-text_w)/2:y=${s(messageStartY) + (9 * renderMessageLineGap)}:fontsize=${renderMessageFontSize}:fontcolor=#2f267f:borderw=1:bordercolor=white@0.35`;

    const videoFilter =
      `[0:v]format=yuv420p[bg];` +
      `[1:v]scale=${s(462)}:${s(610)}:force_original_aspect_ratio=increase,crop=${s(462)}:${s(610)},setsar=1[vid];` +
      `[bg][vid]overlay=${s(281)}:${s(342)}:shortest=1[outv]`;

    // Mix the complete personalized Printo voice with the theme music.
    // All timing values follow the measured speech duration, so no words are
    // cut off and the music fades only after Printo finishes speaking.
    const audioFilter =
      `[2:a]aresample=48000:osf=fltp:ochl=stereo,` +
      `adelay=${birthdayVoiceDelayMs}|${birthdayVoiceDelayMs},volume=1.15,` +
      `apad=pad_dur=${birthdayDurationText},atrim=0:${birthdayDurationText}[voice];` +
      `[3:a]aresample=48000:osf=fltp:ochl=stereo,` +
      `volume=0.28,afade=t=in:st=0:d=0.35,` +
      `afade=t=out:st=${birthdayMusicFadeOutStart}:d=0.8,` +
      `apad=pad_dur=${birthdayDurationText},atrim=0:${birthdayDurationText}[music];` +
      `[music][voice]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0,` +
      `loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000:osf=fltp:ochl=stereo[aout]`;

    birthdayPersonalizedFramePath = path.join(
      generatedDir,
      `birthday_card_${birthdayJobId}_${Date.now()}.jpg`
    );

    const personalizedFrameArgs = [
      "-y",
      "-nostdin",
      "-loglevel", "error",
      "-filter_threads", "1",
      "-threads", "1",
      "-i", framePath,
      "-frames:v", "1",
      "-vf", personalizedFrameFilter,
      "-q:v", "3",
      birthdayPersonalizedFramePath
    ];

    const ffmpegArgs = [
      "-y",
      "-nostdin",
      "-loglevel", "error",
      "-filter_threads", "1",
      "-filter_complex_threads", "1",
      "-loop", "1",
      "-framerate", "24",
      "-threads", "1",
      "-i", birthdayPersonalizedFramePath,
      // Loop the 10-second master animation when the complete speech is longer.
      "-stream_loop", "-1",
      "-threads", "1",
      "-i", masterPath,
      "-threads", "1",
      "-i", voicePath,
      // Loop the short theme file until the complete personalized speech ends.
      "-stream_loop", "-1",
      "-threads", "1",
      "-i", audioPath,
      "-t", birthdayDurationText,
      "-filter_complex", `${videoFilter};${audioFilter}`,
      "-map", "[outv]",
      "-map", "[aout]",
      "-shortest",
      "-r", "24",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-threads", "1",
      "-x264-params", "threads=1:lookahead_threads=1:sync-lookahead=0",
      "-crf", "29",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-ac", "2",
      "-ar", "48000",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outputPath
    ];

    console.log("Birthday low-memory render prepared:", {
      jobId: birthdayJobId,
      renderSize: `${BIRTHDAY_RENDER_WIDTH}x${BIRTHDAY_RENDER_HEIGHT}`,
      queueDepth: birthdayRenderQueueDepth + 1,
      voiceDurationSeconds: birthdayVoiceDurationSeconds,
      outputDurationSeconds: birthdayOutputDuration,
      voiceText: voiceResult.text,
      toNameLines,
      fromNameLines,
      messageUsedLines: messageLayout.usedLines,
      musicFile: path.basename(audioPath)
    });

    await updateStandardGreetingStatus(birthdayGreetingId, "rendering");
    await runBirthdayRenderQueued(birthdayJobId, async () => {
      try {
        saveBirthdayJobStatus(birthdayJobId, {
          status: "rendering",
          progress: 34,
          message: "Preparing your personalized card background."
        });

        await execFilePromise("ffmpeg", personalizedFrameArgs, {
          timeout: 60000,
          maxBuffer: 2 * 1024 * 1024
        });

        if (!fs.existsSync(birthdayPersonalizedFramePath)) {
          throw new Error("The personalized birthday card background was not created.");
        }

        saveBirthdayJobStatus(birthdayJobId, {
          status: "rendering",
          progress: 48,
          message: "Combining Printo, your message, personalized voice and theme music."
        });

        await execFilePromise("ffmpeg", ffmpegArgs, {
          timeout: 180000,
          maxBuffer: 3 * 1024 * 1024
        });

        if (!fs.existsSync(outputPath)) {
          throw new Error("Birthday video output was not created.");
        }

        const publicBase = String(getConfiguredPublicOrigin(req)).replace(/\/$/, "");
        const greetingId = birthdayGreetingId;
        const downloadUrl = `${publicBase}/standard-media/${encodeURIComponent(greetingId)}/video`;
        const posterName = fileName.replace(/\.mp4$/i, ".jpg");
        const posterPath = path.join(generatedDir, posterName);
        const sharePosterName = fileName.replace(/\.mp4$/i, "_share.jpg");
        const sharePosterPath = path.join(generatedDir, sharePosterName);
        const fallbackPosterUrl = `${publicBase}/greeting-assets/birthday-v2.png`;

        saveBirthdayJobStatus(birthdayJobId, {
          status: "finalizing",
          progress: 88,
          message: "Finalizing your video and preview image."
        });

        try {
          await execFilePromise("ffmpeg", [
            "-y", "-nostdin", "-loglevel", "error",
            "-threads", "1",
            "-ss", "1.2", "-i", outputPath,
            "-frames:v", "1",
            "-vf", "scale=720:-2",
            "-q:v", "3", posterPath
          ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
        } catch (posterError) {
          console.error("Clean greeting poster generation failed:", posterError.message);
        }

        const posterUrl = fs.existsSync(posterPath)
          ? `${publicBase}/standard-media/${encodeURIComponent(greetingId)}/poster`
          : fallbackPosterUrl;
        const fullResultUrl = buildGreetingResultUrl(
          req,
          downloadUrl,
          toNameRaw,
          fromNameRaw,
          posterUrl,
          requestLanguage
        );
        const resultUrl = buildShortGreetingUrl(req, greetingId);

        await completeStandardGreetingGeneration({
          greetingId,
          fileName,
          outputPath,
          posterPath,
          spokenText: voiceResult.text || ""
        });

        saveGreetingMetadata(greetingId, {
          videoUrl: downloadUrl,
          posterUrl,
          sharePosterUrl: posterUrl,
          toName: toNameRaw,
          fromName: fromNameRaw,
          message: messageRaw,
          spokenText: voiceResult.text || "",
          language: requestLanguage,
          customerKey: customerIdentity?.customerKey || "",
          customerId: String(req.body.customerId || req.headers["x-printo-customer-id"] || ""),
          fileName,
          fullResultUrl,
          createdAt: new Date().toISOString()
        });

        const latestAccess = await getGreetingAccessStatus(
          customerIdentity?.customerKey || "",
          customerIdentity?.contactPhone || ""
        );

        saveBirthdayJobStatus(birthdayJobId, {
          status: "ready",
          progress: 100,
          message: "Your Printo birthday video is ready!",
          downloadUrl,
          posterUrl,
          sharePosterUrl: posterUrl,
          resultUrl,
          shareUrl: resultUrl,
          fullResultUrl,
          greetingId,
          file: fileName,
          hasPrintoVoice,
          customerKey: customerIdentity?.customerKey || "",
          access: {
            source: accessReservation?.source || "",
            paidCreditsRemaining: latestAccess.creditBalance,
            creditBalance: latestAccess.creditBalance,
            remainingCreations: latestAccess.remainingCreations,
            creditsUsed: accessReservation?.creditsUsed ?? 20
          }
        });

        // The sharing poster is optional. Make it while the FFmpeg queue is still
        // locked so it cannot overlap another customer's main video render.
        if (fs.existsSync(posterPath)) {
          try {
            await execFilePromise("ffmpeg", [
              "-y", "-nostdin", "-loglevel", "error",
              "-threads", "1",
              "-i", posterPath,
              "-frames:v", "1",
              "-vf",
              "drawtext=text='▶':x=(w-text_w)/2:y=330:fontsize=205:fontcolor=white:box=1:boxcolor=#0754b8@0.82:boxborderw=58:borderw=6:bordercolor=white@0.98",
              "-q:v", "3", sharePosterPath
            ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });

            if (fs.existsSync(sharePosterPath)) {
              await updateStandardGreetingSharePoster(greetingId, sharePosterPath);
              const sharePosterUrl = `${publicBase}/standard-media/${encodeURIComponent(greetingId)}/share-poster`;
              const metadata = loadGreetingMetadata(greetingId) || {};
              saveGreetingMetadata(greetingId, {
                ...metadata,
                posterUrl: `${publicBase}/standard-media/${encodeURIComponent(greetingId)}/poster`,
                sharePosterUrl,
                updatedAt: new Date().toISOString()
              });
              saveBirthdayJobStatus(birthdayJobId, {
                sharePosterUrl,
                updatedAt: new Date().toISOString()
              });
            }
          } catch (sharePosterError) {
            console.error("Social greeting poster generation failed:", sharePosterError.message);
          }
        }
      } finally {
        safeUnlink(birthdayPersonalizedFramePath);
        safeUnlink(voicePath);
        // Finished media is now stored in PostgreSQL. Local files are temporary.
        if (birthdayGreetingId) {
          const record = await getStandardGreetingMetadata(birthdayGreetingId).catch(() => null);
          if (record?.status === "ready") {
            safeUnlink(outputPath);
            safeUnlink(outputPath.replace(/\.mp4$/i, ".jpg"));
            safeUnlink(outputPath.replace(/\.mp4$/i, "_share.jpg"));
          }
        }
      }
    });
    return;
  } catch (err) {
    safeUnlink(birthdayPersonalizedFramePath);
    safeUnlink(birthdayVoicePath);
    if (birthdayGreetingId && birthdayGenerationRecordCreated) {
      await failStandardGreetingGeneration({
        greetingId: birthdayGreetingId,
        error: String(err.message || err)
      }).catch((refundError) => {
        console.error("Birthday access refund failed:", refundError);
      });
      accessReservation = null;
    } else if (accessReservation?.allowed && customerIdentity?.customerKey) {
      await refundGreetingGenerationAccess(
        customerIdentity.customerKey,
        accessReservation.source,
        accessReservation.creditsUsed
      ).catch((refundError) => {
        console.error("Birthday access refund failed:", refundError);
      });
    }

    console.error("Birthday generate route error:", err);
    if (birthdayResponseSent && birthdayJobId) {
      saveBirthdayJobStatus(birthdayJobId, {
        status: "failed",
        progress: 100,
        error: String(err.message || err),
        message: "The render failed. Your credits were restored."
      });
      return;
    }
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});


// =========================
// PRINTO THEME MUSIC
// =========================
function findPrintoThemeFile() {
  const configured = String(process.env.PRINTO_THEME_FILE || "").trim();
  const candidates = [
    configured,
    path.join(templatesDir, "birthday", "birthday_audio.m4a"),
    path.join(templatesDir, "birthday", "birthday_audio.mp3"),
    path.join(templatesDir, "birthday", "music.mp3"),
    path.join(templatesDir, "birthday", "theme.mp3"),
    path.join(templatesDir, "birthday", "printo-theme.mp3"),
    path.join(templatesDir, "music.mp3"),
    path.join(masterVideosDir, "music.mp3"),
    path.join(__dirname, "public", "music.mp3"),
    path.join(__dirname, "public", "printo-theme.mp3")
  ].filter(Boolean);

  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch (error) {
      return false;
    }
  }) || "";
}

function sendAudioWithRange(req, res, audioFile) {
  const stat = fs.statSync(audioFile);
  const fileSize = stat.size;
  const ext = path.extname(audioFile).toLowerCase();
  const contentType =
    ext === ".m4a" || ext === ".mp4" ? "audio/mp4" :
    ext === ".ogg" ? "audio/ogg" :
    ext === ".wav" ? "audio/wav" :
    "audio/mpeg";

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Content-Type", contentType);

  const range = req.headers.range;
  if (!range) {
    res.setHeader("Content-Length", fileSize);
    return fs.createReadStream(audioFile).pipe(res);
  }

  const parts = range.replace(/bytes=/, "").split("-");
  const start = Number(parts[0]);
  const requestedEnd = parts[1] ? Number(parts[1]) : fileSize - 1;
  const end = Math.min(requestedEnd, fileSize - 1);

  if (!Number.isFinite(start) || start < 0 || start >= fileSize || end < start) {
    res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
    return res.end();
  }

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", end - start + 1);
  return fs.createReadStream(audioFile, { start, end }).pipe(res);
}

app.get("/printo-theme", (req, res) => {
  try {
    const themeFile = findPrintoThemeFile();
    if (!themeFile) {
      return res.status(404).json({
        ok: false,
        error: "Printo theme music file was not found. Add birthday_audio.m4a or music.mp3 to templates/birthday, or set PRINTO_THEME_FILE."
      });
    }
    return sendAudioWithRange(req, res, themeFile);
  } catch (error) {
    console.error("Printo theme route error:", error);
    return res.status(500).json({ ok: false, error: "Printo theme music could not be loaded." });
  }
});

// =========================
// PUBLIC PRINTO GREETING STUDIO PAGES
// =========================
function escapeGreetingAssetText(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getGreetingPreviewPalette(templateId = "birthday") {
  const palettes = {
    birthday: ["#ff5e7d", "#ffb703", "#7b2cbf"],
    anniversary: ["#e63973", "#ff8fab", "#7b2cbf"],
    wedding: ["#fff0c7", "#d4af37", "#8b5e3c"],
    engagement: ["#8ec5fc", "#6a11cb", "#d4af37"],
    "new-baby": ["#8ed8ff", "#ffc8dd", "#6c63ff"],
    "baby-shower": ["#ffd6e7", "#9bf6ff", "#7b2cbf"],
    "child-dedication": ["#fef3c7", "#93c5fd", "#2563eb"],
    graduation: ["#0f172a", "#1d4ed8", "#facc15"],
    housewarming: ["#86efac", "#22c55e", "#0f766e"],
    "new-job-promotion": ["#93c5fd", "#1d4ed8", "#f59e0b"],
    congratulations: ["#fb7185", "#8b5cf6", "#facc15"],
    "get-well": ["#a7f3d0", "#34d399", "#0f766e"],
    "sympathy-condolence": ["#cbd5e1", "#64748b", "#1e293b"],
    retirement: ["#fdba74", "#f97316", "#7c2d12"],
    christmas: ["#dc2626", "#15803d", "#facc15"],
    "new-year": ["#111827", "#4338ca", "#facc15"],
    easter: ["#f9a8d4", "#c4b5fd", "#fef08a"],
    islamic: ["#065f46", "#0f766e", "#facc15"],
    thanksgiving: ["#f59e0b", "#b45309", "#7c2d12"],
    "mothers-day": ["#fb7185", "#ec4899", "#fbcfe8"],
    "fathers-day": ["#2563eb", "#1e3a8a", "#93c5fd"],
    "valentines-day": ["#e11d48", "#be185d", "#fecdd3"],
    "business-greeting": ["#0f172a", "#1d4ed8", "#38bdf8"],
    "grand-opening": ["#f97316", "#dc2626", "#facc15"],
    "employee-appreciation": ["#7c3aed", "#4f46e5", "#facc15"],
    "award-achievement": ["#1e3a8a", "#7c3aed", "#facc15"],
    "cultural-festival": ["#ef4444", "#f59e0b", "#8b5cf6"]
  };
  return palettes[templateId] || ["#2563eb", "#7c3aed", "#facc15"];
}

app.get("/greeting-assets/card/:templateId.svg", (req, res) => {
  const templateId = String(req.params.templateId || "birthday").toLowerCase();
  const template = GREETING_TEMPLATES.find((item) => item.id === templateId) || GREETING_TEMPLATES[0];
  const language = ["en", "es", "fr", "de", "pt", "ar", "zh"].includes(String(req.query.lang || "en"))
    ? String(req.query.lang || "en")
    : "en";
  const title = escapeGreetingAssetText(getGreetingLocalizedOccasion(template, language));
  const emoji = escapeGreetingAssetText(template.emoji || "🎁");
  const palette = getGreetingPreviewPalette(template.id);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette[0]}"/><stop offset="0.55" stop-color="${palette[1]}"/><stop offset="1" stop-color="${palette[2]}"/></linearGradient>
      <radialGradient id="glow"><stop offset="0" stop-color="#ffffff" stop-opacity=".7"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
      <filter id="shadow"><feDropShadow dx="0" dy="12" stdDeviation="12" flood-opacity=".32"/></filter>
    </defs>
    <rect width="960" height="540" rx="34" fill="url(#bg)"/>
    <circle cx="145" cy="105" r="180" fill="url(#glow)" opacity=".45"/>
    <circle cx="835" cy="465" r="220" fill="url(#glow)" opacity=".35"/>
    <rect x="38" y="38" width="884" height="464" rx="30" fill="#06194f" fill-opacity=".26" stroke="#ffffff" stroke-opacity=".78" stroke-width="3"/>
    <text x="480" y="170" text-anchor="middle" font-size="104">${emoji}</text>
    <text x="480" y="265" text-anchor="middle" font-family="Arial, sans-serif" font-size="48" font-weight="900" fill="#ffffff" filter="url(#shadow)">${title}</text>
    <text x="480" y="322" text-anchor="middle" font-family="Arial, sans-serif" font-size="25" font-weight="700" fill="#fff7cc">A beautiful Printo video greeting</text>
    <rect x="352" y="362" width="256" height="72" rx="36" fill="#ffffff" fill-opacity=".94"/>
    <text x="480" y="476" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="800" fill="#ffffff">Printo Studio • Powered by PATAPATA</text>
  </svg>`;
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.type("image/svg+xml").send(svg);
});

app.get("/greeting-assets/premium-tribute-sample.svg", (_req, res) => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
    <defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#061b62"/><stop offset=".5" stop-color="#4c1d95"/><stop offset="1" stop-color="#d63384"/></linearGradient><filter id="s"><feDropShadow dx="0" dy="14" stdDeviation="15" flood-opacity=".4"/></filter></defs>
    <rect width="960" height="540" rx="34" fill="url(#p)"/>
    <circle cx="120" cy="90" r="150" fill="#ffd21f" opacity=".18"/><circle cx="860" cy="470" r="220" fill="#38bdf8" opacity=".16"/>
    <rect x="45" y="45" width="870" height="450" rx="30" fill="#06194f" fill-opacity=".38" stroke="#ffd21f" stroke-width="4"/>
    <rect x="105" y="100" width="260" height="320" rx="28" fill="#ffffff" fill-opacity=".94" filter="url(#s)"/>
    <circle cx="235" cy="216" r="78" fill="#dbeafe"/><text x="235" y="244" text-anchor="middle" font-size="86">📸</text>
    <text x="235" y="326" text-anchor="middle" font-family="Arial" font-size="24" font-weight="900" fill="#082a8f">RECIPIENT PHOTO</text>
    <text x="235" y="365" text-anchor="middle" font-family="Arial" font-size="18" font-weight="700" fill="#475569">Your special person</text>
    <text x="620" y="143" text-anchor="middle" font-family="Arial" font-size="23" font-weight="900" fill="#ffd21f">PREMIUM EXPERIENCE</text>
    <text x="620" y="205" text-anchor="middle" font-family="Arial" font-size="39" font-weight="900" fill="#ffffff">Personal Tribute</text>
    <text x="620" y="250" text-anchor="middle" font-family="Arial" font-size="39" font-weight="900" fill="#ffffff">Music Video Card</text>
    <text x="620" y="301" text-anchor="middle" font-family="Arial" font-size="22" font-weight="700" fill="#fce7f3">Personal introduction • Photo • Original song</text>
    <rect x="490" y="340" width="260" height="72" rx="36" fill="#ffd21f" filter="url(#s)"/>
    <text x="620" y="460" text-anchor="middle" font-family="Arial" font-size="19" font-weight="800" fill="#ffffff">Printo Studio • Powered by PATAPATA</text>
  </svg>`;
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.type("image/svg+xml").send(svg);
});


function findGreetingSampleVideo(templateId = "birthday") {
  const safeId = String(templateId || "birthday").toLowerCase().replace(/[^a-z0-9-]+/g, "");
  const envKey = `GREETING_SAMPLE_${safeId.replace(/-/g, "_").toUpperCase()}_URL`;
  const envUrl = String(process.env[envKey] || "").trim();
  if (envUrl) return { type: "redirect", value: envUrl };

  const candidates = [
    path.join(templatesDir, safeId, "sample.mp4"),
    path.join(templatesDir, safeId, "master.mp4"),
    path.join(masterVideosDir, `${safeId}.mp4`),
    path.join(masterVideosDir, "birthday_master.mp4"),
    path.join(templatesDir, "birthday", "master.mp4")
  ];
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  return existing ? { type: "file", value: existing } : null;
}

app.get('/greeting-assets/sample-video/:templateId', (req, res) => {
  const sample = findGreetingSampleVideo(req.params.templateId);
  if (!sample) return res.status(404).json({ ok: false, error: 'Sample video is not uploaded yet.' });
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (sample.type === 'redirect') return res.redirect(sample.value);
  return res.sendFile(sample.value);
});

app.get('/greeting-assets/premium-sample-video', (req, res) => {
  const configured = String(process.env.PREMIUM_TRIBUTE_SAMPLE_VIDEO_URL || '').trim();
  if (configured) return res.redirect(configured);
  const sample = findGreetingSampleVideo('premium-tribute');
  if (!sample) return res.status(404).json({ ok: false, error: 'Premium sample video is not uploaded yet.' });
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (sample.type === 'redirect') return res.redirect(sample.value);
  return res.sendFile(sample.value);
});

function buildGreetingStudioHomePage(language = "en") {
  const lang = ["en", "es", "fr", "de", "pt", "ar", "zh"].includes(language) ? language : "en";
  const copy = {
    en: { title:"Printo Greeting Studio", hero:"Create personalized video greetings with Printo music, voice, names and messages.", choose:"Choose Your Greeting", watch:"Watch Sample", buy:"Buy & Download", create:"Create Your Own", help:"Worker Help", credits:"My Credits", studio:"Printo Studio", close:"Close", sampleNote:"This sample uses the available Printo master video. Each finished order is personalized with the selected occasion, names, message, music and voice.", loading:"Loading your credits...", creditError:"Credits could not be loaded. Please try again.", balance:"Credit balance", creations:"Creations available", cost:"Credits per creation" },
    es: { title:"Estudio de Saludos Printo", hero:"Crea saludos de video personalizados con música, voz, nombres y mensajes.", choose:"Elige tu saludo", watch:"Ver muestra", buy:"Comprar y descargar", create:"Crea el tuyo", help:"Ayuda del trabajador", credits:"Mis créditos", studio:"Printo Studio", close:"Cerrar", sampleNote:"Esta muestra usa el video maestro disponible de Printo. Cada pedido final se personaliza con ocasión, nombres, mensaje, música y voz.", loading:"Cargando tus créditos...", creditError:"No se pudieron cargar los créditos.", balance:"Saldo de créditos", creations:"Creaciones disponibles", cost:"Créditos por creación" },
    fr: { title:"Studio de Vœux Printo", hero:"Créez des vœux vidéo personnalisés avec musique, voix, noms et messages.", choose:"Choisissez votre vœu", watch:"Voir l’exemple", buy:"Acheter et télécharger", create:"Créer le vôtre", help:"Aide d’un agent", credits:"Mes crédits", studio:"Printo Studio", close:"Fermer", sampleNote:"Cet exemple utilise la vidéo maître Printo disponible. Chaque commande finale est personnalisée.", loading:"Chargement des crédits...", creditError:"Impossible de charger les crédits.", balance:"Solde de crédits", creations:"Créations disponibles", cost:"Crédits par création" },
    de: { title:"Printo Grußstudio", hero:"Erstellen Sie personalisierte Videogrüße mit Musik, Stimme, Namen und Nachrichten.", choose:"Gruß auswählen", watch:"Beispiel ansehen", buy:"Kaufen & herunterladen", create:"Eigenes erstellen", help:"Mitarbeiterhilfe", credits:"Meine Credits", studio:"Printo Studio", close:"Schließen", sampleNote:"Dieses Beispiel verwendet das verfügbare Printo-Mastervideo. Jede fertige Bestellung wird personalisiert.", loading:"Credits werden geladen...", creditError:"Credits konnten nicht geladen werden.", balance:"Credit-Guthaben", creations:"Verfügbare Erstellungen", cost:"Credits pro Erstellung" },
    pt: { title:"Estúdio de Saudações Printo", hero:"Crie saudações em vídeo personalizadas com música, voz, nomes e mensagens.", choose:"Escolha sua saudação", watch:"Ver amostra", buy:"Comprar e baixar", create:"Crie o seu", help:"Ajuda do trabalhador", credits:"Meus créditos", studio:"Printo Studio", close:"Fechar", sampleNote:"Esta amostra usa o vídeo mestre Printo disponível. Cada pedido final é personalizado.", loading:"Carregando créditos...", creditError:"Não foi possível carregar os créditos.", balance:"Saldo de créditos", creations:"Criações disponíveis", cost:"Créditos por criação" },
    ar: { title:"استوديو تهاني Printo", hero:"أنشئ تهاني فيديو مخصصة مع الموسيقى والصوت والأسماء والرسائل.", choose:"اختر التهنئة", watch:"مشاهدة النموذج", buy:"شراء وتنزيل", create:"أنشئ نسختك", help:"مساعدة الموظف", credits:"رصيدي", studio:"استوديو Printo", close:"إغلاق", sampleNote:"يستخدم هذا النموذج فيديو Printo الرئيسي المتاح. يتم تخصيص كل طلب نهائي.", loading:"جارٍ تحميل الرصيد...", creditError:"تعذر تحميل الرصيد.", balance:"رصيد النقاط", creations:"عدد الإنشاءات المتاحة", cost:"النقاط لكل إنشاء" },
    zh: { title:"Printo 祝福工作室", hero:"使用音乐、声音、姓名和留言制作个性化祝福视频。", choose:"选择祝福类型", watch:"观看示例", buy:"购买并下载", create:"制作专属视频", help:"工作人员帮助", credits:"我的积分", studio:"Printo Studio", close:"关闭", sampleNote:"此示例使用当前可用的 Printo 主视频。最终订单会按场合、姓名、留言、音乐和语音进行个性化。", loading:"正在加载积分...", creditError:"无法加载积分。", balance:"积分余额", creations:"可制作次数", cost:"每次制作所需积分" }
  };
  const t = copy[lang] || copy.en;
  const dir = lang === "ar" ? "rtl" : "ltr";
  const premiumOrderUrl = `/greetings/premium?lang=${encodeURIComponent(lang)}`;
  const premiumWhatsAppMessage = ["Video editing request","Service code: CARD_PERSONALIZATION_AGENT","Package: GREETING_PREMIUM",`Language: ${lang}`,"Selected card: Personal Tribute Music Video Card"].join("\n");
  const premiumWhatsAppUrl = `https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(premiumWhatsAppMessage)}`;
  const shopifyBase = GREETING_SHOPIFY_PAYMENT_URL || "https://www.patapata.us/";
  const studioUrl = `/birthday?lang=${encodeURIComponent(lang)}`;
  const cards = GREETING_TEMPLATES.map((item) => {
    const title = getGreetingLocalizedOccasion(item, lang);
    const description = getGreetingLocalizedDescription(item, lang);
    const previewUrl = `/greeting-assets/card/${encodeURIComponent(item.id)}.svg?lang=${encodeURIComponent(lang)}`;
    const videoUrl = `/greeting-assets/sample-video/${encodeURIComponent(item.id)}`;
    const personalizeUrl = `/birthday?lang=${encodeURIComponent(lang)}&template=${encodeURIComponent(item.id)}`;
    return `<article class="card"><button class="sample-open media" type="button" data-video="${videoUrl}" data-poster="${previewUrl}" data-title="${escapeGreetingAssetText(title)}"><img src="${previewUrl}" alt="${escapeGreetingAssetText(title)} sample" loading="lazy"><span class="play">▶</span></button><div class="card-body"><h3>${item.emoji} ${title}</h3><p>${description}</p><div class="actions"><button class="sample-open secondary" type="button" data-video="${videoUrl}" data-poster="${previewUrl}" data-title="${escapeGreetingAssetText(title)}">▶ ${t.watch}</button><a class="buy" href="${shopifyBase}" target="_blank" rel="noopener">🛒 ${t.buy}</a><a class="create account-required" href="${personalizeUrl}">✨ ${t.create}</a></div></div></article>`;
  }).join("");

  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#082a8f"><title>${t.title}</title><style>
  *{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:radial-gradient(circle at top,#1b56c9 0,#082a8f 40%,#031442 100%);color:#fff;min-height:100vh}.wrap{max-width:1160px;margin:auto;padding:22px}.hero{text-align:center;padding:20px 10px 12px}.hero h1{font-size:42px;margin:6px}.hero p{font-size:18px;line-height:1.55;max-width:760px;margin:12px auto}.toplinks{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin:16px 0}.toplinks button,.toplinks a{border:0;padding:12px 18px;border-radius:999px;text-decoration:none;font-weight:900;cursor:pointer;font-size:16px}.credits{background:#ffd21f;color:#082a8f}.home{background:#fff;color:#082a8f}.premium{position:relative;overflow:hidden;background:linear-gradient(110deg,#fff1a8,#fff,#e8f1ff);color:#071b61;border:3px solid #ffd21f;border-radius:28px;padding:24px;margin:22px 0 28px;box-shadow:0 18px 48px rgba(0,0,0,.3)}.premium-badge{display:inline-block;background:#123faa;color:#ffd21f;font-weight:900;padding:9px 16px;border-radius:999px}.premium-grid{display:grid;grid-template-columns:38% 1fr;gap:25px;align-items:center;margin-top:16px}.premium-media{position:relative;border-radius:24px;overflow:hidden;min-height:270px;background:#092b92;border:2px solid #3158b6;cursor:pointer;padding:0}.premium-media img{display:block;width:100%;height:100%;min-height:270px;object-fit:cover}.premium-media .play,.media .play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:72px;height:72px;border-radius:50%;display:grid;place-items:center;background:#ffd21f;color:#082a8f;font-size:32px;box-shadow:0 10px 25px rgba(0,0,0,.3)}.premium h2{font-size:32px;margin:0 0 10px}.premium p{line-height:1.55}.premium ul{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;padding:0;list-style:none;font-weight:800}.premium-actions,.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.premium-actions a,.premium-actions button,.actions a,.actions button{border:0;border-radius:999px;padding:12px 16px;text-decoration:none;font-weight:900;cursor:pointer;font-size:14px}.watch,.secondary{background:#123faa;color:#fff}.buy{background:#0f9d58;color:#fff}.create{background:linear-gradient(90deg,#7b2cbf,#d63384);color:#fff}.worker{background:#25D366;color:#072b17}.choose{text-align:center;font-size:34px;margin:20px 0}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.card{background:#fff;color:#0a286d;border-radius:24px;overflow:hidden;box-shadow:0 14px 30px rgba(0,0,0,.25);display:flex;flex-direction:column}.media{position:relative;border:0;padding:0;width:100%;aspect-ratio:16/9;background:#dbeafe;cursor:pointer;overflow:hidden}.media img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .25s}.media:hover img{transform:scale(1.025)}.media .play{width:58px;height:58px;font-size:25px}.card-body{padding:18px;display:flex;flex-direction:column;flex:1}.card h3{font-size:23px;margin:0 0 8px}.card p{color:#475569;line-height:1.45;min-height:61px;margin:0}.actions{margin-top:auto}.actions a,.actions button{flex:1;text-align:center;min-width:125px}.modal{display:none;position:fixed;z-index:9999;inset:0;background:rgba(0,0,0,.84);padding:20px;align-items:center;justify-content:center}.modal.open{display:flex}.modal-box{width:min(920px,100%);background:#fff;color:#082a8f;border-radius:25px;padding:18px;box-shadow:0 25px 80px rgba(0,0,0,.55)}.modal-head{display:flex;justify-content:space-between;align-items:center;gap:10px}.modal-head h2{margin:5px}.modal-close{border:0;background:#e2e8f0;color:#0f172a;padding:10px 15px;border-radius:999px;font-weight:900;cursor:pointer}.modal-video{width:100%;border-radius:18px;margin-top:12px;display:block;max-height:68vh;background:#061b62}.modal-note{text-align:center;color:#475569;font-weight:700;line-height:1.45}.credit-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:15px}.credit-stat{background:#eff6ff;border:2px solid #bfdbfe;border-radius:16px;padding:17px;text-align:center}.credit-stat strong{display:block;font-size:30px;color:#7b2cbf}.credit-stat span{display:block;margin-top:5px;font-weight:800;color:#475569}.credit-status{text-align:center;padding:18px;font-weight:900;color:#475569}.legal{margin:38px 0 10px;background:#fff;color:#172554;border:3px solid #ffd21f;border-radius:26px;padding:26px;box-shadow:0 18px 48px rgba(0,0,0,.3)}.legal h2{text-align:center;color:#082a8f;font-size:30px;margin:0 0 8px}.legal-intro{text-align:center;color:#475569;max-width:850px;margin:0 auto 22px;line-height:1.6}.legal-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.legal-card{background:#f8fafc;border:2px solid #dbeafe;border-radius:18px;padding:18px}.legal-card h3{color:#123faa;margin:0 0 9px;font-size:20px}.legal-card p,.legal-card li{color:#334155;line-height:1.6}.legal-card ul{padding-left:21px;margin:8px 0}.legal-alert{background:#fff7d6;border-color:#ffd21f}.legal-danger{background:#fff1f2;border-color:#fb7185}.legal-contact{text-align:center;background:#eff6ff;border:2px solid #93c5fd;border-radius:18px;padding:18px;margin-top:16px;color:#172554;line-height:1.65}.legal-contact a{color:#123faa;font-weight:900}.footer{text-align:center;padding:32px 10px;color:#dbeafe;font-weight:700}@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}.premium-grid{grid-template-columns:1fr}.premium-media img,.premium-media{min-height:230px}}@media(max-width:570px){.wrap{padding:12px}.hero h1{font-size:32px}.choose{font-size:28px}.grid{grid-template-columns:1fr}.premium{padding:16px}.premium h2{font-size:27px}.premium ul{grid-template-columns:1fr}.actions a,.actions button{min-width:100%}.modal{padding:8px}.modal-box{padding:12px}.credit-grid{grid-template-columns:1fr}.legal{padding:18px}.legal-grid{grid-template-columns:1fr}.legal h2{font-size:25px}}
  </style></head><body><main class="wrap"><section class="hero"><h1>🎁 ${t.title}</h1><p>${t.hero}</p><div class="toplinks"><button id="creditsButton" class="credits" type="button">⭐ ${t.credits}</button><a class="home" href="${studioUrl}" target="_blank" rel="noopener">🏠 ${t.studio}</a></div></section>
  <section class="premium"><span class="premium-badge">🌟 PREMIUM EXPERIENCE</span><div class="premium-grid"><button class="premium-media sample-open" type="button" data-video="/greeting-assets/premium-sample-video" data-poster="/greeting-assets/premium-tribute-sample.svg" data-title="Personal Tribute Music Video Card"><img src="/greeting-assets/premium-tribute-sample.svg" alt="Premium tribute sample"><span class="play">▶</span></button><div><h2>Personal Tribute Music Video Card</h2><p>Create a powerful personal tribute using the recipient photo, your personal introduction video, an original tribute song, names and a heartfelt message.</p><ul><li>✓ Recipient photo on screen</li><li>✓ Personal introduction video</li><li>✓ Original tribute song</li><li>✓ Recipient and sender names</li><li>✓ Personal message</li><li>✓ Downloadable finished video</li></ul><div class="premium-actions"><button class="watch sample-open" type="button" data-video="/greeting-assets/premium-sample-video" data-poster="/greeting-assets/premium-tribute-sample.svg" data-title="Personal Tribute Music Video Card">▶ ${t.watch}</button><a class="buy" href="${shopifyBase}" target="_blank" rel="noopener">🛒 ${t.buy}</a><a class="create account-required" href="${premiumOrderUrl}">✨ ${t.create}</a><a class="worker" href="${premiumWhatsAppUrl}" target="_blank" rel="noopener">💬 ${t.help}</a></div></div></div></section>
  <h2 class="choose">${t.choose}</h2><section class="grid">${cards}</section>
  <section id="terms" class="legal">
    <h2>📜 Printto Studio Terms of Use, Privacy &amp; Refund Policy</h2>
    <p class="legal-intro"><strong>Last updated: July 2026.</strong> By accessing Printto Greeting Studio, uploading content, purchasing credits or memberships, or requesting a generated video, you agree to the policies below.</p>
    <div class="legal-grid">
      <article class="legal-card legal-alert"><h3>1. Your Content and Permission</h3><p>You confirm that you own, created, licensed, or received clear permission to use every photograph, video, voice recording, name, message, logo, song, document, or other material you upload.</p><p><strong>Do not upload or generate content using another person’s image, video, voice, likeness, or private information without that person’s authorization.</strong></p></article>
      <article class="legal-card legal-danger"><h3>2. User Responsibility</h3><p>You are solely responsible for your uploads and the instructions you provide. PATAPATA LLC does not authorize impersonation, harassment, defamation, copyright infringement, privacy violations, misleading endorsements, or unlawful use of another person’s identity.</p><p>PATAPATA LLC may reject, suspend, remove, or report content or accounts that appear illegal, abusive, deceptive, unsafe, or unauthorized.</p></article>
      <article class="legal-card"><h3>3. Prohibited Content</h3><ul><li>Content involving exploitation, threats, hate, harassment, violence, or illegal activity.</li><li>Sexually explicit content or content that exploits or endangers minors.</li><li>Unauthorized copyrighted material, trademarks, private records, or confidential information.</li><li>False impersonation, fraud, scams, or content intended to deceive the public.</li></ul></article>
      <article class="legal-card"><h3>4. Privacy and Uploaded Files</h3><p>Names, contact details, photos, videos, messages, and other uploaded files may be processed and temporarily stored to create the requested service, operate customer accounts, prevent abuse, complete payments, troubleshoot failures, and provide support.</p><p>PATAPATA LLC does not sell customer personal information. Customers should avoid uploading unnecessary sensitive information.</p></article>
      <article class="legal-card"><h3>5. AI and Creative Output</h3><p>AI-generated or automatically assembled results may contain variations. You must review names, spelling, messages, photos, video selections, and instructions before submitting. Minor creative differences that do not prevent delivery are not generation failures.</p></article>
      <article class="legal-card"><h3>6. Credits and Memberships</h3><p>Credits are deducted when a generation or eligible service begins. Membership credits are released according to the selected plan. Prices, credit costs, available features, and processing times may be updated for future purchases.</p></article>
      <article class="legal-card legal-danger"><h3>7. Final Sale and No-Return Policy</h3><p><strong>Because each video is custom-generated using customer-provided information and computing resources, a successfully generated video is final and non-returnable. No refund is provided after successful generation merely because the customer changes their mind, dislikes a creative preference, or supplied incorrect information.</strong></p></article>
      <article class="legal-card legal-alert"><h3>8. Technical Generation Problems</h3><p>If a verified technical problem caused the generation not to work, produced no usable video, or prevented delivery, contact a Printto Support Agent promptly. After reviewing the issue, PATAPATA LLC may fix and regenerate the video, restore the affected credits, or provide another appropriate resolution.</p><p>A refund, when legally required or approved by PATAPATA LLC, is considered only after support has had a reasonable opportunity to investigate and correct the technical problem.</p></article>
      <article class="legal-card"><h3>9. Limitation of Responsibility</h3><p>To the extent permitted by law, PATAPATA LLC is not responsible for claims, losses, or disputes caused by unauthorized uploads, customer mistakes, infringement by a user, third-party platforms, internet interruptions, or circumstances outside our reasonable control.</p></article>
      <article class="legal-card"><h3>10. Policy Enforcement and Updates</h3><p>We may refuse service or restrict access when necessary to protect people, intellectual property, privacy, platform security, or legal compliance. Updated terms apply to future use after they are posted on this page.</p></article>
    </div>
    <div class="legal-contact"><strong>PATAPATA LLC</strong><br>81 W. Allen Street<br>Irvington, NJ 07111, United States<br><br>For a failed generation or another service problem, use the <strong>Worker Help</strong> or Support Agent option in Printto Studio before requesting a refund.</div>
  </section>
  <div class="footer">© 2026 PATAPATA LLC • Printto Greeting Studio™<br>81 W. Allen Street, Irvington, NJ 07111 • All Rights Reserved.</div></main>
  <div id="sampleModal" class="modal" role="dialog" aria-modal="true" aria-hidden="true"><div class="modal-box"><div class="modal-head"><h2 id="sampleTitle"></h2><button class="modal-close close-modal" type="button">✕ ${t.close}</button></div><video id="sampleVideo" class="modal-video" controls playsinline preload="metadata"></video><p class="modal-note">${t.sampleNote}</p></div></div>
  <div id="creditModal" class="modal" role="dialog" aria-modal="true" aria-hidden="true"><div class="modal-box"><div class="modal-head"><h2>⭐ ${t.credits}</h2><button class="modal-close close-credit" type="button">✕ ${t.close}</button></div><div id="creditStatus" class="credit-status">${t.loading}</div><div id="creditGrid" class="credit-grid" hidden><div class="credit-stat"><strong id="creditBalance">0</strong><span>${t.balance}</span></div><div class="credit-stat"><strong id="creditCreations">0</strong><span>${t.creations}</span></div><div class="credit-stat"><strong id="creditCost">20</strong><span>${t.cost}</span></div></div><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px"><a href="/customer-dashboard" style="flex:1;text-align:center;padding:12px;border-radius:12px;background:#123faa;color:white;text-decoration:none;font-weight:900">🎬 My Videos</a><a href="/subscriptions" style="flex:1;text-align:center;padding:12px;border-radius:12px;background:#7b2cbf;color:white;text-decoration:none;font-weight:900">➕ Buy Credits / Subscribe</a></div></div></div>
  <script>
  const sampleModal=document.getElementById('sampleModal'),video=document.getElementById('sampleVideo'),sampleTitle=document.getElementById('sampleTitle');
  function openModal(el){el.classList.add('open');el.setAttribute('aria-hidden','false');document.body.style.overflow='hidden'}
  function closeModal(el){el.classList.remove('open');el.setAttribute('aria-hidden','true');document.body.style.overflow=''}
  document.querySelectorAll('.sample-open').forEach(btn=>btn.addEventListener('click',()=>{sampleTitle.textContent=btn.dataset.title||'Printo Sample';video.poster=btn.dataset.poster||'';video.src=btn.dataset.video||'';openModal(sampleModal);video.play().catch(()=>{});}));
  document.querySelectorAll('.close-modal').forEach(btn=>btn.addEventListener('click',()=>{video.pause();video.removeAttribute('src');video.load();closeModal(sampleModal)}));sampleModal.addEventListener('click',e=>{if(e.target===sampleModal){video.pause();closeModal(sampleModal)}});
  const creditModal=document.getElementById('creditModal'),creditButton=document.getElementById('creditsButton'),creditStatus=document.getElementById('creditStatus'),creditGrid=document.getElementById('creditGrid');
  function getCustomerKey(){return localStorage.getItem('printoGreetingCustomerKey')||''}
  function clearStoredPrintoLogin(){
    localStorage.removeItem('printoGreetingCustomerKey');
    localStorage.removeItem('printoGreetingCustomerId');
    localStorage.removeItem('printoGreetingCustomerEmail');
    localStorage.removeItem('printoGreetingCustomerPhone');
  }
  function openPrintoLogin(nextUrl){
    window.location.href='/customer-login?next='+encodeURIComponent(nextUrl||location.pathname+location.search);
  }
  async function openProtectedGreeting(event){
    event.preventDefault();
    const target=event.currentTarget.getAttribute('href')||'/greetings';
    const key=getCustomerKey();
    if(!key){openPrintoLogin(target);return;}
    try{
      const response=await fetch('/api/customer/account/status',{
        cache:'no-store',
        credentials:'same-origin',
        headers:{'x-printo-customer-key':key}
      });
      const data=await response.json();
      if(!response.ok||!data.ok)throw new Error(data.error||'Please log in.');
      if(data.customerKey)localStorage.setItem('printoGreetingCustomerKey',String(data.customerKey));
      if(data.phone){
        localStorage.setItem('printoGreetingCustomerId',String(data.phone));
        localStorage.setItem('printoGreetingCustomerPhone',String(data.phone));
      }else if(data.email){
        localStorage.setItem('printoGreetingCustomerId',String(data.email));
        localStorage.setItem('printoGreetingCustomerEmail',String(data.email));
      }
      window.location.href=target;
    }catch(_error){
      clearStoredPrintoLogin();
      openPrintoLogin(target);
    }
  }
  document.querySelectorAll('.account-required').forEach(link=>link.addEventListener('click',openProtectedGreeting));
  async function loadCredits(){const key=getCustomerKey();if(!key){window.location.href='/customer-login?next='+encodeURIComponent(location.pathname+location.search);return}creditStatus.hidden=false;creditGrid.hidden=true;creditStatus.textContent=${JSON.stringify(t.loading)};try{const response=await fetch('/api/customer/account/status',{cache:'no-store',headers:{'x-printo-customer-key':key}});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Credit request failed');document.getElementById('creditBalance').textContent=String(data.creditBalance??data.credits??0);document.getElementById('creditCreations').textContent=String(data.remainingCreations??0);document.getElementById('creditCost').textContent=String(data.creationCost??20);creditStatus.hidden=true;creditGrid.hidden=false}catch(error){localStorage.removeItem('printoGreetingCustomerKey');window.location.href='/customer-login?next='+encodeURIComponent(location.pathname+location.search)}}
  creditButton.addEventListener('click',()=>{if(!getCustomerKey()){window.location.href='/customer-login?next='+encodeURIComponent(location.pathname+location.search);return}openModal(creditModal);loadCredits()});document.querySelectorAll('.close-credit').forEach(btn=>btn.addEventListener('click',()=>closeModal(creditModal)));creditModal.addEventListener('click',e=>{if(e.target===creditModal)closeModal(creditModal)});document.addEventListener('keydown',e=>{if(e.key==='Escape'){video.pause();closeModal(sampleModal);closeModal(creditModal)}});
  </script></body></html>`;
}

function buildBirthdayGeneratorPage(language = "en", templateId = "birthday") {
  const lang = ["en", "es", "fr", "de", "pt", "ar", "zh"].includes(language) ? language : "en";
  const copy = {
    en: { title:"Printo Birthday Generator", back:"All Greeting Cards", intro:"Enter the recipient, sender and personal message. Printo will create the finished video with music and personalized voice.", recipient:"Recipient Name", sender:"Sender Name", recipientExample:"Example: Michael", senderExample:"Example: Ana", personal:"Personal Message", messagePlaceholder:"Write a short birthday message...", generate:"Generate Birthday Video", generating:"Generating...", waiting:"Printo is creating your birthday video. Please wait.", failed:"Generation failed.", voiceReady:"Video and Printo voice are ready!", musicReady:"Video is ready. Music was used because voice was unavailable.", shopify:"Buy via Shopify", nigeria:"Nigeria Payment", note:"Your generated page will include a large Play button, Download, WhatsApp, Facebook, X/Twitter, Instagram, TikTok, YouTube, Email and Copy Link options." },
    es: { title:"Generador de cumpleaños Printo", back:"Todas las tarjetas de saludo", intro:"Ingresa el nombre del destinatario, el remitente y un mensaje personal. Printo creará el video final con música y voz personalizada.", recipient:"Nombre del destinatario", sender:"Nombre del remitente", recipientExample:"Ejemplo: Miguel", senderExample:"Ejemplo: Ana", personal:"Mensaje personal", messagePlaceholder:"Escribe un mensaje corto de cumpleaños...", generate:"Generar video de cumpleaños", generating:"Generando...", waiting:"Printo está creando tu video de cumpleaños. Espera, por favor.", failed:"No se pudo generar el video.", voiceReady:"¡El video y la voz de Printo están listos!", musicReady:"El video está listo. Se usó música porque la voz no estaba disponible.", shopify:"Comprar por Shopify", nigeria:"Pago en Nigeria", note:"La página generada incluirá un botón grande de reproducción, descarga, WhatsApp, Facebook, Instagram, TikTok, YouTube, correo electrónico y copiar enlace." },
    fr: { title:"Générateur d’anniversaire Printo", back:"Toutes les cartes de vœux", intro:"Saisissez le nom du destinataire, de l’expéditeur et un message personnel. Printo créera la vidéo finale avec musique et voix personnalisée.", recipient:"Nom du destinataire", sender:"Nom de l’expéditeur", recipientExample:"Exemple : Michel", senderExample:"Exemple : Ana", personal:"Message personnel", messagePlaceholder:"Écrivez un court message d’anniversaire...", generate:"Créer la vidéo d’anniversaire", generating:"Création...", waiting:"Printo crée votre vidéo d’anniversaire. Veuillez patienter.", failed:"La création a échoué.", voiceReady:"La vidéo et la voix de Printo sont prêtes !", musicReady:"La vidéo est prête. La musique a été utilisée car la voix n’était pas disponible.", shopify:"Acheter via Shopify", nigeria:"Paiement Nigeria", note:"La page générée comprendra un grand bouton Lecture, Télécharger, WhatsApp, Facebook, Instagram, TikTok, YouTube, E-mail et Copier le lien." },
    de: { title:"Printo Geburtstagsgenerator", back:"Alle Grußkarten", intro:"Geben Sie den Namen des Empfängers, des Absenders und eine persönliche Nachricht ein. Printo erstellt das fertige Video mit Musik und personalisierter Stimme.", recipient:"Name des Empfängers", sender:"Name des Absenders", recipientExample:"Beispiel: Michael", senderExample:"Beispiel: Ana", personal:"Persönliche Nachricht", messagePlaceholder:"Schreiben Sie eine kurze Geburtstagsnachricht...", generate:"Geburtstagsvideo erstellen", generating:"Wird erstellt...", waiting:"Printo erstellt Ihr Geburtstagsvideo. Bitte warten.", failed:"Erstellung fehlgeschlagen.", voiceReady:"Video und Printo-Stimme sind fertig!", musicReady:"Das Video ist fertig. Musik wurde verwendet, da die Stimme nicht verfügbar war.", shopify:"Über Shopify kaufen", nigeria:"Nigeria-Zahlung", note:"Die erstellte Seite enthält eine große Wiedergabetaste sowie Download-, WhatsApp-, Facebook-, Instagram-, TikTok-, YouTube-, E-Mail- und Link-kopieren-Optionen." },
    pt: { title:"Gerador de aniversário Printo", back:"Todos os cartões de saudação", intro:"Digite o nome do destinatário, do remetente e uma mensagem pessoal. Printo criará o vídeo final com música e voz personalizada.", recipient:"Nome do destinatário", sender:"Nome do remetente", recipientExample:"Exemplo: Miguel", senderExample:"Exemplo: Ana", personal:"Mensagem pessoal", messagePlaceholder:"Escreva uma mensagem curta de aniversário...", generate:"Gerar vídeo de aniversário", generating:"Gerando...", waiting:"Printo está criando seu vídeo de aniversário. Aguarde.", failed:"Falha ao gerar o vídeo.", voiceReady:"O vídeo e a voz do Printo estão prontos!", musicReady:"O vídeo está pronto. A música foi usada porque a voz não estava disponível.", shopify:"Comprar pela Shopify", nigeria:"Pagamento na Nigéria", note:"A página gerada incluirá um grande botão Reproduzir, Download, WhatsApp, Facebook, Instagram, TikTok, YouTube, E-mail e Copiar link." },
    ar: { title:"منشئ فيديو عيد الميلاد من Printo", back:"جميع بطاقات التهنئة", intro:"أدخل اسم المستلم والمرسل والرسالة الشخصية. سيُنشئ Printo الفيديو النهائي مع الموسيقى والصوت المخصص.", recipient:"اسم المستلم", sender:"اسم المرسل", recipientExample:"مثال: محمد", senderExample:"مثال: آنا", personal:"الرسالة الشخصية", messagePlaceholder:"اكتب رسالة عيد ميلاد قصيرة...", generate:"إنشاء فيديو عيد الميلاد", generating:"جارٍ الإنشاء...", waiting:"يقوم Printo بإنشاء فيديو عيد الميلاد. يرجى الانتظار.", failed:"فشل إنشاء الفيديو.", voiceReady:"الفيديو وصوت Printo جاهزان!", musicReady:"الفيديو جاهز. تم استخدام الموسيقى لأن الصوت لم يكن متاحًا.", shopify:"الشراء عبر Shopify", nigeria:"الدفع في نيجيريا", note:"ستتضمن الصفحة الناتجة زر تشغيل كبيرًا وخيارات التنزيل وWhatsApp وFacebook وInstagram وTikTok وYouTube والبريد الإلكتروني ونسخ الرابط." },
    zh: { title:"Printo 生日视频生成器", back:"所有祝福卡片", intro:"输入收件人、发件人和个人留言。Printo 将制作带有音乐和个性化语音的完整视频。", recipient:"收件人姓名", sender:"发件人姓名", recipientExample:"例如：迈克尔", senderExample:"例如：安娜", personal:"个人留言", messagePlaceholder:"写一段简短的生日祝福……", generate:"生成生日视频", generating:"正在生成……", waiting:"Printo 正在制作您的生日视频，请稍候。", failed:"生成失败。", voiceReady:"视频和 Printo 语音已准备好！", musicReady:"视频已准备好。由于语音不可用，已使用音乐。", shopify:"通过 Shopify 购买", nigeria:"尼日利亚付款", note:"生成的页面将包含大号播放按钮、下载、WhatsApp、Facebook、Instagram、TikTok、YouTube、电子邮件和复制链接选项。" }
  };
  const baseT = copy[lang] || copy.en;
  const selectedTemplate = getGreetingTemplate(templateId) || getGreetingTemplate("birthday");
  const selectedOccasion = getGreetingLocalizedOccasion(selectedTemplate, lang);
  const isBirthdayTemplate = selectedTemplate.id === "birthday";
  const t = { ...baseT };
  if (!isBirthdayTemplate) {
    t.title = `Printo ${selectedOccasion} Video Card`;
    t.intro = `Enter the recipient name, sender name and personal message for your ${selectedOccasion} video card. A Printo worker will prepare this selected occasion for you.`;
    t.messagePlaceholder = `Write your personal ${selectedOccasion} message...`;
    t.generate = `Submit ${selectedOccasion} Request`;
    t.generating = "Submitting...";
    t.waiting = "Sending your personalization request to the Printo worker...";
  }
  const dir = lang === "ar" ? "rtl" : "ltr";
  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${t.title}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:linear-gradient(180deg,#071b61,#0b63ce);color:#fff;min-height:100vh;padding:20px}.wrap{max-width:760px;margin:auto}.top{text-align:center;margin-bottom:18px}.top h1{font-size:34px;margin:7px 0}.top p{opacity:.92;line-height:23px}.panel{background:#fff;color:#172554;border-radius:22px;padding:22px;box-shadow:0 14px 38px rgba(0,0,0,.32)}label{display:block;font-weight:900;margin:13px 0 7px}.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field{position:relative}input,textarea{width:100%;border:2px solid #cbd5e1;border-radius:13px;padding:13px 15px;font-size:17px;outline:none;text-align:start}input:focus,textarea:focus{border-color:#7b2cbf;box-shadow:0 0 0 3px rgba(123,44,191,.14)}textarea{min-height:120px;resize:vertical}.counter{text-align:end;font-size:13px;font-weight:800;color:#64748b;margin-top:5px}.counter.warn{color:#dc2626}.generate{width:100%;border:0;border-radius:15px;padding:16px;background:linear-gradient(90deg,#7b2cbf,#d63384);color:#fff;font-size:19px;font-weight:900;cursor:pointer;margin-top:18px}.generate:disabled{opacity:.55;cursor:not-allowed}.status{text-align:center;min-height:28px;margin-top:13px;font-weight:800;color:#7b2cbf}.payments{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:15px}.pay{display:block;text-align:center;text-decoration:none;color:#fff;font-weight:900;padding:13px;border-radius:13px}.shopify{background:#4f772d}.nigeria{background:#008751}.back{display:inline-block;color:#ffd21f;text-decoration:none;font-weight:900;margin-bottom:10px}.note{font-size:13px;line-height:19px;color:#475569;background:#f1f5f9;padding:12px;border-radius:12px;margin-top:14px}.agreement{display:flex;align-items:flex-start;gap:10px;background:#fff7d6;border:2px solid #ffd21f;border-radius:13px;padding:13px;margin-top:16px}.agreement input{width:20px;height:20px;flex:0 0 auto;margin:2px 0 0}.agreement label{margin:0;font-weight:800;line-height:1.45}.agreement a{color:#123faa;font-weight:900}@media(max-width:580px){body{padding:12px}.row,.payments{grid-template-columns:1fr}.top h1{font-size:29px}}
  </style>
</head>
<body>
<div class="wrap">
  <a class="back" href="/greetings?lang=${lang}">← ${t.back}</a>
  <div class="top"><h1>${selectedTemplate.emoji || "🎁"} ${t.title}</h1><p>${t.intro}</p></div>
  <div class="panel">
    <form id="birthdayForm" method="POST" action="/birthday-submit">
      <div class="row">
        <div class="field"><label for="toName">${t.recipient}</label><input id="toName" name="to" maxlength="${BIRTHDAY_NAME_MAX}" required placeholder="${t.recipientExample}" /><div id="toCount" class="counter">0 / ${BIRTHDAY_NAME_MAX}</div></div>
        <div class="field"><label for="fromName">${t.sender}</label><input id="fromName" name="from" maxlength="${BIRTHDAY_NAME_MAX}" required placeholder="${t.senderExample}" /><div id="fromCount" class="counter">0 / ${BIRTHDAY_NAME_MAX}</div></div>
      </div>
      <label for="message">${t.personal}</label>
      <textarea id="message" name="message" maxlength="${BIRTHDAY_MESSAGE_MAX}" required placeholder="${t.messagePlaceholder}"></textarea>
      <div id="messageCount" class="counter">0 / ${BIRTHDAY_MESSAGE_MAX}</div>
      <input type="hidden" id="formLanguage" name="language" value="${lang}" />
      <input type="hidden" id="formCustomerId" name="customerId" value="" />
      <input type="hidden" id="formCustomerKey" name="customerKey" value="" />
      <input type="hidden" id="formTermsAccepted" name="termsAccepted" value="yes" />
      <div class="agreement"><input id="termsAccepted" name="termsAccepted" type="checkbox" value="yes" required><label for="termsAccepted">I confirm that I have permission to use all names, photos, videos, voices and other content submitted, and I agree to the <a href="/greetings?lang=${lang}#terms" target="_blank" rel="noopener">Terms of Use, Privacy Policy and Refund Policy</a>.</label></div>
      <button id="generateBtn" class="generate" type="submit">✨ ${t.generate}</button>
      <div id="status" class="status"></div>
    </form>
    <div class="payments">
      <a id="shopifyPayment" class="pay shopify" href="${GREETING_SHOPIFY_PAYMENT_URL}" target="_blank" rel="noopener">🛒 ${t.shopify}</a>
      <a id="africaPayment" class="pay nigeria" href="https://www.patapata.us/pages/africa-payment" target="_blank" rel="noopener">🇳🇬 ${t.nigeria}</a>
    </div>
    <div class="note">${t.note}</div>
  </div>
</div>
<script>
  const ui=${JSON.stringify(t)};
  const currentLanguage=${JSON.stringify(lang)};
  const selectedTemplateId=${JSON.stringify(selectedTemplate.id)};
  const selectedOccasion=${JSON.stringify(selectedOccasion)};
  const isBirthdayTemplate=${JSON.stringify(isBirthdayTemplate)};
  const supportPhone=${JSON.stringify(SUPPORT_PHONE)};
  const limits={name:${BIRTHDAY_NAME_MAX},message:${BIRTHDAY_MESSAGE_MAX}};
  const recipientInput=document.getElementById('toName');
  const senderInput=document.getElementById('fromName');
  const messageInput=document.getElementById('message');
  const toCount=document.getElementById('toCount'),fromCount=document.getElementById('fromCount'),messageCount=document.getElementById('messageCount');
  const statusBox=document.getElementById('status'),button=document.getElementById('generateBtn'),termsAccepted=document.getElementById('termsAccepted');
  const shopifyPayment=document.getElementById('shopifyPayment');
  const africaPayment=document.getElementById('africaPayment');
  let customerId=localStorage.getItem('printoGreetingCustomerId')||'';
  let customerKey=localStorage.getItem('printoGreetingCustomerKey')||'';
  async function restorePrintoLogin(){
    if(customerKey)return true;
    try{
      const response=await fetch('/api/customer/account/status',{cache:'no-store',credentials:'same-origin'});
      const data=await response.json();
      if(response.ok&&data.ok&&data.customerKey){
        customerKey=String(data.customerKey);
        customerId=String(data.phone||data.customerId||data.email||customerId||'');
        localStorage.setItem('printoGreetingCustomerKey',customerKey);
        localStorage.setItem('printoGreetingCustomerId',customerId);
        if(data.phone)localStorage.setItem('printoGreetingCustomerPhone',String(data.phone));
        if(data.email)localStorage.setItem('printoGreetingCustomerEmail',String(data.email));
        document.getElementById('formCustomerId').value=customerId;
        document.getElementById('formCustomerKey').value=customerKey;
        return true;
      }
    }catch(_){}
    window.location.replace('/customer-login?next='+encodeURIComponent(location.pathname+location.search));
    return false;
  }
  document.getElementById('formCustomerId').value=customerId;
  document.getElementById('formCustomerKey').value=customerKey;
  restorePrintoLogin();
  function updateCounter(input,output,max){const n=input.value.length;output.textContent=n+' / '+max;output.classList.toggle('warn',n>=max)}
  function syncGenerateButton(){
    updateCounter(recipientInput,toCount,limits.name);
    updateCounter(senderInput,fromCount,limits.name);
    updateCounter(messageInput,messageCount,limits.message);
    const hasRequiredText=
      recipientInput.value.trim().length>0 &&
      senderInput.value.trim().length>0 &&
      messageInput.value.trim().length>0;
    button.disabled=false;
  }
  recipientInput.addEventListener('input',syncGenerateButton);
  recipientInput.addEventListener('change',syncGenerateButton);
  senderInput.addEventListener('input',syncGenerateButton);
  senderInput.addEventListener('change',syncGenerateButton);
  messageInput.addEventListener('input',syncGenerateButton);
  messageInput.addEventListener('change',syncGenerateButton);
  termsAccepted.addEventListener('change',syncGenerateButton);
  window.addEventListener('pageshow',syncGenerateButton);
  document.addEventListener('DOMContentLoaded',syncGenerateButton);
  setTimeout(syncGenerateButton,0);
  setTimeout(syncGenerateButton,250);
  setTimeout(syncGenerateButton,1000);
  window.addEventListener('error',function(event){
    console.error('[Birthday Page Error]',event.error||event.message);
    statusBox.textContent='❌ Page error: '+String(event.message||'Unknown JavaScript error');
  });
  window.addEventListener('unhandledrejection',function(event){
    console.error('[Birthday Promise Error]',event.reason);
    statusBox.textContent='❌ '+String(event.reason?.message||event.reason||'Request failed');
  });
  const birthdayForm=document.getElementById('birthdayForm');
  if(!birthdayForm){
    throw new Error('Birthday form could not be found.');
  }
  birthdayForm.addEventListener('submit',async function(e){
    e.preventDefault();
    customerId=localStorage.getItem('printoGreetingCustomerId')||customerId||'';
    customerKey=localStorage.getItem('printoGreetingCustomerKey')||customerKey||'';
    document.getElementById('formCustomerId').value=customerId;
    document.getElementById('formCustomerKey').value=customerKey;
    console.log('[Birthday Generate] Submit clicked');
    const recipientName=recipientInput.value.trim();
    const senderName=senderInput.value.trim();
    const personalMessage=messageInput.value.trim();
    if(!recipientName||!senderName||!personalMessage){
      statusBox.textContent='❌ Please enter recipient name, sender name, and personal message.';
      return;
    }
    if(!termsAccepted.checked){
      statusBox.textContent='❌ Please confirm permission and accept the Terms, Privacy and Refund Policy.';
      return;
    }
    if(!customerKey){
      const restored=await restorePrintoLogin();
      if(!restored)return;
    }
    button.disabled=true;button.textContent='⏳ '+ui.generating;statusBox.textContent=ui.waiting;
    try{
      if(!isBirthdayTemplate){
        const requestLines=[
          'Printo personalized greeting request',
          'Service code: CARD_PERSONALIZATION_AGENT',
          'Occasion: '+selectedOccasion,
          'Template: '+selectedTemplateId,
          'Recipient: '+recipientInput.value.trim(),
          'Sender: '+senderInput.value.trim(),
          'Personal message: '+messageInput.value.trim(),
          'Language: '+currentLanguage,
          'Please prepare this selected occasion video card.'
        ];
        statusBox.textContent='✅ Request ready. Opening Printo worker help...';
        window.location.href='https://wa.me/'+supportPhone+'?text='+encodeURIComponent(requestLines.join('\n'));
        return;
      }
      const response=await fetch('/api/greeting/birthday/generate',{method:'POST',headers:{'Content-Type':'application/json','x-printo-customer-id':customerId,...(customerKey?{'x-printo-customer-key':customerKey}:{})},body:JSON.stringify({to:recipientName,from:senderName,message:personalMessage,language:currentLanguage,customerId,customerKey,termsAccepted:true})});
      const responseText=await response.text();
      let data={};
      try{data=responseText?JSON.parse(responseText):{};}catch(parseError){throw new Error('Server returned an invalid response: '+responseText.slice(0,180));}
      console.log('[Birthday Generate] Response',response.status,data);
      if(data.paymentRequired){
        if(data.payment?.shopify)shopifyPayment.href=data.payment.shopify;
        if(data.payment?.africa)africaPayment.href=data.payment.africa;
        statusBox.textContent='💳 '+(data.error||'Payment is required before another greeting can be generated.');
        button.textContent='✨ '+ui.generate;
        syncGenerateButton();
        return;
      }
      if(!response.ok||!data.ok)throw new Error(data.error||ui.failed);
      if(data.customerKey){customerKey=String(data.customerKey);localStorage.setItem('printoGreetingCustomerKey',customerKey);}
      if(data.queued&&data.progressUrl){statusBox.textContent='✅ Request accepted. Opening render progress...';window.location.href=data.progressUrl;return;}
      statusBox.textContent=(data.hasPrintoVoice?'✅ '+ui.voiceReady:'✅ '+ui.musicReady)+' Credits remaining: '+String(data.access?.creditBalance??data.access?.paidCreditsRemaining??'');
      const target=data.resultUrl||data.downloadUrl;
      if(data.resultUrl){const separator=target.includes('?')?'&':'?';window.location.href=target+separator+'lang='+encodeURIComponent(currentLanguage)}else{window.location.href=target}
    }catch(error){statusBox.textContent='❌ '+(error.message||ui.failed);button.disabled=false;button.textContent='✨ '+ui.generate}
  });
</script>
</body>
</html>`;
}

function buildPremiumGreetingOrderPage(language = "en") {
  const lang = ["en", "es", "fr", "de", "pt", "ar", "zh"].includes(language)
    ? language
    : "en";
  const copy = {
    en: {
      title: "Personal Tribute Music Video Card",
      intro: "Complete the order details and upload the recipient photo and your personal introduction video. Payment is completed only after the order is saved.",
      recipient: "Recipient name",
      sender: "Sender name",
      phone: "WhatsApp phone number",
      email: "Email address (optional)",
      message: "Heartfelt personal message",
      songStyle: "Preferred tribute-song style",
      notes: "Story, memories, qualities, or words for the tribute song",
      photo: "Recipient photo",
      video: "Your personal introduction video",
      submit: "Save Premium Order",
      saving: "Saving order and uploads…",
      required: "Please complete every required field and choose both files.",
      success: "Premium order saved successfully.",
      pay: "Choose payment method",
      shopify: "Pay with Shopify",
      africa: "Africa Payment",
      worker: "Send order to worker on WhatsApp",
      back: "Back to Greeting Studio"
    },
    es: { title:"Tarjeta musical de homenaje personal", intro:"Complete los datos y suba la foto del destinatario y su video de introducción. El pago se realiza después de guardar el pedido.", recipient:"Nombre del destinatario", sender:"Nombre del remitente", phone:"Número de WhatsApp", email:"Correo electrónico (opcional)", message:"Mensaje personal", songStyle:"Estilo de canción preferido", notes:"Historia, recuerdos o palabras para la canción", photo:"Foto del destinatario", video:"Su video personal de introducción", submit:"Guardar pedido Premium", saving:"Guardando pedido y archivos…", required:"Complete todos los campos obligatorios y seleccione ambos archivos.", success:"Pedido Premium guardado.", pay:"Elija el método de pago", shopify:"Pagar con Shopify", africa:"Pago África", worker:"Enviar pedido al trabajador por WhatsApp", back:"Volver al Estudio" },
    fr: { title:"Carte vidéo musicale d’hommage personnel", intro:"Complétez les informations et importez la photo du destinataire et votre vidéo d’introduction. Le paiement vient après l’enregistrement.", recipient:"Nom du destinataire", sender:"Nom de l’expéditeur", phone:"Numéro WhatsApp", email:"E-mail (facultatif)", message:"Message personnel", songStyle:"Style de chanson souhaité", notes:"Histoire, souvenirs ou mots pour la chanson", photo:"Photo du destinataire", video:"Votre vidéo d’introduction", submit:"Enregistrer la commande Premium", saving:"Enregistrement de la commande…", required:"Complétez les champs obligatoires et choisissez les deux fichiers.", success:"Commande Premium enregistrée.", pay:"Choisissez le paiement", shopify:"Payer avec Shopify", africa:"Paiement Afrique", worker:"Envoyer au travailleur sur WhatsApp", back:"Retour au Studio" },
    de: { title:"Persönliche Tribute-Musik-Videokarte", intro:"Füllen Sie die Angaben aus und laden Sie Empfängerfoto und Einführungsvideo hoch. Bezahlt wird nach dem Speichern.", recipient:"Empfängername", sender:"Absendername", phone:"WhatsApp-Nummer", email:"E-Mail (optional)", message:"Persönliche Nachricht", songStyle:"Gewünschter Musikstil", notes:"Geschichte, Erinnerungen oder Worte für den Song", photo:"Empfängerfoto", video:"Persönliches Einführungsvideo", submit:"Premium-Bestellung speichern", saving:"Bestellung wird gespeichert…", required:"Füllen Sie alle Pflichtfelder aus und wählen Sie beide Dateien.", success:"Premium-Bestellung gespeichert.", pay:"Zahlungsmethode wählen", shopify:"Mit Shopify bezahlen", africa:"Afrika-Zahlung", worker:"Bestellung per WhatsApp senden", back:"Zurück zum Studio" },
    pt: { title:"Cartão musical de homenagem pessoal", intro:"Preencha os dados e envie a foto do destinatário e seu vídeo de introdução. O pagamento é feito depois de salvar.", recipient:"Nome do destinatário", sender:"Nome do remetente", phone:"Número de WhatsApp", email:"E-mail (opcional)", message:"Mensagem pessoal", songStyle:"Estilo musical desejado", notes:"História, memórias ou palavras para a música", photo:"Foto do destinatário", video:"Seu vídeo de introdução", submit:"Salvar pedido Premium", saving:"Salvando pedido e arquivos…", required:"Preencha os campos obrigatórios e escolha os dois arquivos.", success:"Pedido Premium salvo.", pay:"Escolha o pagamento", shopify:"Pagar com Shopify", africa:"Pagamento África", worker:"Enviar pedido ao trabalhador no WhatsApp", back:"Voltar ao Studio" },
    ar: { title:"بطاقة فيديو موسيقية للتكريم الشخصي", intro:"أكمل تفاصيل الطلب وارفع صورة المستلم وفيديو التقديم الشخصي. يتم الدفع بعد حفظ الطلب.", recipient:"اسم المستلم", sender:"اسم المرسل", phone:"رقم واتساب", email:"البريد الإلكتروني (اختياري)", message:"الرسالة الشخصية", songStyle:"نمط الأغنية المطلوب", notes:"القصة أو الذكريات أو الكلمات للأغنية", photo:"صورة المستلم", video:"فيديو التقديم الشخصي", submit:"حفظ طلب Premium", saving:"جارٍ حفظ الطلب والملفات…", required:"أكمل الحقول المطلوبة واختر الملفين.", success:"تم حفظ طلب Premium.", pay:"اختر طريقة الدفع", shopify:"الدفع عبر Shopify", africa:"الدفع في أفريقيا", worker:"إرسال الطلب للعامل عبر واتساب", back:"العودة إلى الاستوديو" },
    zh: { title:"个人致敬音乐视频贺卡", intro:"填写订单信息，并上传收件人照片和您的个人介绍视频。保存订单后再付款。", recipient:"收件人姓名", sender:"发件人姓名", phone:"WhatsApp 电话", email:"电子邮件（可选）", message:"个人留言", songStyle:"致敬歌曲风格", notes:"故事、回忆、优点或歌曲内容", photo:"收件人照片", video:"您的个人介绍视频", submit:"保存高级订单", saving:"正在保存订单和文件…", required:"请填写必填项并选择两个文件。", success:"高级订单已保存。", pay:"选择付款方式", shopify:"Shopify 付款", africa:"非洲付款", worker:"通过 WhatsApp 发送给工作人员", back:"返回祝福工作室" }
  };
  const t = copy[lang] || copy.en;
  const dir = lang === "ar" ? "rtl" : "ltr";
  return `<!doctype html>
<html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:linear-gradient(150deg,#071b61,#0b63ce);color:#fff;min-height:100vh;padding:18px}.wrap{max-width:820px;margin:auto}.back{color:#ffd21f;font-weight:900;text-decoration:none}.hero{text-align:center;margin:12px 0 20px}.hero h1{font-size:34px;margin:8px}.hero p{line-height:1.55}.panel{background:#fff;color:#172554;border:3px solid #ffd21f;border-radius:25px;padding:22px;box-shadow:0 18px 44px rgba(0,0,0,.35)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.full{grid-column:1/-1}label{display:block;font-weight:900;margin:5px 0 7px}input,textarea,select{width:100%;padding:13px;border:2px solid #cbd5e1;border-radius:13px;font-size:16px}textarea{min-height:110px}.hint{font-size:12px;color:#64748b;margin-top:5px}.submit{width:100%;border:0;border-radius:15px;padding:16px;background:linear-gradient(90deg,#7b2cbf,#d63384);color:#fff;font-size:19px;font-weight:900;margin-top:15px;cursor:pointer}.submit:disabled{opacity:.55}.status{text-align:center;font-weight:900;min-height:26px;margin-top:12px}.result{display:none;background:#f1f5f9;padding:16px;border-radius:16px;margin-top:15px}.orderId{font-size:20px;font-weight:900}.payments{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.pay{display:block;text-align:center;text-decoration:none;color:#fff;font-weight:900;padding:14px;border-radius:13px}.shopify{background:#4f772d}.africa{background:#008751}.worker{background:#25D366;grid-column:1/-1}.disabled{opacity:.45;pointer-events:none}.agreement{display:flex;align-items:flex-start;gap:10px;background:#fff7d6;border:2px solid #ffd21f;border-radius:13px;padding:13px;margin-top:16px}.agreement input{width:20px;height:20px;flex:0 0 auto;margin:2px 0 0}.agreement label{margin:0;font-weight:800;line-height:1.45}.agreement a{color:#123faa;font-weight:900}@media(max-width:620px){.grid,.payments{grid-template-columns:1fr}.full,.worker{grid-column:auto}.hero h1{font-size:28px}}
</style></head><body><main class="wrap"><a class="back" href="/greetings?lang=${lang}">← ${t.back}</a><section class="hero"><h1>🌟 ${t.title}</h1><p>${t.intro}</p></section><section class="panel">
<form id="premiumForm" enctype="multipart/form-data"><input type="hidden" name="language" value="${lang}"><input type="hidden" id="customerId" name="customerId"><input type="hidden" id="premiumCustomerKey" name="customerKey">
<div class="grid"><div><label>${t.recipient} *</label><input name="recipientName" maxlength="24" required></div><div><label>${t.sender} *</label><input name="senderName" maxlength="24" required></div><div><label>${t.phone} *</label><input name="customerPhone" inputmode="tel" required></div><div><label>${t.email}</label><input name="customerEmail" type="email"></div><div class="full"><label>${t.message} *</label><textarea name="personalMessage" maxlength="220" required></textarea></div><div><label>${t.songStyle}</label><select name="songStyle"><option value="">Worker will discuss with me</option><option>Afrobeat</option><option>Gospel</option><option>R&B / Soul</option><option>Pop</option><option>Highlife</option><option>Hip-Hop / Rap</option><option>Soft acoustic</option><option>Other</option></select></div><div><label>${t.notes}</label><textarea name="tributeNotes" maxlength="1000"></textarea></div><div><label>${t.photo} *</label><input name="recipientPhoto" type="file" accept="image/*" required><div class="hint">JPG, PNG or WebP. Clear portrait preferred.</div></div><div><label>${t.video} *</label><input name="introVideo" type="file" accept="video/mp4,video/quicktime,video/webm,video/*" required><div class="hint">Maximum 60 seconds and 100 MB. Large files are compressed automatically to a smaller 720p MP4 before permanent storage.</div></div></div>
<div class="agreement"><input id="premiumTermsAccepted" name="termsAccepted" type="checkbox" value="yes" required><label for="premiumTermsAccepted">I confirm that I own or have permission to use the recipient photo, introduction video, voice, names, music instructions and all other submitted content. I agree to the <a href="/greetings?lang=${lang}#terms" target="_blank" rel="noopener">Terms of Use, Privacy Policy and Refund Policy</a>.</label></div>
<button id="submitBtn" class="submit" type="submit">✨ ${t.submit}</button><div id="status" class="status"></div></form><div id="result" class="result"><div>${t.success}</div><div id="orderId" class="orderId"></div><h3>${t.pay}</h3><div class="payments"><a id="shopifyPay" class="pay shopify" target="_blank" rel="noopener">🛒 ${t.shopify}</a><a id="africaPay" class="pay africa" target="_blank" rel="noopener">🌍 ${t.africa}</a><a id="workerLink" class="pay worker" target="_blank" rel="noopener">💬 ${t.worker}</a></div></div></section></main>
<script>
const form=document.getElementById('premiumForm'),button=document.getElementById('submitBtn'),termsAccepted=document.getElementById('premiumTermsAccepted'),statusBox=document.getElementById('status'),result=document.getElementById('result'),orderIdBox=document.getElementById('orderId'),shopifyPay=document.getElementById('shopifyPay'),africaPay=document.getElementById('africaPay'),workerLink=document.getElementById('workerLink');
function syncPremiumButton(){button.disabled=false;}
termsAccepted.addEventListener('change',syncPremiumButton);
window.addEventListener('pageshow',syncPremiumButton);
document.addEventListener('DOMContentLoaded',syncPremiumButton);
setTimeout(syncPremiumButton,0);
setTimeout(syncPremiumButton,250);
let accountKey=localStorage.getItem('printoGreetingCustomerKey')||'';if(!accountKey){window.location.replace('/customer-login?next='+encodeURIComponent(location.pathname+location.search));}
document.getElementById('premiumCustomerKey').value=accountKey;
let customerId=localStorage.getItem('printoGreetingCustomerId')||localStorage.getItem('printoPremiumCustomerId');if(!customerId){customerId='premium_'+Date.now()+'_'+Math.random().toString(36).slice(2,11);localStorage.setItem('printoPremiumCustomerId',customerId)}document.getElementById('customerId').value=customerId;
function readVideoDuration(file){return new Promise((resolve,reject)=>{const url=URL.createObjectURL(file),video=document.createElement('video');video.preload='metadata';video.onloadedmetadata=()=>{const duration=Number(video.duration||0);URL.revokeObjectURL(url);resolve(duration)};video.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('The introduction video could not be read.'))};video.src=url;});}
form.addEventListener('submit',async(e)=>{e.preventDefault();if(!termsAccepted.checked){statusBox.textContent='❌ Please confirm permission and accept the Terms, Privacy and Refund Policy.';return;}button.disabled=true;button.textContent='⏳ ${t.saving}';statusBox.textContent='';result.style.display='none';try{const fd=new FormData(form);const photo=fd.get('recipientPhoto'),video=fd.get('introVideo');if(!photo||!photo.size||!video||!video.size)throw new Error('${t.required}');if(photo.size>10*1024*1024)throw new Error('Recipient photo must be 10 MB or smaller.');if(video.size>100*1024*1024)throw new Error('Introduction video must be 100 MB or smaller.');const duration=await readVideoDuration(video);if(duration>60.25)throw new Error('Introduction video must be 60 seconds or shorter.');statusBox.textContent='⏳ Uploading and compressing your introduction video…';fd.set('customerKey',accountKey);const response=await fetch('/api/greeting/premium/request',{method:'POST',headers:{'x-printo-customer-id':customerId,'x-printo-customer-key':accountKey},body:fd});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Could not save premium order.');statusBox.textContent='✅ ${t.success} Introduction video compressed and stored safely.';orderIdBox.textContent='Order: '+data.orderId;shopifyPay.href=data.payment?.shopify||'#';africaPay.href=data.payment?.africa||'#';if(!data.payment?.shopify)shopifyPay.classList.add('disabled');else shopifyPay.classList.remove('disabled');workerLink.href=data.whatsappUrl;result.style.display='block';result.scrollIntoView({behavior:'smooth'});}catch(error){statusBox.textContent='❌ '+error.message;}finally{button.textContent='✨ ${t.submit}';syncPremiumButton();}});
</script></body></html>`;
}

app.get(["/greetings/premium", "/premium-greeting"], requirePrintoAccountPage, (req, res) => {
  const language = String(req.query.lang || "en").toLowerCase();
  res.type("html").send(buildPremiumGreetingOrderPage(language));
});

app.get(
  ["/premium-media/:orderId/:kind", "/api/greeting/premium/media/:orderId/:kind"],
  async (req, res) => {
    try {
      const orderId = String(req.params.orderId || "").trim();
      const kind = String(req.params.kind || "").toLowerCase();
      const token = String(req.query.token || "").trim();

      const mediaColumns = {
        photo: {
          data: "recipient_photo_data",
          mime: "recipient_photo_mime",
          name: "recipient_photo_name"
        },
        video: {
          data: "intro_video_data",
          mime: "intro_video_mime",
          name: "intro_video_name"
        },
        music: {
          data: "tribute_music_data",
          mime: "tribute_music_mime",
          name: "tribute_music_name"
        },
        final: {
          data: "final_video_data",
          mime: "final_video_mime",
          name: "final_video_name"
        }
      };

      const selected = mediaColumns[kind];
      if (!orderId || !token || !selected) {
        return res.status(404).send("Premium media not found.");
      }

      // Read only the one requested media object. The previous query selected every
      // large BYTEA column for every preview request, which unnecessarily loaded the
      // photo, introduction, music and final video together and stressed PostgreSQL.
      const result = await queryWithRetry(
        `SELECT
           ${selected.data} AS media_data,
           ${selected.mime} AS media_mime,
           ${selected.name} AS media_name
         FROM premium_greeting_orders
         WHERE order_id = $1 AND media_token = $2
         LIMIT 1`,
        [orderId, token],
        { attempts: 6, baseDelayMs: 400 }
      );

      const row = result.rows[0];
      if (!row) return res.status(404).send("Premium media not found.");

      return sendPremiumMediaBuffer(req, res, {
        data: row.media_data,
        mime: row.media_mime,
        name: row.media_name
      });
    } catch (error) {
      console.error("Premium media delivery error:", {
        message: error?.message || String(error),
        code: error?.code || "",
        severity: error?.severity || ""
      });

      if (isTransientPostgresError(error)) {
        res.setHeader("Retry-After", "3");
        return res.status(503).send(
          "Premium media is temporarily unavailable. Please try again in a few seconds."
        );
      }

      return res.status(500).send("Could not open Premium media.");
    }
  }
);

const handlePremiumUpload = premiumUpload.fields([
  { name: "recipientPhoto", maxCount: 1 },
  { name: "introVideo", maxCount: 1 }
]);

app.post(
  "/api/greeting/premium/request",
  (req, res, next) => {
    handlePremiumUpload(req, res, (error) => {
      if (!error) return next();

      const isLimit = error && error.code === "LIMIT_FILE_SIZE";
      return res.status(400).json({
        ok: false,
        error: isLimit
          ? "Premium upload is too large. Use a photo up to 10 MB and an introduction video up to 100 MB."
          : error.message || "Could not receive Premium uploads."
      });
    });
  },
  async (req, res) => {
    let premiumAccessReservation = null;
    let premiumCustomerIdentity = null;
    const photo = req.files?.recipientPhoto?.[0];
    const introVideo = req.files?.introVideo?.[0];
    const compressedVideoPath = introVideo?.path
      ? path.join(premiumTempDir, `${path.parse(introVideo.path).name}_compressed.mp4`)
      : "";

    try {
      const body = req.body || {};
      const recipientName = String(body.recipientName || "").trim().slice(0, 24);
      const senderName = String(body.senderName || "").trim().slice(0, 24);
      const personalMessage = String(body.personalMessage || "").trim().slice(0, 220);
      const customerPhone = String(body.customerPhone || "").replace(/\D+/g, "");
      const customerEmail = String(body.customerEmail || "").trim().slice(0, 200);
      const songStyle = String(body.songStyle || "").trim().slice(0, 100);
      const tributeNotes = String(body.tributeNotes || "").trim().slice(0, 1000);
      const language = String(body.language || "en").toLowerCase();

      if (!recipientName || !senderName || !personalMessage || !customerPhone) {
        return res.status(400).json({
          ok: false,
          error: "Recipient name, sender name, personal message, and WhatsApp phone are required."
        });
      }

      if (!photo || !photo.path || !String(photo.mimetype || "").startsWith("image/")) {
        return res.status(400).json({ ok: false, error: "A recipient photo is required." });
      }

      if (!introVideo || !introVideo.path || !String(introVideo.mimetype || "").startsWith("video/")) {
        return res.status(400).json({ ok: false, error: "A personal introduction video is required." });
      }

      const photoBytes = fs.statSync(photo.path).size;
      const originalVideoBytes = fs.statSync(introVideo.path).size;
      if (photoBytes > PREMIUM_PHOTO_MAX_BYTES) {
        return res.status(400).json({ ok: false, error: "Recipient photo must be 10 MB or smaller." });
      }
      if (originalVideoBytes > PREMIUM_VIDEO_UPLOAD_MAX_BYTES) {
        return res.status(400).json({ ok: false, error: "Introduction video must be 100 MB or smaller." });
      }

      premiumCustomerIdentity = getGreetingCustomerIdentity(req, {
        customerKey: body.customerKey,
        customerId: body.customerId,
        customerPhone,
        email: customerEmail
      });

      if (premiumCustomerIdentity.identitySource !== "customer_key") {
        return res.status(401).json({
          ok: false,
          loginRequired: true,
          error: "Please log in to your Printo account before submitting a Premium greeting."
        });
      }

      const premiumRegisteredAccount = await queryWithRetry(
        `SELECT email FROM greeting_customer_accounts WHERE customer_key = $1 LIMIT 1`,
        [premiumCustomerIdentity.customerKey]
      );
      if (!premiumRegisteredAccount.rows[0]) {
        return res.status(401).json({
          ok: false,
          loginRequired: true,
          error: "Your Printo login has expired. Please log in again."
        });
      }

      premiumAccessReservation = await reserveGreetingGenerationAccess(
        premiumCustomerIdentity.customerKey,
        premiumCustomerIdentity.contactPhone,
        "premium_video"
      );

      if (!premiumAccessReservation.allowed) {
        const payment = buildGreetingPaymentLinks({
          customerKey: premiumCustomerIdentity.customerKey,
          templateId: "premium-tribute",
          contactPhone: customerPhone
        });
        return res.status(402).json({
          ok: false,
          paymentRequired: true,
          error: `You need ${PRINTO_CREATION_CREDIT_COSTS.premium_video} credits to create this Premium Tribute.`,
          customerKey: premiumCustomerIdentity.customerKey,
          access: premiumAccessReservation,
          payment
        });
      }

      const compression = await compressPremiumIntroductionVideo(
        introVideo.path,
        compressedVideoPath
      );
      const photoBuffer = fs.readFileSync(photo.path);
      const compressedVideoBuffer = fs.readFileSync(compressedVideoPath);

      const identity = premiumCustomerIdentity;
      const customerKey = identity.customerKey;
      const orderId = makePremiumOrderId();
      const mediaToken = crypto.randomBytes(24).toString("hex");
      const recipientPhotoUrl = buildPremiumMediaUrl(req, orderId, mediaToken, "photo");
      const introVideoUrl = buildPremiumMediaUrl(req, orderId, mediaToken, "video");
      const finalVideoUrl = buildPremiumMediaUrl(req, orderId, mediaToken, "final");
      const voiceScript = buildPremiumVoiceScript({
        recipient_name: recipientName,
        sender_name: senderName,
        personal_message: personalMessage
      });
      const payment = buildPremiumPaymentLinks({
        orderId,
        customerKey,
        contactPhone: customerPhone
      });

      await queryWithRetry(
        `
        INSERT INTO premium_greeting_orders (
          order_id, customer_key, contact_phone, customer_email,
          recipient_name, sender_name, personal_message, song_style,
          tribute_notes, recipient_photo_url, intro_video_url,
          recipient_photo_data, recipient_photo_mime, recipient_photo_name,
          intro_video_data, intro_video_mime, intro_video_name,
          intro_video_duration_seconds, intro_video_original_bytes,
          intro_video_stored_bytes, voice_script, final_video_url,
          media_token, status, dashboard_job_id, render_status,
          created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
          $23,'payment_required','','not_started',NOW(),NOW()
        )
        `,
        [
          orderId,
          customerKey,
          customerPhone,
          customerEmail,
          recipientName,
          senderName,
          personalMessage,
          songStyle,
          tributeNotes,
          recipientPhotoUrl,
          introVideoUrl,
          photoBuffer,
          photo.mimetype,
          safeBaseName(photo.originalname || "recipient-photo"),
          compressedVideoBuffer,
          compression.mime,
          compression.name,
          compression.duration,
          originalVideoBytes,
          compression.storedBytes,
          voiceScript,
          finalVideoUrl,
          mediaToken
        ]
      );

      await queryWithRetry(
        `UPDATE premium_greeting_orders
         SET status = 'paid',
             payment_provider = 'printo_credits',
             payment_reference = $2,
             paid_at = NOW(),
             updated_at = NOW()
         WHERE order_id = $1`,
        [orderId, `credits:${PRINTO_CREATION_CREDIT_COSTS.premium_video}`]
      );

      const job = await createPremiumGreetingDashboardJob({
        orderId,
        customerKey,
        contactPhone: customerPhone,
        customerEmail,
        recipientName,
        senderName,
        personalMessage,
        songStyle,
        tributeNotes,
        recipientPhotoUrl,
        introVideoUrl,
        introVideoMime: compression.mime,
        recipientPhotoMime: photo.mimetype,
        shopifyUrl: payment.shopify,
        africaUrl: payment.africa,
        language,
        introDuration: compression.duration,
        originalVideoBytes,
        storedVideoBytes: compression.storedBytes
      });

      if (job?.id) {
        await queryWithRetry(
          `UPDATE premium_greeting_orders SET dashboard_job_id = $2, updated_at = NOW() WHERE order_id = $1`,
          [orderId, String(job.id)]
        );
      }

      const workerMessage = [
        "Printo Premium Tribute order saved",
        `Premium order ID: ${orderId}`,
        `Recipient: ${recipientName}`,
        `Sender: ${senderName}`,
        `Customer phone: ${customerPhone}`,
        `Introduction: ${compression.duration.toFixed(1)} seconds; compressed from ${Math.round(originalVideoBytes / 1024 / 1024)} MB to ${Math.round(compression.storedBytes / 1024 / 1024)} MB.`,
        "I submitted the photo, introduction video, message, and tribute-song details on Printo Studio.",
        "Please confirm payment and help complete this premium order."
      ].join("\n");
      const whatsappUrl = `https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(workerMessage)}`;

      return res.json({
        ok: true,
        orderId,
        customerKey,
        jobId: job?.id || null,
        payment,
        whatsappUrl,
        status: "paid",
        paymentRequired: false,
        access: premiumAccessReservation,
        creditBalance: premiumAccessReservation.creditBalance,
        remainingCreations: premiumAccessReservation.remainingCreations,
        compression: {
          durationSeconds: Number(compression.duration.toFixed(2)),
          originalBytes: originalVideoBytes,
          storedBytes: compression.storedBytes
        },
        media: {
          photo: recipientPhotoUrl,
          video: introVideoUrl,
          final: finalVideoUrl
        }
      });
    } catch (error) {
      if (premiumAccessReservation?.allowed && premiumCustomerIdentity?.customerKey) {
        await refundGreetingGenerationAccess(
          premiumCustomerIdentity.customerKey,
          premiumAccessReservation.source
        ).catch((refundError) => {
          console.error("Premium credit refund failed:", refundError);
        });
        premiumAccessReservation = null;
      }
      console.error("Premium greeting request error:", error);
      const clientError = /must be|too large|duration|valid video|could not be read/i.test(String(error.message || ""));
      return res.status(clientError ? 400 : 500).json({
        ok: false,
        error: error.message || "Could not save premium greeting order."
      });
    } finally {
      safeUnlink(photo?.path);
      safeUnlink(introVideo?.path);
      safeUnlink(compressedVideoPath);
    }
  }
);

app.post(
  "/api/greeting/premium/music",
  requireDashboardKey,
  (req, res, next) => {
    premiumMusicUpload.single("tributeMusic")(req, res, (error) => {
      if (!error) return next();
      console.error("Premium music receive error:", error);
      return res.status(400).json({
        ok: false,
        error: error.code === "LIMIT_FILE_SIZE"
          ? "Tribute music must be 30 MB or smaller."
          : error.message || "Could not receive tribute music."
      });
    });
  },
  async (req, res) => {
    const music = req.file;
    const orderId = String(
      req.body?.orderId ||
      req.body?.order_id ||
      req.query?.orderId ||
      req.query?.order_id ||
      ""
    ).trim();

    console.log("Premium music upload request received:", {
      orderId,
      hasFile: Boolean(music?.path),
      filename: music?.originalname || "",
      mime: music?.mimetype || "",
      bytes: Number(music?.size || 0)
    });

    const client = await pool.connect();
    try {
      if (!orderId) {
        return res.status(400).json({ ok: false, error: "Premium order ID is required." });
      }
      if (!music?.path || !fs.existsSync(music.path)) {
        return res.status(400).json({ ok: false, error: "Choose the completed tribute music file." });
      }

      const probe = await probePremiumMedia(music.path);
      if (!probe.hasAudio) {
        return res.status(400).json({ ok: false, error: "The selected file does not contain audio." });
      }

      const musicBuffer = await fs.promises.readFile(music.path);
      if (!Buffer.isBuffer(musicBuffer) || musicBuffer.length === 0) {
        return res.status(400).json({ ok: false, error: "The selected tribute music file is empty." });
      }

      await client.query("BEGIN");

      const found = await client.query(
        `SELECT order_id, media_token, dashboard_job_id
         FROM premium_greeting_orders
         WHERE order_id = $1
         LIMIT 1
         FOR UPDATE`,
        [orderId]
      );
      const order = found.rows[0];
      if (!order) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "Premium order was not found." });
      }

      const musicName = safeBaseName(music.originalname || "tribute-music.mp3");
      const musicMime = music.mimetype || "audio/mpeg";
      const musicUrl = buildPremiumMediaUrl(req, orderId, order.media_token, "music");

      const saved = await client.query(
        `UPDATE premium_greeting_orders
         SET tribute_music_data = $2,
             tribute_music_mime = $3,
             tribute_music_name = $4,
             tribute_music_url = $5,
             render_status = 'ready_to_render',
             render_error = '',
             final_video_data = NULL,
             final_video_mime = '',
             final_video_name = '',
             final_video_url = '',
             updated_at = NOW()
         WHERE order_id = $1
         RETURNING order_id,
                   tribute_music_name,
                   tribute_music_mime,
                   tribute_music_url,
                   OCTET_LENGTH(tribute_music_data) AS stored_bytes`,
        [orderId, musicBuffer, musicMime, musicName, musicUrl]
      );

      const savedRow = saved.rows[0];
      const storedBytes = Number(savedRow?.stored_bytes || 0);
      if (!savedRow || storedBytes !== musicBuffer.length) {
        throw new Error(
          `Tribute music storage verification failed. Expected ${musicBuffer.length} bytes but stored ${storedBytes}.`
        );
      }

      await client.query(
        `UPDATE print_jobs
         SET instructions = CASE
               WHEN COALESCE(instructions, '') LIKE '%🎵 CUSTOM TRIBUTE MUSIC READY%'
                 THEN regexp_replace(
                   COALESCE(instructions, ''),
                   E'\\n\\n🎵 CUSTOM TRIBUTE MUSIC READY\\n[^\\n]*',
                   E'\\n\\n🎵 CUSTOM TRIBUTE MUSIC READY\\n' || $3,
                   'g'
                 )
               ELSE COALESCE(instructions, '') || E'\\n\\n🎵 CUSTOM TRIBUTE MUSIC READY\\n' || $3
             END,
             updated_at = NOW()
         WHERE (($1 <> '' AND id::text = $1)
                OR COALESCE(instructions, '') ILIKE $2)`,
        [
          String(order.dashboard_job_id || ""),
          `%${orderId}%`,
          musicUrl
        ]
      );

      await client.query("COMMIT");

      console.log("Premium music stored and verified:", {
        orderId,
        musicName,
        musicMime,
        uploadedBytes: musicBuffer.length,
        storedBytes,
        durationSeconds: Number(probe.duration || 0).toFixed(2),
        musicUrl
      });

      return res.json({
        ok: true,
        orderId,
        musicUrl,
        musicName,
        musicMime,
        uploadedBytes: musicBuffer.length,
        storedBytes,
        durationSeconds: Number(probe.duration || 0)
      });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      console.error("Premium music upload error:", error);
      return res.status(500).json({
        ok: false,
        error: error.message || "Could not save tribute music."
      });
    } finally {
      client.release();
      safeUnlink(music?.path);
    }
  }
);

const activePremiumRenders = new Set();

async function readPremiumBinaryToFile(orderId, columnName, outputPath, missingMessage) {
  const allowedColumns = new Set([
    "recipient_photo_data",
    "intro_video_data",
    "tribute_music_data"
  ]);
  if (!allowedColumns.has(columnName)) {
    throw new Error("Unsupported Premium media column.");
  }

  const result = await queryWithRetry(
    `SELECT ${columnName} AS media_data
     FROM premium_greeting_orders
     WHERE order_id = $1
     LIMIT 1`,
    [orderId]
  );
  const media = result.rows[0]?.media_data;
  if (!media || !Buffer.isBuffer(media) || media.length === 0) {
    throw new Error(missingMessage);
  }

  await fs.promises.writeFile(outputPath, media);
  // Release the PostgreSQL bytea reference before FFmpeg starts.
  result.rows[0].media_data = null;
  return media.length;
}

function premiumSegmentVideoArgs({ duration, outputPath, fps = 15 }) {
  return [
    "-t", String(duration),
    "-r", String(fps),
    "-an",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "32",
    "-threads", "1",
    "-filter_threads", "1",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outputPath
  ];
}

function findPremiumTributeFrame() {
  const candidates = [
    // Final approved blank vertical Premium Tribute master template.
    path.join(__dirname, "templates", "premium", "premium_tribute_frame.png"),
    path.join(__dirname, "templates", "premium", "printo_premium_tribute_vertical.png"),
    path.join(__dirname, "templates", "premium", "printo_premium_tribute_frame.png"),
    path.join(__dirname, "templates", "premium", "premium_tribute_music_video.png")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function renderPremiumOrderVideo({ orderId, req, publicBaseUrl = "" }) {
  const found = await queryWithRetry(
    `SELECT order_id,
            recipient_name,
            sender_name,
            personal_message,
            tribute_notes,
            song_style,
            status,
            media_token,
            dashboard_job_id,
            recipient_photo_mime,
            intro_video_mime,
            tribute_music_mime,
            tribute_music_data IS NOT NULL AS has_custom_music
     FROM premium_greeting_orders
     WHERE order_id = $1
     LIMIT 1`,
    [orderId]
  );
  const order = found.rows[0];
  if (!order) throw new Error("Premium order was not found.");

  const premiumFramePath = findPremiumTributeFrame();
  if (!premiumFramePath) {
    throw new Error(
      "Premium tribute frame is missing. Add templates/premium/premium_tribute_frame.png to the repository."
    );
  }

  const runId = `${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
  const photoExt = getExtFromMime(order.recipient_photo_mime) || ".jpg";
  const musicExt = getExtFromMime(order.tribute_music_mime) || ".mp3";
  const photoPath = path.join(premiumTempDir, `${runId}_photo${photoExt}`);
  const introPath = path.join(premiumTempDir, `${runId}_intro.mp4`);
  const customMusicPath = path.join(premiumTempDir, `${runId}_music${musicExt}`);
  const openingPath = path.join(premiumTempDir, `${runId}_opening.mp4`);
  const introSegmentPath = path.join(premiumTempDir, `${runId}_intro_segment.mp4`);
  const tributePath = path.join(premiumTempDir, `${runId}_tribute.mp4`);
  const concatListPath = path.join(premiumTempDir, `${runId}_concat.txt`);
  const silentVideoPath = path.join(premiumTempDir, `${runId}_silent.mp4`);
  const outputPath = path.join(premiumTempDir, `${runId}_final.mp4`);
  const cleanup = [
    photoPath,
    introPath,
    customMusicPath,
    openingPath,
    introSegmentPath,
    tributePath,
    concatListPath,
    silentVideoPath,
    outputPath
  ];

  try {
    await queryWithRetry(
      `UPDATE premium_greeting_orders
       SET render_status = 'rendering', render_error = '', updated_at = NOW()
       WHERE order_id = $1`,
      [orderId]
    );

    console.log("Premium render stage 1/7 - loading photo:", orderId);
    await readPremiumBinaryToFile(
      orderId,
      "recipient_photo_data",
      photoPath,
      "Recipient photo is missing."
    );

    console.log("Premium render stage 2/7 - loading introduction:", orderId);
    await readPremiumBinaryToFile(
      orderId,
      "intro_video_data",
      introPath,
      "Introduction video is missing."
    );

    // Premium production must use the worker-uploaded Suno/custom tribute song.
    // Never fall back to the demo or intro music for a paid Premium order.
    if (!order.has_custom_music) {
      throw new Error(
        "Custom tribute music is required. Upload the completed Suno song before rendering."
      );
    }

    console.log("Premium render stage 3/7 - loading uploaded Suno/custom music:", orderId);
    const storedMusicBytes = await readPremiumBinaryToFile(
      orderId,
      "tribute_music_data",
      customMusicPath,
      "Custom tribute music is missing. Upload the completed Suno song again."
    );
    const selectedMusicPath = customMusicPath;
    console.log(
      "Premium custom music ready:",
      orderId,
      `${Math.round(storedMusicBytes / 1024)} KB`,
      order.tribute_music_mime || "audio/mpeg"
    );

    const introProbe = await probePremiumMedia(introPath);
    const musicProbe = await probePremiumMedia(selectedMusicPath);
    const introDuration = Math.max(
      1,
      Math.min(PREMIUM_VIDEO_MAX_SECONDS, Number(introProbe.duration || 1))
    );
    // Final Premium sequence: sender introduction starts immediately.
    // The recipient photo and custom music begin at the exact frame where
    // the sender introduction ends. There is no opening card delay.
    const openingDuration = 0;
    const musicDuration = Math.max(20, Math.min(180, Number(musicProbe.duration || 45)));
    const closingDuration = 6;
    const tributeDuration = musicDuration + closingDuration;
    const totalDuration = introDuration + tributeDuration;
    const introEnd = introDuration;

    const recipientName = String(order.recipient_name || "Special Recipient").trim().slice(0, 24);
    const senderName = String(order.sender_name || "With Love").trim().slice(0, 24);
    const fullPersonalMessage = String(
      order.personal_message || "A special tribute created with love."
    ).trim().slice(0, 220);

    // Auto-fit the complete customer message inside the Premium panel.
    // The final production layout uses larger, phone-readable text while
    // still supporting the full 220-character customer message.
    let messageFontSize = 16;
    let messageMaxCharsPerLine = 29;
    let messageMaxLines = 5;
    let messageLineGap = 18;

    if (fullPersonalMessage.length > 180) {
      messageFontSize = 11;
      messageMaxCharsPerLine = 37;
      messageMaxLines = 7;
      messageLineGap = 12;
    } else if (fullPersonalMessage.length > 140) {
      messageFontSize = 12;
      messageMaxCharsPerLine = 35;
      messageMaxLines = 7;
      messageLineGap = 13;
    } else if (fullPersonalMessage.length > 100) {
      messageFontSize = 13;
      messageMaxCharsPerLine = 33;
      messageMaxLines = 6;
      messageLineGap = 14;
    } else if (fullPersonalMessage.length > 60) {
      messageFontSize = 14;
      messageMaxCharsPerLine = 31;
      messageMaxLines = 6;
      messageLineGap = 15;
    }

    const messageLines = wrapGreetingMessage(
      fullPersonalMessage,
      messageMaxCharsPerLine,
      messageMaxLines
    ).split("\\n");

    while (messageLines.length < 8) messageLines.push("");

    const messagePanelTop = 686;
    const messagePanelHeight = 116;
    const messageLabelY = messagePanelTop - 13;
    const messageLabelW = 250;
    const messageLabelH = 26;
    const messageContentTop = messagePanelTop + 20;
    const messageContentHeight = messagePanelHeight - 24;
    const visibleMessageLines = Math.max(
      1,
      messageLines.slice(0, messageMaxLines).filter(Boolean).length
    );
    const messageBlockHeight = visibleMessageLines * messageLineGap;
    const messageStartY =
      messageContentTop +
      Math.max(0, Math.floor((messageContentHeight - messageBlockHeight) / 2));

    const fontFile = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    const fontOption = fs.existsSync(fontFile) ? `fontfile=${fontFile}:` : "";
    const q = quoteDrawtextText;

    // FINAL APPROVED PREMIUM TRIBUTE LAYOUT
    // The background artwork is a 2:3 vertical card. Render at 576 x 864 so
    // the design keeps its original proportions without stretching.
    const outputW = 576;
    const outputH = 864;

    // Large portrait window in the final approved template.
    // No Printo artwork, ribbon, badge, or decoration overlaps this inner area.
    // One shared vertical media window: sender video first, recipient photo next.
    // Coordinates match the final blank 1024 x 1536 artwork scaled to 576 x 864.
    const introWindowX = 157;
    const introWindowY = 150;
    const introWindowW = 262;
    const introWindowH = 371;
    const introInnerX = 166;
    const introInnerY = 160;
    const introInnerW = 244;
    const introInnerH = 347;

    // Fit the complete sender vertically without cutting off the cap, head,
    // face, or shoulders. Any unused space stays a clean warm cream color.
    // Scale the sender video safely, then center it over a cream canvas.
    // Do NOT use FFmpeg pad here: phone rotation/SAR metadata can make the
    // scaled frame appear larger than the requested pad canvas and trigger
    // "Padded dimensions cannot be smaller than input dimensions".
    const introVideoFilter =
      `scale=${introInnerW}:${introInnerH}:force_original_aspect_ratio=decrease,` +
      `setsar=1,format=yuv420p`;

    // The recipient photograph replaces the sender video immediately after
    // the speech ends. A very gentle zoom keeps the music section alive.
    const recipientPhotoFilter =
      `scale=${introInnerW + 34}:${introInnerH + 48}:force_original_aspect_ratio=increase,` +
      `crop=${introInnerW}:${introInnerH}:(iw-${introInnerW})/2:(ih-${introInnerH})/2,` +
      `setsar=1,format=yuv420p`;

    // Coordinates are based on the approved 1024 x 1536 artwork scaled exactly
    // to 576 x 864.
    const baseFrame = `scale=${outputW}:${outputH},setsar=1,format=yuv420p`;

    const commonTextOverlay = [
      // Keep all customer fields blank in the master artwork, then write the
      // current order's data into the dedicated panels at render time.
      "drawbox=x=53:y=574:w=199:h=48:color=#fff7e6@0.99:t=fill",
      "drawbox=x=326:y=574:w=199:h=48:color=#fff7e6@0.99:t=fill",
      "drawbox=x=58:y=681:w=460:h=116:color=#fff7e6@0.99:t=fill",

      // Recipient and sender names.
      `drawtext=${fontOption}text=${q(recipientName)}:x=153-text_w/2:y=586:fontsize=19:fontcolor=#082b6a:borderw=1:bordercolor=#fff7e6`,
      `drawtext=${fontOption}text=${q(senderName)}:x=426-text_w/2:y=586:fontsize=19:fontcolor=#082b6a:borderw=1:bordercolor=#fff7e6`,

      // Complete 220-character heartfelt message.
      `drawtext=${fontOption}text=${q(messageLines[0] || "")}:x=(w-text_w)/2:y=699:fontsize=${messageFontSize}:fontcolor=#082b6a:borderw=1:bordercolor=#fff7e6`,
      `drawtext=${fontOption}text=${q(messageLines[1] || "")}:x=(w-text_w)/2:y=${699 + messageLineGap}:fontsize=${messageFontSize}:fontcolor=#082b6a:borderw=1:bordercolor=#fff7e6`,
      `drawtext=${fontOption}text=${q(messageLines[2] || "")}:x=(w-text_w)/2:y=${699 + messageLineGap * 2}:fontsize=${messageFontSize}:fontcolor=#082b6a:borderw=1:bordercolor=#fff7e6`,
      `drawtext=${fontOption}text=${q(messageLines[3] || "")}:x=(w-text_w)/2:y=${699 + messageLineGap * 3}:fontsize=${messageFontSize}:fontcolor=#082b6a:borderw=1:bordercolor=#fff7e6`,
      `drawtext=${fontOption}text=${q(messageLines[4] || "")}:x=(w-text_w)/2:y=${699 + messageLineGap * 4}:fontsize=${messageFontSize}:fontcolor=#082b6a:borderw=1:bordercolor=#fff7e6`,
      `drawtext=${fontOption}text=${q(messageLines[5] || "")}:x=(w-text_w)/2:y=${699 + messageLineGap * 5}:fontsize=${messageFontSize}:fontcolor=#082b6a:borderw=1:bordercolor=#fff7e6`,
      `drawtext=${fontOption}text=${q(messageLines[6] || "")}:x=(w-text_w)/2:y=${699 + messageLineGap * 6}:fontsize=${messageFontSize}:fontcolor=#082b6a:borderw=1:bordercolor=#fff7e6`,
      `drawtext=${fontOption}text=${q(messageLines[7] || "")}:x=(w-text_w)/2:y=${699 + messageLineGap * 7}:fontsize=${messageFontSize}:fontcolor=#082b6a:borderw=1:bordercolor=#fff7e6`
    ].join(",");

    console.log("Premium render stage 4/7 - creating final vertical Printo segments:", orderId);
    console.log("Premium Stage 4 media window:", { orderId, introInnerW, introInnerH, introDuration, tributeDuration });

    // No separate opening segment. The sender introduction begins at 0:00.

    // Sender introduction: only the sender's portrait video is shown in the
    // vertical window. The original sender audio is retained for this segment.
    await execFilePromise("ffmpeg", [
      "-y", "-nostdin", "-loglevel", "error",
      "-loop", "1", "-i", premiumFramePath,
      "-i", introPath,
      "-filter_complex",
      `[0:v]${baseFrame},${commonTextOverlay}[base];` +
      `[1:v]${introVideoFilter}[intro_scaled];` +
      `color=c=#fff7e6:s=${introInnerW}x${introInnerH}:d=${introDuration},format=yuv420p[intro_canvas];` +
      `[intro_canvas][intro_scaled]overlay=(W-w)/2:(H-h)/2:shortest=1[intro];` +
      `[base][intro]overlay=${introInnerX}:${introInnerY}:shortest=1[v]`,
      "-map", "[v]",
      ...premiumSegmentVideoArgs({ duration: introDuration, outputPath: introSegmentPath, fps: 18 })
    ], { timeout: PREMIUM_RENDER_STAGE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });

    // Tribute section: as soon as the sender speech finishes, replace the
    // sender video with the recipient photograph and play the custom music to
    // the end. The sender video is never frozen or left talking under the song.
    await execFilePromise("ffmpeg", [
      "-y", "-nostdin", "-loglevel", "error",
      "-loop", "1", "-i", premiumFramePath,
      "-loop", "1", "-i", photoPath,
      "-filter_complex",
      `[0:v]${baseFrame},${commonTextOverlay}[base];` +
      `[1:v]${recipientPhotoFilter},` +
      `tpad=stop_mode=clone:stop_duration=${tributeDuration}[recipient];` +
      `[base][recipient]overlay=${introInnerX}:${introInnerY}:shortest=1[v]`,
      "-map", "[v]",
      ...premiumSegmentVideoArgs({ duration: tributeDuration, outputPath: tributePath, fps: 12 })
    ], { timeout: PREMIUM_RENDER_STAGE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });

    const escapeConcatPath = (value) => String(value).replace(/'/g, "'\\''");
    await fs.promises.writeFile(
      concatListPath,
      [introSegmentPath, tributePath]
        .map((file) => `file '${escapeConcatPath(file)}'`)
        .join("\n") + "\n",
      "utf8"
    );

    console.log("Premium render stage 5/7 - joining branded segments:", orderId);
    await execFilePromise("ffmpeg", [
      "-y", "-nostdin", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", concatListPath,
      "-c", "copy",
      "-movflags", "+faststart",
      silentVideoPath
    ], { timeout: PREMIUM_RENDER_STAGE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });

    console.log("Premium render stage 6/7 - mixing intro audio and tribute music:", orderId);
    const audioInputArgs = [
      "-i", silentVideoPath,
      "-i", selectedMusicPath
    ];
    let introAudioIndex = -1;
    if (introProbe.hasAudio) {
      introAudioIndex = 2;
      audioInputArgs.push("-i", introPath);
    }

    // Build one exact, non-overlapping audio timeline:
    // 1) sender speech only from 0:00 for the exact introduction duration,
    // 2) custom tribute music only after the sender speech ends.
    // Using concat instead of amix prevents the sender voice from continuing
    // underneath the tribute song and keeps the recipient-photo switch exact.
    const audioFilters = [
      `[1:a]atrim=0:${tributeDuration},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=0.15,` +
      `afade=t=out:st=${Math.max(0, tributeDuration - 4)}:d=4,` +
      `volume=1.0,apad=pad_dur=${tributeDuration},atrim=0:${tributeDuration}[music_exact]`
    ];

    if (introAudioIndex >= 0) {
      audioFilters.push(
        `[${introAudioIndex}:a]atrim=0:${introDuration},asetpts=PTS-STARTPTS,` +
        `loudnorm=I=-16:TP=-1.5:LRA=11,volume=1.22,` +
        `afade=t=out:st=${Math.max(0, introDuration - 0.12)}:d=0.12,` +
        `apad=pad_dur=${introDuration},atrim=0:${introDuration}[intro_exact]`
      );
    } else {
      audioFilters.push(
        `anullsrc=r=48000:cl=stereo,atrim=0:${introDuration},asetpts=PTS-STARTPTS[intro_exact]`
      );
    }

    audioFilters.push(
      `[intro_exact][music_exact]concat=n=2:v=0:a=1,` +
      `alimiter=limit=0.95,atrim=0:${totalDuration}[aout]`
    );

    console.log("Premium exact switch timing:", {
      orderId,
      openingDuration,
      introDuration,
      recipientPhotoStartsAt: introEnd,
      tributeMusicStartsAt: introEnd,
      noOpeningDelay: true,
      totalDuration
    });

    await execFilePromise("ffmpeg", [
      "-y", "-nostdin", "-loglevel", "error",
      ...audioInputArgs,
      "-filter_complex", audioFilters.join(";"),
      "-map", "0:v:0",
      "-map", "[aout]",
      "-t", String(totalDuration),
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "112k",
      "-threads", "1",
      "-filter_complex_threads", "1",
      "-movflags", "+faststart",
      outputPath
    ], { timeout: PREMIUM_RENDER_STAGE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });

    const outputStat = await fs.promises.stat(outputPath);
    if (outputStat.size > PREMIUM_FINAL_VIDEO_MAX_BYTES) {
      throw new Error("Finished Premium video is larger than the temporary launch storage limit.");
    }

    console.log("Premium render stage 7/7 - saving finished video:", orderId);
    const finalBytes = await fs.promises.readFile(outputPath);
    const finalVideoUrl = publicBaseUrl
      ? `${String(publicBaseUrl).replace(/\/$/, "")}/premium-media/${encodeURIComponent(orderId)}/final?token=${encodeURIComponent(order.media_token)}`
      : buildPremiumMediaUrl(req, orderId, order.media_token, "final");

    await queryWithRetry(
      `UPDATE premium_greeting_orders
       SET final_video_data = $2,
           final_video_mime = 'video/mp4',
           final_video_name = $3,
           final_video_url = $4,
           voice_script = $5,
           render_status = 'completed',
           render_error = '',
           status = CASE WHEN status = 'paid' THEN 'completed' ELSE status END,
           updated_at = NOW()
       WHERE order_id = $1`,
      [
        orderId,
        finalBytes,
        `Printo-Premium-${orderId}.mp4`,
        finalVideoUrl,
        `Personal introduction by ${senderName}, followed by a tribute song for ${recipientName}.`
      ]
    );

    await queryWithRetry(
      `UPDATE print_jobs
       SET instructions = CASE
             WHEN COALESCE(instructions, '') LIKE '%🎬 FINISHED PREMIUM VIDEO%'
               THEN COALESCE(instructions, '')
             ELSE COALESCE(instructions, '') || $3
           END,
           updated_at = NOW()
       WHERE (($1 <> '' AND id::text = $1)
              OR COALESCE(instructions, '') ILIKE $2)`,
      [
        String(order.dashboard_job_id || ""),
        `%${orderId}%`,
        `\n\n🎬 FINISHED PREMIUM VIDEO\n${finalVideoUrl}`
      ]
    );

    return {
      orderId,
      finalVideoUrl,
      totalDuration,
      hasVoice: Boolean(introProbe.hasAudio),
      usedCustomMusic: true,
      usedPremiumFrame: true
    };
  } catch (error) {
    await queryWithRetry(
      `UPDATE premium_greeting_orders
       SET render_status = 'failed', render_error = $2, updated_at = NOW()
       WHERE order_id = $1`,
      [orderId, String(error.message || "Render failed").slice(0, 1000)]
    ).catch(() => {});
    throw error;
  } finally {
    cleanup.forEach(safeUnlink);
  }
}

app.post("/api/greeting/premium/render", requireDashboardKey, express.json(), async (req, res) => {
  try {
    const orderId = String(req.body?.orderId || req.body?.order_id || "").trim();
    if (!orderId) {
      return res.status(400).json({ ok: false, error: "Premium order ID is required." });
    }

    const found = await queryWithRetry(
      `SELECT order_id, render_status, render_error, final_video_url
       FROM premium_greeting_orders
       WHERE order_id = $1
       LIMIT 1`,
      [orderId]
    );
    const order = found.rows[0];
    if (!order) {
      return res.status(404).json({ ok: false, error: "Premium order was not found." });
    }

    const forceRender =
      req.body?.force === true ||
      String(req.body?.force || "").toLowerCase() === "true" ||
      String(req.body?.force || "") === "1";

    if (
      !forceRender &&
      String(order.render_status || "").toLowerCase() === "completed" &&
      order.final_video_url
    ) {
      return res.json({
        ok: true,
        accepted: false,
        status: "completed",
        finalVideoUrl: order.final_video_url
      });
    }

    if (activePremiumRenders.has(orderId)) {
      return res.status(202).json({
        ok: true,
        accepted: true,
        status: "rendering",
        message: "Premium rendering is already in progress."
      });
    }

    const publicBaseUrl = getPublicBaseUrl(req);
    await queryWithRetry(
      `UPDATE premium_greeting_orders
       SET render_status = 'queued',
           render_error = '',
           final_video_url = CASE WHEN $2::boolean THEN '' ELSE final_video_url END,
           final_video_data = CASE WHEN $2::boolean THEN NULL ELSE final_video_data END,
           final_video_mime = CASE WHEN $2::boolean THEN '' ELSE final_video_mime END,
           updated_at = NOW()
       WHERE order_id = $1`,
      [orderId, forceRender]
    );

    // Start FFmpeg only after the 202 response has fully left the server.
    res.once("finish", () => {
      setTimeout(async () => {
        if (activePremiumRenders.has(orderId)) return;
        activePremiumRenders.add(orderId);
        console.log("Premium low-memory background render started:", orderId);
        try {
          const result = await renderPremiumOrderVideo({
            orderId,
            req: null,
            publicBaseUrl
          });
          console.log(
            "Premium low-memory background render completed:",
            orderId,
            result.finalVideoUrl || ""
          );
        } catch (error) {
          console.error(
            "Premium low-memory background render failed:",
            orderId,
            error?.stderr || error?.message || error
          );
        } finally {
          activePremiumRenders.delete(orderId);
        }
      }, 750);
    });

    console.log("Premium low-memory render queued:", orderId);
    return res.status(202).json({
      ok: true,
      accepted: true,
      status: "queued",
      message: "Premium rendering was queued successfully."
    });
  } catch (error) {
    console.error("Premium render start error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Premium video rendering could not start."
    });
  }
});

app.get("/api/greeting/premium/render-status", requireDashboardKey, async (req, res) => {
  try {
    const orderId = String(req.query.orderId || req.query.order_id || "").trim();
    if (!orderId) {
      return res.status(400).json({ ok: false, error: "Premium order ID is required." });
    }

    const found = await queryWithRetry(
      `SELECT order_id,
              render_status,
              render_error,
              final_video_url,
              updated_at
       FROM premium_greeting_orders
       WHERE order_id = $1
       LIMIT 1`,
      [orderId]
    );
    const order = found.rows[0];
    if (!order) {
      return res.status(404).json({ ok: false, error: "Premium order was not found." });
    }

    return res.json({
      ok: true,
      orderId,
      renderStatus: String(order.render_status || "not_started").toLowerCase(),
      renderError: order.render_error || "",
      finalVideoUrl: order.final_video_url || "",
      updatedAt: order.updated_at || null
    });
  } catch (error) {
    console.error("Premium render status error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Could not read Premium render status."
    });
  }
});

app.get(["/greetings", "/greeting"], (req, res) => {
  const language = String(req.query.lang || "en").toLowerCase();
  res.type("html").send(buildGreetingStudioHomePage(language));
});


app.get("/api/greeting/birthday/jobs/:jobId", async (req, res) => {
  const localJob = loadBirthdayJobStatus(req.params.jobId);
  if (localJob) return res.json({ ok: true, job: localJob });
  try {
    const row = await getStandardGreetingJobById(req.params.jobId);
    if (!row) return res.status(404).json({ ok: false, error: "Birthday render job not found." });
    const publicBase = String(getConfiguredPublicOrigin(req)).replace(/\/$/, "");
    const job = {
      jobId: row.job_id,
      greetingId: row.greeting_id,
      status: row.status,
      progress: row.status === "ready" || row.status === "failed" ? 100 : 50,
      message: row.status === "ready"
        ? "Your Printo birthday video is ready!"
        : row.status === "failed"
          ? (row.render_error || "The render failed. Credits were restored.")
          : "Printo is creating your video.",
      error: row.status === "failed" ? (row.render_error || "Render failed.") : "",
      resultUrl: row.status === "ready" ? `${publicBase}/g/${encodeURIComponent(row.greeting_id)}` : ""
    };
    return res.json({ ok: true, job });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "Could not load render status." });
  }
});

app.get("/birthday-progress/:jobId", (req, res) => {
  const jobId = String(req.params.jobId || "");
  const language = String(req.query.lang || "en");
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Printo Render Progress</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(180deg,#071b61,#0b63ce);font-family:Arial;color:#10245e;padding:20px}.card{width:min(620px,100%);background:#fff;border-radius:24px;padding:28px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.35)}h1{color:#123b9d}.bar{height:24px;background:#e5e7eb;border-radius:99px;overflow:hidden;margin:22px 0}.fill{height:100%;width:5%;background:linear-gradient(90deg,#7b2cbf,#d63384);transition:width .5s}.status{font-weight:800;font-size:18px}.note{color:#64748b;line-height:1.5}.btn{display:inline-block;margin-top:18px;padding:13px 20px;border-radius:13px;background:#7b2cbf;color:#fff;text-decoration:none;font-weight:900}</style></head><body><div class="card"><h1>🎂 Printo is creating your video</h1><div class="bar"><div id="fill" class="fill"></div></div><div id="percent" class="status">5%</div><p id="message" class="note">Your request is queued.</p><p class="note">You may keep this page open. It will automatically take you to your finished video.</p><a class="btn" href="/greetings?lang=${encodeURIComponent(language)}">Back to Studio</a></div><script>const jobId=${JSON.stringify(jobId)};async function check(){try{const r=await fetch('/api/greeting/birthday/jobs/'+encodeURIComponent(jobId),{cache:'no-store'});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Unable to load render status');const j=d.job||{};const p=Math.max(0,Math.min(100,Number(j.progress||0)));document.getElementById('fill').style.width=p+'%';document.getElementById('percent').textContent=p+'%';document.getElementById('message').textContent=j.message||j.status||'Working...';if(j.status==='ready'&&j.resultUrl){window.location.href=j.resultUrl+(j.resultUrl.includes('?')?'&':'?')+'lang='+encodeURIComponent(${JSON.stringify(language)});return;}if(j.status==='failed'){document.getElementById('message').textContent='❌ '+(j.error||j.message||'Render failed.');return;}setTimeout(check,2500);}catch(e){document.getElementById('message').textContent='Still working... reconnecting.';setTimeout(check,4000);}}check();</script></body></html>`);
});

app.post("/birthday-submit", async (req, res) => {
  const language = ["en", "es", "fr", "de", "pt", "ar", "zh"].includes(String(req.body?.language || "en").toLowerCase())
    ? String(req.body.language).toLowerCase()
    : "en";
  const publicBase = String(
    getConfiguredPublicOrigin(req)
  ).replace(/\/$/, "");

  console.log("[Birthday Form Fallback] Native form received", {
    hasRecipient: Boolean(String(req.body?.to || "").trim()),
    hasSender: Boolean(String(req.body?.from || "").trim()),
    messageLength: String(req.body?.message || "").length
  });

  try {
    let customerId = String(req.body?.customerId || "").trim();
    let customerKey = String(
      req.body?.customerKey ||
      readPrintoCookie(req, "printo_customer_key") ||
      ""
    ).trim();

    // Native form submission can happen when a browser restores an older tab.
    // Recover the logged-in account from the submitted email when the hidden
    // customer key or cookie is unavailable.
    if (!customerKey && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerId)) {
      const accountLookup = await queryWithRetry(
        `SELECT customer_key FROM greeting_customer_accounts WHERE email = $1 LIMIT 1`,
        [normalizePrintoAccountEmail(customerId)]
      );
      customerKey = String(accountLookup.rows[0]?.customer_key || "").trim();
    }

    if (!customerKey) {
      return res.redirect(
        `/customer-login?next=${encodeURIComponent(`/birthday?lang=${language}&template=birthday`)}`
      );
    }

    const apiResponse = await axios.post(
      `${publicBase}/api/greeting/birthday/generate`,
      {
        to: req.body?.to || "",
        from: req.body?.from || "",
        message: req.body?.message || "",
        language,
        customerId,
        customerKey,
        termsAccepted: true
      },
      {
        headers: {
          "Content-Type": "application/json",
          ...(customerId ? { "x-printo-customer-id": customerId } : {}),
          ...(customerKey ? { "x-printo-customer-key": customerKey } : {}),
          ...(req.headers.cookie ? { "Cookie": req.headers.cookie } : {})
        },
        timeout: PREMIUM_RENDER_STAGE_TIMEOUT_MS * 3,
        validateStatus: () => true
      }
    );

    const data = apiResponse.data || {};
    if (apiResponse.status >= 200 && apiResponse.status < 300 && data.ok) {
      const target = String(data.progressUrl || data.resultUrl || data.downloadUrl || "");
      if (target) {
        const separator = target.includes("?") ? "&" : "?";
        return res.redirect(`${target}${separator}lang=${encodeURIComponent(language)}`);
      }
    }

    const message = String(data.error || "Birthday generation failed. Please return and try again.");
    const paymentLinks = data.paymentRequired && data.payment
      ? `<p><a href="${String(data.payment.shopify || "#")}">Shopify Payment</a></p><p><a href="${String(data.payment.africa || "#")}">Nigeria Payment</a></p>`
      : "";
    return res.status(apiResponse.status || 500).send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Printo Generation</title></head><body style="font-family:Arial;background:#0b2d86;color:white;padding:30px"><div style="max-width:680px;margin:auto;background:white;color:#10245e;padding:24px;border-radius:18px"><h2>Generation could not continue</h2><p>${message.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</p>${paymentLinks}<p><a href="/birthday?lang=${encodeURIComponent(language)}">Return to Birthday Studio</a></p></div></body></html>`);
  } catch (error) {
    console.error("[Birthday Form Fallback] Failed:", error);
    return res.status(500).send(`Birthday generation request failed: ${String(error.message || error)}`);
  }
});

app.get(["/birthday", "/birthday-generator", "/generate-birthday", "/greetings/create"], requirePrintoAccountPage, (req, res) => {
  const language = String(req.query.lang || "en").toLowerCase();
  const templateId = String(req.query.template || "birthday").toLowerCase();
  res.type("html").send(buildBirthdayGeneratorPage(language, templateId));
});

function renderGreetingResult(req, res) {
  const videoUrl = String(req.query.video || "");
  const toName = String(req.query.to || "");
  const fromName = String(req.query.from || "");
  const posterUrl = String(req.query.poster || "");
  const sharePosterUrl = String(req.query.sharePoster || req.query.poster || "");
  const requestedDownloadUrl = String(req.query.download || "").trim();
  const downloadUrl = requestedDownloadUrl || videoUrl;
  const language = ["en", "es", "fr", "de", "pt", "ar", "zh"].includes(String(req.query.lang || "en").toLowerCase())
    ? String(req.query.lang || "en").toLowerCase()
    : "en";
  const shopifyUrl = GREETING_SHOPIFY_PAYMENT_URL;
  const nigeriaUrl = "https://www.patapata.us/pages/africa-payment";

  if (!videoUrl.startsWith("http")) {
    return res.status(400).send("Invalid or missing greeting video link.");
  }

  const escapeHtml = (value = "") => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeVideo = escapeHtml(videoUrl);
  const safePoster = posterUrl.startsWith("http") ? escapeHtml(posterUrl) : "";
  const safeSharePoster = sharePosterUrl.startsWith("http")
    ? escapeHtml(sharePosterUrl)
    : safePoster;
  const publicBase = String(
    getConfiguredPublicOrigin(req)
  ).replace(/\/$/, "");
  const pageUrl = `${publicBase}${req.originalUrl}`;
  const title = `A special Printo greeting${toName ? ` for ${toName}` : ""}`;
  const studioReturnUrl = buildBrandedPrintoStudioUrl(language);
  const shopifyMenuUrl = buildPrintoShopifyMenuUrl(language);

  res.send(`<!DOCTYPE html>
<html lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>\n  <link rel="canonical" href="${escapeHtml(pageUrl)}" />
  <meta property="og:type" content="video.other" />\n  <meta property="og:site_name" content="Printo Greeting Studio" />
  <meta property="og:url" content="${escapeHtml(pageUrl)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="Tap the large Play button to watch, then create your own personalized Printo greeting." />
  ${safeSharePoster ? `<meta property="og:image" content="${safeSharePoster}" /><meta property="og:image:secure_url" content="${safeSharePoster}" /><meta property="og:image:type" content="image/jpeg" /><meta property="og:image:width" content="720" /><meta property="og:image:height" content="1080" /><meta property="og:image:alt" content="Personalized Printo greeting card with play button" />` : ""}
  <meta property="og:video" content="${safeVideo}" />
  <meta property="og:video:secure_url" content="${safeVideo}" />
  <meta property="og:video:type" content="video/mp4" />\n  <meta property="og:video:width" content="1024" />\n  <meta property="og:video:height" content="1536" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="Tap the preview to watch this personalized Printo greeting." />
  ${safeSharePoster ? `<meta name="twitter:image" content="${safeSharePoster}" />` : ""}
  <style>
    *{box-sizing:border-box} body{margin:0;font-family:Arial,sans-serif;background:linear-gradient(180deg,#071b61,#0b63ce);color:#fff;min-height:100vh;padding:22px}
    .wrap{max-width:680px;margin:auto;text-align:center}.brand{font-size:28px;font-weight:900;margin:8px 0}.sub{opacity:.9;margin-bottom:18px}
    .player{position:relative;width:min(100%,680px);aspect-ratio:2/3;margin:0 auto;border:4px solid #ffd21f;border-radius:22px;overflow:hidden;background:#071b61;box-shadow:0 12px 35px rgba(0,0,0,.35)}
    .player video{display:block;width:100%;height:100%;object-fit:contain;object-position:center;background:#071b61}.bigPlay{position:absolute;z-index:10;inset:0;margin:auto;width:190px;height:190px;border-radius:50%;border:9px solid #fff;background:rgba(7,84,184,.88);color:#fff;font-size:98px;line-height:166px;padding-left:16px;cursor:pointer;box-shadow:0 12px 34px rgba(0,0,0,.55)}
    .actions{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:18px}.btn{display:block;padding:14px 10px;border-radius:14px;text-decoration:none;color:#fff;font-weight:900;border:0;font-size:15px;cursor:pointer}.download{background:#7b2cbf}.whatsapp{background:#25D366}.facebook{background:#1877F2}.xshare{background:#000}.copy{background:#334155}.social{background:#d63384}.youtube{background:#ff0000}.tiktok{background:#111}.email{background:#0f766e}.shopify{background:#4f772d}.nigeria{background:#008751}.studioBack{display:inline-block;margin:0 0 18px;padding:12px 20px;border-radius:13px;background:#ffd21f;color:#10245e;text-decoration:none;font-weight:900;box-shadow:0 7px 20px rgba(0,0,0,.24)}.full{grid-column:1/-1}
    .note{font-size:13px;line-height:19px;background:rgba(255,255,255,.12);padding:12px;border-radius:12px;margin-top:14px}.toast{min-height:22px;color:#ffd21f;font-weight:800;margin-top:10px}
    @media(max-width:480px){.actions{grid-template-columns:1fr}.full{grid-column:auto}.bigPlay{width:154px;height:154px;font-size:80px;line-height:132px;border-width:8px}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">🎉 Printo Greeting Studio</div>
    <div class="sub">${toName ? `Created for <strong>${toName}</strong>` : "Your personalized greeting is ready"}${fromName ? ` from <strong>${fromName}</strong>` : ""}</div>
    <a class="studioBack" href="${escapeHtml(studioReturnUrl)}">← Back to Printo Studio</a>
    <div class="player">
      <video id="greetingVideo" playsinline preload="metadata" ${safePoster ? `poster="${safePoster}"` : ""} src="${safeVideo}"></video>
      <button id="bigPlay" class="bigPlay" aria-label="Play greeting">▶</button>
    </div>
    <div id="toast" class="toast"></div>
    <div class="actions">
      <a class="btn download full" href="${escapeHtml(downloadUrl)}">📥 Download Video</a>
      <button class="btn whatsapp" onclick="shareWhatsApp()">📱 WhatsApp</button>
      <button class="btn facebook" onclick="shareFacebook()">📘 Facebook</button>
      <button class="btn xshare" onclick="shareX()">𝕏 X / Twitter</button>
      <button class="btn social" onclick="downloadThenOpen('instagram')">📸 Share Video to Instagram</button>
      <button class="btn youtube" onclick="downloadThenOpen('youtube')">▶ Share Video to YouTube</button>
      <button class="btn tiktok" onclick="downloadThenOpen('tiktok')">🎵 Share Video to TikTok</button>
      <button class="btn email" onclick="shareEmail()">📧 Email</button>
      <button class="btn copy full" onclick="copyLink()">🔗 Copy Short Greeting Link</button>
      <a class="btn social" href="${escapeHtml(studioReturnUrl)}">✨ Create Another</a>
      <a class="btn download" href="/customer-dashboard">⭐ My Videos & Credits</a>
      <a class="btn shopify full" href="/subscriptions">➕ Buy More Credits / Subscribe</a>
      <a class="btn shopify" href="${shopifyUrl}" target="_blank" rel="noopener">🛒 Buy via Shopify</a>
      <a class="btn nigeria" href="${nigeriaUrl}" target="_blank" rel="noopener">🇳🇬 Nigeria Payment</a>
    </div>
    <div class="note">Facebook, WhatsApp and X/Twitter share the short greeting link and preview. Instagram, YouTube and TikTok download the MP4 first; upload the downloaded video in the app and paste the copied short link into the caption or description.</div>
  </div>
<script>
  const video=document.getElementById('greetingVideo'); const play=document.getElementById('bigPlay'); const toast=document.getElementById('toast');
  const pageUrl=${JSON.stringify(pageUrl)}; const videoUrl=${JSON.stringify(videoUrl)};
  const createYourOwnUrl=${JSON.stringify(shopifyMenuUrl)};
  const shareText=${JSON.stringify(`🎉 Watch my personalized Printo greeting!

▶️ Tap the greeting preview above to watch the finished video.

✨ Create your own personalized Printo greeting in Printo Studio:`)};
  const emailText=${JSON.stringify(`🎉 Watch my personalized Printo greeting!\n\nCreate yours with Printo Greeting Studio.\nShopify: ${shopifyUrl}\nNigeria payment: ${nigeriaUrl}`)};
  async function startGreetingPlayback(){
    try{
      video.muted=false;
      await video.play();
      play.style.display='none';
      toast.textContent='';
    }catch(error){
      video.controls=true;
      toast.textContent='Tap the video once more to play.';
    }
  }

  play.addEventListener('click',(event)=>{
    event.preventDefault();
    event.stopPropagation();
    startGreetingPlayback();
  });

  video.addEventListener('click',()=>{
    if(video.paused){
      startGreetingPlayback();
    }else{
      video.pause();
      play.textContent='▶';
      play.style.display='block';
    }
  });

  video.addEventListener('ended',()=>{
    play.textContent='↻';
    play.style.display='block';
  });
  function shareWhatsApp(){
    const whatsappMessage =
      shareText +
      '\\n\\n🎬 Watch this finished greeting:\\n' + pageUrl +
      '\\n\\n🏠 Create your own: Open the PATAPATA Store and tap Printo Studio:\\n' + createYourOwnUrl;
    window.open('https://wa.me/?text='+encodeURIComponent(whatsappMessage),'_blank');
  }
  function shareFacebook(){
    window.open(
      'https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(pageUrl),
      '_blank'
    );
  }

  function shareX(){
    window.open(
      'https://twitter.com/intent/tweet?text='+
      encodeURIComponent(shareText)+
      '&url='+encodeURIComponent(pageUrl),
      '_blank'
    );
  }

  async function downloadThenOpen(platform){
    const platformNames={
      instagram:'Instagram',
      youtube:'YouTube',
      tiktok:'TikTok'
    };
    const platformUrls={
      instagram:'https://www.instagram.com/',
      youtube:'https://www.youtube.com/upload',
      tiktok:'https://www.tiktok.com/upload'
    };

    const platformName=platformNames[platform]||'Social Media';
    const safeRecipient=String(${JSON.stringify(toName)}||'Recipient')
      .replace(/[^a-zA-Z0-9_-]+/g,'_')
      .replace(/^_+|_+$/g,'')
      .slice(0,30);
    const fileName='Printo_Birthday_'+(safeRecipient||'Greeting')+'.mp4';

    try{
      await navigator.clipboard.writeText(
        shareText+'\\n\\n'+pageUrl
      );
    }catch(error){
      // File sharing can continue when clipboard permission is unavailable.
    }

    try{
      const response=await fetch(videoUrl,{cache:'no-store'});
      if(!response.ok) throw new Error('Video download failed');

      const blob=await response.blob();
      const videoFile=new File(
        [blob],
        fileName,
        {type:blob.type||'video/mp4'}
      );

      // On iPhone and supported mobile browsers, this sends the actual
      // personalized MP4 to the system share sheet. The user can select
      // YouTube, Instagram, TikTok, Files, or another installed app.
      if(
        navigator.share &&
        navigator.canShare &&
        navigator.canShare({files:[videoFile]})
      ){
        await navigator.share({
          files:[videoFile],
          title:'My Printo Greeting',
          text:shareText+'\\n\\n'+pageUrl
        });
        return;
      }

      // Desktop and older-browser fallback: download the actual MP4 file.
      const objectUrl=URL.createObjectURL(blob);
      const link=document.createElement('a');
      link.href=objectUrl;
      link.download=fileName;
      link.rel='noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(()=>{
        URL.revokeObjectURL(objectUrl);
        window.open(platformUrls[platform]||pageUrl,'_blank');
      },900);
    }catch(error){
      console.error(platformName+' video sharing failed:',error);

      // Final fallback: open the MP4 itself so the user can save/share it.
      const link=document.createElement('a');
      link.href=videoUrl;
      link.download=fileName;
      link.target='_blank';
      link.rel='noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(()=>{
        window.open(platformUrls[platform]||pageUrl,'_blank');
      },900);
    }
  }

  function shareEmail(){
    location.href='mailto:?subject='+encodeURIComponent('My Printo greeting')+
      '&body='+encodeURIComponent(emailText+'\\n\\n'+pageUrl)
  }

  async function copyLink(){
    try{
      await navigator.clipboard.writeText(pageUrl);
      toast.textContent='Greeting link copied!';
    }catch(e){
      prompt('Copy this link:',pageUrl)
    }
  }
  if(navigator.share){document.querySelector('.copy').textContent='📤 Share / Copy Greeting Link';document.querySelector('.copy').onclick=async()=>{try{await navigator.share({title:'Printo Greeting',text:shareText,url:pageUrl})}catch(e){copyLink()}}}
</script>
</body>
</html>`);
}


app.get("/standard-media/:id/:kind", async (req, res) => {
  try {
    const greetingId = String(req.params.id || "");
    const kind = String(req.params.kind || "video");
    const column = kind === "poster"
      ? "poster_data"
      : kind === "share-poster"
        ? "share_poster_data"
        : "video_data";
    const mimeColumn = kind === "poster"
      ? "poster_mime"
      : kind === "share-poster"
        ? "share_poster_mime"
        : "video_mime";
    const result = await queryWithRetry(
      `SELECT ${column} AS media_data, ${mimeColumn} AS media_mime, file_name,
              recipient_name, status
       FROM standard_greeting_videos
       WHERE greeting_id = $1
       LIMIT 1`,
      [greetingId]
    );
    const row = result.rows[0];
    if (!row || row.status !== "ready" || !row.media_data) {
      return res.status(404).send("Greeting media is unavailable.");
    }
    const downloadName = kind === "video" && String(req.query.download || "") === "1"
      ? `Printo-${String(row.recipient_name || "Greeting").replace(/[^a-zA-Z0-9_-]+/g, "_")}.mp4`
      : "";
    return sendDatabaseBufferWithRange(
      req,
      res,
      row.media_data,
      row.media_mime || (kind === "video" ? "video/mp4" : "image/jpeg"),
      downloadName
    );
  } catch (error) {
    console.error("Standard greeting media route failed:", error);
    return res.status(500).send("Greeting media could not be loaded.");
  }
});

app.get("/download/g/:id", async (req, res) => {
  try {
    const greetingId = String(req.params.id || "");
    const result = await queryWithRetry(
      `SELECT video_data, video_mime, recipient_name, status
       FROM standard_greeting_videos
       WHERE greeting_id = $1
       LIMIT 1`,
      [greetingId]
    );
    const row = result.rows[0];
    if (row && row.status === "ready" && row.video_data) {
      const downloadName = `Printo-${String(row.recipient_name || "Greeting").replace(/[^a-zA-Z0-9_-]+/g,"_")}.mp4`;
      return sendDatabaseBufferWithRange(req, res, row.video_data, row.video_mime || "video/mp4", downloadName);
    }

    // Backward-compatible fallback for a still-existing pre-database local file.
    const metadata = loadGreetingMetadata(greetingId);
    if (!metadata || !metadata.videoUrl) return res.status(404).send("Greeting video is unavailable.");
    const localName = String(metadata.fileName || path.basename(new URL(metadata.videoUrl).pathname || "Printo-Greeting.mp4"));
    const localPath = path.join(generatedDir, path.basename(localName));
    const downloadName = `Printo-${String(metadata.toName || "Greeting").replace(/[^a-zA-Z0-9_-]+/g,"_")}.mp4`;
    res.setHeader("Content-Disposition", `attachment; filename=\"${downloadName}\"`);
    res.setHeader("Content-Type", "video/mp4");
    if (fs.existsSync(localPath)) return res.sendFile(localPath);
    return res.redirect(metadata.videoUrl);
  } catch (error) {
    console.error("Standard greeting download failed:", error);
    return res.status(500).send("Greeting video could not be downloaded.");
  }
});

app.get("/api/customer/account/dashboard", async (req,res)=>{
  try {
    const identity=getGreetingCustomerIdentity(req,{});
    if(identity.identitySource!=="customer_key"){
      return res.status(401).json({ok:false,loginRequired:true,error:"Please log in."});
    }
    const account=await queryWithRetry(`SELECT email, phone_e164, account_type FROM greeting_customer_accounts WHERE customer_key=$1 LIMIT 1`,[identity.customerKey]);
    if(!account.rows[0]) return res.status(401).json({ok:false,loginRequired:true,error:"Please log in."});
    const accountRow=account.rows[0];
    const phone=normalizePrintoPhone(accountRow.phone_e164||"");
    const status=await getGreetingAccessStatus(identity.customerKey,printoPhoneDigits(phone));
    const videos=await listStandardGreetingVideos(identity.customerKey);
    return res.json({ok:true,phone,email:accountRow.account_type==="legacy_email"?accountRow.email:"",...status,videos});
  }catch(error){return res.status(500).json({ok:false,error:error.message});}
});

app.get("/api/customer/dashboard/:customerId", async (req,res)=>{
  try {
    const identity=getGreetingCustomerIdentity(req,{customerId:req.params.customerId,customerPhone:req.query.phone||"",email:req.query.email||""});
    const status=await getGreetingAccessStatus(identity.customerKey,identity.contactPhone);
    const videos=await listStandardGreetingVideos(identity.customerKey);
    res.json({ok:true,...status,videos});
  } catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.get("/api/customer/standard-checkout", async (req, res) => {
  try {
    const customerKey = String(req.headers["x-printo-customer-key"] || "").trim();
    if (!customerKey) {
      return res.status(401).json({ ok: false, loginRequired: true, error: "Please log in first." });
    }

    const account = await queryWithRetry(
      `SELECT email FROM greeting_customer_accounts WHERE customer_key = $1 LIMIT 1`,
      [customerKey]
    );
    if (!account.rows[0]) {
      return res.status(401).json({ ok: false, loginRequired: true, error: "Your login has expired." });
    }

    const payment = buildGreetingPaymentLinks({ customerKey, templateId: "birthday" });
    if (!payment.shopify) {
      return res.status(503).json({
        ok: false,
        error: "The Shopify Standard greeting variant is not configured."
      });
    }

    return res.json({
      ok: true,
      credits: PRINTO_STANDARD_SINGLE_PURCHASE_CREDITS,
      checkoutUrl: payment.shopify
    });
  } catch (error) {
    console.error("Standard Shopify checkout creation failed:", error);
    return res.status(500).json({ ok: false, error: "Could not open Shopify checkout." });
  }
});

app.get("/standard-checkout", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening Shopify Checkout</title><style>body{font-family:Arial;background:#082a8f;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#fff;color:#082a8f;padding:28px;border-radius:18px;max-width:520px;text-align:center}a{color:#082a8f;font-weight:900}</style></head><body><main class="card"><h1>Opening Shopify Checkout…</h1><p id="status">Connecting this $4.99 order to your Printo account for 20 credits.</p><p><a href="/greetings">Return to Printo Studio</a></p></main><script>(async()=>{const key=localStorage.getItem('printoGreetingCustomerKey')||'';if(!key){location.replace('/customer-login?next=%2Fstandard-checkout');return;}try{const r=await fetch('/api/customer/standard-checkout',{cache:'no-store',headers:{'x-printo-customer-key':key}});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Could not open checkout.');location.replace(d.checkoutUrl);}catch(e){document.getElementById('status').textContent=e.message||'Could not open checkout.';}})();</script></body></html>`);
});

app.get("/subscriptions", (req,res)=>res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Printo Plans</title><style>*{box-sizing:border-box}body{margin:0;font-family:Arial;background:linear-gradient(150deg,#071b61,#0b63ce);color:#fff;padding:24px}.wrap{max-width:1180px;margin:auto;text-align:center}.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.close-link{background:#fff;color:#082a8f;text-decoration:none;padding:11px 16px;border-radius:999px;font-weight:900}.section{margin:28px 0 38px}.section-title{font-size:30px;margin:0 0 8px}.section-sub{margin:0 0 18px}.plans{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.plan{background:#fff;color:#082a8f;border:3px solid #ffd21f;border-radius:22px;padding:22px;position:relative}.plan.premium{border-color:#c13cff;box-shadow:0 10px 28px rgba(0,0,0,.18)}.badge{display:inline-block;background:#123faa;color:#fff;border-radius:999px;padding:7px 12px;font-size:13px;font-weight:900;margin-bottom:8px}.premium .badge{background:#7b2cbf}.price{font-size:34px;font-weight:900}.plan a{display:block;background:#7b2cbf;color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:900;margin-top:16px}.standard a{background:#123faa}.best{transform:scale(1.03)}.note{background:#fff4b8;color:#082a8f;border:3px solid #ffd21f;border-radius:18px;padding:16px;margin:0 auto 20px;max-width:820px;font-weight:900}@media(max-width:950px){.plans{grid-template-columns:1fr 1fr}}@media(max-width:560px){body{padding:16px}.plans{grid-template-columns:1fr}.best{transform:none}.topbar{justify-content:center}.section-title{font-size:25px}}</style></head><body><main class="wrap"><div class="topbar"><h1>⭐ Printo Credits & Subscriptions</h1><a class="close-link" href="/greetings">✕ Close / Return to Studio</a></div><div class="note">🎁 Each verified phone number receives 100 FREE credits once — enough for 5 standard creations. Each standard creation uses 20 credits.</div><p>Use one universal Printo credit wallet for Standard, Premium Video, and Premium Multi-Image creations.</p><section class="section"><h2 class="section-title">🎁 Standard Greeting Plans</h2><p class="section-sub">For personalized standard greeting video cards with names, messages, Printo music and voice.</p><div class="plans"><article class="plan standard"><span class="badge">STANDARD</span><h2>Single Creation</h2><div class="price">$4.99</div><p>20 credits • 1 standard creation</p><a href="/standard-checkout">Buy One</a></article><article class="plan standard"><span class="badge">STANDARD</span><h2>Monthly</h2><div class="price">$${PRINTO_STANDARD_SUBSCRIPTION_PRICES.monthly.toFixed(2)}</div><p>100 credits monthly • 5 standard creations</p><a href="${PRINTO_STANDARD_MONTHLY_SUBSCRIPTION_URL}">Choose Standard Monthly</a></article><article class="plan standard"><span class="badge">STANDARD</span><h2>6 Months</h2><div class="price">$${PRINTO_STANDARD_SUBSCRIPTION_PRICES.six_months.toFixed(2)}</div><p>600 credits • 30 standard creations</p><a href="${PRINTO_STANDARD_SIX_MONTH_SUBSCRIPTION_URL}">Choose Standard 6 Months</a></article><article class="plan standard best"><span class="badge">BEST STANDARD VALUE</span><h2>1 Year</h2><div class="price">$${PRINTO_STANDARD_SUBSCRIPTION_PRICES.yearly.toFixed(2)}</div><p>1,200 credits • 60 standard creations</p><a href="${PRINTO_STANDARD_YEARLY_SUBSCRIPTION_URL}">Choose Standard Annual</a></article></div></section><section class="section"><h2 class="section-title">🌟 Premium Subscription Plans</h2><p class="section-sub">For Premium Tribute and enhanced personalized video experiences. Credit costs: Standard 20, Premium Video 25, Premium Multi-Image 50.</p><div class="plans"><article class="plan premium"><span class="badge">PREMIUM</span><h2>Monthly</h2><div class="price">$${PRINTO_SUBSCRIPTION_PRICES.monthly.toFixed(2)}</div><p>100 credits now, then 100 credits each active month</p><a href="${PRINTO_MONTHLY_SUBSCRIPTION_URL}">Choose Premium Monthly</a></article><article class="plan premium"><span class="badge">PREMIUM</span><h2>6 Months</h2><div class="price">$${PRINTO_SUBSCRIPTION_PRICES.six_months.toFixed(2)}</div><p>100 credits monthly for 6 months</p><a href="${PRINTO_SIX_MONTH_SUBSCRIPTION_URL}">Choose Premium 6 Months</a></article><article class="plan premium best"><span class="badge">BEST PREMIUM VALUE</span><h2>1 Year</h2><div class="price">$${PRINTO_SUBSCRIPTION_PRICES.yearly.toFixed(2)}</div><p>100 credits monthly for 12 months</p><a href="${PRINTO_YEARLY_SUBSCRIPTION_URL}">Choose Premium Annual</a></article></div></section><p><a class="close-link" href="/greetings">← Return to Printo Greeting Studio</a></p></main></body></html>`));

app.get("/customer-dashboard", (req,res)=>res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>My Printo Dashboard</title><style>body{font-family:Arial;margin:0;background:#082a8f;color:#fff;padding:20px}.wrap{max-width:900px;margin:auto}.head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.close-link{background:#fff;color:#082a8f;text-decoration:none;padding:11px 16px;border-radius:999px;font-weight:900}.card{background:#fff;color:#082a8f;border-radius:18px;padding:18px;margin:14px 0}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.stat{background:#edf4ff;padding:15px;border-radius:14px;text-align:center}.buttons a{display:inline-block;margin:6px;padding:12px 16px;border-radius:12px;background:#7b2cbf;color:#fff;text-decoration:none;font-weight:bold}.video{border-top:1px solid #ddd;padding:12px 0}@media(max-width:600px){.stats{grid-template-columns:1fr}.head{justify-content:center}}</style></head><body><main class="wrap"><div class="head"><h1>⭐ My Printo Dashboard</h1><a class="close-link" href="/greetings">✕ Close / Return to Studio</a></div><div id="content" class="card">Loading…</div></main><script>let key=localStorage.getItem('printoGreetingCustomerKey')||'';if(!key){window.location.replace('/customer-login?next=%2Fcustomer-dashboard')}else fetch('/api/customer/account/dashboard',{cache:'no-store',headers:{'x-printo-customer-key':key}}).then(r=>r.json()).then(d=>{if(!d.ok)throw Error(d.error);document.getElementById('content').innerHTML='<div style="background:#fff4b8;border:2px solid #ffd21f;border-radius:14px;padding:14px;margin-bottom:14px;font-weight:900">🎁 Welcome Bonus: Each verified phone number receives 100 FREE credits once — enough for 5 standard creations.</div><div class="stats"><div class="stat"><h2>'+d.creditBalance+'</h2>Credits</div><div class="stat"><h2>'+d.remainingCreations+'</h2>Standard Creations Remaining</div><div class="stat"><h2>'+String(d.subscriptionPlan||'Free Welcome')+'</h2>Plan</div></div><div class="buttons"><a href="/birthday?lang=en&template=birthday">'+((Number(d.totalGenerated||0)>0||d.videos.length)?'Create Another Greeting':'Create Your First Greeting')+'</a><a href="/subscriptions">Buy Credits / Subscribe</a><a href="/greetings">✕ Close / Return to Studio</a></div><h2>My Finished Videos</h2>'+(d.videos.length?d.videos.map(v=>'<div class="video"><strong>For '+(v.toName||'Recipient')+'</strong><br><a href="'+v.resultUrl+'">▶ Play</a> &nbsp; <a href="'+v.downloadUrl+'">⬇ Download</a></div>').join(''):((Number(d.totalGenerated||0)>0)?'<p>Your earlier creation record is saved, but its old temporary video file is no longer available. New finished videos will remain here after deployments and restarts.</p>':'<p>🎉 You have not created your first greeting yet. Click <strong>Create Your First Greeting</strong> to surprise someone special.</p>'))}).catch(e=>{localStorage.removeItem('printoGreetingCustomerKey');window.location.replace('/customer-login?next=%2Fcustomer-dashboard')})</script></body></html>`));

app.get("/g/:id", async (req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60, must-revalidate");
  try {
    const greetingId = String(req.params.id || "");
    const row = await getStandardGreetingMetadata(greetingId);
    if (row && row.status === "ready" && row.has_video) {
      const publicBase = String(getConfiguredPublicOrigin(req)).replace(/\/$/, "");
      const videoUrl = `${publicBase}/standard-media/${encodeURIComponent(greetingId)}/video`;
      const posterUrl = row.has_poster
        ? `${publicBase}/standard-media/${encodeURIComponent(greetingId)}/poster`
        : `${publicBase}/greeting-assets/birthday-v2.png`;
      const sharePosterUrl = row.has_share_poster
        ? `${publicBase}/standard-media/${encodeURIComponent(greetingId)}/share-poster`
        : posterUrl;
      req.query = {
        video: videoUrl,
        poster: posterUrl,
        sharePoster: sharePosterUrl,
        to: row.recipient_name || "",
        from: row.sender_name || "",
        lang: row.language || "en",
        download: `/download/g/${encodeURIComponent(greetingId)}`,
        customerKey: row.customer_key || "",
        greetingId
      };
      return renderGreetingResult(req, res);
    }

    // Backward compatibility while any pre-database local metadata still exists.
    const metadata = loadGreetingMetadata(greetingId);
    if (!metadata || !metadata.videoUrl) {
      return res.status(404).send("This Printo greeting link is unavailable or has expired.");
    }
    req.query = {
      video: metadata.videoUrl,
      poster: metadata.posterUrl || "",
      sharePoster: metadata.sharePosterUrl || metadata.posterUrl || "",
      to: metadata.toName || "",
      from: metadata.fromName || "",
      lang: metadata.language || "en",
      download: `/download/g/${encodeURIComponent(greetingId)}`,
      customerKey: metadata.customerKey || "",
      greetingId
    };
    return renderGreetingResult(req, res);
  } catch (error) {
    console.error("Greeting result lookup failed:", error);
    return res.status(500).send("This Printo greeting could not be loaded.");
  }
});

app.get("/greeting-result", renderGreetingResult);

app.get("/greeting-test", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Printo Birthday Generator Test</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: Arial; max-width: 600px; margin: 30px auto; padding: 20px; }
    input, textarea, button { width: 100%; box-sizing: border-box; padding: 12px; margin: 8px 0; font-size: 16px; }
    button { background: #6c2bd9; color: white; border: 0; border-radius: 8px; cursor: pointer; }
    a { display: block; margin-top: 20px; font-size: 18px; }
    .field { margin-bottom: 12px; }
    .counter { text-align: right; font-size: 13px; color: #666; margin-top: -4px; }
    .counter.limit { color: #b42318; font-weight: bold; }
  </style>
</head>
<body>
  <h1>🎂 Printo Birthday Generator</h1>

  <div class="field">
    <input id="to" maxlength="${BIRTHDAY_NAME_MAX}" placeholder="Recipient name e.g. Mary" />
    <div id="toCount" class="counter">0 / ${BIRTHDAY_NAME_MAX}</div>
  </div>

  <div class="field">
    <input id="from" maxlength="${BIRTHDAY_NAME_MAX}" placeholder="Sender name e.g. John" />
    <div id="fromCount" class="counter">0 / ${BIRTHDAY_NAME_MAX}</div>
  </div>

  <div class="field">
    <textarea id="message" maxlength="${BIRTHDAY_MESSAGE_MAX}" rows="4" placeholder="Birthday message">Wishing you happiness, laughter, and a wonderful celebration!</textarea>
    <div id="messageCount" class="counter">0 / ${BIRTHDAY_MESSAGE_MAX}</div>
  </div>

  <button onclick="generate()">Generate Birthday Video</button>

  <p id="status"></p>
  <div id="result"></div>

<script>
function setupCounter(inputId, counterId, maxLength) {
  const input = document.getElementById(inputId);
  const counter = document.getElementById(counterId);

  function updateCounter() {
    const count = input.value.length;
    counter.innerText = count + " / " + maxLength;
    counter.classList.toggle("limit", count >= maxLength);
  }

  input.addEventListener("input", updateCounter);
  updateCounter();
}

setupCounter("to", "toCount", ${BIRTHDAY_NAME_MAX});
setupCounter("from", "fromCount", ${BIRTHDAY_NAME_MAX});
setupCounter("message", "messageCount", ${BIRTHDAY_MESSAGE_MAX});

let printoGreetingCustomerId = localStorage.getItem("printoGreetingCustomerId");
let printoGreetingCustomerKey = localStorage.getItem("printoGreetingCustomerKey") || "";
if (!printoGreetingCustomerId) {
  printoGreetingCustomerId =
    (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : "pg-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  localStorage.setItem("printoGreetingCustomerId", printoGreetingCustomerId);
}

async function generate() {
  document.getElementById("status").innerText = "Generating video... please wait.";
  document.getElementById("result").innerHTML = "";

  const res = await fetch("/api/greeting/birthday/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-printo-customer-id": printoGreetingCustomerId,
      ...(printoGreetingCustomerKey ? { "x-printo-customer-key": printoGreetingCustomerKey } : {})
    },
    body: JSON.stringify({
      to: document.getElementById("to").value || "Mary",
      from: document.getElementById("from").value || "John",
      message: document.getElementById("message").value,
      customerId: printoGreetingCustomerId,
      customerKey: printoGreetingCustomerKey
    })
  });

  const data = await res.json();

  if (data.paymentRequired) {
    document.getElementById("status").innerText =
      "Payment required before another greeting can be generated.";
    document.getElementById("result").innerHTML =
      '<a href="' + data.payment.shopify + '" target="_blank">🛒 Shopify Payment</a><br><br>' +
      '<a href="' + data.payment.africa + '" target="_blank">🌍 Africa Payment</a>';
    return;
  }

  if (!data.ok) {
    document.getElementById("status").innerText = "Failed: " + (data.error || "Unknown error");
    return;
  }
  if (data.customerKey) {
    printoGreetingCustomerKey = String(data.customerKey);
    localStorage.setItem("printoGreetingCustomerKey", printoGreetingCustomerKey);
  }

  document.getElementById("status").innerText = "Video ready! Credits remaining: " + String(data.access?.creditBalance ?? data.access?.paidCreditsRemaining ?? "");
  document.getElementById("result").innerHTML =
    '<a href="' + (data.resultUrl || data.downloadUrl) + '" target="_blank">▶ Open, Play, Share & Download Birthday Video</a>';
}
</script>
</body>
</html>`);
});
function startServer() {
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });

  // Start database upgrades only after the web port is open.
  // A slow database migration must never prevent Render from detecting the service.
  setImmediate(async () => {
    try {
      await ensureGreetingAccessTables();
      await refundInterruptedStandardGreetingGenerations();
      await syncPremiumDashboardProductionStatus();
      await releaseDuePrintoMembershipCredits();

      console.log(
        "Greeting access tables, memberships, and Premium dashboard status are ready."
      );
    } catch (error) {
      console.error(
        "Background database setup failed. The website remains online, but greeting generation stays protected until the database is available:",
        error?.message || error
      );
    }
  });

  setInterval(() => {
    releaseDuePrintoMembershipCredits().catch((error) =>
      console.error(
        "Monthly Printo credit release failed:",
        error?.message || error
      )
    );
  }, 60 * 60 * 1000).unref();

  return server;
}

startServer();
