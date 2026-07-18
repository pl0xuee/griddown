<h1 align="center">◈ GridDown</h1>
<p align="center"><b>Apocalypse-proof offline maps for the United States.</b></p>
<p align="center">Streets · forest service roads · trails · terrain — working with <b>no internet at all.</b></p>

---

GridDown is an offline map application built to keep working when the grid goes down.
Download a US state while you have a connection, and from then on the map — major
roads, **forest service roads**, **hiking trails**, place search, and **terrain
(hillshade + elevation contours)** — runs **100% offline**, no signal required. Meant
as an off-grid and emergency replacement for online maps.

## Features

- 🗺️ **Offline vector maps** — pan/zoom streets, towns, water, and land, all from
  local files.
- 🌲 **Forest roads & trails** — forest service roads and hiking trails styled and
  labeled (what most maps hide).
- ⛰️ **Terrain** — hillshade relief and elevation contour lines in feet, generated
  offline from local elevation data.
- 🌗 **Day / night themes** — a dark "field console" look and a light daytime map.
- 📦 **Download by state** — pick states from the in-app **Map library**; each is a
  self-contained offline pack stored on your device.
- 🔌 **Truly offline** — once downloaded, nothing the map does touches the internet.

## Platforms

One codebase targets **Linux, Windows, and iOS** (via [Tauri 2](https://tauri.app)).
Desktop (Linux/Windows) is the current focus; iOS needs a macOS build host + signing.

## Tech

[Tauri 2](https://tauri.app) · [MapLibre GL JS](https://maplibre.org) ·
[PMTiles](https://protomaps.com) · [maplibre-contour](https://github.com/onthegomap/maplibre-contour)
· [go-pmtiles](https://github.com/protomaps/go-pmtiles).

## Develop

```bash
npm install
npm run tauri dev        # runs the desktop app (Linux/Windows)
```

The app downloads state map data itself (via the Map library) into your app-data
folder — nothing large is bundled or committed. A go-pmtiles binary is needed for
downloads: drop one from [go-pmtiles releases](https://github.com/protomaps/go-pmtiles/releases)
at `src-tauri/binaries/pmtiles-<target-triple>` (e.g. `pmtiles-x86_64-unknown-linux-gnu`).

## Data & licensing

- Basemap: **© OpenStreetMap contributors** (ODbL), via the Protomaps planet build.
- Elevation: **Terrain Tiles** on AWS Open Data (USGS/SRTM, public domain).
- Fonts & sprites: Protomaps basemap assets (bundled, small).

## Builds

`.github/workflows/build.yml` builds Linux + Windows apps (manual trigger, or push a
`vX.Y.Z` tag to draft a release with installers).
