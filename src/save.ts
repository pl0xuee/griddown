import { invoke } from "@tauri-apps/api/core";
import { toast } from "./toast";

// Saving exported files (PDF, GPX, backups).
//
// In the app this goes through the `save_file` Rust command, which writes to
// Downloads on desktop and to the app's Documents folder on iOS (which has no
// Downloads, and refuses the write) — WebKitGTK never handles `<a download>`,
// so the old anchor trick silently dropped files.
// In a plain browser (dev) the anchor still works, so it stays as fallback.

const inTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000; // keep the fromCharCode arg list within limits
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** What became of an export. `path` is null in the browser fallback, where
 *  the download is the browser's business and we never learn where it went. */
export type SaveOutcome =
  | { ok: false }
  | { ok: true; path: string | null; location: string; durable: boolean };

/**
 * Save bytes as a file the user can find, and report what became of it —
 * including whether where it landed survives the app being deleted.
 *
 * Callers that only need the path can use `saveFile` below.
 *
 * `announce` controls the SUCCESS toast only. It is on for every export that
 * genuinely ends where it says it does, and off for the backup path: there the
 * location on iOS is the app's own container, and "Saved to Files → On My
 * iPhone → GridDown" is the durability promise this app must stop making —
 * especially just before an export picker opens, where it reads like
 * instructions. backup.ts owns the success message in that case, once it knows
 * the copy actually landed outside. A failure is announced either way, because
 * runBackup gives up on `!ok` trusting that the reason has already been shown.
 */
export async function saveExport(
  name: string,
  data: Uint8Array | string,
  mime: string,
  announce: boolean = true
): Promise<SaveOutcome> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;

  if (inTauri) {
    try {
      // `location` is what to show a human and `path` is the real file: on iOS
      // they differ, because the path there is a container UUID nobody can act
      // on. The backend decides which is which — the user agent can't be asked,
      // since iPadOS reports itself as desktop Safari (see updater.ts). It
      // decides `durable` for the same reason.
      const saved = await invoke<{
        path: string;
        location: string;
        durable: boolean;
      }>("save_file", { name, b64: toBase64(bytes) });
      if (announce) toast(`Saved to ${saved.location}`, "success", 6000);
      return {
        ok: true,
        path: saved.path,
        location: saved.location,
        durable: saved.durable,
      };
    } catch (e) {
      toast(`Couldn't save ${name}: ${e}`, "error");
      return { ok: false };
    }
  }

  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  if (announce) toast(`Saved ${name} to your downloads`, "success");
  // A browser download lands in the real Downloads folder, which is not going
  // anywhere when an app is uninstalled.
  return { ok: true, path: null, location: "your downloads", durable: true };
}

/**
 * Save bytes as a file the user can find. Returns the saved path (desktop)
 * or null (browser fallback / failure — a toast is shown either way).
 */
export async function saveFile(
  name: string,
  data: Uint8Array | string,
  mime: string
): Promise<string | null> {
  const out = await saveExport(name, data, mime);
  return out.ok ? out.path : null;
}
