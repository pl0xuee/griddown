import { describe, it, expect } from "vitest";
import { areaId, bboxFrom, bboxSqMi } from "../src/customarea";

describe("bboxFrom", () => {
  it("normalises whichever corners you tapped first", () => {
    const a: [number, number] = [-121.5, 45.5];
    const b: [number, number] = [-121.0, 45.0];
    // Same box regardless of tap order.
    expect(bboxFrom(a, b)).toEqual([-121.5, 45.0, -121.0, 45.5]);
    expect(bboxFrom(b, a)).toEqual([-121.5, 45.0, -121.0, 45.5]);
  });

  it("survives a degenerate box (both taps in the same place)", () => {
    expect(bboxFrom([-121, 45], [-121, 45])).toEqual([-121, 45, -121, 45]);
  });

  it("handles negative and positive longitudes together", () => {
    expect(bboxFrom([-1, -1], [1, 1])).toEqual([-1, -1, 1, 1]);
  });
});

describe("bboxSqMi", () => {
  it("shrinks longitude with latitude", () => {
    // One degree square is much smaller in area near the pole than the equator.
    const equator = bboxSqMi([0, 0, 1, 1]);
    const north = bboxSqMi([0, 60, 1, 61]);
    expect(north).toBeLessThan(equator / 1.5);
  });

  it("is roughly right for a one-degree square at the equator", () => {
    // ~69 mi x ~69 mi.
    expect(bboxSqMi([0, 0, 1, 1])).toBeGreaterThan(4000);
    expect(bboxSqMi([0, 0, 1, 1])).toBeLessThan(5200);
  });

  it("returns zero area for a degenerate box", () => {
    expect(bboxSqMi([-121, 45, -121, 45])).toBe(0);
  });
});

describe("areaId", () => {
  it("makes a filesystem-safe id from a name", () => {
    expect(areaId("Mt Hood area", [])).toBe("MT_HOOD_AREA");
    expect(areaId("  spaces  ", [])).toBe("SPACES");
  });

  it("strips characters that could escape a path", () => {
    // safe_abbr on the Rust side would sanitise too, but an id that survives
    // both layers unchanged is easier to reason about.
    const id = areaId("../../etc/passwd", []);
    expect(id).toMatch(/^[A-Z0-9_]+$/);
    expect(id).not.toContain("/");
    expect(id).not.toContain(".");
  });

  it("never collides with an existing pack, which would overwrite it", () => {
    expect(areaId("Oregon", ["OREGON"])).toBe("OREGON_2");
    expect(areaId("Oregon", ["OREGON", "OREGON_2"])).toBe("OREGON_3");
  });

  it("falls back to a usable id when the name has nothing usable in it", () => {
    expect(areaId("!!!", [])).toBe("AREA");
    expect(areaId("", [])).toBe("AREA");
  });

  it("keeps ids short enough to stay a sane filename", () => {
    expect(areaId("a".repeat(100), []).length).toBeLessThanOrEqual(16);
  });
});
