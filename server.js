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

  return menus[language] || menus.en;
}

function optionReply(language = "en", option = "") {

  const replies = {

    "1": {
      en: "Print selected. Please upload your PDF, image, or document.",
      es: "Impresión seleccionada. Por favor sube tu PDF, imagen o documento.",
      fr: "Impression sélectionnée. Veuillez envoyer votre PDF, image ou document.",
      de: "Drucken ausgewählt. Bitte lade dein PDF, Bild oder Dokument hoch.",
      pt: "Impressão selecionada. Por favor envie seu PDF, imagem ou documento.",
      ar: "تم اختيار الطباعة. يرجى رفع ملف PDF أو صورة أو مستند.",
    },

    "2": {
      en: "Laminate selected. Please upload the document or image you want laminated.",
      es: "Laminado seleccionado. Por favor sube el documento o imagen que deseas laminar.",
      fr: "Plastification sélectionnée. Veuillez envoyer le document ou l’image à plastifier.",
      de: "Laminieren ausgewählt. Bitte lade das Dokument oder Bild hoch.",
      pt: "Laminação selecionada. Por favor envie o documento ou imagem.",
      ar: "تم اختيار التغليف الحراري. يرجى رفع المستند أو الصورة.",
    },

    "3": {
      en: "ID Photo selected. Please upload your photo.",
      es: "Foto de identificación seleccionada. Por favor sube tu foto.",
      fr: "Photo d'identité sélectionnée. Veuillez envoyer votre photo.",
      de: "Passfoto ausgewählt. Bitte lade dein Foto hoch.",
      pt: "Foto de identificação selecionada. Por favor envie sua foto.",
      ar: "تم اختيار صورة الهوية. يرجى رفع صورتك.",
    },

    "4": {
      en: "Image Editing selected. Please upload your image and describe what you want changed.",
      es: "Edición de imagen seleccionada. Sube tu imagen y describe lo que quieres cambiar.",
      fr: "Retouche d'image sélectionnée. Envoyez votre image et décrivez les changements souhaités.",
      de: "Bildbearbeitung ausgewählt. Lade dein Bild hoch und beschreibe die gewünschten Änderungen.",
      pt: "Edição de imagem selecionada. Envie sua imagem e descreva as alterações.",
      ar: "تم اختيار تعديل الصور. يرجى رفع الصورة وشرح التعديلات المطلوبة.",
    },

    "5": {
      en: "Video Editing selected. Please upload your video and instructions.",
      es: "Edición de video seleccionada. Sube tu video e instrucciones.",
      fr: "Montage vidéo sélectionné. Envoyez votre vidéo et vos instructions.",
      de: "Videobearbeitung ausgewählt. Lade dein Video und deine Anweisungen hoch.",
      pt: "Edição de vídeo selecionada. Envie seu vídeo e instruções.",
      ar: "تم اختيار تعديل الفيديو. يرجى رفع الفيديو والتعليمات.",
    },

    "6": {
      en: "Lesson / Homework selected. Please upload your file or type your question.",
      es: "Lección / Tarea seleccionada. Sube tu archivo o escribe tu pregunta.",
      fr: "Leçon / Devoirs sélectionné. Envoyez votre fichier ou écrivez votre question.",
      de: "Unterricht / Hausaufgaben ausgewählt. Lade deine Datei hoch oder schreibe deine Frage.",
      pt: "Aula / Tarefa selecionada. Envie seu arquivo ou escreva sua pergunta.",
      ar: "تم اختيار الدرس / الواجب. يرجى رفع الملف أو كتابة سؤالك.",
    },

    "7": {
      en: "Talk to Agent selected. Please type your request.",
      es: "Hablar con un agente seleccionado. Escribe tu solicitud.",
      fr: "Parler à un agent sélectionné. Veuillez écrire votre demande.",
      de: "Mit Agent sprechen ausgewählt. Bitte schreibe deine Anfrage.",
      pt: "Falar com agente selecionado. Por favor escreva sua solicitação.",
      ar: "تم اختيار التحدث مع موظف. يرجى كتابة طلبك.",
    },

    "8": {
      en: "Auto Mechanic selected. Please send your location, vehicle type, and the problem.",
      es: "Mecánico de autos seleccionado. Envía tu ubicación, tipo de vehículo y el problema.",
      fr: "Mécanicien auto sélectionné. Envoyez votre localisation, type de véhicule et problème.",
      de: "Automechaniker ausgewählt. Sende Standort, Fahrzeugtyp und Problem.",
      pt: "Mecânico selecionado. Envie localização, tipo de veículo e problema.",
      ar: "تم اختيار ميكانيكي السيارات. يرجى إرسال الموقع ونوع السيارة والمشكلة.",
    },

    "9": {
      en: "Ride to Work selected. Please send pickup location, destination, date, and time.",
      es: "Transporte al trabajo seleccionado. Envía punto de recogida, destino, fecha y hora.",
      fr: "Trajet au travail sélectionné. Envoyez le lieu de départ, destination, date et heure.",
      de: "Fahrt zur Arbeit ausgewählt. Sende Abholort, Ziel, Datum und Uhrzeit.",
      pt: "Transporte para o trabalho selecionado. Envie local, destino, data e hora.",
      ar: "تم اختيار مواصلة للعمل. يرجى إرسال موقع الانطلاق والوجهة والتاريخ والوقت.",
    },

    "10": {
      en: "Shared Apartment / Rent selected. Please send preferred location, budget, and move-in date.",
      es: "Apartamento compartido / Renta seleccionado. Envía ubicación, presupuesto y fecha de mudanza.",
      fr: "Appartement partagé / Location sélectionné. Envoyez lieu souhaité, budget et date d’emménagement.",
      de: "WG / Miete ausgewählt. Sende gewünschten Ort, Budget und Einzugsdatum.",
      pt: "Apartamento compartilhado selecionado. Envie localização, orçamento e data da mudança.",
      ar: "تم اختيار السكن المشترك / الإيجار. يرجى إرسال الموقع والميزانية وتاريخ الانتقال.",
    },

    "11": {
      en: "Helper selected. Please send the type of help needed, location, date, and time.",
      es: "Ayudante seleccionado. Envía tipo de ayuda, ubicación, fecha y hora.",
      fr: "Aide sélectionnée. Envoyez le type d’aide, lieu, date et heure.",
      de: "Hilfe ausgewählt. Sende Art der Hilfe, Standort, Datum und Uhrzeit.",
      pt: "Ajuda selecionada. Envie o tipo de ajuda, local, data e hora.",
      ar: "تم اختيار المساعدة. يرجى إرسال نوع المساعدة والموقع والتاريخ والوقت.",
    },

    "12": {
      en: "Custom T-Shirt Print selected. Please send shirt size, color, and design text/image.",
      es: "Camiseta personalizada seleccionada. Envía talla, color y texto/imagen del diseño.",
      fr: "T-shirt personnalisé sélectionné. Envoyez taille, couleur et texte/image du design.",
      de: "Individueller T-Shirt-Druck ausgewählt. Sende Größe, Farbe und Designtext/Bild.",
      pt: "Camiseta personalizada selecionada. Envie tamanho, cor e design.",
      ar: "تم اختيار طباعة تيشيرت مخصص. يرجى إرسال المقاس واللون والتصميم.",
    },

    "13": {
      en: "Job Search / CV selected. Please upload your CV or type your job interest.",
      es: "Búsqueda de trabajo / CV seleccionado. Sube tu CV o escribe el trabajo que buscas.",
      fr: "Recherche d’emploi / CV sélectionnée. Envoyez votre CV ou écrivez le poste recherché.",
      de: "Jobsuche / Lebenslauf ausgewählt. Lade deinen Lebenslauf hoch oder schreibe dein Interesse.",
      pt: "Procura de emprego / CV selecionado. Envie seu CV ou escreva o emprego desejado.",
      ar: "تم اختيار البحث عن عمل / السيرة الذاتية. يرجى رفع السيرة الذاتية أو كتابة الوظيفة المطلوبة.",
    },
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
