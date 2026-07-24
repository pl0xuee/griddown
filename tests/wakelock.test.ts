import { describe, it, expect, vi, beforeEach } from "vitest";

// The wake lock module reads navigator/document at import time, so the fake has
// to be installed before it loads — hence the dynamic import in each test.
async function loadWakelock(wakeLock?: unknown) {
  vi.resetModules();
  if (wakeLock === undefined) {
    // Simulate a platform without the API at all (older webkit2gtk on Linux).
    delete (navigator as unknown as Record<string, unknown>).wakeLock;
  } else {
    Object.defineProperty(navigator, "wakeLock", {
      value: wakeLock,
      configurable: true,
      writable: true,
    });
  }
  return await import("../src/wakelock");
}

/**
 * The sentinels handed out here are MUTABLE, because that is what makes the
 * real bug reproducible: the browser sets `released` to true on the object we
 * are still holding when the OS takes the lock away (app switch, screen off).
 * A hard-coded `released: false` cannot express that state at all.
 */
function fakeWakeLock() {
  const released: boolean[] = [];
  let granted = 0;
  const handed: { released: boolean }[] = [];
  return {
    released,
    handed,
    get granted() {
      return granted;
    },
    /** The sentinel most recently handed out — what the system would release. */
    get last() {
      return handed[handed.length - 1];
    },
    request: vi.fn(async () => {
      granted += 1;
      const s = {
        released: false,
        release: vi.fn(async () => {
          s.released = true;
          released.push(true);
        }),
      };
      handed.push(s);
      return s;
    }),
  };
}

/** jsdom's visibilityState is a getter; override it, then fire the event. */
function setVisible(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Let the module's `void request()` settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("keepAwake", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("acquires a screen lock and releases it", async () => {
    const wl = fakeWakeLock();
    const { keepAwake } = await loadWakelock(wl);

    const release = await keepAwake();
    expect(wl.request).toHaveBeenCalledWith("screen");
    expect(wl.granted).toBe(1);
    expect(wl.released).toHaveLength(0);

    release();
    // The release call is async internally; let the microtask queue drain.
    await Promise.resolve();
    expect(wl.released).toHaveLength(1);
  });

  it("holds the lock until the last concurrent holder releases", async () => {
    // The real case: basemap, terrain and forest-road downloads overlap. The
    // first one to finish must not drop the screen lock for the others.
    const wl = fakeWakeLock();
    const { keepAwake } = await loadWakelock(wl);

    const a = await keepAwake();
    const b = await keepAwake();
    expect(wl.granted).toBe(1); // one underlying lock, two holders

    a();
    await Promise.resolve();
    expect(wl.released).toHaveLength(0); // b still holds it

    b();
    await Promise.resolve();
    expect(wl.released).toHaveLength(1);
  });

  it("ignores a double release", async () => {
    // Releasing twice would drop the count below the number of real holders and
    // unlock the screen while a download is still running.
    const wl = fakeWakeLock();
    const { keepAwake } = await loadWakelock(wl);

    const a = await keepAwake();
    const b = await keepAwake();

    a();
    a();
    a();
    await Promise.resolve();
    expect(wl.released).toHaveLength(0); // b's hold survived a's over-release

    b();
    await Promise.resolve();
    expect(wl.released).toHaveLength(1);
  });

  /**
   * The bug that killed multi-gigabyte downloads: `request()` returned early on
   * any non-null sentinel, never asking whether it was still held. The system
   * drops the lock the moment the page is hidden — switching apps to check
   * something, the screen timing out before we asked — and it leaves the dead
   * sentinel object in place. So the coming-back-to-visible re-acquire could
   * never fire, the screen locked, iOS suspended the app, and the download died
   * minutes into a state pack.
   */
  it("re-acquires a lock the system released while we were hidden", async () => {
    const wl = fakeWakeLock();
    const { keepAwake } = await loadWakelock(wl);

    const release = await keepAwake();
    expect(wl.granted).toBe(1);

    // The OS takes the lock away. We still hold the object; it is just dead.
    wl.last.released = true;
    setVisible("visible");
    await flush();

    expect(wl.granted).toBe(2);
    expect(wl.last.released).toBe(false); // a live one this time

    release();
    await flush();
    expect(wl.released).toHaveLength(1);
  });

  it("does not stack a second lock while the first is still alive", async () => {
    // Coming back to visible with the lock intact must be a no-op, or every
    // app-switch leaks a sentinel we will never release.
    const wl = fakeWakeLock();
    const { keepAwake } = await loadWakelock(wl);

    const release = await keepAwake();
    setVisible("visible");
    await flush();
    expect(wl.granted).toBe(1);

    release();
    await flush();
  });

  it("does not re-acquire when nothing is being downloaded", async () => {
    // No holders means no reason to hold the screen awake — waking it up for
    // every tab switch would be a battery leak with nothing to protect.
    const wl = fakeWakeLock();
    const { keepAwake } = await loadWakelock(wl);

    const release = await keepAwake();
    release();
    await flush();
    expect(wl.granted).toBe(1);

    wl.last.released = true;
    setVisible("visible");
    await flush();
    expect(wl.granted).toBe(1);
  });

  it("ignores a visibilitychange that leaves the page hidden", async () => {
    const wl = fakeWakeLock();
    const { keepAwake } = await loadWakelock(wl);

    const release = await keepAwake();
    wl.last.released = true;
    setVisible("hidden");
    await flush();
    expect(wl.granted).toBe(1);

    setVisible("visible");
    await flush();
    expect(wl.granted).toBe(2);

    release();
    await flush();
  });

  it("still returns a usable release when the API is missing", async () => {
    const { keepAwake } = await loadWakelock(undefined);
    const release = await keepAwake();
    expect(typeof release).toBe("function");
    expect(() => release()).not.toThrow();
  });

  it("still returns a usable release when the request is denied", async () => {
    // Safari rejects if the document isn't visible. A download must start
    // anyway — an unprotected download beats no download.
    const denied = { request: vi.fn(async () => Promise.reject(new Error("denied"))) };
    const { keepAwake } = await loadWakelock(denied);
    const release = await keepAwake();
    expect(denied.request).toHaveBeenCalled();
    expect(() => release()).not.toThrow();
  });
});
