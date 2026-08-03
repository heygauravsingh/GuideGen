/* Tier 2 of the API log: the body of a *failed* response.
 *
 * This file is the only code in the extension that runs in the page's **MAIN
 * world**, and it has to. `chrome.webRequest` cannot read a response body at any
 * permission level and never could, and the alternatives are worse: the
 * `chrome.debugger` API can, but it paints a "started debugging this browser"
 * banner across the tab, refuses to share the tab with DevTools, and is close to
 * an automatic store rejection. So the body has to come from the only place that
 * already has it — the page's own fetch and XHR.
 *
 * Consequences of living in the MAIN world, all of which are real:
 *
 * - **It shares a global scope with the site.** Hence one bracketed IIFE, no
 *   globals beyond the marker, and no assumptions about what else is patched.
 *   Other extensions and the site's own instrumentation may have wrapped these
 *   same functions; chaining through whatever is already there is the only
 *   correct thing to do, which is why the originals are captured by reference
 *   rather than by name.
 * - **It cannot use `chrome.*`.** The MAIN world has no extension APIs, so the
 *   only way out is `window.postMessage`, picked up by recorder.js in the
 *   isolated world and forwarded to the worker.
 * - **The page can post the same messages.** So nothing here is trusted:
 *   background.js only attaches a body to a request `webRequest` independently
 *   saw, matched on tab, status and path. A forged body with no matching request
 *   is dropped. This file is a source of *hints*, not of records.
 * - **It misses anything that already ran.** A page mid-session has its own
 *   references to fetch and XHR taken long ago; patching now cannot reach those
 *   calls. Requests from Workers and Service Workers, `sendBeacon`, WebSockets
 *   and EventSource are all out of reach too. The Tier 1 summary still covers
 *   every one of them, because webRequest sees the network rather than the page.
 *
 * Only failures. A 2xx body is the bulk of the data and the bulk of the risk —
 * customer records, personal details, whole result sets — for the least value: if
 * it worked, the status line already said so. A failure envelope is small, it is
 * the thing being diagnosed, and it is the only body worth the exposure.
 */
(() => {
  const MARK = "__ggNetPatched";
  if (window[MARK]) return;
  window[MARK] = 1;

  const TAG = "gg_net_body";
  // Bounds the postMessage only; the worker trims again to NET.bodyChars. Slightly
  // above that on purpose, so the worker is the single place the real limit lives.
  const LIMIT = 12000;

  function report(url, status, body) {
    if (!body) return;
    try {
      window.postMessage(
        { source: TAG, url: String(url || ""), status: status, body: String(body).slice(0, LIMIT) },
        // Same document only. A '*' target would hand failed API responses to
        // every iframe on the page.
        window.location.origin === "null" ? "*" : window.location.origin
      );
    } catch (e) { /* a page that has broken postMessage is not worth fighting */ }
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        return p.then((res) => {
          try {
            if (res && !res.ok) {
              // clone() is not optional: reading the response consumes it, and
              // consuming the page's own body would break the page.
              res.clone().text().then((t) => report(res.url, res.status, t), () => {});
            }
          } catch (e) { /* already-consumed or opaque response */ }
          return res;
        });
      } catch (e) {
        return p;
      }
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try { this[MARK + "_u"] = url; } catch (e) { /* frozen instance */ }
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      try {
        this.addEventListener("load", () => {
          try {
            if (this.status < 400) return;
            // Only the text-ish response types can be read without touching the
            // page's own view of the data. blob and arraybuffer are skipped —
            // they are downloads, not API errors.
            const rt = this.responseType;
            let body = "";
            if (rt === "" || rt === "text") body = this.responseText;
            else if (rt === "json") body = JSON.stringify(this.response);
            report(this[MARK + "_u"] || this.responseURL, this.status, body);
          } catch (e) { /* cross-origin or unreadable */ }
        });
      } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }
})();
