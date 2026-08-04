/* The try-it demo on the GuideGen landing page.
 *
 * A visitor clicks a pretend admin panel and a guide writes itself beside it, ending on
 * "Copy it for an AI" — the flagship export demonstrated rather than claimed, with
 * something they actually want to paste. It is the only component on this page that
 * *shows* the product instead of describing it.
 *
 * It lived on the house page (backpocket.website) first and was moved here on 4 Aug 2026:
 * it sells GuideGen specifically, and the house sells the house. Nothing about the house
 * needs it.
 *
 * **Nothing is captured or sent.** The step "screenshots" are clones of the mock's own
 * DOM, scaled with `zoom`, with a ring drawn over whatever was clicked. That is honest by
 * construction — it is our own markup — and a real capture would need permissions no
 * landing page should ask for. The copy under the demo says so outright.
 *
 * The wording follows recorder.js's conventions on purpose, because the whole point is
 * that this is what the real thing writes.
 *
 * Older idiom (`var`, `function`, no arrows) to match gg.js, app.js and the rest of
 * web/assets.
 */
(function () {
  function el(id) { return document.getElementById(id); }

  var app = el("demo-app");
  if (!app) return;

  var list = el("demo-steps");
  var count = el("demo-count");
  var foot = el("demo-foot");
  var reset = el("demo-reset");

  var steps = [];
  var typingTimer = null;
  var typedRecorded = "";   // the value already written into a step, for the dedupe

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

  /* The row a control belongs to, if any. Two "View KYC" buttons on two different riders
     produced two steps reading `Click "View KYC"` — identical text, different rings, and a
     guide nobody could follow. The real recorder disambiguates from surrounding context;
     this does the same, from the card's own label. */
  function context(target) {
    var card = target.closest ? target.closest(".da-card") : null;
    if (!card || card === target) return "";
    var label = card.getAttribute("data-label");
    return label ? ' on "' + label + '"' : "";
  }

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
    return 'Click "' + label + '"' + context(target);
  }

  /* A step's picture: the mock, cloned and shrunk, with a ring over what was clicked.
     Cloned rather than captured — see the header. The ring is positioned in percentages of
     the mock's own box, so it lands correctly at whatever width the card renders. */
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

  /* Adds a step, unless it repeats the one before it. Clicking the same thing twice is a
     slip, not two instructions, and the real recorder merges redundant steps for the same
     reason — a guide that says "Click Payouts. Click Payouts." reads as broken. */
  function add(text, target) {
    var last = steps[steps.length - 1];
    if (last && !last.typing && last.text === text) return;
    steps.push({ text: text, shot: target ? thumb(target) : null });
    paint();
  }

  /* Ends a pending typing burst *now*. Called before a click is recorded, because steps are
     appended in arrival order: left to its own 650ms timer, `Type "demo"` lands after the
     click it led to, and the guide reads as though the result was clicked before it was
     searched for. The real recorder flushes on pointerdown for exactly this reason. */
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

  app.addEventListener("click", function (e) {
    // A checkbox is handled by its own `change` listener below. Clicking the <label>
    // toggles the inner <input>, which dispatches a second click that bubbles right back
    // here — and that produced the same step twice.
    if (e.target.closest(".da-check")) return;
    flushTyping();
    var target = e.target.closest("[data-label]");
    if (!target) return;
    if (target.classList.contains("da-nav")) {
      [].forEach.call(app.querySelectorAll(".da-nav"), function (n) { n.classList.remove("on"); });
      target.classList.add("on");
    }
    /* The mock reacts to being opened. Without it, clicking "View KYC" changed nothing on
       screen, so two steps in the guide looked identical even once their text differed —
       the visitor's own click appeared to do nothing at all. */
    var row = target.closest(".da-card");
    if (row && target.tagName === "BUTTON") {
      [].forEach.call(app.querySelectorAll(".da-card"), function (c) { c.classList.remove("on"); });
      row.classList.add("on");
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

  /* Typing is one step per burst, not one per keystroke — the same 650ms settle the real
     recorder uses, and the same reason: "Type "d"", "Type "de"", "Type "dem"" is not a
     guide, it's a keylogger transcript. */
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

  if (reset) {
    reset.addEventListener("click", function () {
      steps = [];
      typedRecorded = "";
      clearTimeout(typingTimer);
      var s = el("da-search");
      if (s) s.value = "";
      var c = app.querySelector(".da-check input");
      if (c) c.checked = false;
      [].forEach.call(app.querySelectorAll(".da-card.on, .da-nav.on"), function (n) {
        n.classList.remove("on");
      });
      paint();
    });
  }

  /* The payoff. Same shape as the real AI handoff: a header saying there are no images,
     then the steps. Someone can paste this into an assistant and get something back, which
     is the entire pitch delivered without an install. */
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
      if (!steps.length) return toast("Click something on the left first.");
      var text = handoffText();
      if (!navigator.clipboard) return toast("Copying isn't available in this browser.");
      navigator.clipboard.writeText(text).then(function () {
        toast("Copied — paste it into ChatGPT or Claude");
      }, function () {
        toast("Couldn't copy. Select the steps and copy them manually.");
      });
    });
  }

  paint();
})();
