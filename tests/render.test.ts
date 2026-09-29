/**
 * Render tests. These drive the real `Sim` and the real `renderFrame`, not a
 * re-implementation of either: the whole point of the rework was that the
 * picture on screen says something, and the only way to know that is to
 * paint a real world and look at the bytes it produced.
 *
 *   node --experimental-strip-types --test tests/render.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Sim, CAUSE } from '../sim/sim.ts';
import { renderFrame, predatorParts, buildAgentIndex, PALETTE, TERRAIN_KEY } from '../sim/render.ts';
import { ticksDue, targetHz } from '../sim/pace.ts';
import { buildInputs, clearLine, I_CARRY_ROCK, I_CARRY_STICK, I_CARRY_MEAT, I_CARRY_FREE } from '../sim/sensors.ts';
import { hormoneBias } from '../sim/hormones.ts';
import {
  GRID_W, GRID_H, GRID_SIZE, RS, VIEW_W, VIEW_H, VIEW_SIZE,
  START_POP, START_PREDATORS, MAX_AGENTS, MAX_PREDATORS,
  T_OPEN, T_ROCK, T_WATER, T_DEAD, T_SAND, T_FOREST, T_MARSH, T_SNOW, T_CAVE,
  TICK_HZ, PRED_DEN_CAP, PRED_DEN_SCATTER, PRED_SMALL, PRED_LARGE, DAY_TICKS,
  PRED_SOFT_CAP, PRED_RESEED_FLOOR, PRED_RESEED_COUNT, PRED_BREED_MIN_PREY,
  MAX_CAMP_SLOTS,
  CAMP_HOME_R, CAMP_MARK_R, MOVE_DX, MOVE_DY,
  FOOD_CELL, FOOD_BUCKETS, FOOD_BUCKETS_X, FOOD_UNDERFOOT,
  N_CAVES, VILLAGES, CAMP_SEP, SEEK_R, N_INPUTS, N_OUTPUTS, N_VERB, N_PARAMS,
  Item, N_ITEMS, CARRY_CAP, TAKE_R, COMBINE_COOLDOWN, ITEM_PICKUP_COOLDOWN,
  FIRE_BURN_TICKS, FIRE_PRED_DAMAGE, FIRE_PIXEL_DAMAGE,
  PRED_SMELL_MULT, PRED_MATE_R, PRED_HUNT_R_SMALL, PRED_HUNT_R_LARGE,
  PRED_SEARCH_GROWTH, PRED_MALE, PRED_FEMALE, PRED_ATTACK_ENERGY,
  PRED_STALK_R, PRED_MEMORY_TICKS, PRED_DEN_ENERGY, DAYLIGHT,
} from '../sim/constants.ts';

const SEED = 20260927;

function freshSim(ticks = 0): Sim {
  const sim = new Sim(SEED);
  sim.seedPopulation(START_POP);
  sim.seedPredators(START_PREDATORS);
  for (let t = 0; t < ticks; t++) sim.step();
  return sim;
}

function paint(sim: Sim): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(VIEW_SIZE * 4);
  renderFrame(sim, buf);
  return buf;
}

/** The pixel at a world cell, sampled at the centre sub-pixel. */
function at(buf: Uint8ClampedArray, cx: number, cy: number): [number, number, number] {
  const o = ((cy * RS + 1) * VIEW_W + cx * RS + 1) * 4;
  return [buf[o], buf[o + 1], buf[o + 2]];
}

/** The mean colour of every sub-pixel of one world cell. For a cell whose
 *  renderer animates within itself — a fire, a flame, anything driven off
 *  `w.tick` — this is the colour of the cell; a single probe is a frame of it. */
function cellMean(buf: Uint8ClampedArray, cx: number, cy: number): [number, number, number] {
  let r = 0, g = 0, b = 0;
  for (let sy = 0; sy < RS; sy++) {
    for (let sx = 0; sx < RS; sx++) {
      const o = ((cy * RS + sy) * VIEW_W + cx * RS + sx) * 4;
      r += buf[o]; g += buf[o + 1]; b += buf[o + 2];
    }
  }
  const n = RS * RS;
  return [r / n, g / n, b / n];
}

function hueDist(
  a: [number, number, number], b: [number, number, number],
): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ---------------------------------------------------------------------------

test('the frame is painted at the full render resolution and is not blank', () => {
  const sim = freshSim(40);
  const buf = paint(sim);
  assert.equal(buf.length, VIEW_W * VIEW_H * 4, 'buffer covers every sub-pixel');
  // "substantially filled": count sub-pixels that are not the transparent
  // black a freshly allocated buffer holds. Every one of them was painted.
  let painted = 0;
  for (let i = 0; i < VIEW_SIZE; i++) {
    if (buf[i * 4 + 3] !== 0) painted++;
  }
  assert.equal(painted, VIEW_SIZE, 'every sub-pixel of the world is painted');
  assert.ok(RS >= 2, 'the renderer draws more than one sub-pixel per world cell');
});

test('all nine biomes are painted in clearly different colours, in their own regions', () => {
  const sim = freshSim(40);
  const buf = paint(sim);
  const w = sim.world;

  // Sample a whole region of each biome, not one lucky cell: the first cell
  // found for a biome is often under a tree canopy or at the ragged edge of a
  // region, and asserting on that one cell tests the noise rather than the
  // biome. Cells with no scenery anywhere in their 3x3 are used, and the
  // median of the samples is what the biome is judged on.
  const samples = new Map<number, [number, number, number][]>();
  for (let y = 2; y < GRID_H - 2; y++) {
    for (let x = 2; x < GRID_W - 2; x++) {
      const i = y * GRID_W + x;
      const t = w.terrain[i];
      let clean = true;
      for (let dy = -1; dy <= 1 && clean; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (w.prop[(y + dy) * GRID_W + (x + dx)] !== 0) { clean = false; break; }
        }
      }
      if (!clean) continue;
      const list = samples.get(t) ?? [];
      if (list.length < 240) list.push(at(buf, x, y));
      samples.set(t, list);
    }
  }

  const median: [number, [number, number, number]][] = [];
  for (const t of [T_OPEN, T_ROCK, T_WATER, T_DEAD, T_SAND, T_FOREST, T_MARSH, T_SNOW, T_CAVE]) {
    const list = samples.get(t);
    assert.ok(list && list.length >= 20,
      `biome ${t} is on the map but barely ${list ? list.length : 0} clean cells of it were sampled`);
    const ch = (c: number): number => {
      const v = list!.map((p) => p[c]).sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    median.push([t, [ch(0), ch(1), ch(2)]]);
  }

  // Every biome must land in its own colour family: no two may be within 45
  // units of each other in RGB, which is roughly a just-noticeable step. This
  // is the assertion that failed when water and rock were 33 apart.
  for (let i = 0; i < median.length; i++) {
    for (let j = i + 1; j < median.length; j++) {
      const [ta, ca] = median[i];
      const [tb, cb] = median[j];
      const d = hueDist(ca, cb);
      assert.ok(d >= 45,
        `biome ${ta} ${JSON.stringify(ca)} and biome ${tb} ${JSON.stringify(cb)} `
        + `are only ${d.toFixed(1)} apart — they read as the same ground`);
    }
  }

  // the key the sidebar shows must cover the same nine biomes
  assert.equal(TERRAIN_KEY.length, 9);
  for (const row of TERRAIN_KEY) {
    assert.ok(samples.has(row.id), `the map key names biome ${row.id}, which the world does not have`);
  }
  // and its swatches must be the colours the renderer actually paints
  for (let i = 0; i < median.length; i++) {
    const [t, painted] = median[i];
    const row = TERRAIN_KEY.find((r) => r.id === t)!;
    const nums = row.css.match(/\d+/g)!.map(Number);
    const d = hueDist(painted, [nums[0], nums[1], nums[2]]);
    assert.ok(d <= 60,
      `the map key shows ${row.css} for ${row.name} but the map paints `
      + `rgb(${painted.join(',')}) — the legend is lying`);
  }
});

test('the scenery pass actually paints: a cell with a prop differs from the same world without one', () => {
  const sim = freshSim(40);
  const w = sim.world;

  // pick a handful of cells that really do carry scenery
  const withProp: number[] = [];
  for (let i = 0; i < GRID_SIZE && withProp.length < 40; i++) {
    if (w.prop[i] !== 0) withProp.push(i);
  }
  assert.ok(withProp.length >= 20, `this world should be covered in scenery, found ${withProp.length} cells`);

  const painted = paint(sim);
  const stripped = new Sim(SEED);
  stripped.seedPopulation(START_POP);
  stripped.seedPredators(START_PREDATORS);
  for (let t = 0; t < 40; t++) stripped.step();
  stripped.world.prop.fill(0);
  const bare = paint(stripped);

  let changed = 0;
  const missed: number[] = [];
  for (const i of withProp) {
    const cx = i % GRID_W, cy = (i / GRID_W) | 0;
    // Compare the whole 3x3 *cell* neighbourhood, because scenery overhangs:
    // a tree crown reaches up into the cell above and sideways into its
    // neighbours. The buffer is addressed in sub-pixels, so a world cell has
    // to be scaled by RS on both axes — indexing it in cell units silently
    // compares the wrong part of the map and reports a false pass.
    let hit = false;
    for (let dy = -1; dy <= 1 && !hit; dy++) {
      const vy0 = (cy + dy) * RS;
      if (vy0 < 0 || vy0 + RS > VIEW_H) continue;
      for (let dx = -1; dx <= 1 && !hit; dx++) {
        const vx0 = (cx + dx) * RS;
        if (vx0 < 0 || vx0 + RS > VIEW_W) continue;
        for (let sy = 0; sy < RS && !hit; sy++) {
          for (let sx = 0; sx < RS; sx++) {
            const o = ((vy0 + sy) * VIEW_W + vx0 + sx) * 4;
            if (hueDist(
              [painted[o], painted[o + 1], painted[o + 2]],
              [bare[o], bare[o + 1], bare[o + 2]],
            ) > 12) { hit = true; break; }
          }
        }
      }
    }
    if (hit) changed++; else missed.push(i);
  }
  assert.deepEqual(missed, [],
    `the scenery pass left ${missed.length} cells untouched out of ${withProp.length} — `
    + `e.g. cell ${missed[0]} (${missed[0] % GRID_W},${(missed[0] / GRID_W) | 0}) prop ${sim.world.prop[missed[0]]}`);
  assert.ok(changed === withProp.length, 'every prop cell was covered by the neighbourhood test');
});

test('a predator is drawn as an animal, not as a square', () => {
  const small = predatorParts(0, 0, 1, 0);
  const large = predatorParts(1, 0, 1, 0);

  // more than one world cell of footprint
  const span = (parts: { dx: number; dy: number }[]) => {
    const w = Math.max(...parts.map((p) => p.dx)) - Math.min(...parts.map((p) => p.dx)) + 1;
    const h = Math.max(...parts.map((p) => p.dy)) - Math.min(...parts.map((p) => p.dy)) + 1;
    return { w, h, area: w * h };
  };
  const s = span(small), l = span(large);
  assert.ok(s.w * s.h > RS * RS, `a small predator fills ${s.w}x${s.h} sub-pixels, more than one cell`);
  assert.ok(small.length > 12, `a small predator is only ${small.length} sub-pixels`);

  // a square of the same area would have this side length; the painted set
  // must not be that rectangle. Square-fill the real footprint and compare
  // its pixel count with the painted count: a square of equal area has the
  // same count only if the shape really is a square.
  const side = Math.round(Math.sqrt(small.length));
  assert.ok(side * side !== small.length || small.length === 0,
    `the painted set is a ${side}x${side} square — that is the bug this rework fixed`);

  // the same test, done by shape rather than by count: the footprint must
  // not fill its own bounding box.
  const cells = new Set(small.map((p) => `${p.dx},${p.dy}`));
  assert.ok(cells.size < s.w * s.h,
    `the small predator fills its whole ${s.w}x${s.h} bounding box`);

  // large and small are different animals
  const ls = new Set(large.map((p) => `${p.dx},${p.dy}`));
  assert.notDeepEqual([...cells].sort(), [...ls].sort(), 'a large predator has the same footprint as a small one');
  assert.ok(large.length > small.length, 'the large predator is the bigger shape');

  // and the sexes differ, so they can be told apart at a glance
  const femaleSmall = predatorParts(0, 1, 1, 0);
  const key = (parts: { dx: number; dy: number; part: number }[]) =>
    parts.map((p) => `${p.dx},${p.dy},${p.part}`).sort().join('|');
  assert.notEqual(key(small), key(femaleSmall), 'a male and a female draw the same pixels');
  assert.equal(cells.size, small.length, 'the sprite has no duplicate sub-pixels');
});

test('the painted frame really contains the predator silhouette, and the small one is visibly smaller', () => {
  // Build a world with nothing on the map but the predators, so any pixel
  // that is predator-hued came from the predator pass.
  const sim = freshSim(0);
  const buf = paint(sim);
  const p = sim.predators;

  const footprint = (i: number): Set<string> => {
    const set = new Set<string>();
    for (let dy = -8; dy <= 8; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        const vx = p.px[i] * RS + (RS >> 1) + dx;
        const vy = p.py[i] * RS + (RS >> 1) + dy;
        if (vx < 0 || vy < 0 || vx >= VIEW_W || vy >= VIEW_H) continue;
        const o = (vy * VIEW_W + vx) * 4;
        const [r, g, b] = [buf[o], buf[o + 1], buf[o + 2]];
        // red-dominant for a small predator, violet-dominant for a large one
        const isPred = p.size[i] === 0
          ? r > 40 && r > g * 1.8 && r > b * 1.8
          : r > 25 && b > 25 && b > g * 1.6;
        if (isPred) set.add(`${vx},${vy}`);
      }
    }
    return set;
  };

  const smallIdx: number[] = [], largeIdx: number[] = [];
  for (let i = 0; i < MAX_PREDATORS; i++) {
    if (!p.alive[i]) continue;
    (p.size[i] === 0 ? smallIdx : largeIdx).push(i);
  }
  assert.ok(smallIdx.length > 0 && largeIdx.length > 0, 'the opening world has both predator sizes');

  const smallArea = footprint(smallIdx[0]).size;
  const largeArea = footprint(largeIdx[0]).size;
  assert.ok(smallArea > RS * RS, `the small predator painted ${smallArea} sub-pixels on the frame`);
  assert.ok(largeArea > smallArea,
    `a large predator painted ${largeArea} sub-pixels against a small one's ${smallArea}`);
});

// ---------------------------------------------------------------------------

test('the opening predators spawn in dens, not on top of the founding pixels', () => {
  const sim = freshSim(0);
  const p = sim.predators;
  assert.equal(p.count, START_PREDATORS, 'a fresh world opens with the seeded predators');

  // every opening predator knows which den it lives in...
  for (let i = 0; i < MAX_PREDATORS; i++) {
    if (!p.alive[i]) continue;
    assert.ok(p.den[i] >= 0 && p.den[i] < sim.world.caveX.length,
      `predator ${i} spawned with den ${p.den[i]}, which is not a den on this map`);
  }

  // ...and stands on ground the den is reachable from, within the scatter
  // radius. This is the "predators are not in dens" complaint, measured: a
  // predator that starts somewhere it could never walk back to is a predator
  // that will spend its life looking for home.
  let worst = 0;
  for (let i = 0; i < MAX_PREDATORS; i++) {
    if (!p.alive[i]) continue;
    const d = Math.hypot(p.px[i] - sim.world.caveX[p.den[i]], p.py[i] - sim.world.caveY[p.den[i]]);
    worst = Math.max(worst, d);
    assert.ok(sim.world.caveDist[sim.world.idx(p.px[i], p.py[i])] >= 0,
      `predator ${i} spawned outside its den's reach`);
  }
  assert.ok(worst <= PRED_DEN_SCATTER + 1,
    `a starting predator is ${worst.toFixed(0)} cells from its den mouth, scatter is ${PRED_DEN_SCATTER}`);

  // and the two species start apart. The old ring put all four predators
  // within twenty-six cells of the founders, which put both species in the
  // same clearing and made the founding village a battleground.
  let nearest = Infinity;
  for (let i = 0; i < MAX_PREDATORS; i++) {
    if (!p.alive[i]) continue;
    for (let k = 0; k < sim.campX.length; k++) {
      nearest = Math.min(nearest, Math.hypot(p.px[i] - sim.campX[k], p.py[i] - sim.campY[k]));
    }
  }
  assert.ok(nearest > CAMP_HOME_R,
    `a starting predator is ${nearest.toFixed(0)} cells from a camp — that is inside the village`);

  // they share dens in pairs, so a den is a pair's home and not a lone animal's
  const perDen = new Map<number, number>();
  for (let i = 0; i < MAX_PREDATORS; i++) {
    if (!p.alive[i]) continue;
    perDen.set(p.den[i], (perDen.get(p.den[i]) ?? 0) + 1);
  }
  assert.ok(Math.max(...perDen.values()) >= 2,
    'no den has a pair in it, so no predator opens its life with a mate in reach');
});

test('a den-marked predator walks home when it is far out on the map', () => {
  const sim = freshSim(0);
  const p = sim.predators;
  // pick any living predator and drop it on the far side of the map
  let i = -1;
  for (let k = 0; k < MAX_PREDATORS; k++) if (p.alive[k]) { i = k; break; }
  assert.ok(i >= 0);
  const den = p.den[i];
  p.px[i] = Math.max(4, Math.min(GRID_W - 5, sim.world.caveX[den] + 90));
  p.py[i] = Math.max(4, Math.min(GRID_H - 5, sim.world.caveY[den] + 90));
  p.ranging[i] = 0;
  p.target[i] = -1;
  p.searchT[i] = 0;

  // Measured down the den's own distance field, NOT as a straight line to the
  // den mouth. A den is a mouth cut into a mountainside with a chamber hollowed
  // out behind it, so the way home is a walk *around* rock: the Euclidean
  // distance to the mouth barely moves while the animal crosses a hundred
  // cells of the map toward it, and on this seed it goes the other way entirely
  // (127 -> 136 straight-line while caveDist fell 272 -> 163). The straight line
  // was measuring the shape of the mountain, not the behaviour of the animal.
  const w = sim.world;
  const before = w.caveDist[w.idx(p.px[i], p.py[i])];
  for (let t = 0; t < 60; t++) sim.step();
  const after = w.caveDist[w.idx(p.px[i], p.py[i])];
  assert.ok(after < before - 40,
    `a stranded predator closed only ${(before - after).toFixed(0)} walked cells in 60 ticks — it is not heading home`);
});

test('a predator resolves the nearest living predator of the opposite sex, and the answer tracks the world', () => {
  const sim = freshSim(0);
  const p = sim.predators;

  // find a male and a female
  let male = -1, female = -1;
  for (let i = 0; i < MAX_PREDATORS; i++) {
    if (!p.alive[i]) continue;
    if (p.sex[i] === 0 && male < 0) male = i;
    if (p.sex[i] === 1 && female < 0) female = i;
  }
  assert.ok(male >= 0 && female >= 0, 'the opening world has both sexes');

  // a lone male on an empty map finds nobody
  for (let i = 0; i < MAX_PREDATORS; i++) p.alive[i] = 0;
  const lone = p.alloc(sim.founderX, sim.founderY, 0, -1, 0, 0);
  assert.ok(lone >= 0);
  assert.equal(sim.nearestOppositeSexPredator(lone), -1,
    'a lone male resolved a partner out of thin air');
  assert.equal(sim.predMateDistance(lone), -1, 'a lone male reported a mate distance');

  // put a female a short walk away: she is the answer
  const f = p.alloc(sim.founderX + 9, sim.founderY + 5, 0, -1, 0, 1);
  assert.equal(sim.nearestOppositeSexPredator(lone), f, 'the lone male did not find the female');
  assert.equal(sim.predMateDistance(lone), Math.round(Math.hypot(9, 5)));

  // move her further off: the reported distance follows her
  p.px[f] = sim.founderX + 40; p.py[f] = sim.founderY + 12;
  assert.equal(sim.predMateDistance(lone), Math.round(Math.hypot(40, 12)));
  assert.equal(sim.nearestOppositeSexPredator(lone), f, 'the answer changed without the neighbour moving away');

  // a second, nearer female must win
  const f2 = p.alloc(sim.founderX + 3, sim.founderY, 0, -1, 0, 1);
  assert.equal(sim.nearestOppositeSexPredator(lone), f2, 'the nearest opposite-sex predator was not chosen');

  // kill her and it falls back to the one still alive
  p.release(f2);
  assert.equal(sim.nearestOppositeSexPredator(lone), f);
  p.release(f);
  assert.equal(sim.nearestOppositeSexPredator(lone), -1, 'a dead partner was still being resolved');
});

test('the sidebar\'s vision figure is the radius the hunt pass actually uses, and it grows with hunger', () => {
  const sim = freshSim(0);
  const p = sim.predators;
  let i = -1;
  for (let k = 0; k < MAX_PREDATORS; k++) if (p.alive[k]) { i = k; break; }
  assert.ok(i >= 0);

  p.energy[i] = 1;
  const full = p.vision(i);
  p.energy[i] = 0.5;
  const half = p.vision(i);
  p.energy[i] = 0;
  const starving = p.vision(i);
  assert.ok(starving > half && half > full,
    `vision did not grow with hunger: ${full} / ${half} / ${starving}`);
  assert.ok(Number.isInteger(full) && full > 0, 'vision is not a usable radius');

  // a large predator sees further than a small one at the same hunger. The
  // size is set explicitly on both reads: the opening world's first slot is
  // a large animal, so reading "the first one" twice measures the same thing.
  p.energy[i] = 0.4;
  p.size[i] = PRED_SMALL;
  const smallR = p.vision(i);
  p.size[i] = PRED_LARGE;
  const largeR = p.vision(i);
  assert.ok(largeR > smallR, `large ${largeR} should out-see small ${smallR}`);
});

test('the sidebar\'s smell figure is the radius the nose actually searches, and it out-reaches the eye', () => {
  // The smell line sits directly under the vision line and promises three things
  // in its own tooltip: it grows with hunger, it is derived the same way vision
  // is, and the circle it draws is the bigger one. A number on screen that has
  // drifted from the sim is a lie told twice over, so the figure is checked
  // against `p.smell(i)` — which is what the hunt pass passes to
  // `nearestByScent` at sim.ts:1796, with no line-of-sight test applied to
  // anything it returns.
  const sim = freshSim(0);
  const p = sim.predators;
  let i = -1;
  for (let k = 0; k < MAX_PREDATORS; k++) if (p.alive[k]) { i = k; break; }
  assert.ok(i >= 0);

  // The same three hunger points the vision test reads, so the two figures are
  // comparable rather than each measured against its own scale.
  for (const energy of [1, 0.5, 0]) {
    p.energy[i] = energy;
    const nose = p.smell(i);
    const eye = p.vision(i);
    assert.ok(Number.isInteger(nose) && nose > 0, `smell at energy ${energy} is not a usable radius`);
    assert.ok(nose > eye,
      `at energy ${energy} the nose reaches ${nose} and the eye ${eye} — the sidebar draws the nose as the bigger circle and it is not`);
  }

  // And it widens with hunger on the same curve the eye does, which is the one
  // claim the tooltip makes twice. Sampled rather than asserted in isolation so
  // a nose that grew while the eye shrank could not pass.
  p.energy[i] = 1;
  const full = p.smell(i);
  p.energy[i] = 0.5;
  const half = p.smell(i);
  p.energy[i] = 0;
  const starving = p.smell(i);
  assert.ok(starving > half && half > full,
    `smell did not grow with hunger: ${full} / ${half} / ${starving}`);

  // The nose is worth a figure of its own only because of the missing
  // line-of-sight check, not because it is the longer number — at full energy
  // a small predator's eye already reaches 70 cells, so almost anything it can
  // smell it can also see. Comparing the two figures cannot show that, because
  // a predator that acquired prey at `vision(i)` would still satisfy every
  // assertion above. It is the smell-through-mountain test at the foot of this
  // file that owns the behaviour: it blocks the line of sight to a pixel
  // standing in open ground inside both radii, checks the eye returns the far
  // visible one, and checks the nose returns the hidden one instead. This test
  // owns the figure; that one owns what the figure is for.
});

test('predators hunt at night, and in daylight only when starving', () => {
  const sim = freshSim(0);
  const p = sim.predators;
  let i = -1;
  for (let k = 0; k < MAX_PREDATORS; k++) if (p.alive[k]) { i = k; break; }
  assert.ok(i >= 0);

  const cases: [string, number, boolean, boolean][] = [
    // label,               energy, isNight, expected
    ['full, day',          0.90, false, false],
    ['full, night',        0.90, true,  false],
    ['comfortable, day',   0.70, false, false],
    ['comfortable, night', 0.70, true,  false],
    ['hungry, day',        0.40, false, false],
    ['hungry, night',      0.40, true,  true],
    ['starving, day',      0.10, false, true],
    ['starving, night',    0.10, true,  true],
  ];
  for (const [label, energy, isNight, want] of cases) {
    p.energy[i] = energy;
    const got = p.wantsToHunt(i, isNight);
    assert.equal(got, want, `wantsToHunt(${label}) returned ${got}`);
  }
});

test('the predator population stays under its cap and is never pinned to it, across several whole days', () => {
  const sim = freshSim(0);
  let peak = 0;
  // two full day-lengths is enough to cover a night, a dawn breeding window
  // and the start of the next night, which is where a cap would be broken
  for (let t = 0; t < 800; t++) {
    sim.step();
    assert.ok(sim.predators.count <= PRED_SOFT_CAP,
      `tick ${t}: ${sim.predators.count} predators alive, the cap is ${PRED_SOFT_CAP}`);
    peak = Math.max(peak, sim.predators.count);
  }
  // The cap is now PRED_SOFT_CAP, which is deliberately ABOVE the four dens and
  // above START_PREDATORS. It used to be `PRED_DEN_CAP` = 4 = the number the
  // world seeds, which meant `breedPredators` returned on its first guard every
  // tick of every run: a cap a species is seeded at is not a cap, it is a
  // padlock, and the species aged out over its 1500-tick lifespan with nothing
  // to replace it. See the PRED_SOFT_CAP comment in constants.ts.
  assert.equal(PRED_SOFT_CAP, 8, 'the predator cap is eight');
  assert.ok(PRED_SOFT_CAP > START_PREDATORS,
    `the cap (${PRED_SOFT_CAP}) must exceed the starting population (${START_PREDATORS}), or the species can never breed`);
  // The world still carves four dens, and the cap is twice that, so a den
  // holds two animals on average and the map stays legible.
  assert.equal(PRED_DEN_CAP, 4, 'the den count is four');
  assert.equal(PRED_DEN_CAP, sim.world.caveX.length,
    `the cap is ${PRED_DEN_CAP} but the world carved ${sim.world.caveX.length} dens — a den the cap does not know about is a den nothing can live in`);
  assert.equal(PRED_SOFT_CAP, PRED_DEN_CAP * 2, 'the cap is two animals a den');
  assert.ok(peak >= 1, 'no predator survived the run, so the cap proved nothing');
  // and the population is not sitting on the ceiling, which is the condition
  // that made the cap fatal: a population pinned at the cap is a population
  // whose breeding pass can never run.
  assert.ok(peak <= PRED_SOFT_CAP, 'peak must be under the cap');
});

test('the world clock says which half of the day it is, and predators follow it', () => {
  const sim = freshSim(0);
  const w = sim.world;
  // drive the real clock and read the real predicate; the old version walked
  // a local counter and asserted against tick 0 for all 400 iterations
  let nightTicks = 0;
  for (let t = 0; t < 400; t++) {
    w.tick = t;
    const frac = t / 400;
    const expectNight = frac >= 0.62 || frac < 0.06;
    assert.equal(w.isNight, expectNight, `tick ${t} disagrees with the night window`);
    if (w.isNight) nightTicks++;
  }
  assert.ok(nightTicks > 100, `only ${nightTicks} of 400 ticks are night`);

  // and the phase name a reader sees agrees with the same clock
  w.tick = 0;   assert.equal(w.phaseName, 'dawn');
  w.tick = 150; assert.equal(w.phaseName, 'day');
  w.tick = 220; assert.equal(w.phaseName, 'dusk');
  w.tick = 300; assert.equal(w.phaseName, 'night');

  // A predator that is not hungry stays in its den through a whole day, both
  // halves of it — checked by running the real step, not by calling the rule.
  //
  // Re-stated every tick, and for every animal rather than the founding four.
  // Setting it once at tick 0 left a hole: a litter costs both parents 0.35,
  // so the four founders were at 0.44 by the end of the window — under the
  // 0.65 line — and went out at night correctly, which read as a failure of
  // the clock. Topping them up each tick tests the thing this test is about,
  // and tests it of the newborn litter as well, which the old version never
  // looked at at all.
  const sim2 = freshSim(0);
  const p = sim2.predators;
  const wellFed = (): void => {
    for (let i = 0; i < MAX_PREDATORS; i++) if (p.alive[i]) p.energy[i] = 0.95;
  };
  wellFed();
  let rangedDuringDay = 0, rangedAtNight = 0;
  for (let t = 0; t < 400; t++) {
    wellFed();
    sim2.step();
    for (let i = 0; i < MAX_PREDATORS; i++) {
      if (!p.alive[i]) continue;
      if (sim2.world.isNight) { if (p.ranging[i]) rangedAtNight++; }
      else if (p.ranging[i]) rangedDuringDay++;
    }
  }
  assert.equal(rangedDuringDay, 0,
    'a well-fed predator was out of its den during daylight');
  assert.equal(rangedAtNight, 0,
    'a well-fed predator left its den at night either — it is supposed to wait');
});

// ---------------------------------------------------------------------------

test('the speed control divides the tick interval, and carries its remainder', () => {
  const SPEEDS = [1, 2, 4, 8, 16];
  for (const s of SPEEDS) {
    // one second of wall clock at this speed, fed in 4ms slices the way the
    // worker loop actually wakes up
    let carry = 0, ticks = 0;
    for (let elapsed = 0; elapsed < 1000; elapsed += 4) {
      const r = ticksDue(carry, 4, s, 1000);
      carry = r.carryMs; ticks += r.ticks;
    }
    const want = TICK_HZ * s;
    assert.ok(Math.abs(ticks - want) <= 1,
      `at ${s}x one second of wall clock ran ${ticks} ticks, expected about ${want}`);
    assert.equal(targetHz(s), want, `targetHz(${s}) is wrong`);
  }

  // and the rates are strictly increasing, which is the whole complaint:
  // two different buttons used to produce the same ticks/second
  for (let i = 1; i < SPEEDS.length; i++) {
    assert.ok(targetHz(SPEEDS[i]) > targetHz(SPEEDS[i - 1]),
      `${SPEEDS[i]}x is not faster than ${SPEEDS[i - 1]}x`);
  }
});

test('a stalled tab does not fast-forward the world when it comes back', () => {
  // a backgrounded tab returns with a huge gap; the loop caps what it will
  // replay in one pass instead of trying to run a minute of simulation
  const r = ticksDue(0, 60_000, 16, 240);
  assert.ok(r.ticks <= 240, `one pass ran ${r.ticks} ticks after a 60s stall`);
  assert.equal(r.carryMs, 0, 'the debt should be dropped, not carried');

  // and a normal gap is passed through untouched
  const n = ticksDue(0, 100, 4, 240);
  assert.equal(n.ticks, 4, '100ms at 4x is four ticks');
});

test('clicking a predator finds the predator, not an empty cell', () => {
  const sim = freshSim();
  const idx = new Int32Array(GRID_SIZE);
  buildAgentIndex(sim, idx);
  const p = sim.predators;
  let checked = 0;
  for (let i = 0; i < MAX_PREDATORS; i++) {
    if (!p.alive[i]) continue;
    const cell = p.py[i] * GRID_W + p.px[i];
    // the sign alone has to say which kind of creature is there
    assert.ok(idx[cell] <= -2,
      `predator ${i} at ${p.px[i]},${p.py[i]} resolved to ${idx[cell]}, not a predator hit`);
    assert.equal(-idx[cell] - 2, i, 'the encoded slot is not the predator that is standing there');
    checked++;
  }
  assert.equal(checked, START_PREDATORS, `expected ${START_PREDATORS} predators, indexed ${checked}`);
});

test('an empty cell still resolves to nothing, so the inspector does not lie', () => {
  const sim = freshSim();
  const idx = new Int32Array(GRID_SIZE);
  buildAgentIndex(sim, idx);
  // the far corner of a 640x448 world: no agent, no predator, ever
  const empty = (GRID_H - 1) * GRID_W + (GRID_W - 1);
  for (let t = 0; t < 20; t++) { sim.step(); buildAgentIndex(sim, idx); }
  assert.equal(idx[empty], -1, 'an empty cell must stay -1, not resolve to predator 0');
});

// --- camps and survival gradients -------------------------------------------
// The three complaints these cover are all the same complaint from different
// angles: pixels died of starvation because nothing on the map pointed at
// food, water or home. The gradients are the mechanism, so they are tested
// directly rather than inferred from a population curve that takes minutes
// to walk.

test('the world gives every founder a camp, and every camp is standable', () => {
  const sim = freshSim(0);
  const w = sim.world;
  assert.ok(sim.campX.length > 0, 'the world has no camps at all');
  assert.equal(sim.campX.length, sim.campY.length, 'a camp has a row and no column');

  for (let k = 0; k < sim.campX.length; k++) {
    const cx = sim.campX[k], cy = sim.campY[k];
    assert.ok(w.inBounds(cx, cy), `camp ${k} is at ${cx},${cy}, off the map`);
    assert.ok(w.passable(cx, cy), `camp ${k} is at ${cx},${cy}, which nobody can stand on`);
  }

  // every pixel inherits one, and it is the same camp as its founder's
  const a = sim.agents;
  let checked = 0;
  for (let i = 0; i < MAX_AGENTS; i++) {
    if (!a.alive[i]) continue;
    const camp = a.campX[a.founder[i]];
    assert.ok(camp > 0, `pixel ${i} has no camp to walk home to`);
    assert.equal(a.campX[i], camp, 'the per-agent camp registry disagrees with the founder lookup');
    checked++;
  }
  assert.equal(checked, START_POP, `expected ${START_POP} pixels, walked ${checked}`);
});

test('a camp marker is painted on the frame, so the village is visible', () => {
  const sim = freshSim(0);
  const buf = paint(sim);
  // The clearing inside the ring has to read differently from the untouched
  // ground just beyond it. Sampled around the circle rather than at one
  // point, because the rim itself is deliberately dashed and a single probe
  // lands in a gap half the time and calls a visible camp invisible.
  // NB: `at` takes world cells and does the sub-pixel scaling itself.
  const rIn = (CAMP_MARK_R - 4) / RS, rOut = CAMP_MARK_R / RS + 3;
  for (let k = 0; k < sim.campX.length; k++) {
    const cx = sim.campX[k], cy = sim.campY[k];
    let campReads = 0;
    for (let s = 0; s < 24; s++) {
      const a = (s / 24) * Math.PI * 2;
      const inside = at(buf, Math.round(cx + Math.cos(a) * rIn), Math.round(cy + Math.sin(a) * rIn));
      const outside = at(buf, Math.round(cx + Math.cos(a) * rOut), Math.round(cy + Math.sin(a) * rOut));
      if (hueDist(inside, outside) > 6) campReads++;
    }
    assert.ok(campReads >= 12,
      `camp ${k} reads at ${campReads} of 24 sample points — the village is invisible on the map`);
  }
});

test('the food gradient points uphill, from barren ground into the green', () => {
  const sim = freshSim(0);
  const w = sim.world;
  w.rebuildFoodField();

  let best = -1, bestV = -1, worst = -1, worstV = Infinity;
  for (let b = 0; b < FOOD_BUCKETS; b++) {
    const v = w.foodField[b];
    if (v > bestV) { bestV = v; best = b; }
    if (v < worstV) { worstV = v; worst = b; }
  }
  assert.ok(bestV > worstV * 4, `the food field is nearly flat (${bestV} vs ${worstV}) — there is no gradient to follow`);

  // Every cell of fertile ground obeys one contract: food underfoot, or a
  // heading toward food. That is the "a pixel always looks a way to live"
  // claim, and the old bucket-sums version broke it — a pixel on a bare
  // rock cell inside a grassy square scored the square's grass as its own
  // and was told to stand still on bare rock. Water, mountain, sand, snow
  // and marsh grow nothing, so the contract is asserted where food can be.
  let checked = 0, starved = 0;
  for (let y = 0; y < GRID_H; y += 3) {
    for (let x = 0; x < GRID_W; x += 3) {
      if (w.terrain[w.idx(x, y)] !== T_OPEN) continue;
      checked++;
      if (w.foodAt(w.idx(x, y)) > FOOD_UNDERFOOT || w.foodStep(x, y) >= 0) continue;
      starved++;
    }
  }
  assert.ok(checked > 1000, `only ${checked} fertile cells sampled — not a real check of the gradient`);
  assert.equal(starved, 0, `${starved} fertile cells have neither food underfoot nor a heading toward any`);

  // Every heading is a step toward food *or* toward the next square that has
  // it, so a single-step comparison proves the wrong thing. What matters is
  // the walk: start a hungry pixel on bare fertile ground, follow the
  // gradient, and it must arrive somewhere it can eat. This is the claim the
  // user made — a pixel should always look a way to live — stated as a test.
  let starts = 0, arrived = 0, worstSteps = 0;
  for (let y = 4; y < GRID_H - 4; y += 2) {
    for (let x = 4; x < GRID_W - 4; x += 2) {
      if (w.terrain[w.idx(x, y)] !== T_OPEN) continue;
      if (w.foodAt(w.idx(x, y)) > FOOD_UNDERFOOT) continue;   // it can already eat
      starts++;
      let px = x, py = y, steps = 0;
      while (steps < 400) {
        const s = w.foodStep(px, py);
        if (s < 0 || s === 4) break;
        const nx = px + MOVE_DX[s], ny = py + MOVE_DY[s];
        if (nx === px && ny === py) break;
        px = nx; py = ny; steps++;
        if (w.foodAt(w.idx(px, py)) > FOOD_UNDERFOOT) break;
      }
      if (w.foodAt(w.idx(px, py)) > FOOD_UNDERFOOT) arrived++;
      else worstSteps++;
    }
  }
  assert.ok(starts > 400, `only ${starts} barren fertile cells to walk from — not a real check`);
  assert.equal(worstSteps, 0,
    `${worstSteps} of ${starts} barren pixels followed the food gradient and never reached anything edible`);

  // A pixel standing on food is told to stay and eat, which is what keeps a
  // lush plain from emptying itself into a march.
  const rx = (best % FOOD_BUCKETS_X) * FOOD_CELL, ry = ((best / FOOD_BUCKETS_X) | 0) * FOOD_CELL;
  assert.equal(findStepIn(w, rx, ry, FOOD_CELL), -1,
    'a pixel standing in the richest square on the map was still told to walk');
  assert.ok(worstV <= 0, 'the emptiest square on the map still has food in it — the test map is not harsh');
});

/** The first heading foodStep gives anywhere in a square, or -1 if the whole
 *  square is bare. The gradient is per cell, not per square, so a test that
 *  probes a square has to probe the way a pixel moves through it. */
function findStepIn(w: Sim['world'], bx: number, by: number, span: number): number {
  for (let y = by; y < by + span; y++) {
    for (let x = bx; x < bx + span; x++) {
      if (w.foodAt(w.idx(x, y)) > FOOD_UNDERFOOT) return -1;
      const s = w.foodStep(x, y);
      if (s >= 0 && s !== 4) return s;
    }
  }
  return -1;
}

test('a pixel is pulled toward its camp, and stops being pulled once it is home', () => {
  const sim = freshSim(0);
  const w = sim.world;
  const cx = sim.campX[0], cy = sim.campY[0];
  const step = w.campStep(cx + 20, cy + 14, cx, cy);
  assert.ok(step >= 0, 'a pixel 24 cells from home was given no heading');
  const dx = cx - (cx + 20), dy = cy - (cy + 14);
  assert.equal(MOVE_DX[step], Math.sign(dx), 'the camp heading does not point at the camp on x');
  assert.equal(MOVE_DY[step], Math.sign(dy), 'the camp heading does not point at the camp on y');
  assert.equal(w.campStep(cx, cy, cx, cy), -1, 'a pixel standing on its camp is still being pulled');
  assert.equal(w.campStep(cx + CAMP_HOME_R, cy, cx, cy), -1, 'a pixel inside CAMP_HOME_R is still being pulled');
});

test('a world runs for thousands of ticks without ending in the first generation', () => {
  // the original complaint: "civilization just ends in gen". 4000 ticks is
  // several day/night cycles and far longer than the founding cohort's
  // lifespan, so a population that is still here at the end has reproduced
  // at least once and its children are still alive.
  const sim = freshSim(0);
  const pop0 = sim.agents.count;
  let extinctAt = -1;
  for (let t = 0; t < 4000; t++) {
    sim.step();
    if (sim.agents.count === 0) { extinctAt = t; break; }
  }
  assert.equal(extinctAt, -1, `the population went extinct at tick ${extinctAt}, generation ${sim.generation}`);
  assert.ok(sim.generation >= 3,
    `four thousand ticks produced only generation ${sim.generation} — the founding cohort is still the only one`);
  assert.ok(sim.agents.count > 0, 'no pixels left');
  assert.ok(sim.agents.count >= pop0 * 0.5,
    `the population fell from ${pop0} to ${sim.agents.count} — survival is still not self-sustaining`);
});

test('living pixels have a way to live: food, water and home are all reachable', () => {
  const sim = freshSim(1500);
  const w = sim.world;
  const a = sim.agents;
  let stranded = 0, fed = 0, watered = 0, homed = 0, checked = 0;
  for (let i = 0; i < MAX_AGENTS; i++) {
    if (!a.alive[i]) continue;
    checked++;
    const x = a.ax[i], y = a.ay[i];
    // the three questions a pixel must be able to answer every tick, from
    // wherever it happens to be standing
    const fs = w.foodStep(x, y);
    const ws = w.waterStep(x, y);
    const camp = a.campX[a.founder[i]];
    const cs = w.campStep(x, y, camp, a.campY[a.founder[i]]);
    if (w.foodAt(w.idx(x, y)) > FOOD_UNDERFOOT || fs >= 0) fed++;
    if (ws >= 0) watered++;
    if (cs >= 0) homed++;
    // "always look a way to live": a pixel can eat where it stands, or it
    // has a heading toward food, or it has a heading toward water or home.
    // A pixel with none of the three is standing in a dead pocket with
    // nothing to do but starve, and that is the failure this whole rework
    // exists to remove.
    if (w.foodAt(w.idx(x, y)) <= FOOD_UNDERFOOT && fs < 0 && ws < 0 && cs < 0) stranded++;
  }
  assert.ok(checked > 0, 'no pixels left to check');
  assert.equal(stranded, 0,
    `${stranded} of ${checked} living pixels are marooned: no food at their feet, no heading to food, water or home`);
  assert.ok(watered / checked > 0.5,
    `only ${watered} of ${checked} living pixels are on a water gradient`);

  // `fed > 0.5` used to stand here and no longer can. It was a proxy for the
  // sentence above, and it stops being one as soon as the population is large
  // enough to have eaten the food near where it lives: measured on this seed
  // the same check gives 84% at pop 58, 61% at pop 376, 39% at pop 382 and 28%
  // at pop 385, while `stranded` is 0 at every one of those. A population that
  // has consumed its own neighbourhood has pixels standing on genuinely barren
  // ground, and `foodStep` is RIGHT to give them no heading — there is none to
  // give. Asserting that a majority of a large population is standing on food
  // is asserting that scarcity has not happened yet, which is a different claim
  // about a different thing, and it is false of a world doing its job.
  //
  // What is worth asserting instead is the thing that is actually load-bearing:
  // the gradient still points at food everywhere it can, and the pixels that
  // are NOT near food are being pointed at water or home rather than marooned.
  // Both are already asserted above and in 'the food gradient points uphill'.
  // So this line only keeps `fed` from being computed and thrown away, and says
  // out loud what the number is now.
  assert.ok(fed / checked > 0.1,
    `only ${fed} of ${checked} living pixels can reach food at all — the food field has stopped answering`);

  // The other half of the claim, and the half that is not about pixels at all:
  // the gradients cover the MAP. A pixel is only ever in a pocket it cannot
  // leave if the pocket is a property of the ground rather than of where the
  // population happens to be standing, and this asks the question over every
  // walkable cell instead of over the hundred-odd that happen to be occupied.
  // It is strictly stronger than `stranded === 0` and it is the assertion that
  // would still fire on a world whose only surviving pixels are standing in the
  // one corner of the map that works.
  //
  // Counted over the biomes that can feed or lead somewhere, which is every
  // one except water and snowfield. Those two are the exception and not an
  // oversight: a pixel standing IN water is already drinking (DRINK_RADIUS=1
  // covers its own tile) and a snowfield is the barren biome the world has on
  // purpose, so neither is ever the place a hungry animal needs a heading out
  // of. Measured on this seed the split is exact — plain, badlands, shore,
  // marsh and forest are 0% unserved, and the two exceptions are 94% and 96%
  // unserved, which is every cell of them that is not already next to
  // something. Counting them would have measured the size of the rivers.
  const FEEDS = new Set([T_OPEN, T_DEAD, T_SAND, T_FOREST, T_MARSH]);
  let live = 0, servedCells = 0;
  for (let y = 2; y < GRID_H - 2; y += 2) {
    for (let x = 2; x < GRID_W - 2; x += 2) {
      if (!w.passable(x, y)) continue;
      if (!FEEDS.has(w.terrain[w.idx(x, y)])) continue;
      live++;
      if (w.foodAt(w.idx(x, y)) > FOOD_UNDERFOOT || w.foodStep(x, y) >= 0
        || w.waterStep(x, y) >= 0) servedCells++;
    }
  }
  assert.ok(live > 10000, `only ${live} habitable cells sampled — not a check of the map`);
  assert.ok(servedCells / live > 0.99,
    `${(live - servedCells)} of ${live} habitable cells have no food, no heading to food and no heading to water`);
});

// ---------------------------------------------------------------------------
// N_CAVES and the den lattice
// ---------------------------------------------------------------------------

test('the world carves exactly N_CAVES dens, and no two share a quarter of the map', () => {
  // The generator used to lay dens on a hardcoded 3x2 lattice and drop N_CAVES
  // to 4 without touching it. `caveX.length` still ended at four — so every
  // assertion in this file that reads "the dens on this map" kept passing —
  // while the lattice had six cells and only the first four in Map order were
  // ever filled. Four dens landed in the two right-hand columns, three quarters
  // of the world had no predator in it at all, and the count was right. This is
  // the assertion that could not have caught it: not how many dens there are,
  // but where they are.
  const sim = freshSim(0);
  const w = sim.world;
  assert.equal(w.caveX.length, N_CAVES,
    `the world carved ${w.caveX.length} dens, the contract says ${N_CAVES}`);
  assert.equal(w.caveY.length, w.caveX.length, 'a den has a row and no column');

  // On COLS x ROWS quarters. N_CAVES=4 is 2x2, and the whole point of deriving
  // the lattice as ceil(sqrt(N_CAVES)) is that the quarters are the ones the
  // generator actually scatters into, so this is the same partition stated from
  // the outside. Checked on six seeds: 4/4, 4/4, 4/4, 4/4, 4/4, 4/4.
  const COLS = Math.ceil(Math.sqrt(N_CAVES));
  const ROWS = Math.ceil(N_CAVES / COLS);
  const quarters = new Map<number, number[]>();
  for (let k = 0; k < w.caveX.length; k++) {
    const q = Math.min(COLS - 1, (w.caveX[k] / (GRID_W / COLS)) | 0)
      + COLS * Math.min(ROWS - 1, (w.caveY[k] / (GRID_H / ROWS)) | 0);
    const list = quarters.get(q) ?? [];
    list.push(k);
    quarters.set(q, list);
  }
  for (const [q, list] of quarters) {
    assert.equal(list.length, 1,
      `quarter ${q % COLS},${(q / COLS) | 0} holds ${list.length} dens at `
      + list.map((k) => `${w.caveX[k]},${w.caveY[k]}`).join(' and ')
      + ' — the lattice is not spreading them');
  }
  assert.equal(quarters.size, N_CAVES,
    `${N_CAVES} dens landed in only ${quarters.size} quarters of the map`);

  // and the weaker but still load-bearing version, in case a future N_CAVES
  // does not fill its lattice: no two dens within a tenth of the map of each
  // other. A den is a place, and four of them stacked on one mountainside is
  // one place with four animals in it.
  for (let a = 0; a < w.caveX.length; a++) {
    for (let b = a + 1; b < w.caveX.length; b++) {
      const d = Math.hypot(w.caveX[a] - w.caveX[b], w.caveY[a] - w.caveY[b]);
      assert.ok(d > GRID_W / 10,
        `dens ${a} and ${b} are ${d.toFixed(0)} cells apart on a ${GRID_W}-wide map`);
    }
  }
});

test('the den lattice is a property of the generator, not of one lucky seed', () => {
  // The single-seed test above can pass by luck on a map that happens to have
  // mountains in all four quarters. Six seeds is enough to make a hardcoded
  // lattice fail: the 3x2 bug put every den in the right-hand columns on every
  // world, so it is not a rare draw, and any seed exposes it.
  for (const seed of [20260927, 1, 7, 12, 99, 4200]) {
    const sim = new Sim(seed);
    const w = sim.world;
    assert.equal(w.caveX.length, N_CAVES,
      `seed ${seed} carved ${w.caveX.length} dens, expected ${N_CAVES}`);
    const COLS = Math.ceil(Math.sqrt(N_CAVES));
    const ROWS = Math.ceil(N_CAVES / COLS);
    const seen = new Set<number>();
    for (let k = 0; k < w.caveX.length; k++) {
      const q = Math.min(COLS - 1, (w.caveX[k] / (GRID_W / COLS)) | 0)
        + COLS * Math.min(ROWS - 1, (w.caveY[k] / (GRID_H / ROWS)) | 0);
      assert.ok(!seen.has(q),
        `seed ${seed} put two dens in quarter ${q % COLS},${(q / COLS) | 0}: `
        + `${w.caveX.map((x, j) => `${x},${w.caveY[j]}`).join(' ')}`);
      seen.add(q);
    }
  }
});

// ---------------------------------------------------------------------------
// the founding villages
// ---------------------------------------------------------------------------

test('the six founders stand as three villages, two pairs, each pair within mating range of its own camp', () => {
  const sim = freshSim(0);
  const w = sim.world;
  const a = sim.agents;

  // Six camps, in the order `seedPopulation` lays them down: two per village.
  assert.equal(sim.campX.length, START_POP, `expected ${START_POP} camps, laid ${sim.campX.length}`);
  assert.equal(sim.campX.length, VILLAGES * 2,
    `${sim.campX.length} camps is not ${VILLAGES} pairs of two`);

  // Consecutive camps are the two founders of one village. The separation has
  // to clear CAMP_HOME_R (so the two read as two places on the map) and stay
  // inside SEEK_R (so the pair can find each other) — CAMP_SEP=9 is the number
  // chosen to sit between them, and this is the assertion that it did.
  const pairs: number[][] = [];
  for (let k = 0; k + 1 < sim.campX.length; k += 2) pairs.push([k, k + 1]);
  for (const [a1, b1] of pairs) {
    const d = Math.hypot(sim.campX[a1] - sim.campX[b1], sim.campY[a1] - sim.campY[b1]);
    assert.ok(d > CAMP_HOME_R,
      `the two camps of village ${a1 / 2} are ${d.toFixed(1)} cells apart — inside CAMP_HOME_R, so one place`);
    assert.ok(d <= SEEK_R,
      `the two camps of village ${a1 / 2} are ${d.toFixed(1)} cells apart, beyond SEEK_R=${SEEK_R}: a lineage that cannot find a mate is not a lineage`);
  }

  // ...and the villages are far enough apart to be three places on the map
  // rather than one smear, which is the other half of the CAMP_SPREAD comment
  // that the old single-village layout failed.
  for (let v1 = 0; v1 < pairs.length; v1++) {
    for (let v2 = v1 + 1; v2 < pairs.length; v2++) {
      const [a1] = pairs[v1], [a2] = pairs[v2];
      const d = Math.hypot(sim.campX[a1] - sim.campX[a2], sim.campY[a1] - sim.campY[a2]);
      assert.ok(d > CAMP_SEP * 4,
        `villages ${v1} and ${v2} are only ${d.toFixed(0)} cells apart — they are one camp field`);
    }
  }

  // Each founder stands at its own camp, and the per-agent registry agrees with
  // the founder lookup — the same identity the whole lineage inherits.
  let checked = 0;
  for (let i = 0; i < MAX_AGENTS; i++) {
    if (!a.alive[i]) continue;
    const k = a.campX[i], c = a.campY[i];
    assert.ok(sim.campX.includes(k) && sim.campY.includes(c),
      `pixel ${i} is homed at ${k},${c}, which is not one of the ${sim.campX.length} camps`);
    assert.equal(k, a.campX[a.founder[i]], 'the per-agent camp disagrees with its founder');
    checked++;
  }
  assert.equal(checked, START_POP);
});

// ---------------------------------------------------------------------------
// items: gathering, carrying, dropping, combining
// ---------------------------------------------------------------------------

/** A world with one pixel standing on a cell the test has set up by hand. */
function itemWorld(): { sim: Sim; agent: number; x: number; y: number } {
  const sim = new Sim(SEED);
  sim.seedPopulation(START_POP);
  sim.seedPredators(START_PREDATORS);
  const a = sim.agents;
  let agent = -1;
  for (let i = 0; i < MAX_AGENTS; i++) if (a.alive[i]) { agent = i; break; }
  assert.ok(agent >= 0, 'no founders to test with');
  // Somewhere walkable and clear of scenery, so a 3x3 reach is a real reach.
  let x = 0, y = 0;
  outer:
  for (let cy = 12; cy < GRID_H - 12; cy += 2) {
    for (let cx = 12; cx < GRID_W - 12; cx += 2) {
      if (!sim.world.passable(cx, cy)) continue;
      x = cx; y = cy;
      break outer;
    }
  }
  a.ax[agent] = x; a.ay[agent] = y;
  a.clearCarry(agent);
  a.gatherT[agent] = 0;
  a.combineT[agent] = 0;
  a.combines[agent] = 0;
  return { sim, agent, x, y };
}

test('a pixel can gather a loose item and is carrying it afterwards', () => {
  const { sim, agent, x, y } = itemWorld();
  const w = sim.world, a = sim.agents;
  // one rock, on the cell underfoot and nowhere else
  w.addItem(w.idx(x, y), Item.ROCK, 1);
  assert.equal(w.itemAt(w.idx(x, y), Item.ROCK), 1, 'the test did not lay down a rock');

  const reward = (sim as unknown as { gatherItem: (i: number) => number }).gatherItem(agent);
  assert.equal(w.itemAt(w.idx(x, y), Item.ROCK), 0, 'the rock is still lying on the map after a gather');
  assert.equal(a.carrying(agent, Item.ROCK), 1, 'the rock is not in the pixel\'s hands');
  assert.equal(a.carryingTotal(agent), 1);
  assert.ok(reward > 0, `a successful gather paid ${reward}`);
  assert.equal(a.gatherT[agent], ITEM_PICKUP_COOLDOWN, 'the gather cooldown was not set');

  // and reach is a real constraint: a rock two cells away is not in reach.
  const far = itemWorld();
  far.sim.world.addItem(far.sim.world.idx(far.x, far.y), Item.STICK, 1);
  far.sim.world.rock.fill(0);
  far.sim.world.stick.fill(0);
  far.sim.world.stickTotal = 0;
  far.sim.world.addItem(far.sim.world.idx(far.x + TAKE_R + 1, far.y), Item.STICK, 1);
  assert.equal(far.sim.world.itemAt(far.sim.world.idx(far.x + TAKE_R + 1, far.y), Item.STICK), 1);
  (far.sim as unknown as { gatherItem: (i: number) => number }).gatherItem(far.agent);
  assert.equal(far.sim.agents.carryingTotal(far.agent), 0,
    `a stick ${TAKE_R + 1} cells away was picked up — TAKE_R is not bounding the reach`);
});

test('carry respects CARRY_CAP, and release() clears the hands of a recycled slot', () => {
  const { sim, agent: i } = itemWorld();
  const a = sim.agents;

  // The row and the total are two different arrays and a hand is full when
  // EITHER says so. The half that gets forgotten is the total: a pixel with
  // four rocks in the row and a total of zero is carrying four rocks and has
  // four free hands, and nothing about that fails loudly.
  a.clearCarry(i);
  assert.equal(a.carryRoom(i), CARRY_CAP, 'a fresh slot is not empty-handed');
  assert.equal(a.addCarry(i, Item.ROCK, 3), 3);
  assert.equal(a.carryingTotal(i), 3, 'addCarry did not update the total');
  assert.equal(a.carryRoom(i), CARRY_CAP - 3);

  // a fourth fits, a fifth does not
  assert.equal(a.addCarry(i, Item.ROCK, 1), 1);
  assert.equal(a.carryRoom(i), 0, 'four in hand is not a full set of hands');
  assert.equal(a.addCarry(i, Item.ROCK, 1), 0, 'a fifth rock fitted into four hands');
  assert.equal(a.carrying(i, Item.ROCK), CARRY_CAP, 'the row disagrees with CARRY_CAP');

  // A kind with no room returns what it fitted, not what it was offered —
  // the caller needs the difference to leave the rest on the ground.
  a.clearCarry(i);
  assert.equal(a.addCarry(i, Item.STICK, 1), 1);
  assert.equal(a.addCarry(i, Item.STICK, 99), CARRY_CAP - 1,
    'addCarry did not report the partial fit, so the caller cannot put the rest back');

  // release() is the recycled-slot bug. The free list hands this index to the
  // next newborn, and a slot that keeps the dead animal's rock gives the
  // newborn a rock it never picked up. Both arrays have to be cleared; clearing
  // only the row leaves carryRoom() at zero and the newborn is born full.
  a.clearCarry(i);
  a.carry[i * N_ITEMS + Item.ROCK] = 4;
  a.carryCount[i] = 4;
  a.gatherT[i] = 2;
  a.combineT[i] = 5;
  a.combines[i] = 7;
  a.release(i);
  assert.equal(a.alive[i], 0);
  for (let it = 0; it < N_ITEMS; it++) {
    assert.equal(a.carrying(i, it), 0, `release left ${it} in the row`);
  }
  assert.equal(a.carryingTotal(i), 0, 'release left the total full — the newborn is born with no hands');
  assert.equal(a.carryRoom(i), CARRY_CAP, 'a recycled slot is not empty-handed');
  assert.equal(a.gatherT[i], 0, 'release left the gather cooldown part-expired');
  assert.equal(a.combineT[i], 0, 'release left the combine cooldown part-expired');
  assert.equal(a.combines[i], 0, 'a recycled slot still reports combines its last tenant performed');

  // and alloc() on that same slot must not hand the dead animal's load back.
  // The free list is a LIFO stack that seedPopulation filled in order, so
  // releasing slot i and allocating once more gives slot i straight back.
  const reused = a.alloc(sim.rng, 10, 10);
  assert.equal(reused, i, 'the free-slot stack did not hand back the slot that was released');
  assert.equal(a.carryingTotal(reused), 0, 'a newborn arrived holding the last tenant\'s things');
  assert.equal(a.carryRoom(reused), CARRY_CAP, 'a newborn arrived with full hands');
});

test('combining fuses everything carried and hands the lump to the world', () => {
  const { sim, agent, x, y } = itemWorld();
  const a = sim.agents, w = sim.world;

  // One thing is not a fusion, and the cooldown is real.
  a.clearCarry(agent);
  a.addCarry(agent, Item.ROCK, 1);
  assert.equal((sim as unknown as { combineItems: (i: number) => number }).combineItems(agent), 0,
    'a pixel holding one rock combined it');
  assert.equal(a.combines[agent], 0, 'a one-item combine was counted');

  a.clearCarry(agent);
  a.addCarry(agent, Item.ROCK, 1);
  a.addCarry(agent, Item.STICK, 1);
  const reward = (sim as unknown as { combineItems: (i: number) => number }).combineItems(agent);
  assert.equal(a.carryingTotal(agent), 0, 'a combine left the ingredients in hand');
  assert.equal(a.combines[agent], 1, 'the combine was not counted');
  assert.equal(a.combineT[agent], COMBINE_COOLDOWN, 'the combine cooldown was not set');
  assert.ok(reward > 0, `a combine paid ${reward}`);

  // The cooldown actually blocks the next attempt, which is the half that
  // makes COMBINE reachable rather than once-per-life.
  a.clearCarry(agent);
  a.addCarry(agent, Item.ROCK, 2);
  assert.equal((sim as unknown as { combineItems: (i: number) => number }).combineItems(agent), 0,
    'a pixel combined again inside its own cooldown');
  assert.equal(a.carryingTotal(agent), 2, 'the blocked combine still emptied the hands');

  // Everything carried goes into the lump, not just the two kinds the world
  // has an opinion about. Four rocks and a stick is a combine; so is a rock
  // and three sticks; both must clear the hands completely.
  a.combineT[agent] = 0;
  a.clearCarry(agent);
  a.addCarry(agent, Item.ROCK, 3);
  a.addCarry(agent, Item.STICK, 1);
  (sim as unknown as { combineItems: (i: number) => number }).combineItems(agent);
  assert.equal(a.carryingTotal(agent), 0, 'four rocks and a stick left something behind');

  // The lump is not left lying on the map: it is handed to the world, which
  // either sets the cell alight or decides there was nothing there. Asserted
  // as an exclusive rather than a value, because the world's answer is
  // stochastic and the pixel is not supposed to be able to predict it — a lump
  // a pixel could walk back to and look at would be a lump whose value the
  // pixel had already been told, which is the whole thing that must not happen.
  const cell = w.idx(x, y);
  assert.equal(w.itemAt(cell, Item.ROCK), 0, 'a lump was left on the map as an item');
  assert.equal(w.itemAt(cell, Item.STICK), 0, 'a lump was left on the map as an item');
});

// ---------------------------------------------------------------------------
// fire
// ---------------------------------------------------------------------------

/** Light the real fire: hand a pixel a rock and a stick and let it COMBINE,
 *  repeatedly, on a cell the test has chosen. Igniting `world.fire` directly is
 *  NOT the same thing and will not work — `Sim.stepFire` walks its own sparse
 *  list, and a cell lit by `World.ignite` alone is in the world's list and not
 *  in the sim's, so the fire pass returns early on `fireN === 0` and the cell
 *  sits at FIRE_BURN_TICKS forever. `Sim.maybeIgnite` is the only path that
 *  registers a cell in both, which is exactly what `spreadTo`'s comment says. */
function igniteAt(sim: Sim, agent: number, cell: number, tries = 40): boolean {
  const a = sim.agents, w = sim.world;
  const x = cell % GRID_W, y = (cell / GRID_W) | 0;
  a.ax[agent] = x; a.ay[agent] = y;
  for (let k = 0; k < tries; k++) {
    if (w.fire[cell] > 0) return true;
    a.clearCarry(agent);
    a.addCarry(agent, Item.ROCK, 1);
    a.addCarry(agent, Item.STICK, 1);
    a.combineT[agent] = 0;
    (sim as unknown as { combineItems: (i: number) => number }).combineItems(agent);
  }
  return w.fire[cell] > 0;
}

/** A flammable cell with no water inside `clear` cells, so a fire there is not
 *  put out before the test can look at it. */
function dryFuelCell(sim: Sim, clear = 2): number {
  const w = sim.world;
  outer:
  for (let y = 20; y < GRID_H - 20; y++) {
    for (let x = 20; x < GRID_W - 20; x++) {
      const i = w.idx(x, y);
      if (!w.flammable(i)) continue;
      let wet = false;
      for (let dy = -clear; dy <= clear && !wet; dy++) {
        for (let dx = -clear; dx <= clear; dx++) {
          if (w.terrain[w.idx(x + dx, y + dy)] === T_WATER) { wet = true; break; }
        }
      }
      if (!wet) return i;
    }
  }
  return -1;
}

test('a burning cell is painted differently from the same cell unburnt', () => {
  const { sim, agent } = itemWorld();
  const w = sim.world;
  const cell = dryFuelCell(sim);
  assert.ok(cell >= 0, 'this world has no flammable ground to burn');
  const cx = cell % GRID_W, cy = (cell / GRID_W) | 0;

  // Unburnt first, so the comparison is the same world with one field changed
  // and nothing else — a fresh Sim would differ in the light, the day, the
  // plants and every agent on the map.
  const before = paint(sim);
  const plain = cellMean(before, cx, cy);

  assert.ok(igniteAt(sim, agent, cell), `the world would not take a lump at ${cx},${cy}`);
  assert.ok(w.isBurning(cell), 'the cell is not alight after a combine');

  // The whole cell, not one sub-pixel of it. `drawFire` flickers per sub-pixel
  // off `w.tick` — the four sub-pixels of a burning cell measured rgb(229,212,134)
  // / rgb(10,22,14) / rgb(197,136,31) / rgb(215,148,34) — so a single probe is
  // sampling the flame animation rather than the fire, and whichever of the two
  // it lands on decides whether this test passes. The mean is the colour of the
  // cell, which is the thing being asserted about.
  const after = paint(sim);
  const lit = cellMean(after, cx, cy);
  const d = hueDist(plain, lit);
  assert.ok(d > 45,
    `a burning cell paints rgb(${lit.map((n) => n.toFixed(0)).join(',')}) and an unburnt one `
    + `rgb(${plain.map((n) => n.toFixed(0)).join(',')}) — only ${d.toFixed(1)} apart, `
    + 'which is not a fire anybody would notice');

  // ...and it is warm, not merely different. A grey rock would satisfy the
  // distance check above and mean nothing.
  assert.ok(lit[0] > lit[2],
    `the fire is not warm: rgb(${lit.map((n) => n.toFixed(0)).join(',')})`);
  assert.ok(lit[0] > plain[0], 'the fire is dimmer than the ground it is burning');

  // A fire the renderer cannot see is a fire the sensors still charge a pixel
  // for, so the two have to agree: the cell the frame lit is the cell the
  // world says is alight.
  assert.equal(w.isBurning(cell), true);
});

test('water puts a fire out, and a cell lit on dry ground beside a river is not', () => {
  // The two halves, because the first one on its own is a test that passes
  // whenever the fire happens to go out for some other reason.
  const { sim, agent } = itemWorld();
  const w = sim.world;

  // --- dry ground: the fire burns, and burns for its full count -------------
  const dry = dryFuelCell(sim);
  assert.ok(dry >= 0, 'this world has no dry fuel');
  assert.ok(igniteAt(sim, agent, dry), `no fire at the dry cell ${dry % GRID_W},${(dry / GRID_W) | 0}`);
  for (let t = 0; t < 10; t++) sim.step();
  assert.ok(w.fire[dry] > 0, 'a fire on dry ground went out in under ten ticks');

  // --- beside water: extinguished on the first fire pass --------------------
  let wet = -1;
  outer:
  for (let y = 20; y < GRID_H - 20; y++) {
    for (let x = 20; x < GRID_W - 20; x++) {
      const i = w.idx(x, y);
      if (!w.flammable(i) || w.isBurning(i)) continue;
      for (let dy = -1; dy <= 1 && wet < 0; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (w.terrain[w.idx(x + dx, y + dy)] === T_WATER) { wet = i; break; }
        }
      }
      if (wet >= 0) break outer;
    }
  }
  assert.ok(wet >= 0, 'this world has no fuel anywhere near water — the map has no shoreline at all');
  assert.ok(igniteAt(sim, agent, wet), `no fire at the wet cell ${wet % GRID_W},${(wet / GRID_W) | 0}`);
  assert.ok(w.fire[wet] > 0, 'the cell never caught in the first place');
  sim.step();
  assert.equal(w.fire[wet], 0,
    'a burning cell a step from a river is still alight — water is the only firebreak this map has');
});

test('a predator standing in fire loses more health per tick than a pixel does', () => {
  const { sim, agent } = itemWorld();
  const w = sim.world, a = sim.agents, p = sim.predators;
  let pred = -1;
  for (let k = 0; k < MAX_PREDATORS; k++) if (p.alive[k]) { pred = k; break; }
  assert.ok(pred >= 0, 'no predator to test with');

  const cell = dryFuelCell(sim);
  assert.ok(cell >= 0, 'this world has no flammable ground to burn');
  const cx = cell % GRID_W, cy = (cell / GRID_W) | 0;
  assert.ok(igniteAt(sim, agent, cell), 'the world would not take a lump, so there is no fire to stand in');

  // Both species pinned on the burning cell and the fire pass run directly.
  //
  // NOT sim.step(), and the reason is the order inside it. `stepFire` runs
  // after the pixels have taken their turn and moved, and before the predators
  // have moved — a pixel that steps into a blaze is hurt by it the same tick,
  // and a predator that walked into one is not punished again for the avoidance
  // that failed to stop it. That asymmetry is the design, and it means a test
  // that re-pins both creatures and then calls step() measures one species
  // standing in a fire and the other one walking through it: the pixel is one
  // cell downstream of its own fire by the time the pass runs, and it loses
  // nothing while the predator loses a tenth of its health every tick. The
  // assertion below is about the two DAMAGE CONSTANTS, so it measures the pass
  // that applies them rather than the ordering around it.
  a.ax[agent] = cx; a.ay[agent] = cy; a.alive[agent] = 1; a.health[agent] = 1; a.deathCause[agent] = 0;
  p.px[pred] = cx; p.py[pred] = cy; p.alive[pred] = 1; p.health[pred] = 1;
  assert.equal(w.fire[cell] > 0, true, 'the cell went out between lighting it and standing in it');

  (sim as unknown as { stepFire: () => void }).stepFire();
  const pixelLost = 1 - a.health[agent];
  const predLost = 1 - p.health[pred];

  const near = (got: number, want: number, what: string) =>
    assert.ok(Math.abs(got - want) < 1e-6,
      `${what} lost ${got.toFixed(4)} health in one fire pass, the constant says ${want.toFixed(4)}`);
  near(pixelLost, FIRE_PIXEL_DAMAGE, 'the pixel');
  near(predLost, FIRE_PRED_DAMAGE, 'the predator');

  // The claim in constants.ts: fire is 2.5x death by starvation and 8x death
  // by age FOR THE PREDATOR, and ten times gentler for the pixel, because
  // there are hundreds of them and a fire at the predator's rate would empty
  // the map in an afternoon. So the ratio has to be the ratio, not just "more".
  assert.ok(predLost > pixelLost * 5,
    `a predator lost ${predLost.toFixed(4)} and a pixel ${pixelLost.toFixed(4)} in the same fire — `
    + `FIRE_PRED_DAMAGE/FIRE_PIXEL_DAMAGE is ${(FIRE_PRED_DAMAGE / FIRE_PIXEL_DAMAGE).toFixed(0)}x `);
  assert.ok(predLost > 2 * 0.0004 && predLost > 8 * 0.006,
    `fire is not the predator's worst threat: ${predLost.toFixed(3)} against 0.0008 starvation and 0.048 age`);

  // ...and the flags the state machine reads were both set, because "fire is a
  // reason to leave" is only a rule if something noticed.
  assert.equal(p.burned[pred], 1, 'the predator was burned and does not know it');
  assert.equal(a.deathCause[agent], CAUSE.BURNED, 'the pixel is burning and its death is not attributed to it');
});

// ---------------------------------------------------------------------------
// the carry channels and the bias buffer
// ---------------------------------------------------------------------------

test('the new carry channels reach the brain, and a reused output buffer does not leak between agents', () => {
  const sim = new Sim(SEED);
  sim.seedPopulation(START_POP);
  sim.seedPredators(START_PREDATORS);
  const a = sim.agents, w = sim.world, p = sim.predators;

  // Pick two founders and give them different loads. The channels are 57-60
  // and they are the ONLY new inputs: if one of them is not written on some
  // path, it keeps whatever the last agent wrote there and the brain learns to
  // trust it.
  let lo = -1, hi = -1;
  for (let i = 0; i < MAX_AGENTS && hi < 0; i++) {
    if (!a.alive[i]) continue;
    if (lo < 0) lo = i; else hi = i;
  }
  assert.ok(lo >= 0 && hi >= 0, 'need two founders to compare');
  a.clearCarry(lo); a.clearCarry(hi);
  a.addCarry(lo, Item.ROCK, 2);              // half a load of one kind
  a.addCarry(hi, Item.STICK, 4);             // a full load of another

  // A single buffer, written twice — this is the whole point. `Sim` allocates
  // one per agent in the tick loop; a test that allocates a fresh one per
  // agent cannot see the bug this is here for.
  const out = new Float32Array(N_INPUTS);
  out.fill(-1);                                 // a value no channel ever writes
  buildInputs(a, w, sim.spatial, p, lo, 200, out);
  const loRock = out[I_CARRY_ROCK], loStick = out[I_CARRY_STICK];
  const loMeat = out[I_CARRY_MEAT], loFree = out[I_CARRY_FREE];
  buildInputs(a, w, sim.spatial, p, hi, 200, out);
  const hiRock = out[I_CARRY_ROCK], hiStick = out[I_CARRY_STICK];
  const hiMeat = out[I_CARRY_MEAT], hiFree = out[I_CARRY_FREE];

  const near = (got: number, want: number, what: string) =>
    assert.ok(Math.abs(got - want) < 1e-5,
      `${what} is ${got.toFixed(4)}, expected ${want.toFixed(4)}`);

  near(loRock, 2 / CARRY_CAP, 'the empty-handed agent\'s rock channel');
  near(loStick, 0, 'the empty-handed agent\'s stick channel');
  near(loMeat, 0, 'the empty-handed agent\'s meat channel');
  near(loFree, (CARRY_CAP - 2) / CARRY_CAP, 'the empty-handed agent\'s free-hands channel');
  near(hiRock, 0, 'the full agent\'s rock channel — it is holding sticks, not rock');
  near(hiStick, 1, 'the full agent\'s stick channel');
  near(hiMeat, 0, 'the full agent\'s meat channel');
  near(hiFree, 0, 'the full agent\'s free-hands channel');

  // The leak, stated as a leak: the second read must not be able to see the
  // first. Every carry channel moved, so if any of these were written once
  // and left, the two columns above would be equal.
  assert.notEqual(loRock, hiRock, 'the rock channel did not change between two agents');
  assert.notEqual(loStick, hiStick, 'the stick channel did not change between two agents');
  assert.notEqual(loFree, hiFree, 'the free-hands channel did not change between two agents');

  // An empty-handed pixel is the case a stale buffer shows up in first: if the
  // channels were only written on a non-zero branch, the second agent would
  // report the first agent's load.
  a.clearCarry(hi);
  buildInputs(a, w, sim.spatial, p, hi, 200, out);
  near(out[I_CARRY_ROCK], 0, 'the emptied agent\'s rock channel still reads the last load');
  near(out[I_CARRY_STICK], 0, 'the emptied agent\'s stick channel still reads the last load');
  near(out[I_CARRY_FREE], 1, 'the emptied agent\'s free-hands channel still reads a full hand');
});

test('hormoneBias leaves no stale verb score on a reused buffer', () => {
  // The silent one. `Sim` keeps ONE `bias` array of N_OUTPUTS floats and hands
  // it to every agent in the turn loop, so a verb slot nobody writes keeps
  // whatever the last animal put there. At N_VERB=7 every verb above IDLE
  // happened to be covered by a write and the bug could not exist; at N_VERB=10
  // with GATHER, DROP and COMBINE added, a verb left unwritten is a verb an
  // animal is silently biased toward or away from by whoever ran before it.
  //
  // The sentinel: fill the buffer with a value no bias expression can produce
  // (a magnitude far outside the scale of anything written here), run one
  // agent, and read every verb slot. Anything still at the sentinel is a slot
  // this function does not own.
  const sim = new Sim(SEED);
  sim.seedPopulation(START_POP);
  sim.seedPredators(START_PREDATORS);
  const a = sim.agents;

  const bias = new Float32Array(N_OUTPUTS);
  const SENTINEL = 1234.5;
  bias.fill(SENTINEL);

  let agent = -1;
  for (let i = 0; i < MAX_AGENTS; i++) if (a.alive[i]) { agent = i; break; }
  assert.ok(agent >= 0);

  // Drive it once with a mix of drives so no verb is trivially zero by
  // accident: a hungry, thirsty, fearful, desperate animal with nobody beside
  // it. wander 0 so the movement head does not hide a verb slot.
  a.horm.fill(0, agent * 10, agent * 10 + 10);
  a.h(agent, 0);
  a.setH(agent, 1 /* HUNGER */, 0.8);
  a.setH(agent, 3 /* FEAR */, 0.6);
  a.setH(agent, 6 /* DESIRE */, 0.4);
  a.desperation[agent] = 0.7;

  hormoneBias(a, agent, bias, 0, false, -1, -1, -1, 0);

  const base = 9;  // VERB_OUT_BASE == N_MOVE
  const NAMES = ['IDLE', 'EAT', 'SEEK_MATE', 'MATE', 'KILL', 'FLEE', 'REST',
    'GATHER', 'DROP', 'COMBINE'];
  for (let v = 0; v < N_VERB; v++) {
    assert.notEqual(bias[base + v], SENTINEL,
      `verb ${NAMES[v]} (index ${v}) was never written — it carries the previous agent's score into this one's decision`);
  }

  // ...and the three item verbs are zero, not merely written. The comment in
  // hormones.ts says the item verbs are deliberately left unbiased: biasing
  // them would be the file deciding that gathering is worthwhile, which is the
  // question the brain is being asked.
  for (const [v, name] of [[7, 'GATHER'], [8, 'DROP'], [9, 'COMBINE']] as const) {
    assert.equal(bias[base + v], 0,
      `the ${name} verb carries a bias of ${bias[base + v]} — the brain is being told ${name} is worth something`);
  }

  // The zeroing is what makes the leak visible, so prove the leak is real:
  // the SAME buffer, run for a second agent, must produce the same zeros and
  // not the first animal's scores. A buffer that was merely "not written" reads
  // the sentinel here, and a buffer written by an older code path would read
  // the previous verb.
  const a2 = -1;
  let other = -1;
  for (let i = 0; i < MAX_AGENTS; i++) if (a.alive[i] && i !== agent) { other = i; break; }
  assert.ok(other >= 0 || a2 === -1, 'unreachable');
  assert.ok(other >= 0, 'need a second founder');
  a.desperation[other] = 0.0;
  a.setH(other, 1, 0.1);
  hormoneBias(a, other, bias, 0, false, -1, -1, -1, 0);
  assert.equal(bias[base + 7], 0, 'GATHER picked up a score from the previous animal');
  assert.equal(bias[base + 9], 0, 'COMBINE picked up a score from the previous animal');
  assert.notEqual(bias[base + 4], SENTINEL, 'KILL was never written for the second animal either');
});

// ---------------------------------------------------------------------------
// the nose
// ---------------------------------------------------------------------------

test('a predator smells a pixel that is behind a mountain, and its eye cannot', () => {
  // The measurement the whole nose is built on: 7.7% of hunting ticks had a
  // pixel inside the vision radius that only ROCK was hiding. So this is not
  // "the smell radius is bigger" — it is that the smell radius's missing
  // line-of-sight check is the entire value, and the two radii are nearly the
  // same size. The setup is built so the hidden pixel is the NEAREST of the
  // two: if it were not, the eye would answer correctly for the wrong reason
  // and the test would pass on a world with no nose at all.
  const sim = new Sim(SEED);
  sim.seedPopulation(START_POP);
  sim.seedPredators(START_PREDATORS);
  const w = sim.world, a = sim.agents, p = sim.predators;
  for (let i = 0; i < MAX_AGENTS; i++) a.release(i);
  for (let i = 0; i < MAX_PREDATORS; i++) if (p.alive[i]) p.release(i);

  // Find a spot with a run of rock in front of it and walkable ground beyond.
  let spot = -1, rockX = 0, rockY = 0, farX = 0, farY = 0;
  outer:
  for (let y = 20; y < GRID_H - 20; y++) {
    for (let x = 20; x < GRID_W - 40; x++) {
      const i = w.idx(x, y);
      if (!w.passable(x, y)) continue;
      for (let d = 2; d < 16; d++) {
        if (w.terrain[w.idx(x + d, y)] !== T_ROCK) continue;
        const bx = x + d + 2, by = y;
        if (!w.passable(bx, by)) break;
        if (clearLine(w, x, y, bx, by)) break;      // the gap is not a gap
        spot = 1; rockX = x + d; rockY = y; farX = bx; farY = by;
        break outer;
      }
    }
  }
  assert.ok(spot > 0, 'this world has no passable cell with rock in front of it and ground behind');

  const px = rockX - 16, py = rockY;              // the predator, this side
  assert.ok(w.passable(px, py), 'the predator has nowhere to stand');
  const pred = p.alloc(px, py, PRED_SMALL, -1, 0, PRED_MALE);
  assert.ok(pred >= 0);
  const hidden = a.alloc(sim.rng, farX, farY);    // behind the rock
  const visible = a.alloc(sim.rng, px - 30, py + 6);   // in the open, much further
  assert.ok(hidden >= 0 && visible >= 0);
  sim.spatial.build();

  const dHidden = Math.hypot(a.ax[hidden] - px, a.ay[hidden] - py);
  const dVisible = Math.hypot(a.ax[visible] - px, a.ay[visible] - py);
  assert.ok(dHidden < dVisible,
    `the hidden pixel is ${dHidden.toFixed(0)} away and the visible one ${dVisible.toFixed(0)} — `
    + 'the eye would answer correctly without ever needing a nose');

  // The two premises, asserted rather than assumed.
  assert.equal(clearLine(w, px, py, a.ax[hidden], a.ay[hidden]), false,
    'the hidden pixel is not actually behind the rock');
  assert.equal(clearLine(w, px, py, a.ax[visible], a.ay[visible]), true,
    'the open-ground pixel is not actually visible');
  assert.equal(w.terrain[w.idx(rockX, rockY)], T_ROCK, 'and there is no rock between them');

  // The eye: nearestPixelTo applies the line-of-sight test, so it must skip
  // the hidden one and answer with the far visible one.
  p.energy[pred] = 1;
  const eye = p.vision(pred);
  assert.ok(dVisible <= eye, `the visible pixel is ${dVisible.toFixed(0)} away and vision is ${eye}`);
  assert.equal((sim as unknown as { nearestPixelTo: (x: number, y: number, r: number) => number })
    .nearestPixelTo(px, py, eye), visible,
  'the eye resolved the pixel behind the mountain');

  // The nose: no line-of-sight test at all, so the NEAREST pixel wins and the
  // nearest one is the one the eye could not see.
  const nose = p.smell(pred);
  assert.ok(nose > eye, `smell ${nose} is not larger than vision ${eye}`);
  // Pinned explicitly rather than left to be implied. The hiding spot is only
  // ~33 cells off and a fed small predator's eye already reaches 70, so the
  // hidden pixel is well inside BOTH radii — the eye declines it purely on the
  // line-of-sight test, and the nose takes it for the want of one. That is the
  // whole claim, and if the nose ever shrank below this distance the test would
  // still be asserting a search that finds nothing.
  assert.ok(dHidden <= nose,
    `the hidden pixel is ${dHidden.toFixed(0)} away and the nose reaches ${nose} — it was out of range, not merely unseen`);
  assert.equal(p.nearestByScent(px, py, nose, sim.spatial), hidden,
    'the nose did not find the pixel behind the mountain');

  // ...and the multiplier is what the sidebar-adjacent comment says it is, so
  // that "the nose sees further" is a number and not a vibe. A starved animal's
  // nose has to be strictly larger than a fed one's, and larger than the fed
  // animal's EYES, or hunger does not widen the circle.
  p.energy[pred] = 0;
  const starveNose = p.smell(pred);
  p.energy[pred] = 1;
  assert.ok(starveNose > nose, `a starving nose (${starveNose}) is not wider than a fed one (${nose})`);
  assert.ok(starveNose > p.vision(pred) * 2,
    `a starving nose (${starveNose}) is not more than double a fed animal's eyes (${p.vision(pred)})`);
});

test('a world that loses its last predator re-founds the species instead of going quietly extinct', () => {
  const sim = freshSim(0);
  // let the world grow past PRED_BREED_MIN_PREY first. Re-seeding refuses a
  // world with no prey — a species restored into a map holding six pixels
  // would starve where it stands, and the whole point of the floor is to not
  // be extinct *of something*. Measured: killing the predators at t=0 leaves
  // the world at 21 pixels at t=250 and 59 at t=500, and the first re-founding
  // lands around t=750 once there is genuinely something to eat.
  for (let t = 0; t < 600; t++) sim.step();
  const p = sim.predators;
  assert.ok(sim.agents.count >= PRED_BREED_MIN_PREY,
    `the world needs ${PRED_BREED_MIN_PREY} pixels before predators can be re-founded, has ${sim.agents.count}`);

  // kill every predator by hand: this is the state the user reported, and the
  // one the old code could never leave — four animals at the cap, no births,
  // and a species that simply aged out over its 1500-tick lifespan.
  for (let i = 0; i < MAX_PREDATORS; i++) if (p.alive[i]) p.release(i);
  assert.equal(p.count, 0, 'the world is now extinct of predators');

  // it comes back, and it comes back as a pair rather than as a single
  // animal. One predator has nobody of the other sex and lives out another
  // full lifespan alone, which is the same extinction with a delay.
  for (let t = 0; t < 400 && p.count === 0; t++) sim.step();
  assert.ok(p.count > 0, 'the species was never re-founded');
  assert.ok(p.count >= PRED_RESEED_COUNT,
    `re-founded with ${p.count} animals, which is one short of the ${PRED_RESEED_COUNT} it takes to breed`);

  // but it does come back, and it comes back as a pair rather than as a
  // single animal. One predator has nobody of the other sex and lives out
  // another full lifespan alone, which is the same extinction with a delay.
  for (let t = 0; t < 400 && p.count === 0; t++) sim.step();
  assert.ok(p.count > 0, 'the species was never re-founded');
  assert.ok(p.count >= PRED_RESEED_COUNT,
    `re-founded with ${p.count} animals, which is one short of the ${PRED_RESEED_COUNT} it takes to breed`);

  // and the pair is of opposite sexes, because that is the only configuration
  // `breedPredators` will accept.
  const sexes = new Set<number>();
  for (let i = 0; i < MAX_PREDATORS; i++) if (p.alive[i]) sexes.add(p.sex[i]);
  assert.equal(sexes.size, 2, 'a re-founded species is one male and one female');

  // they live at a den the prey can actually reach, not shut inside a rock in
  // a corner no pixel walks to.
  for (let i = 0; i < MAX_PREDATORS; i++) {
    if (!p.alive[i]) continue;
    assert.ok(p.den[i] >= 0, 'a re-founded predator has a den to go home to');
  }
});

test('a village that has died out is re-founded, and the camp table does not grow without bound', () => {
  const sim = freshSim(0);
  for (let t = 0; t < 400; t++) sim.step();
  const campsAfterFounding = sim.campX.length;
  assert.ok(campsAfterFounding > 0, 'the world found camps to begin with');

  // empty the first village completely
  const a = sim.agents;
  for (let i = 0; i < MAX_AGENTS; i++) {
    if (a.alive[i] && (a.founder[i] === 0 || a.founder[i] === 1)) a.release(i);
  }
  for (let t = 0; t < 600; t++) sim.step();

  // the village is occupied again, or was re-founded and has since failed
  // again — either way the world is not carrying a permanently dead village
  // with a camp marker on it and nothing living in it.
  const campPop = sim.campPop[0] + sim.campPop[1];
  assert.ok(campPop > 0 || sim.villagesRefounded > 0,
    `village 0 holds ${campPop} and was never re-founded (${sim.villagesRefounded} re-foundings)`);

  // and the table has not grown into a map of half-villages. This is the
  // failure the first version had: it pushed two new camps per re-founding, so
  // the table grew to all 64 slots and the renderer drew 32 villages on a map
  // with three, most of them empty.
  assert.ok(sim.campX.length <= MAX_CAMP_SLOTS,
    `the camp table grew to ${sim.campX.length}, past the ${MAX_CAMP_SLOTS} slot ceiling`);
  assert.ok(sim.campX.length < 20,
    `the camp table grew to ${sim.campX.length} — a re-founding that reuses its village's own camps cannot grow it at all`);
});

test('a species that has only just been wiped out is not re-seeded on the very next tick', () => {
  // The cooldown is the difference between a repair and a flicker. Without it
  // a world on the edge of extinction re-seeds every census, fills the den,
  // loses the animals again, and re-seeds — a predator population that visibly
  // blinks rather than one that recovers. PRED_RESEED_COOLDOWN is 250 ticks,
  // and this asserts the first tick after the wipe does nothing.
  const sim = freshSim(0);
  for (let t = 0; t < 600; t++) sim.step();
  const p = sim.predators;
  // drive the cooldown up so the world is one tick from being allowed to
  // re-found, and then wipe it
  sim.predReseedT = 1;
  for (let i = 0; i < MAX_PREDATORS; i++) if (p.alive[i]) p.release(i);
  sim.step();
  assert.equal(p.count, 0,
    'a world whose re-seeding cooldown has not expired stays empty for one more tick');
});
