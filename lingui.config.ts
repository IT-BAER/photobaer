import { defineConfig } from '@lingui/cli';
import { formatter } from '@lingui/format-po';

// English is the source text in code; pseudo is an accented, longer English for layout checks in dev.
export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'de', 'fr', 'es', 'pt-BR', 'ja', 'ko', 'zh-Hans', 'ru', 'tr', 'pl', 'it', 'pseudo'],
  pseudoLocale: 'pseudo',
  // File origins without line numbers: moving code does not rewrite every catalog.
  format: formatter({ lineNumbers: false }),
  fallbackLocales: { default: 'en' },
  catalogs: [{ path: '<rootDir>/app/src/locales/{locale}/messages', include: ['<rootDir>/app/src'], exclude: ['**/*.test.ts', '**/engine-pkg/**'] }],
});
