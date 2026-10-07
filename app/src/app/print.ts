// File > Print: page layout in mm and the page printed from a hidden frame (printer, copies and
// "Save as PDF" are chosen in the browser's print dialog).
import { t } from '@lingui/core/macro';

export const PAPERS = [
  { id: 'letter', label: 'US Letter', widthMm: 215.9, heightMm: 279.4 },
  { id: 'legal', label: 'US Legal', widthMm: 215.9, heightMm: 355.6 },
  { id: 'tabloid', label: 'Tabloid', widthMm: 279.4, heightMm: 431.8 },
  { id: 'a3', label: 'A3', widthMm: 297, heightMm: 420 },
  { id: 'a4', label: 'A4', widthMm: 210, heightMm: 297 },
  { id: 'a5', label: 'A5', widthMm: 148, heightMm: 210 },
] as const;

export interface PrintSettings {
  paper: typeof PAPERS[number]['id']; orientation: 'portrait' | 'landscape'; sizing: 'fit' | 'actual' | 'custom'; scale: number;
  centered: boolean; offsetXMm: number; offsetYMm: number; marginMm: number; bleedMm: number;
  cropMarks: boolean; registrationMarks: boolean; labels: boolean;
}
export interface PrintLayout { pageWidthMm: number; pageHeightMm: number; xMm: number; yMm: number; widthMm: number; heightMm: number; scale: number }

export const defaultPrint = (): PrintSettings => ({
  paper: 'letter', orientation: 'portrait', sizing: 'fit', scale: 1, centered: true, offsetXMm: 0, offsetYMm: 0, marginMm: 6.35, bleedMm: 0,
  cropMarks: false, registrationMarks: false, labels: false,
});

const MM_PER_INCH = 25.4;

/** Where a `w` x `h` px image at `ppi` lands on the page; offsets count from the margins. */
export function printLayout(w: number, h: number, ppi: number, s: PrintSettings): PrintLayout {
  const p = PAPERS.find(x => x.id === s.paper) ?? PAPERS[0];
  const [pw, ph] = s.orientation === 'landscape' ? [p.heightMm, p.widthMm] : [p.widthMm, p.heightMm];
  const aw = Math.max(1, pw - s.marginMm * 2), ah = Math.max(1, ph - s.marginMm * 2);
  const iw = w / ppi * MM_PER_INCH, ih = h / ppi * MM_PER_INCH;
  const scale = s.sizing === 'fit' ? Math.min(aw / iw, ah / ih) : s.sizing === 'actual' ? 1 : Math.max(0.01, s.scale);
  const widthMm = iw * scale, heightMm = ih * scale;
  return {
    pageWidthMm: pw, pageHeightMm: ph, widthMm, heightMm, scale,
    xMm: s.centered ? (pw - widthMm) / 2 : s.marginMm + s.offsetXMm,
    yMm: s.centered ? (ph - heightMm) / 2 : s.marginMm + s.offsetYMm,
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One printed page: the image (`src`) with crop marks at the bleed edge, registration marks and a label. */
export function printHtml(l: PrintLayout, s: PrintSettings, src: string, label: string): string {
  const marks: string[] = [];
  const b = s.bleedMm, x = l.xMm - b, y = l.yMm - b, w = l.widthMm + b * 2, h = l.heightMm + b * 2;
  if (s.cropMarks) {
    for (const [cx, cy, dx, dy] of [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]]) {
      marks.push(`<div class="mark" style="left:${cx + (dx < 0 ? -5 : 0)}mm;top:${cy}mm;width:5mm;height:0.2mm"></div>`,
        `<div class="mark" style="left:${cx}mm;top:${cy + (dy < 0 ? -5 : 0)}mm;width:0.2mm;height:5mm"></div>`);
    }
  }
  if (s.registrationMarks) {
    for (const [cx, cy] of [[l.pageWidthMm / 2, 6], [l.pageWidthMm / 2, l.pageHeightMm - 6], [6, l.pageHeightMm / 2], [l.pageWidthMm - 6, l.pageHeightMm / 2]]) {
      marks.push(`<div class="reg" style="left:${cx - 2}mm;top:${cy - 2}mm"></div>`);
    }
  }
  if (s.labels) marks.push(`<div class="label" style="left:${l.xMm}mm;top:${Math.max(2, l.yMm - 5)}mm">${esc(label)}</div>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(label)}</title><style>
@page { size: ${l.pageWidthMm}mm ${l.pageHeightMm}mm; margin: 0; }
html, body { margin: 0; padding: 0; }
.page { position: relative; width: ${l.pageWidthMm}mm; height: ${l.pageHeightMm}mm; overflow: hidden; }
.page > * { position: absolute; }
.mark { background: #000; }
.reg { width: 4mm; height: 4mm; box-sizing: border-box; border: 0.2mm solid #000; border-radius: 50%;
  background: linear-gradient(#000, #000) center / 0.2mm 100% no-repeat, linear-gradient(#000, #000) center / 100% 0.2mm no-repeat; }
.label { font: 8pt sans-serif; white-space: nowrap; }
</style></head><body><div class="page"><img src="${esc(src)}" alt="" style="left:${l.xMm}mm;top:${l.yMm}mm;width:${l.widthMm}mm;height:${l.heightMm}mm">${marks.join('')}</div></body></html>`;
}

/** Opens the browser's print dialog for `html` in a hidden frame; resolves after the dialog closes. */
export function printPage(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;height:400px;border:0;visibility:hidden';
    document.body.appendChild(f);
    const done = (err?: unknown) => { setTimeout(() => f.remove(), 1000); if (err) reject(err); else resolve(); };
    const d = f.contentDocument, w = f.contentWindow;
    if (!d || !w) { f.remove(); reject(new Error(t`The print frame could not be created.`)); return; }
    d.open();
    d.write(html);
    d.close();
    const img = d.querySelector('img');
    const go = () => { try { w.focus(); w.print(); done(); } catch (e) { done(e); } };
    if (!img || img.complete) go();
    else { img.onload = go; img.onerror = () => done(new Error(t`The print image could not be loaded.`)); }
  });
}
