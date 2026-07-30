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

  function closeModal() {
    var o = document.getElementById("overlay");
    o.classList.remove("open");
    o.dataset.busy = "0";
    document.getElementById("modal").innerHTML = "";
  }
  document.getElementById("overlay").addEventListener("click", function (e) {
    if (e.target.id === "overlay" && e.currentTarget.dataset.busy !== "1") closeModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    var menu = document.getElementById("exp-menu");
    if (menu) menu.classList.remove("open");
    var o = document.getElementById("overlay");
    if (o.classList.contains("open") && o.dataset.busy !== "1") closeModal();
  });
  function openModal(html) {
    document.getElementById("modal").innerHTML = html;
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

  var LABEL = { html: "web page", markdown: "Markdown", pdf: "PDF", pptx: "PowerPoint", video: "video" };

  function runExport(kind) {
    if (!GG.current()) { pendingKind = kind; return signInModal(kind); }

    if (kind === "video") return videoModal();

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
      '<a class="btn brand-btn" target="_blank" rel="noopener" ' +
      'href="https://chromewebstore.google.com/detail/' + window.GGBridge.STORE_ID +
      '">Get the extension</a></div>'
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
      '<div class="lbl">Built on your device</div>' +
      item("html", "Web page", "Self-contained .html") +
      item("markdown", "Markdown", ".md with embedded images") +
      item("pdf", "PDF document", "Title page + steps") +
      item("pptx", "PowerPoint", "One slide per step") +
      '<div class="sep"></div><div class="lbl">Video</div>' +
      item("video", "Narrated video", "1080p .webm, needs the extension") +
      "</div></div>";

    var btn = document.getElementById("exp-btn");
    var menu = document.getElementById("exp-menu");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      // No point showing a format list to someone who has to sign in first — the
      // choice is made after, and re-offered automatically.
      if (!GG.current()) return runExport("pdf");
      menu.classList.toggle("open");
    });
    document.addEventListener("click", function () { menu.classList.remove("open"); });
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

    var html =
      '<div class="viewer-head"><h1></h1><div class="meta">' +
      "<span>" + steps.length + (steps.length === 1 ? " step" : " steps") + "</span>" +
      (g.createdAt ? '<span class="sep"></span><span>' + esc(fmtDate(g.createdAt)) + "</span>" : "") +
      "</div></div>";

    if (!steps.length) {
      html += '<p style="color:var(--muted)">This guide has no steps yet.</p>';
    }

    steps.forEach(function (s, i) {
      var isNote = s.type === "note";
      html +=
        '<div class="vstep' + (isNote ? " note" : "") + '">' +
        '<div class="n">' + (i + 1) + "</div>" +
        '<div class="body">' +
        (isNote ? '<span class="note-tag">Note</span>' : "") +
        '<p class="txt">' + esc(s.text || "") + "</p>" +
        (s.imageUrl
          ? '<figure><img loading="lazy" decoding="async" alt="Step ' + (i + 1) +
            '" src="' + esc(s.imageUrl) + '" /></figure>'
          : "") +
        "</div></div>";
    });

    html +=
      '<div class="viewer-foot"><span>Made with GuideGen</span>' +
      '<span class="spacer"></span>' +
      '<a class="btn" style="padding:8px 13px;font-size:13.5px" href="/">Make your own guide</a></div>';

    main.className = "wrap narrow viewer";
    main.innerHTML = html;
    main.querySelector(".viewer-head h1").textContent = title;
    renderExportBar();
  }

  // ---------------------------------------------------------------- boot

  document.getElementById("print-btn").addEventListener("click", function () {
    window.print();
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
