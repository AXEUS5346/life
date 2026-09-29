import { MAX_AGENTS, N_HORMONES, N_GENES, N_ITEMS, CARRY_CAP, GRID_W, GRID_H } from './constants.ts';
import { RNG } from './rng.ts';
import { randomGenome } from './genome.ts';

/**
 * Structure-of-arrays store. One flat buffer per attribute, indexed by agent
 * slot, so the tick loop stays cache-friendly and never allocates.
 */
export class Agents {
  ax = new Int16Array(MAX_AGENTS);
  ay = new Int16Array(MAX_AGENTS);
  age = new Int32Array(MAX_AGENTS);
  energy = new Float32Array(MAX_AGENTS);
  thirst = new Float32Array(MAX_AGENTS);
  health = new Float32Array(MAX_AGENTS);
  /**
   * What actually killed this pixel, marked at the instant it dies and read
   * once by reap(). Without it, deaths that are already counted the moment
   * they happen (a kill, a newborn that failed its survival roll) get counted
   * a second time when reap() looks at the body and cannot tell what finished
   * it — and since "not old, not thirsty" falls through to starvation, every
   * kill in the world was being reported as a famine.
   */
  deathCause = new Uint8Array(MAX_AGENTS);
  sex = new Uint8Array(MAX_AGENTS);
  alive = new Uint8Array(MAX_AGENTS);

  genes = new Float32Array(MAX_AGENTS * N_GENES);
  horm = new Float32Array(MAX_AGENTS * N_HORMONES);

  mate = new Int32Array(MAX_AGENTS);   // partner slot, -1 = none
  bond = new Float32Array(MAX_AGENTS);  // love strength with `mate`
  nausea = new Float32Array(MAX_AGENTS);
  nauseaT = new Int32Array(MAX_AGENTS);
  desperation = new Float32Array(MAX_AGENTS);
  starveT = new Int32Array(MAX_AGENTS); // consecutive low-energy ticks
  /** Ticks left before this pixel will kill again. Desperation is supposed to
   *  be a last resort, and a last resort available every tick is not one:
   *  without the gap, one starving animal standing in a village of a hundred
   *  can empty it, one neighbour per tick, in a single bad afternoon. */
  killT = new Int32Array(MAX_AGENTS);

  gen = new Int32Array(MAX_AGENTS);
  founder = new Int32Array(MAX_AGENTS); // lineage root, for surnames
  /**
   * Where this pixel's lineage camps, indexed by the founder slot it inherits
   * from — the same identity as `founder`, so a camp outlives everyone who
   * started it. A pixel is pulled back toward it when it needs a mate, a
   * friend, or the shelter of the village while it is still a juvenile.
   */
  campX = new Int32Array(MAX_AGENTS);
  campY = new Int32Array(MAX_AGENTS);
  bornTick = new Int32Array(MAX_AGENTS);

  // --- hands ---------------------------------------------------------------
  /* The same flat addressing as `genes` and `horm` above — one row of N_ITEMS
   * per slot, indexed i * N_ITEMS + kind — because a pixel holds a handful of
   * things at once and three separate MAX_AGENTS-long arrays would make the
   * count a three-argument sum at every call site that wants to know how full
   * these hands are. */
  /** How many of each item kind this pixel holds, indexed by Item.*. */
  carry = new Uint8Array(MAX_AGENTS * N_ITEMS);
  /** Total in hand across all kinds — the capacity check without a sum. */
  carryCount = new Uint8Array(MAX_AGENTS);
  /** Ticks before this pixel will gather again. */
  gatherT = new Int32Array(MAX_AGENTS);
  /** Ticks before this pixel will combine again. */
  combineT = new Int32Array(MAX_AGENTS);
  /** How many separate combines this pixel has performed (sidebar). */
  combines = new Int32Array(MAX_AGENTS);

  /** free slots, used as a stack */
  free: number[] = [];
  count = 0;

  constructor() {
    for (let i = MAX_AGENTS - 1; i >= 0; i--) this.free.push(i);
    this.mate.fill(-1);
  }

  g(i: number, gene: number): number { return this.genes[i * N_GENES + gene]; }
  h(i: number, hormone: number): number { return this.horm[i * N_HORMONES + hormone]; }
  carrying(i: number, kind: number): number { return this.carry[i * N_ITEMS + kind]; }
  carryingTotal(i: number): number { return this.carryCount[i]; }
  /** How much more this pixel can pick up. Negative would mean Sim has let the
   *  hands overflow, which `addCarry` refuses to do; it is deliberately not
   *  clamped to zero here, because a number that can go negative is how an
   *  overflow gets noticed instead of quietly becoming a bigger number. */
  carryRoom(i: number): number { return CARRY_CAP - this.carryCount[i]; }

  /**
   * Put up to `n` of one kind in this pixel's hands and report how much fitted.
   *
   * The return value is the whole point of the method: a gather that finds two
   * rocks into one free hand has to leave the second on the ground, and the
   * caller cannot work that out from a boolean because the rock it failed to
   * pick up is still sitting there in a world that keeps decaying.
   *
   * The counts are whole things. A hand holds a thing or it holds nothing,
   * which is why this is a Uint8Array of counts and not a Float32Array of
   * nutrition — a fraction of a lump exists only at the moment it is eaten.
   */
  addCarry(i: number, kind: number, n: number): number {
    const room = CARRY_CAP - this.carryCount[i];
    if (room <= 0 || n <= 0) return 0;
    const took = n < room ? n : room;
    this.carry[i * N_ITEMS + kind] += took;
    this.carryCount[i] += took;
    return took;
  }

  /** Empty the hands. Clears the total as well as the row, which is the half
   *  that gets forgotten: the row is N_ITEMS long and the total is not, so
   *  zeroing one of them leaves a pixel that has nothing in its hands and a
   *  capacity check that thinks it is full. */
  clearCarry(i: number): void {
    this.carry.fill(0, i * N_ITEMS, (i + 1) * N_ITEMS);
    this.carryCount[i] = 0;
  }

  setH(i: number, hormone: number, v: number): void {
    const idx = i * N_HORMONES + hormone;
    const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
    // move toward the target so hormones drift rather than snap
    const cur = this.horm[idx];
    this.horm[idx] = cur + (clamped - cur) * 0.25;
  }

  alloc(rng: RNG, x: number, y: number): number {
    const i = this.free.pop();
    if (i === undefined) return -1;
    this.alive[i] = 1;
    this.count++;
    this.ax[i] = x; this.ay[i] = y;
    this.age[i] = 0;
    this.energy[i] = 0.85;
    this.thirst[i] = 0.25;
    this.health[i] = 1;
    this.deathCause[i] = 0;
    this.sex[i] = rng.chance(0.5) ? 0 : 1;
    this.horm.fill(0, i * N_HORMONES, (i + 1) * N_HORMONES);
    this.mate[i] = -1;
    this.bond[i] = 0;
    this.nausea[i] = 0;
    this.nauseaT[i] = 0;
    this.desperation[i] = 0;
    this.starveT[i] = 0;
    this.killT[i] = 0;
    // newborn holds nothing and has never combined anything; release() has
    // already cleared these, and this is the same belt as that braces
    this.clearCarry(i);
    this.gatherT[i] = 0;
    this.combineT[i] = 0;
    this.combines[i] = 0;
    randomGenome(rng, this.genes.subarray(i * N_GENES, (i + 1) * N_GENES));
    this.gen[i] = 0;
    this.founder[i] = i;
    // a fresh lineage camps where it is born until someone says otherwise;
    // Sim overrides this for the founders and the children copy it down
    this.campX[i] = x; this.campY[i] = y;
    return i;
  }

  release(i: number): void {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.count--;
    if (this.mate[i] >= 0 && this.alive[this.mate[i]]) {
      // orphan the partner rather than leaving a dangling reference
      const m = this.mate[i];
      this.mate[m] = -1;
      this.bond[m] = 0;
      this.setH(m, 4 /* LOVE */, 0);
    }
    this.mate[i] = -1;
    this.deathCause[i] = 0;
    // Everything that belongs to the animal rather than to the slot. The free
    // list hands this slot to the next newborn, and a slot that keeps the dead
    // one's rock gives the newborn a rock it never picked up, a sidebar that
    // reports combines nobody performed, and a gather cooldown that has already
    // partly expired. None of those fail loudly; they just make the new animal
    // behave like the old one.
    this.clearCarry(i);
    this.gatherT[i] = 0;
    this.combineT[i] = 0;
    this.combines[i] = 0;
    this.free.push(i);
  }

  /** A free walkable tile, or the tile itself if the map is jammed. */
  randomSpot(rng: RNG, x: number, y: number, passable: (x: number, y: number) => boolean): number[] {
    for (let k = 0; k < 64; k++) {
      const nx = rng.int(GRID_W);
      const ny = rng.int(GRID_H);
      if (passable(nx, ny)) return [nx, ny];
    }
    return [x, y];
  }

  /**
   * A passable tile within `r` cells of (cx, cy), or null.
   *
   * This exists because the only other way to find a tile was uniform over
   * the whole 286k-cell map, which is a fair answer to "somewhere" and a
   * disastrous one to "somewhere near here". A newborn has parents, a camp
   * and a cohort; being born two hundred cells away is not a hard start, it
   * is being born in a different world. Walks the ring outwards, then
   * rejection-samples inside it, and gives up rather than searching — the
   * caller always has a fallback.
   */
  nearSpot(
    rng: RNG, cx: number, cy: number, r: number,
    passable: (x: number, y: number) => boolean,
  ): number[] | null {
    // Sample first, so a lineage spreads across its own camp instead of
    // stacking every child on the one tile the search happens to reach
    // first. Two pixels sharing a tile are at distance zero, which every
    // sensor and every partner search discards as "not there".
    for (let k = 0; k < 48; k++) {
      const nx = cx + rng.int(2 * r + 3) - (r + 1);
      const ny = cy + rng.int(2 * r + 3) - (r + 1);
      if (Math.abs(nx - cx) > r + 1 || Math.abs(ny - cy) > r + 1) continue;
      if (passable(nx, ny)) return [nx, ny];
    }
    // …then walk the rings outwards, which cannot fail while the centre is
    // somewhere walkable, so a camp with an unusable tile under it still has
    // children.
    for (let ring = 0; ring <= r + 1; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          if (passable(cx + dx, cy + dy)) return [cx + dx, cy + dy];
        }
      }
    }
    return null;
  }
}
