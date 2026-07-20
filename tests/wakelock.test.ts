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

function fakeWakeLock() {
  const released: boolean[] = [];
  let granted = 0;
  return {
    released,
    get granted() {
      return granted;
    },
    request: vi.fn(async () => {
      granted += 1;
      return {
        released: false,
        release: vi.fn(async () => {
          released.push(true);
        }),
      };
    }),
  };
}

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
