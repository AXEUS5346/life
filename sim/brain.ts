import {
  N_INPUTS, N_HIDDEN, N_OUTPUTS, N_PARAMS,
  W1_SIZE, B1_SIZE, W2_SIZE, B2_SIZE, MAX_AGENTS,
  DISCOUNT, LEARNING_RATE, RMS_DECAY, RMS_EPS,
} from './constants.ts';
import { RNG } from './rng.ts';

// Offsets inside one agent's weight block.
const O_W1 = 0;
const O_B1 = O_W1 + W1_SIZE;          // 1536
const O_W2 = O_B1 + B1_SIZE;          // 1584
const O_B2 = O_W2 + W2_SIZE;          // 2352
export const PARAM_OFFSETS = { O_W1, O_B1, O_W2, O_B2 } as const;

/** Reusable per-agent scratch so the hot loop never allocates. */
export class BrainScratch {
  inputs = new Float32Array(N_INPUTS);
  hidden = new Float32Array(N_HIDDEN);
  outputs = new Float32Array(N_OUTPUTS);
  grad = new Float32Array(N_PARAMS);
  dz = new Float32Array(N_OUTPUTS);
  dh = new Float32Array(N_HIDDEN);
}

/** Per-agent memory of the previous decision, so TD needs no second forward. */
export class BrainHistory {
  inputs = new Float32Array(MAX_AGENTS * N_INPUTS);
  hidden = new Float32Array(MAX_AGENTS * N_HIDDEN);
  outputs = new Float32Array(MAX_AGENTS * N_OUTPUTS);
  value = new Float32Array(MAX_AGENTS);
  hasPrev = new Uint8Array(MAX_AGENTS);

  save(i: number, x: Float32Array, h: Float32Array, q: Float32Array, v: number): void {
    this.inputs.set(x, i * N_INPUTS);
    this.hidden.set(h, i * N_HIDDEN);
    this.outputs.set(q, i * N_OUTPUTS);
    this.value[i] = v;
    this.hasPrev[i] = 1;
  }

  clear(i: number): void {
    this.hasPrev[i] = 0;
  }
}

/** Glorot-uniform init. An untrained brain is pure noise, by design. */
export function initBrain(w: Float32Array, off: number, rng: RNG): void {
  const l1 = Math.sqrt(6 / (N_INPUTS + N_HIDDEN));
  for (let i = 0; i < W1_SIZE; i++) w[off + O_W1 + i] = rng.range(-l1, l1);
  for (let i = 0; i < B1_SIZE; i++) w[off + O_B1 + i] = rng.range(-l1, l1);

  const l2 = Math.sqrt(6 / (N_HIDDEN + N_OUTPUTS));
  for (let i = 0; i < W2_SIZE; i++) w[off + O_W2 + i] = rng.range(-l2, l2);
  for (let i = 0; i < B2_SIZE; i++) w[off + O_B2 + i] = rng.range(-l2, l2);
}

/** Forward pass into caller-owned buffers. `x[0]` must be the bias term. */
export function forward(
  w: Float32Array, off: number,
  x: Float32Array, h: Float32Array, q: Float32Array,
): void {
  let p = off + O_W1;
  for (let j = 0; j < N_HIDDEN; j++) {
    let sum = w[off + O_B1 + j];
    for (let i = 0; i < N_INPUTS; i++) sum += w[p + i] * x[i];
    h[j] = Math.tanh(sum);
    p += N_INPUTS;
  }
  p = off + O_W2;
  for (let k = 0; k < N_OUTPUTS; k++) {
    let sum = w[off + O_B2 + k];
    for (let j = 0; j < N_HIDDEN; j++) sum += w[p + j] * h[j];
    q[k] = sum;
    p += N_HIDDEN;
  }
}

/**
 * Softmax policy value:  V(s) = SUM_k p_k * q_k,  p = softmax(q).
 *
 * A soft value rather than max(q) on purpose: max over a learned function
 * approximator overestimates (the classic deadly-triad failure) and made
 * 600 parallel agents diverge to NaN. Averaging under the policy's own
 * distribution is stable and backpropagates through the whole network.
 */
export function softmaxValue(q: Float32Array, temperature = 1.0): number {
  let max = -Infinity;
  for (let k = 0; k < N_OUTPUTS; k++) if (q[k] > max) max = q[k];
  let sum = 0;
  for (let k = 0; k < N_OUTPUTS; k++) sum += Math.exp((q[k] - max) / temperature);
  const inv = 1 / (sum * temperature);
  let v = 0;
  for (let k = 0; k < N_OUTPUTS; k++) v += Math.exp((q[k] - max) / temperature) * inv * q[k];
  return v;
}

/**
 * TD(0) gradient, written into `grad`. No allocation, no forward pass.
 *
 *   dV/dz_k = p_k * (1 + (q_k - V) / T)     with z = q
 */
export function tdGrad(
  w: Float32Array, off: number, grad: Float32Array, dz: Float32Array, dh: Float32Array,
  xPrev: Float32Array, hPrev: Float32Array, qPrev: Float32Array, vPrev: number,
  vCur: number, reward: number, temperature = 1.0,
): number {
  const delta = reward + DISCOUNT * vCur - vPrev;

  let max = -Infinity;
  for (let k = 0; k < N_OUTPUTS; k++) if (qPrev[k] > max) max = qPrev[k];
  let sum = 0;
  for (let k = 0; k < N_OUTPUTS; k++) sum += Math.exp((qPrev[k] - max) / temperature);
  const inv = 1 / (sum * temperature);

  let vRecomputed = 0;
  for (let k = 0; k < N_OUTPUTS; k++) {
    vRecomputed += Math.exp((qPrev[k] - max) / temperature) * inv * qPrev[k];
  }
  // guard: history can drift if a brain was edited between ticks
  const vp = vPrev === 0 ? vRecomputed : vPrev;

  for (let k = 0; k < N_OUTPUTS; k++) {
    const p = Math.exp((qPrev[k] - max) / temperature) * inv;
    dz[k] = p * (1 + (qPrev[k] - vp) / temperature);
  }

  grad.fill(0);

  for (let k = 0; k < N_OUTPUTS; k++) {
    const gk = dz[k];
    const row = off + O_W2 + k * N_HIDDEN;
    for (let j = 0; j < N_HIDDEN; j++) grad[row + j] += gk * hPrev[j];
    grad[off + O_B2 + k] += gk;
  }

  for (let j = 0; j < N_HIDDEN; j++) {
    let acc = 0;
    for (let k = 0; k < N_OUTPUTS; k++) acc += dz[k] * w[off + O_W2 + k * N_HIDDEN + j];
    dh[j] = acc * (1 - hPrev[j] * hPrev[j]);
  }

  for (let j = 0; j < N_HIDDEN; j++) {
    const gh = dh[j];
    const row = off + O_W1 + j * N_INPUTS;
    for (let i = 0; i < N_INPUTS; i++) grad[row + i] += gh * xPrev[i];
    grad[off + O_B1 + j] += gh;
  }

  return delta;
}

/** RMSprop update, scaled by the TD error. */
export function applyRmsprop(
  w: Float32Array, off: number, rms: Float32Array, grad: Float32Array, scale: number,
): void {
  for (let i = 0; i < N_PARAMS; i++) {
    const idx = off + i;
    const g = grad[i];
    const r = rms[idx] * RMS_DECAY + (1 - RMS_DECAY) * g * g;
    rms[idx] = r;
    w[idx] -= LEARNING_RATE * scale * g / (Math.sqrt(r) + RMS_EPS);
  }
}

/**
 * Child brain = alpha*p1 + (1-alpha)*p2 + noise.
 * `attachment` supplies alpha: a pixel that barely inherits is born nearly
 * random however good its parents were.
 */
export function inheritBrain(
  w: Float32Array, off: number, p1: number, p2: number,
  alpha: number, sigma: number, rng: RNG,
): void {
  for (let i = 0; i < N_PARAMS; i++) {
    w[off + i] = alpha * w[p1 + i] + (1 - alpha) * w[p2 + i] + rng.gauss() * sigma;
  }
}
