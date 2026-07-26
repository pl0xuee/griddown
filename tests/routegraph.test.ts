import { describe, it, expect } from "vitest";
import {
  buildRouteGraph,
  findRoute,
  isRoutable,
  costMultiplier,
  haversine,
  type RoadSeg,
} from "../src/routegraph";

// A small grid of streets near Bend, OR. 0.001° ≈ 111 m north/south.
const A: [number, number] = [-121.31, 44.06];
const road = (
  coords: [number, number][],
  extra: Partial<RoadSeg> = {}
): RoadSeg => ({ coords, kind: "minor_road", detail: "residential", ...extra });

describe("isRoutable", () => {
  it("excludes rail and aeroway however the geometry looks", () => {
    // Routing someone down a railway or a runway is the failure this prevents.
    expect(isRoutable("rail", "rail")).toBe(false);
    expect(isRoutable("aeroway", "runway")).toBe(false);
    expect(isRoutable("major_road", "primary")).toBe(true);
    expect(isRoutable("path", "track")).toBe(true);
  });
});

describe("costMultiplier", () => {
  it("prefers real roads over trails", () => {
    expect(costMultiplier({ kind: "major_road", detail: "primary" })).toBeLessThan(
      costMultiplier({ kind: "minor_road", detail: "residential" })
    );
    expect(costMultiplier({ kind: "minor_road", detail: "residential" })).toBeLessThan(
      costMultiplier({ kind: "path", detail: "track" })
    );
    expect(costMultiplier({ kind: "path", detail: "track" })).toBeLessThan(
      costMultiplier({ kind: "path", detail: "footway" })
    );
  });
});

describe("buildRouteGraph", () => {
  it("joins two roads that share a junction vertex", () => {
    const mid: [number, number] = [A[0] + 0.002, A[1]];
    const g = buildRouteGraph([
      road([A, mid]),
      road([mid, [A[0] + 0.002, A[1] + 0.002]]),
    ]);
    const r = findRoute(g, A, [A[0] + 0.002, A[1] + 0.002]);
    expect(r).not.toBeNull();
    expect(r!.meters).toBeGreaterThan(0);
  });

  it("does NOT connect an overpass to the road beneath it", () => {
    // Two ways crossing at the same lng/lat but never sharing a vertex — a
    // bridge over a highway. A coarse global snap would fuse them and invent a
    // turn; endpoint-only stitching must not.
    const ns = road([
      [A[0], A[1] - 0.002],
      [A[0], A[1] + 0.002],
    ]);
    const ew = road(
      [
        [A[0] - 0.002, A[1]],
        [A[0] + 0.002, A[1]],
      ],
      { bridge: true }
    );
    const g = buildRouteGraph([ns, ew]);
    // Travelling the north-south road must not reach the east-west road.
    const r = findRoute(g, [A[0], A[1] - 0.002], [A[0] + 0.002, A[1]]);
    expect(r).toBeNull();
  });

  it("stitches endpoints split across a tile boundary", () => {
    // The same road clipped into two pieces, endpoints ~3 m apart.
    const cut: [number, number] = [A[0] + 0.002, A[1]];
    const cutJitter: [number, number] = [cut[0] + 0.00003, cut[1]];
    expect(haversine(cut, cutJitter)).toBeLessThan(8);
    const g = buildRouteGraph([road([A, cut]), road([cutJitter, [A[0] + 0.004, A[1]]])]);
    const r = findRoute(g, A, [A[0] + 0.004, A[1]]);
    expect(r).not.toBeNull();
  });

  it("leaves genuinely separate roads unstitched", () => {
    const g = buildRouteGraph([
      road([A, [A[0] + 0.001, A[1]]]),
      // ~220 m away — far beyond the stitch tolerance
      road([[A[0] + 0.003, A[1]], [A[0] + 0.004, A[1]]]),
    ]);
    expect(findRoute(g, A, [A[0] + 0.004, A[1]])).toBeNull();
  });

  it("respects oneway direction", () => {
    const b: [number, number] = [A[0] + 0.002, A[1]];
    const g = buildRouteGraph([road([A, b], { oneway: true })]);
    expect(findRoute(g, A, b)).not.toBeNull();
    expect(findRoute(g, b, A)).toBeNull(); // can't drive it backwards
  });

  /**
   * The stitch pass exists only to bridge pieces that are DISCONNECTED. It used
   * to exclude nothing but an endpoint's direct neighbours, so an endpoint
   * handed itself free bidirectional shortcuts to the other vertices of its own
   * segment: corners cut off curves, distance under-reported, and — because a
   * stitch edge is added in both directions — a oneway that could be driven
   * backwards by hopping along the shortcuts.
   *
   * A single major road is the sharp case: two major roads may be bridged up to
   * 250 m apart, and consecutive vertices of a real road are far closer than
   * that, so every vertex of a curve was in range of every other.
   */
  const N = (i: number): [number, number] => [A[0], A[1] + 0.001 * i];

  it("never stitches a lone road to itself", () => {
    // Four vertices ~111 m apart: well inside the 250 m major-road reach, so
    // they were all mutual stitch candidates.
    const g = buildRouteGraph([
      road([N(0), N(1), N(2), N(3)], { kind: "major_road", detail: "primary", oneway: true }),
    ]);
    expect(haversine(N(0), N(2))).toBeLessThan(250); // in reach, as intended
    expect(g.nodeCount).toBe(4);

    // seg === -1 marks a stitch edge. One road needs no bridging at all.
    const stitched = g.adj.flat().filter((e) => e.seg === -1);
    expect(stitched).toEqual([]);

    // Exactly the three forward edges the geometry describes, and nothing else.
    expect(g.adj.map((es) => es.map((e) => e.to))).toEqual([[1], [2], [3], []]);
  });

  it("cannot drive a lone oneway backwards via its own stitch edges", () => {
    const g = buildRouteGraph([
      road([N(0), N(1), N(2), N(3)], { kind: "major_road", detail: "primary", oneway: true }),
    ]);
    expect(findRoute(g, N(0), N(3))).not.toBeNull(); // forwards is fine
    expect(findRoute(g, N(3), N(0))).toBeNull(); // backwards must not exist
  });

  it("does not cut the corner off a curve", () => {
    // A right-angle dogleg. Its two ends are ~157 m apart — inside the major
    // reach — so a self-stitch would offer a diagonal shortcut that is not a
    // road, and the reported distance would come out short.
    const corner: [number, number] = [A[0] + 0.001, A[1] + 0.001];
    const end: [number, number] = [A[0] + 0.001, A[1]];
    const g = buildRouteGraph([
      road([A, corner, end], { kind: "major_road", detail: "primary" }),
    ]);
    expect(haversine(A, end)).toBeLessThan(250);
    const r = findRoute(g, A, end)!;
    expect(r).not.toBeNull();
    // Both legs, not the hypotenuse: ~111 m + ~80 m, versus ~80 m direct.
    expect(r.meters).toBeCloseTo(haversine(A, corner) + haversine(corner, end), 6);
    expect(r.coords).toHaveLength(3);
  });

  it("still bridges two separate major-road pieces a couple of hundred metres apart", () => {
    // The feature the fix must not have disabled: US-97 north of Bend arrives
    // from the tiles with 219 m and 239 m holes in it, and while they remain the
    // router weaves through side streets instead of taking the highway.
    const major = { kind: "major_road", detail: "primary" };
    const g = buildRouteGraph([
      road([N(0), N(1)], major),
      road([N(3), N(4)], major),
    ]);
    expect(haversine(N(1), N(3))).toBeGreaterThan(200);
    expect(haversine(N(1), N(3))).toBeLessThan(250);

    expect(g.adj.flat().filter((e) => e.seg === -1).length).toBeGreaterThan(0);
    expect(findRoute(g, N(0), N(4))).not.toBeNull();
  });

  it("does not extend that allowance to minor roads", () => {
    // 222 m between two residential streets is a real gap, not a tile seam.
    const g = buildRouteGraph([road([N(0), N(1)]), road([N(3), N(4)])]);
    expect(g.adj.flat().filter((e) => e.seg === -1)).toEqual([]);
    expect(findRoute(g, N(0), N(4))).toBeNull();
  });
});

describe("findRoute", () => {
  it("prefers a slightly longer road over a shorter trail", () => {
    // Direct trail A->C, versus a dogleg on real roads A->B->C.
    const c: [number, number] = [A[0] + 0.004, A[1]];
    const b: [number, number] = [A[0] + 0.002, A[1] + 0.0005];
    const g = buildRouteGraph([
      road([A, c], { kind: "path", detail: "path" }),
      road([A, b], { kind: "major_road", detail: "secondary" }),
      road([b, c], { kind: "major_road", detail: "secondary" }),
    ]);
    const r = findRoute(g, A, c)!;
    expect(r).not.toBeNull();
    expect(r.usedTrail).toBe(false);
    // It took the dogleg, so it's longer than the straight trail.
    expect(r.meters).toBeGreaterThan(haversine(A, c));
  });

  it("falls back to a trail when no road connects, and flags it", () => {
    const c: [number, number] = [A[0] + 0.004, A[1]];
    const g = buildRouteGraph([road([A, c], { kind: "path", detail: "track" })]);
    const r = findRoute(g, A, c)!;
    expect(r).not.toBeNull();
    expect(r.usedTrail).toBe(true);
  });

  it("groups consecutive same-named ways into one step", () => {
    const b: [number, number] = [A[0] + 0.002, A[1]];
    const c: [number, number] = [A[0] + 0.004, A[1]];
    const d: [number, number] = [A[0] + 0.004, A[1] + 0.002];
    const g = buildRouteGraph([
      road([A, b], { name: "Cascade Ave" }),
      road([b, c], { name: "Cascade Ave" }),
      road([c, d], { name: "Pine St" }),
    ]);
    const r = findRoute(g, A, d)!;
    expect(r.steps.map((s) => s.name)).toEqual(["Cascade Ave", "Pine St"]);
    expect(r.steps[0].meters).toBeGreaterThan(r.steps[1].meters * 0.5);
  });

  it("returns null rather than guessing when the endpoint is far from any road", () => {
    const g = buildRouteGraph([road([A, [A[0] + 0.002, A[1]]])]);
    // ~2 km away, well beyond the snap radius
    expect(findRoute(g, A, [A[0] + 0.03, A[1]], { snapMeters: 300 })).toBeNull();
  });

  it("reports straight-line distance alongside the route distance", () => {
    const b: [number, number] = [A[0] + 0.002, A[1] + 0.002];
    const g = buildRouteGraph([
      road([A, [A[0] + 0.002, A[1]]]),
      road([[A[0] + 0.002, A[1]], b]),
    ]);
    const r = findRoute(g, A, b)!;
    expect(r.directMeters).toBeLessThan(r.meters); // dogleg is longer
    expect(r.directMeters).toBeCloseTo(haversine(A, b), 5);
  });
});

describe("divided highways", () => {
  // Two opposing one-way carriageways of the same road, 40 m apart, is what a
  // divided highway IS — and each one is its own component, because no geometry
  // joins them. The stitch pass bridges two major roads up to 250 m, to any
  // vertex, bidirectionally, which fused them into a single two-way road: the
  // route came back crossing the median twice and travelling north up the
  // southbound side.
  const dLat = 0.00036; // ~40 m
  const nb = (n: number): [number, number] => [A[0] + n * 0.004, A[1]];
  const sb = (n: number): [number, number] => [A[0] + n * 0.004, A[1] + dLat];

  const carriageways = () => [
    road([nb(0), nb(1), nb(2)], { kind: "major_road", detail: "motorway", oneway: true }),
    // Southbound runs the other way: its geometry order is reversed.
    road([sb(2), sb(1), sb(0)], { kind: "major_road", detail: "motorway", oneway: true }),
  ];

  it("does not let a route hop to the other carriageway", () => {
    const g = buildRouteGraph(carriageways());
    // Backwards along the southbound side. There is no legal way to do this.
    expect(findRoute(g, sb(0), sb(2))).toBeNull();
  });

  it("still routes the legal direction on each side", () => {
    const g = buildRouteGraph(carriageways());
    expect(findRoute(g, nb(0), nb(2))).not.toBeNull();
    expect(findRoute(g, sb(2), sb(0))).not.toBeNull();
  });

  it("still bridges a genuine seam in a one-way road", () => {
    // The same one-way road cut across a tile boundary, with a 200 m gap. Head
    // to tail, same direction — this is what the major-road allowance is for.
    const gap = 0.0018;
    const g = buildRouteGraph([
      road([nb(0), nb(1)], { kind: "major_road", detail: "motorway", oneway: true }),
      road(
        [[nb(1)[0] + gap, nb(1)[1]], [nb(2)[0] + gap, nb(2)[1]]],
        { kind: "major_road", detail: "motorway", oneway: true }
      ),
    ]);
    expect(findRoute(g, nb(0), [nb(2)[0] + gap, nb(2)[1]])).not.toBeNull();
  });
});

describe("a destination on the wrong side of a oneway", () => {
  // Components are labelled on the UNDIRECTED view, because that is what
  // "reachable" means before oneways are considered. snapPair then committed to
  // the closest pair sharing a component and A* answered "no route" — while a
  // node 160 m from the destination was perfectly reachable. That is the far
  // carriageway of a divided highway, or the far side of a one-way exit ramp.
  const P = (n: number): [number, number] => [A[0] + n * 0.002, A[1]];

  const g = () =>
    buildRouteGraph([
      road([P(0), P(1), P(2)], { oneway: true }),
      road([P(2), P(3), P(4)]),
    ]);

  it("routes to the nearest place it can actually reach", () => {
    const r = findRoute(g(), P(4), P(1));
    expect(r).not.toBeNull();
    // It stopped short rather than pretending to arrive, and says how short.
    expect(r!.snappedToM).toBeGreaterThan(100);
    expect(r!.snappedToM).toBeLessThan(300);
  });

  it("still answers null when nothing is reachable at all", () => {
    const far: [number, number] = [A[0] + 5, A[1] + 5];
    expect(findRoute(g(), P(4), far)).toBeNull();
  });

  it("does not relocate when the direct route exists", () => {
    const r = findRoute(g(), P(0), P(4));
    expect(r).not.toBeNull();
    expect(r!.snappedFromM).toBeLessThan(1);
    expect(r!.snappedToM).toBeLessThan(1);
  });
});
