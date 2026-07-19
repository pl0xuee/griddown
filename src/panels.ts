// Menu button behaviour shared by every HUD panel:
//   - clicking the button of an already-open panel closes it again (toggle)
//   - opening a panel closes any other panel that was open
//
// Each panel module still owns its own open/close logic (rendering, focus,
// map state). This just sits in front of them, so the modules stay unchanged.
//
// "Measure" is deliberately absent: it already toggles itself, and its readout
// is a small floating box that is fine to leave up alongside a panel.

const PANELS: ReadonlyArray<{ btn: string; panel: string }> = [
  { btn: "states-open", panel: "states-panel" },
  { btn: "handbook-open", panel: "handbook-panel" },
  { btn: "marks-open", panel: "marks-panel" },
  { btn: "goto-open", panel: "goto-box" },
  { btn: "sky-open", panel: "sky-panel" },
];

export function initPanels() {
  // Capture on `document` so this always runs before the button's own handler.
  // (Listeners on the button itself fire in registration order regardless of
  // the capture flag, which would make the ordering depend on init order.)
  document.addEventListener(
    "click",
    (e) => {
      const btn = (e.target as HTMLElement | null)?.closest?.("button");
      if (!btn) return;
      const hit = PANELS.find((p) => p.btn === btn.id);
      if (!hit) return;
      const panel = document.getElementById(hit.panel);
      if (!panel) return;

      if (!panel.classList.contains("hidden")) {
        // Already open: this click closes it. Stop the event so the module's
        // own opener doesn't immediately re-open it.
        panel.classList.add("hidden");
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }

      // Opening: clear the others, then let the module's opener run.
      for (const other of PANELS) {
        if (other.panel !== hit.panel) {
          document.getElementById(other.panel)?.classList.add("hidden");
        }
      }
    },
    true
  );
}
