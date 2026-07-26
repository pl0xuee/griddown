// How much of the map is actually visible.
//
// A uniform padding is wrong when fitting anything to the screen, because the
// visible map is not the map element. Three different things eat into it:
//
//   - Chrome painted over the bottom: the dock, the on-map recompute button
//     that floats above it, the legend and the attribution strip.
//   - A panel, which takes a side on a desktop and the whole screen on a phone.
//   - The device itself. A notch and a home indicator are not elements and
//     nothing in the DOM reports them, so they have to be passed in — see
//     safeAreaInsets() below. Without that the top of a fitted route sits under
//     the status bar on every recent iPhone, which is the platform this app is
//     actually carried on.
//
// Measured rather than hard-coded, so it stays right as the insets and
// --dock-h change between devices and orientations.
//
// The maths is here, away from the DOM, because the route overview and the Plan
// panel fit lines to this same screen. Two copies of it would stay in step right
// up until one of them was fixed.

/** The parts of a DOMRect this needs. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface Padding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PaddingInput {
  canvas: Rect;
  /**
   * Everything painted over the map from below — dock, recompute button,
   * legend. The tallest wins; nulls are skipped so a caller can pass elements
   * that may not exist yet.
   */
  bottom?: (Rect | null | undefined)[];
  /** A side panel, padded for only when it leaves usable map beside it. */
  panel?: Rect | null;
  /** Safe-area insets. See safeAreaInsets(). */
  insets?: { top?: number; right?: number; bottom?: number; left?: number };
  gap?: number;
}

/** Breathing room, so a fitted line never touches an edge. */
export const GAP = 24;

export function computePadding(input: PaddingInput): Padding {
  const { canvas, bottom = [], panel = null, insets = {}, gap = GAP } = input;

  // How far up from the bottom of the canvas the lowest piece of chrome reaches.
  let covered = 0;
  for (const r of bottom) {
    if (!r) continue;
    covered = Math.max(covered, canvas.bottom - r.top);
  }
  // The dock's own box already includes the home-indicator inset it pads for,
  // so take the larger of the two rather than adding them — adding double-counts
  // it on exactly the devices that have one.
  covered = Math.max(covered, insets.bottom ?? 0, 0);

  let top = gap + (insets.top ?? 0);
  let bottomPad = gap + covered;
  let left = gap + (insets.left ?? 0);
  let right = gap + (insets.right ?? 0);

  // A panel open over the map takes a side on desktop and the whole screen on a
  // phone. Only pad for it when it leaves something worth fitting into.
  if (panel && panel.width < canvas.width * 0.6) {
    if (panel.left - canvas.left < canvas.width * 0.2) left += panel.width;
    else right += panel.width;
  }

  // Never let the padding exceed the viewport: MapLibre cannot fit into a
  // negative box, and a tall route on a short screen gets close.
  const capV = Math.max(0, (canvas.height - 40) / 2);
  const capH = Math.max(0, (canvas.width - 40) / 2);
  return {
    top: Math.min(top, capV),
    bottom: Math.min(bottomPad, capV),
    left: Math.min(left, capH),
    right: Math.min(right, capH),
  };
}

/** Read an element's box, treating a hidden element as absent. */
export function visibleBox(el: Element | null | undefined): Rect | null {
  return el && !el.classList.contains("hidden") ? el.getBoundingClientRect() : null;
}

/**
 * The device's safe-area insets, in CSS pixels.
 *
 * `env(safe-area-inset-*)` cannot be read from script directly, so styles.css
 * copies the four values onto :root as --sai-* and this reads them back. Zero
 * everywhere without a notch, which is every desktop.
 */
export function safeAreaInsets(): Padding {
  const read = (name: string): number => {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name);
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  };
  return {
    top: read("--sai-top"),
    right: read("--sai-right"),
    bottom: read("--sai-bottom"),
    left: read("--sai-left"),
  };
}
