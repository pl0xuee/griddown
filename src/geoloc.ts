// One place for "where am I", so nothing else has to care how the fix is got.
//
// On iOS/Android it uses the native geolocation plugin, which talks straight to
// the OS location service — the only prompt is the system one. The web
// `navigator.geolocation` path we take on desktop makes iOS WKWebView add a
// SECOND, per-website "localhost wants your location" prompt on top of the app
// one, which is the whole reason this wrapper exists. Desktop and the browser
// keep the web API (no such double prompt there, and no native plugin built).

import { invoke } from "@tauri-apps/api/core";

export interface GeoFix {
  lng: number;
  lat: number;
  accuracy?: number; // metres, if the source reports it
  altitude?: number; // metres, if the source reports it (for recorded tracks)
}

const inTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";

let mobileP: Promise<boolean> | null = null;
/** Cached compile-time answer from the backend (see `is_mobile` in lib.rs). */
function isMobile(): Promise<boolean> {
  if (!inTauri) return Promise.resolve(false);
  if (!mobileP) mobileP = invoke<boolean>("is_mobile").catch(() => false);
  return mobileP;
}

const WEB_OPTS: PositionOptions = { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 };

/** Ask the native plugin for permission, requesting it if it isn't granted yet. */
async function ensureNativePermission(
  geo: typeof import("@tauri-apps/plugin-geolocation")
): Promise<boolean> {
  let status = await geo.checkPermissions();
  if (status.location !== "granted" && status.coarseLocation !== "granted") {
    status = await geo.requestPermissions(["location"]);
  }
  return status.location === "granted" || status.coarseLocation === "granted";
}

/** A single fix. Rejects with an Error on failure or denial. */
export async function getFix(): Promise<GeoFix> {
  if (await isMobile()) {
    const geo = await import("@tauri-apps/plugin-geolocation");
    if (!(await ensureNativePermission(geo))) throw new Error("permission denied");
    const p = await geo.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 10000,
    });
    return { lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy ?? undefined, altitude: p.coords.altitude ?? undefined };
  }
  return new Promise<GeoFix>((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("no geolocation on this device"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy ?? undefined, altitude: p.coords.altitude ?? undefined }),
      (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? "permission denied" : e.message || "location error")),
      WEB_OPTS
    );
  });
}

/**
 * Continuous fixes until you stop. Returns a stop function. `onError` reports a
 * short reason string; a denial reads "permission denied" on every platform.
 */
export async function watchFix(
  onFix: (f: GeoFix) => void,
  onError: (msg: string) => void
): Promise<() => void> {
  if (await isMobile()) {
    const geo = await import("@tauri-apps/plugin-geolocation");
    if (!(await ensureNativePermission(geo))) {
      onError("permission denied");
      return () => {};
    }
    const idP = geo.watchPosition(
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 2000 },
      (loc, err) => {
        if (err) return onError(err);
        if (loc?.coords)
          onFix({ lng: loc.coords.longitude, lat: loc.coords.latitude, accuracy: loc.coords.accuracy ?? undefined, altitude: loc.coords.altitude ?? undefined });
      }
    );
    return () => void idP.then((id) => geo.clearWatch(id)).catch(() => {});
  }
  if (!("geolocation" in navigator)) {
    onError("no geolocation on this device");
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({ lng: p.coords.longitude, lat: p.coords.latitude, accuracy: p.coords.accuracy ?? undefined, altitude: p.coords.altitude ?? undefined }),
    (e) => onError(e.code === e.PERMISSION_DENIED ? "permission denied" : e.message || "location error"),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}
