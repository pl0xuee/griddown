import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { keepMapSized } from "../src/mapsize";

/**
 * jsdom has no ResizeObserver, so the tests supply one and drive it by hand.
 *
 * `deliver()` is the whole point of this fake. A real ResizeObserver calls back
 * once as soon as it starts observing, whether or not anything has changed —
 * and that first callback is the one MapLibre discards, so it is the one these
 * tests have to be able to fire.
 */
class FakeResizeObserver {
  static live: FakeResizeObserver[] = [];
  targets: Element[] = [];
  constructor(private cb: () => void) {
    FakeResizeObserver.live.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  disconnect() {
    this.targets = [];
  }
  deliver() {
    this.cb();
  }
  static get last() {
    return FakeResizeObserver.live[FakeResizeObserver.live.length - 1];
  }
}

/** jsdom reports 0 for every clientWidth; shadow the getter with a real size. */
function setSize(el: Element, w: number, h: number) {
  Object.defineProperty(el, "clientWidth", { value: w, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: h, configurable: true });
}

function sizedEl(w: number, h: number): HTMLElement {
  const el = document.createElement("div");
  setSize(el, w, h);
  return el;
}

/**
 * A map stub sized the way MapLibre sizes itself: the canvas carries an inline
 * width/height written from whatever the container measured at construction.
 * `resize()` re-reads the container, exactly as the real one does.
 */
function fakeMap(w: number, h: number) {
  const container = sizedEl(w, h);
  const canvas = sizedEl(w, h);
  const resize = vi.fn(() => setSize(canvas, container.clientWidth, container.clientHeight));
  return {
    container,
    canvas,
    resize,
    map: { getContainer: () => container, getCanvas: () => canvas, resize },
  };
}

describe("keepMapSized", () => {
  beforeEach(() => {
    FakeResizeObserver.live = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The iPhone bug, in full.
   *
   * The map is built while WKWebView still has the page at its pre-layout size.
   * A frame later the webview lays out again — final window bounds, safe-area
   * insets — and the container becomes 46px shorter. That change arrives as the
   * ResizeObserver's FIRST callback, which MapLibre drops on the floor, so the
   * canvas keeps the height it was born with for the rest of the session.
   *
   * A 390x844 canvas in a 390x798 container puts the map's centre 23px above
   * the centre of the screen — and #crosshair is pinned to the centre of the
   * screen, which is why the GPS dot lands 23px off it and stays there.
   */
  it("resizes when the first observation carries a size the constructor never saw", () => {
    const { map, container, canvas, resize } = fakeMap(390, 844);
    keepMapSized(map);

    setSize(container, 390, 798);
    FakeResizeObserver.last.deliver();

    expect(resize).toHaveBeenCalledTimes(1);
    expect([canvas.clientWidth, canvas.clientHeight]).toEqual([390, 798]);
  });

  it("corrects a mismatch that is already there when it is wired up", () => {
    // Belt and braces for the same race landing a frame earlier: the container
    // has already moved on by the time this runs, and no observation is coming
    // because nothing will change size again.
    const { map, container, canvas, resize } = fakeMap(390, 844);
    setSize(container, 390, 798);

    keepMapSized(map);

    expect(resize).toHaveBeenCalledTimes(1);
    expect([canvas.clientWidth, canvas.clientHeight]).toEqual([390, 798]);
  });

  it("leaves a map that already matches its container alone", () => {
    // MapLibre keeps its own observer, so resizing on every callback would mean
    // two resizes per rotation and a re-render for callbacks that changed nothing.
    const { map, resize } = fakeMap(390, 844);
    keepMapSized(map);
    FakeResizeObserver.last.deliver();
    FakeResizeObserver.last.deliver();

    expect(resize).not.toHaveBeenCalled();
  });

  it("resizes once, not once per observation, for a single change", () => {
    const { map, container, resize } = fakeMap(390, 844);
    keepMapSized(map);

    setSize(container, 844, 390);
    FakeResizeObserver.last.deliver();
    FakeResizeObserver.last.deliver();

    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("keeps up with later changes, like turning the phone", () => {
    const { map, container, canvas, resize } = fakeMap(390, 844);
    keepMapSized(map);

    setSize(container, 844, 390); // landscape
    FakeResizeObserver.last.deliver();
    setSize(container, 390, 844); // and back
    FakeResizeObserver.last.deliver();

    expect(resize).toHaveBeenCalledTimes(2);
    expect([canvas.clientWidth, canvas.clientHeight]).toEqual([390, 844]);
  });

  it("ignores a container that measures nothing", () => {
    // Detached, or display:none. MapLibre's fallback for a zero-sized container
    // is a hardcoded 400x300, so resizing into that state is strictly worse than
    // leaving the map at the size it had.
    const { map, container, resize } = fakeMap(390, 844);
    keepMapSized(map);

    setSize(container, 0, 0);
    FakeResizeObserver.last.deliver();

    expect(resize).not.toHaveBeenCalled();
  });

  it("watches the map's own container", () => {
    const { map, container } = fakeMap(390, 844);
    keepMapSized(map);
    expect(FakeResizeObserver.last.targets).toEqual([container]);
  });
});
