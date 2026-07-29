// FlowScribe — content-script recorder.
// Captures clicks and form input while recording, and shows a floating pill.
(() => {
  if (window.__flowscribeLoaded) return;
  window.__flowscribeLoaded = true;

  const UI = "data-flowscribe-ui";
  let recording = false;
  let count = 0;
  let pill = null;
  let lastCaptureTs = 0;

  // Initial state
  chrome.storage.local.get("fs_state", (r) => {
    const s = r.fs_state;
    if (s && s.recording) {
      recording = true;
      count = s.stepCount || 0;
      start();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "fs_recording_changed") {
      if (msg.recording && !recording) {
        recording = true;
        count = 0;
        start();
      } else if (!msg.recording && recording) {
        recording = false;
        stop();
      }
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

  // ---- listeners ----
  function start() {
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("keydown", onKeyDown, true);
    showPill();
  }
  function stop() {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("change", onChange, true);
    document.removeEventListener("keydown", onKeyDown, true);
    hidePill();
  }

  function isOurUI(el) {
    return el && el.closest && el.closest("[" + UI + "]");
  }

  function onPointerDown(e) {
    if (!recording || e.button !== 0) return;
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
    if (!recording) return;
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
    if (!recording || e.key !== "Enter" || e.repeat) return;
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

  function send(step) {
    // Hide our pill so it never lands in the screenshot.
    if (pill) pill.style.visibility = "hidden";
    chrome.runtime.sendMessage({ type: "fs_capture_step", step }, (resp) => {
      if (pill) pill.style.visibility = "visible";
      if (chrome.runtime.lastError) return;
      if (resp && resp.ok) {
        count = resp.count;
        updatePill();
        flash();
      }
    });
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
  function showPill() {
    if (pill) return;
    pill = document.createElement("div");
    pill.setAttribute(UI, "1");
    pill.className = "flowscribe-pill";
    pill.innerHTML =
      '<span class="fs-dot"></span>' +
      '<span class="fs-count">Recording — <b>0</b> steps</span>' +
      '<button class="fs-stop" ' + UI + '="1">Stop &amp; edit</button>';
    (document.body || document.documentElement).appendChild(pill);
    pill.querySelector(".fs-stop").addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        e.preventDefault();
        chrome.runtime.sendMessage({ type: "fs_stop" }, (resp) => {
          if (resp && resp.guideId)
            chrome.runtime.sendMessage({
              type: "fs_open_editor",
              guideId: resp.guideId,
            });
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
      if (b) b.textContent = count;
    }
  }
  function flash() {
    if (!pill) return;
    pill.classList.add("fs-flash");
    setTimeout(() => pill && pill.classList.remove("fs-flash"), 220);
  }
})();
