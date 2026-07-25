import { describe, it, expect, beforeEach } from "vitest";
import { normalize, updateMarks, currentMarks } from "../src/store";
import type { Plan } from "../src/plan";

// normalize() is the boundary between the app and a file someone else may have
// written — marks.json by hand, or a restored backup off a USB stick. These
// tests are about what it refuses, not what it accepts.

const goodPlan: Plan = {
  id: "p1",
  name: "Home → cabin",
  destination: "the cabin",
  routes: [
    {
      id: "r1",
      name: "Primary",
      coords: [
        [-120, 45],
        [-119.9, 45.1],
      ],
      meters: 12000,
      steps: [{ name: "US-97", meters: 12000 }],
      usedTrail: false,
      from: { lat: 45, lng: -120, label: "home" },
      to: { lat: 45.1, lng: -119.9, label: "cabin" },
      pack: "OR",
      computedAt: 1_700_000_000_000,
      appVersion: "1.1.8",
    },
  ],
  stops: [],
  triggers: ["Power out more than 72 hours"],
  t: 1_700_000_000_000,
};

const waypoint = { id: "w1", name: "Spring", lat: 45, lng: -120, t: 1 };

describe("normalize — plans", () => {
  it("keeps a well-formed plan", () => {
    const m = normalize({ waypoints: [], tracks: [], plans: [goodPlan] });
    expect(m.plans).toHaveLength(1);
    expect(m.plans[0].name).toBe("Home → cabin");
  });

  it("drops a plan whose id could break out of an HTML attribute", () => {
    const m = normalize({
      plans: [{ ...goodPlan, id: 'p1" onload="alert(1)' }],
    });
    expect(m.plans).toEqual([]);
  });

  it("drops a plan carrying a route with non-finite coordinates", () => {
    const broken = {
      ...goodPlan,
      routes: [{ ...goodPlan.routes[0], coords: [[NaN, 45]] }],
    };
    expect(normalize({ plans: [broken] }).plans).toEqual([]);
  });

  it("keeps the good plans in a file that also holds a bad one", () => {
    const m = normalize({
      plans: [goodPlan, { ...goodPlan, id: "p2", name: 42 }],
    });
    expect(m.plans).toHaveLength(1);
    expect(m.plans[0].id).toBe("p1");
  });

  it("fills in plans for a marks file written before plans existed", () => {
    const m = normalize({ waypoints: [waypoint], tracks: [] });
    expect(m.plans).toEqual([]);
    expect(m.waypoints).toHaveLength(1); // the old data still survives
  });

  it("ignores a plans value that isn't an array", () => {
    expect(normalize({ plans: "yes please" }).plans).toEqual([]);
  });

  it("survives being handed nothing at all", () => {
    expect(normalize(null).plans).toEqual([]);
    expect(normalize(undefined).waypoints).toEqual([]);
  });
});

describe("normalize — kits", () => {
  const goodKit = {
    id: "k1",
    name: "Go bag",
    template: "go-bag-72h",
    sections: [
      {
        title: "Water",
        items: [{ id: "s0-i0", name: "Bottles", have: true, qty: 3, unit: "L" }],
      },
    ],
    t: 1_700_000_000_000,
  };

  it("keeps a well-formed kit", () => {
    expect(normalize({ kits: [goodKit] }).kits).toHaveLength(1);
  });

  it("drops a kit holding an item with no id", () => {
    const bad = {
      ...goodKit,
      sections: [{ title: "Water", items: [{ name: "Bottles", have: true }] }],
    };
    expect(normalize({ kits: [bad] }).kits).toEqual([]);
  });

  it("fills in kits for a marks file written before kits existed", () => {
    expect(normalize({ waypoints: [waypoint] }).kits).toEqual([]);
  });
});

describe("normalize — roster and comms", () => {
  const sam = { id: "p1", name: "Sam", blood: "O+", t: 1 };

  it("keeps a well-formed person", () => {
    expect(normalize({ roster: [sam] }).roster).toHaveLength(1);
  });

  it("drops a person whose medical field isn't text", () => {
    expect(normalize({ roster: [{ ...sam, allergies: 42 }] }).roster).toEqual([]);
  });

  it("keeps a comms plan", () => {
    const comms = { channels: [{ label: "Primary", freq: "146.520" }], callsigns: [] };
    expect(normalize({ comms }).comms).toEqual(comms);
  });

  it("treats a malformed comms plan as none, rather than half of one", () => {
    expect(normalize({ comms: { channels: "146.520" } }).comms).toBeNull();
  });

  it("has no roster and no comms in a file written before they existed", () => {
    const m = normalize({ waypoints: [waypoint] });
    expect(m.roster).toEqual([]);
    expect(m.comms).toBeNull();
  });
});

// Waypoints, tracks, plans, kits and the roster are owned by different modules
// but share one file. Each module knows only its own slice, so a whole-Marks
// write from any of them would erase the others' work.
describe("updateMarks", () => {
  beforeEach(async () => {
    await updateMarks({ waypoints: [waypoint], tracks: [], plans: [goodPlan] });
  });

  it("leaves plans alone when a module saves only waypoints", async () => {
    await updateMarks({ waypoints: [waypoint, { ...waypoint, id: "w2" }] });
    expect(currentMarks().plans).toHaveLength(1);
    expect(currentMarks().waypoints).toHaveLength(2);
  });

  it("leaves waypoints alone when a module saves only plans", async () => {
    await updateMarks({ plans: [] });
    expect(currentMarks().plans).toEqual([]);
    expect(currentMarks().waypoints).toHaveLength(1);
  });

  it("carries an earlier patch forward into the next one", async () => {
    await updateMarks({ plans: [] });
    await updateMarks({ waypoints: [] });
    expect(currentMarks().plans).toEqual([]);
    expect(currentMarks().waypoints).toEqual([]);
    expect(currentMarks().tracks).toEqual([]);
  });

  it("leaves kits alone when another module saves", async () => {
    const k = {
      id: "k1",
      name: "Go bag",
      sections: [{ title: "All", items: [] }],
      t: 1,
    };
    await updateMarks({ kits: [k] });
    await updateMarks({ waypoints: [waypoint] });
    expect(currentMarks().kits).toHaveLength(1);
  });
});
