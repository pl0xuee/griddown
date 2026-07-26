// Shared validation for data that arrives from a file rather than from us.
//
// Waypoints, tracks, plans, kits and the roster all come back from marks.json,
// from a restored backup, or from a GPX import — files someone else may have
// written. Everything downstream assumes these are strings and numbers, and a
// numeric `name` reaching `.replace()` takes out a whole panel. The guards live
// here rather than being reinvented per module.

/**
 * Ids end up in `data-*` attributes, so one containing a quote could break out
 * of the attribute. Constrained here as well as escaped on output — a restored
 * backup must not be able to smuggle markup into a panel.
 */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const isId = (v: unknown): v is string =>
  typeof v === "string" && ID_RE.test(v);

export const isStr = (v: unknown): v is string => typeof v === "string";

export const isOptStr = (v: unknown): v is string | undefined =>
  v === undefined || typeof v === "string";

export const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** A point on Earth, not merely two finite numbers. */
export function isLatLng(lat: unknown, lng: unknown): boolean {
  return (
    isNum(lat) && isNum(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  );
}

/** A [lng, lat] pair, as stored in route geometry. */
export function isLngLat(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length >= 2 && isLatLng(v[1], v[0]);
}
