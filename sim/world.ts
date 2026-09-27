import {
  GRID_W, GRID_H, GRID_SIZE,
  T_OPEN, T_ROCK, T_WATER, T_DEAD, T_SAND, T_FOREST, T_MARSH, T_SNOW, T_CAVE,
  SEASON_TICKS, SEASON_NAMES, SEASON_REGROW,
  FOOD_RESERVE,
  N_MOVE, MOVE_DX, MOVE_DY,
  N_CAVES, MEAT_ROT_RATE,
  TERRAIN_PASSABLE, DAY_TICKS, PHASE_DAWN, PHASE_DUSK, PHASE_NIGHT, PHASE_NAMES,
  FOOD_CELL, FOOD_BUCKETS, FOOD_BUCKETS_X, FOOD_BUCKETS_Y, FOOD_FIELD_EVERY,
  FOOD_UNDERFOOT,
  CAMP_HOME_R,
} from './constants.ts';
import { RNG } from './rng.ts';

/**
 * The value below which `q` of the field lies. Used to cut the world into
 * bands of a chosen size rather than against a magic constant, so the map
 * comes out the same shape on every seed.
 */
function quantile(field: Float32Array, q: number): number {
  // sample rather than sort: GRID_SIZE is ~200k and we only need a cut point
  const N = 8192;
  const samp = new Float32Array(N);
  const stride = Math.max(1, Math.floor(field.length / N));
  let n = 0;
  for (let i = 0; i < field.length && n < N; i += stride) samp[n++] = field[i];
  const s = samp.subarray(0, n);
  const arr = Array.from(s);
  arr.sort((a, b) => a - b);
  return arr[Math.min(arr.length - 1, Math.max(0, Math.round(q * (arr.length - 1))))];
}

/** The 4-neighbour offsets, in the order E, W, S, N. */
const D4X = [1, -1, 0, 0];
const D4Y = [0, 0, 1, -1];
const WATER_DRAIN = 2.5;
const MARSH_DRAIN = 1.45;

/** The index into MOVE_DX/MOVE_DY for a signed heading. The 3x3 grid is
 *  row-major from up-left, so it is just the heading mapped into 0..2. */
export function moveIndexOf(dx: number, dy: number): number {
  return (dy + 1) * 3 + (dx + 1);
}

/** Seeded 2D value noise, bilinearly interpolated, `oct` fractal octaves. */
function makeNoise(rng: RNG) {
  const P = new Uint8Array(512);
  const perm = new Uint8Array(256);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  for (let i = 0; i < 512; i++) P[i] = perm[i & 255];

  const grad = (h: number, x: number, y: number): number => {
    switch (h & 3) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      default: return -x - y;
    }
  };
  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

  return (x: number, y: number, oct: number, freq: number): number => {
    let amp = 1, sum = 0, norm = 0, f = freq;
    for (let o = 0; o < oct; o++) {
      const X = Math.floor(x * f) & 255;
      const Y = Math.floor(y * f) & 255;
      const fx = x * f - Math.floor(x * f);
      const fy = y * f - Math.floor(y * f);
      const u = fade(fx), v = fade(fy);
      const aa = P[P[X] + Y], ab = P[P[X] + Y + 1];
      const ba = P[P[X + 1] + Y], bb = P[P[X + 1] + Y + 1];
      const x1 = grad(aa, fx, fy) + u * (grad(ba, fx - 1, fy) - grad(aa, fx, fy));
      const x2 = grad(ab, fx, fy - 1) + u * (grad(bb, fx - 1, fy - 1) - grad(ab, fx, fy - 1));
      sum += amp * (x1 + v * (x2 - x1));
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  };
}

export type DeathCause = 'starvation' | 'dehydration' | 'age' | 'crowding' | 'killed';

export class World {
  terrain = new Uint8Array(GRID_SIZE);
  plant = new Float32Array(GRID_SIZE);      // 0..1, regrows
  plantTimer = new Float32Array(GRID_SIZE); // ticks since last grazed
  carcass = new Float32Array(GRID_SIZE);    // 0..1, rots away
  carcassAge = new Float32Array(GRID_SIZE);
  /** A pixel killed by a predator. Worth more than anything that grows, and
 *  the only thing that gives dopamine. Rots like everything else. */
  meat = new Float32Array(GRID_SIZE);
  meatAge = new Float32Array(GRID_SIZE);
  /** Running total of meat in the world, so decay can skip the whole map
   *  when there is none — which is most of the time. */
  meatTotal = 0;
  /** Only fertile ground grows food. This is what makes a vast world scarce. */
  fertile = new Uint8Array(GRID_SIZE);
  private fertileList = new Int32Array(GRID_SIZE);
  private fertileCount = 0;

  /** Walking distance to the nearest water, -1 where none is reachable.
   *  Built once by BFS. Thirst needs a gradient to follow: telling a pixel
   *  that it is thirsty is useless if it cannot tell which way the river is. */
  waterDist = new Int32Array(GRID_SIZE);

  /** Predator dens: the centres of the world's caves, and how far away each
 *  cave is from every cell. Predators are born in a cave and go back to one
 *  when they are done hunting, so caves have to be somewhere to walk to. */
  caveX: number[] = [];
  caveY: number[] = [];
  caveDist = new Int32Array(GRID_SIZE);

  /**
   * Coarse food field: total grass in each FOOD_CELL square.
   *
   * The same trick as `waterDist`, at a resolution food can afford to be
   * sampled at. A pixel's own eyes reach twenty cells, and on a map this size
   * a pixel will spend most of its life standing somewhere with nothing in
   * view and no idea which way to go — which is the whole reason six founders
   * used to starve out on ground that had a third of a hundred thousand
   * nutrition units of grass on it. Squares of eight cells are wider than a
   * pixel's vision and strictly better informed than it is, so a hungry pixel
   * always has somewhere to walk even when it can see nothing.
   */
  foodField = new Float32Array(FOOD_BUCKETS);

  /** Scratch elevation/moisture fields, kept so the biome pass and the
   *  scenery pass can look at the same numbers the classifier saw. */
  private heightField = new Float32Array(GRID_SIZE);
  private moistField = new Float32Array(GRID_SIZE);
  /** Scenery per cell: 0 none, 1 tree, 2 big tree, 3 boulder, 4 reeds. */
  prop = new Uint8Array(GRID_SIZE);

  tick = 0;
  season = 0;
  seasonTicks = 0;

  seed: number;

  constructor(seed: number) {
    this.seed = seed;
    this.generate(new RNG(seed));
  }

  idx(x: number, y: number): number { return y * GRID_W + x; }
  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
  }

  /**
   * Build the map.
   *
   * Two noise fields decide everything: how high the ground is, and how wet
   * it is. Height carves mountains and basins, moisture decides whether a
   * basin floods and whether a slope grows forest or goes to badlands, and
   * the two together give a map with actual regions on it — a river with a
   * shore, woods with a clearing in them, a range of peaks with snow on the
   * tops — instead of one noise threshold smeared over a single flat
   * colour. Everything a pixel does afterwards is legible in the terrain it
   * is standing on.
   */
  private generate(rng: RNG): void {
    const elev = makeNoise(rng);
    const moist = makeNoise(rng);
    const cx = GRID_W / 2, cy = GRID_H / 2;
    const maxR = Math.hypot(cx, cy);

    // Pass 1: height and moisture, with a rim that pushes rock outward so the
    // middle of the map is the habitable part and the edge is the wall.
    const h = this.heightField;
    const m = this.moistField;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const i = this.idx(x, y);
        const r = Math.hypot(x - cx, y - cy) / maxR;
        const rim = Math.max(0, r - 0.55) * 1.9; // flat centre, walls at the rim
        // domain warp, so coastlines are ragged instead of noise-blobs
        const wx = x + elev(x * 0.5 + 11, y * 0.5, 2, 0.03) * 20;
        const wy = y + moist(x * 0.5 + 5, y * 0.5 + 9, 2, 0.03) * 20;
        h[i] = elev(wx, wy, 5, 0.011) - rim;
        m[i] = moist(wx + 4000, wy + 2700, 4, 0.014);
      }
    }

    // Pass 2: cut the world into bands of a chosen size instead of guessing a
    // threshold against the noise. `quantile(f, q)` is the value that q of the
    // field lies below, so `e < quantile(h, 0.20)` is the lowest fifth of the
    // map. A hand-tuned constant produced a world that was 33% ocean on one
    // seed and had no mountains at all, which is worse than having no world;
    // quantiles make the map's proportions a property of the design instead of
    // a property of the noise implementation.
    const seaLevel = quantile(h, 0.20);   // ~13% floods once moisture is applied
    const dampLine = quantile(h, 0.28);   // the belt just above the waterline
    const snowLine = quantile(h, 0.89);   // top 11% is mountain...
    const peakLine = quantile(h, 0.97);   // ...top 3% is snow-capped peak
    const wetLine = quantile(m, 0.72);    // ~19% becomes forest
    const dryLine = quantile(m, 0.12);    // ~11% becomes badlands
    const washLine = quantile(m, 0.35);   // the wet half of the low ground

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const i = this.idx(x, y);
        const e = h[i], w = m[i];
        if (e > peakLine) { this.terrain[i] = T_SNOW; continue; }
        if (e > snowLine) { this.terrain[i] = T_ROCK; continue; }
        if (e < seaLevel) {
          // low ground: it floods if it is wet enough, and otherwise sits
          // there as a marsh
          this.terrain[i] = w > washLine ? T_WATER : T_MARSH;
          continue;
        }
        if (w > wetLine) { this.terrain[i] = T_FOREST; continue; }
        if (w < dryLine) { this.terrain[i] = T_DEAD; continue; }
        if (e < dampLine && w < washLine + 0.18) { this.terrain[i] = T_MARSH; continue; }
        this.terrain[i] = T_OPEN;
      }
    }

    // Pass 3: shore. Any land touching water is a bank, which is what makes a
    // river read as a river instead of a blue stripe with hard edges.
    for (let y = 1; y < GRID_H - 1; y++) {
      for (let x = 1; x < GRID_W - 1; x++) {
        const i = this.idx(x, y);
        const t = this.terrain[i];
        if (t !== T_OPEN && t !== T_MARSH && t !== T_DEAD) continue;
        let nearWater = false;
        for (let dy = -2; dy <= 2 && !nearWater; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (this.terrain[this.idx(x + dx, y + dy)] === T_WATER) { nearWater = true; break; }
          }
        }
        if (nearWater) this.terrain[i] = T_SAND;
      }
    }

    this.buildFertility();
    this.buildProps(rng);
    this.sowReserve(rng, FOOD_RESERVE);
    this.buildWaterField();
    this.findCaves();
    this.rebuildFoodField();
  }

  /**
   * Fertile ground: a third noise channel, gated on the biome. Forest and
   * wet lowland grow; mountain, snow, shore and badlands never do.
   */
  private buildFertility(): void {
    const fert = makeNoise(new RNG(this.seed ^ 0x51ab3d));
    const cx = GRID_W / 2, cy = GRID_H / 2;
    const maxR = Math.hypot(cx, cy);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const i = this.idx(x, y);
        const t = this.terrain[i];
        if (t !== T_OPEN && t !== T_FOREST && t !== T_MARSH) continue;
        const r = Math.hypot(x - cx, y - cy) / maxR;
        // forest is the rich ground; the rim is not
        const bias = t === T_FOREST ? 0.12 : t === T_MARSH ? 0.03 : 0;
        if (fert(x + 2100, y + 1500, 3, 0.045) + bias + (0.30 - r * 0.30) > 0.34) {
          this.fertile[i] = 1;
          this.fertileList[this.fertileCount++] = i;
        }
      }
    }
  }

  /**
   * Scenery. A tree, a boulder or a reed on the cell it belongs to, so the
   * renderer has something to draw a silhouette from and the map is not a
   * field of flat colour. Stored as one byte per cell: 0 none, 1 tree,
   * 2 big tree, 3 boulder, 4 reeds.
   *
   * Densities are deliberately sparse. Every prop is a handful of painted
   * sub-pixels, so thirty thousand of them is most of a frame's budget, and
   * a solid canopy reads as one green mass rather than as woodland. Gaps
   * between the trees are what make it look like a forest.
   */
  private buildProps(rng: RNG): void {
    for (let y = 1; y < GRID_H - 1; y++) {
      for (let x = 1; x < GRID_W - 1; x++) {
        const i = this.idx(x, y);
        const t = this.terrain[i];
        if (t === T_WATER) {
          // reeds hug the bank, never the middle of the river
          let bank = false;
          for (let dy = -1; dy <= 1 && !bank; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (this.terrain[this.idx(x + dx, y + dy)] === T_SAND) { bank = true; break; }
            }
          }
          if (bank && rng.chance(0.12)) this.prop[i] = 4;
          continue;
        }
        if (t === T_FOREST) {
          if (rng.chance(0.24)) this.prop[i] = rng.chance(0.22) ? 2 : 1;
        } else if (t === T_OPEN && this.fertile[i]) {
          if (rng.chance(0.06)) this.prop[i] = 1;
        } else if (t === T_MARSH) {
          if (rng.chance(0.10)) this.prop[i] = 4;
        } else if (t === T_SNOW) {
          if (rng.chance(0.035)) this.prop[i] = 3;
        } else if (t === T_DEAD) {
          if (rng.chance(0.05)) this.prop[i] = 3;
        }
      }
    }
  }

  /**
   * Which part of the day it is, 0 = dawn .. 3 = night.
   */
  get phase(): number {
    const t = (this.tick % DAY_TICKS) / DAY_TICKS;
    if (t < PHASE_DAWN + 0.12) return 0;
    if (t < PHASE_DUSK) return 1;
    if (t < PHASE_NIGHT) return 2;
    return 3;
  }

  get phaseName(): string { return PHASE_NAMES[this.phase]; }

  /** 0 at midnight, 1 at noon. The world's colour grade and the light a
   *  predator hunts by both read this. */
  get daylight(): number {
    const t = (this.tick % DAY_TICKS) / DAY_TICKS;
    // piecewise: dawn ramp, day plateau, dusk fall, night floor
    if (t < 0.12) return 0.30 + (t / 0.12) * 0.70;
    if (t < 0.50) return 1.0;
    if (t < 0.62) return 1.0 - ((t - 0.50) / 0.12) * 0.94;
    return 0.06;
  }

  /** Ticks into the current day, 0..DAY_TICKS. */
  get timeOfDay(): number { return this.tick % DAY_TICKS; }

  /** Is it dark enough to hunt? */
  get isNight(): boolean {
    const t = (this.tick % DAY_TICKS) / DAY_TICKS;
    return t >= PHASE_NIGHT || t < 0.06;
  }

  /**
   * Carve the world's dens.
   *
   * A den is a real place, not a coordinate: a mouth cut into a mountainside
   * with a chamber behind it, marked as T_CAVE on the map so it is visible
   * before a predator has ever been seen near it. The generator picks sites
   * where rock meets walkable ground, opens a mouth on the walkable side,
   * and hollows a chamber behind it into the rock.
   *
   * Predators are born at a den and walk back to it when they are not
   * hunting, so the site has to be reachable: every chamber is checked
   * against the cave distance field afterwards and carved sites that the
   * world cannot walk to are discarded.
   */
  private findCaves(): void {
    const cx0 = GRID_W / 2, cy0 = GRID_H / 2;
    const maxR0 = Math.hypot(cx0, cy0);
    const cand: { x: number; y: number; score: number }[] = [];
    // Look for a walkable cell with a wall of rock on exactly one side —
    // that is a mountainside, which is the only place a den makes sense.
    for (let y = 3; y < GRID_H - 3; y++) {
      for (let x = 3; x < GRID_W - 3; x++) {
        const i = this.idx(x, y);
        if (!TERRAIN_PASSABLE[this.terrain[i]]) continue;
        if (this.terrain[i] === T_WATER) continue;
        // score by how much rock is around: a mouth wants one side solid
        let rock = 0, open = 0;
        for (let k = 0; k < 4; k++) {
          const nx = x + D4X[k], ny = y + D4Y[k];
          if (!this.inBounds(nx, ny)) continue;
          if (this.terrain[this.idx(nx, ny)] === T_ROCK) rock++; else open++;
        }
        if (rock >= 1 && open >= 3) {
          // a den on the very edge of the map is unreachable scenery; weight
          // the interior up so the six dens land somewhere the world walks
          const r = Math.hypot(x - cx0, y - cy0) / maxR0;
          const edge = Math.max(0, r - 0.78) * 70;
          cand.push({ x, y, score: rock * 10 + open - edge });
        }
      }
    }
    // Spread the dens across the whole map. A plain "best score wins" pass
    // puts every den on the most mountainous rim — one corner of the world,
    // six times — which is a place, not a habitat. So the map is cut into a
    // coarse lattice and each region contributes its single best site: six
    // dens in six different places, each on a real wall.
    const COLS = 3, ROWS = 2;
    const cw = GRID_W / COLS, chh = GRID_H / ROWS;
    const best = new Map<string, { x: number; y: number; score: number }>();
    for (const c of cand) {
      const key = `${Math.min(COLS - 1, (c.x / cw) | 0)}:${Math.min(ROWS - 1, (c.y / chh) | 0)}`;
      const cur = best.get(key);
      if (!cur || c.score > cur.score) best.set(key, c);
    }
    for (const [, c] of best) {
      if (this.caveX.length >= N_CAVES) break;
      this.caveX.push(c.x);
      this.caveY.push(c.y);
      this.carveDen(c.x, c.y);
    }
    // A world with too few mountains may not have produced N_CAVES sites;
    // fall back to spreading the remaining dens over open ground so a
    // predator always has somewhere to be.
    if (this.caveX.length === 0) {
      for (let k = 0; k < N_CAVES; k++) {
        const x = Math.floor((k + 0.5) / N_CAVES * GRID_W);
        const y = Math.floor(GRID_H / 2 + ((k % 2) ? 1 : -1) * GRID_H * 0.22);
        this.caveX.push(Math.max(1, Math.min(GRID_W - 2, x)));
        this.caveY.push(Math.max(1, Math.min(GRID_H - 2, y)));
        this.carveDen(this.caveX[k], this.caveY[k]);
      }
    }
    this.buildCaveField();
  }

  /** Open a mouth and hollow a chamber behind it, and mark it on the map. */
  private carveDen(x: number, y: number): void {
    // the chamber sits two cells back, so push the wall outward from open
    // ground rather than digging into the middle of a plain
    let bx = x, by = y;
    for (let k = 0; k < 4; k++) {
      const nx = x + D4X[k], ny = y + D4Y[k];
      if (this.inBounds(nx, ny) && this.terrain[this.idx(nx, ny)] === T_ROCK) { bx = nx; by = ny; break; }
    }
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = bx + dx, ny = by + dy;
        if (!this.inBounds(nx, ny)) continue;
        if (Math.abs(dx) + Math.abs(dy) > 3) continue;
        const j = this.idx(nx, ny);
        if (this.terrain[j] === T_ROCK) {
          this.terrain[j] = T_CAVE;
          this.fertile[j] = 0;
        }
      }
    }
    // the mouth itself: a passable cave cell at the original site
    const mi = this.idx(x, y);
    this.terrain[mi] = T_CAVE;
    this.fertile[mi] = 0;
  }

  /** Walking distance to the nearest cave, -1 where none is reachable. */
  private buildCaveField(): void {
    this.caveDist.fill(-1);
    if (this.caveX.length === 0) return;
    const q = new Int32Array(GRID_SIZE);
    let head = 0, tail = 0;
    for (let k = 0; k < this.caveX.length; k++) {
      const i = this.idx(this.caveX[k], this.caveY[k]);
      if (this.caveDist[i] !== -1) continue;
      this.caveDist[i] = 0;
      q[tail++] = i;
    }
    while (head < tail) {
      const i = q[head++];
      const x = i % GRID_W, y = (i / GRID_W) | 0;
      const d = this.caveDist[i] + 1;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const j = this.idx(nx, ny);
        if (this.caveDist[j] !== -1) continue;
        if (this.terrain[j] === T_ROCK) continue;
        this.caveDist[j] = d;
        q[tail++] = j;
      }
    }
  }

  /**
   * Somewhere worth starting a lineage.
   *
   * The old world dropped its founders on a uniformly random walkable tile,
   * which on a 200k-cell map is very often a bare rock shelf a long way from
   * anything — a founding cast that starts with no food in reach and no water
   * in sight is not a hard start, it is a slow extinction, and it is what made
   * the whole thing look broken rather than hard. So this scores the map and
   * returns somewhere with food underfoot, water within reach and open ground
   * to run on.
   */
  findHabitable(rng: RNG): [number, number] {
    let bestX = -1, bestY = -1, bestScore = -Infinity;
    for (let t = 0; t < 4000; t++) {
      const x = rng.int(GRID_W), y = rng.int(GRID_H);
      const i = this.idx(x, y);
      const ter = this.terrain[i];
      if (ter === T_ROCK || ter === T_WATER || ter === T_SNOW
          || ter === T_MARSH || ter === T_SAND || ter === T_CAVE) continue;

      // food underfoot and in the immediate neighbourhood
      let food = 0;
      for (let dy = -8; dy <= 8; dy += 2) {
        for (let dx = -8; dx <= 8; dx += 2) {
          const nx = x + dx, ny = y + dy;
          if (!this.inBounds(nx, ny)) continue;
          food += this.plant[this.idx(nx, ny)];
        }
      }
      if (food < 1) continue;

      // water has to be walkable-to: a river across a chasm is no water at all
      const wd = this.waterDist[i];
      if (wd < 0 || wd > 70) continue;

      // open ground around, so six of them are not born inside a thicket
      let open = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx, ny = y + dy;
          if (!this.inBounds(nx, ny)) continue;
          const nt = this.terrain[this.idx(nx, ny)];
          if (nt === T_OPEN || nt === T_DEAD) open++;
        }
      }
      if (open < 40) continue;

      // prefer rich ground, close water, and somewhere not right on the rim
      const r = Math.hypot(x - GRID_W / 2, y - GRID_H / 2) / (Math.hypot(GRID_W, GRID_H) / 2);
      const score = food * 1.0 - wd * 0.35 + open * 0.12 - r * 12;
      if (score > bestScore) { bestScore = score; bestX = x; bestY = y; }
    }
    if (bestX >= 0) return [bestX, bestY];
    // no acceptable site on this seed: fall back to any walkable land
    for (let t = 0; t < 4000; t++) {
      const x = rng.int(GRID_W), y = rng.int(GRID_H);
      if (this.passable(x, y) && this.terrain[this.idx(x, y)] !== T_WATER) return [x, y];
    }
    return [GRID_W >> 1, GRID_H >> 1];
  }

  /** Index of the nearest cave to a cell, or -1 if this world has none. */
  nearestCave(x: number, y: number): number {
    if (this.caveX.length === 0 || !this.inBounds(x, y)) return -1;
    let best = -1, bestD = Infinity;
    for (let k = 0; k < this.caveX.length; k++) {
      const d = Math.abs(this.caveX[k] - x) + Math.abs(this.caveY[k] - y);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  /**
   * The movement step that heads toward the nearest den, as an index into
   * MOVE_DX/MOVE_DY, or -1 if it is already there.
   *
   * This exists because the alternative was worse. A predator walking home
   * by `sign(caveX - px)` walks into the mountainside, hits rock, and then
   * either reverses or turns at random — and a den is *carved into* a
   * mountainside, so that walk is into the one wall it has to get around.
   * Measured over a whole run, four predators sat at a constant 90 cells
   * from their dens, never moved, never hunted and never starved: jammed in
   * the first minute and inert for the rest of the world. Walking the field
   * that was already built to find the dens is the same cost as the greedy
   * step and it gets there.
   */
  caveStep(x: number, y: number, den: number): number {
    if (den < 0 || den >= this.caveX.length) return -1;
    const cx = this.caveX[den], cy = this.caveY[den];
    if (Math.abs(cx - x) <= 1 && Math.abs(cy - y) <= 1) return -1;
    const here = this.caveDist[this.idx(x, y)];
    let bestStep = -1, best = here;
    for (let k = 0; k < N_MOVE; k++) {
      if (k === 4) continue; // standing still never gets you closer
      const nx = x + MOVE_DX[k], ny = y + MOVE_DY[k];
      if (!this.inBounds(nx, ny)) continue;
      const d = this.caveDist[this.idx(nx, ny)];
      if (d >= 0 && d < best) { best = d; bestStep = k; }
    }
    return bestStep;
  }

  /** The food standing on one cell, in the same units `Sim.eat` spends: grass
   *  at face value, carcass at the fraction that is actually digestible. */
  foodAt(i: number): number {
    return this.plant[i] + this.carcass[i] * 0.6;
  }

  /**
   * The movement step that heads for food, or -1 to stay put and eat here.
   *
   * Two scales, because one was quietly starving the population. Comparing
   * coarse bucket sums answers "is the next square richer", and a pixel
   * standing on a bare rock cell inside a grassy square scored that square's
   * grass as its own — so it was told to stay put on bare rock with a full
   * meal one cell over. The first pass is therefore exact, over the same
   * cells `eat` can reach, and the coarse field is the fallback for ground
   * this pixel cannot see.
   *
   * Staying put stays a real answer: food within reach means -1, and so does
   * a square with nothing in any direction at all, which is a fact about the
   * world rather than something a heading could fix.
   */
  foodStep(x: number, y: number): number {
    if (!this.inBounds(x, y)) return -1;
    if (this.foodAt(this.idx(x, y)) > FOOD_UNDERFOOT) return -1;

    // pass one: something to eat within a single step
    let nearStep = -1, nearBest = FOOD_UNDERFOOT;
    for (let k = 0; k < N_MOVE; k++) {
      if (k === 4) continue;
      const nx = x + MOVE_DX[k], ny = y + MOVE_DY[k];
      if (!this.inBounds(nx, ny)) continue;
      const f = this.foodAt(this.idx(nx, ny));
      if (f > nearBest) { nearBest = f; nearStep = k; }
    }
    if (nearStep >= 0) return nearStep;

    // pass two: nothing within reach, so head for the richest coarse square.
    // No margin here on purpose. A margin is the right test for choosing
    // between two directions, but the wrong test for choosing between
    // walking and starving: a pixel on bare rock in the middle of a square
    // full of grass has nothing to lose by stepping toward it, and the
    // margin used to be exactly what kept it on the bare rock.
    const bx = (x / FOOD_CELL) | 0, by = (y / FOOD_CELL) | 0;
    let bestStep = -1, bestBucket = this.foodField[by * FOOD_BUCKETS_X + bx];
    for (let k = 0; k < N_MOVE; k++) {
      if (k === 4) continue;
      const nx = x + MOVE_DX[k], ny = y + MOVE_DY[k];
      if (!this.inBounds(nx, ny)) continue;
      const nbx = Math.min(FOOD_BUCKETS_X - 1, (nx / FOOD_CELL) | 0);
      const nby = Math.min(FOOD_BUCKETS_Y - 1, (ny / FOOD_CELL) | 0);
      const f = this.foodField[nby * FOOD_BUCKETS_X + nbx];
      if (f > bestBucket) { bestBucket = f; bestStep = k; }
    }
    return bestBucket > 0 ? bestStep : -1;
  }

  /**
   * The movement step that heads toward a pixel camp, or -1 when this pixel
   * is already home.
   *
   * A camp is a few cells across and sits on ground the founders picked for
   * being walkable, so there is nothing here to path around: a straight
   * heading plus the caller's obstacle-sliding step is the whole of it.
   */
  campStep(x: number, y: number, cx: number, cy: number): number {
    const dx = cx - x, dy = cy - y;
    if (Math.abs(dx) <= CAMP_HOME_R && Math.abs(dy) <= CAMP_HOME_R) return -1;
    return moveIndexOf(Math.sign(dx), Math.sign(dy));
  }

  /**
   * Rebuild the coarse food field. One linear pass over the map, folding
   * grass and carcass into their square. Run on a timer rather than every
   * tick: grass this dense does not meaningfully change in twenty ticks, and
   * a second full pass per tick is real money in a loop that already spends
   * one.
   */
  rebuildFoodField(): void {
    this.foodField.fill(0);
    const f = this.foodField;
    for (let y = 0; y < GRID_H; y++) {
      const row = ((y / FOOD_CELL) | 0) * FOOD_BUCKETS_X;
      for (let x = 0; x < GRID_W; x++) {
        const i = y * GRID_W + x;
        const p = this.plant[i];
        if (p > 0.02) f[row + ((x / FOOD_CELL) | 0)] += p;
        const c = this.carcass[i];
        if (c > 0.02) f[row + ((x / FOOD_CELL) | 0)] += c * 0.6;
      }
    }
  }

  private buildWaterField(): void {
    this.waterDist.fill(-1);
    const q = new Int32Array(GRID_SIZE);
    let head = 0, tail = 0;
    for (let i = 0; i < GRID_SIZE; i++) {
      if (this.terrain[i] === T_WATER) { this.waterDist[i] = 0; q[tail++] = i; }
    }
    while (head < tail) {
      const i = q[head++];
      const x = i % GRID_W, y = (i / GRID_W) | 0;
      const d = this.waterDist[i] + 1;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const j = this.idx(nx, ny);
        if (this.waterDist[j] !== -1) continue;
        if (this.terrain[j] === T_ROCK) continue;
        this.waterDist[j] = d;
        q[tail++] = j;
      }
    }
  }

  /** The 3x3 movement step that heads most directly toward water, as an index
   *  into MOVE_DX/MOVE_DY, or -1 if there is nothing to walk toward. Cheap
   *  enough to run for every thirsty pixel every tick. */
  waterStep(x: number, y: number): number {
    if (!this.inBounds(x, y)) return -1;
    const here = this.waterDist[this.idx(x, y)];
    if (here <= 0) return -1; // standing in it already, or no water reachable
    let bestStep = -1, best = here;
    for (let k = 0; k < N_MOVE; k++) {
      if (k === 4) continue; // standing still never gets you closer
      const nx = x + MOVE_DX[k], ny = y + MOVE_DY[k];
      if (!this.inBounds(nx, ny)) continue;
      const d = this.waterDist[this.idx(nx, ny)];
      if (d >= 0 && d < best) { best = d; bestStep = k; }
    }
    return bestStep;
  }

  /**
   * Lay down an opening food stock so a handful of founders can actually feed.
   *
   * Rejection-samples walkable tiles and drops food on them until the world
   * holds `amount` nutrition. Crucially these tiles are NOT marked fertile,
   * so the stock never regrows: it is a finite cushion that gets eaten, and
   * once it is gone the map is back to its own fertility. Every founder is
   * spawned by `randomSpot` anywhere on the map, so the reserve has to be
   * global to be worth anything to them.
   */
  private sowReserve(rng: RNG, amount: number): void {
    // the normal planting pass may already have put food down; only top up
    let planted = this.totalFood();
    if (planted >= amount) return;
    // candidates are walkable tiles; acceptance is well above half, so the
    // guard is a liveness backstop rather than a real limit
    const guard = amount * 8 + 1024;
    for (let tries = 0; planted < amount && tries < guard; tries++) {
      const x = rng.int(GRID_W);
      const y = rng.int(GRID_H);
      const i = this.idx(x, y);
      const t = this.terrain[i];
      // plain only. Badlands are barren by design — nothing there has ever
      // grown and nothing ever will — and seeding them made the opening stock
      // paint a fifth of the map in the same green as the plain, so two
      // different biomes rendered as one colour.
      if (t !== T_OPEN) continue;
      if (this.plant[i] > 0.95) continue;
      const put = Math.min(rng.range(0.5, 1), amount - planted);
      // a tile that was already at 0.9 only absorbs 0.1, so credit the
      // reserve with what actually landed, not with what we tried to drop
      const before = this.plant[i];
      this.plant[i] = Math.min(1, before + put);
      planted += this.plant[i] - before;
    }
  }

  get seasonName(): string { return SEASON_NAMES[this.season]; }
  get regrowRate(): number { return SEASON_REGROW[this.season]; }

  /** Advance plants, carcasses and the season. */
  step(): void {
    this.tick++;
    this.seasonTicks++;
    if (this.seasonTicks >= SEASON_TICKS) {
      this.seasonTicks = 0;
      this.season = (this.season + 1) % 4;
    }
    if (this.tick % FOOD_FIELD_EVERY === 0) this.rebuildFoodField();

    const rate = this.regrowRate * 0.0022;
    for (let k = 0; k < this.fertileCount; k++) {
      const i = this.fertileList[k];
      if (this.plant[i] < 1) {
        this.plantTimer[i] += 1;
        // regrow faster the longer it has rested, then clamp
        const rest = Math.min(1, this.plantTimer[i] / 120);
        this.plant[i] = Math.min(1, this.plant[i] + rate * rest);
      } else {
        this.plantTimer[i] = 0;
      }
      if (this.carcass[i] > 0) {
        this.carcassAge[i] += 1;
        this.carcass[i] = Math.max(0, this.carcass[i] - 0.0035);
      }
    }
    // meat does not grow, so it is only walked while some exists
    if (this.meatTotal > 0) {
      for (let i = 0; i < GRID_SIZE; i++) {
        if (this.meat[i] <= 0) continue;
        this.meatAge[i] += 1;
        this.meat[i] = Math.max(0, this.meat[i] - MEAT_ROT_RATE);
        this.meatTotal = Math.max(0, this.meatTotal - MEAT_ROT_RATE);
      }
    }
  }

  /** Drop meat where something was killed. */
  addMeat(i: number, amount: number): void {
    const before = this.meat[i];
    this.meat[i] = Math.min(1.5, before + amount);
    this.meatTotal += this.meat[i] - before;
    if (before === 0) this.meatAge[i] = 0;
  }

  /** Take up to `want` of meat off a tile. Meat fills you completely, so the
   *  caller tops itself up rather than adding a fraction. */
  takeMeat(i: number, want: number): number {
    if (this.meat[i] <= 0) return 0;
    const got = Math.min(this.meat[i], want);
    this.meat[i] -= got;
    this.meatTotal = Math.max(0, this.meatTotal - got);
    return got;
  }

  /** Total edible energy in the world — the harness uses this to spot famine. */
  totalFood(): number {
    let s = 0;
    for (let i = 0; i < GRID_SIZE; i++) s += this.plant[i];
    return s;
  }

  passable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return TERRAIN_PASSABLE[this.terrain[this.idx(x, y)]];
  }

  /** Energy multiplier for standing on a cell: water and marsh both cost you,
   *  marsh only a little. */
  terrainDrain(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 1;
    const t = this.terrain[this.idx(x, y)];
    if (t === T_WATER) return WATER_DRAIN;
    if (t === T_MARSH) return MARSH_DRAIN;
    return 1;
  }
}
