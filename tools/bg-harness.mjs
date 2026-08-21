// A real background.js running in a vm with a stubbed `chrome`.
//
// Extracted from context-test.mjs so the buffer tests can drive the same worker
// rather than keeping a second copy of this in sync by hand. If a test needs a
// chrome API that isn't here, add it here — a missing stub throws inside the
// worker and surfaces as an unrelated assertion failure two tests later.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function harness() {
  const store = {};
  const listeners = { activated: [], updated: [], message: [] };
  const captures = [];
  const broadcasts = [];
  const harnessTabs = {};
  const net = { before: [], completed: [], errored: [] };
  const injected = [];

  const chrome = {
    runtime: {
      lastError: null,
      id: "dijeonandicniffeffbcolhfldommhnp",
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
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
        // Arrays as well as single keys. chrome.storage takes both, and buffer
        // eviction removes a batch — a single-key-only stub silently kept every
        // evicted step, which made the caps look broken when they weren't.
        remove(k, cb) {
          (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]);
          cb && cb();
        },
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      query: (q, cb) => cb([]),
      sendMessage() {},
      /* Asynchronous, because Chrome's is. It used to call back synchronously, and
         that hid a real race: `netRecord` does a `tabs.get` before it remembers a
         request as body-eligible, so in Chrome a body posted by the page can reach
         the worker *first*. A synchronous stub made that ordering impossible to
         reproduce here. Do not make this synchronous again to make a test simpler. */
      get(id, cb) { setTimeout(() => cb(harnessTabs[id]), 0); },
      captureVisibleTab: async (winId) => { captures.push(winId); return "data:image/png;base64,AAA"; },
      onActivated: { addListener: (fn) => listeners.activated.push(fn) },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
      onRemoved: { addListener() {} },
      create() {}, update() {},
    },
    // Observational only — no blocking, no onBeforeSendHeaders. If a test ever needs
    // a header listener here, that is a signal to check why: headers are the one
    // thing the API log deliberately never reads.
    webRequest: {
      onBeforeRequest: { addListener: (fn) => net.before.push(fn) },
      onCompleted: { addListener: (fn) => net.completed.push(fn) },
      onErrorOccurred: { addListener: (fn) => net.errored.push(fn) },
    },
    scripting: {
      insertCSS: async () => {},
      // Records what was injected and into which world, which is how the Tier 2
      // tests assert that netpatch.js only ever reaches MAIN when it was asked for.
      executeScript: async (opts) => { injected.push(opts); return []; },
    },
    downloads: { download() {}, onChanged: { addListener() {}, removeListener() {} } },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    action: { onClicked: { addListener() {} } },
    identity: { getRedirectURL: () => "https://x.chromiumapp.org/" },
    windows: { onFocusChanged: { addListener() {} } },
  };

  const sandbox = {
    chrome,
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Date, Math, JSON, Object, Array, String, Number, Error, URL, URLSearchParams,
    RegExp, Boolean, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    fetch: async () => ({ ok: true, json: async () => ({}), blob: async () => ({ size: 5, type: "image/png" }) }),
    crypto: webcrypto,
    // normalizeShot needs these; return a plausible retina capture so the
    // downscale factor it folds into `dpr` is a real number.
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

  // Wrapped after load, so the worker's own definition is the one under test.
  // broadcast() fans out through chrome.tabs.query, which has no tabs here, so
  // recording the calls is the only way to see what it told the pages.
  const realBroadcast = sandbox.broadcast;
  sandbox.broadcast = (m) => { broadcasts.push(m); return realBroadcast(m); };

  return { sandbox, ctx, store, listeners, captures, broadcasts, harnessTabs, net, injected };
}

/* Drives one request through the worker's webRequest listeners, start to finish.
 *
 * `status` 0 with an `error` goes down the onErrorOccurred path instead of
 * onCompleted, which is how a connection failure reaches the log — it has no
 * status code at all, and treating it as a 0 response would be a lie. */
let reqId = 0;
export function request(h, opts) {
  const o = opts || {};
  const d = {
    requestId: "r" + ++reqId,
    tabId: o.tabId == null ? 1 : o.tabId,
    type: o.type || "xmlhttprequest",
    method: o.method || "GET",
    url: o.url || "https://api.uengage.in/orders",
  };
  h.net.before.forEach((fn) => fn(d));
  if (o.error) h.net.errored.forEach((fn) => fn({ ...d, error: o.error }));
  else h.net.completed.forEach((fn) => fn({ ...d, statusCode: o.status == null ? 200 : o.status }));
  return d;
}

// Sends through the worker's real onMessage router and resolves with its reply.
export function send(h, msg, sender) {
  return new Promise((res) => {
    let done = false;
    const reply = (r) => { if (!done) { done = true; res(r); } };
    h.listeners.message.forEach((fn) => fn(msg, sender || {}, reply));
    setTimeout(() => reply(undefined), 1500);
  });
}

export const tick = (ms) => new Promise((r) => setTimeout(r, ms == null ? 400 : ms));

/* Evaluates an expression inside the worker's own scope.
 *
 * background.js declares its constants with top-level `const`, which in a vm
 * context live in the global *lexical* environment rather than as properties of
 * the sandbox object — so `h.sandbox.BUF` is undefined while `evalIn(h, "BUF")`
 * works. That is the only way to reach them, and it is what lets a test shrink
 * BUF.maxSteps to 5 instead of writing 245 steps to prove the cap. Read-only
 * peeking is free; when a test mutates, it is mutating the real constant the
 * worker uses, so keep it to fresh harnesses. */
export function evalIn(h, code) {
  return vm.runInContext(code, h.ctx);
}
