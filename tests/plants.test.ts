import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  bySymbol,
  checkPairing,
  deadlyLookalikes,
  isDangerous,
  isEdible,
  lookalikes,
  matchCommonName,
  plantsForState,
  hasStateRecords,
  type PlantData,
  type Plant,
} from "../src/plants";

/** The human-curated source, before tools/fetch_plants.mjs enriches it. */
const curated = JSON.parse(readFileSync("tools/plants-curated.json", "utf8"));
const data: PlantData = {
  plants: curated.plants.map((p: Partial<Plant>) => ({ states: [], images: [], ...p })) as Plant[],
  distributionStates: ["OR"],
};

describe("the safety invariant", () => {
  // This is the test that matters. If it fails, the data is not merely thin —
  // it is capable of showing somebody an edible plant with no warning attached.
  it("pairs every edible with a real, mutual, dangerous lookalike", () => {
    expect(checkPairing(data)).toEqual([]);
  });

  it("gives every entry a tell, not just a description", () => {
    for (const p of data.plants) {
      expect(p.tell.length, `${p.symbol} has no tell`).toBeGreaterThan(20);
    }
  });

  it("never leaves an edible-with-care standing alone", () => {
    for (const p of data.plants) {
      if (p.verdict !== "edible-with-care") continue;
      expect(lookalikes(data, p).length, `${p.symbol} names no lookalike`).toBeGreaterThan(0);
    }
  });

  it("explains what every dangerous plant actually does to you", () => {
    for (const p of data.plants) {
      if (!isDangerous(p)) continue;
      expect(p.effect, `${p.symbol} has no effect described`).toBeTruthy();
      expect(p.effect!.length).toBeGreaterThan(30);
    }
  });

  it("does not describe edible parts for anything deadly", () => {
    for (const p of data.plants) {
      if (p.verdict === "deadly") expect(p.edibleParts).toBeUndefined();
    }
  });
});

describe("the classic killers are present and correctly paired", () => {
  // Each of these pairs has a body count in North America. If a future edit
  // breaks one of these links, this is where it gets caught.
  const PAIRS: [string, string, string][] = [
    ["DACA6", "CIMA2", "wild carrot / water hemlock"],
    ["DACA6", "COMA2", "wild carrot / poison hemlock"],
    ["ALLIU", "ZIGAD", "wild onion / death camas"],
    ["CAMAS", "ZIGAD", "camas / death camas"],
    ["ALTR3", "VERAT", "ramps / false hellebore"],
    ["MORCH", "GYRES", "morel / false morel"],
    ["AGARI", "AMANI", "field mushroom / destroying angel"],
    ["RHTY", "TOXIC", "staghorn sumac / poison sumac"],
  ];

  for (const [edible, killer, name] of PAIRS) {
    it(`links ${name}`, () => {
      const e = bySymbol(data, edible);
      const k = bySymbol(data, killer);
      expect(e, `${edible} missing`).not.toBeNull();
      expect(k, `${killer} missing`).not.toBeNull();
      expect(isEdible(e!)).toBe(true);
      expect(isDangerous(k!)).toBe(true);
      expect(lookalikes(data, e!).map((p) => p.symbol)).toContain(killer);
    });
  }

  it("flags the ones whose lookalike is outright deadly", () => {
    for (const s of ["DACA6", "ALLIU", "CAMAS", "MORCH", "AGARI"]) {
      expect(deadlyLookalikes(data, bySymbol(data, s)!).length, s).toBeGreaterThan(0);
    }
  });

  it("keeps the decisive tells intact", () => {
    // These specific sentences are the difference between a meal and a funeral.
    expect(bySymbol(data, "ALLIU")!.tell).toMatch(/smell of onion|onion or garlic/i);
    expect(bySymbol(data, "ZIGAD")!.tell).toMatch(/no onion smell/i);
    expect(bySymbol(data, "MORCH")!.tell).toMatch(/hollow/i);
    expect(bySymbol(data, "GYRES")!.tell).toMatch(/hollow|solid|chambered/i);
    expect(bySymbol(data, "AGARI")!.tell).toMatch(/gills|cup|sac/i);
    expect(bySymbol(data, "AMANI")!.tell).toMatch(/volva|cup|sac|base/i);
    expect(bySymbol(data, "CIMA2")!.tell).toMatch(/chamber/i);
  });
});

describe("plantsForState", () => {
  const withRanges: PlantData = {
    distributionStates: ["OR"],
    plants: [
      { ...bySymbol(data, "VACCI")!, states: ["OR", "WA"] },
      { ...bySymbol(data, "CIMA2")!, states: ["ME"] },
      { ...bySymbol(data, "MORCH")!, states: [] }, // fungi are not in USDA at all
    ],
  };
  const symbols = (s: string) => plantsForState(withRanges, s).map((r) => r.plant.symbol);

  it("labels what is actually recorded here", () => {
    const rec = plantsForState(withRanges, "OR").find((r) => r.plant.symbol === "VACCI")!;
    expect(rec.recordedHere).toBe(true);
  });

  it("NEVER hides a plant that is unrecorded in this state", () => {
    // The reason this matters: USDA's per-state export returns 44 species for
    // Minnesota and 77 for Pennsylvania. Absence from it is not evidence of
    // absence, and filtering on it would drop water hemlock from the list of
    // somebody standing next to water hemlock.
    expect(symbols("OR")).toContain("CIMA2");
    expect(plantsForState(withRanges, "OR").find((r) => r.plant.symbol === "CIMA2")!.recordedHere)
      .toBe(false);
  });

  it("keeps plants with no distribution data at all", () => {
    expect(symbols("OR")).toContain("MORCH");
  });

  it("puts the deadly things first, whatever the state", () => {
    const order = plantsForState(data, "OR").map((r) => r.plant.verdict);
    const firstEdible = order.findIndex((v) => v === "edible" || v === "edible-with-care");
    const lastDeadly = order.lastIndexOf("deadly");
    expect(lastDeadly).toBeLessThan(firstEdible);
  });

  it("promotes locally-recorded plants within the same verdict", () => {
    const here: PlantData = {
      distributionStates: ["OR"],
      plants: [
        { ...bySymbol(data, "CIMA2")!, common: "Zed elsewhere", states: [] },
        { ...bySymbol(data, "COMA2")!, common: "Alpha here", states: ["OR"] },
      ],
    };
    expect(plantsForState(here, "OR")[0].plant.common).toBe("Alpha here");
  });

  it("is case-insensitive about the state", () => {
    expect(symbols("or")).toEqual(symbols("OR"));
  });
});

describe("hasStateRecords", () => {
  it("reports only whether records exist, never that a list is complete", () => {
    expect(hasStateRecords(data, "OR")).toBe(true);
    expect(hasStateRecords(data, "ME")).toBe(false);
  });
});

describe("matchCommonName", () => {
  // The Wild food card links its plant names to these entries, so a wrong match
  // attaches the wrong lookalike warning to the wrong plant.
  it("matches the names the Wild food card actually produces", () => {
    expect(matchCommonName(data, "Wild onion")).toBe("ALLIU");
    expect(matchCommonName(data, "Morel mushrooms")).toBe("MORCH");
    expect(matchCommonName(data, "Cattail (near water)")).toBe("TYPHA");
    expect(matchCommonName(data, "Blueberry")).toBe("VACCI");
    expect(matchCommonName(data, "Huckleberry")).toBe("VACCI");
  });

  it("does not join unrelated plants that share a word", () => {
    // "Wild rose (hips)" and "Wild grape" must not land on "Wild onion", and
    // "Blackberry" must not land on "blueberry".
    for (const t of ["Wild rose (hips)", "Wild grape", "Blackberry", "Wild strawberry"]) {
      expect([t, matchCommonName(data, t)]).not.toEqual([t, "ALLIU"]);
      expect([t, matchCommonName(data, t)]).not.toEqual([t, "VACCI"]);
    }
  });

  it("returns null rather than guessing", () => {
    for (const t of ["Acorns (leach first)", "Pine nuts", "Gleaned grain & corn", "", "   "]) {
      expect([t, matchCommonName(data, t)]).toEqual([t, null]);
    }
  });
});
