import { describe, it, expect } from "vitest";
import { sweepViewshed } from "../src/sweep";

const OPTS = { rays: 4, steps: 140, stepM: 50 }; // 7 km sweep

describe("sweepViewshed", () => {
  it("sees everything on a flat plain (until curvature wins)", () => {
    const r = sweepViewshed(100, () => 100, OPTS);
    // Near samples must be visible from 1.7 m eye height on flat ground.
    expect(r.visible[0]).toBe(1);
    expect(r.visible[10]).toBe(1);
    // The eye-height horizon with refraction is ~5 km; at 7 km the earth
    // itself hides flat ground.
    expect(r.visible[OPTS.steps - 1]).toBe(0);
  });

  it("a wall hides the ground behind it", () => {
    // 50 m wall at 1 km; flat before and after.
    const elev = (d: number) => (d >= 1000 && d < 1050 ? 150 : 100);
    const r = sweepViewshed(100, elev, OPTS);
    const at = (d: number) => r.visible[Math.round(d / OPTS.stepM) - 1];
    expect(at(500)).toBe(1); // before the wall
    expect(at(1000)).toBe(1); // the wall face itself is visible
    expect(at(1500)).toBe(0); // shadowed
    expect(at(4000)).toBe(0); // still shadowed
  });

  it("high ground behind a low wall comes back into view", () => {
    // 20 m rise at 1 km, then a slope climbing from 3 km on.
    const elev = (d: number) => {
      if (d >= 3000) return 100 + (d - 3000) * 0.2; // keeps rising -> stays visible
      if (d >= 1000 && d < 1100) return 120;
      return 100;
    };
    const r = sweepViewshed(100, elev, OPTS);
    const at = (d: number) => r.visible[Math.round(d / OPTS.stepM) - 1];
    expect(at(2000)).toBe(0); // valley hidden behind the rise
    expect(at(3500)).toBe(1); // the rising slope clears the rise
    expect(at(5000)).toBe(1); // and keeps clearing it
  });

  it("unknown elevation neither blocks nor shows", () => {
    const r = sweepViewshed(100, (d) => (d < 1000 ? null : 100), OPTS);
    const at = (d: number) => r.visible[Math.round(d / OPTS.stepM) - 1];
    expect(at(500)).toBe(0); // unknown -> not drawn as visible
    expect(at(1500)).toBe(1); // and it didn't create a phantom wall either
  });

  it("rays are independent", () => {
    // Wall only on ray 0.
    const r = sweepViewshed(
      100,
      (d, ray) => (ray === 0 && d >= 500 && d < 550 ? 200 : 100),
      OPTS
    );
    const at = (ray: number, d: number) =>
      r.visible[ray * OPTS.steps + Math.round(d / OPTS.stepM) - 1];
    expect(at(0, 2000)).toBe(0);
    expect(at(1, 2000)).toBe(1);
  });
});
