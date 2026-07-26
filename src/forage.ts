// Wild food — what the land might feed you, and what might feed on you.
//
// A habitat guess from the basemap's `landuse` polygons plus elevation, region
// and season. Like the fishing guess, it points you at the right ground and the
// right handbook chapter — it is NOT a field guide and NOT plant identification.
// The caution is loud on purpose: wild plants and mushrooms have lookalikes that
// kill (water hemlock, death camas, destroying angel), so nothing here is ever a
// green light to eat. Pure and offline; tested in tests/forage.test.ts.

export type Habitat =
  | "conifer forest" | "hardwood forest" | "forest"
  | "meadow" | "brushland" | "wetland" | "farmland" | "orchard" | "vineyard";

export interface ForageGuess {
  habitat: Habitat;
  /** Edible or useful wild plants likely in this habitat, this season, here. */
  plants: string[];
  /** Animals to hunt or trap in this habitat. */
  game: string[];
  /** What the season is offering right now (a phrase, not a list). */
  seasonNote: string;
  /** The loud, always-present safety disclaimer. */
  caution: string;
  elevationKnown: boolean;
}

type Season = "spring" | "summer" | "fall" | "winter";

/** Northern-hemisphere season from a 0–11 month. The US packs are all northern,
 *  so no hemisphere flip is needed. */
export function seasonOf(month: number): Season {
  const m = ((month % 12) + 12) % 12;
  if (m <= 1 || m === 11) return "winter"; // Dec–Feb
  if (m <= 4) return "spring"; // Mar–May
  if (m <= 7) return "summer"; // Jun–Aug
  return "fall"; // Sep–Nov
}

function habitatFor(landuseKind: string, elevationFt: number | null, west: boolean): Habitat {
  const k = (landuseKind || "").toLowerCase();
  if (k === "farmland" || k === "farmyard") return "farmland";
  if (k === "orchard") return "orchard";
  if (k === "vineyard") return "vineyard";
  if (k === "wetland") return "wetland";
  if (k === "meadow" || k === "grassland" || k === "grass") return "meadow";
  if (k === "scrub") return "brushland";
  // forest / wood — split conifer vs hardwood by how high and cold it is. The
  // West's high country is conifer; lower and eastern ground trends hardwood.
  if (k === "forest" || k === "wood") {
    if (elevationFt == null) return west ? "conifer forest" : "hardwood forest";
    if (elevationFt >= 4500 || (west && elevationFt >= 3000)) return "conifer forest";
    return "hardwood forest";
  }
  return west ? "conifer forest" : "hardwood forest";
}

const CAUTION =
  "Never eat a wild plant or mushroom unless you have identified it with total " +
  "certainty — deadly lookalikes exist, and some of these are poisonous raw even " +
  "when you have named them right. This is a habitat guess, not identification. " +
  "Cross-check the Plants panel before you forage.";

/**
 * What will hurt you, per plant name this module can emit.
 *
 * plants.ts states the rule the whole plant dataset is built on: NOTHING EDIBLE
 * APPEARS ALONE — every edible entry names the thing it is confused with, and
 * checkPairing enforces it inside plants.json. This card sits OUTSIDE that
 * boundary. It emits 43 names of which only a handful have a plant entry, so
 * "Chanterelles" and "Wild grape" used to render as inert text with no lookalike
 * attached anywhere — which is precisely the shape plants.ts says gets people
 * poisoned.
 *
 * So every name has to be listed here, and the test enumerates every habitat,
 * season and region to prove it. An empty string is a deliberate "reviewed, no
 * lookalike or preparation worth the warning", not a gap: adding a name without
 * a decision about it fails the suite.
 */
const HAZARD: Record<string, string> = {
  // --- Deadly lookalikes ---------------------------------------------------
  "Wild grape":
    "Moonseed grows in the same hedges and its fruit passes for wild grape. It is deadly. Grape seeds are 2–4 and round; moonseed has ONE flat crescent seed. Grapes climb by tendrils, moonseed has none. Split a berry before you eat any of them.",
  Grapes:
    "Moonseed grows in the same hedges and its fruit passes for a wild grape. It is deadly. Grape seeds are 2–4 and round; moonseed has ONE flat crescent seed.",
  Chanterelles:
    "Jack-o'-lantern is the killer of appetites here and is toxic. Chanterelle has blunt forking RIDGES running down the stem and grows from soil, usually singly; jack-o'-lantern has true knife-edge gills and grows in clumps on wood or buried roots.",
  Ramps:
    "Lily of the valley and false hellebore come up in the same woods at the same time and are both dangerous. Ramps smell strongly of onion when crushed — no onion smell, not a ramp, put it down.",
  "Wild onion":
    "Death camas grows with it and looks like it until it flowers. The smell is the test and it is one-way: no onion smell means not an onion. Crush each bulb with clean hands, because handling one real onion contaminates everything you touch afterwards.",
  Huckleberry:
    "Baneberry grows in the same woods and its white or red berries are deadly. Baneberry carries its fruit in an upright cluster on a single stalk; huckleberries hang singly off the twigs of a woody shrub.",
  Blueberry:
    "Baneberry grows in the same woods and its white or red berries are deadly. Baneberry carries its fruit in an upright cluster on a single stalk; blueberries hang singly off the twigs of a woody shrub.",
  Watercress:
    "It grows in the same still water as water hemlock, which is the most poisonous plant on this continent — check what else is in the patch before you reach into it. Water below livestock also carries liver fluke, so cook it unless you know the ground upstream.",

  // --- Correctly identified and still poisonous raw -------------------------
  "Morel mushrooms":
    "Toxic RAW even when correctly identified — cook them through, and never with alcohol. False morels are a separate and worse problem: a true morel is completely hollow from tip to stem base when cut lengthways.",
  Elderberry:
    "Cook it. Raw fruit, and every leaf, stem and bit of bark, are cyanogenic, and a batch of raw juice has poisoned a whole party before now. Red elderberry — the common one in the West — is the one to be strictest with.",
  "Fiddlehead ferns":
    "Ostrich fern only, and boiled 15 minutes or steamed 12 — raw or lightly cooked fiddleheads cause outbreaks of violent illness every spring. Bracken fiddleheads are carcinogenic and are not food at any preparation.",
  "Acorns (leach first)":
    "Leach the tannins out in repeated changes of water until the water runs clear and the meat is no longer bitter. Unleached acorns are hard on the kidneys and taste of it.",
  "Acorns & nuts": "Acorns need leaching in changes of water until they no longer taste bitter.",
  Cattail:
    "It takes up whatever is in the water it stands in, including road salt, farm runoff and metals. Take it from clean water or not at all.",
  "Cattail (near water)":
    "It takes up whatever is in the water it stands in, including road salt, farm runoff and metals. Take it from clean water or not at all.",
  "Gleaned grain & corn":
    "Look at the heads. Ergot shows as a hard dark purple-black spur where a grain should be, and eating it does permanent damage — discard the whole lot rather than pick through it.",

  // --- Named too vaguely to be identification ------------------------------
  Berries: "A chip that just says \"berries\" is not identification. Name the species before you pick it.",
  "Wild greens": "Not identification. Name the species before you pick it.",
  "Young greens": "Not identification. Name the species before you pick it.",

  // --- Reviewed, no lookalike or preparation worth the warning -------------
  "Pine nuts": "",
  "Wild strawberry": "",
  "Miner's lettuce": "",
  Blackberry: "",
  "Blackberry (margins)": "",
  Pawpaw: "",
  "Hickory nuts": "",
  Dandelion: "",
  Clover: "",
  Plantain: "",
  "Lamb's quarters": "",
  "Wild rose (hips)": "",
  "Manzanita berries": "",
  Yucca: "",
  "Arrowhead (wapato)": "",
  Tule: "",
  "Wild rice": "",
  "Root vegetables": "",
  "Wild mustard": "",
  Amaranth: "",
  Apples: "",
  Pears: "",
  Plums: "",
  Walnuts: "",
};

/** What will hurt you if you get this one wrong; "" when nothing will. */
export function plantHazard(name: string): string {
  return HAZARD[name] ?? "";
}

/** Every name this module can emit — the test enumerates against this. */
export function knownPlantNames(): string[] {
  return Object.keys(HAZARD);
}

export function likelyForage(w: {
  landuseKind: string;
  elevationFt: number | null;
  lat: number;
  lng: number;
  month: number;
}): ForageGuess {
  const west = w.lng < -100;
  const habitat = habitatFor(w.landuseKind, w.elevationFt, west);
  const season = seasonOf(w.month);

  const plants: string[] = [];
  const game: string[] = [];
  const add = (arr: string[], ...xs: string[]) =>
    xs.forEach((x) => { if (!arr.includes(x)) arr.push(x); });

  // --- Plants by habitat (region-aware where the species genuinely differ) ---
  switch (habitat) {
    case "conifer forest":
      add(plants, west ? "Huckleberry" : "Blueberry", "Pine nuts", "Wild strawberry", "Miner's lettuce", "Cattail (near water)");
      break;
    case "hardwood forest":
      add(plants, "Blackberry", "Acorns (leach first)", west ? "Elderberry" : "Pawpaw", "Wild grape", "Hickory nuts", "Ramps");
      break;
    case "forest":
      add(plants, "Berries", "Acorns (leach first)", "Wild greens");
      break;
    case "meadow":
      add(plants, "Dandelion", "Wild onion", "Clover", "Plantain", "Lamb's quarters");
      break;
    case "brushland":
      add(plants, "Blackberry", "Wild rose (hips)", "Manzanita berries", "Yucca");
      break;
    case "wetland":
      add(plants, "Cattail", "Watercress", "Arrowhead (wapato)", west ? "Tule" : "Wild rice");
      break;
    case "farmland":
      add(plants, "Gleaned grain & corn", "Root vegetables", "Wild mustard", "Amaranth");
      break;
    case "orchard":
      add(plants, "Apples", "Pears", "Plums", "Walnuts");
      break;
    case "vineyard":
      add(plants, "Grapes", "Wild mustard", "Blackberry (margins)");
      break;
  }

  // --- Season overlays ---
  let seasonNote: string;
  if (season === "spring") {
    if (habitat.includes("forest")) add(plants, "Morel mushrooms", "Fiddlehead ferns");
    add(plants, "Young greens");
    seasonNote = "Spring: tender greens, fiddleheads, and morels in the woods — few berries yet.";
  } else if (season === "summer") {
    seasonNote = "Summer: berries ripening and greens everywhere — the easiest foraging of the year.";
  } else if (season === "fall") {
    if (habitat.includes("forest")) add(plants, "Chanterelles", "Acorns & nuts");
    seasonNote = "Fall: nuts, acorns, and mushrooms drop, and it's prime hunting season.";
  } else {
    seasonNote = "Winter: lean — cattail roots, inner bark, rosehips, and stored nuts; lean on trapping.";
  }

  // --- Game by habitat ---
  switch (habitat) {
    case "conifer forest":
    case "hardwood forest":
    case "forest":
      add(game, "Deer", west ? "Elk" : "Wild turkey", "Squirrel", "Grouse", "Rabbit");
      break;
    case "meadow":
    case "farmland":
    case "vineyard":
      add(game, "Rabbit", "Deer", west ? "Quail" : "Pheasant", "Dove", "Groundhog");
      break;
    case "brushland":
      add(game, "Rabbit", "Quail", "Deer", "Dove");
      break;
    case "wetland":
      add(game, "Duck", "Goose", "Muskrat", "Frog");
      break;
    case "orchard":
      add(game, "Deer", "Rabbit", "Wild turkey", "Squirrel");
      break;
  }
  // In winter the seasonNote says "lean on trapping", so make sure the trapping
  // item leads and survives the cap rather than being pushed off the end.
  if (season === "winter" && !game.includes("Snared small game")) game.unshift("Snared small game");

  return {
    habitat,
    plants: plants.slice(0, 7),
    game: game.slice(0, 5),
    seasonNote,
    caution: CAUTION,
    elevationKnown: w.elevationFt != null,
  };
}
