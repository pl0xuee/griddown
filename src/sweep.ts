// Pure viewshed sweep — no imports, so tests and (later) workers can use it.

const EYE_M = 1.7; // observer eye height above ground
export const R_EARTH = 6371000;
/**
 * Standard atmospheric refraction coefficient. Exported so the measure tool's
 * line-of-sight reads the same constant: the two used to disagree by ~6 m of
 * apparent bulge over a 30 mi shot, which is enough for a grazing sightline to
 * read Visible on the viewshed and Blocked in the measure panel.
 */
export const REFRACTION = 0.13;

export interface ViewshedResult {
  /** For each ray, for each step: was that sample visible? */
  visible: Uint8Array;
  rays: number;
  steps: number;
}

/**
 * Core sweep, pure so it's testable: `elevAt(distM, azimuthIndex)` returns
 * terrain height at that distance along that ray (or null = unknown).
 */
export function sweepViewshed(
  observerElevM: number,
  elevAt: (dist: number, ray: number) => number | null,
  opts: { rays: number; steps: number; stepM: number }
): ViewshedResult {
  const { rays, steps, stepM } = opts;
  const visible = new Uint8Array(rays * steps);
  const eye = observerElevM + EYE_M;
  for (let r = 0; r < rays; r++) {
    let maxAngle = -Infinity;
    for (let s = 1; s <= steps; s++) {
      const d = s * stepM;
      const ground = elevAt(d, r);
      if (ground == null) continue; // unknown terrain: neither blocks nor shows
      // Effective height after curvature + refraction drop.
      const drop = ((1 - REFRACTION) * d * d) / (2 * R_EARTH);
      const angle = (ground - drop - eye) / d;
      if (angle > maxAngle) {
        maxAngle = angle;
        visible[r * steps + (s - 1)] = 1;
      }
    }
  }
  return { visible, rays, steps };
}

