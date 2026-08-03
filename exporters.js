// GuideGen — exporters (window.FSExport)
(function () {
  const R = window.FSRender;

  // ---------- shared helpers ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  function safeName(s) {
    return (String(s || "guidegen-guide").trim() || "guidegen-guide")
      .replace(/[^\w\- ]+/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 60);
  }
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function contain(iw, ih, maxW, maxH) {
    const s = Math.min(maxW / iw, maxH / ih);
    return { w: iw * s, h: ih * s };
  }
  // Crops `canvas` to the part of the step worth showing, in `aspect`. Same
  // reasoning as the video exporter: a full desktop viewport is mostly empty
  // margin, and embedding all of it shrinks the real UI until it can't be read.
  function cropToFocus(canvas, step, aspect) {
    const roi = R.focusRegion(step, canvas.width, canvas.height, aspect, { canvas });
    if (!roi) return canvas;
    const c2 = document.createElement("canvas");
    c2.width = Math.round(roi.w);
    c2.height = Math.round(roi.h);
    const cx = c2.getContext("2d");
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, c2.width, c2.height);
    return c2;
  }

  // Aspect the page/slide gives an image. Documents are laid out portrait, so a
  // moderately wide crop fills the column without dominating the page.
  const DOC_ASPECT = 1.6;
  const SLIDE_ASPECT = 2.0;

  async function annoDataUrl(step, seq, maxW, aspect) {
    const c = await R.renderStep(Object.assign({}, step, { seq }));
    if (!c) return null;
    const out = aspect ? cropToFocus(c, step, aspect) : c;
    return { data: R.canvasToDataURL(out, maxW || 1600), w: out.width, h: out.height };
  }

  // ---------- HTML ----------
  async function html(guide, steps) {
    let body = "";
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      let img = "";
      if (s.screenshot) {
        const a = await annoDataUrl(s, i + 1, 1600, DOC_ASPECT);
        if (a) img = '<img alt="Step ' + (i + 1) + '" src="' + a.data + '" />';
      }
      const note = s.type === "note" ? " note" : "";
      body +=
        '<section class="step' + note + '"><div class="num">' + (i + 1) +
        '</div><div class="c"><p>' + esc(s.text) + "</p>" + img + "</div></section>";
    }
    const doc =
      "<!doctype html><html><head><meta charset='utf-8'><title>" +
      esc(guide.title) +
      "</title><style>" +
      "body{font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1713;background:#f4f1ea;margin:0;padding:40px}" +
      ".doc{max-width:820px;margin:0 auto;background:#fff;border:1px solid #e5dfd2;border-radius:14px;padding:44px}" +
      "h1{font-size:30px;letter-spacing:-.028em;margin:0 0 6px}.sub{color:#6f675b;margin:0 0 28px;font-size:14px}" +
      ".step{display:flex;gap:16px;padding:18px 0;border-top:1px solid #ece7dc}" +
      ".step:first-of-type{border-top:0}" +
      ".num{width:30px;height:30px;min-width:30px;border-radius:50%;background:#c2410c;color:#fffdfa;font-weight:700;font-variant-numeric:tabular-nums;display:flex;align-items:center;justify-content:center}" +
      ".c{flex:1;min-width:0}.c p{margin:4px 0 10px;font-size:17px}" +
      ".step.note .c{background:#f6ece2;border-radius:9px;padding:12px 14px}" +
      "img{max-width:100%;border:1px solid #e5dfd2;border-radius:9px;display:block}" +
      ".foot{margin-top:30px;color:#928879;font-size:12px;text-align:center}" +
      "</style></head><body><div class='doc'><h1>" +
      esc(guide.title) +
      "</h1><p class='sub'>" +
      steps.length + " steps" +
      (guide.startUrl ? " · " + esc(guide.startUrl) : "") +
      "</p>" +
      body +
      "<div class='foot'>Generated with GuideGen</div></div></body></html>";
    download(new Blob([doc], { type: "text/html" }), safeName(guide.title) + ".html");
  }

  // ---------- Markdown ----------
  async function markdown(guide, steps) {
    let md = "# " + (guide.title || "Untitled guide") + "\n\n";
    if (guide.startUrl) md += "> Source: " + guide.startUrl + "\n\n";
    md += "_" + steps.length + " steps · generated with GuideGen_\n\n";
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      md += "## Step " + (i + 1) + "\n\n" + (s.text || "") + "\n\n";
      if (s.screenshot) {
        const a = await annoDataUrl(s, i + 1, 1400, DOC_ASPECT);
        if (a) md += "![Step " + (i + 1) + "](" + a.data + ")\n\n";
      }
    }
    download(new Blob([md], { type: "text/markdown" }), safeName(guide.title) + ".md");
  }

  // ---------- AI handoff ----------
  //
  // The one export whose reader is a model, not a person, and the only one that
  // emits the fields every other format throws away: the action type, and the URL
  // and page title each step happened on. A guide is the answer to "what did you
  // do" — a model needs "and where", or it invents it.
  //
  // Deliberately text only. The other exporters embed the screenshot as a data URL,
  // which is right for a document and wrong here: 40 base64 screenshots is several
  // megabytes of tokens that no chat window will take, and a model told to expect
  // images that aren't there will describe them anyway. Say so in the header
  // instead.
  //
  // Steps are grouped by URL rather than repeating it on all forty lines. That is
  // also the shape of the information — a workflow is a few pages with several
  // actions on each, and a flat list hides where the page changed.
  const ACTION = {
    click: "click", input: "type", key: "keypress",
    switch: "tab switch", nav: "navigation", note: "note", scroll: "scroll",
  };

  /* One logged request as a cURL command.
   *
   * The status line alone (`POST /api/orders → 500`) tells you a call failed and
   * nothing about what was sent, so acting on it means asking the reporter to
   * reproduce it. A cURL is the one format an engineer and a model both already
   * read, and it carries the method, the address, the headers and the sent body in
   * a shape that can be pasted straight into a terminal.
   *
   * Two things it deliberately is *not*:
   *
   * - **Not replayable as-is.** Credential header values are masked at capture
   *   (see netpatch.js) and query values are masked in the path, so this documents
   *   a call rather than re-issuing it. The trailing comment says so in the output
   *   itself — a cURL that looks runnable and silently 401s wastes more time than
   *   one that admits what is missing.
   * - **Not built from Tier 1 alone.** Without `reqHeaders`/`reqBody` there is no
   *   request to describe, so this returns "" and callers fall back to the status
   *   line. Emitting `curl -X POST url` off a summary would look like a capture and
   *   be a guess.
   *
   * Single-quoted with the POSIX `'\''` escape, so a body containing quotes, braces
   * or newlines survives a paste into a shell.
   */
  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function curlOf(r) {
    if (!r) return "";
    const heads = r.reqHeaders || [];
    if (!heads.length && !r.reqBody) return "";
    const url = (r.scheme || "https") + "://" + (r.host || "") + (r.path || "");
    const lines = ["curl -X " + (r.method || "GET") + " " + shellQuote(url)];
    heads.forEach((h) => {
      lines.push("  -H " + shellQuote(h[0] + ": " + h[1]));
    });
    if (r.reqBody) lines.push("  --data-raw " + shellQuote(r.reqBody));
    let out = lines.join(" \\\n");
    const notes = [];
    if (heads.some((h) => /…GuideGen-masked…/.test(h[1])))
      notes.push("credential header values are masked — paste your own to replay");
    if (/\?.*=…/.test(r.path || "")) notes.push("query values are masked");
    if (r.reqBodyTruncated) notes.push("sent body truncated from " + r.reqBodyTruncated + " characters");
    notes.push("cookies are not captured");
    out += "\n# " + notes.join("; ");
    return out;
  }

  function aiText(guide, steps) {
    const n = steps.length;
    let out = "# " + (guide.title || "Untitled guide") + "\n\n";
    out += "Browser workflow captured with GuideGen. " + n +
      (n === 1 ? " step" : " steps") + ".\n";
    if (guide.startUrl) out += "Starting point: " + guide.startUrl + "\n";
    out += "This is the written record only — the screenshots are not included.\n";
    // Said up front, because a model that meets an indented `POST /x → 500` with no
    // warning tends to treat it as prose rather than as evidence.
    if (steps.some((s) => (s.network || []).length))
      out += "Requests the page made are listed under the step that triggered them, " +
        "with their status. Failed ones may carry the full exchange as a cURL " +
        "command plus the response; credential values in it are masked, so treat it " +
        "as a record of the call rather than something to re-run.\n";
    out += "\n";

    let lastUrl = null;
    let redacted = false;
    for (let i = 0; i < n; i++) {
      const s = steps[i];
      if ((s.blurs || []).length) redacted = true;
      const url = s.url || "";
      // A note isn't something that happened on a page, so it never opens a new
      // group — that would split a run of actions in half around a comment.
      if (s.type !== "note" && url && url !== lastUrl) {
        out += (lastUrl === null ? "" : "\n") + "## " + url + "\n";
        if (s.pageTitle) out += "*" + s.pageTitle + "*\n";
        out += "\n";
        lastUrl = url;
      }
      const kind = ACTION[s.type] || s.type || "click";
      out += (i + 1) + ". " + (s.text || "").replace(/\s+/g, " ").trim() +
        (s.type === "note" ? "" : "  `" + kind + "`") + "\n";

      /* The API log, and **this is the only export that carries it.** A guide is
       * for a person following steps; `GET /api/session → 200` is noise to them.
       * A model debugging the same flow needs exactly that line, and it is cheap:
       * a few dozen characters where a screenshot would be a megabyte.
       *
       * Indented under its step so the numbered list stays a numbered list. */
      const net = s.network || [];
      if (net.length) {
        net.forEach((r) => {
          const status = r.error ? r.error : r.status || "no response";
          out += "    - `" + r.method + " " + (r.host ? r.host : "") + r.path +
            "` → **" + status + "**" + (r.ms != null ? " (" + r.ms + "ms)" : "") + "\n";
          // The request, as a cURL, when the exchange was captured. Fenced as `bash`
          // so a model reads it as a command rather than as prose, and placed before
          // the response because that is the order they happened in.
          const curl = curlOf(r);
          if (curl) {
            out += "      ```bash\n";
            curl.split("\n").forEach((line) => { out += "      " + line + "\n"; });
            out += "      ```\n";
          }
          if (r.body) {
            /* Fenced, because a JSON body full of braces and quotes wrecks the
             * surrounding Markdown otherwise — and a model reads a fence as data.
             *
             * A failure gets more room than a success, which is the one place this
             * export second-guesses the log. Bodies are kept for every request now,
             * and forty full result sets is a handoff no chat window will accept —
             * whereas the failure is the thing being asked about. The log drawer's
             * own copy button (`apiLogText`) trims nothing, so nothing is lost. */
            const cap = r.ok ? 8 : 24;
            const lines = r.body.split("\n");
            out += "      ```\n";
            lines.slice(0, cap).forEach((line) => {
              out += "      " + line.slice(0, 300) + "\n";
            });
            out += "      ```\n";
            if (lines.length > cap)
              out += "      *(" + (lines.length - cap) + " more lines — full body in the API log)*\n";
            if (r.bodyTruncated)
              out += "      *(response truncated from " + r.bodyTruncated + " characters)*\n";
          }
        });
        if (s.networkMore)
          out += "    - *(" + s.networkMore + " more request" +
            (s.networkMore === 1 ? "" : "s") + " not shown)*\n";
      }
    }
    if (redacted) {
      out += "\nSome values were redacted before export, so a few fields " +
        "referenced above are intentionally blank in the screenshots.\n";
    }
    return out;
  }

  /* Just the API log, for the case where the recipient is a developer who wants the
   * requests and not the guide around them. Shares its formatting with `aiText`'s
   * inline version rather than inventing a second one — the destination is the same
   * kind of window, and two formats for one thing is how they drift.
   *
   * Not a download and not in the export menu: it is the clipboard action inside the
   * log drawer. Documents never carry the log at all. */
  function apiLogText(guide, steps) {
    const rows = [];
    steps.forEach((s, i) => {
      const net = s.network || [];
      if (!net.length) return;
      rows.push("## " + (i + 1) + ". " + (s.text || "").replace(/\s+/g, " ").trim());
      if (s.url) rows.push("*" + s.url + "*");
      rows.push("");
      net.forEach((r) => {
        const status = r.error ? r.error : r.status || "no response";
        rows.push("- `" + r.method + " " + (r.host || "") + r.path + "` → **" + status + "**" +
          (r.ms != null ? " (" + r.ms + "ms)" : ""));
        const curl = curlOf(r);
        if (curl) {
          rows.push("  ```bash");
          curl.split("\n").forEach((line) => rows.push("  " + line));
          rows.push("  ```");
        }
        if (r.body) {
          rows.push("  ```");
          r.body.split("\n").forEach((line) => rows.push("  " + line));
          rows.push("  ```");
          if (r.bodyTruncated)
            rows.push("  *(truncated from " + r.bodyTruncated + " characters)*");
        }
      });
      if (s.networkMore) rows.push("- *(" + s.networkMore + " more not shown)*");
      rows.push("");
    });
    if (!rows.length) return "";
    return "# API log — " + (guide.title || "Untitled guide") + "\n\n" + rows.join("\n");
  }

  // Fallback path. The UI copies `aiText` to the clipboard instead, because the
  // destination is a chat window and a file on disk is one step further from it.
  async function ai(guide, steps) {
    download(
      new Blob([aiText(guide, steps)], { type: "text/markdown" }),
      safeName(guide.title) + "-for-ai.md"
    );
  }

  // ---------- PDF ----------
  async function pdf(guide, steps) {
    const jsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!jsPDF) throw new Error("PDF library not loaded");
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const PW = doc.internal.pageSize.getWidth();
    const PH = doc.internal.pageSize.getHeight();
    const M = 48;
    const CW = PW - 2 * M;

    // Title page
    doc.setFillColor(29, 26, 21);
    doc.rect(0, 0, PW, PH, "F");
    doc.setTextColor(251, 250, 247);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(30);
    const tl = doc.splitTextToSize(guide.title || "Untitled guide", CW);
    doc.text(tl, PW / 2, PH / 2 - 20, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(13);
    doc.setTextColor(217, 207, 190);
    doc.text(
      "Created with GuideGen · " +
        new Date(guide.createdAt || Date.now()).toLocaleDateString(),
      PW / 2,
      PH / 2 + 20,
      { align: "center" }
    );

    doc.addPage();
    let y = M;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      const lines = doc.splitTextToSize((i + 1) + ". " + (s.text || ""), CW);
      const headH = lines.length * 17 + 6;

      let a = null, box = null;
      if (s.screenshot) {
        a = await annoDataUrl(s, i + 1, 1400, DOC_ASPECT);
        if (a) box = contain(a.w, a.h, CW, PH - 2 * M - headH - 24);
      }

      /* A note with no picture gets the paper card the HTML export has always given
       * it — the same tint, and an ochre edge so it reads as an aside rather than as
       * a step whose screenshot failed to render. */
      const asCard = s.type === "note" && !a;
      const blockH = headH + (box ? box.h + 12 : 0) + (asCard ? 18 : 0) + 16;
      if (y + blockH > PH - M && y > M) {
        doc.addPage();
        y = M;
      }
      if (asCard) {
        doc.setFillColor(246, 236, 226);
        doc.roundedRect(M - 10, y - 4, CW + 20, headH + 14, 6, 6, "F");
        doc.setFillColor(194, 65, 12);
        doc.rect(M - 10, y - 4, 3, headH + 14, "F");
      }
      doc.setTextColor(26, 23, 19);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.text(lines, M, y + 12);
      y += headH + (asCard ? 18 : 0);
      if (a && box) {
        doc.addImage(a.data, "PNG", M + (CW - box.w) / 2, y, box.w, box.h);
        y += box.h + 14;
      }
      doc.setDrawColor(236, 231, 220);
      doc.line(M, y, PW - M, y);
      y += 16;
    }
    doc.save(safeName(guide.title) + ".pdf");
  }

  // ---------- PPTX ----------
  async function pptx(guide, steps) {
    const P = window.PptxGenJS;
    if (!P) throw new Error("PPTX library not loaded");
    const pptx = new P();
    pptx.defineLayout({ name: "FS", width: 13.33, height: 7.5 });
    pptx.layout = "FS";

    const t = pptx.addSlide();
    t.background = { color: "1D1A15" };
    t.addText(guide.title || "Untitled guide", {
      x: 0.6, y: 2.5, w: 12.1, h: 1.6,
      fontSize: 40, bold: true, color: "FFFFFF", align: "center",
    });
    t.addText(
      "Created with GuideGen · " +
        new Date(guide.createdAt || Date.now()).toLocaleDateString(),
      { x: 0.6, y: 4.2, w: 12.1, h: 0.6, fontSize: 16, color: "D9CFBE", align: "center" }
    );

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const sl = pptx.addSlide();

      /* A note with no picture is a section slide, not a step with a blank middle.
       * It used to get the dark step header *and* the same sentence again in grey
       * underneath — the text twice, once too small to read from a room. Now it is
       * the one thing on the slide, set large on paper, which is also what makes an
       * imageless note worth adding: it becomes the divider in a deck. */
      if (s.type === "note" && !s.screenshot) {
        sl.background = { color: "F4F1EA" };
        sl.addShape(pptx.ShapeType.rect, { x: 0, y: 3.34, w: 0.9, h: 0.09, fill: { color: "C2410C" } });
        sl.addText(s.text || "", {
          x: 1.4, y: 2.0, w: 10.5, h: 3.5,
          fontSize: 34, bold: true, color: "1A1713", align: "left", valign: "middle",
        });
        continue;
      }

      sl.addText(
        [
          { text: i + 1 + ".  ", options: { bold: true, color: "E39A63" } },
          { text: s.text || "", options: { color: "FFFFFF" } },
        ],
        {
          x: 0, y: 0, w: 13.33, h: 1.1,
          fill: { color: "1A1713" }, fontSize: 18, valign: "middle",
          margin: [6, 12, 6, 12], align: "left",
        }
      );
      if (s.screenshot) {
        const a = await annoDataUrl(s, i + 1, 1600, SLIDE_ASPECT);
        if (a) {
          const box = contain(a.w, a.h, 12.3, 5.8);
          sl.addImage({
            data: a.data,
            x: (13.33 - box.w) / 2,
            y: 1.25 + (6.0 - box.h) / 2,
            w: box.w,
            h: box.h,
          });
        }
      } else {
        sl.addText(s.text || "", {
          x: 1, y: 2.6, w: 11.3, h: 2.3,
          fontSize: 26, align: "center", color: "374151",
        });
      }
    }
    await pptx.writeFile({ fileName: safeName(guide.title) + ".pptx" });
  }

  // ---------- Video (webm) with optional TTS narration ----------
  function pickMime() {
    const c = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    for (const m of c)
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return "";
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- pacing ----------
  // One source of truth: the editor builds its dropdown from this, and both
  // narrated and silent video use the same per-step duration curve.
  const PACES = {
    vfast:  { label: "Very fast", wpm: 210, rate: 1.45, min: 1.2, pad: 0.4 },
    fast:   { label: "Fast",      wpm: 180, rate: 1.2,  min: 1.6, pad: 0.5 },
    medium: { label: "Medium",    wpm: 150, rate: 1.0,  min: 2.0, pad: 0.7 },
    slow:   { label: "Slow",      wpm: 125, rate: 0.85, min: 2.6, pad: 0.9 },
    vslow:  { label: "Very slow", wpm: 100, rate: 0.7,  min: 3.4, pad: 1.2 },
  };
  const DEFAULT_PACE = "medium";
  function paceOf(key) { return PACES[key] || PACES[DEFAULT_PACE]; }

  // How long a step stays on screen, derived from its own text: wordy steps get
  // room to be read/spoken, short ones don't linger. `pad` is breathing space
  // between slides; `min` keeps one-word steps from flashing past.
  function stepSecs(text, paceKey) {
    const p = paceOf(paceKey);
    const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
    return Math.min(20, Math.max(p.min, (words / p.wpm) * 60 + p.pad));
  }

  // Opus drops packets that are pure digital silence, which shortens the audio
  // track relative to the video and drifts the narration off its slide. A noise
  // floor at -80dBFS is inaudible but keeps packets flowing the whole time.
  // Routed to the recorder only, never to the speakers.
  function startDither(ctx, dest) {
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 1e-4;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(dest);
    src.start();
    return src;
  }

  // Lays out the whole video before recording: which slide is on screen from
  // when to when, and where each narration clip sits. One timeline drives both
  // picture and sound, so they cannot drift apart.
  function buildTimeline(guide, frames, clips, titleClip, paceKey, narrationOn) {
    const p = paceOf(paceKey);
    const segs = [];
    const intro = narrationOn
      ? (titleClip ? titleClip.duration : 0) + 0.8
      : (1700 * (PACES.medium.wpm / p.wpm)) / 1000;
    segs.push({ index: -1, start: 0, dur: intro, clip: narrationOn ? titleClip : null });
    let t = intro;
    for (let i = 0; i < frames.length; i++) {
      const clip = narrationOn && clips ? clips[i] : null;
      // whichever is longer: the reading time for this text, or the narration
      // that has to fit inside it plus a beat of silence
      const dur = Math.max(
        stepSecs(frames[i].step.text, paceKey),
        (clip ? clip.duration : 0) + p.pad
      );
      segs.push({ index: i, start: t, dur, clip });
      t += dur;
    }
    return { segs, total: t + 0.6 };
  }

  function segAt(segs, t) {
    for (let i = segs.length - 1; i >= 0; i--) if (t >= segs[i].start) return segs[i];
    return segs[0];
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function wrapLines(ctx, text, maxW, maxLines) {
    const words = String(text || "").split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
        if (lines.length === maxLines - 1) break;
      } else line = test;
    }
    if (line) lines.push(line);
    if (lines.length >= maxLines) {
      let last = lines[maxLines - 1] || "";
      while (ctx.measureText(last + "…").width > maxW && last.length)
        last = last.slice(0, -1);
      lines[maxLines - 1] = last + "…";
    }
    return lines.slice(0, maxLines);
  }
  // Draws sub-rect `roi` of `src` onto a white card with a soft shadow, so the
  // screenshot reads as a deliberate object rather than a raw bitmap bleeding
  // to the frame edge.
  function drawSource(ctx, src, roi, x, y, w, h, S) {
    const box = contain(roi.w, roi.h, w, h);
    const dx = x + (w - box.w) / 2;
    const dy = y + (h - box.h) / 2;
    const pad = 10 * S;
    const rad = 14 * S;
    ctx.save();
    ctx.shadowColor = "rgba(26,23,19,0.18)";
    ctx.shadowBlur = 34 * S;
    ctx.shadowOffsetY = 10 * S;
    ctx.fillStyle = "#ffffff";
    roundRectPath(ctx, dx - pad, dy - pad, box.w + pad * 2, box.h + pad * 2, rad);
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRectPath(ctx, dx, dy, box.w, box.h, rad * 0.6);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, roi.x, roi.y, roi.w, roi.h, dx, dy, box.w, box.h);
    ctx.restore();
  }

  const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

  // Shrinks the crop slightly across a slide's life — a slow push-in toward the
  // highlight. Static slides with hard cuts are the main thing that reads cheap.
  function pushIn(roi, step, srcW, srcH, local) {
    const k = 1 - 0.045 * easeOut(local);
    const w = roi.w * k;
    const h = roi.h * k;
    // drift toward the target so the movement has a subject
    const dpr = step.dpr || 1;
    const r = step.rect;
    let tx = roi.x + roi.w / 2;
    let ty = roi.y + roi.h / 2;
    if (r && r.w > 0) {
      tx = (r.x + r.w / 2) * dpr;
      ty = (r.y + r.h / 2) * dpr;
    }
    const f = 0.35 * easeOut(local);
    const cx = roi.x + roi.w / 2 + (tx - (roi.x + roi.w / 2)) * f;
    const cy = roi.y + roi.h / 2 + (ty - (roi.y + roi.h / 2)) * f;
    return {
      x: Math.max(0, Math.min(srcW - w, cx - w / 2)),
      y: Math.max(0, Math.min(srcH - h, cy - h / 2)),
      w, h,
    };
  }

  function drawTitle(ctx, W, H, guide) {
    const S = H / 720;
    // Ink, not a brand gradient. A two-stop purple wash across a title card is
    // the most generated-looking thing a slide can do.
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, "#211d18");
    g.addColorStop(1, "#131110");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold " + Math.round(52 * S) + "px -apple-system, Arial, sans-serif";
    const lines = wrapLines(ctx, guide.title || "Untitled guide", W - 200 * S, 3);
    const lh = 62 * S;
    let y = H / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((l) => { ctx.fillText(l, W / 2, y); y += lh; });
    ctx.font = Math.round(22 * S) + "px -apple-system, Arial, sans-serif";
    ctx.fillStyle = "#d9cfbe";
    ctx.fillText("A GuideGen walkthrough", W / 2, H - 90 * S);
  }

  // Layout of a step slide. Light, generous, typographic — the old dark bar with
  // 22px text jammed in the corner read like a debug overlay.
  function stepLayout(W, H) {
    const S = H / 720;
    const capH = 132 * S;
    const barH = 7 * S;
    return {
      S, capH, barH,
      ax: 56 * S, ay: capH, aw: W - 112 * S, ah: H - capH - 40 * S - barH,
    };
  }

  function drawStepFrame(ctx, W, H, f, total, local) {
    const L = stepLayout(W, H);
    const S = L.S;
    local = local == null ? 1 : local;

    ctx.fillStyle = "#f4f1ea";
    ctx.fillRect(0, 0, W, H);

    // caption
    const numR = 27 * S;
    const numX = 56 * S + numR;
    const numY = L.capH / 2 - 6 * S;
    ctx.save();
    ctx.fillStyle = R.BRAND;
    ctx.beginPath();
    ctx.arc(numX, numY, numR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold " + Math.round(28 * S) + "px -apple-system, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(f.index + 1), numX, numY + S);
    ctx.restore();

    ctx.save();
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#7c7466";
    ctx.font = "600 " + Math.round(19 * S) + "px -apple-system, Arial, sans-serif";
    const counter = "Step " + (f.index + 1) + " of " + total;
    ctx.fillText(counter, W - 56 * S, numY);
    const cw = ctx.measureText(counter).width;
    ctx.restore();

    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#1a1713";
    ctx.font = "600 " + Math.round(34 * S) + "px -apple-system, Arial, sans-serif";
    const textX = numX + numR + 26 * S;
    const lines = wrapLines(ctx, f.step.text || "", W - textX - cw - 90 * S, 2);
    const lh = 42 * S;
    let ty = numY - ((lines.length - 1) * lh) / 2;
    lines.forEach((l) => { ctx.fillText(l, textX, ty); ty += lh; });
    ctx.restore();

    // progress bar pinned to the bottom edge
    ctx.fillStyle = "#e5dfd2";
    ctx.fillRect(0, H - L.barH, W, L.barH);
    ctx.fillStyle = R.BRAND;
    ctx.fillRect(0, H - L.barH, (W * (f.index + 1)) / total, L.barH);

    const ax = L.ax, ay = L.ay, aw = L.aw, ah = L.ah;
    if (f.anno) {
      // Cached — focusRegion measures pixels and this runs on every drawn frame.
      if (!f.roi) {
        f.roi =
          R.focusRegion(f.step, f.anno.width, f.anno.height, aw / ah, { canvas: f.anno }) ||
          { x: 0, y: 0, w: f.anno.width, h: f.anno.height };
      }
      // No push-in on a baked image. The drift ends 4.5% tighter than it started,
      // which on an already-cropped frame eats into the number badge sitting near
      // the edge. There is also nothing to push *toward* — a baked step has no
      // rect, so the movement would have no subject.
      const roi = f.step.baked
        ? f.roi
        : pushIn(f.roi, f.step, f.anno.width, f.anno.height, local);
      drawSource(ctx, f.anno, roi, ax, ay, aw, ah, S);
    } else {
      // note step: a quiet card, matching the light slide
      ctx.save();
      ctx.shadowColor = "rgba(26,23,19,0.14)";
      ctx.shadowBlur = 30 * S;
      ctx.shadowOffsetY = 8 * S;
      ctx.fillStyle = "#ffffff";
      roundRectPath(ctx, ax, ay, aw, ah, 16 * S);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = "#443c31";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = Math.round(32 * S) + "px -apple-system, Arial, sans-serif";
      const nl = wrapLines(ctx, f.step.text || "", aw - 140 * S, 6);
      const nlh = 44 * S;
      let ny = ay + ah / 2 - ((nl.length - 1) * nlh) / 2;
      nl.forEach((l) => { ctx.fillText(l, W / 2, ny); ny += nlh; });
    }
  }

  async function video(guide, steps, opts) {
    opts = opts || {};
    const prog = (p, m) => opts.onProgress && opts.onProgress(p, m);
    // 1080p, not 720p: these are dense dashboard screenshots carrying a lot of
    // small UI text. At 720p it was already illegible before the encoder ever
    // saw it, even off a full-retina capture.
    const W = 1920, H = 1080;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const pace = paceOf(opts.pace);

    prog(0.03, "Preparing frames…");
    const frames = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      let anno = null;
      if (s.screenshot) anno = await R.renderStep(Object.assign({}, s, { seq: i + 1 }));
      frames.push({ step: s, anno, index: i });
    }

    // Narration is synthesized up front, before the recorder starts — Piper
    // takes a second or two per step and we must not record that dead air.
    let clips = null, titleClip = null;
    if (opts.narrate) {
      try {
        if (!window.FSTTS || !(await window.FSTTS.available()))
          throw new Error("voice files missing from lib/");
        const relay = (m) => prog(0.06, m);
        titleClip = await window.FSTTS.synth(guide.title || "Untitled guide", {
          rate: pace.rate, onProgress: relay,
        });
        clips = [];
        for (let i = 0; i < frames.length; i++) {
          prog(0.08 + 0.5 * (i / frames.length),
            "Generating narration " + (i + 1) + " of " + frames.length + "…");
          clips.push(await window.FSTTS.synth(frames[i].step.text, { rate: pace.rate }));
        }
      } catch (e) {
        clips = null;
        titleClip = null;
        prog(0.58, "Narration unavailable (" + (e && e.message) +
          ") — making a silent captioned video.");
        await wait(1800);
      }
    }
    const narrationOn = !!clips;

    const videoStream = canvas.captureStream(30);
    let audioCtx = null, dest = null;
    const tracks = videoStream.getVideoTracks().slice();
    if (narrationOn) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      dest = audioCtx.createMediaStreamDestination();
      startDither(audioCtx, dest);
      tracks.push(...dest.stream.getAudioTracks());
    }
    const mixed = new MediaStream(tracks);
    const mime = pickMime();
    // MediaRecorder's default lands around 0.8 Mbps here, which smears small UI
    // text into mush. Screen content needs a lot more than camera footage does.
    const recOpts = { videoBitsPerSecond: 12000000, audioBitsPerSecond: 128000 };
    if (mime) recOpts.mimeType = mime;
    const rec = new MediaRecorder(mixed, recOpts);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start(200);

    const tl = buildTimeline(guide, frames, clips, titleClip, opts.pace, narrationOn);

    // Schedule every clip up front against the audio clock. Sample-accurate, and
    // immune to the setTimeout jitter that accumulated one step at a time before.
    const LEAD = 0.15;
    const t0 = narrationOn ? audioCtx.currentTime + LEAD : 0;
    if (narrationOn) {
      tl.segs.forEach((s) => {
        if (!s.clip || !s.clip.pcm || !s.clip.pcm.length) return;
        const buf = audioCtx.createBuffer(1, s.clip.pcm.length, s.clip.sampleRate);
        buf.copyToChannel(s.clip.pcm, 0);
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        // Audible while it renders, which is reassuring in a visible page and
        // baffling from an offscreen document — narration playing out of nowhere
        // with no window to point at. Callers without a UI pass monitor: false.
        if (opts.monitor !== false) src.connect(audioCtx.destination);
        src.start(t0 + s.start);
      });
    }

    // The picture reads its position from the same clock the audio is on, so a
    // stalled frame catches up to the right slide instead of falling behind.
    const wallStart = Date.now();
    const clock = () =>
      narrationOn ? audioCtx.currentTime - t0 : (Date.now() - wallStart) / 1000;

    // Crossfade rather than hard-cut: paint the outgoing slide over the incoming
    // one at falling opacity. Hard cuts between static slides are the single
    // biggest thing that made this read as a slideshow instead of a video.
    const FADE = 0.4;
    const paint = (seg, local) => {
      if (!seg || seg.index < 0) drawTitle(ctx, W, H, guide);
      else drawStepFrame(ctx, W, H, frames[seg.index], frames.length, local);
    };
    const draw = () => {
      const t = clock();
      const i = tl.segs.indexOf(segAt(tl.segs, t));
      const seg = tl.segs[i];
      const into = Math.max(0, t - seg.start);
      paint(seg, seg.dur ? Math.min(1, into / seg.dur) : 1);
      if (i > 0 && into < FADE) {
        ctx.save();
        ctx.globalAlpha = 1 - into / FADE;
        paint(tl.segs[i - 1], 1);
        ctx.restore();
      }
    };
    let raf;
    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    loop();
    // requestAnimationFrame is suspended outright while the tab is hidden, which
    // would freeze the entire video on whichever slide was up when the user
    // switched away. A timer still fires, so the slides keep advancing — choppy,
    // but the right pictures in the right places.
    //
    // An offscreen document is *never* visible, so there the timer is the only
    // clock the picture has. It passes tickMs: 33 to match captureStream(30) and
    // get a full-rate render out of a page that will never see a frame callback.
    const tick = setInterval(draw, opts.tickMs || 100);

    const base = narrationOn ? 0.6 : 0.1; // narration already ate the first 60%
    const span = 1 - base - 0.04;
    prog(base, "Recording intro…");
    let reported = -2;
    while (clock() < tl.total) {
      const seg = segAt(tl.segs, clock());
      if (seg && seg.index !== reported) {
        reported = seg.index;
        if (seg.index >= 0)
          prog(base + span * (seg.index / frames.length),
            "Recording step " + (seg.index + 1) + " of " + frames.length + "…");
      }
      await wait(100);
    }

    cancelAnimationFrame(raf);
    clearInterval(tick);
    rec.stop();
    if (audioCtx) try { await audioCtx.close(); } catch (e) {}
    await stopped;

    prog(0.98, "Finalizing video…");
    const blob = new Blob(chunks, { type: (mime || "video/webm").split(";")[0] });
    const filename = safeName(guide.title) + ".webm";
    // An offscreen document can't start a download itself — it only has
    // chrome.runtime — so it takes the blob and hands it to the service worker.
    if (opts.onBlob) await opts.onBlob(blob, filename);
    else download(blob, filename);
    prog(1, "Done");
  }

  /* The API log travels with `aiText` and `apiLogText` and with nothing else.
   * html/markdown/pdf/pptx/video never read `step.network` — that is not an
   * oversight to tidy up later: a guide is for a person following steps, and
   * `GET /api/session → 200` on every slide of a video is noise at best. If you add
   * an exporter, leave it out of that one too. */
  window.FSExport = {
    html, markdown, ai, aiText, apiLogText, curlOf, pdf, pptx, video,
    PACES, DEFAULT_PACE, stepSecs,
  };
})();
