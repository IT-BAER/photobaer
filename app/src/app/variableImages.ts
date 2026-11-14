type Picked = { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };
type Call = (files: { name: string; bytes: Uint8Array }[]) => Promise<string[]>;

/** Sends picked replacement images one per call, so peak memory is one file; a file over 1 GB is refused before any is read. */
export async function sendVariableImages(files: Picked[], call: Call, onLoaded: (names: string[]) => void) {
  if (files.some(f => f.size > 2 ** 30)) throw new Error('The replacement images are limited to 1 GB in total.');
  for (const f of files) onLoaded(await call([{ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }]));
}
