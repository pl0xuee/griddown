import { describe, it, expect, beforeEach } from "vitest";
import { confirmAction, promptAction } from "../src/dialog";

/**
 * These guard deletions and overwrites, so the case that matters most is the
 * one that shipped broken: a dialog whose answer is never actually waited for.
 * The previous implementation used window.confirm, which Tauri shims to an
 * async function — `if (!confirm(...))` tested a Promise, was always truthy,
 * and the guard silently never fired. None of that was testable at all.
 */

const overlay = () => document.querySelector(".ask");
const btn = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".ask-btn")].find(
    (b) => b.textContent === label
  )!;
const input = () => document.querySelector<HTMLInputElement>(".ask-input")!;
const key = (k: string) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("confirmAction", () => {
  it("resolves true only when the user actually says yes", async () => {
    const p = confirmAction("Delete it?");
    expect(overlay()).not.toBeNull();
    btn("OK").click();
    expect(await p).toBe(true);
  });

  it("resolves false on cancel, escape and backdrop — a dismissal is a no", async () => {
    const cancelled = confirmAction("Delete it?");
    btn("Cancel").click();
    expect(await cancelled).toBe(false);

    const escaped = confirmAction("Delete it?");
    key("Escape");
    expect(await escaped).toBe(false);

    const dismissed = confirmAction("Delete it?");
    (overlay() as HTMLElement).click(); // the backdrop itself
    expect(await dismissed).toBe(false);
  });

  it("does not resolve until answered", async () => {
    let settled = false;
    void confirmAction("Delete it?").then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    btn("OK").click();
    await Promise.resolve();
  });

  it("cleans up after itself", async () => {
    const p = confirmAction("Delete it?");
    btn("OK").click();
    await p;
    expect(overlay()).toBeNull();
  });

  it("cancel is the first tab stop, since these guard destructive things", () => {
    void confirmAction("Delete it?");
    const buttons = [...document.querySelectorAll(".ask-btn")].map((b) => b.textContent);
    expect(buttons[0]).toBe("Cancel");
    btn("Cancel").click();
  });
});

describe("promptAction", () => {
  it("resolves what was typed", async () => {
    const p = promptAction("Waypoint name:", { value: "Camp" });
    expect(input().value).toBe("Camp");
    input().value = "Ridge camp";
    btn("OK").click();
    expect(await p).toBe("Ridge camp");
  });

  it("resolves null when cancelled, which is not the same as empty", async () => {
    const cancelled = promptAction("Waypoint name:", { value: "Camp" });
    btn("Cancel").click();
    expect(await cancelled).toBeNull();

    // Cleared and accepted is an empty string, and callers treat the two
    // differently — null means "leave it alone".
    const emptied = promptAction("Waypoint name:", { value: "Camp" });
    input().value = "";
    btn("OK").click();
    expect(await emptied).toBe("");
  });

  it("accepts on Enter and cancels on Escape", async () => {
    const entered = promptAction("Waypoint name:", { value: "Camp" });
    key("Enter");
    expect(await entered).toBe("Camp");

    const escaped = promptAction("Waypoint name:", { value: "Camp" });
    key("Escape");
    expect(await escaped).toBeNull();
  });

  it("shows the message as text, never as markup", async () => {
    const p = promptAction("<img src=x onerror=boom>", {});
    expect(document.querySelector(".ask-message")!.innerHTML).not.toContain("<img");
    expect(document.querySelector(".ask-message")!.textContent).toBe("<img src=x onerror=boom>");
    btn("Cancel").click();
    await p;
  });

  it("gives focus back to whatever opened it", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const p = promptAction("Waypoint name:", { value: "Camp" });
    expect(document.activeElement).toBe(input());
    btn("Cancel").click();
    await p;
    expect(document.activeElement).toBe(opener);
  });

  it("settles once, even if accepted twice", async () => {
    let count = 0;
    const p = promptAction("Waypoint name:", { value: "Camp" }).then((v) => {
      count++;
      return v;
    });
    const ok = btn("OK");
    ok.click();
    ok.click(); // Enter and a click can both land before removal
    expect(await p).toBe("Camp");
    expect(count).toBe(1);
  });
});
