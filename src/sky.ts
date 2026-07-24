import * as SunCalc from "suncalc";

// Sun & moon times for the map center, computed offline (no data needed).

export function fmtTime(d: Date | undefined | null): string {
  if (!d || isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Moonrise/moonset rows, honouring SunCalc's alwaysUp/alwaysDown flags.
 *
 * Without them both cases render as "—", so "the moon is up all night" (very
 * good for moving after dark) is indistinguishable from "no result" — at high
 * latitudes, where it actually happens, and where that light matters most.
 */
export function moonUpDown(mt: { rise?: Date; set?: Date; alwaysUp?: boolean; alwaysDown?: boolean }): string {
  const row = (k: string, v: string) =>
    `<div class="sky-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  if (mt.alwaysUp) return row("Moon", "Up all night");
  if (mt.alwaysDown) return row("Moon", "Never rises today");
  return row("Moonrise", fmtTime(mt.rise)) + row("Moonset", fmtTime(mt.set));
}

/**
 * How far the map centre's timezone is from this device's, in whole hours.
 *
 * The times below are computed for the crosshair but rendered with
 * `toLocaleTimeString`, i.e. in the *device's* zone. That is right in the normal
 * case — you are standing where you are looking — and wrong the moment you pan
 * to another zone to plan, which the panel gave no hint about.
 *
 * Converting instead would be worse: a longitude-derived zone is standard time,
 * so it would shift a user at home by an hour all summer. Comparing against the
 * device's *standard* offset (the larger of its January and July offsets, north
 * of the equator) keeps DST from reading as a mismatch.
 */
export function zoneOffsetHours(lng: number, now: Date): number {
  const y = now.getFullYear();
  const jan = new Date(y, 0, 1).getTimezoneOffset();
  const jul = new Date(y, 6, 1).getTimezoneOffset();
  const deviceStdHours = -Math.max(jan, jul) / 60;
  return Math.round(lng / 15) - deviceStdHours;
}

export function moonPhaseName(phase: number): string {
  if (phase < 0.03 || phase > 0.97) return "New moon";
  if (phase < 0.22) return "Waxing crescent";
  if (phase < 0.28) return "First quarter";
  if (phase < 0.47) return "Waxing gibbous";
  if (phase < 0.53) return "Full moon";
  if (phase < 0.72) return "Waning gibbous";
  if (phase < 0.78) return "Last quarter";
  return "Waning crescent";
}

export function dayLength(sunrise: Date | null | undefined, sunset: Date | null | undefined): string {
  if (!sunrise || !sunset || isNaN(sunrise.getTime()) || isNaN(sunset.getTime())) return "—";
  let mins = Math.round((sunset.getTime() - sunrise.getTime()) / 60000);
  if (mins < 0) mins += 1440;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function initSky(getCenter: () => { lat: number; lng: number }) {
  refreshSkyIcon();
  // The phase moves slowly; once an hour is ample and costs nothing.
  window.setInterval(refreshSkyIcon, 3600_000);
  const panel = document.getElementById("sky-panel");
  const content = document.getElementById("sky-content");
  const sub = document.getElementById("sky-sub");

  function render() {
    if (!content) return;
    const { lat, lng } = getCenter();
    const now = new Date();
    const t = SunCalc.getTimes(now, lat, lng);
    const moon = SunCalc.getMoonIllumination(now);
    const mt = SunCalc.getMoonTimes(now, lat, lng);

    if (sub) {
      // Say whose clock these times are on whenever it isn't the obvious one.
      const dh = zoneOffsetHours(lng, now);
      const zone = dh === 0
        ? ""
        : ` · times in YOUR clock — this point is ${Math.abs(dh)}h ${dh < 0 ? "behind" : "ahead"}`;
      sub.textContent = `${lat.toFixed(3)}, ${lng.toFixed(3)} · ${now.toLocaleDateString(
        [],
        { weekday: "short", month: "short", day: "numeric" }
      )} · computed offline${zone}`;
    }

    const sunRows: [string, Date | null | undefined][] = [
      ["First light", t.dawn],
      ["Sunrise", t.sunrise],
      ["Solar noon", t.solarNoon],
      ["Sunset", t.sunset],
      ["Last light", t.dusk],
    ];

    content.innerHTML = `
      <div class="sky-block">
        <h4>☀ SUN</h4>
        ${sunRows.map(([k, v]) => `<div class="sky-row"><span class="k">${k}</span><span class="v">${fmtTime(v)}</span></div>`).join("")}
        <div class="sky-daylen">Daylight: <b>${dayLength(t.sunrise, t.sunset)}</b></div>
      </div>
      <div class="sky-block">
        <h4>☾ MOON</h4>
        <div class="sky-row"><span class="k">Phase</span><span class="v sky-moon-name">${moonPhaseName(moon.phase)}</span></div>
        <div class="sky-row"><span class="k">Illumination</span><span class="v">${Math.round(moon.fraction * 100)}%</span></div>
        ${moonUpDown(mt)}
      </div>`;
  }

  document.getElementById("sky-open")?.addEventListener("click", () => {
    render();
    panel?.classList.remove("hidden");
  });
  document.getElementById("sky-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });
}

/**
 * A glyph for tonight's moon, for the HUD icon.
 *
 * The icon may as well carry information: how much moon there will be decides
 * whether you can move after dark without a light, which is the main reason to
 * open this panel at all.
 */
export function moonGlyph(phase: number): string {
  const p = ((phase % 1) + 1) % 1;
  if (p < 0.03 || p > 0.97) return "\u{1F311}"; // new
  if (p < 0.22) return "\u{1F312}";
  if (p < 0.28) return "\u{1F313}"; // first quarter
  if (p < 0.47) return "\u{1F314}";
  if (p < 0.53) return "\u{1F315}"; // full
  if (p < 0.72) return "\u{1F316}";
  if (p < 0.78) return "\u{1F317}"; // last quarter
  return "\u{1F318}";
}

/** Put tonight's phase on the HUD icon. */
export function refreshSkyIcon() {
  const el = document.getElementById("sky-open");
  if (!el) return;
  try {
    const phase = SunCalc.getMoonIllumination(new Date()).phase;
    (el.querySelector(".hud-icon-glyph") ?? el).textContent = moonGlyph(phase);
    el.title = `Sun & moon — ${moonPhaseName(phase).toLowerCase()}`;
  } catch {
    /* leave the static glyph */
  }
}
