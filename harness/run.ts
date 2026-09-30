/**
 * Headless balance harness. Runs the real sim with no browser and reports
 * whether the population actually survives and evolves.
 *
 *   node --experimental-strip-types harness/run.ts [seed] [ticks] [startPop] [quiet]
 */
import { Sim } from '../sim/sim.ts';
import { MAX_AGENTS, HARD_CAP, SOFT_CAP, TICK_MS, START_POP, START_PREDATORS, DAY_TICKS, PRED_DEN_CAP, PRED_SOFT_CAP } from '../sim/constants.ts';

const seed = Number(process.argv[2] ?? 12345);
const TICKS = Number(process.argv[3] ?? 20000);
const START = Number(process.argv[4] ?? START_POP);
const QUIET = process.argv[5] === 'quiet';

const sim = new Sim(seed);
sim.seedPopulation(START);
sim.seedPredators(START_PREDATORS);

let peakPop = 0, firstBirth = -1, extinctAt = -1, maxGen = 0, peakPred = 0;
let nightKills = 0, dayKills = 0, prevPredKills = 0;
let t0 = Date.now();
let earlyB = 0, midB = 0;
// rolling mean lifespan of the most recent deaths: the direct evidence that
// selection is improving the population rather than just churning it
const deathAges: number[] = [];
const rollingLifespan = (n = 200): number => {
  const s = sim.naturalDeathAges.slice(-n);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
};

for (let t = 1; t <= TICKS; t++) {
  const before = sim.births;
  const deathsBefore = sim.deaths.starvation + sim.deaths.age + sim.deaths.crowding + sim.deaths.killed;
  sim.step();
  if (sim.predators.predKills !== prevPredKills) {
    if (sim.world.isNight) nightKills++; else dayKills++;
    prevPredKills = sim.predators.predKills;
  }
  const deathsAfter = sim.deaths.starvation + sim.deaths.age + sim.deaths.crowding + sim.deaths.killed;

  if (sim.births > before && firstBirth < 0) firstBirth = t;
  if (sim.births > before && firstBirth < 0) firstBirth = t;
  peakPop = Math.max(peakPop, sim.agents.count);
  maxGen = Math.max(maxGen, sim.generation);
  if (sim.agents.count === 0) { extinctAt = t; break; }

  peakPred = Math.max(peakPred, sim.predators.count);
  if (t === 1000) earlyB = sim.births;
  if (t === Math.floor(TICKS / 2)) midB = sim.births;
  if (!QUIET && t % 1000 === 0) {
    const h = sim.history[sim.history.length - 1];
    const bar = '#'.repeat(Math.round((sim.agents.count / HARD_CAP) * 40));
    const ms = Date.now() - t0;
    console.log(
      `t=${String(t).padStart(6)} pop ${String(sim.agents.count).padStart(4)}` +
      ` births ${String(sim.births).padStart(4)} gen ${String(maxGen).padStart(3)}` +
      ` food ${String(h ? h.food : 0).padStart(6)} e=${(h ? h.meanEnergy : 0).toFixed(2)}` +
      ` ${h ? h.season : ''}  ${bar}` +
      `  life~${rollingLifespan().toFixed(0)}` +
      `  [${(t / (ms / 1000)).toFixed(0)} tick/s]`);
  }
}

const lateB = sim.births - midB;
const snap = sim.snapshot();
const wall = Date.now() - t0;
console.log('='.repeat(66));
console.log(`  seed ${seed}   ${TICKS} ticks   start ${START}   ${(TICK_MS).toFixed(0)}ms/tick real-time`);
console.log('='.repeat(66));
console.log(`  population    ${sim.agents.count}   peak ${peakPop}   cap ${HARD_CAP} (soft ${SOFT_CAP})`);
console.log(`  births        ${snap.births}${firstBirth >= 0 ? `  first at t=${firstBirth}` : '  NEVER'}`);
console.log(`  generation    ${maxGen}`);
console.log(`  mean lifespan ${snap.meanLifespan.toFixed(0)} ticks`);
console.log(`  deaths        ${JSON.stringify(snap.deaths)}`);
console.log(`  kills         ${snap.kills}   betrayals ${snap.betraysals}`);
console.log(`  predators     ${sim.predators.count} alive  peak ${peakPred}  cap ${PRED_SOFT_CAP} (${PRED_DEN_CAP} dens)`);
console.log(`  pred ledger   eaten ${sim.predators.predKills} (${nightKills} at night, ${dayKills} by day)` +
            `  mobbed ${sim.predators.mobbed}  starved ${sim.predators.starved}  aged ${sim.predators.diedOfAge}  born ${sim.predators.born}`);
console.log(`  day length    ${DAY_TICKS} ticks   phase now ${sim.world.phaseName}  daylight ${sim.world.daylight.toFixed(2)}`);
console.log(`  perf          ${(TICKS / (wall / 1000)).toFixed(0)} ticks/s  (${(wall / Math.max(1, TICKS)).toFixed(2)} ms/tick)`);
const first150 = sim.naturalDeathAges.slice(0, 200), last150 = sim.naturalDeathAges.slice(-200);
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
console.log(`  selection     natural lifespan, first 200 ${mean(first150).toFixed(0)}` +
            `  ->  last 200 ${mean(last150).toFixed(0)}   (n=${sim.naturalDeathAges.length})`);
console.log(`  restraint     births per 1000 ticks: early ${earlyB.toFixed(0)} -> late ${lateB.toFixed(0)}` +
            `  (lower near cap = lust control learned)`);
if (extinctAt >= 0) console.log(`\n  *** EXTINCT at tick ${extinctAt} ***`);
else console.log(`\n  survived all ${TICKS} ticks`);
