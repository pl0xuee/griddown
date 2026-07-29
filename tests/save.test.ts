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
 * save.ts decides once, at import, whether it is running inside Tauri — so the
 * module has to be reloaded to be tested on either side of that.
 */
async function load(tauri: boolean) {
  vi.resetModules();
  if (tauri) (window as any).__TAURI_INTERNALS__ = {};
  else delete (window as any).__TAURI_INTERNALS__;
  return await import("../src/save");
}

beforeEach(() => {
  invoke.mockReset();
  toasted.mockReset();
  // jsdom has neither of these, and no navigation, so the browser fallback
  // cannot run without them.
  (URL as any).createObjectURL = vi.fn(() => "blob:mock");
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  delete (window as any).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("saveExport in the app", () => {
  it("says where the file landed, by default", async () => {
    invoke.mockResolvedValue(IOS);
    const { saveExport } = await load(true);

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
    const { saveExport } = await load(true);

    const out = await saveExport("griddown-backup.json", "{}", "application/json", false);

    expect(toasted).not.toHaveBeenCalled();
    // Still reports everything the caller needs to decide what to say.
    expect(out).toEqual({ ok: true, ...IOS });
  });

  it("still reports a failure when it has been told not to announce", async () => {
    // runBackup returns on !ok without a word of its own.
    invoke.mockRejectedValue(new Error("disk full"));
    const { saveExport } = await load(true);

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
    const { saveFile } = await load(true);

    const path = await saveFile("griddown-map.pdf", new Uint8Array([1, 2]), "application/pdf");

    expect(path).toBe("/…/Documents/griddown-map.pdf");
    expect(toasted).toHaveBeenCalledWith(
      "Saved to Files → On My iPhone → GridDown",
      "success",
      expect.any(Number)
    );
  });
});

describe("saveExport in a plain browser", () => {
  it("announces the download by default", async () => {
    const { saveExport } = await load(false);

    const out = await saveExport("griddown.gpx", "<gpx/>", "application/gpx+xml");

    expect(out).toEqual({
      ok: true,
      path: null,
      location: "your downloads",
      durable: true,
    });
    expect(toasted).toHaveBeenCalledWith("Saved griddown.gpx to your downloads", "success");
  });

  it("holds its tongue for the backup path here too", async () => {
    // Dev only, but the rule is the caller's to make, not the path's.
    const { saveExport } = await load(false);

    const out = await saveExport("griddown-backup.json", "{}", "application/json", false);

    expect(toasted).not.toHaveBeenCalled();
    expect(out.ok && out.durable).toBe(true);
  });
});
