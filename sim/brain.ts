import {
  N_INPUTS, N_HIDDEN, N_OUTPUTS, N_PARAMS, N_MOVE, N_VERB, VERB_OUT_BASE,
  W1_SIZE, B1_SIZE, W2_SIZE, B2_SIZE, WV_SIZE, BV_SIZE, MAX_AGENTS,
  DISCOUNT, LEARNING_RATE, RMS_DECAY, RMS_EPS, W_CLIP_RMS, ADV_CLIP,
} from './constants.ts';
import { RNG } from './rng.ts';

// Offsets inside one agent's weight block.
const O_W1 = 0;
const O_B1 = O_W1 + W1_SIZE;          // 4288
const O_W2 = O_B1 + B1_SIZE;          // 4352
const O_B2 = O_W2 + W2_SIZE;          // 5568
const O_WV = O_B2 + B2_SIZE;          // 5587  (critic, was the value's home)
const O_BV = O_WV + WV_SIZE;          // 5651
const O_PARAMS_END = O_BV + BV_SIZE;  // 5652
export const PARAM_OFFSETS = { O_W1, O_B1, O_W2, O_B2, O_WV, O_BV, O_PARAMS_END } as const;

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
  /** The action actually taken at that state, which the policy gradient needs
   *  and which is only known after the argmax — a few lines below the point
   *  the state is saved. Recorded separately rather than in `save`. */
  move = new Int8Array(MAX_AGENTS);
  verb = new Int8Array(MAX_AGENTS);
  hasPrev = new Uint8Array(MAX_AGENTS);

  save(i: number, x: Float32Array, h: Float32Array, q: Float32Array, v: number): void {
    this.inputs.set(x, i * N_INPUTS);
    this.hidden.set(h, i * N_HIDDEN);
    this.outputs.set(q, i * N_OUTPUTS);
    this.value[i] = v;
    this.hasPrev[i] = 1;
  }

  saveAction(i: number, move: number, verb: number): void {
    this.move[i] = move;
    this.verb[i] = verb;
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

  const lv = Math.sqrt(6 / (N_HIDDEN + BV_SIZE));
  for (let i = 0; i < WV_SIZE; i++) w[off + O_WV + i] = rng.range(-lv, lv);
  for (let i = 0; i < BV_SIZE; i++) w[off + O_BV + i] = rng.range(-lv, lv);
}

/**
 * Forward pass into caller-owned buffers. `x[0]` must be the bias term.
 * Returns the critic's value estimate for this state.
 *
 * The 19 outputs are the policy and nothing else: 9 movement logits then 10
 * verb logits. The value used to be `softmaxValue` over these same 19
 * numbers, which is what welded the two together — see `tdGrad`.
 */
export function forward(
  w: Float32Array, off: number,
  x: Float32Array, h: Float32Array, q: Float32Array,
): number {
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

  let v = w[off + O_BV];
  for (let j = 0; j < WV_SIZE; j++) v += w[off + O_WV + j] * h[j];
  return v;
}

/** Softmax over a slice of the output head, written into `out`. */
function softmaxSlice(q: Float32Array, base: number, n: number, out: Float32Array): void {
  let max = -Infinity;
  for (let k = 0; k < n; k++) if (q[base + k] > max) max = q[base + k];
  let sum = 0;
  for (let k = 0; k < n; k++) sum += Math.exp(q[base + k] - max);
  const inv = 1 / sum;
  for (let k = 0; k < n; k++) out[k] = Math.exp(q[base + k] - max) * inv;
}

/**
 * Actor-critic gradient, written into `grad`. No allocation, no forward pass.
 *
 * Two heads, two jobs, and the separation between them is the whole point.
 *
 * The critic regresses `V(s)` onto the TD target and touches only its own
 * weights plus, through the shared hidden layer, everything below. The policy
 * is improved by the policy gradient theorem on the one-step advantage
 * estimate `A = delta`:
 *
 *     dJ/dz_k = A * p_k * (1[k == a] - p_k)
 *
 * with `z` the action logits and `a` the action actually taken. Actions whose
 * advantage came out positive are reinforced, negative ones are suppressed.
 * The 19 outputs are two independent categorical policies — 9 movement logits
 * and 10 verb logits — so each gets its own softmax and its own argmax.
 *
 * This replaced a rule that had no policy gradient at all. It read
 * `dV/dz_k = p_k * (1 + (q_k - V) / T)` over the same 19 numbers the policy
 * chose from, so the only force acting on the action logits was value
 * regression, and its sign was to sharpen the softmax toward its own argmax
 * regardless of what the reward said. Turning on learning therefore made
 * pixels worse rather than better, and the damage scaled with the learning
 * rate: peak population 16 / 12 / 112 / 80 / 491 / 413 at LEARNING_RATE
 * 0.01 / 0.001 / 0.0001, against 456 / 486 with no learning at all, and the
 * `EAT` verb collapsed to 3.0% of all choices. See the note on `W_CLIP_RMS`
 * for the separate value divergence this rule also produced.
 *
 * Returns the raw TD error, which the caller reports as the advantage.
 */
export function tdGrad(
  w: Float32Array, off: number, grad: Float32Array, dz: Float32Array, dh: Float32Array,
  xPrev: Float32Array, hPrev: Float32Array, qPrev: Float32Array, vPrev: number,
  vCur: number, reward: number, movePrev: number, verbPrev: number,
): number {
  const delta = reward + DISCOUNT * vCur - vPrev;
  const adv = delta > ADV_CLIP ? ADV_CLIP : delta < -ADV_CLIP ? -ADV_CLIP : delta;

  // SIGN CONVENTION. `grad` is dLoss/dw, and `applyRmsprop` descends it. Both
  // heads therefore carry a leading minus, and it is not cosmetic.
  //
  // The critic's loss is 1/2 (V - T)^2, so dLoss/dV = V - T = -delta, and the
  // descent step is V <- V + lr*delta: the value must RISE when the TD error is
  // positive. Writing grad = +delta * df/dtheta instead — which is what the
  // single-head version of this function did, for every agent, for the whole
  // life of the project — inverts that. The value then moves *away* from its
  // target, the error grows, and the error growing drives the value further
  // still: a positive feedback loop whose fixed point is the weight ceiling.
  // Rewards here are persistently negative (hunger and thirst both subtract
  // every tick), so the correct value is r/(1-gamma) = -0.15/0.05 = -3, and
  // measured before this sign was fixed the mean value ran to +39.15, pinned
  // against W_CLIP_RMS, with meanDelta -1.597. With V pinned there, delta
  // collapses to a near-constant and the policy gradient has no discriminative
  // signal left in it at all.
  //
  // The policy is the same story from the other side: maximising return means
  // minimising -A * log(pi(a)), so its entries are negated for the same reason.
  grad.fill(0);
  for (let j = 0; j < N_HIDDEN; j++) dh[j] = 0;

  // --- policy: two categorical heads, each reinforced by its own advantage ---
  // Movement logits live at 0..N_MOVE and verb logits at VERB_OUT_BASE..+N_VERB,
  // which between them are exactly the 19 outputs. Each head's contribution is
  // folded into both `grad` and the shared `dh` before `dz` is reused for the
  // other head.
  softmaxSlice(qPrev, 0, N_MOVE, dz);
  for (let k = 0; k < N_MOVE; k++) {
    const p = dz[k];
    const gk = -adv * p * ((k === movePrev ? 1 : 0) - p);
    if (gk === 0) continue;
    const row = O_W2 + k * N_HIDDEN;
    for (let j = 0; j < N_HIDDEN; j++) {
      grad[row + j] += gk * hPrev[j];
      dh[j] += gk * w[row + j];
    }
    grad[O_B2 + k] += gk;
  }

  softmaxSlice(qPrev, VERB_OUT_BASE, N_VERB, dz);
  for (let k = 0; k < N_VERB; k++) {
    const p = dz[k];
    const gk = -adv * p * ((k === verbPrev ? 1 : 0) - p);
    if (gk === 0) continue;
    const row = O_W2 + (VERB_OUT_BASE + k) * N_HIDDEN;
    for (let j = 0; j < N_HIDDEN; j++) {
      grad[row + j] += gk * hPrev[j];
      dh[j] += gk * w[row + j];
    }
    grad[O_B2 + VERB_OUT_BASE + k] += gk;
  }

  // --- critic: regress V on the TD target, with its own weights ------------
  for (let j = 0; j < WV_SIZE; j++) grad[O_WV + j] = -delta * hPrev[j];
  grad[O_BV] = -delta;
  for (let j = 0; j < WV_SIZE; j++) dh[j] -= delta * w[off + O_WV + j];

  // --- one shared hidden layer, carrying both heads' signal ---------------
  for (let j = 0; j < N_HIDDEN; j++) dh[j] *= 1 - hPrev[j] * hPrev[j];

  for (let j = 0; j < N_HIDDEN; j++) {
    const gh = dh[j];
    const row = O_W1 + j * N_INPUTS;
    for (let i = 0; i < N_INPUTS; i++) grad[row + i] += gh * xPrev[i];
    grad[O_B1 + j] += gh;
  }

  return delta;
}

/**
 * RMSprop update, then clipped to a bounded norm.
 *
 * `grad` arrives already carrying the TD error, for both heads: the critic
 * entry is `delta * h` and the policy entries are `A * p * (1 - p)`. It used
 * to be scaled here by a `scale` argument instead, which is not equivalent
 * once the policy gradient is in the mix — the critic wants the raw error and
 * the policy wants the clipped advantage, and one outside multiplier cannot
 * express both.
 */
export function applyRmsprop(
  w: Float32Array, off: number, rms: Float32Array, grad: Float32Array,
): void {
  for (let i = 0; i < N_PARAMS; i++) {
    const idx = off + i;
    const g = grad[i];
    const r = rms[idx] * RMS_DECAY + (1 - RMS_DECAY) * g * g;
    rms[idx] = r;
    w[idx] -= LEARNING_RATE * g / (Math.sqrt(r) + RMS_EPS);
  }

  // Rescale the whole brain in place once it outgrows its ceiling. The value
  // estimate is read off these same weights, so an unbounded norm is an
  // unbounded value; see W_CLIP_RMS for the measurement. One pass, no
  // allocation, and it only costs anything once a brain is actually clipping.
  let ss = 0;
  for (let i = 0; i < N_PARAMS; i++) { const v = w[off + i]; ss += v * v; }
  const norm = Math.sqrt(ss / N_PARAMS);
  if (norm > W_CLIP_RMS) {
    const k = W_CLIP_RMS / norm;
    for (let i = 0; i < N_PARAMS; i++) w[off + i] *= k;
  }
}

/**
 * Child brain = alpha*p1 + (1-alpha)*p2 + noise.
 * `attachment` supplies alpha: a pixel that barely inherits is born nearly
 * random however good its parents were.
 *
 * The RMSprop accumulator is reset here rather than in `Agents.alloc`, which
 * resets every other per-agent buffer it can reach. `rms` belongs to `Sim`, so
 * it was out of there — and a newborn landing in a recycled slot kept the dead
 * occupant's running gradient statistics, which then divided the step size for
 * the rest of its life. The new brain's first gradients are not the old brain's.
 */
export function inheritBrain(
  w: Float32Array, off: number, p1: number, p2: number,
  alpha: number, sigma: number, rng: RNG, rms?: Float32Array,
): void {
  for (let i = 0; i < N_PARAMS; i++) {
    w[off + i] = alpha * w[p1 + i] + (1 - alpha) * w[p2 + i] + rng.gauss() * sigma;
  }
  if (rms) rms.fill(0, off, off + N_PARAMS);
}
