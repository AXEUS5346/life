import {
  MAX_AGENTS, N_PARAMS, N_INPUTS, N_HIDDEN, N_OUTPUTS, N_MOVE, Verb, VERB_OUT_BASE,
  SOFT_CAP, HARD_CAP, VILLAGE_SOFT_CAP, VILLAGE_HARD_CAP, T_ROCK, T_WATER,
  LEARNING_RATE, EPSILON_START, EPSILON_END, EPSILON_DECAY_TICKS,
  MOVE_ENERGY_COST, BASE_METABOLISM, WATER_MULTIPLIER,
  MATE_RADIUS, SENSE_R, SEEK_R, SEEK_EVERY, BOND_RADIUS, BOND_LOYALTY, KILL_RADIUS, KILL_COOLDOWN, CARCASS_NUTRITION, PLANT_NUTRITION, NAUSEA_TICKS,
  THIRST_RATE, DRINK_RELIEF, DEHYDRATION_DAMAGE, DRINK_RADIUS, N_VERB,
  MOVE_DX, MOVE_DY, FOUNDER_SPREAD, CAMP_SPREAD, PRED_DEN_SCATTER,
  NEWBORN_ENERGY, NEWBORN_THIRST, BIRTH_SPREAD, FOOD_UNDERFOOT,
  MAX_PREDATORS, PRED_LARGE, PRED_SMALL, PRED_MALE, PRED_FEMALE,
  PRED_ENERGY_CAP, PRED_HUNGER_RATE,
  PRED_SOFT_CAP, PRED_SEX_CAP, PRED_BREED_ENERGY, GRID_W, GRID_H, GRID_SIZE,
  PRED_BREED_CHANCE, PRED_BREED_COOLDOWN, PRED_EAT_GAIN, PRED_DEN_BREED_R,
  PRED_SEARCH_EVERY, PRED_DEN_ENERGY, PRED_ATTACK_ENERGY, PRED_HUNT_LEASH,
  PRED_NIGHT_REACH, PRED_CHASE_STEPS, PRED_SIGHT_TRIES,
  PRED_MATE_R, PRED_MATE_BOND_R, PRED_DEN_CROWDING, PRED_DEN_MATE_BONUS,
  PRED_DEN_STAY_MARGIN, PRED_BREED_MIN_PREY,
  PRED_RESEED_FLOOR, PRED_RESEED_COUNT, PRED_RESEED_COOLDOWN,
  MAX_CAMP_SLOTS, VILLAGE_CHECK_EVERY, VILLAGE_REFOUND_FLOOR,
  VILLAGE_REFOUND_COUNT, VILLAGE_REFOUND_COOLDOWN, VILLAGE_MIGRATE_R,
  VILLAGE_REFOUND_FRACTION,
  VILLAGE_MIGRATE_WANT_POP,
  PRED_SMELL_EVERY, PRED_STALK_R, PRED_MEMORY_TICKS, PRED_PANIC_HEALTH,
  PRED_FIRE_AVOID,
  MOBS_TO_KILL_LARGE, MOBS_TO_KILL_SMALL, MOBS_RADIUS, MOB_DAMAGE, MOB_REWARD,
  MEAT_PER_KILL, MEAT_NUTRITION, MEAT_DOPAMINE, H,
  T_SNOW, T_SAND, T_CAVE, T_DEAD, T_OPEN, T_MARSH,
  VILLAGES, VILLAGE_GAP, CAMP_SEP, CAMP_HOME_R,
  Item, N_ITEMS, CARRY_CAP, TAKE_R, ITEM_PICKUP_COOLDOWN, MEAT_PER_CARRY,
  COMBINE_COOLDOWN, GATHER_REWARD, COMBINE_REWARD,
  FIRE_BURN_TICKS, FIRE_SPREAD_ALONG, FIRE_SPREAD_ACROSS, FIRE_PRED_DAMAGE,
  FIRE_PIXEL_DAMAGE, FIRE_SCORCH_RATE, MEAT_ROT_RATE, IGNITE_SOFTNESS,
} from './constants.ts';
import { RNG } from './rng.ts';
import { World, type DeathCause, moveIndexOf } from './world.ts';
import { Agents } from './agents.ts';
import { SpatialIndex } from './spatial.ts';
import { Predators, PredState } from './predators.ts';
import { buildInputs, clearLine } from './sensors.ts';
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

/** The 4 directions a fire spreads, indexed by `World.wind`. Duplicated from
 *  world.ts's private table because the fire pass lives here; the index order
 *  is the part that has to agree and it is fixed by `World.wind`'s own
 *  comment, so the two cannot drift without that comment being wrong. */
const WIND_DX = [1, -1, 0, 0];
const WIND_DY = [0, 0, 1, -1];

/** Keep a coordinate on the map. A fire at the rim has no neighbour to spread
 *  into, and a spread that wrapped round to the other side of the world would
 *  light a cell 640 cells away from the one that was burning. */
function clampCell(v: number, limit: number): number {
  return v < 0 ? 0 : v >= limit ? limit - 1 : v;
}

export type SimStats = {
  tick: number; pop: number; food: number; season: string;
  meanAge: number; meanEnergy: number;
};

/** What killed a pixel. Marked on the agent, tallied once in reap(). */
export const CAUSE = {
  NONE: 0, STARVATION: 1, DEHYDRATION: 2, AGE: 3, CROWDING: 4, KILLED: 5,
  BURNED: 6,
} as const;

/** Newborn survival as a function of how crowded the world already is. */
export function newbornSurvival(pop: number): number {
  if (pop >= HARD_CAP) return 0;
  if (pop <= SOFT_CAP) return 1;
  return 1 - (pop - SOFT_CAP) / (HARD_CAP - SOFT_CAP);
}

/**
 * Newborn survival, with the crowding measured against the *village* rather
 * than against the world.
 *
 * The world version above is a single number applied to every newborn on the
 * map, and it is the reason three founding villages became one. Measured on
 * seed 20260927: camp population by village went [15, 16, 29] -> [0, 0, 0] and
 * [0, 52, 398] over 5000 ticks, with 88% of the world inside a single village
 * and the *least* food of the three. Nothing about the ground chose that
 * village, so the explanation had to be in the birth rate — and it is:
 *
 *   `newbornSurvival(a.count)` reads the WORLD's population. At 450 pixels,
 *   between SOFT_CAP=200 and HARD_CAP=600, it returns
 *   `1 - (450-200)/(600-200)` = 0.375. So 62.5% of every newborn everywhere
 *   dies at birth — in the crowded village AND in the empty one, identically.
 *
 * A tax that is identical in a village of 25 and a village of 400 cannot
 * correct a 16:1 gap between them; it applies the same pressure to both and
 * lets whichever got ahead of the race stay ahead. The gap opens in the first
 * five hundred ticks, when one village happens to get a run of births, and
 * nothing after that ever pushes back.
 *
 * So the soft half of the curve moves to the local population, where it means
 * what "crowded" is supposed to mean: a village of 400 throttles its own
 * newborns, a village of 25 does not. The hard half stays global, because the
 * world has a fixed amount of grass and a population past HARD_CAP has to be
 * throttled wherever it happens to be standing.
 *
 * `villagePop` is the parent's own village, so a child is taxed by the
 * density of the place it is being born into — which is the place `homePull`
 * will spend its first few hundred ticks, and therefore the density that
 * actually decides whether it survives them.
 */
export function newbornSurvivalLocal(worldPop: number, villagePop: number): number {
  // The world is full: no village is exempt.
  if (worldPop >= HARD_CAP) return 0;
  // The village is comfortable, and there is room in the world for the birth.
  if (villagePop <= VILLAGE_SOFT_CAP) return 1;
  // A crowded village pays for its own crowding, on the same slope the world
  // used to pay on the world.
  return 1 - (villagePop - VILLAGE_SOFT_CAP) / (VILLAGE_HARD_CAP - VILLAGE_SOFT_CAP);
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

  /**
   * Walking distance from every cell to the nearest camp, -1 where none is
   * reachable. The same trick as `World.waterDist` and `World.caveDist`, and
   * built at the same moment, because the camps only exist once
   * `seedPopulation` has picked the founding spot.
   *
   * This exists for the predators' leash, and the distance has to be a walked
   * one rather than a straight line: a den and a village 150 cells apart on
   * the map can be 200 cells apart to walk round a lake, and a leash that
   * turns an animal back at 150 is a leash that stops it on the shoreline.
   */
  campDist = new Int32Array(GRID_SIZE);

  /**
   * How many living pixels carry each camp's founder id.
   *
   * This is the whole of "which villages still exist", and it is a tally
   * rather than a scan because the answer is asked every VILLAGE_CHECK_EVERY
   * ticks and the expensive version is a pass over MAX_AGENTS.
   *
   * It exists because of what the tally showed. Villages are demographically
   * sealed — `agents.campX[agents.founder[i]]` is fixed at birth and `homePull`
   * pulls every pixel toward its own camp — so three villages are three
   * independent populations that cannot help each other, and with two founders
   * apiece a village that dips low can never be re-founded by anybody. Measured
   * on seed 20260927, camp population by village over 5000 ticks:
   *
   *     t=500   [15, 16, 29]     (two camps per village, summed)
   *     t=1000  [16, 35, 371]    <- village 2 goes 29 -> 371 in 500 ticks
   *     t=2500  [0,  25, 327]
   *     t=5000  [0,  52, 398]    <- 88% of the world in one of three villages
   *
   * That is a demographic runaway, not terrain. Food within 60 cells of the
   * six camps is 608/668/496/588/495/510 units, so the village that wins is the
   * one with the *least* food of the three; nothing about the ground explains
   * it, and nothing stops it. The losing villages do not get out-competed, they
   * just lose a run of births and never come back.
   */
  campPop = new Int32Array(MAX_CAMP_SLOTS);
  /** Ticks until the next village census / re-founding pass. */
  private villageCheckT = 0;
  /** Ticks until the next village re-founding may happen. Separate from the
   *  census interval on purpose: the census is a cheap tally that wants to run
   *  often, and re-founding is an act that wants to be rare. */
  private refoundT = 0;
  /** How many villages have been re-founded. Shown in the sidebar for the
   *  same reason `predReseeded` is: a world that quietly repairs itself is
   *  indistinguishable from one where the repair never worked. */
  villagesRefounded = 0;

  births = 0;
  deaths: Record<DeathCause, number> = {
    starvation: 0, dehydration: 0, age: 0, crowding: 0, killed: 0, burned: 0,
  };
  private lifespanSum = 0;
  private deathCount = 0;
  betraysals = 0;
  /** age of the most recent death, for harness diagnostics */
  lastDeathAge = 0;
  /** ages of natural deaths (starvation/age), excluding instant crowding deaths */
  naturalDeathAges: number[] = [];
  kills = 0;
  /** Ticks until the next predator re-founding attempt.
   *  Internal rather than private: a test needs to put the world one tick
   *  short of being allowed to re-found, to prove the cooldown is real and
   *  that a species does not blink back into existence the tick it is wiped. */
  predReseedT = 0;
  /** How many times the world has had to re-found the predator species. The
   *  sidebar shows it, because a number that only ever reads zero is a number
   *  nobody can tell apart from a feature that is not working. */
  predReseeded = 0;

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
    // Three villages of two, not one village of six.
    //
    // Six pixels dropped at random across a 286k-cell map have a 79% chance
    // of having nobody within partner range, and a lineage that cannot find a
    // mate is not a lineage. The previous answer was one founding spot and all
    // six born within two cells of it, which solved "can they find each other"
    // by making them a single pair of coordinates. The new answer splits the
    // six into VILLAGES pairs on VILLAGES separate pieces of ground, so the
    // six founders are three places on the map rather than one smear — and
    // each place still has the redundancy to survive losing a founder.
    //
    // Site choice is a GREEDY FARTHEST-POINT pass over the same score
    // `findHabitable` uses, and it has to be that and not `findHabitable`
    // itself. `findHabitable` returns the global argmax of a deterministic
    // scorer, so calling it three times returns the same three cells: measured
    // over ten seeds, eight calls returned eight sites all within about ten
    // cells of each other, because the scorer rewards the same rich valley
    // every time. Farthest-point fixes it by excluding everything within
    // VILLAGE_GAP of what is already chosen before scoring the rest, and it
    // found three well-separated sites on ten seeds out of ten — minimum gap
    // 122, typically 150 to 490.
    const sites = this.villageSites(Math.min(VILLAGES, Math.max(1, Math.floor(n / 2))));
    // The opening predators spawn in the dens nearest this spot, so the
    // "founding valley" that both species open on has to still be one place.
    this.founderX = sites[0][0]; this.founderY = sites[0][1];

    for (let v = 0; v < sites.length; v++) {
      const [cx, cy] = sites[v];
      // Two founders per village, CAMP_SEP apart so the two camps are visibly
      // distinct places rather than one mark. CAMP_SEP is above CAMP_HOME_R=4
      // and below SEEK_R=60, which is the band the constant was chosen for:
      // far enough that "which camp am I at" has an answer, near enough that
      // the pair is inside each other's partner search from the first tick.
      const camps = this.findCampPair(cx, cy);
      const pair: number[] = [];
      for (let m = 0; m < 2; m++) {
        const [gx, gy] = camps[m];
        const [x, y] = this.nearFoundingCell(gx, gy);
        const i = this.agents.alloc(this.rng, x, y);
        if (i < 0) break;
        initBrain(this.brains, i * N_PARAMS, this.rng);
        this.agents.bornTick[i] = 0;
        this.agents.campX[i] = gx;
        this.agents.campY[i] = gy;
        this.campX.push(gx);
        this.campY.push(gy);
        // One male and one female per village.
        //
        // Sex is a coin flip in `Agents.alloc`, and a village whose two
        // founders came up the same way can never produce a child: `breed`
        // requires a bonded pair and `findPartner` filters on the opposite
        // sex. A village of two has no margin at all — lose either founder to
        // the first predator that walks past and the lineage is over
        // permanently, with no third animal to replace it. Measured, that is
        // exactly what happened: 2 of 3 villages ended runs holding 2 to 7
        // animals while the third held 66 to 113, on sites whose habitat
        // scores were within 2 to 5% of each other. Equal ground, unequal
        // outcome, so the cause is the founding pair and not the terrain.
        this.agents.sex[i] = m;
        pair.push(i);
      }
      if (pair.length === 2) this.coupleFounders(pair[0], pair[1]);
    }
    // Any founders left over (a caller asking for more than 2*VILLAGES) go to
    // the last village rather than being dropped on the floor.
    for (let k = sites.length * 2; k < n; k++) {
      const [cx, cy] = sites[sites.length - 1];
      const [x, y] = this.nearFoundingCell(cx, cy);
      const i = this.agents.alloc(this.rng, x, y);
      if (i < 0) break;
      initBrain(this.brains, i * N_PARAMS, this.rng);
      this.agents.bornTick[i] = 0;
      this.agents.campX[i] = cx;
      this.agents.campY[i] = cy;
      this.campX.push(cx);
      this.campY.push(cy);
    }
    this.buildCampField();
  }

  /**
   * The score `findHabitable` maximises, hoisted so a whole village set can be
   * chosen against it without re-deriving it per candidate.
   *
   * This is a copy of the arithmetic in `World.findHabitable` and it has to
   * stay a copy rather than becoming a call: the greedy pass needs to score
   * thousands of candidate cells, and the map's own version re-derives its
   * answer by sampling 4,000 random points and returning one of them. Greedy
   * farthest-point is only farthest-point if every candidate is scored the
   * same way, and a random sample of 4,000 is not a scoring function.
   * -Infinity is the "uninhabitable" answer, so it loses every comparison.
   */
  private habitatScore(x: number, y: number): number {
    const w = this.world;
    const i = w.idx(x, y);
    const ter = w.terrain[i];
    if (ter === T_ROCK || ter === T_WATER || ter === T_SNOW || ter === T_MARSH
        || ter === T_SAND || ter === T_CAVE) return -Infinity;
    let food = 0;
    for (let dy = -8; dy <= 8; dy += 2) {
      for (let dx = -8; dx <= 8; dx += 2) {
        const nx = x + dx, ny = y + dy;
        if (!w.inBounds(nx, ny)) continue;
        food += w.plant[w.idx(nx, ny)];
      }
    }
    if (food < 1) return -Infinity;
    const wd = w.waterDist[i];
    if (wd < 0 || wd > 70) return -Infinity;
    let open = 0;
    for (let dy = -3; dy <= 3; dy += 1) {
      for (let dx = -3; dx <= 3; dx += 1) {
        const nx = x + dx, ny = y + dy;
        if (!w.inBounds(nx, ny)) continue;
        const nt = w.terrain[w.idx(nx, ny)];
        if (nt === T_OPEN || nt === T_DEAD) open++;
      }
    }
    if (open < 40) return -Infinity;
    // and away from the rim, where the generator has already put mountains
    const r = Math.hypot(x - GRID_CX, y - GRID_CY) / (Math.hypot(GRID_W, GRID_H) / 2);
    return food * 1.0 - wd * 0.35 + open * 0.12 - r * 12;
  }

  /**
   * `count` founding sites at least VILLAGE_GAP apart, by greedy
   * farthest-point.
   *
   * First pick is the global best. Every pick after it is the best-scoring
   * cell that is at least VILLAGE_GAP from all of them, which is the whole
   * algorithm: it trades a slightly worse site for a village that is actually
   * a village. Scanned on a 4-cell lattice — the score is a smoothed field
   * (a 17x17 food sum and a 7x7 openness count), so a finer lattice costs
   * four times the work to move the answer by a cell or two.
   *
   * Relaxing the gap before giving up on a village. A world with two villages
   * is worse than one with three, but a world with one is not a world with
   * villages in it — and a greedy pass that gave up would hand back a single
   * site and quietly seed all six founders on it, which is the single-village
   * layout this whole change exists to leave behind. VILLAGE_GAP is measured
   * in cells of separation, and on a cramped map there is honest no room for
   * three sites that far apart; shrinking toward CAMP_SEP*4 keeps them
   * distinct places rather than pretending the map has room it does not.
   */
  private villageSites(count: number): [number, number][] {
    const picks: [number, number][] = [];
    const minGap = CAMP_SEP * 4;
    for (let gap = VILLAGE_GAP; gap >= minGap && picks.length < count; gap -= VILLAGE_GAP / 4) {
      let bx = -1, by = -1, bs = -Infinity;
      for (let y = 4; y < GRID_H - 4; y += 4) {
        for (let x = 4; x < GRID_W - 4; x += 4) {
          if (picks.length > 0) {
            let tooClose = false;
            for (let p = 0; p < picks.length; p++) {
              if (Math.hypot(picks[p][0] - x, picks[p][1] - y) < gap) { tooClose = true; break; }
            }
            if (tooClose) continue;
          }
          const s = this.habitatScore(x, y);
          if (s > bs) { bs = s; bx = x; by = y; }
        }
      }
      if (bx < 0) continue;   // nothing this gap can satisfy; try a smaller one
      picks.push([bx, by]);
    }
    return picks;
  }

  /**
   * Two standable camp cells CAMP_SEP apart, for one village's two founders.
   *
   * Opposed rather than adjacent, so the pair has to close the gap to court
   * and the camps read as two places on the map. Each walks out HALF of
   * CAMP_SEP from the site and then inwards until it finds ground a pixel can
   * stand on, because the site the greedy pass chose is scored for its
   * neighbourhood and not for its own eight cells: one of the two camps can
   * land in the river that the water term made the site attractive in the
   * first place.
   *
   * Half on each side, so the separation between the two camps is CAMP_SEP and
   * not twice it. CAMP_SEP is the number that has to be above CAMP_HOME_R=4
   * (so the camps are visibly distinct) and below SEEK_R=60 (so the pair can
   * find each other), and 18 satisfies both — but it is not the number the
   * constant was written about, and a distance field is not worth having a
   * wrong comment on.
   */
  private findCampPair(cx: number, cy: number): [[number, number], [number, number]] {
    const half = Math.max(1, Math.round(CAMP_SEP / 2));
    const a = this.campCellTowards(cx, cy, 1, 0, half);
    const b = this.campCellTowards(cx, cy, -1, 0, half);
    return [a, b];
  }

  /** Walk from (cx,cy) along (ux,uy) for up to `r` cells, then inwards. */
  private campCellTowards(
    cx: number, cy: number, ux: number, uy: number, r: number,
  ): [number, number] {
    const w = this.world;
    for (let d = r; d >= 0; d--) {
      const nx = Math.round(cx + ux * d), ny = Math.round(cy + uy * d);
      if (w.inBounds(nx, ny) && w.passable(nx, ny)) return [nx, ny];
    }
    return [cx, cy];
  }

  /**
   * The actual birth cell for a founder: a few cells around its camp, so the
   * two founders are near each other but never stacked. Two pixels on one tile
   * are at distance 0 and every sensor discards them as "not there", which is
   * the failure FOUNDER_SPREAD exists to prevent — and it is the whole reason
   * the bonding assist below is allowed to work at all.
   */
  private nearFoundingCell(cx: number, cy: number): [number, number] {
    const w = this.world;
    for (let t = 0; t < 64; t++) {
      const nx = cx + this.rng.int(FOUNDER_SPREAD * 2 + 1) - FOUNDER_SPREAD;
      const ny = cy + this.rng.int(FOUNDER_SPREAD * 2 + 1) - FOUNDER_SPREAD;
      if (w.inBounds(nx, ny) && w.passable(nx, ny)) return [nx, ny];
    }
    return [cx, cy];
  }

  /**
   * Start each village's pair already bonded, and standing together.
   *
   * A mechanism, not a special case: it writes `mate`, `bond` and the LOVE
   * hormone for any two animals that are a founder pair, and every one of
   * those three fields is exactly what `court` would have written had the two
   * of them stood still long enough. Nothing in the tick loop consults it —
   * there is no "is a founder" flag anywhere, and no branch keyed on one. A
   * pair that bonds this way is indistinguishable from a pair that courted
   * its way there, which is the property that makes it a mechanism rather
   * than a founder-shaped exception.
   *
   * Why it is needed at all: see `seedPopulation`. A village of exactly two
   * has no margin, and without this the two of them spend the first hundred
   * ticks failing to stand next to each other long enough to bond, which is
   * the whole window in which a predator or a bad night can end the lineage.
   *
   * The two are brought to a shared standable cell a couple of cells apart
   * rather than to the midpoint of their camps: the midpoint of two camps
   * CAMP_SEP apart is on the line between them and may well be the river the
   * site was picked next to, so the shared cell is searched outwards and the
   * pair is seated on whichever two cells around it are standable.
   */
  private coupleFounders(p: number, q: number): void {
    const a = this.agents;
    // Seat them together. Search outwards from the midpoint of where they
    // already stand for the first standable cell, then put the second animal
    // on a neighbour of the first — distance 0 is not "adjacent", it is
    // "invisible": every sensor discards a pixel standing on the same tile as
    // another, so a pair seated on one cell courts nothing at all.
    const mx = Math.round((a.ax[p] + a.ax[q]) / 2);
    const my = Math.round((a.ay[p] + a.ay[q]) / 2);
    const seat = this.standableCellNear(mx, my);
    if (seat) {
      a.ax[p] = seat[0]; a.ay[p] = seat[1];
      const beside = this.standableCellNear(seat[0] + FOUNDER_SPREAD, seat[1])
        ?? this.standableCellNear(seat[0] - FOUNDER_SPREAD, seat[1]);
      if (beside) { a.ax[q] = beside[0]; a.ay[q] = beside[1]; }
    }
    a.mate[p] = q; a.mate[q] = p;
    // BOND_LOYALTY is what `court` climbs to before a bond stops being
    // breakable. Starting there means the pair has already paid the
    // courtship; a fresh pair that starts at 0 has to survive being
    // interrupted, and in a village of two the interruption is usually the
    // death of the other founder, which ends the lineage outright.
    a.bond[p] = BOND_LOYALTY; a.bond[q] = BOND_LOYALTY;
    a.setH(p, H.LOVE, BOND_LOYALTY); a.setH(q, H.LOVE, BOND_LOYALTY);
  }

  /**
   * The first standable cell at or near (cx, cy), searching outwards ring by
   * ring, or null if there is nothing standable within CAMP_SEP.
   */
  private standableCellNear(cx: number, cy: number): [number, number] | null {
    const w = this.world;
    for (let r = 0; r <= CAMP_SEP; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx, ny = cy + dy;
          if (w.inBounds(nx, ny) && w.passable(nx, ny)) return [nx, ny];
        }
      }
    }
    return null;
  }

  /**
   * Breadth-first walk out from every camp at once, 4-connected, refusing
   * rock — the same shape as `World.buildWaterField`, over the same queue.
   */
  private buildCampField(): void {
    this.campDist.fill(-1);
    if (this.campX.length === 0) return;
    const w = this.world;
    const q = new Int32Array(GRID_SIZE);
    let head = 0, tail = 0;
    for (let k = 0; k < this.campX.length; k++) {
      if (!w.inBounds(this.campX[k], this.campY[k])) continue;
      const i = w.idx(this.campX[k], this.campY[k]);
      if (this.campDist[i] !== -1) continue;
      this.campDist[i] = 0;
      q[tail++] = i;
    }
    while (head < tail) {
      const i = q[head++];
      const x = i % GRID_W, y = (i / GRID_W) | 0;
      const d = this.campDist[i] + 1;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
        const j = w.idx(nx, ny);
        if (this.campDist[j] !== -1) continue;
        if (w.terrain[j] === T_ROCK) continue;
        this.campDist[j] = d;
        q[tail++] = j;
      }
    }
  }

  /**
   * The step that walks toward the nearest camp, or -1 if it is standing in
   * one or there is nothing to walk to.
   *
   * The predator's counterpart to `World.waterStep` and `World.foodStep`, and
   * for the same reason they exist: a gradient is the only way an animal that
   * cannot see its goal ever arrives at it. Descending `campDist` rather than
   * walking `sign(camp - pos)` is what keeps this consistent with the leash,
   * which is also measured in walked cells.
   */
  private campStep(x: number, y: number): number {
    if (!this.world.inBounds(x, y)) return -1;
    const here = this.campDist[this.world.idx(x, y)];
    if (here <= 0) return -1;
    let bestStep = -1, best = here;
    for (let k = 0; k < N_MOVE; k++) {
      if (k === 4) continue;
      const nx = x + MOVE_DX[k], ny = y + MOVE_DY[k];
      if (!this.world.inBounds(nx, ny)) continue;
      const d = this.campDist[this.world.idx(nx, ny)];
      if (d >= 0 && d < best) { best = d; bestStep = k; }
    }
    return bestStep;
  }

  /**
   * How far a predator may range from this den before it turns back.
   *
   * The base leash, widened if the prey is further away than that. A den
   * whose territory provably holds no prey is not a territory, it is a rock
   * with an animal shut in it, and the base leash is what put the animal
   * there. Widened to the walk to the nearest camp it stops doing that while
   * still bounding the animal: past the village it turns round, so a hunt
   * still cannot quietly become a migration to the far side of the map.
   *
   * Measured from the den, and that is the whole subtlety. The first version
   * asked how far the *animal* was from the prey, which is the same number
   * in the wrong place: the allowance shrank as the animal closed on the
   * village, so a predator 155 cells from home walking toward a village 150
   * cells away was turned around on the doorstep, 77 cells out instead of 25.
   * The run came back byte-identical, which is how that was found. A leash
   * belongs to a place. It does not move because the animal using it did.
   */
  denLeash(den: number): number {
    const w = this.world;
    if (den < 0 || den >= w.caveX.length) return PRED_HUNT_LEASH;
    if (!w.inBounds(w.caveX[den], w.caveY[den])) return PRED_HUNT_LEASH;
    const toPrey = this.campDist[w.idx(w.caveX[den], w.caveY[den])];
    if (toPrey < 0) return PRED_HUNT_LEASH; // no prey reachable from there
    return Math.max(PRED_HUNT_LEASH, toPrey);
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
    // Fire burns before things move through it, so a pixel that steps into a
    // blaze this tick is hurt by it this tick rather than next. Order against
    // `huntPredators` is the other way round on purpose: a predator that walks
    // into fire has already chosen to be there, and `PRED_FIRE_AVOID` stops it
    // getting there — it should not be punished again for the fire that the
    // avoidance failed to prevent, because then fire is a wall with a tax.
    this.stepFire();
    this.huntPredators();
    this.resolveMobs();
    this.breedPredators();
    this.reseedPredators();
    this.checkVillages();
    this.reap();
    this.record();
  }

  /**
   * Keep the map's villages alive: count them, re-found the empty ones, and
   * let a pixel leave a village that is failing.
   *
   * Three parts, and each one answers a different way a village dies.
   *
   * **The census** is a tally of `agents.founder[i]` over the living slots,
   * into `campPop`. It is the only place that knows which villages exist.
   *
   * **The re-founding** is the same bargain made with the predators: a village
   * that has fallen to `VILLAGE_REFOUND_FLOOR` is a village that cannot breed
   * (`findPartner` needs an eligible partner of the opposite sex) and so is
   * not a village that is small, it is one that is already over. It gets
   * `VILLAGE_REFOUND_COUNT` fresh pixels on a fresh pair of camps sited by the
   * same greedy farthest-point rule the founders used, so a re-founded village
   * lands on ground as good as a founding one. The camps go in the table, the
   * pixels carry them as their founder id, and the lineage is a real lineage
   * again.
   *
   * **The migration** is the part that stops the collapse rather than mopping
   * it up, and it is deliberately the smallest of the three. Villages are
   * sealed: a pixel's camp is fixed at birth and `homePull` pulls it back
   * there, so a pixel can never join the village next door. Three sealed
   * populations are three populations whose fates are decided by whichever one
   * had a better run of births, and the losers have no way back — which is
   * exactly what was measured, 88% of the population inside one of three
   * founding villages, the winner being the village with the *least* food.
   *
   * So a pixel that is lonely, has no partner, and stands well outside its own
   * camp may switch to the nearest camp, but only if that camp has company
   * and its own is empty. That is a starved animal looking for a home rather
   * than a mass migration, which is the difference between a world that
   * recovers from a bad patch and a world that empties into whichever village
   * happens to be winning.
   */
  private checkVillages(): void {
    if (this.villageCheckT > 0) { this.villageCheckT--; return; }
    this.villageCheckT = VILLAGE_CHECK_EVERY;
    const a = this.agents;
    this.campPop.fill(0);
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (!a.alive[i]) continue;
      const f = a.founder[i];
      if (f >= 0 && f < MAX_CAMP_SLOTS) this.campPop[f]++;
    }
    this.migrateStrays();
    this.refoundVillages();
  }

  /**
   * A pixel from a failing village may join a thriving one.
   *
   * The first version of this moved a pixel only when its own village was
   * *completely* empty, on the reasoning that a village should not be drained.
   * Measured, that guard made the pass inert: at t=1500 there were 201 pixels
   * that were lonely, had no partner, and stood away from their own camp —
   * and not one of them moved, because the village they were leaving still had
   * *someone* in it. By the time a village did empty there was nobody left
   * inside it to migrate, and the collapse finished exactly as before.
   *
   * So the test is comparative: a destination holding at least
   * `VILLAGE_MIGRATE_WANT_POP` times as many as the source. That is a
   * gradient, and it is what lets three populations correct for each other.
   *
   * One thing keeps it from being a mass exodus. A pixel has to be *wanting*
   * company (lonely, or past fertility with nobody to mate) — a fed adult
   * with a mate scores near zero on both and never qualifies, so this is a
   * rescue and not a tide. And the ratio bounds the flow: animals go from
   * weak to strong until the two are within a factor of two, and then the
   * destination stops qualifying and the flow stops with it.
   *
   * What this does NOT do is equalise the villages, and the measurement says
   * so plainly. Dropping the absolute source floor — which had made the pass
   * inert, since 380 of 383 pixels sat above it at t=1000 while their village
   * held 25 against a neighbour's 348 — made things *worse*, not better:
   * at t=3000 the camps read [0,0,0,38,341,0] and the world had shrunk from
   * 555 to 372. Migration moves animals toward the winner; it does not move
   * them toward balance, because the imbalance is a birth rate and not a
   * shortage of travellers. The pass is kept because a village holding
   * nothing at all is still a village that should not be empty, and that is
   * the case it rescues.
   */
  private migrateStrays(): void {
    const a = this.agents;
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (!a.alive[i]) continue;
      const home = a.founder[i];
      if (home < 0 || home >= this.campX.length) continue;
      // alone, with a reason to want company
      if (a.h(i, H.LONELY) < 0.5 && a.h(i, H.DESIRE) < 0.6) continue;
      // and far enough out that it is already in the open
      const dHome = Math.hypot(a.ax[i] - this.campX[home], a.ay[i] - this.campY[home]);
      if (dHome < CAMP_HOME_R) continue;
      // The nearest camp that is doing meaningfully better than this one.
      //
      // There is deliberately NO absolute floor on the source village here.
      // There was, at VILLAGE_MIGRATE_MIN_POP=8, and it made the pass inert:
      // measured at t=1000, 380 of 383 living pixels were in camps above that
      // floor, so the test returned before the destination was ever considered,
      // and a village holding 25 pixels next to one holding 348 — a ratio of
      // fourteen to one, the exact imbalance the pass exists to correct — was
      // not a single animal's idea of moving. The comparison has to be
      // between the two villages and nothing else, because a village two
      // hundred cells from any other village on this map is never going to be
      // under eight for long and never needs rescuing on those grounds.
      let best = -1, bestD = VILLAGE_MIGRATE_R;
      for (let c = 0; c < this.campX.length; c++) {
        if (c === home) continue;
        if (this.campPop[c] < (this.campPop[home] + 1) * VILLAGE_MIGRATE_WANT_POP) continue;
        const d = Math.hypot(a.ax[i] - this.campX[c], a.ay[i] - this.campY[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (best < 0) continue;
      a.founder[i] = best;
      a.campX[i] = this.campX[best];
      a.campY[i] = this.campY[best];
      this.campPop[home]--;
      this.campPop[best]++;
      // and it is born into a new lineage, not adopted into the old one: the
      // brain it arrives with is a fresh one, because a pixel that keeps its
      // parent's weights and changes its village is a pixel whose behaviour
      // was learned in one place and is now expressed in another.
      initBrain(this.brains, i * N_PARAMS, this.rng);
      this.hist.clear(i);
    }
  }

  /**
   * Re-found a village that has died out, on the same terms the founders got.
   *
   * A new pair of camps is sited by the greedy farthest-point pass, with the
   * dead village's own sites excluded — so the new village goes somewhere
   * else rather than onto the two patches of ground that just proved they
   * cannot hold anybody.
   */
  private refoundVillages(): void {
    // No slot guard: re-founding now reuses the dead village's own two camps,
    // so the table cannot grow past what `seedPopulation` put in it. The guard
    // was only ever there because this used to push two new camps per repair.
    if (this.campX.length === 0) return;
    // The cooldown is counted in TICKS, not in census passes. It was decremented
    // once per call and the call runs every VILLAGE_CHECK_EVERY=60 ticks, so a
    // 200-tick cooldown actually took 12,000 ticks to expire — which is longer
    // than most runs, and the whole reason a village that emptied at t=2000 was
    // still empty at t=3000 while this function sat on a counter at 159.
    if (this.refoundT > 0) { this.refoundT -= VILLAGE_CHECK_EVERY; return; }
    const empty: number[] = [];
    // A village is re-founded only if it is holding a negligible share of the
    // world, not merely a small absolute number. The absolute floor alone is
    // what turned this into a runaway: ordinary churn dips a village to one
    // pixel for a census or two, that gets "repaired", the repair dips to one,
    // and 28 re-foundings later the whole camp table is full of half-villages
    // and the map has more camps than it has animals.
    const share = Math.max(1, a0(this) * VILLAGE_REFOUND_FRACTION);
    for (let c = 0; c < this.campX.length; c += 2) {
      // a village is its two camps; either pair being empty means it is empty
      const here = this.campPop[c] ?? 0;
      const there = this.campPop[c + 1] ?? 0;
      const pop = here + there;
      if (pop < VILLAGE_REFOUND_FLOOR && pop < share) empty.push(c);
    }
    if (empty.length === 0) { this.refoundT = VILLAGE_REFOUND_COOLDOWN; return; }
    this.refoundT = VILLAGE_REFOUND_COOLDOWN;
    for (const start of empty) {
      // Re-found the village ON ITS OWN GROUND, reusing its two camp slots.
      //
      // It used to site a new pair and push two more camps onto the table,
      // which meant the table only ever grew: 28 re-foundings and 62 slots
      // consumed by t=2500, the map covered in camp rings, and the population
      // still stacked 376 of 480 into the one village that was working. The
      // sites a village occupied are not the problem — the animals were — and
      // putting new animals on the old ground is exactly the same village with
      // the same food and the same neighbours, which is the thing that already
      // failed once.
      //
      // The only reason to move a village is if its ground is genuinely
      // unusable, and that is rare enough to be worth the table growing for,
      // so the test is whether the old site can still hold anybody: same
      // `habitatScore` the founders were sited on, -1 if it cannot.
      const cx = this.campX[start], cy = this.campY[start];
      let gx = cx, gy = cy;
      if (this.habitatScore(cx, cy) === -Infinity) {
        const site = this.refoundSite(cx, cy);
        gx = site[0]; gy = site[1];
        const camps = this.findCampPair(gx, gy);
        this.campX[start] = camps[0][0]; this.campY[start] = camps[0][1];
        if (start + 1 < this.campX.length) {
          this.campX[start + 1] = camps[1][0]; this.campY[start + 1] = camps[1][1];
        }
      }
      const pair: number[] = [];
      for (let k = 0; k < VILLAGE_REFOUND_COUNT; k++) {
        const c = start + (k % 2);
        if (c >= this.campX.length) break;
        const sx = this.campX[c], sy = this.campY[c];
        const [x, y] = this.nearFoundingCell(sx, sy);
        const i = this.agents.alloc(this.rng, x, y);
        if (i < 0) break;
        initBrain(this.brains, i * N_PARAMS, this.rng);
        this.agents.bornTick[i] = this.tick;
        this.agents.campX[i] = sx;
        this.agents.campY[i] = sy;
        this.agents.founder[i] = c;
        this.agents.sex[i] = k % 2;   // a pair of each, plus one spare
        this.campPop[c] = (this.campPop[c] ?? 0) + 1;
        pair.push(i);
      }
      if (pair.length >= 2) this.coupleFounders(pair[0], pair[1]);
      this.villagesRefounded++;
    }
    this.buildCampField();
  }

  /**
   * Somewhere for a dead village to be re-founded: the best ground that is
   * not already a camp and not on top of the village that just died.
   *
   * A `villageSites` pass restricted to the cells that are neither. It is the
   * same scorer, so a re-founded village is sited on ground as good as a
   * founding one, and the same greedy rule, so two re-found villages do not
   * land on each other.
   */
  private refoundSite(deadX: number, deadY: number): [number, number] {
    let bx = -1, by = -1, bs = -Infinity;
    for (let y = 4; y < GRID_H - 4; y += 4) {
      for (let x = 4; x < GRID_W - 4; x += 4) {
        if (this.campDist[this.world.idx(x, y)] < 0) continue;   // unreachable
        let tooClose = false;
        for (let k = 0; k < this.campX.length; k++) {
          if (Math.hypot(this.campX[k] - x, this.campY[k] - y) < CAMP_SEP * 4) {
            tooClose = true; break;
          }
        }
        if (Math.hypot(deadX - x, deadY - y) < VILLAGE_GAP) tooClose = true;
        if (tooClose) continue;
        const s = this.habitatScore(x, y);
        if (s > bs) { bs = s; bx = x; by = y; }
      }
    }
    return bx < 0 ? [Math.round(GRID_CX), Math.round(GRID_CY)] : [bx, by];
  }

  /**
   * Re-found the predator species if it has died out.
   *
   * The user asked for this and it is not a patch over the ceiling bug: even
   * with `PRED_SOFT_CAP` above `START_PREDATORS`, a species with a 1500-tick
   * lifespan, a four-animal ceiling and a breeding gate that needs a fed pair
   * standing at a den is a population that random-walks, and a long enough
   * unlucky run ends it. Nothing else in the world notices. A world of four
   * hundred pixels and no predators is a world that has silently lost half its
   * simulation, and it keeps running — births climb, the grass grows back, and
   * the only evidence is a sidebar number that stopped moving.
   *
   * So the world re-seeds. Two animals, one of each sex, at a den, which is
   * the only configuration that can produce a third: `breedPredators` requires
   * a bonded pair sharing a den, and a single re-seeded animal would live out
   * another fifteen hundred ticks alone and leave the world where it started.
   *
   * Dens first, and only a den with prey reachable from it. A species restored
   * to a cave in a corner that no pixel can walk to is a species that exists
   * on the sidebar and not on the map, which is the same silent failure one
   * layer down. `denPull` already scores dens on exactly this — `campDist` is
   * the walked distance to the nearest camp and -1 means unreachable — so the
   * choice reuses that answer rather than inventing a second one.
   */
  private reseedPredators(): void {
    const p = this.predators, w = this.world;
    if (p.count > PRED_RESEED_FLOOR) {
      this.predReseedT = 0;
      return;
    }
    if (this.predReseedT > 0) { this.predReseedT--; return; }
    this.predReseedT = PRED_RESEED_COOLDOWN;
    if (p.count >= PRED_SOFT_CAP) return;
    // Prey has to exist, or the restored animals starve where they stand and
    // the world re-seeds a corpse. This is the same precondition breeding has.
    if (this.agents.count < PRED_BREED_MIN_PREY) return;
    // A den the prey can actually be walked to. A den with no reachable camp
    // scores -1 and is skipped, so a world where the generator put every cave
    // in a sealed range falls through to the no-den path below rather than
    // restoring a species inside a rock.
    let den = -1, bestScore = Infinity;
    for (let d = 0; d < w.caveX.length; d++) {
      if (!w.inBounds(w.caveX[d], w.caveY[d])) continue;
      const prey = this.campDist[w.idx(w.caveX[d], w.caveY[d])];
      if (prey < 0) continue;
      if (prey < bestScore) { bestScore = prey; den = d; }
    }
    // Prefer an empty den, so a re-founding does not stack four animals on
    // the one rock that still has somebody living in it.
    if (den >= 0) {
      for (let d = 0; d < w.caveX.length; d++) {
        if (d === den || !w.inBounds(w.caveX[d], w.caveY[d])) continue;
        if (this.campDist[w.idx(w.caveX[d], w.caveY[d])] < 0) continue;
        let occ = 0;
        for (let k = 0; k < MAX_PREDATORS; k++) if (p.alive[k] && p.den[k] === d) occ++;
        if (occ === 0) { den = d; break; }
      }
    }
    const [mx, my] = den >= 0
      ? this.denMouth(den, this.predReseedT % 2)
      : [this.founderX, this.founderY];
    if (mx < 0) return;
    // One male, one female. The order matters only for the sex cap, which is
    // derived from PRED_SOFT_CAP and cannot be tripped by a single pair.
    for (let k = 0; k < PRED_RESEED_COUNT; k++) {
      const [x, y] = k === 0 ? [mx, my] : this.denMouth(den >= 0 ? den : -1, 1);
      const sx = x < 0 ? mx : x, sy = x < 0 ? my : y;
      if (!w.inBounds(sx, sy)) continue;
      const sex = k % 2 === 0 ? PRED_MALE : PRED_FEMALE;
      if (p.alloc(sx, sy, k === 0 ? PRED_LARGE : PRED_SMALL, den, 0, sex) < 0) return;
    }
    this.predReseeded++;
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
        // The three item verbs, here and not in the movement switch above,
        // because they act on the cell the pixel LANDED ON rather than
        // replacing the move. A gather is "walk onto the rock and pick it
        // up", not "stop walking because you chose to pick something up" —
        // and the whole of the movement head is wasted if a verb can cancel
        // it. `REST` above is the one that overrides, and that is a different
        // kind of thing: rest means stand still, which is a complete
        // statement about where to be.
        case Verb.GATHER: {
          reward += this.gatherItem(i);
          break;
        }
        case Verb.DROP: {
          reward += this.dropItem(i);
          break;
        }
        case Verb.COMBINE: {
          reward += this.combineItems(i);
          break;
        }
        // IDLE, SEEK_MATE and MATE-KILL and FLEE are handled above; an explicit
        // IDLE arm so the switch is total over the verb set rather than
        // silently falling through on a value nobody wrote. The default below
        // is deliberately empty and commented: a new verb that is added to
        // `Verb` and not handled should do nothing and be visible, not do
        // whatever the last writer left in the case.
        case Verb.IDLE:
        default: {
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

  /**
   * A heading that steps around a burning cell rather than into it, or -1 if
   * there is none.
   *
   * Tries the two headings that flank the intended one and then the reverse,
   * which is the same preference order `slide` uses — so a fire and a cliff
   * are the same kind of obstacle to this animal and it has one rule for
   * both. Only cells that are cooler than the one it was refused are offered,
   * so an animal walking along the edge of a fire is pushed along it rather
   * than off it, and a fire with no cool side is a wall it stops at instead
   * of a fire it walks into.
   */
  private fireDetour(x: number, y: number, dx: number, dy: number): number {
    const w = this.world;
    const tries = SLIDE_ORDER[moveIndexOf(dx, dy)];
    const hot = w.fire[w.idx(
      clampCell(x + dx, GRID_W), clampCell(y + dy, GRID_H))] / FIRE_BURN_TICKS;
    for (let k = 0; k < tries.length; k++) {
      const s = tries[k];
      if (s === 4 || s === 0) continue;   // no move, and not straight back into it
      const nx = x + MOVE_DX[s], ny = y + MOVE_DY[s];
      if (!w.inBounds(nx, ny) || w.terrain[w.idx(nx, ny)] === T_ROCK) continue;
      if (w.fire[w.idx(nx, ny)] / FIRE_BURN_TICKS < hot) return s;
    }
    return -1;
  }

  private tryMove(i: number, dx: number, dy: number): boolean {
    if (dx === 0 && dy === 0) return false;
    const a = this.agents, w = this.world;
    const x = a.ax[i], y = a.ay[i];
    let [nx, ny] = this.slide(x, y, dx, dy);
    // Swimming out of water, not into it. `slide` rejects only T_ROCK, so a
    // pixel can walk into a river and the WATER_MULTIPLIER below is the only
    // thing that prices it — which is a cost, not a rule, and a pixel with
    // energy to burn will happily sit in a river. That is not a bug until it
    // is stranded: the food and camp gradients are multi-source BFS fields
    // that do not route through water, so a pixel standing in it gets
    // foodStep = -1, and if it is also within CAMP_HOME_R of its camp then
    // campStep = -1 too ("you are home"), and waterStep = -1 is correct
    // because it is already in the water. All three headings gone at once.
    //
    // Measured on seed 20260927 at t=1500: 2 of 364 living pixels were in
    // exactly that state, on a water tile with zero food anywhere in a
    // four-cell ring, and the render suite's "every living pixel has a way to
    // live" check failed on them. They were not starving and not thirsty —
    // they had walked into a dead pocket and had no reason to leave.
    //
    // So a pixel that is ALREADY in water takes the first dry cell the slide
    // order offers, and only accepts another water cell if there is no land
    // within reach. A pixel on dry ground is untouched: crossing a river on
    // the way somewhere is still allowed and still costs, because the slide
    // order is only consulted for the dry alternative once the pixel is
    // already wet.
    if (w.terrain[w.idx(x, y)] === T_WATER) {
      const tries = SLIDE_ORDER[moveIndexOf(dx, dy)];
      for (let k = 0; k < tries.length; k++) {
        const s = tries[k];
        if (s === 4) continue;
        const tx = x + MOVE_DX[s], ty = y + MOVE_DY[s];
        if (!w.inBounds(tx, ty) || w.terrain[w.idx(tx, ty)] === T_ROCK) continue;
        if (w.terrain[w.idx(tx, ty)] === T_WATER) continue;
        nx = tx; ny = ty;
        break;
      }
    }
    if (nx === x && ny === y) return false;
    a.ax[i] = nx; a.ay[i] = ny;
    const wet = w.terrain[w.idx(nx, ny)] === T_WATER ? WATER_MULTIPLIER : 1;
    a.energy[i] -= MOVE_ENERGY_COST * (0.4 + a.g(i, GENE.MOVE_COST)) * wet;
    return true;
  }

  // --- loose items ---------------------------------------------------------
  //
  // Three verbs, and the thing that makes them a different shape of rule from
  // MATE and KILL is that they do not override the move. The movement head
  // runs first and these execute against the cell the pixel landed on, so a
  // pixel that has learned to walk onto a rock can still be walking while it
  // picks the rock up. An overriding verb is what REST is, and a body of
  // overriding verbs is how a brain ends up not walking at all.

  /**
   * Take the nearest loose item within reach into this pixel's hands.
   *
   * NEAREST, not best. There is no "best" available to a function that is not
   * allowed to know what an item is for, and the question the design review
   * actually settled is narrower than "best": it is "which thing", and the
   * only honest answer to that is "the one you are standing next to". A
   * scoring rule here would be a rule about materials wearing a pixel's
   * clothes — a pixel walking past a rock toward a stick because rock scored
   * lower is a world in which the game is deciding what rock is for, and the
   * whole point of the item set is that the game does not get to.
   *
   * Tie-broken by kind index, purely so the result is deterministic: a pixel
   * standing between a rock and a stick picks the lower-indexed one and the
   * run is reproducible. That is a reproducibility decision, not a preference.
   *
   * GATHER_REWARD is scaled by how much actually fitted rather than paid flat,
   * because `addCarry` is allowed to leave the overflow on the ground — a
   * gather that found four rocks into one free hand has done a quarter of the
   * work and is paid a quarter of the reward, so the credit matches the act.
   */
  private gatherItem(i: number): number {
    const a = this.agents, w = this.world;
    if (a.gatherT[i] > 0) return 0;
    if (a.carryRoom(i) <= 0) return 0;
    const x = a.ax[i], y = a.ay[i];
    let kind = -1, bestD = Infinity, cell = -1;
    for (let oy = -TAKE_R; oy <= TAKE_R; oy++) {
      for (let ox = -TAKE_R; ox <= TAKE_R; ox++) {
        // Chebyshev within the reach square, so "beside" and "diagonally
        // beside" are both in reach — the item rays the brain reads run on
        // the same 8-neighbourhood the pickup uses.
        if (Math.abs(ox) > TAKE_R || Math.abs(oy) > TAKE_R) continue;
        const kx = x + ox, ky = y + oy;
        if (!w.inBounds(kx, ky)) continue;
        const k = w.idx(kx, ky);
        const d = ox * ox + oy * oy;
        if (d >= bestD) continue;
        // Only the two kinds that live on the item layer. `World.itemField`
        // folds every non-ROCK kind onto its stick array, so scanning up to
        // N_ITEMS here asked for MEAT and got sticks back — measured: the
        // stick and "meat" cell counts were byte-identical at t=0, 1000 and
        // 3000 (3109/3109, 3708/3708, 4943/4943), because a pixel
        // "gathering meat" was picking a stick up a second time and
        // portioning it by MEAT_PER_CARRY.
        //
        // Meat is not an item and must not become one. It has its own field,
        // its own addMeat/takeMeat and its own total, because a carcass is
        // food in the world rather than a thing lying about to be carried —
        // one economy, one number on the sidebar. `eat` reads that field
        // through the hold, and this verb does not touch it.
        for (let it = 0; it < 2; it++) {
          if (w.itemAt(k, it) <= 0) continue;
          kind = it; bestD = d; cell = k;
          break;
        }
      }
    }
    if (kind < 0 || cell < 0) return 0;
    // Take the amount off the ground FIRST and only then put it in the hands,
    // so a hand that fills up partway through leaves the remainder lying
    // there — the item left behind is still findable, and the pixel is paid
    // for what it actually picked up rather than for what it tried to.
    const got = w.takeItem(cell, kind, 1);
    if (got <= 0) return 0;
    const fitted = a.addCarry(i, kind, got);
    if (fitted <= 0) {
      w.dropItem(cell, kind, got);   // nowhere to put it: it stays on the map
      return 0;
    }
    if (fitted < got) w.dropItem(cell, kind, got - fitted);
    a.gatherT[i] = ITEM_PICKUP_COOLDOWN;
    return GATHER_REWARD * fitted;
  }

  /**
   * Put one carried item back on this pixel's own cell.
   *
   * The most-carried kind, which is a rule about the shape of the load and not
   * about what is in it. It is deliberately NOT "drop the rock first" or any
   * other ordering by material: that is the exact reasoning the design review
   * rejected, because it narrows rock to a weapon behind the scenes. A pixel
   * carrying four rocks and one stick drops a rock here, and so would a pixel
   * carrying four sticks and one rock, and the difference between those two
   * animals is one the world is not allowed to have an opinion about.
   *
   * Ties go to the lower kind index, for reproducibility and nothing else.
   */
  private dropItem(i: number): number {
    const a = this.agents, w = this.world;
    if (a.carryingTotal(i) <= 0) return 0;
    let kind = -1, best = 0;
    for (let it = 0; it < N_ITEMS; it++) {
      if (a.carrying(i, it) > best) { best = a.carrying(i, it); kind = it; }
    }
    if (kind < 0) return 0;
    const x = a.ax[i], y = a.ay[i];
    // Meat goes back through `addMeat`, never through `dropItem`, because it
    // was never on the item layer in the first place — it is a carcass in the
    // world that a pixel is carrying, not an item lying in it. Routing it
    // through `dropItem` would write a dead animal onto the stick array,
    // which is the same aliasing that made `gatherItem` hand back sticks when
    // it asked for meat.
    if (kind === Item.MEAT) w.addMeat(w.idx(x, y), 1);
    else w.dropItem(w.idx(x, y), kind, 1);
    a.carry[i * N_ITEMS + kind]--;
    a.carryCount[i]--;
    return 0;
  }

  /**
   * Fuse everything carried into one lump, set it down here, and hand the lump
   * to the world.
   *
   * EVERYTHING, and flat COMBINE_REWARD, with no bonus for any particular mix.
   * A pixel holding four rocks fuses four rocks into one lump and is paid the
   * same as one holding a rock and three sticks. If a mix is worth more that
   * is `maybeIgnite`'s business and it is the world's business, not this
   * function's — the whole point of the split is that a brain is handed the
   * ingredients and left to find out what they do.
   */
  private combineItems(i: number): number {
    const a = this.agents, w = this.world;
    if (a.combineT[i] > 0) return 0;
    if (a.carryingTotal(i) < 2) return 0;   // one thing is not a fusion
    const x = a.ax[i], y = a.ay[i];
    const cell = w.idx(x, y);
    let rockish = 0, woody = 0;
    for (let it = 0; it < N_ITEMS; it++) {
      const n = a.carrying(i, it);
      if (n <= 0) continue;
      if (it === Item.ROCK) rockish += n;
      else if (it === Item.STICK) woody += n;
    }
    // The lump is NOT left on the map as an item. It is consumed by the world
    // the moment it is set down: either it takes and becomes a burning cell,
    // or it does not and there is nothing there. That is deliberate and it is
    // the honest reading of "fuse everything carried into one lump, set it
    // down, and hand the lump to the ignition rule" — a lump a pixel can walk
    // back to and look at is a lump whose value the world has already judged,
    // and a brain that can look at it can learn that the pairing is special
    // from a sensor channel rather than from having made one.
    a.clearCarry(i);
    this.maybeIgnite(i, rockish, woody);
    a.combines[i]++;
    a.combineT[i] = COMBINE_COOLDOWN;
    return COMBINE_REWARD;
  }

  /**
   * The world's opinion about a lump of rock and a lump of stick.
   *
   * This is the whole of the fire chemistry, and it lives here on purpose.
   * A softstep on the (rockish, woody) pair against a threshold around (1,1):
   * a lump needs BOTH kinds before it will take, and the softness is what
   * stops the question "is this a good lump?" from having a cliff in it — two
   * rocks and no sticks is a softstep near zero and never catches, one rock
   * and one stick is a softstep of 0.5 and takes about half the time, and
   * that gradient is the whole of the learnable surface.
   *
   * What this function must never do is tell a pixel that any pairing is
   * worth anything, and it does not: nothing reads it back, it pays no
   * reward, and it does not set a hormone. A brain that has never combined
   * anything has no way to know the pairing exists. It is honest to say this
   * is the part of the design a TD learner is least likely to find on its
   * own — the reward for COMBINE is flat, the outcome is a stochastic ignite,
   * and the causal chain from "I held a rock and a stick" to "there is now
   * fire here" runs through a rule that is invisible to every channel the
   * brain has. It is reachable, but it is reachable by a learner that
   * happens to combine often enough and stand on flammable ground often
   * enough, not by anything the design can point at.
   */
  private maybeIgnite(i: number, rockish: number, woody: number): void {
    const a = this.agents, w = this.world;
    if (rockish <= 0 || woody <= 0) return;   // both kinds, or nothing
    const cell = w.idx(a.ax[i], a.ay[i]);
    if (!w.flammable(cell)) return;           // the world decides if it takes
    // softstep on the pair, threshold at (1,1), softness IGNITE_SOFTNESS
    const s = 1 / (1 + Math.exp(-(Math.min(rockish, 1) + Math.min(woody, 1) - 2) / IGNITE_SOFTNESS));
    if (!this.rng.chance(s)) return;
    w.ignite(cell, FIRE_BURN_TICKS);
    // `World.ignite` is a no-op on ground with nothing to burn and on a cell
    // already alight, so the cell it actually lit is only knowable by asking
    // afterwards. See `spreadTo` for why the second list exists.
    if (w.fire[cell] > 0) this.lightFire(cell);
  }

  /**
   * Eat whatever is underfoot. Meat is checked first and taken first: it
   * clears hunger outright and spikes dopamine, so a pixel that has learned
   * where predators kill has a reason to walk toward the killing ground.
   * Grass is a calorie; meat is a reward.
   *
   * Carried meat is eaten before ground meat, and it is the SAME `world.meat`
   * quantity seen through a hold. One economy, one number on the sidebar: a
   * pixel that picked up a half-carcass and walked away has not created a
   * second food supply, it has moved the first one into its hands, and the
   * total in the world is the total in the world whether it is on the ground
   * or in four pairs of hands. It is charged at MEAT_PER_CARRY a gather, so
   * carrying costs a fraction of a unit per pickup and the arithmetic of a
   * full meal is unchanged.
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
    // in hand first: eating what you are carrying is the whole point of
    // having picked it up, and it is a strictly smaller search than the
    // 4-cell sweep below for the same reward
    if (gap > 0.001) {
      const held = a.carrying(i, Item.MEAT);
      if (held > 0) {
        const bite = Math.min(held, gap);
        a.carry[i * N_ITEMS + Item.MEAT] -= bite;
        a.carryCount[i] -= bite;
        meat += bite;
      }
    }
    if (gap - meat > 0.001) {
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
    // The crowding that decides whether this child lives is measured against
    // its own village, not against the world — see `newbornSurvivalLocal`.
    // The world cap is still the hard ceiling; this is the half of the curve
    // that lets a village of 25 keep the babies a village of 400 cannot.
    const f = a.founder[p1];
    const villagePop = (f >= 0 && f < MAX_CAMP_SLOTS) ? this.campPop[f] : a.count;
    const survival = newbornSurvivalLocal(a.count, villagePop);
    const [x, y] = this.birthSpot(p1, p2);
    const i = a.alloc(this.rng, x, y);
    if (i < 0) return;
    // The census is every VILLAGE_CHECK_EVERY=60 ticks, and this is where the
    // crowding tax is read, so the tally cannot be allowed to go stale: a
    // village that has quietly grown by thirty newborns since the last census
    // would still be paying the tax of the size it had an hour ago.
    if (a.founder[i] >= 0 && a.founder[i] < MAX_CAMP_SLOTS) this.campPop[a.founder[i]]++;

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

  // --- fire ----------------------------------------------------------------
  //
  // The sparse fire list lives here rather than in `World`, and the reason is
  // that `World.fireList` is private and `World` has no way to run the
  // per-tick pass: the damage, the spread and the removal are all rules about
  // living things, and they were written here. `World.ignite` keeps its own
  // private list and its own `fireActive` counter, so this list is a second
  // index over the same `w.fire` field rather than a second fire — the cells
  // are the world's, the iteration is ours, and `w.fireActive` is rewritten
  // from this list at the end of every pass so the public counter stays the
  // truth rather than a monotone count of every fire ever lit.
  //
  // It exists at all because a full map pass is 0.528 ms against 0.3-10.2 us
  // for the walk over the lit cells, and a world with no fire in it is the
  // normal state. `fireActive === 0` short-circuits the whole pass on one
  // integer compare.

  /** Cells alight, packed at the front. Swap-removed, so no order is kept. */
  private fireCells = new Int32Array(GRID_SIZE);
  private fireN = 0;
  /** 1 if this cell is in `fireCells`. Lets `lightFire` be idempotent. */
  private fireIn = new Uint8Array(GRID_SIZE);

  /** Add a cell to the sparse list, if it is not already on it. */
  private lightFire(cell: number): void {
    if (this.fireIn[cell]) return;
    this.fireIn[cell] = 1;
    this.fireCells[this.fireN++] = cell;
  }

  /**
   * The per-tick fire pass. Walk the sparse list, never the map.
   *
   * Order per burning cell: consume fuel, hurt whatever is standing in it,
   * scorch the plant under it, pass fire downwind and across, put it out if
   * there is water in any of the eight neighbours, and count the cell down.
   *
   * Water in the 8-neighbourhood is the hard stop and it is checked BEFORE
   * the spread, so a shoreline does not pass a cell the fire was about to
   * reach anyway. Spread is downwind and across only — never upwind, never
   * along the third axis — and that shape is the thing that bounds a fire:
   * fuel gating alone does not, because a cell with no fuel under it still
   * passes it on, and a fire that can spread in four directions is a fire
   * that reaches the far side of the map whatever the fuel numbers say.
   */
  private stepFire(): void {
    if (this.fireN === 0) { this.world.fireActive = 0; return; }
    const a = this.agents, w = this.world, p = this.predators;

    // Snapshot the length: `lightFire` appends to this same array while it is
    // being walked, and a cell lit this tick should burn for a full
    // FIRE_BURN_TICKS starting now, not be processed again in the same pass
    // (which would consume its fuel and count it down twice).
    const n = this.fireN;
    for (let k = 0; k < n; k++) {
      const cell = this.fireCells[k];
      if (w.fire[cell] <= 0) { this.putOut(k); continue; }

      // --- burn the fuel under it ---------------------------------------
      w.fireFuel[cell] = Math.max(0, w.fireFuel[cell] - 1);

      const cx = cell % GRID_W, cy = (cell / GRID_W) | 0;

      // --- hurt whatever is standing in it -------------------------------
      // Predators are the serious casualty at FIRE_PRED_DAMAGE=0.10 against a
      // 0.02 starvation drain and a 0.006 age drain, so fire is 2.5x death by
      // starvation and 8x death by age for the other species. Pixels take a
      // tenth of that, because there are hundreds of them and a fire that
      // killed at the predator's rate would empty the map in one afternoon.
      for (let j = 0; j < MAX_PREDATORS; j++) {
        if (!p.alive[j]) continue;
        if (p.px[j] !== cx || p.py[j] !== cy) continue;
        p.health[j] -= FIRE_PRED_DAMAGE;
        p.burned[j] = 1;
      }
      for (let j = 0; j < MAX_AGENTS; j++) {
        if (!a.alive[j]) continue;
        if (a.ax[j] !== cx || a.ay[j] !== cy) continue;
        if (a.deathCause[j] === CAUSE.NONE) a.deathCause[j] = CAUSE.BURNED;
        a.health[j] -= FIRE_PIXEL_DAMAGE;
      }

      // --- scorch the plant, which is also the fire's own fuel -----------
      if (w.plant[cell] > 0) {
        const burn = Math.min(w.plant[cell], FIRE_SCORCH_RATE);
        w.plant[cell] -= burn;
        w.plantTimer[cell] = 0;
      }

      // --- water in the 8-neighbourhood puts it out ----------------------
      let doused = false;
      for (let dy = -1; dy <= 1 && !doused; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (!w.inBounds(nx, ny)) continue;
          if (w.terrain[w.idx(nx, ny)] !== T_WATER) continue;
          doused = true; break;
        }
      }
      if (doused) { w.fire[cell] = 0; this.putOut(k); continue; }

      // --- pass it downwind and across -----------------------------------
      // WIND_DX/DY is the table `World.wind` indexes into — a 4-connected
      // N/E/S/W, never a diagonal, so a fire spreads into eight neighbours
      // but only ever leaves a burning cell in two of them. `w.wind` is
      // derived from the tick counter and never from Math.random(), so the
      // same seed burns the same way twice.
      const down = w.wind & 3;
      const across = (down + 1) & 3;
      if (this.rng.chance(FIRE_SPREAD_ALONG)) {
        const j = w.idx(
          clampCell(cx + WIND_DX[down], GRID_W), clampCell(cy + WIND_DY[down], GRID_H));
        this.spreadTo(j);
      }
      if (this.rng.chance(FIRE_SPREAD_ACROSS)) {
        const j = w.idx(
          clampCell(cx + WIND_DX[across], GRID_W), clampCell(cy + WIND_DY[across], GRID_H));
        this.spreadTo(j);
      }

      // --- count it down --------------------------------------------------
      w.fire[cell]--;
      if (w.fire[cell] <= 0) { w.fire[cell] = 0; this.putOut(k); }
    }
    // The public counter is the truth about now, not a count of every fire
    // ever lit — `World.ignite` increments it and nothing in World decrements
    // it, so left alone it climbs forever.
    this.world.fireActive = this.fireN;
  }

  /**
   * Try to pass fire into one neighbour cell.
   *
   * Both lists have to be told. `World.ignite` maintains its own private
   * sparse list, and this class maintains a second index over the same
   * `w.fire` field for the per-tick pass; a cell lit through `World.ignite`
   * and not added here is a cell that is genuinely alight and that the fire
   * pass will never visit, so it burns down to nothing in `World`'s hands
   * without ever consuming fuel, hurting anything, or spreading. Two indices
   * over one field is the price of `World.fireList` being private, and this
   * is the line where that price is paid.
   */
  private spreadTo(cell: number): void {
    const w = this.world;
    if (w.fire[cell] > 0) return;   // already burning: never re-list
    if (!w.flammable(cell)) return; // nothing to burn: it never catches
    w.ignite(cell, FIRE_BURN_TICKS);
    if (w.fire[cell] > 0) this.lightFire(cell);
  }

  /**
   * Remove the k-th lit cell from the sparse list.
   *
   * Swap-remove rather than a stable compaction: the list is unordered (the
   * pass is independent per cell) and a swap is O(1) with no memmove of a
   * 1.1 MB array behind a fire that is spreading.
   */
  private putOut(k: number): void {
    const last = --this.fireN;
    const cell = this.fireCells[k];
    this.fireIn[cell] = 0;
    this.fireCells[k] = this.fireCells[last];
    this.fireCells[last] = 0;
    this.world.fire[cell] = 0;
    // Every cell that leaves the list is a cell the fire consumed, whether it
    // burned out on its countdown, was doused by water, or had its fuel
    // exhausted. `World` declares this tally and nothing in `World` writes
    // it, so it is written here or it is a number on the sidebar that is
    // permanently zero and reads as "fire has never happened".
    this.world.fireBurned++;
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
      // Can this animal get to the food and back before dawn? If it cannot,
      // waiting for dark is not patience, it is a night spent walking.
      const den = p.den[i];
      const denTooFar = den < 0 || den >= w.caveX.length
        || !w.inBounds(w.caveX[den], w.caveY[den])
        || this.campDist[w.idx(w.caveX[den], w.caveY[den])] > PRED_NIGHT_REACH;
      const hunting = !denning && p.wantsToHunt(i, isNight, denTooFar);
      p.ranging[i] = hunting ? 1 : 0;
      // RESTING is the default and every branch below only overrides it.
      // Without this line `state` is only ever written INSIDE the hunt, so an
      // animal that is out on the map with nothing in range keeps whatever it
      // was doing last tick — a predator that killed something twenty ticks
      // ago still reads FEEDING while it walks a hundred cells with an empty
      // belly, and the renderer and the sidebar both draw from this number.
      // It is the same class of bug as the recycled free slot that kept its
      // old scent: a field nothing assigns is a field that reports the past.
      p.state[i] = PredState.RESTING;

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
          // THE NOSE FIRST. `nearestByScent` has no line-of-sight test, and
          // that absence is the entire value of it: measured over 2,676
          // hunting samples, 7.7% of hunting ticks had a pixel inside the
          // vision radius that only ROCK was hiding and 1.9% had nothing in
          // range at all, so 9.6% of every hunt the world ran ended in
          // `target = -1` and a blind sweep along a remembered heading. The
          // radius multiplier is nearly irrelevant next to that (99.9% of
          // in-range ticks at 1.3x against 91.2% for vision alone) — what
          // the nose buys is that it sees ROUND things.
          //
          // The eye is the fallback rather than the first choice, so a
          // predator that can see prey does not get to smell something
          // further away and walk past the animal in front of it.
          if (this.tick % PRED_SMELL_EVERY === 0) {
            const smelled = p.nearestByScent(p.px[i], p.py[i], p.smell(i), this.spatial);
            if (smelled >= 0) {
              p.target[i] = smelled;
              p.bySmell[i] = 1;
              p.scentT[i] = PRED_MEMORY_TICKS;
              p.tx[i] = a.ax[smelled]; p.ty[i] = a.ay[smelled];
            }
          }
          if (p.target[i] < 0 || !a.alive[p.target[i]]) {
            const found = this.nearestPixelTo(p.px[i], p.py[i], r);
            p.target[i] = found;
            p.bySmell[i] = 0;
            if (found >= 0) {
              p.scentT[i] = PRED_MEMORY_TICKS;
              p.tx[i] = a.ax[found]; p.ty[i] = a.ay[found];
            }
          }
        }
        if (p.scentT[i] > 0) p.scentT[i]--;

        // A cornered animal goes home, whatever it was doing. Fire is the
        // predator's weakness and the point of it is that fire is a reason to
        // leave rather than a wall to walk into — but it is not a wall to walk
        // AWAY from either. Above PRED_PANIC_HEALTH the fight is still worth
        // taking, because PRED_EAT_GAIN=0.5 against PRED_HUNGER_RATE=0.0004
        // is a thousand ticks of life, and an animal burned once should not
        // spend the rest of its life flinching.
        //
        // A flag rather than a branch, so the animal still falls through to
        // the age/hunger tick at the bottom of the loop: an early `continue`
        // here is a predator that does not get hungry while it is running for
        // its life, which is precisely backwards.
        const panicking = p.burned[i] && p.health[i] <= PRED_PANIC_HEALTH;
        if (panicking) {
          p.state[i] = PredState.RETREAT;
          p.fireDread[i] = PRED_MEMORY_TICKS;
          const home = p.den[i] >= 0
            ? w.caveStep(p.px[i], p.py[i], p.den[i]) : -1;
          gx = 0; gy = 0;
          if (home >= 0) { gx = MOVE_DX[home]; gy = MOVE_DY[home]; }
          else { [gx, gy] = this.predFallback(i); }
          p.hx[i] = gx; p.hy[i] = gy;
        } else {
          const t = p.target[i];
        // A target that is alive but that the animal can no longer see is a
        // STALK, not a HUNT: it walks at the remembered position and does not
        // sprint, because a sprint is a commitment to a closing move and the
        // prey is not where it was. `scentT` is the countdown that keeps this
        // honest — PRED_MEMORY_TICKS is four times the four ticks it takes to
        // close the last PRED_STALK_R cells, which is the window in which the
        // prey breaks around a rock and the predator needs a position rather
        // than a heading to walk at.
        const seen = t >= 0 && a.alive[t]
          && clearLine(w, p.px[i], p.py[i], a.ax[t], a.ay[t]);
        if (t >= 0 && !seen && p.scentT[i] > 0) p.state[i] = PredState.STALKING;
        else if (t >= 0) p.state[i] = PredState.HUNTING;

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
            // A kill is FEEDING until the animal is fed, and a fed animal
            // stops hunting. Marking it is what lets the sidebar and the
            // renderer tell "standing over a kill" apart from "walking home
            // with its belly full", which are the same animal in different
            // parts of a night.
            p.state[i] = PredState.FEEDING;
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
          // predators is further from the village than the base leash allows
          // — measured at 280, 131, 146, 137, 178, 192, 177, 235, 155 and
          // 207 walked cells against 130. That animal walked toward the food
          // every night, was turned back at 130, and spent its whole life in
          // a territory with nothing in it. It is not a hard life, it is a
          // starvation chamber with scenery in it, and the leash is what put
          // the animal inside.
          //
          // `denLeash` is measured from the *den*, and that is the whole
          // subtlety. The first version of this asked how far the animal was
          // from the prey, which is the same number in the wrong place: the
          // allowance then shrank as the animal closed on the village, so a
          // predator 155 cells from home walking toward a village 150 cells
          // away got turned around on the doorstep — 77 cells out instead of
          // 25, and the run came back byte-identical. A leash belongs to a
          // place. It does not move because the animal using it did.
          const stray = p.den[i] >= 0 && p.den[i] < w.caveX.length
            ? w.caveDist[w.idx(p.px[i], p.py[i])] > this.denLeash(p.den[i]) : false;
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
            //
            // Down the camp distance field, not straight at it. The leash
            // is measured in walked cells and the two have to agree: a
            // straight line from a den 272 walked cells away to the village
            // is shorter than the walk, so an animal going straight has
            // covered its whole allowance while it is still short of the
            // prey, and gets turned back at the boundary of its own
            // territory. Measured on one seed, every predator hunted 5,216
            // ticks and killed nothing at all. It was walking blind past a
            // village of a hundred pixels and being sent home before it
            // arrived, because its vision tops out at 160 cells and the
            // village is 210 away.
            const camp = this.campStep(p.px[i], p.py[i]);
            if (camp >= 0) {
              gx = MOVE_DX[camp]; gy = MOVE_DY[camp];
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
        }   // end else(panicking)
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
        const pulled = this.denPull(i);
        const step = pulled >= 0
          ? w.caveStep(p.px[i], p.py[i], pulled)
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
      //
      // Two of them when it has something to run at, because a predator and
      // a pixel both move one cell a tick and that is not a chase, it is a
      // footrace the predator cannot win by any amount of wanting to. It
      // would see prey — vision reaches 160 cells and a village of a hundred
      // pixels sits well inside that — walk at it forever, and arrive
      // exactly never, because the prey is going the same speed in the same
      // direction. Measured: four predators spent 5,216 hunting ticks on one
      // seed and killed nothing at all, with the nearest pixel 23 cells off
      // and a kill needing it within one. Predators sprint; that is the
      // whole of what a predator is for.
      if (gx || gy) {
        const chase = p.target[i] >= 0 && a.alive[p.target[i]]
          && p.energy[i] < PRED_ATTACK_ENERGY
          // A stalk does not sprint. The prey has not noticed anything at
          // PRED_STALK_R=8 — FLEE_TRIGGER_RADIUS is 6 — so the last eight
          // cells are a walk, not a race, and sprinting through them is what
          // turns a successful approach into a chase the prey can win.
          && Math.hypot(a.ax[p.target[i]] - p.px[i], a.ay[p.target[i]] - p.py[i]) <= PRED_STALK_R;
        const sprint = chase ? PRED_CHASE_STEPS : 1;
        for (let step2 = 0; step2 < sprint; step2++) {
          let [nx, ny, s] = this.slide(p.px[i], p.py[i], gx, gy);
          if (nx === p.px[i] && ny === p.py[i]) break; // blocked: no point trying again
          // FIRE. Compared against the cell's own burn countdown, so 1 is a
          // trace and 0 is a full flame. Both branches exist because smoke
          // should bend a route and a real flame should end the question: a
          // detour is a choice, a refusal is a fact about the world.
          if (p.fireDread[i] <= 0) {
            const heat = w.fire[this.world.idx(nx, ny)] / FIRE_BURN_TICKS;
            if (heat > PRED_FIRE_AVOID) {
              const detour = this.fireDetour(p.px[i], p.py[i], gx, gy);
              if (detour >= 0) { nx = p.px[i] + MOVE_DX[detour]; ny = p.py[i] + MOVE_DY[detour]; s = detour; }
              else break;   // every way round is alight: it stays where it is
            }
          }
          p.px[i] = nx; p.py[i] = ny;
          if (s !== 4) { p.hx[i] = MOVE_DX[s]; p.hy[i] = MOVE_DY[s]; }
        }
      }
      if (p.fireDread[i] > 0) p.fireDread[i]--;
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
   * The den this predator should be living in, or -1 to stay where it is.
   *
   * Two reasons to leave, and they are the same reason seen from two sides.
   *
   * One is sex. A den of one sex is a rock, not a home, and the animal in it
   * has no way to breed and no way to find out that it is the only one.
   * Nothing in the world corrects for it, so the species random-walks to a
   * single sex and leaves: five males and one female at t=3000 on the seed
   * this was found on, three males and none by t=4000, after which every
   * animal spent a full lifespan walking home to nobody.
   *
   * The other is distance, and it is the subtler of the two because it fails
   * without ever looking like a failure. The six dens are a three-by-two
   * lattice and the walked distance from a den to the prey village measures
   * 10 to 543 cells. A pair at a den 300 cells out spends its life commuting:
   * walk 300 to the village, kill, walk 300 home, and a kill is worth 0.5
   * against 0.0004 a tick — the return journey alone costs 0.12, and the
   * animal arrives below the 0.45 it needs to be considered well enough fed
   * to breed. So it goes out again. It never accumulates enough at the mouth
   * to raise a litter, and the pair ages out in its own territory with a
   * hundred pixels a few hundred cells away. Measured on the three seeds that
   * were still losing their predators: 14 to 19 kills and 6 to 12 litters in
   * six thousand ticks, against 49 to 61 and 16 to 20 on the seeds where the
   * dens happened to land near the village. A den that far from the food is
   * not a home, and the animal is entitled to notice that.
   *
   * Company is worth more than distance — the bonus is larger than any
   * distance on the map, so a den with a partner always beats one without,
   * and distance only chooses between homes that all have company. Crowding
   * keeps six predators spread over two or three dens rather than all in one
   * rock, and the stay margin stops two animals in the same den trading
   * places every time one of them comes back from a hunt.
   */
  private denPull(i: number): number {
    const p = this.predators, w = this.world;
    // score the home it is in, and every home it could be in instead
    let here = -1, hereScore = Infinity, best = -1, bestScore = Infinity;
    for (let d = 0; d < w.caveX.length; d++) {
      if (!w.inBounds(w.caveX[d], w.caveY[d])) continue;
      const prey = this.campDist[w.idx(w.caveX[d], w.caveY[d])];
      if (prey < 0) continue;            // no prey walkable from there: not a home
      let crowd = 0, mate = 0;
      for (let k = 0; k < MAX_PREDATORS; k++) {
        if (!p.alive[k] || p.den[k] !== d) continue;
        crowd++;
        if (k !== i && p.sex[k] !== p.sex[i]) mate = 1;
      }
      if (crowd === 0) continue;        // nobody there to be with
      const score = prey + crowd * PRED_DEN_CROWDING - mate * PRED_DEN_MATE_BONUS;
      if (d === p.den[i]) here = d, hereScore = score;
      if (score < bestScore) { bestScore = score; best = d; }
    }
    if (here < 0 || best < 0 || best === here) return here;
    // Hysteresis. Two dens a few cells apart in quality are not a reason to
    // spend a day walking, and without this the pair that shares a den also
    // shares the score, so they trade places every time one of them hunts.
    return bestScore + PRED_DEN_STAY_MARGIN < hereScore ? best : here;
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
      // The cap has to be re-read INSIDE the loop, not only at the top of it.
      // It used to sit outside, and `p.count` only changes when something is
      // born — so a pass that started at five of six could walk the whole
      // loop and produce a litter for every eligible pair it met, ending
      // above the ceiling it had just checked. The harness printed "predators
      // 8 alive peak 8 cap 6", which is the shape of the bug exactly: eight
      // animals in a world whose cap is six, from one pass over three pairs.
      if (p.count >= PRED_SOFT_CAP) return;
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
      // Fire first, and it has to be checked before hunger: an animal that
      // walked into a blaze while it was already hungry would otherwise be
      // tallied as a famine, which is the same mis-attribution `reap` was
      // rewritten to stop on the pixel side. `burned` is set by `stepFire`
      // and cleared by `Predators.release`, so it is a fact about this death
      // and not a property the animal carries into the next slot.
      if (p.burned[i]) { this.world.predBurned++; }
      else if (p.energy[i] <= 0) p.starved++;
      else if (p.age[i] > p.maxAge(i)) p.diedOfAge++;
      else p.mobbed++;
      p.release(i);
    }
  }

  /**
   * Nearest living pixel within `r` that this predator can actually see, or -1.
   *
   * The line of sight is the whole of this, and it is the same rule pixels are
   * already held to on predators. Without it a predator acquires the nearest
   * pixel in a straight line through a mountain and spends its life walking
   * at it: measured on one seed, four predators ran 5,216 hunting ticks,
   * closed to eight cells — the width of the rock between them — and killed
   * nothing at all, because every approach was into a cliff.
   *
   * Candidates are tried nearest first and only a handful are tested, since a
   * march across the map is not free and the point is to find something it
   * can walk at rather than something it can only look at.
   */
  private nearestPixelTo(x: number, y: number, r: number): number {
    const a = this.agents, w = this.world;
    const seen: { j: number; d: number }[] = [];
    this.spatial.forEachNear(x, y, r, (j, ox, oy) => {
      if (!a.alive[j]) return;
      const d = ox * ox + oy * oy;
      if (d <= r * r) seen.push({ j, d });
    });
    seen.sort((p, q) => p.d - q.d);
    for (let k = 0; k < seen.length && k < PRED_SIGHT_TRIES; k++) {
      const { j } = seen[k];
      if (clearLine(w, x, y, a.ax[j], a.ay[j])) return j;
    }
    return -1;
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
      // The two item cooldowns tick down HERE, with `nauseaT` and `killT`, and
      // they were missing entirely. `gatherItem` set `gatherT` to
      // ITEM_PICKUP_COOLDOWN and `combineItems` set `combineT` to
      // COMBINE_COOLDOWN, and nothing ever decremented either: the only
      // reset was `Agents.clearCarry` on death or birth. A pixel that picked
      // up one item was locked out of gathering for the rest of its life, and
      // COMBINE was unreachable from the first attempt onward.
      //
      // Measured, before this line existed: over 3,000 ticks on seed 12345,
      // 38,841 GATHER attempts produced 278 pickups (0.7%) and 6,745
      // pixel-ticks holding an item — of which 6,745 held exactly ONE and
      // none held two or more. `combineItems` requires `carryTotal >= 2`, so
      // it executed 0 times and no fire was ever lit by a pixel in the whole
      // run. The cooldowns were not a tuning value, they were a wall.
      if (a.gatherT[i] > 0) a.gatherT[i]--;
      if (a.combineT[i] > 0) a.combineT[i]--;
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
    const a = this.agents, w = this.world;
    for (let i = 0; i < MAX_AGENTS; i++) {
      if (!a.alive[i] || a.health[i] > 0) continue;
      // A pixel that dies holding meat puts it back on the ground it fell
      // on. The hands are the animal's, not a place, and `Agents.release`
      // zeroes them a few lines below — so without this a carcass that was
      // picked up and carried ninety cells dies with a fifth of a unit of
      // food still in it, and that food is simply deleted from the world
      // rather than becoming somebody else's meal. It is `world.meat` going
      // back into `world.meat`, so the total and the sidebar number are
      // unchanged by the carrying and only the location moved.
      const heldMeat = a.carrying(i, Item.MEAT);
      if (heldMeat > 0) w.addMeat(w.idx(a.ax[i], a.ay[i]), heldMeat);
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
        case CAUSE.BURNED: this.deaths.burned++; break;
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
      // the village loses a member, and the crowding tax it pays is the tax on
      // the size it is now rather than the size it was at the last census
      if (a.founder[i] >= 0 && a.founder[i] < MAX_CAMP_SLOTS) this.campPop[a.founder[i]]--;
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
