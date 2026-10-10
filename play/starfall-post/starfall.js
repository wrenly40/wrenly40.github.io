/* Starfall Post — presentation. Canvas rendering, input, sound,
   screens, saves. All game logic lives in starfall-core.js; this
   file never decides what is true, it only flies and shows.

   v1.1 (FD-034 + FD-035): one endless lane for everybody — the same
   canonical lane for every player, direct controls, mini-bosses in
   the deep lane. The district campaign, the free/daily lanes, the
   seed box and the modifiers are gone. Saves moved to v3 keys: v1.0
   campaign records and v1.1-district snapshots do not carry into
   the endless game (passport records are the adapter's and stay).

   v1.2 (FD-037): the owner's fix round — the bottom-band render
   fix, no height throttle, a harder ramp, and no score for sitting
   still (all in the core). Score semantics changed (depth pays
   nothing now), so saves move to v4 keys; v3 records do not carry
   (passport records are the adapter's and stay).

   v1.3: the music round (in the Sound object below: the static
   bed is replaced by a slow pad progression; the near-miss is
   softened) and the core's difficulty lift. The ramp changes
   materially from 12,000 px on, so records earned on the v1.2
   ramp are not comparable: saves move to v5 keys; v4 records do
   not carry (passport records are the adapter's and stay).

   v1.4: the coasted-delivery fix (in the core: passing through a
   beacon's ring is the delivery — the v1.2 activity gate no longer
   applies to capture, only to near-miss credit). Delivery counts
   change materially, so saves move to v6 keys; v5 records do not
   carry (passport records are the adapter's and stay).

   v1.5: the boss round (in the core: bosses are full sections now —
   longer, narrower, tighter, and The Orbit's boulder travels with
   the ship). Boss geometry changes what a run's records mean, so
   saves move to v7 keys; v6 records do not carry (passport records
   are the adapter's and stay). */
(function () {
"use strict";
var Core = window.StarfallCore;
var API = window.ArcadeAPI;
var SLUG = "starfall-post";
var W = Core.W, H = Core.H;
var root = document.getElementById("game");

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
function fmtScore(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function fmtMs(ms) {
  var s = Math.round(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
var MEDAL_ORDER = ["none", "bronze", "silver", "gold", "wren"];

/* ---------------- sound (WebAudio, no assets) ---------------- */
var Sound = {
  ctx: null, muted: localStorage.getItem("starfall.muted") === "1",
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
  tone: function (freq0, freq1, dur, type, peak, delay) {
    if (this.muted || !this.ensure()) return;
    var c = this.ctx, t = c.currentTime + (delay || 0);
    var o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, freq1), t + dur);
    this.env(g, t, 0.01, dur, peak);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  },
  noise: function (dur, f0, f1, peak, delay) {
    if (this.muted || !this.ensure()) return;
    var c = this.ctx, t = c.currentTime + (delay || 0);
    var len = Math.floor(c.sampleRate * dur);
    var buf = c.createBuffer(1, len, c.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = c.createBufferSource(); src.buffer = buf;
    var f = c.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 0.9;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    var g = c.createGain(); this.env(g, t, 0.008, dur, peak);
    src.connect(f); f.connect(g); g.connect(c.destination); src.start(t);
  },
  click: function () { this.tone(660, 660, 0.06, "triangle", 0.08); },
  deliver: function (chain) {
    var base = 540 * (1 + Math.min(chain, 12) * 0.045);
    this.tone(base, base, 0.12, "triangle", 0.16);
    this.tone(base * 1.335, base * 1.335, 0.16, "triangle", 0.13, 0.07);
  },
  swift: function () { this.tone(1180, 1180, 0.1, "sine", 0.09, 0.13); },
  nearMiss: function () {
    /* v1.3: softened. The denser lane earns near misses constantly,
       and the old fixed sweep (2,600 → 700 Hz at 0.10 peak) grated
       on repetition — lower peak, less top end, and the sweep
       varies per trigger so repeats never land identically. */
    var f0 = 1650 + Math.random() * 450;
    this.noise(0.13 + Math.random() * 0.06, f0, 620 + Math.random() * 120, 0.055);
  },
  hit: function () { this.tone(130, 38, 0.3, "sine", 0.5); this.noise(0.22, 900, 160, 0.28); },
  chainLost: function () { this.tone(392, 392, 0.12, "triangle", 0.1); this.tone(311, 311, 0.18, "triangle", 0.1, 0.1); },
  bossWarn: function () { this.tone(196, 196, 0.22, "sine", 0.22); this.tone(147, 147, 0.3, "sine", 0.22, 0.18); },
  clear: function () {
    var n = [523, 659, 784, 1047];
    for (var i = 0; i < n.length; i++) this.tone(n[i], n[i], 0.22, "triangle", 0.13, i * 0.09);
  },
  fail: function () { this.tone(220, 110, 0.5, "triangle", 0.18); this.tone(147, 73, 0.7, "triangle", 0.14, 0.16); },
  /* ---- the music (v1.3) ----
     Replaces the old bed: a STATIC chord — 110 + 220 + 277.18 Hz
     sines through a slow filter wobble, gain 0.016, unchanged from
     the first second of a run to the last. It never developed, so
     it never registered as music; as an unchanging hum under the
     whole game it read as a rocket drone and wore out its welcome
     fast (owner's playtest of v1.2). What plays now is a slow pad
     progression — Am, Fmaj7, Cmaj7, G — one chord every 5.5 s,
     each crossfading into the next through a shared lowpass and a
     single master gain capped at the old bed's level (0.02). On
     the Am and Cmaj7 a single high chord tone sounds once, very
     quietly, part-way through. All WebAudio, no assets. The
     lifecycle is the old bed's exactly — startBed/stopBed at the
     same call sites, mute toggle + starfall.muted persistence,
     and nothing sounds before a user gesture has created and
     resumed the context — and starting twice never stacks. */
  musicDef: [
    { name: "Am",    freqs: [110.00, 164.81, 220.00, 261.63] },  /* A2 E3 A3 C4 */
    { name: "Fmaj7", freqs: [87.31, 174.61, 220.00, 329.63] },   /* F2 F3 A3 E4 */
    { name: "Cmaj7", freqs: [130.81, 164.81, 196.00, 246.94] },  /* C3 E3 G3 B3 */
    { name: "G",     freqs: [98.00, 123.47, 146.83, 196.00] }    /* G2 B2 D3 G3 */
  ],
  CHORD_LEN: 5.5, MUSIC_PEAK: 0.02,
  music: null,
  trackVoice: function (m, osc) {
    m.voices.push(osc);
    var self = this;
    osc.onended = function () {
      if (self.music !== m) return;
      var j = m.voices.indexOf(osc);
      if (j >= 0) m.voices.splice(j, 1);
    };
  },
  scheduleChord: function (m, idx, when) {
    var c = this.ctx, def = this.musicDef[idx];
    var g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(1, when + 2.4);
    g.gain.setValueAtTime(1, when + this.CHORD_LEN - 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, when + this.CHORD_LEN + 2.6);
    g.connect(m.filter);
    var weights = [0.5, 0.34, 0.3, 0.26];
    for (var i = 0; i < def.freqs.length; i++) {
      var o = c.createOscillator(), og = c.createGain();
      o.type = "sine"; o.frequency.value = def.freqs[i];
      og.gain.value = weights[i];
      o.connect(og); og.connect(g);
      o.start(when); o.stop(when + this.CHORD_LEN + 2.8);
      this.trackVoice(m, o);
    }
    if (idx % 2 === 0) {   /* one sparse high tone, alternate chords */
      var so = c.createOscillator(), sg = c.createGain();
      var st = when + 2.9;
      so.type = "sine"; so.frequency.value = def.freqs[3] * 2;
      sg.gain.setValueAtTime(0.0001, st);
      sg.gain.exponentialRampToValueAtTime(0.10, st + 0.4);
      sg.gain.exponentialRampToValueAtTime(0.0001, st + 2.6);
      so.connect(sg); sg.connect(m.filter);
      so.start(st); so.stop(st + 2.8);
      this.trackVoice(m, so);
    }
    m.idx = idx; m.changes += 1;
  },
  startBed: function () {
    if (this.muted || !this.ensure() || this.music) return;
    var c = this.ctx, t = c.currentTime;
    var master = c.createGain();
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(this.MUSIC_PEAK, t + 3);
    var f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 640;
    var lfo = c.createOscillator(); lfo.frequency.value = 0.07;
    var lfoG = c.createGain(); lfoG.gain.value = 120;
    lfo.connect(lfoG); lfoG.connect(f.frequency);
    f.connect(master); master.connect(c.destination);
    lfo.start(t);
    var m = this.music = { gain: master, filter: f, lfo: lfo, voices: [],
                           idx: 0, changes: 0, timer: null };
    var self = this;
    this.scheduleChord(m, 0, t + 0.05);
    var advance = function () {
      if (self.music !== m) return;
      self.scheduleChord(m, (m.idx + 1) % self.musicDef.length, c.currentTime + 0.05);
      m.timer = setTimeout(advance, self.CHORD_LEN * 1000);
    };
    m.timer = setTimeout(advance, this.CHORD_LEN * 1000);
  },
  stopBed: function () {
    if (!this.music || !this.ctx) { this.music = null; return; }
    var m = this.music, t = this.ctx.currentTime;
    this.music = null;
    if (m.timer) clearTimeout(m.timer);
    m.gain.gain.cancelScheduledValues(t);
    m.gain.gain.setValueAtTime(Math.max(m.gain.gain.value, 0.0001), t);
    m.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    var nodes = m.voices.concat([m.lfo]);
    setTimeout(function () { nodes.forEach(function (n) { try { n.stop(); } catch (e) {} }); }, 600);
  },
  /* read-only state for the gate's audio suite (it reports the
     schedule and levels; it cannot change anything) */
  debugState: function () {
    var m = this.music;
    return {
      ctx: this.ctx ? this.ctx.state : "none",
      muted: this.muted,
      music: m ? { name: this.musicDef[m.idx].name,
                   freqs: this.musicDef[m.idx].freqs.slice(),
                   changes: m.changes,
                   gain: m.gain.gain.value,
                   voices: m.voices.length } : null
    };
  },
  toggleMute: function () {
    this.muted = !this.muted;
    localStorage.setItem("starfall.muted", this.muted ? "1" : "0");
    if (this.muted) this.stopBed(); else this.startBed();
    return this.muted;
  }
};
document.addEventListener("pointerdown", function () { Sound.ensure(); }, { once: true });

/* ---------------- save ---------------- */
var SAVE_KEY = "starfall.save.v7";
function loadSave() {
  try {
    var s = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (s && typeof s.bestScore === "number") return s;
  } catch (e) {}
  return { runs: 0, bestScore: 0, bestDepth: 0, bestDeliveries: 0, bestBosses: 0, bestMedal: "none" };
}
function writeSave() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) {} }
var save = loadSave();

/* ---------------- run snapshot (FD-030: a refresh never means
 * starting from scratch) ----------------
 * The whole run state is serialised every couple of seconds and on
 * pause/hide/unload. Campaign progress lives in the save above and
 * is written the moment anything is earned, so a refresh can never
 * lose it; the snapshot additionally lets a mid-run pilot pick the
 * run itself back up. */
var RUN_KEY = "starfall.run.v7";
function snapshotRun() {
  if (!run || run.done || screen !== "run") return;
  try {
    localStorage.setItem(RUN_KEY, JSON.stringify({
      cfg: runCfg, state: run, wallElapsed: Date.now() - runWallStart, savedAt: Date.now()
    }));
  } catch (e) { /* storage full/blocked: the best-run save still holds */ }
}
function clearRunSnapshot() { try { localStorage.removeItem(RUN_KEY); } catch (e) {} }
function readRunSnapshot() {
  try {
    var s = JSON.parse(localStorage.getItem(RUN_KEY));
    if (!s || !s.state || !s.cfg || s.cfg.kind !== "endless") return null;
    if (s.state.done) { clearRunSnapshot(); return null; }
    return s;
  } catch (e) { return null; }
}
function resumeRun(snap) {
  runCfg = snap.cfg;
  run = Core.reviveRun(snap.state);
  runWallStart = Date.now() - (snap.wallElapsed || 0);
  runFinalized = false;
  paused = false;
  particles.length = 0; floaters.length = 0; effects.length = 0;
  screen = "run";
  overlay.innerHTML = "";
  overlay.style.display = "none";
  hud.hidden = false;
  hintShownAt = performance.now();
  el("sf-hint").style.opacity = "1";
  Sound.ensure(); Sound.startBed();
  togglePause(); /* opens paused, so the pilot resumes deliberately */
}

/* ---------------- stage ---------------- */
root.innerHTML =
  '<div class="sf-stage" id="sf-stage">' +
    '<canvas id="sf-canvas" width="' + W + '" height="' + H + '"></canvas>' +
    '<div class="sf-hud" id="sf-hud" hidden>' +
      '<div class="sf-hud-left"><span id="sf-score">0</span><span class="sf-chain" id="sf-chain"></span><div class="sf-deliv" id="sf-deliv"></div></div>' +
      '<div class="sf-hud-mid"><div class="sf-parcel"><div class="sf-parcel-fill" id="sf-parcel-fill"></div></div><span id="sf-parcel-pct">100%</span></div>' +
      '<div class="sf-hud-right"><button class="sf-iconbtn" id="sf-sound" aria-label="Toggle sound">♪</button>' +
      '<button class="sf-iconbtn" id="sf-pause" aria-label="Pause">❚❚</button></div>' +
      '<div class="sf-progress"><div class="sf-progress-fill" id="sf-progress-fill"></div></div>' +
      '<div class="sf-hint" id="sf-hint">Steer with a mouse or touch drag, or ← → ↑ ↓. Fly through the lit rings to deliver — the arrow at the top points to the next ring. The lane ends when the parcel does.</div>' +
    '</div>' +
    '<div class="sf-overlay" id="sf-overlay"></div>' +
  '</div>';

var canvas = document.getElementById("sf-canvas");
var ctx = canvas.getContext("2d");
var DPR = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = W * DPR; canvas.height = H * DPR;
ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
var overlay = document.getElementById("sf-overlay");
var hud = document.getElementById("sf-hud");
var el = function (id) { return document.getElementById(id); };

/* ---------------- input ---------------- */
var keys = {};
var pointer = { active: false, x: 0, y: 0, touch: false };
document.addEventListener("keydown", function (e) {
  if (screen === "run") {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].indexOf(e.key) >= 0) e.preventDefault();
    keys[e.key.toLowerCase()] = true;
    if (e.key === "p" || e.key === "P" || e.key === "Escape") togglePause();
  }
  if (e.key === "m" || e.key === "M") refreshSoundBtn(Sound.toggleMute());
});
document.addEventListener("keyup", function (e) { keys[e.key.toLowerCase()] = false; });
function canvasPos(evt) {
  var r = canvas.getBoundingClientRect();
  return { x: (evt.clientX - r.left) / r.width * W, y: (evt.clientY - r.top) / r.height * H };
}
canvas.addEventListener("pointerdown", function (e) {
  Sound.ensure();
  var p = canvasPos(e); pointer.active = true; pointer.x = p.x; pointer.y = p.y;
  pointer.touch = e.pointerType !== "mouse";
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or already-released pointer */ }
});
canvas.addEventListener("pointermove", function (e) {
  if (!pointer.active) return;
  var p = canvasPos(e); pointer.x = p.x; pointer.y = p.y;
});
function endPointer() { pointer.active = false; }
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
function currentInput() {
  var ix = 0, iy = 0;
  if (keys["arrowleft"] || keys["a"]) ix -= 1;
  if (keys["arrowright"] || keys["d"]) ix += 1;
  if (keys["arrowup"] || keys["w"]) iy -= 1;
  if (keys["arrowdown"] || keys["s"]) iy += 1;
  if (ix !== 0 || iy !== 0) return { x: ix, y: iy };
  if (pointer.active && run) {
    var tx = pointer.x, ty = pointer.y - (pointer.touch ? 64 : 0);
    var dx = tx - run.ship.x, dy = ty - run.ship.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > 5) {
      var m = Math.min(1, d / 78);
      return { x: dx / d * m, y: dy / d * m };
    }
  }
  return { x: 0, y: 0 };
}

/* ---------------- run management ---------------- */
var screen = "start";           /* start | run | results */
var run = null;                 /* core state */
var runCfg = null;              /* {kind: "endless"} */
var runWallStart = 0;
var runFinalized = false;
var endTimer = 0;
var paused = false;
var hintShownAt = 0;

function startRun() {
  clearRunSnapshot(); /* a fresh run supersedes any kept one */
  runCfg = { kind: "endless" };
  run = Core.createRun();
  runWallStart = Date.now();
  runFinalized = false;
  paused = false;
  particles.length = 0; floaters.length = 0;
  effects.length = 0;
  screen = "run";
  overlay.innerHTML = "";
  overlay.style.display = "none";
  hud.hidden = false;
  hintShownAt = performance.now();
  el("sf-hint").style.opacity = "1";
  el("sf-hint").textContent = "Steer with a mouse or touch drag, or ← → ↑ ↓. Fly through the lit rings to deliver — the arrow at the top points to the next ring. The lane ends when the parcel does.";
  save.runs += 1; writeSave();
  API.logEvent("game_start", SLUG, { mode: "endless", seed: Core.SEED });
  Sound.startBed();
}
function togglePause() {
  if (screen !== "run" || !run || run.done) return;
  paused = !paused;
  if (paused) {
    snapshotRun();
    overlay.style.display = "flex";
    overlay.innerHTML =
      '<div class="sf-panel"><h2 class="sf-h">Paused</h2>' +
      '<button class="sf-btn primary" id="sf-resume">Keep flying</button>' +
      '<button class="sf-btn" id="sf-restart">Restart this run</button>' +
      '<button class="sf-btn ghost" id="sf-quit">Leave the run</button>' +
      '</div>';
    el("sf-resume").addEventListener("click", function () { Sound.click(); togglePause(); });
    el("sf-restart").addEventListener("click", function () { Sound.click(); startRun(); });
    el("sf-quit").addEventListener("click", function () {
      Sound.click();
      API.logEvent("run_quit", SLUG, { mode: "endless", depth: Math.round(run.depth) });
      clearRunSnapshot();
      run = null; paused = false; hud.hidden = true;
      showStart();
    });
  } else {
    overlay.innerHTML = "";
    overlay.style.display = "none";
  }
}
document.addEventListener("visibilitychange", function () {
  if (document.hidden && screen === "run" && !paused && run && !run.done) togglePause();
});
el("sf-pause").addEventListener("click", function () { togglePause(); });
function refreshSoundBtn(muted) {
  var b = el("sf-sound");
  if (b) { b.textContent = muted ? "✕" : "♪"; b.setAttribute("aria-label", muted ? "Sound off" : "Sound on"); }
}
el("sf-sound").addEventListener("click", function () { refreshSoundBtn(Sound.toggleMute()); });
refreshSoundBtn(Sound.muted);

function finalizeRun() {
  if (runFinalized || !run) return;
  runFinalized = true;
  clearRunSnapshot();
  var st = run;
  var final = Core.finalScore(st);
  var wallMs = Date.now() - runWallStart;
  var medal = Core.medalForRun(st.depth, st.deliveries, st.bestChain);
  var newBest = final > save.bestScore;
  if (newBest) {
    save.bestScore = final;
    save.bestDepth = Math.round(st.depth);
    save.bestDeliveries = st.deliveries;
    save.bestBosses = st.bosses;
  }
  if (MEDAL_ORDER.indexOf(medal) > MEDAL_ORDER.indexOf(save.bestMedal)) save.bestMedal = medal;
  API.logEvent("run_end", SLUG, {
    mode: "endless", ms: wallMs, score: final, depth: Math.round(st.depth),
    deliveries: st.deliveries, chain: st.bestChain, hits: st.hits,
    bosses: st.bosses, medal: medal
  });
  API.recordResult(SLUG, { finished: true, medal: medal, score: final, deliveries: st.deliveries });
  writeSave();
  showResults(st, final, medal, newBest);
}

/* ---------------- overlays / screens ---------------- */
function medalDot(m) {
  return '<span class="sf-medal-dot m-' + m + '" title="' + esc(API.MEDAL_LABEL[m]) + '"></span>';
}
function showStart() {
  screen = "start";
  hud.hidden = true;
  particles.length = 0; floaters.length = 0; effects.length = 0; /* no run debris over the panel */
  overlay.style.display = "flex";
  var record = "";
  if (save.bestScore > 0) {
    record = '<p class="sf-small">Your best run: ' + fmtScore(save.bestScore) + ' · ' +
      fmtScore(Math.round(save.bestDepth / 10)) + ' m · ' + save.bestDeliveries + ' deliveries · ' +
      esc(API.MEDAL_LABEL[save.bestMedal]) + '.</p>';
  }
  var snap = readRunSnapshot();
  var resumeBtn = "";
  if (snap) {
    resumeBtn = '<button class="sf-btn primary" id="sf-resume-run">Pick up your run — ' +
      fmtScore(Math.round(snap.state.depth / 10)) + ' m in · parcel ' + Math.round(snap.state.integrity) + '%</button>';
  }
  overlay.innerHTML =
    '<div class="sf-panel">' +
    '<p class="sf-kicker">Wrenworks Arcade</p>' +
    '<h1 class="sf-title">STARFALL<br>POST</h1>' +
    '<p class="sf-sub">One endless lane, the same for everyone. Chain your deliveries, keep the parcel whole — how far can you get?</p>' +
    record +
    resumeBtn +
    '<button class="sf-btn' + (resumeBtn ? "" : " primary") + '" id="sf-go-fly">Fly the lane</button>' +
    '<div class="sf-controls"><span>mouse drag</span><span>touch drag</span><span>← → ↑ ↓ or WASD</span></div>' +
    '<button class="sf-smallbtn" id="sf-sound2">Sound: ' + (Sound.muted ? "off" : "on") + '</button>' +
    '</div>';
  if (snap) el("sf-resume-run").addEventListener("click", function () { Sound.click(); resumeRun(snap); });
  el("sf-go-fly").addEventListener("click", function () { Sound.click(); startRun(); });
  el("sf-sound2").addEventListener("click", function () {
    var m = Sound.toggleMute(); refreshSoundBtn(m);
    this.textContent = "Sound: " + (m ? "off" : "on");
  });
}
function showResults(st, final, medal, newBest) {
  screen = "results";
  hud.hidden = true;
  /* clear the run's floaters/particles: they only advance during a
     run, so a leftover "Parcel hit" floater would otherwise hang
     frozen behind the results panel forever (cold playtest v1.2) */
  particles.length = 0; floaters.length = 0; effects.length = 0;
  overlay.style.display = "flex";
  var depthM = fmtScore(Math.round(st.depth / 10));
  var medalRow = medal !== "none"
    ? '<p class="sf-medal-line">' + medalDot(medal) + ' ' + esc(API.MEDAL_LABEL[medal]) + (newBest ? ' · a new best run' : '') + '</p>'
    : '<p class="sf-small dim">Medals start at 1,200 m with 4 deliveries — Bronze. Silver wants 2,600 m and 9.</p>';
  overlay.innerHTML =
    '<div class="sf-panel">' +
    '<h2 class="sf-h">The parcel broke apart.</h2>' +
    '<p class="sf-sub">You reached ' + depthM + ' m.</p>' + medalRow +
    '<div class="sf-stats">' +
      '<div><span>Score</span><strong>' + fmtScore(final) + '</strong></div>' +
      '<div><span>Depth</span><strong>' + depthM + ' m</strong></div>' +
      '<div><span>Deliveries</span><strong>' + st.deliveries + '</strong></div>' +
      '<div><span>Best chain</span><strong>' + st.bestChain + '</strong></div>' +
      '<div><span>Near misses</span><strong>' + st.nearMisses + '</strong></div>' +
      '<div><span>Time</span><strong>' + fmtMs(st.time * 1000) + '</strong></div>' +
    '</div>' +
    '<div class="sf-boardrow"><input type="text" id="sf-name" maxlength="24" placeholder="Nickname for the board" value="' +
      esc(API.getName()) + '" aria-label="Nickname for the board">' +
    '<button class="sf-btn" id="sf-board">Put this run on the board</button></div>' +
    '<p class="sf-small dim" id="sf-board-note"></p>' +
    '<div class="sf-row2">' +
      '<button class="sf-btn primary" id="sf-again">Fly again</button>' +
      '<button class="sf-btn ghost" id="sf-tostart">Back to the start</button>' +
    '</div></div>';
  el("sf-board").addEventListener("click", function () {
    var name = el("sf-name").value.trim() || "A player";
    API.setName(name);
    var detail = depthM + " m · " + st.deliveries + " deliveries" +
      (st.bosses > 0 ? " · " + st.bosses + (st.bosses === 1 ? " boss" : " bosses") + " survived" : "");
    API.submitScore(SLUG, "run", { name: name, score: final, detail: detail });
    el("sf-board-note").textContent = "On the board.";
    this.disabled = true;
  });
  el("sf-again").addEventListener("click", function () { Sound.click(); startRun(); });
  el("sf-tostart").addEventListener("click", function () { Sound.click(); showStart(); });
}

/* ---------------- effects ---------------- */
var particles = [], floaters = [], effects = [];
function burst(x, y, color, n, spread) {
  for (var i = 0; i < n; i++) {
    var a = Math.random() * Math.PI * 2, v = 40 + Math.random() * (spread || 130);
    particles.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 30,
                     life: 0.55 + Math.random() * 0.4, t: 0, color: color, r: 1.5 + Math.random() * 2 });
  }
  if (particles.length > 260) particles.splice(0, particles.length - 260);
}
function floater(x, y, text, color) {
  floaters.push({ x: x, y: y, text: text, color: color, t: 0, life: 1.15 });
  if (floaters.length > 14) floaters.shift();
}
var hitFlash = 0, shake = 0;
function handleEvents(evs) {
  for (var i = 0; i < evs.length; i++) {
    var e = evs[i];
    if (e.type === "delivered") {
      Sound.deliver(e.chain);
      if (e.swift) Sound.swift();
      burst(e.x, e.y, "#57ffc7", 16, 120);
      burst(e.x, e.y, "#ffb347", 8, 80);
      floater(e.x, e.y - 34, "+" + e.gained + (e.chain > 1 ? "  chain " + e.chain : ""), "#a7ffd9");
    } else if (e.type === "nearMiss") {
      Sound.nearMiss();
      floater(e.x, e.y + 26, "+25 near miss", "#9fb4ff");
    } else if (e.type === "hit") {
      Sound.hit();
      hitFlash = 1; shake = 9;
      burst(e.x, e.y, "#ff7a5c", 22, 190);
      floater(run.ship.x, run.ship.y - 40, "Parcel hit — " + e.integrity + "%", "#ffb59d");
    } else if (e.type === "chainLost") {
      Sound.chainLost();
    } else if (e.type === "bossAhead") {
      Sound.bossWarn();
      floater(240, 150, "⚠ " + e.name + " ahead", "#ffb59d");
    } else if (e.type === "bossClear") {
      Sound.clear();
      floater(run.ship.x, run.ship.y - 46, e.name + " survived · +" + e.gained, "#a7ffd9");
    } else if (e.type === "cleared") {
      Sound.clear();
    } else if (e.type === "failed") {
      Sound.fail();
      hitFlash = 1; shake = 12;
      burst(run.ship.x, run.ship.y, "#ffb347", 30, 220);
      burst(run.ship.x, run.ship.y, "#ff7a5c", 20, 160);
    }
  }
}

/* ---------------- rendering ---------------- */
var skyGrad = null;
function makeSky() {
  skyGrad = ctx.createLinearGradient(0, 0, 0, H);
  skyGrad.addColorStop(0, "#060a1c");
  skyGrad.addColorStop(0.55, "#0d1430");
  skyGrad.addColorStop(1, "#18224c");
}
makeSky();
var starLayers = [];
(function () {
  var rng = Core.mulberry32(Core.fnv1a("starfall-stars"));
  for (var L = 0; L < 2; L++) {
    var arr = [];
    for (var i = 0; i < 70; i++) arr.push({ x: rng() * W, d: rng() * 1800, s: 0.7 + rng() * (L ? 1.5 : 1), tw: rng() * 6.28 });
    starLayers.push({ f: L ? 0.62 : 0.34, arr: arr });
  }
})();
var PLANET_HUES = [222, 262, 18, 199, 336, 152, 275, 36];
/* Pre-rendered washes. A radial gradient is the most expensive thing a
   software rasterizer paints, and the two nebulae, the planet and the
   hit vignette were being repainted from scratch every frame. Each is
   painted once into an offscreen canvas here and blitted per frame
   instead — the same pixels for a fraction of the cost. (Perf fix,
   cold-playtest gate round: see evidence/perf-starfall-output.txt.) */
function makeSprite(w, h, painter) {
  var c = document.createElement("canvas");
  c.width = w; c.height = h;
  painter(c.getContext("2d"));
  return c;
}
var nebulaSprite1 = makeSprite(660, 660, function (g) {
  var gr = g.createRadialGradient(330, 330, 10, 330, 330, 330);
  gr.addColorStop(0, "rgba(96,64,180,0.20)");
  gr.addColorStop(1, "rgba(96,64,180,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 660, 660);
});
var nebulaSprite2 = makeSprite(600, 600, function (g) {
  var gr = g.createRadialGradient(300, 300, 10, 300, 300, 300);
  gr.addColorStop(0, "rgba(20,120,130,0.16)");
  gr.addColorStop(1, "rgba(20,120,130,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 600, 600);
});
var planetSprites = PLANET_HUES.map(function (hue) {
  return makeSprite(190, 190, function (g) {
    var gr = g.createRadialGradient(95, 95, 8, 95, 95, 95);
    gr.addColorStop(0, "hsla(" + hue + ",70%,68%,0.85)");
    gr.addColorStop(0.75, "hsla(" + hue + ",60%,46%,0.55)");
    gr.addColorStop(1, "hsla(" + hue + ",60%,40%,0)");
    g.fillStyle = gr;
    g.beginPath(); g.arc(95, 95, 95, 0, 6.2832); g.fill();
    g.fillStyle = "hsla(" + hue + ",65%,60%,0.9)";
    g.beginPath(); g.arc(95, 95, 52, 0, 6.2832); g.fill();
    g.fillStyle = "hsla(" + hue + ",70%,74%,0.5)";
    g.beginPath(); g.arc(79, 81, 34, 0, 6.2832); g.fill();
  });
});
var flashSprite = makeSprite(W, H, function (g) {
  var gr = g.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.72);
  gr.addColorStop(0, "rgba(255,60,30,0)");
  gr.addColorStop(1, "rgba(255,60,30,0.4)");
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
});
function drawBackground(depth, time, hueIdx) {
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, H);
  /* two slow nebula washes, far behind everything (pre-rendered) */
  var n1y = (((-depth * 0.08) % 3400) + 3400) % 3400 - 1200;
  ctx.drawImage(nebulaSprite1, 96 - 330, n1y - 330);
  var n2y = (((-depth * 0.05 + 1500) % 3400) + 3400) % 3400 - 1200;
  ctx.drawImage(nebulaSprite2, 404 - 300, n2y - 300);
  for (var L = 0; L < 2; L++) {
    var layer = starLayers[L];
    ctx.fillStyle = "#ffffff";
    for (var i = 0; i < layer.arr.length; i++) {
      var st = layer.arr[i];
      var y = (((st.d - depth * layer.f) % 1800) + 1800) % 1800 - 540;
      if (y < -4 || y > H + 4) continue;
      ctx.globalAlpha = (0.42 + 0.34 * Math.sin(time * 1.7 + st.tw)) * (L ? 1 : 0.72);
      ctx.fillRect(st.x, y, st.s, st.s);
    }
  }
  ctx.globalAlpha = 1;
  /* a slow planet, far off (pre-rendered per hue) */
  var px = 392, py = (((-depth * 0.12) % 2600) + 2600) % 2600 - 700;
  if (py > -190 && py < H + 190) {
    ctx.drawImage(planetSprites[hueIdx % PLANET_HUES.length], px - 95, py - 95);
  }
}
function meteorVerts(m) {
  if (m._v) return m._v;
  var rng = Core.mulberry32(Core.fnv1a("rock-" + m.seedI + "-" + Math.round(m.depth)));
  var v = [];
  for (var i = 0; i < 8; i++) v.push(0.74 + rng() * 0.34);
  m._v = v;
  return v;
}
function drawMeteor(m, x, y, time) {
  var v = meteorVerts(m);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(m.spin * time * 0.35);
  ctx.beginPath();
  for (var i = 0; i < 8; i++) {
    var a = i / 8 * Math.PI * 2, r = m.r * v[i];
    if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = "#2b3049";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,166,88,0.5)";
  ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(0, 0, m.r * 0.92, Math.PI * 1.05, Math.PI * 1.55); ctx.stroke();
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath(); ctx.arc(-m.r * 0.3, -m.r * 0.15, m.r * 0.22, 0, 6.2832); ctx.fill();
  ctx.beginPath(); ctx.arc(m.r * 0.28, m.r * 0.3, m.r * 0.16, 0, 6.2832); ctx.fill();
  ctx.restore();
}
function drawBeacon(x, y, time, isNext, delivered) {
  if (delivered) return;
  var pulse = 1 + Math.sin(time * 3.1 + x) * 0.08;
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = isNext ? 1 : 0.62;
  ctx.strokeStyle = "#57ffc7";
  ctx.lineWidth = isNext ? 3 : 2;
  ctx.beginPath(); ctx.arc(0, 0, 30 * pulse, 0, 6.2832); ctx.stroke();
  ctx.globalAlpha *= 0.5;
  ctx.beginPath(); ctx.arc(0, 0, 40 * pulse, 0, 6.2832); ctx.stroke();
  ctx.globalAlpha = isNext ? 1 : 0.75;
  /* the parcel waiting at the ring */
  ctx.fillStyle = "#ffb347";
  ctx.strokeStyle = "#7a4d12";
  ctx.lineWidth = 1;
  var s = 10;
  ctx.beginPath();
  ctx.roundRect(-s, -s * 0.8, s * 2, s * 1.6, 2.5);
  ctx.fill(); ctx.stroke();
  ctx.strokeStyle = "rgba(122,77,18,0.85)";
  ctx.beginPath(); ctx.moveTo(0, -s * 0.8); ctx.lineTo(0, s * 0.8); ctx.moveTo(-s, 0); ctx.lineTo(s, 0); ctx.stroke();
  ctx.restore();
}
function drawShip(st, time) {
  var s = st.ship;
  ctx.save();
  ctx.translate(s.x, s.y);
  if (st.invulnT > 0 && Math.sin(time * 26) > 0.2) ctx.globalAlpha = 0.45;
  /* engine flame — longer while the ship is climbing (v1.2: it no
     longer grows with height itself; the lane runs at one speed
     wherever the ship sits) */
  var fl = 13 + Math.sin(time * 42) * 3 + Math.max(0, -s.vy) * 0.03;
  ctx.fillStyle = "rgba(87,255,199,0.85)";
  ctx.beginPath();
  ctx.moveTo(-4.5, 15); ctx.lineTo(0, 15 + Math.max(6, fl)); ctx.lineTo(4.5, 15);
  ctx.closePath(); ctx.fill();
  ctx.rotate(Math.max(-0.32, Math.min(0.32, s.vx * 0.0011)));
  /* parcel, strapped behind the canopy */
  ctx.fillStyle = "#ffb347";
  ctx.strokeStyle = "#7a4d12"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(-8, -21, 16, 13, 2.5); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = "rgba(122,77,18,0.9)";
  ctx.beginPath(); ctx.moveTo(0, -21); ctx.lineTo(0, -8); ctx.stroke();
  if (st.integrity <= 60) { ctx.beginPath(); ctx.moveTo(-6, -19); ctx.lineTo(-1, -13); ctx.lineTo(-4, -9); ctx.stroke(); }
  if (st.integrity <= 32) { ctx.beginPath(); ctx.moveTo(6, -20); ctx.lineTo(2, -14); ctx.lineTo(6, -10); ctx.stroke(); }
  /* hull */
  var hull = ctx.createLinearGradient(0, -16, 0, 17);
  hull.addColorStop(0, "#f4f8ff"); hull.addColorStop(0.6, "#b9c8ea"); hull.addColorStop(1, "#7286b8");
  ctx.fillStyle = hull;
  ctx.beginPath();
  ctx.moveTo(0, -17);
  ctx.quadraticCurveTo(6.5, -6, 7.5, 5);
  ctx.lineTo(14, 14); ctx.lineTo(6, 12.5);
  ctx.lineTo(4, 16); ctx.lineTo(-4, 16); ctx.lineTo(-6, 12.5);
  ctx.lineTo(-14, 14); ctx.lineTo(-7.5, 5);
  ctx.quadraticCurveTo(-6.5, -6, 0, -17);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#20335f";
  ctx.beginPath(); ctx.ellipse(0, -4.5, 3.6, 6, 0, 0, 6.2832); ctx.fill();
  ctx.fillStyle = "rgba(160,220,255,0.85)";
  ctx.beginPath(); ctx.ellipse(-1, -6.5, 1.5, 2.6, 0, 0, 6.2832); ctx.fill();
  ctx.restore();
}
function render(state, time) {
  var snap = Core.snapshot(state);
  var hueIdx = Core.fnv1a(state.lane.seed) % 8;
  ctx.save();
  if (shake > 0.2) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  drawBackground(state.depth, time, hueIdx);
  /* beacons */
  var bs = state.beacons;
  var nb = Core.snapshot(state).nextBeacon;
  for (var i = 0; i < bs.length; i++) {
    var b = bs[i];
    if (b.done) continue;
    var by = Core.screenY(state, b.depth);
    if (by < -70 || by > H + 70) continue;
    drawBeacon(b.x, by, time, nb && Math.abs(nb.depth - b.depth) < 1, false);
  }
  /* next-beacon guide arrow when it is above the screen */
  if (nb && nb.y < -46) {
    ctx.save();
    ctx.translate(Math.max(24, Math.min(W - 24, nb.x)), 20);
    ctx.fillStyle = "#57ffc7";
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(8, 5); ctx.lineTo(-8, 5); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  /* boss telegraph: a standing banner while one approaches, its name
     while it is on you — the warning never depends on catching a
     one-second floater (cold playtest, v1.1) */
  if (snap.bossAhead) {
    var bName = snap.bossAhead.name.toUpperCase();
    var bText = snap.bossAhead.active ? bName : "⚠ " + bName + " AHEAD";
    ctx.save();
    ctx.font = "700 14px system-ui, sans-serif";
    var bW = ctx.measureText(bText).width + 26;
    ctx.fillStyle = "rgba(8, 8, 22, 0.62)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(W / 2 - bW / 2, 44, bW, 26, 13); else ctx.rect(W / 2 - bW / 2, 44, bW, 26);
    ctx.fill();
    ctx.fillStyle = snap.bossAhead.active ? "#ffd9a8" : "#ffb59d";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(bText, W / 2, 58);
    ctx.restore();
  }
  /* meteors (verts keyed by depth: stable per rock, no state kept) */
  for (var j = 0; j < snap.meteors.length; j++) {
    var sm = snap.meteors[j];
    drawMeteor({ depth: sm.depth, x: sm.baseX, r: sm.r, spin: sm.spin, seedI: 0 }, sm.x, sm.y, time);
  }
  drawShip(state, time);
  /* particles */
  for (var p = particles.length - 1; p >= 0; p--) {
    var pt = particles[p];
    ctx.globalAlpha = Math.max(0, 1 - pt.t / pt.life);
    ctx.fillStyle = pt.color;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.r, 0, 6.2832); ctx.fill();
  }
  ctx.globalAlpha = 1;
  /* floaters */
  ctx.textAlign = "center";
  for (var f = 0; f < floaters.length; f++) {
    var fl2 = floaters[f];
    ctx.globalAlpha = Math.max(0, 1 - fl2.t / fl2.life);
    ctx.fillStyle = fl2.color;
    ctx.font = "650 14px -apple-system, 'Segoe UI', sans-serif";
    ctx.fillText(fl2.text, fl2.x, fl2.y - fl2.t * 34);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  if (hitFlash > 0.01) {
    ctx.globalAlpha = hitFlash;
    ctx.drawImage(flashSprite, 0, 0);
    ctx.globalAlpha = 1;
  }
}

/* attract mode: the game flies the lane itself behind the start screen */
var attract = null;
function ensureAttract() {
  if (!attract) {
    attract = Core.createRun();
  }
  return attract;
}
function stepAttract(dt) {
  var st = ensureAttract();
  var s = Core.snapshot(st);
  var ix = 0;
  var gx = s.nextBeacon ? s.nextBeacon.x : 240 + Math.sin(st.time * 0.3) * 120;
  ix = Math.max(-0.8, Math.min(0.8, (gx - s.x) / 70));
  for (var i = 0; i < s.meteors.length; i++) {
    var m = s.meteors[i];
    var ahead = s.y - m.y;
    if (ahead > 0 && ahead < 240 && Math.abs(m.x - s.x) < m.r + 40) ix += (m.x >= s.x ? -0.7 : 0.7);
  }
  Core.stepRun(st, { x: Math.max(-1, Math.min(1, ix)), y: (150 - s.y) / 90 }, dt);
  if (st.done) attract = Core.createRun();
}

/* ---------------- HUD ---------------- */
function updateHUD() {
  if (!run) return;
  el("sf-score").textContent = fmtScore(Core.finalScore(run));
  var ch = el("sf-chain");
  if (run.chain >= 2) {
    var mult = 1 + 0.25 * Math.min(run.chain - 1, 12);
    ch.textContent = "chain " + run.chain + " · ×" + mult.toFixed(2).replace(/0$/, "");
  } else ch.textContent = "";
  var dv = el("sf-deliv");
  if (dv) dv.textContent = fmtScore(Math.round(run.depth / 10)) + " m · deliveries " + run.deliveries +
    (run.bosses > 0 ? " · " + run.bosses + (run.bosses === 1 ? " boss" : " bosses") : "");
  el("sf-parcel-fill").style.width = run.integrity + "%";
  el("sf-parcel-fill").style.background = run.integrity > 50 ? "#ffb347" : (run.integrity > 25 ? "#ff8a5c" : "#ff5c47");
  el("sf-parcel-pct").textContent = run.integrity + "%";
  var pf = el("sf-progress-fill");
  pf.parentElement.style.display = "none"; /* an endless lane has no route bar */
  if (performance.now() - hintShownAt > 7000) el("sf-hint").style.opacity = "0";
}

/* ---------------- main loop ---------------- */
var lastTs = 0, lastSnapTs = 0;
/* The game also sits inside longer pages now (home, game page).
   While the frame is scrolled out of view, idle screens (start,
   results) stop stepping and rendering the attract run — an
   attract loop nobody can see should not cost the page its
   scroll. A run in progress is never gated, and on the play page
   the frame is always in view, so nothing changes there. */
var stageVisible = true;
if (window.IntersectionObserver) {
  new IntersectionObserver(function (entries) {
    stageVisible = entries[0].isIntersecting;
  }, { threshold: 0.02 }).observe(document.getElementById("sf-stage"));
}
window.addEventListener("beforeunload", function () { snapshotRun(); });
function loop(ts) {
  requestAnimationFrame(loop);
  var dt = Math.min(0.033, lastTs ? (ts - lastTs) / 1000 : 0.016);
  lastTs = ts;
  var time = ts / 1000;
  if (screen === "run" && run) {
    if (!paused && !run.done) {
      var sub = 2, sdt = dt / sub;
      for (var i = 0; i < sub; i++) {
        var evs = Core.stepRun(run, currentInput(), sdt);
        if (evs.length) handleEvents(evs);
        if (run.done) break;
      }
      if (ts - lastSnapTs > 2000) { snapshotRun(); lastSnapTs = ts; }
      if (run.done && !runFinalized) {
        endTimer = setTimeout(finalizeRun, 850);
      }
    }
    /* effects advance even while the run settles */
    for (var p = particles.length - 1; p >= 0; p--) {
      var pt = particles[p]; pt.t += dt;
      pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vy += 130 * dt;
      if (pt.t >= pt.life) particles.splice(p, 1);
    }
    for (var f = floaters.length - 1; f >= 0; f--) {
      floaters[f].t += dt;
      if (floaters[f].t >= floaters[f].life) floaters.splice(f, 1);
    }
    if (hitFlash > 0) hitFlash = Math.max(0, hitFlash - dt * 2.4);
    if (shake > 0) shake = Math.max(0, shake - dt * 26);
    render(run, time);
    if (!hud.hidden) updateHUD();
  } else if (stageVisible) {
    stepAttract(dt);
    render(attract, time);
  }
}
requestAnimationFrame(loop);
showStart();

/* read-only snapshot for test drivers (documented in the gate report;
   it exposes state, it cannot change it) */
window.__starfall = {
  snapshot: function () {
    if (screen === "run" && run) {
      var s = Core.snapshot(run);
      s.screen = screen; s.paused = paused;
      return s;
    }
    return { screen: screen };
  },
  /* v1.3: the audio suite's read-only view of the sound engine */
  sound: function () { return Sound.debugState(); },
  /* FD-045 (SPA): the shell's router asks the game to pause a live
     run when navigation is about to hide the stage. Goes through
     the game's own pause path (togglePause, with its snapshot and
     resume panel); a no-op unless a run is live and unpaused. */
  pause: function () {
    if (screen === "run" && run && !run.done && !paused) togglePause();
  }
};
})();
