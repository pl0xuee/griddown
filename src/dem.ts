import maplibregl from "maplibre-gl";
import mlcontour from "maplibre-contour";

// Shared local-DEM source: drives hillshade + on-the-fly contours (main.ts) and
// point/path elevation sampling (coordinate readout, measure profile). All read
// from the static Terrarium tile pyramid under /public/dem — fully offline.

const origin = window.location.origin;
export const DEM_TILES = `${origin}/dem/{z}/{x}/{y}.png`;

export const demSource = new mlcontour.DemSource({
  url: DEM_TILES,
  encoding: "terrarium",
  maxzoom: 12,
  worker: false,
});
demSource.setupMaplibre(maplibregl);

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
    const tile = await demSource.getDemTile(z, x, y);
    const w = tile.width;
    const px = Math.min(w - 1, Math.max(0, Math.floor((xf - x) * w)));
    const py = Math.min(w - 1, Math.max(0, Math.floor((yf - y) * w)));
    const m = tile.data[py * w + px];
    return m == null || isNaN(m) ? null : m;
  } catch {
    return null;
  }
}
