import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { thirdPartyNotices } from './scripts/third-party.mjs';

// SharedArrayBuffer and WASM threads need cross-origin isolation; every host must send these.
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

// Website files (content pages, their images, crawler files) are not part of the offline app.
const SITE_ONLY = /^(img\/|licenses\/|[^/]+\/index\.html$|site\.css$|og-image\.png$|robots\.txt$|sitemap\.xml$|llms\.txt$)/;

function notices(): Plugin {
  return {
    name: 'photobaer-notices',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'licenses/third-party.txt', source: thirdPartyNotices(fileURLToPath(new URL('.', import.meta.url))) });
    },
  };
}

// Lists every built file so the service worker can precache the whole app for offline use,
// and stamps sw.js with a content hash so every changed build installs a new worker.
function precache(): Plugin {
  let outDir = '';
  return {
    name: 'photobaer-precache',
    apply: 'build',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() {
      const files = (readdirSync(outDir, { recursive: true, withFileTypes: true }))
        .filter(d => d.isFile())
        .map(d => relative(outDir, join(d.parentPath, d.name)).replaceAll('\\', '/'))
        .filter(f => f !== 'sw.js' && f !== 'precache.json' && !SITE_ONLY.test(f));
      writeFileSync(join(outDir, 'precache.json'), JSON.stringify(files));
      const hash = createHash('sha256');
      for (const f of files.sort()) hash.update(f).update(readFileSync(join(outDir, f)));
      const sw = join(outDir, 'sw.js');
      const src = readFileSync(sw, 'utf8');
      const out = src.replace("const CACHE = 'photobaer';", `const CACHE = 'photobaer-${hash.digest('hex').slice(0, 16)}';`);
      if (out === src) throw new Error('sw.js: CACHE declaration not found');
      writeFileSync(sw, out);
    },
  };
}

// The app version is the newest released CHANGELOG.md section, which is also the release notes.
const version = /^## \[(\d+\.\d+\.\d+)\]/m.exec(readFileSync(new URL('./CHANGELOG.md', import.meta.url), 'utf8'))?.[1] ?? '0.0.0';

export default defineConfig({
  root: 'app',
  base: './',
  plugins: [react(), notices(), precache()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { headers },
  preview: { headers },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2023' },
  worker: { format: 'es' },
});
