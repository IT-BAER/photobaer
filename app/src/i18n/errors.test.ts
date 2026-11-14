import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ERROR_LABELS, errorLabel } from './errors.ts';
import { i18n } from './index.ts';
import { poEntries } from './catalogCheck.ts';

test('errorLabel shows known engine and worker errors, interpolates patterns, passes unknown text through', () => {
  assert.equal(errorLabel('Make a selection first.'), 'Make a selection first.');
  assert.equal(errorLabel('Layer not found: 7'), 'Layer not found: 7');
  assert.equal(errorLabel('Error: Make a selection first.'), 'Make a selection first.');
  assert.equal(errorLabel('something else'), 'something else');
  assert.equal(errorLabel('toString'), 'toString');
});

test('every user-facing worker error literal has a message', () => {
  const src = ['../engine.worker.ts', '../worker/helpers.ts'].map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  const literals = [...src.matchAll(/new Error\('((?:[^'\\]|\\.)+)'\)/g)].map(m => m[1]!.replaceAll("\\'", "'")).filter(s => /^[A-Z]/.test(s));
  assert.deepEqual(literals.filter(s => !Object.hasOwn(ERROR_LABELS, s)), []);
});

// Lingui's message id: the first 6 base64url characters of sha256(message + U+001F + context).
const messageId = (message: string, context = '') => createHash('sha256').update(`${message}\u001f${context}`).digest('base64url').slice(0, 6);

test('export, data set, file and memory errors show in the UI language', () => {
  const de = poEntries(readFileSync(new URL('../locales/de/messages.po', import.meta.url), 'utf8'));
  assert.equal(messageId('Make a selection first.'), ERROR_LABELS['Make a selection first.'].id, 'the test computes Lingui ids');
  i18n.load('de', Object.fromEntries(de.filter(e => e.str).map(e => [messageId(e.id, e.context), e.str])));
  i18n.activate('de');
  try {
    const samples = [
      'The image "a.png" is not loaded or cannot be read; choose it with Select File in Image > Variables > Data Sets.',
      'variables bound to layers that were not found were dropped: photo, logo',
      'The variables were not kept: Variables are limited to 1000 bindings and 10000 data sets',
      'The File Info was not kept: File Info fields are limited to 64 KiB, keywords to 1000 of 1 KiB',
      'The image size 70000 x 1 cannot be written in this format.',
      'The TIFF file would be larger than 4 GB.',
      'The BMP file would be larger than 4 GB.',
      'BMP files are written from 8-bit samples.',
      'Targa files are written from 8-bit samples.',
      'The EXR file is damaged (PIZ bitmap).',
      'The EXR file is damaged (DWA sizes).',
      'transform result is too large',
      'Array buffer allocation failed',
      'Invalid typed array length: 17179869184',
      'The scaled replacement image is too large.',
      'The replacement images are limited to 1 GB in total.',
      'The image is too large to save at this bit depth.',
    ];
    assert.deepEqual(samples.filter(s => errorLabel(s) === s), [], 'every sample is translated');
    assert.equal(errorLabel('"cat.png": The scaled replacement image is too large.'), `"cat.png": ${errorLabel('The scaled replacement image is too large.')}`, 'the reason after a file name is translated');
    assert.match(errorLabel('The variables were not kept: transform result is too large'), new RegExp(errorLabel('transform result is too large')), 'a nested reason is translated');
    assert.match(errorLabel('The EXR file is damaged (PIZ bitmap).'), /PIZ bitmap/, 'the technical detail is kept');
    const vars = [
      'The file is empty or has only a header row.',
      'The alignment must lie between 0 and 1.',
      '"1a" is not a valid variable name; use letters, digits and underscore, not starting with a digit.',
      'The name "title" is already bound to another layer or property.',
      'No data set named "Q3".',
      'Variable "x" is bound to a layer that no longer exists.',
      'Variable "x" needs a pixel layer, but "Text 1" is not one.',
      'Variable "x" needs a type layer, but "Layer 2" is not one.',
      'Variable "x" expected true/false or visible/hidden but got "maybe".',
      'Variable "x" expected true/false or visible/hidden but got "".',
      'EXR compression B44 is not supported (use NONE, RLE, ZIPS, ZIP, PIZ, PXR24, B44, B44A, DWAA or DWAB).',
      'HDR FORMAT=32-bit_rle_xyze is not supported (only 32-bit_rle_rgbe).',
    ];
    assert.deepEqual(vars.filter(s => errorLabel(s) === s), [], 'every variables and HDR/EXR sample is translated');
    assert.match(errorLabel('No data set named "Q3".'), /"Q3"/, 'the quoted name is kept');
    assert.match(errorLabel('Variable "x" needs a pixel layer, but "Text 1" is not one.'), /"x".*"Text 1"|"Text 1".*"x"/, 'both names are kept');
    assert.match(errorLabel('HDR FORMAT=32-bit_rle_xyze is not supported (only 32-bit_rle_rgbe).'), /FORMAT=32-bit_rle_xyze/, 'the HDR line is kept');
    const nested = errorLabel('The variables were not kept: Variable "x" is bound to a layer that no longer exists.');
    assert.equal(nested, `${errorLabel('The variables were not kept: transform result is too large').replace(errorLabel('transform result is too large'), errorLabel('Variable "x" is bound to a layer that no longer exists.'))}`, 'both parts of a nested message are translated');
    assert.notEqual(nested, 'The variables were not kept: Variable "x" is bound to a layer that no longer exists.');
    assert.doesNotMatch(nested, /no longer exists/, 'the nested reason is translated');
    assert.equal(errorLabel('"x": unknown reason'), '"x": unknown reason', 'an unknown reason passes through');
  } finally { i18n.activate('en'); }
});

test('encoder and EXR error literals have a message', () => {
  const src = ['../encoders.ts', '../formats.ts', '../exr/piz.ts', '../exr/dwa.ts'].map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  const literals = [...src.matchAll(/new Error\('((?:[^'\\]|\\.)+)'\)/g)].map(m => m[1]!.replaceAll("\\'", "'")).filter(s => /^[A-Z]/.test(s) && s !== 'The pixel data does not match the image size.' && !s.startsWith('The EXR file is damaged ('));
  assert.deepEqual(literals.filter(s => !Object.hasOwn(ERROR_LABELS, s)), []);
});

test('PSD save and import warnings show in the UI language', () => {
  const src = readFileSync(new URL('../psd.ts', import.meta.url), 'utf8');
  const literals = [...new Set([...src.matchAll(/warn\('((?:[^'\\]|\\.)*)'\)/g)].map(m => m[1]!.replaceAll("\\'", "'")))];
  assert.ok(literals.length >= 27, 'the PSD warn literals were found');
  i18n.activate('de');
  try {
    assert.deepEqual(literals.filter(s => errorLabel(s) === s), [], 'every PSD warning is translated');
    const filter = errorLabel('the Gaussian Blur smart filter was kept without its effect because the engine refused its values');
    assert.notEqual(filter, 'the Gaussian Blur smart filter was kept without its effect because the engine refused its values');
    assert.match(filter, /Gaussian Blur/, 'the filter name is kept');
    const skipped = errorLabel('the Gaussian Blur smart filter was not imported');
    assert.notEqual(skipped, 'the Gaussian Blur smart filter was not imported');
    assert.match(skipped, /Gaussian Blur/, 'the filter name is kept');
    const dropped = errorLabel('smart filters ag-psd cannot read are kept without their effect: Lens Blur, Oil Paint');
    assert.notEqual(dropped, 'smart filters ag-psd cannot read are kept without their effect: Lens Blur, Oil Paint');
    assert.match(dropped, /ag-psd/, 'ag-psd is kept');
    assert.match(dropped, /Lens Blur, Oil Paint/, 'the dropped list is kept');
    const channels = errorLabel("3 alpha and spot channels beyond Photoshop's 56-channel limit were not saved");
    assert.notEqual(channels, "3 alpha and spot channels beyond Photoshop's 56-channel limit were not saved");
    assert.match(channels, /3/, 'the count is kept');
    assert.match(channels, /56/, 'the channel limit is kept');
    assert.match(channels, /Photoshop/, 'Photoshop is kept');
  } finally { i18n.activate('en'); }
});
