// Drives the real background.js catch-up buffer with a stubbed chrome.
//
// The buffer captures on clicks the user never asked to record, so the tests that
// matter most are the ones asserting when it does NOT capture: an unarmed origin,
// an incognito tab, a recording already in progress, a password field on screen.
// Those are the four ways this feature could quietly become something nobody
// agreed to, so each is mutation-checked below.
import { harness, send, tick } from "./bg-harness.mjs";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}

const TAB = { id: 1, windowId: 9, url: "https://dash.uengage.in/orders", title: "Orders", incognito: false };
const ORIGIN = "https://dash.uengage.in";

function step(text, extra) {
  return Object.assign(
    { type: "click", text, url: TAB.url, pageTitle: TAB.title, timestamp: Date.now(), dpr: 2,
      point: { x: 10, y: 10 }, rect: { x: 0, y: 0, w: 50, h: 20 } },
    extra || {}
  );
}
function buf(h) {
  return (h.store.fs_bufindex || []).map((id) => h.store["fs_bufstep_" + id]).filter(Boolean);
}
async function armed() {
  const h = harness();
  h.harnessTabs[1] = TAB;
  await send(h, { type: "fs_buf_arm", origin: ORIGIN, on: true });
  await tick(50);
  return h;
}

// ---------------------------------------------------------------------------
console.log("\n=== 1. off by default ===");
{
  const h = harness();
  h.harnessTabs[1] = TAB;
  const r = await send(h, { type: "fs_buffer_step", step: step('Click "Orders"') }, { tab: TAB });
  await tick();
  check("an unarmed origin buffers nothing", buf(h).length, 0);
  check("and says so to the caller", (r || {}).ok, false);

  const st = await send(h, { type: "fs_buf_status" }, { tab: TAB });
  check("status reports not armed", { armed: st.armed, origin: st.origin }, { armed: false, origin: ORIGIN });
}

// ---------------------------------------------------------------------------
console.log("\n=== 2. armed per origin ===");
{
  const h = await armed();
  await send(h, { type: "fs_buffer_step", step: step('Click "Orders"') }, { tab: TAB });
  await tick();
  check("the armed origin buffers", buf(h).map((s) => s.text), ['Click "Orders"']);

  // A different origin, same browser.
  const other = { id: 2, windowId: 9, url: "https://mail.google.com/u/0", title: "Inbox", incognito: false };
  h.harnessTabs[2] = other;
  await send(h, { type: "fs_buffer_step", step: step("Click \"Compose\"", { url: other.url }) }, { tab: other });
  await tick();
  check("an origin nobody armed is untouched", buf(h).map((s) => s.text), ['Click "Orders"']);
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. disarming, and the wildcard ===");
{
  const h = await armed();
  await send(h, { type: "fs_buf_arm", origin: ORIGIN, on: false });
  await tick(50);
  await send(h, { type: "fs_buffer_step", step: step("Click \"X\"") }, { tab: TAB });
  await tick();
  check("disarmed stops buffering", buf(h).length, 0);

  await send(h, { type: "fs_buf_arm", origin: "*", on: true });
  await tick(50);
  const other = { id: 3, windowId: 9, url: "https://example.com/a", title: "A", incognito: false };
  h.harnessTabs[3] = other;
  await send(h, { type: "fs_buffer_step", step: step("Click \"Y\"", { url: other.url }) }, { tab: other });
  await tick();
  check('"*" arms every origin', buf(h).map((s) => s.text), ['Click "Y"']);
}

// ---------------------------------------------------------------------------
console.log("\n=== 4. never while recording, never in incognito ===");
{
  const h = await armed();
  h.store.fs_state = { recording: true, guideId: "g1", stepCount: 0 };
  h.store["fs_steporder_g1"] = [];
  h.store.fs_index = [{ id: "g1", stepCount: 0 }];
  await send(h, { type: "fs_buffer_step", step: step("Click \"Z\"") }, { tab: TAB });
  await tick();
  check("a recording owns the click; nothing is double-captured", buf(h).length, 0);

  const h2 = await armed();
  const priv = Object.assign({}, TAB, { id: 4, incognito: true });
  h2.harnessTabs[4] = priv;
  await send(h2, { type: "fs_buffer_step", step: step("Click \"Q\"") }, { tab: priv });
  await tick();
  check("incognito is never buffered", buf(h2).length, 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== 5. a password on screen loses the picture, keeps the words ===");
{
  const h = await armed();
  await send(h, { type: "fs_buffer_step", step: step("Type your password in the \"Password\" field", { noShot: true }) }, { tab: TAB });
  await tick();
  const s = buf(h)[0];
  check("the step survives", s.text, 'Type your password in the "Password" field');
  check("with no screenshot", s.screenshot, null);
  check("and no noShot flag left on it", "noShot" in s, false);
  check("no capture was even attempted", h.captures.length, 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== 6. it expires — by count ===");
{
  const h = await armed();
  for (let i = 1; i <= 45; i++) {
    await send(h, { type: "fs_buffer_step", step: step("Click " + i) }, { tab: TAB });
    await tick(90);
  }
  const kept = buf(h);
  check("capped at 40", kept.length, 40);
  check("and it is the LAST 40, not the first", [kept[0].text, kept[39].text], ["Click 6", "Click 45"]);
  const orphans = Object.keys(h.store).filter((k) => k.startsWith("fs_bufstep_")).length;
  check("evicted steps are deleted, not orphaned in storage", orphans, 40);
}

// ---------------------------------------------------------------------------
console.log("\n=== 7. it expires — by age ===");
{
  const h = await armed();
  await send(h, { type: "fs_buffer_step", step: step("ancient", { timestamp: Date.now() - 25 * 60 * 1000 }) }, { tab: TAB });
  await tick();
  await send(h, { type: "fs_buffer_step", step: step("recent") }, { tab: TAB });
  await tick();
  check("anything past 20 minutes is dropped", buf(h).map((s) => s.text), ["recent"]);
}

// ---------------------------------------------------------------------------
console.log("\n=== 8. promotion makes an ordinary guide ===");
{
  const h = await armed();
  for (const t of ['Click "Orders"', 'Click "Rider Management"', "Press Enter"]) {
    await send(h, { type: "fs_buffer_step", step: step(t) }, { tab: TAB });
    await tick(90);
  }
  const r = await send(h, { type: "fs_buf_promote" });
  await tick();
  check("it reports a guide", !!(r && r.ok && r.guideId), true);

  const order = h.store["fs_steporder_" + r.guideId] || [];
  const steps = order.map((id) => h.store["fs_step_" + id]);
  check("all three steps, in order", steps.map((s) => s.text),
        ['Click "Orders"', 'Click "Rider Management"', "Press Enter"]);
  check("seq is renumbered from 1", steps.map((s) => s.seq), [1, 2, 3]);
  check("each step knows its guide", steps.every((s) => s.guideId === r.guideId), true);
  check("step ids are fresh, not the buffer's", steps.some((s) => (h.store.fs_bufindex || []).includes(s.id)), false);

  const gi = (h.store.fs_index || []).find((x) => x.id === r.guideId);
  check("it is in the library with a count", { n: gi.stepCount, from: gi.fromBuffer }, { n: 3, from: true });
  check("guessTitle ran on it", /^How to /.test(gi.title), true);
  check("the buffer is left intact — promoting is not consuming", buf(h).length, 3);
}

// ---------------------------------------------------------------------------
console.log("\n=== 9. promoting a slice, and promoting nothing ===");
{
  const h = await armed();
  for (const t of ["one", "two", "three", "four"]) {
    await send(h, { type: "fs_buffer_step", step: step(t) }, { tab: TAB });
    await tick(90);
  }
  const r = await send(h, { type: "fs_buf_promote", n: 2 });
  await tick();
  const steps = (h.store["fs_steporder_" + r.guideId] || []).map((id) => h.store["fs_step_" + id]);
  check("n takes the LAST n", steps.map((s) => s.text), ["three", "four"]);

  const empty = harness();
  const r2 = await send(empty, { type: "fs_buf_promote" });
  check("an empty buffer refuses rather than making a blank guide", (r2 || {}).ok, false);
}

// ---------------------------------------------------------------------------
console.log("\n=== 10. clearing ===");
{
  const h = await armed();
  await send(h, { type: "fs_buffer_step", step: step("gone") }, { tab: TAB });
  await tick();
  await send(h, { type: "fs_buf_clear" });
  await tick(50);
  check("the index is emptied", (h.store.fs_bufindex || []).length, 0);
  check("and every step key with it", Object.keys(h.store).filter((k) => k.startsWith("fs_bufstep_")).length, 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== 11. the downscale is folded into dpr, as it is for a recording ===");
{
  const h = await armed();
  await send(h, { type: "fs_buffer_step", step: step("Click \"Orders\"") }, { tab: TAB });
  await tick();
  const s = buf(h)[0];
  // The stub captures 3024px wide; the buffer caps at 1280. 2 * (1280/3024).
  check("dpr carries the whole CSS-px -> bitmap-px relationship",
        Math.round(s.dpr * 1000) / 1000, Math.round(2 * (1280 / 3024) * 1000) / 1000);
}

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
