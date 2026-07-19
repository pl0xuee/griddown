// Bulk DEM sampling — pure, so tests (and later workers) can use it.
// No maplibre imports: dem.ts owns the live tile source and passes it in.

export interface DemTile {
  width: number;
  data: ArrayLike<number>;
}

/** Anything that can hand back a decoded DEM tile — the real mlcontour
 *  DemSource in the app, a stub in tests. */
export interface DemTileSource {
  getDemTile(z: number, x: number, y: number): Promise<DemTile>;
}

export interface ElevationGrid {
  /** Metres at a point, or null where no tile covers it. Synchronous. */
  sample(lng: number, lat: number): number | null;
  tilesLoaded: number;
  /** Tiles that failed to load; points inside them sample as null. */
  tilesMissing: number;
}

// Fractional tile coordinates (slippy/Web-Mercator) at a zoom's tile count.
export function tileXf(lng: number, n: number): number {
  return ((lng + 180) / 360) * n;
}
export function tileYf(lat: number, n: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
}

/** Read one sample out of an already-decoded DEM tile. */
export function pixelAt(tile: DemTile, xf: number, yf: number): number | null {
  const w = tile.width;
  const px = Math.min(w - 1, Math.max(0, Math.floor((xf - Math.floor(xf)) * w)));
  const py = Math.min(w - 1, Math.max(0, Math.floor((yf - Math.floor(yf)) * w)));
  const m = tile.data[py * w + px];
  return m == null || isNaN(m) ? null : m;
}

/**
 * Preload every DEM tile covering a bbox, then sample it synchronously.
 *
 * The viewshed takes tens of thousands of samples across an area spanned by
 * only a handful of tiles. Awaiting a per-point async lookup instead re-requests
 * those same tiles once per sample, and at that volume the source starts failing
 * — which callers can't distinguish from "no terrain here", so dropped samples
 * render as if the ground were hidden. (That produced false terrain shadow in
 * the viewshed; see git 6728e40.) Loading each tile exactly once removes both
 * the redundancy and the ambiguity: a null here means genuinely-absent data,
 * and `tilesMissing` says so out loud.
 */
export async function loadElevationGrid(
  source: DemTileSource,
  bounds: { west: number; south: number; east: number; north: number },
  z = 12
): Promise<ElevationGrid> {
  const n = 2 ** z;
  const x0 = Math.floor(tileXf(bounds.west, n));
  const x1 = Math.floor(tileXf(bounds.east, n));
  const y0 = Math.floor(tileYf(bounds.north, n)); // north = smaller y
  const y1 = Math.floor(tileYf(bounds.south, n));

  const tiles = new Map<string, DemTile>();
  let tilesMissing = 0;
  const jobs: Promise<void>[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      jobs.push(
        source
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
