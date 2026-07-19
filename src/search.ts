import maplibregl from "maplibre-gl";
import { PMTiles } from "pmtiles";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { toast } from "./toast";
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
};

let index: Place[] | null = null;
let indexedUrl = "";
let building = false;

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

export type { Place };

export function initSearch(deps: {
  map: () => maplibregl.Map;
  /** Current pmtiles URL WITHOUT the pmtiles:// prefix. */
  sourceUrl: () => string;
  /** Drop the go-to pin at a spot (reuses the goto marker). */
  dropPin: (lng: number, lat: number) => void;
}) {
  const panel = document.getElementById("search-panel");
  const input = document.getElementById("search-input") as HTMLInputElement | null;
  const results = document.getElementById("search-results");

  function show(html: string) {
    if (results) results.innerHTML = html;
  }

  async function ensureIndex() {
    const url = deps.sourceUrl();
    if (index && indexedUrl === url) return;
    if (building) return;
    building = true;
    index = null;
    show(`<div class="search-empty">Reading place names from the map pack…</div>`);
    try {
      index = await buildIndex(url, (d, t) => {
        show(`<div class="search-empty">Reading place names… ${d}/${t} tiles</div>`);
      });
      indexedUrl = url;
      show(`<div class="search-empty">${index.length} places known here. Type to search.</div>`);
      if (input?.value) render(input.value);
    } catch (e) {
      show(`<div class="search-empty">Couldn't read this map pack: ${e}</div>`);
    } finally {
      building = false;
    }
  }

  function label(p: Place): string {
    if (p.kind === "region") return "state";
    if (p.kind === "county") return "county";
    return p.detail || "place";
  }

  function render(q: string) {
    if (!index) return;
    const hits = rankMatches(index, q);
    if (!q.trim()) {
      show(`<div class="search-empty">${index.length} places known here. Type to search.</div>`);
      return;
    }
    if (!hits.length) {
      show(`<div class="search-empty">No places match "${esc(q)}".</div>`);
      return;
    }
    show(
      hits
        .map(
          (p, i) => `<button class="search-hit" data-hit="${i}">
            <span class="sh-name">${esc(p.name)}</span>
            <span class="sh-kind">${esc(label(p))}</span>
          </button>`
        )
        .join("")
    );
    results?.querySelectorAll<HTMLElement>("[data-hit]").forEach((el) => {
      el.addEventListener("click", () => {
        const p = hits[Number(el.dataset.hit)];
        deps.map().flyTo({ center: [p.lng, p.lat], zoom: KIND_ZOOM[p.kind] ?? 12 });
        deps.dropPin(p.lng, p.lat);
        panel?.classList.add("hidden");
        toast(`${p.name} — pin dropped`, "success");
      });
    });
  }

  document.getElementById("search-open")?.addEventListener("click", () => {
    panel?.classList.remove("hidden");
    input?.focus();
    void ensureIndex();
  });
  document.getElementById("search-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });
  input?.addEventListener("input", () => render(input.value));
}
