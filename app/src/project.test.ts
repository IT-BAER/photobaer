import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packProject, unpackProject, tileIds } from './project.ts';

const manifest = JSON.stringify({ format: 'photobaer-manifest', version: 1, layers: [{ tiles: [0, 7, 7, 2 ** 40 + 3] }, { tiles: [9, 0] }] });
const bytes = (id: number) => new Uint8Array([id % 251, 1, 2, 3, id % 7]);

test('tileIds lists each referenced tile once and skips 0', () => {
  assert.deepEqual([...tileIds(manifest)].sort((a, b) => a - b), [7, 9, 2 ** 40 + 3]);
});

test('pack then unpack returns the manifest and every tile', async () => {
  const blob = await packProject(manifest, bytes);
  const p = await unpackProject(blob);
  assert.equal(p.manifest, manifest);
  assert.equal(p.tiles.size, 3);
  for (const id of tileIds(manifest)) assert.deepEqual(p.tiles.get(id), bytes(id));
});

test('the file is gzip compressed', async () => {
  const head = new Uint8Array(await (await packProject(manifest, bytes)).arrayBuffer()).slice(0, 2);
  assert.deepEqual([...head], [0x1f, 0x8b]);
});

test('a truncated file is rejected', async () => {
  const raw = new Uint8Array(await new Response((await packProject(manifest, bytes)).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const cut = raw.slice(0, raw.length - 10);
  const gz = await new Response(new Blob([cut]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  await assert.rejects(unpackProject(gz), /truncated/);
});

test('a file that is not a project is rejected', async () => {
  const gz = await new Response(new Blob(['hello world, not a project']).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  await assert.rejects(unpackProject(gz), /not a Photobaer project/);
  await assert.rejects(unpackProject(new Blob(['plain'])), /not a Photobaer project/);
});
