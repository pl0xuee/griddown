import maplibregl from "maplibre-gl";
import { sweepViewshed, R_EARTH } from "./sweep";
import { loadElevationGrid } from "./dem";
import { toast } from "./toast";

// 360° viewshed: everything you can see from where the crosshair is.
// Radial DEM sampling with earth-curvature correction — the same physics as
// the two-point line-of-sight in the measure tool, swept around the horizon.
// Pure offline math; needs elevation data (bundled region or downloaded
// state terrain).

/** Destination point given start, bearing (rad) and distance (m). */
function destination(lng: number, lat: number, bearingRad: number, distM: number): [number, number] {
  const δ = distM / R_EARTH;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lng * Math.PI) / 180;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(bearingRad)
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
  return [((λ2 * 180) / Math.PI + 540) % 360 - 180, (φ2 * 180) / Math.PI];
}

const RAYS = 360;
// Sample spacing along a ray. z12 terrarium is ~27 m/px at these latitudes, so
// finer steps cost time without resolving more terrain.
const STEP_M = 50;

// Round MILES, not round kilometres — this is a US map and the rest of the app
// reads in feet and miles.
const MI = 1609.344;
/** Stored and compared in whole MILES — exact integers, no float-equality trap. */
export const RADIUS_CHOICES_MI = [5, 15, 30];
const RADIUS_KEY = "griddown_viewshed_radius_mi";

export function viewshedRadiusMi(): number {
  const saved = Number(localStorage.getItem(RADIUS_KEY));
  return RADIUS_CHOICES_MI.includes(saved) ? saved : 15;
}
export function viewshedRadiusM(): number {
  return viewshedRadiusMi() * MI;
}

const SRC = "gd-viewshed";

interface ComputeResult {
  ok: boolean;
  radiusM: number;
  /** Samples with no terrain data — rendered unlit, so worth saying out loud. */
  noData: number;
  total: number;
  tilesMissing: number;
}

async function compute(map: maplibregl.Map): Promise<ComputeResult> {
  const c = map.getCenter();
  const radiusM = viewshedRadiusM();
  const steps = Math.round(radiusM / STEP_M);

  const west = destination(c.lng, c.lat, (3 * Math.PI) / 2, radiusM)[0];
  const east = destination(c.lng, c.lat, Math.PI / 2, radiusM)[0];
  const north = destination(c.lng, c.lat, 0, radiusM)[1];
  const south = destination(c.lng, c.lat, Math.PI, radiusM)[1];

  // One fetch per DEM tile over the whole sweep, then sample synchronously.
  let dem;
  try {
    dem = await loadElevationGrid({ west, south, east, north });
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
    return { ok: false, radiusM, noData: 0, total: 0, tilesMissing: 0 };
  }
  const obs = dem.sample(c.lng, c.lat);
  if (obs == null) {
    // Distinguish "this pack has no terrain" from "the terrain failed to load".
    // Telling someone to download terrain they already have is a dead end.
    toast(
      dem.tilesMissing > 0 && dem.tilesLoaded === 0
        ? `Couldn't load terrain here — all ${dem.tilesMissing} elevation tiles failed. Try again, or a smaller range.`
        : "No elevation data here — viewshed needs terrain.",
      "error"
    );
    return { ok: false, radiusM, noData: 0, total: 0, tilesMissing: dem.tilesMissing };
  }

  const grid = new Float64Array(RAYS * steps).fill(NaN);
  // Flat typed arrays, not an array of [lng,lat] pairs: at 30 mi that would be
  // 360,000 two-element JS arrays (tens of MB of object overhead) on a webview
  // already documented as fragile under memory pressure.
  const lngs = new Float64Array(RAYS * steps);
  const lats = new Float64Array(RAYS * steps);
  let noData = 0;
  for (let r = 0; r < RAYS; r++) {
    const bearing = (r / RAYS) * 2 * Math.PI;
    for (let s = 1; s <= steps; s++) {
      const [lng, lat] = destination(c.lng, c.lat, bearing, s * STEP_M);
      const i = r * steps + (s - 1);
      lngs[i] = lng;
      lats[i] = lat;
      const e = dem.sample(lng, lat);
      if (e == null) noData++;
      else grid[i] = e;
    }
  }

  const result = sweepViewshed(
    obs,
    (dist, ray) => {
      const s = Math.round(dist / STEP_M) - 1;
      const v = grid[ray * steps + s];
      return Number.isNaN(v) ? null : v;
    },
    { rays: RAYS, steps, stepM: STEP_M }
  );

  // Paint visible samples onto a canvas laid over the viewshed's bounding box.
  const SIZE = radiusM > 10000 ? 1024 : 512;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  // Degrees east of the west edge, wrapping the antimeridian. A raw
  // `lng - west` goes negative for a bbox straddling ±180 (the Aleutians),
  // putting every dot off-canvas.
  const lngSpan = ((east - west) % 360 + 360) % 360 || 360;
  const eastOf = (lng: number) => (((lng - west) % 360) + 360) % 360;
  ctx.fillStyle = "rgba(80, 220, 120, 0.4)";
  for (let r = 0; r < RAYS; r++) {
    for (let s = 0; s < steps; s++) {
      const i = r * steps + s;
      if (!result.visible[i]) continue;
      const lng = lngs[i];
      const lat = lats[i];
      const x = (eastOf(lng) / lngSpan) * SIZE;
      const y = ((north - lat) / (north - south)) * SIZE;
      // Dot size grows with distance so the ray fan stays gap-free.
      const px = (1.6 + (s / steps) * 2.6) * (SIZE / 512);
      ctx.fillRect(x - px / 2, y - px / 2, px, px);
    }
  }
  // Observer dot.
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, 4, 0, 2 * Math.PI);
  ctx.fill();

  // Use an unwrapped east edge (may exceed 180) so the quad stays non-degenerate
  // across the antimeridian; MapLibre accepts continuous longitudes here.
  const eastBox = west + lngSpan;
  const coordsBox: [[number, number], [number, number], [number, number], [number, number]] = [
    [west, north],
    [eastBox, north],
    [eastBox, south],
    [west, south],
  ];
  const existing = map.getSource(SRC) as maplibregl.ImageSource | undefined;
  const url = canvas.toDataURL("image/png");
  if (existing) {
    existing.updateImage({ url, coordinates: coordsBox });
  } else {
    map.addSource(SRC, { type: "image", url, coordinates: coordsBox });
    // Under the labels — the tint should never drown a town name.
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    map.addLayer(
      {
        id: SRC,
        type: "raster",
        source: SRC,
        paint: { "raster-opacity": 0.85, "raster-fade-duration": 0 },
      },
      firstSymbol
    );
  }
  return { ok: true, radiusM, noData, total: RAYS * steps, tilesMissing: dem.tilesMissing };
}

export function initViewshed(getMap: () => maplibregl.Map) {
  let shown = false;
  const btn = document.getElementById("viewshed-toggle");
  const radiusSel = document.getElementById("viewshed-radius") as HTMLSelectElement | null;
  if (radiusSel) {
    radiusSel.value = String(viewshedRadiusMi());
    radiusSel.addEventListener("change", () => {
      localStorage.setItem(RADIUS_KEY, radiusSel.value);
      // The drawn sweep is for the old radius; make the user re-run it.
      const map = getMap();
      if (map.getLayer(SRC)) map.removeLayer(SRC);
      if (map.getSource(SRC)) map.removeSource(SRC);
      shown = false;
      btn?.classList.add("off");
    });
  }

  function clear(map: maplibregl.Map) {
    if (map.getLayer(SRC)) map.removeLayer(SRC);
    if (map.getSource(SRC)) map.removeSource(SRC);
  }

  btn?.addEventListener("click", async () => {
    const map = getMap();
    if (shown) {
      clear(map);
      shown = false;
      btn.classList.add("off");
      return;
    }
    const mi = viewshedRadiusMi();
    toast(`Computing viewshed from the crosshair (${mi} mi)…`);
    btn.setAttribute("disabled", "");
    try {
      const res = await compute(map);
      shown = res.ok;
      btn.classList.toggle("off", !shown);
      if (!shown) return;
      // No-data reads as "not visible" on the map, so name it rather than let
      // a gap in the terrain masquerade as a blocked sightline.
      const gaps = res.total ? Math.round((res.noData / res.total) * 100) : 0;
      if (res.tilesMissing > 0) {
        toast(
          `${res.tilesMissing} elevation tile(s) failed to load — the unshaded areas may be data gaps, not blocked ground.`,
          "error",
          8000
        );
      } else if (gaps >= 5) {
        toast(
          `Green = visible (${mi} mi). ${gaps}% of the sweep has no terrain data — those areas are unshaded, not blocked.`,
          "info"
        );
      } else {
        toast(`Green = visible from here (${mi} mi sweep).`, "success");
      }
    } finally {
      btn.removeAttribute("disabled");
    }
  });

  // Style rebuilds (theme/terrain toggles) wipe custom sources — reflect that.
  getMap().on("style.load", () => {
    shown = false;
    btn?.classList.add("off");
  });
}
