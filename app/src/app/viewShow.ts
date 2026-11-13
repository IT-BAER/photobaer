// View > Show flags beyond Layer Edges, kept across sessions like Photoshop's: the target path outline,
// note icons, the colored brush resize preview (Ctrl+Alt+right drag) and the Puppet Warp mesh.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export const SHOW_KEYS = ['targetPath', 'notes', 'brushPreview', 'mesh'] as const;
export type ShowKey = typeof SHOW_KEYS[number];
export type ViewShow = Record<ShowKey, boolean>;
export const SHOW_LABEL: Record<ShowKey, MessageDescriptor> = {
  targetPath: msg`Target Path`, notes: msg`Notes`, brushPreview: msg`Brush Preview`, mesh: msg`Mesh`,
};
export const DEFAULT_VIEW_SHOW: ViewShow = { targetPath: true, notes: true, brushPreview: true, mesh: true };

const STORE_KEY = 'photobaer:viewShow';

export function parseViewShow(raw: string | null): ViewShow {
  const out = { ...DEFAULT_VIEW_SHOW };
  try {
    const v = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    for (const k of SHOW_KEYS) if (typeof v[k] === 'boolean') out[k] = v[k];
  } catch { /* corrupt: defaults */ }
  return out;
}
export function loadViewShow(): ViewShow {
  try { return parseViewShow(globalThis.localStorage?.getItem(STORE_KEY) ?? null); } catch { return { ...DEFAULT_VIEW_SHOW }; }
}
export function saveViewShow(s: ViewShow) {
  try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* session-only */ }
}
