// Compass — which way am I facing. Pure device-sensor, fully offline.
//
// iOS: needs DeviceOrientationEvent.requestPermission() from a user gesture,
// and reports `webkitCompassHeading` (degrees clockwise from magnetic north).
// Android/others: `deviceorientationabsolute` (or absolute deviceorientation)
// with `alpha`, where heading = 360 - alpha.
// Desktops usually have no magnetometer — say so instead of spinning aimlessly.
//
// Headings are shown relative to TRUE north, because that is what the map and
// any bearing taken off it use. The sensor reports magnetic north, so every
// reading gets the local declination added (geomag.ts). In the western US that
// correction is 10-15° — a mile and a half of error over ten miles, which is
// the difference between finding a trailhead and not.

import {
  declination,
  formatDeclination,
  magneticToTrue,
  modelValidFor,
  WMM_VALID_TO,
} from "./geomag";

const NO_SENSOR =
  "No compass on this device. Most desktops have no magnetometer — use a phone or tablet in the field.";

const CARDINALS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

export function cardinal(deg: number): string {
  return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * The shortest signed turn from one angle to another, in (-180, 180].
 *
 * Rotations are interpolated by CSS as plain numbers, so going from 359° to 1°
 * by way of the arithmetic difference turns 358 degrees the wrong way. This
 * gives the step a needle should actually take.
 */
export function shortestTurn(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/** Extract a compass heading (° CW from magnetic north) from an orientation
 *  event. Exported so the map's heading-up mode reads the sensor the same way
 *  the compass panel does. */
export function headingFrom(e: DeviceOrientationEvent): number | null {
  const webkit = (e as any).webkitCompassHeading;
  if (typeof webkit === "number" && webkit >= 0) return webkit; // iOS
  if (e.absolute && e.alpha != null) return (360 - e.alpha + 360) % 360;
  return null;
}

/**
 * @param here fallback position (map centre) — declination is a function of it.
 * @param locate optional: go to the user's actual location first and return it,
 *   so the compass is for where they are, not wherever the map was left.
 */
export function initCompass(
  here: () => { lat: number; lng: number },
  locate?: () => Promise<{ lat: number; lng: number } | null>
) {
  const box = document.getElementById("compass-box");
  const readout = document.getElementById("compass-readout");
  const needle = document.getElementById("compass-needle");
  const note = document.getElementById("compass-note");
  const decEl = document.getElementById("compass-dec");

  let listening = false;
  let gotReading = false;
  /** Continuous needle angle — see setNeedle. Not wrapped to 0..360. */
  let needleAngle = 0;
  let noSensorTimer = 0;
  // Declination is recomputed when the panel opens, not per reading: it changes
  // by about a degree per 100 km, so it is constant for anyone standing still,
  // and the field model is a 90-term sum.
  let dec: number | null = null;

  function refreshDeclination(pos?: { lat: number; lng: number }) {
    const expired = !modelValidFor();
    if (expired) {
      // Refuse to correct with a model past its validity rather than apply a
      // drifting one silently: a stale correction looks exactly like a good one.
      dec = null;
      if (decEl)
        decEl.textContent = `Magnetic model expired (${WMM_VALID_TO.toFixed(0)}) — headings are magnetic, uncorrected.`;
      return;
    }
    const { lat, lng } = pos ?? here();
    dec = declination(lat, lng);
    if (decEl)
      decEl.textContent = `Declination here: ${formatDeclination(dec)} — true north is ${
        dec > 0 ? "left of" : dec < 0 ? "right of" : "the same as"
      } the needle.`;
  }

  /**
   * Point the needle, taking the short way round.
   *
   * The angle handed to CSS is accumulated rather than wrapped. `rotate()`
   * interpolates the number it is given, and the needle has a transition, so
   * handing it -1deg straight after -359deg turns it 358 degrees backwards
   * instead of 2 forwards — walk past north and the needle spins the long way
   * round, then unwinds again coming back. Tracking a running angle that only
   * ever moves by the shortest signed step keeps what CSS sees continuous even
   * though the heading it came from does not.
   */
  function setNeedle(heading: number) {
    needleAngle += shortestTurn(needleAngle, -heading);
    if (needle) needle.style.transform = `rotate(${needleAngle}deg)`;
  }

  function onOrientation(e: DeviceOrientationEvent) {
    const mag = headingFrom(e);
    if (mag == null) return;
    gotReading = true;
    window.clearTimeout(noSensorTimer);

    const corrected = dec != null;
    const heading = corrected ? magneticToTrue(mag, dec!) : mag;

    if (note)
      note.textContent = corrected
        ? `True heading, corrected for declination. Magnetic reads ${Math.round(mag)}°.`
        : "Magnetic heading — true north differs by local declination.";
    if (readout)
      readout.textContent = `${Math.round(heading)}° ${cardinal(heading)}${corrected ? " true" : " mag"}`;
    // The needle shows where NORTH is relative to the way you're facing.
    setNeedle(heading);
  }

  function start() {
    if (listening) return;
    listening = true;
    gotReading = false;
    if (readout) readout.textContent = "—";
    if (note) note.textContent = "Listening for the compass…";

    // Prefer the absolute event where it exists (Android).
    window.addEventListener("deviceorientationabsolute" as any, onOrientation);
    window.addEventListener("deviceorientation", onOrientation);

    noSensorTimer = window.setTimeout(() => {
      if (!gotReading && note) note.textContent = NO_SENSOR;
    }, 3000);
  }

  function stop() {
    listening = false;
    window.clearTimeout(noSensorTimer);
    window.removeEventListener("deviceorientationabsolute" as any, onOrientation);
    window.removeEventListener("deviceorientation", onOrientation);
  }

  document.getElementById("compass-open")?.addEventListener("click", async () => {
    // Read the constructor off `window`, never as a bare global: WebKitGTK
    // doesn't define DeviceOrientationEvent at all, and a bare reference to an
    // undeclared binding throws ReferenceError before any `?.` can guard it —
    // which killed the whole handler on Linux instead of showing the fallback.
    const doe = (window as any).DeviceOrientationEvent;
    box?.classList.remove("hidden");
    if (readout) readout.textContent = "—";

    // The motion-permission prompt MUST be requested straight from this gesture:
    // iOS drops the user-gesture context after the first await, so this has to
    // come before we go off to fetch a location.
    let motionDenied = false;
    if (doe && typeof doe.requestPermission === "function") {
      try {
        motionDenied = (await doe.requestPermission()) !== "granted";
      } catch {
        /* fall through; the no-sensor timeout will explain */
      }
    }

    // Go to the user's actual location first, so the needle and declination are
    // for where they are — not wherever the map happened to be left. The map is
    // centred there as a side effect. Falls back to the map centre if there's
    // no fix (desktop, denied, offline).
    let pos: { lat: number; lng: number } | null = null;
    if (locate) {
      if (note) note.textContent = "Finding your location…";
      try {
        pos = await locate();
      } catch {
        /* map centre */
      }
    }
    // The panel can be closed during the location wait (compass-close, the ☰
    // toggle, another panel). Bail before touching it or starting the sensor:
    // the observer that stops the sensor already fired while nothing was
    // listening, and it won't fire again — so start() here would leave the
    // compass running on a hidden panel, the drain the observer exists to stop.
    if (box?.classList.contains("hidden")) return;

    // Declination is worth showing even with no magnetometer: it's the number
    // you write on a printed map before navigating from it with a real compass.
    refreshDeclination(pos ?? undefined);

    if (motionDenied) {
      // Falling through to start() overwrote this with "Listening…" and then
      // "No compass on this device" — telling someone holding a phone their
      // hardware is missing, and hiding the one action that would fix it.
      if (note)
        note.textContent =
          "Compass permission denied — allow Motion & Orientation access in Settings, then reopen this panel.";
      return;
    }
    if (!doe) {
      if (note) note.textContent = NO_SENSOR;
      return;
    }
    start();
  });

  document.getElementById("compass-close")?.addEventListener("click", () => {
    box?.classList.add("hidden");
  });

  // The panel manager (panels.ts) can also hide the box — from the ☰ button
  // toggle or by opening another panel — so stop whenever it goes hidden,
  // however that happened. Leaving the sensor running would just burn battery.
  if (box) {
    new MutationObserver(() => {
      if (box.classList.contains("hidden")) stop();
    }).observe(box, { attributes: true, attributeFilter: ["class"] });
  }
}
