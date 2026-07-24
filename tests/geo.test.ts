import { describe, it, expect } from "vitest";
import { bearing, cardinal, EARTH_R, haversine, type LL } from "../src/geo";

/**
 * The shared geodesic maths. Everything that reports a distance goes through
 * here — mesh range, MVUM mileage, track length, the measure tool, the terrain
 * profile's sample spacing — and none of it had a direct test: `haversine` was
 * only ever reached through assertions loose enough that deleting the
 * `cos(lat)·cos(lat)` factor left the whole suite green, while inflating every
 * east-west distance by 41% at latitude 45.
 *
 * Expected values below are derived independently of this module: by the
 * spherical LAW OF COSINES (a different formula from the half-versine one under
 * test) on a SPHERE of radius EARTH_R = 6378137 m — the WGS84 *equatorial*
 * radius geo.ts uses, NOT the 6371000 m mean radius most published tables
 * assume. That distinction is worth ~0.11%: 1° of longitude at latitude 45 is
 * 78714 m here and 78626 m on the mean-radius sphere.
 *
 * Sanity-checked against Vincenty on the WGS84 ellipsoid, which is a wholly
 * different algorithm on a wholly different figure: it gives 194550 m and
 * 145.84° for Portland–Bend against the 194684 m / 145.93° asserted here
 * (0.07% and 0.09°), and 78846 m for the east-west degree (0.17%).
 */

const PORTLAND: LL = [-122.6784, 45.5152];
const BEND: LL = [-121.3153, 44.0582];

/** Assert `got` is within `pct` percent of `want`. */
function within(got: number, want: number, pct: number) {
  expect(Math.abs(got - want) / Math.abs(want)).toBeLessThan(pct / 100);
}

describe("haversine", () => {
  it("uses the equatorial radius, so a degree of latitude is R·π/180", () => {
    // With no change of longitude the formula collapses to 2R·asin(sin(Δφ/2)) =
    // R·Δφ, i.e. 6378137 × π/180 = 111319.4908 m — hand-derivable, exact, and
    // the same at every latitude on a sphere.
    expect(EARTH_R).toBe(6378137);
    for (const lat of [0, 30, 45, 60]) {
      expect(haversine([-121, lat], [-121, lat + 1])).toBeCloseTo(111319.4908, 3);
    }
  });

  it("shrinks an east-west degree by the cosine of the latitude", () => {
    // THE case that dies when the cos·cos term is dropped: without it every one
    // of these returns the full 111319 m. 1° of longitude spans a whole degree
    // of arc only on the equator.
    within(haversine([-0.5, 0], [0.5, 0]), 111319.49, 0.5);
    within(haversine([-0.5, 30], [0.5, 30]), 96405.2, 0.5);
    within(haversine([-0.5, 45], [0.5, 45]), 78714.27, 0.5);
    within(haversine([-0.5, 60], [0.5, 60]), 55659.22, 0.5);
  });

  it("measures a real baseline: Portland to Bend is 194.7 km", () => {
    // ~121 statute miles, which is the figure any chart gives for these two.
    within(haversine(PORTLAND, BEND), 194683.9, 0.5);
  });

  it("is symmetric and zero for a point against itself", () => {
    expect(haversine(PORTLAND, PORTLAND)).toBe(0);
    expect(haversine(PORTLAND, BEND)).toBeCloseTo(haversine(BEND, PORTLAND), 6);
  });

  it("stays accurate at the scale a measure tool is used at", () => {
    // 100 m due north: 100 / 111319.4908 degrees of latitude.
    const d = 100 / 111319.4908;
    expect(haversine([-121, 45], [-121, 45 + d])).toBeCloseTo(100, 3);
    // And 100 m due east at latitude 45 needs that same 100 m divided by the
    // shortened east-west degree.
    const e = 100 / 78714.27;
    within(haversine([-121, 45], [-121 + e, 45]), 100, 0.5);
  });
});

describe("bearing", () => {
  it("gives the four cardinal directions exactly", () => {
    expect(bearing([-121, 44], [-121, 45])).toBeCloseTo(0, 9);
    expect(bearing([-121, 45], [-121, 44])).toBeCloseTo(180, 9);
    expect(bearing([0, 0], [1, 0])).toBeCloseTo(90, 9);
    expect(bearing([0, 0], [-1, 0])).toBeCloseTo(270, 9);
  });

  it("starts a little north of due east on a great circle away from the equator", () => {
    // Heading "east" along latitude 45 is not a great circle: the shortest path
    // bulges poleward, so the INITIAL bearing is under 90°. Getting this back as
    // exactly 90 would mean the formula had lost its latitude terms.
    expect(bearing([-0.5, 45], [0.5, 45])).toBeCloseTo(89.6464, 3);
    expect(bearing([0.5, 45], [-0.5, 45])).toBeCloseTo(270.3536, 3);
  });

  it("points Portland at Bend, and back", () => {
    expect(bearing(PORTLAND, BEND)).toBeCloseTo(145.934, 2);
    expect(bearing(BEND, PORTLAND)).toBeCloseTo(326.894, 2);
  });

  it("is always in 0–360, never negative", () => {
    for (let lng = -180; lng < 180; lng += 17) {
      const b = bearing([0, 0], [lng + 0.0001, 0.5]);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });
});

describe("cardinal", () => {
  // geo.ts carries its own copy of this table (compass.ts has the other), so it
  // needs its own check.
  it("names the point a bearing falls in", () => {
    expect(cardinal(0)).toBe("N");
    expect(cardinal(90)).toBe("E");
    expect(cardinal(100)).toBe("E");
    expect(cardinal(180)).toBe("S");
    expect(cardinal(270)).toBe("W");
    expect(cardinal(-90)).toBe("W");
    expect(cardinal(360)).toBe("N");
  });

  it("describes the Portland–Bend leg as southeast", () => {
    expect(cardinal(bearing(PORTLAND, BEND))).toBe("SE");
  });
});
