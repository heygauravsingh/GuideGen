/* GuideGen — the dashboard: guide library + guide editor.
 *
 * This is the *only* editor. The extension records and, for narrated video,
 * renders; everything else — editing, redaction, reordering, all five exports,
 * publishing — happens on this page, on the user's own device.
 *
 * Two kinds of guide live side by side here, and the difference is not cosmetic:
 *
 *   local   Recorded on this machine and still only on this machine, read over
 *           the extension bridge. Fully editable: annotations are re-rendered
 *           from the original screenshot every time, so the ring, the badge and
 *           the redactions can all still change.
 *
 *   shared  Published to the account. Its images were rendered with annotations
 *           baked in at publish time, which is what makes the public viewer a
 *           plain <img> and stops a shared page ever drifting from what was
 *           approved. The cost is that on a shared-only guide you can edit the
 *           title and the words, not the pictures — to change a picture you
 *           re-publish from the machine that holds the original.
 *
 * A guide that is both (local, with a remoteId) gets the best of both: edit
 * anything, then Update to push it to the same link.
 */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var R = window.FSRender;
  var X = window.FSExport;

  var lib = { local: [], remote: [], buf: [], extVersion: null, extError: null };
  var cur = null;   // { kind, id, guide, steps }
  var mode = "signin";
  var saveTimers = {};
  // Which steps are in redaction mode, by step id. Held outside the DOM because a
  // committed redaction used to re-render the whole editor and drop the mode, so
  // hiding three fields on one screenshot meant pressing Redact three times.
  var redacting = {};

  // ---------------------------------------------------------------- utilities

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(v) {
    if (!v) return "";
    try {
      var d = new Date(v);
      var days = Math.floor((Date.now() - d.getTime()) / 86400000);
      if (days === 0) return "Today";
      if (days === 1) return "Yesterday";
      if (days < 7) return days + " days ago";
      return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    } catch (e) { return ""; }
  }

  function shortUrl(u) {
    try { var x = new URL(u); return x.hostname + x.pathname; } catch (e) { return u || ""; }
  }

  function mk(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function svg(path, size) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
      (size ? ' style="width:' + size + "px;height:" + size + 'px"' : "") + ">" + path + "</svg>";
  }

  var ICON = {
    grip: '<path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"/>',
    up: '<path d="M12 19V5m0 0-6 6m6-6 6 6"/>',
    down: '<path d="M12 5v14m0 0 6-6m-6 6-6-6"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    /* The blur tool, drawn the way every image editor draws it: a droplet. "Redact"
       is a legal-department word — half the people who need this button read it as
       something to do with paperwork, or don't read it at all. The droplet plus
       "Blur sensitive information" says what pressing it does. */
    redact: '<path d="M12 3.2c3.2 3.4 5.4 6.2 5.4 9a5.4 5.4 0 0 1-10.8 0c0-2.8 2.2-5.6 5.4-9z"/><path d="M9.6 12.6h.01M12 14.6h.01M14.4 12.2h.01M11 10.6h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    image: '<rect x="3" y="4" width="18" height="15" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M3 16l4-3 3 2 4-4 7 5"/>',
    check: '<path d="m5 13 4 4L19 7"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
    // Up-and-down arrows: a request went out and something came back.
    net: '<path d="M7 4v13m0 0-3-3m3 3 3-3M17 20V7m0 0-3 3m3-3 3 3"/>',
    warn: '<path d="M12 9v4m0 3h.01"/><path d="M10.3 4.3 2.6 17.5A1.9 1.9 0 0 0 4.3 20.5h15.4a1.9 1.9 0 0 0 1.7-3L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z"/>',
  };

  function iconBtn(icon, title, fn, disabled) {
    var b = mk("button", "btn icon sm");
    b.innerHTML = svg(icon);
    b.title = title;
    b.setAttribute("aria-label", title);
    if (disabled) b.setAttribute("disabled", "");
    if (fn) b.addEventListener("click", fn);
    return b;
  }

  function textBtn(label, icon) {
    var b = mk("button", "btn sm");
    b.innerHTML = (icon ? svg(icon) : "") + label;
    return b;
  }
  /* An icon that grows into its label on hover or focus. The label is always in the
     DOM — it is the accessible name and the tooltip — so this is a visual affordance
     and never the only way to know what the button is. Coarse pointers get it
     expanded from the start, since there is no hover to reveal it with. */
  function expandBtn(icon, label) {
    var b = mk("button", "btn sm exp");
    b.innerHTML = svg(icon) + '<span class="lbl"></span>';
    b.querySelector(".lbl").textContent = label;
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  }

  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  var toastTimer = null;
  function toast(msg) {
    var t = el("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  function say(id, text, kind) {
    var m = el(id);
    if (!m) return;
    m.textContent = text || "";
    m.className = "msg" + (kind ? " " + kind : "");
  }

  // jsPDF and PptxGenJS are 840KB between them and most sessions never export a
  // document. Fetch them the first time they're actually needed.
  var loading = {};
  function loadLib(src, present) {
    if (present()) return Promise.resolve();
    if (loading[src]) return loading[src];
    loading[src] = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        loading[src] = null;
        reject(new Error("Couldn't load the exporter library."));
      };
      document.head.appendChild(s);
    });
    return loading[src];
  }

  // ---------------------------------------------------------------- modals

  // Whatever the user was on when the dialog opened, so closing puts them back
  // there instead of at the top of the document.
  var modalReturn = null;
  var FOCUSABLE = 'button:not([disabled]), a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

  function openModal() {
    modalReturn = document.activeElement;
    var m = el("modal");
    m.setAttribute("role", "dialog");
    m.setAttribute("aria-modal", "true");
    document.body.classList.add("modal-open");
    el("overlay").classList.add("open");
  }

  function closeModal() {
    var o = el("overlay");
    o.classList.remove("open");
    o.dataset.busy = "0";
    document.body.classList.remove("modal-open");
    // Every dialog shares one element, so any per-dialog width has to be dropped
    // here rather than by whoever set it — Escape and the overlay click never run
    // the dialog's own close handler.
    el("modal").classList.remove("wide");
    el("modal").innerHTML = "";
    if (modalReturn && document.contains(modalReturn)) {
      try { modalReturn.focus(); } catch (e) { /* gone from the DOM */ }
    }
    modalReturn = null;
  }
  el("overlay").addEventListener("click", function (e) {
    if (e.target === el("overlay") && el("overlay").dataset.busy !== "1") closeModal();
  });
  document.addEventListener("keydown", function (e) {
    var open = el("overlay").classList.contains("open");
    if (e.key === "Escape") {
      el("ed-export-menu").classList.remove("open");
      el("ed-export").setAttribute("aria-expanded", "false");
      if (open && el("overlay").dataset.busy !== "1") closeModal();
      return;
    }
    // Without this, Tab walks straight out of the dialog and into the page behind
    // it, which is still there and still clickable-looking.
    if (e.key !== "Tab" || !open) return;
    var items = [].slice.call(el("modal").querySelectorAll(FOCUSABLE));
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* opts.info renders a single neutral button: several call sites here are telling
     the user something ("Video needs the original recording"), and an explanation
     that offers Cancel next to a red OK reads as a choice with consequences.
     Otherwise the confirm is destructive, and Cancel takes focus — the confirm
     button had it, so Enter or Space on a dialog the user had not finished reading
     went straight through to deleting the guide. */
  function confirmModal(title, body, confirmLabel, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var m = el("modal");
      m.innerHTML = "<h3></h3><p></p>" +
        '<div class="row">' +
        (opts.info ? "" : '<button class="btn" id="c-no">Cancel</button><span class="spacer"></span>') +
        '<button class="btn' + (opts.info ? " brand-btn" : " danger") + '" id="c-yes"></button></div>';
      m.querySelector("h3").textContent = title;
      m.querySelector("p").textContent = body;
      m.querySelector("#c-yes").textContent = confirmLabel || "Confirm";
      openModal();
      var done = function (v) { closeModal(); resolve(v); };
      if (!opts.info) m.querySelector("#c-no").onclick = function () { done(false); };
      m.querySelector("#c-yes").onclick = function () { done(true); };
      m.querySelector(opts.info ? "#c-yes" : "#c-no").focus();
    });
  }

  function infoModal(title, body, label) {
    return confirmModal(title, body, label || "OK", { info: true });
  }

  // ---------------------------------------------------------------- auth view

  function applyMode() {
    var up = mode === "signup";
    el("auth-title").textContent = up ? "Create an account" : "Sign in";
    el("auth-sub").textContent = up
      ? "An account lets you edit your guides here and share them as links."
      : "Sign in to edit and share your guides.";
    el("auth-submit").textContent = up ? "Create account" : "Sign in";
    el("alt-text").textContent = up ? "Already have an account?" : "New here?";
    el("alt-toggle").textContent = up ? "Sign in" : "Create an account";
    el("password").autocomplete = up ? "new-password" : "current-password";
    // Only asked when creating an account, and only for the password route —
    // Google hands the name over with the token, so asking again would be asking
    // for something we already have.
    el("name-field").hidden = !up;
    el("forgot-wrap").hidden = up;
    say("auth-msg", "");
  }

  // Hidden entirely until an OAuth client id is configured. A Google button that
  // always fails is worse than no Google button.
  (function wireGoogle() {
    var wrap = el("google-wrap");
    if (!wrap) return;
    if (!GG.googleReady()) { wrap.hidden = true; return; }
    wrap.hidden = false;
    el("google-btn").addEventListener("click", function () {
      say("auth-msg", "Taking you to Google…");
      GG.beginGoogle("/app" + location.hash).catch(function (e) {
        say("auth-msg", e.message, "err");
      });
    });
  })();

  el("alt-toggle").addEventListener("click", function () {
    mode = mode === "signup" ? "signin" : "signup";
    applyMode();
  });

  el("auth-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var email = el("email").value.trim();
    var pw = el("password").value;
    var name = el("full-name").value.trim();
    if (mode === "signup" && name.length < 2) return say("auth-msg", "Enter your full name.", "err");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return say("auth-msg", "Enter a valid email address.", "err");
    if (!pw) return say("auth-msg", "Enter your password.", "err");
    if (mode === "signup" && pw.length < 6) return say("auth-msg", "Password needs at least 6 characters.", "err");

    el("auth-submit").disabled = true;
    say("auth-msg", mode === "signup" ? "Creating your account…" : "Signing in…");
    (mode === "signup" ? GG.signUp(email, pw, name) : GG.signIn(email, pw))
      .catch(function (err) { say("auth-msg", err.message, "err"); })
      .then(function () { el("auth-submit").disabled = false; });
  });

  el("forgot").addEventListener("click", function () {
    var email = el("email").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return say("auth-msg", "Type your email above first, then click this again.", "err");
    }
    say("auth-msg", "Sending reset email…");
    GG.sendPasswordReset(email).then(function () {
      say("auth-msg", "Reset link sent to " + email + ". Check your inbox.", "ok");
    }).catch(function (err) { say("auth-msg", err.message, "err"); });
  });

  el("sign-out").addEventListener("click", function () { GG.signOut(); });

  // ---------------------------------------------------------------- library

  function loadLibrary() {
    var list = el("list");
    list.innerHTML = '<div class="skel"></div><div class="skel"></div>';
    say("dash-msg", "");

    var localP = GGBridge.available()
      ? GGBridge.ping()
          .then(function (v) { lib.extVersion = v; return GGBridge.guides(); })
          .catch(function (e) { lib.extError = e.message; return []; })
      : Promise.resolve((lib.extError = "The GuideGen extension isn't installed in this browser.", []));

    var remoteP = GG.listGuides().catch(function (e) {
      say("dash-msg", "Couldn't load your shared guides: " + e.message, "err");
      return [];
    });

    // Catch-up captures nobody has turned into a guide yet. Best-effort on
    // purpose: an extension too old to know this message answers with an error,
    // and a missing pending list must not take the whole library down with it.
    var bufP = GGBridge.available()
      ? GGBridge.bufSessions().catch(function () { return []; })
      : Promise.resolve([]);

    return Promise.all([localP, remoteP, bufP]).then(function (r) {
      lib.local = r[0] || [];
      lib.remote = r[1] || [];
      lib.buf = (r[2] || []).filter(function (s) { return !s.redeemedAt; });
      renderLibrary();
    });
  }

  function renderLibrary() {
    var note = el("ext-note");
    if (lib.extError) {
      note.hidden = false;
      note.innerHTML =
        "<b>Guides recorded on this device aren't listed.</b> " +
        escapeHtml(lib.extError) +
        "<br><br>Unpublished guides live in the extension's own storage, so this page has " +
        "to reach the extension to show them. Guides you've already shared are listed " +
        "below and work from any browser.";
    } else {
      note.hidden = true;
    }

    // A local guide that has been published appears once, as the local one — that
    // copy can still edit its images, so it's strictly the more capable of the two.
    var claimed = {};
    lib.local.forEach(function (g) { if (g.remoteId) claimed[g.remoteId] = true; });
    var remoteOnly = lib.remote.filter(function (g) { return !claimed[g.id]; });

    var rows = lib.local.map(function (g) {
      var pub = g.remoteId ? lib.remote.filter(function (r) { return r.id === g.remoteId; })[0] : null;
      return {
        kind: "local", id: g.id, title: g.title, stepCount: g.stepCount,
        createdAt: g.createdAt, startUrl: g.startUrl,
        remoteId: g.remoteId || null,
        live: !!(pub && pub.visibility === "link"),
        shared: !!g.remoteId,
      };
    }).concat(remoteOnly.map(function (g) {
      return {
        kind: "remote", id: g.id, title: g.title, stepCount: g.stepCount,
        createdAt: g.createdAt, remoteId: g.id,
        live: g.visibility === "link", shared: true,
      };
    }));

    var list = el("list");
    list.innerHTML = "";
    var pending = lib.buf || [];
    if (!rows.length && !pending.length) {
      list.innerHTML = blankState();
      el("dash-sub").textContent = "Nothing here yet.";
      return;
    }
    // Pending captures sit above the guides, and they are the only rows with an
    // expiry — so the thing that will disappear on its own is the thing you see
    // first. They are not guides yet and are counted separately for that reason.
    pending.forEach(function (s) { list.appendChild(pendingRow(s)); });
    rows.forEach(function (r) { list.appendChild(libRow(r)); });
    el("dash-sub").textContent =
      (rows.length === 1 ? "1 guide" : rows.length + " guides") +
      (pending.length
        ? " · " + pending.length + " catch-up capture" + (pending.length === 1 ? "" : "s")
        : "");
  }

  // "in 6 days" / "in 4 hours" / "in 12 minutes". Rounded down, because a card
  // saying a day when there are hours left is the one direction that loses work.
  function untilText(ts) {
    var ms = ts - Date.now();
    if (ms <= 0) return "any moment";
    var mins = Math.floor(ms / 60000);
    if (mins < 60) return "in " + mins + " minute" + (mins === 1 ? "" : "s");
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return "in " + hrs + " hour" + (hrs === 1 ? "" : "s");
    var days = Math.floor(hrs / 24);
    return "in " + days + " day" + (days === 1 ? "" : "s");
  }

  /* A catch-up capture, listed beside real guides but never mistaken for one:
   * different badge, an expiry, and no Open — there is nothing to open until it
   * has been made into a guide. Both capture buttons do that; the difference is
   * only how much of the session they take. */
  function pendingRow(s) {
    var d = mk("div", "guide-row pending");
    d.innerHTML =
      '<div class="info"><div class="t"></div><div class="m"></div></div>' +
      '<span class="badge buf"><span class="dot"></span>Catch-up</span>' +
      '<div class="acts"></div>';
    d.querySelector(".t").textContent = s.host || "Catch-up capture";
    d.querySelector(".m").textContent =
      (s.stepCount || 0) + (s.stepCount === 1 ? " step · " : " steps · ") +
      fmtDate(s.endedAt) + " · deletes " + untilText(s.expiresAt);

    var acts = d.querySelector(".acts");
    var busy = false;
    function take(btn, minutes) {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      var was = btn.textContent;
      btn.textContent = "Working…";
      GGBridge.bufPromote(s.id, minutes)
        .then(function (guideId) {
          if (!guideId) throw new Error("That capture has expired.");
          location.hash = "#local-" + guideId;
          return loadLibrary();
        })
        .catch(function (e) {
          busy = false;
          btn.disabled = false;
          btn.textContent = was;
          say("dash-msg", e.message, "err");
        });
    }

    var mins = s.sliceMinutes || 2;
    var slice = textBtn("Capture last " + mins + " min");
    slice.classList.add("brand-btn");
    slice.disabled = !s.sliceCount;
    slice.addEventListener("click", function () { take(slice, mins); });
    acts.appendChild(slice);

    // Only worth offering when it would give you more than the slice does.
    if (s.stepCount > (s.sliceCount || 0)) {
      var all = textBtn("Capture all " + s.stepCount);
      all.addEventListener("click", function () { take(all, 0); });
      acts.appendChild(all);
    }

    var drop = textBtn("Discard");
    drop.addEventListener("click", function () {
      confirmModal(
        "Discard this capture?",
        // confirmModal sets this with textContent, so no escaping here.
        "The " + s.stepCount + " steps held for " + (s.host || "this site") +
          " are deleted now instead of when they expire. This can't be undone.",
        "Discard"
      ).then(function (yes) {
        if (!yes) return;
        GGBridge.bufDiscard(s.id)
          .then(loadLibrary)
          .catch(function (e) { say("dash-msg", e.message, "err"); });
      });
    });
    acts.appendChild(drop);
    return d;
  }

  function blankState() {
    return '<div class="blank">' +
      '<div class="ico">' + svg('<path d="M4 7h16M4 12h11M4 17h7"/>', 22) + "</div>" +
      "<h2>No guides yet</h2>" +
      "<p>Click the GuideGen icon in your toolbar and press <b>Start recording</b>. " +
      "When you stop, the guide opens here.</p>" +
      "</div>";
  }

  function libRow(r) {
    var d = mk("div", "guide-row");
    d.innerHTML =
      '<div class="info"><div class="t"></div><div class="m"></div></div>' +
      '<span class="badge' + (r.live ? " live" : "") + '"><span class="dot"></span>' +
      (r.live ? "Shared" : r.shared ? "Unlisted" : "This device") + "</span>" +
      '<div class="acts"></div>';
    d.querySelector(".t").textContent = r.title || "Untitled guide";
    d.querySelector(".m").textContent =
      (r.stepCount || 0) + (r.stepCount === 1 ? " step · " : " steps · ") + fmtDate(r.createdAt) +
      (r.kind === "remote" ? " · not on this device" : "");

    var acts = d.querySelector(".acts");
    var open = textBtn("Open");
    open.classList.add("brand-btn");
    open.addEventListener("click", function () {
      location.hash = (r.kind === "local" ? "#local-" : "#g-") + r.id;
    });
    acts.appendChild(open);

    if (r.live) {
      var copy = textBtn("Copy link");
      copy.addEventListener("click", function () {
        var url = location.origin + "/g/" + r.remoteId;
        (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
          .then(function () {
            var old = copy.textContent;
            copy.textContent = "Copied";
            setTimeout(function () { copy.textContent = old; }, 1400);
          })
          .catch(function () { window.prompt("Copy this link:", url); });
      });
      acts.appendChild(copy);
      var view = textBtn("View");
      view.addEventListener("click", function () { window.open("/g/" + r.remoteId, "_blank"); });
      acts.appendChild(view);
    }
    return d;
  }

  el("refresh").addEventListener("click", loadLibrary);

  // ---------------------------------------------------------------- editor

  function openLocal(id) {
    return GGBridge.guide(id).then(function (r) {
      cur = { kind: "local", id: id, guide: r.guide, steps: r.steps || [] };
    });
  }

  function openRemote(id) {
    return GG.getGuide(id).then(function (g) {
      cur = {
        kind: "remote", id: id, guide: g,
        steps: (g.steps || []).map(function (s, i) {
          return { seq: s.seq || i + 1, type: s.type || "click", text: s.text || "", imageUrl: s.imageUrl || null };
        }),
      };
    });
  }

  function renderEditor() {
    var g = cur.guide;
    var isLocal = cur.kind === "local";

    el("ed-title").value = g.title || "";
    el("ed-desc").value = g.description || "";
    // Grown here rather than in the input handler alone: a textarea reads
    // scrollHeight 0 until it is in the document, same trap as the step cards.
    autoGrow(el("ed-desc"));
    el("ed-share-label").textContent =
      (cur.kind === "remote" || g.remoteId) ? "Sharing" : "Share";

    var bits = [cur.steps.length + (cur.steps.length === 1 ? " step" : " steps"), fmtDate(g.createdAt)];
    if (isLocal && g.startUrl) bits.push(shortUrl(g.startUrl));
    if (!isLocal) bits.push("shared guide");
    el("ed-meta").textContent = bits.join(" · ");

    /* Adding a step of your own is local-only, so the + rows are only rendered for a
       local guide — a step added to an already-published one would need a re-publish
       to appear anywhere, and there is no picture for it on this machine to bake. */

    /* The API log button carries the failure count in its own label, because that
     * is the number someone opening a captured bug report is looking for and it
     * should not need a click to find. Hidden entirely when there is no log — an
     * always-present button that usually opens an empty dialog trains people to
     * ignore it. */
    var nLog = 0, nBad = 0;
    cur.steps.forEach(function (s) {
      var c = netCounts(s);
      nLog += c.reqs.length;
      nBad += c.bad.length;
    });
    el("ed-netlog").hidden = !nLog;
    el("ed-netlog").classList.toggle("has-bad", nBad > 0);
    el("ed-netlog-label").textContent = nBad ? "API log · " + nBad + " failed" : "API log";

    var banner = el("ed-banner");
    if (isLocal) {
      banner.hidden = true;
    } else {
      banner.hidden = false;
      banner.innerHTML =
        "<b>This guide isn't on this device.</b> You can change its title and step text, " +
        "and export it. The screenshots were rendered with their annotations baked in when " +
        "the guide was published, so redaction, reordering and the highlight can only be " +
        "changed from the machine that recorded it — then re-published.";
    }

    var wrap = el("ed-steps");
    wrap.innerHTML = "";
    if (!cur.steps.length) {
      wrap.innerHTML = '<div class="blank"><h2>This guide has no steps</h2>' +
        "<p>Record again, or add a step of your own to start writing it by hand.</p></div>";
      if (isLocal) wrap.appendChild(insertRow(0));
      return;
    }
    cur.steps.forEach(function (step, i) {
      // A + before every step and one after the last, so "add something here" is
      // answerable at the place you are looking rather than at the top of the page.
      if (isLocal) wrap.appendChild(insertRow(i));
      var card = isLocal ? localCard(step, i) : remoteCard(step, i);
      wrap.appendChild(card);
      // Size the textarea only once it is laid out in the document. Doing it while
      // the card is still detached reads scrollHeight 0 and collapses the text to
      // an invisible zero-height box.
      var ta = card.querySelector("textarea");
      if (ta) autoGrow(ta);
    });
    if (isLocal) wrap.appendChild(insertRow(cur.steps.length));
    if (isLocal) hydrateImages();
    renderActivity();
  }

  // Who exported this guide, and when. Only rendered for a published guide,
  // because there is nothing to export from otherwise. Readable only by the owner
  // — that's enforced by the rules, not here.
  function renderActivity() {
    var host = el("ed-activity");
    var remoteId = cur.kind === "remote" ? cur.id : cur.guide.remoteId;
    if (!remoteId) { host.hidden = true; host.innerHTML = ""; return; }

    host.hidden = false;
    host.innerHTML = '<h2>Export activity</h2><p class="act-empty">Loading…</p>';

    GG.listExports(remoteId).then(function (rows) {
      if (!rows.length) {
        host.innerHTML = '<h2>Export activity</h2>' +
          '<p class="act-empty">' + (cur.guide.allowExport
            ? "Nobody has exported this guide yet. You'll see an entry here when they do."
            : "Exports are switched off for this guide. Turn them on in Share if you want " +
              "readers to be able to download it.") + "</p>";
        return;
      }
      host.innerHTML = '<h2>Export activity</h2>' +
        '<p class="act-empty">' + rows.length +
        (rows.length === 1 ? " export" : " exports") + " so far.</p>" +
        '<div class="act-list">' + rows.map(function (r) {
          return '<div class="act-row"><span class="who"></span>' +
            '<span class="kind">' + escapeHtml(r.kind || "?") + "</span>" +
            '<span class="when">' + escapeHtml(fmtWhen(r.at)) + "</span></div>";
        }).join("") + "</div>";
      var whos = host.querySelectorAll(".act-row .who");
      rows.forEach(function (r, i) { whos[i].textContent = r.email || "(unknown)"; });
    }).catch(function (e) {
      // A 403 here almost certainly means the rules for the exports subcollection
      // haven't been published yet. Say so rather than showing a bare error.
      host.innerHTML = '<h2>Export activity</h2><p class="act-empty">' +
        escapeHtml(e.message) +
        " If this says the log isn't yours, the Firestore rules for export logging " +
        "may not be published yet.</p>";
    });
  }

  function fmtWhen(v) {
    if (!v) return "";
    try {
      var d = new Date(v);
      return d.toLocaleDateString([], { day: "numeric", month: "short" }) + ", " +
             d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  /* Step ids come from `uid()` and are safe today, but a selector built from stored data is a
     footgun waiting for the day that changes. */
  function cssEscape(v) {
    v = String(v);
    if (window.CSS && CSS.escape) return CSS.escape(v);
    return v.replace(/["\\]/g, "\\$&");
  }

  function stepShell(step, i) {
    var card = mk("div", "step" + (step.type === "note" ? " is-note" : ""));
    card.dataset.i = String(i);
    /* The id as well as the index, so `refreshStep` can find this card without counting
       children — see the comment there for what counting cost. */
    card.dataset.stepId = step.id;

    var gutter = mk("div", "gutter");
    var num = mk("div", "num");
    num.textContent = String(i + 1);
    gutter.appendChild(num);
    card.appendChild(gutter);

    var content = mk("div", "content");
    card.appendChild(content);

    if (step.type === "note") {
      var badge = mk("div", "note-badge");
      badge.textContent = "Note";
      content.appendChild(badge);
    }

    var ta = document.createElement("textarea");
    ta.value = step.text || "";
    ta.rows = 1;
    ta.spellcheck = true;
    ta.setAttribute("aria-label", "Step " + (i + 1) + " description");
    content.appendChild(ta);

    return { card: card, gutter: gutter, content: content, ta: ta };
  }

  /* ---------------------------------------------------------------- adding a step
   *
   * The old affordance was a "Note" button in the toolbar that appended an empty
   * text step to the end of the guide — so the two things anyone actually wants
   * ("put an explanation *here*" and "include this picture") both took several more
   * moves, and one of them wasn't possible at all.
   *
   * Now: a + between every pair of steps, and one dialog that takes a line of text
   * and, optionally, an image. With an image it is a step of your own alongside the
   * recorded ones. Without, the text becomes a section slide styled like the rest of
   * the guide — a divider in the deck, a tinted card in the document.
   */
  function insertRow(index) {
    var row = mk("div", "insert");
    var btn = mk("button", "ins-btn");
    btn.innerHTML = svg(ICON.plus) + '<span class="lbl">Add a step here</span>';
    btn.title = "Add a step here";
    btn.setAttribute("aria-label", "Add a step at position " + (index + 1));
    btn.addEventListener("click", function () { openStepDialog(index); });
    row.appendChild(btn);
    return row;
  }

  var MAX_NOTE_W = 1600;   // same cap as every exporter and the publish pipeline

  /* Read a picked file, downscale it and re-encode as WebP. Done here rather than in
     the worker for one reason: what crosses the bridge is a `sendMessage` payload, and
     a 12-megapixel phone photo as a PNG data URL is tens of megabytes. The worker
     validates and caps whatever arrives regardless — see `cleanImage()` — because this
     code runs on a web page and cannot be the safeguard. */
  function readImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return resolve(null);
      if (!/^image\//.test(file.type) || /svg/i.test(file.type)) {
        return reject(new Error("Pick a PNG, JPEG, WebP or GIF image."));
      }
      var fr = new FileReader();
      fr.onerror = function () { reject(new Error("That file couldn't be read.")); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("That file isn't an image we can read.")); };
        img.onload = function () {
          var scale = Math.min(1, MAX_NOTE_W / Math.max(1, img.naturalWidth));
          var c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.naturalWidth * scale));
          c.height = Math.max(1, Math.round(img.naturalHeight * scale));
          var cx = c.getContext("2d");
          cx.imageSmoothingQuality = "high";
          cx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL("image/webp", 0.9));
        };
        img.src = String(fr.result);
      };
      fr.readAsDataURL(file);
    });
  }

  /* One dialog for both jobs: inserting a step, and changing the picture on one that
     already exists. `step` null means insert at `index`. */
  function openStepDialog(index, step) {
    var editing = !!step;
    var picked = editing ? null : null;      // a new data URL, once one is chosen
    var dropped = false;                     // has the user touched the image field

    el("modal").innerHTML =
      "<h3>" + (editing ? "Edit this step" : "Add a step") + "</h3>" +
      '<p class="sub">Write the line you want the reader to see. Add a picture if you have ' +
      "one — without it, the text becomes a section slide in your exports.</p>" +
      '<div class="field"><label for="nt-text">Text</label>' +
      '<textarea id="nt-text" rows="3" maxlength="2000" placeholder="Before you start, make sure you have…"></textarea></div>' +
      '<div class="field"><label for="nt-file">Picture <span class="opt">optional</span></label>' +
      '<div class="drop" id="nt-drop" tabindex="0" role="button" aria-controls="nt-file">' +
      '<div class="drop-empty">' + svg(ICON.image) +
      "<span>Click to choose an image, or drop one here</span></div>" +
      '<img id="nt-prev" alt="" hidden />' +
      '<button class="btn sm" id="nt-clear" type="button" hidden>Remove picture</button>' +
      "</div>" +
      '<input type="file" id="nt-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden /></div>' +
      '<p class="msg" id="nt-msg" role="status" aria-live="polite"></p>' +
      '<div class="row"><span class="spacer"></span>' +
      '<button class="btn" id="nt-cancel">Cancel</button>' +
      '<button class="btn brand-btn" id="nt-ok">' + (editing ? "Save" : "Add step") + "</button></div>";
    openModal();

    var ta = el("nt-text");
    var file = el("nt-file");
    var drop = el("nt-drop");
    var prev = el("nt-prev");
    var clear = el("nt-clear");
    var msg = el("nt-msg");

    if (editing) {
      ta.value = step.text || "";
      if (step.hasImage) {
        // The image itself lives in the extension; pull it over to show it.
        GGBridge.stepImage(step.id).then(function (src) {
          if (src && !dropped) showPreview(src);
        }).catch(function () { /* the placeholder stands */ });
      }
    }
    ta.focus();

    function showPreview(src) {
      prev.src = src;
      prev.hidden = false;
      clear.hidden = false;
      drop.querySelector(".drop-empty").hidden = true;
    }
    function clearPreview() {
      prev.removeAttribute("src");
      prev.hidden = true;
      clear.hidden = true;
      drop.querySelector(".drop-empty").hidden = false;
    }

    function take(f) {
      say("nt-msg", "", "");
      readImage(f).then(function (url) {
        if (!url) return;
        picked = url;
        dropped = true;
        showPreview(url);
      }).catch(function (e) { say("nt-msg", e.message, "err"); });
    }

    drop.addEventListener("click", function (e) {
      if (e.target.closest("#nt-clear")) return;
      file.click();
    });
    drop.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); }
    });
    ["dragenter", "dragover"].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); });
    });
    ["dragleave", "drop"].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove("over"); });
    });
    drop.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) take(f);
    });
    file.addEventListener("change", function () { take(file.files && file.files[0]); });
    clear.addEventListener("click", function (e) {
      e.stopPropagation();
      picked = null;
      dropped = true;         // "I touched this and left it empty" — removes on save
      clearPreview();
    });

    el("nt-cancel").addEventListener("click", closeModal);
    el("nt-ok").addEventListener("click", function () {
      var text = ta.value.trim();
      if (!text && !picked) {
        return say("nt-msg", "Add some text, a picture, or both.", "err");
      }
      el("nt-ok").disabled = true;
      msg.textContent = "Saving…";

      var job;
      if (editing) {
        var patch = { text: text };
        // Only send `image` if the field was actually touched, so saving a reworded
        // caption doesn't re-upload — or silently drop — the existing picture.
        if (dropped) patch.image = picked;
        job = GGBridge.updateStep(step.id, patch).then(function () {
          step.text = text;
          if (dropped) step.hasImage = !!picked;
        });
      } else {
        job = GGBridge.addNote(cur.id, text, index, picked).then(function (fresh) {
          cur.steps.splice(index, 0, fresh);
        });
      }

      job.then(function () {
        closeModal();
        renderEditor();
        toast(editing ? "Step updated" : "Step added");
      }).catch(function (e) {
        el("nt-ok").disabled = false;
        say("nt-msg", e.message, "err");
      });
    });
  }

  // ---- local step card: everything editable ----

  function localCard(step, i) {
    var s = stepShell(step, i);

    var grip = mk("div", "grip");
    grip.innerHTML = svg(ICON.grip);
    grip.title = "Drag to reorder";
    grip.draggable = true;
    s.gutter.appendChild(grip);
    wireDrag(s.card, grip, i);

    s.ta.addEventListener("input", function () {
      autoGrow(s.ta);
      step.text = s.ta.value;
      clearTimeout(saveTimers[step.id]);
      saveTimers[step.id] = setTimeout(function () {
        GGBridge.updateStep(step.id, { text: step.text })
          .catch(function (e) { say("ed-msg", e.message, "err"); });
      }, 400);
    });

    if (step.hasImage) {
      var shot = mk("div", "shot" + (redacting[step.id] ? " redacting" : ""));
      shot.dataset.stepId = step.id;
      var ph = mk("div", "shot-skel");
      shot.appendChild(ph);
      var sel = mk("div", "sel");
      shot.appendChild(sel);
      s.content.appendChild(shot);
    }

    var tools = mk("div", "rowtools");
    tools.appendChild(iconBtn(ICON.up, "Move up", function () { move(i, -1); }, i === 0));
    tools.appendChild(iconBtn(ICON.down, "Move down", function () { move(i, 1); }, i === cur.steps.length - 1));

    if (step.hasImage) {
      var wasOn = !!redacting[step.id];
      var BLUR_LABEL = "Blur sensitive information";
      var redactBtn = expandBtn(wasOn ? ICON.check : ICON.redact, wasOn ? "Done blurring" : BLUR_LABEL);
      // Once you're in blur mode the label is the way out, so it stays open.
      if (wasOn) redactBtn.classList.add("brand-btn", "open");
      redactBtn.addEventListener("click", function () {
        var shotEl = s.card.querySelector(".shot");
        var on = shotEl.classList.toggle("redacting");
        if (on) redacting[step.id] = true; else delete redacting[step.id];
        var label = on ? "Done blurring" : BLUR_LABEL;
        redactBtn.innerHTML = svg(on ? ICON.check : ICON.redact) + '<span class="lbl"></span>';
        redactBtn.querySelector(".lbl").textContent = label;
        redactBtn.title = label;
        redactBtn.setAttribute("aria-label", label);
        redactBtn.classList.toggle("brand-btn", on);
        redactBtn.classList.toggle("open", on);
      });
      tools.appendChild(redactBtn);

      if ((step.blurs || []).length) {
        var clear = textBtn("Clear " + step.blurs.length, ICON.undo);
        clear.title = "Remove every blurred area on this step";
        clear.addEventListener("click", function () {
          step.blurs = [];
          GGBridge.updateStep(step.id, { blurs: [] }).then(function () {
            refreshStep(i);
            toast("Redactions cleared");
          }).catch(function (e) { say("ed-msg", e.message, "err"); });
        });
        tools.appendChild(clear);
      }
    }

    /* A step you added yourself is the only one whose picture is yours to change —
       a recorded screenshot is evidence of what was on screen when you clicked, and
       the worker refuses to overwrite one. */
    if (step.type === "note") {
      var edit = expandBtn(ICON.image, step.hasImage ? "Change the picture" : "Add a picture");
      edit.addEventListener("click", function () { openStepDialog(i, step); });
      tools.appendChild(edit);
    }

    if ((step.network || []).length) s.content.appendChild(netInline(step, i));

    tools.appendChild(mk("div", "spacer"));
    var del = iconBtn(ICON.trash, "Delete step", function () { removeStep(i); });
    del.classList.add("danger");
    tools.appendChild(del);
    s.content.appendChild(tools);

    return s.card;
  }

  /* ---------------------------------------------------------------- the API log
   *
   * The whole design problem here is that a guide must not turn into a log file.
   * A single-page app fires a handful of requests on nearly every click, so
   * rendering each step's requests inline turns a nine-step guide into two hundred
   * monospace rows and buries the step text the editor exists to edit.
   *
   * So there are two surfaces, and the split is on *whether anything went wrong*:
   *
   *   - **All fine** → one quiet line. "5 requests", muted, no expansion. It is a
   *     fact about the step, not a thing to read.
   *   - **Something failed** → an inline block, open, showing the failures only.
   *     That is the one case where the log is the point, and hiding it behind a
   *     click would be hiding the answer.
   *
   * Either way, "everything, in full" lives in the drawer — one place, reachable
   * from any step and from the editor toolbar. Nothing is truncated there. That is
   * what lets the inline view stay this small without losing anything.
   */
  function netCounts(step) {
    var reqs = step.network || [];
    return { reqs: reqs, bad: reqs.filter(function (r) { return !r.ok; }) };
  }

  function netRow(r) {
    var row = mk("div", "netrow" + (r.ok ? "" : " bad"));
    var status = r.error ? r.error : r.status || "—";
    row.innerHTML =
      '<span class="m"></span><span class="p"></span><span class="s"></span>' +
      '<span class="t">' + (r.ms != null ? r.ms + "ms" : "") + "</span>";
    row.querySelector(".m").textContent = r.method;
    row.querySelector(".p").textContent = (r.host || "") + r.path;
    row.querySelector(".p").title = (r.host || "") + r.path;
    row.querySelector(".s").textContent = String(status);
    return row;
  }

  /* One block of monospace text under a request — the cURL, or the response body.
   *
   * Clamped to a readable height with an explicit expander rather than left to
   * scroll inside the card: a nested scroll region inside a scrolling page is the
   * single most annoying pattern on the web, and a 200-line stack trace would
   * otherwise own the viewport.
   *
   * `label` is what makes two blocks under one row readable at a glance; without it
   * a cURL followed by a JSON envelope is one wall of monospace with no seam. */
  function netBlock(label, text, opts) {
    opts = opts || {};
    var wrap = mk("div", "netbodywrap");
    var head = mk("div", "netblockhead");
    var tag = mk("span", "netblocklabel");
    tag.textContent = label;
    head.appendChild(tag);
    head.appendChild(mk("div", "spacer"));
    if (opts.copy) {
      var cp = mk("button", "btn sm");
      cp.textContent = opts.copy;
      cp.addEventListener("click", function () {
        copyText(text, cp, opts.copy);
      });
      head.appendChild(cp);
    }
    wrap.appendChild(head);

    // A cURL is bounded by how many headers a request had — a dozen lines, and it
    // is the thing someone came here to read. A response body is unbounded. So the
    // request gets the taller clamp, and in practice never trips it.
    var pre = mk("pre", "netbody" + (opts.tall ? " tall" : ""));
    pre.textContent = text;
    wrap.appendChild(pre);
    if (opts.truncated) {
      var cut = mk("div", "netcut");
      cut.textContent = "Truncated from " + opts.truncated.toLocaleString() + " characters";
      wrap.appendChild(cut);
    }
    /* Whether to clamp is decided from the *text*, not by measuring the element.
     * Two reasons, both learned the hard way:
     *
     * - The max-height lives on `.clamped` alone, so an unclamped <pre> always
     *   reports scrollHeight === clientHeight however long it is. The original
     *   "measure, then clamp if it overflows" therefore never clamped anything, and
     *   a 200-line stack trace rendered in full — the exact clutter this block
     *   exists to prevent.
     * - Clamping first and then measuring does work, but only after layout has
     *   settled: measured at setTimeout(0) the same content came back taller than
     *   it ends up, so the expander appeared under text that was fully visible.
     *
     * Counting newlines plus a rough wrap allowance is deterministic, needs no
     * layout, and is wrong only at the margin — where the cost is an expander over
     * content that nearly fits. */
    var lines = text.split("\n").length + Math.floor(text.length / 90);
    if (lines > (opts.tall ? 16 : 8)) {
      pre.classList.add("clamped");
      var more = mk("button", "btn sm netmore");
      var openLabel = "Show full " + label.toLowerCase();
      more.textContent = openLabel;
      more.addEventListener("click", function () {
        var open = pre.classList.toggle("open");
        more.textContent = open ? "Collapse" : openLabel;
      });
      wrap.appendChild(more);
    }
    return wrap;
  }

  function copyText(text, btn, label) {
    var was = label || btn.textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = was; }, 1400);
      })
      .catch(function () { window.prompt("Copy:", text); });
  }

  /* Everything known about one request beyond its status line: the cURL of what was
   * sent, then what came back. In that order, because that is the order they
   * happened in and because the request is what someone reproducing the bug needs
   * first.
   *
   * Both are absent for a request that only Tier 1 saw, which is most of them — so
   * this returns an empty node and the row stands alone. That is the common case and
   * it is what keeps a 30-request step from becoming a wall. */
  function netDetail(r) {
    var wrap = mk("div", "netdetail");
    var curl = X && X.curlOf ? X.curlOf(r) : "";
    if (curl) wrap.appendChild(netBlock("Request", curl, { copy: "Copy cURL", tall: true }));
    if (r.body) wrap.appendChild(netBlock("Response", r.body, { truncated: r.bodyTruncated }));
    return wrap;
  }

  /* One request: its status line, and its detail underneath — open or behind a
   * peek button.
   *
   * The cURL now exists for *every* request rather than only failures, which is
   * what makes the log worth having on a flow that worked. It also means a step
   * that fired forty requests would render forty open cURLs, which is the wall this
   * whole feature is designed to avoid. So: a failure opens itself, because that is
   * the answer someone came for, and a success keeps its cURL one click away. The
   * data is all there either way; only the reading order changes. */
  function netItem(r, open) {
    var wrap = mk("div", "netitem");
    var row = netRow(r);
    var detail = netDetail(r);
    if (detail.childNodes.length) {
      var peek = mk("button", "netpeek");
      var label = r.reqHeaders || r.reqBody ? "cURL" : "Body";
      peek.textContent = open ? "Hide" : label;
      peek.title = "Show what was sent and what came back";
      detail.hidden = !open;
      peek.addEventListener("click", function () {
        detail.hidden = !detail.hidden;
        peek.textContent = detail.hidden ? label : "Hide";
      });
      row.appendChild(peek);
    }
    wrap.appendChild(row);
    wrap.appendChild(detail);
    return wrap;
  }

  function netInline(step, i) {
    var c = netCounts(step);
    var total = c.reqs.length + (step.networkMore || 0);

    // Nothing failed: one line, and it does not expand.
    if (!c.bad.length) {
      var quiet = mk("div", "netquiet");
      var b = mk("button", "netlink");
      b.innerHTML = svg(ICON.net, 13) + total + (total === 1 ? " request" : " requests");
      b.title = "See the API log for this guide";
      b.addEventListener("click", function () { openNetLog(step.id); });
      quiet.appendChild(b);
      return quiet;
    }

    // Something failed: show the failures, here, without asking.
    var box = mk("div", "netlog bad");
    var head = mk("div", "nethead");
    head.innerHTML =
      svg(ICON.warn, 15) +
      '<span><b>' + c.bad.length + (c.bad.length === 1 ? " request failed" : " requests failed") +
      "</b> of " + total + "</span>";
    box.appendChild(head);

    var list = mk("div", "netrows");
    // Inline, on the step: only the failures, and they open themselves.
    c.bad.forEach(function (r) { list.appendChild(netItem(r, true)); });
    box.appendChild(list);

    var foot = mk("div", "netfoot");
    var all = textBtn("See all " + total, ICON.net);
    all.classList.add("sm");
    all.addEventListener("click", function () { openNetLog(step.id); });
    foot.appendChild(all);
    foot.appendChild(netRemoveBtn(step, i));
    foot.appendChild(mk("div", "spacer"));
    var note = mk("span", "netnote");
    note.textContent = "AI handoff only";
    note.title = "Documents, slides and video never include the API log.";
    foot.appendChild(note);
    box.appendChild(foot);
    return box;
  }

  /* Removing a log is per step, and it exists for the same reason redaction does:
   * a response body is the one thing in a guide the user did not look at before it
   * was captured, so there has to be a way to take it out without deleting the
   * step it belongs to. */
  function netRemoveBtn(step, i, onDone) {
    var drop = textBtn("Remove", ICON.trash);
    drop.classList.add("sm");
    drop.title = "Remove the API log from this step";
    drop.addEventListener("click", function () {
      GGBridge.updateStep(step.id, { network: [] })
        .then(function () {
          step.network = [];
          step.networkMore = 0;
          if (onDone) onDone();
          else refreshStep(i);
          toast("API log removed from this step");
        })
        .catch(function (e) { say("ed-msg", e.message, "err"); });
    });
    return drop;
  }

  /* The drawer: every request in the guide, grouped by the step that caused it,
   * nothing truncated. `focusStepId` scrolls to the step you came from, so opening
   * this from step 7 does not dump you at step 1.
   *
   * "Failed only" defaults on when there are failures — that is what anyone opening
   * this is looking for — and off when there are none, where it would filter the
   * view down to nothing and look broken. */
  function openNetLog(focusStepId) {
    var steps = (cur.steps || []).filter(function (s) { return (s.network || []).length; });
    var totalBad = 0, total = 0;
    steps.forEach(function (s) {
      var c = netCounts(s);
      total += c.reqs.length;
      totalBad += c.bad.length;
    });
    if (!total) return infoModal("No API log", "None of these steps recorded any requests.");

    var failedOnly = totalBad > 0;
    var m = el("modal");
    m.classList.add("wide");
    m.innerHTML =
      "<h3>API log</h3>" +
      '<p class="netsum"></p>' +
      '<div class="netbar">' +
      '<label class="netfilter"><input type="checkbox" id="nl-bad"><span>Failed only</span></label>' +
      '<div class="spacer"></div>' +
      '<button class="btn sm" id="nl-copy">Copy log</button>' +
      "</div>" +
      '<div class="netscroll" id="nl-body"></div>' +
      '<div class="row"><span class="spacer"></span><button class="btn brand-btn" id="nl-close">Done</button></div>';
    m.querySelector(".netsum").textContent =
      total + (total === 1 ? " request" : " requests") + " across " +
      steps.length + (steps.length === 1 ? " step" : " steps") +
      (totalBad ? " · " + totalBad + " failed" : " · none failed");
    m.querySelector("#nl-bad").checked = failedOnly;
    if (!totalBad) m.querySelector("#nl-bad").disabled = true;

    function paint() {
      var only = m.querySelector("#nl-bad").checked;
      var body = m.querySelector("#nl-body");
      body.innerHTML = "";
      steps.forEach(function (s) {
        var c = netCounts(s);
        var show = only ? c.bad : c.reqs;
        if (!show.length) return;
        var i = cur.steps.indexOf(s);
        var grp = mk("div", "netgrp");
        /* Tagged, because the loop `return`s for any step with nothing to show — so `body.children`
           is a filtered list while `i` indexes the unfiltered one. Scrolling to the focused step by
           position therefore landed on a different step's group. Same fault as `refreshStep` had. */
        grp.dataset.stepId = s.id;
        var gh = mk("div", "netgrph");
        gh.innerHTML = '<span class="n">' + (i + 1) + "</span><span class=\"tx\"></span>";
        gh.querySelector(".tx").textContent = (s.text || "").replace(/\s+/g, " ").trim();
        var rm = netRemoveBtn(s, i, function () { paint(); renderEditor(); });
        gh.appendChild(rm);
        grp.appendChild(gh);
        // In the drawer: failures open, successes one click from their cURL.
        show.forEach(function (r) { grp.appendChild(netItem(r, !r.ok)); });
        if (s.networkMore && !only) {
          var more = mk("div", "netmoreline");
          more.textContent = s.networkMore + " more not recorded (per-step limit)";
          grp.appendChild(more);
        }
        body.appendChild(grp);
      });
      if (!body.children.length) {
        var none = mk("p", "netnote");
        none.textContent = "Nothing matches that filter.";
        body.appendChild(none);
      }
      if (focusStepId) {
        var node = body.querySelector('.netgrp[data-step-id="' + cssEscape(focusStepId) + '"]');
        if (node && node.scrollIntoView) node.scrollIntoView({ block: "start" });
      }
    }

    m.querySelector("#nl-bad").addEventListener("change", paint);
    m.querySelector("#nl-copy").addEventListener("click", function () {
      var btn = m.querySelector("#nl-copy");
      copyText(X.apiLogText(cur.guide, cur.steps), btn, "Copy log");
    });
    m.querySelector("#nl-close").addEventListener("click", closeModal);
    openModal();
    paint();
  }

  // ---- shared step card: words only ----

  function remoteCard(step, i) {
    var s = stepShell(step, i);

    s.ta.addEventListener("input", function () {
      autoGrow(s.ta);
      step.text = s.ta.value;
      clearTimeout(saveTimers["r" + i]);
      saveTimers["r" + i] = setTimeout(saveRemoteSteps, 600);
    });

    if (step.imageUrl) {
      var fig = mk("figure", "baked");
      var img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "Step " + (i + 1);
      // A 404 here — a CDN purge racing a page load, or assets deleted out of
      // band — otherwise shows a broken-image icon with no explanation.
      // Handler before src, always: a cached or instant failure fires the event
      // before the next statement runs, which is how this kind of fallback ends up
      // looking intermittent.
      img.onerror = function () {
        fig.classList.add("gone");
        fig.innerHTML = '<p class="no-img">This step\'s image is no longer available.</p>';
      };
      img.src = step.imageUrl;
      fig.appendChild(img);
      s.content.appendChild(fig);
    } else if (step.type !== "note") {
      var p = mk("p", "no-img");
      p.textContent = "No screenshot for this step";
      s.content.appendChild(p);
    }
    return s.card;
  }

  function saveRemoteSteps() {
    var steps = cur.steps.map(function (s) {
      var o = { seq: s.seq, type: s.type, text: s.text || "" };
      // Carry these through. Rewriting a shared guide's wording must not strip the
      // page context the AI handoff export reads.
      if (s.url) o.url = s.url;
      if (s.pageTitle) o.pageTitle = s.pageTitle;
      if (s.imageUrl) o.imageUrl = s.imageUrl;
      return o;
    });
    say("ed-msg", "Saving…");
    return GG.updateGuide(cur.id, { steps: steps })
      .then(function () { say("ed-msg", ""); toast("Changes saved"); })
      .catch(function (e) { say("ed-msg", e.message, "err"); });
  }

  // ---- images, one at a time ----
  //
  // The bridge deliberately doesn't send screenshots with the guide: even
  // width-capped WebP, a long guide is several megabytes in one message. Each card
  // asks for its own image as it comes into view.

  var io = null;

  function paint(shot, step) {
    return R.renderStep(Object.assign({}, step, { seq: cur.steps.indexOf(step) + 1 }))
      .then(function (canvas) {
        if (!canvas) return;
        shot.querySelectorAll(".shot-skel, canvas").forEach(function (n) { n.remove(); });
        shot.insertBefore(canvas, shot.firstChild);
        wireRedaction(shot, canvas, shot.querySelector(".sel"), step);
      });
  }

  function hydrateImages() {
    var shots = [].slice.call(el("ed-steps").querySelectorAll(".shot[data-step-id]"));
    if (!shots.length) return;

    var fetchOne = function (shot) {
      var id = shot.dataset.stepId;
      var step = cur.steps.filter(function (s) { return s.id === id; })[0];
      if (!step) return Promise.resolve();
      if (step.screenshot) return paint(shot, step);
      return GGBridge.stepImage(id).then(function (data) {
        step.screenshot = data;
        if (!data) {
          shot.innerHTML = '<p class="no-img">That screenshot is missing from storage.</p>';
          return;
        }
        return paint(shot, step);
      }).catch(function (e) {
        shot.innerHTML = '<p class="no-img">' + escapeHtml(e.message) + "</p>";
      });
    };

    // The first few load regardless of the observer. Partly so the top of the
    // guide is never briefly blank, and partly because an observer that never
    // fires — a hidden container, a zero-height window — would otherwise leave
    // every card a skeleton with no error and nothing to retry.
    var eager = shots.slice(0, 3);
    var rest = shots.slice(3);
    eager.reduce(function (c, s) {
      return c.then(function () { return fetchOne(s); });
    }, Promise.resolve());

    if (!rest.length) return;
    if (!("IntersectionObserver" in window)) {
      // No observer: fetch the remainder in order rather than all at once.
      rest.reduce(function (c, s) { return c.then(function () { return fetchOne(s); }); }, Promise.resolve());
      return;
    }
    // One observer at a time: renderEditor() runs again on every redaction and
    // reorder, and leaving the old one attached accumulates them.
    if (io) io.disconnect();
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        fetchOne(entry.target);
      });
    }, { rootMargin: "600px 0px" });
    rest.forEach(function (s) { io.observe(s); });
  }

  // Pulls every remaining image. Exports and publishing need the whole guide, not
  // just the part that has been scrolled past.
  function allImages(onProgress) {
    var missing = cur.steps.filter(function (s) { return s.hasImage && !s.screenshot; });
    if (!missing.length) return Promise.resolve(cur.steps);
    var done = 0;
    return missing.reduce(function (chain, step) {
      return chain.then(function () {
        return GGBridge.stepImage(step.id).then(function (data) {
          step.screenshot = data;
          done++;
          if (onProgress) onProgress(done / missing.length, "Loading image " + done + " of " + missing.length + "…");
        });
      });
    }, Promise.resolve()).then(function () { return cur.steps; });
  }

  // ---- reorder ----

  var dragFrom = null;
  function clearDropHints() {
    el("ed-steps").querySelectorAll(".step").forEach(function (s) {
      s.classList.remove("drop-before", "drop-after");
    });
  }

  function wireDrag(card, grip, i) {
    grip.addEventListener("dragstart", function (e) {
      dragFrom = i;
      card.classList.add("dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
        e.dataTransfer.setDragImage(card, 20, 20);
      } catch (err) { /* Safari */ }
    });
    grip.addEventListener("dragend", function () {
      dragFrom = null;
      card.classList.remove("dragging");
      clearDropHints();
    });
    card.addEventListener("dragover", function (e) {
      if (dragFrom == null || dragFrom === i) return;
      e.preventDefault();
      var r = card.getBoundingClientRect();
      clearDropHints();
      card.classList.add(e.clientY > r.top + r.height / 2 ? "drop-after" : "drop-before");
    });
    card.addEventListener("dragleave", function () {
      card.classList.remove("drop-before", "drop-after");
    });
    card.addEventListener("drop", function (e) {
      if (dragFrom == null) return;
      e.preventDefault();
      var r = card.getBoundingClientRect();
      var to = i + (e.clientY > r.top + r.height / 2 ? 1 : 0);
      var from = dragFrom;
      dragFrom = null;
      clearDropHints();
      if (to > from) to -= 1;
      if (to === from) return;
      var moved = cur.steps.splice(from, 1)[0];
      cur.steps.splice(to, 0, moved);
      saveOrder();
    });
  }

  function saveOrder() {
    var order = cur.steps.map(function (s) { return s.id; });
    renderEditor();
    return GGBridge.reorder(cur.id, order)
      .catch(function (e) { say("ed-msg", e.message, "err"); });
  }

  function move(i, dir) {
    var j = i + dir;
    if (j < 0 || j >= cur.steps.length) return;
    var tmp = cur.steps[i];
    cur.steps[i] = cur.steps[j];
    cur.steps[j] = tmp;
    saveOrder();
  }

  // The delete icon sits next to Move up and Move down, all three the same size,
  // and there is no undo — the bridge removes the step and its screenshot. Ask.
  function removeStep(i) {
    var step = cur.steps[i];
    confirmModal(
      "Delete step " + (i + 1) + "?",
      (step.text ? "“" + step.text + "”" : "This step") +
        " and its screenshot will be removed from the guide. This cannot be undone.",
      "Delete step"
    ).then(function (ok) {
      if (!ok) return;
      cur.steps.splice(i, 1);
      delete redacting[step.id];
      renderEditor();
      GGBridge.deleteStep(cur.id, step.id).then(function (r) {
        cur.guide.stepCount = r.stepCount;
        toast("Step deleted");
      }).catch(function (e) { say("ed-msg", e.message, "err"); });
    });
  }

  // Re-render one card rather than the whole guide. renderEditor() rebuilds every
  // step, which on a long guide means every canvas is redrawn and the page height
  // collapses and re-expands under the scroll position — very visible when the
  // thing that triggered it was drawing a small box halfway down.
  /* **`wrap.children[i]` was not this step's card, and that is why a redaction did not appear
     until the page was reloaded.**
     `renderEditor` puts an `insertRow` — the "+ add a step here" row — *before every card* and one
     after the last, so the children of `#ed-steps` alternate: row, card, row, card. The card for
     step `i` is at child index `2i + 1`. Reading `children[i]` therefore returned an insert row for
     step 0, step 0's card for step 1, and so on — so `replaceChild` painted the freshly redacted
     card over a "+" row while the real card sat there unchanged, showing the old pixels. A reload
     rebuilt everything from `cur.steps`, which had the blur all along; that is exactly why it "only
     worked after a refresh".
     Two other callers went through the same door: clearing every blur on a step, and one of the
     network-log removals. Both looked ignored for the same reason.
     Found by the step's own id rather than by any index, so a reorder or an insert between the save
     and the repaint cannot reintroduce this. */
  function refreshStep(i) {
    var wrap = el("ed-steps");
    var step = cur.steps[i];
    var old = step
      ? wrap.querySelector('.step[data-step-id="' + cssEscape(step.id) + '"]')
      : null;
    if (!old) old = wrap.querySelectorAll(".step")[i];
    if (!old || !step || cur.kind !== "local") return renderEditor();
    var card = localCard(step, i);
    wrap.replaceChild(card, old);
    var ta = card.querySelector("textarea");
    if (ta) autoGrow(ta);
    var shot = card.querySelector(".shot[data-step-id]");
    if (shot && step.screenshot) paint(shot, step);
  }

  // ---- redaction ----
  //
  // Same coordinate chain as the extension editor had: displayed px -> bitmap px
  // -> CSS px. dpr is bitmap-px-per-CSS-px for this stored screenshot, which is
  // not the device's devicePixelRatio — background.js folds the capture downscale
  // into it — so dividing by it is what puts the rect back into page coordinates.

  // Pointer events rather than mouse events, for two separate reasons.
  //
  // Reach: `mousedown`/`mousemove` are not synthesized for touch drags, so on a
  // touch screen or a trackpad in touch mode redaction did nothing at all — the one
  // editing action a reader of a sensitive guide most needs.
  //
  // Lifetime: releasing outside the image had to be caught, and the old code did it
  // with a listener on `window`. Nothing removed it, and renderEditor() re-wires
  // every visible step on every redaction and every reorder, so those accumulated —
  // each holding a stale canvas and step. `setPointerCapture` routes the rest of
  // the gesture to this element instead, so the handlers live and die with the card.
  function wireRedaction(shot, canvas, sel, step) {
    if (!canvas || !sel) return;
    var dragging = false, startX = 0, startY = 0;

    function at(e) {
      var rect = canvas.getBoundingClientRect();
      return {
        dispX: e.clientX - rect.left,
        dispY: e.clientY - rect.top,
        scaleX: canvas.width / rect.width,
        scaleY: canvas.height / rect.height,
      };
    }

    shot.addEventListener("pointerdown", function (e) {
      if (!shot.classList.contains("redacting")) return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      try { shot.setPointerCapture(e.pointerId); } catch (err) { /* no capture: window-free anyway */ }
      var p = at(e);
      startX = p.dispX; startY = p.dispY;
      sel.style.display = "block";
      sel.style.left = startX + "px";
      sel.style.top = startY + "px";
      sel.style.width = "0px";
      sel.style.height = "0px";
    });

    shot.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var p = at(e);
      sel.style.left = Math.min(startX, p.dispX) + "px";
      sel.style.top = Math.min(startY, p.dispY) + "px";
      sel.style.width = Math.abs(p.dispX - startX) + "px";
      sel.style.height = Math.abs(p.dispY - startY) + "px";
    });

    shot.addEventListener("pointercancel", function () {
      dragging = false;
      sel.style.display = "none";
    });

    shot.addEventListener("pointerup", function (e) {
      if (!dragging) return;
      dragging = false;
      sel.style.display = "none";
      var p = at(e);
      var dispX = Math.min(startX, p.dispX);
      var dispY = Math.min(startY, p.dispY);
      var dispW = Math.abs(p.dispX - startX);
      var dispH = Math.abs(p.dispY - startY);
      if (dispW < 6 || dispH < 6) return;
      var dpr = step.dpr || 1;
      step.blurs = (step.blurs || []).concat([{
        x: (dispX * p.scaleX) / dpr,
        y: (dispY * p.scaleY) / dpr,
        w: (dispW * p.scaleX) / dpr,
        h: (dispH * p.scaleY) / dpr,
      }]);
      GGBridge.updateStep(step.id, { blurs: step.blurs }).then(function () {
        refreshStep(cur.steps.indexOf(step));
      }).catch(function (err) { say("ed-msg", err.message, "err"); });
    });
  }

  // ---- title ----

  var titleTimer = null;
  el("ed-title").addEventListener("input", function () {
    if (!cur) return;
    cur.guide.title = el("ed-title").value;
    clearTimeout(titleTimer);
    titleTimer = setTimeout(function () {
      var t = cur.guide.title;
      var p = cur.kind === "local"
        ? GGBridge.updateGuide(cur.id, { title: t })
        : GG.patchGuide(cur.id, { title: t });
      p.catch(function (e) { say("ed-msg", e.message, "err"); });
    }, 400);
  });
  el("ed-title").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); el("ed-title").blur(); }
  });

  // ---- description ----

  /* Saved on the same 400ms debounce as the title, and to the same two places. On a
     published guide it patches the document directly, so the shared page picks up a
     reworded intro without re-uploading a single image. */
  var descTimer = null;
  el("ed-desc").addEventListener("input", function () {
    if (!cur) return;
    autoGrow(el("ed-desc"));
    cur.guide.description = el("ed-desc").value;
    clearTimeout(descTimer);
    descTimer = setTimeout(function () {
      var d = cur.guide.description;
      var p = cur.kind === "local"
        ? GGBridge.updateGuide(cur.id, { description: d })
        : GG.patchGuide(cur.id, { description: d });
      p.catch(function (e) { say("ed-msg", e.message, "err"); });
    }, 400);
  });

  el("ed-netlog").addEventListener("click", function () { openNetLog(null); });

  // ---- delete guide ----

  el("ed-delete").addEventListener("click", function () {
    if (!cur) return;
    var title = cur.guide.title || "Untitled guide";
    var shared = cur.kind === "remote" || cur.guide.remoteId;
    confirmModal(
      "Delete this guide?",
      "“" + title + "” and its " + cur.steps.length +
        (cur.steps.length === 1 ? " step" : " steps") + " will be removed." +
        (shared ? " Its screenshots will be deleted from our servers and anyone with the link will lose access." : "") +
        " This cannot be undone.",
      "Delete guide"
    ).then(function (ok) {
      if (!ok) return;
      var remoteId = cur.kind === "remote" ? cur.id : cur.guide.remoteId;
      var jobs = [];
      if (remoteId) jobs.push(GG.deleteGuideAndAssets(remoteId));
      if (cur.kind === "local") jobs.push(GGBridge.deleteGuide(cur.id));
      say("ed-msg", "Deleting…");
      Promise.all(jobs).then(function () {
        toast("Guide deleted");
        location.hash = "";
      }).catch(function (e) { say("ed-msg", e.message, "err"); });
    });
  });

  // ---- exports ----

  el("ed-export").setAttribute("aria-expanded", "false");
  el("ed-export").setAttribute("aria-haspopup", "menu");
  el("ed-export").addEventListener("click", function (e) {
    e.stopPropagation();
    var on = el("ed-export-menu").classList.toggle("open");
    el("ed-export").setAttribute("aria-expanded", String(on));
  });
  document.addEventListener("click", function () {
    el("ed-export-menu").classList.remove("open");
    el("ed-export").setAttribute("aria-expanded", "false");
  });
  el("ed-export-menu").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-x]");
    if (!btn) return;
    el("ed-export-menu").classList.remove("open");
    runExport(btn.dataset.x);
  });

  // Steps in the shape the exporters want. A shared guide's image is already
  // annotated, so it goes in as `screenshot` with no rect — renderStep then draws
  // the picture and adds nothing, which is exactly right: the ring and the number
  // are already in those pixels.
  function exportSteps() {
    if (cur.kind === "remote") {
      return Promise.resolve(cur.steps.map(function (s) {
        return { seq: s.seq, type: s.type, text: s.text, screenshot: s.imageUrl || null, blurs: [] };
      }));
    }
    return allImages(function (p, m) { say("ed-msg", m); }).then(function (steps) {
      say("ed-msg", "");
      return steps;
    });
  }

  function runExport(kind) {
    if (!cur || !cur.steps.length) return toast("Nothing to export yet.");
    var guide = {
      title: cur.guide.title || "Untitled guide",
      createdAt: cur.guide.createdAt,
      startUrl: cur.guide.startUrl,
    };

    if (kind === "video") return openVideoModal(guide);
    if (kind === "ai") return copyForAI(guide);
    if (kind === "rich") return copyRich(guide);

    var need = kind === "pdf"
      ? loadLib("/assets/lib/jspdf.umd.min.js", function () { return !!window.jspdf; })
      : kind === "pptx"
        ? loadLib("/assets/lib/pptxgen.bundle.js", function () { return !!window.PptxGenJS; })
        : Promise.resolve();

    var label = { html: "web page", md: "Markdown", pdf: "PDF", pptx: "PowerPoint" }[kind];
    say("ed-msg", "Building the " + label + "…");

    need.then(exportSteps).then(function (steps) {
      say("ed-msg", "Building the " + label + "…");
      if (kind === "html") return X.html(guide, steps);
      if (kind === "md") return X.markdown(guide, steps);
      if (kind === "pdf") return X.pdf(guide, steps);
      if (kind === "pptx") return X.pptx(guide, steps);
    }).then(function () {
      say("ed-msg", "");
      toast("Export ready — check your downloads.");
    }).catch(function (e) {
      say("ed-msg", "Export failed: " + e.message, "err");
    });
  }

  /* ---- Rich copy ----
   *
   * Needs the screenshots, unlike the AI handoff — the whole point is that the images
   * come with it — so it goes through exportSteps() and can take a moment on a long
   * guide. Says so, because a clipboard action that takes four seconds with no message
   * reads as a dead button. */
  function copyRich(guide) {
    say("ed-msg", "Building it for the clipboard…");
    exportSteps()
      .then(function (steps) { return X.rich(guide, steps); })
      .then(function () {
        say("ed-msg", "");
        toast("Copied — paste it into Notion, Confluence or Google Docs.");
      })
      .catch(function (e) {
        say("ed-msg", "Couldn't copy it: " + e.message, "err");
      });
  }

  // ---- AI handoff ----
  //
  // The only export that doesn't produce a file by default. What someone does with
  // this is paste it into a chat, so the clipboard is the destination and a download
  // is the fallback — for a browser without clipboard access, and for the case where
  // the steps are long enough that a file is genuinely easier to attach.
  //
  // It also skips `exportSteps()`, which pulls every screenshot over the bridge one
  // at a time. This format has no images in it, so on a forty-step guide that is
  // forty round trips avoided for nothing.
  function copyForAI(guide) {
    var text;
    try {
      text = X.aiText(guide, cur.steps.map(function (s, i) {
        return {
          seq: i + 1, type: s.type, text: s.text || "",
          url: s.url || "", pageTitle: s.pageTitle || "", blurs: s.blurs || [],
        };
      }));
    } catch (e) {
      return say("ed-msg", "Couldn't build the handoff: " + e.message, "err");
    }
    var fallback = function () {
      X.ai(guide, cur.steps);
      toast("Saved as a file — the clipboard wasn't available");
    };
    if (!navigator.clipboard) return fallback();
    navigator.clipboard.writeText(text).then(function () {
      toast(cur.steps.length + " steps copied — paste them into your assistant");
    }, fallback);
  }

  // ---- narrated video ----
  //
  // The one export that can't run here. The offline voice is an 88MB model that
  // ships inside the extension and can't be served from this site, so the
  // extension renders the video in an offscreen document and downloads it. That
  // also means it needs the guide's original screenshots — so it works for a guide
  // recorded on this device, and not for one that only exists in the account.

  function openVideoModal(guide) {
    if (cur.kind !== "local") {
      return infoModal(
        "Video needs the original recording",
        "This guide isn't on this device, and the narrated video is rendered from the " +
        "original screenshots by the extension. Open it on the machine that recorded it, " +
        "or export a PDF or web page instead.",
        "OK"
      );
    }
    if (!GGBridge.available()) {
      return infoModal(
        "The extension isn't available",
        "Narrated video is rendered by the GuideGen extension, because the offline voice " +
        "is an 88MB model that ships inside it. Install or enable the extension and try again.",
        "OK"
      );
    }

    var P = X.PACES;
    var keys = Object.keys(P);
    var pace = X.DEFAULT_PACE;

    el("modal").innerHTML =
      "<h3>Export narrated video</h3>" +
      "<p>Each step becomes a slide that stays on screen as long as its own text needs. " +
      "Pace sets how quickly the voice reads. The extension renders this in the background — " +
      "you can leave this tab.</p>" +
      '<label class="switch"><input type="checkbox" id="v-narrate" checked />' +
      '<span class="track"></span><span class="label"><b>Narrate with the built-in voice</b>' +
      "<small>Speech is synthesized on your machine. The first run loads the voice model.</small>" +
      "</span></label>" +
      '<div class="field"><span class="field-label">Pace</span><div class="segmented" id="v-pace">' +
      keys.map(function (k) {
        return '<button type="button" data-k="' + k + '" aria-pressed="' + (k === pace) + '">' +
          P[k].label + "</button>";
      }).join("") +
      '</div><div class="hint" id="v-est"></div></div>' +
      '<div class="progress" id="v-prog" style="display:none"><div></div></div>' +
      '<div class="status-line" id="v-status"></div>' +
      '<div class="row"><button class="btn" id="v-cancel">Cancel</button>' +
      '<span class="spacer"></span><button class="btn brand-btn" id="v-go">Create video</button></div>';
    openModal();

    var est = el("v-est");
    var seg = el("v-pace");
    function showEstimate() {
      var total = cur.steps.reduce(function (t, s) { return t + X.stepSecs(s.text, pace); }, 2);
      var m = Math.floor(total / 60);
      var sec = Math.round(total % 60);
      est.textContent = "About " + (m ? m + " min " : "") + sec + " sec · " +
        cur.steps.length + (cur.steps.length === 1 ? " step" : " steps");
    }
    seg.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-k]");
      if (!b) return;
      pace = b.dataset.k;
      seg.querySelectorAll("button").forEach(function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      showEstimate();
    });
    showEstimate();

    el("v-cancel").onclick = function () { closeModal(); };
    el("v-go").onclick = function () {
      var narrate = el("v-narrate").checked;
      var prog = el("v-prog");
      var bar = prog.firstElementChild;
      var status = el("v-status");
      prog.style.display = "block";
      el("v-go").disabled = true;
      el("v-cancel").disabled = true;
      el("overlay").dataset.busy = "1";

      GGBridge.renderVideo(cur.id, { pace: pace, narrate: narrate }, function (p, msg) {
        bar.style.width = Math.round((p || 0) * 100) + "%";
        if (msg) status.textContent = msg;
      }).then(function () {
        status.textContent = "Done — the video is in your downloads.";
        el("overlay").dataset.busy = "0";
        setTimeout(closeModal, 1600);
      }).catch(function (e) {
        status.textContent = "Video failed: " + e.message;
        el("v-go").disabled = false;
        el("v-cancel").disabled = false;
        el("overlay").dataset.busy = "0";
      });
    };
  }

  // ---- share / publish ----

  el("ed-share").addEventListener("click", openShareModal);

  function openShareModal() {
    if (!cur) return;
    var remoteId = cur.kind === "remote" ? cur.id : cur.guide.remoteId;
    var url = remoteId ? location.origin + "/g/" + remoteId : "";
    var shots = cur.steps.filter(function (s) {
      return cur.kind === "local" ? s.hasImage : s.imageUrl;
    }).length;
    var canPush = cur.kind === "local";

    var body;
    if (!remoteId) {
      body = "<h3>Publish this guide</h3>" +
        "<p>This uploads " + shots + (shots === 1 ? " screenshot" : " screenshots") +
        " and the step text of <b>this guide only</b>, then gives you a link. " +
        "Redact anything sensitive first — redactions are burned into the image before " +
        "it is uploaded, so no unredacted original ever leaves this machine.</p>";
    } else {
      body = "<h3>Shared</h3>" +
        "<p>Anyone with this link can open the guide." +
        (canPush ? " Update re-uploads the current version to the <b>same link</b>, so nothing you've already shared goes stale." : "") +
        "</p>" +
        '<div class="field"><input id="sh-url" readonly value="' + escapeHtml(url) + '" /></div>' +
        // Said out loud because it is a surprise otherwise: pasting the link into a
        // chat shows the *title* to that channel, whether or not they open it. The
        // picture is a GuideGen banner and never a step from the guide — worth
        // stating in the same breath, since "a preview image" reasonably sounds like
        // it might be one of your screenshots.
        '<p class="hint">Pasted into a chat, the preview shows this guide\'s title — ' +
        "<b>" + escapeHtml((cur.guide.title || "Untitled guide").slice(0, 80)) + "</b> — " +
        "with a GuideGen banner. Never a screenshot from the guide. Rename it above if that " +
        "title isn't for other eyes.</p>";
    }

    // Exports are only meaningful once there is a public page to export from.
    var exportRow = remoteId
      ? '<label class="switch" style="margin:16px 0 4px">' +
        '<input type="checkbox" id="sh-allow"' + (cur.guide.allowExport ? " checked" : "") + " />" +
        '<span class="track"></span><span class="label">' +
        "<b>Let readers export this guide</b>" +
        "<small>Adds an Export button to the shared page. They sign in first, and you " +
        "see who exported what, below. It doesn't stop anyone saving the guide — the " +
        "images are already public, so printing and right-click-save work either way.</small>" +
        "</span></label>"
      : "";

    /* The embed snippet, offered only once the guide is actually published — before
       that there is nothing to point an iframe at. `?embed=1` strips our house bar,
       nav and promo, so what lands on someone else's page is the guide and one quiet
       credit line rather than our chrome inside their layout. */
    var embedRow = remoteId
      ? '<p style="margin:16px 0 6px"><b>Embed it on your own site</b></p>' +
        '<div class="field"><input id="sh-embed" readonly value="' +
        escapeHtml('<iframe src="' + url + '?embed=1" width="100%" height="640" ' +
                   'style="border:1px solid #e5dfd2;border-radius:12px" loading="lazy" ' +
                   'title="Step-by-step guide"></iframe>') + '" /></div>' +
        '<p style="color:var(--muted);font-size:13px;margin:6px 0 0">Paste it into your help centre, ' +
        'docs or product page. Readers get the walkthrough — one step at a time — with none of our ' +
        'chrome around it.</p>'
      : "";

    el("modal").innerHTML = body + exportRow + embedRow +
      '<div class="progress" id="sh-prog" style="display:none"><div></div></div>' +
      '<div class="status-line" id="sh-msg"></div>' +
      '<div class="row"><button class="btn" id="sh-close">Close</button><span class="spacer"></span>' +
      (remoteId
        ? '<button class="btn" id="sh-unpub">Unpublish</button>' +
          '<button class="btn" id="sh-open">Open</button>' +
          (canPush ? '<button class="btn brand-btn" id="sh-update">Update</button>' : "") +
          '<button class="btn brand-btn" id="sh-copy">Copy link</button>'
        : '<button class="btn brand-btn" id="sh-go">Publish</button>') +
      "</div>";
    openModal();

    var note = function (t, kind) {
      var m = el("sh-msg");
      m.textContent = t || "";
      m.style.color = kind === "err" ? "var(--err)" : "var(--muted)";
    };
    el("sh-close").onclick = function () { closeModal(); };
    // The field is read-only and holds one value. Clicking it should hand over the
    // whole link, not start a text selection the user has to finish by hand.
    if (el("sh-url")) el("sh-url").onclick = function (e) { e.currentTarget.select(); };
    // Same reasoning as the link field: one value, read-only, and the thing you want
    // from it is the whole of it.
    if (el("sh-embed")) el("sh-embed").onclick = function (e) {
      e.currentTarget.select();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(e.currentTarget.value).then(function () {
          note("Embed code copied.");
        }, function () {});
      }
    };

    if (el("sh-allow")) {
      el("sh-allow").addEventListener("change", function (e) {
        var on = e.target.checked;
        cur.guide.allowExport = on;
        note(on ? "Saving…" : "Turning exports off…");
        GG.setAllowExport(remoteId, on).then(function () {
          note(on ? "Readers can export this guide." : "Export button removed from the shared page.");
          renderEditor();
        }).catch(function (err) {
          e.target.checked = !on;
          cur.guide.allowExport = !on;
          note(err.message, "err");
        });
      });
    }

    if (!remoteId) {
      el("sh-go").onclick = function () { doPublish(null, note); };
      return;
    }

    el("sh-copy").onclick = function (e) {
      var b = e.currentTarget;
      // navigator.clipboard is absent outside a secure context, and reading
      // .writeText off undefined throws synchronously — so the rejection handler
      // that selects the field instead would never have run. Same guard the
      // library row already uses.
      if (!navigator.clipboard) return el("sh-url").select();
      navigator.clipboard.writeText(url).then(function () {
        b.textContent = "Copied";
        setTimeout(function () { b.textContent = "Copy link"; }, 1400);
      }, function () { el("sh-url").select(); });
    };
    el("sh-open").onclick = function () { window.open(url, "_blank"); };
    if (canPush) el("sh-update").onclick = function () { doPublish(remoteId, note); };
    // Unpublishing revokes a link other people may already hold and deletes the
    // images behind it. It was a single click on a plain button sitting between
    // Close and Open, with nothing between the click and the consequence.
    el("sh-unpub").onclick = function () {
      var title = (cur && cur.guide && cur.guide.title) || "this guide";
      confirmModal(
        "Unpublish this guide?",
        "“" + title + "” will stop loading for anyone who has the link, and its screenshots " +
        "will be deleted from our servers. You can publish it again later, but the new link " +
        "will be a different one.",
        "Unpublish"
      ).then(function (ok) {
        if (!ok) return openShareModal();
        openModal();
        el("modal").innerHTML = "<h3>Unpublishing…</h3>" +
          '<p>Removing the public page and its images.</p><div class="status-line"></div>';
        GG.setVisibility(remoteId, "private").then(function () {
          toast("Unpublished — the link no longer works");
          closeModal();
          loadLibrary();
        }).catch(function (err) {
          closeModal();
          say("ed-msg", err.message, "err");
        });
      });
    };
  }

  function doPublish(remoteId, note) {
    var prog = el("sh-prog");
    var bar = prog.firstElementChild;
    prog.style.display = "block";
    ["sh-go", "sh-update", "sh-unpub"].forEach(function (id) {
      if (el(id)) el(id).disabled = true;
    });
    el("overlay").dataset.busy = "1";

    var onProgress = function (p, m) {
      bar.style.width = Math.round((p || 0) * 100) + "%";
      note(m);
    };
    /* startUrl and description travel with the publish: the first is how a
       recipient reaches the screen step 1 starts on, the second is the only thing
       on the page written for them rather than derived. Both live on the local
       index entry, and on the document itself once it has been published. */
    var guide = {
      title: cur.guide.title || "Untitled guide",
      startUrl: cur.guide.startUrl || "",
      description: cur.guide.description || "",
    };

    allImages(function (p, m) { onProgress(p * 0.05, m); })
      .then(function (steps) {
        return remoteId
          ? GGPublish.republish(remoteId, guide, steps, { onProgress: onProgress })
          : GGPublish.publish(guide, steps, { onProgress: onProgress });
      })
      .then(function (res) {
        // Remembering the published id is what lets this offer Update instead of
        // minting a second document, and a second link, on every press.
        if (cur.kind === "local") {
          cur.guide.remoteId = res.remoteId;
          return GGBridge.updateGuide(cur.id, {
            remoteId: res.remoteId, publishedAt: Date.now(),
          }).catch(function () { /* published fine; bookkeeping can retry */ })
            .then(function () { return res; });
        }
        return res;
      })
      .then(function (res) {
        el("overlay").dataset.busy = "0";
        toast(remoteId ? "Updated — the link is unchanged" : "Published — link copied to your clipboard");
        if (!remoteId && navigator.clipboard) navigator.clipboard.writeText(res.url).catch(function () {});
        if (res.note) say("ed-msg", res.note, "err");
        closeModal();
        renderEditor();
        loadLibrary();
      })
      .catch(function (e) {
        el("overlay").dataset.busy = "0";
        ["sh-go", "sh-update", "sh-unpub"].forEach(function (id) {
          if (el(id)) el(id).disabled = false;
        });
        note(e.message, "err");
      });
  }

  // ---------------------------------------------------------------- routing

  el("ed-back").addEventListener("click", function () { location.hash = ""; });

  function show(which) {
    el("view-auth").hidden = which !== "auth";
    el("view-lib").hidden = which !== "lib";
    el("view-editor").hidden = which !== "editor";
  }

  function route() {
    if (!GG.current()) return;
    var h = location.hash.replace(/^#/, "");
    var m = /^(local|g)-(.+)$/.exec(h);
    if (!m) {
      cur = null;
      show("lib");
      loadLibrary();
      return;
    }
    show("editor");
    el("ed-steps").innerHTML = '<div class="skel"></div><div class="skel"></div>';
    say("ed-msg", "");
    var open = m[1] === "local" ? openLocal(m[2]) : openRemote(m[2]);
    open.then(renderEditor).catch(function (e) {
      el("ed-steps").innerHTML = "";
      say("ed-msg", e.message, "err");
      el("ed-title").value = "";
      el("ed-meta").textContent = "";
    });
  }

  window.addEventListener("hashchange", route);

  // Adopt the extension's session before deciding which view to show: the popup is
  // where a user signs in, and asking again here would be asking twice for one
  // product.
  function bootSession() {
    if (GG.current() || !GGBridge.available()) return Promise.resolve();
    return GGBridge.session()
      .then(function (s) { if (s) GG.adopt(s); })
      .catch(function () { /* no extension, or it declined — sign in here instead */ });
  }

  bootSession().then(function () {
    GG.onChange(function (s) {
      var signedIn = !!s;
      el("nav-signed-in").hidden = !signedIn;
      el("nav-signed-out").hidden = signedIn;
      if (!signedIn) {
        show("auth");
        mode = "signin";
        el("email").value = "";
        el("password").value = "";
        el("full-name").value = "";
        applyMode();
        return;
      }
      // Name if we have it, email as the tooltip. A name is what a person
      // recognises as themselves.
      el("acct-email").textContent = s.name || s.email || "";
      el("acct-email").title = s.email || "";
      route();
    });
  });
})();
