import { GRID_W, GRID_H, MAX_AGENTS } from './constants.ts';

const CELL = 16;
const BX = Math.ceil(GRID_W / CELL);
const BY = Math.ceil(GRID_H / CELL);
const NB = BX * BY;

/**
 * Uniform-grid spatial index over agent positions, rebuilt each tick with a
 * counting sort. Allocation-free after construction.
 */
export class SpatialIndex {
  /** bucket -> number of agents */
  private counts = new Int32Array(NB);
  /** bucket -> offset of its run in `items` (NB+1 so bucket b spans [starts[b], starts[b+1]) ) */
  private starts = new Int32Array(NB + 1);
  /** working cursor used only while filling */
  private cursor = new Int32Array(NB);
  items = new Int32Array(MAX_AGENTS);
  size = 0;

  private alive: Uint8Array;
  private ax: Int16Array;
  private ay: Int16Array;

  constructor(alive: Uint8Array, ax: Int16Array, ay: Int16Array) {
    this.alive = alive;
    this.ax = ax;
    this.ay = ay;
  }

  private bucketOf(x: number, y: number): number {
    const bx = Math.min(BX - 1, Math.max(0, (x / CELL) | 0));
    const by = Math.min(BY - 1, Math.max(0, (y / CELL) | 0));
    return by * BX + bx;
  }

  build(): void {
    this.counts.fill(0);
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (this.alive[i]) this.counts[this.bucketOf(this.ax[i], this.ay[i])]++;
    }
    let sum = 0;
    for (let b = 0; b < NB; b++) {
      this.starts[b] = sum;
      this.cursor[b] = sum;
      sum += this.counts[b];
    }
    this.starts[NB] = sum;
    this.size = sum;
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (!this.alive[i]) continue;
      this.items[this.cursor[this.bucketOf(this.ax[i], this.ay[i])]++] = i;
    }
  }

  /**
   * Visit every agent whose bucket overlaps the square of radius `r` around
   * (x, y). The callback receives the agent and its true offsets; the caller
   * is responsible for the exact distance check.
   */
  forEachNear(
    x: number, y: number, r: number,
    fn: (j: number, ox: number, oy: number) => void,
  ): void {
    const span = Math.max(1, Math.ceil(r / CELL));
    const cx = Math.min(BX - 1, Math.max(0, (x / CELL) | 0));
    const cy = Math.min(BY - 1, Math.max(0, (y / CELL) | 0));
    const x0 = Math.max(0, cx - span), x1 = Math.min(BX - 1, cx + span);
    const y0 = Math.max(0, cy - span), y1 = Math.min(BY - 1, cy + span);
    for (let by = y0; by <= y1; by++) {
      for (let bx = x0; bx <= x1; bx++) {
        const b = by * BX + bx;
        const end = this.starts[b + 1];
        for (let p = this.starts[b]; p < end; p++) {
          const j = this.items[p];
          fn(j, this.ax[j] - x, this.ay[j] - y);
        }
      }
    }
  }
}
