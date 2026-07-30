/* GuideGen — auth + data access over Firebase REST.
 *
 * No Firebase SDK: the site loads nothing from an external host, and every call
 * here is one that can be reproduced with curl. Security lives in the Firestore
 * rules (firebase/firestore.rules), not in this file — treat everything below as
 * hostile-editable, because it is.
 */
window.GG = (function () {
  var API_KEY = "AIzaSyCihDiLQ51V0C8DS07WTl70FOpC3ACkfJY";
  var PROJECT = "guidegen-1f938";
  var IDT = "https://identitytoolkit.googleapis.com/v1/accounts";
  var TOKEN = "https://securetoken.googleapis.com/v1/token";
  var FS = "https://firestore.googleapis.com/v1/projects/" + PROJECT +
           "/databases/(default)/documents";
  var STORE_KEY = "gg_auth";

  /* Google sign-in.
   *
   * Done as a plain OAuth redirect, NOT with Google Identity Services, because the
   * rule at the top of this file is that the site loads nothing from an external
   * host — and GIS is a remote script. A redirect costs one page load and keeps
   * that intact.
   *
   * Paste the OAuth 2.0 *Web application* client id below. One client covers every
   * surface; it needs three authorised redirect URIs:
   *
   *   https://guide-gen.vercel.app/auth                     (this site)
   *   https://<store-extension-id>.chromiumapp.org/         (the popup)
   *   https://<unpacked-extension-id>.chromiumapp.org/      (your dev build)
   *
   * Until it's set, googleReady() is false and every Google button stays hidden.
   * A visible button that always fails is worse than no button. */
  var GOOGLE_CLIENT_ID = "PASTE_GOOGLE_WEB_CLIENT_ID_HERE";
  var OAUTH_KEY = "gg_oauth";

  function googleReady() {
    return /^[0-9][0-9a-z-]*\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID);
  }

  function rand(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) {
      return x.toString(36).padStart(2, "0");
    }).join("");
  }

  // Reads the payload without verifying the signature — Firebase does that when it
  // exchanges the token. This is only here to check the nonce we sent came back.
  function jwtPayload(tok) {
    try {
      var b64 = String(tok).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      var json = decodeURIComponent(atob(b64).split("").map(function (c) {
        return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(""));
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  // ---------- session ----------

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); }
    catch (e) { return null; }
  }
  function save(s) {
    if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORE_KEY);
    listeners.forEach(function (fn) { fn(s); });
  }
  var listeners = [];
  function onChange(fn) { listeners.push(fn); fn(load()); }

  function session(body) {
    return {
      uid: body.localId || body.user_id,
      email: body.email || (load() || {}).email,
      // Refresh responses carry no profile, so fall back to what we already had
      // rather than blanking the name on every token refresh.
      name: body.displayName || (load() || {}).name || "",
      idToken: body.idToken || body.id_token,
      refreshToken: body.refreshToken || body.refresh_token,
      // refresh a minute early rather than discovering expiry mid-request
      expiresAt: Date.now() + (parseInt(body.expiresIn || body.expires_in, 10) - 60) * 1000,
    };
  }

  // Google's error strings are shouty constants; make them human.
  var MESSAGES = {
    EMAIL_EXISTS: "That email already has an account. Sign in instead — and if you set it up with Google, use Continue with Google.",
    EMAIL_NOT_FOUND: "No account with that email.",
    INVALID_PASSWORD: "Wrong password. If you signed up with Google, use Continue with Google instead.",
    INVALID_LOGIN_CREDENTIALS: "That email and password don't match. If you signed up with Google, use Continue with Google instead.",
    WEAK_PASSWORD: "Password needs to be at least 6 characters.",
    INVALID_EMAIL: "That doesn't look like a valid email address.",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts. Wait a few minutes and try again.",
    USER_DISABLED: "That account has been disabled.",
  };
  function humanise(raw) {
    if (!raw) return "Something went wrong. Please try again.";
    var key = String(raw).split(" :")[0].trim();
    return MESSAGES[key] || MESSAGES[key.replace(/_.*$/, "")] ||
           "Something went wrong. Please try again.";
  }

  function post(url, body, token, form) {
    var opts = { method: "POST", headers: {} };
    if (form) {
      opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
      opts.body = Object.keys(body).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(body[k]);
      }).join("&");
    } else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    if (token) opts.headers.Authorization = "Bearer " + token;
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var e = new Error(humanise(j && j.error && j.error.message));
          e.raw = j && j.error && j.error.message;
          throw e;
        }
        return j;
      });
    });
  }

  function signUp(email, password, name) {
    return post(IDT + ":signUp?key=" + API_KEY,
                { email: email, password: password, returnSecureToken: true })
      .then(function (b) {
        var s = session(b);
        s.email = email;
        s.name = (name || "").trim();
        save(s);
        if (!s.name) return s;
        // Write it to the account too, so it survives a sign-out and shows up for
        // anything that reads the profile rather than our local copy. Never fail a
        // signup over it — the account exists by this point either way.
        return post(IDT + ":update?key=" + API_KEY,
                    { idToken: s.idToken, displayName: s.name, returnSecureToken: false })
          .then(function () { return s; }, function () { return s; });
      });
  }

  function signIn(email, password) {
    return post(IDT + ":signInWithPassword?key=" + API_KEY,
                { email: email, password: password, returnSecureToken: true })
      .then(function (b) {
        var s = session(b); s.email = email; save(s); return s;
      });
  }

  // Step one: hand off to Google. Nothing is stored except what we need to verify
  // the round trip, and that lives in sessionStorage so it dies with the tab.
  function beginGoogle(returnTo) {
    if (!googleReady()) {
      return Promise.reject(new Error("Google sign-in isn't set up on this deployment yet."));
    }
    var state = rand(16);
    var nonce = rand(16);
    try {
      sessionStorage.setItem(OAUTH_KEY, JSON.stringify({
        state: state,
        nonce: nonce,
        returnTo: returnTo || (location.pathname + location.search + location.hash),
      }));
    } catch (e) {
      return Promise.reject(new Error("Your browser is blocking session storage, which Google sign-in needs."));
    }
    location.assign(
      "https://accounts.google.com/o/oauth2/v2/auth" +
      "?client_id=" + encodeURIComponent(GOOGLE_CLIENT_ID) +
      "&redirect_uri=" + encodeURIComponent(location.origin + "/auth") +
      "&response_type=id_token" +
      "&scope=" + encodeURIComponent("openid email profile") +
      "&nonce=" + encodeURIComponent(nonce) +
      "&state=" + encodeURIComponent(state) +
      // So someone with several Google accounts isn't silently signed in as the
      // wrong one, which is very hard to notice and annoying to undo.
      "&prompt=select_account"
    );
    return new Promise(function () {});   // navigating away; never settles
  }

  // Step two, on /auth: verify the round trip, then trade the Google token for a
  // Firebase session. Resolves with where to send the user back to.
  function completeGoogle() {
    var frag = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(OAUTH_KEY) || "null"); } catch (e) {}
    try { sessionStorage.removeItem(OAUTH_KEY); } catch (e) {}
    var back = (saved && saved.returnTo) || "/app";

    var fail = function (msg) {
      var e = new Error(msg);
      e.returnTo = back;
      return Promise.reject(e);
    };

    var err = frag.get("error");
    if (err) {
      return fail(err === "access_denied"
        ? "Google sign-in was cancelled."
        : "Google turned that sign-in down.");
    }

    var idToken = frag.get("id_token");
    // state proves the response belongs to a request this tab made; nonce proves
    // the token itself isn't a replay of an older one.
    if (!idToken || !saved || frag.get("state") !== saved.state) {
      return fail("That sign-in couldn't be verified. Please start again.");
    }
    var claims = jwtPayload(idToken);
    if (!claims || claims.nonce !== saved.nonce) {
      return fail("That sign-in couldn't be verified. Please start again.");
    }

    return post(IDT + ":signInWithIdp?key=" + API_KEY, {
      postBody: "id_token=" + encodeURIComponent(idToken) + "&providerId=google.com",
      requestUri: location.origin,
      returnIdpCredential: true,
      returnSecureToken: true,
    }).then(function (b) {
      var s = session(b);
      s.email = b.email || s.email;
      s.name = b.displayName || (claims && claims.name) || s.name || "";
      save(s);
      return { session: s, returnTo: back };
    }, function (e) {
      e.returnTo = back;
      throw e;
    });
  }

  function signOut() { save(null); }

  // Take over a session the extension already holds, so signing in at the popup
  // doesn't mean signing in again here. Only ever called with what the extension
  // handed over across the bridge — and only if this page has no session of its
  // own, so it can never stomp on the account someone is already using here.
  function adopt(s) {
    if (!s || !s.idToken || !s.refreshToken || !s.uid) return null;
    if (load()) return load();
    save({
      uid: s.uid,
      email: s.email || "",
      idToken: s.idToken,
      refreshToken: s.refreshToken,
      // Trust the extension's own expiry, but never a stale one.
      expiresAt: typeof s.expiresAt === "number" ? s.expiresAt : 0,
    });
    return load();
  }

  function sendPasswordReset(email) {
    return post(IDT + ":sendOobCode?key=" + API_KEY,
                { requestType: "PASSWORD_RESET", email: email });
  }

  // Returns a valid idToken, refreshing it if it's within a minute of expiry.
  var refreshing = null;
  function getToken() {
    var s = load();
    if (!s) return Promise.reject(new Error("not signed in"));
    if (Date.now() < s.expiresAt) return Promise.resolve(s.idToken);
    if (refreshing) return refreshing;
    refreshing = post(TOKEN + "?key=" + API_KEY,
                      { grant_type: "refresh_token", refresh_token: s.refreshToken },
                      null, true)
      .then(function (b) {
        var next = session(b);
        next.email = s.email;
        save(next);
        refreshing = null;
        return next.idToken;
      })
      .catch(function (e) {
        refreshing = null;
        save(null);           // refresh token dead — force a fresh sign-in
        throw e;
      });
    return refreshing;
  }

  // ---------- Firestore value coding ----------

  function decode(v) {
    if (v == null) return null;
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return parseInt(v.integerValue, 10);
    if ("doubleValue" in v) return v.doubleValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("timestampValue" in v) return v.timestampValue;
    if ("nullValue" in v) return null;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
    if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
    return null;
  }
  function decodeFields(f) {
    var out = {};
    Object.keys(f).forEach(function (k) { out[k] = decode(f[k]); });
    return out;
  }
  function encode(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "string") return { stringValue: v };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") {
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    }
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
    if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
    return { nullValue: null };
  }
  function encodeFields(o) {
    var out = {};
    Object.keys(o).forEach(function (k) { out[k] = encode(o[k]); });
    return out;
  }

  // ---------- guides ----------

  // Deliberately no orderBy: pairing an equality filter with orderBy on another
  // field needs a composite index, which would be one more console step. Guide
  // counts per user are small, so sort here instead.
  function listGuides() {
    var s = load();
    if (!s) return Promise.reject(new Error("not signed in"));
    return getToken().then(function (tok) {
      return post(FS + ":runQuery", {
        structuredQuery: {
          from: [{ collectionId: "guides" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "ownerUid" },
              op: "EQUAL",
              value: { stringValue: s.uid },
            },
          },
          limit: 300,
        },
      }, tok);
    }).then(function (rows) {
      return (rows || [])
        .filter(function (r) { return r.document; })
        .map(function (r) {
          var g = decodeFields(r.document.fields || {});
          g.id = r.document.name.split("/").pop();
          g.createdAt = g.createdAt || r.document.createTime;
          return g;
        })
        .sort(function (a, b) {
          return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
        });
    });
  }

  // Public read — no token. Works only for guides with visibility 'link',
  // which is enforced by the rules, not here.
  function getPublicGuide(id) {
    return fetch(FS + "/guides/" + encodeURIComponent(id) + "?key=" + API_KEY)
      .then(function (r) {
        if (r.status === 403 || r.status === 404) {
          var e = new Error("not-found");
          e.code = r.status;
          throw e;
        }
        if (!r.ok) throw new Error("failed");
        return r.json();
      })
      .then(function (doc) {
        var g = decodeFields(doc.fields || {});
        g.id = id;
        return g;
      });
  }

  function setVisibility(id, visibility) {
    return getToken().then(function (tok) {
      return fetch(FS + "/guides/" + encodeURIComponent(id) +
                   "?updateMask.fieldPaths=visibility", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
        body: JSON.stringify({ fields: { visibility: { stringValue: visibility } } }),
      }).then(function (r) {
        if (!r.ok) throw new Error("Couldn't change sharing for that guide.");
        return true;
      });
    });
  }

  function renameGuide(id, title) {
    return getToken().then(function (tok) {
      return fetch(FS + "/guides/" + encodeURIComponent(id) +
                   "?updateMask.fieldPaths=title", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
        body: JSON.stringify({ fields: { title: { stringValue: title } } }),
      }).then(function (r) {
        if (!r.ok) throw new Error("Couldn't rename that guide.");
        return true;
      });
    });
  }

  // Create one guide document. The auto-assigned id becomes the public URL slug —
  // 20 random characters, so it's already unguessable and needs no slug scheme.
  function createGuide(plain) {
    return getToken().then(function (tok) {
      var fields = encodeFields(plain);
      // createdAt has to be a real timestamp, which encode() can't express.
      fields.createdAt = { timestampValue: new Date().toISOString() };
      return post(FS + "/guides", { fields: fields }, tok).then(function (doc) {
        if (!doc || !doc.name) throw new Error("Publishing failed.");
        return doc.name.split("/").pop();
      });
    });
  }

  // PATCH exactly the fields given, and no others: the update mask is derived from
  // the keys, so ownerUid, createdAt and visibility survive an edit untouched.
  // Firestore replaces an unmasked document wholesale, which would silently strip
  // them.
  function patchGuide(id, plain) {
    var keys = Object.keys(plain || {});
    if (!keys.length) return Promise.resolve(true);
    var masks = keys.map(function (k) { return "updateMask.fieldPaths=" + encodeURIComponent(k); });
    return getToken().then(function (tok) {
      return fetch(FS + "/guides/" + encodeURIComponent(id) + "?" + masks.join("&"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
        body: JSON.stringify({ fields: encodeFields(plain) }),
      }).then(function (r) {
        if (!r.ok) throw new Error("Couldn't save those changes.");
        return true;
      });
    });
  }

  // Patch title and/or step text on a published guide. Images are not touched —
  // they were rendered with annotations baked in at publish time, so changing one
  // means re-publishing from the machine that holds the original.
  function updateGuide(id, patch) {
    var plain = {};
    if (typeof patch.title === "string") plain.title = patch.title;
    if (Array.isArray(patch.steps)) {
      plain.steps = patch.steps;
      plain.stepCount = patch.steps.length;
    }
    return patchGuide(id, plain);
  }

  // One owned guide, by id. listGuides() already returns everything, but a deep
  // link to the editor shouldn't have to download the whole library first.
  function getGuide(id) {
    return getToken().then(function (tok) {
      return fetch(FS + "/guides/" + encodeURIComponent(id), {
        headers: { Authorization: "Bearer " + tok },
      }).then(function (r) {
        if (r.status === 403 || r.status === 404) throw new Error("That guide doesn't exist, or isn't yours.");
        if (!r.ok) throw new Error("Couldn't load that guide.");
        return r.json();
      }).then(function (doc) {
        var g = decodeFields(doc.fields || {});
        g.id = id;
        g.createdAt = g.createdAt || doc.createTime;
        return g;
      });
    });
  }

  // ---------- exports: the owner's switch, and the log ----------

  // Whether recipients are offered one-click exports on the public page.
  //
  // This is NOT an access control and must never be described as one. The step
  // images are already publicly retrievable at their own URLs — anyone with the
  // link can right-click-save them, print the page, or screenshot it, switch off
  // or on. All this governs is whether the convenience button appears.
  function setAllowExport(id, allowed) {
    return patchGuide(id, { allowExport: !!allowed });
  }

  // Recorded by the *recipient* after a successful export, so it is the one write
  // in the product performed by someone who doesn't own the document. uid and
  // email are both checked against the caller's token by the rules, and there is
  // deliberately no client timestamp — the time is the document's createTime,
  // which a client cannot forge.
  function logExport(guideId, kind) {
    var s = load();
    if (!s) return Promise.reject(new Error("not signed in"));
    return getToken().then(function (tok) {
      return post(FS + "/guides/" + encodeURIComponent(guideId) + "/exports", {
        fields: encodeFields({ uid: s.uid, email: s.email || "", kind: kind }),
      }, tok);
    });
  }

  // The owner's view of that log. Readable only by them, per the rules.
  function listExports(guideId) {
    return getToken().then(function (tok) {
      return fetch(FS + "/guides/" + encodeURIComponent(guideId) +
                   "/exports?pageSize=300", {
        headers: { Authorization: "Bearer " + tok },
      }).then(function (r) {
        if (r.status === 403) throw new Error("That log isn't yours to read.");
        if (!r.ok) throw new Error("Couldn't load the export activity.");
        return r.json();
      }).then(function (j) {
        return (j.documents || []).map(function (d) {
          var f = decodeFields(d.fields || {});
          // createTime, not a field: the server stamped it.
          f.at = d.createTime;
          f.id = d.name.split("/").pop();
          return f;
        }).sort(function (a, b) {
          return String(b.at || "").localeCompare(String(a.at || ""));
        });
      });
    });
  }

  // Purge one Cloudinary asset tag without touching the document. Used when
  // re-publishing replaces a guide's images: the new set is uploaded under a new
  // tag, the document is patched to point at it, and then the superseded images
  // are deleted — otherwise a republish meant to *remove* something sensitive
  // would leave the old image publicly retrievable by URL.
  function purgeAssetTag(tag) {
    return getToken().then(function (tok) {
      return fetch("/api/delete-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: tok, purgeTag: tag }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok) return { ok: true, note: j.note || null };
          // Not fatal: the guide is already updated and correct. Say so instead of
          // failing a publish that actually succeeded.
          return { ok: false, note: j.detail || j.error || "Old images were not removed." };
        });
      });
    });
  }

  // Deletes the guide AND its Cloudinary images, via /api/delete-assets — the only
  // path that can remove images, since that needs the API secret. If the endpoint
  // isn't configured yet it falls back to deleting the document only, and says so,
  // rather than silently claiming the images are gone.
  function deleteGuideAndAssets(id) {
    return getToken().then(function (tok) {
      return fetch("/api/delete-assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: tok, guideId: id }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok) return { assetsDeleted: !!j.assetsDeleted, note: j.note || null };
          if (r.status === 503 || r.status === 404) {
            // endpoint missing or unconfigured — remove the record at least
            return deleteGuide(id).then(function () {
              return { assetsDeleted: false, note: j.detail || j.error || "Images were not removed." };
            });
          }
          throw new Error(j.error || "Couldn't delete that guide.");
        });
      });
    });
  }

  function deleteGuide(id) {
    return getToken().then(function (tok) {
      return fetch(FS + "/guides/" + encodeURIComponent(id), {
        method: "DELETE",
        headers: { Authorization: "Bearer " + tok },
      }).then(function (r) {
        if (!r.ok) throw new Error("Couldn't delete that guide.");
        return true;
      });
    });
  }

  return {
    signUp: signUp, signIn: signIn, signOut: signOut, adopt: adopt,
    googleReady: googleReady, beginGoogle: beginGoogle, completeGoogle: completeGoogle,
    sendPasswordReset: sendPasswordReset,
    getToken: getToken, onChange: onChange, current: load,
    listGuides: listGuides, getPublicGuide: getPublicGuide, getGuide: getGuide,
    setVisibility: setVisibility, renameGuide: renameGuide, updateGuide: updateGuide,
    createGuide: createGuide, patchGuide: patchGuide, purgeAssetTag: purgeAssetTag,
    setAllowExport: setAllowExport, logExport: logExport, listExports: listExports,
    deleteGuide: deleteGuide, deleteGuideAndAssets: deleteGuideAndAssets,
    encodeFields: encodeFields, decodeFields: decodeFields,
  };
})();
