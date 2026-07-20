import maplibregl from "maplibre-gl";
import { toPoint as mgrsToPoint } from "mgrs";

// Jump to a coordinate someone gives you — an MGRS grid ("18T VK 1234 5678")
// or a plain "lat, lng". The inverse of the coordinate readout. Fully offline.
//
// This used to own a panel of its own. It doesn't any more: "Find" takes a
// grid reference or a place name in one box, because in the field you should
// not have to decide which control you need before reading what you were
// handed. What survives here is the parser and the pin, which Find drives.

// Returns [lng, lat] or null if unparseable.
export function parseCoord(raw: string): [number, number] | null {
  const s = raw.trim();
  if (!s) return null;

  // "lat, lng" or "lat lng" (matches the readout's copy format order)
  const ll = s.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (ll) {
    const lat = parseFloat(ll[1]);
    const lng = parseFloat(ll[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return [lng, lat];
    return null;
  }

  // MGRS / USNG (spaces optional)
  try {
    const pt = mgrsToPoint(s.replace(/\s+/g, "").toUpperCase());
    if (pt && isFinite(pt[0]) && isFinite(pt[1])) return [pt[0], pt[1]];
  } catch {
    /* not MGRS */
  }
  return null;
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
