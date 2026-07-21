// Likely fish — a habitat guess, not a survey.
//
// The map packs know where water IS (rivers, lakes, streams, and their names)
// but nothing about what lives in it — no map does; OpenStreetMap has no fish.
// So we infer the LIKELY catch the way an angler reads water before wetting a
// line: cold, high, moving water is trout country; warm, low, still water holds
// bass, catfish and panfish; the Pacific slope adds salmon and steelhead to
// anything a fish can run up from the sea. It is a starting guess to point you at
// the right water and the right method — never a stocking record. Every result
// says so, in the same honest spirit as the routing caveats.
//
// Pure and offline: the only inputs are the water body's type, the elevation
// under it (from the local DEM, when present), and where it is. No network,
// no database. Tested in tests/fish.test.ts.

export type Regime = "cold" | "cool" | "warm";

export interface FishGuess {
  /** Human label for the water, e.g. "mountain stream", "lowland reservoir". */
  waterType: string;
  regime: Regime;
  /** Most-likely first, capped to a readable handful. */
  species: string[];
  /** One-line hint on how to work this kind of water. */
  method: string;
  /** The honest disclaimer — always shown. */
  caveat: string;
  /** False when there was no DEM to read an elevation from (guess is coarser). */
  elevationKnown: boolean;
}

/** Water kinds worth showing and identifying. Excludes ditch/drain/fountain/
 *  swimming_pool and other non-fishable water the basemap also carries. */
export const FISHABLE_KINDS = [
  "water", "lake", "reservoir", "river", "stream", "canal", "pond", "basin", "lagoon",
];

const MOVING = new Set(["stream", "river", "canal", "creek"]);
const BIG = new Set(["lake", "reservoir", "water", "river", "canal"]);

/**
 * The elevation, in feet, above which water runs cold enough for trout — falling
 * as you go north. A rough linear fit: about 6000 ft is needed near the Mexican
 * border, dropping to sea level by the Canadian line. Good enough to separate
 * trout country from bass country; it is a guide, not a thermometer.
 */
export function coldElevationLineFt(lat: number): number {
  return Math.max(0, (49 - Math.abs(lat)) * 320);
}

/** Cold / cool / warm from elevation + latitude. With no DEM (elevationFt null)
 *  we fall back to latitude alone and say so upstream. */
export function regimeFor(elevationFt: number | null, lat: number): Regime {
  if (elevationFt == null) {
    const a = Math.abs(lat);
    if (a >= 44) return "cold";
    if (a >= 39) return "cool";
    return "warm";
  }
  const line = coldElevationLineFt(lat);
  if (elevationFt >= line) return "cold";
  if (elevationFt >= line - 1500) return "cool";
  return "warm";
}

function waterTypeLabel(kind: string, regime: Regime, moving: boolean): string {
  switch (kind) {
    case "reservoir": return regime === "cold" ? "high reservoir" : "lowland reservoir";
    case "river": return regime === "cold" ? "mountain river" : "river";
    case "canal": return "canal";
    case "stream": return regime === "cold" ? "mountain stream" : "creek";
    case "pond":
    case "basin": return "pond";
    case "lagoon": return "lagoon";
    default: return regime === "cold" ? "high lake" : "lake"; // water / lake
  }
  void moving;
}

function methodFor(regime: Regime, moving: boolean): string {
  if (regime === "cold") {
    return moving
      ? "Fish riffles and the pools below them — small spinners, flies, or bait drifted along the bottom."
      : "Work the drop-offs and inlets — spoons or bait near the bottom in the cool of morning and evening.";
  }
  if (regime === "warm") {
    return moving
      ? "Cast to cover — undercut banks, logjams, and deep bends — with cut bait for catfish, lures for bass."
      : "Fish the weed edges, sunken timber, and shade — worms or small jigs for panfish, lures for bass.";
  }
  return moving
    ? "Try the seams where fast water meets slow, and any structure that breaks the current."
    : "Fan-cast the shoreline structure; a bobber-and-worm finds most of what lives here.";
}

const CAVEAT =
  "A habitat guess from water type, elevation, and region — not a stocking survey. " +
  "Check local regulations, seasons, and licensing before you fish.";

/**
 * Likely species for a water body. `kind` is the OSM/basemap water kind
 * (river, lake, stream, reservoir …); `elevationFt` may be null when the pack
 * has no terrain.
 */
export function likelyFish(w: {
  kind: string;
  name?: string;
  elevationFt: number | null;
  lat: number;
  lng: number;
}): FishGuess {
  const kind = (w.kind || "").toLowerCase();
  const moving = MOVING.has(kind);
  const big = BIG.has(kind);
  const regime = regimeFor(w.elevationFt, w.lat);

  // Coarse regional flags. Species pools split east/west because the trout and
  // panfish that dominate one side are absent on the other — kokanee and
  // cutthroat are Western fish; walleye and pike are the Northern interior's.
  const west = w.lng < -100;
  const pacific = w.lng < -116.5 && w.lat > 34 && w.lat < 62; // Pacific slope: CA→AK
  const northInterior = !west && w.lng < -69 && w.lat >= 41; // upper Midwest / Great Lakes / NE
  const southeast = w.lat < 36 && w.lng > -95;

  // `lead` holds the marquee regional catch (salmon, sturgeon, walleye) so it
  // survives the cap; `base` is the everyday pool for the water's type + regime.
  const lead: string[] = [];
  const base: string[] = [];

  if (regime === "cold") {
    if (moving) base.push(...(west
      ? ["Rainbow trout", "Cutthroat trout", "Brook trout", "Brown trout", "Mountain whitefish"]
      : ["Brook trout", "Brown trout", "Rainbow trout", "Landlocked salmon"]));
    else base.push(...(west
      ? ["Rainbow trout", "Kokanee", "Lake trout", "Cutthroat trout", "Brook trout"]
      : ["Lake trout", "Brook trout", "Rainbow trout", "Whitefish"]));
    // Large stocked reservoirs stay cold up top but hold warmwater fish too.
    if (big && !moving) base.push("Smallmouth bass", "Yellow perch");
  } else if (regime === "cool") {
    if (moving) base.push(...(west
      ? ["Smallmouth bass", "Rainbow trout", "Mountain whitefish", "Channel catfish"]
      : ["Smallmouth bass", "Rock bass", "Rainbow trout", "Channel catfish"]));
    else base.push(...(west
      ? ["Rainbow trout", "Largemouth bass", "Black crappie", "Bluegill", "Yellow perch"]
      : ["Largemouth bass", "Smallmouth bass", "Black crappie", "Bluegill", "Yellow perch"]));
  } else {
    if (moving) base.push("Channel catfish", "Flathead catfish", "Largemouth bass", "Smallmouth bass", "Common carp");
    else base.push("Largemouth bass", "Bluegill", "Black crappie", "Channel catfish", "Yellow perch");
    if (southeast) base.push("Longnose gar", "Bowfin");
  }

  // Northern coolwater specialists — walleye/pike country runs across the cold
  // and cool still waters and slow rivers of the north-central states and NE.
  if (northInterior && regime !== "warm") lead.push("Walleye", "Northern pike");
  // Anadromous fish of the Pacific slope, in low-enough water they can run up to
  // from the sea (a guess by elevation, not by tracing the drainage).
  if (pacific && moving && regime !== "warm" && (w.elevationFt == null || w.elevationFt < 3000))
    lead.push("Steelhead", "Chinook salmon", "Coho salmon");
  // The big Pacific rivers (Columbia, Snake, Willamette) hold sturgeon.
  if (pacific && kind === "river") lead.push("White sturgeon");

  const species: string[] = [];
  for (const x of [...lead, ...base]) if (!species.includes(x)) species.push(x);

  return {
    waterType: waterTypeLabel(kind, regime, moving),
    regime,
    species: species.slice(0, 6),
    method: methodFor(regime, moving),
    caveat: CAVEAT,
    elevationKnown: w.elevationFt != null,
  };
}
