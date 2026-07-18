#!/usr/bin/env bash
# Extract a US state's basemap from the Protomaps daily planet build into a local
# .pmtiles, and symlink it under public/ so the app serves it offline.
#
# Usage: tools/fetch_state_pmtiles.sh <name> <minLon,minLat,maxLon,maxLat> [maxzoom]
# Example: tools/fetch_state_pmtiles.sh region -124.0,41.0,-116.0,46.0
set -euo pipefail

NAME="${1:?region name required, e.g. region}"
BBOX="${2:?bbox required: minLon,minLat,maxLon,maxLat}"
MAXZOOM="${3:-15}"

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PM="$DIR/tools/pmtiles"
[ -x "$PM" ] || { echo "Missing $PM — download go-pmtiles from GitHub releases"; exit 1; }

# Find the most recent Protomaps daily planet build (probe back a few days).
BUILD=""
for i in 0 1 2 3 4 5 6 7; do
  D=$(date -u -d "-$i day" +%Y%m%d)
  if curl -s -o /dev/null -w "%{http_code}" -r 0-0 "https://build.protomaps.com/$D.pmtiles" | grep -q 206; then
    BUILD="$D"; break
  fi
done
[ -n "$BUILD" ] || { echo "Could not find a recent Protomaps planet build"; exit 1; }
echo "Using planet build $BUILD"

mkdir -p "$DIR/mapdata" "$DIR/public/mapdata"
OUT="$DIR/mapdata/$NAME.pmtiles"
"$PM" extract "https://build.protomaps.com/$BUILD.pmtiles" "$OUT" \
  --bbox="$BBOX" --maxzoom="$MAXZOOM" --download-threads=8

ln -sf "../../mapdata/$NAME.pmtiles" "$DIR/public/mapdata/$NAME.pmtiles"
echo "Done: $OUT ($(du -h "$OUT" | cut -f1))"
