// GuideGen — offscreen video renderer
//
// Driven entirely by messages from background.js. The contract, in both
// directions, is deliberately tiny:
//
//   in   { target: "offscreen", type: "gg_off_video", guide, steps, pace, narrate }
//   out  { type: "gg_off_progress", p, msg }      … repeatedly
//   out  { type: "gg_off_blob", url, filename }   … once, on success
//   out  { type: "gg_off_error", error }          … once, on failure
//
// An offscreen document only has chrome.runtime, so the guide arrives in the
// message rather than being read from storage here, and the finished video leaves
// as a blob: URL for the service worker to hand to chrome.downloads.
(function () {
  let busy = false;

  function send(m) {
    // The worker may have been replaced mid-render; a failed post is not fatal.
    try { chrome.runtime.sendMessage(m, () => void chrome.runtime.lastError); }
    catch (e) { /* ignore */ }
  }

  async function renderVideo(m) {
    await window.FSExport.video(m.guide, m.steps, {
      narrate: m.narrate !== false,
      pace: m.pace,
      // Never visible, so requestAnimationFrame never fires here. 33ms matches
      // the canvas.captureStream(30) the recorder is pulling from; leaving it at
      // the 100ms hidden-tab default would render the whole video at 10fps.
      tickMs: 33,
      // Don't play the narration through the speakers. In the old editor page
      // that was reassuring feedback; from an invisible document it is a voice
      // coming out of nowhere with no window to attribute it to.
      monitor: false,
      onProgress: (p, msg) => send({ type: "gg_off_progress", p, msg }),
      // Hand the bytes over instead of letting exporters.js call download() —
      // this document has no chrome.downloads.
      onBlob: (blob, filename) => {
        send({ type: "gg_off_blob", url: URL.createObjectURL(blob), filename });
      },
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only ours. Returning true for someone else's message would leave their
    // sendResponse dangling.
    if (!msg || msg.target !== "offscreen") return false;

    if (msg.type !== "gg_off_video") {
      sendResponse({ ok: false, error: "Unknown offscreen request." });
      return false;
    }
    if (busy) {
      sendResponse({ ok: false, error: "Already rendering." });
      return false;
    }

    busy = true;
    sendResponse({ ok: true });
    renderVideo(msg)
      .catch((e) => send({ type: "gg_off_error", error: String((e && e.message) || e) }))
      .then(() => { busy = false; });
    return false;
  });
})();
