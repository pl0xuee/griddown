/**
 * The overprint — the one reserved hue in the interface.
 *
 * On a USGS topographic quadrangle, the magenta overprint marks everything
 * added on top of the original survey: features revised from aerial photography
 * and never field-checked. That is exactly what a pin you dropped is, so this
 * hue means one thing here and only one thing — *you* put this on the sheet*.
 *
 * It applies to your waypoints, your recorded tracks and the route you asked
 * for. It does not apply to anything the map itself knows: roads, water, land
 * cover, contours. It is also the one hue no terrain feature uses (forest roads
 * are brown, water cyan, camp amber, public land green), so a magenta line can
 * never be misread as map data.
 *
 * Measurements are deliberately NOT overprinted. They stay amber because they
 * are a transient tool rather than a mark you keep, and the colour split is
 * what tells the two apart at a glance.
 *
 * These mirror --overprint / --overprint-lift in styles.css. Map layers are
 * painted from JS and CSS custom properties cannot reach them, so the values
 * live here and both sides refer to the same documented pair. If you change one,
 * change the other.
 */

/** Where you are going, and what you marked. */
export const OVERPRINT = "#e8177f";

/** Where you have been — the same hue, lifted, for breadcrumb tracks. */
export const OVERPRINT_LIFT = "#ff6fb0";

/**
 * Casing drawn under an overprinted line so it stays legible over anything —
 * snow, rock, dark forest. Near-black with the hue still in it, so the line
 * reads as one object rather than a bright stripe on a grey one.
 */
export const OVERPRINT_CASING = "#2a0316";
