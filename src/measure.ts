import maplibregl from "maplibre-gl";
import { toast } from "./toast";

// Measure tool: tap the map to lay down points, get running distance along the
// path, the bearing of the last leg, and — with 3+ points — the enclosed area.
// Pure offline math (haversine + geodesic bearing + spherical polygon area).

type LL = [number, number]; // lng, lat

const R = 6378137; // Earth radius (m), WGS84

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

function haversine(a: LL, b: LL): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Initial (forward) bearing from a to b, degrees 0–360 clockwise from north.
function bearing(a: LL, b: LL): number {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const DIRS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];
const cardinal = (deg: number) => DIRS[Math.round(deg / 22.5) % 16];

// Geodesic area of a closed ring (m²), signed magnitude taken absolute.
function ringArea(pts: LL[]): number {
  const n = pts.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [lng1, lat1] = pts[i];
    const [lng2, lat2] = pts[(i + 1) % n];
    total += toRad(lng2 - lng1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((total * R * R) / 2);
}

function fmtDist(m: number): { imp: string; met: string } {
  const ft = m * 3.28084;
  const mi = m / 1609.344;
  const km = m / 1000;
  const imp = ft < 1000 ? `${Math.round(ft).toLocaleString()} ft` : `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  const met = km < 1 ? `${Math.round(m).toLocaleString()} m` : `${km.toFixed(km < 10 ? 2 : 1)} km`;
  return { imp, met };
}

function fmtArea(m2: number): { imp: string; met: string } {
  const acres = m2 / 4046.8564224;
  const sqmi = m2 / 2589988.110336;
  const km2 = m2 / 1e6;
  const imp =
    acres < 640
      ? `${acres < 10 ? acres.toFixed(2) : Math.round(acres).toLocaleString()} acres`
      : `${sqmi.toFixed(sqmi < 10 ? 2 : 1)} sq mi`;
  const met =
    km2 < 1
      ? `${Math.round(m2).toLocaleString()} m²`
      : `${km2.toFixed(km2 < 10 ? 2 : 1)} km²`;
  return { imp, met };
}

export function initMeasure(map: maplibregl.Map) {
  let measuring = false;
  let pts: LL[] = [];

  const btn = document.getElementById("measure-open");
  const box = document.getElementById("measure-readout");
  const stats = document.getElementById("measure-stats");

  // --- Map layers (re-added on every new style) ---
  function geojson(): any {
    const features: any[] = [];
    if (pts.length >= 2) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: pts },
        properties: {},
      });
    }
    if (pts.length >= 3) {
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [[...pts, pts[0]]] },
        properties: {},
      });
    }
    pts.forEach((p, i) =>
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: p },
        properties: { i: i + 1 },
      })
    );
    return { type: "FeatureCollection", features };
  }

  function ensureLayers() {
    const src = map.getSource("gd-measure") as maplibregl.GeoJSONSource | undefined;
    if (!src) {
      map.addSource("gd-measure", { type: "geojson", data: geojson() });
      map.addLayer({
        id: "gd-measure-fill", type: "fill", source: "gd-measure",
        paint: { "fill-color": "#ffd54a", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "gd-measure-line", type: "line", source: "gd-measure",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffd54a", "line-width": 3, "line-opacity": 0.95 },
      });
      map.addLayer({
        id: "gd-measure-pts", type: "circle", source: "gd-measure",
        paint: {
          "circle-radius": 5,
          "circle-color": "#1a1200",
          "circle-stroke-color": "#ffd54a",
          "circle-stroke-width": 2,
        },
      });
    } else {
      src.setData(geojson());
    }
  }
  map.on("style.load", () => {
    if (measuring) ensureLayers();
  });

  // --- Readout ---
  function render() {
    if (!stats) return;
    if (pts.length < 2) {
      stats.innerHTML = `<div class="ms-hint">Tap the map to drop measuring points.</div>`;
      return;
    }
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += haversine(pts[i - 1], pts[i]);
    const d = fmtDist(total);
    const legLen = haversine(pts[pts.length - 2], pts[pts.length - 1]);
    const brg = bearing(pts[pts.length - 2], pts[pts.length - 1]);
    const leg = fmtDist(legLen);

    let html = `
      <div class="ms-main">
        <div class="ms-big">${d.imp}</div>
        <div class="ms-sub">${d.met} · ${pts.length} pts</div>
      </div>
      <div class="ms-row"><span class="ms-k">Last leg</span><span class="ms-v">${leg.imp} · ${Math.round(brg)}° ${cardinal(brg)}</span></div>`;

    if (pts.length >= 3) {
      const a = fmtArea(ringArea(pts));
      html += `<div class="ms-row"><span class="ms-k">Area</span><span class="ms-v">${a.imp} · ${a.met}</span></div>`;
    }
    stats.innerHTML = html;
  }

  function update() {
    if (measuring) ensureLayers();
    render();
  }

  // --- Mode control ---
  function onClick(e: maplibregl.MapMouseEvent) {
    pts.push([+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)]);
    update();
  }

  function enter() {
    measuring = true;
    pts = [];
    map.getCanvas().style.cursor = "crosshair";
    map.doubleClickZoom.disable();
    map.on("click", onClick);
    ensureLayers();
    render();
    box?.classList.remove("hidden");
    btn?.classList.add("on");
    toast("Measure: tap points on the map.", "info");
  }

  function clearLayers() {
    for (const id of ["gd-measure-fill", "gd-measure-line", "gd-measure-pts"]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource("gd-measure")) map.removeSource("gd-measure");
  }

  function exit() {
    measuring = false;
    pts = [];
    map.off("click", onClick);
    map.getCanvas().style.cursor = "";
    map.doubleClickZoom.enable();
    clearLayers();
    box?.classList.add("hidden");
    btn?.classList.remove("on");
  }

  function undo() {
    pts.pop();
    update();
  }
  function clearPts() {
    pts = [];
    update();
  }

  btn?.addEventListener("click", () => (measuring ? exit() : enter()));
  document.getElementById("measure-undo")?.addEventListener("click", undo);
  document.getElementById("measure-clear")?.addEventListener("click", clearPts);
  document.getElementById("measure-done")?.addEventListener("click", exit);
}
