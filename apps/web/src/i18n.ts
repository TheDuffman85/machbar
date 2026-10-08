import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import de from './locales/de.json';

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, de: { translation: de satisfies typeof en } },
  lng: navigator.language.startsWith('de') ? 'de' : 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});
export default i18n;
