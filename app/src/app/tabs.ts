// The tab `step` places from the active one (wrapping); null when there are fewer than two tabs.
export function stepTab(docs: { key: string; active: boolean }[], step: 1 | -1): string | null {
  const i = docs.findIndex(d => d.active);
  return docs.length < 2 || i < 0 ? null : docs[(i + step + docs.length) % docs.length].key;
}
