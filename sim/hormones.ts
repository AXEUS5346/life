import {
  H, Verb, VERB_OUT_BASE, N_MOVE, N_VERB, N_GENES, N_HORMONES,
  DOPAMINE_DECAY, JUVENILE_TICKS, MOVE_DX, MOVE_DY,
} from './constants.ts';
import { GENE } from './genome.ts';
import type { Agents } from './agents.ts';
import type { World } from './world.ts';
import type { SpatialIndex } from './spatial.ts';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function fertilityAge(g: Float32Array, i: number): number {
  return 25 + g[i * N_GENES + GENE.FERTILITY_AGE] * 55; // 25..80 ticks
}

export function maxAgeFor(g: Float32Array, i: number): number {
  return 200 + g[i * N_GENES + GENE.LIFESPAN] * 500; // 200..700 ticks
}

/**
 * Every hormone is a graded quantity that drifts toward a target. Nothing here
 * is a rule — they only ever bias what an agent is *likely* to do.
 */
export function updateHormones(
  a: Agents, w: World, spatial: SpatialIndex, i: number, sawSomeone: boolean,
): void {
  const g = a.genes;
  const gi = (gene: number): number => g[i * 10 + gene];
  const energy = a.energy[i];

  // HUNGER — the one drive a newborn is born with.
  a.setH(i, H.HUNGER, clamp01(1 - energy));

  // THIRST — the second drive a newborn is born with, on the same clock as
  // hunger so neither is the one that actually kills you.
  a.setH(i, H.THIRST, clamp01(a.thirst[i]));

  // DESIRE — cannot exist before fertility age, then tracks libido and proximity.
  const fert = fertilityAge(g, i);
  if (a.age[i] <= fert) {
    a.setH(i, H.DESIRE, 0);
  } else {
    const mature = clamp01((a.age[i] - fert) / 100);
    a.setH(i, H.DESIRE, mature * (0.35 + 0.65 * gi(GENE.LIBIDO)));
  }

  // DESPERATION — continuous. Near zero while fed, dominant while starving.
  if (energy < 0.20) a.starveT[i]++;
  else a.starveT[i] = 0;
  const depth = clamp01((0.20 - energy) / 0.20);
  const persistence = clamp01(a.starveT[i] / 50);
  const target = depth * persistence;
  a.desperation[i] += (target - a.desperation[i]) * 0.15;

  // LOVE — simply the strength of the current bond.
  a.setH(i, H.LOVE, a.bond[i]);

  // EGO — mostly temperament, nudged by wins and betrayed.
  a.setH(i, H.EGO, clamp01(0.35 + gi(GENE.AGGRESSION) * 0.45));

  // FEAR — a nearby desperate/aggressive creature is frightening.
  let threat = 0;
  spatial.forEachNear(a.ax[i], a.ay[i], 8, (j, ox, oy) => {
    if (j === i) return;
    const d = Math.sqrt(ox * ox + oy * oy);
    if (d > 8 || d < 0.01) return;
    const menace = Math.max(a.desperation[j], a.h(j, H.ANGER)) * gi(GENE.AGGRESSION);
    threat = Math.max(threat, (menace * 8) / (8 + d));
  });
  a.setH(i, H.FEAR, threat);

  // LONELY — accumulates while nobody is in sight, weighted by sociability.
  if (sawSomeone) a.setH(i, H.LONELY, 0);
  else a.setH(i, H.LONELY, a.h(i, H.LONELY) + 0.004 * (0.5 + gi(GENE.SOCIABILITY)));

  // DOPAMINE — a reward that has to fade, or every pixel would sit permanently
  // content on a single meal of meat.
  if (a.h(i, H.DOPAMINE) > 0) {
    a.setH(i, H.DOPAMINE, Math.max(0, a.h(i, H.DOPAMINE) - DOPAMINE_DECAY));
  }

  // CALM — the absence of everything else.
  let peak = 0;
  for (let k = 0; k < N_HORMONES; k++) {
    if (k !== H.CALM) peak = Math.max(peak, a.horm[i * N_HORMONES + k]);
  }
  a.setH(i, H.CALM, clamp01(1 - peak));
}

/**
 * Lean `out` toward a movement step, and a little onto everything else that
 * points broadly the same way.
 *
 * The 3x3 movement grid means a single output is one of nine near-identical
 * cells, and a preference that only raises one of them is a preference the
 * brain routinely loses to noise. Spreading the lean across the neighbours
 * that share a heading is what makes "that way" read as a direction.
 */
function lean(out: Float32Array, step: number, pull: number): void {
  if (step < 0 || step >= N_MOVE || pull <= 0) return;
  out[step] += pull;
  const dx = MOVE_DX[step], dy = MOVE_DY[step];
  const norm = Math.abs(dx) + Math.abs(dy);
  for (let k = 0; k < N_MOVE; k++) {
    if (k === step) continue;
    const d = MOVE_DX[k] * dx + MOVE_DY[k] * dy;
    if (d > 0) out[k] += (pull * 0.4 * d) / norm;
  }
}

/**
 * How much this pixel wants to be at its camp right now, 0 to ~3.
 *
 * Three separate reasons, and they are separate on purpose: a mature pixel
 * with its own life to live mostly does not, which is what leaves the map
 * open; a pixel that wants a mate or has not seen anyone in a long time does,
 * which is what brings a scattered population back together; and a juvenile
 * wants it hardest of anything at all, which is what puts a cohort of young
 * inside the village to grow up in rather than alone out on the grass.
 */
export function homePull(a: Agents, i: number): number {
  const juvenile = Math.max(0, 1 - a.age[i] / JUVENILE_TICKS);
  return a.h(i, H.DESIRE) * 1.4 + a.h(i, H.LONELY) * 0.9 + juvenile * 2.4;
}

/**
 * Hormone -> output-logit bias.
 *
 * This is the only place "gating" happens, and it is a soft additive nudge,
 * never a mask. The KILL and MATE biases carry a large negative floor so a
 * well-fed newborn effectively cannot choose them — but as desperation climbs
 * the floor is overwhelmed continuously, with no threshold anywhere.
 *
 * The movement biases are where a pixel stays alive before it has learned
 * anything. Hunger leans on the food field, thirst on the water field, and
 * a pixel that needs a mate or a friend leans on its camp — all three
 * squared, so the pull is nothing at all when the drive is mild and
 * overwhelming when it is not. Without them a fresh brain is a random walk
 * over a 286,000-cell map, and the honest answer to "do pixels ever learn to
 * eat" is that they mostly starve first. With them a pixel knows how to
 * survive from the tick it is born, and everything the brain learns is
 * layered on top of that.
 */
export function hormoneBias(
  a: Agents, i: number, out: Float32Array, wander: number, adjacentMate: boolean,
  waterStep: number, foodStep: number, homeStep: number, pull: number,
): void {
  const g = a.genes;
  const gi = (gene: number): number => g[i * 10 + gene];
  const libido = gi(GENE.LIBIDO);
  const aggression = gi(GENE.AGGRESSION);
  const sociability = gi(GENE.SOCIABILITY);
  const curiosity = gi(GENE.CURIOSITY);
  const ego = a.h(i, H.EGO);

  // --- movement: 3x3, 0 is up-left. wander adds restless jitter -----------
  const pull0 = wander * curiosity;
  out[0] = pull0; out[1] = pull0 * 0.6; out[2] = pull0;
  out[3] = pull0 * 0.6 + sociability * 0.4; out[4] = -0.4; out[5] = pull0 * 0.6 + sociability * 0.4;
  out[6] = pull0; out[7] = pull0 * 0.6; out[8] = pull0;

  // --- survival: the three headings that keep a pixel alive ---------------
  // Squared, so each one is a near-binary pull once the drive is real and
  // nothing at all before then. The caller's obstacle-sliding step is what
  // keeps a rock from cancelling the heading out entirely.
  //
  // Scaled against the most pressing of the three, not summed at face value.
  // Summing is what let a pixel walk to the grass with a river thirty cells
  // behind it: hunger and thirst are on the same clock, so a pixel that is
  // moderately hungry and moderately thirsty always has one of them winning
  // the heading, and which one wins is decided by a constant rather than by
  // how close either of them is to killing it. Dividing by the strongest
  // makes the ordering the answer to "what is nearest to being fatal", and
  // a drive at half the top drive gets half the pull instead of competing
  // with a coefficient that was fixed once and never revisited.
  const hunger = a.h(i, H.HUNGER);
  const thirst = a.h(i, H.THIRST);
  const needFood = hunger * hunger;
  const needWater = thirst * thirst;
  // home is on the same scale as the other two: a juvenile's pull is the
  // strongest thing in its movement, and used to be able to outvote a river
  const needHome = clamp01(pull / 2.4);
  const top = Math.max(needFood, needWater, needHome, 1e-6);
  lean(out, foodStep, (needFood / top) * 4.0);
  lean(out, waterStep, (needWater / top) * 4.0);
  lean(out, homeStep, (needHome / top) * 4.0);

  const base = VERB_OUT_BASE;
  // Every verb slot is cleared before any of them is written. This function
  // does not own the buffer: the caller keeps ONE bias array of N_OUTPUTS
  // floats per agent and reuses it for that agent's whole life, so a slot
  // nobody writes keeps whatever the last write put there.
  //
  // This was invisible at N_VERB=7, where every verb happened to be covered by
  // a write below, and it became a real cross-contamination the moment the set
  // stopped being complete — GATHER, DROP and COMBINE were unwritten for a
  // while, and every pixel in the world inherited the previous pixel's opinion
  // about picking up a rock. Zeroing the range rather than listing the gaps
  // means the guarantee is structural: add a verb tomorrow and it starts at
  // zero for the same reason the others do, without anyone remembering.
  for (let v = 0; v < N_VERB; v++) out[base + v] = 0;
  out[base + Verb.EAT] = hunger * 3.0 - 0.3;
  out[base + Verb.SEEK_MATE] = a.h(i, H.DESIRE) * sociability * 1.8;
  // MATE, and this is the second line that decides whether a population has a
  // future. A bias of `desire * libido * 3.0` sounds decisive and is not: it
  // lands around 0.75 at typical hormone levels, while an untrained brain's
  // verb logits are spread over about two, so the brain simply outvoted
  // courtship and courtship happened twice in a thousand ticks. Measured on
  // the world it was measured on: a village of eighteen pixels, fourteen of
  // them past fertility age, partners an average of twenty cells away, and
  // not one child born in eight hundred ticks — the bonds were never formed,
  // so the population aged out with the grass still standing.
  //
  // The two ends of the scale are honest. With nobody worth mating beside it
  // the bias is 0.2 and the verb stays the brain's to lose. With an eligible
  // partner on the same tile the two of you are both grown, both fed, and
  // both wanting this, which is the one moment in a pixel's life where the
  // right thing to do is not in doubt — so the bias is large enough to beat a
  // noisy argmax, and the brain keeps the only vote that matters, which is
  // the rest of the time.
  out[base + Verb.MATE] = a.h(i, H.DESIRE) * libido * (adjacentMate ? 4.5 : 0.2);
  // GATHER, DROP and COMBINE keep the zero the loop above gave them, and that
  // is a decision rather than an omission. Biasing them would be this file
  // deciding that gathering is worthwhile, which is the question the brain is
  // being asked; a pixel picks a rock up because the rock turned out to be
  // worth having, not because something leaned on it.
  //
  // KILL, and the floor is not a constant because what makes murder rare in
  // this world is that it is only ever the last resort of an animal with
  // nothing left. A flat -2.5 is not rare. The brain's seven verb logits are
  // spread over about two, so a handicap of 2.5 still wins the argmax by
  // accident several times a hundred ticks — and every one of those accidents
  // finds a neighbour, because a pixel in a village is always adjacent to
  // one, and pays +0.5 for the corpse. That is not a bad habit to learn, it is
  // a suicide pact: measured on one seed, the founding six murdered each
  // other between t=86 and t=177 with desperation at zero and aggression at
  // 0.05, the lowest this world can produce, and the run was over before the
  // first generation. The punishment for a healthy animal that reaches for
  // the verb is that there is no way it can.
  //
  // So it climbs from hopeless to reachable on desperation alone, squared,
  // the same shape as everything else in here — and even at full starvation
  // a well-fed animal stays below eating, because a starving animal should
  // look for grass first and only turn to murder when there is none.
  const desp = a.desperation[i];
  out[base + Verb.KILL] = -8.0 + (1 - (1 - desp) * (1 - desp)) * 9.0 * aggression;
  out[base + Verb.FLEE] = a.h(i, H.FEAR) * 2.5 * (1 - ego * 0.7);
  out[base + Verb.REST] = (1 - hunger) * 0.5 - a.h(i, H.FEAR) * 1.0;
}

export { clamp01 };
