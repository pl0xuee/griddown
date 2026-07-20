// Match a computed route against the Motor Vehicle Use Map.
//
// "Get there" plans over the basemap's roads, which include forest tracks —
// so it will happily route you down a Forest Service road. What the basemap
// cannot say is whether you are ALLOWED to drive it, in what, or in which
// months. That answer only exists in the MVUM, and it is the difference
// between a shortcut and a citation.
//
// The two datasets are separate surveys of the same ground: their geometry is
// close but never identical, so routes are matched to MVUM routes by proximity
// rather than by id. Everything here is deliberately conservative — an
// unmatched stretch is reported as unknown, never as permitted.

import { haversine, type LL } from "./geo";

export interface MvumFeatureLite {
  props: Record<string, unknown>;
  /** Every vertex of the route, flattened from Line/MultiLineString. */
  points: LL[];
  /** Consecutive vertex pairs — what distance is actually measured against. */
  segments?: Array<[LL, LL]>;
}

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG = 111_320;

/**
 * Distance from a point to a line segment, in metres.
 *
 * Measuring to vertices alone is not good enough: MVUM geometry is simplified,
 * so a straight half-mile of road may have vertices only at its ends, and a
 * route running down the middle of it would come out "unmatched" — silently
 * under-reporting the very roads this is meant to check. Flat-earth projection
 * is fine at the tens-of-metres scale being tested.
 */
export function pointToSegmentM(p: LL, a: LL, b: LL): number {
  const kx = M_PER_DEG_LNG * Math.cos((p[1] * Math.PI) / 180);
  const ky = M_PER_DEG_LAT;
  const px = (p[0] - a[0]) * kx;
  const py = (p[1] - a[1]) * ky;
  const bx = (b[0] - a[0]) * kx;
  const by = (b[1] - a[1]) * ky;
  const len2 = bx * bx + by * by;
  // A zero-length segment is just its endpoint — and duplicate vertices are
  // common in this data, so this branch is reached in practice.
  if (len2 === 0) return Math.hypot(px, py);
  let t = (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - bx * t, py - by * t);
}

/**
 * A coarse grid over the loaded MVUM features.
 *
 * A state carries tens of thousands of routes and a route may sample hundreds
 * of points, so a linear scan per point is millions of comparisons. Bucketing
 * by rounded degree keeps each lookup to the handful of routes actually nearby.
 */
export class MvumIndex {
  private cells = new Map<string, number[]>();
  private feats: MvumFeatureLite[] = [];
  /** ~0.01° ≈ 1.1 km — comfortably larger than any match distance. */
  private readonly step = 0.01;

  private key(lng: number, lat: number): string {
    return `${Math.floor(lng / this.step)}:${Math.floor(lat / this.step)}`;
  }

  add(feat: MvumFeatureLite) {
    const idx = this.feats.length;
    const segments: Array<[LL, LL]> =
      feat.segments ??
      feat.points.slice(1).map((p, i) => [feat.points[i], p] as [LL, LL]);
    this.feats.push({ ...feat, segments });

    const seen = new Set<string>();
    const register = (lng: number, lat: number) => {
      const k = this.key(lng, lat);
      if (seen.has(k)) return;
      seen.add(k);
      const bucket = this.cells.get(k);
      if (bucket) bucket.push(idx);
      else this.cells.set(k, [idx]);
    };

    if (!segments.length) {
      for (const [lng, lat] of feat.points) register(lng, lat);
      return;
    }
    // Register the cells a segment CROSSES, not only the ones its ends land in:
    // a long segment can span a whole cell without a vertex inside it, and that
    // cell's lookups would never consider this route.
    for (const [a, b] of segments) {
      const steps = Math.max(
        1,
        Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / (this.step / 2))
      );
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        register(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
      }
    }
  }

  get size(): number {
    return this.feats.length;
  }

  /** Nearest MVUM route to a point, within maxMeters — or null. */
  nearest(lng: number, lat: number, maxMeters = 40): MvumFeatureLite | null {
    let best: MvumFeatureLite | null = null;
    let bestD = maxMeters;
    const cx = Math.floor(lng / this.step);
    const cy = Math.floor(lat / this.step);
    const tried = new Set<number>();
    // The neighbouring cells too: a point near a cell edge has its nearest
    // route in the cell next door as often as its own.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of this.cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (tried.has(i)) continue;
          tried.add(i);
          const f = this.feats[i];
          for (const [a, b] of f.segments ?? []) {
            const d = pointToSegmentM([lng, lat], a, b);
            if (d < bestD) {
              bestD = d;
              best = f;
            }
          }
          // A single-vertex feature has no segment to measure against.
          if (!f.segments?.length) {
            for (const p of f.points) {
              const d = haversine([lng, lat], p);
              if (d < bestD) {
                bestD = d;
                best = f;
              }
            }
          }
        }
      }
    }
    return best;
  }
}

/** Build an index from the downloaded MVUM GeoJSON. */
export function buildMvumIndex(geojson: any): MvumIndex {
  const index = new MvumIndex();
  for (const f of geojson?.features ?? []) {
    const g = f?.geometry;
    if (!g) continue;
    const lines: LL[][] =
      g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    const points: LL[] = [];
    // Segments are built PER PART. Flattening first and pairing consecutive
    // points joined the end of one part to the start of the next with a
    // straight line across ground the route does not cover — and MVUM routes
    // are routinely multi-part exactly where they are interrupted, by an
    // inholding or a change of jurisdiction. Matching against that phantom
    // reported the gap as designated, turning "unknown" into "permitted".
    const segments: Array<[LL, LL]> = [];
    for (const line of lines) {
      let prev: LL | null = null;
      for (const c of line) {
        const pt: LL = [c[0], c[1]];
        points.push(pt);
        if (prev) segments.push([prev, pt]);
        prev = pt;
      }
    }
    if (points.length) index.add({ props: f.properties ?? {}, points, segments });
  }
  return index;
}

/** Walk a path, dropping a sample at least every `everyM` metres. */
export function samplePath(path: LL[], everyM = 60): LL[] {
  if (path.length < 2) return path.slice();
  const out: LL[] = [path[0]];
  let carried = 0;
  for (let i = 1; i < path.length; i++) {
    const segLen = haversine(path[i - 1], path[i]);
    if (segLen === 0) continue;
    let t = everyM - carried;
    while (t <= segLen) {
      const f = t / segLen;
      out.push([
        path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f,
        path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f,
      ]);
      t += everyM;
    }
    carried = (carried + segLen) % everyM;
  }
  out.push(path[path.length - 1]);
  return out;
}

export interface MvumRouteSummary {
  /** Metres of the route that sit on a designated MVUM route. */
  matchedM: number;
  /** Metres with no MVUM route nearby — public highway, or simply not covered. */
  unmatchedM: number;
  /** Metres by access class label. */
  byClass: Array<{ label: string; metres: number; symbol: string }>;
  /** Named routes travelled, in the order first met. */
  routes: Array<{ id: string; name: string; symbol: string }>;
  /** Designated routes on this path that are seasonal. */
  seasonal: Array<{ id: string; dates: string }>;
}

/**
 * Which MVUM routes a path travels, and under what rules.
 *
 * Distances are attributed by sample, so they are approximate by design — the
 * point is "most of this is highway-legal only", not a surveyed mileage.
 */
export function summariseRoute(
  path: LL[],
  index: MvumIndex,
  classify: (symbol: unknown) => { label: string; seasonal?: boolean },
  datesFor: (props: Record<string, unknown>) => string,
  maxMeters = 40
): MvumRouteSummary {
  const samples = samplePath(path);
  const byClass = new Map<string, { label: string; metres: number; symbol: string }>();
  const routes = new Map<string, { id: string; name: string; symbol: string }>();
  const seasonal = new Map<string, { id: string; dates: string }>();
  let matchedM = 0;
  let unmatchedM = 0;

  for (let i = 0; i < samples.length; i++) {
    // Each sample stands for the ground halfway to its neighbours.
    const prev = i > 0 ? haversine(samples[i - 1], samples[i]) / 2 : 0;
    const next = i < samples.length - 1 ? haversine(samples[i], samples[i + 1]) / 2 : 0;
    const share = prev + next;

    const hit = index.nearest(samples[i][0], samples[i][1], maxMeters);
    if (!hit) {
      unmatchedM += share;
      continue;
    }
    matchedM += share;

    const symbol = String(hit.props.symbol ?? "");
    const { label, seasonal: seasonalSymbol } = classify(symbol);
    const entry = byClass.get(label);
    if (entry) entry.metres += share;
    else byClass.set(label, { label, metres: share, symbol });

    const id = String(hit.props.id ?? "").trim();
    const name = String(hit.props.name ?? "").trim();
    const routeKey = id || name;
    if (routeKey && !routes.has(routeKey)) routes.set(routeKey, { id, name, symbol });

    // The map dashes a route on its SYMBOL code, so the warning must use the
    // same test or the two disagree: a blank SEASONAL attribute (stripped as
    // empty on download) would draw dashed and warn about nothing.
    const seasonalFlag = String(hit.props.seasonal ?? "").trim().toLowerCase() === "seasonal";
    if ((seasonalFlag || seasonalSymbol === true) && routeKey && !seasonal.has(routeKey)) {
      seasonal.set(routeKey, { id: id || name, dates: datesFor(hit.props) });
    }
  }

  return {
    matchedM,
    unmatchedM,
    byClass: [...byClass.values()].sort((a, b) => b.metres - a.metres),
    routes: [...routes.values()],
    seasonal: [...seasonal.values()],
  };
}
