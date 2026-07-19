import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  magneticField,
  declination,
  decimalYear,
  magneticToTrue,
  trueToMagnetic,
  formatDeclination,
  modelValidFor,
} from "../src/geomag";

// NOAA ships 100 official test values with WMM2025 precisely so an
// implementation can prove itself. If these pass, the spherical harmonics, the
// geodetic conversion and the secular variation are all right; if any fails,
// the compass would be quietly lying about north.
const FIXTURE = join(process.cwd(), "tests/fixtures/wmm2025-testvalues.txt");

interface Row {
  year: number;
  altKm: number;
  lat: number;
  lon: number;
  dec: number;
  inc: number;
  f: number;
}

function testValues(): Row[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => {
      const v = l.trim().split(/\s+/).map(Number);
      return { year: v[0], altKm: v[1], lat: v[2], lon: v[3], dec: v[4], inc: v[5], f: v[10] };
    });
}

/** Decimal year → a Date, so the model is exercised through its real entry point. */
function dateOf(year: number): Date {
  const y = Math.floor(year);
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return new Date(start + (year - y) * (end - start));
}

describe("WMM2025 against NOAA's official test values", () => {
  const rows = testValues();

  it("loads all 100 test vectors", () => {
    expect(rows).toHaveLength(100);
  });

  // NOAA publishes declination to 0.01°; allow a hair more for the round trip
  // through Date, which lands a few seconds off an exact decimal year.
  it.each(rows)(
    "$year lat=$lat lon=$lon alt=$altKm km → declination $dec°",
    ({ year, altKm, lat, lon, dec, inc, f }) => {
      const got = magneticField(lat, lon, altKm, dateOf(year));
      expect(got.declination).toBeCloseTo(dec, 1);
      expect(got.inclination).toBeCloseTo(inc, 1);
      expect(got.intensity / 1000).toBeCloseTo(f / 1000, 1);
    }
  );
});

describe("declination in the field", () => {
  it("is easterly in the eastern US and westerly in the west", () => {
    // The agonic line runs roughly through the middle of the country: a
    // compass in Oregon points well east of true north, in Maine well west.
    expect(declination(45.5, -122.7, new Date("2026-07-01"))).toBeGreaterThan(10);
    expect(declination(44.8, -68.8, new Date("2026-07-01"))).toBeLessThan(-10);
  });

  it("is stable to a tenth of a degree over a mile", () => {
    const a = declination(45.5, -122.7, new Date("2026-07-01"));
    const b = declination(45.514, -122.7, new Date("2026-07-01"));
    expect(Math.abs(a - b)).toBeLessThan(0.1);
  });

  it("returns a finite answer at the poles rather than NaN", () => {
    expect(Number.isFinite(declination(90, 0, new Date("2026-07-01")))).toBe(true);
    expect(Number.isFinite(declination(-90, 0, new Date("2026-07-01")))).toBe(true);
  });
});

describe("decimalYear", () => {
  it("puts new year at the year boundary", () => {
    expect(decimalYear(new Date(Date.UTC(2026, 0, 1)))).toBeCloseTo(2026, 6);
  });

  it("puts midyear near .5", () => {
    expect(decimalYear(new Date(Date.UTC(2026, 6, 2)))).toBeCloseTo(2026.5, 2);
  });
});

describe("applying the correction", () => {
  it("adds easterly declination going magnetic → true", () => {
    expect(magneticToTrue(0, 15)).toBeCloseTo(15);
    expect(magneticToTrue(350, 15)).toBeCloseTo(5);
  });

  it("subtracts it going true → magnetic", () => {
    expect(trueToMagnetic(15, 15)).toBeCloseTo(0);
    expect(trueToMagnetic(5, 15)).toBeCloseTo(350);
  });

  it("round-trips", () => {
    expect(trueToMagnetic(magneticToTrue(123, -14.2), -14.2)).toBeCloseTo(123);
  });
});

describe("formatDeclination", () => {
  it("labels east and west", () => {
    expect(formatDeclination(13.42)).toBe("13.4° E");
    expect(formatDeclination(-13.42)).toBe("13.4° W");
  });

  it("does not put a hemisphere on zero", () => {
    expect(formatDeclination(0)).toBe("0°");
    expect(formatDeclination(0.01)).toBe("0°");
  });
});

describe("model validity", () => {
  it("covers its five-year window and not beyond", () => {
    expect(modelValidFor(new Date("2026-07-01"))).toBe(true);
    expect(modelValidFor(new Date("2031-01-01"))).toBe(false);
    expect(modelValidFor(new Date("2024-01-01"))).toBe(false);
  });
});
