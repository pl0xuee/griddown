import maplibregl from "maplibre-gl";
import { toast } from "./toast";
import { buildGPX, parseGPX } from "./gpx";
import {
  currentMarks,
  loadMarks,
  normalize,
  updateMarks,
  type Pt,
  type Track,
  type Waypoint,
} from "./store";
import { BACKUP_KEY, fmtAge } from "./readiness";
import { haversine } from "./geo";
import { watchFix } from "./geoloc";
import { saveExport, saveFile } from "./save";
import { runBackup } from "./backup";
import { save as savePicker } from "@tauri-apps/plugin-dialog";
import { confirmAction, promptAction } from "./dialog";
import { OVERPRINT_LIFT } from "./overprint";

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
  let stopWatch: (() => void) | null = null;
  // Bumped on every startRec. The watch is async (native path spans real IPC),
  // so a start→stop→start burst can leave an earlier watchFix still resolving;
  // the generation lets a superseded watch stop itself instead of leaking.
  let recGen = 0;
  let recStart = 0;

  // A recording in progress lived only in RAM until Stop was pressed. iOS kills
  // a backgrounded app whenever it wants, and a phone in a pocket is a
  // backgrounded app — so a whole day's walk could vanish with nothing to
  // recover, which is the one thing a track recorder must not do. Each fix is
  // mirrored to localStorage (a few KB, no marks.json churn, no IPC) and picked
  // back up on the next launch.
  const REC_KEY = "griddown_rec_inprogress";
  const stashRec = () => {
    try {
      if (recPts.length) {
        localStorage.setItem(REC_KEY, JSON.stringify({ t: recStart, pts: recPts }));
      } else localStorage.removeItem(REC_KEY);
    } catch {
      /* private mode, or full — the recording still works, it just isn't
         crash-proof, and saying so would be noise mid-walk. */
    }
  };
  const clearStash = () => {
    try {
      localStorage.removeItem(REC_KEY);
    } catch {
      /* nothing to do */
    }
  };

  // Persisting is async now, but callers are all UI handlers that don't need to
  // wait — surface a failure as a toast rather than swallowing it, since a
  // silent save failure is exactly the kind of thing this change exists to stop.
  const save = () => {
    // A patch, not a whole Marks: this module doesn't own plans, and writing
    // the object it does know about would delete them.
    void updateMarks({ waypoints, tracks }).catch(() =>
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
        paint: { "line-color": OVERPRINT_LIFT, "line-width": 4, "line-opacity": 0.9 },
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
    // Never leave a prior watch running, whatever state it's in.
    if (stopWatch) {
      stopWatch();
      stopWatch = null;
    }
    recording = true;
    recPts = [];
    recStart = Date.now();
    const gen = ++recGen;
    // Via geoloc.ts, so on a phone it's the native, single-prompt location.
    void watchFix(
      (f) => {
        // Ignore a watch that's been superseded by a newer start, or fires
        // after recording stopped but before its clearWatch takes effect.
        if (gen !== recGen || !recording) return;
        recPts.push([f.lng, f.lat, f.altitude]);
        stashRec();
        ensureTrackLayer();
        updateRecUi(); // keep the live distance/points/time honest
      },
      // Swallowing this left the button reading "■ Stop recording" while nothing
      // was ever captured — the user believes they're recording the route they
      // walked, and finds out only when the track isn't there afterwards.
      (msg) => {
        if (gen !== recGen) return;
        const why = /denied/i.test(msg)
          ? "location permission denied"
          : /no geolocation/i.test(msg)
            ? "location isn't available on this device"
            : "no position fix available";
        if (recPts.length === 0) {
          toast(`Can't record a track — ${why}.`, "error", 6000);
          stopRec();
        } else {
          toast(`Track recording interrupted — ${why}.`, "error", 5000);
        }
      }
    ).then((stop) => {
      // Keep the stop fn only if this watch is still the current, active one;
      // otherwise it was superseded or already stopped — kill it now so no
      // native watch is left running (the drain the one-shot design avoids).
      if (gen === recGen && recording) stopWatch = stop;
      else stop();
    }).catch((e) => {
      // The error CALLBACK above covers a watch that starts and then fails. A
      // rejected promise is the other case — watchFix never got as far as
      // starting one — and without this the button reads "Stop recording" while
      // nothing is being captured and nothing has said so.
      if (gen !== recGen) return;
      toast(
        `Can't record a track — ${e instanceof Error ? e.message : "location unavailable"}.`,
        "error",
        6000
      );
      stopRec();
    });
    updateRecUi();
  }
  function stopRec() {
    recording = false;
    if (stopWatch) {
      stopWatch();
      stopWatch = null;
    }
    clearStash();
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
    // waypoints and tracks are this module's; plans, kits, the roster and the
    // comms plan are read from the store, which owns them. Backing up means all
    // of it — this panel just must not lose what it does not own.
    const m = { ...currentMarks(), waypoints, tracks };
    void runBackup(m, { ...localStorage } as unknown as Record<string, string>, {
      // No success toast from the save itself: on a phone it would name the
      // container the export is about to rescue the file from. runBackup says
      // what happened, once it knows.
      save: (name, json) => saveExport(name, json, "application/json", false),
      // Only reached when the save was not durable, which today means iOS. The
      // plugin resolves a bare name against the app's Documents directory —
      // the same directory save_file just wrote to, which is also why runBackup
      // checks what comes back against it.
      exportOut: (fileName) => savePicker({ defaultPath: fileName }),
      stamp: (t) => localStorage.setItem(BACKUP_KEY, String(t)),
      now: () => Date.now(),
      toast,
    }).catch((e) => {
      // Nothing has been stamped if we are here, so the state is honest; the
      // user just has no idea. Say so rather than letting it go unhandled.
      toast(`Couldn't back up: ${e}`, "error", 7000);
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
    const now = currentMarks();
    if (
      !restored.waypoints.length &&
      !restored.tracks.length &&
      !restored.plans.length &&
      !restored.kits.length &&
      !restored.roster.length &&
      !restored.comms
    ) {
      toast("No marks found in that backup.", "error");
      return;
    }
    // A restore replaces, so make the user say yes — with the counts, so they
    // can see they're not about to trade a full set for an empty one. Plans are
    // named too: a backup taken before plans existed restores zero of them, and
    // silently trading your bug-out plan for nothing is the worst thing this
    // button could do.
    // Every slice this is about to overwrite has to be named, including the
    // ones a backup taken before they existed restores as nothing. The first
    // version of this listed pins, tracks and plans and then silently wrote
    // roster, kits and comms as well — so restoring a March backup to recover a
    // deleted pin also deleted every person's blood group, allergies and
    // medication, with the dialog saying nothing about it.
    const line = (label: string, from: number, to: number) =>
      from || to ? `${from} → ${to} ${label}` : "";
    const changes = [
      line("pin(s)", waypoints.length, restored.waypoints.length),
      line("track(s)", tracks.length, restored.tracks.length),
      line("plan(s)", now.plans.length, restored.plans.length),
      line("checklist(s)", now.kits.length, restored.kits.length),
      line("person/people", now.roster.length, restored.roster.length),
      line("comms plan", now.comms ? 1 : 0, restored.comms ? 1 : 0),
    ].filter(Boolean);
    const losing = changes.length
      ? `\n\n${changes.join("\n")}`
      : "";
    const ok = await confirmAction(
      `Replace everything saved on this device with the contents of this backup?${losing}`
    );
    if (!ok) return;
    waypoints = restored.waypoints;
    tracks = restored.tracks;
    void updateMarks({
      waypoints,
      tracks,
      plans: restored.plans,
      kits: restored.kits,
      roster: restored.roster,
      comms: restored.comms,
    })
      .then(() => {
        // The Plan and Kit panels hold their own copies; tell them to re-read
        // rather than leaving them showing data that is no longer on disk.
        document.dispatchEvent(new CustomEvent("griddown:marks-changed"));
      })
      .catch(() => toast("Couldn't save your marks to disk.", "error"));
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
          <button class="mk-del" data-delwp="${esc(w.id)}" title="Delete" aria-label="Delete pin">✕</button></div>`
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
          <button class="mk-del" data-deltr="${esc(t.id)}" title="Delete" aria-label="Delete track">✕</button></div>`;
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

  // Somebody else wrote the marks file — a restore, or the Plan panel pushing
  // its stops onto the map as pins.
  //
  // Re-reading is not cosmetic, it is the difference between keeping those pins
  // and destroying them: this module holds `waypoints` in a closure, and the
  // very next save() would write that stale array straight over the new ones.
  document.addEventListener("griddown:marks-changed", () => {
    const m = currentMarks();
    waypoints = m.waypoints;
    tracks = m.tracks;
    refreshMarkers();
    ensureTrackLayer();
    renderList();
  });

  refreshMarkers();
  updateRecUi();

  // A recording the app never got to finish. Offered rather than saved: the
  // points are real, but only the person who walked them knows whether the
  // track is worth keeping, and silently adding one is its own surprise.
  void (async () => {
    let stash: { t?: number; pts?: unknown } | null = null;
    try {
      const raw = localStorage.getItem(REC_KEY);
      stash = raw ? JSON.parse(raw) : null;
    } catch {
      clearStash();
      return;
    }
    const pts = Array.isArray(stash?.pts) ? (stash!.pts as Pt[]) : [];
    const good = pts.filter(
      (p) =>
        Array.isArray(p) &&
        typeof p[0] === "number" &&
        typeof p[1] === "number" &&
        Math.abs(p[1]) <= 90 &&
        Math.abs(p[0]) <= 180
    );
    if (good.length < 2) {
      clearStash();
      return;
    }
    const when = typeof stash?.t === "number" ? stash.t : Date.now();
    const km = trackMeters(good) / 1000;
    const ok = await confirmAction(
      `A track recording was interrupted — ${good.length} points, ${km.toFixed(1)} km, ` +
        `started ${fmtAge(Math.floor((Date.now() - when) / 1000))}. Keep it?`
    );
    clearStash();
    if (!ok) return;
    tracks.push({
      id: rid(),
      name: `Recovered track ${new Date(when).toLocaleDateString()}`,
      pts: good,
      t: when,
    });
    saveTr();
    ensureTrackLayer();
    renderList();
    toast(`Recovered a track — ${good.length} points.`, "success");
  })();
}
