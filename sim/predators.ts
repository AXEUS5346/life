import {
  MAX_PREDATORS, PRED_ENERGY_CAP, PRED_BREED_COOLDOWN,
  PRED_SMALL, PRED_LARGE, PRED_MALE, PRED_FEMALE,
  PRED_LIFESPAN_SMALL, PRED_LIFESPAN_LARGE, PRED_DEN_ENERGY, PRED_STARVE_ENERGY,
  PRED_HUNT_R_SMALL, PRED_HUNT_R_LARGE, PRED_SEARCH_GROWTH,
  PRED_SMELL_MULT, PRED_SMELL_GROWTH,
} from './constants.ts';
import type { SpatialIndex } from './spatial.ts';

/**
 * The other species. Structure-of-arrays like `Agents`, but far smaller and
 * with no brain.
 *
 * What a predator has instead of a brain is a nose and a state machine. The
 * old version of this file opened by saying a predator does not deliberate,
 * it walks at the nearest pixel and eats it, and everything since has been
 * downstream of that one sentence: `target` is set by a search that returns
 * -1 on nine hunting ticks in ten, the heading survives a lost target as a
 * pair of `hx`/`hy` signs, and an animal that cannot see anything walks in
 * whatever direction it last happened to be facing. That is not a hunt, it is
 * a walk with a kill attached to it if the world happens to put a pixel in
 * front of the animal.
 *
 * The nose is the fix, and its measured value is already in constants.ts:
 * over 2,676 predator-hunting samples, 9.6% of hunting ticks had a pixel
 * inside the vision radius that the line-of-sight check threw away, and 7.7%
 * of all hunting ticks had one in range that only ROCK was hiding. So the
 * head of a hunt ended in `target = -1` and a blind sweep roughly one time in
 * ten. A predator that can smell does not end the hunt; it ends it somewhere
 * useful, and then STALKING is what it does with a target it cannot see.
 *
 * The state machine is deliberately small, and every state answers "what does
 * this animal do with a thing it cannot currently perceive":
 *
 *   RESTING  in the den, not hungry enough to leave
 *   HUNTING  out with a live target it can see
 *   STALKING out, tracking a target it has lost
 *   FEEDING  standing over a kill or a fresh carcass
 *   RETREAT  hurt or cornered, heading home
 *
 * HUNTING and STALKING are separate because they cost different things and
 * because the difference is observable: a hunting predator sprints two cells
 * a tick and a stalking one walks, and the renderer can draw the two apart.
 */

/** Predator behavioural states, as a plain const object: `enum` is not
 *  erasable syntax under --experimental-strip-types, and the sim, the
 *  renderer and the sidebar all have to agree on these five numbers. */
export const PredState = {
  RESTING: 0,   // in the den, not hungry enough to leave
  HUNTING: 1,   // out with a live target it can see
  STALKING: 2,  // out, tracking a target it has lost
  FEEDING: 3,   // standing over a kill or a fresh carcass
  RETREAT: 4,   // hurt or cornered, heading home
} as const;

export class Predators {
  px = new Int16Array(MAX_PREDATORS);
  py = new Int16Array(MAX_PREDATORS);
  age = new Int32Array(MAX_PREDATORS);
  energy = new Float32Array(MAX_PREDATORS);
  health = new Float32Array(MAX_PREDATORS);
  size = new Uint8Array(MAX_PREDATORS);    // PRED_SMALL | PRED_LARGE
  sex = new Uint8Array(MAX_PREDATORS);     // PRED_MALE | PRED_FEMALE
  den = new Int32Array(MAX_PREDATORS);     // home cave, -1 if the world has none
  /** Where this predator last saw a predator of the opposite sex. A male
   *  walks to this when it is well fed and has nothing to hunt, which is
   *  what makes the pair find each other without any global bookkeeping. */
  mtx = new Int16Array(MAX_PREDATORS);
  mty = new Int16Array(MAX_PREDATORS);
  /** Ticks left before it will look for a partner again. */
  mateT = new Int32Array(MAX_PREDATORS);
  /** True while it is out of its den hunting, false while it is inside. The
   *  renderer draws the difference, so you can see at a glance which of the
   *  six are hunting tonight and which are asleep in the rock. */
  ranging = new Uint8Array(MAX_PREDATORS);
  target = new Int32Array(MAX_PREDATORS);  // pixel slot being hunted, -1 = none
  /** Where a predator last saw its target, so it can walk there while the
   *  next search runs. */
  tx = new Int16Array(MAX_PREDATORS);
  ty = new Int16Array(MAX_PREDATORS);
  /** Current heading when hunting blind. A predator that stopped the moment
   * it lost sight of prey just sat in its cave and starved. */
  hx = new Int8Array(MAX_PREDATORS);
  hy = new Int8Array(MAX_PREDATORS);
  /** Countdown to the next search sweep. */
  searchT = new Int32Array(MAX_PREDATORS);
  alive = new Uint8Array(MAX_PREDATORS);
  cooldown = new Int32Array(MAX_PREDATORS);
  kills = new Int32Array(MAX_PREDATORS);

  /** Which of the five states this animal is in. The renderer and the sidebar
   *  both read it, and both need it to be the SIM's number rather than
   *  something re-derived from `ranging` and `target` at draw time. */
  state = new Uint8Array(MAX_PREDATORS);
  /** Ticks of scent memory left, 0 = no memory. This is the whole of the
   *  nose: it is what lets a predator walk to a position it can no longer
   *  SEE, and it has to be a countdown and not a position because the closing
   *  gap is four ticks long. Eight cells of stand-off at two cells a tick is
   *  four ticks of approach (PRED_STALK_R / PRED_CHASE_STEPS), and if the prey
   *  breaks around a rock inside that window the predator needs somewhere to
   *  walk that is not the heading the prey was last seen travelling on — a
   *  remembered heading rounds the rock the wrong way, a remembered position
   *  finds the gap it actually went through. PRED_MEMORY_TICKS is how long the
   *  animal keeps believing it. */
  scentT = new Int32Array(MAX_PREDATORS);
  /** Whether the current target was found by nose rather than by eye. A
   *  stalking predator and a hunting one are not the same animal, and this is
   *  the flag the hunt pass sets to say which. */
  bySmell = new Uint8Array(MAX_PREDATORS);
  /** Ticks left of refusing to step toward a burning cell.
   *
   *  This is a countdown rather than a boolean because "the cell is
   *  smouldering" and "the cell is a full flame" are different facts, and an
   *  animal that treats them the same is either uselessly brave or uselessly
   *  cowardly. PRED_FIRE_AVOID is compared against the cell's own heat
   *  countdown — 1 is a trace, 0 is a full flame — so a detour is a choice
   *  and a refusal is a fact about the world. */
  fireDread = new Int32Array(MAX_PREDATORS);
  /** Has this predator been hurt by fire since it last hunted?
   *
   *  Fire is the predator's weakness and the point of it is that the animal
   *  treats it as a reason to leave rather than a wall to walk into. But it
   *  is not a wall to walk *away* from either: above PRED_PANIC_HEALTH the
   *  fight is still worth taking, because PRED_EAT_GAIN=0.5 against
   *  PRED_HUNGER_RATE=0.0004 is a thousand ticks of life, and an animal that
   *  has been burned once should not spend the rest of its life flinching. */
  burned = new Uint8Array(MAX_PREDATORS);

  free: number[] = [];
  count = 0;

  // --- world-level tallies, shown in the sidebar ---
  born = 0;
  predKills = 0;    // pixels eaten
  mobbed = 0;       // predators killed by a mob of pixels
  starved = 0;
  diedOfAge = 0;

  constructor() {
    for (let i = MAX_PREDATORS - 1; i >= 0; i--) this.free.push(i);
    this.target.fill(-1);
    this.den.fill(-1);
  }

  get small(): number { return this.countSmall; }
  private countSmall = 0;
  get male(): number { return this.countMale; }
  private countMale = 0;
  get female(): number { return this.count - this.countMale; }

  alloc(
    x: number, y: number, size: number, den: number, age: number,
    sex: number,
  ): number {
    const i = this.free.pop();
    if (i === undefined) return -1;
    this.alive[i] = 1;
    this.count++;
    this.px[i] = x; this.py[i] = y;
    this.age[i] = age;
    this.energy[i] = PRED_ENERGY_CAP;
    this.health[i] = 1;
    this.size[i] = size;
    this.sex[i] = sex;
    this.den[i] = den;
    this.ranging[i] = 0;
    this.mateT[i] = 0;
    this.mtx[i] = x; this.mty[i] = y;
    this.target[i] = -1;
    this.cooldown[i] = PRED_BREED_COOLDOWN;
    this.kills[i] = 0;
    this.hx[i] = 0; this.hy[i] = 0;
    this.searchT[i] = 0;
    // A newborn has never seen a pixel and has never been burned, and saying
    // so here rather than in `spawn` is what stops a recycled slot from
    // arriving as a ghost. See `release`.
    this.state[i] = PredState.RESTING;
    this.scentT[i] = 0;
    this.bySmell[i] = 0;
    this.fireDread[i] = 0;
    this.burned[i] = 0;
    this.born++;
    if (size === PRED_SMALL) this.countSmall++;
    if (sex === PRED_MALE) this.countMale++;
    return i;
  }

  release(i: number): void {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    this.count--;
    if (this.size[i] === PRED_SMALL) this.countSmall--;
    if (this.sex[i] === PRED_MALE) this.countMale--;
    this.target[i] = -1;
    this.ranging[i] = 0;
    // The free-slot stack hands this same index to the next animal to be
    // born, and every one of these fields is a thing a predator acts on
    // rather than a thing it only reports. `scentT` is the one that matters:
    // a slot that kept its old scent is a predator that walks to a remembered
    // position forty ticks after the animal that left it there was dead, and
    // a `fireDread` that outlives its fire is a predator refusing to cross a
    // cell that went out three hundred ticks ago. Both are cheap to clear and
    // both produce a bug that reads as "the AI is haunted" rather than as
    // "the AI is wrong", which is the expensive kind.
    this.state[i] = PredState.RESTING;
    this.scentT[i] = 0;
    this.bySmell[i] = 0;
    this.fireDread[i] = 0;
    this.burned[i] = 0;
    this.free.push(i);
  }

  /**
   * Should this predator be out of its den right now?
   *
   * Hunger is the gate; the light of day only decides how patient it is.
   * Comfortable, it waits in the rock. Hungry, it goes out — but it prefers
   * to wait for dark, and only ignores the sun when starving, which is the
   * difference between a predator that keeps to a rhythm and one that lies
   * in a hole and dies.
   */
  wantsToHunt(i: number, isNight: boolean, denTooFar = false): boolean {
    if (this.energy[i] >= PRED_DEN_ENERGY) return false;
    if (isNight) return true;
    if (this.energy[i] < PRED_STARVE_ENERGY) return true; // starving
    // A den further from the prey than one night is a walk to feed on, so
    // waiting for dark is not patience, it is arithmetic: the animal sets off
    // at dusk, is still on the road at dawn, and goes home empty every single
    // night. The rhythm is a preference and the distance gets a vote.
    return denTooFar;
  }

  /**
   * How far this predator can notice a pixel right now.
   *
   * A base radius that grows with hunger, so a starving animal will cross the
   * whole map and a fed one barely leaves its rock. The sidebar shows this
   * exact number, which is the point: "more vision" has to be a number that
   * visibly moves, not a claim in a comment.
   */
  vision(i: number): number {
    const base = this.size[i] === PRED_SMALL ? PRED_HUNT_R_SMALL : PRED_HUNT_R_LARGE;
    return Math.round(base + (1 - this.energy[i]) * PRED_SEARCH_GROWTH);
  }

  /**
   * How far this predator can notice a pixel by nose right now.
   *
   * The same energy curve as `vision`, scaled by PRED_SMELL_MULT and widened
   * again by PRED_SMELL_GROWTH, so a hungry animal's nose is a strictly
   * larger circle than its eyes rather than a differently-shaped one. The
   * sidebar prints this next to the vision figure, which is the only reason
   * it exists as a method rather than as an inline expression in the hunt
   * pass: the number on the screen has to be the number the sim used, or the
   * panel is a second, wrong simulation of how far the animal can see.
   */
  smell(i: number): number {
    const base = this.vision(i) * PRED_SMELL_MULT;
    return Math.round(base + (1 - this.energy[i]) * PRED_SMELL_GROWTH);
  }

  /**
   * Nearest living pixel by nose — no line-of-sight test at all.
   *
   * The absence of the LOS check is the entire value here, and the constants
   * file has the measurement: 7.7% of all hunting ticks had a pixel inside the
   * vision radius that only ROCK was hiding, and 1.9% had nothing in range at
   * all, so 9.6% of hunts ended in `target = -1` and a blind sweep. Smell does
   * not see further than sight by much — at 1.3x the radius buys under a
   * point of coverage on its own (99.9% vs 91.2% of in-range ticks) — it sees
   * *round* things, and that is the 8.6 points.
   *
   * Runs every PRED_SMELL_EVERY ticks per hunting predator, which is every
   * tick, so it is written to not allocate: no candidate array, no sort. A
   * running minimum is cheaper than the sort `Sim.nearestPixelTo` does per
   * search and it cannot lose the nearest candidate to a truncation — the
   * PRED_SIGHT_TRIES cap there exists because an untested candidate is a
   * candidate that might be behind the next ridge, and by definition this
   * scan has no ridge to test against.
   */
  nearestByScent(x: number, y: number, r: number, spatial: SpatialIndex): number {
    let best = -1, bestD = r * r;
    spatial.forEachNear(x, y, r, (j, ox, oy) => {
      const d = ox * ox + oy * oy;
      if (d <= bestD) { bestD = d; best = j; }
    });
    return best;
  }

  /** Predators live much longer than pixels. */
  maxAge(i: number): number {
    return this.size[i] === PRED_SMALL ? PRED_LIFESPAN_SMALL : PRED_LIFESPAN_LARGE;
  }
}
