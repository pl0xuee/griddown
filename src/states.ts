import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "./toast";
import { fmtAge, DAY } from "./readiness";
import { keepAwake } from "./wakelock";
import { esc as escapeHtml } from "./esc";
import { confirmAction, promptAction } from "./dialog";

export interface StateEntry {
  abbr: string;
  name: string;
  bbox: [number, number, number, number];
  center: [number, number];
  estMB: number;
  /**
   * Cut this state shallower than the usual z15.
   *
   * Only Alaska sets it. Alaska at z15 is 19.6 M tiles — fourteen times
   * California — because Mercator stretches tiles at that latitude, and it
   * cannot be built inside CI's six-hour job limit. One level down is a
   * quarter of the work, and vector tiles overzoom, so the map still zooms in;
   * detail just stops improving a level earlier.
   *
   * CI reads the same field, so the pack is cut at exactly the zoom the app
   * asks for and the manifest's zoom check still holds.
   */
  maxzoom?: number;
}

export interface SwitchTarget {
  /** Which pack this is — overlays keyed by pack (MVUM) need to follow it. */
  abbr: string;
  pmtilesUrl: string;
  name: string;
  center: [number, number];
  zoom: number;
  hasDem: boolean;
  /** Tile URL template for this state's downloaded DEM (when hasDem). */
  demUrl?: string;
  /** Stable protocol id for that DEM root, e.g. "dem-or". */
  demId?: string;
  /** Reload data but leave the camera where it is (used after a pack refresh). */
  keepView?: boolean;
}

interface PackInfo {
  abbr: string;
  bytes: number;
  modified: number; // unix seconds, 0 = unknown
  dem_bytes: number; // 0 = no terrain downloaded
  mvum_bytes: number; // 0 = no Forest Service overlay downloaded
}

let onSwitch: (t: SwitchTarget) => void = () => {};
let catalog: StateEntry[] = [];
let installed = new Set<string>();
let packInfo = new Map<string, PackInfo>();
let activeAbbr = localStorage.getItem("griddown_active_state") || "";
const downloading = new Map<string, number>(); // abbr -> percent (0-100), -1 = indeterminate
const downloadStatus = new Map<string, string>(); // abbr -> what it is currently doing
const demDownloading = new Map<string, number>(); // abbr -> percent, -1 = starting
const mvumDownloading = new Map<string, number>(); // abbr -> percent, -1 = starting

/** Told when a pack's Forest Service overlay arrives, so the map can show it. */
let onMvumReady: (abbr: string) => void = () => {};
export function setMvumListener(cb: (abbr: string) => void) {
  onMvumReady = cb;
}

const inTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";

export async function initStateLibrary(cb: (t: SwitchTarget) => void) {
  onSwitch = cb;
  try {
    catalog = await (await fetch("/states.json")).json();
  } catch {
    catalog = [];
  }
  await refreshInstalled();

  if (inTauri) {
    // Two shapes share this event: `pct` carries real progress, `line` carries a
    // status message for the phases before tile counts exist ("Finding latest
    // map build…"). This used to scrape percentages out of the go-pmtiles
    // subprocess's stdout with a regex; the extract now runs in-process and
    // reports actual numbers.
    await listen<{ abbr: string; line?: string; done?: number; total?: number; pct?: number }>(
      "download-progress",
      (e) => {
        if (typeof e.payload.line === "string") {
          // Worth showing, not just discarding as it used to be: these lines are
          // where "downloading a 27 MB file" and "rebuilding this state from the
          // planet archive, back in twenty minutes" tell themselves apart.
          if (!downloading.has(e.payload.abbr)) return; // stale event
          downloadStatus.set(e.payload.abbr, e.payload.line);
          updateRow(e.payload.abbr);
          return;
        }
        if (typeof e.payload.pct !== "number") return;
        // Same stale-event guard the line branch and the DEM handler already
        // have. Without it a progress event arriving after the command's
        // promise resolves puts the state back into `downloading`, and the row
        // is stuck on a disabled percentage with no way back short of restart.
        if (!downloading.has(e.payload.abbr)) return;
        downloading.set(e.payload.abbr, e.payload.pct);
        updateRow(e.payload.abbr);
      }
    );
    await listen<{ abbr: string; done: number; total: number }>("dem-progress", (e) => {
      if (!demDownloading.has(e.payload.abbr)) return; // stale event
      demDownloading.set(
        e.payload.abbr,
        Math.round((e.payload.done / Math.max(1, e.payload.total)) * 100)
      );
      updateRow(e.payload.abbr);
    });
    await listen<{ abbr: string; done: number; total: number }>("mvum-progress", (e) => {
      if (!mvumDownloading.has(e.payload.abbr)) return; // stale event
      mvumDownloading.set(
        e.payload.abbr,
        Math.round((e.payload.done / Math.max(1, e.payload.total)) * 100)
      );
      updateRow(e.payload.abbr);
    });
  }

  document.getElementById("states-search")?.addEventListener("input", render);
  document.getElementById("states-import")?.addEventListener("click", () => void importPack());
  render();

  // Restore a previously-active downloaded state.
  if (activeAbbr && installed.has(activeAbbr)) {
    void activate(activeAbbr, true);
  }
}

async function refreshInstalled() {
  if (!inTauri) return;
  try {
    const packs = await invoke<PackInfo[]>("pack_info");
    packInfo = new Map(packs.map((p) => [p.abbr, p]));
    installed = new Set(packInfo.keys());
  } catch (err) {
    // Emptying these turns "I couldn't find out" into "you have nothing
    // installed and no terrain" everywhere downstream — the Terrain button
    // disappears and elevation/profile/viewshed all report no data for a state
    // whose DEM is sitting on disk. Keep the failure visible.
    packInfo = new Map();
    installed = new Set();
    toast(`Couldn't read your installed packs: ${err}`, "error", 6000);
  }
}

function fmtSize(mb: number): string {
  return mb >= 1000 ? `~${(mb / 1000).toFixed(1)} GB` : `~${mb} MB`;
}

function fmtBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
}

/** "Installed · 240 MB · updated 3 months ago" for the row's sub-line. */
function installedSub(abbr: string): string {
  const p = packInfo.get(abbr);
  if (!p) return "Installed";
  const parts = [`Installed · ${fmtBytes(p.bytes)}`];
  if (p.dem_bytes > 0) parts.push(`terrain ${fmtBytes(p.dem_bytes)}`);
  if (p.mvum_bytes > 0) parts.push(`forest roads ${fmtBytes(p.mvum_bytes)}`);
  if (p.modified) {
    const age = Math.floor(Date.now() / 1000) - p.modified;
    const stale = age > 365 * DAY;
    parts.push(
      `<span class="${stale ? "state-stale" : ""}">updated ${fmtAge(age)}</span>`
    );
  }
  return parts.join(" · ");
}

/**
 * Rough DEM download size for a bbox: count z12 tiles (the pyramid above them
 * adds ~1/3) at the ~110 KB/tile the bundled mountainous region averages.
 */
function estDemMB(bbox: [number, number, number, number]): number {
  const [w, s, e, n] = bbox;
  const n12 = 2 ** 12;
  const lat2y = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n12;
  };
  const cols = Math.max(1, ((e - w) / 360) * n12);
  const rows = Math.max(1, lat2y(s) - lat2y(n));
  return Math.round((cols * rows * 1.33 * 110) / 1000);
}

function render() {
  const list = document.getElementById("states-list");
  if (!list) return;
  const q = (
    document.getElementById("states-search") as HTMLInputElement | null
  )?.value?.toLowerCase() || "";
  const rows = catalog
    .filter((s) => s.name.toLowerCase().includes(q) || s.abbr.toLowerCase().includes(q))
    .map((s) => rowHtml(s))
    .join("");
  list.innerHTML =
    rows ||
    `<div style="opacity:.6;font-size:12px;padding:10px">No states match.</div>`;

  for (const s of catalog) {
    list
      .querySelector(`[data-dl="${s.abbr}"]`)
      ?.addEventListener("click", () => download(s));
    list
      .querySelector(`[data-view="${s.abbr}"]`)
      ?.addEventListener("click", () => activate(s.abbr, true));
    list
      .querySelector(`[data-refresh="${s.abbr}"]`)
      ?.addEventListener("click", () => download(s, true));
    list
      .querySelector(`[data-dem="${s.abbr}"]`)
      ?.addEventListener("click", () => downloadDem(s));
    list
      .querySelector(`[data-mvum="${s.abbr}"]`)
      ?.addEventListener("click", () => downloadMvum(s));
    list
      .querySelector(`[data-share="${s.abbr}"]`)
      ?.addEventListener("click", () => sharePack(s));
    list
      .querySelector(`[data-del="${s.abbr}"]`)
      ?.addEventListener("click", () => remove(s.abbr));
  }
}

/**
 * One in-progress side download (terrain, forest roads) as a labelled bar.
 *
 * A percentage of -1 means it has started but has no count yet — shown as an
 * indeterminate sweep rather than a stuck bar at a made-up width, which is what
 * the old "…" and fixed 5% were standing in for.
 */
function taskRow(label: string, pct: number): string {
  const indet = pct < 0;
  return `<div class="state-task">
      <div class="state-task-head"><span>${label}</span><span>${indet ? "" : pct + "%"}</span></div>
      <div class="state-progress${indet ? " indeterminate" : ""}"><span style="width:${indet ? 100 : pct}%"></span></div>
    </div>`;
}

function rowHtml(s: StateEntry): string {
  const isInstalled = installed.has(s.abbr);
  const isActive = activeAbbr === s.abbr;
  const dl = downloading.get(s.abbr);
  const isDownloading = dl !== undefined;
  const dem = demDownloading.get(s.abbr);
  const isDemDownloading = dem !== undefined;
  const hasDem = (packInfo.get(s.abbr)?.dem_bytes ?? 0) > 0;

  let action: string;
  if (isDownloading) {
    const pct = dl! >= 0 ? `${dl}%` : "…";
    action = `<button class="state-action" disabled>${pct}</button>`;
  } else if (isInstalled) {
    action = `<button class="state-action installed" data-view="${s.abbr}">${
      isActive ? "● Active" : "View"
    }</button>`;
  } else {
    action = `<button class="state-action" data-dl="${s.abbr}">Download</button>`;
  }

  const extras = isInstalled && !isDownloading
    ? `<button class="state-refresh" data-refresh="${s.abbr}" title="Update this pack (re-download)">↻</button>` +
      `<button class="state-refresh" data-share="${s.abbr}" title="Export to Downloads (share via USB/SD)">⇪</button>` +
      `<button class="state-delete" data-del="${s.abbr}" title="Delete">🗑</button>`
    : "";

  // Terrain: its own sub-row so the big optional download is a clear choice.
  let demRow = "";
  if (isInstalled && !isDownloading) {
    if (isDemDownloading) {
      demRow = taskRow("Terrain", dem!);
    } else if (!hasDem) {
      demRow = `<div class="state-dem">
          <button class="state-dem-btn" data-dem="${s.abbr}">△ Add terrain (~${fmtSize(estDemMB(s.bbox))})</button>
        </div>`;
    }
  }

  // Forest Service roads: a second optional extra, same shape as terrain.
  let mvumRow = "";
  if (isInstalled && !isDownloading) {
    const mv = mvumDownloading.get(s.abbr);
    const hasMvum = (packInfo.get(s.abbr)?.mvum_bytes ?? 0) > 0;
    if (mv !== undefined) {
      mvumRow = taskRow("Forest roads", mv);
    } else if (!hasMvum) {
      mvumRow = `<div class="state-mvum">
          <button class="state-mvum-btn" data-mvum="${s.abbr}">● Add forest roads (MVUM)</button>
        </div>`;
    }
  }

  const status = downloadStatus.get(s.abbr);
  const indet = isDownloading && dl! < 0;
  const progress = isDownloading
    ? (status ? `<div class="state-dl-status">${escapeHtml(status)}</div>` : "") +
      `<div class="state-progress${indet ? " indeterminate" : ""}"><span style="width:${indet ? 100 : dl}%"></span></div>`
    : "";

  return `<div class="state-row ${isActive ? "active" : ""}" data-row="${s.abbr}">
      <div class="state-head">
        <div class="state-info">
          <div class="state-name">${s.name}</div>
          <div class="state-sub">${isInstalled ? installedSub(s.abbr) : fmtSize(s.estMB) + " download"}</div>
        </div>
        <div class="state-controls">${action}${extras}</div>
      </div>
      ${progress}${demRow}${mvumRow}
    </div>`;
}

function updateRow(abbr: string) {
  const s = catalog.find((c) => c.abbr === abbr);
  const row = document.querySelector(`[data-row="${abbr}"]`);
  if (!s || !row) return;
  row.outerHTML = rowHtml(s);
  const list = document.getElementById("states-list");
  list?.querySelector(`[data-view="${abbr}"]`)?.addEventListener("click", () => activate(abbr, true));
  list?.querySelector(`[data-refresh="${abbr}"]`)?.addEventListener("click", () => download(s, true));
  list?.querySelector(`[data-dem="${abbr}"]`)?.addEventListener("click", () => downloadDem(s));
  list?.querySelector(`[data-mvum="${abbr}"]`)?.addEventListener("click", () => downloadMvum(s));
  list?.querySelector(`[data-del="${abbr}"]`)?.addEventListener("click", () => remove(abbr));
  list?.querySelector(`[data-dl="${abbr}"]`)?.addEventListener("click", () => download(s));
  // render() binds this too. Leaving it out here meant that after any row
  // refresh — terrain finishing, forest roads finishing, a pack update — the
  // node was replaced and Export stopped working until a full re-render.
  list?.querySelector(`[data-share="${abbr}"]`)?.addEventListener("click", () => sharePack(s));
}

async function downloadDem(s: StateEntry) {
  if (!inTauri) {
    toast("Downloads require the desktop app.", "error");
    return;
  }
  demDownloading.set(s.abbr, -1);
  updateRow(s.abbr);
  try {
    await invoke<number>("download_dem", {
      abbr: s.abbr,
      bbox: s.bbox.join(","),
      maxzoom: 12,
    });
    demDownloading.delete(s.abbr);
    await refreshInstalled();
    updateRow(s.abbr);
    toast(`${s.name} terrain ready — hillshade, contours and elevation now work offline.`, "success");
    // If it's on screen, reload so terrain appears right away.
    if (activeAbbr === s.abbr) void activate(s.abbr, false);
  } catch (err) {
    demDownloading.delete(s.abbr);
    updateRow(s.abbr);
    toast(`Terrain download failed: ${err}`, "error");
    toast("Already-downloaded tiles are kept — trying again resumes.", "info");
  }
}

async function downloadMvum(s: StateEntry) {
  if (!inTauri) {
    toast("Downloads require the desktop app.", "error");
    return;
  }
  mvumDownloading.set(s.abbr, -1);
  updateRow(s.abbr);
  try {
    await invoke<number>("download_mvum", {
      abbr: s.abbr,
      bbox: s.bbox.join(","),
    });
    mvumDownloading.delete(s.abbr);
    await refreshInstalled();
    updateRow(s.abbr);
    toast(
      `${s.name} forest roads ready — turn on "Forest roads" to see what you may drive.`,
      "success",
      7000
    );
    if (activeAbbr === s.abbr) onMvumReady(s.abbr);
  } catch (err) {
    mvumDownloading.delete(s.abbr);
    updateRow(s.abbr);
    toast(`Forest roads download failed: ${err}`, "error");
  }
}

async function download(s: StateEntry, refresh = false) {
  if (!inTauri) {
    toast("Downloads require the desktop app.", "error");
    return;
  }
  downloading.set(s.abbr, -1);
  updateRow(s.abbr);
  // A state pack takes minutes. If the screen locks partway, iOS suspends the
  // app and every open socket dies with it.
  const wake = await keepAwake();
  try {
    await invoke<string>("download_state", {
      abbr: s.abbr,
      bbox: s.bbox.join(","),
      maxzoom: s.maxzoom ?? 15,
    });
    downloading.delete(s.abbr);
    downloadStatus.delete(s.abbr);
    await refreshInstalled();
    updateRow(s.abbr);
    if (refresh) {
      toast(`${s.name} updated to the latest map data`, "success");
      // Reload it only if it's what's on screen — don't yank the view otherwise.
      if (activeAbbr === s.abbr) void activate(s.abbr, false);
    } else {
      toast(`${s.name} downloaded — ready offline`, "success");
      // Auto-view the freshly downloaded state.
      void activate(s.abbr, true);
    }
  } catch (err) {
    downloading.delete(s.abbr);
    downloadStatus.delete(s.abbr);
    updateRow(s.abbr);
    const verb = refresh ? "Update" : "Download";
    toast(`${verb} failed: ${err}`, "error");
    if (refresh) toast("Your existing pack is untouched.", "info");
  } finally {
    wake();
  }
}

async function activate(abbr: string, fly: boolean) {
  const s = catalog.find((c) => c.abbr === abbr);
  if (!s || !inTauri) return;
  try {
    const path = await invoke<string>("state_path", { abbr });
    const url = `pmtiles://${convertFileSrc(path)}`;
    const hasDem = (packInfo.get(abbr)?.dem_bytes ?? 0) > 0;
    let demUrl: string | undefined;
    if (hasDem) {
      const demDir = await invoke<string>("dem_path", { abbr });
      demUrl = `${convertFileSrc(demDir)}/{z}/{x}/{y}.png`;
    }
    activeAbbr = abbr;
    localStorage.setItem("griddown_active_state", abbr);
    onSwitch({
      abbr,
      pmtilesUrl: url,
      name: s.name,
      center: s.center,
      zoom: 7,
      hasDem,
      demUrl,
      demId: `dem-${abbr.toLowerCase()}`,
      keepView: !fly,
    });
    render();
    document.getElementById("states-panel")?.classList.add("hidden");
  } catch (err) {
    toast(`Couldn't open ${s.name}: ${err}`, "error");
  }
}

async function sharePack(s: StateEntry) {
  try {
    toast(`Copying ${s.name} pack…`);
    const path = await invoke<string>("export_pack", { abbr: s.abbr });
    toast(`Saved to ${path} — copy it to a USB stick to share.`, "success", 7000);
    // A pack file is the basemap only; terrain lives in a separate tile tree.
    // Whoever receives this gets no hillshade, contours, elevation, profile or
    // viewshed until they download terrain themselves — say so at the point of
    // sharing rather than letting them discover it in the field.
    if ((packInfo.get(s.abbr)?.dem_bytes ?? 0) > 0) {
      toast(
        "Note: terrain isn't included in the pack file. The person you share it with will need to add terrain themselves.",
        "info",
        9000
      );
    }
  } catch (err) {
    toast(`Export failed: ${err}`, "error");
  }
}

async function importPack() {
  if (!inTauri) {
    toast("Importing requires the desktop app.", "error");
    return;
  }
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: "PMTiles map pack", extensions: ["pmtiles"] }],
  });
  if (!picked) return;
  const path = String(picked);
  // Guess the state from a "griddown-XX.pmtiles" name, else ask.
  const m = path.match(/griddown-([A-Za-z]{2})(?:-\d+)?\.pmtiles$/);
  let abbr = m ? m[1].toUpperCase() : "";
  if (!abbr || !catalog.some((c) => c.abbr === abbr)) {
    // Not window.prompt: it is unimplemented in WKWebView, so on iOS this
    // returned null immediately and importing a pack silently did nothing.
    const typed = await promptAction(
      "Which state is this pack? Enter its 2-letter code (e.g. OR):",
      { value: abbr, placeholder: "OR" }
    );
    if (!typed) return;
    abbr = typed.trim().toUpperCase();
    if (!catalog.some((c) => c.abbr === abbr)) {
      toast(`"${abbr}" isn't a state code I know.`, "error");
      return;
    }
  }
  try {
    toast("Importing pack…");
    await invoke("import_pack", { abbr, path });
    await refreshInstalled();
    render();
    toast(`${abbr} imported — works offline now.`, "success");
    // An imported pack never carries terrain (export copies the .pmtiles only),
    // so hillshade/contours/elevation stay silently absent. Name it, and point
    // at the fix, instead of letting it read as a broken import.
    if ((packInfo.get(abbr)?.dem_bytes ?? 0) === 0) {
      toast(
        `${abbr} has no terrain — use "△ Add terrain" for hillshade, contours and elevation.`,
        "info",
        9000
      );
    }
    void activate(abbr, true);
  } catch (err) {
    toast(`Import failed: ${err}`, "error");
  }
}

async function remove(abbr: string) {
  if (!inTauri) return;
  const s = catalog.find((c) => c.abbr === abbr);
  try {
    // Inside the try: `remove` is called as a floating promise, so a dialog
    // that rejects would otherwise be an unhandled rejection and the button
    // would simply appear dead — the exact failure this dialog work set out
    // to remove.
    if (!(await confirmAction(`Delete the downloaded map for ${s?.name ?? abbr}?`))) return;
    await invoke("delete_state", { abbr });
    if (activeAbbr === abbr) {
      activeAbbr = "";
      localStorage.removeItem("griddown_active_state");
    }
    await refreshInstalled();
    render();
  } catch (err) {
    toast(`Delete failed: ${err}`, "error");
  }
}
