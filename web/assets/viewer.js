/* GuideGen — the public guide page (/g/{id}).
 *
 * Read-only for anyone with the link. If the owner has switched exports on, a
 * signed-in reader can also generate the guide as a document on their own machine.
 *
 * Three things about that worth holding onto:
 *
 * 1. **Everything renders on the reader's device.** The images are already public
 *    URLs; this page just draws them into a PDF or a slide deck locally. No server
 *    compute, which is the reason this product's hosting can plausibly cost nothing.
 * 2. **The step images are already annotated and cropped** — baked at publish time.
 *    So every step passed to the exporters carries `baked: true`, which tells
 *    render.js and exporters.js to leave the pixels alone. Without it PPTX asks for
 *    a 2.0 crop of a 1.6 image and slices the number badge off every slide.
 * 3. **The heavy scripts load on demand.** A reader who only reads should not pay
 *    for the exporters, so render.js, exporters.js and the bridge are injected the
 *    first time someone opens the Export menu.
 */
(function () {
  var main = document.getElementById("main");
  var guide = null;
  var id = "";
  var pendingKind = null;   // the format someone asked for before signing in

  // ---------------------------------------------------------------- helpers

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function guideId() {
    var m = location.pathname.match(/\/g\/([A-Za-z0-9_-]{6,})\/?$/);
    if (m) return m[1];
    return new URLSearchParams(location.search).get("id") || "";
  }

  function fmtDate(v) {
    if (!v) return "";
    try {
      return new Date(v).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
    } catch (e) { return ""; }
  }

  /* How long the recording was — not an estimate of how long the task takes. The
     wording on the page says "recorded in" for exactly that reason. */
  function fmtDur(ms) {
    if (!ms || ms < 1000) return "";
    var s = Math.round(ms / 1000);
    if (s < 90) return s + " seconds";
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? " minute" : " minutes");
    var h = Math.floor(m / 60);
    return h + (h === 1 ? " hour" : " hours") + (m % 60 ? " " + (m % 60) + " min" : "");
  }

  function shortUrl(u) {
    try {
      var x = new URL(u);
      var s = x.hostname.replace(/^www\./, "") + (x.pathname === "/" ? "" : x.pathname);
      return s.length > 64 ? s.slice(0, 63) + "…" : s;
    } catch (e) { return String(u || "").slice(0, 64); }
  }

  // Only ever emit an href we know is http(s). A published document is data from
  // another user's machine, and `javascript:` in an href is the oldest trick there is.
  function safeUrl(u) {
    try {
      var x = new URL(u);
      return (x.protocol === "http:" || x.protocol === "https:") ? x.href : "";
    } catch (e) { return ""; }
  }

  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "";
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }

  function copyText(text, okMsg) {
    if (!navigator.clipboard) return toast("Copying isn't available in this browser.");
    navigator.clipboard.writeText(text).then(function () {
      toast(okMsg);
    }, function () {
      toast("Couldn't copy — copy it from the address bar instead.");
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3000);
  }

  function state(icon, title, body, cta) {
    main.className = "wrap narrow";
    main.innerHTML =
      '<div class="state"><div class="ico">' + icon + "</div>" +
      "<h1>" + esc(title) + "</h1><p>" + esc(body) + "</p>" +
      (cta ? '<div class="cta">' + cta + "</div>" : "") + "</div>";
  }

  var ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:22px;height:22px"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
  var ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:22px;height:22px"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>';

  // ---------------------------------------------------------------- modal

  // Same contract as the dashboard's dialogs: focus goes in, Tab stays in, and
  // closing hands focus back to whatever opened it. A reader signing in to export
  // is typing a password into this thing — Tab must not walk out of it into the
  // page behind.
  var modalReturn = null;
  var FOCUSABLE = 'button:not([disabled]), a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])';

  function closeModal() {
    var o = document.getElementById("overlay");
    o.classList.remove("open");
    o.dataset.busy = "0";
    document.body.classList.remove("modal-open");
    document.getElementById("modal").innerHTML = "";
    if (modalReturn && document.contains(modalReturn)) {
      try { modalReturn.focus(); } catch (e) { /* gone from the DOM */ }
    }
    modalReturn = null;
  }
  document.getElementById("overlay").addEventListener("click", function (e) {
    if (e.target.id === "overlay" && e.currentTarget.dataset.busy !== "1") closeModal();
  });
  document.addEventListener("keydown", function (e) {
    var o = document.getElementById("overlay");
    var open = o.classList.contains("open");
    if (e.key === "Escape" && lb) { closeLightbox(); return; }
    if (e.key === "Escape") {
      var menu = document.getElementById("exp-menu");
      if (menu) menu.classList.remove("open");
      var eb = document.getElementById("exp-btn");
      if (eb) eb.setAttribute("aria-expanded", "false");
      if (open && o.dataset.busy !== "1") closeModal();
      return;
    }
    if (e.key !== "Tab" || !open) return;
    var items = [].slice.call(document.getElementById("modal").querySelectorAll(FOCUSABLE));
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  function openModal(html) {
    modalReturn = document.activeElement;
    var m = document.getElementById("modal");
    m.innerHTML = html;
    m.setAttribute("role", "dialog");
    m.setAttribute("aria-modal", "true");
    document.body.classList.add("modal-open");
    document.getElementById("overlay").classList.add("open");
  }

  // ---------------------------------------------------------------- lazy libs

  var loading = {};
  function script(src) {
    if (loading[src]) return loading[src];
    loading[src] = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = function () { loading[src] = null; rej(new Error("Couldn't load " + src)); };
      document.head.appendChild(s);
    });
    return loading[src];
  }
  function ensureLibs() {
    return Promise.resolve()
      .then(function () { return window.FSRender || script("/assets/render.js"); })
      .then(function () { return window.FSExport || script("/assets/exporters.js"); })
      .then(function () { return window.GGBridge || script("/assets/bridge.js"); });
  }
  function ensureExportLib(kind) {
    if (kind === "pdf" && !window.jspdf) return script("/assets/lib/jspdf.umd.min.js");
    if (kind === "pptx" && !window.PptxGenJS) return script("/assets/lib/pptxgen.bundle.js");
    return Promise.resolve();
  }

  // ---------------------------------------------------------------- exporting

  // The exporters want `screenshot`; a published step calls it `imageUrl`. `baked`
  // is the important part — see the header comment.
  function exportSteps() {
    return (guide.steps || []).map(function (s, i) {
      return {
        seq: i + 1,
        type: s.type || "click",
        text: s.text || "",
        // Present on guides published after the AI handoff shipped; absent on older
        // ones, which the handoff then renders as a flat list with no page headings.
        url: s.url || "",
        pageTitle: s.pageTitle || "",
        screenshot: s.imageUrl || null,
        baked: true,
        blurs: [],
      };
    });
  }

  // The extension can't read a Cloudinary URL out of this page's DOM, so the video
  // path needs the bytes inline. Going via FSRender.loadImage reuses the CORS
  // handling the document exporters already depend on.
  function bakedDataUrls(onProgress) {
    var steps = exportSteps();
    var withImg = steps.filter(function (s) { return s.screenshot; }).length;
    var done = 0;
    return steps.reduce(function (chain, s) {
      return chain.then(function () {
        if (!s.screenshot) return;
        return window.FSRender.loadImage(s.screenshot).then(function (img) {
          var c = document.createElement("canvas");
          c.width = img.naturalWidth || img.width;
          c.height = img.naturalHeight || img.height;
          c.getContext("2d").drawImage(img, 0, 0);
          s.screenshot = c.toDataURL("image/webp", 0.92);
          done++;
          if (onProgress) onProgress(done / Math.max(1, withImg), "Preparing image " + done + " of " + withImg + "…");
        });
      });
    }, Promise.resolve()).then(function () { return steps; });
  }

  var LABEL = { html: "web page", markdown: "Markdown", pdf: "PDF", pptx: "PowerPoint",
                video: "video", ai: "AI handoff" };

  /* Text, so it needs neither an exporter library nor the images — but it does need
     exporters.js for aiText, which is loaded on demand like everything else here. */
  function copyForAI() {
    return ensureLibs().then(function () {
      var g = { title: guide.title || "Untitled guide", startUrl: guide.startUrl || "" };
      var text = window.FSExport.aiText(g, exportSteps());
      var saved = function () {
        window.FSExport.ai(g, exportSteps());
        toast("Saved as a file — the clipboard wasn't available.");
      };
      if (!navigator.clipboard) { saved(); return record("ai"); }
      return navigator.clipboard.writeText(text).then(function () {
        toast((guide.steps || []).length + " steps copied — paste them into your assistant.");
      }, saved).then(function () { return record("ai"); });
    }).catch(function (e) { toast("Handoff failed: " + e.message); });
  }

  function runExport(kind) {
    if (!GG.current()) { pendingKind = kind; return signInModal(kind); }

    if (kind === "video") return videoModal();
    if (kind === "ai") return copyForAI();

    toast("Building the " + LABEL[kind] + "… this runs on your machine.");
    return ensureLibs()
      .then(function () { return ensureExportLib(kind); })
      .then(function () {
        var g = { title: guide.title || "Untitled guide", createdAt: guide.createdAt };
        var steps = exportSteps();
        if (kind === "html") return window.FSExport.html(g, steps);
        if (kind === "markdown") return window.FSExport.markdown(g, steps);
        if (kind === "pdf") return window.FSExport.pdf(g, steps);
        if (kind === "pptx") return window.FSExport.pptx(g, steps);
      })
      .then(function () {
        toast("Done — check your downloads.");
        return record(kind);
      })
      .catch(function (e) { toast("Export failed: " + e.message); });
  }

  // Best effort, and deliberately so: the export has already happened on the
  // reader's machine by this point. A logging failure must never present itself as
  // a failed export.
  function record(kind) {
    return GG.logExport(id, kind).catch(function () {});
  }

  // ---------------------------------------------------------------- sign-in gate

  function signInModal(kind) {
    var mode = "signin";

    function paint() {
      var up = mode === "signup";
      openModal(
        "<h3>" + (up ? "Create an account to export" : "Sign in to export") + "</h3>" +
        "<p>Exports are generated on your own computer — the " + esc(LABEL[kind] || "file") +
        " is built in this browser and downloaded straight to you.</p>" +
        '<div class="consent">' +
        "<b>The person who shared this guide will see that you exported it.</b> " +
        "They see your email address, which format you chose and when. Nothing else, " +
        "and nothing about anything else you do." +
        "</div>" +
        (GG.googleReady()
          ? '<button type="button" class="btn google-btn" id="si-google">' +
            '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">' +
            '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>' +
            '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"/>' +
            '<path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z"/>' +
            '<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"/>' +
            "</svg>Continue with Google</button>" +
            '<div class="or"><span>or</span></div>'
          : "") +
        (up
          ? '<div class="field"><span class="field-label">Full name</span>' +
            '<input type="text" id="si-name" autocomplete="name" /></div>'
          : "") +
        '<div class="field"><span class="field-label">Email</span>' +
        '<input type="email" id="si-email" autocomplete="email" /></div>' +
        '<div class="field"><span class="field-label">Password</span>' +
        '<input type="password" id="si-pw" autocomplete="' +
        (up ? "new-password" : "current-password") + '" /></div>' +
        '<div class="status-line" id="si-msg"></div>' +
        '<div class="row"><button class="btn" id="si-cancel">Cancel</button>' +
        '<span class="spacer"></span>' +
        '<button class="btn brand-btn" id="si-go">' +
        (up ? "Create account & export" : "Sign in & export") + "</button></div>" +
        '<div class="auth-alt">' + (up ? "Already have an account?" : "New here?") +
        ' <button type="button" id="si-alt">' + (up ? "Sign in" : "Create one") + "</button></div>"
      );
      document.getElementById("si-cancel").onclick = closeModal;
      document.getElementById("si-alt").onclick = function () {
        mode = up ? "signin" : "signup";
        paint();
      };
      document.getElementById("si-go").onclick = submit;
      document.getElementById("si-pw").onkeydown = function (e) {
        if (e.key === "Enter") submit();
      };
      var g = document.getElementById("si-google");
      if (g) {
        g.onclick = function () {
          note("Taking you to Google…");
          // Come back to this guide, and to the format they asked for, so signing in
          // doesn't lose their place or make them pick again.
          GG.beginGoogle(location.pathname + "?export=" + encodeURIComponent(kind))
            .catch(function (e) { note(e.message); });
        };
      }
      document.getElementById("si-email").focus();
    }

    function note(t) { document.getElementById("si-msg").textContent = t || ""; }

    function submit() {
      var email = document.getElementById("si-email").value.trim();
      var pw = document.getElementById("si-pw").value;
      var nameEl = document.getElementById("si-name");
      var name = nameEl ? nameEl.value.trim() : "";
      if (mode === "signup" && name.length < 2) return note("Enter your full name.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return note("Enter a valid email address.");
      if (!pw) return note("Enter your password.");
      if (mode === "signup" && pw.length < 6) return note("Password needs at least 6 characters.");
      document.getElementById("si-go").disabled = true;
      note(mode === "signup" ? "Creating your account…" : "Signing in…");
      (mode === "signup" ? GG.signUp(email, pw, name) : GG.signIn(email, pw))
        .then(function () {
          closeModal();
          renderExportBar();
          var k = pendingKind;
          pendingKind = null;
          if (k) runExport(k);
        })
        .catch(function (e) {
          document.getElementById("si-go").disabled = false;
          note(e.message);
        });
    }
    paint();
  }

  // ---------------------------------------------------------------- video

  function videoModal() {
    return ensureLibs().then(function () {
      if (!window.GGBridge.available()) return needExtension();

      var P = window.FSExport.PACES;
      var pace = window.FSExport.DEFAULT_PACE;
      openModal(
        "<h3>Narrated video</h3>" +
        "<p>The GuideGen extension renders this on your machine — a canvas, an audio " +
        "engine and a video recorder, none of which a web page can drive on its own. " +
        "The voice is synthesized locally; the first run loads the voice model.</p>" +
        '<div class="field"><span class="field-label">Pace</span><div class="segmented" id="v-pace">' +
        Object.keys(P).map(function (k) {
          return '<button type="button" data-k="' + k + '" aria-pressed="' + (k === pace) + '">' +
            P[k].label + "</button>";
        }).join("") + "</div></div>" +
        '<div class="progress" id="v-prog" style="display:none"><div></div></div>' +
        '<div class="status-line" id="v-status"></div>' +
        '<div class="row"><button class="btn" id="v-cancel">Cancel</button>' +
        '<span class="spacer"></span>' +
        '<button class="btn brand-btn" id="v-go">Create video</button></div>'
      );
      var seg = document.getElementById("v-pace");
      seg.addEventListener("click", function (e) {
        var b = e.target.closest("button[data-k]");
        if (!b) return;
        pace = b.dataset.k;
        [].forEach.call(seg.querySelectorAll("button"), function (x) {
          x.setAttribute("aria-pressed", String(x === b));
        });
      });
      document.getElementById("v-cancel").onclick = closeModal;
      document.getElementById("v-go").onclick = function () {
        var bar = document.getElementById("v-prog");
        var fill = bar.firstElementChild;
        var status = document.getElementById("v-status");
        bar.style.display = "block";
        document.getElementById("v-go").disabled = true;
        document.getElementById("v-cancel").disabled = true;
        document.getElementById("overlay").dataset.busy = "1";
        var step = function (p, m) {
          fill.style.width = Math.round((p || 0) * 100) + "%";
          if (m) status.textContent = m;
        };
        bakedDataUrls(function (p, m) { step(p * 0.15, m); })
          .then(function (steps) {
            return window.GGBridge.renderVideo(null, {
              steps: steps, title: guide.title || "Untitled guide", pace: pace, narrate: true,
            }, function (p, m) { step(0.15 + p * 0.85, m); });
          })
          .then(function () {
            status.textContent = "Done — the video is in your downloads.";
            document.getElementById("overlay").dataset.busy = "0";
            record("video");
            setTimeout(closeModal, 1800);
          })
          .catch(function (e) {
            status.textContent = "Video failed: " + e.message;
            document.getElementById("v-go").disabled = false;
            document.getElementById("v-cancel").disabled = false;
            document.getElementById("overlay").dataset.busy = "0";
          });
      };
    });
  }

  function needExtension() {
    openModal(
      "<h3>Video needs the GuideGen extension</h3>" +
      "<p>Every other format is built by this page on its own. The narrated video " +
      "can't be: it needs a canvas, an audio engine and a video recorder running " +
      "together, plus an offline voice that is too large to send over the web. All of " +
      "that ships inside the extension, and it renders on your machine — the guide " +
      "is never uploaded anywhere.</p>" +
      '<div class="consent">Already installed? Open the extension once, then come back ' +
      "and try again — it has to be running for this page to reach it.</div>" +
      '<div class="row"><button class="btn" id="ne-close">Close</button>' +
      '<span class="spacer"></span>' +
      /* `/install`, not the Chrome Web Store: the listing is still in review, so the
         store URL is a 404 for everyone who isn't signed in as the developer — this
         dialog was sending a reader who wanted the video to a dead page. `/install`
         hands them the build that exists and switches to the store link on its own
         once there is one. Opens in a new tab so they keep their place in the guide
         they were reading. */
      '<a class="btn brand-btn" target="_blank" rel="noopener" href="/install">' +
      "Get the extension</a></div>"
    );
    document.getElementById("ne-close").onclick = closeModal;
  }

  // ---------------------------------------------------------------- export bar

  function renderExportBar() {
    var host = document.getElementById("export-slot");
    if (!host) return;
    if (!guide || !guide.allowExport) { host.innerHTML = ""; return; }

    var signedIn = !!GG.current();
    host.innerHTML =
      '<div class="menu-wrap">' +
      '<button class="btn brand-btn" id="exp-btn" style="padding:8px 13px;font-size:13.5px">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16"/></svg>' +
      (signedIn ? "Export" : "Sign in to export") + "</button>" +
      '<div class="menu" id="exp-menu">' +
      '<div class="lbl">Hand off</div>' +
      item("ai", "Copy for AI", "Steps, actions and URLs as text") +
      '<div class="sep"></div><div class="lbl">Built on your device</div>' +
      item("html", "Web page", "Self-contained .html") +
      item("markdown", "Markdown", ".md with embedded images") +
      item("pdf", "PDF document", "Title page + steps") +
      item("pptx", "PowerPoint", "One slide per step") +
      '<div class="sep"></div><div class="lbl">Video</div>' +
      item("video", "Narrated video", "1080p .webm, needs the extension") +
      "</div></div>";

    var btn = document.getElementById("exp-btn");
    var menu = document.getElementById("exp-menu");
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      // No point showing a format list to someone who has to sign in first — the
      // choice is made after, and re-offered automatically.
      if (!GG.current()) return runExport("pdf");
      btn.setAttribute("aria-expanded", String(menu.classList.toggle("open")));
    });
    document.addEventListener("click", function () {
      menu.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    });
    menu.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-x]");
      if (!b) return;
      menu.classList.remove("open");
      runExport(b.dataset.x);
    });
  }

  function item(kind, title, sub) {
    return '<button data-x="' + kind + '"><span class="txt">' + esc(title) +
      "<small>" + esc(sub) + "</small></span></button>";
  }

  // ---------------------------------------------------------------- render

  function render(g) {
    var steps = Array.isArray(g.steps) ? g.steps : [];
    var title = g.title || "Untitled guide";
    document.title = title + " — GuideGen";

    var dur = fmtDur(g.durationMs);
    var start = safeUrl(g.startUrl);
    var who = String(g.ownerName || "").trim();

    var meta = [];
    if (who) {
      meta.push('<span class="who"><span class="av">' + esc(initials(who)) + "</span>" +
                esc(who.slice(0, 60)) + "</span>");
    }
    meta.push("<span>" + steps.length + (steps.length === 1 ? " step" : " steps") + "</span>");
    if (dur) meta.push("<span>recorded in " + esc(dur) + "</span>");
    if (g.createdAt) meta.push("<span>" + esc(fmtDate(g.createdAt)) + "</span>");

    var html = '<div class="viewer-head">';
    /* The app the flow happened in, from the page titles the steps carry. A monogram
       tile rather than the site's favicon on purpose: fetching a favicon means asking
       a third party for it on every read, and this page loads nothing from an
       external host it doesn't already serve images from. */
    if (g.app) {
      html += '<div class="appchip"><span class="tile">' +
              esc(String(g.app).trim().charAt(0).toUpperCase()) + "</span>" +
              esc(String(g.app).slice(0, 40)) + "</div>";
    }
    html += "<h1></h1>";
    if (g.description) html += '<p class="vdesc"></p>';
    html += '<div class="meta">' + meta.join('<span class="sep"></span>') + "</div>";

    /* Where to begin. Without this a recipient lands on step 1 — often a click inside
       a search box — with no way of reaching the screen it happened on. Scribe leads
       with the same thing as its step 1; kept out of the numbering here so the step
       numbers still match the editor, the PDF and the handoff. */
    if (start) {
      html +=
        '<div class="startrow">' +
        '<a class="btn brand-btn" href="' + esc(start) + '" target="_blank" rel="noopener noreferrer">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>' +
        "Start here</a>" +
        '<code class="starturl">' + esc(shortUrl(start)) + "</code></div>";
    }

    /* A table of contents, because a 13-step guide is 6000px of page and a reader
       arriving from a chat message usually wants one specific step. Collapsed by
       default — it is navigation, not content. */
    if (steps.length > 3) {
      html += '<details class="vtoc"><summary>All ' + steps.length + " steps</summary><ol>";
      steps.forEach(function (s, i) {
        html += '<li><a href="#step-' + (i + 1) + '">' + esc(s.text || "Step " + (i + 1)) + "</a></li>";
      });
      html += "</ol></details>";
    }
    html += "</div>";

    if (!steps.length) {
      html += '<p style="color:var(--muted)">This guide has no steps yet.</p>';
    }

    steps.forEach(function (s, i) {
      var isNote = s.type === "note";
      var n = i + 1;
      // Navigations are the one step type whose subject *is* a URL — so it gets to be
      // a link the reader can follow, rather than an address to retype.
      var link = s.type === "nav" ? safeUrl(s.url) : "";
      html +=
        '<div class="vstep' + (isNote ? " note" : "") + '" id="step-' + n + '">' +
        '<div class="n">' + n + "</div>" +
        '<div class="body">' +
        (isNote ? '<span class="note-tag">Note</span>' : "") +
        '<div class="txtrow"><p class="txt">' + esc(s.text || "") + "</p>" +
        '<button class="anchor" data-step="' + n + '" title="Copy a link to step ' + n +
        '" aria-label="Copy a link to step ' + n + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>' +
        "</button></div>" +
        (link
          ? '<a class="vlink" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' +
            esc(shortUrl(link)) +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></a>'
          : "") +
        (s.imageUrl
          ? '<figure><img loading="lazy" decoding="async" alt="Step ' + n +
            '" src="' + esc(s.imageUrl) + '" />' +
            '<button class="zoombtn" data-src="' + esc(s.imageUrl) + '" data-n="' + n +
            '" aria-label="Enlarge the screenshot for step ' + n + '">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21M11 8v6M8 11h6"/></svg>' +
            "Zoom</button></figure>"
          : "") +
        "</div></div>";
    });

    /* The one place a reader who was sent this can become a user, so it says what
       the tool did rather than only naming it — and points at /install, where they
       can actually get it, instead of the home page they'd have to navigate from. */
    html +=
      '<div class="viewer-foot"><span>Made with <b>GuideGen</b> — this guide wrote ' +
      "itself while someone did the work once. " +
      '<a href="https://www.backpocket.website" target="_blank" rel="noopener">A backpocket.website tool</a>.</span>' +
      '<span class="spacer"></span>' +
      '<a class="btn brand-btn" style="padding:8px 13px;font-size:13.5px" href="/install">' +
      "Get it free</a></div>";

    /* Not `.narrow`. That is a 720px reading column, and this is an image-first
       document — a 1600px screenshot rendered into 672px of it made small UI text
       unreadable, which is the whole thing a reader came to look at. */
    main.className = "wrap viewer";
    main.innerHTML = html;
    main.querySelector(".viewer-head h1").textContent = title;
    var d = main.querySelector(".vdesc");
    if (d) d.textContent = g.description;
    renderExportBar();
    wireSteps();
    wireHeader(title, steps.length);
    wirePromo(g);
    jumpToHash();
  }

  // ------------------------------------------------------ step-level affordances

  function wireSteps() {
    main.addEventListener("click", function (e) {
      var a = e.target.closest(".anchor");
      if (a) {
        var n = a.dataset.step;
        history.replaceState(null, "", location.pathname + "#step-" + n);
        copyText(location.origin + location.pathname + "#step-" + n,
                 "Link to step " + n + " copied");
        return;
      }
      var z = e.target.closest(".zoombtn");
      if (z) return openLightbox(z.dataset.src, z.dataset.n);
      // The picture itself is the biggest target on the page and the obvious thing to
      // press; the button exists so the affordance is visible, not to be the only way in.
      var img = e.target.closest(".vstep figure img");
      if (img) {
        var btn = img.parentNode.querySelector(".zoombtn");
        openLightbox(img.getAttribute("src"), btn ? btn.dataset.n : "");
      }
    });
  }

  /* Someone landing on /g/{id}#step-7 from a chat message. The images above it are
     lazy and have no intrinsic size until they load, so the anchor drifts as they
     arrive — hence the second, later scroll rather than a single one. */
  function jumpToHash() {
    var m = (location.hash || "").match(/^#step-(\d+)$/);
    if (!m) return;
    var target = document.getElementById("step-" + m[1]);
    if (!target) return;
    var go = function () { target.scrollIntoView({ block: "start" }); };
    go();
    target.classList.add("flash");
    setTimeout(go, 400);
    setTimeout(function () { target.classList.remove("flash"); }, 2200);
  }

  // ------------------------------------------------------ lightbox

  /* Zoom, because a screenshot of a dense admin panel is not readable at page width
     and never will be. Deliberately its own overlay rather than the modal: the modal
     is a dialog contract (focus trap, Cancel/confirm) and this is a picture. Pan is
     pointer events with capture, the same rule as the editor's redaction — mouse
     events aren't synthesized for touch drags, so a mouse-only version does nothing
     at all on a phone, which is where zoom matters most. */
  var lb = null;
  function openLightbox(src, n) {
    if (!src) return;
    closeLightbox();
    var scale = 1, tx = 0, ty = 0, dragging = false, lastX = 0, lastY = 0;

    lb = document.createElement("div");
    lb.className = "lightbox";
    lb.innerHTML =
      '<div class="lb-bar">' +
      (n ? '<span class="lb-n">Step ' + esc(n) + "</span>" : "") +
      '<span class="lb-sp"></span>' +
      '<button class="lb-btn" data-z="out" aria-label="Zoom out">−</button>' +
      '<button class="lb-btn" data-z="reset" aria-label="Fit to screen">Fit</button>' +
      '<button class="lb-btn" data-z="in" aria-label="Zoom in">+</button>' +
      '<button class="lb-btn lb-x" data-z="close" aria-label="Close">✕</button>' +
      "</div>" +
      '<div class="lb-stage"><img alt="' + (n ? "Step " + esc(n) : "Screenshot") + '" src="' + esc(src) + '" /></div>';
    document.body.appendChild(lb);
    document.body.classList.add("modal-open");

    var stage = lb.querySelector(".lb-stage");
    var img = lb.querySelector("img");
    var apply = function () {
      img.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
      stage.classList.toggle("zoomed", scale > 1);
    };
    var zoom = function (next, cx, cy) {
      next = Math.min(6, Math.max(1, next));
      if (next === scale) return;
      // Keep whatever is under the cursor under the cursor.
      if (cx != null) {
        var r = stage.getBoundingClientRect();
        var ox = cx - r.left - r.width / 2 - tx;
        var oy = cy - r.top - r.height / 2 - ty;
        tx -= ox * (next / scale - 1);
        ty -= oy * (next / scale - 1);
      }
      scale = next;
      if (scale === 1) { tx = 0; ty = 0; }
      apply();
    };

    lb.querySelector(".lb-bar").addEventListener("click", function (e) {
      var b = e.target.closest("[data-z]");
      if (!b) return;
      if (b.dataset.z === "close") return closeLightbox();
      if (b.dataset.z === "in") return zoom(scale * 1.5);
      if (b.dataset.z === "out") return zoom(scale / 1.5);
      scale = 1; tx = 0; ty = 0; apply();
    });
    // A click on the backdrop closes; a click on the picture does not, or panning
    // would dismiss the thing you were reading.
    lb.addEventListener("click", function (e) {
      if (e.target === lb || e.target === stage) closeLightbox();
    });
    img.addEventListener("dblclick", function (e) {
      zoom(scale > 1 ? 1 : 2.5, e.clientX, e.clientY);
    });
    stage.addEventListener("wheel", function (e) {
      e.preventDefault();
      zoom(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
    }, { passive: false });
    img.addEventListener("pointerdown", function (e) {
      if (scale <= 1) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      try { img.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    });
    img.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      tx += e.clientX - lastX; ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      apply();
    });
    img.addEventListener("pointerup", function () { dragging = false; });
    img.addEventListener("pointercancel", function () { dragging = false; });

    lb.querySelector(".lb-x").focus();
  }

  function closeLightbox() {
    if (!lb) return;
    lb.remove();
    lb = null;
    // Only this overlay put the lock on — the modal manages its own.
    if (!document.getElementById("overlay").classList.contains("open")) {
      document.body.classList.remove("modal-open");
    }
  }

  // ------------------------------------------------------ sticky header + progress

  /* Six thousand pixels down a guide, the header said "GuideGen" and nothing about
     what you were reading. It now carries the title and which step you are on, plus a
     read-progress line along the bottom edge — one IntersectionObserver for the
     title, one scroll handler for the rest. */
  function wireHeader(title, total) {
    var slot = document.getElementById("hdr-title");
    var count = document.getElementById("hdr-step");
    var bar = document.getElementById("hdr-bar");
    var h1 = main.querySelector(".viewer-head h1");
    if (slot && h1) {
      slot.textContent = title;
      if ("IntersectionObserver" in window) {
        new IntersectionObserver(function (entries) {
          slot.classList.toggle("show", !entries[0].isIntersecting);
        }, { rootMargin: "-58px 0px 0px 0px" }).observe(h1);
      }
    }

    var steps = [].slice.call(main.querySelectorAll(".vstep"));
    var tick = function () {
      var top = window.scrollY || document.documentElement.scrollTop;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (bar) bar.style.width = (max > 0 ? Math.min(100, (top / max) * 100) : 0) + "%";
      if (!count || !steps.length) return;
      // The step whose top has passed the header: what the reader is looking at.
      var n = 0;
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].getBoundingClientRect().top <= 120) n = i + 1;
      }
      count.textContent = n ? "Step " + n + " of " + total : "";
      count.classList.toggle("show", !!n);
    };
    window.addEventListener("scroll", tick, { passive: true });
    window.addEventListener("resize", tick);
    tick();
  }

  // ------------------------------------------------------ the growth loop

  /* The footer CTA is at the bottom of a page most readers never reach the bottom of.
     This is the same offer, positioned where it can actually be seen — and dismissible,
     because a bar you cannot get rid of on someone else's document is an advert. */
  function wirePromo(g) {
    var bar = document.getElementById("promo");
    if (!bar) return;
    try { if (sessionStorage.getItem("gg_promo_off") === "1") return; } catch (e) { /* blocked */ }
    var dur = fmtDur(g.durationMs);
    bar.innerHTML =
      "<span>This guide wrote itself" + (dur ? " in <b>" + esc(dur) + "</b>" : "") +
      " while someone did the work once.</span>" +
      '<span class="sp"></span>' +
      '<a class="btn brand-btn" href="/install">Get GuideGen free</a>' +
      '<button class="x" id="promo-x" aria-label="Dismiss">✕</button>';
    document.getElementById("promo-x").addEventListener("click", function () {
      bar.classList.remove("show");
      try { sessionStorage.setItem("gg_promo_off", "1"); } catch (e) { /* blocked */ }
    });
    var tick = function () {
      var top = window.scrollY || document.documentElement.scrollTop;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var seen = max > 0 ? top / max : 0;
      // Not immediately: someone who opened the link deserves to read a step first.
      bar.classList.toggle("show", seen > 0.2 && seen < 0.94);
    };
    window.addEventListener("scroll", tick, { passive: true });
    tick();
  }

  // ---------------------------------------------------------------- boot

  document.getElementById("print-btn").addEventListener("click", function () {
    window.print();
  });

  /* The reader's most likely *first* action is passing it on, and until now the page
     offered no way to — a shared link that can only be re-shared out of the address
     bar is a viral surface with the loop cut. Strips any #step-n so what gets pasted
     is the guide, not wherever the sender happened to be scrolled to. */
  document.getElementById("copy-btn").addEventListener("click", function () {
    copyText(location.origin + location.pathname, "Link copied");
  });

  id = guideId();
  if (!id) {
    state(ICON_WARN, "No guide specified",
          "This link doesn't point at a guide. Check that you copied the whole thing.",
          '<a class="btn" href="/">Go to GuideGen</a>');
    return;
  }

  GG.getPublicGuide(id).then(function (g) {
    // A guide can exist but not be shared; the rules deny the read, so a 403
    // arrives instead. Belt and braces in case that ever changes.
    if (g.visibility !== "link") {
      state(ICON_LOCK, "This guide is private",
            "The owner hasn't shared this guide, or has since unpublished it. Ask them for a new link.",
            '<a class="btn" href="/">Go to GuideGen</a>');
      return;
    }
    guide = g;
    render(g);
    // Back from Google mid-export: pick up where they left off rather than making
    // them find the menu again.
    var want = new URLSearchParams(location.search).get("export");
    if (want && GG.current() && LABEL[want]) {
      try { history.replaceState(null, "", location.pathname); } catch (err) {}
      runExport(want);
    }
  }).catch(function (e) {
    if (e.code === 403 || e.code === 404) {
      // Firestore returns 403 for both "denied" and "doesn't exist" — on purpose,
      // so a stranger can't probe which guide ids are real. That means we cannot
      // tell an unpublished guide from a mistyped link, so the message must not
      // claim to know which it is.
      state(ICON_LOCK, "This guide isn't available",
            "It may have been unpublished or deleted, or the link may be incomplete. " +
            "Ask whoever shared it for a fresh link.",
            '<a class="btn" href="/">Go to GuideGen</a>');
    } else {
      state(ICON_WARN, "Couldn't load this guide",
            "Something went wrong fetching it. Refresh to try again.",
            '<a class="btn" href="">Refresh</a>');
    }
  });
})();
