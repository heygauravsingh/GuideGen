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
   * `pifkel…` is the id the Web Store assigned on 29 Jul 2026, and with the store
   * item's public key pinned in the extension's manifest (`key`, see RUNBOOK step
   * 2c) an unpacked build loads under that same id too. So the store id is normally
   * the right answer everywhere.
   *
   * The discovery below is kept anyway, because the failure it guards against is
   * silent and expensive. Without a pinned key, Chrome derives an unpacked id from
   * the folder's absolute path — different on every machine — and `sendMessage` to
   * the wrong id sets lastError exactly as it does for "not installed". The page
   * would report the extension missing while it sat there in the toolbar. That
   * happened, and it cost a debugging session.
   *
   * So: `background.js` appends its own `chrome.runtime.id` as `?ext=` when it opens
   * this page, and whichever candidate answers a ping is remembered. Costs one ping
   * on first load and makes the un-pinned case work regardless.
   */
  var STORE_ID = "dijeonandicniffeffbcolhfldommhnp";
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
      "No GuideGen extension answered (tried " + ids.join(", ") + "). Check it's " +
      "installed and enabled. If it is, record a guide and press Stop — that reopens " +
      "this page with the extension's own id attached, which covers a build whose id " +
      "isn't pinned to the store one."
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

  /* Catch-up captures. Metadata only — a session is not a guide yet, so there is
   * nothing to render and no screenshots come over. `bufPromote` turns one into a
   * real local guide and resolves with its id; `minutes` measures back from that
   * session's own end, so an older card offers its own last two minutes rather
   * than an empty slice. */
  function bufSessions() {
    return send({ type: "gg_buf_sessions" }).then(function (r) { return r.sessions || []; });
  }
  function bufPromote(sessionId, minutes) {
    return send({ type: "gg_buf_promote", sessionId: sessionId, minutes: minutes || 0 })
      .then(function (r) { return r.guideId; });
  }
  function bufDiscard(sessionId) {
    return send({ type: "gg_buf_discard", sessionId: sessionId });
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
      // Either a guide on this machine (guideId), or one the page is handing
      // over wholesale (steps) — a recipient exporting a published guide their
      // own extension has never seen.
      var msg = {
        task: "video",
        pace: opts && opts.pace,
        narrate: !(opts && opts.narrate === false),
      };
      if (opts && opts.steps) {
        msg.steps = opts.steps;
        msg.guide = (opts && opts.title) || "Untitled guide";
      } else {
        msg.guideId = guideId;
      }
      port.postMessage(msg);
      });
    });
  }

  return {
    available: available, isInstalled: isInstalled, ping: ping, id: id,
    session: session, setTheme: setTheme,
    guides: guides, guide: guide, stepImage: stepImage,
    updateGuide: updateGuide, updateStep: updateStep, reorder: reorder,
    deleteStep: deleteStep, addNote: addNote, deleteGuide: deleteGuide,
    bufSessions: bufSessions, bufPromote: bufPromote, bufDiscard: bufDiscard,
    renderVideo: renderVideo,
    STORE_ID: STORE_ID,
  };
})();
