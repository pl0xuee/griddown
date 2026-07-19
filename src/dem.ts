import maplibregl from "maplibre-gl";
import mlcontour from "maplibre-contour";

// Local-DEM sources: drive hillshade + on-the-fly contours (main.ts) and
// point/path elevation sampling (coordinate readout, measure profile).
//
// There can be more than one DEM root now: the bundled region's pyramid under
// /public/dem, plus a per-state pyramid downloaded into app-data (served via
// the asset protocol). Each root gets its own DemSource (they register
// distinct maplibre protocols, keyed by id); `current` is whichever the
// active map uses, and everything else reads through it.

const origin = window.location.origin;
const BUNDLED_URL = `${origin}/dem/{z}/{x}/{y}.png`;

const sources = new Map<string, InstanceType<typeof mlcontour.DemSource>>();

function getSource(url: string, id: string) {
  let s = sources.get(url);
  if (!s) {
    s = new mlcontour.DemSource({
      url,
      encoding: "terrarium",
      maxzoom: 12,
      worker: false,
      id,
    });
    s.setupMaplibre(maplibregl);
    sources.set(url, s);
  }
  return s;
}

let current = getSource(BUNDLED_URL, "dem");
let currentUrl = BUNDLED_URL;

/**
 * Point the DEM machinery at a different tile root (a downloaded state's
 * terrain), or back at the bundled region with null. `id` must be unique per
 * root and stable across calls (it names the maplibre protocol).
 */
export function setDemRoot(url: string | null, id: string) {
  currentUrl = url ?? BUNDLED_URL;
  current = url ? getSource(url, id) : getSource(BUNDLED_URL, "dem");
}

/** Raster-dem tile URL template for the active DEM root. */
export function demTiles(): string {
  return currentUrl;
}

/** Contour-protocol URL for the active DEM root (see mlcontour docs). */
export function demContourUrl(options: Parameters<typeof current.contourProtocolUrl>[0]): string {
  return current.contourProtocolUrl(options);
}

// Sample the DEM at a lng/lat and return meters (null if no tile/data there).
export async function sampleElevationM(lng: number, lat: number): Promise<number | null> {
  const z = 12;
  const n = 2 ** z;
  const xf = ((lng + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  try {
    const tile = await current.getDemTile(z, x, y);
    const w = tile.width;
    const px = Math.min(w - 1, Math.max(0, Math.floor((xf - x) * w)));
    const py = Math.min(w - 1, Math.max(0, Math.floor((yf - y) * w)));
    const m = tile.data[py * w + px];
    return m == null || isNaN(m) ? null : m;
  } catch {
    return null;
  }
}
