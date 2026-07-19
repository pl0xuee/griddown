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

// Fractional tile coordinates (slippy/Web-Mercator) at a zoom's tile count.
function tileXf(lng: number, n: number) {
  return ((lng + 180) / 360) * n;
}
function tileYf(lat: number, n: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
}

// Read one sample out of an already-decoded DEM tile.
function pixelAt(tile: { width: number; data: ArrayLike<number> }, xf: number, yf: number) {
  const w = tile.width;
  const px = Math.min(w - 1, Math.max(0, Math.floor((xf - Math.floor(xf)) * w)));
  const py = Math.min(w - 1, Math.max(0, Math.floor((yf - Math.floor(yf)) * w)));
  const m = tile.data[py * w + px];
  return m == null || isNaN(m) ? null : m;
}

// Sample the DEM at a lng/lat and return meters (null if no tile/data there).
export async function sampleElevationM(lng: number, lat: number): Promise<number | null> {
  const z = 12;
  const n = 2 ** z;
  const xf = tileXf(lng, n);
  const yf = tileYf(lat, n);
  try {
    const tile = await current.getDemTile(z, Math.floor(xf), Math.floor(yf));
    return pixelAt(tile, xf, yf);
  } catch {
    return null;
  }
}

export interface ElevationGrid {
  /** Metres at a point, or null where no tile covers it. Synchronous. */
  sample(lng: number, lat: number): number | null;
  tilesLoaded: number;
  /** Tiles that failed to load; points inside them sample as null. */
  tilesMissing: number;
}

/**
 * Preload every DEM tile covering a bbox, then sample it synchronously.
 *
 * The viewshed takes tens of thousands of samples across an area spanned by
 * only a handful of tiles. Awaiting `sampleElevationM` per sample re-requests
 * those same tiles once per sample, and at that volume the source starts
 * failing lookups — which callers can't distinguish from "no terrain here",
 * so dropped samples render as if the ground were hidden. Loading each tile
 * exactly once removes both the redundancy and that ambiguity: a null from
 * this grid means genuinely-absent data, and `tilesMissing` says so out loud.
 */
export async function loadElevationGrid(
  bounds: { west: number; south: number; east: number; north: number },
  z = 12
): Promise<ElevationGrid> {
  const src = current; // pin the root: setDemRoot may fire while we await
  const n = 2 ** z;
  const x0 = Math.floor(tileXf(bounds.west, n));
  const x1 = Math.floor(tileXf(bounds.east, n));
  const y0 = Math.floor(tileYf(bounds.north, n)); // north = smaller y
  const y1 = Math.floor(tileYf(bounds.south, n));

  const tiles = new Map<string, { width: number; data: ArrayLike<number> }>();
  let tilesMissing = 0;
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      jobs.push(
        src
          .getDemTile(z, x, y)
          .then((t) => {
            tiles.set(`${x}/${y}`, t);
          })
          .catch(() => {
            tilesMissing++;
          })
      );
    }
  }
  await Promise.all(jobs);

  return {
    tilesLoaded: tiles.size,
    tilesMissing,
    sample(lng: number, lat: number) {
      const xf = tileXf(lng, n);
      const yf = tileYf(lat, n);
      const tile = tiles.get(`${Math.floor(xf)}/${Math.floor(yf)}`);
      return tile ? pixelAt(tile, xf, yf) : null;
    },
  };
}
