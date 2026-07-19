import { invoke } from "@tauri-apps/api/core";

// Durable storage for the user's own data — waypoints and recorded tracks.
//
// These are the only things in the app that can't be regenerated: a map pack can
// be re-downloaded, a pin you dropped in the field can't. They used to live in
// localStorage, which in a Tauri app is a webview cache directory that a
// reinstall or webview update can silently wipe. They now live in marks.json in
// the app data dir, written atomically on the Rust side.
//
// localStorage is still the fallback when there's no Tauri backend (plain
// `vite dev` in a browser), and is read once to migrate existing data over.

export interface Waypoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  note?: string;
  t: number;
}
export type Pt = [number, number, number?]; // lng, lat, ele?
export interface Track {
  id: string;
  name: string;
  pts: Pt[];
  t: number;
}
export interface Marks {
  waypoints: Waypoint[];
  tracks: Track[];
}

const WP_KEY = "griddown_waypoints";
const TR_KEY = "griddown_tracks";

const empty = (): Marks => ({ waypoints: [], tracks: [] });

function hasTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
}

function readLocalStorage(): Marks {
  const parse = <T>(key: string): T[] => {
    try {
      const v = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return { waypoints: parse<Waypoint>(WP_KEY), tracks: parse<Track>(TR_KEY) };
}

function writeLocalStorage(m: Marks) {
  try {
    localStorage.setItem(WP_KEY, JSON.stringify(m.waypoints));
    localStorage.setItem(TR_KEY, JSON.stringify(m.tracks));
  } catch {
    /* quota or disabled storage — the file is the real store anyway */
  }
}

/** Coerce anything we read back into a well-formed Marks. */
export function normalize(v: any): Marks {
  const m = empty();
  if (v && typeof v === "object") {
    if (Array.isArray(v.waypoints)) m.waypoints = v.waypoints.filter(isWaypoint);
    if (Array.isArray(v.tracks)) m.tracks = v.tracks.filter(isTrack);
  }
  return m;
}

function isWaypoint(w: any): w is Waypoint {
  return w && typeof w.id === "string" && Number.isFinite(w.lat) && Number.isFinite(w.lng);
}
function isTrack(t: any): t is Track {
  return t && typeof t.id === "string" && Array.isArray(t.pts);
}

export async function loadMarks(): Promise<Marks> {
  if (!hasTauri()) return readLocalStorage();

  let fromFile = empty();
  try {
    const raw = await invoke<string>("read_marks");
    if (raw.trim()) fromFile = normalize(JSON.parse(raw));
  } catch {
    fromFile = empty();
  }

  // One-time migration: if the file is empty but localStorage still holds the
  // old data, adopt it and write it through to the durable store.
  if (!fromFile.waypoints.length && !fromFile.tracks.length) {
    const legacy = readLocalStorage();
    if (legacy.waypoints.length || legacy.tracks.length) {
      await saveMarks(legacy);
      return legacy;
    }
  }
  return fromFile;
}

export async function saveMarks(m: Marks): Promise<void> {
  // Mirror to localStorage too: harmless, and it keeps a second copy around on
  // the off chance the app data dir is lost.
  writeLocalStorage(m);
  if (!hasTauri()) return;
  try {
    await invoke("write_marks", { json: JSON.stringify(m) });
  } catch (e) {
    console.error("Failed to save marks", e);
    throw e;
  }
}
