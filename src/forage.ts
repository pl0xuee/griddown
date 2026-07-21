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
  "certainty — deadly lookalikes exist. This is a habitat guess, not " +
  "identification. Cross-check the Poisonous Plants chapter before you forage.";

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
