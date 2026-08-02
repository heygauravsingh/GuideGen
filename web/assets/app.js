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

  var lib = { local: [], remote: [], extVersion: null, extError: null };
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
    redact: '<rect x="4" y="7" width="16" height="11" rx="2"/><path d="M8 12h8"/>',
    check: '<path d="m5 13 4 4L19 7"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
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

    return Promise.all([localP, remoteP]).then(function (r) {
      lib.local = r[0] || [];
      lib.remote = r[1] || [];
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
    if (!rows.length) {
      list.innerHTML = blankState();
      el("dash-sub").textContent = "Nothing here yet.";
      return;
    }
    rows.forEach(function (r) { list.appendChild(libRow(r)); });
    el("dash-sub").textContent =
      rows.length === 1 ? "1 guide" : rows.length + " guides";
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
    el("ed-share-label").textContent =
      (cur.kind === "remote" || g.remoteId) ? "Sharing" : "Share";

    var bits = [cur.steps.length + (cur.steps.length === 1 ? " step" : " steps"), fmtDate(g.createdAt)];
    if (isLocal && g.startUrl) bits.push(shortUrl(g.startUrl));
    if (!isLocal) bits.push("shared guide");
    el("ed-meta").textContent = bits.join(" · ");

    // Note is a local-only action: a note has no baked image, so adding one to a
    // shared guide would need a re-publish to appear anywhere.
    el("ed-note").hidden = !isLocal;

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
        "<p>Record again, or add a note to start writing it by hand.</p></div>";
      return;
    }
    cur.steps.forEach(function (step, i) {
      var card = isLocal ? localCard(step, i) : remoteCard(step, i);
      wrap.appendChild(card);
      // Size the textarea only once it is laid out in the document. Doing it while
      // the card is still detached reads scrollHeight 0 and collapses the text to
      // an invisible zero-height box.
      var ta = card.querySelector("textarea");
      if (ta) autoGrow(ta);
    });
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

  function stepShell(step, i) {
    var card = mk("div", "step" + (step.type === "note" ? " is-note" : ""));
    card.dataset.i = String(i);

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
      var redactBtn = textBtn(wasOn ? "Done" : "Redact", wasOn ? ICON.check : ICON.redact);
      if (wasOn) redactBtn.classList.add("brand-btn");
      redactBtn.addEventListener("click", function () {
        var shotEl = s.card.querySelector(".shot");
        var on = shotEl.classList.toggle("redacting");
        if (on) redacting[step.id] = true; else delete redacting[step.id];
        redactBtn.innerHTML = (on ? svg(ICON.check) : svg(ICON.redact)) + (on ? "Done" : "Redact");
        redactBtn.classList.toggle("brand-btn", on);
      });
      tools.appendChild(redactBtn);

      if ((step.blurs || []).length) {
        var clear = textBtn("Clear " + step.blurs.length, ICON.undo);
        clear.title = "Remove all redactions on this step";
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

    tools.appendChild(mk("div", "spacer"));
    var del = iconBtn(ICON.trash, "Delete step", function () { removeStep(i); });
    del.classList.add("danger");
    tools.appendChild(del);
    s.content.appendChild(tools);

    return s.card;
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
  function refreshStep(i) {
    var wrap = el("ed-steps");
    var old = wrap.children[i];
    var step = cur.steps[i];
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

  // ---- add note ----

  el("ed-note").addEventListener("click", function () {
    if (!cur || cur.kind !== "local") return;
    GGBridge.addNote(cur.id, "Add a note or instruction here…").then(function (step) {
      cur.steps.push(step);
      renderEditor();
      var last = el("ed-steps").querySelector(".step:last-of-type textarea");
      if (last) { autoGrow(last); last.focus(); last.select(); }
    }).catch(function (e) { say("ed-msg", e.message, "err"); });
  });

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
        '<div class="field"><input id="sh-url" readonly value="' + escapeHtml(url) + '" /></div>';
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

    el("modal").innerHTML = body + exportRow +
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
    var guide = { title: cur.guide.title || "Untitled guide" };

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
