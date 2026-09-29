// ---------------------------------------------------------------------------
// pixels — tuning constants. Everything the balance depends on lives here.
// ---------------------------------------------------------------------------

// --- world -----------------------------------------------------------------
/** The map is 40% wider and 17% taller than it was, and the reason is
 *  legibility rather than more simulation. At 512x384 a browser fitting the
 *  world to a normal window gave every cell about two pixels, and at two
 *  pixels a cell cannot carry a tree, a shoreline or a pair of ears: the map
 *  was a mosaic of identical squares. 640x448 plus the render scale below
 *  means a fitted world draws each cell at four pixels, so scenery and
 *  creatures have somewhere to put their shape. */
export const GRID_W = 640;
export const GRID_H = 448;
export const GRID_SIZE = GRID_W * GRID_H;

/** Sub-pixels per world cell in the frame buffer. The simulation still moves
 *  one cell at a time; the renderer paints `RS x RS` pixels for it, which is
 *  the resolution at which a tree has a trunk, water has a shoreline and a
 *  predator has a head. Exported so the canvas, the click mapping and the
 *  tests all agree on what "one cell" is worth on screen. */
export const RS = 2;
export const VIEW_W = GRID_W * RS;
export const VIEW_H = GRID_H * RS;
export const VIEW_SIZE = VIEW_W * VIEW_H;

// --- population ------------------------------------------------------------
/** Slot count, hard ceiling on live pixels, and the two lines in between.
 *
 *  A hundred and twenty, not six hundred. The world used to carry a cap of
 *  600 that nothing had ever reached — the population died out around
 *  nineteen every time, so the cap was a number in a file rather than a
 *  controller. Once the population actually grew, the number turned out to
 *  be a commitment in two directions at once.
 *
 *  It is a legibility budget. Everything this simulation is for — six named
 *  founders, lineage surnames, bonds, betrayals, six identifiable predators,
 *  a generation counter you can watch climb — is about being able to point at
 *  one animal and follow it. Six hundred pixels on a 640x448 map is a smear
 *  of identical dots, and the same argument the predator cap of six already
 *  makes in its own comment applies to everything else.
 *
 *  It is also a compute budget, and the binding one. Every living pixel runs
 *  a 45-48-16 network forward and a TD(0) update every tick: measured at 18
 *  ms per tick with the population in the hundreds, 16 ms of it brain. A
 *  tick is 100 ms of wall clock at 1x and 6.25 ms at 16x, so a population in
 *  the hundreds means the world runs slower the moment it becomes
 *  interesting. 120 keeps a whole tick inside a few milliseconds, which is
 *  what leaves the speed control honest. MAX_AGENTS is 300 rather than 120
 *  so the free-slot list is never the thing that stops a birth, and so the
 *  scans that walk every slot are not walking four fifths of nothing. */
export const MAX_AGENTS = 800;
/** Newborns below this always survive. Between SOFT_CAP and HARD_CAP the
 *  survival chance falls linearly to zero. At HARD_CAP it is always fatal. */
export const SOFT_CAP = 200;
export const HARD_CAP = 600;

/** How many founding villages the six founders are laid out as: three pairs,
 *  each pair given its own piece of the map.
 *
 *  Fully scattering the six across 640x448 is the failure the CAMP_SPREAD
 *  comment below documents — a lineage that cannot find a mate is not a
 *  lineage. Three villages keeps each pair within mating range of its own
 *  camp while putting the pairs far enough apart to be three places on the
 *  map rather than one smear. */
export const VILLAGES = 3;

/** How many pixels one village holds before its own newborns start to be
 *  culled, and how many before none of them survive.
 *
 *  The world caps above measure the whole map. These measure one of three
 *  villages on it, and the split is the point: the old crowding test read the
 *  world's population and applied it to every newborn everywhere, so a village
 *  of 25 and a village of 400 paid the identical tax and the imbalance between
 *  them was never correctable. See `newbornSurvivalLocal` in sim/sim.ts for the
 *  measurement — 88% of the population in one of three founding villages, the
 *  one with the least food of the three.
 *
 *  100 and 300 is `SOFT_CAP/VILLAGES` and `HARD_CAP/VILLAGES`: a village is
 *  comfortable holding a third of the world's soft cap and is at its ceiling
 *  holding a third of the hard one. Three villages at 300 each is 900, which is
 *  above the world's own HARD_CAP — deliberately, because the world cap is
 *  still enforced separately and it is the one that has to hold when a village
 *  swallows the map. This pair governs the *relative* balance; the pair above
 *  governs the absolute one. */
export const VILLAGE_SOFT_CAP = Math.floor(SOFT_CAP / VILLAGES);
export const VILLAGE_HARD_CAP = Math.floor(HARD_CAP / VILLAGES);
/** Minimum walking distance between two village sites, in cells. 120 is about
 *  a fifth of the map's width: far enough that two villages never merge into
 *  one camp field, close enough that a predator's den can still serve more
 *  than one. */
export const VILLAGE_GAP = 120;
/** Distance between the two camps inside one village. Above CAMP_HOME_R=4 so
 *  the camps are visibly distinct, below the SEEK_R=60 partner search so the
 *  pair can actually find each other. */
export const CAMP_SEP = 9;
/** The founding population. Small on purpose: the point is to watch one
 *  lineage grow out of a handful instead of watching a full world churn. */
export const START_POP = 6;
/** How far apart the founders may be born, in cells. They are born together,
 *  not scattered — but never stacked on one tile, because two pixels sharing
 *  a tile are at distance 0 and every sensor discards them as "not there". */
export const FOUNDER_SPREAD = 2;
/** How far from the founding spot each lineage's camp is sited, in cells.
 *
 *  A pixel has a camp the way a predator has a den: one place it belongs to,
 *  which it is pulled back toward whenever it needs a mate, a friend or a
 *  safe place to be a juvenile. It is inherited down the lineage the same way
 *  the founder id is, so a camp outlives everyone who started it.
 *
 *  The camps are close together on purpose. Six founders scattered over a
 *  640x448 map is six lineages that never meet, and a lineage that cannot
 *  find a mate is not a lineage — six pixels with nobody within partner range
 *  starve out and the world ends in the first generation. One founding
 *  village, six family camps inside it: close enough that the founders can
 *  pair up, far enough apart that the villages are visibly distinct. */
export const CAMP_SPREAD = 7;
/** Within this many cells of its camp a pixel counts as home, and stops being
 *  pulled. */
export const CAMP_HOME_R = 4;

/** Slot ceiling on the camp table, so `campPop` can be a fixed array.
 *
 *  Two camps per village, and enough villages that a repaired one has
 *  somewhere to go without the table being the thing that stops it. Four
 *  villages' worth of camps: the three the world starts with plus one spare,
 *  so a village that dies is replaced *at* its old site rather than by
 *  pushing the whole map's camp list up by two.
 *
 *  It was 64, which is not a bound so much as a suggestion — with the
 *  re-founding firing freely the table filled all 64 slots with half-villages
 *  inside 2500 ticks, which is 32 "villages" on a map with three, most of
 *  them empty. The renderer draws every camp, so a full table is a map
 *  covered in rings and a sidebar full of zeroes. */
export const MAX_CAMP_SLOTS = 8;

/** How often the village census runs, in ticks.
 *
 *  Not every tick: the census walks all MAX_AGENTS slots to count, which at
 *  60 ticks out of 3600 ticks is free, and at every tick would be a third of
 *  a pass the population does not otherwise need. 60 is about the age at which
 *  a newborn is no longer at risk of the survival roll, so a census never sees
 *  a village as empty because of a bad minute. */
export const VILLAGE_CHECK_EVERY = 60;

/** A village holding fewer than this many pixels is re-founded.
 *
 *  This has to be low in absolute terms — one pixel is a village that is
 *  already over, since `findPartner` needs an eligible partner of the other
 *  sex — but the test that actually runs is `VILLAGE_REFOUND_FRACTION` of the
 *  world below, and this number is only the hard floor under it.
 *
 *  Two, and that is deliberate as a floor: the failure mode of a floor of 1 is
 *  a village of one flickering in and out of existence every census, and the
 *  failure mode of a floor high enough to be "the village is really dead" is
 *  that a village which has lost one of its two founding lineages is never
 *  repaired. The fraction test is what does the real work. */
export const VILLAGE_REFOUND_FLOOR = 2;

/** A village is re-founded only if it holds less than this fraction of the
 *  living population.
 *
 *  This is the number that stops the re-founding from running away, and it
 *  exists because the absolute floor alone is not enough. With a floor of 2
 *  and no fraction test, a village that dips to 1 during ordinary population
 *  churn gets re-founded, the new village starts on 3, dips to 1 during its
 *  own churn, gets re-founded again, and the whole table fills with
 *  half-villages: measured on seed 20260927, 28 re-foundings and all 62 camp
 *  slots consumed by t=2500, with 376 of 480 pixels still stacked in the one
 *  original village the mechanism was supposed to be balancing. A repair that
 *  fires on every dip is not a repair, it is a second population crisis.
 *
 *  One twentieth, so a village is repaired when it holds less than 5% of the
 *  world. At the SOFT_CAP=200 and HARD_CAP=600 the population actually runs
 *  at, that is a village of 10 to 30 — comfortably below a healthy village's
 *  worth, and comfortably above the noise of a village losing a founder. */
export const VILLAGE_REFOUND_FRACTION = 0.05;

/** How many pixels a re-founded village starts with, and how long the world
 *  waits between attempts. Three, so the new village is immediately
 *  breedable and holds a bonded pair. */
export const VILLAGE_REFOUND_COUNT = 3;
export const VILLAGE_REFOUND_COOLDOWN = 200;

/** How far a pixel will walk from its own camp to found a new one.
 *
 *  This is the migration that breaks the demographic seal, and it has to be a
 *  real number rather than "anywhere", because the alternative — leaving a
 *  pixel's camp permanently unchangeable — is what produced the collapse this
 *  constant exists to stop. Measured on seed 20260927, village population went
 *  [15, 16, 29] -> [0, 52, 398] over 5000 ticks: 88% of the world inside one
 *  of three founding villages, and the winning village had the *least* food of
 *  the three, so nothing about the ground was choosing it. Three populations
 *  that cannot exchange a single animal are three populations whose fates are
 *  decided by whichever one happened to have a better run of births, and the
 *  other two then have no way back.
 *
 *  150 is over `VILLAGE_GAP`, so a pixel that decides to move can actually
 *  reach a different village rather than hopping to the neighbouring camp. */
export const VILLAGE_MIGRATE_R = 150;

/** How much better a destination village has to be, as a multiple, before a
 *  pixel crosses the map for it.
 *
 *  Two, so a pixel moves from a village of three into one of seven and not
 *  from a village of ninety into one of a hundred and eighty. The point of
 *  the number is to make the flow one-directional — animals leaving weak
 *  villages for strong ones — without letting a big village strip a small one
 *  that happens to be a little smaller. */
export const VILLAGE_MIGRATE_WANT_POP = 2;
/** Radius, in sub-pixels, of the worn ring the renderer draws at each camp.
 *  A little over CAMP_SPREAD cells so the six family camps read as six places
 *  inside one village rather than as one stain. */
export const CAMP_MARK_R = 18;

// --- clock -----------------------------------------------------------------
export const TICK_HZ = 10;
export const TICK_MS = 1000 / TICK_HZ;

/** Ticks in one full day/night. At 1x this is a minute of real time; a pixel
 *  lives about one and a half days, so a generation is short enough to watch
 *  a whole lifetime go by and a season is eight of them. */
export const DAY_TICKS = 400;
/** Where each phase starts, as a fraction of the day. The four windows are
 *  contiguous and cover 0..1 exactly. */
export const PHASE_DAWN = 0.00;
export const PHASE_DAY = 0.12;
export const PHASE_DUSK = 0.50;
export const PHASE_NIGHT = 0.62;
export const PHASE_NAMES = ['dawn', 'day', 'dusk', 'night'] as const;
/** Sun strength over the day: 0 is pitch dark, 1 is full noon. Used both for
 *  the world's colour grade and for the light a predator hunts by. */
export const DAYLIGHT = [0.30, 1.0, 0.35, 0.06] as const;

// --- brain: 67 -> 64 -> 19 -------------------------------------------------
// 45 sensors, unchanged: 15 body/state channels, 6 sets of 4 compass rays
// (food, agent, plant, carcass, water, meat), nearest-other, standing-in-water,
// and 4 predator rays. Then 22 more, appended so no existing index moves and
// no existing brain weight is misread: 3 item ray blocks, 4 carry channels,
// 4 fire rays, and 2 fire state channels. The full table lives in sim/sensors.ts.
export const N_INPUTS = 67;
export const N_HIDDEN = 64;
export const N_OUTPUTS = 19;
export const N_MOVE = 9; // 3x3 movement grid
/** Offsets of the 3x3 movement grid, row-major, 0 = up-left. These indices are
 *  the same numbers as the brain's first N_MOVE output units, so the world can
 *  hand a heading straight to the policy. */
export const MOVE_DX = [-1, 0, 1, -1, 0, 1, -1, 0, 1] as const;
export const MOVE_DY = [-1, -1, -1, 0, 0, 0, 1, 1, 1] as const;
export const N_VERB = 10; // discrete verbs
export const W1_SIZE = N_INPUTS * N_HIDDEN; // 4288
export const B1_SIZE = N_HIDDEN; // 64
export const W2_SIZE = N_HIDDEN * N_OUTPUTS; // 1216
export const B2_SIZE = N_OUTPUTS; // 19
export const N_PARAMS = W1_SIZE + B1_SIZE + W2_SIZE + B2_SIZE; // 5587
export const OFF_W1 = 0;
export const OFF_B1 = OFF_W1 + W1_SIZE;
export const OFF_W2 = OFF_B1 + B1_SIZE;
export const OFF_B2 = OFF_W2 + W2_SIZE;

// --- verbs (plain const object: `enum` is not erasable syntax) -------------
/** GATHER, DROP and COMBINE are deliberately general.
 *
 *  There is no verb that makes fire. COMBINE fuses whatever is in hand into
 *  one lump and sets it down, and the world decides what a lump of rock and
 *  stick happens to be — see `Sim.maybeIgnite`. Nothing here tells a pixel
 *  that two particular things in its hands are worth something, which is the
 *  point: whether that pairing is worth anything is not a thing this file
 *  gets to know.
 *
 *  The three new verbs act where the pixel LANDS rather than replacing its
 *  move. An overriding verb is what `rest` is, and a body of overriding
 *  verbs is how a brain ends up not walking (measured at sim.ts:499: one
 *  pixel in twenty-three walked where it had chosen to). So the movement
 *  head runs first, then the verb executes against the cell arrived at. */
export const Verb = {
  IDLE: 0,
  EAT: 1,
  SEEK_MATE: 2,
  MATE: 3,
  KILL: 4,
  FLEE: 5,
  REST: 6,
  GATHER: 7,  // take the nearest loose item at your reach into your hands
  DROP: 8,    // put one carried item on your own cell
  COMBINE: 9, // fuse everything you carry into one lump and set it down
} as const;
export const VERB_NAMES = [
  'idle', 'eat', 'seek_mate', 'mate', 'kill', 'flee', 'rest',
  'gather', 'drop', 'combine',
] as const;

/** Offset of each verb's output head. Movement occupies 0..8, verbs 9..15. */
export const VERB_OUT_BASE = N_MOVE;

// --- hormones --------------------------------------------------------------
/** Nine emotion channels, in the fixed order used by the renderer. */
export const H = {
  CALM: 0,
  HUNGER: 1,
  ANGER: 2,
  FEAR: 3,
  LOVE: 4,
  EGO: 5,
  DESIRE: 6,
  LONELY: 7,
  THIRST: 8,
  DOPAMINE: 9,
} as const;
export const N_HORMONES = 10;

// --- items (plain const object: `enum` is not erasable syntax) -------------
/** The three things a pixel can hold. There is no ITEM_NONE: "carrying
 *  nothing" is a carry total of zero, not a fourth kind of thing, and a
 *  sentinel kind would put an off-by-one between the array index and the
 *  name the sidebar prints. */
export const Item = {
  ROCK: 0,   // deliberately general: fuel, tool, ammunition, stockpile
  STICK: 1,  // fuel
  MEAT: 2,   // food, in units
} as const;
export const N_ITEMS = 3;
export const ITEM_NAMES = ['rock', 'stick', 'meat'] as const;

/** Most items one pixel can hold at once.
 *
 *  Four, and the reason is a dead end at two. A pixel that gathers two rocks
 *  with a capacity of two has filled its hands with a pair it cannot use, and
 *  there is no verb that frees it except DROP. Capacity 1 is worse still: a
 *  pixel could never hold a rock AND a stick, which is the combination the
 *  world has an opinion about. Four leaves a genuinely mixed load, which is
 *  what COMBINE needs to have something to fuse. */
export const CARRY_CAP = 4;
/** How far, in cells, a pixel can reach to pick something up. 1, so you have
 *  to be standing on the thing or beside it. */
export const TAKE_R = 1;
/** Ticks before this pixel will try to gather again. Three, so a brain that
 *  has learned to walk onto a rock and grab it does not spend every tick
 *  re-deciding the same thing. */
export const ITEM_PICKUP_COOLDOWN = 3;
/** How many units of one item a single gather takes. A rock is one thing and
 *  a stick is one thing; meat is portioned because a whole carcass would
 *  fill a pair of hands on its own. */
export const MEAT_PER_CARRY = 0.35;
/** Ticks before this pixel will try to combine again. */
export const COMBINE_COOLDOWN = 12;
/** Paid for gathering something, scaled by how much. This is the reward that
 *  has to exist before a brain picks a rock up at all; without it the hands
 *  stay empty forever and nothing downstream is reachable. */
export const GATHER_REWARD = 0.25;
/** Paid for combining. Flat, and deliberately NOT a bonus for any particular
 *  pairing — see `Sim.maybeIgnite`, which is where the world's opinion about
 *  rock and stick lives, and which no brain is told about. */
export const COMBINE_REWARD = 0.5;

// --- fire ------------------------------------------------------------------
/** Ticks a burning cell lasts. 30, measured four ways (scratch/diag31): a
 *  cell lit and left burns for exactly this long and then goes out, whether
 *  it had fuel under it or not.
 *
 *  It is short because the alternative is not a longer fire, it is a longer
 *  problem: at 220 ticks a blaze started at dusk is still alive at dawn, and
 *  anything that can be relit without resetting is a fire that never ends. */
export const FIRE_BURN_TICKS = 30;
/** Chance per tick that a burning cell passes fire to the cell downwind, and
 *  the cell across it. Downwind and across, never upwind and never along the
 *  axis that is not wind. Fuel gating alone does not bound a fire — a cell
 *  with no fuel under it still passes it on — so the bound is the shape of
 *  the neighbourhood, and it was measured rather than guessed. */
export const FIRE_SPREAD_ALONG = 0.06;
export const FIRE_SPREAD_ACROSS = 0.05;
/** Health a predator standing in fire loses per tick.
 *
 *  Fire is 2.5x death by starvation (which costs a starving predator 0.02) and
 *  8x death by age (0.006), and the same number applies to both predator
 *  sizes so a large animal is not quietly favoured. It is a serious threat
 *  and not an instant one: at two cells a tick a predator crosses a blaze in
 *  three ticks and pays 0.15, which is survivable. A wall of fire is a
 *  decision, not a wall. */
export const FIRE_PRED_DAMAGE = 0.10;
/** Health a pixel standing in fire loses per tick. Ten times gentler than for
 *  a predator, because there are six hundred of them and a fire that killed
 *  at the predator's rate would empty the map. */
export const FIRE_PIXEL_DAMAGE = 0.01;
/** Plant burned off per tick under a burning cell. */
export const FIRE_SCORCH_RATE = 0.05;
/** Ticks the wind holds one direction before turning. */
export const FIRE_WIND_TURNS_EVERY = 120;
/** How sharply the world's opinion turns on a fused lump.
 *
 *  A softstep on (rockish, woody) against a threshold of (1,1): a lump needs
 *  both kinds before it can take, and this is the width of the ramp between
 *  "cannot possibly" and "certainly will". 1.5 puts a bare 1-and-1 at about
 *  0.5, so a pixel that fuses one rock and one stick gets a coin flip rather
 *  than a rule — which is the point. A hard threshold would make the fire a
 *  switch the world flips for you, and a switch has nothing for a learner to
 *  climb. Read only by `Sim.maybeIgnite`, which is the only place that is
 *  allowed to hold an opinion about what a particular pairing of materials
 *  does; no brain is told it exists. */
export const IGNITE_SOFTNESS = 1.5;
/** Ticks between item scatter passes. A harvested cell comes back over time
 *  rather than never: a village that strips a woodline and then starves for
 *  sticks forever is not scarcity, it is a world where the second woodline
 *  does not exist. 200 is a day and a half — long enough that a village can
 *  genuinely strip a woodline and notice it is empty, short enough that it
 *  recovers while the same animals are still alive to use it. */
export const ITEM_SCATTER_EVERY = 200;

// --- terrain ---------------------------------------------------------------
// A biome, not a colour. The first four are the original tiles; the rest
// exist so a pixel on the map can say *where* it is rather than just what
// colour it is standing on. The renderer draws a different silhouette for
// every one of these, and the map key in the sidebar names them.
export const T_OPEN = 0;    // plain grass, walkable, lightly fertile
export const T_ROCK = 1;    // mountain, impassable
export const T_WATER = 2;   // river/lake, passable, drains energy
export const T_DEAD = 3;    // badlands: walkable, barren, nothing grows
export const T_SAND = 4;    // shore, walkable, no food
export const T_FOREST = 5;  // dense wood, walkable, the richest ground
export const T_MARSH = 6;   // wetland, walkable, drains energy slowly
export const T_SNOW = 7;    // high frozen ground, walkable, nearly barren
export const T_CAVE = 8;    // a den mouth: passable, where predators live
export const TERRAIN_NAMES = [
  'plain', 'mountain', 'water', 'badlands', 'shore', 'forest', 'marsh',
  'snowfield', 'den',
] as const;
export const TERRAIN_PASSABLE = [
  true, false, true, true, true, true, true, true, true,
] as const;

// --- meat ------------------------------------------------------------------
/** A pixel killed by a predator leaves meat where it fell. Meat is worth
 *  strictly more than grass: it fills you completely and it is the only
 *  thing that gives dopamine. Grass is a calorie, meat is a reward. */
export const MEAT_PER_KILL = 0.9;
export const MEAT_ROT_RATE = 0.0022;
export const MEAT_NUTRITION = 1.0;
export const MEAT_DOPAMINE = 1.0;
export const DOPAMINE_DECAY = 0.04;

// --- predators -------------------------------------------------------------
/** Slot ceiling. Only ever as many as can be seen at once; the cap below is
 *  what actually bounds the population. */
export const MAX_PREDATORS = 40;
/**
 * How many predators may be alive in the world at once.
 *
 * Six. The point of a predator is that it is something you can point at and
 * say *that one*, and that the den it comes out of is a place on the map. At
 * two dozen the population is a smear and no den means anything; at six the
 * map has six actors and every kill has a name.
 */
export const PRED_DEN_CAP = 4;
/** How many are alive when a world starts, and how close to the founders they
 *  are born. The old world opened with two predators exiled in whatever cave
 *  the generator happened to pick, which is another district — you could run
 *  a whole generation without seeing one. Now all four start on top of the
 *  founding pixels, so the predator is a fact of the opening screen and not a
 *  rumour. */
export const START_PREDATORS = 4;
/** How far from its den mouth a starting predator may be placed, searching
 *  outwards. A den is carved into a mountainside, so the tile at the centre
 *  is sometimes a pocket with no way out; this is how far the spawn walks
 *  before it gives up and takes the next den instead. */
export const PRED_DEN_SCATTER = 10;
export const PRED_SMALL = 0;
export const PRED_LARGE = 1;
/** Sexes. A male walks to the nearest female it can see and only breeds in
 *  its den, so "where is she" is a real question a predator answers. */
export const PRED_MALE = 0;
export const PRED_FEMALE = 1;
/** Pixels that must gang up on a predator of each size. One pixel alone is
 *  noise: damage scales with the square of the mob, so four is nearly nothing
 *  against a large one and five is a kill. */
export const MOBS_TO_KILL_SMALL = 3;
export const MOBS_TO_KILL_LARGE = 5;
export const MOBS_RADIUS = 2;
export const MOB_DAMAGE = 0.09;
/** What a pixel is paid for standing its ground against a predator. Without
 *  a reward the brain never learns that a crowd is a weapon. */
export const MOB_REWARD = 0.6;
/** Predators live far longer than pixels — a pixel tops out around 700 ticks,
 *  a large predator is still hunting at 2000. */
/** Cells a predator covers per tick when it has a target in sight.
 *
 *  Two. A predator and a pixel both move one cell a tick, which is not a chase
 *  but a footrace neither can win: the predator closes at exactly the rate the
 *  prey is leaving. It would see the village — its vision reaches 160 cells,
 *  and a village of a hundred pixels sits well inside that — walk at it for
 *  eight thousand ticks and arrive never, because a kill has to land within
 *  one cell. Measured on one seed: four predators spent 5,216 hunting ticks
 *  and killed nothing at all, with the nearest pixel 23 cells away throughout.
 *  Two cells a tick closes at one cell a tick, which is enough to arrive. */
export const PRED_CHASE_STEPS = 2;
/** How many candidate prey a predator will test for line of sight before it
 *  gives up and sweeps on. Eight is plenty: the point is to find something it
 *  can walk at, not to be certain there is nothing behind the next ridge. */
export const PRED_SIGHT_TRIES = 8;
export const PRED_LIFESPAN_SMALL = 1500;
export const PRED_LIFESPAN_LARGE = 2800;
export const PRED_ENERGY_CAP = 1;
/** A predator burns energy slowly enough that a good hunt actually pays for
 *  itself, and slowly enough that it can sit out a whole day without dying. */
export const PRED_HUNGER_RATE = 0.0004;
export const PRED_EAT_GAIN = 0.5;
/** How far a predator can notice a pixel. Larger ones see further, and both
 *  start far enough out that a den actually has a hunting ground in front of
 *  it rather than one screen of grass. */
export const PRED_HUNT_R_SMALL = 70;
export const PRED_HUNT_R_LARGE = 90;
/** How much further a starving predator will search than a fed one.
 *
 *  This was 190, on top of a 70-cell base, which gave a starving animal a
 *  260-cell sight radius on a 640x448 map. That is most of the world: a
 *  predator left its den, found nothing, and kept going, and by the time it
 *  came home it was ninety cells away with a partner ninety cells the other
 *  way. Four animals sharing a den never assembled in the same place at the
 *  same time, so the species aged out one at a time. The radius now grows
 *  enough to mean "this one is desperate" and stops well short of "this one
 *  is homeless". */
export const PRED_SEARCH_GROWTH = 70;
/** How far from its own den a predator will range before turning back.
 *
 *  A den with no territory is not a den, it is a spawn point. Past this
 *  distance — and only while it has no prey in sight — the animal gives up
 *  the sweep and goes home, so there is a stretch of map each den actually
 *  holds and the six of them mean six places. */
export const PRED_HUNT_LEASH = 130;
export const PRED_SEARCH_EVERY = 6;

// --- the nose ---------------------------------------------------------------
/** How much further a predator can SMELL than it can see. 1.3, not 3.
 *
 *  Measured over 2,676 predator-hunting samples across five seeds, asking of
 *  every hunting tick whether any living pixel was inside the radius at all,
 *  and then again with the line-of-sight check applied:
 *
 *      radius   smell (no LOS)   vision (LOS)   gain
 *      x1.0         97.8%           89.0%       +8.8pp
 *      x1.3         99.9%           91.2%       +8.6pp
 *      x1.6         99.9%           91.3%       +8.5pp
 *      x2.0        100.0%           91.7%       +8.3pp
 *
 *  The whole of the power is the missing line-of-sight check, and the radius
 *  is nearly irrelevant past about 1.3x. A further breakdown of the same
 *  samples: 90.4% of hunting ticks have a pixel in range that the predator
 *  can actually see, 7.7% have one in range that only ROCK is hiding, and
 *  1.9% have nothing in range at all. So 9.6% of every hunt the world runs
 *  ends in `target = -1` and a blind sweep along a remembered heading, and
 *  smell is worth exactly that 9.6% and no more. */
export const PRED_SMELL_MULT = 1.3;
/** How much further a STARVING predator can smell than a fed one, in cells.
 *
 *  A flat addition rather than a multiple of the smell radius, so hunger
 *  widens the circle on a starved animal in absolute terms the way it does
 *  for vision, and so the two numbers stay independently readable on the
 *  sidebar. 120 puts a starving nose at 237 cells across a 640x448 map:
 *  enough to know the village is over there, not enough to walk to it on the
 *  strength of scent alone. */
export const PRED_SMELL_GROWTH = 120;
/** How often, in ticks, a predator re-reads its nose. One: every tick.
 *
 *  Affordable because the nose is cheap, and the benchmark is why it can be
 *  said this way. Forty predators sweeping `spatial.forEachNear` around a real
 *  population, 300 sweeps:
 *
 *      r= 90  0.071 ms/tick      r=200  0.087 ms/tick
 *      r=140  0.097 ms/tick      r=320  0.125 ms/tick
 *
 *  Flat in the radius, because the cost is the bucket sweep and there are
 *  only a few hundred agents to sweep. Cheap-and-constant is the whole reason
 *  the two senses are separate animals rather than one radius. */
export const PRED_SMELL_EVERY = 1;
/** How many cells of clear ground a stalker stands off from its prey before
 *  closing the last gap.
 *
 *  A predator that walks straight at a pixel from two cells away is a
 *  predator that eats and one that starves, because the pixel's FLEE trigger
 *  is 6 cells and its sprint is 1 cell a tick to a predator's 2. Stopping
 *  eight cells out is outside the flee radius: at that distance the prey has
 *  not noticed anything, so the approach is not a footrace, it is a walk.
 *  Eight is `FLEE_TRIGGER_RADIUS + 2` — the two numbers have to know about
 *  each other, and this comment is how they do. */
export const PRED_STALK_R = 8;
/** How long a predator keeps a scent it can no longer see, in ticks.
 *
 *  The memory is what makes a stalk survivable: closing the last eight cells
 *  takes four ticks at two cells a tick, and if the prey breaks around a rock
 *  in that window the predator needs somewhere to walk that is not the
 *  direction the prey was last seen going. */
export const PRED_MEMORY_TICKS = 40;
/** A cornered predator runs for its den even mid-hunt, at this health.
 *
 *  Fire is the predator's weakness and the point of it is that the animal
 *  treats fire as a reason to leave rather than a wall to walk into. Above
 *  this line the fight is worth taking, because PRED_EAT_GAIN=0.5 against
 *  PRED_HUNGER_RATE=0.0004 is a thousand ticks of life. */
export const PRED_PANIC_HEALTH = 0.3;
/** How hot a cell must be before a predator refuses to step onto it, and how
 *  close counts as a detour. Compared against the countdown, so 1 is a trace
 *  and 0 is a full flame. Both branches exist because smoke should bend a
 *  route and a real flame should end the question: a detour is a choice, a
 *  refusal is a fact about the world. */
export const PRED_FIRE_AVOID = 0.15;
/** How far a predator can see another predator of the opposite sex. Sex is
 *  only worth tracking if the search is real, and with six predators in the
 *  world a wide radius is not a cost. */
export const PRED_MATE_R = 110;
export const PRED_MATE_BOND_R = 4;
/** How much a den already being lived in counts against it when a lone
 *  predator is choosing somewhere to move: 70 cells per animal already in
 *  there, or about how far it would rather not walk. The effect is that
 *  recruits go to the nearest chamber with room, so the species spreads over
 *  two or three dens rather than all six animals emptying into one rock. */
export const PRED_DEN_CROWDING = 30;
/** What sharing a den with one of the other sex is worth when a predator is
 *  choosing between homes. Larger than any distance on the map on purpose:
 *  company decides whether a den is a home at all, and distance only chooses
 *  between the ones that have it. */
export const PRED_DEN_MATE_BONUS = 900;
/** How much better another den has to be before an animal walks to it. Two
 *  homes a few cells apart in quality are not worth a day's travel, and
 *  without a margin a pair sharing a den also shares a score and trades
 *  places every time either of them comes back from a hunt. */
export const PRED_DEN_STAY_MARGIN = 60;
/**
 * Predators hunt at night, and in daylight only if they are truly starving.
 *
 * Above `PRED_DEN_ENERGY` a predator is comfortable: it walks to its den and
 * waits. Below it, the animal is hungry enough to hunt — but only once the
 * light goes. Between `PRED_STARVE_ENERGY` and daylight, hunger stops being a
 * preference and becomes an emergency and it comes out anyway, because a rule
 * that says "never hunt in daylight" is a rule that ends in six starving
 * corpses. Night is the normal case; the morning exception is the exception.
 */
export const PRED_DEN_ENERGY = 0.65;
export const PRED_STARVE_ENERGY = 0.22;
/** How far a den may sit from the prey and still keep the night rhythm.
 *
 *  A night is 176 of the day's 400 ticks and a predator covers one cell a
 *  tick, so anything past about 88 cells out is already a round trip that does
 *  not fit in the dark. In practice it is much further than that: the six
 *  dens are spread over a three-by-two lattice and the walked distance from
 *  den to village measures 10 to 543 cells, so on nine of ten seeds most of
 *  the opening predators live at a den from which no night contains a hunt.
 *  They set off at dusk, are still on the road at dawn, and go home empty
 *  every night — which is not a rhythm, it is a schedule of walks. An animal
 *  whose den is further from the prey than this hunts in daylight when it is
 *  hungry, and the ones close enough keep waiting for dark, so a world still
 *  has its night-hunting predators on the seeds whose dens are near the
 *  village. */
export const PRED_NIGHT_REACH = 88;
/** A predator only kills when it is actually hungry. Without this a fed
 *  predator still eats every pixel it walks into, and the world gets eaten
 *  far faster than six predators could ever need to eat. */
export const PRED_ATTACK_ENERGY = 0.85;
/** Predators breed, but nowhere near as often as pixels do, and only at dawn
 *  and only in a den, so a litter is something you can watch happen. */
export const PRED_BREED_COOLDOWN = 380;
/**
 * Predators only breed into a world that can feed the new one.
 *
 * Six is a ceiling, not a quota. A world holding thirty pixels does not have
 * room for a sixth predator, and a cap that behaves like a quota is just a
 * slower extinction: the population breeds up to the ceiling in the first few
 * hundred ticks, eats everything that spawned it, and the whole world is
 * over before the first generation is old enough to fight back.
 *
 * Thirty, not seventy. It used to be seventy, which is most of a soft-capped
 * population, and that made the two species' fates the same number: any dip in
 * the pixel count closed the predators' breeding window, the predators then
 * aged out one at a time over the next fifteen hundred ticks with nothing to
 * replace them, and a world that had recovered its population in the
 * meantime was still walking around with no predators in it — and a world
 * that had not recovered lost both. Thirty is the point at which a litter is
 * a real gamble and a world of six is a real meal, and it lets the species
 * hold itself together through the bad years instead of only through the
 * good ones.
 */
export const PRED_BREED_MIN_PREY = 30;
/**
 * How fed a pair has to be to breed, and how close to the den mouth.
 *
 * The energy figure has to sit *below* PRED_DEN_ENERGY, because that is the
 * line above which an animal stops hunting and starts walking home, and a
 * den is where a litter is born. At 0.7 it sat above 0.65, so the window in
 * which a predator was well enough fed to breed was exactly the window in
 * which it was out on the map instead: a range with no animals in it, and a
 * species that aged out one by one without ever replacing itself.
 *
 * It is 0.45, and the number below it is what mattered. At 0.55 a pair had to
 * be *well* fed — well enough that neither of them wanted to hunt — and the
 * only way to be well fed is to have killed recently, which on a world where
 * a predator eats roughly once every twelve hundred ticks meant a litter
 * once every few thousand ticks, against a lifespan of fifteen hundred. The
 * species was always dying faster than it bred, on every seed, and the
 * arithmetic never worked at any population size.
 */
export const PRED_BREED_ENERGY = 0.45;
/** How close to the den mouth a pair has to be standing to breed. Both
 *  animals walk home and stop one cell short of the centre, so they end up
 *  within two of each other at worst — a tight mouth and a three-cell radius
 *  made the litter a coin toss on the last step. */
export const PRED_DEN_BREED_R = 4;
export const PRED_BREED_CHANCE = 0.45;
/** Cap on how many may exist, so a bad world cannot be swallowed whole.
 *
 *  This used to be `PRED_DEN_CAP`, which is 4, which is also `START_PREDATORS`
 *  — and a cap that a species is *seeded at* is not a cap, it is a padlock.
 *  `breedPredators` opens with `if (p.count >= PRED_SOFT_CAP) return;` and the
 *  only thing that lowers `p.count` is death, so the breeding pass returned
 *  immediately on every tick of every run and the species could never replace
 *  a single animal. Measured over 5000 ticks on five seeds: four predators at
 *  t=0, still four at t=2500, and then four deaths all of them by age
 *  (`starved=0, mobbed=0, burned=0`) and none ever — 4 kills in five thousand
 *  ticks, zero litters, `predators 0 alive` by t=3500. Nothing about a
 *  predator's behaviour, den, nose or hunger was involved. A 1500-tick
 *  lifespan against a breeding function that is structurally incapable of
 *  running is a countdown that starts on the first tick.
 *
 *  Eight, so a world opens with half the ceiling and has room to breed on
 *  tick one. The ceiling still does its job — it is twice the four dens, so
 *  a den holds two animals on average and the map stays legible — and the
 *  number that is supposed to bound this species is now above the number that
 *  starts it, which is the entire invariant that was broken. */
export const PRED_SOFT_CAP = 8;
/** Below this many predators, the world tries to re-found the species.
 *
 *  The user asked for exactly this and the arithmetic agrees it is needed: the
 *  species has a 1500-tick lifespan and no source of new animals other than
 *  breeding, so even with the cap fixed the population random-walks and a bad
 *  decade ends it. One, and it fires the moment the last animal goes — see
 *  `Sim.reseedPredators`. Zero would mean waiting for total extinction before
 *  acting, which is the state the user is complaining about. */
export const PRED_RESEED_FLOOR = 1;
/** How many animals a re-founding drops, and how long it waits before trying
 *  again. Two, because a re-founding of one animal is a species that dies of
 *  old age again in 1500 ticks: a single animal has nobody of the other sex
 *  and the whole point of the floor is to not be extinct. */
export const PRED_RESEED_COUNT = 2;
/** Ticks between attempts. Long enough that a world which has just lost its
 *  last predator to a bad patch does not spend the next hundred ticks
 *  re-seeding a species the moment it can, short enough that extinction is
 *  not observable. */
export const PRED_RESEED_COOLDOWN = 250;
/** How many predators of each sex a world may hold: three, because six is
 *  the ceiling and a species that has to keep breeding has to be three and
 *  three.
 *
 *  A litter is one animal with a fifty-fifty sex, so two of them can come out
 *  the same, and a den of two same-sex animals can never produce another one.
 *  Nothing anywhere in the world noticed that or corrected for it, so the
 *  population random-walked toward a single sex and then walked out: on the
 *  seed this was found on there were five males and one female at t=3000 and
 *  three males and no females by t=4000, after which every remaining animal
 *  spent a full lifespan walking home to a den with nobody in it of the sex it
 *  needed. It is not a food problem and it is not a den problem — it is six
 *  coins, flipped once, and no amount of tuning anything else reaches it. */
export const PRED_SEX_CAP = Math.floor(PRED_SOFT_CAP / 2);
/** How many caves a world has. Predators are born in one and go back to it. */
export const N_CAVES = 4;

// --- starting reserve ------------------------------------------------------
/** Generations the opening food reserve is sized to carry. */
export const FOOD_RESERVE_GENERATIONS = 6;
/** Opening food, in nutrition units, scattered over the walkable map.
 *
 *  The natural fertility (~13% of the map) is calibrated for a few hundred
 *  agents sweeping the world constantly. A founding handful covers a
 *  vanishing fraction of a 120k-cell map, so it spends most of its life
 *  standing on ground that will never grow food — and a meal that was never
 *  there to be had is a failed meal no matter how many plants exist
 *  somewhere else. Density is the scarce thing at t=0, not total food.
 *
 *  This is a *finite* stock, not extra fertility: it is scattered onto walkable
 *  ground without marking it fertile, so it never regrows. Sufficient to carry
 *  the founders to FOOD_RESERVE_GENERATIONS, then it is eaten and the world
 *  is back to its own scarcity — which is the part that makes scarcity mean
 *  anything.
 *
 *  Density is the lever, not the total, and the threshold is high. Measured
 *  on the default seed, 6 founders, 6000 ticks:
 *
 *      58k -> extinct t=923    80k -> extinct t=1153    90k -> gen 40
 *
 *  At 90k the founders reach the cap and then eat the reserve down from
 *  ~93k to ~31k over the run, so scarcity genuinely comes back. The figure
 *  is scaled with the map: the reserve is a *density*, and a 46% larger
 *  world holding the same total would quietly hand the founders a world
 *  with 31% less underfoot than the one the number was tuned on. */
export const FOOD_RESERVE = 130000;

// --- tuning ----------------------------------------------------------------
export const LEARNING_RATE = 0.01;
export const DISCOUNT = 0.95; // gamma
export const RMS_EPS = 1e-8;
export const RMS_DECAY = 0.9;
export const EPSILON_START = 0.25;
export const EPSILON_END = 0.05;
export const EPSILON_DECAY_TICKS = 40_000; // global sim-tick ramp

export const MOVE_ENERGY_COST = 0.0009;
export const BASE_METABOLISM = 0.0022;
export const WATER_MULTIPLIER = 2.5;
export const EAT_RADIUS = 1; // manhattan
export const MATE_RADIUS = 12;
/** Cheap per-tick neighbour scan (fear, flee, agent rays). */
export const SENSE_R = 20;
/** Long-range partner search, run every SEEK_EVERY ticks per agent. */
/** Sized for the founding population, not the mature one. At SEEK_R=34 a
 *  population of six had nobody in range 79% of the time and could not
 *  breed at all; 60 keeps a small founder group able to find a partner. */
export const SEEK_R = 60;
export const SEEK_EVERY = 12;
/** Two pixels must be this close to form a bond. */
export const BOND_RADIUS = 3;
/** How strong a bond has to be before it stops being breakable.
 *
 *  Courtship has to happen reliably or nothing is ever born, and a rule that
 *  lets the nearest eligible partner win every time turns that reliability
 *  into a churn: in a crowded village a pixel stands beside two or three
 *  candidates at once, severs and re-forms several times a second, never
 *  lets a bond climb, and `findPartner` then writes every animal off as
 *  spoken for. The population ends up starving for partners while standing
 *  surrounded by them. So a bond is cheap to start and costs a little to
 *  break; at 0.12 a courtship tick it takes about ten ticks of standing
 *  together, which is a courtship, not a commitment for life. Betrayals
 *  still happen — the sidebar counts them — they just happen to the young
 *  and the fickle rather than to everyone, always. */
export const BOND_LOYALTY = 0.6;
export const KILL_RADIUS = 1;
/** Ticks between one pixel's killings. KILL is gated behind desperation
 *  anyway; this is the other half of the same rule, because a gate a pixel
 *  can act on every single tick is a rate, not a gate. */
export const KILL_COOLDOWN = 40;
export const FLEE_TRIGGER_RADIUS = 6;

export const CARCASS_ROT_TICKS = 300;
export const CARCASS_NUTRITION = 0.35;
export const PLANT_NUTRITION = 1.0;
export const NAUSEA_TICKS = 120;

// --- survival gradients ----------------------------------------------------
/** Edge length, in cells, of one bucket in the coarse food field. Eight is
 *  about a third of a pixel's vision radius, so the gradient is wider than
 *  what a pixel can see and strictly better-informed than it is. */
export const FOOD_CELL = 8;
export const FOOD_BUCKETS_X = Math.ceil(GRID_W / FOOD_CELL);
export const FOOD_BUCKETS_Y = Math.ceil(GRID_H / FOOD_CELL);
export const FOOD_BUCKETS = FOOD_BUCKETS_X * FOOD_BUCKETS_Y;
/** Ticks between rebuilds of the food field. A pixel eats maybe one tile in
 *  twenty ticks, so a field that is a fifth of a second old is already
 *  describing a different world; rebuilding it every tick would be a second
 *  full pass over the map for a picture that is barely different. */
export const FOOD_FIELD_EVERY = 20;
/** Food on a cell, below which `Sim.eat` will not take from it and above which
 *  `World.foodStep` says the pixel has no reason to walk. The two functions
 *  have to agree on this number or a pixel is told to stand still on a tile
 *  it cannot eat from. */
export const FOOD_UNDERFOOT = 0.02;

// --- juvenile window -------------------------------------------------------
/** Ticks a newborn spends as a juvenile. Before this it is pulled hard toward
 *  its camp, which is the one place with adults in it — so a cohort of young
 *  grows up inside the village instead of being born into open country and
 *  starving alone. This is the "time to reproduce" the world was missing: a
 *  population that is born scattered dies scattered, however well each
 *  individual is doing. */
export const JUVENILE_TICKS = 80;
/** How far from its camp a newborn may be born, in cells.
 *
 *  Zero, and the village fills up in one place — which is the point. A
 *  newborn used to be dropped on a uniformly random tile of a 286k-cell map,
 *  which meant the average birth happened about two hundred cells from
 *  either parent, in country it had never seen, with nobody in partner range
 *  and no reason to be anywhere in particular. The population could not grow
 *  past thirty on those worlds and then aged out: two of ten seeds went
 *  extinct with a hundred thousand nutrition units of grass going spare and
 *  every death of old age. Birth is now an event in a place — the cohort's
 *  camp, the same one the juvenile pull is pointing at, a few cells of it. */
export const BIRTH_SPREAD = 3;
/** What a newborn is born holding. A blank slate of 0.5 energy and 0.3
 *  thirst is about 150 ticks of life before the first meal has to land, and
 *  that margin is exactly what a predator takes. */
export const NEWBORN_ENERGY = 0.8;
export const NEWBORN_THIRST = 0.1;

// --- thirst ----------------------------------------------------------------
/** Thirst rises at a rate matched to BASE_METABOLISM, so a full tank of water
 *  lasts about as long as a full belly. That is the whole point: not eating
 *  and not drinking kill on the same timeline, and you can starve to death
 *  standing next to a river you refused to drink from. */
export const THIRST_RATE = 0.0022;
/** Thirst lost per drink, and how much one wade is worth. */
export const DRINK_RELIEF = 0.5;
/** Health lost per tick at maximum thirst — deliberately the same figure as
 *  the starvation drain, so neither drive is the "real" one. */
export const DEHYDRATION_DAMAGE = 0.025;
/** How close you must be to water to drink: your own tile or a neighbour. */
export const DRINK_RADIUS = 1;

export const SEASON_TICKS = 1200; // 120s at 1x
export const SEASON_NAMES = ['spring', 'summer', 'autumn', 'winter'] as const;
// plants regrow at these multipliers
export const SEASON_REGROW = [1.0, 0.6, 0.9, 0.15] as const;

// --- genome ---------------------------------------------------------------
export const N_GENES = 10;

// --- saved worlds ----------------------------------------------------------
/** The shape of a saved world: the brain's input count, verb count and every
 *  field that is interpreted rather than merely stored. A world saved under a
 *  different shape cannot be loaded — a weight vector of 2800 read as 5587 is
 *  not a brain with bad memories, it is a different animal.
 *
 *  It lives here rather than in the worker because it is a fact about the
 *  simulation, and sim/, worker/ and tests/ all have to agree on it. */
export const SNAPSHOT_VERSION = 2;
