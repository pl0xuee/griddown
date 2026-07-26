import maplibregl from "maplibre-gl";
import { toPoint as mgrsToPoint } from "mgrs";

// Jump to a coordinate someone gives you — an MGRS grid ("18T VK 1234 5678")
// or a plain "lat, lng". The inverse of the coordinate readout. Fully offline.
//
// This used to own a panel of its own. It doesn't any more: "Find" takes a
// grid reference or a place name in one box, because in the field you should
// not have to decide which control you need before reading what you were
// handed. What survives here is the parser and the pin, which Find drives.

export interface Coord {
  lng: number;
  lat: number;
  /**
   * Side of the square the reference names, in metres. 0 for a typed lat/lng,
   * which is as exact as it was written.
   *
   * This exists because mgrs.toPoint answers a 100 km square and a 1 m square
   * with the same shape of value: one lat/lng, at the CENTRE. "10T DK 12345
   * 67890" and "10TDK" both parsed, both dropped a pin, and both were reported
   * to five decimal places — so a grid reference read over a radio with the
   * digits dropped put a confident mark up to 70 km from where the person
   * actually was, and nothing on screen said which of the two you had.
   */
  squareM: number;
  kind: "mgrs" | "latlng";
}

/** How big a square each pair of grid digits names. */
const MGRS_SQUARE_M = [100000, 10000, 1000, 100, 10, 1];

/** A grid reference or a typed lat/lng, with how precise it actually is. */
export function parseCoord(raw: string): Coord | null {
  const s = raw.trim();
  if (!s) return null;

  // "lat, lng" or "lat lng" (matches the readout's copy format order)
  const ll = s.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (ll) {
    const lat = parseFloat(ll[1]);
    const lng = parseFloat(ll[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lng, lat, squareM: 0, kind: "latlng" };
    }
    return null;
  }

  // MGRS / USNG (spaces optional)
  const flat = s.replace(/\s+/g, "").toUpperCase();
  // <zone><band><two square letters><2n digits>. An ODD number of digits means
  // easting and northing disagree, which is a mis-transcription rather than a
  // coarser square — refuse it instead of splitting it somewhere arbitrary.
  const m = flat.match(/^\d{1,2}[C-HJ-NP-X][A-HJ-NP-Z]{2}(\d*)$/);
  if (!m) return null;
  const digits = m[1].length;
  if (digits % 2 !== 0 || digits > 10) return null;
  try {
    const pt = mgrsToPoint(flat);
    if (pt && isFinite(pt[0]) && isFinite(pt[1])) {
      return {
        lng: pt[0],
        lat: pt[1],
        squareM: MGRS_SQUARE_M[digits / 2],
        kind: "mgrs",
      };
    }
  } catch {
    /* not MGRS */
  }
  return null;
}

/** "1 km square", "10 m square" — how the precision is said out loud. */
export function squareLabel(squareM: number): string {
  if (squareM <= 0) return "";
  return squareM >= 1000 ? `${squareM / 1000} km square` : `${squareM} m square`;
}

let marker: maplibregl.Marker | null = null;

/** Drop (or move) the target pin — also used by place search results. */
/** Remove the target pin. */
export function clearGotoPin() {
  marker?.remove();
  marker = null;
}

export function dropGotoPin(map: maplibregl.Map, lng: number, lat: number) {
  marker?.remove();
  const el = document.createElement("div");
  el.className = "goto-marker";
  marker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
}
