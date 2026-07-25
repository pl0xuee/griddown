import { currentMarks, loadMarks, marksUnreadable, updateMarks } from "./store";
import {
  expiryState,
  instantiate,
  kitIssues,
  kitProgress,
  supplyCoverage,
  supplyTargets,
  WATER_L_PER_DAY,
  type ExpiryState,
  type Kit,
  type KitItem,
} from "./kit";
import { KIT_TEMPLATES } from "./kitdata";
import { confirmAction, promptAction } from "./dialog";
import { esc } from "./esc";
import { toast } from "./toast";

// The Kit panel — what you have, and whether it still works.
//
// The tickbox is the easy half. The half that earns the feature is the DATE:
// a go bag packed once and never opened is a bag of expired water tablets, flat
// batteries and medication that stopped working two years ago, and the tickbox
// will still say you are ready. Rotation is what actually kills preparations,
// so every item can carry a shelf life, and Readiness counts what has lapsed.
//
// All logic lives in kit.ts, which is pure and tested. This file is DOM.

/** How many people the supply maths is for. A household setting, not a kit one —
 *  the same bag feeds a different number of days depending who is eating. */
const PEOPLE_KEY = "griddown_people";

let loaded = false;
let kits: Kit[] = [];
let openId: string | null = null;
/** Sections collapsed in the detail view, by title. */
const collapsed = new Set<string>();

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function people(): number {
  try {
    const n = Number(localStorage.getItem(PEOPLE_KEY));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  } catch {
    return 1;
  }
}

function setPeople(n: number) {
  try {
    localStorage.setItem(PEOPLE_KEY, String(n));
  } catch {
    /* storage unavailable — the default of 1 is still honest */
  }
}

function body(): HTMLElement | null {
  return document.getElementById("kit-body");
}

function findKit(id: string | null): Kit | undefined {
  return kits.find((k) => k.id === id);
}

function replaceKit(next: Kit) {
  kits = kits.map((k) => (k.id === next.id ? next : k));
}

async function persist(): Promise<void> {
  try {
    // A patch: this module owns kits and nothing else. See store.ts.
    await updateMarks({ kits });
  } catch (e) {
    toast(e instanceof Error ? e.message : "Couldn't save your kit.", "error", 7000);
  }
}

/** Apply a change to one item, wherever it lives in the kit. */
function mapItem(k: Kit, itemId: string, f: (i: KitItem) => KitItem): Kit {
  return {
    ...k,
    sections: k.sections.map((s) => ({
      ...s,
      items: s.items.map((i) => (i.id === itemId ? f(i) : i)),
    })),
  };
}

const EXPIRY_TEXT: Record<ExpiryState, string> = {
  expired: "expired",
  soon: "expires",
  ok: "good until",
  none: "",
};

// --- Rendering ---------------------------------------------------------------

function bar(pct: number, expired: number): string {
  return `<div class="kt-bar"><div class="kt-bar-fill${
    expired ? " has-expired" : ""
  }" style="width:${pct}%"></div></div>`;
}

function renderList() {
  const el = body();
  if (!el) return;
  if (marksUnreadable()) {
    el.innerHTML = `<div class="kt-empty">Your saved data couldn't be read, so this
      list may be wrong. Restart the app before changing anything — see Readiness.</div>`;
    return;
  }
  const now = Date.now();
  const rows = kits
    .map((k) => {
      const i = kitIssues(k, now);
      const flags = [
        i.expired ? `<span class="kt-flag bad">${i.expired} expired</span>` : "",
        i.soon ? `<span class="kt-flag warn">${i.soon} due soon</span>` : "",
      ].join("");
      return `<div class="kt-row" data-open="${esc(k.id)}">
          <div class="kt-info">
            <div class="kt-name">▤ ${esc(k.name)}</div>
            <div class="kt-sub">${i.have} of ${i.total} packed${
              i.grams ? ` · ${(i.grams / 1000).toFixed(1)} kg` : ""
            }</div>
            ${bar(i.pct, i.expired)}
            <div class="kt-flags">${flags}</div>
          </div>
          <div class="kt-pct">${i.pct}%</div>
        </div>`;
    })
    .join("");

  el.innerHTML = `
    <div class="kt-actions">
      <button id="kt-add" type="button">＋ Add a checklist</button>
      <button id="kt-people" type="button">Household: ${people()}</button>
    </div>
    ${
      rows ||
      `<div class="kt-empty">No checklists yet.
        <p>Start with the <b>go bag</b> — one person, on foot, three days — then
        the longer list for staying put.</p>
        <p>Tick what you have. Put a date on anything that expires: rotation is
        what actually kills preparations, and Readiness will count what has
        lapsed while there is still time to replace it.</p></div>`
    }
    <div class="kt-fine">Saved on this device only.</div>`;
}

function itemRow(i: KitItem, now: number): string {
  const state = expiryState(i, now);
  const qty =
    i.qty !== undefined ? `${i.qty}${i.unit ? ` ${esc(i.unit)}` : ""}` : "";
  const meta = [qty, i.grams ? `${i.grams} g` : ""].filter(Boolean).join(" · ");
  const exp =
    state === "none"
      ? ""
      : `<span class="kt-exp ${state}">${EXPIRY_TEXT[state]} ${esc(i.expires!)}</span>`;
  return `<div class="kt-item${i.have ? " have" : ""}" data-item="${esc(i.id)}">
      <button class="kt-tick" data-tick="${esc(i.id)}" type="button"
        aria-pressed="${i.have}" aria-label="${i.have ? "Packed" : "Not packed"}">${
          i.have ? "◼" : "◻"
        }</button>
      <div class="kt-item-info">
        <div class="kt-item-name">${esc(i.name)}</div>
        ${meta || exp ? `<div class="kt-item-meta">${meta}${meta && exp ? " · " : ""}${exp}</div>` : ""}
        ${i.note ? `<div class="kt-note">${esc(i.note)}</div>` : ""}
      </div>
      <button class="kt-edit" data-edit="${esc(i.id)}" type="button" aria-label="Edit">⋯</button>
    </div>`;
}

function renderDetail(k: Kit) {
  const el = body();
  if (!el) return;
  const now = Date.now();
  const prog = kitProgress(k);
  const n = people();
  const cov = supplyCoverage(k, n);
  const target = supplyTargets(n, 3);

  const sections = k.sections
    .map((s) => {
      const isShut = collapsed.has(s.title);
      const packed = s.items.filter((i) => i.have).length;
      return `<div class="kt-section${isShut ? " collapsed" : ""}">
          <button class="kt-section-head" data-section="${esc(s.title)}" type="button"
            aria-expanded="${!isShut}">
            <span>${esc(s.title)}</span>
            <span class="kt-section-count">${packed}/${s.items.length}<span class="kt-caret">▾</span></span>
          </button>
          <div class="kt-section-body">
            ${s.items.map((i) => itemRow(i, now)).join("") || `<div class="kt-empty">Nothing here yet.</div>`}
          </div>
        </div>`;
    })
    .join("");

  // Only shown when the kit actually states litres or days. Guessing a figure
  // someone would plan around is worse than saying nothing — see kit.ts.
  const supply =
    cov.waterDays != null || cov.foodDays != null
      ? `<div class="kt-supply">
          ${
            cov.waterDays != null
              ? `<div><b>${cov.waterL} L</b> of water — about <b>${cov.waterDays.toFixed(
                  1
                )} days</b> for ${n} at ${WATER_L_PER_DAY} L each per day.</div>`
              : ""
          }
          ${cov.foodDays != null ? `<div><b>${cov.foodDays} days</b> of food stated.</div>` : ""}
        </div>`
      : `<div class="kt-fine">Give water items a quantity in <b>L</b>, or food in
         <b>days</b>, and this works out how long you'd last. ${n} ${
           n === 1 ? "person needs" : "people need"
         } ${target.waterL} L for three days.</div>`;

  el.innerHTML = `
    <button id="kt-back" class="kt-back" type="button">‹ All checklists</button>
    <div class="kt-title-row">
      <div>
        <div class="kt-name">▤ ${esc(k.name)}</div>
        <div class="kt-sub">${prog.have} of ${prog.total} packed${
          prog.grams ? ` · ${(prog.grams / 1000).toFixed(1)} kg carried` : ""
        }</div>
      </div>
      <div class="kt-pct">${prog.pct}%</div>
    </div>
    ${bar(prog.pct, kitIssues(k, now).expired)}
    ${supply}
    <div class="kt-actions">
      <button id="kt-additem" type="button">＋ Add an item</button>
      <button id="kt-addsection" type="button">＋ Add a section</button>
      <button id="kt-rename" type="button">Rename</button>
    </div>
    ${sections}

    <!-- Alone at the foot, for the same reason as the Plan panel: deleting a
         checklist you have spent an evening filling in should not be the
         biggest button on the screen. -->
    <div class="pn-danger-row">
      <button id="kt-delete" type="button" class="pn-danger">Delete this checklist</button>
    </div>`;
}

/** Which screen was last drawn, so we know whether the scroll position from
 *  before still refers to the same content. */
let lastView = "";

/**
 * Redraw, keeping your place.
 *
 * Every action here rebuilds the panel's innerHTML, and that resets scrollTop
 * to zero. On a 64-item go bag that means ticking the fortieth item throws you
 * back to the first — once, and you stop ticking things. Restoring the offset
 * whenever the view is still the same screen costs nothing and is the whole
 * difference between a usable checklist and a maddening one. Changing screens
 * deliberately starts at the top.
 */
function render() {
  const el = body();
  const k = findKit(openId);
  const view = k ? `detail:${k.id}` : "list";
  const keep = view === lastView ? (el?.scrollTop ?? 0) : 0;

  if (k) renderDetail(k);
  else {
    openId = null;
    renderList();
  }

  lastView = view;
  if (el) el.scrollTop = keep;
}

// --- Actions -----------------------------------------------------------------

async function addFromTemplate() {
  const list = KIT_TEMPLATES.map((t, i) => `${i + 1}. ${t.name}`).join("  ");
  const choice = await promptAction(`Which checklist? ${list}`, {
    value: "1",
    okLabel: "Add",
  });
  if (choice == null) return;
  const t = KIT_TEMPLATES[Number(choice.trim()) - 1];
  if (!t) {
    toast("No checklist with that number.", "error");
    return;
  }
  const k = instantiate(t, { id: rid(), now: Date.now() });
  kits = kits.concat(k);
  await persist();
  openId = k.id;
  render();
  toast(t.blurb, "info", 7000);
}

async function editItem(k: Kit, itemId: string) {
  const item = k.sections.flatMap((s) => s.items).find((i) => i.id === itemId);
  if (!item) return;
  const qty = await promptAction(`How many/much ${item.name}?`, {
    value: item.qty === undefined ? "" : String(item.qty),
    placeholder: "leave blank for none",
  });
  if (qty == null) return;
  const unit = await promptAction("Unit", {
    value: item.unit ?? "",
    placeholder: "L, days, cans, pairs",
  });
  const expires = await promptAction("Rotate or expire by (YYYY-MM-DD)", {
    value: item.expires ?? "",
    placeholder: "leave blank for none",
  });
  const n = Number(qty.trim());
  replaceKit(
    mapItem(k, itemId, (i) => ({
      ...i,
      qty: qty.trim() && Number.isFinite(n) ? n : undefined,
      unit: (unit ?? "").trim() || undefined,
      expires: (expires ?? "").trim() || undefined,
    }))
  );
  await persist();
  render();
}

async function addItem(k: Kit) {
  const name = await promptAction("What is it?", { placeholder: "Spare glasses" });
  if (!name?.trim()) return;
  const titles = k.sections.map((s, i) => `${i + 1}. ${s.title}`).join("  ");
  const where = await promptAction(`Which section? ${titles}`, { value: "1" });
  if (where == null) return;
  const idx = Number(where.trim()) - 1;
  if (!k.sections[idx]) {
    toast("No section with that number.", "error");
    return;
  }
  const sections = k.sections.map((s, i) =>
    i === idx
      ? { ...s, items: s.items.concat({ id: rid(), name: name.trim(), have: false }) }
      : s
  );
  replaceKit({ ...k, sections });
  await persist();
  render();
}

// --- Wiring ------------------------------------------------------------------

function onClick(e: MouseEvent) {
  const t = (e.target as HTMLElement | null)?.closest?.(
    "button, [data-open]"
  ) as HTMLElement | null;
  if (!t) return;
  const k = findKit(openId);

  if (t.id === "kt-add") {
    void addFromTemplate();
    return;
  }
  if (t.id === "kt-people") {
    void (async () => {
      const n = await promptAction("How many people is this kit for?", {
        value: String(people()),
      });
      const v = Number((n ?? "").trim());
      if (Number.isFinite(v) && v > 0) setPeople(Math.floor(v));
      render();
    })();
    return;
  }
  const open = t.dataset.open;
  if (open) {
    openId = open;
    render();
    return;
  }
  if (!k) return;

  if (t.id === "kt-back") {
    openId = null;
    render();
    return;
  }
  if (t.id === "kt-additem") {
    void addItem(k);
    return;
  }
  if (t.id === "kt-addsection") {
    void (async () => {
      const title = await promptAction("Name the section", { placeholder: "Dog" });
      if (!title?.trim()) return;
      replaceKit({ ...k, sections: k.sections.concat({ title: title.trim(), items: [] }) });
      await persist();
      render();
    })();
    return;
  }
  if (t.id === "kt-rename") {
    void (async () => {
      const name = await promptAction("Rename this checklist", { value: k.name });
      if (!name?.trim()) return;
      replaceKit({ ...k, name: name.trim() });
      await persist();
      render();
    })();
    return;
  }
  if (t.id === "kt-delete") {
    void (async () => {
      const ok = await confirmAction(`Delete "${k.name}" and everything ticked on it?`);
      if (!ok) return;
      kits = kits.filter((x) => x.id !== k.id);
      openId = null;
      await persist();
      render();
    })();
    return;
  }

  const tick = t.dataset.tick;
  if (tick) {
    replaceKit(mapItem(k, tick, (i) => ({ ...i, have: !i.have })));
    void persist();
    render();
    return;
  }
  const edit = t.dataset.edit;
  if (edit) {
    void editItem(k, edit);
    return;
  }
  const section = t.dataset.section;
  if (section) {
    if (collapsed.has(section)) collapsed.delete(section);
    else collapsed.add(section);
    render();
    return;
  }
}

export function initKit() {
  const panel = document.getElementById("kit-panel");

  const load = () => {
    kits = currentMarks().kits;
    render();
  };

  void loadMarks().then(() => {
    loaded = true;
    load();
  });

  document.getElementById("kit-open")?.addEventListener("click", () => {
    panel?.classList.remove("hidden");
    if (loaded) load();
    else render();
  });
  document.getElementById("kit-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });
  body()?.addEventListener("click", onClick);

  // A restore replaces what's on disk under us.
  document.addEventListener("griddown:marks-changed", () => {
    kits = currentMarks().kits;
    if (openId && !findKit(openId)) openId = null;
    render();
  });
}
