import {
  GRID_W, GRID_H, T_WATER, T_ROCK, H, MAX_PREDATORS, PRED_LARGE,
  Item, N_ITEMS, CARRY_CAP, FIRE_BURN_TICKS,
} from './constants.ts';
import type { World } from './world.ts';
import type { Agents } from './agents.ts';
import type { SpatialIndex } from './spatial.ts';
import type { Predators } from './predators.ts';

export const VISION_R = 20;

/**
 * The brain's input contract — fixed layout, 67 channels.
 *   0      bias
 *   1-5    energy, hunger, thirst, age/maxAge, sex
 *   6-14   fertility, desire, love, anger, fear, ego, lonely, desperation, nausea
 *   15-18  food rays      (plant + carcass) N,S,E,W
 *   19-22  agent rays     N,S,E,W
 *   23-26  plant rays     N,S,E,W
 *   27-30  carcass rays   N,S,E,W
 *   31-34  water rays     N,S,E,W
 *   35-38  meat rays      N,S,E,W   (loose meat, read as food)
 *   39     nearest-other proximity
 *   40     standing in water
 *   41-44  predator rays  N,S,E,W  (1 = small, 2 = large)
 *   45-48  rock rays      N,S,E,W
 *   49-52  stick rays     N,S,E,W
 *   53-56  item-meat rays N,S,E,W  (the same cells as 35-38; see below)
 *   57     hands: rock     / CARRY_CAP  (whole counts, so 0 .25 .5 .75 1)
 *   58     hands: stick    / CARRY_CAP
 *   59     hands: meat     / CARRY_CAP
 *   60     hands free, 0..1
 *   61-64  fire rays      N,S,E,W  (burn countdown / FIRE_BURN_TICKS)
 *   65     standing in fire
 *   66     fire within 3 cells, 0 or 1
 *
 * 0-44 is frozen and 45-66 were appended after it. That is the only ordering
 * rule this file has: a weight vector is a flat block of N_PARAMS floats with
 * no field names, so inserting a channel at 30 does not fail loudly, it
 * quietly re-points every predator weight at what used to be a water weight
 * and the world's whole learned behaviour changes shape overnight. Appending
 * is the only change a living brain survives.
 *
 * The block at 45-66 is deliberately symmetric and deliberately mute about
 * value. A rock is a rock here and a stick is a stick here, reported with the
 * same shape and the same scaling, and nothing in this file knows — or is
 * allowed to know — what is worth carrying or what two particular things add
 * up to. `Sim.maybeIgnite` is where the world holds its opinion about a lump
 * of rock and a stick; a brain is handed the ingredients and left to find out.
 *
 * 35-38 and 53-56 read the same cells and that is not a mistake. I_MEAT reads
 * loose meat as food; I_MEATITEM_RAY reads it as something you can pick up. The
 * second block exists so that a brain which has learned "walk toward a nonzero
 * ray, then reach for it" holds one rule for rock, stick and meat alike,
 * instead of learning it three times over three differently-shaped channels.
 */
export const I_BIAS = 0, I_ENERGY = 1, I_HUNGER = 2, I_THIRST = 3, I_AGE = 4, I_SEX = 5;
export const I_FERT = 6, I_DESIRE = 7, I_LOVE = 8, I_ANGER = 9;
export const I_FEAR = 10, I_EGO = 11, I_LONELY = 12, I_DESPERATE = 13, I_NAUSEA = 14;
export const I_FOOD = 15, I_AGENT = 19, I_PLANT = 23, I_CARCASS = 27;
export const I_WATER_RAY = 31, I_MEAT = 35, I_MATE = 39, I_WATER = 40, I_PRED = 41;
export const I_ROCK_RAY = 45, I_STICK_RAY = 49, I_MEATITEM_RAY = 53;
export const I_CARRY_ROCK = 57, I_CARRY_STICK = 58, I_CARRY_MEAT = 59, I_CARRY_FREE = 60;
export const I_FIRE_RAY = 61, I_FIRE_UNDER = 65, I_FIRE_NEAR = 66;

/** How near a flame has to be to set I_FIRE_NEAR, in cells, Chebyshev. Three
 *  is the distance at which stepping the wrong way is already expensive, and
 *  it is the radius the four cardinal rays cannot cover: a blaze two north and
 *  two east is inside this box and inside none of the rays. */
const FIRE_NEAR_R = 3;

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
export function clearLine(w: World, x: number, y: number, x2: number, y2: number): boolean {
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

  // Item rays, in the same loop and the same shape as the food rays above, so
  // that "a ray going somewhere" is one thing the brain knows how to read for
  // food, for water and for the three things it can pick up. No FLOOR here:
  // the 0.02 cut exists because a plant below it is not worth a step, and a
  // rock is a whole rock at any size — there is no crumb of stone to ignore.
  for (let d = 0; d < 4; d++) {
    out[I_ROCK_RAY + d] = ray(w, x, y, d, (k) => w.rock[k]);
    out[I_STICK_RAY + d] = ray(w, x, y, d, (k) => w.stick[k]);
    out[I_MEATITEM_RAY + d] = ray(w, x, y, d, (k) => w.meat[k]);
  }

  // Fire rays. `w.fire` is a countdown, so dividing by FIRE_BURN_TICKS turns
  // "how many ticks this cell has left to burn" into 1 for a cell just lit and
  // 0 for an ember, which is the scale the rest of this vector is written in.
  // ray() then thins it with distance, and that ordering is the useful one:
  // a wall of flame twenty cells away is not the thing that kills a pixel, and
  // the weight that says "get out of the fire" should be driven by the fire
  // that is about to be underfoot.
  for (let d = 0; d < 4; d++) {
    out[I_FIRE_RAY + d] = ray(w, x, y, d, (k) =>
      (w.fire[k] > 0 ? w.fire[k] / FIRE_BURN_TICKS : 0));
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

  // Hands. Three counts, divided by CARRY_CAP rather than clamped to it, so a
  // full set of hands is a 1 and each step down to empty is a quarter — four
  // distinguishable states per kind rather than the one bit "am I holding
  // anything", which is the difference between a brain that can learn to walk
  // home full and one that can only learn to gather once.
  const c = i * N_ITEMS;
  out[I_CARRY_ROCK] = a.carry[c + Item.ROCK] / CARRY_CAP;
  out[I_CARRY_STICK] = a.carry[c + Item.STICK] / CARRY_CAP;
  out[I_CARRY_MEAT] = a.carry[c + Item.MEAT] / CARRY_CAP;
  // Free hands, not hands full: the decision GATHER turns on is whether there
  // is room, and the headroom is a cheaper thing to hand a network than the
  // sum of three channels is for it to reconstruct. Read through
  // `Agents.carryRoom` rather than summed here so that this channel and Sim's
  // own capacity check are the same number by construction — two answers to
  // "how much room" is how a sensor ends up disagreeing with the rule it is
  // supposed to be reporting. Clamped because that method is deliberately
  // allowed to go negative, and a channel specified 0..1 that reported -0.25
  // of free hands would be a channel teaching the wrong sign.
  out[I_CARRY_FREE] = Math.max(0, Math.min(1, a.carryRoom(i) / CARRY_CAP));

  // Fire, here and close. The four rays answer how bad and which way; these two
  // answer the two things four cardinal rays structurally cannot. 65 is the
  // only place a pixel learns it is standing in a flame at all: ray() starts
  // at s=1 and so never reads the cell underfoot. 66 is the diagonal — a blaze
  // two north and two east is inside this box and inside none of the four rays,
  // which is a hole a fleeing animal can die in.
  const here = w.idx(x, y);
  out[I_FIRE_UNDER] = w.fire[here] > 0 ? 1 : 0;
  // Scanned as a 7x7 box and short-circuited on the first lit cell, so on the
  // overwhelming majority of ticks — the ones where the world has no fire in it
  // at all — this costs one or two reads, not 49.
  let near = 0;
  for (let dy = -FIRE_NEAR_R; dy <= FIRE_NEAR_R && !near; dy++) {
    for (let dx = -FIRE_NEAR_R; dx <= FIRE_NEAR_R; dx++) {
      if (!w.inBounds(x + dx, y + dy)) continue;
      if (w.fire[w.idx(x + dx, y + dy)] > 0) { near = 1; break; }
    }
  }
  out[I_FIRE_NEAR] = near;
}
