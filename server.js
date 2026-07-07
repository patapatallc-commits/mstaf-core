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
const express = require("express");
const axios = require("axios");
const { execFile } = require("child_process");
require("dotenv").config();

const app = express();


app.use("/uploads", express.static(uploadsDir));
app.use("/generated", express.static(generatedDir));

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
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || process.env.PATAPATA_PHONE || "18622306637";

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
// PRINTO GREETING STUDIO
// =========================
const GREETING_TEMPLATES = [
  {
    id: "birthday",
    name: "Birthday Greeting",
    occasion: "Birthday",
    masterVideo: "master.mp4",
    priceLabel: "Standard"
  },
  {
    id: "wedding",
    name: "Wedding Greeting",
    occasion: "Wedding",
    masterVideo: "master.mp4",
    priceLabel: "Standard"
  },
  {
    id: "graduation",
    name: "Graduation Greeting",
    occasion: "Graduation",
    masterVideo: "master.mp4",
    priceLabel: "Standard"
  },
  {
    id: "anniversary",
    name: "Anniversary Greeting",
    occasion: "Anniversary",
    masterVideo: "master.mp4",
    priceLabel: "Standard"
  },
  {
    id: "christmas",
    name: "Christmas Greeting",
    occasion: "Christmas",
    masterVideo: "master.mp4",
    priceLabel: "Standard"
  },
  {
    id: "business",
    name: "Business Greeting",
    occasion: "Business",
    masterVideo: "master.mp4",
    priceLabel: "Premium"
  }
];

function getGreetingTemplate(templateId = "birthday") {
  const id = String(templateId || "birthday").trim().toLowerCase();
  return GREETING_TEMPLATES.find((item) => item.id === id) || GREETING_TEMPLATES[0];
}

function greetingStudioMenuText(language = "en") {
  return pickText(language, {
    en: `🎬 Printo Greeting Studio

Create personalized animated Printo video greeting cards.

Choose the occasion:
1 - Birthday
2 - Wedding
3 - Graduation
4 - Anniversary
5 - Christmas
6 - Business Greeting

Reply with only the occasion number.

You do NOT need to use | or /. The bot will ask one question at a time.`,
    es: `🎬 Printo Greeting Studio

Crea tarjetas de video animadas personalizadas de Printo.

Elige la ocasión:
1 - Cumpleaños
2 - Boda
3 - Graduación
4 - Aniversario
5 - Navidad
6 - Saludo de negocio

Responde solo con el número de la ocasión.

No necesitas usar | ni /. El bot preguntará paso a paso.`,
    fr: `🎬 Printo Greeting Studio

Créez des cartes vidéo animées personnalisées avec Printo.

Choisissez l'occasion :
1 - Anniversaire
2 - Mariage
3 - Remise de diplôme
4 - Anniversaire
5 - Noël
6 - Message professionnel

Répondez uniquement avec le numéro.

Vous n'avez pas besoin d'utiliser | ou /. Le bot posera les questions une par une.`,
    de: `🎬 Printo Greeting Studio

Erstellen Sie personalisierte animierte Printo-Video-Grußkarten.

Wählen Sie den Anlass:
1 - Geburtstag
2 - Hochzeit
3 - Abschluss
4 - Jubiläum
5 - Weihnachten
6 - Geschäftlicher Gruß

Antworten Sie nur mit der Nummer.

Sie müssen | oder / nicht verwenden. Der Bot fragt Schritt für Schritt.`,
    pt: `🎬 Printo Greeting Studio

Crie cartões de vídeo animados personalizados com Printo.

Escolha a ocasião:
1 - Aniversário
2 - Casamento
3 - Formatura
4 - Comemoração
5 - Natal
6 - Saudação empresarial

Responda apenas com o número.

Você não precisa usar | ou /. O bot perguntará uma coisa de cada vez.`,
    ar: `🎬 Printo Greeting Studio

أنشئ بطاقات تهنئة فيديو متحركة ومخصصة مع Printo.

اختر المناسبة:
1 - عيد ميلاد
2 - زفاف
3 - تخرج
4 - ذكرى
5 - عيد الميلاد
6 - تهنئة أعمال

رد برقم المناسبة فقط.

لا تحتاج إلى استخدام | أو /. سيطرح البوت سؤالاً واحدًا في كل مرة.`,
    zh: `🎬 Printo Greeting Studio

创建个性化 Printo 动画视频贺卡。

请选择场合：
1 - 生日
2 - 婚礼
3 - 毕业
4 - 周年纪念
5 - 圣诞节
6 - 商务问候

请只回复编号。

不需要使用 | 或 /。机器人会一步一步询问。`
  });
}

function greetingQuestionText(language = "en", key = "recipient", spec = {}) {
  const occasion = spec.occasion || "Greeting";
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
  const occasionMap = {
    "1": { occasion: "Birthday", templateId: "birthday", packageType: "STANDARD" },
    "birthday": { occasion: "Birthday", templateId: "birthday", packageType: "STANDARD" },
    "birth day": { occasion: "Birthday", templateId: "birthday", packageType: "STANDARD" },
    "2": { occasion: "Wedding", templateId: "wedding", packageType: "STANDARD" },
    "wedding": { occasion: "Wedding", templateId: "wedding", packageType: "STANDARD" },
    "3": { occasion: "Graduation", templateId: "graduation", packageType: "STANDARD" },
    "graduation": { occasion: "Graduation", templateId: "graduation", packageType: "STANDARD" },
    "graduate": { occasion: "Graduation", templateId: "graduation", packageType: "STANDARD" },
    "4": { occasion: "Anniversary", templateId: "anniversary", packageType: "STANDARD" },
    "anniversary": { occasion: "Anniversary", templateId: "anniversary", packageType: "STANDARD" },
    "5": { occasion: "Christmas", templateId: "christmas", packageType: "STANDARD" },
    "christmas": { occasion: "Christmas", templateId: "christmas", packageType: "STANDARD" },
    "xmas": { occasion: "Christmas", templateId: "christmas", packageType: "STANDARD" },
    "6": { occasion: "Business", templateId: "business", packageType: "PREMIUM" },
    "business": { occasion: "Business", templateId: "business", packageType: "PREMIUM" },
    "business greeting": { occasion: "Business", templateId: "business", packageType: "PREMIUM" }
  };

  return occasionMap[value] || null;
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
  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `${req.protocol}://${req.get("host")}`;

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
      return `\n\n🎬 Video rendering is ready, but the master video is not uploaded yet.\n${renderResult.message}\n\nFor now, use the Greeting Order Portal link:\n${spec.downloadUrl || "Download link already created."}`;
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

    return `\n\n🎉 Your personalized Printo greeting video is ready!\n\n📥 Download MP4:\n${renderResult.downloadUrl}\n\n📱 You can share this video on WhatsApp, Facebook, Instagram, and TikTok.\n\nThank you for using Printo Greeting Studio.`;
  } catch (err) {
    console.error("Greeting MP4 render failed:", err.stderr || err.message);
    return `\n\n⚠️ The greeting order was received, but automatic MP4 rendering could not complete yet. A Printo team member will continue it.\n\nGreeting Order Portal:\n${spec.downloadUrl || "Download link already created."}`;
  }
}

function greetingPaymentPromptText(spec = {}) {
  return `✅ Your Printo Greeting Studio request has been received.

Occasion: ${spec.occasion || "Birthday"}
Recipient: ${spec.recipientName || ""}
Sender: ${spec.senderName || ""}

Message:
${spec.message || ""}

✅ Your Greeting Order Portal is ready:
${spec.downloadUrl || "Download link will be created shortly."}

Please choose payment method.

Reply with number only:

1 - Shopify Checkout (coming next)
2 - Africa Payment
3 - Continue with Agent

After payment, please send your payment receipt here on WhatsApp for confirmation.

To start over, type 39.`;
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
  const checkoutUrl =
    finalSpec.checkoutUrl ||
    buildGreetingCheckoutUrl(finalSpec.packageType || "STANDARD", 1);

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
    await safeAttach("Greeting Studio payment choice: Shopify Checkout selected by customer");

    if (checkoutUrl) {
      session.stage = "DONE";
      session.selectedService = null;
      const renderNote = await tryRenderGreetingVideoForWhatsApp(req, from, session, finalSpec);
      await sendMessage(
        from,
        `✅ Shopify Checkout selected.

Please complete payment here:
${checkoutUrl}

Your Greeting Order Portal:
${finalSpec.downloadUrl || "Download link already created."}

After payment, please send your payment receipt here on WhatsApp for confirmation.

A Printo team member will confirm the order and continue the greeting card video process.${renderNote}`
      );
      return true;
    }

    session.stage = "GREETING_PAYMENT";
    session.selectedService = "GREETING_CARD";
    await sendMessage(
      from,
      `✅ Shopify Checkout selected.

Shopify Greeting Studio checkout is coming next.

Your Greeting Order Portal:
${finalSpec.downloadUrl || "Download link already created."}

For now, please choose:

2 - Africa Payment
3 - Continue with Agent`
    );
    return true;
  }

  if (isGreetingAfricaChoice(choice)) {
    await safeAttach("Greeting Studio payment choice: Africa Payment selected by customer");

    session.stage = "DONE";
    session.selectedService = null;
    const renderNote = await tryRenderGreetingVideoForWhatsApp(req, from, session, finalSpec);
    await sendMessage(
      from,
      `✅ Africa Payment selected for Printo Greeting Studio.

Please complete payment here:
https://www.patapata.us/pages/africa-payment

After payment, please send your payment receipt here on WhatsApp for confirmation.

Your Greeting Order Portal:
${finalSpec.downloadUrl || "Download link already created."}

A Printo team member will confirm the order and continue the greeting card video process.${renderNote}`
    );
    return true;
  }

  if (isGreetingAgentChoice(choice)) {
    await safeAttach("Greeting Studio payment choice: Continue with Agent selected by customer");

    session.stage = "DONE";
    session.selectedService = null;
    const renderNote = await tryRenderGreetingVideoForWhatsApp(req, from, session, finalSpec);
    await sendMessage(
      from,
      `✅ Continue with Agent selected.

Your Greeting Order Portal:
${finalSpec.downloadUrl || "Download link already created."}

A Printo team member will review your Greeting Studio order and reply here shortly.${renderNote}`
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
  status = "pending"
}) {
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
${downloadUrl || "Not generated yet"}`;

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

    res.json({
      ok: true,
      greetingId: record.greetingId,
      job_id: job?.id || null,
      status: renderResult.ok ? "mp4_rendered" : "record_created_master_missing",
      template,
      downloadUrl: renderResult.ok ? renderResult.downloadUrl : record.downloadUrl,
      recordDownloadUrl: record.downloadUrl,
      videoDownloadUrl: renderResult.ok ? renderResult.downloadUrl : "",
      note: renderResult.ok ? "MP4 greeting video rendered." : renderResult.message
    });
  } catch (err) {
    console.error("Greeting Studio render error:", err.stderr || err.message || err);
    res.status(500).json({
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
    ["GREETING_STUDIO", "GREETING_OCCASION", "GREETING_RECIPIENT", "GREETING_SENDER", "GREETING_MESSAGE", "GREETING_PAYMENT"].includes(session.stage)
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
    const downloadRecord = createGreetingDownloadRecord(req, {
      templateId: spec.templateId || "birthday",
      occasion: spec.occasion || "Birthday",
      recipientName: spec.recipientName,
      senderName: spec.senderName,
      message: spec.message,
      language: session.language
    });

    const checkoutUrl = buildGreetingCheckoutUrl(spec.packageType || "STANDARD", 1);

    const finalSpec = {
      ...session.greetingSpec,
      ...spec,
      greetingId: downloadRecord.greetingId,
      templateId: downloadRecord.template.id,
      downloadUrl: downloadRecord.downloadUrl,
      generatedFileName: downloadRecord.fileName,
      checkoutUrl
    };

    const job = await createGreetingDashboardJob({
      templateId: finalSpec.templateId || "birthday",
      occasion: finalSpec.occasion || "Birthday",
      recipientName: finalSpec.recipientName,
      senderName: finalSpec.senderName,
      message: finalSpec.message,
      language: session.language,
      customerPhone: from,
      checkoutUrl,
      downloadUrl: finalSpec.downloadUrl,
      status: "pending"
    });

    session.greetingSpec = finalSpec;
    session.selectedService = "GREETING_CARD";
    session.lastServiceJobId = job?.id || null;
    session.stage = "GREETING_PAYMENT";
    await sendMessage(from, greetingPaymentPromptText(finalSpec));
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

  

app.get("/api/greeting/birthday/assets", (req, res) => {
  const base = path.join(__dirname, "templates", "birthday");

  res.json({
    frame: require("fs").existsSync(path.join(base, "frame.png")),
    printo: require("fs").existsSync(path.join(base, "printo.png")),
    master: require("fs").existsSync(path.join(base, "master.mp4")),
    folder: base
  });
});

 function buildGeneratedUrl(req, fileName) {
  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `${req.protocol}://${req.get("host")}`;

  return `${base}/generated/${encodeURIComponent(fileName)}`;
}

function safeGreetingText(value = "") {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\n/g, " ")
    .slice(0, 80);
}

app.post("/api/greeting/birthday/generate", async (req, res) => {
  try {
    console.log("Birthday generator request received:", req.body);
    const toName = safeGreetingText(req.body.to || "Mary");
    const fromName = safeGreetingText(req.body.from || "John");
    const message = safeGreetingText(req.body.message || "Wishing you happiness, laughter, and a wonderful celebration!");

    const birthdayDir = path.join(__dirname, "templates", "birthday");
    const framePath = path.join(birthdayDir, "frame.png");
    const masterPath = path.join(birthdayDir, "master.mp4");

    if (!fs.existsSync(framePath) || !fs.existsSync(masterPath)) {
      return res.status(400).json({ ok: false, error: "Birthday template assets missing." });
    }

    const fileName = `birthday_${Date.now()}.mp4`;
    const outputPath = path.join(generatedDir, fileName);

    const filter =
      `[0:v]scale=1536:1024[bg];` +
      `[1:v]scale=690:430:force_original_aspect_ratio=decrease,pad=690:430:(ow-iw)/2:(oh-ih)/2:black[vid];` +
      `[bg][vid]overlay=425:315,` +
      `drawtext=text='${toName}':x=115:y=275:fontsize=54:fontcolor=#d63384,` +
      `drawtext=text='${fromName}':x=1190:y=350:fontsize=48:fontcolor=#7b2cbf,` +
      `drawtext=text='${message}':x=105:y=565:fontsize=34:fontcolor=#3b1f8f:line_spacing=8[outv]`;

    execFile("ffmpeg", [
      "-y",
      "-loop", "1",
      "-i", framePath,
      "-i", masterPath,
      "-filter_complex", filter,
      "-map", "[outv]",
      "-map", "1:a?",
      "-shortest",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      outputPath
    ], (err) => {
      if (err) {
        console.error("Birthday render error:", err.message);
        return res.status(500).json({ ok: false, error: "Video render failed. FFmpeg may be missing on Render." });
      }

      res.json({
        ok: true,
        downloadUrl: buildGeneratedUrl(req, fileName),
        file: fileName
      });
    });
  } catch (err) {
    console.error("Birthday generate route error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/greeting-test", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Printo Birthday Generator Test</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: Arial; max-width: 600px; margin: 30px auto; padding: 20px; }
    input, textarea, button { width: 100%; padding: 12px; margin: 8px 0; font-size: 16px; }
    button { background: #6c2bd9; color: white; border: 0; border-radius: 8px; }
    a { display: block; margin-top: 20px; font-size: 18px; }
  </style>
</head>
<body>
  <h1>🎂 Printo Birthday Generator</h1>

  <input id="to" placeholder="Recipient name e.g. Mary" />
  <input id="from" placeholder="Sender name e.g. John" />
  <textarea id="message" placeholder="Birthday message">Wishing you happiness, laughter, and a wonderful celebration!</textarea>

  <button onclick="generate()">Generate Birthday Video</button>

  <p id="status"></p>
  <div id="result"></div>

<script>
async function generate() {
  document.getElementById("status").innerText = "Generating video... please wait.";
  document.getElementById("result").innerHTML = "";

  const res = await fetch("/api/greeting/birthday/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: document.getElementById("to").value || "Mary",
      from: document.getElementById("from").value || "John",
      message: document.getElementById("message").value
    })
  });

  const data = await res.json();

  if (!data.ok) {
    document.getElementById("status").innerText = "Failed: " + (data.error || "Unknown error");
    return;
  }

  document.getElementById("status").innerText = "Video ready!";
  document.getElementById("result").innerHTML =
    '<a href="' + data.downloadUrl + '" target="_blank">Download Birthday Video</a>';
}
</script>
</body>
</html>`);
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
