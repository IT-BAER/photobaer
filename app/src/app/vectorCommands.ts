// Layer menu Combine Shapes, Vector Mask and Rasterize entries, and the layer row context menu
// (docs/M4.md sections 5 to 7). Every entry acts on the selected layers.
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { client } from '../client.ts';
import { BOOL_LABEL } from '../shell/shapetools.ts';
import type { BoolOp, DocInfo, FillContent, LayerNode, VectorMaskInfo, VectorPath } from '../worker/types.ts';
import { selectCreated, tl, type Item, type Run } from './helpers.ts';

type ShapeInfo = NonNullable<LayerNode['shape']>;
const OPS: BoolOp[] = ['unite', 'subtract', 'intersect', 'exclude'];

/** The canvas rect as a one-subpath path (Reveal All / Hide All). */
export function rectPath(w: number, h: number): VectorPath {
  const c = (x: number, y: number): [number, number, number, number, number, number] => [x, y, x, y, x, y];
  return { fill_rule: 'nonzero', subpaths: [{ closed: true, op: 'combine', points: [c(0, 0), c(w, 0), c(w, h), c(0, h)] }] };
}

/** The work path, else the last saved path; null when it has no subpaths. */
export function currentPath(doc: DocInfo): VectorPath | null {
  const p = doc.paths.find(x => x.work) ?? doc.paths.at(-1);
  return p && p.path.subpaths.length ? p.path : null;
}

const newMask = (path: VectorPath, inverted: boolean): VectorMaskInfo => ({ path, enabled: true, linked: true, inverted, density: 1, feather: 0 });

export function vectorMaskItems(doc: DocInfo, nodes: LayerNode[], run: Run): Item[] {
  const masked = nodes.filter(n => n.vector_mask);
  const edit = (targets: LayerNode[], mask: (n: LayerNode) => VectorMaskInfo | null, label: string) =>
    run(null, () => client.call('vectorMaskEdit', targets.map(n => ({ id: n.id, mask: mask(n) })), label));
  const toggle = (key: 'enabled' | 'linked', label: MessageDescriptor) => {
    const on = masked.some(n => n.vector_mask![key]);
    return { ...tl(label, on), off: !masked.length, run: () => edit(masked, n => ({ ...n.vector_mask!, [key]: !on }), label.message!) };
  };
  const cur = currentPath(doc);
  return [
    { ...tl(msg`Reveal All`), off: !nodes.length, run: () => edit(nodes, () => newMask(rectPath(doc.width, doc.height), false), 'Reveal All') },
    { ...tl(msg`Hide All`), off: !nodes.length, run: () => edit(nodes, () => newMask(rectPath(doc.width, doc.height), true), 'Hide All') },
    { ...tl(msg`Current Path`), off: !nodes.length || !cur, run: () => cur && edit(nodes, () => newMask(cur, false), 'Current Path') },
    { ...tl(msg`Delete`), sep: true, off: !masked.length, run: () => edit(masked, () => null, 'Delete Vector Mask') },
    { ...toggle('enabled', msg`Enable Vector Mask`), sep: true },
    toggle('linked', msg`Link Vector Mask`),
  ];
}

export function combineItems(nodes: LayerNode[], run: Run): Item[] {
  const shapes = nodes.filter(n => n.kind === 'shape').map(n => n.id);
  return [
    ...OPS.map(op => ({ ...tl(BOOL_LABEL[op]), off: shapes.length < 2, run: () => run(null, () => client.call('combineShapes', shapes, op), selectCreated) })),
    { ...tl(msg`Merge Shape Components`), sep: true, off: !shapes.length, run: () => run(null, () => client.call('mergeShapeComponents', shapes)) },
  ];
}

export function rasterizeItems(nodes: LayerNode[], run: Run): Item[] {
  const of = (pick: (n: LayerNode) => boolean) => nodes.filter(pick).map(n => n.id);
  const item = (label: MessageDescriptor, what: 'type' | 'shape' | 'vectorMask', ids: number[]) =>
    ({ ...tl(label), off: !ids.length, run: () => run(t`Rasterizing…`, () => client.call('rasterizeLayers', what, ids)) });
  return [
    item(msg`Type`, 'type', of(n => n.kind === 'text')),
    item(msg`Shape`, 'shape', of(n => n.kind === 'shape')),
    item(msg`Vector Mask`, 'vectorMask', of(n => !!n.vector_mask)),
  ];
}

// Copy Shape Attributes keeps the fill and stroke records for Paste Shape Attributes.
let shapeAttrs: { fill: FillContent | null; stroke: ShapeInfo['stroke'] } | null = null;

async function copyCode(id: number, format: 'svg' | 'css') {
  const r = await client.call('layerCode', id, format);
  await navigator.clipboard.writeText(r.text);
}

/** The layer row context menu: shape attributes for shape layers, then Copy CSS / Copy SVG. */
export function layerContextItems(n: LayerNode, nodes: LayerNode[], run: Run, onError: (m: string) => void): Item[] {
  const shapes = nodes.filter(x => x.kind === 'shape' && x.shape);
  const copy = (format: 'svg' | 'css') => () => { copyCode(n.id, format).catch(e => onError((e as Error).message)); };
  return [
    ...(n.kind === 'shape' && n.shape ? [
      { ...tl(msg`Copy Shape Attributes`), run: () => { shapeAttrs = structuredClone({ fill: n.shape!.fill, stroke: n.shape!.stroke }); } },
      {
        ...tl(msg`Paste Shape Attributes`), off: !shapeAttrs, run: () => {
          const a = shapeAttrs;
          if (a) run(null, () => client.call('setShapes', shapes.map(x => ({ id: x.id, shape: { live: x.shape!.live, fill: a.fill, stroke: a.stroke } })), 'Paste Shape Attributes'));
        },
      },
    ] : []),
    { ...tl(msg`Copy CSS`), sep: n.kind === 'shape', run: copy('css') },
    { ...tl(msg`Copy SVG`), run: copy('svg') },
  ];
}
