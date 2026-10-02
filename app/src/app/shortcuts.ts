import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { digitOption, stepHardness, stepSize, type DigitState } from '../shell/brushKeys.ts';
import type { Rgb } from '../shell/color.ts';
import type { ToolOptions } from '../shell/OptionsBar.tsx';
import type { Viewer } from '../viewer.ts';
import { PAINT_TOOLS, type Item } from './helpers.ts';
import { COMPOSITE, type ChannelView } from './channels.ts';

type SetState<T> = Dispatch<SetStateAction<T>>;
type Session = { active: () => boolean; commit: () => void; cancel: () => void };

export interface ShortcutCtx {
  menusRef: RefObject<Record<string, Item[]>>; capsLockRef: RefObject<boolean>; polygonActionsRef: RefObject<(Session & { removeLast: () => void }) | null>;
  transformKey: (e: KeyboardEvent, k: string, ctrl: boolean) => boolean; cropSession: RefObject<Session | null>;
  setDockTab: SetState<'color' | 'swatches' | 'brushSettings' | 'brushes'>; setMenu: SetState<string | null>; viewer: RefObject<Viewer | null>;
  setFg: SetState<Rgb>; setBg: SetState<Rgb>; bgRef: RefObject<Rgb>; fgRef: RefObject<Rgb>; setQuickMask: SetState<boolean>;
  toolRef: RefObject<string>; toolOptionsRef: RefObject<ToolOptions>;
  patchToolOptions: (toolId: string, patch: Record<string, number | string | boolean>) => void;
  flowDigitRef: RefObject<DigitState | null>; opacityDigitRef: RefObject<DigitState | null>;
  moveKeysRef: RefObject<{ nudge: (dx: number, dy: number, alt: boolean) => void } | null>; selectByKey: (key: string, shift: boolean) => boolean;
  open: (f: File, handle?: FileSystemFileHandle | null) => Promise<void>;
  // The active pen or path selection tool's keys; true = handled.
  penKeysRef: RefObject<((e: KeyboardEvent) => boolean) | null>;
  // An open type edit session's keys; checked first (Esc commits instead of resetting the view rotation).
  typeKeysRef: RefObject<((e: KeyboardEvent) => boolean) | null>;
  setChannelView: SetState<ChannelView>;
}

export function useShortcuts(c: ShortcutCtx) {
  const {
    menusRef, capsLockRef, polygonActionsRef, transformKey, cropSession, setDockTab, setMenu, viewer, setFg, setBg, bgRef, fgRef, setQuickMask,
    toolRef, toolOptionsRef, patchToolOptions, flowDigitRef, opacityDigitRef, moveKeysRef, selectByKey, open, penKeysRef, typeKeysRef, setChannelView,
  } = c;
  useEffect(() => {
    const find = (pred: (label: string) => boolean) => Object.values(menusRef.current).flat().flatMap(i => [i, ...(i.sub ?? [])]).find(i => pred(i.label));
    const trigger = (label: string, e: KeyboardEvent) => {
      const it = find(l => l.startsWith(label));
      e.preventDefault();
      if (it && !it.off) it.run();
    };
    const triggerBy = (pred: (label: string) => boolean, e: KeyboardEvent) => {
      const it = find(pred);
      e.preventDefault();
      if (it && !it.off) it.run();
    };
    // Image > Adjustments items only: Layer > New Adjustment Layer carries the same kind names.
    const adjustment = (label: string, e: KeyboardEvent) => {
      const sub = menusRef.current.Image.find(i => i.label === 'Adjustments');
      const it = sub?.sub?.find(i => i.label === label);
      e.preventDefault();
      if (it && !sub!.off && !it.off) it.run();
    };
    const down = (e: KeyboardEvent) => {
      // A closed <dialog> can keep focus on its OK button; only an open dialog or a live field swallows keys.
      const t = e.target instanceof Element ? e.target : null;
      if (t && (t.closest('dialog[open]') || (t.closest('input, select') && !t.closest('dialog:not([open])')))) return;
      capsLockRef.current = e.getModifierState('CapsLock');
      const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
      if (typeKeysRef.current?.(e)) return;
      if (penKeysRef.current?.(e)) return;
      if (polygonActionsRef.current?.active()) {
        if (k === 'escape') { e.preventDefault(); polygonActionsRef.current.cancel(); return; }
        if (k === 'backspace') { e.preventDefault(); polygonActionsRef.current.removeLast(); return; }
        if (k === 'enter') { e.preventDefault(); polygonActionsRef.current.commit(); return; }
      }
      if (transformKey(e, k, ctrl)) return;
      if (!ctrl && (k === 'enter' || k === 'escape') && cropSession.current?.active()) {
        e.preventDefault();
        if (e.repeat) return;
        if (k === 'enter') cropSession.current.commit(); else cropSession.current.cancel();
        return;
      }
      if (ctrl && e.altKey && k === 'n') trigger('New', e);
      else if (ctrl && e.altKey && !e.shiftKey && k === 'f') trigger('Last Filter', e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 'f') trigger('Fade', e);
      else if (ctrl && !e.altKey && !e.shiftKey && k === 'f') { if (!t?.closest('textarea, [contenteditable]')) triggerBy(l => l === 'Search…', e); }
      else if (ctrl && k === 'tab') triggerBy(l => l === (e.shiftKey ? 'Previous Document' : 'Next Document'), e);
      else if (ctrl && !e.altKey && !e.shiftKey && k === 'w') triggerBy(l => l === 'Close', e);
      else if (ctrl && k === 'o') trigger('Open', e);
      else if (ctrl && e.altKey && !e.shiftKey && k === 's') triggerBy(l => l === 'Save a Copy…', e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 's') triggerBy(l => l === 'Save As…', e);
      else if (ctrl && !e.altKey && k === 's') triggerBy(l => l === 'Save', e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 'k') triggerBy(l => l === 'Color Settings…', e);
      else if (ctrl && !e.altKey && k === 'y') triggerBy(l => l.endsWith(e.shiftKey ? 'Gamut Warning' : 'Proof Colors'), e);
      else if (ctrl && k === 'z' && e.shiftKey) trigger('Redo', e);
      else if (ctrl && k === 'z') trigger('Undo', e);
      else if (ctrl && e.shiftKey && e.altKey && k === 'a') trigger('Adaptive Wide Angle', e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 'a') trigger('Camera Raw Filter', e);
      else if (ctrl && k === 'a') trigger('All', e);
      else if (ctrl && e.shiftKey && k === 'd') trigger('Reselect', e);
      else if (ctrl && k === 'd') trigger('Deselect', e);
      else if (ctrl && e.shiftKey && k === 'i') trigger('Inverse', e);
      else if (ctrl && e.altKey && !e.shiftKey && k === 'i') trigger('Image Size', e);
      else if (ctrl && e.altKey && !e.shiftKey && k === 'c') trigger('Canvas Size', e);
      else if (ctrl && e.altKey && e.shiftKey && k === 'c') trigger('Content-Aware Scale', e);
      else if (ctrl && !e.altKey && e.shiftKey && k === 'c') triggerBy(l => l === 'Copy Merged', e);
      else if (ctrl && !e.altKey && k === 'c') triggerBy(l => l === 'Copy', e);
      else if (ctrl && !e.altKey && !e.shiftKey && k === 'x') triggerBy(l => l === 'Cut', e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 'x') trigger('Liquify', e);
      else if (ctrl && e.altKey && e.shiftKey && k === 'v') triggerBy(l => l === 'Paste Into', e);
      else if (ctrl && e.altKey && !e.shiftKey && k === 'v') trigger('Vanishing Point', e);
      else if (ctrl && !e.altKey && e.shiftKey && k === 'v') triggerBy(l => l === 'Paste in Place', e);
      else if (ctrl && k === 'i') adjustment('Invert', e);
      else if (ctrl && e.altKey && e.shiftKey && k === 'l') trigger('Auto Contrast', e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 'l') trigger('Auto Tone', e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 'u') adjustment('Desaturate', e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 'b') trigger('Auto Color', e);
      else if (ctrl && !e.altKey && k === 'l') adjustment('Levels…', e);
      else if (ctrl && !e.altKey && k === 'm') adjustment('Curves…', e);
      else if (ctrl && !e.altKey && k === 'u') adjustment('Hue/Saturation…', e);
      else if (ctrl && e.altKey && e.shiftKey && k === 'b') adjustment('Black & White…', e);
      else if (ctrl && !e.altKey && !e.shiftKey && k === 'b') adjustment('Color Balance…', e);
      else if (ctrl && e.shiftKey && k === 't') triggerBy(l => l === 'Again', e);
      else if (ctrl && k === 't') trigger('Free Transform', e);
      else if (e.shiftKey && k === 'f6') trigger('Feather', e);
      else if (e.shiftKey && !ctrl && k === 'f5') triggerBy(l => l === 'Fill…', e);
      else if (k === 'f12' && !ctrl && !e.shiftKey && !e.altKey && find(l => l === 'Revert')?.off === false) triggerBy(l => l === 'Revert', e);
      else if (k === 'f5' && !ctrl) { e.preventDefault(); setDockTab(t => (t === 'brushSettings' ? 'color' : 'brushSettings')); }
      else if (ctrl && k === 'h') triggerBy(l => l.endsWith('selection edges'), e);
      else if (ctrl && e.shiftKey && !e.altKey && k === 'r') trigger('Lens Correction', e);
      else if (ctrl && k === 'r') triggerBy(l => l.endsWith('Rulers'), e);
      else if (ctrl && e.shiftKey && (k === ';' || k === ':')) triggerBy(l => l.replace('✓ ', '') === 'Snap', e);
      else if (ctrl && e.altKey && k === ';') triggerBy(l => l === 'Lock Guides' || l === 'Unlock Guides', e);
      else if (ctrl && !e.altKey && k === ';') triggerBy(l => l === 'Show Guides' || l === 'Hide Guides', e);
      else if (ctrl && k === "'") triggerBy(l => l === 'Show Grid' || l === 'Hide Grid', e);
      else if (ctrl && e.shiftKey && k === 'j') trigger('Layer via Cut', e);
      else if (ctrl && k === 'j') trigger('Layer via Copy', e);
      else if (ctrl && e.altKey && k === 'g') triggerBy(l => l.endsWith('Clipping Mask'), e);
      else if (ctrl && e.shiftKey && k === 'g') trigger('Ungroup Layers', e);
      else if (ctrl && e.altKey && e.shiftKey && e.code === 'KeyE') trigger('Stamp Visible', e);
      else if (ctrl && !e.altKey && e.shiftKey && k === 'e') trigger('Merge Visible', e);
      else if (ctrl && !e.altKey && k === 'e') triggerBy(l => l === 'Merge Down' || l === 'Merge Layers' || l === 'Merge Group', e);
      else if (ctrl && k === 'g') trigger('Group Layers', e);
      else if (ctrl && !e.altKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        trigger(e.code === 'BracketRight' ? (e.shiftKey ? 'Bring to Front' : 'Bring Forward') : (e.shiftKey ? 'Send to Back' : 'Send Backward'), e);
      }
      else if (ctrl && (k === '+' || k === '=')) trigger('Zoom in', e);
      else if (ctrl && k === '-') trigger('Zoom out', e);
      else if (ctrl && k === '0') trigger('Fit', e);
      else if (ctrl && k === '1') trigger('100%', e);
      else if (ctrl && !e.altKey && k >= '2' && k <= '5') {
        e.preventDefault();
        setChannelView(k === '2' ? COMPOSITE : { rgb: [0, 1, 2].map(i => i === +k - 3) as ChannelView['rgb'], alpha: [] });
      }
      else if (e.altKey && !ctrl && (k === 'backspace' || k === 'delete')) triggerBy(l => l === 'Fill with Foreground Color', e);
      else if (ctrl && !e.altKey && (k === 'backspace' || k === 'delete')) triggerBy(l => l === 'Fill with Background Color', e);
      else if (e.shiftKey && k === 'backspace') triggerBy(l => l === 'Fill…', e);
      else if (k === 'delete' || k === 'backspace') trigger('Clear', e);
      else if (k === 'escape') { setMenu(null); viewer.current?.resetRotation(); }
      else if (k === ' ' && ctrl && e.altKey) { e.preventDefault(); viewer.current?.setSpring('zoomOut'); }
      else if (k === ' ' && ctrl) { e.preventDefault(); viewer.current?.setSpring('zoom'); }
      else if (k === ' ') { e.preventDefault(); viewer.current?.setSpring('hand'); }
      else if (!ctrl && !e.altKey && k === 'x') { e.preventDefault(); setFg(bgRef.current); setBg(fgRef.current); }
      else if (!ctrl && !e.altKey && k === 'd') { e.preventDefault(); setFg([0, 0, 0]); setBg([255, 255, 255]); }
      else if (!ctrl && !e.altKey && k === 'q') { e.preventDefault(); setQuickMask(v => !v); }
      else if (!ctrl && !e.altKey && (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}' || /^Digit[0-9]$/.test(e.code))) {
        // Brush shortcuts (docs/M2.md section 4): only mutate options for the active paint tool,
        // but always swallow these keys so they never reach selectByKey (no slot uses them anyway).
        e.preventDefault();
        if (PAINT_TOOLS.has(toolRef.current)) {
          const o = toolOptionsRef.current;
          if (e.key === '[' || e.key === ']') patchToolOptions(toolRef.current, { size: stepSize(Number(o.size), e.key === ']') });
          else if ((e.key === '{' || e.key === '}') && o.hardness !== undefined) {
            patchToolOptions(toolRef.current, { hardness: stepHardness(Number(o.hardness), e.key === '}') });
          } else {
            const digit = e.code.slice(5);
            const now = performance.now();
            if (e.shiftKey && o.flow !== undefined) {
              const r = digitOption(flowDigitRef.current, digit, now);
              flowDigitRef.current = r.state;
              patchToolOptions(toolRef.current, { flow: r.value });
            } else if (!e.shiftKey) {
              const r = digitOption(opacityDigitRef.current, digit, now);
              opacityDigitRef.current = r.state;
              patchToolOptions(toolRef.current, { opacity: r.value });
            }
          }
        }
      }
      else if (moveKeysRef.current && !ctrl && k.startsWith('arrow')) {
        e.preventDefault();
        const n = e.shiftKey ? 10 : 1;
        moveKeysRef.current.nudge(k === 'arrowleft' ? -n : k === 'arrowright' ? n : 0, k === 'arrowup' ? -n : k === 'arrowdown' ? n : 0, e.altKey);
      }
      else if (!ctrl && !e.altKey && !e.metaKey) selectByKey(k, e.shiftKey);
    };
    const up = (e: KeyboardEvent) => {
      capsLockRef.current = e.getModifierState('CapsLock');
      if (e.key === ' ') viewer.current?.setSpring(null);
    };
    // Ctrl+V is left to the browser so this event carries the system clipboard; fields, dialogs and a type session keep it.
    const paste = (e: ClipboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('dialog[open], input, textarea, select, [contenteditable]')) return;
      const it = find(l => l === 'Paste') as { run: (bytes: Uint8Array | null) => void; off?: boolean } | undefined;
      if (!it || it.off) return;
      e.preventDefault();
      const f = [...(e.clipboardData?.files ?? [])].find(f => f.type.startsWith('image/'));
      if (f) void f.arrayBuffer().then(b => it.run(new Uint8Array(b)));
      else it.run(null);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      // Files and handles are only readable during the event; a dropped folder has no file.
      type Item = DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> };
      const dropped = [...(e.dataTransfer?.items ?? [])].filter(i => i.kind === 'file')
        .map(i => ({ file: i.getAsFile(), handle: (i as Item).getAsFileSystemHandle?.().catch(() => null) ?? null }));
      void (async () => {
        for (const d of dropped) {
          const h = await d.handle;
          if (d.file) await open(d.file, h?.kind === 'file' ? h as FileSystemFileHandle : null);
        }
      })();
    };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('paste', paste);
    addEventListener('dragover', over);
    addEventListener('drop', drop);
    return () => {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('paste', paste);
      removeEventListener('dragover', over);
      removeEventListener('drop', drop);
    };
  }, []);
}
