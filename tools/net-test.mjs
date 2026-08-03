// Drives the real background.js API log with a stubbed chrome.
//
// The summary tier (webRequest) is cheap and safe, so most of the weight here is
// on the two things that could turn this feature into a leak:
//
//   * **What it refuses to record.** Nothing while idle, nothing from an unarmed
//     origin, nothing from incognito, nothing that isn't an API call.
//   * **Tier 2 bodies.** Off by default on both surfaces; only failures; only
//     when the body matches a request webRequest independently saw, because the
//     page shares the channel the body arrives on and can post anything.
//
// Every one of those is mutation-checked: drop the guard and at least one
// assertion below fails. Verified by mutation — allowing 2xx bodies, logging every
// request type, letting the page write a log, and removing the correlation window
// each break a test here.
//
// One exception, deliberately kept: the `target.bodies` check inside `netBody` is
// **not** isolable, because `netRecord` only remembers a request as body-eligible
// when the same flag is on — so removing the second check leaves nothing for a
// body to match and it is refused anyway. Two checks on one flag, at both ends of
// the exchange, is the right shape for the one switch in this feature that governs
// whether response bodies exist at all. Don't delete it because a mutation run
// called it redundant.
import { harness, send, tick, request } from "./bg-harness.mjs";

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
function guideSteps(h, guideId) {
  return (h.store["fs_steporder_" + guideId] || []).map((id) => h.store["fs_step_" + id]);
}
async function recording(bodies) {
  const h = harness();
  h.harnessTabs[1] = TAB;
  const r = await send(h, { type: "fs_start", bodies: !!bodies }, { tab: TAB });
  await tick(50);
  return { h, guideId: r.guideId };
}
async function armed(bodies) {
  const h = harness();
  h.harnessTabs[1] = TAB;
  await send(h, { type: "fs_buf_arm", origin: ORIGIN, on: true });
  if (bodies) await send(h, { type: "fs_buf_bodies", on: true });
  await tick(50);
  return h;
}

// ---------------------------------------------------------------------------
console.log("\n=== 1. nothing is logged unless something is capturing ===");
{
  const h = harness();
  h.harnessTabs[1] = TAB;
  request(h, { status: 200 });
  await tick(120);
  check("an idle browser logs nothing", Object.keys(h.store).filter((k) => k.startsWith("fs_net")).length, 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== 2. a recording logs the summary ===");
{
  const { h, guideId } = await recording();
  request(h, { method: "POST", url: "https://api.uengage.in/v2/orders?token=secret", status: 500 });
  request(h, { method: "GET", url: "https://api.uengage.in/v2/me", status: 200 });
  await tick(200);
  const log = h.store["fs_net_" + guideId] || [];
  check("both requests are held", log.length, 2);
  check("method, host and path", [log[0].method, log[0].host, log[0].path],
        ["POST", "api.uengage.in", "/v2/orders?…"]);
  check("the query string never lands — ids and tokens ride in it",
        /secret/.test(JSON.stringify(log)), false);
  check("status and outcome", [log[0].status, log[0].ok, log[1].status, log[1].ok],
        [500, false, 200, true]);
  check("no headers, ever", Object.keys(log[0]).filter((k) => /header|cookie|auth/i.test(k)), []);
  check("and no body on the summary tier", "body" in log[0], false);
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. what is not an API call is not logged ===");
{
  const { h, guideId } = await recording();
  for (const type of ["image", "stylesheet", "script", "font", "main_frame", "ping", "websocket"])
    request(h, { type, status: 200 });
  await tick(200);
  check("page furniture and telemetry stay out", (h.store["fs_net_" + guideId] || []).length, 0);
  request(h, { type: "xmlhttprequest", status: 200 });
  await tick(150);
  check("an xhr/fetch does not", (h.store["fs_net_" + guideId] || []).length, 1);
}
{
  const { h, guideId } = await recording();
  // A request with no tab (the worker's own fetch, a service worker) has tabId -1.
  request(h, { tabId: -1, status: 200 });
  await tick(150);
  check("a request belonging to no tab is not attributed to one",
        (h.store["fs_net_" + guideId] || []).length, 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== 4. a failure with no response at all ===");
{
  const { h, guideId } = await recording();
  request(h, { method: "POST", error: "net::ERR_CONNECTION_REFUSED" });
  await tick(150);
  const e = (h.store["fs_net_" + guideId] || [])[0];
  check("recorded as an error, not as a status 0", [e.status, e.ok, e.error],
        [0, false, "ERR_CONNECTION_REFUSED"]);
}

// ---------------------------------------------------------------------------
console.log("\n=== 5. requests land on the step that caused them ===");
{
  const { h, guideId } = await recording();
  const t0 = Date.now();
  await send(h, { type: "fs_capture_step", step: step('Click "Orders"', { timestamp: t0 }) }, { tab: TAB });
  await tick(120);
  request(h, { method: "GET", url: "https://api.uengage.in/orders", status: 200 });
  await tick(120);
  await send(h, { type: "fs_capture_step", step: step('Click "Save"', { timestamp: Date.now() }) }, { tab: TAB });
  await tick(120);
  request(h, { method: "POST", url: "https://api.uengage.in/orders", status: 422 });
  await tick(200);

  await send(h, { type: "fs_stop" });
  await tick(300);
  const steps = guideSteps(h, guideId);
  check("each step gets its own request",
        steps.map((s) => (s.network || []).map((r) => r.method + " " + r.status)),
        [["GET 200"], ["POST 422"]]);
  check("the log itself is deleted once folded onto the steps",
        "fs_net_" + guideId in h.store, false);
  check("steps carry the tab they happened in, which is what makes that possible",
        steps.every((s) => s.tabId === 1), true);
}
{
  const { h, guideId } = await recording();
  await send(h, { type: "fs_capture_step", step: step("Click", { timestamp: Date.now() - 60000 }) }, { tab: TAB });
  await tick(120);
  request(h, { status: 200 });
  await tick(150);
  await send(h, { type: "fs_stop" });
  await tick(300);
  check("a request a minute after its step is nobody's consequence",
        (guideSteps(h, guideId)[0].network || []).length, 0);
}
{
  const { h, guideId } = await recording();
  await send(h, { type: "fs_capture_step", step: step("Click", { timestamp: Date.now() }) }, { tab: TAB });
  await tick(120);
  // Same moment, different tab.
  request(h, { tabId: 2, status: 200 });
  await tick(150);
  await send(h, { type: "fs_stop" });
  await tick(300);
  check("nor is one from another tab",
        (guideSteps(h, guideId)[0].network || []).length, 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== 6. Tier 2 bodies: off unless asked for ===");
{
  const { h } = await recording(false);
  request(h, { method: "POST", url: "https://api.uengage.in/orders", status: 500 });
  await tick(150);
  const r = await send(h, {
    type: "fs_net_body", url: "https://api.uengage.in/orders", status: 500,
    body: '{"error":"card declined","customer":"someone@example.com"}',
  }, { tab: TAB });
  await tick(150);
  check("a body offered to a recording that didn't ask is refused", (r || {}).ok, false);
  check("the patch is never injected either",
        h.injected.filter((x) => (x.files || []).includes("netpatch.js")).length, 0);
}
{
  const { h, guideId } = await recording(true);
  const patch = await send(h, { type: "fs_net_patch" }, { tab: TAB });
  check("with bodies on, the patch is injected", (patch || {}).ok, true);
  const inj = h.injected.filter((x) => (x.files || []).includes("netpatch.js"))[0];
  check("into the MAIN world, which is the only place a body exists", inj.world, "MAIN");

  request(h, { method: "POST", url: "https://api.uengage.in/orders", status: 500 });
  await tick(150);
  await send(h, {
    type: "fs_net_body", url: "https://api.uengage.in/orders", status: 500, body: '{"error":"card declined"}',
  }, { tab: TAB });
  await tick(200);
  check("the body annotates the request", (h.store["fs_net_" + guideId] || [])[0].body,
        '{"error":"card declined"}');
}

// ---------------------------------------------------------------------------
console.log("\n=== 7. Tier 2: only failures, and only what was really seen ===");
{
  const { h, guideId } = await recording(true);
  request(h, { method: "GET", url: "https://api.uengage.in/customers", status: 200 });
  await tick(150);
  const r = await send(h, {
    type: "fs_net_body", url: "https://api.uengage.in/customers", status: 200,
    body: '[{"name":"real person","phone":"98xxxxxx"}]',
  }, { tab: TAB });
  await tick(150);
  check("a 200's body is refused — that is the PII, for none of the value", (r || {}).ok, false);
  check("nothing was written", "body" in (h.store["fs_net_" + guideId] || [])[0], false);
}
{
  const { h, guideId } = await recording(true);
  request(h, { method: "POST", url: "https://api.uengage.in/orders", status: 500 });
  await tick(150);
  // The page shares the postMessage channel netpatch.js uses, so it can claim
  // anything. A body with no matching request is a claim, not an observation.
  const r = await send(h, {
    type: "fs_net_body", url: "https://evil.example.com/anything", status: 500, body: "forged",
  }, { tab: TAB });
  await tick(150);
  check("a body for a request that never happened is dropped", (r || {}).ok, false);
  check("and never reaches storage", /forged/.test(JSON.stringify(h.store)), false);
}
{
  const { h, guideId } = await recording(true);
  request(h, { method: "POST", url: "https://api.uengage.in/orders", status: 500 });
  await tick(150);
  const long = "x".repeat(20000);
  await send(h, { type: "fs_net_body", url: "https://api.uengage.in/orders", status: 500, body: long }, { tab: TAB });
  await tick(200);
  const e = (h.store["fs_net_" + guideId] || [])[0];
  check("a long body is truncated", e.body.length, 8192);
  check("and says how much was dropped", e.bodyTruncated, 20000);
}

// ---------------------------------------------------------------------------
console.log("\n=== 8. the catch-up buffer logs too ===");
{
  const h = await armed();
  await send(h, { type: "fs_buffer_step", step: step('Click "Orders"') }, { tab: TAB });
  await tick(120);
  request(h, { method: "POST", url: "https://api.uengage.in/orders", status: 503 });
  await tick(200);
  check("an armed origin's requests are held", (h.store.fs_bufnet || []).length, 1);

  const r = await send(h, { type: "fs_buf_promote" });
  await tick(200);
  check("and reach the promoted guide",
        (guideSteps(h, r.guideId)[0].network || []).map((x) => x.status), [503]);
  check("the buffered log survives promotion, like the steps do",
        (h.store.fs_bufnet || []).length, 1);
}
{
  const h = harness();
  const other = { id: 5, windowId: 9, url: "https://mail.google.com/u/0", title: "Inbox", incognito: false };
  h.harnessTabs[5] = other;
  request(h, { tabId: 5, status: 200 });
  await tick(150);
  check("an unarmed origin is not logged", (h.store.fs_bufnet || []).length, 0);
}
{
  const h = await armed();
  const priv = { ...TAB, id: 6, incognito: true };
  h.harnessTabs[6] = priv;
  request(h, { tabId: 6, status: 200 });
  await tick(150);
  check("incognito is never logged, armed or not", (h.store.fs_bufnet || []).length, 0);
}
{
  const h = await armed(false);
  request(h, { method: "POST", url: "https://api.uengage.in/orders", status: 500 });
  await tick(150);
  const r = await send(h, {
    type: "fs_net_body", url: "https://api.uengage.in/orders", status: 500, body: "nope",
  }, { tab: TAB });
  check("buffered bodies are off by default too", (r || {}).ok, false);
}
{
  const h = await armed(true);
  request(h, { method: "POST", url: "https://api.uengage.in/orders", status: 500 });
  await tick(150);
  await send(h, {
    type: "fs_net_body", url: "https://api.uengage.in/orders", status: 500, body: '{"e":1}',
  }, { tab: TAB });
  await tick(200);
  check("switched on, a buffered failure keeps its body", (h.store.fs_bufnet || [])[0].body, '{"e":1}');

  await send(h, { type: "fs_buf_bodies", on: false });
  await tick(120);
  // "Off" has to mean the bodies are gone. A switch that only stops new ones is a
  // promise about the future and nothing about what is already held.
  check("switching it off drops what was already held", "body" in (h.store.fs_bufnet || [])[0], false);
  check("the summary is kept — that was never the risky part",
        (h.store.fs_bufnet || [])[0].status, 500);
}

// ---------------------------------------------------------------------------
console.log("\n=== 9. discarding a capture takes its log with it ===");
{
  const h = await armed();
  await send(h, { type: "fs_buffer_step", step: step("Click") }, { tab: TAB });
  await tick(120);
  request(h, { status: 200 });
  await tick(200);
  const sess = (await send(h, { type: "fs_buf_sessions" })).sessions[0];
  await send(h, { type: "fs_buf_discard", sessionId: sess.id });
  await tick(120);
  check("the requests go when the steps do", (h.store.fs_bufnet || []).length, 0);
}
{
  const h = await armed();
  await send(h, { type: "fs_buffer_step", step: step("Click") }, { tab: TAB });
  await tick(120);
  request(h, { status: 200 });
  await tick(200);
  await send(h, { type: "fs_buf_clear" });
  await tick(120);
  check("and clearing everything clears the log", (h.store.fs_bufnet || []).length, 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== 10. the editor may remove a log, never write one ===");
{
  const { h, guideId } = await recording(true);
  await send(h, { type: "fs_capture_step", step: step("Click", { timestamp: Date.now() }) }, { tab: TAB });
  await tick(120);
  request(h, { method: "POST", url: "https://api.uengage.in/orders", status: 500 });
  await tick(150);
  await send(h, { type: "fs_net_body", url: "https://api.uengage.in/orders", status: 500, body: "oops" }, { tab: TAB });
  await tick(150);
  await send(h, { type: "fs_stop" });
  await tick(300);

  const stepId = (h.store["fs_steporder_" + guideId] || [])[0];
  check("the step has a log with its body", h.store["fs_step_" + stepId].network[0].body, "oops");

  await h.sandbox.bridge({ type: "gg_update_step", stepId, patch: { network: [{ method: "GET", path: "/fake", status: 200 }] } });
  check("a page cannot invent a log", h.store["fs_step_" + stepId].network.length, 1);

  await h.sandbox.bridge({ type: "gg_update_step", stepId, patch: { network: [] } });
  check("but it can remove one — the escape hatch for a body nobody read",
        "network" in h.store["fs_step_" + stepId], false);
}

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
