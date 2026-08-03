// GuideGen — toolbar popup.
//
// Two views behind one gate: sign in, or record. The session comes from FSSync
// (chrome.storage.local), and the dashboard adopts that same session over the
// bridge, so this is the only place a user types a password.

const el = (id) => document.getElementById(id);

// ---------- theme ----------
// The dashboard owns this choice and pushes it here over the bridge (gg_set_theme),
// because a 296px panel is not the place to put a third copy of the control. Read
// it before anything paints; fall back to the OS for anyone who has never chosen.
(function theme() {
  const done = (mode) => {
    const dark = mode === "dark" ||
      (mode !== "light" &&
       window.matchMedia &&
       window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.body.classList.remove("pre-theme");
  };
  try {
    chrome.storage.local.get("gg_theme", (o) => done((o && o.gg_theme) || "light"));
  } catch (e) {
    done("light");
  }
})();

const toggle = el("toggle");
const toggleLabel = el("toggleLabel");
const toggleIcon = el("toggleIcon");
const library = el("library");
const statusTitle = el("statusTitle");
const statusSub = el("statusSub");
const hint = el("hint");

const DOT = '<circle cx="12" cy="12" r="7" />';
const SQUARE = '<rect x="6" y="6" width="12" height="12" rx="2.5" />';

// ---------- recording view ----------

function render(state) {
  const rec = state && state.recording;
  const n = (state && state.stepCount) || 0;
  document.body.classList.toggle("rec", !!rec);
  if (rec) {
    toggleLabel.textContent = "Stop & edit";
    toggleIcon.innerHTML = SQUARE;
    statusTitle.textContent = "Recording…";
    statusSub.textContent = n === 1 ? "1 step captured" : n + " steps captured";
    hint.textContent = "Do your workflow as normal, then stop to edit the guide.";
  } else {
    toggleLabel.textContent = "Start recording";
    toggleIcon.innerHTML = DOT;
    statusTitle.textContent = "Ready to record";
    statusSub.textContent = "Every click becomes a step";
    hint.textContent =
      "Tip: if a tab was open before you installed GuideGen, reload it once before recording.";
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: "fs_get_state" }, (s) => {
    if (chrome.runtime.lastError) return;
    render(s || { recording: false });
  });
}

toggle.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "fs_get_state" }, (s) => {
    if (s && s.recording) {
      chrome.runtime.sendMessage({ type: "fs_stop" }, (resp) => {
        if (resp && resp.guideId)
          chrome.runtime.sendMessage({ type: "fs_open_editor", guideId: resp.guideId });
        window.close();
      });
    } else {
      chrome.runtime.sendMessage({ type: "fs_start" }, () => window.close());
    }
  });
});

library.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "fs_open_editor" }, () => window.close());
});

// ---------- catch-up capture ----------
//
// Armed per origin, off by default. The worker owns the origin list and the
// buffer; this is a switch and the redeem buttons over it. Arming needs the tab's
// own url, so a page with no origin — chrome://, the Web Store, a PDF — hides the
// card entirely rather than offering a switch that cannot do anything.
//
// **This is the only place minutes become a guide.** The on-page dot is bare
// disclosure with no button, so the primary action here has to be the one people
// actually want — the last two minutes — with the whole session as the fallback
// for when two minutes wasn't enough.

let bufOrigin = "";
let bufTabId = null;
let bufSession = null;
// BUF.sliceMs in background.js is the source of truth for what "last 2 minutes"
// means; this mirrors whatever it says rather than hard-coding a 2 that would
// drift out of the button label the moment that constant changed.
let bufSliceMins = 2;

function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

// "3:42 PM", so "everything since" reads as a time rather than a duration.
function clockTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

function bufRender(r) {
  const card = el("bufCard");
  if (!r || !r.origin) { card.hidden = true; return; }
  card.hidden = false;
  bufOrigin = r.origin;
  bufSession = r.session || null;
  const host = r.origin.replace(/^https?:\/\//, "");
  const mins = r.sliceMinutes || 2;
  bufSliceMins = mins;
  const held = bufSession ? bufSession.stepCount : 0;
  const slice = bufSession ? bufSession.sliceCount : 0;

  el("bufArm").checked = !!r.armed;
  // Both action rows go together: an armed site with nothing held yet has nothing
  // to capture, and a button that can only fail is worse than no button.
  el("bufActs").hidden = !(r.armed && held);
  el("bufActs2").hidden = !(r.armed && held);

  if (r.armed && held) {
    el("bufSlice").textContent =
      slice ? "Capture last " + mins + " minutes (" + plural(slice, "step") + ")"
            : "Capture last " + mins + " minutes";
    el("bufSlice").disabled = !slice;
    el("bufAll").textContent = "Capture all " + held;
    el("bufSub").textContent =
      plural(held, "step") + " held for " + host + " since " +
      clockTime(bufSession.startedAt) + ". Kept for " + (r.days || 7) +
      " days unless you capture it.";
  } else if (r.armed) {
    el("bufSub").textContent =
      "Watching " + host + ". Do something, then come back and capture the last " +
      mins + " minutes of it.";
  } else {
    el("bufSub").textContent =
      "Keeps what you do on " + host + " for " + (r.days || 7) + " days so you can " +
      "turn the last " + mins + " minutes into a guide afterwards. Never uploaded, " +
      "never leaves this device.";
  }
}

function bufRefresh() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs && tabs[0];
    bufTabId = t ? t.id : null;
    chrome.runtime.sendMessage({ type: "fs_buf_status", url: (t && t.url) || "" }, (r) => {
      if (chrome.runtime.lastError) return;
      bufRender(r);
    });
  });
}

el("bufArm").addEventListener("change", (e) => {
  const on = e.target.checked;
  chrome.runtime.sendMessage(
    { type: "fs_buf_arm", origin: bufOrigin, on, tabId: bufTabId },
    () => {
      if (chrome.runtime.lastError) return;
      bufRefresh();
    }
  );
});

// Both redeem buttons take the same path: promote a slice of *this origin's*
// session, then open the editor on the new guide. Passing the session id rather
// than letting the worker pick the newest is what stops a click in another tab
// redirecting this button onto a site the user isn't looking at.
function bufPromote(btn, minutes) {
  const b = el(btn);
  b.disabled = true;
  chrome.runtime.sendMessage(
    {
      type: "fs_buf_promote",
      sessionId: bufSession ? bufSession.id : "",
      minutes: minutes || 0,
    },
    (r) => {
      b.disabled = false;
      if (chrome.runtime.lastError) return;
      if (r && r.ok) {
        chrome.runtime.sendMessage({ type: "fs_open_editor", guideId: r.guideId }, () =>
          window.close()
        );
      } else {
        el("bufSub").textContent = (r && r.error) || "Nothing captured yet.";
      }
    }
  );
}

el("bufSlice").addEventListener("click", () => bufPromote("bufSlice", bufSliceMins));
el("bufAll").addEventListener("click", () => bufPromote("bufAll", 0));

el("bufClear").addEventListener("click", () => {
  // Discards this site's session, not the whole buffer. Another armed site's
  // minutes are not this button's business.
  chrome.runtime.sendMessage(
    { type: "fs_buf_discard", sessionId: bufSession ? bufSession.id : "" },
    () => bufRefresh()
  );
});

// ---------- auth view ----------

let mode = "signin"; // or "signup"

function applyMode() {
  const up = mode === "signup";
  el("authTitle").textContent = up ? "Create an account" : "Sign in";
  el("authSub").textContent = up
    ? "Your guides still stay on this machine — an account is what lets you publish one."
    : "GuideGen needs an account before it records.";
  el("authSubmit").textContent = up ? "Create account" : "Sign in";
  el("altText").textContent = up ? "Already have an account?" : "New here?";
  el("altToggle").textContent = up ? "Sign in" : "Create an account";
  el("password").autocomplete = up ? "new-password" : "current-password";
  // Password signups only. Google supplies the name with the token, so asking for
  // it again would be asking for something we already have.
  el("nameField").hidden = !up;
  el("forgotWrap").hidden = up;
  say("");
}

// Hidden unless an OAuth client id is configured — a Google button that can't work
// is worse than none.
(function wireGoogle() {
  if (!FSSync.googleReady()) return;
  el("googleWrap").hidden = false;
  /* Handed to the service worker rather than run here. Chrome closes this popup as
   * soon as Google's window takes focus, so a flow started here dies half-finished
   * with nothing to report — see signInWithGoogle in sync.js.
   *
   * Both outcomes below are therefore best-effort: usually this popup is already gone
   * by the time the worker answers. That's fine, because the worker stores the
   * session, so reopening the popup lands on the signed-in view. The message telling
   * the user to do that is the important part — the window vanishing with no
   * explanation is what makes this look broken. */
  el("googleBtn").addEventListener("click", () => {
    el("googleBtn").disabled = true;
    say("Opening Google… you may need to reopen this popup afterwards.");
    chrome.runtime.sendMessage({ type: "fs_google_signin" }, (resp) => {
      if (chrome.runtime.lastError) return;      // popup outlived by the flow
      if (resp && resp.ok) return showMain(resp.session);
      el("googleBtn").disabled = false;
      say((resp && resp.error) || "Google sign-in didn't complete.", "err");
    });
  });

  /* If the popup does happen to survive the round trip, this is what updates it —
   * the worker writes the session to storage, so the popup doesn't depend on
   * receiving a reply it may not be alive for. */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.gg_auth) return;
    const s = changes.gg_auth.newValue;
    if (s) showMain(s);
  });
})();

function say(text, kind) {
  const m = el("authMsg");
  m.textContent = text || "";
  m.className = "msg" + (kind ? " " + kind : "");
}

el("altToggle").addEventListener("click", () => {
  mode = mode === "signup" ? "signin" : "signup";
  applyMode();
});

el("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = el("email").value.trim();
  const pw = el("password").value;
  const name = el("fullName").value.trim();
  if (mode === "signup" && name.length < 2) return say("Enter your full name.", "err");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return say("Enter a valid email address.", "err");
  if (!pw) return say("Enter your password.", "err");
  if (mode === "signup" && pw.length < 6) return say("Password needs at least 6 characters.", "err");

  el("authSubmit").disabled = true;
  say(mode === "signup" ? "Creating your account…" : "Signing in…");
  try {
    const s = mode === "signup"
      ? await FSSync.signUp(email, pw, name)
      : await FSSync.signIn(email, pw);
    showMain(s);
  } catch (err) {
    el("authSubmit").disabled = false;
    say(err.message, "err");
  }
});

el("forgot").addEventListener("click", async () => {
  const email = el("email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return say("Type your email above first, then click this again.", "err");
  }
  say("Sending reset email…");
  try {
    await FSSync.sendPasswordReset(email);
    say("Reset link sent to " + email + ".", "ok");
  } catch (err) {
    say(err.message, "err");
  }
});

el("signOut").addEventListener("click", async () => {
  await FSSync.signOut();
  // Always come back to Sign in. Left in sign-up mode, a returning user gets
  // "that email already has an account" for their own credentials.
  mode = "signin";
  el("email").value = "";
  el("password").value = "";
  el("fullName").value = "";
  applyMode();
  showAuth();
});

// ---------- routing ----------

function showAuth() {
  el("viewMain").hidden = true;
  el("viewAuth").hidden = false;
  el("email").focus();
}

function showMain(session) {
  el("viewAuth").hidden = true;
  el("viewMain").hidden = false;
  el("acctEmail").textContent = session.name || session.email || "";
  el("acctEmail").title = session.email || "";
  refresh();
  bufRefresh();
}

(async () => {
  applyMode();
  const s = await FSSync.current();
  if (s) showMain(s);
  else showAuth();
})();
