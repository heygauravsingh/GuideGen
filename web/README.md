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
