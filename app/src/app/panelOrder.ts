// User order of dock sections and toolbar slots, kept per browser.

interface OrderStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** The stored order of `defaults`; unknown keys drop out, missing keys go after their default predecessor. */
export function loadOrder<T extends string>(key: string, defaults: readonly T[], storage: OrderStorage = localStorage): T[] {
  let raw: unknown = null;
  try { raw = JSON.parse(storage.getItem(key) ?? 'null'); } catch { /* defaults */ }
  const known = new Set<string>(defaults);
  const out: T[] = [];
  if (Array.isArray(raw)) for (const k of raw) if (typeof k === 'string' && known.has(k) && !out.includes(k as T)) out.push(k as T);
  defaults.forEach((k, i) => {
    if (out.includes(k)) return;
    out.splice(i ? out.indexOf(defaults[i - 1]) + 1 : 0, 0, k);
  });
  return out;
}

export function saveOrder(key: string, order: readonly string[], storage: OrderStorage = localStorage) {
  try { storage.setItem(key, JSON.stringify(order)); } catch { /* storage full or blocked: order lasts this session */ }
}

/** Moves `item` before (or after) `target`; unknown keys leave the order unchanged. */
export function moveItem<T>(order: readonly T[], item: T, target: T, after: boolean): T[] {
  if (item === target || !order.includes(item) || !order.includes(target)) return [...order];
  const out = order.filter(k => k !== item);
  out.splice(out.indexOf(target) + (after ? 1 : 0), 0, item);
  return out;
}
