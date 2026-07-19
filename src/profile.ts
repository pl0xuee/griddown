// Gap handling for the elevation profile — pure, so it can be tested.
//
// This exists because of a real bug: the profile's only guard was "at least 2
// known samples", while the gap filler happily interpolated across runs of ANY
// length and extended flat past the ends. Two real samples out of 256 produced
// a complete-looking profile, a climb figure, and a line-of-sight verdict of
// "Blocked at 0.59 mi" — a precise measurement of ground that was never
// sampled. Extracted from measure.ts so the rule that stops it is covered by
// tests rather than living inside a DOM callback.

/** Longest run of consecutive missing samples — how far a fill has to reach. */
export function longestNullRun(v: readonly (number | null)[]): number {
  let worst = 0;
  let run = 0;
  for (const m of v) {
    run = m == null ? run + 1 : 0;
    if (run > worst) worst = run;
  }
  return worst;
}

/** Fill null samples by linear interpolation between known neighbours. */
export function fillGaps(v: readonly (number | null)[]): (number | null)[] {
  const out = v.slice();
  for (let i = 0; i < out.length; i++) {
    if (out[i] != null) continue;
    let lo = i - 1;
    while (lo >= 0 && out[lo] == null) lo--;
    let hi = i + 1;
    while (hi < out.length && out[hi] == null) hi++;
    if (lo >= 0 && hi < out.length) {
      const f = (i - lo) / (hi - lo);
      out[i] = (out[lo] as number) + ((out[hi] as number) - (out[lo] as number)) * f;
    } else if (lo >= 0) out[i] = out[lo];
    else if (hi < out.length) out[i] = out[hi];
  }
  return out;
}

/** Fills longer than this are disclosed, not silently drawn as measurements. */
export const MAX_FILL_RUN = 3; // ~60 m at the profile's ~20 m sample spacing

export interface GapReport {
  /** Percentage of samples with no terrain data, 0-100. */
  missingPct: number;
  /** Longest consecutive run of missing samples. */
  gapRun: number;
  /**
   * True when every gap is short enough to bridge honestly. When false the
   * profile may still be drawn, but it must say it is interpolated, and the
   * line-of-sight verdict must be withheld — "Visible" and "Blocked at 0.59 mi"
   * both read as measurements, and neither is one over invented ground.
   */
  trustworthy: boolean;
}

export function assessGaps(raw: readonly (number | null)[]): GapReport {
  const known = raw.filter((m) => m != null).length;
  const gapRun = longestNullRun(raw);
  return {
    missingPct: raw.length ? Math.round(((raw.length - known) / raw.length) * 100) : 0,
    gapRun,
    trustworthy: gapRun <= MAX_FILL_RUN,
  };
}
