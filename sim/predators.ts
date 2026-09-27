import {
  MAX_PREDATORS, PRED_ENERGY_CAP, PRED_BREED_COOLDOWN,
  PRED_SMALL, PRED_LARGE, PRED_MALE, PRED_FEMALE,
  PRED_LIFESPAN_SMALL, PRED_LIFESPAN_LARGE, PRED_DEN_ENERGY, PRED_STARVE_ENERGY,
  PRED_HUNT_R_SMALL, PRED_HUNT_R_LARGE, PRED_SEARCH_GROWTH,
} from './constants.ts';

/**
 * The other species. Structure-of-arrays like `Agents`, but far smaller and
 * with no brain: a predator does not deliberate, it walks at the nearest
 * pixel and eats it. Everything interesting about a predator is in the
 * numbers — how big it is, how old it gets, how rarely it breeds.
 */
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
   *  it lost sight of prey just sat in its cave and starved. */
  hx = new Int8Array(MAX_PREDATORS);
  hy = new Int8Array(MAX_PREDATORS);
  /** Countdown to the next search sweep. */
  searchT = new Int32Array(MAX_PREDATORS);
  alive = new Uint8Array(MAX_PREDATORS);
  cooldown = new Int32Array(MAX_PREDATORS);
  kills = new Int32Array(MAX_PREDATORS);

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
  wantsToHunt(i: number, isNight: boolean): boolean {
    if (this.energy[i] >= PRED_DEN_ENERGY) return false;
    if (isNight) return true;
    return this.energy[i] < PRED_STARVE_ENERGY; // starving: daylight no longer matters
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

  /** Predators live much longer than pixels. */
  maxAge(i: number): number {
    return this.size[i] === PRED_SMALL ? PRED_LIFESPAN_SMALL : PRED_LIFESPAN_LARGE;
  }
}
