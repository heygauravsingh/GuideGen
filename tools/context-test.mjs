// Drives the real background.js context-step logic with a stubbed chrome.
// Asserts what does and does not become a step.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function harness() {
  const store = {};
  const listeners = { activated: [], updated: [] };
  const captures = [];

  const chrome = {
    runtime: {
      lastError: null,
      id: "dijeonandicniffeffbcolhfldommhnp",
      onMessage: { addListener() {} },
      onMessageExternal: { addListener() {} },
      onConnectExternal: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      getURL: (p) => "chrome-extension://x/" + p,
      sendMessage() {},
    },
    storage: {
      local: {
        get(key, cb) {
          if (typeof key === "string") return cb(key in store ? { [key]: store[key] } : {});
          const out = {};
          (Array.isArray(key) ? key : Object.keys(key || {})).forEach((k) => {
            if (k in store) out[k] = store[k];
          });
          cb(out);
        },
        set(obj, cb) { Object.assign(store, obj); cb && cb(); },
        remove(k, cb) { delete store[k]; cb && cb(); },
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      query: (q, cb) => cb([]),
      sendMessage() {},
      get(id, cb) { cb(harnessTabs[id]); },
      captureVisibleTab: async (winId) => { captures.push(winId); return "data:image/png;base64,AAA"; },
      onActivated: { addListener: (fn) => listeners.activated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
      onRemoved: { addListener() {} },
      create() {}, update() {},
    },
    scripting: { insertCSS: async () => {}, executeScript: async () => {} },
    downloads: { download() {}, onChanged: { addListener() {}, removeListener() {} } },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    action: { onClicked: { addListener() {} } },
    identity: { getRedirectURL: () => "https://x.chromiumapp.org/" },
    windows: { onFocusChanged: { addListener() {} } },
  };

  const harnessTabs = {};

  const sandbox = {
    chrome,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Date, Math, JSON, Object, Array, String, Number, Error, URL, URLSearchParams,
    RegExp, Boolean, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    fetch: async () => ({ ok: true, json: async () => ({}), blob: async () => ({ size: 5, type: "image/png" }) }),
    crypto: webcrypto,
    // normalizeShot needs these; return a plausible downscale.
    createImageBitmap: async () => ({ width: 3024, height: 1700, close() {} }),
    OffscreenCanvas: class {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() { return { drawImage() {}, imageSmoothingEnabled: true, imageSmoothingQuality: "" }; }
      async convertToBlob() { return { size: 1234, type: "image/webp", arrayBuffer: async () => new ArrayBuffer(8) }; }
    },
    FileReader: class {
      readAsDataURL() { setTimeout(() => { this.result = "data:image/webp;base64,BBB"; this.onload && this.onload(); }, 1); }
    },
    Blob: class { constructor(p, o) { this.size = 1; this.type = (o || {}).type || ""; } },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    importScripts: () => {},   // sync.js is not under test here
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(ROOT + "/background.js", "utf8"), ctx, { filename: "background.js" });

  return { sandbox, ctx, store, listeners, captures, harnessTabs };
}

const tick = () => new Promise((r) => setTimeout(r, 400));   // enqueueCapture waits 70ms before capturing

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}

function stepsOf(h) {
  const order = Object.keys(h.store).find((k) => k.startsWith("fs_steporder_"));
  const ids = order ? h.store[order] : [];
  return ids.map((id) => h.store["fs_step_" + id]).map((s) => ({ type: s.type, text: s.text }));
}

// ---------------------------------------------------------------------------
console.log("\n=== 1. click opens a NEW tab: onActivated (blank) then onUpdated ===");
{
  const h = harness();
  h.harnessTabs[1] = { id: 1, windowId: 9, url: "https://www.canva.com/", title: "Home - Canva", active: true };
  h.store.fs_state = { recording: true, guideId: "g1", stepCount: 0 };
  h.store["fs_steporder_g1"] = [];
  h.store.fs_index = [{ id: "g1", stepCount: 0 }];
  // Seed as if recording started in tab 1.
  h.sandbox.seedContext(h.harnessTabs[1]);

  // A new tab appears and is activated before it has a url.
  h.harnessTabs[2] = { id: 2, windowId: 9, url: "", title: "", active: true };
  h.listeners.activated.forEach((fn) => fn({ tabId: 2 }));
  await tick();
  check("blank new tab makes no step", stepsOf(h), []);

  // Then it finishes loading.
  h.harnessTabs[2] = { id: 2, windowId: 9, url: "https://www.canva.com/design/DAGxyz/edit?ui=abc", title: "Untitled - Canva", active: true };
  h.listeners.updated.forEach((fn) => fn(2, { status: "complete" }, h.harnessTabs[2]));
  await tick();
  check("one nav step, query stripped", stepsOf(h),
        [{ type: "nav", text: "Go to canva.com/design/DAGxyz/edit" }]);
}

// ---------------------------------------------------------------------------
console.log("\n=== 2. switching to an already-loaded tab ===");
{
  const h = harness();
  h.harnessTabs[1] = { id: 1, windowId: 9, url: "https://www.canva.com/", title: "Home - Canva", active: true };
  h.harnessTabs[2] = { id: 2, windowId: 9, url: "https://drive.google.com/drive/my-drive", title: "My Drive - Google Drive", active: true };
  h.store.fs_state = { recording: true, guideId: "g1", stepCount: 0 };
  h.store["fs_steporder_g1"] = [];
  h.store.fs_index = [{ id: "g1", stepCount: 0 }];
  h.sandbox.seedContext(h.harnessTabs[1]);

  h.listeners.activated.forEach((fn) => fn({ tabId: 2 }));
  await tick();
  check("switch step names the tab", stepsOf(h),
        [{ type: "switch", text: 'Switch to the "My Drive - Google Drive" tab' }]);
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. noise the recorder must swallow ===");
{
  const h = harness();
  h.harnessTabs[1] = { id: 1, windowId: 9, url: "https://www.canva.com/", title: "Home - Canva", active: true };
  h.store.fs_state = { recording: true, guideId: "g1", stepCount: 0 };
  h.store["fs_steporder_g1"] = [];
  h.store.fs_index = [{ id: "g1", stepCount: 0 }];
  h.sandbox.seedContext(h.harnessTabs[1]);

  // the tab recording started in, re-announced
  h.listeners.activated.forEach((fn) => fn({ tabId: 1 }));
  await tick();
  check("start tab is not a switch to itself", stepsOf(h), []);

  // same url completing twice
  h.listeners.updated.forEach((fn) => fn(1, { status: "complete" }, h.harnessTabs[1]));
  await tick();
  h.listeners.updated.forEach((fn) => fn(1, { status: "complete" }, h.harnessTabs[1]));
  await tick();
  check("duplicate complete on the same url", stepsOf(h), []);

  // hash-only change
  h.harnessTabs[1] = { ...h.harnessTabs[1], url: "https://www.canva.com/#section" };
  h.listeners.updated.forEach((fn) => fn(1, { status: "complete" }, h.harnessTabs[1]));
  await tick();
  check("hash-only change", stepsOf(h), []);

  // a background tab finishing a load
  h.harnessTabs[3] = { id: 3, windowId: 9, url: "https://example.com/", title: "Example", active: false };
  h.listeners.updated.forEach((fn) => fn(3, { status: "complete" }, h.harnessTabs[3]));
  await tick();
  check("background tab load", stepsOf(h), []);

  // a chrome:// page
  h.harnessTabs[4] = { id: 4, windowId: 9, url: "chrome://extensions/", title: "Extensions", active: true };
  h.listeners.updated.forEach((fn) => fn(4, { status: "complete" }, h.harnessTabs[4]));
  await tick();
  check("chrome:// page", stepsOf(h), []);

  // loading, not complete
  h.harnessTabs[5] = { id: 5, windowId: 9, url: "https://example.org/", title: "Ex", active: true };
  h.listeners.updated.forEach((fn) => fn(5, { status: "loading" }, h.harnessTabs[5]));
  await tick();
  check("status loading", stepsOf(h), []);
}

// ---------------------------------------------------------------------------
console.log("\n=== 4. not recording ===");
{
  const h = harness();
  h.harnessTabs[2] = { id: 2, windowId: 9, url: "https://drive.google.com/", title: "Drive", active: true };
  h.store.fs_state = { recording: false };
  h.listeners.activated.forEach((fn) => fn({ tabId: 2 }));
  h.listeners.updated.forEach((fn) => fn(2, { status: "complete" }, h.harnessTabs[2]));
  await tick();
  check("nothing recorded while idle", stepsOf(h), []);
}

// ---------------------------------------------------------------------------
console.log("\n=== 5. guessTitle ignores context steps ===");
{
  const h = harness();
  const steps = [
    { type: "click", text: 'Click "Presentation"' },
    { type: "nav", text: "Go to canva.com/design/DAGxyz/edit" },
    { type: "switch", text: 'Switch to the "Untitled - Canva" tab' },
  ];
  const title = h.sandbox.guessTitle(steps, "https://www.canva.com/");
  check("title comes from the click, not the tab name", title, "How to view Presentation in Canva");
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
