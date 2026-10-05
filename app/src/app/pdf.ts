// pdf.js, loaded only when a PDF is opened.
import { getDocument, GlobalWorkerOptions, ImageKind, OPS, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

// getDocument transfers `data`, so callers pass a copy they do not need again.
export const loadPdf = (data: Uint8Array, password?: string) => getDocument({ data, password }).promise;

// The viewport over `box` in PDF units (default: the visible crop), rotated as the page, `scale` px per pt.
// pdf.js does not clip to its crop, so a larger box renders the content around it.
function boxViewport(page: PDFPageProxy, scale: number, box?: number[]) {
  const v = page.getViewport({ scale });
  if (!box) return v;
  const Viewport = v.constructor as new (o: object) => typeof v;
  return new Viewport({ viewBox: box, userUnit: page.userUnit, scale, rotation: page.rotate });
}

// The page size in pt over `box` (default: the visible crop), rotated as the page.
export async function pageSize(pdf: PDFDocumentProxy, n: number, box?: number[]): Promise<[number, number]> {
  const v = boxViewport(await pdf.getPage(n), 1, box);
  return [v.width, v.height];
}

const toPng = async (canvas: HTMLCanvasElement, what: string) => {
  const png = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
  if (!png) throw new Error(`${what} could not be rendered.`);
  return png;
};
const tooLarge = (w: number, h: number) => w > 32767 || h > 32767 || w * h > 268435456;

// Page `n` over `box` on a transparent canvas, `sx` x `sy` px per pt, as PNG.
export async function renderPage(pdf: PDFDocumentProxy, n: number, sx: number, sy = sx, box?: number[]): Promise<Blob> {
  const page = await pdf.getPage(n);
  const viewport = boxViewport(page, sx, box);
  const w = Math.max(1, Math.round(viewport.width)), h = Math.max(1, Math.round(viewport.height * sy / sx));
  if (tooLarge(w, h)) throw new Error(`Page ${n} at this size is ${w} x ${h} px, too large for the browser canvas.`);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  // Given `canvas`, pdf.js opens it without alpha; an alpha context keeps empty page areas transparent.
  await page.render({ canvas: null, canvasContext: canvas.getContext('2d')!, viewport, background: 'rgba(0,0,0,0)', transform: sy === sx ? undefined : [1, 0, 0, sy / sx, 0, 0] }).promise;
  return toPng(canvas, `Page ${n}`);
}

type PdfImage = { width: number; height: number; bitmap?: ImageBitmap; kind?: number; data?: Uint8Array | Uint8ClampedArray };

function imageCanvas(img: PdfImage): HTMLCanvasElement {
  const { width: w, height: h } = img;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  if (img.bitmap) { ctx.drawImage(img.bitmap, 0, 0); return canvas; }
  const src = img.data!, out = ctx.createImageData(w, h), d = out.data;
  if (img.kind === ImageKind.RGBA_32BPP) d.set(src.subarray(0, w * h * 4));
  else if (img.kind === ImageKind.RGB_24BPP) for (let i = 0; i < w * h; i++) { d[i * 4] = src[i * 3]; d[i * 4 + 1] = src[i * 3 + 1]; d[i * 4 + 2] = src[i * 3 + 2]; d[i * 4 + 3] = 255; }
  else {
    // GRAYSCALE_1BPP: rows padded to bytes, a set bit is white.
    const row = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = src[y * row + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0, o = (y * w + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

export interface PdfImageRef { key: string; page: number; width: number; height: number; canvas: HTMLCanvasElement }

// The images page `n` paints, once each, at their own pixel size (soft masks applied by pdf.js).
export async function pageImages(pdf: PDFDocumentProxy, n: number): Promise<PdfImageRef[]> {
  const page = await pdf.getPage(n);
  const ops = await page.getOperatorList();
  const seen = new Set<string>(), out: PdfImageRef[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    let img: PdfImage | null = null, key = '';
    if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const id = args[0] as string;
      key = id;
      if (seen.has(key)) continue;
      const objs = id.startsWith('g_') ? page.commonObjs : page.objs;
      img = await new Promise<PdfImage>(r => objs.get(id, r));
    } else if (fn === OPS.paintInlineImageXObject) { img = args[0] as PdfImage; key = `inline-${n}-${i}`; }
    if (!img || seen.has(key) || img.width < 1 || img.height < 1) continue;
    seen.add(key);
    if (tooLarge(img.width, img.height)) continue;
    out.push({ key, page: n, width: img.width, height: img.height, canvas: imageCanvas(img) });
  }
  return out;
}

export const imagePng = (img: PdfImageRef) => toPng(img.canvas, 'The image');

// A thumbnail of page `n` (or of a canvas), at most `size` px on its long side, on white, as an object URL.
export async function thumbnail(pdf: PDFDocumentProxy | null, n: number, size: number, from?: HTMLCanvasElement): Promise<string> {
  const canvas = document.createElement('canvas');
  if (from) {
    const k = Math.min(1, size / Math.max(from.width, from.height));
    canvas.width = Math.max(1, Math.round(from.width * k));
    canvas.height = Math.max(1, Math.round(from.height * k));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(from, 0, 0, canvas.width, canvas.height);
  } else {
    const page = await pdf!.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: size / Math.max(v1.width, v1.height) });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
  }
  const b = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
  return b ? URL.createObjectURL(b) : '';
}
