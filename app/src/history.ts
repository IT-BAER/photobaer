export interface Snapshots {
  snapshot(): number;
  restore(id: number): void;
  drop(id: number): void;
}

interface Step { label: string; snap: number }

// Memento history: each step holds a copy-on-write document snapshot taken before (undo) or after (redo) it.
export class History {
  #s: Snapshots;
  #limit: number;
  #undo: Step[] = [];
  #redo: Step[] = [];
  #open: Step | null = null;

  constructor(s: Snapshots, limit = 50) {
    this.#s = s;
    this.#limit = limit;
  }

  get undoLabel() { return this.#undo.at(-1)?.label ?? null; }
  get redoLabel() { return this.#redo.at(-1)?.label ?? null; }
  // Every step oldest first; the first `current` are applied, the rest can be redone.
  get labels() { return [...this.#undo, ...this.#redo.toReversed()].map(s => s.label); }
  get current() { return this.#undo.length; }

  goto(n: number) {
    let moved = false;
    while (this.#undo.length > n && this.undo()) moved = true;
    while (this.#undo.length < n && this.redo()) moved = true;
    return moved;
  }

  run(label: string, fn: () => void) {
    const snap = this.#s.snapshot();
    try {
      fn();
    } catch (e) {
      this.#s.restore(snap);
      this.#s.drop(snap);
      throw e;
    }
    this.#push({ label, snap });
  }

  // Multi-call ops (a stroke) span several `stroke_to` calls; begin() takes the snapshot once so
  // they land as one undo step. Caller must commit() or abort() before starting another run/begin.
  begin(label: string) {
    if (this.#open) throw new Error('a history step is already open');
    this.#open = { label, snap: this.#s.snapshot() };
  }

  commit() {
    const open = this.#open;
    if (!open) throw new Error('no history step is open');
    this.#open = null;
    this.#push(open);
  }

  // Puts the document back to the open step's starting state (a live preview rerun or cancel).
  restoreOpen() {
    if (!this.#open) throw new Error('no history step is open');
    this.#s.restore(this.#open.snap);
  }

  // Drops the pending snapshot; the caller (e.g. the engine's own stroke_cancel) is responsible
  // for reverting the document itself.
  abort() {
    if (!this.#open) throw new Error('no history step is open');
    this.#s.drop(this.#open.snap);
    this.#open = null;
  }

  // The earliest snapshot still kept (the state before the first undo step), or null with no history.
  oldestSnapshot(): number | null {
    return this.#undo[0]?.snap ?? null;
  }

  #push(step: Step) {
    this.#undo.push(step);
    this.#free(this.#redo.splice(0));
    if (this.#undo.length > this.#limit) this.#free(this.#undo.splice(0, this.#undo.length - this.#limit));
  }

  undo() { return this.#move(this.#undo, this.#redo); }
  redo() { return this.#move(this.#redo, this.#undo); }

  clear() {
    this.#free(this.#undo.splice(0));
    this.#free(this.#redo.splice(0));
  }

  #move(from: Step[], to: Step[]) {
    const step = from.pop();
    if (!step) return false;
    to.push({ label: step.label, snap: this.#s.snapshot() });
    this.#s.restore(step.snap);
    this.#s.drop(step.snap);
    return true;
  }

  #free(steps: Step[]) {
    for (const st of steps) this.#s.drop(st.snap);
  }
}
