# pixels

A deterministic pixel life-sim. A few hundred small creatures live on a grid,
each carrying a small neural network, and they learn: to find food, to avoid
predators, to find water, to find each other. Nothing is scripted. The six that
start the world are as lost as the six hundredth, and everything that happens
afterwards is the result of their brains getting better at being alive.

Nothing in the simulation uses `Math.random()` or `Date.now()`. The same seed
produces the same world, every time, on every machine — which is what makes the
rest of the project possible: you can change one number, re-run, and know that
any difference you see came from that number and not from the weather.

## Running it

```
pnpm install
pnpm dev          # http://localhost:3000
```

The simulation runs in a Web Worker and renders to a canvas. Click a pixel to
inspect its genes, hormones, brain weights, and current verb scores.

```
pnpm test                                   # 40 tests
pnpm harness                                # headless run
node --experimental-strip-types --test tests/render.test.ts
```

## The world

A 640x448 grid — 286,720 cells — generated from a seed. It carves four
predator dens at well-separated sites, places three founding villages at
greedy farthest-point sites, and seeds the terrain: open ground, rock, water,
dead ground, sand, forest, marsh, snow, caves.

The simulation runs at 10 ticks/second, and a day is 400 ticks. A pixel
occupies one cell. Up to 800 can exist; the population regulates itself toward
a soft cap of 200 and a hard cap of 600.

## What a pixel is

A brain, a body, and a set of drives.

The **body** has energy, thirst, health, age, sex, and a genome — genes for
curiosity, attachment, aggression, fertility lifespan, and the rest. Two
pixels mate, blend their genes, and the child inherits a blend of their brains
too, so a child starts out closer to its parents than to a random brain. A
founder that barely inherits is born nearly random however good its parents
were; that is what the attachment gene buys.

The **brain** is a two-layer MLP, 67 inputs to 64 hidden units to 19 outputs,
5,652 parameters. The 19 outputs are two policies: nine movement logits for the
3x3 heading grid, and ten verb logits — `idle`, `eat`, `seek_mate`, `mate`,
`kill`, `flee`, `rest`, `gather`, `drop`, `combine`. The movement head picks a
direction; the verb head picks what to do about it. A separate scalar head
reads the same hidden layer and predicts the value of being in this situation.

The 67 inputs are everything a creature could plausibly notice: the eight
neighbouring cells and what is on them, food and water and carcass in each
direction, the nearest predator and how far away it is, fire, the local time
of day, and what is in your hands.

## How the learning works

An actor-critic, one step at a time, every tick, for every pixel.

The **critic** predicts V, the discounted value of the current situation, and
is trained by TD(0): given reward `r` and the value of the next state, the
error is `delta = r + gamma*V' - V`, and the critic regresses toward it.

The **policy** is improved by the policy gradient theorem on that same one-step
error, which serves as an estimate of the advantage — how much better this
action turned out to be than the pixel expected. For each of the two heads,
with `p` the softmax over that head's logits and `a` the action actually taken:

```
dJ/dz_k = A * p_k * (1[k == a] - p_k)
```

Actions that led somewhere better get reinforced; actions that led somewhere
worse get suppressed. The advantage is clamped to +/-1 so that one unusually
good meal cannot dominate a lifetime of learning.

Pixels do not get smarter by being told what to do. They start on random
weights, and everything they learn, they learn from what happened to them.

## Why there is so much comment in the source

Most of it is not explanation. It is measurement — the number, the experiment,
and the failure that chose it. `sim/constants.ts` in particular reads as a log
of things that went wrong, because that is what a tuning constant is: the
number that survived having been the wrong number first.

Some examples, all of them real:

`PRED_SOFT_CAP` was `4`, which was also `START_PREDATORS`. A cap a species is
seeded at is not a cap, it is a padlock: the breeding pass returned
immediately on every tick forever, and the predators could never replace a
single animal. Over 5,000 ticks on five seeds, four kills and zero litters,
extinct by t=3500. The cap is now 8, and a world that loses its last predator
re-founds the species.

`newbornSurvival` read the *world* population, which applied a 62.5% birth tax
uniformly to a village of 25 and a village of 400 alike. A tax that is
identical in a crowded village and an empty one cannot correct a 16:1
imbalance between them. Measuring crowding against the village instead took the
worst village's share from 96% to 35%.

`REST` paid a flat +0.15 per tick, unconditionally, which banked a guaranteed
return larger than anything else available inside the value function's horizon.
Pixels learned it — `REST` climbed to 47% of all actions as the population
died. It now pays by how tired you actually are.

## The bug that took the longest to find

`tdGrad` wrote its gradient at *absolute* offsets into a per-agent scratch
buffer only `N_PARAMS` long. For the agent in slot 0 those offsets happen to
be correct. For every other agent they start past the end of the array, and a
TypedArray discards an out-of-range write without complaint.

So 599 of 600 pixels were handed a buffer of 5,587 zeros every tick, every
tick, forever, while their TD error sat unused next to it. The population was
healthy and the tests passed, because a world where nothing learns looks
exactly like a world that is working.

Nothing caught it because nothing asserted that the population was learning.
There is now a test that runs a real world, snapshots every brain, and fails
if any living pixel's weights did not move.

## Layout

```
sim/          the simulation. No React, no DOM, no I/O.
  constants.ts   every tunable, with the measurement that chose it
  sim.ts         the world: terrain, breeding, villages, the tick loop
  brain.ts       forward pass, actor-critic gradient, RMSprop
  agents.ts      the per-pixel arrays (structure-of-arrays)
  world.ts       terrain and resources
  predators.ts   the predator species
  sensors.ts     the 67 inputs
  hormones.ts    drives that bias the verb head
  genome.ts      genes and blending
  render.ts      the frame the canvas draws
  rng.ts         the deterministic random number generator
worker/       the Web Worker that owns the simulation
app/          the Next.js page
components/   canvas and sidebar
tests/        40 tests driving the real Sim and the real renderer
harness/      headless runs
docs/         design notes
scratch/      scratch diagnostics, gitignored
```

`sim/` has no dependency on anything outside itself. It can be imported and
stepped from a plain Node process, which is what the tests and the harness do —
there is no test double of the simulation anywhere in this repository.

## Design notes

The simulation is deterministic on purpose. Emergent behaviour is hard enough
to reason about when you can re-run yesterday's world and get it back exactly;
adding an unseeded random number would make every measurement a one-shot
experiment.

Predators are not scripted either. They hunt, they are hunted, they breed, and
they can die out and be re-founded from the same rules pixels follow. The
simulation does not decide that a pixel should build a fire; `COMBINE` fuses
whatever is in hand and the world decides what a lump of rock and a stick
happens to be. Discovery is a thing that can happen to these creatures, not a
thing that is written into them.
