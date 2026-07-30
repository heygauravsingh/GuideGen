// POST /api/delete-assets   { idToken, guideId }   delete a guide and its images
// POST /api/delete-assets   { idToken, purgeTag }  delete one asset tag you own
//
// The only server-side code in GuideGen. It exists for one reason: deleting from
// Cloudinary needs the API secret, and a secret cannot live in a browser. Nothing
// is computed here — no rendering, no image processing. Purely credential custody.
//
// The purgeTag mode exists for re-publishing. A new image set goes up under a new
// tag, the document is patched to point at it, and the superseded tag is purged —
// otherwise a republish intended to *remove* something sensitive would leave the
// old image publicly retrievable by URL forever. It cannot check the document
// (which by then names the new tag), so it authorises differently: every image is
// tagged `uid_<owner>` at upload, so a tag is yours if every resource under it
// carries your uid.
//
// Required Vercel environment variables (set them in the Vercel dashboard, never
// in the repo):
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
//
// Trust model: the caller sends their Firebase idToken. We validate it with Google
// to get the uid — we never trust a uid sent in the body — then read the guide and
// confirm ownerUid matches before deleting anything.

const PROJECT = "guidegen-1f938";
const FIREBASE_API_KEY = "AIzaSyCihDiLQ51V0C8DS07WTl70FOpC3ACkfJY"; // public by design
const CLOUD_NAME = "dqrytwq5e";

const IDT = "https://identitytoolkit.googleapis.com/v1/accounts";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Use POST." });

  const key = process.env.CLOUDINARY_API_KEY;
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!key || !secret) {
    // Deliberately explicit: a vague 500 here would look like a bug in the client.
    return json(res, 503, {
      error: "Asset deletion is not configured yet.",
      detail:
        "CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are not set in this deployment's " +
        "environment variables. The guide document can still be deleted; its images cannot.",
    });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: "Malformed request body." });
  }

  const { idToken, guideId, purgeTag } = body || {};
  if (!idToken) return json(res, 400, { error: "idToken is required." });
  if (!guideId && !purgeTag) {
    return json(res, 400, { error: "Either guideId or purgeTag is required." });
  }
  if (guideId && !/^[A-Za-z0-9_-]{6,64}$/.test(guideId)) {
    return json(res, 400, { error: "Invalid guideId." });
  }
  if (purgeTag && !/^gg_[a-z0-9]{6,64}$/.test(purgeTag)) {
    return json(res, 400, { error: "Invalid purgeTag." });
  }

  const auth = Buffer.from(`${key}:${secret}`).toString("base64");
  const CLD = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}`;

  // invalidate=true is NOT optional. Without it Cloudinary removes the asset from
  // storage but its CDN keeps serving the cached copy — measured at
  // `max-age=2592000, immutable`, i.e. publicly retrievable for 30 days after a
  // "successful" delete. That would make this endpoint report a deletion it had
  // not performed, on the one feature where that matters most.
  async function deleteByTag(tag) {
    const r = await fetch(
      `${CLD}/resources/image/tags/${encodeURIComponent(tag)}?invalidate=true`,
      { method: "DELETE", headers: { Authorization: `Basic ${auth}` } }
    );
    if (r.ok) return { ok: true };
    const txt = await r.text().catch(() => "");
    return { ok: false, note: `Cloudinary returned ${r.status}. ${txt.slice(0, 180)}` };
  }

  try {
    // 1. Who is calling? Ask Google — never trust a uid from the client.
    const lookup = await fetch(`${IDT}:lookup?key=${FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!lookup.ok) return json(res, 401, { error: "Not signed in, or the session expired." });
    const users = (await lookup.json()).users || [];
    const uid = users[0] && users[0].localId;
    if (!uid) return json(res, 401, { error: "Could not identify the signed-in user." });

    // ---- purgeTag mode: authorise from the images' own uid_ tag ----
    if (purgeTag) {
      const list = await fetch(
        `${CLD}/resources/image/tags/${encodeURIComponent(purgeTag)}?tags=true&max_results=500`,
        { headers: { Authorization: `Basic ${auth}` } }
      );
      if (!list.ok) return json(res, 502, { error: "Couldn't list those images." });
      const resources = (await list.json()).resources || [];
      // Nothing to do is a success — a republish whose upload failed early leaves
      // an empty tag, and reporting that as an error would fail a good publish.
      if (!resources.length) return json(res, 200, { ok: true, assetsDeleted: false, note: "No images under that tag." });
      const mine = resources.every((r) => (r.tags || []).includes(`uid_${uid}`));
      if (!mine) return json(res, 403, { error: "Those images aren't yours." });
      const del = await deleteByTag(purgeTag);
      if (!del.ok) return json(res, 502, { error: "Couldn't delete those images.", detail: del.note });
      return json(res, 200, {
        ok: true,
        assetsDeleted: true,
        note: "Superseded images deleted. Already-cached copies can take up to an hour to clear the CDN.",
      });
    }

    // 2. Read the guide. Sent with the caller's token so Firestore rules apply too.
    const docRes = await fetch(`${FS}/guides/${encodeURIComponent(guideId)}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (docRes.status === 403 || docRes.status === 404) {
      return json(res, 404, { error: "That guide doesn't exist, or isn't yours." });
    }
    if (!docRes.ok) return json(res, 502, { error: "Couldn't read the guide." });
    const fields = (await docRes.json()).fields || {};

    // 3. Ownership. The rules already gate writes, but a read is permitted for any
    //    published guide — so this check is what stops one user deleting another's.
    const ownerUid = fields.ownerUid && fields.ownerUid.stringValue;
    if (ownerUid !== uid) return json(res, 403, { error: "That guide isn't yours." });

    // Every tag this guide has ever used, not just the current one. Re-publishing
    // uploads a fresh set under a new tag and normally purges the old one straight
    // away — but if that purge failed, the tag is still listed here, and this is
    // the last chance to catch it before the document is gone.
    const tags = [];
    const list = fields.assetTags && fields.assetTags.arrayValue;
    ((list && list.values) || []).forEach((v) => {
      if (v && v.stringValue) tags.push(v.stringValue);
    });
    const current = fields.assetTag && fields.assetTag.stringValue;
    if (current && !tags.includes(current)) tags.push(current);

    // 4. Purge the images. Guides published before asset tagging shipped have no
    //    tag at all, so report that honestly rather than pretending otherwise.
    let assetsDeleted = false;
    let assetNote = null;
    const failed = [];
    for (const tag of tags) {
      const r = await deleteByTag(tag);
      if (r.ok) assetsDeleted = true;
      else failed.push(r.note);
    }
    if (!tags.length) {
      assetNote = "This guide has no assetTag — it was published before asset tagging " +
                  "shipped, so its images can't be located automatically.";
    } else if (failed.length) {
      assetNote = failed.join(" ");
    } else {
      // CDN purge is asynchronous — Cloudinary documents up to an hour. Say so
      // rather than implying the URLs die the instant this returns.
      assetNote = "Images deleted and CDN invalidation requested. Already-cached " +
                  "copies can take up to an hour to disappear from the CDN.";
    }

    // 5. Delete the document last, so a failed purge doesn't orphan the only record
    //    of which images exist.
    if (failed.length) {
      return json(res, 502, { error: "Couldn't delete the images, so the guide was kept.", detail: assetNote });
    }
    const del = await fetch(`${FS}/guides/${encodeURIComponent(guideId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!del.ok) return json(res, 502, { error: "Images were deleted but the guide record wasn't." });

    return json(res, 200, { ok: true, assetsDeleted, note: assetNote });
  } catch (e) {
    return json(res, 500, { error: "Deletion failed.", detail: String(e && e.message).slice(0, 200) });
  }
};
