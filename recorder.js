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

  // Attach, detach or switch, whichever the current mode calls for. Called after
  // every state change rather than each caller deciding — recording starting while
  // an origin is armed has to swap the pill, not stack two of them.
  function sync() {
    const m = mode();
    if (m === attached) { updatePill(); return; }
    if (attached) stop();
    attached = m;
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
      if (typeof msg.count === "number") bufCount = msg.count;
      askBuffer();
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
   * Requested once per page. A second injection would chain a second patch onto
   * the first and report every failure twice. */
  let patchAsked = false;
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
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("message", onNetMessage);
    askNetPatch();
    showPill(m);
  }
  function stop() {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("message", onNetMessage);
    hidePill();
  }

  function isOurUI(el) {
    return el && el.closest && el.closest("[" + UI + "]");
  }

  function onPointerDown(e) {
    if (!mode() || e.button !== 0) return;
    if (!e.target || isOurUI(e.target)) return;
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

  function onChange(e) {
    if (!mode()) return;
    const el = e.target;
    if (!el || isOurUI(el)) return;
    const tag = (el.tagName || "").toLowerCase();
    if (!["input", "textarea", "select"].includes(tag)) return;
    const type = (el.type || "").toLowerCase();
    if (["button", "submit", "reset", "file", "hidden"].includes(type)) return;
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
    if (!mode() || e.key !== "Enter" || e.repeat) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target;
    if (!el || isOurUI(el)) return;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "textarea") return; // a newline, not a submit
    const isField = tag === "input" || tag === "select" || el.isContentEditable;
    if (!isField) return;
    const now = Date.now();
    if (now - lastCaptureTs < 250) return;
    lastCaptureTs = now;
    const rect = el.getBoundingClientRect();
    send({
      type: "key",
      url: location.href,
      pageTitle: document.title,
      timestamp: now,
      dpr: window.devicePixelRatio || 1,
      point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      rect: clampRect(rect),
      text: "Press Enter",
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
          if (m === "rec") count = resp.count;
          else bufCount = resp.count;
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
      pill.innerHTML =
        '<span class="fs-dot"></span>' +
        '<span class="fs-count">Catch-up on — <b>0</b> steps held</span>';
      // Native tooltip as well as the hover expansion, since a host page can
      // suppress transitions and this must stay explainable if it does.
      pill.setAttribute("title", "GuideGen catch-up capture is on for this site. Open GuideGen to capture the last 2 minutes.");
    } else {
      pill.innerHTML =
        '<span class="fs-dot"></span>' +
        '<span class="fs-count">Recording — <b>0</b> steps</span>' +
        '<button class="fs-stop" ' + UI + '="1">Stop &amp; edit</button>';
    }
    (document.body || document.documentElement).appendChild(pill);
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
