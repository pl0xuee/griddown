import { describe, it, expect } from "vitest";
import {
  likelyFish,
  regimeFor,
  coldElevationLineFt,
  FISHABLE_KINDS,
} from "../src/fish";

// Feet per metre, so tests can think in the DEM's native metres where handy.
const ft = (m: number) => m * 3.28084;

describe("coldElevationLineFt", () => {
  it("drops as you go north and floors at zero", () => {
    expect(coldElevationLineFt(30)).toBeGreaterThan(coldElevationLineFt(45));
    expect(coldElevationLineFt(49)).toBe(0);
    expect(coldElevationLineFt(60)).toBe(0); // clamped, never negative
  });
});

describe("regimeFor", () => {
  it("reads high, northern water as cold and low, southern water as warm", () => {
    expect(regimeFor(6000, 44)).toBe("cold"); // high Cascades lake
    expect(regimeFor(200, 30)).toBe("warm"); // Gulf-coast bayou
  });
  it("puts a mid-elevation reservoir in the cool/cold band, not warm", () => {
    expect(regimeFor(4100, 42.5)).not.toBe("warm"); // Boggs-Lake-like
  });
  it("falls back to latitude when there is no elevation", () => {
    expect(regimeFor(null, 47)).toBe("cold");
    expect(regimeFor(null, 41)).toBe("cool");
    expect(regimeFor(null, 30)).toBe("warm");
  });
});

describe("likelyFish", () => {
  it("calls a cold mountain stream trout water", () => {
    const g = likelyFish({ kind: "stream", elevationFt: 5000, lat: 44, lng: -121.5 });
    expect(g.regime).toBe("cold");
    expect(g.species[0]).toMatch(/trout/i);
    expect(g.waterType).toMatch(/stream/);
  });

  it("adds Pacific salmon & steelhead to a coastal river, not to an interior one", () => {
    const coastal = likelyFish({ kind: "river", elevationFt: 400, lat: 44, lng: -123.5 });
    expect(coastal.species.join(" ")).toMatch(/steelhead|salmon/i);
    // The Pacific slope's big rivers also hold sturgeon.
    expect(coastal.species.join(" ")).toMatch(/sturgeon/i);

    const interior = likelyFish({ kind: "river", elevationFt: 400, lat: 39, lng: -98 });
    expect(interior.species.join(" ")).not.toMatch(/steelhead|salmon|sturgeon/i);
  });

  it("calls a warm lowland lake bass-and-panfish water", () => {
    const g = likelyFish({ kind: "lake", elevationFt: 300, lat: 32, lng: -95 });
    expect(g.regime).toBe("warm");
    expect(g.species.join(" ")).toMatch(/bass/i);
    expect(g.species.join(" ")).toMatch(/bluegill|crappie/i);
  });

  it("gives a mid-elevation reservoir a trout-led mix (matches the pitched example)", () => {
    const g = likelyFish({ kind: "reservoir", elevationFt: 4100, lat: 42.5, lng: -121 });
    expect(g.species[0]).toMatch(/trout/i);
    expect(g.species.join(" ")).toMatch(/bass/i); // stocked reservoirs hold warmwater too
    expect(g.waterType).toMatch(/reservoir/);
  });

  it("flags a coarser guess when elevation is unknown, but still guesses", () => {
    const g = likelyFish({ kind: "lake", elevationFt: null, lat: 46, lng: -122 });
    expect(g.elevationKnown).toBe(false);
    expect(g.species.length).toBeGreaterThan(0);
  });

  it("adds northern coolwater specialists in the upper Midwest", () => {
    const g = likelyFish({ kind: "lake", elevationFt: 1200, lat: 46, lng: -92 });
    expect(g.species.join(" ")).toMatch(/walleye|pike/i);
  });

  it("caps the list and always carries the honest caveat and a method", () => {
    const g = likelyFish({ kind: "river", elevationFt: 400, lat: 44, lng: -123.5 });
    expect(g.species.length).toBeLessThanOrEqual(6);
    expect(g.caveat).toMatch(/not a stocking survey/i);
    expect(g.method.length).toBeGreaterThan(10);
  });

  it("never lists the same species twice", () => {
    for (const kind of FISHABLE_KINDS) {
      const g = likelyFish({ kind, elevationFt: 3000, lat: 45, lng: -122 });
      expect(new Set(g.species).size).toBe(g.species.length);
    }
  });
});
