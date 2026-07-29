# CLAUDE.md — GuideGen

Project context for Claude Code. Read this first before making changes.

## What this is
GuideGen is a **self-hosted, local replica of Scribe Capture**, built as a Chrome
Manifest V3 extension. You record a browser workflow; it auto-generates a step-by-step
guide (one annotated screenshot per click) and exports to HTML, Markdown, PDF, PowerPoint,
and a narrated video. Everything runs client-side. No server, no account, no network calls
except loading the two bundled libraries from disk. Data lives in `chrome.storage.local`.

## Non-negotiables / constraints
- **Manifest V3**, vanilla JS only. No build step, no framework, no bundler — files load
  directly. Keep it that way unless explicitly asked to add tooling.
- No remote code. Libraries are vendored in `lib/` (MV3 forbids remote script loading).
- No `localStorage`/`sessionStorage` for app data — use `chrome.storage.local`
  (the manifest already requests `unlimitedStorage`).
- Keep everything working as "Load unpacked" from this folder.

## How to test a change
1. Edit files here.
2. Go to `chrome://extensions` → click the ↻ (reload) on the GuideGen card.
3. For content-script (`recorder.js`) changes, also **reload the web page** you're recording.
4. Logs: the service worker log is behind the "Inspect views: service worker" link on the
   extension card; editor/popup logs are in their own DevTools.

## File map
| File | Role |
|---|---|
| `manifest.json` | MV3 config. Permissions: activeTab, scripting, storage, unlimitedStorage, tabs, downloads; host `<all_urls>`. CSP adds `'wasm-unsafe-eval'` for the TTS engine. |
| `background.js` | Service worker. Owns recording state, `captureVisibleTab` screenshots (serialized via a throttled queue), and all persistence. Message router (`fs_start`, `fs_stop`, `fs_capture_step`, `fs_get_state`, `fs_open_editor`). On stop, `finalizeGuide()` merges redundant steps and names the guide (see Post-processing). |
| `recorder.js` | Content script. Listens (capture phase) for `pointerdown` + `change` + `keydown` (Enter), builds a human-readable step description from the DOM element (see Step wording), hides its own pill before each capture, shows the floating "Recording" pill. |
| `recorder.css` | Styles for the recording pill only. Every declaration is `!important` and children start from `all: unset` — this is the one surface that renders inside a stranger's page. |
| `popup.html/js` | Toolbar popup: status card (idle / recording with live step count) + Start/Stop and Guide library. Self-contained styles, light + dark. |
| `editor.html/js/css` | Guide library sidebar (with search) + step editor: inline text edit, reorder by buttons or drag handle, delete, drag-to-redact, add note, title edit, export menu, video modal. See UI conventions. |
| `render.js` | `window.FSRender`. Draws annotations onto a canvas: scrim + spotlight, accent ring, numbered badge, and redaction via pixelation (see Annotations). Pure canvas, reused by editor preview AND every exporter. Also `focusRegion()`/`contentBox()` — pick the crop worth showing (see Presentation). |
| `exporters.js` | `window.FSExport`: `.html`, `.markdown`, `.pdf` (jsPDF), `.pptx` (PptxGenJS), `.video` (canvas → MediaRecorder webm + optional narration). Also owns `PACES`/`stepSecs` — the single source of truth for pacing, which the editor's dropdown is built from. |
| `tts.js` | `window.FSTTS`. Offline neural narration: espeak-ng (wasm) → phoneme ids → Piper VITS via onnxruntime-web → mono PCM. `synth(text, {rate})` → `{pcm, sampleRate, duration}`. Loads `lib/ort` + `lib/piper` + `lib/voices` lazily on first use. |
| `lib/jspdf.umd.min.js` | jsPDF 2.5.1. Global: `window.jspdf.jsPDF`. |
| `lib/pptxgen.bundle.js` | PptxGenJS 3.12.0. Global: `window.PptxGenJS`. |
| `lib/ort/` | onnxruntime-web 1.18.0, wasm backend only (`ort.wasm.min.js` + `ort-wasm-simd.wasm`). Global: `window.ort`. |
| `lib/piper/` | piper_phonemize wasm build (espeak-ng). Global: `window.createPiperPhonemize`. The 17MB `.data` is the espeak-ng dictionary. |
| `lib/voices/` | Piper voice `en_US-hfc_female-medium` (60MB `.onnx` + its `.json` config, 22.05kHz). |
| `icons/` | Generated PNG icons. |

## Data model (chrome.storage.local)
- `fs_state` → `{ recording, guideId, stepCount }`
- `fs_index` → array of `{ id, title, createdAt, startUrl, stepCount }` (newest first)
- `fs_steporder_<guideId>` → array of step ids (defines order)
- `fs_step_<stepId>` → one step object

Step object:
```
{
  id, guideId, seq, type: "click" | "input" | "key" | "note",
  url, pageTitle, timestamp,
  dpr,                     // devicePixelRatio at capture
  point: { x, y },         // click point, CSS px within viewport
  rect:  { x, y, w, h },   // target element bounds, CSS px within viewport
  text,                    // editable description
  screenshot,              // PNG dataURL of visible viewport (physical px), or null for notes
  blurs: [ { x, y, w, h } ] // redaction rects, CSS px
}
```
Coordinate rule: screenshots from `captureVisibleTab` are at **physical** pixels, so any
CSS-px value maps onto the bitmap by multiplying by `dpr`. `render.js` relies on this.

## Recording flow
popup Start → `background.startRecording` (creates guide, sets state, injects recorder into
active tab, broadcasts) → `recorder.js` attaches listeners + shows pill → each click/input
sends `fs_capture_step` → background captures the screenshot and appends the step → pill
counter updates via `storage.onChanged` → Stop opens the editor for that guide.

## Narration (video export)
Narration works and is fully offline. Two rules if you touch it:

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
scrim undimmed, a brand-purple ring around it, and the number badge placed **outside** the ring
(flipping side when it would fall off the frame). What this replaced, and why not to go back:
a red box *and* a red ripple *and* a badge sitting on top of the very element it pointed at —
three marks competing, with the target obscured. There is deliberately **no cursor dot**; inside a
text field it landed on the label the reader was trying to read.

## Presentation (video)
Video renders at **1920×1080** and asks MediaRecorder for **12 Mbps**. Both matter: the source
screenshots are retina-sized (~3024px wide) and full of small UI text, and MediaRecorder's
default (~0.8 Mbps at 720p) smears it. Don't lower either without measuring text legibility.

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

Slides are light (#eef1f6), with a 34px-at-720p caption, the number in a brand circle, a
"Step n of m" counter, the screenshot on a white card with a soft shadow, and a progress bar
pinned to the bottom. Slides crossfade (0.4s) and push in slightly (4.5%) toward the highlight —
hard cuts between static slides were the main thing that made this read as a slideshow.

## UI conventions
`editor.css` starts with design tokens (`--brand`, `--ink`, `--panel*`, `--line`, radii, shadows,
two easing durations) and everything else consumes them. Three rules:

- **Both colour schemes, always.** Every token is redefined under
  `@media (prefers-color-scheme: dark)`. Extension pages inherit the OS scheme and a
  light-only panel looks broken at night. Never hard-code a hex outside the token block.
- **Honour `prefers-reduced-motion`.** There's a blanket rule at the bottom of `editor.css`
  killing transitions and animations; keep new motion inside that contract.
- **Never write `font: <size>/<lh> inherit`.** It's invalid shorthand, so it silently fails and
  the element falls back to the UA default — which is *monospace* for `<textarea>`. Every step
  description in the editor rendered as code until this was fixed. Set `font-family: inherit`
  as its own declaration.

**Grow textareas after the card is in the document.** `renderStepCard` is `async` — it
awaits the screenshot decode — so a `requestAnimationFrame(autoGrow)` inside it fires while
the card is still detached, `scrollHeight` reads 0, and the step text collapses to an
invisible zero-height box. `renderMain` calls `autoGrow` after `appendChild`. This only
showed up on the *first* card to decode an image, which made it look intermittent.

Icons are inline SVG built in `editor.js` (`ICON` + `svg()`); no icon font, no image files.
The step number sits above the drag grip in `.gutter` so it lines up with the first line of step
text — the grip is `opacity: 0` until hover but still occupies its box.

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
- `requestAnimationFrame` is **suspended**, not merely throttled, while the tab is hidden — the
  video used to freeze on one slide for its whole length. There's now a `setInterval(draw, 100)`
  alongside the rAF loop so hidden-tab renders still advance (~1fps, choppy but correct).
  Focused is still much better; README says so.
- First narrated export pays a one-time cost to load the 60MB voice model into an ONNX session.
- Web pages only — no native desktop capture (would need an Electron/native companion).
- No cloud sync, sharing links, or team features (out of scope by design).

## Style
Keep code readable and dependency-free. Match existing patterns: promelike wrappers around
`chrome.storage`, small pure helpers, `window.FS*` namespaces for cross-file sharing (no
modules). When adding an exporter, reuse `FSRender.renderStep` for annotation so all outputs
stay visually consistent.
