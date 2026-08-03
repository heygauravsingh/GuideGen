/* Tier 2 of the API log: the whole failed exchange, as a cURL.
 *
 * This file is the only code in the extension that runs in the page's **MAIN
 * world**, and it has to. `chrome.webRequest` cannot read a response body at any
 * permission level and never could, and it cannot read a *request* body either.
 * The alternatives are worse: `chrome.debugger` can read both, but it paints a
 * "started debugging this browser" banner across the tab, refuses to share the
 * tab with DevTools, and is close to an automatic store rejection. So the
 * exchange has to come from the only place that already has it — the page's own
 * fetch and XHR.
 *
 * **Why a cURL and not a status line.** `POST /api/orders → 500` says a request
 * failed; it does not say what was sent, so nobody can act on it without asking
 * the reporter to reproduce it. The request line, the headers, the sent body and
 * the response together are a bug report an engineer — or a model — can work from
 * directly, and cURL is the one format both already read.
 *
 * **Secret values never leave the page.** Masking happens *here*, before the
 * postMessage, not in the worker: a value that never crosses the boundary cannot
 * be stored, exported, or pasted into a chat window by accident. `MASKED_HEADER`
 * covers anything whose name looks like credentials, `MASKED_KEY` covers the
 * obvious keys inside a JSON or form body, and the worker masks again on the way
 * in (see netScrubHeaders in background.js) because one of the two has to be the
 * last word and both are cheap. The header *name* is kept — knowing a request
 * carried an `authorization` header is the diagnosis; the token is not.
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
 *   background.js only attaches an exchange to a request `webRequest`
 *   independently saw, matched on tab, status and path. A forged body with no
 *   matching request is dropped. This file is a source of *hints*, not of records.
 * - **It misses anything that already ran.** A page mid-session has its own
 *   references to fetch and XHR taken long ago; patching now cannot reach those
 *   calls. Requests from Workers and Service Workers, `sendBeacon`, WebSockets
 *   and EventSource are all out of reach too. The Tier 1 summary still covers
 *   every one of them, because webRequest sees the network rather than the page.
 * - **Cookies are not in reach and that is fine.** `Cookie` is set by the browser
 *   below this layer, and an HttpOnly cookie is invisible to any page script. So a
 *   captured cURL is not a replayable session token — it is the shape of the call.
 *
 * Only failures. A 2xx exchange is the bulk of the data and the bulk of the risk —
 * customer records, personal details, whole result sets — for the least value: if
 * it worked, the status line already said so. A failure envelope is small, it is
 * the thing being diagnosed, and it is the only exchange worth the exposure.
 */
(() => {
  const MARK = "__ggNetPatched";
  if (window[MARK]) return;
  window[MARK] = 1;

  const TAG = "gg_net_body";
  // Bounds the postMessage only; the worker trims again to NET.bodyChars /
  // NET.reqBodyChars. Slightly above those on purpose, so the worker stays the
  // single place the real limits live.
  const LIMIT = 12000;
  const REQ_LIMIT = 6000;

  // Header names whose *value* is a credential. Substring match, lower-cased, so
  // `x-auth-token`, `x-api-key` and `proxy-authorization` are all covered without
  // enumerating every vendor's spelling.
  const MASKED_HEADER = /auth|cookie|token|secret|api[-_]?key|session|credential|signature/i;
  // Keys inside a sent body. A login request carries the password in the body, not
  // in a header, and that is exactly the request someone debugs.
  const MASKED_KEY = /pass|pwd|token|secret|otp|auth|card|cvv|cvc|ssn|api[-_]?key|credential/i;
  const MASK = "…GuideGen-masked…";

  function maskHeaders(pairs) {
    const out = [];
    pairs.forEach(([k, v]) => {
      if (!k) return;
      out.push([String(k), MASKED_HEADER.test(k) ? MASK : String(v == null ? "" : v)]);
    });
    return out;
  }

  // Headers arrive as a Headers instance, a plain object, or an array of pairs —
  // all three are legal in a fetch init, and a site will use whichever it likes.
  function readHeaders(h) {
    try {
      if (!h) return [];
      if (typeof h.forEach === "function" && typeof h.get === "function") {
        const pairs = [];
        h.forEach((v, k) => pairs.push([k, v]));
        return maskHeaders(pairs);
      }
      if (Array.isArray(h)) return maskHeaders(h);
      return maskHeaders(Object.keys(h).map((k) => [k, h[k]]));
    } catch (e) {
      return [];
    }
  }

  /* Masks obvious secrets inside a sent body, leaving the shape intact.
   *
   * JSON and form-encoded are handled because between them they are nearly every
   * API call a browser makes. Anything else is passed through as text — the cap is
   * the only protection there, and that is stated in the docs rather than pretended
   * away. */
  function maskBody(body) {
    if (typeof body !== "string" || !body) return body || "";
    const s = body.slice(0, REQ_LIMIT);
    // JSON
    if (/^[\s]*[{[]/.test(s)) {
      try {
        const walk = (v) => {
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === "object") {
            const o = {};
            Object.keys(v).forEach((k) => { o[k] = MASKED_KEY.test(k) ? MASK : walk(v[k]); });
            return o;
          }
          return v;
        };
        return JSON.stringify(walk(JSON.parse(s)));
      } catch (e) { /* not valid JSON after all — fall through */ }
    }
    // form-encoded
    if (/^[^=&\s]+=[^&]*(&|$)/.test(s) && s.indexOf("\n") === -1) {
      try {
        return s.split("&").map((kv) => {
          const i = kv.indexOf("=");
          if (i < 0) return kv;
          const k = kv.slice(0, i);
          return MASKED_KEY.test(decodeURIComponent(k)) ? k + "=" + MASK : kv;
        }).join("&");
      } catch (e) { /* leave it */ }
    }
    return s;
  }

  // A body that is not text at all. Saying which kind beats saying nothing: a
  // FormData upload failing is a different bug from a JSON call failing.
  function bodyOf(b) {
    if (b == null) return "";
    if (typeof b === "string") return maskBody(b);
    try {
      if (b instanceof URLSearchParams) return maskBody(b.toString());
      if (typeof FormData !== "undefined" && b instanceof FormData) return "<form-data, not captured>";
      if (typeof Blob !== "undefined" && b instanceof Blob) return "<blob, not captured>";
      if (b.buffer || b instanceof ArrayBuffer) return "<binary, not captured>";
    } catch (e) { /* exotic body */ }
    return "";
  }

  function report(url, status, body, req) {
    try {
      window.postMessage(
        {
          source: TAG,
          url: String(url || ""),
          status: status,
          body: String(body == null ? "" : body).slice(0, LIMIT),
          req: req || null,
        },
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
      // Read the request *before* awaiting: a Request can be consumed by the call
      // itself, and an init object can be mutated by the caller afterwards.
      let req = null;
      try {
        const input = args[0];
        const init = args[1] || {};
        const isReq = typeof Request !== "undefined" && input instanceof Request;
        req = {
          method: String((init.method || (isReq && input.method) || "GET")).toUpperCase(),
          headers: readHeaders(isReq && !init.headers ? input.headers : init.headers),
          body: bodyOf(init.body),
        };
        // A Request's own body needs a clone; the original must stay unread or the
        // page's call breaks.
        if (!req.body && isReq && input.body) {
          try {
            input.clone().text().then((t) => { req.body = maskBody(t); }, () => {});
          } catch (e) { /* already consumed */ }
        }
      } catch (e) {
        req = null;
      }
      const p = origFetch.apply(this, args);
      try {
        return p.then((res) => {
          try {
            if (res && !res.ok) {
              // clone() is not optional: reading the response consumes it, and
              // consuming the page's own body would break the page.
              res.clone().text().then(
                (t) => report(res.url, res.status, t, req),
                () => report(res.url, res.status, "", req)
              );
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
    const origSetHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      try {
        this[MARK + "_u"] = url;
        this[MARK + "_m"] = String(method || "GET").toUpperCase();
        this[MARK + "_h"] = [];
      } catch (e) { /* frozen instance */ }
      return origOpen.apply(this, arguments);
    };
    // The only way to see an XHR's headers: they are write-only once set.
    XHR.prototype.setRequestHeader = function (k, v) {
      try {
        if (!this[MARK + "_h"]) this[MARK + "_h"] = [];
        this[MARK + "_h"].push([k, v]);
      } catch (e) { /* ignore */ }
      return origSetHeader.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      let req = null;
      try {
        req = {
          method: this[MARK + "_m"] || "GET",
          headers: maskHeaders(this[MARK + "_h"] || []),
          body: bodyOf(body),
        };
      } catch (e) { /* ignore */ }
      try {
        this.addEventListener("load", () => {
          try {
            if (this.status < 400) return;
            // Only the text-ish response types can be read without touching the
            // page's own view of the data. blob and arraybuffer are skipped —
            // they are downloads, not API errors.
            const rt = this.responseType;
            let out = "";
            if (rt === "" || rt === "text") out = this.responseText;
            else if (rt === "json") out = JSON.stringify(this.response);
            report(this[MARK + "_u"] || this.responseURL, this.status, out, req);
          } catch (e) { /* cross-origin or unreadable */ }
        });
      } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }
})();
