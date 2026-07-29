// FlowScribe — background service worker
// Handles recording state, screenshot capture, and persistence.

const K = {
  state: "fs_state",
  index: "fs_index",
  order: (g) => `fs_steporder_${g}`,
  step: (id) => `fs_step_${id}`,
};

function get(key, def) {
  return new Promise((res) =>
    chrome.storage.local.get(key, (o) => res(key in o ? o[key] : def))
  );
}
function set(obj) {
  return new Promise((res) => chrome.storage.local.set(obj, res));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

async function ensureInjected(tabId) {
  if (tabId == null) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["recorder.css"] });
  } catch (e) { /* ignore */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["recorder.js"] });
  } catch (e) { /* restricted page */ }
}

function broadcast(msg) {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      try {
        chrome.tabs.sendMessage(t.id, msg, () => void chrome.runtime.lastError);
      } catch (e) { /* ignore */ }
    }
  });
}

async function startRecording(tab) {
  const t = tab || (await activeTab());
  const guideId = uid();
  const title = "Untitled guide — " + new Date().toLocaleString();
  const index = await get(K.index, []);
  index.unshift({
    id: guideId,
    title,
    createdAt: Date.now(),
    startUrl: (t && t.url) || "",
    stepCount: 0,
  });
  await set({
    [K.index]: index,
    [K.order(guideId)]: [],
    [K.state]: { recording: true, guideId, stepCount: 0 },
  });
  if (t && t.id != null) await ensureInjected(t.id);
  broadcast({ type: "fs_recording_changed", recording: true, guideId });
  return guideId;
}

const DEFAULT_TITLE_RE = /^Untitled guide — /;

// The label the step is about, e.g. 'Click the "History" button' -> History.
function stepLabel(text) {
  const q = /"([^"]{1,60})"/.exec(String(text || ""));
  if (q) return q[1];
  const m = /^(?:Click|Press|Select|Choose|Open)\s+(?:the\s+)?(.+?)(?:\s+(?:button|link|field|element|tab|icon|menu))?$/i
    .exec(String(text || "").trim());
  return m ? m[1] : "";
}

// Words that describe the shell rather than the product, e.g. the "Dashboard"
// in "uEngage Dashboard" — the brand is the part worth keeping.
const GENERIC_TAIL = /[\s—–|·-]+(dashboard|console|app|portal|admin|home|panel)\s*$/i;

// App name from the page title, falling back to the hostname. Page titles keep
// the vendor's own casing ("uEngage"), which a hostname can't give us.
function appName(steps, startUrl) {
  const titles = steps.map((s) => s.pageTitle).filter(Boolean);
  for (const t of titles) {
    const parts = String(t).split(/\s*[|·»>—–]\s*/).map((x) => x.trim()).filter(Boolean);
    // "Journey Tracking | uEngage" -> brand is the trailing segment
    let cand = parts.length > 1 ? parts[parts.length - 1] : parts[0] || "";
    cand = cand.replace(GENERIC_TAIL, "").trim();
    if (cand && cand.length <= 30) return cand;
  }
  try {
    const h = new URL(startUrl).hostname.split(".");
    const skip = new Set(["www", "app", "apps", "dashboard", "admin", "my", "portal", "console"]);
    const label = h.find((x) => !skip.has(x)) || h[0] || "";
    return label ? label[0].toUpperCase() + label.slice(1) : "";
  } catch (e) {
    return "";
  }
}

// Is this label worth naming a guide after? Rejects dates, numbers, ids and
// other incidental clicks — a date cell reading "28" told us nothing about the
// workflow, but it happened to be the last thing clicked.
function looksLikeName(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 3 || t.length > 48) return false;
  if (!/[A-Za-z]{3}/.test(t)) return false;          // needs real words
  if (/^[\d\s,./:+-]+$/.test(t)) return false;       // pure numbers/dates
  // "Jul 29, 2026", "29 July 2026", "12:30 PM"
  if (/\d/.test(t) && /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|am|pm)\b/i.test(t)) return false;
  if (/^(ok|yes|no|next|back|close|cancel|save|submit|done|apply|search|select|refresh)$/i.test(t)) return false;
  return true;
}

// Names the guide after the last meaningful thing the workflow reached. Scans
// backwards rather than taking the final click, because flows usually end on an
// incidental one (a date cell, a row, a confirm button). Only ever replaces the
// placeholder title, and the user can still edit it.
function guessTitle(steps, startUrl) {
  const app = appName(steps, startUrl);
  const real = steps.filter((s) => s && s.type !== "note");
  let label = "";
  for (let i = real.length - 1; i >= 0; i--) {
    const cand = stepLabel(real[i].text);
    if (!looksLikeName(cand)) continue;
    if (app && cand.toLowerCase() === app.toLowerCase()) continue;
    label = cand;
    break;
  }
  if (!label) return null;
  const sameThing = app && label.toLowerCase().indexOf(app.toLowerCase()) !== -1;
  return "How to view " + label + (app && !sameThing ? " in " + app : "");
}

// A click that only focuses a field, immediately followed by typing into that
// same field, is one action to a reader. Keep the typing step — its screenshot
// shows the entered value — and drop the bare click.
function mergeRedundant(steps) {
  const near = (a, b) => Math.abs(a - b) <= 4;
  const sameTarget = (a, b) =>
    a.rect && b.rect && a.url === b.url &&
    near(a.rect.x, b.rect.x) && near(a.rect.y, b.rect.y) &&
    near(a.rect.w, b.rect.w) && near(a.rect.h, b.rect.h);

  const keep = [];
  const dropped = [];
  for (let i = 0; i < steps.length; i++) {
    const cur = steps[i];
    const next = steps[i + 1];
    if (cur.type === "click" && next && next.type === "input" && sameTarget(cur, next)) {
      dropped.push(cur);
      continue;
    }
    keep.push(cur);
  }
  return { keep, dropped };
}

async function finalizeGuide(guideId) {
  if (!guideId) return;
  const orderKey = K.order(guideId);
  const order = await get(orderKey, []);
  if (!order.length) return;
  const map = await new Promise((res) =>
    chrome.storage.local.get(order.map(K.step), res)
  );
  const steps = order.map((id) => map[K.step(id)]).filter(Boolean);
  if (!steps.length) return;

  const index = await get(K.index, []);
  const gi = index.find((x) => x.id === guideId);

  const { keep, dropped } = mergeRedundant(steps);
  const writes = {};
  if (dropped.length) {
    keep.forEach((s, i) => { s.seq = i + 1; writes[K.step(s.id)] = s; });
    writes[orderKey] = keep.map((s) => s.id);
    await new Promise((res) =>
      chrome.storage.local.remove(dropped.map((s) => K.step(s.id)), res)
    );
  }

  if (gi) {
    gi.stepCount = keep.length;
    if (DEFAULT_TITLE_RE.test(gi.title || "")) {
      const t = guessTitle(keep, gi.startUrl);
      if (t) gi.title = t;
    }
    writes[K.index] = index;
  }
  if (Object.keys(writes).length) await set(writes);
}

async function stopRecording() {
  const state = await get(K.state, {});
  await set({ [K.state]: { recording: false, guideId: null, stepCount: 0 } });
  try {
    await finalizeGuide(state.guideId);
  } catch (e) {
    /* never block stopping over post-processing */
  }
  broadcast({ type: "fs_recording_changed", recording: false });
  return state.guideId;
}

// Serialize captureVisibleTab calls to respect the rate limit.
let captureChain = Promise.resolve(null);
function enqueueCapture(windowId) {
  const run = async (retry) => {
    await new Promise((r) => setTimeout(r, 70));
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (e) {
      if (retry > 0) {
        await new Promise((r) => setTimeout(r, 650));
        return run(retry - 1);
      }
      return null;
    }
  };
  captureChain = captureChain.then(() => run(1));
  return captureChain;
}

async function captureStep(step, sender) {
  const state = await get(K.state, {});
  if (!state.recording) return { ok: false };
  const winId = sender && sender.tab ? sender.tab.windowId : undefined;
  const dataUrl = await enqueueCapture(winId);
  step.id = uid();
  step.guideId = state.guideId;
  step.screenshot = dataUrl || null;

  const orderKey = K.order(state.guideId);
  const order = await get(orderKey, []);
  step.seq = order.length + 1;
  if (!step.blurs) step.blurs = [];
  order.push(step.id);

  const index = await get(K.index, []);
  const gi = index.find((x) => x.id === state.guideId);
  if (gi) gi.stepCount = order.length;

  await set({
    [K.step(step.id)]: step,
    [orderKey]: order,
    [K.index]: index,
    [K.state]: { ...state, stepCount: order.length },
  });
  return { ok: true, count: order.length };
}

function openEditor(guideId) {
  const url =
    chrome.runtime.getURL("editor.html") + (guideId ? "#" + guideId : "");
  chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case "fs_start": {
          const g = await startRecording(sender.tab);
          sendResponse({ ok: true, guideId: g });
          break;
        }
        case "fs_stop": {
          const g = await stopRecording();
          sendResponse({ ok: true, guideId: g });
          break;
        }
        case "fs_capture_step": {
          sendResponse(await captureStep(msg.step, sender));
          break;
        }
        case "fs_get_state": {
          sendResponse(await get(K.state, { recording: false }));
          break;
        }
        case "fs_open_editor": {
          openEditor(msg.guideId);
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message) });
    }
  })();
  return true; // async response
});
