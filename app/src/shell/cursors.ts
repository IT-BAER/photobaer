import { Crop, Frame, Lasso, MousePointer2, Navigation, PaintBucket, PenTool, Pipette, Slice, Wand2, WandSparkles } from 'lucide-react';
import { TOOLS } from './tools.ts';

type IconNode = [string, Record<string, string>][];
// lucide-react icons are forwardRef components whose render passes the icon data as the `icon` prop.
type LucideIcon = { render: (props: object, ref: null) => { props: { icon: { node: IconNode } } } };

// Canvas cursors drawn from the toolbar icon, like Photoshop's standard cursors; [x, y] is the hotspot in
// the icon's 24px grid (the lasso's rope end, the pipette tip, the pen nib, the crop corner).
const ICON_CURSORS: Record<string, [unknown, number, number]> = {
  lasso: [Lasso, 7, 22], polygonalLasso: [PenTool, 2, 2], magicWand: [Wand2, 20, 4], magicEraser: [WandSparkles, 20, 4],
  eyedropper: [Pipette, 2, 22], bucket: [PaintBucket, 20, 22], crop: [Crop, 6, 6], perspectiveCrop: [Frame, 6, 6],
  slice: [Slice, 2, 20], pen: [PenTool, 2, 2], pathSelection: [MousePointer2, 4, 4], directSelection: [Navigation, 22, 2],
};

const cache = new Map<string, string>();

function iconSvg(icon: unknown): string {
  const node = (icon as LucideIcon).render({}, null).props.icon.node;
  const shapes = node.map(([tag, attrs]) =>
    `<${tag} ${Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
  // A white halo under the black stroke keeps the cursor visible on any image.
  return '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">'
    + `<g stroke="#fff" stroke-width="4">${shapes}</g><g stroke="#000" stroke-width="2">${shapes}</g></svg>`;
}

// The CSS cursor for a tool over the canvas. Brush-type tools ('none') draw their own outline on the
// overlay while it shows; the crosshair is what remains when it does not.
export function toolCursor(id: string): string {
  const hit = cache.get(id);
  if (hit) return hit;
  const css = TOOLS[id]?.cursor ?? 'default';
  const fallback = css === 'none' ? 'crosshair' : css;
  const icon = ICON_CURSORS[id];
  const cursor = icon ? `url("data:image/svg+xml,${encodeURIComponent(iconSvg(icon[0]))}") ${icon[1]} ${icon[2]}, ${fallback}` : fallback;
  cache.set(id, cursor);
  return cursor;
}
