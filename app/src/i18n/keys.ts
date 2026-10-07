// Displayed shortcut text with the UI language's modifier names (German Photoshop: Strg+Umschalt+S).
// Display only: key bindings, aria-keyshortcuts and stored shortcut strings stay English.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { i18n } from './index.ts';

export const KEY_NAMES: Record<'Ctrl' | 'Shift' | 'Alt', MessageDescriptor> = {
  Ctrl: msg({ message: 'Ctrl', context: 'keyboard modifier' }),
  Shift: msg({ message: 'Shift', context: 'keyboard modifier' }),
  Alt: msg({ message: 'Alt', context: 'keyboard modifier' }),
};

export const keysLabel = (keys = '') =>
  keys.split('+').map(k => (Object.hasOwn(KEY_NAMES, k) ? i18n._(KEY_NAMES[k as keyof typeof KEY_NAMES]) : k)).join('+');
