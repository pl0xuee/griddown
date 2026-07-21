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
  { btn: "search-open", panel: "search-panel" },
  { btn: "route-open", panel: "route-panel" },
  { btn: "handbook-open", panel: "handbook-panel" },
  { btn: "marks-open", panel: "marks-panel" },
  { btn: "mesh-open", panel: "mesh-panel" },
  { btn: "compass-open", panel: "compass-box" },
  { btn: "sky-open", panel: "sky-panel" },
  { btn: "readiness-open", panel: "readiness-panel" },
  { btn: "print-open", panel: "print-panel" },
  { btn: "camp-open", panel: "camp-box" },
  { btn: "season-open", panel: "season-box" },
  { btn: "lakes-open", panel: "lakes-box" },
  { btn: "plants-open", panel: "plants-panel" },
];

/**
 * Light the command bar button belonging to whichever panel is showing, so the
 * bar reports state rather than only issuing commands.
 *
 * Watched with a MutationObserver rather than hooked onto the click handler
 * below, because panels are also opened and closed programmatically — a search
 * jump, an Escape key, a module closing itself. Observing the class attribute
 * catches every route into the state; watching clicks would only catch one.
 */
function watchPanelState(onOpen?: () => void) {
  const bar = document.getElementById("cmdbar");
  const cmds = bar
    ? [...bar.querySelectorAll<HTMLElement>(".cmd[data-forward]")]
    : [];

  let wasOpen = false;
  const sync = () => {
    let anyOpen = false;
    for (const p of PANELS) {
      const open = document.getElementById(p.panel)?.classList.contains("hidden") === false;
      if (open) anyOpen = true;
      for (const c of cmds) {
        if (c.dataset.forward === p.btn) c.classList.toggle("on", open);
      }
    }
    // Fires on the transition into "something is showing", so opening a panel
    // from inside the menu drops the menu — whichever button you used to do it.
    if (anyOpen && !wasOpen) onOpen?.();
    wasOpen = anyOpen;
  };

  const obs = new MutationObserver(sync);
  for (const p of PANELS) {
    const el = document.getElementById(p.panel);
    if (el) obs.observe(el, { attributes: true, attributeFilter: ["class"] });
  }
  sync();
}

/** Close every panel. Used by the command bar's More, which raises the menu
 *  over the top of whatever was showing. */
export function closeAllPanels() {
  for (const p of PANELS) {
    document.getElementById(p.panel)?.classList.add("hidden");
  }
}

/** Is any panel currently showing? */
export function anyPanelOpen(): boolean {
  return PANELS.some(
    (p) => document.getElementById(p.panel)?.classList.contains("hidden") === false
  );
}

export function initPanels(onPanelOpen?: () => void) {
  watchPanelState(onPanelOpen);

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
