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
      idToken: body.idToken || body.id_token,
      refreshToken: body.refreshToken || body.refresh_token,
      // refresh a minute early rather than discovering expiry mid-request
      expiresAt: Date.now() + (parseInt(body.expiresIn || body.expires_in, 10) - 60) * 1000,
    };
  }

  // Google's error strings are shouty constants; make them human.
  var MESSAGES = {
    EMAIL_EXISTS: "That email already has an account. Try signing in.",
    EMAIL_NOT_FOUND: "No account with that email.",
    INVALID_PASSWORD: "Wrong password.",
    INVALID_LOGIN_CREDENTIALS: "That email and password don't match.",
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

  function signUp(email, password) {
    return post(IDT + ":signUp?key=" + API_KEY,
                { email: email, password: password, returnSecureToken: true })
      .then(function (b) {
        var s = session(b); s.email = email; save(s); return s;
      });
  }

  function signIn(email, password) {
    return post(IDT + ":signInWithPassword?key=" + API_KEY,
                { email: email, password: password, returnSecureToken: true })
      .then(function (b) {
        var s = session(b); s.email = email; save(s); return s;
      });
  }

  function signOut() { save(null); }

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

  // Patch title and/or step text on a published guide. Images are not touched —
  // they were rendered with annotations baked in at publish time and can only be
  // regenerated by re-publishing from the extension.
  function updateGuide(id, patch) {
    var masks = [];
    var fields = {};
    if (typeof patch.title === "string") {
      masks.push("updateMask.fieldPaths=title");
      fields.title = { stringValue: patch.title };
    }
    if (Array.isArray(patch.steps)) {
      masks.push("updateMask.fieldPaths=steps");
      fields.steps = { arrayValue: { values: patch.steps.map(encode) } };
    }
    if (!masks.length) return Promise.resolve(true);
    return getToken().then(function (tok) {
      return fetch(FS + "/guides/" + encodeURIComponent(id) + "?" + masks.join("&"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok },
        body: JSON.stringify({ fields: fields }),
      }).then(function (r) {
        if (!r.ok) throw new Error("Couldn't save those changes.");
        return true;
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
    signUp: signUp, signIn: signIn, signOut: signOut,
    sendPasswordReset: sendPasswordReset,
    getToken: getToken, onChange: onChange, current: load,
    listGuides: listGuides, getPublicGuide: getPublicGuide,
    setVisibility: setVisibility, renameGuide: renameGuide, updateGuide: updateGuide,
    deleteGuide: deleteGuide, deleteGuideAndAssets: deleteGuideAndAssets,
    encodeFields: encodeFields, decodeFields: decodeFields,
  };
})();
