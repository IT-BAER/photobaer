// Tile ids a document manifest references; autosave writes and restores exactly these.
// v1 and v2 store a dense array of tile ids, v3 a sparse list of [tx, ty, id].
// v4 adds smart-object tiles and a top-level list of blob ids (smart sources, patterns, lookup tables).
type TileList = (number | [number, number, number])[];
type Mask = { tiles?: TileList } | null;
type Smart = { source?: { tiles?: TileList }; filters?: { mask?: Mask }[]; stack_mask?: Mask };
type ManifestNode = { tiles?: TileList; mask?: Mask; smart?: Smart; children?: ManifestNode[] };
type Manifest = {
  layers: ManifestNode[];
  selection?: Mask;
  last_selection?: Mask;
  channels?: { tiles?: TileList }[];
  blobs?: number[];
};

export function tileIds(manifest: string): Set<number> {
  const ids = new Set<number>();
  const add = (list?: TileList) => {
    for (const e of list ?? []) {
      const id = Array.isArray(e) ? e[2] : e;
      if (id) ids.add(id);
    }
  };
  const walk = (n: ManifestNode) => {
    add(n.tiles);
    add(n.mask?.tiles);
    add(n.smart?.source?.tiles);
    for (const f of n.smart?.filters ?? []) add(f.mask?.tiles);
    add(n.smart?.stack_mask?.tiles);
    for (const c of n.children ?? []) walk(c);
  };
  const m = JSON.parse(manifest) as Manifest;
  for (const n of m.layers) walk(n);
  add(m.selection?.tiles);
  add(m.last_selection?.tiles);
  for (const c of m.channels ?? []) add(c.tiles);
  add(m.blobs);
  return ids;
}
