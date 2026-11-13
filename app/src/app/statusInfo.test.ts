import test from 'node:test';
import assert from 'node:assert/strict';
import { i18n } from '@lingui/core';
import { documentSizes, fmtBytes, statusInfoText, STATUS_INFO, type StatusCtx } from './statusInfo.ts';

i18n.loadAndActivate({ locale: 'en', messages: {} });

const rgb = { width: 1000, height: 1000, depth: 8, mode: null, gray: false, extraChannels: 0 };

test('document sizes: flattened color channels, layered adds alpha per layer clipped to the canvas', () => {
  assert.deepEqual(documentSizes(rgb, [[0, 0, 1000, 1000]]), [3_000_000, 4_000_000]);
  // Half the layer lies left of the canvas.
  assert.deepEqual(documentSizes(rgb, [[-500, 0, 1000, 1000], [0, 0, 1000, 1000]]), [3_000_000, 6_000_000]);
  // Never below the flattened size; an empty document still has its composite.
  assert.deepEqual(documentSizes(rgb, []), [3_000_000, 3_000_000]);
  assert.deepEqual(documentSizes({ ...rgb, depth: 16 }, [[0, 0, 1000, 1000]]), [6_000_000, 8_000_000]);
  assert.deepEqual(documentSizes({ ...rgb, gray: true }, [[0, 0, 1000, 1000]]), [1_000_000, 2_000_000]);
  assert.deepEqual(documentSizes({ ...rgb, mode: { kind: 'cmyk' } }, [[0, 0, 1000, 1000]]), [4_000_000, 5_000_000]);
  // Alpha and spot channels count with the layers only.
  assert.deepEqual(documentSizes({ ...rgb, extraChannels: 2 }, [[0, 0, 1000, 1000]]), [3_000_000, 6_000_000]);
  // Bitmap stores one bit per pixel, rows padded to whole bytes.
  assert.deepEqual(documentSizes({ ...rgb, width: 10, height: 4, mode: { kind: 'bitmap' }, gray: true }, []), [8, 8]);
});

test('byte sizes use Photoshop compact units', () => {
  assert.equal(fmtBytes(1920 * 1080 * 3), '5.93M');
  assert.equal(fmtBytes(750_000), '732.4K');
  assert.equal(fmtBytes(3 * 2 ** 30), '3G');
});

const ctx: StatusCtx = {
  width: 1920, height: 1080, depth: 8, resolution: 300, modeName: 'RGB', profile: null, unit: 'px',
  sizes: [6_220_800, 8_294_400], scale: { pixels: 1, logical: 1, units: 'px' }, toolName: 'Brush Tool', layerCount: 1,
};

test('status info texts for every Show entry', () => {
  assert.deepEqual([...STATUS_INFO], ['sizes', 'profile', 'dimensions', 'scale', 'tool', 'layers']);
  assert.equal(statusInfoText('sizes', ctx), 'Doc: 5.93M/7.91M');
  assert.equal(statusInfoText('sizes', { ...ctx, sizes: null }), 'Doc: …');
  assert.equal(statusInfoText('profile', ctx), 'Untagged RGB (8bpc)');
  assert.equal(statusInfoText('profile', { ...ctx, depth: 16, profile: 'sRGB IEC61966-2.1' }), 'sRGB IEC61966-2.1 (16bpc)');
  assert.equal(statusInfoText('dimensions', ctx), '1920 px x 1080 px (300 ppi)');
  assert.equal(statusInfoText('dimensions', { ...ctx, unit: 'cm' }), '16.26 cm x 9.14 cm (300 ppi)');
  assert.equal(statusInfoText('dimensions', { ...ctx, unit: 'percent' }), '100 % x 100 % (300 ppi)');
  assert.equal(statusInfoText('scale', ctx), '1 px = 1 px');
  assert.equal(statusInfoText('scale', { ...ctx, scale: { pixels: 120, logical: 2.5, units: 'cm' } }), '120 px = 2.5 cm');
  assert.equal(statusInfoText('tool', ctx), 'Brush Tool');
  assert.equal(statusInfoText('layers', ctx), '1 Layer');
  assert.equal(statusInfoText('layers', { ...ctx, layerCount: 3 }), '3 Layers');
});
