import type { SaveOutcome } from "./save";
import type { Marks, Track, Waypoint } from "./store";
import type { Plan } from "./plan";
import type { Kit } from "./kit";
import type { CommsPlan, Person } from "./roster";

// Backing up everything the user cannot regenerate, to somewhere that outlives
// the app.
//
// The second half of that sentence is the whole reason this module exists. On
// iOS `save_file` writes into the app container's own Documents directory —
// which the Files app shows as "On My iPhone → GridDown", so it reads like a
// folder outside the app and is not one. Deleting the app deletes the
// container, and the backup with it. That is not a hypothetical: it is how this
// was found.
//
// So a save is only half a backup on a phone. The other half is handing the
// file to the iOS export picker, which copies it wherever the user says —
// iCloud Drive, On My iPhone proper, another app — and that copy survives.
// Restore already reads from anywhere, through a plain <input type="file">.
//
// Every effect is injected. The real flow ends in a system picker, so this is
// the only way any of it can be tested.

export interface BackupPayload {
  app: "GridDown";
  kind: "marks-backup";
  version: 1;
  exported: string;
  settings: Record<string, string>;
  waypoints: Waypoint[];
  tracks: Track[];
  plans: Plan[];
  kits: Kit[];
  roster: Person[];
  comms: CommsPlan | null;
}

export interface BackupDeps {
  /** Write the file. See saveExport in save.ts, which is asked NOT to announce
   *  its own success: on a phone the place it would name is the container this
   *  module exists to get the file out of. Success messaging is ours. It still
   *  reports failures, and we rely on that. */
  save: (name: string, json: string) => Promise<SaveOutcome>;
  /** The iOS export picker: resolves to the chosen destination, or null if the
   *  user backed out. `fileName` is resolved against the app's Documents
   *  directory by the dialog plugin, so it must be a bare name. */
  exportOut: (fileName: string) => Promise<string | null>;
  /** Record that a backup exists, as milliseconds. */
  stamp: (t: number) => void;
  now: () => number;
  toast: (msg: string, kind?: "info" | "error" | "success", ms?: number) => void;
}

/**
 * Is there anything here worth backing up?
 *
 * Comms counts. A household that has filled in how to raise each other and
 * nothing else has something to lose, and the first version of this check
 * looked at pins, tracks, plans, kits and the roster only — so it told them
 * there was nothing to back up.
 */
export function hasContent(m: Marks): boolean {
  return Boolean(
    m.waypoints.length ||
      m.tracks.length ||
      m.plans.length ||
      m.kits.length ||
      m.roster.length ||
      m.comms
  );
}

export function buildPayload(
  m: Marks,
  settings: Record<string, string>,
  exportedISO: string
): BackupPayload {
  return {
    app: "GridDown",
    kind: "marks-backup",
    version: 1,
    exported: exportedISO,
    settings,
    waypoints: m.waypoints,
    tracks: m.tracks,
    plans: m.plans,
    kits: m.kits,
    // The roster carries names and medical details. It is in the backup
    // because losing it is the failure that matters, but this file is
    // therefore worth handling like a document, not like a map — the panel
    // says so where you press the button.
    roster: m.roster,
    comms: m.comms,
  };
}

/** The file name without its directory, for either separator. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() || "";
}

/**
 * The directory a path or file:// URL points into, normalised just enough that
 * two spellings of the same directory compare equal.
 *
 * The picker and `save_file` do not describe a location the same way: one hands
 * back a file:// URL with percent-escapes, the other a plain path, and iOS
 * calls the same directory both /private/var/… and /var/…. So strip the scheme,
 * decode, and drop a leading /private before comparing.
 *
 * Returns "" for anything with no directory part, which never matches.
 */
function dirOf(path: string): string {
  let s = path.trim().replace(/^file:\/\/(localhost)?/i, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    // A stray % is not an escape. Compare what we were given.
  }
  s = s.replace(/\\/g, "/").replace(/^\/private\//, "/");
  const i = s.lastIndexOf("/");
  return i <= 0 ? "" : s.slice(0, i).replace(/\/+$/, "");
}

/**
 * Did the user pick the directory the file is already in?
 *
 * On iOS the export sheet opens on the app's own Documents folder, so the
 * shortest path through it is to accept where it lands — which copies the file
 * onto itself, inside the container, and is exactly the loss this module is
 * here to prevent. It is worth catching precisely because the sentence the user
 * just read points them at that folder by name.
 *
 * Deliberately blunt: exact match on the normalised directory, nothing clever.
 * Missing a match leaves the behaviour we had before, which is survivable.
 * Inventing one tells somebody with a good backup that they have none, and the
 * only thing worse than an unreliable backup is disbelieving a reliable one.
 */
function sameDirectory(a: string, b: string): boolean {
  const da = dirOf(a);
  return da !== "" && da === dirOf(b);
}

export async function runBackup(
  m: Marks,
  settings: Record<string, string>,
  deps: BackupDeps
): Promise<void> {
  if (!hasContent(m)) {
    deps.toast("Nothing to back up yet — drop a pin or record a track first.");
    return;
  }

  const t = deps.now();
  const json = JSON.stringify(
    buildPayload(m, settings, new Date(t).toISOString()),
    null,
    2
  );

  const out = await deps.save("griddown-backup.json", json);
  // save.ts has already said what went wrong.
  if (!out.ok) return;

  // Desktop, or the browser fallback: Downloads outlives the app.
  if (out.durable) {
    deps.stamp(t);
    // save.ts is told not to announce this one, so that a phone never gets
    // "Saved to Files → On My iPhone → GridDown" for a copy that dies with the
    // app. Where it landed is still worth saying when it landed somewhere real.
    deps.toast(`Saved to ${out.location}`, "success", 6000);
    return;
  }

  const warn = () =>
    deps.toast(
      "Not backed up: the only copy is inside the app, and goes if you delete it.",
      "error",
      7000
    );

  // The name the picker is given must be the file that was actually written.
  // save_file never clobbers, so the second backup is griddown-backup-2.json —
  // and the dialog plugin creates an EMPTY placeholder for any name it cannot
  // find, which would export cleanly and hand back nothing.
  //
  // Both halves of that rest on tauri-plugin-dialog 2.7.2: mobile
  // `set_default_path` reduces `defaultPath` to a bare file name, and the Swift
  // `saveFileDialog` reuses an existing file of that name under Documents
  // instead of overwriting it with an empty placeholder. Either could change in
  // an upgrade without a compile error or a failing test here, so treat a
  // version bump of that plugin as something to re-check on a device.
  const name = out.path ? basename(out.path) : "";
  if (!name) {
    warn();
    return;
  }

  // A picker that throws — IPC gone, capability missing — is not a backup, and
  // silence here is the worst outcome: nothing is stamped and the user is told
  // nothing. Same warning as backing out, because it is the same situation.
  let dest: string | null;
  try {
    dest = await deps.exportOut(name);
  } catch {
    dest = null;
  }
  if (dest === null) {
    warn();
    return;
  }

  // The export sheet opens on the app's own folder, so it is easy to save the
  // file next to itself. That is not a backup, and must not be stamped as one.
  if (out.path && sameDirectory(dest, out.path)) {
    deps.toast(
      "Not backed up: that folder is the app's own, and goes when the app goes. Try again and pick iCloud Drive, or another app.",
      "error",
      7000
    );
    return;
  }

  deps.stamp(t);
  // Deliberately not the destination URL: it is a file:// path into a
  // container the user cannot act on, and printing it reads like a fault.
  deps.toast(
    "Backed up. That copy is outside the app and survives deleting it.",
    "success",
    6000
  );
}
