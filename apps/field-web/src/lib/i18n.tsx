import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

// Field strings for the navigation shell, primary actions, and emergency
// helplines. Hindi and Tamil are first-pass translations: a deploying authority
// must have them reviewed by native speakers before public use, and any key
// missing from a language falls back to English rather than rendering blank.
const en = {
  "nav.conditions": "Conditions",
  "nav.report": "Report",
  "nav.queue": "Queue",
  "nav.alerts": "Alerts",
  "nav.route": "Route",
  "nav.label": "Field navigation",
  "net.online": "Online",
  "net.offline": "Offline",
  "net.connected": "Connected",
  "net.offlineReady": "Offline-ready",
  "net.lastSync": "Last sync completed",
  "net.queueReady": "Offline queue is ready",
  "header.install": "Install",
  "header.installLabel": "Install floodRISE Field",
  "header.language": "Language",
  "header.helplines": "Emergency helplines",
  "header.sos": "112",
  "conditions.title": "Current conditions",
  "conditions.report": "Report flooding",
  "conditions.route": "Find a lower-risk route",
  "alerts.title": "Alerts",
  "helplines.title": "Emergency helplines",
  "helplines.intro": "Tap a number to call. Calls work without internet.",
  "helplines.call": "Call",
  "helplines.safety": "Do not enter floodwater. In an emergency call 112.",
  "helplines.verify":
    "Numbers can differ by state and district. Confirm local helplines with your district administration.",
  "contact.erss-112": "Emergency: police, fire, ambulance",
  "contact.ndma-1078": "National disaster helpline",
  "contact.state-1070": "State disaster control room",
  "contact.district-1077": "District disaster control room",
  "contact.ambulance-108": "Ambulance",
  "contact.fire-101": "Fire and rescue",
  "contact.police-100": "Police",
  "contact.women-1091": "Women helpline",
  "contact.child-1098": "Childline",
  "contact.gcc-1913": "Greater Chennai Corporation helpline"
} as const;

export type MessageKey = keyof typeof en;

const hi: Partial<Record<MessageKey, string>> = {
  "nav.conditions": "स्थिति",
  "nav.report": "रिपोर्ट",
  "nav.queue": "कतार",
  "nav.alerts": "चेतावनी",
  "nav.route": "मार्ग",
  "nav.label": "फ़ील्ड नेविगेशन",
  "net.online": "ऑनलाइन",
  "net.offline": "ऑफ़लाइन",
  "net.connected": "जुड़ा हुआ",
  "net.offlineReady": "ऑफ़लाइन के लिए तैयार",
  "net.lastSync": "पिछला सिंक पूरा हुआ",
  "net.queueReady": "ऑफ़लाइन कतार तैयार है",
  "header.install": "इंस्टॉल करें",
  "header.installLabel": "floodRISE Field इंस्टॉल करें",
  "header.language": "भाषा",
  "header.helplines": "आपातकालीन हेल्पलाइन",
  "conditions.title": "वर्तमान स्थिति",
  "conditions.report": "बाढ़ की सूचना दें",
  "conditions.route": "कम जोखिम वाला मार्ग खोजें",
  "alerts.title": "चेतावनियाँ",
  "helplines.title": "आपातकालीन हेल्पलाइन",
  "helplines.intro": "कॉल करने के लिए नंबर पर टैप करें। कॉल बिना इंटरनेट के भी लगती है।",
  "helplines.call": "कॉल करें",
  "helplines.safety": "बाढ़ के पानी में न जाएँ। आपात स्थिति में 112 पर कॉल करें।",
  "helplines.verify":
    "नंबर राज्य और ज़िले के अनुसार अलग हो सकते हैं। स्थानीय हेल्पलाइन की पुष्टि अपने ज़िला प्रशासन से करें।",
  "contact.erss-112": "आपातकालीन सेवा: पुलिस, अग्निशमन, एम्बुलेंस",
  "contact.ndma-1078": "राष्ट्रीय आपदा हेल्पलाइन",
  "contact.state-1070": "राज्य आपदा नियंत्रण कक्ष",
  "contact.district-1077": "ज़िला आपदा नियंत्रण कक्ष",
  "contact.ambulance-108": "एम्बुलेंस",
  "contact.fire-101": "अग्निशमन और बचाव",
  "contact.police-100": "पुलिस",
  "contact.women-1091": "महिला हेल्पलाइन",
  "contact.child-1098": "चाइल्डलाइन",
  "contact.gcc-1913": "ग्रेटर चेन्नई कॉर्पोरेशन हेल्पलाइन"
};

const ta: Partial<Record<MessageKey, string>> = {
  "nav.conditions": "நிலைமை",
  "nav.report": "புகார்",
  "nav.queue": "வரிசை",
  "nav.alerts": "எச்சரிக்கை",
  "nav.route": "வழி",
  "nav.label": "கள வழிசெலுத்தல்",
  "net.online": "ஆன்லைன்",
  "net.offline": "ஆஃப்லைன்",
  "net.connected": "இணைக்கப்பட்டது",
  "net.offlineReady": "ஆஃப்லைனுக்குத் தயார்",
  "net.lastSync": "கடைசி ஒத்திசைவு முடிந்தது",
  "net.queueReady": "ஆஃப்லைன் வரிசை தயார்",
  "header.install": "நிறுவு",
  "header.installLabel": "floodRISE Field-ஐ நிறுவு",
  "header.language": "மொழி",
  "header.helplines": "அவசர உதவி எண்கள்",
  "conditions.title": "தற்போதைய நிலைமை",
  "conditions.report": "வெள்ளத்தைப் புகாரளி",
  "conditions.route": "குறைந்த ஆபத்துள்ள வழியைக் கண்டறி",
  "alerts.title": "எச்சரிக்கைகள்",
  "helplines.title": "அவசர உதவி எண்கள்",
  "helplines.intro": "அழைக்க எண்ணைத் தட்டவும். இணையம் இல்லாமலும் அழைக்கலாம்.",
  "helplines.call": "அழை",
  "helplines.safety": "வெள்ள நீரில் இறங்க வேண்டாம். அவசர நிலையில் 112-ஐ அழைக்கவும்.",
  "helplines.verify":
    "எண்கள் மாநிலம் மற்றும் மாவட்டத்தைப் பொறுத்து மாறுபடலாம். உள்ளூர் உதவி எண்களை உங்கள் மாவட்ட நிர்வாகத்திடம் உறுதிப்படுத்தவும்.",
  "contact.erss-112": "அவசர சேவை: காவல், தீயணைப்பு, ஆம்புலன்ஸ்",
  "contact.ndma-1078": "தேசிய பேரிடர் உதவி எண்",
  "contact.state-1070": "மாநில பேரிடர் கட்டுப்பாட்டு அறை",
  "contact.district-1077": "மாவட்ட பேரிடர் கட்டுப்பாட்டு அறை",
  "contact.ambulance-108": "ஆம்புலன்ஸ்",
  "contact.fire-101": "தீயணைப்பு மற்றும் மீட்பு",
  "contact.police-100": "காவல்துறை",
  "contact.women-1091": "பெண்கள் உதவி எண்",
  "contact.child-1098": "குழந்தைகள் உதவி எண்",
  "contact.gcc-1913": "பெருநகர சென்னை மாநகராட்சி உதவி எண்"
};

export const LANGUAGES = [
  { code: "en", name: "English", short: "EN", locale: "en-IN" },
  { code: "hi", name: "हिन्दी", short: "हिं", locale: "hi-IN" },
  { code: "ta", name: "தமிழ்", short: "த", locale: "ta-IN" }
] as const;

export type Language = (typeof LANGUAGES)[number]["code"];

const dictionaries: Record<Language, Partial<Record<MessageKey, string>>> = { en, hi, ta };
const STORAGE_KEY = "floodrise.field.language";

function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.code === value);
}

/** Stored choice wins; otherwise the first browser language we support. */
export function resolveLanguage(stored: string | null, preferred: readonly string[]): Language {
  if (isLanguage(stored)) return stored;
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0];
    if (isLanguage(base)) return base;
  }
  return "en";
}

export function translate(language: Language, key: MessageKey): string {
  return dictionaries[language][key] ?? en[key];
}

function readStoredLanguage() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

type I18nValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: MessageKey) => string;
};

const I18nContext = createContext<I18nValue>({
  language: "en",
  setLanguage: () => undefined,
  t: (key) => en[key]
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() =>
    resolveLanguage(readStoredLanguage(), typeof navigator === "undefined" ? [] : navigator.languages ?? [])
  );

  useEffect(() => {
    document.documentElement.lang = LANGUAGES.find((item) => item.code === language)!.locale;
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing can refuse storage; the choice still applies this session.
    }
  }, []);

  const value = useMemo<I18nValue>(
    () => ({ language, setLanguage, t: (key) => translate(language, key) }),
    [language, setLanguage]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
