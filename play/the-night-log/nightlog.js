/* The Night Log — game controller. Rendering, sound, saves, scoring.
   All case logic lives in nightlog-core.js; this file never decides
   what is true, it only presents cases and records the player's call. */
(function () {
"use strict";
var Core = window.NightLogCore;
var API = window.ArcadeAPI;
var SLUG = "the-night-log";
var root = document.getElementById("game");

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
function todayStr() {
  var d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function fmtMs(ms) {
  var s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/* ---------------- sound (WebAudio, no assets) ---------------- */
var Sound = {
  ctx: null, muted: localStorage.getItem("nightlog.muted") === "1",
  ensure: function () {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.ctx = null; }
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  env: function (gain, t0, a, d, peak) {
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  },
  tone: function (freq0, freq1, dur, type, peak) {
    if (this.muted || !this.ensure()) return;
    var c = this.ctx, t = c.currentTime;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, freq1), t + dur);
    this.env(g, t, 0.01, dur, peak);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  },
  noise: function (dur, freq, peak) {
    if (this.muted || !this.ensure()) return;
    var c = this.ctx, t = c.currentTime;
    var len = Math.floor(c.sampleRate * dur);
    var buf = c.createBuffer(1, len, c.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = c.createBufferSource(); src.buffer = buf;
    var f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = freq; f.Q.value = 0.8;
    var g = c.createGain(); this.env(g, t, 0.005, dur, peak);
    src.connect(f); f.connect(g); g.connect(c.destination); src.start(t);
  },
  page: function () { this.noise(0.18, 900, 0.12); },
  /* A low, slow music bed: two detuned tones and a sub tone under a
     slow swell, quiet enough to read over. Starts on a player's first
     action (browser rules), stops the moment mute is pressed. */
  bed: null,
  startBed: function () {
    if (this.muted || !this.ensure() || this.bed) return;
    var c = this.ctx, t = c.currentTime;
    var g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.028, t + 2.5);
    var o1 = c.createOscillator(); o1.type = "sine"; o1.frequency.value = 110;
    var o2 = c.createOscillator(); o2.type = "sine"; o2.frequency.value = 164.81;
    var o3 = c.createOscillator(); o3.type = "triangle"; o3.frequency.value = 55;
    var lfo = c.createOscillator(); lfo.frequency.value = 0.07;
    var lfoG = c.createGain(); lfoG.gain.value = 0.008;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    o1.connect(g); o2.connect(g); o3.connect(g); g.connect(c.destination);
    o1.start(t); o2.start(t); o3.start(t); lfo.start(t);
    this.bed = { g: g, nodes: [o1, o2, o3, lfo] };
  },
  stopBed: function () {
    if (!this.bed || !this.ctx) { this.bed = null; return; }
    var bed = this.bed, t = this.ctx.currentTime;
    this.bed = null;
    bed.g.gain.cancelScheduledValues(t);
    bed.g.gain.setValueAtTime(Math.max(bed.g.gain.value, 0.0001), t);
    bed.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    setTimeout(function () { bed.nodes.forEach(function (n) { try { n.stop(); } catch (e) {} }); }, 600);
  },
  tick: function () { this.noise(0.05, 2400, 0.06); },
  stamp: function () { this.tone(140, 42, 0.28, "sine", 0.5); this.noise(0.08, 300, 0.25); },
  chime: function () { this.tone(659, 659, 0.35, "sine", 0.12); setTimeout(function () { Sound.tone(988, 988, 0.5, "sine", 0.1); }, 130); },
  dread: function () { this.tone(98, 92, 0.9, "triangle", 0.22); this.tone(147, 139, 0.9, "triangle", 0.12); },
  toggleMute: function () {
    this.muted = !this.muted;
    localStorage.setItem("nightlog.muted", this.muted ? "1" : "0");
    if (this.muted) this.stopBed(); else this.startBed();
    return this.muted;
  }
};
document.addEventListener("pointerdown", function () { Sound.ensure(); }, { once: true });

/* ---------------- state ---------------- */
var SAVE_KEY = "nightlog.save.v1";
function loadSave() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return null; } }
function writeSave(s) { if (s) localStorage.setItem(SAVE_KEY, JSON.stringify(s)); else localStorage.removeItem(SAVE_KEY); }

var S = null; // active session: {kind:'shift'|'daily', ...}

function newShift(mode) {
  var seed = "shift-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
  var shift = Core.generateShift(seed, mode);
  S = {
    kind: "shift", mode: mode, seed: seed, shift: shift, idx: 0,
    results: [], score: 0, startedAt: Date.now(), caseStartedAt: null,
    banishCorrect: null, finishedAt: null
  };
  persist();
  API.logEvent("game_start", SLUG, { mode: mode });
  Sound.startBed();
  showCase();
}
function persist() {
  if (!S || S.kind !== "shift") return;
  writeSave({
    seed: S.seed, mode: S.mode, idx: S.idx, results: S.results,
    score: S.score, startedAt: S.startedAt, banishCorrect: S.banishCorrect
  });
}
function resumeShift() {
  var save = loadSave();
  if (!save) return false;
  var shift = Core.generateShift(save.seed, save.mode);
  S = {
    kind: "shift", mode: save.mode, seed: save.seed, shift: shift, idx: save.idx,
    results: save.results, score: save.score, startedAt: save.startedAt,
    caseStartedAt: null, banishCorrect: save.banishCorrect, finishedAt: null
  };
  if (S.idx >= 13) { showResults(); } else { Sound.startBed(); showCase(); }
  return true;
}

/* ---------------- shared chrome ---------------- */
function topbar(extra) {
  return '<div class="nl-topbar"><span class="muted small">' + (extra || "") + '</span>' +
    '<button class="nl-icon-btn" id="mute-btn" type="button">' + (Sound.muted ? "Sound: off" : "Sound: on") + "</button></div>";
}
function bindMute() {
  var b = document.getElementById("mute-btn");
  if (b) b.addEventListener("click", function () {
    b.textContent = Sound.toggleMute() ? "Sound: off" : "Sound: on";
  });
}
function progressDots() {
  if (!S || S.kind !== "shift") return "";
  var html = '<div class="nl-progress" aria-hidden="true">';
  for (var i = 0; i < 13; i++) {
    var cls = "";
    if (i < S.results.length) cls = S.results[i].solved ? "done" : "failed";
    else if (i === S.idx) cls = "now";
    html += "<span class='" + cls + "'>" + (i + 1) + "</span>";
  }
  return html + "</div>";
}
function journalHtml(tells, heading) {
  var items = tells.map(function (id) {
    var t = Core.TELLS.find(function (x) { return x.id === id; });
    return "<li>" + esc(t.journal) + "</li>";
  }).join("");
  return '<div class="nl-journal"><h3>' + esc(heading || "Your journal") + "</h3><ul>" + items + "</ul></div>";
}
function revealedTells() {
  var upto = S.kind === "shift" ? S.results.length : 13;
  var out = [];
  if (upto >= 4) out.push(S.shift.tells[0]);
  if (upto >= 8) out.push(S.shift.tells[1]);
  if (upto >= 12) out.push(S.shift.tells[2]);
  return out;
}

/* ---------------- start screen ---------------- */
function showStart() {
  var save = loadSave();
  var passport = API.getPassport();
  var g = passport.games[SLUG];
  var best = g && g.finishes ? "<p class='muted'>Your passport: " + g.finishes + " shift" + (g.finishes > 1 ? "s" : "") +
    " finished · best medal " + API.MEDAL_LABEL[g.bestMedal] + " · best score " + g.bestScore + ".</p>" : "";
  var daily = Core.generateDailyCase(todayStr());
  root.innerHTML =
    topbar("The Night Log") +
    '<div class="nl-paper">' +
    '<span class="nl-filetab">Wrenworks Arcade · Week 1</span>' +
    "<h1>The Night Log</h1>" +
    "<p>You are the night investigator, and the log is your book of cases. A shift is twelve cases and a finale. In every case you get the scene, the sounds, where everyone was — and four witness testimonies. Three of the witnesses are people. The rest are not: something is wearing a person's shape, and its testimony holds one detail that could not be true. Find it, and name the thing.</p>" +
    "<p>One name per case — two in the hard shift. A wrong name closes the case and the thing walks free, so read before you accuse. There is no clock on a case; the log rewards care, not speed. As the shift goes on your journal fills with what the thing cannot do. By the last case, the journal is the evidence. Witnesses also talk about the weather and their sleep — none of that can hang anybody. Only what can be checked against the file counts.</p>" +
    '<hr class="nl-rule">' +
    "<p class='nl-score-line'>Scoring: a case named right is worth 100 (150 in the hard shift), the finale 150 (200), and the right ending 50 more. Medals: 7 cases solved is bronze, 9 silver, 11 gold — and a flawless shift with the right ending earns the Wren medal.</p>" +
    best +
    '<div class="nl-bar">' +
    (save ? '<button class="nl-btn red" id="resume-btn" type="button">Resume your shift (case ' + (save.idx + 1) + " of 13)</button>" : "") +
    '<button class="nl-btn" id="start-btn" type="button">Begin a shift</button>' +
    '<button class="nl-btn" id="hard-btn" type="button">Begin the hard shift</button>' +
    '<button class="nl-btn" id="daily-btn" type="button">Today\'s case</button>' +
    "</div>" +
    "<p class='muted'>Today's case is a single case, new every day, on its own board. A full shift takes most players half an hour to an hour.</p>" +
    "</div>";
  bindMute();
  if (save) document.getElementById("resume-btn").addEventListener("click", function () { Sound.page(); resumeShift(); });
  document.getElementById("start-btn").addEventListener("click", function () { Sound.page(); newShift("normal"); });
  document.getElementById("hard-btn").addEventListener("click", function () { Sound.page(); newShift("hard"); });
  document.getElementById("daily-btn").addEventListener("click", function () {
    Sound.page();
    S = { kind: "daily", shift: null, daily: daily, caseStartedAt: Date.now(), mode: "daily" };
    API.logEvent("game_start", SLUG, { mode: "daily" });
    Sound.startBed();
    showCase();
  });
}

/* ---------------- case screen ---------------- */
function currentCase() { return S.kind === "daily" ? S.daily : S.shift.cases[S.idx]; }
function thingsCount() {
  if (S.kind === "daily") return 1;
  return currentCase().culprits.length;
}

function showCase() {
  var c = currentCase();
  S.caseStartedAt = Date.now();
  API.logEvent("case_shown", SLUG, { n: c.n || 0, daily: S.kind === "daily" });
  var isFinale = !!c.finale;
  var selected = {};
  var pinned = {};

  var head = S.kind === "daily"
    ? '<span class="nl-filetab">Today\'s case · ' + todayStr() + "</span>"
    : '<span class="nl-filetab">Case ' + c.n + " of 13" + (isFinale ? " · the last case" : "") + "</span>";

  var sections = c.sections.map(function (sec) {
    return '<div class="nl-facts"><h3>' + esc(sec.title) + "</h3><ul>" +
      sec.lines.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ul></div>";
  }).join("");

  var witnesses = c.witnesses.map(function (w, i) {
    return '<article class="nl-witness selectable" data-w="' + i + '" tabindex="0" role="button" aria-pressed="false" aria-label="Choose ' + esc(w.name) + '">' +
      '<button class="pin" data-pin="' + i + '" aria-pressed="false" type="button">mark</button>' +
      "<h3>" + esc(w.name) + "</h3><p class='role'>" + esc(w.role) + "</p>" +
      w.statements.map(function (s) { return "<p>" + esc(s) + "</p>"; }).join("") +
      "</article>";
  }).join("");

  var need = thingsCount();
  var journalBlock = "";
  if (S.kind === "shift" && !isFinale && revealedTells().length) {
    journalBlock = journalHtml(revealedTells(), "Your journal, so far");
  }
  var finaleNote = isFinale
    ? "<p><strong>Tonight the journal is evidence.</strong> Everything in this case file is true — including what your journal says the thing cannot do. One testimony below defies the journal itself. The thing lies to pass as human: it will claim to have done the very things it cannot do, because it does not know what your journal holds.</p>"
    : "";

  root.innerHTML =
    topbar(S.kind === "shift" ? "Shift score: " + S.score : "Today's case") +
    progressDots() +
    '<div class="nl-paper">' + head +
    "<h1>" + esc(c.title) + "</h1>" +
    "<p>" + esc(c.intro) + "</p>" +
    sections + finaleNote +
    "<h2>The testimonies</h2>" +
    "<p class='muted'>Choose by tapping a witness's card — the mark button is only a note for yourself, and changes nothing in the log. When you are sure, enter " + (need === 2 ? "the two names" : "the name") + " in the log. There is no second chance in a case.</p>" +
    '<div class="nl-witnesses">' + witnesses + "</div>" +
    '<div class="nl-bar">' +
    '<button class="nl-btn red" id="accuse-btn" type="button" disabled>Enter the name in the log</button>' +
    '<span class="muted" id="pick-note">' + (need === 2 ? "Choose two names." : "Choose one name.") + "</span>" +
    "</div>" +
    journalBlock +
    "</div>";
  bindMute();
  Sound.page();

  root.querySelectorAll("[data-pin]").forEach(function (btn) {
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var i = btn.getAttribute("data-pin");
      pinned[i] = !pinned[i];
      btn.setAttribute("aria-pressed", pinned[i] ? "true" : "false");
      btn.textContent = pinned[i] ? "marked" : "mark";
      Sound.tick();
    });
  });
  var accuseBtn = document.getElementById("accuse-btn");
  var note = document.getElementById("pick-note");
  root.querySelectorAll(".nl-witness").forEach(function (card) {
    function toggle() {
      var i = card.getAttribute("data-w");
      if (selected[i]) { delete selected[i]; card.classList.remove("selected"); card.setAttribute("aria-pressed", "false"); }
      else {
        if (Object.keys(selected).length >= need) return;
        selected[i] = true; card.classList.add("selected"); card.setAttribute("aria-pressed", "true");
      }
      Sound.tick();
      var n = Object.keys(selected).length;
      accuseBtn.disabled = n !== need;
      if (n === need) {
        var selNames = Object.keys(selected).map(function (k) { return c.witnesses[k].name; });
        note.textContent = "Ready: " + selNames.join(" and ") + ". This cannot be undone.";
        accuseBtn.textContent = "Enter " + selNames.join(" and ") + " in the log";
      } else {
        note.textContent = "Choose " + (need - n) + " more name" + (need - n > 1 ? "s" : "") + ".";
        accuseBtn.textContent = need === 2 ? "Enter the names in the log" : "Enter the name in the log";
      }
    }
    card.addEventListener("click", toggle);
    card.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
    });
  });
  accuseBtn.addEventListener("click", function () {
    var picks = Object.keys(selected).map(Number).sort();
    resolveCase(c, picks);
  });
}

/* ---------------- verdicts and flow ---------------- */
function resolveCase(c, picks) {
  var culprits = c.culprits.slice().sort();
  var solved = JSON.stringify(picks) === JSON.stringify(culprits);
  var wrongs = picks.filter(function (p) { return culprits.indexOf(p) === -1; }).length;
  var caseMs = Date.now() - S.caseStartedAt;
  API.logEvent("accusation", SLUG, { n: c.n || 0, correct: solved, wrongs: wrongs, ms: caseMs });
  if (solved) Sound.stamp(), Sound.chime(); else Sound.dread();

  var revealHtml = c.reveals.map(function (r) { return "<p>" + esc(r) + "</p>"; }).join("");
  var namedHtml = picks.map(function (p) {
    return "<p>" + esc(c.witnesses[p].name) + ", " + esc(c.witnesses[p].role) + " — " +
      (culprits.indexOf(p) !== -1 ? "<strong>not human.</strong>" : "<strong>innocent.</strong>") + "</p>";
  }).join("");

  if (S.kind === "daily") {
    var secs = Math.round(caseMs / 1000);
    var score = solved ? Math.max(100, 1000 - secs) : 0;
    API.logEvent("daily_end", SLUG, { solved: solved, ms: caseMs });
    if (solved) API.recordResult(SLUG, { finished: false, dailyStamp: todayStr() });
    root.innerHTML = topbar("Today's case") +
      '<div class="nl-paper nl-verdict">' +
      '<span class="nl-filetab">Verdict</span>' +
      "<p style='margin-top:1rem'><span class='nl-stamp" + (solved ? "" : " black") + "'>" + (solved ? "Not human" : "It walks free") + "</span></p>" +
      namedHtml + revealHtml +
      "<p class='nl-score-line'>" + (solved ? "Named in " + fmtMs(caseMs) + "." : "The thing keeps today's shape.") + "</p>" +
      '<div class="nl-bar">' +
      '<button class="nl-btn" id="daily-board-btn" type="button">' + (solved ? "Put it on today's board" : "Note it on today's board") + "</button>" +
      '<button class="nl-btn ghost" id="again-btn" type="button">Back to the start</button>' +
      "</div></div>";
    bindMute();
    document.getElementById("daily-board-btn").addEventListener("click", function () {
      submitScore("daily", score, solved ? "Solved in " + fmtMs(caseMs) : "It escaped", this);
    });
    document.getElementById("again-btn").addEventListener("click", showStart);
    return;
  }

  // shift flow
  var gained = 0;
  if (solved) gained = c.finale ? (S.mode === "hard" ? 200 : 150) : (S.mode === "hard" ? 150 : 100);
  S.score += gained;
  S.results.push({ solved: solved, wrongs: wrongs, ms: caseMs });
  API.logEvent("case_end", SLUG, { n: c.n, solved: solved, score: S.score });
  persist();

  var journalNew = null;
  if (S.results.length === 4) journalNew = S.shift.tells[0];
  if (S.results.length === 8) journalNew = S.shift.tells[1];
  if (S.results.length === 12) journalNew = S.shift.tells[2];
  var journalSection = "";
  if (journalNew) {
    var t = Core.TELLS.find(function (x) { return x.id === journalNew; });
    journalSection = '<div class="nl-journal"><h3>Written into your journal tonight</h3><p>' + esc(t.journal) +
      "</p><p class='muted' style='color:#a3a099'>Remember it. In the last case, the journal is the evidence.</p></div>";
  }

  var isLast = S.idx === 12;
  root.innerHTML = topbar("Shift score: " + S.score) + progressDots() +
    '<div class="nl-paper nl-verdict">' +
    '<span class="nl-filetab">Case ' + c.n + " · verdict</span>" +
    "<p style='margin-top:1rem'><span class='nl-stamp" + (solved ? "" : " black") + "'>" + (solved ? "Not human" : "It walks free") + "</span></p>" +
    namedHtml + revealHtml +
    "<p class='nl-score-line'>" + (solved ? "+" + gained + " · shift score " + S.score + " · case took " + fmtMs(caseMs) :
      "No points · shift score " + S.score + " · case took " + fmtMs(caseMs)) + "</p>" +
    journalSection +
    '<div class="nl-bar"><button class="nl-btn red" id="next-btn" type="button">' +
    (isLast ? (solved ? "Face the ending" : "See how the shift ends") : "Open the next case") + "</button></div>" +
    "</div>";
  bindMute();
  document.getElementById("next-btn").addEventListener("click", function () {
    Sound.page();
    if (isLast) {
      if (S.results[12].solved) showBanish();
      else finishShift();
    } else {
      S.idx += 1; persist(); showCase();
    }
  });
}
function solvedCases() { return S.results.filter(function (r) { return r.solved; }).length; }

/* ---------------- the ending ---------------- */
function showBanish() {
  var c = S.shift.cases[12];
  root.innerHTML = topbar("The ending") +
    '<div class="nl-paper">' +
    '<span class="nl-filetab">The last case · the ending</span>' +
    "<h1>End it.</h1>" +
    "<p>The thing is named, and naming is most of the work — but a named thing can still walk out into the fog. Your journal holds three things it cannot do, learned across twelve cases. One of them is the weakness that gave it away tonight. Use that one.</p>" +
    journalHtml(S.shift.tells, "Your journal") +
    '<div class="nl-bar">' +
    c.banish.options.map(function (o, i) {
      return '<button class="nl-btn" data-banish="' + i + '" type="button">' + esc(o.text) + "</button>";
    }).join("") +
    "</div></div>";
  bindMute();
  root.querySelectorAll("[data-banish]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var opt = c.banish.options[Number(btn.getAttribute("data-banish"))];
      S.banishCorrect = opt.tell === c.banish.correctTell;
      if (S.banishCorrect) { S.score += 50; Sound.stamp(); Sound.chime(); } else { Sound.dread(); }
      persist();
      finishShift();
    });
  });
}

function medalFor() {
  var solved = solvedCases();
  if (solved === 13 && S.banishCorrect) return "wren";
  if (solved >= 11) return "gold";
  if (solved >= 9) return "silver";
  if (solved >= 7) return "bronze";
  return "none";
}

function finishShift() {
  S.finishedAt = Date.now();
  var totalMs = S.finishedAt - S.startedAt;
  var medal = medalFor();
  API.logEvent("shift_end", SLUG, { ms: totalMs, solved: solvedCases(), score: S.score, medal: medal, mode: S.mode });
  API.recordResult(SLUG, { finished: true, medal: medal, score: S.score });
  writeSave(null);
  showResults(totalMs, medal);
}

function showResults(totalMs, medal) {
  if (totalMs === undefined) { totalMs = Date.now() - S.startedAt; medal = medalFor(); }
  var solved = solvedCases();
  var wrongs = S.results.reduce(function (a, r) { return a + r.wrongs; }, 0);
  var endingLine = S.banishCorrect === true
    ? "You ended it with the journal's own evidence. The parish sleeps."
    : (S.banishCorrect === false
      ? "You named it, but chose the wrong weakness, and it slipped your hands at the door."
      : "The last case went unnamed, and the thing walked out of the log into the fog.");
  var board = API.getBoard(SLUG, "shift");
  var boardHtml = board.length
    ? '<table class="board"><tr><th>Player</th><th class="num">Score</th><th>Shift</th></tr>' +
      board.slice(0, 10).map(function (r) {
        return "<tr><td>" + esc(r.name) + '</td><td class="num">' + r.score + "</td><td>" + esc(r.detail) + "</td></tr>";
      }).join("") + "</table>"
    : "<p class='muted'>No shifts on the board yet.</p>";

  root.innerHTML = topbar("Shift complete") +
    '<div class="nl-paper">' +
    '<span class="nl-filetab">The log, closed</span>' +
    "<h1>" + solved + " of 13 named.</h1>" +
    "<p>" + endingLine + "</p>" +
    "<p class='nl-score-line'>Score " + S.score + " · wrong accusations " + wrongs +
    " · shift took " + fmtMs(totalMs) + " · medal: " + API.MEDAL_LABEL[medal] + "</p>" +
    (medal !== "none" ? "<p><span class='nl-stamp'>" + API.MEDAL_LABEL[medal] + "</span></p>" : "") +
    '<div class="nl-bar">' +
    '<button class="nl-btn" id="board-btn" type="button">Put my score on the board</button>' +
    '<button class="nl-btn ghost" id="new-btn" type="button">A new shift</button>' +
    '<a class="nl-btn ghost" href="../../index.html">Back to the arcade</a>' +
    "</div>" +
    "<h2>Share the shift</h2>" +
    "<p class='muted'>A page from the log, with your numbers on it.</p>" +
    '<p><canvas id="share-card" width="1200" height="630"></canvas></p>' +
    '<div class="nl-bar">' +
    '<a class="nl-btn" id="dl-card" download="night-log-shift.png" href="#">Download the page</a>' +
    '<button class="nl-btn ghost" id="copy-card" type="button">Copy as text</button>' +
    "</div>" +
    "<h2>The shift board</h2>" + boardHtml +
    "</div>";
  bindMute();
  drawShareCard(solved, wrongs, totalMs, medal);
  document.getElementById("dl-card").href = document.getElementById("share-card").toDataURL("image/png");
  document.getElementById("copy-card").addEventListener("click", function () {
    var text = "The Night Log — I named " + solved + " of 13, " + wrongs + " wrong accusations, medal: " +
      API.MEDAL_LABEL[medal] + ". One new game every Friday at the Wrenworks Arcade.";
    if (navigator.clipboard) navigator.clipboard.writeText(text);
    this.textContent = "Copied";
  });
  document.getElementById("board-btn").addEventListener("click", function () {
    submitScore("shift", S.score, (S.mode === "hard" ? "Hard shift · " : "Shift · ") + solved + "/13 · " + API.MEDAL_LABEL[medal], this);
  });
  document.getElementById("new-btn").addEventListener("click", showStart);
}

function submitScore(board, score, detail, btn) {
  var name = API.getName();
  if (!name) {
    name = window.prompt("A nickname for the board (never your real name or email):", "");
    if (name) API.setName(name.trim());
    name = API.getName();
  }
  API.submitScore(SLUG, board, { name: name || "A player", score: score, detail: detail });
  btn.disabled = true; btn.textContent = "On the board";
}

function drawShareCard(solved, wrongs, totalMs, medal) {
  var c = document.getElementById("share-card");
  if (!c) return;
  var ctx = c.getContext("2d");
  ctx.fillStyle = "#ece5d3"; ctx.fillRect(0, 0, 1200, 630);
  ctx.strokeStyle = "#211d16"; ctx.lineWidth = 2; ctx.strokeRect(30, 30, 1140, 570);
  ctx.fillStyle = "#211d16";
  ctx.font = "700 58px Georgia, serif";
  ctx.fillText("THE NIGHT LOG", 70, 130);
  ctx.font = "30px Georgia, serif";
  ctx.fillText("I named " + solved + " of the 13.", 70, 220);
  ctx.fillText("Wrong accusations: " + wrongs + " · Shift took " + fmtMs(totalMs), 70, 280);
  ctx.fillText("Medal: " + API.MEDAL_LABEL[medal] + " · Score: " + S.score, 70, 340);
  ctx.save();
  ctx.translate(880, 430); ctx.rotate(-0.07);
  ctx.strokeStyle = "#9e2b25"; ctx.lineWidth = 5; ctx.strokeRect(-190, -60, 380, 120);
  ctx.fillStyle = "#9e2b25"; ctx.font = "700 44px 'Courier New', monospace"; ctx.textAlign = "center";
  ctx.fillText(solved >= 11 ? "CASE CLOSED" : "LOG CLOSED", 0, 16);
  ctx.restore();
  ctx.textAlign = "left"; ctx.fillStyle = "#4a4436"; ctx.font = "26px Georgia, serif";
  ctx.fillText("Wrenworks Arcade — one new game every Friday", 70, 545);
}

/* ---------------- boot ---------------- */
showStart();
})();
