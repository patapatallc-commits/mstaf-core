// Printo Greeting Studio: multilingual cards, permanent customer identity,
// first greeting free, paid greeting credits, 24-character names,
// 220-character message, dynamic text sizing, and Android keyboard resize.
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  Linking,
  SafeAreaView,
  ScrollView,
  Animated,
  TextInput,
  ActivityIndicator,
  Share,
  Alert,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const PHONE = "18622306637";
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.patapata.printomatic";
const API_BASE_URL = "https://mstaf-core-1.onrender.com";
const PRINTO_STUDIO_WEB_URL = "https://www.patapata.us/";
const SHOPIFY_GREETING_URL =
  "https://www.patapata.us/cart/54144499581227:1";
const NIGERIA_PAYMENT_URL = "https://www.patapata.us/pages/africa-payment";
const CUSTOMER_ID_STORAGE_KEY = "@printo/greeting-customer-id";
const NAME_MAX = 24;
const MESSAGE_MAX = 220;

function createGreetingCustomerId() {
  const randomPart = Math.random().toString(36).slice(2, 12);
  return `printo_${Date.now()}_${randomPart}`;
}

const TEXT = {
  en: {
    name: "English",
    choose: "Choose your language",
    welcome: "Welcome to Printo Studio",
    subtitle: "Music • Videos • AI • Printing",
    explore: "🎵 Explore Printo Studio",
    studioTitle: "Printo Studio",
    tap: "Tap to continue ›",
    talk: "📲 Talk to Printo on WhatsApp",
    change: "Change Language",
    backToLanguage: "⬅ Back to Language Selection",
    powered: "Powered by Patapata LLC",
    scanTitle: "Scan to download our Google Play Store app",
    scanSub: "Open the Print-O-Matic app from Google Play.",
    playButton: "⬇️ Download from Google Play",
    agentMsg: "I want to talk to a Printo Studio agent.",
  },
  es: {
    name: "Español",
    choose: "Elige tu idioma",
    welcome: "Bienvenido a Printo Studio",
    subtitle: "Música • Videos • IA • Impresión",
    explore: "🎵 Explorar Printo Studio",
    studioTitle: "Printo Studio",
    tap: "Toca para continuar ›",
    talk: "📲 Hablar con Printo por WhatsApp",
    change: "Cambiar idioma",
    backToLanguage: "⬅ Volver a seleccionar idioma",
    powered: "Desarrollado por Patapata LLC",
    scanTitle: "Escanea para descargar nuestra app en Google Play",
    scanSub: "Abre la app Print-O-Matic desde Google Play.",
    playButton: "⬇️ Descargar desde Google Play",
    agentMsg: "Quiero hablar con un agente de Printo Studio.",
  },
  fr: {
    name: "Français",
    choose: "Choisissez votre langue",
    welcome: "Bienvenue à Printo Studio",
    subtitle: "Musique • Vidéos • IA • Impression",
    explore: "🎵 Découvrir Printo Studio",
    studioTitle: "Printo Studio",
    tap: "Touchez pour continuer ›",
    talk: "📲 Parler à Printo sur WhatsApp",
    change: "Changer de langue",
    backToLanguage: "⬅ Retour au choix de la langue",
    powered: "Propulsé par Patapata LLC",
    scanTitle: "Scannez pour télécharger notre application Google Play",
    scanSub: "Ouvrez l’application Print-O-Matic sur Google Play.",
    playButton: "⬇️ Télécharger sur Google Play",
    agentMsg: "Je veux parler à un agent Printo Studio.",
  },
  de: {
    name: "Deutsch",
    choose: "Sprache auswählen",
    welcome: "Willkommen bei Printo Studio",
    subtitle: "Musik • Videos • KI • Drucken",
    explore: "🎵 Printo Studio entdecken",
    studioTitle: "Printo Studio",
    tap: "Tippen zum Fortfahren ›",
    talk: "📲 Mit Printo auf WhatsApp sprechen",
    change: "Sprache ändern",
    backToLanguage: "⬅ Zur Sprachauswahl zurück",
    powered: "Bereitgestellt von Patapata LLC",
    scanTitle: "Scannen, um unsere Google Play Store App herunterzuladen",
    scanSub: "Öffne die Print-O-Matic App bei Google Play.",
    playButton: "⬇️ Aus Google Play herunterladen",
    agentMsg: "Ich möchte mit einem Printo Studio Agenten sprechen.",
  },
  pt: {
    name: "Português",
    choose: "Escolha seu idioma",
    welcome: "Bem-vindo ao Printo Studio",
    subtitle: "Música • Vídeos • IA • Impressão",
    explore: "🎵 Explorar Printo Studio",
    studioTitle: "Printo Studio",
    tap: "Toque para continuar ›",
    talk: "📲 Falar com Printo no WhatsApp",
    change: "Mudar idioma",
    backToLanguage: "⬅ Voltar para seleção de idioma",
    powered: "Desenvolvido por Patapata LLC",
    scanTitle: "Escaneie para baixar nosso app na Google Play Store",
    scanSub: "Abra o app Print-O-Matic na Google Play.",
    playButton: "⬇️ Baixar na Google Play",
    agentMsg: "Quero falar com um agente do Printo Studio.",
  },
  ar: {
    name: "العربية",
    choose: "اختر لغتك",
    welcome: "مرحبًا بك في استوديو برينتو",
    subtitle: "موسيقى • فيديوهات • ذكاء اصطناعي • طباعة",
    explore: "🎵 استكشف استوديو برينتو",
    studioTitle: "استوديو برينتو",
    tap: "اضغط للمتابعة ›",
    talk: "📲 تحدث مع برينتو على واتساب",
    change: "تغيير اللغة",
    backToLanguage: "⬅ الرجوع لاختيار اللغة",
    powered: "بدعم من Patapata LLC",
    scanTitle: "امسح لتنزيل تطبيقنا من متجر Google Play",
    scanSub: "افتح تطبيق Print-O-Matic من Google Play.",
    playButton: "⬇️ تنزيل من Google Play",
    agentMsg: "أريد التحدث مع وكيل Printo Studio.",
  },
  zh: {
    name: "中文",
    choose: "请选择语言",
    welcome: "欢迎来到 Printo Studio",
    subtitle: "音乐 • 视频 • AI • 打印",
    explore: "🎵 探索 Printo Studio",
    studioTitle: "Printo Studio",
    tap: "点击继续 ›",
    talk: "📲 在 WhatsApp 上联系 Printo",
    change: "更改语言",
    backToLanguage: "⬅ 返回语言选择",
    powered: "由 Patapata LLC 提供支持",
    scanTitle: "扫码下载我们的 Google Play 商店应用",
    scanSub: "从 Google Play 打开 Print-O-Matic 应用。",
    playButton: "⬇️ 从 Google Play 下载",
    agentMsg: "我想联系 Printo Studio 客服。",
  },
};

const SERVICES = {
  en: [
    {
      emoji: "🎵",
      title: "Buy Printo Music",
      sub: "Official songs, beats, instrumentals, and albums.",
      message: "I want to buy Printo music.",
    },
    {
      emoji: "🎂",
      title: "Greeting Video Cards",
      sub: "Birthday, wedding, anniversary, graduation, and special greetings.",
      message: "I want to order a Printo greeting video card.",
    },
    {
      emoji: "🎭",
      title: "Personalized Printo Videos",
      sub: "Printo speaks, sings, dances, and greets someone by name.",
      message: "I want a personalized Printo video.",
    },
    {
      emoji: "🎬",
      title: "AI Video Creation",
      sub: "Talking photos, dancing mascots, social media videos, and adverts.",
      message: "I want AI video creation service.",
    },
    {
      emoji: "🎤",
      title: "Music & Voice Studio",
      sub: "Songs, jingles, voice-overs, voice cloning, and sound effects.",
      message: "I want music or voice creation service.",
    },
    {
      emoji: "🛍️",
      title: "Digital Downloads",
      sub: "Templates, courses, flyers, eBooks, logos, and AI prompts.",
      message: "I want digital downloads.",
    },
    {
      emoji: "🖨️",
      title: "Print-O-Matic Services",
      sub: "Print documents, photos, cards, flyers, editing, and shipping.",
      message: "I want Print-O-Matic services.",
    },
  ],
  es: [
    {
      emoji: "🎵",
      title: "Comprar música de Printo",
      sub: "Canciones oficiales, ritmos, instrumentales y álbumes.",
      message: "Quiero comprar música de Printo.",
    },
    {
      emoji: "🎂",
      title: "Tarjetas de video de saludo",
      sub: "Cumpleaños, bodas, aniversarios, graduaciones y saludos especiales.",
      message: "Quiero ordenar una tarjeta de video de saludo de Printo.",
    },
    {
      emoji: "🎭",
      title: "Videos personalizados de Printo",
      sub: "Printo habla, canta, baila y saluda a alguien por su nombre.",
      message: "Quiero un video personalizado de Printo.",
    },
    {
      emoji: "🎬",
      title: "Creación de videos con IA",
      sub: "Fotos que hablan, mascotas bailando, videos para redes y anuncios.",
      message: "Quiero servicio de creación de video con IA.",
    },
    {
      emoji: "🎤",
      title: "Estudio de música y voz",
      sub: "Canciones, jingles, voces, clonación de voz y efectos de sonido.",
      message: "Quiero servicio de música o voz.",
    },
    {
      emoji: "🛍️",
      title: "Descargas digitales",
      sub: "Plantillas, cursos, flyers, eBooks, logos y prompts de IA.",
      message: "Quiero descargas digitales.",
    },
    {
      emoji: "🖨️",
      title: "Servicios Print-O-Matic",
      sub: "Impresión, fotos, tarjetas, flyers, edición y envío.",
      message: "Quiero servicios Print-O-Matic.",
    },
  ],
  fr: [
    {
      emoji: "🎵",
      title: "Acheter la musique Printo",
      sub: "Chansons, beats, instrumentaux et albums officiels.",
      message: "Je veux acheter de la musique Printo.",
    },
    {
      emoji: "🎂",
      title: "Cartes vidéo de vœux",
      sub: "Anniversaire, mariage, remise de diplôme et vœux spéciaux.",
      message: "Je veux commander une carte vidéo Printo.",
    },
    {
      emoji: "🎭",
      title: "Vidéos Printo personnalisées",
      sub: "Printo parle, chante, danse et salue quelqu’un par son nom.",
      message: "Je veux une vidéo Printo personnalisée.",
    },
    {
      emoji: "🎬",
      title: "Création vidéo IA",
      sub: "Photos parlantes, mascottes dansantes, vidéos sociales et publicités.",
      message: "Je veux un service de création vidéo IA.",
    },
    {
      emoji: "🎤",
      title: "Studio musique et voix",
      sub: "Chansons, jingles, voix off, clonage vocal et effets sonores.",
      message: "Je veux un service de musique ou de voix.",
    },
    {
      emoji: "🛍️",
      title: "Téléchargements numériques",
      sub: "Modèles, cours, flyers, eBooks, logos et prompts IA.",
      message: "Je veux des téléchargements numériques.",
    },
    {
      emoji: "🖨️",
      title: "Services Print-O-Matic",
      sub: "Documents, photos, cartes, flyers, édition et livraison.",
      message: "Je veux les services Print-O-Matic.",
    },
  ],
  de: [
    {
      emoji: "🎵",
      title: "Printo Musik kaufen",
      sub: "Offizielle Songs, Beats, Instrumentals und Alben.",
      message: "Ich möchte Printo Musik kaufen.",
    },
    {
      emoji: "🎂",
      title: "Grußvideo-Karten",
      sub: "Geburtstag, Hochzeit, Jahrestag, Abschluss und besondere Grüße.",
      message: "Ich möchte eine Printo Grußvideo-Karte bestellen.",
    },
    {
      emoji: "🎭",
      title: "Personalisierte Printo Videos",
      sub: "Printo spricht, singt, tanzt und grüßt jemanden mit Namen.",
      message: "Ich möchte ein personalisiertes Printo Video.",
    },
    {
      emoji: "🎬",
      title: "KI-Videoerstellung",
      sub: "Sprechende Fotos, tanzende Maskottchen, Social-Media-Videos und Werbung.",
      message: "Ich möchte KI-Videoerstellung.",
    },
    {
      emoji: "🎤",
      title: "Musik- & Sprachstudio",
      sub: "Songs, Jingles, Voice-over, Stimmklonen und Soundeffekte.",
      message: "Ich möchte Musik- oder Sprachservice.",
    },
    {
      emoji: "🛍️",
      title: "Digitale Downloads",
      sub: "Vorlagen, Kurse, Flyer, eBooks, Logos und KI-Prompts.",
      message: "Ich möchte digitale Downloads.",
    },
    {
      emoji: "🖨️",
      title: "Print-O-Matic Services",
      sub: "Dokumente, Fotos, Karten, Flyer, Bearbeitung und Versand.",
      message: "Ich möchte Print-O-Matic Services.",
    },
  ],
  pt: [
    {
      emoji: "🎵",
      title: "Comprar música Printo",
      sub: "Músicas oficiais, beats, instrumentais e álbuns.",
      message: "Quero comprar música Printo.",
    },
    {
      emoji: "🎂",
      title: "Cartões de vídeo de saudação",
      sub: "Aniversário, casamento, formatura e mensagens especiais.",
      message: "Quero pedir um cartão de vídeo Printo.",
    },
    {
      emoji: "🎭",
      title: "Vídeos Printo personalizados",
      sub: "Printo fala, canta, dança e cumprimenta alguém pelo nome.",
      message: "Quero um vídeo Printo personalizado.",
    },
    {
      emoji: "🎬",
      title: "Criação de vídeo com IA",
      sub: "Fotos falantes, mascotes dançando, vídeos sociais e anúncios.",
      message: "Quero serviço de criação de vídeo com IA.",
    },
    {
      emoji: "🎤",
      title: "Estúdio de música e voz",
      sub: "Músicas, jingles, narração, clonagem de voz e efeitos sonoros.",
      message: "Quero serviço de música ou voz.",
    },
    {
      emoji: "🛍️",
      title: "Downloads digitais",
      sub: "Modelos, cursos, flyers, eBooks, logos e prompts de IA.",
      message: "Quero downloads digitais.",
    },
    {
      emoji: "🖨️",
      title: "Serviços Print-O-Matic",
      sub: "Documentos, fotos, cartões, flyers, edição e envio.",
      message: "Quero serviços Print-O-Matic.",
    },
  ],
  ar: [
    {
      emoji: "🎵",
      title: "شراء موسيقى برينتو",
      sub: "أغانٍ رسمية وإيقاعات وموسيقى وألبومات.",
      message: "أريد شراء موسيقى Printo.",
    },
    {
      emoji: "🎂",
      title: "بطاقات فيديو للتهنئة",
      sub: "عيد ميلاد، زفاف، تخرج، ذكرى ومناسبات خاصة.",
      message: "أريد طلب بطاقة فيديو تهنئة من Printo.",
    },
    {
      emoji: "🎭",
      title: "فيديوهات برينتو مخصصة",
      sub: "برينتو يتحدث ويغني ويرقص ويحيي الشخص بالاسم.",
      message: "أريد فيديو Printo مخصصًا.",
    },
    {
      emoji: "🎬",
      title: "إنشاء فيديو بالذكاء الاصطناعي",
      sub: "صور ناطقة، شخصيات راقصة، فيديوهات للسوشيال وإعلانات.",
      message: "أريد خدمة إنشاء فيديو بالذكاء الاصطناعي.",
    },
    {
      emoji: "🎤",
      title: "استوديو الموسيقى والصوت",
      sub: "أغانٍ، إعلانات صوتية، تعليق صوتي، استنساخ صوتي ومؤثرات.",
      message: "أريد خدمة موسيقى أو صوت.",
    },
    {
      emoji: "🛍️",
      title: "تنزيلات رقمية",
      sub: "قوالب، دورات، منشورات، كتب إلكترونية، شعارات وبرومبتات.",
      message: "أريد تنزيلات رقمية.",
    },
    {
      emoji: "🖨️",
      title: "خدمات Print-O-Matic",
      sub: "طباعة مستندات وصور وبطاقات ومنشورات وتعديل وشحن.",
      message: "أريد خدمات Print-O-Matic.",
    },
  ],
  zh: [
    {
      emoji: "🎵",
      title: "购买 Printo 音乐",
      sub: "官方歌曲、节拍、伴奏和专辑。",
      message: "我想购买 Printo 音乐。",
    },
    {
      emoji: "🎂",
      title: "祝福视频卡",
      sub: "生日、婚礼、周年、毕业和特别祝福。",
      message: "我想订购 Printo 祝福视频卡。",
    },
    {
      emoji: "🎭",
      title: "个性化 Printo 视频",
      sub: "Printo 可以说话、唱歌、跳舞，并按名字问候。",
      message: "我想要个性化 Printo 视频。",
    },
    {
      emoji: "🎬",
      title: "AI 视频制作",
      sub: "会说话的照片、跳舞吉祥物、社交媒体视频和广告。",
      message: "我想要 AI 视频制作服务。",
    },
    {
      emoji: "🎤",
      title: "音乐与语音工作室",
      sub: "歌曲、广告歌、配音、声音克隆和音效。",
      message: "我想要音乐或语音制作服务。",
    },
    {
      emoji: "🛍️",
      title: "数字下载",
      sub: "模板、课程、传单、电子书、标志和 AI 提示词。",
      message: "我想要数字下载。",
    },
    {
      emoji: "🖨️",
      title: "Print-O-Matic 服务",
      sub: "打印文件、照片、卡片、传单、编辑和配送。",
      message: "我想要 Print-O-Matic 服务。",
    },
  ],
};

type GreetingCardId =
  | "birthday"
  | "anniversary"
  | "wedding"
  | "engagement"
  | "new-baby"
  | "baby-shower"
  | "child-dedication"
  | "graduation"
  | "housewarming"
  | "new-job-promotion"
  | "congratulations"
  | "get-well"
  | "sympathy-condolence"
  | "retirement"
  | "christmas"
  | "new-year"
  | "easter"
  | "islamic"
  | "thanksgiving"
  | "mothers-day"
  | "fathers-day"
  | "valentines-day"
  | "business-greeting"
  | "grand-opening"
  | "employee-appreciation"
  | "award-achievement"
  | "cultural-festival";

type GreetingCard = {
  id: GreetingCardId;
  emoji: string;
  title: string;
  sub: string;
};

const GREETING_CARD_BASE: Array<Pick<GreetingCard, "id" | "emoji">> = [
  { id: "birthday", emoji: "🎂" },
  { id: "anniversary", emoji: "❤️" },
  { id: "wedding", emoji: "💍" },
  { id: "engagement", emoji: "💎" },
  { id: "new-baby", emoji: "👶" },
  { id: "baby-shower", emoji: "🍼" },
  { id: "child-dedication", emoji: "🙏" },
  { id: "graduation", emoji: "🎓" },
  { id: "housewarming", emoji: "🏡" },
  { id: "new-job-promotion", emoji: "💼" },
  { id: "congratulations", emoji: "🎉" },
  { id: "get-well", emoji: "🙏" },
  { id: "sympathy-condolence", emoji: "🌹" },
  { id: "retirement", emoji: "🎊" },
  { id: "christmas", emoji: "🎄" },
  { id: "new-year", emoji: "🎆" },
  { id: "easter", emoji: "🐣" },
  { id: "islamic", emoji: "☪️" },
  { id: "thanksgiving", emoji: "🦃" },
  { id: "mothers-day", emoji: "🌸" },
  { id: "fathers-day", emoji: "👔" },
  { id: "valentines-day", emoji: "💖" },
  { id: "business-greeting", emoji: "💼" },
  { id: "grand-opening", emoji: "📣" },
  { id: "employee-appreciation", emoji: "🏆" },
  { id: "award-achievement", emoji: "🏅" },
  { id: "cultural-festival", emoji: "🥁" },
];

const GREETING_CARD_TEXT: Record<
  string,
  Record<GreetingCardId, { title: string; sub: string }>
> = {
  "en": {
    "birthday": {
      "title": "Birthday Video Card",
      "sub": "A joyful Printo birthday greeting with music and celebration."
    },
    "anniversary": {
      "title": "Anniversary Video Card",
      "sub": "A warm anniversary greeting filled with love and celebration."
    },
    "wedding": {
      "title": "Wedding Video Card",
      "sub": "A beautiful Printo wedding greeting for the happy couple."
    },
    "engagement": {
      "title": "Engagement Video Card",
      "sub": "Celebrate a special engagement with love and excitement."
    },
    "new-baby": {
      "title": "New Baby Video Card",
      "sub": "A sweet welcome greeting for a newborn baby and family."
    },
    "baby-shower": {
      "title": "Baby Shower Video Card",
      "sub": "Celebrate the coming baby with a joyful Printo greeting."
    },
    "child-dedication": {
      "title": "Child Dedication Video Card",
      "sub": "A meaningful greeting for a child dedication celebration."
    },
    "graduation": {
      "title": "Graduation Video Card",
      "sub": "Celebrate achievement with a proud Printo graduation message."
    },
    "housewarming": {
      "title": "Housewarming Video Card",
      "sub": "Send warm wishes for a beautiful new home."
    },
    "new-job-promotion": {
      "title": "New Job / Promotion Video Card",
      "sub": "Celebrate a new job, promotion, or career achievement."
    },
    "congratulations": {
      "title": "Congratulations Video Card",
      "sub": "Send a bright congratulatory message for any achievement."
    },
    "get-well": {
      "title": "Get Well Soon Video Card",
      "sub": "A caring Printo message of hope, comfort, and encouragement."
    },
    "sympathy-condolence": {
      "title": "Sympathy / Condolence Video Card",
      "sub": "Share a respectful message of comfort and support."
    },
    "retirement": {
      "title": "Retirement Video Card",
      "sub": "Celebrate years of service and a wonderful new chapter."
    },
    "christmas": {
      "title": "Christmas Video Card",
      "sub": "A festive Christmas greeting with Printo music and holiday joy."
    },
    "new-year": {
      "title": "New Year Video Card",
      "sub": "Send happiness, success, and good wishes for the new year."
    },
    "easter": {
      "title": "Easter Video Card",
      "sub": "A bright and joyful Printo Easter celebration greeting."
    },
    "islamic": {
      "title": "Islamic Celebration (Eid) Video Card",
      "sub": "A respectful greeting for Eid and other Islamic celebrations."
    },
    "thanksgiving": {
      "title": "Thanksgiving Video Card",
      "sub": "A grateful greeting for family, friends, and loved ones."
    },
    "mothers-day": {
      "title": "Mother's Day Video Card",
      "sub": "A loving greeting to honor and celebrate mothers everywhere."
    },
    "fathers-day": {
      "title": "Father's Day Video Card",
      "sub": "A special greeting to celebrate fathers and father figures."
    },
    "valentines-day": {
      "title": "Valentine's Day Video Card",
      "sub": "Share love with a romantic and heartfelt Printo greeting."
    },
    "business-greeting": {
      "title": "Business Greeting Video Card",
      "sub": "A polished greeting for clients, partners, and business teams."
    },
    "grand-opening": {
      "title": "Grand Opening Video Card",
      "sub": "Celebrate a new business, office, or store opening."
    },
    "employee-appreciation": {
      "title": "Employee Appreciation Video Card",
      "sub": "Thank employees and team members for their contribution."
    },
    "award-achievement": {
      "title": "Award & Achievement Video Card",
      "sub": "Honor an award, milestone, or outstanding achievement."
    },
    "cultural-festival": {
      "title": "Cultural Festival Video Card",
      "sub": "Celebrate cultural traditions, festivals, and community joy."
    }
  },
  "es": {
    "birthday": {
      "title": "Tarjeta de video de cumpleaños",
      "sub": "Un alegre saludo de cumpleaños de Printo con música y celebración."
    },
    "anniversary": {
      "title": "Tarjeta de video de aniversario",
      "sub": "Un cálido saludo de aniversario lleno de amor y celebración."
    },
    "wedding": {
      "title": "Tarjeta de video de boda",
      "sub": "Un hermoso saludo de boda de Printo para la feliz pareja."
    },
    "engagement": {
      "title": "Tarjeta de video de compromiso",
      "sub": "Celebra un compromiso especial con amor y emoción."
    },
    "new-baby": {
      "title": "Tarjeta de video para nuevo bebé",
      "sub": "Una dulce bienvenida para el bebé y su familia."
    },
    "baby-shower": {
      "title": "Tarjeta de video para baby shower",
      "sub": "Celebra la llegada del bebé con un alegre saludo de Printo."
    },
    "child-dedication": {
      "title": "Tarjeta de video de dedicación infantil",
      "sub": "Un saludo especial para una celebración de dedicación infantil."
    },
    "graduation": {
      "title": "Tarjeta de video de graduación",
      "sub": "Celebra este logro con un orgulloso mensaje de graduación."
    },
    "housewarming": {
      "title": "Tarjeta de video de casa nueva",
      "sub": "Envía buenos deseos para un hermoso nuevo hogar."
    },
    "new-job-promotion": {
      "title": "Tarjeta de video de nuevo empleo / ascenso",
      "sub": "Celebra un nuevo trabajo, ascenso o logro profesional."
    },
    "congratulations": {
      "title": "Tarjeta de video de felicitaciones",
      "sub": "Envía un alegre mensaje de felicitación por cualquier logro."
    },
    "get-well": {
      "title": "Tarjeta de video de pronta recuperación",
      "sub": "Un mensaje de esperanza, consuelo y ánimo."
    },
    "sympathy-condolence": {
      "title": "Tarjeta de video de condolencias",
      "sub": "Comparte un mensaje respetuoso de consuelo y apoyo."
    },
    "retirement": {
      "title": "Tarjeta de video de jubilación",
      "sub": "Celebra los años de servicio y una nueva etapa."
    },
    "christmas": {
      "title": "Tarjeta de video de Navidad",
      "sub": "Un saludo navideño con música de Printo y alegría."
    },
    "new-year": {
      "title": "Tarjeta de video de Año Nuevo",
      "sub": "Envía felicidad, éxito y buenos deseos para el nuevo año."
    },
    "easter": {
      "title": "Tarjeta de video de Pascua",
      "sub": "Un saludo alegre para celebrar la Pascua con Printo."
    },
    "islamic": {
      "title": "Tarjeta de video para celebración islámica (Eid)",
      "sub": "Un saludo respetuoso para Eid y otras celebraciones islámicas."
    },
    "thanksgiving": {
      "title": "Tarjeta de video de Acción de Gracias",
      "sub": "Un saludo de gratitud para familiares, amigos y seres queridos."
    },
    "mothers-day": {
      "title": "Tarjeta de video del Día de la Madre",
      "sub": "Un saludo lleno de amor para honrar a las madres."
    },
    "fathers-day": {
      "title": "Tarjeta de video del Día del Padre",
      "sub": "Un saludo especial para celebrar a los padres."
    },
    "valentines-day": {
      "title": "Tarjeta de video de San Valentín",
      "sub": "Comparte amor con un saludo romántico y sincero."
    },
    "business-greeting": {
      "title": "Tarjeta de saludo empresarial",
      "sub": "Un saludo profesional para clientes, socios y equipos."
    },
    "grand-opening": {
      "title": "Tarjeta de video de gran inauguración",
      "sub": "Celebra la apertura de un negocio, oficina o tienda."
    },
    "employee-appreciation": {
      "title": "Tarjeta de agradecimiento al empleado",
      "sub": "Agradece a empleados y equipos por su contribución."
    },
    "award-achievement": {
      "title": "Tarjeta de premio y logro",
      "sub": "Honra un premio, meta o logro destacado."
    },
    "cultural-festival": {
      "title": "Tarjeta de festival cultural",
      "sub": "Celebra tradiciones, festivales y alegría comunitaria."
    }
  },
  "fr": {
    "birthday": {
      "title": "Carte vidéo d'anniversaire",
      "sub": "Un joyeux message Printo avec musique et célébration."
    },
    "anniversary": {
      "title": "Carte vidéo d'anniversaire de mariage",
      "sub": "Un message chaleureux rempli d’amour et de célébration."
    },
    "wedding": {
      "title": "Carte vidéo de mariage",
      "sub": "Un magnifique message Printo pour les jeunes mariés."
    },
    "engagement": {
      "title": "Carte vidéo de fiançailles",
      "sub": "Célébrez des fiançailles avec amour et enthousiasme."
    },
    "new-baby": {
      "title": "Carte vidéo pour nouveau-né",
      "sub": "Un doux message de bienvenue pour le bébé et sa famille."
    },
    "baby-shower": {
      "title": "Carte vidéo de baby shower",
      "sub": "Célébrez l’arrivée du bébé avec un joyeux message Printo."
    },
    "child-dedication": {
      "title": "Carte vidéo de dédicace d'enfant",
      "sub": "Un message significatif pour une cérémonie de dédicace."
    },
    "graduation": {
      "title": "Carte vidéo de remise de diplôme",
      "sub": "Célébrez la réussite avec un fier message Printo."
    },
    "housewarming": {
      "title": "Carte vidéo de pendaison de crémaillère",
      "sub": "Envoyez de chaleureux vœux pour une nouvelle maison."
    },
    "new-job-promotion": {
      "title": "Carte vidéo nouvel emploi / promotion",
      "sub": "Célébrez un nouvel emploi, une promotion ou une réussite."
    },
    "congratulations": {
      "title": "Carte vidéo de félicitations",
      "sub": "Envoyez un message joyeux pour toute réussite."
    },
    "get-well": {
      "title": "Carte vidéo de bon rétablissement",
      "sub": "Un message attentionné d’espoir et de réconfort."
    },
    "sympathy-condolence": {
      "title": "Carte vidéo de condoléances",
      "sub": "Partagez un message respectueux de soutien et de réconfort."
    },
    "retirement": {
      "title": "Carte vidéo de retraite",
      "sub": "Célébrez les années de service et un nouveau chapitre."
    },
    "christmas": {
      "title": "Carte vidéo de Noël",
      "sub": "Un message festif avec musique Printo et joie de Noël."
    },
    "new-year": {
      "title": "Carte vidéo du Nouvel An",
      "sub": "Envoyez bonheur, réussite et meilleurs vœux."
    },
    "easter": {
      "title": "Carte vidéo de Pâques",
      "sub": "Un message lumineux et joyeux pour célébrer Pâques."
    },
    "islamic": {
      "title": "Carte vidéo de célébration islamique (Aïd)",
      "sub": "Un message respectueux pour l’Aïd et les fêtes islamiques."
    },
    "thanksgiving": {
      "title": "Carte vidéo de Thanksgiving",
      "sub": "Un message reconnaissant pour la famille et les proches."
    },
    "mothers-day": {
      "title": "Carte vidéo de la fête des Mères",
      "sub": "Un message plein d’amour pour célébrer les mamans."
    },
    "fathers-day": {
      "title": "Carte vidéo de la fête des Pères",
      "sub": "Un message spécial pour célébrer les pères."
    },
    "valentines-day": {
      "title": "Carte vidéo de la Saint-Valentin",
      "sub": "Partagez votre amour avec un message romantique."
    },
    "business-greeting": {
      "title": "Carte vidéo de vœux professionnels",
      "sub": "Un message professionnel pour clients, partenaires et équipes."
    },
    "grand-opening": {
      "title": "Carte vidéo de grande ouverture",
      "sub": "Célébrez l’ouverture d’une entreprise, boutique ou bureau."
    },
    "employee-appreciation": {
      "title": "Carte vidéo d'appréciation des employés",
      "sub": "Remerciez les employés et les équipes pour leur contribution."
    },
    "award-achievement": {
      "title": "Carte vidéo prix et réussite",
      "sub": "Honorez un prix, une étape ou une réussite exceptionnelle."
    },
    "cultural-festival": {
      "title": "Carte vidéo de festival culturel",
      "sub": "Célébrez les traditions, festivals et la joie communautaire."
    }
  },
  "de": {
    "birthday": {
      "title": "Geburtstags-Videokarte",
      "sub": "Ein fröhlicher Printo-Geburtstagsgruß mit Musik und Feier."
    },
    "anniversary": {
      "title": "Jubiläums-Videokarte",
      "sub": "Ein herzlicher Jubiläumsgruß voller Liebe und Freude."
    },
    "wedding": {
      "title": "Hochzeits-Videokarte",
      "sub": "Ein wunderschöner Hochzeitsgruß für das glückliche Paar."
    },
    "engagement": {
      "title": "Verlobungs-Videokarte",
      "sub": "Feiern Sie eine besondere Verlobung mit Liebe und Freude."
    },
    "new-baby": {
      "title": "Videokarte zur Geburt",
      "sub": "Ein liebevoller Willkommensgruß für Baby und Familie."
    },
    "baby-shower": {
      "title": "Babyshower-Videokarte",
      "sub": "Feiern Sie das kommende Baby mit einem fröhlichen Gruß."
    },
    "child-dedication": {
      "title": "Videokarte zur Kindersegnung",
      "sub": "Ein bedeutungsvoller Gruß zur Kindersegnung."
    },
    "graduation": {
      "title": "Abschluss-Videokarte",
      "sub": "Feiern Sie den Erfolg mit einer stolzen Glückwunschbotschaft."
    },
    "housewarming": {
      "title": "Einweihungs-Videokarte",
      "sub": "Senden Sie herzliche Wünsche für das neue Zuhause."
    },
    "new-job-promotion": {
      "title": "Videokarte neuer Job / Beförderung",
      "sub": "Feiern Sie einen neuen Job oder beruflichen Erfolg."
    },
    "congratulations": {
      "title": "Glückwunsch-Videokarte",
      "sub": "Senden Sie eine fröhliche Botschaft zu jedem Erfolg."
    },
    "get-well": {
      "title": "Gute-Besserung-Videokarte",
      "sub": "Eine fürsorgliche Botschaft mit Hoffnung und Trost."
    },
    "sympathy-condolence": {
      "title": "Beileids-Videokarte",
      "sub": "Teilen Sie eine respektvolle Botschaft von Trost und Unterstützung."
    },
    "retirement": {
      "title": "Ruhestands-Videokarte",
      "sub": "Feiern Sie viele Dienstjahre und einen neuen Lebensabschnitt."
    },
    "christmas": {
      "title": "Weihnachts-Videokarte",
      "sub": "Ein festlicher Gruß mit Printo-Musik und Weihnachtsfreude."
    },
    "new-year": {
      "title": "Neujahrs-Videokarte",
      "sub": "Senden Sie Glück, Erfolg und gute Wünsche."
    },
    "easter": {
      "title": "Oster-Videokarte",
      "sub": "Ein heller und fröhlicher Printo-Ostergruß."
    },
    "islamic": {
      "title": "Videokarte für islamische Feste (Eid)",
      "sub": "Ein respektvoller Gruß zu Eid und anderen Festen."
    },
    "thanksgiving": {
      "title": "Thanksgiving-Videokarte",
      "sub": "Ein dankbarer Gruß für Familie, Freunde und Geliebte."
    },
    "mothers-day": {
      "title": "Muttertags-Videokarte",
      "sub": "Ein liebevoller Gruß, um Mütter zu ehren."
    },
    "fathers-day": {
      "title": "Vatertags-Videokarte",
      "sub": "Ein besonderer Gruß für Väter und Vaterfiguren."
    },
    "valentines-day": {
      "title": "Valentinstags-Videokarte",
      "sub": "Teilen Sie Liebe mit einem romantischen Gruß."
    },
    "business-greeting": {
      "title": "Geschäftsgruß-Videokarte",
      "sub": "Ein professioneller Gruß für Kunden, Partner und Teams."
    },
    "grand-opening": {
      "title": "Eröffnungs-Videokarte",
      "sub": "Feiern Sie die Eröffnung eines Geschäfts oder Büros."
    },
    "employee-appreciation": {
      "title": "Mitarbeiteranerkennungs-Videokarte",
      "sub": "Danken Sie Mitarbeitern und Teams für ihren Beitrag."
    },
    "award-achievement": {
      "title": "Auszeichnung-und-Erfolg-Videokarte",
      "sub": "Würdigen Sie einen Preis, Meilenstein oder besonderen Erfolg."
    },
    "cultural-festival": {
      "title": "Kulturfestival-Videokarte",
      "sub": "Feiern Sie Traditionen, Festivals und Gemeinschaft."
    }
  },
  "pt": {
    "birthday": {
      "title": "Cartão de vídeo de aniversário",
      "sub": "Uma alegre saudação Printo com música e celebração."
    },
    "anniversary": {
      "title": "Cartão de vídeo de aniversário de casamento",
      "sub": "Uma saudação calorosa cheia de amor e celebração."
    },
    "wedding": {
      "title": "Cartão de vídeo de casamento",
      "sub": "Uma linda saudação Printo para o casal feliz."
    },
    "engagement": {
      "title": "Cartão de vídeo de noivado",
      "sub": "Celebre um noivado especial com amor e alegria."
    },
    "new-baby": {
      "title": "Cartão de vídeo para novo bebê",
      "sub": "Uma doce boas-vindas para o bebê e a família."
    },
    "baby-shower": {
      "title": "Cartão de vídeo de chá de bebê",
      "sub": "Celebre a chegada do bebê com uma saudação alegre."
    },
    "child-dedication": {
      "title": "Cartão de vídeo de dedicação infantil",
      "sub": "Uma mensagem especial para a dedicação da criança."
    },
    "graduation": {
      "title": "Cartão de vídeo de formatura",
      "sub": "Celebre a conquista com uma mensagem orgulhosa."
    },
    "housewarming": {
      "title": "Cartão de vídeo de casa nova",
      "sub": "Envie bons desejos para um novo lar."
    },
    "new-job-promotion": {
      "title": "Cartão de vídeo de novo emprego / promoção",
      "sub": "Celebre um novo trabalho, promoção ou conquista profissional."
    },
    "congratulations": {
      "title": "Cartão de vídeo de parabéns",
      "sub": "Envie uma mensagem alegre por qualquer conquista."
    },
    "get-well": {
      "title": "Cartão de vídeo de melhoras",
      "sub": "Uma mensagem carinhosa com esperança e conforto."
    },
    "sympathy-condolence": {
      "title": "Cartão de vídeo de condolências",
      "sub": "Compartilhe uma mensagem respeitosa de apoio e conforto."
    },
    "retirement": {
      "title": "Cartão de vídeo de aposentadoria",
      "sub": "Celebre anos de serviço e uma nova fase."
    },
    "christmas": {
      "title": "Cartão de vídeo de Natal",
      "sub": "Uma saudação festiva com música Printo e alegria."
    },
    "new-year": {
      "title": "Cartão de vídeo de Ano Novo",
      "sub": "Envie felicidade, sucesso e bons desejos."
    },
    "easter": {
      "title": "Cartão de vídeo de Páscoa",
      "sub": "Uma saudação alegre para celebrar a Páscoa."
    },
    "islamic": {
      "title": "Cartão de vídeo para celebração islâmica (Eid)",
      "sub": "Uma saudação respeitosa para o Eid e outras celebrações."
    },
    "thanksgiving": {
      "title": "Cartão de vídeo de Ação de Graças",
      "sub": "Uma mensagem de gratidão para familiares e amigos."
    },
    "mothers-day": {
      "title": "Cartão de vídeo do Dia das Mães",
      "sub": "Uma saudação amorosa para celebrar as mães."
    },
    "fathers-day": {
      "title": "Cartão de vídeo do Dia dos Pais",
      "sub": "Uma saudação especial para celebrar os pais."
    },
    "valentines-day": {
      "title": "Cartão de vídeo do Dia dos Namorados",
      "sub": "Compartilhe amor com uma mensagem romântica."
    },
    "business-greeting": {
      "title": "Cartão de saudação empresarial",
      "sub": "Uma saudação profissional para clientes, parceiros e equipes."
    },
    "grand-opening": {
      "title": "Cartão de vídeo de grande inauguração",
      "sub": "Celebre a abertura de uma empresa, loja ou escritório."
    },
    "employee-appreciation": {
      "title": "Cartão de agradecimento ao funcionário",
      "sub": "Agradeça funcionários e equipes pela contribuição."
    },
    "award-achievement": {
      "title": "Cartão de prêmio e conquista",
      "sub": "Homenageie um prêmio, marco ou grande conquista."
    },
    "cultural-festival": {
      "title": "Cartão de festival cultural",
      "sub": "Celebre tradições, festivais e alegria comunitária."
    }
  },
  "ar": {
    "birthday": {
      "title": "بطاقة فيديو لعيد الميلاد",
      "sub": "تهنئة مبهجة من برينتو مع الموسيقى والاحتفال."
    },
    "anniversary": {
      "title": "بطاقة فيديو للذكرى السنوية",
      "sub": "تهنئة دافئة مليئة بالحب والاحتفال."
    },
    "wedding": {
      "title": "بطاقة فيديو للزفاف",
      "sub": "تهنئة زفاف جميلة للعروسين السعيدين."
    },
    "engagement": {
      "title": "بطاقة فيديو للخطوبة",
      "sub": "احتفل بخطوبة مميزة بالحب والفرح."
    },
    "new-baby": {
      "title": "بطاقة فيديو للمولود الجديد",
      "sub": "تهنئة ترحيبية لطيفة للمولود والعائلة."
    },
    "baby-shower": {
      "title": "بطاقة فيديو لحفل استقبال المولود",
      "sub": "احتفل بقدوم المولود برسالة مبهجة."
    },
    "child-dedication": {
      "title": "بطاقة فيديو لتكريس الطفل",
      "sub": "رسالة مميزة لمناسبة تكريس الطفل."
    },
    "graduation": {
      "title": "بطاقة فيديو للتخرج",
      "sub": "احتفل بالإنجاز مع رسالة تخرج فخورة."
    },
    "housewarming": {
      "title": "بطاقة فيديو للمنزل الجديد",
      "sub": "أرسل أطيب الأمنيات للمنزل الجديد."
    },
    "new-job-promotion": {
      "title": "بطاقة فيديو لوظيفة جديدة / ترقية",
      "sub": "احتفل بوظيفة جديدة أو ترقية أو إنجاز مهني."
    },
    "congratulations": {
      "title": "بطاقة فيديو للتهنئة",
      "sub": "أرسل رسالة تهنئة مبهجة لأي إنجاز."
    },
    "get-well": {
      "title": "بطاقة فيديو للشفاء العاجل",
      "sub": "رسالة محبة تحمل الأمل والراحة والتشجيع."
    },
    "sympathy-condolence": {
      "title": "بطاقة فيديو للتعزية",
      "sub": "شارك رسالة محترمة من الراحة والدعم."
    },
    "retirement": {
      "title": "بطاقة فيديو للتقاعد",
      "sub": "احتفل بسنوات الخدمة وبداية مرحلة جديدة."
    },
    "christmas": {
      "title": "بطاقة فيديو لعيد الميلاد المجيد",
      "sub": "تهنئة احتفالية مع موسيقى برينتو وفرحة العيد."
    },
    "new-year": {
      "title": "بطاقة فيديو للعام الجديد",
      "sub": "أرسل السعادة والنجاح وأطيب الأمنيات."
    },
    "easter": {
      "title": "بطاقة فيديو لعيد الفصح",
      "sub": "تهنئة مشرقة ومبهجة للاحتفال بعيد الفصح."
    },
    "islamic": {
      "title": "بطاقة فيديو للمناسبات الإسلامية (العيد)",
      "sub": "تهنئة محترمة للعيد والمناسبات الإسلامية الأخرى."
    },
    "thanksgiving": {
      "title": "بطاقة فيديو لعيد الشكر",
      "sub": "رسالة امتنان للعائلة والأصدقاء والأحبة."
    },
    "mothers-day": {
      "title": "بطاقة فيديو لعيد الأم",
      "sub": "تهنئة مليئة بالحب للاحتفال بالأمهات."
    },
    "fathers-day": {
      "title": "بطاقة فيديو لعيد الأب",
      "sub": "تهنئة خاصة للاحتفال بالآباء."
    },
    "valentines-day": {
      "title": "بطاقة فيديو لعيد الحب",
      "sub": "شارك الحب برسالة رومانسية وصادقة."
    },
    "business-greeting": {
      "title": "بطاقة فيديو لتحية الأعمال",
      "sub": "تحية مهنية للعملاء والشركاء وفرق العمل."
    },
    "grand-opening": {
      "title": "بطاقة فيديو للافتتاح الكبير",
      "sub": "احتفل بافتتاح شركة أو متجر أو مكتب جديد."
    },
    "employee-appreciation": {
      "title": "بطاقة فيديو لتقدير الموظفين",
      "sub": "اشكر الموظفين وفرق العمل على مساهمتهم."
    },
    "award-achievement": {
      "title": "بطاقة فيديو للجوائز والإنجازات",
      "sub": "كرّم جائزة أو إنجازًا أو مرحلة مميزة."
    },
    "cultural-festival": {
      "title": "بطاقة فيديو للمهرجان الثقافي",
      "sub": "احتفل بالتقاليد والمهرجانات وفرحة المجتمع."
    }
  },
  "zh": {
    "birthday": {
      "title": "生日视频贺卡",
      "sub": "带有音乐和庆祝气氛的欢乐 Printo 生日祝福。"
    },
    "anniversary": {
      "title": "纪念日视频贺卡",
      "sub": "充满爱与庆祝气氛的温馨纪念日祝福。"
    },
    "wedding": {
      "title": "婚礼视频贺卡",
      "sub": "送给幸福新人的精美 Printo 婚礼祝福。"
    },
    "engagement": {
      "title": "订婚视频贺卡",
      "sub": "用爱与喜悦庆祝特别的订婚时刻。"
    },
    "new-baby": {
      "title": "新生儿视频贺卡",
      "sub": "送给新生儿和家人的甜蜜欢迎祝福。"
    },
    "baby-shower": {
      "title": "宝宝派对视频贺卡",
      "sub": "用欢乐的 Printo 祝福庆祝宝宝即将到来。"
    },
    "child-dedication": {
      "title": "儿童奉献礼视频贺卡",
      "sub": "适合儿童奉献礼庆典的温馨祝福。"
    },
    "graduation": {
      "title": "毕业视频贺卡",
      "sub": "用自豪的 Printo 毕业祝福庆祝成就。"
    },
    "housewarming": {
      "title": "乔迁视频贺卡",
      "sub": "为美好的新家送上温暖祝福。"
    },
    "new-job-promotion": {
      "title": "新工作 / 晋升视频贺卡",
      "sub": "庆祝新工作、晋升或职业成就。"
    },
    "congratulations": {
      "title": "祝贺视频贺卡",
      "sub": "为任何成就送上欢乐祝贺。"
    },
    "get-well": {
      "title": "早日康复视频贺卡",
      "sub": "带来希望、安慰和鼓励的贴心祝福。"
    },
    "sympathy-condolence": {
      "title": "慰问 / 哀悼视频贺卡",
      "sub": "送上尊重、安慰和支持的信息。"
    },
    "retirement": {
      "title": "退休视频贺卡",
      "sub": "庆祝多年服务和精彩的新篇章。"
    },
    "christmas": {
      "title": "圣诞节视频贺卡",
      "sub": "带有 Printo 音乐和节日欢乐的圣诞祝福。"
    },
    "new-year": {
      "title": "新年视频贺卡",
      "sub": "为新的一年送上幸福、成功和美好祝愿。"
    },
    "easter": {
      "title": "复活节视频贺卡",
      "sub": "明亮欢乐的 Printo 复活节祝福。"
    },
    "islamic": {
      "title": "伊斯兰节庆（开斋节）视频贺卡",
      "sub": "适用于开斋节和其他伊斯兰节庆的尊重祝福。"
    },
    "thanksgiving": {
      "title": "感恩节视频贺卡",
      "sub": "送给家人、朋友和所爱之人的感恩祝福。"
    },
    "mothers-day": {
      "title": "母亲节视频贺卡",
      "sub": "用充满爱的祝福向所有母亲表达敬意。"
    },
    "fathers-day": {
      "title": "父亲节视频贺卡",
      "sub": "庆祝父亲和父亲般人物的特别祝福。"
    },
    "valentines-day": {
      "title": "情人节视频贺卡",
      "sub": "用浪漫真挚的 Printo 祝福表达爱意。"
    },
    "business-greeting": {
      "title": "商务祝福视频贺卡",
      "sub": "适合客户、合作伙伴和团队的专业祝福。"
    },
    "grand-opening": {
      "title": "盛大开业视频贺卡",
      "sub": "庆祝企业、商店或办公室开业。"
    },
    "employee-appreciation": {
      "title": "员工感谢视频贺卡",
      "sub": "感谢员工和团队的贡献。"
    },
    "award-achievement": {
      "title": "奖项与成就视频贺卡",
      "sub": "表彰奖项、里程碑或杰出成就。"
    },
    "cultural-festival": {
      "title": "文化节视频贺卡",
      "sub": "庆祝文化传统、节日和社区欢乐。"
    }
  }
};

const GREETING_UI: Record<string, Record<string, string>> = {
  en: {
    storeTitle: "🎁 Printo Video Greeting Card Store",
    storeText:
      "Choose a ready-made video card to buy immediately, or personalize it with the recipient name, sender name, and your own message.",
    videoCard: "VIDEO CARD",
    readyPersonalized: "READY-MADE + PERSONALIZED",
    preview: "▶ Preview",
    buy: "🛒 Buy",
    personalize: "✨ Personalize",
    otherServices: "More Printo Studio Services",
    previewInfo:
      "The full preview video will appear here as each finished default card is uploaded. You can already order the ready-made version or request personalization.",
    readyOrder: "I want to buy the ready-made Printo video card.",
    personalizeOrder: "I want to personalize the Printo video card.",
    cardSelected: "Card selected",
    readyNoChanges:
      "I want the ready-made version without changing the names or message.",
    helpAddDetails:
      "Please help me add the recipient name, sender name, and personal message.",
    formIntro:
      "Enter the details below. Printo music and personalized voice will be added automatically.",
    selected: "Selected",
    backToStudio: "⬅ Back to Printo Studio",
    recipientName: "Recipient name",
    recipientPlaceholder: "e.g. Michael",
    senderName: "Sender name",
    senderPlaceholder: "e.g. James",
    personalMessage: "Personal message",
    messagePlaceholder: "Your birthday message",
    generate: "✨ Generate Personalized Video",
    missingTitle: "Missing information",
    missingMessage:
      "Please enter the recipient name, sender name, and personal message.",
    defaultBirthdayMessage:
      "Wishing you happiness, laughter, and a wonderful celebration!",
    resultReady: "🎉 Your greeting is ready!",
    playGreeting: "Play Printo Greeting",
    shareGreeting: "📤 Share Greeting",
    downloadVideo: "📥 Download Video",
    resultNote:
      "The play page includes WhatsApp, Facebook, Instagram, YouTube, TikTok, email, copy-link and download options.",
  },
  es: {
    storeTitle: "🎁 Tienda de tarjetas de video Printo",
    storeText:
      "Elige una tarjeta de video lista para comprar de inmediato o personalízala con el nombre del destinatario, el remitente y tu propio mensaje.",
    videoCard: "TARJETA DE VIDEO",
    readyPersonalized: "LISTA + PERSONALIZADA",
    preview: "▶ Vista previa",
    buy: "🛒 Comprar",
    personalize: "✨ Personalizar",
    otherServices: "Más servicios de Printo Studio",
    previewInfo:
      "El video de vista previa aparecerá aquí cuando se cargue cada tarjeta terminada. Ya puedes comprar la versión lista o solicitar personalización.",
    readyOrder: "Quiero comprar la tarjeta de video Printo lista.",
    personalizeOrder: "Quiero personalizar la tarjeta de video Printo.",
    cardSelected: "Tarjeta seleccionada",
    readyNoChanges:
      "Quiero la versión lista sin cambiar los nombres ni el mensaje.",
    helpAddDetails:
      "Ayúdeme a añadir el nombre del destinatario, el remitente y un mensaje personal.",
    formIntro:
      "Introduce los datos. La música de Printo y la voz personalizada se añadirán automáticamente.",
    selected: "Seleccionada",
    backToStudio: "⬅ Volver a Printo Studio",
    recipientName: "Nombre del destinatario",
    recipientPlaceholder: "p. ej. Michael",
    senderName: "Nombre del remitente",
    senderPlaceholder: "p. ej. James",
    personalMessage: "Mensaje personal",
    messagePlaceholder: "Tu mensaje de cumpleaños",
    generate: "✨ Generar video personalizado",
    missingTitle: "Falta información",
    missingMessage:
      "Introduce el nombre del destinatario, el remitente y el mensaje personal.",
    defaultBirthdayMessage:
      "¡Te deseo felicidad, risas y una celebración maravillosa!",
    resultReady: "🎉 ¡Tu saludo está listo!",
    playGreeting: "Reproducir saludo Printo",
    shareGreeting: "📤 Compartir saludo",
    downloadVideo: "📥 Descargar video",
    resultNote:
      "La página incluye opciones para WhatsApp, Facebook, Instagram, YouTube, TikTok, correo, copiar enlace y descargar.",
  },
  fr: {
    storeTitle: "🎁 Boutique de cartes vidéo Printo",
    storeText:
      "Choisissez une carte vidéo prête à acheter immédiatement ou personnalisez-la avec le nom du destinataire, de l'expéditeur et votre message.",
    videoCard: "CARTE VIDÉO",
    readyPersonalized: "PRÊTE + PERSONNALISÉE",
    preview: "▶ Aperçu",
    buy: "🛒 Acheter",
    personalize: "✨ Personnaliser",
    otherServices: "Autres services Printo Studio",
    previewInfo:
      "La vidéo d'aperçu apparaîtra ici lorsque chaque carte terminée sera chargée. Vous pouvez déjà acheter la version prête ou demander une personnalisation.",
    readyOrder: "Je souhaite acheter la carte vidéo Printo prête.",
    personalizeOrder: "Je souhaite personnaliser la carte vidéo Printo.",
    cardSelected: "Carte sélectionnée",
    readyNoChanges:
      "Je souhaite la version prête sans modifier les noms ni le message.",
    helpAddDetails:
      "Aidez-moi à ajouter le nom du destinataire, de l'expéditeur et un message personnel.",
    formIntro:
      "Saisissez les informations ci-dessous. La musique Printo et la voix personnalisée seront ajoutées automatiquement.",
    selected: "Sélectionnée",
    backToStudio: "⬅ Retour à Printo Studio",
    recipientName: "Nom du destinataire",
    recipientPlaceholder: "ex. Michael",
    senderName: "Nom de l'expéditeur",
    senderPlaceholder: "ex. James",
    personalMessage: "Message personnel",
    messagePlaceholder: "Votre message d'anniversaire",
    generate: "✨ Générer la vidéo personnalisée",
    missingTitle: "Informations manquantes",
    missingMessage:
      "Saisissez le nom du destinataire, de l'expéditeur et le message personnel.",
    defaultBirthdayMessage:
      "Je vous souhaite bonheur, rires et une merveilleuse célébration !",
    resultReady: "🎉 Votre message est prêt !",
    playGreeting: "Lire le message Printo",
    shareGreeting: "📤 Partager le message",
    downloadVideo: "📥 Télécharger la vidéo",
    resultNote:
      "La page de lecture comprend WhatsApp, Facebook, Instagram, YouTube, TikTok, e-mail, copie du lien et téléchargement.",
  },
  de: {
    storeTitle: "🎁 Printo Video-Grußkarten-Shop",
    storeText:
      "Wählen Sie eine fertige Videokarte zum sofortigen Kauf oder personalisieren Sie sie mit Empfängername, Absendername und Ihrer eigenen Nachricht.",
    videoCard: "VIDEO-KARTE",
    readyPersonalized: "FERTIG + PERSONALISIERT",
    preview: "▶ Vorschau",
    buy: "🛒 Kaufen",
    personalize: "✨ Personalisieren",
    otherServices: "Weitere Printo Studio-Dienste",
    previewInfo:
      "Das vollständige Vorschauvideo erscheint hier, sobald die fertige Karte hochgeladen wurde. Sie können die fertige Version bereits kaufen oder eine Personalisierung anfordern.",
    readyOrder: "Ich möchte die fertige Printo-Videokarte kaufen.",
    personalizeOrder: "Ich möchte die Printo-Videokarte personalisieren.",
    cardSelected: "Ausgewählte Karte",
    readyNoChanges:
      "Ich möchte die fertige Version ohne Änderung der Namen oder Nachricht.",
    helpAddDetails:
      "Bitte helfen Sie mir, Empfängername, Absendername und persönliche Nachricht hinzuzufügen.",
    formIntro:
      "Geben Sie unten die Angaben ein. Printo-Musik und eine personalisierte Stimme werden automatisch hinzugefügt.",
    selected: "Ausgewählt",
    backToStudio: "⬅ Zurück zu Printo Studio",
    recipientName: "Name des Empfängers",
    recipientPlaceholder: "z. B. Michael",
    senderName: "Name des Absenders",
    senderPlaceholder: "z. B. James",
    personalMessage: "Persönliche Nachricht",
    messagePlaceholder: "Ihre Geburtstagsnachricht",
    generate: "✨ Personalisiertes Video erstellen",
    missingTitle: "Angaben fehlen",
    missingMessage:
      "Bitte geben Sie Empfängername, Absendername und persönliche Nachricht ein.",
    defaultBirthdayMessage:
      "Ich wünsche dir Glück, Lachen und eine wundervolle Feier!",
    resultReady: "🎉 Ihr Gruß ist fertig!",
    playGreeting: "Printo-Gruß abspielen",
    shareGreeting: "📤 Gruß teilen",
    downloadVideo: "📥 Video herunterladen",
    resultNote:
      "Die Wiedergabeseite enthält WhatsApp, Facebook, Instagram, YouTube, TikTok, E-Mail, Link kopieren und Download.",
  },
  pt: {
    storeTitle: "🎁 Loja de cartões de vídeo Printo",
    storeText:
      "Escolha um cartão de vídeo pronto para comprar imediatamente ou personalize com o nome do destinatário, remetente e sua mensagem.",
    videoCard: "CARTÃO DE VÍDEO",
    readyPersonalized: "PRONTO + PERSONALIZADO",
    preview: "▶ Prévia",
    buy: "🛒 Comprar",
    personalize: "✨ Personalizar",
    otherServices: "Mais serviços do Printo Studio",
    previewInfo:
      "O vídeo de prévia aparecerá aqui quando cada cartão finalizado for carregado. Você já pode comprar a versão pronta ou pedir personalização.",
    readyOrder: "Quero comprar o cartão de vídeo Printo pronto.",
    personalizeOrder: "Quero personalizar o cartão de vídeo Printo.",
    cardSelected: "Cartão selecionado",
    readyNoChanges: "Quero a versão pronta sem alterar os nomes ou a mensagem.",
    helpAddDetails:
      "Ajude-me a adicionar o nome do destinatário, remetente e uma mensagem pessoal.",
    formIntro:
      "Digite os dados abaixo. A música Printo e a voz personalizada serão adicionadas automaticamente.",
    selected: "Selecionado",
    backToStudio: "⬅ Voltar ao Printo Studio",
    recipientName: "Nome do destinatário",
    recipientPlaceholder: "ex.: Michael",
    senderName: "Nome do remetente",
    senderPlaceholder: "ex.: James",
    personalMessage: "Mensagem pessoal",
    messagePlaceholder: "Sua mensagem de aniversário",
    generate: "✨ Gerar vídeo personalizado",
    missingTitle: "Informações ausentes",
    missingMessage:
      "Digite o nome do destinatário, remetente e a mensagem pessoal.",
    defaultBirthdayMessage:
      "Desejo muita felicidade, risadas e uma celebração maravilhosa!",
    resultReady: "🎉 Sua saudação está pronta!",
    playGreeting: "Reproduzir saudação Printo",
    shareGreeting: "📤 Compartilhar saudação",
    downloadVideo: "📥 Baixar vídeo",
    resultNote:
      "A página inclui WhatsApp, Facebook, Instagram, YouTube, TikTok, e-mail, copiar link e download.",
  },
  ar: {
    storeTitle: "🎁 متجر بطاقات فيديو برينتو",
    storeText:
      "اختر بطاقة فيديو جاهزة للشراء فورًا أو خصصها باسم المستلم واسم المرسل ورسالتك الخاصة.",
    videoCard: "بطاقة فيديو",
    readyPersonalized: "جاهزة + مخصصة",
    preview: "▶ معاينة",
    buy: "🛒 شراء",
    personalize: "✨ تخصيص",
    otherServices: "المزيد من خدمات استوديو برينتو",
    previewInfo:
      "سيظهر فيديو المعاينة هنا عند رفع كل بطاقة مكتملة. يمكنك شراء النسخة الجاهزة أو طلب التخصيص الآن.",
    readyOrder: "أريد شراء بطاقة فيديو برينتو الجاهزة.",
    personalizeOrder: "أريد تخصيص بطاقة فيديو برينتو.",
    cardSelected: "البطاقة المختارة",
    readyNoChanges: "أريد النسخة الجاهزة دون تغيير الأسماء أو الرسالة.",
    helpAddDetails:
      "يرجى مساعدتي في إضافة اسم المستلم واسم المرسل ورسالة شخصية.",
    formIntro:
      "أدخل التفاصيل أدناه. ستتم إضافة موسيقى برينتو والصوت المخصص تلقائيًا.",
    selected: "المحدد",
    backToStudio: "⬅ العودة إلى استوديو برينتو",
    recipientName: "اسم المستلم",
    recipientPlaceholder: "مثال: مايكل",
    senderName: "اسم المرسل",
    senderPlaceholder: "مثال: جيمس",
    personalMessage: "الرسالة الشخصية",
    messagePlaceholder: "رسالة عيد الميلاد",
    generate: "✨ إنشاء فيديو مخصص",
    missingTitle: "معلومات ناقصة",
    missingMessage: "يرجى إدخال اسم المستلم واسم المرسل والرسالة الشخصية.",
    defaultBirthdayMessage: "أتمنى لك السعادة والضحك واحتفالًا رائعًا!",
    resultReady: "🎉 تهنئتك جاهزة!",
    playGreeting: "تشغيل تهنئة برينتو",
    shareGreeting: "📤 مشاركة التهنئة",
    downloadVideo: "📥 تنزيل الفيديو",
    resultNote:
      "تتضمن صفحة التشغيل واتساب وفيسبوك وإنستغرام ويوتيوب وتيك توك والبريد ونسخ الرابط والتنزيل.",
  },
  zh: {
    storeTitle: "🎁 Printo 视频贺卡商店",
    storeText:
      "选择可立即购买的成品视频贺卡，或添加收件人姓名、发件人姓名和您的专属留言进行个性化。",
    videoCard: "视频贺卡",
    readyPersonalized: "成品 + 个性化",
    preview: "▶ 预览",
    buy: "🛒 购买",
    personalize: "✨ 个性化",
    otherServices: "更多 Printo Studio 服务",
    previewInfo:
      "每张成品贺卡上传后，完整预览视频会显示在这里。您现在可以购买成品版本或申请个性化。",
    readyOrder: "我想购买成品 Printo 视频贺卡。",
    personalizeOrder: "我想个性化 Printo 视频贺卡。",
    cardSelected: "已选择贺卡",
    readyNoChanges: "我想要不更改姓名或留言的成品版本。",
    helpAddDetails: "请帮我添加收件人姓名、发件人姓名和个人留言。",
    formIntro: "请在下方输入信息。Printo 音乐和个性化语音将自动添加。",
    selected: "已选择",
    backToStudio: "⬅ 返回 Printo Studio",
    recipientName: "收件人姓名",
    recipientPlaceholder: "例如：Michael",
    senderName: "发件人姓名",
    senderPlaceholder: "例如：James",
    personalMessage: "个人留言",
    messagePlaceholder: "您的生日留言",
    generate: "✨ 生成个性化视频",
    missingTitle: "信息不完整",
    missingMessage: "请输入收件人姓名、发件人姓名和个人留言。",
    defaultBirthdayMessage: "祝您幸福、欢笑，并拥有美好的庆祝时光！",
    resultReady: "🎉 您的祝福已准备好！",
    playGreeting: "播放 Printo 祝福",
    shareGreeting: "📤 分享祝福",
    downloadVideo: "📥 下载视频",
    resultNote:
      "播放页面包含 WhatsApp、Facebook、Instagram、YouTube、TikTok、电子邮件、复制链接和下载选项。",
  },
};


const PURCHASE_UI: Record<string, Record<string, string>> = {
  en: {
    paymentTitle: "Choose payment method",
    paymentMessage: "Select where you want to pay for this ready-made video card.",
    selectedCard: "Selected card",
    shopify: "🛒 Shopify Payment",
    africa: "🌍 Africa Payment",
    cancel: "Cancel",
  },
  es: {
    paymentTitle: "Elige el método de pago",
    paymentMessage: "Selecciona dónde deseas pagar esta tarjeta de video lista.",
    selectedCard: "Tarjeta seleccionada",
    shopify: "🛒 Pago de Shopify",
    africa: "🌍 Pago de África",
    cancel: "Cancelar",
  },
  fr: {
    paymentTitle: "Choisissez le mode de paiement",
    paymentMessage: "Choisissez où payer cette carte vidéo prête à l'emploi.",
    selectedCard: "Carte sélectionnée",
    shopify: "🛒 Paiement Shopify",
    africa: "🌍 Paiement Afrique",
    cancel: "Annuler",
  },
  de: {
    paymentTitle: "Zahlungsmethode wählen",
    paymentMessage: "Wählen Sie, wo Sie diese fertige Videokarte bezahlen möchten.",
    selectedCard: "Ausgewählte Karte",
    shopify: "🛒 Shopify-Zahlung",
    africa: "🌍 Afrika-Zahlung",
    cancel: "Abbrechen",
  },
  pt: {
    paymentTitle: "Escolha a forma de pagamento",
    paymentMessage: "Selecione onde deseja pagar por este cartão de vídeo pronto.",
    selectedCard: "Cartão selecionado",
    shopify: "🛒 Pagamento Shopify",
    africa: "🌍 Pagamento África",
    cancel: "Cancelar",
  },
  ar: {
    paymentTitle: "اختر طريقة الدفع",
    paymentMessage: "اختر مكان الدفع مقابل بطاقة الفيديو الجاهزة هذه.",
    selectedCard: "البطاقة المختارة",
    shopify: "🛒 الدفع عبر Shopify",
    africa: "🌍 الدفع في أفريقيا",
    cancel: "إلغاء",
  },
  zh: {
    paymentTitle: "选择付款方式",
    paymentMessage: "请选择购买此成品视频贺卡的付款方式。",
    selectedCard: "已选择贺卡",
    shopify: "🛒 Shopify 付款",
    africa: "🌍 非洲付款",
    cancel: "取消",
  },
};


const ACCESS_UI: Record<string, Record<string, string>> = {
  en: {
    checking: "Checking your greeting access…",
    firstFree: "🎁 Your first personalized video greeting is FREE.",
    paidCredit: "✅ You have a paid greeting credit available.",
    paymentNeeded:
      "🔒 Your free greeting has been used. Pay $4.99 to unlock one additional greeting.",
    paymentTitle: "Payment required",
    paymentMessage:
      "Your first free greeting has already been used. Choose Shopify or Africa Payment to unlock one additional greeting.",
    shopify: "🛒 Pay $4.99 with Shopify",
    africa: "🌍 Africa Payment",
    cancel: "Not now",
    identityError:
      "The app could not create your permanent greeting customer ID. Please close and reopen the app.",
    statusError: "We could not check your greeting access right now.",
    nextRequiresPayment:
      "Your greeting was created. Your next greeting requires payment.",
  },
  es: {
    checking: "Comprobando tu acceso…",
    firstFree: "🎁 Tu primer saludo de video personalizado es GRATIS.",
    paidCredit: "✅ Tienes un crédito de saludo pagado disponible.",
    paymentNeeded:
      "🔒 Ya usaste tu saludo gratis. Paga $4.99 para desbloquear uno adicional.",
    paymentTitle: "Pago requerido",
    paymentMessage:
      "Ya usaste tu primer saludo gratis. Elige Shopify o Pago África para desbloquear otro saludo.",
    shopify: "🛒 Pagar $4.99 con Shopify",
    africa: "🌍 Pago África",
    cancel: "Ahora no",
    identityError:
      "La app no pudo crear tu ID permanente. Cierra y vuelve a abrir la app.",
    statusError: "No pudimos comprobar tu acceso en este momento.",
    nextRequiresPayment:
      "Tu saludo fue creado. El siguiente requiere pago.",
  },
  fr: {
    checking: "Vérification de votre accès…",
    firstFree: "🎁 Votre première vidéo de vœux personnalisée est GRATUITE.",
    paidCredit: "✅ Vous avez un crédit de vœux payé disponible.",
    paymentNeeded:
      "🔒 Votre essai gratuit a été utilisé. Payez 4,99 $ pour un vœu supplémentaire.",
    paymentTitle: "Paiement requis",
    paymentMessage:
      "Votre premier vœu gratuit a déjà été utilisé. Choisissez Shopify ou Paiement Afrique.",
    shopify: "🛒 Payer 4,99 $ avec Shopify",
    africa: "🌍 Paiement Afrique",
    cancel: "Pas maintenant",
    identityError:
      "L’application n’a pas pu créer votre identifiant permanent. Fermez-la puis rouvrez-la.",
    statusError: "Impossible de vérifier votre accès pour le moment.",
    nextRequiresPayment:
      "Votre vœu a été créé. Le prochain nécessite un paiement.",
  },
  de: {
    checking: "Grußzugang wird geprüft…",
    firstFree: "🎁 Ihr erster personalisierter Videogruß ist KOSTENLOS.",
    paidCredit: "✅ Ein bezahltes Grußguthaben ist verfügbar.",
    paymentNeeded:
      "🔒 Der kostenlose Gruß wurde genutzt. Zahlen Sie 4,99 $, um einen weiteren freizuschalten.",
    paymentTitle: "Zahlung erforderlich",
    paymentMessage:
      "Ihr erster kostenloser Gruß wurde bereits genutzt. Wählen Sie Shopify oder Afrika-Zahlung.",
    shopify: "🛒 4,99 $ mit Shopify zahlen",
    africa: "🌍 Afrika-Zahlung",
    cancel: "Nicht jetzt",
    identityError:
      "Die App konnte keine dauerhafte Kunden-ID erstellen. Bitte schließen und erneut öffnen.",
    statusError: "Der Grußzugang konnte momentan nicht geprüft werden.",
    nextRequiresPayment:
      "Ihr Gruß wurde erstellt. Für den nächsten ist eine Zahlung erforderlich.",
  },
  pt: {
    checking: "Verificando seu acesso…",
    firstFree: "🎁 Seu primeiro vídeo de saudação personalizado é GRÁTIS.",
    paidCredit: "✅ Você tem um crédito de saudação pago disponível.",
    paymentNeeded:
      "🔒 A saudação grátis já foi usada. Pague US$ 4,99 para liberar outra.",
    paymentTitle: "Pagamento necessário",
    paymentMessage:
      "Sua primeira saudação grátis já foi usada. Escolha Shopify ou Pagamento África.",
    shopify: "🛒 Pagar US$ 4,99 com Shopify",
    africa: "🌍 Pagamento África",
    cancel: "Agora não",
    identityError:
      "O app não conseguiu criar seu ID permanente. Feche e abra o app novamente.",
    statusError: "Não foi possível verificar seu acesso agora.",
    nextRequiresPayment:
      "Sua saudação foi criada. A próxima exige pagamento.",
  },
  ar: {
    checking: "جارٍ التحقق من صلاحية إنشاء التهنئة…",
    firstFree: "🎁 أول فيديو تهنئة مخصص لك مجاني.",
    paidCredit: "✅ لديك رصيد مدفوع متاح لإنشاء تهنئة.",
    paymentNeeded:
      "🔒 تم استخدام التهنئة المجانية. ادفع 4.99 دولار لفتح تهنئة إضافية.",
    paymentTitle: "الدفع مطلوب",
    paymentMessage:
      "تم استخدام أول تهنئة مجانية. اختر الدفع عبر Shopify أو دفع أفريقيا.",
    shopify: "🛒 الدفع 4.99 دولار عبر Shopify",
    africa: "🌍 دفع أفريقيا",
    cancel: "ليس الآن",
    identityError:
      "تعذر إنشاء معرّف عميل دائم. أغلق التطبيق وافتحه مرة أخرى.",
    statusError: "تعذر التحقق من صلاحية إنشاء التهنئة الآن.",
    nextRequiresPayment:
      "تم إنشاء التهنئة. التهنئة التالية تتطلب الدفع.",
  },
  zh: {
    checking: "正在检查贺卡权限…",
    firstFree: "🎁 您的第一个个性化视频祝福免费。",
    paidCredit: "✅ 您有一个可用的付费祝福额度。",
    paymentNeeded:
      "🔒 免费祝福已使用。支付 4.99 美元可解锁一个额外祝福。",
    paymentTitle: "需要付款",
    paymentMessage:
      "您的第一个免费祝福已使用。请选择 Shopify 或非洲付款。",
    shopify: "🛒 使用 Shopify 支付 4.99 美元",
    africa: "🌍 非洲付款",
    cancel: "暂不",
    identityError:
      "应用无法创建永久客户 ID。请关闭并重新打开应用。",
    statusError: "目前无法检查您的祝福权限。",
    nextRequiresPayment:
      "祝福已创建。下一个祝福需要付款。",
  },
};

type GreetingAccessState =
  | "checking"
  | "free"
  | "credit"
  | "payment"
  | "unknown";

type GreetingPaymentLinks = {
  shopify: string;
  africa: string;
};

export default function HomeScreen() {
  const [selectedLanguage, setSelectedLanguage] = useState("en");
  const [showStudio, setShowStudio] = useState(false);
  const [showGreeting, setShowGreeting] = useState(false);
  const [selectedGreetingTitle, setSelectedGreetingTitle] = useState(
    "Birthday Video Card",
  );
  const [showSplash, setShowSplash] = useState(true);
  const [recipientName, setRecipientName] = useState("");
  const [senderName, setSenderName] = useState("");
  const [personalMessage, setPersonalMessage] = useState(
    "Wishing you happiness, laughter, and a wonderful celebration!",
  );
  const [generating, setGenerating] = useState(false);
  const [resultUrl, setResultUrl] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [customerIdReady, setCustomerIdReady] = useState(false);
  const [greetingAccessState, setGreetingAccessState] =
    useState<GreetingAccessState>("checking");
  const [paymentRequired, setPaymentRequired] = useState(false);
  const [paymentLinks, setPaymentLinks] = useState<GreetingPaymentLinks>({
    shopify: SHOPIFY_GREETING_URL,
    africa: NIGERIA_PAYMENT_URL,
  });
  const fadeAnim = useState(new Animated.Value(1))[0];
  const greetingScrollRef = useRef<ScrollView>(null);
  const recipientInputRef = useRef<TextInput>(null);
  const senderInputRef = useRef<TextInput>(null);
  const messageInputRef = useRef<TextInput>(null);
  const activeGreetingField = useRef<
    "recipient" | "sender" | "message" | null
  >(null);
  const formCardY = useRef(0);
  const fieldOffsets = useRef({
    recipient: 0,
    sender: 0,
    message: 0,
  });
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const getNameFontSize = (value: string) => {
    if (value.length <= 10) return 20;
    if (value.length <= 16) return 18;
    if (value.length <= 20) return 16;
    return 14;
  };

  const getMessageFontSize = (value: string) => {
    if (value.length <= 60) return 18;
    if (value.length <= 120) return 16;
    if (value.length <= 175) return 15;
    return 14;
  };

  const scrollGreetingFormTo = (
    field: "recipient" | "sender" | "message",
  ) => {
    // Recalculate the position at every attempt because Android changes the
    // available screen height while the keyboard is opening.
    [60, 180, 360, 620].forEach((delay) => {
      setTimeout(() => {
        const extraLift = field === "message" ? 72 : field === "sender" ? 44 : 24;
        const y = Math.max(
          0,
          formCardY.current + fieldOffsets.current[field] - extraLift,
        );
        greetingScrollRef.current?.scrollTo({ y, animated: true });
      }, delay);
    });
  };

  useEffect(() => {
    const showSubscription = Keyboard.addListener(
      "keyboardDidShow",
      (event) => {
        setKeyboardVisible(true);
        setKeyboardHeight(event.endCoordinates.height);

        const activeField = activeGreetingField.current;
        if (activeField) {
          setTimeout(() => scrollGreetingFormTo(activeField), 80);
        }
      },
    );
    const hideSubscription = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const t = TEXT[selectedLanguage] || TEXT.en;
  const services = SERVICES[selectedLanguage] || SERVICES.en;
  const greetingUi = GREETING_UI[selectedLanguage] || GREETING_UI.en;
  const purchaseUi = PURCHASE_UI[selectedLanguage] || PURCHASE_UI.en;
  const accessUi = ACCESS_UI[selectedLanguage] || ACCESS_UI.en;
  const greetingCardText =
    GREETING_CARD_TEXT[selectedLanguage] || GREETING_CARD_TEXT.en;
  const greetingCards: GreetingCard[] = GREETING_CARD_BASE.map((card) => ({
    ...card,
    ...greetingCardText[card.id],
  }));


  const getOrCreateCustomerId = async () => {
    if (customerId) return customerId;

    try {
      const saved = await AsyncStorage.getItem(CUSTOMER_ID_STORAGE_KEY);
      if (saved && saved.trim()) {
        setCustomerId(saved);
        setCustomerIdReady(true);
        return saved;
      }

      const created = createGreetingCustomerId();
      await AsyncStorage.setItem(CUSTOMER_ID_STORAGE_KEY, created);
      setCustomerId(created);
      setCustomerIdReady(true);
      return created;
    } catch (error) {
      console.error("Greeting customer ID storage error:", error);
      setCustomerIdReady(false);
      throw error;
    }
  };

  const applyPaymentLinks = (payment: any) => {
    const nextLinks = {
      shopify:
        String(payment?.shopify || payment?.shopifyUrl || "").trim() ||
        SHOPIFY_GREETING_URL,
      africa:
        String(payment?.africa || payment?.africaUrl || "").trim() ||
        NIGERIA_PAYMENT_URL,
    };

    setPaymentLinks(nextLinks);
    return nextLinks;
  };

  const showPaymentOptions = (
    message: string,
    links: GreetingPaymentLinks = paymentLinks,
  ) => {
    Alert.alert(accessUi.paymentTitle, message, [
      {
        text: accessUi.shopify,
        onPress: () => Linking.openURL(links.shopify),
      },
      {
        text: accessUi.africa,
        onPress: () => Linking.openURL(links.africa),
      },
      {
        text: accessUi.cancel,
        style: "cancel",
      },
    ]);
  };

  const refreshGreetingAccess = async (templateId = "birthday") => {
    try {
      setGreetingAccessState("checking");
      const persistentCustomerId = await getOrCreateCustomerId();

      const response = await fetch(`${API_BASE_URL}/api/greeting/access/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-printo-customer-id": persistentCustomerId,
        },
        body: JSON.stringify({
          customerId: persistentCustomerId,
          templateId,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || accessUi.statusError);
      }

      applyPaymentLinks(data.payment);

      if (data.paymentRequired) {
        setPaymentRequired(true);
        setGreetingAccessState("payment");
      } else if (Number(data.paidCredits || 0) > 0) {
        setPaymentRequired(false);
        setGreetingAccessState("credit");
      } else if (data.freeAvailable) {
        setPaymentRequired(false);
        setGreetingAccessState("free");
      } else {
        setPaymentRequired(false);
        setGreetingAccessState("unknown");
      }

      return data;
    } catch (error) {
      console.error("Greeting access check failed:", error);
      setGreetingAccessState("unknown");
      return null;
    }
  };

  useEffect(() => {
    getOrCreateCustomerId()
      .then(() => setCustomerIdReady(true))
      .catch(() => {
        setCustomerIdReady(false);
        setGreetingAccessState("unknown");
      });
  }, []);

  useEffect(() => {
    const blink = Animated.loop(
      Animated.sequence([
        Animated.timing(fadeAnim, {
          toValue: 0.35,
          duration: 350,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 350,
          useNativeDriver: true,
        }),
      ]),
    );
    blink.start();
    const timer = setTimeout(() => {
      blink.stop();
      setShowSplash(false);
    }, 2200);
    return () => {
      blink.stop();
      clearTimeout(timer);
    };
  }, []);

  const openWhatsApp = (message: string) => {
    const finalMessage = `Language: ${selectedLanguage}\n${message}`;
    Linking.openURL(
      `https://wa.me/${PHONE}?text=${encodeURIComponent(finalMessage)}`,
    );
  };

  const previewGreetingCard = (title: string) => {
    Alert.alert(
      title,
      "The full preview video will appear here as each finished default card is uploaded. You can already order the ready-made version or request personalization.",
    );
  };

  const buyReadyMadeGreeting = async (card: GreetingCard) => {
    let links: GreetingPaymentLinks = {
      shopify: SHOPIFY_GREETING_URL,
      africa: NIGERIA_PAYMENT_URL,
    };

    try {
      const persistentCustomerId = await getOrCreateCustomerId();
      const response = await fetch(`${API_BASE_URL}/api/greeting/access/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-printo-customer-id": persistentCustomerId,
        },
        body: JSON.stringify({
          customerId: persistentCustomerId,
          templateId: card.id,
        }),
      });
      const data = await response.json();

      if (response.ok && data.ok) {
        links = applyPaymentLinks(data.payment);
      }
    } catch (error) {
      console.error("Could not prepare customer-specific payment links:", error);
    }

    Alert.alert(
      purchaseUi.paymentTitle,
      `${purchaseUi.paymentMessage}\n\n${purchaseUi.selectedCard}: ${card.title}`,
      [
        {
          text: purchaseUi.shopify,
          onPress: () => Linking.openURL(links.shopify),
        },
        {
          text: purchaseUi.africa,
          onPress: () => Linking.openURL(links.africa),
        },
        {
          text: purchaseUi.cancel,
          style: "cancel",
        },
      ],
    );
  };

  const openPersonalizationAgent = (card: GreetingCard) => {
    // This wording intentionally starts with "Video editing request" so the
    // existing WhatsApp backend routes it to the AGENT dashboard instead of
    // returning the normal service menu.
    const agentMessage = [
      "Video editing request",
      "Service code: CARD_PERSONALIZATION_AGENT",
      `Language: ${selectedLanguage}`,
      `Selected card: ${card.title}`,
      "The automatic personalization form is not yet available for this card.",
      "Please route this request directly to a worker agent for recipient name, sender name, personal message, and payment assistance.",
    ].join("\n");

    Linking.openURL(
      `https://wa.me/${PHONE}?text=${encodeURIComponent(agentMessage)}`,
    );
  };

  const personalizeGreeting = (card: GreetingCard) => {
    setSelectedGreetingTitle(card.title);
    setResultUrl("");
    setDownloadUrl("");
    setPaymentRequired(false);

    if (card.id === "birthday") {
      setPersonalMessage(greetingUi.defaultBirthdayMessage);
      setShowGreeting(true);
      void refreshGreetingAccess(card.id);
      return;
    }

    openPersonalizationAgent(card);
  };

  const generateGreeting = async () => {
    if (
      !recipientName.trim() ||
      !senderName.trim() ||
      !personalMessage.trim()
    ) {
      Alert.alert(greetingUi.missingTitle, greetingUi.missingMessage);
      return;
    }

    setGenerating(true);
    setResultUrl("");
    setDownloadUrl("");

    try {
      const persistentCustomerId = await getOrCreateCustomerId();

      const response = await fetch(
        `${API_BASE_URL}/api/greeting/birthday/generate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-printo-customer-id": persistentCustomerId,
          },
          body: JSON.stringify({
            to: recipientName.trim(),
            from: senderName.trim(),
            message: personalMessage.trim(),
            language: selectedLanguage,
            customerId: persistentCustomerId,
          }),
        },
      );

      const data = await response.json();

      if (data.paymentRequired) {
        const links = applyPaymentLinks(data.payment);
        setPaymentRequired(true);
        setGreetingAccessState("payment");
        showPaymentOptions(
          data.error || accessUi.paymentMessage,
          links,
        );
        return;
      }

      if (!response.ok || !data.ok) {
        throw new Error(data.error || "Could not generate greeting.");
      }

      setPaymentRequired(false);
      setResultUrl(data.resultUrl || data.downloadUrl);
      setDownloadUrl(data.downloadUrl || data.resultUrl);
      applyPaymentLinks(data.payment);

      void refreshGreetingAccess("birthday");
    } catch (error: any) {
      const message =
        !customerIdReady && !customerId
          ? accessUi.identityError
          : error?.message || "Please try again.";
      Alert.alert("Generation failed", message);
    } finally {
      setGenerating(false);
    }
  };

  const shareGreeting = async () => {
    const url = resultUrl || downloadUrl;
    if (!url) return;
    await Share.share({
      message: `🎉 Watch my personalized Printo greeting!\n${url}\n\nCreate yours: ${PRINTO_STUDIO_WEB_URL}\nNigeria payment: ${NIGERIA_PAYMENT_URL}`,
      url,
      title: "Printo Greeting Studio",
    });
  };

  if (showSplash) {
    return (
      <SafeAreaView style={styles.splashScreen}>
        <Animated.Image
          source={require("../../assets/images/splash.png")}
          style={[styles.splashImage, { opacity: fadeAnim }]}
          resizeMode="contain"
        />
      </SafeAreaView>
    );
  }

  if (!showStudio) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.centerWrap}>
          <Image
            source={require("../../assets/images/printomatic-logo.png")}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.title}>{t.welcome}</Text>
          <Text style={styles.subtitle}>{t.subtitle}</Text>
          <Text style={styles.choose}>{t.choose}</Text>
          <View style={styles.languageGrid}>
            {Object.keys(TEXT).map((key) => (
              <TouchableOpacity
                key={key}
                style={[
                  styles.languageButton,
                  selectedLanguage === key && styles.languageButtonActive,
                ]}
                onPress={() => setSelectedLanguage(key)}
              >
                <Text
                  style={[
                    styles.languageText,
                    selectedLanguage === key && styles.languageTextActive,
                  ]}
                >
                  {TEXT[key].name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity
            style={styles.mainButton}
            onPress={() => setShowStudio(true)}
          >
            <Text style={styles.mainButtonText}>{t.explore}</Text>
          </TouchableOpacity>
          <Text style={styles.footer}>{t.powered}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (showGreeting) {
    return (
      <SafeAreaView style={styles.screen}>
        <KeyboardAvoidingView
          style={styles.keyboardAvoidingView}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 8}
        >
          <ScrollView
            ref={greetingScrollRef}
            contentContainerStyle={[
              styles.scrollWrap,
              styles.greetingScrollWrap,
              { paddingBottom: keyboardVisible ? keyboardHeight + 180 : 320 },
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={
              Platform.OS === "ios" ? "interactive" : "on-drag"
            }
            automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
            nestedScrollEnabled
            scrollEventThrottle={16}
            onContentSizeChange={() => {
              const activeField = activeGreetingField.current;
              if (keyboardVisible && activeField) {
                scrollGreetingFormTo(activeField);
              }
            }}
            showsVerticalScrollIndicator={false}
          >
            {!keyboardVisible && (
              <>
                <Image
                  source={require("../../assets/images/printomatic-logo.png")}
                  style={styles.smallLogo}
                  resizeMode="contain"
                />
                <Text style={styles.title}>
                  🎂 Printo {selectedGreetingTitle}
                </Text>
                <Text style={styles.subtitle}>{greetingUi.formIntro}</Text>
                <View style={styles.selectedCardBadge}>
                  <Text style={styles.selectedCardBadgeText}>
                    {greetingUi.selected}: {selectedGreetingTitle}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.backButton}
                  onPress={() => setShowGreeting(false)}
                >
                  <Text style={styles.backButtonText}>
                    {greetingUi.backToStudio}
                  </Text>
                </TouchableOpacity>
                <View
                  style={[
                    styles.accessBanner,
                    greetingAccessState === "payment" &&
                      styles.accessBannerPayment,
                    greetingAccessState === "credit" &&
                      styles.accessBannerCredit,
                  ]}
                >
                  <Text style={styles.accessBannerText}>
                    {greetingAccessState === "checking"
                      ? accessUi.checking
                      : greetingAccessState === "free"
                        ? accessUi.firstFree
                        : greetingAccessState === "credit"
                          ? accessUi.paidCredit
                          : greetingAccessState === "payment"
                            ? accessUi.paymentNeeded
                            : accessUi.statusError}
                  </Text>
                </View>
              </>
            )}
            <View
              style={styles.formCard}
              onLayout={(event) => {
                formCardY.current = event.nativeEvent.layout.y;
              }}
            >
              <View
                onLayout={(event) => {
                  fieldOffsets.current.recipient = event.nativeEvent.layout.y;
                }}
              >
                <Text style={styles.inputLabel}>
                  {greetingUi.recipientName}
                </Text>
                <TextInput
                  ref={recipientInputRef}
                  style={[
                    styles.input,
                    { fontSize: getNameFontSize(recipientName) },
                  ]}
                  value={recipientName}
                  onChangeText={(v) => setRecipientName(v.slice(0, NAME_MAX))}
                  maxLength={NAME_MAX}
                  placeholder={greetingUi.recipientPlaceholder}
                  returnKeyType="next"
                  blurOnSubmit={false}
                  onSubmitEditing={() => senderInputRef.current?.focus()}
                  onFocus={() => {
                    activeGreetingField.current = "recipient";
                    scrollGreetingFormTo("recipient");
                  }}
                />
              </View>
              <Text
                style={[
                  styles.counter,
                  recipientName.length >= NAME_MAX && styles.counterLimit,
                ]}
              >
                {recipientName.length} / {NAME_MAX}
              </Text>
              <View
                onLayout={(event) => {
                  fieldOffsets.current.sender = event.nativeEvent.layout.y;
                }}
              >
                <Text style={styles.inputLabel}>{greetingUi.senderName}</Text>
                <TextInput
                  ref={senderInputRef}
                  style={[
                    styles.input,
                    { fontSize: getNameFontSize(senderName) },
                  ]}
                  value={senderName}
                  onChangeText={(v) => setSenderName(v.slice(0, NAME_MAX))}
                  maxLength={NAME_MAX}
                  placeholder={greetingUi.senderPlaceholder}
                  returnKeyType="next"
                  blurOnSubmit={false}
                  onSubmitEditing={() => messageInputRef.current?.focus()}
                  onFocus={() => {
                    activeGreetingField.current = "sender";
                    scrollGreetingFormTo("sender");
                  }}
                />
              </View>
              <Text
                style={[
                  styles.counter,
                  senderName.length >= NAME_MAX && styles.counterLimit,
                ]}
              >
                {senderName.length} / {NAME_MAX}
              </Text>
              <View
                onLayout={(event) => {
                  fieldOffsets.current.message = event.nativeEvent.layout.y;
                }}
              >
                <Text style={styles.inputLabel}>
                  {greetingUi.personalMessage}
                </Text>
                <TextInput
                  ref={messageInputRef}
                  style={[
                    styles.input,
                    styles.messageInput,
                    { fontSize: getMessageFontSize(personalMessage) },
                  ]}
                  value={personalMessage}
                  onChangeText={(v) =>
                    setPersonalMessage(v.slice(0, MESSAGE_MAX))
                  }
                  maxLength={MESSAGE_MAX}
                  multiline
                  returnKeyType="done"
                  blurOnSubmit
                  onSubmitEditing={Keyboard.dismiss}
                  placeholder={greetingUi.messagePlaceholder}
                  onFocus={() => {
                    activeGreetingField.current = "message";
                    scrollGreetingFormTo("message");
                  }}
                />
              </View>
              <Text
                style={[
                  styles.counter,
                  personalMessage.length >= MESSAGE_MAX && styles.counterLimit,
                ]}
              >
                {personalMessage.length} / {MESSAGE_MAX}
              </Text>
              <TouchableOpacity
                style={styles.generateButton}
                onPress={generateGreeting}
                disabled={generating || !customerIdReady}
              >
                {generating ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.generateButtonText}>
                    {greetingUi.generate}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
            {paymentRequired && !resultUrl && (
              <View style={styles.paymentRequiredCard}>
                <Text style={styles.paymentRequiredTitle}>
                  {accessUi.paymentTitle}
                </Text>
                <Text style={styles.paymentRequiredText}>
                  {accessUi.paymentMessage}
                </Text>
                <TouchableOpacity
                  style={styles.shopifyPaymentWideButton}
                  onPress={() => Linking.openURL(paymentLinks.shopify)}
                >
                  <Text style={styles.paymentText}>{accessUi.shopify}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.africaPaymentWideButton}
                  onPress={() => Linking.openURL(paymentLinks.africa)}
                >
                  <Text style={styles.paymentText}>{accessUi.africa}</Text>
                </TouchableOpacity>
              </View>
            )}
            {!!resultUrl && (
              <View style={styles.resultCard}>
                <Text style={styles.resultTitle}>{greetingUi.resultReady}</Text>
                <TouchableOpacity
                  style={styles.largePlayButton}
                  onPress={() => Linking.openURL(resultUrl)}
                >
                  <Text style={styles.largePlayIcon}>▶</Text>
                  <Text style={styles.largePlayText}>
                    {greetingUi.playGreeting}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.shareButton}
                  onPress={shareGreeting}
                >
                  <Text style={styles.shareButtonText}>
                    {greetingUi.shareGreeting}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.downloadButton}
                  onPress={() => Linking.openURL(downloadUrl)}
                >
                  <Text style={styles.shareButtonText}>
                    {greetingUi.downloadVideo}
                  </Text>
                </TouchableOpacity>
                <View style={styles.paymentRow}>
                  <TouchableOpacity
                    style={styles.shopifyButton}
                    onPress={() => Linking.openURL(paymentLinks.shopify)}
                  >
                    <Text style={styles.paymentText}>🛒 Shopify</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.nigeriaButton}
                    onPress={() => Linking.openURL(paymentLinks.africa)}
                  >
                    <Text style={styles.paymentText}>🇳🇬 Nigeria Pay</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.resultNote}>{greetingUi.resultNote}</Text>
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scrollWrap}>
        <Image
          source={require("../../assets/images/printomatic-logo.png")}
          style={styles.smallLogo}
          resizeMode="contain"
        />
        <Text style={styles.title}>{t.studioTitle}</Text>
        <Text style={styles.subtitle}>{t.subtitle}</Text>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => setShowStudio(false)}
        >
          <Text style={styles.backButtonText}>{t.backToLanguage}</Text>
        </TouchableOpacity>

        <View style={styles.greetingStoreHeader}>
          <Text style={styles.greetingStoreTitle}>{greetingUi.storeTitle}</Text>
          <Text style={styles.greetingStoreText}>{greetingUi.storeText}</Text>
        </View>

        {greetingCards.map((card) => (
          <View key={card.id} style={styles.greetingProductCard}>
            <View style={styles.greetingProductTop}>
              <View style={styles.greetingPreviewBox}>
                <Text style={styles.greetingPreviewEmoji}>{card.emoji}</Text>
                <Text style={styles.greetingPreviewLabel}>
                  {greetingUi.videoCard}
                </Text>
              </View>
              <View style={styles.greetingProductContent}>
                <Text style={styles.greetingProductTitle}>{card.title}</Text>
                <Text style={styles.greetingProductText}>{card.sub}</Text>
                <View style={styles.readyBadge}>
                  <Text style={styles.readyBadgeText}>
                    {greetingUi.readyPersonalized}
                  </Text>
                </View>
              </View>
            </View>
            <View style={styles.greetingButtonRow}>
              <TouchableOpacity
                style={styles.previewCardButton}
                onPress={() => previewGreetingCard(card.title)}
              >
                <Text style={styles.greetingButtonText}>
                  {greetingUi.preview}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.buyCardButton}
                onPress={() => buyReadyMadeGreeting(card)}
              >
                <Text style={styles.greetingButtonText}>{greetingUi.buy}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.personalizeCardButton}
                onPress={() => personalizeGreeting(card)}
              >
                <Text style={styles.greetingButtonText}>
                  {greetingUi.personalize}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}

        <Text style={styles.otherServicesTitle}>
          {greetingUi.otherServices}
        </Text>
        {services.map((item, index) => (
          <TouchableOpacity
            key={item.title}
            style={styles.card}
            onPress={() =>
              index === 1
                ? personalizeGreeting(greetingCards[0])
                : openWhatsApp(item.message)
            }
          >
            <View style={styles.cardRow}>
              <Text style={styles.cardEmoji}>{item.emoji}</Text>
              <View style={styles.cardContent}>
                <Text style={styles.cardTitle}>{item.title}</Text>
                <Text style={styles.cardText}>{item.sub}</Text>
                <Text style={styles.cardAction}>{t.tap}</Text>
              </View>
            </View>
          </TouchableOpacity>
        ))}
        <View style={styles.downloadCard}>
          <Text style={styles.downloadTitle}>⬇️ {t.scanTitle}</Text>
          <Text style={styles.downloadText}>{t.scanSub}</Text>
          <Image
            source={require("../../assets/images/playstore-qr.png")}
            style={styles.qrImage}
            resizeMode="contain"
          />
          <TouchableOpacity
            style={styles.playButton}
            onPress={() => Linking.openURL(PLAY_STORE_URL)}
          >
            <Text style={styles.playButtonText}>{t.playButton}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={styles.whatsappButton}
          onPress={() => openWhatsApp(t.agentMsg)}
        >
          <Text style={styles.whatsappText}>{t.talk}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowStudio(false)}>
          <Text style={styles.backText}>{t.change}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  splashScreen: {
    flex: 1,
    backgroundColor: "#05081D",
    alignItems: "center",
    justifyContent: "center",
  },
  splashImage: {
    width: "100%",
    height: "100%",
  },
  screen: {
    flex: 1,
    backgroundColor: "#0b63ce",
  },
  centerWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  scrollWrap: {
    padding: 22,
    alignItems: "center",
  },
  keyboardAvoidingView: {
    flex: 1,
  },
  greetingScrollWrap: {
    paddingBottom: 320,
  },
  accessBanner: {
    width: "100%",
    backgroundColor: "#e0f2fe",
    borderColor: "#38bdf8",
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 14,
  },
  accessBannerPayment: {
    backgroundColor: "#fff7ed",
    borderColor: "#fb923c",
  },
  accessBannerCredit: {
    backgroundColor: "#ecfdf5",
    borderColor: "#34d399",
  },
  accessBannerText: {
    color: "#0f172a",
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "800",
    textAlign: "center",
  },
  logo: {
    width: 280,
    height: 280,
    marginBottom: 4,
  },
  smallLogo: {
    width: 180,
    height: 180,
    marginBottom: 8,
  },
  title: {
    fontSize: 30,
    fontWeight: "900",
    color: "#ffffff",
    textAlign: "center",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: "#ffffff",
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 24,
  },
  choose: {
    fontSize: 17,
    fontWeight: "800",
    color: "#ffffff",
    marginBottom: 14,
  },
  languageGrid: {
    width: "100%",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    marginBottom: 22,
  },
  languageButton: {
    backgroundColor: "#ffffff",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    margin: 5,
  },
  languageButtonActive: {
    backgroundColor: "#ffd21f",
  },
  languageText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#111111",
  },
  languageTextActive: {
    color: "#111111",
  },
  mainButton: {
    backgroundColor: "#ffd21f",
    paddingVertical: 16,
    paddingHorizontal: 30,
    borderRadius: 18,
  },
  mainButtonText: {
    color: "#111111",
    fontSize: 17,
    fontWeight: "900",
    textAlign: "center",
  },
  footer: {
    color: "#ffffff",
    fontWeight: "800",
    marginTop: 22,
  },
  backButton: {
    backgroundColor: "#ffd21f",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 16,
    marginBottom: 16,
  },
  backButtonText: {
    color: "#111111",
    fontSize: 15,
    fontWeight: "900",
    textAlign: "center",
  },
  card: {
    width: "100%",
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 16,
    marginBottom: 14,
    borderWidth: 2,
    borderColor: "#ffd21f",
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  cardEmoji: {
    fontSize: 36,
    marginRight: 14,
  },
  cardContent: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: "900",
    color: "#0b63ce",
    marginBottom: 5,
  },
  cardText: {
    fontSize: 15,
    color: "#333333",
    lineHeight: 21,
  },
  cardAction: {
    marginTop: 8,
    fontSize: 14,
    fontWeight: "900",
    color: "#111111",
  },
  downloadCard: {
    width: "100%",
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 16,
    marginTop: 4,
    marginBottom: 14,
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#ffd21f",
  },
  downloadTitle: {
    fontSize: 18,
    fontWeight: "900",
    color: "#0b63ce",
    textAlign: "center",
    marginBottom: 6,
  },
  downloadText: {
    fontSize: 14,
    color: "#333333",
    textAlign: "center",
    marginBottom: 12,
  },
  qrImage: {
    width: 170,
    height: 170,
    backgroundColor: "#ffffff",
  },
  playButton: {
    backgroundColor: "#34A853",
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 16,
    marginTop: 15,
  },
  playButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "900",
    textAlign: "center",
  },
  whatsappButton: {
    width: "100%",
    backgroundColor: "#25D366",
    paddingVertical: 16,
    borderRadius: 18,
    alignItems: "center",
    marginTop: 6,
  },
  whatsappText: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "900",
    textAlign: "center",
  },
  backText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800",
    marginTop: 18,
    textDecorationLine: "underline",
  },
  greetingStoreHeader: {
    width: "100%",
    backgroundColor: "#082f74",
    borderRadius: 20,
    padding: 18,
    marginBottom: 16,
    borderWidth: 2,
    borderColor: "#ffd21f",
  },
  greetingStoreTitle: {
    color: "#ffd21f",
    fontSize: 22,
    fontWeight: "900",
    textAlign: "center",
    marginBottom: 8,
  },
  greetingStoreText: {
    color: "#ffffff",
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },
  greetingProductCard: {
    width: "100%",
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 14,
    marginBottom: 14,
    borderWidth: 2,
    borderColor: "#ffd21f",
  },
  greetingProductTop: { flexDirection: "row", alignItems: "center" },
  greetingPreviewBox: {
    width: 92,
    height: 110,
    backgroundColor: "#eaf3ff",
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 13,
    borderWidth: 1,
    borderColor: "#aacbff",
  },
  greetingPreviewEmoji: { fontSize: 42 },
  greetingPreviewLabel: {
    marginTop: 7,
    color: "#0b63ce",
    fontSize: 10,
    fontWeight: "900",
  },
  greetingProductContent: { flex: 1 },
  greetingProductTitle: {
    color: "#0b63ce",
    fontSize: 18,
    fontWeight: "900",
    marginBottom: 5,
  },
  greetingProductText: { color: "#334155", fontSize: 14, lineHeight: 19 },
  readyBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#fff4b8",
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 7,
    marginTop: 8,
  },
  readyBadgeText: { color: "#6b4f00", fontSize: 9, fontWeight: "900" },
  greetingButtonRow: {
    flexDirection: "row",
    width: "100%",
    marginTop: 13,
    gap: 7,
  },
  previewCardButton: {
    flex: 1,
    backgroundColor: "#0b63ce",
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: "center",
  },
  buyCardButton: {
    flex: 1,
    backgroundColor: "#4f772d",
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: "center",
  },
  personalizeCardButton: {
    flex: 1.25,
    backgroundColor: "#7b2cbf",
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: "center",
  },
  greetingButtonText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "900",
    textAlign: "center",
  },
  otherServicesTitle: {
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "900",
    textAlign: "center",
    marginTop: 8,
    marginBottom: 14,
  },
  selectedCardBadge: {
    backgroundColor: "#ffd21f",
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginTop: -12,
    marginBottom: 16,
  },
  selectedCardBadgeText: {
    color: "#111111",
    fontWeight: "900",
    textAlign: "center",
  },
  formCard: {
    width: "100%",
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 18,
    borderWidth: 2,
    borderColor: "#ffd21f",
  },
  inputLabel: {
    fontSize: 15,
    fontWeight: "900",
    color: "#0b63ce",
    marginTop: 8,
    marginBottom: 5,
  },
  input: {
    width: "100%",
    backgroundColor: "#f5f7fb",
    borderWidth: 1,
    borderColor: "#b8c4d8",
    borderRadius: 12,
    padding: 13,
    fontSize: 16,
    color: "#111",
  },
  messageInput: { minHeight: 105, textAlignVertical: "top" },
  counter: {
    alignSelf: "flex-end",
    color: "#64748b",
    fontSize: 13,
    marginTop: 4,
    marginBottom: 8,
  },
  counterLimit: { color: "#b42318", fontWeight: "900" },
  generateButton: {
    backgroundColor: "#7b2cbf",
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 12,
  },
  generateButtonText: { color: "#fff", fontSize: 17, fontWeight: "900" },
  paymentRequiredCard: {
    width: "100%",
    backgroundColor: "#ffffff",
    borderRadius: 18,
    padding: 18,
    marginTop: 16,
    borderWidth: 2,
    borderColor: "#f59e0b",
    alignItems: "center",
  },
  paymentRequiredTitle: {
    color: "#7c2d12",
    fontSize: 21,
    fontWeight: "900",
    textAlign: "center",
    marginBottom: 8,
  },
  paymentRequiredText: {
    color: "#334155",
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    marginBottom: 14,
  },
  shopifyPaymentWideButton: {
    width: "100%",
    backgroundColor: "#4f772d",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    marginTop: 4,
  },
  africaPaymentWideButton: {
    width: "100%",
    backgroundColor: "#008751",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    marginTop: 10,
  },
  resultCard: {
    width: "100%",
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 18,
    marginTop: 18,
    borderWidth: 2,
    borderColor: "#ffd21f",
    alignItems: "center",
  },
  resultTitle: {
    fontSize: 22,
    fontWeight: "900",
    color: "#0b63ce",
    marginBottom: 14,
  },
  largePlayButton: {
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: "#0b63ce",
    borderWidth: 7,
    borderColor: "#ffd21f",
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 8,
  },
  largePlayIcon: { color: "#fff", fontSize: 62, marginLeft: 9 },
  largePlayText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 14,
    marginTop: 3,
  },
  shareButton: {
    width: "100%",
    backgroundColor: "#25D366",
    paddingVertical: 15,
    borderRadius: 15,
    alignItems: "center",
    marginTop: 12,
  },
  downloadButton: {
    width: "100%",
    backgroundColor: "#7b2cbf",
    paddingVertical: 15,
    borderRadius: 15,
    alignItems: "center",
    marginTop: 10,
  },
  shareButtonText: { color: "#fff", fontSize: 16, fontWeight: "900" },
  paymentRow: { width: "100%", flexDirection: "row", gap: 10, marginTop: 10 },
  shopifyButton: {
    flex: 1,
    backgroundColor: "#4f772d",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
  },
  nigeriaButton: {
    flex: 1,
    backgroundColor: "#008751",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
  },
  paymentText: { color: "#fff", fontWeight: "900", textAlign: "center" },
  resultNote: {
    color: "#334155",
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    marginTop: 12,
  },
});
