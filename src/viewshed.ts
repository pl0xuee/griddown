import maplibregl from "maplibre-gl";
import { sweepViewshed, R_EARTH } from "./sweep";
import { sampleElevationM } from "./dem";
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
const STEPS = 160;
const RADIUS_M = 8000;
const STEP_M = RADIUS_M / STEPS;

const SRC = "gd-viewshed";

async function compute(map: maplibregl.Map): Promise<boolean> {
  const c = map.getCenter();
  const obs = await sampleElevationM(c.lng, c.lat);
  if (obs == null) {
    toast("No elevation data here — viewshed needs terrain.", "error");
    return false;
  }

  // Pre-sample every ray point (async), then run the pure sweep on the grid.
  const grid = new Float64Array(RAYS * STEPS).fill(NaN);
  const coords: [number, number][] = new Array(RAYS * STEPS);
  const jobs: Promise<void>[] = [];
  for (let r = 0; r < RAYS; r++) {
    const bearing = (r / RAYS) * 2 * Math.PI;
    for (let s = 1; s <= STEPS; s++) {
      const [lng, lat] = destination(c.lng, c.lat, bearing, s * STEP_M);
      const i = r * STEPS + (s - 1);
      coords[i] = [lng, lat];
      jobs.push(
        sampleElevationM(lng, lat).then((e) => {
          if (e != null) grid[i] = e;
        })
      );
    }
  }
  await Promise.all(jobs);

  const result = sweepViewshed(
    obs,
    (dist, ray) => {
      const s = Math.round(dist / STEP_M) - 1;
      const v = grid[ray * STEPS + s];
      return Number.isNaN(v) ? null : v;
    },
    { rays: RAYS, steps: STEPS, stepM: STEP_M }
  );

  // Paint visible samples onto a canvas laid over the viewshed's bounding box.
  const SIZE = 512;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d")!;
  const west = destination(c.lng, c.lat, (3 * Math.PI) / 2, RADIUS_M)[0];
  const east = destination(c.lng, c.lat, Math.PI / 2, RADIUS_M)[0];
  const north = destination(c.lng, c.lat, 0, RADIUS_M)[1];
  const south = destination(c.lng, c.lat, Math.PI, RADIUS_M)[1];
  ctx.fillStyle = "rgba(80, 220, 120, 0.4)";
  for (let r = 0; r < RAYS; r++) {
    for (let s = 0; s < STEPS; s++) {
      if (!result.visible[r * STEPS + s]) continue;
      const [lng, lat] = coords[r * STEPS + s];
      const x = ((lng - west) / (east - west)) * SIZE;
      const y = ((north - lat) / (north - south)) * SIZE;
      // Dot size grows with distance so the ray fan stays gap-free.
      const px = 1.6 + (s / STEPS) * 2.6;
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
  return true;
}

export function initViewshed(getMap: () => maplibregl.Map) {
  let shown = false;
  const btn = document.getElementById("viewshed-toggle");

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
    toast("Computing viewshed from the crosshair…");
    btn.setAttribute("disabled", "");
    try {
      shown = await compute(map);
      btn.classList.toggle("off", !shown);
      if (shown) toast("Green = visible from here (8 km sweep).", "success");
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
