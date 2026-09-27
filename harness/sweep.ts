/**
 * Parameter sweep. Runs the real sim headless over a grid of settings and a
 * spread of seeds, and prints the outcome of each combination, so a balance
 * change is chosen against measurements instead of a hunch.
 *
 *   node --experimental-strip-types harness/sweep.ts
 */
import { Sim } from '../sim/sim.ts';
import { START_POP, START_PREDATORS, PRED_DEN_CAP } from '../sim/constants.ts';

const SEEDS = [12345, 1, 7, 42, 999, 20260927];
const TICKS = 8000;

function runAll() { return SEEDS.map(run); }

function run(seed: number) {
  const sim = new Sim(seed);
  sim.seedPopulation(START_POP);
  sim.seedPredators(START_PREDATORS);
  let peakPred = 0, nightKills = 0, dayKills = 0, prev = 0, predZeroAt = -1;
  for (let t = 1; t <= TICKS; t++) {
    sim.step();
    if (sim.agents.count === 0) {
      return { seed, extinct: t, peak: 0, peakPred, born: sim.births, gen: sim.generation,
               nightKills, dayKills, predEnd: sim.predators.count, predBorn: sim.predators.born, predZeroAt };
    }
    if (sim.predators.predKills !== prev) {
      if (sim.world.isNight) nightKills++; else dayKills++;
      prev = sim.predators.predKills;
    }
    peakPred = Math.max(peakPred, sim.predators.count);
    if (predZeroAt < 0 && sim.predators.count === 0) predZeroAt = t;
  }
  return { seed, extinct: -1, peak: sim.agents.count, peakPred, born: sim.births, gen: sim.generation, nightKills, dayKills, predEnd: sim.predators.count, predBorn: sim.predators.born, predZeroAt };
}

let survived = 0, predSurvived = 0;
const rows = runAll();
for (const r of rows) {
  if (r.extinct < 0) survived++;
  if (r.predEnd > 0) predSurvived++;
  console.log(
    `  seed ${String(r.seed).padStart(8)}  ${r.extinct < 0 ? 'ALIVE ' + String(r.peak).padStart(4) : 'DEAD t=' + String(r.extinct).padStart(5)}` +
    `  gen ${String(r.gen).padStart(3)}` +
    `  | preds end ${r.predEnd} peak ${r.peakPred} born ${r.predBorn} born-then-gone@${r.predZeroAt}` +
    `  | kills ${r.nightKills}night/${r.dayKills}day`);
}
console.log(`  --> ${survived}/${SEEDS.length} worlds survived, ${predSurvived}/${SEEDS.length} still had a predator at t=${TICKS}`);
