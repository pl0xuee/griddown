import { invoke } from "@tauri-apps/api/core";
import { loadMarks, marksUnreadable } from "./store";
import { planIssues } from "./plan";
import { kitIssues } from "./kit";
import { rosterIssues } from "./roster";
import { PLAN_PDF_KEY } from "./planprint";

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

    // Pack freshness — the oldest one sets the verdict. modified is 0 when the
    // backend couldn't read the file's date, and a 0 wins any "which is oldest"
    // comparison outright: one undatable pack used to report the whole check as
    // Unknown, hiding a genuinely three-year-old pack behind it. Judge the packs
    // we do have dates for, and say separately which ones we don't.
    const dated = packs.filter((p) => p.modified);
    const undated = packs.filter((p) => !p.modified);
    if (!dated.length) {
      checks.push({ label: "Pack freshness", level: "warn", detail: "Unknown." });
    } else {
      const oldest = dated.reduce((a, b) => (a.modified < b.modified ? a : b));
      const age = now - oldest.modified;
      if (age > 730 * DAY) {
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
      if (undated.length) {
        checks.push({
          label: "Pack age unknown",
          level: "warn",
          detail: `Couldn't read the download date of ${undated
            .map((p) => p.abbr.toUpperCase())
            .join(", ")} — ${undated.length === 1 ? "it may be" : "they may be"} older than the above.`,
          fix: "Re-download from Map packs if you can't remember when you last did.",
        });
      }
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
  const n =
    marks.waypoints.length +
    marks.tracks.length +
    marks.plans.length +
    marks.kits.length;
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

  // --- The plan ---
  //
  // This is the part of the panel that has to be read *now*. Everything a plan
  // says is decided in advance, so everything wrong with one is fixable in
  // advance — and only in advance. A missing map pack is a download today and an
  // impossibility next week.
  const nowMs = Date.now();
  const installedPacks = packs.map((p) => p.abbr);
  if (!unreadable) {
    if (!marks.plans.length) {
      checks.push({
        label: "Bug-out plan",
        level: "bad",
        detail: "No plan saved.",
        fix: "A route worked out today is a route you don't have to compute on the day. Get there → Save to plan, or start one in Plan.",
      });
    } else {
      const issues = marks.plans.flatMap((p) =>
        planIssues(p, { installedPacks, now: nowMs })
      );
      const routes = marks.plans.reduce((t, p) => t + p.routes.length, 0);
      checks.push({
        label: "Bug-out plan",
        level: issues.length ? "warn" : "ok",
        detail: `${marks.plans.length} plan(s), ${routes} route(s) frozen to disk.`,
      });
      // Each plan's own complaints, in its own words — see plan.ts.
      for (const i of issues) checks.push(i);

      // Paper is the only copy that survives a dead battery, and this app runs
      // on the device most likely to be flat when it matters.
      const printed = Number(localStorage.getItem(PLAN_PDF_KEY) || 0);
      checks.push(
        printed
          ? {
              label: "Plan on paper",
              level: "ok",
              detail: `Last printed ${fmtAge(now - Math.floor(printed / 1000))}.`,
            }
          : {
              label: "Plan on paper",
              level: "warn",
              detail: "Never printed.",
              fix: "Open the plan and press Print to paper. Put a copy in each go bag and one in the glovebox — it's the copy that works at 0%.",
            }
      );
    }

    // --- Roster & comms ---
    for (const i of rosterIssues(marks.roster, marks.comms)) checks.push(i);

    // --- Kit ---
    if (!marks.kits.length) {
      checks.push({
        label: "Kit",
        level: "warn",
        detail: "No checklists yet.",
        fix: "Kit → Add a checklist. Start with the go bag; it takes ten minutes and tells you what you're missing.",
      });
    } else {
      for (const k of marks.kits) {
        const i = kitIssues(k, nowMs);
        if (i.expired) {
          checks.push({
            label: k.name,
            level: "bad",
            detail: `${i.expired} item(s) expired · ${i.pct}% packed.`,
            fix: "Open it in Kit — expired items are listed with their dates. Replace them now; the tickbox says you're ready and the date says you aren't.",
          });
        } else if (i.soon) {
          checks.push({
            label: k.name,
            level: "warn",
            detail: `${i.soon} item(s) due for rotation${
              i.nextExpiry ? ` — next ${i.nextExpiry}` : ""
            } · ${i.pct}% packed.`,
            fix: "Replace them on the next shop rather than at the point of use.",
          });
        } else if (i.pct < 100) {
          checks.push({
            label: k.name,
            level: "warn",
            detail: `${i.have} of ${i.total} packed (${i.pct}%).`,
            fix: "Finish it while the shops are open.",
          });
        } else {
          checks.push({
            label: k.name,
            level: "ok",
            detail: `Complete, nothing expiring${
              i.nextExpiry ? ` before ${i.nextExpiry}` : ""
            }.`,
          });
        }
      }
    }
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
      fix: "Marks & tracks → Back up everything, and put it somewhere that isn't this phone.",
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
    // "You're ready to go dark" was the one line in this app that asserted
    // overall readiness from a partial signal. This panel can see map packs,
    // saved marks, a plan, a checklist percentage, a backup date and whether
    // location works. It cannot see water, medication, fuel, skills or anybody's
    // legs. Everywhere else the rule is that absence of data must not read as
    // absence of risk, and this has to follow it.
    const verdict = {
      ok: "Nothing left that this app can check. It cannot check water, medicine, fuel or practice — those are on you.",
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
