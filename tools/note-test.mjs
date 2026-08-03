// Drives the real background.js note-insert path with a stubbed chrome.
//
// A note is the one step a *web page* creates, and since it can now carry a picture
// the page also hands over image bytes. So the tests here are weighted towards what
// the worker refuses: an image that isn't a base64 raster data URL, an SVG (a
// document, not a bitmap — it can carry script and it renders in every export), an
// oversized one, and an index outside the guide. Each is mutation-checked: remove
// the corresponding guard in `cleanImage()` or the index clamp and one of these fails.
//
// It calls `bridge()` directly through the vm rather than through onMessageExternal,
// which the harness stubs as a no-op — same function the real listener calls.
import { harness, tick, evalIn } from "./bg-harness.mjs";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const WEBP = "data:image/webp;base64,UklGRhIAAABXRUJQVlA4";

// One guide, three recorded steps.
function guide() {
  const h = harness();
  h.store.fs_index = [{ id: "g1", title: "A guide", stepCount: 3, createdAt: Date.now() }];
  h.store["fs_steporder_g1"] = ["s1", "s2", "s3"];
  ["s1", "s2", "s3"].forEach((id, i) => {
    h.store["fs_step_" + id] = {
      id, guideId: "g1", seq: i + 1, type: "click", text: "Click " + (i + 1),
      screenshot: "data:image/webp;base64,AAA", dpr: 2, blurs: [],
      rect: { x: 0, y: 0, w: 10, h: 10 },
    };
  });
  return h;
}
function call(h, msg) {
  return evalIn(h, "bridge")(msg);
}
function order(h) {
  return (h.store["fs_steporder_g1"] || []).map((id) => {
    const s = h.store["fs_step_" + id];
    return s.type === "note" ? "note:" + s.text : s.text;
  });
}

// ---------------------------------------------------------------------------
console.log("\n=== 1. it lands where the + was pressed ===");
{
  const h = guide();
  const r = await call(h, { type: "gg_add_note", guideId: "g1", text: "Before you start", index: 1 });
  await tick(50);
  check("inserted at the index, not appended", order(h),
        ["Click 1", "note:Before you start", "Click 2", "Click 3"]);
  check("the reply says where it went", r.index, 1);
  check("and the guide's step count follows", h.store.fs_index[0].stepCount, 4);
}
{
  const h = guide();
  await call(h, { type: "gg_add_note", guideId: "g1", text: "First", index: 0 });
  await tick(50);
  check("index 0 puts it before everything", order(h)[0], "note:First");
}
{
  const h = guide();
  await call(h, { type: "gg_add_note", guideId: "g1", text: "Last", index: 3 });
  await tick(50);
  check("index === length appends", order(h)[3], "note:Last");
}
{
  /* A web page is on the other end, so an index it made up must not decide where a
     step lands — or whether one lands at all. Clamped, never rejected: the user did
     press +, and losing their text to a stale index would be the wrong answer. */
  const h = guide();
  await call(h, { type: "gg_add_note", guideId: "g1", text: "Way out", index: 999 });
  await call(h, { type: "gg_add_note", guideId: "g1", text: "Negative", index: -5 });
  await tick(50);
  check("an out-of-range index is clamped, both ways", order(h),
        ["note:Negative", "Click 1", "Click 2", "Click 3", "note:Way out"]);
}

// ---------------------------------------------------------------------------
console.log("\n=== 2. the picture, and what is refused ===");
{
  const h = guide();
  await call(h, { type: "gg_add_note", guideId: "g1", text: "See this", index: 0, image: PNG });
  await tick(50);
  const s = h.store["fs_step_" + h.store["fs_steporder_g1"][0]];
  check("a base64 raster data URL is kept", s.screenshot, PNG);
  check("dpr is 1 — an uploaded image has no CSS-px relationship to anything", s.dpr, 1);
  check("and it is still a note", s.type, "note");
}
{
  const h = guide();
  const bad = [
    ["an https: URL", "https://example.com/a.png"],
    ["a blob: URL", "blob:https://guide-gen.vercel.app/abc-123"],
    ["a javascript: URL", "javascript:alert(1)//data:image/png;base64,AAA"],
    ["an SVG data URL", "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4="],
    ["a non-image data URL", "data:text/html;base64,PHNjcmlwdD4="],
    ["base64 with markup smuggled in", 'data:image/png;base64,AA"><img src=x onerror=1>'],
    ["an object instead of a string", { toString: () => PNG }],
    ["an oversized image", "data:image/png;base64," + "A".repeat(9 * 1024 * 1024)],
  ];
  for (const [label, img] of bad) {
    const r = await call(h, { type: "gg_add_note", guideId: "g1", text: "x", index: 0, image: img });
    check("refuses " + label, [r.ok, !!r.error], [false, true]);
  }
  await tick(50);
  check("and none of them created a step", order(h).length, 3);
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. changing the picture afterwards ===");
{
  const h = guide();
  await call(h, { type: "gg_add_note", guideId: "g1", text: "Caption", index: 0, image: PNG });
  await tick(50);
  const id = h.store["fs_steporder_g1"][0];
  h.store["fs_step_" + id].blurs = [{ x: 1, y: 1, w: 5, h: 5 }];

  await call(h, { type: "gg_update_step", stepId: id, patch: { image: WEBP } });
  await tick(50);
  check("a note's picture can be replaced", h.store["fs_step_" + id].screenshot, WEBP);
  /* A rect that pixelated something in the old picture lands somewhere arbitrary in
     the new one — which is worse than losing the redaction, because it looks done. */
  check("its redactions go with it", h.store["fs_step_" + id].blurs, []);

  await call(h, { type: "gg_update_step", stepId: id, patch: { image: null } });
  await tick(50);
  check("and null takes the picture off again", h.store["fs_step_" + id].screenshot, null);

  const r = await call(h, { type: "gg_update_step", stepId: id, patch: { image: "https://x/y.png" } });
  check("a bad replacement is refused", r.ok, false);
}
{
  /* The one that matters: a recorded screenshot is evidence of what was on screen at
     the moment of the click. A page that could overwrite it could rewrite the history
     of a guide someone else is about to read. */
  const h = guide();
  const r = await call(h, { type: "gg_update_step", stepId: "s2", patch: { image: PNG } });
  await tick(50);
  check("a recorded step's screenshot cannot be overwritten by the page",
        [r.ok, h.store.fs_step_s2.screenshot], [true, "data:image/webp;base64,AAA"]);
  check("nor removed", h.store.fs_step_s2.screenshot !== null, true);
}
{
  const h = guide();
  const r = await call(h, { type: "gg_add_note", guideId: "g1", text: "x", index: 0 });
  check("an unknown guide is refused", (await call(h, { type: "gg_add_note", guideId: "nope", text: "x", index: 0 })).ok, false);
  check("a known one is not", r.ok, true);
}

// ---------------------------------------------------------------------------
console.log("\n=== 4. the text ===");
{
  const h = guide();
  await call(h, { type: "gg_add_note", guideId: "g1", text: "y".repeat(5000), index: 0 });
  await tick(50);
  const s = h.store["fs_step_" + h.store["fs_steporder_g1"][0]];
  check("text is capped worker-side, not just by the textarea", s.text.length, 2000);
}
{
  const h = guide();
  await call(h, { type: "gg_add_note", guideId: "g1", index: 0, image: PNG });
  await tick(50);
  const s = h.store["fs_step_" + h.store["fs_steporder_g1"][0]];
  check("a picture with no caption is allowed", [s.text, !!s.screenshot], ["", true]);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
