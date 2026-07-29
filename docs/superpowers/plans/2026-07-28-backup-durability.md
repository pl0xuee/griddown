# Backups That Outlive the App — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On iOS, `Back up everything` puts the backup somewhere the user chooses outside the app container, so deleting the app no longer deletes the backup.

**Architecture:** The Rust `save_file` command starts reporting whether the directory it wrote to survives the app being deleted (`durable`). A new `src/backup.ts` owns the backup flow and branches on that flag: durable means done, not durable means hand the file it just wrote to the iOS export picker so the user can put a copy outside the container. The flow takes its dependencies by injection so it can be tested without Tauri or a system picker.

**Tech Stack:** TypeScript + Vite + Vitest (jsdom), Tauri v2, Rust, `@tauri-apps/plugin-dialog`.

## Global Constraints

- No new dependencies. `@tauri-apps/plugin-dialog` (^2.7.2) and `tauri-plugin-dialog` (2.7.2) are already in `package.json` and `src-tauri/Cargo.toml`.
- No capability change. `src-tauri/capabilities/default.json` already grants `dialog:default`, whose permission set is `["allow-message", "allow-save", "allow-open"]`.
- No entitlement, provisioning, signing or workflow changes. Nothing in this plan may touch `.github/workflows/**`, `Info.ios.plist`, or anything the TestFlight pipeline depends on.
- Never detect iOS from the user agent. `src/updater.ts` records that iPadOS reports itself as desktop Safari. The only permitted signal is the `durable` flag from Rust.
- The exported file name passed to the picker must be the basename of the path `save_file` actually returned, never the name that was requested.
- Cancelling the picker is not a backup: `BACKUP_KEY` must not be stamped.
- Commit messages: plain imperative prose in the style of `git log`, no `feat:`/`fix:` prefixes, ending with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Full verification before any commit that touches TS: `npx vitest run`, `npx tsc --noEmit`, `npm run build`. Rust changes also need `cargo test --manifest-path src-tauri/Cargo.toml`.

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/lib.rs` (modify) | `SavedFile` gains `durable: bool`, set from `IS_IOS`. One serde test. |
| `src/save.ts` (modify) | New `saveExport` returning the full outcome; `saveFile` becomes a thin wrapper so its three existing callers are untouched. |
| `src/backup.ts` (create) | The backup payload and the flow. No imports from `waypoints.ts`; all effects injected. |
| `tests/backup.test.ts` (create) | The flow's decision logic, against fakes. |
| `src/waypoints.ts` (modify) | Loses the backup body, keeps the button wiring and supplies the real dependencies. |
| `index.html`, `src/styles.css`, `src/readiness.ts` (modify) | Copy: what a backup contains, and where to put it. |

---

### Task 1: Rust reports whether an export is durable

**Files:**
- Modify: `src-tauri/src/lib.rs:225-233` (the `SavedFile` struct) and `src-tauri/src/lib.rs:283-287` (its construction)
- Test: `src-tauri/src/lib.rs` (the existing `#[cfg(test)] mod tests` at line 1445)

**Interfaces:**
- Consumes: nothing.
- Produces: the `save_file` command resolves with `{ path: string, location: string, durable: boolean }`. `durable` is `false` on iOS and `true` everywhere else.

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/lib.rs`:

```rust
    /// The JS side branches on this field to decide whether a backup needs
    /// exporting out of the app container. A rename or a `skip` here would not
    /// fail to compile — it would silently leave every iOS backup inside the
    /// container, which is the bug this exists to fix.
    #[test]
    fn saved_file_reports_durability_to_the_frontend() {
        let s = SavedFile {
            path: "/tmp/x.json".into(),
            location: "/tmp/x.json".into(),
            durable: true,
        };
        let v: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert_eq!(v["durable"], serde_json::json!(true));
        assert_eq!(v["path"], serde_json::json!("/tmp/x.json"));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml saved_file_reports_durability`
Expected: FAIL — `SavedFile` has no field named `durable`.

- [ ] **Step 3: Add the field**

In `src-tauri/src/lib.rs`, change the struct:

```rust
/// A file written by `save_file`.
#[derive(serde::Serialize)]
struct SavedFile {
    /// The real path on disk.
    path: String,
    /// Where to tell the user it went — not always the path; see
    /// [`export_location`].
    location: String,
    /// Does this file survive the app being deleted?
    ///
    /// False on iOS, where [`export_dir`] is the app container's own Documents
    /// directory — which the Files app shows as "On My iPhone → GridDown", so
    /// it reads like a folder outside the app and is not one. iOS deletes the
    /// container with the app, backup included. Desktop exports go to Downloads
    /// and are nobody's business but the user's.
    durable: bool,
}
```

and its construction at the end of `save_file`:

```rust
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(SavedFile {
        location: export_location(IS_IOS, &path),
        path: path.to_string_lossy().to_string(),
        durable: !IS_IOS,
    })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS, including the seven tests that were already there.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
Report whether an exported file survives deleting the app

save_file writes to Downloads on desktop and to the app container's own
Documents directory on iOS. Only one of those two outlives the app, and
the frontend had no way to tell them apart short of sniffing the user
agent, which iPadOS lies about.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `saveExport` carries the outcome through to callers

**Files:**
- Modify: `src/save.ts` (whole file)

**Interfaces:**
- Consumes: the `save_file` command from Task 1.
- Produces:
  - `export type SaveOutcome = { ok: false } | { ok: true; path: string | null; location: string; durable: boolean }`
  - `export async function saveExport(name: string, data: Uint8Array | string, mime: string): Promise<SaveOutcome>`
  - `export async function saveFile(name: string, data: Uint8Array | string, mime: string): Promise<string | null>` — unchanged contract.

No test in this task. `saveExport` is an adapter over `invoke` with no branching logic of its own worth a jsdom harness (the browser fallback needs `URL.createObjectURL`, which jsdom does not implement); the decision it feeds is tested in Task 3 through an injected fake.

- [ ] **Step 1: Replace the body of `saveFile` with `saveExport` plus a wrapper**

In `src/save.ts`, replace the exported `saveFile` function (from its doc comment to the closing brace) with:

```ts
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
 */
export async function saveExport(
  name: string,
  data: Uint8Array | string,
  mime: string
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
      toast(`Saved to ${saved.location}`, "success", 6000);
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
  toast(`Saved ${name} to your downloads`, "success");
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
```

- [ ] **Step 2: Verify nothing else broke**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. `saveFile`'s three other callers (`src/print.ts:423`, `src/planprint.ts:213`, `src/waypoints.ts:340`) are untouched and still compile.

- [ ] **Step 3: Commit**

```bash
git add src/save.ts
git commit -m "$(cat <<'EOF'
Carry the export outcome back to the caller

saveFile answered "here is a path, or null", which cannot distinguish a
file that will outlive the app from one that will not. saveExport reports
the whole outcome; saveFile stays exactly as it was for the PDF and GPX
callers, which only ever wanted the path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `src/backup.ts` — the flow, with tests

**Files:**
- Create: `src/backup.ts`
- Test: `tests/backup.test.ts`

**Interfaces:**
- Consumes: `SaveOutcome` from Task 2; `Marks`, `Waypoint`, `Track` from `src/store.ts`; `Plan` from `src/plan.ts`; `Kit` from `src/kit.ts`; `Person`, `CommsPlan` from `src/roster.ts`.
- Produces:
  - `export interface BackupPayload`
  - `export interface BackupDeps`
  - `export function buildPayload(m: Marks, settings: Record<string, string>, exportedISO: string): BackupPayload`
  - `export function hasContent(m: Marks): boolean`
  - `export async function runBackup(m: Marks, settings: Record<string, string>, deps: BackupDeps): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `tests/backup.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildPayload, hasContent, runBackup, type BackupDeps } from "../src/backup";
import type { Marks } from "../src/store";

const EMPTY: Marks = {
  waypoints: [],
  tracks: [],
  plans: [],
  kits: [],
  roster: [],
  comms: null,
};

const PIN = { id: "abc12345", name: "Spring", lat: 44.1, lng: -121.3, t: 1 };

/** Marks with one pin in them — the least that counts as worth backing up. */
function withPin(): Marks {
  return { ...EMPTY, waypoints: [PIN] };
}

/**
 * Dependencies with the iOS shape by default: a save that lands somewhere
 * that does NOT survive the app, and a picker the user completes.
 */
function deps(over: Partial<BackupDeps> = {}) {
  const d: BackupDeps = {
    save: vi.fn(async () => ({
      ok: true as const,
      path: "/var/mobile/Containers/Data/Application/8F3C/Documents/griddown-backup.json",
      location: "Files → On My iPhone → GridDown",
      durable: false,
    })),
    exportOut: vi.fn(async () => "file:///iCloud/griddown-backup.json"),
    stamp: vi.fn(),
    now: () => 1_700_000_000_000,
    toast: vi.fn(),
    ...over,
  };
  return d;
}

describe("buildPayload", () => {
  it("carries every slice, not just pins and tracks", () => {
    const m: Marks = {
      ...EMPTY,
      waypoints: [PIN],
      plans: [{ id: "p1" } as any],
      kits: [{ id: "k1" } as any],
      roster: [{ id: "r1" } as any],
      comms: { id: "c1" } as any,
    };
    const p = buildPayload(m, { theme: "dark" }, "2026-07-28T00:00:00.000Z");

    expect(p.kind).toBe("marks-backup");
    expect(p.version).toBe(1);
    expect(p.exported).toBe("2026-07-28T00:00:00.000Z");
    expect(p.settings).toEqual({ theme: "dark" });
    // The roster and the comms plan are the slices whose loss actually matters
    // and the ones a backup written from the Marks panel could most easily
    // forget, because that panel does not own them.
    expect(p.roster).toHaveLength(1);
    expect(p.comms).not.toBeNull();
    expect(p.plans).toHaveLength(1);
    expect(p.kits).toHaveLength(1);
  });
});

describe("hasContent", () => {
  it("is false for nothing at all", () => {
    expect(hasContent(EMPTY)).toBe(false);
  });

  it("is true for a comms plan and nothing else", () => {
    // A household that has filled in how to raise each other and nothing else
    // has something to lose. The old check omitted comms and told them there
    // was nothing to back up.
    expect(hasContent({ ...EMPTY, comms: { id: "c1" } as any })).toBe(true);
  });
});

describe("runBackup", () => {
  it("refuses when there is nothing, and never writes a file", async () => {
    const d = deps();
    await runBackup(EMPTY, {}, d);
    expect(d.save).not.toHaveBeenCalled();
    expect(d.stamp).not.toHaveBeenCalled();
  });

  it("stops after the save when it landed somewhere durable", async () => {
    // Desktop and the browser fallback. Downloads is not going anywhere.
    const d = deps({
      save: vi.fn(async () => ({
        ok: true as const,
        path: "/home/x/Downloads/griddown-backup.json",
        location: "/home/x/Downloads/griddown-backup.json",
        durable: true,
      })),
    });
    await runBackup(withPin(), {}, d);

    expect(d.exportOut).not.toHaveBeenCalled();
    expect(d.stamp).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it("exports out of the container when the save was not durable", async () => {
    const d = deps();
    await runBackup(withPin(), {}, d);

    expect(d.exportOut).toHaveBeenCalledWith("griddown-backup.json");
    expect(d.stamp).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it("exports the file that was actually written, not the one asked for", async () => {
    // save_file never clobbers: the second backup is written as
    // griddown-backup-2.json. Passing the requested name would hand the picker
    // a stale backup — or, on a fresh install, the empty placeholder the
    // dialog plugin creates when the name does not exist.
    const d = deps({
      save: vi.fn(async () => ({
        ok: true as const,
        path: "/var/mobile/Containers/Data/Application/8F3C/Documents/griddown-backup-2.json",
        location: "Files → On My iPhone → GridDown",
        durable: false,
      })),
    });
    await runBackup(withPin(), {}, d);

    expect(d.exportOut).toHaveBeenCalledWith("griddown-backup-2.json");
  });

  it("does not count a cancelled export as a backup", async () => {
    // BACKUP_KEY drives the readiness row. Stamping here would report a backup
    // that dies with the app.
    const d = deps({ exportOut: vi.fn(async () => null) });
    await runBackup(withPin(), {}, d);

    expect(d.stamp).not.toHaveBeenCalled();
    expect(d.toast).toHaveBeenCalledWith(
      expect.stringContaining("inside the app"),
      "error",
      expect.any(Number)
    );
  });

  it("does not export or stamp when the save itself failed", async () => {
    const d = deps({ save: vi.fn(async () => ({ ok: false as const })) });
    await runBackup(withPin(), {}, d);

    expect(d.exportOut).not.toHaveBeenCalled();
    expect(d.stamp).not.toHaveBeenCalled();
  });

  it("warns rather than exporting a placeholder when there is no path to export", async () => {
    // Belt and braces: a non-durable save with no path is not a thing the
    // backend produces, but handing the picker a guessed name would export the
    // empty file the plugin creates, which looks exactly like success.
    const d = deps({
      save: vi.fn(async () => ({
        ok: true as const,
        path: null,
        location: "somewhere",
        durable: false,
      })),
    });
    await runBackup(withPin(), {}, d);

    expect(d.exportOut).not.toHaveBeenCalled();
    expect(d.stamp).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/backup.test.ts`
Expected: FAIL — cannot resolve `../src/backup`.

- [ ] **Step 3: Write the implementation**

Create `src/backup.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/backup.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify the whole suite and the types**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backup.ts tests/backup.test.ts
git commit -m "$(cat <<'EOF'
A backup flow that knows a saved file can still be lost

On iOS save_file writes into the app container's own Documents directory,
so a backup taken there is deleted with the app it is insuring. This
module treats a save as half the job on any platform that reports the
write as not durable: the other half hands the file to the iOS export
picker, which copies it somewhere the user chooses and the system keeps.

Cancelling that picker is not a backup and is not recorded as one. The
name handed to the picker is the file that was actually written, never
the one that was asked for — save_file does not clobber, so the second
backup is griddown-backup-2.json, and the plugin silently creates an
empty placeholder for any name it cannot find.

Comms now counts as content. A household with a comms plan and nothing
else was told it had nothing to back up.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire the Marks panel to the new flow

**Files:**
- Modify: `src/waypoints.ts` — imports at lines 1-18, and `backupAll` at lines 371-414

**Interfaces:**
- Consumes: `runBackup`, `BackupDeps` from Task 3; `saveExport` from Task 2.
- Produces: nothing new. `document.getElementById("marks-backup")` keeps calling `backupAll` (line 572, unchanged).

- [ ] **Step 1: Add the imports**

In `src/waypoints.ts`, change the `saveFile` import line and add two more:

```ts
import { saveExport, saveFile } from "./save";
import { runBackup } from "./backup";
import { save as savePicker } from "@tauri-apps/plugin-dialog";
```

`saveFile` stays: the GPX export at line 340 still uses it.

- [ ] **Step 2: Replace the body of `backupAll`**

Replace the whole of `backupAll` (from `function backupAll() {` to its closing brace) with:

```ts
  function backupAll() {
    // waypoints and tracks are this module's; plans, kits, the roster and the
    // comms plan are read from the store, which owns them. Backing up means all
    // of it — this panel just must not lose what it does not own.
    const m = { ...currentMarks(), waypoints, tracks };
    void runBackup(m, { ...localStorage } as unknown as Record<string, string>, {
      save: (name, json) => saveExport(name, json, "application/json"),
      // Only reached when the save was not durable, which today means iOS. The
      // plugin resolves a bare name against the app's Documents directory —
      // the same directory save_file just wrote to.
      exportOut: (fileName) => savePicker({ defaultPath: fileName }),
      stamp: (t) => localStorage.setItem(BACKUP_KEY, String(t)),
      now: () => Date.now(),
      toast,
    });
  }
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: PASS. If `tsc` objects to the `savePicker` return type, note that `save()` resolves `string | null`, which matches `BackupDeps.exportOut` exactly — do not widen the interface to `any` to silence it.

- [ ] **Step 4: Commit**

```bash
git add src/waypoints.ts
git commit -m "$(cat <<'EOF'
Put the backup button on the flow that can outlive the app

The Marks panel keeps the button and supplies the real dependencies; the
decisions moved to backup.ts, where they can be tested without a device
and a system picker.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Say what a backup holds and where to put it

**Files:**
- Modify: `index.html:510-516` (inside `#marks-actions`)
- Modify: `src/styles.css` (after the `#marks-actions button` block near line 1212)
- Modify: `src/readiness.ts:285` (the "Never backed up" fix text)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add the note to the Marks panel**

In `index.html`, immediately after the `marks-restore` button and before the closing `</div>` of `#marks-actions`:

```html
        <div id="marks-note">
          A backup holds your pins, tracks, plans, checklists and the roster —
          names and medical details included. On a phone, save it somewhere
          outside the app: a copy kept inside GridDown goes when GridDown does.
        </div>
```

- [ ] **Step 2: Style it**

In `src/styles.css`, immediately after the `#marks-actions button { … }` rule:

```css
/* What the file you are about to write actually contains, said where the
   button is rather than in a panel nobody opens twice. The wording earns its
   space: this file holds the roster's medical details, and it used to be
   written somewhere iOS deletes along with the app. */
#marks-note {
  padding: 6px 2px 0;
  color: var(--type-2);
  font-family: var(--font-prose);
  font-size: 11px;
  line-height: 1.4;
}
```

- [ ] **Step 3: Correct the readiness advice**

In `src/readiness.ts`, in the `!last` branch, replace the `fix` string:

```ts
      fix: "Marks & tracks → Back up everything, and put it somewhere that isn't this phone.",
```

- [ ] **Step 4: Verify**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html src/styles.css src/readiness.ts
git commit -m "$(cat <<'EOF'
Say what a backup holds, and where it has to go

The file carries the roster's medical details and is the only copy of
everything that cannot be regenerated. Both facts belong next to the
button, not in a changelog.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Verify on a device that the exported file is not empty

**Files:** none.

This task exists because of the one assumption the whole design rests on, recorded in the spec's *Risks*: that Tauri's `document_dir()` on iOS and the dialog plugin's `FileManager.urls(for: .documentDirectory, in: .userDomainMask).first!` resolve to the same directory. If they do not, the picker exports the plugin's empty placeholder — and every visible sign, including the toast and the readiness row, says the backup worked.

**A picker that appears is not a pass. Only opening the exported file is.**

- [ ] **Step 1: Get the build onto a phone**

```bash
gh workflow run ios-testflight.yml --ref master
gh run watch --exit-status
```

Install from TestFlight when processing finishes.

- [ ] **Step 2: Take a backup with something in it**

Drop at least one pin, then Marks & tracks → **Back up everything**. The export picker must appear.

- [ ] **Step 3: Save it outside the app**

Choose **iCloud Drive**, or On My iPhone in a folder that is not GridDown's.

- [ ] **Step 4: Open the exported file and confirm it has contents**

In the Files app, open the saved `griddown-backup.json`. It must contain the pin — real JSON with a `"waypoints"` array, not `0 bytes` and not an empty file. **If it is empty, stop: the assumption is false, the design needs the file written through the plugin's own directory instead, and nothing further in this plan should ship.**

- [ ] **Step 5: Prove the round trip**

Delete GridDown from the phone. Reinstall from TestFlight. Marks & tracks → **Restore backup**, pick the file from where you saved it, and confirm the pin comes back.

- [ ] **Step 6: Confirm cancelling is honest**

Take another backup and dismiss the picker. The toast must say the only copy is inside the app, and the Readiness panel's Backup row must **not** advance to a fresh "Last backup" time.

- [ ] **Step 7: Record the result**

Add a line to the spec's *Risks and assumptions* section recording that the assumption was verified on device, with the iOS version tested, and commit it:

```bash
git add docs/superpowers/specs/2026-07-28-backup-durability-design.md
git commit -m "$(cat <<'EOF'
Record that the export lands with real contents on device

The design rested on Tauri's document_dir() and the dialog plugin's
Swift documentDirectory being the same folder. If they had differed the
picker would have exported an empty placeholder and every indicator in
the app would still have said the backup worked.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Release

Not a task: this ships the way v1.2.2 did — bump `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `cargo update -p griddown --offline`, add a `## v1.2.3` section to `CHANGELOG.md` (which `build.yml` extracts by heading and refuses to build without), then tag and push. Do that only after Task 6 passes.
