// Layer menu Combine Shapes, Vector Mask and Rasterize entries, and the layer row context menu
// (docs/M4.md sections 5 to 7). Every entry acts on the selected layers.
import { client } from '../client.ts';
import { BOOL_LABEL } from '../shell/shapetools.ts';
import type { BoolOp, DocInfo, FillContent, LayerNode, VectorMaskInfo, VectorPath } from '../worker/types.ts';
import { selectCreated, type Item, type Run } from './helpers.ts';

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
  const toggle = (key: 'enabled' | 'linked', label: string) => {
    const on = masked.some(n => n.vector_mask![key]);
    return { label: `${on ? '✓ ' : ''}${label}`, off: !masked.length, run: () => edit(masked, n => ({ ...n.vector_mask!, [key]: !on }), label) };
  };
  const cur = currentPath(doc);
  return [
    { label: 'Reveal All', off: !nodes.length, run: () => edit(nodes, () => newMask(rectPath(doc.width, doc.height), false), 'Reveal All') },
    { label: 'Hide All', off: !nodes.length, run: () => edit(nodes, () => newMask(rectPath(doc.width, doc.height), true), 'Hide All') },
    { label: 'Current Path', off: !nodes.length || !cur, run: () => cur && edit(nodes, () => newMask(cur, false), 'Current Path') },
    { label: 'Delete', sep: true, off: !masked.length, run: () => edit(masked, () => null, 'Delete Vector Mask') },
    { ...toggle('enabled', 'Enable Vector Mask'), sep: true },
    toggle('linked', 'Link Vector Mask'),
  ];
}

export function combineItems(nodes: LayerNode[], run: Run): Item[] {
  const shapes = nodes.filter(n => n.kind === 'shape').map(n => n.id);
  return [
    ...OPS.map(op => ({ label: BOOL_LABEL[op], off: shapes.length < 2, run: () => run(null, () => client.call('combineShapes', shapes, op), selectCreated) })),
    { label: 'Merge Shape Components', sep: true, off: !shapes.length, run: () => run(null, () => client.call('mergeShapeComponents', shapes)) },
  ];
}

export function rasterizeItems(nodes: LayerNode[], run: Run): Item[] {
  const of = (pick: (n: LayerNode) => boolean) => nodes.filter(pick).map(n => n.id);
  const item = (label: string, what: 'type' | 'shape' | 'vectorMask', ids: number[]) =>
    ({ label, off: !ids.length, run: () => run('Rasterizing…', () => client.call('rasterizeLayers', what, ids)) });
  return [
    item('Type', 'type', of(n => n.kind === 'text')),
    item('Shape', 'shape', of(n => n.kind === 'shape')),
    item('Vector Mask', 'vectorMask', of(n => !!n.vector_mask)),
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
      { label: 'Copy Shape Attributes', run: () => { shapeAttrs = structuredClone({ fill: n.shape!.fill, stroke: n.shape!.stroke }); } },
      {
        label: 'Paste Shape Attributes', off: !shapeAttrs, run: () => {
          const a = shapeAttrs;
          if (a) run(null, () => client.call('setShapes', shapes.map(x => ({ id: x.id, shape: { live: x.shape!.live, fill: a.fill, stroke: a.stroke } })), 'Paste Shape Attributes'));
        },
      },
    ] : []),
    { label: 'Copy CSS', sep: n.kind === 'shape', run: copy('css') },
    { label: 'Copy SVG', run: copy('svg') },
  ];
}
