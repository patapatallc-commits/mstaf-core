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
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = String(file.originalname || "upload").replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const upload = multer({ storage });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  if (!process.env.DATABASE_URL) return;

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
  console.error("Database init error:", err.message);
});

const sessions = new Map();

function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, { language: "en", stage: "MENU" });
  }
  return sessions.get(from);
}

function detectLanguage(text = "") {
  const lower = String(text).trim().toLowerCase();

  if (lower.startsWith("hola") || lower === "spanish" || lower === "español" || lower === "espanol") return "es";
  if (lower.startsWith("bonjour") || lower === "french" || lower === "français" || lower === "francais") return "fr";
  if (lower.startsWith("hallo") || lower === "german" || lower === "deutsch") return "de";
  if (lower.startsWith("olá") || lower.startsWith("ola") || lower === "portuguese" || lower === "português" || lower === "portugues") return "pt";
  if (lower.startsWith("مرحبا") || lower === "arabic" || lower === "العربية" || lower === "عربي") return "ar";
  if (lower.startsWith("hello") || lower === "english") return "en";

  return null;
}

function greeting(language = "en") {
  return {
    en: "Hello 👋 Welcome to PATAPATA Print-O-Matic",
    es: "Hola 👋 Bienvenido a PATAPATA Print-O-Matic",
    fr: "Bonjour 👋 Bienvenue sur PATAPATA Print-O-Matic",
    de: "Hallo 👋 Willkommen bei PATAPATA Print-O-Matic",
    pt: "Olá 👋 Bem-vindo ao PATAPATA Print-O-Matic",
    ar: "مرحبًا 👋 أهلاً بك في PATAPATA Print-O-Matic",
  }[language] || "Hello 👋 Welcome to PATAPATA Print-O-Matic";
}

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
21 - Buy & Resell Auto`,

    es: `1 - Imprimir
2 - Laminar
3 - Foto de identificación
4 - Edición de imagen
5 - Edición de video
6 - Lección / Tarea
7 - Hablar con un agente
8 - Buscar mecánico de autos
9 - Necesito transporte al trabajo
10 - Apartamento compartido / Renta
11 - Necesito ayudante interior o exterior
12 - Camiseta personalizada
13 - Buscar trabajo / Enviar CV
14 - Oportunidades de trabajo
15 - Contratar trabajador
16 - Alerta comunitaria
17 - Proveedores confiables
18 - Comprar terreno para usar o revender
19 - Cambio de moneda
20 - Creador de redes sociales
21 - Comprar y revender autos`,

    fr: `1 - Imprimer
2 - Plastifier
3 - Photo d'identité
4 - Retouche d'image
5 - Montage vidéo
6 - Leçon / Devoirs
7 - Parler à un agent
8 - Trouver un mécanicien auto
9 - Besoin d'un trajet au travail
10 - Appartement partagé / Location
11 - Besoin d'aide intérieure ou extérieure
12 - Impression de t-shirt personnalisé
13 - Recherche d'emploi / Envoyer CV
14 - Offres d'emploi
15 - Embaucher un travailleur
16 - Alerte communautaire
17 - Fournisseurs fiables
18 - Acheter un terrain pour utiliser ou revendre
19 - Change de monnaie
20 - Créateur de réseaux sociaux
21 - Acheter et revendre des autos`,

    de: `1 - Drucken
2 - Laminieren
3 - Passfoto
4 - Bildbearbeitung
5 - Videobearbeitung
6 - Unterricht / Hausaufgaben
7 - Mit Agent sprechen
8 - Automechaniker finden
9 - Fahrt zur Arbeit benötigt
10 - WG / Miete
11 - Innen- oder Außenhilfe benötigt
12 - Individueller T-Shirt-Druck
13 - Jobsuche / Lebenslauf senden
14 - Jobangebote
15 - Arbeiter einstellen
16 - Gemeinschaftsalarm
17 - Vertrauenswürdige Lieferanten
18 - Land kaufen zur Nutzung oder zum Wiederverkauf
19 - Geldwechsel
20 - Social-Media-Ersteller
21 - Autos kaufen und weiterverkaufen`,

    pt: `1 - Imprimir
2 - Laminar
3 - Foto de identificação
4 - Edição de imagem
5 - Edição de vídeo
6 - Aula / Tarefa
7 - Falar com um agente
8 - Encontrar mecânico de automóveis
9 - Preciso de transporte para o trabalho
10 - Apartamento compartilhado / Aluguel
11 - Preciso de ajudante interno ou externo
12 - Impressão de camiseta personalizada
13 - Procurar emprego / Enviar CV
14 - Oportunidades de emprego
15 - Contratar trabalhador
16 - Alerta comunitário
17 - Fornecedores confiáveis
18 - Comprar terreno para usar ou revender
19 - Câmbio de moeda
20 - Criador de redes sociais
21 - Comprar e revender automóveis`,

    ar: `1 - طباعة
2 - تغليف حراري
3 - صورة هوية
4 - تعديل الصور
5 - تعديل الفيديو
6 - درس / واجب
7 - التحدث مع موظف
8 - البحث عن ميكانيكي سيارات
9 - أحتاج مواصلة إلى العمل
10 - سكن مشترك / إيجار
11 - أحتاج مساعدًا داخليًا أو خارجيًا
12 - طباعة تيشيرت مخصص
13 - البحث عن عمل / إرسال السيرة الذاتية
14 - فرص عمل
15 - توظيف عامل
16 - تنبيه مجتمعي
17 - موردون موثوقون
18 - شراء أرض للاستخدام أو إعادة البيع
19 - تحويل العملات
20 - منشئ محتوى وسائل التواصل
21 - شراء وإعادة بيع السيارات`,
  };

  return menus[language] || menus.en;
}    "13": {
      en: "Job Search / CV selected. Please upload your CV or type your job interest.",
      es: "Búsqueda de trabajo / CV seleccionado. Sube tu CV o escribe el trabajo que buscas.",
      fr: "Recherche d’emploi / CV sélectionnée. Envoyez votre CV ou écrivez le poste recherché.",
      de: "Jobsuche / Lebenslauf ausgewählt. Lade deinen Lebenslauf hoch oder schreibe dein Interesse.",
      pt: "Procura de emprego / CV selecionado. Envie seu CV ou escreva o emprego desejado.",
      ar: "تم اختيار البحث عن عمل / السيرة الذاتية. يرجى رفع السيرة الذاتية أو كتابة الوظيفة المطلوبة.",
    },

    "14": {
      en: "Job Opportunities selected. Please type your profession or role.",
      es: "Oportunidades de trabajo seleccionadas. Escribe tu profesión o puesto.",
      fr: "Offres d’emploi sélectionnées. Écrivez votre profession ou rôle.",
      de: "Jobangebote ausgewählt. Schreibe deinen Beruf oder deine Rolle.",
      pt: "Oportunidades de emprego selecionadas. Escreva sua profissão ou função.",
      ar: "تم اختيار فرص العمل. يرجى كتابة مهنتك أو وظيفتك.",
    },

    "15": {
      en: "Hire a Worker selected. Please describe the worker you need.",
      es: "Contratar trabajador seleccionado. Describe el trabajador que necesitas.",
      fr: "Embaucher un travailleur sélectionné. Décrivez le travailleur dont vous avez besoin.",
      de: "Arbeiter einstellen ausgewählt. Beschreibe, welche Arbeitskraft du brauchst.",
      pt: "Contratar trabalhador selecionado. Descreva o trabalhador que você precisa.",
      ar: "تم اختيار توظيف عامل. يرجى وصف العامل الذي تحتاجه.",
    },

    "16": {
      en: "Community Alert selected. Please send description, location, photo, or video.",
      es: "Alerta comunitaria seleccionada. Envía descripción, ubicación, foto o video.",
      fr: "Alerte communautaire sélectionnée. Envoyez description, lieu, photo ou vidéo.",
      de: "Gemeinschaftsalarm ausgewählt. Sende Beschreibung, Standort, Foto oder Video.",
      pt: "Alerta comunitário selecionado. Envie descrição, localização, foto ou vídeo.",
      ar: "تم اختيار التنبيه المجتمعي. يرجى إرسال الوصف والموقع والصورة أو الفيديو.",
    },

    "17": {
      en: "Trusted Suppliers selected. Please send the supplier category you need.",
      es: "Proveedores confiables seleccionado. Envía la categoría de proveedor que necesitas.",
      fr: "Fournisseurs fiables sélectionné. Envoyez la catégorie de fournisseur souhaitée.",
      de: "Vertrauenswürdige Lieferanten ausgewählt. Sende die gewünschte Lieferantenkategorie.",
      pt: "Fornecedores confiáveis selecionados. Envie a categoria do fornecedor desejado.",
      ar: "تم اختيار الموردين الموثوقين. يرجى إرسال فئة المورد المطلوبة.",
    },

    "18": {
      en: "Land Purchase selected. Please send location, budget, and purpose.",
      es: "Compra de terreno seleccionada. Envía ubicación, presupuesto y propósito.",
      fr: "Achat de terrain sélectionné. Envoyez lieu, budget et objectif.",
      de: "Landkauf ausgewählt. Sende Standort, Budget und Zweck.",
      pt: "Compra de terreno selecionada. Envie localização, orçamento e objetivo.",
      ar: "تم اختيار شراء الأرض. يرجى إرسال الموقع والميزانية والغرض.",
    },

    "19": {
      en: "Currency Exchange selected. Please send currency, amount, and location.",
      es: "Cambio de moneda seleccionado. Envía moneda, cantidad y ubicación.",
      fr: "Change de monnaie sélectionné. Envoyez devise, montant et lieu.",
      de: "Geldwechsel ausgewählt. Sende Währung, Betrag und Standort.",
      pt: "Câmbio selecionado. Envie moeda, valor e localização.",
      ar: "تم اختيار تحويل العملات. يرجى إرسال العملة والمبلغ والموقع.",
    },

    "20": {
      en: "Social Media Creator selected. Please send platform, topic, and content idea.",
      es: "Creador de redes sociales seleccionado. Envía plataforma, tema e idea de contenido.",
      fr: "Créateur de réseaux sociaux sélectionné. Envoyez plateforme, sujet et idée de contenu.",
      de: "Social-Media-Ersteller ausgewählt. Sende Plattform, Thema und Inhaltsidee.",
      pt: "Criador de mídia social selecionado. Envie plataforma, tema e ideia de conteúdo.",
      ar: "تم اختيار منشئ محتوى وسائل التواصل. يرجى إرسال المنصة والموضوع وفكرة المحتوى.",
    },

    "21": {
      en: "Buy & Resell Auto selected. Please send vehicle type, budget, and location.",
      es: "Comprar y revender autos seleccionado. Envía tipo de vehículo, presupuesto y ubicación.",
      fr: "Acheter et revendre des autos sélectionné. Envoyez type de véhicule, budget et lieu.",
      de: "Autos kaufen und weiterverkaufen ausgewählt. Sende Fahrzeugtyp, Budget und Standort.",
      pt: "Comprar e revender automóveis selecionado. Envie tipo de veículo, orçamento e localização.",
      ar: "تم اختيار شراء وإعادة بيع السيارات. يرجى إرسال نوع السيارة والميزانية والموقع.",
    },
  };

  return replies[option]?.[language] || replies[option]?.en || null;
}

function unknownReply(language = "en") {
  return {
    en: `Please reply with a number from the menu below:\n\n${serviceMenu("en")}`,
    es: `Por favor responde con un número del menú:\n\n${serviceMenu("es")}`,
    fr: `Veuillez répondre avec un numéro du menu :\n\n${serviceMenu("fr")}`,
    de: `Bitte antworte mit einer Nummer aus dem Menü:\n\n${serviceMenu("de")}`,
    pt: `Por favor responda com um número do menu:\n\n${serviceMenu("pt")}`,
    ar: `يرجى الرد برقم من القائمة التالية:\n\n${serviceMenu("ar")}`,
  }[language];
}

async function sendWhatsAppMessage(to, text) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.log("Missing WhatsApp credentials. Message not sent:", text);
    return;
  }

  await axios.post(
    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );
}app.get("/", (_req, res) => {
  res.json({ ok: true, message: "PATAPATA backend is running" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get("/webhook", (req, res) => {
  const verifyToken =
    process.env.WHATSAPP_VERIFY_TOKEN ||
    process.env.WEBHOOK_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post(["/webhook", "/whatsapp-webhook"], async (req, res) => {
  try {
    console.log(
      "WhatsApp webhook received:",
      JSON.stringify(req.body)
    );

    const message =
      req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;

    const session = getSession(from);

    const text =
      message.type === "text"
        ? message.text?.body || ""
        : "";

    const lower = text.trim().toLowerCase();

    const detectedLanguage = detectLanguage(text);

    if (detectedLanguage) {
      session.language = detectedLanguage;
      session.stage = "MENU";

      await sendWhatsAppMessage(
        from,
        `${greeting(session.language)}\n\n${serviceMenu(session.language)}`
      );

      return res.sendStatus(200);
    }

    if (message.type !== "text") {
      const received = {
        en: "File received. A team member will review it and reply shortly.",
        es: "Archivo recibido. Un miembro del equipo lo revisará y responderá pronto.",
        fr: "Fichier reçu. Un membre de l’équipe l’examinera et répondra bientôt.",
        de: "Datei erhalten. Ein Teammitglied prüft sie und antwortet bald.",
        pt: "Arquivo recebido. Um membro da equipe irá analisar e responder em breve.",
        ar: "تم استلام الملف. سيقوم أحد أعضاء الفريق بمراجعته والرد قريبًا.",
      };

      await sendWhatsAppMessage(
        from,
        received[session.language] || received.en
      );

      return res.sendStatus(200);
    }

    if (/^([1-9]|1[0-9]|2[0-1])$/.test(lower)) {

      const reply = optionReply(
        session.language,
        lower
      );

      await sendWhatsAppMessage(from, reply);

      return res.sendStatus(200);
    }

    await sendWhatsAppMessage(
      from,
      unknownReply(session.language)
    );

    return res.sendStatus(200);

  } catch (err) {

    console.error(
      "Webhook error:",
      err.response?.data || err.message || err
    );

    return res.sendStatus(200);
  }
});

app.post("/upload", upload.single("file"), async (req, res) => {

  try {

    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No file uploaded" });
    }

    res.json({
      ok: true,
      filename: req.file.filename,
      url: `/uploads/${req.file.filename}`,
    });

  } catch (err) {

    console.error(err);

    res
      .status(500)
      .json({ error: "Upload failed" });
  }
});

app.post("/send-sms", async (req, res) => {

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

    res
      .status(500)
      .json({ error: "Failed to send SMS" });
  }
});

app.post("/ai-reply", async (req, res) => {

  try {

    const { message } = req.body;

    if (!message) {

      return res
        .status(400)
        .json({ error: "Missing message" });
    }

    res.json({
      ok: true,
      reply: "AI reply placeholder",
    });

  } catch (err) {

    console.error(err);

    res
      .status(500)
      .json({ error: "AI reply failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
