import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import { demTiles, demContourUrl, setDemRoot, sampleElevationM } from "./dem";
import { initStateLibrary, type SwitchTarget } from "./states";
import { initHandbook } from "./handbook";
import { initSky } from "./sky";
import { initWaypoints } from "./waypoints";
import { initMeasure } from "./measure";
import { initGoto, dropGotoPin } from "./goto";
import { initSearch } from "./search";
import { initPanels } from "./panels";
import { initReadiness } from "./readiness";
import { initPrint } from "./print";
import { initCompass } from "./compass";
import { initViewshed } from "./viewshed";
import { forward as mgrsForward } from "mgrs";

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
async function loadRegion(): Promise<Region> {
  try {
    const r = await fetch(`${origin}/region.json`, { cache: "no-store" });
    if (r.ok) return (await r.json()) as Region;
  } catch {
    /* fall through to generic default */
  }
  return { name: "GridDown", pmtiles: "region.pmtiles", center: [-98.58, 39.83], zoom: 4 };
}

// Assigned once the region config is loaded (see start() at the bottom).
let PMTILES_URL = "";

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

let activeResources = new Set<string>(
  JSON.parse(localStorage.getItem("griddown_resources") || "[]")
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

async function start() {
  const region = await loadRegion();
  PMTILES_URL = `pmtiles://${origin}/mapdata/${region.pmtiles}`;

  const stateEl = document.getElementById("hud-state");
  if (stateEl) stateEl.textContent = region.name;

  map = new maplibregl.Map({
    container: "map",
    center: region.center,
    zoom: region.zoom,
    hash: false,
    attributionControl: { compact: true },
    style: buildStyle(currentTheme),
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  map.on("error", (e) => {
    console.error("[map error]", e && (e as any).error ? (e as any).error : e);
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

  // Switch the active map source (called when a downloaded state is selected).
  function switchToSource(t: SwitchTarget) {
    // Drop the protocol's cached instance for this file — after a pack refresh
    // the bytes on disk changed but the URL didn't, and a stale cached header/
    // directory would point at the wrong tile offsets.
    protocol.tiles.delete(t.pmtilesUrl.replace(/^pmtiles:\/\//, ""));
    PMTILES_URL = t.pmtilesUrl;
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
  }
  // Resource overlay chips (water / shelter / medical / supply / help)
  function applyResourceUi() {
    document.querySelectorAll<HTMLElement>(".res-chip").forEach((chip) => {
      chip.classList.toggle("on", activeResources.has(chip.dataset.res || ""));
    });
  }
  document.querySelectorAll<HTMLElement>(".res-chip").forEach((chip) => {
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
  async function updateElevation() {
    const ft = await centerElevationFt();
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
  initGoto(map);
  // Read through a getter: terrain availability changes when you switch states.
  initReadiness(() => terrainAvailable);
  initCompass();
  initViewshed(() => map);
  initSearch({
    map: () => map,
    sourceUrl: () => PMTILES_URL.replace(/^pmtiles:\/\//, ""),
    dropPin: (lng, lat) => dropGotoPin(map, lng, lat),
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
  if (themeBtn) themeBtn.textContent = currentTheme === "dark" ? "☀ Day" : "☾ Night";
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

// --- Welcome screen (first run) + Map library panel open/close ---
function initChrome() {
  // Menu collapse toggle (☰) — hides everything but the bar; choice persists.
  const hud = document.getElementById("hud");
  if (hud && localStorage.getItem("griddown_menu_collapsed") === "1") {
    hud.classList.add("collapsed");
  }
  document.getElementById("hud-toggle")?.addEventListener("click", () => {
    const collapsed = hud?.classList.toggle("collapsed");
    localStorage.setItem("griddown_menu_collapsed", collapsed ? "1" : "0");
  });

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
    if (nvBtn) nvBtn.textContent = on ? "◉ Night vis" : "◑ Night vis";
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
