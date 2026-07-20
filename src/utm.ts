// UTM, so a printed map can carry a real grid.
//
// A printed map with a scale bar but no grid is a picture. A grid is what lets
// you take a bearing with a protractor, read off a six-figure reference, and
// say it over a radio to someone holding a different map — which is the whole
// reason to print one before the battery dies.
//
// MGRS squares are aligned to UTM, not to latitude and longitude, and the two
// differ by grid convergence — up to a couple of degrees at the edge of a zone.
// Drawing a lat/long lattice and calling it a grid would be wrong in exactly
// the way that matters: the lines would not be the lines on anyone else's map.
// So this does the real projection.
//
// Formulas are the standard Redfearn series (Snyder, USGS Professional Paper
// 1395), accurate to millimetres within a zone — far beyond what a printed page
// can show. Verified against the `mgrs` package in tests rather than trusted.

const A = 6378137.0; // WGS84 semi-major axis, m
const F = 1 / 298.257223563;
const K0 = 0.9996; // UTM scale factor on the central meridian
const E2 = F * (2 - F); // first eccentricity squared
const EP2 = E2 / (1 - E2); // second eccentricity squared

const DEG = Math.PI / 180;

export interface UtmPoint {
  easting: number;
  northing: number;
  zone: number;
  /** True for the northern hemisphere — northing is measured differently. */
  north: boolean;
}

/** The UTM zone a longitude falls in (1-60). */
export function utmZone(lonDeg: number): number {
  const lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  return Math.floor((lon + 180) / 6) + 1;
}

/** Central meridian of a zone, in degrees. */
export function zoneMeridian(zone: number): number {
  return (zone - 1) * 6 - 180 + 3;
}

/**
 * Geodetic → UTM.
 *
 * @param zoneOverride force a zone, so a map spanning a zone boundary stays on
 *        one grid rather than jumping mid-page — which is what paper maps do.
 */
export function latLonToUtm(latDeg: number, lonDeg: number, zoneOverride?: number): UtmPoint {
  const zone = zoneOverride ?? utmZone(lonDeg);
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const lon0 = zoneMeridian(zone) * DEG;

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const tanLat = Math.tan(lat);

  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const T = tanLat * tanLat;
  const C = EP2 * cosLat * cosLat;
  let dLon = lon - lon0;
  // Keep the longitude difference in (-π, π]; without this a map near the
  // antimeridian projects to the far side of the world.
  if (dLon > Math.PI) dLon -= 2 * Math.PI;
  if (dLon < -Math.PI) dLon += 2 * Math.PI;
  const Aa = cosLat * dLon;

  // Meridional arc.
  const M =
    A *
    ((1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256) * lat -
      ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 * E2 * E2) / 1024) * Math.sin(2 * lat) +
      ((15 * E2 * E2) / 256 + (45 * E2 * E2 * E2) / 1024) * Math.sin(4 * lat) -
      ((35 * E2 * E2 * E2) / 3072) * Math.sin(6 * lat));

  const easting =
    K0 *
      N *
      (Aa +
        ((1 - T + C) * Aa * Aa * Aa) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa * Aa * Aa * Aa * Aa) / 120) +
    500000.0;

  let northing =
    K0 *
    (M +
      N *
        tanLat *
        ((Aa * Aa) / 2 +
          ((5 - T + 9 * C + 4 * C * C) * Aa * Aa * Aa * Aa) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa * Aa * Aa * Aa * Aa * Aa) / 720));

  const north = latDeg >= 0;
  if (!north) northing += 10000000.0; // false northing, southern hemisphere

  return { easting, northing, zone, north };
}

/** UTM → geodetic. */
export function utmToLatLon(p: UtmPoint): { lat: number; lon: number } {
  const x = p.easting - 500000.0;
  const y = p.north ? p.northing : p.northing - 10000000.0;

  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 * e1 * e1) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 * e1 * e1 * e1) / 32) * Math.sin(4 * mu) +
    ((151 * e1 * e1 * e1) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 * e1 * e1 * e1) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const C1 = EP2 * cosPhi1 * cosPhi1;
  const T1 = tanPhi1 * tanPhi1;
  const N1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1);
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * sinPhi1 * sinPhi1, 1.5);
  const D = x / (N1 * K0);

  const lat =
    phi1 -
    ((N1 * tanPhi1) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D * D * D * D) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) *
          D *
          D *
          D *
          D *
          D *
          D) /
          720);

  const lon =
    zoneMeridian(p.zone) * DEG +
    (D -
      ((1 + 2 * T1 + C1) * D * D * D) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D * D * D * D * D) / 120) /
      cosPhi1;

  return { lat: lat / DEG, lon: lon / DEG };
}

/** A grid spacing that gives a usable number of squares at this scale. */
export function gridSpacing(widthMeters: number): number {
  // Aim for roughly 6-14 lines across the page. Only round MGRS-friendly
  // spacings are offered, because a grid at 2.5 km is no use for reading a
  // standard reference off.
  for (const step of [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000]) {
    if (widthMeters / step <= 14) return step;
  }
  return 100000;
}

export interface GridLine {
  /** Points along the line, in [lng, lat]. */
  points: Array<[number, number]>;
  /** The UTM coordinate this line holds constant, in metres. */
  value: number;
  axis: "easting" | "northing";
}

/**
 * Grid lines crossing a bounding box, as lat/long polylines.
 *
 * The lines are generated in UTM and converted point by point, so they come out
 * very slightly curved on the page — which is correct. That curve IS grid
 * convergence, the difference between grid north and true north, and it is the
 * thing a straight lat/long lattice would quietly throw away.
 */
export function gridLines(
  bounds: { west: number; south: number; east: number; north: number },
  spacingM: number,
  steps = 8
): GridLine[] {
  const centerLon = (bounds.west + bounds.east) / 2;
  const zone = utmZone(centerLon);
  const northHemi = (bounds.south + bounds.north) / 2 >= 0;

  // Project all four corners: the UTM extent of a lat/long box is not itself a
  // box, so taking only two corners would clip the grid on one side.
  const corners = [
    latLonToUtm(bounds.south, bounds.west, zone),
    latLonToUtm(bounds.south, bounds.east, zone),
    latLonToUtm(bounds.north, bounds.west, zone),
    latLonToUtm(bounds.north, bounds.east, zone),
  ];
  const minE = Math.min(...corners.map((c) => c.easting));
  const maxE = Math.max(...corners.map((c) => c.easting));
  const minN = Math.min(...corners.map((c) => c.northing));
  const maxN = Math.max(...corners.map((c) => c.northing));

  const out: GridLine[] = [];
  const firstE = Math.ceil(minE / spacingM) * spacingM;
  const firstN = Math.ceil(minN / spacingM) * spacingM;

  for (let e = firstE; e <= maxE; e += spacingM) {
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const n = minN + ((maxN - minN) * i) / steps;
      const { lat, lon } = utmToLatLon({ easting: e, northing: n, zone, north: northHemi });
      points.push([lon, lat]);
    }
    out.push({ points, value: e, axis: "easting" });
  }
  for (let n = firstN; n <= maxN; n += spacingM) {
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const e = minE + ((maxE - minE) * i) / steps;
      const { lat, lon } = utmToLatLon({ easting: e, northing: n, zone, north: northHemi });
      points.push([lon, lat]);
    }
    out.push({ points, value: n, axis: "northing" });
  }
  return out;
}

/**
 * The label for a grid line: the two digits that identify it within its 100 km
 * square, which is how a grid reference is read aloud.
 */
export function gridLabel(value: number, spacingM: number): string {
  const within = Math.round(value) % 100000;
  if (spacingM >= 100000) return String(Math.round(value / 100000));
  if (spacingM >= 1000) return String(Math.floor(within / 1000)).padStart(2, "0");
  return String(Math.floor(within / 100)).padStart(3, "0");
}
