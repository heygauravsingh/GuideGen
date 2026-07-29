# Chrome Web Store listing — copy/paste sheet

Everything below is ready to paste into the Developer Dashboard. Nothing here needs
editing except the two `<<< >>>` placeholders.

---

## Store listing tab

**Item name** (max 75 chars)

```
FlowScribe — Step-by-step guide capture
```

**Short description** (max 132 chars — this is 131, do not add to it)

```
Record a workflow and auto-generate an annotated step-by-step guide. Export to HTML, Markdown, PDF, PowerPoint, and narrated video.
```

**Category:** Productivity → Workflow & Planning (pick Productivity if the
sub-category isn't offered)

**Language:** English (United States)

**Detailed description**

```
Document any process by simply doing it.

Turn on FlowScribe, click through the workflow you want to explain, and press stop.
You get a finished step-by-step guide: one annotated screenshot per click, with the
target highlighted and numbered, and a written instruction for every step — "Click
Rider Management", "Type Demo in the Search field", "Press Enter".

Then edit anything you like and export it.

WHAT YOU GET
• Automatic step text — written from the actual control you clicked, not a generic label
• An annotated screenshot per step, highlighted, numbered and cropped to what matters
• An auto-generated title, so guides aren't called "Untitled"
• Redaction — drag a box over anything sensitive and it's pixelated in every export
• Notes — add context steps that aren't clicks
• Reorder, rewrite or delete any step

EXPORT TO
• Web page (.html) — one self-contained file
• Markdown (.md) — images embedded
• PDF — title page plus paginated steps
• PowerPoint (.pptx) — one slide per step
• Narrated video (.webm) — 1080p, with a spoken voiceover

EVERYTHING STAYS ON YOUR MACHINE
FlowScribe has no account, no server and no cloud. Your screenshots are stored locally
in the browser and never uploaded, because there is nowhere for them to be uploaded to.

Even the narration is local: the voice is synthesized on your own machine by a bundled
neural speech engine, so the text of your internal processes is never sent to a
text-to-speech service. That is unusual — most tools in this category upload both your
screenshots and your script.

This makes FlowScribe usable in places cloud tools can't go: regulated industries,
customer data, internal admin panels, anything under an NDA.

GOOD TO KNOW
• Works on web pages in Chrome and other Chromium browsers (Edge, Brave, Arc)
• Cannot capture native desktop apps — browser only
• The first narrated video takes a moment longer while the voice model loads
• Keep the editor tab in focus while a video renders
• If a tab was already open when you installed FlowScribe, reload it once before recording

FlowScribe is free while in early access.
```

---

## Privacy practices tab

**Single purpose** (one sentence, they are strict about this)

```
FlowScribe records the user's own browser interactions in order to generate an editable step-by-step guide document that the user can export as a file.
```

**Permission justifications** — paste one per field:

`activeTab`
```
Used to identify the tab the user has chosen to record when they press Start recording, so the recorder is attached to that page and screenshots are taken of it.
```

`scripting`
```
Used to inject the recorder script into the page the user chooses to document, so that clicks and form entries in that page can be turned into guide steps.
```

`storage`
```
Used to store the user's guides — step text, screenshots and settings — locally in chrome.storage.local. This is the only place guide data exists; nothing is transmitted.
```

`unlimitedStorage`
```
Screenshots are stored as full-resolution images and a single guide can exceed the default storage quota. This permission prevents guides from being silently truncated.
```

`tabs`
```
Used to read the URL and title of the tab being recorded, so each step records where it happened and the guide can be given a meaningful title, and to open the guide editor page when recording stops.
```

`downloads`
```
Used to save the exported guide — HTML, Markdown, PDF, PowerPoint or video — to the user's computer when they choose an export format.
```

**Host permission** `<all_urls>`
```
FlowScribe documents whatever web application the user chooses, which cannot be known in advance — it may be any internal admin panel, SaaS dashboard or intranet site. The content script must therefore be able to run on any URL the user decides to record. It is inert unless the user has explicitly started a recording, and it reads only the label and position of the element clicked. No page content is transmitted anywhere.
```

**Data usage — certify all three:**
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Data collection disclosure:** leave every category **unchecked**. FlowScribe
collects nothing — no analytics, no telemetry, no network requests at all. This is
true and verifiable from the source; do not check a box "just in case".

**Privacy policy URL**

```
<<< paste your published privacy-policy URL here — see store/privacy-policy.html >>>
```

---

## Distribution tab

- **Visibility:** start with **Unlisted** (see step 6 in the launch runbook)
- **Pricing:** Free
- **Regions:** All regions

---

## Screenshots (required — at least 1, up to 5)

Exact size **1280×800** or **640×400** PNG/JPEG. Suggested set, in order:

1. The editor with a real recorded guide open — steps visible with screenshots
2. The export menu open, showing all five formats
3. The narrated-video dialog with the pace control
4. A step mid-redaction, showing the drag-to-hide overlay
5. The recording pill on a real page

Take them at any size, then run `store/make-screenshots.sh` to convert to exact
store dimensions.
