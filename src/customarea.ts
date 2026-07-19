import maplibregl from "maplibre-gl";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "./toast";
import { esc } from "./esc";

// Download just the area you care about, instead of a whole state.
//
// A state pack is 0.5-1.5 GB; the hundred miles around a trailhead might be 30.
// It also solves the border problem — a trip along a state line otherwise means
// two full packs. The backend machinery is the same `pmtiles extract --bbox`
// that state downloads already use, so this is a different bbox, not a
// different mechanism.

const SRC = "gd-area";
const FILL = "gd-area-fill";
const LINE = "gd-area-line";

type LL = [number, number];

export interface CustomArea {
  abbr: string;
  name: string;
  bbox: [number, number, number, number];
  center: [number, number];
  estMB: number;
  custom: true;
}

/** A short, filesystem-safe id derived from the name, unique against existing. */
export function areaId(name: string, taken: ReadonlyArray<string>): string {
  const base =
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 16) || "AREA";
  // Never collide with an existing pack: that would overwrite it on disk.
  let id = base;
  let n = 2;
  while (taken.includes(id)) id = `${base}_${n++}`;
  return id;
}

/** Normalised bbox from two opposite corners: [west, south, east, north]. */
export function bboxFrom(a: LL, b: LL): [number, number, number, number] {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
  ];
}

/** Rough area in square miles — for warning about absurdly large boxes. */
export function bboxSqMi(bbox: [number, number, number, number]): number {
  const [w, s, e, n] = bbox;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const miPerDegLat = 69.05;
  const miPerDegLng = 69.17 * Math.cos(midLat);
  return Math.abs((e - w) * miPerDegLng) * Math.abs((n - s) * miPerDegLat);
}

export function initCustomArea(deps: {
  map: () => maplibregl.Map;
  /** Abbreviations already in use — new areas must not collide. */
  takenIds: () => string[];
  /** Persist the area and kick off its download. */
  onCreate: (area: CustomArea) => void;
}) {
  const panel = document.getElementById("area-panel");
  const body = document.getElementById("area-body");
  let corners: LL[] = [];
  let picking = false;
  let estimating = false;

  function clearBox() {
    const map = deps.map();
    for (const id of [FILL, LINE]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(SRC)) map.removeSource(SRC);
  }

  function drawBox() {
    if (corners.length !== 2) return;
    const [w, s, e, n] = bboxFrom(corners[0], corners[1]);
    const map = deps.map();
    const data: any = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
      },
    };
    const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(data);
      return;
    }
    map.addSource(SRC, { type: "geojson", data });
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    map.addLayer(
      {
        id: FILL, type: "fill", source: SRC,
        paint: { "fill-color": "#4fc3ff", "fill-opacity": 0.12 },
      },
      firstSymbol
    );
    map.addLayer(
      {
        id: LINE, type: "line", source: SRC,
        paint: { "line-color": "#4fc3ff", "line-width": 2, "line-dasharray": [2, 1.5] },
      },
      firstSymbol
    );
  }

  function onMapClick(e: maplibregl.MapMouseEvent) {
    if (!picking) return;
    const p: LL = [+e.lngLat.lng.toFixed(5), +e.lngLat.lat.toFixed(5)];
    if (corners.length >= 2) corners = [];
    corners.push(p);
    if (corners.length === 2) {
      picking = false;
      deps.map().getCanvas().style.cursor = "";
      drawBox();
      void estimate();
    }
    render();
  }

  let estMB: number | null = null;
  let estError = "";

  async function estimate() {
    if (corners.length !== 2) return;
    estMB = null;
    estError = "";
    estimating = true;
    render();
    try {
      // Ask the map server what this would actually weigh. A box drawn casually
      // across three states is gigabytes, and learning that after committing to
      // the download is a poor way to find out.
      estMB = await invoke<number>("estimate_extract_mb", {
        bbox: bboxFrom(corners[0], corners[1]).join(","),
        maxzoom: 15,
      });
    } catch (err) {
      estError = String(err);
    } finally {
      estimating = false;
      render();
    }
  }

  function render() {
    if (!body) return;
    const has = corners.length === 2;
    const bbox = has ? bboxFrom(corners[0], corners[1]) : null;
    const sqmi = bbox ? Math.round(bboxSqMi(bbox)) : 0;

    let sizeLine = "";
    if (has) {
      if (estimating) sizeLine = `<div class="ar-msg">Checking the download size…</div>`;
      else if (estMB != null) {
        const big = estMB > 2000;
        sizeLine = `<div class="ar-size ${big ? "ar-big" : ""}">${
          estMB >= 1000 ? `${(estMB / 1000).toFixed(1)} GB` : `${estMB} MB`
        }<span class="ar-sub"> to download · ${sqmi.toLocaleString()} sq mi</span></div>${
          big
            ? `<div class="ar-warn">⚠ That's a very large area. Consider drawing a smaller box, or downloading the whole state instead.</div>`
            : ""
        }`;
      } else if (estError) {
        // Don't block the download on a failed estimate — say so and let them
        // decide, rather than pretending the area can't be downloaded.
        sizeLine = `<div class="ar-warn">Couldn't check the size (${esc(
          estError
        )}). You can still download it.</div>`;
      }
    }

    body.innerHTML = `
      <div class="ar-step">${
        has
          ? `Corner 1: ${corners[0][1].toFixed(4)}, ${corners[0][0].toFixed(4)}<br>Corner 2: ${corners[1][1].toFixed(4)}, ${corners[1][0].toFixed(4)}`
          : picking
            ? corners.length === 1
              ? "Now tap the <b>opposite corner</b>."
              : "Tap <b>one corner</b> of the area on the map."
            : "Pick two opposite corners on the map to mark the area you want."
      }</div>
      ${sizeLine}
      ${
        has
          ? `<label class="ar-label">Name this area
               <input id="ar-name" type="text" maxlength="40" placeholder="e.g. Mt Hood area" />
             </label>`
          : ""
      }
      <div class="ar-btns">
        <button id="ar-pick" type="button">${
          picking ? "Tap the map…" : has ? "Redraw box" : "Pick corners"
        }</button>
        <button id="ar-clear" type="button">Clear</button>
      </div>
      ${has ? `<button id="ar-go" type="button" class="ar-go">Download this area</button>` : ""}
      <div class="ar-fine">Downloads only the map inside the box — roads, trails and
      labels. Terrain is a separate download from the pack's row afterwards.</div>`;
    wire();
  }

  function wire() {
    document.getElementById("ar-pick")?.addEventListener("click", () => {
      picking = true;
      corners = [];
      estMB = null;
      clearBox();
      deps.map().getCanvas().style.cursor = "crosshair";
      render();
    });
    document.getElementById("ar-clear")?.addEventListener("click", () => {
      picking = false;
      corners = [];
      estMB = null;
      deps.map().getCanvas().style.cursor = "";
      clearBox();
      render();
    });
    document.getElementById("ar-go")?.addEventListener("click", () => {
      if (corners.length !== 2) return;
      const input = document.getElementById("ar-name") as HTMLInputElement | null;
      const name = (input?.value || "").trim();
      if (!name) {
        toast("Give the area a name first.", "error");
        input?.focus();
        return;
      }
      const bbox = bboxFrom(corners[0], corners[1]);
      const area: CustomArea = {
        abbr: areaId(name, deps.takenIds()),
        name,
        bbox,
        center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
        estMB: estMB ?? 0,
        custom: true,
      };
      clearBox();
      corners = [];
      estMB = null;
      panel?.classList.add("hidden");
      render();
      deps.onCreate(area);
    });
  }

  deps.map().on("click", onMapClick);

  document.getElementById("area-open")?.addEventListener("click", () => {
    render();
    panel?.classList.remove("hidden");
  });
  document.getElementById("area-close")?.addEventListener("click", () => {
    picking = false;
    deps.map().getCanvas().style.cursor = "";
    panel?.classList.add("hidden");
  });
}
