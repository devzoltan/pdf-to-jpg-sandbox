#!/bin/sh
# PDF (stdin) -> JPEG pages as a tar archive (stdout). Diagnostics: only a short code on stderr.
# Exit codes: 10 invalid/empty, 11 encrypted, 12 too many pages, 13 output too large,
#             14 rendering failed, 15 input too large, 16 resource/internal error
set -eu
umask 077

MAX_IN=${PDF2JPG_MAX_INPUT_BYTES:-20971520}
MAX_PAGES=${PDF2JPG_MAX_PAGES:-50}
DPI=${PDF2JPG_DPI:-150}
MAX_PX=${PDF2JPG_MAX_PX:-2000}
QUALITY=${PDF2JPG_JPEG_QUALITY:-85}
MAX_OUT=${PDF2JPG_MAX_OUTPUT_BYTES:-52428800}

W=/work
IN="$W/in.pdf"
OUT="$W/out"

fail() {
  echo "PDF2JPG_ERROR=$1" >&2
  exit "$2"
}

mkdir -p "$OUT" || fail INTERNAL 16

# Read the input with an upper bound (one extra byte to detect overflow)
head -c $((MAX_IN + 1)) > "$IN" || fail INTERNAL 16
size=$(stat -c %s "$IN")
[ "$size" -gt 0 ] || fail INVALID_PDF 10
[ "$size" -le "$MAX_IN" ] || fail INPUT_TOO_LARGE 15
head -c 1024 "$IN" | grep -a -q '%PDF-' || fail INVALID_PDF 10

rc=0
pdfinfo "$IN" > "$W/info.txt" 2> "$W/info.err" || rc=$?
if [ "$rc" -ne 0 ]; then
  # > 128: killed by a signal (e.g. memory limit) => resource error, not a PDF error
  [ "$rc" -le 128 ] || fail RESOURCE 16
  if grep -q -i 'password' "$W/info.err"; then fail ENCRYPTED 11; fi
  fail INVALID_PDF 10
fi
# Any encryption (including owner-password-only) is rejected
if grep -q -E '^Encrypted:[[:space:]]+yes' "$W/info.txt"; then fail ENCRYPTED 11; fi

pages=$(sed -n 's/^Pages:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$W/info.txt")
[ -n "$pages" ] || fail INVALID_PDF 10
[ "$pages" -ge 1 ] || fail INVALID_PDF 10
[ "$pages" -le "$MAX_PAGES" ] || fail TOO_MANY_PAGES 12

pdfinfo -box -f 1 -l "$pages" "$IN" > "$W/boxes.txt" 2> /dev/null || fail INVALID_PDF 10

total=0
i=1
while [ "$i" -le "$pages" ]; do
  # Resolution per page: at most DPI, and low enough that the longest side stays <= MAX_PX
  # (proportional scaling, no cropping).
  dpi=$(awk -v p="$i" -v base="$DPI" -v maxpx="$MAX_PX" '
    $1 == "Page" && $2 == p && $3 == "CropBox:" {
      w = $6 - $4; if (w < 0) w = -w
      h = $7 - $5; if (h < 0) h = -h
      L = (w > h) ? w : h
      if (L <= 0) { print "ERR"; exit }
      d = base
      m = (maxpx - 1) * 72 / L
      if (m < d) d = m
      printf "%.4f", d
      found = 1
      exit
    }
    END { if (!found) print "ERR" }' "$W/boxes.txt")
  [ "$dpi" != "ERR" ] || fail INVALID_PDF 10

  name=$(printf 'page-%03d' "$i")
  rc=0
  pdftoppm -q -cropbox -f "$i" -l "$i" -singlefile -r "$dpi" \
    -jpeg -jpegopt "quality=$QUALITY" "$IN" "$OUT/$name" 2> /dev/null || rc=$?
  if [ "$rc" -ne 0 ]; then
    [ "$rc" -le 128 ] || fail RESOURCE 16
    fail RENDER_FAILED 14
  fi
  [ -s "$OUT/$name.jpg" ] || fail RENDER_FAILED 14

  total=$((total + $(stat -c %s "$OUT/$name.jpg")))
  [ "$total" -le "$MAX_OUT" ] || fail OUTPUT_TOO_LARGE 13
  i=$((i + 1))
done

rm -f "$IN"
cd "$OUT"
tar --format=ustar --owner=0 --group=0 --numeric-owner -cf - page-*.jpg || fail INTERNAL 16
