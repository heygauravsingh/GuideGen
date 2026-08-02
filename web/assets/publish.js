/* GuideGen — publishing (window.GGPublish).
 *
 * This used to live in the extension's sync.js. It moved here when the dashboard
 * became the editor, so there is one implementation instead of two to keep in
 * step. Five rules govern it, and all five have a cost behind them:
 *
 * 1. **Only the guide the user pressed Publish on is uploaded.** Never batch,
 *    never background-sync. The privacy claim on the site and in the store
 *    listing depends on this, and so does the Cloudinary bill.
 * 2. **Annotations are baked in before upload.** stepImage() renders the ring,
 *    badge and redactions, crops with focusRegion, caps at 1600px and encodes
 *    WebP q0.85. The viewer is then a plain <img> — no canvas on the public page,
 *    and a published image can't drift from what the editor showed. It also means
 *    no unredacted original ever leaves the machine.
 * 3. **Never use Cloudinary delivery transformations.** They bill 1 credit per
 *    1,000 derived images and would eat the 25-credit monthly allowance. We
 *    upload pre-optimised WebP and serve the original. Measured: ~17KB per step
 *    image against ~200-400KB for the PNG equivalent.
 * 4. **Always send the uid_ and gg_ tags.** They are the only way to find and
 *    delete one user's images later through the Admin API, which is what makes a
 *    deletion request answerable.
 * 5. **`Overwrite: false` on the unsigned preset is load-bearing.** A caller can
 *    choose its own public_id; with overwrite off that's harmless. Turn it on and
 *    anyone who learns an image id could replace it on a user's shared page.
 */
window.GGPublish = (function () {
  var CLOUD = "dqrytwq5e";
  var PRESET = "GuideGen_Unsigned";
  var CLD = "https://api.cloudinary.com/v1_1/" + CLOUD + "/image/upload";

  var MAX_W = 1600;
  var QUALITY = 0.85;
  var ASPECT = 1.6;

  // Every publish gets its own random asset tag, stored on the document. That tag
  // is the ONLY way to find this guide's images again: deletion goes through the
  // Admin API by tag, and the dashboard only ever knows the remote document id.
  // Do not derive it from an id — images are uploaded before the document exists.
  function newAssetTag() {
    var b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return "gg_" + Array.prototype.map.call(b, function (x) {
      return x.toString(36).padStart(2, "0");
    }).join("");
  }

  function stepImage(step, seq) {
    var R = window.FSRender;
    return R.renderStep(Object.assign({}, step, { seq: seq })).then(function (canvas) {
      if (!canvas) return null;
      var roi = R.focusRegion(step, canvas.width, canvas.height, ASPECT, { canvas: canvas }) ||
                { x: 0, y: 0, w: canvas.width, h: canvas.height };
      var scale = Math.min(1, MAX_W / roi.w);
      var out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(roi.w * scale));
      out.height = Math.max(1, Math.round(roi.h * scale));
      var cx = out.getContext("2d");
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = "high";
      cx.drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, out.width, out.height);
      return new Promise(function (resolve, reject) {
        out.toBlob(function (b) {
          b ? resolve(b) : reject(new Error("Could not encode a step image."));
        }, "image/webp", QUALITY);
      });
    });
  }

  function uploadImage(blob, uid, assetTag) {
    var fd = new FormData();
    fd.append("file", blob);
    fd.append("upload_preset", PRESET);
    fd.append("tags", ["guidegen", "uid_" + uid, assetTag].join(","));
    fd.append("context", "uid=" + uid + "|asset=" + assetTag);
    return fetch(CLD, { method: "POST", body: fd }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.secure_url) {
          throw new Error("Image upload failed: " + ((j.error && j.error.message) || r.status));
        }
        return j.secure_url;
      });
    });
  }

  // Renders and uploads every step that has a screenshot, in order.
  // `steps` must already carry their images — for a local guide the caller pulls
  // them over the bridge first.
  function buildSteps(steps, uid, assetTag, prog) {
    var withShots = steps.filter(function (s) { return s.screenshot; }).length;
    var done = 0;
    var out = [];

    return steps.reduce(function (chain, step, i) {
      return chain.then(function () {
        /* url and pageTitle travel with a published step, because the AI handoff
           export needs to say *where* each action happened and a recipient opening
           a shared link has no other source for it. Both the privacy policy and the
           store listing already state that publishing sends "the page URLs and
           titles recorded with each step" — this is the code catching up to what
           was declared, not a new disclosure. */
        var entry = {
          seq: i + 1, type: step.type || "click", text: step.text || "",
          url: step.url || "", pageTitle: step.pageTitle || "",
        };
        if (!step.screenshot) { out.push(entry); return; }
        prog(0.05 + 0.8 * (done / Math.max(1, withShots)),
             "Uploading image " + (done + 1) + " of " + withShots + "…");
        return stepImage(step, i + 1).then(function (blob) {
          if (!blob) { out.push(entry); done++; return; }
          return uploadImage(blob, uid, assetTag).then(function (url) {
            entry.imageUrl = url;
            out.push(entry);
            done++;
          });
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  /* First publish: create the document. Returns { remoteId, assetTag, url }. */
  function publish(guide, steps, opts) {
    opts = opts || {};
    var prog = function (p, m) { opts.onProgress && opts.onProgress(p, m); };
    var session = window.GG.current();
    if (!session) return Promise.reject(new Error("Sign in to publish a guide."));
    var assetTag = newAssetTag();

    return buildSteps(steps, session.uid, assetTag, prog).then(function (published) {
      prog(0.9, "Publishing…");
      return window.GG.createGuide({
        ownerUid: session.uid,
        title: guide.title || "Untitled guide",
        visibility: "link",
        stepCount: published.length,
        steps: published,
        assetTag: assetTag,
        assetTags: [assetTag],
        // Off until the owner says otherwise. The rules read this field when a
        // recipient tries to log an export, so it wants to exist from the start
        // rather than being absent and coerced.
        allowExport: false,
      });
    }).then(function (remoteId) {
      prog(1, "Published");
      return { remoteId: remoteId, assetTag: assetTag, url: location.origin + "/g/" + remoteId };
    });
  }

  /* Re-publish an already-published guide *in place*.
   *
   * The whole point: the link must not go stale. Re-publishing used to POST a new
   * document, which minted a new URL and silently orphaned whatever the user had
   * already shared. So this PATCHes the existing document instead, and the id —
   * and therefore the link — survives.
   *
   * Order matters and is not interchangeable:
   *   1. upload the new images under a NEW tag (the preset forbids overwriting)
   *   2. PATCH the document to point at them
   *   3. only then purge the OLD tag
   *
   * Purging before the patch would leave a live document pointing at deleted
   * images if step 2 failed. Not purging at all would leave the superseded images
   * publicly retrievable by URL — which would quietly defeat re-publishing to
   * *remove* something sensitive. Step 3 failing is not fatal: the tag stays on
   * the document's assetTags list, so deleting the guide still catches it.
   */
  function republish(remoteId, guide, steps, opts) {
    opts = opts || {};
    var prog = function (p, m) { opts.onProgress && opts.onProgress(p, m); };
    var session = window.GG.current();
    if (!session) return Promise.reject(new Error("Sign in to publish a guide."));
    var assetTag = newAssetTag();

    return window.GG.getGuide(remoteId).then(function (existing) {
      var oldTags = (existing.assetTags || []).slice();
      if (existing.assetTag && oldTags.indexOf(existing.assetTag) === -1) {
        oldTags.push(existing.assetTag);
      }
      return buildSteps(steps, session.uid, assetTag, prog).then(function (published) {
        prog(0.9, "Updating the shared guide…");
        return window.GG.patchGuide(remoteId, {
          title: guide.title || "Untitled guide",
          stepCount: published.length,
          steps: published,
          assetTag: assetTag,
          // Keep the old tags listed until they're confirmed gone, so a failed
          // purge can still be cleaned up when the guide is deleted.
          assetTags: oldTags.concat([assetTag]),
        }).then(function () { return oldTags; });
      });
    }).then(function (oldTags) {
      if (!oldTags.length) {
        prog(1, "Updated");
        return { remoteId: remoteId, assetTag: assetTag, url: location.origin + "/g/" + remoteId, note: null };
      }
      prog(0.95, "Removing the old images…");
      return Promise.all(oldTags.map(function (t) { return window.GG.purgeAssetTag(t); }))
        .then(function (results) {
          var bad = results.filter(function (r) { return !r.ok; });
          var kept = oldTags.filter(function (t, i) { return !results[i].ok; });
          // Drop the tags that are definitely gone; leave the rest for deletion.
          return window.GG.patchGuide(remoteId, { assetTags: kept.concat([assetTag]) })
            .catch(function () { /* cosmetic bookkeeping — never fail a good publish */ })
            .then(function () {
              prog(1, "Updated");
              return {
                remoteId: remoteId,
                assetTag: assetTag,
                url: location.origin + "/g/" + remoteId,
                note: bad.length
                  ? "The guide is updated, but its previous images couldn't be removed: " +
                    (bad[0].note || "") + " They'll be cleaned up when you delete the guide."
                  : null,
              };
            });
        });
    });
  }

  return { publish: publish, republish: republish };
})();
