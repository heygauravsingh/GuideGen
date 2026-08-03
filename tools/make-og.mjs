/* Generates the Open Graph banners: web/og.png and web/og-guide.png, 1200x630.
 *
 * `node tools/make-og.mjs`  writes them
 * `node tools/make-og.mjs --check`  fails if either is missing (see below)
 *
 * **Why headless Chrome and not the hand-rolled PNG writer in make-icons.mjs.**
 * That script draws shapes, and shapes are all an icon is. A banner is mostly
 * *type* — a headline, a subhead, a mocked-up step card — and rendering text
 * without a font rasteriser means shipping a bitmap font, which is a worse
 * dependency than a browser everyone building this already has. So the design
 * lives in HTML/CSS below and Chrome screenshots it. No npm packages either way,
 * which is the rule that actually matters here.
 *
 * **Why the image is committed rather than generated per request.** A link
 * preview is fetched by WhatsApp, Slack and the rest within a second of the
 * message being sent, from servers with no interest in waiting for a cold
 * function. A static PNG on the CDN is the only version of this that is reliably
 * *there*. It also means the preview cannot leak: it is a product banner, drawn
 * from nothing, so a shared guide's screenshots never reach a third party's
 * preview cache.
 *
 * **--check only asserts existence, not bytes.** Chrome's text rasterisation
 * varies with version and installed fonts, so a byte comparison would fail on a
 * machine that is not this one — unlike make-icons.mjs, where the generator owns
 * every pixel and `--check` can be exact. Existence is what the build step needs:
 * an OG tag pointing at a missing file is a broken preview everywhere.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = [
  { file: "og.png", kind: "product" },
  { file: "og-guide.png", kind: "guide" },
  // The house banner. Sells the *house*, not one tool: the promise every tool shares.
  { file: "og-house.png", kind: "house" },
];

if (process.argv.includes("--check")) {
  const missing = OUT.filter((o) => !existsSync(join(ROOT, "web", o.file)));
  if (missing.length) {
    console.error("missing OG banner(s): " + missing.map((m) => m.file).join(", ") +
                  " — run `node tools/make-og.mjs`");
    process.exit(1);
  }
  console.log("OG banners present");
  process.exit(0);
}

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
].find(existsSync);
if (!CHROME) {
  console.error("No Chrome/Chromium/Edge found to render with. Install one, or hand-edit web/og.png.");
  process.exit(1);
}

/* The design, and the reasoning behind it:
 *
 * - **Ink & Paper, not a gradient.** The palette is the product's, so the preview
 *   and the page a click later look like the same thing. A saturated gradient
 *   banner is the single most common "generated" tell.
 * - **The headline is the promise, not the name.** Nobody shares a link because a
 *   tool exists; the pitch is what the recipient gets. The product name is the
 *   small line, and the ochre mark carries the identity.
 * - **A mocked step card, drawn in CSS.** A real screenshot would be someone's
 *   dashboard — the one thing that must never end up in a preview cache — and a
 *   generic stock UI reads as filler. Three numbered lines and a masked cURL row
 *   say what this makes without showing anyone's data.
 * - **Nothing near the edges.** Every platform crops this differently; the safe
 *   area is roughly the middle 90%, so the frame carries only background.
 */
function html(kind) {
  const guide = kind === "guide";
  const house = kind === "house";
  const eyebrow = house
    ? "One tool at a time"
    : guide ? "Someone shared a guide with you" : "Do it once. Hand it over.";
  const head = house
    ? "Small tools for<br />the daily mess."
    : guide
      ? "A step-by-step guide,<br />recorded in one pass."
      : "Turn any workflow into<br />steps an AI can act on.";
  const sub = house
    ? "They run on your own machine. Nothing uploaded, nothing to sign up for, no dashboard to check."
    : guide
      ? "Screenshots, written steps, and the exact requests the page made — captured while someone just did the work."
      : "Record a browser workflow once. Get a handoff for an assistant, or a document for a person.";
  return `<!doctype html><meta charset="utf-8" />
<style>
  @font-face { font-family: x; src: local("Inter"); }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1200px; height: 630px; }
  body {
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    color: #1a1713; background: #fbfaf7;
    display: grid; grid-template-columns: 1fr 430px; gap: 44px;
    padding: 68px 72px; -webkit-font-smoothing: antialiased;
  }
  /* One warm wash off the top-right, at 6% — enough to stop the paper reading as
     plain white in a dark chat client, not enough to become a gradient banner. */
  body::before {
    content: ""; position: fixed; inset: 0;
    background: radial-gradient(900px 520px at 96% -8%, rgba(194,65,12,.10), transparent 70%);
  }
  .l { position: relative; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 13px; }
  .mark {
    width: 46px; height: 46px; border-radius: 13px; background: #1a1713; color: #fbfaf7;
    display: grid; place-items: center;
  }
  .mark svg { width: 26px; height: 26px; }
  .brand b { font-size: 27px; font-weight: 680; letter-spacing: -.02em; }
  .eyebrow {
    margin-top: 46px; font-size: 19px; font-weight: 650; letter-spacing: .06em;
    text-transform: uppercase; color: #9e340a;
  }
  h1 {
    margin-top: 16px; font-size: 57px; line-height: 1.08; font-weight: 700;
    letter-spacing: -.03em;
  }
  p.sub { margin-top: 22px; font-size: 22.5px; line-height: 1.45; color: #443c31; max-width: 600px; }
  .foot { margin-top: auto; display: flex; align-items: center; gap: 14px; font-size: 19px; color: #6f675b; }
  .pill {
    padding: 8px 16px; border-radius: 999px; background: #f6ece2; color: #9e340a;
    font-weight: 650; font-size: 18px;
  }
  /* The mock. A card, three steps, and one failed request — the two things the
     product does, in the smallest form that still reads at preview size. */
  .r { position: relative; }
  .card {
    background: #fff; border: 1px solid #e5dfd2; border-radius: 20px;
    box-shadow: 0 22px 60px rgba(26,23,19,.14); padding: 26px 26px 22px; height: 100%;
    display: flex; flex-direction: column; gap: 18px;
  }
  .shot { border-radius: 12px; background: #f4f1ea; border: 1px solid #e5dfd2; height: 150px; position: relative; overflow: hidden; }
  .shot .bar { position: absolute; left: 0; right: 0; top: 0; height: 26px; background: #ece7dd; }
  .shot .row2 { position: absolute; left: 16px; top: 46px; width: 150px; height: 9px; border-radius: 5px; background: #ddd6c8; }
  .shot .row3 { position: absolute; left: 16px; top: 66px; width: 104px; height: 9px; border-radius: 5px; background: #e4ddd0; }
  .shot .tgt {
    position: absolute; right: 26px; top: 84px; width: 128px; height: 38px; border-radius: 9px;
    background: #fff; border: 3px solid #c2410c; box-shadow: 0 0 0 6px rgba(194,65,12,.16);
  }
  .shot .badge {
    position: absolute; right: 162px; top: 90px; width: 27px; height: 27px; border-radius: 999px;
    background: #c2410c; color: #fffdfa; font-size: 15px; font-weight: 700;
    display: grid; place-items: center;
  }
  .steps { display: flex; flex-direction: column; gap: 11px; }
  .step { display: flex; gap: 12px; align-items: center; font-size: 18px; color: #443c31; }
  .step i {
    flex: none; width: 25px; height: 25px; border-radius: 999px; background: #f6ece2; color: #9e340a;
    font-style: normal; font-size: 14px; font-weight: 700; display: grid; place-items: center;
  }
  .net {
    margin-top: auto; border-left: 3px solid #c2410c; background: #f4f1ea; border-radius: 0 10px 10px 0;
    padding: 11px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14.5px; color: #443c31; line-height: 1.6;
  }
  .net b { color: #9e340a; }
</style>
<div class="l">
  <div class="brand">
    <span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
      stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M4 12h16M4 18h7"/></svg></span>
    <b>${house ? "Backpocket" : "GuideGen"}</b>
  </div>
  <div class="eyebrow">${eyebrow}</div>
  <h1>${head}</h1>
  <p class="sub">${sub}</p>
  <div class="foot"><span class="pill">${house ? "Built in the open" : "Free early access"}</span><span>${house ? "backpocket.website" : "guidegen.backpocket.website"}</span></div>
</div>
<div class="r">
  <div class="card">
    <div class="shot">
      <div class="bar"></div><div class="row2"></div><div class="row3"></div>
      <div class="badge">3</div><div class="tgt"></div>
    </div>
    <div class="steps">
      <div class="step"><i>1</i>Click "Rider Management"</div>
      <div class="step"><i>2</i>Type "Demo" in the Search field</div>
      <div class="step"><i>3</i>Click "Save"</div>
    </div>
    <div class="net">POST /api/orders → <b>500</b><br />authorization: …masked…</div>
  </div>
</div>`;
}

const tmp = mkdtempSync(join(tmpdir(), "gg-og-"));
try {
  for (const { file, kind } of OUT) {
    const page = join(tmp, kind + ".html");
    writeFileSync(page, html(kind));
    const shot = join(tmp, file);
    execFileSync(CHROME, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars",
      // 1200x630 is the size every platform crops from; 2x would be sharper and
      // is not worth ~4x the bytes on an image nobody zooms into.
      "--window-size=1200,630", "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      "--screenshot=" + shot, "file://" + page,
    ], { stdio: "ignore" });
    copyFileSync(shot, join(ROOT, "web", file));
    console.log("wrote web/" + file, "(" + Math.round(statSync(join(ROOT, "web", file)).size / 1024) + "KB)");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
