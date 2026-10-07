// View > Proof Setup, Proof Colors, Gamut Warning and 32-bit Preview Options: per-document display
// state, and its translation into the engine's view JSON.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Intent } from './colorSettings.ts';

export type ProofId =
  | 'custom' | 'workingCmyk' | 'workingCyanPlate' | 'workingMagentaPlate' | 'workingYellowPlate' | 'workingBlackPlate'
  | 'workingCmyPlate' | 'legacyMacintoshRgb' | 'internetStandardRgb' | 'monitorRgb' | 'colorBlindnessProtanopia'
  | 'colorBlindnessDeuteranopia';

export interface ProofSetup {
  id: ProofId;
  // Custom only: the device profile (built-in or loaded name).
  profile?: string;
  intent: Intent;
  bpc: boolean;
  preserveNumbers: boolean;
  simulatePaper: boolean;
  simulateBlackInk: boolean;
}

export type HdrMethod = 'exposureAndGamma' | 'highlightCompression';
export interface HdrPreview { method: HdrMethod; exposure: number; gamma: number }

export interface ViewState { setup: ProofSetup; proofColors: boolean; gamutWarning: boolean; hdr: HdrPreview }

// The Proof Setup submenu: id, label, separator before it.
export const PROOF_PRESETS: [ProofId, MessageDescriptor, boolean][] = [
  ['workingCmyk', msg`Working CMYK`, true],
  ['workingCyanPlate', msg`Working Cyan Plate`, false],
  ['workingMagentaPlate', msg`Working Magenta Plate`, false],
  ['workingYellowPlate', msg`Working Yellow Plate`, false],
  ['workingBlackPlate', msg`Working Black Plate`, false],
  ['workingCmyPlate', msg`Working CMY Plate`, false],
  ['legacyMacintoshRgb', msg`Legacy Macintosh RGB`, true],
  ['internetStandardRgb', msg`Internet Standard RGB`, false],
  ['monitorRgb', msg`Monitor RGB`, false],
  ['colorBlindnessProtanopia', msg`Color Blindness — Protanopia-type`, true],
  ['colorBlindnessDeuteranopia', msg`Color Blindness — Deuteranopia-type`, false],
];

const PLATES: Partial<Record<ProofId, [boolean, boolean, boolean, boolean]>> = {
  workingCyanPlate: [true, false, false, false],
  workingMagentaPlate: [false, true, false, false],
  workingYellowPlate: [false, false, true, false],
  workingBlackPlate: [false, false, false, true],
  workingCmyPlate: [true, true, true, false],
};

// The proof as the document tab names it, e.g. "CMYK" in (RGB/8/CMYK); custom: the profile name.
export function proofLabel(s: ProofSetup): string {
  if (s.id === 'custom') return s.profile ?? 'CMYK';
  if (s.id === 'workingCmyk') return 'CMYK';
  const label = PROOF_PRESETS.find(p => p[0] === s.id)![1].message!;
  return label.replace(/^Working |^Color Blindness — |-type$/g, '');
}

export const LEGACY_MAC = 'Legacy Macintosh RGB (Gamma 1.8)';
export const HDR_EXPOSURE = 20;
export const HDR_GAMMA: [number, number] = [0.1, 10];

export function presetSetup(id: ProofId): ProofSetup {
  const rgb = id === 'legacyMacintoshRgb' || id === 'internetStandardRgb' || id === 'monitorRgb';
  return { id, intent: 'relativeColorimetric', bpc: true, preserveNumbers: rgb, simulatePaper: false, simulateBlackInk: false };
}

export const DEFAULT_VIEW: ViewState = {
  setup: presetSetup('workingCmyk'), proofColors: false, gamutWarning: false, hdr: { method: 'exposureAndGamma', exposure: 0, gamma: 1 },
};

// Exposure within ±20 stops and gamma within 0.1..10; anything not finite takes the default.
export function sanitizeHdr(h: Partial<HdrPreview>): HdrPreview {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    method: h.method === 'highlightCompression' ? 'highlightCompression' : 'exposureAndGamma',
    exposure: Math.min(HDR_EXPOSURE, Math.max(-HDR_EXPOSURE, num(h.exposure, 0))),
    gamma: Math.min(HDR_GAMMA[1], Math.max(HDR_GAMMA[0], num(h.gamma, 1))),
  };
}

// The engine's view JSON; `workingCmyk` is the Color Settings CMYK working space.
export function engineView(v: ViewState, workingCmyk: string) {
  const s = v.setup;
  const kind = s.id === 'colorBlindnessProtanopia' ? 'protanopia' : s.id === 'colorBlindnessDeuteranopia' ? 'deuteranopia' : 'device';
  const profile = s.id === 'custom' ? s.profile ?? workingCmyk
    : s.id === 'legacyMacintoshRgb' ? LEGACY_MAC
      : s.id === 'internetStandardRgb' ? 'sRGB IEC61966-2.1'
        : s.id === 'monitorRgb' || kind !== 'device' ? undefined : workingCmyk;
  return {
    setup: {
      kind, profile, plates: PLATES[s.id], intent: s.intent, blackPointCompensation: s.bpc, preserveNumbers: s.preserveNumbers,
      simulatePaper: s.simulatePaper, simulateBlackInk: s.simulateBlackInk || s.simulatePaper,
    },
    proofColors: v.proofColors, gamutWarning: v.gamutWarning, hdr: v.hdr,
  };
}

