// Edit > Define Brush Preset, Define Pattern and Define Custom Shape: what the worker sampled goes into the libraries.
import { defaultDynamics, type BrushPreset } from '../brushes/preset.ts';
import type { BrushLibrary } from '../brushes/store.ts';
import { fitUnit, type ShapeLibrary } from '../shell/customShapes.ts';
import type { DocInfo, LayerNode, VectorPath } from '../worker/types.ts';

const newId = (kind: string) => `${kind}.${crypto.randomUUID()}`;

/** Adds a sampled-tip preset (and its tip) to `lib`; the stored preset, or null when the library is full. */
export function addBrushPreset(lib: BrushLibrary, name: string, tip: { width: number; height: number; alpha: Uint8Array }): BrushPreset | null {
  const tipRef = newId('tip');
  const preset: BrushPreset = {
    id: newId('brush'), name,
    tip: { kind: 'sampled', tipRef, diameter: Math.max(tip.width, tip.height), hardness: 1, angle: 0, roundness: 1, spacing: 0.25, flipX: false, flipY: false },
    dynamics: defaultDynamics(),
  };
  const { added } = lib.import({ presets: [preset], tips: [{ id: tipRef, name, ...tip }], patterns: [] });
  return added ? lib.list().find(p => p.id === preset.id) ?? null : null;
}

/** Adds an RGBA pattern to `lib`; returns its id. */
export function addPattern(lib: BrushLibrary, name: string, p: { width: number; height: number; data: Uint8Array }) {
  const id = newId('pattern');
  lib.import({ presets: [], tips: [], patterns: [{ id, name, width: p.width, height: p.height, channels: 4, data: p.data }] });
  return id;
}

/** The path Define Custom Shape takes: the active shape layer's, else its vector mask, else the selected saved path. */
export function customShapeSource(doc: DocInfo | null, node: LayerNode | undefined, selectedPath: number | null): VectorPath | null {
  const p = node?.shape?.path ?? node?.vector_mask?.path ?? doc?.paths.find(x => x.id === selectedPath)?.path ?? null;
  return p?.subpaths.some(s => s.points.length) ? p : null;
}

export function addCustomShape(lib: ShapeLibrary, name: string, path: VectorPath) {
  lib.append([{ id: newId('user'), name, path: fitUnit(path) }]);
}
