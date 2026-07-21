import maplibregl from "maplibre-gl";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { demTiles, demContourUrl, setDemRoot, sampleElevationM } from "./dem";
import { initStateLibrary, setMvumListener, type SwitchTarget } from "./states";
import { initMvum } from "./mvum";
import { initMesh } from "./mesh";
import { initHandbook, openHandbook } from "./handbook";
import { likelyFish, FISHABLE_KINDS } from "./fish";
import { likelyForage } from "./forage";
import { seasonReport } from "./season";
import { scoreCamp, type CampInputs } from "./campsite";
import { nearbyLakes, lakeNameNear, clearLakesCache, type Lake } from "./lakes";
import { esc } from "./esc";
import { initSky } from "./sky";
import { initWaypoints } from "./waypoints";
import { initMeasure } from "./measure";
import { dropGotoPin } from "./goto";
import { initSearch, resetPlaceIndex } from "./search";
import { initRoute } from "./route";
import { initUpdater } from "./updater";
import { initVersion } from "./version";
import { initPanels } from "./panels";
import { initReadiness } from "./readiness";
import { initPrint } from "./print";
import { initCompass, headingFrom, shortestTurn } from "./compass";
import { declination, magneticToTrue } from "./geomag";
import { getFix, type GeoFix } from "./geoloc";
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
/** The active pack's URL without the pmtiles:// prefix — for direct PMTiles
 *  reads (place search, lakes), the same form initSearch/initRoute use. */
const packUrl = () => PMTILES_URL.replace(/^pmtiles:\/\//, "");

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
// Fishing overlay: emphasise fishable water and let a tap identify the water
// and its likely catch (see fish.ts). All from the basemap `water` layer, so it
// works offline in every downloaded pack.
let fishingOn = localStorage.getItem("griddown_fishing") === "1";
// Still water worth tinting so lakes read as a surface, not just a shoreline.
// Excludes the non-fishable kinds (ditch, drain, fountain, swimming_pool).
const STILL_FISH = ["water", "lake", "reservoir", "pond", "basin", "lagoon"];
// Drinking-water sources (springs, wells) — folded into the Fishing overlay so
// it shows where to fish AND where to find drinkable water. (Was a separate
// "Water" chip; the data is the same POI kinds.)
const WATER_SOURCE_KINDS = ["drinking_water", "water_point", "spring", "water_well", "well", "water_tap"];

// Wild-food overlay: land that might feed you (see forage.ts). Split into the
// wild ground (woods, brush, meadow — forage + game) and cultivated ground
// (farmland, orchard, vineyard — crops + fruit), tinted differently.
let wildfoodOn = localStorage.getItem("griddown_wildfood") === "1";
const FORAGE_WILD = ["forest", "wood", "scrub", "meadow", "grassland", "grass", "wetland"];
const FORAGE_CROP = ["farmland", "farmyard", "orchard", "vineyard"];
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

/** Fishing overlay fills — tint still water so lakes read as a fishable
 *  surface. Inserted under roads, like the public-land fills. */
function fishingFills(): any[] {
  return [
    {
      id: "app-fish-fill", type: "fill", source: "protomaps", "source-layer": "water",
      filter: ["in", ["get", "kind"], ["literal", STILL_FISH]],
      paint: { "fill-color": "#38d6ff", "fill-opacity": 0.16 },
    },
  ];
}

/** Fishing overlay lines — a cyan outline on every fishable water body so
 *  rivers and creeks stand out and read as tappable. */
function fishingLines(): any[] {
  return [
    {
      id: "app-fish-line", type: "line", source: "protomaps", "source-layer": "water",
      filter: ["in", ["get", "kind"], ["literal", FISHABLE_KINDS]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#38d6ff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 12, 1.8, 15, 3.2],
        "line-opacity": 0.9,
      },
    },
  ];
}

/** Drinking-water source POIs (springs/wells), shown with the Fishing overlay.
 *  Dots + labels, drawn on top like the resource POIs. */
function fishingPois(t: (typeof THEME)[ThemeName]): any[] {
  const filter: any = ["in", ["get", "kind"], ["literal", WATER_SOURCE_KINDS]];
  return [
    {
      id: "app-fish-src-dot", type: "circle", source: "protomaps", "source-layer": "pois",
      filter, minzoom: 11,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 14, 5.5, 16, 7.5],
        "circle-color": "#3fa9f5",
        "circle-stroke-color": "#0a0a0a",
        "circle-stroke-width": 1.5,
        "circle-opacity": 0.92,
      },
    },
    {
      id: "app-fish-src-label", type: "symbol", source: "protomaps", "source-layer": "pois",
      filter: ["all", filter, ["has", "name"]], minzoom: 14,
      layout: {
        "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"],
        "text-size": 10, "text-offset": [0, 0.9], "text-anchor": "top", "text-optional": true,
      },
      paint: { "text-color": "#3fa9f5", "text-halo-color": t.halo, "text-halo-width": 1.4 },
    },
  ];
}

/** Wild-food overlay fills — green for wild ground, amber for cultivated. */
function forageFills(): any[] {
  return [
    {
      id: "app-forage-wild-fill", type: "fill", source: "protomaps", "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", FORAGE_WILD]],
      paint: { "fill-color": "#5fd06a", "fill-opacity": 0.14 },
    },
    {
      id: "app-forage-crop-fill", type: "fill", source: "protomaps", "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", FORAGE_CROP]],
      paint: { "fill-color": "#ffbe5a", "fill-opacity": 0.16 },
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

  // An always-present, fully transparent fill over every landuse polygon, so
  // Camp check can read the land — forest, wetland, and especially military —
  // from queryRenderedFeatures no matter which overlays are on. The base style
  // only draws a few landuse kinds, so without this the "avoid military land"
  // gate and tree-cover check silently miss most ground. A zero-opacity fill is
  // invisible but still answers feature queries; visibility:none would not.
  base.push({
    id: "app-landuse-query",
    type: "fill",
    source: "protomaps",
    "source-layer": "landuse",
    paint: { "fill-color": "#000000", "fill-opacity": 0 },
  });

  // Lakes carry their name on a separate label POINT, not on the polygon you
  // tap — so tapping a lake hits an unnamed shape. This invisible layer makes
  // those name points queryable, so the Fishing identify can recover the name.
  base.push({
    id: "app-water-name",
    type: "circle",
    source: "protomaps",
    "source-layer": "water",
    filter: ["all", ["==", ["geometry-type"], "Point"], ["has", "name"]],
    paint: { "circle-radius": 3, "circle-opacity": 0, "circle-stroke-width": 0 },
  });

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

  if (fishingOn) {
    // Water tint sits under the roads too, so a road crossing a river stays on
    // top of the highlight rather than being washed out by it.
    const firstRoad = base.findIndex(
      (l) => typeof l.id === "string" && l.id.startsWith("roads")
    );
    base.splice(firstRoad >= 0 ? firstRoad : base.length, 0, ...fishingFills());
  }

  if (wildfoodOn) {
    const firstRoad = base.findIndex(
      (l) => typeof l.id === "string" && l.id.startsWith("roads")
    );
    base.splice(firstRoad >= 0 ? firstRoad : base.length, 0, ...forageFills());
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
    ...(fishingOn ? fishingLines() : []),
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
    layers: [
      ...base, ...emphLabels, ...resourceLayers(t),
      ...(fishingOn ? fishingPois(t) : []),
      ...contourLabels,
    ],
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

/**
 * Where to read the region's basemap from.
 *
 * The bundled starter pack cannot be fetched from the frontend the way every
 * other file in `public/` is. PMTiles reads an archive with HTTP range
 * requests, and the protocol serving the bundled frontend implements none — it
 * answers with the whole file and a 200, which the PMTiles reader refuses
 * outright rather than guessing. That is a grey screen on a fresh install of
 * any packaged build, while `tauri dev` works perfectly, because Vite serves
 * ranges. Which is exactly why it took a real device to notice.
 *
 * In the app it therefore goes through the asset protocol, which does implement
 * ranges and is how downloaded packs have always been read. In a browser there
 * is no asset protocol, and whatever is serving the page serves ranges anyway.
 */
async function regionPmtilesUrl(region: { pmtiles: string }): Promise<string> {
  const plain = `pmtiles://${origin}/mapdata/${region.pmtiles}`;
  if (typeof (window as any).__TAURI_INTERNALS__ === "undefined") return plain;
  try {
    const path = await invoke<string>("starter_path");
    return `pmtiles://${convertFileSrc(path)}`;
  } catch (err) {
    // A map that might not draw beats no map at all: the plain URL is still
    // correct anywhere ranges are served.
    console.error("[starter] falling back to the frontend copy", err);
    return plain;
  }
}

async function start() {
  const region = await loadRegion();
  PMTILES_URL = await regionPmtilesUrl(region);

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

  // "Where am I" — one fix, marked with a dot and an accuracy circle, the map
  // centred on it. Never a continuous GPS watch: a stray one was the single
  // heaviest battery drain available to us, and the rest of the app is one-shot
  // too (route.ts, compass.ts). The fix comes from geoloc.ts, which on a phone
  // uses the native location plugin so there is only the OS permission prompt,
  // not WKWebView's extra per-website one.

  // --- User-location dot + accuracy circle --------------------------------
  // Drawn here rather than by MapLibre's GeolocateControl: that control is
  // hardwired to the web geolocation API, which is exactly the double-prompt
  // this whole change avoids.
  let shownFix: GeoFix | null = null;
  const ULOC = "gd-userloc";

  function accuracyRing(lng: number, lat: number, metres: number, n = 64): [number, number][] {
    const R = 6378137;
    const latR = (lat * Math.PI) / 180;
    const ring: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI;
      const dLat = ((metres * Math.cos(a)) / R) * (180 / Math.PI);
      const dLng = ((metres * Math.sin(a)) / (R * Math.cos(latR))) * (180 / Math.PI);
      ring.push([lng + dLng, lat + dLat]);
    }
    return ring;
  }
  function ensureUserLayers() {
    if (map.getSource(ULOC)) return;
    map.addSource(ULOC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    // The accuracy circle is a Polygon; the dot is a Point — both live on one
    // source, split by geometry type. The dot is a GL circle, not a DOM marker,
    // so it renders at exactly the projected coordinate and lands on the
    // centre crosshair when the map is centred on you (no marker-transform drift).
    map.addLayer(
      { id: "gd-userloc-fill", type: "fill", source: ULOC,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#3b82f6", "fill-opacity": 0.15 } },
      firstSymbol
    );
    map.addLayer(
      { id: "gd-userloc-ring", type: "line", source: ULOC,
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "line-color": "#3b82f6", "line-opacity": 0.5, "line-width": 1 } },
      firstSymbol
    );
    map.addLayer(
      { id: "gd-userloc-dot", type: "circle", source: ULOC,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 7,
          "circle-color": "#3b82f6",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
        } },
      firstSymbol
    );
  }
  function drawUserLoc(f: GeoFix) {
    ensureUserLayers();
    const feats: GeoJSON.Feature[] = [
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [f.lng, f.lat] } },
    ];
    if (f.accuracy && f.accuracy > 1) {
      feats.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [accuracyRing(f.lng, f.lat, f.accuracy)] },
      });
    }
    (map.getSource(ULOC) as maplibregl.GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: feats,
    });
  }
  // A theme switch rebuilds the style and drops the source/layers; restore them.
  map.on("style.load", () => {
    if (shownFix) drawUserLoc(shownFix);
  });

  // --- Combined locate / heading-up control -------------------------------
  //
  // One button, three states, like the location button in other map apps:
  //   off      → tap: find me and centre there (a one-shot fix + dot).
  //   located  → tap: turn the map to face the way I point, centred on me.
  //   heading  → tap: back to north up.
  //
  // Heading is compass-driven (device orientation), never a GPS watch, so it
  // stays consistent with the deliberately one-shot Locate and costs no extra
  // battery.
  type LocState = "off" | "located" | "heading";
  let locState: LocState = "off";
  let locBusy = false; // true while a fix is being fetched
  let locBtn: HTMLButtonElement | null = null;
  let lastFix: { lng: number; lat: number } | null = null;
  let headingBusy = false; // true while the iOS permission prompt is pending
  let headingDec = 0; // magnetic→true correction for the area, degrees
  let smoothBearing = 0; // continuous, low-pass filtered to damp sensor jitter

  const LOCATE_SVG =
    '<svg class="gd-loc-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4.4" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="12" cy="12" r="1.5" fill="currentColor"/>' +
    '<path d="M12 1.5V5M12 19v3.5M1.5 12H5M19 12h3.5" stroke="currentColor" stroke-width="2"/></svg>';
  const HEADING_SVG =
    '<svg class="gd-loc-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<path d="M12 2 L19 21 L12 16.5 L5 21 Z" fill="currentColor"/></svg>';

  function renderLoc() {
    if (!locBtn) return;
    const heading = locState === "heading";
    locBtn.innerHTML = heading ? HEADING_SVG : LOCATE_SVG;
    locBtn.classList.toggle("gd-on", locState !== "off");
    locBtn.classList.toggle("gd-busy", locBusy);
    locBtn.setAttribute("aria-pressed", String(locState !== "off"));
    locBtn.title = locBusy
      ? "Finding your location…"
      : heading
        ? "Heading up — tap for north up"
        : locState === "located"
          ? "Located — tap to turn the map to face your heading"
          : "Show my location";
  }

  function applyHeading(e: DeviceOrientationEvent) {
    const mag = headingFrom(e);
    if (mag == null) return;
    const target = magneticToTrue(mag, headingDec);
    // Ease a quarter of the way toward the reading each event, along the short
    // arc — smooths the noisy sensor and crosses north without spinning. The
    // map is true-north, so the magnetic reading is corrected first.
    smoothBearing += shortestTurn(smoothBearing, target) * 0.25;
    map.setBearing(((smoothBearing % 360) + 360) % 360);
  }
  function stopHeadingSensor() {
    window.removeEventListener("deviceorientationabsolute" as any, applyHeading);
    window.removeEventListener("deviceorientation", applyHeading);
  }

  /** Begin heading-up: centre on the user (not the crosshair) and rotate. */
  async function startHeading(): Promise<boolean> {
    const doe = (window as any).DeviceOrientationEvent;
    if (!doe) {
      toast("No compass on this device — heading-up needs a phone or tablet.", "error");
      return false;
    }
    // iOS gates the sensor behind a permission prompt that must come from a user
    // gesture — the click that called this is that gesture. `headingBusy` blocks
    // a second tap from starting a second prompt while it's pending.
    if (typeof doe.requestPermission === "function") {
      if (headingBusy) return false;
      headingBusy = true;
      try {
        if ((await doe.requestPermission()) !== "granted") {
          toast("Compass permission denied — can't turn the map to your heading.", "error");
          return false;
        }
      } catch {
        toast("Couldn't start the compass.", "error");
        return false;
      } finally {
        headingBusy = false;
      }
    }
    // Centre on you rather than wherever the map was left. lastFix is from the
    // locate that got us to this state, so it's fresh — no extra GPS.
    const at = lastFix ?? { lng: map.getCenter().lng, lat: map.getCenter().lat };
    if (lastFix) map.easeTo({ center: [lastFix.lng, lastFix.lat], duration: 400 });
    try {
      headingDec = declination(at.lat, at.lng);
    } catch {
      headingDec = 0;
    }
    smoothBearing = map.getBearing();
    window.addEventListener("deviceorientationabsolute" as any, applyHeading);
    window.addEventListener("deviceorientation", applyHeading);
    toast("Heading up — the map turns to face the way you point. Tap again for north up.", "info");
    return true;
  }

  /** Fetch a fix, centre on it, and mark it. Throws on failure. Shared by the
   *  locate button and the compass panel ("go to my location first"). */
  async function locateUser(): Promise<GeoFix> {
    const f = await getFix();
    lastFix = { lng: f.lng, lat: f.lat };
    shownFix = f;
    drawUserLoc(f);
    map.flyTo({ center: [f.lng, f.lat], zoom: Math.max(map.getZoom(), 14) });
    return f;
  }

  async function cycleLocate() {
    if (locBusy) return;
    if (locState === "off") {
      locBusy = true;
      renderLoc();
      try {
        await locateUser();
        locState = "located";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast(
          /denied/i.test(msg)
            ? "Location permission denied — allow it in your system settings."
            : "Couldn't get a location fix. Most desktops have no GPS; this works on a phone or tablet.",
          "error",
          6000
        );
      } finally {
        locBusy = false;
        renderLoc();
      }
    } else if (locState === "located") {
      if (await startHeading()) {
        locState = "heading";
        renderLoc();
      }
    } else {
      stopHeadingSensor();
      map.easeTo({ bearing: 0, duration: 400 }); // north up
      locState = "off";
      renderLoc();
    }
  }

  class LocateControl implements maplibregl.IControl {
    private _c!: HTMLElement;
    onAdd() {
      const c = document.createElement("div");
      c.className = "maplibregl-ctrl maplibregl-ctrl-group";
      const b = document.createElement("button");
      b.type = "button";
      b.addEventListener("click", () => void cycleLocate());
      locBtn = b;
      c.appendChild(b);
      this._c = c;
      renderLoc();
      return c;
    }
    onRemove() {
      this._c.remove();
    }
  }
  map.addControl(new LocateControl(), "top-right");
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
  document.getElementById("fishing-toggle")?.addEventListener("click", () => {
    fishingOn = !fishingOn;
    localStorage.setItem("griddown_fishing", fishingOn ? "1" : "0");
    map.setStyle(buildStyle(currentTheme));
    applyThemeUi();
    // The identify panel belongs to the overlay — close it when the layer goes.
    if (!fishingOn) document.getElementById("fish-box")?.classList.add("hidden");
  });
  document.getElementById("wildfood-toggle")?.addEventListener("click", () => {
    wildfoodOn = !wildfoodOn;
    localStorage.setItem("griddown_wildfood", wildfoodOn ? "1" : "0");
    map.setStyle(buildStyle(currentTheme));
    applyThemeUi();
    if (!wildfoodOn) document.getElementById("forage-box")?.classList.add("hidden");
  });
  applyThemeUi();

  // Assigned further down, once the overlay is initialised — switchToSource is
  // declared before it but only ever runs after.
  let mvumCtl: { packChanged(): void } | null = null;
  let routeCtl: { routeTo(lng: number, lat: number, label: string): void } | null = null;

  // --- Map info cards: tap water (Fishing) or land (Wild food) to identify it
  // and its likely food, plus the Camp-check and In-season tools. Everything
  // reads the pack's own data, so it all works offline. ---
  const fishBox = document.getElementById("fish-box");
  const forageBox = document.getElementById("forage-box");
  const campBox = document.getElementById("camp-box");
  const seasonBox = document.getElementById("season-box");
  const lakesBox = document.getElementById("lakes-box");
  // One generation counter across the tap-cards. ANY change to what should be on
  // screen — a new tap, a close, an overlay toggled off, another card opened —
  // bumps it, so a render still waiting on its elevation lookup sees `gen !==
  // cardGen` and no-ops instead of painting a card the user has moved on from.
  let cardGen = 0;
  const closeFishBox = () => { cardGen++; fishBox?.classList.add("hidden"); };
  // These cards all sit top-centre, so only one shows at a time — opening one
  // closes the others rather than stacking them. Bumping the token here also
  // cancels any pending render for a card we're hiding.
  function hideCards(keep?: Element | null) {
    cardGen++;
    for (const b of [fishBox, forageBox, campBox, seasonBox, lakesBox]) {
      if (b && b !== keep) b.classList.add("hidden");
    }
  }

  // ---- Fishing card ----
  function renderFishBox(
    lng: number, lat: number, kind: string, title: string, elevFt: number | null
  ) {
    // fishingOn can flip off during the elevation await — don't paint a card
    // for an overlay the user just turned off.
    if (!fishBox || !fishingOn) return;
    hideCards(fishBox);
    const g = likelyFish({ kind, name: title, elevationFt: elevFt, lat, lng });
    const regimeWord =
      g.regime === "cold" ? "coldwater" : g.regime === "warm" ? "warmwater" : "coolwater";
    const elevLabel = elevFt != null ? `${Math.round(elevFt).toLocaleString()} ft` : "elevation n/a";
    const chips = g.species.map((s) => `<span class="fish-sp">${esc(s)}</span>`).join("");
    fishBox.innerHTML = `
      <div id="fish-head">
        <span class="goto-title">&#127907; ${esc(title)}</span>
        <button id="fish-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="fish-sub">${esc(g.waterType)} &middot; ${elevLabel} &middot; ${regimeWord}</div>
      <div class="fish-label">Likely here</div>
      <div class="fish-species">${chips}</div>
      ${elevFt == null && !terrainAvailable
        ? `<div class="fish-note">Add terrain to this pack for a sharper guess.</div>`
        : ""}
      <div class="fish-method">${esc(g.method)}</div>
      <div class="fish-drink">Before you drink it: purify first &mdash; boil 1 min, filter, or treat.
        <button id="fish-water" type="button" class="fish-link">Water how-to &rarr;</button></div>
      <div class="fish-caveat">${esc(g.caveat)}</div>
      <div class="fish-actions">
        <button id="fish-route" type="button">&#10148; Get there</button>
        <button id="fish-book" type="button">&#128214; Catch &amp; cook</button>
      </div>`;
    fishBox.classList.remove("hidden");
    document.getElementById("fish-close")?.addEventListener("click", closeFishBox);
    document.getElementById("fish-route")?.addEventListener("click", () => {
      closeFishBox();
      routeCtl?.routeTo(lng, lat, title);
    });
    document.getElementById("fish-book")?.addEventListener("click", () =>
      openHandbook("food procurement")
    );
    document.getElementById("fish-water")?.addEventListener("click", () =>
      openHandbook("water procurement")
    );
  }

  async function showFishBox(lng: number, lat: number, kind: string, name: string) {
    if (!fishBox) return;
    const gen = ++cardGen;
    // When zoomed out, the lake's on-map label isn't rendered, so the tap
    // couldn't read a name from it. Fall back to reading the name straight from
    // the tiles — but only for still water (rivers already named on the line).
    const needName = !name && STILL_FISH.includes(kind);
    const [elevM, found] = await Promise.all([
      terrainAvailable ? sampleElevationM(lng, lat) : Promise.resolve(null),
      needName ? lakeNameNear({ url: packUrl(), lng, lat }).catch(() => "") : Promise.resolve(name),
    ]);
    if (gen !== cardGen) return;
    const title = found || `Unnamed ${
      kind === "river" ? "river" : kind === "stream" ? "creek"
      : kind === "reservoir" ? "reservoir" : "water"}`;
    renderFishBox(lng, lat, kind, title, elevM == null ? null : elevM * 3.28084);
  }

  // ---- Wild-food card ----
  function renderForageBox(lng: number, lat: number, landuseKind: string, elevFt: number | null) {
    if (!forageBox || !wildfoodOn) return;
    hideCards(forageBox);
    const g = likelyForage({ landuseKind, elevationFt: elevFt, lat, lng, month: new Date().getMonth() });
    const elevLabel = elevFt != null ? `${Math.round(elevFt).toLocaleString()} ft · ` : "";
    const plants = g.plants.map((s) => `<span class="card-chip">${esc(s)}</span>`).join("");
    const game = g.game.map((s) => `<span class="card-chip">${esc(s)}</span>`).join("");
    forageBox.innerHTML = `
      <div class="card-head">
        <span class="card-title">&#127807; ${esc(g.habitat)}</span>
        <button class="card-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="card-sub">${elevLabel}${esc(g.seasonNote)}</div>
      <div class="card-label">Wild plants</div>
      <div class="card-chips">${plants}</div>
      <div class="card-label">Game</div>
      <div class="card-chips">${game}</div>
      <div class="card-caveat">${esc(g.caution)}</div>
      <div class="card-actions">
        <button id="forage-route" type="button">&#10148; Get there</button>
        <button id="forage-book" type="button">&#128214; Plants guide</button>
      </div>`;
    forageBox.classList.remove("hidden");
    forageBox.querySelector(".card-close")?.addEventListener("click", () => {
      cardGen++;
      forageBox.classList.add("hidden");
    });
    document.getElementById("forage-route")?.addEventListener("click", () => {
      forageBox.classList.add("hidden");
      routeCtl?.routeTo(lng, lat, g.habitat);
    });
    document.getElementById("forage-book")?.addEventListener("click", () =>
      openHandbook("survival use of plants")
    );
  }

  async function showForageBox(lng: number, lat: number, landuseKind: string) {
    if (!forageBox) return;
    const gen = ++cardGen;
    const elevM = terrainAvailable ? await sampleElevationM(lng, lat) : null;
    if (gen !== cardGen) return;
    renderForageBox(lng, lat, landuseKind, elevM == null ? null : elevM * 3.28084);
  }

  // Standard ray-cast point-in-ring.
  function inRing(pt: [number, number], ring: number[][]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > pt[1]) !== (yj > pt[1]) &&
          pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inGeom(pt: [number, number], geom: any): boolean {
    const inPoly = (rings: number[][][]) =>
      rings.length > 0 && inRing(pt, rings[0]) && !rings.slice(1).some((h) => inRing(pt, h));
    if (geom?.type === "Polygon") return inPoly(geom.coordinates);
    if (geom?.type === "MultiPolygon") return geom.coordinates.some(inPoly);
    return false;
  }

  // The name of a tapped lake — recovered from the separate label POINT, since
  // the polygon itself is unnamed. Returns ONLY a label that lies inside the
  // tapped polygon (unambiguous), over a bounded query; if none is rendered
  // (zoomed out, or clipped across tiles) it returns "" and the caller falls
  // back to the tile-scan lookup. Guessing the nearest on-screen label could
  // name a neighbouring lake, so it no longer does.
  function waterName(tapPt: { x: number; y: number }, polyGeom: any): string {
    if (!polyGeom) return "";
    const R = 500;
    let labels: maplibregl.MapGeoJSONFeature[] = [];
    try {
      labels = map.queryRenderedFeatures(
        [[tapPt.x - R, tapPt.y - R], [tapPt.x + R, tapPt.y + R]],
        { layers: ["app-water-name"] }
      );
    } catch { return ""; }
    for (const lf of labels) {
      const nm = lf.properties?.name;
      if (!nm || lf.geometry.type !== "Point") continue;
      if (inGeom(lf.geometry.coordinates as [number, number], polyGeom)) return String(nm);
    }
    return "";
  }

  // ---- Combined tap handler: water first (Fishing), then land (Wild food) ----
  map.on("click", (e) => {
    if (!fishingOn && !wildfoodOn) return;
    // Don't steal the tap from the measure tool while it's placing points.
    if (!document.getElementById("measure-readout")?.classList.contains("hidden")) return;
    const pad = 6;
    const box: [maplibregl.PointLike, maplibregl.PointLike] = [
      [e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad],
    ];
    if (fishingOn) {
      let water: maplibregl.MapGeoJSONFeature[] = [];
      try { water = map.queryRenderedFeatures(box, { layers: ["app-fish-fill", "app-fish-line"] }); }
      catch { /* layers mid-rebuild */ }
      if (water.length) {
        const f = water.find((ff) => ff.properties && ff.properties.name) || water[0];
        const kind = String(f.properties?.kind || "water");
        let name = f.properties?.name ? String(f.properties.name) : "";
        // Rivers/streams carry their name on the line we just hit; lakes don't
        // — their name is a separate label point. Recover it from the label
        // that lies inside the lake polygon we tapped.
        if (!name) {
          const poly = water.find(
            (ff) => ff.geometry?.type === "Polygon" || ff.geometry?.type === "MultiPolygon"
          );
          name = waterName(e.point, poly?.geometry);
        }
        void showFishBox(e.lngLat.lng, e.lngLat.lat, kind, name);
        return; // a tapped lake is a lake, not the woods behind it
      }
    }
    if (wildfoodOn) {
      let land: maplibregl.MapGeoJSONFeature[] = [];
      try { land = map.queryRenderedFeatures(box, { layers: ["app-forage-wild-fill", "app-forage-crop-fill"] }); }
      catch { /* layers mid-rebuild */ }
      if (land.length) {
        void showForageBox(e.lngLat.lng, e.lngLat.lat, String(land[0].properties?.kind || "forest"));
      }
    }
  });

  // ---- Camp check: score the ground under the crosshair ----
  function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
    const R = 6371000;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLng = ((bLng - aLng) * Math.PI) / 180;
    const la1 = (aLat * Math.PI) / 180, la2 = (bLat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function eachCoord(geom: any, cb: (c: [number, number]) => void) {
    if (!geom) return;
    if (geom.type === "Point") { cb(geom.coordinates); return; }
    const walk = (arr: any) => {
      if (typeof arr[0] === "number") cb(arr as [number, number]);
      else for (const x of arr) walk(x);
    };
    walk(geom.coordinates);
  }
  async function groundSlopeDeg(lng: number, lat: number): Promise<number | null> {
    if (!terrainAvailable) return null;
    const d = 0.0005; // ~55 m each way
    const dLng = d / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const els = await Promise.all([
      sampleElevationM(lng, lat + d), sampleElevationM(lng, lat - d),
      sampleElevationM(lng + dLng, lat), sampleElevationM(lng - dLng, lat),
    ]);
    if (els.some((x) => x == null)) return null;
    const [n, s, east, west] = els as number[];
    const distY = 2 * d * 111320;
    const distX = 2 * dLng * 111320 * Math.cos((lat * Math.PI) / 180);
    const grad = Math.hypot((n - s) / distY, (east - west) / distX);
    return (Math.atan(grad) * 180) / Math.PI;
  }
  const closeCampBox = () => { cardGen++; campBox?.classList.add("hidden"); };
  async function runCampCheck() {
    if (!campBox) return;
    // Claim the slot up front; the slope lookup awaits, and a tap or another
    // tool opened meanwhile must win over this result landing late.
    const gen = ++cardGen;
    const c = map.getCenter();
    const centerPt = map.project(c);
    // Read land use from the always-on transparent query layer, so this works
    // regardless of which overlays are drawn.
    let atCenter: maplibregl.MapGeoJSONFeature[] = [];
    try { atCenter = map.queryRenderedFeatures(centerPt, { layers: ["app-landuse-query"] }); }
    catch { /* layer mid-rebuild */ }
    let land: CampInputs["land"] = "unknown";
    let tree = false, wet = false;
    for (const f of atCenter) {
      const k = String(f.properties?.kind || "");
      if (MILITARY_KINDS.includes(k)) land = "military";
      else if (land !== "military" && PUBLIC_KINDS.includes(k)) land = "public";
      if (FOREST_KINDS.includes(k)) tree = true;
      if (k === "wetland") wet = true;
    }
    let waterMeters: number | null = null;
    try {
      // Size the query box to ~3 km of ground (not a fixed pixel count), so the
      // metric thresholds in scoreCamp mean the same thing at every zoom.
      // Clamp: at least a small box, at most the viewport.
      const off = map.project([c.lng, c.lat + 3000 / 111320]);
      const cv = map.getCanvas();
      // Clamp to the viewport in CSS pixels (clientWidth/Height), matching the
      // units map.project returns — the raw canvas .width/.height are DPR-scaled.
      const pad = Math.min(
        Math.max(Math.abs(off.y - centerPt.y), 60),
        Math.max(cv.clientWidth, cv.clientHeight)
      );
      const near = map.queryRenderedFeatures(
        [[centerPt.x - pad, centerPt.y - pad], [centerPt.x + pad, centerPt.y + pad]]
      );
      let min = Infinity;
      for (const f of near) {
        if ((f as any).sourceLayer !== "water") continue;
        if (!FISHABLE_KINDS.includes(String(f.properties?.kind || ""))) continue;
        eachCoord(f.geometry, ([lng, lat]) => {
          const dd = haversineM(c.lat, c.lng, lat, lng);
          if (dd < min) min = dd;
        });
      }
      if (isFinite(min)) waterMeters = min;
    } catch { /* leave null */ }
    const slopeDeg = await groundSlopeDeg(c.lng, c.lat);
    // Superseded by a tap or another card while the slope resolved — drop it.
    if (gen !== cardGen) return;
    hideCards(campBox);
    const res = scoreCamp({ slopeDeg, waterMeters, treeCover: tree, land, wetland: wet });
    const reasons = res.reasons.map((r) => `<li>${esc(r)}</li>`).join("");
    campBox.innerHTML = `
      <div class="card-head">
        <span class="card-title">&#9978; Camp check &mdash; <span class="camp-verdict ${res.verdict}">${res.verdict}</span></span>
        <button class="card-close" type="button" aria-label="Close">&times;</button>
      </div>
      <ul class="card-reasons">${reasons}</ul>
      <div class="card-caveat">Judged at the crosshair, from terrain and map data. Move the map to check another spot &mdash; and always trust your own eyes on the ground.</div>`;
    campBox.classList.remove("hidden");
    campBox.querySelector(".card-close")?.addEventListener("click", closeCampBox);
  }
  document.getElementById("camp-open")?.addEventListener("click", () => { void runCampCheck(); });

  // ---- In season: what this month offers where the map is centred ----
  const closeSeasonBox = () => { cardGen++; seasonBox?.classList.add("hidden"); };
  document.getElementById("season-open")?.addEventListener("click", () => {
    if (!seasonBox) return;
    hideCards(seasonBox);
    const c = map.getCenter();
    const r = seasonReport(new Date().getMonth(), c.lat, c.lng);
    const items = r.items
      .map((it) =>
        `<div class="season-item"><span class="si-icon">${it.icon}</span>` +
        `<span class="si-body"><span class="si-label">${esc(it.label)}</span> — ${esc(it.note)}</span></div>`
      )
      .join("");
    seasonBox.innerHTML = `
      <div class="card-head">
        <span class="card-title">&#128197; ${esc(r.monthName)} &middot; ${esc(r.season)}</span>
        <button class="card-close" type="button" aria-label="Close">&times;</button>
      </div>
      ${items}
      <div class="card-caveat">A seasonal generalisation for your area — local timing, seasons, and licences vary. Confirm the rules before you hunt or fish.</div>`;
    seasonBox.classList.remove("hidden");
    seasonBox.querySelector(".card-close")?.addEventListener("click", closeSeasonBox);
  });

  // ---- Nearby water: named lakes, reservoirs, rivers & creeks, nearest first ----
  const closeLakesBox = () => { cardGen++; lakesBox?.classList.add("hidden"); };
  let lakesGen = 0;
  function renderLakesList(fromYou: boolean, lakes: Lake[]) {
    if (!lakesBox) return;
    const where = fromYou ? "from your location" : "from the map centre";
    const rows = lakes.length
      ? lakes.slice(0, 50).map((l, i) =>
          `<button class="lake-row" data-lake="${i}">
             <span class="lake-name">${esc(l.name)}</span>
             <span class="lake-meta">${esc(l.label || "water")} &middot; ${l.distMi!.toFixed(1)} mi</span>
           </button>`
        ).join("")
      : `<div class="lake-empty">No named water found nearby in this pack.</div>`;
    lakesBox.innerHTML = `
      <div class="card-head">
        <span class="card-title">&#128167; Nearby water</span>
        <button class="card-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="card-sub">${lakes.length} within reach, ${where}</div>
      <div class="lake-list">${rows}</div>`;
    lakesBox.classList.remove("hidden");
    lakesBox.querySelector(".card-close")?.addEventListener("click", closeLakesBox);
    lakesBox.querySelectorAll<HTMLElement>("[data-lake]").forEach((el) => {
      el.addEventListener("click", () => {
        const l = lakes[Number(el.dataset.lake)];
        closeLakesBox();
        map.flyTo({ center: [l.lng, l.lat], zoom: Math.max(map.getZoom(), 12) });
        dropGotoPin(map, l.lng, l.lat);
        peekSheet();
      });
    });
  }
  document.getElementById("lakes-open")?.addEventListener("click", async () => {
    if (!lakesBox) return;
    const gen = ++lakesGen;
    hideCards(lakesBox); // supersede any tap card, keep this one
    // Alive = still the current open AND not dismissed. Covers the X button,
    // another card opening, and the panel-manager toggle-close (which just
    // hides the box) — any of them stops the in-flight scan from re-showing it.
    const alive = () => gen === lakesGen && !lakesBox.classList.contains("hidden");
    const setSub = (text: string) => {
      if (!alive()) return;
      const sub = lakesBox.querySelector(".card-sub");
      if (sub) sub.textContent = text;
    };
    lakesBox.innerHTML = `
      <div class="card-head">
        <span class="card-title">&#128167; Nearby water</span>
        <button class="card-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="card-sub">Finding your location…</div>`;
    lakesBox.classList.remove("hidden");
    lakesBox.querySelector(".card-close")?.addEventListener("click", closeLakesBox);

    // Prefer a known fix; else try for one; else fall back to the map centre.
    let center = lastFix;
    let fromYou = !!lastFix;
    if (!center) {
      try {
        const f = await getFix();
        center = { lng: f.lng, lat: f.lat };
        lastFix = center;
        fromYou = true;
      } catch {
        center = { lng: map.getCenter().lng, lat: map.getCenter().lat };
        fromYou = false;
      }
    }
    if (!alive()) return;
    setSub("Reading water from the map pack…");
    try {
      const lakes = await nearbyLakes({
        url: packUrl(),
        center: center!,
        maxMi: 80,
        onProgress: (d, t) => { if (t) setSub(`Reading water… ${d}/${t} tiles`); },
      });
      if (!alive()) return;
      renderLakesList(fromYou, lakes);
    } catch (e) {
      if (alive()) setSub(`Couldn't read water: ${e}`);
    }
  });

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
    // The lakes scanner and the place index both cache per URL; drop them too,
    // or after a same-URL refresh they'd serve the old pack's data.
    clearLakesCache();
    resetPlaceIndex();
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
  // Resource overlay chips (shelter / medical / supply / help; water folded
  // into the Water/Fishing overlay).
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
  // Build the two spans once and update textContent thereafter — rewriting
  // innerHTML every frame reparsed and recreated the nodes on the pan hot path.
  let gridSpan: HTMLElement | null = null;
  let llSpan: HTMLElement | null = null;
  if (coordsEl) {
    coordsEl.innerHTML = `<span class="c-grid"></span><span class="c-ll"></span>`;
    gridSpan = coordsEl.querySelector(".c-grid");
    llSpan = coordsEl.querySelector(".c-ll");
  }
  function renderCoords() {
    if (gridSpan) gridSpan.textContent = lastGrid;
    if (llSpan) llSpan.textContent = lastLL + (lastElev ? " · " + lastElev : "");
  }
  // Coalesce a burst of `move` events into one update per animation frame — the
  // MGRS projection and DOM write then run once per frame, not once per event.
  let coordsRaf = 0;
  function updateCoords() {
    if (coordsRaf) return;
    coordsRaf = requestAnimationFrame(() => {
      coordsRaf = 0;
      const c = map.getCenter();
      lastLL = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
      try {
        lastGrid = fmtMgrs(mgrsForward([c.lng, c.lat]));
      } catch {
        lastGrid = "—";
      }
      renderCoords();
    });
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
  initCompass(
    () => {
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng };
    },
    // Go to the user first when the compass opens, so its needle and
    // declination are for where they actually are, not wherever the map was
    // left. Falls back to the map centre (above) if there's no fix.
    async () => {
      try {
        const f = await locateUser();
        return { lat: f.lat, lng: f.lng };
      } catch {
        return null;
      }
    }
  );
  initViewshed(() => map);
  initSearch({
    map: () => map,
    sourceUrl: () => PMTILES_URL.replace(/^pmtiles:\/\//, ""),
    dropPin: (lng, lat) => dropGotoPin(map, lng, lat),
    // Reveal the map after a jump: drop the bottom sheet out of the way.
    onJump: peekSheet,
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
    (themeBtn.querySelector(".hud-icon-glyph") ?? themeBtn).textContent =
      currentTheme === "dark" ? "☀" : "☾";
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
  const fishBtn = document.getElementById("fishing-toggle");
  if (fishBtn) {
    fishBtn.title = fishingOn ? "Water: on — tap water to identify" : "Water: off";
    fishBtn.classList.toggle("off", !fishingOn);
  }
  const wildBtn = document.getElementById("wildfood-toggle");
  if (wildBtn) {
    wildBtn.title = wildfoodOn ? "Wild food: on — tap land to identify" : "Wild food: off";
    wildBtn.classList.toggle("off", !wildfoodOn);
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
  document.querySelectorAll<HTMLElement>(".legend-row.fishing").forEach((el) => {
    el.classList.toggle("hidden", !fishingOn);
  });
  document.querySelectorAll<HTMLElement>(".legend-row.wildfood").forEach((el) => {
    el.classList.toggle("hidden", !wildfoodOn);
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

// Two rest positions: the menu is either up or minimized to its grip. A middle
// "half" stop was dropped when the sheet was made to fit its content — a
// content-height sheet and a half-stop body cap fight each other, and with the
// legend moved off the menu the whole thing fits on screen at once anyway.
type SheetState = "sheet-peek" | "sheet-full";
const SHEET_STATES: SheetState[] = ["sheet-peek", "sheet-full"];

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
 * Drop the bottom sheet out of the way, so a place the app just moved to is
 * actually visible instead of hidden behind the menu.
 *
 * Phone only — on desktop the menu is a side panel and doesn't cover the map.
 * Deliberately NOT persisted: this is a temporary get-out-of-the-way for a
 * search jump, not the user choosing peek as their resting position, so a
 * reload still restores the height they last set.
 */
function peekSheet() {
  const hud = document.getElementById("hud");
  if (!hud || !isPhone()) return;
  hud.classList.remove(...SHEET_STATES);
  hud.classList.add("sheet-peek");
  hud.style.transform = "";
}

/**
 * Drag-to-move for the phone bottom sheet.
 *
 * Driven by a transform, not by height. Animating height relaid out the whole
 * menu on every frame of a drag, which is what made it feel rough; a transform
 * is composited and never touches layout.
 *
 * Two rest positions: open (fits the content, which scrolls if it's taller than
 * the screen) or minimized to the grip strip. A drag or flick moves between
 * them; a flick carries one stop the way it was thrown.
 */
function setupSheet(hud: HTMLElement) {
  const grip = document.getElementById("hud-grip");
  const bar = document.getElementById("hud-bar");
  if (!grip || !bar) return;

  const stored = localStorage.getItem("griddown_sheet") as SheetState | null;
  // Anything that isn't one of the two current states (including a "sheet-half"
  // saved by an older build) falls back to the menu being up.
  const initial: SheetState = stored && SHEET_STATES.includes(stored) ? stored : "sheet-full";
  hud.classList.add(initial);

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
  /** Rest positions in order, shallowest first. Index arithmetic below. */
  const STOPS: SheetState[] = ["sheet-full", "sheet-peek"];
  /** Which stop the drag began at, so a flick moves exactly one from there. */
  let startStop = 0;
  /** Last sample, for velocity. */
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;

  /**
   * A flick is a deliberate throw rather than a slow drag, in px/ms.
   *
   * Below this the sheet settles wherever it was let go, which is what you want
   * when placing it carefully. Above it, the gesture means "next stop, that
   * way" — and it has to, because a fast flick barely moves the sheet before
   * the finger lifts, so position alone would leave it where it started.
   */
  const FLICK = 0.45;

  /** Which stop a given shift is nearest, by how much of the sheet shows. */
  // Index into STOPS. As a fraction of the sheet's own height, so it's right
  // whatever the content height is: below half shown → minimize, else open.
  const stopAt = (shift: number) => {
    const shown = (hud.offsetHeight - shift) / Math.max(1, hud.offsetHeight);
    return shown < 0.5 ? 1 : 0; // 1 = peek, 0 = full
  };

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
    startStop = stopAt(startShift);
    lastY = e.clientY;
    lastT = e.timeStamp;
    velocity = 0;
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

    // Sampled per move rather than averaged over the whole gesture: a drag that
    // pauses and then flicks should be read as a flick, not as its slow mean.
    const dt = e.timeStamp - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = e.timeStamp;
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== activeId) return;
    activeId = null;

    if (!moved) {
      hud.classList.remove("dragging");
      // A tap, not a drag. Leave the resting position alone.
      hud.style.transform = "";
      return;
    }

    // A throw goes one stop the way it was thrown; anything slower settles
    // where it was let go. Thresholds rather than the peek height, because the
    // peek is defined in CSS with a safe-area inset in it and re-deriving that
    // here is how the two drift apart.
    const target =
      Math.abs(velocity) > FLICK
        ? Math.max(0, Math.min(STOPS.length - 1, startStop + (velocity > 0 ? 1 : -1)))
        : stopAt(currentShift());
    settle(STOPS[target]);
  };

  /**
   * Animate to a rest position over a time that suits the distance.
   *
   * A fixed duration has to be a compromise, and reads as both: sluggish
   * nudging the sheet a few pixels, abrupt throwing it the height of the
   * screen. The end position is measured rather than computed — the stops are
   * defined in CSS, in dvh and safe-area insets, and duplicating that
   * arithmetic here is how the two quietly stop agreeing.
   */
  function settle(state: SheetState) {
    const from = currentShift();
    // Read the target with the transition still suppressed, then put the sheet
    // back where it was before letting it animate. One forced layout, once, on
    // release.
    setSheet(hud, state); // also clears the transform the drag left behind
    const to = currentShift();
    hud.style.transform = `translateY(${from}px)`;
    void hud.offsetHeight; // flush, so the line below animates from `from`

    const ms = Math.max(180, Math.min(420, 180 + Math.abs(to - from) * 0.55));
    hud.style.transitionDuration = `${Math.round(ms)}ms`;
    hud.classList.remove("dragging");
    hud.style.transform = "";
    window.setTimeout(() => {
      hud.style.transitionDuration = "";
    }, ms + 60);
  }

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

  // Legend card on the map: collapse it to a title bar and back, remembered.
  const legend = document.getElementById("map-legend");
  const legendToggle = document.getElementById("legend-toggle");
  if (legend && legendToggle) {
    if (localStorage.getItem("griddown_legend") === "0") legend.classList.add("collapsed");
    const syncCaret = () =>
      legendToggle.setAttribute("aria-expanded", String(!legend.classList.contains("collapsed")));
    syncCaret();
    legendToggle.addEventListener("click", () => {
      const collapsed = legend.classList.toggle("collapsed");
      localStorage.setItem("griddown_legend", collapsed ? "0" : "1");
      syncCaret();
    });
  }

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
      (nvBtn.querySelector(".hud-icon-glyph") ?? nvBtn).textContent = on ? "◉" : "◑";
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
