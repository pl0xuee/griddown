import maplibregl from "maplibre-gl";
import { toast } from "./toast";
import { buildGPX, parseGPX } from "./gpx";
import { loadMarks, normalize, saveMarks, type Pt, type Track, type Waypoint } from "./store";
import { BACKUP_KEY, fmtAge } from "./readiness";
import { haversine } from "./geo";
import { saveFile } from "./save";
import { confirmAction, promptAction } from "./dialog";

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
  let recStart = 0;

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

  async function renameWp(id: string) {
    const w = waypoints.find((x) => x.id === id);
    if (!w) return;
    // Not window.prompt: WKWebView implements no text-input panel, so on iOS it
    // returned null immediately and renaming a pin silently did nothing.
    const name = await promptAction("Waypoint name:", { value: w.name });
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
    recStart = Date.now();
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        recPts.push([
          p.coords.longitude,
          p.coords.latitude,
          p.coords.altitude ?? undefined,
        ]);
        ensureTrackLayer();
        updateRecUi(); // keep the live distance/points/time honest
      },
      // Swallowing this left the button reading "■ Stop recording" while nothing
      // was ever captured — the user believes they're recording the route they
      // walked, and finds out only when the track isn't there afterwards.
      (err) => {
        const why =
          err.code === err.PERMISSION_DENIED
            ? "location permission denied"
            : err.code === err.POSITION_UNAVAILABLE
              ? "no position fix available"
              : "location timed out";
        if (recPts.length === 0) {
          toast(`Can't record a track — ${why}.`, "error", 6000);
          stopRec();
        } else {
          toast(`Track recording interrupted — ${why}.`, "error", 5000);
        }
      },
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
      toast(`Track saved — ${recPts.length} points.`, "success");
    } else if (recPts.length > 0) {
      // One point isn't a track, but discarding it without a word looks like
      // the recording simply vanished.
      toast("Not enough movement to save a track — nothing recorded.", "error");
    }
    recPts = [];
    ensureTrackLayer();
    updateRecUi();
    renderList();
  }
  /** Ground length of a track (or the in-progress one), in metres. */
  function trackMeters(pts: Pt[]): number {
    let m = 0;
    for (let i = 1; i < pts.length; i++) {
      m += haversine([pts[i - 1][0], pts[i - 1][1]], [pts[i][0], pts[i][1]]);
    }
    return m;
  }
  function fmtLen(m: number): string {
    const mi = m / 1609.344;
    if (mi < 0.1) return `${Math.round(m / 0.3048)} ft`;
    return `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  }
  function fmtDur(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  function updateRecUi() {
    const b = document.getElementById("marks-record");
    if (b) {
      b.textContent = recording ? "■ Stop recording" : "● Record track";
      b.classList.toggle("recording", recording);
    }
    // The status region below the buttons: what recording is, while idle;
    // a live readout while it runs. The panel can be closed and the recording
    // keeps going, so this says so — the button state alone is invisible then.
    const rec = document.getElementById("marks-rec");
    if (!rec) return;
    if (!recording) {
      rec.className = "mk-rec";
      rec.innerHTML =
        "<b>Record track</b> traces the path you walk or drive as a line on the map. " +
        "Tap it, move, then stop — it&rsquo;s saved to <b>Tracks</b> below, where you can view or export it.";
      return;
    }
    rec.className = "mk-rec on";
    if (!recPts.length) {
      rec.innerHTML =
        `<div class="mk-rec-live"><span class="mk-rec-dot">&#9679;</span> Recording &mdash; waiting for GPS…</div>` +
        `<div class="mk-rec-note">Keeps recording if you close this. Tap &#9632; Stop recording when you&rsquo;re done.</div>`;
      return;
    }
    const len = fmtLen(trackMeters(recPts));
    const dur = recStart ? ` &middot; ${fmtDur(Date.now() - recStart)}` : "";
    rec.innerHTML =
      `<div class="mk-rec-live"><span class="mk-rec-dot">&#9679;</span> Recording &mdash; <b>${len}</b> &middot; ${recPts.length} pts${dur}</div>` +
      `<div class="mk-rec-note">A blue line is growing on the map as you move. Keeps going if you close this; tap &#9632; Stop to save it to Tracks.</div>`;
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
    const ok = await confirmAction(
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
        (w) => `<div class="mk-row" data-wp="${esc(w.id)}">
          <div class="mk-info"><div class="mk-name">◉ ${esc(w.name)}</div>
          <div class="mk-sub">${w.lat.toFixed(4)}, ${w.lng.toFixed(4)}</div></div>
          <button class="mk-btn" data-fly="${esc(w.id)}">Go</button>
          <button class="mk-btn" data-ren="${esc(w.id)}">✎</button>
          <button class="mk-del" data-delwp="${esc(w.id)}">🗑</button></div>`
      )
      .join("");
    const trRows = tracks
      .map((t) => {
        const len = fmtLen(trackMeters(t.pts));
        const when = t.t ? ` · ${fmtAge(Math.floor((Date.now() - t.t) / 1000))}` : "";
        return `<div class="mk-row">
          <div class="mk-info"><div class="mk-name">〜 ${esc(t.name)}</div>
          <div class="mk-sub">${len} · ${t.pts.length} points${when}</div></div>
          <button class="mk-btn" data-flytr="${esc(t.id)}">View</button>
          <button class="mk-del" data-deltr="${esc(t.id)}">🗑</button></div>`;
      })
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
      b.addEventListener("click", () => void renameWp(b.dataset.ren!))
    );
    el.querySelectorAll<HTMLElement>("[data-delwp]").forEach((b) =>
      b.addEventListener("click", () => deleteWp(b.dataset.delwp!))
    );
    el.querySelectorAll<HTMLElement>("[data-deltr]").forEach((b) =>
      b.addEventListener("click", () => deleteTrack(b.dataset.deltr!))
    );
    el.querySelectorAll<HTMLElement>("[data-flytr]").forEach((b) =>
      b.addEventListener("click", () => {
        const t = tracks.find((x) => x.id === b.dataset.flytr);
        if (!t || !t.pts.length) return;
        // A one-point track (only reachable via an imported GPX) has zero-area
        // bounds, which fitBounds slams to max zoom. Fly to the point instead.
        if (t.pts.length === 1) {
          map.flyTo({ center: [t.pts[0][0], t.pts[0][1]], zoom: Math.max(map.getZoom(), 14) });
        } else {
          const bounds = new maplibregl.LngLatBounds(
            [t.pts[0][0], t.pts[0][1]],
            [t.pts[0][0], t.pts[0][1]]
          );
          for (const p of t.pts) bounds.extend([p[0], p[1]]);
          map.fitBounds(bounds, { padding: 60, duration: 600 });
        }
        // Close the panel so the framed track is actually visible.
        document.getElementById("marks-panel")?.classList.add("hidden");
      })
    );
  }

  // --- Wire up ---
  const panel = document.getElementById("marks-panel");
  document.getElementById("marks-open")?.addEventListener("click", () => {
    renderList();
    updateRecUi();
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
