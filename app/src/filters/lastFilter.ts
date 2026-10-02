// Filter > Last Filter (docs/M5.md section 2): the last filter applied successfully in this session.

export type CurvePoint = { y: number; offset: number };
export type PathPoint = { x: number; y: number };
export interface Light {
  type: 'point' | 'spot' | 'infinite'; intensity: number; hotspot: number; x: number; y: number; z: number;
  targetX: number; targetY: number; color: string; enabled: boolean;
}
export type ParamValue = number | string | boolean | PathPoint | number[] | CurvePoint[] | PathPoint[] | Light[];
export interface AppliedFilter { kind: string; params: Record<string, ParamValue>; label: string }

let last: AppliedFilter | null = null;

export const lastFilter = () => last;
export const resetLastFilter = () => { last = null; };

// Applies `f` and records a copy once the apply succeeded.
export async function applyFilter(apply: (f: AppliedFilter) => Promise<void>, f: AppliedFilter) {
  const copy = { ...f, params: { ...f.params } };
  await apply(copy);
  last = copy;
}

export async function repeatLastFilter(apply: (f: AppliedFilter) => Promise<void>, report: (msg: string) => void) {
  if (!last) { report('No filter to reapply.'); return; }
  await applyFilter(apply, last);
}
