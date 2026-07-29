# FlowScribe — build plan under real constraints

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

- [x] Extension is feature-complete and packaged (`../flowscribe-build.zip`)
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
