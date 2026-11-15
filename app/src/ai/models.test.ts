import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cachedModel, downloadModel, MODEL_CACHE, SEGMENTATION, type Model } from './models.ts';

const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i * 7);
const model: Model = { ...SEGMENTATION, url: 'https://models.test/m.onnx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

// A fetch that streams `body` in 300-byte chunks with `status`.
function fakeFetch(body: Uint8Array, status = 200) {
  return (async () => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < body.length; i += 300) c.enqueue(body.slice(i, i + 300)); c.close(); },
  }), { status })) as typeof fetch;
}
// Cache Storage with one cache, as a map of URL to bytes.
function fakeCaches() {
  const store = new Map<string, Uint8Array<ArrayBuffer>>();
  const names: string[] = [];
  const cache = {
    async match(url: string) { const b = store.get(url); return b ? new Response(b) : undefined; },
    async put(url: string, r: Response) { store.set(url, new Uint8Array(await r.arrayBuffer())); },
  };
  return { store, names, caches: { async open(n: string) { names.push(n); return cache; } } as unknown as CacheStorage };
}

test('downloadModel checks size and sha256 before it keeps the model in Cache Storage', async t => {
  const c = fakeCaches();
  Object.assign(globalThis, { caches: c.caches });
  t.after(() => { delete (globalThis as { caches?: CacheStorage }).caches; });
  const seen: number[] = [];
  t.mock.method(globalThis, 'fetch', fakeFetch(bytes));
  const got = await downloadModel(model, n => seen.push(n));
  assert.deepEqual(new Uint8Array(got), bytes);
  assert.deepEqual(seen, [300, 600, 900, 1000]);
  assert.deepEqual(c.names, [MODEL_CACHE]);
  assert.deepEqual(new Uint8Array(await cachedModel(model) ?? new ArrayBuffer(0)), bytes);

  const other = { ...model, url: 'https://models.test/other.onnx' };
  const damaged = bytes.slice(); damaged[5] ^= 1;
  t.mock.method(globalThis, 'fetch', fakeFetch(damaged));
  await assert.rejects(downloadModel(other, () => {}), /damaged/);
  t.mock.method(globalThis, 'fetch', fakeFetch(Uint8Array.from([...bytes, 1])));
  await assert.rejects(downloadModel(other, () => {}), /damaged/);
  t.mock.method(globalThis, 'fetch', fakeFetch(bytes.slice(1)));
  await assert.rejects(downloadModel(other, () => {}), /damaged/);
  t.mock.method(globalThis, 'fetch', fakeFetch(new Uint8Array(0), 404));
  await assert.rejects(downloadModel(other, () => {}), /HTTP 404/);
  assert.equal(c.store.has(other.url), false, 'nothing kept after a failed download');
  assert.equal(await cachedModel(other), null);
});

test('cachedModel is null without Cache Storage', async () => {
  assert.equal(typeof caches, 'undefined');
  assert.equal(await cachedModel(model), null);
});
