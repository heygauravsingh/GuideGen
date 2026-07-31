// FlowScribe — background service worker
// Handles recording state, screenshot capture, and persistence.

// The account session, shared verbatim with the popup rather than reimplemented.
// Needed here for Google sign-in, which cannot run in the popup — see
// signInWithGoogle in sync.js. Publishes FSSync on `self` in this context.
importScripts("sync.js");

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
  acked = 0;
  seedContext(t);
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
  // Titles come from things the user acted on. A context step's quoted text is a tab
  // title, so `stepLabel` would happily lift it — and "How to view Canva in Canva" is
  // what that produces.
  const SKIP = { note: 1, switch: 1, nav: 1 };
  const real = steps.filter((s) => s && !SKIP[s.type]);
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
  acked = 0;
  await set({ [K.state]: { recording: false, guideId: null, stepCount: 0 } });
  try {
    // Let the last click's step finish landing first — clicking something and
    // immediately pressing Stop would otherwise finalize a guide that's still
    // one step short.
    await stepChain;
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

// ---- Screenshot normalisation ------------------------------------------------
// captureVisibleTab hands back a full-retina PNG — ~3024x1700, 1-3MB per step.
// Every exporter downscales to 1600px anyway, so most of those bytes were stored
// and then thrown away. Storing width-capped WebP instead is a 5-10x reduction:
// it relieves chrome.storage.local, makes the editor quicker to render, and is
// what makes the dashboard bridge possible at all — a full-res guide cannot be
// moved over sendMessage.
//
// maxWidth deliberately matches every consumer's own cap (exporters.js and
// sync.js both use 1600), so in the common case — a dense dashboard, where
// focusRegion returns the full frame — the exported image comes out at exactly
// the size it did before.
const SHOT = { maxWidth: 1600, type: "image/webp", quality: 0.92 };

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const type = (/^data:([^;,]+)/.exec(dataUrl.slice(0, comma)) || [, "image/png"])[1];
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// No FileReader here on purpose, and btoa over a chunked view — one
// String.fromCharCode.apply over a megabyte of bytes blows the argument limit.
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const CH = 0x8000;
  let s = "";
  for (let i = 0; i < bytes.length; i += CH)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return "data:" + (blob.type || "image/webp") + ";base64," + btoa(s);
}

// PNG dataURL -> width-capped WebP dataURL, plus the factor the bitmap shrank
// by. Returns the original untouched on any failure: a fat screenshot always
// beats a lost step.
async function normalizeShot(dataUrl) {
  if (!dataUrl) return { dataUrl: null, scale: 1 };
  let bmp = null;
  try {
    bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
    const srcW = bmp.width;
    const w = Math.max(1, Math.min(srcW, SHOT.maxWidth));
    const h = Math.max(1, Math.round((bmp.height * w) / srcW));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: SHOT.type, quality: SHOT.quality });
    if (!blob || !blob.size) throw new Error("encode produced nothing");
    // Measured against the real bitmap rather than the requested ratio — the
    // rounding above is what the coordinate maths has to agree with.
    return { dataUrl: await blobToDataUrl(blob), scale: w / srcW };
  } catch (e) {
    return { dataUrl, scale: 1 };
  } finally {
    // A retina capture is ~20MB decoded. Leaking one per step would cost more
    // than the bytes this function exists to save.
    if (bmp) bmp.close();
  }
}

// Persistence runs on its own chain. Encoding a screenshot takes long enough
// that two quick clicks would otherwise both read the same step order, push onto
// it and write it back — silently losing one of the two steps.
let stepChain = Promise.resolve();

async function persistStep(step, state, shotPromise) {
  const shot = await shotPromise;
  step.id = uid();
  step.guideId = state.guideId;
  step.screenshot = shot.dataUrl;
  // "bitmap px = CSS px * dpr" is the one coordinate rule in the data model, and
  // downscaling changes that ratio. Folding the factor into dpr keeps render.js,
  // focusRegion and the editor's redaction maths correct with no changes of
  // their own, and every annotation still lands at the same size relative to the
  // image it's drawn on.
  if (shot.scale !== 1) step.dpr = (step.dpr || 1) * shot.scale;

  const orderKey = K.order(state.guideId);
  const order = await get(orderKey, []);
  step.seq = order.length + 1;
  if (!step.blurs) step.blurs = [];
  order.push(step.id);

  const index = await get(K.index, []);
  const gi = index.find((x) => x.id === state.guideId);
  if (gi) gi.stepCount = order.length;

  const writes = { [K.step(step.id)]: step, [orderKey]: order, [K.index]: index };
  // Only touch the live state if this guide is still recording. The user can
  // press Stop while a step is still encoding, and writing back the state this
  // step was captured under would set recording: true again.
  const live = await get(K.state, {});
  if (live.recording && live.guideId === state.guideId)
    writes[K.state] = { ...live, stepCount: order.length };
  await set(writes);
}

// Steps acked since recording started. recorder.js hides its pill until this
// message is answered, so the ack must not wait on the ~350ms WebP encode or the
// pill blinks out on every click. The counter it carries is cosmetic — the pill
// re-syncs from fs_state via storage.onChanged once the write lands — so acking
// optimistically is safe. Seeded from stepCount so a service-worker restart
// mid-recording doesn't send the count back to 1.
let acked = 0;

/* ---- Context steps: tab switches and page navigations ----------------------
 *
 * Clicks in other tabs were always recorded — `recorder.js` is a declared content
 * script on <all_urls> and self-attaches from `fs_state`, and `broadcast()` reaches
 * every tab. What was missing is the step that explains the *move*: a guide went
 * straight from a click in one tab to a click in another, and the reader had no idea
 * the tab had changed. Clicking a tile that opens a new tab is the common case.
 *
 * Two events, one step type, and the ordering between them is what keeps it from
 * emitting twice for one action:
 *
 *   onActivated  — a different tab came to the front. For a *newly opened* tab this
 *                  fires while the url is still "" or "about:blank", so RECORDABLE
 *                  rejects it and the navigation below is what gets recorded.
 *                  Switching to an already-loaded tab has a real url, so it lands
 *                  here and never reaches onUpdated.
 *   onUpdated    — a document finished loading in the *active* tab. Background tabs
 *                  loading are not something the user did.
 *
 * `seen` is what stops repeats: a tab+url already recorded produces no second step,
 * so a site firing `complete` more than once, or a bounce back to a tab, stays quiet.
 * It is in-memory, so a worker restart mid-recording can cost one duplicate step —
 * cheaper than a read-modify-write of persisted state on every navigation.
 */
const RECORDABLE = /^https?:/i;
let seen = { tabId: null, url: "" };

// Seeded at startRecording, so the tab the user started in is never announced as a
// switch to itself.
function seedContext(tab) {
  seen = { tabId: (tab && tab.id) != null ? tab.id : null, url: (tab && tab.url) || "" };
}

function bareUrl(u) {
  return String(u || "").split("#")[0];
}

// Host + path, no scheme or query: "canva.com/design/DAG.../edit" rather than 180
// characters of tracking parameters, which is unreadable as an instruction.
function shortUrl(u) {
  try {
    const x = new URL(u);
    const p = x.pathname === "/" ? "" : x.pathname;
    return x.host.replace(/^www\./, "") + p;
  } catch (e) {
    return String(u || "");
  }
}

async function contextStep(tab, kind) {
  if (!tab || tab.id == null || !RECORDABLE.test(tab.url || "")) return;
  const state = await get(K.state, {});
  if (!state.recording) return;

  const sameTab = seen.tabId === tab.id;
  if (sameTab && bareUrl(seen.url) === bareUrl(tab.url)) return;
  seen = { tabId: tab.id, url: tab.url };

  const text = kind === "switch" && tab.title
    ? `Switch to the "${tab.title}" tab`
    : `Go to ${shortUrl(tab.url)}`;

  const step = {
    type: kind === "switch" ? "switch" : "nav",
    url: tab.url,
    pageTitle: tab.title || "",
    timestamp: Date.now(),
    // No point or rect: nothing was clicked, so render.js draws the screenshot
    // unannotated. dpr starts at 1 and normalizeShot's downscale is folded in by
    // persistStep, which keeps the editor's redaction maths round-tripping.
    dpr: 1,
    text,
    blurs: [],
  };

  const shot = await enqueueCapture(tab.windowId);
  const shotPromise = normalizeShot(shot);
  stepChain = stepChain.then(() => persistStep(step, state, shotPromise)).catch(() => {});
  acked = Math.max(acked, state.stepCount || 0) + 1;
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    contextStep(tab, "switch");
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab || !tab.active) return;
  contextStep(tab, "nav");
});

async function captureStep(step, sender) {
  const state = await get(K.state, {});
  if (!state.recording) return { ok: false };
  const winId = sender && sender.tab ? sender.tab.windowId : undefined;
  // Capture stays serialized *and* prompt: the page must not move on before its
  // screenshot is taken. Encoding then overlaps the next capture instead of
  // delaying it, and only the write is serialized — claimed here, in click
  // order, so a slow encode can never reorder steps.
  const shot = await enqueueCapture(winId);
  const shotPromise = normalizeShot(shot);
  stepChain = stepChain
    .then(() => persistStep(step, state, shotPromise))
    .catch(() => {});
  acked = Math.max(acked, state.stepCount || 0) + 1;
  return { ok: true, count: acked };
}

// The editor lives on the dashboard now, not in the extension — one editor
// instead of two hand-kept-in-parity copies. editor.html only still exists to
// redirect old bookmarks here.
const WEB_ORIGIN = "https://guide-gen.vercel.app";
const DASHBOARD = WEB_ORIGIN + "/app";

// Hand the dashboard our own extension id. It cannot know it otherwise: an
// extension loaded unpacked gets an id Chrome derives locally, not the permanent
// one the Web Store assigned, and a page targeting the wrong id gets an error
// indistinguishable from "not installed" (see web/assets/bridge.js).
function openEditor(guideId) {
  const url = DASHBOARD + "?ext=" + encodeURIComponent(chrome.runtime.id) +
              (guideId ? "#local-" + guideId : "");
  chrome.tabs.create({ url });
}

// ---- The dashboard bridge ----------------------------------------------------
// A page on guide-gen.vercel.app cannot read chrome.storage.local: different
// origin, different sandbox. `externally_connectable` in the manifest is the only
// link — the dashboard calls chrome.runtime.sendMessage(EXTENSION_ID, …) and this
// answers. Three things shaped the API:
//
// 1. **Step images come one at a time**, via gg_step_image, as the editor scrolls.
//    Never put a whole guide's screenshots in one response: even width-capped
//    WebP, a 40-step guide is several megabytes, and that is how you discover the
//    message-size ceiling in production rather than here.
// 2. **Every write is validated as if it came from a stranger**, because it comes
//    from a web page. Reorders must be a permutation of the steps that already
//    exist; redaction rects must be finite positive numbers.
// 3. **Any script running on that origin can read and edit every local guide.**
//    That is inherent to hosting the editor there, not an extra hole — but it is
//    the reason the manifest match is one exact origin and never a wildcard.

async function readSteps(guideId) {
  const order = await get(K.order(guideId), []);
  if (!order.length) return [];
  const map = await new Promise((res) =>
    chrome.storage.local.get(order.map(K.step), res)
  );
  return order.map((id) => map[K.step(id)]).filter(Boolean);
}

// A step without its screenshot. `hasImage` is all the editor needs to decide
// whether to ask for the bytes.
function lightStep(s) {
  const out = {};
  Object.keys(s).forEach((k) => { if (k !== "screenshot") out[k] = s[k]; });
  out.hasImage = !!s.screenshot;
  return out;
}

function cleanRect(r) {
  if (!r || typeof r !== "object") return null;
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  const x = n(r.x), y = n(r.y), w = n(r.w), h = n(r.h);
  if (x === null || y === null || w === null || h === null) return null;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

async function setStepCount(guideId, n) {
  const index = await get(K.index, []);
  const gi = index.find((g) => g.id === guideId);
  if (!gi) return;
  gi.stepCount = n;
  await set({ [K.index]: index });
}

async function bridge(msg) {
  const type = msg && msg.type;
  const guideId = msg && msg.guideId;

  switch (type) {
    case "gg_ping":
      return { ok: true, version: chrome.runtime.getManifest().version };

    // The popup is the sign-in gate, so the extension holds the session. The
    // dashboard asks for it once on load and adopts it if it has none — signing
    // in twice for one product is not a feature. Only our own origin can ask,
    // and it is an origin we already trust with every local guide.
    case "gg_session":
      return { ok: true, session: (await get("gg_auth", null)) || null };

    // The dashboard owns the light/dark choice; the popup follows it. Without this
    // the popup sat in dark mode while the editor next to it was light.
    case "gg_set_theme": {
      const mode = ["light", "dark", "auto"].indexOf(msg.mode) !== -1 ? msg.mode : "light";
      await set({ gg_theme: mode });
      return { ok: true };
    }

    case "gg_guides":
      return { ok: true, guides: await get(K.index, []) };

    case "gg_guide": {
      const gi = (await get(K.index, [])).find((g) => g.id === guideId);
      if (!gi) return { ok: false, error: "That guide isn't on this device." };
      const steps = await readSteps(guideId);
      return { ok: true, guide: gi, steps: steps.map(lightStep) };
    }

    case "gg_step_image": {
      const s = await get(K.step(msg.stepId), null);
      if (!s) return { ok: false, error: "That step isn't on this device." };
      return { ok: true, screenshot: s.screenshot || null };
    }

    case "gg_update_guide": {
      const index = await get(K.index, []);
      const gi = index.find((g) => g.id === guideId);
      if (!gi) return { ok: false, error: "That guide isn't on this device." };
      const p = msg.patch || {};
      if (typeof p.title === "string") gi.title = p.title;
      // Publishing writes these back so the dashboard can offer Update instead of
      // creating a second document — and a second link — on every press.
      if ("remoteId" in p) gi.remoteId = p.remoteId || null;
      if ("publishedAt" in p) gi.publishedAt = p.publishedAt || null;
      await set({ [K.index]: index });
      return { ok: true, guide: gi };
    }

    case "gg_update_step": {
      const s = await get(K.step(msg.stepId), null);
      if (!s) return { ok: false, error: "That step isn't on this device." };
      const p = msg.patch || {};
      if (typeof p.text === "string") s.text = p.text;
      if (Array.isArray(p.blurs)) s.blurs = p.blurs.map(cleanRect).filter(Boolean);
      await set({ [K.step(s.id)]: s });
      return { ok: true };
    }

    case "gg_reorder": {
      const current = await get(K.order(guideId), []);
      const want = Array.isArray(msg.order) ? msg.order : [];
      const known = new Set(current);
      const next = want.filter((id) => known.has(id));
      // Must be a permutation of what's already there. A malformed list from the
      // page must not be able to orphan a step or invent one.
      if (next.length !== current.length || new Set(next).size !== next.length) {
        return { ok: false, error: "That order doesn't match this guide's steps." };
      }
      await set({ [K.order(guideId)]: next });
      return { ok: true };
    }

    case "gg_delete_step": {
      const order = await get(K.order(guideId), []);
      const next = order.filter((id) => id !== msg.stepId);
      if (next.length === order.length) {
        return { ok: false, error: "That step isn't in this guide." };
      }
      await set({ [K.order(guideId)]: next });
      await new Promise((r) => chrome.storage.local.remove(K.step(msg.stepId), r));
      await setStepCount(guideId, next.length);
      return { ok: true, stepCount: next.length };
    }

    case "gg_add_note": {
      const gi = (await get(K.index, [])).find((g) => g.id === guideId);
      if (!gi) return { ok: false, error: "That guide isn't on this device." };
      const order = await get(K.order(guideId), []);
      const step = {
        id: uid(),
        guideId,
        seq: order.length + 1,
        type: "note",
        text: typeof msg.text === "string" ? msg.text : "",
        screenshot: null,
        blurs: [],
      };
      order.push(step.id);
      await set({ [K.step(step.id)]: step, [K.order(guideId)]: order });
      await setStepCount(guideId, order.length);
      return { ok: true, step: lightStep(step) };
    }

    case "gg_delete_guide": {
      const order = await get(K.order(guideId), []);
      const keys = order.map(K.step);
      keys.push(K.order(guideId));
      await new Promise((r) => chrome.storage.local.remove(keys, r));
      const index = (await get(K.index, [])).filter((g) => g.id !== guideId);
      await set({ [K.index]: index });
      return { ok: true };
    }

    default:
      return { ok: false, error: "Unknown request: " + type };
  }
}

// Serialized for the same reason step writes are: several of these handlers
// read-modify-write fs_index, and the dashboard fires them as fast as the user
// clicks.
let bridgeChain = Promise.resolve();

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // externally_connectable is the real gate. This is the belt to its braces.
  if (!sender || sender.origin !== WEB_ORIGIN) {
    sendResponse({ ok: false, error: "forbidden" });
    return false;
  }
  const run = bridgeChain.then(() => bridge(msg));
  bridgeChain = run.catch(() => {});
  run.then(sendResponse, (e) =>
    sendResponse({ ok: false, error: String((e && e.message) || e) })
  );
  return true;
});

// ---- Narrated video, rendered in an offscreen document ----------------------
// The 88MB voice stack (lib/ort + lib/piper + lib/voices) ships in this package
// and cannot be served from the website — .vercelignore exists to make sure of
// it, and at 88MB a head Vercel Hobby's monthly transfer is ~1,100 exports. So
// narration stays here while the editor moves to the web.
//
// An offscreen document is the MV3 way to get a DOM, an AudioContext and a
// MediaRecorder with no visible page. Two consequences the code has to respect:
// it only has chrome.runtime, so the guide arrives by message and the finished
// blob leaves as a blob: URL for this worker to download; and it is never
// visible, so requestAnimationFrame never fires there (see exporters.js tickMs).
const OFF_DOC = "offscreen.html";

// Steps handed over by the dashboard for a guide this machine has never recorded.
// Everything is clamped rather than trusted: a web page is on the other end, and
// this data goes straight into a canvas and a MediaRecorder.
const PUSHED_MAX_STEPS = 300;             // matches the Firestore rules' cap
const PUSHED_MAX_BYTES = 24 * 1024 * 1024;

function pushedSteps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let bytes = 0;
  for (const s of raw.slice(0, PUSHED_MAX_STEPS)) {
    if (!s || typeof s !== "object") continue;
    const shot = typeof s.screenshot === "string" && /^data:image\//.test(s.screenshot)
      ? s.screenshot : null;
    if (shot) {
      bytes += shot.length;
      if (bytes > PUSHED_MAX_BYTES) break;
    }
    out.push({
      seq: out.length + 1,
      type: s.type === "note" ? "note" : "click",
      text: typeof s.text === "string" ? s.text.slice(0, 2000) : "",
      screenshot: shot,
      // Already annotated and cropped at publish time. render.js and exporters.js
      // both key off this to leave the image alone — see focusRegion.
      baked: true,
      blurs: [],
    });
  }
  return out;
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFF_DOC,
    reasons: ["AUDIO_PLAYBACK", "BLOBS"],
    justification:
      "Render the narrated video export: Web Audio for the offline voice, " +
      "MediaRecorder for the webm.",
  });
}

async function closeOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  } catch (e) { /* already gone */ }
}

// The dashboard connects a port rather than sending one message, for two
// reasons: progress has to stream back over a render that can take minutes, and
// an open port keeps this service worker from being shut down mid-export.
let task = null;

async function finishTask(msg) {
  const t = task;
  task = null;
  if (t && t.port) { try { t.port.postMessage(msg); } catch (e) { /* page gone */ } }
  // Closing the document frees the blob: URL along with it.
  await closeOffscreen();
}

function downloadVideo(url, filename) {
  chrome.downloads.download({ url, filename }, (id) => {
    if (chrome.runtime.lastError || id == null) {
      const why = (chrome.runtime.lastError || {}).message || "the download was refused";
      finishTask({ type: "error", error: "Couldn't save the video: " + why });
      return;
    }
    // Wait for the write to finish before closing the offscreen document — the
    // blob: URL dies with it, and a half-written webm is worse than none.
    const watch = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(watch);
        finishTask({ type: "done", filename });
      } else if (delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(watch);
        finishTask({ type: "error", error: "The download was interrupted." });
      }
    };
    chrome.downloads.onChanged.addListener(watch);
  });
}

chrome.runtime.onConnectExternal.addListener((port) => {
  if (!port.sender || port.sender.origin !== WEB_ORIGIN || port.name !== "gg_task") {
    return port.disconnect();
  }
  port.onDisconnect.addListener(() => {
    // Drop the port but keep the task. Closing the dashboard tab shouldn't cancel
    // a render that's already going — the user still gets the file — and clearing
    // `task` here would let the next request through to an offscreen document
    // that's still busy, where the only way to accept it would be to kill the
    // render in progress.
    if (task && task.port === port) task.port = null;
  });
  port.onMessage.addListener((m) => {
    (async () => {
      if (!m || m.task !== "video") {
        return port.postMessage({ type: "error", error: "Unknown task." });
      }
      if (task) {
        return port.postMessage({
          type: "error",
          error: "A video is already rendering. Wait for it to finish.",
        });
      }
      task = { port };
      try {
        let gi, steps;
        if (m.steps) {
          // A guide the page already holds, rather than one on this machine —
          // a recipient exporting someone else's *published* guide. Their copy
          // of the extension has never seen it, so the images come in the
          // message. Cheap: published images are ~17KB each, so a 40-step guide
          // is about a megabyte.
          //
          // Validated as hostile input, because it is web-page input. The size
          // bound is the point — an unbounded array here would take the offscreen
          // document out of memory rather than fail cleanly.
          gi = {
            title: typeof m.guide === "string" ? m.guide.slice(0, 300) : "Untitled guide",
            createdAt: Date.now(),
          };
          steps = pushedSteps(m.steps);
          if (!steps.length) throw new Error("No usable steps were sent.");
        } else {
          gi = (await get(K.index, [])).find((g) => g.id === m.guideId);
          if (!gi) throw new Error("That guide isn't on this device.");
          steps = await readSteps(m.guideId);
        }
        if (!steps.length) throw new Error("That guide has no steps.");
        port.postMessage({ type: "progress", p: 0.02, msg: "Starting the renderer…" });
        await ensureOffscreen();
        // Read the reply. The document refuses a second render while one is in
        // flight, and `task` alone doesn't catch that — a dashboard tab that was
        // closed mid-render clears `task` while the renderer keeps going. Without
        // this the next request would sit there forever with nothing to show.
        const accepted = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            target: "offscreen",
            type: "gg_off_video",
            guide: { title: gi.title, createdAt: gi.createdAt, startUrl: gi.startUrl },
            steps,
            pace: m.pace,
            narrate: m.narrate !== false,
          }, (resp) => resolve(chrome.runtime.lastError ? null : resp));
        });
        if (!accepted || !accepted.ok) {
          throw new Error((accepted && accepted.error) || "The video renderer didn't start.");
        }
      } catch (e) {
        await finishTask({ type: "error", error: String((e && e.message) || e) });
      }
    })();
  });
});

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
        /* Google sign-in runs here, not in the popup, because the popup is destroyed
         * the instant Google's window takes focus. The reply is best-effort for the
         * same reason — by the time the flow finishes there is usually no popup left
         * to receive it. The session is written to storage regardless, so reopening
         * the popup shows a signed-in state. */
        case "fs_google_signin": {
          try {
            const session = await FSSync.signInWithGoogle();
            sendResponse({ ok: true, session });
          } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
          }
          break;
        }
        // ---- from the offscreen video renderer ----
        case "gg_off_progress": {
          if (task && task.port) {
            try { task.port.postMessage({ type: "progress", p: msg.p, msg: msg.msg }); }
            catch (e) { /* the dashboard tab went away */ }
          }
          sendResponse({ ok: true });
          break;
        }
        case "gg_off_blob": {
          sendResponse({ ok: true });
          downloadVideo(msg.url, msg.filename);
          break;
        }
        case "gg_off_error": {
          sendResponse({ ok: true });
          await finishTask({ type: "error", error: String(msg.error || "Video failed.") });
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
