// Offline survival reference. Concise, conservative, widely-accepted guidance.
// Not medical advice — see the disclaimer in the panel.

interface Section {
  title: string;
  items: string[];
}

const HANDBOOK: Section[] = [
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
      "Find it: flowing streams, springs, rain, dew, snow (melt it first — don't eat snow cold).",
      "Prefer clear, moving water over still/stagnant. Avoid water near dead animals or heavy algae.",
      "<b>Boil</b> to purify: a rolling boil for 1 minute (3 minutes above ~6,500 ft / 2,000 m).",
      "No fire? Use a filter, then chemical treatment (unscented household bleach: ~2 drops per liter, wait 30 min) or purification tablets.",
      "Cloudy water: let it settle or filter through cloth before treating.",
      "Ration sweat, not water — drink when thirsty; dark urine means drink more.",
    ],
  },
  {
    title: "Shelter & staying warm",
    items: [
      "Get <b>off the ground</b> — insulate underneath with leaves, boughs, or a pack; the ground steals heat fast.",
      "Stay <b>dry</b> and block <b>wind</b>. Wet + wind is the fastest route to hypothermia.",
      "Keep it small — a shelter just bigger than your body traps heat better.",
      "Use natural cover: rock overhangs, deadfall, dense evergreens. Avoid gullies (cold air, flash floods) and lone tall trees (lightning).",
      "Layer clothing; avoid sweating — remove a layer before you overheat, add it back at rest.",
    ],
  },
  {
    title: "Fire",
    items: [
      "Gather first: <b>tinder</b> (dry grass, bark, fluff), <b>kindling</b> (pencil-thin twigs), then <b>fuel</b> (wrist-thick). Have plenty before you light.",
      "Build on bare dirt or rock, sheltered from wind. Clear a 3 ft / 1 m ring of anything flammable.",
      "Start small, feed gradually. Give it air; don't smother it.",
      "Dry tinder in a pocket. Birch bark, pine resin/fatwood, and dry pine needles light even when damp.",
      "Never leave it unattended; drown, stir, and drown again to put it out.",
    ],
  },
  {
    title: "Signal for rescue",
    items: [
      "<b>Three</b> of anything = distress: 3 fires in a triangle, 3 whistle blasts, 3 shouts. Repeat.",
      "Make yourself big and unnatural: ground signals in a clearing (a large <b>V</b> = need assistance, <b>X</b> = need medical help).",
      "A signal mirror or any shiny surface can be seen for miles — flash toward aircraft/vehicles.",
      "A whistle carries far and saves your voice. Bright colors and movement draw the eye.",
      "Smoke by day (add green leaves), flame by night. Keep signals ready to light fast.",
    ],
  },
  {
    title: "First aid — the big ones",
    items: [
      "<b>Severe bleeding</b>: press hard directly on the wound with a cloth; keep pressure. For a limb that won't stop, apply a tourniquet 2–3 in above the wound, tighten until bleeding stops, note the time.",
      "<b>Hypothermia</b> (shivering, confusion, clumsiness): get dry, insulate from the ground, add layers, share body heat, warm sweet drinks if fully alert. Handle gently.",
      "<b>Heat illness</b>: move to shade, cool with water, sip fluids. Hot dry skin + confusion is an emergency — cool aggressively.",
      "<b>Dehydration</b>: rest, sip water, shade. Add a pinch of salt + sugar to water if you have it.",
      "<b>Sprains/breaks</b>: rest, immobilize/splint, elevate. Don't walk on a serious lower-leg injury if avoidable.",
      "Clean wounds with clean water; cover to keep dirt out; watch for spreading redness (infection).",
    ],
  },
  {
    title: "Navigate without GPS",
    items: [
      "Sun rises in the <b>east</b>, sets in the <b>west</b>. At midday it sits due south (northern hemisphere).",
      "Analog watch trick: point the hour hand at the sun; halfway between it and 12 points south.",
      "At night, find <b>Polaris</b> (North Star) off the Big Dipper's pointer stars — it marks true north.",
      "Pick a distant landmark on your bearing and walk to it, then repeat — you'll drift less.",
      "Note terrain as you go (ridge, stream, sun angle) so you can back-track. Rivers generally lead downhill to people.",
    ],
  },
  {
    title: "Food — caution first",
    items: [
      "Food is the <b>lowest</b> priority in a short survival situation — water and warmth matter far more.",
      "Do <b>not</b> eat unknown plants, berries, or mushrooms. Misidentification can kill; the risk rarely beats the reward.",
      "Safer calories: known nuts, cattail, fish, and (where legal/possible) small game.",
      "When unsure, go hungry. A few days without food won't harm a healthy adult.",
    ],
  },
  {
    title: "Essential knots",
    items: [
      "<b>Bowline</b>: a fixed loop that won't slip or jam — rescue, securing a line. \"Rabbit out of the hole, round the tree, back down the hole.\"",
      "<b>Square (reef) knot</b>: join two ropes of equal thickness — right over left, left over right.",
      "<b>Taut-line hitch</b>: an adjustable loop for tent guy-lines — slides to tension, then holds.",
      "<b>Two half-hitches</b>: quick, secure tie-off to a post, tree, or ring.",
      "<b>Clove hitch</b>: fast attach to a pole/tree; easy to adjust.",
    ],
  },
  {
    title: "Weather & terrain sense",
    items: [
      "Falling pressure, thickening/lowering clouds, and rising wind often mean a storm coming.",
      "In the mountains, storms often build in the afternoon — do exposed travel early.",
      "Avoid ridgelines and lone trees in lightning; get low, off metal, and crouch on insulation.",
      "Watch for flash-flood ground (narrow canyons, dry washes) after rain, even from storms miles away.",
      "Cold air pools in valleys at night — camp slightly above the valley floor if you can.",
    ],
  },
];

export function initHandbook() {
  const content = document.getElementById("handbook-content");
  const panel = document.getElementById("handbook-panel");
  const search = document.getElementById("handbook-search") as HTMLInputElement | null;

  function render() {
    if (!content) return;
    const q = (search?.value || "").toLowerCase().trim();
    const shown = HANDBOOK.map((sec) => {
      const matchTitle = sec.title.toLowerCase().includes(q);
      const items = q
        ? sec.items.filter((i) => i.toLowerCase().includes(q) || matchTitle)
        : sec.items;
      return { sec, items };
    }).filter((s) => s.items.length > 0);

    content.innerHTML =
      shown
        .map(
          ({ sec, items }, idx) => `
      <div class="hb-section ${q ? "" : idx === 0 ? "" : "collapsed"}">
        <div class="hb-title">${sec.title}<span class="hb-icon">▾</span></div>
        <div class="hb-body"><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul></div>
      </div>`
        )
        .join("") ||
      `<div style="opacity:.6;font-size:12px;padding:10px">Nothing matches "${q}".</div>`;

    content.querySelectorAll(".hb-title").forEach((t) => {
      t.addEventListener("click", () =>
        t.parentElement?.classList.toggle("collapsed")
      );
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
