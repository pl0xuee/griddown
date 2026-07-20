import { describe, it, expect } from "vitest";
import { buildMvumIndex, samplePath, summariseRoute, MvumIndex } from "../src/mvumindex";
import { mvumClass, formatDates } from "../src/mvum";

// A short east-west forest road near Mt Hood, and a parallel one 2 km north.
const road = (id: string, symbol: string, lat: number, extra = {}) => ({
  type: "Feature",
  properties: { id, symbol, name: `Road ${id}`, ...extra },
  geometry: {
    type: "LineString",
    coordinates: [
      [-121.700, lat],
      [-121.690, lat],
      [-121.680, lat],
    ],
  },
});

const collection = (feats: any[]) => ({ type: "FeatureCollection", features: feats });

const datesFor = (p: Record<string, unknown>) => formatDates(p.passengervehicle_datesopen);

describe("buildMvumIndex", () => {
  it("indexes LineString and MultiLineString alike", () => {
    const idx = buildMvumIndex(
      collection([
        road("101", "1", 45.37),
        {
          type: "Feature",
          properties: { id: "202", symbol: "3" },
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [-121.7, 45.4],
                [-121.69, 45.4],
              ],
              [
                [-121.68, 45.4],
                [-121.67, 45.4],
              ],
            ],
          },
        },
      ])
    );
    expect(idx.size).toBe(2);
  });

  it("survives features with no geometry rather than throwing", () => {
    const idx = buildMvumIndex(
      collection([{ type: "Feature", properties: {}, geometry: null }, road("1", "1", 45.37)])
    );
    expect(idx.size).toBe(1);
  });

  it("is empty for empty or malformed input", () => {
    expect(buildMvumIndex(null).size).toBe(0);
    expect(buildMvumIndex({}).size).toBe(0);
  });
});

describe("MvumIndex.nearest", () => {
  const idx = buildMvumIndex(collection([road("101", "1", 45.37), road("999", "3", 45.39)]));

  it("finds the road under the point", () => {
    expect(idx.nearest(-121.69, 45.37)!.props.id).toBe("101");
  });

  it("picks the closer of two candidates", () => {
    // ~33 m from the northern road, 2 km from the southern one.
    expect(idx.nearest(-121.69, 45.3897)!.props.id).toBe("999");
  });

  it("matches mid-segment, not only near a vertex", () => {
    // The road's vertices are ~780 m apart; this point sits between two of
    // them, which vertex-only matching would miss entirely.
    expect(idx.nearest(-121.695, 45.37, 40)!.props.id).toBe("101");
  });

  // Matching too generously would attribute legal permission to a road you
  // are not actually on — the error that matters here.
  it("returns null when nothing is within the limit", () => {
    expect(idx.nearest(-121.69, 45.5, 40)).toBeNull();
  });

  it("searches neighbouring cells, so a point near a cell edge still matches", () => {
    // 45.37 sits very close to a 0.01° bucket boundary.
    const onEdge = buildMvumIndex(collection([road("101", "1", 45.3700001)]));
    expect(onEdge.nearest(-121.69, 45.3699, 40)).not.toBeNull();
  });
});

describe("samplePath", () => {
  it("drops a sample at least every interval", () => {
    const pts = samplePath(
      [
        [-121.7, 45.37],
        [-121.6, 45.37],
      ],
      1000
    );
    // ~7.8 km at this latitude, so at least 8 samples.
    expect(pts.length).toBeGreaterThanOrEqual(8);
  });

  it("keeps both ends", () => {
    const path: [number, number][] = [
      [-121.7, 45.37],
      [-121.6, 45.37],
    ];
    const pts = samplePath(path, 1000);
    expect(pts[0]).toEqual(path[0]);
    expect(pts[pts.length - 1]).toEqual(path[1]);
  });

  it("handles degenerate paths without hanging", () => {
    expect(samplePath([], 100)).toEqual([]);
    expect(samplePath([[-121.7, 45.37]], 100)).toHaveLength(1);
    // Repeated identical points would divide by zero if not guarded.
    expect(
      samplePath(
        [
          [-121.7, 45.37],
          [-121.7, 45.37],
        ],
        100
      ).length
    ).toBeGreaterThan(0);
  });
});

describe("summariseRoute", () => {
  const route: [number, number][] = [
    [-121.7, 45.37],
    [-121.68, 45.37],
  ];

  it("attributes the distance to the access class", () => {
    const idx = buildMvumIndex(collection([road("101", "1", 45.37)]));
    const s = summariseRoute(route, idx, mvumClass, datesFor);
    expect(s.matchedM).toBeGreaterThan(1000);
    expect(s.unmatchedM).toBeLessThan(200);
    expect(s.byClass[0].label).toBe("Open to all vehicles");
    expect(s.routes[0].id).toBe("101");
  });

  // Nothing nearby must read as unknown, never as permitted.
  it("counts unmatched ground rather than assuming it is open", () => {
    const idx = buildMvumIndex(collection([road("101", "1", 45.50)]));
    const s = summariseRoute(route, idx, mvumClass, datesFor);
    expect(s.matchedM).toBe(0);
    expect(s.unmatchedM).toBeGreaterThan(1000);
    expect(s.byClass).toEqual([]);
  });

  it("reports seasonal routes with their open dates", () => {
    const idx = buildMvumIndex(
      collection([
        road("101", "2", 45.37, {
          seasonal: "seasonal",
          passengervehicle_datesopen: "06/01-10/15",
        }),
      ])
    );
    const s = summariseRoute(route, idx, mvumClass, datesFor);
    expect(s.seasonal).toEqual([{ id: "101", dates: "Jun 1 – Oct 15" }]);
  });

  it("ignores the seasonal flag's stray casing and whitespace", () => {
    const idx = buildMvumIndex(
      collection([road("101", "2", 45.37, { seasonal: "Seasonal " })])
    );
    expect(summariseRoute(route, idx, mvumClass, datesFor).seasonal).toHaveLength(1);
  });

  it("does not call a yearlong route seasonal", () => {
    const idx = buildMvumIndex(collection([road("101", "1", 45.37, { seasonal: "yearlong" })]));
    expect(summariseRoute(route, idx, mvumClass, datesFor).seasonal).toEqual([]);
  });

  it("splits a route that crosses two access classes", () => {
    const idx = buildMvumIndex(
      collection([
        {
          type: "Feature",
          properties: { id: "A", symbol: "1" },
          geometry: {
            type: "LineString",
            coordinates: [
              [-121.7, 45.37],
              [-121.69, 45.37],
            ],
          },
        },
        {
          type: "Feature",
          properties: { id: "B", symbol: "3" },
          geometry: {
            type: "LineString",
            coordinates: [
              [-121.689, 45.37],
              [-121.68, 45.37],
            ],
          },
        },
      ])
    );
    const s = summariseRoute(route, idx, mvumClass, datesFor);
    expect(s.byClass.map((c) => c.label).sort()).toEqual(
      ["Highway-legal vehicles only", "Open to all vehicles"].sort()
    );
    expect(s.routes.map((r) => r.id).sort()).toEqual(["A", "B"]);
  });

  it("lists each route once however many samples hit it", () => {
    const idx = buildMvumIndex(collection([road("101", "1", 45.37)]));
    expect(summariseRoute(route, idx, mvumClass, datesFor).routes).toHaveLength(1);
  });

  it("returns an empty summary for an empty index", () => {
    const s = summariseRoute(route, new MvumIndex(), mvumClass, datesFor);
    expect(s.matchedM).toBe(0);
    expect(s.routes).toEqual([]);
  });
});

describe("multi-part routes", () => {
  // MVUM routes are published as multi-part geometry exactly where they are
  // interrupted — a private inholding, a change of jurisdiction. Flattening the
  // parts and pairing consecutive points drew a phantom segment straight across
  // that gap, so a route crossing it was reported as designated: "unknown"
  // silently became "permitted", which is the one thing this must never do.
  const split = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { id: "500", symbol: "1" },
        geometry: {
          type: "MultiLineString",
          coordinates: [
            [
              [-121.75, 45.37],
              [-121.74, 45.37],
            ],
            [
              [-121.69, 45.37],
              [-121.68, 45.37],
            ],
          ],
        },
      },
    ],
  };

  it("does not match ground in the gap between two parts", () => {
    const idx = buildMvumIndex(split);
    // Dead centre of the ~4 km gap.
    expect(idx.nearest(-121.715, 45.37, 40)).toBeNull();
  });

  it("still matches on each part itself", () => {
    const idx = buildMvumIndex(split);
    expect(idx.nearest(-121.745, 45.37, 40)?.props.id).toBe("500");
    expect(idx.nearest(-121.685, 45.37, 40)?.props.id).toBe("500");
  });

  it("does not attribute the gap to the route's access class", () => {
    const idx = buildMvumIndex(split);
    const across: [number, number][] = [
      [-121.73, 45.37],
      [-121.7, 45.37],
    ];
    const s = summariseRoute(across, idx, mvumClass, datesFor);
    expect(s.matchedM).toBe(0);
    expect(s.unmatchedM).toBeGreaterThan(1000);
  });
});

describe("seasonal agreement with the map", () => {
  // The map dashes on the symbol code; the warning used to require a literal
  // "seasonal" attribute, which the download strips when blank. A route could
  // therefore draw dashed and warn about nothing.
  it("warns on an even symbol code even with no seasonal attribute", () => {
    const idx = buildMvumIndex(
      collection([road("101", "2", 45.37, { passengervehicle_datesopen: "06/01-10/15" })])
    );
    const s = summariseRoute(
      [
        [-121.7, 45.37],
        [-121.68, 45.37],
      ],
      idx,
      mvumClass,
      datesFor
    );
    expect(s.seasonal).toEqual([{ id: "101", dates: "Jun 1 – Oct 15" }]);
  });
});
