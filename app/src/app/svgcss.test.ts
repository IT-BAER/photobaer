import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerCss, shapeSvg } from './svgcss.ts';
import { defaultBlending } from '../layerStyle.ts';
import type { LayerNode, PathAnchor, VectorMaskInfo } from '../worker/types.ts';
import type { ShapeStroke } from '../shell/shapetools.ts';

const c = (x: number, y: number): PathAnchor => [x, y, x, y, x, y];
function rect(extra: Partial<LayerNode> = {}): LayerNode {
  return {
    id: 2, name: 'Rectangle', kind: 'shape', visible: true, opacity: 1, fill: 1, blend: 'normal', clipping: false,
    locks: { transparency: false, pixels: false, position: false }, mask: null, style: null, blending: defaultBlending(), vector_mask: null,
    shape: {
      path: { fill_rule: 'nonzero', subpaths: [{ closed: true, op: 'combine', points: [c(10, 10), c(110, 10), c(110, 70), c(10, 70)] }] },
      live: null, fill: { type: 'solid', color: [255, 0, 0] }, stroke: null,
    },
    ...extra,
  } as LayerNode;
}
const bounds: [number, number, number, number] = [10, 10, 100, 60];

test('Copy SVG of a red 100 x 60 rect: viewBox from the layer bounds, rgb fill, cubic segments, nonzero', () => {
  const svg = shapeSvg(rect(), bounds);
  assert.equal(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60" viewBox="10 10 100 60">'
    + '<path d="M 10 10 C 10 10 110 10 110 10 C 110 10 110 70 110 70 C 110 70 10 70 10 70 C 10 70 10 10 10 10 Z" fill="rgb(255, 0, 0)" fill-rule="nonzero" opacity="1"/></svg>');
});

test('Copy SVG writes a solid centered stroke and opacity x fill, and refuses what it cannot keep', () => {
  const stroke: ShapeStroke = {
    enabled: true, width: 4, align: 'center', cap: 'round', join: 'bevel', miter_limit: 4, dash: [8, 4], dash_offset: 1,
    content: { type: 'solid', color: [0, 0, 255] }, opacity: 1, blend: 'normal',
  };
  const n = rect({ opacity: 0.5, fill: 0.5 });
  n.shape!.stroke = { ...stroke };
  const svg = shapeSvg(n, bounds)!;
  assert.match(svg, / opacity="0.25" stroke="rgb\(0, 0, 255\)" stroke-width="4" stroke-linecap="round" stroke-linejoin="bevel" stroke-miterlimit="4" stroke-dashoffset="1" stroke-dasharray="8 4"\/>/);
  n.shape!.fill = null;
  assert.match(shapeSvg(n, bounds)!, / fill="none" /);
  const refused: Partial<LayerNode>[] = [
    { blend: 'multiply' }, { clipping: true }, { mask: { enabled: true, default: 255 } }, { vector_mask: { path: { fill_rule: 'nonzero', subpaths: [] } } as unknown as VectorMaskInfo },
    { style: {} as LayerNode['style'] }, { blending: { ...defaultBlending(), knockout: 'deep' } },
  ];
  for (const r of refused) assert.equal(shapeSvg(rect(r), bounds), null, JSON.stringify(r));
  const grad = rect();
  grad.shape!.fill = { type: 'pattern' } as unknown as NonNullable<LayerNode['shape']>['fill'];
  assert.equal(shapeSvg(grad, bounds), null, 'solid fill only');
  const inside = rect();
  inside.shape!.stroke = { ...stroke, align: 'inside' };
  assert.equal(shapeSvg(inside, bounds), null, 'center stroke only');
  const sub = rect();
  sub.shape!.path.subpaths.push({ closed: true, op: 'subtract', points: [c(20, 20), c(30, 20), c(30, 30)] });
  assert.equal(shapeSvg(sub, bounds), null, 'combine subpaths only');
  assert.equal(shapeSvg({ ...rect(), kind: 'pixel', shape: undefined }, bounds), null);
});

test('Copy CSS is one absolute rule with the SVG as its background', () => {
  const svg = shapeSvg(rect(), bounds)!;
  const css = layerCss(svg, bounds);
  assert.equal(css, `.photobaer-layer {\n  position: absolute;\n  left: 10px;\n  top: 10px;\n  width: 100px;\n  height: 60px;\n`
    + `  background: url("data:image/svg+xml,${encodeURIComponent(svg)}") center / 100% 100% no-repeat;\n}`);
  assert.ok(!layerCss("<svg a='1'/>", bounds).includes("'"), 'quotes are escaped');
});
