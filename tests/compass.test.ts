import { describe, it, expect } from "vitest";
import { cardinal } from "../src/compass";

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
