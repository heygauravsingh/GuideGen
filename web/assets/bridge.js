/* GuideGen — the extension bridge (window.GGBridge).
 *
 * Unpublished guides live in the extension's chrome.storage.local, on one machine.
 * This page can't read that directly — different origin, different sandbox — so
 * every local read and write goes through chrome.runtime.sendMessage to the
 * extension id below, which the extension allows because its manifest names this
 * exact origin in `externally_connectable`.
 *
 * Two consequences worth stating plainly, because users will hit both:
 *
 *   - Without the extension installed, there are no local guides to show. Only
 *     published guides are in the account, so only those travel between devices.
 *   - Step images are fetched ONE AT A TIME, as cards come into view. A guide's
 *     screenshots are megabytes; asking for them in one message is how you find
 *     the message-size ceiling in front of a user.
 */
window.GGBridge = (function () {
  // Assigned by the Chrome Web Store on 29 Jul 2026 and permanent.
  var EXT_ID = "pifkelcohogbbocldnkjlfiagjigikjl";

  // chrome.runtime exists on this page only because the extension's manifest lists
  // this origin. No extension, no object — so this is also the install check.
  function available() {
    return !!(window.chrome && chrome.runtime && chrome.runtime.sendMessage);
  }

  var installed = null; // null = not asked yet

  function send(msg) {
    return new Promise(function (resolve, reject) {
      if (!available()) return reject(new Error("The GuideGen extension isn't available on this browser."));
      try {
        chrome.runtime.sendMessage(EXT_ID, msg, function (resp) {
          // lastError is how "not installed" and "disabled" both surface. Reading
          // it is also what stops Chrome logging it as an unchecked error.
          var err = chrome.runtime.lastError;
          if (err) {
            installed = false;
            return reject(new Error("The GuideGen extension isn't installed in this browser."));
          }
          installed = true;
          if (!resp) return reject(new Error("The extension didn't answer."));
          if (!resp.ok) return reject(new Error(resp.error || "The extension refused that."));
          resolve(resp);
        });
      } catch (e) {
        installed = false;
        reject(new Error("The GuideGen extension isn't installed in this browser."));
      }
    });
  }

  function ping() {
    return send({ type: "gg_ping" }).then(function (r) { return r.version; });
  }
  function isInstalled() { return installed; }

  function session() {
    return send({ type: "gg_session" }).then(function (r) { return r.session; });
  }
  function guides() {
    return send({ type: "gg_guides" }).then(function (r) { return r.guides || []; });
  }
  function guide(guideId) {
    return send({ type: "gg_guide", guideId: guideId });
  }
  function stepImage(stepId) {
    return send({ type: "gg_step_image", stepId: stepId })
      .then(function (r) { return r.screenshot; });
  }
  function updateGuide(guideId, patch) {
    return send({ type: "gg_update_guide", guideId: guideId, patch: patch });
  }
  function updateStep(stepId, patch) {
    return send({ type: "gg_update_step", stepId: stepId, patch: patch });
  }
  function reorder(guideId, order) {
    return send({ type: "gg_reorder", guideId: guideId, order: order });
  }
  function deleteStep(guideId, stepId) {
    return send({ type: "gg_delete_step", guideId: guideId, stepId: stepId });
  }
  function addNote(guideId, text) {
    return send({ type: "gg_add_note", guideId: guideId, text: text })
      .then(function (r) { return r.step; });
  }
  function deleteGuide(guideId) {
    return send({ type: "gg_delete_guide", guideId: guideId });
  }

  /* Narrated video is the one export that can't run here: it needs the 88MB
   * offline voice stack, which ships inside the extension and can't be served
   * from this site. So the extension renders it in an offscreen document and
   * downloads the result.
   *
   * A long-lived port rather than sendMessage, for two reasons: progress has to
   * stream over a render that can take minutes, and an open port is what stops
   * Chrome shutting the extension's service worker down halfway through.
   */
  function renderVideo(guideId, opts, onProgress) {
    return new Promise(function (resolve, reject) {
      if (!available()) return reject(new Error("The GuideGen extension isn't available on this browser."));
      var port;
      try {
        port = chrome.runtime.connect(EXT_ID, { name: "gg_task" });
      } catch (e) {
        return reject(new Error("The GuideGen extension isn't installed in this browser."));
      }
      var settled = false;
      port.onMessage.addListener(function (m) {
        if (!m) return;
        if (m.type === "progress") return onProgress && onProgress(m.p, m.msg);
        settled = true;
        port.disconnect();
        if (m.type === "done") resolve(m.filename);
        else reject(new Error(m.error || "The video failed."));
      });
      port.onDisconnect.addListener(function () {
        if (settled) return;
        // The worker was replaced, or the extension was reloaded mid-render.
        reject(new Error("Lost contact with the extension before the video finished."));
      });
      port.postMessage({
        task: "video",
        guideId: guideId,
        pace: opts && opts.pace,
        narrate: !(opts && opts.narrate === false),
      });
    });
  }

  return {
    available: available, isInstalled: isInstalled, ping: ping,
    session: session,
    guides: guides, guide: guide, stepImage: stepImage,
    updateGuide: updateGuide, updateStep: updateStep, reorder: reorder,
    deleteStep: deleteStep, addNote: addNote, deleteGuide: deleteGuide,
    renderVideo: renderVideo,
    EXT_ID: EXT_ID,
  };
})();
