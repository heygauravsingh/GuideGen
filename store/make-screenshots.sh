#!/bin/bash
# Converts any screenshots you took into exact Chrome Web Store dimensions (1280x800).
#
# Usage:
#   1. Take screenshots of FlowScribe however you like (Cmd+Shift+4 on macOS).
#   2. Drop them into store/screenshots-raw/
#   3. Run:  bash store/make-screenshots.sh
#   4. Upload everything from store/screenshots-out/
#
# Images are scaled to fit and centred on a white canvas, so nothing is cropped
# or stretched — the store rejects wrong dimensions, not letterboxing.

set -e
cd "$(dirname "$0")/.."
RAW="store/screenshots-raw"
OUT="store/screenshots-out"
W=1280
H=800

mkdir -p "$RAW" "$OUT"

shopt -s nullglob nocaseglob
files=("$RAW"/*.png "$RAW"/*.jpg "$RAW"/*.jpeg)

if [ ${#files[@]} -eq 0 ]; then
  echo "No images found in $RAW/"
  echo "Put your screenshots there and run this again."
  exit 0
fi

i=0
for f in "${files[@]}"; do
  i=$((i + 1))
  out="$OUT/screenshot-$i.png"
  # scale to fit inside 1280x800, then pad to exactly 1280x800 on white
  sips -s format png "$f" --out "$out" >/dev/null
  sips --resampleHeightWidthMax $W "$out" >/dev/null
  sips -p $H $W --padColor FFFFFF "$out" >/dev/null 2>&1
  dims=$(sips -g pixelWidth -g pixelHeight "$out" 2>/dev/null | awk '/pixel/{printf "%s", $2"x"}' | sed 's/x$//')
  echo "  $(basename "$f")  ->  $out   [$dims]"
done

echo
echo "Done. $i screenshot(s) in $OUT/ at ${W}x${H} — ready to upload."
