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
   The district campaign, the daily lane and the modifiers are gone. */
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
var DEPTH_POINTS = 0.05;       /* score per px flown: 1 point per 20 px */

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
   together from a gentle opening to a hard plateau reached at
   roughly 60,000 px (about five minutes into a surviving run) and
   sustained from there — the lane never gets easier again, and the
   corridor guarantee (§ lane generation) holds at every depth, so
   the limit on a run is always the pilot, never the geometry.
   On top of the ramp sit the mini-bosses (§ below): the first at
   24,000 px, then one every 30,000 px. */
function scrollAt(d) { return Math.min(250, 158 + d * 0.0016); }
function gapAt(d)    { return Math.max(52, 118 - d * 0.0011); }
function extraAt(d)  { return Math.min(0.92, 0.34 + d * 0.000010); }
function driftAt(d)  { return Math.min(72, 16 + d * 0.00095); }
function halfWAt(d)  { return Math.max(62, 82 - d * 0.00033); }
function paramsAt(d) {
  return { scroll: scrollAt(d), gap: gapAt(d), extra: extraAt(d),
           drift: driftAt(d), halfW: halfWAt(d) };
}

/* ---------------- medals (best-run achievements) ----------------
   A run earns the highest medal whose BOTH marks it reaches: depth
   in px and deliveries. Calibrated from the policy-bot death
   distribution and the cold playtest (see the v1.1 report): bronze
   is a learner's good first run, Wren is a deep-lane feat that also
   demands a long unbroken chain. */
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
    var count = 1 + (rng() < opts.extra ? 1 : 0) + (rng() < opts.extra * 0.35 ? 1 : 0) + (rng() < opts.extra * 0.15 ? 1 : 0);
    for (var k = 0; k < count; k++) {
      var r = 10 + Math.pow(rng(), 1.6) * 18;   /* 10..28, small ones common */
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
   every 30,000 px — each anchored at a chunk start, each wholly
   inside its chunk, with a clear approach stretch before it (the
   telegraph: the pattern is seen entering, never an instant kill;
   the presentation adds a warning as it nears). Three patterns
   cycle by boss index k (pattern = k mod 3); every return of a
   pattern is one escalation tier up (tier = floor(k/3)): gaps
   narrow, rings gain satellites and spin faster. Surviving a boss
   (flying past its end) pays 300 + 100 × tier.

   0 · THE GATES — a run of rock walls, one gap each; the gap walks
       along a seeded path in steps the ship can always make.
   1 · THE ORBIT — a huge boulder with satellites circling it. The
       ring never reaches the field's edges: the outside is always
       open, and the ring's own spacing can be threaded.
   2 · THE SLALOM — walls whose gaps alternate far left / far right,
       forcing full crossings on a clock the ship can always meet.
   The verifier asserts each pattern's channel numerically. */
var BOSS_FIRST = 24000, BOSS_EVERY = 30000;
var BOSS_NAMES = ["The Gates", "The Orbit", "The Slalom"];
function bossIndexForChunk(ci) {
  var start = ci * CHUNK;
  if (start < BOSS_FIRST || (start - BOSS_FIRST) % BOSS_EVERY !== 0) return -1;
  return (start - BOSS_FIRST) / BOSS_EVERY;
}
function bossBonus(k) { return 300 + 100 * Math.floor(k / 3); }

function wallRocks(depth, gapC, gapW, seedI0) {
  /* One solid row of anchored rock across the field except the gap.
     Rocks are r=15 spaced 23 px apart (overlapping — no through-hole),
     and a rock is omitted only if it would narrow the gap. */
  var out = [];
  for (var x = 15; x <= W - 15; x += 23) {
    if (Math.abs(x - gapC) < gapW / 2 + 7) continue;
    out.push({ depth: depth, x: x, r: 15, drift: 0, phase: 0,
               spin: 0.35, seedI: seedI0 + out.length });
  }
  return out;
}
function buildBoss(k, rng) {
  var start = BOSS_FIRST + k * BOSS_EVERY;
  var pattern = k % 3, tier = Math.floor(k / 3);
  var meteors = [], boss = null, end;
  if (pattern === 0) {                                   /* The Gates */
    var gapW = Math.max(150, 260 - 30 * tier);
    var walls = 6, spacing = 700, first = start + 900;
    var c = 240 + (rng() - 0.5) * 120, prev = c;
    for (var i = 0; i < walls; i++) {
      var step = (rng() - 0.5) * 480;
      c = Math.max(gapW / 2 + 20, Math.min(W - gapW / 2 - 20, prev + step));
      meteors = meteors.concat(wallRocks(first + i * spacing, c, gapW, 1000 + i * 40));
      prev = c;
    }
    end = first + walls * spacing;
    boss = { pattern: 0, name: BOSS_NAMES[0], start: start, end: end, tier: tier,
             gapW: gapW, spacing: spacing, walls: walls };
  } else if (pattern === 1) {                            /* The Orbit */
    var n = Math.min(8, 5 + tier);
    var omega = Math.min(0.7, 0.35 + 0.07 * tier);
    var cy = start + 2600;
    meteors.push({ depth: cy, x: W / 2, r: 46, drift: 0, phase: 0,
                   spin: 0.12, seedI: 2000 });
    boss = { pattern: 1, name: BOSS_NAMES[1], start: start, end: cy + 900, tier: tier,
             cx: W / 2, cyDepth: cy, R: 110, n: n, omega: omega,
             rockR: 15, phase0: rng() * Math.PI * 2 };
    end = boss.end;
  } else {                                               /* The Slalom */
    var gapW2 = Math.max(170, 240 - 25 * tier);
    var spacing2 = Math.max(475, 550 - 25 * tier);
    var walls2 = 8, first2 = start + 800;
    var amp = Math.min(150, (W - gapW2) / 2 - 30);
    for (var j = 0; j < walls2; j++) {
      var cc = W / 2 + (j % 2 === 0 ? -amp : amp) + (rng() - 0.5) * 24;
      meteors = meteors.concat(wallRocks(first2 + j * spacing2, cc, gapW2, 3000 + j * 40));
    }
    end = first2 + walls2 * spacing2;
    boss = { pattern: 2, name: BOSS_NAMES[2], start: start, end: end, tier: tier,
             gapW: gapW2, spacing: spacing2, walls: walls2 };
  }
  return { meteors: meteors, boss: boss };
}

/* One chunk of the canonical lane: a pure function of its index.
   Field parameters are sampled at the chunk's start depth (the
   ramp's steepest slope moves any parameter by less than 7 units
   across a chunk). A boss chunk holds the boss pattern and no
   beacons — the boss bonus replaces them. */
function generateChunk(idx) {
  var rng = mulberry32(fnv1a(SEED + ":chunk:" + idx));
  var ph = seedPhases(SEED);
  var from = idx * CHUNK, to = from + CHUNK;
  var bk = bossIndexForChunk(idx);
  if (bk >= 0) {
    var built = buildBoss(bk, rng);
    return { meteors: built.meteors, beacons: [], boss: built.boss };
  }
  var p = paramsAt(from);
  var field = buildField(rng, p, from, to, ph);
  var beacons = [];
  for (var i = 0; i < 2; i++) {
    var bd = from + (i + 0.5) * CHUNK / 2 + (rng() - 0.5) * 800;
    var bx = corridorCenter(ph, bd) + (rng() - 0.5) * 250;
    if (bx < 56) bx = 56; if (bx > W - 56) bx = W - 56;
    beacons.push({ depth: Math.round(bd), x: Math.round(bx) });
  }
  clearBubbles(field.meteors, beacons);
  return { meteors: field.meteors, beacons: beacons, boss: null };
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
  /* drop chunks far behind to bound memory */
  var keys = Object.keys(state.chunks);
  for (var k = 0; k < keys.length; k++) {
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
/* Current satellite positions of an Orbit boss: pure f(time). */
function orbitRocks(state, boss) {
  var out = [];
  for (var j = 0; j < boss.n; j++) {
    var a = boss.phase0 + state.time * boss.omega + j * Math.PI * 2 / boss.n;
    out.push({ x: boss.cx + Math.cos(a) * boss.R, depth: boss.cyDepth + Math.sin(a) * boss.R,
               r: boss.rockR, spin: 0.8 });
  }
  return out;
}
function meteorX(state, m) {
  return m.x + Math.sin(state.time * 0.75 + m.phase) * m.drift;
}
function shipDepthOf(state) { return state.depth + (ANCHOR_Y - state.ship.y); }
function screenY(state, depth) { return ANCHOR_Y - (depth - shipDepthOf(state)); }

var STEP_EVENTS = [];
function stepRun(state, input, dt) {
  STEP_EVENTS.length = 0;
  if (state.done) return STEP_EVENTS;
  var ev = function (e) { STEP_EVENTS.push(e); };
  state.time += dt;
  var s = state.ship;

  /* Direct control (FD-035): velocity IS the input. No momentum,
     no drag, no wind — the position is the player's, exactly. */
  s.vx = input.x * SHIP_VX;
  s.vy = input.y * SHIP_VY;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  if (s.x < 22) s.x = 22;
  if (s.x > W - 22) s.x = W - 22;
  if (s.y < 92) s.y = 92;
  if (s.y > H - 64) s.y = H - 64;

  /* forward speed: the ramp's scroll at this depth, faster flown
     high, slower flown low; depth itself pays a steady trickle */
  var factor = 1 + (ANCHOR_Y - s.y) / ANCHOR_Y * 0.35;
  var prevDepth = state.depth;
  state.depth += scrollAt(state.depth) * factor * dt;
  state.raw += (state.depth - prevDepth) * DEPTH_POINTS;
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
        if (!m.hit && m.minDist != null && m.minDist < m.r + SHIP_R + NEAR_R) {
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
  var near = [], ms = state.meteors;
  for (var i = 0; i < ms.length; i++) {
    var m = ms[i];
    if (m.dead) continue;
    var rel = m.depth - sd;
    if (rel < -60 || rel > 900) continue;
    near.push({ x: meteorX(state, m), y: screenY(state, m.depth), r: m.r, depth: m.depth,
                baseX: m.x, drift: m.drift, phase: m.phase, spin: m.spin });
  }
  var boss = bossOf(state, state.nextBoss);
  if (boss && boss.pattern === 1 && sd > boss.start - 1200 && sd < boss.end + 400) {
    var orocks2 = orbitRocks(state, boss);
    for (var j = 0; j < orocks2.length; j++) {
      var or2 = orocks2[j];
      var rel2 = or2.depth - sd;
      if (rel2 < -60 || rel2 > 900) continue;
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
  screenY: screenY, shipDepthOf: shipDepthOf
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
global.StarfallCore = api;
})(typeof window !== "undefined" ? window : globalThis);
