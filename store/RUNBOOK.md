# Launch runbook — submit GuideGen to the Chrome Web Store today

Everything you need is in this folder. Work top to bottom; the whole thing is about
40 minutes of your time, most of it taking screenshots.

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
cd "/Users/apple/Desktop/GuideGen 2" && open store/screenshots-raw
```

Drop them in that folder and run:

```bash
bash "/Users/apple/Desktop/GuideGen 2/store/make-screenshots.sh"
```

That converts each one to exactly 1280×800 in `store/screenshots-out/`. Verified
working — the store rejects wrong dimensions, so don't skip it.

> Use a guide with **real** content. Screenshots that look like placeholder data read
> as an unfinished product to both reviewers and users.

---

## Step 2 — build the package

Already built at `../guidegen-build.zip` (68 MB). If you changed anything since —
including the rename — rebuild it:

```bash
cd "/Users/apple/Desktop/GuideGen 2" && rm -f ../guidegen-build.zip && zip -r -X ../guidegen-build.zip manifest.json background.js recorder.js recorder.css popup.html popup.js editor.html editor.js editor.css render.js exporters.js tts.js icons lib -x "*.DS_Store" -x "*.map"
```

`CLAUDE.md` and `README.md` are deliberately excluded — they describe the project as a
"replica of Scribe Capture", which should not be sitting inside a package a reviewer can
open.

---

## Step 3 — publish the privacy policy (5 minutes, free)

The store requires a reachable privacy-policy URL. `store/privacy-policy.html` is
written and ready. Free hosting, no card needed:

1. Create a public GitHub repo, e.g. `flowscribe-site`
2. Upload `store/privacy-policy.html`, renamed to `index.html`
3. Repo **Settings → Pages → Source: main branch, / (root) → Save**
4. Wait ~1 minute; your URL is `https://<username>.github.io/flowscribe-site/`
5. Open it and confirm it loads

Keep that URL — it goes in the Privacy tab.

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
- Privacy policy URL: your GitHub Pages URL from step 3

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
