import { TICK_HZ, TICK_MS } from './constants.ts';

/**
 * How many simulation ticks a wall-clock gap is worth, and the remainder to
 * carry into the next call.
 *
 * This is the entire speed control, pulled out of the worker loop so it can
 * be tested without a browser and without a clock. The old loop stepped
 * `min(speed, what fits in a 10ms budget)` times per 4ms wake-up, so the
 * multiplier was really a hint that lost to the CPU long before 16x, and two
 * different settings produced the same ticks/second. Here the multiplier
 * divides the tick interval and nothing else does: at 1x a tick is every
 * 100ms, at 16x every 6.25ms, and the remainder is carried so the long-run
 * rate is exact rather than a floor.
 */
export function ticksDue(
  carriedMs: number, elapsedMs: number, speed: number, maxCatchup: number,
): { ticks: number; carryMs: number } {
  const s = speed > 0 ? speed : 1;
  const interval = TICK_MS / s;
  const acc = carriedMs + (elapsedMs > 0 ? elapsedMs : 0);
  let ticks = Math.floor(acc / interval);
  let carryMs = acc - ticks * interval;
  if (ticks > maxCatchup) {
    // A backgrounded tab owes seconds of wall clock. Paying all of it at once
    // freezes the page; the world resumes where it was instead.
    ticks = maxCatchup;
    carryMs = 0;
  }
  return { ticks, carryMs };
}

/** Ticks per second a given speed asks for. Shown next to the measured rate
 *  so "16x" can be checked rather than believed. */
export function targetHz(speed: number): number {
  return Math.round(TICK_HZ * (speed > 0 ? speed : 1));
}
