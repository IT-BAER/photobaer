import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localMatches, withLocal, type LocalFont } from './sources.ts';
import type { FaceInfo } from '../worker/types.ts';

const face = (family: string, style: string, postscript: string): FaceInfo => ({ id: 1, family, style, weight: 400, italic: false, postscript, source: 'bundled', color: false });
const local = (family: string, style: string, postscriptName: string): LocalFont => ({ family, style, postscriptName, fullName: `${family} ${style}`, blob: async () => new Blob() });

test('system faces join the picker list only for families that are not registered, hidden names excluded', () => {
  const faces = [face('Noto Sans', 'Regular', 'NotoSans-Regular')];
  const sys = [local('Noto Sans', 'Regular', 'NotoSans-Regular'), local('Arial', 'Regular', 'ArialMT'), local('Arial', 'Bold Italic', 'Arial-BoldItalicMT'), local('@MS Gothic', 'Regular', 'MS-Gothic'), local('.SF NS', 'Regular', 'SFNS')];
  const all = withLocal(faces, sys);
  assert.deepEqual(all.map(f => [f.family, f.style, f.source]), [['Noto Sans', 'Regular', 'bundled'], ['Arial', 'Regular', 'local'], ['Arial', 'Bold Italic', 'local']]);
  assert.equal(all[2].italic, true);
});

test('names match system faces by family or PostScript name, skipping registered families', () => {
  const faces = [face('Noto Sans', 'Regular', 'NotoSans-Regular')];
  const sys = [local('Noto Sans', 'Regular', 'NotoSans-Regular'), local('Arial', 'Regular', 'ArialMT'), local('Segoe UI', 'Regular', 'SegoeUI')];
  assert.deepEqual(localMatches(sys, faces, ['ArialMT', 'Noto Sans', 'Segoe UI', 'Nope']).map(f => f.postscriptName), ['ArialMT', 'SegoeUI']);
});
