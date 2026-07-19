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
import { loadMarks, marksUnreadable, type Waypoint } from "./store";

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

/** A computed route plus everything needed to redraw it later. */
interface Shown {
  r: RouteResult;
  z: number;
  missing: number;
  approx: boolean;
  from: Endpoint;
  to: Endpoint;
  at: number;
}

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} hr ago` : `${Math.round(h / 24)} day(s) ago`;
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
  // Pad the corridor by a share of the TRIP LENGTH, on both axes.
  //
  // Padding each axis by its own extent looks reasonable and is badly wrong:
  // for a due-east trip the latitude difference is ~0, so the north-south
  // corridor collapsed to the 0.02° floor (~2 km). Any route that has to bow
  // around terrain then falls outside the loaded tiles and reports "no
  // connected road route" — which is what happened on a 62 km east-west trip
  // whose real road (US-26 through Government Camp) dips ~10 km south of the
  // straight line.
  const padM = Math.max(3000, directMeters * 0.35);
  const midLat = (a.lat + b.lat) / 2;
  const padLat = padM / 111320;
  const padLng = padM / (111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  const west = Math.min(a.lng, b.lng) - padLng;
  const east = Math.max(a.lng, b.lng) + padLng;
  const south = Math.min(a.lat, b.lat) - padLat;
  const north = Math.max(a.lat, b.lat) + padLat;

  // Every zoom worth trying, best guess first.
  //
  // NO SINGLE ZOOM WINS. Which one connects depends on the corridor, not just
  // the distance: Bend -> Redmond routes cleanly at z12 and not at all at z14,
  // while a 38 mi trip over Mt Hood is the reverse — z13 routes it at strict
  // tolerance and z12 needs a reckless 120 m stitch. So distance only orders
  // the attempts; the caller walks the list until one connects.
  const guess = zoomForTrip(directMeters);
  const order = [...ZOOMS].sort((p, q) => Math.abs(p - guess) - Math.abs(q - guess));
  const plans = [];
  for (const z of order) {
    const x0 = lng2tile(west, z);
    const x1 = lng2tile(east, z);
    const y0 = lat2tile(north, z);
    const y1 = lat2tile(south, z);
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count <= MAX_TILES) plans.push({ z, x0, x1, y0, y1, count });
  }
  return plans;
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

/** Pin names are user-entered; never inject them raw into innerHTML. */
function escapeHtml(v: string) {
  return v.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

function miles(m: number) {
  const mi = m / 1609.344;
  return mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString();
}

/** Short distances in feet, longer ones in miles — imperial throughout. */
function shortDist(m: number) {
  const ft = m * 3.28084;
  return ft < 1000 ? `${Math.round(ft).toLocaleString()} ft` : `${miles(m)} mi`;
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

  // The last route that actually worked. Two jobs, both about never being left
  // worse off than before you asked:
  //  - a failed recompute must not take away the route you already had;
  //  - a route survives a reload or a webview crash (which this platform does
  //    do — see the WebKitGTK crashes in the notes), because the moment you
  //    most need the way out is the moment you can least afford to recompute.
  let shown: Shown | null = null;
  const SAVE_KEY = "griddown_last_route";

  // Saved waypoints, refreshed each time the panel opens so a pin dropped a
  // moment ago is selectable without a restart.
  let pins: Waypoint[] = [];
  let pinsProblem = "";
  async function refreshPins() {
    try {
      const marks = await loadMarks();
      // An unreadable marks file reads as "you have no pins" — say which it is
      // rather than quietly offering an empty list.
      pinsProblem = marksUnreadable()
        ? "Couldn't read your saved pins — see Readiness."
        : "";
      pins = pinsProblem ? [] : marks.waypoints;
    } catch {
      pins = [];
      pinsProblem = "Couldn't read your saved pins.";
    }
  }

  function save(s: Shown) {
    try {
      // Coordinates rounded to ~1 m: this is a map line, not a survey, and a
      // long route is thousands of points.
      localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          ...s,
          r: { ...s.r, coords: s.r.coords.map(([a, b]) => [+a.toFixed(5), +b.toFixed(5)]) },
        })
      );
    } catch {
      // Out of quota or storage disabled — the in-memory copy still works.
    }
  }

  function loadSaved(): Shown | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as Shown;
      if (!s?.r?.coords?.length || !s.from || !s.to) return null;
      return s;
    } catch {
      return null;
    }
  }

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
    const pinBtns =
      pins.length > 0
        ? `<div class="rt-btns">
             <button id="rt-from-pin" type="button">&#9670; Start: a pin</button>
             <button id="rt-to-pin" type="button">&#9670; Dest: a pin</button>
           </div>`
        : `<div class="rt-fine">${
            pinsProblem || "No saved pins yet — drop one in Marks and it'll show up here."
          }</div>`;
    body.innerHTML = `
      <div class="rt-row"><span class="rt-k">From</span><span class="rt-v">${pt(from, "not set")}</span></div>
      <div class="rt-row"><span class="rt-k">To</span><span class="rt-v">${pt(to, "not set")}</span></div>
      ${pinBtns}
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

  /** Pick one of the saved pins as the start or destination. */
  function renderPinPicker(which: "from" | "to") {
    if (!body) return;
    const here = deps.map().getCenter();
    // Nearest first: the pin you want is usually the one you're looking at.
    const sorted = [...pins].sort(
      (a, b) =>
        haversineLL({ lng: a.lng, lat: a.lat, label: "" }, { lng: here.lng, lat: here.lat, label: "" }) -
        haversineLL({ lng: b.lng, lat: b.lat, label: "" }, { lng: here.lng, lat: here.lat, label: "" })
    );
    body.innerHTML = `
      <div class="rt-row"><span class="rt-k">${which === "from" ? "Start" : "Destination"}</span><span class="rt-v">pick a pin</span></div>
      <div class="rt-steps">
        ${sorted
          .map((w, i) => {
            const d = haversineLL(
              { lng: w.lng, lat: w.lat, label: "" },
              { lng: here.lng, lat: here.lat, label: "" }
            );
            return `<button class="rt-pin" data-i="${i}" type="button"><span>${escapeHtml(
              w.name || "Unnamed pin"
            )}</span><span>${miles(d)} mi</span></button>`;
          })
          .join("")}
      </div>
      <div class="rt-btns"><button id="rt-pin-cancel" type="button">Back</button></div>`;
    body.querySelectorAll<HTMLButtonElement>(".rt-pin").forEach((b) => {
      b.addEventListener("click", () => {
        const w = sorted[Number(b.dataset.i)];
        const e: Endpoint = { lng: w.lng, lat: w.lat, label: w.name || "pin" };
        if (which === "from") from = e;
        else to = e;
        renderIdle();
      });
    });
    document.getElementById("rt-pin-cancel")?.addEventListener("click", () => renderIdle());
  }

  function renderResult(s: Shown, problem = "") {
    if (!body) return;
    const { r, missing, approx } = s;
    const plan = { z: s.z };
    const stale = Date.now() - s.at > 60000;
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
      ${problem ? `<div class="rt-warn">⚠ ${problem} Showing the previous route, worked out ${ago(s.at)}.</div>` : ""}
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
          ? `<div class="rt-warn">⚠ The route starts ${shortDist(r.snappedFromM)} from your start and ends ${shortDist(r.snappedToM)} from your destination — that's the nearest connected road.</div>`
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
      <button id="rt-refresh" type="button" class="rt-go">↻ Recompute from where I am</button>
      <div class="rt-btns">
        <button id="rt-again" type="button">New route</button>
        <button id="rt-clear" type="button">Clear</button>
      </div>
      <div class="rt-fine">This route doesn't follow you &mdash; it was worked out
      ${stale ? ago(s.at) : "just now"}, from the start point. Recompute when you've moved.</div>
      <div class="rt-disclaimer">Overview only, from map data: no turn restrictions,
      gates, private-road or seasonal-closure information. Check the ground before you commit.</div>`;
    wire();
  }

  /**
   * Report a failure WITHOUT throwing away a route that already worked.
   *
   * A recompute that can't find a way — no fix, tiles unreadable, gaps in the
   * network — must never leave you with less than you had a moment ago. The
   * previous line stays on the map and on screen; only the reason changes.
   */
  function fail(msg: string) {
    if (shown) {
      draw(shown.r.coords); // may have been cleared by a style rebuild
      renderResult(shown, msg);
    } else {
      renderIdle(msg);
    }
  }

  async function go() {
    if (busy) return;
    if (!from || !to) {
      renderIdle("Set both a start and a destination first.");
      return;
    }
    const direct = haversineLL(from, to);
    const plans = planTiles(from, to, direct);
    if (!plans.length) {
      fail(
        "That's too far apart for an offline route overview. Try a closer destination, or route it in shorter legs."
      );
      return;
    }
    busy = true;
    if (body) body.innerHTML = `<div class="rt-msg">Reading roads from the pack&hellip;</div>`;
    try {
      // Walk the zoom candidates, STRICT stitching on every one before trying a
      // loose pass on any. A strict route at another zoom is more trustworthy
      // than a loose route at the preferred zoom, because the loose pass can
      // bridge roads that don't actually meet.
      const loaded = new Map<number, { segs: RoadSeg[]; missing: number }>();
      const roadsFor = async (plan: (typeof plans)[number]) => {
        const hit = loaded.get(plan.z);
        if (hit) return hit;
        const got = await loadRoads(deps.sourceUrl(), plan, (d, t) => {
          if (body) body.innerHTML = `<div class="rt-msg">Reading roads&hellip; ${d}/${t} tiles</div>`;
        });
        loaded.set(plan.z, got);
        return got;
      };

      let best: { r: RouteResult; plan: (typeof plans)[number]; missing: number; approx: boolean } | null = null;
      for (const stitch of [undefined, 60]) {
        for (const plan of plans) {
          const { segs, missing } = await roadsFor(plan);
          if (!segs.length) continue;
          if (body) body.innerHTML = `<div class="rt-msg">Working out the way&hellip;</div>`;
          const graph = buildRouteGraph(segs, stitch ? { stitchMeters: stitch } : {});
          const r = findRoute(graph, [from.lng, from.lat], [to.lng, to.lat], { snapMeters: 2000 });
          if (r) {
            best = { r, plan, missing, approx: stitch !== undefined };
            break;
          }
        }
        if (best) break;
      }

      if (!best) {
        // Be explicit that this is a limit of the data, not a claim that no
        // road exists — the network in these tiles is not fully connected.
        fail(
          `No connected road route found at any detail level. The map pack's road network can have gaps, so this doesn't prove there's no way through. Straight-line distance is ${miles(
            direct
          )} mi.`
        );
        return;
      }
      const next: Shown = {
        r: best.r,
        z: best.plan.z,
        missing: best.missing,
        approx: best.approx,
        from,
        to,
        at: Date.now(),
      };
      draw(best.r.coords);
      fit(best.r.coords);
      shown = next;
      save(next);
      renderResult(next);
    } catch (err) {
      fail(`Couldn't build the route: ${err instanceof Error ? err.message : String(err)}`);
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

  /** Set `from` to the current GPS fix, then continue — or explain why not. */
  function useMyLocation(then: () => void) {
    if (!("geolocation" in navigator)) {
      fail("Location isn't available on this device — use the crosshair instead.");
      return;
    }
    if (body) body.innerHTML = `<div class="rt-msg">Getting your location…</div>`;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        from = { lng: p.coords.longitude, lat: p.coords.latitude, label: "my location" };
        then();
      },
      (err) => {
        // Never leave this silent: the user is waiting on a fix that isn't coming.
        fail(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied — use the crosshair instead."
            : "Couldn't get a location fix — use the crosshair instead."
        );
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
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
    document.getElementById("rt-from-here")?.addEventListener("click", () =>
      useMyLocation(() => renderIdle())
    );
    // Recompute from where you are now. The route is a one-shot overview, not
    // live navigation — this is the deliberate manual equivalent, so a stale
    // line is only ever replaced when you ask for it.
    document.getElementById("rt-refresh")?.addEventListener("click", () =>
      useMyLocation(() => void go())
    );
    document.getElementById("rt-from-pin")?.addEventListener("click", () => renderPinPicker("from"));
    document.getElementById("rt-to-pin")?.addEventListener("click", () => renderPinPicker("to"));
    document.getElementById("rt-clear")?.addEventListener("click", () => {
      from = to = null;
      shown = null;
      try {
        localStorage.removeItem(SAVE_KEY);
      } catch {
        /* storage unavailable — the in-memory clear is what matters */
      }
      clearRoute();
      renderIdle();
    });
    document.getElementById("rt-again")?.addEventListener("click", () => renderIdle());
    document.getElementById("rt-go")?.addEventListener("click", () => void go());
  }

  document.getElementById("route-open")?.addEventListener("click", () => {
    void refreshPins().then(() => {
      // Only redraw the idle view; a shown result shouldn't be replaced.
      if (!shown) renderIdle();
    });
    // Restore the last working route, including across a restart or a crash.
    if (!shown) {
      const saved = loadSaved();
      if (saved) {
        shown = saved;
        from = saved.from;
        to = saved.to;
      }
    }
    if (shown) {
      draw(shown.r.coords);
      renderResult(shown);
    } else {
      renderIdle();
    }
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
