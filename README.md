# FlowScribe

A self-hosted, no-subscription replica of Scribe Capture. Record a workflow in your browser and FlowScribe auto-generates a step-by-step guide — an annotated screenshot for every click, with editable step text — then exports it to HTML, Markdown, PDF, PowerPoint, or a narrated video.

Everything runs locally in your browser. No account, no server, no data leaves your machine.

## Install (Load unpacked)

1. Open Chrome (or any Chromium browser: Edge, Brave, Arc).
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select this `FlowScribe` folder.
5. Pin the FlowScribe icon from the puzzle-piece menu.

## Record a guide

1. Open the page/app you want to document. *(If a tab was already open before you installed FlowScribe, reload it once.)*
2. Click the FlowScribe icon → **Start recording**.
3. Do your workflow normally. Each click and each form entry becomes a step with a screenshot, the clicked element highlighted, and an auto-written description ("Click the ... button", "Type ... into ...").
4. A red **Recording** pill sits in the bottom-right and counts steps. Click **Stop & edit** when finished — the editor opens automatically.

When you stop, FlowScribe tidies the guide up: it names it after what you did (e.g. *How to view Journey Tracking in uEngage* — editable, and only when you haven't titled it yourself), and folds "click the field" + "type into that field" into a single step.

## Edit

- Every step is a card: edit the description inline, reorder with **↑/↓**, or **Delete** it.
- **Redact:** click *Redact* on a step, then drag a box over anything sensitive (passwords, emails, account numbers). The region is pixelated in every export. Password fields are auto-masked at capture time.
- **+ Note:** add a text-only step for context or instructions.
- The title (top bar) and all edits save automatically. Guides persist across browser restarts.

## Export

Open the **Export ▾** menu:

Every format crops each screenshot toward the thing you clicked, so the UI is readable instead of lost in the browser window's empty margins.

| Format | Notes |
|---|---|
| **Web page (.html)** | Single self-contained file, images embedded. |
| **Markdown (.md)** | Images embedded as data URIs. |
| **PDF (.pdf)** | Title page + paginated steps. |
| **PowerPoint (.pptx)** | Title slide + one slide per step. |
| **Narrated video (.webm)** | Slideshow of your steps, narrated by a built-in offline voice. |

### About the narrated video
The video is rendered on a canvas and captured to `.webm`. With narration on, FlowScribe synthesizes the speech itself — a neural voice (Piper) bundled in `lib/` and run in your browser — then mixes it into the recording. Nothing is uploaded and no voice service is called.

**Pace** — Very fast through Very slow — sets how quickly the voice reads. There's no seconds-per-step setting: each step stays on screen as long as its own text takes to say, so short steps go by quickly and wordy ones get room. The dialog shows the estimated video length as you change pace.

Video is 1080p. Like the other exports, each slide zooms toward the thing you clicked rather than showing the whole browser window — a full desktop viewport is mostly empty margin, and fitting all of it on screen shrinks the actual UI until the text can't be read.

The first narrated export takes a little longer while the voice model loads. Keep the editor tab focused while the video renders: Chrome suspends background tabs, and while FlowScribe keeps the slides advancing anyway, the picture gets choppy. If the voice files are missing from `lib/`, FlowScribe falls back to a **silent captioned** video (every step still shows its text on screen).

## How it works (for tinkering)

- `manifest.json` — MV3 config and permissions.
- `background.js` — recording state, `captureVisibleTab` screenshots, storage.
- `recorder.js` / `recorder.css` — content script: listens for clicks/inputs, builds step descriptions, shows the recording pill.
- `render.js` — draws annotations (highlight box, numbered marker, click ripple, redaction pixelation) onto a canvas.
- `editor.html` / `editor.js` / `editor.css` — the guide library + step editor.
- `exporters.js` — HTML / Markdown / PDF / PPTX / video generators.
- `tts.js` — offline speech synthesis for the narrated video.
- `lib/` — bundled [jsPDF](https://github.com/parallax/jsPDF) (PDF), [PptxGenJS](https://github.com/gitbrent/PptxGenJS) (PowerPoint), and the narration engine: [onnxruntime-web](https://github.com/microsoft/onnxruntime), [piper-phonemize](https://github.com/rhasspy/piper-phonemize) (espeak-ng), and a [Piper](https://github.com/rhasspy/piper) voice. The voice model and its pronunciation dictionary account for nearly all of the folder's ~90MB.

Data lives in `chrome.storage.local` (unlimited storage). To wipe everything, remove the extension or clear its storage.

## Known limits vs. paid Scribe
- Captures web pages only (browser clicks/inputs), not native desktop apps.
- No cloud sync, sharing links, team workspaces, or the AI workflow-analysis features.
- Screenshots are of the visible viewport at click time.

Built as a personal, local alternative. Bundled libraries retain their own MIT licenses (see `lib/`).
