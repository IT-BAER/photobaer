import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, Engine } from './engine-pkg/photobaer_engine.js';
import { Autosave } from './autosave.ts';
import { FakeDir } from './fake-opfs.ts';

// Restore runs once per worker module (init), so it gets its own process with a prefilled OPFS fake.
initSync({ module: readFileSync(new URL('./engine-pkg/photobaer_engine_bg.wasm', import.meta.url)) });
const root = new FakeDir();
Object.defineProperty(navigator, 'storage', { value: { getDirectory: async () => root } });
Object.defineProperty(navigator, 'locks', { value: { request: (_n: string, _o: unknown, cb: (l: object) => unknown) => cb({}) } });
const replies = new Map<number, (m: { result?: unknown; error?: string }) => void>();
const events: { event?: string; state?: string; detail?: string }[] = [];
const g = globalThis as unknown as { postMessage(m: { id?: number; result?: unknown; error?: string }): void; onmessage: ((e: { data: unknown }) => void) | null };
g.onmessage = null;
g.postMessage = m => { if (m.id !== undefined) replies.get(m.id)?.(m); else events.push(m as never); };

let nextId = 0;
function call(op: string, ...args: unknown[]) {
  const id = ++nextId;
  const p = new Promise<{ result?: unknown; error?: string }>(r => replies.set(id, r));
  g.onmessage!({ data: { id, op, args } });
  return p;
}
type Info = { key: string; width: number; name: string; dirty: boolean; undoLabel: string | null; docs: { key: string; name: string; active: boolean; dirty: boolean }[] };

function saved(key: string, name: string, w: number, dirty: boolean) {
  const e = new Engine(w, 8, 8);
  e.fill(1, 'pixels', w, 0, 0, 255);
  return { key, name, dirty, manifest: e.manifest(), tile: (id: number) => e.tile_bytes(BigInt(id)) };
}

test('init restores every saved tab in order, the active one, names and dirty flags, and skips a broken one', async () => {
  const a = saved('ka', 'A', 16, true), b = saved('kb', 'B', 24, false), c = saved('kc', 'C', 32, false), d = saved('kd', 'D', 40, true), e = saved('ke', 'E', 48, false);
  const auto = await Autosave.fromRoot(root as unknown as FileSystemDirectoryHandle);
  // C is unreadable for the engine although its tile files are all present.
  const broken = { ...c, manifest: JSON.stringify({ ...JSON.parse(c.manifest), width: 'x' }) };
  assert.equal(await auto.save([a, b, broken, d, e], 'kb', () => true), true);
  // E misses a tile file, so load() skips it.
  const folders = (await root.getDirectoryHandle('autosave')).entries.get('docs') as FakeDir;
  const eDir = folders.entries.get('ke') as FakeDir;
  eDir.entries.delete([...eDir.entries.keys()][0]);
  await import('./engine.worker.ts');
  const r = (await call('init')).result as Info;
  assert.deepEqual(r.docs.map(x => [x.key, x.name, x.dirty, x.active]), [['ka', 'A', true, false], ['kb', 'B', false, true], ['kd', 'D', true, false]]);
  assert.equal(r.key, 'kb');
  assert.equal(r.width, 24);
  assert.ok(events.some(x => x.state === 'error' && x.detail?.includes('C') && x.detail.includes('E')), 'the skipped documents are reported');
  const ra = (await call('switchDoc', 'ka')).result as Info;
  assert.deepEqual([ra.width, ra.dirty], [16, true]);
  const rd = (await call('switchDoc', 'kd')).result as Info;
  assert.deepEqual([rd.width, rd.name, rd.dirty], [40, 'D', true]);
  // A clean restored tab turns dirty on an edit and clean again on undo.
  const rb = (await call('switchDoc', 'kb')).result as Info;
  assert.equal(rb.dirty, false);
  assert.equal(((await call('addLayer', 0)).result as Info).dirty, true);
  assert.equal(((await call('undo')).result as Info).dirty, false);
  // Saves after the restore keep the unrestored documents listed, with their folders, and keep reporting them.
  await new Promise(r => setTimeout(r, 1300));
  await call('addLayer', 0);
  await new Promise(r => setTimeout(r, 1300));
  assert.deepEqual([...folders.entries.keys()].sort(), ['ka', 'kb', 'kc', 'kd', 'ke']);
  const again = (await (await Autosave.fromRoot(root as unknown as FileSystemDirectoryHandle)).load())!;
  assert.deepEqual(again.docs.map(x => x.key), ['ka', 'kb', 'kd', 'kc']);
  assert.deepEqual(again.skipped, ['E']);
  assert.equal(again.active, 'kb');
  const last = events.filter(x => x.event === 'autosave').at(-1)!;
  assert.equal(last.state, 'error');
  assert.match(last.detail!, /C.*E|E.*C/);
});
