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
  /** Write the file. See saveExport in save.ts. */
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
  const name = out.path ? basename(out.path) : "";
  if (!name) {
    warn();
    return;
  }

  const dest = await deps.exportOut(name);
  if (dest === null) {
    warn();
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
