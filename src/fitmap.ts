// How much of the map is actually visible.
//
// A uniform padding is wrong when fitting anything to the screen, because the
// visible map is not the map element: the dock covers the bottom of it on a
// phone, the collar and command bar sit on top of that, and an open panel takes
// a whole side. Fitting to the raw container tucked the southern end of every
// route behind the dock — worst on exactly the routes you most want to see
// whole, since a long one is fitted tightly.
//
// Measured from the live chrome rather than hard-coded, so it stays right as the
// safe-area insets and --dock-h change between devices and orientations.
//
// The maths is here, away from the DOM, because both the route overview and the
// Plan panel fit lines to this same screen. Two copies of it would stay in step
// right up until one of them was fixed.

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

/** Breathing room, so a fitted line never touches an edge. */
export const GAP = 24;

export function computePadding(
  canvas: Rect,
  dock: Rect | null,
  panel: Rect | null,
  gap: number = GAP
): Padding {
  let top = gap;
  let bottom = gap + (dock ? Math.max(0, canvas.bottom - dock.top) : 0);
  let left = gap;
  let right = gap;

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
    bottom: Math.min(bottom, capV),
    left: Math.min(left, capH),
    right: Math.min(right, capH),
  };
}

/** Read an element's box, treating a hidden element as absent. */
export function visibleBox(el: Element | null | undefined): Rect | null {
  return el && !el.classList.contains("hidden") ? el.getBoundingClientRect() : null;
}
