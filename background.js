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
  // The buffer mirrors the guide model — an id list plus one key per step —
  // rather than one fat array. A single key holding forty base64 screenshots
  // would be rewritten in full on every click, which is megabytes of storage
  // churn per click for no reason.
  bufIndex: "fs_bufindex",
  bufStep: (id) => `fs_bufstep_${id}`,
  bufOrigins: "fs_buf_origins",
  // session id -> when it was turned into a guide. Promoting marks, never deletes.
  bufDone: "fs_bufdone",
  // The API log. One per recording, plus one shared by the catch-up buffer. Both
  // are working scratch: entries are folded onto the steps they belong to at
  // finalize (or at promotion) and the log itself is then thrown away.
  net: (g) => `fs_net_${g}`,
  bufNet: "fs_bufnet",
  // Opt-in for Tier 2 (failed response bodies) while buffering. Recordings carry
  // their own flag on fs_state, chosen at Start.
  bufBodies: "fs_buf_bodies",
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

async function startRecording(tab, opts) {
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
    // captureBodies is Tier 2 of the API log: chosen at Start, per recording, and
    // false unless the popup asked for it. It lives on the state rather than in
    // settings because it is a decision about *this* recording.
    [K.state]: { recording: true, guideId, stepCount: 0, captureBodies: !!(opts && opts.bodies) },
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
  // A scroll's text has no quoted label to lift, and a keypress's is a key name —
  // neither is a thing the guide is *about*, so neither may name it.
  const SKIP = { note: 1, switch: 1, nav: 1, scroll: 1, key: 1 };
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

/* A `nav` step that only says where the click before it already went.
 *
 * `Click "Rider Management"` followed by `Go to …/rider-management` is one thing
 * happening, written down twice, and a reader has to work out that they are the same
 * — which is four of thirteen steps on a real recording. The navigation only earns a
 * step when nothing in the guide explains it: the first step, a page reached by
 * typing a URL, or one that arrives long after whatever preceded it.
 *
 * Three guards, each of them load-bearing:
 *
 * - **Same tab only.** Clicking a tile that opens a *new* tab produces a click step
 *   holding the old page and a nav step holding the new one, and the switch step for
 *   a brand-new tab is rejected before it is written (its url is still `about:blank`).
 *   Drop that nav and the destination never appears in the guide at all.
 * - **Only after an action.** A nav following another nav, a scroll or a note is not
 *   explained by it, so it stays.
 * - **Never the last step.** A click's screenshot is of the page it was clicked on;
 *   the destination shows up in the *next* step's picture. When the nav is last there
 *   is no next step, so it is the only record of the outcome. */
const NAV_CAUSED_MS = 12000;
function dropCausedNavs(steps) {
  const CAUSE = { click: 1, key: 1, input: 1 };
  const keep = [];
  const dropped = [];
  steps.forEach((cur, i) => {
    // `keep`, not `steps`: a redirect chain writes two navs, and the second is
    // explained by the same click as the first.
    const prev = keep[keep.length - 1];
    const caused =
      cur.type === "nav" && i < steps.length - 1 &&
      prev && CAUSE[prev.type] &&
      prev.tabId != null && prev.tabId === cur.tabId &&
      (cur.timestamp || 0) - (prev.timestamp || 0) <= NAV_CAUSED_MS;
    if (caused) dropped.push(cur);
    else keep.push(cur);
  });
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

  const merged = mergeRedundant(steps);
  const navs = dropCausedNavs(merged.keep);
  const keep = navs.keep;
  const dropped = merged.dropped.concat(navs.dropped);
  const writes = {};

  /* Fold the API log onto the steps, then delete it. It is scratch space, not part
   * of the data model — once each request sits on the step that caused it there is
   * nothing left to correlate, and leaving a second copy around would be a second
   * place to have to redact. Runs before the merge writes below so a merged-away
   * step doesn't take its requests with it. */
  const netKey = K.net(guideId);
  const entries = await get(netKey, []);
  if (entries.length) {
    if (attachNetwork(keep, entries)) keep.forEach((s) => { writes[K.step(s.id)] = s; });
    await new Promise((res) => chrome.storage.local.remove(netKey, res));
  }

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
async function normalizeShot(dataUrl, opts) {
  const spec = opts || SHOT;
  if (!dataUrl) return { dataUrl: null, scale: 1 };
  let bmp = null;
  try {
    bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
    const srcW = bmp.width;
    const w = Math.max(1, Math.min(srcW, spec.maxWidth));
    const h = Math.max(1, Math.round((bmp.height * w) / srcW));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: spec.type, quality: spec.quality });
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
  /* Buffered sessions get these too. They did not at first, and the result was a
   * promoted guide that jumped between tabs with nothing explaining the move
   * while a recorded one said "Switch to the … tab" — the same flow reading worse
   * for having been captured after the fact, which is not a trade anybody chose.
   * Recording still wins if both apply, exactly as it does for a click. */
  const buffering =
    !state.recording && !tab.incognito && (await bufArmed(tab.url || ""));
  if (!state.recording && !buffering) return;

  const sameTab = seen.tabId === tab.id;
  if (sameTab && bareUrl(seen.url) === bareUrl(tab.url)) return;
  seen = { tabId: tab.id, url: tab.url };

  const text = kind === "switch" && tab.title
    ? `Switch to the "${tab.title}" tab`
    : `Go to ${shortUrl(tab.url)}`;

  const step = {
    type: kind === "switch" ? "switch" : "nav",
    tabId: tab.id,
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
  if (buffering) {
    bufWrite(step, normalizeShot(shot, BUF.shot));
    return;
  }
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

/* ---------------------------------------------------------------- the buffer
 *
 * **"Capture last 2 minutes."** That is the feature; everything here serves it.
 * The pain always arrives after the fact — you finish something, then someone
 * asks how — and by then Start is useless.
 *
 * You cannot screenshot the past, so the only way to answer that is to have been
 * capturing all along and throwing it away. Which is why this is **armed per
 * origin and off by default**. A blanket always-on buffer eventually holds a
 * screenshot of the user's bank, and no wording in a settings page makes that a
 * reasonable default. Armed on the two or three admin panels someone actually
 * documents, the surface is small enough to explain in one sentence.
 *
 * The cost of that choice, stated plainly because it shapes the onboarding: the
 * first time someone wants this on a new site, it is empty. Arming is a
 * before-decision in a feature whose whole premise is deciding after. It is
 * mitigated by *offering* to arm at the moment the intent is proven — after a
 * deliberate recording on that site — never by arming silently.
 *
 * Four properties this must keep:
 *
 * 1. **Nothing here is ever uploaded.** The buffer is not a guide. Promoting it
 *    creates a real guide, and publishing that is the same deliberate act it
 *    always was. `publish.js` never sees a `fs_bufstep_` key.
 * 2. **It expires, as whole sessions.** See `groupSessions` — the countdown the
 *    dashboard shows has to be true, and a session that rots from the front
 *    while its card claims six days left is not.
 * 3. **It is visible while it runs.** recorder.js shows a bare dot. An invisible
 *    always-on capture is the thing people are right to be afraid of — but the
 *    full pill said "something is being written down", which while buffering is
 *    a lie in the other direction. Disclosure, not a status.
 * 4. **Redeeming happens in the popup, not on the page.** The dot is not a
 *    button. One deliberate place to turn minutes into a guide.
 *
 * `<all_urls>` and the declared content script were already here — buffering
 * needs no new permission. That makes it a *behaviour* change, not a capability
 * one, which is exactly why the store listing has to be re-worded even though
 * the permission list does not move.
 */
const BUF = {
  // 240 rather than 40, because the count cap and the age cap have to agree
  // about what this feature promises. At 40, a 7-day retention was decoration:
  // ~40 clicks of ordinary work evicted yesterday's session before lunch, so
  // nothing survived a night no matter what the card said. ~240 steps of
  // 1280px WebP is roughly 20MB per armed origin, which is what
  // `unlimitedStorage` is for.
  maxSteps: 240,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  // A gap this long ends a session. Long enough that a coffee break doesn't
  // split one piece of work in two, short enough that this morning and this
  // afternoon are separate things in the library.
  sessionGapMs: 30 * 60 * 1000,
  // What "last 2 minutes" means, measured back from the *session's* end rather
  // than from now — so yesterday's card offers yesterday's last two minutes.
  sliceMs: 2 * 60 * 1000,
  // Cheaper than a real recording's capture: this runs on clicks the user never
  // asked to record, so it must not cost what a deliberate recording costs. A
  // promoted guide is a little softer than a recorded one, which beats not
  // existing.
  shot: { maxWidth: 1280, type: "image/webp", quality: 0.8 },
};

function originOf(url) {
  try { return new URL(url).origin; } catch (e) { return ""; }
}

async function bufOrigins() {
  return await get(K.bufOrigins, {});
}

// "*" arms everywhere. Deliberately expressible — some people will want it, and
// hiding it behind a rebuild would just mean they never get the choice — but it
// is never what the popup sets.
async function bufArmed(url) {
  const origins = await bufOrigins();
  if (origins["*"]) return true;
  const o = originOf(url);
  return !!(o && origins[o]);
}

async function setBufArmed(origin, on) {
  if (!origin) return {};
  const origins = await bufOrigins();
  if (on) origins[origin] = true;
  else delete origins[origin];
  await set({ [K.bufOrigins]: origins });
  broadcast({ type: "fs_buf_changed" });
  return origins;
}

async function bufList() {
  const ids = await get(K.bufIndex, []);
  if (!ids.length) return [];
  const map = await new Promise((res) =>
    chrome.storage.local.get(ids.map(K.bufStep), res)
  );
  return ids.map((id) => map[K.bufStep(id)]).filter(Boolean);
}

/* Splits the flat step list into sessions: a run of buffered steps on one origin
 * with no gap longer than `sessionGapMs`.
 *
 * Sessions are **derived, never stored**. The buffer stays one ordered id list,
 * which means there is no second index to keep consistent and no migration for
 * anything already buffered. It also means the grouping rule can change without
 * touching stored data.
 *
 * The session's id is its first step's id. That is stable for a session's whole
 * life *except* when a single session is big enough to be trimmed from the front
 * by the count cap, which re-ids it — so a dashboard card can shift identity in
 * that one case. Cheap to live with; not worth a stored id and its consistency
 * problem.
 */
function groupSessions(steps) {
  const out = [];
  let cur = null;
  steps.forEach((s) => {
    const origin = originOf(s.url);
    const t = s.timestamp || 0;
    if (!cur || cur.origin !== origin || t - cur.endedAt > BUF.sessionGapMs) {
      cur = { id: s.id, origin, startedAt: t, endedAt: t, steps: [s] };
      out.push(cur);
    } else {
      cur.endedAt = t;
      cur.steps.push(s);
    }
  });
  return out;
}

/* Drops what is past the age cap or the count cap. Returns the surviving ids.
 *
 * **Both caps are applied per session, not per step**, and that is the whole
 * point: the dashboard shows each pending capture with "expires in N days", so a
 * session has to either be there or be gone. Expiring the oldest *steps* of a
 * session left a card promising six days over a guide that had quietly lost its
 * first half. Age drops whole sessions; the count cap drops whole sessions
 * oldest-first, and only trims mid-session when one session alone is over cap.
 */
async function evictBuffer(ids) {
  const cutoff = Date.now() - BUF.maxAgeMs;
  const map = await new Promise((res) =>
    chrome.storage.local.get(ids.map(K.bufStep), res)
  );
  const steps = ids.map((id) => map[K.bufStep(id)]).filter(Boolean);
  let sessions = groupSessions(steps).filter((s) => s.endedAt >= cutoff);

  let total = sessions.reduce((n, s) => n + s.steps.length, 0);
  while (total > BUF.maxSteps && sessions.length > 1) {
    total -= sessions[0].steps.length;
    sessions = sessions.slice(1);
  }
  if (total > BUF.maxSteps && sessions.length) {
    const s = sessions[0];
    s.steps = s.steps.slice(s.steps.length - BUF.maxSteps);
    s.id = s.steps[0].id;
  }

  const keep = [];
  sessions.forEach((s) => s.steps.forEach((x) => keep.push(x.id)));
  const drop = ids.filter((id) => keep.indexOf(id) < 0);
  if (drop.length) {
    await new Promise((res) => chrome.storage.local.remove(drop.map(K.bufStep), res));
  }
  return keep;
}

/* Sessions as the popup and the dashboard see them — no steps, no screenshots,
 * newest first. `redeemed` is what makes "captures you haven't turned into a
 * guide yet" answerable: promoting marks the session rather than deleting it,
 * because the common case after promoting is wanting a *different* slice of the
 * same few minutes. */
async function bufSessions() {
  const steps = await bufList();
  const done = await get(K.bufDone, {});
  const out = groupSessions(steps).map((s) => {
    const from = s.endedAt - BUF.sliceMs;
    return {
      id: s.id,
      origin: s.origin,
      host: s.origin.replace(/^https?:\/\//, ""),
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      stepCount: s.steps.length,
      // How many of those steps "last 2 minutes" would actually take. The popup
      // needs it to label its own button honestly.
      sliceCount: s.steps.filter((x) => (x.timestamp || 0) >= from).length,
      sliceMinutes: Math.round(BUF.sliceMs / 60000),
      expiresAt: s.endedAt + BUF.maxAgeMs,
      redeemedAt: done[s.id] || null,
    };
  });
  return out.reverse();
}

// Prunes redemption marks whose session no longer exists, so this map cannot
// grow forever behind a buffer that keeps expiring.
async function markRedeemed(sessionId) {
  const live = groupSessions(await bufList()).map((s) => s.id);
  const done = await get(K.bufDone, {});
  const next = {};
  live.forEach((id) => { if (done[id]) next[id] = done[id]; });
  if (sessionId) next[sessionId] = Date.now();
  await set({ [K.bufDone]: next });
}

async function discardSession(sessionId) {
  const sessions = groupSessions(await bufList());
  const sess = sessions.filter((s) => s.id === sessionId)[0];
  if (!sess) return { ok: false, error: "That capture has already gone." };
  const gone = sess.steps.map((s) => s.id);
  const ids = (await get(K.bufIndex, [])).filter((id) => gone.indexOf(id) < 0);
  await new Promise((res) =>
    chrome.storage.local.remove(gone.map(K.bufStep), res)
  );
  // The API log for that stretch of time goes with it. Discarding a capture has to
  // take everything the capture held, not just the screenshots.
  const from = sess.startedAt;
  const to = sess.endedAt + NET.windowMs;
  const net = (await get(K.bufNet, [])).filter((e) => e.ts < from || e.ts > to);
  await set({ [K.bufIndex]: ids, [K.bufNet]: net });
  broadcast({ type: "fs_buf_changed", count: ids.length });
  return { ok: true };
}

async function clearBuffer() {
  const ids = await get(K.bufIndex, []);
  await new Promise((res) =>
    chrome.storage.local.remove(
      ids.map(K.bufStep).concat([K.bufIndex, K.bufDone, K.bufNet]),
      res
    )
  );
  broadcast({ type: "fs_buf_changed" });
  return { ok: true };
}

let bufChain = Promise.resolve();

/* The one place a buffered step is written. Serialized on `bufChain` for the same
 * reason recording steps are serialized on `stepChain`: the encode runs off-chain
 * so it overlaps the next capture, which means completion order is not click
 * order. Shared by clicks (`bufferStep`) and by tab switches and navigations
 * (`contextStep`) so those cannot drift apart in how they land. */
function bufWrite(step, shotPromise) {
  bufChain = bufChain
    .then(async () => {
      const s = await shotPromise;
      step.id = uid();
      step.screenshot = s.dataUrl;
      if (s.scale !== 1) step.dpr = (step.dpr || 1) * s.scale;
      if (!step.blurs) step.blurs = [];
      delete step.noShot;

      const ids = (await get(K.bufIndex, [])).concat([step.id]);
      await set({ [K.bufStep(step.id)]: step });
      const keep = await evictBuffer(ids);
      await set({ [K.bufIndex]: keep });
      broadcast({ type: "fs_buf_changed", count: keep.length });
    })
    .catch(() => {});
}

async function bufferStep(step, sender) {
  const tab = sender && sender.tab;
  if (!tab || tab.incognito) return { ok: false };
  // A recording already captures this click. Buffering it too would double every
  // step and spend two captures against the rate limit for one action.
  const state = await get(K.state, {});
  if (state.recording) return { ok: false };
  if (!(await bufArmed(tab.url || step.url))) return { ok: false };
  step.tabId = tab.id;

  // recorder.js sets this when a password field has focus. The step's words are
  // safe — it never records a typed value — but the screenshot is the whole
  // viewport, and a login screen is the one frame most worth not keeping.
  const shot = step.noShot ? null : await enqueueCapture(tab.windowId);
  const shotPromise = step.noShot
    ? Promise.resolve({ dataUrl: null, scale: 1 })
    : normalizeShot(shot, BUF.shot);

  bufWrite(step, shotPromise);

  const n = (await get(K.bufIndex, [])).length + 1;
  return { ok: true, count: Math.min(n, BUF.maxSteps) };
}

/* Buffer -> real guide. Copies a slice of one session into the normal guide
 * keyspace and runs the same finalizeGuide() a recording gets, so a promoted
 * guide is indistinguishable from a recorded one downstream — the dashboard, the
 * exporters and publish.js need to know nothing about buffering.
 *
 * `opts.minutes` is the "last 2 minutes" case and is measured back from the
 * *session's* own end, not from now, so an older card offers its own last two
 * minutes rather than an empty slice. `opts.n` is a step count, kept because the
 * page-side callers had it. Neither is required: no options promotes the whole
 * most recent session.
 *
 * The steps are left in the buffer. Promoting is not consuming: the common case
 * is realising you want a *different* slice of the same few minutes. The session
 * is marked redeemed instead, which is what takes its card out of the pending
 * list without taking the minutes away. */
async function promoteBuffer(opts) {
  await bufChain;
  const o = typeof opts === "number" ? { n: opts } : opts || {};
  const steps = await bufList();
  if (!steps.length) return { ok: false, error: "Nothing captured yet." };

  const sessions = groupSessions(steps);
  const sess = o.sessionId
    ? sessions.filter((s) => s.id === o.sessionId)[0]
    : sessions[sessions.length - 1];
  if (!sess) return { ok: false, error: "That capture has expired." };

  let take = sess.steps;
  if (o.minutes) {
    // Measured back from the session's end, which is also why this can never
    // slice to nothing: the last step sits *at* `endedAt`, so it satisfies any
    // positive window. No empty-guide guard needed, and one was written and then
    // deleted for being unreachable — don't add it back.
    const from = sess.endedAt - o.minutes * 60000;
    take = take.filter((s) => (s.timestamp || 0) >= from);
  }
  if (o.n) take = take.slice(Math.max(0, take.length - o.n));

  const guideId = uid();
  const first = take[0] || {};
  const writes = {};
  const order = [];
  take.forEach((s, i) => {
    const id = uid();
    order.push(id);
    writes[K.step(id)] = { ...s, id, guideId, seq: i + 1 };
  });

  /* The buffered API log is copied, not moved — the buffer is not consumed by
   * promoting, so a second slice of the same minutes must still get its requests.
   * Only entries inside the slice are carried over; attachNetwork's window would
   * reject the rest anyway, but filtering first keeps the pass small. */
  const netEntries = await get(K.bufNet, []);
  if (netEntries.length) {
    const copied = order.map((id) => writes[K.step(id)]);
    const from = (copied[0] || {}).timestamp || 0;
    const to = ((copied[copied.length - 1] || {}).timestamp || 0) + NET.windowMs;
    attachNetwork(copied, netEntries.filter((e) => e.ts >= from && e.ts <= to));
  }

  const index = await get(K.index, []);
  index.unshift({
    id: guideId,
    title: "Untitled guide — " + new Date().toLocaleString(),
    createdAt: Date.now(),
    startUrl: first.url || "",
    stepCount: take.length,
    fromBuffer: true,
  });
  writes[K.index] = index;
  writes[K.order(guideId)] = order;
  await set(writes);
  await markRedeemed(sess.id);
  await finalizeGuide(guideId);
  broadcast({ type: "fs_buf_changed" });
  return { ok: true, guideId, count: take.length };
}

/* ------------------------------------------------------- the API log (network)
 *
 * What fired, and what came back, for each step. A bug report that says
 * "Click Save -> POST /api/orders -> 500" is actionable by a person or a model;
 * "clicked Save, it didn't work" is a guessing game. This is a handoff feature
 * first, which is why `aiText()` is the only export that emits it.
 *
 * **Two tiers, and the line between them is the whole design.**
 *
 * Tier 1 — the summary — is `chrome.webRequest`: method, path, status, duration.
 * `webRequest` **cannot read a response body**, at any permission level, and
 * never could. So the summary is free of the one thing that makes this feature
 * dangerous, and it is on for every recording.
 *
 * Tier 2 — the whole *failed* exchange, as a cURL — needs the page's own
 * `fetch`/`XHR`, so `netpatch.js` runs in the MAIN world and posts what it sees
 * back: request method, request headers, the body that was sent, and the body that
 * came back. It is **opt-in and off by default on both surfaces**, capped,
 * truncated, and limited to `status >= 400`. Four reasons for those limits:
 *
 * 1. **You cannot redact what you never saw.** Redaction in this product is
 *    visual — you look at a screenshot and drag a box over it. Nobody reads a
 *    2KB JSON blob before sharing it, so the only safe body is one narrow enough
 *    to reason about in the abstract: a failure envelope, not a customer record.
 * 2. **Header names are captured; credential values never are.** That a request
 *    carried an `authorization` header is the diagnosis; the token is not. The
 *    value is replaced with a mask in the page (netpatch.js) *and* again here
 *    (`netScrubHeaders`) — one of the two has to be the last word, and the page
 *    side means a secret never crosses the boundary at all. There is no toggle to
 *    keep a real token and there should not be one: the destination for this data
 *    is a chat window.
 * 3. **Query values are masked, names kept.** `?token=…&page=…` identifies the
 *    endpoint and its shape without carrying the id or the session key.
 * 4. **`Cookie` is out of reach anyway.** The browser attaches it below the page's
 *    fetch, and an HttpOnly cookie is invisible to page script. So a captured cURL
 *    is the shape of a call, never a replayable session.
 *
 * `webRequest` here is observational only — no blocking, no `declarativeNetRequest`,
 * nothing that alters a request. It is a new permission, though, which the store
 * listing has to account for.
 */
const NET = {
  // Requests are attributed to the step they follow, so this is how long after a
  // click a request can land and still be considered its consequence.
  windowMs: 10000,
  // Generous, because the editor has a place to read all of them (the API log
  // drawer) and a step that fired 30 requests is exactly the step someone is
  // trying to debug. The *inline* view is what stays small — that is a display
  // decision, not a capture one, and conflating the two is how you end up unable
  // to answer the question the user actually has.
  maxPerStep: 50,
  // Per guide, and per buffer. Entries are ~120 bytes; bodies dominate, which is
  // what the separate body caps are for.
  maxEntries: 600,
  // Bodies arrive for every call now, not only failures. At ~2KB of kept text each
  // this is a few hundred KB per guide — one screenshot — and a step firing 40
  // requests is exactly the step someone is debugging.
  maxBodies: 250,
  // The request side arrives for every call, not only failures, so it needs its own
  // and larger ceiling: at ~400 bytes an entry this is well under a megabyte per
  // guide, and one shared cap would let successful requests eat the room error
  // bodies need.
  maxReqs: 400,
  // A failure envelope is usually a few hundred characters; a stack trace can be
  // several thousand, and cutting one in half wastes the whole point of keeping it.
  // 40 bodies at this size is ~320KB per guide, which is nothing next to one
  // screenshot.
  bodyChars: 8192,
  // A sent body is usually smaller than the response, and a huge one is a file
  // upload rather than an API call worth reading.
  reqBodyChars: 4096,
  maxHeaders: 30,
  headerChars: 300,
  // Substring match, lower-cased. Same list as netpatch.js's MASKED_HEADER, kept
  // in both places on purpose — the page-side mask means a credential never
  // crosses the boundary, this one means a page that posts an unmasked value
  // still cannot get it stored.
  maskedHeader: /auth|cookie|token|secret|api[-_]?key|session|credential|signature/i,
  // Keys inside a body, request or response. The response case is the one that
  // matters most now that a 200 is captured: a sign-in returns the token this is
  // here to keep out of a guide. Mirrors netpatch.js's MASKED_KEY.
  maskedKey: /pass|pwd|token|secret|otp|auth|card|cvv|cvc|ssn|api[-_]?key|credential/i,
  mask: "…GuideGen-masked…",
  // `xmlhttprequest` covers fetch as well as XHR in Chrome. Everything else is
  // page furniture — images, fonts, stylesheets — or telemetry (`ping` is
  // sendBeacon), and an API log full of font requests is not an API log.
  types: { xmlhttprequest: 1 },
};

function netPath(url) {
  try {
    const u = new URL(url);
    // Parameter *names* kept, values masked. The names are part of what identifies
    // the call — `?page=2&token=…` is a different request from `?export=1` — while
    // the values are where ids, tokens and session keys ride. Stripping the query
    // wholesale (which this used to do) made two different failures look identical
    // in the log, and made the cURL a guess.
    let q = "";
    if (u.search) {
      const parts = [];
      u.searchParams.forEach((v, k) => { parts.push(k + "=" + (v ? "…" : "")); });
      q = "?" + (parts.length ? parts.join("&") : "…");
    }
    return u.pathname + q;
  } catch (e) {
    return "";
  }
}
function netHost(url) {
  try { return new URL(url).host; } catch (e) { return ""; }
}
function netScheme(url) {
  try { return new URL(url).protocol.replace(":", ""); } catch (e) { return "https"; }
}

/* The last word on request headers. netpatch.js already masked these in the page,
 * which is the mask that matters — a value that never crosses the boundary cannot
 * be stored. This one exists because the channel is `postMessage` and the page can
 * write to it too: a hostile page could post `authorization: <real token>` and,
 * without this, have the extension store it for them. Also where the caps live, so
 * a page cannot make one entry arbitrarily large. */
function netScrubHeaders(pairs) {
  if (!Array.isArray(pairs)) return [];
  const out = [];
  for (const p of pairs) {
    if (out.length >= NET.maxHeaders) break;
    const k = String((p && p[0]) || "").slice(0, 80).trim();
    if (!k) continue;
    const raw = String((p && p[1]) || "");
    out.push([k, NET.maskedHeader.test(k) ? NET.mask : raw.slice(0, NET.headerChars)]);
  }
  return out;
}

// requestId -> when it started, so a duration can be reported without keeping the
// whole request. In memory and disposable: a worker restart costs some durations,
// never a whole entry.
const netStarted = {};

let netChain = Promise.resolve();
// requestId -> entry, for the short window between the summary landing and a body
// arriving from the MAIN world for the same request. Matched on method+url+status
// rather than requestId, because the page has no idea what a requestId is.
let netAwaitingBody = [];

async function netTarget(tab) {
  // Which log this request belongs to, or null for "don't record it". Recording
  // wins over buffering exactly as it does for a click.
  if (!tab || tab.id == null || tab.incognito) return null;
  const state = await get(K.state, {});
  if (state.recording) return { kind: "rec", key: K.net(state.guideId), bodies: !!state.captureBodies };
  if (await bufArmed(tab.url || "")) {
    return { kind: "buf", key: K.bufNet, bodies: !!(await get(K.bufBodies, false)) };
  }
  return null;
}

function netAppend(key, entry, isBuf) {
  netChain = netChain
    .then(async () => {
      let list = await get(key, []);
      list.push(entry);
      if (isBuf) {
        // Buffered entries expire with the sessions they belong to, or the API log
        // would outlive the steps it describes.
        const cutoff = Date.now() - BUF.maxAgeMs;
        list = list.filter((e) => (e.ts || 0) >= cutoff);
      }
      if (list.length > NET.maxEntries) list = list.slice(list.length - NET.maxEntries);
      await set({ [key]: list });
    })
    .catch(() => {});
}

function netRecord(details, status, error) {
  if (!NET.types[details.type]) return;
  if (details.tabId == null || details.tabId < 0) return;
  const started = netStarted[details.requestId];
  delete netStarted[details.requestId];
  chrome.tabs.get(details.tabId, async (tab) => {
    if (chrome.runtime.lastError) return;
    const target = await netTarget(tab);
    if (!target) return;
    const entry = {
      ts: Date.now(),
      tabId: details.tabId,
      method: details.method || "GET",
      host: netHost(details.url),
      path: netPath(details.url),
      status: status || 0,
      ms: started ? Math.max(0, Date.now() - started) : null,
      ok: !error && status >= 200 && status < 400,
    };
    // Only when it isn't https, so the common case costs nothing. The cURL builder
    // assumes https without it.
    const scheme = netScheme(details.url);
    if (scheme !== "https") entry.scheme = scheme;
    if (error) entry.error = String(error).replace(/^net::/, "");
    netAppend(target.key, entry, target.kind === "buf");
    /* Remember it briefly so what netpatch.js sends can be matched to it. Every
     * request, whatever its status: the exchange is captured in full when the user
     * asked for it, and the status is not what decides whether they will want it. */
    if (target.bodies) {
      netAwaitingBody.push({ entry, key: target.key, isBuf: target.kind === "buf" });
      netAwaitingBody = netAwaitingBody.filter((x) => Date.now() - x.entry.ts < NET.windowMs);
    }
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => { if (NET.types[d.type]) netStarted[d.requestId] = Date.now(); },
  { urls: ["<all_urls>"] }
);
chrome.webRequest.onCompleted.addListener(
  (d) => netRecord(d, d.statusCode, null),
  { urls: ["<all_urls>"] }
);
chrome.webRequest.onErrorOccurred.addListener(
  (d) => netRecord(d, 0, d.error || "failed"),
  { urls: ["<all_urls>"] }
);

/* A failed response's body, forwarded by netpatch.js through recorder.js.
 *
 * Matched to a summary entry that webRequest already recorded, rather than
 * trusted on its own: a page can post anything it likes into its own window, so
 * a body with no matching request is dropped rather than logged. That is also
 * why the body never creates an entry — it only annotates one. */
async function netBody(msg, sender) {
  const tab = sender && sender.tab;
  if (!tab || tab.id == null) return { ok: false };
  const target = await netTarget(tab);
  if (!target || !target.bodies) return { ok: false };
  const status = Number(msg.status) || 0;
  const path = netPath(msg.url);
  const hit = netAwaitingBody.filter(
    (x) =>
      x.key === target.key &&
      x.entry.tabId === tab.id &&
      x.entry.status === status &&
      x.entry.path === path
  )[0];
  if (!hit) return { ok: false };
  netAwaitingBody = netAwaitingBody.filter((x) => x !== hit);

  /* Both halves of every call, and the reason the success/failure line is gone is
   * in the netpatch.js header: nobody knows in advance which request they will need
   * the response of, and "it returned the wrong rows" is not a failure status.
   *
   * What holds instead is the *opt-in* — this code only runs when the user ticked
   * the box for this recording — plus masking, caps, and the fact that none of it is
   * ever uploaded. `netScrubBody` is the worker's own pass over what netpatch.js
   * already masked, because the page shares that channel and could post a token
   * back unmasked. */
  const raw = netScrubBody(String(msg.body || ""));
  const body = raw.slice(0, NET.bodyChars);
  const req = msg.req && typeof msg.req === "object" ? msg.req : null;
  const reqHeaders = req ? netScrubHeaders(req.headers) : [];
  const rawReqBody = netScrubBody(req ? String(req.body || "") : "");
  const reqBody = rawReqBody.slice(0, NET.reqBodyChars);
  netChain = netChain
    .then(async () => {
      const list = await get(target.key, []);
      /* Two caps, because the two halves cost different amounts: a body is kilobytes,
       * a request line is hundreds of bytes. Both are counted per log, and a request
       * that is over the body cap still records its request side — losing the cURL
       * because a response was too long would be the wrong half to drop. */
      const overBodies = list.filter((e) => e.body).length >= NET.maxBodies;
      const overReqs = list.filter((e) => e.reqHeaders || e.reqBody).length >= NET.maxReqs;
      if (overBodies && overReqs) return;
      const e = list.filter(
        (x) => x.ts === hit.entry.ts && x.path === hit.entry.path && x.status === status
      )[0];
      if (!e) return;
      if (body && !overBodies) e.body = body;
      if (body && !overBodies && raw.length > body.length) e.bodyTruncated = raw.length;
      if (overReqs) { await set({ [target.key]: list }); return; }
      if (reqHeaders.length) e.reqHeaders = reqHeaders;
      if (reqBody) e.reqBody = reqBody;
      if (rawReqBody.length > reqBody.length) e.reqBodyTruncated = rawReqBody.length;
      await set({ [target.key]: list });
    })
    .catch(() => {});
  return { ok: true };
}

/* The worker's own pass over a body netpatch.js already masked.
 *
 * Same reasoning as netScrubHeaders: the page shares the `postMessage` channel, so
 * anything arriving on it gets masked here too rather than trusted. Only JSON and
 * form-encoded are walked, which between them are nearly every API body a browser
 * sends or receives; anything else is left as text and bounded by the cap alone.
 * Deliberately duplicated work — one of the two ends has to have the last word. */
function netScrubBody(text) {
  const s = String(text || "");
  if (!s) return "";
  if (/^\s*[{[]/.test(s)) {
    try {
      const walk = (v) => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
          const o = {};
          for (const k of Object.keys(v)) o[k] = NET.maskedKey.test(k) ? NET.mask : walk(v[k]);
          return o;
        }
        return v;
      };
      return JSON.stringify(walk(JSON.parse(s)));
    } catch (e) { /* not JSON after all */ }
  }
  if (/^[^=&\s]+=[^&]*(&|$)/.test(s) && s.indexOf("\n") === -1) {
    try {
      return s.split("&").map((kv) => {
        const i = kv.indexOf("=");
        if (i < 0) return kv;
        const k = kv.slice(0, i);
        return NET.maskedKey.test(decodeURIComponent(k)) ? k + "=" + NET.mask : kv;
      }).join("&");
    } catch (e) { /* leave it */ }
  }
  return s;
}

/* Assigns logged requests to the steps that caused them: the last step at or
 * before the request, in the same tab, within NET.windowMs.
 *
 * Done in one pass at finalize (or at promotion) rather than incrementally as
 * requests land, for two reasons. A request arrives *after* the click that caused
 * it, so attaching on the way in would mean patching an already-written step on
 * every response; and keeping the correlation rule in one place means it can
 * change later without a migration. */
function attachNetwork(steps, entries) {
  if (!steps.length || !entries.length) return 0;
  let used = 0;
  const byStep = {};
  entries.forEach((e) => {
    let best = null;
    for (const s of steps) {
      const t = s.timestamp || 0;
      if (t > e.ts) break;
      if (s.tabId != null && e.tabId != null && s.tabId !== e.tabId) continue;
      best = s;
    }
    if (!best) return;
    if (e.ts - (best.timestamp || 0) > NET.windowMs) return;
    (byStep[best.id] = byStep[best.id] || []).push(e);
  });
  steps.forEach((s) => {
    const list = byStep[s.id];
    if (!list || !list.length) return;
    const keep = list.slice(0, NET.maxPerStep);
    s.network = keep.map((e) => {
      const out = { method: e.method, path: e.path, status: e.status, ms: e.ms, ok: e.ok };
      if (e.host) out.host = e.host;
      if (e.scheme) out.scheme = e.scheme;
      if (e.error) out.error = e.error;
      if (e.body) out.body = e.body;
      if (e.bodyTruncated) out.bodyTruncated = e.bodyTruncated;
      // The request side of a failed exchange — what makes a cURL possible.
      if (e.reqHeaders) out.reqHeaders = e.reqHeaders;
      if (e.reqBody) out.reqBody = e.reqBody;
      if (e.reqBodyTruncated) out.reqBodyTruncated = e.reqBodyTruncated;
      return out;
    });
    // Say when the log is partial rather than silently showing the first twelve.
    if (list.length > keep.length) s.networkMore = list.length - keep.length;
    used += keep.length;
  });
  return used;
}

async function captureStep(step, sender) {
  const state = await get(K.state, {});
  if (!state.recording) return { ok: false };
  const winId = sender && sender.tab ? sender.tab.windowId : undefined;
  // Which tab this happened in. Only the API log reads it — a request and the
  // click that caused it have to be in the same tab to be related at all.
  if (sender && sender.tab && sender.tab.id != null) step.tabId = sender.tab.id;
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

/* An image the *page* sent us, for a note step. Returns the data URL or null.
 *
 * Three things it has to refuse, and the order matters because the cheap test is the
 * one that keeps the rest cheap:
 *
 * 1. **Anything that isn't a base64 `data:image/...`.** A `blob:` or `https:` URL
 *    stored here would make the guide depend on something outside it, and a
 *    `javascript:` one would be handed to an `<img src>` by every consumer. The whole
 *    picture has to live inside the guide, or an export made tomorrow breaks.
 * 2. **SVG**, even as a data URL. It is a document, not a bitmap: it can carry script
 *    and fetch remote references, and it renders inside the editor and in every
 *    export. The four raster types below are all a screenshot or a photo needs.
 * 3. **Anything oversized.** The dashboard downscales to 1600px WebP before sending,
 *    so a legitimate note image is a few hundred KB. The cap is what stops one note
 *    filling `chrome.storage.local`, and it is enforced here rather than there
 *    because the sender is a web page. */
const NOTE_IMG = {
  types: /^data:image\/(png|jpe?g|webp|gif);base64,/i,
  maxChars: 8 * 1024 * 1024,   // ~6MB decoded
};
function cleanImage(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length > NOTE_IMG.maxChars) return null;
  if (!NOTE_IMG.types.test(s)) return null;
  // Base64 only past the comma — a stray quote or angle bracket means it isn't.
  const body = s.slice(s.indexOf(",") + 1);
  if (!body.length || /[^A-Za-z0-9+/=\s]/.test(body)) return null;
  return s;
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

    /* Pending catch-up captures, so the library can show them beside real guides
     * with their expiry. Metadata only — no steps and no screenshots, because a
     * session is not a guide yet and there is nothing here to render. Anything
     * the user wants to *see* has to be promoted first, which is the same
     * deliberate act it has always been. */
    case "gg_buf_sessions":
      return { ok: true, sessions: await bufSessions() };

    case "gg_buf_promote":
      return await promoteBuffer({
        sessionId: String(msg.sessionId || ""),
        // Clamped: a web page is on the other end, and an absurd window would
        // otherwise be handed straight to a filter comparison.
        minutes: Math.max(0, Math.min(Number(msg.minutes) || 0, 24 * 60)),
      });

    case "gg_buf_discard":
      return await discardSession(String(msg.sessionId || ""));

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
      /* The one-paragraph intro shown above the steps on a published guide. Capped
       * here rather than only in the editor, because a web page is the sender. */
      if (typeof p.description === "string") gi.description = p.description.slice(0, 600);
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
      /* The API log is removable but not editable. The page may clear it — that is
       * the per-step escape hatch for a response body nobody read before it was
       * captured — and may not write one, because a log the extension did not
       * observe is not a log. Anything non-empty is rejected rather than trusted. */
      if (Array.isArray(p.network) && p.network.length === 0) {
        delete s.network;
        delete s.networkMore;
      }
      /* A note's picture can be changed or taken off again — `null` removes it. Only
       * for a note: a recorded step's screenshot is evidence of what was on screen at
       * the moment of the click, and letting a page overwrite it would make a guide
       * something you can quietly rewrite the history of. Redactions go with it,
       * because a rect that pixelated something in the old image lands somewhere
       * arbitrary in the new one. */
      if (s.type === "note" && "image" in p) {
        if (p.image === null) {
          s.screenshot = null;
          s.blurs = [];
        } else {
          const shot = cleanImage(p.image);
          if (!shot) return { ok: false, error: "That image couldn't be read." };
          s.screenshot = shot;
          s.dpr = 1;
          s.blurs = [];
        }
      }
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

    /* A note, inserted where the user pressed the + rather than appended to the end.
     * It may carry a picture of its own — one they chose, not one we captured — so a
     * note is now either a caption on an image or a section divider, which is what
     * makes it worth having at all.
     *
     * Everything here is validated as if a stranger sent it, because a web page did:
     * the index is clamped rather than trusted, and the image has to survive
     * `cleanImage()` before it is stored. */
    case "gg_add_note": {
      const gi = (await get(K.index, [])).find((g) => g.id === guideId);
      if (!gi) return { ok: false, error: "That guide isn't on this device." };
      const order = await get(K.order(guideId), []);
      let shot = null;
      if (msg.image != null) {
        shot = cleanImage(msg.image);
        if (!shot) return { ok: false, error: "That image couldn't be read." };
      }
      const step = {
        id: uid(),
        guideId,
        seq: 1,
        type: "note",
        text: typeof msg.text === "string" ? msg.text.slice(0, 2000) : "",
        screenshot: shot,
        // 1, because an uploaded image has no CSS-px relationship to anything. The
        // editor's redaction maths reads this and would otherwise scale by a ratio
        // that means nothing here.
        dpr: 1,
        blurs: [],
      };
      /* Clamped, never rejected. A stale index from the page is the page's problem,
       * but the user did press +, and throwing their text away over an off-by-one
       * would be the wrong answer. Absent or unparseable means "at the end"; a
       * number is clamped into range — including a negative one, which read as
       * "append" before `tools/note-test.mjs` said so. */
      const asked = Number(msg.index);
      const at = Number.isFinite(asked)
        ? Math.max(0, Math.min(order.length, Math.floor(asked)))
        : order.length;
      // `fs_steporder_<guideId>` is what defines order; `seq` is a capture-time
      // artefact that nothing downstream reads (every exporter numbers from the
      // array index). Set it to something sensible and don't renumber the guide.
      step.seq = at + 1;
      order.splice(at, 0, step.id);
      await set({ [K.step(step.id)]: step, [K.order(guideId)]: order });
      await setStepCount(guideId, order.length);
      return { ok: true, step: lightStep(step), index: at };
    }

    case "gg_delete_guide": {
      const order = await get(K.order(guideId), []);
      const keys = order.map(K.step);
      keys.push(K.order(guideId));
      // Normally already gone — finalizeGuide folds the API log onto the steps and
      // deletes it — but a guide deleted before it was ever finalized would leave it
      // behind, and an orphaned request log is the last thing to leave lying around.
      keys.push(K.net(guideId));
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
          const g = await startRecording(sender.tab, { bodies: !!msg.bodies });
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
        // ---- the buffer ----
        case "fs_buffer_step": {
          sendResponse(await bufferStep(msg.step, sender));
          break;
        }
        // ---- the API log ----
        /* recorder.js asks for this per tab, once, when it attaches — so every tab
         * that joins a recording gets the patch, not only the one Start was pressed
         * in. Injected from here because a content script cannot reach the MAIN
         * world by itself. */
        case "fs_net_patch": {
          const tabId = sender.tab && sender.tab.id;
          const target = tabId != null ? await netTarget(sender.tab) : null;
          if (target && target.bodies) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId, allFrames: false },
                files: ["netpatch.js"],
                world: "MAIN",
              });
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false });
            }
          } else {
            sendResponse({ ok: false });
          }
          break;
        }
        case "fs_net_body": {
          sendResponse(await netBody(msg, sender));
          break;
        }
        case "fs_buf_status": {
          // Asked by recorder.js on load and by the popup on open. The url comes
          // from the sender's own tab for a content script, so a page cannot ask
          // whether some *other* origin is armed.
          const url = (sender.tab && sender.tab.url) || msg.url || "";
          const origin = originOf(url);
          const sessions = await bufSessions();
          // The session the popup would act on: the most recent one on *this*
          // origin. Not simply the newest, or a click in another tab would leave
          // the popup offering to capture a site you are not looking at.
          const here = sessions.filter((s) => s.origin === origin)[0] || null;
          sendResponse({
            armed: await bufArmed(url),
            origin,
            session: here,
            pending: sessions.filter((s) => !s.redeemedAt).length,
            count: (await get(K.bufIndex, [])).length,
            max: BUF.maxSteps,
            sliceMinutes: Math.round(BUF.sliceMs / 60000),
            days: Math.round(BUF.maxAgeMs / 86400000),
            bodies: await get(K.bufBodies, false),
          });
          break;
        }
        case "fs_buf_bodies": {
          await set({ [K.bufBodies]: !!msg.on });
          // Turning it off drops what is already held, rather than only stopping new
          // ones. "Off" has to mean the bodies are gone, or the switch is a promise
          // about the future and nothing about the past.
          if (!msg.on) {
            const list = (await get(K.bufNet, [])).map((e) => {
              const out = { ...e };
              delete out.body;
              delete out.bodyTruncated;
              // The whole exchange goes, not only the response: the request headers
              // and the sent body are Tier 2 too, and leaving them behind would make
              // "off" mean half off.
              delete out.reqHeaders;
              delete out.reqBody;
              delete out.reqBodyTruncated;
              return out;
            });
            await set({ [K.bufNet]: list });
          }
          sendResponse({ ok: true });
          break;
        }
        case "fs_buf_sessions": {
          sendResponse({ ok: true, sessions: await bufSessions() });
          break;
        }
        case "fs_buf_discard": {
          sendResponse(await discardSession(msg.sessionId));
          break;
        }
        case "fs_buf_arm": {
          const origins = await setBufArmed(msg.origin, !!msg.on);
          if (msg.on && msg.tabId != null) await ensureInjected(msg.tabId);
          sendResponse({ ok: true, origins });
          break;
        }
        case "fs_buf_promote": {
          sendResponse(await promoteBuffer(msg));
          break;
        }
        /* The pill's own "Capture last 2 minutes" — the slice, for the session on
         * the sender's own origin. No sessionId crosses the boundary: the page's
         * pill knows nothing about sessions, and resolving it here from
         * `sender.tab.url` is the same rule `fs_buf_status` uses, so the button can
         * only ever redeem the site it is sitting on. */
        case "fs_buf_capture": {
          const url = (sender.tab && sender.tab.url) || "";
          const here = (await bufSessions()).filter((s) => s.origin === originOf(url))[0];
          if (!here) {
            sendResponse({ ok: false, error: "Nothing is held for this site yet." });
            break;
          }
          sendResponse(
            await promoteBuffer({ sessionId: here.id, minutes: BUF.sliceMs / 60000 })
          );
          break;
        }
        case "fs_buf_clear": {
          sendResponse(await clearBuffer());
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
