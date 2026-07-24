import { describe, it, expect } from "vitest";
import {
  mvumClass,
  vehicleAccess,
  formatDates,
  colorExpression,
  seasonalCodes,
  MVUM_CLASSES,
  VEHICLES,
} from "../src/mvum";

describe("mvumClass", () => {
  it("maps the published road and trail symbols", () => {
    expect(mvumClass("1").label).toBe("Open to all vehicles");
    expect(mvumClass("3").label).toBe("Highway-legal vehicles only");
    expect(mvumClass("9").label).toBe("Trail, motorcycles only");
  });

  it("marks the seasonal variants seasonal", () => {
    for (const even of ["2", "4", "6", "8", "10", "12", "17"]) {
      expect(MVUM_CLASSES[even].seasonal).toBe(true);
    }
    for (const odd of ["1", "3", "5", "7", "9", "11", "16"]) {
      expect(MVUM_CLASSES[odd].seasonal).toBe(false);
    }
  });

  it("falls back rather than throwing on an unknown or missing symbol", () => {
    expect(mvumClass("999").label).toBe("Designated route");
    expect(mvumClass(undefined).label).toBe("Designated route");
    expect(mvumClass(null).label).toBe("Designated route");
  });

  it("accepts a numeric symbol, since JSON may not quote it", () => {
    expect(mvumClass(1 as any).label).toBe("Open to all vehicles");
  });
});

describe("vehicleAccess", () => {
  it("lists only classes explicitly marked open", () => {
    const got = vehicleAccess({
      passengervehicle: "open",
      passengervehicle_datesopen: "01/01-12/31",
      atv: null,
      motorcycle: "open",
      motorcycle_datesopen: "06/01-10/15",
    });
    expect(got).toEqual([
      { label: "Passenger car", dates: "year-round" },
      { label: "Motorcycle", dates: "Jun 1 – Oct 15" },
    ]);
  });

  // The data uses null, "" and " " interchangeably for "not designated", and
  // there is no "closed" value at all — so anything that isn't "open" is a no.
  it("treats blank, whitespace and null as not designated", () => {
    expect(vehicleAccess({ atv: "", motorcycle: " ", truck: null })).toEqual([]);
  });

  it("is case- and whitespace-insensitive about 'open'", () => {
    expect(vehicleAccess({ atv: " OPEN " })).toEqual([{ label: "ATV", dates: "" }]);
  });

  it("returns nothing for a route with no vehicle columns at all", () => {
    expect(vehicleAccess({})).toEqual([]);
  });

  it("keeps the order drivers ask in, not the order in the data", () => {
    const got = vehicleAccess({ motorcycle: "open", passengervehicle: "open" });
    expect(got.map((v) => v.label)).toEqual(["Passenger car", "Motorcycle"]);
  });

  /**
   * The three columns whose dates twin drops the width suffix. Deriving the
   * name as `${field}_datesopen` looked up a key that is never present, and
   * because the download strips blank properties there is no way to tell that
   * from "no restriction" — so a road open only in high summer printed as open,
   * full stop. Someone reads that in October and drives into a closure.
   */
  it("finds the dates column when it drops the width suffix", () => {
    expect(
      vehicleAccess({ fourwd_gt50inches: "open", fourwd_gt50_datesopen: "06/01-10/15" })
    ).toEqual([{ label: '4WD over 50"', dates: "Jun 1 – Oct 15" }]);

    expect(
      vehicleAccess({ twowd_gt50inches: "open", twowd_gt50_datesopen: "05/15-11/30" })
    ).toEqual([{ label: '2WD over 50"', dates: "May 15 – Nov 30" }]);

    expect(
      vehicleAccess({ other_ohv_lt50inches: "open", other_ohv_lt50_datesopen: "07/01-09/30" })
    ).toEqual([{ label: 'OHV under 50"', dates: "Jul 1 – Sep 30" }]);
  });

  it("does not read the suffixed name that the data never uses", () => {
    // The key the old derivation went looking for. If it is honoured, a road
    // whose real column says "closed until June" reads as open year-round.
    expect(
      vehicleAccess({
        fourwd_gt50inches: "open",
        fourwd_gt50inches_datesopen: "01/01-12/31",
        fourwd_gt50_datesopen: "06/01-10/15",
      })
    ).toEqual([{ label: '4WD over 50"', dates: "Jun 1 – Oct 15" }]);
  });

  it("reads every class's dates in one mixed row, as a real feature carries them", () => {
    const got = vehicleAccess({
      passengervehicle: "open",
      passengervehicle_datesopen: "01/01-12/31",
      highclearancevehicle: "open",
      highclearancevehicle_datesopen: "04/15-11/15",
      motorhome: "open",
      motorhome_datesopen: "01/01-12/31",
      fourwd_gt50inches: "open",
      fourwd_gt50_datesopen: "06/01-10/15",
      twowd_gt50inches: "open",
      twowd_gt50_datesopen: "06/01-10/15",
      atv: "open",
      atv_datesopen: "05/01-10/31",
      motorcycle: "open",
      motorcycle_datesopen: "05/01-10/31",
      otherwheeled_ohv: "open",
      otherwheeled_ohv_datesopen: "05/01-10/31",
      other_ohv_lt50inches: "open",
      other_ohv_lt50_datesopen: "05/01-10/31",
    });
    expect(got).toEqual([
      { label: "Passenger car", dates: "year-round" },
      { label: "High-clearance", dates: "Apr 15 – Nov 15" },
      { label: "Motorhome", dates: "year-round" },
      { label: '4WD over 50"', dates: "Jun 1 – Oct 15" },
      { label: '2WD over 50"', dates: "Jun 1 – Oct 15" },
      { label: "ATV", dates: "May 1 – Oct 31" },
      { label: "Motorcycle", dates: "May 1 – Oct 31" },
      { label: "Other wheeled OHV", dates: "May 1 – Oct 31" },
      { label: 'OHV under 50"', dates: "May 1 – Oct 31" },
    ]);
    // Not one of them may be blank: a blank here is exactly what the bug
    // produced, and it renders as the word "open".
    expect(got.filter((v) => v.dates === "")).toEqual([]);
  });
});

describe("formatDates", () => {
  it("calls the full year year-round", () => {
    expect(formatDates("01/01-12/31")).toBe("year-round");
  });

  it("renders a seasonal window readably", () => {
    expect(formatDates("06/01-10/15")).toBe("Jun 1 – Oct 15");
    expect(formatDates("6/1-10/15")).toBe("Jun 1 – Oct 15");
  });

  it("passes through free text rather than inventing a range", () => {
    // Observed in the real data — one route carries "4/1 - 12/25" style text.
    expect(formatDates("4/1 - 12/25")).toBe("Apr 1 – Dec 25");
    expect(formatDates("call district office")).toBe("call district office");
  });

  it("is empty for empty input", () => {
    expect(formatDates(null)).toBe("");
    expect(formatDates("  ")).toBe("");
  });

  it("does not turn a nonsense month into a month name", () => {
    expect(formatDates("13/01-14/02")).toBe("13/01-14/02");
  });
});

describe("MapLibre expressions", () => {
  it("gives every known symbol a colour, with a fallback last", () => {
    const expr = colorExpression();
    expect(expr[0]).toBe("match");
    for (const code of Object.keys(MVUM_CLASSES)) expect(expr).toContain(code);
    // match expressions end with the default value
    expect(typeof expr[expr.length - 1]).toBe("string");
    expect(expr[expr.length - 1]).toMatch(/^#/);
  });

  it("stringifies the symbol before matching, since it may be a number", () => {
    expect(colorExpression()[1]).toEqual(["to-string", ["get", "symbol"]]);
  });

  it("lists exactly the seasonal codes", () => {
    expect(seasonalCodes().sort()).toEqual(["10", "12", "17", "2", "4", "6", "8"].sort());
  });
});

describe("vehicle field names", () => {
  // These must match the USFS column names exactly or every route reads as
  // closed — which is the failure mode that looks like working software.
  it("uses the published MVUM column names", () => {
    expect(VEHICLES.map((v) => v.field)).toEqual([
      "passengervehicle",
      "highclearancevehicle",
      "motorhome",
      "fourwd_gt50inches",
      "twowd_gt50inches",
      "atv",
      "motorcycle",
      "otherwheeled_ohv",
      "other_ohv_lt50inches",
    ]);
  });

  /**
   * Both halves of every column pair, spelled out.
   *
   * Transcribed from MVUM_FIELDS_COMMON in src-tauri/src/lib.rs, which is the
   * `outFields` list actually sent to the USFS service — so it is the only
   * source of truth for what keys arrive in the GeoJSON. Note the three that
   * DROP the width suffix on the dates twin: fourwd_gt50inches pairs with
   * fourwd_gt50_datesopen, not fourwd_gt50inches_datesopen. That asymmetry is
   * theirs, not ours, and deriving the name instead of listing it is what broke.
   */
  it("pairs each column with the dates column the service actually returns", () => {
    expect(VEHICLES.map((v) => [v.field, v.dates])).toEqual([
      ["passengervehicle", "passengervehicle_datesopen"],
      ["highclearancevehicle", "highclearancevehicle_datesopen"],
      ["motorhome", "motorhome_datesopen"],
      ["fourwd_gt50inches", "fourwd_gt50_datesopen"],
      ["twowd_gt50inches", "twowd_gt50_datesopen"],
      ["atv", "atv_datesopen"],
      ["motorcycle", "motorcycle_datesopen"],
      ["otherwheeled_ohv", "otherwheeled_ohv_datesopen"],
      ["other_ohv_lt50inches", "other_ohv_lt50_datesopen"],
    ]);
  });

  it("has three pairs that are NOT the naive field + _datesopen", () => {
    const odd = VEHICLES.filter((v) => v.dates !== `${v.field}_datesopen`).map((v) => v.field);
    expect(odd).toEqual(["fourwd_gt50inches", "twowd_gt50inches", "other_ohv_lt50inches"]);
  });
});
