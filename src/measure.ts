import maplibregl from "maplibre-gl";
import { toast } from "./toast";
import { assessGaps, fillGaps } from "./profile";
import { sampleElevationM } from "./dem";
import { haversine, bearing, cardinal, toRad, EARTH_R as R, type LL } from "./geo";

// Measure tool: tap the map to lay down points, get running distance along the
// path, the bearing of the last leg, and — with 3+ points — the enclosed area.
// Pure offline math (haversine + geodesic bearing + spherical polygon area).

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
  const profileView = document.getElementById("measure-profile-view");

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
    // Any change to the points makes a shown profile stale — collapse it.
    if (profileView && !profileView.classList.contains("hidden")) {
      profileView.classList.add("hidden");
      profileView.innerHTML = "";
    }
  }

  // --- Elevation profile along the path (samples the local DEM) ---
  // Interpolate evenly-spaced points along the multi-segment path.
  function sampleAlong(path: LL[], n: number): { d: number; lng: number; lat: number }[] {
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversine(path[i - 1], path[i]));
    const total = cum[cum.length - 1];
    const out: { d: number; lng: number; lat: number }[] = [];
    let seg = 1;
    for (let k = 0; k < n; k++) {
      const d = (total * k) / (n - 1);
      while (seg < path.length - 1 && cum[seg] < d) seg++;
      const a = path[seg - 1];
      const b = path[seg];
      const segLen = cum[seg] - cum[seg - 1] || 1;
      const f = Math.min(1, Math.max(0, (d - cum[seg - 1]) / segLen));
      out.push({ d, lng: a[0] + (b[0] - a[0]) * f, lat: a[1] + (b[1] - a[1]) * f });
    }
    return out;
  }

  function profileSVG(dist: number[], elev: number[], sight?: number[]): string {
    const W = 296, H = 104, pad = { l: 4, r: 4, t: 8, b: 4 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;
    const dMax = dist[dist.length - 1] || 1;
    let lo = Math.min(...elev), hi = Math.max(...elev);
    if (sight) { lo = Math.min(lo, ...sight); hi = Math.max(hi, ...sight); }
    if (hi - lo < 1) hi = lo + 1;
    const px = (d: number) => pad.l + (d / dMax) * pw;
    const py = (e: number) => pad.t + (1 - (e - lo) / (hi - lo)) * ph;
    const line = elev.map((e, i) => `${i ? "L" : "M"}${px(dist[i]).toFixed(1)} ${py(e).toFixed(1)}`).join(" ");
    const area = `${line} L${px(dMax).toFixed(1)} ${(H - pad.b).toFixed(1)} L${pad.l} ${(H - pad.b).toFixed(1)} Z`;
    const sightPath = sight
      ? `<path d="M${px(dist[0]).toFixed(1)} ${py(sight[0]).toFixed(1)} L${px(dMax).toFixed(1)} ${py(sight[sight.length - 1]).toFixed(1)}" fill="none" stroke="#7fd6ff" stroke-width="1.2" stroke-dasharray="4 3"/>`
      : "";
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img">
      <path d="${area}" fill="rgba(255,213,74,0.16)"/>
      <path d="${line}" fill="none" stroke="#ffd54a" stroke-width="1.5"/>
      ${sightPath}
    </svg>`;
  }

  // Line-of-sight between the two endpoints over the terrain, with an
  // eye/target height and Earth-curvature correction. Optical (no refraction).
  const EYE_M = 1.7; // observer eye height
  const TGT_M = 1.7; // target height
  const EARTH_M = 6371000;
  function lineOfSight(
    samples: { d: number }[],
    elevM: number[]
  ): { visible: boolean; blockAtMi: number | null } {
    const D = samples[samples.length - 1].d;
    const Ho = elevM[0] + EYE_M;
    const Ht = elevM[elevM.length - 1] + TGT_M;
    let blockAt: number | null = null;
    for (let i = 1; i < elevM.length - 1; i++) {
      const di = samples[i].d;
      const los = Ho + (Ht - Ho) * (di / D);
      const bulge = (di * (D - di)) / (2 * EARTH_M); // earth curvature
      if (los - (elevM[i] + bulge) < 0 && blockAt == null) blockAt = di;
    }
    return { visible: blockAt == null, blockAtMi: blockAt == null ? null : blockAt / 1609.344 };
  }

  async function showProfile() {
    if (!profileView) return;
    if (pts.length < 2) {
      toast("Add at least two points to profile.", "info");
      return;
    }
    if (!profileView.classList.contains("hidden")) {
      profileView.classList.add("hidden");
      profileView.innerHTML = "";
      return;
    }
    profileView.classList.remove("hidden");
    profileView.innerHTML = `<div class="ms-hint">Reading elevation…</div>`;

    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1];
    const N = Math.min(256, Math.max(2, Math.round(total / 20)));
    const samples = sampleAlong(pts, N);
    const rawM = await Promise.all(samples.map((s) => sampleElevationM(s.lng, s.lat)));
    const known = rawM.filter((m) => m != null).length;
    if (known < 2) {
      profileView.innerHTML = `<div class="ms-hint">No elevation data for this area. Terrain is only bundled for the default region.</div>`;
      return;
    }

    // Interpolating across a long gap invents terrain that was never measured.
    // A short dropout (isolated DEM noise) is fine to bridge silently; anything
    // larger gets disclosed, and the line-of-sight verdict is withheld rather
    // than computed from invented ground. Without this, 2 real samples out of
    // 256 still produced a confident profile and a precise "Blocked at 0.59 mi".
    const { missingPct, trustworthy } = assessGaps(rawM);

    const elevM = fillGaps(rawM) as number[];
    const elevFt = elevM.map((m) => m * 3.28084);
    const distMi = samples.map((s) => s.d / 1609.344);

    // Total climb / descent with a small threshold to suppress DEM noise.
    const THRESH_FT = 12;
    let gain = 0, loss = 0, ref = elevFt[0];
    for (const e of elevFt) {
      const dd = e - ref;
      if (Math.abs(dd) >= THRESH_FT) {
        if (dd > 0) gain += dd;
        else loss += -dd;
        ref = e;
      }
    }
    const lo = Math.round(Math.min(...elevFt));
    const hi = Math.round(Math.max(...elevFt));

    // Line of sight only makes sense for a straight two-point shot.
    let sightFt: number[] | undefined;
    let losRow = "";
    if (pts.length === 2) {
      const eyeFt = EYE_M * 3.28084;
      const tgtFt = TGT_M * 3.28084;
      const startFt = elevFt[0] + eyeFt;
      const endFt = elevFt[elevFt.length - 1] + tgtFt;
      sightFt = distMi.map((_, i) => startFt + (endFt - startFt) * (i / (distMi.length - 1)));
      if (!trustworthy) {
        // "Visible" and "Blocked at 0.59 mi" both read as measurements. Neither
        // is one when the ground under the line was interpolated, so say so.
        losRow = `<div class="ms-prow ms-los ms-los-unknown"><span>◉ Line of sight</span><span>Can't tell — terrain data missing</span></div>`;
      } else {
        const los = lineOfSight(samples, elevM);
        losRow = los.visible
          ? `<div class="ms-prow ms-los ms-los-ok"><span>◉ Line of sight</span><span>Visible ✓</span></div>`
          : `<div class="ms-prow ms-los ms-los-block"><span>◉ Line of sight</span><span>Blocked at ${los.blockAtMi!.toFixed(los.blockAtMi! < 10 ? 2 : 1)} mi ✗</span></div>`;
      }
    }

    profileView.innerHTML = `
      ${profileSVG(distMi, elevFt, sightFt)}
      <div class="ms-prow">
        <span>↑ <b>${Math.round(gain).toLocaleString()} ft</b> gain</span>
        <span>↓ <b>${Math.round(loss).toLocaleString()} ft</b> loss</span>
      </div>
      <div class="ms-prow ms-psub">
        <span>${lo.toLocaleString()}–${hi.toLocaleString()} ft</span>
        <span>${(total / 1609.344).toFixed(total / 1609.344 < 10 ? 2 : 1)} mi</span>
      </div>
      ${
        trustworthy
          ? ""
          : `<div class="ms-prow ms-gap"><span>⚠ ${missingPct}% of this path has no terrain data — the profile is drawn across the gaps, not measured.</span></div>`
      }
      ${losRow}`;
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
    if (profileView) {
      profileView.classList.add("hidden");
      profileView.innerHTML = "";
    }
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
  document.getElementById("measure-profile")?.addEventListener("click", () => void showProfile());
  document.getElementById("measure-undo")?.addEventListener("click", undo);
  document.getElementById("measure-clear")?.addEventListener("click", clearPts);
  document.getElementById("measure-done")?.addEventListener("click", exit);
}
