import { GRID_W, GRID_H, T_WATER, T_ROCK, H, MAX_PREDATORS, PRED_LARGE } from './constants.ts';
import type { World } from './world.ts';
import type { Agents } from './agents.ts';
import type { SpatialIndex } from './spatial.ts';
import type { Predators } from './predators.ts';

export const VISION_R = 20;

/**
 * The brain's input contract — fixed layout, 45 channels.
 *   0      bias
 *   1-5    energy, hunger, thirst, age/maxAge, sex
 *   6-14   fertility, desire, love, anger, fear, ego, lonely, desperation, nausea
 *   15-18  food rays      (plant + carcass) N,S,E,W
 *   19-22  agent rays     N,S,E,W
 *   23-26  plant rays     N,S,E,W
 *   27-30  carcass rays   N,S,E,W
 *   31-34  water rays     N,S,E,W
 *   35-38  meat rays      N,S,E,W
 *   39     nearest-other proximity
 *   40     standing in water
 *   41-44  predator rays  N,S,E,W  (1 = small, 2 = large)
 */
export const I_BIAS = 0, I_ENERGY = 1, I_HUNGER = 2, I_THIRST = 3, I_AGE = 4, I_SEX = 5;
export const I_FERT = 6, I_DESIRE = 7, I_LOVE = 8, I_ANGER = 9;
export const I_FEAR = 10, I_EGO = 11, I_LONELY = 12, I_DESPERATE = 13, I_NAUSEA = 14;
export const I_FOOD = 15, I_AGENT = 19, I_PLANT = 23, I_CARCASS = 27;
export const I_WATER_RAY = 31, I_MEAT = 35, I_MATE = 39, I_WATER = 40, I_PRED = 41;

// ray order: N, S, E, W
const RX = [0, 0, 1, -1];
const RY = [-1, 1, 0, 0];

/** March a ray until it hits rock or leaves vision range. */
function ray(
  w: World, x: number, y: number, d: number,
  read: (i: number) => number,
): number {
  const dx = RX[d], dy = RY[d];
  for (let s = 1; s <= VISION_R; s++) {
    const nx = x + dx * s, ny = y + dy * s;
    if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) return 0;
    const i = w.idx(nx, ny);
    if (w.terrain[i] === T_ROCK) return 0;
    const v = read(i);
    if (v > 0) return v / (1 + s);
  }
  return 0;
}

/** Is the straight line from (x,y) to (x2,y2) clear of rock? Cheap DDA over
 *  the dominant axis; predators are big and slow, so this only has to be
 *  good enough to stop a pixel seeing a predator through a mountain. */
function clearLine(w: World, x: number, y: number, x2: number, y2: number): boolean {
  const steps = Math.max(Math.abs(x2 - x), Math.abs(y2 - y));
  if (steps === 0) return true;
  const dx = (x2 - x) / steps, dy = (y2 - y) / steps;
  let cx = x, cy = y;
  for (let s = 1; s < steps; s++) {
    cx = Math.round(x + dx * s);
    cy = Math.round(y + dy * s);
    if (cx === x && cy === y) continue;
    if (!w.inBounds(cx, cy)) return false;
    if (w.terrain[w.idx(cx, cy)] === T_ROCK) return false;
  }
  return true;
}

export function buildInputs(
  a: Agents, w: World, spatial: SpatialIndex, preds: Predators,
  i: number, maxAge: number, out: Float32Array,
): void {
  const x = a.ax[i], y = a.ay[i];

  out[I_BIAS] = 1;
  out[I_ENERGY] = a.energy[i];
  out[I_HUNGER] = a.h(i, H.HUNGER);
  out[I_THIRST] = a.thirst[i];
  out[I_AGE] = Math.min(1, a.age[i] / Math.max(1, maxAge));
  out[I_SEX] = a.sex[i];
  out[I_FERT] = Math.max(0, Math.min(1, (a.age[i] - 40) / 120));
  out[I_DESIRE] = a.h(i, H.DESIRE);
  out[I_LOVE] = a.h(i, H.LOVE);
  out[I_ANGER] = a.h(i, H.ANGER);
  out[I_FEAR] = a.h(i, H.FEAR);
  out[I_EGO] = a.h(i, H.EGO);
  out[I_LONELY] = a.h(i, H.LONELY);
  out[I_DESPERATE] = a.desperation[i];
  out[I_NAUSEA] = a.nausea[i];

  for (let d = 0; d < 4; d++) {
    out[I_FOOD + d] = ray(w, x, y, d, (k) =>
      (w.plant[k] > 0.02 ? w.plant[k] : 0) + (w.carcass[k] > 0.02 ? w.carcass[k] * 0.6 : 0));
    out[I_PLANT + d] = ray(w, x, y, d, (k) => (w.plant[k] > 0.02 ? w.plant[k] : 0));
    out[I_CARCASS + d] = ray(w, x, y, d, (k) => (w.carcass[k] > 0.02 ? w.carcass[k] : 0));
    // water reads as a hard 1/s: a spring does not get thinner with distance,
    // and thirst is the one drive with no substitute
    out[I_WATER_RAY + d] = ray(w, x, y, d, (k) => (w.terrain[k] === T_WATER ? 1 : 0));
    out[I_MEAT + d] = ray(w, x, y, d, (k) => (w.meat[k] > 0.02 ? w.meat[k] : 0));
  }

  // one spatial pass: fills the 4 agent rays and the nearest-other distance
  let nearest = 99;
  let r0 = 0, r1 = 0, r2 = 0, r3 = 0;
  spatial.forEachNear(x, y, VISION_R, (j, ox, oy) => {
    if (j === i) return;
    const d = Math.sqrt(ox * ox + oy * oy);
    if (d < 1) return;
    if (d < nearest) nearest = d;
    const strength = 1 / (1 + d);
    if (Math.abs(ox) >= Math.abs(oy)) {
      if (ox > 0) { if (strength > r2) r2 = strength; }
      else { if (strength > r3) r3 = strength; }
    } else {
      if (oy > 0) { if (strength > r1) r1 = strength; }
      else { if (strength > r0) r0 = strength; }
    }
  });
  out[I_AGENT] = r0; out[I_AGENT + 1] = r1; out[I_AGENT + 2] = r2; out[I_AGENT + 3] = r3;
  out[I_MATE] = 1 / (1 + nearest);
  out[I_WATER] = w.terrain[w.idx(x, y)] === T_WATER ? 1 : 0;

  // Predator rays. There are only ever a few dozen predators, so a direct
  // scan is cheaper than a second spatial index. The value carries the size
  // (1 = small, 2 = large) because the mob you need depends on it: three
  // against a small one, five against a large one. Without this channel a
  // pixel cannot perceive a predator at all, so it can only mob one by
  // walking into it by accident.
  let q0 = 0, q1 = 0, q2 = 0, q3 = 0;
  for (let k = 0; k < MAX_PREDATORS; k++) {
    if (!preds.alive[k]) continue;
    const ox = preds.px[k] - x, oy = preds.py[k] - y;
    const adx = Math.abs(ox), ady = Math.abs(oy);
    if (adx > VISION_R || ady > VISION_R) continue;
    const d = Math.sqrt(ox * ox + oy * oy);
    if (d < 0.5 || d > VISION_R) continue;
    if (!clearLine(w, x, y, preds.px[k], preds.py[k])) continue;
    const weight = (preds.size[k] === PRED_LARGE ? 2 : 1) / (1 + d);
    if (adx >= ady) {
      if (ox > 0) { if (weight > q2) q2 = weight; } else { if (weight > q3) q3 = weight; }
    } else {
      if (oy > 0) { if (weight > q1) q1 = weight; } else { if (weight > q0) q0 = weight; }
    }
  }
  out[I_PRED] = q0; out[I_PRED + 1] = q1; out[I_PRED + 2] = q2; out[I_PRED + 3] = q3;
}
