import { describe, it, expect } from "vitest";
import { classify, designationOf, landInfo } from "../src/publicland";

describe("classify", () => {
  it("folds the basemap's military kinds onto one class", () => {
    expect(classify("military")).toBe("military");
    expect(classify("naval_base")).toBe("military");
    expect(classify("airfield")).toBe("military");
  });

  it("treats wood as forest, since the extract uses both", () => {
    expect(classify("forest")).toBe("forest");
    expect(classify("wood")).toBe("forest");
  });

  it("is case-insensitive and rejects anything it cannot advise on", () => {
    expect(classify("National_Park")).toBe("national_park");
    expect(classify("farmland")).toBeNull();
    expect(classify("")).toBeNull();
  });
});

describe("designationOf", () => {
  it("reads the designation out of real unit names", () => {
    // The polygon for this one is kind=nature_reserve — the name is the only
    // thing that reveals it is wilderness. Verified against the Oregon extract.
    expect(designationOf("Three Sisters Wilderness")).toBe("wilderness");
    expect(designationOf("Deschutes National Forest")).toBe("national_forest");
    expect(designationOf("Crater Lake National Park")).toBe("national_park");
    expect(designationOf("Malheur National Wildlife Refuge")).toBe("wildlife_refuge");
    expect(designationOf("Smith Rock State Park")).toBe("state_park");
    expect(designationOf("Tillamook State Forest")).toBe("state_forest");
    expect(designationOf("Cascade\u2013Siskiyou National Monument")).toBe("national_monument");
  });

  it("prefers wilderness over the forest that contains it", () => {
    // A wilderness area sits inside a national forest and its rules are the
    // stricter ones, so the inner designation has to win.
    expect(designationOf("Mount Jefferson Wilderness Area")).toBe("wilderness");
  });

  it("does not call a national scenic area a monument", () => {
    // Real name from the Oregon extract, tagged kind=protected_area. It is
    // Forest Service ground, so labelling it an NPS monument names the wrong
    // agency and gives the wrong rules.
    expect(designationOf("Columbia River Gorge National Scenic Area")).toBe("national_scenic");
    expect(designationOf("Hells Canyon National Recreation Area")).toBe("national_scenic");
    expect(landInfo("protected_area", "Columbia River Gorge National Scenic Area")!.manager)
      .toMatch(/Forest Service/i);
  });

  it("handles the real unit names found in the Oregon extract", () => {
    // Every one of these was read out of mapdata/oregon.pmtiles, including the
    // en-dash in Cascade–Siskiyou, which a hand-typed hyphen would have missed.
    const real: [string, string | null][] = [
      ["Three Sisters Wilderness", "wilderness"],
      ["Mount Hood National Forest", "national_forest"],
      ["Fremont-Winema National Forest", "national_forest"],
      ["Fort Stevens State Park", "state_park"],
      ["Oswald West State Park", "state_park"],
      ["Chinook Wildlife Area", "wildlife_refuge"],
      ["Cascade\u2013Siskiyou National Monument", "national_monument"],
      ["Columbia Park", "local_park"],
      // No designation in the name — these must fall back, not guess.
      ["Redfish Rocks Marine Reserve", null],
      ["Klickitat Wild and Scenic River", null],
      ["Elochoman Block", null],
      ["Powell Buttes", null],
      // An NPS unit that does not say "National Park" — it used to fall through
      // to the local-park rule and be reported as a city park closing at dusk.
      ["Lewis and Clark National Historical Park", "national_park"],
      ["Oregon Caves National Preserve", "national_park"],
    ];
    for (const [name, want] of real) expect([name, designationOf(name)]).toEqual([name, want]);
  });

  it("returns null when the name says nothing useful", () => {
    expect(designationOf("")).toBeNull();
    expect(designationOf("Section 14")).toBeNull();
  });

  it("never mistakes a federal or state unit for a municipal park", () => {
    // The trailing-"Park" rule is the greedy one, so it must yield to anything
    // that names a federal or state agency.
    expect(designationOf("Lewis and Clark National Historical Park")).not.toBe("local_park");
    expect(designationOf("Fort Stevens State Park")).not.toBe("local_park");
    expect(designationOf("Columbia Park")).toBe("local_park");
  });
});

describe("landInfo", () => {
  it("returns null for ground it has nothing to say about", () => {
    expect(landInfo("farmland")).toBeNull();
  });

  it("reports military land as closed, with every activity denied", () => {
    const i = landInfo("military")!;
    expect(i.access).toBe("closed");
    expect(i.rules.every((r) => r.ok === false)).toBe(true);
    expect(i.notes.join(" ")).toMatch(/ordnance/i);
  });

  it("never lets a friendly name soften military ground", () => {
    // "…Park" in the name must not downgrade a range to a picnic spot.
    const i = landInfo("military", "Boardman Bombing Range Park")!;
    expect(i.access).toBe("closed");
    expect(i.designation).toBeNull();
  });

  it("upgrades a coarse polygon kind using the unit name", () => {
    // The whole point: the polygon says nature_reserve, the name says wilderness.
    const bare = landInfo("nature_reserve")!;
    expect(bare.title).toBe("Nature reserve");
    expect(bare.designation).toBeNull();

    const named = landInfo("nature_reserve", "Three Sisters Wilderness")!;
    expect(named.designation).toBe("wilderness");
    expect(named.title).toBe("Wilderness area");
    expect(named.name).toBe("Three Sisters Wilderness");
    expect(named.manager).toMatch(/wilderness/i);
    // The rule people break by accident.
    expect(named.notes.join(" ")).toMatch(/no bicycles|bicycles/i);
  });

  it("names the managing agency once the designation is known", () => {
    expect(landInfo("forest", "Deschutes National Forest")!.manager).toMatch(/Forest Service/i);
    expect(landInfo("park", "Smith Rock State Park")!.manager).toMatch(/State parks/i);
    expect(landInfo("protected_area", "Steens Mountain BLM")!.manager).toMatch(/Bureau of Land/i);
  });

  it("is honest that an unnamed forest has unknown ownership", () => {
    // This is the common case — most landuse polygons have no name at all — so
    // it must not read as permission.
    const i = landInfo("forest")!;
    expect(i.access).toBe("limited");
    expect(i.rules.find((r) => r.label === "Camp")!.value).toBe("Unknown");
    expect(i.rules.find((r) => r.label === "Camp")!.ok).toBe(null);
    expect(i.notes.join(" ")).toMatch(/private until/i);
  });

  it("does allow dispersed camping once the forest is known to be national", () => {
    const i = landInfo("forest", "Deschutes National Forest")!;
    expect(i.access).toBe("open");
    expect(i.rules.find((r) => r.label === "Camp")!.value).toMatch(/usually yes/i);
  });

  it("gates national park camping behind a permit rather than allowing it", () => {
    const camp = landInfo("national_park")!.rules.find((r) => r.label === "Camp")!;
    expect(camp.ok).toBe(null);
    expect(camp.value).toMatch(/permit/i);
  });

  it("keeps hunting off in national parks and local parks", () => {
    for (const [kind, name] of [["national_park", ""], ["park", "Drake Park"]] as const) {
      expect(landInfo(kind, name)!.rules.find((r) => r.label === "Hunt")!.ok).toBe(false);
    }
  });

  it("trims a whitespace-only name rather than treating it as present", () => {
    expect(landInfo("forest", "  ").name).toBe("");
    expect(landInfo("forest").name).toBe("");
  });

  it("always carries the verify-with-the-agency caveat", () => {
    const kinds = ["military", "national_park", "forest", "nature_reserve", "protected_area", "park"];
    for (const k of kinds) {
      expect(landInfo(k)!.caveat).toMatch(/verify with the managing agency/i);
      expect(landInfo(k, "Three Sisters Wilderness")!.caveat).toMatch(/verify with the managing agency/i);
    }
  });

  it("gives every class and every designation a full card", () => {
    const named = [
      "", "Three Sisters Wilderness", "Deschutes National Forest", "Crater Lake National Park",
      "Cascade\u2013Siskiyou National Monument", "Malheur National Wildlife Refuge",
      "Smith Rock State Park", "Tillamook State Forest", "Steens Mountain BLM", "Drake Park",
    ];
    for (const k of ["military", "national_park", "forest", "nature_reserve", "protected_area", "park"]) {
      for (const n of named) {
        const i = landInfo(k, n)!;
        expect(i.title.length).toBeGreaterThan(0);
        expect(i.manager.length).toBeGreaterThan(0);
        expect(i.accessNote.length).toBeGreaterThan(0);
        expect(i.rules.length).toBe(4);
        expect(i.notes.length).toBeGreaterThan(0);
      }
    }
  });
});
