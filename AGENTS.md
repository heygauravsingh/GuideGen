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
