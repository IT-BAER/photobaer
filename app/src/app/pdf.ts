// pdf.js, loaded only when a PDF is opened.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

// getDocument transfers `data`, so callers pass a copy they do not need again.
export const loadPdf = (data: Uint8Array, password?: string) => getDocument({ data, password }).promise;

// Page `n` on a transparent canvas, `scale` px per pt, as PNG.
export async function renderPage(pdf: PDFDocumentProxy, n: number, scale: number): Promise<Blob> {
  const page = await pdf.getPage(n);
  const viewport = page.getViewport({ scale });
  const w = Math.ceil(viewport.width), h = Math.ceil(viewport.height);
  if (w > 32767 || h > 32767 || w * h > 268435456) throw new Error(`Page ${n} at this resolution is ${w} x ${h} px, too large for the browser canvas.`);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  // Given `canvas`, pdf.js opens it without alpha; an alpha context keeps empty page areas transparent.
  await page.render({ canvas: null, canvasContext: canvas.getContext('2d')!, viewport, background: 'rgba(0,0,0,0)' }).promise;
  const png = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
  if (!png) throw new Error(`Page ${n} could not be rendered.`);
  return png;
}

// A thumbnail of page `n`, at most `size` px on its long side, on white, as an object URL.
export async function thumbnail(pdf: PDFDocumentProxy, n: number, size: number): Promise<string> {
  const page = await pdf.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: size / Math.max(v1.width, v1.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  const b = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
  return b ? URL.createObjectURL(b) : '';
}
