// Keep MapLibre's idea of how big it is in step with the element it lives in.
//
// MapLibre measures its container once, synchronously, in the constructor, and
// then watches it with a ResizeObserver — but it deliberately discards that
// observer's FIRST callback (`_setupResizeObserver`: `t ? i(e) : t = !0`), on
// the assumption that it can only be repeating the size the constructor just
// read.
//
// On iOS that assumption does not hold. WKWebView lays the page out again a
// frame after the script runs — final window bounds, safe-area insets — so the
// first observation carries the NEW size, and it is precisely the one thrown
// away. Nothing changes the container after that, so the map spends the rest of
// the session believing it is the size it was born at.
//
// The damage is not subtle once you know where to look. MapLibre's stylesheet
// gives `.maplibregl-canvas` no width or height at all: the canvas is sized by
// an inline style written from that stale measurement, pinned to the container's
// top left. So the map's centre — where the GPS dot is drawn, as a GL circle at
// the projected coordinate — sits at (staleW/2, staleH/2), while #crosshair is
// pinned to the centre of the screen. The two sit half the size difference
// apart and stay there. Turning the phone to landscape and back fixes it because
// that fires two further observations, and neither of those is the first one.
//
// So: watch the container ourselves, and reconcile on every callback including
// the first. It is a no-op whenever MapLibre has already kept up, which is every
// other platform and every later resize.

/**
 * The parts of a MapLibre map this needs, structurally — so the tests can hand
 * it a stub. jsdom has no WebGL context to build a real map with.
 */
type SizedMap = {
  getContainer(): Element;
  getCanvas(): Element;
  resize(): void;
};

/**
 * Hold the map's canvas to the size of its container, for the life of the map.
 *
 * Call it immediately after constructing the map. There is nothing to undo: the
 * map outlives everything else in the app.
 */
export function keepMapSized(map: SizedMap): void {
  const container = map.getContainer();

  const sync = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    // A container measuring nothing is detached or display:none, not a map that
    // wants to be nothing: MapLibre's fallback for a zero-sized container is a
    // hardcoded 400x300, which is strictly worse than the size it already has.
    if (!w || !h) return;
    // The canvas carries the size MapLibre last measured, in CSS pixels. Equal
    // means MapLibre is keeping up and calling resize() would only cost a
    // re-render — it has an observer of its own, so most callbacks land here.
    const canvas = map.getCanvas();
    if (canvas.clientWidth === w && canvas.clientHeight === h) return;
    map.resize();
  };

  // Once now, for the case where the container has already moved on by the time
  // this runs and no observation is coming, because nothing will change again.
  sync();
  new ResizeObserver(sync).observe(container);
}
