// Route graph + A* over roads decoded from the map pack. Pure — no maplibre,
// no network — so it can be tested and later moved to a worker.
//
// IMPORTANT: this is built from *rendering* tiles. They carry geometry, class,
// name and oneway, but no turn restrictions, no access tags (private drives,
// locked gates), no surface, no seasonal closures. It can say "here is a road
// path from A to B"; it cannot say "you are allowed to drive it". Callers must
// present the result as an overview, never as navigation.

export interface RoadSeg {
  coords: [number, number][];
  kind: string; // major_road | minor_road | path | rail | aeroway …
  detail: string; // primary | residential | track | footway …
  name?: string;
  ref?: string;
  oneway?: boolean;
  bridge?: boolean;
}

export interface RouteStep {
  /** Road name/ref, or a generic label when the way is unnamed. */
  name: string;
  meters: number;
}

export interface RouteResult {
  coords: [number, number][];
  meters: number;
  steps: RouteStep[];
  /** True when the route relies on a trail/path rather than a drivable road. */
  usedTrail: boolean;
  /** Straight-line metres between the requested endpoints, for comparison. */
  directMeters: number;
  /** Distance from the requested start/end to the road the route actually uses. */
  snappedFromM: number;
  snappedToM: number;
}

// Cost multipliers per road class: lower = preferred. A vehicle route should
// favour real roads and fall back to tracks/trails only when nothing else
// connects, so paths cost several times their length rather than being banned
// outright (banning them strands anyone whose destination is up a trail).
const CLASS_COST: Record<string, number> = {
  major_road: 1,
  minor_road: 1.35,
  path: 6,
};
const DETAIL_COST: Record<string, number> = {
  track: 2.5, // forest/logging roads: drivable, but slow and rough
  steps: 40, // not drivable by anything
  sidewalk: 12,
  crossing: 12,
  footway: 10,
  pier: 20,
  corridor: 20,
  raceway: 20,
};

/** Kinds that must never carry a route, whatever the geometry suggests. */
export function isRoutable(kind: string, detail: string): boolean {
  if (kind === "rail" || kind === "aeroway") return false;
  if (detail === "runway" || detail === "taxiway") return false;
  return kind === "major_road" || kind === "minor_road" || kind === "path";
}

export function costMultiplier(seg: { kind: string; detail: string }): number {
  return DETAIL_COST[seg.detail] ?? CLASS_COST[seg.kind] ?? 3;
}

const R_EARTH = 6371000;
export function haversine(a: [number, number], b: [number, number]): number {
  const φ1 = (a[1] * Math.PI) / 180;
  const φ2 = (b[1] * Math.PI) / 180;
  const dφ = φ2 - φ1;
  const dλ = ((b[0] - a[0]) * Math.PI) / 180;
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

interface Edge {
  to: number;
  cost: number;
  meters: number;
  seg: number; // index into the segment metadata table
}

/**
 * Adjacency is CSR — one flat typed array per edge field, with `start` giving
 * each node's slice — not an array of Edge objects per node.
 *
 * This is a memory decision, and on a phone it is the difference between a
 * route and being killed by the OS. An `Edge` object plus its slot in a
 * per-node array measured 150–176 bytes per edge, which put a 17-mile trip at
 * 83 MB and a Newport–La Grande corridor at 343 MB. The same edges as five
 * typed arrays are 24 bytes each, flat, with no per-node array and no object
 * header. A* got faster too, because walking a Float64Array beats chasing
 * pointers into a million small objects.
 */
export interface RouteGraph {
  lng: Float64Array;
  lat: Float64Array;
  /** Node v's outgoing edges are the index range [start[v], start[v + 1]). */
  start: Int32Array;
  eTo: Int32Array;
  eCost: Float64Array;
  eMet: Float64Array;
  /** Segment metadata index, or -1 for a stitch link. */
  eSeg: Int32Array;
  /**
   * Edge-object view of the same adjacency, built on first read and cached.
   * Nothing in the app touches it — it exists so the graph can still be
   * inspected edge-by-edge in a test without the router paying for it.
   */
  readonly adj: Edge[][];
  segs: { name: string; kind: string; detail: string }[];
  nodeCount: number;
  /** Connected-component id per node. */
  comp: Int32Array;
  /** Node count of each component, indexed by component id. */
  compSize: number[];
}

/** Label every node with its connected component (undirected reachability). */
function labelComponents(start: Int32Array, eTo: Int32Array, nodeCount: number) {
  const comp = new Int32Array(nodeCount).fill(-1);
  const compSize: number[] = [];
  // Oneways make the graph directed; for *reachability* grouping we want the
  // undirected view, so build a reverse adjacency on the fly.
  //
  // Held as CSR — an offsets array plus a flat targets array — rather than one
  // array per node. This function runs twice per build, and an array per node
  // meant 854 k empty-array allocations each time on a Portland–Salem corridor,
  // for an index that fits entirely in two Int32Arrays.
  const total = nodeCount ? start[nodeCount] : 0;
  const back = new Int32Array(nodeCount + 1);
  for (let i = 0; i < total; i++) back[eTo[i] + 1]++;
  for (let i = 0; i < nodeCount; i++) back[i + 1] += back[i];
  const backTo = new Int32Array(total);
  const cursor = back.slice(0, nodeCount);
  for (let v = 0; v < nodeCount; v++)
    for (let i = start[v]; i < start[v + 1]; i++) backTo[cursor[eTo[i]]++] = v;
  // A node is pushed only when its comp is claimed in the same statement, so it
  // can never be on the stack twice and nodeCount is a hard bound.
  const stack = new Int32Array(nodeCount);
  for (let s = 0; s < nodeCount; s++) {
    if (comp[s] !== -1) continue;
    const id = compSize.length;
    let size = 0;
    let sp = 0;
    stack[sp++] = s;
    comp[s] = id;
    while (sp) {
      const v = stack[--sp];
      size++;
      for (let i = start[v]; i < start[v + 1]; i++) {
        const w = eTo[i];
        if (comp[w] === -1) { comp[w] = id; stack[sp++] = w; }
      }
      for (let i = back[v]; i < back[v + 1]; i++) {
        const w = backTo[i];
        if (comp[w] === -1) { comp[w] = id; stack[sp++] = w; }
      }
    }
    compSize.push(size);
  }
  return { comp, compSize };
}

/**
 * A class rather than an object literal, purely so `adj` can live on the
 * PROTOTYPE.
 *
 * An accessor declared inside an object literal makes V8 read that object's
 * ordinary data properties roughly half as fast — measured on a Bend–Redmond
 * graph, a scan reading g.lng/g.lat went 36 ms to 72 ms just by adding the
 * getter to the literal. nearestNodes reads them once per node per snap, which
 * is a million times per route, so that is not a rounding error. Moved to the
 * prototype the cost disappears entirely.
 */
class Graph implements RouteGraph {
  lng: Float64Array;
  lat: Float64Array;
  start: Int32Array;
  eTo: Int32Array;
  eCost: Float64Array;
  eMet: Float64Array;
  eSeg: Int32Array;
  segs: { name: string; kind: string; detail: string }[];
  nodeCount: number;
  comp: Int32Array;
  compSize: number[];
  private view: Edge[][] | null = null;

  constructor(
    lng: Float64Array,
    lat: Float64Array,
    start: Int32Array,
    eTo: Int32Array,
    eCost: Float64Array,
    eMet: Float64Array,
    eSeg: Int32Array,
    segs: { name: string; kind: string; detail: string }[],
    nodeCount: number,
    comp: Int32Array,
    compSize: number[]
  ) {
    this.lng = lng;
    this.lat = lat;
    this.start = start;
    this.eTo = eTo;
    this.eCost = eCost;
    this.eMet = eMet;
    this.eSeg = eSeg;
    this.segs = segs;
    this.nodeCount = nodeCount;
    this.comp = comp;
    this.compSize = compSize;
  }

  get adj(): Edge[][] {
    if (this.view) return this.view;
    const out: Edge[][] = new Array(this.nodeCount);
    for (let v = 0; v < this.nodeCount; v++) {
      const es: Edge[] = [];
      for (let i = this.start[v]; i < this.start[v + 1]; i++)
        es.push({ to: this.eTo[i], cost: this.eCost[i], meters: this.eMet[i], seg: this.eSeg[i] });
      out[v] = es;
    }
    return (this.view = out);
  }
}

/** Snap precision for identifying a shared vertex: ~0.1 m. */
const SNAP_DP = 6;

/**
 * Build a routable graph from decoded road segments.
 *
 * Two vertices join only when they are the *same point* (to ~0.1 m), plus the
 * endpoint-anchored stitch pass described below. A coarse *global* snap is
 * deliberately avoided: it would fuse an overpass to the highway crossing
 * beneath it and invent a turn that does not exist.
 */
export function buildRouteGraph(
  segs: RoadSeg[],
  opts: { stitchMeters?: number } = {}
): RouteGraph {
  const { stitchMeters = 25 } = opts;
  // Vertex identity is a NUMBER pair, not a string.
  //
  // The obvious `${lng.toFixed(6)},${lat.toFixed(6)}` key cost one string
  // allocation per vertex read — 1.07 M of them on a Portland–Salem corridor —
  // and the garbage dominated both the time and the peak heap of the build. A
  // two-level map keyed on the rounded integers carries the same information
  // with no allocation per lookup.
  //
  // One semantic difference, accepted deliberately: toFixed distinguishes
  // "-0.000000" from "0.000000" and a number cannot, so two points less than
  // 0.09 m apart that straddle exactly 0° longitude or 0° latitude now merge
  // instead of staying separate. That is well inside the 0.1 m tolerance
  // SNAP_DP already declares, and 0°/0° is in the Gulf of Guinea — no US pack
  // contains either line.
  const ids = new Map<number, Map<number, number>>();
  const SNAP_Q = 10 ** SNAP_DP;
  // Math.round is half-up, and negatives are negated before rounding, which
  // reproduces toFixed's round-half-away-from-zero exactly.
  const q = (v: number) => (v >= 0 ? Math.round(v * SNAP_Q) : -Math.round(-v * SNAP_Q));
  const lngs: number[] = [];
  const lats: number[] = [];
  const meta: { name: string; kind: string; detail: string }[] = [];

  const idOf = (c: [number, number]) => {
    const kx = q(c[0]);
    let row = ids.get(kx);
    if (row === undefined) ids.set(kx, (row = new Map<number, number>()));
    const ky = q(c[1]);
    let id = row.get(ky);
    if (id === undefined) {
      id = lngs.length;
      row.set(ky, id);
      lngs.push(c[0]);
      lats.push(c[1]);
    }
    return id;
  };

  const endpoints: number[] = [];
  // Road classes touching each node, as a bitmask. A node can belong to several
  // segments, so this must accumulate rather than record only the last one.
  const MAJOR = 1;
  const kindMask: number[] = [];
  const maskOf = (kind: string) => (kind === "major_road" ? MAJOR : kind === "minor_road" ? 2 : 4);
  const usable = (s: RoadSeg) => isRoutable(s.kind, s.detail) && s.coords.length >= 2;

  // CSR cannot be grown an edge at a time: every node's degree has to be known
  // before the first edge is written, so the geometry is walked more than once.
  // Each vertex's node id is resolved ONCE, here, and cached — re-deriving it
  // on the later passes would mean a second and third million-entry map lookup
  // for information already in hand.
  let vertexCount = 0;
  for (const s of segs) if (usable(s)) vertexCount += s.coords.length;
  const vids = new Int32Array(vertexCount);
  let vp = 0;
  for (const s of segs) {
    if (!usable(s)) continue;
    meta.push({
      name: s.ref || s.name || genericName(s),
      kind: s.kind,
      detail: s.detail,
    });
    const km = maskOf(s.kind);
    const first = vp;
    for (let i = 0; i < s.coords.length; i++) {
      const id = idOf(s.coords[i]);
      kindMask[id] = (kindMask[id] ?? 0) | km;
      vids[vp++] = id;
    }
    endpoints.push(vids[first], vids[vp - 1]);
  }

  const nodeCount = lngs.length;
  // Pass 2: geometry out-degree per node, prefix-summed into CSR offsets.
  const geomStart = new Int32Array(nodeCount + 1);
  vp = 0;
  for (const s of segs) {
    if (!usable(s)) continue;
    const len = s.coords.length;
    for (let i = 1; i < len; i++) {
      const a = vids[vp + i - 1];
      const b = vids[vp + i];
      if (a !== b) {
        geomStart[a + 1]++;
        // A oneway is traversable only in geometry order.
        if (!s.oneway) geomStart[b + 1]++;
      }
    }
    vp += len;
  }
  for (let i = 0; i < nodeCount; i++) geomStart[i + 1] += geomStart[i];
  const geomEdges = nodeCount ? geomStart[nodeCount] : 0;

  // Stitch tile seams: link each segment ENDPOINT to the nearest vertex of a
  // different segment.
  //
  // Endpoint-to-endpoint matching does not work here. Planetiler renders
  // geometry into a buffer past each tile edge, so neighbouring tiles carry
  // overlapping *duplicates* of the same road — one copy's endpoint sits
  // partway ALONG the other copy, not near its end. Matching ends to ends
  // therefore needed ~50 m to catch anything (measured: Bend and Redmond only
  // joined at 50 m), which is loose enough to fuse unrelated roads. Anchoring
  // on endpoints but allowing any vertex as the target connects the same seams
  // at a far tighter tolerance. It stays endpoint-anchored deliberately: a road
  // crossing *over* another mid-way (an overpass) has its endpoints at the
  // ramps, so it is never fused to the road beneath.
  // Stitch links, collected here and merged into the final CSR below rather
  // than appended as they are found.
  const linkFrom: number[] = [];
  const linkTo: number[] = [];
  const linkM: number[] = [];
  const extraDeg = new Int32Array(nodeCount);

  if (stitchMeters > 0 && endpoints.length) {
    // Which piece each vertex already belongs to, BEFORE any bridging. The pass
    // exists solely to join pieces that are disconnected, so a candidate in the
    // same component is never a seam. Testing direct adjacency instead (as this
    // did) only rejected the immediate neighbour, so an endpoint handed itself
    // free bidirectional shortcuts to other vertices of its OWN segment — which
    // cut corners off curves, under-reported distance, and let the router drive
    // the wrong way up a oneway.
    //
    // Only the shape of the geometry graph matters here, so this pass fills a
    // targets array alone — the costs and metres are computed later, straight
    // into the final arrays, and are never materialised twice.
    const geomTo = new Int32Array(geomEdges);
    const geomCursor = geomStart.slice(0, nodeCount);
    vp = 0;
    for (const s of segs) {
      if (!usable(s)) continue;
      const len = s.coords.length;
      for (let i = 1; i < len; i++) {
        const a = vids[vp + i - 1];
        const b = vids[vp + i];
        if (a !== b) {
          geomTo[geomCursor[a]++] = b;
          if (!s.oneway) geomTo[geomCursor[b]++] = a;
        }
      }
      vp += len;
    }
    const pre = labelComponents(geomStart, geomTo, nodeCount).comp;
    const cellLat = Math.max(stitchMeters, 250) / 111320; // rough degrees
    // A degree of longitude is only cos(lat) as wide as a degree of latitude —
    // ~0.72 across the lower 48. Using the latitude cell on both axes shrank the
    // ±1-cell scan below the intended reach east-west, so an east-west gap
    // stitched or not depending on where the road fell relative to a cell
    // boundary: the 219 m and 239 m US-97 gaps this allowance exists for only
    // bridged reliably when the road happened to run north-south.
    let midLat = 0;
    let maxAbsLat = 0;
    for (let i = 0; i < lats.length; i++) {
      midLat += lats[i];
      const a = Math.abs(lats[i]);
      if (a > maxAbsLat) maxAbsLat = a;
    }
    midLat = lats.length ? midLat / lats.length : 0;
    const cellLng = cellLat / Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
    const grid = new Map<string, number[]>();
    for (let id = 0; id < lngs.length; id++) {
      const k = `${Math.floor(lngs[id] / cellLng)},${Math.floor(lats[id] / cellLat)}`;
      let b = grid.get(k);
      if (!b) grid.set(k, (b = []));
      b.push(id);
    }
    // Link to the nearest FEW candidates, not just the single nearest.
    //
    // One link per endpoint silently fails in the common case: the closest
    // vertex is usually one the endpoint is already connected to — its own
    // segment's duplicate copy from the neighbouring tile, a couple of metres
    // away — so the endpoint spends its only stitch on a connection it already
    // had, and the genuine gap just beyond is never bridged. Measured on US-97
    // north of Bend: whole components sat 5.4 m, 6.2 m and 22.3 m apart and
    // stayed unstitched at a 25 m tolerance, which is why raising the tolerance
    // to 60 m changed nothing at all. Distance was never the constraint.
    const MAX_LINKS = 4;
    // A gap between two MAJOR roads is nearly always an artifact of how the
    // tiles were cut, not a real break — a trunk highway does not simply stop
    // for 200 m. US-97 north of Bend has 219 m and 239 m gaps in it, and while
    // they remain the router weaves through side streets instead of taking the
    // highway. Bridging is allowed further between two major roads, and stays
    // tight for everything else so a driveway never fuses to a highway.
    const MAJOR_STITCH = Math.max(stitchMeters, 250);
    // Reject on a degree box BEFORE paying for a haversine.
    //
    // The grid cell is ~250 m, so the ±1-cell scan sweeps a 750 m box and hands
    // several hundred candidates to each endpoint, while the tolerance that
    // actually applies is usually `stitchMeters` — 25 m at z14. Around 99% of
    // the haversines were computed only to be thrown away, and haversine was
    // 40% of the whole build.
    //
    // The box must be strictly WIDER than the true tolerance, or it would
    // reject a pair the haversine would have accepted and silently change the
    // graph. Great-circle distance obeys d >= 111194.93·|Δlat°| and
    // d >= 111194.93·cos(φmax)·|Δlng°|·(1 - Δλ²/24), so dividing the tolerance
    // by the smaller 111194.0 — and, east-west, by a further 0.999 — makes both
    // thresholds larger than any distance the haversine could return. cos is
    // clamped away from zero so a graph reaching the poles degenerates to
    // "never reject" rather than dividing by nothing.
    const DEG_LAT = 111194.0;
    const degLng = DEG_LAT * Math.max(1e-6, Math.cos((maxAbsLat * Math.PI) / 180)) * 0.999;
    const boxLat = [stitchMeters / DEG_LAT, MAJOR_STITCH / DEG_LAT];
    const boxLng = [stitchMeters / degLng, MAJOR_STITCH / degLng];
    const linked = new Set<string>();
    for (const id of endpoints) {
      const bx = Math.floor(lngs[id] / cellLng);
      const by = Math.floor(lats[id] / cellLat);
      const lngA = lngs[id];
      const latA = lats[id];
      const preA = pre[id];
      const maskA = kindMask[id] ?? 0;
      const near: { id: number; m: number }[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const other of grid.get(`${bx + dx},${by + dy}`) ?? []) {
            if (other === id) continue;
            // Already joined through real geometry — nothing to bridge.
            if (pre[other] === preA) continue;
            // The tolerance decides the box, so it has to be known first. Two
            // majors get MAJOR_STITCH, everything else stitchMeters — and since
            // MAJOR_STITCH is never below stitchMeters, testing against that one
            // value is the whole acceptance test.
            const major = maskA & (kindMask[other] ?? 0) & MAJOR ? 1 : 0;
            const dLat = lats[other] - latA;
            if (dLat > boxLat[major] || -dLat > boxLat[major]) continue;
            const dLng = lngs[other] - lngA;
            if (dLng > boxLng[major] || -dLng > boxLng[major]) continue;
            const m = haversine([lngA, latA], [lngs[other], lats[other]]);
            if (m <= (major ? MAJOR_STITCH : stitchMeters)) near.push({ id: other, m });
          }
        }
      }
      near.sort((a, b) => a.m - b.m);
      for (const cand of near.slice(0, MAX_LINKS)) {
        const pair = id < cand.id ? `${id}:${cand.id}` : `${cand.id}:${id}`;
        if (linked.has(pair)) continue;
        linked.add(pair);
        // Free to traverse: this models one road continuing across a tile seam,
        // not a new piece of road.
        linkFrom.push(id);
        linkTo.push(cand.id);
        linkM.push(cand.m);
        extraDeg[id]++;
        extraDeg[cand.id]++;
      }
    }
  }

  // Merge geometry and stitch edges into one CSR.
  //
  // The per-node edge ORDER has to reproduce the old array-of-arrays exactly:
  // every geometry edge in the order its segment and vertex were read, then
  // every stitch edge in the order the stitch pass found it. A* pops equal-f
  // nodes in heap-insertion order, so a different edge order would silently
  // pick a different one of two equally good routes — the same trip would come
  // back with a different line for no reason a user could see.
  const start = new Int32Array(nodeCount + 1);
  for (let v = 0; v < nodeCount; v++)
    start[v + 1] = start[v] + (geomStart[v + 1] - geomStart[v]) + extraDeg[v];
  const edgeCount = nodeCount ? start[nodeCount] : 0;
  const eTo = new Int32Array(edgeCount);
  const eCost = new Float64Array(edgeCount);
  const eMet = new Float64Array(edgeCount);
  const eSeg = new Int32Array(edgeCount);

  const cursor = start.slice(0, nodeCount);
  vp = 0;
  let segIdx = 0;
  for (const s of segs) {
    if (!usable(s)) continue;
    const mult = costMultiplier(s);
    const len = s.coords.length;
    for (let i = 1; i < len; i++) {
      const a = vids[vp + i - 1];
      const b = vids[vp + i];
      if (a !== b) {
        const m = haversine([lngs[a], lats[a]], [lngs[b], lats[b]]);
        let k = cursor[a]++;
        eTo[k] = b;
        eCost[k] = m * mult;
        eMet[k] = m;
        eSeg[k] = segIdx;
        if (!s.oneway) {
          k = cursor[b]++;
          eTo[k] = a;
          eCost[k] = m * mult;
          eMet[k] = m;
          eSeg[k] = segIdx;
        }
      }
    }
    vp += len;
    segIdx++;
  }
  // Each cursor now sits exactly past that node's geometry edges, so walking
  // the link list in discovery order lands the stitch edges where the old code
  // pushed them.
  for (let j = 0; j < linkFrom.length; j++) {
    const a = linkFrom[j];
    const b = linkTo[j];
    const m = linkM[j];
    let k = cursor[a]++;
    eTo[k] = b;
    eCost[k] = m;
    eMet[k] = m;
    eSeg[k] = -1;
    k = cursor[b]++;
    eTo[k] = a;
    eCost[k] = m;
    eMet[k] = m;
    eSeg[k] = -1;
  }

  const { comp, compSize } = labelComponents(start, eTo, nodeCount);
  return new Graph(
    Float64Array.from(lngs),
    Float64Array.from(lats),
    start,
    eTo,
    eCost,
    eMet,
    eSeg,
    meta,
    nodeCount,
    comp,
    compSize
  );
}

function genericName(s: RoadSeg): string {
  if (s.detail === "track") return "forest road";
  if (s.kind === "path") return "trail";
  return "unnamed road";
}

/** Nearest graph node to a point, or -1 if nothing is within maxMeters. */
export function nearestNode(g: RouteGraph, p: [number, number], maxMeters = 1000): number {
  let best = -1;
  let bestM = maxMeters;
  for (let i = 0; i < g.nodeCount; i++) {
    const m = haversine(p, [g.lng[i], g.lat[i]]);
    if (m < bestM) {
      bestM = m;
      best = i;
    }
  }
  return best;
}

/** The `k` nearest nodes within maxMeters, closest first. */
function nearestNodes(
  g: RouteGraph,
  p: [number, number],
  maxMeters: number,
  k: number
): { id: number; m: number }[] {
  const out: { id: number; m: number }[] = [];
  for (let i = 0; i < g.nodeCount; i++) {
    const m = haversine(p, [g.lng[i], g.lat[i]]);
    if (m > maxMeters) continue;
    if (out.length < k) {
      out.push({ id: i, m });
      if (out.length === k) out.sort((a, b) => a.m - b.m);
    } else if (m < out[k - 1].m) {
      out[k - 1] = { id: i, m };
      out.sort((a, b) => a.m - b.m);
    }
  }
  return out.sort((a, b) => a.m - b.m);
}

/**
 * Pick start/goal nodes that can actually reach each other.
 *
 * Snapping each endpoint to its geometrically nearest node fails constantly on
 * real data: this network is fragmented (roughly half to three-quarters of it
 * in the largest component), so a destination often lands on a 100-node stub —
 * a driveway or a clipped fragment — and A* then reports "no route" even
 * though the town is plainly connected. Consider several candidates per end and
 * take the closest pair that share a component.
 */
export function snapPair(
  g: RouteGraph,
  from: [number, number],
  to: [number, number],
  maxMeters: number,
  candidates = 60,
  slackMeters = 250
): { start: number; goal: number; startM: number; goalM: number } | null {
  const a = nearestNodes(g, from, maxMeters, candidates);
  const b = nearestNodes(g, to, maxMeters, candidates);
  if (!a.length || !b.length) return null;

  // Hunting for a *connected* pair means we may end up snapping to something
  // further away than the closest road. That is right when the point sits well
  // off the network (a spot in open country), and badly wrong when the user
  // pointed straight at a road: jumping to a different road hundreds of metres
  // away silently answers a question they didn't ask. Allow generous slack
  // relative to how far the nearest road was anyway, but never an unbounded
  // relocation away from a road that is right there.
  // Pointing within ON_ROAD_M of a road means "this road" — relocating far from
  // it answers a different question. Further out, the point is off-network and
  // reaching the nearest connected road is exactly what's wanted.
  const ON_ROAD_M = 25;
  const allow = (nearest: number) =>
    nearest <= ON_ROAD_M ? Math.max(60, nearest * 4) : Math.max(slackMeters, nearest * 4);
  const maxFrom = Math.min(maxMeters, allow(a[0].m));
  const maxTo = Math.min(maxMeters, allow(b[0].m));

  let best: { start: number; goal: number; startM: number; goalM: number } | null = null;
  let bestScore = Infinity;
  for (const x of a) {
    if (x.m > maxFrom) break; // sorted: everything after is further still
    if (x.m >= bestScore) break; // can't win even with a perfect partner
    for (const y of b) {
      if (y.m > maxTo) break;
      if (g.comp[x.id] !== g.comp[y.id]) continue;
      const score = x.m + y.m;
      if (score < bestScore) {
        bestScore = score;
        best = { start: x.id, goal: y.id, startM: x.m, goalM: y.m };
      }
      break; // b is sorted: the first same-component hit is the closest
    }
  }
  return best;
}

// Binary min-heap keyed by f-score.
class Heap {
  private a: number[] = [];
  private f: Float64Array;
  constructor(size: number) {
    this.f = new Float64Array(size);
  }
  setF(id: number, v: number) {
    this.f[id] = v;
  }
  // The sifts swap with a scalar temp rather than a destructuring swap: the
  // array-literal form allocates a two-element array on every step of every
  // sift, which is the hottest loop A* has.
  push(id: number) {
    const a = this.a;
    const f = this.f;
    a.push(id);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[a[p]] <= f[a[i]]) break;
      const t = a[p];
      a[p] = a[i];
      a[i] = t;
      i = p;
    }
  }
  pop(): number | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const f = this.f;
    const top = a[0];
    const last = a.pop()!;
    const n = a.length;
    if (n) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < n && f[a[l]] < f[a[s]]) s = l;
        if (r < n && f[a[r]] < f[a[s]]) s = r;
        if (s === i) break;
        const t = a[s];
        a[s] = a[i];
        a[i] = t;
        i = s;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

/**
 * A* from `from` to `to`. The heuristic is straight-line distance, which is
 * admissible because the cheapest possible multiplier is 1 (major roads), so
 * it never overestimates the true remaining cost.
 */
export function findRoute(
  g: RouteGraph,
  from: [number, number],
  to: [number, number],
  opts: { snapMeters?: number } = {}
): RouteResult | null {
  const snap = opts.snapMeters ?? 1000;
  const pair = snapPair(g, from, to, snap);
  if (!pair) return null;
  const { start, goal } = pair;
  if (start === goal) return null;

  const n = g.nodeCount;
  // Hoisted: the relax loop below reads five of these per edge, and going
  // through the graph object each time is the difference between a typed-array
  // load and a property lookup.
  const { start: adjStart, eTo, eCost, eSeg, lng, lat } = g;
  const gScore = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const cameEdge = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new Heap(n);
  const goalPt: [number, number] = [lng[goal], lat[goal]];

  gScore[start] = 0;
  heap.setF(start, haversine([lng[start], lat[start]], goalPt));
  heap.push(start);

  while (heap.size) {
    const cur = heap.pop()!;
    if (closed[cur]) continue;
    if (cur === goal) break;
    closed[cur] = 1;
    const gCur = gScore[cur];
    const end = adjStart[cur + 1];
    for (let i = adjStart[cur]; i < end; i++) {
      const to = eTo[i];
      if (closed[to]) continue;
      const tentative = gCur + eCost[i];
      if (tentative < gScore[to]) {
        gScore[to] = tentative;
        cameFrom[to] = cur;
        cameEdge[to] = eSeg[i];
        heap.setF(to, tentative + haversine([lng[to], lat[to]], goalPt));
        heap.push(to);
      }
    }
  }

  if (!Number.isFinite(gScore[goal])) return null;

  // Walk back, then measure and group into steps by road name.
  const nodes: number[] = [];
  for (let v = goal; v !== -1; v = cameFrom[v]) nodes.push(v);
  nodes.reverse();

  const coords: [number, number][] = nodes.map((i) => [g.lng[i], g.lat[i]]);
  let meters = 0;
  let usedTrail = false;
  const steps: RouteStep[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const m = haversine(coords[i - 1], coords[i]);
    meters += m;
    const segIdx = cameEdge[nodes[i]];
    const meta = segIdx >= 0 ? g.segs[segIdx] : null;
    if (meta && meta.kind === "path") usedTrail = true;
    const label = meta?.name ?? "";
    if (!label) continue;
    const last = steps[steps.length - 1];
    if (last && last.name === label) last.meters += m;
    else steps.push({ name: label, meters: m });
  }

  return {
    coords,
    meters,
    steps,
    usedTrail,
    directMeters: haversine(from, to),
    // How far the endpoints were from any usable road — the UI should say so
    // when it's a long walk from where you asked to where the route starts.
    snappedFromM: pair.startM,
    snappedToM: pair.goalM,
  };
}
