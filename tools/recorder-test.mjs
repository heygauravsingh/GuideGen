// Drives the real recorder.js in a stubbed DOM with a stubbed chrome.
//
// The point of this file is the orphan cases. Reloading the extension leaves the
// old recorder running in every open page with a dead `chrome.runtime`, and the
// next call throws **synchronously** — so a `lastError` check never sees it and
// neither does a `catch` sitting beside an async callback. That has now reached
// the Errors pane twice from two different call sites, which is what this exists
// to stop happening a third time.
//
// Cases 5 and 6 fail against the recorder.js that was committed before safeSend
// existed, so they are real regression tests and not descriptions of current
// behaviour.
//
// On what is and isn't proven here: safeSend guards in three places — before the
// call, inside the reply, and with a try/catch around the reply's body. Only the
// middle one is isolable. Removing the pre-call `alive()` leaves the outer
// try/catch to catch the synchronous throw and retire anyway, and removing the
// inner try/catch leaves the inner `alive()` to return before anything can throw.
// Both surviving layers cover the same race from the other side — the context can
// die between any two statements, including between a check and the call it
// guards — which is the reasoning the orphan note in CLAUDE.md already sets out.
// They cost nothing and they are deliberate; they are just not testable in
// isolation, so don't delete one because a mutation run called it redundant.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}

function el(tag) {
  const node = {
    tagName: (tag || "div").toUpperCase(),
    className: "", innerHTML: "", style: {}, children: [], attrs: {}, parent: null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; },
    // The pill's markup is built with innerHTML, so the button it looks for has to
    // be findable without a real parser.
    querySelector(sel) {
      if (sel === ".fs-stop") return this._stop || (this._stop = el("button"));
      if (sel === ".fs-count b") return this._count || (this._count = el("b"));
      return null;
    },
    closest() { return null },
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 60, height: 20 }; },
    addEventListener(t, fn) { (this._h = this._h || {}), (this._h[t] = this._h[t] || []).push(fn); },
    removeEventListener(t, fn) { if (this._h && this._h[t]) this._h[t] = this._h[t].filter((f) => f !== fn); },
    fire(t, ev) { ((this._h || {})[t] || []).forEach((f) => f(ev)); },
  };
  return node;
}

function harness(opts) {
  const o = opts || {};
  const sent = [];
  const pending = [];
  const handlers = {};
  const body = el("body");
  const runtime = {
    id: "dijeonandicniffeffbcolhfldommhnp",
    lastError: null,
    onMessage: { addListener() {} },
    sendMessage(msg, cb) {
      // The synchronous throw the whole guard exists for.
      if (!runtime.id) throw new Error("Extension context invalidated.");
      sent.push(msg);
      if (cb) pending.push({ msg, cb });
    },
  };
  const chrome = {
    runtime,
    storage: {
      // Async, as Chrome's is. A synchronous stub here would let recorder.js get
      // away with reading state that has not been declared yet.
      local: { get(k, cb) { setTimeout(() => cb(o.state ? { fs_state: o.state } : {}), 0); } },
      onChanged: { addListener() {} },
    },
  };
  const document = {
    body,
    documentElement: body,
    activeElement: o.activeElement || el("div"),
    createElement: el,
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
    removeEventListener(t, fn) { if (handlers[t]) handlers[t] = handlers[t].filter((f) => f !== fn); },
  };
  const sandbox = {
    chrome, document, console,
    location: { href: "https://dash.uengage.in/orders", origin: "https://dash.uengage.in" },
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2,
    setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, Error, Boolean,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(ROOT + "/recorder.js", "utf8"), ctx, { filename: "recorder.js" });
  return { sandbox, chrome, runtime, sent, pending, handlers, body, document };
}

// A left click on a button-ish element, through the capture-phase listener.
function click(h) {
  const target = el("button");
  target.innerHTML = "Orders";
  target.textContent = "Orders";
  (h.handlers.pointerdown || []).forEach((fn) =>
    fn({ button: 0, target, clientX: 5, clientY: 5, isTrusted: true })
  );
}
function pill(h) { return h.body.children[0]; }
function drain(h, killFirst) {
  const q = h.pending.splice(0);
  if (killFirst) h.runtime.id = undefined;
  q.forEach((p) => p.cb(p.reply === undefined ? { ok: true, count: 1, guideId: "g1" } : p.reply));
}
const settle = () => new Promise((r) => setTimeout(r, 20));

// ---------------------------------------------------------------------------
console.log("\n=== 1. live context, recording ===");
{
  const h = harness({ state: { recording: true, guideId: "g1", stepCount: 0 } });
  await settle();
  check("the pill is up", !!pill(h), true);
  h.sent.length = 0;
  click(h);
  check("the click is sent as a recording step", h.sent.map((m) => m.type), ["fs_capture_step"]);
  check("the pill is hidden for the capture", pill(h).style.visibility, "hidden");
  drain(h);
  check("and restored afterwards", pill(h).style.visibility, "visible");
  check("the pill survives", !!pill(h), true);
}

// ---------------------------------------------------------------------------
console.log("\n=== 2. live context, buffering an armed origin ===");
{
  const h = harness({});
  await settle();
  drain(h);                                   // answer fs_buf_status
  h.pending.length = 0;
  h.sent.length = 0;
  // Re-answer with armed:true by driving askBuffer through a buf_changed message.
  const h2 = harness({});
  await settle();
  h2.pending[0].cb({ armed: true, count: 3, origin: "https://dash.uengage.in" });
  await settle();
  check("a buffering pill goes up", !!pill(h2), true);
  h2.sent.length = 0;
  click(h2);
  check("the click is sent as a buffered step", h2.sent.map((m) => m.type), ["fs_buffer_step"]);
  check("and never as a recording step", h2.sent.some((m) => m.type === "fs_capture_step"), false);
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. a password field on screen while buffering ===");
{
  const pw = el("input");
  pw.type = "password";
  const h = harness({ activeElement: pw });
  await settle();
  h.pending[0].cb({ armed: true, count: 0, origin: "https://dash.uengage.in" });
  await settle();
  h.sent.length = 0;
  click(h);
  check("the step is still sent", h.sent.length, 1);
  check("with noShot set, so no picture is taken", h.sent[0].step.noShot, true);
}

// ---------------------------------------------------------------------------
console.log("\n=== 4. orphaned BEFORE the click ===");
{
  const h = harness({ state: { recording: true, guideId: "g1", stepCount: 0 } });
  await settle();
  h.sent.length = 0;
  h.runtime.id = undefined;                   // the extension was reloaded
  let threw = null;
  try { click(h); } catch (e) { threw = String(e.message); }
  check("nothing is thrown", threw, null);
  check("nothing is sent", h.sent.length, 0);
  check("the pill is taken away", h.body.children.length, 0);
  check("the listeners are detached", (h.handlers.pointerdown || []).length, 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== 5. orphaned BETWEEN the send and the reply ===");
// The case a `try` around sendMessage cannot catch: the callback runs long after
// that block has returned, and reading chrome.runtime.lastError in a dead context
// throws on the lookup itself.
{
  const h = harness({ state: { recording: true, guideId: "g1", stepCount: 0 } });
  await settle();
  h.sent.length = 0;
  click(h);
  check("the step went out while the context was alive", h.sent.length, 1);
  let threw = null;
  try { drain(h, true); } catch (e) { threw = String(e.message); }
  check("the reply handler does not throw", threw, null);
  check("and the orphaned pill is removed", h.body.children.length, 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== 6. orphaned between the pill's button and its reply ===");
// Two chained calls: fs_stop, then fs_open_editor built from the response. The
// second runs inside the first's callback, so it needs its own guard.
{
  const h = harness({ state: { recording: true, guideId: "g1", stepCount: 0 } });
  await settle();
  h.sent.length = 0;
  pill(h).querySelector(".fs-stop").fire("click", { stopPropagation() {}, preventDefault() {} });
  check("the button asks the worker to stop", h.sent.map((m) => m.type), ["fs_stop"]);
  let threw = null;
  try { drain(h, true); } catch (e) { threw = String(e.message); }
  check("the chained fs_open_editor does not throw", threw, null);
  check("no second message escaped", h.sent.map((m) => m.type), ["fs_stop"]);
}

// ---------------------------------------------------------------------------
console.log("\n=== 7. idle: armed nowhere, not recording ===");
{
  const h = harness({});
  await settle();
  h.pending.forEach((p) => p.cb({ armed: false, count: 0, origin: "https://example.com" }));
  await settle();
  check("no pill", h.body.children.length, 0);
  h.sent.length = 0;
  click(h);
  check("a click sends nothing", h.sent.length, 0);
}

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
