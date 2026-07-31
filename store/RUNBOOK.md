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
cd "/Users/apple/Desktop/FlowScribe 2" && node tools/sync-web-assets.mjs --check && node tools/make-icons.mjs --check && node tools/set-extension-key.mjs --check
```

A stale renderer mirror keeps the site working while rendering last week's annotations.
A stale icon doesn't show up in a grep for a hex value at all — which is exactly how the
purple bullseye survived the repalette. A missing `key` doesn't show up anywhere until a
tester's Google sign-in fails on their machine and works on yours.

Then build **both packages**, with one command. They contain exactly the same files and
differ only in layout:

| File | Layout | Goes to |
|---|---|---|
| `../GuideGen-Prod.zip` | flat — `manifest.json` at the archive root | the store |
| `../GuideGen-Beta.zip` | wrapped — everything inside `guidegen/` | Google Drive, for `/install` |

```bash
cd "/Users/apple/Desktop/FlowScribe 2" && FILES=(manifest.json background.js recorder.js recorder.css popup.html popup.js sync.js editor.html redirect.js offscreen.html offscreen.js render.js exporters.js tts.js icons lib) && rm -f ../GuideGen-Prod.zip && zip -r -q -X ../GuideGen-Prod.zip "${FILES[@]}" -x "*.DS_Store" -x "*.map" && rm -rf /tmp/gg-stage && mkdir -p /tmp/gg-stage/guidegen && for f in "${FILES[@]}"; do cp -R "$f" /tmp/gg-stage/guidegen/; done && find /tmp/gg-stage -name ".DS_Store" -delete && find /tmp/gg-stage -name "*.map" -delete && (cd /tmp/gg-stage && zip -r -q -X /tmp/GuideGen-Beta.zip guidegen) && mv -f /tmp/GuideGen-Beta.zip ../GuideGen-Beta.zip && rm -rf /tmp/gg-stage && ls -lh ../GuideGen-*.zip
```

`FILES` is a **zsh array**, and the `"${FILES[@]}"` expansions matter: zsh does not
word-split an unquoted plain variable, so `zip … $FILES` gets one long argument and exits
with `zip error: Nothing to do!`.

Prod is flat because the store requires `manifest.json` at the archive root. Beta wraps
everything in `guidegen/` so a tester who double-clicks gets one folder to point Chrome at,
rather than fifteen loose files in their Downloads. `guidegen/` being the archive's only
top-level entry is what stops it double-nesting into `GuideGen-Beta/guidegen/`, and it is
the folder name `/install` step 1 promises — rename it and that instruction goes stale.

**Build and ship both, every time.** The names are ours and mean nothing to Google; the only
difference is the layout. Two artifacts mean two things to remember, and on 31 Jul that cost
exactly one: the Google sign-in fix reached the store zip while Drive still served the
broken build, so a tester downloading in that window would have hit a sign-in that silently
did nothing. Verify with the check at the end of this step before either upload.

The file list changed for v1.1, in both directions:
- **added** `sync.js` (the account session — v1.0 shipped without it, which is why the
  reviewed build had no sync at all), `offscreen.html` + `offscreen.js` (the narrated
  video renderer), `redirect.js`
- **removed** `editor.js` and `editor.css` — the editor moved to the website. `editor.html`
  stays, as a redirect for v1.0 bookmarks.

`CLAUDE.md`, `README.md`, `PLAN.md`, `tools/` and `web/` are all deliberately excluded.
The first three describe the project as a "replica of Scribe Capture", which should not be
sitting inside a package a reviewer can open; the last two aren't part of the extension.

**Check both packages before uploading either.** This catches the layout being wrong for its
destination, a stale build, and a missing or wrong `key` — none of which are visible from the
file listing:

```bash
cd "/Users/apple/Desktop/FlowScribe 2" && node -e '
const {execSync}=require("child_process");const {createHash}=require("crypto");
const id=k=>createHash("sha256").update(Buffer.from(k,"base64")).digest().subarray(0,16).reduce((s,x)=>s+String.fromCharCode(97+(x>>4))+String.fromCharCode(97+(x&15)),"");
for (const [z,mp,label] of [["../GuideGen-Prod.zip","manifest.json","PROD (store, flat)"],["../GuideGen-Beta.zip","guidegen/manifest.json","BETA (drive, wrapped)"]]) {
  const m=JSON.parse(execSync(`unzip -p "${z}" ${mp}`).toString());
  const list=execSync(`unzip -l "${z}"`).toString();
  console.log(label, "-> v"+m.version, "| perms", m.permissions.length,
              "| key", m.key?id(m.key):"NONE", "| wrapped", list.includes("guidegen/"));
}'
```

Expect both at the same version and permission count, both deriving
`dijeonandicniffeffbcolhfldommhnp`, and `wrapped` **false for Prod, true for Beta**.

---

## Step 2b — early-access distribution over Google Drive

While the store review is pending, `/install` on the site hands testers the same ZIP that
gets submitted. **It is hosted on Google Drive, not on Vercel, and that is deliberate:**
`.vercelignore` exists to stop `lib/` being served, and a 68MB archive of exactly that would
reintroduce the problem it was written to prevent — plus 68MB committed to git forever, in
every clone, since the site has no build step and the file would have to be checked in.

**Drive gets `GuideGen-Beta.zip`, the store gets `GuideGen-Prod.zip`** — same contents, and
the wrapped layout is the whole reason there are two. A tester unzipping a flat archive gets
fifteen loose files in Downloads, and "pick the folder" then means nothing.

First time:

1. Build both — `Step 2` produces `../GuideGen-Prod.zip` and `../GuideGen-Beta.zip` (~68MB
   each), and run the verification at the end of that step.
2. Upload **`GuideGen-Beta.zip`** to Drive.
3. Share → **Anyone with the link** → **Viewer**. Without this, testers get a request-access
   screen instead of a download.
4. Copy the link and paste it into `web/install.html` — one line, near the top of the inline
   script at the bottom of the download card:

   ```js
   var DOWNLOAD_URL = "PASTE_GOOGLE_DRIVE_LINK_HERE";
   ```

   Until that's a real `https://` URL the page hides the button and shows "the download link is
   being set up, email me" instead. That's deliberate: the page is safe to have live before the
   link exists, and it can never ship with a button that 404s.

**Every time after that — do NOT upload a new file.** Right-click the existing file in Drive →
**Manage versions** → **Upload new version**. That keeps the same file id, so the link in
`install.html` never changes and you never have to remember to update the site. Uploading a
fresh file mints a new id, and the page then points at the old build with no error to tell you.

Two notes on the link itself:

- The plain share link (`/file/d/<id>/view`) opens Drive's preview page with a Download button.
  One extra click, but it always works and it shows the file size, which reads as more
  trustworthy than an unexplained 68MB binary starting to download.
- A direct download is `https://drive.usercontent.google.com/download?id=<id>&export=download`.
  Drive interposes a virus-scan warning above ~100MB; at 68MB it shouldn't, but that threshold
  is Google's to move, so the preview link is the safer default.

Delete `/install` and revert the landing-page CTAs once the store listing is public — the
callouts on that page are written on the assumption that it's temporary.

## Step 2c — Google sign-in: three console tasks

Code is done and hidden until configured. `GOOGLE_CLIENT_ID` sits in **two** places (the two
surfaces don't share a bundle): `web/assets/gg.js` and `sync.js`. Same value in both.

**1. Firebase Console → Authentication → Sign-in method → Google → Enable.**
Set the project support email while you're there; Google requires one.

**2. Firebase Console → Authentication → Settings → User account linking.**
✅ **Done 30 Jul 2026** — set to *Link accounts that use the same email*, which is right. The
alternative would give one person two accounts under one email address, each with its own guide
library and no way to merge them.

One consequence of that setting, handled in the copy rather than the console: linking works when
a *password* account meets Google, but not the other way round. Someone whose account is a
Google account who tries the password form gets `EMAIL_EXISTS` on signup and
`INVALID_LOGIN_CREDENTIALS` on sign-in — both dead ends unless the message names the way out.
All three of those errors now say "use Continue with Google instead".

**3. Pin the extension id.** ✅ **Done 31 Jul 2026** — `manifest.json` carries the store item's
public key, verified to derive `dijeonandicniffeffbcolhfldommhnp`. Nothing to do unless the
manifest's `key` goes missing; `node tools/set-extension-key.mjs --check` says so if it does.

Kept here because it explains why there are two redirect URIs below and not one per machine:

Chrome derives an unpacked extension's id from the **absolute path of the folder** it was loaded
from. Stable across reloads, different on every machine. So every tester's install has a
different id, and anything registered against an id — the OAuth redirect URI above all — would
work only for whoever registered it. Registering one per tester is not possible.

Fix: put the store item's public key in `manifest.json`. Chrome then derives the id from the key
instead of the path, and the unpacked build loads as `pifkel…` everywhere.

1. Web Store dashboard → your item → **Package** → **View public key**
2. Copy the whole PEM block, then:

```bash
cd "/Users/apple/Desktop/FlowScribe 2" && pbpaste | node tools/set-extension-key.mjs -
```

The script checks the key against the id the store already assigned and **refuses** if they
don't match — a key from the wrong item would give every install a third id and break the OAuth
redirect and the dashboard bridge at once. `--check` re-verifies later; it's in the build step.

**4. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID →
Web application.** One client, **two** redirect URIs now:

```
https://guide-gen.vercel.app/auth
https://dijeonandicniffeffbcolhfldommhnp.chromiumapp.org/
```

Then paste the client id into `web/assets/gg.js` and `sync.js` and deploy.

*If a store upload ever rejects the manifest over `key`:* it shouldn't, since the key is that
item's own, but if it does, strip `key` from `GuideGen-Prod.zip` only —
`GuideGen-Beta.zip` keeps it, and Beta is the one where the id matters, because only an
unpacked load derives its id from the key.

**OAuth consent screen.** Scopes are `openid email profile` — all non-sensitive, so **no Google
review is required**. But an unpublished consent screen stays in *Testing*, which only lets 100
named test users sign in. Hit **Publish app** or real users get "access blocked".

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

## Step 4 — the item

> **v1.0.0 was rejected on 30 Jul 2026.** Purple Potassium, *use of permissions* —
> "requesting but not using: downloads". Correctly: v1.0 saved exports by clicking an
> `<a download>` anchor and never called `chrome.downloads`. v1.1 uses it for the narrated
> video, which is rendered in an offscreen document that cannot save a file itself, so the
> finding is already remediated by the code. See the `downloads` justification in
> LISTING.md.
>
> Two things follow. First, **a rejection is against the draft, not the item** — the banner
> says "you may resubmit a new draft", and the item has no strike to escape. Second, a
> rejection follows the *code*: filing a fresh item without fixing the finding gets the same
> rejection, and repeatedly filing fresh items against an unresolved one reads as
> circumventing review, which escalates past rejection. Fix first, then choose the route.

Two valid routes. **Pick one before you touch the dashboard**, because the second one
changes the extension id and therefore changes code.

> **Route 4b was taken on 31 Jul 2026.** The live item is now
> `dijeonandicniffeffbcolhfldommhnp`; the rejected `pifkel…` item is superseded. 4a is kept
> below because it is the right route for every *subsequent* release — a new item per version
> is never correct once an item has users.

### 4a — new version of the existing item (less work)

For releases after the first: open the current item, id
`dijeonandicniffeffbcolhfldommhnp`, created 31 Jul 2026.

1. <https://chrome.google.com/webstore/devconsole> → open **that item**
2. **Package** → **Upload new package** → `GuideGen-Prod.zip`
3. Rewrite the listing and the privacy declarations for v1.1 (step 5). This is the real
   work either way: v1.0's declarations said the extension made no network requests.

Nothing in the repo changes. The version in `manifest.json` must exceed the published one
(1.1.0 > 1.0.0, fine).

### 4b — resubmit as a NEW item (chosen 31 Jul 2026)

Defensible when the product has changed enough that the old listing describes something
else: v1.1 moved the editor to the website, added an account, and added publishing, so
every privacy and connectivity answer is different. The cost is that the id moves, and the
id is pinned in code.

**The ordering is not negotiable.** The new item has no key until it has processed a
package, so there is a window where the manifest can only carry the *old* item's key —
and uploading that as a new item asks the store to mint a second item deriving an id it
has already assigned.

1. **Strip the key**, then build the store zip from that state:
   ```
   node tools/set-extension-key.mjs --remove
   ```
   Then the Step 2 build. Upload `GuideGen-Prod.zip` from that state — and do NOT ship the
   `GuideGen-Beta.zip` built alongside it, because without a key an unpacked id comes from
   the folder path and differs per machine.
2. **Add new item** → upload that zip → wait for processing.
3. Copy the new id from the item, and the new key from **Package → View public key**.
4. **Adopt it** — one command, and it verifies the key derives the id before writing
   anything:
   ```
   node tools/set-extension-key.mjs newkey.pem --id <new-32-char-id>
   ```
   Writes `manifest.json`'s key and rewrites the id in `tools/set-extension-key.mjs`,
   `web/assets/bridge.js`, `sync.js` and `web/assets/gg.js`. It prints the prose files it
   did *not* touch; fix those by hand.
5. **OAuth client** → Credentials → the Web application client → *Authorised redirect
   URIs* → add `https://<new-id>.chromiumapp.org/`. Keep the old one until every tester
   has upgraded, then remove it. Leave `/auth` alone; the site's URI doesn't move.
6. **Rebuild both zips** (Step 2) now that the new key is in the manifest, and
   **re-upload `GuideGen-Beta.zip` to Drive via Manage versions → Upload new version** so the
   `/install` link keeps working. A fresh Drive upload would change the file id and dead-link
   `web/install.html`.
7. **Deploy the site** — `bridge.js` and `gg.js` changed, so the dashboard is pointing at
   the old id until you do.
8. **Unpublish the old item** so there aren't two listings for one product. Everyone on the
   old build must reinstall; their local guides don't come with them, because a new id gets
   fresh `chrome.storage.local`. Publish anything worth keeping first.

Verify before submitting:
```
node tools/set-extension-key.mjs --check && node tools/sync-web-assets.mjs --check && node tools/make-icons.mjs --check
```

---

## Step 5 — fill in the three tabs

Open `store/LISTING.md` beside the dashboard and paste as you go.

**Store listing** — name, short description, detailed description, category
(Productivity → Workflow & Planning), language, and your five screenshots. The icon is
picked up from the manifest automatically. Promotional tiles are optional; skip them
today.

**Privacy practices** — this is where submissions get bounced, so don't rush it:
- Single purpose: paste from LISTING.md
- A justification for every permission: all **eight** plus the host permission, pasted from
  LISTING.md. Eight, not six — `offscreen` and `identity` arrived with v1.1.
- Data usage: tick the three certifications, **and tick the four data-collection categories
  listed in LISTING.md** — personally identifiable information, authentication information,
  website content, web history.
- Privacy policy URL: `https://guide-gen.vercel.app/privacy`

> The four ticks are the single most important difference from the v1.0 submission. v1.0 was
> reviewed with every box unchecked and that was *accurate* — it made no network requests at
> all. v1.1 has an account and publishes guides. Submitting it with the old declaration is a
> false one, which is a takedown rather than a rejection. LISTING.md carries the reasoning per
> category; read it there rather than guessing at the console.

**Distribution** — Free, all regions, and see the next step for visibility.

---

## Step 6 — choose visibility, then submit

Set visibility to **Unlisted** (or leave it there — it's where the item already is).

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
