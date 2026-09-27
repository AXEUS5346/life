'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GRID_W, GRID_H, HARD_CAP, SOFT_CAP, START_POP, TICK_HZ, DAY_TICKS } from '@/sim/constants.ts';
import { EMOTION, HORMONE_NAMES } from '@/sim/render.ts';
import type { AgentDetail, PredDetail, ToWorker, PredRow } from '@/worker/sim.worker.ts';
import { WorkerCanvas } from '@/components/WorkerCanvas.tsx';
import { Sidebar } from '@/components/Sidebar.tsx';

export type Stats = {
  tick: number; pop: number; births: number; kills: number; betraysals: number;
  meanLifespan: number; generation: number; season: string; food: number;
  epsilon: number; free: number;
  predators: number; predSmall: number;
  predKills: number; predMobbed: number; predBorn: number;
  meat: number;
  /** The multiplier the user asked for. */
  speed: number;
  /** What the simulation actually achieved, measured over the last second.
   *  Shown next to the target so "16x" can be checked rather than believed. */
  ticksPerSec: number;
  targetHz: number;
  preds: PredRow[];
  deaths: {
    starvation: number; dehydration: number;
    age: number; crowding: number; killed: number;
  };
};

const SPEEDS = [1, 2, 4, 8, 16];
const LEGEND = HORMONE_NAMES;

/** Dawn/day/dusk/night is four numbers, and the single most important
 *  fact on the screen is which of them the predators are allowed to hunt in,
 *  so the phase is in the top bar where it cannot be missed. */
const PHASE_LABEL = ['dawn', 'day', 'dusk', 'night'] as const;

/** The phase, derived from the tick counter the worker already sends. The
 *  four windows are contiguous over the 400-tick day. */
function phaseOf(tick: number): 0 | 1 | 2 | 3 {
  const t = (tick % DAY_TICKS) / DAY_TICKS;
  if (t < 0.12) return 0;
  if (t < 0.50) return 1;
  if (t < 0.62) return 2;
  return 3;
}

export default function Page() {
  const workerRef = useRef<Worker | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(4);
  const [seed, setSeed] = useState(20260927);
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<{ pop: number; life: number }[]>([]);
  const [detail, setDetail] = useState<AgentDetail | PredDetail | null>(null);
  const [hoverCell, setHoverCell] = useState<number>(-1);

  // boot the worker
  useEffect(() => {
    const w = new Worker(new URL('../worker/sim.worker.ts', import.meta.url));
    workerRef.current = w;
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'ready') {
        setReady(true);
        // the worker's own default is 1x and the UI opens at 4x: without
        // this the pressed button and the measured rate disagree until the
        // first click. `speed` is the opening value, which is what we want.
        w.postMessage({ type: 'speed', value: speed } as ToWorker);
        return;
      }
      if (m.type === 'frame') {
        setStats(m.stats as Stats);
        setHistory((h) => {
          const next = h.concat({ pop: m.stats.pop, life: m.stats.meanLifespan });
          return next.length > 220 ? next.slice(-220) : next;
        });
        return;
      }
      if (m.type === 'inspect') { setDetail(m.detail as AgentDetail | PredDetail | null); return; }
    };
    w.postMessage({ type: 'init', seed: 20260927, startPop: START_POP } as ToWorker);
    return () => { w.terminate(); workerRef.current = null; };
  }, []);

  const send = useCallback((msg: ToWorker) => {
    workerRef.current?.postMessage(msg);
  }, []);

  const toggle = useCallback(() => {
    setPlaying((p) => {
      send({ type: p ? 'pause' : 'play' });
      return !p;
    });
  }, [send]);

  const changeSpeed = useCallback((v: number) => {
    setSpeed(v);
    send({ type: 'speed', value: v });
  }, [send]);

  const stepOnce = useCallback(() => send({ type: 'stepOnce' }), [send]);

  const reset = useCallback((newSeed: number) => {
    setSeed(newSeed);
    setHistory([]);
    setDetail(null);
    send({ type: 'reset', seed: newSeed, startPop: START_POP });
  }, [send]);

  const inspectCell = useCallback((cell: number) => {
    setHoverCell(cell);
    send({ type: 'inspect', cell });
  }, [send]);

  // keyboard: space = play/pause, arrows = speed
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      if (e.code === 'ArrowRight') { e.preventDefault(); stepOnce(); }
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        const i = SPEEDS.indexOf(speed);
        const n = Math.max(0, Math.min(SPEEDS.length - 1, i + (e.code === 'ArrowUp' ? 1 : -1)));
        changeSpeed(SPEEDS[n]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, stepOnce, speed, changeSpeed]);

  const popPct = stats ? stats.pop / HARD_CAP : 0;
  const phaseIndex = phaseOf(stats?.tick ?? 0);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">pixels <span>/ life sim</span></div>

        <div className="speed-group" role="group" aria-label="Simulation speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              data-active={speed === s}
              onClick={() => changeSpeed(s)}
              aria-pressed={speed === s}
              title={`${s} tick${s === 1 ? '' : 's'} every 100ms — ${TICK_HZ * s} ticks/second`}
            >
              {s}&times;
            </button>
          ))}
          <span
            className="speed-read"
            title={`Measured over the last second. Target for ${speed}x is ${TICK_HZ * speed} ticks/second.`}
          >
            <b>{Math.round(stats?.ticksPerSec ?? 0)}</b>
            <em>/{stats?.targetHz ?? TICK_HZ * speed} tps</em>
          </span>
        </div>

        <button onClick={toggle} data-active={playing} aria-pressed={playing}>
          {playing ? '❚❚ pause' : '▶ play'}
        </button>
        <button onClick={stepOnce} disabled={playing}>step</button>

        <div className="spacer" />

        <span className="kv" style={{ display: 'inline-flex', gap: 6, marginRight: 4 }}>
          <span style={{ color: 'var(--ink-faint)' }} title="Ticks elapsed. One tick is 100ms of real time at 1x.">ticks</span>
          <span style={{ color: 'var(--ink-mid)' }} title="Ticks elapsed. One tick is 100ms of real time at 1x.">{stats?.tick ?? 0}</span>
          <span style={{ color: 'var(--ink-faint)' }} title="What part of the day it is. Predators hunt at night; a starving one hunts in daylight.">phase</span>
          <span style={{ color: 'var(--ink-mid)' }} title="What part of the day it is. Predators hunt at night; a starving one hunts in daylight.">{PHASE_LABEL[phaseIndex]}</span>
          <span style={{ color: 'var(--ink-faint)' }} title="Breeding rounds deep the founding lineage runs.">gen</span>
          <span style={{ color: 'var(--ink-mid)' }} title="Breeding rounds deep the founding lineage runs.">{stats?.generation ?? 0}</span>
        </span>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: 'var(--ink-faint)', fontSize: 10, letterSpacing: '0.08em' }}>SEED</span>
          <input
            className="seed-input"
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value) || 0)}
            onKeyDown={(e) => { if (e.key === 'Enter') reset(seed); }}
            aria-label="World seed"
          />
        </label>
        <button onClick={() => reset(seed)}>new world</button>
      </header>

      <div className="stage">
        <WorkerCanvas
          worker={workerRef}
          onInspect={inspectCell}
          onReturnBuffer={(buf) => send({ type: 'return', buffer: buf })}
        />
        <div className="overlay-legend">
          {LEGEND.map((name, i) => (
            <span key={name}>
              <i style={{ background: `rgb(${EMOTION[i].join(',')})` }} />
              <em>{name}</em>
            </span>
          ))}
        </div>
        <div className="overlay-hint">
          click a pixel to inspect · space = play/pause · ↑↓ = speed · → = step
        </div>
      </div>

      <Sidebar stats={stats} history={history} detail={detail} />
    </div>
  );
}

export { GRID_W, GRID_H, SOFT_CAP };
