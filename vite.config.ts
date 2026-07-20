import { defineConfig } from "vite";
import { rmSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Keep the local dev region out of packaged builds.
 *
 * `public/mapdata/region.pmtiles` is a gitignored symlink to whichever state
 * you happen to be developing against, and Vite follows symlinks when it copies
 * `public/` — so a build made on a developer's machine bakes that whole state
 * into the app. Half a gigabyte of Oregon, in one case.
 *
 * CI never hits this: both files are gitignored, so they simply are not there.
 * Stripping them locally makes a local build behave like a CI one rather than
 * like the developer's dev environment.
 *
 * All three go together, not just the big one:
 *
 * - `region.json` — `loadRegion()` treats its presence as "this install is
 *   configured". Leaving it while removing the basemap it names is precisely
 *   the broken-install case the app cannot distinguish from a real one, and the
 *   map comes up blank.
 * - `mapdata/region.pmtiles` — the basemap itself.
 * - `dem/` — the bundled region's terrain pyramid, and the larger offender at
 *   941 MB. It pairs with region.json; a downloaded state brings its own DEM
 *   into app-data and reads it over the asset protocol, so nothing in a
 *   released build ever looks here.
 *
 * `starter.pmtiles` is deliberately NOT stripped — it is committed, only 10 MB,
 * and is what a fresh install is supposed to open on.
 */
function stripDevRegion() {
  return {
    name: "griddown:strip-dev-region",
    apply: "build" as const,
    closeBundle() {
      const out = "dist";
      for (const f of ["region.json", join("mapdata", "region.pmtiles"), "dem"]) {
        rmSync(join(out, f), { force: true, recursive: true });
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [stripDevRegion()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
