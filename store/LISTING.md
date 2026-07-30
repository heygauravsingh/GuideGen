# Chrome Web Store listing — copy/paste sheet

Everything below is ready to paste into the Developer Dashboard. Nothing here needs
editing except the two `<<< >>>` placeholders.

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

SHARE A LINK, OR DON'T
• Publish a guide and you get a link anyone can open — only that guide is uploaded
• Update it in place; the link you already shared keeps working
• Unpublish and the link stops working and the images are deleted
• Optionally let readers export it themselves — their browser builds the file, and you
  see who exported what

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
Used to save the exported guide — HTML, Markdown, PDF, PowerPoint or video — to the user's computer when they choose an export format.
```

**Host permission** `<all_urls>`
```
GuideGen documents whatever web application the user chooses, which cannot be known in advance — it may be any internal admin panel, SaaS dashboard or intranet site. The content script must therefore be able to run on any URL the user decides to record. It is inert unless the user has explicitly started a recording, and it reads only the label and position of the element clicked. Recorded pages are stored locally and are transmitted only if the user explicitly publishes that one guide to get a shareable link.
```

**Data usage — certify all three:**
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Data collection disclosure — v1.1 changes this. Tick exactly these three:**

| Category | Why it applies |
|---|---|
| **Authentication information** | The extension signs the user in (email + password, via Firebase Authentication) and holds the session. v1.0 had no account; v1.1 requires one. |
| **Website content** | Publishing a guide uploads screenshots of the pages the user recorded, plus the step text generated from those pages. Only for the guide the user presses Publish on. |
| **Web history** | Each step stores the URL and page title of where it happened, and those are included in a published guide. |

*Name:* signup asks for a full name, and Google sign-in supplies one. It is stored as the
Firebase Auth `displayName`, which is account data — already covered by *Authentication
information*. No separate category, and no phone number is collected.

**One more consideration, if guide exports are enabled.** The export log records the email
address of a *recipient* — someone who may never have installed the extension — and shows it
to the guide's owner. That is still *Authentication information* / *Personally identifiable
information* rather than a new category, but two things follow:

- The recipient must be told before they sign in. The public page does this, above the form.
- It is disclosed to a third party (the guide owner) by design, which is a use the
  "I do not sell or transfer user data to third parties" certification permits, because the
  user is told and it is the purpose of the feature. Read the certification wording again
  before ticking it if this changes.

Leave everything else unchecked — **no** personally identifiable information beyond the
email covered above, **no** health, financial, location or personal communications data,
**no** user activity (there is no analytics or telemetry of any kind), and **no** website
content collected for any purpose other than the guide the user chose to publish.

Do not tick a box "just in case": an over-declaration is as inconsistent with the source
as an under-declaration, and reviewers check.

**This is the declaration change that gates the v1.1 submission.** v1.0 was reviewed with
every box unchecked, which was accurate — that build made no network requests at all.
Shipping v1.1 without updating this would be a false declaration. The hosted privacy
policy at `/privacy` has been revised to match and now opens with what changed in 1.1.

**Also review before submitting v1.1:**
- The listing no longer claims "no account" or that there is nowhere to upload to. Both
  were true of v1.0 and are not true now. Check the description above, the landing page
  and the FAQ together — they have to agree.
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
