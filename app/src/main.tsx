import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { App } from './App.tsx';
import { activateLocale, i18n, LOCALES, negotiateLocale, RELEASED, savedLocale } from './i18n/index.ts';
import { installTooltips } from './shell/tooltips.ts';
import './styles.css';

// ?lang=pseudo shows accented, longer text in dev to find hard-coded and clipped strings.
const pseudo = import.meta.env.DEV && new URLSearchParams(location.search).get('lang') === 'pseudo';
await activateLocale(pseudo ? 'pseudo' : negotiateLocale(savedLocale(), navigator.languages, import.meta.env.DEV ? LOCALES : RELEASED));
createRoot(document.getElementById('root')!).render(<I18nProvider i18n={i18n}><App /></I18nProvider>);
installTooltips();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(e => console.error('service worker', e));
}
