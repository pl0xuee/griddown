import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "./toast";

// Update check — deliberately MANUAL, and deliberately quiet.
//
// This app's whole premise is that the internet may not be there. So:
//  - nothing runs on startup; you ask for it, or it never happens
//  - being offline is a normal answer, not an error
//  - it never touches downloaded map packs, terrain, or your marks — an update
//    replaces the application binary and nothing else
//  - it can't run in development at all (the plugin is compiled out of debug
//    builds, so `check()` would throw)

let busy = false;

export function initUpdater() {
  const btn = document.getElementById("update-check");
  btn?.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    btn.setAttribute("disabled", "");
    try {
      toast("Checking for updates…");
      const update = await check();
      if (!update) {
        toast("You're on the latest version.", "success");
        return;
      }
      const ok = confirm(
        `GridDown ${update.version} is available (you have ${update.currentVersion}).\n\n` +
          `${update.body ?? ""}\n\n` +
          `Download and install it now? Your maps, terrain and saved marks are not affected — ` +
          `only the app itself is replaced. The app will restart.`
      );
      if (!ok) return;

      let total = 0;
      let got = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") {
          total = e.data.contentLength ?? 0;
          toast("Downloading update…");
        } else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total) {
            const pct = Math.round((got / total) * 100);
            if (pct % 20 === 0) toast(`Downloading update… ${pct}%`);
          }
        }
      });
      toast("Update installed — restarting.", "success");
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
      btn?.removeAttribute("disabled");
    }
  });
}
