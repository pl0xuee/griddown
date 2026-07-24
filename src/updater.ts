import { toast } from "./toast";
import { confirmAction } from "./dialog";

// Update check — deliberately MANUAL, and deliberately quiet.
//
// This app's whole premise is that the internet may not be there. So:
//  - nothing runs on startup; you ask for it, or it never happens
//  - being offline is a normal answer, not an error
//  - it never touches downloaded map packs, terrain, or your marks — an update
//    replaces the application binary and nothing else
//  - it can't run in development at all (the plugin is compiled out of debug
//    builds, so `check()` would throw)
//  - it doesn't exist on mobile at all (see below)

let busy = false;

export function initUpdater() {
  const btn = document.getElementById("update-check");
  if (!btn) return;

  // Show the button only where in-app update actually works — desktop. iOS and
  // Android update through their stores, and the updater/process plugins are
  // compiled out of mobile builds, so the button would fire IPC at a plugin
  // that isn't there.
  //
  // The answer comes from the backend (`cfg!(desktop)`), not from the user
  // agent: the old check sniffed the UA for "iPad", and iPadOS reports a
  // *desktop* Safari UA, so the button stayed on iPad. The button starts
  // hidden and is revealed only once desktop is confirmed, so it never flashes
  // on a phone or tablet, and stays gone in a browser where there is no updater
  // at all.
  void (async () => {
    let supported = false;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      supported = await invoke<boolean>("updates_supported");
    } catch {
      supported = false; // not running under Tauri (a browser), or no command
    }
    if (!supported) {
      btn.remove();
      return;
    }
    btn.hidden = false;
    wireUpdateButton(btn);
  })();
}

function wireUpdateButton(btn: HTMLElement) {
  btn.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    btn.setAttribute("disabled", "");
    try {
      // Imported lazily so the mobile bundle never pulls in plugin JS whose
      // Rust half doesn't exist.
      const { check } = await import("@tauri-apps/plugin-updater");
      toast("Checking for updates…");
      const update = await check();
      if (!update) {
        toast("You're on the latest version.", "success");
        return;
      }
      const ok = await confirmAction(
        `GridDown ${update.version} is available (you have ${update.currentVersion}).\n\n` +
          `${update.body ?? ""}\n\n` +
          `Download and install it now? Your maps, terrain and saved marks are not affected — ` +
          `only the app itself is replaced. The app will restart.`
      );
      if (!ok) return;

      let total = 0;
      let got = 0;
      // Report each 20% band once. Testing `pct % 20 === 0` fired per *chunk*,
      // and a percent of a 20 MB installer spans several 8-64 KB chunks — so
      // each milestone stacked up a handful of identical toasts, each of which
      // sits on screen for 3.4 s, over the install.
      let lastBand = -1;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") {
          total = e.data.contentLength ?? 0;
          toast("Downloading update…");
        } else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total) {
            const band = Math.min(5, Math.floor((got / total) * 5));
            if (band > lastBand) {
              lastBand = band;
              if (band > 0) toast(`Downloading update… ${band * 20}%`);
            }
          }
        }
      });
      toast("Update installed — restarting.", "success");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      // No connection is the expected case for this app, not a failure worth
      // an alarming red toast.
      const msg = err instanceof Error ? err.message : String(err);
      const offline = /network|connect|dns|resolve|timed? ?out|unreachable/i.test(msg);
      toast(
        offline
          ? "Can't reach the update server — you're offline. The app works fine without it."
          : `Update check failed: ${msg}`,
        offline ? "info" : "error",
        6000
      );
    } finally {
      busy = false;
      btn.removeAttribute("disabled");
    }
  });
}
