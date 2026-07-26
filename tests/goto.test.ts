import { describe, it, expect } from "vitest";
import { parseCoord } from "../src/goto";

// A grid reference read over a radio loses digits. "One zero tango delta kilo,
// one two three four, five six seven eight" is a 10 m square; the same call
// with the numbers dropped is a 100 km square, and mgrs.toPoint answers both
// with a single lat/lng. Nothing downstream could tell them apart, so a
// reference missing half its digits dropped a pin to five decimal places —
// implying metres — up to 70 km from where the person actually was.

describe("parseCoord", () => {
  it("reads a full-precision grid reference", () => {
    const c = parseCoord("10T DK 12345 67890");
    expect(c).not.toBeNull();
    expect(c!.squareM).toBe(1);
    expect(c!.kind).toBe("mgrs");
  });

  it("reports how big the square is when digits are missing", () => {
    expect(parseCoord("10T DK 1234 5678")!.squareM).toBe(10);
    expect(parseCoord("10T DK 123 456")!.squareM).toBe(100);
    expect(parseCoord("10T DK 12 34")!.squareM).toBe(1000);
    expect(parseCoord("10T DK 1 1")!.squareM).toBe(10000);
    expect(parseCoord("10TDK")!.squareM).toBe(100000);
  });

  it("does not care about spacing or case", () => {
    const a = parseCoord("10tdk1234567890");
    const b = parseCoord("10T DK 12345 67890");
    expect(a!.squareM).toBe(b!.squareM);
    expect(a!.lng).toBeCloseTo(b!.lng, 9);
  });

  it("treats a typed lat/lng as exact", () => {
    const c = parseCoord("45.5, -122.7");
    expect(c!.kind).toBe("latlng");
    expect(c!.squareM).toBe(0);
    expect(c!.lat).toBeCloseTo(45.5, 9);
    expect(c!.lng).toBeCloseTo(-122.7, 9);
  });

  it("still refuses what it always refused", () => {
    for (const bad of ["", "hello", "1234567890", "91, 0", "0, 181"]) {
      expect(parseCoord(bad)).toBeNull();
    }
  });

  it("rejects an odd number of grid digits rather than guessing", () => {
    // Easting and northing must have the same number of digits. A reference
    // with one digit missing is a mis-transcription, not a coarse square.
    expect(parseCoord("10T DK 123 45")).toBeNull();
  });
});
