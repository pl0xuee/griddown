# GridDown — apocalypse-proof offline maps

A fully offline map application for the United States, covering major streets **plus
forest service roads and trails**, with terrain (hillshade + contour lines). Built to
keep working with **no internet at all** — an off-grid / emergency replacement for
online maps. Maps are downloaded **state by state** while you have a connection, then
work forever offline.

**Target platforms:** iOS, Windows, Linux.
**Stack:** [Tauri 2](https://tauri.app) (Rust + web UI) · [MapLibre GL JS](https://maplibre.org)
· [PMTiles](https://protomaps.com) · [maplibre-contour](https://github.com/onthegomap/maplibre-contour).

Status: **Phase 0 complete** — an offline state map renders on Linux with
styled/labeled forest roads + trails, day/night themes, hillshade, and elevation
contours.

## Develop

```bash
npm install
npm run tauri dev     # desktop app (Linux/Windows)
```

## Map data (not committed — regenerate locally)

The large map/elevation files are `.gitignore`d. Regenerate them for whichever region
you want with the scripts in `tools/` (requires internet once):

```bash
# 1. Get the go-pmtiles CLI (one time)
#    Download from https://github.com/protomaps/go-pmtiles/releases into tools/pmtiles

# 2. Extract a region's basemap from the Protomaps daily planet build
tools/fetch_state_pmtiles.sh region <minLon,minLat,maxLon,maxLat>

# 3. Download offline elevation (DEM) tiles for hillshade + contours
python3 tools/fetch_dem.py <minLon,minLat,maxLon,maxLat> 12

# 4. Point the app at your data
cp public/region.example.json public/region.json   # then edit name/center/zoom
```

Outputs land in `mapdata/` and `public/dem/`, and are served under `public/` so the
app reads them locally. `public/region.json` is gitignored so your chosen region
stays local.

## Data sources & licensing

- Basemap: **© OpenStreetMap contributors** (ODbL) via the Protomaps planet build.
- Elevation: **Terrain Tiles** on AWS Open Data (USGS/SRTM etc., public domain).
- Fonts/sprites: Protomaps basemap assets (bundled under `public/`, small).
