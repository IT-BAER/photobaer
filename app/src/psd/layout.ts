// PSD guides, grid, resolution and artboards (docs/M4.md sections 11 and 12).
// Units: guide locations are px (ag-psd scales by 32); grid spacing is raw 1/32 px (576 = 18 px);
// resolution is ppi (the PSD stores ppi whatever display unit is chosen).
import type { Layer, Psd } from 'ag-psd';

type Guide = { id: number; axis: 'x' | 'y'; pos: number };
interface DocLayout { resolution: number; guides: Guide[]; grid?: { spacing_x: number; spacing_y: number } }

export function layoutIn(psd: Psd): DocLayout {
  const r = psd.imageResources, gg = r?.gridAndGuidesInformation;
  const res = r?.resolutionInfo?.horizontalResolution;
  const out: DocLayout = {
    resolution: res && res >= 1 && res <= 30000 ? res : 72,
    // Out-of-range guides are dropped; `guideIndices` still count them.
    guides: (gg?.guides ?? []).flatMap((g, i) => Number.isFinite(g.location) && Math.abs(g.location) <= 1e7
      ? [{ id: i + 1, axis: g.direction === 'vertical' ? 'x' as const : 'y' as const, pos: g.location }] : []),
  };
  if (gg?.grid && gg.grid.horizontal > 0 && gg.grid.vertical > 0) out.grid = { spacing_x: gg.grid.horizontal / 32, spacing_y: gg.grid.vertical / 32 };
  return out;
}

export function layoutOut(m: DocLayout & { grid: { spacing_x: number; spacing_y: number } }): NonNullable<Psd['imageResources']> {
  return {
    resolutionInfo: {
      horizontalResolution: m.resolution, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches',
      verticalResolution: m.resolution, verticalResolutionUnit: 'PPI', heightUnit: 'Inches',
    },
    gridAndGuidesInformation: {
      grid: { horizontal: Math.round(m.grid.spacing_x * 32), vertical: Math.round(m.grid.spacing_y * 32) },
      guides: m.guides.map(g => ({ location: g.pos, direction: g.axis === 'x' ? 'vertical' : 'horizontal' })),
    },
  };
}

// backgroundType: 1 white, 2 black, 3 transparent, 4 other color.
const BACKGROUNDS = ['none', 'white', 'black', 'transparent', 'color'];

export function artboardIn(l: Layer, guides: Guide[]) {
  const a = l.artboard!, c = a.color && 'r' in a.color ? a.color : undefined;
  const type = BACKGROUNDS[a.backgroundType ?? 0] ?? 'none';
  return {
    rect: [a.rect.left, a.rect.top, a.rect.right, a.rect.bottom],
    background: type === 'color' ? { type, color: c ? [c.r, c.g, c.b].map(Math.round) : [255, 255, 255] } : { type },
    preset_name: a.presetName ?? '',
    guide_ids: (a.guideIndices ?? []).filter((i: number) => guides.some(g => g.id === i + 1)).map((i: number) => i + 1),
  };
}

export function artboardOut(a: any, guides: Guide[]): Layer['artboard'] {
  const [left, top, right, bottom] = a.rect;
  const bg = a.background;
  const rgb = bg.type === 'color' ? bg.color : bg.type === 'black' ? [0, 0, 0] : [255, 255, 255];
  return {
    rect: { left, top, right, bottom }, presetName: a.preset_name, backgroundType: Math.max(0, BACKGROUNDS.indexOf(bg.type)),
    color: { r: rgb[0], g: rgb[1], b: rgb[2] }, guideIndices: a.guide_ids.map((id: number) => guides.findIndex(g => g.id === id)).filter((i: number) => i >= 0),
  };
}
