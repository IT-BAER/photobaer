// ICC profiles loaded by the user (Assign/Convert to Profile, Proof Setup, working spaces), kept per
// browser in IndexedDB so they survive a reload; their names are mirrored in localStorage so saved
// Color Settings can name them before the worker has read the store.

export interface StoredProfile { name: string; space: 'rgb' | 'cmyk' | 'gray'; bytes: Uint8Array }
export interface ProfileStore { all(): Promise<StoredProfile[]>; put(p: StoredProfile): Promise<void> }

// Null without IndexedDB or when storage is blocked (profiles then last for the session).
export function openProfileStore(): Promise<ProfileStore | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(res => {
    const open = indexedDB.open('photobaer-profiles', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('loaded', { keyPath: 'name' });
    open.onerror = () => res(null);
    open.onsuccess = () => {
      const db = open.result;
      const run = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => new Promise<T>((ok, no) => {
        const tx = db.transaction('loaded', mode);
        const r = f(tx.objectStore('loaded'));
        tx.oncomplete = () => ok(r.result);
        tx.onerror = tx.onabort = () => no(tx.error);
      });
      res({ all: () => run('readonly', s => s.getAll() as IDBRequest<StoredProfile[]>), put: async p => { await run('readwrite', s => s.put(p)); } });
    };
  });
}

const NAMES = 'photobaer.loadedProfiles';

// The loaded profile names by space, as last seen by the app.
export function loadedProfileNames(): { rgb: string[]; cmyk: string[]; gray: string[] } {
  const out = { rgb: [] as string[], cmyk: [] as string[], gray: [] as string[] };
  try {
    for (const p of JSON.parse(localStorage.getItem(NAMES) ?? '[]') as { name: string; space: keyof typeof out }[]) out[p.space]?.push(p.name);
  } catch { /* none */ }
  return out;
}

export function rememberLoadedProfiles(list: { name: string; space: string }[]) {
  try { localStorage.setItem(NAMES, JSON.stringify(list.map(({ name, space }) => ({ name, space })))); } catch { /* not stored this time */ }
}
