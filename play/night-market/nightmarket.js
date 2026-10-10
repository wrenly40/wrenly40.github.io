/* Night Market — browser game. All rules live in NightMarketCore;
 * this file is rendering, input, sound and the arcade wiring. */
(function () {
  "use strict";
  var Core = window.NightMarketCore;
  var API = window.ArcadeAPI;
  var SLUG = "night-market";
  var root = document.getElementById("game");

  function esc(s) { return String(s).replace(/</g, "&lt;"); }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /* ---------------- sound (synthesized, persisted mute) ---------------- */
  var muted = false;
  try { muted = window.localStorage.getItem("nightmarket.muted") === "1"; } catch (e) {}
  var AC = null, bedNodes = null;
  function ac() {
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (AC && AC.state === "suspended") AC.resume();
    return AC;
  }
  function tone(freq, dur, type, vol, when, slideTo) {
    if (muted) return;
    var ctx = ac(); if (!ctx) return;
    var t0 = ctx.currentTime + (when || 0);
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || "sine"; o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.12, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function noiseBurst(dur, vol, when) {
    if (muted) return;
    var ctx = ac(); if (!ctx) return;
    var t0 = ctx.currentTime + (when || 0);
    var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 1800;
    var g = ctx.createGain(); g.gain.value = vol || 0.05;
    src.connect(f); f.connect(g); g.connect(ctx.destination);
    src.start(t0);
  }
  var Snd = {
    click: function () { tone(660, 0.05, "triangle", 0.05); },
    dice: function () { for (var i = 0; i < 5; i++) noiseBurst(0.03, 0.06, i * 0.055); },
    place: function () { tone(196, 0.12, "triangle", 0.14); tone(294, 0.1, "sine", 0.08, 0.03); },
    coin: function () { tone(1320, 0.07, "square", 0.04); tone(1760, 0.09, "square", 0.035, 0.05); },
    flip: function () { tone(520, 0.08, "triangle", 0.08, 0, 880); },
    shot: function (face) {
      if (face === 5) { noiseBurst(0.16, 0.07); tone(880, 0.2, "sawtooth", 0.03, 0, 220); }
      else if (face === 4) { tone(150, 0.12, "square", 0.07, 0, 90); }
      else if (face === 3) { tone(1175, 0.18, "sine", 0.05); }
      else tone(740, 0.05, "square", 0.025);
    },
    hit: function () { noiseBurst(0.04, 0.035); },
    kill: function () { tone(523, 0.09, "triangle", 0.07); tone(784, 0.12, "triangle", 0.06, 0.06); },
    leak: function () { tone(392, 0.25, "sine", 0.12, 0, 196); tone(262, 0.35, "sine", 0.1, 0.08, 131); },
    dawn: function () { var n = [523, 659, 784, 1047]; for (var i = 0; i < n.length; i++) tone(n[i], 0.22, "triangle", 0.08, i * 0.11); },
    lost: function () { var n = [330, 262, 196]; for (var i = 0; i < n.length; i++) tone(n[i], 0.3, "sine", 0.09, i * 0.16); },
    bedStart: function () {
      if (muted || bedNodes) return;
      var ctx = ac(); if (!ctx) return;
      var g = ctx.createGain(); g.gain.value = 0.016; g.connect(ctx.destination);
      var o1 = ctx.createOscillator(); o1.type = "sine"; o1.frequency.value = 110;
      var o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = 165.2;
      o1.connect(g); o2.connect(g); o1.start(); o2.start();
      bedNodes = { g: g, o1: o1, o2: o2 };
    },
    bedStop: function () {
      if (!bedNodes) return;
      try { bedNodes.o1.stop(); bedNodes.o2.stop(); bedNodes.g.disconnect(); } catch (e) {}
      bedNodes = null;
    }
  };
  function setMuted(m) {
    muted = m;
    try { window.localStorage.setItem("nightmarket.muted", m ? "1" : "0"); } catch (e) {}
    if (m) Snd.bedStop();
    var b = document.getElementById("nm-sound");
    if (b) b.textContent = m ? "Sound: off" : "Sound: on";
  }

  /* ---------------- save ----------------
   * Defensive by design: an unreadable or partial save merges into
   * defaults field by field — never rejected wholesale. */
  var SAVE_KEY = "nightmarket.save.v1";
  function defaultSave() {
    return { v: 1, unlocked: 1, nights: {}, campaignDone: false, endlessBest: 0 };
  }
  function loadSave() {
    var s = defaultSave();
    try {
      var raw = JSON.parse(window.localStorage.getItem(SAVE_KEY) || "null");
      if (!raw || typeof raw !== "object") return s;
      if (typeof raw.unlocked === "number") s.unlocked = Math.min(7, Math.max(1, raw.unlocked));
      if (raw.nights && typeof raw.nights === "object") {
        Object.keys(raw.nights).forEach(function (k) {
          var n = raw.nights[k];
          if (n && typeof n === "object") {
            s.nights[k] = {
              best: typeof n.best === "number" ? n.best : 0,
              leaks: typeof n.leaks === "number" ? n.leaks : null,
              star: !!n.star
            };
          }
        });
      }
      s.campaignDone = !!raw.campaignDone;
      if (typeof raw.endlessBest === "number") s.endlessBest = raw.endlessBest;
    } catch (e) {}
    return s;
  }
  function storeSave(s) {
    try { window.localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch (e) {}
  }
  var save = loadSave();

  /* ---------------- mid-night snapshot (FD-030) ----------------
   * A refreshed page must never mean starting from scratch: at
   * every build-phase change the whole night is snapshotted, and a
   * night in progress restores exactly on the next visit. */
  var SNAP_KEY = "nightmarket.midnight.v1";
  function snapshotNight() {
    if (!session || session.marching || !session.state) return;
    if (session.state.phase !== "build") return;
    try {
      window.localStorage.setItem(SNAP_KEY, JSON.stringify({
        v: 1, mode: session.mode, nightIndex: session.nightIndex,
        elapsedMs: Date.now() - session.startedAt,
        state: Core.serializeState(session.state)
      }));
    } catch (e) {}
  }
  function clearSnapshot() {
    try { window.localStorage.removeItem(SNAP_KEY); } catch (e) {}
  }
  function restoreSnapshot() {
    try {
      var snap = JSON.parse(window.localStorage.getItem(SNAP_KEY) || "null");
      if (!snap || snap.v !== 1 || !snap.state) return false;
      var st = Core.deserializeState(snap.state);
      if (!st || st.phase !== "build") { clearSnapshot(); return false; }
      session = {
        mode: snap.mode, nightIndex: snap.nightIndex, config: st.config, state: st,
        startedAt: Date.now() - (snap.elapsedMs || 0),
        selectedDie: -1, marching: false, fast: false, tokenEls: {}
      };
      API.logEvent("game_resume", SLUG, { mode: snap.mode, night: st.config.id, round: st.round });
      Snd.bedStart();
      renderPlay(true);
      return true;
    } catch (e) { return false; }
  }

  function campaignTotals() {
    var best = 0, leaks = 0, allCleared = true, allStar = true;
    Core.NIGHTS.forEach(function (n) {
      var rec = save.nights[n.id];
      if (!rec || typeof rec.leaks !== "number") { allCleared = false; allStar = false; return; }
      best += rec.best;
      leaks += rec.leaks;
      if (!rec.star) allStar = false;
    });
    return { best: best, leaks: leaks, allCleared: allCleared, allStar: allStar };
  }
  function campaignMedal() {
    var t = campaignTotals();
    if (!t.allCleared) return null;
    if (t.allStar) return "wren";
    if (t.leaks <= 4) return "gold";
    if (t.leaks <= 10) return "silver";
    return "bronze";
  }

  /* ---------------- art (inline SVG, drawn for this game) ---------------- */
  var AWNING = { 1: "#e8b04b", 2: "#f2f0e6", 3: "#7fb6a4", 4: "#d96f4e", 5: "#b46fd9", 6: "#5e7fc9" };
  function stallSVG(face) {
    var a = AWNING[face];
    var icon = "";
    if (face === 1) icon = '<circle cx="40" cy="52" r="6" fill="#e8c98a"/><circle cx="52" cy="55" r="5" fill="#d9ae62"/>';
    if (face === 2) icon = '<rect x="44" y="42" width="12" height="15" rx="3" fill="#ffd97a"/><rect x="48" y="38" width="4" height="4" fill="#8a6d3b"/>';
    if (face === 3) icon = '<path d="M44 56 a6 7 0 1 1 12 0 Z" fill="#cfd8dc"/><rect x="48" y="47" width="4" height="4" fill="#90a4ae"/>';
    if (face === 4) icon = '<path d="M40 57 h20 l-3 -11 h-14 Z" fill="#90a4ae"/><path d="M46 42 q4 -4 8 0" stroke="#90a4ae" fill="none" stroke-width="2"/>';
    if (face === 5) icon = '<g stroke="#ffd97a" stroke-width="2"><path d="M50 40 v14 M42 46 l16 8 M58 46 l-16 8"/></g><circle cx="50" cy="50" r="3" fill="#ffd97a"/>';
    if (face === 6) icon = '<path d="M56 40 a9 10 0 1 0 4 16 a11 12 0 0 1 -4 -16Z" fill="#f4e9c8"/>';
    return '<svg viewBox="0 0 100 78" class="nm-stall-art" aria-hidden="true">' +
      '<path d="M18 30 L50 16 L82 30 L76 38 L50 27 L24 38 Z" fill="' + a + '"/>' +
      '<rect x="24" y="38" width="52" height="6" fill="' + a + '" opacity="0.75"/>' +
      '<rect x="28" y="44" width="5" height="26" fill="#6d4c41"/><rect x="67" y="44" width="5" height="26" fill="#6d4c41"/>' +
      '<rect x="26" y="58" width="48" height="9" rx="2" fill="#8d6e63"/>' + icon + '</svg>' +
      '<span class="nm-face-badge">' + face + '</span>';
  }
  function enemySVG(type) {
    if (type === "moth") return '<svg viewBox="0 0 60 44" class="nm-enemy-art" aria-hidden="true"><ellipse cx="18" cy="18" rx="13" ry="8" fill="#e8e3d5" opacity="0.9" transform="rotate(-24 18 18)"/><ellipse cx="42" cy="18" rx="13" ry="8" fill="#e8e3d5" opacity="0.9" transform="rotate(24 42 18)"/><ellipse cx="30" cy="24" rx="5" ry="10" fill="#b8ab8d"/><circle cx="30" cy="13" r="4" fill="#8d7d5f"/></svg>';
    if (type === "rat") return '<svg viewBox="0 0 60 44" class="nm-enemy-art" aria-hidden="true"><path d="M6 36 Q22 40 34 34" stroke="#9e8fa8" stroke-width="3" fill="none"/><ellipse cx="36" cy="28" rx="15" ry="9" fill="#7a7186"/><circle cx="50" cy="22" r="7" fill="#7a7186"/><circle cx="47" cy="16" r="3.4" fill="#9e8fa8"/><circle cx="52" cy="24" r="1.6" fill="#ffd9d9"/></svg>';
    return '<svg viewBox="0 0 60 44" class="nm-enemy-art" aria-hidden="true"><path d="M30 4 L46 16 L44 40 L16 40 L14 16 Z" fill="#2c2a3d"/><circle cx="24" cy="21" r="2.6" fill="#ffd97a"/><circle cx="36" cy="21" r="2.6" fill="#ffd97a"/><path d="M22 33 Q30 29 38 33" stroke="#4a4666" stroke-width="2" fill="none"/></svg>';
  }
  function pips(face) {
    var pos = { 1: [50, 50], 2: [32, 32, 68, 68], 3: [30, 30, 50, 50, 70, 70], 4: [32, 32, 68, 32, 32, 68, 68, 68], 5: [30, 30, 70, 30, 50, 50, 30, 70, 70, 70], 6: [32, 28, 32, 50, 32, 72, 68, 28, 68, 50, 68, 72] };
    var p = pos[face] || pos[1], out = "";
    if (face === 1) return '<span class="pip" style="left:50%;top:50%"></span>';
    for (var i = 0; i < p.length; i += 2) out += '<span class="pip" style="left:' + p[i] + '%;top:' + p[i + 1] + '%"></span>';
    return out;
  }
  function dieHTML(face, extraClass) {
    var st = Core.STALLS[face];
    return '<span class="nm-die-face">' + pips(face) + '</span>' +
      '<span class="nm-die-name" style="border-color:' + AWNING[face] + '">' + esc(st.name) + '</span>' +
      (extraClass ? "" : "");
  }
  function stallBlurb(face) {
    var st = Core.STALLS[face];
    var bits = [st.dmg + " damage", "reaches " + st.range + " columns east"];
    if (st.period > 1) bits.push("fires every other step");
    else bits.push("fires every step");
    if (st.splash) bits.push("splashes 2 damage onto the things beside its target");
    if (st.chill) bits.push("things it hits skip their next step west");
    return bits.join(" · ") + ".";
  }

  /* ---------------- start screen ---------------- */
  var session = null; // {mode, config, state, startedAt, selectedDie, marching, replayMods}

  function soundBtnHTML() {
    return '<button class="nm-quiet-btn" id="nm-sound">' + (muted ? "Sound: off" : "Sound: on") + "</button>";
  }
  function bindSound() {
    var b = document.getElementById("nm-sound");
    if (b) b.addEventListener("click", function () { setMuted(!muted); Snd.click(); });
  }

  function showStart() {
    Snd.bedStop();
    session = null;
    var medal = campaignMedal();
    var totals = campaignTotals();
    var heldCount = Core.NIGHTS.filter(function (n) {
      var r = save.nights[n.id];
      return r && typeof r.leaks === "number";
    }).length;
    var passport = API.getPassport();
    var dailyDoneToday = !!(passport.dailyStamps && passport.dailyStamps[todayStr()]);
    var nightsHTML = Core.NIGHTS.map(function (n, i) {
      var rec = save.nights[n.id];
      var locked = i + 1 > save.unlocked;
      var label = "Night " + (i + 1) + " — " + esc(n.name);
      var meta = locked ? "Locked" :
        rec ? ("Best " + rec.best + (rec.star ? " · ★ no-leak" : "") + (typeof rec.leaks === "number" ? " · best leaks " + rec.leaks : "")) :
        "Not held yet";
      return '<button class="nm-night-row" data-night="' + i + '"' + (locked ? " disabled" : "") + ">" +
        '<span class="nm-night-name">' + label + "</span>" +
        '<span class="nm-night-meta">' + meta + "</span></button>";
    }).join("");
    root.innerHTML =
      '<div class="nm-panel nm-start">' +
      '<div class="nm-topbar"><p class="kicker">Wrenworks Arcade</p>' + soundBtnHTML() + "</div>" +
      '<h1 class="nm-title">Night Market</h1>' +
      '<p class="nm-tagline">The night things are coming for the lantern tree. Roll the market dice, ' +
      "raise your stalls, and hold the square until dawn.</p>" +
      (medal ? '<p class="nm-medal-line">Campaign held — your medal: <strong>' + esc(API.MEDAL_LABEL[medal]) + "</strong>" +
        " · campaign best " + totals.best + " · total best leaks " + totals.leaks + "</p>" : "") +
      (!medal && heldCount ? '<p class="nm-medal-line">' + heldCount + " of 7 nights held · total best leaks so far: " +
        totals.leaks + " — silver needs 10 or fewer in total, gold 4.</p>" : "") +
      '<h2 class="nm-h">The campaign — seven nights</h2>' +
      '<div class="nm-night-list">' + nightsHTML + "</div>" +
      '<h2 class="nm-h">Other ways to keep the market</h2>' +
      '<div class="nm-mode-row">' +
      '<button class="nm-mode-btn" id="nm-daily">Tonight\'s Night<span>One seeded night, the same for every keeper today.' +
      (dailyDoneToday ? " Held today ✓" : "") + "</span></button>" +
      '<button class="nm-mode-btn" id="nm-endless">The Long Night<span>No dawn. Hold as many hours as you can.' +
      (save.endlessBest ? " Best: " + save.endlessBest + "." : "") + "</span></button>" +
      "</div>" +
      '<button class="nm-quiet-btn" id="nm-how">How to play</button>' +
      '<div id="nm-how-body" hidden>' + howToPlayHTML() + "</div>" +
      "</div>";
    bindSound();
    root.querySelectorAll("[data-night]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        Snd.click();
        showNightIntro(parseInt(btn.getAttribute("data-night"), 10), {});
      });
    });
    document.getElementById("nm-daily").addEventListener("click", function () {
      Snd.click();
      showModeIntro("daily", Core.dailyConfig(todayStr()));
    });
    document.getElementById("nm-endless").addEventListener("click", function () {
      Snd.click();
      showModeIntro("endless", Core.endlessConfig());
    });
    document.getElementById("nm-how").addEventListener("click", function () {
      var body = document.getElementById("nm-how-body");
      body.hidden = !body.hidden;
      Snd.click();
    });
  }

  function howToPlayHTML() {
    var stalls = [1, 2, 3, 4, 5, 6].map(function (f) {
      var st = Core.STALLS[f];
      return '<li><span class="nm-how-face" style="border-color:' + AWNING[f] + '">' + f + "</span> <strong>" +
        esc(st.name) + "</strong> — " + stallBlurb(f) + "</li>";
    }).join("");
    return '<div class="nm-how">' +
      "<p>The square has five lanes. Night things enter at the east gate (the right edge) and walk west, " +
      "toward the lantern tree. If one steps past the last column it steals lanterns — a moth or a rat takes one, " +
      "a shade takes two. Lose all " + "10" + " lanterns and the night is lost. Hold every hour until dawn and the night is yours.</p>" +
      "<p><strong>Each hour</strong> works the same way. The hour's things arrive at the gate. You roll <strong>four market dice</strong>. " +
      "Each die's face <em>is</em> a stall: spend the die to raise that stall on any empty plot. Then the march: your stalls fire twice, " +
      "and after each firing the things step west. Stalls shoot east along their own lane at the most advanced thing in reach. " +
      "Nothing west of a stall can be hit by it — once a thing slips past one of your stalls, that stall is done with it.</p>" +
      "<ul>" + stalls + "</ul>" +
      "<p><strong>Coins.</strong> A die you don't spend is banked for 1 coin when the march begins. Every kill pays its bounty " +
      "(moth 1, rat 1, shade 2). And the keeper's mercy: <strong>any die can be flipped to any face for 3 coins</strong> — " +
      "so no roll, however unkind, can strand the market.</p>" +
      "<p><strong>Watch for:</strong> a hurt rat <em>scampers</em> one column west unless the hit chilled it — one strong hit beats two small ones. " +
      "Bell-chilled things skip their next step. On later nights some things slip in through the <strong>side alley</strong>, halfway across the square. " +
      "In <strong>fog</strong>, every stall sees one column less. On a <strong>festival</strong> night the crowds are bigger and every kill pays an extra coin.</p>" +
      "<p><strong>Scoring, each night:</strong> 10 per kill, 100 per lantern still lit at dawn, 1 per coin left, 150 for holding the night, " +
      "250 more for a night with no leaks at all. Fog and festival nights pay a quarter extra. " +
      "Finish all seven nights for the campaign medal: bronze for holding them, silver for ten or fewer leaks in your best runs, " +
      "gold for four or fewer, and the Wren medal when every night has a no-leak best — a leaked night can always be replayed clean.</p>" +
      "</div>";
  }

  /* ---------------- night intro ---------------- */
  function modifierLine(config) {
    if (config.modifier === "fog") return '<p class="nm-mod-line">🌫 <strong>Fog:</strong> every stall sees one column less tonight. Scores pay a quarter extra.</p>';
    if (config.modifier === "festival") return '<p class="nm-mod-line">🎉 <strong>Festival:</strong> bigger crowds, and every kill pays an extra coin. Scores pay a quarter extra.</p>';
    return "";
  }
  function factsLine(config) {
    var rounds = config.rounds === Infinity ? "as many as you can hold" : config.rounds + " hours";
    return '<p class="muted"> ' + rounds + " · " + config.lanterns + " lanterns · four dice an hour · " +
      config.startCoins + " coins in the purse to start.</p>";
  }
  function showNightIntro(index, mods) {
    var base = Core.NIGHTS[index];
    var config = {
      id: base.id, name: base.name, rounds: base.rounds, lanterns: base.lanterns,
      startCoins: base.startCoins, modifier: base.modifier, intro: base.intro,
      spawns: base.spawns, alley: base.alley, seed: base.id + ":campaign",
      replayMod: null
    };
    var rec = save.nights[base.id];
    var cleared = !!(rec && typeof rec.leaks === "number");
    var modToggles = "";
    if (cleared && !base.modifier) {
      config.replayMod = mods.fog ? "fog" : (mods.festival ? "festival" : null);
      if (config.replayMod) config.modifier = config.replayMod;
      modToggles = '<div class="nm-replay-mods"><p class="muted small">Held this night before? Replay it with a twist — scores pay a quarter extra:</p>' +
        '<button class="nm-quiet-btn" id="nm-mod-fog" aria-pressed="' + (mods.fog ? "true" : "false") + '">' + (mods.fog ? "🌫 Fog on ✓" : "Add fog") + "</button>" +
        '<button class="nm-quiet-btn" id="nm-mod-fest" aria-pressed="' + (mods.festival ? "true" : "false") + '">' + (mods.festival ? "🎉 Festival on ✓" : "Add festival") + "</button>" +
        "</div>";
    }
    root.innerHTML =
      '<div class="nm-panel">' +
      '<div class="nm-topbar"><p class="kicker">Night ' + (index + 1) + " of 7</p>" + soundBtnHTML() + "</div>" +
      '<h1 class="nm-title small-title">' + esc(config.name) + "</h1>" +
      '<p class="nm-tagline">' + esc(config.intro) + "</p>" +
      factsLine(config) + modifierLine(config) + modToggles +
      '<div class="nm-actions"><button class="btn large" id="nm-begin">Begin the night</button>' +
      '<button class="nm-quiet-btn" id="nm-back">Back</button></div>' +
      "</div>";
    bindSound();
    document.getElementById("nm-back").addEventListener("click", function () { Snd.click(); showStart(); });
    var bf = document.getElementById("nm-mod-fog");
    if (bf) bf.addEventListener("click", function () { showNightIntro(index, { fog: !mods.fog, festival: false }); });
    var bs = document.getElementById("nm-mod-fest");
    if (bs) bs.addEventListener("click", function () { showNightIntro(index, { fog: false, festival: !mods.festival }); });
    document.getElementById("nm-begin").addEventListener("click", function () {
      startNight("campaign", config, index);
    });
  }
  function showModeIntro(mode, config) {
    root.innerHTML =
      '<div class="nm-panel">' +
      '<div class="nm-topbar"><p class="kicker">' + (mode === "daily" ? "Daily" : "Endless") + "</p>" + soundBtnHTML() + "</div>" +
      '<h1 class="nm-title small-title">' + esc(config.name) + "</h1>" +
      '<p class="nm-tagline">' + esc(config.intro) + "</p>" +
      factsLine(config) + modifierLine(config) +
      '<div class="nm-actions"><button class="btn large" id="nm-begin">Begin the night</button>' +
      '<button class="nm-quiet-btn" id="nm-back">Back</button></div>' +
      "</div>";
    bindSound();
    document.getElementById("nm-back").addEventListener("click", function () { Snd.click(); showStart(); });
    document.getElementById("nm-begin").addEventListener("click", function () { startNight(mode, config, -1); });
  }

  /* ---------------- playing a night ---------------- */
  function startNight(mode, config, nightIndex) {
    var seed = mode === "daily" ? config.seed : config.id + ":" + Date.now();
    var state = Core.createNight(config, seed);
    session = {
      mode: mode, nightIndex: nightIndex, config: config, state: state,
      startedAt: Date.now(), selectedDie: -1, marching: false, fast: false,
      tokenEls: {}
    };
    API.logEvent("game_start", SLUG, { mode: mode, night: config.id, modifier: config.modifier || "none" });
    Core.startRound(state);
    Snd.dice();
    Snd.bedStart();
    renderPlay(true);
  }

  function hudHTML() {
    var st = session.state, cfg = session.config;
    var hours = cfg.rounds === Infinity ? "Hour " + st.round : "Hour " + st.round + " of " + cfg.rounds;
    return '<span class="nm-hud-item">🕐 ' + hours + "</span>" +
      '<span class="nm-hud-item' + (st.lanterns <= 3 ? " nm-danger" : "") + '">🏮 Lanterns: <strong>' + st.lanterns + "</strong></span>" +
      '<span class="nm-hud-item">🪙 Coins: <strong>' + st.coins + "</strong></span>" +
      '<span class="nm-hud-item">Turned back: <strong>' + st.kills + "</strong></span>" +
      '<span class="nm-hud-item">On the square: <strong>' + st.enemies.length + "</strong></span>";
  }

  function renderPlay(first) {
    var st = session.state, cfg = session.config;
    var cells = "";
    for (var lane = 0; lane < Core.LANES; lane++) {
      for (var col = 0; col < Core.COLS; col++) {
        var alleyCls = cfg.alley && col === cfg.alley.col ? " nm-alley" : "";
        cells += '<button class="nm-cell' + alleyCls + '" data-lane="' + lane + '" data-col="' + col + '" aria-label="Plot, lane ' + (lane + 1) + ", column " + (col + 1) + '"></button>';
      }
    }
    root.innerHTML =
      '<div class="nm-panel nm-play-panel">' +
      '<div class="nm-topbar"><p class="kicker">' + esc(cfg.name) + "</p>" +
      '<span class="nm-top-actions">' + soundBtnHTML() +
      '<button class="nm-quiet-btn" id="nm-abandon">' + (session.mode === "endless" ? "End the Long Night" : "Abandon night") + "</button></span></div>" +
      '<div class="nm-hud" id="nm-hud">' + hudHTML() + "</div>" +
      '<div class="nm-board-wrap">' +
      '<div class="nm-tree" title="The lantern tree"><svg viewBox="0 0 60 300" class="nm-tree-art" aria-hidden="true">' +
      '<path d="M30 300 L30 190" stroke="#5d4037" stroke-width="9"/><path d="M30 210 Q10 180 14 140 M30 200 Q50 175 46 135 M30 190 Q30 150 22 120" stroke="#5d4037" stroke-width="6" fill="none"/>' +
      '<circle cx="14" cy="128" r="10" fill="#ffca6a"/><circle cx="46" cy="122" r="10" fill="#ffb340"/><circle cx="22" cy="104" r="9" fill="#ffd97a"/><circle cx="38" cy="88" r="8" fill="#ffca6a"/>' +
      '<circle cx="30" cy="150" r="46" fill="#ffb340" opacity="0.10"/></svg>' +
      '<span class="nm-tree-count" id="nm-tree-count">' + st.lanterns + "</span></div>" +
      '<div class="nm-board" id="nm-board">' +
      '<div class="nm-grid" id="nm-grid">' + cells + "</div>" +
      '<svg class="nm-shots" id="nm-shots" viewBox="0 0 900 500" preserveAspectRatio="none" aria-hidden="true"></svg>' +
      '<div class="nm-tokens" id="nm-tokens"></div>' +
      "</div>" +
      '<div class="nm-gate" title="The east gate"><span>gate</span></div>' +
      "</div>" +
      (cfg.alley ? '<p class="muted small nm-alley-note">The dashed column is the side alley — from hour ' + cfg.alley.fromRound + ", some things slip in there.</p>" : "") +
      '<div class="nm-tray" id="nm-tray"></div>' +
      '<div class="nm-die-panel" id="nm-die-panel"></div>' +
      '<div class="nm-actions"><button class="btn large" id="nm-march">Begin the march ▸</button></div>' +
      '<p class="muted small">Pick a die, then tap a plot to raise its stall. Dice left in the tray when the march begins are banked, 1 coin each.</p>' +
      "</div>";
    bindSound();
    document.getElementById("nm-abandon").addEventListener("click", function () {
      if (session.mode === "endless") { finishEndless(false); return; }
      API.logEvent("night_abandoned", SLUG, { mode: session.mode, night: cfg.id, round: st.round });
      clearSnapshot();
      Snd.bedStop();
      showStart();
    });
    document.getElementById("nm-march").addEventListener("click", runMarch);
    document.getElementById("nm-board").addEventListener("click", function () { if (session.marching) session.fast = true; });
    root.querySelectorAll(".nm-cell").forEach(function (cell) {
      cell.addEventListener("click", function () {
        if (session.marching || session.selectedDie < 0) return;
        var lane = parseInt(cell.getAttribute("data-lane"), 10);
        var col = parseInt(cell.getAttribute("data-col"), 10);
        if (Core.doPlace(session.state, session.selectedDie, lane, col)) {
          Snd.place();
          session.selectedDie = -1;
          renderDynamic();
        }
      });
    });
    renderDynamic();
    if (first) renderTokens(true);
  }

  function renderDynamic() {
    var st = session.state;
    document.getElementById("nm-hud").innerHTML = hudHTML();
    document.getElementById("nm-tree-count").textContent = st.lanterns;
    /* stalls into cells */
    root.querySelectorAll(".nm-cell").forEach(function (cell) {
      var lane = parseInt(cell.getAttribute("data-lane"), 10);
      var col = parseInt(cell.getAttribute("data-col"), 10);
      var stall = st.stalls[Core.cellKey(lane, col)];
      if (stall) {
        var cooling = st.step < stall.nextFire;
        cell.innerHTML = '<span class="nm-stall' + (cooling ? " nm-cooling" : "") + '">' + stallSVG(stall.face) + "</span>";
        cell.classList.add("nm-occupied");
        cell.disabled = true;
      } else {
        cell.innerHTML = "";
        cell.classList.remove("nm-occupied");
        cell.disabled = session.marching || session.selectedDie < 0;
      }
    });
    renderTokens(false);
    /* dice tray */
    var tray = document.getElementById("nm-tray");
    if (st.dice.length === 0) {
      tray.innerHTML = '<p class="muted nm-tray-empty">All dice spent. Begin the march when you are ready.</p>';
    } else {
      tray.innerHTML = st.dice.map(function (face, i) {
        return '<button class="nm-die' + (i === session.selectedDie ? " nm-selected" : "") + '" data-die="' + i + '" aria-label="Die showing ' + face + ": " + esc(Core.STALLS[face].name) + '">' + dieHTML(face) + "</button>";
      }).join("");
      tray.querySelectorAll("[data-die]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          session.selectedDie = parseInt(btn.getAttribute("data-die"), 10);
          Snd.click();
          renderDynamic();
        });
      });
    }
    renderDiePanel();
    var march = document.getElementById("nm-march");
    march.disabled = session.marching;
    march.textContent = session.marching ? "The march…" : "Begin the march ▸";
    snapshotNight();
  }

  function renderDiePanel() {
    var panel = document.getElementById("nm-die-panel");
    var st = session.state;
    if (session.selectedDie < 0 || session.selectedDie >= st.dice.length) { panel.innerHTML = ""; return; }
    var face = st.dice[session.selectedDie];
    var blurb = stallBlurb(face);
    if (session.config.modifier === "fog") {
      blurb += " In tonight's fog it reaches " + Math.max(1, Core.STALLS[face].range - 1) + ".";
    }
    var flips = [1, 2, 3, 4, 5, 6].filter(function (f) { return f !== face; }).map(function (f) {
      return '<button class="nm-flip-btn" data-flip="' + f + '"' + (st.coins < Core.FLIP_COST ? " disabled" : "") + ">" + f + " · " + esc(Core.STALLS[f].name) + "</button>";
    }).join("");
    panel.innerHTML =
      '<div class="nm-die-info"><strong>' + face + " — " + esc(Core.STALLS[face].name) + ".</strong> " + esc(blurb) + "</div>" +
      '<div class="nm-flip-row"><span class="muted small">Flip this die for ' + Core.FLIP_COST + " coins" + (st.coins < Core.FLIP_COST ? " (you have " + st.coins + ")" : "") + ":</span>" + flips + "</div>";
    panel.querySelectorAll("[data-flip]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var f = parseInt(btn.getAttribute("data-flip"), 10);
        if (Core.doFlip(session.state, session.selectedDie, f)) {
          Snd.flip();
          renderDynamic();
        }
      });
    });
  }

  function renderTokens(snap) {
    var layer = document.getElementById("nm-tokens");
    if (!layer) return;
    var st = session.state;
    var seen = {};
    st.enemies.forEach(function (e, idx) {
      seen[e.id] = true;
      var el = session.tokenEls[e.id];
      if (!el) {
        el = document.createElement("div");
        el.className = "nm-token nm-token-" + e.type + (snap ? "" : " nm-arrive");
        el.innerHTML = enemySVG(e.type) + '<span class="nm-hp"><span class="nm-hp-fill"></span></span>';
        layer.appendChild(el);
        session.tokenEls[e.id] = el;
      }
      var off = (e.id % 3 - 1) * 9;
      el.style.left = "calc(" + (e.col * 100 / 9) + "% + " + off + "px)";
      el.style.top = "calc(" + (e.lane * 100 / 5) + "% + " + ((e.id % 2) * 7 - 3) + "px)";
      el.classList.toggle("nm-chilled", !!e.chilled);
      var fill = el.querySelector(".nm-hp-fill");
      if (fill) fill.style.width = Math.max(0, Math.round(e.hp / e.maxHp * 100)) + "%";
    });
    Object.keys(session.tokenEls).forEach(function (id) {
      if (!seen[id]) {
        var el = session.tokenEls[id];
        if (el.parentNode) el.parentNode.removeChild(el);
        delete session.tokenEls[id];
      }
    });
  }

  /* ---------------- the march, animated ---------------- */
  function wait(ms) { return new Promise(function (r) { setTimeout(r, session.fast ? Math.min(ms, 60) : ms); }); }

  async function runMarch() {
    if (session.marching) return;
    session.marching = true;
    session.selectedDie = -1;
    var st = session.state;
    while (st.dice.length > 0) { Core.doBank(st, 0); Snd.coin(); }
    renderDynamic();
    await wait(250);
    for (var s = 0; s < Core.MARCH_STEPS; s++) {
      var ev = Core.marchStep(st);
      animateLeaks(ev);
      drawShots(ev);
      playStepSounds(ev);
      await wait(280);
      renderDynamic();
      markDeaths(ev);
      await wait(430);
      clearShots();
      if (st.phase !== "build") break;
    }
    session.marching = false;
    session.fast = false;
    if (st.phase === "won") { nightWon(); return; }
    if (st.phase === "lost") { nightLost(); return; }
    if (st.round >= session.config.rounds) { st.phase = "won"; nightWon(); return; }
    Core.startRound(st);
    Snd.dice();
    renderDynamic();
    renderTokens(false);
  }

  function drawShots(ev) {
    var svg = document.getElementById("nm-shots");
    if (!svg) return;
    var html = "";
    ev.shots.forEach(function (sh) {
      var x1 = sh.col * 100 + 50, y1 = sh.lane * 100 + 50;
      var x2 = sh.targetCol * 100 + 50, y2 = sh.lane * 100 + 50;
      html += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" class="nm-shot-line"/>' +
        '<circle cx="' + x2 + '" cy="' + y2 + '" r="15" class="nm-shot-hit"/>';
    });
    svg.innerHTML = html;
  }
  function clearShots() {
    var svg = document.getElementById("nm-shots");
    if (svg) svg.innerHTML = "";
  }
  function playStepSounds(ev) {
    var faces = {};
    ev.shots.forEach(function (sh) { faces[sh.face] = true; });
    Object.keys(faces).forEach(function (f, i) { setTimeout(function () { Snd.shot(parseInt(f, 10)); }, i * 40); });
    if (ev.kills.length) setTimeout(function () { Snd.kill(); }, 120);
    if (ev.leaks.length) setTimeout(function () { Snd.leak(); }, 150);
    else if (ev.shots.length) setTimeout(function () { Snd.hit(); }, 100);
  }
  function animateLeaks(ev) {
    ev.leaks.forEach(function (lk) {
      var el = session.tokenEls[lk.id];
      if (!el) return;
      delete session.tokenEls[lk.id];
      el.classList.add("nm-leaking");
      el.style.left = "-14%";
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 650);
    });
  }
  function markDeaths(ev) {
    var layer = document.getElementById("nm-tokens");
    if (!layer) return;
    ev.kills.forEach(function (k) {
      var b = document.createElement("div");
      b.className = "nm-burst";
      b.style.left = "calc(" + (k.col * 100 / 9) + "%)";
      b.style.top = "calc(" + (k.lane * 100 / 5) + "%)";
      b.textContent = "✦";
      layer.appendChild(b);
      setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 700);
    });
  }

  /* ---------------- night end ---------------- */
  function endlessScore(state) {
    var completedRounds = Math.max(0, state.round - 1);
    return { total: state.scoreRaw + completedRounds * 25, rounds: completedRounds };
  }

  function statsRows(state, scoreInfo) {
    var rows = [
      ["Hours", state.phase === "won" ? session.config.rounds + " — held to dawn" : "fell in hour " + state.round],
      ["Turned back", state.kills],
      ["Leaks", state.leaks],
      ["Lanterns left", Math.max(0, state.lanterns)],
      ["Coins left", state.coins]
    ];
    return rows.map(function (r) { return '<div class="nm-stat"><span>' + r[0] + '</span><strong>' + r[1] + "</strong></div>"; }).join("");
  }
  function breakdownHTML(sc) {
    var b = sc.breakdown;
    var rows = "";
    rows += '<div class="nm-stat"><span>Turned back</span><strong>' + b.kills + "</strong></div>";
    if (b.lanterns) rows += '<div class="nm-stat"><span>Lanterns at dawn</span><strong>' + b.lanterns + "</strong></div>";
    if (b.coins) rows += '<div class="nm-stat"><span>Coins left</span><strong>' + b.coins + "</strong></div>";
    if (b.clear) rows += '<div class="nm-stat"><span>Holding the night</span><strong>' + b.clear + "</strong></div>";
    if (b.noLeak) rows += '<div class="nm-stat"><span>No-leak bonus</span><strong>' + b.noLeak + "</strong></div>";
    if (sc.multiplier !== 1) {
      rows += '<div class="nm-stat"><span>Score before the modifier bonus</span><strong>' + sc.raw + "</strong></div>";
      rows += '<div class="nm-stat"><span>Modifier bonus</span><strong>×' + sc.multiplier + "</strong></div>";
    }
    rows += '<div class="nm-stat nm-total"><span>Night score</span><strong>' + sc.total + "</strong></div>";
    return rows;
  }

  function boardBlockHTML(board, score, detail) {
    return '<div class="nm-board-block" id="nm-board-block">' +
      "<h2>Put your name on the board</h2>" +
      '<p class="muted small">This board is your own record, kept in your own browser.</p>' +
      '<div class="signup"><input type="text" id="nm-name" maxlength="24" placeholder="A nickname, not your real name" value="' + esc(API.getName()) + '">' +
      '<button class="btn" id="nm-board-btn">Add my score — ' + score + "</button></div>" +
      '<p class="muted small">' + esc(detail) + "</p></div>";
  }
  function bindBoardBlock(board, score, detail) {
    var btn = document.getElementById("nm-board-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var name = document.getElementById("nm-name").value.trim() || "A player";
      API.setName(name);
      var rows = API.submitScore(SLUG, board, { name: name, score: score, detail: detail });
      Snd.coin();
      var html = '<table class="board"><tr><th>Player</th><th class="num">Score</th><th>Detail</th></tr>';
      rows.slice(0, 10).forEach(function (r) {
        html += "<tr><td>" + esc(r.name) + '</td><td class="num">' + r.score + "</td><td>" + esc(r.detail) + "</td></tr>";
      });
      document.getElementById("nm-board-block").innerHTML = "<h2>The board</h2>" + html + "</table>";
    });
  }

  function resultsShell(opts) {
    root.innerHTML =
      '<div class="nm-panel nm-results">' +
      '<div class="nm-topbar"><p class="kicker">' + esc(opts.kicker) + "</p>" + soundBtnHTML() + "</div>" +
      '<h1 class="nm-title small-title">' + esc(opts.title) + "</h1>" +
      '<p class="nm-tagline">' + opts.sub + "</p>" +
      '<div class="nm-stats">' + opts.stats + "</div>" +
      (opts.breakdown ? '<div class="nm-stats">' + opts.breakdown + "</div>" : "") +
      (opts.extra || "") +
      '<div class="nm-actions">' + opts.actions + "</div>" +
      "</div>";
    bindSound();
    (opts.bind || function () {})();
  }

  function nightWon() {
    clearSnapshot();
    var st = session.state, cfg = session.config;
    var ms = Date.now() - session.startedAt;
    var sc = Core.scoreNight(st);
    Snd.bedStop(); Snd.dawn();
    API.logEvent("night_clear", SLUG, { mode: session.mode, night: cfg.id, score: sc.total, leaks: st.leaks, ms: ms });

    if (session.mode === "campaign") {
      var idx = session.nightIndex;
      var prev = save.nights[cfg.id] || { best: 0, leaks: null, star: false };
      save.nights[cfg.id] = {
        best: Math.max(prev.best, sc.total),
        leaks: prev.leaks === null ? st.leaks : Math.min(prev.leaks, st.leaks),
        star: prev.star || st.leaks === 0
      };
      if (idx + 2 > save.unlocked && idx + 2 <= 7) save.unlocked = idx + 2;
      var isFinal = idx === Core.NIGHTS.length - 1;
      if (isFinal && !save.campaignDone) save.campaignDone = true;
      storeSave(save);

      if (isFinal) {
        var totals = campaignTotals();
        var medal = campaignMedal();
        API.recordResult(SLUG, { finished: true, score: totals.best, medal: medal });
        API.logEvent("game_finish", SLUG, { mode: "campaign", score: totals.best, medal: medal, ms: ms });
        var detail = "Seven nights · best leaks " + totals.leaks + " · " + API.MEDAL_LABEL[medal];
        resultsShell({
          kicker: "Campaign complete",
          title: "Dawn over the market 🌅",
          sub: "All seven nights held. The lantern tree is still lit, and the market is yours. " +
            (st.leaks === 0 ? "And this last night never leaked at all. " : "") +
            "Your campaign medal: <strong>" + esc(API.MEDAL_LABEL[medal]) + "</strong>.",
          stats: statsRows(st),
          breakdown: breakdownHTML(sc),
          extra: '<canvas id="nm-card" width="1200" height="630" class="nm-card"></canvas>' +
            '<p><a id="nm-card-link" class="nm-quiet-btn" download="night-market-card.png">Download your market card</a></p>' +
            boardBlockHTML("campaign", totals.best, detail),
          actions: '<button class="btn large" id="nm-again">Walk the market again</button>',
          bind: function () {
            bindBoardBlock("campaign", totals.best, detail);
            drawShareCard(totals, medal);
            document.getElementById("nm-again").addEventListener("click", function () { Snd.click(); showStart(); });
          }
        });
        return;
      }
      var next = Core.NIGHTS[idx + 1];
      resultsShell({
        kicker: "Night " + (idx + 1) + " of 7 — held",
        title: "Dawn 🌅",
        sub: esc(cfg.name) + " is held" + (st.leaks === 0 ? " — and nothing got through. A no-leak night ★" : " — the tree lost " + st.lanternsLost + " lantern-light but still stands.") +
          " Next: <strong>" + esc(next.name) + "</strong>.",
        stats: statsRows(st),
        breakdown: breakdownHTML(sc),
        actions: '<button class="btn large" id="nm-next">Next night — ' + esc(next.name) + "</button>" +
          '<button class="nm-quiet-btn" id="nm-home">Back to the market</button>',
        bind: function () {
          document.getElementById("nm-next").addEventListener("click", function () { Snd.click(); showNightIntro(idx + 1, {}); });
          document.getElementById("nm-home").addEventListener("click", function () { Snd.click(); showStart(); });
        }
      });
      return;
    }

    if (session.mode === "daily") {
      API.recordResult(SLUG, { finished: false, score: sc.total, dailyStamp: todayStr() });
      var dDetail = "Tonight's Night · " + todayStr() + " · leaks " + st.leaks;
      resultsShell({
        kicker: "Tonight's Night — held",
        title: "Dawn 🌅",
        sub: "The seeded night is held" + (st.leaks === 0 ? " without a single leak ★" : "") + ". Your passport carries today's stamp.",
        stats: statsRows(st),
        breakdown: breakdownHTML(sc),
        extra: boardBlockHTML("daily", sc.total, dDetail),
        actions: '<button class="btn large" id="nm-home">Back to the market</button>',
        bind: function () {
          bindBoardBlock("daily", sc.total, dDetail);
          document.getElementById("nm-home").addEventListener("click", function () { Snd.click(); showStart(); });
        }
      });
      return;
    }
  }

  function nightLost() {
    clearSnapshot();
    var st = session.state, cfg = session.config;
    var ms = Date.now() - session.startedAt;
    if (session.mode === "endless") { finishEndless(true); return; }
    Snd.bedStop(); Snd.lost();
    API.logEvent("night_lost", SLUG, { mode: session.mode, night: cfg.id, round: st.round, ms: ms });
    resultsShell({
      kicker: esc(cfg.name),
      title: "The tree went dark 🌑",
      sub: "The last lantern is out in hour " + st.round + ". The stalls will be back tomorrow night — " +
        "bank more dice early, and remember a die can always be flipped for 3 coins.",
      stats: statsRows(st),
      actions: '<button class="btn large" id="nm-retry">Try the night again</button>' +
        '<button class="nm-quiet-btn" id="nm-home">Back to the market</button>',
      bind: function () {
        document.getElementById("nm-retry").addEventListener("click", function () {
          Snd.click();
          if (session.mode === "campaign") showNightIntro(session.nightIndex, {});
          else showModeIntro(session.mode, session.mode === "daily" ? Core.dailyConfig(todayStr()) : Core.endlessConfig());
        });
        document.getElementById("nm-home").addEventListener("click", function () { Snd.click(); showStart(); });
      }
    });
  }

  function finishEndless(byLoss) {
    clearSnapshot();
    var st = session.state;
    var ms = Date.now() - session.startedAt;
    var sc = endlessScore(st);
    Snd.bedStop();
    if (byLoss) Snd.lost(); else Snd.dawn();
    if (sc.total > save.endlessBest) { save.endlessBest = sc.total; storeSave(save); }
    API.recordResult(SLUG, { finished: false, score: sc.total });
    API.logEvent("game_finish", SLUG, { mode: "endless", score: sc.total, rounds: sc.rounds, ms: ms });
    var detail = sc.rounds + (sc.rounds === 1 ? " hour" : " hours") + " held · " + st.kills + " turned back";
    resultsShell({
      kicker: "The Long Night",
      title: byLoss ? "The tree went dark 🌑" : "You call it a night 🌙",
      sub: "You held the Long Night for " + sc.rounds + (sc.rounds === 1 ? " hour" : " hours") + ", turning back " + st.kills + " things.",
      stats: statsRows(st),
      breakdown: '<div class="nm-stat"><span>Turned back</span><strong>' + st.scoreRaw + '</strong></div>' +
        '<div class="nm-stat"><span>Hours held</span><strong>' + (sc.rounds * 25) + '</strong></div>' +
        '<div class="nm-stat nm-total"><span>Long Night score</span><strong>' + sc.total + "</strong></div>",
      extra: boardBlockHTML("endless", sc.total, detail),
      actions: '<button class="btn large" id="nm-home">Back to the market</button>',
      bind: function () {
        bindBoardBlock("endless", sc.total, detail);
        document.getElementById("nm-home").addEventListener("click", function () { Snd.click(); showStart(); });
      }
    });
  }

  /* ---------------- share card ---------------- */
  function drawShareCard(totals, medal) {
    var cv = document.getElementById("nm-card");
    if (!cv) return;
    var ctx = cv.getContext("2d");
    var grad = ctx.createLinearGradient(0, 0, 0, 630);
    grad.addColorStop(0, "#1b2138"); grad.addColorStop(1, "#2c2140");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 1200, 630);
    ctx.fillStyle = "#ffb340";
    [[120, 110], [300, 70], [520, 120], [760, 66], [990, 110], [1080, 190], [180, 200]].forEach(function (p) {
      ctx.beginPath(); ctx.arc(p[0], p[1], 13, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(p[0], p[1], 34, 0, 7); ctx.fillStyle = "rgba(255,179,64,0.13)"; ctx.fill();
      ctx.fillStyle = "#ffb340";
    });
    ctx.fillStyle = "#f5efe2";
    ctx.font = "700 84px Georgia, serif";
    ctx.fillText("Night Market", 90, 300);
    ctx.font = "400 40px Georgia, serif";
    ctx.fillText("The campaign is held — all seven nights.", 90, 362);
    ctx.font = "700 54px Georgia, serif";
    ctx.fillStyle = "#ffca6a";
    ctx.fillText(totals.best + " points · " + API.MEDAL_LABEL[medal], 90, 448);
    ctx.font = "400 34px Georgia, serif";
    ctx.fillStyle = "#cfc7b8";
    var stars = Core.NIGHTS.map(function (n) { return save.nights[n.id] && save.nights[n.id].star ? "★" : "☆"; }).join(" ");
    ctx.fillText("No-leak nights: " + stars, 90, 510);
    ctx.font = "400 28px Georgia, serif";
    ctx.fillText("Wrenworks Arcade · wrenly40.github.io", 90, 572);
    var link = document.getElementById("nm-card-link");
    if (link) link.href = cv.toDataURL("image/png");
  }

  /* The arcade's own test harnesses drive the real UI through this:
   * the live session, so a scripted keeper clicks the same buttons a
   * player clicks while the core makes its decisions. */
  window.NightMarketUI = { session: function () { return session; } };

  if (!restoreSnapshot()) showStart();
})();
