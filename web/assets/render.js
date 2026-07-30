// GuideGen — shared annotation renderer (window.FSRender)
(function () {
  // The annotation mark. Deliberately NOT the same value as the UI's primary
  // action, and deliberately warm: this gets drawn on top of whatever the user
  // was looking at, which is usually a blue-grey admin panel. Purple sat close
  // enough to that chrome to get lost in it; burnt orange cannot.
  //
  // It is a constant rather than a token because exports have no theme — a PDF
  // is a PDF whether the editor was in dark mode or not.
  const BRAND = "#c2410c";
  const ON_BRAND = "#fffdfa";
  const HILITE = "#c1352c";

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      if (!src) return reject(new Error("no image"));
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image load failed"));
      // A cross-origin image has to be requested with CORS or the canvas it is
      // drawn into is tainted — and toDataURL/getImageData on a tainted canvas
      // throws, which is every export of a *published* guide failing at the last
      // step. Only for http(s): extension screenshots are data: URLs, and asking
      // for CORS on a host that doesn't send the header turns a tainted load into
      // no load at all.
      if (/^https?:/i.test(src)) img.crossOrigin = "anonymous";
      img.src = src;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function pixelate(ctx, x, y, w, h, block) {
    x = Math.round(x); y = Math.round(y);
    w = Math.round(w); h = Math.round(h);
    if (w <= 0 || h <= 0) return;
    block = block || 10;
    const tw = Math.max(1, Math.floor(w / block));
    const th = Math.max(1, Math.floor(h / block));
    const tmp = document.createElement("canvas");
    tmp.width = tw; tmp.height = th;
    const tctx = tmp.getContext("2d");
    tctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, tw, th);
    const smooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tw, th, x, y, w, h);
    ctx.imageSmoothingEnabled = smooth;
    // subtle overlay so it reads as intentionally redacted
    ctx.save();
    ctx.fillStyle = "rgba(26,23,19,0.10)";
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  // Renders an annotated canvas for a step. Returns an HTMLCanvasElement.
  // For "note" steps (no screenshot) returns null.
  async function renderStep(step) {
    if (!step || !step.screenshot) return null;
    const img = await loadImage(step.screenshot);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    // dpr is bitmap px per CSS px for *this stored screenshot*, not necessarily
    // the device's devicePixelRatio — background.js folds the capture downscale
    // into it. So CSS px -> bitmap px is just * dpr, whatever the capture size.
    const dpr = step.dpr || 1;
    const scale = dpr;

    // Redaction regions first.
    (step.blurs || []).forEach((b) => {
      pixelate(ctx, b.x * scale, b.y * scale, b.w * scale, b.h * scale, 12);
    });

    // One accent, one idea: dim the page, lift the target back out of the dim,
    // ring it, and put the number beside it. The old treatment stacked a red
    // box, a red ripple and a badge sitting on top of the very thing it pointed
    // at — three marks competing, and the target obscured.
    const r = step.rect;
    if (r && r.w > 0 && r.h > 0) {
      const pad = 8 * scale;
      const bx = r.x * scale - pad;
      const by = r.y * scale - pad;
      const bw = r.w * scale + pad * 2;
      const bh = r.h * scale + pad * 2;
      const radius = 10 * scale;

      // keep an undimmed copy of the target before the scrim goes down
      const keep = document.createElement("canvas");
      keep.width = Math.max(1, Math.ceil(bw));
      keep.height = Math.max(1, Math.ceil(bh));
      keep.getContext("2d").drawImage(
        canvas, bx, by, bw, bh, 0, 0, keep.width, keep.height
      );

      // Barely there on purpose. At 0.16 the whole screenshot read as washed-out
      // grey; the ring and badge already carry the emphasis, so the scrim only
      // needs to take the surroundings a shade back.
      ctx.save();
      ctx.fillStyle = "rgba(26,23,19,0.07)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();

      ctx.save();
      roundRect(ctx, bx, by, bw, bh, radius);
      ctx.clip();
      ctx.drawImage(keep, bx, by, bw, bh);
      ctx.restore();

      ctx.save();
      ctx.lineWidth = 4 * scale;
      ctx.strokeStyle = BRAND;
      ctx.shadowColor = "rgba(194,65,12,0.42)";
      ctx.shadowBlur = 18 * scale;
      roundRect(ctx, bx, by, bw, bh, radius);
      ctx.stroke();
      ctx.restore();

      drawMarker(ctx, step.seq || 1, bx, by, bw, bh, scale, canvas);
    }

    // No cursor dot: the ring already says where to act, and a dot inside a text
    // field lands on top of the label the reader is trying to read.

    return canvas;
  }

  // Number badge placed *outside* the highlight, tucked against its top-left
  // corner, flipping to another side when that would fall off the screenshot.
  function drawMarker(ctx, num, bx, by, bw, bh, scale, canvas) {
    const rr = 19 * scale;
    let cx = bx - rr * 0.85;
    let cy = by - rr * 0.85;
    if (cx < rr) cx = bx + bw + rr * 0.85;
    if (cy < rr) cy = by + bh + rr * 0.85;
    cx = Math.max(rr, Math.min(canvas.width - rr, cx));
    cy = Math.max(rr, Math.min(canvas.height - rr, cy));
    ctx.save();
    ctx.fillStyle = BRAND;
    ctx.strokeStyle = ON_BRAND;
    ctx.lineWidth = 3 * scale;
    ctx.shadowColor = "rgba(26,23,19,0.35)";
    ctx.shadowBlur = 8 * scale;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.fillStyle = ON_BRAND;
    ctx.font = "bold " + Math.round(21 * scale) + "px -apple-system, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(num), cx, cy + scale);
    ctx.restore();
  }

  function canvasToDataURL(canvas, maxWidth) {
    if (maxWidth && canvas.width > maxWidth) {
      const s = maxWidth / canvas.width;
      const c2 = document.createElement("canvas");
      c2.width = maxWidth;
      c2.height = Math.round(canvas.height * s);
      const cx = c2.getContext("2d");
      cx.drawImage(canvas, 0, 0, c2.width, c2.height);
      return c2.toDataURL("image/png");
    }
    return canvas.toDataURL("image/png");
  }

  // Bounding box of the page's actual content, found by trimming uniform
  // margins. Web apps centre their UI in a lot of empty background; this finds
  // where the real pixels are so a crop can drop the emptiness without slicing
  // through the interface. Measured on a small downscale — plenty for margins.
  function contentBox(canvas, tol) {
    const SW = 240;
    const s = SW / canvas.width;
    const sh = Math.max(1, Math.round(canvas.height * s));
    const tmp = document.createElement("canvas");
    tmp.width = SW;
    tmp.height = sh;
    tmp.getContext("2d").drawImage(canvas, 0, 0, SW, sh);
    let d;
    try {
      d = tmp.getContext("2d").getImageData(0, 0, SW, sh).data;
    } catch (e) {
      return null; // tainted canvas — caller falls back to the full frame
    }
    const at = (x, y) => (y * SW + x) * 4;
    // Background = the most common of the four corners.
    const corners = [[0, 0], [SW - 1, 0], [0, sh - 1], [SW - 1, sh - 1]].map(([x, y]) => {
      const i = at(x, y);
      return d[i] + "," + d[i + 1] + "," + d[i + 2];
    });
    const counts = {};
    corners.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
    const bg = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0].split(",").map(Number);
    // Low threshold on purpose: web apps put near-white cards on near-white
    // backgrounds, and a 1px border downscales to a few percent of coverage. At
    // tol 14 those vanish and the "content" box collapses onto stray dark text.
    const T = tol == null ? 8 : tol;
    let x0 = SW, y0 = sh, x1 = -1, y1 = -1;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < SW; x++) {
        const i = at(x, y);
        if (
          Math.abs(d[i] - bg[0]) > T ||
          Math.abs(d[i + 1] - bg[1]) > T ||
          Math.abs(d[i + 2] - bg[2]) > T
        ) {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < x0 || y1 < y0) return null;
    return {
      x: x0 / s,
      y: y0 / s,
      w: (x1 - x0 + 1) / s,
      h: (y1 - y0 + 1) / s,
    };
  }

  // Picks the part of a screenshot worth showing, in the aspect the caller
  // needs. Two competing failures to avoid: showing the whole viewport shrinks
  // the UI to an illegible island, but zooming to the clicked element slices
  // through cards and text and leaves the viewer with no idea where they are.
  // So: start from the page's content box, guarantee the highlighted target
  // fits inside it with margin, and cap how far we're willing to zoom.
  function focusRegion(step, srcW, srcH, aspect, opts) {
    opts = opts || {};

    // `baked` means the image already IS the final crop, with its ring, badge and
    // redactions burned in — a published guide's image, in other words. Cropping
    // it again is not a smaller improvement, it is damage: the baked images are
    // 1.6 and PPTX asks for 2.0, so re-cropping sliced the number badge and the
    // top of the highlight off every slide. Nothing to choose here, so return the
    // whole frame and let the caller letterbox it.
    if (step && step.baked) return { x: 0, y: 0, w: srcW, h: srcH };

    const maxZoom = opts.maxZoom || 1.5; // never magnify more than this
    const dpr = step.dpr || 1;
    const canvas = opts.canvas || null;

    let box = canvas ? contentBox(canvas, opts.tol) : null;
    if (box) {
      // a little air around the content so it doesn't touch the frame edge
      const air = Math.min(srcW, srcH) * 0.02;
      box = { x: box.x - air, y: box.y - air, w: box.w + air * 2, h: box.h + air * 2 };
    }

    // The target, padded enough that its highlight ring and number badge are
    // never clipped by the crop edge.
    const r = step.rect;
    let target = null;
    if (r && r.w > 0 && r.h > 0) {
      const pad = 44 * dpr;
      target = { x: r.x * dpr - pad, y: r.y * dpr - pad, w: r.w * dpr + pad * 2, h: r.h * dpr + pad * 2 };
    } else if (step.point) {
      const pad = 60 * dpr;
      target = { x: step.point.x * dpr - pad, y: step.point.y * dpr - pad, w: pad * 2, h: pad * 2 };
    }

    if (!box && !target) return null;
    let reg = box || target;
    if (box && target) {
      const x0 = Math.min(box.x, target.x);
      const y0 = Math.min(box.y, target.y);
      const x1 = Math.max(box.x + box.w, target.x + target.w);
      const y1 = Math.max(box.y + box.h, target.y + target.h);
      reg = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    // Don't magnify past maxZoom: grow the region back out if it's too tight.
    const minW = srcW / maxZoom;
    const minH = srcH / maxZoom;
    if (reg.w < minW) { reg.x -= (minW - reg.w) / 2; reg.w = minW; }
    if (reg.h < minH) { reg.y -= (minH - reg.h) / 2; reg.h = minH; }

    // Fit the requested aspect by growing the short side, never cropping tighter.
    let w = reg.w, h = reg.h;
    if (w / h < aspect) w = h * aspect; else h = w / aspect;
    // If that won't fit the screenshot, shrinking it back would slice content
    // off — it cut a page logo to "age". Show the whole frame instead and let
    // the caller letterbox: losing some magnification beats losing the page.
    if (w > srcW + 0.5 || h > srcH + 0.5) {
      return { x: 0, y: 0, w: srcW, h: srcH };
    }

    const cx = reg.x + reg.w / 2;
    const cy = reg.y + reg.h / 2;
    let x = Math.max(0, Math.min(srcW - w, cx - w / 2));
    let y = Math.max(0, Math.min(srcH - h, cy - h / 2));

    // Centring on the content can still push the highlighted target out of
    // frame once the aspect fit trims a side — a target near the bottom edge
    // got cut. Slide the window the minimum needed to keep it in view.
    if (target) {
      const tx0 = Math.max(0, target.x);
      const ty0 = Math.max(0, target.y);
      const tx1 = Math.min(srcW, target.x + target.w);
      const ty1 = Math.min(srcH, target.y + target.h);
      if (tx0 < x) x = tx0;
      if (ty0 < y) y = ty0;
      if (tx1 > x + w) x = tx1 - w;
      if (ty1 > y + h) y = ty1 - h;
      x = Math.max(0, Math.min(srcW - w, x));
      y = Math.max(0, Math.min(srcH - h, y));
    }
    return { x, y, w, h };
  }

  window.FSRender = { renderStep, canvasToDataURL, loadImage, focusRegion, contentBox, BRAND, ON_BRAND, HILITE };
})();
