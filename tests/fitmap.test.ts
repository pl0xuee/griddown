import { describe, it, expect } from "vitest";
import { computePadding, type Rect } from "../src/fitmap";

// A 1000×800 map canvas at the top-left of the screen.
const canvas: Rect = {
  left: 0,
  top: 0,
  right: 1000,
  bottom: 800,
  width: 1000,
  height: 800,
};

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top,
});

describe("computePadding", () => {
  it("pads by the gap alone when nothing overlaps the map", () => {
    expect(computePadding(canvas, null, null, 24)).toEqual({
      top: 24,
      bottom: 24,
      left: 24,
      right: 24,
    });
  });

  it("pads the bottom by however much the dock covers", () => {
    // Dock occupies the bottom 103 px of the canvas.
    const p = computePadding(canvas, rect(0, 697, 1000, 800), null, 24);
    expect(p.bottom).toBe(24 + 103);
    expect(p.top).toBe(24);
  });

  it("ignores a dock that sits below the map entirely", () => {
    expect(computePadding(canvas, rect(0, 800, 1000, 900), null, 24).bottom).toBe(24);
  });

  it("pads the left when a panel sits against the left edge", () => {
    const p = computePadding(canvas, null, rect(0, 0, 320, 800), 24);
    expect(p.left).toBe(24 + 320);
    expect(p.right).toBe(24);
  });

  it("pads the right when a panel sits against the right edge", () => {
    const p = computePadding(canvas, null, rect(680, 0, 1000, 800), 24);
    expect(p.right).toBe(24 + 320);
    expect(p.left).toBe(24);
  });

  it("ignores a panel that covers most of the map", () => {
    // On a phone the panel is the whole screen — padding around it would leave
    // nothing to fit into.
    const p = computePadding(canvas, null, rect(0, 0, 1000, 800), 24);
    expect(p).toEqual({ top: 24, bottom: 24, left: 24, right: 24 });
  });

  it("never pads more than half the viewport", () => {
    // A dock taller than the map, which the caps exist to survive.
    const p = computePadding(canvas, rect(0, 0, 1000, 800), null, 24);
    expect(p.bottom).toBeLessThanOrEqual((canvas.height - 40) / 2);
    expect(p.bottom).toBeGreaterThan(0);
  });

  it("never returns a negative padding", () => {
    const tiny: Rect = { left: 0, top: 0, right: 30, bottom: 30, width: 30, height: 30 };
    const p = computePadding(tiny, rect(0, 0, 30, 30), null, 24);
    for (const v of Object.values(p)) expect(v).toBeGreaterThanOrEqual(0);
  });
});
