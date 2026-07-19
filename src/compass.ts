// Compass — which way am I facing. Pure device-sensor, fully offline.
//
// iOS: needs DeviceOrientationEvent.requestPermission() from a user gesture,
// and reports `webkitCompassHeading` (degrees clockwise from magnetic north).
// Android/others: `deviceorientationabsolute` (or absolute deviceorientation)
// with `alpha`, where heading = 360 - alpha.
// Desktops usually have no magnetometer — say so instead of spinning aimlessly.

const NO_SENSOR =
  "No compass on this device. Most desktops have no magnetometer — use a phone or tablet in the field.";

const CARDINALS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

export function cardinal(deg: number): string {
  return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Extract a compass heading (° CW from north) from an orientation event. */
function headingFrom(e: DeviceOrientationEvent): number | null {
  const webkit = (e as any).webkitCompassHeading;
  if (typeof webkit === "number" && webkit >= 0) return webkit; // iOS
  if (e.absolute && e.alpha != null) return (360 - e.alpha + 360) % 360;
  return null;
}

export function initCompass() {
  const box = document.getElementById("compass-box");
  const readout = document.getElementById("compass-readout");
  const needle = document.getElementById("compass-needle");
  const note = document.getElementById("compass-note");

  let listening = false;
  let gotReading = false;
  let noSensorTimer = 0;

  function onOrientation(e: DeviceOrientationEvent) {
    const h = headingFrom(e);
    if (h == null) return;
    gotReading = true;
    window.clearTimeout(noSensorTimer);
    if (note) note.textContent = "Magnetic heading — true north differs by local declination.";
    if (readout) readout.textContent = `${Math.round(h)}° ${cardinal(h)}`;
    // The needle shows where NORTH is relative to the way you're facing.
    if (needle) needle.style.transform = `rotate(${-h}deg)`;
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
    if (!doe) {
      box?.classList.remove("hidden");
      if (readout) readout.textContent = "—";
      if (note) note.textContent = NO_SENSOR;
      return;
    }
    // iOS gates the sensor behind a permission prompt that MUST come from a
    // user gesture — this click is that gesture.
    if (typeof doe.requestPermission === "function") {
      try {
        const res = await doe.requestPermission();
        if (res !== "granted") {
          if (note) note.textContent = "Compass permission denied — allow motion access in Settings.";
        }
      } catch {
        /* fall through; the no-sensor timeout will explain */
      }
    }
    box?.classList.remove("hidden");
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
