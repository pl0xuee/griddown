import { describe, it, expect, beforeEach } from "vitest";
import { BACKUP_KEY, initReadiness } from "../src/readiness";

/**
 * The Readiness panel is read before the day it matters, and every failing row
 * tells you what to do about it while you still can. So the wording of a fix is
 * the behaviour, not decoration — and this app runs on desktops as well as
 * phones, where "somewhere that isn't this phone" was both wrong and no help.
 */

const PIN = { id: "abc12345", name: "Spring", lat: 44.1, lng: -121.3, t: 1 };

/**
 * jsdom here has no localStorage, and nothing else in the suite has needed one.
 * The store falls back to it when there is no Tauri backend, and readiness
 * reads the marks through the store — with no storage at all there is nothing
 * to back up and no row to check.
 */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  } as Storage;
}

/** Render the panel and hand back what it actually put on screen. */
async function rows(): Promise<string> {
  document.body.innerHTML =
    `<button id="readiness-open"></button>` +
    `<div id="readiness-panel" class="hidden"><div id="readiness-content"></div></div>`;
  initReadiness(() => false);
  document.getElementById("readiness-open")!.click();
  // render() is async: it reads the marks before it can say anything.
  await new Promise((r) => setTimeout(r, 0));
  return document.getElementById("readiness-content")!.textContent || "";
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  });
});

describe("the backup row", () => {
  it("sends you outside the app, not off the phone", async () => {
    localStorage.setItem("griddown_waypoints", JSON.stringify([PIN]));
    localStorage.removeItem(BACKUP_KEY);

    const text = await rows();

    expect(text).toContain("Never backed up.");
    expect(text).toContain(
      "Marks & tracks → Back up everything, and save the copy somewhere outside the app."
    );
    // Outside the app may well still be the phone — iCloud Drive, another
    // app's folder — and on a desktop there is no phone in the story at all.
    expect(text).not.toContain("this phone");
  });
});
