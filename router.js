/* Wrenworks Arcade — SPA router (FD-045).
   One document, four views. Internal route links are intercepted
   and the view is swapped in place via the History API; a direct
   load at any route renders that view. The game mounts once
   (starfall.js owns #game) and this file only MOVES that node
   between the home and play hosts — it is never rebuilt, so a run,
   the attract loop and the audio all survive navigation. Switching
   to a view where the game is hidden asks the game to pause a live
   run first, through the game's own pause path
   (window.__starfall.pause). */
(function () {
  "use strict";

  var ROUTES = {
    "/": { view: "home", title: "The Wrenworks Arcade — a new game every Friday", nav: "home" },
    "/play/starfall-post/": { view: "play", title: "Starfall Post — play · Wrenworks Arcade", nav: null },
    "/leaderboard/": { view: "leaderboard", title: "Leaderboard — Starfall Post · Wrenworks Arcade", nav: "leaderboard" },
    "/vault/": { view: "vault", title: "The Vault — The Wrenworks Arcade", nav: "vault" }
  };
  var current = null; /* canonical path of the visible view */

  /* The canonical route path for a URL path, or null when the path
     is not one of the four routes (asset, external, anything else —
     those keep the browser's default behaviour). */
  function alias(pathname) {
    var p = pathname || "/";
    if (p === "/index.html") p = "/";
    if (p === "/play/starfall-post" || p === "/leaderboard" || p === "/vault") p += "/";
    return Object.prototype.hasOwnProperty.call(ROUTES, p) ? p : null;
  }

  /* The leaderboard table, rendered each time the view is entered
     (this was the leaderboard page's own script; the markup and
     strings are unchanged). */
  function renderLeaderboard() {
    var slug = "starfall-post";
    var MEDAL_POINTS = { none: 0, bronze: 10, silver: 20, gold: 30, wren: 50 };
    var mount = document.getElementById("champ-table");
    var g = ArcadeAPI.getPassport().games[slug];
    if (!g || !g.plays) {
      mount.innerHTML = '<p class="muted">No points yet. Finish a run to take the first line.</p>';
      return;
    }
    var points = (MEDAL_POINTS[g.bestRunMedal || "none"] || 0) + (g.bestRunDeliveries || 0);
    var name = String(ArcadeAPI.getName() || "A player").replace(/</g, "&lt;");
    mount.innerHTML = '<table class="board"><tr><th>Player</th><th class="num">Points</th>' +
      '<th>Best-run medal</th><th class="num">Best-run deliveries</th><th class="num">Best score</th></tr>' +
      "<tr><td>" + name + '</td><td class="num">' + points + '</td><td>' +
      ArcadeAPI.MEDAL_LABEL[g.bestRunMedal || "none"] + '</td><td class="num">' + (g.bestRunDeliveries || 0) +
      '</td><td class="num">' + g.bestScore +
      "</td></tr></table>";
  }

  function show(path, opts) {
    opts = opts || {};
    var route = ROUTES[path];
    var view = route.view;
    var game = document.getElementById("game");
    if (view === "home") {
      document.getElementById("game-host-home").appendChild(game);
    } else if (view === "play") {
      document.getElementById("game-host-play").appendChild(game);
    } else if (window.__starfall && window.__starfall.pause) {
      /* the game is about to be hidden mid-run: pause it through
         its own pause path, so coming back offers the resume */
      window.__starfall.pause();
    }
    var sections = document.querySelectorAll("[data-view]");
    for (var i = 0; i < sections.length; i++)
      sections[i].hidden = sections[i].getAttribute("data-view") !== view;
    var footers = document.querySelectorAll("[data-footer]");
    for (var j = 0; j < footers.length; j++)
      footers[j].hidden = (footers[j].getAttribute("data-footer") === "play") !== (view === "play");
    var links = document.querySelectorAll("header.site nav a[data-route]");
    for (var k = 0; k < links.length; k++)
      links[k].classList.toggle("here", links[k].getAttribute("data-route") === route.nav);
    document.title = route.title;
    if (view === "leaderboard") renderLeaderboard();
    current = path;
    if (opts.push) history.pushState({ path: path }, "", path);
    if (opts.scroll !== false) window.scrollTo(0, 0);
  }

  document.addEventListener("click", function (e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var url;
    try { url = new URL(a.getAttribute("href"), location.href); } catch (err) { return; }
    if (url.origin !== location.origin) return;
    var path = alias(url.pathname);
    if (!path) return; /* not a route: default behaviour */
    e.preventDefault();
    if (path === current) { window.scrollTo(0, 0); return; }
    show(path, { push: true });
  });

  window.addEventListener("popstate", function () {
    var path = alias(location.pathname) || "/";
    if (path !== current) show(path, { push: false });
  });

  /* Direct landing: render the view the URL asks for, and tidy
     alias URLs (/leaderboard, /index.html) to the canonical path. */
  var start = alias(location.pathname) || "/";
  show(start, { push: false, scroll: false });
  if (location.pathname !== start) history.replaceState({ path: start }, "", start);
})();
