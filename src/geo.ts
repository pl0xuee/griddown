// Shared geodesic maths — one implementation, used by every tool that needs it.
//
// Extracted from measure.ts when the mesh panel needed the same distance and
// bearing. Two copies of a bearing formula is exactly the sort of thing that
// stays consistent right up until one of them is fixed.

export type LL = [number, number]; // lng, lat

export const EARTH_R = 6378137; // WGS84 equatorial radius, m

export const toRad = (d: number) => (d * Math.PI) / 180;
export const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversine(a: LL, b: LL): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial (forward) bearing from a to b, degrees 0–360 clockwise from north. */
export function bearing(a: LL, b: LL): number {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const DIRS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** Compass point for a bearing, e.g. 100° → "E". */
export function cardinal(deg: number): string {
  // A NaN bearing indexed the table with NaN and returned undefined, which the
  // readout then printed as the literal word "undefined" next to "NaN°". An
  // em dash says the same thing without pretending to be a direction.
  if (!Number.isFinite(deg)) return "—";
  return DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Geodesic area of a closed ring (m²), magnitude. Lives here rather than in
 *  measure.ts so it can be tested without a map. */
export function ringArea(pts: LL[]): number {
  const n = pts.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [lng1, lat1] = pts[i];
    const [lng2, lat2] = pts[(i + 1) % n];
    // Shortest way round, not the arithmetic difference. MapLibre hands back
    // wrapped longitudes, so a ring straddling the antimeridian gives
    // lng2 - lng1 = -359.8 where the leg is +0.2 — and a 305 km box in the
    // Aleutians read 549,004 km. haversine and bearing are periodic and were
    // never affected, so distance and bearing stayed right while Area alone
    // went absurd.
    let dLng = lng2 - lng1;
    if (dLng > 180) dLng -= 360;
    else if (dLng < -180) dLng += 360;
    total += toRad(dLng) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((total * EARTH_R * EARTH_R) / 2);
}

/**
 * A point a fraction of the way along the great circle from `a` to `b`.
 *
 * Interpolating linearly in lng/lat is not the same line the distances are
 * measured along: everything here reports great-circle metres, so a profile
 * sampled on the straight lng/lat line was labelled with another line's
 * distances. On a 100-mile east-west leg at 45 N the midpoint was 508 m out.
 */
export function interpolate(a: LL, b: LL, f: number): LL {
  const la1 = toRad(a[1]);
  const lo1 = toRad(a[0]);
  const la2 = toRad(b[1]);
  const lo2 = toRad(b[0]);
  const d =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin((la2 - la1) / 2) ** 2 +
            Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2
        )
      )
    );
  // Coincident, or near enough that sin(d) is not worth dividing by.
  if (!(d > 1e-12)) return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
  const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
  const z = A * Math.sin(la1) + B * Math.sin(la2);
  return [toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.hypot(x, y)))];
}
