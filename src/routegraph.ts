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

export interface RouteGraph {
  lng: Float64Array;
  lat: Float64Array;
  adj: Edge[][];
  segs: { name: string; kind: string; detail: string }[];
  nodeCount: number;
  /** Connected-component id per node. */
  comp: Int32Array;
  /** Node count of each component, indexed by component id. */
  compSize: number[];
}

/** Label every node with its connected component (undirected reachability). */
function labelComponents(adj: Edge[][], nodeCount: number) {
  const comp = new Int32Array(nodeCount).fill(-1);
  const compSize: number[] = [];
  // Oneways make the graph directed; for *reachability* grouping we want the
  // undirected view, so build a reverse adjacency on the fly.
  const back: number[][] = Array.from({ length: nodeCount }, () => []);
  for (let v = 0; v < nodeCount; v++) for (const e of adj[v]) back[e.to].push(v);
  for (let s = 0; s < nodeCount; s++) {
    if (comp[s] !== -1) continue;
    const id = compSize.length;
    let size = 0;
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const v = stack.pop()!;
      size++;
      for (const e of adj[v]) if (comp[e.to] === -1) { comp[e.to] = id; stack.push(e.to); }
      for (const w of back[v]) if (comp[w] === -1) { comp[w] = id; stack.push(w); }
    }
    compSize.push(size);
  }
  return { comp, compSize };
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
  const ids = new Map<string, number>();
  const lngs: number[] = [];
  const lats: number[] = [];
  const adj: Edge[][] = [];
  const meta: { name: string; kind: string; detail: string }[] = [];

  const idOf = (c: [number, number]) => {
    const k = `${c[0].toFixed(SNAP_DP)},${c[1].toFixed(SNAP_DP)}`;
    let id = ids.get(k);
    if (id === undefined) {
      id = lngs.length;
      ids.set(k, id);
      lngs.push(c[0]);
      lats.push(c[1]);
      adj.push([]);
    }
    return id;
  };

  const endpoints: number[] = [];
  // Road classes touching each node, as a bitmask. A node can belong to several
  // segments, so this must accumulate rather than record only the last one.
  const MAJOR = 1;
  const kindMask: number[] = [];
  const maskOf = (kind: string) => (kind === "major_road" ? MAJOR : kind === "minor_road" ? 2 : 4);
  for (const s of segs) {
    if (!isRoutable(s.kind, s.detail) || s.coords.length < 2) continue;
    const mult = costMultiplier(s);
    const segIdx = meta.length;
    meta.push({
      name: s.ref || s.name || genericName(s),
      kind: s.kind,
      detail: s.detail,
    });
    const km = maskOf(s.kind);
    let prev = idOf(s.coords[0]);
    kindMask[prev] = (kindMask[prev] ?? 0) | km;
    endpoints.push(prev);
    for (let i = 1; i < s.coords.length; i++) {
      const cur = idOf(s.coords[i]);
      kindMask[cur] = (kindMask[cur] ?? 0) | km;
      if (cur !== prev) {
        const m = haversine([lngs[prev], lats[prev]], [lngs[cur], lats[cur]]);
        adj[prev].push({ to: cur, cost: m * mult, meters: m, seg: segIdx });
        // A oneway is traversable only in geometry order.
        if (!s.oneway) adj[cur].push({ to: prev, cost: m * mult, meters: m, seg: segIdx });
      }
      prev = cur;
    }
    endpoints.push(prev);
  }

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
  if (stitchMeters > 0 && endpoints.length) {
    const cell = Math.max(stitchMeters, 250) / 111320; // rough degrees
    const grid = new Map<string, number[]>();
    for (let id = 0; id < lngs.length; id++) {
      const k = `${Math.floor(lngs[id] / cell)},${Math.floor(lats[id] / cell)}`;
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
    const tolFor = (a: number, b: number) =>
      (kindMask[a] ?? 0) & (kindMask[b] ?? 0) & MAJOR ? MAJOR_STITCH : stitchMeters;
    const reach = Math.max(stitchMeters, MAJOR_STITCH);
    const linked = new Set<string>();
    for (const id of endpoints) {
      const bx = Math.floor(lngs[id] / cell);
      const by = Math.floor(lats[id] / cell);
      const near: { id: number; m: number }[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const other of grid.get(`${bx + dx},${by + dy}`) ?? []) {
            if (other === id) continue;
            // Already joined through real geometry — nothing to bridge.
            if (adj[id].some((e) => e.to === other)) continue;
            const m = haversine([lngs[id], lats[id]], [lngs[other], lats[other]]);
            if (m <= reach && m <= tolFor(id, other)) near.push({ id: other, m });
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
        adj[id].push({ to: cand.id, cost: cand.m, meters: cand.m, seg: -1 });
        adj[cand.id].push({ to: id, cost: cand.m, meters: cand.m, seg: -1 });
      }
    }
  }

  const { comp, compSize } = labelComponents(adj, lngs.length);
  return {
    lng: Float64Array.from(lngs),
    lat: Float64Array.from(lats),
    adj,
    segs: meta,
    nodeCount: lngs.length,
    comp,
    compSize,
  };
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
  push(id: number) {
    this.a.push(id);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[this.a[p]] <= this.f[this.a[i]]) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop(): number | undefined {
    if (!this.a.length) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < this.a.length && this.f[this.a[l]] < this.f[this.a[s]]) s = l;
        if (r < this.a.length && this.f[this.a[r]] < this.f[this.a[s]]) s = r;
        if (s === i) break;
        [this.a[s], this.a[i]] = [this.a[i], this.a[s]];
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
  const gScore = new Float64Array(n).fill(Infinity);
  const cameFrom = new Int32Array(n).fill(-1);
  const cameEdge = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new Heap(n);
  const goalPt: [number, number] = [g.lng[goal], g.lat[goal]];

  gScore[start] = 0;
  heap.setF(start, haversine([g.lng[start], g.lat[start]], goalPt));
  heap.push(start);

  while (heap.size) {
    const cur = heap.pop()!;
    if (closed[cur]) continue;
    if (cur === goal) break;
    closed[cur] = 1;
    for (const e of g.adj[cur]) {
      if (closed[e.to]) continue;
      const tentative = gScore[cur] + e.cost;
      if (tentative < gScore[e.to]) {
        gScore[e.to] = tentative;
        cameFrom[e.to] = cur;
        cameEdge[e.to] = e.seg;
        heap.setF(e.to, tentative + haversine([g.lng[e.to], g.lat[e.to]], goalPt));
        heap.push(e.to);
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
