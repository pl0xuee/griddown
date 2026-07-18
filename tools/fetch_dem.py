#!/usr/bin/env python3
"""Download Terrarium DEM tiles (AWS Open Data) for a bbox into a static XYZ
pyramid under public/dem/{z}/{x}/{y}.png. Resumable + parallel."""
import math, os, sys, time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "dem")

# Bounding box + zoom for the region to download.
# Usage: python3 tools/fetch_dem.py <minLon,minLat,maxLon,maxLat> [maxzoom]
if len(sys.argv) >= 2:
    W, S, E, N = (float(v) for v in sys.argv[1].split(","))
else:
    print("Usage: fetch_dem.py <minLon,minLat,maxLon,maxLat> [maxzoom]")
    print("  e.g. fetch_dem.py -124.57,41.98,-116.46,46.30 12")
    sys.exit(2)
MINZ = 0
MAXZ = int(sys.argv[2]) if len(sys.argv) >= 3 else 12

def deg2num(lat, lon, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    r = math.radians(lat)
    y = int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * n)
    return x, y

def tiles():
    for z in range(MINZ, MAXZ + 1):
        x0, y1 = deg2num(N, W, z)
        x1, y0 = deg2num(S, E, z)
        for x in range(min(x0, x1), max(x0, x1) + 1):
            for y in range(min(y0, y1), max(y0, y1) + 1):
                yield z, x, y

done = 0
skipped = 0
failed = []

def fetch(t):
    global done, skipped
    z, x, y = t
    path = os.path.join(OUT, str(z), str(x), f"{y}.png")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        skipped += 1
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    url = BASE.format(z=z, x=x, y=y)
    for attempt in range(4):
        try:
            req = Request(url, headers={"User-Agent": "offline-map-dem/1.0"})
            with urlopen(req, timeout=30) as r:
                data = r.read()
            with open(path, "wb") as f:
                f.write(data)
            done += 1
            return
        except (URLError, HTTPError) as e:
            if attempt == 3:
                failed.append((t, str(e)))
            else:
                time.sleep(1 + attempt)

all_tiles = list(tiles())
print(f"Total tiles to consider: {len(all_tiles)} (z{MINZ}-{MAXZ})", flush=True)
start = time.time()
with ThreadPoolExecutor(max_workers=24) as ex:
    for i, _ in enumerate(ex.map(fetch, all_tiles)):
        if (i + 1) % 500 == 0:
            print(f"  {i+1}/{len(all_tiles)}  downloaded={done} skipped={skipped} "
                  f"failed={len(failed)}  {time.time()-start:.0f}s", flush=True)
print(f"DONE: downloaded={done} skipped={skipped} failed={len(failed)} "
      f"in {time.time()-start:.0f}s", flush=True)
if failed:
    print("First failures:", failed[:5], flush=True)
    sys.exit(1)
