import { describe, it, expect } from "vitest";
import { seasonReport } from "../src/season";

describe("seasonReport", () => {
  it("names the month and season", () => {
    const r = seasonReport(9, 44, -122); // October, Oregon
    expect(r.monthName).toBe("October");
    expect(r.season).toBe("fall");
  });

  it("always returns fishing, foraging, hunting, and a hazard", () => {
    const r = seasonReport(6, 40, -100);
    const labels = r.items.map((i) => i.label);
    expect(labels).toContain("Fishing");
    expect(labels).toContain("Foraging");
    expect(labels).toContain("Hunting");
    expect(labels).toContain("Watch");
  });

  it("calls fall prime hunting season", () => {
    const r = seasonReport(10, 45, -120); // November, west
    const hunt = r.items.find((i) => i.label === "Hunting");
    expect(hunt?.note).toMatch(/prime|rut/i);
  });

  it("gives the West salmon runs in fall, the East a bass bite", () => {
    const west = seasonReport(9, 44, -123);
    const east = seasonReport(9, 44, -85);
    expect(west.items.find((i) => i.label === "Fishing")?.note).toMatch(/salmon|steelhead/i);
    expect(east.items.find((i) => i.label === "Fishing")?.note).toMatch(/bass|walleye/i);
  });

  it("warns about cold and ice in winter", () => {
    const r = seasonReport(0, 46, -95); // January, north
    expect(r.items.find((i) => i.label === "Watch")?.note).toMatch(/cold|ice|hypothermia/i);
  });

  it("handles any month value without throwing", () => {
    for (let m = 0; m < 12; m++) expect(seasonReport(m, 40, -110).items.length).toBe(4);
  });
});
