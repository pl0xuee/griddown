import { describe, it, expect } from "vitest";
import { assessGaps, fillGaps, longestNullRun, MAX_FILL_RUN } from "../src/profile";

// Regression cover for the "invented terrain" bug: the elevation profile drew a
// complete-looking chart, a climb figure and a line-of-sight verdict from as
// few as 2 real samples out of 256, because the only guard was "at least 2
// known" and the gap filler interpolated across runs of any length.

describe("longestNullRun", () => {
  it("measures the worst run, not the count of gaps", () => {
    expect(longestNullRun([1, null, 2, null, 3])).toBe(1);
    expect(longestNullRun([1, null, null, null, 2])).toBe(3);
    expect(longestNullRun([1, 2, 3])).toBe(0);
  });

  it("counts runs at the very start and end", () => {
    expect(longestNullRun([null, null, 1])).toBe(2);
    expect(longestNullRun([1, null, null])).toBe(2);
    expect(longestNullRun([null, null, null])).toBe(3);
  });

  it("handles an empty profile", () => {
    expect(longestNullRun([])).toBe(0);
  });
});

describe("assessGaps", () => {
  it("trusts a profile whose gaps are short dropouts", () => {
    const r = assessGaps([100, null, 102, 103, null, 105]);
    expect(r.trustworthy).toBe(true);
    expect(r.gapRun).toBe(1);
    expect(r.missingPct).toBe(33);
  });

  it("does NOT trust a profile bridged across a long gap", () => {
    // The bug: 2 real samples, everything else invented.
    const raw = [100, ...Array(20).fill(null), 300] as (number | null)[];
    const r = assessGaps(raw);
    expect(r.trustworthy).toBe(false);
    expect(r.gapRun).toBe(20);
    expect(r.missingPct).toBe(91);
  });

  it("draws the line exactly at MAX_FILL_RUN", () => {
    const atLimit = [1, ...Array(MAX_FILL_RUN).fill(null), 2] as (number | null)[];
    const overLimit = [1, ...Array(MAX_FILL_RUN + 1).fill(null), 2] as (number | null)[];
    expect(assessGaps(atLimit).trustworthy).toBe(true);
    expect(assessGaps(overLimit).trustworthy).toBe(false);
  });

  it("treats a profile with no data at all as untrustworthy", () => {
    const r = assessGaps([null, null, null, null]);
    expect(r.trustworthy).toBe(false);
    expect(r.missingPct).toBe(100);
  });

  it("reports a complete profile as fully trustworthy", () => {
    const r = assessGaps([1, 2, 3, 4]);
    expect(r.trustworthy).toBe(true);
    expect(r.missingPct).toBe(0);
    expect(r.gapRun).toBe(0);
  });
});

describe("fillGaps", () => {
  it("interpolates linearly between known neighbours", () => {
    expect(fillGaps([100, null, 200])).toEqual([100, 150, 200]);
    expect(fillGaps([0, null, null, 300])).toEqual([0, 100, 200, 300]);
  });

  it("extends flat past the ends, which is why long end-gaps are disclosed", () => {
    // Extending flat is a blunter invention than interpolating between two
    // known values — there is nothing to interpolate towards. A short run of it
    // is tolerated like any other dropout; a long one has to be disclosed, and
    // that judgement belongs to assessGaps, not to fillGaps refusing to draw.
    expect(fillGaps([null, null, 50])).toEqual([50, 50, 50]);
    expect(fillGaps([50, null, null])).toEqual([50, 50, 50]);
    // Short end-gap: within tolerance, drawn without comment.
    expect(assessGaps([null, null, 50]).trustworthy).toBe(true);
    // Long end-gap: flat-extended over most of the path, so it must be flagged.
    const longTail = [50, ...Array(30).fill(null)] as (number | null)[];
    expect(fillGaps(longTail).every((v) => v === 50)).toBe(true);
    expect(assessGaps(longTail).trustworthy).toBe(false);
  });

  it("leaves a complete profile untouched", () => {
    expect(fillGaps([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("returns all-null unchanged rather than inventing a value", () => {
    expect(fillGaps([null, null])).toEqual([null, null]);
  });

  it("does not mutate its input", () => {
    const raw: (number | null)[] = [1, null, 3];
    fillGaps(raw);
    expect(raw).toEqual([1, null, 3]);
  });
});
