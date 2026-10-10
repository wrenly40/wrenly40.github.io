/* Glasshouse — presentation. All rules live in glasshouse-core.js;
 * this file only draws, sounds, and keeps the player's records via
 * the arcade adapter (arcade-api.js). */
(function () {
  "use strict";
  var Core = window.GlasshouseCore;
  var API = window.ArcadeAPI;
  var SLUG = "glasshouse";
  var root = document.getElementById("game");

  /* ---------------- sound (all synthesised) ---------------- */
  var Sound = (function () {
    var ctx = null, master = null;
    var muted = false;
    try { muted = window.localStorage.getItem("glasshouse.muted") === "1"; } catch (e) {}
    function ensure() {
      if (ctx) { if (ctx.state === "suspended") ctx.resume(); return true; }
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain(); master.gain.value = muted ? 0 : 1;
        master.connect(ctx.destination);
        startBed();
        return true;
      } catch (e) { return false; }
    }
    function tone(freq, t0, dur, type, gain, slideTo) {
      if (!ctx) return;
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || "sine"; o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.05);
    }
    function noise(t0, dur, freqFrom, freqTo, gain) {
      if (!ctx) return;
      var len = Math.max(1, (dur * ctx.sampleRate) | 0);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      var src = ctx.createBufferSource(); src.buffer = buf;
      var f = ctx.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 1.1;
      f.frequency.setValueAtTime(freqFrom, t0);
      f.frequency.exponentialRampToValueAtTime(freqTo, t0 + dur);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0); src.stop(t0 + dur + 0.05);
    }
    var SCALE = [523.25, 587.33, 659.25, 783.99, 880.0];
    function startBed() {
      // a slow, quiet plucked bed — a note every few seconds, never loud
      setInterval(function () {
        if (!ctx || muted || document.hidden) return;
        var t = ctx.currentTime + 0.05;
        var f = SCALE[(Math.random() * SCALE.length) | 0] / 2;
        tone(f, t, 1.6, "sine", 0.028);
        tone(f * 2, t, 0.9, "sine", 0.008);
      }, 3400);
    }
    return {
      unlock: function () { ensure(); },
      isMuted: function () { return muted; },
      toggle: function () {
        muted = !muted;
        try { window.localStorage.setItem("glasshouse.muted", muted ? "1" : "0"); } catch (e) {}
        if (master) master.gain.value = muted ? 0 : 1;
        if (!muted) ensure();
        return muted;
      },
      tick: function (kind) {
        if (!ensure()) return;
        var t = ctx.currentTime + 0.01;
        if (kind === "mir") { tone(1250, t, 0.07, "triangle", 0.05); tone(1900, t, 0.04, "sine", 0.02); }
        else { tone(300, t, 0.09, "sine", 0.07, 170); noise(t, 0.05, 900, 500, 0.02); }
      },
      served: function (i) {
        if (!ensure()) return;
        var t = ctx.currentTime + 0.01;
        var f = SCALE[i % SCALE.length];
        tone(f, t, 0.7, "sine", 0.055); tone(f * 1.5, t + 0.02, 0.5, "sine", 0.018);
      },
      clear: function () {
        if (!ensure()) return;
        var t = ctx.currentTime + 0.02;
        [0, 1, 2, 4].forEach(function (n, i) { tone(SCALE[n % SCALE.length], t + i * 0.11, 0.8, "sine", 0.05); });
        noise(t, 0.7, 500, 1500, 0.03);
      }
    };
  })();

  /* ---------------- save ---------------- */
  var SAVE_KEY = "glasshouse.save.v1";
  function loadSave() {
    var fallback = {
      season: { best: {}, perfects: {}, recorded: false },
      mid: null, // {mode, key, states, taps, drought}
      dailyDone: null // {date, score}
    };
    try {
      var s = JSON.parse(window.localStorage.getItem(SAVE_KEY) || "null");
      if (s && typeof s === "object" && s.season && typeof s.season === "object") {
        if (!s.season.best) s.season.best = {};
        if (!s.season.perfects) s.season.perfects = {};
        if (!("mid" in s)) s.mid = null;
        if (!("dailyDone" in s)) s.dailyDone = null;
        return s;
      }
    } catch (e) {}
    return fallback;
  }
  function storeSave() {
    try { window.localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) {}
  }
  var save = loadSave();

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function esc(s) { return String(s == null ? "" : s).replace(/</g, "&lt;").replace(/"/g, "&quot;"); }
  function fmtMins(ms) {
    var m = Math.max(1, Math.round(ms / 60000));
    return m + (m === 1 ? " minute" : " minutes");
  }

  /* ---------------- piece art (inline SVG) ---------------- */
  function svgSun(dir) {
    var rot = (dir - 1) * 90;
    var rays = "";
    for (var i = 0; i < 8; i++) rays += '<line x1="50" y1="14" x2="50" y2="24" transform="rotate(' + i * 45 + ' 50 50)"/>';
    return '<svg viewBox="0 0 100 100" aria-hidden="true">' +
      '<g stroke="#e9a83b" stroke-width="5" stroke-linecap="round">' + rays + '</g>' +
      '<circle cx="50" cy="50" r="17" fill="#f6cf7d" stroke="#e9a83b" stroke-width="3"/>' +
      '<g transform="rotate(' + rot + ' 50 50)"><path d="M 66 42 L 88 50 L 66 58 Z" fill="#c4703f"/></g></svg>';
  }
  function svgTap(dir) {
    var rot = (dir - 1) * 90;
    return '<svg viewBox="0 0 100 100" aria-hidden="true">' +
      '<g transform="rotate(' + rot + ' 50 50)">' +
      '<rect x="30" y="34" width="30" height="32" rx="7" fill="#8d99a4" stroke="#5f6d78" stroke-width="3"/>' +
      '<rect x="52" y="42" width="26" height="11" rx="5" fill="#8d99a4" stroke="#5f6d78" stroke-width="3"/>' +
      '<path d="M 78 58 q 6 10 0 15 q -6 -5 0 -15" fill="#4d84ad"/></g>' +
      '<circle cx="45" cy="28" r="7" fill="#c4703f"/></svg>';
  }
  function svgMirror(slant) {
    var line = slant === 0 ? '<line x1="24" y1="76" x2="76" y2="24"/>' : '<line x1="24" y1="24" x2="76" y2="76"/>';
    var caps = slant === 0
      ? '<circle cx="24" cy="76" r="7.5"/><circle cx="76" cy="24" r="7.5"/>'
      : '<circle cx="24" cy="24" r="7.5"/><circle cx="76" cy="76" r="7.5"/>';
    return '<svg viewBox="0 0 100 100" aria-hidden="true">' +
      '<rect x="10" y="10" width="80" height="80" rx="12" fill="#fdfaf0" stroke="#cbbd93" stroke-width="2.5"/>' +
      '<g stroke="#aeb9c2" stroke-width="13" stroke-linecap="round">' + line + '</g>' +
      '<g stroke="#e8eef2" stroke-width="5" stroke-linecap="round">' + line + '</g>' +
      '<g fill="#71808b">' + caps + '</g></svg>';
  }
  function svgSluice(state) {
    return '<svg viewBox="0 0 100 100" aria-hidden="true">' +
      '<g transform="rotate(' + state * 90 + ' 50 50)">' +
      '<path d="M 50 2 Q 50 50 98 50" fill="none" stroke="#7d94a6" stroke-width="23" stroke-linecap="round"/>' +
      '<path d="M 50 2 Q 50 50 98 50" fill="none" stroke="#b9cfdf" stroke-width="10" stroke-linecap="round"/>' +
      '<circle cx="50" cy="5" r="7" fill="#54687a"/><circle cx="95" cy="50" r="7" fill="#54687a"/>' +
      '<circle cx="50" cy="5" r="3.2" fill="#d7e6f2"/><circle cx="95" cy="50" r="3.2" fill="#d7e6f2"/></g></svg>';
  }
  function svgSeed(seedState) {
    // seedState: {need, light, water, ok}
    var leaf = seedState.ok ? "#5d8a4a" : (seedState.light ? "#8fae4d" : "#a9b39a");
    var leaf2 = seedState.ok ? "#4c7a3d" : (seedState.water ? "#7d9b6d" : "#98a58c");
    var flower = "";
    if (seedState.ok) {
      var petals = "";
      for (var i = 0; i < 5; i++) petals += '<circle cx="50" cy="16" r="7.5" fill="#e58bb1" transform="rotate(' + i * 72 + ' 50 30)"/>';
      flower = petals + '<circle cx="50" cy="30" r="6" fill="#e9a83b"/>';
    }
    return '<svg viewBox="0 0 100 100" aria-hidden="true">' +
      '<path d="M 22 88 Q 50 76 78 88 L 74 97 L 26 97 Z" fill="#c4703f"/>' +
      '<path d="M 50 88 Q 48 60 50 38" fill="none" stroke="#5d7a43" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M 50 62 Q 30 58 26 42 Q 44 44 50 62" fill="' + leaf + '"/>' +
      '<path d="M 50 54 Q 70 50 74 34 Q 56 36 50 54" fill="' + leaf2 + '"/>' +
      flower + '</svg>';
  }
  function svgRock() {
    return '<svg viewBox="0 0 100 100" aria-hidden="true">' +
      '<path d="M 18 72 Q 10 44 34 32 Q 52 16 72 30 Q 90 42 82 72 Q 50 84 18 72 Z" fill="#b3a88f" stroke="#978a6e" stroke-width="3"/></svg>';
  }
  function cellArt(g, x, y, states, evalSeed) {
    var cell = g.cells[Core.key(x, y)];
    if (cell) {
      if (cell.t === "sun") return svgSun(cell.dir);
      if (cell.t === "tap") return svgTap(cell.dir);
      if (cell.t === "rock") return svgRock();
      if (cell.t === "seed") return svgSeed(evalSeed || { need: cell.need, light: false, water: false, ok: false });
    }
    return "";
  }
  function needsBadges(seedState) {
    var out = "";
    if (!seedState) return out;
    if (seedState.need === "L" || seedState.need === "B")
      out += '<span class="gh-need need-light' + (seedState.light ? " met" : "") + '"></span>';
    if (seedState.need === "W" || seedState.need === "B")
      out += '<span class="gh-need need-water' + (seedState.water ? " met" : "") + '"></span>';
    return '<span class="gh-needs">' + out + '</span>';
  }

  /* ---------------- session state ---------------- */
  var session = null; // {mode, startedAt, score, gardensCleared, seedBase, idx, drought, recorded}
  var current = null; // {garden, states, taps, startedAt, key, solved, par}

  function gardenScore(g, taps, par) {
    var seeds = Core.seedList(g).length;
    var perfect = taps <= par;
    return { score: 200 + 40 * seeds + (perfect ? 150 : 0), perfect: perfect };
  }

  function startSession(mode, drought) {
    session = {
      mode: mode, startedAt: Date.now(), score: 0, gardensCleared: 0,
      seedBase: mode === "endless" ? "endless-" + Date.now().toString(36) + "-" + ((Math.random() * 1e6) | 0) : null,
      idx: 0, drought: !!drought, recorded: false
    };
    API.logEvent("game_start", SLUG, { mode: mode, drought: session.drought });
  }

  function generatedFor(mode, idx, drought) {
    var seedKey, tries = 0, g = null;
    if (mode === "daily") seedKey = "daily-" + todayStr();
    else seedKey = session.seedBase + "-" + idx;
    while (!g && tries < 40) {
      g = Core.generateGarden(seedKey + (tries ? "-r" + tries : ""), { drought: drought });
      tries++;
    }
    return { garden: g, key: seedKey };
  }

  /* ---------------- board rendering ---------------- */
  function boardHTML(g) {
    var cellsHtml = "";
    for (var y = 0; y < g.h; y++) for (var x = 0; x < g.w; x++) {
      var k = Core.key(x, y);
      var ri = g.rots.findIndex(function (r) { return r.x === x && r.y === y; });
      var cell = g.cells[k];
      if (ri >= 0) {
        cellsHtml += '<button type="button" class="gh-cell rot" data-rot="' + ri + '" data-x="' + x + '" data-y="' + y +
          '" aria-label="Rotate the ' + (g.rots[ri].kind === "mir" ? "mirror" : "sluice") + ' at column ' + (x + 1) + ', row ' + (y + 1) + '">' +
          '<span class="piece" data-piece="' + ri + '"></span></button>';
      } else {
        cellsHtml += '<div class="gh-cell' + (cell && cell.t === "rock" ? " rock" : "") + '" data-cell="' + k + '">' +
          '<span class="art" data-art="' + k + '"></span><span data-badges="' + k + '"></span></div>';
      }
    }
    return '<div class="gh-board-frame"><div class="gh-board" id="gh-board">' +
      '<div class="gh-grid" style="grid-template-columns: repeat(' + g.w + ', 1fr);">' + cellsHtml + '</div>' +
      '<svg class="gh-beams" id="gh-beams" viewBox="0 0 ' + g.w * 100 + ' ' + g.h * 100 + '" preserveAspectRatio="none" aria-hidden="true"></svg>' +
      '</div></div>';
  }

  function pieceHTML(g, ri, state) {
    var r = g.rots[ri];
    if (r.kind === "mir") return svgMirror(state);
    return svgSluice(state);
  }

  function updateBoard() {
    if (!current) return;
    var g = current.garden;
    var ev = Core.evaluate(g, current.states, { drought: session && session.drought });
    // pieces
    g.rots.forEach(function (r, ri) {
      var el = root.querySelector('[data-piece="' + ri + '"]');
      if (el) el.innerHTML = pieceHTML(g, ri, current.states[ri]);
    });
    // fixed cells + seedling states
    var seedByKey = {};
    ev.seeds.forEach(function (s) { seedByKey[Core.key(s.x, s.y)] = s; });
    Object.keys(g.cells).forEach(function (k) {
      var parts = k.split(","), x = +parts[0], y = +parts[1];
      var artEl = root.querySelector('[data-art="' + k + '"]');
      if (artEl) artEl.innerHTML = cellArt(g, x, y, current.states, seedByKey[k]);
      var badgeEl = root.querySelector('[data-badges="' + k + '"]');
      if (badgeEl) badgeEl.innerHTML = g.cells[k].t === "seed" ? needsBadges(seedByKey[k]) : "";
    });
    // beams
    var beams = "";
    function pts(path) { return path.map(function (p) { return (p[0] * 100 + 50) + "," + (p[1] * 100 + 50); }).join(" "); }
    ev.sim.lightPaths.forEach(function (p) {
      beams += '<polyline class="beam-light" points="' + pts(p) + '"/><polyline class="beam-light-core flow" points="' + pts(p) + '"/>';
    });
    ev.sim.waterPaths.forEach(function (p) {
      beams += '<polyline class="beam-water" points="' + pts(p) + '"/><polyline class="beam-water-core flow" points="' + pts(p) + '"/>';
    });
    var beamEl = document.getElementById("gh-beams");
    if (beamEl) beamEl.innerHTML = beams;
    // stats
    var stats = document.getElementById("gh-stats");
    if (stats) stats.textContent = "Taps " + current.taps + " · Par " + current.par +
      (session && session.mode !== "season" ? " · Session score " + session.score : "");
    return ev;
  }

  function saveMid() {
    if (!current || current.solved) { save.mid = null; storeSave(); return; }
    save.mid = {
      mode: session.mode, key: current.key, states: current.states.slice(),
      taps: current.taps, drought: !!session.drought,
      score: session.score, gardensCleared: session.gardensCleared,
      seedBase: session.seedBase, idx: session.idx
    };
    storeSave();
  }

  function loadGarden(garden, key, opts) {
    opts = opts || {};
    var drought = !!(session && session.drought);
    var solved = Core.solve(garden, { drought: drought });
    current = {
      garden: garden, key: key, taps: opts.taps || 0,
      states: opts.states ? opts.states.slice() : Core.startStates(garden),
      startedAt: Date.now(), solved: false,
      par: drought ? (garden.droughtPar != null ? garden.droughtPar : (solved ? solved.taps : garden.par)) :
                     (garden.par != null ? garden.par : (solved ? solved.taps : 0))
    };
    var modeTag = session.mode === "season" ? "The season · garden " + (session.idx + 1) + " of " + Core.GARDENS.length :
      session.mode === "daily" ? "Today's garden" + (session.drought ? " · Drought" : "") :
      "Endless gardens" + (session.drought ? " · Drought" : "");
    root.innerHTML = '<div class="gh-wrap">' +
      '<div class="gh-topbar"><div><p class="gh-kicker">' + esc(modeTag) + '</p>' +
      '<span class="gh-garden-name">' + esc(garden.name) + '</span></div>' +
      '<div><span class="gh-stats" id="gh-stats"></span></div></div>' +
      (garden.intro ? '<p class="gh-muted gh-small">' + esc(garden.intro) + '</p>' : "") +
      boardHTML(garden) +
      '<div class="gh-btn-row">' +
      '<button class="gh-icon-btn" id="gh-reset" type="button">Start this garden over</button>' +
      '<button class="gh-icon-btn" id="gh-sound" type="button">' + (Sound.isMuted() ? "Sound: off" : "Sound: on") + '</button>' +
      (session.mode === "endless" ? '<button class="gh-icon-btn" id="gh-finish" type="button">Finish the session</button>' : "") +
      '<button class="gh-icon-btn" id="gh-leave" type="button">Back to the start screen</button>' +
      '</div><div id="gh-clear"></div></div>';

    root.querySelectorAll("[data-rot]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (current.solved) return;
        Sound.unlock();
        var ri = +btn.getAttribute("data-rot");
        var cyc = current.garden.rots[ri].kind === "mir" ? 2 : 4;
        var before = Core.evaluate(current.garden, current.states, { drought: session.drought });
        current.states[ri] = (current.states[ri] + 1) % cyc;
        current.taps += 1;
        Sound.tick(current.garden.rots[ri].kind);
        var ev = updateBoard();
        // a seedling that just became fully served gets its pluck
        ev.seeds.forEach(function (s, i) {
          var was = before.seeds[i];
          if (s.ok && !(was && was.ok)) Sound.served(i);
        });
        saveMid();
        if (ev.solved) onGardenSolved();
      });
    });
    document.getElementById("gh-reset").addEventListener("click", function () {
      current.states = Core.startStates(current.garden);
      current.taps = 0;
      updateBoard(); saveMid();
    });
    document.getElementById("gh-sound").addEventListener("click", function (e) {
      var m = Sound.toggle();
      e.target.textContent = m ? "Sound: off" : "Sound: on";
    });
    document.getElementById("gh-leave").addEventListener("click", function () { saveMid(); showStart(); });
    var fin = document.getElementById("gh-finish");
    if (fin) fin.addEventListener("click", function () { finishEndless(); });
    updateBoard();
  }

  function onGardenSolved() {
    current.solved = true;
    var g = current.garden;
    var gs = gardenScore(g, current.taps, current.par);
    var elapsed = Date.now() - current.startedAt;
    Sound.clear();
    var board = document.getElementById("gh-board");
    if (board) board.classList.add("solved");
    root.querySelectorAll("[data-rot]").forEach(function (b) { b.disabled = true; });
    API.logEvent("garden_clear", SLUG, {
      garden: current.key, mode: session.mode, drought: !!session.drought,
      taps: current.taps, par: current.par, perfect: gs.perfect, score: gs.score, ms: elapsed
    });
    save.mid = null; storeSave();

    if (session.mode === "season") {
      var prev = save.season.best[g.id];
      if (!prev || gs.score > prev.score) save.season.best[g.id] = { score: gs.score, taps: current.taps };
      if (gs.perfect) save.season.perfects[g.id] = true;
      storeSave();
      // The moment the twelfth garden first falls, the run is recorded
      // to the passport — the board button afterwards only adds a name.
      if (seasonProgress().cleared >= Core.GARDENS.length && !save.season.recorded) {
        save.season.recorded = true; storeSave();
        var prog = seasonProgress();
        API.recordResult(SLUG, { finished: true, score: prog.score, medal: seasonMedal(prog.perfects) });
        API.logEvent("game_finish", SLUG, { mode: "season", score: prog.score, perfects: prog.perfects, medal: seasonMedal(prog.perfects), ms: Date.now() - session.startedAt });
      }
    } else {
      session.score += gs.score;
      session.gardensCleared += 1;
    }

    var panel = document.getElementById("gh-clear");
    var seasonDone = session.mode === "season" && seasonProgress().cleared >= Core.GARDENS.length;
    var nextLabel = session.mode === "season" ?
      (seasonDone ? "See how the season went" : "Next garden") :
      session.mode === "daily" ? "Back to the start screen" : "Next garden";
    panel.innerHTML = '<div class="gh-panel"><h2>The garden blooms.</h2>' +
      (gs.perfect ? '<span class="gh-stamp perfect">Perfect — in par</span>' : '<span class="gh-stamp">Cleared</span>') +
      '<p class="gh-score-line">' + gs.score + ' points — ' + current.taps + ' taps against a par of ' + current.par + '.</p>' +
      '<div class="gh-btn-row"><button class="gh-btn" id="gh-next" type="button">' + nextLabel + '</button>' +
      (session.mode === "endless" ? '<button class="gh-btn ghost" id="gh-finish2" type="button">Finish the session</button>' : "") +
      '</div></div>';
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    document.getElementById("gh-next").addEventListener("click", function () {
      if (session.mode === "season") {
        if (seasonProgress().cleared >= Core.GARDENS.length) { showSeasonComplete(); return; }
        var nxt = Core.GARDENS.findIndex(function (gg) { return !save.season.best[gg.id]; });
        session.idx = nxt === -1 ? 0 : nxt;
        loadGarden(Core.GARDENS[session.idx], Core.GARDENS[session.idx].id);
      } else if (session.mode === "daily") { recordDaily(gs); showStart("daily-done"); }
      else { session.idx += 1; var nx = generatedFor("endless", session.idx, session.drought); loadGarden(nx.garden, nx.key); }
    });
    var f2 = document.getElementById("gh-finish2");
    if (f2) f2.addEventListener("click", function () { finishEndless(); });
    updateBoard();
  }

  function recordDaily(gs) {
    if (save.dailyDone && save.dailyDone.date === todayStr()) return;
    save.dailyDone = { date: todayStr(), score: gs.score };
    storeSave();
    var name = API.getName() || "A player";
    API.submitScore(SLUG, "daily", { name: name, score: gs.score, detail: "Today's garden · " + current.taps + " taps" });
    API.recordResult(SLUG, { finished: false, score: gs.score, dailyStamp: todayStr() });
  }

  function finishEndless() {
    if (!session || session.mode !== "endless") return;
    if (!session.recorded) {
      session.recorded = true;
      API.recordResult(SLUG, { finished: false, score: session.score });
      API.logEvent("game_finish", SLUG, { mode: "endless", score: session.score, gardens: session.gardensCleared, ms: Date.now() - session.startedAt });
    }
    showSessionEnd();
  }

  /* ---------------- screens ---------------- */
  function seasonProgress() {
    var cleared = Core.GARDENS.filter(function (g) { return !!save.season.best[g.id]; }).length;
    var perfects = Core.GARDENS.filter(function (g) { return !!save.season.perfects[g.id]; }).length;
    var score = Core.GARDENS.reduce(function (n, g) { return n + (save.season.best[g.id] ? save.season.best[g.id].score : 0); }, 0);
    return { cleared: cleared, perfects: perfects, score: score };
  }
  function seasonMedal(perfects) {
    if (perfects >= 12) return "wren";
    if (perfects >= 8) return "gold";
    if (perfects >= 4) return "silver";
    return "bronze";
  }

  function boardTable(board, emptyText) {
    var rows = API.getBoard(SLUG, board);
    if (!rows.length) return '<p class="gh-muted">' + emptyText + '</p>';
    var html = '<table class="gh-board-table"><tr><th>Player</th><th class="num">Score</th><th>Detail</th></tr>';
    rows.slice(0, 10).forEach(function (r) {
      html += "<tr><td>" + esc(r.name) + '</td><td class="num">' + r.score + "</td><td>" + esc(r.detail) + "</td></tr>";
    });
    return html + "</table>";
  }

  function showStart(note) {
    session = null; current = null;
    var prog = seasonProgress();
    var passport = API.getPassport();
    var mine = passport.games[SLUG];
    var recordLine = mine && mine.plays ?
      '<p class="gh-muted">Your record: ' + mine.finishes + (mine.finishes === 1 ? " season" : " seasons") +
      ' finished · best medal ' + API.MEDAL_LABEL[mine.bestMedal] + ' · best score ' + mine.bestScore + '.</p>' : "";
    var seasonBtn = prog.cleared === 0 ? "Play the season" :
      prog.cleared >= 12 ? "Play the season again" : "Continue the season — " + prog.cleared + " of 12 gardens in bloom";
    var dailyDone = save.dailyDone && save.dailyDone.date === todayStr();
    var gardenList = Core.GARDENS.map(function (g, i) {
      var unlocked = i === 0 || !!save.season.best[Core.GARDENS[i - 1].id] || !!save.season.best[g.id];
      var status = save.season.perfects[g.id] ? '<span class="done">Perfect</span>' :
        save.season.best[g.id] ? '<span class="done">Cleared</span>' : unlocked ? "Open" : "Ahead";
      var btn = unlocked ? '<button class="gh-icon-btn" data-garden="' + i + '" type="button">' + (save.season.best[g.id] ? "Replay" : "Play") + '</button>' : "";
      return "<li><span>" + (i + 1) + ". " + esc(g.name) + '</span><span>' + status + " " + btn + "</span></li>";
    }).join("");

    root.innerHTML = '<div class="gh-wrap">' +
      '<p class="gh-kicker">A watercolour logic puzzle</p>' +
      '<h1 class="gh-title">Glasshouse</h1>' +
      '<p class="gh-lede">The seedlings are thirsty and the light is pointing the wrong way. Turn the mirrors and the sluices until every seedling gets what it needs.</p>' +
      recordLine +
      (note === "daily-done" ? '<div class="gh-panel"><p><strong>Today\'s garden is in bloom.</strong> It comes back fresh tomorrow; the endless gardens are below if you want more today.</p></div>' : "") +
      (save.mid ? '<div class="gh-panel"><p><strong>A garden is waiting where you left it.</strong></p><div class="gh-btn-row"><button class="gh-btn" id="gh-resume" type="button">Go back to it</button></div></div>' : "") +
      '<div class="gh-btn-row">' +
      '<button class="gh-btn" id="gh-season" type="button">' + seasonBtn + '</button>' +
      '<button class="gh-btn ghost" id="gh-endless" type="button">Endless gardens</button>' +
      '<button class="gh-btn ghost" id="gh-daily" type="button">Today\'s garden' + (dailyDone ? " (in bloom)" : "") + '</button>' +
      '<button class="gh-toggle" id="gh-drought" type="button" aria-pressed="false">Drought — for endless and today\'s garden</button>' +
      '</div>' +
      '<p class="gh-muted gh-small">In a drought the water runs dry after 8 tiles, so the wet road has to be short. The season is twelve gardens; most players finish it in about 40 minutes.</p>' +
      '<h2>How to play</h2>' +
      '<p>Tap a mirror to turn the light. Tap a sluice to turn the water. A seedling\'s badges show what it is still waiting for — a gold sun, a blue drop — and a badge dims once that need has arrived. When a seedling has everything it needs, it blooms pink; beams pass through a bloomed seedling, so a finished one never blocks the road. Bloom them all to clear the garden.</p>' +
      '<p>Clear a garden in par taps or fewer for a perfect. Pieces a beam never reaches are decoys; not every piece matters.</p>' +
      '<h2>The season</h2><ul class="gh-garden-list">' + gardenList + '</ul>' +
      '<h2>Today\'s garden — your record</h2>' + boardTable("daily", "No daily garden cleared yet. A fresh one arrives every day.") +
      '<div class="gh-btn-row"><button class="gh-icon-btn" id="gh-sound2" type="button">' + (Sound.isMuted() ? "Sound: off" : "Sound: on") + '</button></div>' +
      '</div>';

    var drought = false;
    document.getElementById("gh-drought").addEventListener("click", function (e) {
      drought = !drought;
      e.currentTarget.setAttribute("aria-pressed", drought ? "true" : "false");
    });
    document.getElementById("gh-season").addEventListener("click", function () {
      Sound.unlock();
      startSession("season", false);
      var next = Core.GARDENS.findIndex(function (g) { return !save.season.best[g.id]; });
      session.idx = next === -1 ? 0 : next;
      if (next === -1) { save.season.best = {}; save.season.perfects = {}; save.season.recorded = false; storeSave(); }
      loadGarden(Core.GARDENS[session.idx], Core.GARDENS[session.idx].id);
    });
    root.querySelectorAll("[data-garden]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        Sound.unlock();
        startSession("season", false);
        session.idx = +btn.getAttribute("data-garden");
        loadGarden(Core.GARDENS[session.idx], Core.GARDENS[session.idx].id);
      });
    });
    document.getElementById("gh-endless").addEventListener("click", function () {
      Sound.unlock();
      startSession("endless", drought);
      var f = generatedFor("endless", 0, drought);
      loadGarden(f.garden, f.key);
    });
    document.getElementById("gh-daily").addEventListener("click", function () {
      Sound.unlock();
      startSession("daily", drought);
      var f = generatedFor("daily", 0, drought);
      loadGarden(f.garden, f.key);
    });
    var resume = document.getElementById("gh-resume");
    if (resume) resume.addEventListener("click", function () {
      Sound.unlock();
      var mid = save.mid;
      startSession(mid.mode, mid.drought);
      session.score = mid.score || 0; session.gardensCleared = mid.gardensCleared || 0;
      session.seedBase = mid.seedBase; session.idx = mid.idx || 0;
      var garden;
      if (mid.mode === "season") { garden = Core.GARDENS[session.idx]; }
      else { var f = generatedFor(mid.mode, session.idx, mid.drought); garden = f.garden; }
      loadGarden(garden, mid.key, { states: mid.states, taps: mid.taps });
    });
    document.getElementById("gh-sound2").addEventListener("click", function (e) {
      var m = Sound.toggle();
      e.target.textContent = m ? "Sound: off" : "Sound: on";
    });
  }

  function nameRow(actionLabel) {
    return '<div class="gh-name-row"><input type="text" id="gh-name" maxlength="24" placeholder="A nickname for the board" value="' +
      esc(API.getName()) + '"><button class="gh-btn" id="gh-record" type="button">' + actionLabel + '</button></div>' +
      '<p class="gh-muted gh-small">Use a nickname, not your real name. The board is kept in your own browser.</p>';
  }

  function showSeasonComplete() {
    var prog = seasonProgress();
    var medal = seasonMedal(prog.perfects);
    var elapsed = session ? Date.now() - session.startedAt : 0;
    root.innerHTML = '<div class="gh-wrap">' +
      '<p class="gh-kicker">The season</p><h1 class="gh-title">The whole glasshouse blooms.</h1>' +
      '<p class="gh-lede">Twelve gardens cleared, ' + prog.perfects + ' of them perfect. ' +
      'That earns the ' + API.MEDAL_LABEL[medal] + ' and ' + prog.score + ' points' +
      (elapsed ? ' — this run took about ' + fmtMins(elapsed) : '') + '.</p>' +
      '<div id="gh-record-zone">' + nameRow("Put this run on the board") + '</div>' +
      '<div id="gh-board-zone"></div>' +
      '<div class="gh-btn-row"><button class="gh-btn ghost" id="gh-again" type="button">Back to the start screen</button>' +
      '<button class="gh-btn ghost" id="gh-card" type="button">Download a card of the season</button></div>' +
      '<canvas id="gh-share" width="1200" height="630" style="display:none"></canvas></div>';
    document.getElementById("gh-record").addEventListener("click", function () {
      var name = document.getElementById("gh-name").value.trim() || "A player";
      API.setName(name);
      API.submitScore(SLUG, "gardens", { name: name, score: prog.score, detail: "12 gardens · " + prog.perfects + " perfect" });
      document.getElementById("gh-record-zone").innerHTML = '<p><strong>On the board.</strong></p>';
      document.getElementById("gh-board-zone").innerHTML = "<h2>The season board</h2>" + boardTable("gardens", "");
    });
    document.getElementById("gh-again").addEventListener("click", function () { showStart(); });
    document.getElementById("gh-card").addEventListener("click", function () { drawShareCard(prog, medal); });
  }

  function showSessionEnd() {
    root.innerHTML = '<div class="gh-wrap">' +
      '<p class="gh-kicker">Endless gardens' + (session.drought ? " · Drought" : "") + '</p><h1 class="gh-title">The session rests.</h1>' +
      '<p class="gh-lede">' + session.gardensCleared + (session.gardensCleared === 1 ? " garden" : " gardens") +
      ' cleared for ' + session.score + ' points.</p>' +
      '<div id="gh-record-zone">' + (session.gardensCleared ? nameRow("Put this session on the board") : "") + '</div>' +
      '<div id="gh-board-zone"></div>' +
      '<div class="gh-btn-row"><button class="gh-btn ghost" id="gh-again2" type="button">Back to the start screen</button></div></div>';
    var rec = document.getElementById("gh-record");
    if (rec) rec.addEventListener("click", function () {
      var name = document.getElementById("gh-name").value.trim() || "A player";
      API.setName(name);
      API.submitScore(SLUG, "endless", { name: name, score: session.score, detail: session.gardensCleared + (session.gardensCleared === 1 ? " garden" : " gardens") + (session.drought ? " · drought" : "") });
      document.getElementById("gh-record-zone").innerHTML = '<p><strong>On the board.</strong></p>';
      document.getElementById("gh-board-zone").innerHTML = "<h2>The endless board</h2>" + boardTable("endless", "");
    });
    document.getElementById("gh-again2").addEventListener("click", function () { showStart(); });
  }

  function drawShareCard(prog, medal) {
    var cv = document.getElementById("gh-share");
    var c = cv.getContext("2d");
    var grad = c.createLinearGradient(0, 0, 1200, 630);
    grad.addColorStop(0, "#fbf6e6"); grad.addColorStop(1, "#eee1bd");
    c.fillStyle = grad; c.fillRect(0, 0, 1200, 630);
    c.strokeStyle = "#c4703f"; c.lineWidth = 6; c.strokeRect(24, 24, 1152, 582);
    c.fillStyle = "#40382a"; c.font = "700 92px Georgia, serif";
    c.fillText("Glasshouse", 70, 150);
    c.font = "34px Georgia, serif"; c.fillStyle = "#7a6c55";
    c.fillText("The whole season in bloom — a Wrenworks Arcade game", 70, 215);
    c.fillStyle = "#40382a"; c.font = "700 64px Georgia, serif";
    c.fillText(prog.score + " points", 70, 340);
    c.font = "40px Georgia, serif";
    c.fillText("12 gardens cleared · " + prog.perfects + " perfect · " + API.MEDAL_LABEL[medal], 70, 415);
    // a row of little sprouts
    for (var i = 0; i < 12; i++) {
      var x = 90 + i * 88, y = 520;
      c.strokeStyle = "#5d7a43"; c.lineWidth = 6;
      c.beginPath(); c.moveTo(x, y + 40); c.quadraticCurveTo(x - 2, y + 16, x, y); c.stroke();
      c.fillStyle = i < prog.perfects ? "#e58bb1" : "#5d8a4a";
      c.beginPath(); c.arc(x, y - 4, 11, 0, Math.PI * 2); c.fill();
    }
    c.fillStyle = "#7a6c55"; c.font = "28px Georgia, serif";
    c.fillText("wrenly40.github.io", 70, 585);
    var a = document.createElement("a");
    a.download = "glasshouse-season.png";
    a.href = cv.toDataURL("image/png");
    a.click();
  }

  /* ---------------- boot ---------------- */
  showStart();
})();
