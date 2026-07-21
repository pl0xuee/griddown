// Edible and dangerous plants, per state.
//
// This is the one feature in GridDown where being wrong can kill someone, so
// the design is built around that rather than around completeness.
//
// Three rules it exists to enforce:
//
//   1. NOTHING EDIBLE APPEARS ALONE. Every edible entry names the dangerous
//      plants it is confused with, and the UI shows them together. A bare list
//      of edible names is the exact shape that gets people poisoned — water
//      hemlock for wild carrot, death camas for wild onion, false morel for
//      morel. `checkPairing()` below fails the build if that link is missing.
//
//   2. EVERY ENTRY CARRIES A TELL. Not a description — a single field-checkable
//      difference. "Cut it open: a true morel is hollow end to end." "It must
//      smell of onion." A description without a tell is trivia, and trivia is
//      what people eat on.
//
//   3. THE CAUTION IS NEVER SUPPRESSED. This app points you at the right
//      question. It is not a field guide and it cannot identify a plant.
//
// The data is human-curated in tools/plants-curated.json and enriched with USDA
// PLANTS state distribution and public-domain photographs by
// tools/fetch_plants.mjs, which writes public/plants.json. Pure and offline;
// tested in tests/plants.test.ts.

export type Verdict =
  /** Kills. No safe quantity, no preparation that helps. */
  | "deadly"
  /** Poisonous — serious illness, and can kill at dose or in children. */
  | "toxic"
  /** Hurts on contact rather than by eating. */
  | "irritant"
  /** Traditionally eaten, and has no dangerous lookalike worth the warning. */
  | "edible"
  /** Traditionally eaten, BUT has a lookalike that can kill you. */
  | "edible-with-care";

export interface PlantImage {
  /** Path within the bundled image set. */
  path: string;
  /** Photographer credit. Public-domain images only — see fetch_plants.mjs. */
  credit: string;
  /**
   * Set when the photograph is of a RELATIVE rather than this exact entry.
   *
   * Genus entries like "Death camas" have no photograph of their own, so the
   * build borrows one from a species in the genus. That has to be stated on the
   * image: an unlabelled picture of the wrong species is worse than no picture,
   * because it invites someone to match against the wrong thing.
   */
  of?: string;
}

export interface Plant {
  /** USDA PLANTS symbol — the primary key. */
  symbol: string;
  scientific: string;
  common: string;
  verdict: Verdict;
  family: string;
  description: string;
  habitat: string;
  season: string;
  /** The single field-checkable difference from its lookalike. Required. */
  tell: string;
  /** Symbols of the plants this is confused with. */
  confusedWith: string[];
  /** Toxic entries: what it does to you. */
  effect?: string;
  /** Edible entries: which parts, and how they are prepared. */
  edibleParts?: string;
  /** USDA state abbreviations where the plant is recorded. */
  states: string[];
  images: PlantImage[];
}

export interface PlantData {
  plants: Plant[];
  /** Which states the distribution data actually covers — see statesCovered. */
  distributionStates: string[];
}

/** Verdicts that mean "do not put this in your mouth". */
const DANGEROUS: ReadonlySet<Verdict> = new Set<Verdict>(["deadly", "toxic", "irritant"]);

export function isDangerous(p: Plant): boolean {
  return DANGEROUS.has(p.verdict);
}

export function isEdible(p: Plant): boolean {
  return p.verdict === "edible" || p.verdict === "edible-with-care";
}

/**
 * Rank for display. Deadly things first, always.
 *
 * The ordering is a safety decision, not a presentation one: someone scanning
 * this list in a hurry should meet the things that kill before the things that
 * feed, because the cost of missing them is not symmetric.
 */
const ORDER: Record<Verdict, number> = {
  deadly: 0,
  toxic: 1,
  irritant: 2,
  "edible-with-care": 3,
  edible: 4,
};

/** A plant together with whether it is actually recorded in the chosen state. */
export interface StatePlant {
  plant: Plant;
  /** True only where USDA positively records this genus in the state. */
  recordedHere: boolean;
}

/**
 * Every plant, ordered for the chosen state — deadliest first, and never filtered.
 *
 * This deliberately does NOT hide plants that are unrecorded in your state, and
 * that decision came from looking at the data rather than from caution in the
 * abstract. USDA's per-state export is not a state flora: it returns 4,856
 * species for Oregon but 44 for Minnesota and 77 for Pennsylvania. Foxglove —
 * naturalised across much of the country — comes back for two states.
 *
 * So absence from a state list is not evidence of absence, and a filter built on
 * it would quietly drop water hemlock from the list of somebody standing next to
 * water hemlock. Presence is used as positive evidence only: it promotes and
 * labels a plant, it never removes one.
 *
 * Ordering is a safety decision too — the things that kill come before the
 * things that feed, because the cost of missing them is not symmetric.
 */
export function plantsForState(data: PlantData, state: string): StatePlant[] {
  const st = (state || "").toUpperCase();
  return data.plants
    .map((plant) => ({ plant, recordedHere: plant.states.includes(st) }))
    .sort(
      (a, b) =>
        ORDER[a.plant.verdict] - ORDER[b.plant.verdict] ||
        Number(b.recordedHere) - Number(a.recordedHere) ||
        a.plant.common.localeCompare(b.plant.common)
    );
}

/** Look one up by USDA symbol. */
export function bySymbol(data: PlantData, symbol: string): Plant | null {
  const s = (symbol || "").toUpperCase();
  return data.plants.find((p) => p.symbol.toUpperCase() === s) ?? null;
}

/**
 * The dangerous plants an edible is confused with, resolved to real entries.
 *
 * Returns them for display beside the edible — never on their own page. If this
 * comes back empty for something edible, the data is broken, not merely thin;
 * see checkPairing().
 */
export function lookalikes(data: PlantData, p: Plant): Plant[] {
  return p.confusedWith
    .map((s) => bySymbol(data, s))
    .filter((x): x is Plant => x !== null);
}

/**
 * Which of a plant's lookalikes can actually kill you.
 *
 * Used to decide how loudly to mark an edible: "wild carrot" beside a deadly
 * lookalike is a different proposition from "huckleberry" beside a toxic one.
 */
export function deadlyLookalikes(data: PlantData, p: Plant): Plant[] {
  return lookalikes(data, p).filter((l) => l.verdict === "deadly");
}

export interface PairingProblem {
  symbol: string;
  problem: string;
}

/**
 * The safety invariant, as a function so a test can hold the line.
 *
 * Checks that:
 *   - every edible names at least one lookalike,
 *   - every symbol named in confusedWith resolves to a real entry,
 *   - every entry has a non-empty tell,
 *   - pairings are mutual: if an edible names a killer, the killer names it
 *     back, so the warning is reachable from whichever side you arrive on.
 *
 * "edible" (as opposed to "edible-with-care") is exempt from the first rule
 * only when it genuinely has no dangerous lookalike — but it still has to say
 * so by leaving confusedWith empty deliberately.
 */
export function checkPairing(data: PlantData): PairingProblem[] {
  const problems: PairingProblem[] = [];
  const known = new Map(data.plants.map((p) => [p.symbol.toUpperCase(), p]));

  for (const p of data.plants) {
    if (!p.tell || !p.tell.trim()) {
      problems.push({ symbol: p.symbol, problem: "no tell — a description without one is trivia" });
    }
    for (const ref of p.confusedWith) {
      if (!known.has(ref.toUpperCase())) {
        problems.push({ symbol: p.symbol, problem: `confusedWith names ${ref}, which is not in the data` });
        continue;
      }
      const other = known.get(ref.toUpperCase())!;
      if (!other.confusedWith.some((b) => b.toUpperCase() === p.symbol.toUpperCase())) {
        problems.push({
          symbol: p.symbol,
          problem: `pairing with ${ref} is one-way — ${ref} does not name it back`,
        });
      }
    }
    if (p.verdict === "edible-with-care" && p.confusedWith.length === 0) {
      problems.push({
        symbol: p.symbol,
        problem: "edible-with-care but names no lookalike — the care is what, exactly?",
      });
    }
  }
  return problems;
}

/**
 * Whether we have any positive distribution evidence for a state at all.
 *
 * True only means "some records exist", never "this list is complete" — see
 * plantsForState for why that distinction is load-bearing. The UI uses it to
 * decide whether to show "recorded in Oregon" labels at all, not to filter.
 */
export function hasStateRecords(data: PlantData, state: string): boolean {
  return data.distributionStates.includes((state || "").toUpperCase());
}

/**
 * The entry whose common name matches a free-text plant name, if any.
 *
 * The Wild food card names plants as prose ("Wild onion", "Morel mushrooms",
 * "Acorns (leach first)"), and linking those to reference entries is how someone
 * gets from a habitat guess to the lookalike warnings. That makes a WRONG match
 * a safety bug, not a cosmetic one — sending "wild rose" to the wild onion entry
 * would attach the wrong tell to the wrong plant.
 *
 * So matching is anchored: an exact name, or one string being a prefix of the
 * other. Never a substring search, which is what would let a shared word like
 * "wild" or "berry" join two unrelated plants.
 */
export function matchCommonName(data: PlantData, text: string): string | null {
  const t = (text || "").toLowerCase().replace(/\s*\(.*$/, "").trim();
  if (!t) return null;
  for (const p of data.plants) {
    for (const n of p.common.toLowerCase().split(/,\s*/)) {
      if (n === t || n.startsWith(t) || t.startsWith(n)) return p.symbol;
    }
  }
  return null;
}
