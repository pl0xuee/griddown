import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { demTiles, demContourUrl, setDemRoot, sampleElevationM } from "./dem";
import { initStateLibrary, setMvumListener, type SwitchTarget } from "./states";
import { initMvum } from "./mvum";
import { initMesh } from "./mesh";
import { initHandbook } from "./handbook";
import { initSky } from "./sky";
import { initWaypoints } from "./waypoints";
import { initMeasure } from "./measure";
import { dropGotoPin } from "./goto";
import { initSearch } from "./search";
import { initRoute } from "./route";
import { initUpdater } from "./updater";
import { initVersion } from "./version";
import { initPanels } from "./panels";
import { initReadiness } from "./readiness";
import { initPrint } from "./print";
import { initCompass } from "./compass";
import { initViewshed } from "./viewshed";
import { forward as mgrsForward } from "mgrs";
import { toast } from "./toast";

// A silent failure must never look like a blank map: surface any uncaught
// error on the HUD status line, where it can actually be reported.
function surfaceError(msg: string) {
  const label = document.getElementById("net-label");
  const dot = document.getElementById("net-dot");
  if (label) label.textContent = `ERROR: ${msg}`.slice(0, 120);
  if (dot) dot.className = "dot";
  console.error("[griddown]", msg);
}
window.addEventListener("error", (e) => surfaceError(e.message || String(e.error)));
window.addEventListener("unhandledrejection", (e) =>
  surfaceError(e.reason instanceof Error ? e.reason.message : String(e.reason))
);

// --- Register the pmtiles:// protocol so MapLibre can read a local .pmtiles file ---
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// All assets are served locally from /public — nothing here touches the internet.
const origin = window.location.origin;

// The active region (basemap file + starting view) is loaded from a local,
// gitignored region.json so no specific location is baked into the code.
interface Region {
  name: string;
  pmtiles: string;
  center: [number, number];
  zoom: number;
}
/**
 * `configured` distinguishes a fresh install from a broken one.
 *
 * A released build ships with no region.json and no bundled basemap — the map
 * data is far too large to bundle, and you pick your own state in-app. Without
 * this flag that state is indistinguishable from a working install whose
 * basemap has gone missing, and a first-time user is greeted by an error about
 * a file they were never supposed to have.
 */
async function loadRegion(): Promise<Region & { configured: boolean }> {
  try {
    const r = await fetch(`${origin}/region.json`, { cache: "no-store" });
    if (r.ok) return { ...((await r.json()) as Region), configured: true };
  } catch {
    /* fall through to generic default */
  }
  return {
    // The bundled whole-US basemap at low zoom, ~11 MB. A fresh install has no
    // state pack — correctly, since one is hundreds of megabytes — and used to
    // open on an empty screen with a notice over it, which reads as broken. This
    // is a real map, just a coarse one: enough to see the country, orient
    // yourself and find the state you want to download.
    name: "GridDown",
    pmtiles: "starter.pmtiles",
    center: [-98.58, 39.83],
    zoom: 4,
    configured: false,
  };
}

// Assigned once the region config is loaded (see start() at the bottom).
let PMTILES_URL = "";

// Which downloaded pack is on screen (""=the bundled region). The Forest
// Service overlay is stored per pack, so it has to follow this.
let activePackAbbr = "";

// True while the HUD is showing "No map yet"; cleared once a pack loads.
let noMapNotice = false;

type ThemeName = "dark" | "light";

const THEME = {
  dark: {
    flavor: "dark" as const,
    sprite: "dark",
    forest: "#f2a53a",
    forestCasing: "#120c02",
    trail: "#5fe05f",
    trailCasing: "#06180a",
    label: "#ffe6b0",
    trailLabel: "#c9ffca",
    halo: "#0a0a0a",
    contour: "#b79b6e",
    contourHalo: "#0a0a0a",
    hillHighlight: "#5a6a54",
    hillShadow: "#000000",
    bg: "#111317",
  },
  light: {
    flavor: "light" as const,
    sprite: "light",
    forest: "#8a5a2b",
    forestCasing: "#ffffff",
    trail: "#1f7a1f",
    trailCasing: "#ffffff",
    label: "#5a3a12",
    trailLabel: "#12550f",
    halo: "#ffffff",
    contour: "#9a7b4f",
    contourHalo: "#ffffff",
    hillHighlight: "#ffffff",
    hillShadow: "#5a5346",
    bg: "#e9e5dc",
  },
};

const TRAIL_KINDS = ["path", "footway", "bridleway", "steps"];

// Survival-resource overlays, filtered from the POIs layer by OSM `kind`.
const RESOURCE_CATS: Record<string, { color: string; kinds: string[] }> = {
  water: {
    color: "#3fa9f5",
    kinds: ["drinking_water", "water_point", "spring", "water_well", "well", "water_tap"],
  },
  shelter: {
    color: "#e0a33a",
    kinds: ["shelter", "wilderness_hut", "alpine_hut", "lean_to", "cabin", "hut",
      "camp_site", "caravan_site", "ranger_station"],
  },
  medical: {
    color: "#ff6a6a",
    kinds: ["hospital", "clinic", "doctors", "pharmacy", "chemist", "first_aid"],
  },
  fuel: {
    color: "#b98cff",
    kinds: ["fuel", "gas", "charging_station", "hardware", "supermarket",
      "convenience", "marketplace"],
  },
  emergency: {
    color: "#ff4d4d",
    kinds: ["police", "fire_station", "ranger_station", "hospital"],
  },
};

// Parsed defensively: this runs at module scope, so a corrupt value would throw
// before start() and the app would never boot again — with no way to recover
// short of clearing storage by hand. A lost overlay preference is nothing.
let activeResources = new Set<string>(
  (() => {
    try {
      const v = JSON.parse(localStorage.getItem("griddown_resources") || "[]");
      // Filter to real category names: a build between the chip-row merge and
      // its fix could have persisted a nameless "" entry, which matches no
      // layer and would light every chip up as "on".
      return Array.isArray(v) ? (v as string[]).filter((k) => k && k in RESOURCE_CATS) : [];
    } catch {
      return [];
    }
  })()
);

// Public-land overlay: where you can legally be — and where you really can't.
// Both come from the basemap's `landuse` polygons, so it works fully offline
// in every downloaded pack.
let publicLandOn = localStorage.getItem("griddown_publicland") === "1";
// Strongly protected: parks, designated protected areas, reserves. US national
// forests are often tagged as plain landuse=forest in OSM (kind "forest"), so
// they get their own, fainter class — shown, but ownership varies.
const PUBLIC_KINDS = ["national_park", "protected_area", "nature_reserve", "park"];
const FOREST_KINDS = ["forest", "wood"];
const MILITARY_KINDS = ["military", "naval_base", "airfield"];

/** Shading fills — inserted under roads/labels so they tint land, not text. */
function publicLandFills(themeName: ThemeName): any[] {
  const dark = themeName === "dark";
  return [
    {
      id: "app-forestland-fill", type: "fill", source: "protomaps", "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", FOREST_KINDS]],
      paint: {
        "fill-color": dark ? "#3ddc63" : "#2e8b3d",
        "fill-opacity": dark ? 0.08 : 0.1,
      },
    },
    {
      id: "app-publicland-fill", type: "fill", source: "protomaps", "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", PUBLIC_KINDS]],
      paint: {
        "fill-color": dark ? "#3ddc63" : "#2e8b3d",
        "fill-opacity": dark ? 0.16 : 0.18,
      },
    },
    {
      id: "app-military-fill", type: "fill", source: "protomaps", "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", MILITARY_KINDS]],
      paint: {
        "fill-color": dark ? "#ff4545" : "#c03030",
        "fill-opacity": dark ? 0.22 : 0.2,
      },
    },
  ];
}

/** Boundary lines — drawn on top so the legal edge is unmistakable. */
function publicLandLines(themeName: ThemeName): any[] {
  const dark = themeName === "dark";
  return [
    {
      id: "app-publicland-line", type: "line", source: "protomaps", "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", PUBLIC_KINDS]],
      paint: {
        "line-color": dark ? "#4ade4a" : "#1f7a1f",
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.8, 12, 1.6],
        "line-dasharray": [3, 2],
        "line-opacity": 0.8,
      },
    },
    {
      id: "app-military-line", type: "line", source: "protomaps", "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", MILITARY_KINDS]],
      paint: {
        "line-color": dark ? "#ff5555" : "#b02020",
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.0, 12, 2.0],
        "line-dasharray": [1.5, 1.2],
        "line-opacity": 0.85,
      },
    },
  ];
}

function resourceLayers(t: (typeof THEME)[ThemeName]): any[] {
  const out: any[] = [];
  for (const cat of activeResources) {
    const c = RESOURCE_CATS[cat];
    if (!c) continue;
    const filter: any = ["in", ["get", "kind"], ["literal", c.kinds]];
    out.push({
      id: `res-${cat}-dot`, type: "circle", source: "protomaps", "source-layer": "pois",
      filter, minzoom: 11,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 14, 5.5, 16, 7.5],
        "circle-color": c.color,
        "circle-stroke-color": "#0a0a0a",
        "circle-stroke-width": 1.5,
        "circle-opacity": 0.92,
      },
    });
    out.push({
      id: `res-${cat}-label`, type: "symbol", source: "protomaps", "source-layer": "pois",
      filter: ["all", filter, ["has", "name"]], minzoom: 14,
      layout: {
        "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"],
        "text-size": 10, "text-offset": [0, 0.9], "text-anchor": "top",
        "text-optional": true,
      },
      paint: { "text-color": c.color, "text-halo-color": t.halo, "text-halo-width": 1.4 },
    });
  }
  return out;
}

function emphasisLayers(t: (typeof THEME)[ThemeName]): any[] {
  return [
    {
      id: "app-forest-casing", type: "line", source: "protomaps", "source-layer": "roads",
      filter: ["==", ["get", "kind_detail"], "track"], minzoom: 9,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.forestCasing,
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.0, 13, 3.6, 16, 6.5],
        "line-opacity": 0.55,
      },
    },
    {
      id: "app-forest-roads", type: "line", source: "protomaps", "source-layer": "roads",
      filter: ["==", ["get", "kind_detail"], "track"], minzoom: 9,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": t.forest, "line-dasharray": [2, 1.4],
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.9, 13, 1.9, 16, 3.4],
      },
    },
    {
      id: "app-trail-casing", type: "line", source: "protomaps", "source-layer": "roads",
      filter: ["in", ["get", "kind_detail"], ["literal", TRAIL_KINDS]], minzoom: 10,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": t.trailCasing,
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.6, 14, 3.0, 16, 5.0],
        "line-opacity": 0.5,
      },
    },
    {
      id: "app-trails", type: "line", source: "protomaps", "source-layer": "roads",
      filter: ["in", ["get", "kind_detail"], ["literal", TRAIL_KINDS]], minzoom: 10,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: {
        "line-color": t.trail, "line-dasharray": [1.4, 1.3],
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.8, 14, 1.8, 16, 2.8],
      },
    },
    {
      id: "app-forest-labels", type: "symbol", source: "protomaps", "source-layer": "roads",
      filter: ["all", ["==", ["get", "kind_detail"], "track"], ["has", "name"]], minzoom: 13,
      layout: {
        "symbol-placement": "line", "text-field": ["get", "name"],
        "text-font": ["Noto Sans Medium"], "text-size": 11, "text-max-angle": 40,
      },
      paint: { "text-color": t.label, "text-halo-color": t.halo, "text-halo-width": 1.6 },
    },
    {
      id: "app-trail-labels", type: "symbol", source: "protomaps", "source-layer": "roads",
      filter: ["all", ["in", ["get", "kind_detail"], ["literal", TRAIL_KINDS]], ["has", "name"]], minzoom: 13,
      layout: {
        "symbol-placement": "line", "text-field": ["get", "name"],
        "text-font": ["Noto Sans Italic"], "text-size": 11, "text-max-angle": 40,
      },
      paint: { "text-color": t.trailLabel, "text-halo-color": t.halo, "text-halo-width": 1.6 },
    },
  ];
}

let currentTheme: ThemeName = "dark";
let terrainOn = true;
// Battery saver: dim the screen and drop the GPU-heavy layers (hillshade/
// contours). Off-grid, screen brightness and GPU are most of the battery.
let batteryOn = localStorage.getItem("griddown_battery") === "1";
// Terrain (hillshade/contours) only exists for regions with a local DEM.
let terrainAvailable = true;
let map: maplibregl.Map;

// The stock dark flavor draws roads in #333–#47 greys on a near-black
// background — nearly invisible in the field. Lift them to clear greys,
// brighter the more important the road. Casings/tunnels stay dark so the
// contrast still reads.
const DARK_ROAD_COLORS: [RegExp, string][] = [
  [/_highway(_late|_early)?$/, "#b0b6c2"],
  [/_major(_late|_early)?$/, "#9aa1ad"],
  [/_(minor|link)$/, "#7e8694"],
  [/_(minor_service|other|taxiway|runway|pier)$/, "#636b78"],
];

// Labels get the same treatment: the stock flavor's #3d–#7a greys drown in
// hillshade and overlay shading. Bright text + a strong dark halo.
const DARK_LABEL_COLORS: [RegExp, string][] = [
  [/^places_locality$/, "#eef1f6"], // cities & towns — the ones you navigate by
  [/^places_subplace$/, "#c3cad4"],
  [/^places_region$/, "#a8afba"],
  [/^places_country$/, "#8f96a3"],
  [/^roads_labels_major$/, "#c9cfd9"],
  [/^roads_labels_minor$/, "#a5acb8"],
  [/^(water_|earth_label)/, "#8fa8c4"],
  [/^address_label$/, "#7d8490"],
];

function brightenDarkRoads(base: any[]) {
  for (const l of base) {
    if (typeof l.id !== "string") continue;
    if (
      l.type === "line" &&
      l.id.startsWith("roads_") &&
      !l.id.includes("casing") &&
      !l.id.includes("tunnels")
    ) {
      for (const [re, color] of DARK_ROAD_COLORS) {
        if (re.test(l.id)) {
          l.paint = { ...l.paint, "line-color": color };
          break;
        }
      }
    }
    if (l.type === "symbol") {
      for (const [re, color] of DARK_LABEL_COLORS) {
        if (re.test(l.id)) {
          l.paint = {
            ...l.paint,
            "text-color": color,
            "text-halo-color": "#0b0d11",
            "text-halo-width": 1.7,
          };
          break;
        }
      }
    }
  }
}

function buildStyle(themeName: ThemeName): maplibregl.StyleSpecification {
  const t = THEME[themeName];
  const base = layers("protomaps", namedFlavor(t.flavor), { lang: "en" }) as any[];
  if (themeName === "dark") brightenDarkRoads(base);

  const sources: any = {
    protomaps: {
      type: "vector",
      url: PMTILES_URL,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
    },
  };

  if (terrainOn && terrainAvailable && !batteryOn) {
    sources.dem = {
      type: "raster-dem",
      tiles: [demTiles()],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 12,
      attribution:
        'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank">Terrain Tiles / USGS</a>',
    };
    sources.contours = {
      type: "vector",
      tiles: [
        demContourUrl({
          multiplier: 3.28084, // meters -> feet
          overzoom: 1,
          elevationKey: "ele",
          levelKey: "level",
          contourLayer: "contours",
          thresholds: {
            10: [500, 2500],
            12: [200, 1000],
            13: [100, 500],
            14: [40, 200],
          },
        }),
      ],
      maxzoom: 15,
    };

    const hillshade: any = {
      id: "app-hillshade", type: "hillshade", source: "dem",
      paint: {
        "hillshade-exaggeration": 0.5,
        "hillshade-shadow-color": t.hillShadow,
        "hillshade-highlight-color": t.hillHighlight,
        "hillshade-accent-color": t.hillShadow,
      },
    };
    const contourLine: any = {
      id: "app-contours", type: "line", source: "contours", "source-layer": "contours",
      minzoom: 11,
      paint: {
        "line-color": t.contour,
        "line-opacity": ["case", [">", ["get", "level"], 0], 0.55, 0.3],
        "line-width": ["case", [">", ["get", "level"], 0], 1.3, 0.6],
      },
    };

    // Insert terrain just below the road layers so it shades land, not roads.
    const firstRoad = base.findIndex(
      (l) => typeof l.id === "string" && l.id.startsWith("roads")
    );
    const at = firstRoad >= 0 ? firstRoad : base.length;
    base.splice(at, 0, hillshade, contourLine);
  }

  if (publicLandOn) {
    // Fills go under the roads (over hillshade); boundary lines go on top.
    const firstRoad = base.findIndex(
      (l) => typeof l.id === "string" && l.id.startsWith("roads")
    );
    base.splice(firstRoad >= 0 ? firstRoad : base.length, 0, ...publicLandFills(themeName));
  }

  const contourLabels: any[] = terrainOn && terrainAvailable && !batteryOn
    ? [
        {
          id: "app-contour-labels", type: "symbol", source: "contours", "source-layer": "contours",
          filter: [">", ["get", "level"], 0], minzoom: 12,
          layout: {
            "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "ele"]], " ft"],
            "text-font": ["Noto Sans Regular"], "text-size": 10, "text-max-angle": 30,
            "symbol-spacing": 320,
          },
          paint: {
            "text-color": THEME[themeName].contour,
            "text-halo-color": THEME[themeName].contourHalo, "text-halo-width": 1.4,
          },
        },
      ]
    : [];

  // Layer order is legibility: our line overlays (trails, forest roads,
  // public-land boundaries) must sit ABOVE base roads but BELOW every label,
  // or they strike through town names. Only our own labels + POI dots go on top.
  const emph = emphasisLayers(t);
  const emphLines = emph.filter((l) => l.type !== "symbol");
  const emphLabels = emph.filter((l) => l.type === "symbol");
  const overlayLines = [
    ...(publicLandOn ? publicLandLines(themeName) : []),
    ...emphLines,
  ];
  const firstSymbol = base.findIndex((l) => l.type === "symbol");
  const at = firstSymbol >= 0 ? firstSymbol : base.length;
  base.splice(at, 0, ...overlayLines);

  return {
    version: 8,
    glyphs: `${origin}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/sprites/${t.sprite}`,
    sources,
    layers: [...base, ...emphLabels, ...resourceLayers(t), ...contourLabels],
  } as maplibregl.StyleSpecification;
}

document.body.style.background = THEME[currentTheme].bg;

/**
 * Confirm the bundled region's basemap is actually there and is PMTiles.
 *
 * A missing file 404s inside the pmtiles protocol, which is not an uncaught
 * error — `surfaceError` never sees it and the user just gets a blank map with
 * no explanation. That exact failure (a deleted `public/mapdata/` symlink) went
 * unnoticed for two days because an active downloaded pack meant the app never
 * loaded the region file. Check it up front and say so plainly.
 */
async function checkBasemap(file: string): Promise<string | null> {
  // Never wait forever on a check whose only job is to explain a failure.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${origin}/mapdata/${file}`, {
      headers: { Range: "bytes=0-6" },
      signal: ctl.signal,
    });
    if (!r.ok) {
      return `Basemap ${file} is missing (HTTP ${r.status}). Reinstall it or pick a downloaded pack.`;
    }
    // Read only the first bytes off the stream. NOT `r.arrayBuffer()`: a server
    // that ignores Range answers 200 with the whole archive, and buffering a
    // ~500 MB basemap to check 7 characters would hang or OOM the app at
    // startup — the opposite of what this check is for.
    const head = r.body ? await firstBytes(r.body, 7) : new Uint8Array();
    if (!new TextDecoder().decode(head).startsWith("PMTiles")) {
      return `Basemap ${file} isn't a PMTiles archive — it may be truncated.`;
    }
    return null;
  } catch (e) {
    // A timeout says the read was slow, not that the file is absent — don't
    // cry wolf about a basemap that may be perfectly fine.
    if (ctl.signal.aborted) return null;
    return `Can't read basemap ${file}: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(timer);
  }
}

/** First n bytes of a stream, then cancel it — never buffers the whole body. */
async function firstBytes(body: ReadableStream<Uint8Array>, n: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const out = new Uint8Array(n);
  let got = 0;
  try {
    while (got < n) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(n - got, value.length);
      out.set(value.subarray(0, take), got);
      got += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, got);
}

async function start() {
  const region = await loadRegion();
  PMTILES_URL = `pmtiles://${origin}/mapdata/${region.pmtiles}`;

  const stateEl = document.getElementById("hud-state");
  if (stateEl) stateEl.textContent = region.name;

  // Start the check but DON'T await it here: nothing about creating the map
  // depends on the answer, and awaiting would let a slow or stalled read delay
  // — or with no timeout, permanently prevent — the map ever being built.
  //
  // Skip it entirely when a downloaded pack is active: that pack replaces the
  // bundled region seconds later, so complaining about a region file nothing
  // will read is a false alarm for anyone running purely off packs.
  const basemapCheck = localStorage.getItem("griddown_active_state")
    ? Promise.resolve(null)
    : checkBasemap(region.pmtiles);

  map = new maplibregl.Map({
    container: "map",
    center: region.center,
    zoom: region.zoom,
    hash: false,
    attributionControl: { compact: true },
    style: buildStyle(currentTheme),
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  // "Where am I" — takes ONE fix, marks it, and centres the map there.
  //
  // trackUserLocation is deliberately FALSE. With it on, MapLibre's first press
  // starts a continuous high-accuracy `watchPosition` that only a second press
  // stops — and nothing in this app ever stopped it, so one tap to check your
  // position left GPS polling until the battery died. That is the single
  // heaviest drain available to us, on a device you may need alive tomorrow,
  // and it contradicted the rest of the codebase: compass.ts kills its sensor
  // the moment its panel hides, waypoints.ts clears its watch on stop, and
  // route.ts uses one-shot positioning. `false` routes to getCurrentPosition.
  //
  // The accuracy circle stays: a fix from wifi/cell triangulation can be a
  // kilometre out, and a confident dot with no sense of that is the same class
  // of lie as the terrain shadow and the invented elevation profile.
  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    trackUserLocation: false,
    showAccuracyCircle: true,
    showUserLocation: true,
  });
  map.addControl(geolocate, "top-right");

  // Same action from the HUD, where people actually look for it — the map
  // control is easy to miss next to the zoom buttons, especially on a phone.
  const locateBtn = document.getElementById("locate-me");
  const locateIdle = locateBtn?.innerHTML ?? "";
  function locateDone() {
    if (!locateBtn) return;
    locateBtn.removeAttribute("disabled");
    locateBtn.innerHTML = locateIdle;
  }
  locateBtn?.addEventListener("click", () => {
    // trigger() returns false when the control is still finishing its async
    // permission check. Without this the button is simply dead for the first
    // moment after launch, with nothing said — the exact silent failure the
    // error handler below exists to prevent.
    const started = geolocate.trigger();
    if (!started) {
      toast("Location is still starting up — try again in a second.", "info");
      return;
    }
    // A fix can take the full 15s timeout, so say something is happening
    // rather than leaving a button that looks like it did nothing.
    locateBtn.setAttribute("disabled", "");
    locateBtn.textContent = "◎ Locating…";
  });
  geolocate.on("geolocate", locateDone);
  geolocate.on("trackuserlocationend", locateDone);
  geolocate.on("error", (e: any) => {
    locateDone();
    // Never fail silently: the user pressed a button and is waiting.
    const denied = e?.code === 1; // PERMISSION_DENIED
    toast(
      denied
        ? "Location permission denied — allow it in your system settings."
        : "Couldn't get a location fix. Most desktops have no GPS; this works on a phone or tablet.",
      "error",
      6000
    );
  });
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  map.on("error", (e) => {
    console.error("[map error]", e && (e as any).error ? (e as any).error : e);
  });

  // Whether a downloaded pack is already chosen. Checked here rather than
  // inferred from the basemap loading: the bundled starter pack always loads,
  // so a load failure no longer means "fresh install" the way it used to.
  const hasActivePack = !!localStorage.getItem("griddown_active_state");

  void basemapCheck.then((problem) => {
    if (!region.configured && !hasActivePack) {
      // Running on the bundled starter pack — a real map, but the whole country
      // at low zoom. Say what it is and point at the fix, rather than letting
      // someone zoom in and conclude the app is broken when the detail runs out.
      //
      // This can be premature: a packaged build runs on a different origin than
      // dev, so it starts with empty localStorage and no active-state key, even
      // when packs are already installed. states.ts finds and activates one a
      // moment later — so the notice has to clear itself when that happens,
      // rather than sitting there over a fully detailed map.
      noMapNotice = true;
      const el = document.getElementById("net-label");
      if (el) el.textContent = "Overview only — open Map packs";
      toast(
        "This is the whole-US overview. Open ▤ Map packs and download your state for detail.",
        "info",
        9000
      );
      return;
    }
    if (!problem) return;
    surfaceError(problem);
    toast(problem, "error");
  });

  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    currentTheme = currentTheme === "dark" ? "light" : "dark";
    map.setStyle(buildStyle(currentTheme));
    applyThemeUi();
  });
  document.getElementById("terrain-toggle")?.addEventListener("click", () => {
    terrainOn = !terrainOn;
    map.setStyle(buildStyle(currentTheme));
    applyThemeUi();
  });
  document.getElementById("publicland-toggle")?.addEventListener("click", () => {
    publicLandOn = !publicLandOn;
    localStorage.setItem("griddown_publicland", publicLandOn ? "1" : "0");
    map.setStyle(buildStyle(currentTheme));
    applyThemeUi();
  });
  document.getElementById("battery-toggle")?.addEventListener("click", () => {
    batteryOn = !batteryOn;
    localStorage.setItem("griddown_battery", batteryOn ? "1" : "0");
    map.setStyle(buildStyle(currentTheme));
    applyThemeUi();
  });
  applyThemeUi();

  // Assigned further down, once the overlay is initialised — switchToSource is
  // declared before it but only ever runs after.
  let mvumCtl: { packChanged(): void } | null = null;
  let routeCtl: { routeTo(lng: number, lat: number, label: string): void } | null = null;

  // Switch the active map source (called when a downloaded state is selected).
  function switchToSource(t: SwitchTarget) {
    // A map is now loaded, so retract any "no map yet" notice.
    if (noMapNotice) {
      noMapNotice = false;
      refreshNetStatus();
    }
    // Drop the protocol's cached instance for this file — after a pack refresh
    // the bytes on disk changed but the URL didn't, and a stale cached header/
    // directory would point at the wrong tile offsets.
    protocol.tiles.delete(t.pmtilesUrl.replace(/^pmtiles:\/\//, ""));
    PMTILES_URL = t.pmtilesUrl;
    activePackAbbr = t.abbr;
    terrainAvailable = t.hasDem;
    // Point terrain machinery at this state's DEM (or back at the bundled one).
    setDemRoot(t.demUrl ?? null, t.demId ?? "dem");
    const el = document.getElementById("hud-state");
    if (el) el.textContent = t.name;
    // diff:false on a refresh — the style is unchanged (same URL), so a diffed
    // setStyle would keep the old source and its already-loaded stale tiles.
    map.setStyle(buildStyle(currentTheme), { diff: !t.keepView });
    if (!t.keepView) map.jumpTo({ center: t.center, zoom: t.zoom });
    applyThemeUi();
    // The overlay belongs to the old pack — reload it for the new one.
    mvumCtl?.packChanged();
  }
  // Resource overlay chips (water / shelter / medical / supply / help).
  //
  // Scoped to [data-res], NOT to .res-chip: the terrain, public-land and forest
  // -road toggles now share the chip row and the chip class, but they are not
  // resources. Without this they would each toggle a nameless "" resource on
  // every click, persist it to storage, force a second style rebuild, and have
  // their own on/off state overwritten by applyResourceUi.
  const resChips = () => document.querySelectorAll<HTMLElement>(".res-chip[data-res]");
  function applyResourceUi() {
    resChips().forEach((chip) => {
      chip.classList.toggle("on", activeResources.has(chip.dataset.res || ""));
    });
  }
  resChips().forEach((chip) => {
    chip.addEventListener("click", () => {
      const cat = chip.dataset.res || "";
      if (activeResources.has(cat)) activeResources.delete(cat);
      else activeResources.add(cat);
      localStorage.setItem("griddown_resources", JSON.stringify([...activeResources]));
      map.setStyle(buildStyle(currentTheme));
      applyResourceUi();
    });
  });
  applyResourceUi();

  // Live coordinate readout (MGRS + lat/long) for the center crosshair.
  const coordsEl = document.getElementById("coords");
  function fmtMgrs(s: string): string {
    const m = s.match(/^(\d{1,2}[C-X])([A-Z]{2})(\d+)$/);
    if (!m) return s;
    const h = m[3].length / 2;
    return `${m[1]} ${m[2]} ${m[3].slice(0, h)} ${m[3].slice(h)}`;
  }
  let lastGrid = "";
  let lastLL = "";
  let lastElev = "";
  function renderCoords() {
    if (!coordsEl) return;
    coordsEl.innerHTML = `<span class="c-grid">${lastGrid}</span><span class="c-ll">${lastLL}${
      lastElev ? " · " + lastElev : ""
    }</span>`;
  }
  function updateCoords() {
    const c = map.getCenter();
    lastLL = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    try {
      lastGrid = fmtMgrs(mgrsForward([c.lng, c.lat]));
    } catch {
      lastGrid = "—";
    }
    renderCoords();
  }

  // Sample the local DEM at the crosshair for an elevation readout.
  async function centerElevationFt(): Promise<number | null> {
    if (!terrainAvailable) return null;
    const c = map.getCenter();
    const m = await sampleElevationM(c.lng, c.lat);
    return m == null ? null : m * 3.28084;
  }
  // Coordinates update synchronously on `move`, elevation resolves async — so
  // without a generation token a slow lookup from an earlier position can land
  // after a later one and be displayed beside the *current* lat/lng. A wrong
  // elevation that looks authoritative is worse than none.
  let elevGen = 0;
  async function updateElevation() {
    const gen = ++elevGen;
    const ft = await centerElevationFt();
    if (gen !== elevGen) return; // superseded by a newer position
    lastElev = ft == null ? "" : `${Math.round(ft).toLocaleString()} ft`;
    renderCoords();
  }

  map.on("move", updateCoords);
  map.on("moveend", updateElevation);
  updateCoords();
  updateElevation();
  coordsEl?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(
        `${lastGrid}  (${lastLL})${lastElev ? "  " + lastElev : ""}`
      );
      coordsEl.classList.add("copied");
      setTimeout(() => coordsEl.classList.remove("copied"), 1200);
    } catch {
      /* clipboard unavailable */
    }
  });

  initSky(() => {
    const c = map.getCenter();
    return { lat: c.lat, lng: c.lng };
  });

  void initWaypoints(map);
  initMeasure(map);
  // Read through a getter: terrain availability changes when you switch states.
  initReadiness(() => terrainAvailable);
  initCompass(() => {
    const c = map.getCenter();
    return { lat: c.lat, lng: c.lng };
  });
  initViewshed(() => map);
  initSearch({
    map: () => map,
    sourceUrl: () => PMTILES_URL.replace(/^pmtiles:\/\//, ""),
    dropPin: (lng, lat) => dropGotoPin(map, lng, lat),
  });
  mvumCtl = initMvum({
    map: () => map,
    activeAbbr: () => activePackAbbr,
  });
  // A freshly downloaded overlay should appear without reopening anything.
  setMvumListener(() => mvumCtl?.packChanged());
  initMesh({
    map: () => map,
    here: () => {
      const c = map.getCenter();
      return [c.lng, c.lat];
    },
    // Route to a teammate. initRoute runs further down, so this reads the
    // control through a getter rather than capturing it before it exists.
    routeTo: (lng, lat, label) => routeCtl?.routeTo(lng, lat, label),
  });
  initUpdater();
  void initVersion();
  routeCtl = initRoute({
    map: () => map,
    sourceUrl: () => PMTILES_URL.replace(/^pmtiles:\/\//, ""),
    activeAbbr: () => activePackAbbr,
  });
  initPrint({
    getMap: () => map,
    // Paper is always the light theme — dark maps waste ink and scan badly.
    printStyle: () => buildStyle("light"),
    regionName: () => document.getElementById("hud-state")?.textContent || "",
  });
  initPanels();

  void initStateLibrary(switchToSource);
}

// --- HUD wiring: day/night + terrain toggles ---
function applyThemeUi() {
  const t = THEME[currentTheme];
  document.body.style.background = t.bg;
  const themeBtn = document.getElementById("theme-toggle");
  // Icon-only now: the glyph shows what tapping switches TO, and the title
  // carries the words for anyone who needs them.
  if (themeBtn) {
    themeBtn.textContent = currentTheme === "dark" ? "☀" : "☾";
    themeBtn.title = currentTheme === "dark" ? "Switch to day colours" : "Switch to night colours";
  }
  const terrBtn = document.getElementById("terrain-toggle");
  if (terrBtn) {
    // Label stays short ("Terrain"); on/off is shown by the dimmed .off state.
    terrBtn.textContent = "△ Terrain";
    terrBtn.title = terrainOn ? "Terrain: on" : "Terrain: off";
    terrBtn.classList.toggle("off", !terrainOn);
    terrBtn.classList.toggle("hidden", !terrainAvailable);
  }
  const plBtn = document.getElementById("publicland-toggle");
  if (plBtn) {
    plBtn.title = publicLandOn ? "Public land: on" : "Public land: off";
    plBtn.classList.toggle("off", !publicLandOn);
  }
  const batBtn = document.getElementById("battery-toggle");
  if (batBtn) {
    batBtn.title = batteryOn
      ? "Battery saver: on (dimmed, terrain off)"
      : "Battery saver: off";
    batBtn.classList.toggle("off", !batteryOn);
  }
  document.body.classList.toggle("battery", batteryOn);
  // Legend rows for the overlay only make sense while it's on.
  document.querySelectorAll<HTMLElement>(".legend-row.publicland").forEach((el) => {
    el.classList.toggle("hidden", !publicLandOn);
  });
  const fs = document.querySelector<HTMLElement>(".swatch.forest");
  const ts = document.querySelector<HTMLElement>(".swatch.trail");
  const cs = document.querySelector<HTMLElement>(".swatch.contour");
  if (fs) fs.style.borderTopColor = t.forest;
  if (ts) ts.style.borderTopColor = t.trail;
  if (cs) cs.style.borderTopColor = t.contour;
}

// --- Network indicator: proves the map does NOT depend on the internet ---
function refreshNetStatus() {
  const dot = document.getElementById("net-dot");
  const label = document.getElementById("net-label");
  if (!dot || !label) return;
  if (navigator.onLine) {
    dot.className = "dot online";
    label.textContent = "online · map is local";
  } else {
    dot.className = "dot offline";
    label.textContent = "OFFLINE · fully operational";
  }
}
window.addEventListener("online", refreshNetStatus);
window.addEventListener("offline", refreshNetStatus);
refreshNetStatus();

// --- First-run placeholder ---

// --- Bottom sheet (phones only) ---

/** Must match the breakpoint the sheet styles are written against. */
const PHONE = "(max-width: 700px)";
function isPhone(): boolean {
  return window.matchMedia(PHONE).matches;
}

type SheetState = "sheet-peek" | "sheet-half" | "sheet-full";
const SHEET_STATES: SheetState[] = ["sheet-peek", "sheet-half", "sheet-full"];

/**
 * Mirror the menu's collapsed state onto <body>.
 *
 * The scale bars and coordinate readout are lifted to clear the sheet, and have
 * to drop back when it is hidden. They aren't inside the HUD, so CSS can only
 * reach them from an ancestor — `:has()` would do it but needs Safari 15.4, and
 * this app still targets iOS 14.
 */
function syncMenuHidden(hud: HTMLElement | null) {
  document.body.classList.toggle("menu-hidden", !!hud?.classList.contains("collapsed"));
}

function setSheet(hud: HTMLElement, state: SheetState) {
  hud.classList.remove(...SHEET_STATES);
  hud.classList.add(state);
  // Drop the transform a drag left behind, so the class governs again.
  hud.style.transform = "";
  localStorage.setItem("griddown_sheet", state);
}

/**
 * Drag-to-resize for the phone bottom sheet.
 *
 * Deliberately driven by height rather than a transform: the body is a
 * scrolling flex child, so changing the sheet's height reflows the list to fit,
 * whereas translating it would just slide the overflow off-screen.
 */
function setupSheet(hud: HTMLElement) {
  const grip = document.getElementById("hud-grip");
  const bar = document.getElementById("hud-bar");
  if (!grip || !bar) return;

  const stored = localStorage.getItem("griddown_sheet") as SheetState | null;
  hud.classList.add(stored && SHEET_STATES.includes(stored) ? stored : "sheet-half");

  // The desktop panel's collapsed state means nothing to a sheet, and a choice
  // made on a desktop must not arrive on the phone as a menu that will not
  // open. The sheet's own resting position is the only state here.
  //
  // Re-checked whenever the breakpoint is crossed, not just at startup: an
  // iPhone in landscape is 844px wide, which is the desktop layout with a
  // working ☰. Collapse it there, rotate back to portrait, and `menu-hidden`
  // would still be on <body> — dropping the scale bar and coordinates back
  // underneath the sheet, the exact overlap the sheet exists to avoid.
  const phoneQuery = window.matchMedia(PHONE);
  const dropDesktopState = () => {
    if (!phoneQuery.matches) return;
    hud.classList.remove("collapsed");
    document.body.classList.remove("menu-hidden");
  };
  dropDesktopState();
  // addEventListener on MediaQueryList is Safari 14+; addListener is the
  // deprecated fallback for anything older, which this app still targets.
  if (typeof phoneQuery.addEventListener === "function") {
    phoneQuery.addEventListener("change", dropDesktopState);
  } else if (typeof (phoneQuery as any).addListener === "function") {
    (phoneQuery as any).addListener(dropDesktopState);
  }

  /** Distance a finger must travel before this counts as a drag, not a tap. */
  const DRAG_SLOP = 4;

  let startY = 0;
  /** How far the sheet was pushed down when the drag began, in px. */
  let startShift = 0;
  let moved = false;

  /**
   * How far the sheet is currently pushed down.
   *
   * Untranslated it sits flush with the bottom, so its top would be at
   * `innerHeight - height`. Anything below that is the shift.
   */
  const currentShift = () =>
    hud.getBoundingClientRect().top - (window.innerHeight - hud.offsetHeight);
  /**
   * Which pointer owns the drag, or null when idle.
   *
   * A second finger must not take over. Without this it would overwrite the
   * origin — so the first finger's next move would jump the sheet by the gap
   * between the two — and then lifting either one would end the drag, leaving
   * the still-held finger doing nothing.
   */
  let activeId: number | null = null;

  const down = (e: PointerEvent) => {
    if (!isPhone()) return;
    if (activeId !== null) return;
    activeId = e.pointerId;
    moved = false;
    startY = e.clientY;
    startShift = currentShift();
    // Pin the sheet where it actually is before killing the transition. Caught
    // mid-animation, `dragging` would otherwise snap it straight to the class's
    // target — a jump on touch-down, then a second jump back on the first move.
    hud.style.transform = `translateY(${startShift}px)`;
    hud.classList.add("dragging");
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== activeId) return;
    const dy = e.clientY - startY;
    // Ignore the first few pixels so a tap on the bar doesn't nudge the sheet.
    if (!moved && Math.abs(dy) < DRAG_SLOP) return;
    moved = true;

    // Only the transform changes, so this costs a composite and no layout —
    // which is the whole reason the sheet moves instead of resizing.
    const limit = hud.offsetHeight - 48;
    const shift = Math.max(0, Math.min(limit, startShift + dy));
    hud.style.transform = `translateY(${shift}px)`;
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== activeId) return;
    activeId = null;
    hud.classList.remove("dragging");

    if (!moved) {
      // A tap, not a drag. Leave the resting position alone.
      hud.style.transform = "";
      return;
    }

    // Snap by how much of the sheet is showing. Measured before clearing the
    // transform, and against thresholds rather than the peek height — the peek
    // is defined in CSS with a safe-area inset in it, and re-deriving that here
    // is how the two drift apart.
    const visible = hud.offsetHeight - currentShift();
    const vh = window.innerHeight;
    if (visible < vh * 0.28) setSheet(hud, "sheet-peek");
    else if (visible < vh * 0.67) setSheet(hud, "sheet-half");
    else setSheet(hud, "sheet-full");
  };

  for (const el of [grip, bar]) {
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }
}

// --- Welcome screen (first run) + Map library panel open/close ---
function initChrome() {
  // Menu collapse toggle (☰) — hides everything but the bar; choice persists.
  const hud = document.getElementById("hud");
  if (hud && localStorage.getItem("griddown_menu_collapsed") === "1") {
    hud.classList.add("collapsed");
  }
  syncMenuHidden(hud);
  document.getElementById("hud-toggle")?.addEventListener("click", () => {
    // Same meaning on both: ☰ hides the menu completely. On a phone that turns
    // the bottom sheet back into the corner pill (see the sheet styles).
    const collapsed = hud?.classList.toggle("collapsed");
    localStorage.setItem("griddown_menu_collapsed", collapsed ? "1" : "0");
    syncMenuHidden(hud);
  });
  if (hud) setupSheet(hud);

  const welcome = document.getElementById("welcome");
  const startBtn = document.getElementById("welcome-start");
  if (welcome && !localStorage.getItem("griddown_welcomed")) {
    welcome.classList.remove("hidden");
  }
  startBtn?.addEventListener("click", () => {
    localStorage.setItem("griddown_welcomed", "1");
    welcome?.classList.add("hidden");
  });

  const panel = document.getElementById("states-panel");
  document.getElementById("states-open")?.addEventListener("click", () =>
    panel?.classList.remove("hidden")
  );
  document.getElementById("states-close")?.addEventListener("click", () =>
    panel?.classList.add("hidden")
  );

  // Red night-vision mode (preserves night vision; persists across launches).
  const nvBtn = document.getElementById("nightvis-toggle");
  function applyNightVis(on: boolean) {
    document.body.classList.toggle("nightvis", on);
    nvBtn?.classList.toggle("on", on);
    if (nvBtn) {
      nvBtn.textContent = on ? "◉" : "◑";
      nvBtn.title = on ? "Night vision: on" : "Night vision (red)";
    }
  }
  applyNightVis(localStorage.getItem("griddown_nightvis") === "1");
  nvBtn?.addEventListener("click", () => {
    const on = !document.body.classList.contains("nightvis");
    localStorage.setItem("griddown_nightvis", on ? "1" : "0");
    applyNightVis(on);
  });

  initHandbook();
}
initChrome();

void start();
