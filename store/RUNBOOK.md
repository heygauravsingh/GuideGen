# Launch runbook — submit GuideGen to the Chrome Web Store today

Everything you need is in this folder. Work top to bottom; the whole thing is about
40 minutes of your time, most of it taking screenshots.

> The project folder on disk is still `~/Desktop/FlowScribe 2` — only the product name
> changed, not the directory. Renaming it would break your Chrome "Load unpacked" path,
> so it stays. Everything a user or reviewer sees says GuideGen.

**Set expectations:** you will *submit* today. Google reviews it. A first submission
with `<all_urls>` host permission usually takes 1–3 days, occasionally longer. Nothing
you do can speed that up, so the goal today is a submission with zero loose ends.

---

## Step 0 — the name is settled

Done. The product is **GuideGen** everywhere that matters:

- `manifest.json` name and toolbar title
- The extension UI, the editor, and every export footer
- Firebase project `guidegen-1f938`, Cloudinary folder `GuideGen`
- GitHub `heygauravsingh/GuideGen`, live at `guide-gen.vercel.app`

This also sidesteps the trademark exposure of shipping a product called
Flow**Scribe** against the incumbent Scribe (scribehow.com).

Internal identifiers were deliberately left alone — `chrome.storage` keys
(`fs_state`, `fs_step_*`), the `FSRender`/`FSExport`/`FSTTS` globals, and the
`flowscribe-pill` CSS class. Renaming storage keys would orphan guides people
have already recorded; none of these are visible to users.

---

## Step 1 — take five screenshots (15 minutes)

Load the extension unpacked, record one real guide in uEngage, then capture:

1. The editor with that guide open, steps and screenshots visible
2. The **Export** menu open, showing all five formats
3. The **narrated video** dialog with the pace control
4. A step in **redaction** mode (the "Drag over anything to hide" overlay)
5. The **recording pill** on a real page

Any size is fine. Then:

```bash
cd "/Users/apple/Desktop/FlowScribe 2" && open store/screenshots-raw
```

Drop them in that folder and run:

```bash
bash "/Users/apple/Desktop/FlowScribe 2/store/make-screenshots.sh"
```

That converts each one to exactly 1280×800 in `store/screenshots-out/`. Verified
working — the store rejects wrong dimensions, so don't skip it.

> Use a guide with **real** content. Screenshots that look like placeholder data read
> as an unfinished product to both reviewers and users.

---

## Step 1b — the listing screenshots are stale (BLOCKS v1.1)

`store/screenshots-out/*.png` — all five — show the **retired extension editor**: the old
purple palette, the sidebar guide list, `editor.html`. That page no longer exists; the editor
is the dashboard at `/app`. Submitting these would show reviewers and users a product that
isn't what installs.

They have to be retaken, and they can't be faked from placeholder data — the RUNBOOK's own
rule above applies, and a store listing is the wrong place to invent a screenshot. Record two
or three real guides, then capture:

1. the dashboard editor with a guide open (replaces `1-editor.png`)
2. the export menu open (replaces `2-export.png`)
3. the narrated-video dialog (replaces `3-video.png`)
4. a redaction in progress (replaces `4-redact.png`)
5. the recording pill on a real page (`5-pill.png` — still accurate in composition, wrong
   colours: the pill is warm near-black now, not blue-black, and Stop is ink not purple)

`store/make-screenshots.sh` still frames them; check it doesn't reference `editor.html`.

## Step 2 — build the package

First check the two things that are generated and go stale silently — the website's
copies of the shared renderer, and the icons:

```bash
cd "/Users/apple/Desktop/FlowScribe 2" && node tools/sync-web-assets.mjs --check && node tools/make-icons.mjs --check
```

A stale renderer mirror keeps the site working while rendering last week's annotations.
A stale icon doesn't show up in a grep for a hex value at all — which is exactly how the
purple bullseye survived the repalette.

Then rebuild the package:

```bash
cd "/Users/apple/Desktop/FlowScribe 2" && rm -f ../guidegen-build.zip && zip -r -X ../guidegen-build.zip manifest.json background.js recorder.js recorder.css popup.html popup.js sync.js editor.html redirect.js offscreen.html offscreen.js render.js exporters.js tts.js icons lib -x "*.DS_Store" -x "*.map"
```

The file list changed for v1.1, in both directions:
- **added** `sync.js` (the account session — v1.0 shipped without it, which is why the
  reviewed build had no sync at all), `offscreen.html` + `offscreen.js` (the narrated
  video renderer), `redirect.js`
- **removed** `editor.js` and `editor.css` — the editor moved to the website. `editor.html`
  stays, as a redirect for v1.0 bookmarks.

`CLAUDE.md`, `README.md`, `PLAN.md`, `tools/` and `web/` are all deliberately excluded.
The first three describe the project as a "replica of Scribe Capture", which should not be
sitting inside a package a reviewer can open; the last two aren't part of the extension.

---

## Step 3 — privacy policy: already live

Done, hosted on Vercel alongside the landing page:

```
https://guide-gen.vercel.app/privacy
```

Verified returning 200 with the correct headers. The old standalone
`store/privacy-policy.html` has been deleted: it predated the website, still said
"collects nothing, transmits nothing, no account", and a superseded copy making claims
the product no longer meets is worse than no copy. `web/privacy.html` is the only one.

There's a Terms of Service at `/terms` too, which the store doesn't require but which
you want in place before anyone signs up.

---

## Step 4 — create the item

1. Go to <https://chrome.google.com/webstore/devconsole>
2. **Add new item**
3. Drag in `guidegen-build.zip`
4. Wait for the upload to process (68 MB — give it a minute)

If it rejects the upload, the message names the reason; the usual causes are a manifest
error or a stray file, and neither applies here.

---

## Step 5 — fill in the three tabs

Open `store/LISTING.md` beside the dashboard and paste as you go.

**Store listing** — name, short description, detailed description, category
(Productivity → Workflow & Planning), language, and your five screenshots. The icon is
picked up from the manifest automatically. Promotional tiles are optional; skip them
today.

**Privacy practices** — this is where submissions get bounced, so don't rush it:
- Single purpose: paste from LISTING.md
- A justification for every permission: all six plus the host permission, pasted from LISTING.md
- Data usage: tick the three certifications; leave **every** data-collection category unchecked
- Privacy policy URL: `https://guide-gen.vercel.app/privacy`

**Distribution** — Free, all regions, and see the next step for visibility.

---

## Step 6 — choose visibility, then submit

Set visibility to **Unlisted** for this first submission.

Unlisted means it isn't in search or the category pages, but anyone with the link can
install it. For a soft launch that's what you want: you can hand the link to colleagues
and design partners immediately, gather feedback on a real install, and flip to
**Public** later from this same screen without resubmitting the package.

Then **Submit for review**.

---

## After you submit

- You'll get an email when it's approved or rejected. Rejections name the policy and are
  usually fixable in one edit — the common one for this category is an insufficient
  permission justification, which is why step 5 matters.
- Don't upload a new package while a review is pending; it restarts the queue.
- Once live, the install link is `https://chromewebstore.google.com/detail/<your-item-id>`

## Known gaps a user may hit — worth knowing before people install

None of these blocks a free early-access launch, but you should not be surprised by them:

- **Browser only.** No native desktop capture.
- **No sharing.** Guides are files; there's no link to send.
- **English only.** The step-wording and title heuristics assume English.
- **Heavy install.** ~68 MB, nearly all of it the bundled voice model.
- **Video renders in the foreground.** Chrome suspends background tabs; the picture goes
  choppy if the user switches away mid-render.
- **No error reporting.** If something breaks for a user, you will not find out unless
  they tell you. Ask early users for the editor's DevTools console on any failure.
