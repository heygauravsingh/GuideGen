#!/usr/bin/env node
// render.js and exporters.js run in two places now: the extension (offscreen video
// renderer) and the website (dashboard editor + document exports). Two
// hand-maintained copies is exactly how the last drift bug happened, so the repo
// root holds the only editable copy and this script mirrors it into web/assets/.
//
//   node tools/sync-web-assets.mjs           copy root -> web/assets
//   node tools/sync-web-assets.mjs --check   exit 1 if any copy is stale
//
// Run --check before packaging or committing. A stale copy is a silent failure:
// the site keeps working, it just quietly renders last week's annotations.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  ["render.js", "web/assets/render.js"],
  ["exporters.js", "web/assets/exporters.js"],
  // Vendored libraries the exporters reach for at call time. The extension loads
  // them from lib/; the site needs its own same-origin copies because a strict
  // CSP and the no-remote-code rule both forbid a CDN.
  ["lib/jspdf.umd.min.js", "web/assets/lib/jspdf.umd.min.js"],
  ["lib/pptxgen.bundle.js", "web/assets/lib/pptxgen.bundle.js"],
];

const check = process.argv.includes("--check");
let stale = 0;

for (const [from, to] of FILES) {
  const src = resolve(ROOT, from);
  const dst = resolve(ROOT, to);
  const a = readFileSync(src);
  const b = existsSync(dst) ? readFileSync(dst) : null;
  if (b && a.equals(b)) continue;

  if (check) {
    stale++;
    console.error(`stale: ${to} ${b ? "differs from" : "is missing, source is"} ${from}`);
    continue;
  }
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, a);
  console.log(`copied ${from} -> ${to}`);
}

if (check) {
  if (stale) {
    console.error(`\n${stale} web asset(s) out of date. Run: node tools/sync-web-assets.mjs`);
    process.exit(1);
  }
  console.log("web assets match the root copies");
} else {
  console.log("done");
}
