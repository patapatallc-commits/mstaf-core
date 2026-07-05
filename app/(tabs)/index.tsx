import React, { useEffect, useState } from "react";
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
} from "react-native";

const PHONE = "18622306637";
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.patapata.printomatic";

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
    powered: "由 Patapata LLC 提供支持",
    scanTitle: "扫码下载我们的 Google Play 商店应用",
    scanSub: "从 Google Play 打开 Print-O-Matic 应用。",
    playButton: "⬇️ 从 Google Play 下载",
    agentMsg: "我想联系 Printo Studio 客服。",
  },
};

const SERVICES = {
  en: [
    { emoji: "🎵", title: "Buy Printo Music", sub: "Official songs, beats, instrumentals, and albums.", message: "I want to buy Printo music." },
    { emoji: "🎂", title: "Greeting Video Cards", sub: "Birthday, wedding, anniversary, graduation, and special greetings.", message: "I want to order a Printo greeting video card." },
    { emoji: "🎭", title: "Personalized Printo Videos", sub: "Printo speaks, sings, dances, and greets someone by name.", message: "I want a personalized Printo video." },
    { emoji: "🎬", title: "AI Video Creation", sub: "Talking photos, dancing mascots, social media videos, and adverts.", message: "I want AI video creation service." },
    { emoji: "🎤", title: "Music & Voice Studio", sub: "Songs, jingles, voice-overs, voice cloning, and sound effects.", message: "I want music or voice creation service." },
    { emoji: "🛍️", title: "Digital Downloads", sub: "Templates, courses, flyers, eBooks, logos, and AI prompts.", message: "I want digital downloads." },
    { emoji: "🖨️", title: "Print-O-Matic Services", sub: "Print documents, photos, cards, flyers, editing, and shipping.", message: "I want Print-O-Matic services." },
  ],
  es: [
    { emoji: "🎵", title: "Comprar música de Printo", sub: "Canciones oficiales, ritmos, instrumentales y álbumes.", message: "Quiero comprar música de Printo." },
    { emoji: "🎂", title: "Tarjetas de video de saludo", sub: "Cumpleaños, bodas, aniversarios, graduaciones y saludos especiales.", message: "Quiero ordenar una tarjeta de video de saludo de Printo." },
    { emoji: "🎭", title: "Videos personalizados de Printo", sub: "Printo habla, canta, baila y saluda a alguien por su nombre.", message: "Quiero un video personalizado de Printo." },
    { emoji: "🎬", title: "Creación de videos con IA", sub: "Fotos que hablan, mascotas bailando, videos para redes y anuncios.", message: "Quiero servicio de creación de video con IA." },
    { emoji: "🎤", title: "Estudio de música y voz", sub: "Canciones, jingles, voces, clonación de voz y efectos de sonido.", message: "Quiero servicio de música o voz." },
    { emoji: "🛍️", title: "Descargas digitales", sub: "Plantillas, cursos, flyers, eBooks, logos y prompts de IA.", message: "Quiero descargas digitales." },
    { emoji: "🖨️", title: "Servicios Print-O-Matic", sub: "Impresión, fotos, tarjetas, flyers, edición y envío.", message: "Quiero servicios Print-O-Matic." },
  ],
  fr: [
    { emoji: "🎵", title: "Acheter la musique Printo", sub: "Chansons, beats, instrumentaux et albums officiels.", message: "Je veux acheter de la musique Printo." },
    { emoji: "🎂", title: "Cartes vidéo de vœux", sub: "Anniversaire, mariage, remise de diplôme et vœux spéciaux.", message: "Je veux commander une carte vidéo Printo." },
    { emoji: "🎭", title: "Vidéos Printo personnalisées", sub: "Printo parle, chante, danse et salue quelqu’un par son nom.", message: "Je veux une vidéo Printo personnalisée." },
    { emoji: "🎬", title: "Création vidéo IA", sub: "Photos parlantes, mascottes dansantes, vidéos sociales et publicités.", message: "Je veux un service de création vidéo IA." },
    { emoji: "🎤", title: "Studio musique et voix", sub: "Chansons, jingles, voix off, clonage vocal et effets sonores.", message: "Je veux un service de musique ou de voix." },
    { emoji: "🛍️", title: "Téléchargements numériques", sub: "Modèles, cours, flyers, eBooks, logos et prompts IA.", message: "Je veux des téléchargements numériques." },
    { emoji: "🖨️", title: "Services Print-O-Matic", sub: "Documents, photos, cartes, flyers, édition et livraison.", message: "Je veux les services Print-O-Matic." },
  ],
  de: [
    { emoji: "🎵", title: "Printo Musik kaufen", sub: "Offizielle Songs, Beats, Instrumentals und Alben.", message: "Ich möchte Printo Musik kaufen." },
    { emoji: "🎂", title: "Grußvideo-Karten", sub: "Geburtstag, Hochzeit, Jahrestag, Abschluss und besondere Grüße.", message: "Ich möchte eine Printo Grußvideo-Karte bestellen." },
    { emoji: "🎭", title: "Personalisierte Printo Videos", sub: "Printo spricht, singt, tanzt und grüßt jemanden mit Namen.", message: "Ich möchte ein personalisiertes Printo Video." },
    { emoji: "🎬", title: "KI-Videoerstellung", sub: "Sprechende Fotos, tanzende Maskottchen, Social-Media-Videos und Werbung.", message: "Ich möchte KI-Videoerstellung." },
    { emoji: "🎤", title: "Musik- & Sprachstudio", sub: "Songs, Jingles, Voice-over, Stimmklonen und Soundeffekte.", message: "Ich möchte Musik- oder Sprachservice." },
    { emoji: "🛍️", title: "Digitale Downloads", sub: "Vorlagen, Kurse, Flyer, eBooks, Logos und KI-Prompts.", message: "Ich möchte digitale Downloads." },
    { emoji: "🖨️", title: "Print-O-Matic Services", sub: "Dokumente, Fotos, Karten, Flyer, Bearbeitung und Versand.", message: "Ich möchte Print-O-Matic Services." },
  ],
  pt: [
    { emoji: "🎵", title: "Comprar música Printo", sub: "Músicas oficiais, beats, instrumentais e álbuns.", message: "Quero comprar música Printo." },
    { emoji: "🎂", title: "Cartões de vídeo de saudação", sub: "Aniversário, casamento, formatura e mensagens especiais.", message: "Quero pedir um cartão de vídeo Printo." },
    { emoji: "🎭", title: "Vídeos Printo personalizados", sub: "Printo fala, canta, dança e cumprimenta alguém pelo nome.", message: "Quero um vídeo Printo personalizado." },
    { emoji: "🎬", title: "Criação de vídeo com IA", sub: "Fotos falantes, mascotes dançando, vídeos sociais e anúncios.", message: "Quero serviço de criação de vídeo com IA." },
    { emoji: "🎤", title: "Estúdio de música e voz", sub: "Músicas, jingles, narração, clonagem de voz e efeitos sonoros.", message: "Quero serviço de música ou voz." },
    { emoji: "🛍️", title: "Downloads digitais", sub: "Modelos, cursos, flyers, eBooks, logos e prompts de IA.", message: "Quero downloads digitais." },
    { emoji: "🖨️", title: "Serviços Print-O-Matic", sub: "Documentos, fotos, cartões, flyers, edição e envio.", message: "Quero serviços Print-O-Matic." },
  ],
  ar: [
    { emoji: "🎵", title: "شراء موسيقى برينتو", sub: "أغانٍ رسمية وإيقاعات وموسيقى وألبومات.", message: "أريد شراء موسيقى Printo." },
    { emoji: "🎂", title: "بطاقات فيديو للتهنئة", sub: "عيد ميلاد، زفاف، تخرج، ذكرى ومناسبات خاصة.", message: "أريد طلب بطاقة فيديو تهنئة من Printo." },
    { emoji: "🎭", title: "فيديوهات برينتو مخصصة", sub: "برينتو يتحدث ويغني ويرقص ويحيي الشخص بالاسم.", message: "أريد فيديو Printo مخصصًا." },
    { emoji: "🎬", title: "إنشاء فيديو بالذكاء الاصطناعي", sub: "صور ناطقة، شخصيات راقصة، فيديوهات للسوشيال وإعلانات.", message: "أريد خدمة إنشاء فيديو بالذكاء الاصطناعي." },
    { emoji: "🎤", title: "استوديو الموسيقى والصوت", sub: "أغانٍ، إعلانات صوتية، تعليق صوتي، استنساخ صوتي ومؤثرات.", message: "أريد خدمة موسيقى أو صوت." },
    { emoji: "🛍️", title: "تنزيلات رقمية", sub: "قوالب، دورات، منشورات، كتب إلكترونية، شعارات وبرومبتات.", message: "أريد تنزيلات رقمية." },
    { emoji: "🖨️", title: "خدمات Print-O-Matic", sub: "طباعة مستندات وصور وبطاقات ومنشورات وتعديل وشحن.", message: "أريد خدمات Print-O-Matic." },
  ],
  zh: [
    { emoji: "🎵", title: "购买 Printo 音乐", sub: "官方歌曲、节拍、伴奏和专辑。", message: "我想购买 Printo 音乐。" },
    { emoji: "🎂", title: "祝福视频卡", sub: "生日、婚礼、周年、毕业和特别祝福。", message: "我想订购 Printo 祝福视频卡。" },
    { emoji: "🎭", title: "个性化 Printo 视频", sub: "Printo 可以说话、唱歌、跳舞，并按名字问候。", message: "我想要个性化 Printo 视频。" },
    { emoji: "🎬", title: "AI 视频制作", sub: "会说话的照片、跳舞吉祥物、社交媒体视频和广告。", message: "我想要 AI 视频制作服务。" },
    { emoji: "🎤", title: "音乐与语音工作室", sub: "歌曲、广告歌、配音、声音克隆和音效。", message: "我想要音乐或语音制作服务。" },
    { emoji: "🛍️", title: "数字下载", sub: "模板、课程、传单、电子书、标志和 AI 提示词。", message: "我想要数字下载。" },
    { emoji: "🖨️", title: "Print-O-Matic 服务", sub: "打印文件、照片、卡片、传单、编辑和配送。", message: "我想要 Print-O-Matic 服务。" },
  ],
};

export default function HomeScreen() {
  const [selectedLanguage, setSelectedLanguage] = useState("en");
  const [showStudio, setShowStudio] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const fadeAnim = useState(new Animated.Value(1))[0];

  const t = TEXT[selectedLanguage] || TEXT.en;
  const services = SERVICES[selectedLanguage] || SERVICES.en;

  useEffect(() => {
    const blink = Animated.loop(
      Animated.sequence([
        Animated.timing(fadeAnim, { toValue: 0.35, duration: 350, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
      ])
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
    Linking.openURL(`https://wa.me/${PHONE}?text=${encodeURIComponent(finalMessage)}`);
  };

  return showSplash ? (
    <SafeAreaView style={styles.splashScreen}>
      <Animated.Image
        source={require("../../assets/images/splash.png")}
        style={[styles.splashImage, { opacity: fadeAnim }]}
        resizeMode="contain"
      />
    </SafeAreaView>
  ) : !showStudio ? (
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

        <TouchableOpacity style={styles.mainButton} onPress={() => setShowStudio(true)}>
          <Text style={styles.mainButtonText}>{t.explore}</Text>
        </TouchableOpacity>

        <Text style={styles.footer}>{t.powered}</Text>
      </View>
    </SafeAreaView>
  ) : (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scrollWrap}>
        <Image
          source={require("../../assets/images/printomatic-logo.png")}
          style={styles.smallLogo}
          resizeMode="contain"
        />

        <Text style={styles.title}>{t.studioTitle}</Text>
        <Text style={styles.subtitle}>{t.subtitle}</Text>

        {services.map((item) => (
          <TouchableOpacity
            key={item.title}
            style={styles.card}
            onPress={() => openWhatsApp(item.message)}
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
});