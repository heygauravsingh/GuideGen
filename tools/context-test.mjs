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

// ---------------------------------------------------------------------------
/* A nav step that only restates where the click before it went is noise — four of
   thirteen steps on a real recording. These are the cases where it must stay. */
console.log("\n=== 6. a navigation the previous step already explains ===");
{
  const h = harness();
  const drop = (steps) => h.sandbox.dropCausedNavs(steps).keep.map((s) => s.type + ":" + (s.text || ""));
  const at = (t) => 1000 + t;

  check("a click's own navigation is dropped", drop([
    { type: "click", text: "Click", tabId: 1, timestamp: at(0) },
    { type: "nav", text: "Go to a", tabId: 1, timestamp: at(900) },
    { type: "click", text: "Click 2", tabId: 1, timestamp: at(4000) },
  ]), ["click:Click", "click:Click 2"]);

  check("so is a redirect chain behind it", drop([
    { type: "click", text: "Click", tabId: 1, timestamp: at(0) },
    { type: "nav", text: "Go to a", tabId: 1, timestamp: at(500) },
    { type: "nav", text: "Go to b", tabId: 1, timestamp: at(900) },
    { type: "click", text: "Click 2", tabId: 1, timestamp: at(4000) },
  ]), ["click:Click", "click:Click 2"]);

  /* A tile that opens a new tab: the click's screenshot is the old page and the nav's
     is the new one, and a brand-new tab's switch step is rejected before it is ever
     written (its url is still about:blank). Drop this and the destination is nowhere
     in the guide. */
  check("a navigation in another tab stays", drop([
    { type: "click", text: "Click", tabId: 1, timestamp: at(0) },
    { type: "nav", text: "Go to a", tabId: 2, timestamp: at(600) },
  ]), ["click:Click", "nav:Go to a"]);

  // Typed into the address bar minutes later: nothing in the guide explains it.
  check("a navigation long after the last action stays", drop([
    { type: "click", text: "Click", tabId: 1, timestamp: at(0) },
    { type: "nav", text: "Go to a", tabId: 1, timestamp: at(60000) },
  ]), ["click:Click", "nav:Go to a"]);

  check("the first step is never dropped", drop([
    { type: "nav", text: "Go to a", tabId: 1, timestamp: at(0) },
    { type: "click", text: "Click", tabId: 1, timestamp: at(900) },
  ]), ["nav:Go to a", "click:Click"]);

  /* The click's picture is of the page it was clicked on — the result shows up in the
     *next* step's picture. When the nav is last there is no next step, so it is the
     only record of how the flow ended. */
  check("a trailing navigation is the outcome, and stays", drop([
    { type: "click", text: "Click", tabId: 1, timestamp: at(0) },
    { type: "nav", text: "Go to a", tabId: 1, timestamp: at(900) },
  ]), ["click:Click", "nav:Go to a"]);

  check("a navigation after a scroll stays — a scroll didn't cause it", drop([
    { type: "scroll", text: "Scroll down the page", tabId: 1, timestamp: at(0) },
    { type: "nav", text: "Go to a", tabId: 1, timestamp: at(600) },
    { type: "click", text: "Click", tabId: 1, timestamp: at(4000) },
  ]), ["scroll:Scroll down the page", "nav:Go to a", "click:Click"]);

  check("typing that submits still explains its navigation", drop([
    { type: "key", text: "Press Enter", tabId: 1, timestamp: at(0) },
    { type: "nav", text: "Go to a", tabId: 1, timestamp: at(700) },
    { type: "click", text: "Click", tabId: 1, timestamp: at(4000) },
  ]), ["key:Press Enter", "click:Click"]);

  check("a tab switch is not a navigation and is left alone", drop([
    { type: "click", text: "Click", tabId: 1, timestamp: at(0) },
    { type: "switch", text: 'Switch to the "X" tab', tabId: 2, timestamp: at(500) },
  ]), ["click:Click", 'switch:Switch to the "X" tab']);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
