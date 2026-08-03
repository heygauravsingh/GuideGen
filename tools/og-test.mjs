// Drives the real web/api/og.js with a stubbed fetch.
//
// A link preview is read by strangers in a work channel, so the weight here is on
// what must never appear in one:
//
//   * an unpublished guide's title (the rules answer the read, and this asserts we
//     honour the answer rather than rendering whatever came back);
//   * unescaped title text, which in an og:title attribute is an injection;
//   * a step image — the preview image is always the committed banner, never
//     anything from the guide, because a preview cache is a third party's disk.
//
// And on degrading rather than failing: Firestore down, slow, or answering
// nonsense all have to produce the generic preview, because the alternative is a
// share link that unfurls as an error.
//
// `node tools/og-test.mjs`
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const handler = require(ROOT + "/web/api/og.js");

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}

function serve(url, fetchImpl) {
  globalThis.fetch = fetchImpl || (async () => { throw new Error("no fetch expected"); });
  return new Promise((done) => {
    const headers = {};
    const res = {
      statusCode: 0,
      setHeader(k, v) { headers[k] = v; },
      end(body) {
        done({
          body,
          headers,
          status: res.statusCode,
          title: (body.match(/<title>([\s\S]*?)<\/title>/) || [])[1],
          ogTitle: (body.match(/og:title" content="([\s\S]*?)"/) || [])[1],
          ogDesc: (body.match(/og:description" content="([\s\S]*?)"/) || [])[1],
          ogImage: (body.match(/og:image" content="([\s\S]*?)"/) || [])[1],
          ogUrl: (body.match(/og:url" content="([\s\S]*?)"/) || [])[1],
        });
      },
    };
    handler({ url, headers: { host: "guide-gen.vercel.app" } }, res);
  });
}

const doc = (fields) => async () => ({ ok: true, json: async () => ({ fields }) });
const published = (title, steps) => doc({
  visibility: { stringValue: "link" },
  title: { stringValue: title },
  stepCount: { integerValue: String(steps) },
});

// ---------------------------------------------------------------------------
console.log("\n=== 1. a published guide gets its own title ===");
{
  const r = await serve("/api/og?id=aBc123_-x", published("How to refund an order", 9));
  check("status", r.status, 200);
  check("the title is the guide's", r.ogTitle, "How to refund an order · GuideGen");
  check("the step count leads the pitch",
        r.ogDesc.startsWith("9 steps. Made with GuideGen"), true);
  check("og:url is the share link, not the function", r.ogUrl,
        "https://guide-gen.vercel.app/g/aBc123_-x");
  check("the image is the committed banner", r.ogImage,
        "https://guide-gen.vercel.app/og-guide.png");
  check("large-image card, or the banner is a thumbnail",
        /name="twitter:card" content="summary_large_image"/.test(r.body), true);
  check("still noindex — a shared SOP's title has no business in a search index",
        /noindex/.test(r.body) && r.headers["X-Robots-Tag"].includes("noindex"), true);
  check("one step reads as one step",
        (await serve("/api/og?id=aBc123_-x", published("x", 1))).ogDesc.startsWith("1 step. "), true);
}

// ---------------------------------------------------------------------------
console.log("\n=== 2. what never reaches a preview ===");
{
  // The Firestore rules only answer a read once visibility == 'link'. This asserts
  // the second half of that: given an answer we shouldn't render, we don't.
  const r = await serve("/api/og?id=aBc123_-x", doc({
    visibility: { stringValue: "private" },
    title: { stringValue: "Q3 layoff process" },
  }));
  check("an unpublished guide's title is not rendered", /Q3 layoff/.test(r.body), false);
  check("it degrades to the generic preview", r.ogTitle, "A step-by-step guide · GuideGen");

  const x = await serve("/api/og?id=aBc123_-x",
                        published('Fix "orders" <b>now</b> & later', 3));
  check("a title with markup in it is escaped", x.ogTitle,
        "Fix &quot;orders&quot; &lt;b&gt;now&lt;/b&gt; &amp; later · GuideGen");
  check("nothing unescaped survives anywhere in the page",
        /<b>|"orders"/.test(x.body), false);
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. it degrades, it never fails ===");
{
  const cases = [
    ["Firestore is down", async () => { throw new Error("ECONNREFUSED"); }],
    ["Firestore says no", async () => ({ ok: false, json: async () => ({}) })],
    ["the document is nonsense", doc({ visibility: { stringValue: "link" } })],
    ["the body is not JSON", async () => ({ ok: true, json: async () => { throw new Error("bad json"); } })],
  ];
  for (const [name, f] of cases) {
    const r = await serve("/api/og?id=aBc123_-x", f);
    check(name + " → generic preview, status 200",
          [r.status, r.ogTitle], [200, "A step-by-step guide · GuideGen"]);
  }
  // A malformed id is refused before the network, so a crawler poking at the route
  // cannot make us issue reads.
  let reads = 0;
  const counted = async () => { reads++; return { ok: false, json: async () => ({}) }; };
  await serve("/api/og?id=%3Cscript%3E", counted);
  await serve("/api/og?id=short", counted);
  await serve("/api/og", counted);
  check("a malformed or missing id never reaches Firestore", reads, 0);
}

console.log(failures ? `\n${failures} failed\n` : "\nall passed\n");
process.exit(failures ? 1 : 0);
