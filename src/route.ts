import maplibregl from "maplibre-gl";
import { PMTiles } from "pmtiles";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import {
  buildRouteGraph,
  findRoute,
  isRoutable,
  zoomForTrip,
  type RoadSeg,
  type RouteResult,
} from "./routegraph";

// "How do I get there" overview: a road-following path from a start point to a
// destination, built entirely from the active map pack. Not turn-by-turn, not
// live — you get the shape of the journey, the distance, and which roads to
// follow, computed offline.
//
// The road data comes from rendering tiles, so it has no turn restrictions, no
// access tags (private drives, locked gates), no surface and no closures. The
// UI says so on every result; do not quietly upgrade the wording to sound like
// navigation.

const SRC = "gd-route";
const LINE = "gd-route-line";
const CASING = "gd-route-casing";

// z14 is the shallowest zoom carrying `oneway`; below it we'd be guessing at
// direction. Long trips fall back to coarser zooms and say so.
const ZOOMS = [14, 13, 12];
const MAX_TILES = 900;

interface Endpoint {
  lng: number;
  lat: number;
  label: string;
}

function tile2lng(x: number, z: number) {
  return (x / 2 ** z) * 360 - 180;
}
function tile2lat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
function lng2tile(lng: number, z: number) {
  return Math.floor(((lng + 180) / 360) * 2 ** z);
}
function lat2tile(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/** Tiles covering the corridor between two points, at the best zoom for the trip. */
function planTiles(a: Endpoint, b: Endpoint, directMeters: number) {
  // Pad the bounding box so the route can bow away from the straight line.
  const padLng = Math.max(0.02, Math.abs(a.lng - b.lng) * 0.35);
  const padLat = Math.max(0.02, Math.abs(a.lat - b.lat) * 0.35);
  const west = Math.min(a.lng, b.lng) - padLng;
  const east = Math.max(a.lng, b.lng) + padLng;
  const south = Math.min(a.lat, b.lat) - padLat;
  const north = Math.max(a.lat, b.lat) + padLat;

  // Distance picks the zoom; the tile budget can only push it coarser.
  const best = zoomForTrip(directMeters);
  for (const z of ZOOMS.filter((z) => z <= best)) {
    const x0 = lng2tile(west, z);
    const x1 = lng2tile(east, z);
    const y0 = lat2tile(north, z);
    const y1 = lat2tile(south, z);
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count <= MAX_TILES) return { z, x0, x1, y0, y1, count };
  }
  return null;
}

async function loadRoads(
  url: string,
  plan: { z: number; x0: number; x1: number; y0: number; y1: number },
  onProgress: (done: number, total: number) => void
): Promise<{ segs: RoadSeg[]; missing: number }> {
  const pm = new PMTiles(url);
  const jobs: [number, number][] = [];
  for (let x = plan.x0; x <= plan.x1; x++) {
    for (let y = plan.y0; y <= plan.y1; y++) jobs.push([x, y]);
  }

  const segs: RoadSeg[] = [];
  let done = 0;
  let missing = 0;
  const CONCURRENCY = 12;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, w) => {
      for (let i = w; i < jobs.length; i += CONCURRENCY) {
        const [x, y] = jobs[i];
        try {
          const t = await pm.getZxy(plan.z, x, y);
          if (t?.data) {
            const layer = new VectorTile(new PbfReader(new Uint8Array(t.data))).layers["roads"];
            for (let f = 0; layer && f < layer.length; f++) {
              const feat = layer.feature(f);
              const p: any = feat.properties;
              const kind = String(p.kind ?? "");
              const detail = String(p.kind_detail ?? "");
              if (!isRoutable(kind, detail)) continue;
              for (const line of feat.loadGeometry()) {
                if (line.length < 2) continue;
                segs.push({
                  coords: line.map((pt) => [
                    tile2lng(x + pt.x / feat.extent, plan.z),
                    tile2lat(y + pt.y / feat.extent, plan.z),
                  ]),
                  kind,
                  detail,
                  name: p.name ? String(p.name) : undefined,
                  ref: p.ref ? String(p.ref) : undefined,
                  oneway: String(p.oneway ?? "") === "yes",
                  bridge: String(p.is_bridge ?? "") === "true",
                });
              }
            }
          }
        } catch {
          // Count it: a dropped tile is a hole in the network, and a hole is
          // indistinguishable from "no road here" once the graph is built.
          missing++;
        }
        done++;
        if (done % 25 === 0 || done === jobs.length) onProgress(done, jobs.length);
      }
    })
  );
  return { segs, missing };
}

function miles(m: number) {
  const mi = m / 1609.344;
  return mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString();
}

export function initRoute(deps: {
  map: () => maplibregl.Map;
  /** Current pmtiles URL WITHOUT the pmtiles:// prefix. */
  sourceUrl: () => string;
}) {
  const panel = document.getElementById("route-panel");
  const body = document.getElementById("route-body");
  let from: Endpoint | null = null;
  let to: Endpoint | null = null;
  let busy = false;

  function clearRoute() {
    const map = deps.map();
    for (const id of [LINE, CASING]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  }

  function draw(coords: [number, number][]) {
    const map = deps.map();
    clearRoute();
    map.addSource(SRC, {
      type: "geojson",
      data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } },
    });
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    map.addLayer(
      {
        id: CASING,
        type: "line",
        source: SRC,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#06121e", "line-width": 8, "line-opacity": 0.85 },
      },
      firstSymbol
    );
    map.addLayer(
      {
        id: LINE,
        type: "line",
        source: SRC,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#4fc3ff", "line-width": 4 },
      },
      firstSymbol
    );
  }

  function fit(coords: [number, number][]) {
    const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
    for (const c of coords) b.extend(c);
    deps.map().fitBounds(b, { padding: 60, duration: 600 });
  }

  function renderIdle(msg = "") {
    if (!body) return;
    const pt = (e: Endpoint | null, fallback: string) =>
      e ? `${e.label} (${e.lat.toFixed(4)}, ${e.lng.toFixed(4)})` : fallback;
    body.innerHTML = `
      <div class="rt-row"><span class="rt-k">From</span><span class="rt-v">${pt(from, "not set")}</span></div>
      <div class="rt-row"><span class="rt-k">To</span><span class="rt-v">${pt(to, "not set")}</span></div>
      <div class="rt-btns">
        <button id="rt-from-here" type="button">Start: my location</button>
        <button id="rt-from-cross" type="button">Start: crosshair</button>
        <button id="rt-to-cross" type="button">Dest: crosshair</button>
        <button id="rt-clear" type="button">Clear</button>
      </div>
      <button id="rt-go" type="button" class="rt-go">Find the way</button>
      ${msg ? `<div class="rt-msg">${msg}</div>` : ""}
      <div class="rt-disclaimer">Overview only, from map data: no turn restrictions,
      gates, private-road or seasonal-closure information. Check the ground before you commit.</div>`;
    wire();
  }

  function renderResult(r: RouteResult, plan: { z: number }, missing: number, approx: boolean) {
    if (!body) return;
    const detour = r.meters / Math.max(1, r.directMeters);
    const steps = r.steps
      .filter((s) => s.meters > 40)
      .slice(0, 14)
      .map(
        (s) =>
          `<div class="rt-step"><span>${s.name}</span><span>${miles(s.meters)} mi</span></div>`
      )
      .join("");
    body.innerHTML = `
      <div class="rt-summary">
        <div class="rt-dist">${miles(r.meters)} mi</div>
        <div class="rt-sub">by road · ${miles(r.directMeters)} mi straight line (${detour.toFixed(1)}×)</div>
      </div>
      ${
        r.usedTrail
          ? `<div class="rt-warn">⚠ Part of this route is a trail or track, not a road. It may not be passable by vehicle.</div>`
          : ""
      }
      ${
        approx
          ? `<div class="rt-warn">⚠ Approximate: the road network had gaps along this corridor, so nearby road ends were joined to complete it. Some connections may not exist on the ground.</div>`
          : ""
      }
      ${
        r.snappedFromM > 150 || r.snappedToM > 150
          ? `<div class="rt-warn">⚠ The route starts ${Math.round(r.snappedFromM)} m from your start and ends ${Math.round(r.snappedToM)} m from your destination — that's the nearest connected road.</div>`
          : ""
      }
      ${
        plan.z < 14
          ? `<div class="rt-warn">⚠ Long trip: computed from coarser map detail, so one-way streets and minor roads weren't considered.</div>`
          : ""
      }
      ${
        missing > 0
          ? `<div class="rt-warn">⚠ ${missing} map tile(s) failed to load — a better route may exist through the missing area.</div>`
          : ""
      }
      <div class="rt-steps">${steps || `<div class="rt-step"><span>Unnamed roads the whole way</span></div>`}</div>
      <div class="rt-btns">
        <button id="rt-again" type="button">New route</button>
        <button id="rt-clear" type="button">Clear</button>
      </div>
      <div class="rt-disclaimer">Overview only, from map data: no turn restrictions,
      gates, private-road or seasonal-closure information. Check the ground before you commit.</div>`;
    wire();
  }

  async function go() {
    if (busy) return;
    if (!from || !to) {
      renderIdle("Set both a start and a destination first.");
      return;
    }
    const direct = haversineLL(from, to);
    const plan = planTiles(from, to, direct);
    if (!plan) {
      renderIdle(
        "That's too far apart for an offline route overview. Try a closer destination, or route it in shorter legs."
      );
      return;
    }
    busy = true;
    if (body) body.innerHTML = `<div class="rt-msg">Reading roads from the pack…</div>`;
    try {
      const { segs, missing } = await loadRoads(deps.sourceUrl(), plan, (d, t) => {
        if (body) body.innerHTML = `<div class="rt-msg">Reading roads… ${d}/${t} tiles</div>`;
      });
      if (!segs.length) {
        renderIdle("No roads found in this area of the pack.");
        return;
      }
      if (body) body.innerHTML = `<div class="rt-msg">Working out the way…</div>`;
      // Strict stitching first. If that finds nothing, the gaps at tile seams
      // are wider than usual along this corridor — retry with a looser
      // tolerance, which recovers many otherwise-unroutable trips (measured:
      // Bend -> Sisters fails at 25 m and routes via US 20/OR 126 at 60 m).
      // The looser pass is more likely to bridge two roads that don't really
      // meet, so anything it produces is flagged as approximate.
      let approx = false;
      let graph = buildRouteGraph(segs);
      let r = findRoute(graph, [from.lng, from.lat], [to.lng, to.lat], { snapMeters: 2000 });
      if (!r) {
        approx = true;
        graph = buildRouteGraph(segs, { stitchMeters: 60 });
        r = findRoute(graph, [from.lng, from.lat], [to.lng, to.lat], { snapMeters: 2000 });
      }
      if (!r) {
        // Be explicit that this is a limit of the data, not a claim that no
        // road exists — the network in these tiles is not fully connected.
        renderIdle(
          `No connected road route found. The map pack's road network can have gaps, so this doesn't prove there's no way through. Straight-line distance is ${miles(
            haversineLL(from, to)
          )} mi.`
        );
        clearRoute();
        return;
      }
      draw(r.coords);
      fit(r.coords);
      renderResult(r, plan, missing, approx);
    } catch (err) {
      renderIdle(`Couldn't build the route: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  }

  function haversineLL(a: Endpoint, b: Endpoint) {
    const R = 6371000;
    const φ1 = (a.lat * Math.PI) / 180;
    const φ2 = (b.lat * Math.PI) / 180;
    const dφ = φ2 - φ1;
    const dλ = ((b.lng - a.lng) * Math.PI) / 180;
    const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function center(): Endpoint {
    const c = deps.map().getCenter();
    return { lng: c.lng, lat: c.lat, label: "crosshair" };
  }

  function wire() {
    document.getElementById("rt-from-cross")?.addEventListener("click", () => {
      from = center();
      renderIdle();
    });
    document.getElementById("rt-to-cross")?.addEventListener("click", () => {
      to = center();
      renderIdle();
    });
    document.getElementById("rt-from-here")?.addEventListener("click", () => {
      if (!("geolocation" in navigator)) {
        renderIdle("Location isn't available on this device — use the crosshair instead.");
        return;
      }
      renderIdle("Getting your location…");
      navigator.geolocation.getCurrentPosition(
        (p) => {
          from = { lng: p.coords.longitude, lat: p.coords.latitude, label: "my location" };
          renderIdle();
        },
        (err) => {
          // Never leave this silent: the user is waiting on a fix that isn't coming.
          renderIdle(
            err.code === err.PERMISSION_DENIED
              ? "Location permission denied — use the crosshair instead."
              : "Couldn't get a location fix — use the crosshair instead."
          );
        },
        { enableHighAccuracy: true, timeout: 15000 }
      );
    });
    document.getElementById("rt-clear")?.addEventListener("click", () => {
      from = to = null;
      clearRoute();
      renderIdle();
    });
    document.getElementById("rt-again")?.addEventListener("click", () => renderIdle());
    document.getElementById("rt-go")?.addEventListener("click", () => void go());
  }

  document.getElementById("route-open")?.addEventListener("click", () => {
    renderIdle();
    panel?.classList.remove("hidden");
  });
  document.getElementById("route-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });

  // Style rebuilds (theme/terrain/pack switches) drop custom sources.
  deps.map().on("style.load", () => {
    if (deps.map().getSource(SRC)) return;
  });
}
