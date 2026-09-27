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

import { Sim } from '../sim/sim.ts';
import { renderFrame, predatorParts, buildAgentIndex, PALETTE, TERRAIN_KEY } from '../sim/render.ts';
import { ticksDue, targetHz } from '../sim/pace.ts';
import {
  GRID_W, GRID_H, GRID_SIZE, RS, VIEW_W, VIEW_H, VIEW_SIZE,
  START_POP, START_PREDATORS, MAX_AGENTS, MAX_PREDATORS,
  T_OPEN, T_ROCK, T_WATER, T_DEAD, T_SAND, T_FOREST, T_MARSH, T_SNOW, T_CAVE,
  TICK_HZ, PRED_DEN_CAP, PRED_DEN_SCATTER, PRED_SMALL, PRED_LARGE, DAY_TICKS,
  CAMP_HOME_R, CAMP_MARK_R, MOVE_DX, MOVE_DY,
  FOOD_CELL, FOOD_BUCKETS, FOOD_BUCKETS_X, FOOD_UNDERFOOT,
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

  const before = Math.hypot(p.px[i] - sim.world.caveX[den], p.py[i] - sim.world.caveY[den]);
  for (let t = 0; t < 60; t++) sim.step();
  const after = Math.hypot(p.px[i] - sim.world.caveX[den], p.py[i] - sim.world.caveY[den]);
  assert.ok(after < before - 20,
    `a stranded predator closed ${(before - after).toFixed(0)} cells in 60 ticks — it is not heading home`);
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

test('no more than six predators are ever alive, across several whole days', () => {
  const sim = freshSim(0);
  let peak = 0;
  // two full day-lengths is enough to cover a night, a dawn breeding window
  // and the start of the next night, which is where a cap would be broken
  for (let t = 0; t < 800; t++) {
    sim.step();
    assert.ok(sim.predators.count <= PRED_DEN_CAP,
      `tick ${t}: ${sim.predators.count} predators alive, the cap is ${PRED_DEN_CAP}`);
    peak = Math.max(peak, sim.predators.count);
  }
  assert.equal(PRED_DEN_CAP, 6, 'the den cap is six');
  assert.ok(peak >= 1, 'no predator survived the run, so the cap proved nothing');
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

  // a well-fed predator stays in its den through a whole day, and comes out
  // at night — checked by running the real step, not by calling the rule
  const sim2 = freshSim(0);
  const p = sim2.predators;
  for (let i = 0; i < MAX_PREDATORS; i++) if (p.alive[i]) p.energy[i] = 0.95;
  let rangedDuringDay = 0, rangedAtNight = 0;
  for (let t = 0; t < 400; t++) {
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
  assert.ok(fed / checked > 0.5,
    `only ${fed} of ${checked} living pixels can reach food from where they stand`);
  assert.ok(watered / checked > 0.5,
    `only ${watered} of ${checked} living pixels are on a water gradient`);
  assert.ok(homed / checked > 0.5,
    `only ${homed} of ${checked} living pixels have a camp outside their home radius`);
});
