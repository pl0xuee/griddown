import { describe, it, expect } from "vitest";
import { rankMatches, rankPins, type Place } from "../src/search";

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

describe("rankPins", () => {
  const pin = (name: string, t: number, note?: string) => ({
    id: name,
    name,
    lat: 45,
    lng: -122,
    note,
    t,
  });

  it("matches a pin by name", () => {
    const out = rankPins([pin("Camp", 1), pin("Home", 2)], "cam");
    expect(out.map((p) => p.name)).toEqual(["Camp"]);
  });

  it("is case-insensitive", () => {
    expect(rankPins([pin("Camp", 1)], "CAMP")).toHaveLength(1);
  });

  // A note is where you write what a place actually is; searching it means
  // "water" finds the pin you named "spring".
  it("matches a pin by its note", () => {
    const out = rankPins([pin("Spring", 1, "good water here")], "water");
    expect(out.map((p) => p.name)).toEqual(["Spring"]);
  });

  it("ranks a name match above a note match", () => {
    const out = rankPins([pin("Creek", 1, "water"), pin("Water tank", 2)], "water");
    expect(out[0].name).toBe("Water tank");
  });

  it("ranks a start-of-name match above a mid-word one", () => {
    const out = rankPins([pin("Old camp", 2), pin("Camp two", 1)], "camp");
    expect(out[0].name).toBe("Camp two");
  });

  // Among equals the newest pin is usually the one being looked for: you drop
  // a pin for something you are about to act on.
  it("puts the most recent first when rank is otherwise equal", () => {
    const out = rankPins([pin("Camp one", 100), pin("Camp two", 900)], "camp");
    expect(out[0].name).toBe("Camp two");
  });

  it("returns nothing for an empty query", () => {
    expect(rankPins([pin("Camp", 1)], "")).toEqual([]);
    expect(rankPins([pin("Camp", 1)], "   ")).toEqual([]);
  });

  it("survives pins with no name or note", () => {
    const out = rankPins([{ id: "x", name: "", lat: 1, lng: 2, t: 1 }], "camp");
    expect(out).toEqual([]);
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => pin(`Camp ${i}`, i));
    expect(rankPins(many, "camp", 5)).toHaveLength(5);
  });
});
