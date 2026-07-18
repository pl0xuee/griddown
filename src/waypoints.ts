import maplibregl from "maplibre-gl";
import { toast } from "./toast";

// Waypoints (dropped pins) and recorded GPS tracks, stored locally and
// exportable as standard GPX. Fully offline.

interface Waypoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  note?: string;
  t: number;
}
type Pt = [number, number, number?]; // lng, lat, ele?
interface Track {
  id: string;
  name: string;
  pts: Pt[];
  t: number;
}

const WP_KEY = "griddown_waypoints";
const TR_KEY = "griddown_tracks";

function load<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}
function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildGPX(wps: Waypoint[], trks: Track[]): string {
  let s = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  s += `<gpx version="1.1" creator="GridDown" xmlns="http://www.topografix.com/GPX/1/1">\n`;
  for (const w of wps) {
    s += `  <wpt lat="${w.lat}" lon="${w.lng}"><name>${esc(w.name)}</name>`;
    if (w.note) s += `<desc>${esc(w.note)}</desc>`;
    s += `</wpt>\n`;
  }
  for (const t of trks) {
    s += `  <trk><name>${esc(t.name)}</name><trkseg>\n`;
    for (const p of t.pts) {
      s += `    <trkpt lat="${p[1]}" lon="${p[0]}">`;
      if (p[2] != null) s += `<ele>${p[2]}</ele>`;
      s += `</trkpt>\n`;
    }
    s += `  </trkseg></trk>\n`;
  }
  s += `</gpx>\n`;
  return s;
}

function download(name: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function initWaypoints(map: maplibregl.Map) {
  let waypoints: Waypoint[] = load<Waypoint>(WP_KEY);
  let tracks: Track[] = load<Track>(TR_KEY);
  const markers = new Map<string, maplibregl.Marker>();

  let recording = false;
  let recPts: Pt[] = [];
  let watchId: number | null = null;

  const saveWp = () => localStorage.setItem(WP_KEY, JSON.stringify(waypoints));
  const saveTr = () => localStorage.setItem(TR_KEY, JSON.stringify(tracks));

  // --- Waypoint markers (DOM markers survive setStyle) ---
  function addMarker(w: Waypoint) {
    const el = document.createElement("div");
    el.className = "wp-marker";
    el.title = w.name;
    const m = new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([w.lng, w.lat])
      .addTo(map);
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      map.flyTo({ center: [w.lng, w.lat], zoom: Math.max(map.getZoom(), 14) });
    });
    markers.set(w.id, m);
  }
  function refreshMarkers() {
    for (const m of markers.values()) m.remove();
    markers.clear();
    waypoints.forEach(addMarker);
  }

  // --- Track line layer (re-added whenever a new style loads) ---
  function trackGeoJSON(): any {
    const lines = tracks.map((t) => t.pts).concat(recording ? [recPts] : []);
    return {
      type: "FeatureCollection",
      features: lines
        .filter((pts) => pts.length > 1)
        .map((pts) => ({
          type: "Feature",
          geometry: { type: "LineString", coordinates: pts.map((p) => [p[0], p[1]]) },
          properties: {},
        })),
    };
  }
  function ensureTrackLayer() {
    const src = map.getSource("gd-track") as maplibregl.GeoJSONSource | undefined;
    if (!src) {
      map.addSource("gd-track", { type: "geojson", data: trackGeoJSON() });
      map.addLayer({
        id: "gd-track-line",
        type: "line",
        source: "gd-track",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ff5aa0", "line-width": 4, "line-opacity": 0.9 },
      });
    } else {
      src.setData(trackGeoJSON());
    }
  }
  map.on("style.load", ensureTrackLayer);
  if (map.isStyleLoaded()) ensureTrackLayer();

  // --- Actions ---
  function dropWaypoint() {
    const c = map.getCenter();
    const w: Waypoint = {
      id: rid(),
      name: `Waypoint ${waypoints.length + 1}`,
      lat: +c.lat.toFixed(6),
      lng: +c.lng.toFixed(6),
      t: Date.now(),
    };
    waypoints.push(w);
    saveWp();
    addMarker(w);
    renderList();
    toast(`Dropped ${w.name}`, "success");
  }

  function renameWp(id: string) {
    const w = waypoints.find((x) => x.id === id);
    if (!w) return;
    const name = prompt("Waypoint name:", w.name);
    if (name != null) {
      w.name = name.trim() || w.name;
      saveWp();
      markers.get(id)?.getElement().setAttribute("title", w.name);
      renderList();
    }
  }
  function deleteWp(id: string) {
    waypoints = waypoints.filter((x) => x.id !== id);
    markers.get(id)?.remove();
    markers.delete(id);
    saveWp();
    renderList();
  }
  function deleteTrack(id: string) {
    tracks = tracks.filter((x) => x.id !== id);
    saveTr();
    ensureTrackLayer();
    renderList();
  }

  function startRec() {
    if (!("geolocation" in navigator)) {
      toast("Location isn't available on this device.", "error");
      return;
    }
    recording = true;
    recPts = [];
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        recPts.push([
          p.coords.longitude,
          p.coords.latitude,
          p.coords.altitude ?? undefined,
        ]);
        ensureTrackLayer();
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
    updateRecUi();
  }
  function stopRec() {
    recording = false;
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (recPts.length > 1) {
      tracks.push({ id: rid(), name: `Track ${tracks.length + 1}`, pts: recPts, t: Date.now() });
      saveTr();
    }
    recPts = [];
    ensureTrackLayer();
    updateRecUi();
    renderList();
  }
  function updateRecUi() {
    const b = document.getElementById("marks-record");
    if (b) {
      b.textContent = recording ? "■ Stop recording" : "● Record track";
      b.classList.toggle("recording", recording);
    }
  }

  function exportGPX() {
    if (waypoints.length === 0 && tracks.length === 0) {
      toast("Nothing to export yet — drop a pin or record a track first.");
      return;
    }
    download("griddown.gpx", buildGPX(waypoints, tracks), "application/gpx+xml");
    toast("Exported griddown.gpx", "success");
  }

  // --- Panel list ---
  function renderList() {
    const el = document.getElementById("marks-content");
    if (!el) return;
    const wpRows = waypoints
      .map(
        (w) => `<div class="mk-row" data-wp="${w.id}">
          <div class="mk-info"><div class="mk-name">◉ ${esc(w.name)}</div>
          <div class="mk-sub">${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}</div></div>
          <button class="mk-btn" data-fly="${w.id}">Go</button>
          <button class="mk-btn" data-ren="${w.id}">✎</button>
          <button class="mk-del" data-delwp="${w.id}">🗑</button></div>`
      )
      .join("");
    const trRows = tracks
      .map(
        (t) => `<div class="mk-row">
          <div class="mk-info"><div class="mk-name">〜 ${esc(t.name)}</div>
          <div class="mk-sub">${t.pts.length} points</div></div>
          <button class="mk-del" data-deltr="${t.id}">🗑</button></div>`
      )
      .join("");
    el.innerHTML =
      `<div class="mk-group">Waypoints (${waypoints.length})</div>` +
      (wpRows || `<div class="mk-empty">No pins yet.</div>`) +
      `<div class="mk-group">Tracks (${tracks.length})</div>` +
      (trRows || `<div class="mk-empty">No tracks yet.</div>`);

    el.querySelectorAll<HTMLElement>("[data-fly]").forEach((b) =>
      b.addEventListener("click", () => {
        const w = waypoints.find((x) => x.id === b.dataset.fly);
        if (w) map.flyTo({ center: [w.lng, w.lat], zoom: Math.max(map.getZoom(), 14) });
      })
    );
    el.querySelectorAll<HTMLElement>("[data-ren]").forEach((b) =>
      b.addEventListener("click", () => renameWp(b.dataset.ren!))
    );
    el.querySelectorAll<HTMLElement>("[data-delwp]").forEach((b) =>
      b.addEventListener("click", () => deleteWp(b.dataset.delwp!))
    );
    el.querySelectorAll<HTMLElement>("[data-deltr]").forEach((b) =>
      b.addEventListener("click", () => deleteTrack(b.dataset.deltr!))
    );
  }

  // --- Wire up ---
  const panel = document.getElementById("marks-panel");
  document.getElementById("marks-open")?.addEventListener("click", () => {
    renderList();
    panel?.classList.remove("hidden");
  });
  document.getElementById("marks-close")?.addEventListener("click", () =>
    panel?.classList.add("hidden")
  );
  document.getElementById("marks-drop")?.addEventListener("click", dropWaypoint);
  document.getElementById("marks-record")?.addEventListener("click", () =>
    recording ? stopRec() : startRec()
  );
  document.getElementById("marks-export")?.addEventListener("click", exportGPX);

  refreshMarkers();
  updateRecUi();
}
