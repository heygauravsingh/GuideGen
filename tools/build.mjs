#!/usr/bin/env node
// Builds both ZIPs.
//
//   node tools/build.mjs            write ../GuideGen-Prod.zip and ../GuideGen-Beta.zip
//   node tools/build.mjs --check    verify the two archives without rebuilding them
//
// This replaces the shell one-liner that used to live in the store runbook, because the two builds
// now differ in more than their folder layout and a one-liner cannot express it.
//
// ## The two builds, and why they are not the same
//
// | | store (`GuideGen-Prod.zip`) | testers (`GuideGen-Beta.zip`) |
// |---|---|---|
// | layout | flat: `manifest.json` at the root | wrapped in `guidegen/` |
// | voice + dictionary | **bundled** (~67MB) | omitted (~3.3MB) |
// | remote fetch code | **removed entirely** | kept |
//
// **Why the store build bundles them.** Chrome Web Store review rejected v1.1.0 on 5 Aug 2026:
// *"Including remotely hosted code in a Manifest V3 item."* The package deliberately omitted
// `en_US-hfc_female-medium.onnx` (60MB) and `piper_phonemize.data` (17MB) and fetched both from a
// GitHub release on first narrated export. `voicecache.js` argued that these are data rather than
// code — and that argument does not survive contact with the policy: `piper_phonemize.data` is the
// preload payload of a WebAssembly module. Bundling is the only fix that keeps narration.
//
// **Why the remote *code* is stripped too, not just made unreachable.** A reviewer reads the package.
// A GitHub URL that pulls a WASM module's data looks like the forbidden thing whether or not the line
// can execute, so the store build contains no such URL. The block is delimited in `voicecache.js` by
// `REMOTE-BEGIN` / `REMOTE-END` and excised here; with the files bundled, `get()` resolves at its
// "bundled in the package?" step and never reaches it.
//
// The beta build keeps the fetch: it is handed to testers directly, is not distributed through the
// store, and a 3.3MB download is the difference between a tester trying it and not.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PROD = path.join(ROOT, "..", "GuideGen-Prod.zip");
const OUT_BETA = path.join(ROOT, "..", "GuideGen-Beta.zip");
const checkOnly = process.argv.includes("--check");

// Everything that ships. Order is irrelevant; presence is not.
const FILES = [
  "manifest.json", "background.js", "recorder.js", "recorder.css", "netpatch.js",
  "popup.html", "popup.js", "sync.js", "editor.html", "redirect.js",
  "offscreen.html", "offscreen.js", "render.js", "exporters.js", "tts.js", "voicecache.js",
  "icons", "lib",
];

// The two big files: in the store build, out of the beta build.
const BIG = ["lib/voices/en_US-hfc_female-medium.onnx", "lib/piper/piper_phonemize.data"];

function fail(msg) {
  console.log("FAIL  " + msg);
  process.exit(1);
}

function zipList(zip) {
  if (!fs.existsSync(zip)) return null;
  return execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n");
}

if (checkOnly) {
  let bad = 0;
  const prod = zipList(OUT_PROD);
  const beta = zipList(OUT_BETA);
  if (!prod) fail("GuideGen-Prod.zip is missing — run without --check.");
  if (!beta) fail("GuideGen-Beta.zip is missing — run without --check.");

  // the store build must carry both big files
  for (const f of BIG) {
    if (!prod.includes(f)) { console.log(`FAIL  store build is missing ${f}`); bad++; }
    if (beta.includes("guidegen/" + f)) { console.log(`FAIL  beta build should not carry ${f}`); bad++; }
  }
  // and it must contain no remote fetch
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-check-"));
  execFileSync("unzip", ["-q", OUT_PROD, "voicecache.js", "-d", tmp]);
  const vc = fs.readFileSync(path.join(tmp, "voicecache.js"), "utf8");
  if (/github\.com|releases\/download|RELEASE\s*\+/.test(vc)) {
    console.log("FAIL  the store build still references a remote download — that is the rejection.");
    bad++;
  }
  if (/REMOTE-BEGIN/.test(vc)) { console.log("FAIL  the remote block was not excised"); bad++; }
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(bad ? `\n${bad} FAILED\n` : "both archives look right");
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------- build

for (const f of [...FILES, ...BIG]) {
  if (!fs.existsSync(path.join(ROOT, f))) fail(`${f} is not in the checkout.`);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "gg-build-"));
const prodDir = path.join(stage, "prod");
const betaDir = path.join(stage, "beta", "guidegen");
fs.mkdirSync(prodDir, { recursive: true });
fs.mkdirSync(betaDir, { recursive: true });

for (const dir of [prodDir, betaDir]) {
  for (const f of FILES) {
    fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  }
}

// tidy both
for (const dir of [prodDir, betaDir]) {
  for (const junk of execFileSync("find", [dir, "-name", ".DS_Store", "-o", "-name", "*.map"],
                                  { encoding: "utf8" }).trim().split("\n").filter(Boolean)) {
    fs.rmSync(junk, { force: true });
  }
}

// the beta build drops the big files and keeps the fetch
for (const f of BIG) fs.rmSync(path.join(betaDir, f), { force: true });

/* the store build keeps the big files and drops the fetch */
const vcPath = path.join(prodDir, "voicecache.js");
let vc = fs.readFileSync(vcPath, "utf8");
const begin = vc.indexOf("/* REMOTE-BEGIN");
const end = vc.indexOf("/* REMOTE-END */");
if (begin === -1 || end === -1) fail("voicecache.js has no REMOTE-BEGIN/REMOTE-END markers.");
vc = vc.slice(0, begin) + `/* The remote-download path is removed from this build.

     Both files this module needs are bundled in the package, so \`get()\` resolves at its "bundled?"
     step and nothing is ever fetched. The fetching code is not merely unreachable here — it is
     absent, because Chrome Web Store review rejected an earlier version for including remotely
     hosted code, and a reviewer reads the package rather than the control flow. See
     \`tools/build.mjs\`. */
  function download() {
    return Promise.reject(new Error("this build bundles the voice; nothing is fetched"));
  }

  ` + vc.slice(end + "/* REMOTE-END */".length).replace(/^\s*\n/, "");
if (/github\.com|releases\/download/.test(vc)) fail("a remote URL survived the excision.");
fs.writeFileSync(vcPath, vc);

// zip: flat for the store, wrapped for Drive
fs.rmSync(OUT_PROD, { force: true });
fs.rmSync(OUT_BETA, { force: true });
execFileSync("zip", ["-r", "-q", "-X", OUT_PROD, ...FILES], { cwd: prodDir });
execFileSync("zip", ["-r", "-q", "-X", OUT_BETA, "guidegen"], { cwd: path.join(stage, "beta") });
fs.rmSync(stage, { recursive: true, force: true });

const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1) + "MB";
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
console.log(`GuideGen-Prod.zip  ${mb(OUT_PROD)}  v${version}  flat, voice bundled, no remote fetch`);
console.log(`GuideGen-Beta.zip  ${mb(OUT_BETA)}  v${version}  wrapped, voice fetched on first use`);
console.log("\nnow run: node tools/build.mjs --check");
