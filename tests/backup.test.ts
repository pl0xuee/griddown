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
