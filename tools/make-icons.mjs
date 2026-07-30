#!/usr/bin/env node
// Draws icons/icon{16,48,128}.png from scratch.
//
//   node tools/make-icons.mjs           write the icons
//   node tools/make-icons.mjs --check   exit 1 if what's on disk differs
//
// Why a generator and not three exported files: the icons went stale the moment
// the palette changed, and nobody noticed because a PNG doesn't show up in a grep
// for #7c3aed. Now they're derived from the same values as everything else, and
// --check catches it if they drift again.
//
// No dependencies. PNG is a container around zlib, both of which Node has, and
// the shapes are simple enough to rasterise directly — pulling in a canvas
// library for three flat images would be worse than 60 lines of arithmetic.
import { deflateSync } from "node:zlib";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The one accent, straight from site.css. Ochre and not ink, for a reason that is
// specific to toolbar icons: Chrome's toolbar is light in light mode and dark in
// dark mode, and the icon has to survive both. Near-black — which is what the
// in-app mark uses — disappears against dark chrome. Ochre holds up on either,
// and a toolbar icon is the one place a saturated brand colour genuinely earns
// its keep, because recognition at 16px is the whole job.
const BG = [0xc2, 0x41, 0x0c];   // #c2410c
const FG = [0xff, 0xfd, 0xfa];   // #fffdfa

const SS = 4;   // supersample, then box-average down. Cheap anti-aliasing.

// The wordmark glyph: three lines of decreasing length, same as the site header
// and the popup. Proportions taken from the SVG path "M4 6h10M4 12h16M4 18h7".
const BARS = [0.625, 1.0, 0.4375];

function draw(size) {
  const W = size * SS;
  const big = new Uint8Array(W * W * 4);

  const put = (x, y, rgb, a) => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = (y * W + x) * 4;
    // painting order is background then glyph, both opaque, so a plain overwrite
    // is correct and there is nothing to blend against
    big[i] = rgb[0]; big[i + 1] = rgb[1]; big[i + 2] = rgb[2]; big[i + 3] = a;
  };

  const roundRect = (x0, y0, w, h, r, rgb) => {
    const x1 = x0 + w, y1 = y0 + h;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        // clamp the pixel into the rect, then test the distance to the nearest
        // corner centre — inside the straight edges that distance is 0
        const cx = Math.min(Math.max(x + 0.5, x0 + r), x1 - r);
        const cy = Math.min(Math.max(y + 0.5, y0 + r), y1 - r);
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r * r) put(x, y, rgb, 255);
      }
    }
  };

  // the tile: a hair of transparent margin so the corners aren't clipped
  const inset = Math.round(size * 0.02) * SS;
  roundRect(inset, inset, W - inset * 2, W - inset * 2, size * 0.235 * SS, BG);

  // the glyph. Round to whole device pixels *before* supersampling, so the bars
  // land on the pixel grid and stay crisp at 16px instead of going soft.
  const barH = Math.max(1, Math.round(size * 0.105));
  const left = Math.round(size * 0.215);
  const span = size - left * 2;
  const rows = [0.305, 0.5, 0.695].map((f) => Math.round(size * f - barH / 2));

  rows.forEach((yTop, i) => {
    const w = Math.max(barH, Math.round(span * BARS[i]));
    roundRect(left * SS, yTop * SS, w * SS, barH * SS, (barH / 2) * SS, FG);
  });

  // box-downsample SS x SS
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * W + (x * SS + dx)) * 4;
          const al = big[i + 3];
          r += big[i] * al; g += big[i + 1] * al; b += big[i + 2] * al; a += al;
        }
      }
      const o = (y * size + x) * 4;
      if (a === 0) { out[o] = out[o+1] = out[o+2] = out[o+3] = 0; continue; }
      // premultiplied average, then back out — otherwise transparent pixels drag
      // the edge colour toward black
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

// ---- PNG (RGBA8, one IDAT) ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // truecolour + alpha
  // filter 0 on every scanline: these are flat images, so a smarter filter would
  // save a few dozen bytes and cost real complexity
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4)
      .copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- ICO (a container around PNGs, which Vista+ accepts) ----
// Only here for /favicon.ico. Explicit <link rel="icon"> tags cover every browser
// that matters, but bots, feed readers and the odd embedder request /favicon.ico
// directly whatever the markup says — and a 404 on it was showing up in the logs.
function ico(sizes) {
  const imgs = sizes.map((s) => png(s, draw(s)));
  const dir = Buffer.alloc(6 + 16 * imgs.length);
  dir.writeUInt16LE(0, 0);            // reserved
  dir.writeUInt16LE(1, 2);            // type 1 = icon
  dir.writeUInt16LE(imgs.length, 4);
  let offset = dir.length;
  imgs.forEach((buf, i) => {
    const p = 6 + i * 16;
    dir[p] = sizes[i] >= 256 ? 0 : sizes[i];   // 0 means 256
    dir[p + 1] = sizes[i] >= 256 ? 0 : sizes[i];
    dir[p + 2] = 0;                   // palette size
    dir[p + 3] = 0;                   // reserved
    dir.writeUInt16LE(1, p + 4);      // colour planes
    dir.writeUInt16LE(32, p + 6);     // bits per pixel
    dir.writeUInt32LE(buf.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += buf.length;
  });
  return Buffer.concat([dir, ...imgs]);
}

// ---- SVG ----
// The primary favicon: one path per bar, crisp at any size, ~300 bytes. Built from
// the same constants as the rasters so the two can't drift.
function svg() {
  const S = 128;
  const barH = Math.round(S * 0.105);
  const left = Math.round(S * 0.215);
  const span = S - left * 2;
  const rows = [0.305, 0.5, 0.695].map((f) => Math.round(S * f - barH / 2));
  const hex = (c) => "#" + c.map((n) => n.toString(16).padStart(2, "0")).join("");
  const bars = rows.map((y, i) => {
    const w = Math.max(barH, Math.round(span * BARS[i]));
    return `    <rect x="${left}" y="${y}" width="${w}" height="${barH}" rx="${barH / 2}"/>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}">
  <title>GuideGen</title>
  <rect width="${S}" height="${S}" rx="${Math.round(S * 0.235)}" fill="${hex(BG)}"/>
  <g fill="${hex(FG)}">
${bars}
  </g>
</svg>
`;
}

const check = process.argv.includes("--check");
let stale = 0;

// Everything this generator owns, and where it goes. `icons/` is the extension;
// `web/` is the site, and it needs its own copies because .vercelignore serves
// nothing outside web/.
const OUTPUTS = [
  ["icons/icon16.png", () => png(16, draw(16))],
  ["icons/icon48.png", () => png(48, draw(48))],
  ["icons/icon128.png", () => png(128, draw(128))],
  ["web/favicon.ico", () => ico([16, 32])],
  ["web/favicon.svg", () => Buffer.from(svg(), "utf8")],
  // 180 is what iOS asks for when someone adds the page to their home screen.
  ["web/apple-touch-icon.png", () => png(180, draw(180))],
];

for (const [rel, build] of OUTPUTS) {
  const file = resolve(ROOT, rel);
  const buf = build();
  if (check) {
    const cur = existsSync(file) ? readFileSync(file) : null;
    if (!cur || !cur.equals(buf)) {
      stale++;
      console.error(`stale: ${rel} ${cur ? "differs from" : "is missing"} the generator's output`);
    }
    continue;
  }
  writeFileSync(file, buf);
  console.log(`wrote ${rel} (${buf.length} bytes)`);
}

if (check) {
  if (stale) {
    console.error(`\n${stale} icon(s) out of date. Run: node tools/make-icons.mjs`);
    process.exit(1);
  }
  console.log("icons match the generator");
}
