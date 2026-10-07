// UI language: Lingui with English source text in code and one compiled catalog per language (docs/I18N.md).
import { i18n } from '@lingui/core';

export { i18n };

// Keep in sync with lingui.config.ts (checked by i18n.test.ts).
export const LOCALES = ['en', 'de', 'fr', 'es', 'pt-BR', 'ja', 'ko', 'zh-Hans', 'ru', 'tr', 'pl', 'it'] as const;
export type Locale = (typeof LOCALES)[number];
export const SOURCE_LOCALE: Locale = 'en';
// Languages users can get; all ship as unreviewed drafts until native review (docs/I18N.md).
export const RELEASED: readonly Locale[] = LOCALES;

const STORE_KEY = 'photobaer:language';

function isIn(list: readonly Locale[], l: string | null | undefined): l is Locale {
  return (list as readonly string[]).includes(l ?? '');
}

// Shipped locale for one browser language tag: exact match, else same language and script (pt-PT -> pt-BR,
// zh-CN -> zh-Hans; zh-TW is Traditional Chinese and has no match).
function match(tag: string, available: readonly Locale[]): Locale | null {
  if (isIn(available, tag)) return tag;
  let want: Intl.Locale;
  try { want = new Intl.Locale(tag).maximize(); } catch { return null; }
  for (const l of available) {
    const have = new Intl.Locale(l).maximize();
    if (have.language === want.language && have.script === want.script) return l;
  }
  return null;
}

export function negotiateLocale(saved: string | null, browser: readonly string[], available = RELEASED): Locale {
  if (isIn(available, saved)) return saved;
  for (const tag of browser) {
    const l = match(tag, available);
    if (l) return l;
  }
  return SOURCE_LOCALE;
}

export function savedLocale(): string | null {
  try { return globalThis.localStorage?.getItem(STORE_KEY) ?? null; } catch { return null; }
}

// The new language applies on the next start, like Photoshop's UI language setting.
export function saveLocale(locale: Locale): void {
  try { globalThis.localStorage?.setItem(STORE_KEY, locale); } catch { /* storage unavailable: session only */ }
}

// Loads and activates a compiled catalog; production code carries message ids only, so English needs one too.
// import.meta.glob is Vite-only: it stays inside the function so node tests can import this module.
export async function activateLocale(locale: Locale | 'pseudo'): Promise<void> {
  const catalogs = import.meta.glob<{ messages: Record<string, string> }>('../locales/*/messages.po');
  const load = catalogs[`../locales/${locale}/messages.po`];
  const { messages } = load ? await load() : { messages: {} };
  i18n.loadAndActivate({ locale, messages });
  document.documentElement.lang = locale === 'pseudo' ? 'en' : locale;
}

// Node tests and the worker render the English source text that the macros keep outside production builds.
i18n.loadAndActivate({ locale: SOURCE_LOCALE, messages: {} });
