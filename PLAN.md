# GuideGen — build plan under real constraints

# TARGET ARCHITECTURE — agreed 30 July 2026

This supersedes the phase framing further down. Decided by Gaurav; the reasoning and the
constraints are recorded so neither of us re-litigates it.

## The flow

1. User installs the extension.
2. Clicking the extension requires **login/signup first**.
3. Once authenticated the popup offers **Start recording** and **Guide library**.
4. User records. Steps and screenshots are written to `chrome.storage.local` as now.
5. On stop, the **guide editor opens on the authenticated dashboard** (`/app`), not in the
   extension. Assets stay local — nothing is uploaded.
6. Editing and all five exports run on the **user's own device**. No server compute, ever.
7. **Publish** is the only thing that uploads, and only that guide.
8. A published guide can be edited and exported from the dashboard **on any device**.

## Why this is better than what exists now

One editor instead of two. Today `editor.html` and `/app` both edit guides and have to be
kept in parity by hand — that drift already produced a real bug (dialog inputs styled in
`site.css` but not `editor.css`). Moving the editor to the web retires `editor.html`
entirely: `render.js` and `exporters.js` are pure client-side and run identically there.

## The bridge — the one genuinely new piece

A page at `guide-gen.vercel.app` cannot read `chrome.storage.local`. Different origin,
different sandbox. The link is **`externally_connectable`** in the manifest: the dashboard
calls `chrome.runtime.sendMessage(EXTENSION_ID, ...)` and the background worker answers.

- Extension id is known: `dijeonandicniffeffbcolhfldommhnp`
- Manifest needs `"externally_connectable": { "matches": ["https://guide-gen.vercel.app/*"] }`
- **Fetch step images one at a time, lazily.** Do not send a whole guide in one message —
  a 10-step guide of full-res PNGs is 10–30MB and `sendMessage` will choke. One step per
  message, requested as the editor scrolls.
- This makes **WebP + downscale at capture time mandatory**, not an optimisation. It was
  already on the list for storage reasons; now the bridge depends on it.

## Constraints that follow — state these to users, don't discover them later

1. **Unpublished guides are device-local.** They live in that browser's extension storage,
   so they cannot be opened from another device. This is a direct consequence of "nothing
   syncs until publish" — it is the design working, not a bug. Published guides are the ones
   that travel.
2. **The dashboard needs the extension installed** to edit an *unpublished* guide, because
   that's where the bytes are. Editing a *published* guide needs nothing but a login.
3. **Redaction on a published guide is additive.** You can pixelate more of a baked image;
   you cannot un-redact, and you cannot move the highlight ring or re-crop, because those
   were burned in at publish. Acceptable — and it means no unredacted original is ever
   uploaded, so the redaction guarantee survives intact.
4. **Auth-gating the extension changes the store submission.** v1.1 must declare
   *Authentication information* at minimum, plus *Website content* and *Web history* once
   publishing ships. "No account needed to record" comes off the landing page, the FAQ and
   the store description — it will no longer be true.
5. **Guides recorded before auth-gating** must still be readable after the update. Don't
   change the `fs_*` storage keys.

## Asset deletion — the one place a server endpoint is genuinely needed

**Current behaviour: deleting a guide deletes the Firestore document and nothing else.**
The Cloudinary images persist indefinitely and stay retrievable by anyone holding an image
URL. Deleting a guide kills the link, not the pixels.

Why this cannot be done client-side: Cloudinary deletion needs the **API secret**, and a
secret cannot ship in a browser. The `delete_token` returned by unsigned uploads expires
after ~10 minutes, so it is useless for deleting later. This is a *credential custody*
problem, not a compute problem — the "everything client-side" rule still holds for
rendering and export.

**The fix:** a small Vercel function, e.g. `/api/delete-assets`:
1. Read the caller's Firebase `idToken` from the request.
2. Validate it (`identitytoolkit:lookup`) to get the uid — do not trust a uid in the body.
3. Read the guide doc; confirm `ownerUid === uid`.
4. Call Cloudinary Admin API `delete_resources_by_tag` for that guide's asset tag.
5. Delete the Firestore doc.

Free on Vercel Hobby (1M invocations). The Cloudinary API key and secret go in Vercel
environment variables — never in the repo, never in client code.

Account deletion is the same call with the `uid_<uid>` tag instead.

### ~~BUG~~ FIXED 30 Jul 2026 — asset tags are now usable for deletion

`sync.js` mints a random `assetTag` (`gg_` + 24 chars from `crypto.getRandomValues`) per
publish, tags every uploaded image with it, and stores it on the Firestore document.
Verified on a real publish: doc `PevZmVZFAgNfCqsM9jT5` carries
`assetTag: gg_1r400n1j1c643n074z3h720d`. Deletion is then one call:
`DELETE /resources/image/tags/<assetTag>`.

Work item 9 (the Vercel function) is now unblocked. Guides published **before** this fix
still have unlocatable images — purge the `GuideGen` Cloudinary folder by hand once.

Original problem, for the record:

`sync.js` tags uploads with `guide_<local fs_index id>`, because the Firestore document does
not exist yet when the images are uploaded. **The dashboard only ever knows the remoteId**,
so it cannot derive that tag. Delete-by-tag would silently match nothing.

Fix: generate a random `assetTag` in the extension at publish time, use it as the Cloudinary
tag, and **store it as a field on the Firestore document**. Then any client can ask the
endpoint to purge exactly that guide's assets.

**Anything published before this fix has orphaned images with no way to locate them** —
including the test guides listed further down. Purge the whole `GuideGen` Cloudinary folder
by hand once, after the fix lands.

## Work breakdown

| # | Piece | Notes |
|---|---|---|
| ~~1~~ | ~~WebP + downscale at capture~~ | **Done 30 Jul 2026.** See below. |
| ~~2~~ | ~~Auth in the popup~~ | **Done 30 Jul 2026.** |
| ~~3~~ | ~~`externally_connectable` + message handler~~ | **Done 30 Jul 2026.** |
| ~~4~~ | ~~Dashboard editor~~ | **Done 30 Jul 2026.** |
| ~~5~~ | ~~Retire `editor.html`~~ | **Done 30 Jul 2026.** Offscreen document keeps narration. |
| ~~6~~ | ~~Update-in-place publish~~ | **Done 30 Jul 2026.** |
| ~~7~~ | ~~Store v1.1~~ | **Copy and declarations written 30 Jul 2026 — not submitted.** |
| ~~8~~ | ~~`assetTag` on the guide doc~~ | **Done 30 Jul 2026**, verified on a real publish. |
| 9 | `/api/delete-assets` Vercel function | Purge Cloudinary assets on guide or account deletion. Only server-side code in the product. |

### ~~1~~ DONE 30 Jul 2026 — captures are WebP, width-capped at 1600px

`background.js → normalizeShot()` re-encodes every capture to WebP at a 1600px width cap
(`SHOT`, q0.92) before it is stored, and folds the downscale factor into `step.dpr` so no
consumer changed. Details and the three rules worth knowing are in CLAUDE.md → *Screenshot
normalisation*. The bridge (item 3) is unblocked: a step image is now ~100–150KB instead of
1–3MB, which is a size `sendMessage` can carry one step at a time.

Verified: the encode path run in a real Chrome engine on a synthetic 3024×1700 dashboard —
output `image/webp`, 1600×899, scale exactly 1600/3024, 686KB → 126KB (5.4×), ~360ms per
step, and a deliberately corrupt input falls back to the original untouched. The
orchestration was driven against the real `background.js` with stubbed `chrome` and codec:
step order, `seq`, the `dpr` fold, and Stop landing mid-encode. Both race assertions were
checked to fail on the pre-fix code, so they test something.

Two things this changed that were not in the original scope, both consequences rather than
extras:

- **`fs_capture_step` now acks before the encode.** `recorder.js` hides its pill until that
  response arrives, so acking afterwards blinked the pill out for ~350ms on every click.
- **`persistStep` re-reads `fs_state` before updating the step counter.** The old code wrote
  back the state the step was captured under; with a ~350ms encode, clicking and then
  immediately pressing Stop would set `recording: true` again. That race existed before at
  ~70ms odds — it is now closed.

Still true and worth stating: pages where `focusRegion` genuinely crops lose some
magnification headroom versus a full-retina source. Dense dashboards, where the region is the
full frame, export at exactly the size they did before.

### ~~2–7~~ DONE 30 Jul 2026 — the architecture above is built

The flow at the top of this document now exists. What shipped, and the decisions that
weren't in the plan:

**2 — auth in the popup.** `sync.js` was trimmed to auth only and loaded into `popup.html`;
the popup shows a sign-in/sign-up form until there's a session, then the record controls. It
gained `sendPasswordReset` so nobody has to leave the popup to recover an account.

**3 — the bridge.** `externally_connectable` names `https://guide-gen.vercel.app/*` and
nothing else. `onMessageExternal` serves ten one-shot requests; `onConnectExternal` serves a
`gg_task` port for the video render. Per-step image fetch as specified. Every write validates
its input as if a stranger sent it, because a web page did — reorders must be a permutation
of the existing steps, redaction rects must be finite and positive. Details in CLAUDE.md →
*The bridge*.

**4 — the dashboard editor.** `web/assets/app.js`, full parity with the retired one for local
guides: title, step text, drag reorder, move up/down, delete, drag-to-redact, clear
redactions, notes, and the four document exports. Published guides get title and step text,
with their images read-only and labelled as such. `render.js`/`exporters.js` are mirrored into
`web/assets/` by `tools/sync-web-assets.mjs` — the plan asked for that script and it has a
`--check` mode now wired into the RUNBOOK's build step, because a stale mirror is silent.

**5 — `editor.html` retired**, now a redirect carrying `#<guideId>` across as
`#local-<guideId>`. `editor.js` and `editor.css` are deleted (recoverable from git).

**6 — update-in-place publish.** `GGPublish.republish()` PATCHes the existing document, so a
shared link never goes stale.

**7 — store v1.1 copy written, not submitted.** The five listing screenshots are a
separate blocker: they all show the retired purple `editor.html`, so they have to be
retaken from real guides before submission (see RUNBOOK step 1b). The icons were the same
problem and are fixed — they were a purple bullseye, now generated by
`tools/make-icons.mjs` from the same accent as everything else, with a `--check` wired into
the build so they can't drift again. `store/LISTING.md` now ticks *Authentication
information*, *Website content* and *Web history*, with a note that shipping without that
change would be a false declaration. The listing, the landing page and the FAQ no longer
claim "no account" or that there is nowhere to upload to. `web/privacy.html` opens with what
changed in 1.1. The stale standalone `store/privacy-policy.html` was deleted — it predated
the site and still said "collects nothing, transmits nothing, no account".

#### Decisions taken that the plan didn't cover

- **Narrated video moved to an offscreen document, not to the web.** Retiring `editor.html`
  would have stranded it: the voice is 88MB in `lib/`, and `.vercelignore` exists precisely to
  stop that being served — at 88MB a head, Vercel Hobby's 100GB/month is ~1,100 exports.
  `chrome.offscreen` gives a DOM, an AudioContext and a MediaRecorder with no visible page.
  Three `exporters.js` options were added for it (`tickMs`, `monitor`, `onBlob`); the first is
  load-bearing, since `requestAnimationFrame` never fires in a page that is never visible and
  the video would otherwise render at 10fps. **Side benefit: nobody has to keep a tab focused
  during a render any more**, which was a listed caveat in the README and the store listing.
- **Publishing moved to the web rather than staying in the extension.** The plan didn't say
  where it should live once the editor moved. Keeping it in `sync.js` would have meant two
  implementations of rules the CLAUDE.md has five numbered warnings about, so `publish()` was
  removed from `sync.js` and rewritten once in `web/assets/publish.js`. Consequence to accept:
  publishing needs the machine that holds the guide, which constraint 2 above already implies.
- **`/api/delete-assets` gained a `purgeTag` mode**, needed by item 6. Re-publishing can't
  overwrite images — rule 5, `Overwrite: false` — so a new tag is uploaded and the old one has
  to be purged, or a republish intended to *remove* something sensitive would leave the old
  image publicly retrievable. It can't authorise from the document (which by then names the
  new tag), so it checks that every image under the tag carries `uid_<caller>`. Guides now
  carry `assetTags` (all tags ever used) so a failed purge is still caught at delete time.
  This also unlocks account-wide deletion by `uid_` tag.
- **One sign-in, not two.** The extension holds the session and the dashboard adopts it over
  `gg_session` if it has none of its own. Without this, a user signs in at the popup and is
  immediately asked again by the editor.
- **`render.js` now sets `crossOrigin` on http(s) sources.** Exporting a *published* guide
  draws a Cloudinary image into a canvas, and without CORS that canvas is tainted, so
  `toDataURL` throws — every export of a shared guide would have failed at the last step.
- **The viewer's broken-image gap below is fixed for the editor**, not the public viewer:
  `app.js` swaps a failed baked image for a "no longer available" line. `web/g.html` still
  needs the same treatment.

#### Verified, and what wasn't

Verified in a real Chrome engine against a served copy of `web/`, with `GG` and `GGBridge`
stubbed so nothing touched the live Firebase or Cloudinary projects:

- The editor renders a three-step local guide: annotations painted by `FSRender` onto canvas
  (ring sampled at exactly `#7c3aed`), the redaction rect pixelated, skeletons cleared, note
  card styled as a note, no monospace leak in the textareas.
- The library merges a local guide and its published counterpart into **one** row.
- With no extension: the explanatory note appears and only published guides list, marked
  "not on this device".
- A shared-only guide: banner shown, Note hidden, no drag grips and no per-step tools, images
  labelled read-only, step text still editable.

**Not verified, and needs a real run before submitting:**

1. **Nothing was exercised against the live backend** — no publish, no republish, no delete,
   no `purgeTag` call, no sign-in. Deliberate: the plan lists leftover test data to clean up
   and creating more would add to it.
2. **The bridge has never carried a real message.** It only answers
   `https://guide-gen.vercel.app`, so a locally served dashboard cannot reach it — this needs
   the deployed site plus the extension loaded unpacked.
3. **The offscreen video renderer has never run.** The `tickMs`/`monitor`/`onBlob` reasoning is
   sound but untested; the specific risks are whether `chrome.offscreen.hasDocument()` behaves
   as assumed across a worker restart, and whether the `blob:` URL survives the hand-off to
   `chrome.downloads` on a long render.
4. **No layout was seen.** The preview viewport measured 0×0, so every geometry number it
   reported was meaningless and no screenshot was taken. The editor CSS is unreviewed visually.

Worth doing in this order: load unpacked → sign in at the popup → record a short guide → stop
→ confirm the dashboard opens and lists it → export a PDF → export the video → publish →
re-publish → delete.

### Exports from a public guide — built 30 Jul 2026, NEEDS RULES PUBLISHED

The flow Gaurav specified: owner switches exports on per guide → a reader signs in on the
public page → the file is built on the reader's machine → the owner sees who exported what.

Built and verified locally end to end. **It will not fully work until the new Firestore rules
are published in the console** — the export log needs the `guides/{id}/exports` block from
`firebase/firestore.rules`. Everything else works without it; logging fails silently by
design, because the file is already on the reader's disk by the time we try to record it.

What was decided along the way:

- **Narrated video does work for a recipient**, contrary to my first assessment. I was wrong
  about the cost: published images are ~17KB each, so the page can hand a 40-step guide to the
  extension in about a megabyte over the existing `gg_task` port. The recipient does need the
  extension installed, and the page explains why rather than just failing.
- **`step.baked` is now a first-class concept** in render.js and exporters.js: the image is
  already annotated and cropped, so don't touch it. This fixed a real defect that was already
  live — PPTX crops to 2.0 and published images are 1.6, so exporting a published guide to
  PowerPoint *from the dashboard* was slicing the number badge off every slide. Verified with a
  control: real screenshots still crop to 1.5× maxZoom, baked ones pass through.
- **The log stores no client timestamp.** `createTime` is server-set and unforgeable; an `at`
  field would be a lie waiting to happen. `email` is checked against `request.auth.token.email`
  in the rules — without that a recipient could log an export as anyone they liked, which is
  worse than no log at all.
- **The switch is labelled as a convenience, not a lock**, in the UI and in the privacy policy.
  Published images are public URLs; print and right-click-save work whether it's on or off.
  Getting this wrong would let someone share something sensitive believing it was protected.
- **Deleting a guide sweeps its export log.** Firestore doesn't cascade, and the log holds
  other people's email addresses — the last thing that should outlive the guide.

Still open:

1. **Google sign-in is the conversion blocker for this feature.** "Create an account with a
   password to download a PDF" converts badly, and the whole growth argument for the sign-in
   gate depends on it being one tap. The OAuth redirect URI is already known:
   `https://dijeonandicniffeffbcolhfldommhnp.chromiumapp.org/`. Higher value than anything
   else on this list.
2. **A recipient can't actually install the extension yet** — the store listing is Unlisted and
   pending review, so the "Get the extension" link in the video panel won't resolve for anyone
   who doesn't already have it. Fine while testing with your own machines; blocks the video
   path for real recipients until v1.1 is public.
3. **The rules need re-verifying.** `scratchpad/verify_rules.py` covered 16 cases against the
   old ruleset; the exports subcollection adds at least: recipient can create with their own
   token email, cannot create with someone else's, cannot create when `allowExport` is false,
   cannot read the log, owner can read and delete, nobody can update.

### Early-access distribution — /install, added 30 Jul 2026

The funnel was broken: the landing page said "Get early access" and there was nothing to get,
because the store listing is Unlisted and pending review. `/install` fixes that — the ZIP plus
a six-step walkthrough — and the landing CTAs now point at it instead of the waitlist.

**Hosted on Google Drive, not Vercel.** Gaurav's call, and the right one: `.vercelignore` exists
to stop `lib/` being served, and a 68MB archive of exactly that would reintroduce the problem
that file was written to prevent — plus 68MB in git forever, since the site has no build step
and the file would have to be committed to be served. Drive costs nothing, caps nothing, and
lets testers have the *full* build with narration rather than a lite one.

Three things the page has to say, and does:

1. **The developer-mode nag is about the install method, not the extension.** Chrome shows it
   for anything loaded from a folder. Without explaining it, it reads as a warning about us.
2. **A folder-loaded extension has a different identity from the store build.** Chrome treats
   them as two extensions, so guides recorded now won't appear after switching to the store
   version — they're in the other extension's storage. Publish anything worth keeping first.
   This is the one thing on that page that can cost someone work.
3. **Reload any tab that was already open.** Pre-existing tabs haven't loaded the recorder.

Two ZIPs, and they are not interchangeable: the store requires `manifest.json` at the archive
root, so `GuideGen-Prod.zip` is flat; a human unzipping a flat archive gets loose files and
"pick the folder" then means nothing, so `GuideGen-Beta.zip` wraps everything in
`guidegen/`. Both commands are in RUNBOOK step 2 and 2b.

Open: **paste the Drive link into `DOWNLOAD_URL` in `web/install.html`.** Until then the page
hides the button and says the link is being set up, so it is safe to be live — but the funnel
isn't complete. Updating the build later means Drive → right-click the file → *Manage versions*
→ *Upload new version*, which keeps the file id and therefore the link stable; uploading a fresh
file mints a new id and the page then points at the old build with nothing to warn you.

Delete `/install` and revert the landing CTAs once the store listing is public.

### Google sign-in + full name — built 30 Jul 2026, NEEDS CONSOLE SETUP

On all three surfaces: popup, `/app`, and the viewer's export gate. Full name captured on
password signup only — Google supplies it in the token.

Decisions worth not re-litigating:

- **Plain OAuth redirect, not Google Identity Services.** `gg.js` states the site loads nothing
  from an external host, and GIS is a remote script. A redirect costs one page load.
- **Extension id pinned with `key`, so it's one OAuth client and two redirect URIs.** Chrome
  derives an unpacked id from the folder's *absolute path*, so it's stable per machine and
  different across machines — meaning every tester would need their own redirect URI, which
  isn't possible. `tools/set-extension-key.mjs` writes the store item's public key into the
  manifest and Chrome then derives the store id everywhere. The script checks the key against
  the known store id and refuses a mismatch: a key from the wrong item would mint a third id
  and break OAuth *and* the dashboard bridge simultaneously. Cross-checked the id derivation
  (SHA-256 of the DER key, first 16 bytes, nibbles mapped to a–p) against an independent
  implementation, and confirmed a wrong key is refused without touching the manifest.
  **Done 31 Jul 2026** — key in `manifest.json`, `--check` confirms it derives the store id.
- **`state` and `nonce` both checked.** Verified: state mismatch, nonce replay, user cancel and
  a direct visit to `/auth` are all rejected with the right message and the right return path.
- **Unset client id hides every Google button.** Same principle as the Drive link on `/install`.
- **The export log still stores email only, not the name.** `email` is checkable against
  `request.auth.token.email` in the rules; a name isn't reliably (the claim is absent until a
  token minted after `displayName` is set). An unverifiable name in a log the owner reads is
  worse than no name.
- **Phone number dropped.** Would have added *Personally identifiable information* to the store
  declaration and a privacy-policy section, for a field most people skip.

Verified locally: the redirect URL carries the right client id, redirect_uri, scopes and
`prompt=select_account`; state/nonce are stashed and match; the happy path saves a session with
the Google display name; and the viewer resumes the export it was interrupted for —
`?export=pdf` produced a real 4.8MB PDF with no second prompt and stripped the param afterwards.

**Console work, and nothing works until it's done** — RUNBOOK step 2c. Notably
*Authentication → Settings → one account per email address*, which decides whether a
password account and a Google account with the same address link or fork. Fork means two
libraries under one email and no merge path. Set it before anyone signs up twice.

### Small gap: the viewer has no broken-image handling — STILL OPEN as of 3 Aug 2026
Re-checked while rebuilding that page, and deliberately left alone: it was not on the list
the owner picked from the audit. It is now slightly worse than described below, because a
broken image also gets a Zoom button and opens an empty lightbox.

`web/g.html` renders each step's `imageUrl` as a plain `<img>` with no `onerror`. If an image
404s — a CDN purge racing a page load, or a guide whose assets were deleted out of band —
the reader gets a broken-image icon with no explanation. Five-line fix: an `onerror` that
replaces the figure with a quiet "image unavailable" placeholder. Worth doing before the
first real shared link, because a broken image in someone else's guide reads as the whole
product being broken.

### Also worth taking from Scribe's editor (observed 30 Jul 2026)
- **"Merge similar steps"** — a user-triggered fix for repeated clicks on same-labelled
  elements producing identical step text. We hit exactly this. **Still open.** What shipped
  instead is automatic and narrower: `mergeRedundant()` folds a field click into the typing
  that follows it, and `dropCausedNavs()` drops a page load the previous click explains.
  Neither is user-triggered, and neither merges two clicks on the same label.
- ~~**"Navigate to &lt;URL&gt;"** recorded as a step.~~ **DONE** — `nav` and `switch` steps,
  30 Jul. Since 3 Aug the ones a click already explains are dropped again, and a published
  guide leads with a `Start here` link built from `startUrl`.
- **ALT text per image**, for accessibility. **Still open.** The viewer emits `alt="Step n"`,
  which is a label rather than a description — there is no per-image alt anyone can edit.
- ~~A short guide description under the title, plus author / step count / creation time.~~
  **DONE 3 Aug** — an editable `description` in the editor, and the published page carries
  owner name, step count, recording length, the app and the date. No per-field toggles: they
  are all derived except the description, and a toggle per line is a settings screen for a
  page with five facts on it.

### Re-audited against Scribe's *published guide page*, 3 Aug 2026 — mostly built
Compared `/g/M3BNbgfE7yYrtv6uf5Ay` with the same workflow captured in Scribe. Built that day:
the wider column, click-to-zoom on every screenshot, Copy link, per-step anchors, the sticky
title and read progress, a table of contents, the scroll CTA, and the header facts above.

Deliberately **not** taken, with reasons:
- **Per-step comments.** Needs reader accounts and a moderation surface. Out of proportion.
- **"Save for later" / bookmarking.** Same reason.
- **Dark by default.** Every artefact this product makes is light — HTML export, PDF, video
  slides, the published page — so the editor matching what you're building wins.
- **LLM-written titles and summaries.** `guessTitle()` plus a description box the author
  writes gets most of the value with no model and no upload.
- **`Copy for AI` unauthenticated on the public page.** Considered and declined by the owner
  (3 Aug): the handoff export stays behind the owner's export switch like every other format.

Keep `render.js`/`exporters.js` single-source: one canonical copy in the repo root, copied
into `web/assets/` by a small script before commit. Two hand-maintained copies is exactly
how the last drift bug happened.

---

> ## Where things actually stand — 30 July 2026
>
> This plan was written as phases. In practice Phases 0–2 were all built in one push, so
> read the phase framing below as *rationale*, not as a to-do list.
>
> **Live and verified**
> - Extension submitted to the Chrome Web Store — **Pending review**, id
>   `pifkelcohogbbocldnkjlfiagjigikjl`, Unlisted. v1.0 has **no** sync in it.
>   *v1.1.0 submitted 31 Jul 2026 on the new item
>   `dijeonandicniffeffbcolhfldommhnp` — pending review, in-depth because of `<all_urls>`.*
>   *Superseded 31 Jul 2026: that submission was **rejected** (Purple Potassium — `downloads`
>   requested but not used, which was correct: v1.0 saved exports with an `<a download>`
>   anchor). Resubmitted as a new item, `dijeonandicniffeffbcolhfldommhnp`.*
> - Website live at `guide-gen.vercel.app`: `/` landing + waitlist, `/app` dashboard,
>   `/g/{id}` public viewer, `/privacy`, `/terms`.
> - Firebase `guidegen-1f938` (Spark, £0): email/password auth, Firestore, rules
>   **verified 16/16** by `scratchpad/verify_rules.py` against the live project.
> - Cloudinary `dqrytwq5e`, unsigned preset `GuideGen_Unsigned`, verified by real upload.
> - **Publishing works end to end.** Published from the editor → 2 images uploaded as
>   WebP (~17KB each) → Firestore doc readable anonymously → guide renders at
>   `guide-gen.vercel.app/g/Ntcrwjs3m5btw4u5bXTX`.
> - Everything committed to `github.com/heygauravsingh/GuideGen` (private).
>
> **Deliberate difference: the two editors are not the same**
> The extension's editor is the source of truth and can do everything — edit text,
> reorder, delete, redact, add notes, re-render annotations. The dashboard editor can
> change **title and step text only**, and shows each screenshot read-only for context.
> Images are rendered with annotations baked in at publish time, so changing one means
> re-publishing from the extension. Don't "unify" these without solving that.
>
> **Not done yet**
> - **v1.1 submission.** The reviewed v1.0 has no sync. Shipping sync means updating the
>   store data declaration to tick *Authentication information*, *Website content* and
>   *Web history*, and updating the privacy policy's "current release transmits nothing"
>   callout. Both are currently accurate for v1.0 — do not ship sync without changing them.
> - `optional_host_permissions` to clear the broad-permission warning (see RUNBOOK).
> - **Update-in-place from the extension.** Re-publishing currently creates a *new*
>   document and a *new* link, so a shared link silently goes stale after a local edit.
>   `remoteId` is already stored on the `fs_index` entry — the Share dialog needs an
>   Update action that PATCHes that document instead of POSTing a new one, plus a warning
>   that it overwrites text edited on the web.
> - **Title heuristic misfires on prose.** `looksLikeName()` rejects numbers, dates and
>   generic buttons, but a sentence-shaped label sails through: recording in Gmail produced
>   *"How to view What if a stay could stay with you? in Mail"* from an email subject.
>   Needs a rule about question marks and sentence-length labels.
> - **Duplicate step text.** Two clicks on same-labelled elements produce two identical
>   step descriptions. Visible in real use; the screenshots are the only way to tell them
>   apart, which is why the dashboard editor now shows them.
> - ~~Untested: whether the auth session survives an editor reload.~~ **Verified by Gaurav
>   in the real extension, 30 July 2026 — the session persists.** So `sync.js`'s session
>   handling (tokens in `chrome.storage.local`, refresh a minute before expiry) can be
>   reused as-is for the popup auth gate in work item 2. Nothing left unverified in the
>   current stack.
> - No automated tests. Every bug this session was caught by generating an artefact and
>   looking at it — A/V desync, collapsed step text, unstyled dialog inputs, `[hidden]`
>   being overridden. None were caught by reading code.
>
> **Test data to delete** (all created by Claude while verifying, none of it real)
> - Firebase Auth: `rulestest-owner-*`, `rulestest-other-*`, `dash-test-1785334636701@example.com`
> - Firestore `guides`: `Es2Kf8zrxbWF7k55EYLc`, `MeB4a1YGdhQ15GBLT87d`, `Ntcrwjs3m5btw4u5bXTX`
> - Firestore `waitlist`: `landing-test-delete-me@example.com`
> - Cloudinary `GuideGen` folder: 4 test assets + 2 published WebPs
>
> Deleting `Ntcrwjs3m5btw4u5bXTX` breaks the demo link above.

**Constraints this plan respects, stated up front:**
1. **Zero spend** until the product earns money. Not "cheap" — zero.
2. **Gaurav is not a developer.** All implementation is done with Claude. The stack must
   be small enough that a broken thing is diagnosable in one session.
3. Free tiers have ceilings. Each phase below states its ceiling, so hitting it is a
   decision rather than an outage.

The ordering principle: **don't build infrastructure for users you don't have yet.**
Sharing infrastructure is worth building when people ask for it, not before.

---

## Phase 0 — Ship and measure (now, £0, no infrastructure)

Goal: find out whether anyone wants this, before building anything for them.

- [x] Extension is feature-complete and packaged (`../GuideGen-Prod.zip` + `../GuideGen-Beta.zip`)
- [ ] Submit to Chrome Web Store as **Unlisted** (see `store/RUNBOOK.md`)
- [ ] Privacy policy on free static hosting (`store/privacy-policy.html`)
- [ ] Landing page — single static HTML file, free host, free subdomain, **no custom domain**
- [ ] **Waitlist email capture** on that page: "Want shareable links and team workspaces?"
      Use a Google Form or Tally — free, no backend, no database
- [ ] Screenshot normalisation: WebP + width cap at capture (see Phase 0 note below)

**Cost: £0.** Chrome Web Store's $5 is already paid and is one-time.

**What you learn:** install count, and how many of those people ask for sharing. That
number decides whether Phase 2 ever happens. If nobody asks, you've saved months.

### Phase 0 note — the one code change worth doing now

`captureVisibleTab` currently stores **full-retina PNG** (~3024×1700, 1–3 MB per step).
Every exporter already downscales to 1400–1600px, so most of those bytes are stored and
then thrown away. Converting capture to WebP at a capped width is roughly a 5–10×
reduction.

Worth doing now because it: (a) relieves `chrome.storage.local` pressure today, (b) makes
guides quicker to render in the editor, and (c) is a prerequisite for any future sync —
it's the difference between a free storage tier lasting months or days. It's contained to
`background.js` and costs nothing.

---

## Phase 1 — Sharing with zero infrastructure (only if people ask)

You can already share guides today and it costs nothing: `FSExport.html()` produces a
**single self-contained .html file** with every image embedded. That file can go in Google
Drive, Notion, SharePoint, an email — anywhere the user already has storage.

It isn't a pretty link. But it answers the real question: *is a file good enough, or is
the link itself the product?* Many teams are entirely happy dropping an HTML file in their
existing wiki.

Work in this phase is polish, not plumbing:
- Make the HTML export look like a designed guide page rather than a document dump
- Add a print stylesheet so the same file prints cleanly
- Optional per-guide password? No — not worth it in a file-based model

**Cost: £0 forever.** No server, no account, no ceiling.

**Also legitimate here:** for your first handful of design partners, host their guides
manually yourself. Five guides is a five-minute job. Do it by hand until the manual
work hurts — that's the signal to automate, and it costs nothing to find out.

---

## Phase 2 — Hosted sharing, one vendor (only when Phase 1 isn't enough)

If and only if users say a file isn't good enough, build the smallest possible hosted
version. The design goal is **no server code to maintain**.

**Stack: Vercel + Firebase. Two vendors, no credit card.**

| Concern | Where | Why |
|---|---|---|
| Landing page + guide viewer | Vercel Hobby | 100 GB transfer/month. Hard usage caps, **cannot purchase overage — so it cannot surprise-bill you** |
| Guide metadata | Firestore | 1 GiB, 50k reads/day, 20k writes/day |
| Auth | Firebase Auth | 50k monthly active users free |
| Screenshots | **Cloudinary** free tier | 25 monthly credits, no card. Firebase Storage requires Blaze on new projects — verified in the console 29 Jul 2026 |
| Authorization | Firebase Security Rules | **Declarative.** Policies, not code. Nothing to debug at 2am |
| Video & PDF | Still rendered in the browser | Never store them. This is your cost moat — protect it |
| Unshared guides | Stay in `chrome.storage.local` | Never uploaded. Protects the privacy claim *and* the storage bill |

Verified on the vendors' own pricing pages (July 2026). Firebase Spark states
"no payment method needed". Vercel Hobby is free with hard caps.

**Do not use** Vercel Blob for screenshots — it's only 1 GB storage / 10 GB transfer.
**Do not use** Firebase Hosting — only 360 MB/day transfer. Host on Vercel instead.

### Why Firebase over Supabase (revised)

Earlier drafts of this plan said Supabase. On the numbers Firebase wins:
100 GB/month asset download versus Supabase's 5 GB egress, and no 7-day
inactivity pause to worry about.

### Why Cloudinary and not Firebase Storage (corrected)

An earlier draft said Firebase Storage, on the basis of Firebase's pricing page listing it
under the free Spark plan. **The console disagrees: new projects must upgrade to Blaze to
enable Cloud Storage.** Confirmed 29 July 2026. Blaze would very likely bill $0 at this
scale but needs a card on file, which the zero-spend constraint rules out.

Cloudinary's free tier is 25 monthly credits with no card, where 1 credit = 1 GB storage
*or* 1 GB bandwidth *or* 1,000 transformations — one shared pool.

**Do not use Cloudinary's delivery transformations.** They're its headline feature, but at
1 credit per 1,000 derived images they would consume most of the monthly allowance. Upload
pre-optimised WebP and serve the original untransformed instead — which makes the
client-side WebP conversion necessary rather than merely nice.

### The ceiling, stated honestly

With WebP width-capped screenshots at ~250 KB each and ~8 steps per guide (~2 MB/guide),
against Cloudinary's 25 shared monthly credits:

- roughly **1,500 guides stored** (3 credits) plus **~11,000 guide views/month**
  (22 credits) — the split is yours to allocate, it's one pool
- zero transformation credits, provided we serve originals
- Firestore reads are the other limit — store each guide as **one document** (steps as an
  array) so a view costs 1 read, not 11. 50k reads/day is then ~50k guide views/day.

That is far beyond what early access needs. When you approach it you have a real decision
with real information: turn on payments, cap the free plan, or move blobs to Cloudflare R2
(zero egress fees) as a deliberate upgrade.

### Data model (the SaaS shape)

**Firestore** — one document per guide. The document ID *is* the public URL slug.

```
guides/{guideId}                 <-- guideId is the URL: /g/{guideId}
  ownerUid      string
  title         string
  visibility    "private" | "link" | "workspace"
  createdAt     timestamp
  stepCount     number
  steps         array of {                 <-- inline, so a view costs 1 read
                  seq, type, text,
                  imageUrl,                <-- tokenized Storage download URL
                  rect, blurs, dpr,
                  url, pageTitle
                }

users/{uid}
  email, displayName, plan
```

Firestore auto-IDs are 20 random characters (~120 bits), so they are already unguessable —
no need to invent a slug scheme. Vanity URLs later would be a separate
`slugs/{slug} -> guideId` collection.

**Storage** — `users/{uid}/guides/{guideId}/{stepId}.webp`

`getDownloadURL()` returns a URL carrying an unguessable access token. Store that token
URL in the guide document. The consequence is a clean privacy chain: the **document** is
gated by security rules, and the image URLs only exist inside the document. Revoke a
share and the URLs stop being discoverable.

Honest caveat: anyone who already copied an image URL keeps access until that token is
rotated. Same model as Scribe and Notion — worth knowing, not worth solving on day one.

**Security rules** — this is the entire authorization model, declarative:

```
match /guides/{id} {
  allow read:   if resource.data.visibility == "link"
                || request.auth.uid == resource.data.ownerUid;
  allow create: if request.auth.uid == request.resource.data.ownerUid;
  allow update, delete: if request.auth.uid == resource.data.ownerUid;
}
```

**The viewer** is a static page on Vercel at `/g/[id]`. It reads the guide document with
the Firebase web SDK and renders it with the existing `FSRender` code. No API layer, no
serverless functions, no backend to maintain. Set `X-Robots-Tag: noindex` on that route.

### The local data is already SaaS-shaped

Nothing shipping today needs redoing. A `fs_step_*` record already holds `seq`, `type`,
`text`, `rect`, `blurs`, `dpr`, `url` and `pageTitle` — the exact fields above. Sync is
therefore: convert screenshots to WebP, upload them, write one document. The extension's
storage layer stays as the local source of truth.

### Why the extension ID argues for submitting first

`externally_connectable` requires the extension manifest to name your web domain, and the
web app to name the **extension ID**. A published extension gets its permanent ID from the
store. So publishing v1.0 first gives you the real ID to build the sign-in handshake
against — and manifest changes are allowed in updates, so nothing is locked in by shipping
without it.

### Two things that are not optional in this phase

**Unguessable IDs and `noindex`.** Users will share internal SOPs containing customer
data. Long random IDs, `X-Robots-Tag: noindex` on every guide route, `robots.txt`
disallow. Default new shares to link-only, never to public. Getting this wrong turns your
product into an accidental disclosure engine, and you find out via a very bad email.

**The extension ID is now known** (assigned by the store on 31 Jul 2026):

```
dijeonandicniffeffbcolhfldommhnp
```

This unblocks Google sign-in from the extension (an OAuth client needs the redirect URI
`https://dijeonandicniffeffbcolhfldommhnp.chromiumapp.org/`) and it is the value the web
app must name when messaging the extension.

> Was `pifkelcohogbbocldnkjlfiagjigikjl` (29 Jul). That item's v1.0 draft was rejected and
> the product was resubmitted as a new item on 31 Jul, which moved the id. The id lives in
> four files plus the OAuth client; `node tools/set-extension-key.mjs <key> --id <id>` moves
> it in one verified step, and prints the prose files it can't.

**Extension → account linking.** Use `externally_connectable` in the manifest so your web
app can message the extension directly after sign-in — no token pasting, no OAuth dance.
This needs a manifest entry and a stable extension ID, which is **easier to add before
you have thousands of installs**. Worth adding the manifest entry in Phase 0 even if
unused, so it's there when needed.

### Caveats to verify yourself before depending on this

- Free-tier numbers move. Re-check Firebase and Vercel pricing pages before you build
  against them; the figures above were read in July 2026.
- Firebase's 20k writes/day is the limit most likely to bite first if you ever sync
  automatically rather than only on share. Another reason to keep sync opt-in.
- Firestore is not relational. Your data is simple (guides with steps), so this is fine,
  but it does mean moving off Firebase later is a migration, not a config change.

---

## Phase 3 — Only once money is coming in

- Payments (Stripe / Razorpay — Razorpay likely simpler for India)
- Move screenshots to Cloudflare R2 for zero-egress serving
- Custom domain
- Check Vercel's terms of service on commercial use before charging money. Their pricing
  page does not state a restriction; the limitation has historically lived in the
  fair-use/ToS wording. Verify it yourself rather than taking my word for it — I flagged
  it twice from memory and could not confirm it from their pricing page
- View analytics ("who read this SOP") — this is what L&D teams actually pay for
- Tests for the A/V-sync and crop invariants, before real customers hit them

---

## What I'd tell you not to do

- **Don't build Phase 2 now.** Zero users, zero budget, zero dev capacity. Sharing
  infrastructure for nobody is the most expensive kind of work: it costs weeks and
  teaches you nothing.
- **Don't buy a domain yet.** It's a decision about the name, and the name is unresolved
  (the Scribe trademark question in `store/RUNBOOK.md` step 0).
- **Don't use Cloudinary's delivery transformations.** Cloudinary itself is now the image
  store (Firebase Storage needs Blaze), but its transformation feature bills 1 credit per
  1,000 derived images and would eat the monthly allowance. Upload pre-optimised WebP and
  serve originals.
- **Don't click "Upgrade project" in Firebase.** It puts a card on file. Revisit only when
  there's revenue — at which point Firebase Storage beats Cloudinary on headroom.
- **Don't move rendering to a server.** Browser-side rendering is the reason your
  infrastructure can plausibly cost nothing. Every competitor pays for encoding; you don't.

---

## The one honest tension

"Free forever" and "hosted public links" cannot both be true indefinitely. Serving other
people's images has a marginal cost. Phase 1 is genuinely free forever because the user
supplies the hosting. Phase 2 is free up to a stated ceiling and then isn't.

So the plan is: stay in Phase 0/1 as long as users will tolerate it, use that time to find
out whether anyone will pay, and only take on a variable cost once there's revenue to
cover it.
