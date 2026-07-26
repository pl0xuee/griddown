// Keep the screen awake while something long is running.
//
// A state pack is 237 MB to 1.5 GB. On a phone that is minutes, and the screen
// will lock long before it finishes — at which point iOS suspends the app, every
// socket it holds dies, and the download fails. Holding a wake lock for the
// duration is the cheapest fix available: it prevents the suspension rather than
// trying to recover from it.
//
// Deliberately best-effort. The Screen Wake Lock API is absent on some of the
// platforms this app targets (notably older webkit2gtk on Linux), and a failure
// to acquire it must never stop a download from starting — it just means the
// user should keep the screen on themselves.

type Sentinel = { released: boolean; release: () => Promise<void> };

let sentinel: Sentinel | null = null;
// Reference-counted: several downloads (basemap, terrain, forest roads) can
// overlap, and the first one to finish must not drop the lock for the others.
let holders = 0;

function supported(): boolean {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

// One request in flight at a time. Asking is asynchronous, and the basemap,
// terrain and forest-road downloads can start together — two callers both found
// `sentinel` still null, both asked the system, and the second grant overwrote
// the first. The first was then held for the rest of the session with nobody
// left holding a reference to release it.
let pending: Promise<void> | null = null;

function request(): Promise<void> {
  // A sentinel the system already released is a dead object, not a held lock —
  // it stays non-null after release, so testing it alone would wedge us here
  // forever and make the re-acquire below unreachable.
  if (!supported() || (sentinel && !sentinel.released)) return Promise.resolve();
  if (pending) return pending;
  sentinel = null;
  pending = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s: Sentinel = await (navigator as any).wakeLock.request("screen");
      if (holders === 0) {
        // Everyone finished while we were waiting — a re-acquire on
        // visibilitychange can race a download that ends at the same moment.
        // Hand it straight back rather than hold a lock nobody asked for.
        void s.release().catch(() => {});
        return;
      }
      sentinel = s;
    } catch {
      // Denied, or the document isn't visible. Not worth surfacing: the
      // download works regardless, it just isn't protected from the screen
      // locking.
      sentinel = null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

// The system drops the lock whenever the page is hidden — switching apps, or the
// screen turning off before we asked. Re-acquire on the way back, or the lock is
// silently gone for the rest of a long download.
function onVisible() {
  if (document.visibilityState === "visible" && holders > 0) void request();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", onVisible);
}

/**
 * Hold the screen awake until the returned function is called.
 *
 * Always returns a release function, whether or not a lock was actually
 * obtained, so callers can use it in a `finally` without checking anything.
 */
export async function keepAwake(): Promise<() => void> {
  holders += 1;
  await request();

  let done = false;
  return () => {
    // Guard against a caller releasing twice, which would drop the count below
    // the real number of holders and release the lock while a download runs.
    if (done) return;
    done = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0 && sentinel) {
      const s = sentinel;
      sentinel = null;
      void s.release().catch(() => {});
    }
  };
}
