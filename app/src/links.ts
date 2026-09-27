// Linked smart object files (D7): File System Access handles in IndexedDB, keyed by link id.
// Without IndexedDB (Node tests) the handles live in memory for the session.
type Handle = FileSystemFileHandle;
const DB = 'photobaer-links', STORE = 'handles';
const memory = new Map<string, Handle>();

function db(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function request<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> | null {
  const open = db();
  return open && open.then(d => new Promise<T>((res, rej) => {
    const r = f(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => { res(r.result as T); d.close(); };
    r.onerror = () => { rej(r.error); d.close(); };
  }));
}

export async function putHandle(key: string, h: Handle) {
  memory.set(key, h);
  await request('readwrite', s => s.put(h, key));
}

export async function getHandle(key: string): Promise<Handle | null> {
  return memory.get(key) ?? (await request<Handle | undefined>('readonly', s => s.get(key))) ?? null;
}
