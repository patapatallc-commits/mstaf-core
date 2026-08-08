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
const PREMIUM_INTRO_AUDIO_MAX_BYTES = 30 * 1024 * 1024;
const PREMIUM_VIDEO_STORED_MAX_BYTES = 40 * 1024 * 1024;
const PREMIUM_INTRO_AUDIO_STORED_MAX_BYTES = 12 * 1024 * 1024;
const PREMIUM_VIDEO_MAX_SECONDS = 60;
const PREMIUM_MUSIC_MAX_BYTES = 30 * 1024 * 1024;
const PREMIUM_FINAL_VIDEO_MAX_BYTES = 70 * 1024 * 1024;
const PREMIUM_MULTI_IMAGE_MIN_COUNT = 2;
const PREMIUM_MULTI_IMAGE_MAX_COUNT = 8;

// Printo Studio uses one universal credit wallet for every creation service.
// Each verified phone number receives 100 welcome credits only once.
const PRINTO_FREE_CREDITS = 100;
const PRINTO_MONTHLY_CREDIT_ALLOCATION = 100;
const PRINTO_CREATION_CREDIT_COSTS = Object.freeze({
  standard: 20,
  premium_video: 25,
  premium_multi_image: 50,
  // Watch & Buy reuses the Premium Multi-Image rendering engine.
  watch_buy: 50
});
const PRINTO_CREATION_CREDIT_COST = PRINTO_CREATION_CREDIT_COSTS.standard;
const PRINTO_MULTI_IMAGE_PRICE_USD = 14.99;
const PRINTO_MULTI_IMAGE_FREE_TRIAL_VALUE_CREDITS =
  PRINTO_CREATION_CREDIT_COSTS.premium_multi_image;
const PRINTO_MULTI_IMAGE_SINGLE_PURCHASE_CREDITS =
  PRINTO_CREATION_CREDIT_COSTS.premium_multi_image;

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
  if (["watch_buy", "watchbuy", "watch_and_buy", "premium_watch_buy"].includes(normalized)) {
    return "watch_buy";
  }
  return "standard";
}

function isPrintoMultiImageCreationType(value = "") {
  const normalized = normalizePrintoCreationType(value);
  return normalized === "premium_multi_image" || normalized === "watch_buy";
}

function isPrintoWatchBuyCreationType(value = "") {
  return normalizePrintoCreationType(value) === "watch_buy";
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
    files: PREMIUM_MULTI_IMAGE_MAX_COUNT + 1,
    fields: 30
  },
  fileFilter: (_req, file, cb) => {
    const fieldName = String(file.fieldname || "");
    const mime = String(file.mimetype || "").toLowerCase();

    if (["recipientPhoto", "recipientImages"].includes(fieldName) && !mime.startsWith("image/")) {
      return cb(new Error("Every Premium recipient file must be an image."));
    }

    if (fieldName === "introVideo" && !mime.startsWith("video/")) {
      return cb(new Error("The personal introduction video must be a video file."));
    }

    if (fieldName === "introAudio") {
      const ext = path.extname(String(file.originalname || "")).toLowerCase();
      const allowedAudioExtensions = new Set([
        ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".webm", ".flac"
      ]);
      const audioMimeAccepted =
        mime.startsWith("audio/") ||
        mime === "video/webm" ||
        mime === "application/octet-stream";
      if (!audioMimeAccepted && !allowedAudioExtensions.has(ext)) {
        return cb(new Error(
          "The voice introduction must be an MP3, WAV, M4A, AAC, OGG, OPUS, WebM, or FLAC audio file."
        ));
      }
    }

    if (!["recipientPhoto", "recipientImages", "introVideo", "introAudio"].includes(fieldName)) {
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


const PRINTO_STUDIO_SUPPORTED_LANGUAGES = Object.freeze(["en", "es", "fr", "de", "pt", "ar", "zh"]);
const PRINTO_STUDIO_LANGUAGE_NAMES = Object.freeze({
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  ar: "العربية",
  zh: "中文"
});
const PRINTO_STUDIO_CLIENT_TRANSLATIONS = Object.freeze({"es":{"Language":"Idioma","Printo Account":"Cuenta Printo","Use one verified WhatsApp phone number for one Printo account.":"Use un número de WhatsApp verificado para cada cuenta Printo.","A verified phone number receives the 100 welcome credits only once. Invented email addresses can no longer create free-credit accounts.":"Un número verificado recibe los 100 créditos de bienvenida una sola vez. Los correos inventados ya no pueden crear cuentas gratuitas.","Create Account":"Crear cuenta","Log In":"Iniciar sesión","WhatsApp Phone Number":"Número de WhatsApp","Include the country code. The number must be connected to WhatsApp.":"Incluya el código de país. El número debe estar conectado a WhatsApp.","Verify Number with WhatsApp":"Verificar número con WhatsApp","Tap the button, send the prepared message in WhatsApp, then return here.":"Pulse el botón, envíe el mensaje preparado en WhatsApp y vuelva aquí.","Open WhatsApp verification":"Abrir verificación de WhatsApp","Existing Email Address":"Correo electrónico existente","Only for an account created before phone verification was introduced.":"Solo para una cuenta creada antes de la verificación telefónica.","PIN Number":"Número PIN","Create Account & Receive 100 Credits":"Crear cuenta y recibir 100 créditos","Existing old email account? Log in here":"¿Tiene una cuenta antigua con correo? Inicie sesión aquí","Use phone-number login instead":"Usar inicio de sesión con teléfono","Log In to My Account":"Iniciar sesión en mi cuenta","Preparing WhatsApp verification...":"Preparando la verificación de WhatsApp...","WhatsApp is opening. Send the prepared PRINTO VERIFY message, then return to this page.":"WhatsApp se está abriendo. Envíe el mensaje PRINTO VERIFY preparado y vuelva a esta página.","Phone number verified. Choose your PIN and create the account.":"Número verificado. Elija su PIN y cree la cuenta.","Verification expired. Tap Verify Number with WhatsApp again.":"La verificación venció. Pulse nuevamente Verificar número con WhatsApp.","Verify your WhatsApp phone number first.":"Primero verifique su número de WhatsApp.","Creating your verified account...":"Creando su cuenta verificada...","Logging in...":"Iniciando sesión...","Success. Opening Printo Studio...":"Listo. Abriendo Printo Studio...","Return to Printo Studio":"Volver a Printo Studio","Close / Return to Studio":"Cerrar / Volver al estudio","My Videos":"Mis videos","Buy Credits / Subscribe":"Comprar créditos / Suscribirse","Printo Sample":"Muestra de Printo","PREMIUM EXPERIENCE":"EXPERIENCIA PREMIUM","Personal Tribute Music Video Card":"Tarjeta musical de homenaje personal","Create a powerful personal tribute using the recipient photo, your personal introduction video, an original tribute song, names and a heartfelt message.":"Cree un homenaje personal con la foto del destinatario, su video de presentación, una canción original, nombres y un mensaje sincero.","Recipient photo on screen":"Foto del destinatario en pantalla","Personal introduction video":"Video de presentación personal","Original tribute song":"Canción original de homenaje","Recipient and sender names":"Nombres del destinatario y remitente","Personal message":"Mensaje personal","Downloadable finished video":"Video final descargable","A beautiful Printo video greeting":"Un hermoso saludo en video de Printo","RECIPIENT PHOTO":"FOTO DEL DESTINATARIO","Your special person":"Su persona especial","Personal Tribute":"Homenaje personal","Music Video Card":"Tarjeta de video musical","Personal introduction • Photo • Original song":"Presentación personal • Foto • Canción original","Worker will discuss with me":"El trabajador lo hablará conmigo","Soft acoustic":"Acústico suave","Other":"Otro","JPG, PNG or WebP. Clear portrait preferred.":"JPG, PNG o WebP. Se recomienda un retrato claro.","Maximum 60 seconds and 100 MB. Large files are compressed automatically to a smaller 720p MP4 before permanent storage.":"Máximo 60 segundos y 100 MB. Los archivos grandes se comprimen automáticamente a MP4 de 720p antes del almacenamiento permanente.","Terms of Use, Privacy Policy and Refund Policy":"Términos de uso, Política de privacidad y Política de reembolso","Please confirm permission and accept the Terms, Privacy and Refund Policy.":"Confirme el permiso y acepte los Términos, la Privacidad y la Política de reembolso.","Recipient photo must be 10 MB or smaller.":"La foto debe pesar 10 MB o menos.","Introduction video must be 100 MB or smaller.":"El video debe pesar 100 MB o menos.","Introduction video must be 60 seconds or shorter.":"El video debe durar 60 segundos o menos.","Uploading and compressing your introduction video…":"Subiendo y comprimiendo su video de presentación…","Introduction video compressed and stored safely.":"El video fue comprimido y guardado de forma segura.","Could not save premium order.":"No se pudo guardar el pedido Premium.","The introduction video could not be read.":"No se pudo leer el video de presentación.","Order":"Pedido","Printo Credits & Subscriptions":"Créditos y suscripciones de Printo","Each verified phone number receives 100 FREE credits once — enough for 5 standard creations. Each standard creation uses 20 credits.":"Cada número verificado recibe una vez 100 créditos GRATIS, suficientes para 5 creaciones estándar. Cada creación usa 20 créditos.","Use one universal Printo credit wallet for Standard, Premium Video, and Premium Multi-Image creations.":"Use una sola cartera universal de créditos para Estándar, Video Premium y Multiimagen Premium.","Standard Greeting Plans":"Planes de saludos estándar","For personalized standard greeting video cards with names, messages, Printo music and voice.":"Para tarjetas estándar personalizadas con nombres, mensajes, música y voz Printo.","STANDARD":"ESTÁNDAR","Single Creation":"Creación individual","20 credits • 1 standard creation":"20 créditos • 1 creación estándar","Buy One":"Comprar una","Monthly":"Mensual","100 credits monthly • 5 standard creations":"100 créditos al mes • 5 creaciones estándar","Choose Standard Monthly":"Elegir Estándar mensual","6 Months":"6 meses","600 credits • 30 standard creations":"600 créditos • 30 creaciones estándar","Choose Standard 6 Months":"Elegir Estándar por 6 meses","BEST STANDARD VALUE":"MEJOR VALOR ESTÁNDAR","1 Year":"1 año","1,200 credits • 60 standard creations":"1.200 créditos • 60 creaciones estándar","Choose Standard Annual":"Elegir Estándar anual","Premium Subscription Plans":"Planes de suscripción Premium","For Premium Tribute and enhanced personalized video experiences. Credit costs: Standard 20, Premium Video 25, Premium Multi-Image 50.":"Para homenajes Premium y videos personalizados. Costos: Estándar 20, Video Premium 25, Multiimagen Premium 50.","PREMIUM":"PREMIUM","100 credits now, then 100 credits each active month":"100 créditos ahora y luego 100 cada mes activo","Choose Premium Monthly":"Elegir Premium mensual","100 credits monthly for 6 months":"100 créditos al mes durante 6 meses","Choose Premium 6 Months":"Elegir Premium por 6 meses","BEST PREMIUM VALUE":"MEJOR VALOR PREMIUM","100 credits monthly for 12 months":"100 créditos al mes durante 12 meses","Choose Premium Annual":"Elegir Premium anual","My Printo Dashboard":"Mi panel de Printo","Welcome Bonus: Each verified phone number receives 100 FREE credits once — enough for 5 standard creations.":"Bono de bienvenida: cada número verificado recibe una vez 100 créditos GRATIS, suficientes para 5 creaciones estándar.","Credits":"Créditos","Standard Creations Remaining":"Creaciones estándar restantes","Plan":"Plan","Free Welcome":"Bienvenida gratuita","Create Another Greeting":"Crear otro saludo","Create Your First Greeting":"Crear su primer saludo","My Finished Videos":"Mis videos terminados","Recipient":"Destinatario","Play":"Reproducir","Download":"Descargar","Your earlier creation record is saved, but its old temporary video file is no longer available. New finished videos will remain here after deployments and restarts.":"El registro anterior está guardado, pero el archivo temporal antiguo ya no está disponible. Los nuevos videos permanecerán después de despliegues y reinicios.","You have not created your first greeting yet. Click Create Your First Greeting to surprise someone special.":"Aún no ha creado su primer saludo. Pulse Crear su primer saludo para sorprender a alguien especial.","Back to Printo Studio":"Volver a Printo Studio","Share Video to YouTube":"Compartir video en YouTube","Create Another":"Crear otro","Buy More Credits / Subscribe":"Comprar más créditos / Suscribirse","My Videos & Credits":"Mis videos y créditos","Nigeria Payment":"Pago en Nigeria","Printo Greeting Studio":"Estudio de saludos Printo","Share Video to TikTok":"Compartir video en TikTok","Download Video":"Descargar video","Email":"Correo electrónico","Share Video to Instagram":"Compartir video en Instagram","Copy Short Greeting Link":"Copiar enlace corto del saludo","Buy via Shopify":"Comprar por Shopify","Your personalized greeting is ready":"Su saludo personalizado está listo","Created for":"Creado para","from":"de","Facebook, WhatsApp and X/Twitter share the short greeting link and preview. Instagram, YouTube and TikTok download the MP4 first; upload the downloaded video in the app and paste the copied short link into the caption or description.":"Facebook, WhatsApp y X/Twitter comparten el enlace corto y la vista previa. Instagram, YouTube y TikTok descargan primero el MP4; suba el video y pegue el enlace corto en el texto o la descripción.","Please read these rules before uploading photos, videos, voices, names, messages, music instructions, documents, logos, or other content to Printto Studio.":"Lea estas reglas antes de subir fotos, videos, voces, nombres, mensajes, instrucciones musicales, documentos, logotipos u otro contenido a Printo Studio.","1. Your Content and Permission":"1. Su contenido y permiso","You confirm that you own, created, licensed, or received clear permission to use every photograph, video, voice recording, name, message, logo, song, document, or other material you upload.":"Confirma que posee, creó, obtuvo licencia o recibió permiso claro para usar cada foto, video, voz, nombre, mensaje, logotipo, canción, documento u otro material.","Do not upload or generate content using another person’s image, video, voice, likeness, or private information without that person’s authorization.":"No suba ni genere contenido usando la imagen, video, voz, apariencia o información privada de otra persona sin autorización.","2. User Responsibility":"2. Responsabilidad del usuario","3. Prohibited Content":"3. Contenido prohibido","4. Privacy and Uploaded Files":"4. Privacidad y archivos subidos","5. AI and Creative Output":"5. IA y resultados creativos","6. Credits and Memberships":"6. Créditos y membresías","7. Final Sale and No-Return Policy":"7. Venta final y sin devoluciones","8. Technical Generation Problems":"8. Problemas técnicos de generación","9. Limitation of Responsibility":"9. Limitación de responsabilidad","10. Policy Enforcement and Updates":"10. Aplicación y actualizaciones","All Rights Reserved.":"Todos los derechos reservados.","You are solely responsible for your uploads and the instructions you provide. PATAPATA LLC does not authorize impersonation, harassment, defamation, copyright infringement, privacy violations, misleading endorsements, or unlawful use of another person’s identity.":"Usted es el único responsable de sus archivos e instrucciones. PATAPATA LLC no autoriza suplantación, acoso, difamación, infracción de derechos de autor, violaciones de privacidad, respaldos engañosos ni uso ilegal de la identidad ajena.","PATAPATA LLC may reject, suspend, remove, or report content or accounts that appear illegal, abusive, deceptive, unsafe, or unauthorized.":"PATAPATA LLC puede rechazar, suspender, eliminar o denunciar contenido o cuentas que parezcan ilegales, abusivos, engañosos, inseguros o no autorizados.","Content involving exploitation, threats, hate, harassment, violence, or illegal activity.":"Contenido que implique explotación, amenazas, odio, acoso, violencia o actividad ilegal.","Sexually explicit content or content that exploits or endangers minors.":"Contenido sexualmente explícito o que explote o ponga en peligro a menores.","Unauthorized copyrighted material, trademarks, private records, or confidential information.":"Material protegido, marcas, registros privados o información confidencial sin autorización.","False impersonation, fraud, scams, or content intended to deceive the public.":"Suplantación falsa, fraude, estafas o contenido destinado a engañar al público.","Names, contact details, photos, videos, messages, and other uploaded files may be processed and temporarily stored to create the requested service, operate customer accounts, prevent abuse, complete payments, troubleshoot failures, and provide support.":"Los nombres, datos de contacto, fotos, videos, mensajes y otros archivos pueden procesarse y almacenarse temporalmente para crear el servicio, administrar cuentas, prevenir abusos, completar pagos, resolver fallos y ofrecer soporte.","PATAPATA LLC does not sell customer personal information. Customers should avoid uploading unnecessary sensitive information.":"PATAPATA LLC no vende información personal de clientes. Evite subir información sensible innecesaria.","AI-generated or automatically assembled results may contain variations. You must review names, spelling, messages, photos, video selections, and instructions before submitting. Minor creative differences that do not prevent delivery are not generation failures.":"Los resultados generados por IA o ensamblados automáticamente pueden variar. Revise nombres, ortografía, mensajes, fotos, videos e instrucciones antes de enviar. Las pequeñas diferencias creativas que no impidan la entrega no son fallos.","Credits are deducted when a generation or eligible service begins. Membership credits are released according to the selected plan. Prices, credit costs, available features, and processing times may be updated for future purchases.":"Los créditos se descuentan cuando comienza una generación o servicio elegible. Los créditos de membresía se liberan según el plan. Los precios, costos, funciones y tiempos pueden actualizarse para compras futuras.","Because each video is custom-generated using customer-provided information and computing resources, a successfully generated video is final and non-returnable. No refund is provided after successful generation merely because the customer changes their mind, dislikes a creative preference, or supplied incorrect information.":"Como cada video se genera a medida con información del cliente y recursos informáticos, un video generado correctamente es final y no retornable. No hay reembolso por cambio de opinión, preferencia creativa o datos incorrectos del cliente.","If a verified technical problem caused the generation not to work, produced no usable video, or prevented delivery, contact a Printto Support Agent promptly. After reviewing the issue, PATAPATA LLC may fix and regenerate the video, restore the affected credits, or provide another appropriate resolution.":"Si un problema técnico verificado impidió la generación, no produjo un video utilizable o evitó la entrega, contacte pronto al soporte Printo. PATAPATA LLC puede corregir y regenerar, restaurar créditos u ofrecer otra solución.","A refund, when legally required or approved by PATAPATA LLC, is considered only after support has had a reasonable opportunity to investigate and correct the technical problem.":"Un reembolso, cuando sea legalmente obligatorio o aprobado, se considera solo después de que soporte haya tenido oportunidad razonable de investigar y corregir el problema.","To the extent permitted by law, PATAPATA LLC is not responsible for claims, losses, or disputes caused by unauthorized uploads, customer mistakes, infringement by a user, third-party platforms, internet interruptions, or circumstances outside our reasonable control.":"En la medida permitida por la ley, PATAPATA LLC no responde por reclamaciones, pérdidas o disputas causadas por archivos no autorizados, errores del cliente, infracciones, plataformas externas, interrupciones de internet o circunstancias fuera de control.","We may refuse service or restrict access when necessary to protect people, intellectual property, privacy, platform security, or legal compliance. Updated terms apply to future use after they are posted on this page.":"Podemos rechazar el servicio o restringir el acceso para proteger a las personas, la propiedad intelectual, la privacidad, la seguridad o el cumplimiento legal. Los términos actualizados se aplican al uso futuro tras publicarse.","For a failed generation or another service problem, use the Worker Help or Support Agent option in Printto Studio before requesting a refund.":"Ante una generación fallida u otro problema, use Ayuda del trabajador o Agente de soporte en Printo Studio antes de solicitar un reembolso.","4–8 numbers":"4–8 números","Could not check verification.":"No se pudo comprobar la verificación.","Could not start verification.":"No se pudo iniciar la verificación.","Account request failed":"La solicitud de cuenta falló","First verified-account test FREE • Then 50 credits or $14.99":"Primera prueba GRATIS para cuentas verificadas • Después, 50 créditos o $14.99","Premium Multi-Image Flip Tribute":"Homenaje Premium con cambio de varias imágenes","Upload 2–8 recipient photos. After the personal introduction ends, the images flip one after another while the custom tribute music plays.":"Suba de 2 a 8 fotos del destinatario. Cuando termine la presentación personal, las imágenes cambiarán una tras otra mientras suena la música personalizada.","2–8 recipient photos":"De 2 a 8 fotos del destinatario","Flip-style image transitions":"Transiciones de imágenes estilo giro","Custom tribute music":"Música personalizada de homenaje","First verified-account test is FREE":"La primera prueba de una cuenta verificada es GRATIS","After the free test: 50 credits or $14.99":"Después de la prueba gratuita: 50 créditos o $14.99","Share and download page":"Página para compartir y descargar","Create Multi-Image Flip":"Crear video con varias imágenes","Premium Creation Prices & Subscription Plans":"Precios de creaciones Premium y planes de suscripción","Each Premium service has its own separate creation price in the universal Printo credit wallet.":"Cada servicio Premium tiene su propio precio de creación dentro de la cartera universal de créditos Printo.","PREMIUM VIDEO":"VIDEO PREMIUM","Personal Tribute Video":"Video de homenaje personal","25 Credits":"25 créditos","1 recipient photo • introduction video • custom music":"1 foto del destinatario • video de presentación • música personalizada","Create Premium Video":"Crear video Premium","MULTI-IMAGE FLIP":"CAMBIO DE VARIAS IMÁGENES","Premium Multi-Image":"Multiimagen Premium","First verified-account test FREE • then 50 credits • 2–8 photos • flip transitions • introduction • custom music":"Primera prueba GRATIS para cuentas verificadas • después 50 créditos • 2–8 fotos • transiciones • presentación • música personalizada","Use Free Test / Create":"Usar prueba gratis / Crear","Buy 50 Credits":"Comprar 50 créditos","Each verified phone number receives 100 FREE universal credits once, plus one FREE Multi-Image Flip test worth 50 credits. After the free Multi-Image test, each Multi-Image creation costs 50 credits or $14.99.":"Cada número verificado recibe una vez 100 créditos universales GRATIS, más una prueba GRATIS de Multiimagen valorada en 50 créditos. Después, cada creación cuesta 50 créditos o $14.99.","Welcome Bonus: 100 FREE universal credits plus one FREE Multi-Image Flip test worth 50 credits for each verified phone account.":"Bono de bienvenida: 100 créditos universales GRATIS más una prueba GRATIS de Multiimagen valorada en 50 créditos para cada cuenta telefónica verificada.","Free Multi-Image Test":"Prueba gratis de Multiimagen","Available":"Disponible","Used":"Utilizada","Premium Multi-Image Flip Video":"Video Premium con varias imágenes","Premium video is not ready yet.":"El video Premium todavía no está listo.","Return to My Videos and try again after rendering is complete.":"Vuelva a Mis videos e inténtelo de nuevo cuando termine el procesamiento.","A personalized Printo Premium tribute video.":"Un video Premium personalizado de homenaje Printo.","Facebook, WhatsApp and X share the Premium result page. Instagram, YouTube and TikTok use your phone’s share sheet when available; otherwise the MP4 downloads first for upload.":"Facebook, WhatsApp y X comparten la página del resultado Premium. Instagram, YouTube y TikTok usan el menú para compartir del teléfono; si no está disponible, primero se descarga el MP4.","Premium video link copied.":"Enlace del video Premium copiado.","Payment is required.":"Se requiere pago.","FREE TEST — 0 credits deducted":"PRUEBA GRATIS — se descontaron 0 créditos","Each recipient image must be 10 MB or smaller.":"Cada imagen del destinatario debe pesar 10 MB o menos.","Personal video or voice introduction":"Introducción personal en video o voz","Choose Video or Voice Introduction":"Elija introducción en video o voz","Video Introduction":"Introducción en video","Voice Introduction":"Introducción de voz","Record Voice":"Grabar voz","Start Recording":"Iniciar grabación","Stop Recording":"Detener grabación","Play Recording":"Reproducir grabación","Record Again":"Grabar de nuevo","Upload Existing Audio":"Subir audio existente","Record in a quiet place and speak clearly. Printo will reduce background noise automatically.":"Grabe en un lugar tranquilo y hable con claridad. Printo reducirá automáticamente el ruido de fondo.","Personal introduction video or voice recording":"Video de presentación personal o grabación de voz","Create a powerful personal tribute using the recipient photo, your personal introduction video or voice recording, an original tribute song, names and a heartfelt message.":"Cree un homenaje personal con la foto del destinatario, su video de presentación o grabación de voz, una canción original, nombres y un mensaje sincero."},"fr":{"Language":"Langue","Printo Account":"Compte Printo","Use one verified WhatsApp phone number for one Printo account.":"Utilisez un numéro WhatsApp vérifié pour chaque compte Printo.","A verified phone number receives the 100 welcome credits only once. Invented email addresses can no longer create free-credit accounts.":"Un numéro vérifié reçoit les 100 crédits de bienvenue une seule fois. Les e-mails inventés ne peuvent plus créer de comptes gratuits.","Create Account":"Créer un compte","Log In":"Se connecter","WhatsApp Phone Number":"Numéro WhatsApp","Include the country code. The number must be connected to WhatsApp.":"Incluez l’indicatif du pays. Le numéro doit être connecté à WhatsApp.","Verify Number with WhatsApp":"Vérifier le numéro avec WhatsApp","Tap the button, send the prepared message in WhatsApp, then return here.":"Appuyez sur le bouton, envoyez le message préparé dans WhatsApp, puis revenez ici.","Open WhatsApp verification":"Ouvrir la vérification WhatsApp","Existing Email Address":"Adresse e-mail existante","Only for an account created before phone verification was introduced.":"Uniquement pour un compte créé avant la vérification téléphonique.","PIN Number":"Code PIN","Create Account & Receive 100 Credits":"Créer le compte et recevoir 100 crédits","Existing old email account? Log in here":"Ancien compte e-mail ? Connectez-vous ici","Use phone-number login instead":"Utiliser plutôt le numéro de téléphone","Log In to My Account":"Me connecter à mon compte","Preparing WhatsApp verification...":"Préparation de la vérification WhatsApp...","WhatsApp is opening. Send the prepared PRINTO VERIFY message, then return to this page.":"WhatsApp s’ouvre. Envoyez le message PRINTO VERIFY préparé, puis revenez sur cette page.","Phone number verified. Choose your PIN and create the account.":"Numéro vérifié. Choisissez votre PIN et créez le compte.","Verification expired. Tap Verify Number with WhatsApp again.":"La vérification a expiré. Appuyez de nouveau sur Vérifier le numéro avec WhatsApp.","Verify your WhatsApp phone number first.":"Vérifiez d’abord votre numéro WhatsApp.","Creating your verified account...":"Création de votre compte vérifié...","Logging in...":"Connexion...","Success. Opening Printo Studio...":"Réussi. Ouverture de Printo Studio...","Return to Printo Studio":"Retour à Printo Studio","Close / Return to Studio":"Fermer / Retour au studio","My Videos":"Mes vidéos","Buy Credits / Subscribe":"Acheter des crédits / S’abonner","Printo Sample":"Exemple Printo","PREMIUM EXPERIENCE":"EXPÉRIENCE PREMIUM","Personal Tribute Music Video Card":"Carte vidéo musicale d’hommage personnel","Create a powerful personal tribute using the recipient photo, your personal introduction video, an original tribute song, names and a heartfelt message.":"Créez un hommage personnel avec la photo du destinataire, votre vidéo d’introduction, une chanson originale, les noms et un message sincère.","Recipient photo on screen":"Photo du destinataire à l’écran","Personal introduction video":"Vidéo d’introduction personnelle","Original tribute song":"Chanson d’hommage originale","Recipient and sender names":"Noms du destinataire et de l’expéditeur","Personal message":"Message personnel","Downloadable finished video":"Vidéo finale téléchargeable","A beautiful Printo video greeting":"Un beau message vidéo Printo","RECIPIENT PHOTO":"PHOTO DU DESTINATAIRE","Your special person":"Votre personne spéciale","Personal Tribute":"Hommage personnel","Music Video Card":"Carte vidéo musicale","Personal introduction • Photo • Original song":"Introduction personnelle • Photo • Chanson originale","Worker will discuss with me":"Un agent en discutera avec moi","Soft acoustic":"Acoustique douce","Other":"Autre","JPG, PNG or WebP. Clear portrait preferred.":"JPG, PNG ou WebP. Portrait clair recommandé.","Maximum 60 seconds and 100 MB. Large files are compressed automatically to a smaller 720p MP4 before permanent storage.":"Maximum 60 secondes et 100 Mo. Les gros fichiers sont automatiquement compressés en MP4 720p avant stockage permanent.","Terms of Use, Privacy Policy and Refund Policy":"Conditions d’utilisation, Politique de confidentialité et Politique de remboursement","Please confirm permission and accept the Terms, Privacy and Refund Policy.":"Confirmez l’autorisation et acceptez les Conditions, la Confidentialité et la Politique de remboursement.","Recipient photo must be 10 MB or smaller.":"La photo doit faire 10 Mo ou moins.","Introduction video must be 100 MB or smaller.":"La vidéo doit faire 100 Mo ou moins.","Introduction video must be 60 seconds or shorter.":"La vidéo doit durer 60 secondes ou moins.","Uploading and compressing your introduction video…":"Téléversement et compression de votre vidéo d’introduction…","Introduction video compressed and stored safely.":"La vidéo a été compressée et stockée en sécurité.","Could not save premium order.":"Impossible d’enregistrer la commande Premium.","The introduction video could not be read.":"La vidéo d’introduction n’a pas pu être lue.","Order":"Commande","Printo Credits & Subscriptions":"Crédits et abonnements Printo","Each verified phone number receives 100 FREE credits once — enough for 5 standard creations. Each standard creation uses 20 credits.":"Chaque numéro vérifié reçoit une fois 100 crédits GRATUITS, soit 5 créations standard. Chaque création utilise 20 crédits.","Use one universal Printo credit wallet for Standard, Premium Video, and Premium Multi-Image creations.":"Utilisez un portefeuille universel de crédits pour Standard, Vidéo Premium et Multi-images Premium.","Standard Greeting Plans":"Formules de vœux standard","For personalized standard greeting video cards with names, messages, Printo music and voice.":"Pour des cartes standard personnalisées avec noms, messages, musique et voix Printo.","STANDARD":"STANDARD","Single Creation":"Création unique","20 credits • 1 standard creation":"20 crédits • 1 création standard","Buy One":"Acheter une","Monthly":"Mensuel","100 credits monthly • 5 standard creations":"100 crédits par mois • 5 créations standard","Choose Standard Monthly":"Choisir Standard mensuel","6 Months":"6 mois","600 credits • 30 standard creations":"600 crédits • 30 créations standard","Choose Standard 6 Months":"Choisir Standard 6 mois","BEST STANDARD VALUE":"MEILLEURE OFFRE STANDARD","1 Year":"1 an","1,200 credits • 60 standard creations":"1 200 crédits • 60 créations standard","Choose Standard Annual":"Choisir Standard annuel","Premium Subscription Plans":"Formules d’abonnement Premium","For Premium Tribute and enhanced personalized video experiences. Credit costs: Standard 20, Premium Video 25, Premium Multi-Image 50.":"Pour les hommages Premium et vidéos personnalisées. Coûts : Standard 20, Vidéo Premium 25, Multi-images Premium 50.","PREMIUM":"PREMIUM","100 credits now, then 100 credits each active month":"100 crédits maintenant, puis 100 par mois actif","Choose Premium Monthly":"Choisir Premium mensuel","100 credits monthly for 6 months":"100 crédits par mois pendant 6 mois","Choose Premium 6 Months":"Choisir Premium 6 mois","BEST PREMIUM VALUE":"MEILLEURE OFFRE PREMIUM","100 credits monthly for 12 months":"100 crédits par mois pendant 12 mois","Choose Premium Annual":"Choisir Premium annuel","My Printo Dashboard":"Mon tableau de bord Printo","Welcome Bonus: Each verified phone number receives 100 FREE credits once — enough for 5 standard creations.":"Bonus de bienvenue : chaque numéro vérifié reçoit une fois 100 crédits GRATUITS, soit 5 créations standard.","Credits":"Crédits","Standard Creations Remaining":"Créations standard restantes","Plan":"Formule","Free Welcome":"Bienvenue gratuite","Create Another Greeting":"Créer un autre vœu","Create Your First Greeting":"Créer votre premier vœu","My Finished Videos":"Mes vidéos terminées","Recipient":"Destinataire","Play":"Lire","Download":"Télécharger","Your earlier creation record is saved, but its old temporary video file is no longer available. New finished videos will remain here after deployments and restarts.":"Votre ancien enregistrement est conservé, mais l’ancien fichier temporaire n’est plus disponible. Les nouvelles vidéos resteront après les déploiements et redémarrages.","You have not created your first greeting yet. Click Create Your First Greeting to surprise someone special.":"Vous n’avez pas encore créé votre premier vœu. Cliquez sur Créer votre premier vœu pour surprendre une personne spéciale.","Back to Printo Studio":"Retour à Printo Studio","Share Video to YouTube":"Partager la vidéo sur YouTube","Create Another":"Créer une autre","Buy More Credits / Subscribe":"Acheter plus de crédits / S’abonner","My Videos & Credits":"Mes vidéos et crédits","Nigeria Payment":"Paiement Nigeria","Printo Greeting Studio":"Studio de vœux Printo","Share Video to TikTok":"Partager la vidéo sur TikTok","Download Video":"Télécharger la vidéo","Email":"E-mail","Share Video to Instagram":"Partager la vidéo sur Instagram","Copy Short Greeting Link":"Copier le lien court","Buy via Shopify":"Acheter via Shopify","Your personalized greeting is ready":"Votre message personnalisé est prêt","Created for":"Créé pour","from":"de","Facebook, WhatsApp and X/Twitter share the short greeting link and preview. Instagram, YouTube and TikTok download the MP4 first; upload the downloaded video in the app and paste the copied short link into the caption or description.":"Facebook, WhatsApp et X/Twitter partagent le lien court et l’aperçu. Instagram, YouTube et TikTok téléchargent d’abord le MP4 ; importez-le et collez le lien court dans la légende ou la description.","Please read these rules before uploading photos, videos, voices, names, messages, music instructions, documents, logos, or other content to Printto Studio.":"Lisez ces règles avant de téléverser des photos, vidéos, voix, noms, messages, instructions musicales, documents, logos ou autre contenu dans Printo Studio.","1. Your Content and Permission":"1. Votre contenu et vos autorisations","You confirm that you own, created, licensed, or received clear permission to use every photograph, video, voice recording, name, message, logo, song, document, or other material you upload.":"Vous confirmez posséder, avoir créé, obtenu une licence ou une autorisation claire pour chaque photo, vidéo, voix, nom, message, logo, chanson, document ou autre élément.","Do not upload or generate content using another person’s image, video, voice, likeness, or private information without that person’s authorization.":"Ne téléversez ni ne générez de contenu utilisant l’image, la vidéo, la voix, l’apparence ou les informations privées d’une autre personne sans autorisation.","2. User Responsibility":"2. Responsabilité de l’utilisateur","3. Prohibited Content":"3. Contenu interdit","4. Privacy and Uploaded Files":"4. Confidentialité et fichiers téléversés","5. AI and Creative Output":"5. IA et résultat créatif","6. Credits and Memberships":"6. Crédits et abonnements","7. Final Sale and No-Return Policy":"7. Vente finale et absence de retour","8. Technical Generation Problems":"8. Problèmes techniques de génération","9. Limitation of Responsibility":"9. Limitation de responsabilité","10. Policy Enforcement and Updates":"10. Application et mises à jour","All Rights Reserved.":"Tous droits réservés.","You are solely responsible for your uploads and the instructions you provide. PATAPATA LLC does not authorize impersonation, harassment, defamation, copyright infringement, privacy violations, misleading endorsements, or unlawful use of another person’s identity.":"Vous êtes seul responsable de vos fichiers et instructions. PATAPATA LLC n’autorise pas l’usurpation, le harcèlement, la diffamation, les atteintes au droit d’auteur ou à la vie privée, les recommandations trompeuses ni l’usage illégal de l’identité d’autrui.","PATAPATA LLC may reject, suspend, remove, or report content or accounts that appear illegal, abusive, deceptive, unsafe, or unauthorized.":"PATAPATA LLC peut refuser, suspendre, supprimer ou signaler tout contenu ou compte semblant illégal, abusif, trompeur, dangereux ou non autorisé.","Content involving exploitation, threats, hate, harassment, violence, or illegal activity.":"Contenu impliquant exploitation, menaces, haine, harcèlement, violence ou activité illégale.","Sexually explicit content or content that exploits or endangers minors.":"Contenu sexuellement explicite ou exploitant ou mettant en danger des mineurs.","Unauthorized copyrighted material, trademarks, private records, or confidential information.":"Contenu protégé, marques, dossiers privés ou informations confidentielles sans autorisation.","False impersonation, fraud, scams, or content intended to deceive the public.":"Fausse identité, fraude, arnaques ou contenu destiné à tromper le public.","Names, contact details, photos, videos, messages, and other uploaded files may be processed and temporarily stored to create the requested service, operate customer accounts, prevent abuse, complete payments, troubleshoot failures, and provide support.":"Les noms, coordonnées, photos, vidéos, messages et autres fichiers peuvent être traités et stockés temporairement pour créer le service, gérer les comptes, prévenir les abus, effectuer les paiements, résoudre les problèmes et fournir l’assistance.","PATAPATA LLC does not sell customer personal information. Customers should avoid uploading unnecessary sensitive information.":"PATAPATA LLC ne vend pas les informations personnelles des clients. Évitez de téléverser des informations sensibles inutiles.","AI-generated or automatically assembled results may contain variations. You must review names, spelling, messages, photos, video selections, and instructions before submitting. Minor creative differences that do not prevent delivery are not generation failures.":"Les résultats générés par IA ou assemblés automatiquement peuvent varier. Vérifiez noms, orthographe, messages, photos, vidéos et instructions avant l’envoi. Les petites différences créatives n’empêchant pas la livraison ne sont pas des échecs.","Credits are deducted when a generation or eligible service begins. Membership credits are released according to the selected plan. Prices, credit costs, available features, and processing times may be updated for future purchases.":"Les crédits sont déduits au début d’une génération ou d’un service admissible. Les crédits d’abonnement sont accordés selon la formule. Les prix, coûts, fonctions et délais peuvent évoluer.","Because each video is custom-generated using customer-provided information and computing resources, a successfully generated video is final and non-returnable. No refund is provided after successful generation merely because the customer changes their mind, dislikes a creative preference, or supplied incorrect information.":"Chaque vidéo étant créée sur mesure avec les informations du client et des ressources informatiques, une vidéo générée avec succès est définitive et non retournable. Aucun remboursement n’est accordé pour changement d’avis, préférence créative ou données erronées.","If a verified technical problem caused the generation not to work, produced no usable video, or prevented delivery, contact a Printto Support Agent promptly. After reviewing the issue, PATAPATA LLC may fix and regenerate the video, restore the affected credits, or provide another appropriate resolution.":"Si un problème technique vérifié empêche la génération, ne produit aucune vidéo utilisable ou bloque la livraison, contactez rapidement l’assistance Printo. PATAPATA LLC peut corriger, régénérer, restaurer les crédits ou proposer une autre solution.","A refund, when legally required or approved by PATAPATA LLC, is considered only after support has had a reasonable opportunity to investigate and correct the technical problem.":"Un remboursement, lorsqu’il est légalement requis ou approuvé, n’est envisagé qu’après que l’assistance a pu raisonnablement enquêter et corriger le problème.","To the extent permitted by law, PATAPATA LLC is not responsible for claims, losses, or disputes caused by unauthorized uploads, customer mistakes, infringement by a user, third-party platforms, internet interruptions, or circumstances outside our reasonable control.":"Dans la mesure permise par la loi, PATAPATA LLC n’est pas responsable des réclamations, pertes ou litiges dus à des fichiers non autorisés, erreurs du client, violations, plateformes tierces, coupures internet ou circonstances hors contrôle.","We may refuse service or restrict access when necessary to protect people, intellectual property, privacy, platform security, or legal compliance. Updated terms apply to future use after they are posted on this page.":"Nous pouvons refuser le service ou limiter l’accès pour protéger les personnes, la propriété intellectuelle, la vie privée, la sécurité ou le respect de la loi. Les conditions mises à jour s’appliquent après publication.","For a failed generation or another service problem, use the Worker Help or Support Agent option in Printto Studio before requesting a refund.":"En cas d’échec ou de problème, utilisez l’aide d’un agent dans Printo Studio avant de demander un remboursement.","4–8 numbers":"4 à 8 chiffres","Could not check verification.":"Impossible de vérifier la confirmation.","Could not start verification.":"Impossible de démarrer la vérification.","Account request failed":"La demande de compte a échoué","First verified-account test FREE • Then 50 credits or $14.99":"Premier essai GRATUIT pour un compte vérifié • Puis 50 crédits ou 14,99 $","Premium Multi-Image Flip Tribute":"Hommage Premium multi-images avec transitions","Upload 2–8 recipient photos. After the personal introduction ends, the images flip one after another while the custom tribute music plays.":"Importez 2 à 8 photos du destinataire. Après la présentation personnelle, les images s’enchaînent pendant la musique d’hommage personnalisée.","2–8 recipient photos":"2 à 8 photos du destinataire","Flip-style image transitions":"Transitions d’images avec effet de bascule","Custom tribute music":"Musique d’hommage personnalisée","First verified-account test is FREE":"Le premier essai d’un compte vérifié est GRATUIT","After the free test: 50 credits or $14.99":"Après l’essai gratuit : 50 crédits ou 14,99 $","Share and download page":"Page de partage et de téléchargement","Create Multi-Image Flip":"Créer la vidéo multi-images","Premium Creation Prices & Subscription Plans":"Prix des créations Premium et abonnements","Each Premium service has its own separate creation price in the universal Printo credit wallet.":"Chaque service Premium possède son propre prix de création dans le portefeuille universel de crédits Printo.","PREMIUM VIDEO":"VIDÉO PREMIUM","Personal Tribute Video":"Vidéo d’hommage personnelle","25 Credits":"25 crédits","1 recipient photo • introduction video • custom music":"1 photo du destinataire • vidéo d’introduction • musique personnalisée","Create Premium Video":"Créer une vidéo Premium","MULTI-IMAGE FLIP":"TRANSITIONS MULTI-IMAGES","Premium Multi-Image":"Premium multi-images","First verified-account test FREE • then 50 credits • 2–8 photos • flip transitions • introduction • custom music":"Premier essai GRATUIT pour un compte vérifié • puis 50 crédits • 2–8 photos • transitions • introduction • musique personnalisée","Use Free Test / Create":"Utiliser l’essai gratuit / Créer","Buy 50 Credits":"Acheter 50 crédits","Each verified phone number receives 100 FREE universal credits once, plus one FREE Multi-Image Flip test worth 50 credits. After the free Multi-Image test, each Multi-Image creation costs 50 credits or $14.99.":"Chaque numéro vérifié reçoit une fois 100 crédits universels GRATUITS, plus un essai GRATUIT multi-images d’une valeur de 50 crédits. Ensuite, chaque création coûte 50 crédits ou 14,99 $.","Welcome Bonus: 100 FREE universal credits plus one FREE Multi-Image Flip test worth 50 credits for each verified phone account.":"Bonus de bienvenue : 100 crédits universels GRATUITS plus un essai GRATUIT multi-images d’une valeur de 50 crédits pour chaque compte téléphonique vérifié.","Free Multi-Image Test":"Essai gratuit multi-images","Available":"Disponible","Used":"Utilisé","Premium Multi-Image Flip Video":"Vidéo Premium multi-images","Premium video is not ready yet.":"La vidéo Premium n’est pas encore prête.","Return to My Videos and try again after rendering is complete.":"Retournez dans Mes vidéos et réessayez lorsque le rendu est terminé.","A personalized Printo Premium tribute video.":"Une vidéo d’hommage Premium personnalisée Printo.","Facebook, WhatsApp and X share the Premium result page. Instagram, YouTube and TikTok use your phone’s share sheet when available; otherwise the MP4 downloads first for upload.":"Facebook, WhatsApp et X partagent la page du résultat Premium. Instagram, YouTube et TikTok utilisent le menu de partage du téléphone ; sinon le MP4 est d’abord téléchargé.","Premium video link copied.":"Lien de la vidéo Premium copié.","Payment is required.":"Un paiement est requis.","FREE TEST — 0 credits deducted":"ESSAI GRATUIT — 0 crédit déduit","Each recipient image must be 10 MB or smaller.":"Chaque image du destinataire doit faire 10 Mo ou moins.","Personal video or voice introduction":"Introduction personnelle en vidéo ou par la voix","Choose Video or Voice Introduction":"Choisissez une introduction vidéo ou vocale","Video Introduction":"Introduction vidéo","Voice Introduction":"Introduction vocale","Record Voice":"Enregistrer la voix","Start Recording":"Démarrer l’enregistrement","Stop Recording":"Arrêter l’enregistrement","Play Recording":"Écouter l’enregistrement","Record Again":"Enregistrer à nouveau","Upload Existing Audio":"Importer un fichier audio","Record in a quiet place and speak clearly. Printo will reduce background noise automatically.":"Enregistrez dans un endroit calme et parlez clairement. Printo réduira automatiquement le bruit de fond.","Personal introduction video or voice recording":"Vidéo d’introduction personnelle ou enregistrement vocal","Create a powerful personal tribute using the recipient photo, your personal introduction video or voice recording, an original tribute song, names and a heartfelt message.":"Créez un hommage personnel avec la photo du destinataire, votre vidéo d’introduction ou enregistrement vocal, une chanson originale, les noms et un message sincère."},"de":{"Language":"Sprache","Printo Account":"Printo-Konto","Use one verified WhatsApp phone number for one Printo account.":"Verwenden Sie eine verifizierte WhatsApp-Nummer pro Printo-Konto.","A verified phone number receives the 100 welcome credits only once. Invented email addresses can no longer create free-credit accounts.":"Eine verifizierte Nummer erhält die 100 Willkommens-Credits nur einmal. Erfundenen E-Mail-Adressen können keine Gratis-Konten mehr erstellen.","Create Account":"Konto erstellen","Log In":"Anmelden","WhatsApp Phone Number":"WhatsApp-Telefonnummer","Include the country code. The number must be connected to WhatsApp.":"Geben Sie die Landesvorwahl an. Die Nummer muss mit WhatsApp verbunden sein.","Verify Number with WhatsApp":"Nummer mit WhatsApp bestätigen","Tap the button, send the prepared message in WhatsApp, then return here.":"Tippen Sie auf die Schaltfläche, senden Sie die vorbereitete Nachricht in WhatsApp und kehren Sie zurück.","Open WhatsApp verification":"WhatsApp-Bestätigung öffnen","Existing Email Address":"Vorhandene E-Mail-Adresse","Only for an account created before phone verification was introduced.":"Nur für Konten, die vor der Telefonbestätigung erstellt wurden.","PIN Number":"PIN-Nummer","Create Account & Receive 100 Credits":"Konto erstellen und 100 Credits erhalten","Existing old email account? Log in here":"Altes E-Mail-Konto? Hier anmelden","Use phone-number login instead":"Stattdessen Telefonnummer verwenden","Log In to My Account":"Bei meinem Konto anmelden","Preparing WhatsApp verification...":"WhatsApp-Bestätigung wird vorbereitet...","WhatsApp is opening. Send the prepared PRINTO VERIFY message, then return to this page.":"WhatsApp wird geöffnet. Senden Sie die vorbereitete PRINTO VERIFY-Nachricht und kehren Sie zurück.","Phone number verified. Choose your PIN and create the account.":"Telefonnummer bestätigt. Wählen Sie Ihre PIN und erstellen Sie das Konto.","Verification expired. Tap Verify Number with WhatsApp again.":"Bestätigung abgelaufen. Tippen Sie erneut auf Nummer mit WhatsApp bestätigen.","Verify your WhatsApp phone number first.":"Bestätigen Sie zuerst Ihre WhatsApp-Nummer.","Creating your verified account...":"Verifiziertes Konto wird erstellt...","Logging in...":"Anmeldung...","Success. Opening Printo Studio...":"Erfolgreich. Printo Studio wird geöffnet...","Return to Printo Studio":"Zurück zu Printo Studio","Close / Return to Studio":"Schließen / Zurück zum Studio","My Videos":"Meine Videos","Buy Credits / Subscribe":"Credits kaufen / Abonnieren","Printo Sample":"Printo-Beispiel","PREMIUM EXPERIENCE":"PREMIUM-ERLEBNIS","Personal Tribute Music Video Card":"Persönliche Tribute-Musik-Videokarte","Create a powerful personal tribute using the recipient photo, your personal introduction video, an original tribute song, names and a heartfelt message.":"Erstellen Sie ein persönliches Tribute mit Empfängerfoto, Einführungsvideo, Originalsong, Namen und herzlicher Nachricht.","Recipient photo on screen":"Empfängerfoto auf dem Bildschirm","Personal introduction video":"Persönliches Einführungsvideo","Original tribute song":"Originaler Tribute-Song","Recipient and sender names":"Empfänger- und Absendernamen","Personal message":"Persönliche Nachricht","Downloadable finished video":"Fertiges Video zum Herunterladen","A beautiful Printo video greeting":"Ein schöner Printo-Videogruß","RECIPIENT PHOTO":"EMPFÄNGERFOTO","Your special person":"Ihre besondere Person","Personal Tribute":"Persönliches Tribute","Music Video Card":"Musik-Videokarte","Personal introduction • Photo • Original song":"Persönliche Einführung • Foto • Originalsong","Worker will discuss with me":"Ein Mitarbeiter bespricht es mit mir","Soft acoustic":"Sanft akustisch","Other":"Andere","JPG, PNG or WebP. Clear portrait preferred.":"JPG, PNG oder WebP. Ein klares Porträt wird empfohlen.","Maximum 60 seconds and 100 MB. Large files are compressed automatically to a smaller 720p MP4 before permanent storage.":"Maximal 60 Sekunden und 100 MB. Große Dateien werden automatisch in eine kleinere 720p-MP4-Datei komprimiert.","Terms of Use, Privacy Policy and Refund Policy":"Nutzungsbedingungen, Datenschutz- und Rückerstattungsrichtlinie","Please confirm permission and accept the Terms, Privacy and Refund Policy.":"Bestätigen Sie die Erlaubnis und akzeptieren Sie Bedingungen, Datenschutz und Rückerstattung.","Recipient photo must be 10 MB or smaller.":"Das Empfängerfoto darf höchstens 10 MB groß sein.","Introduction video must be 100 MB or smaller.":"Das Einführungsvideo darf höchstens 100 MB groß sein.","Introduction video must be 60 seconds or shorter.":"Das Einführungsvideo darf höchstens 60 Sekunden lang sein.","Uploading and compressing your introduction video…":"Einführungsvideo wird hochgeladen und komprimiert…","Introduction video compressed and stored safely.":"Das Video wurde komprimiert und sicher gespeichert.","Could not save premium order.":"Premium-Bestellung konnte nicht gespeichert werden.","The introduction video could not be read.":"Das Einführungsvideo konnte nicht gelesen werden.","Order":"Bestellung","Printo Credits & Subscriptions":"Printo Credits & Abonnements","Each verified phone number receives 100 FREE credits once — enough for 5 standard creations. Each standard creation uses 20 credits.":"Jede verifizierte Nummer erhält einmal 100 GRATIS-Credits, genug für 5 Standard-Erstellungen. Jede Erstellung kostet 20 Credits.","Use one universal Printo credit wallet for Standard, Premium Video, and Premium Multi-Image creations.":"Verwenden Sie ein universelles Guthaben für Standard, Premium Video und Premium Multi-Image.","Standard Greeting Plans":"Standard-Grußpläne","For personalized standard greeting video cards with names, messages, Printo music and voice.":"Für personalisierte Standard-Videokarten mit Namen, Nachrichten, Printo-Musik und Stimme.","STANDARD":"STANDARD","Single Creation":"Einzelerstellung","20 credits • 1 standard creation":"20 Credits • 1 Standard-Erstellung","Buy One":"Einmal kaufen","Monthly":"Monatlich","100 credits monthly • 5 standard creations":"100 Credits monatlich • 5 Standard-Erstellungen","Choose Standard Monthly":"Standard monatlich wählen","6 Months":"6 Monate","600 credits • 30 standard creations":"600 Credits • 30 Standard-Erstellungen","Choose Standard 6 Months":"Standard 6 Monate wählen","BEST STANDARD VALUE":"BESTER STANDARDWERT","1 Year":"1 Jahr","1,200 credits • 60 standard creations":"1.200 Credits • 60 Standard-Erstellungen","Choose Standard Annual":"Standard jährlich wählen","Premium Subscription Plans":"Premium-Abonnementpläne","For Premium Tribute and enhanced personalized video experiences. Credit costs: Standard 20, Premium Video 25, Premium Multi-Image 50.":"Für Premium-Tributes und personalisierte Videos. Kosten: Standard 20, Premium Video 25, Premium Multi-Image 50.","PREMIUM":"PREMIUM","100 credits now, then 100 credits each active month":"100 Credits jetzt, danach 100 pro aktivem Monat","Choose Premium Monthly":"Premium monatlich wählen","100 credits monthly for 6 months":"100 Credits monatlich für 6 Monate","Choose Premium 6 Months":"Premium 6 Monate wählen","BEST PREMIUM VALUE":"BESTER PREMIUMWERT","100 credits monthly for 12 months":"100 Credits monatlich für 12 Monate","Choose Premium Annual":"Premium jährlich wählen","My Printo Dashboard":"Mein Printo-Dashboard","Welcome Bonus: Each verified phone number receives 100 FREE credits once — enough for 5 standard creations.":"Willkommensbonus: Jede verifizierte Nummer erhält einmal 100 GRATIS-Credits, genug für 5 Standard-Erstellungen.","Credits":"Credits","Standard Creations Remaining":"Verbleibende Standard-Erstellungen","Plan":"Plan","Free Welcome":"Kostenloser Start","Create Another Greeting":"Weiteren Gruß erstellen","Create Your First Greeting":"Ersten Gruß erstellen","My Finished Videos":"Meine fertigen Videos","Recipient":"Empfänger","Play":"Abspielen","Download":"Herunterladen","Your earlier creation record is saved, but its old temporary video file is no longer available. New finished videos will remain here after deployments and restarts.":"Der frühere Datensatz ist gespeichert, aber die alte temporäre Videodatei ist nicht mehr verfügbar. Neue Videos bleiben nach Bereitstellungen und Neustarts erhalten.","You have not created your first greeting yet. Click Create Your First Greeting to surprise someone special.":"Sie haben noch keinen Gruß erstellt. Klicken Sie auf Ersten Gruß erstellen, um jemanden zu überraschen.","Back to Printo Studio":"Zurück zu Printo Studio","Share Video to YouTube":"Video auf YouTube teilen","Create Another":"Weiteres erstellen","Buy More Credits / Subscribe":"Mehr Credits kaufen / Abonnieren","My Videos & Credits":"Meine Videos und Credits","Nigeria Payment":"Nigeria-Zahlung","Printo Greeting Studio":"Printo Grußstudio","Share Video to TikTok":"Video auf TikTok teilen","Download Video":"Video herunterladen","Email":"E-Mail","Share Video to Instagram":"Video auf Instagram teilen","Copy Short Greeting Link":"Kurzen Grußlink kopieren","Buy via Shopify":"Über Shopify kaufen","Your personalized greeting is ready":"Ihr personalisierter Gruß ist fertig","Created for":"Erstellt für","from":"von","Facebook, WhatsApp and X/Twitter share the short greeting link and preview. Instagram, YouTube and TikTok download the MP4 first; upload the downloaded video in the app and paste the copied short link into the caption or description.":"Facebook, WhatsApp und X/Twitter teilen den kurzen Link und die Vorschau. Instagram, YouTube und TikTok laden zuerst die MP4 herunter; laden Sie sie hoch und fügen Sie den Link in die Beschreibung ein.","Please read these rules before uploading photos, videos, voices, names, messages, music instructions, documents, logos, or other content to Printto Studio.":"Lesen Sie diese Regeln, bevor Sie Fotos, Videos, Stimmen, Namen, Nachrichten, Musikanweisungen, Dokumente, Logos oder andere Inhalte hochladen.","1. Your Content and Permission":"1. Ihre Inhalte und Erlaubnis","You confirm that you own, created, licensed, or received clear permission to use every photograph, video, voice recording, name, message, logo, song, document, or other material you upload.":"Sie bestätigen, dass Sie jedes hochgeladene Foto, Video, jede Stimme, jeden Namen, jede Nachricht, jedes Logo, Lied, Dokument oder Material besitzen oder nutzen dürfen.","Do not upload or generate content using another person’s image, video, voice, likeness, or private information without that person’s authorization.":"Laden oder erzeugen Sie keine Inhalte mit Bild, Video, Stimme, Erscheinungsbild oder privaten Informationen einer anderen Person ohne Genehmigung.","2. User Responsibility":"2. Verantwortung des Nutzers","3. Prohibited Content":"3. Verbotene Inhalte","4. Privacy and Uploaded Files":"4. Datenschutz und hochgeladene Dateien","5. AI and Creative Output":"5. KI und kreative Ergebnisse","6. Credits and Memberships":"6. Credits und Mitgliedschaften","7. Final Sale and No-Return Policy":"7. Endverkauf und keine Rückgabe","8. Technical Generation Problems":"8. Technische Generierungsprobleme","9. Limitation of Responsibility":"9. Haftungsbeschränkung","10. Policy Enforcement and Updates":"10. Durchsetzung und Aktualisierungen","All Rights Reserved.":"Alle Rechte vorbehalten.","You are solely responsible for your uploads and the instructions you provide. PATAPATA LLC does not authorize impersonation, harassment, defamation, copyright infringement, privacy violations, misleading endorsements, or unlawful use of another person’s identity.":"Sie tragen die alleinige Verantwortung für Uploads und Anweisungen. PATAPATA LLC erlaubt keine Identitätsvortäuschung, Belästigung, Verleumdung, Urheberrechts- oder Datenschutzverletzung, irreführende Empfehlungen oder rechtswidrige Nutzung fremder Identität.","PATAPATA LLC may reject, suspend, remove, or report content or accounts that appear illegal, abusive, deceptive, unsafe, or unauthorized.":"PATAPATA LLC kann Inhalte oder Konten ablehnen, sperren, entfernen oder melden, die illegal, missbräuchlich, täuschend, unsicher oder unautorisiert erscheinen.","Content involving exploitation, threats, hate, harassment, violence, or illegal activity.":"Inhalte mit Ausbeutung, Drohungen, Hass, Belästigung, Gewalt oder illegalen Aktivitäten.","Sexually explicit content or content that exploits or endangers minors.":"Sexuell explizite Inhalte oder Inhalte, die Minderjährige ausbeuten oder gefährden.","Unauthorized copyrighted material, trademarks, private records, or confidential information.":"Nicht autorisierte urheberrechtlich geschützte Materialien, Marken, private Unterlagen oder vertrauliche Informationen.","False impersonation, fraud, scams, or content intended to deceive the public.":"Falsche Identität, Betrug, Täuschungen oder Inhalte zur Irreführung der Öffentlichkeit.","Names, contact details, photos, videos, messages, and other uploaded files may be processed and temporarily stored to create the requested service, operate customer accounts, prevent abuse, complete payments, troubleshoot failures, and provide support.":"Namen, Kontaktdaten, Fotos, Videos, Nachrichten und andere Dateien können zur Diensterstellung, Kontoverwaltung, Missbrauchsprävention, Zahlungsabwicklung, Fehlerbehebung und Unterstützung verarbeitet und vorübergehend gespeichert werden.","PATAPATA LLC does not sell customer personal information. Customers should avoid uploading unnecessary sensitive information.":"PATAPATA LLC verkauft keine persönlichen Kundendaten. Laden Sie keine unnötigen sensiblen Informationen hoch.","AI-generated or automatically assembled results may contain variations. You must review names, spelling, messages, photos, video selections, and instructions before submitting. Minor creative differences that do not prevent delivery are not generation failures.":"KI-generierte oder automatisch zusammengestellte Ergebnisse können variieren. Prüfen Sie Namen, Schreibweise, Nachrichten, Fotos, Videos und Anweisungen. Kleine Unterschiede ohne Lieferhindernis sind keine Fehler.","Credits are deducted when a generation or eligible service begins. Membership credits are released according to the selected plan. Prices, credit costs, available features, and processing times may be updated for future purchases.":"Credits werden beim Beginn einer Generierung oder eines berechtigten Dienstes abgezogen. Mitgliedschafts-Credits werden gemäß Plan freigegeben. Preise, Kosten, Funktionen und Zeiten können geändert werden.","Because each video is custom-generated using customer-provided information and computing resources, a successfully generated video is final and non-returnable. No refund is provided after successful generation merely because the customer changes their mind, dislikes a creative preference, or supplied incorrect information.":"Da jedes Video individuell mit Kundendaten und Rechenressourcen erzeugt wird, ist ein erfolgreich erstelltes Video endgültig und nicht rückgabefähig. Keine Erstattung wegen Meinungsänderung, Vorlieben oder falscher Kundendaten.","If a verified technical problem caused the generation not to work, produced no usable video, or prevented delivery, contact a Printto Support Agent promptly. After reviewing the issue, PATAPATA LLC may fix and regenerate the video, restore the affected credits, or provide another appropriate resolution.":"Wenn ein bestätigtes technisches Problem die Erstellung verhindert, kein brauchbares Video erzeugt oder die Lieferung blockiert, kontaktieren Sie den Printo-Support. PATAPATA LLC kann korrigieren, neu erstellen, Credits wiederherstellen oder eine andere Lösung anbieten.","A refund, when legally required or approved by PATAPATA LLC, is considered only after support has had a reasonable opportunity to investigate and correct the technical problem.":"Eine gesetzlich erforderliche oder genehmigte Erstattung wird erst erwogen, nachdem der Support angemessen Zeit zur Prüfung und Behebung hatte.","To the extent permitted by law, PATAPATA LLC is not responsible for claims, losses, or disputes caused by unauthorized uploads, customer mistakes, infringement by a user, third-party platforms, internet interruptions, or circumstances outside our reasonable control.":"Soweit gesetzlich zulässig, haftet PATAPATA LLC nicht für Ansprüche, Verluste oder Streitigkeiten durch unautorisierte Uploads, Kundenfehler, Verstöße, Drittplattformen, Internetausfälle oder Umstände außerhalb der Kontrolle.","We may refuse service or restrict access when necessary to protect people, intellectual property, privacy, platform security, or legal compliance. Updated terms apply to future use after they are posted on this page.":"Wir können Dienste ablehnen oder den Zugang beschränken, um Personen, geistiges Eigentum, Datenschutz, Sicherheit oder Rechtskonformität zu schützen. Aktualisierte Bedingungen gelten nach Veröffentlichung.","For a failed generation or another service problem, use the Worker Help or Support Agent option in Printto Studio before requesting a refund.":"Nutzen Sie bei fehlgeschlagener Erstellung oder Problemen zuerst Mitarbeiterhilfe oder Support in Printo Studio, bevor Sie eine Erstattung beantragen.","4–8 numbers":"4–8 Ziffern","Could not check verification.":"Die Bestätigung konnte nicht geprüft werden.","Could not start verification.":"Die Bestätigung konnte nicht gestartet werden.","Account request failed":"Die Kontoanfrage ist fehlgeschlagen","First verified-account test FREE • Then 50 credits or $14.99":"Erster Test für ein verifiziertes Konto KOSTENLOS • Danach 50 Credits oder 14,99 $","Premium Multi-Image Flip Tribute":"Premium Multi-Bild-Flip-Tribute","Upload 2–8 recipient photos. After the personal introduction ends, the images flip one after another while the custom tribute music plays.":"Laden Sie 2–8 Empfängerfotos hoch. Nach dem persönlichen Einführungsvideo wechseln die Bilder nacheinander, während die eigene Tribute-Musik spielt.","2–8 recipient photos":"2–8 Empfängerfotos","Flip-style image transitions":"Bildübergänge im Flip-Stil","Custom tribute music":"Eigene Tribute-Musik","First verified-account test is FREE":"Der erste Test für ein verifiziertes Konto ist KOSTENLOS","After the free test: 50 credits or $14.99":"Nach dem kostenlosen Test: 50 Credits oder 14,99 $","Share and download page":"Seite zum Teilen und Herunterladen","Create Multi-Image Flip":"Multi-Bild-Flip erstellen","Premium Creation Prices & Subscription Plans":"Premium-Erstellungspreise und Abonnements","Each Premium service has its own separate creation price in the universal Printo credit wallet.":"Jeder Premium-Dienst hat einen eigenen Erstellungspreis im universellen Printo-Credit-Guthaben.","PREMIUM VIDEO":"PREMIUM-VIDEO","Personal Tribute Video":"Persönliches Tribute-Video","25 Credits":"25 Credits","1 recipient photo • introduction video • custom music":"1 Empfängerfoto • Einführungsvideo • eigene Musik","Create Premium Video":"Premium-Video erstellen","MULTI-IMAGE FLIP":"MULTI-BILD-FLIP","Premium Multi-Image":"Premium Multi-Bild","First verified-account test FREE • then 50 credits • 2–8 photos • flip transitions • introduction • custom music":"Erster Test für ein verifiziertes Konto KOSTENLOS • danach 50 Credits • 2–8 Fotos • Flip-Übergänge • Einführung • eigene Musik","Use Free Test / Create":"Kostenlosen Test nutzen / Erstellen","Buy 50 Credits":"50 Credits kaufen","Each verified phone number receives 100 FREE universal credits once, plus one FREE Multi-Image Flip test worth 50 credits. After the free Multi-Image test, each Multi-Image creation costs 50 credits or $14.99.":"Jede verifizierte Telefonnummer erhält einmal 100 KOSTENLOSE universelle Credits sowie einen KOSTENLOSEN Multi-Bild-Flip-Test im Wert von 50 Credits. Danach kostet jede Erstellung 50 Credits oder 14,99 $.","Welcome Bonus: 100 FREE universal credits plus one FREE Multi-Image Flip test worth 50 credits for each verified phone account.":"Willkommensbonus: 100 KOSTENLOSE universelle Credits plus ein KOSTENLOSER Multi-Bild-Flip-Test im Wert von 50 Credits für jedes verifizierte Telefonkonto.","Free Multi-Image Test":"Kostenloser Multi-Bild-Test","Available":"Verfügbar","Used":"Verwendet","Premium Multi-Image Flip Video":"Premium Multi-Bild-Flip-Video","Premium video is not ready yet.":"Das Premium-Video ist noch nicht fertig.","Return to My Videos and try again after rendering is complete.":"Kehren Sie zu Meine Videos zurück und versuchen Sie es nach Abschluss des Renderns erneut.","A personalized Printo Premium tribute video.":"Ein personalisiertes Printo Premium-Tribute-Video.","Facebook, WhatsApp and X share the Premium result page. Instagram, YouTube and TikTok use your phone’s share sheet when available; otherwise the MP4 downloads first for upload.":"Facebook, WhatsApp und X teilen die Premium-Ergebnisseite. Instagram, YouTube und TikTok verwenden das Teilen-Menü des Telefons; andernfalls wird die MP4 zuerst heruntergeladen.","Premium video link copied.":"Premium-Video-Link kopiert.","Payment is required.":"Eine Zahlung ist erforderlich.","FREE TEST — 0 credits deducted":"KOSTENLOSER TEST — 0 Credits abgezogen","Each recipient image must be 10 MB or smaller.":"Jedes Empfängerbild darf höchstens 10 MB groß sein.","Personal video or voice introduction":"Persönliche Video- oder Sprachvorstellung","Choose Video or Voice Introduction":"Video- oder Sprachvorstellung wählen","Video Introduction":"Video-Einführung","Voice Introduction":"Sprachaufnahme","Record Voice":"Stimme aufnehmen","Start Recording":"Aufnahme starten","Stop Recording":"Aufnahme stoppen","Play Recording":"Aufnahme abspielen","Record Again":"Erneut aufnehmen","Upload Existing Audio":"Vorhandene Audiodatei hochladen","Record in a quiet place and speak clearly. Printo will reduce background noise automatically.":"Nehmen Sie an einem ruhigen Ort auf und sprechen Sie deutlich. Printo reduziert Hintergrundgeräusche automatisch.","Personal introduction video or voice recording":"Persönliches Einführungsvideo oder Sprachaufnahme","Create a powerful personal tribute using the recipient photo, your personal introduction video or voice recording, an original tribute song, names and a heartfelt message.":"Erstellen Sie ein persönliches Tribute mit Empfängerfoto, Einführungsvideo oder Sprachaufnahme, einem eigenen Song, Namen und einer herzlichen Nachricht."},"pt":{"Language":"Idioma","Printo Account":"Conta Printo","Use one verified WhatsApp phone number for one Printo account.":"Use um número de WhatsApp verificado para cada conta Printo.","A verified phone number receives the 100 welcome credits only once. Invented email addresses can no longer create free-credit accounts.":"Um número verificado recebe os 100 créditos de boas-vindas apenas uma vez. E-mails inventados não podem mais criar contas grátis.","Create Account":"Criar conta","Log In":"Entrar","WhatsApp Phone Number":"Número do WhatsApp","Include the country code. The number must be connected to WhatsApp.":"Inclua o código do país. O número deve estar conectado ao WhatsApp.","Verify Number with WhatsApp":"Verificar número com WhatsApp","Tap the button, send the prepared message in WhatsApp, then return here.":"Toque no botão, envie a mensagem preparada no WhatsApp e volte aqui.","Open WhatsApp verification":"Abrir verificação do WhatsApp","Existing Email Address":"E-mail existente","Only for an account created before phone verification was introduced.":"Somente para uma conta criada antes da verificação por telefone.","PIN Number":"Número PIN","Create Account & Receive 100 Credits":"Criar conta e receber 100 créditos","Existing old email account? Log in here":"Conta antiga por e-mail? Entre aqui","Use phone-number login instead":"Usar login por telefone","Log In to My Account":"Entrar na minha conta","Preparing WhatsApp verification...":"Preparando a verificação do WhatsApp...","WhatsApp is opening. Send the prepared PRINTO VERIFY message, then return to this page.":"O WhatsApp está abrindo. Envie a mensagem PRINTO VERIFY preparada e volte a esta página.","Phone number verified. Choose your PIN and create the account.":"Número verificado. Escolha seu PIN e crie a conta.","Verification expired. Tap Verify Number with WhatsApp again.":"A verificação expirou. Toque novamente em Verificar número com WhatsApp.","Verify your WhatsApp phone number first.":"Verifique primeiro seu número do WhatsApp.","Creating your verified account...":"Criando sua conta verificada...","Logging in...":"Entrando...","Success. Opening Printo Studio...":"Sucesso. Abrindo o Printo Studio...","Return to Printo Studio":"Voltar ao Printo Studio","Close / Return to Studio":"Fechar / Voltar ao estúdio","My Videos":"Meus vídeos","Buy Credits / Subscribe":"Comprar créditos / Assinar","Printo Sample":"Amostra Printo","PREMIUM EXPERIENCE":"EXPERIÊNCIA PREMIUM","Personal Tribute Music Video Card":"Cartão musical de homenagem pessoal","Create a powerful personal tribute using the recipient photo, your personal introduction video, an original tribute song, names and a heartfelt message.":"Crie uma homenagem pessoal com a foto do destinatário, seu vídeo de apresentação, uma música original, nomes e uma mensagem sincera.","Recipient photo on screen":"Foto do destinatário na tela","Personal introduction video":"Vídeo de apresentação pessoal","Original tribute song":"Música original de homenagem","Recipient and sender names":"Nomes do destinatário e remetente","Personal message":"Mensagem pessoal","Downloadable finished video":"Vídeo final para download","A beautiful Printo video greeting":"Uma linda saudação em vídeo Printo","RECIPIENT PHOTO":"FOTO DO DESTINATÁRIO","Your special person":"Sua pessoa especial","Personal Tribute":"Homenagem pessoal","Music Video Card":"Cartão de vídeo musical","Personal introduction • Photo • Original song":"Apresentação pessoal • Foto • Música original","Worker will discuss with me":"O atendente conversará comigo","Soft acoustic":"Acústico suave","Other":"Outro","JPG, PNG or WebP. Clear portrait preferred.":"JPG, PNG ou WebP. Retrato nítido recomendado.","Maximum 60 seconds and 100 MB. Large files are compressed automatically to a smaller 720p MP4 before permanent storage.":"Máximo de 60 segundos e 100 MB. Arquivos grandes são comprimidos automaticamente para MP4 720p.","Terms of Use, Privacy Policy and Refund Policy":"Termos de Uso, Política de Privacidade e Política de Reembolso","Please confirm permission and accept the Terms, Privacy and Refund Policy.":"Confirme a permissão e aceite os Termos, a Privacidade e a Política de Reembolso.","Recipient photo must be 10 MB or smaller.":"A foto deve ter 10 MB ou menos.","Introduction video must be 100 MB or smaller.":"O vídeo deve ter 100 MB ou menos.","Introduction video must be 60 seconds or shorter.":"O vídeo deve ter 60 segundos ou menos.","Uploading and compressing your introduction video…":"Enviando e comprimindo seu vídeo de apresentação…","Introduction video compressed and stored safely.":"O vídeo foi comprimido e armazenado com segurança.","Could not save premium order.":"Não foi possível salvar o pedido Premium.","The introduction video could not be read.":"Não foi possível ler o vídeo de apresentação.","Order":"Pedido","Printo Credits & Subscriptions":"Créditos e assinaturas Printo","Each verified phone number receives 100 FREE credits once — enough for 5 standard creations. Each standard creation uses 20 credits.":"Cada número verificado recebe uma vez 100 créditos GRÁTIS, suficientes para 5 criações padrão. Cada criação usa 20 créditos.","Use one universal Printo credit wallet for Standard, Premium Video, and Premium Multi-Image creations.":"Use uma carteira universal de créditos para Padrão, Vídeo Premium e Multi-Imagem Premium.","Standard Greeting Plans":"Planos de saudação padrão","For personalized standard greeting video cards with names, messages, Printo music and voice.":"Para cartões padrão personalizados com nomes, mensagens, música e voz Printo.","STANDARD":"PADRÃO","Single Creation":"Criação única","20 credits • 1 standard creation":"20 créditos • 1 criação padrão","Buy One":"Comprar uma","Monthly":"Mensal","100 credits monthly • 5 standard creations":"100 créditos por mês • 5 criações padrão","Choose Standard Monthly":"Escolher Padrão mensal","6 Months":"6 meses","600 credits • 30 standard creations":"600 créditos • 30 criações padrão","Choose Standard 6 Months":"Escolher Padrão por 6 meses","BEST STANDARD VALUE":"MELHOR VALOR PADRÃO","1 Year":"1 ano","1,200 credits • 60 standard creations":"1.200 créditos • 60 criações padrão","Choose Standard Annual":"Escolher Padrão anual","Premium Subscription Plans":"Planos de assinatura Premium","For Premium Tribute and enhanced personalized video experiences. Credit costs: Standard 20, Premium Video 25, Premium Multi-Image 50.":"Para homenagens Premium e vídeos personalizados. Custos: Padrão 20, Vídeo Premium 25, Multi-Imagem Premium 50.","PREMIUM":"PREMIUM","100 credits now, then 100 credits each active month":"100 créditos agora e depois 100 em cada mês ativo","Choose Premium Monthly":"Escolher Premium mensal","100 credits monthly for 6 months":"100 créditos por mês durante 6 meses","Choose Premium 6 Months":"Escolher Premium por 6 meses","BEST PREMIUM VALUE":"MELHOR VALOR PREMIUM","100 credits monthly for 12 months":"100 créditos por mês durante 12 meses","Choose Premium Annual":"Escolher Premium anual","My Printo Dashboard":"Meu painel Printo","Welcome Bonus: Each verified phone number receives 100 FREE credits once — enough for 5 standard creations.":"Bônus de boas-vindas: cada número verificado recebe uma vez 100 créditos GRÁTIS, suficientes para 5 criações padrão.","Credits":"Créditos","Standard Creations Remaining":"Criações padrão restantes","Plan":"Plano","Free Welcome":"Boas-vindas grátis","Create Another Greeting":"Criar outra saudação","Create Your First Greeting":"Criar sua primeira saudação","My Finished Videos":"Meus vídeos finalizados","Recipient":"Destinatário","Play":"Reproduzir","Download":"Baixar","Your earlier creation record is saved, but its old temporary video file is no longer available. New finished videos will remain here after deployments and restarts.":"O registro anterior está salvo, mas o arquivo temporário antigo não está mais disponível. Novos vídeos permanecerão após implantações e reinícios.","You have not created your first greeting yet. Click Create Your First Greeting to surprise someone special.":"Você ainda não criou sua primeira saudação. Clique em Criar sua primeira saudação para surpreender alguém.","Back to Printo Studio":"Voltar ao Printo Studio","Share Video to YouTube":"Compartilhar vídeo no YouTube","Create Another":"Criar outro","Buy More Credits / Subscribe":"Comprar mais créditos / Assinar","My Videos & Credits":"Meus vídeos e créditos","Nigeria Payment":"Pagamento na Nigéria","Printo Greeting Studio":"Estúdio de Saudações Printo","Share Video to TikTok":"Compartilhar vídeo no TikTok","Download Video":"Baixar vídeo","Email":"E-mail","Share Video to Instagram":"Compartilhar vídeo no Instagram","Copy Short Greeting Link":"Copiar link curto da saudação","Buy via Shopify":"Comprar pela Shopify","Your personalized greeting is ready":"Sua saudação personalizada está pronta","Created for":"Criado para","from":"de","Facebook, WhatsApp and X/Twitter share the short greeting link and preview. Instagram, YouTube and TikTok download the MP4 first; upload the downloaded video in the app and paste the copied short link into the caption or description.":"Facebook, WhatsApp e X/Twitter compartilham o link curto e a prévia. Instagram, YouTube e TikTok baixam primeiro o MP4; envie-o e cole o link na legenda ou descrição.","Please read these rules before uploading photos, videos, voices, names, messages, music instructions, documents, logos, or other content to Printto Studio.":"Leia estas regras antes de enviar fotos, vídeos, vozes, nomes, mensagens, instruções musicais, documentos, logotipos ou outro conteúdo.","1. Your Content and Permission":"1. Seu conteúdo e permissão","You confirm that you own, created, licensed, or received clear permission to use every photograph, video, voice recording, name, message, logo, song, document, or other material you upload.":"Você confirma que possui, criou, licenciou ou recebeu permissão clara para usar cada foto, vídeo, voz, nome, mensagem, logotipo, música, documento ou material.","Do not upload or generate content using another person’s image, video, voice, likeness, or private information without that person’s authorization.":"Não envie nem gere conteúdo usando imagem, vídeo, voz, aparência ou informação privada de outra pessoa sem autorização.","2. User Responsibility":"2. Responsabilidade do usuário","3. Prohibited Content":"3. Conteúdo proibido","4. Privacy and Uploaded Files":"4. Privacidade e arquivos enviados","5. AI and Creative Output":"5. IA e resultado criativo","6. Credits and Memberships":"6. Créditos e assinaturas","7. Final Sale and No-Return Policy":"7. Venda final e sem devolução","8. Technical Generation Problems":"8. Problemas técnicos de geração","9. Limitation of Responsibility":"9. Limitação de responsabilidade","10. Policy Enforcement and Updates":"10. Aplicação e atualizações","All Rights Reserved.":"Todos os direitos reservados.","You are solely responsible for your uploads and the instructions you provide. PATAPATA LLC does not authorize impersonation, harassment, defamation, copyright infringement, privacy violations, misleading endorsements, or unlawful use of another person’s identity.":"Você é o único responsável pelos arquivos e instruções. A PATAPATA LLC não autoriza falsidade de identidade, assédio, difamação, violação de direitos autorais ou privacidade, endossos enganosos ou uso ilegal da identidade alheia.","PATAPATA LLC may reject, suspend, remove, or report content or accounts that appear illegal, abusive, deceptive, unsafe, or unauthorized.":"A PATAPATA LLC pode rejeitar, suspender, remover ou denunciar conteúdo ou contas que pareçam ilegais, abusivos, enganosos, inseguros ou não autorizados.","Content involving exploitation, threats, hate, harassment, violence, or illegal activity.":"Conteúdo com exploração, ameaças, ódio, assédio, violência ou atividade ilegal.","Sexually explicit content or content that exploits or endangers minors.":"Conteúdo sexualmente explícito ou que explore ou coloque menores em risco.","Unauthorized copyrighted material, trademarks, private records, or confidential information.":"Material protegido, marcas, registros privados ou informações confidenciais sem autorização.","False impersonation, fraud, scams, or content intended to deceive the public.":"Falsa identidade, fraude, golpes ou conteúdo destinado a enganar o público.","Names, contact details, photos, videos, messages, and other uploaded files may be processed and temporarily stored to create the requested service, operate customer accounts, prevent abuse, complete payments, troubleshoot failures, and provide support.":"Nomes, contatos, fotos, vídeos, mensagens e outros arquivos podem ser processados e armazenados temporariamente para criar o serviço, operar contas, evitar abusos, concluir pagamentos, resolver falhas e oferecer suporte.","PATAPATA LLC does not sell customer personal information. Customers should avoid uploading unnecessary sensitive information.":"A PATAPATA LLC não vende informações pessoais dos clientes. Evite enviar informações sensíveis desnecessárias.","AI-generated or automatically assembled results may contain variations. You must review names, spelling, messages, photos, video selections, and instructions before submitting. Minor creative differences that do not prevent delivery are not generation failures.":"Resultados gerados por IA ou montados automaticamente podem variar. Revise nomes, ortografia, mensagens, fotos, vídeos e instruções. Pequenas diferenças que não impeçam a entrega não são falhas.","Credits are deducted when a generation or eligible service begins. Membership credits are released according to the selected plan. Prices, credit costs, available features, and processing times may be updated for future purchases.":"Os créditos são deduzidos quando uma geração ou serviço elegível começa. Créditos de assinatura são liberados conforme o plano. Preços, custos, recursos e prazos podem mudar.","Because each video is custom-generated using customer-provided information and computing resources, a successfully generated video is final and non-returnable. No refund is provided after successful generation merely because the customer changes their mind, dislikes a creative preference, or supplied incorrect information.":"Como cada vídeo é gerado sob medida com informações do cliente e recursos computacionais, um vídeo gerado com sucesso é final e não retornável. Não há reembolso por mudança de opinião, preferência ou dados incorretos.","If a verified technical problem caused the generation not to work, produced no usable video, or prevented delivery, contact a Printto Support Agent promptly. After reviewing the issue, PATAPATA LLC may fix and regenerate the video, restore the affected credits, or provide another appropriate resolution.":"Se um problema técnico verificado impedir a geração, não produzir vídeo utilizável ou impedir a entrega, contate o suporte Printo. A PATAPATA LLC pode corrigir, gerar novamente, restaurar créditos ou oferecer outra solução.","A refund, when legally required or approved by PATAPATA LLC, is considered only after support has had a reasonable opportunity to investigate and correct the technical problem.":"Um reembolso, quando exigido por lei ou aprovado, só é considerado após o suporte ter oportunidade razoável de investigar e corrigir o problema.","To the extent permitted by law, PATAPATA LLC is not responsible for claims, losses, or disputes caused by unauthorized uploads, customer mistakes, infringement by a user, third-party platforms, internet interruptions, or circumstances outside our reasonable control.":"Na medida permitida por lei, a PATAPATA LLC não é responsável por reclamações, perdas ou disputas causadas por arquivos não autorizados, erros, violações, plataformas terceiras, falhas de internet ou circunstâncias fora do controle.","We may refuse service or restrict access when necessary to protect people, intellectual property, privacy, platform security, or legal compliance. Updated terms apply to future use after they are posted on this page.":"Podemos recusar serviço ou restringir acesso para proteger pessoas, propriedade intelectual, privacidade, segurança ou conformidade legal. Termos atualizados se aplicam após a publicação.","For a failed generation or another service problem, use the Worker Help or Support Agent option in Printto Studio before requesting a refund.":"Em caso de falha ou outro problema, use Ajuda do trabalhador ou Agente de suporte no Printo Studio antes de pedir reembolso.","4–8 numbers":"4–8 números","Could not check verification.":"Não foi possível verificar a confirmação.","Could not start verification.":"Não foi possível iniciar a verificação.","Account request failed":"A solicitação da conta falhou","First verified-account test FREE • Then 50 credits or $14.99":"Primeiro teste GRÁTIS para conta verificada • Depois, 50 créditos ou US$ 14,99","Premium Multi-Image Flip Tribute":"Homenagem Premium com várias imagens","Upload 2–8 recipient photos. After the personal introduction ends, the images flip one after another while the custom tribute music plays.":"Envie de 2 a 8 fotos do destinatário. Quando a apresentação pessoal terminar, as imagens mudarão uma após a outra enquanto a música personalizada toca.","2–8 recipient photos":"2–8 fotos do destinatário","Flip-style image transitions":"Transições de imagens em estilo flip","Custom tribute music":"Música personalizada de homenagem","First verified-account test is FREE":"O primeiro teste de uma conta verificada é GRÁTIS","After the free test: 50 credits or $14.99":"Após o teste grátis: 50 créditos ou US$ 14,99","Share and download page":"Página para compartilhar e baixar","Create Multi-Image Flip":"Criar vídeo com várias imagens","Premium Creation Prices & Subscription Plans":"Preços de criações Premium e assinaturas","Each Premium service has its own separate creation price in the universal Printo credit wallet.":"Cada serviço Premium tem seu próprio preço de criação na carteira universal de créditos Printo.","PREMIUM VIDEO":"VÍDEO PREMIUM","Personal Tribute Video":"Vídeo de homenagem pessoal","25 Credits":"25 créditos","1 recipient photo • introduction video • custom music":"1 foto do destinatário • vídeo de apresentação • música personalizada","Create Premium Video":"Criar vídeo Premium","MULTI-IMAGE FLIP":"VÁRIAS IMAGENS","Premium Multi-Image":"Premium Multi-Imagem","First verified-account test FREE • then 50 credits • 2–8 photos • flip transitions • introduction • custom music":"Primeiro teste GRÁTIS para conta verificada • depois 50 créditos • 2–8 fotos • transições • apresentação • música personalizada","Use Free Test / Create":"Usar teste grátis / Criar","Buy 50 Credits":"Comprar 50 créditos","Each verified phone number receives 100 FREE universal credits once, plus one FREE Multi-Image Flip test worth 50 credits. After the free Multi-Image test, each Multi-Image creation costs 50 credits or $14.99.":"Cada número verificado recebe uma vez 100 créditos universais GRÁTIS, mais um teste GRÁTIS de Multi-Imagem no valor de 50 créditos. Depois, cada criação custa 50 créditos ou US$ 14,99.","Welcome Bonus: 100 FREE universal credits plus one FREE Multi-Image Flip test worth 50 credits for each verified phone account.":"Bônus de boas-vindas: 100 créditos universais GRÁTIS mais um teste GRÁTIS de Multi-Imagem no valor de 50 créditos para cada conta de telefone verificada.","Free Multi-Image Test":"Teste grátis de Multi-Imagem","Available":"Disponível","Used":"Usado","Premium Multi-Image Flip Video":"Vídeo Premium Multi-Imagem","Premium video is not ready yet.":"O vídeo Premium ainda não está pronto.","Return to My Videos and try again after rendering is complete.":"Volte para Meus vídeos e tente novamente após a conclusão da renderização.","A personalized Printo Premium tribute video.":"Um vídeo Premium personalizado de homenagem Printo.","Facebook, WhatsApp and X share the Premium result page. Instagram, YouTube and TikTok use your phone’s share sheet when available; otherwise the MP4 downloads first for upload.":"Facebook, WhatsApp e X compartilham a página do resultado Premium. Instagram, YouTube e TikTok usam o menu de compartilhamento do telefone; caso contrário, o MP4 é baixado primeiro.","Premium video link copied.":"Link do vídeo Premium copiado.","Payment is required.":"É necessário pagamento.","FREE TEST — 0 credits deducted":"TESTE GRÁTIS — 0 créditos descontados","Each recipient image must be 10 MB or smaller.":"Cada imagem do destinatário deve ter 10 MB ou menos.","Personal video or voice introduction":"Introdução pessoal em vídeo ou voz","Choose Video or Voice Introduction":"Escolha introdução em vídeo ou voz","Video Introduction":"Introdução em vídeo","Voice Introduction":"Introdução por voz","Record Voice":"Gravar voz","Start Recording":"Iniciar gravação","Stop Recording":"Parar gravação","Play Recording":"Reproduzir gravação","Record Again":"Gravar novamente","Upload Existing Audio":"Enviar áudio existente","Record in a quiet place and speak clearly. Printo will reduce background noise automatically.":"Grave em um local silencioso e fale claramente. O Printo reduzirá automaticamente o ruído de fundo.","Personal introduction video or voice recording":"Vídeo de apresentação pessoal ou gravação de voz","Create a powerful personal tribute using the recipient photo, your personal introduction video or voice recording, an original tribute song, names and a heartfelt message.":"Crie uma homenagem pessoal com a foto do destinatário, seu vídeo de apresentação ou gravação de voz, uma música original, nomes e uma mensagem sincera."},"ar":{"Language":"اللغة","Printo Account":"حساب Printo","Use one verified WhatsApp phone number for one Printo account.":"استخدم رقم واتساب موثّقًا واحدًا لكل حساب Printo.","A verified phone number receives the 100 welcome credits only once. Invented email addresses can no longer create free-credit accounts.":"يحصل الرقم الموثّق على 100 رصيد ترحيبي مرة واحدة فقط. لم يعد البريد الوهمي ينشئ حسابات مجانية.","Create Account":"إنشاء حساب","Log In":"تسجيل الدخول","WhatsApp Phone Number":"رقم واتساب","Include the country code. The number must be connected to WhatsApp.":"أدخل رمز الدولة. يجب أن يكون الرقم مرتبطًا بواتساب.","Verify Number with WhatsApp":"توثيق الرقم عبر واتساب","Tap the button, send the prepared message in WhatsApp, then return here.":"اضغط الزر وأرسل الرسالة الجاهزة في واتساب ثم عد إلى هنا.","Open WhatsApp verification":"فتح توثيق واتساب","Existing Email Address":"البريد الإلكتروني الحالي","Only for an account created before phone verification was introduced.":"فقط للحسابات التي أُنشئت قبل توثيق الهاتف.","PIN Number":"رقم PIN","Create Account & Receive 100 Credits":"إنشاء الحساب واستلام 100 رصيد","Existing old email account? Log in here":"لديك حساب بريد قديم؟ سجّل الدخول هنا","Use phone-number login instead":"استخدام تسجيل الدخول بالهاتف","Log In to My Account":"تسجيل الدخول إلى حسابي","Preparing WhatsApp verification...":"جارٍ إعداد توثيق واتساب...","WhatsApp is opening. Send the prepared PRINTO VERIFY message, then return to this page.":"يتم فتح واتساب. أرسل رسالة PRINTO VERIFY الجاهزة ثم عد إلى الصفحة.","Phone number verified. Choose your PIN and create the account.":"تم توثيق رقم الهاتف. اختر رقم PIN وأنشئ الحساب.","Verification expired. Tap Verify Number with WhatsApp again.":"انتهت صلاحية التوثيق. اضغط توثيق الرقم مرة أخرى.","Verify your WhatsApp phone number first.":"وثّق رقم واتساب أولًا.","Creating your verified account...":"جارٍ إنشاء حسابك الموثّق...","Logging in...":"جارٍ تسجيل الدخول...","Success. Opening Printo Studio...":"تم بنجاح. جارٍ فتح استوديو Printo...","Return to Printo Studio":"العودة إلى استوديو Printo","Close / Return to Studio":"إغلاق / العودة إلى الاستوديو","My Videos":"فيديوهاتي","Buy Credits / Subscribe":"شراء رصيد / اشتراك","Printo Sample":"نموذج Printo","PREMIUM EXPERIENCE":"تجربة PREMIUM","Personal Tribute Music Video Card":"بطاقة فيديو موسيقية لتكريم شخصي","Create a powerful personal tribute using the recipient photo, your personal introduction video, an original tribute song, names and a heartfelt message.":"أنشئ تكريمًا شخصيًا باستخدام صورة المستلم وفيديو تقديمك وأغنية أصلية والأسماء ورسالة صادقة.","Recipient photo on screen":"صورة المستلم على الشاشة","Personal introduction video":"فيديو تقديم شخصي","Original tribute song":"أغنية تكريم أصلية","Recipient and sender names":"أسماء المستلم والمرسل","Personal message":"رسالة شخصية","Downloadable finished video":"فيديو نهائي قابل للتنزيل","A beautiful Printo video greeting":"تهنئة فيديو جميلة من Printo","RECIPIENT PHOTO":"صورة المستلم","Your special person":"شخصك المميز","Personal Tribute":"تكريم شخصي","Music Video Card":"بطاقة فيديو موسيقية","Personal introduction • Photo • Original song":"تقديم شخصي • صورة • أغنية أصلية","Worker will discuss with me":"سيتحدث الموظف معي","Soft acoustic":"موسيقى هادئة","Other":"أخرى","JPG, PNG or WebP. Clear portrait preferred.":"JPG أو PNG أو WebP. يُفضّل أن تكون الصورة واضحة.","Maximum 60 seconds and 100 MB. Large files are compressed automatically to a smaller 720p MP4 before permanent storage.":"الحد الأقصى 60 ثانية و100 ميغابايت. تُضغط الملفات الكبيرة تلقائيًا إلى MP4 بدقة 720p.","Terms of Use, Privacy Policy and Refund Policy":"شروط الاستخدام وسياسة الخصوصية وسياسة الاسترداد","Please confirm permission and accept the Terms, Privacy and Refund Policy.":"يرجى تأكيد الإذن والموافقة على الشروط والخصوصية وسياسة الاسترداد.","Recipient photo must be 10 MB or smaller.":"يجب ألا تتجاوز الصورة 10 ميغابايت.","Introduction video must be 100 MB or smaller.":"يجب ألا يتجاوز الفيديو 100 ميغابايت.","Introduction video must be 60 seconds or shorter.":"يجب ألا يتجاوز الفيديو 60 ثانية.","Uploading and compressing your introduction video…":"جارٍ رفع وضغط فيديو التقديم…","Introduction video compressed and stored safely.":"تم ضغط الفيديو وتخزينه بأمان.","Could not save premium order.":"تعذر حفظ طلب Premium.","The introduction video could not be read.":"تعذر قراءة فيديو التقديم.","Order":"الطلب","Printo Credits & Subscriptions":"أرصدة واشتراكات Printo","Each verified phone number receives 100 FREE credits once — enough for 5 standard creations. Each standard creation uses 20 credits.":"يحصل كل رقم موثّق على 100 رصيد مجاني مرة واحدة، تكفي لـ5 إنشاءات قياسية. يستخدم كل إنشاء 20 رصيدًا.","Use one universal Printo credit wallet for Standard, Premium Video, and Premium Multi-Image creations.":"استخدم محفظة رصيد واحدة للقياسي وفيديو Premium وPremium متعدد الصور.","Standard Greeting Plans":"خطط التهنئة القياسية","For personalized standard greeting video cards with names, messages, Printo music and voice.":"لبطاقات قياسية مخصصة بالأسماء والرسائل وموسيقى وصوت Printo.","STANDARD":"قياسي","Single Creation":"إنشاء واحد","20 credits • 1 standard creation":"20 رصيدًا • إنشاء قياسي واحد","Buy One":"شراء واحد","Monthly":"شهري","100 credits monthly • 5 standard creations":"100 رصيد شهريًا • 5 إنشاءات قياسية","Choose Standard Monthly":"اختيار القياسي الشهري","6 Months":"6 أشهر","600 credits • 30 standard creations":"600 رصيد • 30 إنشاءً قياسيًا","Choose Standard 6 Months":"اختيار القياسي لمدة 6 أشهر","BEST STANDARD VALUE":"أفضل قيمة قياسية","1 Year":"سنة واحدة","1,200 credits • 60 standard creations":"1200 رصيد • 60 إنشاءً قياسيًا","Choose Standard Annual":"اختيار القياسي السنوي","Premium Subscription Plans":"خطط اشتراك Premium","For Premium Tribute and enhanced personalized video experiences. Credit costs: Standard 20, Premium Video 25, Premium Multi-Image 50.":"لتكريمات Premium والفيديوهات المخصصة. التكلفة: القياسي 20، فيديو Premium 25، متعدد الصور 50.","PREMIUM":"PREMIUM","100 credits now, then 100 credits each active month":"100 رصيد الآن ثم 100 في كل شهر نشط","Choose Premium Monthly":"اختيار Premium الشهري","100 credits monthly for 6 months":"100 رصيد شهريًا لمدة 6 أشهر","Choose Premium 6 Months":"اختيار Premium لمدة 6 أشهر","BEST PREMIUM VALUE":"أفضل قيمة PREMIUM","100 credits monthly for 12 months":"100 رصيد شهريًا لمدة 12 شهرًا","Choose Premium Annual":"اختيار Premium السنوي","My Printo Dashboard":"لوحة تحكم Printo","Welcome Bonus: Each verified phone number receives 100 FREE credits once — enough for 5 standard creations.":"مكافأة الترحيب: يحصل كل رقم موثّق على 100 رصيد مجاني مرة واحدة تكفي لـ5 إنشاءات قياسية.","Credits":"الأرصدة","Standard Creations Remaining":"الإنشاءات القياسية المتبقية","Plan":"الخطة","Free Welcome":"ترحيب مجاني","Create Another Greeting":"إنشاء تهنئة أخرى","Create Your First Greeting":"إنشاء أول تهنئة","My Finished Videos":"فيديوهاتي المكتملة","Recipient":"المستلم","Play":"تشغيل","Download":"تنزيل","Your earlier creation record is saved, but its old temporary video file is no longer available. New finished videos will remain here after deployments and restarts.":"تم حفظ السجل السابق، لكن ملف الفيديو المؤقت القديم لم يعد متاحًا. ستبقى الفيديوهات الجديدة بعد النشر وإعادة التشغيل.","You have not created your first greeting yet. Click Create Your First Greeting to surprise someone special.":"لم تنشئ أول تهنئة بعد. اضغط إنشاء أول تهنئة لمفاجأة شخص مميز.","Back to Printo Studio":"العودة إلى استوديو Printo","Share Video to YouTube":"مشاركة الفيديو على YouTube","Create Another":"إنشاء آخر","Buy More Credits / Subscribe":"شراء المزيد من الأرصدة / اشتراك","My Videos & Credits":"فيديوهاتي وأرصدتي","Nigeria Payment":"الدفع في نيجيريا","Printo Greeting Studio":"استوديو تهاني Printo","Share Video to TikTok":"مشاركة الفيديو على TikTok","Download Video":"تنزيل الفيديو","Email":"البريد الإلكتروني","Share Video to Instagram":"مشاركة الفيديو على Instagram","Copy Short Greeting Link":"نسخ رابط التهنئة القصير","Buy via Shopify":"الشراء عبر Shopify","Your personalized greeting is ready":"تهنئتك المخصصة جاهزة","Created for":"أُنشئت من أجل","from":"من","Facebook, WhatsApp and X/Twitter share the short greeting link and preview. Instagram, YouTube and TikTok download the MP4 first; upload the downloaded video in the app and paste the copied short link into the caption or description.":"يشارك Facebook وWhatsApp وX/Twitter الرابط القصير والمعاينة. يقوم Instagram وYouTube وTikTok بتنزيل MP4 أولًا؛ ارفع الفيديو والصق الرابط في التعليق أو الوصف.","Please read these rules before uploading photos, videos, voices, names, messages, music instructions, documents, logos, or other content to Printto Studio.":"اقرأ هذه القواعد قبل رفع الصور أو الفيديوهات أو الأصوات أو الأسماء أو الرسائل أو تعليمات الموسيقى أو المستندات أو الشعارات أو أي محتوى آخر.","1. Your Content and Permission":"1. محتواك والإذن","You confirm that you own, created, licensed, or received clear permission to use every photograph, video, voice recording, name, message, logo, song, document, or other material you upload.":"تؤكد أنك تملك أو أنشأت أو حصلت على ترخيص أو إذن واضح لاستخدام كل صورة وفيديو وصوت واسم ورسالة وشعار وأغنية ومستند أو مادة.","Do not upload or generate content using another person’s image, video, voice, likeness, or private information without that person’s authorization.":"لا ترفع أو تنشئ محتوى يستخدم صورة أو فيديو أو صوت أو مظهر أو معلومات خاصة لشخص آخر دون إذنه.","2. User Responsibility":"2. مسؤولية المستخدم","3. Prohibited Content":"3. المحتوى المحظور","4. Privacy and Uploaded Files":"4. الخصوصية والملفات المرفوعة","5. AI and Creative Output":"5. الذكاء الاصطناعي والنتيجة الإبداعية","6. Credits and Memberships":"6. الأرصدة والعضويات","7. Final Sale and No-Return Policy":"7. البيع النهائي وعدم الإرجاع","8. Technical Generation Problems":"8. مشكلات الإنشاء التقنية","9. Limitation of Responsibility":"9. تحديد المسؤولية","10. Policy Enforcement and Updates":"10. تطبيق السياسة والتحديثات","All Rights Reserved.":"جميع الحقوق محفوظة.","You are solely responsible for your uploads and the instructions you provide. PATAPATA LLC does not authorize impersonation, harassment, defamation, copyright infringement, privacy violations, misleading endorsements, or unlawful use of another person’s identity.":"أنت المسؤول وحدك عن الملفات والتعليمات. لا تسمح PATAPATA LLC بانتحال الهوية أو المضايقة أو التشهير أو انتهاك حقوق النشر أو الخصوصية أو التأييد المضلل أو الاستخدام غير القانوني لهوية الآخرين.","PATAPATA LLC may reject, suspend, remove, or report content or accounts that appear illegal, abusive, deceptive, unsafe, or unauthorized.":"يجوز لـPATAPATA LLC رفض أو تعليق أو إزالة أو الإبلاغ عن محتوى أو حسابات تبدو غير قانونية أو مسيئة أو خادعة أو غير آمنة أو غير مصرح بها.","Content involving exploitation, threats, hate, harassment, violence, or illegal activity.":"المحتوى الذي يتضمن استغلالًا أو تهديدات أو كراهية أو مضايقة أو عنفًا أو نشاطًا غير قانوني.","Sexually explicit content or content that exploits or endangers minors.":"المحتوى الجنسي الصريح أو الذي يستغل القاصرين أو يعرضهم للخطر.","Unauthorized copyrighted material, trademarks, private records, or confidential information.":"المواد المحمية بحقوق نشر أو العلامات التجارية أو السجلات الخاصة أو المعلومات السرية دون إذن.","False impersonation, fraud, scams, or content intended to deceive the public.":"انتحال الهوية أو الاحتيال أو الخداع أو المحتوى المقصود به تضليل الجمهور.","Names, contact details, photos, videos, messages, and other uploaded files may be processed and temporarily stored to create the requested service, operate customer accounts, prevent abuse, complete payments, troubleshoot failures, and provide support.":"قد تتم معالجة الأسماء وبيانات الاتصال والصور والفيديوهات والرسائل والملفات الأخرى وتخزينها مؤقتًا لإنشاء الخدمة وإدارة الحسابات ومنع إساءة الاستخدام وإتمام المدفوعات وحل الأعطال وتقديم الدعم.","PATAPATA LLC does not sell customer personal information. Customers should avoid uploading unnecessary sensitive information.":"لا تبيع PATAPATA LLC المعلومات الشخصية للعملاء. تجنب رفع معلومات حساسة غير ضرورية.","AI-generated or automatically assembled results may contain variations. You must review names, spelling, messages, photos, video selections, and instructions before submitting. Minor creative differences that do not prevent delivery are not generation failures.":"قد تختلف النتائج التي ينشئها الذكاء الاصطناعي أو تُجمع تلقائيًا. راجع الأسماء والتهجئة والرسائل والصور والفيديوهات والتعليمات. الاختلافات البسيطة التي لا تمنع التسليم ليست أعطالًا.","Credits are deducted when a generation or eligible service begins. Membership credits are released according to the selected plan. Prices, credit costs, available features, and processing times may be updated for future purchases.":"تُخصم الأرصدة عند بدء الإنشاء أو الخدمة المؤهلة. تُمنح أرصدة العضوية حسب الخطة. قد تتغير الأسعار والتكاليف والميزات وأوقات المعالجة.","Because each video is custom-generated using customer-provided information and computing resources, a successfully generated video is final and non-returnable. No refund is provided after successful generation merely because the customer changes their mind, dislikes a creative preference, or supplied incorrect information.":"لأن كل فيديو يُنشأ خصيصًا باستخدام معلومات العميل وموارد الحوسبة، فإن الفيديو الناجح نهائي وغير قابل للإرجاع. لا يتم رد الأموال بسبب تغيير الرأي أو التفضيل أو المعلومات غير الصحيحة.","If a verified technical problem caused the generation not to work, produced no usable video, or prevented delivery, contact a Printto Support Agent promptly. After reviewing the issue, PATAPATA LLC may fix and regenerate the video, restore the affected credits, or provide another appropriate resolution.":"إذا تسبب عطل تقني موثّق في فشل الإنشاء أو عدم إنتاج فيديو صالح أو منع التسليم، فاتصل بدعم Printo. قد تقوم PATAPATA LLC بالإصلاح وإعادة الإنشاء أو استعادة الأرصدة أو تقديم حل آخر.","A refund, when legally required or approved by PATAPATA LLC, is considered only after support has had a reasonable opportunity to investigate and correct the technical problem.":"لا يُنظر في الاسترداد، عندما يكون مطلوبًا قانونيًا أو معتمدًا، إلا بعد منح الدعم فرصة معقولة للتحقيق والتصحيح.","To the extent permitted by law, PATAPATA LLC is not responsible for claims, losses, or disputes caused by unauthorized uploads, customer mistakes, infringement by a user, third-party platforms, internet interruptions, or circumstances outside our reasonable control.":"في حدود ما يسمح به القانون، لا تتحمل PATAPATA LLC مسؤولية المطالبات أو الخسائر أو النزاعات الناتجة عن رفع غير مصرح أو أخطاء أو انتهاكات أو منصات خارجية أو انقطاع الإنترنت أو ظروف خارج السيطرة.","We may refuse service or restrict access when necessary to protect people, intellectual property, privacy, platform security, or legal compliance. Updated terms apply to future use after they are posted on this page.":"يجوز لنا رفض الخدمة أو تقييد الوصول لحماية الأشخاص أو الملكية الفكرية أو الخصوصية أو الأمن أو الامتثال القانوني. تنطبق الشروط المحدثة بعد نشرها.","For a failed generation or another service problem, use the Worker Help or Support Agent option in Printto Studio before requesting a refund.":"عند فشل الإنشاء أو وجود مشكلة، استخدم مساعدة الموظف أو وكيل الدعم في استوديو Printo قبل طلب الاسترداد.","4–8 numbers":"من 4 إلى 8 أرقام","Could not check verification.":"تعذر التحقق من حالة التوثيق.","Could not start verification.":"تعذر بدء التوثيق.","Account request failed":"فشل طلب الحساب","First verified-account test FREE • Then 50 credits or $14.99":"الاختبار الأول للحساب الموثّق مجانًا • بعد ذلك 50 رصيدًا أو 14.99 دولارًا","Premium Multi-Image Flip Tribute":"تكريم Premium متعدد الصور","Upload 2–8 recipient photos. After the personal introduction ends, the images flip one after another while the custom tribute music plays.":"ارفع من صورتين إلى 8 صور للمستلم. بعد انتهاء فيديو التقديم، تتبدل الصور واحدة تلو الأخرى أثناء تشغيل موسيقى التكريم المخصصة.","2–8 recipient photos":"من صورتين إلى 8 صور للمستلم","Flip-style image transitions":"انتقالات صور بأسلوب التقليب","Custom tribute music":"موسيقى تكريم مخصصة","First verified-account test is FREE":"الاختبار الأول للحساب الموثّق مجاني","After the free test: 50 credits or $14.99":"بعد الاختبار المجاني: 50 رصيدًا أو 14.99 دولارًا","Share and download page":"صفحة للمشاركة والتنزيل","Create Multi-Image Flip":"إنشاء فيديو متعدد الصور","Premium Creation Prices & Subscription Plans":"أسعار إنشاءات Premium وخطط الاشتراك","Each Premium service has its own separate creation price in the universal Printo credit wallet.":"لكل خدمة Premium سعر إنشاء مستقل داخل محفظة أرصدة Printo الموحدة.","PREMIUM VIDEO":"فيديو PREMIUM","Personal Tribute Video":"فيديو تكريم شخصي","25 Credits":"25 رصيدًا","1 recipient photo • introduction video • custom music":"صورة واحدة للمستلم • فيديو تقديم • موسيقى مخصصة","Create Premium Video":"إنشاء فيديو Premium","MULTI-IMAGE FLIP":"فيديو متعدد الصور","Premium Multi-Image":"Premium متعدد الصور","First verified-account test FREE • then 50 credits • 2–8 photos • flip transitions • introduction • custom music":"الاختبار الأول للحساب الموثّق مجانًا • ثم 50 رصيدًا • 2–8 صور • انتقالات • تقديم • موسيقى مخصصة","Use Free Test / Create":"استخدام الاختبار المجاني / إنشاء","Buy 50 Credits":"شراء 50 رصيدًا","Each verified phone number receives 100 FREE universal credits once, plus one FREE Multi-Image Flip test worth 50 credits. After the free Multi-Image test, each Multi-Image creation costs 50 credits or $14.99.":"يحصل كل رقم موثّق مرة واحدة على 100 رصيد موحد مجاني، بالإضافة إلى اختبار مجاني متعدد الصور بقيمة 50 رصيدًا. بعده، يكلف كل إنشاء 50 رصيدًا أو 14.99 دولارًا.","Welcome Bonus: 100 FREE universal credits plus one FREE Multi-Image Flip test worth 50 credits for each verified phone account.":"مكافأة الترحيب: 100 رصيد موحد مجاني بالإضافة إلى اختبار مجاني متعدد الصور بقيمة 50 رصيدًا لكل حساب هاتف موثّق.","Free Multi-Image Test":"اختبار مجاني متعدد الصور","Available":"متاح","Used":"مستخدم","Premium Multi-Image Flip Video":"فيديو Premium متعدد الصور","Premium video is not ready yet.":"فيديو Premium غير جاهز بعد.","Return to My Videos and try again after rendering is complete.":"عد إلى فيديوهاتي وحاول مرة أخرى بعد اكتمال المعالجة.","A personalized Printo Premium tribute video.":"فيديو تكريم Premium مخصص من Printo.","Facebook, WhatsApp and X share the Premium result page. Instagram, YouTube and TikTok use your phone’s share sheet when available; otherwise the MP4 downloads first for upload.":"يشارك Facebook وWhatsApp وX صفحة نتيجة Premium. يستخدم Instagram وYouTube وTikTok قائمة المشاركة في الهاتف، وإلا يتم تنزيل ملف MP4 أولًا.","Premium video link copied.":"تم نسخ رابط فيديو Premium.","Payment is required.":"الدفع مطلوب.","FREE TEST — 0 credits deducted":"اختبار مجاني — لم يُخصم أي رصيد","Each recipient image must be 10 MB or smaller.":"يجب ألا يتجاوز حجم كل صورة للمستلم 10 ميغابايت.","Personal video or voice introduction":"تقديم شخصي بالفيديو أو التسجيل الصوتي","Choose Video or Voice Introduction":"اختر تقديمًا بالفيديو أو بالصوت","Video Introduction":"تقديم بالفيديو","Voice Introduction":"تقديم صوتي","Record Voice":"تسجيل الصوت","Start Recording":"بدء التسجيل","Stop Recording":"إيقاف التسجيل","Play Recording":"تشغيل التسجيل","Record Again":"التسجيل مرة أخرى","Upload Existing Audio":"رفع ملف صوتي موجود","Record in a quiet place and speak clearly. Printo will reduce background noise automatically.":"سجّل في مكان هادئ وتحدث بوضوح. سيقلل Printo ضوضاء الخلفية تلقائيًا.","Personal introduction video or voice recording":"فيديو تقديم شخصي أو تسجيل صوتي","Create a powerful personal tribute using the recipient photo, your personal introduction video or voice recording, an original tribute song, names and a heartfelt message.":"أنشئ تكريمًا شخصيًا باستخدام صورة المستلم وفيديو التقديم أو التسجيل الصوتي وأغنية أصلية والأسماء ورسالة مؤثرة."},"zh":{"Language":"语言","Printo Account":"Printo 账户","Use one verified WhatsApp phone number for one Printo account.":"每个 Printo 账户使用一个已验证的 WhatsApp 号码。","A verified phone number receives the 100 welcome credits only once. Invented email addresses can no longer create free-credit accounts.":"每个已验证号码只能领取一次 100 个欢迎积分，虚假电子邮件不能再创建免费账户。","Create Account":"创建账户","Log In":"登录","WhatsApp Phone Number":"WhatsApp 电话号码","Include the country code. The number must be connected to WhatsApp.":"请包含国家代码，该号码必须已连接 WhatsApp。","Verify Number with WhatsApp":"通过 WhatsApp 验证号码","Tap the button, send the prepared message in WhatsApp, then return here.":"点击按钮，在 WhatsApp 中发送准备好的消息，然后返回。","Open WhatsApp verification":"打开 WhatsApp 验证","Existing Email Address":"现有电子邮件地址","Only for an account created before phone verification was introduced.":"仅用于启用电话验证之前创建的账户。","PIN Number":"PIN 码","Create Account & Receive 100 Credits":"创建账户并领取 100 积分","Existing old email account? Log in here":"已有旧电子邮件账户？在此登录","Use phone-number login instead":"改用电话号码登录","Log In to My Account":"登录我的账户","Preparing WhatsApp verification...":"正在准备 WhatsApp 验证……","WhatsApp is opening. Send the prepared PRINTO VERIFY message, then return to this page.":"正在打开 WhatsApp。发送准备好的 PRINTO VERIFY 消息，然后返回此页面。","Phone number verified. Choose your PIN and create the account.":"电话号码已验证。请选择 PIN 并创建账户。","Verification expired. Tap Verify Number with WhatsApp again.":"验证已过期。请再次点击通过 WhatsApp 验证号码。","Verify your WhatsApp phone number first.":"请先验证您的 WhatsApp 号码。","Creating your verified account...":"正在创建已验证账户……","Logging in...":"正在登录……","Success. Opening Printo Studio...":"成功。正在打开 Printo Studio……","Return to Printo Studio":"返回 Printo Studio","Close / Return to Studio":"关闭 / 返回工作室","My Videos":"我的视频","Buy Credits / Subscribe":"购买积分 / 订阅","Printo Sample":"Printo 示例","PREMIUM EXPERIENCE":"高级体验","Personal Tribute Music Video Card":"个人致敬音乐视频贺卡","Create a powerful personal tribute using the recipient photo, your personal introduction video, an original tribute song, names and a heartfelt message.":"使用收件人照片、个人介绍视频、原创歌曲、姓名和真挚留言制作个人致敬视频。","Recipient photo on screen":"屏幕显示收件人照片","Personal introduction video":"个人介绍视频","Original tribute song":"原创致敬歌曲","Recipient and sender names":"收件人与发件人姓名","Personal message":"个人留言","Downloadable finished video":"可下载的完成视频","A beautiful Printo video greeting":"精美的 Printo 祝福视频","RECIPIENT PHOTO":"收件人照片","Your special person":"您特别的人","Personal Tribute":"个人致敬","Music Video Card":"音乐视频贺卡","Personal introduction • Photo • Original song":"个人介绍 • 照片 • 原创歌曲","Worker will discuss with me":"工作人员会与我沟通","Soft acoustic":"轻柔原声","Other":"其他","JPG, PNG or WebP. Clear portrait preferred.":"支持 JPG、PNG 或 WebP，建议使用清晰人像。","Maximum 60 seconds and 100 MB. Large files are compressed automatically to a smaller 720p MP4 before permanent storage.":"最长 60 秒、最大 100 MB。大文件会自动压缩为较小的 720p MP4。","Terms of Use, Privacy Policy and Refund Policy":"使用条款、隐私政策和退款政策","Please confirm permission and accept the Terms, Privacy and Refund Policy.":"请确认授权并接受条款、隐私和退款政策。","Recipient photo must be 10 MB or smaller.":"收件人照片必须不超过 10 MB。","Introduction video must be 100 MB or smaller.":"介绍视频必须不超过 100 MB。","Introduction video must be 60 seconds or shorter.":"介绍视频必须不超过 60 秒。","Uploading and compressing your introduction video…":"正在上传并压缩介绍视频……","Introduction video compressed and stored safely.":"视频已压缩并安全保存。","Could not save premium order.":"无法保存高级订单。","The introduction video could not be read.":"无法读取介绍视频。","Order":"订单","Printo Credits & Subscriptions":"Printo 积分与订阅","Each verified phone number receives 100 FREE credits once — enough for 5 standard creations. Each standard creation uses 20 credits.":"每个已验证号码可一次性获得 100 个免费积分，可制作 5 个标准视频。每次使用 20 积分。","Use one universal Printo credit wallet for Standard, Premium Video, and Premium Multi-Image creations.":"标准、Premium 视频和 Premium 多图片制作共用一个积分钱包。","Standard Greeting Plans":"标准祝福计划","For personalized standard greeting video cards with names, messages, Printo music and voice.":"用于带有姓名、留言、Printo 音乐和语音的个性化标准视频。","STANDARD":"标准","Single Creation":"单次制作","20 credits • 1 standard creation":"20 积分 • 1 次标准制作","Buy One":"购买一次","Monthly":"每月","100 credits monthly • 5 standard creations":"每月 100 积分 • 5 次标准制作","Choose Standard Monthly":"选择标准月度计划","6 Months":"6 个月","600 credits • 30 standard creations":"600 积分 • 30 次标准制作","Choose Standard 6 Months":"选择标准 6 个月计划","BEST STANDARD VALUE":"标准最佳价值","1 Year":"1 年","1,200 credits • 60 standard creations":"1,200 积分 • 60 次标准制作","Choose Standard Annual":"选择标准年度计划","Premium Subscription Plans":"Premium 订阅计划","For Premium Tribute and enhanced personalized video experiences. Credit costs: Standard 20, Premium Video 25, Premium Multi-Image 50.":"用于 Premium 致敬和个性化视频。积分费用：标准 20、Premium 视频 25、Premium 多图片 50。","PREMIUM":"PREMIUM","100 credits now, then 100 credits each active month":"现在 100 积分，之后每个有效月份 100 积分","Choose Premium Monthly":"选择 Premium 月度计划","100 credits monthly for 6 months":"连续 6 个月每月 100 积分","Choose Premium 6 Months":"选择 Premium 6 个月计划","BEST PREMIUM VALUE":"PREMIUM 最佳价值","100 credits monthly for 12 months":"连续 12 个月每月 100 积分","Choose Premium Annual":"选择 Premium 年度计划","My Printo Dashboard":"我的 Printo 控制面板","Welcome Bonus: Each verified phone number receives 100 FREE credits once — enough for 5 standard creations.":"欢迎奖励：每个已验证号码一次性获得 100 个免费积分，可制作 5 个标准视频。","Credits":"积分","Standard Creations Remaining":"剩余标准制作次数","Plan":"计划","Free Welcome":"免费欢迎计划","Create Another Greeting":"制作另一个祝福","Create Your First Greeting":"制作您的第一个祝福","My Finished Videos":"我完成的视频","Recipient":"收件人","Play":"播放","Download":"下载","Your earlier creation record is saved, but its old temporary video file is no longer available. New finished videos will remain here after deployments and restarts.":"早期制作记录已保存，但旧临时视频不再可用。新视频会在部署和重启后继续保留。","You have not created your first greeting yet. Click Create Your First Greeting to surprise someone special.":"您还没有制作第一个祝福。点击制作您的第一个祝福，给特别的人一个惊喜。","Back to Printo Studio":"返回 Printo Studio","Share Video to YouTube":"分享到 YouTube","Create Another":"再制作一个","Buy More Credits / Subscribe":"购买更多积分 / 订阅","My Videos & Credits":"我的视频和积分","Nigeria Payment":"尼日利亚付款","Printo Greeting Studio":"Printo 祝福工作室","Share Video to TikTok":"分享到 TikTok","Download Video":"下载视频","Email":"电子邮件","Share Video to Instagram":"分享到 Instagram","Copy Short Greeting Link":"复制祝福短链接","Buy via Shopify":"通过 Shopify 购买","Your personalized greeting is ready":"您的个性化祝福已准备好","Created for":"为以下人员制作","from":"来自","Facebook, WhatsApp and X/Twitter share the short greeting link and preview. Instagram, YouTube and TikTok download the MP4 first; upload the downloaded video in the app and paste the copied short link into the caption or description.":"Facebook、WhatsApp 和 X/Twitter 分享短链接和预览。Instagram、YouTube 和 TikTok 会先下载 MP4；上传视频并将短链接粘贴到标题或说明中。","Please read these rules before uploading photos, videos, voices, names, messages, music instructions, documents, logos, or other content to Printto Studio.":"上传照片、视频、声音、姓名、留言、音乐说明、文档、标志或其他内容前，请阅读这些规则。","1. Your Content and Permission":"1. 您的内容与授权","You confirm that you own, created, licensed, or received clear permission to use every photograph, video, voice recording, name, message, logo, song, document, or other material you upload.":"您确认拥有、创作、获得许可或明确授权使用上传的每张照片、视频、录音、姓名、留言、标志、歌曲、文档或其他材料。","Do not upload or generate content using another person’s image, video, voice, likeness, or private information without that person’s authorization.":"未经本人授权，请勿使用他人的图像、视频、声音、肖像或私人信息上传或生成内容。","2. User Responsibility":"2. 用户责任","3. Prohibited Content":"3. 禁止内容","4. Privacy and Uploaded Files":"4. 隐私与上传文件","5. AI and Creative Output":"5. AI 与创意结果","6. Credits and Memberships":"6. 积分与会员","7. Final Sale and No-Return Policy":"7. 最终销售与不可退货政策","8. Technical Generation Problems":"8. 技术生成问题","9. Limitation of Responsibility":"9. 责任限制","10. Policy Enforcement and Updates":"10. 政策执行与更新","All Rights Reserved.":"保留所有权利。","You are solely responsible for your uploads and the instructions you provide. PATAPATA LLC does not authorize impersonation, harassment, defamation, copyright infringement, privacy violations, misleading endorsements, or unlawful use of another person’s identity.":"您对上传内容和说明承担全部责任。PATAPATA LLC 不允许冒充、骚扰、诽谤、侵犯版权或隐私、误导性代言或非法使用他人身份。","PATAPATA LLC may reject, suspend, remove, or report content or accounts that appear illegal, abusive, deceptive, unsafe, or unauthorized.":"PATAPATA LLC 可拒绝、暂停、删除或举报看似违法、辱骂、欺骗、不安全或未授权的内容或账户。","Content involving exploitation, threats, hate, harassment, violence, or illegal activity.":"涉及剥削、威胁、仇恨、骚扰、暴力或违法活动的内容。","Sexually explicit content or content that exploits or endangers minors.":"露骨色情内容或剥削、危害未成年人的内容。","Unauthorized copyrighted material, trademarks, private records, or confidential information.":"未经授权的版权材料、商标、私人记录或机密信息。","False impersonation, fraud, scams, or content intended to deceive the public.":"虚假冒充、欺诈、骗局或意图欺骗公众的内容。","Names, contact details, photos, videos, messages, and other uploaded files may be processed and temporarily stored to create the requested service, operate customer accounts, prevent abuse, complete payments, troubleshoot failures, and provide support.":"姓名、联系方式、照片、视频、留言和其他上传文件可能会被处理并临时保存，以提供服务、管理账户、防止滥用、完成付款、排查故障和提供支持。","PATAPATA LLC does not sell customer personal information. Customers should avoid uploading unnecessary sensitive information.":"PATAPATA LLC 不出售客户个人信息。客户应避免上传不必要的敏感信息。","AI-generated or automatically assembled results may contain variations. You must review names, spelling, messages, photos, video selections, and instructions before submitting. Minor creative differences that do not prevent delivery are not generation failures.":"AI 生成或自动组合的结果可能存在差异。提交前请检查姓名、拼写、留言、照片、视频和说明。不影响交付的细微差异不属于生成失败。","Credits are deducted when a generation or eligible service begins. Membership credits are released according to the selected plan. Prices, credit costs, available features, and processing times may be updated for future purchases.":"生成或符合条件的服务开始时会扣除积分。会员积分按计划发放。未来的价格、积分费用、功能和处理时间可能更新。","Because each video is custom-generated using customer-provided information and computing resources, a successfully generated video is final and non-returnable. No refund is provided after successful generation merely because the customer changes their mind, dislikes a creative preference, or supplied incorrect information.":"由于每个视频都使用客户信息和计算资源定制生成，成功生成的视频为最终产品，不可退货。不会因改变主意、创意偏好或错误信息而退款。","If a verified technical problem caused the generation not to work, produced no usable video, or prevented delivery, contact a Printto Support Agent promptly. After reviewing the issue, PATAPATA LLC may fix and regenerate the video, restore the affected credits, or provide another appropriate resolution.":"如果经确认的技术问题导致生成失败、没有可用视频或无法交付，请联系 Printo 支持。PATAPATA LLC 可修复、重新生成、恢复积分或提供其他方案。","A refund, when legally required or approved by PATAPATA LLC, is considered only after support has had a reasonable opportunity to investigate and correct the technical problem.":"只有在法律要求或批准，并且支持团队有合理机会调查和纠正问题后，才会考虑退款。","To the extent permitted by law, PATAPATA LLC is not responsible for claims, losses, or disputes caused by unauthorized uploads, customer mistakes, infringement by a user, third-party platforms, internet interruptions, or circumstances outside our reasonable control.":"在法律允许范围内，PATAPATA LLC 不对因未授权上传、客户错误、侵权、第三方平台、网络中断或超出合理控制的情况造成的索赔、损失或争议负责。","We may refuse service or restrict access when necessary to protect people, intellectual property, privacy, platform security, or legal compliance. Updated terms apply to future use after they are posted on this page.":"为保护人员、知识产权、隐私、安全或法律合规，我们可拒绝服务或限制访问。更新后的条款发布后适用于未来使用。","For a failed generation or another service problem, use the Worker Help or Support Agent option in Printto Studio before requesting a refund.":"生成失败或出现其他问题时，请先在 Printo Studio 使用工作人员帮助或支持代理，再申请退款。","4–8 numbers":"4–8 位数字","Could not check verification.":"无法检查验证状态。","Could not start verification.":"无法开始验证。","Account request failed":"账户请求失败","First verified-account test FREE • Then 50 credits or $14.99":"已验证账户首次测试免费 • 之后 50 积分或 14.99 美元","Premium Multi-Image Flip Tribute":"Premium 多图片翻转致敬","Upload 2–8 recipient photos. After the personal introduction ends, the images flip one after another while the custom tribute music plays.":"上传 2–8 张收件人照片。个人介绍结束后，照片会在自定义致敬音乐播放时依次翻转切换。","2–8 recipient photos":"2–8 张收件人照片","Flip-style image transitions":"翻转式图片过渡","Custom tribute music":"自定义致敬音乐","First verified-account test is FREE":"已验证账户首次测试免费","After the free test: 50 credits or $14.99":"免费测试后：50 积分或 14.99 美元","Share and download page":"分享和下载页面","Create Multi-Image Flip":"创建多图片翻转视频","Premium Creation Prices & Subscription Plans":"Premium 制作价格与订阅计划","Each Premium service has its own separate creation price in the universal Printo credit wallet.":"每项 Premium 服务在通用 Printo 积分钱包中都有独立的制作价格。","PREMIUM VIDEO":"PREMIUM 视频","Personal Tribute Video":"个人致敬视频","25 Credits":"25 积分","1 recipient photo • introduction video • custom music":"1 张收件人照片 • 介绍视频 • 自定义音乐","Create Premium Video":"创建 Premium 视频","MULTI-IMAGE FLIP":"多图片翻转","Premium Multi-Image":"Premium 多图片","First verified-account test FREE • then 50 credits • 2–8 photos • flip transitions • introduction • custom music":"已验证账户首次测试免费 • 之后 50 积分 • 2–8 张照片 • 翻转过渡 • 介绍 • 自定义音乐","Use Free Test / Create":"使用免费测试 / 创建","Buy 50 Credits":"购买 50 积分","Each verified phone number receives 100 FREE universal credits once, plus one FREE Multi-Image Flip test worth 50 credits. After the free Multi-Image test, each Multi-Image creation costs 50 credits or $14.99.":"每个已验证电话号码可一次性获得 100 个免费通用积分，并获得一次价值 50 积分的免费多图片翻转测试。测试后，每次制作需 50 积分或 14.99 美元。","Welcome Bonus: 100 FREE universal credits plus one FREE Multi-Image Flip test worth 50 credits for each verified phone account.":"欢迎奖励：每个已验证电话账户可获得 100 个免费通用积分，并获得一次价值 50 积分的免费多图片翻转测试。","Free Multi-Image Test":"免费多图片测试","Available":"可用","Used":"已使用","Premium Multi-Image Flip Video":"Premium 多图片翻转视频","Premium video is not ready yet.":"Premium 视频尚未准备好。","Return to My Videos and try again after rendering is complete.":"请返回我的视频，并在渲染完成后重试。","A personalized Printo Premium tribute video.":"个性化 Printo Premium 致敬视频。","Facebook, WhatsApp and X share the Premium result page. Instagram, YouTube and TikTok use your phone’s share sheet when available; otherwise the MP4 downloads first for upload.":"Facebook、WhatsApp 和 X 会分享 Premium 结果页面。Instagram、YouTube 和 TikTok 会在可用时使用手机分享菜单，否则会先下载 MP4 供上传。","Premium video link copied.":"Premium 视频链接已复制。","Payment is required.":"需要付款。","FREE TEST — 0 credits deducted":"免费测试 — 扣除 0 积分","Each recipient image must be 10 MB or smaller.":"每张收件人图片必须不超过 10 MB。","Personal video or voice introduction":"个人视频或语音介绍","Choose Video or Voice Introduction":"选择视频或语音介绍","Video Introduction":"视频介绍","Voice Introduction":"语音介绍","Record Voice":"录制语音","Start Recording":"开始录音","Stop Recording":"停止录音","Play Recording":"播放录音","Record Again":"重新录音","Upload Existing Audio":"上传现有音频","Record in a quiet place and speak clearly. Printo will reduce background noise automatically.":"请在安静的地方清晰讲话。Printo 会自动降低背景噪音。","Personal introduction video or voice recording":"个人介绍视频或语音录音","Create a powerful personal tribute using the recipient photo, your personal introduction video or voice recording, an original tribute song, names and a heartfelt message.":"使用收件人照片、个人介绍视频或语音录音、原创致敬歌曲、姓名和真挚留言，制作有感染力的个人致敬视频。"}});

function normalizePrintoStudioLanguage(value = "en") {
  const normalized = String(value || "en").trim().toLowerCase().split(/[-_]/)[0];
  return PRINTO_STUDIO_SUPPORTED_LANGUAGES.includes(normalized) ? normalized : "en";
}

function translatePrintoStudioPhrase(language = "en", englishText = "") {
  const lang = normalizePrintoStudioLanguage(language);
  if (lang === "en") return String(englishText || "");
  return PRINTO_STUDIO_CLIENT_TRANSLATIONS[lang]?.[String(englishText || "")] || String(englishText || "");
}

function addPrintoLanguageToPath(rawPath = "/greetings", language = "en") {
  const lang = normalizePrintoStudioLanguage(language);
  const value = String(rawPath || "/greetings");
  if (!value.startsWith("/") || value.startsWith("//")) return value;

  try {
    const parsed = new URL(value, "https://studio.patapata.us");
    parsed.searchParams.set("lang", lang);
    return parsed.pathname + parsed.search + parsed.hash;
  } catch (_error) {
    return value;
  }
}

function shouldInjectPrintoStudioLanguageTools(pathname = "") {
  const pathValue = String(pathname || "");
  const exactPaths = new Set([
    "/greetings",
    "/greeting",
    "/birthday",
    "/birthday-generator",
    "/generate-birthday",
    "/greetings/create",
    "/greetings/premium",
    "/greetings/premium-multi-image",
    "/greetings/watch-buy",
    "/premium-greeting",
    "/customer-login",
    "/subscriptions",
    "/customer-dashboard",
    "/greeting-result",
    "/greeting-test"
  ]);

  return (
    exactPaths.has(pathValue) ||
    pathValue.startsWith("/g/") ||
    pathValue.startsWith("/premium-result/") ||
    pathValue.startsWith("/birthday-progress/")
  );
}

function buildPrintoStudioLanguageTools(serverLanguage = "en") {
  const safeServerLanguage = normalizePrintoStudioLanguage(serverLanguage);
  const dictionaries = JSON.stringify(PRINTO_STUDIO_CLIENT_TRANSLATIONS).replace(/</g, "\\u003c");
  const languageNames = JSON.stringify(PRINTO_STUDIO_LANGUAGE_NAMES).replace(/</g, "\\u003c");

  return `
<style id="printo-language-tools-style">
#printoLanguageDock{position:fixed;z-index:100000;inset-block-start:12px;inset-inline-end:12px;display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:999px;background:rgba(255,255,255,.97);color:#082a8f;box-shadow:0 8px 26px rgba(0,0,0,.28);border:2px solid #ffd21f;font-family:Arial,sans-serif}
#printoLanguageDock label{margin:0!important;font-size:13px;font-weight:900;white-space:nowrap}
#printoLanguageSelect{width:auto!important;min-width:118px!important;margin:0!important;padding:8px 30px 8px 10px!important;border:1px solid #93c5fd!important;border-radius:999px!important;background:#fff!important;color:#082a8f!important;font-size:14px!important;font-weight:800!important;line-height:1.2!important}
html[dir="rtl"] #printoLanguageDock{inset-inline-end:auto;inset-inline-start:12px}
@media(max-width:520px){#printoLanguageDock{inset-block-start:7px;inset-inline-end:7px;padding:6px 8px}#printoLanguageDock label{display:none}#printoLanguageSelect{min-width:104px!important;font-size:13px!important}}
</style>
<div id="printoLanguageDock" role="group" aria-label="Language">
  <label id="printoLanguageLabel" for="printoLanguageSelect">🌐 Language</label>
  <select id="printoLanguageSelect" aria-label="Language"></select>
</div>
<script id="printo-language-tools-script">
(function(){
  var supported=["en","es","fr","de","pt","ar","zh"];
  var serverLanguage=${JSON.stringify(safeServerLanguage)};
  var dictionaries=${dictionaries};
  var languageNames=${languageNames};

  function normalizeLanguage(value){
    var normalized=String(value||"").trim().toLowerCase().split(/[-_]/)[0];
    return supported.indexOf(normalized)>=0?normalized:"";
  }

  var params=new URLSearchParams(window.location.search);
  var queryLanguage=normalizeLanguage(params.get("lang"));
  var storedLanguage="";
  try{storedLanguage=normalizeLanguage(localStorage.getItem("printoLanguage"));}catch(_error){}
  var browserLanguage=normalizeLanguage((navigator.languages&&navigator.languages[0])||navigator.language||"");
  var language=queryLanguage||storedLanguage||browserLanguage||serverLanguage||"en";

  try{localStorage.setItem("printoLanguage",language);}catch(_error){}

  if(!queryLanguage&&language!==serverLanguage){
    params.set("lang",language);
    window.location.replace(window.location.pathname+"?"+params.toString()+window.location.hash);
    return;
  }

  document.documentElement.lang=language;
  document.documentElement.dir=language==="ar"?"rtl":"ltr";

  var map=language==="en"?{}:(dictionaries[language]||{});
  var excludedTags={SCRIPT:true,STYLE:true,NOSCRIPT:true,CODE:true,PRE:true,TEXTAREA:true};
  var scheduled=false;

  function translateCore(value){
    var text=String(value==null?"":value);
    var trimmed=text.trim();
    if(!trimmed||language==="en")return text;

    if(Object.prototype.hasOwnProperty.call(map,trimmed)){
      return text.slice(0,text.indexOf(trimmed))+map[trimmed]+text.slice(text.indexOf(trimmed)+trimmed.length);
    }

    var prefixMatch=trimmed.match(/^([^A-Za-zÀ-ÿ\u00C0-\uFFFF0-9]*)(.+)$/u);
    if(prefixMatch&&Object.prototype.hasOwnProperty.call(map,prefixMatch[2])){
      var translated=prefixMatch[1]+map[prefixMatch[2]];
      return text.slice(0,text.indexOf(trimmed))+translated+text.slice(text.indexOf(trimmed)+trimmed.length);
    }

    var orderMatch=trimmed.match(/^Order:\s*(.+)$/i);
    if(orderMatch)return (map["Order"]||"Order")+": "+orderMatch[1];

    var forMatch=trimmed.match(/^For\s+(.+)$/i);
    if(forMatch)return (map["Recipient"]||"For")+" "+forMatch[1];

    return text;
  }

  function translateElement(element){
    if(!element||element.nodeType!==1)return;
    var tag=String(element.tagName||"").toUpperCase();
    if(excludedTags[tag])return;

    ["placeholder","title","aria-label","alt"].forEach(function(attribute){
      if(element.hasAttribute&&element.hasAttribute(attribute)){
        var current=element.getAttribute(attribute);
        var translated=translateCore(current);
        if(translated!==current)element.setAttribute(attribute,translated);
      }
    });

    if((tag==="INPUT"||tag==="BUTTON")&&["button","submit","reset"].indexOf(String(element.type||"").toLowerCase())>=0){
      var currentValue=element.value;
      var translatedValue=translateCore(currentValue);
      if(translatedValue!==currentValue)element.value=translatedValue;
    }

    if(tag==="INPUT"&&String(element.name||"").toLowerCase()==="language"){
      element.value=language;
    }
  }

  function translateTree(root){
    if(!root)return;
    if(root.nodeType===3){
      if(root.parentElement&&!excludedTags[String(root.parentElement.tagName||"").toUpperCase()]){
        var updated=translateCore(root.nodeValue);
        if(updated!==root.nodeValue)root.nodeValue=updated;
      }
      return;
    }

    if(root.nodeType===1)translateElement(root);
    var walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
    var node;
    while((node=walker.nextNode())){
      if(node.nodeType===3){
        if(node.parentElement&&!excludedTags[String(node.parentElement.tagName||"").toUpperCase()]){
          var newValue=translateCore(node.nodeValue);
          if(newValue!==node.nodeValue)node.nodeValue=newValue;
        }
      }else{
        translateElement(node);
      }
    }
  }

  function isStudioPagePath(pathname){
    return [
      "/greetings","/greeting","/birthday","/birthday-generator",
      "/generate-birthday","/greetings/create","/greetings/premium",
      "/premium-greeting","/greetings/premium-multi-image","/greetings/watch-buy","/customer-login","/subscriptions",
      "/customer-dashboard","/greeting-result","/greeting-test"
    ].indexOf(pathname)>=0||pathname.indexOf("/g/")===0||pathname.indexOf("/premium-result/")===0||pathname.indexOf("/birthday-progress/")===0;
  }

  function addLanguageToLinks(root){
    var scope=root&&root.querySelectorAll?root:document;
    scope.querySelectorAll("a[href]").forEach(function(anchor){
      var raw=anchor.getAttribute("href")||"";
      if(!raw||raw.charAt(0)==="#"||/^(mailto:|tel:|javascript:)/i.test(raw))return;
      try{
        var url=new URL(raw,window.location.origin);
        if(url.origin!==window.location.origin||!isStudioPagePath(url.pathname))return;
        url.searchParams.set("lang",language);
        if(url.pathname==="/customer-login"&&url.searchParams.get("next")){
          try{
            var nextUrl=new URL(url.searchParams.get("next"),window.location.origin);
            if(nextUrl.origin===window.location.origin&&isStudioPagePath(nextUrl.pathname)){
              nextUrl.searchParams.set("lang",language);
              url.searchParams.set("next",nextUrl.pathname+nextUrl.search+nextUrl.hash);
            }
          }catch(_nestedError){}
        }
        anchor.setAttribute("href",url.pathname+url.search+url.hash);
      }catch(_error){}
    });
  }

  function applyAll(){
    translateTree(document.body);
    addLanguageToLinks(document);
    var label=document.getElementById("printoLanguageLabel");
    if(label)label.textContent="🌐 "+(map["Language"]||"Language");
  }

  var select=document.getElementById("printoLanguageSelect");
  supported.forEach(function(code){
    var option=document.createElement("option");
    option.value=code;
    option.textContent=languageNames[code]||code;
    option.selected=code===language;
    select.appendChild(option);
  });
  select.addEventListener("change",function(){
    var chosen=normalizeLanguage(select.value)||"en";
    try{localStorage.setItem("printoLanguage",chosen);}catch(_error){}
    var nextParams=new URLSearchParams(window.location.search);
    nextParams.set("lang",chosen);
    window.location.href=window.location.pathname+"?"+nextParams.toString()+window.location.hash;
  });

  applyAll();

  var observer=new MutationObserver(function(){
    if(scheduled)return;
    scheduled=true;
    window.requestAnimationFrame(function(){
      scheduled=false;
      applyAll();
    });
  });
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["placeholder","title","aria-label","alt","href","value"]});
})();
</script>`;
}

app.use((req, res, next) => {
  if (!shouldInjectPrintoStudioLanguageTools(req.path)) return next();

  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (
      typeof body === "string" &&
      /<\/body>/i.test(body) &&
      !body.includes('id="printoLanguageDock"')
    ) {
      const language = normalizePrintoStudioLanguage(req.query.lang || "en");
      body = body.replace(/<\/body>/i, `${buildPrintoStudioLanguageTools(language)}</body>`);
      res.setHeader("Content-Language", language);
    }
    return originalSend(body);
  };

  return next();
});


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
// Parse the WhatsApp webhook from its exact raw bytes before converting it
// to JSON. Meta calculates X-Hub-Signature-256 from those exact bytes.
// All other JSON routes continue using the normal Express JSON parser.
const printoJsonParser = express.json({
  limit: "20mb",
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
});

const printoWebhookRawParser = express.raw({
  type: "application/json",
  limit: "20mb"
});

app.use((req, res, next) => {
  const isWhatsAppWebhookPost =
    req.method === "POST" && req.path === "/webhook";

  if (!isWhatsAppWebhookPost) {
    return printoJsonParser(req, res, next);
  }

  return printoWebhookRawParser(req, res, (error) => {
    if (error) return next(error);

    if (!Buffer.isBuffer(req.body)) {
      console.error("WhatsApp webhook raw body was unavailable.");
      return res.sendStatus(400);
    }

    req.rawBody = Buffer.from(req.body);

    try {
      req.body = JSON.parse(req.rawBody.toString("utf8"));
    } catch (parseError) {
      console.error(
        "WhatsApp webhook JSON parse failed:",
        parseError?.message || parseError
      );
      return res.sendStatus(400);
    }

    return next();
  });
});
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
const PRINTO_MULTI_IMAGE_SHOPIFY_URL =
  process.env.GREETING_PREMIUM_MULTI_IMAGE_SHOPIFY_URL ||
  process.env.PRINTO_MULTI_IMAGE_SHOPIFY_URL ||
  "";
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
  GREETING_PREMIUM_MULTI_IMAGE:
    process.env.SHOPIFY_VARIANT_GREETING_PREMIUM_MULTI_IMAGE || "",
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
        free_multi_image_trial_used BOOLEAN NOT NULL DEFAULT FALSE,
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
    await queryWithRetry(`ALTER TABLE greeting_customer_access ADD COLUMN IF NOT EXISTS free_multi_image_trial_used BOOLEAN NOT NULL DEFAULT FALSE`);
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
      creation_type TEXT NOT NULL DEFAULT 'premium_video',
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
      intro_media_type TEXT NOT NULL DEFAULT 'video',
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
      share_preview_data BYTEA,
      share_preview_mime TEXT NOT NULL DEFAULT '',
      share_preview_name TEXT NOT NULL DEFAULT '',
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
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS creation_type TEXT NOT NULL DEFAULT 'premium_video'`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS intro_media_type TEXT NOT NULL DEFAULT 'video'`);
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
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS share_preview_data BYTEA`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS share_preview_mime TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS share_preview_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS render_status TEXT NOT NULL DEFAULT 'not_started'`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS render_error TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE premium_greeting_orders ADD COLUMN IF NOT EXISTS media_token TEXT NOT NULL DEFAULT ''`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS premium_greeting_images (
      order_id TEXT NOT NULL REFERENCES premium_greeting_orders(order_id) ON DELETE CASCADE,
      image_position INTEGER NOT NULL,
      image_data BYTEA NOT NULL,
      image_mime TEXT NOT NULL DEFAULT 'image/jpeg',
      image_name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (order_id, image_position)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS premium_greeting_images_order_idx
    ON premium_greeting_images(order_id, image_position)
  `);

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
      free_multi_image_trial_used,
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
    freeMultiImageTrialUsed: Boolean(row.free_multi_image_trial_used),
    freeMultiImageTrialAvailable: !Boolean(row.free_multi_image_trial_used),
    freeMultiImageTrialValueCredits:
      PRINTO_MULTI_IMAGE_FREE_TRIAL_VALUE_CREDITS,
    multiImagePriceUsd: PRINTO_MULTI_IMAGE_PRICE_USD,
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

    if (normalizedCreationType === "premium_multi_image") {
      const trialResult = await client.query(
        `
        UPDATE greeting_customer_access AS access
        SET
          free_multi_image_trial_used = TRUE,
          total_generated = total_generated + 1,
          last_generation_source = 'free:premium_multi_image_trial',
          last_generated_at = NOW(),
          updated_at = NOW()
        WHERE access.customer_key = $1
          AND access.free_multi_image_trial_used = FALSE
          AND EXISTS (
            SELECT 1
            FROM greeting_customer_accounts AS account
            WHERE account.customer_key = access.customer_key
              AND account.account_type = 'verified_phone'
              AND account.phone_verified_at IS NOT NULL
          )
        RETURNING access.*
        `,
        [customerKey]
      );

      if (trialResult.rows[0]) {
        await client.query("COMMIT");
        const row = trialResult.rows[0];
        const creditBalance = Number(row.paid_credits || 0);

        return {
          allowed: true,
          source: "free_multi_image_trial",
          creationType: normalizedCreationType,
          customerKey,
          creditsUsed: 0,
          trialValueCredits: PRINTO_MULTI_IMAGE_FREE_TRIAL_VALUE_CREDITS,
          freeMultiImageTrialUsed: true,
          paidCredits: creditBalance,
          creditBalance,
          remainingCreations: Math.floor(creditBalance / creditCost),
          totalGenerated: Number(row.total_generated || 0)
        };
      }
    }

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
  if (!customerKey) return;

  if (source === "free_multi_image_trial") {
    await pool.query(
      `
      UPDATE greeting_customer_access
      SET
        free_multi_image_trial_used = FALSE,
        total_generated = GREATEST(total_generated - 1, 0),
        last_generation_source = '',
        last_generated_at = NULL,
        updated_at = NOW()
      WHERE customer_key = $1
      `,
      [customerKey]
    );
    return;
  }

  if (source !== "credits") return;
  const safeCreditsUsed = Math.max(
    1,
    Number(creditsUsed) || PRINTO_CREATION_CREDIT_COST
  );

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
    type: "standard",
    toName: row.recipient_name || "",
    fromName: row.sender_name || "",
    message: row.personal_message || "",
    language: row.language || "en",
    createdAt: row.completed_at || row.created_at || null,
    resultUrl: `/g/${encodeURIComponent(row.greeting_id)}`,
    downloadUrl: `/download/g/${encodeURIComponent(row.greeting_id)}`
  }));
}


async function listPremiumGreetingVideos(customerKey) {
  const result = await queryWithRetry(
    `SELECT order_id,
            recipient_name,
            sender_name,
            creation_type,
            personal_message,
            media_token,
            created_at,
            updated_at
     FROM premium_greeting_orders
     WHERE customer_key = $1
       AND render_status = 'completed'
       AND final_video_data IS NOT NULL
       AND COALESCE(media_token, '') <> ''
     ORDER BY COALESCE(updated_at, created_at) DESC
     LIMIT 100`,
    [customerKey]
  );

  return result.rows.map((row) => {
    const orderId = String(row.order_id || "");
    const token = String(row.media_token || "");
    const baseUrl =
      `/premium-result/${encodeURIComponent(orderId)}` +
      `?token=${encodeURIComponent(token)}`;
    const downloadUrl =
      `/premium-media/${encodeURIComponent(orderId)}/final` +
      `?token=${encodeURIComponent(token)}&download=1`;

    return {
      id: orderId,
      type: String(row.creation_type || "premium_video") === "premium_multi_image"
        ? "premium_multi_image"
        : String(row.creation_type || "premium_video") === "watch_buy"
          ? "watch_buy"
          : "premium",
      toName: row.recipient_name || "",
      fromName: row.sender_name || "",
      message: row.personal_message || "",
      language: "en",
      createdAt: row.updated_at || row.created_at || null,
      resultUrl: baseUrl,
      downloadUrl
    };
  });
}

function mergeCustomerFinishedVideos(standardVideos = [], premiumVideos = []) {
  return [...standardVideos, ...premiumVideos].sort((left, right) => {
    const leftTime = new Date(left?.createdAt || 0).getTime() || 0;
    const rightTime = new Date(right?.createdAt || 0).getTime() || 0;
    return rightTime - leftTime;
  });
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


function getMultiImageShopifyBaseUrl() {
  const explicit = String(PRINTO_MULTI_IMAGE_SHOPIFY_URL || "").trim();
  if (explicit) return explicit;

  const cartUrl = buildGreetingCheckoutUrl("PREMIUM_MULTI_IMAGE", 1);
  return cartUrl || "";
}

function buildMultiImagePurchaseLinks({
  customerKey,
  contactPhone = ""
} = {}) {
  const phone = String(contactPhone || "").replace(/\D+/g, "");
  const credits = String(PRINTO_MULTI_IMAGE_SINGLE_PURCHASE_CREDITS);
  const packageName = "GREETING_PREMIUM_MULTI_IMAGE_CREDITS";
  const baseUrl = getMultiImageShopifyBaseUrl();

  const properties = encodeShopifyCartProperties({
    "Greeting Customer Key": customerKey || "",
    "Greeting Package": packageName,
    "Greeting Credits": credits,
    "Greeting Phone": phone,
    "Multi-Image Price": `$${PRINTO_MULTI_IMAGE_PRICE_USD.toFixed(2)}`
  });

  const shopify = baseUrl
    ? appendUrlParameters(baseUrl, {
        properties,
        "attributes[Greeting Customer Key]": customerKey || "",
        "attributes[Greeting Package]": packageName,
        "attributes[Greeting Credits]": credits,
        "attributes[Greeting Phone]": phone,
        "attributes[Multi-Image Price]":
          `$${PRINTO_MULTI_IMAGE_PRICE_USD.toFixed(2)}`,
        ref: "printo-multi-image-credits"
      })
    : "";

  const africa = appendUrlParameters(GREETING_AFRICA_PAYMENT_URL, {
    greeting_customer_key: customerKey || "",
    greeting_package: packageName,
    greeting_credits: credits,
    greeting_phone: phone,
    multi_image_price_usd: PRINTO_MULTI_IMAGE_PRICE_USD.toFixed(2)
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
  const allowedKinds = new Set(["photo", "video", "audio", "music", "final", "preview"]);
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
      ? "voice-introduction.m4a"
      : "recipient-photo.jpg";
  const fileName = safeBaseName(media.name || defaultName);

  res.setHeader("Content-Type", mime);
  const forceDownload =
    String(req.query.download || "") === "1" ||
    String(req.query.download || "").toLowerCase() === "true";
  res.setHeader(
    "Content-Disposition",
    `${forceDownload ? "attachment" : "inline"}; filename="${fileName}"`
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Cache-Control",
    media.cacheControl || "private, no-store, max-age=0"
  );

  if (mime.startsWith("video/") || mime.startsWith("audio/")) {
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

async function probeSpokenAudioEndSeconds(filePath, totalDurationSeconds) {
  const safeTotal = Number(totalDurationSeconds || 0);
  if (!Number.isFinite(safeTotal) || safeTotal <= 0) return safeTotal;

  try {
    const { stderr } = await execFilePromise("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-i", filePath,
      "-af",
      "highpass=f=80,lowpass=f=9000,afftdn=nr=8:nf=-38:tn=1:tr=1:ad=0.25:gs=5,silencedetect=noise=-42dB:d=0.22",
      "-f", "null",
      "-"
    ], {
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024
    });

    const logText = String(stderr || "");
    const starts = [...logText.matchAll(/silence_start:\s*([0-9.]+)/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
    const ends = [...logText.matchAll(/silence_end:\s*([0-9.]+)/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);

    const lastSilenceStart = starts.at(-1);
    const lastSilenceEnd = ends.at(-1);

    const reachesFileEnd =
      Number.isFinite(lastSilenceStart) &&
      (
        !Number.isFinite(lastSilenceEnd) ||
        lastSilenceEnd >= safeTotal - 0.25
      );

    // Keep a small safety floor so an unusual audio file can never produce
    // a nearly empty video.
    if (reachesFileEnd && lastSilenceStart >= 1.25) {
      return Math.min(safeTotal, lastSilenceStart);
    }
  } catch (error) {
    console.warn(
      "Birthday trailing-silence detection failed; using full voice duration:",
      error.message
    );
  }

  return safeTotal;
}

function parseFfmpegClockSeconds(value) {
  const match = String(value || "").match(
    /^(\d+):(\d+):(\d+(?:\.\d+)?)$/
  );
  if (!match) return 0;

  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const total = hours * 3600 + minutes * 60 + seconds;

  return Number.isFinite(total) && total > 0 ? total : 0;
}

async function probeDecodedMediaDurationSeconds(filePath) {
  let stderrText = "";

  try {
    const result = await execFilePromise("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-i", filePath,
      "-map", "0:a:0?",
      "-map", "0:v:0?",
      "-f", "null",
      "-"
    ], {
      timeout: 120000,
      maxBuffer: 5 * 1024 * 1024
    });
    stderrText = String(result.stderr || "");
  } catch (error) {
    // FFmpeg may still provide a usable final timestamp in stderr even when
    // a damaged trailing packet causes a non-zero exit code.
    stderrText = String(error?.stderr || "");
  }

  const timestamps = [
    ...stderrText.matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)
  ]
    .map((match) => parseFfmpegClockSeconds(match[1]))
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0);

  return timestamps.length ? Math.max(...timestamps) : 0;
}

async function probePremiumMedia(filePath) {
  const { stdout } = await execFilePromise("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=duration,size:stream=codec_type,duration",
    "-of", "json",
    filePath
  ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });

  const parsed = JSON.parse(stdout || "{}");
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const durationCandidates = [
    Number(parsed?.format?.duration || 0),
    ...streams.map((stream) => Number(stream?.duration || 0))
  ].filter((duration) => Number.isFinite(duration) && duration > 0);

  let duration = durationCandidates.length
    ? Math.max(...durationCandidates)
    : 0;

  if (!duration) {
    duration = await probeDecodedMediaDurationSeconds(filePath);
  }

  return {
    duration,
    size: Number(parsed?.format?.size || 0),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    hasVideo: streams.some((stream) => stream.codec_type === "video")
  };
}

async function probePremiumAudioLevels(filePath) {
  const { stderr } = await execFilePromise("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-i", filePath,
    "-vn",
    "-af", "volumedetect",
    "-f", "null",
    "-"
  ], {
    timeout: 60000,
    maxBuffer: 3 * 1024 * 1024
  });

  const logText = String(stderr || "");
  const readDb = (label) => {
    const match = logText.match(
      new RegExp(`${label}:\\s*(-?inf|-?\\d+(?:\\.\\d+)?)\\s*dB`, "i")
    );
    if (!match) return Number.NEGATIVE_INFINITY;
    if (String(match[1]).toLowerCase().includes("inf")) {
      return Number.NEGATIVE_INFINITY;
    }
    return Number(match[1]);
  };

  return {
    meanDb: readDb("mean_volume"),
    maxDb: readDb("max_volume")
  };
}

function assertPremiumIntroductionIsAudible(levels, label = "Voice introduction") {
  const maxDb = Number(levels?.maxDb);
  const meanDb = Number(levels?.meanDb);

  if (
    !Number.isFinite(maxDb) ||
    maxDb < -42 ||
    (!Number.isFinite(meanDb) && maxDb < -36)
  ) {
    throw new Error(
      `${label} is silent or too quiet. Play the recording before submitting, then record again closer to the microphone.`
    );
  }
}

async function probePremiumStreamDurations(filePath) {
  const { stdout } = await execFilePromise("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,duration",
    "-of", "json",
    filePath
  ], {
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024
  });

  const parsed = JSON.parse(stdout || "{}");
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");

  return {
    videoDuration: Number(video?.duration || 0),
    audioDuration: Number(audio?.duration || 0)
  };
}


async function compressPremiumRecipientImage(inputPath, outputPath) {
  const firstPassArgs = [
    "-y", "-nostdin", "-loglevel", "error",
    "-i", inputPath,
    "-vf",
    "scale=1080:1350:force_original_aspect_ratio=decrease," +
      "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
    "-frames:v", "1",
    "-map_metadata", "-1",
    "-q:v", "4",
    outputPath
  ];

  await execFilePromise("ffmpeg", firstPassArgs, {
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024
  });

  let outputSize = fs.statSync(outputPath).size;
  const maxStoredImageBytes = 2.5 * 1024 * 1024;

  if (outputSize > maxStoredImageBytes) {
    const smallerPath = `${outputPath}.smaller.jpg`;
    await execFilePromise("ffmpeg", [
      "-y", "-nostdin", "-loglevel", "error",
      "-i", inputPath,
      "-vf",
      "scale=900:1125:force_original_aspect_ratio=decrease," +
        "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
      "-frames:v", "1",
      "-map_metadata", "-1",
      "-q:v", "7",
      smallerPath
    ], {
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024
    });

    safeUnlink(outputPath);
    fs.renameSync(smallerPath, outputPath);
    outputSize = fs.statSync(outputPath).size;
  }

  if (!Number.isFinite(outputSize) || outputSize <= 0) {
    throw new Error("One of the recipient photos could not be prepared.");
  }

  return {
    path: outputPath,
    storedBytes: outputSize,
    mime: "image/jpeg",
    name: "recipient-photo.jpg"
  };
}

async function compressPremiumIntroductionVideo(inputPath, outputPath) {
  const source = await probePremiumMedia(inputPath);
  if (!source.hasVideo) throw new Error("The introduction file does not contain a valid video stream.");
  if (!source.hasAudio) {
    throw new Error("The introduction video has no audio. Record or upload a video in which your voice can be heard.");
  }
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
    "-af",
    "highpass=f=80,lowpass=f=9000,afftdn=nr=10:nf=-38:tn=1:tr=1:ad=0.30:gs=6,acompressor=threshold=0.06:ratio=2:attack=15:release=180:makeup=2,loudnorm=I=-14:TP=-1.0:LRA=8,alimiter=limit=0.95",
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

  const cleanedLevels = await probePremiumAudioLevels(outputPath);
  assertPremiumIntroductionIsAudible(
    cleanedLevels,
    "Introduction-video voice"
  );

  return {
    duration: source.duration,
    originalBytes: source.size || fs.statSync(inputPath).size,
    storedBytes: outputSize,
    mime: "video/mp4",
    name: "introduction-video.mp4"
  };
}


async function compressPremiumIntroductionAudio(inputPath, outputPath) {
  const source = await probePremiumMedia(inputPath);
  if (!source.hasAudio) {
    throw new Error("The voice introduction does not contain a valid audio stream.");
  }
  if (!Number.isFinite(source.duration) || source.duration <= 0) {
    throw new Error("The voice recording could not be decoded. Please record again or upload an MP3, M4A or WAV file.");
  }
  if (source.duration > PREMIUM_VIDEO_MAX_SECONDS + 0.25) {
    throw new Error(`Voice introduction must be ${PREMIUM_VIDEO_MAX_SECONDS} seconds or shorter.`);
  }

  await execFilePromise("ffmpeg", [
    "-y", "-nostdin", "-loglevel", "error",
    "-i", inputPath,
    "-t", String(Math.min(source.duration, PREMIUM_VIDEO_MAX_SECONDS)),
    "-vn",
    "-af",
    "highpass=f=80,lowpass=f=9000,afftdn=nr=10:nf=-38:tn=1:tr=1:ad=0.30:gs=6,acompressor=threshold=0.06:ratio=2:attack=15:release=180:makeup=2,loudnorm=I=-14:TP=-1.0:LRA=8,alimiter=limit=0.95",
    "-c:a", "aac",
    "-b:a", "96k",
    "-ar", "44100",
    "-ac", "1",
    "-movflags", "+faststart",
    outputPath
  ], {
    timeout: 240000,
    maxBuffer: 8 * 1024 * 1024
  });

  const outputSize = fs.statSync(outputPath).size;
  if (outputSize > PREMIUM_INTRO_AUDIO_STORED_MAX_BYTES) {
    throw new Error("The cleaned voice introduction is still too large. Please upload a shorter recording.");
  }

  const cleanedLevels = await probePremiumAudioLevels(outputPath);
  assertPremiumIntroductionIsAudible(cleanedLevels, "Voice introduction");

  return {
    duration: source.duration,
    originalBytes: source.size || fs.statSync(inputPath).size,
    storedBytes: outputSize,
    mime: "audio/mp4",
    name: "voice-introduction.m4a",
    mediaType: "audio"
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
  introMediaUrl,
  introMediaMime,
  introMediaType = "video",
  recipientPhotoMime,
  shopifyUrl,
  africaUrl,
  language = "en",
  introDuration = 0,
  originalVideoBytes = 0,
  storedVideoBytes = 0,
  creationType = "premium_video",
  imageCount = 1,
  imageUrls = []
}) {
  const normalizedCreationType = normalizePrintoCreationType(creationType);
  const isMultiImage = normalizedCreationType === "premium_multi_image";
  const isWatchBuy = normalizedCreationType === "watch_buy";
  const usesMultipleImages = isMultiImage || isWatchBuy;
  const serviceLabel = isWatchBuy
    ? "PRINTO WATCH & BUY — POWERED BY PATAPATA"
    : isMultiImage
      ? "PRINTO PREMIUM MULTI-IMAGE FLIP TRIBUTE"
      : "PRINTO PREMIUM PERSONAL TRIBUTE";
  const creationCreditCost = getPrintoCreationCreditCost(normalizedCreationType);
  const extraImageList = Array.isArray(imageUrls) && imageUrls.length
    ? imageUrls.map((url, index) => `Image ${index + 1}: ${url}`).join("\n")
    : recipientPhotoUrl || "Not uploaded";

  const instructions = `${serviceLabel} ORDER

Premium order ID: ${orderId}
Creation type: ${normalizedCreationType}
Separate creation price: ${creationCreditCost} Printo credits
Image count: ${Number(imageCount || 1)}
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

Recipient photo(s):
${extraImageList}

Personal introduction ${String(introMediaType || "video").toLowerCase() === "audio" ? "audio" : "video"}:
${introMediaUrl || "Not uploaded"}

Introduction processing:
Type: ${String(introMediaType || "video").toUpperCase()}
Duration: ${Number(introDuration || 0).toFixed(1)} seconds
Original upload: ${Math.round(Number(originalVideoBytes || 0) / 1024 / 1024)} MB
Stored cleaned file: ${Math.round(Number(storedVideoBytes || 0) / 1024 / 1024)} MB

Custom tribute music:
Upload the completed song from this dashboard, then render the complete Premium video. The music will loop or extend continuously to the final Printo screen.

Shopify Premium Checkout:
${shopifyUrl || "Premium Shopify product not configured yet"}

Africa Payment:
${africaUrl || GREETING_AFRICA_PAYMENT_URL}

NEXT ACTION FOR WORKER:
1. Confirm payment before production.
2. Review the photo and personal introduction video or voice recording.
3. Contact the customer for any missing tribute-song details.
4. Prepare and deliver the finished premium Printo tribute video.`;

  try {
    await ensurePrintJobsDashboardColumns();
    const tableColumns = await getPrintJobsColumns();
    const primaryFileUrl = introMediaUrl || recipientPhotoUrl || "";
    const primaryMime = introMediaUrl
      ? introMediaMime || (introMediaType === "audio" ? "audio/mp4" : "video/mp4")
      : recipientPhotoMime || "image/jpeg";

    const valuesByColumn = {
      printer_id: process.env.AGENT_QUEUE_ID || "AGENT",
      queue_type: "AGENT",
      status: "pending",
      service_type: isMultiImage
        ? "GREETING_PREMIUM_MULTI_IMAGE"
        : "GREETING_PREMIUM",
      customer_name:
        senderName || recipientName || "Premium Greeting Customer",
      customer_email: customerEmail || "",
      customer_phone: contactPhone || "",
      original_name:
        `${isMultiImage ? "Printo Premium Multi-Image Flip" : "Printo Premium Tribute"} - ${recipientName}`,
      file_url: primaryFileUrl,
      mime_type: primaryMime,
      instruction_audio_url:
        introMediaType === "audio" ? introMediaUrl || "" : "",
      instructions,
      copies: 1,
      pages: 1,
      total_cost: 0,
      created_at: new Date(),
      updated_at: new Date()
    };

    const preferredOrder = [
      "printer_id", "queue_type", "status", "service_type",
      "customer_name", "customer_email", "customer_phone",
      "original_name", "file_url", "mime_type",
      "instruction_audio_url", "instructions", "copies", "pages",
      "total_cost", "created_at", "updated_at"
    ];
    const insertColumns = preferredOrder.filter((name) =>
      tableColumns.has(name)
    );

    if (!insertColumns.includes("status") || !insertColumns.includes("instructions")) {
      throw new Error(
        "print_jobs is missing the status or instructions column required for Premium jobs."
      );
    }

    const parameters = insertColumns.map((name) => valuesByColumn[name]);
    const placeholders = insertColumns.map((_name, index) => `$${index + 1}`);
    const result = await pool.query(
      `INSERT INTO print_jobs (${insertColumns.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING *`,
      parameters
    );

    const savedJob = result.rows[0] || null;
    console.log("Premium dashboard job created:", {
      orderId,
      jobId: savedJob?.id || null,
      creationType: normalizedCreationType,
      introMediaType,
      columns: insertColumns
    });
    return savedJob;
  } catch (error) {
    console.error("Premium greeting dashboard job insert failed:", {
      orderId,
      message: error?.message || error,
      code: error?.code || "",
      detail: error?.detail || ""
    });
    return null;
  }
}

let premiumDashboardRepairPromise = null;
let premiumDashboardRepairLastAt = 0;

function buildStoredPremiumMediaUrl(order, kind) {
  const orderId = String(order?.order_id || "").trim();
  const token = String(order?.media_token || "").trim();
  if (!orderId || !token) return "";
  return `${PRINTO_BRANDED_PUBLIC_ORIGIN}/premium-media/${encodeURIComponent(orderId)}/${encodeURIComponent(kind)}?token=${encodeURIComponent(token)}`;
}

async function syncMissingPremiumDashboardJobs({
  limit = 50,
  force = false,
  reason = "automatic"
} = {}) {
  const now = Date.now();
  if (!force && now - premiumDashboardRepairLastAt < 15000) {
    return { ok: true, skipped: true, recovered: 0, linked: 0, failed: 0 };
  }
  if (premiumDashboardRepairPromise) return premiumDashboardRepairPromise;

  premiumDashboardRepairPromise = (async () => {
    premiumDashboardRepairLastAt = Date.now();
    const tableReady = await ensurePrintJobsDashboardColumns();
    if (!tableReady) {
      return {
        ok: false,
        skipped: true,
        recovered: 0,
        linked: 0,
        failed: 0,
        error: "print_jobs table was not found"
      };
    }

    const missing = await queryWithRetry(
      `SELECT premium.*,
              COALESCE((
                SELECT COUNT(*)::integer
                FROM premium_greeting_images AS image
                WHERE image.order_id = premium.order_id
              ), 0) AS stored_image_count
       FROM premium_greeting_orders AS premium
       WHERE LOWER(COALESCE(premium.status, '')) IN (
               'paid', 'payment_required', 'approved'
             )
         AND (
           COALESCE(premium.dashboard_job_id, '') = ''
           OR NOT EXISTS (
             SELECT 1
             FROM print_jobs AS job
             WHERE job.id::text = premium.dashboard_job_id
           )
         )
       ORDER BY premium.created_at DESC
       LIMIT $1`,
      [Math.max(1, Math.min(200, Number(limit) || 50))]
    );

    let recovered = 0;
    let linked = 0;
    let failed = 0;

    for (const order of missing.rows) {
      try {
        // Prevent duplicate cards when an older server inserted the job but
        // failed before saving dashboard_job_id back to the Premium order.
        const existing = await pool.query(
          `SELECT id
           FROM print_jobs
           WHERE COALESCE(instructions, '') ILIKE $1
              OR COALESCE(original_name, '') ILIKE $1
           ORDER BY id DESC
           LIMIT 1`,
          [`%${String(order.order_id || "")}%`]
        );

        if (existing.rows[0]?.id) {
          await queryWithRetry(
            `UPDATE premium_greeting_orders
             SET dashboard_job_id = $2,
                 updated_at = NOW()
             WHERE order_id = $1`,
            [order.order_id, String(existing.rows[0].id)]
          );
          linked += 1;
          continue;
        }

        const creationType = normalizePrintoCreationType(
          order.creation_type || "premium_video"
        );
        const introMediaType =
          String(order.intro_media_type || "video").toLowerCase() === "audio"
            ? "audio"
            : "video";
        const photoUrl =
          String(order.recipient_photo_url || "").trim() ||
          buildStoredPremiumMediaUrl(order, "photo");
        const introUrl =
          String(order.intro_video_url || "").trim() ||
          buildStoredPremiumMediaUrl(
            order,
            introMediaType === "audio" ? "audio" : "video"
          );
        const imageCount = Math.max(
          1,
          Number(order.stored_image_count || 0) || 1
        );
        const imageUrls = Array.from({ length: imageCount }, (_value, index) =>
          `${PRINTO_BRANDED_PUBLIC_ORIGIN}/premium-media/${encodeURIComponent(order.order_id)}/image/${index + 1}?token=${encodeURIComponent(order.media_token || "")}`
        );
        const payment = buildPremiumPaymentLinks({
          orderId: order.order_id,
          customerKey: order.customer_key,
          contactPhone: order.contact_phone
        });

        const job = await createPremiumGreetingDashboardJob({
          orderId: order.order_id,
          customerKey: order.customer_key,
          contactPhone: order.contact_phone,
          customerEmail: order.customer_email,
          recipientName: order.recipient_name,
          senderName: order.sender_name,
          personalMessage: order.personal_message,
          songStyle: order.song_style,
          tributeNotes: order.tribute_notes,
          recipientPhotoUrl: photoUrl,
          introMediaUrl: introUrl,
          introMediaMime:
            order.intro_video_mime ||
            (introMediaType === "audio" ? "audio/mp4" : "video/mp4"),
          introMediaType,
          recipientPhotoMime: order.recipient_photo_mime || "image/jpeg",
          shopifyUrl: payment.shopify,
          africaUrl: payment.africa,
          language: "en",
          introDuration: Number(order.intro_video_duration_seconds || 0),
          originalVideoBytes: Number(order.intro_video_original_bytes || 0),
          storedVideoBytes: Number(order.intro_video_stored_bytes || 0),
          creationType,
          imageCount,
          imageUrls
        });

        if (!job?.id) {
          failed += 1;
          continue;
        }

        await queryWithRetry(
          `UPDATE premium_greeting_orders
           SET dashboard_job_id = $2,
               updated_at = NOW()
           WHERE order_id = $1`,
          [order.order_id, String(job.id)]
        );
        recovered += 1;
      } catch (error) {
        failed += 1;
        console.error("Premium dashboard job recovery failed:", {
          orderId: order?.order_id || "",
          reason,
          message: error?.message || error,
          code: error?.code || ""
        });
      }
    }

    if (recovered || linked || failed) {
      console.log("Premium dashboard job recovery finished:", {
        reason,
        checked: missing.rows.length,
        recovered,
        linked,
        failed
      });
    }

    return {
      ok: failed === 0,
      checked: missing.rows.length,
      recovered,
      linked,
      failed
    };
  })();

  try {
    return await premiumDashboardRepairPromise;
  } finally {
    premiumDashboardRepairPromise = null;
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

function getMultiImageGreetingShopifyQuantity(order = {}) {
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  const configuredVariantId = String(
    SHOPIFY_VARIANTS.GREETING_PREMIUM_MULTI_IMAGE || ""
  ).trim();
  let quantity = 0;

  for (const item of lineItems) {
    const itemVariantId = String(
      item?.variant_id || item?.variant?.id || ""
    ).trim();
    const title =
      `${item?.title || ""} ${item?.name || ""} ${item?.variant_title || ""}`
        .toLowerCase();

    const isConfiguredVariant =
      Boolean(configuredVariantId) && itemVariantId === configuredVariantId;
    const isNamedMultiImage =
      title.includes("printo") &&
      (
        title.includes("multi-image") ||
        title.includes("multi image") ||
        title.includes("image flip")
      ) &&
      !title.includes("subscription");

    if (isConfiguredVariant || isNamedMultiImage) {
      quantity += Math.max(1, Number(item?.quantity || 1));
    }
  }

  if (quantity === 0) {
    const packageName = getShopifyNoteAttribute(order, [
      "Greeting Package",
      "greeting_package",
      "Printo Greeting Package"
    ]).toUpperCase();

    if (packageName === "GREETING_PREMIUM_MULTI_IMAGE_CREDITS") {
      quantity = 1;
    }
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
  if (type === "PREMIUM_MULTI_IMAGE") {
    return SHOPIFY_VARIANTS.GREETING_PREMIUM_MULTI_IMAGE;
  }
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

function getPrintoWhatsAppAppSecrets() {
  const candidates = [
    ["META_APP_SECRET", process.env.META_APP_SECRET],
    ["WHATSAPP_APP_SECRET", process.env.WHATSAPP_APP_SECRET],
    ["FACEBOOK_APP_SECRET", process.env.FACEBOOK_APP_SECRET]
  ];

  const extraSecrets = String(process.env.META_APP_SECRETS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  extraSecrets.forEach((secret, index) => {
    candidates.push([`META_APP_SECRETS_${index + 1}`, secret]);
  });

  const seen = new Set();

  return candidates
    .map(([name, value]) => [name, String(value || "").trim()])
    .filter(([, value]) => Boolean(value))
    .filter(([, value]) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function getPrintoWhatsAppAppSecret() {
  return getPrintoWhatsAppAppSecrets()[0]?.[1] || "";
}

function verifyPrintoWhatsAppWebhookSignature(req) {
  const provided = String(req.headers["x-hub-signature-256"] || "").trim();
  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
  const appSecrets = getPrintoWhatsAppAppSecrets();

  if (!rawBody || appSecrets.length === 0) return false;
  if (!/^sha256=[a-f0-9]{64}$/i.test(provided)) return false;

  const providedDigest = Buffer.from(
    provided.slice("sha256=".length),
    "hex"
  );

  for (const [secretName, secretValue] of appSecrets) {
    const expectedDigest = crypto
      .createHmac("sha256", secretValue)
      .update(rawBody)
      .digest();

    if (
      expectedDigest.length === providedDigest.length &&
      crypto.timingSafeEqual(expectedDigest, providedDigest)
    ) {
      req.printoMetaSecretSource = secretName;
      return true;
    }
  }

  return false;
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
  const language = normalizePrintoStudioLanguage(req.query.lang || "en");
  const next = String(req.query.next || "/greetings");
  const safeNextBase = next.startsWith("/") && !next.startsWith("//") ? next : "/greetings";
  const safeNext = addPrintoLanguageToPath(safeNextBase, language);
  const tx = (phrase) => translatePrintoStudioPhrase(language, phrase);
  const loginText = {
    account: tx("Printo Account"),
    oneNumber: tx("Use one verified WhatsApp phone number for one Printo account."),
    welcomeNotice: tx("A verified phone number receives the 100 welcome credits only once. Invented email addresses can no longer create free-credit accounts."),
    createAccount: tx("Create Account"),
    logIn: tx("Log In"),
    phoneNumber: tx("WhatsApp Phone Number"),
    phoneHelp: tx("Include the country code. The number must be connected to WhatsApp."),
    verifyNumber: tx("Verify Number with WhatsApp"),
    verifyInstructions: tx("Tap the button, send the prepared message in WhatsApp, then return here."),
    openVerification: tx("Open WhatsApp verification"),
    existingEmail: tx("Existing Email Address"),
    legacyHelp: tx("Only for an account created before phone verification was introduced."),
    pinNumber: tx("PIN Number"),
    pinPlaceholder: tx("4–8 numbers"),
    createAndReceive: tx("Create Account & Receive 100 Credits"),
    oldEmailLogin: tx("Existing old email account? Log in here"),
    phoneLogin: tx("Use phone-number login instead"),
    loginToAccount: tx("Log In to My Account"),
    preparing: tx("Preparing WhatsApp verification..."),
    openingWhatsApp: tx("WhatsApp is opening. Send the prepared PRINTO VERIFY message, then return to this page."),
    verified: tx("Phone number verified. Choose your PIN and create the account."),
    expired: tx("Verification expired. Tap Verify Number with WhatsApp again."),
    verifyFirst: tx("Verify your WhatsApp phone number first."),
    creating: tx("Creating your verified account..."),
    loggingIn: tx("Logging in..."),
    success: tx("Success. Opening Printo Studio..."),
    returnStudio: tx("Return to Printo Studio"),
    checkFailed: tx("Could not check verification."),
    startFailed: tx("Could not start verification."),
    accountFailed: tx("Account request failed")
  };
  const loginTextJson = JSON.stringify(loginText).replace(/</g, "\\u003c");
  const studioHref = addPrintoLanguageToPath("/greetings", language);

  return res.type("html").send(`<!doctype html>
<html lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(loginText.account)}</title><style>
*{box-sizing:border-box}body{margin:0;font-family:Arial;background:linear-gradient(160deg,#071b61,#0b63ce);min-height:100vh;color:#fff;padding:20px}
.wrap{max-width:590px;margin:28px auto}.head{text-align:center}.card{background:#fff;color:#102a72;border-radius:22px;padding:22px;box-shadow:0 18px 50px rgba(0,0,0,.35)}
.tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}.tabs button{border:0;border-radius:12px;padding:13px;font-weight:900;cursor:pointer}
.tabs .active{background:#123faa;color:#fff}.tabs button:not(.active){background:#e8efff;color:#123faa}
label{display:block;font-weight:900;margin:13px 0 7px}input{width:100%;padding:13px;border:2px solid #cbd5e1;border-radius:12px;font-size:17px}
.verifyBox{background:#edf7ff;border:2px solid #71b7ff;border-radius:14px;padding:14px;margin-top:14px}.verifyBtn{width:100%;border:0;border-radius:12px;padding:14px;background:#25D366;color:#073b1a;font-size:17px;font-weight:900;cursor:pointer}.verifyBtn:disabled{opacity:.6}
.submit{width:100%;margin-top:18px;border:0;border-radius:13px;padding:15px;background:linear-gradient(90deg,#7b2cbf,#d63384);color:#fff;font-size:18px;font-weight:900;cursor:pointer}.submit:disabled{opacity:.5;cursor:not-allowed}
.status{min-height:28px;text-align:center;margin-top:12px;font-weight:800;line-height:1.45}.note{background:#fff4b8;border:2px solid #ffd21f;border-radius:13px;padding:13px;line-height:1.5}.back{display:block;text-align:center;color:#ffd21f;font-weight:900;text-decoration:none;margin-top:16px}.small{font-size:13px;line-height:1.45;color:#475569}.legacy{margin-top:14px;text-align:center}.legacy button{border:0;background:transparent;color:#123faa;text-decoration:underline;font-weight:900;cursor:pointer}.hidden{display:none!important}.verified{color:#087a35}.error{color:#b42318}.waFallback{display:inline-block;margin-top:9px;font-weight:900;color:#123faa}
</style></head><body><main class="wrap"><div class="head"><h1>⭐ ${escapeHtml(loginText.account)}</h1><p>${escapeHtml(loginText.oneNumber)}</p></div>
<div class="card"><div class="note">🎁 ${escapeHtml(loginText.welcomeNotice)}</div>
<div class="tabs"><button id="registerTab" class="active" type="button">${escapeHtml(loginText.createAccount)}</button><button id="loginTab" type="button">${escapeHtml(loginText.logIn)}</button></div>
<form id="accountForm"><input id="mode" type="hidden" value="register">
<div id="phoneGroup"><label>${escapeHtml(loginText.phoneNumber)}</label><input id="phone" type="tel" autocomplete="tel" required placeholder="+1 862 230 6637"><div class="small">${escapeHtml(loginText.phoneHelp)}</div></div>
<div id="verifyBox" class="verifyBox"><button id="verifyBtn" class="verifyBtn" type="button">✅ ${escapeHtml(loginText.verifyNumber)}</button><div id="verifyStatus" class="status">${escapeHtml(loginText.verifyInstructions)}</div><a id="waFallback" class="waFallback hidden" target="_blank" rel="noopener">${escapeHtml(loginText.openVerification)}</a></div>
<div id="legacyGroup" class="hidden"><label>${escapeHtml(loginText.existingEmail)}</label><input id="legacyEmail" type="email" autocomplete="email"><div class="small">${escapeHtml(loginText.legacyHelp)}</div></div>
<label>${escapeHtml(loginText.pinNumber)}</label><input id="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" autocomplete="current-password" required placeholder="${escapeHtml(loginText.pinPlaceholder)}">
<button id="submit" class="submit" type="submit" disabled>${escapeHtml(loginText.createAndReceive)}</button><div id="status" class="status"></div></form>
<div id="legacyLink" class="legacy hidden"><button id="legacyToggle" type="button">${escapeHtml(loginText.oldEmailLogin)}</button></div></div>
<a class="back" href="${escapeHtml(studioHref)}">← ${escapeHtml(loginText.returnStudio)}</a></main>
<script>
const next=${JSON.stringify(safeNext)};
const loginText=${loginTextJson};
const form=document.getElementById('accountForm'),mode=document.getElementById('mode'),submit=document.getElementById('submit'),statusBox=document.getElementById('status'),registerTab=document.getElementById('registerTab'),loginTab=document.getElementById('loginTab'),phoneInput=document.getElementById('phone'),pinInput=document.getElementById('pin'),verifyBox=document.getElementById('verifyBox'),verifyBtn=document.getElementById('verifyBtn'),verifyStatus=document.getElementById('verifyStatus'),waFallback=document.getElementById('waFallback'),legacyLink=document.getElementById('legacyLink'),legacyToggle=document.getElementById('legacyToggle'),legacyGroup=document.getElementById('legacyGroup'),legacyEmail=document.getElementById('legacyEmail');
let challengeToken='',verifiedPhone='',pollTimer=null,legacyMode=false;
function stopPolling(){if(pollTimer){clearInterval(pollTimer);pollTimer=null;}}
function resetVerification(){stopPolling();challengeToken='';verifiedPhone='';verifyBtn.disabled=false;verifyStatus.className='status';verifyStatus.textContent=loginText.verifyInstructions;waFallback.classList.add('hidden');waFallback.removeAttribute('href');if(mode.value==='register')submit.disabled=true;}
function selectMode(value){mode.value=value;registerTab.classList.toggle('active',value==='register');loginTab.classList.toggle('active',value==='login');verifyBox.classList.toggle('hidden',value!=='register');legacyLink.classList.toggle('hidden',value!=='login');legacyGroup.classList.add('hidden');legacyMode=false;legacyToggle.textContent=loginText.oldEmailLogin;phoneInput.required=true;legacyEmail.required=false;submit.textContent=value==='register'?loginText.createAndReceive:loginText.loginToAccount;submit.disabled=value==='register';statusBox.textContent='';resetVerification();}
registerTab.onclick=()=>selectMode('register');loginTab.onclick=()=>selectMode('login');
legacyToggle.onclick=()=>{legacyMode=!legacyMode;legacyGroup.classList.toggle('hidden',!legacyMode);document.getElementById('phoneGroup').classList.toggle('hidden',legacyMode);legacyEmail.required=legacyMode;phoneInput.required=!legacyMode;legacyToggle.textContent=legacyMode?loginText.phoneLogin:loginText.oldEmailLogin;};
phoneInput.addEventListener('input',()=>{if(phoneInput.value!==verifiedPhone)resetVerification();});
async function pollVerification(){if(!challengeToken)return;try{const response=await fetch('/api/customer/account/phone/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challengeToken})});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||loginText.checkFailed);if(data.confirmed){stopPolling();verifiedPhone=phoneInput.value;verifyStatus.className='status verified';verifyStatus.textContent='✅ '+loginText.verified;verifyBtn.disabled=true;submit.disabled=false;}else if(data.expired||data.used){stopPolling();verifyStatus.className='status error';verifyStatus.textContent='❌ '+loginText.expired;verifyBtn.disabled=false;submit.disabled=true;}}catch(_){}}
verifyBtn.onclick=async()=>{resetVerification();verifyBtn.disabled=true;verifyStatus.textContent=loginText.preparing;let popup=null;try{popup=window.open('about:blank','_blank');const response=await fetch('/api/customer/account/phone/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:phoneInput.value})});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||loginText.startFailed);challengeToken=String(data.challengeToken||'');waFallback.href=data.whatsappUrl;waFallback.classList.remove('hidden');verifyStatus.textContent=loginText.openingWhatsApp;if(popup)popup.location=data.whatsappUrl;else window.location.href=data.whatsappUrl;pollTimer=setInterval(pollVerification,2000);pollVerification();}catch(error){if(popup)popup.close();verifyStatus.className='status error';verifyStatus.textContent='❌ '+error.message;verifyBtn.disabled=false;}};
form.addEventListener('submit',async(e)=>{e.preventDefault();if(mode.value==='register'&&!challengeToken){statusBox.textContent='❌ '+loginText.verifyFirst;return;}submit.disabled=true;statusBox.textContent=mode.value==='register'?loginText.creating:loginText.loggingIn;try{const payload={pin:pinInput.value};if(mode.value==='register'){payload.phone=phoneInput.value;payload.challengeToken=challengeToken;}else if(legacyMode){payload.email=legacyEmail.value;}else{payload.phone=phoneInput.value;}const response=await fetch('/api/customer/account/'+mode.value,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||loginText.accountFailed);localStorage.setItem('printoGreetingCustomerKey',String(data.customerKey));localStorage.setItem('printoGreetingCustomerId',String(data.customerId||data.phone||data.email||''));if(data.phone)localStorage.setItem('printoGreetingCustomerPhone',String(data.phone));else localStorage.removeItem('printoGreetingCustomerPhone');if(data.email)localStorage.setItem('printoGreetingCustomerEmail',String(data.email));else localStorage.removeItem('printoGreetingCustomerEmail');statusBox.className='status verified';statusBox.textContent='✅ '+loginText.success;window.location.href=next;}catch(error){statusBox.className='status error';statusBox.textContent='❌ '+error.message;}finally{if(mode.value==='login'||verifiedPhone)submit.disabled=false;}});
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

    const multiImageQuantity = getMultiImageGreetingShopifyQuantity(order);
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

    if (multiImageQuantity > 0) {
      const requestedCredits =
        PRINTO_MULTI_IMAGE_SINGLE_PURCHASE_CREDITS * multiImageQuantity;

      const result = await grantGreetingPaidCredits({
        customerKey,
        contactPhone,
        credits: requestedCredits,
        provider: "shopify",
        eventKey: `shopify:multi-image:${orderReference}`,
        payload: order
      });

      if (contactPhone && !result.duplicate) {
        await sendMessage(
          contactPhone,
          `✅ Your Printo Multi-Image Flip payment is confirmed.

${requestedCredits} Printo credits have been added to your account.

You can now create one Multi-Image Flip video:
${buildBrandedPrintoStudioUrl("en")}`
        );
      }

      return res.status(200).json({
        ok: true,
        multiImagePurchase: true,
        customerKey,
        credits: requestedCredits,
        result
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
      const metaSignatureVerified =
        verifyPrintoWhatsAppWebhookSignature(req);

      if (metaSignatureVerified) {
        console.log(
          "Verified Printo phone-verification webhook signature.",
          { secretSource: req.printoMetaSecretSource || "configured-secret" }
        );
      } else {
        // Do not block the legitimate WhatsApp verification flow when Meta's
        // app-secret signature cannot be matched. The verification request is
        // still protected by a 192-bit random, hashed, one-time challenge that
        // must arrive from the exact phone number entered by the customer,
        // while pending and before its 10-minute expiration.
        console.warn(
          "Meta signature did not match; continuing with strict one-time phone challenge validation.",
          {
            hasAppSecret: Boolean(getPrintoWhatsAppAppSecret()),
            hasSignature: Boolean(req.headers["x-hub-signature-256"]),
            rawBodyBytes: Buffer.isBuffer(req.rawBody) ? req.rawBody.length : 0,
            contentType: String(req.headers["content-type"] || "")
          }
        );
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
let printJobsDashboardColumnsReady = false;

async function ensurePrintJobsDashboardColumns() {
  if (printJobsDashboardColumnsReady) return true;

  const found = await pool.query(
    `SELECT to_regclass('public.print_jobs') AS table_name`
  );
  if (!found.rows[0]?.table_name) return false;

  const upgrades = [
    ["printer_id", "TEXT NOT NULL DEFAULT 'AGENT'"],
    ["queue_type", "TEXT NOT NULL DEFAULT 'WORKER'"],
    ["status", "TEXT NOT NULL DEFAULT 'pending'"],
    ["file_url", "TEXT NOT NULL DEFAULT ''"],
    ["original_name", "TEXT NOT NULL DEFAULT ''"],
    ["paper_size", "TEXT"],
    ["color_mode", "TEXT"],
    ["copies", "INTEGER NOT NULL DEFAULT 1"],
    ["pages", "INTEGER NOT NULL DEFAULT 1"],
    ["instructions", "TEXT NOT NULL DEFAULT ''"],
    ["instruction_audio_url", "TEXT NOT NULL DEFAULT ''"],
    ["service_type", "TEXT NOT NULL DEFAULT 'SERVICE'"],
    ["customer_phone", "TEXT NOT NULL DEFAULT ''"],
    ["customer_name", "TEXT NOT NULL DEFAULT ''"],
    ["customer_email", "TEXT NOT NULL DEFAULT ''"],
    ["mime_type", "TEXT NOT NULL DEFAULT ''"],
    ["total_cost", "NUMERIC NOT NULL DEFAULT 0"],
    ["created_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"],
    ["updated_at", "TIMESTAMPTZ NOT NULL DEFAULT NOW()"]
  ];

  for (const [columnName, definition] of upgrades) {
    await pool.query(
      `ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS ${columnName} ${definition}`
    );
  }

  printJobsDashboardColumnsReady = true;
  return true;
}

async function getPrintJobsColumns() {
  const q = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'print_jobs'
  `);
  return new Set(q.rows.map(r => r.column_name));
}

function dashboardColumnExpression(columns, name, fallbackSql) {
  return columns.has(name)
    ? name
    : `${fallbackSql} AS ${name}`;
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
    await ensurePrintJobsDashboardColumns();
    const recovery = await syncMissingPremiumDashboardJobs({
      limit: 75,
      reason: "dashboard_api"
    });
    const columns = await getPrintJobsColumns();

    if (!columns.has("id")) {
      throw new Error("print_jobs does not contain its required id column.");
    }

    const {
      status = "",
      q = "",
      queue = "",
      printer_id = "",
      limit = "100"
    } = req.query;

    const params = [];
    const where = [];

    if (status && columns.has("status")) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    if (queue === "agent") {
      const queueClauses = [];
      if (columns.has("queue_type")) queueClauses.push(`queue_type = 'AGENT'`);
      if (columns.has("printer_id")) {
        params.push(AGENT_QUEUE_ID);
        queueClauses.push(`printer_id = $${params.length}`);
      }
      if (queueClauses.length) where.push(`(${queueClauses.join(" OR ")})`);
    } else if (queue === "dispatch") {
      const queueClauses = [];
      if (columns.has("queue_type")) queueClauses.push(`queue_type = 'DISPATCH'`);
      if (columns.has("printer_id")) {
        params.push(DISPATCH_QUEUE_ID);
        queueClauses.push(`printer_id = $${params.length}`);
      }
      if (queueClauses.length) where.push(`(${queueClauses.join(" OR ")})`);
    } else if (queue === "worker" && columns.has("queue_type")) {
      where.push(`(
        COALESCE(queue_type, '') <> 'AGENT'
        AND COALESCE(queue_type, '') <> 'DISPATCH'
      )`);
    }

    if (printer_id && columns.has("printer_id")) {
      params.push(printer_id);
      where.push(`printer_id = $${params.length}`);
    }

    if (q) {
      const searchableColumns = [
        "original_name", "file_url", "instructions", "customer_phone",
        "customer_name", "customer_email", "printer_id", "service_type"
      ].filter((name) => columns.has(name));

      if (searchableColumns.length) {
        params.push(`%${q}%`);
        const placeholder = `$${params.length}`;
        where.push(`(${searchableColumns
          .map((name) => `COALESCE(${name}::text, '') ILIKE ${placeholder}`)
          .join(" OR ")})`);
      }
    }

    params.push(Math.min(parseInt(limit, 10) || 100, 300));

    const selectColumns = [
      dashboardColumnExpression(columns, "id", "NULL::bigint"),
      dashboardColumnExpression(columns, "printer_id", "''::text"),
      dashboardColumnExpression(columns, "queue_type", "''::text"),
      dashboardColumnExpression(columns, "status", "'pending'::text"),
      dashboardColumnExpression(columns, "file_url", "''::text"),
      dashboardColumnExpression(columns, "original_name", "''::text"),
      dashboardColumnExpression(columns, "paper_size", "NULL::text"),
      dashboardColumnExpression(columns, "color_mode", "NULL::text"),
      dashboardColumnExpression(columns, "copies", "1::integer"),
      dashboardColumnExpression(columns, "pages", "1::integer"),
      dashboardColumnExpression(columns, "instructions", "''::text"),
      dashboardColumnExpression(columns, "instruction_audio_url", "''::text"),
      dashboardColumnExpression(columns, "service_type", "'SERVICE'::text"),
      dashboardColumnExpression(columns, "customer_phone", "''::text"),
      dashboardColumnExpression(columns, "customer_name", "''::text"),
      dashboardColumnExpression(columns, "customer_email", "''::text"),
      dashboardColumnExpression(columns, "mime_type", "''::text"),
      dashboardColumnExpression(columns, "created_at", "NULL::timestamptz"),
      dashboardColumnExpression(columns, "updated_at", "NULL::timestamptz")
    ];

    const sql = `
      SELECT ${selectColumns.join(",\n             ")}
      FROM print_jobs
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id DESC
      LIMIT $${params.length}
    `;

    const result = await pool.query(sql, params);
    return res.json({
      ok: true,
      jobs: result.rows,
      printers: getPrinterRegistry(),
      premiumRecovery: recovery
    });
  } catch (err) {
    console.error("Dashboard jobs error:", {
      message: err?.message || err,
      code: err?.code || "",
      detail: err?.detail || ""
    });
    return res.status(500).json({ ok: false, error: err.message });
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
 * Send a Printo share email from the server.
 * Required Render env vars:
 *   RESEND_API_KEY
 *   PRINTO_EMAIL_FROM  (example: Printo <share@patapata.us>)
 */
app.post("/api/share/email", express.json({ limit: "32kb" }), async (req, res) => {
  try {
    const to = String(req.body?.to || "").trim();
    const subject = String(req.body?.subject || "Printo video").trim().slice(0, 160);
    const text = String(req.body?.text || "").trim().slice(0, 12000);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ ok: false, error: "Enter a valid email address." });
    }
    if (!text) {
      return res.status(400).json({ ok: false, error: "Email message is empty." });
    }

    const apiKey = String(process.env.RESEND_API_KEY || "").trim();
    const from = String(process.env.PRINTO_EMAIL_FROM || "").trim();
    if (!apiKey || !from) {
      return res.status(503).json({
        ok: false,
        error: "Email sending is not configured. Add RESEND_API_KEY and PRINTO_EMAIL_FROM on Render."
      });
    }

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from, to: [to], subject, text })
    });

    const data = await emailResponse.json().catch(() => ({}));
    if (!emailResponse.ok) {
      console.error("Printo email share failed:", data);
      return res.status(502).json({
        ok: false,
        error: data?.message || data?.error?.message || "Email provider rejected the message."
      });
    }

    return res.json({ ok: true, sent: true, id: data?.id || null });
  } catch (error) {
    console.error("Printo email share error:", error);
    return res.status(500).json({ ok: false, error: error.message || "Email send failed." });
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

    // Meta expects the WhatsApp recipient as digits only (country code included).
    // Jobs can contain +, spaces, dashes or brackets, so normalize before sending.
    const normalizedPhone = String(phone).replace(/\D/g, "");
    if (!normalizedPhone || normalizedPhone.length < 8) {
      return res.status(400).json({ ok: false, error: "Invalid WhatsApp number on this job" });
    }

    const sendResult = await sendWhatsAppText(normalizedPhone, message);
    if (!sendResult.ok) {
      console.error("Dashboard WhatsApp send failed:", sendResult.error);
      const detail = typeof sendResult.error === "string"
        ? sendResult.error
        : (sendResult.error?.error?.message || JSON.stringify(sendResult.error));
      return res.status(502).json({ ok: false, error: detail || "WhatsApp send failed" });
    }
const customerSession = getSession(normalizedPhone);
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
    .jobBody > *,
    .previewBox,
    .detailBox,
    .insBox{
      min-width:0;
      max-width:100%;
    }
    .insBox{
      overflow-wrap:anywhere;
      word-break:break-word;
    }
    .premiumProductionActions{
      width:100%;
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:10px;
      margin-top:12px;
      align-items:stretch;
    }
    .premiumProductionActions .premiumAction,
    .premiumProductionActions .premiumMusicForm,
    .premiumProductionActions .premiumMusicChooseButton,
    .premiumProductionActions .premiumRenderButton{
      width:100%;
      max-width:100%;
      min-width:0;
    }
    .premiumProductionActions .premiumAction,
    .premiumProductionActions .premiumMusicChooseButton,
    .premiumProductionActions .premiumRenderButton{
      display:flex;
      align-items:center;
      justify-content:center;
      min-height:48px;
      padding:11px 12px;
      border-radius:12px;
      white-space:normal;
      overflow-wrap:anywhere;
      text-align:center;
      line-height:1.25;
      font-size:14px;
      text-decoration:none;
    }
    .premiumProductionActions .premiumMusicForm{
      display:block !important;
    }
    .premiumAudioPlayer{
      grid-column:1 / -1;
      width:100%;
      padding:12px;
      border-radius:14px;
      background:rgba(8,17,31,.72);
      border:2px solid rgba(143,209,255,.35);
    }
    .premiumAudioPlayer strong{
      display:block;
      margin-bottom:8px;
      color:#8fd1ff;
      font-size:15px;
    }
    .premiumAudioPlayer audio{
      display:block;
      width:100%;
      min-height:48px;
    }
    .premiumAudioPlayer .audioHelp{
      display:block;
      margin-top:7px;
      color:var(--muted);
      font-size:12px;
      line-height:1.4;
    }
    .premiumProductionStatus{
      grid-column:1 / -1;
      display:block;
      width:100%;
      padding:10px 12px;
      border-radius:10px;
      background:rgba(255,255,255,.05);
      overflow-wrap:anywhere;
      line-height:1.4;
    }
    .premiumProductionHint{
      margin-top:10px;
      line-height:1.45;
      overflow-wrap:anywhere;
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
    .backToJobsButton{
      position:fixed;
      right:14px;
      bottom:86px;
      z-index:9999;
      border:0;
      border-radius:999px;
      padding:13px 17px;
      background:#ffd34f;
      color:#071225;
      font-weight:1000;
      font-size:15px;
      box-shadow:0 10px 30px rgba(0,0,0,.45);
      cursor:pointer;
      display:none;
    }
    .backToJobsButton.show{display:block}
    .dashboardRefreshStatus{
      position:fixed;
      left:50%;
      bottom:18px;
      transform:translateX(-50%);
      z-index:9998;
      border-radius:999px;
      padding:8px 13px;
      background:rgba(7,18,37,.92);
      color:#dbeafe;
      border:1px solid rgba(143,209,255,.35);
      font-size:12px;
      font-weight:800;
      pointer-events:none;
      opacity:0;
      transition:opacity .2s ease;
    }
    .dashboardRefreshStatus.show{opacity:1}
    @media (max-width: 1100px){
      .hero,.main,.jobBody,.toolbar{grid-template-columns:1fr}
    }
    @media (max-width: 700px){
      .wrap{padding:10px}
      .panel,.sidePanel,.uploadPanel{padding:10px}
      .jobHead,.jobBody{padding:11px}
      .previewBox,.detailBox,.insBox{padding:10px}
      .detailRow{grid-template-columns:1fr;gap:4px}
      .premiumProductionActions{grid-template-columns:1fr}
      .premiumProductionStatus{grid-column:auto}
      .premiumProductionActions .premiumAction,
      .premiumProductionActions .premiumMusicChooseButton,
      .premiumProductionActions .premiumRenderButton{
        min-height:52px;
        font-size:15px;
      }
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
      <button class="btn secondary" onclick="loadJobs({preserveScroll:true})">Refresh</button>
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
  <button id="backToJobsButton" class="backToJobsButton" type="button">⬆ Back to Jobs</button>
  <div id="dashboardRefreshStatus" class="dashboardRefreshStatus">Jobs updated</div>

<script>
  const DASHBOARD_KEY = ${JSON.stringify(req.query.key || "")};
  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }
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
    loadJobs({ preserveScroll: true });
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
    if (!String(job.service_type || "").toUpperCase().startsWith("GREETING_PREMIUM")) return "";

    const photoUrl = extractLabeledInstructionUrl(job, "Recipient photo");
    const videoUrl = extractLabeledInstructionUrl(job, "Personal introduction video");
    const savedAudioUrl = extractLabeledInstructionUrl(job, "Personal introduction audio");
    const orderId = extractPremiumOrderId(job);
    const audioUrl = savedAudioUrl
      ? savedAudioUrl.replace(
          /(\\/premium-media\\/[^/?]+)\\/(?:photo|video)(\\?)/i,
          "$1/audio$2"
        )
      : "";
    const combined = [job.instructions || "", job.notes || "", job.error_message || ""].join("\\n");
    const urls = combined.match(/https?:\\/\\/[^\\s<]+/g) || [];
    const musicUrl = urls.find((url) => url.includes("/premium-media/") && url.includes("/music?")) || "";
    const finalShareUrl = urls.find((url) => url.includes("/premium-result/")) || "";
    const finalDownloadUrl = urls.find((url) => url.includes("/premium-media/") && url.includes("/final?")) || "";
    const finalUrl = finalShareUrl || finalDownloadUrl;
    const actions = [];

    if (orderId) {
      const uploadLabel = musicUrl ? "✅ Replace Tribute Music" : "🎵 Upload Tribute Music";
      const renderLabel = finalUrl
        ? "🎬 Re-render Complete Premium Video"
        : "🎬 Render Complete Premium Video";

      actions.push(
        '<span class="premiumMusicForm" data-order-id="' + h(orderId) + '">' +
          '<input class="premiumMusicInput" data-order-id="' + h(orderId) + '" name="tributeMusic" type="file" ' +
          'accept=".mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,audio/*" ' +
          'style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;">' +
          '<button type="button" class="btn secondary premiumMusicChooseButton" data-order-id="' + h(orderId) + '">' +
            uploadLabel +
          '</button>' +
        '</span>'
      );

      actions.push(
        '<button type="button" class="btn premiumRenderButton" data-order-id="' + h(orderId) + '"' +
          (musicUrl ? '' : ' disabled title="Upload tribute music first"') +
          '>' + renderLabel + '</button>'
      );
    }

    if (photoUrl) {
      actions.push(
        '<a class="fileLink premiumAction" href="' + h(photoUrl) +
        '" target="_blank" rel="noopener noreferrer">📸 Open Recipient Photo</a>'
      );
    }

    if (videoUrl) {
      actions.push(
        '<a class="fileLink premiumAction" href="' + h(videoUrl) +
        '" target="_blank" rel="noopener noreferrer">🎥 Play Introduction Video</a>'
      );
    }

    if (audioUrl) {
      actions.push(
        '<div class="premiumAudioPlayer">' +
          '<strong>🎙️ Voice Introduction</strong>' +
          '<audio controls playsinline preload="metadata" src="' + h(audioUrl) + '">' +
            'Your browser cannot play this voice introduction.' +
          '</audio>' +
          '<span class="audioHelp">Press play here to review the customer’s recorded voice before rendering.</span>' +
          '<a class="fileLink" href="' + h(audioUrl) +
            '" target="_blank" rel="noopener noreferrer">Open voice file in a new tab</a>' +
        '</div>'
      );
    }

    if (musicUrl) {
      actions.push(
        '<a class="fileLink premiumAction" href="' + h(musicUrl) +
        '" target="_blank" rel="noopener noreferrer">🎵 Play Tribute Music</a>'
      );
    }

    if (finalUrl) {
      actions.push(
        '<a class="fileLink premiumAction" href="' + h(finalUrl) +
        '" target="_blank" rel="noopener noreferrer">🎬 Play & Share Finished Premium Video</a>'
      );
    }

    if (finalDownloadUrl) {
      actions.push(
        '<a class="fileLink premiumAction" href="' + h(finalDownloadUrl) +
        '" target="_blank" rel="noopener noreferrer">⬇ Download Finished Premium Video</a>'
      );
    }

    if (!actions.length) {
      return '<div class="insBox"><b>Premium Production</b><br>' +
        '<span class="small">No Premium assets were found on this job.</span></div>';
    }

    const statusText = orderId
      ? (musicUrl
          ? "✅ Tribute music is stored. You can render or re-render the complete Premium video."
          : "Choose the completed tribute song, tap Upload Tribute Music, then tap Render Complete Premium Video.")
      : "Premium order ID was not found on this job. Refresh the dashboard or reopen the Premium order.";

    return '<div class="insBox premiumProductionBox">' +
      '<b>Premium Production</b>' +
      '<div class="premiumProductionActions">' + actions.join("") + '</div>' +
      '<span class="small premiumMusicStatus premiumProductionStatus" data-order-id="' +
        h(orderId || "") + '">' + h(statusText) + '</span>' +
      '<div class="small premiumProductionHint">' +
        'The selected video or voice introduction plays first. The uploaded tribute song begins immediately afterward ' +
        'and continues through the final Printo screen.' +
      '</div>' +
    '</div>';
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

  async function loadJobs(options = {}) {
    const grid = document.getElementById("jobGrid");
    const silent = Boolean(options.silent);
    const preserveScroll = options.preserveScroll !== false;
    const previousScrollY = window.scrollY;
    const previousGridHeight = grid ? grid.offsetHeight : 0;
    const hadRenderedJobs = Boolean(
      grid &&
      grid.children.length &&
      !grid.querySelector(".emptyState")
    );

    try {
      // Keep existing cards visible during refresh. Replacing them with a
      // tiny loading box caused mobile browsers to jump to Worker Notes.
      if (grid && !silent && !hadRenderedJobs) {
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
        if (preserveScroll) {
          requestAnimationFrame(() => {
            window.scrollTo({ top: previousScrollY, left: 0, behavior: "instant" });
          });
        }
        updateBackToJobsButton();
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

      if (preserveScroll) {
        requestAnimationFrame(() => {
          const newGridHeight = grid ? grid.offsetHeight : 0;
          const gridTop = grid ? grid.offsetTop : 0;
          const heightDelta = newGridHeight - previousGridHeight;
          const targetScroll = Math.max(
            0,
            previousScrollY + (previousScrollY > gridTop ? heightDelta : 0)
          );
          window.scrollTo({ top: targetScroll, left: 0, behavior: "instant" });
        });
      }

      if (silent) showDashboardRefreshStatus("Jobs updated");
      updateBackToJobsButton();
    } catch (err) {
      console.error("Worker dashboard load failed", err);
      document.getElementById("s_all").textContent = "0";
      document.getElementById("s_pending").textContent = "0";
      document.getElementById("s_completed").textContent = "0";
      document.getElementById("s_working").textContent = "0";
      const hasVisibleJobCard = Boolean(grid?.querySelector(".jobCard"));
      if (grid && !hasVisibleJobCard) {
        grid.innerHTML =
          '<div class="emptyState"><b>Dashboard could not load jobs.</b><br><br>' +
          h(err.message || String(err)) +
          '<br><br>Open Render logs and search for <b>Dashboard jobs error</b> or <b>Premium dashboard job recovery failed</b>.</div>';
      } else if (grid) {
        showDashboardRefreshStatus("Refresh failed — existing jobs kept");
      }

      if (preserveScroll) {
        requestAnimationFrame(() => {
          window.scrollTo({ top: previousScrollY, left: 0, behavior: "instant" });
        });
      }
      updateBackToJobsButton();
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

  let dashboardRefreshStatusTimer = null;

  function showDashboardRefreshStatus(message) {
    const node = document.getElementById("dashboardRefreshStatus");
    if (!node) return;
    node.textContent = message || "Jobs updated";
    node.classList.add("show");
    clearTimeout(dashboardRefreshStatusTimer);
    dashboardRefreshStatusTimer = setTimeout(() => {
      node.classList.remove("show");
    }, 1600);
  }

  function scrollToJobs() {
    const panel = document.getElementById("jobGrid");
    if (!panel) return;
    const top = Math.max(
      0,
      panel.getBoundingClientRect().top + window.scrollY - 105
    );
    window.scrollTo({ top, behavior: "smooth" });
  }

  function updateBackToJobsButton() {
    const button = document.getElementById("backToJobsButton");
    const panel = document.getElementById("jobGrid");
    if (!button || !panel) return;
    button.classList.toggle(
      "show",
      panel.getBoundingClientRect().bottom < 80
    );
  }

  function initializeWorkerDashboard() {
    const qInput = document.getElementById("q");
    const statusSelect = document.getElementById("status");
    const queueSelect = document.getElementById("queue");
    const manualUploadForm = document.getElementById("manualUploadForm");
    const backToJobsButton = document.getElementById("backToJobsButton");

    backToJobsButton?.addEventListener("click", scrollToJobs);
    window.addEventListener("scroll", updateBackToJobsButton, { passive: true });
    window.addEventListener("resize", updateBackToJobsButton);

    // Always open a fresh dashboard visit at the jobs, not at the long
    // printer registry restored from a previous mobile browsing session.
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });

    qInput?.addEventListener("input", () => loadJobs({ preserveScroll: true }));
    statusSelect?.addEventListener("change", () => loadJobs({ preserveScroll: true }));
    queueSelect?.addEventListener("change", () => loadJobs({ preserveScroll: true }));

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
        await loadJobs({ preserveScroll: true });
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

    loadJobs({ preserveScroll: false }).then(() => {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      updateBackToJobsButton();
    });
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

// Refresh the worker dashboard every 30 seconds so workers have enough
// time to read each job. Automatic refresh still pauses while media is
// playing, while a worker is typing, or during active Premium production.
const WORKER_DASHBOARD_REFRESH_MS = 30000;

setInterval(() => {
  if (document.hidden) return;
  if (mediaIsPlaying()) return;
  if (isUserTyping) return;
  if (premiumWorkIsActive()) return;
  loadJobs({ silent: true, preserveScroll: true });
}, WORKER_DASHBOARD_REFRESH_MS);
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

    // Stop Printo's dancing at the actual final spoken word. ElevenLabs MP3
    // files can contain extra encoded silence after speech, so measure the
    // beginning of the final silence instead of using the full MP3 duration.
    const birthdaySpokenEndSeconds = await probeSpokenAudioEndSeconds(
      voicePath,
      birthdayVoiceDurationSeconds
    );
    const birthdayVoiceDelaySeconds = 0.4;
    const birthdayFinalWordSafetySeconds = 0.08;
    const birthdayOutputDuration = Math.min(
      60,
      Math.max(
        1.5,
        birthdayVoiceDelaySeconds +
          birthdaySpokenEndSeconds +
          birthdayFinalWordSafetySeconds
      )
    );
    const birthdayVoiceDelayMs = Math.round(birthdayVoiceDelaySeconds * 1000);
    const birthdayMusicFadeDuration = Math.min(
      0.22,
      Math.max(0.08, birthdayOutputDuration / 20)
    );
    const birthdayMusicFadeOutStart = Math.max(
      0,
      birthdayOutputDuration - birthdayMusicFadeDuration
    ).toFixed(3);
    const birthdayMusicFadeDurationText = birthdayMusicFadeDuration.toFixed(3);
    const birthdayDurationText = birthdayOutputDuration.toFixed(3);

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
      `afade=t=out:st=${birthdayMusicFadeOutStart}:d=${birthdayMusicFadeDurationText},` +
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
      spokenEndSeconds: birthdaySpokenEndSeconds,
      outputDurationSeconds: birthdayOutputDuration,
      stopsAtFinalWord: true,
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
  const subtitle = escapeGreetingAssetText(
    translatePrintoStudioPhrase(language, "A beautiful Printo video greeting")
  );
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
    <text x="480" y="322" text-anchor="middle" font-family="Arial, sans-serif" font-size="25" font-weight="700" fill="#fff7cc">${subtitle}</text>
    <rect x="352" y="362" width="256" height="72" rx="36" fill="#ffffff" fill-opacity=".94"/>
    <text x="480" y="476" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="800" fill="#ffffff">Printo Studio • Powered by PATAPATA</text>
  </svg>`;
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.type("image/svg+xml").send(svg);
});

app.get("/greeting-assets/premium-tribute-sample.svg", (req, res) => {
  const language = normalizePrintoStudioLanguage(req.query.lang || "en");
  const premiumText = {
    recipientPhoto: escapeGreetingAssetText(translatePrintoStudioPhrase(language, "RECIPIENT PHOTO")),
    specialPerson: escapeGreetingAssetText(translatePrintoStudioPhrase(language, "Your special person")),
    premiumExperience: escapeGreetingAssetText(translatePrintoStudioPhrase(language, "PREMIUM EXPERIENCE")),
    personalTribute: escapeGreetingAssetText(translatePrintoStudioPhrase(language, "Personal Tribute")),
    musicVideoCard: escapeGreetingAssetText(translatePrintoStudioPhrase(language, "Music Video Card")),
    features: escapeGreetingAssetText(translatePrintoStudioPhrase(language, "Personal introduction • Photo • Original song"))
  };
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
    <defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#061b62"/><stop offset=".5" stop-color="#4c1d95"/><stop offset="1" stop-color="#d63384"/></linearGradient><filter id="s"><feDropShadow dx="0" dy="14" stdDeviation="15" flood-opacity=".4"/></filter></defs>
    <rect width="960" height="540" rx="34" fill="url(#p)"/>
    <circle cx="120" cy="90" r="150" fill="#ffd21f" opacity=".18"/><circle cx="860" cy="470" r="220" fill="#38bdf8" opacity=".16"/>
    <rect x="45" y="45" width="870" height="450" rx="30" fill="#06194f" fill-opacity=".38" stroke="#ffd21f" stroke-width="4"/>
    <rect x="105" y="100" width="260" height="320" rx="28" fill="#ffffff" fill-opacity=".94" filter="url(#s)"/>
    <circle cx="235" cy="216" r="78" fill="#dbeafe"/><text x="235" y="244" text-anchor="middle" font-size="86">📸</text>
    <text x="235" y="326" text-anchor="middle" font-family="Arial" font-size="24" font-weight="900" fill="#082a8f">${premiumText.recipientPhoto}</text>
    <text x="235" y="365" text-anchor="middle" font-family="Arial" font-size="18" font-weight="700" fill="#475569">${premiumText.specialPerson}</text>
    <text x="620" y="143" text-anchor="middle" font-family="Arial" font-size="23" font-weight="900" fill="#ffd21f">${premiumText.premiumExperience}</text>
    <text x="620" y="205" text-anchor="middle" font-family="Arial" font-size="39" font-weight="900" fill="#ffffff">${premiumText.personalTribute}</text>
    <text x="620" y="250" text-anchor="middle" font-family="Arial" font-size="39" font-weight="900" fill="#ffffff">${premiumText.musicVideoCard}</text>
    <text x="620" y="301" text-anchor="middle" font-family="Arial" font-size="22" font-weight="700" fill="#fce7f3">${premiumText.features}</text>
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
  <section class="premium"><span class="premium-badge">🌟 PREMIUM EXPERIENCE</span><div class="premium-grid"><button class="premium-media sample-open" type="button" data-video="/greeting-assets/premium-sample-video" data-poster="/greeting-assets/premium-tribute-sample.svg?lang=${encodeURIComponent(lang)}" data-title="Personal Tribute Music Video Card"><img src="/greeting-assets/premium-tribute-sample.svg?lang=${encodeURIComponent(lang)}" alt="Premium tribute sample"><span class="play">▶</span></button><div><h2>Personal Tribute Music Video Card</h2><p>Create a powerful personal tribute using the recipient photo, your personal introduction video or voice recording, an original tribute song, names and a heartfelt message.</p><ul><li>✓ Recipient photo on screen</li><li>✓ Personal introduction video or voice recording</li><li>✓ Original tribute song</li><li>✓ Recipient and sender names</li><li>✓ Personal message</li><li>✓ Downloadable finished video</li></ul><div class="premium-actions"><button class="watch sample-open" type="button" data-video="/greeting-assets/premium-sample-video" data-poster="/greeting-assets/premium-tribute-sample.svg?lang=${encodeURIComponent(lang)}" data-title="Personal Tribute Music Video Card">▶ ${t.watch}</button><a class="buy" href="${shopifyBase}" target="_blank" rel="noopener">🛒 ${t.buy}</a><a class="create account-required" href="${premiumOrderUrl}">✨ ${t.create}</a><a class="worker" href="${premiumWhatsAppUrl}" target="_blank" rel="noopener">💬 ${t.help}</a></div></div></div></section>
  <section class="premium">
    <span class="premium-badge">🌟 PREMIUM MULTI-IMAGE • ${PRINTO_CREATION_CREDIT_COSTS.premium_multi_image} CREDITS</span>
    <div class="premium-grid">
      <div class="premium-media" style="display:grid;place-items:center;background:linear-gradient(135deg,#123faa,#7b2cbf);min-height:270px">
        <div style="font-size:72px">🖼️↔️🖼️</div>
      </div>
      <div>
        <h2>Premium Multi-Image Flip Tribute</h2>
        <p>Upload 2–8 recipient photos. After the personal introduction ends, the images flip one after another while the custom tribute music plays.</p>
        <ul>
          <li>✓ 2–8 recipient photos</li>
          <li>✓ Flip-style image transitions</li>
          <li>✓ Personal introduction video or voice recording</li>
          <li>✓ Custom tribute music</li>
          <li>✓ First verified-account test is FREE</li>
          <li>✓ After the free test: ${PRINTO_CREATION_CREDIT_COSTS.premium_multi_image} credits or $${PRINTO_MULTI_IMAGE_PRICE_USD.toFixed(2)}</li>
          <li>✓ Share and download page</li>
        </ul>
        <div class="premium-actions">
          <a class="create account-required" href="/greetings/premium-multi-image?lang=${encodeURIComponent(lang)}">✨ Create Multi-Image Flip</a>
          <a class="worker" href="${premiumWhatsAppUrl}" target="_blank" rel="noopener">💬 ${t.help}</a>
        </div>
      </div>
    </div>
  </section>

  <section class="premium"><span class="premium-badge">🛍️ WATCH & BUY • ${PRINTO_CREATION_CREDIT_COSTS.watch_buy} CREDITS</span><div class="premium-grid"><button class="premium-media" type="button" onclick="location.href='/greetings/watch-buy?lang=${encodeURIComponent(lang)}'"><img src="/greeting-assets/premium-tribute-sample.svg?lang=${encodeURIComponent(lang)}" alt="Watch & Buy product video card"><span class="play">▶</span></button><div><h2>Watch & Buy — Powered by PATAPATA</h2><p>Showcase a product with a seller intro, up to 8 product images, item name, price and specifications. Generate a finished product video to watch, buy and share on social media.</p><ul><li>✓ Product intro video or voice</li><li>✓ 2–8 product images with flip transitions</li><li>✓ Item name shown in the recipient-name area</li><li>✓ Price shown in the sender-name area</li><li>✓ Product specifications in the message area</li><li>✓ Share and download finished product video</li></ul><div class="premium-actions"><a class="create account-required" href="/greetings/watch-buy?lang=${encodeURIComponent(lang)}">🛍️ Create Watch & Buy</a><a class="worker" href="${premiumWhatsAppUrl}" target="_blank" rel="noopener">💬 ${t.help}</a></div></div></div></section>
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
    const genericCopy = {
      en: {
        title: (occasion) => `Printo ${occasion} Video Card`,
        intro: (occasion) => `Enter the recipient name, sender name and personal message for your ${occasion} video card. A Printo worker will prepare this selected occasion for you.`,
        placeholder: (occasion) => `Write your personal ${occasion} message...`,
        generate: (occasion) => `Submit ${occasion} Request`,
        generating: "Submitting...",
        waiting: "Sending your personalization request to the Printo worker..."
      },
      es: {
        title: (occasion) => `Tarjeta de video Printo: ${occasion}`,
        intro: (occasion) => `Ingrese el destinatario, el remitente y el mensaje para su tarjeta de ${occasion}. Un trabajador de Printo preparará esta ocasión.`,
        placeholder: (occasion) => `Escriba su mensaje personal de ${occasion}...`,
        generate: (occasion) => `Enviar solicitud de ${occasion}`,
        generating: "Enviando...",
        waiting: "Enviando su solicitud al trabajador de Printo..."
      },
      fr: {
        title: (occasion) => `Carte vidéo Printo : ${occasion}`,
        intro: (occasion) => `Saisissez le destinataire, l’expéditeur et le message pour votre carte ${occasion}. Un agent Printo préparera cette occasion.`,
        placeholder: (occasion) => `Écrivez votre message personnel pour ${occasion}...`,
        generate: (occasion) => `Envoyer la demande ${occasion}`,
        generating: "Envoi...",
        waiting: "Envoi de votre demande à l’agent Printo..."
      },
      de: {
        title: (occasion) => `Printo Videokarte: ${occasion}`,
        intro: (occasion) => `Geben Sie Empfänger, Absender und Nachricht für Ihre ${occasion}-Videokarte ein. Ein Printo-Mitarbeiter bereitet diese Gelegenheit vor.`,
        placeholder: (occasion) => `Schreiben Sie Ihre persönliche Nachricht für ${occasion}...`,
        generate: (occasion) => `${occasion}-Anfrage senden`,
        generating: "Wird gesendet...",
        waiting: "Ihre Anfrage wird an den Printo-Mitarbeiter gesendet..."
      },
      pt: {
        title: (occasion) => `Cartão de vídeo Printo: ${occasion}`,
        intro: (occasion) => `Digite o destinatário, remetente e a mensagem para o cartão de ${occasion}. Um trabalhador Printo preparará esta ocasião.`,
        placeholder: (occasion) => `Escreva sua mensagem pessoal de ${occasion}...`,
        generate: (occasion) => `Enviar pedido de ${occasion}`,
        generating: "Enviando...",
        waiting: "Enviando sua solicitação ao trabalhador Printo..."
      },
      ar: {
        title: (occasion) => `بطاقة فيديو Printo: ${occasion}`,
        intro: (occasion) => `أدخل اسم المستلم والمرسل والرسالة لبطاقة ${occasion}. سيقوم موظف Printo بإعداد هذه المناسبة.`,
        placeholder: (occasion) => `اكتب رسالتك الشخصية لـ ${occasion}...`,
        generate: (occasion) => `إرسال طلب ${occasion}`,
        generating: "جارٍ الإرسال...",
        waiting: "جارٍ إرسال طلبك إلى موظف Printo..."
      },
      zh: {
        title: (occasion) => `Printo ${occasion}视频贺卡`,
        intro: (occasion) => `输入收件人、发件人和留言，制作${occasion}视频贺卡。Printo 工作人员将为您准备。`,
        placeholder: (occasion) => `写下您的${occasion}个人留言……`,
        generate: (occasion) => `提交${occasion}请求`,
        generating: "正在提交……",
        waiting: "正在将您的请求发送给 Printo 工作人员……"
      }
    };
    const generic = genericCopy[lang] || genericCopy.en;
    t.title = generic.title(selectedOccasion);
    t.intro = generic.intro(selectedOccasion);
    t.messagePlaceholder = generic.placeholder(selectedOccasion);
    t.generate = generic.generate(selectedOccasion);
    t.generating = generic.generating;
    t.waiting = generic.waiting;
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

function buildPremiumGreetingOrderPage(language = "en", creationType = "premium_video") {
  const lang = ["en", "es", "fr", "de", "pt", "ar", "zh"].includes(language)
    ? language
    : "en";
  const copy = {
    en: {
      title: "Personal Tribute Music Video Card",
      intro: "Complete the order details, upload the recipient photo, and choose a personal video or voice introduction. Payment is completed only after the order is saved.",
      recipient: "Recipient name",
      sender: "Sender name",
      phone: "WhatsApp phone number",
      email: "Email address (optional)",
      message: "Heartfelt personal message",
      songStyle: "Preferred tribute-song style",
      notes: "Story, memories, qualities, or words for the tribute song",
      photo: "Recipient photo",
      video: "Personal video or voice introduction",
      introType: "Choose Video or Voice Introduction",
      videoMode: "Video Introduction",
      audioMode: "Voice Introduction",
      startRecording: "Start Recording",
      stopRecording: "Stop Recording",
      playRecording: "Play Recording",
      recordAgain: "Record Again",
      uploadAudio: "Upload Existing Audio",
      audioHint: "Record in a quiet place and speak clearly. Printo will reduce background noise automatically.",
      audioFormats: "MP3, M4A, WAV, AAC, OGG, OPUS, WebM or FLAC • Maximum 60 seconds and 30 MB.",
      audioRequired: "Please record or upload your voice introduction.",
      audioTooLarge: "Voice introduction must be 30 MB or smaller.",
      audioTooLong: "Voice introduction must be 60 seconds or shorter.",
      audioUnreadable: "The voice introduction could not be read.",
      audioUploading: "Uploading, cleaning, and reducing background noise in your voice introduction…",
      audioStored: "Voice introduction cleaned and stored safely.",
      recordingUnsupported: "Voice recording is not supported in this browser. Please use Upload Existing Audio.",
      microphoneDenied: "Microphone access was not allowed. Please upload an existing audio file.",
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
    es: { title:"Tarjeta musical de homenaje personal", intro:"Complete los datos, suba la foto del destinatario y elija una introducción personal en video o voz. El pago se realiza después de guardar el pedido.", recipient:"Nombre del destinatario", sender:"Nombre del remitente", phone:"Número de WhatsApp", email:"Correo electrónico (opcional)", message:"Mensaje personal", songStyle:"Estilo de canción preferido", notes:"Historia, recuerdos o palabras para la canción", photo:"Foto del destinatario", video:"Introducción personal en video o voz", introType:"Elija introducción en video o voz", videoMode:"Introducción en video", audioMode:"Introducción de voz", startRecording:"Iniciar grabación", stopRecording:"Detener grabación", playRecording:"Reproducir grabación", recordAgain:"Grabar de nuevo", uploadAudio:"Subir audio existente", audioHint:"Grabe en un lugar tranquilo y hable con claridad. Printo reducirá automáticamente el ruido de fondo.", audioFormats:"MP3, M4A, WAV, AAC, OGG, OPUS, WebM o FLAC • Máximo 60 segundos y 30 MB.", audioRequired:"Grabe o suba su introducción de voz.", audioTooLarge:"La introducción de voz debe pesar 30 MB o menos.", audioTooLong:"La introducción de voz debe durar 60 segundos o menos.", audioUnreadable:"No se pudo leer la introducción de voz.", audioUploading:"Subiendo, limpiando y reduciendo el ruido de fondo de su introducción de voz…", audioStored:"Introducción de voz limpiada y guardada de forma segura.", recordingUnsupported:"Este navegador no permite grabar voz. Use Subir audio existente.", microphoneDenied:"No se permitió el acceso al micrófono. Suba un archivo de audio existente.", submit:"Guardar pedido Premium", saving:"Guardando pedido y archivos…", required:"Complete todos los campos obligatorios y seleccione ambos archivos.", success:"Pedido Premium guardado.", pay:"Elija el método de pago", shopify:"Pagar con Shopify", africa:"Pago África", worker:"Enviar pedido al trabajador por WhatsApp", back:"Volver al Estudio" },
    fr: { title:"Carte vidéo musicale d’hommage personnel", intro:"Complétez les informations, importez la photo du destinataire et choisissez une introduction vidéo ou vocale. Le paiement vient après l’enregistrement.", recipient:"Nom du destinataire", sender:"Nom de l’expéditeur", phone:"Numéro WhatsApp", email:"E-mail (facultatif)", message:"Message personnel", songStyle:"Style de chanson souhaité", notes:"Histoire, souvenirs ou mots pour la chanson", photo:"Photo du destinataire", video:"Introduction personnelle en vidéo ou par la voix", introType:"Choisissez une introduction vidéo ou vocale", videoMode:"Introduction vidéo", audioMode:"Introduction vocale", startRecording:"Démarrer l’enregistrement", stopRecording:"Arrêter l’enregistrement", playRecording:"Écouter l’enregistrement", recordAgain:"Enregistrer à nouveau", uploadAudio:"Importer un fichier audio", audioHint:"Enregistrez dans un endroit calme et parlez clairement. Printo réduira automatiquement le bruit de fond.", audioFormats:"MP3, M4A, WAV, AAC, OGG, OPUS, WebM ou FLAC • Maximum 60 secondes et 30 Mo.", audioRequired:"Enregistrez ou importez votre introduction vocale.", audioTooLarge:"L’introduction vocale doit faire 30 Mo ou moins.", audioTooLong:"L’introduction vocale doit durer 60 secondes ou moins.", audioUnreadable:"Impossible de lire l’introduction vocale.", audioUploading:"Téléversement, nettoyage et réduction du bruit de fond de votre introduction vocale…", audioStored:"Introduction vocale nettoyée et stockée en sécurité.", recordingUnsupported:"L’enregistrement vocal n’est pas pris en charge par ce navigateur. Utilisez Importer un fichier audio.", microphoneDenied:"L’accès au microphone n’a pas été autorisé. Importez un fichier audio existant.", submit:"Enregistrer la commande Premium", saving:"Enregistrement de la commande…", required:"Complétez les champs obligatoires et choisissez les deux fichiers.", success:"Commande Premium enregistrée.", pay:"Choisissez le paiement", shopify:"Payer avec Shopify", africa:"Paiement Afrique", worker:"Envoyer au travailleur sur WhatsApp", back:"Retour au Studio" },
    de: { title:"Persönliche Tribute-Musik-Videokarte", intro:"Füllen Sie die Angaben aus, laden Sie das Empfängerfoto hoch und wählen Sie eine Video- oder Sprachvorstellung. Bezahlt wird nach dem Speichern.", recipient:"Empfängername", sender:"Absendername", phone:"WhatsApp-Nummer", email:"E-Mail (optional)", message:"Persönliche Nachricht", songStyle:"Gewünschter Musikstil", notes:"Geschichte, Erinnerungen oder Worte für den Song", photo:"Empfängerfoto", video:"Persönliche Video- oder Sprachvorstellung", introType:"Video- oder Sprachvorstellung wählen", videoMode:"Video-Einführung", audioMode:"Sprachaufnahme", startRecording:"Aufnahme starten", stopRecording:"Aufnahme stoppen", playRecording:"Aufnahme abspielen", recordAgain:"Erneut aufnehmen", uploadAudio:"Vorhandene Audiodatei hochladen", audioHint:"Nehmen Sie an einem ruhigen Ort auf und sprechen Sie deutlich. Printo reduziert Hintergrundgeräusche automatisch.", audioFormats:"MP3, M4A, WAV, AAC, OGG, OPUS, WebM oder FLAC • Maximal 60 Sekunden und 30 MB.", audioRequired:"Nehmen Sie Ihre Sprachvorstellung auf oder laden Sie sie hoch.", audioTooLarge:"Die Sprachvorstellung darf höchstens 30 MB groß sein.", audioTooLong:"Die Sprachvorstellung darf höchstens 60 Sekunden lang sein.", audioUnreadable:"Die Sprachvorstellung konnte nicht gelesen werden.", audioUploading:"Sprachvorstellung wird hochgeladen, bereinigt und von Hintergrundgeräuschen befreit…", audioStored:"Sprachvorstellung wurde bereinigt und sicher gespeichert.", recordingUnsupported:"Sprachaufnahme wird in diesem Browser nicht unterstützt. Laden Sie eine vorhandene Audiodatei hoch.", microphoneDenied:"Der Mikrofonzugriff wurde nicht erlaubt. Laden Sie eine vorhandene Audiodatei hoch.", submit:"Premium-Bestellung speichern", saving:"Bestellung wird gespeichert…", required:"Füllen Sie alle Pflichtfelder aus und wählen Sie beide Dateien.", success:"Premium-Bestellung gespeichert.", pay:"Zahlungsmethode wählen", shopify:"Mit Shopify bezahlen", africa:"Afrika-Zahlung", worker:"Bestellung per WhatsApp senden", back:"Zurück zum Studio" },
    pt: { title:"Cartão musical de homenagem pessoal", intro:"Preencha os dados, envie a foto do destinatário e escolha uma introdução em vídeo ou voz. O pagamento é feito depois de salvar.", recipient:"Nome do destinatário", sender:"Nome do remetente", phone:"Número de WhatsApp", email:"E-mail (opcional)", message:"Mensagem pessoal", songStyle:"Estilo musical desejado", notes:"História, memórias ou palavras para a música", photo:"Foto do destinatário", video:"Introdução pessoal em vídeo ou voz", introType:"Escolha introdução em vídeo ou voz", videoMode:"Introdução em vídeo", audioMode:"Introdução por voz", startRecording:"Iniciar gravação", stopRecording:"Parar gravação", playRecording:"Reproduzir gravação", recordAgain:"Gravar novamente", uploadAudio:"Enviar áudio existente", audioHint:"Grave em um local silencioso e fale claramente. O Printo reduzirá automaticamente o ruído de fundo.", audioFormats:"MP3, M4A, WAV, AAC, OGG, OPUS, WebM ou FLAC • Máximo de 60 segundos e 30 MB.", audioRequired:"Grave ou envie sua introdução por voz.", audioTooLarge:"A introdução por voz deve ter 30 MB ou menos.", audioTooLong:"A introdução por voz deve ter 60 segundos ou menos.", audioUnreadable:"Não foi possível ler a introdução por voz.", audioUploading:"Enviando, limpando e reduzindo o ruído de fundo da introdução por voz…", audioStored:"Introdução por voz limpa e armazenada com segurança.", recordingUnsupported:"Este navegador não permite gravação de voz. Use Enviar áudio existente.", microphoneDenied:"O acesso ao microfone não foi permitido. Envie um arquivo de áudio existente.", submit:"Salvar pedido Premium", saving:"Salvando pedido e arquivos…", required:"Preencha os campos obrigatórios e escolha os dois arquivos.", success:"Pedido Premium salvo.", pay:"Escolha o pagamento", shopify:"Pagar com Shopify", africa:"Pagamento África", worker:"Enviar pedido ao trabalhador no WhatsApp", back:"Voltar ao Studio" },
    ar: { title:"بطاقة فيديو موسيقية للتكريم الشخصي", intro:"أكمل تفاصيل الطلب وارفع صورة المستلم واختر تقديمًا شخصيًا بالفيديو أو بالصوت. يتم الدفع بعد حفظ الطلب.", recipient:"اسم المستلم", sender:"اسم المرسل", phone:"رقم واتساب", email:"البريد الإلكتروني (اختياري)", message:"الرسالة الشخصية", songStyle:"نمط الأغنية المطلوب", notes:"القصة أو الذكريات أو الكلمات للأغنية", photo:"صورة المستلم", video:"تقديم شخصي بالفيديو أو التسجيل الصوتي", introType:"اختر تقديمًا بالفيديو أو بالصوت", videoMode:"تقديم بالفيديو", audioMode:"تقديم صوتي", startRecording:"بدء التسجيل", stopRecording:"إيقاف التسجيل", playRecording:"تشغيل التسجيل", recordAgain:"التسجيل مرة أخرى", uploadAudio:"رفع ملف صوتي موجود", audioHint:"سجّل في مكان هادئ وتحدث بوضوح. سيقلل Printo ضوضاء الخلفية تلقائيًا.", audioFormats:"MP3 أو M4A أو WAV أو AAC أو OGG أو OPUS أو WebM أو FLAC • بحد أقصى 60 ثانية و30 ميغابايت.", audioRequired:"سجّل أو ارفع تقديمك الصوتي.", audioTooLarge:"يجب ألا يتجاوز حجم التقديم الصوتي 30 ميغابايت.", audioTooLong:"يجب ألا يتجاوز التقديم الصوتي 60 ثانية.", audioUnreadable:"تعذرت قراءة التقديم الصوتي.", audioUploading:"جارٍ رفع التقديم الصوتي وتنظيفه وتقليل ضوضاء الخلفية…", audioStored:"تم تنظيف التقديم الصوتي وتخزينه بأمان.", recordingUnsupported:"التسجيل الصوتي غير مدعوم في هذا المتصفح. استخدم رفع ملف صوتي موجود.", microphoneDenied:"لم يتم السماح بالوصول إلى الميكروفون. ارفع ملفًا صوتيًا موجودًا.", submit:"حفظ طلب Premium", saving:"جارٍ حفظ الطلب والملفات…", required:"أكمل الحقول المطلوبة واختر الملفين.", success:"تم حفظ طلب Premium.", pay:"اختر طريقة الدفع", shopify:"الدفع عبر Shopify", africa:"الدفع في أفريقيا", worker:"إرسال الطلب للعامل عبر واتساب", back:"العودة إلى الاستوديو" },
    zh: { title:"个人致敬音乐视频贺卡", intro:"填写订单信息，并上传收件人照片和您的个人介绍视频。保存订单后再付款。", recipient:"收件人姓名", sender:"发件人姓名", phone:"WhatsApp 电话", email:"电子邮件（可选）", message:"个人留言", songStyle:"致敬歌曲风格", notes:"故事、回忆、优点或歌曲内容", photo:"收件人照片", video:"个人视频或语音介绍", introType:"选择视频或语音介绍", videoMode:"视频介绍", audioMode:"语音介绍", startRecording:"开始录音", stopRecording:"停止录音", playRecording:"播放录音", recordAgain:"重新录音", uploadAudio:"上传现有音频", audioHint:"请在安静的地方清晰讲话。Printo 会自动降低背景噪音。", audioFormats:"MP3、M4A、WAV、AAC、OGG、OPUS、WebM 或 FLAC • 最长 60 秒，最大 30 MB。", audioRequired:"请录制或上传语音介绍。", audioTooLarge:"语音介绍必须不超过 30 MB。", audioTooLong:"语音介绍必须不超过 60 秒。", audioUnreadable:"无法读取语音介绍。", audioUploading:"正在上传、清理并降低语音介绍中的背景噪音……", audioStored:"语音介绍已降噪并安全保存。", recordingUnsupported:"此浏览器不支持语音录制。请使用上传现有音频。", microphoneDenied:"未允许麦克风访问。请上传现有音频文件。", submit:"保存高级订单", saving:"正在保存订单和文件…", required:"请填写必填项并选择两个文件。", success:"高级订单已保存。", pay:"选择付款方式", shopify:"Shopify 付款", africa:"非洲付款", worker:"通过 WhatsApp 发送给工作人员", back:"返回祝福工作室" }
  };
  const t = copy[lang] || copy.en;
  t.connectionInterrupted = t.connectionInterrupted ||
    "The upload connection was interrupted. Check My Videos or the worker dashboard before submitting again.";
  const normalizedCreationType = normalizePrintoCreationType(creationType);
  const isMultiImage = normalizedCreationType === "premium_multi_image";
  const isWatchBuy = normalizedCreationType === "watch_buy";
  const usesMultipleImages = isMultiImage || isWatchBuy;
  const multiCopy = {
    en: {
      title: "Premium Multi-Image Flip Tribute",
      intro: "Upload 2–8 photos and your personal introduction video. After your last spoken word, the photos flip one after another while the custom tribute music plays.",
      photo: "Recipient photos (2–8)",
      required: "Choose 2–8 recipient photos and one introduction video.",
      submit: "Save Multi-Image Flip Order",
      success: "Premium Multi-Image Flip order saved successfully.",
      priceLabel: "First verified-account test FREE • Then 50 credits or $14.99",
      photoHint: "Choose 2–8 JPG, PNG or WebP photos. Each image must be 10 MB or smaller. Your first verified-account test is free. Afterward: 50 credits or $14.99.",
      videoHint: "Maximum 60 seconds and 100 MB. Large files are compressed automatically before secure storage.",
      acceptTerms: "Please confirm permission and accept the Terms, Privacy and Refund Policy.",
      imageTooLarge: "Each recipient image must be 10 MB or smaller.",
      videoTooLarge: "Introduction video must be 100 MB or smaller.",
      videoTooLong: "Introduction video must be 60 seconds or shorter.",
      uploading: "Uploading, compressing, and reducing background noise in your introduction video…",
      paymentRequired: "Your free Multi-Image test has already been used and your account does not have enough credits.",
      paymentSummary: "Multi-Image Flip: $14.99 or {credits} more credits",
      order: "Order",
      freeTestUsed: "FREE TEST — 0 credits deducted",
      creditsDeducted: "credits deducted",
      stored: "Introduction video compressed, cleaned, and stored safely."
    },
    es: {
      title: "Homenaje Premium con cambio de varias imágenes",
      intro: "Suba de 2 a 8 fotos y su video de presentación. Después de la última palabra, las fotos cambiarán una tras otra mientras suena la música personalizada.",
      photo: "Fotos del destinatario (2–8)",
      required: "Elija de 2 a 8 fotos y un video de presentación.",
      submit: "Guardar pedido Multiimagen",
      success: "Pedido Premium Multiimagen guardado correctamente.",
      priceLabel: "Primera prueba GRATIS para cuentas verificadas • Después, 50 créditos o $14.99",
      photoHint: "Elija de 2 a 8 fotos JPG, PNG o WebP. Cada imagen debe pesar 10 MB o menos. La primera prueba de una cuenta verificada es gratis. Después: 50 créditos o $14.99.",
      videoHint: "Máximo 60 segundos y 100 MB. Los archivos grandes se comprimen automáticamente antes del almacenamiento seguro.",
      acceptTerms: "Confirme el permiso y acepte los Términos, la Privacidad y la Política de reembolso.",
      imageTooLarge: "Cada imagen del destinatario debe pesar 10 MB o menos.",
      videoTooLarge: "El video de presentación debe pesar 100 MB o menos.",
      videoTooLong: "El video de presentación debe durar 60 segundos o menos.",
      uploading: "Subiendo, comprimiendo y reduciendo el ruido de fondo del video de presentación…",
      paymentRequired: "La prueba gratuita de Multiimagen ya fue utilizada y la cuenta no tiene créditos suficientes.",
      paymentSummary: "Multiimagen: $14.99 o {credits} créditos adicionales",
      order: "Pedido",
      freeTestUsed: "PRUEBA GRATIS — se descontaron 0 créditos",
      creditsDeducted: "créditos descontados",
      stored: "Video de presentación comprimido, limpiado y guardado de forma segura."
    },
    fr: {
      title: "Hommage Premium multi-images avec transitions",
      intro: "Importez 2 à 8 photos et votre vidéo d’introduction. Après votre dernier mot, les images s’enchaînent pendant la musique personnalisée.",
      photo: "Photos du destinataire (2–8)",
      required: "Choisissez 2 à 8 photos et une vidéo d’introduction.",
      submit: "Enregistrer la commande multi-images",
      success: "Commande Premium multi-images enregistrée.",
      priceLabel: "Premier essai GRATUIT pour un compte vérifié • Puis 50 crédits ou 14,99 $",
      photoHint: "Choisissez 2 à 8 photos JPG, PNG ou WebP. Chaque image doit faire 10 Mo ou moins. Le premier essai d’un compte vérifié est gratuit. Ensuite : 50 crédits ou 14,99 $.",
      videoHint: "Maximum 60 secondes et 100 Mo. Les gros fichiers sont automatiquement compressés avant le stockage sécurisé.",
      acceptTerms: "Confirmez l’autorisation et acceptez les Conditions, la Confidentialité et la Politique de remboursement.",
      imageTooLarge: "Chaque image du destinataire doit faire 10 Mo ou moins.",
      videoTooLarge: "La vidéo d’introduction doit faire 100 Mo ou moins.",
      videoTooLong: "La vidéo d’introduction doit durer 60 secondes ou moins.",
      uploading: "Téléversement, compression et réduction du bruit de fond de votre vidéo d’introduction…",
      paymentRequired: "L’essai gratuit multi-images a déjà été utilisé et le compte ne possède pas assez de crédits.",
      paymentSummary: "Multi-images : 14,99 $ ou {credits} crédits supplémentaires",
      order: "Commande",
      freeTestUsed: "ESSAI GRATUIT — 0 crédit déduit",
      creditsDeducted: "crédits déduits",
      stored: "Vidéo d’introduction compressée, nettoyée et stockée en sécurité."
    },
    de: {
      title: "Premium Multi-Bild-Flip-Tribute",
      intro: "Laden Sie 2–8 Fotos und Ihr Einführungsvideo hoch. Nach dem letzten gesprochenen Wort wechseln die Bilder nacheinander zur eigenen Musik.",
      photo: "Empfängerfotos (2–8)",
      required: "Wählen Sie 2–8 Fotos und ein Einführungsvideo.",
      submit: "Multi-Bild-Bestellung speichern",
      success: "Premium Multi-Bild-Bestellung erfolgreich gespeichert.",
      priceLabel: "Erster Test für ein verifiziertes Konto KOSTENLOS • Danach 50 Credits oder 14,99 $",
      photoHint: "Wählen Sie 2–8 JPG-, PNG- oder WebP-Fotos. Jedes Bild darf höchstens 10 MB groß sein. Der erste Test eines verifizierten Kontos ist kostenlos. Danach: 50 Credits oder 14,99 $.",
      videoHint: "Maximal 60 Sekunden und 100 MB. Große Dateien werden vor der sicheren Speicherung automatisch komprimiert.",
      acceptTerms: "Bestätigen Sie die Erlaubnis und akzeptieren Sie Bedingungen, Datenschutz und Rückerstattungsrichtlinie.",
      imageTooLarge: "Jedes Empfängerbild darf höchstens 10 MB groß sein.",
      videoTooLarge: "Das Einführungsvideo darf höchstens 100 MB groß sein.",
      videoTooLong: "Das Einführungsvideo darf höchstens 60 Sekunden lang sein.",
      uploading: "Einführungsvideo wird hochgeladen, komprimiert und von Hintergrundgeräuschen bereinigt…",
      paymentRequired: "Der kostenlose Multi-Bild-Test wurde bereits verwendet und das Konto besitzt nicht genügend Credits.",
      paymentSummary: "Multi-Bild-Flip: 14,99 $ oder {credits} weitere Credits",
      order: "Bestellung",
      freeTestUsed: "KOSTENLOSER TEST — 0 Credits abgezogen",
      creditsDeducted: "Credits abgezogen",
      stored: "Einführungsvideo wurde komprimiert, bereinigt und sicher gespeichert."
    },
    pt: {
      title: "Homenagem Premium com várias imagens",
      intro: "Envie de 2 a 8 fotos e seu vídeo de apresentação. Depois da última palavra, as imagens mudarão uma após a outra enquanto a música personalizada toca.",
      photo: "Fotos do destinatário (2–8)",
      required: "Escolha de 2 a 8 fotos e um vídeo de apresentação.",
      submit: "Salvar pedido Multi-Imagem",
      success: "Pedido Premium Multi-Imagem salvo com sucesso.",
      priceLabel: "Primeiro teste GRÁTIS para conta verificada • Depois, 50 créditos ou US$ 14,99",
      photoHint: "Escolha de 2 a 8 fotos JPG, PNG ou WebP. Cada imagem deve ter 10 MB ou menos. O primeiro teste de uma conta verificada é grátis. Depois: 50 créditos ou US$ 14,99.",
      videoHint: "Máximo de 60 segundos e 100 MB. Arquivos grandes são comprimidos automaticamente antes do armazenamento seguro.",
      acceptTerms: "Confirme a permissão e aceite os Termos, a Privacidade e a Política de Reembolso.",
      imageTooLarge: "Cada imagem do destinatário deve ter 10 MB ou menos.",
      videoTooLarge: "O vídeo de apresentação deve ter 100 MB ou menos.",
      videoTooLong: "O vídeo de apresentação deve ter 60 segundos ou menos.",
      uploading: "Enviando, comprimindo e reduzindo o ruído de fundo do vídeo de apresentação…",
      paymentRequired: "O teste grátis de Multi-Imagem já foi usado e a conta não possui créditos suficientes.",
      paymentSummary: "Multi-Imagem: US$ 14,99 ou mais {credits} créditos",
      order: "Pedido",
      freeTestUsed: "TESTE GRÁTIS — 0 créditos descontados",
      creditsDeducted: "créditos descontados",
      stored: "Vídeo de apresentação comprimido, limpo e armazenado com segurança."
    },
    ar: {
      title: "تكريم Premium متعدد الصور",
      intro: "ارفع من صورتين إلى 8 صور وفيديو التقديم. بعد آخر كلمة، تتبدل الصور واحدة تلو الأخرى أثناء تشغيل الموسيقى المخصصة.",
      photo: "صور المستلم (2–8)",
      required: "اختر من صورتين إلى 8 صور وفيديو تقديم واحد.",
      submit: "حفظ طلب الصور المتعددة",
      success: "تم حفظ طلب Premium متعدد الصور بنجاح.",
      priceLabel: "الاختبار الأول للحساب الموثّق مجانًا • بعد ذلك 50 رصيدًا أو 14.99 دولارًا",
      photoHint: "اختر من صورتين إلى 8 صور بصيغة JPG أو PNG أو WebP. يجب ألا يتجاوز حجم كل صورة 10 ميغابايت. الاختبار الأول للحساب الموثّق مجاني. بعد ذلك: 50 رصيدًا أو 14.99 دولارًا.",
      videoHint: "الحد الأقصى 60 ثانية و100 ميغابايت. تُضغط الملفات الكبيرة تلقائيًا قبل التخزين الآمن.",
      acceptTerms: "يرجى تأكيد الإذن والموافقة على الشروط والخصوصية وسياسة الاسترداد.",
      imageTooLarge: "يجب ألا يتجاوز حجم كل صورة للمستلم 10 ميغابايت.",
      videoTooLarge: "يجب ألا يتجاوز فيديو التقديم 100 ميغابايت.",
      videoTooLong: "يجب ألا يتجاوز فيديو التقديم 60 ثانية.",
      uploading: "جارٍ رفع فيديو التقديم وضغطه وتقليل ضوضاء الخلفية…",
      paymentRequired: "تم استخدام الاختبار المجاني متعدد الصور ولا توجد أرصدة كافية في الحساب.",
      paymentSummary: "فيديو متعدد الصور: 14.99 دولارًا أو {credits} رصيدًا إضافيًا",
      order: "الطلب",
      freeTestUsed: "اختبار مجاني — لم يُخصم أي رصيد",
      creditsDeducted: "رصيدًا تم خصمه",
      stored: "تم ضغط فيديو التقديم وتنظيفه وتخزينه بأمان."
    },
    zh: {
      title: "Premium 多图片翻转致敬",
      intro: "上传 2–8 张照片和介绍视频。最后一句话结束后，照片会随着自定义音乐依次翻转切换。",
      photo: "收件人照片（2–8 张）",
      required: "请选择 2–8 张照片和一个介绍视频。",
      submit: "保存多图片订单",
      success: "Premium 多图片订单已成功保存。",
      priceLabel: "已验证账户首次测试免费 • 之后 50 积分或 14.99 美元",
      photoHint: "请选择 2–8 张 JPG、PNG 或 WebP 照片。每张图片必须不超过 10 MB。已验证账户首次测试免费。之后：50 积分或 14.99 美元。",
      videoHint: "最长 60 秒、最大 100 MB。大文件会在安全保存前自动压缩。",
      acceptTerms: "请确认授权并接受使用条款、隐私政策和退款政策。",
      imageTooLarge: "每张收件人图片必须不超过 10 MB。",
      videoTooLarge: "介绍视频必须不超过 100 MB。",
      videoTooLong: "介绍视频必须不超过 60 秒。",
      uploading: "正在上传、压缩并减少介绍视频中的背景噪音……",
      paymentRequired: "免费多图片测试已使用，并且账户积分不足。",
      paymentSummary: "多图片翻转：14.99 美元或还需 {credits} 积分",
      order: "订单",
      freeTestUsed: "免费测试 — 扣除 0 积分",
      creditsDeducted: "积分已扣除",
      stored: "介绍视频已压缩、降噪并安全保存。"
    }
  };
  const multiUi = multiCopy[lang] || multiCopy.en;
  if (isMultiImage) Object.assign(t, multiUi);
  if (isWatchBuy) {
    Object.assign(t, {
      title: "Watch & Buy — Powered by PATAPATA",
      intro: "Create a finished product showcase video with a seller introduction, 2–8 product images, item name, price and product specifications.",
      recipient: "Item name",
      sender: "Price",
      message: "Item specifications",
      songStyle: "Background music style",
      notes: "Seller/store name, shipping, return policy, buy link or additional product details",
      photo: "Product images (2–8)",
      video: "Product intro video or voice",
      introType: "Choose Product Video or Voice Introduction",
      videoMode: "Product Video Introduction",
      audioMode: "Product Voice Introduction",
      submit: "Create Watch & Buy Product Video",
      saving: "Saving product listing and uploads…",
      required: "Enter the item name, price and specifications, then choose 2–8 product images and an introduction.",
      success: "Watch & Buy product order saved successfully.",
      worker: "Send product order to worker on WhatsApp"
    });
  }
  const creationCreditCost = getPrintoCreationCreditCost(normalizedCreationType);
  const creationPriceLabel = usesMultipleImages
    ? (isWatchBuy ? `${creationCreditCost} Printo credits per product video` : multiUi.priceLabel)
    : `${creationCreditCost} Printo credits per creation`;
  const photoInputHtml = usesMultipleImages
    ? `<input name="recipientImages" type="file" accept="image/*" multiple required><div class="hint">${isWatchBuy ? "Choose 2–8 clear product images. Each image must be 10 MB or smaller." : multiUi.photoHint}</div>`
    : `<input name="recipientPhoto" type="file" accept="image/*" required><div class="hint">JPG, PNG or WebP. Clear portrait preferred. Price: ${creationCreditCost} credits.</div>`;
  const premiumPhoneGuidance = {
    en: {
      placeholder: "Enter country code + phone number, e.g. +1 862 230 6637",
      hint: "Use the same verified WhatsApp number connected to your Printo account."
    },
    es: {
      placeholder: "Ingrese código de país + número, ej. +1 862 230 6637",
      hint: "Use el mismo número de WhatsApp verificado conectado a su cuenta Printo."
    },
    fr: {
      placeholder: "Entrez l’indicatif + le numéro, ex. +1 862 230 6637",
      hint: "Utilisez le même numéro WhatsApp vérifié associé à votre compte Printo."
    },
    de: {
      placeholder: "Landesvorwahl + Nummer eingeben, z. B. +1 862 230 6637",
      hint: "Verwenden Sie dieselbe verifizierte WhatsApp-Nummer wie in Ihrem Printo-Konto."
    },
    pt: {
      placeholder: "Digite código do país + número, ex. +1 862 230 6637",
      hint: "Use o mesmo número de WhatsApp verificado conectado à sua conta Printo."
    },
    ar: {
      placeholder: "أدخل رمز الدولة والرقم، مثال: +1 862 230 6637",
      hint: "استخدم نفس رقم واتساب الموثّق المرتبط بحساب Printo."
    },
    zh: {
      placeholder: "输入国家代码和号码，例如 +1 862 230 6637",
      hint: "请使用与 Printo 账户关联的同一个已验证 WhatsApp 号码。"
    }
  };
  const phoneGuide = premiumPhoneGuidance[lang] || premiumPhoneGuidance.en;
  const dir = lang === "ar" ? "rtl" : "ltr";
  return `<!doctype html>
<html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:linear-gradient(150deg,#071b61,#0b63ce);color:#fff;min-height:100vh;padding:18px}.wrap{max-width:820px;margin:auto}.back{color:#ffd21f;font-weight:900;text-decoration:none}.hero{text-align:center;margin:12px 0 20px}.hero h1{font-size:34px;margin:8px}.hero p{line-height:1.55}.creditPrice{display:inline-block;background:#ffd21f;color:#082a8f;padding:9px 14px;border-radius:999px;font-weight:900;margin-top:8px}.panel{background:#fff;color:#172554;border:3px solid #ffd21f;border-radius:25px;padding:22px;box-shadow:0 18px 44px rgba(0,0,0,.35)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.full{grid-column:1/-1}label{display:block;font-weight:900;margin:5px 0 7px}input,textarea,select{width:100%;padding:13px;border:2px solid #cbd5e1;border-radius:13px;font-size:16px}textarea{min-height:110px}.hint{font-size:12px;color:#64748b;margin-top:5px}.submit{width:100%;border:0;border-radius:15px;padding:16px;background:linear-gradient(90deg,#7b2cbf,#d63384);color:#fff;font-size:19px;font-weight:900;margin-top:15px;cursor:pointer}.submit:disabled{opacity:.55}.status{text-align:center;font-weight:900;min-height:26px;margin-top:12px}.result{display:none;background:#f1f5f9;padding:16px;border-radius:16px;margin-top:15px}.orderId{font-size:20px;font-weight:900}.payments{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.pay{display:block;text-align:center;text-decoration:none;color:#fff;font-weight:900;padding:14px;border-radius:13px}.shopify{background:#4f772d}.africa{background:#008751}.worker{background:#25D366;grid-column:1/-1}.disabled{opacity:.45;pointer-events:none}.introChoice{grid-column:1/-1;border:2px solid #bfdbfe;background:#eff6ff;border-radius:14px;padding:14px}.introChoiceTitle{font-weight:900;margin-bottom:10px}.introTabs{display:grid;grid-template-columns:1fr 1fr;gap:9px}.introTabs button{border:2px solid #123faa;background:#fff;color:#123faa;padding:12px;border-radius:12px;font-weight:900;cursor:pointer}.introTabs button.active{background:#123faa;color:#fff}.introPanel{margin-top:12px}.recordControls{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.recordControls button{border:0;border-radius:10px;padding:11px 13px;font-weight:900;cursor:pointer;background:#7b2cbf;color:#fff}.recordControls button.stop{background:#c1121f}.recordControls button:disabled{opacity:.45;cursor:not-allowed}.recordTimer{font-weight:900;color:#c1121f;margin-top:8px}.audioPreview{width:100%;margin-top:9px}.audioBoostRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:9px;padding:10px;border:2px solid #ffd21f;border-radius:12px;background:#fff8cf}.audioBoostRow button{border:0;border-radius:10px;padding:10px 13px;background:#0f766e;color:#fff;font-weight:900;cursor:pointer}.audioBoostRow label{margin:0;display:flex;align-items:center;gap:8px;flex:1;min-width:210px}.audioBoostRow input[type=range]{width:100%;padding:0;border:0}.audioBoostValue{font-weight:900;color:#c1121f;min-width:42px}.audioDiagnostic{display:grid;gap:8px;margin:9px 0;padding:10px;border:2px solid #bfdbfe;border-radius:12px;background:#f8fbff}.audioDiagnostic button{border:0;border-radius:10px;padding:10px 13px;background:#123faa;color:#fff;font-weight:900;cursor:pointer}.micMeter{height:18px;border-radius:999px;background:#dbeafe;overflow:hidden;border:1px solid #93c5fd}.micMeterFill{display:block;height:100%;width:0;background:linear-gradient(90deg,#22c55e,#facc15,#ef4444);transition:width .08s linear}.micMeterText{font-size:12px;color:#475569;font-weight:800}.hidden{display:none!important}.agreement{display:flex;align-items:flex-start;gap:10px;background:#fff7d6;border:2px solid #ffd21f;border-radius:13px;padding:13px;margin-top:16px}.agreement input{width:20px;height:20px;flex:0 0 auto;margin:2px 0 0}.agreement label{margin:0;font-weight:800;line-height:1.45}.agreement a{color:#123faa;font-weight:900}@media(max-width:620px){.grid,.payments{grid-template-columns:1fr}.full,.worker{grid-column:auto}.hero h1{font-size:28px}.introTabs{grid-template-columns:1fr}}
</style></head><body><main class="wrap"><a class="back" href="/greetings?lang=${lang}">← ${t.back}</a><section class="hero"><h1>🌟 ${t.title}</h1><p>${t.intro}</p><span class="creditPrice">${creationPriceLabel}</span></section><section class="panel">
<form id="premiumForm" enctype="multipart/form-data"><input type="hidden" name="language" value="${lang}"><input type="hidden" name="creationType" value="${normalizedCreationType}"><input type="hidden" id="customerId" name="customerId"><input type="hidden" id="premiumCustomerKey" name="customerKey">
<div class="grid"><div><label>${t.recipient} *</label><input name="recipientName" maxlength="24" required></div><div><label>${t.sender} *</label><input name="senderName" maxlength="24" required></div><div><label>${t.phone} *</label><input id="premiumCustomerPhone" name="customerPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="${phoneGuide.placeholder}" required><div class="hint">${phoneGuide.hint}</div></div><div><label>${t.email}</label><input name="customerEmail" type="email"></div><div class="full"><label>${t.message} *</label><textarea name="personalMessage" maxlength="220" required></textarea></div><div><label>${t.songStyle}</label><select name="songStyle"><option value="">Worker will discuss with me</option><option>Afrobeat</option><option>Gospel</option><option>R&B / Soul</option><option>Pop</option><option>Highlife</option><option>Hip-Hop / Rap</option><option>Soft acoustic</option><option>Other</option></select></div><div><label>${t.notes}</label><textarea name="tributeNotes" maxlength="1000"></textarea></div><div><label>${t.photo} *</label>${photoInputHtml}</div><div class="introChoice"><div class="introChoiceTitle">${t.introType}</div><input id="introMediaType" name="introMediaType" type="hidden" value="video"><div class="introTabs"><button id="videoIntroTab" class="active" type="button">🎥 ${t.videoMode}</button><button id="audioIntroTab" type="button">🎙️ ${t.audioMode}</button></div><div id="videoIntroPanel" class="introPanel"><label>${t.videoMode} *</label><input id="introVideoInput" name="introVideo" type="file" accept="video/mp4,video/quicktime,video/webm,video/*"><div class="hint">${usesMultipleImages ? multiUi.videoHint : "Maximum 60 seconds and 100 MB. Large files are compressed automatically to a smaller 720p MP4 before permanent storage."}</div></div><div id="audioIntroPanel" class="introPanel hidden"><label>${t.audioMode} *</label><div class="hint">${t.audioHint}</div><div class="recordControls"><button id="startRecordBtn" type="button">🎙️ ${t.startRecording}</button><button id="stopRecordBtn" class="stop" type="button" disabled>⏹ ${t.stopRecording}</button><button id="playRecordBtn" type="button" class="hidden">▶ ${t.playRecording}</button><button id="recordAgainBtn" type="button" class="hidden">🔄 ${t.recordAgain}</button></div><div class="audioDiagnostic"><button id="testSpeakerBtn" type="button">🔔 Test Phone Speaker</button><div class="micMeter"><span id="micMeterFill" class="micMeterFill"></span></div><div id="micMeterText" class="micMeterText">Microphone level will move while you record.</div></div><div id="recordTimer" class="recordTimer"></div><audio id="recordedAudioPreview" class="audioPreview hidden" controls playsinline preload="auto"></audio><div id="audioBoostRow" class="audioBoostRow hidden"><button id="audioBoostBtn" type="button">🔊 Boost & Replay</button><label><span id="audioBoostLabel">Preview volume</span><input id="audioBoostRange" type="range" min="1" max="4" step="0.25" value="3"></label><span id="audioBoostValue" class="audioBoostValue">3×</span></div><div id="audioPreviewStatus" class="hint"></div><label style="margin-top:12px">${t.uploadAudio}</label><input id="introAudioInput" name="introAudio" type="file" accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,audio/aac,audio/ogg,audio/opus,audio/webm,.mp3,.m4a,.wav,.aac,.ogg,.opus,.webm,.flac"><div class="hint">${t.audioFormats}</div></div></div></div>
<div class="agreement"><input id="premiumTermsAccepted" name="termsAccepted" type="checkbox" value="yes" required><label for="premiumTermsAccepted">I confirm that I own or have permission to use the recipient photo, introduction video or voice recording, names, music instructions and all other submitted content. I agree to the <a href="/greetings?lang=${lang}#terms" target="_blank" rel="noopener">Terms of Use, Privacy Policy and Refund Policy</a>.</label></div>
<button id="submitBtn" class="submit" type="submit">✨ ${t.submit}</button><div id="status" class="status"></div></form><div id="result" class="result"><div>${t.success}</div><div id="orderId" class="orderId"></div><h3>${t.pay}</h3><div class="payments"><a id="shopifyPay" class="pay shopify" target="_blank" rel="noopener">🛒 ${t.shopify}</a><a id="africaPay" class="pay africa" target="_blank" rel="noopener">🌍 ${t.africa}</a><a id="workerLink" class="pay worker" target="_blank" rel="noopener">💬 ${t.worker}</a></div></div></section></main>
<script>
const form=document.getElementById('premiumForm'),button=document.getElementById('submitBtn'),termsAccepted=document.getElementById('premiumTermsAccepted'),statusBox=document.getElementById('status'),result=document.getElementById('result'),orderIdBox=document.getElementById('orderId'),shopifyPay=document.getElementById('shopifyPay'),africaPay=document.getElementById('africaPay'),workerLink=document.getElementById('workerLink');
const premiumCreationType=${JSON.stringify(normalizedCreationType)};
const premiumLanguage=${JSON.stringify(lang)};
const premiumIsMultiImage=premiumCreationType==='premium_multi_image'||premiumCreationType==='watch_buy';
const premiumIsWatchBuy=premiumCreationType==='watch_buy';
const premiumMultiUi=${JSON.stringify(multiUi)};
const premiumIntroUi=${JSON.stringify(t)};
const introMediaTypeInput=document.getElementById('introMediaType');
const videoIntroTab=document.getElementById('videoIntroTab');
const audioIntroTab=document.getElementById('audioIntroTab');
const videoIntroPanel=document.getElementById('videoIntroPanel');
const audioIntroPanel=document.getElementById('audioIntroPanel');
const introVideoInput=document.getElementById('introVideoInput');
const introAudioInput=document.getElementById('introAudioInput');
const startRecordBtn=document.getElementById('startRecordBtn');
const stopRecordBtn=document.getElementById('stopRecordBtn');
const playRecordBtn=document.getElementById('playRecordBtn');
const recordAgainBtn=document.getElementById('recordAgainBtn');
const recordTimer=document.getElementById('recordTimer');
const recordedAudioPreview=document.getElementById('recordedAudioPreview');
const audioBoostRow=document.getElementById('audioBoostRow');
const audioBoostBtn=document.getElementById('audioBoostBtn');
const audioBoostRange=document.getElementById('audioBoostRange');
const audioBoostValue=document.getElementById('audioBoostValue');
const audioBoostLabel=document.getElementById('audioBoostLabel');
const audioPreviewStatus=document.getElementById('audioPreviewStatus');
const testSpeakerBtn=document.getElementById('testSpeakerBtn');
const micMeterFill=document.getElementById('micMeterFill');
const micMeterText=document.getElementById('micMeterText');
const audioBoostTranslations={
  en:{button:'🔊 Boost & Replay',label:'Preview volume',ready:'Tap Play Recording or Boost & Replay. Turn up your phone media volume too.',playing:'Preview is playing with automatic voice normalization. Confirm that you can hear your voice clearly.',unsupported:'This browser cannot amplify the preview. Use the phone volume buttons and record closer to the microphone.',speaker:'🔔 Test Phone Speaker',meterIdle:'Microphone level will move while you record.',meterGood:'Microphone is receiving your voice.',meterLow:'Very little sound is reaching the microphone. Speak closer and louder.',silent:'No usable voice was captured. Check microphone permission, disconnect Bluetooth or earphones, and record again.'},
  es:{button:'🔊 Aumentar y repetir',label:'Volumen de vista previa',ready:'Pulse Reproducir grabación o Aumentar y repetir. Suba también el volumen multimedia del teléfono.',playing:'La vista previa se reproduce con volumen aumentado. Confirme que oye su voz claramente.',unsupported:'Este navegador no puede amplificar la vista previa. Use los botones de volumen y grabe más cerca del micrófono.'},
  fr:{button:'🔊 Amplifier et rejouer',label:'Volume de préécoute',ready:'Touchez Lire l’enregistrement ou Amplifier et rejouer. Augmentez aussi le volume multimédia du téléphone.',playing:'La préécoute est amplifiée. Vérifiez que votre voix est clairement audible.',unsupported:'Ce navigateur ne peut pas amplifier la préécoute. Utilisez les boutons de volume et rapprochez-vous du microphone.'},
  de:{button:'🔊 Verstärken und wiederholen',label:'Vorschau-Lautstärke',ready:'Tippen Sie auf Aufnahme abspielen oder Verstärken und wiederholen. Erhöhen Sie auch die Medienlautstärke des Telefons.',playing:'Die Vorschau wird verstärkt abgespielt. Prüfen Sie, ob Ihre Stimme klar hörbar ist.',unsupported:'Dieser Browser kann die Vorschau nicht verstärken. Nutzen Sie die Lautstärketasten und sprechen Sie näher am Mikrofon.'},
  pt:{button:'🔊 Aumentar e repetir',label:'Volume da prévia',ready:'Toque em Reproduzir gravação ou Aumentar e repetir. Aumente também o volume de mídia do telefone.',playing:'A prévia está tocando com volume aumentado. Confirme que consegue ouvir sua voz claramente.',unsupported:'Este navegador não consegue amplificar a prévia. Use os botões de volume e grave mais perto do microfone.'},
  ar:{button:'🔊 رفع الصوت وإعادة التشغيل',label:'مستوى صوت المعاينة',ready:'اضغط تشغيل التسجيل أو رفع الصوت وإعادة التشغيل. ارفع أيضًا مستوى صوت الوسائط في الهاتف.',playing:'يتم تشغيل المعاينة بصوت أعلى. تأكد من سماع صوتك بوضوح.',unsupported:'لا يستطيع هذا المتصفح تضخيم المعاينة. استخدم أزرار الصوت وسجّل بالقرب من الميكروفون.'},
  zh:{button:'🔊 增强音量并重播',label:'预览音量',ready:'点击播放录音或增强音量并重播，同时调高手机媒体音量。',playing:'预览正在以增强音量播放，请确认能清楚听到自己的声音。',unsupported:'此浏览器无法增强预览音量。请使用手机音量键并靠近麦克风录音。'}
};
const audioBoostUi=audioBoostTranslations[premiumLanguage]||audioBoostTranslations.en;
audioBoostUi.speaker=audioBoostUi.speaker||audioBoostTranslations.en.speaker;
audioBoostUi.meterIdle=audioBoostUi.meterIdle||audioBoostTranslations.en.meterIdle;
audioBoostUi.meterGood=audioBoostUi.meterGood||audioBoostTranslations.en.meterGood;
audioBoostUi.meterLow=audioBoostUi.meterLow||audioBoostTranslations.en.meterLow;
audioBoostUi.silent=audioBoostUi.silent||audioBoostTranslations.en.silent;
audioBoostBtn.textContent=audioBoostUi.button;
audioBoostLabel.textContent=audioBoostUi.label;
testSpeakerBtn.textContent=audioBoostUi.speaker;
micMeterText.textContent=audioBoostUi.meterIdle;
let mediaRecorder=null,recordingStream=null,recordingChunks=[],recordedAudioBlob=null,recordingTimerId=null,recordingStartedAt=0,recordedAudioUrl='',audioPreviewConfirmed=false;
let previewAudioContext=null,previewMediaSource=null,previewGainNode=null,previewCompressor=null,decodedPreviewBuffer=null,decodedPreviewPeak=0,decodedPreviewRms=0,previewBufferSource=null;
let microphoneAudioContext=null,microphoneAnalyser=null,microphoneMeterFrame=null,microphonePeakSeen=0;
function formatRecordingTime(seconds){const safe=Math.max(0,Math.min(60,Math.floor(seconds)));return String(Math.floor(safe/60)).padStart(2,'0')+':'+String(safe%60).padStart(2,'0')+' / 01:00';}
function stopMicrophoneStream(){if(recordingStream){recordingStream.getTracks().forEach(track=>track.stop());recordingStream=null;}}
function clearRecordingTimer(){if(recordingTimerId){clearInterval(recordingTimerId);recordingTimerId=null;}}
function clearAudioPreviewUrl(){if(recordedAudioUrl){URL.revokeObjectURL(recordedAudioUrl);recordedAudioUrl='';}}
async function ensurePreviewAmplifier(){
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextClass)return false;
  try{
    if(!previewAudioContext)previewAudioContext=new AudioContextClass();
    if(!previewMediaSource){
      previewMediaSource=previewAudioContext.createMediaElementSource(recordedAudioPreview);
      previewGainNode=previewAudioContext.createGain();
      previewCompressor=previewAudioContext.createDynamicsCompressor();
      previewCompressor.threshold.value=-12;
      previewCompressor.knee.value=18;
      previewCompressor.ratio.value=4;
      previewCompressor.attack.value=0.003;
      previewCompressor.release.value=0.25;
      previewMediaSource.connect(previewGainNode);
      previewGainNode.connect(previewCompressor);
      previewCompressor.connect(previewAudioContext.destination);
    }
    previewGainNode.gain.value=Math.max(1,Math.min(4,Number(audioBoostRange.value)||3));
    if(previewAudioContext.state==='suspended')await previewAudioContext.resume();
    return true;
  }catch(_error){
    return false;
  }
}
function syncPreviewBoost(){
  const boost=Math.max(1,Math.min(4,Number(audioBoostRange.value)||3));
  audioBoostValue.textContent=boost.toFixed(boost%1?2:0).replace(/\.00$/,'')+'×';
  if(previewGainNode)previewGainNode.gain.value=boost;
}
async function getPreviewAudioContext(){
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextClass)return null;
  if(!previewAudioContext)previewAudioContext=new AudioContextClass();
  if(previewAudioContext.state==='suspended')await previewAudioContext.resume();
  return previewAudioContext;
}
async function decodeAndMeasureAudio(fileOrBlob){
  const context=await getPreviewAudioContext();
  if(!context)return null;
  const bytes=await fileOrBlob.arrayBuffer();
  const buffer=await context.decodeAudioData(bytes.slice(0));
  let peak=0,sumSquares=0,sampleCount=0;
  for(let channelIndex=0;channelIndex<buffer.numberOfChannels;channelIndex+=1){
    const channel=buffer.getChannelData(channelIndex);
    const step=Math.max(1,Math.floor(channel.length/250000));
    for(let index=0;index<channel.length;index+=step){
      const value=Math.abs(channel[index]);
      if(value>peak)peak=value;
      sumSquares+=value*value;
      sampleCount+=1;
    }
  }
  return {
    buffer,
    peak,
    rms:sampleCount?Math.sqrt(sumSquares/sampleCount):0
  };
}
function stopMicrophoneMeter(){
  if(microphoneMeterFrame){cancelAnimationFrame(microphoneMeterFrame);microphoneMeterFrame=null;}
  if(microphoneAudioContext){microphoneAudioContext.close().catch(()=>{});microphoneAudioContext=null;}
  microphoneAnalyser=null;
  micMeterFill.style.width='0%';
}
async function startMicrophoneMeter(stream){
  stopMicrophoneMeter();
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextClass)return;
  microphoneAudioContext=new AudioContextClass();
  if(microphoneAudioContext.state==='suspended')await microphoneAudioContext.resume();
  const source=microphoneAudioContext.createMediaStreamSource(stream);
  microphoneAnalyser=microphoneAudioContext.createAnalyser();
  microphoneAnalyser.fftSize=1024;
  microphoneAnalyser.smoothingTimeConstant=.65;
  source.connect(microphoneAnalyser);
  const samples=new Float32Array(microphoneAnalyser.fftSize);
  microphonePeakSeen=0;
  const draw=()=>{
    if(!microphoneAnalyser)return;
    microphoneAnalyser.getFloatTimeDomainData(samples);
    let peak=0,sum=0;
    for(const sample of samples){
      const absolute=Math.abs(sample);
      if(absolute>peak)peak=absolute;
      sum+=sample*sample;
    }
    const rms=Math.sqrt(sum/samples.length);
    microphonePeakSeen=Math.max(microphonePeakSeen,peak);
    const percent=Math.max(1,Math.min(100,Math.round(rms*700)));
    micMeterFill.style.width=percent+'%';
    micMeterText.textContent=rms>.012?audioBoostUi.meterGood:audioBoostUi.meterLow;
    microphoneMeterFrame=requestAnimationFrame(draw);
  };
  draw();
}
function resetRecordedAudio(options={}){clearRecordingTimer();stopMicrophoneMeter();stopMicrophoneStream();recordingChunks=[];recordedAudioBlob=null;decodedPreviewBuffer=null;decodedPreviewPeak=0;decodedPreviewRms=0;audioPreviewConfirmed=false;clearAudioPreviewUrl();if(previewBufferSource){try{previewBufferSource.stop();}catch(_error){}previewBufferSource=null;}recordedAudioPreview.pause();recordedAudioPreview.removeAttribute('src');recordedAudioPreview.load();recordedAudioPreview.classList.add('hidden');audioBoostRow.classList.add('hidden');playRecordBtn.classList.add('hidden');recordAgainBtn.classList.add('hidden');audioPreviewStatus.textContent='';recordTimer.textContent='';micMeterText.textContent=audioBoostUi.meterIdle;startRecordBtn.disabled=false;stopRecordBtn.disabled=true;if(!options.keepUploadedFile)introAudioInput.value='';}
async function showAudioPreview(fileOrBlob,label){clearAudioPreviewUrl();audioPreviewConfirmed=false;decodedPreviewBuffer=null;decodedPreviewPeak=0;decodedPreviewRms=0;try{const measured=await decodeAndMeasureAudio(fileOrBlob);if(measured){decodedPreviewBuffer=measured.buffer;decodedPreviewPeak=measured.peak;decodedPreviewRms=measured.rms;if(decodedPreviewPeak<.003||decodedPreviewRms<.00045){audioPreviewStatus.textContent='❌ '+audioBoostUi.silent;recordedAudioBlob=null;return false;}}}catch(_decodeError){audioPreviewStatus.textContent='⚠️ The browser could not analyze this recording. Use the native player below to test it.';}recordedAudioUrl=URL.createObjectURL(fileOrBlob);recordedAudioPreview.pause();recordedAudioPreview.src=recordedAudioUrl;recordedAudioPreview.muted=false;recordedAudioPreview.volume=1;recordedAudioPreview.load();audioBoostRange.value='3';syncPreviewBoost();recordedAudioPreview.classList.remove('hidden');audioBoostRow.classList.remove('hidden');playRecordBtn.classList.remove('hidden');recordAgainBtn.classList.remove('hidden');audioPreviewStatus.textContent='🔊 '+label+' '+audioBoostUi.ready;return true;}
function setIntroMode(mode){const isAudio=mode==='audio';introMediaTypeInput.value=isAudio?'audio':'video';videoIntroTab.classList.toggle('active',!isAudio);audioIntroTab.classList.toggle('active',isAudio);videoIntroPanel.classList.toggle('hidden',isAudio);audioIntroPanel.classList.toggle('hidden',!isAudio);if(isAudio){introVideoInput.value='';}else{resetRecordedAudio();}}
videoIntroTab.addEventListener('click',()=>setIntroMode('video'));
audioIntroTab.addEventListener('click',()=>setIntroMode('audio'));
function chooseRecorderMime(){const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);const choices=isIOS?['audio/mp4','audio/webm;codecs=opus','audio/webm']:['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];return choices.find(type=>window.MediaRecorder&&MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(type))||'';}
async function startVoiceRecording(){if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){alert(premiumIntroUi.recordingUnsupported);return;}resetRecordedAudio();try{recordingStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1,sampleRate:48000}});await startMicrophoneMeter(recordingStream);const mimeType=chooseRecorderMime();mediaRecorder=mimeType?new MediaRecorder(recordingStream,{mimeType,audioBitsPerSecond:128000}):new MediaRecorder(recordingStream);recordingChunks=[];mediaRecorder.ondataavailable=event=>{if(event.data&&event.data.size)recordingChunks.push(event.data);};mediaRecorder.onerror=event=>{audioPreviewStatus.textContent='❌ '+(event?.error?.message||'Voice recording failed. Please record again or upload an audio file.');};mediaRecorder.onstop=()=>{clearRecordingTimer();stopMicrophoneMeter();stopMicrophoneStream();setTimeout(async()=>{const finalType=mediaRecorder?.mimeType||mimeType||'audio/webm';recordedAudioBlob=new Blob(recordingChunks,{type:finalType});startRecordBtn.disabled=false;stopRecordBtn.disabled=true;if(!recordedAudioBlob.size||recordedAudioBlob.size<1500||microphonePeakSeen<.003){recordedAudioBlob=null;audioPreviewStatus.textContent='❌ '+audioBoostUi.silent;return;}const ready=await showAudioPreview(recordedAudioBlob,'Recording ready.');if(!ready)return;recordTimer.textContent='✅ '+formatRecordingTime((Date.now()-recordingStartedAt)/1000);},300);};if(String(mimeType).includes('mp4'))mediaRecorder.start();else mediaRecorder.start(1000);recordingStartedAt=Date.now();startRecordBtn.disabled=true;stopRecordBtn.disabled=false;recordTimer.textContent='🔴 '+formatRecordingTime(0);recordingTimerId=setInterval(()=>{const elapsed=(Date.now()-recordingStartedAt)/1000;recordTimer.textContent='🔴 '+formatRecordingTime(elapsed);if(elapsed>=60&&mediaRecorder?.state==='recording')mediaRecorder.stop();},250);}catch(error){resetRecordedAudio();alert(error?.message||premiumIntroUi.microphoneDenied);}}
function stopVoiceRecording(){if(mediaRecorder?.state==='recording'){try{mediaRecorder.requestData();}catch(_error){}mediaRecorder.stop();}}
startRecordBtn.addEventListener('click',startVoiceRecording);
stopRecordBtn.addEventListener('click',stopVoiceRecording);
async function playBoostedPreview(){if(!recordedAudioPreview.src&&!decodedPreviewBuffer)return;try{if(decodedPreviewBuffer){const context=await getPreviewAudioContext();if(!context)throw new Error('No AudioContext');if(previewBufferSource){try{previewBufferSource.stop();}catch(_error){}}previewBufferSource=context.createBufferSource();previewBufferSource.buffer=decodedPreviewBuffer;const gain=context.createGain();const compressor=context.createDynamicsCompressor();compressor.threshold.value=-10;compressor.knee.value=20;compressor.ratio.value=5;compressor.attack.value=.003;compressor.release.value=.3;const selectedBoost=Math.max(1,Math.min(4,Number(audioBoostRange.value)||3));const normalizationGain=decodedPreviewPeak>0?Math.min(18,.82/decodedPreviewPeak):selectedBoost;gain.gain.value=Math.max(selectedBoost,normalizationGain);previewBufferSource.connect(gain);gain.connect(compressor);compressor.connect(context.destination);previewBufferSource.start(0);previewBufferSource.onended=()=>{previewBufferSource=null;};audioPreviewConfirmed=true;audioPreviewStatus.textContent='✅ '+audioBoostUi.playing;return;}const amplified=await ensurePreviewAmplifier();recordedAudioPreview.muted=false;recordedAudioPreview.volume=1;recordedAudioPreview.currentTime=0;await recordedAudioPreview.play();audioPreviewConfirmed=true;audioPreviewStatus.textContent='✅ '+(amplified?audioBoostUi.playing:audioBoostUi.unsupported);}catch(error){audioPreviewConfirmed=false;audioPreviewStatus.textContent='❌ This recording could not play. Record again or upload an existing audio file.';}}
playRecordBtn.addEventListener('click',playBoostedPreview);
audioBoostBtn.addEventListener('click',async()=>{audioBoostRange.value='4';syncPreviewBoost();await playBoostedPreview();});
audioBoostRange.addEventListener('input',syncPreviewBoost);
testSpeakerBtn.addEventListener('click',async()=>{try{const context=await getPreviewAudioContext();if(!context)throw new Error('No AudioContext');const oscillator=context.createOscillator();const gain=context.createGain();oscillator.frequency.value=740;gain.gain.setValueAtTime(.0001,context.currentTime);gain.gain.exponentialRampToValueAtTime(.45,context.currentTime+.03);gain.gain.exponentialRampToValueAtTime(.0001,context.currentTime+.7);oscillator.connect(gain);gain.connect(context.destination);oscillator.start();oscillator.stop(context.currentTime+.72);audioPreviewStatus.textContent='🔔 If you heard the tone, the phone speaker works. Watch the microphone meter while recording.';}catch(_error){audioPreviewStatus.textContent='❌ Speaker test could not start. Tap the page once and try again.';}});
recordedAudioPreview.addEventListener('play',()=>{ensurePreviewAmplifier().then(syncPreviewBoost).catch(()=>{});});
recordedAudioPreview.addEventListener('playing',()=>{audioPreviewConfirmed=true;});
recordedAudioPreview.addEventListener('error',()=>{audioPreviewConfirmed=false;audioPreviewStatus.textContent='❌ This audio cannot be played on this device. Record again or upload MP3, M4A or WAV.';});
recordAgainBtn.addEventListener('click',startVoiceRecording);
introAudioInput.addEventListener('change',async()=>{const selected=introAudioInput.files?.[0];if(!selected)return;clearRecordingTimer();stopMicrophoneMeter();stopMicrophoneStream();recordedAudioBlob=null;recordingChunks=[];await showAudioPreview(selected,'Uploaded audio ready.');});
window.addEventListener('beforeunload',()=>{clearRecordingTimer();stopMicrophoneMeter();stopMicrophoneStream();clearAudioPreviewUrl();if(previewAudioContext)previewAudioContext.close().catch(()=>{});});
function syncPremiumButton(){button.disabled=false;}
termsAccepted.addEventListener('change',syncPremiumButton);
window.addEventListener('pageshow',syncPremiumButton);
document.addEventListener('DOMContentLoaded',syncPremiumButton);
setTimeout(syncPremiumButton,0);
setTimeout(syncPremiumButton,250);
let accountKey=localStorage.getItem('printoGreetingCustomerKey')||'';if(!accountKey){window.location.replace('/customer-login?next='+encodeURIComponent(location.pathname+location.search));}
document.getElementById('premiumCustomerKey').value=accountKey;
const premiumCustomerPhone=document.getElementById('premiumCustomerPhone');
const savedVerifiedPhone=localStorage.getItem('printoGreetingCustomerPhone')||'';
if(premiumCustomerPhone&&savedVerifiedPhone&&!premiumCustomerPhone.value){
  premiumCustomerPhone.value=savedVerifiedPhone;
}
let customerId=localStorage.getItem('printoGreetingCustomerId')||localStorage.getItem('printoPremiumCustomerId');if(!customerId){customerId='premium_'+Date.now()+'_'+Math.random().toString(36).slice(2,11);localStorage.setItem('printoPremiumCustomerId',customerId)}document.getElementById('customerId').value=customerId;
function readMediaDuration(file,isAudio=false){return new Promise((resolve,reject)=>{const url=URL.createObjectURL(file),media=document.createElement(isAudio?'audio':'video');let finished=false;const cleanup=()=>{if(finished)return;finished=true;URL.revokeObjectURL(url);};const resolveDuration=()=>{const duration=Number(media.duration||0);cleanup();resolve(Number.isFinite(duration)&&duration>0?duration:0);};media.preload='metadata';media.onloadedmetadata=resolveDuration;media.ondurationchange=()=>{if(Number.isFinite(Number(media.duration))&&Number(media.duration)>0)resolveDuration();};media.onerror=()=>{cleanup();reject(new Error(isAudio?premiumIntroUi.audioUnreadable:'The introduction video could not be read.'));};media.src=url;setTimeout(()=>{if(!finished){cleanup();resolve(0);}},5000);});}
async function readReliableAudioDuration(file){
  const decodedDuration=Number(decodedPreviewBuffer?.duration||0);
  if(Number.isFinite(decodedDuration)&&decodedDuration>0)return decodedDuration;
  try{
    const measured=await decodeAndMeasureAudio(file);
    const duration=Number(measured?.buffer?.duration||0);
    if(Number.isFinite(duration)&&duration>0)return duration;
  }catch(_decodeError){}
  try{
    return await readMediaDuration(file,true);
  }catch(_metadataError){
    // The server performs a decode-based duration check, so metadata failure
    // alone must not block a valid, audible recording.
    return 0;
  }
}
form.addEventListener('submit',async(e)=>{e.preventDefault();if(!termsAccepted.checked){statusBox.textContent='❌ '+(premiumIsMultiImage?premiumMultiUi.acceptTerms:'Please confirm permission and accept the Terms, Privacy and Refund Policy.');return;}button.disabled=true;button.textContent='⏳ ${t.saving}';statusBox.textContent='';result.style.display='none';try{const fd=new FormData(form);const introMode=introMediaTypeInput.value==='audio'?'audio':'video';const video=fd.get('introVideo');const uploadedAudio=fd.get('introAudio');const singlePhoto=fd.get('recipientPhoto');const multiPhotos=fd.getAll('recipientImages').filter(file=>file&&file.size);if(premiumIsMultiImage){if(multiPhotos.length<2||multiPhotos.length>8)throw new Error('${t.required}');for(const image of multiPhotos){if(image.size>10*1024*1024)throw new Error(premiumMultiUi.imageTooLarge);}}else{if(!singlePhoto||!singlePhoto.size)throw new Error('${t.required}');if(singlePhoto.size>10*1024*1024)throw new Error('Recipient photo must be 10 MB or smaller.');}let introFile=null;if(introMode==='audio'){if(recordedAudioBlob){const extension=recordedAudioBlob.type.includes('mp4')?'m4a':recordedAudioBlob.type.includes('ogg')?'ogg':'webm';introFile=new File([recordedAudioBlob],'printo-voice-introduction.'+extension,{type:recordedAudioBlob.type||'audio/webm'});fd.set('introAudio',introFile);}else if(uploadedAudio&&uploadedAudio.size){introFile=uploadedAudio;}if(!introFile)throw new Error(premiumIntroUi.audioRequired);if(!audioPreviewConfirmed)throw new Error('Tap Play Recording and confirm that you can hear your voice before saving the order.');if(introFile.size>30*1024*1024)throw new Error(premiumIntroUi.audioTooLarge);const audioDuration=await readReliableAudioDuration(introFile);if(audioDuration>60.25)throw new Error(premiumIntroUi.audioTooLong);fd.delete('introVideo');}else{introFile=video;if(!introFile||!introFile.size)throw new Error('${t.required}');if(introFile.size>100*1024*1024)throw new Error(premiumIsMultiImage?premiumMultiUi.videoTooLarge:'Introduction video must be 100 MB or smaller.');const videoDuration=await readMediaDuration(introFile,false);if(videoDuration>60.25)throw new Error(premiumIsMultiImage?premiumMultiUi.videoTooLong:'Introduction video must be 60 seconds or shorter.');fd.delete('introAudio');}fd.set('introMediaType',introMode);statusBox.textContent='⏳ '+(introMode==='audio'?premiumIntroUi.audioUploading:(premiumIsMultiImage?premiumMultiUi.uploading:'Uploading and compressing your introduction video…'));fd.set('customerKey',accountKey);let response;try{response=await fetch('/api/greeting/premium/request',{method:'POST',headers:{'x-printo-customer-id':customerId,'x-printo-customer-key':accountKey},body:fd});}catch(networkError){throw new Error(premiumIntroUi.connectionInterrupted||'The upload connection was interrupted. Check My Videos or the worker dashboard before submitting again.');}const responseText=await response.text();let data={};try{data=responseText?JSON.parse(responseText):{};}catch(_parseError){throw new Error(response.ok?'The server returned an unreadable response. Please check My Videos before retrying.':('Server error '+response.status+'. Please check Render logs.'));}if(response.status===402&&data.paymentRequired){statusBox.textContent=(data.saved?'✅ ${t.success} ':'')+'💳 '+(premiumIsMultiImage?premiumMultiUi.paymentRequired:(data.error||'Payment is required.'));const creditsNeeded=String(data.access?.creditsNeeded||${creationCreditCost});orderIdBox.textContent=data.orderId?((premiumIsMultiImage?premiumMultiUi.order:'Order')+': '+data.orderId+' • Payment required'):(premiumIsMultiImage?premiumMultiUi.paymentSummary.replace('{credits}',creditsNeeded):'Premium payment required');shopifyPay.href=data.payment?.shopify||'/multi-image-checkout';africaPay.href=data.payment?.africa||'#';if(!data.payment?.shopify&&premiumIsMultiImage)shopifyPay.href='/multi-image-checkout';if(data.whatsappUrl){workerLink.href=data.whatsappUrl;workerLink.classList.remove('disabled');}else{workerLink.classList.add('disabled');}result.style.display='block';result.scrollIntoView({behavior:'smooth'});return;}if(!response.ok||!data.ok)throw new Error(data.error||'Could not save premium order.');statusBox.textContent='✅ ${t.success} '+(introMode==='audio'?premiumIntroUi.audioStored:(premiumIsMultiImage?premiumMultiUi.stored:'Introduction video compressed and stored safely.'));const chargeSummary=data.usedFreeMultiImageTrial?premiumMultiUi.freeTestUsed:String(data.chargedCredits??data.creditCost??${creationCreditCost})+' '+premiumMultiUi.creditsDeducted;orderIdBox.textContent=(premiumIsMultiImage?premiumMultiUi.order:'Order')+': '+data.orderId+' • '+chargeSummary;shopifyPay.href=data.payment?.shopify||'#';africaPay.href=data.payment?.africa||'#';if(!data.payment?.shopify)shopifyPay.classList.add('disabled');else shopifyPay.classList.remove('disabled');workerLink.href=data.whatsappUrl;result.style.display='block';result.scrollIntoView({behavior:'smooth'});}catch(error){statusBox.textContent='❌ '+error.message;}finally{button.textContent='✨ ${t.submit}';syncPremiumButton();}});
</script></body></html>`;
}


async function generatePremiumSharePreviewFile(videoPath, previewPath) {
  const filter =
    "[0:v]split=2[background][foreground];" +
    "[background]scale=1200:630:force_original_aspect_ratio=increase," +
      "crop=1200:630,gblur=sigma=28[blurred];" +
    "[foreground]scale=1200:600:force_original_aspect_ratio=decrease[card];" +
    "[blurred][card]overlay=(W-w)/2:(H-h)/2," +
      "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.10:t=fill," +
      "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:" +
        "text='▶':fontsize=170:fontcolor=white:" +
        "x=(w-text_w)/2+8:y=(h-text_h)/2-8:" +
        "box=1:boxcolor=black@0.62:boxborderw=42," +
      "format=yuvj420p[preview]";

  await execFilePromise("ffmpeg", [
    "-y", "-nostdin", "-loglevel", "error",
    "-ss", "0.35",
    "-i", videoPath,
    "-filter_complex", filter,
    "-map", "[preview]",
    "-frames:v", "1",
    "-q:v", "7",
    "-map_metadata", "-1",
    previewPath
  ], {
    timeout: 120000,
    maxBuffer: 6 * 1024 * 1024
  });

  let stat = await fs.promises.stat(previewPath);

  if (stat.size > 700 * 1024) {
    const smallerPath = `${previewPath}.smaller.jpg`;
    await execFilePromise("ffmpeg", [
      "-y", "-nostdin", "-loglevel", "error",
      "-ss", "0.35",
      "-i", videoPath,
      "-filter_complex", filter,
      "-map", "[preview]",
      "-frames:v", "1",
      "-q:v", "11",
      "-map_metadata", "-1",
      smallerPath
    ], {
      timeout: 120000,
      maxBuffer: 6 * 1024 * 1024
    });

    safeUnlink(previewPath);
    fs.renameSync(smallerPath, previewPath);
    stat = await fs.promises.stat(previewPath);
  }

  if (!Number.isFinite(stat.size) || stat.size <= 0) {
    throw new Error("Premium share preview could not be generated.");
  }

  return {
    bytes: stat.size,
    width: 1200,
    height: 630,
    mime: "image/jpeg"
  };
}

async function ensurePremiumSharePreview(orderId, token) {
  const found = await queryWithRetry(
    `SELECT share_preview_data,
            share_preview_name,
            final_video_data,
            updated_at
     FROM premium_greeting_orders
     WHERE order_id = $1
       AND media_token = $2
     LIMIT 1`,
    [orderId, token],
    { attempts: 5, baseDelayMs: 350 }
  );

  const row = found.rows[0];
  if (!row) return null;

  const hasCurrentPlayPreview =
    Buffer.isBuffer(row.share_preview_data) &&
    row.share_preview_data.length > 0 &&
    String(row.share_preview_name || "").includes("-Play-");

  if (hasCurrentPlayPreview) {
    return {
      ready: true,
      updatedAt: row.updated_at
    };
  }

  if (
    !Buffer.isBuffer(row.final_video_data) ||
    row.final_video_data.length === 0
  ) {
    return null;
  }

  const runId = `${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
  const videoPath =
    path.join(premiumTempDir, `${runId}_preview_source.mp4`);
  const previewPath =
    path.join(premiumTempDir, `${runId}_share_preview.jpg`);

  try {
    await fs.promises.writeFile(videoPath, row.final_video_data);
    await generatePremiumSharePreviewFile(videoPath, previewPath);
    const previewData = await fs.promises.readFile(previewPath);

    const saved = await queryWithRetry(
      `UPDATE premium_greeting_orders
       SET share_preview_data = $3,
           share_preview_mime = 'image/jpeg',
           share_preview_name = $4,
           updated_at = NOW()
       WHERE order_id = $1
         AND media_token = $2
       RETURNING updated_at`,
      [
        orderId,
        token,
        previewData,
        `Printo-Premium-Preview-Play-${orderId}.jpg`
      ]
    );

    return {
      ready: true,
      updatedAt: saved.rows[0]?.updated_at || new Date()
    };
  } finally {
    safeUnlink(videoPath);
    safeUnlink(previewPath);
  }
}

app.get(["/greetings/premium", "/premium-greeting"], requirePrintoAccountPage, (req, res) => {
  const language = String(req.query.lang || "en").toLowerCase();
  res.type("html").send(buildPremiumGreetingOrderPage(language, "premium_video"));
});

app.get("/greetings/premium-multi-image", requirePrintoAccountPage, (req, res) => {
  const language = String(req.query.lang || "en").toLowerCase();
  res.type("html").send(buildPremiumGreetingOrderPage(language, "premium_multi_image"));
});

app.get("/greetings/watch-buy", requirePrintoAccountPage, (req, res) => {
  const language = String(req.query.lang || "en").toLowerCase();
  res.type("html").send(buildPremiumGreetingOrderPage(language, "watch_buy"));
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
        audio: {
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
        },
        preview: {
          data: "share_preview_data",
          mime: "share_preview_mime",
          name: "share_preview_name",
          cacheControl: "public, max-age=31536000, immutable"
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
        name: row.media_name,
        cacheControl: selected.cacheControl
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


app.get(
  ["/premium-media/:orderId/image/:position", "/api/greeting/premium/media/:orderId/image/:position"],
  async (req, res) => {
    try {
      const orderId = String(req.params.orderId || "").trim();
      const token = String(req.query.token || "").trim();
      const position = Math.max(1, Number.parseInt(String(req.params.position || "1"), 10) || 1);

      const result = await queryWithRetry(
        `SELECT image.image_data AS media_data,
                image.image_mime AS media_mime,
                image.image_name AS media_name
         FROM premium_greeting_images AS image
         JOIN premium_greeting_orders AS orders ON orders.order_id = image.order_id
         WHERE image.order_id = $1
           AND image.image_position = $2
           AND orders.media_token = $3
         LIMIT 1`,
        [orderId, position, token],
        { attempts: 6, baseDelayMs: 400 }
      );

      const row = result.rows[0];
      if (!row) return res.status(404).send("Premium image not found.");

      return sendPremiumMediaBuffer(req, res, {
        data: row.media_data,
        mime: row.media_mime,
        name: row.media_name
      });
    } catch (error) {
      console.error("Premium multi-image delivery error:", error);
      return res.status(500).send("Could not open Premium image.");
    }
  }
);


app.get("/premium-result/:orderId", async (req, res) => {
  try {
    const orderId = String(req.params.orderId || "").trim();
    const token = String(req.query.token || "").trim();
    const language = normalizePrintoStudioLanguage(req.query.lang || "en");

    const found = await queryWithRetry(
      `SELECT order_id,
              creation_type,
              recipient_name,
              sender_name,
              personal_message,
              media_token,
              render_status,
              updated_at,
              final_video_data IS NOT NULL AS has_final_video
       FROM premium_greeting_orders
       WHERE order_id = $1
         AND media_token = $2
       LIMIT 1`,
      [orderId, token]
    );
    const order = found.rows[0];

    if (!order || !order.has_final_video || String(order.render_status) !== "completed") {
      return res.status(404).type("html").send(
        "<h2>Premium video is not ready yet.</h2><p>Return to My Videos and try again after rendering is complete.</p>"
      );
    }

    const previewState = await ensurePremiumSharePreview(orderId, token);
    const publicBase = getPublicBaseUrl(req).replace(/\/$/, "");
    const pageUrl =
      `${publicBase}/premium-result/${encodeURIComponent(orderId)}` +
      `?token=${encodeURIComponent(token)}&lang=${encodeURIComponent(language)}`;
    const videoUrl =
      `${publicBase}/premium-media/${encodeURIComponent(orderId)}/final` +
      `?token=${encodeURIComponent(token)}`;
    const downloadUrl = `${videoUrl}&download=1`;
    const previewVersion = encodeURIComponent(
      String(previewState?.updatedAt || order.updated_at || orderId)
    );
    const sharePreviewUrl =
      `${publicBase}/premium-media/${encodeURIComponent(orderId)}/preview` +
      `?token=${encodeURIComponent(token)}&v=${previewVersion}`;
    const videoPosterUrl =
      `${publicBase}/premium-media/${encodeURIComponent(orderId)}/photo` +
      `?token=${encodeURIComponent(token)}`;
    const recipient = String(order.recipient_name || "Someone Special").trim();
    const sender = String(order.sender_name || "With Love").trim();
    const message = String(order.personal_message || "").trim();
    const creationType = normalizePrintoCreationType(order.creation_type || "premium_video");
    const title = creationType === "watch_buy"
      ? `${recipient} — ${sender} | Watch & Buy`
      : creationType === "premium_multi_image"
        ? `Printo Premium Multi-Image Tribute for ${recipient}`
        : `Printo Premium Tribute for ${recipient}`;
    const shareText = creationType === "watch_buy"
      ? `🛍️ ${recipient}\nPrice: ${sender}\n\n${message}\n\nWatch this product and contact the seller through Printo Watch & Buy — Powered by PATAPATA.`
      : `🎉 ${title}\nFrom ${sender}\n\nWatch this personalized Printo video and create yours too.`;

    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    return res.type("html").send(`<!doctype html>
<html lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta property="og:type" content="video.other">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(message || "A personalized Printo Premium tribute video.")}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
<meta property="og:site_name" content="Printo Studio">
<meta property="og:image" content="${escapeHtml(sharePreviewUrl)}">
<meta property="og:image:secure_url" content="${escapeHtml(sharePreviewUrl)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(title)}">
<link rel="image_src" href="${escapeHtml(sharePreviewUrl)}">
<meta property="og:video" content="${escapeHtml(videoUrl)}">
<meta property="og:video:secure_url" content="${escapeHtml(videoUrl)}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="720">
<meta property="og:video:height" content="1280">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(message || "A personalized Printo Premium tribute video.")}">
<meta name="twitter:image" content="${escapeHtml(sharePreviewUrl)}">
<meta name="twitter:image:alt" content="${escapeHtml(title)}">
<style>
*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;background:linear-gradient(150deg,#020617,#082a8f);color:#fff;padding:22px}
.wrap{max-width:760px;margin:auto;text-align:center}
.back{display:inline-block;margin-bottom:15px;padding:11px 16px;border-radius:999px;background:#ffd21f;color:#082a8f;text-decoration:none;font-weight:900}
h1{font-size:30px;margin:8px 0}
.subtitle{color:#dbeafe;line-height:1.5}
.videoShell{position:relative;background:#000;border:3px solid #ffd21f;border-radius:20px;padding:8px;box-shadow:0 18px 50px rgba(0,0,0,.45)}
video{display:block;width:100%;max-height:72vh;border-radius:13px;background:#000}
.bigPlayButton{
  position:absolute;
  left:50%;
  top:50%;
  transform:translate(-50%,-50%);
  width:112px;
  height:112px;
  border-radius:50%;
  border:5px solid rgba(255,255,255,.94);
  background:rgba(0,0,0,.68);
  color:#fff;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:54px;
  line-height:1;
  padding:0 0 2px 8px;
  cursor:pointer;
  z-index:5;
  box-shadow:0 8px 28px rgba(0,0,0,.55);
}
.bigPlayButton:hover{transform:translate(-50%,-50%) scale(1.06)}
.bigPlayButton.hidden{display:none}
.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}
.btn{border:0;border-radius:13px;padding:13px 10px;color:#fff;font-weight:900;font-size:15px;cursor:pointer;text-decoration:none;display:flex;align-items:center;justify-content:center;min-height:48px}
.download{background:#7b2cbf}.whatsapp{background:#25D366;color:#082a24}.facebook{background:#1877F2}.xshare{background:#111}.instagram{background:#d63384}.youtube{background:#ef0000}.tiktok{background:#111}.email{background:#0f766e}.copy{background:#475569}.videos{background:#123faa}.credits{background:#4f772d}.full{grid-column:1/-1}
.note{margin-top:15px;padding:13px;background:rgba(255,255,255,.1);border-radius:14px;line-height:1.5}
@media(max-width:560px){body{padding:12px}.actions{grid-template-columns:1fr}h1{font-size:25px}.full{grid-column:auto}}
</style>
</head>
<body>
<main class="wrap">
<a class="back" href="/greetings?lang=${encodeURIComponent(language)}">← Back to Printo Studio</a>
<h1>🌟 ${escapeHtml(title)}</h1>
<p class="subtitle">Created for <strong>${escapeHtml(recipient)}</strong> from <strong>${escapeHtml(sender)}</strong></p>
<div class="videoShell">
<video id="premiumVideo" controls playsinline preload="metadata" poster="${escapeHtml(videoPosterUrl)}"><source src="${escapeHtml(videoUrl)}" type="video/mp4"></video>
<button id="bigPlayButton" class="bigPlayButton" type="button" aria-label="Play Premium video">▶</button>
</div>
<div class="actions">
<a class="btn download full" href="${escapeHtml(downloadUrl)}">⬇ Download Video</a>
<button class="btn whatsapp" type="button" onclick="shareWhatsApp()">📱 WhatsApp</button>
<button class="btn facebook" type="button" onclick="shareFacebook()">📘 Facebook</button>
<button class="btn xshare" type="button" onclick="shareX()">𝕏 X / Twitter</button>
<button class="btn instagram" type="button" onclick="shareVideoFile('Instagram')">📸 Instagram</button>
<button class="btn youtube" type="button" onclick="shareVideoFile('YouTube')">▶ YouTube</button>
<button class="btn tiktok" type="button" onclick="shareVideoFile('TikTok')">🎵 TikTok</button>
<button class="btn email" type="button" onclick="shareEmail()">📧 Email</button>
<button class="btn copy" type="button" onclick="copyLink()">🔗 Copy Link</button>
<a class="btn videos" href="/customer-dashboard?lang=${encodeURIComponent(language)}">🎬 My Videos & Credits</a>
<a class="btn credits" href="/subscriptions?lang=${encodeURIComponent(language)}">➕ Buy Credits / Subscribe</a>
</div>
<div class="note">Facebook, WhatsApp and X share the Premium result page. Instagram, YouTube and TikTok use your phone’s share sheet when available; otherwise the MP4 downloads first for upload.</div>
</main>
<script>
const pageUrl=${JSON.stringify(pageUrl)};
const videoUrl=${JSON.stringify(videoUrl)};
const downloadUrl=${JSON.stringify(downloadUrl)};
const shareText=${JSON.stringify(shareText)};
const fileName=${JSON.stringify(`Printo-Premium-${orderId}.mp4`)};
const premiumVideo=document.getElementById('premiumVideo');
const bigPlayButton=document.getElementById('bigPlayButton');

function syncBigPlayButton(){
  if(!premiumVideo||!bigPlayButton)return;
  if(premiumVideo.paused||premiumVideo.ended){
    bigPlayButton.classList.remove('hidden');
  }else{
    bigPlayButton.classList.add('hidden');
  }
}

async function playPremiumVideo(){
  if(!premiumVideo)return;
  try{
    await premiumVideo.play();
  }catch(_error){
    premiumVideo.controls=true;
  }
  syncBigPlayButton();
}

if(bigPlayButton){
  bigPlayButton.addEventListener('click',playPremiumVideo);
}
if(premiumVideo){
  premiumVideo.addEventListener('play',syncBigPlayButton);
  premiumVideo.addEventListener('pause',syncBigPlayButton);
  premiumVideo.addEventListener('ended',syncBigPlayButton);
  premiumVideo.addEventListener('loadeddata',syncBigPlayButton);
}
syncBigPlayButton();

function popup(url){window.open(url,'_blank','noopener,noreferrer,width=760,height=720')}
function shareWhatsApp(){popup('https://wa.me/?text='+encodeURIComponent(shareText+'\\n\\n'+pageUrl))}
function shareFacebook(){popup('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(pageUrl))}
function shareX(){popup('https://twitter.com/intent/tweet?text='+encodeURIComponent(shareText)+'&url='+encodeURIComponent(pageUrl))}
async function shareEmail(){const to=prompt('Enter the email address to send this Printo video to:');if(!to)return;try{const response=await fetch('/api/share/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to,subject:'Printo Premium Tribute',text:shareText+'\\n\\n🎬 Watch video:\\n'+pageUrl})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Email send failed');alert('✅ Printo video link sent by email.');}catch(error){alert('Email failed: '+error.message);}}
async function copyLink(){try{await navigator.clipboard.writeText(pageUrl);alert('Premium video link copied.')}catch(_error){prompt('Copy this link:',pageUrl)}}
async function shareVideoFile(platform){
  try{
    const response=await fetch(videoUrl);
    if(!response.ok)throw new Error('Video download failed');
    const blob=await response.blob();
    const file=new File([blob],fileName,{type:'video/mp4'});
    if(navigator.share&&(!navigator.canShare||navigator.canShare({files:[file]}))){
      await navigator.share({title:'Printo Premium Tribute',text:shareText,files:[file]});
      return;
    }
  }catch(_error){}
  const link=document.createElement('a');
  link.href=downloadUrl;
  link.download=fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  alert('The Premium MP4 has downloaded. Open '+platform+' and upload the video.');
}
</script>
</body>
</html>`);
  } catch (error) {
    console.error("Premium result page error:", error);
    return res.status(500).send("Could not open the Premium result page.");
  }
});

const handlePremiumUpload = premiumUpload.fields([
  { name: "recipientPhoto", maxCount: 1 },
  { name: "recipientImages", maxCount: PREMIUM_MULTI_IMAGE_MAX_COUNT },
  { name: "introVideo", maxCount: 1 },
  { name: "introAudio", maxCount: 1 }
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
          ? "Premium upload is too large. Use photos up to 10 MB, a video up to 100 MB, or voice audio up to 30 MB."
          : error.message || "Could not receive Premium uploads."
      });
    });
  },
  async (req, res) => {
    let premiumAccessReservation = null;
    let premiumCustomerIdentity = null;
    const preparedPhotoPaths = [];
    const requestedCreationType = normalizePrintoCreationType(req.body?.creationType || "premium_video");
    const singlePhoto = req.files?.recipientPhoto?.[0];
    const multiPhotos = Array.isArray(req.files?.recipientImages) ? req.files.recipientImages : [];
    const premiumPhotos = isPrintoMultiImageCreationType(requestedCreationType)
      ? multiPhotos
      : (singlePhoto ? [singlePhoto] : []);
    const photo = premiumPhotos[0];
    const introVideo = req.files?.introVideo?.[0];
    const introAudio = req.files?.introAudio?.[0];
    const requestedIntroMediaType = String(req.body?.introMediaType || (introAudio ? "audio" : "video")).toLowerCase() === "audio"
      ? "audio"
      : "video";
    const introMedia = requestedIntroMediaType === "audio" ? introAudio : introVideo;
    const compressedIntroPath = introMedia?.path
      ? path.join(
          premiumTempDir,
          `${path.parse(introMedia.path).name}_cleaned.${requestedIntroMediaType === "audio" ? "m4a" : "mp4"}`
        )
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
      const creationType = normalizePrintoCreationType(body.creationType || requestedCreationType);
      const introMediaType = String(body.introMediaType || requestedIntroMediaType).toLowerCase() === "audio"
        ? "audio"
        : "video";

      if (!recipientName || !senderName || !personalMessage || !customerPhone) {
        return res.status(400).json({
          ok: false,
          error: "Recipient name, sender name, personal message, and WhatsApp phone are required."
        });
      }

      if (isPrintoMultiImageCreationType(creationType)) {
        if (premiumPhotos.length < PREMIUM_MULTI_IMAGE_MIN_COUNT || premiumPhotos.length > PREMIUM_MULTI_IMAGE_MAX_COUNT) {
          return res.status(400).json({
            ok: false,
            error: isPrintoWatchBuyCreationType(creationType)
              ? `Choose ${PREMIUM_MULTI_IMAGE_MIN_COUNT}–${PREMIUM_MULTI_IMAGE_MAX_COUNT} product images for Watch & Buy.`
              : `Choose ${PREMIUM_MULTI_IMAGE_MIN_COUNT}–${PREMIUM_MULTI_IMAGE_MAX_COUNT} recipient photos for the Multi-Image Flip.`
          });
        }
      } else if (!photo || !photo.path || !String(photo.mimetype || "").startsWith("image/")) {
        return res.status(400).json({ ok: false, error: "A recipient photo is required." });
      }

      if (premiumPhotos.some((item) => !item?.path || !String(item.mimetype || "").startsWith("image/"))) {
        return res.status(400).json({ ok: false, error: "Every selected recipient file must be an image." });
      }

      if (!introMedia || !introMedia.path) {
        return res.status(400).json({
          ok: false,
          error: introMediaType === "audio"
            ? "A recorded or uploaded voice introduction is required."
            : "A personal introduction video is required."
        });
      }
      if (introMediaType === "video" && !String(introMedia.mimetype || "").startsWith("video/")) {
        return res.status(400).json({ ok: false, error: "The selected introduction must be a valid video." });
      }
      if (introMediaType === "audio") {
        const mime = String(introMedia.mimetype || "").toLowerCase();
        const ext = path.extname(String(introMedia.originalname || "")).toLowerCase();
        const allowedExt = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".webm", ".flac"]);
        if (!mime.startsWith("audio/") && mime !== "video/webm" && mime !== "application/octet-stream" && !allowedExt.has(ext)) {
          return res.status(400).json({ ok: false, error: "The selected voice introduction must be a valid audio file." });
        }
      }

      const originalIntroBytes = fs.statSync(introMedia.path).size;
      for (const item of premiumPhotos) {
        const itemBytes = fs.statSync(item.path).size;
        if (itemBytes > PREMIUM_PHOTO_MAX_BYTES) {
          return res.status(400).json({ ok: false, error: "Each recipient photo must be 10 MB or smaller." });
        }
      }
      if (introMediaType === "video" && originalIntroBytes > PREMIUM_VIDEO_UPLOAD_MAX_BYTES) {
        return res.status(400).json({ ok: false, error: "Introduction video must be 100 MB or smaller." });
      }
      if (introMediaType === "audio" && originalIntroBytes > PREMIUM_INTRO_AUDIO_MAX_BYTES) {
        return res.status(400).json({ ok: false, error: "Voice introduction must be 30 MB or smaller." });
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

      const accessPreview = await getGreetingAccessStatus(
        premiumCustomerIdentity.customerKey,
        premiumCustomerIdentity.contactPhone
      );
      const creationCreditCost = getPrintoCreationCreditCost(creationType);
      const canUseFreeMultiImageTrial =
        creationType === "premium_multi_image" &&
        Boolean(accessPreview.freeMultiImageTrialAvailable);
      const hasEnoughCredits =
        Number(accessPreview.creditBalance || 0) >= creationCreditCost;

      let externalPaymentRequired =
        !canUseFreeMultiImageTrial && !hasEnoughCredits;
      const paymentRequirementMessage =
        `You need ${creationCreditCost} credits to create this ` +
        `${creationType === "premium_multi_image"
          ? "Premium Multi-Image Flip"
          : creationType === "watch_buy"
            ? "Watch & Buy product video"
            : "Premium Tribute"}.`;

      // Important: an unpaid Premium order must still be compressed, stored,
      // and sent to the worker dashboard. Payment is confirmed afterward.
      // Do not return here merely because the account lacks credits.


      const compression = introMediaType === "audio"
        ? await compressPremiumIntroductionAudio(
            introMedia.path,
            compressedIntroPath
          )
        : await compressPremiumIntroductionVideo(
            introMedia.path,
            compressedIntroPath
          );

      const premiumImageBuffers = [];
      for (let imageIndex = 0; imageIndex < premiumPhotos.length; imageIndex += 1) {
        const item = premiumPhotos[imageIndex];
        const preparedPath = path.join(
          premiumTempDir,
          `${Date.now()}_${crypto.randomBytes(5).toString("hex")}_prepared_${imageIndex + 1}.jpg`
        );
        preparedPhotoPaths.push(preparedPath);

        const prepared = await compressPremiumRecipientImage(
          item.path,
          preparedPath
        );

        // Read only the already-compressed image. This keeps the total memory
        // footprint small even when the customer selected eight iPhone photos.
        premiumImageBuffers.push({
          data: fs.readFileSync(prepared.path),
          mime: prepared.mime,
          name: prepared.name,
          storedBytes: prepared.storedBytes
        });
      }

      if (!premiumImageBuffers.length) {
        throw new Error("At least one recipient photo is required.");
      }

      const photoBuffer = premiumImageBuffers[0].data;
      const compressedIntroBuffer = fs.readFileSync(compressedIntroPath);

      // Consume the one-time trial or wallet credits only after all files have
      // been validated, compressed, and made ready for storage.
      if (!externalPaymentRequired) {
        premiumAccessReservation = await reserveGreetingGenerationAccess(
          premiumCustomerIdentity.customerKey,
          premiumCustomerIdentity.contactPhone,
          creationType
        );

        if (!premiumAccessReservation.allowed) {
          // A balance may change while the media is uploading. Keep the order
          // instead of losing the customer's files and recording.
          externalPaymentRequired = true;
          premiumAccessReservation = null;
        }
      }

      const identity = premiumCustomerIdentity;
      const customerKey = identity.customerKey;
      const orderId = makePremiumOrderId();
      const mediaToken = crypto.randomBytes(24).toString("hex");
      const recipientPhotoUrl = buildPremiumMediaUrl(req, orderId, mediaToken, "photo");
      const publicBaseUrl = getPublicBaseUrl(req).replace(/\/$/, "");
      const recipientImageUrls = premiumImageBuffers.map((_item, index) =>
        `${publicBaseUrl}/premium-media/${encodeURIComponent(orderId)}/image/${index + 1}?token=${encodeURIComponent(mediaToken)}`
      );
      const introMediaUrl = buildPremiumMediaUrl(
        req,
        orderId,
        mediaToken,
        introMediaType === "audio" ? "audio" : "video"
      );
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
          tribute_notes, recipient_photo_url, intro_video_url, intro_media_type,
          recipient_photo_data, recipient_photo_mime, recipient_photo_name,
          intro_video_data, intro_video_mime, intro_video_name,
          intro_video_duration_seconds, intro_video_original_bytes,
          intro_video_stored_bytes, voice_script, final_video_url,
          media_token, creation_type, status, dashboard_job_id, render_status,
          created_at, updated_at
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
          $24,$25,'payment_required','','not_started',NOW(),NOW()
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
          introMediaUrl,
          introMediaType,
          photoBuffer,
          premiumImageBuffers[0].mime,
          premiumImageBuffers[0].name,
          compressedIntroBuffer,
          compression.mime,
          compression.name,
          compression.duration,
          originalIntroBytes,
          compression.storedBytes,
          voiceScript,
          finalVideoUrl,
          mediaToken,
          creationType
        ]
      );

      await queryWithRetry(
        `DELETE FROM premium_greeting_images WHERE order_id = $1`,
        [orderId]
      );
      for (let imageIndex = 0; imageIndex < premiumImageBuffers.length; imageIndex += 1) {
        const image = premiumImageBuffers[imageIndex];
        await queryWithRetry(
          `INSERT INTO premium_greeting_images (
             order_id, image_position, image_data, image_mime, image_name, created_at
           )
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (order_id, image_position)
           DO UPDATE SET image_data = EXCLUDED.image_data,
                         image_mime = EXCLUDED.image_mime,
                         image_name = EXCLUDED.image_name`,
          [orderId, imageIndex + 1, image.data, image.mime, image.name]
        );
      }

      if (!externalPaymentRequired && premiumAccessReservation?.allowed) {
        await queryWithRetry(
          `UPDATE premium_greeting_orders
           SET status = 'paid',
               payment_provider = 'printo_credits',
               payment_reference = $2,
               paid_at = NOW(),
               updated_at = NOW()
           WHERE order_id = $1`,
          [orderId, `credits:${getPrintoCreationCreditCost(creationType)}`]
        );
      }

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
        introMediaUrl,
        introMediaMime: compression.mime,
        introMediaType,
        recipientPhotoMime: premiumImageBuffers[0].mime,
        shopifyUrl: payment.shopify,
        africaUrl: payment.africa,
        language,
        introDuration: compression.duration,
        originalVideoBytes: originalIntroBytes,
        storedVideoBytes: compression.storedBytes,
        creationType,
        imageCount: premiumImageBuffers.length,
        imageUrls: recipientImageUrls
      });

      if (job?.id) {
        await queryWithRetry(
          `UPDATE premium_greeting_orders SET dashboard_job_id = $2, updated_at = NOW() WHERE order_id = $1`,
          [orderId, String(job.id)]
        );
      }

      const workerMessage = [
        creationType === "watch_buy"
          ? "Printo Watch & Buy product order saved"
          : creationType === "premium_multi_image"
            ? "Printo Premium Multi-Image Flip order saved"
            : "Printo Premium Tribute order saved",
        `Premium order ID: ${orderId}`,
        `${creationType === "watch_buy" ? "Item name" : "Recipient"}: ${recipientName}`,
        `${creationType === "watch_buy" ? "Price" : "Sender"}: ${senderName}`,
        `Customer phone: ${customerPhone}`,
        `Creation price: ${getPrintoCreationCreditCost(creationType)} Printo credits.`,
        `${creationType === "watch_buy" ? "Product images" : "Recipient images"}: ${premiumImageBuffers.length}.`,
        `Prepared image storage: ${Math.round(
          premiumImageBuffers.reduce(
            (sum, image) => sum + Number(image.storedBytes || 0),
            0
          ) / 1024
        )} KB total.`,
        `Introduction type: ${introMediaType}.`,
        `Introduction: ${compression.duration.toFixed(1)} seconds; cleaned from ${Math.round(originalIntroBytes / 1024 / 1024)} MB to ${Math.round(compression.storedBytes / 1024 / 1024)} MB.`,
        creationType === "watch_buy"
          ? `I submitted the product images, ${introMediaType === "audio" ? "seller voice recording" : "product introduction video"}, price and item specifications on Printo Studio.`
          : `I submitted the photo, ${introMediaType === "audio" ? "voice recording" : "introduction video"}, message, and tribute-song details on Printo Studio.`,
        creationType === "watch_buy"
          ? "Please confirm payment and help complete this Watch & Buy product video."
          : "Please confirm payment and help complete this premium order."
      ].join("\n");
      const whatsappUrl = `https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(workerMessage)}`;

      const storedStatus =
        externalPaymentRequired ? "payment_required" : "paid";

      console.log("Premium order stored:", {
        orderId,
        status: storedStatus,
        creationType,
        introMediaType,
        jobId: job?.id || null,
        imageCount: premiumImageBuffers.length
      });

      if (externalPaymentRequired) {
        return res.status(402).json({
          ok: false,
          saved: true,
          paymentRequired: true,
          error: paymentRequirementMessage,
          orderId,
          customerKey,
          jobId: job?.id || null,
          payment,
          whatsappUrl,
          status: "payment_required",
          creationType,
          creditCost: creationCreditCost,
          chargedCredits: 0,
          usedFreeMultiImageTrial: false,
          multiImagePriceUsd:
            creationType === "premium_multi_image"
              ? PRINTO_MULTI_IMAGE_PRICE_USD
              : null,
          imageCount: premiumImageBuffers.length,
          access: {
            ...accessPreview,
            creditsNeeded: Math.max(
              0,
              creationCreditCost - Number(accessPreview.creditBalance || 0)
            )
          },
          compression: {
            durationSeconds: Number(compression.duration.toFixed(2)),
            mediaType: introMediaType,
            originalBytes: originalIntroBytes,
            storedBytes: compression.storedBytes
          },
          media: {
            photo: recipientPhotoUrl,
            introduction: introMediaUrl,
            video: introMediaType === "video" ? introMediaUrl : "",
            audio: introMediaType === "audio" ? introMediaUrl : "",
            final: finalVideoUrl
          }
        });
      }

      return res.json({
        ok: true,
        orderId,
        customerKey,
        jobId: job?.id || null,
        payment,
        whatsappUrl,
        status: "paid",
        creationType,
        creditCost: getPrintoCreationCreditCost(creationType),
        chargedCredits: Number(premiumAccessReservation?.creditsUsed || 0),
        usedFreeMultiImageTrial:
          premiumAccessReservation?.source === "free_multi_image_trial",
        multiImagePriceUsd:
          creationType === "premium_multi_image"
            ? PRINTO_MULTI_IMAGE_PRICE_USD
            : null,
        imageCount: premiumImageBuffers.length,
        paymentRequired: false,
        access: premiumAccessReservation,
        creditBalance: premiumAccessReservation?.creditBalance ?? accessPreview.creditBalance,
        remainingCreations: premiumAccessReservation?.remainingCreations ?? accessPreview.remainingCreations,
        compression: {
          durationSeconds: Number(compression.duration.toFixed(2)),
          mediaType: introMediaType,
          originalBytes: originalIntroBytes,
          storedBytes: compression.storedBytes
        },
        media: {
          photo: recipientPhotoUrl,
          introduction: introMediaUrl,
          video: introMediaType === "video" ? introMediaUrl : "",
          audio: introMediaType === "audio" ? introMediaUrl : "",
          final: finalVideoUrl
        }
      });
    } catch (error) {
      if (premiumAccessReservation?.allowed && premiumCustomerIdentity?.customerKey) {
        await refundGreetingGenerationAccess(
          premiumCustomerIdentity.customerKey,
          premiumAccessReservation.source,
          premiumAccessReservation.creditsUsed
        ).catch((refundError) => {
          console.error("Premium credit refund failed:", refundError);
        });
        premiumAccessReservation = null;
      }
      console.error("Premium greeting request error:", error);
      const clientError = /must be|too large|duration|valid video|valid audio|voice introduction|could not be read/i.test(String(error.message || ""));
      return res.status(clientError ? 400 : 500).json({
        ok: false,
        error: error.message || "Could not save premium greeting order."
      });
    } finally {
      premiumPhotos.forEach((item) => safeUnlink(item?.path));
      preparedPhotoPaths.forEach((preparedPath) => safeUnlink(preparedPath));
      safeUnlink(introVideo?.path);
      safeUnlink(introAudio?.path);
      safeUnlink(compressedIntroPath);
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
             share_preview_data = NULL,
             share_preview_mime = '',
             share_preview_name = '',
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
            intro_media_type,
            tribute_music_mime,
            creation_type,
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

  const creationType = normalizePrintoCreationType(order.creation_type || "premium_video");
  const isWatchBuy = creationType === "watch_buy";
  const isMultiImage = isPrintoMultiImageCreationType(creationType);
  const storedImageResult = isMultiImage
    ? await queryWithRetry(
        `SELECT image_position, image_data, image_mime, image_name
         FROM premium_greeting_images
         WHERE order_id = $1
         ORDER BY image_position ASC`,
        [orderId]
      )
    : { rows: [] };
  const storedImages = Array.isArray(storedImageResult.rows) ? storedImageResult.rows : [];

  const runId = `${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
  const photoExt = getExtFromMime(order.recipient_photo_mime) || ".jpg";
  const musicExt = getExtFromMime(order.tribute_music_mime) || ".mp3";
  const introMediaType = String(order.intro_media_type || "video").toLowerCase() === "audio"
    ? "audio"
    : "video";
  const introExt = getExtFromMime(order.intro_video_mime) || (introMediaType === "audio" ? ".m4a" : ".mp4");
  const photoPath = path.join(premiumTempDir, `${runId}_photo${photoExt}`);
  const introPath = path.join(premiumTempDir, `${runId}_intro${introExt}`);
  const customMusicPath = path.join(premiumTempDir, `${runId}_music${musicExt}`);
  const openingPath = path.join(premiumTempDir, `${runId}_opening.mp4`);
  const introSegmentPath = path.join(premiumTempDir, `${runId}_intro_segment.mp4`);
  const tributePath = path.join(premiumTempDir, `${runId}_tribute.mp4`);
  const concatListPath = path.join(premiumTempDir, `${runId}_concat.txt`);
  const silentVideoPath = path.join(premiumTempDir, `${runId}_silent.mp4`);
  const outputPath = path.join(premiumTempDir, `${runId}_final.mp4`);
  const sharePreviewPath =
    path.join(premiumTempDir, `${runId}_share_preview.jpg`);
  const multiImagePaths = storedImages.map((image, index) =>
    path.join(
      premiumTempDir,
      `${runId}_image_${index + 1}${getExtFromMime(image.image_mime) || ".jpg"}`
    )
  );
  const cleanup = [
    photoPath,
    ...multiImagePaths,
    introPath,
    customMusicPath,
    openingPath,
    introSegmentPath,
    tributePath,
    concatListPath,
    silentVideoPath,
    outputPath,
    sharePreviewPath
  ];

  try {
    await queryWithRetry(
      `UPDATE premium_greeting_orders
       SET render_status = 'rendering', render_error = '', updated_at = NOW()
       WHERE order_id = $1`,
      [orderId]
    );

    console.log("Premium render stage 1/7 - loading recipient image(s):", orderId);
    let tributeImagePaths = [];
    if (isMultiImage) {
      if (storedImages.length < PREMIUM_MULTI_IMAGE_MIN_COUNT) {
        throw new Error(
          isWatchBuy
            ? "Watch & Buy needs at least two stored product images."
            : "Premium Multi-Image Flip needs at least two stored recipient photos."
        );
      }
      for (let index = 0; index < storedImages.length; index += 1) {
        const image = storedImages[index];
        const imagePath = multiImagePaths[index];
        if (!Buffer.isBuffer(image.image_data) || image.image_data.length === 0) {
          throw new Error(`Premium image ${index + 1} is missing.`);
        }
        await fs.promises.writeFile(imagePath, image.image_data);
        tributeImagePaths.push(imagePath);
      }
    } else {
      await readPremiumBinaryToFile(
        orderId,
        "recipient_photo_data",
        photoPath,
        "Recipient photo is missing."
      );
      tributeImagePaths = [photoPath];
    }

    console.log("Premium render stage 2/7 - loading introduction:", orderId);
    await readPremiumBinaryToFile(
      orderId,
      "intro_video_data",
      introPath,
      introMediaType === "audio"
        ? "Voice introduction is missing."
        : "Introduction video is missing."
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
    const introAudioLevels = introProbe.hasAudio
      ? await probePremiumAudioLevels(introPath)
      : { meanDb: Number.NEGATIVE_INFINITY, maxDb: Number.NEGATIVE_INFINITY };

    if (introMediaType === "audio") {
      assertPremiumIntroductionIsAudible(
        introAudioLevels,
        "Stored voice introduction"
      );
    } else if (!introProbe.hasVideo) {
      throw new Error("Stored personal introduction video has no video stream.");
    } else {
      assertPremiumIntroductionIsAudible(
        introAudioLevels,
        "Stored introduction-video voice"
      );
    }

    const musicProbe = await probePremiumMedia(selectedMusicPath);
    const introMediaDuration = Math.max(
      1,
      Math.min(PREMIUM_VIDEO_MAX_SECONDS, Number(introProbe.duration || 1))
    );
    const detectedIntroSpokenEnd = introProbe.hasAudio
      ? await probeSpokenAudioEndSeconds(introPath, introMediaDuration)
      : introMediaDuration;
    const introDuration = Math.max(
      1,
      Math.min(
        introMediaDuration,
        Number(detectedIntroSpokenEnd || introMediaDuration) + 0.08
      )
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

    // In Watch & Buy mode these existing database columns are intentionally reused:
    // recipient_name = item name, sender_name = price, personal_message = specifications.
    const recipientName = String(
      order.recipient_name || (isWatchBuy ? "Featured Item" : "Special Recipient")
    ).trim().slice(0, 24);
    const senderName = String(
      order.sender_name || (isWatchBuy ? "See Price" : "With Love")
    ).trim().slice(0, 24);
    const fullPersonalMessage = String(
      order.personal_message || (isWatchBuy
        ? "Product specifications and purchasing details."
        : "A special tribute created with love.")
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
      `fps=15,trim=duration=${introDuration},setpts=PTS-STARTPTS,` +
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

    // Video mode shows the sender's introduction video. Voice mode shows the
    // first recipient photo immediately while the sender's cleaned recording plays.
    if (introMediaType === "audio" || !introProbe.hasVideo) {
      await execFilePromise("ffmpeg", [
        "-y", "-nostdin", "-loglevel", "error",
        "-loop", "1", "-i", premiumFramePath,
        "-loop", "1", "-i", tributeImagePaths[0],
        "-filter_complex",
        `[0:v]${baseFrame},${commonTextOverlay}[base];` +
        `[1:v]${recipientPhotoFilter},` +
        `tpad=stop_mode=clone:stop_duration=${introDuration}[voice_photo];` +
        `[base][voice_photo]overlay=${introInnerX}:${introInnerY}:shortest=1[v]`,
        "-map", "[v]",
        ...premiumSegmentVideoArgs({
          duration: introDuration,
          outputPath: introSegmentPath,
          fps: 15
        })
      ], {
        timeout: PREMIUM_RENDER_STAGE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });
    } else {
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
    }

    const introSegmentProbe = await probePremiumStreamDurations(introSegmentPath);
    if (
      !Number.isFinite(introSegmentProbe.videoDuration) ||
      introSegmentProbe.videoDuration < Math.max(0.75, introDuration - 0.75)
    ) {
      throw new Error(
        introMediaType === "audio"
          ? "The voice-introduction photo segment could not be created."
          : "The personal introduction video segment was missing or too short."
      );
    }

    // Tribute section: as soon as the sender speech finishes, replace the
    // sender video with the recipient photograph and play the custom music to
    // the end. The sender video is never frozen or left talking under the song.
    if (tributeImagePaths.length > 1) {
      const flipDuration = Math.min(0.7, Math.max(0.35, tributeDuration / 80));
      const imageClipDuration =
        (tributeDuration + (tributeImagePaths.length - 1) * flipDuration) /
        tributeImagePaths.length;
      const slideshowInputArgs = [
        "-loop", "1", "-i", premiumFramePath
      ];
      tributeImagePaths.forEach((imagePath) => {
        slideshowInputArgs.push(
          "-loop", "1",
          "-t", imageClipDuration.toFixed(3),
          "-i", imagePath
        );
      });

      const slideshowFilters = [
        `[0:v]${baseFrame},${commonTextOverlay}[base]`
      ];
      tributeImagePaths.forEach((_imagePath, index) => {
        slideshowFilters.push(
          `[${index + 1}:v]${recipientPhotoFilter},fps=15,settb=AVTB,` +
          `trim=duration=${imageClipDuration.toFixed(3)},setpts=PTS-STARTPTS[flip${index}]`
        );
      });

      let previousLabel = "flip0";
      for (let index = 1; index < tributeImagePaths.length; index += 1) {
        const outputLabel = index === tributeImagePaths.length - 1
          ? "slideshow"
          : `flipmix${index}`;
        const offset = index * (imageClipDuration - flipDuration);
        slideshowFilters.push(
          `[${previousLabel}][flip${index}]xfade=` +
          `transition=squeezeh:duration=${flipDuration.toFixed(3)}:` +
          `offset=${offset.toFixed(3)}[${outputLabel}]`
        );
        previousLabel = outputLabel;
      }

      slideshowFilters.push(
        `[${previousLabel}]trim=duration=${tributeDuration.toFixed(3)},setpts=PTS-STARTPTS[recipient]`
      );
      slideshowFilters.push(
        `[base][recipient]overlay=${introInnerX}:${introInnerY}:shortest=1[v]`
      );

      await execFilePromise("ffmpeg", [
        "-y", "-nostdin", "-loglevel", "error",
        ...slideshowInputArgs,
        "-filter_complex", slideshowFilters.join(";"),
        "-map", "[v]",
        ...premiumSegmentVideoArgs({
          duration: tributeDuration,
          outputPath: tributePath,
          fps: 15
        })
      ], {
        timeout: PREMIUM_RENDER_STAGE_TIMEOUT_MS,
        maxBuffer: 12 * 1024 * 1024
      });
    } else {
      await execFilePromise("ffmpeg", [
        "-y", "-nostdin", "-loglevel", "error",
        "-loop", "1", "-i", premiumFramePath,
        "-loop", "1", "-i", tributeImagePaths[0],
        "-filter_complex",
        `[0:v]${baseFrame},${commonTextOverlay}[base];` +
        `[1:v]${recipientPhotoFilter},` +
        `tpad=stop_mode=clone:stop_duration=${tributeDuration}[recipient];` +
        `[base][recipient]overlay=${introInnerX}:${introInnerY}:shortest=1[v]`,
        "-map", "[v]",
        ...premiumSegmentVideoArgs({ duration: tributeDuration, outputPath: tributePath, fps: 15 })
      ], { timeout: PREMIUM_RENDER_STAGE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    }

    console.log("Premium render stage 5/7 - joining introduction and tribute segments:", orderId);
    await execFilePromise("ffmpeg", [
      "-y", "-nostdin", "-loglevel", "error",
      "-i", introSegmentPath,
      "-i", tributePath,
      "-filter_complex",
      `[0:v]fps=15,settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[intro_v];` +
      `[1:v]fps=15,settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[tribute_v];` +
      `[intro_v][tribute_v]concat=n=2:v=1:a=0[vout]`,
      "-map", "[vout]",
      "-t", String(totalDuration),
      "-r", "15",
      "-an",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "31",
      "-threads", "1",
      "-filter_threads", "1",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      silentVideoPath
    ], {
      timeout: PREMIUM_RENDER_STAGE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024
    });

    const joinedVideoProbe = await probePremiumStreamDurations(silentVideoPath);
    if (
      !Number.isFinite(joinedVideoProbe.videoDuration) ||
      Math.abs(joinedVideoProbe.videoDuration - totalDuration) > 1.25
    ) {
      throw new Error(
        `Premium video timeline is incomplete. Expected ${totalDuration.toFixed(2)} seconds but created ${Number(joinedVideoProbe.videoDuration || 0).toFixed(2)} seconds.`
      );
    }

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
      `aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
      `afade=t=in:st=0:d=0.15,` +
      `afade=t=out:st=${Math.max(0, tributeDuration - 4)}:d=4,` +
      `volume=1.0,apad=pad_dur=${tributeDuration},atrim=0:${tributeDuration}[music_exact]`
    ];

    if (introAudioIndex >= 0) {
      audioFilters.push(
        `[${introAudioIndex}:a]atrim=0:${introDuration},asetpts=PTS-STARTPTS,` +
        `aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `volume=1.0,alimiter=limit=0.92,` +
        `afade=t=out:st=${Math.max(0, introDuration - 0.08)}:d=0.08,` +
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
      introMediaType,
      introMediaDuration,
      detectedIntroSpokenEnd,
      introAudioMeanDb: introAudioLevels.meanDb,
      introAudioMaxDb: introAudioLevels.maxDb,
      introDuration,
      stopsIntroductionAtFinalWord: true,
      recipientPhotoStartsAt: introEnd,
      tributeMusicStartsAt: introEnd,
      noOpeningDelay: true,
      creationType,
      imageCount: tributeImagePaths.length,
      multiImageFlip: tributeImagePaths.length > 1,
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

    const finalStreamDurations = await probePremiumStreamDurations(outputPath);
    if (
      !Number.isFinite(finalStreamDurations.videoDuration) ||
      !Number.isFinite(finalStreamDurations.audioDuration) ||
      Math.abs(finalStreamDurations.videoDuration - finalStreamDurations.audioDuration) > 1.25
    ) {
      throw new Error(
        `Premium final video/audio timing mismatch. Video: ${Number(finalStreamDurations.videoDuration || 0).toFixed(2)} seconds; audio: ${Number(finalStreamDurations.audioDuration || 0).toFixed(2)} seconds.`
      );
    }

    const outputStat = await fs.promises.stat(outputPath);
    if (outputStat.size > PREMIUM_FINAL_VIDEO_MAX_BYTES) {
      throw new Error("Finished Premium video is larger than the temporary launch storage limit.");
    }

    console.log("Premium render stage 7/7 - preparing share preview:", orderId);
    const sharePreviewInfo = await generatePremiumSharePreviewFile(
      outputPath,
      sharePreviewPath
    );

    console.log("Premium render stage 7/7 - saving finished video:", {
      orderId,
      previewBytes: sharePreviewInfo.bytes,
      previewWidth: sharePreviewInfo.width,
      previewHeight: sharePreviewInfo.height
    });
    const finalBytes = await fs.promises.readFile(outputPath);
    const sharePreviewBytes = await fs.promises.readFile(sharePreviewPath);
    const finalDownloadUrl = publicBaseUrl
      ? `${String(publicBaseUrl).replace(/\/$/, "")}/premium-media/${encodeURIComponent(orderId)}/final?token=${encodeURIComponent(order.media_token)}`
      : buildPremiumMediaUrl(req, orderId, order.media_token, "final");
    const premiumResultUrl = `${String(publicBaseUrl || getPublicBaseUrl(req)).replace(/\/$/, "")}/premium-result/${encodeURIComponent(orderId)}?token=${encodeURIComponent(order.media_token)}`;

    await queryWithRetry(
      `UPDATE premium_greeting_orders
       SET final_video_data = $2,
           final_video_mime = 'video/mp4',
           final_video_name = $3,
           final_video_url = $4,
           voice_script = $5,
           share_preview_data = $6,
           share_preview_mime = 'image/jpeg',
           share_preview_name = $7,
           render_status = 'completed',
           render_error = '',
           status = CASE WHEN status = 'paid' THEN 'completed' ELSE status END,
           updated_at = NOW()
       WHERE order_id = $1`,
      [
        orderId,
        finalBytes,
        `Printo-Premium-${orderId}.mp4`,
        premiumResultUrl,
        `${introMediaType === "audio" ? "Voice introduction" : "Video introduction"} by ${senderName}, followed by a tribute song for ${recipientName}.`,
        sharePreviewBytes,
        `Printo-Premium-Preview-Play-${orderId}.jpg`
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
        `\n\n🎬 FINISHED PREMIUM VIDEO\n${premiumResultUrl}\n\n⬇ PREMIUM DOWNLOAD\n${finalDownloadUrl}`
      ]
    );

    return {
      orderId,
      finalVideoUrl: premiumResultUrl,
      downloadUrl: finalDownloadUrl,
      creationType,
      imageCount: tributeImagePaths.length,
      totalDuration,
      hasVoice: Boolean(introProbe.hasAudio),
      introMediaType,
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

  async function shareEmail(){
    const to=prompt('Enter the email address to send this Printo greeting to:');
    if(!to)return;
    try{
      const response=await fetch('/api/share/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to,subject:'My Printo greeting',text:emailText+'\\n\\n🎬 Watch greeting:\\n'+pageUrl})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||'Email send failed');
      alert('✅ Printo greeting sent by email.');
    }catch(error){
      alert('Email failed: '+error.message);
    }
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
    const [standardVideos,premiumVideos]=await Promise.all([
      listStandardGreetingVideos(identity.customerKey),
      listPremiumGreetingVideos(identity.customerKey)
    ]);
    const videos=mergeCustomerFinishedVideos(standardVideos,premiumVideos);
    return res.json({
      ok:true,
      phone,
      email:accountRow.account_type==="legacy_email"?accountRow.email:"",
      ...status,
      videos,
      standardVideos,
      premiumVideos
    });
  }catch(error){return res.status(500).json({ok:false,error:error.message});}
});

app.get("/api/customer/dashboard/:customerId", async (req,res)=>{
  try {
    const identity=getGreetingCustomerIdentity(req,{customerId:req.params.customerId,customerPhone:req.query.phone||"",email:req.query.email||""});
    const status=await getGreetingAccessStatus(identity.customerKey,identity.contactPhone);
    const [standardVideos,premiumVideos]=await Promise.all([
      listStandardGreetingVideos(identity.customerKey),
      listPremiumGreetingVideos(identity.customerKey)
    ]);
    const videos=mergeCustomerFinishedVideos(standardVideos,premiumVideos);
    res.json({ok:true,...status,videos,standardVideos,premiumVideos});
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


app.get("/api/customer/multi-image-checkout", async (req, res) => {
  try {
    const customerKey = String(
      req.headers["x-printo-customer-key"] || ""
    ).trim();

    if (!customerKey) {
      return res.status(401).json({
        ok: false,
        loginRequired: true,
        error: "Please log in first."
      });
    }

    const account = await queryWithRetry(
      `SELECT phone_e164
       FROM greeting_customer_accounts
       WHERE customer_key = $1
       LIMIT 1`,
      [customerKey]
    );

    if (!account.rows[0]) {
      return res.status(401).json({
        ok: false,
        loginRequired: true,
        error: "Your login has expired."
      });
    }

    const payment = buildMultiImagePurchaseLinks({
      customerKey,
      contactPhone: account.rows[0].phone_e164 || ""
    });

    if (!payment.shopify) {
      return res.status(503).json({
        ok: false,
        setupRequired: true,
        error:
          "Create the $14.99 Shopify Multi-Image product, then add its URL as GREETING_PREMIUM_MULTI_IMAGE_SHOPIFY_URL or add its variant ID as SHOPIFY_VARIANT_GREETING_PREMIUM_MULTI_IMAGE."
      });
    }

    return res.json({
      ok: true,
      priceUsd: PRINTO_MULTI_IMAGE_PRICE_USD,
      credits: PRINTO_MULTI_IMAGE_SINGLE_PURCHASE_CREDITS,
      checkoutUrl: payment.shopify
    });
  } catch (error) {
    console.error("Multi-Image Shopify checkout creation failed:", error);
    return res.status(500).json({
      ok: false,
      error: "Could not open the Multi-Image checkout."
    });
  }
});

app.get("/multi-image-checkout", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening Multi-Image Checkout</title>
<style>
body{font-family:Arial;background:#082a8f;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;padding:18px}
.card{background:#fff;color:#082a8f;padding:28px;border-radius:18px;max-width:560px;text-align:center}
a{color:#082a8f;font-weight:900}
</style>
</head>
<body>
<main class="card">
<h1>Opening Shopify Checkout…</h1>
<p id="status">Connecting this $14.99 purchase to your Printo account for 50 universal credits.</p>
<p><a href="/greetings/premium-multi-image">Return to Multi-Image Flip</a></p>
</main>
<script>
(async()=>{
  const key=localStorage.getItem('printoGreetingCustomerKey')||'';
  if(!key){
    location.replace('/customer-login?next=%2Fmulti-image-checkout');
    return;
  }
  try{
    const response=await fetch('/api/customer/multi-image-checkout',{
      cache:'no-store',
      headers:{'x-printo-customer-key':key}
    });
    const data=await response.json();
    if(!response.ok||!data.ok){
      throw new Error(data.error||'Could not open checkout.');
    }
    location.replace(data.checkoutUrl);
  }catch(error){
    document.getElementById('status').textContent=
      error.message||'Could not open checkout.';
  }
})();
</script>
</body>
</html>`);
});

app.get("/subscriptions", (req,res)=>res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Printo Plans</title><style>*{box-sizing:border-box}body{margin:0;font-family:Arial;background:linear-gradient(150deg,#071b61,#0b63ce);color:#fff;padding:24px}.wrap{max-width:1180px;margin:auto;text-align:center}.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.close-link{background:#fff;color:#082a8f;text-decoration:none;padding:11px 16px;border-radius:999px;font-weight:900}.section{margin:28px 0 38px}.section-title{font-size:30px;margin:0 0 8px}.section-sub{margin:0 0 18px}.plans{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}.plan{background:#fff;color:#082a8f;border:3px solid #ffd21f;border-radius:22px;padding:22px;position:relative}.plan.premium{border-color:#c13cff;box-shadow:0 10px 28px rgba(0,0,0,.18)}.badge{display:inline-block;background:#123faa;color:#fff;border-radius:999px;padding:7px 12px;font-size:13px;font-weight:900;margin-bottom:8px}.premium .badge{background:#7b2cbf}.price{font-size:34px;font-weight:900}.plan a{display:block;background:#7b2cbf;color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:900;margin-top:16px}.standard a{background:#123faa}.best{transform:scale(1.03)}.note{background:#fff4b8;color:#082a8f;border:3px solid #ffd21f;border-radius:18px;padding:16px;margin:0 auto 20px;max-width:820px;font-weight:900}@media(max-width:950px){.plans{grid-template-columns:1fr 1fr}}@media(max-width:560px){body{padding:16px}.plans{grid-template-columns:1fr}.best{transform:none}.topbar{justify-content:center}.section-title{font-size:25px}}</style></head><body><main class="wrap"><div class="topbar"><h1>⭐ Printo Credits & Subscriptions</h1><a class="close-link" href="/greetings">✕ Close / Return to Studio</a></div><div class="note">🎁 Each verified phone number receives 100 FREE universal credits once, plus one FREE Multi-Image Flip test worth 50 credits. After the free Multi-Image test, each Multi-Image creation costs 50 credits or $14.99.</div><p>Use one universal Printo credit wallet for Standard, Premium Video, and Premium Multi-Image creations.</p><section class="section"><h2 class="section-title">🎁 Standard Greeting Plans</h2><p class="section-sub">For personalized standard greeting video cards with names, messages, Printo music and voice.</p><div class="plans"><article class="plan standard"><span class="badge">STANDARD</span><h2>Single Creation</h2><div class="price">$4.99</div><p>20 credits • 1 standard creation</p><a href="/standard-checkout">Buy One</a></article><article class="plan standard"><span class="badge">STANDARD</span><h2>Monthly</h2><div class="price">$${PRINTO_STANDARD_SUBSCRIPTION_PRICES.monthly.toFixed(2)}</div><p>100 credits monthly • 5 standard creations</p><a href="${PRINTO_STANDARD_MONTHLY_SUBSCRIPTION_URL}">Choose Standard Monthly</a></article><article class="plan standard"><span class="badge">STANDARD</span><h2>6 Months</h2><div class="price">$${PRINTO_STANDARD_SUBSCRIPTION_PRICES.six_months.toFixed(2)}</div><p>600 credits • 30 standard creations</p><a href="${PRINTO_STANDARD_SIX_MONTH_SUBSCRIPTION_URL}">Choose Standard 6 Months</a></article><article class="plan standard best"><span class="badge">BEST STANDARD VALUE</span><h2>1 Year</h2><div class="price">$${PRINTO_STANDARD_SUBSCRIPTION_PRICES.yearly.toFixed(2)}</div><p>1,200 credits • 60 standard creations</p><a href="${PRINTO_STANDARD_YEARLY_SUBSCRIPTION_URL}">Choose Standard Annual</a></article></div></section><section class="section"><h2 class="section-title">🌟 Premium Creation Prices & Subscription Plans</h2><p class="section-sub">Each Premium service has its own separate creation price in the universal Printo credit wallet.</p><div class="plans"><article class="plan premium"><span class="badge">PREMIUM VIDEO</span><h2>Personal Tribute Video</h2><div class="price">${PRINTO_CREATION_CREDIT_COSTS.premium_video} Credits</div><p>1 recipient photo • introduction video • custom music</p><a href="/greetings/premium">Create Premium Video</a></article><article class="plan premium"><span class="badge">MULTI-IMAGE FLIP</span><h2>Premium Multi-Image</h2><div class="price">$${PRINTO_MULTI_IMAGE_PRICE_USD.toFixed(2)}</div><p>First verified-account test FREE • then ${PRINTO_CREATION_CREDIT_COSTS.premium_multi_image} credits • 2–8 photos • flip transitions • introduction • custom music</p><a href="/greetings/premium-multi-image">Use Free Test / Create</a><a href="/multi-image-checkout">Buy 50 Credits</a></article><article class="plan premium"><span class="badge">WATCH & BUY</span><h2>Product Showcase Video</h2><div class="price">${PRINTO_CREATION_CREDIT_COSTS.watch_buy} Credits</div><p>2–8 product images • seller intro • item name • price • specifications • social sharing</p><a href="/greetings/watch-buy">Create Watch & Buy</a></article><article class="plan premium"><span class="badge">PREMIUM</span><h2>Monthly</h2><div class="price">$${PRINTO_SUBSCRIPTION_PRICES.monthly.toFixed(2)}</div><p>100 credits now, then 100 credits each active month</p><a href="${PRINTO_MONTHLY_SUBSCRIPTION_URL}">Choose Premium Monthly</a></article><article class="plan premium"><span class="badge">PREMIUM</span><h2>6 Months</h2><div class="price">$${PRINTO_SUBSCRIPTION_PRICES.six_months.toFixed(2)}</div><p>100 credits monthly for 6 months</p><a href="${PRINTO_SIX_MONTH_SUBSCRIPTION_URL}">Choose Premium 6 Months</a></article><article class="plan premium best"><span class="badge">BEST PREMIUM VALUE</span><h2>1 Year</h2><div class="price">$${PRINTO_SUBSCRIPTION_PRICES.yearly.toFixed(2)}</div><p>100 credits monthly for 12 months</p><a href="${PRINTO_YEARLY_SUBSCRIPTION_URL}">Choose Premium Annual</a></article></div></section><p><a class="close-link" href="/greetings">← Return to Printo Greeting Studio</a></p></main></body></html>`));

app.get("/customer-dashboard", (req, res) => {
  const language = normalizePrintoStudioLanguage(req.query.lang || "en");
  const studioHref = addPrintoLanguageToPath("/greetings", language);
  const loginNext = addPrintoLanguageToPath("/customer-dashboard", language);

  return res.type("html").send(`<!doctype html>
<html lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}">
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Printo Dashboard</title>
<style>
*{box-sizing:border-box}
body{
  font-family:Arial;
  margin:0;
  background:#082a8f;
  color:#fff;
  padding:92px 20px 20px;
}
.wrap{max-width:900px;margin:auto}
.head{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:14px;
  flex-wrap:wrap;
}
.head h1{margin:0}
.close-link{
  background:#fff;
  color:#082a8f;
  text-decoration:none;
  padding:11px 16px;
  border-radius:999px;
  font-weight:900;
  line-height:1.25;
  text-align:center;
}
.card{
  background:#fff;
  color:#082a8f;
  border-radius:18px;
  padding:18px;
  margin:18px 0;
}
.stats{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:10px
}
.stat{
  background:#edf4ff;
  padding:15px;
  border-radius:14px;
  text-align:center
}
.buttons{
  display:flex;
  flex-wrap:wrap;
  gap:10px;
  margin:8px 0 18px;
}
.buttons a{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  padding:12px 16px;
  border-radius:12px;
  background:#7b2cbf;
  color:#fff;
  text-decoration:none;
  font-weight:bold;
  text-align:center;
}
.video{
  border-top:1px solid #ddd;
  padding:14px 0;
}
.videoType{
  display:inline-block;
  margin-bottom:6px;
  padding:5px 9px;
  border-radius:999px;
  background:#123faa;
  color:#fff;
  font-size:12px;
  font-weight:900;
}
.videoType.premium{background:#7b2cbf}
.videoLinks a{font-weight:800}
@media(max-width:600px){
  body{padding:82px 12px 12px}
  .stats{grid-template-columns:1fr}
  .head{justify-content:center;text-align:center}
  .head h1{width:100%;font-size:28px}
  .close-link{width:100%}
  .buttons{display:grid;grid-template-columns:1fr}
  .buttons a{width:100%}
  .card{padding:14px}
}
</style>
</head>
<body>
<main class="wrap">
  <div class="head">
    <h1>⭐ My Printo Dashboard</h1>
    <a class="close-link" href="${studioHref}">✕ Close / Return to Studio</a>
  </div>
  <div id="content" class="card">Loading…</div>
</main>
<script>
const dashboardLanguage=${JSON.stringify(language)};
const loginNext=${JSON.stringify(loginNext)};
const studioHref=${JSON.stringify(studioHref)};
const key=localStorage.getItem('printoGreetingCustomerKey')||'';

function escapeDashboardHtml(value){
  return String(value==null?'':value)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

function safeDashboardUrl(value){
  const raw=String(value||'');
  if(!raw.startsWith('/')||raw.startsWith('//'))return '#';
  return raw;
}

function renderFinishedVideo(video){
  const videoType=String(video.type||'standard');
  const isPremium=videoType==='premium'||videoType==='premium_multi_image'||videoType==='watch_buy';
  const label=videoType==='watch_buy'
    ? '🛍️ Watch & Buy Product Video'
    : videoType==='premium_multi_image'
      ? '🌟 Premium Multi-Image Flip Video'
    : (isPremium?'🌟 Premium Tribute Video':'🎁 Standard Greeting Video');
  const typeClass=isPremium?'videoType premium':'videoType';
  const recipient=escapeDashboardHtml(video.toName||'Recipient');
  const playUrl=escapeDashboardHtml(safeDashboardUrl(video.resultUrl));
  const downloadUrl=escapeDashboardHtml(safeDashboardUrl(video.downloadUrl));

  return '<div class="video">'+
    '<span class="'+typeClass+'">'+label+'</span><br>'+
    '<strong>For '+recipient+'</strong><br>'+
    '<span class="videoLinks"><a href="'+playUrl+'">▶ Play</a> &nbsp; '+
    '<a href="'+downloadUrl+'">⬇ Download</a></span>'+
    '</div>';
}

if(!key){
  window.location.replace('/customer-login?next='+encodeURIComponent(loginNext));
}else{
  fetch('/api/customer/account/dashboard',{
    cache:'no-store',
    headers:{'x-printo-customer-key':key}
  })
  .then(response=>response.json())
  .then(data=>{
    if(!data.ok)throw new Error(data.error||'Please log in.');
    const videos=Array.isArray(data.videos)?data.videos:[];
    const createHref='/birthday?lang='+encodeURIComponent(dashboardLanguage)+'&template=birthday';
    const plansHref='/subscriptions?lang='+encodeURIComponent(dashboardLanguage);
    const hasCreations=Number(data.totalGenerated||0)>0||videos.length>0;

    document.getElementById('content').innerHTML=
      '<div style="background:#fff4b8;border:2px solid #ffd21f;border-radius:14px;padding:14px;margin-bottom:14px;font-weight:900">'+
      '🎁 Welcome Bonus: 100 FREE universal credits plus one FREE Multi-Image Flip test worth 50 credits for each verified phone account.'+
      '</div>'+
      '<div class="stats">'+
        '<div class="stat"><h2>'+Number(data.creditBalance||0)+'</h2>Credits</div>'+
        '<div class="stat"><h2>'+Number(data.remainingCreations||0)+'</h2>Standard Creations Remaining</div>'+
        '<div class="stat"><h2>'+escapeDashboardHtml(data.subscriptionPlan||'Free Welcome')+'</h2>Plan</div>'+
        '<div class="stat"><h2>'+(data.freeMultiImageTrialAvailable?'Available':'Used')+'</h2>Free Multi-Image Test</div>'+
      '</div>'+
      '<div class="buttons">'+
        '<a href="'+createHref+'">'+(hasCreations?'Create Another Greeting':'Create Your First Greeting')+'</a>'+
        '<a href="'+plansHref+'">Buy Credits / Subscribe</a>'+
        '<a href="'+escapeDashboardHtml(studioHref)+'">✕ Close / Return to Studio</a>'+
      '</div>'+
      '<h2>My Finished Videos</h2>'+
      (videos.length
        ? videos.map(renderFinishedVideo).join('')
        : (Number(data.totalGenerated||0)>0
          ? '<p>Your earlier creation record is saved, but its old temporary video file is no longer available. New finished videos will remain here after deployments and restarts.</p>'
          : '<p>🎉 You have not created your first greeting yet. Click <strong>Create Your First Greeting</strong> to surprise someone special.</p>'));
  })
  .catch(()=>{
    localStorage.removeItem('printoGreetingCustomerKey');
    window.location.replace('/customer-login?next='+encodeURIComponent(loginNext));
  });
}
</script>
</body>
</html>`);
});

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
      await ensurePrintJobsDashboardColumns();
      const premiumDashboardRecovery = await syncMissingPremiumDashboardJobs({
        limit: 100,
        force: true,
        reason: "startup"
      });
      await refundInterruptedStandardGreetingGenerations();
      await syncPremiumDashboardProductionStatus();
      await releaseDuePrintoMembershipCredits();

      console.log(
        "Greeting access tables, memberships, and Premium dashboard status are ready.",
        { premiumDashboardRecovery }
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
