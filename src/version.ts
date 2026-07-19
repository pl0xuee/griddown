import { getVersion } from "@tauri-apps/api/app";

// Show which build is running.
//
// Worth having for a reason beyond tidiness: an update that silently didn't
// apply, and an update that applied, look identical without it — and the same
// goes for "is the bug you're describing already fixed?". Read from Tauri so it
// reflects the actual installed binary rather than a number compiled into the
// frontend, which could drift from it.
export async function initVersion() {
  const el = document.getElementById("app-version");
  if (!el) return;
  try {
    el.textContent = `v${await getVersion()}`;
  } catch {
    // Browser/dev without the Tauri backend: say so rather than showing a
    // version that isn't really the app's.
    el.textContent = "(dev)";
  }
}
