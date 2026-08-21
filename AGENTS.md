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
