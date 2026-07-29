// GuideGen — guide editor
(function () {
  const K = {
    index: "fs_index",
    order: (g) => `fs_steporder_${g}`,
    step: (id) => `fs_step_${id}`,
  };
  const store = {
    get: (k, d) =>
      new Promise((r) => chrome.storage.local.get(k, (o) => r(k in o ? o[k] : d))),
    getMany: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
    set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
    remove: (keys) => new Promise((r) => chrome.storage.local.remove(keys, r)),
  };

  let index = [];
  let currentId = null;
  let steps = []; // array of step objects, in order
  let filter = "";

  const els = {
    list: document.getElementById("guideList"),
    search: document.getElementById("guideSearch"),
    count: document.getElementById("guideCount"),
    title: document.getElementById("guideTitle"),
    submeta: document.getElementById("submeta"),
    content: document.getElementById("content"),
    exportBtn: document.getElementById("exportBtn"),
    exportMenu: document.getElementById("exportMenu"),
    deleteGuide: document.getElementById("deleteGuide"),
    addNote: document.getElementById("addNote"),
    toast: document.getElementById("toast"),
    overlay: document.getElementById("overlay"),
    modal: document.getElementById("modal"),
  };

  // ---------- icons ----------
  const ICON = {
    grip: '<path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"/>',
    up: '<path d="M12 19V5m0 0-6 6m6-6 6 6"/>',
    down: '<path d="M12 5v14m0 0 6-6m-6 6-6-6"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
    redact: '<rect x="4" y="7" width="16" height="11" rx="2"/><path d="M8 12h8"/>',
    check: '<path d="m5 13 4 4L19 7"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 12h18"/>',
  };
  function svg(path, size) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
      (size ? ' style="width:' + size + "px;height:" + size + 'px"' : "") +
      ">" + path + "</svg>"
    );
  }

  // ---------- data ----------
  async function loadIndex() {
    index = await store.get(K.index, []);
  }

  async function loadGuide(id) {
    currentId = id;
    steps = [];
    if (!id) return;
    const order = await store.get(K.order(id), []);
    if (!order.length) return;
    const keys = order.map((sid) => K.step(sid));
    const map = await store.getMany(keys);
    steps = order.map((sid) => map[K.step(sid)]).filter(Boolean);
  }

  async function saveOrder() {
    await store.set({ [K.order(currentId)]: steps.map((s) => s.id) });
  }
  async function saveStep(step) {
    await store.set({ [K.step(step.id)]: step });
  }
  async function updateIndexMeta() {
    const gi = index.find((g) => g.id === currentId);
    if (gi) {
      gi.stepCount = steps.length;
      await store.set({ [K.index]: index });
    }
  }

  // ---------- rendering ----------
  function fmtDate(ts) {
    try {
      const d = new Date(ts);
      const days = Math.floor((Date.now() - ts) / 86400000);
      if (days === 0) return "Today, " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      if (days === 1) return "Yesterday";
      if (days < 7) return days + " days ago";
      return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
    } catch (e) {
      return "";
    }
  }

  function visibleGuides() {
    const q = filter.trim().toLowerCase();
    if (!q) return index;
    return index.filter((g) => (g.title || "").toLowerCase().indexOf(q) !== -1);
  }

  function renderSidebar() {
    const list = visibleGuides();
    els.count.textContent = index.length ? index.length : "";
    els.list.innerHTML = "";
    if (!index.length) {
      els.list.innerHTML =
        '<div class="empty">No guides yet. Click the GuideGen icon and press <b>Start recording</b>.</div>';
      return;
    }
    if (!list.length) {
      els.list.innerHTML = '<div class="empty">No guides match “' + escapeHtml(filter) + '”.</div>';
      return;
    }
    list.forEach((g) => {
      const d = document.createElement("div");
      d.className = "guide-item" + (g.id === currentId ? " active" : "");
      d.innerHTML =
        '<div class="t"></div><div class="m">' +
        (g.stepCount || 0) + (g.stepCount === 1 ? " step · " : " steps · ") +
        fmtDate(g.createdAt) + "</div>";
      d.querySelector(".t").textContent = g.title || "Untitled guide";
      d.addEventListener("click", () => selectGuide(g.id));
      els.list.appendChild(d);
    });
  }

  async function renderMain() {
    const gi = index.find((g) => g.id === currentId);
    if (!currentId || !gi) {
      els.title.value = "";
      els.title.disabled = true;
      els.submeta.textContent = "";
      setActionsEnabled(false);
      els.content.innerHTML =
        '<div class="no-guides-main">' +
        '<span class="big">' + svg(ICON.film, 22) + "</span>" +
        "<h2>No guide selected</h2>" +
        "<p>Pick a guide on the left, or record a new one from the GuideGen toolbar icon.</p>" +
        "</div>";
      return;
    }
    els.title.disabled = false;
    els.title.value = gi.title || "";
    setActionsEnabled(true);

    els.submeta.innerHTML = "";
    const bits = [steps.length + (steps.length === 1 ? " step" : " steps"), fmtDate(gi.createdAt)];
    bits.forEach((b, i) => {
      if (i) els.submeta.appendChild(mkEl("span", "dot"));
      const s = mkEl("span");
      s.textContent = b;
      els.submeta.appendChild(s);
    });
    if (gi.startUrl) {
      els.submeta.appendChild(mkEl("span", "dot"));
      const s = mkEl("span", "src");
      s.textContent = shortUrl(gi.startUrl);
      s.title = gi.startUrl;
      els.submeta.appendChild(s);
    }

    els.content.innerHTML = "";
    if (!steps.length) {
      els.content.innerHTML =
        '<div class="no-guides-main"><h2>This guide has no steps</h2>' +
        "<p>Record again, or add a note to start writing it by hand.</p></div>";
      return;
    }
    for (let i = 0; i < steps.length; i++) {
      const card = await renderStepCard(steps[i], i);
      els.content.appendChild(card);
      // size the textarea only once it's laid out in the document
      const ta = card.querySelector("textarea");
      if (ta) autoGrow(ta);
    }
  }

  function setActionsEnabled(on) {
    [els.addNote, els.exportBtn, els.deleteGuide].forEach((b) => {
      if (on) b.removeAttribute("disabled");
      else b.setAttribute("disabled", "");
    });
  }

  async function renderStepCard(step, i) {
    const card = document.createElement("div");
    card.className = "step" + (step.type === "note" ? " is-note" : "");
    card.dataset.i = String(i);

    const gutter = mkEl("div", "gutter");
    const num = mkEl("div", "num");
    num.textContent = String(i + 1);
    gutter.appendChild(num);
    const grip = mkEl("div", "grip");
    grip.innerHTML = svg(ICON.grip);
    grip.title = "Drag to reorder";
    grip.draggable = true;
    gutter.appendChild(grip);
    card.appendChild(gutter);
    wireDrag(card, grip, i);

    const content = mkEl("div", "content");
    card.appendChild(content);

    if (step.type === "note") {
      const badge = mkEl("div", "note-badge");
      badge.textContent = "Note";
      content.appendChild(badge);
    }

    const ta = document.createElement("textarea");
    ta.value = step.text || "";
    ta.rows = 1;
    ta.spellcheck = true;
    ta.setAttribute("aria-label", "Step " + (i + 1) + " description");
    content.appendChild(ta);
    // NB: autoGrow is called by renderMain *after* the card is in the document.
    // Doing it here races the `await renderStep()` below — the callback fires
    // while the card is still detached, scrollHeight reads 0, and the step text
    // collapses to nothing.
    ta.addEventListener("input", () => {
      autoGrow(ta);
      step.text = ta.value;
      debounceSave(step);
    });

    if (step.screenshot) {
      const shot = mkEl("div", "shot");
      const canvas = await window.FSRender.renderStep(
        Object.assign({}, step, { seq: i + 1 })
      );
      if (canvas) shot.appendChild(canvas);
      const sel = mkEl("div", "sel");
      shot.appendChild(sel);
      content.appendChild(shot);
      wireRedaction(shot, canvas, sel, step, i);
    }

    const tools = mkEl("div", "rowtools");
    tools.appendChild(iconBtn(ICON.up, "Move up", () => move(i, -1), i === 0));
    tools.appendChild(iconBtn(ICON.down, "Move down", () => move(i, 1), i === steps.length - 1));

    if (step.screenshot) {
      const redactBtn = mkBtn("Redact", ICON.redact);
      redactBtn.classList.add("sm");
      redactBtn.addEventListener("click", () => {
        const shot = card.querySelector(".shot");
        const on = shot.classList.toggle("redacting");
        redactBtn.innerHTML = (on ? svg(ICON.check) : svg(ICON.redact)) +
          (on ? "Done" : "Redact");
        redactBtn.classList.toggle("brand", on);
      });
      tools.appendChild(redactBtn);
      if ((step.blurs || []).length) {
        const clear = mkBtn("Clear " + step.blurs.length, ICON.undo);
        clear.classList.add("sm");
        clear.title = "Remove all redactions on this step";
        clear.addEventListener("click", async () => {
          step.blurs = [];
          await saveStep(step);
          selectGuide(currentId);
          toast("Redactions cleared");
        });
        tools.appendChild(clear);
      }
    }

    tools.appendChild(mkEl("div", "spacer"));
    const del = iconBtn(ICON.trash, "Delete step", () => removeStep(i));
    del.classList.add("danger");
    tools.appendChild(del);
    content.appendChild(tools);

    return card;
  }

  // ---------- drag to reorder ----------
  let dragFrom = null;
  function wireDrag(card, grip, i) {
    grip.addEventListener("dragstart", (e) => {
      dragFrom = i;
      card.classList.add("dragging");
      try {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
        e.dataTransfer.setDragImage(card, 20, 20);
      } catch (err) {}
    });
    grip.addEventListener("dragend", () => {
      dragFrom = null;
      card.classList.remove("dragging");
      clearDropHints();
    });
    card.addEventListener("dragover", (e) => {
      if (dragFrom == null || dragFrom === i) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      clearDropHints();
      card.classList.add(after ? "drop-after" : "drop-before");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-before", "drop-after"));
    card.addEventListener("drop", async (e) => {
      if (dragFrom == null) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      let to = i + (after ? 1 : 0);
      const from = dragFrom;
      dragFrom = null;
      clearDropHints();
      if (to > from) to -= 1;
      if (to === from) return;
      const [moved] = steps.splice(from, 1);
      steps.splice(to, 0, moved);
      await saveOrder();
      await renderMain();
    });
  }
  function clearDropHints() {
    els.content.querySelectorAll(".step").forEach((s) =>
      s.classList.remove("drop-before", "drop-after")
    );
  }

  // ---------- redaction (coordinate math unchanged) ----------
  function wireRedaction(shot, canvas, sel, step, i) {
    if (!canvas) return;
    let dragging = false;
    let startX = 0, startY = 0;

    function toCanvasPx(e) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
        dispX: e.clientX - rect.left,
        dispY: e.clientY - rect.top,
      };
    }

    shot.addEventListener("mousedown", (e) => {
      if (!shot.classList.contains("redacting")) return;
      e.preventDefault();
      dragging = true;
      const p = toCanvasPx(e);
      startX = p.dispX; startY = p.dispY;
      sel.style.display = "block";
      sel.style.left = startX + "px";
      sel.style.top = startY + "px";
      sel.style.width = "0px";
      sel.style.height = "0px";
    });
    shot.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const p = toCanvasPx(e);
      const x = Math.min(startX, p.dispX);
      const y = Math.min(startY, p.dispY);
      const w = Math.abs(p.dispX - startX);
      const h = Math.abs(p.dispY - startY);
      sel.style.left = x + "px";
      sel.style.top = y + "px";
      sel.style.width = w + "px";
      sel.style.height = h + "px";
    });
    window.addEventListener("mouseup", async (e) => {
      if (!dragging) return;
      dragging = false;
      sel.style.display = "none";
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const p = toCanvasPx(e);
      const dispX = Math.min(startX, p.dispX);
      const dispY = Math.min(startY, p.dispY);
      const dispW = Math.abs(p.dispX - startX);
      const dispH = Math.abs(p.dispY - startY);
      if (dispW < 6 || dispH < 6) return;
      const dpr = step.dpr || 1;
      // displayed px -> bitmap px -> CSS px (divide by dpr)
      const b = {
        x: (dispX * scaleX) / dpr,
        y: (dispY * scaleY) / dpr,
        w: (dispW * scaleX) / dpr,
        h: (dispH * scaleY) / dpr,
      };
      step.blurs = step.blurs || [];
      step.blurs.push(b);
      await saveStep(step);
      selectGuide(currentId);
    });
  }

  // ---------- actions ----------
  async function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const tmp = steps[i];
    steps[i] = steps[j];
    steps[j] = tmp;
    await saveOrder();
    await renderMain();
  }

  async function removeStep(i) {
    const s = steps[i];
    steps.splice(i, 1);
    await saveOrder();
    if (s && s.id) await store.remove(K.step(s.id));
    await updateIndexMeta();
    renderSidebar();
    await renderMain();
    toast("Step deleted");
  }

  async function addNote() {
    if (!currentId) return;
    const step = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      guideId: currentId,
      type: "note",
      text: "Add a note or instruction here…",
      screenshot: null,
      blurs: [],
    };
    steps.push(step);
    await saveStep(step);
    await saveOrder();
    await updateIndexMeta();
    renderSidebar();
    await renderMain();
    const last = els.content.querySelector(".step:last-of-type textarea");
    if (last) { autoGrow(last); last.focus(); last.select(); }
  }

  async function selectGuide(id) {
    await loadGuide(id);
    renderSidebar();
    await renderMain();
    location.hash = id || "";
  }

  async function deleteGuide() {
    if (!currentId) return;
    const gi = index.find((g) => g.id === currentId);
    const ok = await confirmModal(
      "Delete this guide?",
      "“" + (gi ? gi.title || "Untitled guide" : "") + "” and its " +
        steps.length + " step" + (steps.length === 1 ? "" : "s") +
        " will be removed. This cannot be undone.",
      "Delete guide"
    );
    if (!ok) return;
    const order = await store.get(K.order(currentId), []);
    const keys = order.map((sid) => K.step(sid));
    keys.push(K.order(currentId));
    await store.remove(keys);
    index = index.filter((g) => g.id !== currentId);
    await store.set({ [K.index]: index });
    currentId = null;
    steps = [];
    const next = index[0] ? index[0].id : null;
    if (next) return selectGuide(next);
    renderSidebar();
    await renderMain();
    toast("Guide deleted");
  }

  // ---------- title ----------
  let titleTimer = null;
  els.title.addEventListener("input", () => {
    const gi = index.find((g) => g.id === currentId);
    if (!gi) return;
    gi.title = els.title.value;
    clearTimeout(titleTimer);
    titleTimer = setTimeout(async () => {
      await store.set({ [K.index]: index });
      renderSidebar();
    }, 350);
  });
  els.title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); els.title.blur(); }
  });

  // ---------- search ----------
  els.search.addEventListener("input", () => {
    filter = els.search.value;
    renderSidebar();
  });

  // ---------- export menu ----------
  els.exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.exportMenu.classList.toggle("open");
  });
  document.addEventListener("click", () => els.exportMenu.classList.remove("open"));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    els.exportMenu.classList.remove("open");
    if (els.overlay.classList.contains("open") && els.overlay.dataset.busy !== "1") {
      closeModal();
    }
  });
  els.exportMenu.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-x]");
    if (!btn) return;
    els.exportMenu.classList.remove("open");
    runExport(btn.dataset.x);
  });

  async function runExport(kind) {
    if (!currentId || !steps.length) {
      toast("Nothing to export yet.");
      return;
    }
    const gi = index.find((g) => g.id === currentId);
    const guide = { title: gi.title || "Untitled guide", createdAt: gi.createdAt, startUrl: gi.startUrl };
    try {
      if (kind === "html") { toast("Building web page…"); await window.FSExport.html(guide, steps); }
      else if (kind === "md") { toast("Building Markdown…"); await window.FSExport.markdown(guide, steps); }
      else if (kind === "pdf") { toast("Building PDF…"); await window.FSExport.pdf(guide, steps); }
      else if (kind === "pptx") { toast("Building PowerPoint…"); await window.FSExport.pptx(guide, steps); }
      else if (kind === "video") { return openVideoModal(guide); }
      toast("Export ready — check your downloads.");
    } catch (err) {
      console.error(err);
      toast("Export failed: " + (err && err.message));
    }
  }

  // ---------- modals ----------
  function closeModal() {
    els.overlay.classList.remove("open");
    els.overlay.dataset.busy = "0";
    els.modal.innerHTML = "";
  }
  els.overlay.addEventListener("click", (e) => {
    if (e.target === els.overlay && els.overlay.dataset.busy !== "1") closeModal();
  });

  function confirmModal(title, body, confirmLabel) {
    return new Promise((resolve) => {
      els.modal.innerHTML =
        "<h3></h3><p></p>" +
        '<div class="row"><button class="btn" id="c-no">Cancel</button>' +
        '<button class="btn danger" id="c-yes"></button></div>';
      els.modal.querySelector("h3").textContent = title;
      els.modal.querySelector("p").textContent = body;
      els.modal.querySelector("#c-yes").textContent = confirmLabel || "Confirm";
      els.overlay.classList.add("open");
      const done = (v) => { closeModal(); resolve(v); };
      els.modal.querySelector("#c-no").onclick = () => done(false);
      els.modal.querySelector("#c-yes").onclick = () => done(true);
      els.modal.querySelector("#c-yes").focus();
    });
  }

  function openVideoModal(guide) {
    const P = window.FSExport.PACES;
    const keys = Object.keys(P);
    let pace = window.FSExport.DEFAULT_PACE;

    els.modal.innerHTML =
      "<h3>Export narrated video</h3>" +
      "<p>Each step becomes a slide that stays on screen as long as its own text needs. " +
      "Pace sets how quickly the voice reads.</p>" +
      '<label class="switch">' +
      '<input type="checkbox" id="v-narrate" checked /><span class="track"></span>' +
      '<span class="label"><b>Narrate with the built-in voice</b>' +
      "<small>Speech is synthesized on your machine. The first run loads the voice model.</small>" +
      "</span></label>" +
      '<div class="field"><span class="field-label">Pace</span>' +
      '<div class="segmented" id="v-pace">' +
      keys.map((k) =>
        '<button type="button" data-k="' + k + '" aria-pressed="' + (k === pace) + '">' +
        P[k].label + "</button>"
      ).join("") +
      '</div><div class="hint" id="v-est"></div></div>' +
      '<div class="progress" id="v-prog" style="display:none"><div></div></div>' +
      '<div class="status-line" id="v-status"></div>' +
      '<div class="row"><button class="btn" id="v-cancel">Cancel</button>' +
      '<button class="btn brand" id="v-go">Create video</button></div>';
    els.overlay.classList.add("open");

    const est = document.getElementById("v-est");
    const seg = document.getElementById("v-pace");
    function showEstimate() {
      const total = steps.reduce(
        (t, s) => t + window.FSExport.stepSecs(s.text, pace), 2
      );
      const m = Math.floor(total / 60);
      const sec = Math.round(total % 60);
      est.textContent =
        "About " + (m ? m + " min " : "") + sec + " sec · " + steps.length +
        (steps.length === 1 ? " step" : " steps");
    }
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-k]");
      if (!b) return;
      pace = b.dataset.k;
      seg.querySelectorAll("button").forEach((x) =>
        x.setAttribute("aria-pressed", String(x === b))
      );
      showEstimate();
    });
    showEstimate();

    document.getElementById("v-cancel").onclick = () => closeModal();
    document.getElementById("v-go").onclick = async () => {
      const narrate = document.getElementById("v-narrate").checked;
      const prog = document.getElementById("v-prog");
      const bar = prog.firstElementChild;
      const status = document.getElementById("v-status");
      const go = document.getElementById("v-go");
      const cancel = document.getElementById("v-cancel");
      prog.style.display = "block";
      go.disabled = true;
      cancel.disabled = true;
      els.overlay.dataset.busy = "1";
      try {
        await window.FSExport.video(guide, steps, {
          narrate,
          pace,
          onProgress: (p, msg) => {
            bar.style.width = Math.round(p * 100) + "%";
            if (msg) status.textContent = msg;
          },
        });
        status.textContent = "Done — video saved to your downloads.";
        els.overlay.dataset.busy = "0";
        setTimeout(() => closeModal(), 1400);
      } catch (err) {
        console.error(err);
        status.textContent = "Video failed: " + (err && err.message);
        go.disabled = false;
        cancel.disabled = false;
        els.overlay.dataset.busy = "0";
      }
    };
  }

  els.deleteGuide.addEventListener("click", deleteGuide);
  els.addNote.addEventListener("click", addNote);

  // ---------- helpers ----------
  let saveTimers = {};
  function debounceSave(step) {
    clearTimeout(saveTimers[step.id]);
    saveTimers[step.id] = setTimeout(() => saveStep(step), 400);
  }
  function mkEl(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function mkBtn(label, icon) {
    const b = document.createElement("button");
    b.className = "btn";
    b.innerHTML = (icon ? svg(icon) : "") + label;
    return b;
  }
  function iconBtn(icon, title, fn, disabled) {
    const b = document.createElement("button");
    b.className = "btn icon sm";
    b.innerHTML = svg(icon);
    b.title = title;
    b.setAttribute("aria-label", title);
    if (disabled) b.setAttribute("disabled", "");
    if (fn) b.addEventListener("click", fn);
    return b;
  }
  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }
  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  function shortUrl(u) {
    try { const x = new URL(u); return x.hostname + x.pathname; } catch (e) { return u; }
  }

  // ---------- init ----------
  async function init() {
    await loadIndex();
    const hashId = location.hash.replace(/^#/, "");
    const startId = index.find((g) => g.id === hashId) ? hashId : (index[0] && index[0].id);
    if (startId) await loadGuide(startId);
    renderSidebar();
    await renderMain();

    // live-refresh sidebar if a new recording finishes in another tab
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === "local" && changes[K.index]) {
        index = changes[K.index].newValue || [];
        renderSidebar();
      }
    });
  }
  init();
})();
