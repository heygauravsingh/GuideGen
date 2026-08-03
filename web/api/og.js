// GET /api/og?id=<guideId>  → a meta-only HTML page for link-preview crawlers
//
// **What this is for.** A shared guide link is the product's only viral surface:
// someone pastes /g/<id> into a work chat and everyone in the channel sees the
// unfurl. Statically that unfurl said "A GuideGen guide" for every guide ever
// shared, which tells a reader nothing and gives them no reason to click. The
// guide's own title, its step count, and a banner is a different message.
//
// **Why a crawler-only route.** vercel.json sends /g/:id here *only* when the
// user-agent matches a known preview bot; a human still gets the static g.html
// with no function in the path. That is deliberate and worth keeping: if this
// file throws, breaks, or times out, the consequence is a plain preview — never a
// guide that won't open. The blast radius of the viral feature must not include
// the thing it is advertising.
//
// **Why the image is static.** web/og-guide.png is committed (tools/make-og.mjs)
// and served from the CDN. Two reasons: a preview bot fetches within a second of
// the message being sent and will not wait for a cold function, and a per-guide
// image would mean rendering *the user's screenshots* into something a third
// party caches forever. The banner is drawn from nothing, so a shared guide's
// contents never reach WhatsApp's or Slack's preview cache — only its title,
// which is the one field the sender chose to name it.
//
// **Titles of unpublished guides are unreachable here.** The Firestore read is
// unauthenticated, exactly as the viewer's is, so the rules answer it: a document
// is readable only once visibility == 'link'. A guessed or unpublished id gets the
// generic preview, not a 403 leak.
//
// Keep the noindex meta. Preview bots ignore it (which is why previews work at
// all), search crawlers honour it, and a shared internal SOP's title has no
// business in a search index.

const PROJECT = "guidegen-1f938";
const FIREBASE_API_KEY = "AIzaSyCihDiLQ51V0C8DS07WTl70FOpC3ACkfJY"; // public by design
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const SITE = "GuideGen";
// The pitch, aimed at the recipient rather than at the sender. It appears under
// the title in every unfurl, so it is the one line that has to make a stranger
// curious about the tool rather than only about the guide.
const PITCH =
  "Made with GuideGen — record a workflow once and get the steps back automatically, " +
  "as a guide for a person or a handoff for an AI.";

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Firestore REST wraps every value in a type tag. Only two fields are read here,
// so this stays a couple of lines rather than importing a decoder.
function str(fields, key) {
  const f = fields && fields[key];
  return f && typeof f.stringValue === "string" ? f.stringValue : "";
}
function int(fields, key) {
  const f = fields && fields[key];
  const n = f ? Number(f.integerValue != null ? f.integerValue : f.doubleValue) : NaN;
  return Number.isFinite(n) ? n : 0;
}

async function guideMeta(id) {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id || "")) return null;
  const r = await fetch(`${FS}/guides/${encodeURIComponent(id)}?key=${FIREBASE_API_KEY}`, {
    // A preview bot has already started counting. Better a generic unfurl than a
    // slow one that times out and shows nothing at all.
    signal: AbortSignal.timeout(2500),
  });
  if (!r.ok) return null;
  const doc = await r.json();
  const f = doc.fields || {};
  if (str(f, "visibility") !== "link") return null;
  const title = str(f, "title").trim();
  return { title: title || "", steps: int(f, "stepCount") };
}

module.exports = async (req, res) => {
  const origin = "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "guide-gen.vercel.app");
  let id = "";
  try {
    const u = new URL(req.url, origin);
    id = u.searchParams.get("id") || (u.pathname.match(/\/g\/([A-Za-z0-9_-]+)/) || [])[1] || "";
  } catch (e) { /* fall through to the generic preview */ }

  let meta = null;
  try {
    meta = await guideMeta(id);
  } catch (e) {
    meta = null; // unreachable Firestore, a timeout, a malformed doc — all the same here
  }

  const title = meta && meta.title
    ? meta.title + " · " + SITE
    : "A step-by-step guide · " + SITE;
  const desc = meta && meta.steps
    ? meta.steps + (meta.steps === 1 ? " step. " : " steps. ") + PITCH
    : PITCH;
  const url = id ? origin + "/g/" + encodeURIComponent(id) : origin + "/";
  const img = origin + "/og-guide.png";

  const body = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow, noarchive" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta property="og:site_name" content="${SITE}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${esc(url)}" />
<meta property="og:image" content="${esc(img)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="GuideGen — a recorded workflow turned into numbered steps" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${esc(img)}" />
<link rel="canonical" href="${esc(url)}" />
</head><body>
<p><a href="${esc(url)}">Open this guide</a> — made with <a href="${origin}/">GuideGen</a>.</p>
</body></html>`;

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Preview bots re-fetch aggressively when a link is pasted repeatedly; let the
  // CDN answer those. Short enough that renaming a guide fixes its unfurl soon.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=600");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.end(body);
};
