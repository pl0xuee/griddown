import { describe, it, expect } from "vitest";
import { likelyForage, seasonOf } from "../src/forage";

describe("seasonOf", () => {
  it("maps months to northern-hemisphere seasons", () => {
    expect(seasonOf(0)).toBe("winter"); // Jan
    expect(seasonOf(3)).toBe("spring"); // Apr
    expect(seasonOf(6)).toBe("summer"); // Jul
    expect(seasonOf(9)).toBe("fall"); // Oct
    expect(seasonOf(11)).toBe("winter"); // Dec
  });
});

describe("likelyForage", () => {
  it("reads high western woods as conifer forest with western plants and elk", () => {
    const g = likelyForage({ landuseKind: "forest", elevationFt: 5000, lat: 44, lng: -121.5, month: 6 });
    expect(g.habitat).toBe("conifer forest");
    expect(g.plants.join(" ")).toMatch(/huckleberry/i);
    expect(g.game.join(" ")).toMatch(/elk/i);
  });

  it("reads low eastern woods as hardwood forest, not conifer", () => {
    const g = likelyForage({ landuseKind: "wood", elevationFt: 600, lat: 39, lng: -80, month: 6 });
    expect(g.habitat).toBe("hardwood forest");
    expect(g.game.join(" ")).not.toMatch(/elk/i); // elk is the western tag
  });

  it("adds morels & fiddleheads in spring, chanterelles & nuts in fall", () => {
    const spring = likelyForage({ landuseKind: "forest", elevationFt: 3000, lat: 44, lng: -122, month: 3 });
    expect(spring.plants.join(" ")).toMatch(/morel|fiddlehead/i);
    const fall = likelyForage({ landuseKind: "forest", elevationFt: 3000, lat: 44, lng: -122, month: 9 });
    expect(fall.plants.join(" ")).toMatch(/chanterelle|acorn|nut/i);
  });

  it("gives wetland cattail-and-waterfowl, not deer-in-the-trees", () => {
    const g = likelyForage({ landuseKind: "wetland", elevationFt: 200, lat: 40, lng: -95, month: 5 });
    expect(g.habitat).toBe("wetland");
    expect(g.plants.join(" ")).toMatch(/cattail/i);
    expect(g.game.join(" ")).toMatch(/duck|goose|muskrat/i);
  });

  it("handles farmland and orchards as cultivated food", () => {
    expect(likelyForage({ landuseKind: "farmland", elevationFt: 500, lat: 41, lng: -93, month: 8 }).habitat).toBe("farmland");
    expect(likelyForage({ landuseKind: "orchard", elevationFt: 500, lat: 41, lng: -122, month: 8 }).plants.join(" ")).toMatch(/apple/i);
  });

  it("always carries the loud caution and caps the lists", () => {
    const g = likelyForage({ landuseKind: "forest", elevationFt: 3000, lat: 45, lng: -120, month: 9 });
    expect(g.caution).toMatch(/never eat|lookalike|identification/i);
    expect(g.plants.length).toBeLessThanOrEqual(7);
    expect(g.game.length).toBeLessThanOrEqual(5);
    expect(new Set(g.plants).size).toBe(g.plants.length);
  });

  it("keeps the trapping suggestion in winter even for a full-list habitat", () => {
    // Forest game already fills the 5-slot cap; winter's "lean on trapping"
    // note must not be contradicted by the item being sliced off.
    const g = likelyForage({ landuseKind: "forest", elevationFt: 3000, lat: 45, lng: -120, month: 0 });
    expect(g.game.join(" ")).toMatch(/snared|trap/i);
  });

  it("flags a coarser guess when there's no elevation, but still guesses", () => {
    const g = likelyForage({ landuseKind: "wood", elevationFt: null, lat: 46, lng: -122, month: 7 });
    expect(g.elevationKnown).toBe(false);
    expect(g.plants.length).toBeGreaterThan(0);
  });
});
