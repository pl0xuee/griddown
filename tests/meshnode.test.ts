import { describe, it, expect } from "vitest";
import {
  formatNodeId,
  freshness,
  formatAge,
  relativeTo,
  formatBattery,
  sortNodes,
  displayName,
  type MeshNode,
} from "../src/meshnode";

const node = (over: Partial<MeshNode> = {}): MeshNode => ({
  num: 1,
  id: "!00000001",
  longName: "Node",
  shortName: "ND",
  ...over,
});

describe("formatNodeId", () => {
  it("writes the Meshtastic !hex form, zero-padded", () => {
    expect(formatNodeId(0x7c3f0a1b)).toBe("!7c3f0a1b");
    expect(formatNodeId(1)).toBe("!00000001");
  });

  // Node numbers routinely exceed 2^31; a signed shift would print "-...".
  it("treats high node numbers as unsigned", () => {
    expect(formatNodeId(0xfeedface)).toBe("!feedface");
    expect(formatNodeId(0xffffffff)).toBe("!ffffffff");
  });
});

describe("freshness", () => {
  const now = 1_800_000_000;

  it("grades a fix by age", () => {
    expect(freshness(now - 10, now)).toBe("live");
    expect(freshness(now - 299, now)).toBe("live");
    expect(freshness(now - 301, now)).toBe("recent");
    expect(freshness(now - 1799, now)).toBe("recent");
    expect(freshness(now - 1801, now)).toBe("stale");
    expect(freshness(now - 3601, now)).toBe("old");
  });

  // A node with no position must never look current — that's the failure that
  // sends people to the wrong place.
  it("treats a missing fix as old, not live", () => {
    expect(freshness(undefined, now)).toBe("old");
    expect(freshness(0, now)).toBe("old");
  });

  it("does not call a clock-skewed future fix stale", () => {
    expect(freshness(now + 60, now)).toBe("live");
  });
});

describe("formatAge", () => {
  const now = 1_800_000_000;

  it("reads naturally at every scale", () => {
    expect(formatAge(now - 5, now)).toBe("just now");
    expect(formatAge(now - 240, now)).toBe("4 min ago");
    expect(formatAge(now - 3600, now)).toBe("1 h ago");
    expect(formatAge(now - 7800, now)).toBe("2 h 10 min ago");
    expect(formatAge(now - 86400, now)).toBe("1 day ago");
    expect(formatAge(now - 3 * 86400, now)).toBe("3 days ago");
  });

  it("says never rather than inventing an age", () => {
    expect(formatAge(undefined, now)).toBe("never");
  });

  it("clamps a future timestamp instead of showing negative time", () => {
    expect(formatAge(now + 500, now)).toBe("just now");
  });
});

describe("relativeTo", () => {
  const here: [number, number] = [-122.7, 45.5];

  it("gives distance and compass direction", () => {
    const r = relativeTo(here, node({ lat: 45.6, lng: -122.7 }));
    expect(r).not.toBeNull();
    expect(r!.miles).toBeCloseTo(6.9, 0);
    expect(r!.brg).toBeCloseTo(0, 0);
    expect(r!.text).toContain("N");
  });

  it("switches to feet up close, where miles would round to nothing", () => {
    const r = relativeTo(here, node({ lat: 45.5003, lng: -122.7 }));
    expect(r!.text).toMatch(/^\d+ ft/);
  });

  it("is null for a node that has never reported a position", () => {
    expect(relativeTo(here, node())).toBeNull();
  });
});

describe("formatBattery", () => {
  it("shows a percentage", () => {
    expect(formatBattery(76)).toBe("76%");
  });

  // The radio uses >100 for "on external power", not a 137% battery.
  it("reads over-100 as plugged in", () => {
    expect(formatBattery(101)).toBe("plugged in");
  });

  // "0%" for a node that simply never reported would read as nearly dead.
  it("is blank when unknown, not zero", () => {
    expect(formatBattery(undefined)).toBe("");
    expect(formatBattery(0)).toBe("0%");
  });
});

describe("sortNodes", () => {
  const here: [number, number] = [-122.7, 45.5];

  it("puts the closest first", () => {
    const far = node({ num: 1, id: "!1", lat: 46.5, lng: -122.7 });
    const near = node({ num: 2, id: "!2", lat: 45.51, lng: -122.7 });
    expect(sortNodes([far, near], here).map((n) => n.id)).toEqual(["!2", "!1"]);
  });

  it("sinks nodes with no position below those with one", () => {
    const positioned = node({ num: 1, id: "!1", lat: 46.5, lng: -122.7 });
    const blind = node({ num: 2, id: "!2" });
    expect(sortNodes([blind, positioned], here).map((n) => n.id)).toEqual(["!1", "!2"]);
  });

  it("falls back to most-recently-heard when nothing has a position", () => {
    const older = node({ num: 1, id: "!1", lastHeard: 100 });
    const newer = node({ num: 2, id: "!2", lastHeard: 900 });
    expect(sortNodes([older, newer], here).map((n) => n.id)).toEqual(["!2", "!1"]);
  });

  it("does not mutate the caller's array", () => {
    const list = [node({ num: 1, id: "!1" }), node({ num: 2, id: "!2" })];
    sortNodes(list, here);
    expect(list.map((n) => n.id)).toEqual(["!1", "!2"]);
  });
});

describe("displayName", () => {
  it("prefers the long name, then short, then the id", () => {
    expect(displayName(node({ longName: "Dad's truck", shortName: "DAD" }))).toBe("Dad's truck");
    expect(displayName(node({ longName: "  ", shortName: "DAD" }))).toBe("DAD");
    expect(displayName(node({ longName: "", shortName: "", id: "!abc" }))).toBe("!abc");
  });
});

describe("formatAge at the hour boundaries", () => {
  const now = 1_800_000_000;

  // Rounding minutes pushed 59.5 min into the hours branch and then printed
  // "0 h 60 min ago" — for 30 seconds of every hour, on the one number this
  // module exists to state honestly.
  it("never prints sixty minutes", () => {
    for (let age = 3400; age < 90_000; age += 7) {
      expect(formatAge(now - age, now)).not.toMatch(/\b60 min/);
    }
  });

  it("crosses each boundary cleanly", () => {
    expect(formatAge(now - 3569, now)).toBe("59 min ago");
    expect(formatAge(now - 3599, now)).toBe("59 min ago");
    expect(formatAge(now - 3600, now)).toBe("1 h ago");
    expect(formatAge(now - 7170, now)).toBe("1 h 59 min ago");
    expect(formatAge(now - 86370, now)).toBe("23 h 59 min ago");
    expect(formatAge(now - 86400, now)).toBe("1 day ago");
  });

  it("never prints zero minutes", () => {
    for (let age = 45; age < 3600; age += 3) {
      expect(formatAge(now - age, now)).not.toBe("0 min ago");
    }
  });
});
