/* Glasshouse — pure game core (no DOM). Shared by the browser game
 * and the Node gate verifier, so what is proven offline is exactly
 * what ships.
 *
 * Rules of the greenhouse:
 *  - Light leaves a sun, water leaves a tap, each in one fixed direction.
 *  - Mirrors bend light 90 degrees. A mirror has two slants:
 *      slant 0 ( / ) : N->E, E->N, S->W, W->S
 *      slant 1 ( \ ) : N->W, E->S, S->E, W->N
 *  - Sluices bend water 90 degrees. A sluice has four orientations;
 *    orientation o joins sides o and o+1 (clockwise). Water entering
 *    from a joined side leaves by the other; from any other side it
 *    stops. Light stops at a sluice; water stops at a mirror; both
 *    stop at rocks, sources and the garden edge.
 *  - Seedlings are not sinks: a beam passes through, serving that
 *    seedling on the way. A seedling is fully served when every need
 *    it has (light, water, or both) has reached it.
 *  - Drought: water runs dry after DROUGHT_RANGE tiles of travel.
 *  - Tapping a piece rotates it: a mirror flips its slant (1 tap), a
 *    sluice turns 90 degrees clockwise (1 tap, four states).
 *
 * A garden: { id, name, w, h, cells, rots }
 *   cells: { "x,y": {t:"sun",dir} | {t:"tap",dir} | {t:"seed",need}
 *                  | {t:"rock"} }        need: "L" | "W" | "B"
 *   rots:  [ {x, y, kind:"mir"|"slu", start, sol} ]
 * A state is an array of numbers aligned with rots.
 */
(function () {
  "use strict";

  var DIRS = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]; // N E S W
  var MIRROR_MAP = [
    [1, 0, 3, 2], // slant / : N->E, E->N, S->W, W->S
    [3, 2, 1, 0]  // slant \ : N->W, E->S, S->E, W->N
  ];
  var DROUGHT_RANGE = 8;
  var NORMAL_RANGE = 100000;

  function key(x, y) { return x + "," + y; }

  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
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
  function rngFrom(seedStr) { return mulberry32(hashStr(String(seedStr))); }

  /* ---------- garden indexing ---------- */

  function seedList(g) {
    var out = [];
    for (var y = 0; y < g.h; y++) for (var x = 0; x < g.w; x++) {
      var c = g.cells[key(x, y)];
      if (c && c.t === "seed") out.push({ x: x, y: y, need: c.need, idx: out.length });
    }
    return out;
  }
  function rotIndex(g) {
    var m = {};
    g.rots.forEach(function (r, i) { m[key(r.x, r.y)] = i; });
    return m;
  }
  function startStates(g) { return g.rots.map(function (r) { return r.start; }); }
  function solutionStates(g) { return g.rots.map(function (r) { return r.sol; }); }
  function cycleOf(kind) { return kind === "mir" ? 2 : 4; }

  function tapsBetween(g, a, b) {
    var n = 0;
    for (var i = 0; i < g.rots.length; i++) {
      var c = cycleOf(g.rots[i].kind);
      n += (b[i] - a[i] + c * 8) % c;
    }
    return n;
  }

  /* ---------- beam simulation ---------- */

  function traceBeam(g, rIdx, states, kind, sx, sy, dir, maxLen) {
    var path = [[sx, sy]];
    var served = {}; // "x,y" -> true
    var visited = {};
    var x = sx, y = sy, d = dir, len = 0;
    while (true) {
      var nx = x + DIRS[d].x, ny = y + DIRS[d].y;
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) { path.push([nx, ny]); break; }
      len += 1;
      if (len > maxLen) break; // ran dry (drought) — beam stops where it is
      var vk = nx + "," + ny + "," + d;
      if (visited[vk]) break; // loop — beam dies
      visited[vk] = true;
      var cell = g.cells[key(nx, ny)];
      var ri = rIdx[key(nx, ny)];
      path.push([nx, ny]);
      if (cell && cell.t === "seed") { served[key(nx, ny)] = true; x = nx; y = ny; continue; }
      if (ri !== undefined) {
        var rot = g.rots[ri], st = states[ri];
        if (kind === "light" && rot.kind === "mir") { d = MIRROR_MAP[st][d]; x = nx; y = ny; continue; }
        if (kind === "water" && rot.kind === "slu") {
          var entry = (d + 2) % 4, o = st;
          if (entry === o || entry === (o + 1) % 4) {
            d = entry === o ? (o + 1) % 4 : o; // leave by the other joined side
            x = nx; y = ny; continue;
          }
          break;
        }
        break; // the other kind of piece blocks this beam
      }
      if (cell) break; // rock or a source blocks
      x = nx; y = ny;
    }
    return { path: path, served: served, length: len };
  }

  function simulate(g, states, opts) {
    opts = opts || {};
    var maxWater = opts.drought ? DROUGHT_RANGE : NORMAL_RANGE;
    var rIdx = rotIndex(g);
    var light = [], water = [];
    var lightServed = {}, waterServed = {};
    for (var y = 0; y < g.h; y++) for (var x = 0; x < g.w; x++) {
      var c = g.cells[key(x, y)];
      if (!c) continue;
      if (c.t === "sun") {
        var r1 = traceBeam(g, rIdx, states, "light", x, y, c.dir, NORMAL_RANGE);
        light.push(r1.path);
        for (var k1 in r1.served) lightServed[k1] = true;
      } else if (c.t === "tap") {
        var r2 = traceBeam(g, rIdx, states, "water", x, y, c.dir, maxWater);
        water.push(r2.path);
        for (var k2 in r2.served) waterServed[k2] = true;
      }
    }
    return { lightPaths: light, waterPaths: water, lightServed: lightServed, waterServed: waterServed };
  }

  function evaluate(g, states, opts) {
    var sim = simulate(g, states, opts);
    var seeds = seedList(g);
    var detail = seeds.map(function (s) {
      var k = key(s.x, s.y);
      var hasLight = !!sim.lightServed[k], hasWater = !!sim.waterServed[k];
      var ok = (s.need === "L" && hasLight) || (s.need === "W" && hasWater) ||
               (s.need === "B" && hasLight && hasWater);
      return { x: s.x, y: s.y, need: s.need, light: hasLight, water: hasWater, ok: ok };
    });
    return {
      seeds: detail,
      solved: detail.every(function (s) { return s.ok; }),
      sim: sim
    };
  }

  /* ---------- solver: BFS over rotation states ---------- */

  function solve(g, opts) {
    opts = opts || {};
    var cap = opts.cap || 250000;
    var start = startStates(g);
    if (evaluate(g, start, opts).solved) return { taps: 0, states: start.slice() };
    var seen = {}; seen[start.join(",")] = true;
    var queue = [{ s: start, d: 0 }];
    var head = 0, explored = 0;
    while (head < queue.length) {
      var cur = queue[head++];
      explored++;
      if (explored > cap) return null;
      for (var i = 0; i < g.rots.length; i++) {
        var ns = cur.s.slice();
        ns[i] = (ns[i] + 1) % cycleOf(g.rots[i].kind);
        var k = ns.join(",");
        if (seen[k]) continue;
        seen[k] = true;
        if (evaluate(g, ns, opts).solved) return { taps: cur.d + 1, states: ns };
        queue.push({ s: ns, d: cur.d + 1 });
      }
    }
    return null;
  }

  function verifyGarden(g) {
    var sol = solutionStates(g);
    var atSolution = evaluate(g, sol, {}).solved;
    var atSolutionDrought = evaluate(g, sol, { drought: true }).solved;
    var atStart = evaluate(g, startStates(g), {}).solved;
    var bfs = solve(g, {});
    var bfsDrought = solve(g, { drought: true });
    return {
      solutionWorks: atSolution,
      solutionWorksInDrought: atSolutionDrought,
      startUnsolved: !atStart,
      par: bfs ? bfs.taps : null,
      parStates: bfs ? bfs.states : null,
      droughtPar: bfsDrought ? bfsDrought.taps : null,
      declaredTaps: tapsBetween(g, startStates(g), sol)
    };
  }

  /* ---------- the hand-set season ---------- */

  function G(id, name, w, h, cells, rots, intro) {
    return { id: id, name: name, w: w, h: h, cells: cells, rots: rots, intro: intro, par: null };
  }
  function C(spec) {
    var cells = {};
    Object.keys(spec).forEach(function (k) {
      var v = spec[k];
      if (v === "rock") cells[k] = { t: "rock" };
      else if (v[0] === "S") cells[k] = { t: "sun", dir: +v.slice(1) };
      else if (v[0] === "T") cells[k] = { t: "tap", dir: +v.slice(1) };
      else if (v[0] === "s") cells[k] = { t: "seed", need: v.slice(1) };
    });
    return cells;
  }
  function R(spec) {
    return spec.map(function (a) {
      return { x: a[0], y: a[1], kind: a[2], start: a[3], sol: a[4] };
    });
  }
  // Directions in cell specs: 0=N, 1=E, 2=S, 3=W. "S1" = sun facing E.
  var GARDENS = [
    G("g01", "First Light", 5, 5,
      C({ "0,2": "S1", "3,4": "sL" }),
      R([[3, 2, "mir", 0, 1]]),
      "One sun, one mirror, one seedling. Tap the mirror to turn the light."),
    G("g02", "First Water", 5, 5,
      C({ "2,0": "T2", "0,3": "sW" }),
      R([[2, 3, "slu", 2, 3]]),
      "A sluice turns water around a corner. Tap it to rotate the elbow."),
    G("g03", "Sun and Rain", 5, 5,
      C({ "0,0": "S1", "0,4": "T1", "2,2": "sB" }),
      R([[2, 0, "mir", 0, 1], [2, 4, "slu", 1, 3]]),
      "This seedling wants both: light from above, water from below."),
    G("g04", "Around the Pots", 5, 6,
      C({ "0,3": "S1", "2,2": "rock", "1,3": "sL", "4,5": "sL" }),
      R([[2, 3, "mir", 0, 1], [2, 5, "mir", 0, 1]]),
      "Pots block the straight road. Bend the light twice."),
    G("g05", "The Long Drink", 6, 5,
      C({ "0,2": "T1", "3,4": "sW", "4,4": "sW" }),
      R([[2, 2, "slu", 0, 2], [2, 4, "slu", 1, 0]]),
      "One tap, two seedlings — water passes through the first to reach the second."),
    G("g06", "Crossing", 6, 6,
      C({ "0,0": "S1", "0,5": "T1", "3,3": "sB", "4,3": "sW", "3,5": "sL" }),
      R([[3, 0, "mir", 0, 1], [1, 5, "slu", 0, 3], [1, 3, "slu", 2, 1]]),
      "Light and water cross in the middle seedling, which wants both."),
    G("g07", "The S-Curve", 6, 6,
      C({ "0,0": "S1", "2,0": "sL", "4,2": "sL", "2,4": "sL", "0,4": "sL", "5,5": "T0", "5,3": "sW", "5,1": "sW" }),
      R([[4, 0, "mir", 0, 1], [4, 4, "mir", 1, 0], [1, 2, "mir", 0, 0]]),
      "One beam can feed a whole row. The spare mirror is a decoy — not every piece matters."),
    G("g08", "The Water Maze", 7, 6,
      C({ "0,0": "T2", "3,2": "rock", "5,2": "rock", "2,3": "sW", "3,4": "sW", "4,4": "sW" }),
      R([[0, 2, "slu", 1, 0], [2, 2, "slu", 0, 2], [2, 4, "slu", 3, 0]]),
      "Three turns thread the water past the pots to the bottom rows."),
    G("g09", "Short Water, Long Light", 7, 6,
      C({ "0,0": "S1", "6,0": "T2", "4,2": "sW", "3,2": "sW", "2,3": "sL", "4,5": "sL", "6,5": "sL" }),
      R([[2, 0, "mir", 0, 1], [6, 2, "slu", 0, 3], [2, 5, "mir", 0, 1]]),
      "A short drink and a long road for the light, crossing on the way."),
    G("g10", "The Full House", 7, 7,
      C({ "0,3": "S1", "1,3": "sL", "4,3": "rock", "3,1": "sB", "3,0": "sL", "2,1": "sW", "6,1": "T3", "0,6": "T1", "3,5": "sW" }),
      R([[3, 3, "mir", 1, 0], [3, 6, "slu", 1, 3], [5, 6, "slu", 0, 0], [5, 5, "mir", 1, 1]]),
      "Five seedlings, one sun, water arriving from two directions — and two pieces that matter not at all."),
    G("g11", "The Mirror Maze", 7, 7,
      C({ "0,6": "S0", "1,4": "sL", "3,4": "rock", "5,4": "rock", "1,1": "rock", "2,2": "sL", "4,3": "sL", "4,5": "sL" }),
      R([[0, 4, "mir", 1, 0], [2, 4, "mir", 1, 0], [2, 1, "mir", 1, 0], [4, 1, "mir", 0, 1]]),
      "A staircase of mirrors climbs the glasshouse. No water today — light only."),
    G("g12", "The Old Glasshouse", 7, 7,
      C({ "0,0": "S1", "4,0": "S2", "2,2": "sL", "0,4": "sB", "0,6": "T0", "6,6": "T0", "4,3": "sW", "3,3": "sW", "4,2": "sL", "6,5": "sL" }),
      R([[2, 0, "mir", 0, 1], [2, 4, "mir", 1, 0], [6, 3, "slu", 0, 2], [4, 5, "mir", 0, 1], [5, 1, "slu", 2, 2], [1, 6, "mir", 0, 0]]),
      "Everything the season taught, in one old glasshouse.")
  ];

  /* Pars below are the BFS-proven minimum taps for each garden (and
   * its drought variant), certified by
   * evidence-glasshouse/verify-glasshouse.js — declared solution taps
   * equal the BFS minimum for every garden, so the intended solution
   * is a shortest one. */
  var VERIFIED_PARS = [1, 1, 3, 2, 5, 7, 2, 6, 5, 3, 4, 5];
  GARDENS.forEach(function (g, i) { g.par = VERIFIED_PARS[i]; g.droughtPar = VERIFIED_PARS[i]; });

  /* ---------- the endless generator ----------
   * Builds a garden by carving real beam paths: walk out from each
   * source, place the bending piece at every turn, plant seedlings
   * along the way. The carved configuration is a working solution by
   * construction; the garden is then scrambled and only accepted if
   * the BFS solver certifies it (solvable, start unsolved, par inside
   * the band, and — for drought gardens — solvable under drought). */

  var GEN_NAMES_A = ["Fern", "North", "Pebble", "Amber", "Willow", "Copper", "Moss", "Ember", "Hollow", "Quiet"];
  var GEN_NAMES_B = ["Bench", "Corner", "Rows", "Arch", "Corner", "Walk", "Shelf", "Yard", "Nook", "Stairs"];

  function generateGarden(seedKey, opts) {
    opts = opts || {};
    var drought = !!opts.drought;
    var minTaps = opts.minTaps || 5, maxTaps = opts.maxTaps || 12;
    var rng = rngFrom(seedKey);
    function ri(n) { return Math.floor(rng() * n); }
    function pick(arr) { return arr[ri(arr.length)]; }

    for (var attempt = 0; attempt < 400; attempt++) {
      var w = opts.w || pick([6, 7]), h = opts.h || pick([6, 7]);
      var cells = {}, rots = [];
      var occupied = {}; // "x,y" -> "src"|"piece"|"seed"|"rock"
      var pathCells = {}; // cells a solution beam passes through (incl. seeds)
      var failed = false;

      function cellFree(x, y) { return x >= 0 && y >= 0 && x < w && y < h && !occupied[key(x, y)]; }

      function carve(kind) {
        // place the source on a random edge, facing inward
        var side = ri(4), pos, sx, sy, dir;
        if (side === 0) { pos = ri(w); sx = pos; sy = 0; dir = 2; }
        else if (side === 1) { pos = ri(w); sx = pos; sy = h - 1; dir = 0; }
        else if (side === 2) { pos = ri(h); sx = 0; sy = pos; dir = 1; }
        else { pos = ri(h); sx = w - 1; sy = pos; dir = 3; }
        if (!cellFree(sx, sy)) return false;
        cells[key(sx, sy)] = kind === "light" ? { t: "sun", dir: dir } : { t: "tap", dir: dir };
        occupied[key(sx, sy)] = "src";
        pathCells[key(sx, sy)] = true;

        var x = sx, y = sy, d = dir, totalLen = 0;
        var segments = rng() < 0.25 ? 2 : (rng() < 0.55 ? 3 : 4); // 1-3 turns per beam
        var walked = []; // plain cells walked (seedling candidates)
        for (var s = 0; s < segments && !failed; s++) {
          var last = s === segments - 1;
          var maxSteps = 0;
          while (true) {
            var tx = x + DIRS[d].x * (maxSteps + 1), ty = y + DIRS[d].y * (maxSteps + 1);
            if (tx < 0 || ty < 0 || tx >= w || ty >= h) break;
            var occ = occupied[key(tx, ty)];
            if (occ === "piece" || occ === "src" || occ === "rock") break;
            maxSteps++;
            if (maxSteps >= 4) break;
          }
          if (maxSteps < 1) { failed = true; break; }
          var steps = 1 + ri(Math.min(maxSteps, 3));
          for (var st = 0; st < steps; st++) {
            x += DIRS[d].x; y += DIRS[d].y; totalLen++;
            var kk = key(x, y);
            pathCells[kk] = true;
            if (occupied[kk] === "seed") { /* crossing the other beam's seedling */ }
            else if (!occupied[kk]) walked.push([x, y]);
            else if (occupied[kk] === "path") walked.push([x, y]);
            occupied[kk] = occupied[kk] || "path";
          }
          if (last) break;
          // the next cell must hold the bending piece
          var px = x + DIRS[d].x, py = y + DIRS[d].y;
          if (!cellFree(px, py)) { failed = true; break; }
          var turn = rng() < 0.5 ? 1 : 3; // +1 clockwise, +3 counter
          var nd = (d + turn) % 4;
          if (kind === "light") {
            var slant = MIRROR_MAP[0][d] === nd ? 0 : 1;
            if (MIRROR_MAP[slant][d] !== nd) { failed = true; break; }
            rots.push({ x: px, y: py, kind: "mir", start: 0, sol: slant, work: true });
          } else {
            var entry = (d + 2) % 4;
            var o = (entry + 1) % 4 === nd ? entry : nd;
            var testCon = [o, (o + 1) % 4];
            if (testCon.indexOf(entry) < 0 || testCon.indexOf(nd) < 0) { failed = true; break; }
            rots.push({ x: px, y: py, kind: "slu", start: 0, sol: o, work: true });
          }
          occupied[key(px, py)] = "piece";
          pathCells[key(px, py)] = true;
          x = px; y = py; d = nd;
        }
        if (failed) return false;
        if (drought && kind === "water" && totalLen > DROUGHT_RANGE - 2) return false;
        // plant seedlings along the walked cells
        var want = 1 + ri(3); // 1-3
        var candidates = walked.slice();
        var planted = 0;
        while (planted < want && candidates.length) {
          var ci = ri(candidates.length);
          var cellPos = candidates.splice(ci, 1)[0];
          var ck = key(cellPos[0], cellPos[1]);
          var existing = cells[ck];
          var need = kind === "light" ? "L" : "W";
          if (existing && existing.t === "seed") {
            if (existing.need !== need) existing.need = "B";
          } else if (!existing) {
            cells[ck] = { t: "seed", need: need };
          } else { continue; }
          occupied[ck] = "seed";
          planted++;
        }
        return planted > 0;
      }

      if (!carve("light")) continue;
      if (!carve("water")) continue;

      var garden = { id: "gen", name: "", w: w, h: h, cells: cells, rots: rots, intro: "", par: null };
      // solution beams, for safe decoy/rock placement
      var solSim = simulate(garden, solutionStates(garden), { drought: drought });
      var beamCells = {};
      solSim.lightPaths.concat(solSim.waterPaths).forEach(function (p) {
        p.forEach(function (pt) { beamCells[key(pt[0], pt[1])] = true; });
      });
      // decoys: pieces no beam touches, state is its own solution
      var decoys = ri(3); // 0-2
      for (var di = 0; di < decoys; di++) {
        for (var tries = 0; tries < 12; tries++) {
          var dx = ri(w), dy = ri(h), dk = key(dx, dy);
          if (occupied[dk] || beamCells[dk]) continue;
          var dkind = rng() < 0.5 ? "mir" : "slu";
          var dst = ri(cycleOf(dkind));
          rots.push({ x: dx, y: dy, kind: dkind, start: dst, sol: dst });
          occupied[dk] = "piece";
          break;
        }
      }
      // rocks on cells no solution beam uses
      var rocks = ri(4); // 0-3
      for (var rj = 0; rj < rocks; rj++) {
        for (var rt = 0; rt < 12; rt++) {
          var rx = ri(w), ry = ri(h), rk = key(rx, ry);
          if (occupied[rk] || beamCells[rk]) continue;
          cells[rk] = { t: "rock" };
          occupied[rk] = "rock";
          break;
        }
      }
      // scramble the working pieces (decoys keep their state)
      rots.forEach(function (r) {
        if (!r.work) return;
        var c = cycleOf(r.kind);
        r.start = (r.sol + 1 + ri(c - 1)) % c;
        delete r.work;
      });
      garden.rots = rots;
      // certify
      var vfy = verifyGarden(garden);
      if (!vfy.solutionWorks || !vfy.startUnsolved) continue;
      if (vfy.par === null || vfy.par < minTaps || vfy.par > maxTaps) continue;
      if (drought && (vfy.droughtPar === null || !vfy.solutionWorksInDrought)) continue;
      garden.par = vfy.par;
      garden.droughtPar = vfy.droughtPar;
      garden.name = pick(GEN_NAMES_A) + " " + pick(GEN_NAMES_B);
      return garden;
    }
    return null;
  }

  var api = {
    DIRS: DIRS, MIRROR_MAP: MIRROR_MAP, DROUGHT_RANGE: DROUGHT_RANGE,
    key: key, hashStr: hashStr, rngFrom: rngFrom,
    seedList: seedList, startStates: startStates, solutionStates: solutionStates,
    tapsBetween: tapsBetween, simulate: simulate, evaluate: evaluate,
    solve: solve, verifyGarden: verifyGarden,
    GARDENS: GARDENS, generateGarden: generateGarden
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.GlasshouseCore = api;
})();
