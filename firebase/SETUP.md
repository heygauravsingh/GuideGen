# Firebase setup — click-by-click

Do these in order. Where something is easy to get wrong, it says so.
Nothing here costs money; the Spark plan needs no payment method.

---

## Before you start: pick the name

The project name becomes the project ID, and the project ID appears inside your
**image URLs** — which are visible to anyone you share a guide with:

```
https://firebasestorage.googleapis.com/v0/b/<project-id>.appspot.com/...
```

So this is a user-visible naming decision, not an internal one. If you're still
undecided, choose something neutral you won't mind living with.

---

## 1. Create the project

1. Go to <https://console.firebase.google.com>
2. **Create a project**
3. Enter the project name
4. **Google Analytics: turn it OFF**

   Not needed, and it would add a data-collection surface you'd then have to
   disclose in the Chrome Web Store privacy declaration. Keep the declaration
   honest and minimal.
5. Create, and wait for provisioning

---

## 2. Register the web app

1. On **Project Overview**, click the **`</>`** (web) icon
2. App nickname: anything, e.g. `web`
3. **Do NOT tick "Also set up Firebase Hosting"** — we're hosting on Vercel.
   Firebase Hosting's free tier is only 360 MB/day of transfer, which is why
   we're not using it.
4. Register app
5. You'll be shown a `firebaseConfig` object. **Copy the whole thing** and paste
   it to me.

That config is public by design — the `apiKey` is an identifier, not a secret.
Security comes from the rules in this folder. Don't worry about it being in the
repo.

---

## 3. Enable Email/Password auth

1. **Build → Authentication → Get started**
2. **Sign-in method** tab → **Email/Password** → **Enable** → Save
3. Leave "Email link (passwordless sign-in)" off

Google sign-in comes later. It needs an OAuth client tied to your *published*
extension ID, which the store hasn't issued yet. Email/password works over plain
REST today with nothing pre-provisioned.

---

## 4. Create Firestore

1. **Build → Firestore Database → Create database**
2. **Start in production mode** — this denies everything until we publish rules.
   Do not pick test mode; test mode is open to the world.
3. **Location: choose carefully — this cannot be changed later.**
   For users in India, `asia-south1` (Mumbai) is the right choice.
4. Create
5. Go to the **Rules** tab, replace everything with the contents of
   `firebase/firestore.rules`, and **Publish**

---

## 5. Screenshots go to Cloudinary, NOT Firebase Storage

**Confirmed on 29 July 2026: Firebase Cloud Storage now requires the Blaze plan
on new projects.** The Firebase pricing page still describes it under Spark; the
console is the authority and the console says upgrade. So we don't use it.

**Do not click "Upgrade project".** Blaze needs a card on file. At your scale it
would very likely bill $0, but "no card" was the constraint, so we route around it.

Screenshots go to Cloudinary's free tier instead — 25 monthly credits, no credit
card, and it was already the designated fallback.

### 5a. Create the Cloudinary account

1. Sign up at <https://cloudinary.com> (free, no card)
2. From the dashboard, note your **Cloud name**

### 5b. Create an unsigned upload preset

This is what lets the extension upload directly with no backend.

1. **Settings (gear) → Upload → Upload presets → Add upload preset**
2. **Signing Mode: Unsigned**
3. **Folder:** `guidegen` — confines everything to one folder
4. **Allowed formats:** `webp,png,jpg` — images only
5. **Max file size:** 5000000 (5 MB)
6. Save, and note the **preset name**

### 5c. Understand what unsigned means

Anyone who reads your extension's source can find the cloud name and preset name
and upload to your account. Two things about that:

- **The blast radius is your free credits, not your users' data.** Nobody can
  read, list or delete anything with an upload preset.
- **The failure mode is uploads stopping**, which is an availability problem, not
  a breach.

**Account isolation.** As of setup, cloud `dqrytwq5e` is shared with an unrelated
project (~170 MB, 0.16/25 credits — effectively dormant). Sharing is fine on those
numbers, but it couples the two: abuse of the unsigned preset, or a Cloudinary
suspension, would hit both. A separate free account on a different email gives a
separate 25-credit pool and removes the coupling.

Migrating later is cheap — the cloud name and preset live in one config spot, and
existing guides keep working because their image URLs are absolute. Only new
uploads move.

At day-one obscurity the risk is close to nil. The proper fix is signed uploads:
a ~25-line Vercel function that validates the caller's Firebase token and returns
a Cloudinary signature, keeping the API secret server-side. That's a same-week
change, not a redesign — it's one function plus one line in the extension.

Tell me if you'd rather do signed from the start; it costs maybe 30 extra minutes
today.

### 5c-verified. Tested against cloud `dqrytwq5e` / preset `GuideGen_Unsigned` (29 Jul 2026)

Actually exercised with curl, not assumed:

| Test | Result |
|---|---|
| Unsigned upload | Works. `asset_folder: GuideGen` applied by the preset |
| Generated `public_id` | Random 20 chars, e.g. `iarmn49yo7ahee1durlv` — unguessable |
| Delivery URL | **Flat, no folder in the path**: `/image/upload/v<ver>/<public_id>.png` |
| `tags` on upload | Allowed |
| `context` key/values | Allowed |
| Non-image file | Rejected — "Invalid image file" |
| WebP | Accepted |
| Caller-supplied `public_id` | **Allowed** — see the warning below |

**Four rules that follow from this:**

1. **Never send `public_id` from our code.** Let Cloudinary generate it. The random
   ID is what makes an image URL unguessable, which is the whole privacy model —
   a predictable path would undo the Firestore gating.

2. **Always send tags:** `uid_<uid>` and `guide_<guideId>`. Verified working. This is
   the only way to find and delete one user's images later via the Admin API
   (`DELETE /resources/image/tags/<tag>`), which you will need the first time
   someone asks you to delete their data.

3. **`Overwrite: false` in the preset is load-bearing security — do not change it.**
   A caller *can* choose their own `public_id`. With overwrite off that's harmless
   (an existing asset is returned, not replaced). Flip it to `true` and anyone who
   learns a guide's image ID could replace that image with arbitrary content on your
   users' shared pages.

4. **Store the full `secure_url` in Firestore.** The folder doesn't appear in the
   delivery URL, so the URL can't be reconstructed from parts.

**Cleanup:** verification left four test assets in the `GuideGen` folder —
`iarmn49yo7ahee1durlv`, `bvx8cfqu8ams0fzxh118`, `attacker_chosen_name`, and a 1x1
webp. Delete them from Media Library when convenient; unsigned uploads can't be
deleted without the API secret, which is why they're still there.

### 5d. Why we still convert to WebP in the extension

Cloudinary can optimise on delivery with `f_auto,q_auto,w_1600` — but **each
derived image counts against your transformation credits** (1 credit per 1,000).
2,500 guides x 8 images would be ~20 of your 25 monthly credits spent on
transformations alone.

So we upload already-optimised WebP at a capped width and serve the original
untransformed. That spends zero transformation credits, and it's the same
`background.js` change that was already on the list.

## 6. After Vercel is deployed — authorized domains

Auth silently fails on any domain not in this list. This is the step people miss
and then spend an hour debugging.

1. **Authentication → Settings → Authorized domains**
2. **Add domain** → your production Vercel URL (e.g. `yourapp.vercel.app`)

`localhost` is already there by default.

Note: Vercel gives **preview deployments their own URLs**, so sign-in won't work
on a preview branch unless you add that URL too. Test auth on production.

---

## 7. Send me these four things

1. The `firebaseConfig` object from step 2
2. Which Firestore region you chose
3. Confirmation that Email/Password is enabled
4. Your Cloudinary **cloud name** and **upload preset name**

With the config I can verify the whole chain with curl before writing any
extension code — sign up a test user, write a guide document, upload an image,
then try to read it back as an anonymous stranger to prove the rules actually
block what they should.

---

## What we are deliberately not doing

- **No Google Analytics** — keeps the privacy declaration clean
- **No Firebase Hosting** — 360 MB/day is too small; Vercel gives 100 GB/month
- **No Firebase Cloud Storage** — requires Blaze on new projects; Cloudinary instead
- **No Firebase SDK in the extension** — it expects a bundler, and this project
  has no build step. The extension talks to Firebase over REST with plain
  `fetch`, which needs no new permissions because `<all_urls>` is already in the
  manifest.
