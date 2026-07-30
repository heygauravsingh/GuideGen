// GuideGen — the extension's account session (window.FSSync)
//
// Auth only. Publishing used to live here too; it moved to the dashboard when the
// dashboard became the editor, so there is exactly one implementation of the
// upload rules rather than two to keep in step (see web/assets/publish.js).
//
// What's left is the session the popup gates on: Identity Toolkit over REST with
// plain fetch — no Firebase SDK, because the modular SDK expects a bundler and
// this project has no build step. `<all_urls>` in host_permissions already covers
// the googleapis hosts, so this needs no new permission.
//
// The session is also handed to the dashboard, once, over the bridge — see
// gg_session in background.js. Signing in twice for one product is not a feature.
(function () {
  const API_KEY = "AIzaSyCihDiLQ51V0C8DS07WTl70FOpC3ACkfJY";
  const IDT = "https://identitytoolkit.googleapis.com/v1/accounts";
  const TOKEN = "https://securetoken.googleapis.com/v1/token";
  const SITE = "https://guide-gen.vercel.app";
  const AUTH_KEY = "gg_auth";

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

  async function sendPasswordReset(email) {
    await idtPost(IDT + ":sendOobCode?key=" + API_KEY,
      { requestType: "PASSWORD_RESET", email });
    return true;
  }

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

  window.FSSync = {
    signUp, signIn, signOut, current, getToken, sendPasswordReset,
    SITE, DASHBOARD: SITE + "/app",
  };
})();
