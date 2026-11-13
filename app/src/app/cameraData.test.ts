import assert from 'node:assert/strict';
import test from 'node:test';
import { i18n } from '@lingui/core';
import { cameraRows } from './cameraData.ts';

i18n.loadAndActivate({ locale: 'en', messages: {} });

const rows = (c: Record<string, string>) => Object.fromEntries(cameraRows(c).map(r => [r.key, r.value]));

test('Camera Data rows format exposure, aperture, focal length, ISO, dates and GPS', () => {
  const r = rows({
    Make: 'Canon', Model: 'EOS R5', ExposureTime: '10/2500', FNumber: '28/10', FocalLength: '500/10', FocalLengthIn35mmFilm: '75',
    ISOSpeedRatings: '400', ExposureBiasValue: '-2/3', MaxApertureValue: '3/1', DateTimeOriginal: '2026:01:02 10:11:12',
    GPSLatitude: '48,8.5N', GPSLongitude: '16,22.123456W', GPSAltitude: '5005/10', GPSAltitudeRef: '1',
    PixelXDimension: '4000', ExposureProgram: '3', MeteringMode: '5', Flash: '16', ColorSpace: '1', Orientation: '6', LensModel: 'RF 50mm',
  });
  assert.equal(r.ExposureTime, '1/250 s');
  assert.equal(r.FNumber, 'f/2.8');
  assert.equal(r.FocalLength, '50 mm');
  assert.equal(r.FocalLengthIn35mmFilm, '75 mm');
  assert.equal(r.ISOSpeedRatings, 'ISO 400');
  assert.equal(r.ExposureBiasValue, '-0.67 EV');
  assert.equal(r.MaxApertureValue, 'f/2.8');
  assert.equal(r.DateTimeOriginal, '2026-01-02 10:11:12');
  assert.equal(r.GPSLatitude, '48° 8.5′ N');
  assert.equal(r.GPSLongitude, '16° 22.1235′ W');
  assert.equal(r.GPSAltitude, '-500.5 m');
  assert.equal(r.PixelXDimension, '4000 px');
  assert.equal(r.ExposureProgram, 'Aperture priority');
  assert.equal(r.MeteringMode, 'Pattern');
  assert.equal(r.Flash, 'Did not fire');
  assert.equal(r.ColorSpace, 'sRGB');
  assert.equal(r.Orientation, 'Rotate 90° CW');
  assert.equal(r.LensModel, 'RF 50mm');
  assert.equal(r.Make, 'Canon');
  assert.ok(!('GPSAltitudeRef' in r), 'the reference is part of the altitude row');
});

test('Camera Data rows: long exposures, unknown codes and damaged values stay readable; order is fixed; empty map', () => {
  const r = cameraRows({ ExposureTime: '25/10', MeteringMode: '42', FNumber: '0/0', Model: 'X', Make: 'Y', Software: 'Tool 1.0' });
  assert.deepEqual(r.map(x => x.key), ['Make', 'Model', 'ExposureTime', 'FNumber', 'MeteringMode', 'Software']);
  const v = Object.fromEntries(r.map(x => [x.key, x.value]));
  assert.equal(v.ExposureTime, '2.5 s');
  assert.equal(v.MeteringMode, '42');
  assert.equal(v.FNumber, '0/0');
  assert.ok(r.every(x => x.label), 'every row has a label');
  assert.deepEqual(cameraRows({}), []);
});
