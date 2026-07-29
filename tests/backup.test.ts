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

  it("says where a durable save landed, because save.ts no longer does", async () => {
    // save.ts is asked not to announce its own success, so that a phone never
    // reads "Saved to Files → On My iPhone → GridDown" for a copy that dies
    // with the app. Desktop still has to be told where its file went.
    const d = deps({
      save: vi.fn(async () => ({
        ok: true as const,
        path: "/home/x/Downloads/griddown-backup.json",
        location: "/home/x/Downloads/griddown-backup.json",
        durable: true,
      })),
    });
    await runBackup(withPin(), {}, d);

    expect(d.toast).toHaveBeenCalledWith(
      "Saved to /home/x/Downloads/griddown-backup.json",
      "success",
      expect.any(Number)
    );
  });

  it("exports out of the container when the save was not durable", async () => {
    const d = deps();
    await runBackup(withPin(), {}, d);

    expect(d.exportOut).toHaveBeenCalledWith("griddown-backup.json");
    expect(d.stamp).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it("promises durability only for the copy that has it", async () => {
    // This one sentence is the whole claim the export makes, and it is made
    // after the picker, never before it. Nothing else in the flow may say
    // "saved" while the only copy is still inside the container.
    const d = deps();
    await runBackup(withPin(), {}, d);

    expect(d.toast).toHaveBeenCalledWith(
      "Backed up. That copy is outside the app and survives deleting it.",
      "success",
      expect.any(Number)
    );
    expect(d.toast).toHaveBeenCalledTimes(1);
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

  it("does not count a picker that threw as a backup either", async () => {
    // A rejected picker — IPC gone, capability missing — used to be an
    // unhandled rejection: nothing stamped, which is safe, and nothing said,
    // which is not. The user's last impression would have been a success toast.
    const d = deps({
      exportOut: vi.fn(async () => {
        throw new Error("dialog.save not allowed");
      }),
    });
    await expect(runBackup(withPin(), {}, d)).resolves.toBeUndefined();

    expect(d.stamp).not.toHaveBeenCalled();
    expect(d.toast).toHaveBeenCalledWith(
      expect.stringContaining("inside the app"),
      "error",
      expect.any(Number)
    );
  });

  /**
   * Saving the file next to itself.
   *
   * The iOS export sheet opens on the app's own Documents folder, so the
   * shortest way through it lands the copy back in the container — and the
   * sentence the user has just been shown names that folder. Accepting it would
   * stamp a backup date for a file that dies with the app: the original bug,
   * with a reassurance on top.
   */
  describe("a destination inside the app's own folder", () => {
    const IOS_DIR = "/var/mobile/Containers/Data/Application/8F3C/Documents";
    const refused = async (dest: string) => {
      const d = deps({ exportOut: vi.fn(async () => dest) });
      await runBackup(withPin(), {}, d);
      expect(d.stamp).not.toHaveBeenCalled();
      return d;
    };

    it("is refused, and said to be the app's own", async () => {
      const d = await refused(`${IOS_DIR}/griddown-backup.json`);
      const [msg, kind] = (d.toast as any).mock.calls.at(-1);
      expect(msg).toContain("the app's own");
      expect(msg).toContain("goes when the app goes");
      expect(kind).toBe("error");
    });

    it("is refused through a file:// URL", async () => {
      // What the picker hands back is a URL; what save_file reports is a path.
      await refused(`file://${IOS_DIR}/griddown-backup.json`);
    });

    it("is refused when the URL escapes a character in the folder name", async () => {
      // Any character the URL has to escape must not read as a different
      // folder. Nothing in a container path needs escaping today, which is
      // exactly why this would rot unnoticed.
      const dir = "/var/mobile/Containers/Data/Application/8F3C/My Documents";
      const d = deps({
        save: vi.fn(async () => ({
          ok: true as const,
          path: `${dir}/griddown-backup.json`,
          location: "Files → On My iPhone → GridDown",
          durable: false,
        })),
        exportOut: vi.fn(async () => `file://${dir.replace(/ /g, "%20")}/griddown-backup.json`),
      });
      await runBackup(withPin(), {}, d);
      expect(d.stamp).not.toHaveBeenCalled();
    });

    it("is refused when iOS spells the same directory /private/var", async () => {
      // /private/var and /var are the same place on iOS, and which one you get
      // depends on who resolved the path.
      await refused(`file:///private${IOS_DIR}/griddown-backup.json`);
    });

    it("does not fire for a real destination that merely looks similar", async () => {
      // A false match tells someone with a good backup that they have none,
      // which is worse than missing one — so the comparison stays exact.
      const d = deps({
        exportOut: vi.fn(async () => `${IOS_DIR}-Inbox/griddown-backup.json`),
      });
      await runBackup(withPin(), {}, d);
      expect(d.stamp).toHaveBeenCalledWith(1_700_000_000_000);
    });
  });

  it("does not export or stamp when the save itself failed", async () => {
    const d = deps({ save: vi.fn(async () => ({ ok: false as const })) });
    await runBackup(withPin(), {}, d);

    expect(d.exportOut).not.toHaveBeenCalled();
    expect(d.stamp).not.toHaveBeenCalled();
    expect(d.toast).not.toHaveBeenCalled();
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
