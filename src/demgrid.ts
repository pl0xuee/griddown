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
  z = 12,
  opts: { concurrency?: number; maxTiles?: number } = {}
): Promise<ElevationGrid> {
  const n = 2 ** z;
  const { concurrency = 12, maxTiles = 2048 } = opts;

  // Clamp latitude to the Mercator limit BEFORE projecting. tileYf(-90) is
  // +Infinity (tan+sec cancels, log(0) = -Infinity), and a loop bounded by
  // `y <= Infinity` never ends — a hard freeze of the webview, not a slow load.
  const yTile = (lat: number) => {
    const yf = tileYf(Math.min(85.0511, Math.max(-85.0511, lat)), n);
    return Math.min(n - 1, Math.max(0, Math.floor(yf)));
  };
  const yTop = yTile(bounds.north); // north = smaller y
  const yBot = yTile(bounds.south);

  // Longitude wraps: a bbox straddling the antimeridian (the Aleutians are US
  // territory and do straddle it) comes in with west > east once `destination`
  // normalizes into (-180, 180]. Walking x0..x1 there covers nothing at all,
  // which surfaced as "no elevation data" on a fully-installed DEM. Cover it
  // as two runs instead.
  const wrap = (v: number) => ((v % n) + n) % n;
  const xL = wrap(Math.floor(tileXf(bounds.west, n)));
  const xR = wrap(Math.floor(tileXf(bounds.east, n)));
  const xs: number[] = [];
  if (xL <= xR) {
    for (let x = xL; x <= xR; x++) xs.push(x);
  } else {
    for (let x = xL; x < n; x++) xs.push(x);
    for (let x = 0; x <= xR; x++) xs.push(x);
  }

  const wanted: [number, number][] = [];
  for (const x of xs) {
    for (let y = Math.min(yTop, yBot); y <= Math.max(yTop, yBot); y++) wanted.push([x, y]);
  }
  if (wanted.length > maxTiles) {
    throw new Error(
      `That area needs ${wanted.length} elevation tiles (limit ${maxTiles}). Use a smaller area or a lower zoom.`
    );
  }

  const tiles = new Map<string, DemTile>();
  let tilesMissing = 0;

  // Bounded concurrency, NOT one promise per tile. The source times out
  // individual fetches (~10 s in mlcontour) and its cache is smaller than a
  // large working set, so firing hundreds at once makes the tail time out and
  // thrash — reintroducing the dropped-sample bug this module exists to fix.
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const [x, y] = wanted[next++];
      try {
        tiles.set(`${x}/${y}`, await source.getDemTile(z, x, y));
      } catch {
        tilesMissing++;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, wanted.length) }, () => worker())
  );

  return {
    tilesLoaded: tiles.size,
    tilesMissing,
    sample(lng: number, lat: number) {
      const xf = tileXf(lng, n);
      const yf = tileYf(lat, n);
      if (!Number.isFinite(xf) || !Number.isFinite(yf)) return null;
      const tile = tiles.get(`${wrap(Math.floor(xf))}/${Math.floor(yf)}`);
      return tile ? pixelAt(tile, xf, yf) : null;
    },
  };
}
