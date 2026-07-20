import maplibregl from "maplibre-gl";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "./toast";
import { esc } from "./esc";

// Motor Vehicle Use Map — where you may legally drive on Forest Service land.
//
// OpenStreetMap knows where most forest roads ARE. It does not reliably know
// which ones you are allowed to drive, in what, or in which months. The MVUM is
// the legal answer: the Forest Service publishes it under 36 CFR 212.56 and the
// printed booklets handed out at ranger stations are generated from it.
//
// Downloaded per pack (see download_mvum in lib.rs) and rendered from a local
// GeoJSON file, so it is as offline as everything else once it's on disk.
//
// It is deliberately NOT authoritative in the app's voice: the data carries a
// disclaimer that it is not a legal document, and a road's status can change
// between publications. The panel repeats that where it will be read.

const SRC = "gd-mvum";
const LAYER_LINE = "gd-mvum-line";
const LAYER_CASE = "gd-mvum-casing";
const LAYER_LABEL = "gd-mvum-label";

export const MVUM_KEY = "griddown_mvum";

/**
 * MVUM symbol codes → what they mean.
 *
 * These come straight from the published symbology: the same six road classes
 * and ten trail classes the paper maps use. Even codes are seasonal, odd are
 * yearlong, but that pattern is coincidence rather than contract — so they're
 * spelled out rather than computed.
 */
export interface MvumClass {
  label: string;
  color: string;
  seasonal: boolean;
}

export const MVUM_CLASSES: Record<string, MvumClass> = {
  "1": { label: "Open to all vehicles", color: "#4fc3ff", seasonal: false },
  "2": { label: "Open to all vehicles (seasonal)", color: "#4fc3ff", seasonal: true },
  "3": { label: "Highway-legal vehicles only", color: "#b388ff", seasonal: false },
  "4": { label: "Highway-legal vehicles only (seasonal)", color: "#b388ff", seasonal: true },
  "5": { label: "Trail, all vehicles", color: "#4fc3ff", seasonal: false },
  "6": { label: "Trail, all vehicles (seasonal)", color: "#4fc3ff", seasonal: true },
  "7": { label: "Trail, vehicles 50\" or less", color: "#ffd54f", seasonal: false },
  "8": { label: "Trail, vehicles 50\" or less (seasonal)", color: "#ffd54f", seasonal: true },
  "9": { label: "Trail, motorcycles only", color: "#ff8a65", seasonal: false },
  "10": { label: "Trail, motorcycles only (seasonal)", color: "#ff8a65", seasonal: true },
  "11": { label: "Special designation", color: "#f06292", seasonal: false },
  "12": { label: "Special designation (seasonal)", color: "#f06292", seasonal: true },
  "16": { label: "Trail, wheeled OHV under 50\"", color: "#ffd54f", seasonal: false },
  "17": { label: "Trail, wheeled OHV under 50\" (seasonal)", color: "#ffd54f", seasonal: true },
};

const UNKNOWN: MvumClass = { label: "Designated route", color: "#9e9e9e", seasonal: false };

export function mvumClass(symbol: unknown): MvumClass {
  return MVUM_CLASSES[String(symbol ?? "")] ?? UNKNOWN;
}

/** Vehicle-class columns, in the order a driver would ask about them. */
export const VEHICLES: ReadonlyArray<{ field: string; label: string }> = [
  { field: "passengervehicle", label: "Passenger car" },
  { field: "highclearancevehicle", label: "High-clearance" },
  { field: "motorhome", label: "Motorhome" },
  { field: "fourwd_gt50inches", label: "4WD over 50\"" },
  { field: "twowd_gt50inches", label: "2WD over 50\"" },
  { field: "atv", label: "ATV" },
  { field: "motorcycle", label: "Motorcycle" },
  { field: "otherwheeled_ohv", label: "Other wheeled OHV" },
  { field: "other_ohv_lt50inches", label: "OHV under 50\"" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "01/01-12/31" → "year-round"; "06/01-10/15" → "Jun 1 – Oct 15".
 *
 * The field is free text in practice, so anything unrecognised is passed
 * through as-is rather than dropped: a date range we can't parse is still
 * information, and inventing one would be worse than showing it raw.
 */
export function formatDates(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s === "01/01-12/31") return "year-round";
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})$/);
  if (!m) return s;
  const [, m1, d1, m2, d2] = m;
  // Half-formatting a nonsense range ("13/01" → "13/01 – Feb 2") dresses bad
  // data up as good. If either month is out of range, show the raw text.
  const named = (mm: string) => Number(mm) >= 1 && Number(mm) <= 12;
  if (!named(m1) || !named(m2)) return s;
  const fmt = (mm: string, dd: string) => `${MONTHS[Number(mm) - 1]} ${Number(dd)}`;
  return `${fmt(m1, d1)} – ${fmt(m2, d2)}`;
}

/**
 * Which vehicles this route is open to.
 *
 * The allow flags are `"open"`, null, `""` or `" "` — there is no "closed"
 * value, so absence means "not designated for this class", which legally means
 * you may not use it. Only an explicit "open" counts.
 */
export function vehicleAccess(
  props: Record<string, unknown>
): Array<{ label: string; dates: string }> {
  const out: Array<{ label: string; dates: string }> = [];
  for (const v of VEHICLES) {
    if (String(props[v.field] ?? "").trim().toLowerCase() !== "open") continue;
    out.push({ label: v.label, dates: formatDates(props[`${v.field}_datesopen`]) });
  }
  return out;
}

/** Colour expression driven by the symbol code, for MapLibre. */
export function colorExpression(): any {
  const match: any[] = ["match", ["to-string", ["get", "symbol"]]];
  for (const [code, cls] of Object.entries(MVUM_CLASSES)) match.push(code, cls.color);
  match.push(UNKNOWN.color);
  return match;
}

/** Seasonal routes are dashed — the same convention the paper maps use. */
export function seasonalCodes(): string[] {
  return Object.entries(MVUM_CLASSES)
    .filter(([, c]) => c.seasonal)
    .map(([code]) => code);
}

export function initMvum(deps: {
  map: () => maplibregl.Map;
  /** Abbreviation of the pack on screen, or "" when none. */
  activeAbbr: () => string;
}) {
  const btn = document.getElementById("mvum-toggle");
  const legend = document.querySelectorAll(".legend-row.mvum");
  let on = localStorage.getItem(MVUM_KEY) === "1";
  let data: any = null;
  let loadedFor = "";
  let popup: maplibregl.Popup | null = null;

  const inTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";

  function setLegend(visible: boolean) {
    legend.forEach((el) => el.classList.toggle("hidden", !visible));
  }

  function syncButton() {
    if (!btn) return;
    btn.classList.toggle("off", !on);
    btn.classList.toggle("on", on);
  }

  function removeLayers() {
    const map = deps.map();
    for (const id of [LAYER_LABEL, LAYER_LINE, LAYER_CASE]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(SRC)) map.removeSource(SRC);
    popup?.remove();
    popup = null;
  }

  function addLayers() {
    const map = deps.map();
    if (!data || map.getSource(SRC)) return;
    map.addSource(SRC, { type: "geojson", data });

    // Under labels so place names stay readable on top of the overlay.
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;

    map.addLayer(
      {
        id: LAYER_CASE,
        type: "line",
        source: SRC,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#0b0f0b",
          "line-opacity": 0.75,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 12, 5, 16, 9],
        },
      },
      firstSymbol
    );
    map.addLayer(
      {
        id: LAYER_LINE,
        type: "line",
        source: SRC,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": colorExpression(),
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1, 12, 2.4, 16, 5],
          "line-dasharray": [
            "case",
            ["in", ["to-string", ["get", "symbol"]], ["literal", seasonalCodes()]],
            ["literal", [3, 2]],
            ["literal", [1]],
          ],
        },
      },
      firstSymbol
    );
    map.addLayer(
      {
        id: LAYER_LABEL,
        type: "symbol",
        source: SRC,
        minzoom: 12,
        layout: {
          "symbol-placement": "line",
          "text-field": ["coalesce", ["get", "id"], ["get", "name"]],
          "text-size": 11,
          "text-font": ["Noto Sans Regular"],
        },
        paint: {
          "text-color": "#e8f4ff",
          "text-halo-color": "#0b0f0b",
          "text-halo-width": 1.6,
        },
      },
      firstSymbol
    );
  }

  async function load(abbr: string): Promise<boolean> {
    if (!abbr || !inTauri) return false;
    if (loadedFor === abbr && data) return true;
    try {
      const path = await invoke<string>("mvum_path", { abbr });
      const res = await fetch(convertFileSrc(path));
      if (!res.ok) return false;
      data = await res.json();
      loadedFor = abbr;
      return true;
    } catch {
      return false;
    }
  }

  function describe(f: maplibregl.MapGeoJSONFeature): string {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const cls = mvumClass(p.symbol);
    const vehicles = vehicleAccess(p);
    const name = String(p.name ?? "").trim();
    const id = String(p.id ?? "").trim();
    const title = [id, name].filter(Boolean).join(" · ") || "Forest route";

    const rows = vehicles.length
      ? vehicles
          .map(
            (v) =>
              `<div class="mv-veh"><span>${esc(v.label)}</span><b>${esc(
                v.dates || "open"
              )}</b></div>`
          )
          .join("")
      : `<div class="mv-none">No vehicle class is designated open here.</div>`;

    const extras = [
      p.surfacetype ? `Surface: ${esc(p.surfacetype)}` : "",
      p.operationalmaintlevel ? `Maintenance: ${esc(p.operationalmaintlevel)}` : "",
      p.trailclass ? `Trail class: ${esc(p.trailclass)}` : "",
      p.forestname ? esc(p.forestname) : "",
    ]
      .filter(Boolean)
      .join(" · ");

    return `<div class="mv-pop">
        <div class="mv-title">${esc(title)}</div>
        <div class="mv-class" style="color:${cls.color}">${esc(cls.label)}</div>
        ${rows}
        ${extras ? `<div class="mv-extra">${extras}</div>` : ""}
        <div class="mv-fine">USFS Motor Vehicle Use Map. Not a legal document —
        check the current MVUM with the ranger district before you drive.</div>
      </div>`;
  }

  function onClick(e: maplibregl.MapMouseEvent) {
    const map = deps.map();
    if (!map.getLayer(LAYER_LINE)) return;
    const hits = map.queryRenderedFeatures(
      [
        [e.point.x - 6, e.point.y - 6],
        [e.point.x + 6, e.point.y + 6],
      ],
      { layers: [LAYER_LINE] }
    );
    if (!hits.length) return;
    popup?.remove();
    popup = new maplibregl.Popup({ closeButton: true, maxWidth: "290px", className: "mv-popup" })
      .setLngLat(e.lngLat)
      .setHTML(describe(hits[0]))
      .addTo(map);
  }

  async function apply() {
    if (!on) {
      removeLayers();
      setLegend(false);
      return;
    }
    const abbr = deps.activeAbbr();
    const ok = await load(abbr);
    if (!ok) {
      on = false;
      syncButton();
      setLegend(false);
      toast(
        abbr
          ? "No Forest Service roads downloaded for this pack — add them from Map packs."
          : "Download a map pack first, then add its Forest Service roads.",
        "info",
        7000
      );
      return;
    }
    addLayers();
    setLegend(true);
  }

  btn?.addEventListener("click", () => {
    on = !on;
    localStorage.setItem(MVUM_KEY, on ? "1" : "0");
    syncButton();
    void apply();
  });

  deps.map().on("click", onClick);

  // A style rebuild (theme, terrain, pack switch) drops custom sources — put
  // them back, or the overlay silently vanishes with the button still lit.
  deps.map().on("style.load", () => {
    if (on) void apply();
  });

  syncButton();
  setLegend(false);
  if (on) void apply();

  /** Called when the active pack changes, so the overlay follows it. */
  return {
    packChanged() {
      data = null;
      loadedFor = "";
      removeLayers();
      if (on) void apply();
    },
  };
}
