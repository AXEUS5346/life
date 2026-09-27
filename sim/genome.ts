import { RNG } from './rng.ts';
import { N_GENES } from './constants.ts';

/** Index of each gene. Order is fixed: it is the on-disk and breeding format. */
export const GENE = {
  METABOLISM: 0,    // how fast hunger rises
  ENERGY_CAP: 1,    // how much energy can be stored
  FERTILITY_AGE: 2, // low = matures early
  LIBIDO: 3,        // strength of desire
  AGGRESSION: 4,    // how easily desperation turns lethal
  SOCIABILITY: 5,   // pull toward other pixels
  ATTACHMENT: 6,    // how much of each parent's brain is inherited
  LIFESPAN: 7,
  CURIOSITY: 8,     // baseline random-walk
  MOVE_COST: 9,     // energy per step
} as const;

export const GENE_NAMES = [
  'metabolism', 'energyCap', 'fertilityAge', 'libido', 'aggression',
  'sociability', 'attachment', 'lifespan', 'curiosity', 'moveCost',
] as const;

export const MUTATION_SIGMA = 0.06;

export function randomGenome(rng: RNG, out: Float32Array): void {
  for (let i = 0; i < N_GENES; i++) out[i] = rng.next();
}

/** Per-gene blend, so children can be mosaics of both parents, then mutate. */
export function crossover(
  a: Float32Array, b: Float32Array, rng: RNG, out: Float32Array,
): void {
  for (let i = 0; i < N_GENES; i++) {
    // sometimes a clean single-parent allele, otherwise a blend
    const t = rng.chance(0.35) ? (rng.chance(0.5) ? 0 : 1) : rng.next();
    let g = a[i] * t + b[i] * (1 - t);
    g += rng.gauss() * MUTATION_SIGMA;
    out[i] = g < 0 ? 0 : g > 1 ? 1 : g;
  }
}

export function geneOf(g: Float32Array, which: number): number {
  return g[which];
}
