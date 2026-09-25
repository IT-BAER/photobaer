import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// SharedArrayBuffer and WASM threads need cross-origin isolation; every host must send these.
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

// Lists every built file so the service worker can precache the whole app for offline use.
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
        .filter(f => f !== 'sw.js' && f !== 'precache.json');
      writeFileSync(join(outDir, 'precache.json'), JSON.stringify(files));
    },
  };
}

export default defineConfig({
  root: 'app',
  base: './',
  plugins: [react(), precache()],
  server: { headers },
  preview: { headers },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2023' },
  worker: { format: 'es' },
});
