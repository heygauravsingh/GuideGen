# Chrome Web Store listing — copy/paste sheet

Everything below is ready to paste into the Developer Dashboard as-is. No placeholders
remain — audited 31 Jul 2026.

---

## Store listing tab

**Item name** (max 75 chars)

```
GuideGen — Step-by-step guide capture
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

Turn on GuideGen, click through the workflow you want to explain, and press stop.
You get a finished step-by-step guide: one annotated screenshot per click, with the
target highlighted and numbered, and a written instruction for every step — "Click
Rider Management", "Type Demo in the Search field", "Press Enter".

Then edit anything you like and export it.

WHAT YOU GET
• Automatic step text — written from the actual control you clicked, not a generic label
• An annotated screenshot per step, highlighted, numbered and cropped to what matters
• Tab switches and page loads recorded as their own steps, so a workflow that opens a new
  tab still reads in order instead of jumping — and a page load that only restates the click
  before it is left out
• Typing captured as one step per field, with the screenshot taken once you've stopped
• An auto-generated title, so guides aren't called "Untitled"
• Capture the last 2 minutes — switch it on for a site you document and you can make a guide
  out of work you already did, without having pressed start. Off everywhere until you turn it
  on for a specific site, held on your device only, and deleted after 7 days
• What the page did, not just what you clicked — the requests each step fired and the status
  that came back, and optionally the full exchange as a cURL. Credential values are masked
  before anything is stored. It travels with the AI handoff and with no other export
• Blur sensitive information — drag a box over anything sensitive and it's pixelated in
  every export, permanently
• Add steps of your own between the recorded ones, with a picture if you have one — and
  without one, the text becomes a section slide in your exports
• Reorder, rewrite or delete any step

EXPORT TO
• Web page (.html) — one self-contained file
• Markdown (.md) — images embedded
• PDF — title page plus paginated steps
• PowerPoint (.pptx) — one slide per step
• Narrated video (.webm) — 1080p, with a spoken voiceover

SHARE A LINK, OR DON'T
• Publish a guide and you get a link anyone can open — only that guide is uploaded
• The page carries your name, the recording's length and the app it happened in; every
  screenshot zooms, and any single step can be linked to on its own
• Pasted into a chat, the preview shows the guide's own title — never a step, never a
  screenshot. Shared guides are marked no-index
• Update it in place; the link you already shared keeps working
• Unpublish and the link stops working and the images are deleted
• Optionally let readers export it themselves — their browser builds the file, and you
  see who exported what. It governs whether a button appears, not who can read the page

YOUR SCREENSHOTS STAY PUT UNTIL YOU SAY OTHERWISE
Guides are saved in your own browser. Nothing is uploaded in the background, for
processing, or on a schedule — only the single guide you press Publish on. Annotations
and redactions are burned into the image before it leaves your machine, so no unredacted
original is ever sent.

Even the narration is local: the voice is synthesized on your own machine by a bundled
neural speech engine, so the text of your internal processes is never sent to a
text-to-speech service. That is unusual — most tools in this category upload both your
screenshots and your script.

This makes GuideGen usable in places cloud tools can't go: regulated industries,
customer data, internal admin panels, anything under an NDA.

GOOD TO KNOW
• A free account is needed — it signs you in to the editor and is what makes publishing work
• Guides you haven't published live on the machine that recorded them, so they don't
  appear on your other computers. Published guides do.
• Works on web pages in Chrome and other Chromium browsers (Edge, Brave, Arc)
• Cannot capture native desktop apps — browser only
• The first narrated video takes a moment longer while the voice model loads
• If a tab was already open when you installed GuideGen, reload it once before recording

GuideGen is free while in early access.
```

---

## Privacy practices tab

**Single purpose** (one sentence, they are strict about this)

```
GuideGen records the user's own browser interactions in order to generate an editable step-by-step guide that the user can export as a file or publish as a shareable link.
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
Used to store the user's guides — step text, screenshots and settings — locally in chrome.storage.local, and to keep the signed-in session. Guide data stays in local storage; nothing is transmitted unless the user explicitly publishes one guide.
```

`unlimitedStorage`
```
Every step stores a full screenshot of the page, so a library of guides quickly exceeds the default storage quota. This permission prevents guides from being silently truncated.
```

`tabs`
```
Used to read the URL and title of the tab being recorded, so each step records where it happened and the guide can be given a meaningful title, and to open the guide editor when recording stops.
```

`offscreen`
```
Used to render the narrated video export. Producing the video needs a canvas, a Web Audio context and a MediaRecorder, none of which exist in a service worker. The offscreen document is never visible, exists only while an export is running, and has no access to any page the user visits.
```

`identity`
```
Used only for "Continue with Google" sign-in. The extension opens Google's own consent screen through chrome.identity.launchWebAuthFlow and receives an identity token, which is exchanged for a Firebase session. It requests the openid, email and profile scopes and nothing else — no access to Gmail, Drive, contacts or any other Google service.
```

`downloads`
```
Used to save the narrated video export. The video is rendered in an offscreen document, which is the only context in the extension with a canvas, an AudioContext and a MediaRecorder; that document cannot save a file itself, so it hands the finished video to the service worker as a blob URL and the service worker saves it with chrome.downloads. The HTML, Markdown, PDF and PowerPoint exports do not use this permission — they are built and saved by the page the user is on.
```

> **This is the permission v1.0.0 was rejected for — Purple Potassium, 30 Jul 2026,
> "requesting but not using: downloads".** The rejection was correct. v1.0 saved every
> export by clicking an `<a download>` anchor from the editor page and never called
> `chrome.downloads` once, so the permission was declared for a feature that didn't use it.
>
> v1.1 uses it for exactly one thing, described above, and cannot avoid it: an offscreen
> document has no anchor to click and a service worker has no DOM. Keep this justification
> narrow and accurate — a reviewer re-auditing after a rejection is checking this specific
> field, and the previous wording claimed all five export formats used it, which would read
> as the same violation restated.

`webRequest`
```
Used to record the API log: while the user is recording a guide (or on a site they have explicitly armed for catch-up capture), the extension notes each network request the page makes — its method, its address with the query-string values masked, its status code and how long it took — and attaches that to the step that triggered it. This is what lets a captured bug report say "clicking Save sent POST /api/orders and received a 500" instead of "clicking Save did not work". It is observational only: the extension registers onBeforeRequest, onCompleted and onErrorOccurred as non-blocking listeners and cannot block, redirect or modify any request. Request headers are not read through this API at all. Nothing is recorded when no recording is running and the site is not armed, and never in incognito windows.
```

> **New in v1.2.0, and the one permission on this list a reviewer will read twice** — the
> API log is exactly what a policy reviewer expects to be misused, so the justification
> above has to be precisely true and nothing more. Three points it must keep making:
> observational only (no blocking listener is registered anywhere in `background.js`),
> no headers read through this API (`onBeforeSendHeaders` is not registered), and nothing
> recorded while idle.
>
> Note also what `webRequest` **cannot** do, because it explains the rest of the design:
> it cannot read a request or response body, and it is not what reads request headers
> either. All of that comes from `netpatch.js` in the page's MAIN world and is opt-in,
> off by default, chosen per recording. That is **not** a `webRequest` capability and
> must not be justified as one.
>
> **v1.2 changed a claim that appears in the old listing copy.** Tier 2 now captures the
> request side of a failed exchange — header *names*, the sent body — so that the log can
> be shown as a cURL. Credential header values, query-string values and obvious secrets in
> a body are replaced with a mask, in the page and again in the worker, and there is no
> setting that keeps a real one. So the accurate sentence is "credential values are never
> stored", **not** "headers are never read". Anywhere the listing still says the latter has
> to change with this build; `web/privacy.html` §9b already has the correct wording.
>
> `chrome.debugger` was considered for bodies and rejected: it works, but it displays a
> "started debugging this browser" banner, blocks DevTools, and is close to an automatic
> rejection. Do not reach for it later.

**Are you using remote code?** → **No, I am not using remote code.** (No justification field
appears once No is selected.)

Audited 31 Jul 2026, because `'wasm-unsafe-eval'` in the manifest CSP makes this look like a
yes and it is not. That flag permits instantiating wasm **already in the package** — the
espeak-ng and onnxruntime binaries under `lib/`. Chrome's question is about JS or Wasm *not
included in the package*. Verified: every `<script src>` in `popup.html`, `offscreen.html` and
`editor.html` is a relative bundled file; no `http(s)` script or module reference exists in any
of the nine extension JS files; no `eval(` or `new Function(`; and every wasm/onnx path in
`tts.js` is `lib/…`. Answering Yes would be a false declaration and would send a reviewer
looking for a remote fetch that isn't there.

**Host permission** `<all_urls>`
```
GuideGen documents whatever web application the user chooses, which cannot be known in advance — it may be any internal admin panel, SaaS dashboard or intranet site. The content script must therefore be able to run on any URL the user decides to record. It is inert unless the user has explicitly started a recording, and it reads only the label and position of the element clicked. Recorded pages are stored locally and are transmitted only if the user explicitly publishes that one guide to get a shareable link.
```

**Data usage — certify all three:**
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Data collection disclosure — v1.1 changes this. Tick exactly these four:**

| Category | Why it applies |
|---|---|
| **Personally identifiable information** | The account has an email address and a full name. Chrome's own definition of this category names both — "name, address, email address, age, or identification number" — so they belong here and not only under *Authentication information*. No phone number is collected. |
| **Authentication information** | Email/password sign-in means a password is handled, and the session (id token + refresh token) is held in `chrome.storage.local`. v1.0 had no account; v1.1 requires one. |
| **Website content** | Publishing a guide uploads screenshots of the pages the user recorded, plus the step text generated from those pages. Only for the guide the user presses Publish on. |
| **Web history** | Each step stores the URL and page title of where it happened, and those are included in a published guide. The API log adds the address of each request the page made, with its query-string values masked. |

**v1.2 adds the API log, and it does *not* add a category — check that reasoning rather than
assuming it.** The request summary is *Website content* and *Web history*, both already
declared. The exchange — request headers, the body sent, the body returned — is also *Website
content*: it is content the recorded page produced or submitted. It is opt-in, off by default,
never uploaded, and excluded from a published guide, so nothing here becomes *transmitted* data.
Credential header values, query-string values and credential-looking keys inside a body are
masked before storage, in the page and again in the worker, so no *Authentication information*
belonging to the recorded site is held either.

**v1.2.3 widened this and the reasoning was re-checked rather than assumed.** Tier 2 now keeps
the body of a *successful* response as well as a failed one — an earlier version of this note
said that would be the thing to revisit, so: it is still *Website content* and still local-only,
so the table does not move, and the mitigations that carry it are the opt-in default (off,
per recording), the masking, the trimming, per-step deletion in the editor, and the publish
whitelist. What **would** move this table is including the log in what publishing uploads, or
keeping a real credential value. Neither is true, and `web/assets/publish.js` names the fields
it sends precisely so the first cannot happen by accident.

*On the first two together:* declare both rather than picking one. They cover different
things — *who the account belongs to* versus *the secrets that prove it* — and this build
does both. Filing the email under *Authentication information* alone is an
under-declaration, and it contradicts the hosted privacy policy, which says in plain words
that an email address and a name are stored. A reviewer reads that policy next to these
boxes; they must agree.

*Name:* stored as the Firebase Auth `displayName` (asked for on password signup, supplied by
the token on Google sign-in). Nothing writes it to Firestore, and the export log deliberately
omits it, because a name can't be verified against the caller's token the way an email can.

**One more consideration, if guide exports are enabled.** The export log records the email
address of a *recipient* — someone who may never have installed the extension — and shows it
to the guide's owner. That is still *Authentication information* / *Personally identifiable
information* rather than a new category, but two things follow:

- The recipient must be told before they sign in. The public page does this, above the form.
- It is disclosed to a third party (the guide owner) by design, which is a use the
  "I do not sell or transfer user data to third parties" certification permits, because the
  user is told and it is the purpose of the feature. Read the certification wording again
  before ticking it if this changes.

Leave everything else unchecked — **no** health, financial, location or personal communications data,
**no** user activity (there is no analytics or telemetry of any kind), and **no** website
content collected for any purpose other than the guide the user chose to publish.

Do not tick a box "just in case": an over-declaration is as inconsistent with the source
as an under-declaration, and reviewers check.

**This is the declaration change that gates the v1.1 submission.** v1.0 was reviewed with
every box unchecked, which was accurate — that build made no network requests at all.
Shipping v1.1 without updating this would be a false declaration. The hosted privacy
policy at `/privacy` has been revised to match and now opens with what changed in 1.1.

**Also review before submitting v1.1:**
- **Re-audit every permission against a call site, not against intent.** This is what the
  v1.0 rejection was: a permission that made sense on paper and was never called. Verified
  for v1.1 on 31 Jul 2026 — `activeTab`/`scripting`/`tabs`/`offscreen` in `background.js`,
  `storage` in four files, `downloads` at `background.js:649`, `identity` in `sync.js`.
  `unlimitedStorage` has no API surface at all and is declared alone, which is normal and
  is not what the policy is about.
- The listing no longer claims "no account" or that there is nowhere to upload to. Both
  were true of v1.0 and are not true now. Check the description above, the landing page
  and the FAQ together — they have to agree.
- **Catch-up capture changes the permission *story* without changing the permission
  *list*.** The buffer keeps the last 240 actions, for up to 7 days, on origins the user
  explicitly arms, so it captures without a recording having been started — which makes the
  host-permission justification's "It is inert unless the user has explicitly started a
  recording" and the landing page's old "The recorder does nothing until you press start"
  both false. Nothing new is requested: `<all_urls>` and the declared content script were
  already there and the recorder has always run on every page. Rewrite that clause to
  something like "It is inert unless the user starts a recording, or has explicitly armed
  this specific site for catch-up capture," and say in the description that the buffer is off
  by default, per site, capped, never uploaded, and shown on screen while it runs.
  Data declarations do **not** change — buffered steps never leave the device.

  Two numbers to state accurately when that rewrite happens, because they are the ones a
  reviewer will weigh: **7 days** of retention (not minutes), and **on screen the whole
  time it is armed** as a small dot rather than a pill. The user-facing name is **"Capture
  last 2 minutes"** — lead with that rather than with "buffer", which describes the
  mechanism and not the promise.

- **The user-facing feature name is "Capture last 2 minutes", and the landing page does not
  mention it yet — deliberately.** The version in review has no catch-up capture at all, so
  a site promising it would over-promise to anyone installing from the store today. Ship the
  site copy and the listing rewrite together, after approval, not before.
- **The website now leads with the AI handoff; this listing does not, deliberately.** The
  site's headline is "Do it once, hand it to a person or an AI" and its first section is the
  handoff; the listing above still leads with step-by-step capture. That is a *deferred*
  edit, not a contradiction — the item is in review and editing the listing restarts the
  queue. Nothing above is now false: the handoff is a sixth export of the same recording,
  and the permissions, data declarations and single purpose are unchanged by it.
  When the review clears, bring the description into line — add the handoff to the
  EXPORT TO list and to the opening paragraph — and re-check it against the landing page
  and the FAQ, which is the check this bullet already asks for.
- `externally_connectable` names `https://guide-gen.vercel.app/*`. This is not a
  permission and has no justification field, but expect it to draw review attention: the
  editor is a page on that site and reads the user's local guides over that channel. The
  privacy policy explains it in section 1.
- The single-purpose statement below still holds. Publishing is the same purpose — the
  user's own guide, exported to a link instead of a file.

**Privacy policy URL** — live and verified:

```
https://guide-gen.vercel.app/privacy
```

> Note: the old standalone `store/privacy-policy.html` has been deleted — the hosted
> page at that URL is the only privacy policy.
> Use the URL above; it covers both the extension and the website.

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
