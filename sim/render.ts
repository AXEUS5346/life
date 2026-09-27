import {
  GRID_W, GRID_H, GRID_SIZE, RS, VIEW_W, VIEW_H, VIEW_SIZE,
  T_OPEN, T_ROCK, T_WATER, T_DEAD, T_SAND, T_FOREST, T_MARSH, T_SNOW, T_CAVE,
  MAX_AGENTS, H, N_HORMONES,
  MAX_PREDATORS, PRED_SMALL, PRED_MALE, PRED_ENERGY_CAP, PRED_DEN_ENERGY, CAMP_MARK_R,
} from './constants.ts';
import { maxAgeFor } from './hormones.ts';
import type { Sim } from './sim.ts';

type RGB = readonly [number, number, number];

/** Terrain and carcass colours. Deliberately dark and desaturated so the
 *  emotion colours on the pixels are the only saturated thing on screen. */
export const PALETTE = {
  rock: [26, 32, 44] as RGB,
  water: [16, 44, 56] as RGB,
  dead: [34, 40, 48] as RGB,
  open: [19, 24, 32] as RGB,
  fertile: [28, 36, 38] as RGB,
  plantLow: [54, 70, 44] as RGB,
  plantHigh: [92, 122, 62] as RGB,
  carcass: [96, 62, 48] as RGB,
  meat: [214, 69, 69] as RGB,
  predSmall: [190, 24, 24] as RGB,
  predLarge: [120, 12, 90] as RGB,
  male: [59, 157, 255] as RGB,
  female: [255, 111, 165] as RGB,
  // scenery
  canopy: [20, 50, 32] as RGB,
  canopyHigh: [72, 128, 62] as RGB,
  trunk: [44, 30, 20] as RGB,
  boulder: [84, 88, 100] as RGB,
  boulderHigh: [128, 132, 144] as RGB,
  reed: [96, 106, 54] as RGB,
  // the per-biome ground colours. Nine regions that read apart at a glance
  // are worth more than nine that read like a mood, so the nine are spaced
  // on a brightness ramp first and on hue second: the two snowfields and the
  // shore carry the light end, the forest, the water and the den mouth carry
  // the dark end, and the four mid-tones are pulled apart by hue. The plant
  // overlay below is capped so a lush plain still reads as *plain*.
  ground: [
    [66, 70, 38] as RGB,    // T_OPEN      plain
    [104, 106, 120] as RGB, // T_ROCK      mountain
    [18, 42, 96] as RGB,    // T_WATER     water
    [126, 70, 34] as RGB,   // T_DEAD      badlands
    [190, 168, 116] as RGB, // T_SAND      shore
    [18, 40, 26] as RGB,    // T_FOREST    forest
    [40, 96, 104] as RGB,   // T_MARSH     marsh
    [222, 230, 242] as RGB, // T_SNOW      snowfield
    [66, 26, 66] as RGB,    // T_CAVE      den
  ] as const,
  caveMouth: [176, 108, 44] as RGB,
  /** Trodden earth at a founding camp. Warm and desaturated, so it reads as
   *  a clearing on every biome at once — and it is nowhere near caveMouth,
   *  which is the one other warm mark on the map and means "predators". */
  campGround: [128, 110, 78] as RGB,
} as const;

/** Swatches for the sidebar's map key, in terrain-id order. The UI reads
 *  these so the legend can never drift away from what the renderer paints. */
export const TERRAIN_KEY: { id: number; name: string; css: string; note: string }[] = [
  { id: T_OPEN, name: 'plain', css: 'rgb(66,70,38)', note: 'Open grass. Walkable and lightly fertile.' },
  { id: T_ROCK, name: 'mountain', css: 'rgb(104,106,120)', note: 'Impassable. Nothing crosses it, nothing grows on it.' },
  { id: T_WATER, name: 'water', css: 'rgb(18,42,96)', note: 'Wadeable, but standing in it burns energy 2.5x faster.' },
  { id: T_DEAD, name: 'badlands', css: 'rgb(126,70,34)', note: 'Walkable and barren. Nothing will ever grow here.' },
  { id: T_SAND, name: 'shore', css: 'rgb(190,168,116)', note: "The bank of a river. Walkable, and it grows no food." },
  { id: T_FOREST, name: 'forest', css: 'rgb(18,40,26)', note: 'Dense wood. The richest ground on the map.' },
  { id: T_MARSH, name: 'marsh', css: 'rgb(40,96,104)', note: 'Wetland. Walkable, and it drains you slowly.' },
  { id: T_SNOW, name: 'snowfield', css: 'rgb(222,230,242)', note: 'High frozen ground. Walkable, nearly barren.' },
  { id: T_CAVE, name: 'den', css: 'rgb(66,26,66)', note: 'A den mouth. Predators live in these and hunt from them.' },
];

/**
 * Per-terrain shading of the RS x RS sub-pixels inside one cell, in the order
 * (0,0) (1,0) (0,1) (1,1). This is what stops the map reading as a grid of
 * identical squares: a bevelled rock face, the banding on water, the
 * grain of sand. A flat colour per terrain still looked like a spreadsheet.
 */
const SHADE: readonly number[][] = [
  [1.10, 0.90, 1.00, 0.96], // plain  — tuft lit from the upper left
  [1.22, 1.06, 0.84, 0.92], // rock   — a bevelled face
  [0.88, 1.06, 0.96, 1.02], // water  — ripple banding
  [1.10, 0.92, 0.86, 1.02], // badland— cracked plates
  [1.08, 0.98, 0.95, 1.03], // sand   — speckle
  [0.96, 0.88, 1.02, 0.94], // forest — deep shade between the trunks
  [0.92, 1.06, 0.96, 1.02], // marsh  — standing water
  [1.06, 0.98, 0.94, 1.02], // snow   — drift
  [1, 1, 1, 1],             // den    — shaded per-cell instead, see below
];

/** Stable per-cell hash, so the grain of the world is the same every frame
 *  instead of boiling like television static. */
const NOISE = new Uint8Array(8192);
for (let i = 0; i < 8192; i++) {
  // xorshift, so the table is filled without a dependency on Math.random
  let x = (i + 1) * 2654435761;
  x ^= x >>> 15; x = Math.imul(x, 2246822519); x ^= x >>> 13;
  NOISE[i] = x & 255;
}
function grain(x: number, y: number): number {
  return NOISE[(x * 7919 + y * 104729) & 8191] / 255;
}

/** One colour per hormone, indexed by the H constants. */
export const EMOTION: readonly RGB[] = [
  [32, 201, 151],   // CALM    #20C997
  [245, 165, 36],   // HUNGER  #F5A524
  [220, 38, 38],    // ANGER   #DC2626
  [222, 226, 230],  // FEAR    #DEE2E6
  [218, 119, 242],  // LOVE    #DA77F2
  [121, 80, 242],   // EGO     #7950F2
  [255, 146, 43],   // DESIRE  #FF922B
  [134, 142, 150],  // LONELY  #868E96
  [56, 189, 248],   // THIRST  #38BDF8
  [244, 114, 182],  // DOPAMINE #F472B6
];

export const HORMONE_NAMES = [
  'calm', 'hunger', 'anger', 'fear', 'love', 'ego', 'desire', 'lonely', 'thirst',
  'dopamine',
] as const;

/** How hard the emotion blend is sharpened. Higher = dominant emotion wins
 *  more decisively, so a crowded world stays readable at a glance. */
const SHARPEN = 3.4;

/**
 * Emotion -> colour, as a weighted gradient across all eight channels.
 * The user's call was "make it gradient", so nothing is ever a flat
 * single-emotion swatch — but the exponent keeps the leader legible.
 */
export function emotionColor(a: Sim['agents'], i: number, out: Float32Array): void {
  let r = 0, g = 0, b = 0, total = 0;
  for (let k = 0; k < N_HORMONES; k++) {
    const v = a.h(i, k);
    if (v <= 0.01) continue;
    const w = Math.pow(v, SHARPEN);
    const c = EMOTION[k];
    r += c[0] * w; g += c[1] * w; b += c[2] * w; total += w;
  }
  if (total <= 0) { out[0] = 128; out[1] = 128; out[2] = 128; return; }
  out[0] = r / total; out[1] = g / total; out[2] = b / total;
}

// ---------------------------------------------------------------------------
// predators: sprites, not dots
// ---------------------------------------------------------------------------

/**
 * Part codes, returned by `predatorParts` alongside the offsets so the
 * painter can pick a colour and a test can assert a shape.
 */
export const P_BODY = 0;   // main hide
export const P_DARK = 1;   // legs, ears, tail — the shadow of the hide
export const P_MARK = 2;   // the sex marking; a male and a female differ here
export const P_EYE = 3;    // the eye
export const P_LIGHT = 4;  // chest blaze and tail tip

export type PredPart = { dx: number; dy: number; part: number };

/**
 * Quadruped sprites, written facing right in sub-pixel space. The world
 * moves one cell at a time; the picture is allowed to be finer than that,
 * which is the whole reason `RS` exists. A predator drawn as a square read
 * as "a pixel that happens to be red", and no amount of colour fixed it —
 * what makes it an animal is the ears, the four legs, the tail and the
 * separation of head from shoulder.
 *
 * `.` transparent, `b` hide, `d` dark (legs, ears, tail, nose),
 * `l` pale belly, `e` eye.
 */
const SPR_SMALL = [
  '........b.b..',
  '..b....bbbb..',
  '.bbbb..bbbbbb',
  'bbbbbbbbbbbbe',
  '.bbbbbbbbbblld',
  '..bbbbbbbbb..',
  '......dd.dd..',
  '......d..dd..',
] as const;

const SPR_LARGE = [
  '............b.b..',
  '..b.........bbbb.',
  '.bbb........bbbbb',
  'bbbbb.......bbbbe',
  'bbbbbbbbbbbbbbbbd',
  '.bbbbbbbbbbbbbbll',
  '..bbbbbbbbbbbbb..',
  '......bbbbb.ddd..',
  '......bb.b.d.d...',
  '......d..d.d.d...',
] as const;

/** Where the sex marking goes, as [col, row] into the sprite, on a cell that
 *  is hide in both variants so the mark is always visible. A male is crested
 *  along the back, a female is marked on the flank, so the two sexes are
 *  told apart at a glance and in a pixel diff. */
const MARK_MALE: Record<number, [number, number]> = { 0: [8, 3], 1: [11, 4] };
const MARK_FEMALE: Record<number, [number, number]> = { 0: [7, 5], 1: [9, 6] };

const SPRITES: Record<number, readonly string[]> = { 0: SPR_SMALL, 1: SPR_LARGE };

/** Rotated sprite cache: size|sex|heading -> parts. A predator's heading is
 *  one of eight compass points, so there are only 32 of these and building
 *  them is free after the first frame. */
const SPRITE_CACHE = new Map<string, PredPart[]>();
const CODE: Record<string, number> = { b: P_BODY, d: P_DARK, l: P_LIGHT, e: P_EYE };

function spriteParts(size: number, sex: number, hx: number, hy: number): PredPart[] {
  const key = `${size}|${sex}|${hx},${hy}`;
  const hit = SPRITE_CACHE.get(key);
  if (hit) return hit;

  const rows = SPRITES[size === 0 ? 0 : 1];
  const H = rows.length;
  const W = rows[0].length;
  const mark = (sex === PRED_MALE ? MARK_MALE : MARK_FEMALE)[size === 0 ? 0 : 1];
  const raw: PredPart[] = [];
  for (let r = 0; r < H; r++) {
    const row = rows[r];
    for (let c = 0; c < W; c++) {
      const ch = row[c];
      if (ch === '.') continue;
      const part = (c === mark[0] && r === mark[1]) ? P_MARK : (CODE[ch] ?? P_BODY);
      // re-centre on the sprite's middle, in sub-pixels
      raw.push({ dx: c - (W >> 1), dy: r - (H >> 1), part });
    }
  }

  // Orient the canonical (facing +x) sprite onto one of the eight headings.
  // The four axis headings are exact flips and a transpose; the four
  // diagonals take the same route, which for a quadruped reads correctly
  // because the body is longer than it is tall.
  const out: PredPart[] = [];
  for (const p of raw) {
    let dx = p.dx, dy = p.dy;
    if (hy !== 0) { const t = dx; dx = dy; dy = t; }     // face up/down
    if (hx < 0) dx = -dx;                                 // face left
    if (hy < 0) dy = -dy;                                 // face up
    if (hy !== 0 && hx > 0 && hx === hy) { const t = dx; dx = dy; dy = t; }
    out.push({ dx, dy, part: p.part });
  }
  SPRITE_CACHE.set(key, out);
  return out;
}

/**
 * The painted footprint of a predator, in sub-pixels relative to its cell.
 *
 * This is the exported, testable half of "predators have a shape": it is
 * pure, it takes the same three facts the renderer has, and it answers both
 * "is this a square" and "is this the same animal as that one" without a
 * frame buffer anywhere in sight.
 */
export function predatorParts(size: number, sex: number, hx: number, hy: number): PredPart[] {
  return spriteParts(size === 0 ? 0 : 1, sex === PRED_MALE ? PRED_MALE : 1, hx, hy);
}

const PRED_HIDE: readonly [RGB, RGB][] = [
  [PALETTE.predSmall, [46, 5, 7]],       // small: rust red, near-black legs
  [PALETTE.predLarge, [34, 3, 24]],      // large: deep violet, near-black legs
];
const SEX_TINT: readonly RGB[] = [PALETTE.male, PALETTE.female];

// ---------------------------------------------------------------------------
// scenery
// ---------------------------------------------------------------------------

/** Prop kinds, mirroring what `World.buildProps` writes into `world.prop`. */
const PROP_TREE = 1, PROP_BIG_TREE = 2, PROP_BOULDER = 3, PROP_REEDS = 4;

const tmp = new Float32Array(3);

function put(buf: Uint8ClampedArray, vx: number, vy: number, r: number, g: number, b: number): void {
  if (vx < 0 || vy < 0 || vx >= VIEW_W || vy >= VIEW_H) return;
  const o = (vy * VIEW_W + vx) * 4;
  buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
}

/** Blend one sub-pixel toward a colour, keeping what is already painted.
 *  The passes that mark a place use this rather than `put`, because a mark
 *  has to read as worn ground under whatever was there — a camp that
 *  repainted the biome underneath it would look like a tile type. */
function tint(
  buf: Uint8ClampedArray, vx: number, vy: number,
  r: number, g: number, b: number, k: number,
): void {
  if (vx < 0 || vy < 0 || vx >= VIEW_W || vy >= VIEW_H) return;
  const o = (vy * VIEW_W + vx) * 4;
  buf[o] += (r - buf[o]) * k;
  buf[o + 1] += (g - buf[o + 1]) * k;
  buf[o + 2] += (b - buf[o + 2]) * k;
  buf[o + 3] = 255;
}

/** A pre-baked silhouette: dx, dy, brightness and a highlight flag per point.
 *
 * The scenery pass is the most expensive thing in a frame — there are tens
 * of thousands of props on a map this size — and re-deriving an ellipse test
 * per prop per frame was most of the render budget. There are only four
 * shapes, so they are built once and then replayed as arithmetic. */
type Mask = { pts: Int16Array; w: number; h: number };
const MASK_CACHE = new Map<string, Mask>();

function ellipseMask(
  key: string, w: number, h: number,
  lit: (ey: number, ex: number) => [number, number],
): Mask {
  const hit = MASK_CACHE.get(key);
  if (hit) return hit;
  const out: number[] = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const ex = (i - (w - 1) / 2) / ((w - 1) / 2);
      const ey = (j - (h - 1) / 2) / ((h - 1) / 2);
      if (ex * ex + ey * ey > 1) continue;
      const [shade, tone] = lit(ey, ex);
      out.push(i, j, Math.round(shade * 100), tone);
    }
  }
  const m: Mask = { pts: Int16Array.from(out), w, h };
  MASK_CACHE.set(key, m);
  return m;
}

/**
 * Paint one frame into an RGBA buffer of VIEW_W*VIEW_H*4 bytes.
 *
 * Five passes, in the order the eye needs them: ground, then scenery that
 * overhangs the ground, then meat, then the pixels, then the predators on
 * top of everything. Nothing is ever hidden behind a tree.
 */
export function renderFrame(sim: Sim, buf: Uint8ClampedArray): void {
  const w = sim.world;
  const terrain = w.terrain, plant = w.plant, carcass = w.carcass, prop = w.prop;
  // One scalar grade for the whole world, folded into every colour below.
  // Hue is untouched, so a night frame and a noon frame still read as the
  // same biomes — the light changes, the map does not.
  const light = 0.46 + 0.54 * w.daylight;

  // --- pass 1: ground ------------------------------------------------------
  // Written straight into the buffer rather than through a bounds-checked
  // helper: every offset here is inside the frame by construction, and at
  // GRID_W*GRID_H cells the four helper calls per cell were most of the
  // frame budget.
  for (let y = 0; y < GRID_H; y++) {
    const rowA = (y * RS * VIEW_W) * 4;
    const rowB = ((y * RS + 1) * VIEW_W) * 4;
    for (let x = 0; x < GRID_W; x++) {
      const i = y * GRID_W + x;
      const t = terrain[i];
      const g = PALETTE.ground[t];
      const baseR = g[0], baseG = g[1], baseB = g[2];
      const sh = SHADE[t];
      const n = grain(x, y);
      const p = plant[i];

      let br = baseR, bg = baseG, bb = baseB;
      if (p > 0.02) {
        // Food is grass: a green that grows out of the ground colour rather
        // than replacing it, so a lush field is still the biome underneath.
        // Two noise scales, because one turned every field into a flat
        // sheet of the same green — the map read as a golf course. The
        // weight is capped for the same reason from the other side: at full
        // strength the overlay repainted the ground and the biome vanished.
        const patch = n * 0.55 + grain(x >> 3, y >> 3) * 0.45;
        const t2 = p > 1 ? 1 : p;
        const pk = t2 * 0.45 * (0.62 + 0.62 * patch);
        const pr = PALETTE.plantLow[0] + (PALETTE.plantHigh[0] - PALETTE.plantLow[0]) * t2;
        const pg = PALETTE.plantLow[1] + (PALETTE.plantHigh[1] - PALETTE.plantLow[1]) * t2;
        const pb = PALETTE.plantLow[2] + (PALETTE.plantHigh[2] - PALETTE.plantLow[2]) * t2;
        br += (pr - br) * pk; bg += (pg - bg) * pk; bb += (pb - bb) * pk;
      }
      const k = carcass[i];
      if (k > 0.02) {
        const ck = Math.min(1, k);
        br += (PALETTE.carcass[0] - br) * ck;
        bg += (PALETTE.carcass[1] - bg) * ck;
        bb += (PALETTE.carcass[2] - bb) * ck;
      }

      // per-biome grain, applied on top of the fixed 2x2 shade
      let m0 = 1, m1 = 1, m2 = 1, m3 = 1;
      if (t === T_WATER) {
        const rip = ((x * 5 + y * 3) & 3) === 0 ? 1.22 : 0.9;
        m0 = rip; m1 = rip;
      } else if (t === T_SNOW) {
        if (n > 0.93) { m0 = 1.14; m1 = 1.1; m2 = 1.04; m3 = 1.04; }
        else if (n < 0.07) { m0 = 0.86; m1 = 0.88; m2 = 0.94; m3 = 0.94; }
      } else if (t === T_DEAD) {
        if (n < 0.18) { m0 = 0.68; m1 = 0.72; m2 = 0.78; m3 = 0.82; }
        else if (n > 0.9) { m0 = 1.2; m1 = 1.14; m2 = 1.02; m3 = 1.04; }
      } else if (t === T_ROCK) {
        if (n > 0.82) { m0 = 0.62; m1 = 0.68; m2 = 0.74; m3 = 0.76; }
        else if (n < 0.12) { m0 = 1.22; m1 = 1.16; m2 = 1.04; m3 = 1.02; }
      } else if (t === T_SAND) {
        if (n > 0.82) { m0 = 1.18; m1 = 1.1; m2 = 0.94; m3 = 0.92; }
        else if (n < 0.14) { m0 = 0.86; m1 = 0.88; m2 = 0.92; m3 = 0.94; }
      } else if (t === T_CAVE) {
        if (n > 0.80) {
          // firelight in the mouth: the lower sub-row only, on the few cells
          // that have a mouth at all. Applied to the whole cell it repainted
          // the den in orange and the biome stopped reading as rock.
          const cm = PALETTE.caveMouth;
          br = br + (cm[0] - br) * 0.45;
          bg = bg + (cm[1] - bg) * 0.45;
          bb = bb + (cm[2] - bb) * 0.45;
          m0 = 0.80; m1 = 0.72; m2 = 1.15; m3 = 1.05;
        } else {
          m0 = 1.00; m1 = 0.90; m2 = 0.78; m3 = 0.84;   // a plain dark chamber
        }
      } else if (p > 0.35) {
        // tall grass: the top row of sub-pixels catches the light
        m0 = 1.18; m1 = 1.08; m2 = 0.88; m3 = 0.92;
      }

      const o = (x * RS) * 4;
      const a0 = o + rowA, a1 = a0 + 4, a2 = o + rowB, a3 = a2 + 4;
      // fold the light into the base once; a cell needs twelve writes and
      // doing thirty-six multiplies for them was measurable across 286k cells
      const lr = br * light, lg = bg * light, lb = bb * light;
      const g0 = sh[0] * m0, g1 = sh[1] * m1, g2 = sh[2] * m2, g3 = sh[3] * m3;
      buf[a0] = lr * g0; buf[a0 + 1] = lg * g0; buf[a0 + 2] = lb * g0; buf[a0 + 3] = 255;
      buf[a1] = lr * g1; buf[a1 + 1] = lg * g1; buf[a1 + 2] = lb * g1; buf[a1 + 3] = 255;
      buf[a2] = lr * g2; buf[a2 + 1] = lg * g2; buf[a2 + 2] = lb * g2; buf[a2 + 3] = 255;
      buf[a3] = lr * g3; buf[a3 + 1] = lg * g3; buf[a3 + 2] = lb * g3; buf[a3 + 3] = 255;
    }
  }

  // --- pass 2: camp ground ------------------------------------------------
  // The founding village is the anchor every pixel walks home to, and the
  // sim pulls them there whether or not anyone is looking. Marking the
  // ground is what makes that legible. It goes here rather than after the
  // scenery so the trees still occlude it: a village under a canopy is a
  // clearing, and a ring painted over the canopy would be a ring floating
  // in the treetops.
  const camp = PALETTE.campGround;
  for (let k = 0; k < sim.campX.length; k++) {
    const cx = sim.campX[k] * RS, cy = sim.campY[k] * RS;
    for (let dy = -CAMP_MARK_R; dy <= CAMP_MARK_R; dy++) {
      for (let dx = -CAMP_MARK_R; dx <= CAMP_MARK_R; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > CAMP_MARK_R) continue;
        const vx = cx + dx, vy = cy + dy;
        if (vx < 0 || vy < 0 || vx >= VIEW_W || vy >= VIEW_H) continue;
        const n = grain(vx * 3 + 31, vy * 5 + 17);
        if (d <= CAMP_MARK_R - 1.5) {
          // trampled ground: a little of the green scuffed off, falling off
          // toward the rim so the clearing has no hard edge
          tint(buf, vx, vy, camp[0], camp[1], camp[2], 0.34 * (1 - 0.5 * d / CAMP_MARK_R) * (0.7 + 0.6 * n));
        } else {
          // the rim, broken into four arcs so a camp reads as a place and not
          // as a stain
          const ang = Math.atan2(dy, dx);
          if (Math.abs(((ang / (Math.PI * 2)) * 4 + 8) % 1 - 0.5) > 0.3) continue;
          if (n > 0.84) continue;
          tint(buf, vx, vy, camp[0] * 1.25, camp[1] * 1.2, camp[2] * 1.1, 0.6);
        }
      }
    }
  }

  // --- pass 3: scenery ----------------------------------------------------
  // The generator has been scattering trees, big trees, boulders and reeds
  // since before anything drew them. This is the pass that turns that data
  // into a forest instead of a dark green rectangle.
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const pr = prop[y * GRID_W + x];
      if (pr === 0) continue;
      const n = grain(x * 3 + 11, y * 5 + 7);
      if (pr === PROP_TREE || pr === PROP_BIG_TREE) {
        drawTree(buf, x, y, pr === PROP_BIG_TREE, n, light);
      } else if (pr === PROP_BOULDER) {
        drawBoulder(buf, x, y, n, light);
      } else if (pr === PROP_REEDS) {
        drawReeds(buf, x, y, n, light);
      }
    }
  }

  // --- pass 4: meat -------------------------------------------------------
  // Meat is a chunk lying on the ground, not the ground changing colour: a
  // full-tile tint read as "this tile is different terrain". Two cells wide,
  // growing to three as the pile gets bigger, so you can see what is left.
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const mk = w.meat[y * GRID_W + x];
      if (mk <= 0.04) continue;
      const k = Math.min(1, mk);
      const r = PALETTE.meat[0] * (0.55 + 0.45 * k) * light;
      const g = PALETTE.meat[1] * (0.55 + 0.45 * k) * light;
      const b = PALETTE.meat[2] * (0.55 + 0.45 * k) * light;
      // a 2x2 block for a scrap, 3x3 for a proper pile
      const span = mk > 0.55 ? 3 : 2;
      const off = mk > 0.55 ? 1 : 0;
      for (let dy = 0; dy < span; dy++) {
        for (let dx = 0; dx < span; dx++) {
          // shave the far corners so it reads as a rounded chunk, not a square
          if (span === 3 && (dx + dy === 0 || dx + dy === 4)) continue;
          const cx = (x - off + dx) * RS, cy = (y - off + dy) * RS;
          for (let sy = 0; sy < RS; sy++) {
            for (let sx = 0; sx < RS; sx++) {
              const e = (sx === 1 && sy === 0) ? 1.25 : (dx === 0 && dy === 0 ? 0.86 : 1);
              put(buf, cx + sx, cy + sy, r * e, g * e, b * e);
            }
          }
        }
      }
    }
  }

  // --- pass 5: the pixels -------------------------------------------------
  const a = sim.agents;
  // Pixels get a gentler grade: they are the only saturated thing on the
  // map and they have to stay readable at midnight.
  const plight = 0.62 + 0.38 * light;
  for (let i = 0; i < MAX_AGENTS; i++) {
    if (!a.alive[i]) continue;
    const x0 = a.ax[i] * RS, y0 = a.ay[i] * RS;
    emotionColor(a, i, tmp);

    // Sex reads as a tint, because a cell has no room for a corner square.
    // The inspector shows it exactly; this just lets you read the sex ratio.
    const s = a.sex[i] === 0 ? PALETTE.male : PALETTE.female;
    const TINT = 0.13;
    let r = tmp[0] * (1 - TINT) + s[0] * TINT;
    let g = tmp[1] * (1 - TINT) + s[1] * TINT;
    let b2 = tmp[2] * (1 - TINT) + s[2] * TINT;

    // Calves fade toward white, the way a newborn reads as "not yet coloured".
    const maxAge = maxAgeFor(a.genes, i);
    if (a.age[i] < 28) {
      const k = 1 - a.age[i] / 28;
      const M = k * 0.34;
      r = r * (1 - M) + 235 * M;
      g = g * (1 - M) + 238 * M;
      b2 = b2 * (1 - M) + 245 * M;
    }
    if (a.health[i] <= 0) { r = 120; g = 118; b2 = 112; }

    // Four sub-pixels with one lit corner: a round, faintly shaded body
    // rather than the hard 1-cell square that read as "not a creature".
    put(buf, x0, y0, r * 0.55 * plight, g * 0.55 * plight, b2 * 0.55 * plight);
    put(buf, x0 + 1, y0, r * plight, g * plight, b2 * plight);
    put(buf, x0, y0 + 1, r * 0.78 * plight, g * 0.78 * plight, b2 * 0.78 * plight);
    put(buf, x0 + 1, y0 + 1, r * 0.92 * plight, g * 0.92 * plight, b2 * 0.92 * plight);
  }

  // --- pass 6: the other species -----------------------------------------
  // Predators are not pixels and must not look like them. A small predator
  // is a fox-shaped animal with ears, four legs and a tail; a large one is
  // a bulkier animal twice the length. Drawn as filled squares they read as
  // "a big pixel", which is exactly what they are not.
  const p = sim.predators;
  for (let i = 0; i < MAX_PREDATORS; i++) {
    if (!p.alive[i]) continue;
    const large = p.size[i] === 1;
    const sex = p.sex[i] === PRED_MALE ? 0 : 1;
    const hide = PRED_HIDE[large ? 1 : 0];
    const mark = SEX_TINT[sex];
    // heading: fall back to a default if it is standing still
    let hx = p.hx[i] || 0, hy = p.hy[i] || 0;
    if (!hx && !hy) { hx = 1; hy = 0; }

    // A hungry animal is dimmer and a well-fed one is bright, so the map
    // says something about the state of the den without a legend.
    const fed = p.energy[i] >= PRED_DEN_ENERGY ? 1
      : 0.55 + 0.45 * (p.energy[i] / PRED_DEN_ENERGY);
    // one that is out of its den at all gets a warm rim, which is how you
    // spot "hunting tonight" without reading the roster
    const out = p.ranging[i] ? 1.18 : 0.86;

    const parts = predatorParts(large ? 1 : 0, p.sex[i], hx, hy);
    const ox = p.px[i] * RS + (RS >> 1);
    const oy = p.py[i] * RS + (RS >> 1);
    for (const part of parts) {
      let r: number, g: number, b: number;
      if (part.part === P_DARK) { r = hide[1][0]; g = hide[1][1]; b = hide[1][2]; }
      else if (part.part === P_EYE) { r = 250; g = 242; b = 206; }
      else if (part.part === P_LIGHT) { r = 232; g = 186; b = 176; }
      else if (part.part === P_MARK) { r = mark[0]; g = mark[1]; b = mark[2]; }
      else { r = hide[0][0]; g = hide[0][1]; b = hide[0][2]; }
      put(buf, ox + part.dx, oy + part.dy, r * fed * out * plight, g * fed * out * plight, b * fed * out * plight);
    }
  }
}

/** A tree: a lit canopy with a dark underside and a visible trunk. Drawn in
 *  sub-pixels and allowed to overhang the cell above, which is what gives
 *  the crown a round edge instead of the square one cell would have. */
const CANOPY_SMALL = () => ellipseMask('canopy5', 5, 6,
  (ey) => (ey < -0.15 ? [1.18, 1] : [0.82 + 0.2 * (1 - ey), 0]));
const CANOPY_BIG = () => ellipseMask('canopy8', 8, 9,
  (ey) => (ey < -0.15 ? [1.22, 1] : [0.8 + 0.24 * (1 - ey), 0]));
const BOULDER_A = () => ellipseMask('boulderA', 5, 4, (ey) => (ey < 0 ? [1.06, 1] : [0.66, 0]));
const BOULDER_B = () => ellipseMask('boulderB', 5, 4, (ey) => (ey < -0.4 ? [0.92, 1] : [0.58, 0]));

function drawTree(buf: Uint8ClampedArray, cx: number, cy: number, big: boolean, n: number, light: number): void {
  const m = big ? CANOPY_BIG() : CANOPY_SMALL();
  const top = cy * RS - (big ? 2 : 1) - (m.h >> 1);
  const pts = m.pts;
  const cd = PALETTE.canopy, ch = PALETTE.canopyHigh;
  let vx0 = cx * RS + (RS >> 1) - (m.w >> 1);
  for (let k = 0; k < pts.length; k += 4) {
    const vx = vx0 + pts[k], vy = top + pts[k + 1];
    if (vx < 0 || vy < 0 || vx >= VIEW_W || vy >= VIEW_H) continue;
    const c = pts[k + 3] ? ch : cd;
    const s = pts[k + 2] * 0.01 * light;
    const o = (vy * VIEW_W + vx) * 4;
    buf[o] = c[0] * s; buf[o + 1] = c[1] * s; buf[o + 2] = c[2] * s; buf[o + 3] = 255;
  }
  // trunk: a two-sub-pixel column down to the ground
  const tx = cx * RS + (RS >> 1);
  const ty = cy * RS - (big ? 2 : 1);
  const tr = PALETTE.trunk[0] * light, tg = PALETTE.trunk[1] * light, tb = PALETTE.trunk[2] * light;
  for (let j = 0; j < RS + 1; j++) {
    if (tx >= 0 && ty + j >= 0 && ty + j < VIEW_H) {
      const o = ((ty + j) * VIEW_W + tx) * 4;
      buf[o] = tr; buf[o + 1] = tg; buf[o + 2] = tb; buf[o + 3] = 255;
    }
    if (big && tx + 1 < VIEW_W) {
      const o = ((ty + j) * VIEW_W + tx + 1) * 4;
      buf[o] = tr * 0.8; buf[o + 1] = tg * 0.8; buf[o + 2] = tb * 0.8; buf[o + 3] = 255;
    }
  }
  if (n < 0.04) {
    put(buf, vx0 + (m.w >> 1), top, 220 * light, 232 * light, 204 * light);
  }
}

/** A rounded lump of stone with a lit face. Two baked variants, picked per
 *  stone, so a field of boulders is not a field of identical lumps. */
function drawBoulder(buf: Uint8ClampedArray, cx: number, cy: number, n: number, light: number): void {
  const m = n > 0.5 ? BOULDER_A() : BOULDER_B();
  const top = cy * RS - (m.h >> 1);
  const left = cx * RS + (RS >> 1) - (m.w >> 1);
  const pts = m.pts;
  const cd = PALETTE.boulder, ch = PALETTE.boulderHigh;
  for (let k = 0; k < pts.length; k += 4) {
    const vx = left + pts[k], vy = top + pts[k + 1];
    if (vx < 0 || vy < 0 || vx >= VIEW_W || vy >= VIEW_H) continue;
    const c = pts[k + 3] ? ch : cd;
    const s = pts[k + 2] * 0.01 * light;
    const o = (vy * VIEW_W + vx) * 4;
    buf[o] = c[0] * s; buf[o + 1] = c[1] * s; buf[o + 2] = c[2] * s; buf[o + 3] = 255;
  }
}

/** Reeds: vertical strokes rising out of the water they grow in. */
function drawReeds(buf: Uint8ClampedArray, cx: number, cy: number, n: number, light: number): void {
  const base = cy * RS + RS;
  const h0 = 3 + ((n * 5) | 0);
  const h1 = 2 + (((n * 3) | 0) % 3);
  const h2 = 2 + (((n * 7) | 0) % 3);
  const r = PALETTE.reed[0] * light, g = PALETTE.reed[1] * light, b = PALETTE.reed[2] * light;
  const x0 = cx * RS, span = Math.min(3, VIEW_W - x0);
  for (let s = 0; s < span; s++) {
    const h = s === 0 ? h0 : (s === 1 ? h1 : h2);
    for (let j = 0; j < h; j++) {
      const vy = base - j;
      if (vy < 0) break;
      const k = 0.7 + 0.3 * (j / h);
      const o = (vy * VIEW_W + x0 + s) * 4;
      buf[o] = r * k; buf[o + 1] = g * k; buf[o + 2] = b * k; buf[o + 3] = 255;
    }
  }
}

/** grid cell -> what is standing on it, rebuilt each frame so clicks can be
 *  resolved. Agents get their slot, predators get `-(slot + 2)`, so one array
 *  carries both: -1 is empty, >= 0 is a pixel, <= -2 is a predator. */
export function buildAgentIndex(sim: Sim, out: Int32Array): void {
  out.fill(-1);
  const a = sim.agents;
  for (let i = 0; i < MAX_AGENTS; i++) {
    if (!a.alive[i]) continue;
    out[a.ay[i] * GRID_W + a.ax[i]] = i;
  }
  const p = sim.predators;
  for (let i = 0; i < MAX_PREDATORS; i++) {
    if (!p.alive[i]) continue;
    // a predator wins the cell: it is drawn on top of everything else, so it
    // has to be what the click finds there too
    out[p.py[i] * GRID_W + p.px[i]] = -i - 2;
  }
}

/** The predator's current detection radius, mirroring the hunt pass so the
 *  sidebar's "vision" figure is the number the simulation is actually using. */
export function predVision(size: number, energy: number): number {
  const base = size === 0 ? 70 : 90;
  return Math.round(base + (PRED_ENERGY_CAP - energy) * 190);
}
