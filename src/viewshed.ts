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

export const RADIUS_CHOICES = [8000, 25000, 50000];
const RADIUS_KEY = "griddown_viewshed_radius";

export function viewshedRadiusM(): number {
  const saved = Number(localStorage.getItem(RADIUS_KEY));
  return RADIUS_CHOICES.includes(saved) ? saved : 25000;
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
  const dem = await loadElevationGrid({ west, south, east, north });
  const obs = dem.sample(c.lng, c.lat);
  if (obs == null) {
    toast("No elevation data here — viewshed needs terrain.", "error");
    return { ok: false, radiusM, noData: 0, total: 0, tilesMissing: dem.tilesMissing };
  }

  const grid = new Float64Array(RAYS * steps).fill(NaN);
  const coords: [number, number][] = new Array(RAYS * steps);
  let noData = 0;
  for (let r = 0; r < RAYS; r++) {
    const bearing = (r / RAYS) * 2 * Math.PI;
    for (let s = 1; s <= steps; s++) {
      const [lng, lat] = destination(c.lng, c.lat, bearing, s * STEP_M);
      const i = r * steps + (s - 1);
      coords[i] = [lng, lat];
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
  ctx.fillStyle = "rgba(80, 220, 120, 0.4)";
  for (let r = 0; r < RAYS; r++) {
    for (let s = 0; s < steps; s++) {
      if (!result.visible[r * steps + s]) continue;
      const [lng, lat] = coords[r * steps + s];
      const x = ((lng - west) / (east - west)) * SIZE;
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

  const coordsBox: [[number, number], [number, number], [number, number], [number, number]] = [
    [west, north],
    [east, north],
    [east, south],
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
    radiusSel.value = String(viewshedRadiusM());
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
    const km = Math.round(viewshedRadiusM() / 1000);
    toast(`Computing viewshed from the crosshair (${km} km)…`);
    btn.setAttribute("disabled", "");
    try {
      const res = await compute(map);
      shown = res.ok;
      btn.classList.toggle("off", !shown);
      if (!shown) return;
      // No-data reads as "not visible" on the map, so name it rather than let
      // a gap in the terrain masquerade as a blocked sightline.
      const gaps = res.total ? Math.round((res.noData / res.total) * 100) : 0;
      if (gaps >= 5) {
        toast(
          `Green = visible (${km} km). ${gaps}% of the sweep has no terrain data — those areas are unshaded, not blocked.`,
          "info"
        );
      } else {
        toast(`Green = visible from here (${km} km sweep).`, "success");
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
