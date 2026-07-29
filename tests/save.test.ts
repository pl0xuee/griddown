import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * What an export says it did.
 *
 * The success toast here names where the file landed, and on iOS that place is
 * the app's own container: "Saved to Files → On My iPhone → GridDown" reads
 * like a folder outside the app, and is not one. Said before the backup export
 * picker opens, it also reads like instructions — follow it, pick that folder,
 * and the backup dies with the app. So the backup path asks for silence on
 * success and does its own messaging once the copy is somewhere real.
 *
 * The failure toast is not optional in either case: runBackup gives up on a
 * failed save without saying anything, trusting that this module already has.
 */

const invoke = vi.fn();
const toasted = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("../src/toast", () => ({
  toast: (...args: unknown[]) => toasted(...args),
}));

const IOS = {
  path: "/var/mobile/Containers/Data/Application/8F3C/Documents/griddown-backup.json",
  location: "Files → On My iPhone → GridDown",
  durable: false,
};

/**
 * save.ts decides once, at import, whether it is running inside Tauri, so the
 * module has to be reloaded with that already decided.
 *
 * Only the in-app side is covered. Reaching the browser fallback means stubbing
 * createObjectURL, revokeObjectURL and the anchor click — the whole download
 * mechanism — and then asserting against those stubs, on a path that only runs
 * under `vite dev`.
 */
async function loadInApp() {
  vi.resetModules();
  (window as any).__TAURI_INTERNALS__ = {};
  return await import("../src/save");
}

beforeEach(() => {
  invoke.mockReset();
  toasted.mockReset();
});

afterEach(() => {
  delete (window as any).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("saveExport in the app", () => {
  it("says where the file landed, by default", async () => {
    invoke.mockResolvedValue(IOS);
    const { saveExport } = await loadInApp();

    const out = await saveExport("griddown.gpx", "<gpx/>", "application/gpx+xml");

    expect(out).toEqual({ ok: true, ...IOS });
    expect(toasted).toHaveBeenCalledWith(
      "Saved to Files → On My iPhone → GridDown",
      "success",
      expect.any(Number)
    );
  });

  it("says nothing on success when the caller asked it not to", async () => {
    // The backup path. Naming that folder here is the durability claim the
    // whole export flow exists to stop making.
    invoke.mockResolvedValue(IOS);
    const { saveExport } = await loadInApp();

    const out = await saveExport("griddown-backup.json", "{}", "application/json", false);

    expect(toasted).not.toHaveBeenCalled();
    // Still reports everything the caller needs to decide what to say.
    expect(out).toEqual({ ok: true, ...IOS });
  });

  it("still reports a failure when it has been told not to announce", async () => {
    // runBackup returns on !ok without a word of its own.
    invoke.mockRejectedValue(new Error("disk full"));
    const { saveExport } = await loadInApp();

    const out = await saveExport("griddown-backup.json", "{}", "application/json", false);

    expect(out).toEqual({ ok: false });
    expect(toasted).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't save griddown-backup.json"),
      "error"
    );
  });

  it("leaves saveFile announcing, for the PDF and GPX exports", async () => {
    // Those files really do land in that folder and are meant to be found
    // there — nothing about them is a backup.
    invoke.mockResolvedValue({ ...IOS, path: "/…/Documents/griddown-map.pdf" });
    const { saveFile } = await loadInApp();

    const path = await saveFile("griddown-map.pdf", new Uint8Array([1, 2]), "application/pdf");

    expect(path).toBe("/…/Documents/griddown-map.pdf");
    expect(toasted).toHaveBeenCalledWith(
      "Saved to Files → On My iPhone → GridDown",
      "success",
      expect.any(Number)
    );
  });
});
