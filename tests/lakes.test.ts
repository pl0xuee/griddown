import { describe, it, expect } from "vitest";
import { milesBetween, waterLabel } from "../src/lakes";

describe("waterLabel", () => {
  it("labels flowing water by kind", () => {
    expect(waterLabel("Sandy River", "river")).toBe("river");
    expect(waterLabel("Trail Creek", "stream")).toBe("creek");
  });
  it("labels a river tagged as a water polygon by its name, not 'lake'", () => {
    expect(waterLabel("Bull Run River", "water")).toBe("river");
    expect(waterLabel("Alder Slough", "water")).toBe("river");
  });
  it("labels reservoirs and lakes correctly", () => {
    expect(waterLabel("Detroit Reservoir", "water")).toBe("reservoir");
    expect(waterLabel("Bull Run Reservoir", "reservoir")).toBe("reservoir");
    expect(waterLabel("Timothy Lake", "water")).toBe("lake");
    expect(waterLabel("Clear Lake", "lake")).toBe("lake");
  });
});

describe("milesBetween", () => {
  it("is zero for the same point", () => {
    expect(milesBetween(45, -121, 45, -121)).toBe(0);
  });

  it("matches a known distance (Portland → Bend ≈ 120 mi)", () => {
    const d = milesBetween(45.52, -122.68, 44.06, -121.31);
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(130);
  });

  it("is symmetric", () => {
    const a = milesBetween(45, -121, 44, -120);
    const b = milesBetween(44, -120, 45, -121);
    expect(Math.abs(a - b)).toBeLessThan(1e-9);
  });

  it("about 69 miles per degree of latitude", () => {
    const d = milesBetween(45, -121, 46, -121);
    expect(d).toBeGreaterThan(68);
    expect(d).toBeLessThan(70);
  });
});
