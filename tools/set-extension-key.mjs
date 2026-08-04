#!/usr/bin/env node
// Pins the extension id by writing the store item's public key into manifest.json.
//
//   node tools/set-extension-key.mjs path/to/public-key.pem
//   pbpaste | node tools/set-extension-key.mjs -
//   node tools/set-extension-key.mjs --check
//   node tools/set-extension-key.mjs --remove          (strip key for a NEW item's first upload)
//   node tools/set-extension-key.mjs <key> --id <id>   (adopt a different store item)
//
// Why: Chrome derives an unpacked extension's id from the absolute path of the
// folder it was loaded from. So the id differs on every machine — which means
// every tester's install has a different id, and anything registered against an
// id (an OAuth redirect URI, most importantly) works only for whoever registered
// it. With a `key` field, Chrome derives the id from the key instead, and the
// unpacked build gets the same id as the store build everywhere.
//
// This script does not take the key on trust. The extension id IS a hash of the
// public key, so the key can be checked against the id the store already assigned:
// if they don't match, the key belongs to a different item and pinning it would
// hand every user a *third* id. It refuses rather than writing that.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = resolve(ROOT, "manifest.json");
const BRIDGE = resolve(ROOT, "web/assets/bridge.js");

// The permanent id the Chrome Web Store assigned on 29 Jul 2026.
//
// `--id <newid>` rewrites this line and bridge.js's STORE_ID together, for when the
// product is resubmitted as a *new* store item. They have to move as a pair: this
// script guards the manifest key, bridge.js is what the dashboard sends messages to,
// and an install where those two disagree looks exactly like "extension not
// installed" while it sits in the toolbar.
const STORE_ID = "dijeonandicniffeffbcolhfldommhnp";

const VALID_ID = /^[a-p]{32}$/;

// Rewrites the STORE_ID constant in this file and in bridge.js. Deliberately a
// narrow anchored replace on the old id rather than a regex over the declaration:
// if either file has drifted, this fails loudly instead of writing one of them.
function adoptId(oldId, newId) {
  // Two of these are functional (this script's guard, the dashboard's send target);
  // two are comments naming the redirect URI. The comments are included because a
  // comment stating a dead id is how the next person registers the wrong URI.
  const files = [
    fileURLToPath(import.meta.url),
    BRIDGE,
    resolve(ROOT, "sync.js"),
    resolve(ROOT, "web/assets/gg.js"),
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const hits = src.split(oldId).length - 1;
    if (hits !== 1) {
      throw new Error(`expected exactly one ${oldId} in ${file}, found ${hits}. ` +
                      `Fix it by hand — a partial rewrite here breaks the bridge silently.`);
    }
    writeFileSync(file, src.replace(oldId, newId));
    console.log(`store id updated in ${file.replace(ROOT + "/", "")}`);
  }
  console.log(
    `\nStill mentioning ${oldId} in prose — update by hand:\n` +
    `  CLAUDE.md, PLAN.md, ../private/GuideGen/store/RUNBOOK.md`
  );
}

// Chrome's id derivation: SHA-256 the DER public key, take the first 16 bytes, and
// map each 4-bit nibble to a–p. Not base16 — 'a' is 0, so 0x0 -> 'a', 0xf -> 'p'.
function idFromKey(b64) {
  const der = Buffer.from(b64, "base64");
  const hash = createHash("sha256").update(der).digest();
  let id = "";
  for (const byte of hash.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

function cleanPem(text) {
  const body = String(text)
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(body) || body.length < 100) {
    throw new Error("That doesn't look like a public key. Expected the PEM block from the " +
                    "Web Store dashboard: Package -> View public key.");
  }
  return body;
}

const arg = process.argv[2];
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));

// ---- --remove: strip the key, for a brand-new item's first upload ----
//
// A new store item has no key until a package has been processed, so there is a
// window where the manifest can only carry the *old* item's key. Uploading that as a
// new item is asking the store to mint a second item deriving an id it has already
// assigned — at best ignored, at worst rejected as a duplicate. Strip it, upload,
// then put the new item's key back with the normal invocation.
if (arg === "--remove") {
  if (!manifest.key) {
    console.log("manifest.json already has no \"key\" — nothing to remove.");
    process.exit(0);
  }
  const gone = idFromKey(manifest.key);
  delete manifest.key;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`removed the key that derived ${gone}`);
  console.log(
    "\nUntil a new key is written, unpacked builds get a path-derived id that differs on\n" +
    "every machine, so Google sign-in and the dashboard bridge work only where the id\n" +
    "happens to match. Do not ship a tester zip in this state — this mode exists for the\n" +
    "store upload only. See RUNBOOK step 2c."
  );
  process.exit(0);
}

// ---- --check: is the manifest's key the right one? ----
if (arg === "--check") {
  if (!manifest.key) {
    console.error("manifest.json has no \"key\" field, so an unpacked build gets a\n" +
                  "path-derived id that differs on every machine. See RUNBOOK step 2c.");
    process.exit(1);
  }
  const got = idFromKey(manifest.key);
  if (got !== STORE_ID) {
    console.error(`manifest key derives id ${got}\nbut the store item is  ${STORE_ID}`);
    process.exit(1);
  }
  console.log(`manifest key derives ${got} — matches the store item`);
  process.exit(0);
}

if (!arg) {
  console.error("Usage: node tools/set-extension-key.mjs <public-key.pem | ->\n" +
                "       node tools/set-extension-key.mjs --check\n" +
                "       node tools/set-extension-key.mjs --remove\n" +
                "       node tools/set-extension-key.mjs <public-key.pem> --id <32-char-id>\n\n" +
                "Get the key from the Chrome Web Store dashboard:\n" +
                "  your item -> Package -> View public key");
  process.exit(2);
}

// `--id <newid>` re-points the whole repo at a different store item. Everything is
// still verified: the supplied key must derive the supplied id, so a typo in either
// is caught rather than written.
const idFlag = process.argv.indexOf("--id");
const newId = idFlag === -1 ? null : process.argv[idFlag + 1];
if (idFlag !== -1) {
  if (!newId || !VALID_ID.test(newId)) {
    console.error("--id needs a 32-character extension id using letters a-p only.\n" +
                  "That's the id shown on the item in the developer dashboard.");
    process.exit(2);
  }
  if (newId === STORE_ID) {
    console.error(`--id ${newId} is already the pinned store item; drop the flag.`);
    process.exit(2);
  }
}

const expected = newId || STORE_ID;

const raw = arg === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(arg), "utf8");
const key = cleanPem(raw);
const derived = idFromKey(key);

if (derived !== expected) {
  console.error(
    `Refusing to write it.\n\n` +
    `  this key derives id : ${derived}\n` +
    `  ${newId ? "id passed to --id  " : "store item id      "} : ${expected}\n\n` +
    (newId
      ? `The key and the id don't belong to the same item, so one of the two was copied\n` +
        `from the wrong place. Both come off the same item in the developer dashboard:\n` +
        `the id is on the item, the key is under Package -> View public key.\n`
      : `That key belongs to a different extension. Pinning it would give every install a\n` +
        `third id — neither the store's nor the path-derived one — and break the OAuth\n` +
        `redirect URI and the dashboard bridge for everyone at once.\n\n` +
        `Check you copied the key from the right item: Package -> View public key.\n` +
        `If you are deliberately moving to a NEW store item, pass --id <new-item-id>.\n`)
  );
  process.exit(1);
}

if (newId) adoptId(STORE_ID, newId);

// Insert after "version" so it reads near the identity fields rather than at the end.
//
// The `k === "key"` skip is load-bearing: a manifest that already has a key carries it
// *after* version, so copying entries in order would set the new key at version and
// then overwrite it with the old one on the next iteration. Replacing a key would
// silently no-op, which is the exact failure this script exists to prevent.
const out = {};
for (const [k, v] of Object.entries(manifest)) {
  if (k === "key") continue;
  out[k] = v;
  if (k === "version") out.key = key;
}
if (!out.key) out.key = key;

writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + "\n");
console.log(`key written to manifest.json`);
console.log(`unpacked builds will now load as ${derived}, same as the store build`);
if (newId) {
  console.log(`\nStore item changed: ${STORE_ID} -> ${newId}`);
  console.log(`Register this redirect URI on the OAuth client, and remove the old one:`);
} else {
  console.log(`\nOne OAuth redirect URI is now enough:`);
}
console.log(`  https://${derived}.chromiumapp.org/`);
