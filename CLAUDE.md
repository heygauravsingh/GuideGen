# CLAUDE.md — GuideGen

Project context for Claude Code. Read this first before making changes.

## What this is
GuideGen is a Chrome Manifest V3 extension plus a static website. You record a browser
workflow; it auto-generates a step-by-step guide (one annotated screenshot per click) and
hands it over — as text an AI can act on, or as HTML, Markdown, PDF, PowerPoint or a
narrated video.

**Positioning, since it decides what gets built:** the lead is the *AI handoff*, with the
documentation tool alongside it — not the other way round. Explaining something you just did
in a browser to an assistant currently means screenshotting it and typing the steps out by
hand, and nobody has automated that. The documentation market is Scribe's, it is crowded, and
a solo extension does not win it head-on. Two consequences for the code:

- **`aiText()` in `exporters.js` is the flagship export, not a nice-to-have.** It is the only
  one that emits `type`, `url` and `pageTitle` — the fields every human-facing format drops.
  A guide answers "what did you do"; a model also needs "and where", or it invents it.
- **Do not promise automation.** We record a control's *label and position*, never a
  selector, so a handoff cannot be replayed. It is for explaining and reasoning about a flow.
  The landing FAQ says this outright; keep it saying it.

Started as a local replica of Scribe Capture, and the capture engine still is one.

**The extension records. The website edits.** Since v1.1 the guide editor is a page on
`guide-gen.vercel.app/app`, not in the extension — one editor to keep good instead of two
kept in parity by hand, which is what produced the unstyled-dialog bug. The dashboard
reads the machine's local guides over `externally_connectable` (see The bridge). The
extension still owns recording, the account session, and the narrated video export.

All rendering and every export still run client-side, on the user's device. Two things
leave it, both deliberate: sign-in, and the single guide the user presses Publish on.
Local guide data lives in `chrome.storage.local`.

## Non-negotiables / constraints
- **Manifest V3**, vanilla JS only. No build step, no framework, no bundler — files load
  directly. Keep it that way unless explicitly asked to add tooling.
- No remote code. Libraries are vendored in `lib/` (MV3 forbids remote script loading).
- No `localStorage`/`sessionStorage` for app data — use `chrome.storage.local`
  (the manifest already requests `unlimitedStorage`).
- Keep everything working as "Load unpacked" from this folder.
- `render.js` and `exporters.js` have **one editable copy, in the repo root.**
  `web/assets/` holds generated mirrors, written by `tools/sync-web-assets.mjs`. Edit a
  mirror and the next sync silently reverts you; run `node tools/sync-web-assets.mjs`
  after touching either file, and `--check` before packaging.
- **The website may not serve anything from `lib/`.** It is 88MB of voice model and
  `.vercelignore` exists to stop exactly that. Anything needing those files runs in the
  extension.

## How to test a change
1. Edit files here.
2. Go to `chrome://extensions` → click the ↻ (reload) on the GuideGen card.
3. For content-script (`recorder.js`) changes, also **reload the web page** you're recording.
4. Logs: the service worker log is behind the "Inspect views: service worker" link on the
   extension card; popup logs are in its own DevTools. The **offscreen document** also
   appears under "Inspect views" while a video is rendering — that is the only way to see
   an error thrown inside it.
5. For website changes, serve `web/` locally rather than opening the files: `/app` and
   `/g/{id}` depend on Vercel's `cleanUrls`, and `file://` breaks the module-free script
   loading. There's a `site` config in `.claude/launch.json`.
6. **The bridge only answers `https://guide-gen.vercel.app`.** A locally served dashboard
   cannot reach the extension, so local guides won't list. Test the bridge against the
   deployed site with the extension loaded unpacked.

## File map
| File | Role |
|---|---|
| `manifest.json` | MV3 config, v1.2.3. Permissions: activeTab, scripting, storage, unlimitedStorage, tabs, downloads, offscreen, webRequest (observational only — see The API log); host `<all_urls>`; `externally_connectable` names `https://guide-gen.vercel.app/*` and nothing else. CSP adds `'wasm-unsafe-eval'` for the TTS engine. |
| `background.js` | Service worker. Owns recording state, `captureVisibleTab` screenshots (serialized via a throttled queue), their re-encode to width-capped WebP (see Screenshot normalisation), and all persistence. Message router (`fs_start`, `fs_stop`, `fs_capture_step`, `fs_get_state`, `fs_open_editor`). On stop, `finalizeGuide()` merges redundant steps and names the guide (see Post-processing). |
| `recorder.js` | Content script. Listens (capture phase) for `pointerdown` + `change` + `keydown` (Enter), builds a human-readable step description from the DOM element (see Step wording), hides its own pill before each capture, shows the floating "Recording" pill. Runs in two modes — recording, or buffering an armed origin (see Catch-up capture) — with `mode()` the single source of truth for which. Also retires itself when orphaned (see Orphaned content scripts). |
| `netpatch.js` | The only code that runs in the page's **MAIN world**. Patches `fetch`/`XHR` to report a *failed* exchange — request headers, sent body, response body — back through `postMessage`, because `chrome.webRequest` can read none of them. Masks credential header values and obvious body secrets *before* posting, so a secret never crosses the boundary. Opt-in, off by default; injected per tab by the worker via `executeScript({world:"MAIN"})`. Nothing it says is trusted — see The API log. |
| `recorder.css` | Styles for the recording pill only. Every declaration is `!important` and children start from `all: unset` — this is the one surface that renders inside a stranger's page. |
| `popup.html/js` | Toolbar popup: status card (idle / recording with live step count) + Start/Stop, Guide library, and the catch-up capture switch for the current tab's origin. Self-contained styles, light + dark. |
| `editor.html` + `redirect.js` | Retired. A redirect to `/app`, carrying `#<guideId>` across as `#local-<guideId>`, so v1.0 bookmarks land somewhere sensible. The editor is `web/assets/app.js`. |
| `offscreen.html/js` | Never-visible page that renders the narrated video. A service worker has no canvas, AudioContext or MediaRecorder; an offscreen document has all three. Only `chrome.runtime` is available to it, so the guide arrives by message and the finished blob leaves as a `blob:` URL for the worker to download. |
| `render.js` | `window.FSRender`. Draws annotations onto a canvas: scrim + spotlight, accent ring, numbered badge, and redaction via pixelation (see Annotations). Pure canvas, reused by editor preview AND every exporter. Also `focusRegion()`/`contentBox()` — pick the crop worth showing (see Presentation). |
| `exporters.js` | `window.FSExport`: `.html`, `.markdown`, `.pdf` (jsPDF), `.pptx` (PptxGenJS), `.video` (canvas → MediaRecorder webm + optional narration), plus `aiText`/`ai` — the AI handoff (see The AI handoff) — `apiLogText`, the API log on its own, and `curlOf`, one logged request as a cURL (shared by both text exports and the editor). Those three are the **only** ones that emit `step.network`; leave a new exporter out of it too. Also owns `PACES`/`stepSecs` — the single source of truth for pacing, which the editor's dropdown is built from. |
| `tts.js` | `window.FSTTS`. Offline neural narration: espeak-ng (wasm) → phoneme ids → Piper VITS via onnxruntime-web → mono PCM. `synth(text, {rate})` → `{pcm, sampleRate, duration}`. Loads `lib/ort` + `lib/piper` + `lib/voices` lazily on first use. |
| `sync.js` | `window.FSSync`. **Auth only** — email/password plus Google via `chrome.identity.launchWebAuthFlow`; Identity Toolkit REST for email/password, tokens in `chrome.storage.local`. Publishing used to live here and now lives in `web/assets/publish.js`, so there is one implementation of the upload rules rather than two. The popup gates on this session, and the dashboard adopts the same one over the bridge (`gg_session`) so nobody signs in twice. |
| `tools/sync-web-assets.mjs` | Mirrors `render.js`, `exporters.js` and the two vendored exporter libs into `web/assets/`. `--check` fails if a mirror is stale. |
| `tools/set-extension-key.mjs` | Writes the store item's public key into `manifest.json` as `key`, which pins the extension id so an **unpacked build loads under the store id on every machine**. Without it Chrome derives the id from the folder's absolute path, so every tester gets a different id and anything registered against one — the OAuth redirect URI especially — works only for whoever registered it. Verifies the key against the known store id and refuses a mismatch, because the wrong key would mint a *third* id and break OAuth and the bridge at once. `--check` is in the build step. |
| `tools/bg-harness.mjs` | The real `background.js` in a `vm` with a stubbed `chrome`, shared by the worker tests. Add missing chrome APIs here — a missing stub throws inside the worker and surfaces as an unrelated failure two tests later. Its `storage.remove` handles arrays as well as single keys, which buffer eviction needs. `evalIn(h, code)` runs an expression in the worker's own scope: `background.js`'s top-level `const`s live in the vm's global *lexical* environment, so `h.sandbox.BUF` is undefined while `evalIn(h, "BUF")` works — that is the only handle on them. |
| `tools/context-test.mjs` | Asserts which tab events become steps (see Context steps). Negative cases are mutation-checked: dropping the `!tab.active` guard or the `seen` comparison fails them. `node tools/context-test.mjs`. |
| `tools/recorder-test.mjs` | Drives the real `recorder.js` in a stubbed DOM. Weighted towards the orphan cases — including the two that a `try` beside `sendMessage` cannot catch, which both shipped. Cases 5 and 6 fail against the pre-`safeSend` file. Case 8 covers the netpatch relay's reshaping and caps; note it reaches in for the vm's `window` *proxy* (`h.win`), because `sandbox !== window` inside the context and recorder.js checks `e.source`. `node tools/recorder-test.mjs`. |
| `tools/buffer-test.mjs` | Asserts the catch-up buffer, weighted towards when it does **not** capture. All the guards — armed origin, recording, incognito, password field, age cap, count cap, session-granular eviction, unarmed context steps — are mutation-checked; removing any one fails at least one assertion. It shrinks `BUF.maxSteps` via `evalIn` rather than writing 245 steps to prove the cap. `node tools/buffer-test.mjs`. |
| `tools/net-test.mjs` | Asserts the API log, weighted towards what it refuses to record: nothing while idle, nothing from an unarmed origin or incognito, nothing that isn't an xhr/fetch, no 2xx bodies, no exchange without a matching request, no page-written log, and no credential value however it was posted. Also asserts `curlOf` directly (it is pure, so it is loaded in a `vm` with a stubbed `window`). Mutation-checked — removing the worker-side header mask fails two assertions. `node tools/net-test.mjs`. |
| `tools/make-icons.mjs` | Draws every icon from scratch — no dependencies, PNG written by hand over `zlib`, ICO by hand around that. Ochre tile, paper wordmark glyph. Outputs the extension's `icons/icon{16,48,128}.png` **and** the site's `web/favicon.svg`, `web/favicon.ico` (16+32) and `web/apple-touch-icon.png` (180). One generator so the tab icon and the toolbar icon can't diverge. `--check` fails if any of them drift, and it's wired into the RUNBOOK build step — the old icons went stale through a repalette unnoticed, because a PNG never appears in a grep for a hex value. |
| `web/app.html` + `web/assets/app.js` | **The editor.** Guide library and step editor for both local guides (over the bridge) and published ones (over Firestore). |
| `web/assets/bridge.js` | `window.GGBridge`. The page side of `externally_connectable`. |
| `web/assets/publish.js` | `window.GGPublish`. `publish()` creates a guide document; `republish()` updates one **in place** so a shared link never goes stale. |
| `web/assets/gg.js` | `window.GG`. Firebase auth + Firestore over REST for the website, including the Google OAuth redirect flow (see Google sign-in). |
| `web/auth.html` | The OAuth landing page, and nothing else. One redirect URI to register instead of one per page. |
| `web/g.html` + `web/assets/viewer.js` | The public guide page. Read-only, plus exports if the owner allowed them. render.js, exporters.js, the bridge and the two exporter libs are all injected on demand — a reader who only reads shouldn't download an exporter. |
| `web/api/delete-assets.js` | Server-side, and one of two. Deletes Cloudinary images, which needs the API secret. Two modes: delete a guide and its images, or purge one superseded asset tag. |
| `web/api/og.js` | Server-side. The link-preview page for a shared guide — the guide's own title and step count, plus the banner. Reached **only** by preview bots, via the user-agent `has` rule in `web/vercel.json`; a human never depends on it (see Link previews). |
| `tools/make-og.mjs` | Generates `web/og.png` and `web/og-guide.png` (1200×630) by screenshotting an HTML design with headless Chrome — a banner is mostly type, and rendering type needs a font rasteriser, which is a worse dependency than a browser already on the machine. `--check` asserts existence only, not bytes: Chrome's text rasterisation varies by version, unlike `make-icons.mjs` where the generator owns every pixel. |
| `tools/og-test.mjs` | Drives `web/api/og.js` with a stubbed fetch. Weighted towards what must never appear in a preview — an unpublished guide's title, unescaped markup, anything from the guide's own images — and towards degrading rather than failing. `node tools/og-test.mjs`. |
| `lib/jspdf.umd.min.js` | jsPDF 2.5.1. Global: `window.jspdf.jsPDF`. |
| `lib/pptxgen.bundle.js` | PptxGenJS 3.12.0. Global: `window.PptxGenJS`. |
| `lib/ort/` | onnxruntime-web 1.18.0, wasm backend only (`ort.wasm.min.js` + `ort-wasm-simd.wasm`). Global: `window.ort`. |
| `lib/piper/` | piper_phonemize wasm build (espeak-ng). Global: `window.createPiperPhonemize`. The 17MB `.data` is the espeak-ng dictionary. |
| `lib/voices/` | Piper voice `en_US-hfc_female-medium` (60MB `.onnx` + its `.json` config, 22.05kHz). |
| `icons/` | Generated PNG icons — output of `tools/make-icons.mjs`, not hand-edited. The site's favicons come out of the same script into `web/`. |

## Data model (chrome.storage.local)
- `fs_state` → `{ recording, guideId, stepCount, captureBodies }`
  (`captureBodies` is Tier 2 of the API log, chosen at Start — see The API log)
- `fs_net_<guideId>` → the API log while recording. **Scratch**: folded onto the steps by
  `attachNetwork()` at `finalizeGuide()` and then deleted.
- `fs_bufnet` → the same for catch-up capture, expiring with the sessions it describes
- `fs_buf_bodies` → `true` if catch-up may keep failed response bodies (off by default)
- `fs_buf_origins` → `{ "<origin>": true }`, or `{ "*": true }` for everywhere (see Catch-up capture)
- `fs_bufindex` → array of buffered step ids, oldest first. **Sessions are derived from this by
  `groupSessions()`, not stored** — there is no session key to keep consistent with it.
- `fs_bufstep_<id>` → one buffered step, same shape as a real one
- `fs_bufdone` → `{ "<sessionId>": <timestamp> }`, sessions already turned into a guide
- `fs_index` → array of `{ id, title, createdAt, startUrl, stepCount, remoteId?, publishedAt? }` (newest first)
- `gg_auth` → the account session `{ uid, email, idToken, refreshToken, expiresAt }`
- `fs_steporder_<guideId>` → array of step ids (defines order)
- `fs_step_<stepId>` → one step object

Step object:
```
{
  id, guideId, seq,
  type: "click" | "input" | "key" | "note" | "switch" | "nav" | "scroll",
  url, pageTitle, timestamp,
  tabId,                   // which tab it happened in; only the API log reads it
  dpr,                     // bitmap px per CSS px for this step's screenshot
  point: { x, y },         // click point, CSS px within viewport
  rect:  { x, y, w, h },   // target element bounds, CSS px within viewport
  text,                    // editable description
  screenshot,              // WebP dataURL of visible viewport, or null for notes
  blurs: [ { x, y, w, h } ], // redaction rects, CSS px
  network: [ { method, host, path, status, ms, ok, scheme?, error?,
               body?, bodyTruncated?,                        // response, Tier 2
               reqHeaders?, reqBody?, reqBodyTruncated? } ], // request, Tier 2 — the cURL

  networkMore              // requests beyond NET.maxPerStep, count only
}
```
Coordinate rule: any CSS-px value maps onto the bitmap by multiplying by `dpr`. `render.js`,
`focusRegion` and the editor's redaction maths all rely on exactly this and nothing else.

`dpr` is **not** `devicePixelRatio` — `recorder.js` sends that, and `background.js` then
multiplies it by however much it downscaled the capture (see Screenshot normalisation). One
number carries the whole CSS-px → bitmap-px relationship, which is what lets the capture size
change without touching a single consumer.

## Recording flow
popup Start → `background.startRecording` (creates guide, sets state, injects recorder into
active tab, broadcasts) → `recorder.js` attaches listeners + shows pill → each click/input
sends `fs_capture_step` → background captures the screenshot and appends the step → pill
counter updates via `storage.onChanged` → Stop opens `/app#local-<guideId>` — the dashboard,
not an extension page.

The popup gates on the account session before any of that: no session, no Start button.

**Recording is not scoped to one tab.** `recorder.js` is a declared content script on
`<all_urls>` that reads `fs_state` on load and self-attaches if a recording is in progress,
and `broadcast()` reaches every tab — so clicks in a second tab were always captured. The one
exception is a tab loaded *before* the extension was installed or reloaded: Chrome does not
inject into existing tabs retroactively, `sendMessage` to it fails, and clicks there are
silently dropped until the page is reloaded. That is worth saying to testers, because it looks
like the recorder ignoring them.

## Orphaned content scripts (recorder.js)
Reloading the extension orphans the `recorder.js` already running in every open page: the
code stays, its `chrome.runtime` handle dies, and the next `sendMessage` throws
**"Extension context invalidated"** *synchronously* — so a `lastError` check never sees it,
and neither does anything watching the callback. Chrome does not inject the new version into
existing tabs, so that page can never record again.

Unhandled, this was one thrown error per click with the pill still sitting there claiming to
record. `alive()` tests `chrome.runtime.id` (undefined once the context is gone), `retire()`
detaches the listeners and removes the pill, and both `send()` and the pill's Stop button are
wrapped in `try/catch` for the case where the context dies between the check and the call.

**Every chrome call after load goes through `safeSend()`, and the reason is the callback
rather than the call.** A `try` around `sendMessage` returns before the reply arrives, so a
`catch` beside it cannot see anything the callback throws — and the callback is where the
context most often dies, because the gap between asking the worker something and hearing back
is exactly when someone hits reload on the extensions page. Reading `chrome.runtime.lastError`
in that state throws on the `chrome.runtime` lookup itself. This shipped twice: once from
`send()`, and again from the pill button's chained `fs_stop` → `fs_open_editor`, where the
second call lives inside the first's reply. `tools/recorder-test.mjs` cases 5 and 6 fail
against the version before `safeSend`.

`orphaned` is declared at the top of the file, not beside `retire()` where it is used, because
the boot path calls `askBuffer()` → `safeSend()`, which reads it. `chrome.storage` callbacks
are always async so in Chrome the declaration has always been reached first — but that is a
scheduling detail to not depend on.

Two consequences to keep in mind:

- **Reloading the page is the only real fix, and only the user can do it.** After reloading
  the extension, reload any tab you intend to record. Same for testers on a fresh install.
- **Don't "simplify" the guard to a `lastError` check.** The throw is synchronous; that is
  the whole reason it reached the Errors pane instead of being swallowed.

Verified both ways in a stubbed DOM: on a live context a click sends one step and the pill
stays; on an orphaned one nothing throws, nothing is sent, the pill is removed and the
listeners are gone. The pre-fix file throws `Extension context invalidated.` on the same
input, which is what makes that a test rather than an assertion of current behaviour.

## Context steps — tab switches and navigations (background.js)
Clicks across tabs were recorded; the *move* between them wasn't, so a guide jumped from a
click in one tab to a click in another with nothing explaining it. Clicking a tile that opens
a new tab is the common case. Two listeners, one step shape, and the order between them is
what stops one action producing two steps:

- **`tabs.onActivated`** → a `switch` step. A *newly opened* tab fires this while its url is
  still `""` or `about:blank`, so the `RECORDABLE` (`^https?:`) test rejects it and the
  navigation below is what gets recorded instead. Switching to an already-loaded tab has a
  real url, lands here, and never reaches `onUpdated`.
- **`tabs.onUpdated`** (`status === "complete"`, active tab only) → a `nav` step. A background
  tab finishing a load is not something the user did.

Three things to keep:

Both also fire for an **armed catch-up origin** while no recording is running (see Catch-up
capture) — same dedupe, same step shape, `BUF.shot` instead of `SHOT`, written through `bufWrite`.

1. **`seen = {tabId, url}` is the noise filter.** A tab+url already recorded produces no
   second step, which is what absorbs a site firing `complete` twice, a hash-only change, and
   a bounce back to a previous tab. It is in-memory on purpose: a worker restart mid-recording
   can cost one duplicate step, which is cheaper than a read-modify-write of persisted state on
   every navigation. `seedContext()` at `startRecording` is why the starting tab is never
   announced as a switch to itself.
2. **No `point` or `rect`.** Nothing was clicked, so `render.js` draws the screenshot
   unannotated — it already guards on `step.rect`. `dpr` starts at 1 and `persistStep` folds
   the downscale in, so the editor's redaction maths round-trips as it does for a click.
3. **`guessTitle` skips `switch` and `nav`.** `stepLabel` lifts the first quoted string, and a
   switch step's quoted string is a tab title — that produced *"How to view Canva in Canva"*.

Both listeners go through `enqueueCapture` and `stepChain` like a click, so ordering and the
capture rate limit are unchanged. Tests: `tools/context-test.mjs` drives the real
`background.js` with a stubbed `chrome`, and the negative cases are mutation-checked — dropping
the `!tab.active` guard or the `seen` comparison fails them.

## Catch-up capture — "Capture last 2 minutes" (background.js + recorder.js + popup + app.js)
**The feature is "capture the last 2 minutes", and the name is not decoration — it is the spec.**
The pain always arrives *after* the fact: you finish something, then someone asks how, and by
then Start is useless. Anything that makes this a decision taken *beforehand* is working against
the feature. The first version got this wrong in a way worth recording: the on-page pill offered
"Make a guide" of the whole buffer, and the popup said "Catch-up capture" — engineer-speak for a
mechanism, with no button anywhere that said the thing people actually want.

**You cannot screenshot the past.** The only way to answer that is to have been capturing all
along and throwing it away, and that is the entire reason for every constraint below.

- **Armed per origin, off by default.** `fs_buf_origins`. A blanket always-on buffer eventually
  holds a screenshot of the user's bank, and no wording on a settings page makes that a
  reasonable default. Armed on the two or three admin panels someone actually documents, the
  surface is small enough to explain in a sentence. `"*"` arms everywhere and is deliberately
  expressible — some people will want it — but the popup never sets it.
  **Know the cost of this choice**: arming is a before-decision inside a feature about deciding
  after, so the first time someone wants this on a new site it is empty. Mitigate by *offering*
  to arm when the intent is proven — after a deliberate recording on that site — never by arming
  silently. See the backlog.
- **No new permissions.** `<all_urls>` and the declared `recorder.js` content script were
  already there; the recorder has always run on every page and done nothing. So this is a
  *behaviour* change, not a capability one — which is exactly why the store listing has to be
  re-worded (it currently says "The recorder does nothing until you press start") even though
  the permission list does not move.
- **Sessions are derived, never stored.** `groupSessions()` splits the flat `fs_bufindex` on a
  30-min idle gap (`BUF.sessionGapMs`) or a change of origin. No second index to keep consistent,
  no migration for anything already buffered, and the grouping rule can change without touching
  stored data. A session's id is its first step's id.
- **Both caps are per session, not per step.** `BUF.maxSteps` 240, `BUF.maxAgeMs` 7 days. Age
  drops whole sessions; the count cap drops whole sessions oldest-first and only trims
  mid-session when one session alone is over cap. The reason is the dashboard: a card promising
  "expires in 6 days" over a session that has quietly lost its first half is a lie, and
  step-granular expiry produced exactly that.
- **The two caps have to agree about what is promised.** 40 steps was the original count cap and
  it made a 7-day retention decoration — ~40 clicks of ordinary work evicted yesterday's session
  before lunch, so nothing survived a night whatever the card said. If you lower `maxSteps`,
  lower `maxAgeMs` with it. `tools/buffer-test.mjs` asserts a 26-hour-old session survives.
- **Disclosure on the page, and redemption in both places.** recorder.js shows a bare `fs-buf`
  **dot**, not a pill. Hovering it expands the status *and* a `Capture last 2 min` button
  (`fs-cap` → `fs_buf_capture`), because the moment someone wants the last two minutes is the
  moment they are still looking at the page, and sending them to the toolbar first is a detour
  away from what they just did. **This is not the button that was rejected in v1.2**: that one
  said "Make a guide" of the *entire* buffer, on a pill that claimed to be recording — a wrong
  action under a false status. The dot still says nothing until hovered, still admits it is only
  *holding* steps, and the action is now the slice. Two guards on it: the click must be
  `isTrusted`, since the button lives in the page's own DOM and `.click()` from a page script
  would otherwise mint a guide out of the buffer silently; and no `sessionId` crosses the
  boundary — the worker resolves it from `sender.tab.url`, the same rule `fs_buf_status` uses, so
  the button can only ever redeem the site it is sitting on. The full pill said "something is being written down", which
  while buffering is false in the other direction — nothing is going into any guide and there is
  nothing to stop. It names itself on hover (a `max-width` transition, so a host page killing
  transitions degrades to an instant label rather than to nothing) and says nothing the rest of
  the time. An invisible always-on capture is what people are right to be afraid of; a fake
  status is the opposite error.
- **The popup's primary action is the slice, not the session.** "Capture last 2 minutes"
  (`BUF.sliceMs`), with "Capture all N" as the fallback for when two minutes wasn't enough. The
  slice is measured back from the **session's own end**, never from now, so an older card offers
  its own last two minutes rather than an empty one. It cannot slice to nothing — the last step
  sits at `endedAt` — so there is no empty-guide guard and one was deleted for being unreachable.
- **A focused password field loses the picture, keeps the words.** `step.noShot` from
  recorder.js; no capture is even attempted. The words were always safe — a typed value is
  never recorded — but the screenshot is the whole viewport, and unlike a recording the user
  never asked for this one.
- **Recording always wins.** `bufferStep` returns early if `fs_state.recording`, or the click
  would be captured twice and spend two captures against the rate limit for one action.
- **Tab switches and navigations are buffered too.** `contextStep` used to return early unless a
  recording was running, so a promoted guide jumped between tabs with nothing explaining the move
  while a recorded one said "Switch to the … tab" — the same flow reading *worse* for having been
  captured after the fact. Both paths now write through `bufWrite`, which is the one place a
  buffered step is persisted, so they cannot drift again.
- **Nothing here is ever uploaded.** The buffer is not a guide; `publish.js` never sees a
  `fs_bufstep_` key. Promotion creates a real guide and publishing that is the same deliberate
  act it always was. `gg_buf_sessions` returns metadata only — no steps, no screenshots.
- **Promoting marks, never consumes.** `promoteBuffer({sessionId, minutes})` copies into the
  normal guide keyspace with fresh ids and runs the same `finalizeGuide()` a recording gets, so a
  promoted guide is indistinguishable downstream. The session is then recorded in `fs_bufdone`
  rather than deleted, because the common case after promoting is wanting a *different* slice of
  the same few minutes. That mark is what makes "captures you haven't redeemed yet" answerable,
  and `markRedeemed()` prunes marks whose session has expired so the map can't grow forever.
- **The dashboard lists pending captures beside guides.** `pendingRow()` in `app.js` — dashed
  border, ochre `Catch-up` badge, `deletes in 6 days`, and no Open, because there is nothing to
  open until it is a guide. They are counted separately in the subtitle for the same reason.
  Loading them is best-effort: an extension too old to answer `gg_buf_sessions` must not take the
  library down with it.
- **Buffered captures are cheaper** (`BUF.shot`, 1280px q0.8) than a recording's, because they
  run on clicks nobody asked to record. A promoted guide is slightly softer than a recorded one,
  which beats not existing.

## The API log (background.js + netpatch.js + app.js + exporters.js)
What fired on each step, and what came back. `Click "Save" → POST /api/orders → 500` is a bug
report someone can act on; "clicked Save, it didn't work" is a guessing game. This is a
**handoff** feature — `aiText()` and `apiLogText()` are the only exports that carry it.

**Two tiers, and the line between them is the design.**

- **Tier 1, the summary** — `chrome.webRequest`, on for every recording and every armed
  catch-up origin. Method, path, status, duration. `webRequest` **cannot read a response
  body**, at any permission level, and never could — so the cheap tier is free of the one
  thing that makes this feature dangerous.
- **Tier 2, the whole exchange, as a cURL** — request headers, the body sent and the body
  returned, for **every** request whatever its status. Needs the page's own `fetch`/`XHR`, so
  `netpatch.js` runs in the **MAIN world**. Opt-in, off by default, on both surfaces separately
  (`fs_state.captureBodies` for a recording, chosen at Start; `fs_buf_bodies` for catch-up).

**This narrowed twice and both cuts were wrong. Don't re-narrow it.** First it was failed
exchanges only, which left a guide of a flow that *worked* — most guides — holding nothing but
status lines. Then it was every request but responses only on failure, which left "what did it
come back with" unanswerable, and *"the search returned the wrong rows"* is not a failure status.
Both times the log could not answer the question its user opened it with, because **which request
matters is not knowable from the status code.**

What carries the safety instead, now that a 200's body is kept:

- **The opt-in is the protection**, so it must stay off by default and stay per-recording. The
  label says what it keeps (`Include full API requests & responses`), and the privacy policy has
  a callout rather than a clause.
- **`netScrubBody` masks credential-looking keys inside a body**, in the worker, over what
  netpatch.js already masked in the page. A sign-in *response* is a 200 and carries the token —
  that is the case this exists for.
- **Two caps** (`NET.maxBodies` 250, `NET.maxReqs` 400), because a body is kilobytes and a
  request line is hundreds of bytes. A request over the body cap still records its request side:
  losing the cURL because one response was long is the wrong half to drop.
- **Nothing changes about publishing.** `publish.js` whitelists fields, so no body has ever left
  the machine, and that is now load-bearing rather than tidy.

**Why Tier 2 is the exchange and not just the response.** A status line says a call failed and
nothing about what was sent, so acting on it means asking the reporter to reproduce it — which
is the thing this product exists to remove. `POST /api/orders → 500` was not worth the feature;
a cURL an engineer or a model can read is. `exporters.js → curlOf()` builds it, and both text
exports and the editor use that one builder.

Rules that are not negotiable:

1. **Header *names* are kept; credential *values* never are.** That a request carried an
   `authorization` header is the diagnosis; the token is not. `NET.maskedHeader` matches
   anything whose name looks like a credential and the value becomes `NET.mask` — masked in the
   page first (netpatch.js's `MASKED_HEADER`, so a secret never crosses the boundary) and again
   in the worker (`netScrubHeaders`, because the page shares the `postMessage` channel and
   could post an unmasked value for us to store). Two masks on one rule, deliberately. There is
   **no toggle to keep a real token** — the destination for this data is a chat window.
   `chrome.webRequest` still reads no headers at all: `onBeforeSendHeaders` is not registered
   anywhere, and the bg-harness stub deliberately omits it so adding one is a visible change.
2. **Query *values* are masked, names kept** (`netPath` → `?token=…&page=…`). Stripping the
   query wholesale, which this used to do, made two different failures identical in the log and
   made the cURL a guess. The names identify the call; the values are where ids and session
   keys ride. `maskBody`/`MASKED_KEY` in netpatch.js does the same job for a sent body, so a
   login request's password never lands.
3. **Secrets are masked inside bodies, not just headers.** `NET.maskedKey` /
   netpatch.js's `MASKED_KEY` cover `password`, `token`, `access_token`, `api_key` and friends
   in JSON and form-encoded bodies, in both directions. Mutation-checked: `tools/net-test.mjs`
   asserts an `access_token` in a **200 response** never reaches storage.
4. **The exchange annotates a request; it never creates one.** The page shares the
   `postMessage` channel `netpatch.js` uses, so it is matched against something `webRequest`
   independently saw (tab + status + path) and dropped otherwise. `netBody` is a source of
   hints, not records. Caps live worker-side for the same reason (`maxHeaders`, `headerChars`,
   `reqBodyChars`) — a page must not be able to make one entry arbitrarily large.
5. **`gg_update_step` accepts `network: []` and nothing else.** The editor may *remove* a log
   — the escape hatch for a body nobody read before it was captured — and may not write one.
6. **Publishing never sends it.** `publish.js` builds an explicit field whitelist; that is why
   it must not become a spread.
7. **`chrome.debugger` is not an option**, though it would read every body. It paints a
   "started debugging this browser" banner, blocks DevTools, and is close to an automatic
   store rejection.
8. **Turning Tier 2 off deletes the request side too.** `fs_buf_bodies` off strips `reqHeaders`
   / `reqBody` / `reqBodyTruncated` alongside `body`, or "off" would be a promise about
   responses only.
9. **A captured cURL is a record, not a replay,** and the output says so in a trailing comment.
   Credentials are masked, query values are masked, and `Cookie` is out of reach entirely — the
   browser attaches it below the page's `fetch` and an HttpOnly cookie is invisible to page
   script. Don't "improve" this into something runnable.

**Correlation** (`attachNetwork`): each request goes to the last step at or before it, in the
same tab, within `NET.windowMs` (10s) — which is why steps now carry `tabId`. Done in **one
pass** at `finalizeGuide()` (or at promotion), not incrementally: a request arrives *after* its
click, so attaching on the way in would mean patching an already-written step on every
response. `fs_net_<guideId>` is scratch and is **deleted** once folded onto the steps, so there
is never a second copy to redact.

**What Tier 2 cannot see, and Tier 1 can.** `netpatch.js` patches the page's `fetch` and `XHR`
at injection time, so it misses calls made through references taken earlier, plus Workers,
Service Workers, `sendBeacon`, WebSockets and EventSource. The summary covers all of them —
`webRequest` watches the network, not the page. Don't "fix" this by patching more surfaces; the
summary is already the complete picture and the exchange is a bonus on failures. It is also why
`curlOf()` returns `""` for a summary-only entry rather than emitting `curl -X POST <url>` off
Tier 1 — that would look like a capture and be a guess.

### The UX problem, which is the real one
A single-page app fires requests on nearly every click, so **rendering every step's log inline
turns a nine-step guide into two hundred monospace rows.** The split is on whether anything
failed:

- **All fine** → one muted line, `netquiet` / `.netlink`: "5 requests", no expansion. A fact
  about the step, not something to read.
- **Something failed** → `.netlog.bad` inline, open, failures only, ochre left edge. The one
  case where the log *is* the point; hiding it behind a click hides the answer.
- **Everything, in full** → the drawer (`openNetLog`), reachable from any step and from the
  toolbar button, whose label carries the failure count. Sticky group headers, "failed only"
  filter defaulting on when there are failures, and a copy button. Nothing truncated there —
  which is what lets the inline view stay that small.

A row carries up to two labelled blocks (`netDetail` → `netBlock`): **Request** — the cURL,
with a Copy cURL button — then **Response**. `netItem` decides whether they start open: **a
failure opens itself, a success keeps its cURL behind a `.netpeek` button.** Once every request
had a cURL, a step that fired forty of them would otherwise have rendered forty open code blocks
— the exact wall this feature is designed around. Same data either way; only the reading order
changes. Labels are not decoration: two runs of
monospace under one row with no seam between them is precisely the "filled with logs" failure
this feature has to avoid. Request first, because that is the order they happened in and what
someone reproducing the bug needs first.

Blocks clamp with a mask fade and an explicit expander, not a scroll box: a nested scroll region
inside a scrolling page is the worst pattern on the web. The clamp is an exact multiple of the
line height so it never slices a line in half. **Response clamps at 8 lines, the cURL at 16**
(`.netbody.tall`) — a cURL is bounded by how many headers a request had and is the thing someone
came to read, while a stack trace is unbounded.

**Whether to clamp is decided from the text, never by measuring the element**, and both wrong
ways have shipped. `max-height` lives on `.clamped` alone, so an unclamped `<pre>` reports
`scrollHeight === clientHeight` however long it is — the original "measure, then clamp if it
overflows" therefore never clamped anything and a 200-line trace rendered in full. Clamping
first and then measuring does work, but only after layout settles: at `setTimeout(0)` the same
content measured taller than it ends up, so an expander appeared under fully visible text.
Counting newlines plus a wrap allowance needs no layout and is wrong only at the margin.

`NET.maxPerStep` is 50, deliberately generous — the *display* is what stays small, and
conflating a capture limit with a display limit is how you end up unable to answer the question
the user has.

## Screenshot normalisation (background.js)
`captureVisibleTab` hands back a full-retina PNG — ~3024×1700, 1–3 MB per step. Every exporter
downscales to 1600px anyway, so those bytes were stored and then thrown away. `normalizeShot()`
re-encodes each capture to **WebP at a 1600px width cap** (`SHOT`, q0.92): measured ~5× smaller
on a synthetic dashboard, more on real retina captures. It relieves `chrome.storage.local`,
makes the editor quicker, and it is what makes the dashboard bridge possible at all — a
full-res guide cannot be moved over `sendMessage`.

Four things to know before touching this:

1. **The width cap matches every consumer's own cap** (`exporters.js` and `sync.js` both use
   1600). On the common case — a dense dashboard, where `focusRegion` returns the full frame —
   the exported image comes out at exactly the size it did before. Pages that genuinely crop
   lose some magnification headroom; that was the trade accepted for the bridge.
2. **The downscale factor is folded into `step.dpr`**, not stored separately. Every consumer
   already treats `dpr` as bitmap-px-per-CSS-px, so folding keeps `render.js`, `focusRegion`
   and the editor's redaction maths correct with no changes of their own, and every annotation
   lands at the same size *relative to the image*. Don't add a second scale field.
3. **Three stages, three different serialisations**, and they are not interchangeable:
   *capture* stays on `captureChain` (serialized and prompt — the page must not move on before
   its screenshot is taken); *encode* runs off-chain so it overlaps the next capture instead of
   delaying it; *persistence* is serialized on `stepChain`, claimed in click order. Put the
   ~300ms encode on the capture chain and screenshots start lagging the clicks that caused
   them. Take `stepChain` away and steps land in encode-completion order — verified, it
   reverses a three-click burst.
4. **`fs_capture_step` is acked as soon as the pixels exist**, before the encode. `recorder.js`
   hides its pill until that response arrives, so acking after the encode blinks the pill out
   on every click. The count in the ack is cosmetic and `storage.onChanged` re-syncs it from
   `fs_state` when the write lands. For the same reason `persistStep` re-reads the live state
   before updating the counter: Stop can land mid-encode, and writing back the state the step
   was captured under would set `recording: true` again.

Guides recorded before this change keep their full-res PNGs and a true-`devicePixelRatio`
`dpr`, and render identically — the fold is per-step, so old and new steps coexist.

## The AI handoff (exporters.js → `aiText`)
The lead feature. `aiText(guide, steps)` returns Markdown; `ai()` downloads it; the UI on both
surfaces copies it to the clipboard instead, because the destination is a chat window and a file
on disk is one step further from it. Five things are load-bearing:

1. **It is text only, and says so in its own header.** Every other exporter embeds the
   screenshot as a data URL. Forty of those is several megabytes of tokens no chat window will
   take — and a model told to expect images that never arrived describes them anyway. The
   header line "the screenshots are not included" is there to stop that.
2. **Steps are grouped under the URL they happened on**, emitted only when it changes. That is
   the shape of the information — a workflow is a few pages with several actions on each — and
   repeating one URL on forty lines is noise. A `note` never opens a group; it isn't something
   that happened on a page, and letting it start one splits a run of actions around a comment.
3. **`url` and `pageTitle` travel with a published step** (`publish.js`), so a recipient opening
   a shared link can hand it off too. Both the privacy policy (§2) and the store listing already
   stated that publishing sends "the page URLs and titles recorded with each step" — this was
   the code catching up to a declaration, not a new disclosure. `saveRemoteSteps` in `app.js`
   must keep carrying them, or editing a shared guide's wording silently strips them.
4. **`'ai'` is whitelisted in `firebase/firestore.rules`.** The export log validates `kind`
   against a fixed list, and `record()` swallows failures — so a format missing from that list
   logs nothing, silently. A new format needs a line there *and* a rules publish, which is a
   **manual step in the Firebase console** — there is no `firebase.json` or `.firebaserc` in
   this repo, so `firebase deploy` has nothing to read and a `git push` does not touch rules.
   `firebase/SETUP.md` §3 is the procedure: paste the whole file into the Rules tab and
   Publish. Pasting the file rather than editing the one line is what keeps deployed and
   committed identical.
5. **A success's body is clamped harder than a failure's** (8 lines against 24) — the one place
   an export second-guesses the log. Bodies exist for every request now, and forty full result
   sets is a handoff no chat window will take, while the failure is the thing being asked about.
   `apiLogText` (the drawer's Copy log) trims nothing, so nothing is actually lost.
6. **It skips `exportSteps()`/`allImages()`.** There are no images in it, so pulling forty
   screenshots over the bridge one at a time would be forty round trips for nothing.

## Narration (video export)
Narration works and is fully offline, and since v1.1 it runs in an **offscreen document**
driven from the dashboard over the bridge. It has to: the voice is 88MB of model in `lib/`,
which the website may not serve, and a service worker has no canvas, AudioContext or
MediaRecorder. Three things that document needs and a visible page didn't:

- `tickMs: 33`. An offscreen document is never visible, so `requestAnimationFrame` never
  fires there — the 100ms hidden-tab fallback is the *only* clock the picture has, and left
  at 100ms the whole video renders at 10fps against a `captureStream(30)`.
- `monitor: false`. Don't connect narration to the speakers. In a visible page that was
  reassuring feedback; from an invisible document it is a voice from nowhere.
- `onBlob`. The document only has `chrome.runtime`, so it can't call `chrome.downloads`. It
  hands back a `blob:` URL and the worker downloads it — then waits for the download to
  reach `complete` before closing the document, because the blob dies with it.

Rules if you touch the synthesis itself:

1. **Never go back to `speechSynthesis`.** The Web Speech API exposes no audio stream, and on
   macOS its voices are rendered by the OS outside the tab's audio graph — so its output can
   never be recorded into an export. `chrome.tabCapture` cannot reach it either; that was the
   old broken approach and `tabCapture` has been dropped from the manifest. `FSTTS` exists
   because Piper hands us actual samples we own.
2. **Synthesize everything before `rec.start()`.** Piper takes ~1–3s per step; running it
   while recording would mux that dead air into the video. `video()` pre-renders every clip,
   then plays them through a `MediaStreamAudioDestinationNode` whose track is added to the
   recorder's `MediaStream`.
3. **One clock owns both picture and sound.** `buildTimeline()` lays out every slide's
   start/duration up front; all clips are scheduled with `src.start(t0 + seg.start)` against
   `audioCtx.currentTime`, and the draw loop picks its slide by reading that *same* clock.
   Never sequence slides with awaited `setTimeout`s — the per-step error accumulates and the
   narration walks off its slide (this was a real bug).
4. **Keep the dither running.** `startDither()` feeds -80dBFS noise into the recorder's audio
   destination. Opus discards pure-silence packets, which shortened the audio track by ~1.8s
   over a 4-step guide and desynced everything after the first gap. It's inaudible and routed
   to the recorder only — do not "optimize" it away.

A/V alignment is the regression test that matters here: decode the exported webm and compare
the audio track's duration against the video's. They should agree within ~0.05s.

Pacing: step duration comes from the step's own text (`stepSecs` — words ÷ wpm + pad, floored
at `min`), never a fixed seconds-per-step. The pace preset also sets Piper's `length_scale`
(inversely), so "Fast" speeds the voice up and shortens the slide together. Slide length is
`max(stepSecs, actual audio length + pad)`.

## Annotations
One accent, one idea: a very light scrim (0.07) over the screenshot, the target lifted back out of the
scrim undimmed, a **burnt-orange** ring (`#c2410c`) around it, and the number badge placed
**outside** the ring (flipping side when it would fall off the frame).

The ring colour is a functional choice, not a brand one, and it is deliberately a constant in
`render.js` rather than a CSS token — a PDF has no theme. It has to stay legible drawn on top
of whatever the user was looking at, which for this product is nearly always a blue-grey admin
panel. The old purple sat close enough to that chrome to disappear into it: on a navy sidebar
it was almost invisible, verified by screenshot. Orange cannot be. If you change it, check it
against a dark navy background first. What this replaced, and why not to go back:
a red box *and* a red ripple *and* a badge sitting on top of the very element it pointed at —
three marks competing, with the target obscured. There is deliberately **no cursor dot**; inside a
text field it landed on the label the reader was trying to read.

## Presentation (video)
Video renders at **1920×1080** and asks MediaRecorder for **12 Mbps**. Both matter: the source
screenshots are full of small UI text, and MediaRecorder's default (~0.8 Mbps at 720p) smears
it. Don't lower either without measuring text legibility. The figures quoted below were
measured against the old full-retina (~3024px) capture; captures are now width-capped at
1600px (see Screenshot normalisation), so treat them as the relative argument they were made
for, not as current absolute readings.

`FSRender.focusRegion(step, srcW, srcH, aspect, {canvas})` decides what to show. It balances two
opposite failures, and both have already been shipped and rejected once:

- Letterboxing the **whole viewport** shrinks the UI to an illegible island (30px source text
  rendered at 10.2px).
- Zooming to the **clicked element** hit a flat 2× on every layout, slicing through cards, logos
  and body text and leaving the viewer with no idea what page they were on.

So the region is built from `contentBox()` — the page's real content, found by trimming uniform
background margins — then unioned with the padded target, then capped at `maxZoom` (1.5). This is
layout-adaptive: a centred card on an empty page crops to ~1.26×, a full-width dashboard doesn't
zoom at all. **Do not reintroduce an element-centred crop.**

Three invariants worth keeping a test on: the highlighted target (plus room for its ring and
number badge) must be fully inside the region — the aspect fit will otherwise crop away a target
near the bottom edge; zoom must never exceed `maxZoom`; and if fitting the aspect would slice into
the content box, `focusRegion` returns the **full frame** instead (it once cut a page logo down to
"age"). Losing magnification beats losing the page.

`contentBox`'s tolerance is deliberately low (8). Web apps put near-white cards on near-white
backgrounds and 1px borders downscale to a few percent of coverage — at a higher threshold those
vanish and the box collapses onto stray dark text.

Reality check on how much this buys: measured on real uEngage screenshots the content covers
100% x 100% of the viewport, so dense dashboards get **no crop at all** and the region is the full
frame. The crop only pays off on pages that genuinely centre a card in empty space. For dashboards
the legibility win comes from 1080p and the caption redesign, not from cropping.

Every exporter crops: video uses its frame's aspect, HTML/Markdown/PDF use `DOC_ASPECT` (1.6),
PPTX uses `SLIDE_ASPECT` (2.0), all via `cropToFocus()` in `exporters.js`. The gain is smaller in
the PDF (narrow column, both fit width-limited: 30px source text goes 4.95pt → 6.56pt) but the
column stops being spent on empty page margins.

Slides are warm paper (#f4f1ea) with an ink title card, a 34px-at-720p caption, the number in a brand circle, a
"Step n of m" counter, the screenshot on a white card with a soft shadow, and a progress bar
pinned to the bottom. Slides crossfade (0.4s) and push in slightly (4.5%) toward the highlight —
hard cuts between static slides were the main thing that made this read as a slideshow.

## UI conventions

### The palette: Ink & Paper
Warm neutrals, ink primary actions, one ochre accent. This replaced violet-600 on blue-slate,
which is worth knowing because that combination is the single most recognisable
generated-UI signature — it ships as the shadcn/v0 default — and it read as untrustworthy to
the one person whose product this is. Two rules hold it together:

1. **The neutrals are warm.** Every framework default is cool slate, so warm paper is the
   cheapest possible way to look deliberate. Don't "fix" `#fbfaf7` to `#fff` or `#15130f` to
   `#0b0e15`.
2. **Colour carries meaning; it is never decoration.** The primary button is `--pri` (ink),
   not the accent. So the only saturated things on screen are the ones that mean something: a
   step number, an annotation, the recording light, a guide that is shared. One accent applied
   to buttons *and* badges *and* numbers *and* rings is what "nobody decided anything" looks
   like — that was the old scheme's actual failure, more than the hue was.

Consequences worth not undoing:
- `--on-brand` exists because white text clears AA on the light ochre (5.1:1) but reaches only
  ~2:1 on the lighter dark-mode ochre. Text drawn on the accent must use it.
- The mark is a flat ink square. It was a purple gradient; a two-stop gradient logo is its own
  tell.
- The export menu icons are drawn SVG. They were emoji (🌐 📝 📄 📊 🎬) in a product that
  draws every other icon by hand.
- All 28 foreground/background pairings clear WCAG AA in both schemes. There's a contrast
  checker worth re-running if you touch the tokens: parse the `:root` blocks and compare.

`web/assets/site.css` starts with those tokens and everything else consumes them. The popup
carries its own copy, because an extension page can't load a stylesheet from the website.
Three more rules:

- **Both colour schemes, always.** Every token is redefined under
  `:root[data-theme="dark"]`. Never hard-code a hex outside the token block — and grep for
  `rgba(` too, not just `#`: the purple glow under the primary button and the cool-slate
  screenshot scrim both survived a hex-only sweep of the repalette.
- **Theme is a choice, not an OS reading, and the default is light.**
  `web/assets/theme.js` loads *synchronously in `<head>`, above the stylesheet* — that
  placement is the whole trick. It stamps `data-theme` before the first paint, so there is no
  flash and `site.css` needs one dark block instead of duplicated values behind a media query.
  Move that script tag below the `<link>` and you get a visible flash of the wrong theme.
  Three modes (`light` / `dark` / `auto`) in `gg_theme`; `auto` is stored as `auto`, never
  flattened to the resolved value, so it keeps following the OS. It also maintains the
  `theme-color` meta, which tints mobile browser chrome — that has to come from JS rather than
  two media-query `<meta>` tags, because the theme is a stored choice and a media query can
  only see the OS.
  Light is the default rather than the OS setting because every artefact this product makes is
  light — HTML export, PDF, published guide, video slides — so the editor matching the thing
  you're building beats one that flips with the time of day.
  The popup can't read that `localStorage`, so the dashboard pushes the choice over the bridge
  (`gg_set_theme` → `gg_theme` in `chrome.storage.local`) and `popup.js` stamps it before
  paint behind a `body.pre-theme { visibility: hidden }`. One frame of the wrong colours is
  very visible in a 296px panel.
- **Honour `prefers-reduced-motion`.** There's a blanket rule at the bottom of `site.css`
  killing transitions and animations; keep new motion inside that contract.
- **Never write `font: <size>/<lh> inherit`.** It's invalid shorthand, so it silently fails and
  the element falls back to the UA default — which is *monospace* for `<textarea>`. Every step
  description in the editor rendered as code until this was fixed. Set `font-family: inherit`
  as its own declaration.

**Grow textareas after the card is in the document.** A detached card reads `scrollHeight`
0, and the step text collapses to an invisible zero-height box. `renderEditor` calls
`autoGrow` after `appendChild`, never inside the card builder. This originally showed up only
on the *first* card to decode an image, which made it look intermittent.

**The extension and the website do not share CSS**, and they can't — the popup's styles ship
in the package while `web/assets/site.css` is served from Vercel. So any component that exists
on both surfaces has to be styled twice. This already bit once: the sign-in form was styled in
`site.css` only, which left the extension's dialog inputs falling through to the UA default —
a white box with an inset border, on a dark panel. The sign-in form now exists on **both**
surfaces (popup gate and `/app`), so it is exactly the component to check. If you add a form
control, cover it in `popup.html`'s `.field input` *and* `site.css`'s `.modal .field input`.

Retiring `editor.html` removed the drift *for guide editing*, which is where it hurt. It did
not remove it for the popup. Two surfaces still exist; there is just no longer a second copy
of the thing with 700 lines of behaviour in it.

### Layout rules that were bugs first
Each of these fixed something visible, so they read as arbitrary until you know what they
replaced:

- **`.btn { flex: 0 0 auto; white-space: nowrap }`.** A button never shrinks as a flex item.
  Every row that holds buttons wraps instead — `.modal .row`, `.rowtools`, `.acts`, `.ed-top`,
  `.cta-row`, `.dl`, `.wl`. Shrinking is what broke "Copy link" onto two lines inside its own
  button in the share dialog, and squashed the step toolbar's icon buttons from 27px to 21px.
- **`.btn { line-height: 1.2 }`.** A `<button>` takes `line-height: normal` from the UA; an
  `<a class="btn">` inherits the body's 1.65. Same class, 41px versus 48px.
- **The modal overlay is flex + `margin: auto`, not grid + `place-items: center`, and it
  scrolls.** A grid item taller than its area is centred and then clipped at *both* ends with
  nowhere to scroll — the share dialog's buttons were unreachable on a 420px-tall viewport.
  `.modal`'s 540px max-width is sized to its widest action row (five buttons + spacer = 481px);
  below 460px that row stacks `column-reverse` so the primary action is at the top.
- **A dropdown can't be kept on screen by CSS while it's anchored to its button.** `right: 0`
  put the editor's 262px export menu at x=-104 at 320px wide; the viewer's old `right: -60px`
  workaround just traded which edge it left. Below 560px `.menu` becomes `position: fixed`
  pinned to the viewport, which no button position can push out of view.
- **`body.modal-open { overflow: hidden }`** plus `scrollbar-gutter: stable` on `html` — the
  gutter is what stops the page jumping sideways as a dialog opens.
- **Form controls go to 16px below 560px.** iOS Safari zooms the page in on focusing anything
  smaller and does not zoom back out.
- **`@media (pointer: coarse)` enlarges the small controls, and un-hides the drag grip.**
  `.step .grip` is `opacity: 0` until `:hover`, which on a touch screen is never — the reorder
  handle was invisible there. Key this on the pointer, not the width: a narrow window on a
  desktop still has a mouse.
- **Redaction uses pointer events with `setPointerCapture`, not mouse events on `window`.**
  Two reasons, both real: `mousedown`/`mousemove` aren't synthesized for touch drags, so
  redaction did nothing at all on a touch device; and the old release handler lived on `window`
  with nothing removing it, so every re-render of the editor added one more, each holding a
  stale canvas.

Icons are inline SVG built in `web/assets/app.js` (`ICON` + `svg()`); no icon font, no image
files. The step number sits above the drag grip in `.gutter` so it lines up with the first line
of step text — the grip is `opacity: 0` until hover but still occupies its box.

## Dialogs (app.js + viewer.js)
Both surfaces share one contract, and the details are there because their absence was
noticeable:

- **`openModal()` / `closeModal()` own focus.** Focus goes into the dialog, Tab is trapped
  inside it, and closing returns focus to whatever opened it. Untrapped, Tab walked straight
  out into the page behind — which matters most on the viewer, where a reader is typing a
  password into that dialog to export a guide.
- **`confirmModal` focuses Cancel, not the confirm.** The destructive button had focus, so
  Enter or Space on a dialog nobody had finished reading deleted the guide.
- **`confirmModal(…, { info: true })` — `infoModal()` — renders one neutral button.** Several
  call sites are purely explanatory ("Video needs the original recording"); an explanation
  offering Cancel next to a red OK reads as a choice with consequences.
- **Destructive actions confirm.** Unpublish revokes a link other people hold *and* deletes the
  images behind it; deleting a step is irreversible and its icon sits between Move up and Move
  down. Both were one click with nothing in between.
- **Editing a step repaints that step, not the guide.** `refreshStep(i)` — `renderEditor()`
  rebuilds every card, so committing one redaction redrew every canvas and the page height
  collapsed and re-expanded under the scroll position. Redaction mode also lives in the
  module-level `redacting` map rather than on the DOM, because the full re-render dropped it:
  hiding three fields on one screenshot meant pressing Redact three times.

## What counts as a step (recorder.js)
Five listeners, and three of them exist because a request went missing.

- **`pointerdown`** → a `click` step. Capture phase, attributed to the enclosing control.
- **`input`, debounced 650ms** → an `input` step. `change` only fires on **blur**, and a search
  box is the case that breaks: you type, the page fires a request per keystroke, you read the
  results and click one — never blurring the field. So there was no step for the typing, and
  since `attachNetwork` hangs a request on the step it followed, **the search requests were
  dropped**. The most interesting call on the page was the one the log was missing.
  Two details are load-bearing: the step is **stamped with the first keystroke of the burst**,
  not the settle, or it sits after its own consequences and they attach to the previous step;
  and `flushTyping` must **not** touch `lastCaptureTs`, which is the 250ms double-click guard —
  setting it there swallowed the click that came straight after a search.
- **`change`** → still the only event for a select, a checkbox and a date picker. Dedupes
  against `lastTyped`, or blurring after typing writes the step twice.
- **`scroll`, debounced, capture phase, passive** → a `scroll` step. Not much of an instruction
  on its own, but an infinite list loads its next page on scroll and those requests belonged to
  nothing either. Stingy on purpose: one per settle, only past half a viewport, `SCROLL_GAP_MS`
  between them, and never during a typing burst. **Capture phase matters** — a scrollable panel
  inside the page doesn't bubble, and on an admin dashboard that panel is where the list is.
- **`keydown`** → a `key` step for Enter in a field, **Escape** (how dialogs and searches get
  dismissed — and a page that reloads its list on cancel had those requests orphaned), and
  **modifier shortcuts** (⌘K, ⌘S: often *the* action on a keyboard-driven app). A bare
  modifier, plain typing and arrow keys are not steps. A shortcut is usually pressed with
  nothing focused, so it carries no `rect` — the body's rect would ring the whole screenshot.
  **Its `flushTyping()` goes *after* the key is known to be one of those three, never at the
  top of the handler.** Every character of a typing burst is a `keydown` too, so flushing
  first ended the burst on the next keystroke and the 650ms debounce never settled — typing
  "Demo" shipped four steps, `Type "D"` … `Type "Demo"`, one per letter (guide `M3BNbgfE7yYrtv6uf5Ay`).
  A flush still has to happen there, or "Press Enter" would be persisted before the typing it
  submitted.

`guessTitle`'s SKIP list covers `scroll` and `key` as well as `note`/`switch`/`nav`: a key name
is not what a guide is about.

## Step wording (recorder.js)
Conventions, chosen to match how a person writes instructions:

```
Click "Rider Management"                      buttons, links, rows, tabs
Click the "Search by name" field              fields, where clicking != acting
Type "Demo" in the "Search by name" field     text entry
Select "Chandigarh" from the "City" dropdown  selects
Check / Uncheck "Send me updates"             checkboxes
Type your password in the "Password" field    never the actual value
Press Enter                                   submits
Switch to the "My Drive" tab                  another tab came to the front
Go to canva.com/design/DAGxyz/edit            a page finished loading
```

No "element", no "the ... element", no restating a role the label already states. Two details that
matter: `actionableTarget()` attributes a click to the enclosing control rather than the inner
`<span>` that was hit, and `describeClick(el, raw)` falls back to the *clicked* text when the
control's own label is a compound blob — a clickable card yielded
`Click "Child Id : 12364Restaurant DemoIT PARK, Chandig…"` before that fallback existed.

`onKeyDown` records Enter in fields as its own `key` step; without it a guide jumps from "type"
straight to the results with nothing explaining what happened.

## The bridge (background.js + web/assets/bridge.js)
A page on `guide-gen.vercel.app` cannot read `chrome.storage.local` — different origin,
different sandbox. `externally_connectable` is the only link: the dashboard calls
`chrome.runtime.sendMessage(EXTENSION_ID, …)` and `onMessageExternal` answers. Extension id
`dijeonandicniffeffbcolhfldommhnp`, assigned by the store and permanent.

Four rules:

1. **Step images come one at a time**, via `gg_step_image`, as cards scroll into view. Never
   put a whole guide's screenshots in one response — even width-capped WebP, a 40-step guide
   is several megabytes, and that is how you find the message-size ceiling in production
   rather than here. `gg_guide` strips `screenshot` and returns `hasImage` instead.
2. **Every write is validated as if a stranger sent it**, because a web page did. Reorders
   must be a permutation of the steps that already exist; redaction rects must be finite and
   positive. Bridge calls are serialized on `bridgeChain` for the same reason step writes
   are — several handlers read-modify-write `fs_index`.
3. **Any script on that origin can read and edit every local guide.** That is inherent to
   hosting the editor there, not an extra hole — and it is why the match is one exact origin
   and never a wildcard.
4. **Narrated video uses a port, not a message.** `onConnectExternal`, port name `gg_task`.
   Progress has to stream over a render that can take minutes, and an open port is what
   stops Chrome shutting the service worker down halfway through.

`gg_buf_sessions` / `gg_buf_promote` / `gg_buf_discard` are how the library lists and redeems
catch-up captures. **Metadata only** — a session is not a guide, so no steps and no screenshots
cross the bridge; anything the user wants to *see* has to be promoted first. `minutes` is clamped
worker-side, because a web page is on the other end.

`gg_session` hands the popup's session to the dashboard, which adopts it only if it has none
of its own. Signing in twice for one product is not a feature.

## Google sign-in (gg.js + sync.js + web/auth.html)
Offered on all three surfaces. Four things not to undo:

1. **No Google Identity Services.** `gg.js`'s own header rule is that the site loads nothing
   from an external host, and GIS is a remote script. So it's a plain OAuth redirect →
   `id_token` → Identity Toolkit `signInWithIdp`. Costs one page load; keeps the rule.
2. **One OAuth *Web application* client, two redirect URIs** — `/auth` for the site and
   `https://dijeonandicniffeffbcolhfldommhnp.chromiumapp.org/` for the popup. Two rather than
   one per install *only* because `manifest.json` pins the id with `key`
   (`tools/set-extension-key.mjs`). Remove that and an unpacked build's id comes from the
   folder path, differs per machine, and Google sign-in silently fails for every tester while
   working for you. `chrome.identity.getRedirectURL()` always reports the running build's.
3. **`state` and `nonce` both get checked.** `state` proves the response answers a request
   this tab made; `nonce` proves the token isn't a replay. Both live in `sessionStorage`, so
   they die with the tab. `jwtPayload()` does not verify the signature and isn't trying to —
   Firebase does that on exchange.
4. **`GOOGLE_CLIENT_ID` unset ⇒ every Google button hidden**, on all three surfaces. A
   visible button that always fails is worse than no button. Same reasoning as the Drive link
   on `/install`.

`web/auth.html` exists so there is one redirect URI to register rather than one per page.
Where the user was going is carried in `sessionStorage`, not the URL, and the token fragment
is `replaceState`d out of history as soon as it's spent. The viewer adds `?export=<kind>` to
its return path so a reader lands back on the guide with the export they asked for already
running, rather than having to find the menu again.

**Full name** is captured on password signup only — Google supplies it in the token, so asking
twice would be asking for something we already have. Stored as the Firebase Auth `displayName`,
not in Firestore; `users/{uid}` still has rules and still nothing writes it.

**The export log deliberately does not store the name.** `email` can be checked against
`request.auth.token.email` in the rules; a name cannot be checked reliably (the claim is absent
until a token is minted after `displayName` is set). An unverifiable name in an audit log a
guide owner reads is worse than no name.

## Publishing (web/assets/publish.js)
Opt-in, per guide, and the extension stays the source of truth for the *pixels*. This moved
out of `sync.js` when the dashboard became the editor — one implementation of these rules,
not two. If you touch it:

1. **Only the guide the user pressed Publish on is uploaded.** Never batch, never
   background-sync. The privacy claim on the site and in the store listing depends on this,
   and so does the Cloudinary bill.
2. **Bake annotations in before upload.** `stepImage()` runs `FSRender.renderStep`, crops with
   `focusRegion` at `ASPECT` 1.6, caps width at 1600 and encodes WebP q0.85. The viewer is then
   a plain `<img>` — no canvas on the web side, and a published image can't drift from what the
   editor showed.
3. **Never use Cloudinary delivery transformations.** They bill 1 credit per 1,000 derived
   images and would eat the 25-credit monthly allowance. We upload pre-optimised WebP and serve
   the original. Measured: ~17KB per step image versus ~200-400KB for the PNG equivalent.
4. **Always send the `uid_` and `guide_` tags.** They're the only way to find and delete one
   user's images later via the Admin API, which is what makes a deletion request answerable.
5. **`Overwrite: false` on the Cloudinary preset is load-bearing.** A caller can choose their
   own `public_id`; with overwrite off that's harmless. Turn it on and someone who learns an
   image id could replace it on a user's shared page.

6. **Re-publishing PATCHes the existing document.** `republish()` — this is what stops a
   shared link going stale. The order is not interchangeable: upload the new images under a
   **new** tag (rule 5 forbids overwriting), PATCH the document to point at them, and only
   *then* purge the old tag. Purge first and a failed PATCH leaves a live document pointing
   at deleted images; don't purge at all and a republish meant to *remove* something
   sensitive leaves the old image publicly retrievable. Every tag a guide has used stays on
   `assetTags` until confirmed gone, so a failed purge is still caught at delete time.

`remoteId` is stored on the `fs_index` entry, written back over the bridge after a publish.
That is how the editor knows to offer Update and Unpublish instead of minting a second
document — and a second link — on every press.

## The published guide page (viewer.js + g.html)
The only surface a stranger meets, so it is a growth surface as much as a document.
Everything here came out of reading a competitor's shared guide beside ours.

- **`.viewer` is 1040px wide and states its own horizontal padding.** Not `.narrow`
  (720px): that is a reading column and this is an image-first document — a 1600px
  capture rendered into 672px made the small UI text, the thing the reader came for,
  unreadable. The padding is stated because `padding: 34px 0 90px` is a *shorthand*
  and silently overrode `.wrap`'s `0 22px`, so on a phone every title, step and
  screenshot ran into the edge of the display.
- **The header block answers "should I trust this, and where do I start".**
  `ownerName`, `durationMs`, `app`, `description` and `startUrl` are all written by
  `headerFields()` in `publish.js` — one builder, used by publish *and* republish, so
  the two can never describe the same guide differently. Two rules inside it: the
  owner's **name** travels and their **email never does**, and `durationMs` is the
  length of the recording, which is why the page says "recorded in" and not "takes".
- **`startUrl` is not step 1.** It renders as a `Start here` link above the steps,
  outside the numbering, so step numbers still match the editor, the PDF and the
  handoff. It was already being read by the AI handoff (`guide.startUrl`) before it
  was ever published — the export just quietly lost it.
- **The lightbox is not the modal.** The modal is a dialog contract (focus trap,
  confirm/cancel); this is a picture. It sits at `z-index: 200` and is **opaque**:
  at 0.92 alpha the sticky header's `backdrop-filter` kept compositing through it, so
  the wordmark and buttons floated on top of the screenshot. Pan is pointer events
  with capture — mouse events aren't synthesized for touch drags, and a phone is
  exactly where zoom matters.
- **The header's mobile rule is the viewer's own.** `site.css`'s 560px rule pins the
  wordmark to row one and the nav to row two, which is right for the dashboard's five
  nav links and wrong for three icon buttons — it dropped Print onto a second row on
  every phone. The `.vrow` override is written to out-specify it (`header.site
  .row.vrow nav`, not `.vrow nav`), because the generic rule is later in the file.
- **The promo bar is dismissible and late.** It appears past 20% scrolled and stores
  the dismissal in `sessionStorage`. An advert you can't remove from someone else's
  document is a different product.
- **No new Firestore rules were needed.** `firestore.rules` validates `title`,
  `steps`, `ownerUid` and `visibility` and does not whitelist guide keys — unlike the
  export log, where a new field *does* need a rules publish.

## Exports from a public guide (viewer.js)
The owner can switch on `allowExport`, and a signed-in reader then builds the guide as a
document on their own machine. Four things govern it:

1. **`step.baked` is the whole trick.** A published image is already annotated and cropped at
   1.6. `focusRegion` short-circuits to the full frame when `baked` is set, and the video
   skips `pushIn`. Without it PPTX asks for a 2.0 crop of a 1.6 image and slices the number
   badge off every slide — which it *was doing* for published guides before this landed, on
   the dashboard as well as the viewer. Any new consumer of a published image must set it.
2. **The switch is not an access control, and must never be described as one.** The step
   images are already public URLs; print, right-click-save and screenshot all work whether
   exports are on or off. It governs whether a button appears. The privacy policy says so in
   a callout, and the switch's own label says so.
3. **The log is the only place a non-owner writes to the database.** The rules check `uid` and
   `email` against the caller's *token* — a client-supplied email would let a recipient log an
   export as anyone they liked, which is worse than having no log. There is deliberately no
   client timestamp: the time is the document's `createTime`. Don't add an `at` field.
4. **Logging is best-effort and must never fail an export.** The file is already on the
   reader's disk by the time we try to record it. `record()` swallows errors for exactly this
   reason — and it's what makes the feature degrade sanely if the rules aren't published yet.

Narrated video is the one format the page can't build, so the page hands the baked images to
the extension over the `gg_task` port (`steps`, not `guideId` — the recipient's extension has
never seen the guide). That's affordable *because* published images are ~17KB each; a 40-step
guide is about a megabyte. `pushedSteps()` in background.js clamps it, because a web page is
on the other end.

## Link previews (web/api/og.js + vercel.json + tools/make-og.mjs)
A shared `/g/{id}` link is the product's only viral surface: someone pastes it into a work
channel and everyone there sees the unfurl. Statically that unfurl read *"A GuideGen guide"* for
every guide ever shared, which gives a reader no reason to click and says nothing about the tool.
Four decisions hold this up:

1. **Preview bots are routed to the function; humans are not.** `vercel.json` rewrites `/g/:id`
   to `/api/og` only when the user-agent matches the bot list, and falls through to the static
   shell otherwise. So if the function throws, times out, or Firestore is down, the cost is a
   generic preview — never a guide that won't open. The blast radius of the viral feature must
   not include the thing it advertises. `tools/og-test.mjs` asserts all four failure modes
   return 200 with the generic preview.
2. **The image is committed, static, and drawn from nothing.** A bot fetches within a second of
   the message being sent and will not wait for a cold function — and a per-guide image would
   mean rendering *the user's screenshots* into something a third party caches forever.
   `og-guide.png` is a mock built in CSS, so a shared guide's contents never reach WhatsApp's or
   Slack's preview cache. Only the title does, which is the one field the sender chose.
3. **The read is unauthenticated on purpose.** The Firestore rules answer it: a document is
   readable only once `visibility == 'link'`. An unpublished or guessed id therefore gets the
   generic preview rather than a leak, and `og.js` checks `visibility` itself as well.
4. **Titles are escaped, and `noindex` stays.** An og:title is an attribute, so an unescaped
   quote in a guide name is an injection. Preview bots ignore `noindex` (which is why previews
   work at all) and search crawlers honour it — a shared internal SOP's title has no business in
   a search index.

The share dialog says all of this in one line, because a preview showing the title to a whole
channel is a surprise otherwise.

## Post-processing on stop
`background.js → finalizeGuide()` runs once when recording stops, before the editor opens:

- **`mergeRedundant()`** drops a click that only focused a field when the very next step types
  into that same field (matched on `rect` within 4px + same `url`). The typing step is kept —
  its screenshot shows the entered value. Deliberately narrow; it will not merge across
  different elements or a click followed by another click.
- **`dropCausedNavs()`** drops a `nav` step that only restates where the click before it
  already went — `Click "Rider Management"` followed by `Go to …/rider-management` is one
  thing written down twice, and it was four of thirteen steps on a real recording. Three
  guards, all tested: **same tab only** (a click that opens a new tab produces the *only*
  record of that tab in its nav step, since a blank new tab's switch step is rejected),
  **only after an action** (a nav after a nav or a scroll is not explained by it), and
  **never the last step** (a click's screenshot is the page it was clicked on; the result
  shows up in the next step's picture, and when there is no next step the nav is the
  outcome). `NAV_CAUSED_MS` is 12s.
- **`guessTitle()`** replaces the `Untitled guide — <timestamp>` placeholder with
  "How to view &lt;label&gt; in &lt;App&gt;". It scans **backwards** for the last label passing
  `looksLikeName()`, because flows end on incidental clicks — taking the literal last step once
  produced *"How to view 28 in uEngage Dashboard"* off a date cell. `looksLikeName()` rejects
  numbers, dates, times, ids and generic buttons (OK/Save/Next). `appName()` prefers `pageTitle`
  over the hostname (page titles carry the vendor's casing — "uEngage", which no hostname gives
  you) and strips a generic tail, so "uEngage Dashboard" yields "uEngage". Returns null when
  nothing qualifies, leaving the placeholder. Only ever overwrites the placeholder, so a
  user-edited title is safe.

Both are heuristics on generated text. If `recorder.js`'s phrasing changes, re-check
`stepLabel()`'s regex.

## Known issues / backlog (do NOT fix unless asked)
- `requestAnimationFrame` is **suspended**, not merely throttled, in a hidden page — the video
  used to freeze on one slide for its whole length. The `setInterval(draw, opts.tickMs || 100)`
  alongside the rAF loop is what keeps it advancing, and in the offscreen renderer it is the
  only clock (see Narration). No longer a user-facing caveat: nobody has to keep a tab focused.
- First narrated export pays a one-time cost to load the 60MB voice model into an ONNX session.
- Web pages only — no native desktop capture (would need an Electron/native companion).
- **Unpublished guides are device-local.** They live in that browser's extension storage, so
  they can't be opened elsewhere. A direct consequence of not uploading until Publish — the
  design working, not a bug. Say so to users rather than letting them discover it.
- **A published guide's images can't be re-annotated from another device.** Redaction is
  additive on a baked image; moving the ring or re-cropping needs a re-publish from the machine
  that holds the original. Which is also why no unredacted original is ever uploaded.
- **Catch-up capture is empty the first time you want it on a new site**, because arming is
  manual and per-origin (see Catch-up capture for why that default stands). The intended fix is
  *offering* to arm after a deliberate recording on that site — the moment the intent is proven —
  not arming by default and not a settings page. Not built.
- No team workspaces (out of scope by design).

## Style
Keep code readable and dependency-free. Match existing patterns: promise-like wrappers around
`chrome.storage`, small pure helpers, and globals for cross-file sharing rather than modules —
`window.FS*` in the extension, `window.GG*` on the website. When adding an exporter, reuse
`FSRender.renderStep` for annotation so all outputs stay visually consistent.

The website's own files (`gg.js`, `bridge.js`, `publish.js`, `app.js`) are written in the
older idiom — `var`, `function`, promise chains, no arrows — because `gg.js` was, and a file
set that switches register halfway is harder to read than one that picks a style and holds it.
There is no technical reason: `render.js` and `exporters.js` are shared verbatim with the
extension and use modern syntax on both surfaces. Match whichever file you're in.
