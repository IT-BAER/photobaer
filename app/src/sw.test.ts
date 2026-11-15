import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('a new service worker deletes old app caches but keeps the downloaded models', async () => {
  const keys = new Set(['photobaer', 'photobaer-0123456789abcdef', 'photobaer-models']);
  const listeners = new Map<string, (e: { waitUntil(p: Promise<unknown>): void }) => void>();
  let done: Promise<unknown> = Promise.resolve();
  const self = {
    addEventListener: (type: string, f: (e: { waitUntil(p: Promise<unknown>): void }) => void) => listeners.set(type, f),
    clients: { claim: async () => {} },
  };
  const caches = { keys: async () => [...keys], delete: async (k: string) => keys.delete(k) };
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, caches });
  listeners.get('activate')!({ waitUntil: p => { done = p; } });
  await done;
  assert.deepEqual([...keys], ['photobaer', 'photobaer-models']);
});
