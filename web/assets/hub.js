/* GuideGen — the hub at /h/{uid}: everything one person has published, in one link.
 *
 * This is the "internal wiki" job, done the way the rest of GuideGen is done. A hosted
 * knowledge base with a custom domain, seats and SSO is a different product and a
 * different business; what people actually need from one is a single address that
 * holds every guide, so nobody has to keep a list of links in a pinned message.
 *
 * **It hosts nothing new.** Every guide on this page is one the owner already pressed
 * Publish on, and the page is a query over exactly those. Nothing private can appear
 * here, because the query Firestore accepts is the one filtered to `visibility:link` —
 * see listPublicGuides in gg.js.
 *
 * Search is client-side over the titles and the app names already in hand. There is no
 * search index, no server and nothing typed here leaves the page.
 */
(function () {
  var main = document.getElementById("main");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function ownerId() {
    var m = location.pathname.match(/\/h\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
    return new URLSearchParams(location.search).get("u") || "";
  }

  function fmtDate(v) {
    try {
      var d = new Date(v);
      if (isNaN(d)) return "";
      return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    } catch (e) { return ""; }
  }

  function initials(name) {
    var p = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!p.length) return "?";
    return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
  }

  function state(title, body) {
    main.className = "wrap narrow";
    main.innerHTML =
      '<div class="state"><h1>' + esc(title) + "</h1><p>" + esc(body) + "</p>" +
      '<a class="btn" href="/">Go to GuideGen</a></div>';
  }

  var guides = [];
  var owner = "";

  function cardsHtml(list) {
    if (!list.length) {
      return '<p class="hub-empty">Nothing matches that.</p>';
    }
    return list.map(function (g) {
      var n = (g.steps && g.steps.length) || g.stepCount || 0;
      var meta = [];
      if (n) meta.push(n + (n === 1 ? " step" : " steps"));
      if (g.app) meta.push(esc(String(g.app).slice(0, 40)));
      if (g.createdAt) meta.push(esc(fmtDate(g.createdAt)));
      return (
        '<a class="hub-card" href="/g/' + esc(g.id) + '">' +
        "<h3>" + esc(g.title || "Untitled guide") + "</h3>" +
        (g.description
          ? '<p class="hub-desc">' + esc(String(g.description).slice(0, 150)) + "</p>"
          : "") +
        '<span class="hub-meta">' + meta.join(" · ") + "</span></a>"
      );
    }).join("");
  }

  function render() {
    main.className = "wrap hub";
    main.innerHTML =
      '<div class="hub-head">' +
      '<span class="hub-av">' + esc(initials(owner)) + "</span>" +
      "<div><h1>" + esc(owner || "Published guides") + "</h1>" +
      '<p class="hub-sub">' + guides.length +
      (guides.length === 1 ? " published guide" : " published guides") +
      " · made with GuideGen</p></div></div>" +
      '<div class="hub-search"><input id="hub-q" type="search" autocomplete="off" ' +
      'placeholder="Search these guides" aria-label="Search these guides" /></div>' +
      '<div class="hub-grid" id="hub-grid">' + cardsHtml(guides) + "</div>" +
      '<div class="viewer-foot"><span>Every guide here was published deliberately by its ' +
      'author. <b>GuideGen</b> records a workflow once and writes it up — ' +
      '<a href="https://www.backpocket.website" target="_blank" rel="noopener">a ' +
      "backpocket.website tool</a>.</span><span class=\"spacer\"></span>" +
      '<a class="btn brand-btn" style="padding:8px 13px;font-size:13.5px" href="/install">' +
      "Get it free</a></div>";

    var q = document.getElementById("hub-q");
    var grid = document.getElementById("hub-grid");
    q.addEventListener("input", function () {
      var t = q.value.trim().toLowerCase();
      if (!t) return (grid.innerHTML = cardsHtml(guides));
      grid.innerHTML = cardsHtml(
        guides.filter(function (g) {
          return (
            String(g.title || "").toLowerCase().indexOf(t) !== -1 ||
            String(g.app || "").toLowerCase().indexOf(t) !== -1 ||
            String(g.description || "").toLowerCase().indexOf(t) !== -1
          );
        })
      );
    });
  }

  var uid = ownerId();
  if (!uid) {
    return state("No hub specified", "This link doesn't point at anyone's guides.");
  }

  GG.listPublicGuides(uid)
    .then(function (list) {
      guides = list || [];
      if (!guides.length) {
        return state(
          "Nothing published yet",
          "This person hasn't published any guides, or has since unpublished them."
        );
      }
      // Taken from the guides rather than a profile document: the name is already on
      // every published guide, and a second collection to read would be a second set
      // of rules to get wrong.
      owner = (guides.find(function (g) { return g.ownerName; }) || {}).ownerName || "";
      document.title = (owner ? owner + "'s guides" : "Published guides") + " — GuideGen";
      render();
    })
    .catch(function () {
      state("Couldn't load these guides", "Something went wrong fetching them. Refresh to try again.");
    });
})();
