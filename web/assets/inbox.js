/* /inbox — everything the forms in the house have sent, newest first.
 *
 * Why it lives in this repo rather than on backpocket.website: the submissions all land in
 * *this* project's `waitlist` collection, and this site already has the auth and Firestore
 * plumbing (`gg.js`). The house page has no sign-in at all, and adding one there to read a
 * collection that lives here would be two copies of the same thing.
 *
 * Access is enforced by `firebase/firestore.rules`, not by this page. The rule allows read
 * only for the owner's verified token email; without it, this file could be opened by
 * anyone and would come back empty-handed. Never "helpfully" widen that rule to make the
 * page work for someone who is locked out — being locked out is the feature.
 *
 * Older idiom (`var`, `function`) to match the rest of web/assets.
 */
(function () {
  var API_KEY = "AIzaSyCihDiLQ51V0C8DS07WTl70FOpC3ACkfJY";
  var PROJECT = "guidegen-1f938";
  var QUERY = "https://firestore.googleapis.com/v1/projects/" + PROJECT +
              "/databases/(default)/documents:runQuery?key=" + API_KEY;

  function el(id) { return document.getElementById(id); }

  /* The prefix in `note` is what tells the four kinds of submission apart — one collection,
     no rules change per form. Anything unprefixed is a plain email signup. */
  var KINDS = [
    { key: "all", label: "Everything", match: function () { return true; } },
    { key: "hi", label: "Messages", match: function (n) { return n.indexOf("hi:") === 0; } },
    { key: "rain", label: "Competition", match: function (n) { return n.indexOf("rain:") === 0; } },
    { key: "vote", label: "Votes", match: function (n) { return n.indexOf("vote:") === 0; } },
    { key: "list", label: "Email list", match: function (n) {
        return n.indexOf("hi:") !== 0 && n.indexOf("rain:") !== 0 && n.indexOf("vote:") !== 0;
      } },
  ];

  var rows = [];
  var kind = "all";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleString(undefined, {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
  }

  /* Firestore's REST shape is one wrapper object per value. `gg.js` already has a decoder,
     so use it rather than writing a second one that drifts. */
  function decode(doc) {
    var f = window.GG.decodeFields(doc.fields || {});
    var note = String(f.note || "");
    var body = note.replace(/^(hi|rain|vote):/, "");
    return {
      email: String(f.email || ""),
      note: note,
      body: body,
      shots: Array.isArray(f.shots) ? f.shots : [],
      // The client sends `createdAt`; `createTime` is the server's own and cannot be
      // forged, so it wins when both exist.
      at: doc.createTime || f.createdAt || "",
    };
  }

  function load() {
    var box = el("ib-list");
    box.innerHTML = '<p class="ib-note">Loading…</p>';
    return window.GG.getToken().then(function (token) {
      return fetch(QUERY, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "waitlist" }],
            orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
            limit: 500,
          },
        }),
      });
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var m = (j && j.error && j.error.message) || ("HTTP " + r.status);
          throw new Error(m);
        }
        return j;
      });
    }).then(function (j) {
      rows = (j || []).filter(function (x) { return x && x.document; })
                      .map(function (x) { return decode(x.document); });
      paint();
    }).catch(function (err) {
      /* A permission error here means one specific thing, so say that rather than the raw
         Firestore text: the rule names one address and this session is not it. */
      var permission = /permission|PERMISSION_DENIED|insufficient/i.test(err.message);
      box.innerHTML = '<p class="ib-err">' + esc(err.message) + "</p>" +
        (permission
          ? '<p class="ib-note">The read rule in <code>firestore.rules</code> allows one ' +
            "email address. This session is signed in as <b>" +
            esc((window.GG.current() || {}).email || "nobody") + "</b>. Either sign in with " +
            "the address named in the rule, or change the rule and publish it in the " +
            "Firebase console.</p>"
          : "");
    });
  }

  function paint() {
    var box = el("ib-list");
    var list = rows.filter(function (r) {
      var k = KINDS.filter(function (x) { return x.key === kind; })[0];
      return k ? k.match(r.note) : true;
    });

    [].forEach.call(document.querySelectorAll("[data-kind]"), function (b) {
      var k = b.getAttribute("data-kind");
      var n = rows.filter(function (r) {
        var d = KINDS.filter(function (x) { return x.key === k; })[0];
        return d ? d.match(r.note) : true;
      }).length;
      b.classList.toggle("on", k === kind);
      var c = b.querySelector(".ib-n");
      if (c) c.textContent = n;
    });

    if (!list.length) {
      box.innerHTML = '<p class="ib-note">Nothing here yet.</p>';
      return;
    }

    box.innerHTML = list.map(function (r) {
      var shots = r.shots.map(function (u) {
        // Opened in a new tab rather than a lightbox: these are images a stranger uploaded,
        // and a click that leaves this page is the least surprising thing to do with one.
        return '<a class="ib-shot" href="' + esc(u) + '" target="_blank" rel="noopener">' +
               '<img src="' + esc(u) + '" alt="" loading="lazy" /></a>';
      }).join("");
      return '<div class="ib-row">' +
        '<div class="ib-top">' +
          '<a class="ib-mail" href="mailto:' + esc(r.email) + '">' + esc(r.email) + "</a>" +
          '<span class="ib-when">' + esc(when(r.at)) + "</span>" +
        "</div>" +
        '<p class="ib-body">' + (esc(r.body) || "<i>(nothing)</i>") + "</p>" +
        (shots ? '<div class="ib-shots">' + shots + "</div>" : "") +
        "</div>";
    }).join("");
  }

  // ---------------------------------------------------------------- boot

  function start() {
    var session = window.GG.current();
    if (!session) {
      el("ib-gate").hidden = false;
      el("ib-main").hidden = true;
      return;
    }
    el("ib-gate").hidden = true;
    el("ib-main").hidden = false;
    el("ib-who").textContent = session.email || "";

    el("ib-tabs").innerHTML = KINDS.map(function (k) {
      return '<button class="ib-tab" data-kind="' + k.key + '">' + k.label +
             ' <span class="ib-n">0</span></button>';
    }).join("");
    el("ib-tabs").addEventListener("click", function (e) {
      var b = e.target.closest("[data-kind]");
      if (!b) return;
      kind = b.getAttribute("data-kind");
      paint();
    });
    el("ib-reload").addEventListener("click", load);

    /* One button that turns whatever is on screen into a list of addresses. The reason this
       page exists is to act on submissions, and every action starts with the emails. */
    el("ib-copy").addEventListener("click", function () {
      var k = KINDS.filter(function (x) { return x.key === kind; })[0];
      var mails = rows.filter(function (r) { return k ? k.match(r.note) : true; })
                      .map(function (r) { return r.email; });
      var uniq = mails.filter(function (m, i) { return mails.indexOf(m) === i; });
      if (!uniq.length) return;
      navigator.clipboard.writeText(uniq.join(", ")).then(function () {
        el("ib-copy").textContent = "Copied " + uniq.length;
        setTimeout(function () { el("ib-copy").textContent = "Copy addresses"; }, 2000);
      });
    });

    load();
  }

  if (window.GG) start();
})();
