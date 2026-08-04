# GuideGen — web app

Static HTML plus the Firebase CDN SDK. **No build step**, so Vercel serves these
files as-is. Set the Vercel project's **Root Directory** to `web`.

## Pages
| File | Route |
|---|---|
| `index.html` | `/` — landing page |
| `app.html` | `/app` — dashboard (auth-gated), email/password over Firebase REST |
| `g.html` | `/g/{id}` — public guide viewer |
| `privacy.html` | `/privacy` |
| `terms.html` | `/terms` |

## assets/gg.js

Auth and Firestore access over **REST**, no Firebase SDK — the site loads nothing from
an external host and every call is reproducible with curl. Sessions live in
`localStorage`; `getToken()` refreshes an expired id token transparently and signs the
user out if the refresh token is dead.

`listGuides()` deliberately has no `orderBy`: pairing an equality filter with an orderBy
on another field would need a composite Firestore index, so it sorts client-side instead.

## vercel.json note

Right now `X-Robots-Tag: noindex` is applied to **every** route, so nothing gets
indexed before launch. When you're ready for the landing page to appear in Google,
narrow that rule to `/g/(.*)` only — guide pages must stay `noindex` permanently,
because users publish internal SOPs through them.

## assets/demo.js — the try-it demo, above the FAQ

A pretend admin panel; click it and a guide writes itself beside it, ending on "Copy it
for an AI". It arrived from the house page (`backpocket.website`) on 4 Aug 2026 — it
advertises this product, and the house advertises the house. Its rules, all of which exist
because each was a bug first:

- **Typing is one step per burst**, using the same 650ms settle as `recorder.js`. One step
  per keystroke is not a guide, it is a keylogger transcript.
- **A pending typing burst is flushed before a click is recorded.** Steps append in arrival
  order, so left to its own timer `Type "demo"` lands *after* the click it caused and the
  guide reads as though the result was clicked before it was searched for. The real recorder
  flushes on pointerdown for exactly this reason.
- **A checkbox is recorded on `change`, never on `click`.** Clicking a `<label>` toggles the
  inner input, which fires a second bubbling click, and every checkbox step appeared twice.
- **Step text carries the row it acted on** — `Click "View KYC" on "Rider #104112"`. Two
  identical buttons on two rows produced two identical steps and an unusable guide.
- **Consecutive identical clicks merge**, like `mergeRedundant`: "Click Payouts. Click
  Payouts." reads as broken.
- **The step pictures are DOM clones of the mock, not captures**, scaled with `zoom` — a
  `transform` keeps the element's original box and leaves a hole under it. Honest by
  construction: it is our own markup, and a real capture would need permissions no landing
  page should ask for. The copy under the demo says outright that nothing is recorded.

## /inbox — the owner's view of every submission

Every form in the house writes to **one** Firestore collection, `waitlist`, in this project,
and `note` carries a prefix so they can be told apart:

| `note` starts with | Came from |
|---|---|
| `hi:` | a Say Hi message on `backpocket.website/#say-hi` (may also carry `shots`) |
| `rain:` | a Make it rain competition answer |
| `vote:` | a "build this next" vote |
| anything else | an email signup (`landing`, `house`) |

`/inbox` lists them newest first with tabs per kind, thumbnails for any attached screenshots,
and a button that copies the addresses of whatever tab is showing. It needs a signed-in
session, which it borrows from `/app` rather than duplicating the auth UI.

**Access is the rule, not the page.** `firebase/firestore.rules` allows read only for the
owner's verified token email; the page is public and comes back empty-handed for anyone else.
Never widen that rule to unblock someone — being locked out is the feature. Every size cap on
a submission is in the rules too, because a form can be bypassed with one curl.
