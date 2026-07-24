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

/** Accuracy at which chasing a better fix stops paying — a phone GPS outdoors
 *  settles around here, and waiting for less is waiting for nothing. */
const GOOD_ENOUGH_M = 20;
/** How long to keep sharpening after the first fix lands. */
const REFINE_MS = 12000;
/** Give up entirely if nothing at all arrives. */
const HARD_MS = 25000;

/**
 * A fix as fast as the device can manage, then a better one.
 *
 * `getFix` asks for a single high-accuracy position, which on iOS means waiting
 * for CoreLocation to actually acquire GPS — ten to thirty seconds from cold,
 * with nothing on screen meanwhile. It is worse than it needs to be: the phone
 * almost always has a usable coarse position (last known, wifi, cell) available
 * immediately, and `maximumAge: 10000` threw that away because a cold fix is
 * older than ten seconds.
 *
 * So watch instead of asking once. The first callback usually arrives in about
 * a second with whatever the OS already had; `onImprove` then fires as the GPS
 * narrows it down, and the watch is torn down once the fix is good enough (or
 * refining stops helping). The promise resolves on the FIRST fix, so callers
 * that just want a position are unchanged — they simply get one sooner.
 *
 * "Usually" is doing work in that sentence: see the note on maximumAge below.
 * On iOS the early fix is CoreLocation volunteering its cache, not something
 * this code can demand, so the timeouts here are what actually bound the wait.
 */
export async function getFixFast(
  onImprove?: (f: GeoFix, final: boolean) => void,
  /** Abort to tear the watch down early. Without one, a caller that starts a
   *  second locate before the first has settled leaves the first watch running
   *  — several concurrent high-accuracy watches is exactly the battery cost
   *  this function exists to avoid. */
  signal?: AbortSignal
): Promise<GeoFix> {
  return new Promise<GeoFix>((resolve, reject) => {
    let first = false; // the caller has been given a position
    let done = false; // the watch has been torn down
    let best: GeoFix | null = null;
    let stop: (() => void) | null = null;
    let refine: ReturnType<typeof setTimeout> | undefined;

    const hard = setTimeout(() => {
      if (first || done) return;
      done = true;
      stop?.();
      reject(new Error("timed out waiting for a location fix"));
    }, HARD_MS);

    // A caller fault must never suppress teardown: `onImprove` calls into
    // MapLibre, which throws if a style rebuild is in flight, and an exception
    // escaping here used to skip the GOOD_ENOUGH check and leave the radio on.
    const tell = (f: GeoFix, final: boolean) => {
      try {
        onImprove?.(f, final);
      } catch (e) {
        console.error("[griddown] locate callback failed", e);
      }
    };

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(hard);
      clearTimeout(refine);
      stop?.();
      if (best) tell(best, true);
    };

    if (signal) {
      if (signal.aborted) {
        done = true;
        clearTimeout(hard);
        reject(new Error("cancelled"));
        return;
      }
      signal.addEventListener("abort", () => {
        const settled = first;
        finish();
        // Tagged, not just worded: a cancellation is the CALLER replacing this
        // request, not a failure to locate. Without the tag the superseded
        // caller reports "couldn't get a location fix" to a user who is at that
        // moment being located perfectly well by the request that replaced it.
        if (!settled) reject(Object.assign(new Error("cancelled"), { cancelled: true }));
      });
    }

    const better = (a: GeoFix, b: GeoFix | null) =>
      !b || (a.accuracy ?? Infinity) < (b.accuracy ?? Infinity);

    void watchFix(
      (f) => {
        if (done) return;
        if (better(f, best)) best = f;
        if (!first) {
          first = true;
          clearTimeout(hard);
          resolve(best!);
          // Keep sharpening for a while, then settle for what we have.
          refine = setTimeout(finish, REFINE_MS);
        } else {
          tell(best!, false);
        }
        if ((best!.accuracy ?? Infinity) <= GOOD_ENOUGH_M) finish();
      },
      (msg) => {
        // An error AFTER a fix is just a dropout — keep the fix we have.
        if (first || done) return;
        done = true;
        clearTimeout(hard);
        stop?.();
        reject(new Error(msg));
      },
      // Web/desktop only. The iOS plugin's WatchPositionArgs decodes just
      // `enableHighAccuracy` and drops maximumAge and timeout on the floor, so
      // on the platform this was written for the early fix is whatever
      // CoreLocation happens to deliver first from cache — welcome, but not
      // something we are asking for. HARD_MS is the real backstop; do not tune
      // this value expecting it to do anything on a phone.
      { maximumAge: 300000 }
    )
      .then((s) => {
        stop = s;
        // finish() may already have run before the watch was installed.
        if (done) s();
      })
      .catch((e) => {
        if (first || done) return;
        done = true;
        clearTimeout(hard);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
  });
}

/**
 * Continuous fixes until you stop. Returns a stop function. `onError` reports a
 * short reason string; a denial reads "permission denied" on every platform.
 */
export async function watchFix(
  onFix: (f: GeoFix) => void,
  onError: (msg: string) => void,
  /** `maximumAge` defaults to 2s, which is right for recording a track. Pass a
   *  larger value to let the OS hand over its last known position immediately
   *  — see getFixFast, where the first fix landing fast is the whole point. */
  opts?: { maximumAge?: number }
): Promise<() => void> {
  const maximumAge = opts?.maximumAge ?? 2000;
  if (await isMobile()) {
    const geo = await import("@tauri-apps/plugin-geolocation");
    if (!(await ensureNativePermission(geo))) {
      onError("permission denied");
      return () => {};
    }
    const idP = geo.watchPosition(
      { enableHighAccuracy: true, timeout: 15000, maximumAge },
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
    { enableHighAccuracy: true, maximumAge, timeout: 15000 }
  );
  return () => navigator.geolocation.clearWatch(id);
}
