import { describe, it, expect } from "vitest";
import { loadElevationGrid, tileXf, tileYf, type DemTile } from "../src/demgrid";

// A stub DEM source that counts how many times each tile was asked for, so a
// regression back to per-sample fetching shows up as a hard number.
function stubSource(opts: { fail?: (x: number, y: number) => boolean; elev?: number } = {}) {
  const calls: string[] = [];
  return {
    calls,
    getDemTile(_z: number, x: number, y: number): Promise<DemTile> {
      calls.push(`${x}/${y}`);
      if (opts.fail?.(x, y)) return Promise.reject(new Error("tile unavailable"));
      const width = 4;
      // Encode the tile identity into the samples so we can prove that a given
      // lng/lat reads from the tile that actually covers it.
      const data = new Float32Array(width * width).fill(opts.elev ?? x * 1000 + y);
      return Promise.resolve({ width, data });
    },
  };
}

// A small bbox around Mt Hood — the case that exposed the original bug.
const HOOD = { west: -121.8, south: 45.2, east: -121.5, north: 45.5 };

describe("loadElevationGrid", () => {
  it("fetches each covering tile exactly once, no matter how many samples", async () => {
    const src = stubSource();
    const grid = await loadElevationGrid(src, HOOD);

    const fetched = src.calls.length;
    expect(fetched).toBeGreaterThan(0);
    expect(new Set(src.calls).size).toBe(fetched); // no tile requested twice

    // Sample far more points than there are tiles — the shape of a viewshed
    // sweep. This must not trigger a single further fetch.
    for (let i = 0; i < 5000; i++) {
      const t = i / 5000;
      grid.sample(HOOD.west + (HOOD.east - HOOD.west) * t, HOOD.south + (HOOD.north - HOOD.south) * t);
    }
    expect(src.calls.length).toBe(fetched);
  });

  it("covers a small bbox with a handful of tiles, not thousands", async () => {
    const src = stubSource();
    await loadElevationGrid(src, HOOD);
    // 0.3° at z12 is a dozen-ish tiles; the old code issued 57,600 requests
    // for this same area, which is what overloaded the source.
    expect(src.calls.length).toBeLessThan(64);
  });

  it("samples from the tile that actually covers the point", async () => {
    const src = stubSource();
    const grid = await loadElevationGrid(src, HOOD);
    const n = 2 ** 12;
    const lng = -121.7;
    const lat = 45.35;
    const expected = Math.floor(tileXf(lng, n)) * 1000 + Math.floor(tileYf(lat, n));
    expect(grid.sample(lng, lat)).toBe(expected);
  });

  it("reports failed tiles instead of silently reading as no terrain", async () => {
    // The whole point of the fix: a dropped tile must be countable, because
    // downstream a null is indistinguishable from "the ground is hidden".
    const src = stubSource({ fail: () => true });
    const grid = await loadElevationGrid(src, HOOD);
    expect(grid.tilesLoaded).toBe(0);
    expect(grid.tilesMissing).toBe(src.calls.length);
    expect(grid.sample(-121.7, 45.35)).toBeNull();
  });

  it("keeps good tiles when only some fail", async () => {
    const src = stubSource({ fail: (x) => x % 2 === 0 });
    const grid = await loadElevationGrid(src, HOOD);
    expect(grid.tilesLoaded).toBeGreaterThan(0);
    expect(grid.tilesMissing).toBeGreaterThan(0);
    expect(grid.tilesLoaded + grid.tilesMissing).toBe(src.calls.length);
  });

  it("returns null outside the loaded bbox rather than guessing", async () => {
    const src = stubSource();
    const grid = await loadElevationGrid(src, HOOD);
    expect(grid.sample(-100, 40)).toBeNull(); // far outside
  });

  it("terminates at the poles instead of hanging", async () => {
    // tileYf(-90) is +Infinity, so an unclamped `y <= y1` loop never ends.
    // If this regresses, the test suite hangs rather than fails — which is
    // exactly what the app would do.
    const src = stubSource();
    const grid = await loadElevationGrid(src, {
      west: -0.05,
      south: -90, // the value that projects to +Infinity
      east: 0.05,
      north: -89.5,
    });
    expect(grid.tilesLoaded).toBeGreaterThan(0);
    // Every requested tile y must be a real in-range index, not Infinity/NaN.
    expect(
      src.calls.every((c) => {
        const y = Number(c.split("/")[1]);
        return Number.isFinite(y) && y >= 0 && y < 4096;
      })
    ).toBe(true);
  });

  it("covers a bbox that straddles the antimeridian", async () => {
    // Attu in the Aleutians: `destination` normalizes into (-180, 180], so the
    // bbox arrives with west > east. Walking west..east covers nothing.
    const src = stubSource();
    const grid = await loadElevationGrid(src, {
      west: 179.336,
      south: 52.7,
      east: -179.936,
      north: 53.1,
    });
    expect(grid.tilesLoaded).toBeGreaterThan(0);
    expect(grid.sample(179.5, 52.9)).not.toBeNull();
    expect(grid.sample(-179.95, 52.9)).not.toBeNull();
  });

  it("refuses an area too large to load rather than firing thousands of fetches", async () => {
    const src = stubSource();
    await expect(
      loadElevationGrid(src, { west: -125, south: 25, east: -66, north: 49 })
    ).rejects.toThrow(/elevation tiles/);
    expect(src.calls.length).toBe(0);
  });

  it("bounds how many tiles are in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const src = {
      calls: [] as string[],
      getDemTile(_z: number, x: number, y: number): Promise<DemTile> {
        src.calls.push(`${x}/${y}`);
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve({ width: 2, data: new Float32Array(4).fill(100) });
          }, 1)
        );
      },
    };
    await loadElevationGrid(src, HOOD, 12, { concurrency: 4 });
    expect(peak).toBeLessThanOrEqual(4);
    expect(src.calls.length).toBeGreaterThan(4); // actually exercised the pool
  });

  it("survives an empty/degenerate bbox", async () => {
    const src = stubSource();
    const grid = await loadElevationGrid(src, { west: -121.7, south: 45.3, east: -121.7, north: 45.3 });
    expect(grid.tilesLoaded).toBe(1); // the single tile containing that point
    expect(grid.sample(-121.7, 45.3)).not.toBeNull();
  });
});
