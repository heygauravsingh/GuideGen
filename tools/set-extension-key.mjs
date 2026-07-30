#!/usr/bin/env node
// Pins the extension id by writing the store item's public key into manifest.json.
//
//   node tools/set-extension-key.mjs path/to/public-key.pem
//   pbpaste | node tools/set-extension-key.mjs -
//   node tools/set-extension-key.mjs --check
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

// The permanent id the Chrome Web Store assigned on 29 Jul 2026.
const STORE_ID = "pifkelcohogbbocldnkjlfiagjigikjl";

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
                "       node tools/set-extension-key.mjs --check\n\n" +
                "Get the key from the Chrome Web Store dashboard:\n" +
                "  your item -> Package -> View public key");
  process.exit(2);
}

const raw = arg === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(arg), "utf8");
const key = cleanPem(raw);
const derived = idFromKey(key);

if (derived !== STORE_ID) {
  console.error(
    `Refusing to write it.\n\n` +
    `  this key derives id : ${derived}\n` +
    `  store item id       : ${STORE_ID}\n\n` +
    `That key belongs to a different extension. Pinning it would give every install a\n` +
    `third id — neither the store's nor the path-derived one — and break the OAuth\n` +
    `redirect URI and the dashboard bridge for everyone at once.\n\n` +
    `Check you copied the key from the right item: Package -> View public key.`
  );
  process.exit(1);
}

// Insert after "version" so it reads near the identity fields rather than at the end.
const out = {};
for (const [k, v] of Object.entries(manifest)) {
  out[k] = v;
  if (k === "version") out.key = key;
}
if (!out.key) out.key = key;

writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + "\n");
console.log(`key written to manifest.json`);
console.log(`unpacked builds will now load as ${derived}, same as the store build`);
console.log(`\nOne OAuth redirect URI is now enough:`);
console.log(`  https://${derived}.chromiumapp.org/`);
