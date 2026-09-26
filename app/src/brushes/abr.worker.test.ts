import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAbr } from './abr.ts';
import { writeAbrV2 } from './abrWriter.testutil.ts';

const g = globalThis as unknown as { onmessage: unknown };
g.onmessage = null;
const { abrMessage } = await import('./abr.worker.ts');

test('abrMessage parses the buffer and lists each tip/pattern buffer once for transfer', () => {
  const bytes = writeAbrV2([
    { type: 'sampled', name: 'A', spacing: 25, bitmap: { w: 2, h: 1, depth: 8, compression: 0, samples: [7, 9] } },
    { type: 'sampled', name: 'B', spacing: 25, bitmap: { w: 1, h: 1, depth: 8, compression: 0, samples: [3] } },
  ]);
  const { result, transfer } = abrMessage(bytes.slice().buffer);
  assert.deepEqual(result, parseAbr(bytes));
  assert.equal(result.tips.length, 2);
  assert.equal(new Set(transfer).size, transfer.length);
  for (const t of result.tips) assert.ok(transfer.includes(t.alpha.buffer as ArrayBuffer));
});

test('abrMessage on garbage still returns a report instead of throwing', () => {
  const { result, transfer } = abrMessage(new Uint8Array([1, 2]).buffer);
  assert.ok(result.report.warnings.length > 0);
  assert.deepEqual(transfer, []);
});
