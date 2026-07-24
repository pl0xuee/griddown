import { describe, it, expect } from "vitest";
import {
  latLonToUtm,
  utmToLatLon,
  utmZone,
  zoneMeridian,
  gridSpacing,
  gridLines,
  gridLabel,
} from "../src/utm";
import { forward as mgrsForward } from "mgrs";

// The projection is checked against the `mgrs` package, which is already a
// dependency and encodes the same UTM the printed grid must agree with. A grid
// drawn from a wrong projection still looks like a grid — it just doesn't match
// anyone else's map, which is the only thing a grid is for.

const PLACES: Array<[string, number, number]> = [
  ["Mt Hood", 45.3736, -121.696],
  ["Portland", 45.5152, -122.6784],
  ["Miami", 25.7617, -80.1918],
  ["Anchorage", 61.2181, -149.9003],
  ["equator", 0.0001, 10.5],
  ["southern hemisphere", -33.8688, 151.2093],
  ["near a zone edge", 45.0, -119.9999],
];

describe("latLonToUtm against the mgrs package", () => {
  it.each(PLACES)("%s", (_name, lat, lon) => {
    const u = latLonToUtm(lat, lon);
    // "10TER1234567890" — zone, 100km square, then 5 digits each of easting
    // and northing WITHIN that square.
    const s = mgrsForward([lon, lat], 5);
    const m = s.match(/^(\d{1,2})[C-X][A-Z]{2}(\d{5})(\d{5})$/);
    expect(m, `unexpected mgrs output ${s}`).not.toBeNull();
    expect(u.zone).toBe(Number(m![1]));
    // mgrs truncates to the metre; allow a metre of slack either way.
    expect(Math.floor(u.easting) % 100000).toBeCloseTo(Number(m![2]), -0.5);
    expect(Math.floor(u.northing) % 100000).toBeCloseTo(Number(m![3]), -0.5);
  });
});

describe("round trip", () => {
  it.each(PLACES)("%s survives lat/lon → UTM → lat/lon", (_name, lat, lon) => {
    const back = utmToLatLon(latLonToUtm(lat, lon));
    expect(back.lat).toBeCloseTo(lat, 7);
    expect(back.lon).toBeCloseTo(lon, 7);
  });

  it("is accurate to under a centimetre", () => {
    const back = utmToLatLon(latLonToUtm(45.3736, -121.696));
    // 1e-7° of latitude is about 1.1 cm.
    expect(Math.abs(back.lat - 45.3736)).toBeLessThan(1e-7);
  });
});

describe("zones", () => {
  it("puts longitudes in the right zone", () => {
    expect(utmZone(-121.7)).toBe(10);
    expect(utmZone(-120.0)).toBe(11); // boundary belongs to the east
    expect(utmZone(-180)).toBe(1);
    expect(utmZone(179.9)).toBe(60);
  });

  it("gives each zone its central meridian", () => {
    expect(zoneMeridian(10)).toBe(-123);
    expect(zoneMeridian(1)).toBe(-177);
    expect(zoneMeridian(60)).toBe(177);
  });

  // A map spanning a zone boundary must stay on one grid, or the lines jump
  // sideways mid-page and no reference read off it is trustworthy.
  it("honours a forced zone across a boundary", () => {
    const natural = latLonToUtm(45, -119.5);
    const forced = latLonToUtm(45, -119.5, 10);
    expect(natural.zone).toBe(11);
    expect(forced.zone).toBe(10);
    // Forced into the neighbouring zone the easting runs past the 500 km
    // central meridian, which is exactly what an extended grid does.
    expect(forced.easting).toBeGreaterThan(natural.easting);
    expect(utmToLatLon(forced).lon).toBeCloseTo(-119.5, 6);
  });

  it("handles the southern hemisphere's false northing", () => {
    const u = latLonToUtm(-33.8688, 151.2093);
    expect(u.north).toBe(false);
    expect(u.northing).toBeGreaterThan(6_000_000); // 10,000,000 − ~3.75M
    expect(utmToLatLon(u).lat).toBeCloseTo(-33.8688, 7);
  });
});

describe("gridSpacing", () => {
  it("keeps the number of lines readable at any scale", () => {
    // A page covering 8 km wants 1 km squares; one covering 400 km does not.
    expect(gridSpacing(8000)).toBe(1000);
    expect(gridSpacing(400_000)).toBe(50000);
    expect(gridSpacing(900)).toBe(100);
  });

  it("only ever returns round, readable spacings", () => {
    for (let w = 500; w < 500_000; w += 977) {
      expect([100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000]).toContain(
        gridSpacing(w)
      );
    }
  });
});

describe("gridLines", () => {
  const bounds = { west: -121.8, south: 45.3, east: -121.6, north: 45.45 };

  it("returns lines on both axes covering the box", () => {
    const lines = gridLines(bounds, 1000);
    expect(lines.some((l) => l.axis === "easting")).toBe(true);
    expect(lines.some((l) => l.axis === "northing")).toBe(true);
  });

  it("spaces the lines by exactly the requested interval", () => {
    const eastings = gridLines(bounds, 1000)
      .filter((l) => l.axis === "easting")
      .map((l) => l.value)
      .sort((a, b) => a - b);
    for (let i = 1; i < eastings.length; i++) {
      expect(eastings[i] - eastings[i - 1]).toBeCloseTo(1000, 6);
    }
    // Every line sits on a round multiple, which is what makes it readable.
    for (const e of eastings) expect(e % 1000).toBeCloseTo(0, 6);
  });

  it("draws lines as polylines, not straight segments", () => {
    // The bend IS grid convergence. A two-point line would discard it.
    const line = gridLines(bounds, 1000)[0];
    expect(line.points.length).toBeGreaterThan(2);
  });

  it("covers the whole box rather than clipping a corner", () => {
    // A lat/long box is not a UTM box; using two corners loses one side.
    const lines = gridLines(bounds, 1000).filter((l) => l.axis === "northing");
    const lats = lines.flatMap((l) => l.points.map((p) => p[1]));
    expect(Math.min(...lats)).toBeLessThanOrEqual(bounds.south + 0.01);
    expect(Math.max(...lats)).toBeGreaterThanOrEqual(bounds.north - 0.01);
  });

  it("produces nothing absurd for a tiny box", () => {
    const tiny = { west: -121.7, south: 45.37, east: -121.699, north: 45.371 };
    expect(gridLines(tiny, 1000).length).toBeLessThan(6);
  });
});

describe("gridLabel", () => {
  // A reference is read as the two digits within the 100 km square: a line at
  // easting 567000 is "67", the number a map user says on the radio.
  it("gives the two digits used in a six-figure reference", () => {
    expect(gridLabel(567000, 1000)).toBe("67");
    expect(gridLabel(500000, 1000)).toBe("00");
    expect(gridLabel(4_509_000, 1000)).toBe("09");
  });

  it("uses three digits at finer spacings", () => {
    expect(gridLabel(567300, 100)).toBe("673");
  });

  it("switches to whole 100 km squares at the coarsest spacing", () => {
    expect(gridLabel(500000, 100000)).toBe("5");
  });

  /**
   * A view straddling the equator is projected into ONE hemisphere, so the
   * other side's northings come out genuinely negative. A raw `%` left the sign
   * on ("-40"), and `Math.floor` on a negative rounded away from zero, putting
   * the line one whole square out — a label that is wrong rather than missing.
   *
   * Hand-worked: -33205 sits 33205 m below a 100 km boundary, so it is 66795 m
   * ABOVE the one below that; 66795 / 1000 floors to 66. Exactly -10000 is
   * 90000 m into its square, so 90. The northern equivalents agree: labelling
   * -33205 and 66795 must give the same digits, because they are the same line.
   */
  it("labels a negative northing by its position within the square", () => {
    expect(gridLabel(-33205, 10000)).toBe("66");
    expect(gridLabel(-10000, 1000)).toBe("90");
    expect(gridLabel(-1, 1000)).toBe("99");
    expect(gridLabel(-100000, 1000)).toBe("00");
    expect(gridLabel(-33205, 100)).toBe("667");
  });

  it("gives a negative northing the same digits as its positive twin", () => {
    // -33205 and 66795 are 100 km apart, so they carry the same two digits.
    expect(gridLabel(-33205, 1000)).toBe(gridLabel(66795, 1000));
    expect(gridLabel(-450000, 1000)).toBe(gridLabel(550000, 1000));
  });

  it("never prints a minus sign inside a 100 km square", () => {
    for (let v = -250000; v <= 250000; v += 1234) {
      expect(gridLabel(v, 1000)).toMatch(/^\d{2}$/);
      expect(gridLabel(v, 100)).toMatch(/^\d{3}$/);
    }
  });
});

describe("refusing to draw a grid that would lie", () => {
  // The Redfearn series is an expansion about the zone's central meridian:
  // exact inside the zone, degrading fast outside it (measured on this
  // implementation: ~5.7 m at 12°, 463 m at 22°, 8.4 km at 32°). A grid drawn
  // that far out still LOOKS like a grid while naming ground hundreds of
  // metres away, which is worse than no grid at all.
  it("draws nothing for a view spanning many zones", () => {
    const conus = { west: -125, south: 24, east: -66, north: 49 };
    expect(gridLines(conus, 50000)).toEqual([]);
  });

  it("draws nothing for the Alaska pack's full width", () => {
    // A real bbox from states.json, ~40° wide.
    expect(gridLines({ west: -170, south: 54, east: -130, north: 71 }, 50000)).toEqual([]);
  });

  it("still draws for a normal state-sized view", () => {
    expect(gridLines({ west: -122.8, south: 45.2, east: -121.4, north: 45.8 }, 1000).length)
      .toBeGreaterThan(4);
  });

  it("draws nothing across the antimeridian, where west > east", () => {
    expect(gridLines({ west: 179, south: 50, east: -179, north: 52 }, 10000)).toEqual([]);
  });

  it("draws nothing for an inverted or empty box", () => {
    expect(gridLines({ west: -121, south: 46, east: -122, north: 45 }, 1000)).toEqual([]);
  });

  // Straddling the equator once mixed offset and un-offset northings, giving
  // 988 lines instead of ~14 and putting southern lines at ~88°N.
  it("stays sane across the equator", () => {
    const lines = gridLines({ west: -78.5, south: -1, east: -77.5, north: 1 }, 10000);
    expect(lines.length).toBeLessThan(40);
    for (const l of lines) {
      for (const [, lat] of l.points) expect(Math.abs(lat)).toBeLessThan(5);
    }
  });

  it("keeps one hemisphere for the whole grid", () => {
    const a = latLonToUtm(-0.5, -77.9, 18, true);
    const b = latLonToUtm(0.5, -77.9, 18, true);
    // Both forced north: the southern point's northing is negative, not
    // 10,000,000 m away from its neighbour.
    expect(Math.abs(b.northing - a.northing)).toBeLessThan(200_000);
  });
});
