// pako ships no type declarations; these are the functions the app calls.
declare module 'pako' {
  export function deflate(data: Uint8Array, options?: { level?: number }): Uint8Array<ArrayBuffer>;
  export function inflate(data: Uint8Array): Uint8Array<ArrayBuffer>;
}
