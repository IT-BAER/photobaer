// On-canvas marks of the Ruler, Count, Color Sampler, Note, Slice, Artboard and Frame tools.
import { handlePoint, type Bounds, type CountGroup, type Handle, type Note, type Pt, type Slice } from '../app/measure.ts';

export interface MarksOverlay {
  ruler: [Pt, Pt] | null;
  counts: CountGroup[]; markerSize: number; labelSize: number;
  samplers: Pt[];
  notes: Note[]; selectedNote: number | null;
  slices: Slice[] | null; selectedSlice: number | null;
  drag: { rect: Bounds; shape: 'rectangle' | 'ellipse' } | null;
}

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const rgb = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

// Draws in CSS pixels; `sc` maps a document point to the screen.
export function drawMarks(ctx: CanvasRenderingContext2D, m: MarksOverlay, sc: (x: number, y: number) => Pt) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  const twoTone = (path: () => void) => {
    path(); ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
  };
  const label = (text: string, x: number, y: number, size: number, color = '#fff') => {
    ctx.font = `${size}px sans-serif`;
    ctx.lineWidth = 3; ctx.strokeStyle = '#000'; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  };
  if (m.slices) {
    m.slices.forEach((s, i) => {
      const [x0, y0] = sc(s.rect[0], s.rect[1]), [x1, y1] = sc(s.rect[2], s.rect[3]);
      const on = s.id === m.selectedSlice;
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeStyle = on ? '#ffb000' : '#3b82f6';
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      ctx.fillStyle = on ? '#ffb000' : '#3b82f6';
      ctx.fillRect(x0 + 1, y0 + 1, 22, 14);
      ctx.fillStyle = '#fff';
      ctx.font = '10px sans-serif';
      ctx.fillText(String(i + 1).padStart(2, '0'), x0 + 4, y0 + 12);
      if (on) for (const h of HANDLES) {
        const [hx, hy] = sc(...handlePoint(s.rect, h));
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
        ctx.fillRect(hx - 3, hy - 3, 6, 6); ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
      }
    });
  }
  if (m.drag) {
    const [x0, y0] = sc(m.drag.rect[0], m.drag.rect[1]), [x1, y1] = sc(m.drag.rect[2], m.drag.rect[3]);
    const path = () => {
      ctx.beginPath();
      if (m.drag!.shape === 'ellipse') ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
      else ctx.rect(x0, y0, x1 - x0, y1 - y0);
    };
    path(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
    ctx.setLineDash([5, 3]); path(); ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.setLineDash([]);
  }
  for (const g of m.counts) {
    if (!g.visible) continue;
    g.marks.forEach(([x, y], i) => {
      const [sx, sy] = sc(x, y), r = m.markerSize + 1;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = rgb(g.color); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
      label(String(i + 1), sx + r + 2, sy - r - 2, m.labelSize, rgb(g.color));
    });
  }
  m.samplers.forEach(([x, y], i) => {
    const [sx, sy] = sc(x, y);
    twoTone(() => {
      ctx.beginPath();
      ctx.moveTo(sx - 8, sy); ctx.lineTo(sx - 3, sy); ctx.moveTo(sx + 3, sy); ctx.lineTo(sx + 8, sy);
      ctx.moveTo(sx, sy - 8); ctx.lineTo(sx, sy - 3); ctx.moveTo(sx, sy + 3); ctx.lineTo(sx, sy + 8);
      ctx.moveTo(sx + 3, sy); ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    });
    label(`#${i + 1}`, sx + 8, sy + 16, 11);
  });
  for (const n of m.notes) {
    const [sx, sy] = sc(n.x, n.y);
    ctx.fillStyle = rgb(n.color);
    ctx.fillRect(sx, sy, 14, 12);
    ctx.beginPath(); ctx.moveTo(sx + 3, sy + 12); ctx.lineTo(sx + 3, sy + 16); ctx.lineTo(sx + 7, sy + 12); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = n.id === m.selectedNote ? '#1e90ff' : '#000'; ctx.lineWidth = n.id === m.selectedNote ? 2 : 1;
    ctx.strokeRect(sx + 0.5, sy + 0.5, 13, 11);
  }
  if (m.ruler) {
    const [a, b] = m.ruler.map(p => sc(p[0], p[1]));
    twoTone(() => { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); });
    for (const [x, y] of [a, b]) twoTone(() => { ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); });
  }
  ctx.restore();
}
