import assert from 'node:assert/strict';
import test from 'node:test';
import { sendVariableImages } from './variableImages.ts';

const file = (name: string, size: number, reads: string[]) => ({ name, size, arrayBuffer: async () => { reads.push(name); return new ArrayBuffer(size); } });

test('replacement images are sent one file per call, updating the list after each', async () => {
  const calls: string[][] = [], seen: string[][] = [], reads: string[] = [];
  const all: string[] = [];
  const call = async (f: { name: string; bytes: Uint8Array }[]) => { calls.push(f.map(x => x.name)); all.push(...f.map(x => x.name)); return [...all]; };
  await sendVariableImages([file('a', 2, reads), file('b', 3, reads)], call, n => seen.push(n));
  assert.deepEqual(calls, [['a'], ['b']]);
  assert.deepEqual(seen, [['a'], ['a', 'b']]);
});

test('a file over 1 GB is refused before any file is read', async () => {
  const reads: string[] = [];
  let sent = 0;
  await assert.rejects(sendVariableImages([file('a', 2, reads), file('big', 2 ** 30 + 1, reads)], async () => { sent++; return []; }, () => {}), /limited to 1 GB in total/);
  assert.deepEqual(reads, []);
  assert.equal(sent, 0);
});
