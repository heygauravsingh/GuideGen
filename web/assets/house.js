/* Backpocket — the house page (backpocket.website).
 *
 * Three things live here, and the first one is the reason the page exists.
 *
 * 1. **The demo.** A visitor clicks a pretend admin panel and a guide writes itself
 *    beside it. It is the only component on any landing page I've written that
 *    *shows* the product instead of describing it, and it ends on the flagship
 *    export — "copy it for an AI" — with something they actually want to paste.
 *
 *    The step "screenshots" are clones of the mock's own DOM, scaled down, with a
 *    ring drawn over whatever was clicked. That is deliberate rather than lazy: a
 *    real capture would need permissions no landing page should ask for, and the
 *    mock is our markup, so cloning it is honest. The copy under the demo says
 *    plainly that nothing is recorded.
 *
 * 2. **Votes**, written to the same `waitlist` collection the email form uses. The
 *    Firestore rules allow create-only with exactly `email`, `note` and `createdAt`
 *    and forbid reading it back, so a vote is a `note` of `vote:<slug>` and needs no
 *    rules change. Nothing here can enumerate anyone else's submission.
 *
 * 3. **Share links**, prefilled. No third-party widgets — the site loads nothing
 *    from an external host, which is the rule the rest of this codebase keeps, and a
 *    share button that ships a tracker onto a privacy page would be its own joke.
 *
 * Written in the older idiom (`var`, `function`, no arrows) to match gg.js, app.js
 * and the rest of `web/assets`.
 */
(function () {
  var API_KEY = "AIzaSyCihDiLQ51V0C8DS07WTl70FOpC3ACkfJY";
  var PROJECT = "guidegen-1f938";
  var WAITLIST = "https://firestore.googleapis.com/v1/projects/" + PROJECT +
                 "/databases/(default)/documents/waitlist?key=" + API_KEY;

  function el(id) { return document.getElementById(id); }

  var toastTimer = null;
  function toast(text) {
    var t = el("toast");
    if (!t) return;
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ------------------------------------------------------------------ the demo

  var steps = [];
  var typingTimer = null;
  var typedRecorded = "";   // the value already written into a step, for the dedupe

  var app = el("demo-app");
  var list = el("demo-steps");
  var count = el("demo-count");
  var foot = el("demo-foot");
  var reset = el("demo-reset");

  /* The wording follows recorder.js's conventions on purpose — "Click "Payouts"",
     "Type "demo" in the "Search riders" field", "Check "Only show disabled riders"" —
     because the whole point of the demo is that this is what the real thing writes. */
  function describe(target, kind) {
    var label = target.getAttribute("data-label") ||
                (target.textContent || "").trim().slice(0, 40) || "it";
    if (kind === "input") {
      return 'Type "' + (target.value || "").trim() + '" in the "' + label + '" field';
    }
    if (kind === "check") {
      return (target.querySelector("input").checked ? "Check " : "Uncheck ") + '"' + label + '"';
    }
    if (target.classList.contains("da-input")) return 'Click the "' + label + '" field';
    return 'Click "' + label + '"';
  }

  /* A step's picture: the mock, cloned and shrunk, with a ring over what was clicked.
     Cloned rather than captured — see the header. The ring is positioned in percentages
     of the mock's own box, so it lands correctly at whatever width the card renders. */
  function thumb(target) {
    var box = app.getBoundingClientRect();
    var r = target.getBoundingClientRect();
    var wrap = document.createElement("div");
    wrap.className = "shot-mini";

    var inner = document.createElement("div");
    inner.className = "shot-mini-in";
    var clone = app.cloneNode(true);
    clone.removeAttribute("id");
    // A cloned form control keeps its value but must never be focusable — Tab would
    // otherwise walk into a dozen dead copies of the same input.
    [].forEach.call(clone.querySelectorAll("input, button"), function (n) {
      n.setAttribute("tabindex", "-1");
      n.setAttribute("aria-hidden", "true");
      n.disabled = true;
    });
    inner.appendChild(clone);

    var ring = document.createElement("div");
    ring.className = "shot-ring";
    ring.style.left = ((r.left - box.left) / box.width * 100) + "%";
    ring.style.top = ((r.top - box.top) / box.height * 100) + "%";
    ring.style.width = (r.width / box.width * 100) + "%";
    ring.style.height = (r.height / box.height * 100) + "%";
    inner.appendChild(ring);

    wrap.appendChild(inner);
    return wrap;
  }

  function paint() {
    if (!steps.length) {
      list.innerHTML =
        '<div class="demo-empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>' +
        "<p>Click something on the left.</p></div>";
      count.textContent = "0 steps";
      foot.hidden = true;
      reset.hidden = true;
      return;
    }
    list.innerHTML = "";
    steps.forEach(function (s, i) {
      var card = document.createElement("div");
      card.className = "demo-step";
      card.innerHTML = '<div class="ds-n">' + (i + 1) + '</div><div class="ds-b">' +
                       '<p class="ds-t">' + esc(s.text) + "</p></div>";
      if (s.shot) card.querySelector(".ds-b").appendChild(s.shot);
      list.appendChild(card);
    });
    count.textContent = steps.length + (steps.length === 1 ? " step" : " steps");
    foot.hidden = false;
    reset.hidden = false;
    // Newest step into view, but only inside the panel — never scroll the page under
    // someone who is still clicking the mock.
    list.scrollTop = list.scrollHeight;
  }

  function add(text, target) {
    steps.push({ text: text, shot: target ? thumb(target) : null });
    paint();
  }

  /* Ends a pending typing burst *now*. Called before a click is recorded, because steps
     are appended in arrival order: left to its own 650ms timer, `Type "demo"` lands after
     the click it led to, and the guide reads as though the result was clicked before it
     was searched for. The real recorder flushes on pointerdown for exactly this reason. */
  function flushTyping() {
    clearTimeout(typingTimer);
    var search = el("da-search");
    if (!search) return;
    var v = search.value.trim();
    // Dedupe against what was last *recorded*, not against the last step: a click flushes
    // the burst, and the 650ms timer then fires anyway and would record it a second time.
    // By then the last step is the click, so inspecting it tells you nothing.
    if (!v || v === typedRecorded) return;
    var last = steps[steps.length - 1];
    // Still mid-burst on the same field: replace rather than stack.
    if (last && last.typing) steps.pop();
    steps.push({
      text: describe(search, "input"), shot: thumb(search),
      typing: true, value: v,
    });
    typedRecorded = v;
  }

  if (app) {
    app.addEventListener("click", function (e) {
      // A checkbox is handled by its own `change` listener below. Clicking the <label>
      // toggles the inner <input>, which dispatches a second click that bubbles right
      // back here — and that produced the same step twice.
      if (e.target.closest(".da-check")) return;
      flushTyping();
      var target = e.target.closest("[data-label]");
      if (!target) return;
      if (target.classList.contains("da-nav")) {
        [].forEach.call(app.querySelectorAll(".da-nav"), function (n) { n.classList.remove("on"); });
        target.classList.add("on");
      }
      add(describe(target, "click"), target);
    });

    var box = app.querySelector(".da-check");
    if (box) {
      box.querySelector("input").addEventListener("change", function () {
        flushTyping();
        add(describe(box, "check"), box);
      });
    }

    /* Typing is one step per burst, not one per keystroke — the same 650ms settle the
       real recorder uses, and the same reason: "Type "d"", "Type "de"", "Type "dem"" is
       not a guide, it's a keylogger transcript. */
    var search = el("da-search");
    if (search) {
      search.addEventListener("input", function () {
        clearTimeout(typingTimer);
        typingTimer = setTimeout(function () {
          flushTyping();
          paint();
        }, 650);
      });
    }
  }

  if (reset) {
    reset.addEventListener("click", function () {
      steps = [];
      typedRecorded = "";
      clearTimeout(typingTimer);
      var s = el("da-search");
      if (s) s.value = "";
      var c = app.querySelector(".da-check input");
      if (c) c.checked = false;
      paint();
    });
  }

  /* The payoff. Same shape as the real AI handoff: a header saying there are no images,
     then the steps. Someone can paste this into an assistant and get something back,
     which is the entire pitch delivered without an install. */
  function handoffText() {
    var out = "# How to do this in app.yourcompany.com\n\n";
    out += "Below is a workflow, recorded step by step. The screenshots are not included — " +
           "this is the text version.\n\n";
    out += "Page: app.yourcompany.com/riders\n\n";
    steps.forEach(function (s, i) {
      out += (i + 1) + ". " + s.text + "\n";
    });
    out += "\n---\nMade with GuideGen (backpocket.website) — this was a demo on a pretend " +
           "dashboard. The real thing records any website, with a screenshot of every step.\n";
    return out;
  }

  var copy = el("demo-copy");
  if (copy) {
    copy.addEventListener("click", function () {
      var text = handoffText();
      if (!navigator.clipboard) return toast("Copying isn't available in this browser.");
      navigator.clipboard.writeText(text).then(function () {
        toast("Copied — paste it into ChatGPT or Claude");
      }, function () {
        toast("Couldn't copy. Select the steps and copy them manually.");
      });
    });
  }

  // ------------------------------------------------------------------ votes

  function submitWaitlist(email, note) {
    return fetch(WAITLIST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          email: { stringValue: email },
          note: { stringValue: note },
          createdAt: { timestampValue: new Date().toISOString() },
        },
      }),
    }).then(function (r) {
      if (!r.ok) throw new Error("That didn't save. Try again in a moment.");
      return true;
    });
  }

  /* A vote wants an email, or it is a number anyone can inflate by holding a key down.
     Asked for inline rather than in a dialog: one extra field beats a modal for a
     one-tap action, and the button becomes the confirmation. */
  [].forEach.call(document.querySelectorAll(".tool[data-vote] .vote-btn"), function (btn) {
    btn.addEventListener("click", function () {
      var card = btn.closest(".tool");
      var slug = card.getAttribute("data-vote");
      var acts = btn.parentNode;
      if (acts.querySelector(".vote-form")) return;

      var form = document.createElement("form");
      form.className = "vote-form";
      form.innerHTML =
        '<input type="email" placeholder="you@wherever.com" aria-label="Your email" />' +
        '<button class="btn sm brand-btn" type="submit">Vote</button>';
      acts.appendChild(form);
      btn.hidden = true;
      form.querySelector("input").focus();

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var input = form.querySelector("input");
        var value = (input.value || "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
          input.focus();
          return say("vote-msg", "That doesn't look like an email address.", "err");
        }
        form.querySelector("button").disabled = true;
        submitWaitlist(value, "vote:" + slug).then(function () {
          form.replaceWith(document.createTextNode(""));
          var done = document.createElement("span");
          done.className = "voted";
          done.textContent = "Voted — you'll hear when it ships";
          acts.appendChild(done);
          say("vote-msg", "", "");
          toast("Vote counted");
        }).catch(function (err) {
          form.querySelector("button").disabled = false;
          say("vote-msg", err.message, "err");
        });
      });
    });
  });

  function say(id, text, kind) {
    var m = el(id);
    if (!m) return;
    m.textContent = text || "";
    m.className = (id === "wl-msg" ? "wl-msg" : "msg") + (kind ? " " + kind : "");
  }

  // ------------------------------------------------------------------ email

  var wlForm = el("wl-form");
  if (wlForm) {
    wlForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = el("wl-email");
      var btn = el("wl-btn");
      var value = (input.value || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        input.focus();
        return say("wl-msg", "That doesn't look like an email address.", "err");
      }
      btn.disabled = true;
      say("wl-msg", "Adding you…");
      submitWaitlist(value, "house").then(function () {
        wlForm.reset();
        say("wl-msg", "Done. One email per tool, nothing else.", "ok");
      }).catch(function (err) {
        say("wl-msg", err.message, "err");
      }).then(function () { btn.disabled = false; });
    });
  }

  // ------------------------------------------------------------------ share

  var SHARE_TEXT = "Small tools that run on your own machine — nothing uploaded. " +
                   "The first one records a workflow once and hands it to a person or an AI:";
  var URL_ = "https://backpocket.website/";

  var links = {
    x: "https://twitter.com/intent/tweet?text=" + encodeURIComponent(SHARE_TEXT) +
       "&url=" + encodeURIComponent(URL_),
    wa: "https://api.whatsapp.com/send?text=" + encodeURIComponent(SHARE_TEXT + " " + URL_),
    li: "https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent(URL_),
  };
  [].forEach.call(document.querySelectorAll("[data-share]"), function (a) {
    var href = links[a.getAttribute("data-share")];
    if (href) a.href = href;
  });

  var shareCopy = el("share-copy");
  if (shareCopy) {
    shareCopy.addEventListener("click", function () {
      if (!navigator.clipboard) return toast("Copying isn't available in this browser.");
      navigator.clipboard.writeText(URL_).then(function () { toast("Link copied"); },
        function () { toast("Couldn't copy — copy it from the address bar."); });
    });
  }
})();
