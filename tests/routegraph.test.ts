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
