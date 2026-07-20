import { describe, it, expect } from "vitest";
import { cardinal, shortestTurn } from "../src/compass";

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
