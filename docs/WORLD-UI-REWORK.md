# World UI + predators: rework status

Working notes for the rework of the world view, the predator behaviour and the
speed control. Written as a handoff: what changed, what is verified, what is
half-finished, and what has to happen next.

The goal this serves, verbatim:

> the predators should have more vision and know where the female/male predator
> is there, they should be limited like there should be only 6 predators in the
> dens. the predators only comes to hunt in night times and only in mornings is
> if is hungry. the design of the world is too generic and very hard to
> understand. i need you to rework the UI
>
> Secondly, i need you to do entire rework on World UI, it is too small, the
> pixels arent actually pixels they are like sqares. the predators should have
> the shape. the world should look bigger and more detailed plans, terrains and
> other elements present. those 1x, 2x ... 16x speed isnt even working (and i
> also think it isnt making any sense).
>
> The 4 predators should also spawn nearby

---

## 1. Where things stand

| Area | State |
| --- | --- |
| Predator vision + opposite-sex awareness | done, unit-tested |
| Night-only hunting, morning exception when starving | already existed; now uses the real constant; unit-tested |
| Hard cap of 6 predators | already existed; now covered by a test |
| Four starting predators spawn near the pixels | already existed; now covered by a test |
| Speed control actually scales the tick rate | rewritten; unit-tested; **not yet verified in a browser** |
| Bigger world + render resolution | done |
| Nine biomes painted distinctly | done; test still failing on one pair |
| Scenery (trees, boulders, reeds) drawn | done, unit-tested |
| Predators drawn as animals | done, unit-tested |
| Sidebar map key + predator roster | done (TSX), CSS done |
| Browser verification + evidence capture | **not started** |
| Plan checklist / deviations | **not updated** |

Last full typecheck (`npx tsc --noEmit`): **clean**.

Last test run: **12 of 13 passing**. The one failure and the one half-applied
fix are in §4.

---

## 2. What changed, and why

### 2.1 The world got bigger and finer

`sim/constants.ts`

- `GRID_W` 512 → **640**, `GRID_H` 384 → **448**.
  Fitting the world to a normal browser window gave every cell about two
  screen pixels, and at two pixels a cell cannot carry a tree, a shoreline or a
  pair of ears. The map was a mosaic of identical squares.
- New `RS = 2` — **sub-pixels per world cell** — and `VIEW_W/VIEW_H/VIEW_SIZE`.
  The simulation still moves one cell at a time; the renderer paints a 2×2
  block for it. That block is where the shape lives.
- `FOOD_RESERVE` 90 000 → **130 000**. The reserve is a *density*; a 46 %
  larger world holding the same total would have quietly handed the founders a
  world with 31 % less underfoot than the number was tuned on.

### 2.2 The renderer was rebuilt (`sim/render.ts`)

`renderFrame` is still a pure `(sim, RGBA buffer) → buffer` function with no
DOM or worker coupling, so it is directly testable. Five passes in the order
the eye needs them:

1. **Ground** — nine distinct ground colours, each with its own 2×2 sub-pixel
   shading: a bevelled rock face, ripple banding on water, cracked plates on
   badlands, speckle on sand, drift on snow, deep shade between forest trunks.
   A stable per-cell hash gives the grain, at two scales, so fields read as
   patchy rather than as one sheet of green.
2. **Scenery** — the generator has been scattering trees, big trees, boulders
   and reeds since before anything drew them. This is the pass that turns that
   data into woodland. Ellipse masks are baked once per shape; a canopy
   overhangs the cell above, which is what gives it a round edge instead of a
   square one.
3. **Meat** — a rounded chunk lying on the ground, growing from a 2×2 to a 3×3
   block as the pile gets bigger.
4. **Pixels** — four sub-pixels with one lit corner, so a pixel reads as a
   small round body rather than a hard square.
5. **Predators** — the animal sprites (below).

A single `light` scalar, folded into every colour, carries the day/night grade.
Hue is untouched, so a night frame and a noon frame still read as the same
biomes.

Palette choices and the reasoning behind them are in the comment above
`PALETTE.ground`; the short version is that the nine biomes are spaced on a
brightness ramp first (snow / shore / rock light, forest / water / den dark)
and on hue second, because nine mid-tone greens cannot be told apart.

`TERRAIN_KEY` is exported so the sidebar's legend is built from the same
constants the renderer paints with.

### 2.3 Predators are animals now

Two hand-drawn quadruped bitmaps in sub-pixel space, small 13×8 and large
17×10, with ears, a snout, four legs, a tail and a pale belly. They are
oriented across all eight compass headings and cached (there are only 32
possibilities). A male carries a mark on its back, a female on its flank, so
the sexes differ in the painted pixel set, not just in a tint.

`predatorParts(size, sex, hx, hy)` is exported as the testable half of this: it
is pure and answers "is this a square" and "is this the same animal as that
one" without a frame buffer anywhere in sight.

Feeding state dims the animal; one that is out of its den gets a warm rim, so
"hunting tonight" is visible on the map without reading the roster.

### 2.4 Predator awareness is observable, not just claimed

`sim/predators.ts`

- `wantsToHunt` used a hardcoded `0.22`; it now reads `PRED_STARVE_ENERGY`.
- New `vision(i)` — the exact radius the hunt pass uses. The sidebar shows this
  number, and it moves as the animal gets hungrier.

`sim/sim.ts`

- `nearestOppositeSexPredator` made public.
- New `predMateDistance(i)` and `predDenDistance(i)`.

The point of the last two: "a predator knows where the female is" is
unobservable if nobody can read it off the screen.

### 2.5 The speed control was the real bug

The old loop was:

```ts
const budgetMs = 10;
const cap = Math.max(1, Math.round(speed));
while (n < cap && now() - t0 < budgetMs) { sim.step(); n++; }
// ... then setTimeout(loop, 4)
```

The rate was decided by whichever ran out first — the multiplier, or a 10 ms
CPU budget. Past roughly 4× the CPU won, so 8× and 16× were both "as fast as
this machine goes" and the buttons did nothing. Two different settings produced
the same ticks/second, which is exactly what was reported.

Now:

- `sim/pace.ts` (new) holds `ticksDue(carriedMs, elapsedMs, speed, maxCatchup)`.
  The multiplier divides the tick interval and nothing else gets a vote. The
  remainder is carried, so the long-run rate is exact rather than a floor. A
  backgrounded tab that returns owing seconds of wall clock has that debt
  capped rather than replayed.
- The worker loop uses a `MessageChannel` instead of `setTimeout`, which has a
  4 ms nested-timer clamp that would itself have capped the rate.
- The worker reports the **measured** `ticksPerSec` alongside the target, and
  the top bar shows both: `NN / NN tps`. A target you cannot see a miss against
  is just a label.

### 2.6 The view got bigger and clearer

`components/WorkerCanvas.tsx`

- Zoom levels are now **screen pixels per world cell** rather than an
  unlabelled buffer scale, so `2×` means "two screen pixels per world cell" and
  a 1:1 blit.
- The opening view is about 2.2× larger than fit, floored to a step. Fitting
  the whole world is still one click away on `fit`.
- Click mapping, panning and the age/sex annotations all account for `RS`.

### 2.7 The sidebar explains the world

`components/Sidebar.tsx` / `app/globals.css`

- A **map key** of all nine grounds at the top of the world section: swatch,
  name, and the one thing that ground *does* to a creature. This is how a
  nine-colour map becomes readable.
- A **per-predator roster** driven by the worker's frame data: size, sex, an
  energy bar, a HUNTING / IN DEN badge, kills, health, and the two readouts
  the brief asked for — current vision in cells, and distance to the nearest
  opposite-sex predator it can see (`none in range` when there is none).
- Aggregate tiles kept, with the ceiling shown explicitly as `n / 6`.
- A one-line restatement of the rule: they leave the den at night; in daylight
  only a starving one comes out.
- Fixed a real bug: `<Chart history={history} />` was rendered twice in a row.
- Floating overlays (emotion key, hint) got scrims, because the map is busy now.

The subagent that wrote the TSX timed out mid-run; its CSS did not land and was
written separately. Sex is marked with a small dot beside the name rather than
a coloured card edge — the label already says "male" or "female", and a
coloured edge on every row is decoration pretending to be data.

---

## 3. Measured

Taken on this machine, seed 20260927:

| Measurement | Value |
| --- | --- |
| World generation | 255 ms, 6 dens carved |
| Distance of the 4 starting predators from the founders | 15–26 cells (ring radius 26) |
| Sim cost | ~1 ms/tick at a small population (200 ticks in 215 ms) |
| Render cost | ~24 ms/frame at 1280×896 |
| Terrain pass alone | ~13 ms |
| Scenery pass | ~12 ms for ~21 000 props |
| Frame buffer | 4.6 MB |

The scenery pass is the largest single cost. Densities were already thinned
once (forest 0.40 → 0.24 of cells) for both cost and legibility; a solid canopy
reads as one green mass rather than as woodland. If 16× speed ever falls short
on a slower machine, the levers in order are: thin the scenery further, or drop
`RS` to 1 on low-end machines.

---

## 4. What is not finished

### 4.1 One failing test

`tests/render.test.ts` → *"all nine biomes are painted in clearly different
colours"*

```
biome 0 [63,76,40] and biome 8 [100,56,51] are only 43.5 apart
```

Plain and the den mouth. Cause: the `T_CAVE` branch in `renderFrame` blends
**every** cave cell above `n > 0.5` toward `PALETTE.caveMouth`, so the median
sampled colour of a den is firelight orange rather than dark rock.

**Half-applied fix.** `SHADE[8]` in `sim/render.ts` was just changed to
`[1, 1, 1, 1]` so the den can be shaded per-cell, but the `T_CAVE` branch that
depends on it has *not* been rewritten yet. Until it is, the shading array
entry is doing nothing and the test still fails. The branch should become:

```ts
} else if (t === T_CAVE) {
  if (n > 0.80) {
    // firelight in the mouth: the lower sub-row only, on the few cells that
    // have a mouth at all. Applied to the whole cell it repainted the den in
    // orange and the biome stopped reading as rock.
    const cm = PALETTE.caveMouth;
    br = br + (cm[0] - br) * 0.45;
    bg = bg + (cm[1] - bg) * 0.45;
    bb = bb + (cm[2] - bb) * 0.45;
    m0 = 0.80; m1 = 0.72; m2 = 1.15; m3 = 1.05;
  } else {
    m0 = 1.00; m1 = 0.90; m2 = 0.78; m3 = 0.84;   // a plain dark chamber
  }
}
```

Only ~20 % of cells take the mouth branch, so the median over 240 samples per
biome stays on the biome's own colour and the pair separates by ~60.

### 4.2 Test bugs found and fixed along the way

Two of the original three failures were the test's fault, not the code's, and
are worth recording because both would have passed a broken implementation:

- The vision test read "the first living predator" twice. Slot 0 is a *large*
  animal, so both measurements came back 204 and the assertion "large out-sees
  small" was never actually exercised. It now sets `size` explicitly.
- The night-window test walked a local counter and never assigned `world.tick`,
  so it asserted against tick 0 for all 400 iterations. It now drives the real
  clock.
- The scenery test addressed the frame buffer with **world-cell** coordinates
  while the buffer is in **sub-pixels**, so it was comparing the wrong part of
  the map. This one was reporting cells as "untouched" for the wrong reason and
  has been corrected to scale by `RS`.

### 4.3 Browser verification — not started

None of the following has been done. The speed fix in particular is verified
only at the level of `ticksDue`'s arithmetic; that the *page* honours it is
untested.

1. `pnpm build`, then start the Next server.
2. Drive it with the Chromium at
   `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`.
3. Assert **zero** page/console errors.
4. Screenshot the world view; confirm the canvas backing store equals
   `VIEW_W × VIEW_H × scale` for the active zoom — not a stale 1× size.
5. For each of 1×, 4×, 16×: wait a fixed wall-clock window, read the on-screen
   tick counter before and after, and assert the rates are non-zero and
   strictly increasing, with 16× substantially faster than 1×.
6. Click a rendered predator and assert the inspector panel populates. Note
   that the inspector currently resolves **agent slots only** — clicking a
   predator currently returns an empty panel. Either extend `inspect` to handle
   predators or drop that item from the verification; as written, it will fail.
7. Capture all of the above to the scratch directory.

### 4.4 Evidence not yet written

`world.png`, `render-test.log`, `predator-test.log`, `speed.log`,
`inspect.png` (or `launch-failure.log` if the browser cannot run here).

### 4.5 Plan housekeeping

The goal plan's `## Task checklist` is untouched — no boxes flipped — and it
has no `## Deviations` section. The deviations that need recording:

- World grown 512×384 → 640×448 and a render scale of `RS = 2` introduced, to
  make cells big enough on screen to carry shape. `FOOD_RESERVE` scaled to
  keep density constant.
- Scenery densities reduced, as a render-cost and legibility trade.
- The food reserve no longer seeds badlands. They are barren by design, and
  seeding them made a fifth of the map paint the same green as the plain, so
  two biomes rendered as one colour.
- The speed control's pacing extracted to `sim/pace.ts` so it is testable
  without a browser, and the worker now reports the measured rate.

---

## 5. Open questions

- **Should 1× be the default speed?** The UI opens at 4×. With the pacing fixed,
  1× is a true 10 ticks/second, which makes a pixel's whole life about 70
  seconds of watching. 4× may be the better opening experience, but that is a
  taste call, not a defect.
- **Predator inspection.** Clicking a predator opens an empty inspector. Worth
  doing: the roster already has everything the panel would need.
- **`RS` on slow machines.** If the render cost proves too high, a runtime
  switch to `RS = 1` for weak hardware is a reasonable escape hatch. It has not
  been built.
