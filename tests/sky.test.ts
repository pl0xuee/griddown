import { describe, it, expect } from "vitest";
import { fmtTime, moonUpDown, moonPhaseName, dayLength } from "../src/sky";
import { fmtMgrs } from "../src/paper";
import { forward as mgrsForward } from "mgrs";

// Sun/moon and MGRS were the last pure offline maths with no coverage.
// Both are read in the field and neither fails loudly when wrong.

describe("moonPhaseName", () => {
  it("names the eight phases across the cycle", () => {
    expect(moonPhaseName(0)).toBe("New moon");
    expect(moonPhaseName(0.125)).toBe("Waxing crescent");
    expect(moonPhaseName(0.25)).toBe("First quarter");
    expect(moonPhaseName(0.375)).toBe("Waxing gibbous");
    expect(moonPhaseName(0.5)).toBe("Full moon");
    expect(moonPhaseName(0.625)).toBe("Waning gibbous");
    expect(moonPhaseName(0.75)).toBe("Last quarter");
    expect(moonPhaseName(0.875)).toBe("Waning crescent");
  });

  // The cycle wraps: 0.98 is a hair before new, not a waning crescent.
  it("treats both ends of the cycle as new", () => {
    expect(moonPhaseName(0.99)).toBe("New moon");
    expect(moonPhaseName(0.01)).toBe("New moon");
  });

  it("gives a name for every value in range", () => {
    for (let p = 0; p <= 1; p += 0.01) {
      expect(moonPhaseName(p)).toMatch(/moon|quarter|crescent|gibbous/i);
    }
  });
});

describe("dayLength", () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 19, h, m));

  it("measures sunrise to sunset", () => {
    expect(dayLength(at(6), at(20, 30))).toBe("14h 30m");
  });

  // Sunset before sunrise means the pair straddles midnight UTC; the answer is
  // still a real day length, not a negative one.
  it("wraps rather than going negative across midnight", () => {
    expect(dayLength(at(20), at(6))).toBe("10h 0m");
  });

  // Polar summer/winter: SunCalc returns invalid dates, and "—" is the honest
  // answer. Printing "0h 0m" would read as a real, very short day.
  it("is a dash when the sun never rises or sets", () => {
    expect(dayLength(null, at(20))).toBe("—");
    expect(dayLength(at(6), undefined)).toBe("—");
    expect(dayLength(new Date(NaN), at(20))).toBe("—");
  });
});

describe("fmtTime", () => {
  it("is a dash for a missing or invalid time", () => {
    expect(fmtTime(null)).toBe("—");
    expect(fmtTime(undefined)).toBe("—");
    expect(fmtTime(new Date(NaN))).toBe("—");
  });

  it("renders a real time", () => {
    expect(fmtTime(new Date(2026, 6, 19, 6, 5))).toMatch(/\d/);
  });
});

describe("moonUpDown", () => {
  // Both flags otherwise render as "—", making "the moon is up all night" —
  // which is when you can actually move after dark — look like a failed lookup.
  it("says so when the moon is up all night", () => {
    expect(moonUpDown({ alwaysUp: true })).toContain("Up all night");
  });

  it("says so when the moon never rises", () => {
    expect(moonUpDown({ alwaysDown: true })).toContain("Never rises today");
  });

  it("otherwise gives both rise and set rows", () => {
    const html = moonUpDown({ rise: new Date(2026, 6, 19, 21, 0), set: new Date(2026, 6, 20, 5, 0) });
    expect(html).toContain("Moonrise");
    expect(html).toContain("Moonset");
  });
});

describe("fmtMgrs", () => {
  it("groups a full-precision reference for reading aloud", () => {
    expect(fmtMgrs("10TER1234567890")).toBe("10T ER 12345 67890");
  });

  it("handles a single-digit zone", () => {
    expect(fmtMgrs("4QFJ1234567890")).toBe("4Q FJ 12345 67890");
  });

  it("groups lower precision too", () => {
    expect(fmtMgrs("10TER1234")).toBe("10T ER 12 34");
  });

  // A string that isn't MGRS must be passed through, not chopped on a guess.
  it("leaves anything unexpected alone", () => {
    expect(fmtMgrs("not a grid ref")).toBe("not a grid ref");
    expect(fmtMgrs("")).toBe("");
    expect(fmtMgrs("10TER123")).toBe("10TER123"); // odd digit count
  });

  it("formats what the mgrs library actually produces", () => {
    // The real pairing: whatever forward() returns must survive formatting
    // into four readable groups.
    const raw = mgrsForward([-121.696, 45.3736], 5);
    expect(fmtMgrs(raw)).toMatch(/^\d{1,2}[C-X] [A-Z]{2} \d{5} \d{5}$/);
  });
});
