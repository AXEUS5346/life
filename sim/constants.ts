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
export const MAX_AGENTS = 300;
/** Newborns below this always survive. Between SOFT_CAP and HARD_CAP the
 *  survival chance falls linearly to zero. At HARD_CAP it is always fatal. */
export const SOFT_CAP = 70;
export const HARD_CAP = 120;
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

// --- brain: 41 -> 48 -> 16 -------------------------------------------------
// 37 sensors: 15 body/state channels, 5 sets of 4 compass rays (food, agent,
// plant, carcass, water), then nearest-other and standing-in-water.
export const N_INPUTS = 45;
export const N_HIDDEN = 48;
export const N_OUTPUTS = 16;
export const N_MOVE = 9; // 3x3 movement grid
/** Offsets of the 3x3 movement grid, row-major, 0 = up-left. These indices are
 *  the same numbers as the brain's first N_MOVE output units, so the world can
 *  hand a heading straight to the policy. */
export const MOVE_DX = [-1, 0, 1, -1, 0, 1, -1, 0, 1] as const;
export const MOVE_DY = [-1, -1, -1, 0, 0, 0, 1, 1, 1] as const;
export const N_VERB = 7; // discrete verbs
export const W1_SIZE = N_INPUTS * N_HIDDEN; // 1968
export const B1_SIZE = N_HIDDEN; // 48
export const W2_SIZE = N_HIDDEN * N_OUTPUTS; // 768
export const B2_SIZE = N_OUTPUTS; // 16
export const N_PARAMS = W1_SIZE + B1_SIZE + W2_SIZE + B2_SIZE; // 2800
export const OFF_W1 = 0;
export const OFF_B1 = OFF_W1 + W1_SIZE;
export const OFF_W2 = OFF_B1 + B1_SIZE;
export const OFF_B2 = OFF_W2 + W2_SIZE;

// --- verbs (plain const object: `enum` is not erasable syntax) -------------
export const Verb = {
  IDLE: 0,
  EAT: 1,
  SEEK_MATE: 2,
  MATE: 3,
  KILL: 4,
  FLEE: 5,
  REST: 6,
} as const;
export const VERB_NAMES = [
  'idle', 'eat', 'seek_mate', 'mate', 'kill', 'flee', 'rest',
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
export const PRED_DEN_CAP = 6;
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
/** How far a predator can see another predator of the opposite sex. Sex is
 *  only worth tracking if the search is real, and with six predators in the
 *  world a wide radius is not a cost. */
export const PRED_MATE_R = 140;
export const PRED_MATE_BOND_R = 4;
/** How much a den already being lived in counts against it when a lone
 *  predator is choosing somewhere to move: 70 cells per animal already in
 *  there, or about how far it would rather not walk. The effect is that
 *  recruits go to the nearest chamber with room, so the species spreads over
 *  two or three dens rather than all six animals emptying into one rock. */
export const PRED_DEN_CROWDING = 70;
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
/** Cap on how many may exist, so a bad world cannot be swallowed whole. */
export const PRED_SOFT_CAP = PRED_DEN_CAP;
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
export const PRED_SEX_CAP = PRED_SOFT_CAP / 2;
/** How many caves a world has. Predators are born in one and go back to it. */
export const N_CAVES = 6;

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
