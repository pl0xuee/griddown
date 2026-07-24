import maplibregl from "maplibre-gl";
import { PMTiles } from "pmtiles";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import {
  buildRouteGraph,
  findRoute,
  isRoutable,
  type RoadSeg,
  type RouteResult,
} from "./routegraph";
import { loadMarks, marksUnreadable, type Waypoint } from "./store";
import { ensurePlaceIndex, rankMatches, rankPins, placeLabel, type Place } from "./search";
import { getFix } from "./geoloc";
import { esc as escapeHtml } from "./esc";
import { toast } from "./toast";
import { loadMvumFor, mvumClass, formatDates } from "./mvum";
import { buildMvumIndex, summariseRoute } from "./mvumindex";
import { OVERPRINT, OVERPRINT_CASING } from "./overprint";

// "How do I get there" overview: a road-following path from a start point to a
// destination, built entirely from the active map pack. Not turn-by-turn, not
// live — you get the shape of the journey, the distance, and which roads to
// follow, computed offline.
//
// The road data comes from rendering tiles, so it has no turn restrictions, no
// access tags (private drives, locked gates), no surface and no closures. The
// UI says so on every result; do not quietly upgrade the wording to sound like
// navigation.

/** Start-point label used when a recompute had no GPS and fell back to the map
 *  centre. Compared against in renderResult, so it lives in one place. */
const CROSSHAIR_LABEL = "the crosshair";

const SRC = "gd-route";
const LINE = "gd-route-line";
const CASING = "gd-route-casing";

// z14 is the shallowest zoom carrying `oneway`; below it we'd be guessing at
// direction. Long trips fall back to coarser zooms and say so.
//
// z11 and z10 exist for the long haul. Without them a corridor that didn't fit
// 900 tiles at z12 produced no plan at all, and the app simply refused: Bend to
// Burns, Portland to Bend and Newport to La Grande — three of the drives anyone
// in this state actually makes — all answered "that's too far apart for an
// offline route overview" while sitting on a pack that contained the whole road.
const ZOOMS = [14, 13, 12, 11, 10];
const MAX_TILES = 1400;

/**
 * How far apart two pieces of road may be and still count as one road.
 *
 * Scaled to the zoom because the gaps this bridges are an artifact of tile
 * resolution, not of the ground: the same junction that meets cleanly at z14 is
 * rendered hundreds of metres apart at z12. A flat 25 m was right for z14 and
 * far too tight below it, and the cost was not a failed route but a plausible
 * WRONG one — the router detoured around every seam it could not cross.
 * Measured against the Oregon pack: Bend to Government Camp came out 151 mi at
 * 25 m and 110 mi at 250 m, against a real drive of about 105.
 */
function stitchFor(z: number): number {
  return Math.round(25 * 2 ** (14 - z));
}

/**
 * The widest the search corridor is allowed to get, in metres.
 *
 * Padding by a share of the trip length is right for short trips and ruinous
 * for long ones: a 120-mile trip asked for a 42-mile margin on every side,
 * which is what pushed long routes down to the coarsest zoom, where the road
 * network is too sparse to follow. Capping the margin keeps a long trip on
 * FINER tiles, and finer tiles are what make the route resemble the drive —
 * Portland to Bend is 178 mi through a wide z12 corridor and 167 mi through a
 * capped z13 one, against a real drive of about 160.
 */
const MAX_PAD_M = 15000;

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
  const padM = Math.min(Math.max(3000, directMeters * 0.35), MAX_PAD_M);
  const midLat = (a.lat + b.lat) / 2;
  const padLat = padM / 111320;
  const padLng = padM / (111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  // Unwrap across the antimeridian before taking min/max. In the western
  // Aleutians a trip from 179°E to 179°W is a few miles, but raw min/max makes
  // it span the globe — every zoom then blows the tile budget and the app
  // reports "too far apart" for two points you can see from each other. The
  // corridor is allowed to run past ±180 so the tile range stays contiguous;
  // loadRoads wraps each x back into the world when it asks for the tile.
  const aLng = a.lng;
  const bLng = Math.abs(b.lng - a.lng) > 180 ? b.lng + (b.lng < a.lng ? 360 : -360) : b.lng;
  const west = Math.min(aLng, bLng) - padLng;
  const east = Math.max(aLng, bLng) + padLng;
  const south = Math.min(a.lat, b.lat) - padLat;
  const north = Math.max(a.lat, b.lat) + padLat;

  // FINEST zoom first, coarser only as a fallback.
  //
  // This used to be the other way round, on the evidence that long trips
  // routed better at z12. That was never a property of the data — it was a
  // symptom of the seam-stitching bug fixed in 1e61b3a. Coarse tiles have
  // fewer seams, so they suffered least from it. With seams stitched properly
  // the finest zoom wins on every count: Bend -> Redmond is 17.3 mi at z14
  // against 18.2 mi at z12 (~17 mi in reality), it is the only zoom carrying
  // `oneway`, and its geometry actually follows the bends in the road instead
  // of cutting corners when drawn over a detailed basemap.
  const plans = [];
  for (const z of ZOOMS) {
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
  // The x range is kept CONTIGUOUS by planTiles (it may run past the
  // antimeridian, so x1 can exceed 2^z-1) and wrapped here, at the point of
  // asking for a tile. A no-op everywhere except the western Aleutians.
  const n = 2 ** plan.z;
  for (let x = plan.x0; x <= plan.x1; x++) {
    const wx = ((x % n) + n) % n;
    for (let y = plan.y0; y <= plan.y1; y++) jobs.push([wx, y]);
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

/**
 * Say whether the forest roads on this route are ones you may legally drive.
 *
 * The router plans over the basemap, which includes forest tracks but knows
 * nothing about motor-vehicle designation. Where the pack has an MVUM overlay
 * downloaded, the finished route is matched against it — so "Get there" can
 * answer the question the map alone cannot.
 *
 * Silent when there is no overlay: absence of data must not be dressed up as
 * an absence of restrictions.
 */
async function renderMvumCheck(coords: [number, number][], abbr: string) {
  const slot = document.getElementById("rt-mvum");
  if (!slot || !abbr || coords.length < 2) return;
  const data = await loadMvumFor(abbr);
  if (!data) return;

  const index = buildMvumIndex(data);
  if (!index.size) return;
  const sum = summariseRoute(coords, index, mvumClass, (p) =>
    // Whichever class is designated tells us the season it's open.
    formatDates(
      p.passengervehicle_datesopen ?? p.highclearancevehicle_datesopen ?? p.atv_datesopen
    )
  );
  if (sum.matchedM < 100) return; // nothing meaningful on Forest Service road

  const share = sum.matchedM / (sum.matchedM + sum.unmatchedM);
  const classes = sum.byClass
    .filter((c) => c.metres > 80)
    .map(
      (c) =>
        `<div class="rt-step"><span>${escapeHtml(c.label)}</span><span>${miles(c.metres)} mi</span></div>`
    )
    .join("");

  const named = sum.routes
    .filter((r) => r.id || r.name)
    .slice(0, 6)
    .map((r) => escapeHtml([r.id, r.name].filter(Boolean).join(" ")))
    .join(", ");

  const seasonal = sum.seasonal.length
    ? `<div class="rt-warn">⚠ Seasonal: ${sum.seasonal
        .slice(0, 4)
        .map((s) => `${escapeHtml(s.id)}${s.dates ? ` open ${escapeHtml(s.dates)}` : ""}`)
        .join("; ")}. Outside those dates this route may be closed to vehicles.</div>`
    : "";

  slot.innerHTML = `
    <div class="rt-mvum-head">● Forest Service roads on this route</div>
    <div class="rt-sub">${miles(sum.matchedM)} mi of ${miles(
      sum.matchedM + sum.unmatchedM
    )} mi (${Math.round(share * 100)}%) is designated motor-vehicle route</div>
    <div class="rt-steps">${classes}</div>
    ${named ? `<div class="rt-sub">Routes: ${named}</div>` : ""}
    ${seasonal}
    <div class="rt-fine">Matched to the MVUM by position, so short stretches may
    be missed. Anything not matched is simply unknown here — not confirmed open.</div>`;
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
  /** Which pack is active, for looking up its Forest Service overlay. */
  activeAbbr?: () => string;
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

  const recalc = document.getElementById("route-recalc") as HTMLButtonElement | null;

  /**
   * Show the on-map recompute button when, and only when, it is the thing you
   * would reach for: a route is drawn AND the panel is not sitting over it.
   *
   * Deliberately manual. A route is a snapshot from where you were standing
   * when you asked, and recomputing it on a timer would move the line under
   * someone mid-decision and burn the GPS doing it. This just puts the button
   * where your eyes already are.
   */
  /** True from the tap until the route is drawn or the attempt has failed —
   *  which starts well before `busy`, since getting a fix comes first. */
  let recalcPending = false;

  function syncRecalc() {
    if (!recalc) return;
    const panelOpen = !!panel && !panel.classList.contains("hidden");
    const working = busy || recalcPending;
    recalc.classList.toggle("hidden", !shown || panelOpen);
    recalc.disabled = working;
    recalc.textContent = working ? "↻ Recomputing…" : "↻ Recalculate";
  }

  recalc?.addEventListener("click", () => {
    if (busy || recalcPending) return;
    // Mark it busy BEFORE asking for a fix. `busy` is only set once routing
    // starts, which is after the GPS returns — so the button sat enabled and
    // reading "Recalculate" through the entire acquisition, looked dead, and
    // invited taps that each fired another location request.
    recalcPending = true;
    syncRecalc();
    // The on-map button is pressed while walking, with the panel shut. A hard
    // failure there is a dead end — there is no visible control to fall back
    // to — so this one routes from the crosshair rather than giving up. The
    // panel's "Recompute from where I am" keeps failing honestly: it names the
    // start point in its own label, and the panel is open to say why.
    useMyLocation(() => void go(), { orCrosshair: true });
  });
  // The panel is opened and closed from several places (its own button, the
  // command bar, Escape, panels.ts's mutual exclusion), so watch the class
  // rather than trying to hook every one of them.
  if (panel) {
    new MutationObserver(syncRecalc).observe(panel, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  // Saved waypoints, refreshed each time the panel opens so a pin dropped a
  // moment ago is selectable without a restart.
  let pins: Waypoint[] = [];
  let pinsProblem = "";
  // The pack's place names, built lazily the first time a picker opens and
  // shared with Find (see ensurePlaceIndex). Null until read. Keyed by the url
  // it was built for: initRoute lives for the whole session while the active
  // pack changes underneath it, so without the url check the picker would keep
  // searching the previous state's town names after a switch.
  let places: Place[] | null = null;
  let placesUrl = "";
  // Set while an endpoint picker is on screen, so the async place-index load
  // can re-render it once names are ready.
  let pickerUpdate: (() => void) | null = null;
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

  // `simplified` = computed from coarse tiles, so the line cuts corners on a
  // detailed basemap. Dash it, so the shape reads as approximate at a glance
  // rather than looking like the router ignored the road.
  function draw(coords: [number, number][], simplified = false) {
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
        paint: { "line-color": OVERPRINT_CASING, "line-width": 8, "line-opacity": 0.85 },
      },
      firstSymbol
    );
    map.addLayer(
      {
        id: LINE,
        type: "line",
        source: SRC,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": OVERPRINT,
          "line-width": 4,
          ...(simplified ? { "line-dasharray": [2.5, 1.5] as [number, number] } : {}),
        },
      },
      firstSymbol
    );
  }

  /**
   * Frame the whole route in the part of the map you can actually see.
   *
   * A uniform padding is wrong here, because the visible map is not the map
   * element: the dock covers the bottom ~103px on a phone, the collar and the
   * command bar sit on top of it, and an open panel takes a whole side. Fitting
   * to the raw container tucked the southern end of every route behind the
   * dock — worst on exactly the routes you most want to see whole, since a
   * long one is fitted tightly.
   *
   * Measured from the live chrome rather than hard-coded, so it stays right as
   * the safe-area insets and --dock-h change between devices and orientations.
   */
  function fit(coords: [number, number][]) {
    if (!coords.length) return;
    const map = deps.map();
    const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
    for (const c of coords) b.extend(c);

    // A route can be a single point: both endpoints snap to the same graph node
    // when the destination is within snapMeters, which the "Get there" button on
    // an identify card hits for water a few hundred metres away. fitBounds on a
    // zero-area box divides by zero and clamps to maxZoom — 22 here, since no
    // maxZoom is set — flying to an empty void above the map.
    if (b.getEast() - b.getWest() < 1e-6 && b.getNorth() - b.getSouth() < 1e-6) {
      map.easeTo({ center: coords[0], zoom: Math.max(map.getZoom(), 15), duration: 600 });
      return;
    }

    const canvas = map.getCanvas().getBoundingClientRect();
    const GAP = 24; // breathing room, so the line never touches an edge
    const box = (el: Element | null | undefined) =>
      el && !el.classList.contains("hidden") ? el.getBoundingClientRect() : null;

    const dock = box(document.getElementById("dock"));
    let top = GAP;
    let bottom = GAP + (dock ? Math.max(0, canvas.bottom - dock.top) : 0);
    let left = GAP;
    let right = GAP;

    // A panel open over the map takes a side on desktop and the whole screen on
    // a phone. Only pad for it when it leaves something worth fitting into.
    const p = box(panel);
    if (p && p.width < canvas.width * 0.6) {
      if (p.left - canvas.left < canvas.width * 0.2) left += p.width;
      else right += p.width;
    }

    // Never let the padding exceed the viewport: MapLibre cannot fit into a
    // negative box, and a tall route on a short screen gets close.
    const capV = Math.max(0, (canvas.height - 40) / 2);
    const capH = Math.max(0, (canvas.width - 40) / 2);
    top = Math.min(top, capV);
    bottom = Math.min(bottom, capV);
    left = Math.min(left, capH);
    right = Math.min(right, capH);

    map.fitBounds(b, { padding: { top, bottom, left, right }, duration: 600 });
  }

  /**
   * `msg` is NOT trusted, despite reading like our own copy. `routeTo` builds
   * it from a tapped feature's name — which comes out of the map pack, i.e. out
   * of a file a user may have been handed on an SD card — and from a Meshtastic
   * node's longName, which any radio in range chooses. Escape it like every
   * other interpolation here.
   */
  function renderIdle(msg = "") {
    if (!body) return;
    pickerUpdate = null; // no picker on screen now
    const slot = (e: Endpoint | null, which: "from" | "to") => {
      const set = !!e;
      const title = which === "from" ? "Start" : "Destination";
      const value = e ? escapeHtml(e.label) : `Set ${which === "from" ? "start" : "destination"}`;
      const coord = e ? `<span class="rt-slot-c">${e.lat.toFixed(4)}, ${e.lng.toFixed(4)}</span>` : "";
      return `<button class="rt-slot${set ? " set" : ""}" id="rt-set-${which}" type="button">
          <span class="rt-slot-k">${title}</span>
          <span class="rt-slot-v">${value}</span>${coord}
        </button>`;
    };
    const canClear = !!(from || to || shown);
    body.innerHTML = `
      ${slot(from, "from")}
      <div class="rt-swap-row">${
        from && to ? `<button id="rt-swap" type="button" class="rt-swap">&#8645; swap</button>` : ""
      }</div>
      ${slot(to, "to")}
      <button id="rt-go" type="button" class="rt-go">Find the way</button>
      ${canClear ? `<div class="rt-btns"><button id="rt-clear" type="button">Clear</button></div>` : ""}
      ${msg ? `<div class="rt-msg">${escapeHtml(msg)}</div>` : ""}
      <div class="rt-disclaimer">Overview only, from map data: no turn restrictions,
      gates, private-road or seasonal-closure information. Check the ground before you commit.</div>`;
    wire();
  }

  /** Kick off (or reuse) the place index for the CURRENT pack, re-rendering
   *  the picker when ready. */
  async function loadPlaces() {
    const url = deps.sourceUrl();
    if (places && placesUrl === url) {
      pickerUpdate?.();
      return;
    }
    try {
      const built = await ensurePlaceIndex(url);
      places = built;
      placesUrl = url;
    } catch {
      // Retryable, not cached: a failed read (or a place-less pack) must not
      // permanently disable name search for the session. Pins and the map
      // point still work meanwhile.
      places = null;
      placesUrl = "";
    }
    pickerUpdate?.();
  }

  /**
   * Choose a start or destination, all in one place: search the pack's towns,
   * pick one of your saved pins, drop on the map point, or use your location.
   *
   * Replaces the old pair of "pick a pin" screens. Pins are shown by default
   * and searched alongside places, which is where the app finally explains that
   * your dropped pins are reusable here.
   */
  function renderEndpointPicker(which: "from" | "to") {
    if (!body) return;
    const isFrom = which === "from";
    const here = deps.map().getCenter();
    const distTo = (lng: number, lat: number) =>
      haversineLL({ lng, lat, label: "" }, { lng: here.lng, lat: here.lat, label: "" });

    const choose = (e: Endpoint) => {
      if (isFrom) from = e;
      else to = e;
      renderIdle();
    };

    body.innerHTML = `
      <div class="rt-pick-head">
        <button id="rt-pick-back" type="button" class="rt-back" aria-label="Back">&#8249;</button>
        <span>Set ${isFrom ? "start" : "destination"}</span>
      </div>
      <input id="rt-pick-search" class="rt-search" type="text" autocomplete="off"
        placeholder="Search a town or place" aria-label="Search a town or place" />
      <div class="rt-quick">
        ${isFrom ? `<button id="rt-q-loc" type="button" class="rt-quick-btn">&#9678; My location</button>` : ""}
        <button id="rt-q-map" type="button" class="rt-quick-btn">&#10011; Point on the map</button>
      </div>
      <div id="rt-pick-results" class="rt-results"></div>
      <div id="rt-pick-hint" class="rt-hint"></div>`;

    const search = body.querySelector<HTMLInputElement>("#rt-pick-search")!;
    const resultsEl = body.querySelector<HTMLElement>("#rt-pick-results")!;
    const hintEl = body.querySelector<HTMLElement>("#rt-pick-hint")!;

    // The lists currently on screen, so one delegated handler can resolve a tap.
    let curPins: Waypoint[] = [];
    let curPlaces: Place[] = [];

    // Shared with Find, so the same feature is described the same way in both.
    const placeKind = (p: Place) => placeLabel(p);
    const pinRow = (w: Waypoint, i: number) =>
      `<button class="rt-hit" data-kind="pin" data-i="${i}" type="button">
        <span class="rt-hit-name">&#9670; ${escapeHtml(w.name || "Unnamed pin")}</span>
        <span class="rt-hit-sub">pin · ${miles(distTo(w.lng, w.lat))} mi</span></button>`;
    const placeRow = (p: Place, i: number) =>
      `<button class="rt-hit" data-kind="place" data-i="${i}" type="button">
        <span class="rt-hit-name">${escapeHtml(p.name)}</span>
        <span class="rt-hit-sub">${escapeHtml(placeKind(p))} · ${miles(distTo(p.lng, p.lat))} mi</span></button>`;
    const section = (title: string, rows: string[]) =>
      rows.length ? `<div class="rt-sec-h">${title}</div>${rows.join("")}` : "";

    const update = () => {
      const q = search.value.trim();
      if (!q) {
        // Default view: your pins, nearest first — and the explanation of them.
        curPlaces = [];
        if (pinsProblem) {
          curPins = [];
          resultsEl.innerHTML = "";
          hintEl.textContent = pinsProblem;
          return;
        }
        if (!pins.length) {
          curPins = [];
          resultsEl.innerHTML = "";
          hintEl.innerHTML =
            "No saved pins yet. Drop a pin on the map and save it in <b>Marks</b> — your pins show up here to reuse as a start or destination. Or search a town above.";
          return;
        }
        curPins = [...pins].sort((a, b) => distTo(a.lng, a.lat) - distTo(b.lng, b.lat));
        resultsEl.innerHTML = section("Your pins", curPins.map(pinRow));
        hintEl.textContent = "Your saved pins, nearest first — or type to search places.";
        return;
      }
      // Searching: your matching pins first (they're yours), then map places.
      // Only trust the index if it was built for the pack that's active now —
      // a switch leaves last pack's list around until loadPlaces refreshes it.
      const idx = places && placesUrl === deps.sourceUrl() ? places : null;
      curPins = rankPins(pins, q, 6);
      // Nearest first, same as Find. Without the centre the distance term is
      // zero for every candidate, and since almost nothing in the widened index
      // carries a population the score collapsed to name length — so a list
      // that prints a distance beside every row showed them in no order at all.
      curPlaces = idx ? rankMatches(idx, q, 20, { lng: here.lng, lat: here.lat }) : [];
      if (!curPins.length && !curPlaces.length) {
        resultsEl.innerHTML = "";
        hintEl.textContent = idx ? `Nothing here matches "${escapeHtml(q)}".` : "Reading place names…";
        return;
      }
      hintEl.textContent = idx ? "" : "Still reading place names — more may appear.";
      resultsEl.innerHTML =
        section("Pins", curPins.map(pinRow)) + section("Places", curPlaces.map(placeRow));
    };
    // So the async place-index load can refresh this exact picker.
    pickerUpdate = update;

    resultsEl.addEventListener("click", (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>(".rt-hit");
      if (!btn) return;
      if (btn.dataset.kind === "pin") {
        const w = curPins[Number(btn.dataset.i)];
        if (w) choose({ lng: w.lng, lat: w.lat, label: w.name || "pin" });
      } else {
        const p = curPlaces[Number(btn.dataset.i)];
        if (p) choose({ lng: p.lng, lat: p.lat, label: p.name });
      }
    });

    search.addEventListener("input", update);
    document.getElementById("rt-pick-back")?.addEventListener("click", () => renderIdle());
    document.getElementById("rt-q-map")?.addEventListener("click", () => {
      const c = deps.map().getCenter();
      choose({ lng: c.lng, lat: c.lat, label: "map point" });
    });
    document.getElementById("rt-q-loc")?.addEventListener("click", () =>
      useMyLocation(() => renderIdle())
    );

    update();
    search.focus();
    void loadPlaces();
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
          // Road names come from OSM via the pack — attacker-editable text.
          `<div class="rt-step"><span>${escapeHtml(s.name)}</span><span>${miles(s.meters)} mi</span></div>`
      )
      .join("");
    body.innerHTML = `
      ${problem ? `<div class="rt-warn">⚠ ${escapeHtml(problem)} Showing the previous route, worked out ${ago(s.at)}.</div>` : ""}
      <div class="rt-summary">
        <div class="rt-dist">${miles(r.meters)} mi</div>
        <div class="rt-sub">by road · ${miles(r.directMeters)} mi straight line (${detour.toFixed(1)}×)</div>
        <div class="rt-sub">from ${escapeHtml(s.from.label)} to ${escapeHtml(s.to.label)}</div>
      </div>
      ${
        // Where a route STARTS is as load-bearing as where it ends, and the
        // crosshair fallback can put the start an arbitrary distance from the
        // user. The toast that announced it is long gone by the time they open
        // this panel, so say it here too.
        s.from.label === CROSSHAIR_LABEL
          ? `<div class="rt-warn">⚠ Worked out from the crosshair, not from your position — there was no GPS fix.</div>`
          : ""
      }
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
          ? `<div class="rt-warn">⚠ Long trip: computed from coarser map detail. One-way streets weren't considered, and the drawn line follows the right roads but cuts corners rather than tracing every bend.</div>`
          : ""
      }
      ${
        missing > 0
          ? `<div class="rt-warn">⚠ ${missing} map tile(s) failed to load — a better route may exist through the missing area.</div>`
          : ""
      }
      <div class="rt-steps">${steps || `<div class="rt-step"><span>Unnamed roads the whole way</span></div>`}</div>
      <div id="rt-mvum"></div>
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
    // Fills #rt-mvum once the overlay has been read — a state's forest roads
    // are tens of megabytes, so the route is shown first rather than waiting.
    void renderMvumCheck(r.coords, deps.activeAbbr?.() ?? "");
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
      draw(shown.r.coords, shown.z < 14); // may have been cleared by a style rebuild
      renderResult(shown, msg);
    } else {
      renderIdle(msg);
    }
    // Every message this function writes goes into the panel body. When the
    // recompute was started from the ON-MAP button the panel is closed by
    // definition, so a denied permission, unreadable tiles and a disconnected
    // network were all indistinguishable from the button doing nothing.
    if (!panel || panel.classList.contains("hidden")) toast(msg, "error", 7000);
    recalcPending = false;
    syncRecalc();
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
    syncRecalc();
    if (body) body.innerHTML = `<div class="rt-msg">Reading roads from the pack&hellip;</div>`;
    try {
      const roadsFor = async (plan: (typeof plans)[number]) =>
        // Not cached by zoom any more. The old loop visited every plan twice
        // (all zooms strict, then all zooms loose) so a cache paid for itself;
        // this one visits each plan once, so the map only ever pinned up to
        // five zooms' worth of decoded geometry — MAX_TILES tiles each — live
        // at once on a phone, for no hit.
        loadRoads(deps.sourceUrl(), plan, (d, t) => {
          if (body) body.innerHTML = `<div class="rt-msg">Reading roads&hellip; ${d}/${t} tiles</div>`;
        });

      let best: { r: RouteResult; plan: (typeof plans)[number]; missing: number; approx: boolean } | null = null;
      // Finest zoom first, and at each zoom the stitch distance that zoom's
      // tiles actually need. Only if a zoom cannot produce a route at all do we
      // try a looser pass over the same, already-loaded segments — a route that
      // needed loose bridging is marked `approx` because loose bridging can join
      // roads that do not meet on the ground.
      outer: for (const plan of plans) {
        const { segs, missing } = await roadsFor(plan);
        if (!segs.length) continue;
        if (body) body.innerHTML = `<div class="rt-msg">Working out the way&hellip;</div>`;
        const tight = stitchFor(plan.z);
        for (const stitch of [tight, tight * 4]) {
          const graph = buildRouteGraph(segs, { stitchMeters: stitch });
          const r = findRoute(graph, [from.lng, from.lat], [to.lng, to.lat], { snapMeters: 2000 });
          if (r) {
            best = { r, plan, missing, approx: stitch !== tight };
            break outer;
          }
        }
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
      draw(best.r.coords, best.plan.z < 14);
      fit(best.r.coords);
      shown = next;
      syncRecalc();
      save(next);
      renderResult(next);
    } catch (err) {
      fail(`Couldn't build the route: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
      syncRecalc();
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

  /** Set `from` to the current fix, then continue — or explain why not.
   *  Via geoloc.ts, so on a phone it's the native, single-prompt path. */
  function useMyLocation(then: () => void, opts?: { orCrosshair?: boolean }) {
    if (body) body.innerHTML = `<div class="rt-msg">Getting your location…</div>`;
    void getFix().then(
      (f) => {
        from = { lng: f.lng, lat: f.lat, label: "my location" };
        recalcPending = false; // `busy` takes over from here
        then();
      },
      (err) => {
        // Never leave this silent: the user is waiting on a fix that isn't coming.
        const msg = err instanceof Error ? err.message : String(err);
        const denied = /denied/i.test(msg);
        if (opts?.orCrosshair) {
          // No fix, but the map still has a point: route from the crosshair
          // rather than refusing. Indoors, under canopy, or with location off,
          // a route from the middle of the screen is the answer you wanted —
          // and the crosshair is already what every other readout in this app
          // measures from.
          //
          // SAID OUT LOUD, always. Quietly starting somewhere other than where
          // the user is standing is the one way this could get someone hurt, so
          // the start point is renamed too: it reads "the crosshair" wherever
          // the route is described, not "my location".
          const c = deps.map().getCenter();
          from = { lng: c.lng, lat: c.lat, label: CROSSHAIR_LABEL };
          toast(
            denied
              ? "No location permission — routed from the crosshair, not from you."
              : "Couldn't get a GPS fix — routed from the crosshair, not from you.",
            "info",
            8000
          );
          recalcPending = false;
          then();
          return;
        }
        fail(
          denied
            ? "Location permission denied — use the map point instead."
            : "Couldn't get a location fix — use the map point instead."
        );
      }
    );
  }

  function wire() {
    // The two endpoint slots each open the unified picker.
    document.getElementById("rt-set-from")?.addEventListener("click", () =>
      renderEndpointPicker("from")
    );
    document.getElementById("rt-set-to")?.addEventListener("click", () =>
      renderEndpointPicker("to")
    );
    document.getElementById("rt-swap")?.addEventListener("click", () => {
      [from, to] = [to, from];
      renderIdle();
    });
    // Recompute from where you are now. The route is a one-shot overview, not
    // live navigation — this is the deliberate manual equivalent, so a stale
    // line is only ever replaced when you ask for it.
    document.getElementById("rt-refresh")?.addEventListener("click", () =>
      useMyLocation(() => void go())
    );
    document.getElementById("rt-clear")?.addEventListener("click", () => {
      from = to = null;
      shown = null;
      syncRecalc();
      try {
        localStorage.removeItem(SAVE_KEY);
      } catch {
        /* storage unavailable — the in-memory clear is what matters */
      }
      clearRoute();
      renderIdle();
    });
    // Re-read pins on the way back: one may have been dropped since the panel
    // opened. Render immediately so the click always responds.
    document.getElementById("rt-again")?.addEventListener("click", () => {
      renderIdle();
      void refreshPins().then(() => {
        if (!body?.querySelector("#rt-go")) return; // moved on since
        renderIdle();
      });
    });
    document.getElementById("rt-go")?.addEventListener("click", () => void go());
  }

  document.getElementById("route-open")?.addEventListener("click", async () => {
    panel?.classList.remove("hidden");
    // Restore the last working route, including across a restart or a crash.
    if (!shown) {
      const saved = loadSaved();
      if (saved) {
        shown = saved;
        syncRecalc();
        from = saved.from;
        to = saved.to;
      }
    }
    if (shown) {
      draw(shown.r.coords, shown.z < 14);
      renderResult(shown);
    }
    // Load pins BEFORE the first idle paint. Rendering first and refreshing
    // after meant the panel opened claiming there were no saved pins.
    await refreshPins();
    if (!shown) renderIdle();
  });
  document.getElementById("route-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });

  /**
   * Route to somewhere chosen elsewhere in the app — currently a teammate on
   * the mesh.
   *
   * The start point is left alone deliberately. A teammate's position is a
   * destination, and quietly overwriting the start with your location would
   * discard a start you had set on purpose. If nothing is set, your location
   * is the sensible assumption and is fetched; otherwise the route is computed
   * straight away.
   */
  function routeTo(lng: number, lat: number, label: string) {
    to = { lng, lat, label };
    panel?.classList.remove("hidden");
    if (from) {
      void go();
    } else {
      renderIdle(`Routing to ${label} — getting your location…`);
      useMyLocation(() => void go());
    }
  }

  // Style rebuilds (theme/terrain/pack switches) drop custom sources. Every
  // other overlay redraws itself here; route did not, so toggling the theme
  // erased the line while the panel still showed its distance and steps.
  deps.map().on("style.load", () => {
    if (!shown || deps.map().getSource(SRC)) return;
    draw(shown.r.coords, shown.z < 14);
  });

  return { routeTo };
}
