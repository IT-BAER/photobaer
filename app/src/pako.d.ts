// pako ships no type declarations; these are the functions the app calls.
declare module 'pako' {
  export function deflate(data: Uint8Array, options?: { level?: number }): Uint8Array<ArrayBuffer>;
  export class Inflate {
    constructor(options?: { chunkSize?: number });
    err: number;
    onData: (chunk: Uint8Array) => void;
    push(data: Uint8Array, last: boolean): boolean;
  }
}
