// editor.html -> the dashboard, carrying the guide id across.
//
// v1.0 used editor.html#<guideId>. The dashboard addresses the same guide as
// #local-<guideId>, "local" meaning it lives in this browser's extension storage
// rather than in the account.
(function () {
  const id = location.hash.replace(/^#/, "").replace(/^local-/, "");
  // Guide ids are base36 from uid(). Anything else came from somewhere odd and is
  // not worth putting in a URL.
  const safe = /^[0-9a-z]+$/.test(id) ? id : "";
  // Carry our extension id across too — the dashboard can't guess it when the
  // extension is loaded unpacked. Same reason as background.js openEditor().
  const url = "https://guide-gen.vercel.app/app?ext=" +
              encodeURIComponent(chrome.runtime.id) +
              (safe ? "#local-" + safe : "");
  document.getElementById("link").href = url;
  location.replace(url);
})();
