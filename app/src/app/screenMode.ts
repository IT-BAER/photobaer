// View > Screen Mode (F cycles, Shift+F backward). Both full screen modes use the browser's full screen;
// With Menu Bar hides the document tabs, Full Screen Mode also hides the menus, bars and panels.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export const SCREEN_MODES = ['standard', 'fullMenu', 'full'] as const;
export type ScreenMode = typeof SCREEN_MODES[number];
export const SCREEN_MODE_LABEL: Record<ScreenMode, MessageDescriptor> = {
  standard: msg`Standard Screen Mode`, fullMenu: msg`Full Screen Mode With Menu Bar`, full: msg`Full Screen Mode`,
};

export function nextScreenMode(m: ScreenMode, back: boolean): ScreenMode {
  const n = SCREEN_MODES.length, i = SCREEN_MODES.indexOf(m);
  return SCREEN_MODES[(i + (back ? n - 1 : 1)) % n];
}
