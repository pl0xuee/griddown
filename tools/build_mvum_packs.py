#!/usr/bin/env python3
"""Build per-state Forest Service MVUM overlays from the national shapefiles.

    python3 tools/build_mvum_packs.py --out dist/mvum
    python3 tools/build_mvum_packs.py --out dist/mvum --only OR,WA --cache .cache

Why this exists
---------------
The app has always fetched forest roads live from the Forest Service's own
ArcGIS service, one state at a time, and that service is the single point of
failure for the feature: when `apps.fs.usda.gov/arcx` returns 500 — as it does
today, for its entire service catalogue, not just this layer — there is no way
to get forest roads at all. The data itself is fine; only that one door is shut.

The same data is published a second way, as national shapefiles on the FSGeodata
Clearinghouse, on a host that is up. This turns those into exactly the per-state
files the app already knows how to read, once, in CI — so a phone downloads a
few megabytes from a host we control and an outage at the Forest Service stops
mattering at the moment somebody actually needs the map.

Dependency-free on purpose: stdlib `zipfile` and `struct` read both the geometry
and the attributes, so CI needs nothing installed and this runs anywhere python3
does. The same reasoning as the hand-rolled PDF writer in src/paper.ts.

What it does NOT change
-----------------------
Coverage. Both channels serve the same Enterprise Data Warehouse product, so
this is the identical data by a different road. The Forest Service's own
metadata is worth repeating: "Not every National Forest has data included in
this feature class." It covers National Forest System land only, only routes
designated open to motor vehicles, and "open" means legally open, never
passable. Absence of data here must never be presented as absence of
restrictions — see renderMvumCheck in src/route.ts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

BASE = "https://data.fs.usda.gov/geodata/edw/edw_resources/shp"
SOURCES = [
    # (kind tag written onto every feature, zip name, member stem)
    ("road", f"{BASE}/S_USA.Road_MVUM.zip", "S_USA.Road_MVUM"),
    ("trail", f"{BASE}/S_USA.Trail_MVUM.zip", "S_USA.Trail_MVUM"),
]

# Matches MVUM_TOLERANCE in src-tauri/src/lib.rs: ~11 m, which is finer than the
# GPS you navigate a forest road with and cuts the file by roughly two thirds.
SIMPLIFY_DEG = 0.0001
# Matches the API's geometryPrecision=5. Five decimal places is ~1 m.
COORD_DP = 5

# dBase truncates field names to 10 characters and upper-cases them, so the
# shapefile's names are nothing like the ones the API returns and the app reads
# in its map expressions (src/mvum.ts). This table is the bridge, and it is the
# part of this script most worth checking against real records: several pairs
# are genuinely ambiguous by name alone.
#
# In particular the >50" and <50" OHV groups collide once truncated. Resolved by
# reading actual rows: a trail whose MVUM_SYMBO says "open to vehicles 50\" or
# less" carries OTHER_OH_1/OTHER_OH_2 and leaves OTHER_OHV_/OTHER_OHV1 empty, so
# the _1/_2 pair is the <50" group and the bare pair is >50".
FIELD_MAP = {
    "ID": "id",
    "NAME": "name",
    "SYMBOL": "symbol",
    "MVUM_SYMBO": "mvum_symbol_name",
    "JURISDICTI": "jurisdiction",
    "SEASONAL": "seasonal",
    "FORESTNAME": "forestname",
    "DISTRICTNA": "districtname",
    "PASSENGERV": "passengervehicle",
    "PASSENGE_1": "passengervehicle_datesopen",
    "HIGHCLEARA": "highclearancevehicle",
    "HIGHCLEA_1": "highclearancevehicle_datesopen",
    "MOTORHOME": "motorhome",
    "MOTORHOME_": "motorhome_datesopen",
    "FOURWD_GT5": "fourwd_gt50inches",
    "FOURWD_G_1": "fourwd_gt50_datesopen",
    "TWOWD_GT50": "twowd_gt50inches",
    "TWOWD_GT_1": "twowd_gt50_datesopen",
    "ATV": "atv",
    "ATV_DATESO": "atv_datesopen",
    "MOTORCYCLE": "motorcycle",
    "MOTORCYC_1": "motorcycle_datesopen",
    "OTHERWHEEL": "otherwheeled_ohv",
    "OTHERWHE_1": "otherwheeled_ohv_datesopen",
    "OTHER_OH_1": "other_ohv_lt50inches",
    "OTHER_OH_2": "other_ohv_lt50_datesopen",
    # Road-only.
    "OPERATIONA": "operationalmaintlevel",
    "SURFACETYP": "surfacetype",
    # Trail-only.
    "TRAILCLASS": "trailclass",
}


# Fields each layer must have. Split because a few are one-sided: a road has an
# operational maintenance level and a surface, a trail has a trail class, and
# neither has the other's.
ROAD_ONLY = {"OPERATIONA", "SURFACETYP"}
TRAIL_ONLY = {"TRAILCLASS"}
COMMON_FIELDS = set(FIELD_MAP) - ROAD_ONLY - TRAIL_ONLY
KIND_FIELDS = {
    "road": COMMON_FIELDS | ROAD_ONLY,
    "trail": COMMON_FIELDS | TRAIL_ONLY,
}


def log(msg: str) -> None:
    print(msg, flush=True)


# --- Shapefile ---------------------------------------------------------------


def read_dbf_header(f):
    """Field descriptors and record geometry from a .dbf header."""
    head = f.read(32)
    _, _, _, _, nrec, hlen, rlen = struct.unpack("<BBBBIHH", head[:12])
    rest = f.read(hlen - 32)
    fields = []
    for i in range((hlen - 33) // 32):
        d = rest[i * 32 : (i + 1) * 32]
        if d[:1] == b"\r":
            break
        name = d[:11].split(b"\x00")[0].decode("ascii", "replace")
        fields.append((name, chr(d[11]), d[16]))
    return fields, nrec, rlen


def dbf_records(f, fields, nrec, rlen, wanted):
    """Yield one dict per record, decoding only the fields we keep.

    `wanted` is a set of dbf names; everything else is skipped without being
    decoded, which matters when a record is 3 kB and there are 700,000 of them.
    """
    offsets, pos = [], 1  # byte 0 is the deletion flag
    for name, ftype, flen in fields:
        if name in wanted:
            offsets.append((name, pos, flen, ftype))
        pos += flen
    for _ in range(nrec):
        rec = f.read(rlen)
        if len(rec) < rlen:
            return
        deleted = rec[:1] == b"*"
        out = {}
        for name, off, flen, ftype in offsets:
            raw = rec[off : off + flen].decode("latin-1").strip()
            if not raw:
                continue
            if ftype in "NF":
                try:
                    num = float(raw)
                    out[name] = int(num) if num.is_integer() else num
                except ValueError:
                    pass
            else:
                out[name] = raw
        yield None if deleted else out


def shp_shapes(f):
    """Yield (bbox, parts) per .shp record. Non-polyline shapes yield None.

    Only X/Y is read. PolyLineZ and PolyLineM carry Z/M arrays after the points,
    and their X/Y prefix is byte-identical to plain PolyLine, so the trailing
    arrays are simply never touched.
    """
    f.read(100)  # file header
    while True:
        rh = f.read(8)
        if len(rh) < 8:
            return
        _, words = struct.unpack(">II", rh)
        content = f.read(words * 2)
        if len(content) < words * 2:
            return
        (shape_type,) = struct.unpack("<i", content[:4])
        if shape_type not in (3, 13, 23):  # PolyLine, PolyLineZ, PolyLineM
            yield None
            continue
        box = struct.unpack("<4d", content[4:36])
        n_parts, n_points = struct.unpack("<2i", content[36:44])
        starts = struct.unpack(f"<{n_parts}i", content[44 : 44 + 4 * n_parts])
        pt_off = 44 + 4 * n_parts
        coords = struct.unpack(f"<{2 * n_points}d", content[pt_off : pt_off + 16 * n_points])
        parts = []
        for i, s in enumerate(starts):
            e = starts[i + 1] if i + 1 < n_parts else n_points
            parts.append([(coords[2 * j], coords[2 * j + 1]) for j in range(s, e)])
        yield box, parts


# --- Geometry ----------------------------------------------------------------


def simplify(points, tol):
    """Douglas–Peucker, iterative so a long road cannot blow the stack."""
    if len(points) <= 2:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        ax, ay = points[first]
        bx, by = points[last]
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        worst, idx = 0.0, -1
        for i in range(first + 1, last):
            px, py = points[i]
            if len2 == 0:
                d = ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len2))
                d = ((px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2) ** 0.5
            if d > worst:
                worst, idx = d, i
        if idx != -1 and worst > tol:
            keep[idx] = True
            stack.append((first, idx))
            stack.append((idx, last))
    return [p for p, k in zip(points, keep) if k]


def round_pt(p):
    return [round(p[0], COORD_DP), round(p[1], COORD_DP)]


def boxes_overlap(box, bbox):
    """Shapefile box is (xmin, ymin, xmax, ymax); state bbox is [w, s, e, n]."""
    return not (box[2] < bbox[0] or box[0] > bbox[2] or box[3] < bbox[1] or box[1] > bbox[3])


# --- Build -------------------------------------------------------------------


def upstream_stamps() -> dict[str, str]:
    """`Last-Modified` for each national file.

    Written into the manifest so a later run can tell whether the Forest
    Service has actually recut anything. Without it the monthly rebuild has no
    way to know, and republishes 272 MB of byte-identical geometry every time —
    the current national file is dated May 2025 and will sit there for a year.
    """
    out: dict[str, str] = {}
    for kind, url, _ in SOURCES:
        try:
            req = urllib.request.Request(url, method="HEAD")
            with urllib.request.urlopen(req, timeout=60) as r:
                out[kind] = r.headers.get("Last-Modified", "")
        except Exception as e:  # noqa: BLE001 - a missing stamp just means "rebuild"
            log(f"  (couldn't read Last-Modified for {kind}: {e})")
            out[kind] = ""
    return out


def fetch(url: str, cache: Path | None) -> Path:
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        dest = cache / url.rsplit("/", 1)[-1]
        if dest.exists() and dest.stat().st_size > 0:
            log(f"  cached  {dest.name} ({dest.stat().st_size:,} bytes)")
            return dest
    else:
        dest = Path(tempfile.mkdtemp()) / url.rsplit("/", 1)[-1]
    log(f"  fetch   {url}")
    with urllib.request.urlopen(url, timeout=300) as r, open(dest, "wb") as out:
        while chunk := r.read(1 << 20):
            out.write(chunk)
    log(f"  got     {dest.stat().st_size:,} bytes")
    return dest


def build(out_dir: Path, only: set[str] | None, cache: Path | None, base_url: str) -> None:
    states = json.loads((REPO / "public" / "states.json").read_text())
    if only:
        states = [s for s in states if s["abbr"].upper() in only]
    if not states:
        sys.exit("no states selected")
    out_dir.mkdir(parents=True, exist_ok=True)

    # One temp file per state, appended to as the national files stream past.
    # The alternative — holding every state's features in memory — does not fit:
    # the trails .dbf alone is 2 GB uncompressed.
    stamps = upstream_stamps()
    log(f"upstream: {stamps}")

    tmp_dir = Path(tempfile.mkdtemp(prefix="mvum-"))
    handles = {s["abbr"]: open(tmp_dir / f"{s['abbr']}.jsonl", "w", encoding="utf-8") for s in states}
    counts = {s["abbr"]: 0 for s in states}
    forests: dict[str, set[str]] = {s["abbr"]: set() for s in states}

    wanted = set(FIELD_MAP)
    for kind, url, stem in SOURCES:
        log(f"\n{kind}s:")
        zpath = fetch(url, cache)
        with zipfile.ZipFile(zpath) as z:
            with z.open(f"{stem}.dbf") as dbf:
                fields, nrec, rlen = read_dbf_header(dbf)
                names = {f[0] for f in fields}
                kept = sorted(n for n in names if n in FIELD_MAP)
                # A field the app reads going missing is silent data loss: the
                # overlay still draws, and every route through it simply stops
                # saying which vehicles may use it. Fail instead.
                gone = sorted(f for f in KIND_FIELDS[kind] if f not in names)
                if gone:
                    sys.exit(
                        f"{stem}: expected field(s) missing from the shapefile: {', '.join(gone)}.\n"
                        "The Forest Service schema has moved; FIELD_MAP in this script needs updating."
                    )
                log(f"  records {nrec:,}  fields kept {len(kept)}/{len(fields)}")
                with z.open(f"{stem}.shp") as shp:
                    rows = dbf_records(dbf, fields, nrec, rlen, wanted)
                    shapes = shp_shapes(shp)
                    seen = 0
                    for props_raw, shape in zip(rows, shapes):
                        seen += 1
                        if props_raw is None or shape is None:
                            continue
                        box, parts = shape
                        # Which states does this route touch? A route can sit in
                        # more than one, and each pack must be complete on its
                        # own — a road that stops at the state line is worse
                        # than one repeated in two files.
                        hits = [s for s in states if boxes_overlap(box, s["bbox"])]
                        if not hits:
                            continue
                        props = {FIELD_MAP[k]: v for k, v in props_raw.items() if k in FIELD_MAP}
                        props["gd_kind"] = kind
                        lines = []
                        for part in parts:
                            pts = simplify(part, SIMPLIFY_DEG)
                            if len(pts) >= 2:
                                lines.append([round_pt(p) for p in pts])
                        if not lines:
                            continue
                        geom = (
                            {"type": "LineString", "coordinates": lines[0]}
                            if len(lines) == 1
                            else {"type": "MultiLineString", "coordinates": lines}
                        )
                        blob = json.dumps(
                            {"type": "Feature", "geometry": geom, "properties": props},
                            separators=(",", ":"),
                        )
                        for s in hits:
                            handles[s["abbr"]].write(blob + "\n")
                            counts[s["abbr"]] += 1
                            if f := props.get("forestname"):
                                forests[s["abbr"]].add(f)
                        if seen % 100_000 == 0:
                            log(f"  ..{seen:,}/{nrec:,}")

    for h in handles.values():
        h.close()

    # Assemble each state's FeatureCollection in the shape src-tauri/src/lib.rs
    # writes today, so the app reads a pack and a live download identically.
    manifest: dict[str, dict] = {}
    stamp = int(time.time())
    log("")
    for s in states:
        abbr = s["abbr"]
        if counts[abbr] == 0:
            log(f"  {abbr}: no forest roads or trails — no pack")
            continue
        path = out_dir / f"{abbr}.geojson"
        with open(tmp_dir / f"{abbr}.jsonl", encoding="utf-8") as src, open(
            path, "w", encoding="utf-8"
        ) as out:
            out.write('{"type":"FeatureCollection","gd_downloaded":')
            out.write(str(stamp))
            out.write(',"gd_source":"USDA Forest Service Motor Vehicle Use Map"')
            # Which forests are actually represented, so the app can tell "no
            # forest roads near here" from "this forest never published any".
            out.write(',"gd_forests":')
            out.write(json.dumps(sorted(forests[abbr]), separators=(",", ":")))
            out.write(',"features":[')
            for i, line in enumerate(src):
                if i:
                    out.write(",")
                out.write(line.rstrip("\n"))
            out.write("]}")
        data = path.read_bytes()
        manifest[abbr] = {
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "url": f"{base_url.rstrip('/')}/{abbr}.geojson",
            "features": counts[abbr],
            "forests": len(forests[abbr]),
        }
        log(f"  {abbr}: {counts[abbr]:,} features, {len(data)/1e6:.1f} MB, {len(forests[abbr])} forest(s)")

    (out_dir / "mvum.json").write_text(
        json.dumps(
            {
                "built": stamp,
                "source": SOURCES[0][1],
                # What the national files said when this was cut. CI compares
                # these before spending two hours re-cutting the same data.
                "upstream": stamps,
                "states": manifest,
            },
            indent=1,
        )
    )
    total = sum(m["bytes"] for m in manifest.values())
    log(f"\n{len(manifest)} state pack(s), {total/1e6:.1f} MB total → {out_dir}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="dist/mvum", help="output directory")
    ap.add_argument("--only", help="comma-separated state abbreviations")
    ap.add_argument("--cache", help="keep the national downloads here between runs")
    ap.add_argument(
        "--base-url",
        default="https://github.com/pl0xuee/griddown-packs/releases/download/mvum-latest",
        help="where the packs will be served from, for the manifest",
    )
    a = ap.parse_args()
    build(
        Path(a.out),
        {x.strip().upper() for x in a.only.split(",")} if a.only else None,
        Path(a.cache) if a.cache else None,
        a.base_url,
    )


if __name__ == "__main__":
    main()
