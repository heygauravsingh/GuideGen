// Drives the real background.js hub operations with a stubbed chrome.
//
// Hubs are folders over the *local* library, which is where the editable copy of a
// guide lives. The two rules worth pinning: deleting a folder never deletes what is
// in it, and a duplicate is a genuinely independent copy — editing it must not reach
// back into the original, which is the whole reason anyone duplicates a guide.
import { harness, tick } from "./bg-harness.mjs";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}
// The dashboard reaches the worker through bridge(), not the internal message bus.
const call = (h, msg) => h.sandbox.bridge(msg);

console.log("\n=== hubs ===");
{
  const h = harness();
  let r = await call(h, { type: "gg_hub_create", name: "Onboarding" });
  check("a hub is created", [r.ok, r.hub.name], [true, "Onboarding"]);
  const id = r.hub.id;

  r = await call(h, { type: "gg_hub_create", name: "onboarding" });
  check("a case-different duplicate is refused", r.ok, false);

  r = await call(h, { type: "gg_hub_create", name: "   " });
  check("an empty name is refused", r.ok, false);

  r = await call(h, { type: "gg_hub_rename", hubId: id, name: "Customer onboarding" });
  check("renaming works", r.hubs[0].name, "Customer onboarding");

  // a guide filed into it
  h.store.fs_index = [{ id: "g1", title: "A guide", stepCount: 2, hubId: id }];
  h.store["fs_steporder_g1"] = ["s1", "s2"];
  h.store["fs_step_s1"] = { id: "s1", guideId: "g1", text: "one", screenshot: "data:x" };
  h.store["fs_step_s2"] = { id: "s2", guideId: "g1", text: "two" };

  r = await call(h, { type: "gg_hub_delete", hubId: id });
  check("deleting a hub leaves no hubs", r.hubs.length, 0);
  check("and never deletes the guides in it", h.store.fs_index.length, 1);
  check("they become unfiled instead", h.store.fs_index[0].hubId, null);
}

console.log("\n=== duplicate ===");
{
  const h = harness();
  h.store.fs_index = [{ id: "g1", title: "Refunds", stepCount: 2, startUrl: "https://x.test", remoteId: "PUBLISHED", hubId: "hub1" }];
  h.store["fs_steporder_g1"] = ["s1", "s2"];
  h.store["fs_step_s1"] = { id: "s1", guideId: "g1", text: "one", blurs: [{ x: 1 }] };
  h.store["fs_step_s2"] = { id: "s2", guideId: "g1", text: "two" };

  const r = await call(h, { type: "gg_guide_duplicate", guideId: "g1" });
  check("a copy is made", r.ok, true);
  check("named as a copy", r.guide.title, "Refunds (copy)");
  check("it keeps the hub", r.guide.hubId, "hub1");
  check("but is NOT published", [r.guide.remoteId, r.guide.publishedAt], [null, null]);
  check("the library has both", h.store.fs_index.length, 2);

  const newOrder = h.store["fs_steporder_" + r.guide.id];
  check("the steps are copied", newOrder.length, 2);
  check("under fresh ids", newOrder.some((id) => id === "s1" || id === "s2"), false);
  // editing the copy must not reach the original
  const copyStep = h.store["fs_step_" + newOrder[0]];
  copyStep.text = "edited";
  check("editing the copy leaves the original alone", h.store["fs_step_s1"].text, "one");
  check("and the original still has its steps", h.store["fs_steporder_g1"], ["s1", "s2"]);
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
