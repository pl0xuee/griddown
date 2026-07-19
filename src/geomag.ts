// Magnetic declination — the angle between the compass needle and true north.
//
// A compass points at the magnetic pole, a paper map is drawn to true north,
// and in the western US the two disagree by 10-15°. Over ten miles that is a
// mile and a half off course, so any bearing taken from the map and walked on
// the compass (or the reverse) needs this correction.
//
// This is the NOAA World Magnetic Model: a degree-12 spherical harmonic
// expansion of the main field, with a linear secular-variation term that
// carries it forward from the model epoch. Coefficients live in wmm2025.ts,
// machine-transcribed from NOAA's WMM.COF. Everything here is arithmetic — no
// network, no data files, which is the point.
//
// Reference: WMM2025 Technical Report, NOAA/NCEI (public domain).

import {
  WMM_EPOCH,
  WMM_MODEL,
  WMM_MAX_N,
  WMM_G,
  WMM_H,
  WMM_GDOT,
  WMM_HDOT,
} from "./wmm2025";

// WGS84 ellipsoid, and the geomagnetic reference radius the model is defined on.
const A = 6378.137; // semi-major axis, km
const F = 1 / 298.257223563; // flattening
const B = A * (1 - F); // semi-minor axis, km
const RE = 6371.2; // geomagnetic reference radius, km

const DEG = Math.PI / 180;

/** Index into the flattened coefficient arrays. */
const ix = (n: number, m: number) => (n * (n + 1)) / 2 + m;

export interface MagField {
  /** Declination: degrees east of true north (negative = west). */
  declination: number;
  /** Inclination / dip angle, degrees below horizontal. */
  inclination: number;
  /** Total field intensity, nT. */
  intensity: number;
}

/** Decimal year, e.g. 2026.54 — the model's time coordinate. */
export function decimalYear(d: Date): number {
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (d.getTime() - start) / (end - start);
}

/** Years outside which the model is no longer valid. */
export const WMM_VALID_FROM = WMM_EPOCH;
export const WMM_VALID_TO = WMM_EPOCH + 5;
export const WMM_NAME = WMM_MODEL;

/**
 * Schmidt semi-normalised associated Legendre functions P(n,m)(sin φ') and
 * their derivatives with respect to φ', for all n ≤ WMM_MAX_N.
 *
 * Built from the unnormalised recursions and scaled, rather than using the
 * normalised recursions directly: at degree 12 the intermediate magnitudes are
 * nowhere near double precision's limits, and this form is far easier to check
 * against the textbook definitions.
 */
function legendre(sinPhi: number, cosPhi: number) {
  const size = ((WMM_MAX_N + 1) * (WMM_MAX_N + 2)) / 2;
  const P = new Float64Array(size);
  const dP = new Float64Array(size);

  // P(m,m) = (2m-1)!! · cos^m φ', then P(m+1,m), then the general recursion.
  P[ix(0, 0)] = 1;
  for (let m = 1; m <= WMM_MAX_N; m++) {
    P[ix(m, m)] = (2 * m - 1) * cosPhi * P[ix(m - 1, m - 1)];
  }
  for (let m = 0; m < WMM_MAX_N; m++) {
    P[ix(m + 1, m)] = (2 * m + 1) * sinPhi * P[ix(m, m)];
  }
  for (let n = 2; n <= WMM_MAX_N; n++) {
    for (let m = 0; m <= n - 2; m++) {
      P[ix(n, m)] =
        ((2 * n - 1) * sinPhi * P[ix(n - 1, m)] - (n + m - 1) * P[ix(n - 2, m)]) /
        (n - m);
    }
  }

  // dP/dφ' from the standard identity
  //   cos φ' · dP(n,m)/dφ' = -n·sin φ'·P(n,m) + (n+m)·P(n-1,m).
  // Singular at the geographic poles; cosPhi is clamped by the caller.
  for (let n = 0; n <= WMM_MAX_N; n++) {
    for (let m = 0; m <= n; m++) {
      const prev = m <= n - 1 ? P[ix(n - 1, m)] : 0;
      dP[ix(n, m)] = (-n * sinPhi * P[ix(n, m)] + (n + m) * prev) / cosPhi;
    }
  }

  // Schmidt semi-normalisation: √( (2-δ(m,0)) · (n-m)! / (n+m)! ).
  for (let n = 1; n <= WMM_MAX_N; n++) {
    for (let m = 0; m <= n; m++) {
      let s = m === 0 ? 1 : Math.SQRT2;
      for (let k = n - m + 1; k <= n + m; k++) s /= Math.sqrt(k);
      P[ix(n, m)] *= s;
      dP[ix(n, m)] *= s;
    }
  }

  return { P, dP };
}

/**
 * The geomagnetic field at a point.
 *
 * @param latDeg  geodetic latitude, degrees north
 * @param lonDeg  longitude, degrees east
 * @param altKm   height above the WGS84 ellipsoid, km
 * @param date    when — the field drifts, hence the secular-variation term
 */
export function magneticField(
  latDeg: number,
  lonDeg: number,
  altKm = 0,
  date: Date = new Date()
): MagField {
  const t = decimalYear(date) - WMM_EPOCH;

  // Right at a pole the east component is 1/cos φ' — undefined, not merely
  // large. Nudging off the pole keeps a finite answer where declination is
  // close to meaningless anyway, instead of returning NaN.
  const lat = Math.min(Math.max(latDeg, -89.9999), 89.9999);
  const phi = lat * DEG;
  const lambda = lonDeg * DEG;

  // Geodetic → geocentric spherical.
  const sinP = Math.sin(phi);
  const cosP = Math.cos(phi);
  const e2 = 1 - (B * B) / (A * A);
  const Rc = A / Math.sqrt(1 - e2 * sinP * sinP);
  const p = (Rc + altKm) * cosP;
  const z = (Rc * (1 - e2) + altKm) * sinP;
  const r = Math.hypot(p, z);
  const phiPrime = Math.asin(z / r);
  const sinPhi = Math.sin(phiPrime);
  const cosPhi = Math.cos(phiPrime);

  const { P, dP } = legendre(sinPhi, cosPhi);

  // Precompute cos(mλ), sin(mλ).
  const cosM = new Float64Array(WMM_MAX_N + 1);
  const sinM = new Float64Array(WMM_MAX_N + 1);
  for (let m = 0; m <= WMM_MAX_N; m++) {
    cosM[m] = Math.cos(m * lambda);
    sinM[m] = Math.sin(m * lambda);
  }

  // B = -∇V, which is where the leading minus on the north component comes
  // from: g(1,0) is about -29,000 nT, and without it north comes out negative
  // and every declination lands 180° out.
  let Xp = 0; // north, geocentric
  let Yp = 0; // east
  let Zp = 0; // down
  const ratio = RE / r;
  let pow = ratio * ratio; // (RE/r)^(n+2), starting at n=0

  for (let n = 1; n <= WMM_MAX_N; n++) {
    pow *= ratio;
    for (let m = 0; m <= n; m++) {
      const i = ix(n, m);
      const g = WMM_G[i] + t * WMM_GDOT[i];
      const h = WMM_H[i] + t * WMM_HDOT[i];
      const gc = g * cosM[m] + h * sinM[m];
      Xp -= pow * gc * dP[i];
      Yp += (pow * m * (g * sinM[m] - h * cosM[m]) * P[i]) / cosPhi;
      Zp -= pow * (n + 1) * gc * P[i];
    }
  }

  // Rotate from geocentric back to geodetic (they differ by up to ~0.19°).
  const d = phiPrime - phi;
  const X = Xp * Math.cos(d) - Zp * Math.sin(d);
  const Y = Yp;
  const Z = Xp * Math.sin(d) + Zp * Math.cos(d);

  const H = Math.hypot(X, Y);
  return {
    declination: Math.atan2(Y, X) / DEG,
    inclination: Math.atan2(Z, H) / DEG,
    intensity: Math.hypot(H, Z),
  };
}

/** Just the declination, degrees east of true north. */
export function declination(
  latDeg: number,
  lonDeg: number,
  date: Date = new Date()
): number {
  return magneticField(latDeg, lonDeg, 0, date).declination;
}

/** True heading from a magnetic one: declination east means true is greater. */
export function magneticToTrue(magneticDeg: number, declinationDeg: number): number {
  return ((magneticDeg + declinationDeg) % 360 + 360) % 360;
}

/** Magnetic heading to steer for a given true bearing. */
export function trueToMagnetic(trueDeg: number, declinationDeg: number): number {
  return ((trueDeg - declinationDeg) % 360 + 360) % 360;
}

/** "13.4° E" — how declination is written on a map legend. */
export function formatDeclination(deg: number): string {
  const a = Math.abs(deg);
  if (a < 0.05) return "0°";
  return `${a.toFixed(1)}° ${deg > 0 ? "E" : "W"}`;
}

/** Whether the model still covers this date; it is only issued for five years. */
export function modelValidFor(date: Date = new Date()): boolean {
  const y = decimalYear(date);
  return y >= WMM_VALID_FROM && y < WMM_VALID_TO;
}
