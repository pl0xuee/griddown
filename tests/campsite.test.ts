import { describe, it, expect } from "vitest";
import { scoreCamp } from "../src/campsite";

const base = {
  slopeDeg: 3,
  waterMeters: 300,
  treeCover: true,
  land: "public" as const,
  wetland: false,
};

describe("scoreCamp", () => {
  it("calls a flat, wooded, public spot near water a good camp", () => {
    const r = scoreCamp(base);
    expect(r.verdict).toBe("good");
    expect(r.reasons.join(" ")).toMatch(/flat/i);
  });

  it("always says to avoid a military reservation, whatever else is true", () => {
    const r = scoreCamp({ ...base, land: "military" });
    expect(r.verdict).toBe("avoid");
    expect(r.reasons[0]).toMatch(/military/i);
  });

  it("avoids steep ground even if everything else is ideal", () => {
    const r = scoreCamp({ ...base, slopeDeg: 28 });
    expect(r.verdict).toBe("avoid");
    expect(r.reasons.join(" ")).toMatch(/steep/i);
  });

  it("warns when right on the water (flood & cold air)", () => {
    const r = scoreCamp({ ...base, waterMeters: 10 });
    expect(r.reasons.join(" ")).toMatch(/flood|cold air|back off/i);
    expect(r.verdict).not.toBe("good");
  });

  it("penalises no water within range", () => {
    const dry = scoreCamp({ ...base, waterMeters: null });
    const wet = scoreCamp(base);
    expect(dry.reasons.join(" ")).toMatch(/carry it in|no water/i);
    expect(["fair", "poor"]).toContain(dry.verdict);
    expect(wet.verdict).toBe("good"); // sanity: the only change dropped it
  });

  it("downgrades wetland ground", () => {
    const r = scoreCamp({ ...base, wetland: true });
    expect(r.reasons.join(" ")).toMatch(/wetland/i);
    expect(r.verdict).not.toBe("good");
  });

  it("notes missing terrain instead of guessing flatness", () => {
    const r = scoreCamp({ ...base, slopeDeg: null });
    expect(r.reasons.join(" ")).toMatch(/no terrain/i);
  });

  it("flags unknown land ownership as a thing to verify", () => {
    const r = scoreCamp({ ...base, land: "unknown" });
    expect(r.reasons.join(" ")).toMatch(/private|ownership|verify/i);
  });
});
