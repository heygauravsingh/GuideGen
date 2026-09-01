# Chrome Web Store: the store build bundles the voice — do not undo this

**v1.1.0 was rejected on 5 Aug 2026:** *"Including remotely hosted code in a Manifest V3 item."*

The package used to omit `lib/voices/en_US-hfc_female-medium.onnx` (60MB) and
`lib/piper/piper_phonemize.data` (17MB) and fetch both from a GitHub release on first narrated
export. `voicecache.js` argued they were data, not code. **That argument loses:**
`piper_phonemize.data` is the preload payload of a WebAssembly module, and a reviewer reads the
package rather than the control flow.

So there are now two builds, produced by `node tools/build.mjs`:

| | `GuideGen-Prod.zip` (store) | `GuideGen-Beta.zip` (testers, Drive) |
|---|---|---|
| the two big files | **bundled**, ~67MB | omitted, 3.3MB |
| the fetching code | **removed from the file entirely** | kept |

The remote block in `voicecache.js` sits between `REMOTE-BEGIN` and `REMOTE-END` markers and is
excised for the store build. It is removed rather than left unreachable **because a scanner cannot
see reachability** — a GitHub URL fetching a WASM payload looks like the forbidden thing either way.

`node tools/build.mjs --check` fails if the store archive is missing either file, or if any remote
URL survived in it. Run it before every upload.

## It happened again on 15 Aug 2026, from a different file — read this before the next upload

**v1.2.7 was rejected for the same policy**, and nothing above was wrong: the voice was bundled and
`voicecache.js` was clean. The offender was **`lib/jspdf.umd.min.js`**, which ships an output mode
(`pdfobjectnewwindow`) that builds a `<script src="…a public CDN…">` and `document.write`s it into a
new window. Nothing in GuideGen calls it. **That does not matter** — it is remote-code loading
inside a Manifest V3 package, and the review reads the package rather than the call graph. A second
line in the same file, an `http://…/md5.js` attribution inside a licence comment, matched the same
shape.

Two things changed, and the second is the one that matters:

- Both jsPDF output modes now throw, and the attribution keeps the credit without the URL. **Both
  must be re-applied after any jsPDF upgrade** — there is a note at the top of the vendored file.
- **`--check` no longer knows which file to distrust.** It used to read `voicecache.js`, the file
  that had just been fixed the last time, which is exactly why this shipped. It now sweeps every
  text file in the built archive — vendored libraries included — for fetchable `http(s)` URLs, the
  known script CDNs by name, and `importScripts()` with a computed argument.

**The lesson worth carrying: the check that catches a rejection must not be written to look at the
file that caused it.** The next violation will come from somewhere else, and probably from a
dependency nobody has read.

One exemption exists, by filename, in `--check`: onnxruntime's bundle contains Emscripten's pthread
bootstrap (`importScripts(e.data.urlOrBlob)`). It cannot run here — `tts.js` sets `numThreads = 1`
and `proxy = false`, so no worker is created, and `wasmPaths` is pinned to `chrome.runtime.getURL`.
`tts.js` also refuses, at runtime, to attach any script whose URL is not inside this extension.

The beta build keeps the fetch on purpose: it is handed to testers directly rather than through the
store, so store policy does not govern it, and 3.3MB is the difference between a tester trying it and
not bothering.

# GuideGen — read CLAUDE.md in this folder

The full brief for this product is [`CLAUDE.md`](./CLAUDE.md), in this directory. It is long
and it is worth reading in full before changing anything: most of its rules exist because a
reasonable-looking simplification broke something in production, and each one says what went
wrong.

Also read, in the house root two levels up (`../../`):

1. `AGENTS.md` — how to work here, and the documentation contract you must follow
2. `STATUS.md` — where this product stands right now, including what is mid-review
3. `WORKLOG.md` — what has already been done and why

Before you say a change is done, run the checks:

```bash
node tools/recorder-test.mjs && node tools/buffer-test.mjs && node tools/net-test.mjs \
&& node tools/context-test.mjs && node tools/note-test.mjs && node tools/origin-test.mjs \
&& node tools/og-test.mjs && node tools/sync-web-assets.mjs --check \
&& node tools/make-icons.mjs --check && node tools/set-extension-key.mjs --check
```

Release procedure, including the build commands and every step that needs Gaurav's hands:
`../../private/GuideGen/store/RUNBOOK.md`. **Do not touch the Chrome Web Store item while a review is pending** —
uploading a package restarts the queue.

## And once more on 21 Aug 2026 — this time the excision broke the file it was cutting

**v1.2.8 shipped to the store with narration silently dead.** Every narrated export produced a
silent captioned video and said *"Narration unavailable (voicecache.js did not load)"*. Nothing was
wrong with the store policy work, and nothing was wrong in the checkout: `voicecache.js` in the
repo was correct, and the beta build — which keeps the whole file — narrated fine. The damage was
done by the excision itself.

The `REMOTE-BEGIN` / `REMOTE-END` markers had been drawn far too wide. They opened just after
`var STORE` and closed just before `get()`, so the block `tools/build.mjs` cut out of the store
build contained not only the GitHub URL and `download()` but also **`ASSETS`, `extUrl()`, the three
IndexedDB helpers, `keyOf()`, `sha256Hex()`, `verify()` and `inFlight`** — every one of which is
still referenced by `get()`, `cached()`, and the `window.FSVoice = {…, ASSETS: ASSETS}` assignment
on the file's last line. The store copy parsed cleanly and contained no remote URL, so it passed
every check, then threw `ReferenceError: ASSETS is not defined` the moment `offscreen.html` ran it.
`window.FSVoice` was never assigned, and `tts.js` reported the only thing it could see.

Two changes:

- **The markers now wrap only `RELEASE` and `download()`.** Everything else moved above
  `REMOTE-BEGIN`. The rule is written into the marker comment: *nothing between the markers may be
  referenced from outside them.*
- **`--check` now runs the excised file** in a `node:vm` context with a bare `window` and fails
  unless `window.FSVoice.get` exists afterwards. It needs no DOM, no `chrome` and no network,
  because everything `voicecache.js` touches at load time is a `var` or a function declaration.

**The lesson worth carrying — and it is a sharper version of the one above.** Every check we had
asked *"is the forbidden thing absent?"*. Not one asked *"does the thing we shipped still work?"*.
A build step that **removes** code needs a test that the remainder still runs, because the property
being verified — absence — is satisfied perfectly by a file that has been cut to pieces. Cheap rule:
**if a build transforms a file, the check must execute the transformed file, not just read it.**

## Two rules from the 21 Aug 2026 catch-up capture bugs

**Anything the worker holds only in memory is gone by the next event.** An MV3 service worker is
killed after ~30s idle. `netBody` used to match a posted exchange against `netAwaitingBody`, an array
`netRecord` pushed to — so a body was lost whenever the worker had restarted, and lost *again*
whenever the page simply won the race (`netRecord` does a `chrome.tabs.get` and two storage reads
before it would have remembered the request). Catch-up capture is idle-and-armed almost all of the
time, which is precisely when the worker is dead, so the feature that depended on it worked least
where it was needed most. **If a correlation has to survive more than one turn of the event loop, it
belongs in storage.**

**A decision the worker makes once, at attach, has to be re-askable.** `netpatch.js` is injected when
recorder.js attaches and the worker decides then whether Tier 2 is wanted. Ticking the box afterwards
changed nothing until the page reloaded, and the `patchAsked` latch is per page load — so on an armed
site, catch-up burned the latch with the box off and pressing Start with it on attached no patch
either. Any switch that gates an injection needs a broadcast and a latch that resets; re-injection is
safe here because `netpatch.js` marks the window and returns early.

**And a testing rule, because this is what hid it.** `bg-harness.mjs` called `tabs.get` back
synchronously. Chrome does not. That one shortcut made the losing ordering impossible to reproduce,
so the race lived in a file with an otherwise thorough test suite. **A stub that is more orderly than
the real API does not simplify a test — it deletes the case the test existed to catch.**

## The hub screen (25 Aug 2026) — three things that look like tidying and are not

The folder rail at `/app` is in `web/assets/app.js` and `web/assets/site.css`. The engine behind it
is in `background.js`; `tools/hub-test.mjs` covers the engine, and there is no automated test for the
screen — it needs an extension and a signed-in session, so it was verified by driving the real
`app.js` against a stubbed `GG`/`GGBridge`. If you change any of the below, drive it the same way.

**`dragGuideId` is a module variable and must stay one.** It is tempting to put the dragged guide's
id into `dataTransfer` and read it in the drop handler. `dataTransfer.getData` returns an empty
string during `dragover` in every browser — that is a deliberate part of the drag-and-drop spec — and
`dragover` is exactly where a folder has to decide whether to accept the drop and show its ring.
Moving this into the drag payload kills every drop target silently: the drag still works, nothing
highlights, and nothing lands.

**The rail hides itself when there is no extension, and that is not a degraded state to improve.**
Hubs live in the extension's storage because the editable copy of a guide does — filing kept anywhere
else drifts the moment the dashboard is open in two windows. So a browser without the extension has
no folders at all, and `renderHubs` sets `.dash-body.no-rail` and forces the selection back to *All
guides*. Do not "fix" this by showing an empty rail: every control on it would fail.

**Move and Duplicate are disabled with a reason on a server-only guide, not hidden.** A guide that
exists only as a published document has no entry in `fs_index`, which is where `hubId` lives, and
duplicating one would mean re-uploading every screenshot to make a draft nobody asked to publish.
Hiding the two items instead makes the menu change shape from row to row, which reads as a bug and
gets reported as one.

## Catch-up capture, 1.2.11 (27 Aug 2026) — two bugs and a scope

Both bugs were reported from the same page, and both had survived a thorough test suite because
the suite only ever exercised the easy half of each.

**"10 steps held" beside "Nothing held yet" was one number describing two different things.**
`fs_buf_status` returned `count: (await get(K.bufIndex, [])).length` — the whole buffer, every armed
site — while `session` in the same response was correctly scoped to this origin, and the Capture
button acts on `session`. So a site holding nothing announced other sites' steps and then refused to
capture them. Both halves were right; they were answering different questions. The count is now
`here ? here.stepCount : 0`, and **the whole-buffer number is gone from all three places that
published it** (the two `fs_buf_changed` broadcasts and the reply to a buffered step) so it cannot
come back by a different route. `sessionForTab()` is now the single rule for "which session would
this tab capture" — the pill and the button must never resolve that separately again.

**Scrolling inside a container recorded nothing, in every mode.** `onScroll` is attached with
`capture: true` *specifically* so a scroll in a panel is seen — there is a comment saying so — but
`flushScroll` measured `window.scrollY` and nothing else. On any page whose content scrolls in a div,
every scroll event was caught and thrown away: the window never moved, so `moved` was always 0. It
now measures whatever actually scrolled, tracked per element in a `WeakMap` keyed by the node (with
`window` for the page), because two scrollers move independently and comparing one against the
other's last position reads as an enormous jump.

**The lesson both share, and it is the same one as the 21 Aug harness bug:** the tests passed because
every scroll case fired with `target: document.body`, and every count case had one armed site. A
suite that only ever exercises the simple shape will not find the bug that lives in the other one.
`recorder-test.mjs` §11 now scrolls a real panel while asserting the window does **not** move, and
`buffer-test.mjs` §13 holds steps on one site and asks a different one. Both were confirmed to fail
against the old code before being kept — do that when you add to them.

**Capture scope is a consent control, not a preference.** `"*"` in the arming map was always the
whole-browser wildcard; 1.2.11 gives it a UI and makes sessions stop splitting at each domain, which
is the half that actually mattered — a journey through a payment provider and back was three
captures, and the slice you got was the last hop. Rules that must not be softened:

- **The switch alone can only ever arm one site.** Whole-browser is a second, explicit choice with
  its own confirm naming what it keeps and for how long. Nobody may arrive at it by accident.
- **Turning catch-up off clears `"*"` as well as this origin.** Clearing only the origin would leave
  the wildcard set: the switch would read off and it would still be recording. That is the worst
  possible failure in a control whose entire job is consent, and `buffer-test.mjs` §15 asserts it.
- **Choosing "this site only" deletes `"*"`.** It is a narrowing; leaving the wildcard would silently
  ignore the choice the user just made.
- **Copy in whole-browser scope must not name a single host.** A merged session's `host` is
  `"site + N more"`, and the popup uses it — saying "held for uengage.io" about a capture that also
  holds two other sites understates what is on disk, which is the one direction this copy may never
  err in.
