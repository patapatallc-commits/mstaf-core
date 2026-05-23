import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const WHATSAPP_PHONE = '18622306637';

const API_BASE =
  Platform.OS === 'web'
    ? 'http://localhost:10000'
    : 'http://192.168.12.228:10000';

const translations = {
  en: {
    title: 'Welcome to PATAPATA Print-O-Matic',
    instructions:
      'Tap Continue on WhatsApp to begin.\n\n“Hello” will already be filled automatically.\n\nThen tap Send on WhatsApp to see the service menu.',
    continue: 'Continue on WhatsApp',
    testBackend: 'Test Backend',
    notNow: 'Not now',
    whatsappMessage: 'Hello',
    label: 'English',
  },
  es: {
    title: 'Bienvenido a PATAPATA Print-O-Matic',
    instructions:
      'Toca Continuar en WhatsApp para comenzar.\n\n“Hola” ya estará escrito automáticamente.\n\nLuego toca Enviar en WhatsApp para ver el menú de servicios.',
    continue: 'Continuar en WhatsApp',
    testBackend: 'Probar Backend',
    notNow: 'Ahora no',
    whatsappMessage: 'Hola',
    label: 'Español',
  },
  fr: {
    title: 'Bienvenue sur PATAPATA Print-O-Matic',
    instructions:
      'Appuyez sur Continuer sur WhatsApp pour commencer.\n\n“Bonjour” sera déjà rempli automatiquement.\n\nAppuyez ensuite sur Envoyer dans WhatsApp pour voir le menu des services.',
    continue: 'Continuer sur WhatsApp',
    testBackend: 'Tester Backend',
    notNow: 'Pas maintenant',
    whatsappMessage: 'Bonjour',
    label: 'Français',
  },
  de: {
    title: 'Willkommen bei PATAPATA Print-O-Matic',
    instructions:
      'Tippen Sie auf Weiter auf WhatsApp, um zu beginnen.\n\n“Hallo” wird automatisch ausgefüllt.\n\nTippen Sie dann in WhatsApp auf Senden, um das Servicemenü zu sehen.',
    continue: 'Weiter auf WhatsApp',
    testBackend: 'Backend testen',
    notNow: 'Nicht jetzt',
    whatsappMessage: 'Hallo',
    label: 'Deutsch',
  },
};

export default function HomeScreen() {
  const [showInstructions, setShowInstructions] = useState(false);
  const [language, setLanguage] = useState('en');

  const blinkAnim = useRef(new Animated.Value(1)).current;

  const currentText = translations[language] || translations.en;

  const showAlert = (title, message) => {
    if (Platform.OS === 'web') {
      window.alert(`${title}\n\n${message}`);
    } else {
      Alert.alert(title, message);
    }
  };

  const startPopupTimer = () => {
    setShowInstructions(false);

    setTimeout(() => {
      setShowInstructions(true);
    }, 3000);
  };

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(blinkAnim, {
          toValue: 0.25,
          duration: 500,
          useNativeDriver: true,
        }),
        Animated.timing(blinkAnim, {
          toValue: 1,
          duration: 500,
          useNativeDriver: true,
        }),
      ])
    ).start();

    startPopupTimer();

    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        startPopupTimer();
      }
    });

    return () => subscription.remove();
  }, []);

  const testBackend = async () => {
    console.log('Test Backend button clicked');

    try {
      const response = await fetch(`${API_BASE}/health`);
      const data = await response.json();

      console.log('BACKEND OK:', data);
      showAlert('Backend connected', 'Your server is working.');
    } catch (err) {
      console.log('BACKEND ERROR:', err);
      showAlert('Backend failed', 'Could not connect to the server.');
    }
  };

  const openWhatsApp = async () => {
    const selectedMessage = translations[language]?.whatsappMessage || 'Hello';

    console.log('Selected language:', language);
    console.log('WhatsApp message:', selectedMessage);

    const message = encodeURIComponent(selectedMessage);

    const whatsappAppUrl = `whatsapp://send?phone=${WHATSAPP_PHONE}&text=${message}`;
    const whatsappWebUrl = `https://wa.me/${WHATSAPP_PHONE}?text=${message}`;

    setShowInstructions(false);

    try {
      const supported = await Linking.canOpenURL(whatsappAppUrl);

      if (supported) {
        await Linking.openURL(whatsappAppUrl);
      } else {
        await Linking.openURL(whatsappWebUrl);
      }
    } catch (err) {
      console.log('WHATSAPP OPEN ERROR:', err);
      await Linking.openURL(whatsappWebUrl);
    }
  };

  return (
    <View style={styles.container}>
      <Pressable
        style={styles.logoButton}
        onPress={() => setShowInstructions(true)}
      >
        <Animated.Image
          source={require('../../assets/images/printomatic-logo.png')}
          style={[styles.logo, { opacity: blinkAnim }]}
          resizeMode="contain"
        />
      </Pressable>

      <Modal
        visible={showInstructions}
        transparent
        animationType="fade"
        presentationStyle="overFullScreen"
        statusBarTranslucent
        onRequestClose={() => setShowInstructions(false)}
      >
        <View style={styles.modalOverlay} pointerEvents="auto">
          <View style={styles.modalBox} pointerEvents="auto">
            <Text style={styles.title}>{currentText.title}</Text>

            <Text style={styles.instructions}>
              {currentText.instructions}
            </Text>

            <View style={styles.languageRow}>
              {Object.keys(translations).map(code => {
                const isActive = language === code;

                return (
                  <Pressable
                    key={code}
                    onPress={() => setLanguage(code)}
                    style={[
                      styles.languageButton,
                      isActive && styles.languageButtonActive,
                    ]}
                    hitSlop={8}
                  >
                    <Text
                      style={[
                        styles.languageText,
                        isActive && styles.languageTextActive,
                      ]}
                    >
                      {translations[code].label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.previewText}>
              WhatsApp message: “{currentText.whatsappMessage}”
            </Text>

            <Pressable
              style={styles.continueButton}
              onPress={openWhatsApp}
              hitSlop={6}
            >
              <Text style={styles.continueText}>
                {currentText.continue}
              </Text>
            </Pressable>

            <Pressable
              style={styles.testButton}
              onPress={testBackend}
              hitSlop={6}
            >
              <Text style={styles.testText}>
                {currentText.testBackend}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => setShowInstructions(false)}
              style={styles.cancelButton}
              hitSlop={8}
            >
              <Text style={styles.cancelText}>
                {currentText.notNow}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050b18',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  logoButton: {
    width: '92%',
    maxWidth: 420,
    aspectRatio: 1,
    borderRadius: 36,
    overflow: 'hidden',
    zIndex: 1,
  },
  logo: {
    width: '100%',
    height: '100%',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 22,
    zIndex: 9999,
    elevation: 9999,
  },
  modalBox: {
    width: '100%',
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 24,
    zIndex: 10000,
    elevation: 10000,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#071022',
    marginBottom: 16,
    textAlign: 'center',
  },
  instructions: {
    fontSize: 16,
    lineHeight: 23,
    color: '#172033',
    marginBottom: 18,
    textAlign: 'center',
  },
  languageRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 12,
  },
  languageButton: {
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 8,
    zIndex: 10001,
  },
  languageButtonActive: {
    backgroundColor: '#0b5ed7',
  },
  languageText: {
    color: '#0b5ed7',
    fontSize: 15,
    fontWeight: '700',
  },
  languageTextActive: {
    color: '#ffffff',
  },
  previewText: {
    textAlign: 'center',
    color: '#444',
    fontSize: 14,
    marginBottom: 14,
    fontWeight: '600',
  },
  continueButton: {
    backgroundColor: '#25D366',
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: 'center',
    zIndex: 10001,
    elevation: 10001,
    cursor: 'pointer',
  },
  continueText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '800',
  },
  testButton: {
    backgroundColor: '#0b5ed7',
    paddingVertical: 13,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 12,
    zIndex: 10001,
    elevation: 10001,
    cursor: 'pointer',
  },
  testText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  cancelButton: {
    zIndex: 10001,
    elevation: 10001,
  },
  cancelText: {
    marginTop: 16,
    textAlign: 'center',
    color: '#444',
    fontSize: 15,
  },
});