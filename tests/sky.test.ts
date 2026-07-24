import { describe, it, expect } from "vitest";
import { fmtTime, moonUpDown, moonPhaseName, dayLength, zoneOffsetHours } from "../src/sky";
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

/**
 * Sun and moon times are computed for the map CENTRE but rendered with
 * toLocaleTimeString, i.e. on the device's clock. That is right while you are
 * standing where you are looking, and quietly wrong the moment you pan two
 * states over to plan — the panel used to give no hint at all. This is the
 * whole-hour gap it reports.
 *
 * The device zone is pinned per assertion rather than inherited from whatever
 * machine the suite runs on, because the answer is a difference between two
 * zones and a floating one would make the expected values unknowable.
 */
function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

describe("zoneOffsetHours", () => {
  const JAN = new Date(Date.UTC(2026, 0, 15, 20, 0));
  const JUL = new Date(Date.UTC(2026, 6, 15, 20, 0));

  it("is silent when the map centre is in the device's own zone", () => {
    // Los Angeles is UTC-8 standard; -122.68° (Portland) rounds to zone -8.
    withTZ("America/Los_Angeles", () => {
      expect(zoneOffsetHours(-122.6784, JAN)).toBe(0);
      expect(zoneOffsetHours(-121.3153, JAN)).toBe(0);
      // Anything from -112.5° to -127.5° rounds into the same whole-hour zone.
      expect(zoneOffsetHours(-113, JAN)).toBe(0);
      expect(zoneOffsetHours(-127, JAN)).toBe(0);
    });
  });

  it("does not let the device's summer time read as a foreign zone", () => {
    // The reason it compares against STANDARD offset: in July the device is on
    // PDT (UTC-7), and a naive comparison would tell a user sitting at home in
    // Oregon that the crosshair is an hour off, all summer.
    withTZ("America/Los_Angeles", () => {
      expect(zoneOffsetHours(-122.6784, JUL)).toBe(0);
      expect(zoneOffsetHours(-122.6784, JAN)).toBe(zoneOffsetHours(-122.6784, JUL));
    });
  });

  it("reports the gap with the right sign and size for a distant longitude", () => {
    withTZ("America/Los_Angeles", () => {
      // New York, -75° → zone -5. Three hours AHEAD of Pacific standard.
      expect(zoneOffsetHours(-75, JAN)).toBe(3);
      expect(zoneOffsetHours(-75, JUL)).toBe(3);
      // Denver, -105° → zone -7. One ahead.
      expect(zoneOffsetHours(-105, JAN)).toBe(1);
      // Honolulu, -157.86° → zone -11 (rounds from -10.52). Three behind.
      expect(zoneOffsetHours(-157.8583, JAN)).toBe(-3);
      // Greenwich, 0° → zone 0. Eight ahead of UTC-8.
      expect(zoneOffsetHours(0, JAN)).toBe(8);
    });
  });

  it("measures against whatever zone the device is actually in", () => {
    // Same longitudes, a different device: the answer must move with the
    // device, not be baked in.
    withTZ("America/New_York", () => {
      // Eastern standard is UTC-5.
      expect(zoneOffsetHours(-75, JAN)).toBe(0);
      expect(zoneOffsetHours(-75, JUL)).toBe(0);
      expect(zoneOffsetHours(-122.6784, JAN)).toBe(-3); // Oregon, three behind
      expect(zoneOffsetHours(0, JAN)).toBe(5);
    });
    withTZ("UTC", () => {
      expect(zoneOffsetHours(0, JAN)).toBe(0);
      expect(zoneOffsetHours(-122.6784, JAN)).toBe(-8);
      expect(zoneOffsetHours(139.6917, JAN)).toBe(9); // Tokyo, 139.69° → zone +9
    });
    // Southern hemisphere, where summer time falls in JANUARY and the standard
    // offset is therefore the SMALLER of the two — which is why the code takes
    // the larger getTimezoneOffset(), those being minutes WEST of Greenwich.
    withTZ("Australia/Sydney", () => {
      // AEST is UTC+10; 151.2° rounds to zone +10.
      expect(zoneOffsetHours(151.2093, JAN)).toBe(0);
      expect(zoneOffsetHours(151.2093, JUL)).toBe(0);
      expect(zoneOffsetHours(0, JAN)).toBe(-10);
    });
  });

  it("rounds to the nearest whole zone, not to the one below", () => {
    withTZ("UTC", () => {
      expect(zoneOffsetHours(7.4, JAN)).toBe(0);
      expect(zoneOffsetHours(7.6, JAN)).toBe(1);
      expect(zoneOffsetHours(-7.6, JAN)).toBe(-1);
      expect(zoneOffsetHours(180, JAN)).toBe(12);
      expect(zoneOffsetHours(-180, JAN)).toBe(-12);
    });
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
