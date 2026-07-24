// The plant reference panel — edible and dangerous plants, for your state.
//
// The interface enforces the same rule the data does: NOTHING EDIBLE IS EVER
// SHOWN ALONE. Opening an edible plant renders its dangerous lookalikes on the
// same screen, above the fold, before anything about how to eat it. You cannot
// reach "wild carrot" without meeting water hemlock on the way.
//
// Ordering is a safety decision, not a layout one — deadly first, always. See
// src/plants.ts for why state distribution never filters this list.

import { esc } from "./esc";
import {
  bySymbol,
  deadlyLookalikes,
  hasStateRecords,
  isDangerous,
  isEdible,
  lookalikes,
  matchCommonName,
  plantsForState,
  type Plant,
  type PlantData,
  type Verdict,
} from "./plants";

let data: PlantData | null = null;
/** The in-flight fetch, so concurrent callers share one request. */
let loading: Promise<void> | null = null;
let currentState = "";
/** Symbol of the plant being shown in detail, or null for the list. */
let openSymbol: string | null = null;
let query = "";
/** Set by initPlantPanel — the single way this panel is ever opened. */
let openPanel: (symbol?: string) => Promise<void> = async () => {};

const VERDICT_LABEL: Record<Verdict, string> = {
  deadly: "Deadly",
  toxic: "Poisonous",
  irritant: "Skin irritant",
  "edible-with-care": "Edible — with care",
  edible: "Edible",
};

/** The permanent caution. Never suppressed, never shortened, always last. */
const CAUTION =
  "This is a reference, not an identification. It cannot tell you what plant you " +
  "are holding. Deadly lookalikes exist for most edible plants — never eat anything " +
  "you have not identified with total certainty from a field guide and, ideally, a " +
  "person who knows it.";

function imgHtml(p: Plant, max = 1): string {
  if (!p.images.length) return "";
  return p.images
    .slice(0, max)
    .map(
      (im) =>
        `<figure class="pl-fig"><img loading="lazy" src="/plantimg/${esc(im.path)}" alt="${esc(p.common)}" />` +
        `<figcaption>` +
        // Say so when the photo is of a relative. Someone matching a plant
        // against a picture needs to know it is the genus, not the species.
        (im.of ? `<b class="pl-of">Pictured: ${esc(im.of)}</b> &middot; ` : "") +
        `${esc(im.credit)} &middot; USDA PLANTS, public domain</figcaption></figure>`
    )
    .join("");
}

function thumbHtml(p: Plant): string {
  if (!p.images.length) {
    return `<span class="pl-thumb pl-thumb--none" aria-hidden="true">${isDangerous(p) ? "&#9760;" : "&#127807;"}</span>`;
  }
  // Same rule as imgHtml, and it matters more here: this thumbnail sits under
  // the "Confused with" heading, where the picture IS the comparison. Prefer a
  // photo of the entry itself, and when only a relative's exists — genus entries
  // like death camas borrow one, and Staghorn sumac's is poison ivy — say whose
  // it is rather than showing an unlabelled picture of the wrong species.
  const im = p.images.find((i) => !i.of) ?? p.images[0];
  if (!im.of) {
    return `<img class="pl-thumb" loading="lazy" src="/plantimg/${esc(im.path)}" alt="${esc(p.common)}" />`;
  }
  const of = `Pictured: ${im.of}`;
  return (
    `<img class="pl-thumb" loading="lazy" src="/plantimg/${esc(im.path)}" alt="${esc(of)}" title="${esc(of)}" />` +
    `<b class="pl-of" title="${esc(of)}" aria-hidden="true">&#9432;</b>`
  );
}

/** One row in the list. */
function rowHtml(p: Plant, recordedHere: boolean): string {
  const danger = deadlyLookalikes(data!, p).length > 0 && isEdible(p);
  return `
    <button class="pl-row" type="button" data-symbol="${esc(p.symbol)}">
      ${thumbHtml(p)}
      <span class="pl-row-body">
        <span class="pl-row-name">${esc(p.common)}</span>
        <span class="pl-row-sci">${esc(p.scientific)}</span>
        ${danger ? `<span class="pl-row-warn">Has a deadly lookalike</span>` : ""}
      </span>
      <span class="pl-row-side">
        <span class="pl-badge pl-${esc(p.verdict)}">${esc(VERDICT_LABEL[p.verdict])}</span>
        ${recordedHere ? `<span class="pl-here">Recorded here</span>` : ""}
      </span>
    </button>`;
}

/** A lookalike, rendered inline inside another plant's detail view. */
function lookalikeHtml(p: Plant): string {
  return `
    <button class="pl-look pl-look--${esc(p.verdict)}" type="button" data-symbol="${esc(p.symbol)}">
      ${thumbHtml(p)}
      <span class="pl-look-body">
        <span class="pl-look-name">${esc(p.common)}</span>
        <span class="pl-badge pl-${esc(p.verdict)}">${esc(VERDICT_LABEL[p.verdict])}</span>
        <span class="pl-look-tell">${esc(p.tell)}</span>
      </span>
    </button>`;
}

function detailHtml(p: Plant): string {
  const looks = lookalikes(data!, p);
  const deadly = looks.filter((l) => l.verdict === "deadly");

  // The lookalike block comes FIRST for anything edible. Meeting the thing that
  // can kill you before reading which parts are tasty is the whole point.
  const lookBlock = looks.length
    ? `<div class="pl-section pl-section--warn">
         <div class="pl-h">${
           deadly.length
             ? `&#9888; Confused with ${deadly.length === 1 ? "a plant that kills" : "plants that kill"}`
             : "Confused with"
         }</div>
         ${looks.map(lookalikeHtml).join("")}
       </div>`
    : "";

  const eff = p.effect
    ? `<div class="pl-section"><div class="pl-h">What it does to you</div><p>${esc(p.effect)}</p></div>`
    : "";
  const parts = p.edibleParts
    ? `<div class="pl-section"><div class="pl-h">Traditionally eaten</div><p>${esc(p.edibleParts)}</p></div>`
    : "";

  return `
    <button id="pl-back" class="pl-back" type="button">&#8592; All plants</button>
    <div class="pl-detail">
      <div class="pl-title-row">
        <div>
          <div class="pl-title">${esc(p.common)}</div>
          <div class="pl-sci">${esc(p.scientific)} &middot; ${esc(p.family)}</div>
        </div>
        <span class="pl-badge pl-${esc(p.verdict)}">${esc(VERDICT_LABEL[p.verdict])}</span>
      </div>

      ${
        p.images.length
          ? imgHtml(p, 3)
          : `<div class="pl-nophoto">No public-domain photograph available${
              p.family.startsWith("Fungus") ? " — USDA PLANTS does not cover fungi" : ""
            }. Use a field guide for this one; the description and the tell below are not enough on their own.</div>`
      }

      ${isEdible(p) ? lookBlock : ""}

      <div class="pl-section pl-section--tell">
        <div class="pl-h">How to tell</div>
        <p>${esc(p.tell)}</p>
      </div>

      <div class="pl-section"><div class="pl-h">What it looks like</div><p>${esc(p.description)}</p></div>
      <div class="pl-section"><div class="pl-h">Where and when</div><p>${esc(p.habitat)} ${esc(p.season)}</p></div>
      ${eff}${parts}
      ${isEdible(p) ? "" : lookBlock}
    </div>`;
}

function listHtml(): string {
  const q = query.trim().toLowerCase();
  const rows = plantsForState(data!, currentState).filter(
    ({ plant: p }) =>
      !q ||
      p.common.toLowerCase().includes(q) ||
      p.scientific.toLowerCase().includes(q) ||
      p.family.toLowerCase().includes(q)
  );

  if (!rows.length) {
    return `<div class="pl-empty">Nothing matches “${esc(query)}”.</div>`;
  }

  // Grouped by verdict, deadliest first — plantsForState already sorted them.
  let html = "";
  let last: Verdict | null = null;
  for (const { plant, recordedHere } of rows) {
    if (plant.verdict !== last) {
      last = plant.verdict;
      html += `<div class="pl-group">${esc(VERDICT_LABEL[plant.verdict])}</div>`;
    }
    html += rowHtml(plant, recordedHere);
  }

  const note = currentState
    ? hasStateRecords(data!, currentState)
      ? `<div class="pl-note">“Recorded here” marks plants USDA records in ${esc(currentState)}. ` +
        `An unmarked plant may still grow here — the records are incomplete, so nothing is hidden from this list.</div>`
      : `<div class="pl-note">No state records are available for ${esc(currentState)}, so every plant is shown. ` +
        `Assume anything here may grow near you.</div>`
    : "";

  return note + html;
}

function render() {
  const body = document.getElementById("plants-body");
  const caution = document.getElementById("plants-caution");
  if (caution && !caution.textContent) caution.textContent = CAUTION;
  const search = document.getElementById("plants-search") as HTMLInputElement | null;
  if (!body || !data) return;

  if (openSymbol) {
    const p = bySymbol(data, openSymbol);
    if (p) {
      if (search) search.hidden = true;
      body.innerHTML = detailHtml(p);
      body.scrollTop = 0;
      return;
    }
    openSymbol = null;
  }
  if (search) search.hidden = false;
  body.innerHTML = listHtml();
}

/**
 * Fetch the reference, once.
 *
 * Started at init rather than on first open, because findPlant() is synchronous
 * and main.ts calls it while building the Wild food card: before this ran, a tap
 * on a meadow made every chip inert, silently dropping the link from Wild onion
 * to death camas until the user had opened the panel by hand at least once.
 *
 * Idempotent both ways — a resolved fetch is never repeated, and a second caller
 * arriving mid-flight waits on the same promise. A failure clears the latch so
 * opening the panel retries.
 */
function load(): Promise<void> {
  if (data) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      try {
        data = await (await fetch(`${location.origin}/plants.json`)).json();
      } catch {
        loading = null;
        const body = document.getElementById("plants-body");
        if (body) {
          body.innerHTML =
            `<div class="pl-empty">The plant reference didn't load. It ships with the app, so this ` +
            `is a problem with the install rather than with your connection.</div>`;
        }
      }
    })();
  }
  return loading;
}

/**
 * Re-link the Wild food card's plant chips.
 *
 * main.ts builds that card from a synchronous findPlant(), so one rendered
 * during the initial load is stuck with inert chips and no route to the
 * lookalikes. Rather than leave it that way, upgrade the chips in place once the
 * data lands. Only the first chip row is touched: the second is game, not plants.
 */
function linkForageChips() {
  if (!data) return;
  const row = document.querySelector("#forage-box .card-chips");
  if (!row) return;
  for (const chip of [...row.querySelectorAll("span.card-chip")]) {
    const name = chip.textContent ?? "";
    const symbol = matchCommonName(data, name);
    if (!symbol) continue;
    const link = document.createElement("button");
    link.className = "card-chip card-chip--link";
    link.type = "button";
    link.dataset.plant = symbol;
    link.innerHTML = `${esc(name)} &#8250;`;
    link.addEventListener("click", () => openPlant(symbol));
    chip.replaceWith(link);
  }
}

/**
 * @param getState returns the two-letter abbreviation of the active map pack,
 *                 so the list can mark what is recorded where you actually are.
 */
export function initPlantPanel(getState: () => string) {
  const panel = document.getElementById("plants-panel");
  const body = document.getElementById("plants-body");
  const search = document.getElementById("plants-search") as HTMLInputElement | null;

  void load().then(linkForageChips);

  openPanel = async (symbol?: string) => {
    openSymbol = symbol ?? null;
    query = "";
    if (search) search.value = "";
    currentState = (getState() || "").toUpperCase();
    panel?.classList.remove("hidden");
    await load();
    render();
  };

  document.getElementById("plants-open")?.addEventListener("click", () => void openPanel());

  document.getElementById("plants-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });

  search?.addEventListener("input", () => {
    query = search.value;
    render();
  });

  // One delegated handler: rows and inline lookalikes both carry data-symbol, so
  // tapping a killer from inside an edible's page opens it — and its own page
  // names the edible right back, because the data pairs both ways.
  body?.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest("#pl-back")) {
      openSymbol = null;
      render();
      return;
    }
    const hit = t?.closest<HTMLElement>("[data-symbol]");
    if (!hit) return;
    openSymbol = hit.dataset.symbol ?? null;
    render();
  });
}

/**
 * Open the panel straight onto one plant.
 *
 * This used to synthesise a click on #plants-open, which was wrong twice over:
 * panels.ts reads a click on an already-open panel's button as "close it", so
 * asking for a plant while the panel was up closed it instead; and that handler
 * is async, so this function's own render() raced the awaited load(). Both entry
 * points now call the same opener with the symbol passed explicitly.
 */
export function openPlant(symbol: string) {
  void openPanel(symbol);
}

/** Free-text plant name -> symbol, for the Wild food card. See matchCommonName. */
export function findPlant(text: string): string | null {
  return data ? matchCommonName(data, text) : null;
}

