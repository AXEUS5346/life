'use client';

import { useEffect, useRef } from 'react';
import {
  HARD_CAP, SOFT_CAP, TICK_MS, N_INPUTS, N_HIDDEN,
  TERRAIN_NAMES,
  T_OPEN, T_ROCK, T_WATER, T_DEAD, T_SAND, T_FOREST, T_MARSH, T_SNOW, T_CAVE,
  DAY_TICKS,
  PRED_DEN_CAP, PRED_DEN_ENERGY, PRED_STARVE_ENERGY,
  PRED_HUNT_R_SMALL, PRED_HUNT_R_LARGE, PRED_MATE_R,
  MOBS_TO_KILL_SMALL, MOBS_TO_KILL_LARGE,
} from '@/sim/constants.ts';
import { EMOTION } from '@/sim/render.ts';
import type { AgentDetail, PredDetail, PredRow } from '@/worker/sim.worker.ts';
import type { Stats } from '@/app/page.tsx';

type Props = {
  stats: Stats | null;
  history: { pop: number; life: number }[];
  detail: AgentDetail | PredDetail | null;
};

const DEATH_COLORS: Record<string, string> = {
  starvation: 'var(--hunger)',
  dehydration: 'var(--thirst)',
  age: 'var(--ego)',
  crowding: 'var(--fear)',
  killed: 'var(--anger)',
};

/**
 * One row per biome, in terrain-id order. The swatches are the exact ground
 * colours the renderer paints, so a pixel standing in the key is the colour a
 * pixel standing on the map is; the sentence is what that ground does to a
 * creature, which is the only way a nine-colour map becomes readable.
 */
const MAP_KEY: { id: number; css: string; note: string }[] = [
  { id: T_OPEN, css: 'rgb(66,70,38)', note: 'open grass, walkable and lightly fertile' },
  { id: T_ROCK, css: 'rgb(104,106,120)', note: 'impassable — nothing crosses it or grows on it' },
  { id: T_WATER, css: 'rgb(18,42,96)', note: 'wadeable, but drains energy 2.5× as fast' },
  { id: T_DEAD, css: 'rgb(126,70,34)', note: 'barren for good — nothing will ever grow here' },
  { id: T_SAND, css: 'rgb(190,168,116)', note: 'the river bank: walkable, and grows no food' },
  { id: T_FOREST, css: 'rgb(18,40,26)', note: 'dense wood, the richest food on the map' },
  { id: T_MARSH, css: 'rgb(40,96,104)', note: 'wetland, walkable, drains you slowly' },
  { id: T_SNOW, css: 'rgb(222,230,242)', note: 'high frozen ground, walkable and near-barren' },
  { id: T_CAVE, css: 'rgb(66,26,66)', note: 'a den mouth, where the predators live' },
];

/** A tick is TICK_MS of wall-clock, so a lifespan in ticks can be said out
 *  loud in the units a person actually has. */
function fmtTime(ticks: number): string {
  const s = Math.round(ticks * (TICK_MS / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? '' : 's'} ${m % 60} min`;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** -1 is the wire's way of saying "no such thing right now", and for a
 *  predator's mate that is information rather than a missing number. */
function cells(d: number, none = 'none in range'): string {
  return d < 0 ? none : `${Math.round(d)} cells`;
}

/** One plain sentence, so the numbers below have something to hang off. */
function summary(s: Stats): string {
  const totalDeaths = Object.values(s.deaths).reduce((a, b) => a + b, 0);
  const foodWord = s.food < 8000 ? 'running short of food'
    : s.food < 25000 ? 'thinning out'
    : 'plentiful';
  const preds = s.preds ?? [];
  const hunting = preds.filter((p) => p.hunting).length;
  const parts = [
    `The world is in ${s.season}.`,
    `${plural(s.pop, 'pixel')} alive out of a hard cap of ${HARD_CAP}, at generation ${s.generation}.`,
    `Food is ${foodWord}.`,
    `The average pixel lives about ${fmtTime(s.meanLifespan)}.`,
  ];
  if (preds.length > 0) {
    parts.push(
      `${plural(preds.length, 'predator')} alive: ${hunting} out of the den hunting, ` +
      `${preds.length - hunting} resting in their dens — ` +
      `${s.predKills === 0 ? 'nothing has been eaten yet' : `they have taken ${plural(s.predKills, 'pixel')}`}, ` +
      `and ${plural(s.predMobbed, 'predator')} ${s.predMobbed === 1 ? 'has' : 'have'} been mobbed down.`,
    );
  } else if (s.predKills > 0) {
    parts.push(`The last predator is gone. It ate ${plural(s.predKills, 'pixel')} first.`);
  }
  if (s.betraysals > 0) {
    parts.push(`${plural(s.betraysals, 'pixel')} ${s.betraysals === 1 ? 'has' : 'have'} abandoned a bonded partner.`);
  }
  if (totalDeaths > 0) parts.push(`${plural(totalDeaths, 'death')} so far.`);
  return parts.join(' ');
}

export function Sidebar({ stats, history, detail }: Props) {
  return (
    <aside className="side">
      <section className="sec">
        <h2>world <em>{stats?.season ?? '—'}</em></h2>
        {!stats ? (
          <div className="empty">waking the world…</div>
        ) : (
          <>
            <MapKey />
            <p className="summary">{summary(stats)}</p>
            <div className="grid2">
              <div className="stat" title="How many pixels are alive right now, against the hard cap the world refuses to pass">
                <b>{stats.pop}<span className="of">/{HARD_CAP}</span></b>
                <span>pixels alive</span>
              </div>
              <div className="stat" title="Every pixel born since the world began, including those already dead">
                <b>{stats.births.toLocaleString()}</b>
                <span>born, all time</span>
              </div>
              <div className={`stat${stats.food < 8000 ? ' warn' : ''}`} title="Total edible energy left in the world. The starting reserve does not regrow, so this only falls.">
                <b>{stats.food.toLocaleString()}</b>
                <span>food left</span>
              </div>
              <div className="stat" title="Average age at death across every pixel that has died">
                <b>{Math.round(stats.meanLifespan)}<span className="of"> ticks</span></b>
                <span>mean life · {fmtTime(stats.meanLifespan)}</span>
              </div>
              <div className="stat" title="How many breeding rounds deep the founding lineage now runs">
                <b>{stats.generation}</b>
                <span>generation</span>
              </div>
              <div className="stat" title="Pixels killed outright by another pixel. Kills need desperation, so a high number means a hungry world.">
                <b>{stats.kills}</b>
                <span>killed by others</span>
              </div>
              <div className="stat" title="A pixel courted somebody else while bonded. The abandoned partner loses its love and gains anger.">
                <b>{stats.betraysals}</b>
                <span>abandoned a mate</span>
              </div>
              <div className="stat" title="Every pixel that has died, for any reason">
                <b>{Object.values(stats.deaths).reduce((a, b) => a + b, 0).toLocaleString()}</b>
                <span>died, all time</span>
              </div>
            </div>

            <PopBar pop={stats.pop} soft={SOFT_CAP} hard={HARD_CAP} />
            <Predators s={stats} />
            <DeathBlock deaths={stats.deaths} />
            <div className="blk">
              <h3>population <span>filled area = alive · dashed = hard cap {HARD_CAP}</span></h3>
              <Chart history={history} />
            </div>
          </>
        )}
      </section>

      <section className="sec">
        <h2>inspector</h2>
        {detail ? (detail.kind === 'predator'
          ? <PredInspector d={detail} />
          : <Inspector d={detail} />) : (
          <div className="empty">
            click any pixel or predator in the world to read its genome, its
            hormones, and the weights it inherited from its parents.
          </div>
        )}
      </section>
    </aside>
  );
}

/** The map is nine colours of ground. This is the legend that makes it a
 *  place: name, colour, and the one fact about that ground a creature can
 *  feel. Sits above the prose so the reader learns the alphabet first. */
function MapKey() {
  return (
    <div className="blk key">
      <h3>map key <span>nine grounds, in the order the world generator lays them down</span></h3>
      <div className="key-grid">
        {MAP_KEY.map((r) => (
          <div className="key-row" key={r.id}>
            <span className="key-swatch" style={{ background: r.css }} />
            <span className="key-name">{TERRAIN_NAMES[r.id]}</span>
            <span className="key-note">{r.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The other species, in the same plain numbers as everything else. A predator
 * is worth a pixel's life only in a crowd: three pixels finish a small one,
 * five finish a large one, and one pixel on its own is a meal.
 */
function Predators({ s }: { s: Stats }) {
  const preds = s.preds ?? [];
  const large = s.predators - s.predSmall;
  const hunting = preds.filter((p) => p.hunting).length;
  return (
    <div className="blk preds">
      <h3>
        predators
        <span>
          {preds.length === 0
            ? 'none left'
            : `${hunting} of ${preds.length} out of the den`}
        </span>
      </h3>
      <div className="grid2">
        <div className="stat" title="Predators currently alive. They start in dens, hunt when hungry, and breed far more slowly than pixels.">
          <b>{s.predators}<span className="of">/{PRED_DEN_CAP}</span></b>
          <span>predators alive</span>
        </div>
        <div className="stat" title="Every predator born since the world began, including the ones a mob of pixels has killed">
          <b>{s.predBorn}</b>
          <span>born, all time</span>
        </div>
        <div className="stat bad" title="Pixels eaten by predators. Each one drops meat on the ground where it fell.">
          <b>{s.predKills.toLocaleString()}</b>
          <span>pixels eaten</span>
        </div>
        <div className="stat" title="Predators killed by pixels. Three pixels mob a small predator, five mob a large one — damage scales with the square of the crowd, so one or two can never finish the job.">
          <b>{s.predMobbed}</b>
          <span>killed by a mob</span>
        </div>
        <div className="stat" title="Meat lying on the ground right now. It fills a pixel completely, clears all hunger, and is the only thing that gives dopamine — grass is a calorie, meat is a reward. It rots.">
          <b>{s.meat.toLocaleString()}</b>
          <span>meat on the ground</span>
        </div>
        <div className="stat" title="How many kills it would take: three pixels for a small predator, five for a large one.">
          <b>{MOBS_TO_KILL_SMALL}<em> / </em>{MOBS_TO_KILL_LARGE}</b>
          <span>mob needed · small / large</span>
        </div>
      </div>
      <p className="pred-rule">
        They leave the den at night. In daylight only a starving one comes
        out, and a day is {DAY_TICKS} ticks.
      </p>
      <PredRoster preds={preds} />
    </div>
  );
}

/** One block per animal rather than six aggregate numbers, because the only
 *  interesting question about a predator is what that one is doing right
 *  now. Males carry a blue rule and females a pink one, so a pair can be
 *  matched up across the list at a glance. */
function PredRoster({ preds }: { preds: PredRow[] }) {
  if (preds.length === 0) {
    return (
      <p className="pred-empty">
        No predator is alive. The next one moves in when a den is free and the
        world has enough prey left to feed it.
      </p>
    );
  }
  return (
    <div className="pred-list">
      {/* the roster is rebuilt from scratch every frame and carries no id, so
          the row index is the only stable key it has */}
      {preds.map((p, i) => <PredRow key={i} p={p} />)}
    </div>
  );
}

function PredRow({ p }: { p: PredRow }) {
  const energy = clamp01(p.energy ?? 0);
  const health = clamp01(p.health ?? 0);
  const big = p.size === 1;
  const male = p.sex === 0;
  // The two energy thresholds in the rule are the same numbers the animal
  // itself acts on, so the bar colour says what it is about to do.
  const energyColor = energy < PRED_STARVE_ENERGY ? 'var(--anger)'
    : energy < PRED_DEN_ENERGY ? 'var(--hunger)'
    : 'var(--calm)';
  return (
    <div className={`pred-row ${male ? 'm' : 'f'}`}>
      <div className="pred-id">
        <span className="pred-name">
          <i className="pred-sex" aria-hidden="true" />
          {big ? 'large' : 'small'} {male ? 'male' : 'female'}
        </span>
        <span className={`pred-badge ${p.hunting ? 'badge-hunt' : 'badge-den'}`}>
          {p.hunting ? 'HUNTING' : 'IN DEN'}
        </span>
      </div>
      <div className="meter" title="Belly. Above 0.65 it walks home and waits; below 0.22 hunger is an emergency and it hunts in daylight.">
        <div className="lab"><span>energy</span><span>{energy.toFixed(2)}</span></div>
        <div className="track"><div className="fill" style={{ width: `${energy * 100}%`, background: energyColor }} /></div>
      </div>
      <div className="pred-read">
        <span title={`How far it can notice a pixel this tick. A ${big ? 'large' : 'small'} predator starts at ${big ? PRED_HUNT_R_LARGE : PRED_HUNT_R_SMALL} cells and searches further the hungrier it gets.`}>
          vision <b>{Math.round(p.vision ?? 0)}</b> cells
        </span>
        <span title={`Distance to the nearest ${male ? 'female' : 'male'} it can see. Past ${PRED_MATE_R} cells it may as well be on another continent.`}>
          mate <b>{cells(p.mateDist ?? -1)}</b>
        </span>
        <span title="Pixels it has killed. Each one becomes meat where it fell.">
          kills <b>{p.kills ?? 0}</b>
        </span>
        <span title="Walking distance in cells to its den. A den is where it sleeps, breeds and is safe from a mob.">
          den <b>{cells(p.denDist ?? -1, 'no den')}</b>
        </span>
        <span title="Damage taken. A crowd of pixels is the only thing that can kill a predator.">
          hp <b className={health < 0.5 ? 'hurt' : undefined}>{health.toFixed(2)}</b>
        </span>
      </div>
    </div>
  );
}

/** A predator has no genome, no brain and no hormones, so this panel is not a
 *  stripped-down Inspector — it is the roster row for the one animal you
 *  clicked, plus the two facts the brief asked for: what it can see, and how
 *  far the nearest opposite-sex predator is. */
function PredInspector({ d }: { d: PredDetail }) {
  const energy = clamp01(d.energy);
  const health = clamp01(d.health);
  const big = d.size === 1;
  const male = d.sex === 0;
  const energyColor = energy < PRED_STARVE_ENERGY ? 'var(--anger)'
    : energy < PRED_DEN_ENERGY ? 'var(--hunger)'
    : 'var(--calm)';
  return (
    <>
      <div className="who">
        <span className={`chip ${male ? 'm' : 'f'}`}>{male ? 'male' : 'female'}</span>
        <span className="name">{big ? 'large predator' : 'small predator'}</span>
        <span className="sub">den {d.slot}<br />{d.x}, {d.y}</span>
      </div>
      <div style={{ margin: '6px 0 10px' }}>
        <span className={`pred-badge ${d.hunting ? 'badge-hunt' : 'badge-den'}`}>
          {d.hunting ? 'HUNTING' : 'IN DEN'}
        </span>
      </div>
      <div className="meter" title="Belly. Above 0.65 it walks home and waits; below 0.22 hunger is an emergency and it hunts in daylight.">
        <div className="lab"><span>energy</span><span>{energy.toFixed(2)}</span></div>
        <div className="track"><div className="fill" style={{ width: `${energy * 100}%`, background: energyColor }} /></div>
      </div>
      <div className="meter" title="Damage taken. A crowd of pixels is the only thing that can kill a predator.">
        <div className="lab"><span>health</span><span>{health.toFixed(2)}</span></div>
        <div className="track"><div className="fill" style={{ width: `${health * 100}%`, background: health < 0.5 ? 'var(--anger)' : 'var(--calm)' }} /></div>
      </div>
      <div className="pred-read">
        <span title={`How far it can notice a pixel this tick. A ${big ? 'large' : 'small'} predator starts at ${big ? PRED_HUNT_R_LARGE : PRED_HUNT_R_SMALL} cells and searches further the hungrier it gets.`}>
          vision <b>{Math.round(d.vision)}</b> cells
        </span>
        <span title={`Distance to the nearest ${male ? 'female' : 'male'} it can see. Past ${PRED_MATE_R} cells it may as well be on another continent.`}>
          mate <b>{cells(d.mateDist, 'none in range')}</b>
        </span>
        <span title="Walking distance in cells to its den. A den is where it sleeps, breeds and is safe from a mob.">
          den <b>{cells(d.denDist, 'no den')}</b>
        </span>
        <span title="Pixels it has killed. Each one becomes meat where it fell.">
          kills <b>{d.kills}</b>
        </span>
        <span title="The pixel slot it is hunting right now, if any.">
          prey <b>{d.huntingSlot >= 0 ? `slot ${d.huntingSlot}` : 'none'}</b>
        </span>
        <span title="Ticks lived.">
          age <b>{d.age}</b>
        </span>
      </div>
    </>
  );
}

function PopBar({ pop, soft, hard }: { pop: number; soft: number; hard: number }) {
  const pct = Math.min(1, pop / hard);
  const softPct = soft / hard;
  const color = pop > soft ? (pop > hard * 0.92 ? 'var(--anger)' : 'var(--hunger)') : 'var(--calm)';
  return (
    <div style={{ marginTop: 10 }}>
      <div className="track" style={{ position: 'relative', height: 5, background: '#182130', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct * 100}%`, height: '100%', background: color, borderRadius: 3 }} />
        <div style={{ position: 'absolute', left: `${softPct * 100}%`, top: -2, bottom: -2, width: 1, background: 'rgba(255,255,255,0.35)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--ink-faint)', marginTop: 3 }}>
        <span>soft cap {soft}</span>
        <span>hard cap {hard}</span>
      </div>
    </div>
  );
}

function DeathBlock({ deaths }: { deaths: Stats['deaths'] }) {
  const total = Object.values(deaths).reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="blk">
      <h3>deaths <span>all time, by cause</span></h3>
      <div className="deaths">
        {Object.entries(deaths).map(([k, v]) => (
          <div className="death-row" key={k}>
            <span>{k}</span>
            <div className="bar">
              <i style={{ width: `${(v / total) * 100}%`, background: DEATH_COLORS[k] }} />
            </div>
            <b>{v.toLocaleString()}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function Chart({ history }: { history: { pop: number; life: number }[] }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || history.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const n = history.length;
    const px = (i: number) => (i / (n - 1)) * w;

    // cap line
    const capY = h - (HARD_CAP / HARD_CAP) * (h - 4) - 2;
    ctx.strokeStyle = 'rgba(220,38,38,0.45)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(0, capY); ctx.lineTo(w, capY); ctx.stroke();
    ctx.setLineDash([]);

    // population fill
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < n; i++) ctx.lineTo(px(i), h - (history[i].pop / HARD_CAP) * (h - 4) - 2);
    ctx.lineTo(w, h); ctx.closePath();
    ctx.fillStyle = 'rgba(59,157,255,0.14)';
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const y = h - (history[i].pop / HARD_CAP) * (h - 4) - 2;
      i ? ctx.lineTo(px(i), y) : ctx.moveTo(px(i), y);
    }
    ctx.strokeStyle = '#3b9dff';
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }, [history]);
  return <canvas className="chart" ref={ref} />;
}

function Inspector({ d }: { d: AgentDetail }) {
  const lifePct = Math.min(1, d.age / d.maxAge);
  return (
    <>
      <div className="who">
        <span className={`chip ${d.sex === 0 ? 'm' : 'f'}`}>{d.sex === 0 ? 'male' : 'female'}</span>
        <span className="name">{d.lineageName}</span>
        <span className="sub">gen {d.generation}<br />slot {d.slot}</span>
      </div>

      <div className="meter">
        <div className="lab"><span>age</span><span>{d.age} / {d.maxAge}</span></div>
        <div className="track"><div className="fill" style={{ width: `${lifePct * 100}%`, background: 'var(--ink-mid)' }} /></div>
      </div>
      <div className="meter">
        <div className="lab"><span>energy</span><span>{d.energy.toFixed(2)}</span></div>
        <div className="track"><div className="fill" style={{ width: `${d.energy * 100}%`, background: d.energy < 0.25 ? 'var(--anger)' : 'var(--calm)' }} /></div>
      </div>
      <div className="meter" title="Thirst. At 1.0 it is killing this pixel, on exactly the same clock as an empty belly.">
        <div className="lab"><span>thirst</span><span>{d.thirst.toFixed(2)}</span></div>
        <div className="track"><div className="fill" style={{ width: `${d.thirst * 100}%`, background: d.thirst > 0.8 ? 'var(--anger)' : 'var(--thirst)' }} /></div>
      </div>
      <div className="meter">
        <div className="lab"><span>health</span><span>{d.health.toFixed(2)}</span></div>
        <div className="track"><div className="fill" style={{ width: `${Math.max(0, d.health) * 100}%`, background: 'var(--calm)' }} /></div>
      </div>

      <h2 style={{ marginTop: 14 }}>hormones</h2>
      {d.hormones.map((h, i) => (
        <div className="meter" key={h.name}>
          <div className="lab">
            <span style={{ color: `rgb(${EMOTION[i].join(',')})` }}>{h.name}</span>
            <span>{h.value.toFixed(2)}</span>
          </div>
          <div className="track">
            <div className="fill" style={{ width: `${h.value * 100}%`, background: `rgb(${EMOTION[i].join(',')})` }} />
          </div>
        </div>
      ))}

      {d.mate >= 0 && (
        <div className="kv" style={{ marginTop: 8 }}>
          <span>bonded to</span><span>slot {d.mate} · {d.bond.toFixed(2)}</span>
          <span>fertile from</span><span>age {d.fertilityAge}</span>
        </div>
      )}

      <h2 style={{ marginTop: 14 }}>action head</h2>
      <div className="verbs">
        {d.verbScores.map((v) => {
          const p = 1 / (1 + Math.exp(-v.score));
          return (
            <div className="verb" key={v.name}>
              <span>{v.name}</span>
              <div className="track"><div className="fill" style={{ width: `${p * 100}%`, background: 'var(--male)' }} /></div>
              <b>{v.score.toFixed(1)}</b>
            </div>
          );
        })}
      </div>

      <BrainHeat d={d} />

      <h2 style={{ marginTop: 14 }}>genome</h2>
      {d.genes.map((g) => (
        <div className="meter" key={g.name}>
          <div className="lab"><span>{g.name}</span><span>{g.value.toFixed(2)}</span></div>
          <div className="track"><div className="fill" style={{ width: `${g.value * 100}%`, background: 'var(--ego)' }} /></div>
        </div>
      ))}
    </>
  );
}

/** W1 drawn as N_INPUTS sensor columns x N_HIDDEN hidden rows — the whole
 *  first layer. Width is read off the constant so adding a sensor does not
 *  silently shear the picture. */
function BrainHeat({ d }: { d: AgentDetail }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const cols = N_INPUTS, rows = N_HIDDEN;
    const cell = Math.max(3, Math.min(5, Math.floor(160 / cols)));
    c.width = cols * cell; c.height = rows * cell;
    const ctx = c.getContext('2d')!;
    const w1 = d.brain.w1;
    let peak = 0.001;
    for (let i = 0; i < w1.length; i++) peak = Math.max(peak, Math.abs(w1[i]));
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const v = w1[r * cols + col] / peak; // -1..1
        const pos = v > 0;
        const a = Math.min(1, Math.abs(v));
        ctx.fillStyle = pos
          ? `rgba(220,60,60,${a})`
          : `rgba(59,157,255,${a})`;
        ctx.fillRect(col * cell, r * cell, cell, cell);
      }
    }
  }, [d]);
  return (
    <>
      <div className="brain-hint">
        brain · layer 1 weights, {N_INPUTS} sensors &times; {N_HIDDEN} hidden — red excites, blue inhibits
      </div>
      <canvas className="brain-canvas" ref={ref} style={{ width: '100%' }} />
    </>
  );
}
