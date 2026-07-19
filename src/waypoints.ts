import maplibregl from "maplibre-gl";
import { toast } from "./toast";
import { buildGPX, parseGPX } from "./gpx";
import { loadMarks, normalize, saveMarks, type Pt, type Track, type Waypoint } from "./store";
import { BACKUP_KEY } from "./readiness";
import { saveFile } from "./save";

// Waypoints (dropped pins) and recorded GPS tracks. Persisted via ./store (a
// real file in the app data dir) and exchangeable as standard GPX. Fully offline.

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

/** Prompt for a file and hand back its text. Resolves null if cancelled. */
function pickFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ""));
      r.onerror = () => resolve(null);
      r.readAsText(f);
    });
    // No "cancel" event we can rely on across webviews; an abandoned picker
    // simply never resolves, which is harmless here.
    input.click();
  });
}

export async function initWaypoints(map: maplibregl.Map) {
  const initial = await loadMarks();
  let waypoints: Waypoint[] = initial.waypoints;
  let tracks: Track[] = initial.tracks;
  const markers = new Map<string, maplibregl.Marker>();

  let recording = false;
  let recPts: Pt[] = [];
  let watchId: number | null = null;

  // Persisting is async now, but callers are all UI handlers that don't need to
  // wait — surface a failure as a toast rather than swallowing it, since a
  // silent save failure is exactly the kind of thing this change exists to stop.
  const save = () => {
    void saveMarks({ waypoints, tracks }).catch(() =>
      toast("Couldn't save your marks to disk.", "error")
    );
  };
  const saveWp = save;
  const saveTr = save;

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
    void saveFile("griddown.gpx", buildGPX(waypoints, tracks), "application/gpx+xml");
  }

  async function importGPX() {
    const xml = await pickFile(".gpx,application/gpx+xml,text/xml");
    if (xml == null) return;
    let parsed;
    try {
      parsed = parseGPX(xml);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't read that GPX file.", "error");
      return;
    }
    if (!parsed.waypoints.length && !parsed.tracks.length) {
      toast("No waypoints or tracks found in that file.", "error");
      return;
    }
    // Merge, never replace — an import shouldn't be able to destroy what you
    // already have in the field.
    waypoints = waypoints.concat(parsed.waypoints);
    tracks = tracks.concat(parsed.tracks);
    save();
    refreshMarkers();
    ensureTrackLayer();
    renderList();
    toast(
      `Imported ${parsed.waypoints.length} pin(s) and ${parsed.tracks.length} track(s).`,
      "success"
    );
  }

  function backupAll() {
    if (waypoints.length === 0 && tracks.length === 0) {
      toast("Nothing to back up yet — drop a pin or record a track first.");
      return;
    }
    const payload = {
      app: "GridDown",
      kind: "marks-backup",
      version: 1,
      exported: new Date().toISOString(),
      settings: { ...localStorage },
      waypoints,
      tracks,
    };
    void saveFile(
      "griddown-backup.json",
      JSON.stringify(payload, null, 2),
      "application/json"
    ).then((path) => {
      // Only count it as a backup if it actually landed somewhere.
      if (path !== null || !("__TAURI_INTERNALS__" in window)) {
        localStorage.setItem(BACKUP_KEY, String(Date.now()));
      }
    });
  }

  async function restoreAll() {
    const text = await pickFile(".json,application/json");
    if (text == null) return;
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      toast("That file isn't valid JSON.", "error");
      return;
    }
    const restored = normalize(data);
    if (!restored.waypoints.length && !restored.tracks.length) {
      toast("No marks found in that backup.", "error");
      return;
    }
    // A restore replaces, so make the user say yes — with the counts, so they
    // can see they're not about to trade a full set for an empty one.
    const ok = confirm(
      `Replace your current ${waypoints.length} pin(s) and ${tracks.length} track(s) ` +
        `with ${restored.waypoints.length} pin(s) and ${restored.tracks.length} track(s) ` +
        `from this backup?`
    );
    if (!ok) return;
    waypoints = restored.waypoints;
    tracks = restored.tracks;
    save();
    refreshMarkers();
    ensureTrackLayer();
    renderList();
    toast("Backup restored.", "success");
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
  document.getElementById("marks-import")?.addEventListener("click", () => void importGPX());
  document.getElementById("marks-backup")?.addEventListener("click", backupAll);
  document.getElementById("marks-restore")?.addEventListener("click", () => void restoreAll());

  refreshMarkers();
  updateRecUi();
}
