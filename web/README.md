# GuideGen — web app

Static HTML plus the Firebase CDN SDK. **No build step**, so Vercel serves these
files as-is. Set the Vercel project's **Root Directory** to `web`.

## Pages
| File | Route |
|---|---|
| `index.html` | `/` — landing page |
| `app.html` | `/app` — dashboard (auth-gated) |
| `g.html` | `/g/{id}` — public guide viewer |
| `privacy.html` | `/privacy` |
| `terms.html` | `/terms` |

## vercel.json note

Right now `X-Robots-Tag: noindex` is applied to **every** route, so nothing gets
indexed before launch. When you're ready for the landing page to appear in Google,
narrow that rule to `/g/(.*)` only — guide pages must stay `noindex` permanently,
because users publish internal SOPs through them.
