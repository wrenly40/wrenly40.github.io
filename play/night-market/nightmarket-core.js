/* Night Market — pure game core (no DOM). Shared by the browser game
 * and the Node gate verifier, so what is proven offline is exactly
 * what ships.
 *
 * Rules of the market:
 *  - The square is 5 lanes x 9 columns. Night things enter at the east
 *    gate (column 8) and walk west. West of column 0 stands the
 *    lantern tree: an enemy that steps past column 0 leaks and steals
 *    lanterns (the night's heart). Lose every lantern and the night
 *    is lost; survive all rounds with at least one and dawn comes.
 *  - Each round ("an hour of the night"): the round's things arrive
 *    at the gate, the keeper rolls 4 market dice, builds, then the
 *    march runs 2 steps (stalls fire, then things advance).
 *  - Each die face IS a stall. Spend a die to raise that stall on any
 *    empty plot, or bank the die for 1 coin. Kills pay bounty coins.
 *    Mercy rule (stated in the how-to-play): any die may be flipped
 *    to any face for 3 coins, so no roll can strand the market.
 *  - Stalls fire east, along their own lane, at the most advanced
 *    thing in range. Things do not block each other or the stalls.
 *
 * A night config: { id, name, rounds, lanterns, startCoins, modifier,
 *                   spawns: [[moth,rat,shade] per round] }
 * Modifiers: "fog" (every stall's range -1, min 1), "festival"
 * (spawn counts up, every kill pays +1 bounty). Score multiplier
 * x1.25 per modifier, applied to the night's total at dawn.
 */
(function () {
  "use strict";

  var COLS = 9;              // columns 0..8, gate at 8
  var LANES = 5;
  var DICE_PER_ROUND = 4;
  var MARCH_STEPS = 2;
  var FLIP_COST = 3;
  var CLEAR_BONUS = 150;
  var NO_LEAK_BONUS = 250;
  var KILL_SCORE = 10;
  var LANTERN_SCORE = 100;
  var COIN_SCORE = 1;

  /* face -> stall. period: march steps between shots. splash: extra
   * damage dealt to things one column either side of the target, same
   * lane. chill: things hit skip their next advance. */
  var STALLS = {
    1: { face: 1, name: "Crumb Cart",     dmg: 1, range: 3, period: 1, splash: 0, chill: false },
    2: { face: 2, name: "Lantern Stall", dmg: 2, range: 6, period: 1, splash: 0, chill: false },
    3: { face: 3, name: "Bell Stall",    dmg: 1, range: 4, period: 1, splash: 0, chill: true  },
    4: { face: 4, name: "Kettle Stall",  dmg: 4, range: 2, period: 1, splash: 0, chill: false },
    5: { face: 5, name: "Firework Stall",dmg: 3, range: 5, period: 2, splash: 2, chill: false },
    6: { face: 6, name: "Moon Stall",    dmg: 3, range: 5, period: 1, splash: 0, chill: false }
  };

  /* moveEvery: march steps between advances. scurry: a rat that is
   * hurt and lives immediately scampers one column west (once per
   * fire phase), unless it was chilled by that same fire phase. */
  var ENEMIES = {
    moth:  { type: "moth",  name: "Moth",  hp: 3,  moveEvery: 1, stride: 1, leak: 1, bounty: 1, scurry: false },
    rat:   { type: "rat",   name: "Rat",   hp: 2,  moveEvery: 1, stride: 1, leak: 1, bounty: 1, scurry: true  },
    shade: { type: "shade", name: "Shade", hp: 11, moveEvery: 2, stride: 1, leak: 2, bounty: 2, scurry: false }
  };

  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* Object-style RNG so a state (and its streams) can be cloned for
   * lookahead without disturbing the real game. Integer ops only. */
  function makeRng(seedStr) {
    var a = hashStr(String(seedStr)) | 0;
    return {
      next: function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      clone: function () {
        var r = makeRng("clone");
        r._set(a);
        return r;
      },
      _set: function (v) { a = v | 0; },
      state: function () { return a; }
    };
  }

  function stallRange(stall, config) {
    var r = stall.range;
    if (config && config.modifier === "fog") r = Math.max(1, r - 1);
    return r;
  }

  /* ---------------- campaign nights ----------------
   * spawns: one [moth, rat, shade] triple per round. Counts are fixed
   * per night (authored difficulty); the night's seed assigns lanes. */
  var NIGHTS = [
    {
      id: "n1", name: "First Night", rounds: 10, lanterns: 10, startCoins: 3, modifier: null,
      intro: "Only moths tonight, drifting for the lantern tree. Raise stalls, hold the square, and dawn will do the rest.",
      spawns: [[2,0,0],[2,0,0],[3,0,0],[3,0,0],[4,0,0],[3,0,0],[4,0,0],[4,0,0],[5,0,0],[5,0,0]]
    },
    {
      id: "n2", name: "Rat Alley", rounds: 10, lanterns: 10, startCoins: 3, modifier: null,
      intro: "Rats have found the square. A hurt rat scampers west, so finish them cleanly — one strong hit beats two small ones.",
      spawns: [[2,1,0],[3,1,0],[3,2,0],[4,2,0],[4,3,0],[5,2,0],[4,3,0],[5,3,0],[5,4,0],[6,4,0]]
    },
    {
      id: "n3", name: "Lantern Row", rounds: 11, lanterns: 10, startCoins: 4, modifier: null,
      intro: "The whole row is lit tonight and the night knows it. More moths, more rats, longer hours.",
      spawns: [[4,2,0],[4,2,0],[5,2,0],[5,3,0],[5,3,0],[6,3,0],[5,4,0],[6,3,0],[6,4,0],[6,4,0],[7,4,0]]
    },
    {
      id: "n4", name: "The Shades Come", rounds: 11, lanterns: 10, startCoins: 4, modifier: null,
      intro: "Shades walk slowly and take a lantern each — two if they reach the tree. They are tough: mass your fire on one at a time. And watch the side alley: from the sixth hour, some things slip in halfway across the square.",
      alley: { fromRound: 6, col: 5, share: 0.2 },
      spawns: [[4,2,1],[4,2,1],[5,2,1],[5,3,1],[5,3,1],[6,3,2],[5,3,2],[6,3,2],[6,4,2],[6,4,2],[7,4,2]]
    },
    {
      id: "n5", name: "Fog over the Square", rounds: 11, lanterns: 10, startCoins: 5, modifier: "fog",
      intro: "Fog tonight: every stall sees one column less. Build closer to the gate, lean on short-range muscle, and keep the side alley covered.",
      alley: { fromRound: 4, col: 5, share: 0.3 },
      spawns: [[5,2,1],[5,2,1],[5,3,1],[6,3,1],[5,3,2],[6,3,2],[6,3,2],[6,4,2],[6,4,2],[7,4,2],[7,4,3]]
    },
    {
      id: "n6", name: "Festival Night", rounds: 12, lanterns: 10, startCoins: 5, modifier: "festival",
      intro: "Festival night: the crowds draw the night things in droves — but every stall is busy, and every kill pays an extra coin. The side alley is busy too.",
      alley: { fromRound: 3, col: 5, share: 0.3 },
      spawns: [[6,3,1],[6,3,1],[7,3,1],[7,4,2],[7,4,2],[8,4,2],[7,5,2],[8,5,3],[8,5,3],[9,6,3],[8,6,3],[9,6,4]]
    },
    {
      id: "n7", name: "The Longest Night", rounds: 12, lanterns: 10, startCoins: 6, modifier: null,
      intro: "Everything the night has, all at once — and the side alley runs all night. Hold this square and the market can hold any night there is.",
      alley: { fromRound: 3, col: 5, share: 0.4 },
      spawns: [[6,4,1],[7,4,2],[7,4,2],[8,5,2],[7,5,3],[8,5,3],[8,6,3],[9,5,4],[8,6,4],[9,6,4],[9,7,4],[10,7,5]]
    }
  ];

  function endlessSpawn(round) {
    var m = 3 + Math.floor(round * 0.7);
    var r = round >= 2 ? Math.floor(round * 0.5) : 0;
    var s = round >= 4 ? Math.floor((round - 3) / 2) : 0;
    return [m, r, s];
  }

  /* Tonight's Night: one of three mid-weight templates, chosen and
   * seeded by the date, so the whole world defends the same night. */
  var DAILY_TEMPLATES = [
    { rounds: 10, lanterns: 10, startCoins: 4, modifier: null,
      spawns: [[3,1,0],[4,2,0],[4,2,1],[5,2,1],[5,3,1],[4,3,1],[5,3,2],[6,3,1],[5,4,2],[6,4,2]] },
    { rounds: 10, lanterns: 10, startCoins: 4, modifier: null,
      spawns: [[2,2,0],[3,3,0],[4,3,1],[4,4,1],[5,3,1],[5,4,2],[4,4,1],[6,4,2],[5,5,2],[6,5,2]] },
    { rounds: 11, lanterns: 10, startCoins: 5, modifier: "fog",
      spawns: [[4,1,0],[4,2,1],[5,2,1],[4,3,1],[5,3,1],[5,2,2],[6,3,1],[5,3,2],[6,4,2],[5,4,2],[6,4,2]] }
  ];

  function dailyConfig(dateStr) {
    var idx = hashStr("daily:" + dateStr) % DAILY_TEMPLATES.length;
    var t = DAILY_TEMPLATES[idx];
    return {
      id: "daily", name: "Tonight's Night", rounds: t.rounds, lanterns: t.lanterns,
      startCoins: t.startCoins, modifier: t.modifier,
      intro: "One seeded night, the same for every keeper tonight. Hold it and stamp your passport.",
      spawns: t.spawns, seed: "daily:" + dateStr
    };
  }

  function endlessConfig() {
    return {
      id: "endless", name: "The Long Night", rounds: Infinity, lanterns: 10, startCoins: 4,
      modifier: null, intro: "No dawn in the Long Night. Hold as many hours as you can.",
      spawns: null, seed: null
    };
  }

  /* ---------------- night state ---------------- */

  function spawnCountsFor(config, round) {
    var base = config.spawns ? config.spawns[round - 1] : endlessSpawn(round);
    if (!base) return [0, 0, 0];
    if (config.modifier === "festival") {
      return [Math.ceil(base[0] * 1.25), Math.ceil(base[1] * 1.25), base[2]];
    }
    return base.slice();
  }

  /* The whole spawn plan is fixed when the night is created: counts
   * are authored (campaign/daily) or formulaic (endless, generated
   * lazily); lanes are drawn from the spawn stream. */
  function createNight(config, seedStr) {
    var seed = seedStr || config.seed || (config.id + ":default");
    var spawnRng = makeRng("spawn:" + seed);
    var state = {
      config: config,
      seed: String(seed),
      round: 0,
      phase: "build",           // build | won | lost
      lanterns: config.lanterns,
      coins: config.startCoins,
      dice: [],                 // faces in hand this round
      diceRng: makeRng("dice:" + seed),
      spawnRng: spawnRng,
      stalls: {},               // "lane,col" -> {lane,col,face,nextFire}
      enemies: [],              // {id,lane,col,type,hp,maxHp,counter,chilled}
      nextEnemyId: 1,
      step: 0,                  // march steps taken (drives fire periods)
      kills: 0,
      leaks: 0,                 // enemies that got through
      lanternsLost: 0,
      scoreRaw: 0,
      events: []
    };
    return state;
  }

  function cellKey(lane, col) { return lane + "," + col; }

  function rollDie(rng) { return 1 + Math.floor(rng.next() * 6); }

  /* Begin a round: spawn this round's things at the gate, roll dice.
   * On alley nights, some moths and rats slip in through the side
   * alley instead (closer to the tree, less time to react). */
  function startRound(state) {
    if (state.phase !== "build") return state.events;
    state.round += 1;
    var counts = spawnCountsFor(state.config, state.round);
    var alley = state.config.alley;
    var types = ["moth", "rat", "shade"];
    for (var t = 0; t < 3; t++) {
      for (var i = 0; i < counts[t]; i++) {
        var lane = Math.floor(state.spawnRng.next() * LANES);
        var col = COLS - 1;
        if (alley && types[t] !== "shade" && state.round >= alley.fromRound &&
            state.spawnRng.next() < alley.share) {
          col = alley.col;
        }
        var def = ENEMIES[types[t]];
        state.enemies.push({
          id: state.nextEnemyId++, lane: lane, col: col, type: types[t],
          hp: def.hp, maxHp: def.hp, counter: 0, chilled: false
        });
      }
    }
    state.dice = [];
    for (var d = 0; d < DICE_PER_ROUND; d++) state.dice.push(rollDie(state.diceRng));
    state.events.push({ kind: "round", round: state.round, spawned: counts[0] + counts[1] + counts[2] });
    return state.events;
  }

  /* ---------------- build actions ---------------- */

  function doPlace(state, dieIndex, lane, col) {
    if (state.phase !== "build") return false;
    if (dieIndex < 0 || dieIndex >= state.dice.length) return false;
    if (lane < 0 || lane >= LANES || col < 0 || col >= COLS) return false;
    var k = cellKey(lane, col);
    if (state.stalls[k]) return false;
    var face = state.dice[dieIndex];
    state.stalls[k] = { lane: lane, col: col, face: face, nextFire: state.step };
    state.dice.splice(dieIndex, 1);
    state.events.push({ kind: "place", face: face, lane: lane, col: col });
    return true;
  }

  function doBank(state, dieIndex) {
    if (state.phase !== "build") return false;
    if (dieIndex < 0 || dieIndex >= state.dice.length) return false;
    state.dice.splice(dieIndex, 1);
    state.coins += 1;
    state.events.push({ kind: "bank", coins: state.coins });
    return true;
  }

  function doFlip(state, dieIndex, face) {
    if (state.phase !== "build") return false;
    if (dieIndex < 0 || dieIndex >= state.dice.length) return false;
    if (face < 1 || face > 6 || face === state.dice[dieIndex]) return false;
    if (state.coins < FLIP_COST) return false;
    state.coins -= FLIP_COST;
    state.dice[dieIndex] = face;
    state.events.push({ kind: "flip", face: face });
    return true;
  }

  /* ---------------- the march ---------------- */

  function targetFor(state, stall) {
    var range = stallRange(STALLS[stall.face], state.config);
    var best = null;
    for (var i = 0; i < state.enemies.length; i++) {
      var e = state.enemies[i];
      if (e.lane !== stall.lane) continue;
      var d = e.col - stall.col;
      if (d < 0 || d > range) continue;
      if (!best || e.col < best.col ||
          (e.col === best.col && (e.hp > best.hp || (e.hp === best.hp && e.id < best.id)))) {
        best = e;
      }
    }
    return best;
  }

  function marchStep(state) {
    var ev = { kind: "step", step: state.step, shots: [], kills: [], leaks: [] };
    if (state.phase !== "build") return ev;

    /* 1 — fire phase. All shots are chosen from positions as they
     * stand, then damage lands together. */
    var dmg = {};   // enemy id -> {amount, chilled}
    var stallKeys = Object.keys(state.stalls);
    for (var s = 0; s < stallKeys.length; s++) {
      var stall = state.stalls[stallKeys[s]];
      if (state.step < stall.nextFire) continue;
      var target = targetFor(state, stall);
      if (!target) continue;
      var def = STALLS[stall.face];
      stall.nextFire = state.step + def.period;
      ev.shots.push({ lane: stall.lane, col: stall.col, face: stall.face, targetId: target.id, targetCol: target.col });
      addDmg(dmg, target, def.dmg, def.chill);
      if (def.splash > 0) {
        for (var i = 0; i < state.enemies.length; i++) {
          var nb = state.enemies[i];
          if (nb.id !== target.id && nb.lane === target.lane && Math.abs(nb.col - target.col) === 1) {
            addDmg(dmg, nb, def.splash, false);
          }
        }
      }
    }
    function addDmg(map, enemy, amount, chill) {
      var rec = map[enemy.id] || (map[enemy.id] = { amount: 0, chilled: false });
      rec.amount += amount;
      if (chill) rec.chilled = true;
    }

    var festival = state.config.modifier === "festival";
    var survivors = [];
    for (var j = 0; j < state.enemies.length; j++) {
      var e = state.enemies[j];
      var rec = dmg[e.id];
      var scurryTo = null;
      if (rec) {
        e.hp -= rec.amount;
        if (rec.chilled) e.chilled = true;
        if (e.hp > 0 && ENEMIES[e.type].scurry && !rec.chilled) scurryTo = e.col - 1;
      }
      if (e.hp <= 0) {
        state.kills += 1;
        state.scoreRaw += KILL_SCORE;
        state.coins += ENEMIES[e.type].bounty + (festival ? 1 : 0);
        ev.kills.push({ id: e.id, type: e.type, lane: e.lane, col: e.col });
        continue;
      }
      if (scurryTo !== null) {
        e.col = scurryTo;
        if (e.col < 0) {
          leakEnemy(state, e, ev);
          continue;
        }
      }
      survivors.push(e);
    }
    state.enemies = survivors;

    /* 2 — advance phase. A chilled thing skips one advance. */
    survivors = [];
    for (var m = 0; m < state.enemies.length; m++) {
      var en = state.enemies[m];
      if (en.chilled) { en.chilled = false; survivors.push(en); continue; }
      en.counter += 1;
      if (en.counter >= ENEMIES[en.type].moveEvery) {
        en.counter = 0;
        en.col -= ENEMIES[en.type].stride;
        if (en.col < 0) { leakEnemy(state, en, ev); continue; }
      }
      survivors.push(en);
    }
    state.enemies = survivors;

    state.step += 1;
    state.events.push(ev);
    if (state.lanterns <= 0) state.phase = "lost";
    return ev;
  }

  function leakEnemy(state, e, ev) {
    state.leaks += 1;
    state.lanternsLost += ENEMIES[e.type].leak;
    state.lanterns -= ENEMIES[e.type].leak;
    if (ev) ev.leaks.push({ id: e.id, type: e.type, lane: e.lane });
    state.events.push({ kind: "leak", type: e.type, lane: e.lane, lanterns: state.lanterns });
  }

  /* End the build phase: run the march, then either the night ends
   * or the next round begins. */
  function endBuild(state) {
    var stepEvents = [];
    for (var s = 0; s < MARCH_STEPS; s++) {
      stepEvents.push(marchStep(state));
      if (state.phase !== "build") break;
    }
    if (state.phase === "build") {
      if (state.round >= state.config.rounds) {
        state.phase = "won";
      } else {
        startRound(state);
      }
    }
    return stepEvents;
  }

  /* ---------------- scoring ---------------- */

  function scoreNight(state) {
    var mult = state.config.modifier ? 1.25 : 1;
    var breakdown = {
      kills: state.kills * KILL_SCORE,
      lanterns: 0, coins: 0, clear: 0, noLeak: 0
    };
    if (state.phase === "won") {
      breakdown.lanterns = state.lanterns * LANTERN_SCORE;
      breakdown.coins = state.coins * COIN_SCORE;
      breakdown.clear = CLEAR_BONUS;
      breakdown.noLeak = state.leaks === 0 ? NO_LEAK_BONUS : 0;
    }
    var raw = state.scoreRaw + breakdown.lanterns + breakdown.coins + breakdown.clear + breakdown.noLeak;
    return { total: Math.round(raw * mult), breakdown: breakdown, multiplier: mult, raw: raw };
  }

  /* ---------------- cloning + lookahead ---------------- */

  function cloneState(state) {
    var stalls = {};
    Object.keys(state.stalls).forEach(function (k) {
      var s = state.stalls[k];
      stalls[k] = { lane: s.lane, col: s.col, face: s.face, nextFire: s.nextFire };
    });
    return {
      config: state.config, seed: state.seed, round: state.round, phase: state.phase,
      lanterns: state.lanterns, coins: state.coins,
      dice: state.dice.slice(),
      diceRng: state.diceRng.clone(), spawnRng: state.spawnRng.clone(),
      stalls: stalls,
      enemies: state.enemies.map(function (e) {
        return { id: e.id, lane: e.lane, col: e.col, type: e.type, hp: e.hp,
                 maxHp: e.maxHp, counter: e.counter, chilled: e.chilled };
      }),
      nextEnemyId: state.nextEnemyId, step: state.step,
      kills: state.kills, leaks: state.leaks, lanternsLost: state.lanternsLost,
      scoreRaw: state.scoreRaw, events: []
    };
  }

  /* Projected harm if the march ran right now on this (cloned) state:
   * leaks dominate, then how far the night has walked in, then how
   * much health it has left. Lower is safer. */
  function projectHarm(state) {
    var sim = cloneState(state);
    var leaksBefore = sim.leaks, killsBefore = sim.kills;
    for (var s = 0; s < MARCH_STEPS; s++) {
      marchStep(sim);
      if (sim.phase !== "build") break;
    }
    var harm = (sim.leaks - leaksBefore) * 400 - (sim.kills - killsBefore) * 8;
    for (var i = 0; i < sim.enemies.length; i++) {
      var e = sim.enemies[i];
      harm += (COLS - e.col) * 6 + e.hp * 2;
    }
    if (sim.phase === "lost") harm += 100000;
    return harm;
  }

  /* ---------------- the reference keeper (bot) ----------------
   * A reasonable, purely legal player: greedy one-round lookahead
   * over every die and plot, coin flips when a stronger face is
   * worth more than the coins, banks what it cannot use well. It
   * plays the shipped functions only — the same build actions and
   * the same march the browser runs. */

  function botBuildTurn(state) {
    var guard = 0;
    while (state.dice.length > 0 && guard++ < 16) {
      var baseHarm = projectHarm(state);
      /* Stalls only shoot their own lane, so a placement can only
       * help in a lane where something is walking. */
      var hotLanes = {};
      for (var e = 0; e < state.enemies.length; e++) hotLanes[state.enemies[e].lane] = true;
      var best = null; // {harm, kind:"place"|"flipplace", dieIndex, face, lane, col}
      for (var di = 0; di < state.dice.length; di++) {
        var face = state.dice[di];
        for (var lane = 0; lane < LANES; lane++) {
          if (!hotLanes[lane]) continue;
          for (var col = 0; col < COLS; col++) {
            if (state.stalls[cellKey(lane, col)]) continue;
            var c1 = cloneState(state);
            if (!doPlace(c1, di, lane, col)) continue;
            var h1 = projectHarm(c1);
            if (!best || h1 < best.harm) best = { harm: h1, kind: "place", dieIndex: di, face: face, lane: lane, col: col };
            if (state.coins >= FLIP_COST) {
              /* The faces worth paying to become: the workhorse, the
               * splash, the premium. */
              var flipFaces = [2, 5, 6];
              for (var fi = 0; fi < flipFaces.length; fi++) {
                var f2 = flipFaces[fi];
                if (f2 === face) continue;
                var c2 = cloneState(state);
                if (!doFlip(c2, di, f2)) continue;
                if (!doPlace(c2, di, lane, col)) continue;
                var h2 = projectHarm(c2);
                if (h2 < best.harm) best = { harm: h2, kind: "flipplace", dieIndex: di, face: f2, lane: lane, col: col };
              }
            }
          }
        }
      }
      if (best && best.harm < baseHarm - 0.5) {
        if (best.kind === "flipplace") doFlip(state, best.dieIndex, best.face);
        doPlace(state, best.dieIndex, best.lane, best.col);
      } else {
        break;
      }
    }
    while (state.dice.length > 0) doBank(state, 0);
    endBuild(state);
  }

  /* Play a whole night with the bot. opts.diceRng, when given,
   * replaces the dice stream (the verifier's adversarial rolls). */
  function botPlayNight(config, seedStr, opts) {
    opts = opts || {};
    var state = createNight(config, seedStr);
    if (opts.diceRng) state.diceRng = opts.diceRng;
    startRound(state);
    var safety = 0;
    while (state.phase === "build" && safety++ < 500) {
      botBuildTurn(state);
    }
    var sc = scoreNight(state);
    return {
      won: state.phase === "won",
      phase: state.phase,
      rounds: state.round,
      kills: state.kills,
      leaks: state.leaks,
      lanternsLeft: Math.max(0, state.lanterns),
      score: sc.total,
      state: state
    };
  }

  /* A naive keeper: places each die on the first empty plot it finds
   * scanning west to east, never flips, banks the rest. Exists so the
   * gate can show the game is not won by playing carelessly. */
  function naivePlayNight(config, seedStr) {
    var state = createNight(config, seedStr);
    startRound(state);
    var safety = 0;
    while (state.phase === "build" && safety++ < 500) {
      while (state.dice.length > 0) {
        var placed = false;
        for (var lane = 0; lane < LANES && !placed; lane++) {
          for (var col = COLS - 1; col >= 0 && !placed; col--) {
            if (doPlace(state, 0, lane, col)) placed = true;
          }
        }
        if (!placed) doBank(state, 0);
      }
      endBuild(state);
    }
    var sc = scoreNight(state);
    return { won: state.phase === "won", leaks: state.leaks, kills: state.kills,
             lanternsLeft: Math.max(0, state.lanterns), score: sc.total, state: state };
  }

  /* ---------------- snapshots (FD-030) ----------------
   * The whole night state as plain JSON, RNG stream positions
   * included, so a refresh mid-night restores the night exactly:
   * the same stalls, the same things on the square, the same dice
   * in hand — and the same dice still to come. */
  function serializeConfig(c) {
    return {
      id: c.id, name: c.name,
      rounds: c.rounds === Infinity ? null : c.rounds,
      lanterns: c.lanterns, startCoins: c.startCoins,
      modifier: c.modifier, intro: c.intro,
      spawns: c.spawns, alley: c.alley || null, seed: c.seed || null,
      replayMod: c.replayMod || null
    };
  }
  function serializeState(state) {
    return {
      v: 1,
      config: serializeConfig(state.config),
      seed: state.seed,
      round: state.round,
      phase: state.phase,
      lanterns: state.lanterns,
      coins: state.coins,
      dice: state.dice.slice(),
      diceRngState: state.diceRng.state(),
      spawnRngState: state.spawnRng.state(),
      stalls: JSON.parse(JSON.stringify(state.stalls)),
      enemies: JSON.parse(JSON.stringify(state.enemies)),
      nextEnemyId: state.nextEnemyId,
      step: state.step,
      kills: state.kills,
      leaks: state.leaks,
      lanternsLost: state.lanternsLost,
      scoreRaw: state.scoreRaw
    };
  }
  function deserializeState(data) {
    if (!data || data.v !== 1 || !data.config || !data.config.id) return null;
    var cfg = data.config;
    cfg.rounds = cfg.rounds === null ? Infinity : cfg.rounds;
    var state = createNight(cfg, data.seed);
    state.round = data.round;
    state.phase = data.phase;
    state.lanterns = data.lanterns;
    state.coins = data.coins;
    state.dice = (data.dice || []).slice();
    state.diceRng._set(data.diceRngState);
    state.spawnRng._set(data.spawnRngState);
    state.stalls = data.stalls || {};
    state.enemies = data.enemies || [];
    state.nextEnemyId = data.nextEnemyId || 1;
    state.step = data.step || 0;
    state.kills = data.kills || 0;
    state.leaks = data.leaks || 0;
    state.lanternsLost = data.lanternsLost || 0;
    state.scoreRaw = data.scoreRaw || 0;
    state.events = [];
    return state;
  }

  function stateHash(state) {
    var parts = [state.phase, state.round, state.lanterns, state.coins, state.kills,
                 state.leaks, state.scoreRaw, state.step, state.dice.join("")];
    var sk = Object.keys(state.stalls).sort();
    for (var i = 0; i < sk.length; i++) {
      var s = state.stalls[sk[i]];
      parts.push(sk[i] + ":" + s.face + ":" + s.nextFire);
    }
    var es = state.enemies.slice().sort(function (a, b) { return a.id - b.id; });
    for (var j = 0; j < es.length; j++) {
      var e = es[j];
      parts.push(e.id + ":" + e.type + ":" + e.lane + ":" + e.col + ":" + e.hp);
    }
    return hashStr(parts.join("|")).toString(16);
  }

  var api = {
    COLS: COLS, LANES: LANES, DICE_PER_ROUND: DICE_PER_ROUND, MARCH_STEPS: MARCH_STEPS,
    FLIP_COST: FLIP_COST, STALLS: STALLS, ENEMIES: ENEMIES, NIGHTS: NIGHTS,
    hashStr: hashStr, makeRng: makeRng,
    dailyConfig: dailyConfig, endlessConfig: endlessConfig, endlessSpawn: endlessSpawn,
    createNight: createNight, startRound: startRound,
    doPlace: doPlace, doBank: doBank, doFlip: doFlip,
    marchStep: marchStep, endBuild: endBuild, scoreNight: scoreNight,
    cloneState: cloneState, projectHarm: projectHarm,
    botBuildTurn: botBuildTurn, botPlayNight: botPlayNight, naivePlayNight: naivePlayNight,
    serializeState: serializeState, deserializeState: deserializeState,
    stateHash: stateHash, stallRange: stallRange, spawnCountsFor: spawnCountsFor,
    cellKey: cellKey
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.NightMarketCore = api;
})();
