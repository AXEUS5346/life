/// <reference lib="webworker" />
import { Sim } from '../sim/sim.ts';
import type { Agents } from '../sim/agents.ts';
import { renderFrame, buildAgentIndex, HORMONE_NAMES } from '../sim/render.ts';
import {
  GRID_W, GRID_H, GRID_SIZE, VIEW_SIZE, MAX_PREDATORS, MAX_AGENTS,
  N_PARAMS, N_INPUTS, N_HIDDEN, N_OUTPUTS,
  START_PREDATORS, TICK_MS, TICK_HZ,
  VERB_OUT_BASE, VERB_NAMES, SNAPSHOT_VERSION,
} from '../sim/constants.ts';
import { GENE_NAMES } from '../sim/genome.ts';
import { ticksDue, targetHz } from '../sim/pace.ts';
import { forward, BrainScratch, PARAM_OFFSETS } from '../sim/brain.ts';
const { O_W1, O_B1, O_W2, O_B2, O_WV, O_BV, O_PARAMS_END } = PARAM_OFFSETS;
import { fertilityAge, maxAgeFor } from '../sim/hormones.ts';
import { buildInputs } from '../sim/sensors.ts';

export type ToWorker =
  | { type: 'init'; seed: number; startPop: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stepOnce' }
  | { type: 'speed'; value: number }
  | { type: 'reset'; seed: number; startPop: number }
  | { type: 'inspect'; cell: number }
  | { type: 'return'; buffer: ArrayBuffer }
  | { type: 'save' }
  | { type: 'load' };

/** One living predator, as the sidebar's roster shows it. */
export type PredRow = {
  size: 0 | 1; sex: 0 | 1; energy: number; health: number;
  hunting: boolean; kills: number;
  /** Walking distance in cells to its den, -1 if it has none. */
  denDist: number;
  /** Prey-detection radius in cells right now; grows with hunger. */
  vision: number;
  /** Distance to the nearest predator of the opposite sex it can see, -1. */
  mateDist: number;
  /** How far it can notice a pixel BY NOSE, in cells.
   *
   *  `p.smell(i)` and not a second opinion formed here. The sidebar prints
   *  this beside the vision figure and the only reason that pair is worth
   *  reading is that both are the numbers the hunt pass actually used; a
   *  sidebar that re-derived the radius would be a second, wrong simulation
   *  of how far the animal can sense, which is precisely the failure this
   *  panel was rebuilt to stop. Same hunger curve as `vision`, scaled by
   *  PRED_SMELL_MULT and widened again by PRED_SMELL_GROWTH, so the two
   *  numbers move together and a starving animal's nose is strictly the
   *  larger circle. */
  smell: number;
  /** Which of the five states the animal is in, as `PredState.*`. The badge
   *  used to be derived from `ranging` alone, which cannot tell a stalker
   *  from a hunter or an animal running for its den from one that is eating
   *  what it killed — and those are the four situations a person watching
   *  the map is trying to name. */
  state: number;
  /** True while the current target was found by nose rather than by eye. The
   *  constants file measures this: 9.6% of hunts used to end with nothing in
   *  sight at all, and this flag is how a viewer sees the nose earning its
   *  keep rather than having to take the claim on trust. */
  preyAware: boolean;
  /** Ticks of scent memory left. Non-zero means the animal is walking to
   *  where its prey was rather than to where its prey is, and the roster
   *  shows it as a countdown so the two are never confused. */
  scentT: number;
};

/** A predator under the cursor. Deliberately not AgentDetail: a predator has
 *  no genome, no brain and no hormones, so most of that panel would be
 *  zeroes pretending to be data. */
export type PredDetail = {
  kind: 'predator'; slot: number; size: 0 | 1; sex: 0 | 1;
  age: number; energy: number; health: number; kills: number;
  hunting: boolean; x: number; y: number;
  denDist: number; vision: number; mateDist: number;
  huntingSlot: number;
};

export type AgentDetail = {  kind?: 'agent'; slot: number; age: number; maxAge: number; energy: number; health: number;
  thirst: number;
  sex: 0 | 1; generation: number; founder: number; bornTick: number;
  genes: { name: string; value: number }[];
  hormones: { name: string; value: number }[];
  mate: number; bond: number; desperation: number; nausea: number;
  fertilityAge: number; lineageName: string;
  brain: {
    w1: Float32Array; b1: Float32Array; w2: Float32Array; b2: Float32Array;
    wv: Float32Array; bv: Float32Array;
  };
  verbScores: { name: string; score: number }[];
};

let sim: Sim | null = null;
let playing = true;   // matches the UI default; 'pause' will turn it off
let speed = 1;
let agentIndex = new Int32Array(GRID_SIZE);
let buffer: ArrayBuffer | null = null;
let scratch = new BrainScratch();
/** The predator currently under the cursor, or -1. Tracked here rather than
 *  re-derived per frame from the last `detail` message so that the ring drawn
 *  on the map and the animal named in the inspector are the same animal: one
 *  is derived from a message and the other from a field, and a frame drawn
 *  between the click and the reply must not show a stale one. */
let selectedPred = -1;
const lineageNames = new Map<number, string>();

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function ensureBuffer(): ArrayBuffer {
  if (!buffer) buffer = new ArrayBuffer(VIEW_SIZE * 4);
  return buffer;
}

/** One row per living predator, for the sidebar's roster. Everything the
 *  panel shows about an animal is read out of the simulation here rather
 *  than reconstructed on the main thread, so the numbers on screen cannot
 *  drift from what is actually being simulated. */
function roster(): PredRow[] {
  const out: PredRow[] = [];
  if (!sim) return out;
  const p = sim.predators;
  for (let i = 0; i < MAX_PREDATORS; i++) {
    if (!p.alive[i]) continue;
    out.push({
      size: p.size[i] === 0 ? 0 : 1,
      sex: p.sex[i] === 0 ? 0 : 1,
      energy: p.energy[i],
      health: p.health[i],
      hunting: p.ranging[i] === 1,
      kills: p.kills[i],
      denDist: sim.predDenDistance(i),
      vision: p.vision(i),
      mateDist: sim.predMateDistance(i),
      smell: p.smell(i),
      state: p.state[i],
      preyAware: p.bySmell[i] === 1,
      scentT: p.scentT[i],
    });
  }
  return out;
}

/**
 * How many pixels are holding something right now.
 *
 * `carryCount` rather than a sum of the per-kind rows: the point of the figure
 * is "how many animals are playing with items at all", and a pixel carrying
 * four rocks and a pixel carrying one of each are both a pair of hands full.
 * The per-kind split lives in the inspector, where there is room for it.
 *
 * Walked over MAX_AGENTS rather than over the live population because there is
 * no compact list of live slots to walk — `free` is a stack of the *dead* ones
 * — and 800 byte reads is not a cost worth an index to avoid.
 */
function countCarrying(a: Agents): number {
  let n = 0;
  for (let i = 0; i < MAX_AGENTS; i++) if (a.alive[i] && a.carryCount[i] > 0) n++;
  return n;
}

function makeWorld(seed: number, startPop: number): void {
  sim = new Sim(seed);
  sim.seedPopulation(startPop);
  sim.seedPredators(START_PREDATORS);
  lineageNames.clear();
  selectedPred = -1;
  for (let i = 0; i < MAX_AGENTS; i++) {
    lineageNames.set(i, `Px-${(seed % 97) * 1000 + i}`);
  }
  // start the clock from zero so the first interval measured is a real one
  lastT = now(); rateStart = lastT; rateTicks = 0; acc = 0;
}

function post(msg: unknown, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer ?? []);
}

function emitFrame(): void {
  if (!sim) return;
  const ab = ensureBuffer();
  const view = new Uint8ClampedArray(ab);
  renderFrame(sim, view, selectedPred);
  buildAgentIndex(sim, agentIndex);
  const snap = sim.snapshot();
  const food = sim.world.totalFood();
  const carrying = countCarrying(sim.agents);
  post({
    type: 'frame',
    buffer: ab,
    ages: Uint16Array.from(sim.agents.age),
    alive: Uint8Array.from(sim.agents.alive),
    sex: Uint8Array.from(sim.agents.sex),
    stats: {
      ...snap,
      food: Math.round(food),
      epsilon: sim.epsilon,
      free: sim.agents.free.length,
      predators: sim.predators.count,
      predSmall: sim.predators.small,
      predKills: sim.predators.predKills,
      predMobbed: sim.predators.mobbed,
      predBorn: sim.predators.born,
      meat: Math.round(sim.world.meatTotal),
      // --- the item and fire counters -------------------------------------
      // Every one of these is a number the simulation already keeps. None of
      // them is recomputed here, for the same reason the roster is not: a
      // sidebar figure derived on the main thread is a second simulation of
      // the world, and it goes stale the moment the sim ticks. `firesLit` and
      // `fireBurned` are cumulative, so they only ever go up and a viewer can
      // see the first fire of a world happen while watching.
      firesLit: sim.world.firesLit,
      /** Cells alight right now. Zero is the normal state of a world, which
       *  is why the renderer can skip its fire pass entirely on a counter
       *  compare. */
      fireActive: sim.world.fireActive,
      fireBurned: sim.world.fireBurned,
      /** Predators fire has killed. The number that says whether fire is a
       *  tool the pixels found or a second way for the species to die. */
      predBurned: sim.world.predBurned,
      /** Loose rock and sticks lying on the ground, in whole items. A
       *  harvested woodline comes back on the ITEM_SCATTER_EVERY regrow, and
       *  these two falling and recovering is the only way a person can watch
       *  that happen. */
      rock: Math.round(sim.world.rockTotal),
      stick: Math.round(sim.world.stickTotal),
      /** Pixels with anything in their hands. The one item number that is
       *  not about the world but about the animals: loose rock is scenery
       *  until somebody picks it up. */
      carrying: carrying,
      // what was asked for, and what the machine actually delivered. The
      // gap between these two is the honest answer to "is 16x really 16x".
      speed,
      ticksPerSec: measuredHz,
      targetHz: targetHz(speed),
      preds: roster(),
    },
    agentIndex: agentIndex,
  }, [ab]);
  buffer = null; // ownership transferred; main thread returns it
}

let lastEmit = 0;
/** Wall-clock debt owed to the simulation, in ms. */
let acc = 0;
let lastT = 0;
/** Ticks since the last rate sample, and when that sample started. */
let rateTicks = 0, rateStart = 0, measuredHz = 0;

/** Never replay more than this in one pass. A backgrounded tab comes back
 *  with seconds of wall-clock debt; paying all of it at once would freeze
 *  the page instead of catching up. */
const MAX_CATCHUP = 240;

/** 20 frames a second. The world moves one cell per tick and a tick is
 *  100ms at 1x, so a faster paint would be repainting the same picture. */
const EMIT_MS = 50;

/**
 * Wake the loop without setTimeout's 4ms nested-timer clamp.
 *
 * The old loop asked for 4ms between passes and did up to `speed` steps per
 * pass, which meant the rate was decided by whichever ran out first: the
 * multiplier, or a 10ms CPU budget. Past about 4x the CPU won, so 8x and
 * 16x were both "as fast as this machine can go" and the buttons did
 * nothing. A MessageChannel wakes as fast as the event loop allows, and the
 * schedule below is derived from the tick interval itself.
 */
const wake = new MessageChannel();
let scheduled = false;
wake.port1.onmessage = () => { scheduled = false; loop(); };
function schedule(ms: number): void {
  if (scheduled) return;
  scheduled = true;
  if (ms <= 1) { wake.port2.postMessage(0); return; }
  setTimeout(() => wake.port2.postMessage(0), ms);
}

function loop(): void {
  if (!sim) return;
  const t = now();
  // A tab that was backgrounded owes a huge debt it should never pay off.
  // Capping the gap means the world resumes where it was, not fast-forwarded.
  const elapsed = Math.min(250, Math.max(0, t - lastT));
  lastT = t;

  if (playing) {
    // One tick every TICK_MS/speed of wall clock, exactly. `ticksDue` is the
    // whole speed control and it lives in sim/pace.ts so it can be tested
    // without a browser: the multiplier divides the interval and nothing
    // else gets a vote, which is what makes 16x mean 16x.
    const r = ticksDue(acc, elapsed, speed, MAX_CATCHUP);
    acc = r.carryMs;
    for (let k = 0; k < r.ticks; k++) sim.step();
    rateTicks += r.ticks;
  }

  if (t - rateStart >= 1000) {
    if (rateStart > 0) measuredHz = (rateTicks * 1000) / (t - rateStart);
    rateStart = t; rateTicks = 0;
  }

  if (t - lastEmit > EMIT_MS) { lastEmit = t; emitFrame(); }
  const gap = TICK_MS / speed;
  schedule(playing ? Math.max(1, Math.min(25, Math.ceil(gap))) : 50);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function detailFor(i: number): AgentDetail | null {
  if (!sim) return null;
  const a = sim.agents;
  if (!a.alive[i]) return null;
  const off = i * N_PARAMS;
  const genes = GENE_NAMES.map((name, k) => ({ name, value: a.genes[i * 10 + k] }));
  const hormones = HORMONE_NAMES.map((name, k) => ({ name, value: a.h(i, k) }));

  const x = scratch.inputs;
  buildInputs(a, sim.world, sim.spatial, sim.predators, i, maxAgeFor(a.genes, i), x);
  const h = new Float32Array(N_HIDDEN);
  const q = new Float32Array(N_OUTPUTS);
  forward(sim.brains, off, x, h, q);
  const verbScores = VERB_NAMES.map((name, k) => ({ name, score: q[VERB_OUT_BASE + k] }));

  return {
    slot: i, age: a.age[i], maxAge: Math.round(maxAgeFor(a.genes, i)),
    energy: a.energy[i], thirst: a.thirst[i], health: a.health[i], sex: a.sex[i] as 0 | 1,
    generation: a.gen[i], founder: a.founder[i], bornTick: a.bornTick[i],
    genes, hormones, mate: a.mate[i], bond: a.bond[i],
    desperation: a.desperation[i], nausea: a.nausea[i],
    fertilityAge: Math.round(fertilityAge(a.genes, i)),
    lineageName: lineageNames.get(a.founder[i]) ?? `Px-${a.founder[i]}`,
    brain: {
      w1: sim.brains.slice(off + O_W1, off + O_B1),
      b1: sim.brains.slice(off + O_B1, off + O_W2),
      w2: sim.brains.slice(off + O_W2, off + O_B2),
      b2: sim.brains.slice(off + O_B2, off + O_WV),
      wv: sim.brains.slice(off + O_WV, off + O_BV),
      bv: sim.brains.slice(off + O_BV, off + O_PARAMS_END),
    },
    verbScores,
  };
}

function predDetailFor(i: number): PredDetail | null {
  if (!sim) return null;
  const p = sim.predators;
  if (!p.alive[i]) return null;
  return {
    kind: 'predator', slot: i,
    size: p.size[i] === 0 ? 0 : 1, sex: p.sex[i] === 0 ? 0 : 1,
    age: p.age[i], energy: p.energy[i], health: p.health[i], kills: p.kills[i],
    hunting: p.ranging[i] === 1, x: p.px[i], y: p.py[i],
    denDist: sim.predDenDistance(i), vision: p.vision(i), mateDist: sim.predMateDistance(i),
    huntingSlot: p.target[i],
  };
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      makeWorld(msg.seed, msg.startPop);
      post({ type: 'ready' });
      loop();
      break;
    case 'play': playing = true; break;
    case 'pause': playing = false; break;
    case 'stepOnce': if (sim) { sim.step(); emitFrame(); } break;
    case 'speed': speed = msg.value; break;
    case 'reset': makeWorld(msg.seed, msg.startPop); emitFrame(); break;
    case 'return': buffer = msg.buffer; break;
    case 'inspect': {
      // msg.cell is a GRID CELL, not a slot - map it first. -1 is empty, >= 0
      // is a pixel, <= -2 is a predator.
      if (msg.cell < 0 || msg.cell >= GRID_SIZE) { post({ type: 'inspect', detail: null }); break; }
      const hit = agentIndex[msg.cell];
      const detail = hit >= 0 ? detailFor(hit) : hit <= -2 ? predDetailFor(-hit - 2) : null;
      // Clicking empty ground clears the selection, which is what makes the
      // ring go away. It is set unconditionally rather than only on a
      // predator hit, so clicking a pixel also clears it — otherwise the ring
      // would sit over a pixel that was clicked and the two would disagree
      // about what is selected.
      selectedPred = hit <= -2 ? -hit - 2 : -1;
      post({ type: 'inspect', detail });
      break;
    }
    case 'save': {
      if (!sim) break;
      post({ type: 'save', data: serialize() });
      break;
    }
    case 'load': {
      // placeholder for the IndexedDB round-trip wired up on the main thread
      break;
    }
  }
};

/** Full world snapshot: brains, genomes, terrain, food, all of it. */
function serialize(): string {
  if (!sim) return '';
  const a = sim.agents;
  const pack = <T extends Float32Array | Int32Array | Int16Array | Uint8Array | Uint16Array | Int8Array>(arr: T) =>
    Array.from(arr as unknown as ArrayLike<number>);
  return JSON.stringify({
    // SNAPSHOT_VERSION, not a literal. A snapshot records the brain's input
    // count, its verb count and every field that is interpreted rather than
    // merely stored, and a world saved under one shape cannot be read under
    // another: N_INPUTS went 45 -> 67 here, so a v1 weight vector is not an
    // animal with bad memories, it is a different animal. The number lives in
    // sim/constants.ts because sim/, worker/ and tests/ all have to agree on
    // it, and a literal here is how the two drift apart.
    version: SNAPSHOT_VERSION,
    seed: sim.seed,
    tick: sim.tick,
    brains: pack(sim.brains),
    rms: pack(sim.rms),
    terrain: Array.from(sim.world.terrain),
    plant: Array.from(sim.world.plant),
    plantTimer: Array.from(sim.world.plantTimer),
    carcass: Array.from(sim.world.carcass),
    fertile: Array.from(sim.world.fertile),
    ax: pack(a.ax), ay: pack(a.ay), age: pack(a.age), energy: pack(a.energy),
    thirst: pack(a.thirst),
    health: pack(a.health), sex: pack(a.sex), alive: pack(a.alive),
    genes: pack(a.genes), horm: pack(a.horm), mate: pack(a.mate),
    bond: pack(a.bond), gen: pack(a.gen), founder: pack(a.founder),
    bornTick: pack(a.bornTick), desperation: pack(a.desperation),
    starveT: pack(a.starveT), nausea: pack(a.nausea), nauseaT: pack(a.nauseaT),
    births: sim.births, kills: sim.kills, deaths: sim.deaths,
  });
}
