// Offline survival handbook: a curated quick-reference cheat sheet, plus the full
// public-domain U.S. Army Survival Manual (FM 21-76), bundled and searchable.

interface Section {
  title: string;
  items: string[]; // pre-formatted HTML (authored here, safe to inject)
}

const QUICK: Section[] = [
  {
    title: "Priorities — the Rule of 3s",
    items: [
      "Roughly: 3 minutes without <b>air</b>, 3 hours without <b>shelter</b> in harsh weather, 3 days without <b>water</b>, 3 weeks without <b>food</b>.",
      "Act in that order. Exposure kills faster than hunger — sort shelter and warmth before food.",
      "<b>STOP</b>: Stop, Think, Observe, Plan. Don't move in a panic.",
      "If lost, usually <b>stay put</b> — you're easier to find and you conserve energy.",
    ],
  },
  {
    title: "Water — find & make it safe",
    items: [
      "Find it: flowing streams, springs, rain, dew, snow (melt it first).",
      "Prefer clear, moving water. Avoid stagnant water or water near dead animals.",
      "<b>Boil</b> to purify: a rolling boil for 1 minute (3 minutes above ~2,000 m / 6,500 ft).",
      "No fire? Filter, then chemical treatment (unscented bleach ~2 drops/liter, wait 30 min) or tablets.",
      "Drink when thirsty; dark urine means drink more.",
    ],
  },
  {
    title: "Shelter & staying warm",
    items: [
      "Get <b>off the ground</b> — insulate underneath; the ground steals heat fast.",
      "Stay <b>dry</b> and block <b>wind</b>. Wet + wind is the fastest path to hypothermia.",
      "Keep it small — a shelter just bigger than your body traps heat.",
      "Avoid gullies (cold air, flash floods) and lone tall trees (lightning).",
    ],
  },
  {
    title: "Signal for rescue",
    items: [
      "<b>Three</b> of anything = distress: 3 fires in a triangle, 3 whistle blasts, 3 shouts.",
      "Ground signals in a clearing: a large <b>V</b> = need assistance, <b>X</b> = need medical help.",
      "A mirror or shiny surface can flash for miles. A whistle carries far and saves your voice.",
      "Smoke by day (add green leaves), flame by night.",
    ],
  },
  {
    title: "First aid — the big ones",
    items: [
      "<b>Severe bleeding</b>: press hard on the wound. For a limb that won't stop, apply a tourniquet 5–8 cm above it, tighten until bleeding stops, note the time.",
      "<b>Hypothermia</b>: get dry, insulate from the ground, add layers, share body heat, warm sweet drinks if fully alert.",
      "<b>Heat illness</b>: shade, cool with water, sip fluids. Hot dry skin + confusion is an emergency — cool aggressively.",
      "Clean wounds with clean water; cover them; watch for spreading redness.",
    ],
  },
  {
    title: "Navigate without GPS",
    items: [
      "Sun rises in the <b>east</b>, sets in the <b>west</b>; at midday it's due south (northern hemisphere).",
      "At night, find <b>Polaris</b> (North Star) off the Big Dipper's pointer stars — it marks true north.",
      "Pick a distant landmark on your bearing, walk to it, repeat — you'll drift less.",
      "Rivers generally lead downhill toward people.",
    ],
  },
];

interface Chapter {
  n: number;
  title: string;
  text: string;
}
let manual: { source: string; chapters: Chapter[] } | null = null;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function chapterBodyHtml(text: string): string {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) =>
      l.startsWith("• ")
        ? `<div class="hb-bullet">• ${esc(l.slice(2))}</div>`
        : `<p>${esc(l)}</p>`
    )
    .join("");
}

export async function initHandbook() {
  const content = document.getElementById("handbook-content");
  const panel = document.getElementById("handbook-panel");
  const search = document.getElementById("handbook-search") as HTMLInputElement | null;

  try {
    manual = await (await fetch("/handbook.json")).json();
  } catch {
    manual = null;
  }

  function render() {
    if (!content) return;
    const q = (search?.value || "").toLowerCase().trim();

    // Quick reference cards
    const quick = QUICK.map((sec) => {
      const matchTitle = sec.title.toLowerCase().includes(q);
      const items = q ? sec.items.filter((i) => i.toLowerCase().includes(q) || matchTitle) : sec.items;
      if (items.length === 0) return "";
      return `<div class="hb-section ${q ? "" : "collapsed"}">
          <div class="hb-title">${sec.title}<span class="hb-icon">▾</span></div>
          <div class="hb-body"><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul></div>
        </div>`;
    }).join("");

    // Full manual chapters (bodies rendered lazily on expand)
    const chaps = (manual?.chapters || [])
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.text.toLowerCase().includes(q))
      .map((c) => {
        const open = q ? "" : "collapsed";
        const body = q ? chapterBodyHtml(c.text) : "";
        return `<div class="hb-section ${open}" data-chapter="${c.n}">
            <div class="hb-title">${c.n}. ${esc(c.title)}<span class="hb-icon">▾</span></div>
            <div class="hb-body">${body}</div>
          </div>`;
      })
      .join("");

    content.innerHTML =
      `<div class="hb-group">Quick reference</div>${quick}` +
      (manual
        ? `<div class="hb-group">Field manual — FM 21-76 <span class="hb-src">public domain</span></div>${chaps || `<div class="hb-empty">No chapters match "${q}".</div>`}`
        : "");

    content.querySelectorAll<HTMLElement>(".hb-title").forEach((t) => {
      t.addEventListener("click", () => {
        const sec = t.parentElement as HTMLElement;
        sec.classList.toggle("collapsed");
        // Lazy-render manual chapter body on first open
        const chapId = sec.getAttribute("data-chapter");
        const bodyEl = sec.querySelector<HTMLElement>(".hb-body");
        if (chapId && bodyEl && !bodyEl.innerHTML) {
          const ch = manual?.chapters.find((c) => String(c.n) === chapId);
          if (ch) bodyEl.innerHTML = chapterBodyHtml(ch.text);
        }
      });
    });
  }

  search?.addEventListener("input", render);
  render();

  document.getElementById("handbook-open")?.addEventListener("click", () => {
    panel?.classList.remove("hidden");
  });
  document.getElementById("handbook-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });
}
