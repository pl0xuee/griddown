import { describe, it, expect } from "vitest";
import { rankMatches, type Place } from "../src/search";

const p = (name: string, pop = 0, kind = "locality"): Place => ({
  name,
  kind,
  detail: "",
  pop,
  lng: 0,
  lat: 0,
});

describe("rankMatches", () => {
  const places = [
    p("Portland", 650000),
    p("South Portland", 30000),
    p("Port Orford", 1100),
    p("Bend", 100000),
    p("North Bend", 10000),
  ];

  it("prefers prefix matches over substring matches", () => {
    const hits = rankMatches(places, "port");
    expect(hits[0].name).toBe("Portland");
    expect(hits.map((h) => h.name)).toContain("South Portland");
  });

  it("uses population to break ties", () => {
    const hits = rankMatches(places, "bend");
    expect(hits[0].name).toBe("Bend");
    expect(hits[1].name).toBe("North Bend");
  });

  it("matches case-insensitively and trims", () => {
    expect(rankMatches(places, "  BEND ")[0].name).toBe("Bend");
  });

  it("returns nothing for empty or non-matching queries", () => {
    expect(rankMatches(places, "")).toHaveLength(0);
    expect(rankMatches(places, "zzz")).toHaveLength(0);
  });

  it("word-boundary matches beat mid-word matches", () => {
    const hits = rankMatches([p("Deportville", 9e9), p("Old Port", 10)], "port");
    expect(hits[0].name).toBe("Old Port");
  });
});
