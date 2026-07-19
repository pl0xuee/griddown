/**
 * Escape text for interpolation into HTML — one implementation, used everywhere.
 *
 * "Untrusted" here is broader than it first looks. Place and road names come
 * from OpenStreetMap, which anyone in the world can edit, and they arrive
 * inside binary vector tiles that no one inspects. A pack can also be handed
 * over on a USB stick, which this app actively encourages. So map text is
 * attacker-controlled input, not app data.
 *
 * Escapes quotes as well as angle brackets, so the result is safe inside an
 * attribute value too — several call sites interpolate ids into `data-*`.
 */
export function esc(v: unknown): string {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}
