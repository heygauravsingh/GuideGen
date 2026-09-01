// Drives the real background.js catch-up buffer with a stubbed chrome.
//
// The buffer captures on clicks the user never asked to record, so the tests that
// matter most are the ones asserting when it does NOT capture: an unarmed origin,
// an incognito tab, a recording already in progress, a password field on screen.
// Those are the four ways this feature could quietly become something nobody
// agreed to, so each is mutation-checked below.
import { harness, send, tick, evalIn } from "./bg-harness.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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
console.log("\n=== 6. it expires — by count, dropping whole sessions ===");
{
  const h = await armed();
  // 5 instead of 240, so this costs five writes rather than 245. Same code path.
  evalIn(h, "BUF.maxSteps = 5");
  const t0 = Date.now() - 3 * HOUR;
  // Two sessions of three, an hour apart. Over cap by one, so the *older session*
  // goes in its entirety — a card claiming "6 days left" over a session that has
  // quietly lost its first half is the failure this shape exists to avoid.
  for (const [i, t] of [t0, t0 + 1000, t0 + 2000, t0 + HOUR, t0 + HOUR + 1000, t0 + HOUR + 2000].entries()) {
    await send(h, { type: "fs_buffer_step", step: step("Click " + (i + 1), { timestamp: t }) }, { tab: TAB });
    await tick(90);
  }
  check("the older session goes whole, not step by step",
        buf(h).map((s) => s.text), ["Click 4", "Click 5", "Click 6"]);
  const orphans = Object.keys(h.store).filter((k) => k.startsWith("fs_bufstep_")).length;
  check("evicted steps are deleted, not orphaned in storage", orphans, 3);
}
{
  const h = await armed();
  evalIn(h, "BUF.maxSteps = 3");
  // One session over cap on its own: nothing to drop wholesale, so it trims from
  // the front rather than deleting the only thing the user has.
  const t0 = Date.now() - 60000;
  for (let i = 1; i <= 5; i++) {
    await send(h, { type: "fs_buffer_step", step: step("Click " + i, { timestamp: t0 + i * 1000 }) }, { tab: TAB });
    await tick(90);
  }
  check("a single over-cap session trims from the front instead",
        buf(h).map((s) => s.text), ["Click 3", "Click 4", "Click 5"]);
}

// ---------------------------------------------------------------------------
console.log("\n=== 7. it expires — by age, seven days ===");
{
  const h = await armed();
  await send(h, { type: "fs_buffer_step", step: step("ancient", { timestamp: Date.now() - 8 * DAY }) }, { tab: TAB });
  await tick();
  await send(h, { type: "fs_buffer_step", step: step("recent") }, { tab: TAB });
  await tick();
  check("a session older than 7 days is gone", buf(h).map((s) => s.text), ["recent"]);

  const h2 = await armed();
  await send(h2, { type: "fs_buffer_step", step: step("yesterday", { timestamp: Date.now() - 26 * HOUR }) }, { tab: TAB });
  await tick();
  await send(h2, { type: "fs_buffer_step", step: step("now") }, { tab: TAB });
  await tick();
  // The old 20-minute cap dropped this, which is what made a 7-day promise
  // decoration: nothing survived a night.
  check("yesterday's session survives the night", buf(h2).map((s) => s.text), ["yesterday", "now"]);
}

// ---------------------------------------------------------------------------
console.log("\n=== 6b. sessions ===");
{
  const h = await armed();
  await send(h, { type: "fs_buf_arm", origin: "https://mail.google.com", on: true });
  await tick(50);
  const other = { id: 7, windowId: 9, url: "https://mail.google.com/u/0", title: "Inbox", incognito: false };
  h.harnessTabs[7] = other;

  const t0 = Date.now() - 4 * HOUR;
  const writes = [
    ["morning A", t0, TAB],
    ["morning B", t0 + 5000, TAB],
    // 90 minutes later: past the 30-minute gap, so a different session.
    ["afternoon", t0 + 90 * 60 * 1000, TAB],
    // Same minute, different origin: also a different session.
    ["gmail", t0 + 90 * 60 * 1000 + 3000, other],
  ];
  for (const [text, ts, tab] of writes) {
    await send(h, { type: "fs_buffer_step", step: step(text, { timestamp: ts, url: tab.url }) }, { tab });
    await tick(90);
  }

  const r = await send(h, { type: "fs_buf_sessions" });
  const s = r.sessions;
  check("three sessions, newest first", s.map((x) => x.stepCount), [1, 1, 2]);
  check("a 30-minute gap splits one", s[1].host, "dash.uengage.in");
  check("so does a change of origin", s[0].host, "mail.google.com");
  check("each expires 7 days after its own last step",
        Math.round((s[2].expiresAt - (t0 + 5000)) / DAY), 7);
  check("none of them is redeemed yet", s.every((x) => !x.redeemedAt), true);
}

// ---------------------------------------------------------------------------
console.log('\n=== 6c. "capture last 2 minutes" ===');
{
  const h = await armed();
  const end = Date.now() - 3 * HOUR;      // an old session, deliberately
  const times = [end - 10 * 60000, end - 5 * 60000, end - 90 * 1000, end - 20 * 1000, end];
  for (const [i, t] of times.entries()) {
    await send(h, { type: "fs_buffer_step", step: step("Click " + (i + 1), { timestamp: t }) }, { tab: TAB });
    await tick(90);
  }

  const st = await send(h, { type: "fs_buf_status" }, { tab: TAB });
  check("the slice is counted from the session's own end, not from now",
        st.session.sliceCount, 3);
  check("and the whole session is still there", st.session.stepCount, 5);

  const r = await send(h, { type: "fs_buf_promote", sessionId: st.session.id, minutes: 2 });
  await tick();
  const steps = (h.store["fs_steporder_" + r.guideId] || []).map((id) => h.store["fs_step_" + id]);
  check("promoting 2 minutes of a 3-hour-old session still yields its last 2 minutes",
        steps.map((s) => s.text), ["Click 3", "Click 4", "Click 5"]);

  // No window can slice to nothing: the last step sits at endedAt, so it is
  // inside any positive window. This is what makes an empty-guide guard dead
  // code — one was written, this assertion killed it.
  const r2 = await send(h, { type: "fs_buf_promote", sessionId: st.session.id, minutes: 0.0001 });
  await tick();
  check("even an absurdly small window still yields the last step",
        (h.store["fs_steporder_" + r2.guideId] || []).length, 1);
}

// ---------------------------------------------------------------------------
// The pill's own CTA. It sends no sessionId — the worker resolves one from the
// sender's tab — so what has to be asserted is *which* session that resolves to.
console.log("\n=== 6c2. fs_buf_capture: the button on the page ===");
{
  const h = await armed();
  const OTHER = { id: 2, windowId: 9, url: "https://admin.other.com/x", title: "Other", incognito: false };
  h.harnessTabs[2] = OTHER;
  await send(h, { type: "fs_buf_arm", origin: "https://admin.other.com", on: true });
  await tick(50);

  const t0 = Date.now();
  for (const [i, t] of [t0 - 9 * 60000, t0 - 30 * 1000, t0 - 5 * 1000].entries()) {
    await send(h, { type: "fs_buffer_step", step: step("Here " + (i + 1), { timestamp: t }) }, { tab: TAB });
    await tick(90);
  }
  await send(h, {
    type: "fs_buffer_step",
    step: step("Elsewhere", { timestamp: t0 - 4 * 1000, url: OTHER.url, pageTitle: OTHER.title }),
  }, { tab: OTHER });
  await tick(120);

  const r = await send(h, { type: "fs_buf_capture" }, { tab: TAB });
  await tick();
  const texts = (h.store["fs_steporder_" + r.guideId] || []).map((id) => h.store["fs_step_" + id].text);
  check("it takes the slice, not the whole session", texts, ["Here 2", "Here 3"]);
  check("and never the session on another origin", texts.includes("Elsewhere"), false);

  // Same resolution rule as fs_buf_status: the session on *this* tab's origin.
  const other = await send(h, { type: "fs_buf_capture" }, { tab: OTHER });
  await tick();
  check("asked from the other tab, it captures that origin instead",
        (h.store["fs_steporder_" + other.guideId] || []).map((id) => h.store["fs_step_" + id].text),
        ["Elsewhere"]);
}
{
  const h = await armed();
  const r = await send(h, { type: "fs_buf_capture" }, { tab: TAB });
  check("nothing held yet is an ordinary refusal, not a crash or an empty guide",
        [r.ok, !!r.guideId], [false, false]);
}

// ---------------------------------------------------------------------------
console.log("\n=== 6d. redeemed, and discarded ===");
{
  const h = await armed();
  for (const t of ["one", "two"]) {
    await send(h, { type: "fs_buffer_step", step: step(t) }, { tab: TAB });
    await tick(90);
  }
  const before = (await send(h, { type: "fs_buf_sessions" })).sessions[0];
  await send(h, { type: "fs_buf_promote", sessionId: before.id });
  await tick();

  const after = (await send(h, { type: "fs_buf_sessions" })).sessions[0];
  check("promoting marks the session rather than consuming it", !!after.redeemedAt, true);
  check("its steps are still held, so another slice is still possible", after.stepCount, 2);
  const st = await send(h, { type: "fs_buf_status" }, { tab: TAB });
  check("and it stops counting as pending", st.pending, 0);

  await send(h, { type: "fs_buf_discard", sessionId: after.id });
  await tick(50);
  check("discarding deletes its steps", buf(h).length, 0);
  const gone = await send(h, { type: "fs_buf_discard", sessionId: after.id });
  check("discarding it twice fails rather than throwing", gone.ok, false);
}

// ---------------------------------------------------------------------------
console.log("\n=== 6e. tab switches and navigations reach the buffer ===");
// They did not at first: contextStep returned early unless a recording was
// running, so a promoted guide jumped between tabs with nothing explaining the
// move while a recorded one said "Switch to the … tab".
{
  const h = await armed();
  const t2 = { id: 8, windowId: 9, url: "https://dash.uengage.in/riders", title: "Riders", active: true, incognito: false };
  h.harnessTabs[8] = t2;
  h.listeners.updated.forEach((fn) => fn(8, { status: "complete" }, t2));
  await tick(300);
  check("a navigation on an armed origin is buffered",
        buf(h).map((s) => [s.type, s.text]), [["nav", "Go to dash.uengage.in/riders"]]);

  // An origin nobody armed must stay out, exactly as a click there does.
  const t3 = { id: 9, windowId: 9, url: "https://mail.google.com/u/0", title: "Inbox", active: true, incognito: false };
  h.harnessTabs[9] = t3;
  h.listeners.updated.forEach((fn) => fn(9, { status: "complete" }, t3));
  await tick(300);
  check("an unarmed origin still is not", buf(h).length, 1);
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

// ---------------------------------------------------------------------------
/* The count the page pill renders, and the session the Capture button acts on, have
   to be the same thing. They were not: `count` was the size of the WHOLE buffer while
   `session` was scoped to this origin, so a site holding nothing announced other
   sites' steps and the button then said "Nothing held yet". Reported 27 Aug 2026. */
console.log("\n=== 13. the held count is about THIS site, not the whole buffer ===");
{
  const h = await armed();
  const other = { id: 2, windowId: 9, url: "https://mail.google.com/u/0", title: "Inbox", incognito: false };
  h.harnessTabs[2] = other;
  await send(h, { type: "fs_buf_arm", origin: "https://mail.google.com", on: true, scope: "site" });
  for (const t of ["a", "b", "c"]) {
    await send(h, { type: "fs_buffer_step", step: step("Click " + t, { url: other.url }) }, { tab: other });
    await tick();
  }
  check("three steps are held, all of them elsewhere", buf(h).length, 3);

  const st = await send(h, { type: "fs_buf_status" }, { tab: TAB });
  check("this site's status says zero, not three", st.count, 0);
  check("and offers no session to capture", st.session, null);

  const cap = await send(h, { type: "fs_buf_capture" }, { tab: TAB });
  check("capturing here refuses, as it always did", cap.ok, false);

  // The half that matters: the number and the button now agree.
  await send(h, { type: "fs_buffer_step", step: step('Click "Orders"') }, { tab: TAB });
  await tick();
  const st2 = await send(h, { type: "fs_buf_status" }, { tab: TAB });
  check("one step here reads as one, not four", st2.count, 1);
  const cap2 = await send(h, { type: "fs_buf_capture" }, { tab: TAB });
  check("and the button that said nothing-held now works", cap2.ok, true);
}

// ---------------------------------------------------------------------------
/* Whole-browser scope. A journey that crosses domains was three separate captures,
   and the slice you got was the last hop — the part that explains nothing. */
console.log("\n=== 14. scope: this site only, or every site ===");
{
  const h = harness();
  h.harnessTabs[1] = TAB;
  const pay = { id: 2, windowId: 9, url: "https://pay.example.com/checkout", title: "Pay", incognito: false };
  h.harnessTabs[2] = pay;

  await send(h, { type: "fs_buf_arm", origin: ORIGIN, on: true, scope: "site" });
  await tick(50);
  const s1 = await send(h, { type: "fs_buf_status" }, { tab: TAB });
  check("site scope is what the switch gives you", s1.scope, "site");
  const p1 = await send(h, { type: "fs_buf_status" }, { tab: pay });
  check("and another domain is not armed by it", p1.armed, false);

  await send(h, { type: "fs_buf_arm", origin: ORIGIN, on: true, scope: "browser" });
  await tick(50);
  const p2 = await send(h, { type: "fs_buf_status" }, { tab: pay });
  check("browser scope arms a domain never named", p2.armed, true);
  check("and reports itself as browser scope", p2.scope, "browser");

  // The journey: two steps here, one on the payment domain, one back.
  await send(h, { type: "fs_buffer_step", step: step('Click "Checkout"') }, { tab: TAB });
  await tick();
  await send(h, { type: "fs_buffer_step", step: step('Click "Pay now"', { url: pay.url }) }, { tab: pay });
  await tick();
  await send(h, { type: "fs_buffer_step", step: step('Click "Done"') }, { tab: TAB });
  await tick();

  const st = await send(h, { type: "fs_buf_status" }, { tab: TAB });
  check("the whole journey is ONE capture, not three", st.count, 3);
  check("and it names every site it crossed", (st.session.origins || []).length, 2);
  check("the label says so rather than naming one", /\+ 1 more$/.test(st.session.host), true);

  // Standing on the payment domain must offer the same session, not a second one.
  const onPay = await send(h, { type: "fs_buf_status" }, { tab: pay });
  check("the same capture is offered from either domain", onPay.session.id, st.session.id);

  const cap = await send(h, { type: "fs_buf_capture" }, { tab: pay });
  check("and capturing it works from the domain it ended on", cap.ok, true);
  const guide = h.store.fs_index[0];
  check("the guide holds all three steps, across both sites", guide.stepCount, 3);
}

// ---------------------------------------------------------------------------
/* The consent switch must actually stop it. Turning catch-up off while every site is
   armed has to clear the wildcard — clearing only this origin would leave it running
   with the switch showing off, which is the worst possible bug in a consent control. */
console.log("\n=== 15. switching it off clears the scope that is on ===");
{
  const h = harness();
  h.harnessTabs[1] = TAB;
  const other = { id: 2, windowId: 9, url: "https://mail.google.com/u/0", title: "Inbox", incognito: false };
  h.harnessTabs[2] = other;

  await send(h, { type: "fs_buf_arm", origin: ORIGIN, on: true, scope: "browser" });
  await tick(50);
  check("armed everywhere", (await send(h, { type: "fs_buf_status" }, { tab: other })).armed, true);

  await send(h, { type: "fs_buf_arm", origin: ORIGIN, on: false });
  await tick(50);
  check("off here means off everywhere", (await send(h, { type: "fs_buf_status" }, { tab: other })).armed, false);
  check("and off here too", (await send(h, { type: "fs_buf_status" }, { tab: TAB })).armed, false);

  await send(h, { type: "fs_buffer_step", step: step("Click x", { url: other.url }) }, { tab: other });
  await tick();
  check("nothing is held after switching off", buf(h).length, 0);

  // Narrowing back to one site must drop the wildcard, or the choice is ignored.
  await send(h, { type: "fs_buf_arm", origin: ORIGIN, on: true, scope: "browser" });
  await tick(50);
  await send(h, { type: "fs_buf_arm", origin: ORIGIN, on: true, scope: "site" });
  await tick(50);
  check("choosing this-site-only narrows it", (await send(h, { type: "fs_buf_status" }, { tab: other })).armed, false);
  check("while this site stays armed", (await send(h, { type: "fs_buf_status" }, { tab: TAB })).armed, true);
}

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
