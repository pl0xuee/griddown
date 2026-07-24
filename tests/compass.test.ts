import { describe, it, expect } from "vitest";
import { cardinal, headingFrom, shortestTurn } from "../src/compass";

/** A DeviceOrientationEvent-shaped bag, without constructing a real event. */
const ev = (o: Record<string, unknown>) => o as unknown as DeviceOrientationEvent;

describe("cardinal", () => {
  it("maps the four cardinal points", () => {
    expect(cardinal(0)).toBe("N");
    expect(cardinal(90)).toBe("E");
    expect(cardinal(180)).toBe("S");
    expect(cardinal(270)).toBe("W");
  });

  it("rounds to the nearest of 16 points", () => {
    expect(cardinal(11)).toBe("N");
    expect(cardinal(12)).toBe("NNE");
    expect(cardinal(359)).toBe("N");
    expect(cardinal(202.5)).toBe("SSW");
  });

  it("normalizes out-of-range headings", () => {
    expect(cardinal(360)).toBe("N");
    expect(cardinal(450)).toBe("E");
    expect(cardinal(-90)).toBe("W");
  });
});

describe("headingFrom", () => {
  /**
   * This is the whole sensor-to-heading conversion, and the W3C branch is an
   * INVERSION: `alpha` is the device's rotation about its vertical axis measured
   * COUNTER-clockwise from north, so the compass heading is 360 - alpha. Drop
   * the inversion and the needle is mirrored east-for-west — which looks
   * completely normal on screen, and walks you the wrong way.
   *
   * The expected values below are read off that definition, not off the code:
   * a device rotated 90° counter-clockwise from north is facing WEST, 270°.
   */
  it("takes webkitCompassHeading as-is, since iOS already reports a heading", () => {
    expect(headingFrom(ev({ webkitCompassHeading: 90 }))).toBe(90);
    expect(headingFrom(ev({ webkitCompassHeading: 0 }))).toBe(0);
    expect(headingFrom(ev({ webkitCompassHeading: 359.5 }))).toBe(359.5);
  });

  it("inverts alpha, which counts the other way round", () => {
    // Asymmetric on purpose: 90 and 270 are the pair a dropped inversion cannot
    // fake, since alpha === heading only at 0 and 180.
    expect(headingFrom(ev({ absolute: true, alpha: 90 }))).toBe(270);
    expect(headingFrom(ev({ absolute: true, alpha: 270 }))).toBe(90);
    expect(headingFrom(ev({ absolute: true, alpha: 0 }))).toBe(0);
    expect(headingFrom(ev({ absolute: true, alpha: 180 }))).toBe(180);
  });

  it("refuses a relative reading, which is not referenced to north at all", () => {
    expect(headingFrom(ev({ absolute: false, alpha: 90 }))).toBeNull();
    expect(headingFrom(ev({ alpha: 90 }))).toBeNull();
  });

  it("refuses a reading with no angle in it", () => {
    expect(headingFrom(ev({ absolute: true, alpha: null }))).toBeNull();
    expect(headingFrom(ev({}))).toBeNull();
  });

  it("treats a negative webkitCompassHeading as uncalibrated, not as a heading", () => {
    // iOS reports -1 when the magnetometer has no fix yet. Passing that through
    // would point the needle at 359°, i.e. north, with total confidence.
    expect(headingFrom(ev({ webkitCompassHeading: -1 }))).toBeNull();
    expect(headingFrom(ev({ webkitCompassHeading: -1, absolute: true, alpha: 90 }))).toBe(270);
  });

  it("reads west when the device is turned 90° counter-clockwise", () => {
    // The chain as the panel uses it: sensor → heading → the letter on screen.
    expect(cardinal(headingFrom(ev({ absolute: true, alpha: 90 }))!)).toBe("W");
    expect(cardinal(headingFrom(ev({ absolute: true, alpha: 270 }))!)).toBe("E");
  });
});

describe("shortestTurn", () => {
  it("crosses north the short way, not the long way round", () => {
    // The bug: the needle spun 358° backwards walking past north, then
    // unwound again coming back, because CSS interpolates the raw number.
    expect(shortestTurn(-359, -1)).toBe(-2);
    expect(shortestTurn(-1, -359)).toBe(2);
    expect(shortestTurn(359, 1)).toBe(2);
    expect(shortestTurn(1, 359)).toBe(-2);
  });

  it("never asks for more than half a turn", () => {
    for (let from = -720; from <= 720; from += 7) {
      for (let to = -720; to <= 720; to += 13) {
        const step = shortestTurn(from, to);
        expect(Math.abs(step)).toBeLessThanOrEqual(180);
        // And it must actually land on the target direction.
        expect((((from + step - to) % 360) + 360) % 360).toBe(0);
      }
    }
  });

  it("accumulates continuously through repeated full turns", () => {
    let angle = 0;
    // Walk a full circle in 10° steps, twice round.
    for (let i = 1; i <= 72; i++) {
      angle += shortestTurn(angle, -((i * 10) % 360));
    }
    // Two full turns clockwise: the running angle keeps going rather than
    // snapping back, which is what stops the needle unwinding.
    expect(angle).toBe(-720);
  });

  it("picks a direction for an exact half turn rather than stalling", () => {
    expect(Math.abs(shortestTurn(0, 180))).toBe(180);
  });
});
