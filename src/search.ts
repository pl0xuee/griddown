import maplibregl from "maplibre-gl";
import { PMTiles } from "pmtiles";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { toast } from "./toast";
import { parseCoord, clearGotoPin } from "./goto";
import { loadMarks, type Waypoint } from "./store";
import { esc } from "./esc";

// Offline place search. There's no name database anywhere — the towns are
// already in the map pack's low-zoom `places` tiles, so we decode those once
// per pack (a few hundred small tiles) and search the result in memory.
// Fully offline; works in every downloaded state.

interface Place {
  name: string;
  kind: string; // locality / region / county …
  detail: string; // city / town / village / hamlet
  pop: number;
  lng: number;
  lat: number;
}

const KIND_ZOOM: Record<string, number> = {
  region: 7,
  county: 9,
  locality: 12,
  water: 12,
};

// Named water worth putting in Find. Streams/creeks live only in high-zoom
// tiles the index never reads, so this catches the lakes, reservoirs and rivers
// big enough to have a name by the zooms we do read — which is what you search
// for. Small creeks are found by tapping the Fishing layer, not by name.
const WATER_FIND_KINDS = new Set(["lake", "reservoir", "water", "river"]);

let index: Place[] | null = null;
let indexedUrl = "";
let building = false;

/** Drop the cached place index — call after a pack is re-downloaded, since the
 *  URL is unchanged but the bytes (and place set) may have changed. */
export function resetPlaceIndex() { index = null; indexedUrl = ""; }

function tile2lng(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}
function tile2lat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

async function buildIndex(
  url: string,
  onProgress: (done: number, total: number) => void
): Promise<Place[]> {
  const pm = new PMTiles(url);
  const header = await pm.getHeader();
  const west = header.minLon, south = header.minLat;
  const east = header.maxLon, north = header.maxLat;
  // Low-zoom tiles cover far more than the pack's bbox (a z1 tile is a quarter
  // of the planet), so they contain places you have no map for. Only index
  // what's inside the downloaded area (with a small margin for edge towns).
  const M = 0.05;
  const inPack = (lng: number, lat: number) =>
    lng >= west - M && lng <= east + M && lat >= south - M && lat <= north + M;

  // Places live in low-zoom tiles. Go as deep as z10 (villages/hamlets show
  // up by then) but cap the tile count so a huge pack can't take forever.
  const jobs: { z: number; x: number; y: number }[] = [];
  for (let z = Math.max(1, header.minZoom); z <= Math.min(10, header.maxZoom); z++) {
    const n = 2 ** z;
    const x0 = Math.floor(((west + 180) / 360) * n);
    const x1 = Math.floor(((east + 180) / 360) * n);
    const lat2y = (lat: number) => {
      const r = (lat * Math.PI) / 180;
      return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    };
    const y0 = lat2y(north), y1 = lat2y(south);
    for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) {
      for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) {
        jobs.push({ z, x, y });
      }
    }
    if (jobs.length > 900) break; // enough coverage; stop before it hurts
  }

  const seen = new Map<string, Place>();
  let done = 0;
  const CONCURRENCY = 12;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, w) => {
      for (let i = w; i < jobs.length; i += CONCURRENCY) {
        const { z, x, y } = jobs[i];
        try {
          const t = await pm.getZxy(z, x, y);
          if (t?.data) {
            const vt = new VectorTile(new PbfReader(new Uint8Array(t.data)));
            const layer = vt.layers["places"];
            for (let f = 0; layer && f < layer.length; f++) {
              const feat = layer.feature(f);
              const props: any = feat.properties;
              const name = props["name:en"] || props.name;
              const kind = String(props.kind ?? "");
              if (!name || kind === "country") continue;
              const g = feat.loadGeometry()[0]?.[0];
              if (!g) continue;
              const lng = tile2lng(x + g.x / feat.extent, z);
              const lat = tile2lat(y + g.y / feat.extent, z);
              if (!inPack(lng, lat)) continue;
              const key = `${name}|${kind}|${Math.round(lng * 50)}|${Math.round(lat * 50)}`;
              if (!seen.has(key)) {
                seen.set(key, {
                  name: String(name),
                  kind,
                  detail: String(props.kind_detail ?? ""),
                  pop: Number(props.population ?? 0),
                  lng,
                  lat,
                });
              }
            }

            // Named water bodies, from the same tiles — so lakes and rivers are
            // findable by name alongside towns. A water feature is a polygon or
            // line, so its point is the mean of its vertices (centre of a lake,
            // a point along a river). Deduped to ~1° so a lake split across
            // tiles collapses to one entry while two distant same-named lakes
            // stay apart.
            const wlayer = vt.layers["water"];
            for (let f = 0; wlayer && f < wlayer.length; f++) {
              const feat = wlayer.feature(f);
              const props: any = feat.properties;
              const name = props["name:en"] || props.name;
              const wkind = String(props.kind ?? "");
              if (!name || !WATER_FIND_KINDS.has(wkind)) continue;
              let sx = 0, sy = 0, n = 0;
              for (const ring of feat.loadGeometry())
                for (const pt of ring) { sx += pt.x; sy += pt.y; n++; }
              if (!n) continue;
              const lng = tile2lng(x + sx / n / feat.extent, z);
              const lat = tile2lat(y + sy / n / feat.extent, z);
              if (!inPack(lng, lat)) continue;
              const key = `w|${name}|${wkind}|${Math.round(lng)}|${Math.round(lat)}`;
              if (!seen.has(key)) {
                seen.set(key, {
                  name: String(name),
                  kind: "water",
                  detail: wkind,
                  pop: 0,
                  lng,
                  lat,
                });
              }
            }
          }
        } catch {
          /* a missing tile is fine — sparse areas */
        }
        done++;
        if (done % 40 === 0 || done === jobs.length) onProgress(done, jobs.length);
      }
    })
  );
  return [...seen.values()];
}

/**
 * Build (or reuse) the place index for a pack, and return it. Shared by Find
 * and by Get-there, so a state's places are read from its tiles once and both
 * features search the same in-memory list.
 *
 * Cached by url: the second caller for the same pack gets it instantly, and
 * switching packs rebuilds. A concurrent second caller waits out the first
 * rather than reading every tile twice.
 */
export async function ensurePlaceIndex(
  url: string,
  onProgress?: (done: number, total: number) => void
): Promise<Place[]> {
  if (index && indexedUrl === url) return index;
  while (building) {
    await new Promise((r) => setTimeout(r, 50));
    if (index && indexedUrl === url) return index;
  }
  building = true;
  // Drop the previous pack's index now, before the (async) rebuild, so nothing
  // reads the old state's place names or counts while this runs — otherwise a
  // Find opened right after a pack switch shows the previous state's towns and
  // flies to coordinates outside the new pack.
  index = null;
  indexedUrl = "";
  try {
    const built = await buildIndex(url, (d, t) => onProgress?.(d, t));
    index = built;
    indexedUrl = url;
    return built;
  } finally {
    building = false;
  }
}

/** Rank matches: prefix > substring, then population, then shorter names. */
export function rankMatches(places: Place[], q: string, limit = 20): Place[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const scored: { p: Place; s: number }[] = [];
  for (const p of places) {
    const hay = p.name.toLowerCase();
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    const prefix = at === 0 ? 2 : hay[at - 1] === " " ? 1 : 0;
    scored.push({ p, s: prefix * 1e12 + Math.min(p.pop, 1e9) * 1e2 - p.name.length });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.p);
}

/**
 * Rank saved pins against a query.
 *
 * Separate from rankMatches because pins have no population to sort by, and
 * because the tie-breaks differ: the most recently dropped pin is usually the
 * one being looked for, since you drop a pin for something you are about to
 * act on. Notes are searched too — "water" finds a pin named "spring" whose
 * note mentions water, which is exactly what a note is for.
 */
export function rankPins(pins: Waypoint[], q: string, limit = 8): Waypoint[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const scored: { p: Waypoint; s: number }[] = [];
  for (const p of pins) {
    const name = (p.name || "").toLowerCase();
    const at = name.indexOf(needle);
    const inNote = (p.note || "").toLowerCase().includes(needle);
    if (at < 0 && !inNote) continue;
    // Name beats note; start-of-name beats mid-word; then most recent first.
    const prefix = at === 0 ? 3 : at > 0 && name[at - 1] === " " ? 2 : at > 0 ? 1 : 0;
    scored.push({ p, s: prefix * 1e14 + (p.t || 0) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.p);
}

export type { Place };

export function initSearch(deps: {
  map: () => maplibregl.Map;
  /** Current pmtiles URL WITHOUT the pmtiles:// prefix. */
  sourceUrl: () => string;
  /** Drop the go-to pin at a spot (reuses the goto marker). */
  dropPin: (lng: number, lat: number) => void;
  /** Called after the map is moved to a result, to reveal it (peek the sheet). */
  onJump?: () => void;
}) {
  const panel = document.getElementById("search-panel");
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  // Your own pins, refreshed whenever the panel opens: they change far more
  // often than the place index, which is baked into the pack.
  let pins: Waypoint[] = [];
  const results = document.getElementById("search-results");

  function show(html: string) {
    if (results) results.innerHTML = html;
  }

  async function ensureIndex() {
    const url = deps.sourceUrl();
    if (index && indexedUrl === url) return;
    // Don't paint "Reading…" over the pin list — pins load faster than the
    // index and are what the user can act on meanwhile.
    if (!pins.length) show(`<div class="search-empty">Reading place names from the map pack…</div>`);
    try {
      const built = await ensurePlaceIndex(url, (d, t) => {
        // Only while the results area has nothing better in it. Pins and
        // coordinates render before the index exists, and blatting progress
        // over them every 40 tiles took away results the user was mid-read of.
        if (input?.value.trim() || pins.length) return;
        show(`<div class="search-empty">Reading place names… ${d}/${t} tiles</div>`);
      });
      void built;
      // Re-render whatever's current (a query, or the empty state with pins),
      // now that the place index exists.
      render(input?.value || "");
    } catch (e) {
      show(`<div class="search-empty">Couldn't read this map pack: ${e}</div>`);
    }
  }

  function label(p: Place): string {
    if (p.kind === "region") return "state";
    if (p.kind === "county") return "county";
    if (p.kind === "water")
      return p.detail === "river" ? "river" : p.detail === "reservoir" ? "reservoir" : "lake";
    return p.detail || "place";
  }

  /** Fly to a coordinate and pin it — what the old "Go to" box did. */
  function goToCoord(lng: number, lat: number) {
    deps.map().flyTo({ center: [lng, lat], zoom: Math.max(deps.map().getZoom(), 13) });
    deps.dropPin(lng, lat);
    panel?.classList.add("hidden");
    deps.onJump?.();
    toast(`Pin dropped at ${lat.toFixed(5)}, ${lng.toFixed(5)}`, "success");
  }

  /** Fly to one of the user's saved pins and re-drop its marker. Shared by the
   *  typed-match results and the browsable pin list shown on an empty query. */
  function jumpToPin(p: Waypoint) {
    deps.map().flyTo({ center: [p.lng, p.lat], zoom: Math.max(deps.map().getZoom(), 14) });
    deps.dropPin(p.lng, p.lat);
    panel?.classList.add("hidden");
    deps.onJump?.();
    toast(p.note ? `${p.name} — ${p.note}` : p.name, "success");
  }

  function pinButton(p: Waypoint, attr: string, i: number): string {
    return `<button class="search-hit" ${attr}="${i}">
        <span class="sh-name">${esc(p.name)}</span>
        <span class="sh-kind sh-pin">your pin</span>
      </button>`;
  }

  function render(q: string) {
    // A grid reference is offered before any name matching, and without needing
    // the place index — so a coordinate still works while the pack is loading,
    // or in a pack with no place names at all. One box, either kind of input:
    // in the field you should not have to know which control you need before
    // you look at what you were handed.
    const coord = parseCoord(q);
    if (coord) {
      show(`<button class="search-hit" id="search-coord">
          <span class="sh-name">${esc(coord[1].toFixed(5))}, ${esc(coord[0].toFixed(5))}</span>
          <span class="sh-kind">grid ref</span>
        </button>`);
      document
        .getElementById("search-coord")
        ?.addEventListener("click", () => goToCoord(coord[0], coord[1]));
      return;
    }
    // Your own pins first, and without waiting for the place index. They are
    // the places you cared enough to mark, so they outrank any town — and a
    // pack still building its index must not hide them.
    const pinHits = rankPins(pins, q);
    const pinHtml = pinHits.map((p, i) => pinButton(p, "data-pin", i)).join("");

    const bindPins = () => {
      results?.querySelectorAll<HTMLElement>("[data-pin]").forEach((el) => {
        el.addEventListener("click", () => jumpToPin(pinHits[Number(el.dataset.pin)]));
      });
    };

    if (!q.trim()) {
      // Nothing typed yet: list the user's pins so they're one tap away — the
      // places you marked are the ones you're most likely reaching for. Most
      // recent first, since a pin is usually dropped for something imminent.
      const recent = [...pins].sort((a, b) => (b.t || 0) - (a.t || 0));
      const hint = index
        ? `<div class="search-empty">${index.length} places known here. Type a name${
            recent.length ? ", or tap a pin below" : ""
          }.</div>`
        : `<div class="search-empty">Type to search${recent.length ? ", or tap a pin below" : ""}.</div>`;
      show(hint + recent.map((p, i) => pinButton(p, "data-allpin", i)).join(""));
      results?.querySelectorAll<HTMLElement>("[data-allpin]").forEach((el) => {
        el.addEventListener("click", () => jumpToPin(recent[Number(el.dataset.allpin)]));
      });
      return;
    }
    if (!index) {
      // Index still building: show what we can rather than nothing.
      if (pinHtml) {
        show(pinHtml);
        bindPins();
      }
      return;
    }
    const hits = rankMatches(index, q);
    if (!hits.length && !pinHits.length) {
      show(`<div class="search-empty">Nothing matches "${esc(q)}".</div>`);
      return;
    }
    show(
      pinHtml +
        hits
          .map(
            (p, i) => `<button class="search-hit" data-hit="${i}">
            <span class="sh-name">${esc(p.name)}</span>
            <span class="sh-kind">${esc(label(p))}</span>
          </button>`
          )
          .join("")
    );
    bindPins();
    results?.querySelectorAll<HTMLElement>("[data-hit]").forEach((el) => {
      el.addEventListener("click", () => {
        const p = hits[Number(el.dataset.hit)];
        deps.map().flyTo({ center: [p.lng, p.lat], zoom: KIND_ZOOM[p.kind] ?? 12 });
        deps.dropPin(p.lng, p.lat);
        panel?.classList.add("hidden");
        deps.onJump?.();
        toast(`${p.name} — pin dropped`, "success");
      });
    });
  }

  document.getElementById("search-open")?.addEventListener("click", () => {
    panel?.classList.remove("hidden");
    input?.focus();
    void ensureIndex();
    // Marks are read fresh each time: one may have been dropped since.
    void loadMarks()
      .then((m) => {
        pins = m.waypoints ?? [];
        // Render now so pins show immediately on open, even with an empty box.
        render(input?.value || "");
      })
      .catch(() => {
        /* pins are a bonus here; the place index still works without them */
      });
  });
  document.getElementById("search-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });
  input?.addEventListener("input", () => render(input.value));
  input?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const coord = parseCoord(input.value);
    if (coord) goToCoord(coord[0], coord[1]);
  });
  document.getElementById("search-clear-pin")?.addEventListener("click", () => {
    clearGotoPin();
    toast("Pin cleared", "info");
  });
}
