/* Wrenworks Arcade — local data adapter.
 *
 * This implements the same shapes as the planned Cloudflare Worker API
 * (build plan section 2) against the browser's local storage, so the
 * shell and the games run fully offline during the local build phase:
 *
 *   Worker: GET  /api/board?game=<slug>&board=<weekly|daily>
 *   Local:  ArcadeAPI.getBoard(game, board) -> [{name, score, detail, ts}]
 *
 *   Worker: POST /api/score {game, board, name, score, detail}
 *   Local:  ArcadeAPI.submitScore(game, board, {name, score, detail})
 *
 *   Worker: POST /api/like {game}
 *   Local:  ArcadeAPI.like(game) -> {likes, liked}
 *
 *   Worker: GET  /api/championship
 *   Local:  ArcadeAPI.getChampionship() -> [{name, points}]
 *
 * When the Worker exists, only this file changes: the functions below
 * become fetch() calls with the same return shapes, and no game code
 * needs to know. Until then everything lives in this browser, which the
 * About page's privacy note says plainly.
 */
(function () {
  "use strict";
  var LS = window.localStorage;

  function jget(key, fallback) {
    try {
      var v = LS.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }
  function jset(key, value) {
    try { LS.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode etc. */ }
  }

  function playerToken() {
    var t = jget("arcade.playerToken", null);
    if (!t) {
      t = "p-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      jset("arcade.playerToken", t);
    }
    return t;
  }

  function getName() { return jget("arcade.playerName", ""); }
  function setName(name) { jset("arcade.playerName", String(name || "").slice(0, 24)); }

  /* ---- boards ---- */
  function boardKey(game, board) { return "arcade.board." + game + "." + board; }

  function getBoard(game, board) {
    var rows = jget(boardKey(game, board), []);
    return rows.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 50);
  }

  /* Keeps the player's best entry per board (the Worker will do the same). */
  function submitScore(game, board, entry) {
    var rows = jget(boardKey(game, board), []);
    var token = playerToken();
    var mine = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].token === token) { mine = rows[i]; break; }
    var row = {
      token: token,
      name: entry.name || getName() || "A player",
      score: entry.score,
      detail: entry.detail || "",
      ts: Date.now()
    };
    if (mine) {
      if (row.score > mine.score) { mine.name = row.name; mine.score = row.score; mine.detail = row.detail; mine.ts = row.ts; }
    } else {
      rows.push(row);
    }
    jset(boardKey(game, board), rows);
    return getBoard(game, board);
  }

  /* ---- likes ---- */
  function getLikes(game) {
    var data = jget("arcade.likes." + game, { count: 0, tokens: {} });
    return { likes: data.count, liked: !!data.tokens[playerToken()] };
  }
  function like(game) {
    var key = "arcade.likes." + game;
    var data = jget(key, { count: 0, tokens: {} });
    var t = playerToken();
    if (data.tokens[t]) { delete data.tokens[t]; data.count = Math.max(0, data.count - 1); }
    else { data.tokens[t] = 1; data.count += 1; }
    jset(key, data);
    return { likes: data.count, liked: !!data.tokens[t] };
  }

  /* ---- championship + passport ---- */
  var MEDAL_POINTS = { wren: 50, gold: 30, silver: 20, bronze: 10, none: 0 };
  var MEDAL_LABEL = { wren: "Wren medal", gold: "Gold", silver: "Silver", bronze: "Bronze", none: "No medal" };

  function getPassport() {
    return jget("arcade.passport", { games: {}, dailyStamps: {} });
  }

  /* Called by a game when a run ends. Updates the passport and the
     championship standing for this browser's player. */
  function recordResult(game, result) {
    var passport = getPassport();
    var g = passport.games[game] || { plays: 0, finishes: 0, bestMedal: "none", bestScore: 0, bestRunMedal: "none", bestRunDeliveries: 0, lastPlayed: 0 };
    g.plays += 1;
    if (result.finished) g.finishes += 1;
    if (typeof result.score === "number" && result.score > g.bestScore) {
      g.bestScore = result.score;
      /* the best run as one run: its medal and its deliveries are
         kept together — the Starfall championship derives its
         points from exactly this pair (see the v1.1 report) */
      g.bestRunMedal = result.medal || "none";
      g.bestRunDeliveries = typeof result.deliveries === "number" ? result.deliveries : 0;
    }
    var order = ["none", "bronze", "silver", "gold", "wren"];
    if (result.medal && order.indexOf(result.medal) > order.indexOf(g.bestMedal)) g.bestMedal = result.medal;
    g.lastPlayed = Date.now();
    passport.games[game] = g;
    if (result.dailyStamp) passport.dailyStamps[result.dailyStamp] = true;
    jset("arcade.passport", passport);

    var table = jget("arcade.championship", {});
    var me = table[playerToken()] || { name: getName() || "A player", points: 0 };
    var pts = 0;
    if (result.finished) pts += 5;
    if (result.medal) pts += (MEDAL_POINTS[result.medal] || 0);
    if (result.dailyStamp) pts += 3;
    me.points += pts;
    me.name = getName() || me.name;
    table[playerToken()] = me;
    jset("arcade.championship", table);
    return passport;
  }

  function getChampionship() {
    var table = jget("arcade.championship", {});
    return Object.keys(table).map(function (k) { return table[k]; })
      .sort(function (a, b) { return b.points - a.points; }).slice(0, 50);
  }

  /* ---- instrumentation (the plan's own game-level numbers) ---- */
  function logEvent(type, game, data) {
    var events = jget("arcade.events", []);
    events.push({ type: type, game: game || null, data: data || {}, ts: Date.now() });
    if (events.length > 3000) events = events.slice(events.length - 3000);
    jset("arcade.events", events);
  }
  function getEvents() { return jget("arcade.events", []); }

  /* ---- signup ----
     Not an adapter function, deliberately: the signup form on the
     arcade home page posts straight to the configured Kit form
     endpoint (the single config value lives in that form's action,
     marked with a SIGNUP CONFIG comment). No address ever passes
     through this adapter or this browser's storage. */

  window.ArcadeAPI = {
    playerToken: playerToken,
    getName: getName, setName: setName,
    getBoard: getBoard, submitScore: submitScore,
    getLikes: getLikes, like: like,
    getPassport: getPassport, recordResult: recordResult,
    getChampionship: getChampionship,
    logEvent: logEvent, getEvents: getEvents,
    MEDAL_LABEL: MEDAL_LABEL
  };
})();
