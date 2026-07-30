/* GuideGen — light / dark / auto (window.GGTheme).
 *
 * Loaded synchronously in <head>, BEFORE the stylesheet, and that placement is the
 * whole trick: it stamps data-theme on <html> before the first paint, so there is
 * no flash of the wrong theme and site.css needs exactly one dark block rather
 * than a duplicated set of values behind a media query.
 *
 * Three modes, stored under gg_theme:
 *   "light"  (the default)
 *   "dark"
 *   "auto"   follow the operating system, and keep following it if it changes
 *
 * The default is light rather than the OS setting on purpose. Everything this
 * product produces is light — the HTML export, the PDF, the published guide page,
 * the video slides — so an editor that looks like the thing you're making beats
 * one that flips with the time of day. Auto is one click away.
 *
 * The choice is also pushed to the extension, so the toolbar popup doesn't sit
 * there in dark mode while the dashboard is light. It can't read this
 * localStorage — different origin — so it goes over the bridge.
 */
(function () {
  var KEY = "gg_theme";
  var MODES = ["light", "dark", "auto"];

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return MODES.indexOf(v) !== -1 ? v : null;
    } catch (e) { return null; }   // private mode, or storage disabled
  }

  var mode = stored() || "light";

  function systemIsDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function resolved(m) {
    return (m === "auto" ? (systemIsDark() ? "dark" : "light") : m);
  }

  // On mobile, this tints the browser's own chrome around the page. It has to be
  // set from JS rather than two media-query <meta> tags, because the theme here is
  // a stored choice and a media query can only see the OS.
  var CHROME = { light: "#fbfaf7", dark: "#15130f" };
  function themeColor(name) {
    var tag = document.querySelector('meta[name="theme-color"]');
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("name", "theme-color");
      // <head> may not exist yet when this runs from a blocking script in <head>;
      // documentElement always does.
      (document.head || document.documentElement).appendChild(tag);
    }
    tag.setAttribute("content", CHROME[name] || CHROME.light);
  }

  // Runs before the stylesheet is applied on first call, hence no flash.
  function apply() {
    var name = resolved(mode);
    document.documentElement.setAttribute("data-theme", name);
    themeColor(name);
  }
  apply();

  // Only meaningful in auto: follow the OS if it changes mid-session.
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () { if (mode === "auto") { apply(); paint(); } };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  function set(next) {
    if (MODES.indexOf(next) === -1) return;
    mode = next;
    try { localStorage.setItem(KEY, next); } catch (e) { /* nothing to do */ }
    apply();
    paint();
    tellExtension(next);
  }

  // Keep the popup in step. Fire and forget: no extension, or an older one, just
  // means the popup carries on following the OS.
  function tellExtension(next) {
    try {
      if (window.GGBridge && GGBridge.available && GGBridge.available()) {
        GGBridge.setTheme(next).catch(function () {});
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- the control ----------

  var ICON = {
    light: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M4.6 12H2.4M21.6 12h-2.2M6.4 6.4 4.8 4.8M19.2 19.2l-1.6-1.6M17.6 6.4l1.6-1.6M4.8 19.2l1.6-1.6"/>',
    dark: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z"/>',
    auto: '<circle cx="12" cy="12" r="8.4"/><path d="M12 3.6v16.8a8.4 8.4 0 0 0 0-16.8z" fill="currentColor" stroke="none"/>',
  };
  var LABEL = { light: "Light", dark: "Dark", auto: "Match my system" };

  function svg(path) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + "</svg>";
  }

  function paint() {
    var wrap = document.querySelector(".theme-toggle");
    if (!wrap) return;
    [].forEach.call(wrap.querySelectorAll("button"), function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    });
  }

  function build() {
    var host = document.querySelector("header.site .row");
    if (!host || host.querySelector(".theme-toggle")) return;

    var wrap = document.createElement("div");
    wrap.className = "theme-toggle";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Colour theme");
    wrap.innerHTML = MODES.map(function (m) {
      return '<button type="button" data-mode="' + m + '" title="' + LABEL[m] +
        '" aria-label="' + LABEL[m] + '">' + svg(ICON[m]) + "</button>";
    }).join("");
    wrap.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-mode]");
      if (b) set(b.dataset.mode);
    });

    // Before the nav, so it reads as a page control rather than an account one.
    var nav = host.querySelector("nav");
    if (nav) host.insertBefore(wrap, nav);
    else host.appendChild(wrap);
    paint();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }

  window.GGTheme = {
    get: function () { return mode; },
    resolved: function () { return resolved(mode); },
    set: set,
  };
})();
