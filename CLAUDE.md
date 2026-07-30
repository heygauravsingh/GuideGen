# CLAUDE.md — GuideGen

Project context for Claude Code. Read this first before making changes.

## What this is
GuideGen is a **self-hosted, local replica of Scribe Capture**, built as a Chrome
Manifest V3 extension plus a static website. You record a browser workflow; it
auto-generates a step-by-step guide (one annotated screenshot per click) and exports to
HTML, Markdown, PDF, PowerPoint, and a narrated video.

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
| `manifest.json` | MV3 config, v1.1.0. Permissions: activeTab, scripting, storage, unlimitedStorage, tabs, downloads, offscreen; host `<all_urls>`; `externally_connectable` names `https://guide-gen.vercel.app/*` and nothing else. CSP adds `'wasm-unsafe-eval'` for the TTS engine. |
| `background.js` | Service worker. Owns recording state, `captureVisibleTab` screenshots (serialized via a throttled queue), their re-encode to width-capped WebP (see Screenshot normalisation), and all persistence. Message router (`fs_start`, `fs_stop`, `fs_capture_step`, `fs_get_state`, `fs_open_editor`). On stop, `finalizeGuide()` merges redundant steps and names the guide (see Post-processing). |
| `recorder.js` | Content script. Listens (capture phase) for `pointerdown` + `change` + `keydown` (Enter), builds a human-readable step description from the DOM element (see Step wording), hides its own pill before each capture, shows the floating "Recording" pill. |
| `recorder.css` | Styles for the recording pill only. Every declaration is `!important` and children start from `all: unset` — this is the one surface that renders inside a stranger's page. |
| `popup.html/js` | Toolbar popup: status card (idle / recording with live step count) + Start/Stop and Guide library. Self-contained styles, light + dark. |
| `editor.html` + `redirect.js` | Retired. A redirect to `/app`, carrying `#<guideId>` across as `#local-<guideId>`, so v1.0 bookmarks land somewhere sensible. The editor is `web/assets/app.js`. |
| `offscreen.html/js` | Never-visible page that renders the narrated video. A service worker has no canvas, AudioContext or MediaRecorder; an offscreen document has all three. Only `chrome.runtime` is available to it, so the guide arrives by message and the finished blob leaves as a `blob:` URL for the worker to download. |
| `render.js` | `window.FSRender`. Draws annotations onto a canvas: scrim + spotlight, accent ring, numbered badge, and redaction via pixelation (see Annotations). Pure canvas, reused by editor preview AND every exporter. Also `focusRegion()`/`contentBox()` — pick the crop worth showing (see Presentation). |
| `exporters.js` | `window.FSExport`: `.html`, `.markdown`, `.pdf` (jsPDF), `.pptx` (PptxGenJS), `.video` (canvas → MediaRecorder webm + optional narration). Also owns `PACES`/`stepSecs` — the single source of truth for pacing, which the editor's dropdown is built from. |
| `tts.js` | `window.FSTTS`. Offline neural narration: espeak-ng (wasm) → phoneme ids → Piper VITS via onnxruntime-web → mono PCM. `synth(text, {rate})` → `{pcm, sampleRate, duration}`. Loads `lib/ort` + `lib/piper` + `lib/voices` lazily on first use. |
| `sync.js` | `window.FSSync`. **Auth only** — Identity Toolkit REST for email/password, tokens in `chrome.storage.local`. Publishing used to live here and now lives in `web/assets/publish.js`, so there is one implementation of the upload rules rather than two. The popup gates on this session, and the dashboard adopts the same one over the bridge (`gg_session`) so nobody signs in twice. |
| `tools/sync-web-assets.mjs` | Mirrors `render.js`, `exporters.js` and the two vendored exporter libs into `web/assets/`. `--check` fails if a mirror is stale. |
| `web/app.html` + `web/assets/app.js` | **The editor.** Guide library and step editor for both local guides (over the bridge) and published ones (over Firestore). |
| `web/assets/bridge.js` | `window.GGBridge`. The page side of `externally_connectable`. |
| `web/assets/publish.js` | `window.GGPublish`. `publish()` creates a guide document; `republish()` updates one **in place** so a shared link never goes stale. |
| `web/assets/gg.js` | `window.GG`. Firebase auth + Firestore over REST for the website. |
| `web/api/delete-assets.js` | The only server-side code. Deletes Cloudinary images, which needs the API secret. Two modes: delete a guide and its images, or purge one superseded asset tag. |
| `lib/jspdf.umd.min.js` | jsPDF 2.5.1. Global: `window.jspdf.jsPDF`. |
| `lib/pptxgen.bundle.js` | PptxGenJS 3.12.0. Global: `window.PptxGenJS`. |
| `lib/ort/` | onnxruntime-web 1.18.0, wasm backend only (`ort.wasm.min.js` + `ort-wasm-simd.wasm`). Global: `window.ort`. |
| `lib/piper/` | piper_phonemize wasm build (espeak-ng). Global: `window.createPiperPhonemize`. The 17MB `.data` is the espeak-ng dictionary. |
| `lib/voices/` | Piper voice `en_US-hfc_female-medium` (60MB `.onnx` + its `.json` config, 22.05kHz). |
| `icons/` | Generated PNG icons. |

## Data model (chrome.storage.local)
- `fs_state` → `{ recording, guideId, stepCount }`
- `fs_index` → array of `{ id, title, createdAt, startUrl, stepCount, remoteId?, publishedAt? }` (newest first)
- `gg_auth` → the account session `{ uid, email, idToken, refreshToken, expiresAt }`
- `fs_steporder_<guideId>` → array of step ids (defines order)
- `fs_step_<stepId>` → one step object

Step object:
```
{
  id, guideId, seq, type: "click" | "input" | "key" | "note",
  url, pageTitle, timestamp,
  dpr,                     // bitmap px per CSS px for this step's screenshot
  point: { x, y },         // click point, CSS px within viewport
  rect:  { x, y, w, h },   // target element bounds, CSS px within viewport
  text,                    // editable description
  screenshot,              // WebP dataURL of visible viewport, or null for notes
  blurs: [ { x, y, w, h } ] // redaction rects, CSS px
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
  flattened to the resolved value, so it keeps following the OS.
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

Icons are inline SVG built in `web/assets/app.js` (`ICON` + `svg()`); no icon font, no image
files. The step number sits above the drag grip in `.gutter` so it lines up with the first line
of step text — the grip is `opacity: 0` until hover but still occupies its box.

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
`pifkelcohogbbocldnkjlfiagjigikjl`, assigned by the store and permanent.

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

`gg_session` hands the popup's session to the dashboard, which adopts it only if it has none
of its own. Signing in twice for one product is not a feature.

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

## Post-processing on stop
`background.js → finalizeGuide()` runs once when recording stops, before the editor opens:

- **`mergeRedundant()`** drops a click that only focused a field when the very next step types
  into that same field (matched on `rect` within 4px + same `url`). The typing step is kept —
  its screenshot shows the entered value. Deliberately narrow; it will not merge across
  different elements or a click followed by another click.
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
