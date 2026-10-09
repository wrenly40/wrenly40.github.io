/* The Night Log — case generator and verifier.
 *
 * Every case is built from propositions. The scene is a small fact base
 * (where each witness was at each bell, what sounds happened, what state
 * things were in). Testimony statements are propositions too, and each
 * one is evaluated against the fact base by fixed rules (sight lines,
 * sound reach, lamplight, a witness's known limits). The generator only
 * ever emits statements it has evaluated; the verifier re-evaluates
 * every statement in a finished case and proves:
 *
 *   - exactly the intended witness(es) carry a false statement;
 *   - each of them carries exactly one;
 *   - every other statement is true;
 *   - every premise a player needs to check any statement is present
 *     in the facts the case file shows.
 *
 * So no ambiguous case can reach a player: if the proof fails, the
 * case is thrown away. This file has no DOM code. It runs in the
 * browser for the game and in Node for the bulk verification.
 */
(function (global) {
"use strict";

/* ---------------- seeds and randomness ---------------- */

function hashStr(s) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function RNG(seed) { this.a = (typeof seed === "number" ? seed : hashStr(String(seed))) >>> 0; }
RNG.prototype.next = function () {
  this.a |= 0; this.a = (this.a + 0x6D2B79F5) | 0;
  var t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
RNG.prototype.int = function (n) { return Math.floor(this.next() * n); };
RNG.prototype.pick = function (arr) { return arr[this.int(arr.length)]; };
RNG.prototype.chance = function (p) { return this.next() < p; };
RNG.prototype.shuffle = function (arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) { var j = this.int(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
};
RNG.prototype.sample = function (arr, n) { return this.shuffle(arr).slice(0, n); };

/* ---------------- pools ---------------- */

var NAMES = ["Mara", "Elias", "Ruth", "Tobias", "Ada", "Silas", "Nora", "Amos",
  "Lydia", "Caleb", "Hester", "Jonas", "Mabel", "Ezra", "Clara", "Reuben",
  "Ivy", "Gideon", "Pearl", "Seth", "Agnes", "Levi", "Miriam", "Owen",
  "Bram", "Cora", "Edith", "Felix", "Greta", "Hugh", "Iris", "Jasper",
  "Maud", "Nathaniel", "Opal", "Wilbur"];

var FLAVOR = [
  "The wind had teeth that night.",
  "I have not slept properly since, if I am honest.",
  "You will think me fanciful. I set it down anyway.",
  "The sea was loud enough to cover a great deal.",
  "I keep my wits about me on that path, always.",
  "It was the sort of night that makes a person check the door twice.",
  "The tide was out and the mud stank, begging your pardon.",
  "There was a moon, but it showed nobody anything.",
  "I said my prayers twice over before I slept.",
  "The cold got into my bones and stayed there.",
  "The dog would not settle, all evening."
];

/* Known limits a witness can have. An attr blocks the listed actions. */
var ATTRS = {
  onehand: {
    blocks: ["write", "row", "haul"],
    fact: function (n, v) { return v === 1
      ? "A sling holds " + n + "'s right hand — the hand " + n + " writes and works with."
      : n + "'s right hand is in a sling, and " + n + " writes and works with that hand."; }
  },
  lame: {
    blocks: ["climb"],
    fact: function (n, v) { return v === 1
      ? "Since the accident on the ice, " + n + " gets about with a stick, and climbing is beyond them."
      : n + " walks with a stick since the accident on the ice, and cannot climb."; }
  }
};

/* Actions a witness may be seen doing. */
var ACTIONS = {
  write: { gerund: "writing in the log book", past: "wrote in the log book" },
  row:   { gerund: "rowing the little boat", past: "rowed the little boat" },
  climb: { gerund: "climbing the ladder", past: "climbed the ladder" },
  haul:  { gerund: "hauling on the rope", past: "hauled on the rope" }
};

/* The thing's tells. The journal collects three across a shift; the
   finale's false statement defies one of them. */
var TELLS = [
  { id: "noreflect",
    journal: "It casts no reflection — not in water, not in glass.",
    claim: "I stood at the pool with the rest of you and saw my own face in the water, clear as any of yours.",
    banish: "Turn the black mirror to face it.",
    reveal: "Still water does not lie. A face that is not there cannot be seen in a pool." },
  { id: "nocross",
    journal: "It cannot cross running water.",
    claim: "I waded the beck twice that night, fetching and carrying, and thought nothing of it.",
    banish: "Drive it to the beck, and hold the far bank.",
    reveal: "Running water is a wall to it. It could no more wade the beck than walk through the chapel door stone." },
  { id: "noiron",
    journal: "It cannot close bare skin on iron.",
    claim: "I hauled the iron gate to with my bare hands and shot the bolt home myself.",
    banish: "Put the cold iron key into its hand.",
    reveal: "Iron is the one honest thing in this parish. Bare skin that closes on it is human skin." },
  { id: "nosalt",
    journal: "It cannot eat salt, nor cross a line of it.",
    claim: "I ate the salt pork with the rest of you, and went back for a second helping.",
    banish: "Lay a line of salt across the doorway.",
    reveal: "Salt is older than anything that walks here. It would starve at a full table before it tasted salt pork." },
  { id: "noleft",
    journal: "It never uses the left hand. Everything it does, it does right-handed, even when the left would serve.",
    claim: "The lamp slipped as I passed it over, and I caught it left-handed, quick as a cat.",
    banish: "Offer it the cup in its left hand, and watch.",
    reveal: "Twelve cases have taught the log this much: the thing has no use of a left hand, and cannot pretend one." }
];

/* ---------------- frames (the haunted places) ---------------- */
/* visible[room] = rooms that can be seen FROM that room (including itself).
   reach[soundSourceRoom] = rooms a sound made there carries to. */

var FRAMES = [
{ id: "lighthouse", title: "The Lighthouse on Gannet Rock",
  intro: "The packet boat went down at dusk with all hands but one, and the one would not say what he had seen from the water. The inspector sent for you before the light was lit. Four people were on the rock that night. One of them was not a person.",
  intro2: "A supply boat found the lamp unlit at midnight and the rock silent, and what its crew saw on the gallery they will only tell one at a time, and quietly. Four people were on the rock that night. One of them was not a person.",
  times: ["nine", "ten", "eleven"],
  rooms: [
    { id: "lamp", name: "the lamp room" }, { id: "gallery", prep: "on", name: "the gallery" },
    { id: "stair", name: "the stair" }, { id: "oilstore", name: "the oil store" },
    { id: "cottage", name: "the cottage" }, { id: "rocks", prep: "on", name: "the rocks below" }
  ],
  visible: { lamp: ["lamp", "gallery", "rocks"], gallery: ["gallery", "lamp", "rocks", "cottage"],
    stair: ["stair"], oilstore: ["oilstore"], cottage: ["cottage", "rocks", "gallery"], rocks: ["rocks", "gallery", "cottage"] },
  sounds: [
    { id: "bell", name: "the fog bell", place: "gallery", reach: ["gallery", "lamp", "cottage", "rocks", "stair"] },
    { id: "horn", name: "a ship's horn out on the water", place: "rocks", reach: ["rocks", "gallery", "cottage"] }
  ],
  darkCandidates: ["oilstore", "stair"],
  roles: ["the keeper", "the keeper's wife", "a fisherman off the cove", "the doctor", "the lighthouse inspector", "a sailor off the packet"],
  actions: ["write", "climb", "haul"],
  objects: [
    { id: "key", name: "the brass key", states: {
      hanging: { fact: "The brass key hangs on its hook by the lamp-room door.", claim: "the brass key was hanging on its hook" },
      gone: { fact: "The brass key is gone from its hook by the lamp-room door.", claim: "the brass key was gone from its hook" } } },
    { id: "oilcan", name: "the oil can", states: {
      full: { fact: "The oil can stands full by the lamp.", claim: "the oil can was full" },
      empty: { fact: "The oil can stands empty by the lamp.", claim: "the oil can was empty" } } }
  ]
},
{ id: "lifeboat", title: "The Lifeboat Station",
  intro: "The maroon went up for a boat that was never found, and the crew came home in the small hours with one more man aboard than had put out — or so the coxswain swore, and then would not swear it. Four people were about the station that night. One of them was not a person.",
  intro2: "The boat came back at dawn with her crew of six and a seventh shape in the stern sheets that was gone by the time she touched the slipway. Four people were about the station that night. One of them was not a person.",
  times: ["nine", "ten", "eleven"],
  rooms: [
    { id: "boathouse", name: "the boathouse" }, { id: "slipway", prep: "on", name: "the slipway" },
    { id: "watch", name: "the watch room" }, { id: "kitstore", name: "the kit store" },
    { id: "jetty", prep: "on", name: "the jetty" }
  ],
  visible: { boathouse: ["boathouse", "slipway"], slipway: ["slipway", "boathouse", "jetty"],
    watch: ["watch", "jetty", "slipway"], kitstore: ["kitstore"], jetty: ["jetty", "slipway", "watch"] },
  sounds: [
    { id: "maroon", name: "the signal maroon", place: "slipway", reach: ["slipway", "boathouse", "watch", "jetty"] },
    { id: "jettybell", name: "the jetty bell", place: "jetty", reach: ["jetty", "slipway", "watch"] }
  ],
  darkCandidates: ["kitstore", "boathouse"],
  roles: ["the coxswain", "a crewman", "the mechanic", "the vicar", "a fisherman off the cove", "the station secretary"],
  actions: ["write", "haul", "row"],
  objects: [
    { id: "flarebox", name: "the flare box", states: {
      locked: { fact: "The flare box is locked, with its seal unbroken.", claim: "the flare box was locked with its seal unbroken" },
      open: { fact: "The flare box stands open, its seal broken.", claim: "the flare box was standing open" } } },
    { id: "whistle", name: "the coxswain's whistle", states: {
      hook: { fact: "The coxswain's whistle hangs on its nail in the watch room.", claim: "the coxswain's whistle was on its nail" },
      gone: { fact: "The coxswain's whistle is gone from its nail in the watch room.", claim: "the coxswain's whistle was gone from its nail" } } }
  ]
},
{ id: "church", title: "The Drowned Church",
  intro: "The spring tide came into the nave again, and in the morning there were wet footprints on the altar steps that no living foot had made — the sexton counted them twice. Four people were about the church that night. One of them was not a person.",
  intro2: "The verger found the font full of seawater though the doors had been barred, and a psalm-book open at a page no hand had turned in living memory. Four people were about the church that night. One of them was not a person.",
  times: ["nine", "ten", "eleven"],
  rooms: [
    { id: "nave", name: "the nave" }, { id: "tower", name: "the bell tower" },
    { id: "vestry", name: "the vestry" }, { id: "churchyard", name: "the churchyard" },
    { id: "lychgate", name: "the lychgate" }
  ],
  visible: { nave: ["nave", "churchyard"], tower: ["tower", "churchyard", "lychgate", "nave"],
    vestry: ["vestry"], churchyard: ["churchyard", "nave", "lychgate", "tower"], lychgate: ["lychgate", "churchyard"] },
  sounds: [
    { id: "churchbell", name: "the church bell", place: "tower", reach: ["tower", "churchyard", "nave", "lychgate"] },
    { id: "handbell", name: "the little handbell", place: "vestry", reach: ["vestry", "nave"] }
  ],
  darkCandidates: ["vestry", "nave"],
  roles: ["the vicar", "the sexton", "a churchwarden", "the organist's widow", "a gravedigger", "the schoolmistress"],
  actions: ["write", "climb", "haul"],
  objects: [
    { id: "chalice", name: "the silver chalice", states: {
      press: { fact: "The silver chalice is shut in its press in the vestry.", claim: "the silver chalice was shut in its press" },
      gone: { fact: "The silver chalice is gone from its press in the vestry.", claim: "the silver chalice was gone from its press" } } },
    { id: "register", name: "the parish register", states: {
      dry: { fact: "The parish register lies dry on its shelf.", claim: "the parish register was dry on its shelf" },
      wet: { fact: "The parish register lies open, and wet through.", claim: "the parish register was lying open and wet" } } }
  ]
},
{ id: "hotel", title: "The Cliff Hotel",
  intro: "A guest checked in after midnight who is in no register, and in the morning a room on the top floor stood open that has been locked since October. The manager will not have it in the papers. Four people were about the hotel that night. One of them was not a person.",
  intro2: "The morning boots found one pair too many outside the doors on the top floor, caked in shingle though it had not rained, and no room wanting them cleaned. Four people were about the hotel that night. One of them was not a person.",
  times: ["ten", "eleven", "midnight"],
  rooms: [
    { id: "lobby", name: "the lobby" }, { id: "dining", name: "the dining room" },
    { id: "kitchen", name: "the kitchen" }, { id: "cellar", name: "the cellar" },
    { id: "terrace", prep: "on", name: "the terrace" }, { id: "landing", prep: "on", name: "the landing" }
  ],
  visible: { lobby: ["lobby", "terrace", "landing"], dining: ["dining", "terrace"],
    kitchen: ["kitchen"], cellar: ["cellar"], terrace: ["terrace", "lobby", "dining"], landing: ["landing", "lobby"] },
  sounds: [
    { id: "gong", name: "the dinner gong", place: "dining", reach: ["dining", "lobby", "terrace", "landing", "kitchen"] },
    { id: "telephone", name: "the telephone in the lobby", place: "lobby", reach: ["lobby", "landing"] }
  ],
  darkCandidates: ["cellar", "kitchen"],
  roles: ["the manager", "the night porter", "a guest, a colonel", "the cook", "a chambermaid", "the doctor"],
  actions: ["write", "climb", "haul"],
  objects: [
    { id: "masterkey", name: "the master key", states: {
      board: { fact: "The master key hangs on its board behind the desk.", claim: "the master key was on its board" },
      gone: { fact: "The master key is gone from its board behind the desk.", claim: "the master key was gone from its board" } } },
    { id: "register", name: "the hotel register", states: {
      shut: { fact: "The hotel register lies shut for the night.", claim: "the hotel register was shut" },
      open: { fact: "The hotel register lies open, in a hand nobody knows.", claim: "the hotel register was lying open" } } }
  ]
},
{ id: "mill", title: "The Tide Mill",
  intro: "The mill ground all night with no grain in the hopper, and at dawn the tally board showed a full sack accounted to nobody. The miller sent his boy running for you before he would set foot on the mill floor. Four people were about the mill that night. One of them was not a person.",
  intro2: "The millstones were found turning at first light with the sluice shut and the pond still, and a row of wet prints crossed the floor where no one owned to walking. Four people were about the mill that night. One of them was not a person.",
  times: ["nine", "ten", "eleven"],
  rooms: [
    { id: "floor", name: "the mill floor" }, { id: "granary", name: "the granary" },
    { id: "sluice", name: "the sluice room" }, { id: "yard", name: "the yard" },
    { id: "bank", prep: "on", name: "the millpond bank" }
  ],
  visible: { floor: ["floor", "yard"], granary: ["granary"], sluice: ["sluice", "bank"],
    yard: ["yard", "floor", "bank"], bank: ["bank", "yard", "sluice"] },
  sounds: [
    { id: "millbell", name: "the mill bell", place: "floor", reach: ["floor", "yard", "granary"] },
    { id: "chain", name: "the sluice chain", place: "sluice", reach: ["sluice", "bank"] }
  ],
  darkCandidates: ["granary", "sluice"],
  roles: ["the miller", "the miller's son", "a carter", "the baker", "the miller's wife", "a poacher, kept for the constable"],
  actions: ["write", "haul", "climb"],
  objects: [
    { id: "tally", name: "the tally board", states: {
      clean: { fact: "The tally board is wiped clean for the night.", claim: "the tally board was wiped clean" },
      marked: { fact: "The tally board is chalked full, in a tall hand.", claim: "the tally board was chalked full" } } },
    { id: "sluicekey", name: "the sluice key", states: {
      peg: { fact: "The sluice key hangs on its peg by the door.", claim: "the sluice key was on its peg" },
      gone: { fact: "The sluice key is gone from its peg by the door.", claim: "the sluice key was gone from its peg" } } }
  ]
},
{ id: "inn", title: "The Wreckers' Inn",
  intro: "A ship went ashore on the shingle in the fog, and by first light her cargo was ashore too, every cask of it, though no boat had put out and no cart had rolled. The landlord keeps a civil house and wants it kept that way. Four people were about the inn that night. One of them was not a person.",
  intro2: "In the morning the cellar tally showed a cask broached that the landlord never sold and no guest ever paid for, and the stable dog has not barked at a stranger since — it will not go near the yard at all. Four people were about the inn that night. One of them was not a person.",
  times: ["nine", "ten", "eleven"],
  rooms: [
    { id: "bar", name: "the bar" }, { id: "parlour", name: "the parlour" },
    { id: "kitchen", name: "the kitchen" }, { id: "cellar", name: "the cellar" },
    { id: "yard", name: "the yard" }, { id: "loft", name: "the loft" }
  ],
  visible: { bar: ["bar", "yard"], parlour: ["parlour"], kitchen: ["kitchen", "bar"],
    cellar: ["cellar"], yard: ["yard", "bar", "loft"], loft: ["loft", "yard"] },
  sounds: [
    { id: "stablebell", name: "the stable bell", place: "yard", reach: ["yard", "bar", "loft"] },
    { id: "fiddle", name: "a fiddle in the bar", place: "bar", reach: ["bar", "kitchen", "parlour"] }
  ],
  darkCandidates: ["cellar", "loft"],
  roles: ["the landlord", "the landlord's daughter", "the ostler", "a carrier off the London road", "a Preventive man", "a widow lodging upstairs"],
  actions: ["write", "haul", "climb"],
  objects: [
    { id: "strongbox", name: "the strongbox", states: {
      shut: { fact: "The strongbox is locked in the landlord's cupboard.", claim: "the strongbox was locked" },
      open: { fact: "The strongbox stands open in the landlord's cupboard, empty.", claim: "the strongbox was standing open" } } },
    { id: "keg", name: "the brandy keg", states: {
      full: { fact: "The brandy keg in the cellar stands full, its bung in.", claim: "the brandy keg was full" },
      empty: { fact: "The brandy keg in the cellar stands empty, its bung out.", claim: "the brandy keg was empty" } } }
  ]
},
{ id: "signal", title: "The Signal Station",
  intro: "Three signals were made in the night that no hand at the station owns to, and a ship answered them and stood in toward the rocks before the true light was shown. The signalman sent his lad down the cliff path for you at first light. Four people were about the station that night. One of them was not a person.",
  intro2: "The station log for the night is written in two hands, and the second hand is nobody's at the station — it spells the signalman's own name wrong, politely. Four people were about the station that night. One of them was not a person.",
  times: ["ten", "eleven", "midnight"],
  rooms: [
    { id: "platform", prep: "on", name: "the platform" }, { id: "lamp", name: "the lamp room" },
    { id: "store", name: "the store" }, { id: "cottage", name: "the cottage" },
    { id: "path", prep: "on", name: "the cliff path" }
  ],
  visible: { platform: ["platform", "path", "cottage"], lamp: ["lamp", "platform"],
    store: ["store"], cottage: ["cottage", "platform", "path"], path: ["path", "platform", "cottage"] },
  sounds: [
    { id: "gun", name: "the signal gun", place: "platform", reach: ["platform", "path", "cottage", "lamp"] },
    { id: "stationbell", name: "the station bell", place: "lamp", reach: ["lamp", "platform"] }
  ],
  darkCandidates: ["store", "cottage"],
  roles: ["the signalman", "the signalman's wife", "a telegraph clerk", "the coastguard", "a captain ashore from the brig", "the doctor"],
  actions: ["write", "climb", "haul"],
  objects: [
    { id: "codebook", name: "the code book", states: {
      shelf: { fact: "The code book lies on its shelf in the lamp room.", claim: "the code book was on its shelf" },
      gone: { fact: "The code book is gone from its shelf in the lamp room.", claim: "the code book was gone from its shelf" } } },
    { id: "stormlantern", name: "the storm lantern", states: {
      lit: { fact: "The storm lantern burns lit on the platform.", claim: "the storm lantern was lit" },
      dark: { fact: "The storm lantern stands dark on the platform.", claim: "the storm lantern was dark" } } }
  ]
}
];

/* The finale returns to the drowned church at dawn. */
var FINALE_INTRO = "It has followed the log from parish to parish, and tonight it has come home to the drowned church, where the tide is in the nave and the pool by the altar stands black and still. Four people are here at dawn. This time the log itself is the evidence: three nights of it are written in your journal, and the thing does not know what the log has learned.";

/* ---------------- propositions ---------------- */

function propKey(p) {
  switch (p.k) {
    case "at": return "at|" + p.p + "|" + p.place + "|" + p.t;
    case "event": return "event|" + p.s + "|" + p.t;
    case "saw": return "saw|" + p.p + "|" + p.q + "|" + p.t;
    case "heard": return "heard|" + p.p + "|" + p.s + "|" + p.t;
    case "state": return "state|" + p.o + "|" + p.v;
    case "did": return "did|" + p.p + "|" + p.a;
    case "attr": return "attr|" + p.p + "|" + p.a;
    case "defies": return "defies|" + p.tell;
  }
  return JSON.stringify(p);
}

function buildCtx(frame, facts, darkRoom, journal) {
  var fb = {};
  facts.forEach(function (f) { fb[propKey(f)] = f; });
  function placeOf(p, t) {
    for (var key in fb) {
      var f = fb[key];
      if (f.k === "at" && f.p === p && f.t === t) return f.place;
    }
    return null;
  }
  return { frame: frame, fb: fb, placeOf: placeOf, dark: darkRoom || null, journal: journal || [] };
}

function evaluate(prop, ctx) {
  var fb = ctx.fb, frame = ctx.frame;
  switch (prop.k) {
    case "at": return !!fb[propKey(prop)];
    case "event": return !!fb[propKey(prop)];
    case "state": {
      for (var key in fb) { var f = fb[key]; if (f.k === "state" && f.o === prop.o) return f.v === prop.v; }
      return false;
    }
    case "attr": return !!fb[propKey(prop)];
    case "saw": {
      if (prop.p === prop.q) return false;
      var pp = ctx.placeOf(prop.p, prop.t), pq = ctx.placeOf(prop.q, prop.t);
      if (!pp || !pq) return false;
      if (ctx.dark && pq === ctx.dark) return false;
      return (frame.visible[pp] || []).indexOf(pq) !== -1;
    }
    case "heard": {
      var ev = null;
      for (var k2 in fb) { var f2 = fb[k2]; if (f2.k === "event" && f2.s === prop.s && f2.t === prop.t) ev = f2; }
      if (!ev) return false;
      var pp2 = ctx.placeOf(prop.p, prop.t);
      if (!pp2) return false;
      var sound = null;
      frame.sounds.forEach(function (s) { if (s.id === prop.s) sound = s; });
      return sound.reach.indexOf(pp2) !== -1;
    }
    case "did": {
      for (var k3 in fb) {
        var f3 = fb[k3];
        if (f3.k === "attr" && f3.p === prop.p && ATTRS[f3.a].blocks.indexOf(prop.a) !== -1) return false;
      }
      return !!fb[propKey(prop)];
    }
    case "defies": return ctx.journal.indexOf(prop.tell) === -1;
  }
  return false;
}

/* Premises a player needs, to check a statement for themselves. */
function premises(prop, ctx) {
  var frame = ctx.frame;
  switch (prop.k) {
    case "at": return ["move|" + prop.p + "|" + prop.t];
    case "event": return ["event|" + prop.s + "|" + prop.t];
    case "state": return ["state|" + prop.o];
    case "attr": return ["attr|" + prop.p];
    case "saw": {
      var pp = ctx.placeOf(prop.p, prop.t), pq = ctx.placeOf(prop.q, prop.t);
      return ["move|" + prop.p + "|" + prop.t, "move|" + prop.q + "|" + prop.t,
        "vis|" + pp + ">" + pq, "light"];
    }
    case "heard": {
      var pp2 = ctx.placeOf(prop.p, prop.t);
      return ["move|" + prop.p + "|" + prop.t, "event|" + prop.s + "|" + prop.t, "reach|" + prop.s + "@" + pp2];
    }
    case "did": {
      /* A did-statement is checked against the did-fact line when the
         act happened, or against the witness's known limit when the
         act is one they cannot perform. Only the relevant line is a
         premise. */
      var blockedBy = null;
      for (var key in ctx.fb) {
        var f = ctx.fb[key];
        if (f.k === "attr" && f.p === prop.p && ATTRS[f.a].blocks.indexOf(prop.a) !== -1) blockedBy = f;
      }
      if (blockedBy) return ["attr|" + prop.p];
      return ["did|" + prop.p + "|" + prop.a];
    }
    case "defies": return ["tell|" + prop.tell];
  }
  return [];
}

/* ---------------- claim text ---------------- */

function roomName(frame, id) {
  for (var i = 0; i < frame.rooms.length; i++) if (frame.rooms[i].id === id) return frame.rooms[i].name;
  return id;
}
/* "in the lamp room", "on the millpond bank" — rooms carry their preposition. */
function placePhrase(frame, id) {
  for (var i = 0; i < frame.rooms.length; i++) if (frame.rooms[i].id === id)
    return (frame.rooms[i].prep || "in") + " " + frame.rooms[i].name;
  return "in " + id;
}
function soundOf(frame, id) {
  for (var i = 0; i < frame.sounds.length; i++) if (frame.sounds[i].id === id) return frame.sounds[i];
  return null;
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function claimText(prop, ctx, W, rng) {
  var frame = ctx.frame;
  var speaker = W[prop._speaker];
  switch (prop.k) {
    case "at":
      return rng.pick([
        "I was " + placePhrase(frame, prop.place) + " at " + prop.t + ".",
        cap(prop.t) + " found me " + placePhrase(frame, prop.place) + ", and I stayed a good while."
      ]);
    case "saw": {
      var q = W[prop.q], qp = placePhrase(frame, ctx.placeOf(prop.q, prop.t));
      return rng.pick([
        "I saw " + q.name + " " + qp + " at " + prop.t + ".",
        "At " + prop.t + " I could see " + q.name + " plainly, over " + qp + ".",
        "I watched " + q.name + " " + qp + " at " + prop.t + ", and I am sure of it."
      ]);
    }
    case "heard": {
      var s = soundOf(frame, prop.s);
      return rng.pick([
        "I heard " + s.name + " at " + prop.t + ", clear as anything.",
        "At " + prop.t + ", " + s.name + " reached me where I stood."
      ]);
    }
    case "state": {
      var obj = null;
      frame.objects.forEach(function (o) { if (o.id === prop.o) obj = o; });
      return rng.pick([
        "I noticed " + obj.states[prop.v].claim + ".",
        "I can tell you " + obj.states[prop.v].claim + "."
      ]);
    }
    case "did": {
      var a = ACTIONS[prop.a], subj = W[prop.p];
      if (prop._speaker === prop.p) return "I " + a.past + " that night, before the last bell.";
      return rng.pick([
        "I saw " + subj.name + " " + a.gerund + ".",
        subj.name + " " + a.past + " — I saw it with my own eyes."
      ]);
    }
    case "defies": {
      var tell = null;
      TELLS.forEach(function (t) { if (t.id === prop.tell) tell = t; });
      return tell.claim;
    }
  }
  return "";
}

function familyOf(prop, ctx) {
  switch (prop.k) {
    case "at": return "temporal";
    case "saw": return (ctx.dark && ctx.placeOf(prop.q, prop.t) === ctx.dark) ? "sensory" : "spatial";
    case "heard": return "sensory";
    case "state": return "object";
    case "did": return "identity";
    case "defies": return "tell";
  }
  return "object";
}

/* Enumerate every statement any witness could make, evaluated. */
function enumerateClaims(ctx, W) {
  var frame = ctx.frame, claims = [];
  function add(speaker, prop) {
    prop._speaker = speaker;
    var truth = evaluate(prop, ctx);
    claims.push({ speaker: speaker, prop: prop, truth: truth, family: familyOf(prop, ctx), needs: premises(prop, ctx) });
  }
  var times = Object.keys(W.reduce(function (acc, w, i) {
    return acc;
  }, {}));
  var timeSet = {};
  for (var key in ctx.fb) { var f = ctx.fb[key]; if (f.k === "at") timeSet[f.t] = true; }
  times = Object.keys(timeSet);
  for (var p = 0; p < W.length; p++) {
    times.forEach(function (t) {
      add(p, { k: "at", p: p, place: ctx.placeOf(p, t), t: t });
      frame.rooms.forEach(function (r) {
        if (r.id !== ctx.placeOf(p, t)) add(p, { k: "at", p: p, place: r.id, t: t });
      });
      for (var q = 0; q < W.length; q++) if (q !== p) add(p, { k: "saw", p: p, q: q, t: t });
      frame.sounds.forEach(function (s) {
        times.forEach(function (t2) { if (t2 === t) add(p, { k: "heard", p: p, s: s.id, t: t }); });
      });
    });
    frame.objects.forEach(function (o) {
      Object.keys(o.states).forEach(function (v) { add(p, { k: "state", o: o.id, v: v }); });
    });
    for (var q2 = 0; q2 < W.length; q2++) {
      frame.actions.forEach(function (a) {
        var prop = { k: "did", p: q2, a: a };
        var hasFact = !!ctx.fb[propKey(prop)];
        var blocked = false;
        for (var k3 in ctx.fb) {
          var f3 = ctx.fb[k3];
          if (f3.k === "attr" && f3.p === q2 && ATTRS[f3.a].blocks.indexOf(a) !== -1) blocked = true;
        }
        if (hasFact || blocked) add(p, prop);
      });
    }
  }
  return claims;
}

/* ---------------- case assembly ---------------- */

var TIER_FAMILIES = {
  easy: ["temporal", "object"],
  medium: ["spatial", "sensory", "temporal", "object"],
  hard: ["spatial", "sensory", "temporal", "object", "identity"]
};

function tryGenerateCase(rng, opts) {
  var frame = opts.frame, tier = opts.tier, things = opts.things || 1;
  var finale = !!opts.finale, journal = opts.journal || [];
  var times = finale ? frame.times.slice(0, 2) : (tier === "easy" ? frame.times.slice(0, 2) : frame.times.slice());
  var claimsPer = tier === "easy" ? 3 : 4;

  var names = rng.sample(NAMES, 4);
  var roles = rng.sample(frame.roles, 4);
  var W = names.map(function (n, i) { return { name: n, role: roles[i] }; });

  var facts = [];
  var wi, ti;
  for (wi = 0; wi < 4; wi++) times.forEach(function (t) {
    facts.push({ k: "at", p: wi, place: rng.pick(frame.rooms).id, t: t });
  });
  var nSounds = tier === "easy" ? 1 : 2;
  rng.sample(frame.sounds, Math.min(nSounds, frame.sounds.length)).forEach(function (s) {
    facts.push({ k: "event", s: s.id, t: rng.pick(times) });
  });
  frame.objects.forEach(function (o) {
    facts.push({ k: "state", o: o.id, v: rng.pick(Object.keys(o.states)) });
  });
  var attrWitness = -1;
  if (tier === "hard" || (finale && opts.hard)) {
    attrWitness = rng.int(4);
    facts.push({ k: "attr", p: attrWitness, a: rng.pick(Object.keys(ATTRS)) });
  }
  if (rng.chance(0.5)) {
    var d = rng.int(4), act = rng.pick(frame.actions);
    var blockedAlready = facts.some(function (f) {
      return f.k === "attr" && f.p === d && ATTRS[f.a].blocks.indexOf(act) !== -1;
    });
    if (!blockedAlready) facts.push({ k: "did", p: d, a: act });
  }
  var dark = null;
  var ctx = buildCtx(frame, facts, null, journal);
  if (!finale && tier !== "easy" && (tier === "hard" || rng.chance(0.5))) {
    /* A dark room only enters the file if somebody actually stood in
       it that night — otherwise the case speaks of a room the player
       can never place, which reads as a hole in the file. */
    var occupied = {};
    W.forEach(function (w, wi2) { times.forEach(function (t) { occupied[ctx.placeOf(wi2, t)] = true; }); });
    var darkPool = frame.darkCandidates.filter(function (r) { return occupied[r]; });
    if (darkPool.length) { dark = rng.pick(darkPool); ctx.dark = dark; }
  }
  var claims = enumerateClaims(ctx, W);

  /* The finale's thing defies a journal tell. Hard-mode finales and
     regular cases draw false statements from the enumeration. */
  var culprits = [];
  var usedFalse = {}; // propKey+speaker already assigned as a false claim
  var usedFamilies = {};
  function falsePoolFor(speaker, families) {
    return claims.filter(function (c) {
      return c.speaker === speaker && !c.truth && families.indexOf(c.family) !== -1 &&
        !usedFalse[propKey(c.prop) + "@" + speaker];
    });
  }

  var candidates = rng.shuffle([0, 1, 2, 3]);
  var need = things;
  if (finale) need = things; // one of them will be the tell-defier
  for (var ci = 0; ci < candidates.length && culprits.length < need; ci++) {
    var cand = candidates[ci];
    var fc = null;
    if (finale && culprits.length === 0) {
      var tellId = rng.pick(journal);
      var tell = null;
      TELLS.forEach(function (t) { if (t.id === tellId) tell = t; });
      fc = { speaker: cand, prop: { k: "defies", tell: tellId, _speaker: cand },
        truth: false, family: "tell", needs: ["tell|" + tellId], _tell: tell };
    } else {
      var tryOrder = [];
      (opts.preferFamilies || []).forEach(function (f) { if (tryOrder.indexOf(f) === -1) tryOrder.push(f); });
      rng.shuffle(TIER_FAMILIES[tier] || TIER_FAMILIES.medium).forEach(function (f) {
        if (tryOrder.indexOf(f) === -1) tryOrder.push(f);
      });
      for (var fi = 0; fi < tryOrder.length && !fc; fi++) {
        if (usedFamilies[tryOrder[fi]]) continue;
        var pool = falsePoolFor(cand, [tryOrder[fi]]);
        if (pool.length) fc = rng.pick(pool);
      }
      if (!fc) { // a repeated family beats no case at all
        for (var fj = 0; fj < tryOrder.length && !fc; fj++) {
          var pool2 = falsePoolFor(cand, [tryOrder[fj]]);
          if (pool2.length) fc = rng.pick(pool2);
        }
      }
      if (fc) usedFamilies[fc.family] = true;
    }
    if (fc) { culprits.push({ witness: cand, claim: fc }); usedFalse[propKey(fc.prop) + "@" + cand] = true; }
  }
  if (culprits.length < need) return null;

  /* Compose testimonies. */
  var usedProps = {};
  var stateUse = {}; // a scene-fact statement may be repeated by at most two witnesses
  function takeTrue(speaker, count, excludeProp) {
    var pool = claims.filter(function (c) {
      if (c.speaker !== speaker || !c.truth || c.prop === excludeProp) return false;
      /* The culprit must never also state the true value of the very
         thing their false statement is about — one witness swearing
         both ways about the same object reads as a broken file. */
      if (excludeProp && excludeProp.k === "state" && c.prop.k === "state" && c.prop.o === excludeProp.o) return false;
      return true;
    });
    pool = rng.shuffle(pool);
    var taken = [], kindsSeen = {};
    function tryTake(c, allowDupKind) {
      var key = propKey(c.prop) + "@" + c.speaker;
      if (usedProps[key]) return false;
      if (c.prop.k === "state" && (stateUse[propKey(c.prop)] || 0) >= 2) return false;
      if (c.prop.k !== "state" && c.prop.k !== "at" && usedProps["shared|" + propKey(c.prop)]) return false;
      if (!allowDupKind && kindsSeen[c.prop.k]) return false;
      taken.push(c); kindsSeen[c.prop.k] = true;
      usedProps[key] = true;
      if (c.prop.k === "state") stateUse[propKey(c.prop)] = (stateUse[propKey(c.prop)] || 0) + 1;
      if (c.prop.k !== "state" && c.prop.k !== "at") usedProps["shared|" + propKey(c.prop)] = true;
      return true;
    }
    pool.forEach(function (c) { if (taken.length < count) tryTake(c, false); });
    pool.forEach(function (c) { if (taken.length < count) tryTake(c, true); });
    return taken;
  }

  var testimonies = [];
  for (wi = 0; wi < 4; wi++) {
    var culpritEntry = null;
    culprits.forEach(function (c) { if (c.witness === wi) culpritEntry = c; });
    var mine;
    if (culpritEntry) {
      mine = takeTrue(wi, claimsPer - 1, culpritEntry.claim.prop);
      if (mine.length < claimsPer - 1) return null;
      mine.push(culpritEntry.claim);
    } else {
      mine = takeTrue(wi, claimsPer, null);
      if (mine.length < claimsPer) return null;
    }
    mine = rng.shuffle(mine);
    testimonies.push(mine);
  }

  /* Render statements. */
  var witnesses = W.map(function (w, i) {
    var lines = testimonies[i].map(function (c) {
      c.text = claimText(c.prop, ctx, W, rng);
      return c.text;
    });
    if (tier === "hard" || (tier === "medium" && rng.chance(0.5))) {
      lines.splice(rng.int(lines.length + 1), 0, rng.pick(FLAVOR));
    }
    return { name: w.name, role: w.role, statements: lines, claims: testimonies[i] };
  });

  var presented = {};
  var sections = buildSections(frame, ctx, W, facts, finale, journal, presented);

  var reveals = culprits.map(function (c) {
    return buildReveal(c, ctx, W, frame, rng);
  });

  var caseObj = {
    title: finale ? "The Last Case — What Follows the Log" : frame.title,
    frameId: frame.id, finale: finale, tier: tier,
    intro: finale ? FINALE_INTRO : ((opts.index > 7 && frame.intro2) ? frame.intro2 : frame.intro),
    sections: sections,
    witnesses: witnesses.map(function (w) {
      return { name: w.name, role: w.role, statements: w.statements };
    }),
    culprits: culprits.map(function (c) { return c.witness; }),
    culpritClaims: culprits.map(function (c) {
      return { witness: c.witness, family: c.claim.family, text: c.claim.text || claimText(c.claim.prop, ctx, W, rng) };
    }),
    reveals: reveals,
    journal: finale ? journal.slice() : null,
    banish: null,
    _ctx: { frameId: frame.id, facts: facts, dark: dark, journal: journal },
    _claims: witnesses.map(function (w) {
      return w.claims.map(function (c) {
        return { prop: stripProp(c.prop), truth: c.truth, needs: c.needs };
      });
    }),
    _presented: presented
  };
  if (finale) {
    var violated = null;
    culprits.forEach(function (c) { if (c.claim.family === "tell") violated = c.claim._tell; });
    var others = TELLS.filter(function (t) { return journal.indexOf(t.id) !== -1 && t.id !== violated.id; });
    var opts2 = rng.shuffle([violated].concat(others).map(function (t) { return { tell: t.id, text: t.banish }; }));
    caseObj.banish = { options: opts2, correctTell: violated.id };
  }
  return caseObj;
}

function stripProp(p) {
  var out = {};
  for (var k in p) if (k !== "_speaker") out[k] = p[k];
  return out;
}

/* ---------------- presentation ---------------- */

function namesList(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

function buildSections(frame, ctx, W, facts, finale, journal, presented) {
  var sections = [];
  var scene = [], sounds = [], moves = [];
  var occupied = {};
  facts.forEach(function (f) { if (f.k === "at") occupied[f.place] = true; });

  if (ctx.dark) {
    scene.push(cap(roomName(frame, ctx.dark)) + " has no lamp and no window of its own: after dark, nothing inside it can be made out.");
  } else {
    scene.push("Every room had a lamp burning that night.");
  }
  presented["light"] = true;

  var occupiedIds = Object.keys(occupied);
  occupiedIds.forEach(function (fromId) {
    var vis = frame.visible[fromId] || [];
    var visNames = vis.filter(function (r) { return occupied[r]; }).map(function (r) { return roomName(frame, r); });
    var notNames = occupiedIds.filter(function (r) { return vis.indexOf(r) === -1; })
      .map(function (r) { return roomName(frame, r); });
    var line = "From " + roomName(frame, fromId) + ", in view: " + namesList(visNames) + ".";
    if (notNames.length) line += " Not in view: " + namesList(notNames) + ".";
    scene.push(line);
    occupiedIds.forEach(function (toId) { presented["vis|" + fromId + ">" + toId] = true; });
  });

  facts.forEach(function (f) {
    if (f.k === "state") {
      var obj = null;
      frame.objects.forEach(function (o) { if (o.id === f.o) obj = o; });
      scene.push(obj.states[f.v].fact);
      presented["state|" + f.o] = true;
    }
    if (f.k === "attr") {
      scene.push(ATTRS[f.a].fact(W[f.p].name, hashStr(W[f.p].name + "|" + f.a) % 2));
      presented["attr|" + f.p] = true;
    }
    if (f.k === "did") {
      scene.push("Earlier in the night, " + W[f.p].name + " " + ACTIONS[f.a].past + " — it was seen, and noted.");
      presented["did|" + f.p + "|" + f.a] = true;
    }
  });
  sections.push({ title: "The scene", lines: scene });

  var eventSounds = {};
  facts.forEach(function (f) { if (f.k === "event") eventSounds[f.s] = true; });
  Object.keys(eventSounds).forEach(function (sid) {
    var s = soundOf(frame, sid);
    var reachNames = s.reach.filter(function (r) { return occupied[r]; }).map(function (r) { return roomName(frame, r); });
    if (!reachNames.length) reachNames = s.reach.map(function (r) { return roomName(frame, r); });
    var notNames = occupiedIds.filter(function (r) { return s.reach.indexOf(r) === -1; })
      .map(function (r) { return roomName(frame, r); });
    var line = cap(s.name) + " sounds from " + roomName(frame, s.place) + ". It carries to " + namesList(reachNames) + ".";
    if (notNames.length) line += " It does not reach " + namesList(notNames) + ".";
    sounds.push(line);
    occupiedIds.forEach(function (r) { presented["reach|" + sid + "@" + r] = true; });
  });
  facts.forEach(function (f) {
    if (f.k === "event") {
      sounds.push("At " + f.t + ", " + soundOf(frame, f.s).name + " sounded.");
      presented["event|" + f.s + "|" + f.t] = true;
    }
  });
  if (sounds.length) sections.push({ title: "Sounds of the night", lines: sounds });

  var timesSeen = [];
  facts.forEach(function (f) { if (f.k === "at" && timesSeen.indexOf(f.t) === -1) timesSeen.push(f.t); });
  timesSeen.forEach(function (t) {
    var parts = [];
    for (var p = 0; p < 4; p++) {
      parts.push(W[p].name + " — " + roomName(frame, ctx.placeOf(p, t)));
      presented["move|" + p + "|" + t] = true;
    }
    moves.push("At " + t + ": " + parts.join("; ") + ".");
  });
  sections.push({ title: "Where everyone was", lines: moves });

  if (finale) {
    var jlines = journal.map(function (tid) {
      var tell = null;
      TELLS.forEach(function (t) { if (t.id === tid) tell = t; });
      presented["tell|" + tid] = true;
      return "From your journal: " + tell.journal;
    });
    sections.push({ title: "Your journal", lines: jlines });
  }
  return sections;
}

/* ---------------- reveals ---------------- */

function buildReveal(entry, ctx, W, frame, rng) {
  var c = entry.claim, E = W[entry.witness], prop = c.prop;
  var pick = rng ? function (a) { return rng.pick(a); } : function (a) { return a[0]; };
  switch (c.family) {
    case "temporal":
      return E.name + " says they were " + placePhrase(frame, prop.place) + " at " + prop.t +
        ". The log is plain: at " + prop.t + ", " + E.name + " was " + placePhrase(frame, ctx.placeOf(entry.witness, prop.t)) +
        ". " + pick(["The thing had not learned where its own feet were meant to be.",
          "The shape was right. The hour was wrong.", "It wore the shape well enough. It had not learned where the shape had stood."]);
    case "spatial":
      return E.name + " swears they saw " + W[prop.q].name + " " + placePhrase(frame, ctx.placeOf(prop.q, prop.t)) +
        " from " + roomName(frame, ctx.placeOf(entry.witness, prop.t)) + ". But " + roomName(frame, ctx.placeOf(entry.witness, prop.t)) +
        " does not look upon " + roomName(frame, ctx.placeOf(prop.q, prop.t)) + ", and no eye standing there could have seen it. " +
        pick(["The thing described a view it had only heard described.", "It described the view the way a person repeats a story."]);
    case "sensory":
      if (prop.k === "heard") {
        return E.name + " claims to have heard " + soundOf(frame, prop.s).name + " from " +
          roomName(frame, ctx.placeOf(entry.witness, prop.t)) + ". That sound never reached that room that night. " +
          pick(["The thing heard it in somebody else's memory.", "It heard the sound the way people tell it afterwards, not the way the night gave it."]);
      }
      return E.name + " claims to have seen " + W[prop.q].name + " " + placePhrase(frame, ctx.placeOf(prop.q, prop.t)) +
        ". There is no light in that room after dark, and nothing in it can be made out. The thing saw with eyes that are not eyes.";
    case "identity": {
      var attrFact = "";
      for (var key in ctx.fb) {
        var f = ctx.fb[key];
        if (f.k === "attr" && f.p === prop.p) attrFact = ATTRS[f.a].fact(W[prop.p].name, hashStr(W[prop.p].name + "|" + f.a) % 2);
      }
      if (prop.p === entry.witness) {
        return E.name + " swears they " + ACTIONS[prop.a].past + " themselves. " + attrFact +
          " The thing did not know the body it was wearing.";
      }
      return E.name + " saw " + W[prop.p].name + " " + ACTIONS[prop.a].gerund + ", they say. " + attrFact +
        " The thing did not know the people it walked among.";
    }
    case "object": {
      var obj = null, actual = "";
      frame.objects.forEach(function (o) { if (o.id === prop.o) obj = o; });
      for (var k2 in ctx.fb) { var f2 = ctx.fb[k2]; if (f2.k === "state" && f2.o === prop.o) actual = obj.states[f2.v].fact; }
      return E.name + " tells you " + obj.states[prop.v].claim + ". " + actual + " " +
        pick(["The thing remembered the room as it stood in some older year.",
          "The thing described the room as it was on some other night, not this one."]);
    }
    case "tell":
      return c._tell.reveal + " The journal had it written first: " + c._tell.journal;
  }
  return "The log speaks for itself.";
}

/* ---------------- the verifier ---------------- */

function verifyCase(caseObj) {
  var errors = [];
  var frame = null;
  FRAMES.forEach(function (f) { if (f.id === caseObj._ctx.frameId) frame = f; });
  if (!frame) return { ok: false, errors: ["unknown frame"] };
  var ctx = buildCtx(frame, caseObj._ctx.facts, caseObj._ctx.dark, caseObj._ctx.journal);
  var falseWitnesses = {};
  caseObj._claims.forEach(function (claims, wi) {
    var falseCount = 0;
    /* One witness must never state two different values for the same
       scene object — the file itself only ever holds one. */
    var stateByObj = {};
    claims.forEach(function (c) {
      if (c.prop.k !== "state") return;
      if (stateByObj[c.prop.o] !== undefined && stateByObj[c.prop.o] !== c.prop.v)
        errors.push("w" + wi + ": states two values for " + c.prop.o);
      stateByObj[c.prop.o] = c.prop.v;
    });
    claims.forEach(function (c) {
      var recomputed = evaluate(c.prop, ctx);
      if (recomputed !== c.truth) errors.push("w" + wi + ": truth mismatch on " + propKey(c.prop));
      if (!c.truth) {
        falseCount++;
        c.needs.forEach(function (n) {
          if (!caseObj._presented[n]) errors.push("w" + wi + ": premise not presented: " + n);
        });
      } else {
        c.needs.forEach(function (n) {
          if (!caseObj._presented[n]) errors.push("w" + wi + ": true-claim premise not presented: " + n);
        });
      }
    });
    if (falseCount > 1) errors.push("w" + wi + ": more than one false statement");
    if (falseCount === 1) falseWitnesses[wi] = true;
  });
  var expected = {};
  caseObj.culprits.forEach(function (w) { expected[w] = true; });
  var gotKeys = Object.keys(falseWitnesses).sort().join(",");
  var expKeys = Object.keys(expected).sort().join(",");
  if (gotKeys !== expKeys) errors.push("false witnesses " + gotKeys + " != culprits " + expKeys);
  caseObj.witnesses.forEach(function (w, wi) {
    if (!w.statements || w.statements.length < 2) errors.push("w" + wi + ": too few statements");
  });
  if (caseObj.finale) {
    var tellCulprits = caseObj.culpritClaims.filter(function (c) { return c.family === "tell"; });
    if (tellCulprits.length !== 1) errors.push("finale: expected exactly one tell-defying culprit");
    if (!caseObj.banish || !caseObj.banish.options.length) errors.push("finale: banish missing");
  }
  return { ok: errors.length === 0, errors: errors };
}

/* ---------------- shifts ---------------- */

function tierForIndex(i) { return i <= 3 ? "easy" : (i <= 8 ? "medium" : "hard"); }

function generateShift(seedStr, mode) {
  var hard = mode === "hard";
  var tellsRng = new RNG(hashStr("nightlog:" + seedStr + ":tells"));
  var tells = tellsRng.sample(TELLS, 3).map(function (t) { return t.id; });
  var frameRng = new RNG(hashStr("nightlog:" + seedStr + ":frames"));
  var frameOrder = frameRng.shuffle(FRAMES.slice());
  var cases = [];
  var prevFamily = null;
  for (var i = 1; i <= 12; i++) {
    var frame = frameOrder[(i - 1) % frameOrder.length];
    var tier = tierForIndex(i);
    /* Family variety across the shift: the gentle cases rotate the two
       easy families, case 4 opens the spatial/sensory set, and later
       cases prefer any family but the previous case's. */
    var prefer = null;
    if (tier === "easy") {
      var rem = ["temporal", "object"].filter(function (f) { return f !== prevFamily; });
      prefer = rem.length ? [rem[0]] : null;
    } else if (i === 4) {
      prefer = [frameRng.pick(["spatial", "sensory"])];
    } else if (prevFamily) {
      var tierFams = TIER_FAMILIES[tier].filter(function (f) { return f !== prevFamily; });
      prefer = [frameRng.pick(tierFams)];
    }
    var rng = new RNG(hashStr("nightlog:" + seedStr + ":case:" + i));
    var made = null;
    for (var attempt = 0; attempt < 80 && !made; attempt++) {
      var c = tryGenerateCase(rng, { frame: frame, tier: tier, things: hard ? 2 : 1, finale: false, journal: tells, preferFamilies: prefer, index: i });
      if (c && verifyCase(c).ok) made = c;
    }
    if (!made) throw new Error("could not generate case " + i + " for seed " + seedStr);
    prevFamily = made.culpritClaims[0].family;
    made.n = i;
    cases.push(made);
  }
  var church = null;
  FRAMES.forEach(function (f) { if (f.id === "church") church = f; });
  var frng = new RNG(hashStr("nightlog:" + seedStr + ":finale"));
  var finale = null;
  for (var a2 = 0; a2 < 80 && !finale; a2++) {
    var fc = tryGenerateCase(frng, { frame: church, tier: "hard", things: hard ? 2 : 1, finale: true, journal: tells, hard: hard });
    if (fc && verifyCase(fc).ok) finale = fc;
  }
  if (!finale) throw new Error("could not generate finale for seed " + seedStr);
  finale.n = 13;
  cases.push(finale);
  return { seed: seedStr, mode: mode, tells: tells, cases: cases };
}

function generateDailyCase(dateStr) {
  var rng = new RNG(hashStr("nightlog:daily:" + dateStr));
  var frame = rng.pick(FRAMES);
  for (var attempt = 0; attempt < 80; attempt++) {
    var c = tryGenerateCase(rng, { frame: frame, tier: "medium", things: 1, finale: false, journal: [] });
    if (c && verifyCase(c).ok) { c.n = 0; c.daily = true; return c; }
  }
  throw new Error("could not generate daily case for " + dateStr);
}

function verifyShift(shift) {
  var errors = [];
  if (shift.cases.length !== 13) errors.push("shift has " + shift.cases.length + " cases, expected 13");
  if (shift.tells.length !== 3) errors.push("shift has " + shift.tells.length + " tells, expected 3");
  shift.cases.forEach(function (c, i) {
    var v = verifyCase(c);
    if (!v.ok) errors.push("case " + (i + 1) + ": " + v.errors.join("; "));
  });
  return { ok: errors.length === 0, errors: errors };
}

var API = {
  RNG: RNG, hashStr: hashStr, FRAMES: FRAMES, TELLS: TELLS,
  generateShift: generateShift, generateDailyCase: generateDailyCase,
  verifyCase: verifyCase, verifyShift: verifyShift,
  tierForIndex: tierForIndex,
  _debug: { buildCtx: buildCtx, enumerateClaims: enumerateClaims, evaluate: evaluate, tryGenerateCase: tryGenerateCase }
};
if (typeof module !== "undefined" && module.exports) module.exports = API;
global.NightLogCore = API;
})(typeof window !== "undefined" ? window : globalThis);
