import { invoke } from "@tauri-apps/api/core";
import { loadMarks, marksUnreadable } from "./store";

// "Are you ready to go dark?" — a preflight check.
//
// The app assumes you set it up while you still have a connection, but it never
// tells you what's missing while that's still fixable. Everything here is
// checked against what's actually on disk, and every failing item says what to
// do about it now rather than later.

export const BACKUP_KEY = "griddown_last_backup";

type Level = "ok" | "warn" | "bad";
interface Check {
  label: string;
  level: Level;
  detail: string;
  /** What to do about it, shown only when it isn't already OK. */
  fix?: string;
}

interface Pack {
  abbr: string;
  bytes: number;
  modified: number;
}

export const DAY = 86400;

function hasTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function fmtAge(secs: number): string {
  const days = Math.floor(secs / DAY);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1)} years ago`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function buildChecks(terrainAvailable: () => boolean): Promise<Check[]> {
  const checks: Check[] = [];
  const now = Math.floor(Date.now() / 1000);

  // --- Map packs ---
  let packs: Pack[] = [];
  if (hasTauri()) {
    try {
      packs = await invoke<Pack[]>("pack_info");
    } catch {
      packs = [];
    }
  }
  const total = packs.reduce((n, p) => n + p.bytes, 0);
  if (packs.length === 0) {
    checks.push({
      label: "Map packs",
      level: "bad",
      detail: "None downloaded — only the bundled region is available.",
      fix: "Open Map packs and download the states you might travel through.",
    });
  } else {
    checks.push({
      label: "Map packs",
      level: "ok",
      detail: `${packs.length} downloaded (${fmtBytes(total)}): ${packs
        .map((p) => p.abbr.toUpperCase())
        .join(", ")}`,
    });

    // Pack freshness — the oldest one sets the verdict.
    const oldest = packs.reduce((a, b) => (a.modified < b.modified ? a : b));
    const age = oldest.modified ? now - oldest.modified : 0;
    if (!oldest.modified) {
      checks.push({ label: "Pack freshness", level: "warn", detail: "Unknown." });
    } else if (age > 730 * DAY) {
      checks.push({
        label: "Pack freshness",
        level: "bad",
        detail: `Oldest pack (${oldest.abbr.toUpperCase()}) downloaded ${fmtAge(age)}.`,
        fix: "Roads and trails change. Update it (↻ in Map packs) while you have a connection.",
      });
    } else if (age > 365 * DAY) {
      checks.push({
        label: "Pack freshness",
        level: "warn",
        detail: `Oldest pack (${oldest.abbr.toUpperCase()}) downloaded ${fmtAge(age)}.`,
        fix: "Consider updating it (↻ in Map packs) while you can.",
      });
    } else {
      checks.push({
        label: "Pack freshness",
        level: "ok",
        detail: `Oldest pack downloaded ${fmtAge(age)}.`,
      });
    }
  }

  // --- Terrain ---
  checks.push(
    terrainAvailable()
      ? { label: "Terrain", level: "ok", detail: "Elevation data available here." }
      : {
          label: "Terrain",
          level: "warn",
          detail: "No elevation data for the current map.",
          fix: "Hillshade, contours, elevation profile and line-of-sight need it. Use “△ Add terrain” on the state in Map packs.",
        }
  );

  // --- Your own data ---
  const marks = await loadMarks();
  const unreadable = marksUnreadable();
  const n = marks.waypoints.length + marks.tracks.length;
  if (unreadable) {
    // The whole point of this panel is catching exactly this before it matters.
    // An empty list here means "couldn't read", not "none" — reporting it as
    // healthy is the worst answer available.
    checks.push({
      label: "Your marks",
      level: "bad",
      detail: "Couldn't read your saved marks — the file may be damaged.",
      fix: "Restart the app. If this persists, restore from your most recent backup — don't add new pins first, that could overwrite them.",
    });
  } else {
    checks.push({
      label: "Your marks",
      level: "ok",
      detail: `${marks.waypoints.length} pin(s), ${marks.tracks.length} track(s), saved to disk.`,
    });
  }

  const last = Number(localStorage.getItem(BACKUP_KEY) || 0);
  if (unreadable) {
    checks.push({
      label: "Backup",
      level: "bad",
      detail: "Can't tell — your marks couldn't be read.",
      fix: "Sort out the marks problem above first.",
    });
  } else if (n === 0) {
    checks.push({
      label: "Backup",
      level: "ok",
      detail: "Nothing to back up yet.",
    });
  } else if (!last) {
    checks.push({
      label: "Backup",
      level: "bad",
      detail: "Never backed up.",
      fix: "Marks & tracks → Back up everything, then copy the file somewhere off this device.",
    });
  } else {
    const age = now - Math.floor(last / 1000);
    checks.push({
      label: "Backup",
      level: age > 90 * DAY ? "warn" : "ok",
      detail: `Last backup ${fmtAge(age)}.`,
      fix: age > 90 * DAY ? "Export a fresh copy — you've added marks since." : undefined,
    });
  }

  // --- Location ---
  checks.push(
    "geolocation" in navigator
      ? { label: "Location", level: "ok", detail: "Available on this device." }
      : {
          label: "Location",
          level: "warn",
          detail: "No location service.",
          fix: "Most desktops have no GPS chip. Track recording needs a phone or a USB GPS.",
        }
  );

  return checks;
}

export function initReadiness(terrainAvailable: () => boolean) {
  const panel = document.getElementById("readiness-panel");
  const content = document.getElementById("readiness-content");

  async function render() {
    if (!content) return;
    content.innerHTML = `<div class="rd-empty">Checking…</div>`;
    const checks = await buildChecks(terrainAvailable);

    const worst: Level = checks.some((c) => c.level === "bad")
      ? "bad"
      : checks.some((c) => c.level === "warn")
        ? "warn"
        : "ok";
    const verdict = {
      ok: "You're ready to go dark.",
      warn: "Mostly ready — a few things worth doing.",
      bad: "Not ready yet. Fix these while you still have a connection.",
    }[worst];

    const icon = { ok: "✓", warn: "!", bad: "✕" };
    content.innerHTML =
      `<div class="rd-verdict ${worst}">${verdict}</div>` +
      checks
        .map(
          (c) => `<div class="rd-row ${c.level}">
            <div class="rd-icon">${icon[c.level]}</div>
            <div class="rd-info">
              <div class="rd-label">${esc(c.label)}</div>
              <div class="rd-detail">${esc(c.detail)}</div>
              ${c.fix ? `<div class="rd-fix">${esc(c.fix)}</div>` : ""}
            </div>
          </div>`
        )
        .join("");
  }

  document.getElementById("readiness-open")?.addEventListener("click", () => {
    void render();
    panel?.classList.remove("hidden");
  });
  document.getElementById("readiness-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });
}
