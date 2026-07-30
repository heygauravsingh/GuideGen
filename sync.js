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

  /* Google sign-in, via chrome.identity.launchWebAuthFlow.
   *
   * Same OAuth *Web application* client as the website — one client, several
   * authorised redirect URIs. This surface needs
   * `https://<extension-id>.chromiumapp.org/`, and note that an unpacked build has
   * a different id from the store build, so BOTH have to be registered or Google
   * sign-in works in one and silently fails in the other. chrome.identity
   * .getRedirectURL() below always reports the right one for the running build.
   *
   * Until GOOGLE_CLIENT_ID is set, googleReady() is false and the popup hides its
   * Google button rather than offering one that can't work. */
  const GOOGLE_CLIENT_ID = "PASTE_GOOGLE_WEB_CLIENT_ID_HERE";

  function googleReady() {
    return /^[0-9][0-9a-z-]*\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID);
  }

  function rand(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("");
  }

  function jwtPayload(tok) {
    try {
      const b64 = String(tok).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(decodeURIComponent(atob(b64).split("").map(
        (c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)
      ).join("")));
    } catch (e) { return null; }
  }

  const store = {
    get: (k) => new Promise((r) => chrome.storage.local.get(k, (o) => r(o[k]))),
    set: (o) => new Promise((r) => chrome.storage.local.set(o, r)),
    remove: (k) => new Promise((r) => chrome.storage.local.remove(k, r)),
  };

  // ---------- auth ----------

  const MESSAGES = {
    EMAIL_EXISTS: "That email already has an account. Sign in instead — and if you set it up with Google, use Continue with Google.",
    EMAIL_NOT_FOUND: "No account with that email.",
    INVALID_PASSWORD: "Wrong password. If you signed up with Google, use Continue with Google instead.",
    INVALID_LOGIN_CREDENTIALS: "That email and password don't match. If you signed up with Google, use Continue with Google instead.",
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

  function sessionFrom(b, email, name) {
    return {
      uid: b.localId || b.user_id,
      email: email || b.email,
      name: name || b.displayName || "",
      idToken: b.idToken || b.id_token,
      refreshToken: b.refreshToken || b.refresh_token,
      expiresAt: Date.now() + (parseInt(b.expiresIn || b.expires_in, 10) - 60) * 1000,
    };
  }

  async function signUp(email, password, name) {
    const b = await idtPost(IDT + ":signUp?key=" + API_KEY,
      { email, password, returnSecureToken: true });
    const s = sessionFrom(b, email, (name || "").trim());
    await store.set({ [AUTH_KEY]: s });
    if (s.name) {
      // Never fail a signup over the display name — the account already exists.
      try {
        await idtPost(IDT + ":update?key=" + API_KEY,
          { idToken: s.idToken, displayName: s.name, returnSecureToken: false });
      } catch (e) { /* keep the local copy and move on */ }
    }
    return s;
  }

  // Opens Google in a popup window Chrome owns, and hands back the id_token from
  // the redirect fragment. Rejects if the user closes it.
  async function signInWithGoogle() {
    if (!googleReady()) throw new Error("Google sign-in isn't set up in this build yet.");
    const redirectUri = chrome.identity.getRedirectURL();
    const nonce = rand(16);
    const url = "https://accounts.google.com/o/oauth2/v2/auth" +
      "?client_id=" + encodeURIComponent(GOOGLE_CLIENT_ID) +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&response_type=id_token" +
      "&scope=" + encodeURIComponent("openid email profile") +
      "&nonce=" + encodeURIComponent(nonce) +
      "&prompt=select_account";

    let landed;
    try {
      landed = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    } catch (e) {
      throw new Error("Google sign-in was cancelled.");
    }
    const frag = new URLSearchParams(String(landed || "").split("#")[1] || "");
    const idToken = frag.get("id_token");
    if (!idToken) throw new Error("Google didn't return a sign-in token.");
    const claims = jwtPayload(idToken);
    // No `state` here: launchWebAuthFlow only ever resolves with the redirect from
    // the window it opened itself, so there is no cross-request to confuse. The
    // nonce still guards against an older token being replayed.
    if (!claims || claims.nonce !== nonce) {
      throw new Error("That sign-in couldn't be verified. Please try again.");
    }

    const b = await idtPost(IDT + ":signInWithIdp?key=" + API_KEY, {
      postBody: "id_token=" + encodeURIComponent(idToken) + "&providerId=google.com",
      requestUri: redirectUri,
      returnIdpCredential: true,
      returnSecureToken: true,
    });
    const s = sessionFrom(b, b.email, b.displayName || (claims && claims.name) || "");
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
    signInWithGoogle, googleReady,
    SITE, DASHBOARD: SITE + "/app",
  };
})();
