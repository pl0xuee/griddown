import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import mlcontour from "maplibre-contour";
import { initStateLibrary, type SwitchTarget } from "./states";
import { initHandbook } from "./handbook";
import { initSky } from "./sky";
import { initWaypoints } from "./waypoints";
import { forward as mgrsForward } from "mgrs";

// --- Register the pmtiles:// protocol so MapLibre can read a local .pmtiles file ---
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// All assets are served locally from /public — nothing here touches the internet.
const origin = window.location.origin;
const DEM_TILES = `${origin}/dem/{z}/{x}/{y}.png`;

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

// Local elevation (DEM) source drives both hillshade and on-the-fly contours,
// all read from the static tile pyramid under /public/dem (fully offline).
const demSource = new mlcontour.DemSource({
  url: DEM_TILES,
  encoding: "terrarium",
  maxzoom: 12,
  worker: false,
});
demSource.setupMaplibre(maplibregl);

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
// Terrain (hillshade/contours) only exists for regions with a local DEM.
let terrainAvailable = true;
let map: maplibregl.Map;

function buildStyle(themeName: ThemeName): maplibregl.StyleSpecification {
  const t = THEME[themeName];
  const base = layers("protomaps", namedFlavor(t.flavor), { lang: "en" }) as any[];

  const sources: any = {
    protomaps: {
      type: "vector",
      url: PMTILES_URL,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
    },
  };

  if (terrainOn && terrainAvailable) {
    sources.dem = {
      type: "raster-dem",
      tiles: [DEM_TILES],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 12,
      attribution:
        'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank">Terrain Tiles / USGS</a>',
    };
    sources.contours = {
      type: "vector",
      tiles: [
        demSource.contourProtocolUrl({
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

  const contourLabels: any[] = terrainOn && terrainAvailable
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

  return {
    version: 8,
    glyphs: `${origin}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/sprites/${t.sprite}`,
    sources,
    layers: [...base, ...emphasisLayers(t), ...resourceLayers(t), ...contourLabels],
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
  applyThemeUi();

  // Switch the active map source (called when a downloaded state is selected).
  function switchToSource(t: SwitchTarget) {
    PMTILES_URL = t.pmtilesUrl;
    terrainAvailable = t.hasDem;
    const el = document.getElementById("hud-state");
    if (el) el.textContent = t.name;
    map.setStyle(buildStyle(currentTheme));
    map.jumpTo({ center: t.center, zoom: t.zoom });
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
    const z = 12;
    const n = 2 ** z;
    const xf = ((c.lng + 180) / 360) * n;
    const latR = (c.lat * Math.PI) / 180;
    const yf = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
    const x = Math.floor(xf);
    const y = Math.floor(yf);
    try {
      const tile = await demSource.getDemTile(z, x, y);
      const w = tile.width;
      const px = Math.min(w - 1, Math.max(0, Math.floor((xf - x) * w)));
      const py = Math.min(w - 1, Math.max(0, Math.floor((yf - y) * w)));
      const m = tile.data[py * w + px];
      return m == null || isNaN(m) ? null : m * 3.28084;
    } catch {
      return null;
    }
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

  initWaypoints(map);

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
    terrBtn.textContent = terrainOn ? "△ Terrain: on" : "△ Terrain: off";
    terrBtn.classList.toggle("off", !terrainOn);
    terrBtn.classList.toggle("hidden", !terrainAvailable);
  }
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
    if (nvBtn) nvBtn.textContent = on ? "◉ Night vision: on" : "◑ Night vision: off";
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
