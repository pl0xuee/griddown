# Backups that outlive the app

**Date:** 2026-07-28
**Status:** approved, ready for planning
**Scope:** phase 1 (manual export to a destination outside the app container). Phase 2 is sketched at the end and is deliberately not part of this plan.

## Problem

Deleting the app on iOS deletes the backup along with it. A user who had taken a
backup, deleted the app, and reinstalled found both the marks and the backup
gone.

## Root cause

`Back up everything` (`src/waypoints.ts:371`, `backupAll`) calls
`saveFile("griddown-backup.json", …)` in `src/save.ts`, which invokes the Rust
`save_file` command. That resolves its directory through `export_dir`
(`src-tauri/src/lib.rs:212`), which on iOS is `p.document_dir()` — the app
sandbox's own Documents directory.

`UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace`
(`src-tauri/Info.ios.plist`) surface that directory in Files as
"On My iPhone → GridDown", which reads like a normal folder outside the app. It
is not. It is a window into the app's container, and iOS deletes the container
when the app is deleted.

So the backup was being stored inside the thing it insures against. On desktop
there is no such problem: `export_dir` resolves to Downloads, which survives.

Restore is already fine. `restoreAll` reads through `pickFile`
(`src/waypoints.ts:35`), a plain `<input type="file">`, which on iOS opens the
system document picker and can reach iCloud Drive, On My iPhone and any other
Files provider. Only the save side is trapped.

## Goals

- A backup taken on iOS lands somewhere that survives deleting the app.
- The user chooses where. The app never writes outside its own container on its
  own initiative.
- The "last backup" readiness row tells the truth: it counts a backup only when
  one has actually landed somewhere durable.
- No change to signing, entitlements, provisioning or the TestFlight pipeline.

## Non-goals

- Automatic or scheduled backups (phase 2).
- iCloud containers, iCloud sync, or any Apple Developer portal change.
- GPX and PDF exports, which write to the same doomed directory. The design
  below makes fixing them a one-line branch later; bundling them into the change
  that fixes data loss would widen the blast radius for no benefit.
- Changing where `marks.json` itself lives.

## Design

### 1. Rust: `SavedFile` gains `durable`

`save_file` already knows, via the `IS_IOS` constant it passes to
`pick_export_dir`, whether the directory it just wrote to survives the app being
deleted. Expose that as a third field on `SavedFile` (`src-tauri/src/lib.rs:227`):

```rust
struct SavedFile {
    path: String,
    location: String,
    /// Does this file survive the app being deleted? False on iOS, where
    /// `export_dir` is the app container's Documents directory.
    durable: bool,
}
```

`durable` is `!IS_IOS`. It is an additive field, so nothing that reads the
existing two breaks.

This is the signal the JS side branches on. It must not sniff the user agent:
`src/updater.ts` already records that iPadOS reports itself as desktop Safari.

### 2. `src/save.ts`: one richer function, one thin wrapper

Add an exported `saveExport` returning the full outcome, and reduce the existing
`saveFile` to a wrapper over it so its three other callers (`print.ts:423`,
`planprint.ts:213`, `waypoints.ts:340`) are untouched:

```ts
export type SaveOutcome =
  | { ok: false }
  | { ok: true; path: string | null; location: string; durable: boolean };

export async function saveExport(name, data, mime): Promise<SaveOutcome>;
export async function saveFile(name, data, mime): Promise<string | null>;
```

In the browser fallback (no Tauri — plain `vite dev`) the anchor download goes to
the real Downloads folder, so that path reports `durable: true`, `path: null`.

### 3. `src/backup.ts`: a new module owning the flow

`waypoints.ts` is 637 lines and owns pins, tracks and their UI. The backup flow
moves out to `src/backup.ts`, leaving only the button wiring behind. The point is
testability: the real flow ends in a system picker, so it can only be tested
through injected dependencies.

```ts
export interface BackupDeps {
  save: (name: string, json: string) => Promise<SaveOutcome>;
  /** The iOS export picker. Resolves to the chosen destination, or null if
   *  the user cancelled. */
  exportOut: (fileName: string) => Promise<string | null>;
  stamp: (t: number) => void;   // writes BACKUP_KEY
  now: () => number;
  toast: (msg: string, kind?: string) => void;
}

export function buildPayload(m: Marks, settings: Record<string, string>): BackupPayload;
export async function runBackup(m: Marks, deps: BackupDeps): Promise<void>;
```

`buildPayload` is the existing object literal from `backupAll` lifted out
unchanged: `app`, `kind: "marks-backup"`, `version: 1`, `exported`, `settings`,
`waypoints`, `tracks`, `plans`, `kits`, `roster`, `comms`.

`exportOut` is `save` from `@tauri-apps/plugin-dialog`. No capability change is
needed: `src-tauri/capabilities/default.json` already grants `dialog:default`,
and that set is `["allow-message", "allow-save", "allow-open"]`.

### 4. Flow

1. Build the payload. If there is nothing in it, toast and stop (unchanged
   behaviour).
2. `saveExport("griddown-backup.json", json)`. This writes the file into
   Documents exactly as today.
3. If the outcome is `durable` — desktop, or the browser fallback — stamp
   `BACKUP_KEY` and stop. Nothing else changes on those platforms.
4. Otherwise (iOS): take the **basename of the returned path** and call
   `exportOut(basename)`. iOS presents the export picker with that file as its
   source; the user picks a destination outside the container and iOS copies it
   there.
5. On a destination: stamp `BACKUP_KEY`, toast that the backup will survive
   deleting the app.
6. On cancel: do **not** stamp. Toast a warning that the only copy is inside the
   app and goes when the app goes.

Step 4 depends on a documented quirk of the dialog plugin's iOS implementation.
In `tauri-plugin-dialog-2.7.2/ios/Sources/DialogPlugin.swift:138`,
`saveFileDialog` uses `Documents/<fileName>` as the export source and writes an
**empty placeholder there only if no such file exists**. Because step 2 has
already written the real file under that name, the exported copy carries the
real contents. And on mobile the same crate's
`src/commands.rs:93` (`set_default_path`) reduces `defaultPath` to its file
name, so a bare basename — not a full path — is the correct thing to pass.

### 5. Edge cases

- **The basename is not always what we asked for.** `save_file` never clobbers:
  the second backup is written as `griddown-backup-2.json`, the third as `-3`.
  Passing the requested name rather than the returned one would export a stale
  backup, or the empty placeholder. The flow must use `path`'s basename. This is
  the subtlest failure available here and gets its own test.
- **Cancelling is not a backup.** `BACKUP_KEY` drives the readiness row
  (`src/readiness.ts:269`). Stamping on cancel would report a backup that dies
  with the app.
- **`saveExport` failing** already toasts inside `save.ts`; `runBackup` adds
  nothing and does not stamp.
- **In-app copies accumulate** in Documents (`-2`, `-3`, …), all inside the
  doomed container. Accepted for phase 1: they are the export source and cost a
  few KB. Not worth changing `save_file`'s no-clobber rule, which PDF and GPX
  exports also rely on.

### 6. Wording

- Success: the toast says the backup is outside the app and will survive
  deleting it. It must not report the raw destination URL, which is a file URL
  the user cannot act on.
- Cancel: a plain warning that the copy inside the app goes with the app.
- The Marks panel copy beside the button says the same thing, in the voice
  already used there for the roster's medical details.

## Testing

`tests/backup.test.ts`, against fakes — no Tauri, no picker:

1. `buildPayload` carries plans, kits, roster and comms, not just pins and
   tracks.
2. Nothing to back up: toasts, and never calls `save`.
3. `durable: true`: never opens the picker, stamps `BACKUP_KEY`.
4. `durable: false`: opens the picker, and stamps on a destination.
5. `durable: false` and the user cancels: `BACKUP_KEY` is untouched.
6. The de-dupe case: `save` resolves with a path ending `griddown-backup-2.json`
   and the picker is called with exactly that basename.
7. `saveExport` failing: no stamp, no picker.

## Risks and assumptions

- **Assumption — VERIFIED ON DEVICE, v1.2.3, 2026-07-28.** Tauri's
  `document_dir()` on iOS and the dialog plugin's
  `FileManager.urls(for: .documentDirectory, …).first!` resolve to the same
  directory. The whole approach rests on this: were it false, the picker would
  export the plugin's empty placeholder rather than the backup, and every
  indicator in the app — the toast, the readiness row — would still report
  success. Confirmed by taking a backup on an iPhone from the v1.2.3 TestFlight
  build, exporting it, and opening the exported file: real contents, not a
  placeholder.

  Code review traced why it holds: on iOS, Tauri resolves `document_dir()`
  through `dirs` to `$HOME/Documents`, and iOS sets `HOME` to the container
  root — the same directory the Swift side uses. The `/private` prefix
  difference is cosmetic; both resolve to the same inode.

  **This rests on pinned versions** — `tauri-plugin-dialog` 2.7.2 and `tauri`
  2.11.5. A plugin upgrade could change the placeholder behaviour with no
  compile error and no failing test, because the failure is silent by
  construction. Re-run the device check when either is bumped.
- The picker is a system UI; it cannot be exercised by the test suite. Tests
  cover the decision logic around it; the picker itself needs the device check
  above.

## Phase 2 (follow-up, not planned here)

Hold a security-scoped bookmark to the folder the user picked, so later backups
can be written there without prompting — on a schedule, or when marks change.
This is the opt-in automatic half, and it is destination-agnostic: pointing it at
an iCloud Drive folder is iCloud sync, opt-in, with no Apple entitlement and no
provisioning change. It needs a small Swift plugin, because the dialog plugin's
`.exportToService` mode returns a URL the app holds no sustained write access to.
