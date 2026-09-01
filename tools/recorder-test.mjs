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
    // The catch-up CTA drives these directly: it disables itself while capturing
    // and narrates on the label, so a no-op stub would hide a broken button.
    disabled: false, textContent: "", isConnected: true, nodeType: 1,
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
      if (sel === ".fs-cap") return this._cap || (this._cap = el("button"));
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
  // documentElement doubles as the scroll root: recorder.js reads scrollTop and
  // scrollHeight off it, and a stub without them makes every scroll look like a
  // scroll to the bottom.
  body.scrollTop = 0;
  body.scrollHeight = 6000;
  const document = {
    body,
    documentElement: body,
    activeElement: o.activeElement || el("div"),
    createElement: el,
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
    removeEventListener(t, fn) { if (handlers[t]) handlers[t] = handlers[t].filter((f) => f !== fn); },
  };
  // The MAIN-world channel for Tier 2 response bodies. recorder.js listens on
  // `window` for these, so the sandbox needs real listener plumbing — not a no-op
  // stub, or the relay would look wired when nothing reaches it.
  const winHandlers = {};
  const sandbox = {
    chrome, document, console,
    location: { href: "https://dash.uengage.in/orders", origin: "https://dash.uengage.in" },
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2, scrollY: 0,
    setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, Error, Boolean,
    addEventListener(t, fn) { (winHandlers[t] = winHandlers[t] || []).push(fn); },
    removeEventListener(t, fn) {
      if (winHandlers[t]) winHandlers[t] = winHandlers[t].filter((f) => f !== fn);
    },
  };
  sandbox.window = sandbox;
  sandbox.winHandlers = winHandlers;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(ROOT + "/recorder.js", "utf8"), ctx, { filename: "recorder.js" });
  // `window` inside the vm is the context's global *proxy*, not the object handed to
  // createContext — so `sandbox !== window` in there, and a message posted with
  // `source: sandbox` fails recorder.js's `e.source !== window` guard. Reach in for
  // the proxy so a test can pretend to be the page.
  const win = vm.runInContext("window", ctx);
  return { sandbox, win, chrome, runtime, sent, pending, handlers, body, document, winHandlers };
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

// ---------------------------------------------------------------------------
// The relay out of the MAIN world. Whatever posts this — netpatch.js or the page
// itself — the shape that reaches the worker has to be flat, capped and boring.
console.log("\n=== 8. the netpatch relay reshapes rather than forwards ===");
{
  const h = harness({ state: { recording: true, guideId: "g1", stepCount: 0 } });
  await settle();
  h.sent.length = 0;
  const post = (data) =>
    (h.winHandlers.message || []).forEach((fn) => fn({ source: h.win, data }));

  post({
    source: "gg_net_body", url: "https://api.x/orders", status: 500, body: "boom",
    req: {
      method: "post",
      headers: [["content-type", "application/json"], ["x-nope"], null],
      body: '{"a":1}',
      extra: { deep: { deeper: 1 } },
    },
  });
  const m = h.sent.filter((x) => x.type === "fs_net_body")[0];
  check("the exchange goes to the worker", !!m, true);
  check("the method is normalised", m.req.method, "POST");
  check("a header with no value is kept as a name; a null pair is dropped",
        m.req.headers, [["content-type", "application/json"], ["x-nope", ""]]);
  check("nothing else on req survives the reshape",
        Object.keys(m.req).sort(), ["body", "headers", "method"]);

  h.sent.length = 0;
  const heads = [];
  for (let i = 0; i < 80; i++) heads.push(["h" + i, "v".repeat(2000)]);
  post({ source: "gg_net_body", url: "https://api.x/orders", status: 500, body: "b",
         req: { method: "POST", headers: heads, body: "" } });
  const big = h.sent.filter((x) => x.type === "fs_net_body")[0];
  check("headers are capped before they leave the page", big.req.headers.length, 40);
  check("and each value with them", big.req.headers[0][1].length, 400);

  h.sent.length = 0;
  post({ source: "gg_net_body", url: "https://api.x/orders", status: 500, body: "b", req: "nonsense" });
  check("a junk req becomes null rather than throwing",
        h.sent.filter((x) => x.type === "fs_net_body")[0].req, null);

  h.sent.length = 0;
  post({ source: "something-else", url: "https://api.x/orders", status: 500, body: "b" });
  check("another page's postMessage is ignored", h.sent.length, 0);
}

// ---------------------------------------------------------------------------
// The catch-up pill's "Capture last 2 min". The button sits in the *page's* DOM,
// so the case that matters is a page clicking it itself.
console.log("\n=== 9. the catch-up CTA ===");
{
  const h = harness({});
  await settle();
  h.pending[0].cb({ armed: true, count: 12, origin: "https://dash.uengage.in" });
  await settle();
  const cap = pill(h).querySelector(".fs-cap");
  h.sent.length = 0;

  // A page script can reach this button and call .click() on it. That must not
  // mint a guide out of a buffer nobody asked to redeem.
  cap.fire("click", { isTrusted: false, stopPropagation() {}, preventDefault() {} });
  check("a synthetic click redeems nothing", h.sent.length, 0);

  cap.fire("click", { isTrusted: true, stopPropagation() {}, preventDefault() {} });
  check("a real click asks the worker for the slice",
        h.sent.map((m) => m.type), ["fs_buf_capture"]);
  // No sessionId crosses the boundary — the worker resolves it from the sender's
  // own tab, so the button cannot name someone else's session.
  check("and names no session", Object.keys(h.sent[0]), ["type"]);
  check("the button locks while it works", [cap.disabled, cap.textContent],
        [true, "Capturing…"]);

  h.pending.forEach((p) => p.cb({ ok: true, guideId: "g9", count: 7 }));
  check("the new guide is opened", h.sent.map((m) => m.type),
        ["fs_buf_capture", "fs_open_editor"]);
  check("and it says so", cap.textContent, "Opening…");
}
{
  const h = harness({});
  await settle();
  h.pending[0].cb({ armed: true, count: 0, origin: "https://dash.uengage.in" });
  await settle();
  const cap = pill(h).querySelector(".fs-cap");
  cap.fire("click", { isTrusted: true, stopPropagation() {}, preventDefault() {} });
  h.pending.forEach((p) => p.cb({ ok: false, error: "Nothing is held for this site yet." }));
  check("an empty buffer says so on the button, and no editor opens",
        [cap.textContent, h.sent.some((m) => m.type === "fs_open_editor")],
        ["Nothing held yet", false]);
}
{
  // The orphan case, on the newest chrome call in the file. The reply arrives
  // after the context has died, which is where the two shipped bugs both were.
  const h = harness({});
  await settle();
  h.pending[0].cb({ armed: true, count: 12, origin: "https://dash.uengage.in" });
  await settle();
  const cap = pill(h).querySelector(".fs-cap");
  cap.fire("click", { isTrusted: true, stopPropagation() {}, preventDefault() {} });
  let threw = null;
  try { drain(h, true); } catch (e) { threw = String(e.message); }
  check("an orphaned reply does not throw", threw, null);
}

// ---------------------------------------------------------------------------
// Typing and scrolling — the two things that were invisible, and the reason a
// search API never made it into a log: `change` only fires on blur, so typing
// produced no step, and a request with no step before it is dropped by
// attachNetwork.
console.log("\n=== 10. typing becomes a step while it happens ===");

function field(value, type) {
  const f = el("input");
  f.type = type || "text";
  f.value = value;
  f.isContentEditable = false;
  // describeInput looks for a label; without one it falls back to the placeholder.
  f.attrs.placeholder = "Search by name";
  f.getAttribute = (k) => f.attrs[k];
  return f;
}
function key(h, k, target, mods) {
  (h.handlers.keydown || []).forEach((fn) =>
    fn(Object.assign({ key: k, target, isTrusted: true, repeat: false }, mods || {})));
}
function type(h, f, value) {
  if (value !== undefined) f.value = value;
  (h.handlers.input || []).forEach((fn) => fn({ target: f, isTrusted: true }));
}
const rec = () => harness({ state: { recording: true, guideId: "g1", stepCount: 0 } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

{
  const h = rec();
  await settle();
  h.sent.length = 0;
  const f = field("");
  const t0 = Date.now();
  // Four keystrokes, as a person types.
  for (const v of ["D", "De", "Dem", "Demo"]) { type(h, f, v); await wait(40); }
  check("nothing is sent mid-burst", h.sent.length, 0);
  await wait(750);
  check("the settle sends exactly one step", h.sent.length, 1);
  check("with the whole value, not the first letter",
        /Type "Demo"/.test(h.sent[0].step.text), true);
  /* Stamped at the *first* keystroke, not the settle. The search requests fire while
     you type — a step stamped at the end sits after its own consequences, and
     attachNetwork hands them to the previous step instead. This is the assertion that
     protects the fix for the missing search API. */
  check("stamped when the typing began, so its requests land on it",
        h.sent[0].step.timestamp <= t0 + 60, true);
}
{
  /* Real typing fires a `keydown` per character as well as an `input`, and onKeyDown
     used to flush the burst before deciding whether the key was a step of its own —
     so every letter after the first ended the previous one. "Demo" came out as four
     steps: `Type "D"`, `Type "De"`, `Type "Dem"`, `Type "Demo"`. Fails against the
     version that flushes at the top of onKeyDown. */
  const h = rec();
  await settle();
  h.sent.length = 0;
  const f = field("");
  const chars = ["D", "e", "m", "o"];
  let val = "";
  for (const c of chars) {
    key(h, c, f);            // keydown, as a keyboard produces
    val += c;
    type(h, f, val);
    await wait(40);
  }
  check("a plain character never ends the burst", h.sent.length, 0);
  key(h, "Enter", f);
  check("Enter flushes it as one step, then records itself",
        h.sent.map((m) => m.step.text), ['Type "Demo" in the "Search by name" field', "Press Enter"]);
  await wait(750);
  check("and the settle adds nothing after it", h.sent.length, 2);
}
{
  const h = rec();
  await settle();
  h.sent.length = 0;
  const f = field("");
  type(h, f, "Demo");
  // The click comes before the 650ms settle would have fired.
  click(h);
  check("a click flushes the pending typing first, in order",
        h.sent.map((m) => m.step.type), ["input", "click"]);
  check("and the click is not swallowed by the typing's own debounce",
        h.sent.filter((m) => m.step.type === "click").length, 1);
  await wait(750);
  check("the settle does not then send it twice", h.sent.length, 2);
}
{
  const h = rec();
  await settle();
  h.sent.length = 0;
  const f = field("");
  type(h, f, "Demo");
  await wait(750);
  // Blurring after typing fires `change` with the same value. Without the dedupe
  // that is the same step twice.
  (h.handlers.change || []).forEach((fn) => fn({ target: f }));
  check("blurring afterwards does not record it again", h.sent.length, 1);
}
{
  const h = rec();
  await settle();
  h.sent.length = 0;
  const p = field("hunter2", "password");
  type(h, p);
  await wait(750);
  check("a typed password is never the value", /hunter2/.test(JSON.stringify(h.sent)), false);
  check("it says what was typed without saying it",
        /Type your password/.test(h.sent[0].step.text), true);
}
{
  const h = rec();
  await settle();
  h.sent.length = 0;
  const f = field("");
  type(h, f, "x");
  type(h, f, "");        // typed and cleared
  await wait(750);
  check("typing and clearing is not a step", h.sent.length, 0);
}

console.log("\n=== 11. scrolling, stingily ===");
{
  const h = rec();
  await settle();
  h.sent.length = 0;
  const scroll = (y) => {
    h.sandbox.scrollY = y;
    h.body.scrollTop = y;
    (h.handlers.scroll || []).forEach((fn) => fn({ target: h.body }));
  };
  scroll(120);
  await wait(600);
  check("a nudge is not a step", h.sent.length, 0);
  scroll(1400);
  await wait(600);
  check("half a viewport or more is", h.sent.map((m) => m.step.type), ["scroll"]);
  check("and it reads as an instruction", h.sent[0].step.text, "Scroll down the page");
  // No point and no rect: nothing was clicked, so render.js draws the screenshot
  // unannotated rather than ringing an arbitrary box.
  check("with nothing highlighted",
        [h.sent[0].step.point, h.sent[0].step.rect], [undefined, undefined]);

  h.sent.length = 0;
  scroll(2000);
  await wait(600);
  check("a second scroll too soon after the first is dropped", h.sent.length, 0);
  await wait(700);
  scroll(3400);
  await wait(600);
  check("once the gap has passed, it records again", h.sent.length, 1);

  h.sent.length = 0;
  await wait(1300);      // clear of SCROLL_GAP_MS
  scroll(5100);          // scrollHeight 6000, innerHeight 900
  await wait(600);
  check("reaching the end says so", h.sent[0].step.text, "Scroll to the bottom of the page");
}

/* Scrolling a container rather than the document.
 *
 * This is the case that shipped broken. onScroll is attached with `capture: true`
 * precisely so a scroll inside a panel is seen, but flushScroll measured only
 * window.scrollY — so on any page whose content scrolls in a div, every scroll was
 * caught and thrown away. The window deliberately never moves in this block: if it
 * has to move for a step to appear, the bug is back. */
{
  const h = rec();
  await settle();
  h.sent.length = 0;
  const panel = el("div");
  panel.scrollTop = 0;
  panel.clientHeight = 800;
  panel.scrollHeight = 6000;
  const frozen = h.sandbox.scrollY;
  const scrollPanel = (y) => {
    panel.scrollTop = y;
    (h.handlers.scroll || []).forEach((fn) => fn({ target: panel }));
  };

  scrollPanel(120);
  await wait(600);
  check("a nudge inside a panel is not a step either", h.sent.length, 0);

  scrollPanel(1200);
  await wait(600);
  check("scrolling a panel IS a step, though the window never moved", h.sent.length, 1);
  check("and the window really did not move", h.sandbox.scrollY, frozen);
  check("it says panel, not page", h.sent[0].step.text, "Scroll down in the panel");

  h.sent.length = 0;
  await wait(1300);
  scrollPanel(400);
  await wait(600);
  check("scrolling back up reads as up", h.sent[0].step.text, "Scroll up in the panel");

  h.sent.length = 0;
  await wait(1300);
  scrollPanel(5200);           // 5200 + 800 === scrollHeight
  await wait(600);
  check("the panel's own end is the end", h.sent[0].step.text, "Scroll to the bottom of the panel");

  // Two scrollers on one page move independently: the page's own position must not
  // be compared against a panel's, or the first scroll after switching between them
  // reads as an enormous jump.
  h.sent.length = 0;
  await wait(1300);
  h.sandbox.scrollY = 1300;
  h.body.scrollTop = 1300;
  (h.handlers.scroll || []).forEach((fn) => fn({ target: h.body }));
  await wait(600);
  check("the page is tracked separately from the panel", h.sent.length, 1);
  check("and it says page again", h.sent[0].step.text, "Scroll down the page");

  // A panel that leaves the DOM mid-settle must not be measured: a detached node
  // reads zeros, which look like a scroll back to the top.
  h.sent.length = 0;
  await wait(1300);
  panel.scrollTop = 0;
  (h.handlers.scroll || []).forEach((fn) => fn({ target: panel }));
  panel.isConnected = false;
  await wait(600);
  check("a panel removed before the settle records nothing", h.sent.length, 0);
}
{
  const h = rec();
  await settle();
  h.sent.length = 0;
  const f = field("");
  type(h, f, "Demo");
  h.sandbox.scrollY = 2000;
  h.body.scrollTop = 2000;
  (h.handlers.scroll || []).forEach((fn) => fn({ target: h.body }));
  await wait(700);
  // A field scrolling into view while you type is not a scroll worth a step; the
  // typing is the thing that happened.
  check("a scroll during a typing burst is not its own step",
        h.sent.map((m) => m.step.type), ["input"]);
}

console.log("\n=== 12. keys beyond Enter ===");
{
  const h = rec();
  await settle();
  const key = (ev) => (h.handlers.keydown || []).forEach((fn) => fn(ev));

  h.sent.length = 0;
  key({ key: "Escape", target: el("div") });
  check("Escape is a step — it is how dialogs and searches get dismissed",
        h.sent.map((m) => m.step.text), ["Press Escape"]);

  await wait(300);
  h.sent.length = 0;
  key({ key: "k", metaKey: true, target: el("div") });
  check("a shortcut is an action, and often *the* action",
        h.sent.map((m) => m.step.text), ["Press ⌘+K"]);
  check("with nothing highlighted, since nothing was focused",
        h.sent[0].step.rect, undefined);

  await wait(300);
  h.sent.length = 0;
  key({ key: "Shift", target: el("div") });
  key({ key: "a", target: el("div") });
  key({ key: "ArrowDown", target: el("div") });
  check("a bare modifier, plain typing and arrow keys are not", h.sent.length, 0);
}

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
