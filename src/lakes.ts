// Nearby lakes — a distance-sorted list of named lakes and reservoirs, and the
// name of a lake under a tap even when zoomed out.
//
// Lake names live on separate label POINTS in the pack's `water` layer, and only
// at zoom ~12+. So the on-map label (and a rendered-feature query) only exist
// when you're zoomed in near the lake — which is why a zoomed-out tap finds no
// name. This module reads those name points straight from the tiles at a fixed
// scan zoom, independent of the view, so both the list and the tap-name work at
// any zoom. Tiles are fetched nearest-first and cached per pack.

import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

export interface Lake {
  name: string;
  kind: string; // raw basemap kind: water / lake / reservoir / river / stream / canal
  label?: string; // display type: lake / reservoir / river / creek / canal
  lng: number;
  lat: number;
  distMi?: number; // filled in relative to a query point
}

// Named water worth listing. Still water (lakes/reservoirs) is labelled by a
// point; flowing water (rivers/creeks/canals) by a line — both are collected.
const STILL_LAKE_KINDS = new Set(["water", "lake", "reservoir", "pond", "lagoon", "basin"]);
const FLOW_KINDS = new Set(["river", "stream", "canal"]);

/** Display type for a water feature, from its kind and name. */
export function waterLabel(name: string, kind: string): string {
  if (kind === "river") return "river";
  if (kind === "stream") return "creek";
  if (kind === "canal") return "canal";
  if (kind === "reservoir" || /\breservoir\b/i.test(name)) return "reservoir";
  // A still-water polygon named like flowing water (e.g. "Bull Run River").
  if (/\bcreek\b/i.test(name)) return "creek";
  if (/\briver\b|\bslough\b|\bbayou\b/i.test(name)) return "river";
  if (/\bcanal\b|\bditch\b/i.test(name)) return "canal";
  return "lake";
}

// A lake's name point only appears in tiles at roughly its own min_zoom and
// deeper — a big lake shows from ~z12, a small one only by z15. So there is no
// single "read everything" zoom below the pack's maxzoom: to catch small lakes
// we must read deep tiles, but reading deep tiles over a wide area is far too
// many. The list therefore scans in two passes (wide+shallow for the big lakes
// far out, near+deep for the small lakes close in); tap-naming reads the pack's
// maxzoom locally, where every lake's name exists.
const WIDE_Z = 12;

/** Great-circle distance in miles. */
export function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180, la2 = (bLat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function lon2x(lng: number, z: number) { return Math.floor(((lng + 180) / 360) * 2 ** z); }
function lat2y(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}
function x2lng(x: number, z: number) { return (x / 2 ** z) * 360 - 180; }
function y2lat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

interface Cache { pm: PMTiles; scanned: Set<string>; lakes: Map<string, Lake>; }
const caches = new Map<string, Cache>();
function cacheFor(url: string): Cache {
  let c = caches.get(url);
  if (!c) { c = { pm: new PMTiles(url), scanned: new Set(), lakes: new Map() }; caches.set(url, c); }
  return c;
}

/** Drop all cached lake scans. Called when the active pack is switched or
 *  re-downloaded, since a stale PMTiles instance would read old byte offsets. */
export function clearLakesCache() { caches.clear(); }

// A "lake" named like flowing water (a river/creek tagged as a water polygon) is
// not a lake — keep it out of the lakes list, unless the name also says lake.
const FLOWING = /\b(river|creek|brook|stream|slough|canal|ditch|bayou|wash)\b/i;
const STILLNAME = /\b(lake|reservoir|pond|lagoon|basin)\b/i;
function isFlowingName(name: string): boolean {
  return FLOWING.test(name) && !STILLNAME.test(name);
}

async function scanTiles(
  c: Cache,
  z: number,
  tiles: { x: number; y: number }[],
  onProgress?: (done: number, total: number) => void
) {
  const todo = tiles.filter((t) => !c.scanned.has(`${z}/${t.x}/${t.y}`));
  if (!todo.length) { onProgress?.(0, 0); return; }
  let done = 0;
  const CONC = 12;
  await Promise.all(
    Array.from({ length: CONC }, async (_, w) => {
      for (let i = w; i < todo.length; i += CONC) {
        const { x, y } = todo[i];
        try {
          const t = await c.pm.getZxy(z, x, y);
          // Mark scanned only after a successful read (null = a real "no tile");
          // a thrown/failed read is left unmarked so it can be retried.
          c.scanned.add(`${z}/${x}/${y}`);
          if (t?.data) {
            const vt = new VectorTile(new PbfReader(new Uint8Array(t.data)));
            const L = vt.layers["water"];
            for (let f = 0; L && f < L.length; f++) {
              const feat = L.feature(f);
              const props: any = feat.properties;
              const name = props["name:en"] || props.name;
              if (!name) continue;
              const kind = String(props.kind ?? "");
              // Points name still water (lakes); lines name flowing water
              // (rivers/creeks). Take a line's midpoint as its representative
              // point for the list; a name deduped nearest-first later keeps the
              // closest segment of a long river.
              let px: number, py: number, ext = feat.extent;
              if (feat.type === 1 && (STILL_LAKE_KINDS.has(kind) || FLOW_KINDS.has(kind))) {
                const g = feat.loadGeometry()[0]?.[0];
                if (!g) continue;
                px = g.x; py = g.y;
              } else if (feat.type === 2 && FLOW_KINDS.has(kind)) {
                const parts = feat.loadGeometry();
                const part = parts.reduce((a, b) => (a.length >= b.length ? a : b), parts[0] || []);
                const mid = part[Math.floor(part.length / 2)];
                if (!mid) continue;
                px = mid.x; py = mid.y;
              } else {
                continue;
              }
              const lng = x2lng(x + px / ext, z);
              const lat = y2lat(y + py / ext, z);
              const key = `${name}|${Math.round(lng * 20)}|${Math.round(lat * 20)}`;
              if (!c.lakes.has(key)) c.lakes.set(key, { name: String(name), kind, lng, lat });
            }
          }
        } catch {
          /* a missing/failed tile is fine — left unscanned to retry */
        }
        done++;
        if (done % 20 === 0) onProgress?.(done, todo.length);
      }
    })
  );
  onProgress?.(todo.length, todo.length);
}

/** Tiles at zoom `z` covering a box of `maxMi` around a centre, clamped to the
 *  pack, ordered nearest-first so a tile cap still keeps the closest ground. */
function tilesAround(
  z: number,
  center: { lng: number; lat: number },
  maxMi: number,
  b: { west: number; south: number; east: number; north: number }
): { x: number; y: number }[] {
  const dLat = maxMi / 69;
  const dLng = maxMi / (69 * Math.max(0.1, Math.cos((center.lat * Math.PI) / 180)));
  const x0 = Math.max(lon2x(center.lng - dLng, z), lon2x(b.west, z));
  const x1 = Math.min(lon2x(center.lng + dLng, z), lon2x(b.east, z));
  const y0 = Math.max(lat2y(center.lat + dLat, z), lat2y(b.north, z));
  const y1 = Math.min(lat2y(center.lat - dLat, z), lat2y(b.south, z));
  const cx = lon2x(center.lng, z), cy = lat2y(center.lat, z);
  const out: { x: number; y: number; d: number }[] = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      out.push({ x, y, d: (x - cx) ** 2 + (y - cy) ** 2 });
  out.sort((a, b2) => a.d - b2.d);
  return out.map(({ x, y }) => ({ x, y }));
}

/**
 * Named lakes and reservoirs near a point, nearest first. A lake's name point
 * only exists from ~its own min_zoom down, so no single zoom sees them all
 * cheaply: big lakes appear shallow, small lakes only deep. So this scans in
 * tiers — wide+shallow for the big lakes far out, a mid tier for medium lakes,
 * and a tight+deep tier for the small lakes close in — each capped nearest-first
 * so a sparse, huge area can't hang.
 */
export async function nearbyLakes(opts: {
  url: string;
  center: { lng: number; lat: number };
  maxMi?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<Lake[]> {
  const { url, center, maxMi = 80, onProgress } = opts;
  const c = cacheFor(url);
  const header = await c.pm.getHeader();
  const bounds = {
    west: header.minLon, south: header.minLat, east: header.maxLon, north: header.maxLat,
  };
  const deepZ = header.maxZoom ?? 15;

  // Tier by (zoom, radius, tile-cap). Deeper zoom → tighter radius, since deep
  // tiles are small and only the closest ground fits the budget. The wide tier
  // is clamped so a shallow pack never scans below its own maxzoom.
  const tiers: { z: number; mi: number; cap: number }[] = [{ z: Math.min(WIDE_Z, deepZ), mi: maxMi, cap: 180 }];
  if (deepZ >= 13) tiers.push({ z: 13, mi: 40, cap: 250 });
  if (deepZ >= 14) tiers.push({ z: deepZ, mi: 8, cap: 200 });

  const lists = tiers.map((t) => tilesAround(t.z, center, t.mi, bounds).slice(0, t.cap));
  const total = lists.reduce((s, l) => s + l.length, 0);
  let base = 0;
  for (let i = 0; i < tiers.length; i++) {
    const list = lists[i];
    await scanTiles(c, tiers[i].z, list, (d) => onProgress?.(base + d, total));
    base += list.length;
  }

  // Dedup by name, keeping the nearest instance — a big reservoir or a long
  // river yields a label point per tile, which would otherwise repeat in the
  // list. Two genuinely distinct same-named lakes far apart collapse to the
  // nearer one, which is the right call for a "nearby" list.
  const byName = new Map<string, Lake>();
  for (const l of c.lakes.values()) {
    const distMi = milesBetween(center.lat, center.lng, l.lat, l.lng);
    if (distMi > maxMi) continue;
    const prev = byName.get(l.name);
    if (!prev || distMi < prev.distMi!) {
      byName.set(l.name, { ...l, distMi, label: waterLabel(l.name, l.kind) });
    }
  }
  return [...byName.values()].sort((a, b) => a.distMi! - b.distMi!);
}

/**
 * The name of the nearest lake to a point, within `withinMi` — used to name a
 * tapped lake when the on-map label isn't rendered (zoomed out). Reads the
 * pack's maxzoom around the tap, where every lake's name point exists.
 */
export async function lakeNameNear(opts: {
  url: string;
  lng: number;
  lat: number;
  withinMi?: number;
}): Promise<string> {
  const { url, lng, lat, withinMi = 3 } = opts;
  const c = cacheFor(url);
  const z = (await c.pm.getHeader()).maxZoom ?? 15;
  const cx = lon2x(lng, z), cy = lat2y(lat, z);
  const R = 2; // 5x5 neighbourhood at maxzoom
  const tiles: { x: number; y: number }[] = [];
  for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) tiles.push({ x: cx + dx, y: cy + dy });
  await scanTiles(c, z, tiles);
  let best = "", bestD = Infinity;
  for (const l of c.lakes.values()) {
    // Only name a tapped lake with actual still water — the cache also holds
    // rivers/creeks now, which shouldn't name a lake.
    if (FLOW_KINDS.has(l.kind) || isFlowingName(l.name)) continue;
    const d = milesBetween(lat, lng, l.lat, l.lng);
    if (d < bestD) { bestD = d; best = l.name; }
  }
  return bestD <= withinMi ? best : "";
}
