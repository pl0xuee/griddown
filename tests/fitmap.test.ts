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

const dock = rect(0, 697, 1000, 800); // bottom 103px, as on a phone

describe("computePadding", () => {
  it("pads by the gap alone when nothing overlaps the map", () => {
    expect(computePadding({ canvas })).toEqual({
      top: 24,
      bottom: 24,
      left: 24,
      right: 24,
    });
  });

  it("pads the bottom by however much the dock covers", () => {
    const p = computePadding({ canvas, bottom: [dock] });
    expect(p.bottom).toBe(24 + 103);
    expect(p.top).toBe(24);
  });

  it("ignores chrome that sits below the map entirely", () => {
    expect(computePadding({ canvas, bottom: [rect(0, 800, 1000, 900)] }).bottom).toBe(24);
  });

  /**
   * The on-map recompute button floats ABOVE the dock, so the dock's own box
   * says nothing about it. Fitting to the dock alone put the end of a route
   * behind the very button you press to recompute it.
   */
  it("takes the tallest of several pieces of bottom chrome", () => {
    const recalc = rect(420, 620, 580, 664); // the recompute button, above the dock
    const p = computePadding({ canvas, bottom: [dock, recalc] });
    expect(p.bottom).toBe(24 + (800 - 620));
  });

  it("skips absent chrome without counting it as covering everything", () => {
    const p = computePadding({ canvas, bottom: [null, dock, null] });
    expect(p.bottom).toBe(24 + 103);
  });

  /**
   * Nothing in the DOM reports a notch. Without this the top of a route sits
   * under the status bar on every recent iPhone — which is the one platform
   * this app is actually carried on.
   */
  it("pads for safe-area insets, which no element reports", () => {
    const p = computePadding({ canvas, insets: { top: 59, bottom: 34 } });
    expect(p.top).toBe(24 + 59);
    expect(p.bottom).toBe(24 + 34);
  });

  it("does not double-count a bottom inset the dock already covers", () => {
    // The dock's own box already includes the home-indicator inset it pads for.
    const p = computePadding({ canvas, bottom: [dock], insets: { bottom: 34 } });
    expect(p.bottom).toBe(24 + 103);
  });

  it("pads the side insets a landscape notch takes", () => {
    const p = computePadding({ canvas, insets: { left: 47, right: 47 } });
    expect(p.left).toBe(24 + 47);
    expect(p.right).toBe(24 + 47);
  });

  it("pads the left when a panel sits against the left edge", () => {
    const p = computePadding({ canvas, panel: rect(0, 0, 320, 800) });
    expect(p.left).toBe(24 + 320);
    expect(p.right).toBe(24);
  });

  it("pads the right when a panel sits against the right edge", () => {
    const p = computePadding({ canvas, panel: rect(680, 0, 1000, 800) });
    expect(p.right).toBe(24 + 320);
    expect(p.left).toBe(24);
  });

  it("ignores a panel that covers most of the map", () => {
    // On a phone the panel is the whole screen — padding around it would leave
    // nothing to fit into.
    const p = computePadding({ canvas, panel: rect(0, 0, 1000, 800) });
    expect(p).toEqual({ top: 24, bottom: 24, left: 24, right: 24 });
  });

  it("never pads more than half the viewport", () => {
    const p = computePadding({ canvas, bottom: [rect(0, 0, 1000, 800)] });
    expect(p.bottom).toBeLessThanOrEqual((canvas.height - 40) / 2);
    expect(p.bottom).toBeGreaterThan(0);
  });

  it("never returns a negative padding", () => {
    const tiny: Rect = { left: 0, top: 0, right: 30, bottom: 30, width: 30, height: 30 };
    const p = computePadding({ canvas: tiny, bottom: [rect(0, 0, 30, 30)], insets: { top: 59 } });
    for (const v of Object.values(p)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it("still leaves room to draw in when everything is against it at once", () => {
    // Notch, dock, recompute button and a side panel together must not add up
    // to a box with no width or height left.
    const p = computePadding({
      canvas,
      bottom: [dock, rect(420, 620, 580, 664)],
      panel: rect(680, 0, 1000, 800),
      insets: { top: 59, left: 47, right: 47 },
    });
    expect(canvas.height - p.top - p.bottom).toBeGreaterThan(0);
    expect(canvas.width - p.left - p.right).toBeGreaterThan(0);
  });
});
