// App-styled tooltips for every `title` attribute: the title is lifted off during hover or
// focus so the native tooltip stays hidden, and restored afterwards for assistive tech.
type Box = { left: number; top: number; right: number; bottom: number; width: number };
type Size = { width: number; height: number };

const DELAY = 500;
const GAP = 6;
const MARGIN = 4;

// Centred below the anchor, above it when that overflows the bottom, clamped to the viewport sides.
export function placeTip(a: Box, tip: Size, view: Size): { left: number; top: number } {
  const below = a.bottom + GAP;
  const top = below + tip.height > view.height - MARGIN ? a.top - GAP - tip.height : below;
  const left = Math.min(Math.max(a.left + a.width / 2 - tip.width / 2, MARGIN), view.width - MARGIN - tip.width);
  return { left: Math.round(left), top: Math.round(top) };
}

export function installTooltips(): () => void {
  // A manual popover renders in the top layer, so tips also show above modal dialogs.
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.popover = 'manual';
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  let target: HTMLElement | null = null, text = '', timer = 0;

  const hide = () => {
    clearTimeout(timer);
    if (tip.matches(':popover-open')) tip.hidePopover();
    if (target && !target.hasAttribute('title')) target.setAttribute('title', text);
    target = null;
  };
  const show = (el: HTMLElement, delay: number) => {
    hide();
    text = el.getAttribute('title') ?? '';
    if (!text.trim()) return;
    target = el;
    el.removeAttribute('title');
    timer = window.setTimeout(() => {
      if (!target?.isConnected) return;
      tip.textContent = text;
      tip.showPopover();
      const p = placeTip(target.getBoundingClientRect(), tip.getBoundingClientRect(), { width: innerWidth, height: innerHeight });
      tip.style.left = `${p.left}px`;
      tip.style.top = `${p.top}px`;
    }, delay);
  };
  const titled = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLElement>('[title]') : null);

  const over = (e: PointerEvent) => {
    if (target?.contains(e.target as Node)) return;
    const el = titled(e);
    if (el) show(el, DELAY); else if (target) hide();
  };
  const out = (e: PointerEvent) => { if (target && !target.contains(e.relatedTarget as Node | null)) hide(); };
  const focus = (e: FocusEvent) => { const el = titled(e); if (el?.matches(':focus-visible')) show(el, 0); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };

  const on: [string, EventListener][] = [
    ['pointerover', over as EventListener], ['pointerout', out as EventListener], ['pointerdown', hide],
    ['focusin', focus as EventListener], ['focusout', hide], ['keydown', key as EventListener], ['wheel', hide],
  ];
  for (const [t, f] of on) document.addEventListener(t, f, true);
  return () => {
    hide();
    for (const [t, f] of on) document.removeEventListener(t, f, true);
    tip.remove();
  };
}
