import { invoke } from "@tauri-apps/api/core";
import { toast } from "./toast";

// Saving exported files (PDF, GPX, backups).
//
// In the desktop app this goes through the `save_file` Rust command, which
// writes to the Downloads folder and returns the real path — WebKitGTK never
// handles `<a download>`, so the old anchor trick silently dropped files.
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

/**
 * Save bytes as a file the user can find. Returns the saved path (desktop)
 * or null (browser fallback / failure — a toast is shown either way).
 */
export async function saveFile(
  name: string,
  data: Uint8Array | string,
  mime: string
): Promise<string | null> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;

  if (inTauri) {
    try {
      const path = await invoke<string>("save_file", {
        name,
        b64: toBase64(bytes),
      });
      toast(`Saved to ${path}`, "success", 6000);
      return path;
    } catch (e) {
      toast(`Couldn't save ${name}: ${e}`, "error");
      return null;
    }
  }

  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Saved ${name} to your downloads`, "success");
  return null;
}
