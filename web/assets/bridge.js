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
  /* Which extension to talk to.
   *
   * The Web Store assigned `pifkel…` on 29 Jul 2026 and that is permanent — but it
   * is only the id of the *packaged* build. An extension loaded unpacked gets an id
   * Chrome derives locally, and there is no way for this page to know it in advance.
   * Hardcoding the store id therefore fails for every developer install, and fails
   * in the most misleading way possible: `sendMessage` sets lastError exactly as it
   * does for "not installed", so the page reports the extension missing while it sits
   * there in the toolbar.
   *
   * So the id is discovered rather than assumed. `background.js` appends its own
   * `chrome.runtime.id` as `?ext=` whenever it opens this page, and whichever
   * candidate actually answers a ping is remembered. Both installs work, and
   * switching between them fixes itself on the next Stop.
   */
  var STORE_ID = "pifkelcohogbbocldnkjlfiagjigikjl";
  var LS_KEY = "gg_ext_id";
  var VALID = /^[a-p]{32}$/;   // Chrome extension ids are 32 chars from a–p

  function fromUrl() {
    try {
      var v = new URLSearchParams(location.search).get("ext");
      return v && VALID.test(v) ? v : null;
    } catch (e) { return null; }
  }
  function remembered() {
    try {
      var v = localStorage.getItem(LS_KEY);
      return v && VALID.test(v) ? v : null;
    } catch (e) { return null; }
  }
  function remember(id) {
    try { localStorage.setItem(LS_KEY, id); } catch (e) { /* private mode */ }
  }

  // Ordered by how likely each is to be the one running right now.
  function candidates() {
    var out = [];
    [fromUrl(), remembered(), STORE_ID].forEach(function (id) {
      if (id && out.indexOf(id) === -1) out.push(id);
    });
    return out;
  }

  // chrome.runtime exists on this page only because *some* installed extension
  // names this origin in externally_connectable. It's a necessary condition, not a
  // sufficient one — the id still has to match.
  function available() {
    return !!(window.chrome && chrome.runtime && chrome.runtime.sendMessage);
  }

  var installed = null; // null = not asked yet

  function raw(id, msg) {
    return new Promise(function (resolve, reject) {
      if (!available()) return reject(new Error("This browser has no GuideGen extension."));
      try {
        chrome.runtime.sendMessage(id, msg, function (resp) {
          // Reading lastError is also what stops Chrome logging it as unchecked.
          var err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message || "no answer"));
          if (!resp) return reject(new Error("The extension didn't answer."));
          resolve(resp);
        });
      } catch (e) {
        reject(new Error(String((e && e.message) || e)));
      }
    });
  }

  function notFound(ids) {
    return new Error(
      "No GuideGen extension answered (tried " + ids.join(", ") + "). If you loaded " +
      "it unpacked, Chrome gave it a different id than the Web Store build — record a " +
      "guide and press Stop, which reopens this page with the right id attached."
    );
  }

  var resolvedId = null;
  var resolving = null;

  // Pings each candidate in turn and keeps the one that answers. Runs once per page
  // load; every later call reuses the result.
  function extensionId() {
    if (resolvedId) return Promise.resolve(resolvedId);
    if (resolving) return resolving;
    if (!available()) return Promise.reject(new Error("This browser has no GuideGen extension."));

    var ids = candidates();
    resolving = ids.reduce(function (chain, id) {
      return chain.then(function (found) {
        if (found) return found;
        return raw(id, { type: "gg_ping" }).then(
          function () { return id; },
          function () { return null; }
        );
      });
    }, Promise.resolve(null)).then(function (found) {
      resolving = null;
      if (!found) { installed = false; throw notFound(ids); }
      resolvedId = found;
      installed = true;
      remember(found);
      return found;
    }, function (e) {
      resolving = null;
      throw e;
    });
    return resolving;
  }

  function send(msg) {
    return extensionId()
      .then(function (id) { return raw(id, msg); })
      .then(function (resp) {
        if (!resp.ok) throw new Error(resp.error || "The extension refused that.");
        return resp;
      });
  }

  function ping() {
    return send({ type: "gg_ping" }).then(function (r) { return r.version; });
  }
  function isInstalled() { return installed; }
  function id() { return resolvedId; }

  function session() {
    return send({ type: "gg_session" }).then(function (r) { return r.session; });
  }
  // Carries the dashboard's light/dark choice to the popup, which can't read this
  // origin's localStorage.
  function setTheme(mode) {
    return send({ type: "gg_set_theme", mode: mode });
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
    // Resolve the id first: connect() to a wrong id looks like a port that opens and
    // immediately disconnects, which is indistinguishable from the renderer dying.
    return extensionId().then(function (extId) {
      return new Promise(function (resolve, reject) {
      var port;
      try {
        port = chrome.runtime.connect(extId, { name: "gg_task" });
      } catch (e) {
        return reject(new Error("Couldn't reach the GuideGen extension."));
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
    });
  }

  return {
    available: available, isInstalled: isInstalled, ping: ping, id: id,
    session: session, setTheme: setTheme,
    guides: guides, guide: guide, stepImage: stepImage,
    updateGuide: updateGuide, updateStep: updateStep, reorder: reorder,
    deleteStep: deleteStep, addNote: addNote, deleteGuide: deleteGuide,
    renderVideo: renderVideo,
    STORE_ID: STORE_ID,
  };
})();
