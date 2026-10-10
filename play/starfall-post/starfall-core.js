/* Starfall Post — core logic. Lane generation, physics, collisions,
   scoring. Pure functions only: no DOM, no rendering, no Math.random.
   The same file runs in the browser (window.StarfallCore) and in Node
   (module.exports) so the gate's proofs exercise the shipped logic.

   v1.1 (FD-034 + FD-035): one endless lane for everybody. A single
   canonical seed (SEED below): every player flies the identical rock
   sequence, generated in chunks as a pure function of the chunk
   index. Difficulty ramps continuously with depth on the documented
   curve in §"the ramp" — gentle for roughly the first minute, at
   full hardness from about 60,000 px in, and sustained there. At
   fixed depths the lane throws a mini-boss (§"mini-bosses"): a large
   pattern built from the same rocks, survived and threaded, never
   shot — the skiff carries parcels, not guns. Controls are direct
   (FD-035): the ship's position follows the held input at a fixed
   speed and stops when the input stops — no momentum, no drift, no
   wind-push; the lane's scroll, density, patterns and bosses are the
   difficulty. A run ends only when the parcel breaks (five hits).
   The district campaign, the daily lane and the modifiers are gone.

   v1.2 (FD-037, owner's playtest of the live v1.1) fixes four
   things. (1) The render list (snapshot) now covers every rock the
   collision pass can touch: v1.1 rendered only rocks down to 60 px
   of depth behind the ship's anchor while collisions ran to 320 px
   behind, so rocks in the bottom band could hit invisibly —
   anything collidable is now drawn until it is fully past the
   bottom and out of reach. (2) The height throttle is gone: flying
   high no longer speeds the lane up, nor dropping back slow it —
   scroll is a function of depth only. (3) The ramp bites sooner
   and plateaus harder (full hardness from ~34,000 px, past every
   v1.1 plateau value). (4) Camping is dead: depth pays nothing,
   beacons are never placed on the safe centre line (you must leave
   it to deliver), and delivery + near-miss credit require the ship
   to have actually flown in the last second or so — a parked ship
   scores nothing and, outside the corridor's passing shelter,
   does not live long either.

   v1.3 (owner's playtest of the live v1.2): two changes, neither to
   the game's shape. (1) The sound: the presentation's static bed
   chord is replaced by a slow chord progression and the near-miss
   sweep is softened (starfall.js § sound — no core change).
   (2) The ramp is lifted a little in the deep lane — plateau
   scroll 275 → 295, row gap 46 → 43, sway 84 → 90, corridor
   halfW 58 → 55, plateau at ~30,000 px instead of ~34,400 —
   blended in between 12,000 and 24,000 px so the opening lane
   (chunks 0–2, generated on v1.2's parameters) is unchanged and
   a first-timer's learning minute is the same. Medals, boss
   cadence and patterns are untouched.

   v1.4 (owner's playtest of the live v1.3): the delivery capture
   loses its activity gate. Passing through a beacon's ring is the
   delivery, full stop — the v1.2 recentMove requirement denied
   coasted pickups (line up early, hands off, ring dead-centre,
   nothing counted). The gate survives only on near-miss credit.
   Anti-camping stands on its other two legs — depth pays nothing
   and beacons are placed off the safe centre line — re-proven by
   the hover suite. Delivery counts change materially, so saves
   move to v6 keys (in starfall.js).

   v1.5 (owner's playtest of the live v1.4): the bosses were "way
   too short and easy" — they are now real sections, roughly two
   and a half times as long and built to bite. The Gates is
   twenty-nine walls with a narrower, fast-walking gap; The
   Slalom is twenty-nine crossings on a tighter clock; The
   Orbit's boulder no longer sits at one depth waiting to be
   passed — it travels with the ship through the whole zone,
   weaving across the field while its satellites sweep, so the
   whole zone is the fight.
   Tier scaling steepens on every pattern. Boss zones now span
   several chunks: generation is zone-aware (the field yields to
   the pattern inside the zone span and is untouched outside it),
   and a boss's anchor chunk is retained until the zone is past
   so its descriptor survives the whole fight. Run comparability
   changes with the geometry, so saves move to v7 keys (in
   starfall.js).

   v1.6 (owner's playtest of the live v1.5): "at least 1.5x more
   difficult, and each cycle of boss more and more difficult."
   Two moves. (1) The whole lane lifts: the ramp keeps v1.5's
   opening exactly (the first 12,000 px are the learning stretch)
   and then climbs steeply to a harder plateau by 24,000 px —
   scroll 295 → 335, row gap 43 → 38, sway 90 → 108, corridor
   halfW 55 → 48 — with denser, bigger rocks (radius ×1.28, the
   extra-rock weights up). The beacon band (70–150 px off the
   centre line) is the one parameter that could NOT move: at
   85–170 the reference pilots' delivery rate fell by a third
   and the Wren medal left proof reach (the delivery evidence
   is in the v1.6 report) — delivery difficulty is carried by
   the density, size and sway around the beacons instead.
   Where a full 1.5×
   would break the survivability proof the parameter goes as
   far as the proof allows (the v1.6 report tabulates the factor
   actually applied to each). (2) Boss escalation is now
   formula-driven and unbounded: every pattern's hardness is an
   asymptotic function of tier — wall gaps follow a guaranteed
   worst-instant span schedule that tightens toward a floor
   above the fairness minimum, wall spacing tightens and wall
   counts grow into the same zone length, wall sway grows, The
   Orbit gains satellites (cap 12), spin and weave — each
   formula monotone in tier and bounded by its asymptote, so
   the channel proofs hold at tier 40 as they do at tier 0.
   Run comparability changes again, so saves move to v8 keys
   (in starfall.js). */
(function (global) {
"use strict";

/* ---------------- field + ship constants ---------------- */
var W = 480, H = 720;
var ANCHOR_Y = 432;            /* screen line the ship's depth sits on */
var SHIP_R = 13;
var SHIP_VX = 300;             /* direct-control speeds, px/s */
var SHIP_VY = 250;
var HIT_DAMAGE = 20;           /* parcel integrity lost per meteor hit */
var CAPTURE_R = 58;            /* beacon delivery radius (screen px) */
var NEAR_R = 17;               /* extra px beyond touching = near miss */
/* v1.2: there are no depth points. The score is deliveries, near
   misses and boss bonuses — all of it earned by flying. */

/* ---------------- the lane ---------------- */
var SEED = "starfall-post";    /* the one canonical seed, for everyone */
var CHUNK = 6000;              /* generation chunk, px of depth */

/* ---------------- seeded rng ---------------- */
function fnv1a(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function chunkHash(chunk) {
  /* Stable fingerprint of a generated chunk (incl. any boss pattern),
     for the determinism proof. */
  var h = fnv1a("chunk");
  function mix(n) { h ^= (n + 0x9e3779b9) & 0xffffffff; h = Math.imul(h, 0x01000193); }
  chunk.beacons.forEach(function (b) { mix(Math.round(b.depth)); mix(Math.round(b.x * 10)); });
  chunk.meteors.forEach(function (m) {
    mix(Math.round(m.depth)); mix(Math.round(m.x * 10)); mix(Math.round(m.r * 10));
    mix(Math.round(m.drift * 10)); mix(Math.round(m.phase * 100));
  });
  if (chunk.boss) {
    mix(chunk.boss.pattern + 11); mix(Math.round(chunk.boss.cx));
    mix(Math.round(chunk.boss.cyDepth)); mix(chunk.boss.n || 0);
  }
  return ("0000000" + (h >>> 0).toString(16)).slice(-8);
}

/* ---------------- the ramp ----------------
   Every difficulty parameter is a function of depth (px). All rise
   together from a gentle opening to a hard plateau and are
   sustained from there — the lane never gets easier again, and
   the corridor guarantee (§ lane generation) holds at every
   depth, so the limit on a run is always the pilot, never the
   geometry. (v1.2: the ramp bites sooner and its plateau sits
   past v1.1's on every axis. v1.3 lifts the plateau a little
   further — scroll → 295, gap → 43, sway → 90, halfW → 55 —
   blended in between 12,000 and 24,000 px.)
   On top of the ramp sit the mini-bosses (§ below): the first at
   24,000 px, then one every 30,000 px. */
/* The v1.6 shape: until 12,000 px the parameters are exactly the
   opening expressions every version since v1.2 has used (the
   plain expressions below ARE those values) — the first two
   chunks stay the welcoming learning stretch. From 12,000 px a
   smoothstep climb (§ climbT) takes each parameter from its
   12,000 px value to the v1.6 plateau by 24,000 px: scroll 335,
   row gap 38, extra 0.99, sway 108, corridor halfW 48. The
   plateau is reached sooner and sits higher than v1.5's on every
   axis; the corridor floor is what caps halfW: the centre
   line's slope can eat at most ~5.1 px of the placement
   clearance, so 48 keeps the worst-case flying clearance above
   the verifier's 40 px floor by construction, not by sampling
   luck (at 45 the sampled minimum was 40.7 but the bound was
   39.9). */
function climbT(d) { var t = (d - 12000) / 12000; t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
function scrollAt(d) { return d <= 12000 ? 175 + d * 0.0029 : 209.8 + 125.2 * climbT(d); }
function gapAt(d)    { return d <= 12000 ? 108 - d * 0.0018 : 86.4 - 48.4 * climbT(d); }
function extraAt(d)  { return d <= 12000 ? 0.42 + d * 0.000016 : 0.612 + 0.378 * climbT(d); }
function driftAt(d)  { return d <= 12000 ? 22 + d * 0.0018 : 43.6 + 64.4 * climbT(d); }
function halfWAt(d)  { return d <= 12000 ? 80 - d * 0.00064 : 72.32 - 24.32 * climbT(d); }
function paramsAt(d) {
  return { scroll: scrollAt(d), gap: gapAt(d), extra: extraAt(d),
           drift: driftAt(d), halfW: halfWAt(d) };
}

/* ---------------- medals (best-run achievements) ----------------
   A run earns the highest medal whose BOTH marks it reaches: depth
   in px and deliveries. Calibrated on the cold playtests (v1.1
   report §7; v1.2 report §7 re-checked them against the harder
   lane and kept them): in the v1.2 cold session, trying runs
   banked Bronze routinely (1,900–2,200 m, 7 deliveries), the best
   run earned Silver (4,289 m, 12 deliveries), and Gold and Wren
   stayed unbanked — bronze is a learner's good run, Wren a
   deep-lane feat that also demands a long unbroken chain. */
var MEDAL_MARKS = [
  { medal: "wren",   depth: 72000, deliveries: 24, chain: 10 },
  { medal: "gold",   depth: 48000, deliveries: 16, chain: 0 },
  { medal: "silver", depth: 26000, deliveries: 9,  chain: 0 },
  { medal: "bronze", depth: 12000, deliveries: 4,  chain: 0 }
];
function medalForRun(depth, deliveries, bestChain) {
  for (var i = 0; i < MEDAL_MARKS.length; i++) {
    var m = MEDAL_MARKS[i];
    if (depth >= m.depth && deliveries >= m.deliveries && bestChain >= m.chain) return m.medal;
  }
  return "none";
}

/* ---------------- lane generation ----------------
   The lane is fully determined by SEED. The safe corridor is an
   explicit analytic function of depth,
     centre(depth) = 240 + 118*sin(depth/2650 + p1) + 58*sin(depth/940 + p2)
   with p1/p2 drawn from the seed — one continuous curve across all
   chunks. Rocks are placed so that even at the extreme of their
   sideways sway their edge never enters [centre-halfW, centre+halfW]
   at their depth, and beacons sit inside rock-free bubbles offset
   from the corridor line. A passable channel therefore exists at
   every depth by construction, indefinitely; the verifier asserts
   it chunk by chunk as far as it runs. Boss chunks (§ mini-bosses)
   replace the random field with their pattern, whose own channel
   is asserted the same way. */
function seedPhases(seedStr) {
  var a = fnv1a(seedStr), b = fnv1a(seedStr + "#2");
  return { p1: (a % 6283) / 1000, p2: (b % 6283) / 1000 };
}
function corridorCenter(ph, depth) {
  return W / 2 + 118 * Math.sin(depth / 2650 + ph.p1) + 58 * Math.sin(depth / 940 + ph.p2);
}

function buildField(rng, opts, depthFrom, depthTo, ph) {
  var meteors = [];
  var rows = Math.floor((depthTo - depthFrom) / opts.gap);
  for (var i = 0; i < rows; i++) {
    var depth = depthFrom + i * opts.gap + rng() * opts.gap * 0.5;
    if (depth < 500) continue;                    /* calm launch stretch */
    var center = corridorCenter(ph, depth);
    var count = 1 + (rng() < opts.extra ? 1 : 0) + (rng() < opts.extra * 0.5 ? 1 : 0) + (rng() < opts.extra * 0.25 ? 1 : 0);
    for (var k = 0; k < count; k++) {
      /* v1.6: the v1.5 radius distribution scaled by 1.28 —
         12.8..35.8, small ones still common */
      var r = (10 + Math.pow(rng(), 1.6) * 18) * 1.28;
      var drift = opts.drift * (0.4 + rng() * 0.9);
      var side = rng() < 0.5 ? -1 : 1;
      /* clearance includes the rock's whole sway: at no point in its
         oscillation can its edge enter the corridor */
      var x = center + side * (opts.halfW + r + drift + 4 + rng() * 110);
      if (x < r + 8) x = r + 8 + rng() * 30;
      if (x > W - r - 8) x = W - r - 8 - rng() * 30;
      if (Math.abs(x - center) < opts.halfW + r + drift) continue;
      meteors.push({
        depth: depth, x: x, r: r, drift: drift,
        phase: rng() * Math.PI * 2,
        spin: (rng() - 0.5) * 1.4,
        seedI: meteors.length
      });
    }
  }
  return { meteors: meteors };
}

function clearBubbles(meteors, beacons) {
  for (var i = meteors.length - 1; i >= 0; i--) {
    var m = meteors[i], drop = false;
    for (var j = 0; j < beacons.length; j++) {
      var b = beacons[j];
      if (Math.abs(m.depth - b.depth) < 175 && Math.abs(m.x - b.x) < 95 + m.r) { drop = true; break; }
    }
    if (drop) meteors.splice(i, 1);
  }
}

/* ---------------- mini-bosses ----------------
   Bosses live at fixed depths — the first at 24,000 px, then one
   every 30,000 px — each anchored at a chunk start. Since v1.5 a
   boss is a SECTION, not a moment: its zone runs 10,000–13,100 px
   across several chunks, with a clear approach stretch before
   the first feature (the telegraph: the pattern is seen
   entering, never an instant kill; the presentation adds a
   warning as it nears). Three patterns cycle by boss index k
   (pattern = k mod 3); every return of a pattern is one
   escalation tier up (tier = floor(k/3)). Surviving a boss
   (flying past its end) pays 300 + 100 × tier. A zone always
   ends well clear of the next boss's start (worst case end =
   start + 13,100 against a 30,000 px cadence). The verifier
   asserts each pattern's channel numerically, and the
   boss-evidence driver flies the reference pilots through
   every zone.

   Escalation (v1.6) is formula-driven and unbounded: every
   hardness quantity is a monotone function of tier bounded by
   an asymptote that itself respects the fairness floors, so
   cycle 30 is harder than cycle 3 and still provably flyable.
   The wall patterns share one gap law: the declared gap width
   is built from WF(tier) = 80 + 17·0.75^tier — the guaranteed
   free span at the worst sway instant, before the wall grid's
   share (the rock-omission rule bounds the grid's narrowing at
   16 px, so the measured worst span is at least WF − 6 at every
   tier; the fairness floor is 66) — plus twice the sway plus a
   10 px grid allowance. Wall sway itself grows with tier
   (drift × (1 + 0.3·(1 − 0.75^tier)), 40 → 52), wall spacing
   tightens toward its own floor and the wall count grows into
   the fixed zone length. The Orbit's satellites rise 8 → 12
   (stepping up from the second cycle), its ring radius grows
   120 → 135, its spin and weave rise toward caps chosen so
   the pattern's total speed stays under the ship's vertical
   speed and the threadable arc stays at or above 40 px (both
   asserted per tier in the verifier, and true at the asymptotes
   by the same arithmetic). Tier 0 of the wall patterns is
   v1.5's boss, modulo the harder lane around it (the ramp's
   plateau scroll sets the walls' closing speed); The Orbit's
   tier 0 ring is deliberately a touch smaller than v1.5's —
   the escalation formulas carry its difficulty from tier 1 up.

   0 · THE GATES — rock walls, one gap each (29 at tier 0, more
       as tiers tighten the spacing); the gap walks along a
       seeded path in steps the reachability budget allows after
       the sway takes its share (the verifier checks the same
       arithmetic) — and the walls come faster than any reaction
       window, so the walk must be read ahead, not reacted to.
       The wall rocks sway, so the gap breathes as it comes.
       Endurance is the test: threads of a narrowing needle.
   1 · THE ORBIT — a huge boulder with satellites circling it.
       The boulder waits ahead of the zone, then TRAVELS with the
       ship through it: its centre holds a lead on the ship's
       depth while weaving across the field and sweeping up and
       down it, so the satellite disc is a threat the whole way,
       not a single pass. It stops short of the zone's end and is
       passed one last time on the way out.
   2 · THE SLALOM — walls whose gaps alternate far left / far
       right, forcing crossings on a clock the ship can always
       meet; the crossing amplitude is whatever the reachability
       budget leaves after sway, so at deep tiers the pattern's
       bite is frequency, sway and gap rather than amplitude. */
var BOSS_FIRST = 24000, BOSS_EVERY = 30000;
var BOSS_NAMES = ["The Gates", "The Orbit", "The Slalom"];
var BOSS_MAX_ZONE = 13100;     /* the longest zone (The Gates) */
function bossIndexForChunk(ci) {
  var start = ci * CHUNK;
  if (start < BOSS_FIRST || (start - BOSS_FIRST) % BOSS_EVERY !== 0) return -1;
  return (start - BOSS_FIRST) / BOSS_EVERY;
}
function bossBonus(k) { return 300 + 100 * Math.floor(k / 3); }

function wallRocks(depth, gapC, gapW, seedI0, drift, phase0) {
  /* One solid row of rock across the field except the gap. Rocks
     are r=15 spaced 23 px apart (overlapping — no through-hole),
     and a rock is omitted only if it would narrow the gap. Since
     v1.5 the wall is built of the lane's own rock: every rock
     sways with the drift the ramp has reached at this depth (its
     own phase, like field rock), so the gap breathes and wanders
     as it comes at you — read it late and it has moved. */
  var out = [];
  for (var x = 15; x <= W - 15; x += 23) {
    if (Math.abs(x - gapC) < gapW / 2 + 7) continue;
    var si = seedI0 + out.length;
    out.push({ depth: depth, x: x, r: 15, drift: drift,
               phase: phase0 + ((si * 2654435761) % 628) / 100,
               spin: 0.35, seedI: si });
  }
  return out;
}
function buildBoss(k) {
  /* A boss's geometry is a pure function of its index alone (its
     own seeded stream), so every chunk the zone touches rebuilds
     the identical pattern. */
  var rng = mulberry32(fnv1a(SEED + ":boss:" + k));
  var start = BOSS_FIRST + k * BOSS_EVERY;
  var pattern = k % 3, tier = Math.floor(k / 3);
  var meteors = [], boss = null, end;
  /* Wall patterns sway with the lane's drift at this depth
     (capped), grown by tier (v1.6: ×1 → ×1.3 asymptotically):
     the reachability budget the verifier asserts is spent on
     the gap walk AND the sway, with margin — the channel proof
     (§ boss channels) uses the same arithmetic. */
  var drift = Math.round(Math.min(40, paramsAt(start).drift * 0.8) * (1 + 0.3 * (1 - Math.pow(0.75, tier))));
  var closing0 = scrollAt(start) * 1.15;
  /* The wall patterns' shared gap law (v1.6, § mini-bosses):
     declared width from the guaranteed worst-instant span
     schedule WF(tier) = 80 + 17·0.75^tier (97 at tier 0,
     tightening toward 80), plus twice the sway, plus the
     10 px grid allowance. */
  var gapW = Math.round(80 + 17 * Math.pow(0.75, tier) + 2 * drift + 10);
  if (pattern === 0) {                                   /* The Gates */
    var spacing = Math.round(302 + 98 * Math.pow(0.78, tier));
    var walls = Math.floor(11200 / spacing) + 1, first = start + 900;
    var stepBound = Math.max(48, SHIP_VX * (spacing / closing0) - 30 - 2 * drift - 25);
    var c = 240 + (rng() - 0.5) * 120, prev = c;
    for (var i = 0; i < walls; i++) {
      var step = (rng() - 0.5) * 2 * stepBound;
      c = Math.max(gapW / 2 + 20, Math.min(W - gapW / 2 - 20, prev + step));
      meteors = meteors.concat(wallRocks(first + i * spacing, c, gapW, 1000 + i * 40, drift, i * 0.7));
      prev = c;
    }
    end = start + 13100;
    boss = { pattern: 0, name: BOSS_NAMES[0], start: start, end: end, tier: tier,
             gapW: gapW, spacing: spacing, walls: walls, drift: drift };
  } else if (pattern === 1) {                            /* The Orbit */
    /* No static rocks at all: the boulder and its satellites are
       computed from the run state by orbitRocks (§ simulation) —
       the boulder travels with the ship, so its geometry cannot
       live in a chunk. Every tunable sits here, in the
       descriptor. */
    /* v1.6 escalation, all asymptotic in tier (§ mini-bosses):
       satellites 8 → 12 (the count steps up from the second
       cycle — tier 1 still flies 8 — and the arc floor caps it
       as R grows), ring radius 120 → 135, spin 0.78 → 0.90,
       weave amplitude and rate up — the weave + tip speed stays
       under SHIP_VY at every tier and at the asymptote (240 of
       250). Tier 0's ring is smaller than v1.5's (R 120 vs 135):
       the first Orbit is the pattern's introduction, and the
       escalation formulas, not the first draw, carry the
       difficulty — by tier 2 the ring is back to ~131 and the
       count and spin are past v1.5's. */
    boss = { pattern: 1, name: BOSS_NAMES[1], start: start, end: start + 10000, tier: tier,
             cx: W / 2, cyDepth: start + 750,
             R: 120 + 15 * (1 - Math.pow(0.75, tier)), n: Math.min(12, 8 + Math.max(0, tier - 1)), omega: 0.90 - 0.12 * Math.pow(0.75, tier),
             rockR: 15 - 2.5 * (1 - Math.pow(0.75, tier)), bodyR: 46,
             xAmp: 125 - 10 * Math.pow(0.75, tier), xRate: 0.28 - 0.02 * Math.pow(0.75, tier),
             yAmp: 190 - 15 * Math.pow(0.75, tier), yRate: 0.44 - 0.04 * Math.pow(0.75, tier), yMid: 320,
             park: start + 750, stopShort: 350,
             phase0: rng() * Math.PI * 2, phX: rng() * Math.PI * 2, phY: rng() * Math.PI * 2 };
    end = boss.end;
  } else {                                               /* The Slalom */
    var spacing2 = Math.round(318 + 112 * Math.pow(0.78, tier));
    var gapW2 = gapW;
    var walls2 = Math.floor(12040 / spacing2) + 1, first2 = start + 800;
    var stepBound2 = Math.max(48, SHIP_VX * (spacing2 / closing0) - 30 - 2 * drift - 25);
    var amp = Math.min(140, Math.max(12, (stepBound2 - 24) / 2));
    for (var j = 0; j < walls2; j++) {
      var cc = W / 2 + (j % 2 === 0 ? -amp : amp) + (rng() - 0.5) * 24;
      meteors = meteors.concat(wallRocks(first2 + j * spacing2, cc, gapW2, 3000 + j * 40, drift, j * 0.7));
    }
    end = start + 13000;
    boss = { pattern: 2, name: BOSS_NAMES[2], start: start, end: end, tier: tier,
             gapW: gapW2, spacing: spacing2, walls: walls2, drift: drift };
  }
  return { meteors: meteors, boss: boss };
}

/* One chunk of the canonical lane: a pure function of its index.
   Field parameters are sampled at the chunk's start depth (the
   ramp's steepest slope moves any parameter by less than 7 units
   across a chunk). The field is generated exactly as it always
   was; then, if a boss zone (§ mini-bosses) overlaps the chunk,
   the pattern takes the zone's span: field rocks and beacons
   inside [zone.start, zone.end) are dropped and the boss's own
   rocks for this chunk's span are laid in. Outside every zone the
   chunk is identical to the pre-v1.5 lane — the filtering only
   ever removes, and only inside a zone. The boss descriptor rides
   on the zone's anchor chunk, where bossOf looks for it. */
function generateChunk(idx) {
  var rng = mulberry32(fnv1a(SEED + ":chunk:" + idx));
  var ph = seedPhases(SEED);
  var from = idx * CHUNK, to = from + CHUNK;
  var p = paramsAt(from);
  var field = buildField(rng, p, from, to, ph);
  var meteors = field.meteors;
  var beacons = [];
  for (var i = 0; i < 2; i++) {
    var bd = from + (i + 0.5) * CHUNK / 2 + (rng() - 0.5) * 800;
    /* v1.2: a beacon is never placed on or near the safe centre
       line — the offset is always to one side (mirrored at the
       field edges so the offset survives). Sitting in the
       corridor keeps you alive; it never delivers anything. The
       job is always out on the rock side of the lane. v1.6: the
       band is unchanged in v1.6 (70–150 px — the delivery
       evidence in the v1.6 report shows why it could not move
       out without taking the Wren medal out of proof reach). */
    var ctr = corridorCenter(ph, bd);
    var off = (70 + rng() * 80) * (rng() < 0.5 ? -1 : 1);
    var bx = ctr + off;
    if (bx < 56) bx = ctr - off;
    if (bx > W - 56) bx = ctr - off;
    if (bx < 56) bx = 56; if (bx > W - 56) bx = W - 56;
    beacons.push({ depth: Math.round(bd), x: Math.round(bx) });
  }
  clearBubbles(meteors, beacons);
  /* boss zones overlapping this chunk take their span */
  var boss = null;
  var kLo = Math.max(0, Math.floor((from - BOSS_FIRST - BOSS_MAX_ZONE) / BOSS_EVERY));
  for (var k = kLo; BOSS_FIRST + k * BOSS_EVERY < to; k++) {
    var built = buildBoss(k);
    var zb = built.boss;
    if (zb.end <= from) continue;
    meteors = meteors.filter(function (m) { return m.depth < zb.start || m.depth >= zb.end; });
    beacons = beacons.filter(function (b) { return b.depth < zb.start || b.depth >= zb.end; });
    for (var bi = 0; bi < built.meteors.length; bi++) {
      var bm = built.meteors[bi];
      if (bm.depth >= from && bm.depth < to) meteors.push(bm);
    }
    if (bossIndexForChunk(idx) === k) boss = zb;
  }
  return { meteors: meteors, beacons: beacons, boss: boss };
}

/* ---------------- run state + simulation ---------------- */
function createRun() {
  var state = {
    lane: { seed: SEED, endless: true },
    time: 0, depth: 0,
    ship: { x: W / 2, y: ANCHOR_Y + 60, vx: 0, vy: 0 },
    integrity: 100, invulnT: 0,
    chain: 0, bestChain: 0, lastDeliveryT: -99,
    deliveries: 0, nearMisses: 0, hits: 0,
    /* v1.2 anti-camping bookkeeping: recent self-driven flight, in
       px, decayed with a ~0.9 s half-life each step and topped up
       by the ship's actual movement. Near-miss credit still
       requires it to be at least ACTIVITY_MIN (a rock drifting
       past a parked ship pays nothing). Deliveries required it
       too until v1.4, which removed the gate from capture: it
       denied coasted pickups flown exactly as intended. */
    recentMove: 0,
    raw: 0, done: false, cleared: false,
    bosses: 0, nextBoss: 0, bossWarned: -1,
    chunks: {},
    startedAt: null
  };
  ensureChunks(state); collectEndless(state);
  return state;
}
function ensureChunks(state) {
  var need = Math.floor((state.depth + 2400) / CHUNK);
  for (var i = 0; i <= need; i++) {
    if (!state.chunks[i]) state.chunks[i] = generateChunk(i);
  }
  /* drop chunks far behind to bound memory — except a boss's
     anchor chunk, which carries the descriptor bossOf reads: it
     is kept until the zone is fully past, however many chunks
     the zone spans (v1.5) */
  var keys = Object.keys(state.chunks);
  for (var k = 0; k < keys.length; k++) {
    var ch = state.chunks[keys[k]];
    if (ch.boss && state.depth < ch.boss.end + 1600) continue;
    if ((+keys[k] + 1) * CHUNK < state.depth - 1600) delete state.chunks[keys[k]];
  }
}
function collectEndless(state) {
  /* Flatten loaded chunks into the run's working lists (sorted by depth). */
  var ms = [], bs = [];
  Object.keys(state.chunks).sort(function (a, b) { return a - b; }).forEach(function (k) {
    ms = ms.concat(state.chunks[k].meteors);
    bs = bs.concat(state.chunks[k].beacons);
  });
  ms.sort(function (a, b) { return a.depth - b.depth; });
  bs.sort(function (a, b) { return a.depth - b.depth; });
  state.meteors = ms; state.beacons = bs;
}
/* The boss descriptor for boss index k, if its chunk is loaded. */
function bossOf(state, k) {
  var ci = (BOSS_FIRST + k * BOSS_EVERY) / CHUNK;
  var ch = state.chunks[ci];
  return ch ? ch.boss : null;
}
/* The Orbit's clock (v1.6): the encounter is a function of
   PROGRESS through the zone — ship depth relative to the zone
   start, in units of the zone's own scroll seconds — never of
   run time. Until v1.5 the weave and spin ran on state.time:
   depth and time are locked together in a live run, so every
   player met the same encounter, but its alignment was an
   accident of the ramp's integral — any difficulty change
   silently re-rolled every boss's phase, and a trial that
   teleports to the zone (the gate's own instrument) measured a
   neighbouring encounter, not the shipped one: at some arrival
   offsets the v1.5 tier-0 Orbit shreds the channel pilot, at
   others it barely touches it (difficulty-evidence-v16
   diagnostic). Progress-anchored, the encounter is a designed
   constant of the canonical lane: trials measure exactly what
   a full run flies. (The clock's rate still breathes with the
   ship's own vertical movement — climbing stretches the
   encounter, diving compresses it; at cruise it runs 1:1, which
   is the rate the channel proof asserts.) */
function orbitClock(state, boss) {
  return (shipDepthOf(state) - boss.start) / scrollAt(boss.start);
}
/* The Orbit's centre, as a pure function of the run state
   (v1.5): the boulder waits parked at boss.park; once the ship
   closes in it travels — holding a lead on the ship's depth so
   its screen height is the weave's y(t), crossing the field on
   x(t) — until it stops boss.stopShort short of the zone's end
   and is passed for the last time. The clamps are max/min of
   continuous functions, so the centre never jumps. (v1.6: t is
   the progress clock above, not run time.) */
function orbitCenter(state, boss) {
  var t = orbitClock(state, boss);
  var yc = boss.yMid + boss.yAmp * Math.sin(t * boss.yRate + boss.phY);
  var xc = W / 2 + boss.xAmp * Math.sin(t * boss.xRate + boss.phX);
  var cd = shipDepthOf(state) + (ANCHOR_Y - yc);
  if (cd < boss.park) cd = boss.park;
  if (cd > boss.end - boss.stopShort) cd = boss.end - boss.stopShort;
  return { x: xc, depth: cd, yc: yc };
}
/* The Orbit's rocks right now: the boulder body and its
   satellites, all from orbitCenter — one list for the collision
   pass and the snapshot, so what is drawn is what can hit. */
function orbitRocks(state, boss) {
  var c = orbitCenter(state, boss);
  var t = orbitClock(state, boss);
  var out = [{ x: c.x, depth: c.depth, r: boss.bodyR, spin: 0.12 }];
  for (var j = 0; j < boss.n; j++) {
    var a = boss.phase0 + t * boss.omega + j * Math.PI * 2 / boss.n;
    out.push({ x: c.x + Math.cos(a) * boss.R, depth: c.depth + Math.sin(a) * boss.R,
               r: boss.rockR, spin: 0.8 });
  }
  return out;
}
function meteorX(state, m) {
  return m.x + Math.sin(state.time * 0.75 + m.phase) * m.drift;
}
function shipDepthOf(state) { return state.depth + (ANCHOR_Y - state.ship.y); }
function screenY(state, depth) { return ANCHOR_Y - (depth - shipDepthOf(state)); }

var ACTIVITY_MIN = 50;         /* px of recent flight that counts as "flying" */

var STEP_EVENTS = [];
function stepRun(state, input, dt) {
  STEP_EVENTS.length = 0;
  if (state.done) return STEP_EVENTS;
  var ev = function (e) { STEP_EVENTS.push(e); };
  state.time += dt;
  var s = state.ship;

  /* Direct control (FD-035): velocity IS the input. No momentum,
     no drag, no wind — the position is the player's, exactly. */
  var px0 = s.x, py0 = s.y;
  s.vx = input.x * SHIP_VX;
  s.vy = input.y * SHIP_VY;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  if (s.x < 22) s.x = 22;
  if (s.x > W - 22) s.x = W - 22;
  if (s.y < 92) s.y = 92;
  if (s.y > H - 64) s.y = H - 64;
  /* anti-camping bookkeeping: how much the ship actually moved
     under its pilot in roughly the last second */
  var moved = Math.sqrt((s.x - px0) * (s.x - px0) + (s.y - py0) * (s.y - py0));
  state.recentMove = state.recentMove * Math.pow(0.5, dt / 0.9) + moved;

  /* forward speed: the ramp's scroll at this depth, and nothing
     else (v1.2 — the height throttle is gone: wherever the ship
     sits on screen, the lane runs at exactly this rate). Depth
     itself pays nothing; the score is earned by flying (§ scoring
     in the beacon and meteor passes below). */
  state.depth += scrollAt(state.depth) * dt;
  var sd = shipDepthOf(state);

  if (state.invulnT > 0) state.invulnT -= dt;
  ensureChunks(state); collectEndless(state);

  /* ---- bosses: warning,Orbit satellites, survival bonus ---- */
  var nb = bossOf(state, state.nextBoss);
  if (nb) {
    if (state.bossWarned < state.nextBoss && nb.start - sd < 2000 && nb.start > sd) {
      state.bossWarned = state.nextBoss;
      ev({ type: "bossAhead", idx: state.nextBoss, name: nb.name });
    }
    if (sd >= nb.end) {
      var gained = bossBonus(state.nextBoss);
      state.raw += gained;
      state.bosses += 1;
      ev({ type: "bossClear", idx: state.nextBoss, name: nb.name, gained: gained });
      state.nextBoss += 1;
    }
  }
  var orbitHit = null;
  if (nb && nb.pattern === 1 && sd > nb.start - 400 && sd < nb.end + 400) {
    var orocks = orbitRocks(state, nb);
    for (var oi = 0; oi < orocks.length; oi++) {
      var orock = orocks[oi];
      var orel = orock.depth - sd;
      if (orel < -80 || orel > 300) continue;
      var odx = orock.x - s.x, ody = screenY(state, orock.depth) - s.y;
      if (state.invulnT <= 0 && odx * odx + ody * ody < (orock.r + SHIP_R - 2) * (orock.r + SHIP_R - 2)) {
        orbitHit = { x: orock.x, y: screenY(state, orock.depth) };
        break;
      }
    }
  }

  /* ---- beacons ---- */
  var beacons = state.beacons;
  for (var bi = 0; bi < beacons.length; bi++) {
    var b = beacons[bi];
    if (b.done) continue;
    var by = screenY(state, b.depth);
    if (by < -140) {                       /* passed by, undelivered */
      if (sd - b.depth > 130) {
        b.done = "missed";
        if (state.chain > 0) { state.chain = 0; ev({ type: "chainLost", why: "missed" }); }
        ev({ type: "beaconMissed", idx: bi });
      }
      continue;
    }
    if (by > H + 140) continue;
    var bdx = b.x - s.x, bdy = by - s.y;
    /* v1.4: passing through the ring is the delivery — the v1.2
       activity gate is gone from this check. It denied exactly the
       pass it should reward: a pilot who lines up early and coasts
       the last stretch arrives centred with recentMove decayed to
       nothing, and the ring passed unclaimed (owner's live-play
       report). Camping stays dead on the closure's other two legs:
       depth pays nothing, and beacons sit 70–150 px off the safe
       centre line, so a parked ship can only collect a beacon that
       drifts onto its exact spot — in traffic that kills parked
       ships in seconds (hover suite, verify §7, re-proven for
       v1.4). The near-miss gate further down is unchanged. */
    if (bdx * bdx + bdy * bdy < CAPTURE_R * CAPTURE_R) {
      b.done = "delivered";
      state.chain += 1;
      if (state.chain > state.bestChain) state.bestChain = state.chain;
      state.deliveries += 1;
      var mult = 1 + 0.25 * Math.min(state.chain - 1, 12);
      var gained2 = Math.round(100 * mult);
      var swift = (state.time - state.lastDeliveryT) <= 6.5 && state.deliveries > 1;
      if (swift) gained2 += 30;
      state.lastDeliveryT = state.time;
      state.raw += gained2;
      ev({ type: "delivered", idx: bi, chain: state.chain, mult: mult, gained: gained2, swift: swift, x: b.x, y: by });
    }
  }

  /* ---- meteors ---- */
  function registerHit(hx, hy) {
    state.integrity -= HIT_DAMAGE;
    state.hits += 1;
    if (state.chain > 0) { state.chain = 0; ev({ type: "chainLost", why: "hit" }); }
    state.invulnT = 1.25;
    ev({ type: "hit", x: hx, y: hy, integrity: state.integrity });
    if (state.integrity <= 0) {
      state.integrity = 0; state.done = true; state.cleared = false;
      ev({ type: "failed", why: "parcel" });
    }
  }
  if (orbitHit && !state.done) registerHit(orbitHit.x, orbitHit.y);
  var meteors = state.meteors;
  for (var mi = 0; mi < meteors.length && !state.done; mi++) {
    var m = meteors[mi];
    if (m.dead) continue;
    var rel = m.depth - sd;
    if (rel < -320) {                       /* fully behind: settle near-miss */
      if (!m.settled) {
        m.settled = true;
        /* near-miss credit only for a pass the pilot actually flew
           (v1.2): activePass is set below, at closest approach, if
           the ship was flying then. A rock drifting past a parked
           ship settles silently. */
        if (!m.hit && m.activePass && m.minDist != null && m.minDist < m.r + SHIP_R + NEAR_R) {
          state.nearMisses += 1; state.raw += 25;
          ev({ type: "nearMiss", gained: 25, x: meteorX(state, m), y: screenY(state, m.depth) });
        }
      }
      continue;
    }
    if (rel > 900) continue;
    var mx = meteorX(state, m), my = screenY(state, m.depth);
    var dx = mx - s.x, dy = my - s.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (m.minDist == null || dist < m.minDist) m.minDist = dist;
    if (dist < m.r + SHIP_R + NEAR_R && state.recentMove >= ACTIVITY_MIN) m.activePass = true;
    if (state.invulnT <= 0 && dist < m.r + SHIP_R - 2) {
      m.hit = true; m.dead = true;
      registerHit(mx, my);
    }
  }
  return STEP_EVENTS;
}

function finalScore(state) { return Math.round(state.raw); }
/* Rebuild a run state revived from JSON (the persistence snapshot):
   the working lists are re-collected from their chunks, whose
   objects carry the delivery/death flags. Boss state (nextBoss,
   bossWarned) is plain data and revives with the state. */
function reviveRun(state) {
  if (state.recentMove == null) state.recentMove = 0;   /* snapshots predating the field */
  ensureChunks(state); collectEndless(state);
  return state;
}
function nextBeacon(state) {
  var bs = state.beacons, sd = shipDepthOf(state);
  for (var i = 0; i < bs.length; i++) {
    if (!bs[i].done && bs[i].depth > sd - 130) return bs[i];
  }
  return null;
}
/* Read-only snapshot for the presentation layer + test drivers. */
function snapshot(state) {
  var sd = shipDepthOf(state);
  var nb2 = nextBeacon(state);
  var boss = bossOf(state, state.nextBoss);
  var near = [], ms = state.meteors;
  for (var i = 0; i < ms.length; i++) {
    var m = ms[i];
    if (m.dead) continue;
    var rel = m.depth - sd;
    /* Render window (v1.2 parity fix, FD-037): this list IS what
       the page draws, so it must contain every rock the collision
       pass can touch. Collisions are evaluated for rel in
       [-320, 900]; the window here is wider on both ends, so a
       rock is drawn until it is fully past the bottom of the
       screen (rel -380 → screen y 812, below the 720 field with
       its whole radius) and beyond collision reach (the lowest a
       ship can sit is y 656; a rock centred at 752+ can no longer
       touch it). In v1.1 this window stopped at rel -60 — rocks
       vanished at screen y 492 and stayed lethal for another
       260 px of travel. That was the invisible-asteroid bug. */
    if (rel < -380 || rel > 940) continue;
    near.push({ x: meteorX(state, m), y: screenY(state, m.depth), r: m.r, depth: m.depth,
                baseX: m.x, drift: m.drift, phase: m.phase, spin: m.spin });
  }
  if (boss && boss.pattern === 1 && sd > boss.start - 1200 && sd < boss.end + 400) {
    var orocks2 = orbitRocks(state, boss);
    for (var j = 0; j < orocks2.length; j++) {
      var or2 = orocks2[j];
      var rel2 = or2.depth - sd;
      if (rel2 < -380 || rel2 > 940) continue;   /* same render window as the field (v1.2 parity) */
      near.push({ x: or2.x, y: screenY(state, or2.depth), r: or2.r, depth: Math.round(or2.depth),
                  baseX: or2.x, drift: 0, phase: 0, spin: or2.spin });
    }
  }
  return {
    time: state.time,
    x: state.ship.x, y: state.ship.y, vx: state.ship.vx, vy: state.ship.vy,
    depth: Math.round(state.depth), shipDepth: Math.round(sd),
    integrity: state.integrity, chain: state.chain, raw: Math.round(state.raw),
    deliveries: state.deliveries, done: state.done, cleared: state.cleared,
    bosses: state.bosses,
    bossAhead: boss && sd < boss.end ? { name: boss.name, inPx: Math.max(0, Math.round(boss.start - sd)), active: sd >= boss.start } : null,
    nextBeacon: nb2 ? { x: nb2.x, y: screenY(state, nb2.depth), depth: nb2.depth } : null,
    meteors: near,
    progress: null
  };
}

var api = {
  W: W, H: H, ANCHOR_Y: ANCHOR_Y, SHIP_R: SHIP_R, SHIP_VX: SHIP_VX, SHIP_VY: SHIP_VY,
  CHUNK: CHUNK, SEED: SEED,
  BOSS_FIRST: BOSS_FIRST, BOSS_EVERY: BOSS_EVERY, BOSS_NAMES: BOSS_NAMES, bossBonus: bossBonus,
  bossIndexForChunk: bossIndexForChunk, buildBoss: buildBoss,
  MEDAL_MARKS: MEDAL_MARKS,
  fnv1a: fnv1a, mulberry32: mulberry32, chunkHash: chunkHash,
  generateChunk: generateChunk, paramsAt: paramsAt,
  scrollAt: scrollAt, gapAt: gapAt, extraAt: extraAt, driftAt: driftAt, halfWAt: halfWAt,
  corridorCenter: corridorCenter, seedPhases: seedPhases,
  createRun: createRun, stepRun: stepRun, finalScore: finalScore, reviveRun: reviveRun,
  medalForRun: medalForRun, snapshot: snapshot, meteorX: meteorX,
  orbitCenter: orbitCenter, orbitRocks: orbitRocks,
  screenY: screenY, shipDepthOf: shipDepthOf
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
global.StarfallCore = api;
})(typeof window !== "undefined" ? window : globalThis);
