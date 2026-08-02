// Drives the real background.js context-step logic with a stubbed chrome.
// Asserts what does and does not become a step.
import { harness, tick } from "./bg-harness.mjs";


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
