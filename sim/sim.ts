import {
  MAX_AGENTS, N_PARAMS, N_INPUTS, N_HIDDEN, N_OUTPUTS, N_MOVE, Verb, VERB_OUT_BASE,
  SOFT_CAP, HARD_CAP, T_ROCK, T_WATER,
  LEARNING_RATE, EPSILON_START, EPSILON_END, EPSILON_DECAY_TICKS,
  MOVE_ENERGY_COST, BASE_METABOLISM, WATER_MULTIPLIER,
  MATE_RADIUS, SENSE_R, SEEK_R, SEEK_EVERY, BOND_RADIUS, BOND_LOYALTY, KILL_RADIUS, KILL_COOLDOWN, CARCASS_NUTRITION, PLANT_NUTRITION, NAUSEA_TICKS,
  THIRST_RATE, DRINK_RELIEF, DEHYDRATION_DAMAGE, DRINK_RADIUS, N_VERB,
  MOVE_DX, MOVE_DY, FOUNDER_SPREAD, CAMP_SPREAD, PRED_DEN_SCATTER,
  NEWBORN_ENERGY, NEWBORN_THIRST, BIRTH_SPREAD, FOOD_UNDERFOOT,
  MAX_PREDATORS, PRED_LARGE, PRED_SMALL, PRED_MALE, PRED_FEMALE,
  PRED_ENERGY_CAP, PRED_HUNGER_RATE,
  PRED_SOFT_CAP, PRED_SEX_CAP, PRED_BREED_ENERGY, GRID_W, GRID_H,
  PRED_BREED_CHANCE, PRED_BREED_COOLDOWN, PRED_EAT_GAIN, PRED_DEN_BREED_R,
  PRED_SEARCH_EVERY, PRED_DEN_ENERGY, PRED_ATTACK_ENERGY, PRED_HUNT_LEASH,
  PRED_MATE_R, PRED_MATE_BOND_R, PRED_DEN_CROWDING, PRED_BREED_MIN_PREY,
  MOBS_TO_KILL_LARGE, MOBS_TO_KILL_SMALL, MOBS_RADIUS, MOB_DAMAGE, MOB_REWARD,
  MEAT_PER_KILL, MEAT_NUTRITION, MEAT_DOPAMINE, H,
} from './constants.ts';
import { RNG } from './rng.ts';
import { World, type DeathCause, moveIndexOf } from './world.ts';
import { Agents } from './agents.ts';
import { SpatialIndex } from './spatial.ts';
import { Predators } from './predators.ts';
import { buildInputs } from './sensors.ts';
import {
  initBrain, forward, softmaxValue, tdGrad, applyRmsprop, inheritBrain,
  BrainScratch, BrainHistory,
} from './brain.ts';
import { crossover, GENE } from './genome.ts';
import {
  updateHormones, hormoneBias, homePull, fertilityAge, maxAgeFor, clamp01,
} from './hormones.ts';
import { N_GENES } from './constants.ts';

/**
 * Slide priority for each of the nine headings: the intended cell first, then
 * the two headings that share most of it, then the diagonals, then the
 * reverse. Built from the movement grid once rather than written out nine
 * times, so it cannot drift out of step with MOVE_DX/MOVE_DY.
 */
const SLIDE_ORDER: number[][] = MOVE_DX.map((dx, k) => {
  const dy = MOVE_DY[k];
  const rest: { k: number; dot: number }[] = [];
  for (let j = 0; j < N_MOVE; j++) {
    if (j === k) continue;
    rest.push({ k: j, dot: MOVE_DX[j] * dx + MOVE_DY[j] * dy });
  }
  rest.sort((p, q) => q.dot - p.dot);
  return [k, ...rest.map((r) => r.k)];
});

export type SimStats = {
  tick: number; pop: number; food: number; season: string;
  meanAge: number; meanEnergy: number;
};

/** What killed a pixel. Marked on the agent, tallied once in reap(). */
export const CAUSE = {
  NONE: 0, STARVATION: 1, DEHYDRATION: 2, AGE: 3, CROWDING: 4, KILLED: 5,
} as const;

/** Newborn survival as a function of how crowded the world already is. */
export function newbornSurvival(pop: number): number {
  if (pop >= HARD_CAP) return 0;
  if (pop <= SOFT_CAP) return 1;
  return 1 - (pop - SOFT_CAP) / (HARD_CAP - SOFT_CAP);
}

export class Sim {
  world: World;
  agents = new Agents();
  predators = new Predators();
  brains = new Float32Array(MAX_AGENTS * N_PARAMS);
  rms = new Float32Array(MAX_AGENTS * N_PARAMS);
  hist = new BrainHistory();
  scratch = new BrainScratch();
  spatial: SpatialIndex;
  rng: RNG;

  tick = 0;
  generation = 0;
  epsilon = EPSILON_START;

  private bias = new Float32Array(N_OUTPUTS);
  private pendingReward = new Float32Array(MAX_AGENTS);
  private nearest = new Int32Array(MAX_AGENTS);
  private nearestDist = new Float32Array(MAX_AGENTS);
  private adjacentMate = new Int32Array(MAX_AGENTS);
  private loveTarget = new Int32Array(MAX_AGENTS);
  private sawSomeone = new Uint8Array(MAX_AGENTS);
  private breedCooldown = new Int32Array(MAX_AGENTS);

  /** Where the founding pixels were born. The opening predators spawn in the
   *  dens nearest this spot, so the world opens with prey in one valley and
   *  predators in the rock above it, rather than with both species sharing
   *  twenty-six cells. */
  founderX = GRID_CX;
  founderY = GRID_CY;

  /** Every camp in the world, one entry per founding lineage, copied out of
   *  the agents when they are seeded and never changing. A camp outlives
   *  everyone who started it, which is the point: it is a place, and the
   *  thing that pulls a scattered population back together after a hard few
   *  hundred ticks. The renderer draws them and the predators hunt toward
   *  them, so this is the one piece of world state both species read. */
  campX: number[] = [];
  campY: number[] = [];

  births = 0;
  deaths: Record<DeathCause, number> = {
    starvation: 0, dehydration: 0, age: 0, crowding: 0, killed: 0,
  };
  private lifespanSum = 0;
  private deathCount = 0;
  betraysals = 0;
  /** age of the most recent death, for harness diagnostics */
  lastDeathAge = 0;
  /** ages of natural deaths (starvation/age), excluding instant crowding deaths */
  naturalDeathAges: number[] = [];
  kills = 0;

  history: SimStats[] = [];
  private historyEvery = 50;

  public seed: number;

  constructor(seed: number) {
    this.seed = seed;
    this.world = new World(seed);
    this.rng = new RNG(seed ^ 0x9e3779b9);
    this.spatial = new SpatialIndex(this.agents.alive, this.agents.ax, this.agents.ay);
  }

  get meanLifespan(): number {
    return this.deathCount ? this.lifespanSum / this.deathCount : 0;
  }

  seedPopulation(n: number): void {
    // The founding generation is born together, not scattered.
    //
    // Six pixels dropped at random across a 92k-cell map have a 79% chance of
    // having nobody within partner range, and a lineage that cannot find a
    // mate is not a lineage — the run just quietly starves out. So we pick
    // one founding spot and the whole starting cast is born within a couple
    // of cells of it. Everything after this is up to them.
    //
    // What they are also given is a camp: one site per founder, spread over a
    // few cells around the founding spot, inherited by everything that
    // founder goes on to have. It is the pixel's answer to a predator's den,
    // and it is what stops a world of six from being six separate searches
    // for a partner on a map with room for 286,000 pixels.
    const [cx, cy] = this.world.findHabitable(this.rng);
    this.founderX = cx; this.founderY = cy;
    for (let k = 0; k < n; k++) {
      let x = cx, y = cy;
      for (let t = 0; t < 64; t++) {
        const nx = cx + this.rng.int(FOUNDER_SPREAD * 2 + 1) - FOUNDER_SPREAD;
        const ny = cy + this.rng.int(FOUNDER_SPREAD * 2 + 1) - FOUNDER_SPREAD;
        if (this.world.passable(nx, ny)) { x = nx; y = ny; break; }
      }
      const i = this.agents.alloc(this.rng, x, y);
      if (i < 0) break;
      initBrain(this.brains, i * N_PARAMS, this.rng);
      this.agents.bornTick[i] = 0;
      const [campX, campY] = this.findCampSite(cx, cy, k, n);
      this.agents.campX[i] = campX;
      this.agents.campY[i] = campY;
      this.campX.push(campX);
      this.campY.push(campY);
    }
  }

  /**
   * Walking-ish distance to the nearest camp, or Infinity if the world has
   * none. The radius a predator is allowed to range out to is the larger of
   * this and its leash, which is the whole of the rule that a den's
   * territory has to contain something.
   */
  campDistance(x: number, y: number): number {
    let best = Infinity;
    for (let k = 0; k < this.campX.length; k++) {
      const d = Math.abs(this.campX[k] - x) + Math.abs(this.campY[k] - y);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * The index of the camp nearest a point, or -1 if this world has none.
   * With six camps on the map a straight scan is cheaper than any index, and
   * it is the only question a predator asks about the rest of the world.
   */
  nearestCampTo(x: number, y: number): number {
    let best = -1, bestD = Infinity;
    for (let k = 0; k < this.campX.length; k++) {
      const d = Math.abs(this.campX[k] - x) + Math.abs(this.campY[k] - y);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  /**
   * A walkable founding site for one lineage's camp, spread around the
   * founding spot so the village has distinct corners rather than one point.
   * Falls back to the founding spot itself, which is walkable by construction.
   */
  private findCampSite(cx: number, cy: number, k: number, n: number): [number, number] {
    const a = (k / Math.max(1, n)) * Math.PI * 2;
    for (let r = CAMP_SPREAD; r > 0; r -= 1) {
      const nx = Math.round(cx + Math.cos(a) * r);
      const ny = Math.round(cy + Math.sin(a) * r);
      if (this.world.passable(nx, ny)) return [nx, ny];
    }
    return [cx, cy];
  }

  /**
   * Where a newborn is born: between its parents, a cell or three of them.
   *
   * This is the most load-bearing line in the whole population. Birth used
   * to call `randomSpot`, which is uniform over the whole 640x448 map — so
   * the average child appeared about two hundred cells from its parents, in
   * country it had never seen, alone, outside the reach of the juvenile pull,
   * and with nobody inside `SEEK_R` to mate with for the first two hundred
   * ticks of its life. Everything the population did followed from that. Two
   * seeds in ten never got past thirty animals and then aged out, ending
   * generation four with a hundred thousand nutrition units of grass going
   * uneaten two hundred cells away, and the reason was where the children
   * were born rather than anything they did.
   *
   * Its parents is the right answer to the question, and it happens to be the
   * right answer to the arithmetic too: the juvenile pull keeps a population
   * inside its village, measured now at a mean of fifteen to thirty cells
   * from the camp, so where the parents are standing *is* where the adults
   * are, where the opening reserve was laid down, and where the cohort is.
   * The camp is the fallback for a parent standing somewhere the map will not
   * give up a dry tile for — the far bank of a river, a rock shelf — and
   * anywhere walkable is the fallback for that.
   */
  private birthSpot(p1: number, p2: number): [number, number] {
    const a = this.agents, w = this.world;
    const ok = (px: number, py: number): boolean => {
      if (!w.inBounds(px, py) || !w.passable(px, py)) return false;
      return w.terrain[w.idx(px, py)] !== T_WATER;
    };
    // with food underfoot where possible: a child born on bare rock spends
    // its first hundred ticks walking to a meal it could have started on
    const fed = (px: number, py: number): boolean =>
      ok(px, py) && w.foodAt(w.idx(px, py)) > FOOD_UNDERFOOT;
    // between the two of them, which is where a child is born
    const midX = Math.round((a.ax[p1] + a.ax[p2]) / 2);
    const midY = Math.round((a.ay[p1] + a.ay[p2]) / 2);
    let spot = a.nearSpot(this.rng, midX, midY, BIRTH_SPREAD, fed)
      ?? a.nearSpot(this.rng, midX, midY, BIRTH_SPREAD, ok);
    for (const p of [p1, p2]) {
      if (spot) break;
      spot = a.nearSpot(this.rng, a.ax[p], a.ay[p], BIRTH_SPREAD, ok);
    }
    // a parent standing somewhere the map refuses to give up a tile for —
    // the far bank of a river, the middle of a rock shelf — is a real case,
    // and then the lineage's camp is the nearest place with ground under it
    if (!spot) {
      const f = a.founder[p1];
      spot = a.nearSpot(this.rng, a.campX[f], a.campY[f], BIRTH_SPREAD, ok);
    }
    if (spot) return [spot[0], spot[1]];
    const any = a.randomSpot(this.rng, a.ax[p1], a.ay[p1], (px, py) => w.passable(px, py));
    return [any[0], any[1]];
  }

  step(): void {
    this.world.step();
    this.spatial.build();
    this.tick++;
    this.epsilon = Math.max(EPSILON_END,
      EPSILON_START * (1 - this.tick / EPSILON_DECAY_TICKS));

    this.sense();
    this.thinkAndAct();
    this.physiology();
    this.reproduce();
    this.huntPredators();
    this.resolveMobs();
    this.breedPredators();
    this.reap();
    this.record();
  }

  // --- perception ----------------------------------------------------------
  private dist(i: number, j: number): number {
    return Math.hypot(this.agents.ax[i] - this.agents.ax[j], this.agents.ay[i] - this.agents.ay[j]);
  }

  /** Long-range, eligible-partner search. Expensive, so run it sparingly. */
  private findPartner(i: number): number {
    const a = this.agents;
    const fert = fertilityAge(a.genes, i);
    let best = -1, bestScore = -Infinity;
    this.spatial.forEachNear(a.ax[i], a.ay[i], SEEK_R, (j, ox, oy) => {
      if (j === i || !a.alive[j]) return;
      const d = Math.sqrt(ox * ox + oy * oy);
      if (d > SEEK_R || d < 0.01) return;
      if (a.sex[j] === a.sex[i]) return;
      if (a.age[j] <= fert) return;
      if (a.mate[j] >= 0 && a.mate[j] !== i) return; // already bonded elsewhere
      // prefer someone close, healthy, and similarly desperate to breed
      const score = 20 - d * 0.4 + a.h(j, 6 /* DESIRE */) * 3 + a.energy[j];
      if (score > bestScore) { bestScore = score; best = j; }
    });
    return best;
  }

  private sense(): void {
    this.sawSomeone.fill(0);
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (!this.agents.alive[i]) continue;
      const a = this.agents;
      const x = a.ax[i], y = a.ay[i];

      // cheap pass: who is near, for fear/flee/agent-rays
      let best = 99, bestIdx = -1;
      this.spatial.forEachNear(x, y, SENSE_R, (j, ox, oy) => {
        if (j === i || !a.alive[j]) return;
        const d = Math.sqrt(ox * ox + oy * oy);
        if (d > SENSE_R) return;
        this.sawSomeone[i] = 1;
        if (d < best) { best = d; bestIdx = j; }
      });
      this.nearest[i] = bestIdx;
      this.nearestDist[i] = best;

      // sticky partner-of-interest; refreshed lazily
      const t = this.loveTarget[i];
      const tOk = t >= 0 && a.alive[t] && this.dist(i, t) < SEEK_R * 2 &&
        !(a.mate[t] >= 0 && a.mate[t] !== i);
      if (!tOk) this.loveTarget[i] = this.findPartner(i);

      const lt = this.loveTarget[i];
      this.adjacentMate[i] = (lt >= 0 && this.dist(i, lt) <= BOND_RADIUS) ? lt : -1;
    }
    // stagger the long search so it never all lands on the same tick
    if (this.tick % SEEK_EVERY === 0) {
      for (let i = 0; i < MAX_AGENTS; i++) {
        if (!this.agents.alive[i]) continue;
        // commit: only re-search if the target died or bonded to someone else
        const t = this.loveTarget[i];
        if (t < 0 || !this.agents.alive[t] ||
            (this.agents.mate[t] >= 0 && this.agents.mate[t] !== i)) {
          this.loveTarget[i] = this.findPartner(i);
        }
      }
    }
  }

  // --- decision + action ---------------------------------------------------
  private thinkAndAct(): void {
    const a = this.agents, w = this.world;
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (!a.alive[i]) continue;
      const x = this.scratch.inputs;
      const maxAge = maxAgeFor(a.genes, i);

      buildInputs(a, w, this.spatial, this.predators, i, maxAge, x);
      forward(this.brains, i * N_PARAMS, x, this.scratch.hidden, this.scratch.outputs);
      const v = this.scratch.outputs;
      const vCur = softmaxValue(v);

      // learn from the reward the previous action earned
      if (this.hist.hasPrev[i]) {
        const delta = tdGrad(
          this.brains, i * N_PARAMS, this.scratch.grad, this.scratch.dz, this.scratch.dh,
          this.hist.inputs.subarray(i * N_INPUTS, (i + 1) * N_INPUTS),
          this.hist.hidden.subarray(i * N_HIDDEN, (i + 1) * N_HIDDEN),
          this.hist.outputs.subarray(i * N_OUTPUTS, (i + 1) * N_OUTPUTS),
          this.hist.value[i], vCur, this.pendingReward[i],
        );
        applyRmsprop(this.brains, i * N_PARAMS, this.rms, this.scratch.grad, delta);
      }
      this.hist.save(i, x, this.scratch.hidden, v, vCur);

      const wander = this.rng.range(-0.4, 0.4) + a.g(i, GENE.CURIOSITY) * 0.3;
      // the three survival headings, each skipped entirely when the pixel has
      // no reason to want it — a fed, unhorned, unlonely adult with a full
      // life of its own does none of this work
      const pull = homePull(a, i);
      hormoneBias(a, i, this.bias, wander, this.adjacentMate[i] >= 0,
        w.waterStep(a.ax[i], a.ay[i]),
        w.foodStep(a.ax[i], a.ay[i]),
        pull > 0.25 ? w.campStep(a.ax[i], a.ay[i], a.campX[a.founder[i]], a.campY[a.founder[i]]) : -1,
        pull);

      let bestMove: number = 4, bestMoveScore = -Infinity;
      for (let k = 0; k < N_MOVE; k++) {
        const sc = v[k] + this.bias[k] + (this.rng.chance(this.epsilon) ? this.rng.range(-2, 2) : 0);
        if (sc > bestMoveScore) { bestMoveScore = sc; bestMove = k; }
      }
      let bestVerb: number = Verb.IDLE, bestVerbScore = -Infinity;
      for (let k = 0; k < N_VERB; k++) {
        const sc = v[VERB_OUT_BASE + k] + this.bias[VERB_OUT_BASE + k] +
          (this.rng.chance(this.epsilon) ? this.rng.range(-2, 2) : 0);
        if (sc > bestVerbScore) { bestVerbScore = sc; bestVerb = k; }
      }

      let reward = 0;

      // --- locomotion, first ---------------------------------------------
      // The movement head chooses a heading, and that heading is what the
      // pixel walks unless the verb says otherwise. It used to be honoured
      // only by IDLE, with every other verb either walking somewhere of its
      // own choosing or standing still — so nine movement outputs, three
      // survival gradients leaning on them, and a world in which the whole lot
      // was computed and then thrown away. IDLE's logit is pinned at zero, so
      // it almost never won: measured over a live population, one pixel in
      // twenty-three was walking the direction it had chosen, and a camp pull
      // strong enough to win the argmax every single time still left the
      // village with nobody in it.
      switch (bestVerb) {
        case Verb.REST: {
          reward += 0.15;
          a.energy[i] = Math.min(1, a.energy[i] + 0.006);
          break;
        }
        case Verb.FLEE: {
          const j = this.nearest[i];
          if (j >= 0) {
            const dx = Math.sign(a.ax[i] - a.ax[j]);
            const dy = Math.sign(a.ay[i] - a.ay[j]);
            if (this.tryMove(i, dx, dy)) reward -= 0.10;
          }
          break;
        }
        case Verb.SEEK_MATE: {
          // a chosen partner overrides the heading — walking away from the
          // person you crossed the map for would be absurd
          const j = this.loveTarget[i] >= 0 ? this.loveTarget[i] : this.nearest[i];
          let went = false;
          if (j >= 0) {
            const dx = Math.sign(a.ax[j] - a.ax[i]);
            const dy = Math.sign(a.ay[j] - a.ay[i]);
            if (dx !== 0 || dy !== 0) went = this.tryMove(i, dx, dy);
          }
          if (!went && this.walk(i, bestMove)) reward -= 0.04;
          break;
        }
        default: {
          if (this.walk(i, bestMove)) reward -= 0.04;
          break;
        }
      }

      // --- what it does where it ended up ---------------------------------
      // Second, so EAT means "eat what you walked onto" and MATE means "court
      // the one you just bumped into". Acting before moving made a hungry
      // pixel on bare ground choose between eating nothing and not walking.
      switch (bestVerb) {
        case Verb.MATE: {
          const j = this.adjacentMate[i];
          if (j >= 0) {
            const before = a.bond[i];
            this.court(i, j);
            // Paid for the bond getting *stronger*, not for standing next to
            // someone: that is something a pixel does whether or not it means
            // anything, and at a flat 0.5 a tick it is a reward with no end
            // on it.
            reward += 0.1 + 0.5 * (a.bond[i] - before);
          }
          break;
        }
        case Verb.KILL: {
          const t = this.findVictim(i);
          if (t >= 0) {
            this.kill(i, t);
            a.killT[i] = KILL_COOLDOWN;
            // paid in proportion to how little there was left to lose, so the
            // lesson learned is "murder is what a starving animal does" and
            // not "murder is the highest-value action available"
            reward += 0.2 + 0.3 * a.desperation[i];
          }
          else reward -= 0.2;
          break;
        }
        case Verb.EAT: {
          reward += this.eat(i);
          break;
        }
      }

      // hunger and thirst are aversive even when you do nothing about them
      reward -= 0.35 * a.h(i, 1 /* HUNGER */);
      reward -= 0.35 * a.thirst[i];
      this.pendingReward[i] = reward;
    }
  }

  /**
   * Walk one cell in a direction, sliding along whatever is in the way.
   *
   * The slide is what keeps a heading from being a suggestion. A pixel that
   * has been leaning hard toward the river since it was born still meets rock
   * on the way, and a step that simply fails there cancels the whole
   * gradient for as long as the wall is between it and the water — which is
   * how a world with a river in it still starves out next to the river. So a
   * blocked step tries the two headings that share most of the intended one,
   * then the reverse. Returns the heading actually taken, for the renderer.
   */
  private slide(x: number, y: number, dx: number, dy: number): [number, number, number] {
    const w = this.world;
    if (dx === 0 && dy === 0) return [x, y, 0];
    const tries = SLIDE_ORDER[moveIndexOf(dx, dy)];
    for (let k = 0; k < tries.length; k++) {
      const s = tries[k];
      if (s === 4) continue;
      const nx = x + MOVE_DX[s], ny = y + MOVE_DY[s];
      if (!w.inBounds(nx, ny) || w.terrain[w.idx(nx, ny)] === T_ROCK) continue;
      return [nx, ny, s];
    }
    return [x, y, 0];
  }

  /** Walk the movement head's chosen cell. Index 4 is standing still. */
  private walk(i: number, move: number): boolean {
    if (move === 4) return false;
    return this.tryMove(i, MOVE_DX[move], MOVE_DY[move]);
  }

  private tryMove(i: number, dx: number, dy: number): boolean {
    if (dx === 0 && dy === 0) return false;
    const a = this.agents;
    const x = a.ax[i], y = a.ay[i];
    const [nx, ny] = this.slide(x, y, dx, dy);
    if (nx === x && ny === y) return false;
    a.ax[i] = nx; a.ay[i] = ny;
    const w = this.world;
    const wet = w.terrain[w.idx(nx, ny)] === T_WATER ? WATER_MULTIPLIER : 1;
    a.energy[i] -= MOVE_ENERGY_COST * (0.4 + a.g(i, GENE.MOVE_COST)) * wet;
    return true;
  }

  /**
   * Eat whatever is underfoot. Meat is checked first and taken first: it
   * clears hunger outright and spikes dopamine, so a pixel that has learned
   * where predators kill has a reason to walk toward the killing ground.
   * Grass is a calorie; meat is a reward.
   */
  private eat(i: number): number {
    const a = this.agents, w = this.world;
    const x = a.ax[i], y = a.ay[i];

    // --- meat first, and unlike anything else it fills you completely ---
    // Take only as much as the gap, but never walk past a full meal: the point
    // of meat is that it clears all hunger in one go, not that it is a
    // slightly better mouthful of grass. The first version took a flat 0.5
    // off the tile, so a pixel at 20% energy still finished at 70% hungry.
    const gap = 1 - a.energy[i];
    let meat = 0;
    if (gap > 0.001) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (Math.abs(ox) + Math.abs(oy) > 1) continue;
          const kx = x + ox, ky = y + oy;
          if (!w.inBounds(kx, ky)) continue;
          meat += w.takeMeat(w.idx(kx, ky), gap - meat);
        }
      }
    }
    if (meat > 0) {
      a.energy[i] = Math.min(1, a.energy[i] + meat * MEAT_NUTRITION);
      // straight to the top, not a quarter of the way: this is the one thing
      // in the world that is meant to feel good, and a quarter-dose spike that
      // then only decays never reads as a reward at all.
      a.setH(i, H.DOPAMINE, MEAT_DOPAMINE);
      a.horm[i * 10 + H.DOPAMINE] = MEAT_DOPAMINE;
      return 1.0 + meat * 4.0; // a real meal, and worth a lot of reward
    }

    let gained = 0, fromCarcass = false;
    // Never strip more off a tile than the gap it would actually fill. The
    // take used to be a flat `0.25 + hunger*0.5` per cell across the whole
    // four-cell cross, so a pixel at 70% energy could pull 1.6 units of
    // grass off the map to gain 0.3 — four fifths of the meal destroyed and
    // thrown away. Scarcity is meant to be a pressure, not a tax.
    const room = 1 - a.energy[i];
    const take0 = Math.min(0.25 + a.h(i, H.HUNGER) * 0.5, room);
    if (take0 > 0) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (Math.abs(ox) + Math.abs(oy) > 1) continue;
          const kx = x + ox, ky = y + oy;
          if (!w.inBounds(kx, ky)) continue;
          const idx = w.idx(kx, ky);
          const want = take0;
          if (w.plant[idx] > 0.02) {
            const take = Math.min(w.plant[idx], want);
            w.plant[idx] -= take;
            w.plantTimer[idx] = 0;
            gained += take * PLANT_NUTRITION;
          } else if (w.carcass[idx] > 0.02) {
            const take = Math.min(w.carcass[idx], want);
            w.carcass[idx] -= take;
            gained += take * CARCASS_NUTRITION;
            fromCarcass = true;
          }
        }
      }
    }
    if (gained <= 0) return -0.05;
    a.energy[i] = Math.min(1, a.energy[i] + gained);
    if (fromCarcass) {
      // "doesn't taste good" — it fills you, but it turns your stomach
      a.nausea[i] = Math.min(1, a.nausea[i] + 0.5);
      a.nauseaT[i] = NAUSEA_TICKS;
    }
    return 1.5 * gained;
  }

  private findVictim(i: number): number {
    const a = this.agents;
    if (a.killT[i] > 0) return -1;
    let best = -1, bestScore = -Infinity;
    this.spatial.forEachNear(a.ax[i], a.ay[i], KILL_RADIUS * 2, (j, ox, oy) => {
      if (j === i || !a.alive[j]) return;
      const d = Math.sqrt(ox * ox + oy * oy);
      if (d > KILL_RADIUS || d < 0.01) return;
      // The target has to actually be the weaker animal. Proximity alone made
      // this a free execution of whoever happened to be standing there, and in
      // a village somebody always is — so a murder meant the death of a
      // healthy adult, a juvenile, anything. Desperation has to select for
      // the weak, or it is not selecting at all.
      if (a.energy[j] >= a.energy[i] && a.health[j] >= a.health[i]) return;
      // the weaker, the hungrier, the more desirable
      const score = (1 - a.energy[j]) * 2 + a.energy[i] - a.health[j];
      if (score > bestScore) { bestScore = score; best = j; }
    });
    return best;
  }

  /**
   * True if there is drinkable water in the 4-neighbourhood — the same reach
   * `eat` uses, so you can drink from the bank without wading in, but you have
   * to be at the water's edge.
   */
  private canDrink(i: number): boolean {
    const a = this.agents, w = this.world;
    const x = a.ax[i], y = a.ay[i];
    if (w.terrain[w.idx(x, y)] === T_WATER) return true;
    for (let oy = -DRINK_RADIUS; oy <= DRINK_RADIUS; oy++) {
      for (let ox = -DRINK_RADIUS; ox <= DRINK_RADIUS; ox++) {
        if (Math.abs(ox) + Math.abs(oy) > DRINK_RADIUS) continue;
        const kx = x + ox, ky = y + oy;
        if (!w.inBounds(kx, ky)) continue;
        if (w.terrain[w.idx(kx, ky)] === T_WATER) return true;
      }
    }
    return false;
  }

  private kill(killer: number, victim: number): void {
    this.kills++;
    const a = this.agents;
    a.health[victim] = -1;
    a.deathCause[victim] = CAUSE.KILLED;
    // the dead feed the living
    const idx = this.world.idx(a.ax[victim], a.ay[victim]);
    this.world.carcass[idx] = Math.min(1, this.world.carcass[idx] + 0.8);
    this.world.carcassAge[idx] = 0;
    // witnesses are frightened; the killer is not sorry
    this.spatial.forEachNear(a.ax[victim], a.ay[victim], 8, (j) => {
      if (j === victim) return;
      a.setH(j, 2 /* ANGER */, Math.min(1, a.h(j, 2) + 0.6));
      a.setH(j, 3 /* FEAR */, Math.min(1, a.h(j, 3) + 0.4));
    });
    a.setH(killer, 2, Math.min(1, a.h(killer, 2) + 0.3));
  }

  // --- bonding (hormonal, never a hard rule) -------------------------------
  /**
   * Court someone.
   *
   * Betrayal is now a *weak* bond's fate rather than a standing offer. With
   * courtship firing reliably — which it has to, or nothing is ever born —
   * a pixel in a crowded village is standing next to two or three eligible
   * partners at once, and a rule that lets the nearest one win every time is
   * a rule that severs and re-forms bonds several times a second: the bond
   * never climbs, `findPartner` treats everybody as spoken for, and the
   * population starves for partners while standing surrounded by them. So a
   * bond has to be earned before it can be broken, and the return value is
   * earned first.
   */
  private court(i: number, j: number): void {
    const a = this.agents;
    if (a.mate[i] >= 0 && a.mate[i] !== j && a.bond[i] < BOND_LOYALTY) {
      // betrayal: the old bond is severed, and it hurts everyone
      const old = a.mate[i];
      this.betraysals++;
      a.bond[old] = 0; a.setH(old, 4 /* LOVE */, 0);
      a.setH(old, 2 /* ANGER */, 1);
      a.setH(old, 5 /* EGO */, Math.max(0, a.h(old, 5) - 0.3));
      a.mate[old] = -1;
      a.setH(i, 4, Math.max(0, a.h(i, 4) - 0.5));
      a.setH(i, 2, Math.min(1, a.h(i, 2) + 0.3));
    }
    a.mate[i] = j; a.mate[j] = i;
    const rate = 0.12 * (0.5 + a.g(i, GENE.ATTACHMENT));
    a.bond[i] = Math.min(1, a.bond[i] + rate);
    a.bond[j] = Math.min(1, a.bond[j] + rate);
  }

  private reproduce(): void {
    const a = this.agents;
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (!a.alive[i] || this.breedCooldown[i] > 0) continue;
      const j = a.mate[i];
      if (j < 0 || !a.alive[j] || a.mate[j] !== i) continue;
      const fert = fertilityAge(a.genes, i);
      if (a.age[i] <= fert || a.age[j] <= fert) continue;
      const want = Math.min(a.h(i, 6 /* DESIRE */), a.h(j, 6));
      if (want < 0.30) continue;
      if (a.energy[i] < 0.30 || a.energy[j] < 0.30) continue;
      this.breed(i, j);
      this.breedCooldown[i] = 30; this.breedCooldown[j] = 30;
    }
    for (let i = 0; i < MAX_AGENTS; i++) if (this.breedCooldown[i] > 0) this.breedCooldown[i]--;
  }

  private breed(p1: number, p2: number): void {
    const a = this.agents, w = this.world;
    if (a.free.length === 0) return;
    const survival = newbornSurvival(a.count);
    const [x, y] = this.birthSpot(p1, p2);
    const i = a.alloc(this.rng, x, y);
    if (i < 0) return;

    crossover(
      a.genes.subarray(p1 * N_GENES, (p1 + 1) * N_GENES),
      a.genes.subarray(p2 * N_GENES, (p2 + 1) * N_GENES),
      this.rng,
      a.genes.subarray(i * N_GENES, (i + 1) * N_GENES),
    );
    a.sex[i] = this.rng.chance(0.5) ? 0 : 1;
    a.energy[i] = NEWBORN_ENERGY;
    a.thirst[i] = NEWBORN_THIRST;
    a.gen[i] = Math.max(a.gen[p1], a.gen[p2]) + 1;
    a.founder[i] = a.founder[p1];
    // the camp comes down the lineage with the founder id, so a child is born
    // knowing which village it belongs to — and a juvenile's pull toward that
    // village is the strongest thing in its movement bias
    a.campX[i] = a.campX[a.founder[i]];
    a.campY[i] = a.campY[a.founder[i]];
    a.bornTick[i] = this.tick;
    this.hist.clear(i);

    // knowledge inheritance: attachment decides how much of each parent survives
    const attach = a.g(i, GENE.ATTACHMENT);
    const alpha = clamp01(0.5 + (attach - 0.5) * 0.9);
    const sigma = 0.02 + (1 - attach) * 0.28;
    inheritBrain(
      this.brains, i * N_PARAMS,
      p1 * N_PARAMS, p2 * N_PARAMS, alpha, sigma, this.rng,
    );

    // the parents pay for it
    a.energy[p1] -= 0.12; a.energy[p2] -= 0.12;
    this.births++;

    if (!this.rng.chance(survival)) {
      a.health[i] = -1;
      a.deathCause[i] = CAUSE.CROWDING;
      const idx = w.idx(a.ax[i], a.ay[i]);
      w.carcass[idx] = Math.min(1, w.carcass[idx] + 0.4);
      // THE LUST BRAKE. A dead newborn has to hurt the parents that made it,
      // or nothing teaches them to hold back — they just breed harder and let
      // the cap do the killing. The cost is felt as hormones and as reward,
      // so RL can discover restraint instead of being told about it.
      const grief = 0.9 + a.count / HARD_CAP;
      for (const parent of [p1, p2]) {
        this.pendingReward[parent] -= grief;
        a.setH(parent, 2 /* ANGER */, Math.min(1, a.h(parent, 2) + 0.5));
        a.setH(parent, 4 /* LOVE */, Math.max(0, a.h(parent, 4) - 0.25));
        a.bond[parent] = Math.max(0, a.bond[parent] - 0.15);
        a.energy[parent] -= 0.06;
      }
    }
    this.generation = Math.max(this.generation, a.gen[i]);
  }

  // --- predators ------------------------------------------------------------

  /**
   * Put the opening predators in their dens.
   *
   * A predator is an animal with a home, and a den is a real place on the
   * map: a mouth cut into a mountainside with a chamber behind it, found by
   * the terrain generator long before anything is alive. So the opening
   * predators start there, spread over the dens nearest the founders so
   * several of them have company, and everything the world shows about them
   * afterwards — walking home at dusk, breeding in the rock, the roster's
   * distance-to-den — is measured from where they actually started.
   *
   * The old version dropped all four in a ring on top of the founding pixels,
   * which put the two species in the same twenty-six cells and made a den a
   * piece of scenery the predators never went near.
   */
  seedPredators(n: number): void {
    const w = this.world;
    if (w.caveX.length === 0) { this.seedPredatorsNoDens(n); return; }
    // the dens nearest the founders, nearest first, so the ones that share a
    // hunt with the pixels are the ones that share a valley
    const order = w.caveX.map((_, k) => k)
      .sort((a, b) =>
        (Math.abs(w.caveX[a] - this.founderX) + Math.abs(w.caveY[a] - this.founderY)) -
        (Math.abs(w.caveX[b] - this.founderX) + Math.abs(w.caveY[b] - this.founderY)));
    const spread = Math.min(n, order.length);

    for (let k = 0; k < n; k++) {
      // two to a den, so a den is a pair's home rather than a lone animal's
      //. Spreading four predators over four separate dens meant no two of
      // them ever shared ground, and a predator that only ever walks home
      // can therefore never meet a mate: the species quietly died out in
      // every run while the world carried on without it.
      const den = order[Math.floor(k / 2) % spread];
      const [x, y] = this.denMouth(den, k % 2);
      if (x < 0) continue;
      // one large among them, so the two sizes are both on screen
      const size = k === 0 ? PRED_LARGE : PRED_SMALL;
      const sex = k % 2 === 0 ? PRED_MALE : PRED_FEMALE;
      const i = this.predators.alloc(x, y, size, den, 0, sex);
      if (i < 0) break;
    }
  }

  /**
   * Somewhere a predator can actually stand near a den's mouth. The den tile
   * itself can be a pocket with no way out of it, so this walks outwards
   * until it finds ground that is both passable and on the den's side of the
   * map.
   *
   * `seat` picks which of the mouth's standing places to take. Two animals
   * sent to the same den used to be sent to the same *tile* — the first one
   * the ring search finds is the same one every time — which stacked the
   * pair, hid one of them under the other in the click index, and left the
   * renderer painting two animals into one silhouette.
   */
  private denMouth(den: number, seat = 0): [number, number] {
    const spots = this.denMouthSpots(den);
    if (spots.length === 0) return [-1, -1];
    return spots[seat % spots.length];
  }

  /** Every place a predator can stand outside a den, nearest ring first. */
  private denMouthSpots(den: number): Array<[number, number]> {
    const w = this.world;
    const cx = w.caveX[den], cy = w.caveY[den];
    const spots: Array<[number, number]> = [];
    for (let r = 0; r <= PRED_DEN_SCATTER; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
          const nx = cx + dx, ny = cy + dy;
          if (!w.inBounds(nx, ny) || !w.passable(nx, ny)) continue;
          // must be somewhere the den is actually reachable from
          if (w.caveDist[w.idx(nx, ny)] < 0) continue;
          spots.push([nx, ny]);
        }
      }
    }
    return spots;
  }

  /** A world whose generator found no mountains at all still gets predators. */
  private seedPredatorsNoDens(n: number): void {
    const w = this.world;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rad = PRED_DEN_SCATTER * 3;
      const nx = Math.round(this.founderX + Math.cos(a) * rad);
      const ny = Math.round(this.founderY + Math.sin(a) * rad);
      if (!w.inBounds(nx, ny) || !w.passable(nx, ny)) continue;
      const size = k === 0 ? PRED_LARGE : PRED_SMALL;
      const sex = k % 2 === 0 ? PRED_MALE : PRED_FEMALE;
      if (this.predators.alloc(nx, ny, size, -1, 0, sex) < 0) break;
    }
  }

  /**
   * Predators move, hunt, court and eat. No brains, no hormones: a predator
   * is hunger plus a light meter plus a memory of where it last saw prey.
   *
   * The rhythm, in order of precedence:
   *
   *   - starving            -> out, whatever the hour
   *   - hungry + night      -> out
   *   - hungry + daylight   -> back to the den and wait for dark
   *   - full                -> walk home, and if there is a partner to walk
   *                             to, walk to them instead
   *
   * The old version had no time of day at all, so predators were on the map
   * around the clock and the world had no pulse you could see. Sight is a
   * base radius that grows with hunger, so a starving predator will cross the
   * whole map if that is what it takes, and a fed one barely leaves its rock.
   */
  private huntPredators(): void {
    const a = this.agents, w = this.world, p = this.predators;
    const isNight = w.isNight;

    for (let i = 0; i < MAX_PREDATORS; i++) {
      if (!p.alive[i]) continue;
      // Going home for a litter counts as a reason to be in the den, exactly
      // as hunger counts as a reason to be out of it. Without this the two
      // windows do not overlap at all: a predator stops hunting at 0.65 and
      // cannot breed below 0.55, so the range in which it was both well fed
      // enough to breed and out on the map was the whole of what it ever did.
      // Every animal in a den of four met every other one in that den and
      // never once in the rock, and the species aged out one at a time.
      const denning = this.denning(i);
      const hunting = !denning && p.wantsToHunt(i, isNight);
      p.ranging[i] = hunting ? 1 : 0;

      // the hungrier it is, the further out it can sense prey
      const r = p.vision(i);

      const tgt = p.target[i];
      let gx = 0, gy = 0;

      if (hunting) {
        // Re-acquire on a stagger rather than every tick: sweeping the map
        // once per predator per tick is wasted work, and a fixed cadence
        // makes a hunt look deliberate instead of twitchy.
        p.searchT[i]--;
        if (p.searchT[i] <= 0 || tgt < 0 || !a.alive[tgt]) {
          p.searchT[i] = PRED_SEARCH_EVERY + (i % PRED_SEARCH_EVERY);
          const found = this.nearestPixelTo(p.px[i], p.py[i], r);
          p.target[i] = found;
          if (found >= 0) { p.tx[i] = a.ax[found]; p.ty[i] = a.ay[found]; }
        }

        const t = p.target[i];
        if (t >= 0) {
          // walk at the live target if it is still moving, else at the spot
          // it was last seen — the memory is what keeps a night hunt going
          // after the prey has broken line of sight behind a rock
          const cx = a.alive[t] ? a.ax[t] : p.tx[i];
          const cy = a.alive[t] ? a.ay[t] : p.ty[i];
          gx = Math.sign(cx - p.px[i]);
          gy = Math.sign(cy - p.py[i]);
          p.hx[i] = gx; p.hy[i] = gy;
          if (Math.abs(cx - p.px[i]) <= 1 && Math.abs(cy - p.py[i]) <= 1
              && p.energy[i] < PRED_ATTACK_ENERGY) {
            a.health[t] = -1;
            a.deathCause[t] = CAUSE.KILLED;
            p.energy[i] = Math.min(PRED_ENERGY_CAP, p.energy[i] + PRED_EAT_GAIN);
            p.kills[i]++;
            p.predKills++;
            // the meal is left on the ground for whoever gets there first
            w.addMeat(w.idx(cx, cy), MEAT_PER_KILL);
            p.target[i] = -1;
          }
        } else {
          // Starving, blind, and a long way from home. Turn back. A den with
          // no territory is not a den, it is a spawn point: the animal
          // sweeps off toward the prey village, finds nothing, and is still
          // ninety cells out when the pair it needs to breed with is sitting
          // in its own rock waiting for it.
          // The leash yields to the prey, and that one clause is the whole
          // difference between a predator that can feed and one that cannot.
          // Six dens on a three-by-two lattice sit about 250 cells apart, so
          // on nine of ten seeds one of the two dens holding the opening
          // predators is further from the village than the leash permits —
          // measured at 280, 131, 146, 137, 178, 192, 177, 235, 155 and 207
          // cells against a leash of 130. That animal walked toward the food
          // every night, was turned back at 130, and spent its whole life in
          // a territory with nothing in it. It is not a hard life, it is a
          // starvation chamber with scenery in it, and the leash is what put
          // the animal inside. So an animal may always walk as far as the
          // nearest camp; the leash still does the job it was written for,
          // which is stopping a hunt from quietly becoming a migration to the
          // far side of the map.
          const stray = p.den[i] >= 0 && p.den[i] < w.caveX.length
            ? w.caveDist[w.idx(p.px[i], p.py[i])] > Math.max(
                PRED_HUNT_LEASH, this.campDistance(p.px[i], p.py[i])) : false;
          if (stray) {
            const back = w.caveStep(p.px[i], p.py[i], p.den[i]);
            if (back >= 0) { gx = MOVE_DX[back]; gy = MOVE_DY[back]; }
            else { [gx, gy] = this.predFallback(i); }
          } else {
            // Otherwise commit to a heading, but head somewhere worth
            // heading. Six founders on a map this size put twenty-odd pixels
            // in a few hundred cells; sweeping 640x448 at random found them
            // so rarely that four predators killed between them nothing at
            // all in eight thousand ticks. A predator walks at the nearest
            // camp instead — the same cheat as a pixel walking at the food
            // field, pointed the other way — so a hunt is something you can
            // watch happen rather than a rumour. With no camp anywhere on
            // the map it keeps the blind sweep.
            const camp = this.nearestCampTo(p.px[i], p.py[i]);
            if (camp >= 0) {
              gx = Math.sign(this.campX[camp] - p.px[i]);
              gy = Math.sign(this.campY[camp] - p.py[i]);
            } else if (!p.hx[i] && !p.hy[i]) {
              p.hx[i] = this.rng.chance(0.5) ? 1 : -1;
              p.hy[i] = this.rng.chance(0.5) ? 1 : -1;
              gx = p.hx[i]; gy = p.hy[i];
            } else {
              gx = p.hx[i]; gy = p.hy[i];
            }
          }
          p.hx[i] = gx; p.hy[i] = gy;
        }
      } else {
        // Not hunting. Give up on a stale target so a dawn return to the den
        // is not walking back to a kill that happened hours ago.
        if (tgt < 0 || !a.alive[tgt]) p.target[i] = -1;

        // Home — but a den with nobody else in it is a rock, not a home, and
        // an animal alone in one has no way to breed and no way to find out
        // that it is the only one. So it goes looking for the nearest den
        // that still has company, and walks the cave distance field to get
        // there rather than straight at the mouth, because a den is carved
        // into a mountainside and the straight line at it is a straight line
        // at the one wall that has to be walked around.
        //
        // This is the single most important thing in the predator's day, and
        // it is the thing that was missing. `mtx`/`mty` have always been
        // documented as "where this animal last saw one of the other sex"
        // and have always been written once at birth and never read by
        // anything. The consequence was arithmetic rather than dramatic: a
        // den of two loses one animal to age, and the survivor sits in the
        // rock for the other twelve hundred ticks of its life with nobody to
        // mate with, while the rest of the species is in other dens doing the
        // same thing. The population was never food-limited. It was
        // unpaired, and it aged out one chamber at a time.
        const lured = this.mateLure(i);
        const step = lured >= 0
          ? w.caveStep(p.px[i], p.py[i], lured)
          : w.caveStep(p.px[i], p.py[i], p.den[i]);
        if (step >= 0) { gx = MOVE_DX[step]; gy = MOVE_DY[step]; }
        else { [gx, gy] = this.predFallback(i); }
        p.hx[i] = gx; p.hy[i] = gy;
      }

      // One step, slid around whatever is in the way. The old version tried
      // the step and, on failure, either reversed or turned at random, which
      // is how four predators sat at a fixed 90 cells from their dens for
      // eight thousand ticks: jammed against a mountain, inert, and taking
      // nothing from a world that was dying around them.
      if (gx || gy) {
        const [nx, ny, s] = this.slide(p.px[i], p.py[i], gx, gy);
        p.px[i] = nx; p.py[i] = ny;
        if (s !== 4) { p.hx[i] = MOVE_DX[s]; p.hy[i] = MOVE_DY[s]; }
      }
      this.adoptDen(i);

      p.age[i]++;
      p.energy[i] -= PRED_HUNGER_RATE;
      if (p.energy[i] <= 0) p.health[i] -= 0.02;
      if (p.age[i] > p.maxAge(i)) p.health[i] -= 0.006;
      if (p.energy[i] > 0.3 && p.health[i] < 1) p.health[i] += 0.004;
      if (p.cooldown[i] > 0) p.cooldown[i]--;
      if (p.mateT[i] > 0) p.mateT[i]--;
    }
    this.reapPredators();
  }

  /**
   * The nearest predator of the opposite sex within PRED_MATE_R, or -1.
   *
   * This is the whole of "predators know where each other are": with six of
   * them alive, a straight scan is cheaper than any index, and every animal
   * therefore always has an accurate answer to the only question it asks
   * about the others. Sexes are balanced at birth, so there is nearly always
   * somebody to find.
   */
  nearestOppositeSexPredator(i: number): number {
    const p = this.predators;
    const want = p.sex[i] === PRED_MALE ? PRED_FEMALE : PRED_MALE;
    let best = -1, bestD = PRED_MATE_R * PRED_MATE_R;
    for (let k = 0; k < MAX_PREDATORS; k++) {
      if (!p.alive[k] || k === i || p.sex[k] !== want) continue;
      const ox = p.px[k] - p.px[i], oy = p.py[k] - p.py[i];
      const d = ox * ox + oy * oy;
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  /**
   * Straight-line distance to the nearest opposite-sex predator this one can
   * currently see, or -1. Public because the sidebar shows it: the ask was
   * that a predator "knows where the female/male predator is", and a fact
   * nobody can read off the screen is not observable.
   */
  predMateDistance(i: number): number {
    const m = this.nearestOppositeSexPredator(i);
    if (m < 0) return -1;
    const p = this.predators;
    return Math.round(Math.hypot(p.px[m] - p.px[i], p.py[m] - p.py[i]));
  }

  /** Walking distance in cells from a predator to its den, or -1. */
  predDenDistance(i: number): number {
    const p = this.predators, w = this.world;
    if (p.den[i] < 0 || p.den[i] >= w.caveX.length) return -1;
    if (!w.inBounds(p.px[i], p.py[i])) return -1;
    return w.caveDist[w.idx(p.px[i], p.py[i])];
  }

  /**
   * Where a predator goes when "go home" is not an instruction it can carry
   * out. Returns a heading.
   *
   * `caveStep` answers -1 for two completely different situations: you are
   * already there, and there is no way to get there. Nothing upstream could
   * tell them apart, so an animal whose den was walled off by a mountain
   * range — or any animal in a world whose generator found no mountain at
   * all, where every predator is seeded with den -1 — read its -1 as "home"
   * and stood in the open for the rest of the world, awake or asleep,
   * because going home was the only thing it knew how to do. That is a
   * predator that can die of nothing but a passing pixel's curiosity, which
   * is a bad way to live and a worse thing to watch.
   *
   * So when there is genuinely nowhere to go, it goes where the prey is. A
   * camp is a landmark, and it is where every pixel in the world eventually
   * is. With no camp on the map at all, the animal keeps its own heading
   * rather than standing still on an empty map.
   */
  private predFallback(i: number): [number, number] {
    const p = this.predators, w = this.world;
    const home = p.den[i] >= 0 && p.den[i] < w.caveX.length
      ? w.caveDist[w.idx(p.px[i], p.py[i])] : -1;
    if (home <= 1) return [0, 0]; // there already, or nowhere at all to be
    const camp = this.nearestCampTo(p.px[i], p.py[i]);
    if (camp >= 0) {
      return [Math.sign(this.campX[camp] - p.px[i]), Math.sign(this.campY[camp] - p.py[i])];
    }
    if (!p.hx[i] && !p.hy[i]) {
      p.hx[i] = this.rng.chance(0.5) ? 1 : -1;
      p.hy[i] = this.rng.chance(0.5) ? 1 : -1;
    }
    return [p.hx[i], p.hy[i]];
  }

  /**
   * The nearest opposite-sex predator living in `den`, within partner range,
   * or -1.
   *
   * Deliberately stricter about the den than `nearestOppositeSexPredator`,
   * which answers "where is anyone of the other sex" and is what the sidebar
   * shows. A den is a territory and a litter is born in one, so "nearby" is
   * not the question that decides whether a pair can breed.
   */
  private partnerInDen(den: number, i: number): number {
    const p = this.predators;
    if (den < 0) return -1;
    let best = -1, bestD = PRED_MATE_R * PRED_MATE_R;
    for (let k = 0; k < MAX_PREDATORS; k++) {
      if (!p.alive[k] || k === i || p.sex[k] === p.sex[i]) continue;
      if (p.den[k] !== den) continue;
      const ox = p.px[k] - p.px[i], oy = p.py[k] - p.py[i];
      const d = ox * ox + oy * oy;
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  denMate(i: number): number {
    return this.partnerInDen(this.predators.den[i], i);
  }

  /**
   * The den this predator should walk to in order to find a partner, or -1.
   *
   * Only asked of an animal whose own den has no other sex in it. Everything
   * else — a pair at home, or an animal with no den at all — is left alone,
   * because a den that works is not a place to leave.
   *
   * There is no range limit on this, which took a while to see. The obvious
   * version reuses PRED_MATE_R, on the grounds that an animal will not walk
   * further than it can see: on the measured seed the two dens holding the
   * founding predators are 204 cells apart and the search radius is 140, so
   * the lure could never once fire, and the survivors aged out exactly as
   * before. A den is worth a day's walk to an animal that has nothing else
   * to do, and at one cell a tick that is a morning's stroll.
   *
   * Crowding is what keeps this from being "everybody move to the same
   * rock": a den that already has animals in it is penalised, so an animal
   * walks to the nearest chamber with room rather than the first one it hears
   * about, and six predators end up spread over two or three dens.
   */
  private mateLure(i: number): number {
    const p = this.predators, w = this.world;
    if (p.den[i] < 0 || p.den[i] >= w.caveX.length) return -1;
    if (this.denMate(i) >= 0) return -1;
    const want = p.sex[i] === PRED_MALE ? PRED_FEMALE : PRED_MALE;
    let best = -1, bestScore = Infinity;
    for (let k = 0; k < MAX_PREDATORS; k++) {
      if (!p.alive[k] || p.sex[k] !== want) continue;
      const d = p.den[k];
      if (d < 0 || d >= w.caveX.length || d === p.den[i]) continue;
      let crowd = 0;
      for (let q = 0; q < MAX_PREDATORS; q++) if (p.alive[q] && p.den[q] === d) crowd++;
      const score = Math.hypot(w.caveX[d] - p.px[i], w.caveY[d] - p.py[i])
        + crowd * PRED_DEN_CROWDING;
      if (score < bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  /**
   * Take a new den, if this animal is standing in someone else's rock with
   * someone of the other sex.
   *
   * Without it the lure walks an animal across the map to stand outside a den
   * that is not its own, which is a visit and not a move: `breedPredators`
   * requires the pair to be in the same den *as recorded*, so the animal would
   * have made the journey every single morning for the rest of its life and
   * bred nothing. Dens are where animals live, not where they were born.
   */
  private adoptDen(i: number): void {
    const p = this.predators, w = this.world;
    if (p.den[i] < 0 || p.den[i] >= w.caveX.length) return;
    if (!w.inBounds(p.px[i], p.py[i])) return;
    const here = w.nearestCave(p.px[i], p.py[i]);
    if (here < 0 || here === p.den[i]) return;
    if (w.caveDist[w.idx(p.px[i], p.py[i])] > PRED_DEN_BREED_R) return;
    if (this.partnerInDen(here, i) < 0) return;
    p.den[i] = here;
  }

  /**
   * Should this predator go home to breed rather than stay out hunting?
   *
   * Four conditions, all of which have to hold: the world is not already
   * full of predators, there is a world behind the new one, the animal is
   * fed enough to raise a litter, it is off cooldown, and there is a partner
   * sharing its den. This is the only thing that puts a hunting animal back
   * in the rock, so it is the hinge the whole predator lifecycle turns on.
   */
  private denning(i: number): boolean {
    const p = this.predators;
    if (p.cooldown[i] > 0) return false;
    if (p.energy[i] < PRED_BREED_ENERGY) return false;
    if (p.count >= PRED_SOFT_CAP) return false;
    if (a0(this) < PRED_BREED_MIN_PREY) return false;
    return this.denMate(i) >= 0;
  }

  /**
   * Predators breed in their den, and only if there is room and a world
   * behind the new one.
   *
   * Six is a hard ceiling, so a birth is always also a death somewhere: the
   * new animal arrives in a world that has decided there are only six of
   * these. A pair is a pair of animals that share a den — which is why the
   * opening predators are seeded two to a den, and why a non-hunting
   * predator walks home and to nowhere else. The old rule was proximity
   * anywhere on the map, which could only ever pair animals that happened to
   * be passing each other, and a species whose animals are never in the same
   * place at the same time does not reproduce; it just gets older.
   */
  private breedPredators(): void {
    const p = this.predators, w = this.world;
    // a ceiling, not a quota: six predators need a world with six predators'
    // worth of prey behind them
    if (p.count >= PRED_SOFT_CAP) return;
    if (a0(this) < PRED_BREED_MIN_PREY) return;
    for (let i = 0; i < MAX_PREDATORS; i++) {
      if (!p.alive[i] || p.cooldown[i] > 0) continue;
      const m = this.nearestOppositeSexPredator(i);
      if (m < 0) continue;
      // they have to actually be together, and both of them fed
      if (Math.abs(p.px[i] - p.px[m]) > PRED_MATE_BOND_R
          || Math.abs(p.py[i] - p.py[m]) > PRED_MATE_BOND_R) continue;
      if (p.energy[i] < PRED_BREED_ENERGY || p.energy[m] < PRED_BREED_ENERGY) continue;
      // and they have to be in the rock together: a den is where the litter
      // is born, and requiring it is what makes a den a place
      const den = p.den[i] >= 0 ? p.den[i] : p.den[m];
      if (den >= 0 && den < w.caveX.length) {
        const dx = w.caveX[den], dy = w.caveY[den];
        if (Math.abs(p.px[i] - dx) > PRED_DEN_BREED_R || Math.abs(p.py[i] - dy) > PRED_DEN_BREED_R) continue;
      }
      if (!this.rng.chance(PRED_BREED_CHANCE)) continue;

      const size = this.rng.chance(0.3) ? PRED_LARGE : PRED_SMALL;
      // Three and three, or the species walks out of the world one coin flip
      // at a time. A litter is one animal with a fifty-fifty sex, so two of
      // them can come out the same, and a den of two same-sex animals can
      // never produce another one — and nothing anywhere in the world notices
      // or corrects it. The population random-walks toward a single sex and
      // then walks out: on the seed this was found on there were five males
      // and one female at t=3000 and three males and no females by t=4000,
      // after which every animal in the species spent a full lifespan walking
      // home to a den with nobody in it of the sex it needed. Not a food
      // problem and not a den problem. Six coins, flipped once.
      let sex = this.rng.chance(0.5) ? PRED_MALE : PRED_FEMALE;
      if ((sex === PRED_MALE ? p.male : p.female) >= PRED_SEX_CAP) {
        sex = sex === PRED_MALE ? PRED_FEMALE : PRED_MALE;
      }
      // born at the den, which is where a pair has to be to breed
      let bx = p.px[i], by = p.py[i];
      if (den >= 0 && den < w.caveX.length) { bx = w.caveX[den]; by = w.caveY[den]; }
      const j = p.alloc(bx, by, size, den, 0, sex);
      if (j < 0) return;
      p.energy[i] -= 0.35; p.energy[m] -= 0.35;
      p.energy[j] = PRED_ENERGY_CAP * 0.6;
      p.cooldown[i] = PRED_BREED_COOLDOWN;
      p.cooldown[m] = PRED_BREED_COOLDOWN;
      p.cooldown[j] = PRED_BREED_COOLDOWN;
    }
  }

  /**
   * Pixels kill predators by mobbing them. Damage scales with the square of
   * the mob, which is what makes "five together" mean something: one pixel
   * lands a twentieth of the damage five do, and cannot realistically finish
   * even a small predator before it eats.
   */
  private resolveMobs(): void {
    const a = this.agents, p = this.predators;
    for (let i = 0; i < MAX_PREDATORS; i++) {
      if (!p.alive[i]) continue;
      const need = p.size[i] === PRED_LARGE ? MOBS_TO_KILL_LARGE : MOBS_TO_KILL_SMALL;
      let mob = 0;
      this.spatial.forEachNear(p.px[i], p.py[i], MOBS_RADIUS, (j) => {
        if (!a.alive[j]) return;
        const dx = a.ax[j] - p.px[i], dy = a.ay[j] - p.py[i];
        if (Math.abs(dx) <= MOBS_RADIUS && Math.abs(dy) <= MOBS_RADIUS) mob++;
      });
      if (mob <= 0) continue;

      // The threshold is the whole point: three pixels kill a small predator,
      // five kill a large one, and a crowd that is one short does not kill it
      // at all. Scaling damage smoothly by crowd size instead meant a lone
      // pixel ground a small predator down in a hundred ticks, which made the
      // number a lie. Below the line a crowd only rattles the thing.
      const enough = mob >= need;
      if (enough) p.health[i] -= MOB_DAMAGE * Math.min(1, mob / need);

      // Everyone in a big enough crowd is paid for standing its ground, so
      // reinforcement is learnable rather than incidental. Pixels one short
      // get nothing, which is what stops a single pixel from learning that
      // walking into a predator is a good idea.
      const heat = Math.min(1, mob / need);
      // The reward is paid on a near miss as well as a kill, scaled by how
      // close the crowd is to the threshold. Paying only on a kill makes it
      // unlearnable: the brain has to find a behaviour it has never been
      // rewarded for. A lone pixel is paid nothing at all, so crowding a
      // predator is never worse than walking into one alone. Two pixels get a
      // third of the pay of five, which is the gradient that teaches "go and
      // get your friends".
      if (mob >= 2) {
        this.spatial.forEachNear(p.px[i], p.py[i], MOBS_RADIUS, (j) => {
          if (!a.alive[j]) return;
          this.pendingReward[j] += MOB_REWARD * heat;
        });
      }
      // the mob is loud either way
      this.spatial.forEachNear(p.px[i], p.py[i], 10, (j) => {
        if (!a.alive[j]) return;
        a.setH(j, H.ANGER, Math.min(1, a.h(j, H.ANGER) + 0.25 * heat));
        a.setH(j, H.FEAR, Math.min(1, a.h(j, H.FEAR) + 0.3 * heat));
      });
    }
  }

  private reapPredators(): void {
    const p = this.predators;
    for (let i = 0; i < MAX_PREDATORS; i++) {
      if (!p.alive[i] || p.health[i] > 0) continue;
      if (p.energy[i] <= 0) p.starved++;
      else if (p.age[i] > p.maxAge(i)) p.diedOfAge++;
      else p.mobbed++;
      p.release(i);
    }
  }

  /** Nearest living pixel within `r`, or -1. */
  private nearestPixelTo(x: number, y: number, r: number): number {
    const a = this.agents;
    let best = -1, bestD = Infinity;
    this.spatial.forEachNear(x, y, r, (j, ox, oy) => {
      if (!a.alive[j]) return;
      const d = ox * ox + oy * oy;
      if (d < bestD && d <= r * r) { bestD = d; best = j; }
    });
    return best;
  }

  // --- physiology ----------------------------------------------------------
  private physiology(): void {
    const a = this.agents;
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (!a.alive[i]) continue;
      a.age[i]++;
      a.energy[i] -= BASE_METABOLISM * (0.6 + a.g(i, GENE.METABOLISM));
      a.thirst[i] = Math.min(1, a.thirst[i] + THIRST_RATE);
      // you do not choose to drink, you drink when you are at the water
      if (a.thirst[i] > 0 && this.canDrink(i)) {
        a.thirst[i] = Math.max(0, a.thirst[i] - DRINK_RELIEF);
      }
      if (a.nauseaT[i] > 0) {
        a.nauseaT[i]--;
        if (a.nauseaT[i] === 0) a.nausea[i] = 0;
      }
      if (a.killT[i] > 0) a.killT[i]--;
      updateHormones(a, this.world, this.spatial, i, this.sawSomeone[i] === 1);

      // Mark what is actually killing this pixel, before the health bar
      // runs out. A kill or a failed newborn already marked itself, and those
      // are the real cause, so the drives never overwrite them.
      if (a.deathCause[i] === CAUSE.NONE) {
        if (a.age[i] > maxAgeFor(a.genes, i)) a.deathCause[i] = CAUSE.AGE;
        else if (a.thirst[i] >= 1) a.deathCause[i] = CAUSE.DEHYDRATION;
        else if (a.energy[i] <= 0) a.deathCause[i] = CAUSE.STARVATION;
      }
      if (a.energy[i] <= 0) a.health[i] -= 0.025;
      // same damage rate as starvation: neither drive is the real one
      if (a.thirst[i] >= 1) a.health[i] -= DEHYDRATION_DAMAGE;
      if (a.age[i] > maxAgeFor(a.genes, i)) a.health[i] -= 0.010;
      if (a.energy[i] > 0.25 && a.health[i] < 1) a.health[i] += 0.003;
    }
  }

  private reap(): void {
    const a = this.agents;
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (!a.alive[i] || a.health[i] > 0) continue;
      // Count the death exactly once, from the cause that was marked when it
      // happened. The old version re-derived the cause here from whatever
      // state the body was in, and anything that was not old and not thirsty
      // fell through to "starvation" — so every pixel eaten by a predator and
      // every newborn that failed its survival roll was tallied as a famine on
      // top of the kill it had already been counted as.
      switch (a.deathCause[i]) {
        case CAUSE.STARVATION: this.deaths.starvation++; break;
        case CAUSE.DEHYDRATION: this.deaths.dehydration++; break;
        case CAUSE.AGE: this.deaths.age++; break;
        case CAUSE.CROWDING: this.deaths.crowding++; break;
        case CAUSE.KILLED: this.deaths.killed++; break;
        // unmarked and dying anyway: health was driven to zero by damage we
        // did not attribute, so call it what it most likely was
        default:
          if (a.age[i] > maxAgeFor(a.genes, i)) this.deaths.age++;
          else if (a.thirst[i] >= 1) this.deaths.dehydration++;
          else this.deaths.starvation++;
      }
      this.lifespanSum += a.age[i];
      this.lastDeathAge = a.age[i];
      // crowding is an instant, policy-level death: it measures the population
      // controller, not whether an individual learned to survive
      if (a.age[i] > 30) this.naturalDeathAges.push(a.age[i]);
      this.deathCount++;
      this.hist.clear(i);
      a.release(i);
    }
  }

  private record(): void {
    if (this.tick % this.historyEvery !== 0) return;
    const a = this.agents;
    let ageSum = 0, eSum = 0;
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (!a.alive[i]) continue;
      ageSum += a.age[i]; eSum += a.energy[i];
    }
    const n = Math.max(1, a.count);
    this.history.push({
      tick: this.tick, pop: a.count, food: Math.round(this.world.totalFood()),
      season: this.world.seasonName, meanAge: ageSum / n, meanEnergy: eSum / n,
    });
  }

  snapshot() {
    return {
      tick: this.tick, pop: this.agents.count, births: this.births,
      deaths: { ...this.deaths }, kills: this.kills, betraysals: this.betraysals,
      meanLifespan: this.meanLifespan, generation: this.generation,
      season: this.world.seasonName,
    };
  }
}

const GRID_CX = GRID_W >> 1, GRID_CY = GRID_H >> 1;

/** Pixel population, via a tiny helper so the predator gate can read it
 *  without a back-reference into the class. */
function a0(sim: Sim): number { return sim.agents.count; }
