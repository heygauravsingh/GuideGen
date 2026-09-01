// GuideGen — content-script recorder.
// Captures clicks and form input while recording, and shows a floating pill.
(() => {
  if (window.__flowscribeLoaded) return;
  window.__flowscribeLoaded = true;

  const UI = "data-flowscribe-ui";
  let recording = false;
  let count = 0;
  let pill = null;
  let lastCaptureTs = 0;

  /* Buffering is the same listeners with a different destination: steps go to the
   * ring buffer instead of a guide, so "make a guide from what I just did" has
   * something to work from. Recording always wins — background.js refuses to
   * buffer during a recording, and the pill says which mode is running.
   *
   * `mode()` is the single source of truth for whether the listeners should be
   * attached, so there is one place that can get it wrong. */
  let buffering = false;
  let bufCount = 0;
  /* Declared up here, not beside retire() where it is used, because the boot path
     below calls askBuffer() -> safeSend(), which reads it. chrome.storage callbacks
     are always async so in Chrome the declaration has always been reached first —
     but that is a scheduling detail to not depend on, and a stub that answers
     synchronously walks straight into the temporal dead zone. */
  let orphaned = false;
  function mode() { return recording ? "rec" : buffering ? "buf" : null; }
  let attached = null;
  // Declared here rather than beside askNetPatch(): sync() resets it, and sync() is
  // reachable from the first storage callback. See the temporal-dead-zone note above.
  let patchAsked = false;

  // Attach, detach or switch, whichever the current mode calls for. Called after
  // every state change rather than each caller deciding — recording starting while
  // an origin is armed has to swap the pill, not stack two of them.
  function sync() {
    const m = mode();
    if (m === attached) { updatePill(); return; }
    if (attached) stop();
    attached = m;
    // A new mode gets to ask about the patch again. Buffering with the opt-in off
    // used to burn the latch for the whole page load, so pressing Start on an armed
    // site — with the box ticked — attached no patch and captured no exchanges.
    patchAsked = false;
    if (m) start(m);
  }

  // Initial state
  chrome.storage.local.get("fs_state", (r) => {
    const s = r.fs_state;
    if (s && s.recording) {
      recording = true;
      count = s.stepCount || 0;
    }
    sync();
    askBuffer();
  });

  // Whether this page's origin is armed for buffering is the worker's call, not
  // ours — it holds the list, and asking keeps one copy of the rule.
  function askBuffer() {
    safeSend({ type: "fs_buf_status" }, (r) => {
      if (!r) return;
      buffering = !!r.armed;
      bufCount = r.count || 0;
      sync();
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "fs_recording_changed") {
      recording = !!msg.recording;
      if (recording) count = 0;
      sync();
    }
    if (msg.type === "fs_buf_changed") {
      /* No count is read off the broadcast any more. It carried the size of the whole
         buffer across every armed site, which is what made the pill claim "10 steps
         held" on a site holding none. askBuffer() is the single source now — it asks
         the one handler that scopes the number to the session this tab would capture. */
      askBuffer();
    }
    // The Tier 2 opt-in changed while this page was already open. Ask again: the
    // worker refused the patch when the box was off, and nothing else would ever
    // re-ask, so the box did nothing until a reload.
    if (msg.type === "fs_net_patch_changed") {
      patchAsked = false;
      if (mode()) askNetPatch();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.fs_state) {
      const s = changes.fs_state.newValue;
      if (s && typeof s.stepCount === "number") {
        count = s.stepCount;
        updatePill();
      }
    }
  });

  /* Tier 2 of the API log. netpatch.js has to run in the page's MAIN world, which
   * a content script cannot reach, so the worker injects it — and it is asked for
   * per tab, on attach, so every tab that joins a recording gets it rather than
   * only the one Start was pressed in. The worker decides whether it is wanted;
   * asking is cheap and the answer is authoritative there.
   *
   * Asked once per attach rather than once per page: the answer depends on the
   * Tier 2 opt-in, which the user can change while the page is open. Re-asking is
   * safe because `netpatch.js` marks the window (`__ggNetPatched`) and returns
   * early rather than chaining a second patch onto the first. */
  function askNetPatch() {
    if (patchAsked) return;
    patchAsked = true;
    safeSend({ type: "fs_net_patch" });
  }

  /* The way back from the MAIN world, which has no chrome.* of its own. Nothing
   * here is trusted: the page shares this channel and can post the same shape, so
   * the worker only ever uses a body to annotate a request chrome.webRequest
   * independently saw. Dropped outright when no mode is running. */
  function onNetMessage(e) {
    if (e.source !== window || !e.data || e.data.source !== "gg_net_body") return;
    if (!mode()) return;
    // Re-shaped rather than forwarded: whatever posted this can put anything in
    // `req`, and the worker should not have to defend against an object of
    // arbitrary depth. Headers come across as pairs of strings, capped, and the
    // worker masks the values again on the way in.
    const d = e.data;
    let req = null;
    try {
      if (d.req && typeof d.req === "object") {
        req = {
          method: String(d.req.method || "").toUpperCase().slice(0, 12),
          headers: (Array.isArray(d.req.headers) ? d.req.headers : [])
            .slice(0, 40)
            .map((p) => [String((p && p[0]) || "").slice(0, 80), String((p && p[1]) || "").slice(0, 400)])
            .filter((p) => p[0]),
          body: String(d.req.body || ""),
        };
      }
    } catch (err) {
      req = null;
    }
    safeSend({
      type: "fs_net_body",
      url: String(d.url || ""),
      status: Number(d.status) || 0,
      body: String(d.body || ""),
      req,
    });
  }

  // ---- listeners ----
  function start(m) {
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    // Passive, and on the capture phase: a scroll container inside the page bubbles
    // nothing, so a listener on window alone misses every scrollable panel — which
    // on an admin dashboard is where the list actually is.
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("message", onNetMessage);
    askNetPatch();
    showPill(m);
  }
  function stop() {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("message", onNetMessage);
    // A pending burst must not fire after the listeners are gone: on an orphaned
    // context its send() would throw, and on a stopped recording it would append a
    // step to a guide the user has already been handed.
    if (typing) { clearTimeout(typing.timer); typing = null; }
    clearTimeout(scrollTimer);
    scrollWho = null;
    hidePill();
  }

  function isOurUI(el) {
    return el && el.closest && el.closest("[" + UI + "]");
  }

  function onPointerDown(e) {
    if (!mode() || e.button !== 0) return;
    if (!e.target || isOurUI(e.target)) return;
    /* A pending typing burst is flushed *first*, so the steps arrive in the order
       they happened. Steps are persisted in arrival order, so leaving it to the
       650ms timer would put `Type "Demo"` after `Click "Demo Restaurant"` — the guide
       reading as though the result was clicked before it was searched for. */
    if (typing) flushTyping();
    // attribute the click to the control, not the inner span that was hit
    const el = actionableTarget(e.target);
    if (!el) return;
    const now = Date.now();
    if (now - lastCaptureTs < 250) return; // debounce
    lastCaptureTs = now;
    const rect = el.getBoundingClientRect();
    send({
      type: "click",
      url: location.href,
      pageTitle: document.title,
      timestamp: now,
      dpr: window.devicePixelRatio || 1,
      point: { x: e.clientX, y: e.clientY },
      rect: clampRect(rect),
      text: describeClick(el, e.target),
    });
  }

  /* Typing, captured while it happens rather than when the field is left.
   *
   * `change` only fires on blur, and a search box is the case that breaks: you type,
   * the page fires a request per keystroke, you read the results and click one —
   * without ever blurring the field. So there was no step for the typing at all, and
   * because `attachNetwork` hangs a request on the step it followed, the search
   * requests had nothing to attach to and were dropped. The most interesting call on
   * the page was the one the log was missing.
   *
   * Two details make this work rather than just fire:
   *
   * - **Debounced to the settle**, so "Demo" is one step reading `Type "Demo"`, not
   *   four steps reading `Type "D"`. The screenshot is taken then too, which is when
   *   the field shows the whole value and the results are on screen.
   * - **Stamped with the *first* keystroke of the burst.** The requests happen while
   *   you type — before the settle — so a step stamped at the settle sits after its
   *   own consequences and `attachNetwork` gives them to the previous step instead.
   *   The timestamp anchors the step to when the typing began; the picture is still
   *   the one from the end. */
  const TYPE_SETTLE = 650;
  let typing = null; // { el, startTs, timer }

  function typeable(el) {
    if (!el || isOurUI(el)) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (el.isContentEditable) return true;
    if (tag !== "input" && tag !== "textarea") return false;
    const type = (el.type || "").toLowerCase();
    return !["button", "submit", "reset", "file", "hidden", "checkbox", "radio", "range", "color"].includes(type);
  }

  function onInput(e) {
    if (!mode() || !typeable(e.target)) return;
    const el = e.target;
    // A different field means the previous burst is over: flush it, or switching
    // fields quickly would merge two values into one step.
    if (typing && typing.el !== el) flushTyping();
    if (!typing) typing = { el, startTs: Date.now(), timer: null };
    clearTimeout(typing.timer);
    typing.timer = setTimeout(flushTyping, TYPE_SETTLE);
  }

  function flushTyping() {
    const t = typing;
    typing = null;
    if (!t) return;
    clearTimeout(t.timer);
    if (!mode() || !t.el || !t.el.isConnected) return;
    const el = t.el;
    const type = (el.type || "").toLowerCase();
    // The value is never recorded for a password — same rule as onChange, and the
    // one place it must not be relaxed for the sake of a better step description.
    let val = el.isContentEditable ? el.textContent : el.value;
    if (type === "password") val = "••••••••";
    if (!String(val || "").length) return;   // typed and cleared is not a step
    lastTyped = { el, val: String(val) };
    const rect = el.getBoundingClientRect();
    /* Deliberately does **not** touch `lastCaptureTs`. That is the 250ms guard
       against one click firing twice, and typing is not a click: setting it here
       swallowed the click that came straight after a search — you type, you click the
       result, and the click never became a step. */
    send({
      type: "input",
      url: location.href,
      pageTitle: document.title,
      timestamp: t.startTs,
      dpr: window.devicePixelRatio || 1,
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      rect: clampRect(rect),
      text: describeInput(el, val),
    });
  }

  /* Scrolling, which used to be invisible.
   *
   * On its own a scroll is not much of an instruction — but an infinite list loads
   * its next page on scroll, and with no step there, those requests belonged to
   * nothing and were dropped exactly as the search ones were. It is also genuinely
   * part of a long flow: "the button is further down" is a step a reader needs.
   *
   * Deliberately stingy: one step per settle, and only when the page has moved more
   * than half a viewport since the last one it recorded. A step per wheel tick would
   * bury the guide and spend the capture rate limit on nothing. */
  const SCROLL_SETTLE = 500;
  const SCROLL_GAP_MS = 1200;
  let scrollTimer = null;
  let lastScrollTs = 0;

  /* Where each scroller was when it last produced a step.
   *
   * A WeakMap keyed by the element, with `window` as the key for the page itself,
   * because a page has more than one scroller and they move independently. This
   * replaced a single `lastScrollY` that only ever tracked the window — see the bug
   * note on flushScroll. Weak so a panel removed from the DOM takes its entry with it. */
  const scrollAt = new WeakMap();

  /* The element that scrolled, or null meaning the page.
   *
   * A scroll event's target is the Document when the page scrolls and the element
   * when a container does; document.body / documentElement can also arrive here
   * depending on the engine, and all three mean the same thing. */
  function scrollerOf(e) {
    const t = e && e.target;
    if (!t || t.nodeType !== 1) return null;
    if (t === document.documentElement || t === document.body) return null;
    return t;
  }
  function offsetOf(el) {
    if (el) return el.scrollTop || 0;
    return window.scrollY || (document.documentElement || {}).scrollTop || 0;
  }
  function viewportOf(el) {
    return (el ? el.clientHeight : window.innerHeight) || 0;
  }
  function atEndOf(el) {
    if (el) return el.scrollTop + el.clientHeight >= (el.scrollHeight || 0) - 4;
    const doc = document.documentElement || {};
    return offsetOf(null) + window.innerHeight >= (doc.scrollHeight || 0) - 4;
  }

  // Which scroller the pending flush is about. Set on the event, read after the
  // settle — the event object is long gone by then.
  let scrollWho = null;

  function onScroll(e) {
    if (!mode()) return;
    scrollWho = scrollerOf(e);
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(flushScroll, SCROLL_SETTLE);
  }

  /* BUG, fixed 27 Aug 2026. This measured `window.scrollY` and nothing else, while
     onScroll is attached with `capture: true` precisely so that scrolling *inside* a
     container is seen — the two disagreed. On any page whose content scrolls in a div
     rather than the document, every scroll event was caught and then thrown away: the
     window never moved, so `moved` was always 0 and no step was ever recorded. Found
     on uengage.io, and it was never catch-up specific — an ordinary recording lost
     them the same way. Measure whatever actually scrolled. */
  function flushScroll() {
    if (!mode()) return;
    // Typing that moves the page (a field scrolling into view) is not a scroll step;
    // the typing step is the one that means something.
    if (typing) return;
    const el = scrollWho;
    // A panel can be gone by the time the settle fires — a virtualised list replaces
    // its scroller, and measuring a detached node reads zeros that look like a scroll
    // back to the top.
    if (el && !el.isConnected) { scrollWho = null; return; }
    const key = el || window;
    const y = offsetOf(el);
    const last = scrollAt.has(key) ? scrollAt.get(key) : 0;
    const moved = Math.abs(y - last);
    const now = Date.now();
    // Half of whatever actually scrolled, not half the window. The 240px floor is the
    // same anti-noise floor as before, so a short panel needs most of its own height
    // before it counts — deliberately conservative.
    if (moved < Math.max(240, viewportOf(el) * 0.5)) return;
    if (now - lastScrollTs < SCROLL_GAP_MS || now - lastCaptureTs < 400) return;
    const down = y > last;
    scrollAt.set(key, y);
    lastScrollTs = now;
    lastCaptureTs = now;
    const atEnd = atEndOf(el);
    send({
      // No point and no rect: nothing was clicked, so render.js draws the screenshot
      // unannotated, exactly as it does for a tab switch.
      type: "scroll",
      url: location.href,
      pageTitle: document.title,
      timestamp: now,
      dpr: window.devicePixelRatio || 1,
      // "the page" is wrong for a panel, and a step that misdescribes what happened is
      // worse than a terse one.
      text: el
        ? (atEnd ? "Scroll to the bottom of the panel" : down ? "Scroll down in the panel" : "Scroll up in the panel")
        : (atEnd ? "Scroll to the bottom of the page" : down ? "Scroll down the page" : "Scroll up the page"),
    });
  }

  // Set by flushTyping so onChange can tell whether the value it is looking at has
  // already been recorded — otherwise blurring a field after typing writes the step
  // twice.
  let lastTyped = null;

  function onChange(e) {
    if (!mode()) return;
    const el = e.target;
    if (!el || isOurUI(el)) return;
    const tag = (el.tagName || "").toLowerCase();
    if (!["input", "textarea", "select"].includes(tag)) return;
    const type = (el.type || "").toLowerCase();
    if (["button", "submit", "reset", "file", "hidden"].includes(type)) return;
    // The typing path has usually already recorded this. A select, a checkbox and a
    // date picker never go through it, so change is still the only event for those.
    if (typing && typing.el === el) flushTyping();
    if (lastTyped && lastTyped.el === el && lastTyped.val === String(el.value)) return;
    let val = el.value;
    if (type === "password") val = "••••••••";
    if (type === "checkbox" || type === "radio")
      val = el.checked ? "checked" : "unchecked";
    if (tag === "select" && el.selectedIndex >= 0)
      val = el.options[el.selectedIndex].text;
    const rect = el.getBoundingClientRect();
    send({
      type: "input",
      url: location.href,
      pageTitle: document.title,
      timestamp: Date.now(),
      dpr: window.devicePixelRatio || 1,
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      rect: clampRect(rect),
      text: describeInput(el, val),
    });
  }

  // Enter is often the action that actually does the thing — submitting a search
  // or a form. Without this the guide jumps from "type" straight to the results
  // with no step explaining what happened.
  function onKeyDown(e) {
    if (!mode() || e.repeat) return;
    const el = e.target;
    if (!el || isOurUI(el)) return;

    const tag = (el.tagName || "").toLowerCase();
    const isField = tag === "input" || tag === "select" || el.isContentEditable;
    const mod = e.metaKey || e.ctrlKey;
    let text = null;

    if (e.key === "Enter" && !e.altKey && !mod) {
      if (tag === "textarea") return;            // a newline, not a submit
      if (!isField) return;                     // a button's Enter is its click
      text = "Press Enter";
    } else if (e.key === "Escape") {
      /* Escape closes the dialog, clears the search, cancels the edit. Without it a
         guide jumps from a form to the list behind it with nothing explaining how it
         was dismissed — and a page that reloads its list on cancel had those
         requests belonging to no step. */
      text = "Press Escape";
    } else if (mod && e.key && e.key.length === 1) {
      /* A keyboard shortcut is an action, and on the apps worth documenting it is
         often *the* action — ⌘K opens the command palette, ⌘S saves. Single
         characters only: a bare modifier, or Ctrl held while scrolling, is not one. */
      const parts = [];
      if (e.metaKey) parts.push("⌘");
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      text = "Press " + parts.join("+") + (parts.length ? "+" : "") + e.key.toUpperCase();
    } else {
      return;
    }

    /* Flushed *here*, not at the top of this handler, and that placement is the whole
       bug this fixed. Every character of a typing burst is a `keydown` too, so
       flushing before knowing whether this key becomes a step ended the burst on the
       next keystroke — typing "demo" produced four steps reading `Type "d"`,
       `Type "de"`, `Type "dem"`, `Type "demo"`, one per letter, with the 650ms
       debounce never getting a chance to settle. By this line the key is known to be
       Enter, Escape or a shortcut, and flushing is what keeps "Type X" ahead of
       "Press Enter" — which is the reason a flush is here at all. */
    if (typing) flushTyping();

    const now = Date.now();
    if (now - lastCaptureTs < 250) return;
    lastCaptureTs = now;
    // A shortcut is usually pressed with nothing focused, and the body's rect is the
    // whole page — which would draw a ring around the entire screenshot. No rect
    // means an unannotated capture, which is the honest picture for a keypress.
    const rect = isField && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    send({
      type: "key",
      url: location.href,
      pageTitle: document.title,
      timestamp: now,
      dpr: window.devicePixelRatio || 1,
      point: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined,
      rect: rect ? clampRect(rect) : undefined,
      text,
    });
  }

  function clampRect(r) {
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    return {
      x,
      y,
      w: Math.min(r.width, window.innerWidth - x),
      h: Math.min(r.height, window.innerHeight - y),
    };
  }

  /* Reloading the extension orphans the copy of this script already running in every
   * open page: the code stays, its `chrome.runtime` handle dies, and the next
   * sendMessage throws "Extension context invalidated" synchronously. Chrome does not
   * inject the new version into existing tabs, so that page can never record again.
   *
   * Unhandled, every click threw while the pill sat there claiming to record. So the
   * orphan is detected and retires itself — listeners off, pill gone. Reloading the
   * page brings the current recorder back; nothing here can do that for the user.
   *
   * `chrome.runtime.id` is the cheap test: it is undefined once the context is gone. */
  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }
  function retire() {
    if (orphaned) return;
    orphaned = true;
    recording = false;
    buffering = false;
    attached = null;
    try { stop(); } catch (e) { /* the page is being torn down */ }
  }

  /* Every chrome call after load goes through this, and the reason is the callback,
   * not the call. A `try` around `sendMessage` exits before its reply arrives, so a
   * `catch` beside it cannot see anything the callback throws — and the callback is
   * where the context most often dies, because the gap between asking the worker
   * something and hearing back is exactly when someone hits reload on the
   * extensions page. Reading `chrome.runtime.lastError` in that state throws on the
   * `chrome.runtime` lookup itself, which is how "Extension context invalidated"
   * reaches the Errors pane instead of being swallowed.
   *
   * So: guard before, guard around, and guard *inside*. `cb` gets the response only
   * when there is still a runtime to have produced it. */
  function safeSend(msg, cb) {
    if (orphaned) return;
    if (!alive()) return retire();
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (!alive()) return retire();
        try {
          if (chrome.runtime.lastError) return;
          if (cb) cb(resp);
        } catch (err) {
          retire();
        }
      });
    } catch (e) {
      retire();
    }
  }

  function send(step) {
    if (orphaned) return;
    const m = mode();
    if (!m) return;
    if (!alive()) return retire();
    /* Buffering only: a screenshot of a login screen is the one frame most worth
     * not keeping, and unlike a recording the user never asked for this one. The
     * step's words are safe either way — a typed value is never recorded. */
    if (m === "buf" && passwordFocused()) step.noShot = true;
    // Hide our pill so it never lands in the screenshot. Restored on the way out of
    // every path, including the orphaned one — a hidden pill that never comes back
    // looks like the recorder died silently.
    if (pill) pill.style.visibility = "hidden";
    safeSend(
      { type: m === "rec" ? "fs_capture_step" : "fs_buffer_step", step },
      (resp) => {
        if (pill) pill.style.visibility = "visible";
        if (resp && resp.ok) {
          // Recording counts its own steps; buffering does not, for the reason in the
          // fs_buf_changed note above. bufWrite() broadcasts one, and askBuffer()
          // answers it with a number that is actually about this site.
          if (m === "rec") count = resp.count;
          updatePill();
          flash();
        }
      }
    );
    if (orphaned && pill) pill.style.visibility = "visible";
  }

  function passwordFocused() {
    const a = document.activeElement;
    return !!(a && a.tagName === "INPUT" && a.type === "password");
  }

  // ---- label / description helpers ----

  // The control the user meant, not the <span> they happened to hit. Clicking
  // the text inside a button should be attributed to the button.
  const ACTIONABLE =
    'a,button,input,select,textarea,label,summary,[role=button],[role=link],' +
    '[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=radio],[onclick],[tabindex]';
  function actionableTarget(el) {
    if (!el || !el.closest) return el;
    const hit = el.closest(ACTIONABLE);
    if (!hit) return el;
    // Don't climb so far that we land on a whole card/row and pick up its text.
    return hit;
  }

  function tidy(s, max) {
    let t = String(s || "").replace(/\s+/g, " ").trim();
    // a control's own text, not its container's paragraph
    if (t.length > (max || 48)) t = t.slice(0, (max || 48) - 1).trim() + "…";
    return t.replace(/[:•·]+$/, "").trim();
  }

  // Text belonging to the control itself, ignoring nested block content that
  // makes labels like "Child Id : 12364 Restaurant Demo IT PARK, Chandigarh".
  function ownText(el) {
    const raw = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (!raw) return "";
    const firstLine = (el.innerText || "").split("\n").map((x) => x.trim()).filter(Boolean)[0];
    return firstLine && firstLine.length <= raw.length ? firstLine : raw;
  }

  function labelOf(el) {
    if (!el || !el.getAttribute) return "";
    const aria = el.getAttribute("aria-label");
    if (aria) return tidy(aria);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const n = document.getElementById(lb);
      if (n) return tidy(n.textContent);
    }
    if (el.id) {
      try {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) return tidy(lab.textContent);
      } catch (e) {}
    }
    const tag = (el.tagName || "").toLowerCase();
    // For fields the placeholder names the field; its value is the user's data.
    if (tag === "input" || tag === "textarea") {
      const ph = el.getAttribute("placeholder");
      if (ph) return tidy(ph);
      const closest = el.closest && el.closest("label");
      if (closest) return tidy(closest.textContent);
    }
    const txt = ownText(el);
    if (txt) return tidy(txt);
    const ph = el.getAttribute("placeholder");
    if (ph) return tidy(ph);
    const alt = el.getAttribute("alt");
    if (alt) return tidy(alt);
    const title = el.getAttribute("title");
    if (title) return tidy(title);
    const val = el.getAttribute("value");
    if (val) return tidy(val);
    const name = el.getAttribute("name");
    if (name) return tidy(name);
    return "";
  }

  function friendlyType(el) {
    const tag = (el.tagName || "").toLowerCase();
    const role = el.getAttribute && el.getAttribute("role");
    const type = (el.type || "").toLowerCase();
    if (tag === "a" || role === "link") return "link";
    if (tag === "button" || role === "button" || type === "submit" || type === "button")
      return "button";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio button";
      return "field";
    }
    if (tag === "select") return "dropdown";
    if (tag === "textarea") return "text area";
    if (tag === "img") return "image";
    if (role === "menuitem") return "menu item";
    if (role === "tab") return "tab";
    return "element";
  }

  // Wording conventions (kept deliberately close to how a person would write it):
  //   Click "Rider Management"                     — buttons, links, rows, tabs
  //   Click the "Search by name" field             — fields, where clicking ≠ acting
  //   Type "Demo" in the "Search by name" field    — text entry
  //   Select "Chandigarh" from the "City" dropdown — selects
  //   Check / Uncheck "Send me updates"            — checkboxes
  // No "element", no "the ... element", no restating the role when the label
  // already says it.
  const NAMES_ITS_ROLE = /\b(button|link|tab|field|box|menu|icon|dropdown)\s*$/i;

  function describeClick(el, raw) {
    let label = labelOf(el);
    // Cards and table rows are one big clickable block: their combined text
    // reads "Child Id : 12364 Restaurant Demo IT PARK, Chandigarh". The words
    // under the pointer name the thing; the whole block doesn't.
    if (raw && raw !== el && (!label || label.length > 40)) {
      const inner = tidy(ownText(raw));
      if (inner && inner.length >= 2 && (!label || inner.length < label.length)) label = inner;
    }
    const ft = friendlyType(el);
    if (!label) return `Click the ${ft}`;
    if (ft === "field" || ft === "text area") return `Click the "${label}" ${ft}`;
    if (ft === "checkbox" || ft === "radio button") return `Click "${label}"`;
    // "Click "Save" button" is redundant when the label already reads as one
    if (NAMES_ITS_ROLE.test(label)) return `Click "${label}"`;
    if (ft === "element") return `Click "${label}"`;
    return `Click "${label}"`;
  }

  function describeInput(el, val) {
    const label = labelOf(el);
    const ft = friendlyType(el);
    const type = (el.type || "").toLowerCase();
    const shown = tidy(val, 40);
    if (ft === "checkbox") return (el.checked ? "Check " : "Uncheck ") + `"${label || "the checkbox"}"`;
    if (ft === "radio button") return `Select "${label || shown}"`;
    if (ft === "dropdown")
      return `Select "${shown}"` + (label ? ` from the "${label}" dropdown` : "");
    if (type === "password")
      return label ? `Type your password in the "${label}" field` : "Type your password";
    if (!label) return `Type "${shown}"`;
    return `Type "${shown}" in the "${label}" ${ft === "text area" ? "text area" : "field"}`;
  }

  // ---- pill UI ----
  /* Two very different things, one element.
   *
   * **Recording** is a full pill: red dot, live step count, "Stop & edit". It is a
   * status, because there is something running that the user started and can end.
   *
   * **Catch-up** is a bare dot, and deliberately not a button. The full pill said
   * "something is being written down", which while buffering is false in the other
   * direction — nothing is being written to any guide and there is nothing to
   * stop. It is disclosure, not a status: it exists so an always-on capture is
   * never invisible, and it says what it is on hover and nothing the rest of the
   * time. Redeeming lives in the popup, which is one deliberate place to turn
   * minutes into a guide rather than a button sitting on every page. */
  function showPill(m) {
    if (pill) return;
    const buf = m === "buf";
    pill = document.createElement("div");
    pill.setAttribute(UI, "1");
    pill.className = "flowscribe-pill" + (buf ? " fs-buf" : "");
    if (buf) {
      /* The dot expands on hover into the status *and* the action, because the
       * action is the whole feature: the moment someone wants the last two minutes
       * is the moment they are still looking at the page, and making them go to the
       * toolbar first is a detour away from the thing they just did.
       *
       * This is not the button that was rejected in v1.2. That one said "Make a
       * guide" of the entire buffer, on a pill that claimed to be recording — a
       * wrong action under a false status. The dot still says nothing until hovered,
       * still admits it is only *holding* steps, and the action is now the slice. */
      pill.innerHTML =
        '<span class="fs-dot"></span>' +
        '<span class="fs-count">Catch-up on — <b>0</b> steps held</span>' +
        '<button class="fs-cap" ' + UI + '="1">Capture last 2 min</button>';
      // Native tooltip as well as the hover expansion, since a host page can
      // suppress transitions and this must stay explainable if it does.
      pill.setAttribute("title", "GuideGen catch-up capture is on for this site. Hover to capture the last 2 minutes.");
    } else {
      pill.innerHTML =
        '<span class="fs-dot"></span>' +
        '<span class="fs-count">Recording — <b>0</b> steps</span>' +
        '<button class="fs-stop" ' + UI + '="1">Stop &amp; edit</button>';
    }
    (document.body || document.documentElement).appendChild(pill);

    const cap = buf ? pill.querySelector(".fs-cap") : null;
    if (cap)
      cap.addEventListener(
        "click",
        (e) => {
          e.stopPropagation();
          e.preventDefault();
          /* A synthetic click is not a request. This button lives in the page's own
           * DOM, so `document.querySelector(...).click()` from a page script would
           * otherwise mint a guide out of the buffer without the user doing
           * anything — quiet, and exactly the thing an always-on buffer must not
           * allow. Only a real pointer redeems. */
          if (!e.isTrusted) return;
          if (cap.disabled) return;
          cap.disabled = true;
          const was = cap.textContent;
          cap.textContent = "Capturing…";
          // Same nested-orphan shape as Stop: the second call runs inside the
          // first's reply, long after any try out here has returned.
          safeSend({ type: "fs_buf_capture" }, (resp) => {
            if (resp && resp.ok && resp.guideId) {
              cap.textContent = "Opening…";
              safeSend({ type: "fs_open_editor", guideId: resp.guideId });
              setTimeout(() => {
                if (!cap.isConnected) return;
                cap.disabled = false;
                cap.textContent = was;
              }, 1200);
              return;
            }
            // Nothing held yet is the ordinary failure — say so on the button
            // rather than in an alert, and let it recover.
            cap.textContent = (resp && resp.error) ? "Nothing held yet" : "Couldn't capture";
            setTimeout(() => {
              if (!cap.isConnected) return;
              cap.disabled = false;
              cap.textContent = was;
            }, 1800);
          });
        },
        true
      );

    const stop = buf ? null : pill.querySelector(".fs-stop");
    if (stop)
      stop.addEventListener(
        "click",
        (e) => {
          e.stopPropagation();
          e.preventDefault();
          // Same orphan case as send(): a stale pill's button would throw rather than
          // do anything, so retire instead and take the pill away with it. The nested
          // call needs its own guard — it runs in the reply, long after any try block
          // out here has returned.
          safeSend({ type: "fs_stop" }, (resp) => {
            if (resp && resp.guideId)
              safeSend({ type: "fs_open_editor", guideId: resp.guideId });
          });
        },
        true
      );
    updatePill();
  }
  function hidePill() {
    if (pill) {
      pill.remove();
      pill = null;
    }
  }
  function updatePill() {
    if (pill) {
      const b = pill.querySelector(".fs-count b");
      if (b) b.textContent = mode() === "buf" ? bufCount : count;
    }
  }
  function flash() {
    if (!pill) return;
    pill.classList.add("fs-flash");
    setTimeout(() => pill && pill.classList.remove("fs-flash"), 220);
  }
})();
