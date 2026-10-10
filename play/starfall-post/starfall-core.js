/* Starfall Post — core logic. Lane generation, physics, collisions,
   scoring. Pure functions only: no DOM, no rendering, no Math.random.
   The same file runs in the browser (window.StarfallCore) and in Node
   (module.exports) so the gate's proofs exercise the shipped logic. */
(function (global) {
"use strict";

/* ---------------- field + ship constants ---------------- */
var W = 480, H = 720;
var ANCHOR_Y = 432;            /* screen line the ship's depth sits on */
var SHIP_R = 13;
var HIT_DAMAGE = 20;           /* parcel integrity lost per meteor hit */
var ACCEL = 1650;              /* px/s^2 from full thrust */
var MAX_VX = 305, MAX_VY = 215;
var DRAG = 2.7;                /* exponential velocity damping /s */
var CAPTURE_R = 58;            /* beacon delivery radius (screen px) */
var NEAR_R = 17;               /* extra px beyond touching = near miss */

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
function laneHash(lane) {
  /* Stable fingerprint of a generated lane, for the determinism proof. */
  var h = fnv1a(lane.seed + "|" + lane.length);
  function mix(n) { h ^= (n + 0x9e3779b9) & 0xffffffff; h = Math.imul(h, 0x01000193); }
  lane.beacons.forEach(function (b) { mix(Math.round(b.depth)); mix(Math.round(b.x * 10)); });
  lane.meteors.forEach(function (m) {
    mix(Math.round(m.depth)); mix(Math.round(m.x * 10)); mix(Math.round(m.r * 10));
    mix(Math.round(m.drift * 10)); mix(Math.round(m.phase * 100));
  });
  return ("0000000" + (h >>> 0).toString(16)).slice(-8);
}

/* ---------------- districts (the campaign) ---------------- */
/* length/scroll give the nominal run time length/scroll seconds.
   gap = depth between meteor rows; drift = sideways sway amplitude;
   wind = lateral gust acceleration at its peak. */
var DISTRICTS = [
  { name: "First Run",     length: 26350, scroll: 150, beacons: 6,  gap: 150, drift: 8,  wind: 0,  extra: 0.15 },
  { name: "The Narrows",   length: 32300, scroll: 160, beacons: 7,  gap: 138, drift: 14, wind: 8,  extra: 0.22 },
  { name: "Ember Drift",   length: 36550, scroll: 170, beacons: 8,  gap: 128, drift: 22, wind: 12, extra: 0.30 },
  { name: "Crosswinds",    length: 40800, scroll: 180, beacons: 9,  gap: 118, drift: 28, wind: 30, extra: 0.38 },
  { name: "The Belt",      length: 45050, scroll: 190, beacons: 10, gap: 110, drift: 34, wind: 34, extra: 0.46 },
  { name: "Night Freight", length: 49300, scroll: 200, beacons: 11, gap: 102, drift: 40, wind: 40, extra: 0.50 },
  { name: "Storm Line",    length: 53550, scroll: 210, beacons: 12, gap: 98,  drift: 40, wind: 42, extra: 0.50 },
  { name: "Starfall Depot",length: 56950, scroll: 220, beacons: 13, gap: 93,  drift: 42, wind: 50, extra: 0.60 }
];
/* Medal thresholds on raw (pre-multiplier) score, calibrated against
   the policy-bot measurements in evidence/verify-starfall.js and
   recorded in the gate report. */
var MEDALS = [
  { bronze: 950,  silver: 1350, gold: 1750 },
  { bronze: 1100, silver: 1550, gold: 2050 },
  { bronze: 1250, silver: 1750, gold: 2300 },
  { bronze: 1425, silver: 2000, gold: 2625 },
  { bronze: 1600, silver: 2250, gold: 2950 },
  { bronze: 1775, silver: 2500, gold: 3300 },
  { bronze: 2000, silver: 2825, gold: 3700 },
  { bronze: 2200, silver: 3125, gold: 4075 }
];
function medalFor(districtIdx, raw, integrity, bestChain, deliveries) {
  var t = MEDALS[districtIdx];
  if (!t) return "none";
  if (raw >= t.gold && integrity >= 75 && bestChain >= Math.ceil(deliveries * 0.6)) return "wren";
  if (raw >= t.gold) return "gold";
  if (raw >= t.silver) return "silver";
  if (raw >= t.bronze) return "bronze";
  return "none";
}

/* ---------------- lane generation ----------------
   A lane is fully determined by its seed string. The safe corridor
   is an explicit analytic function of depth,
     centre(depth) = 240 + 118*sin(depth/2650 + p1) + 58*sin(depth/940 + p2)
   with p1/p2 drawn from the seed. Rocks are placed so that even at
   the extreme of their sideways sway their edge never enters
   [centre-halfW, centre+halfW], and beacons sit near the corridor
   line inside rock-free bubbles. A passable channel therefore
   exists at every depth by construction; the verifier asserts it
   depth by depth, and the bot additionally flies it. */
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
    var count = 1 + (rng() < opts.extra ? 1 : 0) + (rng() < opts.extra * 0.35 ? 1 : 0);
    for (var k = 0; k < count; k++) {
      var r = 10 + Math.pow(rng(), 1.6) * 15;   /* 10..25, small ones common */
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

function generateLane(seedStr, districtIdx) {
  var d = DISTRICTS[districtIdx];
  var rng = mulberry32(fnv1a(seedStr));
  var ph = seedPhases(seedStr);
  var halfW = Math.max(74, 88 - districtIdx * 2);
  var field = buildField(rng, {
    gap: d.gap, drift: d.drift, extra: d.extra, halfW: halfW
  }, 0, d.length, ph);
  /* beacons: one per stretch, close to the corridor line so the
     delivery route follows the safe channel with small excursions */
  var beacons = [];
  for (var i = 0; i < d.beacons; i++) {
    var bd = d.length * (i + 0.62) / (d.beacons + 0.24) + (rng() - 0.5) * 700;
    var bx = corridorCenter(ph, bd) + (rng() - 0.5) * 170;
    if (bx < 56) bx = 56; if (bx > W - 56) bx = W - 56;
    beacons.push({ depth: Math.round(bd), x: Math.round(bx) });
  }
  clearBubbles(field.meteors, beacons);
  return { seed: seedStr, district: districtIdx, length: d.length, scroll: d.scroll,
           wind: d.wind, halfW: halfW, p1: ph.p1, p2: ph.p2,
           beacons: beacons, meteors: field.meteors };
}

function clearBubbles(meteors, beacons) {
  for (var i = meteors.length - 1; i >= 0; i--) {
    var m = meteors[i], drop = false;
    for (var j = 0; j < beacons.length; j++) {
      var b = beacons[j];
      if (Math.abs(m.depth - b.depth) < 210 && Math.abs(m.x - b.x) < 105 + m.r) { drop = true; break; }
    }
    if (drop) meteors.splice(i, 1);
  }
}

/* Endless lanes (free play + today's seed): generated in 6000px
   chunks, each chunk a pure function of (seed, chunkIndex). */
var CHUNK = 6000;
var ENDLESS = { gap: 106, drift: 30, extra: 0.44, halfW: 76, wind: 24 };
function generateChunk(seedStr, idx) {
  var rng = mulberry32(fnv1a(seedStr + ":chunk:" + idx));
  var ph = seedPhases(seedStr);   /* lane-level phases: the corridor is
                                     one continuous curve across chunks */
  var from = idx * CHUNK, to = from + CHUNK;
  var field = buildField(rng, ENDLESS, from, to, ph);
  var beacons = [];
  var nb = 2;
  for (var i = 0; i < nb; i++) {
    var bd = from + (i + 0.5) * CHUNK / nb + (rng() - 0.5) * 800;
    var bx = corridorCenter(ph, bd) + (rng() - 0.5) * 170;
    if (bx < 56) bx = 56; if (bx > W - 56) bx = W - 56;
    beacons.push({ depth: Math.round(bd), x: Math.round(bx) });
  }
  clearBubbles(field.meteors, beacons);
  return { meteors: field.meteors, beacons: beacons };
}
function endlessScroll(depth) { return Math.min(242, 170 + depth * 0.0023); }

/* ---------------- run state + simulation ---------------- */
function createRun(lane, mods) {
  mods = mods || {};
  var state = {
    lane: lane, endless: !!lane.endless,
    mods: { noBrake: !!mods.noBrake, storm: !!mods.storm },
    time: 0, depth: 0,
    ship: { x: W / 2, y: ANCHOR_Y + 60, vx: 0, vy: 0 },
    integrity: 100, invulnT: 0,
    chain: 0, bestChain: 0, lastDeliveryT: -99,
    deliveries: 0, nearMisses: 0, hits: 0,
    raw: 0, done: false, cleared: false,
    chunks: {}, nextBeaconIdx: 0,
    startedAt: null
  };
  if (state.endless) { ensureChunks(state); collectEndless(state); }
  return state;
}
function scoreMult(state) {
  var m = 1;
  if (state.mods.noBrake) m *= 1.5;
  if (state.mods.storm) m *= 1.5;
  return m;
}
function driftScale(state) { return state.mods.storm ? 1.8 : 1; }
function windAmp(state) {
  var base = state.endless ? ENDLESS.wind : state.lane.wind;
  return base * (state.mods.storm ? 1.6 : 1);
}
function ensureChunks(state) {
  var need = Math.floor((state.depth + 2400) / CHUNK);
  for (var i = 0; i <= need; i++) {
    if (!state.chunks[i]) state.chunks[i] = generateChunk(state.lane.seed, i);
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
function laneMeteors(state) { return state.endless ? state.meteors : state.lane.meteors; }
function laneBeacons(state) { return state.endless ? state.beacons : state.lane.beacons; }
function meteorX(state, m) {
  return m.x + Math.sin(state.time * 0.75 + m.phase) * m.drift * driftScale(state);
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

  /* wind gusts: a slow sine along the depth, seeded by the lane */
  var windPhase = state.endless ? 0.7 : (fnv1a(state.lane.seed) % 628) / 100;
  var wind = windAmp(state) * Math.sin(state.depth / 700 + windPhase);
  s.vx += (input.x * ACCEL + wind) * dt;
  s.vy += input.y * ACCEL * dt;
  var damp = Math.exp(-DRAG * dt);
  s.vx *= damp; s.vy *= damp;
  if (s.vx > MAX_VX) s.vx = MAX_VX; else if (s.vx < -MAX_VX) s.vx = -MAX_VX;
  if (s.vy > MAX_VY) s.vy = MAX_VY; else if (s.vy < -MAX_VY) s.vy = -MAX_VY;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  if (s.x < 22) { s.x = 22; s.vx = Math.max(0, s.vx); }
  if (s.x > W - 22) { s.x = W - 22; s.vx = Math.min(0, s.vx); }
  if (s.y < 92) { s.y = 92; s.vy = Math.max(0, s.vy); }
  if (s.y > H - 64) { s.y = H - 64; s.vy = Math.min(0, s.vy); }

  /* forward speed: base scroll, faster flown high, slower flown low */
  var factor = 1 + (ANCHOR_Y - s.y) / ANCHOR_Y * 0.35;
  if (state.mods.noBrake) factor = Math.max(factor, 1.12);
  var base = state.endless ? endlessScroll(state.depth) : state.lane.scroll;
  if (state.mods.noBrake) base *= 1.15;
  state.depth += base * factor * dt;
  var sd = shipDepthOf(state);

  if (state.invulnT > 0) state.invulnT -= dt;
  if (state.endless) { ensureChunks(state); collectEndless(state); }

  /* ---- beacons ---- */
  var beacons = laneBeacons(state);
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
      var gained = Math.round(100 * mult);
      var swift = (state.time - state.lastDeliveryT) <= 6.5 && state.deliveries > 1;
      if (swift) gained += 30;
      state.lastDeliveryT = state.time;
      state.raw += gained;
      ev({ type: "delivered", idx: bi, chain: state.chain, mult: mult, gained: gained, swift: swift, x: b.x, y: by });
    }
  }

  /* ---- meteors ---- */
  var meteors = laneMeteors(state);
  for (var mi = 0; mi < meteors.length; mi++) {
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
      state.integrity -= HIT_DAMAGE;
      state.hits += 1;
      if (state.chain > 0) { state.chain = 0; ev({ type: "chainLost", why: "hit" }); }
      state.invulnT = 1.25;
      ev({ type: "hit", x: mx, y: my, integrity: state.integrity });
      if (state.integrity <= 0) {
        state.integrity = 0; state.done = true; state.cleared = false;
        ev({ type: "failed", why: "parcel" });
        return STEP_EVENTS;
      }
    }
  }

  /* ---- depot / district end ---- */
  if (!state.endless && state.depth >= state.lane.length) {
    state.done = true; state.cleared = true;
    var bonus = 250 + state.integrity * 5;
    state.raw += bonus;
    ev({ type: "cleared", bonus: bonus });
  }
  return STEP_EVENTS;
}

function finalScore(state) { return Math.round(state.raw * scoreMult(state)); }
/* Rebuild a run state revived from JSON (the persistence snapshot):
   endless working lists are re-collected from their chunks, whose
   objects carry the delivery/death flags. District states revive
   as they are — a lane is pure data. */
function reviveRun(state) {
  if (state.endless) { ensureChunks(state); collectEndless(state); }
  return state;
}
function nextBeacon(state) {
  var bs = laneBeacons(state), sd = shipDepthOf(state);
  for (var i = 0; i < bs.length; i++) {
    if (!bs[i].done && bs[i].depth > sd - 130) return bs[i];
  }
  return null;
}
/* Read-only snapshot for the presentation layer + test drivers. */
function snapshot(state) {
  var sd = shipDepthOf(state);
  var nb = nextBeacon(state);
  var near = [], ms = laneMeteors(state);
  for (var i = 0; i < ms.length; i++) {
    var m = ms[i];
    if (m.dead) continue;
    var rel = m.depth - sd;
    if (rel < -60 || rel > 900) continue;
    near.push({ x: meteorX(state, m), y: screenY(state, m.depth), r: m.r, depth: m.depth,
                baseX: m.x, drift: m.drift * driftScale(state), phase: m.phase, spin: m.spin });
  }
  return {
    time: state.time,
    x: state.ship.x, y: state.ship.y, vx: state.ship.vx, vy: state.ship.vy,
    depth: Math.round(state.depth), shipDepth: Math.round(sd),
    integrity: state.integrity, chain: state.chain, raw: state.raw,
    deliveries: state.deliveries, done: state.done, cleared: state.cleared,
    nextBeacon: nb ? { x: nb.x, y: screenY(state, nb.depth), depth: nb.depth } : null,
    meteors: near,
    progress: state.endless ? null : Math.min(1, state.depth / state.lane.length)
  };
}

var api = {
  W: W, H: H, ANCHOR_Y: ANCHOR_Y, SHIP_R: SHIP_R, CHUNK: CHUNK,
  DISTRICTS: DISTRICTS, MEDALS: MEDALS, ENDLESS: ENDLESS,
  fnv1a: fnv1a, mulberry32: mulberry32, laneHash: laneHash,
  generateLane: generateLane, generateChunk: generateChunk,
  corridorCenter: corridorCenter, seedPhases: seedPhases,
  createRun: createRun, stepRun: stepRun, finalScore: finalScore, reviveRun: reviveRun,
  medalFor: medalFor, snapshot: snapshot, meteorX: meteorX,
  screenY: screenY, shipDepthOf: shipDepthOf, endlessScroll: endlessScroll
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
global.StarfallCore = api;
})(typeof window !== "undefined" ? window : globalThis);
