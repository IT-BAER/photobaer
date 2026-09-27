import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDir } from '../fake-opfs.ts';
import { FontStore, type FontIndex, type FontRecord } from './store.ts';

// IndexedDB stand-in: the records outlive every store opened over it, like the real database.
function memoryIndex(): FontIndex & { rows: Map<string, FontRecord> } {
  const rows = new Map<string, FontRecord>();
  return { rows, all: async () => [...rows.values()], put: async r => { rows.set(r.hash, r); } };
}

test('an uploaded font is stored once by hash and survives reopening the store', async () => {
  const root = new FakeDir();
  const index = memoryIndex();
  const bytes = new Uint8Array([0, 1, 0, 0, 7, 7, 7]);
  const store = await FontStore.fromRoot(root as unknown as FileSystemDirectoryHandle, index);
  const a = await store.put('A.ttf', bytes);
  const b = await store.put('Copy of A.ttf', bytes);
  assert.equal(a.fresh, true);
  assert.equal(b.fresh, false, 'the same bytes are not stored again');
  assert.equal(b.record.name, 'A.ttf');
  const dir = await root.getDirectoryHandle('fonts');
  assert.deepEqual([...dir.entries.keys()], [a.record.hash]);
  assert.equal(index.rows.size, 1);
  assert.match(a.record.hash, /^[0-9a-f]{64}$/);

  const reopened = await FontStore.fromRoot(root as unknown as FileSystemDirectoryHandle, index);
  const all = await reopened.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].record.name, 'A.ttf');
  assert.deepEqual(all[0].bytes, bytes);
});

test('an index row whose file is gone is skipped', async () => {
  const root = new FakeDir();
  const index = memoryIndex();
  const store = await FontStore.fromRoot(root as unknown as FileSystemDirectoryHandle, index);
  const { record } = await store.put('A.ttf', new Uint8Array([1, 2, 3]));
  await (await root.getDirectoryHandle('fonts')).removeEntry(record.hash);
  assert.deepEqual(await (await FontStore.fromRoot(root as unknown as FileSystemDirectoryHandle, index)).all(), []);
});

test('a store that cannot open (storage blocked) degrades to null instead of rejecting', async () => {
  const g = globalThis as unknown as { indexedDB?: unknown };
  const had = Object.getOwnPropertyDescriptor(navigator, 'storage');
  Object.defineProperty(navigator, 'storage', { value: { getDirectory: async () => { throw new Error('SecurityError'); } }, configurable: true });
  g.indexedDB = { open: () => ({}) };
  try {
    assert.equal(await FontStore.open(), null);
  } finally {
    delete g.indexedDB;
    if (had) Object.defineProperty(navigator, 'storage', had); else delete (navigator as unknown as { storage?: unknown }).storage;
  }
});
