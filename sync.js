// GuideGen — publish a local guide to the web (window.FSSync)
//
// The extension stays the source of truth. Nothing here runs unless the user
// explicitly signs in and presses Publish, and only the guide they chose is sent.
//
// Firebase over REST with plain fetch — no SDK, because the modular SDK expects a
// bundler and this project has no build step. `<all_urls>` in host_permissions
// already covers the googleapis and cloudinary hosts, so this needs no new
// permission.
(function () {
  const API_KEY = "AIzaSyCihDiLQ51V0C8DS07WTl70FOpC3ACkfJY";
  const PROJECT = "guidegen-1f938";
  const IDT = "https://identitytoolkit.googleapis.com/v1/accounts";
  const TOKEN = "https://securetoken.googleapis.com/v1/token";
  const FS = "https://firestore.googleapis.com/v1/projects/" + PROJECT +
             "/databases/(default)/documents";
  const CLOUD = "dqrytwq5e";
  const PRESET = "GuideGen_Unsigned";
  const CLD = "https://api.cloudinary.com/v1_1/" + CLOUD + "/image/upload";
  const SITE = "https://guide-gen.vercel.app";
  const AUTH_KEY = "gg_auth";

  // Images are re-encoded to WebP before upload and served untransformed.
  // Cloudinary bills 1 credit per 1,000 derived images, so asking it to resize
  // would burn the monthly allowance — we do it here instead.
  const MAX_W = 1600;
  const QUALITY = 0.85;
  const ASPECT = 1.6;

  const store = {
    get: (k) => new Promise((r) => chrome.storage.local.get(k, (o) => r(o[k]))),
    set: (o) => new Promise((r) => chrome.storage.local.set(o, r)),
    remove: (k) => new Promise((r) => chrome.storage.local.remove(k, r)),
  };

  // ---------- auth ----------

  const MESSAGES = {
    EMAIL_EXISTS: "That email already has an account — try signing in instead.",
    EMAIL_NOT_FOUND: "No account with that email.",
    INVALID_PASSWORD: "Wrong password.",
    INVALID_LOGIN_CREDENTIALS: "That email and password don't match.",
    WEAK_PASSWORD: "Password needs to be at least 6 characters.",
    INVALID_EMAIL: "That doesn't look like a valid email address.",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts. Wait a few minutes.",
  };
  function humanise(raw) {
    const key = String(raw || "").split(" :")[0].trim();
    return MESSAGES[key] || "Something went wrong. Please try again.";
  }

  async function idtPost(path, body, form) {
    const opts = { method: "POST", headers: {} };
    if (form) {
      opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
      opts.body = Object.keys(body)
        .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(body[k]))
        .join("&");
    } else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(humanise(j && j.error && j.error.message));
    return j;
  }

  function sessionFrom(b, email) {
    return {
      uid: b.localId || b.user_id,
      email: email || b.email,
      idToken: b.idToken || b.id_token,
      refreshToken: b.refreshToken || b.refresh_token,
      expiresAt: Date.now() + (parseInt(b.expiresIn || b.expires_in, 10) - 60) * 1000,
    };
  }

  async function signUp(email, password) {
    const b = await idtPost(IDT + ":signUp?key=" + API_KEY,
      { email, password, returnSecureToken: true });
    const s = sessionFrom(b, email);
    await store.set({ [AUTH_KEY]: s });
    return s;
  }

  async function signIn(email, password) {
    const b = await idtPost(IDT + ":signInWithPassword?key=" + API_KEY,
      { email, password, returnSecureToken: true });
    const s = sessionFrom(b, email);
    await store.set({ [AUTH_KEY]: s });
    return s;
  }

  async function signOut() { await store.remove(AUTH_KEY); }
  async function current() { return (await store.get(AUTH_KEY)) || null; }

  async function getToken() {
    const s = await current();
    if (!s) throw new Error("Sign in to publish a guide.");
    if (Date.now() < s.expiresAt) return s.idToken;
    try {
      const b = await idtPost(TOKEN + "?key=" + API_KEY,
        { grant_type: "refresh_token", refresh_token: s.refreshToken }, true);
      const next = sessionFrom(b, s.email);
      await store.set({ [AUTH_KEY]: next });
      return next.idToken;
    } catch (e) {
      await signOut();                    // refresh token dead
      throw new Error("Your session expired — sign in again.");
    }
  }

  // ---------- image preparation ----------

  // Annotations are baked in here, so the viewer is a plain <img> with no canvas
  // work and the published image can't drift from what the editor showed.
  async function stepImage(step, seq) {
    const canvas = await window.FSRender.renderStep(Object.assign({}, step, { seq }));
    if (!canvas) return null;

    const roi =
      window.FSRender.focusRegion(step, canvas.width, canvas.height, ASPECT, { canvas }) ||
      { x: 0, y: 0, w: canvas.width, h: canvas.height };

    const scale = Math.min(1, MAX_W / roi.w);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(roi.w * scale));
    out.height = Math.max(1, Math.round(roi.h * scale));
    const cx = out.getContext("2d");
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, out.width, out.height);

    return new Promise((resolve, reject) => {
      out.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Could not encode step image"))),
        "image/webp",
        QUALITY
      );
    });
  }

  async function uploadImage(blob, uid, assetTag) {
    const fd = new FormData();
    fd.append("file", blob);
    fd.append("upload_preset", PRESET);
    // Tags are the only way to find and delete one user's images later via the
    // Admin API. Without them a deletion request is unanswerable.
    fd.append("tags", ["guidegen", "uid_" + uid, assetTag].join(","));
    fd.append("context", "uid=" + uid + "|asset=" + assetTag);
    const r = await fetch(CLD, { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.secure_url) {
      throw new Error("Image upload failed: " + ((j.error && j.error.message) || r.status));
    }
    return j.secure_url;
  }

  // ---------- Firestore ----------

  function enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "string") return { stringValue: v };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") {
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    }
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    if (typeof v === "object") return { mapValue: { fields: encFields(v) } };
    return { nullValue: null };
  }
  function encFields(o) {
    const out = {};
    Object.keys(o).forEach((k) => { out[k] = enc(o[k]); });
    return out;
  }

  // Every published guide gets its own random asset tag, stored on the Firestore
  // document. That tag is the ONLY way to find this guide's Cloudinary images
  // again — deletion goes through the Admin API by tag, and the dashboard only
  // ever knows the remote document id, never the local one. Do not derive this
  // from a local id: images are uploaded before the document exists.
  function newAssetTag() {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return "gg_" + Array.from(b).map((x) => x.toString(36).padStart(2, "0")).join("");
  }

  // ---------- publish ----------

  async function publish(guide, steps, opts) {
    opts = opts || {};
    const prog = (p, m) => opts.onProgress && opts.onProgress(p, m);
    const s = await current();
    if (!s) throw new Error("Sign in to publish a guide.");
    const token = await getToken();

    const assetTag = newAssetTag();
    const withShots = steps.filter((x) => x.screenshot);
    let done = 0;
    const published = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const entry = {
        seq: i + 1,
        type: step.type || "click",
        text: step.text || "",
      };
      if (step.screenshot) {
        prog(0.05 + 0.8 * (done / Math.max(1, withShots.length)),
             "Uploading image " + (done + 1) + " of " + withShots.length + "…");
        const blob = await stepImage(step, i + 1);
        if (blob) entry.imageUrl = await uploadImage(blob, s.uid, assetTag);
        done++;
      }
      published.push(entry);
    }

    prog(0.9, "Publishing…");
    const body = {
      fields: encFields({
        ownerUid: s.uid,
        title: guide.title || "Untitled guide",
        visibility: "link",
        stepCount: published.length,
        steps: published,
        assetTag: assetTag,
      }),
    };
    // createdAt must be a real timestamp, which enc() can't express
    body.fields.createdAt = { timestampValue: new Date().toISOString() };

    const r = await fetch(FS + "/guides", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.name) {
      throw new Error("Publishing failed: " + ((j.error && j.error.message) || r.status));
    }

    const remoteId = j.name.split("/").pop();
    prog(1, "Published");
    return { remoteId, assetTag, url: SITE + "/g/" + remoteId };
  }

  async function unpublish(remoteId) {
    const token = await getToken();
    const r = await fetch(FS + "/guides/" + encodeURIComponent(remoteId) +
                          "?updateMask.fieldPaths=visibility", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ fields: { visibility: { stringValue: "private" } } }),
    });
    if (!r.ok) throw new Error("Couldn't unpublish that guide.");
    return true;
  }

  window.FSSync = {
    signUp, signIn, signOut, current, getToken,
    publish, unpublish,
    SITE, DASHBOARD: SITE + "/app",
  };
})();
