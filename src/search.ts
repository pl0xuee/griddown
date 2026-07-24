import maplibregl from "maplibre-gl";
import { PMTiles } from "pmtiles";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { toast } from "./toast";
import { parseCoord, clearGotoPin } from "./goto";
import { loadMarks, type Waypoint } from "./store";
import { esc } from "./esc";
import { haversine, bearing, cardinal, type LL } from "./geo";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

// Offline place search. There's no name database anywhere — the towns are
// already in the map pack's low-zoom `places` tiles, so we decode those once
// per pack (a few hundred small tiles) and search the result in memory.
// Fully offline; works in every downloaded state.

interface Place {
  name: string;
  kind: string; // locality / region / county …
  detail: string; // city / town / village / hamlet
  pop: number;
  lng: number;
  lat: number;
  /** `name` run through fold(), cached at build time. See rankMatches. */
  folded?: string;
}

// OSM stores place names accented — Cañon City, Española, Peñasco — and there is
// no way to type ñ on the keyboard this app is used with, so an unfolded search
// can never reach those towns even though they're indexed and on the map. Fold
// both sides: lowercase, and decompose accents so the combining mark can be
// dropped, leaving the ASCII letter someone can actually type.
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

const KIND_ZOOM: Record<string, number> = {
  region: 7,
  county: 9,
  locality: 12,
  water: 12,
  area: 11,
  road: 13,
  mvum: 14,
  earth: 13,
  poi: 14,
};

/**
 * Which layers to take names from.
 *
 * Every one of these rides in the tiles the index already reads — the decode
 * was happening anyway and everything outside `places` was being dropped on the
 * floor. Over the whole Oregon pack that was the difference between 2,509 and
 * 14,160 findable names, for zero extra tile reads: wilderness areas, glaciers,
 * reservoirs, state parks, named highways, cliffs and rims were all sitting
 * there unsearchable.
 *
 * `as` buckets the result so `label()` and KIND_ZOOM have something stable to
 * key on; the feature's own kind is kept in `detail`. `grid` is the dedupe cell
 * in 1/degrees — tight for points, loose for lines and polygons, which repeat
 * in every tile they cross (one "Santiam Highway" per degree, not per tile).
 */
const HARVEST: ReadonlyArray<{
  layer: string;
  as: string | null;
  skip?: ReadonlySet<string>;
  grid: number;
}> = [
  // `as: null` keeps locality/region/county, which the UI already labels.
  { layer: "places", as: null, skip: new Set(["country"]), grid: 50 },
  // `administrative` in pois is the city-limits / county polygon for something
  // already in `places` — it produced a second "Bend" labelled "administrative"
  // beside the real one, and turned Deschutes County into a POI.
  { layer: "pois", as: "poi", skip: new Set(["administrative"]), grid: 50 },
  { layer: "water", as: "water", grid: 1 },
  { layer: "roads", as: "road", skip: new Set(["ferry"]), grid: 1 },
  { layer: "earth", as: "earth", grid: 1 },
  // `administrative` here is the city-limits polygon for a town that is already
  // in `places` — indexing it gave every town a duplicate result labelled
  // "administrative", including "Deschutes County".
  { layer: "landuse", as: "area", skip: new Set(["administrative"]), grid: 1 },
];

/**
 * Vector-tile kind → the word a person would use.
 *
 * The tile schema names things for cartography, not for a result list: a
 * campground is `camp_site`, a trail is `path`, a rim is `cliff`. Left raw,
 * Find reported "Green Lakes Trailhead — parking" and "Mallard Marsh
 * Campground — camp_site".
 */
const KIND_LABEL: Record<string, string> = {
  // Water
  lake: "lake",
  reservoir: "reservoir",
  river: "river",
  stream: "creek",
  canal: "canal",
  spring: "spring",
  hot_spring: "hot spring",
  // Ground you travel on
  path: "trail",
  footway: "trail",
  track: "track",
  major_road: "road",
  medium_road: "road",
  minor_road: "road",
  highway: "highway",
  rail: "railway",
  aeroway: "airstrip",
  // Landforms
  peak: "peak",
  volcano: "volcano",
  ridge: "ridge",
  cliff: "cliff",
  valley: "valley",
  glacier: "glacier",
  island: "island",
  cape: "cape",
  beach: "beach",
  // Land and shelter
  camp_site: "campground",
  caravan_site: "campground",
  wilderness: "wilderness",
  nature_reserve: "nature reserve",
  national_park: "national park",
  protected_area: "protected area",
  forest: "forest",
  wood: "woods",
  park: "park",
  garden: "garden",
  golf_course: "golf course",
  wetland: "wetland",
  marsh: "marsh",
  heath: "heath",
  meadow: "meadow",
  grassland: "grassland",
  residential: "community",
  farmland: "farmland",
  // Settlement classes the schema names but a person wouldn't: `locality` is
  // OSM for "a named spot", and `isolated_dwelling` for a house or two too
  // small to call a hamlet.
  locality: "place",
  isolated_dwelling: "homestead",
  cycleway: "bike trail",
  retail: "shops",
  commercial: "shops",
  pier: "pier",
  dam: "dam",
  military: "military area",
  // Things worth finding in an emergency
  hospital: "hospital",
  clinic: "clinic",
  pharmacy: "pharmacy",
  fire_station: "fire station",
  police: "police",
  ranger_station: "ranger station",
  fuel: "fuel",
  supermarket: "shop",
  school: "school",
  airport: "airport",
  aerodrome: "airfield",
};

/**
 * Kinds too generic to label a result from. For these the feature's NAME is the
 * better authority — a `water` polygon called "Cougar Reservoir" is a
 * reservoir, and most `parking` in this data is a trailhead.
 *
 * The land-cover kinds are here for the same reason one step removed: `heath`,
 * `scree` and `scrub` describe what GROWS on a thing, not what the thing is.
 * Left to speak for themselves they produced "Buck Meadows — heath" and
 * "Yapoah Crater — scree".
 */
const VAGUE_KINDS = new Set([
  "water", "parking", "other", "yes", "", "area", "locality",
  "heath", "scrub", "scree", "grassland", "bare_rock", "wood", "sand", "forest",
]);

/** The label implied by the name itself: "… Reservoir" → reservoir. */
function nameSuffixLabel(name: string): string {
  const n = name.toLowerCase();
  const ends = (...w: string[]) => w.some((s) => n.endsWith(" " + s) || n === s);
  // American naming puts the generic in front about as often as behind —
  // "Lake Billy Chinook", "Mount Jefferson" — so check both ends.
  const starts = (...w: string[]) => w.some((s) => n.startsWith(s + " "));
  if (ends("trailhead", "trail head")) return "trailhead";
  if (ends("campground", "campsite", "horse camp", "camp")) return "campground";
  if (ends("reservoir")) return "reservoir";
  if (ends("lake", "lakes", "pond") || starts("lake")) return "lake";
  if (ends("creek", "brook")) return "creek";
  if (ends("river", "fork")) return "river";
  if (ends("spring", "springs")) return "spring";
  if (ends("falls")) return "falls";
  if (ends("wilderness")) return "wilderness";
  if (ends("national forest", "state forest", "forest")) return "forest";
  if (ends("national park", "state park", "park")) return "park";
  if (ends("trail", "loop")) return "trail";
  if (ends("road", "rd", "highway", "hwy", "lane", "drive")) return "road";
  if (ends("butte", "mountain", "mtn", "peak", "point", "summit", "dome", "spire", "hill")
      || starts("mount", "mt", "mt.")) return "peak";
  if (ends("crater", "cone", "lava flow")) return "crater";
  if (ends("ridge", "rim", "bench")) return "ridge";
  if (ends("pass", "saddle", "gap")) return "pass";
  if (ends("canyon", "gulch", "draw", "valley", "hollow")) return "canyon";
  if (ends("meadow", "meadows", "prairie", "flat", "flats")) return "meadow";
  if (ends("marsh", "swamp", "bog", "slough")) return "wetland";
  if (ends("glacier", "snowfield")) return "glacier";
  if (ends("island", "islands", "isle")) return "island";
  if (ends("cave", "caves")) return "cave";
  if (ends("ranch", "acres", "estates", "village")) return "community";
  return "";
}

/**
 * How far a result is from the middle of the map, and which way.
 *
 * Names repeat: seven Clear Lakes, four Elk Lakes, a Bear Creek in every
 * county. Without this the rows are identical and there is no way to pick the
 * right one — which is what made a correct result set look like junk.
 */
function distanceAway(p: { lng: number; lat: number }, from: { lng: number; lat: number }): string {
  const a: LL = [from.lng, from.lat];
  const b: LL = [p.lng, p.lat];
  const mi = haversine(a, b) / 1609.344;
  if (mi < 0.1) return "here";
  const dir = cardinal(bearing(a, b));
  return mi < 10 ? `${mi.toFixed(1)} mi ${dir}` : `${Math.round(mi)} mi ${dir}`;
}

/**
 * Towns usable as an anchor.
 *
 * Localities only — never neighbourhoods. Anchoring on those produced "near
 * Lair Hill", which is a district of Portland and tells you nothing unless you
 * already know Portland. A neighbourhood is a thing to be anchored, not a thing
 * to anchor with.
 */
/**
 * Somewhere a person could be said to live, and how well known it is.
 *
 * The `locality` class is deliberately absent even though it is the second
 * commonest: it is where the basemap files named points that are NOT
 * settlements — "Tombstone Pass", "Tire Junction", "Yoakam Point" — so
 * anchoring on it produced directions to places nobody lives. `farm` and
 * `isolated_dwelling` are out for the same reason.
 *
 * Ranked rather than sorted by population because the populations here are
 * placeholders: every hamlet in the pack reads exactly 200, every `locality`
 * exactly 1000. Only city/town/village carry real figures, so the class is the
 * honest signal.
 */
const SETTLEMENT_RANK: Record<string, number> = { city: 4, town: 3, village: 2, hamlet: 1 };

let townCache: { src: Place[]; towns: Place[] } | null = null;
function towns(list: Place[]): Place[] {
  if (townCache?.src === list) return townCache.towns;
  const t = list.filter((p) => p.kind === "locality" && SETTLEMENT_RANK[p.detail]);
  townCache = { src: list, towns: t };
  return t;
}

/**
 * The town a result sits next to.
 *
 * A distance from the crosshair separates two same-named lakes, but it does not
 * tell you WHICH one — "Clear Lake, 78 mi" means nothing on its own. "near
 * Sisters" does, and it is how anyone here would actually describe the place.
 *
 * Not simply the closest town: the closest is often a hamlet nobody has heard
 * of, and "near Tire Junction" is no more use than no anchor at all. Distance
 * is discounted by how well known a place is, so a real town a little further
 * off beats a hamlet next door — while a hamlet still wins if nothing else is
 * anywhere near. Bounded to 40 miles so somewhere genuinely empty says nothing
 * rather than naming a town two hours away.
 */
function nearestTown(p: Place, list: Place[]): string {
  if (p.kind === "locality") return ""; // it IS the town
  const from: LL = [p.lng, p.lat];
  const LIMIT = 40 * 1609.344;
  let best: Place | null = null;
  let bestScore = Infinity;
  for (const t of towns(list)) {
    // Cheap reject before the trig: 1° of latitude is ~69 mi.
    if (Math.abs(t.lat - p.lat) > 0.6 || Math.abs(t.lng - p.lng) > 0.8) continue;
    const m = haversine(from, [t.lng, t.lat]);
    if (m > LIMIT) continue;
    const score = m / (1 + 2 * (SETTLEMENT_RANK[t.detail] ?? 0));
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best ? `near ${best.name}` : "";
}

/**
 * The state a pack URL belongs to: "…/states/OR.pmtiles" → "OR".
 *
 * Derived rather than passed in on purpose. The index is cached by URL and
 * shared between Find and Get-there, so whatever goes into it has to be decided
 * by the URL alone — if one caller supplied the forest roads and the other
 * didn't, whichever asked first would decide what the other one could search.
 */
function abbrFromUrl(url: string): string {
  // The separator is load-bearing: without it "planet.pmtiles" — the bundled
  // starter pack — matches its own last two letters and reports state "ET".
  const m = decodeURIComponent(url).match(/[/\\]([A-Za-z]{2})\.pmtiles(?:$|[?#])/);
  return m ? m[1].toUpperCase() : "";
}

/** A point ON a line, rather than a centroid that can sit off in a valley. */
function lineMidpoint(geom: any): LL | null {
  const lines =
    geom?.type === "MultiLineString"
      ? geom.coordinates
      : geom?.type === "LineString"
        ? [geom.coordinates]
        : null;
  if (!lines?.length) return null;
  const line = lines[Math.floor(lines.length / 2)];
  if (!line?.length) return null;
  const p = line[Math.floor(line.length / 2)];
  return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
    ? [p[0], p[1]]
    : null;
}

/**
 * "CHINA HAT RD" → "China Hat Rd". Tokens like B.P.A and 4600-471 stay put.
 *
 * The verbatim escape is deliberately narrow — a digit, or two periods in one
 * token — because it copies out of the all-caps source. Treating any period as
 * a designation left 1,234 of Oregon's forest-road names shouting an ordinary
 * abbreviation: "China Hat Cut-off RD.", "Gibson CR. RD.", "Dog MTN. Th".
 *
 * Each dot-separated part is capitalised rather than just the first letter, so
 * a two-letter initialism survives as "C.G" instead of becoming "C.g".
 */
function titleCase(s: string): string {
  const raw = s.split(/\s+/);
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) =>
      /\d|\..*\./.test(w)
        ? raw.find((o) => o.toLowerCase() === w) ?? w
        : w.replace(/(^|\.)([a-z])/g, (_, sep, c) => sep + c.toUpperCase())
    )
    .join(" ");
}

/**
 * Named Forest Service roads, from the MVUM overlay if it is downloaded.
 *
 * These are the roads this app exists to show, and they were the one dataset on
 * disk that Find could not see: 31,453 features carrying 10,732 distinct names,
 * none of them reachable by typing. Unnamed segments are deliberately skipped —
 * there are 25,101 bare route numbers, and filling the index with "Forest road
 * 4600301" would bury the towns and lakes under noise. A numbered road is found
 * by tapping it on the overlay, which already reports its designation.
 *
 * Best-effort: most packs have no MVUM file, and a missing one is normal.
 *
 * Read one feature at a time, and NOT through mvum.ts's loadMvumFor. That
 * function's `res.json()` materialises the whole 40 MB document as objects to
 * keep a few thousand names and one vertex each: measured on Oregon, 155 MB of
 * peak resident memory and 110 MB still held while the harvest runs. Handing
 * the elements to JSON.parse one at a time costs ~40 ms and takes the peak of
 * this pass down by 56 MB, and the whole index build's from 365 to 305 MB. On
 * iOS the app is killed for memory long before it is killed for being slow, so
 * that is the right side of the trade.
 *
 * The whole-document parse stays where it belongs: the overlay and the route
 * checker want the geometry and keep it cached, so loadMvumFor is untouched and
 * this is the only caller that streams.
 */
function* mvumFeatureTexts(doc: string): Generator<string> {
  // NOT a JSON parser — it only finds where each element of the `features`
  // array starts and ends, and every element still goes through JSON.parse, so
  // a malformed feature throws exactly as it did before. What it does have to
  // get right is that braces and brackets inside a string value ("Camp {1}",
  // a name with an escaped quote) are text, not structure.
  const head = /"features"\s*:\s*\[/.exec(doc);
  if (!head) return;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = head.index + head[0].length; i < doc.length; i++) {
    const c = doc.charCodeAt(i);
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true; // backslash
      else if (c === 34) inStr = false; // closing quote
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) {
      if (depth === 0) start = i;
      depth++;
    } else if (c === 125 || c === 93) {
      if (depth === 0) return; // the `]` that ends the features array
      if (--depth === 0 && start >= 0) {
        yield doc.slice(start, i + 1);
        start = -1;
      }
    }
  }
}

async function harvestMvum(
  abbr: string,
  inPack: (lng: number, lat: number) => boolean,
  onProgress?: (done: number, total: number, phase: string) => void
): Promise<Place[]> {
  if (!abbr) return [];
  const out: Place[] = [];
  try {
    // Announced before the read, not after it. Fetching and parsing 40 MB and
    // walking 31,453 features takes as long as a chunk of the tile pass, and
    // reporting only on completion left the panel frozen on "6459/6459 tiles"
    // for all of it, looking hung at exactly 100%.
    onProgress?.(0, 0, "forest roads");
    if (typeof (window as any).__TAURI_INTERNALS__ === "undefined") return [];
    const path = await invoke<string>("mvum_path", { abbr });
    const res = await fetch(convertFileSrc(path));
    if (!res.ok) return [];
    const doc = await res.text();
    for (const text of mvumFeatureTexts(doc)) {
      const f: any = JSON.parse(text);
      const raw = String(f?.properties?.name ?? "").trim();
      if (!raw) continue;
      const at = lineMidpoint(f.geometry);
      if (!at || !inPack(at[0], at[1])) continue;
      const name = titleCase(raw);
      out.push({
        name,
        kind: "mvum",
        detail: "forest road",
        pop: 0,
        lng: at[0],
        lat: at[1],
        folded: fold(name),
      });
    }
  } catch {
    // Same answer a broken or missing file gave before: no forest roads, and a
    // place index that is otherwise complete.
    return [];
  }
  return out;
}

let index: Place[] | null = null;
let indexedUrl = "";
let building = false;
/**
 * Bumped every time the index is invalidated, so a build can tell it has been
 * superseded.
 *
 * A statewide build is thousands of range requests and runs for tens of
 * seconds on a phone. Nulling `index` cannot stop one that is already in
 * flight, so switching packs mid-build had the old pack's places written back
 * over the reset when it finished — and a result tapped from that list flew
 * the map outside the downloaded area. The pack-REFRESH case was worse: the
 * URL is unchanged, so the finishing build also restored `indexedUrl` and the
 * pre-refresh names were served for the rest of the session.
 */
let gen = 0;

/** Drop the cached place index — call after a pack is re-downloaded, since the
 *  URL is unchanged but the bytes (and place set) may have changed. */
export function resetPlaceIndex() {
  index = null;
  indexedUrl = "";
  gen++;
  // Keyed on the old array's identity, so it would otherwise hold every one of
  // that pack's entries alive for as long as the app runs.
  townCache = null;
}

function tile2lng(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}
function tile2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Σx, Σy and the vertex count for a feature's geometry, without building it.
 *
 * The harvest wants one centroid per feature and nothing else, but
 * `loadGeometry()` has to materialise the whole shape to hand one over — a ring
 * array plus a `Point` object for every vertex of every named feature, across
 * six layers and 6,459 tiles. Timed with the tiles already in memory, that was
 * 42% of the harvest's work, spent decoding varints into objects thrown away on
 * the next line. Adding the coordinates as they come off the wire gives the
 * identical three numbers, allocates once, and returns a third of it.
 *
 * This deliberately duplicates ~25 lines of @mapbox/vector-tile's own decoder:
 * the command encoding, the zigzag deltas, and the ClosePath quirk where the
 * ring's first vertex is repeated (drop that and every polygon's centroid
 * moves). Re-check it against `VectorTileFeature.loadGeometry` if that
 * dependency is upgraded — including the two cases that throw, which abandon
 * the rest of the tile and so have to throw here too.
 */
function geomSum(feat: any): { sx: number; sy: number; np: number } {
  if (feat._geometry < 0) throw new Error("feature has no geometry");
  const pbf = feat._pbf;
  const buf: Uint8Array = pbf.buf;
  let pos: number = feat._geometry;
  // Varint read, written out at each of its four sites rather than called: `v`
  // from `buf[pos]`, advancing `pos`. Nearly every value here is a small delta
  // that fits in one byte, so that case is peeled out — measured, it is where
  // most of the win is. Anything wider than four bytes, which a tile coordinate
  // never is, hands back to the library reader for the exact same answer.
  let b = 0, v = 0, shift = 0, at = 0;
  at = pos; b = buf[pos++]; v = b & 0x7f;
  if (b >= 0x80) {
    shift = 7;
    do { b = buf[pos++]; v |= (b & 0x7f) << shift; shift += 7; } while (b >= 0x80 && shift < 28);
    if (b >= 0x80) { pbf.pos = at; v = pbf.readVarint(); pos = pbf.pos; }
  }
  const end = pos + v;

  let cmd = 1, len = 0, x = 0, y = 0;
  let sx = 0, sy = 0, np = 0;
  // The current ring's first vertex, and whether a ring has been opened at all —
  // `loadGeometry` drops a LineTo arriving before any MoveTo, but still applies
  // its delta.
  let fx = 0, fy = 0, open = false;
  while (pos < end) {
    if (len <= 0) {
      at = pos; b = buf[pos++]; v = b & 0x7f;
      if (b >= 0x80) {
        shift = 7;
        do { b = buf[pos++]; v |= (b & 0x7f) << shift; shift += 7; } while (b >= 0x80 && shift < 28);
        if (b >= 0x80) { pbf.pos = at; v = pbf.readVarint(); pos = pbf.pos; }
      }
      cmd = v & 0x7;
      len = v >> 3;
      if (len === 0) continue;
    }
    len--;
    if (cmd === 7) {
      if (open) { sx += fx; sy += fy; np++; }
      continue;
    }
    if (cmd !== 1 && cmd !== 2) throw new Error(`unknown command ${cmd}`);
    at = pos; b = buf[pos++]; v = b & 0x7f;
    if (b >= 0x80) {
      shift = 7;
      do { b = buf[pos++]; v |= (b & 0x7f) << shift; shift += 7; } while (b >= 0x80 && shift < 28);
      if (b >= 0x80) { pbf.pos = at; v = pbf.readVarint(); pos = pbf.pos; }
    }
    x += v % 2 === 1 ? (v + 1) / -2 : v / 2;
    at = pos; b = buf[pos++]; v = b & 0x7f;
    if (b >= 0x80) {
      shift = 7;
      do { b = buf[pos++]; v |= (b & 0x7f) << shift; shift += 7; } while (b >= 0x80 && shift < 28);
      if (b >= 0x80) { pbf.pos = at; v = pbf.readVarint(); pos = pbf.pos; }
    }
    y += v % 2 === 1 ? (v + 1) / -2 : v / 2;
    if (cmd === 1) { fx = x; fy = y; open = true; }
    else if (!open) continue;
    sx += x; sy += y; np++;
  }
  return { sx, sy, np };
}

async function buildIndex(
  url: string,
  onProgress: (done: number, total: number, phase: string) => void
): Promise<Place[]> {
  const pm = new PMTiles(url);
  const header = await pm.getHeader();
  const west = header.minLon, south = header.minLat;
  const east = header.maxLon, north = header.maxLat;
  // Low-zoom tiles cover far more than the pack's bbox (a z1 tile is a quarter
  // of the planet), so they contain places you have no map for. Only index
  // what's inside the downloaded area (with a small margin for edge towns).
  const M = 0.05;
  const inPack = (lng: number, lat: number) =>
    lng >= west - M && lng <= east + M && lat >= south - M && lat <= north + M;

  /** The tile range covering the pack's bbox at one zoom. */
  const rangeAt = (z: number) => {
    const n = 2 ** z;
    const lat2y = (lat: number) => {
      const r = (lat * Math.PI) / 180;
      return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    };
    const x0 = Math.max(0, Math.floor(((west + 180) / 360) * n));
    const x1 = Math.min(n - 1, Math.floor(((east + 180) / 360) * n));
    const y0 = Math.max(0, lat2y(north));
    const y1 = Math.min(n - 1, lat2y(south));
    return { n, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };

  // Read two zooms, not a ladder.
  //
  // This used to walk z1..z10 and stop at 900 tiles, on the assumption that
  // "villages/hamlets show up by z10". They don't: in the Protomaps basemap
  // most localities are not introduced until z12. Measured over the whole of
  // the shipped Oregon pack — z10 yields 372 named places, z11 adds NOTHING,
  // z12 yields 2454, and z13 adds 8 more for five times the tiles. Towns like
  // Camp Sherman, Crooked River Ranch, Opal City and Cloverdale were simply
  // not in the index, which is what made Find look broken for rural Oregon.
  //
  // So: one coarse level for the labels that drop OUT at high zoom (the state
  // itself, counties, the biggest cities — 55 of them in Oregon), plus z12 for
  // everything else. Whole-state cost is 6459 tiles instead of 432.
  const COARSE = 8;
  const DETAIL = 12;
  // Alaska spans 50° of longitude, where z12 runs to six figures of tiles. Step
  // the detail level back until it fits rather than reading forever — a coarser
  // index beats a Find that never finishes.
  const BUDGET = 24000;
  let detail = Math.min(DETAIL, header.maxZoom);
  while (detail > COARSE && rangeAt(detail).count > BUDGET) detail--;

  const levels = [...new Set([Math.min(COARSE, header.maxZoom), detail])].filter(
    (z) => z >= header.minZoom && z >= 0
  );
  const jobs: { z: number; x: number; y: number }[] = [];
  for (const z of levels) {
    const { x0, x1, y0, y1 } = rangeAt(z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) jobs.push({ z, x, y });
    }
  }

  const seen = new Map<string, Place>();
  /**
   * Running vertex sum per dedupe key, so the coordinate a feature ends up
   * with is the mean of every fragment of it rather than whichever of the 24
   * workers reached it first. First-write-wins made the position of anything
   * spanning several tiles a race: 464 of Oregon's 13,412 entries landed
   * somewhere different on each build, the worst by 109 miles, so searching the
   * same name twice flew you to two different places. Summing rather than
   * picking a fragment is also the better answer for a river or a highway,
   * where no single fragment's centroid is on the middle of the thing.
   */
  const acc = new Map<string, { sx: number; sy: number; n: number }>();
  let done = 0;
  // Latency-bound, not CPU-bound: each tile is a range request through the
  // asset protocol. With ~11x more tiles to read than before, more of them in
  // flight is what keeps the wait short.
  const CONCURRENCY = 24;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, w) => {
      for (let i = w; i < jobs.length; i += CONCURRENCY) {
        const { z, x, y } = jobs[i];
        try {
          const t = await pm.getZxy(z, x, y);
          if (t?.data) {
            const vt = new VectorTile(new PbfReader(new Uint8Array(t.data)));
            for (const spec of HARVEST) {
              const layer = vt.layers[spec.layer];
              for (let f = 0; layer && f < layer.length; f++) {
                const feat = layer.feature(f);
                const props: any = feat.properties;
                const name = props["name:en"] || props.name;
                if (!name) continue;
                const fkind = String(props.kind ?? "");
                if (spec.skip?.has(fkind)) continue;
                // Mean of the vertices. For a point layer that IS the point;
                // for a lake it is the middle, for a road a point along it.
                const { sx, sy, np } = geomSum(feat);
                if (!np) continue;
                const lng = tile2lng(x + sx / np / feat.extent, z);
                const lat = tile2lat(y + sy / np / feat.extent, z);
                if (!inPack(lng, lat)) continue;
                const key = `${spec.layer}|${name}|${fkind}|${Math.round(
                  lng * spec.grid
                )}|${Math.round(lat * spec.grid)}`;
                const prev = acc.get(key);
                if (prev) {
                  prev.sx += lng * np;
                  prev.sy += lat * np;
                  prev.n += np;
                  continue;
                }
                acc.set(key, { sx: lng * np, sy: lat * np, n: np });
                seen.set(key, {
                  name: String(name),
                  kind: spec.as ?? fkind,
                  detail: spec.as ? fkind : String(props.kind_detail ?? ""),
                  pop: Number(props.population ?? 0),
                  lng,
                  lat,
                  folded: fold(String(name)),
                });
              }
            }
          }
        } catch {
          /* a missing tile is fine — sparse areas */
        }
        done++;
        if (done % 40 === 0 || done === jobs.length) onProgress(done, jobs.length, "tiles");
      }
    })
  );
  for (const [key, p] of seen) {
    const a = acc.get(key)!;
    p.lng = a.sx / a.n;
    p.lat = a.sy / a.n;
  }
  // Forest roads ride in a separate file, not in the tiles — folded in here so
  // they dedupe and rank alongside everything else.
  const mvum = await harvestMvum(abbrFromUrl(url), inPack, onProgress);
  return mergeDuplicates([...seen.values(), ...mvum]);
}

/** Preference when the same thing was found more than once — lowest wins. */
const KIND_RANK: Record<string, number> = {
  region: 0, county: 1, locality: 2, neighbourhood: 3,
  water: 4, poi: 5, earth: 6, area: 7, road: 8, mvum: 9,
};

/**
 * Collapse "the same thing, found several times" down to one result each.
 *
 * Two separate causes, both of which put a wall of "Clear Lake" in front of the
 * user. Cross-layer: a lake is in `water` AND in `pois` (as kind `water`), so it
 * arrives twice with different kinds — which is why the per-tile dedupe key
 * could not catch it, since that key names the layer. And cross-tile: a lake or
 * a highway crosses many tiles and is re-emitted in each one, at a slightly
 * different centroid every time.
 *
 * So: group by folded name, then keep entries that are genuinely far apart.
 * Oregon really does have several distinct Clear Lakes and they should all be
 * findable — MERGE_DEG is wide enough to swallow one lake's worth of tile
 * fragments and narrow enough to keep two real lakes apart.
 */
function mergeDuplicates(list: Place[]): Place[] {
  // How far apart two same-named things must be to count as two things.
  //
  // Real miles, not degrees: a degree of longitude is only 0.72 of a degree of
  // latitude up here, so a degree box merged more aggressively east-west than
  // north-south for no reason anyone could see.
  //
  // 10 miles for a point feature — two lakes of the same name that close are
  // the same lake, arriving twice from two layers or two tiles. A road or a
  // river is not a point: "Santiam Highway" is emitted at a different centroid
  // in every tile it crosses, tens of miles apart, so those need far more room
  // before they count as separate.
  const MI = 1609.344;
  const radiusFor = (p: Place) =>
    (p.kind === "road" || p.kind === "mvum"
      ? 120
      : p.kind === "water" && (p.detail === "river" || p.detail === "canal" || p.detail === "stream")
        ? 60
        : 10) * MI;
  const byName = new Map<string, Place[]>();
  for (const p of list) {
    const k = p.folded ?? fold(p.name);
    const g = byName.get(k);
    if (g) g.push(p);
    else byName.set(k, [p]);
  }
  const out: Place[] = [];
  for (const group of byName.values()) {
    // Best-labelled entry survives: a town beats a landuse polygon of the same
    // name, and a lake beats the POI marker sitting in the middle of it.
    //
    // Position is the last tiebreak, and it is here for determinism rather than
    // for taste: without it the survivor among equally-ranked fragments is
    // decided by the order the tile workers happened to finish in, which is a
    // different answer on every build of the same pack.
    group.sort(
      (a, b) =>
        (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) ||
        b.pop - a.pop ||
        a.lng - b.lng ||
        a.lat - b.lat
    );
    const kept: Place[] = [];
    for (const p of group) {
      const r = Math.max(radiusFor(p), ...kept.map(radiusFor));
      if (kept.some((q) => haversine([q.lng, q.lat], [p.lng, p.lat]) < r)) continue;
      kept.push(p);
    }
    out.push(...kept);
  }
  return out;
}

/**
 * Build (or reuse) the place index for a pack, and return it. Shared by Find
 * and by Get-there, so a state's places are read from its tiles once and both
 * features search the same in-memory list.
 *
 * Cached by url: the second caller for the same pack gets it instantly, and
 * switching packs rebuilds. A concurrent second caller waits out the first
 * rather than reading every tile twice.
 */
export async function ensurePlaceIndex(
  url: string,
  onProgress?: (done: number, total: number, phase: string) => void
): Promise<Place[]> {
  if (index && indexedUrl === url) return index;
  while (building) {
    await new Promise((r) => setTimeout(r, 50));
    if (index && indexedUrl === url) return index;
  }
  building = true;
  // Drop the previous pack's index now, before the (async) rebuild, so nothing
  // reads the old state's place names or counts while this runs — otherwise a
  // Find opened right after a pack switch shows the previous state's towns and
  // flies to coordinates outside the new pack.
  index = null;
  indexedUrl = "";
  townCache = null;
  const g = ++gen;
  try {
    const built = await buildIndex(url, (d, t, phase) => onProgress?.(d, t, phase));
    // Publish only if nothing invalidated the index while we were reading it.
    // The caller still gets what it asked for; what it must not do is leave
    // that behind as the answer for whichever pack is on screen now.
    if (g === gen) {
      index = built;
      indexedUrl = url;
    }
    return built;
  } finally {
    building = false;
  }
}

/**
 * How far a place's size goes against how far away it is.
 *
 * Both are counted in decades so they can argue with each other at all. Raw
 * population cannot: it arrives as a plain count, so anything with a
 * population at all outweighed every distance a single state can contain, and
 * the `from` argument was decoration. That is how a hamlet 108 miles off came
 * to sit above the Clear Lake 40 miles away, and settlements 115 miles out
 * above the Cascade Village three miles down the road.
 *
 * It is also mostly fiction — the basemap gives every hamlet exactly 200 and
 * every `locality` exactly 1000 (see SETTLEMENT_RANK), so only city, town and
 * village carry a real figure. Population deserves a vote, not a veto.
 *
 * At 8, a placeholder hamlet has to be under twice as far away to keep its head
 * start, while Portland's six real decades of people still carry the city past
 * anything unpopulated within about 20 miles of you — so "portland" from Bend
 * is still Portland.
 */
const NEAR_W = 8;

/**
 * Rank matches: prefix > substring, then how big and how close the place is.
 *
 * `from` (the map centre) is most of the answer. Names repeat constantly out
 * here — Oregon has seven distinct Clear Lakes, four Elk Lakes — and without
 * distance the seven arrive in an order with no meaning, so the one you are
 * standing next to could be anywhere in the list. Real miles, not degrees: a
 * degree of longitude is 0.7 of a degree of latitude at this latitude, so a
 * degrees-based ordering disagreed by 30% east-west with the "N mi" the row
 * itself prints.
 */
/**
 * The word a person would use for a search result.
 *
 * Exported because BOTH result lists need it. Get-there had grown its own
 * one-liner (`p.detail || "place"`) which never saw KIND_LABEL, so picking a
 * destination there listed the schema's own tokens — "major_road",
 * "camp_site", "nature_reserve" — while Find, three metres away on the same
 * screen, said "road", "campground", "nature reserve" for the same feature.
 */
export function placeLabel(p: Place): string {
  if (p.kind === "region") return "state";
  if (p.kind === "county") return "county";
  // A town is a town: places carry the useful word in kind_detail
  // (city / town / village / hamlet / neighbourhood). Through KIND_LABEL like
  // everything else, though — those four are already English, but `locality`
  // and `isolated_dwelling` are not, and returning kind_detail raw put the
  // schema's own tokens on 556 of Oregon's rows: "Elk Lake · locality",
  // "Pistol River · isolated_dwelling".
  if (p.kind === "locality" || p.kind === "neighbourhood" || !p.kind) {
    return KIND_LABEL[p.detail] ?? (p.detail ? p.detail.replace(/_/g, " ") : "place");
  }
  // Say where it came from: a Forest Service designation is a legal fact
  // about who may drive it, not just another line on the map.
  if (p.kind === "mvum") return "forest road";

  const named = nameSuffixLabel(p.name);
  // Some vector-tile kinds are generic buckets — a reservoir, a lake and a
  // pond are all `water`, and a trailhead is `parking`. When the kind is one
  // of those, the name is the better authority: "Cougar Reservoir" is a
  // reservoir, "Green Lakes Trailhead" is a trailhead.
  if (VAGUE_KINDS.has(p.detail) && named) return named;

  const exact = KIND_LABEL[p.detail];
  if (exact) return exact;
  // Anything unmapped still reads as English rather than as a schema token.
  return p.detail ? p.detail.replace(/_/g, " ") : named || "place";
}

export function rankMatches(
  places: Place[],
  q: string,
  limit = 20,
  from?: { lng: number; lat: number }
): Place[] {
  const needle = fold(q.trim());
  if (!needle) return [];
  const here: LL | null = from ? [from.lng, from.lat] : null;
  const scored: { p: Place; s: number }[] = [];
  for (const p of places) {
    // buildIndex folded these once; a statewide index is tens of thousands of
    // places, and folding them all again on every keystroke is not affordable.
    const hay = p.folded ?? fold(p.name);
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    const prefix = at === 0 ? 2 : hay[at - 1] === " " ? 1 : 0;
    const near = here
      ? -NEAR_W * Math.log10(haversine(here, [p.lng, p.lat]) / 1609.344 + 1)
      : 0;
    scored.push({
      p,
      s:
        prefix * 1e6 +
        (p.pop > 0 ? Math.log10(p.pop + 1) : 0) +
        near -
        // Last word only: "Bend" over "Bend River Promenade" when nothing else
        // separates them, without ever overturning size or distance.
        p.name.length * 0.01,
    });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.p);
}

/**
 * Rank saved pins against a query.
 *
 * Separate from rankMatches because pins have no population to sort by, and
 * because the tie-breaks differ: the most recently dropped pin is usually the
 * one being looked for, since you drop a pin for something you are about to
 * act on. Notes are searched too — "water" finds a pin named "spring" whose
 * note mentions water, which is exactly what a note is for.
 */
export function rankPins(pins: Waypoint[], q: string, limit = 8): Waypoint[] {
  const needle = fold(q.trim());
  if (!needle) return [];
  const scored: { p: Waypoint; s: number }[] = [];
  for (const p of pins) {
    // Folded per keystroke, unlike places: there are a handful of pins, and they
    // change often enough that a cache would have to be invalidated on every save.
    const name = fold(p.name || "");
    const at = name.indexOf(needle);
    const inNote = fold(p.note || "").includes(needle);
    if (at < 0 && !inNote) continue;
    // Name beats note; start-of-name beats mid-word; then most recent first.
    const prefix = at === 0 ? 3 : at > 0 && name[at - 1] === " " ? 2 : at > 0 ? 1 : 0;
    scored.push({ p, s: prefix * 1e14 + (p.t || 0) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.p);
}

export type { Place };

export function initSearch(deps: {
  map: () => maplibregl.Map;
  /** Current pmtiles URL WITHOUT the pmtiles:// prefix. */
  sourceUrl: () => string;
  /** Drop the go-to pin at a spot (reuses the goto marker). */
  dropPin: (lng: number, lat: number) => void;
  /** Called after the map is moved to a result, to reveal it (peek the sheet). */
  onJump?: () => void;
}) {
  const panel = document.getElementById("search-panel");
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  // Your own pins, refreshed whenever the panel opens: they change far more
  // often than the place index, which is baked into the pack.
  let pins: Waypoint[] = [];
  const results = document.getElementById("search-results");

  function show(html: string) {
    if (results) results.innerHTML = html;
  }

  /**
   * The place index, but only when it belongs to the pack on screen.
   *
   * `index` is module-level and shared with Get-there, and a build for the
   * previous pack can still be running when this panel is opened — rendering
   * from that one offers places there is no map for, and flies to them.
   */
  const current = () => (index && indexedUrl === deps.sourceUrl() ? index : null);

  async function ensureIndex() {
    const url = deps.sourceUrl();
    if (index && indexedUrl === url) return;
    // Don't paint "Reading…" over the pin list — pins load faster than the
    // index and are what the user can act on meanwhile.
    if (!pins.length) show(`<div class="search-empty">Reading place names from the map pack…</div>`);
    try {
      const built = await ensurePlaceIndex(url, (d, t, phase) => {
        // Only while the results area has nothing better in it. Pins and
        // coordinates render before the index exists, and blatting progress
        // over them every 40 tiles took away results the user was mid-read of.
        if (input?.value.trim() || pins.length) return;
        // The forest-road phase has no count to give until the file is read, so
        // it names itself instead — better than sitting on the last tile count.
        show(
          `<div class="search-empty">Reading place names… ${
            t ? `${d}/${t} ` : ""
          }${phase}</div>`
        );
      });
      void built;
      // Re-render whatever's current (a query, or the empty state with pins),
      // now that the place index exists.
      render(input?.value || "");
    } catch (e) {
      show(`<div class="search-empty">Couldn't read this map pack: ${esc(e)}</div>`);
    }
  }

  /** Fly to a coordinate and pin it — what the old "Go to" box did. */
  function goToCoord(lng: number, lat: number) {
    deps.map().flyTo({ center: [lng, lat], zoom: Math.max(deps.map().getZoom(), 13) });
    deps.dropPin(lng, lat);
    panel?.classList.add("hidden");
    deps.onJump?.();
    toast(`Pin dropped at ${lat.toFixed(5)}, ${lng.toFixed(5)}`, "success");
  }

  /** Fly to one of the user's saved pins and re-drop its marker. Shared by the
   *  typed-match results and the browsable pin list shown on an empty query. */
  function jumpToPin(p: Waypoint) {
    deps.map().flyTo({ center: [p.lng, p.lat], zoom: Math.max(deps.map().getZoom(), 14) });
    deps.dropPin(p.lng, p.lat);
    panel?.classList.add("hidden");
    deps.onJump?.();
    toast(p.note ? `${p.name} — ${p.note}` : p.name, "success");
  }

  function pinButton(p: Waypoint, attr: string, i: number): string {
    return `<button class="search-hit" ${attr}="${i}">
        <span class="sh-name">${esc(p.name)}</span>
        <span class="sh-kind sh-pin">your pin</span>
      </button>`;
  }

  function render(q: string) {
    // A grid reference is offered before any name matching, and without needing
    // the place index — so a coordinate still works while the pack is loading,
    // or in a pack with no place names at all. One box, either kind of input:
    // in the field you should not have to know which control you need before
    // you look at what you were handed.
    const coord = parseCoord(q);
    if (coord) {
      show(`<button class="search-hit" id="search-coord">
          <span class="sh-name">${esc(coord[1].toFixed(5))}, ${esc(coord[0].toFixed(5))}</span>
          <span class="sh-kind">grid ref</span>
        </button>`);
      document
        .getElementById("search-coord")
        ?.addEventListener("click", () => goToCoord(coord[0], coord[1]));
      return;
    }
    // Your own pins first, and without waiting for the place index. They are
    // the places you cared enough to mark, so they outrank any town — and a
    // pack still building its index must not hide them.
    const pinHits = rankPins(pins, q);
    const pinHtml = pinHits.map((p, i) => pinButton(p, "data-pin", i)).join("");

    const bindPins = () => {
      results?.querySelectorAll<HTMLElement>("[data-pin]").forEach((el) => {
        el.addEventListener("click", () => jumpToPin(pinHits[Number(el.dataset.pin)]));
      });
    };

    if (!q.trim()) {
      // Nothing typed yet: list the user's pins so they're one tap away — the
      // places you marked are the ones you're most likely reaching for. Most
      // recent first, since a pin is usually dropped for something imminent.
      const recent = [...pins].sort((a, b) => (b.t || 0) - (a.t || 0));
      const idx = current();
      const hint = idx
        ? `<div class="search-empty">${idx.length} places known here. Type a name${
            recent.length ? ", or tap a pin below" : ""
          }.</div>`
        : `<div class="search-empty">Type to search${recent.length ? ", or tap a pin below" : ""}.</div>`;
      show(hint + recent.map((p, i) => pinButton(p, "data-allpin", i)).join(""));
      results?.querySelectorAll<HTMLElement>("[data-allpin]").forEach((el) => {
        el.addEventListener("click", () => jumpToPin(recent[Number(el.dataset.allpin)]));
      });
      return;
    }
    const places = current();
    if (!places) {
      // Index still building (or built for another pack): show what we can
      // rather than nothing.
      if (pinHtml) {
        show(pinHtml);
        bindPins();
      }
      return;
    }
    const here = deps.map().getCenter();
    const hits = rankMatches(places, q, 20, { lng: here.lng, lat: here.lat });
    if (!hits.length && !pinHits.length) {
      show(`<div class="search-empty">Nothing matches "${esc(q)}".</div>`);
      return;
    }
    show(
      pinHtml +
        hits
          .map(
            (p, i) => `<button class="search-hit" data-hit="${i}">
            <span class="sh-name">${esc(p.name)}</span>
            <span class="sh-kind">${esc(
              [placeLabel(p), distanceAway(p, here), nearestTown(p, places)]
                .filter(Boolean)
                .join(" · ")
            )}</span>
          </button>`
          )
          .join("")
    );
    bindPins();
    results?.querySelectorAll<HTMLElement>("[data-hit]").forEach((el) => {
      el.addEventListener("click", () => {
        const p = hits[Number(el.dataset.hit)];
        deps.map().flyTo({ center: [p.lng, p.lat], zoom: KIND_ZOOM[p.kind] ?? 12 });
        deps.dropPin(p.lng, p.lat);
        panel?.classList.add("hidden");
        deps.onJump?.();
        toast(`${p.name} — pin dropped`, "success");
      });
    });
  }

  document.getElementById("search-open")?.addEventListener("click", () => {
    panel?.classList.remove("hidden");
    input?.focus();
    void ensureIndex();
    // Marks are read fresh each time: one may have been dropped since.
    void loadMarks()
      .then((m) => {
        pins = m.waypoints ?? [];
        // Render now so pins show immediately on open, even with an empty box.
        render(input?.value || "");
      })
      .catch(() => {
        /* pins are a bonus here; the place index still works without them */
      });
  });
  document.getElementById("search-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });
  input?.addEventListener("input", () => render(input.value));
  input?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const coord = parseCoord(input.value);
    if (coord) goToCoord(coord[0], coord[1]);
  });
  document.getElementById("search-clear-pin")?.addEventListener("click", () => {
    clearGotoPin();
    toast("Pin cleared", "info");
  });
}
