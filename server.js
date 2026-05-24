function getExtFromMime(mimeType = "") {
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
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

  
   function buildUploadUrl(req, finalName) {
  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `${req.protocol}://${req.get("host")}`;

  return `${base}/uploads/${encodeURIComponent(finalName)}`;
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
});
// Ensure uploads folder exists
const path = require("path");

// Multer storage

const uploadsDir = path.resolve("uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
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
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();


app.use("/uploads", express.static(uploadsDir));

app.use(express.static("public"));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use(express.json({ limit: "20mb" }));
const cors = require("cors");

app.use(cors({
  origin: [
    "https://patapata.us",
    "https://www.patapata.us",
    "https://patapata.myshopify.com"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-worker-key", "x-dashboard-key"],
  credentials: false
}));

app.options("*", cors());


app.use("/uploads", express.static(uploadsDir));

app.get("/uploads/:file", (req, res) => {
  const filePath = path.join(uploadsDir, req.params.file);
  res.sendFile(filePath);
});
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
     language: "en",
    selectedService: null,
    printSpec: {},
    laminateSpec: {},
    pendingFile: null,
    lastServiceJobId: null
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
    en: `1 - Print
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
25 - Mobile App Development`,

    es: `1 - Imprimir
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
25 - Desarrollo de aplicaciones móviles`,

    fr: `1 - Imprimer
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
25 - Développement d'application mobile`,

    de: `1 - Drucken
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
25 - Mobile-App-Entwicklung`,

    pt: `1 - Imprimir
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
25 - Desenvolvimento de aplicativo móvel`,

    ar: `1 - طباعة
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
25 - تطوير تطبيقات الجوال`
  };

  return menus[language] || menus.en;
}
function printSizeMenuText(language = "en") {
  const texts = {
    en: `Print selected.

Choose paper size:
1 - A4
2 - A3
3 - Letter
4 - Legal
5 - Tabloid
6 - Card`,

    de: `Drucken ausgewählt.

Wählen Sie die Papiergröße:
1 - A4
2 - A3
3 - Letter
4 - Legal
5 - Tabloid
6 - Karte`,

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
6 - Card`
  };

  return texts[language] || texts.en;
}

function printColorMenuText(language = "en") {
  const texts = {
    en: `Choose color:
1 - Black & White
2 - Color`,

    de: `Farbe wählen:
1 - Schwarzweiß
2 - Farbe`,

    es: `Elige color:
1 - Blanco y negro
2 - Color`,

    fr: `Choisissez la couleur :
1 - Noir et blanc
2 - Couleur`,

    pt: `Escolha a cor:
1 - Preto e branco
2 - Colorido`,

    ar: `اختر اللون:
1 - أبيض وأسود
2 - ملون`
  };

  return texts[language] || texts.en;
}

function laminateSizeMenuText(language = "en") {
  const texts = {
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
• Tabloid: ₦500`
  };

  return texts[language] || texts.en;
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
    en: "Hello 👋 Welcome to PATAPATA Print-O-Matic",
    es: "Hola 👋 Bienvenido a PATAPATA Print-O-Matic",
    fr: "Bonjour 👋 Bienvenue chez PATAPATA Print-O-Matic",
    de: "Hallo 👋 Willkommen bei PATAPATA Print-O-Matic",
    pt: "Olá 👋 Bem-vindo ao PATAPATA Print-O-Matic",
    ar: "مرحبًا 👋 أهلاً بك في PATAPATA Print-O-Matic"
  });
}

function selectedText(language = "en", serviceName = "") {
  return pickText(language, {
    en: `✅ Selected: ${serviceName}`,
    es: `✅ Seleccionado: ${serviceName}`,
    fr: `✅ Sélectionné : ${serviceName}`,
    de: `✅ Ausgewählt: ${serviceName}`,
    pt: `✅ Selecionado: ${serviceName}`,
    ar: `✅ تم الاختيار: ${serviceName}`
  });
}

function printSetupCompleteText(language = "en", spec = {}) {
  const colorText = spec.color_mode === "COLOR"
    ? pickText(language, { en: "Color", es: "Color", fr: "Couleur", de: "Farbe", pt: "Colorido", ar: "ملون" })
    : pickText(language, { en: "Black & White", es: "Blanco y negro", fr: "Noir et blanc", de: "Schwarzweiß", pt: "Preto e branco", ar: "أبيض وأسود" });

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

يرجى رفع ملف PDF أو صورة أو مستند الآن.`
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

يرجى رفع الملف/الصورة الآن.`
  });
}

function printFileReceivedText(language = "en", details = {}) {
  const colorText = details.colorMode === "COLOR"
    ? pickText(language, { en: "Color", es: "Color", fr: "Couleur", de: "Farbe", pt: "Colorido", ar: "ملون" })
    : pickText(language, { en: "Black & White", es: "Blanco y negro", fr: "Noir et blanc", de: "Schwarzweiß", pt: "Preto e branco", ar: "أبيض وأسود" });

  const checkout = details.checkoutUrl || pickText(language, {
    en: "Checkout link not available for this paper/color yet.",
    es: "El enlace de pago aún no está disponible para este papel/color.",
    fr: "Le lien de paiement n'est pas encore disponible pour ce papier/couleur.",
    de: "Der Checkout-Link ist für dieses Papier/diese Farbe noch nicht verfügbar.",
    pt: "O link de pagamento ainda não está disponível para este papel/cor.",
    ar: "رابط الدفع غير متاح بعد لهذا الورق/اللون."
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
3 - المتابعة مع موظف`
  });
}

function laminateFileReceivedText(language = "en", details = {}) {
  const checkout = details.checkoutUrl || pickText(language, {
    en: "Checkout link not available for this laminate size yet.",
    es: "El enlace de pago aún no está disponible para este tamaño de laminado.",
    fr: "Le lien de paiement n'est pas encore disponible pour ce format de plastification.",
    de: "Der Checkout-Link ist für diese Laminiergröße noch nicht verfügbar.",
    pt: "O link de pagamento ainda não está disponível para este tamanho de laminação.",
    ar: "رابط الدفع غير متاح بعد لحجم التغليف هذا."
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
3 - المتابعة مع موظف`
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
3 - المتابعة مع موظف`
  });
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
    VIDEO_ADVANCED: 1000
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
    const lower = text.toLowerCase().trim();
    const langMatch = lower.match(/lang=(en|es|fr|de|pt|ar)/);

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
// ===== LANDING PAGE WHATSAPP REQUESTS → WORKER DASHBOARD =====
if (
  lower.includes("upload and print") ||
  lower.includes("print-o-matic") ||
  lower.includes("lamination") ||
  lower.includes("image editing") ||
  lower.includes("video editing") ||
  lower.includes("submit cv")
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
    `✅ Your request has been received by PATAPATA Print-O-Matic.

Service: ${serviceType.replaceAll("_", " ")}

A worker will review it and reply to you shortly here on WhatsApp.

You may now send your file, photo, video, document, or voice instruction.`
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
          ELSE instructions || E'\\n\\n' || $1
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
    session.stage = "PRINT_SELECT_SIZE";
    await sendMessage(from, printSizeMenuText(session.language));
    return res.sendStatus(200);
  }

  if (lower === "2") {
    session.selectedService = "LAMINATE";
    session.laminateSpec = {};
    session.stage = "LAMINATE_WAITING_SIZE";
    await sendMessage(from, laminateSizeMenuText(session.language));
    return res.sendStatus(200);
  }

  if (lower === "3") {
    session.selectedService = "ID_PHOTO";
    session.stage = "IDPHOTO_WAITING_UPLOAD";
    await sendMessage(from, "📸 ID Photo selected. Please upload your photo now.");
    return res.sendStatus(200);
  }

  if (lower === "4") {
    session.selectedService = "IMAGE_EDIT";
    session.stage = "IMAGE_EDIT_SELECT_TYPE";
    await sendMessage(
      from,
      `🖼️ Image Editing selected.

Choose image editing type:

1 - Basic Image Edit
2 - Background Removal
3 - Product Photo Enhancement
4 - Advanced Image Editing

Reply with 1, 2, 3, or 4.`
    );
    return res.sendStatus(200);
  }

  if (lower === "5") {
    session.selectedService = "VIDEO_EDIT";
    session.stage = "VIDEO_EDIT_SELECT_TYPE";
    await sendMessage(
      from,
      `🎬 Video Editing selected.

Choose video editing type:

1 - Short Video Edit
2 - Social Media Video Edit
3 - Standard Video Edit
4 - Advanced Video Edit

Reply with 1, 2, 3, or 4.`
    );
    return res.sendStatus(200);
  }

  if (lower === "6") {
    session.selectedService = "LESSON_HOMEWORK";
    session.stage = "LESSON_WAITING_UPLOAD";
    await sendMessage(from, {
  en: "📚 Lesson / Homework selected. Please upload your file now.",
  es: "📚 Lección / Tarea seleccionada. Por favor suba su archivo ahora.",
  fr: "📚 Leçon / Devoir sélectionné. Veuillez télécharger votre fichier maintenant.",
  de: "📚 Unterricht / Hausaufgabe ausgewählt. Bitte laden Sie jetzt Ihre Datei hoch.",
  pt: "📚 Aula / Trabalho selecionado. Faça upload do seu arquivo agora.",
  ar: "📚 تم اختيار الدرس / الواجب. يرجى رفع الملف الآن."
}[session.language || "en"]);
    return res.sendStatus(200);
  }

  if (lower === "7") {
    session.selectedService = "TALK_TO_AGENT";
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    await sendMessage(from, pickText(session.language, {
      en: "👨‍💼 Talk to Agent selected. Please type your request now.",
      es: "👨‍💼 Hablar con un agente seleccionado. Escriba su solicitud ahora.",
      fr: "👨‍💼 Parler à un agent sélectionné. Veuillez écrire votre demande maintenant.",
      de: "👨‍💼 Mit Agent sprechen ausgewählt. Bitte schreiben Sie jetzt Ihre Anfrage.",
      pt: "👨‍💼 Falar com agente selecionado. Digite sua solicitação agora.",
      ar: "👨‍💼 تم اختيار التحدث مع موظف. يرجى كتابة طلبك الآن."
    }));
    return res.sendStatus(200);
  }

  if (lower === "8") {
    session.selectedService = "AUTO_MECHANIC";
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    await sendMessage(from, {
  en: "👨‍🔧 Please send your location, vehicle type, and the problem.",
  es: "👨‍🔧 Por favor envíe su ubicación, tipo de vehículo y el problema.",
  fr: "👨‍🔧 Veuillez envoyer votre position, le type de véhicule et le problème.",
  de: "👨‍🔧 Bitte senden Sie Ihren Standort, Fahrzeugtyp und das Problem.",
  pt: "👨‍🔧 Envie sua localização, tipo de veículo e o problema.",
  ar: "👨‍🔧 يرجى إرسال موقعك ونوع المركبة والمشكلة."
}[session.language || "en"]);
    return res.sendStatus(200);
  }

  if (lower === "9") {
    session.selectedService = "RIDE_TO_WORK";
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    await sendMessage(from, {
  en: "🚘 Please send pickup location, destination, date, and time.",
  es: "🚘 Envíe el lugar de recogida, destino, fecha y hora.",
  fr: "🚘 Veuillez envoyer le lieu de prise en charge, la destination, la date et l'heure.",
  de: "🚘 Bitte senden Sie Abholort, Zielort, Datum und Uhrzeit.",
  pt: "🚘 Envie o local de partida, destino, data e hora.",
  ar: "🚘 يرجى إرسال موقع الاستلام والوجهة والتاريخ والوقت."
}[session.language || "en"]);
    return res.sendStatus(200);
  }

  if (lower === "10") {
    session.selectedService = "SHARED_APARTMENT_RENT";
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    await sendMessage(from, pickText(session.language, {
      en: "🏠 Please send preferred location, budget, and move-in date.",
      es: "🏠 Envíe la ubicación preferida, presupuesto y fecha de mudanza.",
      fr: "🏠 Veuillez envoyer le lieu préféré, le budget et la date d'emménagement.",
      de: "🏠 Bitte senden Sie den bevorzugten Standort, das Budget und das Einzugsdatum.",
      pt: "🏠 Envie a localização preferida, orçamento e data de mudança.",
      ar: "🏠 يرجى إرسال الموقع المفضل والميزانية وتاريخ الانتقال."
    }));
    return res.sendStatus(200);
  }

  if (lower === "11") {
    session.selectedService = "INDOOR_OUTDOOR_HELPER";
    session.stage = "SERVICE_WAITING_EXTRA_NOTES";
    await sendMessage(from, pickText(session.language, {
      en: `🧰 Indoor / Outdoor Helper selected.

Please send:
1. Type of helper needed
2. Indoor or outdoor work
3. Your location
4. Date and time needed

Our team will contact you shortly on WhatsApp.`,
      es: `🧰 Ayudante interior / exterior seleccionado.

Envíe:
1. Tipo de ayudante necesario
2. Trabajo interior o exterior
3. Su ubicación
4. Fecha y hora necesarias

Nuestro equipo se comunicará con usted pronto por WhatsApp.`,
      fr: `🧰 Aide intérieure / extérieure sélectionnée.

Veuillez envoyer :
1. Type d'aide nécessaire
2. Travail intérieur ou extérieur
3. Votre position
4. Date et heure souhaitées

Notre équipe vous contactera bientôt sur WhatsApp.`,
      de: `🧰 Innen- / Außenhilfe ausgewählt.

Bitte senden Sie:
1. Art der benötigten Hilfe
2. Innen- oder Außenarbeit
3. Ihren Standort
4. Benötigtes Datum und Uhrzeit

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.`,
      pt: `🧰 Ajudante interno / externo selecionado.

Envie:
1. Tipo de ajudante necessário
2. Trabalho interno ou externo
3. Sua localização
4. Data e horário necessários

Nossa equipe entrará em contato em breve pelo WhatsApp.`,
      ar: `🧰 تم اختيار مساعد داخلي / خارجي.

يرجى إرسال:
1. نوع المساعد المطلوب
2. عمل داخلي أو خارجي
3. موقعك
4. التاريخ والوقت المطلوبان

سيتواصل معك فريقنا قريبًا عبر واتساب.`
    }));
    return res.sendStatus(200);
  }

  if (lower === "12") {
    session.selectedService = "TSHIRT_PRINT";
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

رد بـ S أو M أو L أو XL أو XXL.`
    }));
    return res.sendStatus(200);
  }
  if (lower === "13") {
  session.selectedService = "JOB_APPLICATION";
  session.stage = "JOB_SELECT_ROLE";

  await sendMessage(
    from,
    `💼 Job Application / CV Submission

Please choose the role you are applying for:

1 - Graphic Designer
2 - Print Machine Operator
3 - Customer Support Agent
4 - Delivery Driver
5 - Video Editor

Reply with 1, 2, 3, 4, or 5.`
  );

  return res.sendStatus(200);
}
if (lower === "14") {
  session.selectedService = "JOB_OPPORTUNITIES";
  session.stage = "JOB_OPPORTUNITIES_MENU";

  await sendMessage(
    from,
    `💼 JOB OPPORTUNITIES

Please choose your profession:

1 - Graphic Designer
2 - Print Operator
3 - Delivery Driver
4 - Video Editor
5 - Customer Support

Reply with a number.`
  );

  return res.sendStatus(200);
}

if (lower === "15") {
  session.selectedService = "HIRE_WORKER";
  session.stage = "HIRE_WORKER_MENU";

  await sendMessage(
    from,
    `👷 HIRE A WORKER

Please describe the worker you need.

Examples:
- Graphic designer
- Electrician
- Plumber
- Video editor
- Carpenter

You can also send voice note.`
  );

  return res.sendStatus(200);
}

if (lower === "16") {
  session.selectedService = "COMMUNITY_ALERT";
  session.stage = "COMMUNITY_ALERT_WAITING";

  await sendMessage(
    from,
    `🚨 COMMUNITY ALERT

Please send:

• Picture/video of incident
• Description
• Location

This information will be reviewed before broadcasting.`
  );

  return res.sendStatus(200);
}

if (lower === "17") {
  session.selectedService = "TRUSTED_SUPPLIERS";
  session.stage = "SUPPLIER_CATEGORY";

  await sendMessage(
    from,
    `🏪 TRUSTED SUPPLIERS

Choose category:

1 - Printing Materials
2 - Electrical Materials
3 - Building Materials
4 - Fashion Materials
5 - Computer Accessories

Reply with a number.`
  );

  return res.sendStatus(200);
}
  if (lower === "18") {
  session.selectedService = "BUY_LAND_RESELL";
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(
    from,
    `🏞️ Buy Land for Use or Resell selected.

Please send:
1. Country/state/location
2. Your budget
3. Land purpose: use, build, farm, or resell
4. How soon you want it

Our team will contact you shortly on WhatsApp.`
  );

  return res.sendStatus(200);
}

if (lower === "19") {
  session.selectedService = "CURRENCY_EXCHANGE";
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(
    from,
    `💱 Currency Exchange selected.

Please send:
1. Currency you have
2. Currency you need
3. Amount
4. Country/location

Our team will contact you shortly on WhatsApp.`
  );

  return res.sendStatus(200);
}

if (lower === "20") {
  session.selectedService = "SOCIAL_MEDIA_CREATOR";
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(
    from,
    `📱 Social Media Creator selected.

Please send:
1. Type of content you need
2. Platform: TikTok, Instagram, Facebook, YouTube, etc.
3. Topic/product/business name
4. Any sample or idea

You can also send photo, video, text, or voice note.`
  );

  return res.sendStatus(200);
}

if (lower === "21") {
  session.selectedService = "BUY_RESELL_AUTO";
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";

  await sendMessage(
    from,
    `🚘 Buy & Resell Auto selected.

Please send:
1. Vehicle type/model
2. Buy, sell, or resell
3. Budget or asking price
4. Location


Our team will contact you shortly on WhatsApp.`
  );

  return res.sendStatus(200);
}

if (lower === "22") {
  session.selectedService = "CAR_LOAN_FINANCING";
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🚗💰 Car Loan / Auto Financing selected.

Please send:
1. Your location/country
2. Vehicle type or model
3. Loan amount or budget
4. Employment/income status
5. Best contact time

PATAPATA will connect you with approved providers. Provider commission is handled by the provider, not the customer.`,
    es: `🚗💰 Préstamo de auto / Financiamiento seleccionado.

Envíe:
1. Su ubicación/país
2. Tipo o modelo de vehículo
3. Monto del préstamo o presupuesto
4. Estado laboral/ingresos
5. Mejor hora de contacto

PATAPATA lo conectará con proveedores aprobados. La comisión la paga el proveedor, no el cliente.`,
    fr: `🚗💰 Prêt auto / Financement sélectionné.

Veuillez envoyer :
1. Votre lieu/pays
2. Type ou modèle du véhicule
3. Montant du prêt ou budget
4. Situation professionnelle/revenus
5. Meilleur moment pour vous contacter

PATAPATA vous mettra en relation avec des fournisseurs approuvés. La commission est payée par le fournisseur, pas par le client.`,
    de: `🚗💰 Autokredit / Finanzierung ausgewählt.

Bitte senden Sie:
1. Standort/Land
2. Fahrzeugtyp oder Modell
3. Kreditbetrag oder Budget
4. Beschäftigungs-/Einkommensstatus
5. Beste Kontaktzeit

PATAPATA verbindet Sie mit geprüften Anbietern. Die Provision wird vom Anbieter bezahlt, nicht vom Kunden.`,
    pt: `🚗💰 Empréstimo de carro / Financiamento selecionado.

Envie:
1. Sua localização/país
2. Tipo ou modelo do veículo
3. Valor do empréstimo ou orçamento
4. Situação de emprego/renda
5. Melhor horário para contato

A PATAPATA conectará você a provedores aprovados. A comissão é paga pelo provedor, não pelo cliente.`,
    ar: `🚗💰 تم اختيار قرض سيارة / تمويل.

يرجى إرسال:
1. موقعك/بلدك
2. نوع أو موديل السيارة
3. مبلغ القرض أو الميزانية
4. حالة العمل/الدخل
5. أفضل وقت للتواصل

ستوصلك PATAPATA بمقدمي خدمات معتمدين. العمولة يدفعها مقدم الخدمة وليس العميل.`
  }));
  return res.sendStatus(200);
}

if (lower === "23") {
  session.selectedService = "CAR_INSURANCE";
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🛡️ Car Insurance selected.

Please send:
1. Your location/country
2. Vehicle make, model, and year
3. Current insurance status
4. Coverage needed
5. Best contact time

PATAPATA will refer you to trusted insurance providers. Provider commission is handled by the provider, not the customer.`,
    es: `🛡️ Seguro de auto seleccionado.

Envíe:
1. Su ubicación/país
2. Marca, modelo y año del vehículo
3. Estado actual del seguro
4. Cobertura necesaria
5. Mejor hora de contacto

PATAPATA lo referirá a proveedores de seguros confiables. La comisión la paga el proveedor, no el cliente.`,
    fr: `🛡️ Assurance auto sélectionnée.

Veuillez envoyer :
1. Votre lieu/pays
2. Marque, modèle et année du véhicule
3. Statut actuel d'assurance
4. Couverture souhaitée
5. Meilleur moment pour vous contacter

PATAPATA vous orientera vers des assureurs fiables. La commission est payée par le fournisseur, pas par le client.`,
    de: `🛡️ Autoversicherung ausgewählt.

Bitte senden Sie:
1. Standort/Land
2. Marke, Modell und Baujahr
3. Aktueller Versicherungsstatus
4. Gewünschte Deckung
5. Beste Kontaktzeit

PATAPATA vermittelt Sie an vertrauenswürdige Versicherungsanbieter. Die Provision wird vom Anbieter bezahlt, nicht vom Kunden.`,
    pt: `🛡️ Seguro de carro selecionado.

Envie:
1. Sua localização/país
2. Marca, modelo e ano do veículo
3. Situação atual do seguro
4. Cobertura desejada
5. Melhor horário para contato

A PATAPATA encaminhará você a seguradoras confiáveis. A comissão é paga pelo provedor, não pelo cliente.`,
    ar: `🛡️ تم اختيار تأمين السيارات.

يرجى إرسال:
1. موقعك/بلدك
2. نوع السيارة والموديل والسنة
3. حالة التأمين الحالية
4. نوع التغطية المطلوبة
5. أفضل وقت للتواصل

ستحيلك PATAPATA إلى مزودي تأمين موثوقين. العمولة يدفعها مقدم الخدمة وليس العميل.`
  }));
  return res.sendStatus(200);
}

if (lower === "24") {
  session.selectedService = "CAR_RENTAL";
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `🚙 Car Rental Services selected.

Please send:
1. Pickup city/location
2. Rental start and return date
3. Vehicle type needed
4. Driver needed? Yes/No
5. Budget range

PATAPATA will connect you with rental providers. Provider commission is handled by the provider, not the customer.`,
    es: `🚙 Servicios de alquiler de autos seleccionado.

Envíe:
1. Ciudad/lugar de recogida
2. Fecha de inicio y devolución
3. Tipo de vehículo necesario
4. ¿Necesita conductor? Sí/No
5. Rango de presupuesto

PATAPATA lo conectará con proveedores de alquiler. La comisión la paga el proveedor, no el cliente.`,
    fr: `🚙 Services de location de voiture sélectionnés.

Veuillez envoyer :
1. Ville/lieu de prise en charge
2. Date de début et de retour
3. Type de véhicule souhaité
4. Chauffeur nécessaire ? Oui/Non
5. Fourchette de budget

PATAPATA vous mettra en relation avec des loueurs. La commission est payée par le fournisseur, pas par le client.`,
    de: `🚙 Autovermietung ausgewählt.

Bitte senden Sie:
1. Abholstadt/Standort
2. Start- und Rückgabedatum
3. Benötigter Fahrzeugtyp
4. Fahrer benötigt? Ja/Nein
5. Budgetrahmen

PATAPATA verbindet Sie mit Mietwagenanbietern. Die Provision wird vom Anbieter bezahlt, nicht vom Kunden.`,
    pt: `🚙 Serviços de aluguel de carros selecionados.

Envie:
1. Cidade/local de retirada
2. Data de início e devolução
3. Tipo de veículo necessário
4. Precisa de motorista? Sim/Não
5. Faixa de orçamento

A PATAPATA conectará você a locadoras. A comissão é paga pelo provedor, não pelo cliente.`,
    ar: `🚙 تم اختيار خدمات تأجير السيارات.

يرجى إرسال:
1. مدينة/موقع الاستلام
2. تاريخ البداية والإرجاع
3. نوع السيارة المطلوبة
4. هل تحتاج سائق؟ نعم/لا
5. نطاق الميزانية

ستوصلك PATAPATA بمزودي تأجير السيارات. العمولة يدفعها مقدم الخدمة وليس العميل.`
  }));
  return res.sendStatus(200);
}

if (lower === "25") {
  session.selectedService = "MOBILE_APP_DEVELOPMENT";
  session.stage = "SERVICE_WAITING_EXTRA_NOTES";
  await sendMessage(from, pickText(session.language, {
    en: `📱 Mobile App Development selected.

Please send:
1. App idea or business type
2. Android, iPhone, or both
3. Main features needed
4. Budget range
5. Timeline

PATAPATA will connect you with app development providers. Provider commission is handled by the provider, not the customer.`,
    es: `📱 Desarrollo de aplicaciones móviles seleccionado.

Envíe:
1. Idea de la app o tipo de negocio
2. Android, iPhone o ambos
3. Funciones principales necesarias
4. Rango de presupuesto
5. Tiempo estimado

PATAPATA lo conectará con desarrolladores de apps. La comisión la paga el proveedor, no el cliente.`,
    fr: `📱 Développement d'application mobile sélectionné.

Veuillez envoyer :
1. Idée d'application ou type d'entreprise
2. Android, iPhone ou les deux
3. Fonctionnalités principales souhaitées
4. Fourchette de budget
5. Délai

PATAPATA vous mettra en relation avec des développeurs d'applications. La commission est payée par le fournisseur, pas par le client.`,
    de: `📱 Mobile-App-Entwicklung ausgewählt.

Bitte senden Sie:
1. App-Idee oder Geschäftstyp
2. Android, iPhone oder beides
3. Benötigte Hauptfunktionen
4. Budgetrahmen
5. Zeitplan

PATAPATA verbindet Sie mit App-Entwicklungsanbietern. Die Provision wird vom Anbieter bezahlt, nicht vom Kunden.`,
    pt: `📱 Desenvolvimento de aplicativo móvel selecionado.

Envie:
1. Ideia do aplicativo ou tipo de negócio
2. Android, iPhone ou ambos
3. Principais recursos necessários
4. Faixa de orçamento
5. Prazo

A PATAPATA conectará você a desenvolvedores de aplicativos. A comissão é paga pelo provedor, não pelo cliente.`,
    ar: `📱 تم اختيار تطوير تطبيقات الجوال.

يرجى إرسال:
1. فكرة التطبيق أو نوع العمل
2. أندرويد أو آيفون أو كلاهما
3. الميزات الرئيسية المطلوبة
4. نطاق الميزانية
5. الجدول الزمني

ستوصلك PATAPATA بمطوري التطبيقات. العمولة يدفعها مقدم الخدمة وليس العميل.`
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

  await sendMessage(
    from,
    `✅ Your worker request has been received.

Worker needed: ${workerRequest}

Our team will review available workers and contact you shortly on WhatsApp.`
  );

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
    await sendMessage(
      from,
      `Please choose a valid role:

1 - Graphic Designer
2 - Print Operator
3 - Delivery Driver
4 - Video Editor
5 - Customer Support`
    );

    return res.sendStatus(200);
  }

  const job = await createTextOnlyServiceJob(
    "JOB_OPPORTUNITIES",
    `Job application for: ${selectedRole}`
  );

  session.lastServiceJobId = job?.id || null;
  session.stage = "MENU";

  await sendMessage(
    from,
    `✅ Your job interest has been received.

Selected Role: ${selectedRole}

Our recruitment team will contact you shortly on WhatsApp with available opportunities.`
  );

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

  await sendMessage(
    from,
    `🚨 Community alert received.

Our moderation team will review the report before broadcasting it to the community.

Thank you for helping keep the community safe.`
  );

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

  await sendMessage(
    from,
    `✅ Community alert details received.

Our moderation team will review the media and details before any community broadcast.

Thank you for helping keep the community safe.`
  );

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

  await sendMessage(
    from,
    `✅ Community alert voice note received.

Our moderation team will review the media and voice details before any community broadcast.

Thank you for helping keep the community safe.`
  );

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
    await sendMessage(
      from,
      `Please choose a valid supplier category:

1 - Printing Materials
2 - Electrical Materials
3 - Building Materials
4 - Fashion Materials
5 - Computer Accessories`
    );

    return res.sendStatus(200);
  }

  const job = await createTextOnlyServiceJob(
    "TRUSTED_SUPPLIERS",
    `Supplier category requested: ${selectedCategory}`
  );

  session.lastServiceJobId = job?.id || null;
  session.stage = "MENU";

  await sendMessage(
    from,
    `🏪 Trusted Suppliers

Category selected: ${selectedCategory}

Our team will send you verified supplier recommendations shortly.

We are also setting up referral tracking so workmen can buy materials from trusted companies with proper monitoring.`
  );

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

  await sendMessage(from, {
  en: "How many copies do you want?",
  es: "¿Cuántas copias deseas?",
  fr: "Combien de copies voulez-vous ?",
  de: "Wie viele Kopien möchten Sie?",
  pt: "Quantas cópias você deseja?",
  ar: "كم عدد النسخ التي تريدها؟"
}[session.language || "en"]);
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
      ar: "يرجى إدخال عدد صحيح من النسخ، مثل: 1 أو 2 أو 5 أو 10."
    }));
    return res.sendStatus(200);
  }

  session.printSpec.copies = copies;
  session.stage = "PRINT_WAITING_PAGES";

  await sendMessage(from, {
  en: "How many pages are in the document?",
  es: "¿Cuántas páginas tiene el documento?",
  fr: "Combien de pages contient le document ?",
  de: "Wie viele Seiten hat das Dokument?",
  pt: "Quantas páginas tem o documento?",
  ar: "كم عدد صفحات المستند؟"
}[session.language || "en"]);
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

  await sendMessage(from, {
  en: "How many documents/pages do you want laminated?",
  es: "¿Cuántos documentos/páginas desea laminar?",
  fr: "Combien de documents/pages voulez-vous plastifier ?",
  de: "Wie viele Dokumente/Seiten möchten Sie laminieren?",
  pt: "Quantos documentos/páginas você deseja laminar?",
  ar: "كم عدد المستندات/الصفحات التي تريد تغليفها؟"
}[session.language || "en"]);
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
    ar: "يرجى الرد بـ 1 أو 2 أو 3 أو 4 أو 5."
  }));
    return res.sendStatus(200);
  }

  session.jobRole = role;
  session.stage = "JOB_WAITING_CV";

  await sendMessage(
    from,
    `✅ Selected Role: ${role}

Please upload your CV (PDF or document).

You can also send a voice note with additional information.`
  );

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
    ar: "رد بـ 1 أو 2 أو 3 أو 4."
  }));
    return res.sendStatus(200);
  }

  session.imageEditType = selected[0];
  session.stage = "IMAGE_EDIT_WAITING_UPLOAD";

  await sendMessage(
    from,
    `✅ Selected: ${selected[0]}

Shopify Checkout:
${buildShopifyCartUrl(selected[1], 1)}

Africa Payment:
https://www.patapata.us/pages/africa-payment

Please upload your image now.`
  );
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
    ar: "رد بـ 1 أو 2 أو 3 أو 4."
  }));
    return res.sendStatus(200);
  }

  session.videoEditType = selected[0];
  session.videoVariantId = selected[1];
  session.stage = "VIDEO_EDIT_WAITING_UPLOAD";

  await sendMessage(
    from,
    `✅ Selected: ${selected[0]}

Shopify Checkout:
${buildShopifyCartUrl(selected[1], 1)}

Africa Payment:
https://www.patapata.us/pages/africa-payment

Please upload your video now.`
  );
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
    ar: "يرجى الرد بـ Small أو Medium أو Large أو XL أو XXL."
  }));
    return res.sendStatus(200);
  }

  session.tshirtSize = size;
  session.stage = "TSHIRT_WAITING_TEXT";

  await sendMessage(
    from,
    `✅ Size selected: ${size}

Please type the text you want printed on your T-shirt.

You can also include:
- Shirt color
- Print color
- Front or back placement

Our team will contact you shortly on WhatsApp.`
  );
  return res.sendStatus(200);
}

if (session.stage === "TSHIRT_WAITING_TEXT" && type === "text") {
  const designText = text.trim();

  const job = await createTextOnlyServiceJob(
    "TSHIRT_PRINT",
    `Size: ${session.tshirtSize}\nDesign: ${designText}`
  );

  session.lastServiceJobId = job?.id || null;

  await sendMessage(
    from,
    `👕 Your T-shirt request has been received.

Size: ${session.tshirtSize}
Design: ${designText}

Our team will contact you shortly on WhatsApp.`
  );

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
      en: "✅ Text instruction received. You can also send photo, document, video, or voice note.",
      es: "✅ Instrucción de texto recibida. También puede enviar foto, documento, video o nota de voz.",
      fr: "✅ Instruction texte reçue. Vous pouvez aussi envoyer une photo, un document, une vidéo ou une note vocale.",
      de: "✅ Textanweisung erhalten. Sie können auch Foto, Dokument, Video oder Sprachnachricht senden.",
      pt: "✅ Instrução de texto recebida. Você também pode enviar foto, documento, vídeo ou nota de voz.",
      ar: "✅ تم استلام التعليمات النصية. يمكنك أيضًا إرسال صورة أو مستند أو فيديو أو رسالة صوتية."
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
      ar: "✅ تم استلام الرسالة الصوتية. يمكنك أيضًا إرسال صورة أو مستند أو فيديو أو تعليمات نصية."
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
      ar: `✅ تم استلام ${type}. يمكنك أيضًا إرسال تعليمات نصية أو رسالة صوتية.`
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
    ar: "يرجى إرسال نص أو رسالة صوتية أو صورة أو فيديو أو مستند."
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

  await sendMessage(
    from,
    

`🚨 Community alert media received.

Please now send ANY of the following:

• What happened
• Location
• Time/date if known
• Voice note explanation

You may send text, voice note, or both.

Our moderation team will review everything before any community broadcast.`
  );

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

  await sendMessage(
    from,
    `✅ CV received for ${session.jobRole}

You can now send:
• Text instruction
• OR voice note

Our team will review and contact you shortly.`
  );

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

        await sendMessage(
  from,
  `✅ Image received.

Please send your instruction now as text or voice note.

Our team will contact you shortly on WhatsApp.`
);
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

  await sendMessage(
    from,
    `✅ Lesson / Homework file received.

Please send your instruction now as text or voice note.

Our team will contact you shortly on WhatsApp.`
  );

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

        await sendMessage(
  from,
  `✅ Video received.

Please send your instruction now as text or voice note.

Our team will contact you shortly on WhatsApp.`
);
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

        await sendMessage(
  from,
  `✅ ID photo received.

Please send your instruction now as text or voice note.

Our team will contact you shortly on WhatsApp.`
);
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

Our team will contact you shortly on WhatsApp.`,
      es: `✅ Pago de Shopify registrado.

Nuestro equipo se comunicará con usted pronto por WhatsApp.`,
      fr: `✅ Paiement Shopify noté.

Notre équipe vous contactera bientôt sur WhatsApp.`,
      de: `✅ Shopify-Zahlung notiert.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.`,
      pt: `✅ Pagamento Shopify registrado.

Nossa equipe entrará em contato em breve pelo WhatsApp.`,
      ar: `✅ تم تسجيل دفع Shopify.

سيتواصل معك فريقنا قريبًا عبر واتساب.`
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

Our team will contact you shortly on WhatsApp.`,
      es: `✅ Pago África registrado.

Nuestro equipo se comunicará con usted pronto por WhatsApp.`,
      fr: `✅ Paiement Afrique noté.

Notre équipe vous contactera bientôt sur WhatsApp.`,
      de: `✅ Afrika-Zahlung notiert.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.`,
      pt: `✅ Pagamento África registrado.

Nossa equipe entrará em contato em breve pelo WhatsApp.`,
      ar: `✅ تم تسجيل دفع أفريقيا.

سيتواصل معك فريقنا قريبًا عبر واتساب.`
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

Our team will contact you shortly on WhatsApp.`,
      es: `👨‍💼 Continuar con agente seleccionado.

Envíe cualquier instrucción adicional como texto o nota de voz.

Nuestro equipo se comunicará con usted pronto por WhatsApp.`,
      fr: `👨‍💼 Continuer avec un agent sélectionné.

Veuillez envoyer toute instruction supplémentaire par texte ou note vocale.

Notre équipe vous contactera bientôt sur WhatsApp.`,
      de: `👨‍💼 Mit Agent fortfahren ausgewählt.

Bitte senden Sie zusätzliche Anweisungen als Text oder Sprachnachricht.

Unser Team wird Sie in Kürze per WhatsApp kontaktieren.`,
      pt: `👨‍💼 Continuar com agente selecionado.

Envie qualquer instrução adicional por texto ou nota de voz.

Nossa equipe entrará em contato em breve pelo WhatsApp.`,
      ar: `👨‍💼 تم اختيار المتابعة مع موظف.

يرجى إرسال أي تعليمات إضافية كنص أو رسالة صوتية.

سيتواصل معك فريقنا قريبًا عبر واتساب.`
    }));

    return res.sendStatus(200);
  }

  await sendMessage(from, paymentChoiceInvalidText(session.language));

  return res.sendStatus(200);
}
  // Only show menu if already in MENU stage
else if (session.stage === "MENU") {
  await sendMessage(
    from,
    `Please reply with one of the options below:

${serviceMenu(session.language)}`
  );

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

  function renderInstructions(job) {
    const parts = [];

    if (job.instructions) {
      parts.push('<div class="insBox"><b>Text Instruction</b><br>' + h(job.instructions).replace(/\\n/g, "<br>") + '</div>');
    }

    if (job.notes) {
      parts.push('<div class="insBox"><b>Notes</b><br>' + h(job.notes).replace(/\\n/g, "<br>") + '</div>');
    }

    if (job.error_message) {
      parts.push('<div class="insBox"><b>Error / Status Note</b><br>' + h(job.error_message).replace(/\\n/g, "<br>") + '</div>');
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

  function renderJob(job, printers) {
    const fileUrl = job.file_url || "";
    const title = job.original_name || job.service_type || ("Job #" + job.id);
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
    try {
      const q = document.getElementById("q").value.trim();
      const status = document.getElementById("status").value;
      const queue = document.getElementById("queue").value || currentQueue;

      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (status) params.set("status", status);
      if (queue) params.set("queue", queue);

      const data = await api("/api/dashboard/jobs?" + params.toString());
      const jobs = data.jobs || [];
      const printers = data.printers || [];

      summarize(jobs);

      const grid = document.getElementById("jobGrid");
      if (!jobs.length) {
        grid.innerHTML = '<div class="emptyState">No jobs found for the selected filter.</div>';
        return;
      }

      grid.innerHTML = jobs.map(job => renderJob(job, printers)).join("");
    } catch (err) {
      document.getElementById("jobGrid").innerHTML =
        '<div class="emptyState">Dashboard load failed: ' + h(err.message) + '</div>';
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

  document.getElementById("q").addEventListener("input", () => loadJobs());
  document.getElementById("status").addEventListener("change", () => loadJobs());
  document.getElementById("queue").addEventListener("change", () => loadJobs());

  document.getElementById("manualUploadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(e.target);
      const res = await fetch("/api/dashboard/manual-upload?key=" + encodeURIComponent(DASHBOARD_KEY), {
        method: "POST",
        body: fd
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed");
      alert("Dashboard upload created successfully.");
      e.target.reset();
      loadJobs();
    } catch (err) {
      alert("Manual upload failed: " + err.message);
    }
  });

  loadJobs();
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
  loadJobs();
}, 8000);
</script>
</body>
</html>`);
});
 

/******************************************************************
 * WORKER + AGENT DASHBOARD END
 ******************************************************************/

   

 
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
