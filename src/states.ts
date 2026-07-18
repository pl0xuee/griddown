import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "./toast";

export interface StateEntry {
  abbr: string;
  name: string;
  bbox: [number, number, number, number];
  center: [number, number];
  estMB: number;
}

export interface SwitchTarget {
  pmtilesUrl: string;
  name: string;
  center: [number, number];
  zoom: number;
  hasDem: boolean;
}

let onSwitch: (t: SwitchTarget) => void = () => {};
let catalog: StateEntry[] = [];
let installed = new Set<string>();
let activeAbbr = localStorage.getItem("griddown_active_state") || "";
const downloading = new Map<string, number>(); // abbr -> percent (0-100), -1 = indeterminate

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
    await listen<{ abbr: string; line: string }>("download-progress", (e) => {
      const pcts = e.payload.line.match(/(\d+)%/g);
      if (pcts && pcts.length) {
        downloading.set(e.payload.abbr, parseInt(pcts[pcts.length - 1]));
        updateRow(e.payload.abbr);
      }
    });
  }

  document.getElementById("states-search")?.addEventListener("input", render);
  render();

  // Restore a previously-active downloaded state.
  if (activeAbbr && installed.has(activeAbbr)) {
    void activate(activeAbbr, true);
  }
}

async function refreshInstalled() {
  if (!inTauri) return;
  try {
    installed = new Set(await invoke<string[]>("list_installed"));
  } catch {
    installed = new Set();
  }
}

function fmtSize(mb: number): string {
  return mb >= 1000 ? `~${(mb / 1000).toFixed(1)} GB` : `~${mb} MB`;
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
      .querySelector(`[data-del="${s.abbr}"]`)
      ?.addEventListener("click", () => remove(s.abbr));
  }
}

function rowHtml(s: StateEntry): string {
  const isInstalled = installed.has(s.abbr);
  const isActive = activeAbbr === s.abbr;
  const dl = downloading.get(s.abbr);
  const isDownloading = dl !== undefined;

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

  const del = isInstalled && !isDownloading
    ? `<button class="state-delete" data-del="${s.abbr}" title="Delete">🗑</button>`
    : "";

  const progress = isDownloading
    ? `<div class="state-progress"><span style="width:${dl! >= 0 ? dl : 15}%"></span></div>`
    : "";

  return `<div class="state-row ${isActive ? "active" : ""}" data-row="${s.abbr}">
      <div class="state-info">
        <div class="state-name">${s.name}</div>
        <div class="state-sub">${isInstalled ? "Installed" : fmtSize(s.estMB) + " download"}</div>
        ${progress}
      </div>
      ${action}${del}
    </div>`;
}

function updateRow(abbr: string) {
  const s = catalog.find((c) => c.abbr === abbr);
  const row = document.querySelector(`[data-row="${abbr}"]`);
  if (!s || !row) return;
  row.outerHTML = rowHtml(s);
  const list = document.getElementById("states-list");
  list?.querySelector(`[data-view="${abbr}"]`)?.addEventListener("click", () => activate(abbr, true));
  list?.querySelector(`[data-del="${abbr}"]`)?.addEventListener("click", () => remove(abbr));
  list?.querySelector(`[data-dl="${abbr}"]`)?.addEventListener("click", () => download(s));
}

async function download(s: StateEntry) {
  if (!inTauri) {
    toast("Downloads require the desktop app.", "error");
    return;
  }
  downloading.set(s.abbr, -1);
  updateRow(s.abbr);
  try {
    await invoke<string>("download_state", {
      abbr: s.abbr,
      bbox: s.bbox.join(","),
      maxzoom: 15,
    });
    downloading.delete(s.abbr);
    await refreshInstalled();
    updateRow(s.abbr);
    toast(`${s.name} downloaded — ready offline`, "success");
    // Auto-view the freshly downloaded state.
    void activate(s.abbr, true);
  } catch (err) {
    downloading.delete(s.abbr);
    updateRow(s.abbr);
    toast(`Download failed: ${err}`, "error");
  }
}

async function activate(abbr: string, fly: boolean) {
  const s = catalog.find((c) => c.abbr === abbr);
  if (!s || !inTauri) return;
  try {
    const path = await invoke<string>("state_path", { abbr });
    const url = `pmtiles://${convertFileSrc(path)}`;
    activeAbbr = abbr;
    localStorage.setItem("griddown_active_state", abbr);
    onSwitch({
      pmtilesUrl: url,
      name: s.name,
      center: s.center,
      zoom: fly ? 7 : 7,
      hasDem: false,
    });
    render();
    document.getElementById("states-panel")?.classList.add("hidden");
  } catch (err) {
    toast(`Couldn't open ${s.name}: ${err}`, "error");
  }
}

async function remove(abbr: string) {
  if (!inTauri) return;
  const s = catalog.find((c) => c.abbr === abbr);
  if (!confirm(`Delete the downloaded map for ${s?.name ?? abbr}?`)) return;
  try {
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
