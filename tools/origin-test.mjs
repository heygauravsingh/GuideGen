// Asserts the bridge's origin guard.
//
// The move to the house domain was additive: `guidegen.backpocket.website` is where the
// site lives now, and `guide-gen.vercel.app` still serves it, because every guide anyone
// has already shared is a link to the old address. So the guard has to accept *both* —
// an extension released before the move talks to the old one, and a guard that knew only
// one origin would be the bug rather than the safeguard.
//
// The negative cases are the point. Any script on an allowed origin can read and edit
// every local guide, so this list must never grow a wildcard: not the apex, not a sibling
// subdomain, not http, and not a lookalike that merely *starts* with an allowed host.
import { harness, evalIn } from "./bg-harness.mjs";

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

const fromSite = evalIn(harness(), "fromSite");

console.log("\n=== the two site origins are allowed ===");
check("the house domain", fromSite("https://guidegen.backpocket.website"), true);
check("the original address, still serving every shared link",
      fromSite("https://guide-gen.vercel.app"), true);

console.log("\n=== everything else is not ===");
// The apex is the house's own marketing page. It is not the editor, so it has no
// business being able to read a guide.
check("the apex domain", fromSite("https://backpocket.website"), false);
// The reason this list is exact origins and never `*.backpocket.website`: the next
// product on the next subdomain must not inherit access to GuideGen's guides.
check("another subdomain of the house domain", fromSite("https://evil.backpocket.website"), false);
check("plain http", fromSite("http://guidegen.backpocket.website"), false);
check("a lookalike that starts with an allowed host",
      fromSite("https://guidegen.backpocket.website.attacker.com"), false);
check("a lookalike of the old address", fromSite("https://guide-gen.vercel.app.evil.com"), false);
check("no origin at all", fromSite(undefined), false);
check("the empty string", fromSite(""), false);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
