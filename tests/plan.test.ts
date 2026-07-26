import { describe, it, expect } from "vitest";
import {
  simplifyLine,
  freezeRoute,
  planSummary,
  planIssues,
  planBounds,
  makePrimary,
  routeSaveTarget,
  isPlan,
  type FrozenRoute,
  type Plan,
} from "../src/plan";

type LL = [number, number];

const M_PER_DEG_LAT = 111320;

/** A due-east line at 45°N, one point roughly every 8 m. */
function straightLine(n: number): LL[] {
  const out: LL[] = [];
  for (let i = 0; i < n; i++) out.push([-120 + i * 0.0001, 45]);
  return out;
}

/** Metres of latitude, as degrees. */
const lat = (m: number) => m / M_PER_DEG_LAT;

function route(over: Partial<FrozenRoute> = {}): FrozenRoute {
  return {
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
    ...over,
  };
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    id: "p1",
    name: "Home → cabin",
    destination: "the cabin",
    routes: [route()],
    stops: [],
    triggers: [],
    t: 1_700_000_000_000,
    ...over,
  };
}

describe("simplifyLine", () => {
  it("keeps the first and last point", () => {
    const line = straightLine(200);
    const out = simplifyLine(line, 8);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
  });

  it("collapses a straight run to its endpoints", () => {
    expect(simplifyLine(straightLine(200), 8)).toHaveLength(2);
  });

  it("keeps a corner that deviates further than the tolerance", () => {
    const line: LL[] = [
      [-120, 45],
      [-119.99, 45 + lat(50)],
      [-119.98, 45],
    ];
    expect(simplifyLine(line, 8)).toHaveLength(3);
  });

  it("drops a wobble smaller than the tolerance", () => {
    const line: LL[] = [
      [-120, 45],
      [-119.99, 45 + lat(2)],
      [-119.98, 45],
    ];
    expect(simplifyLine(line, 8)).toHaveLength(2);
  });

  it("returns lines too short to simplify untouched", () => {
    expect(simplifyLine([], 8)).toEqual([]);
    expect(simplifyLine([[-120, 45]], 8)).toEqual([[-120, 45]]);
    const two: LL[] = [
      [-120, 45],
      [-119, 45],
    ];
    expect(simplifyLine(two, 8)).toEqual(two);
  });

  it("honours a maximum point count by loosening the tolerance", () => {
    // A zigzag where every midpoint deviates far more than the tolerance, so
    // nothing can be dropped at 8 m — the cap is the only thing that can act.
    const line: LL[] = [];
    for (let i = 0; i < 1000; i++) {
      line.push([-120 + i * 0.001, 45 + (i % 2 ? lat(60) : 0)]);
    }
    expect(simplifyLine(line, 8).length).toBeGreaterThan(500); // uncapped
    const capped = simplifyLine(line, 8, 100);
    expect(capped.length).toBeLessThanOrEqual(100);
    expect(capped[0]).toEqual(line[0]);
    expect(capped[capped.length - 1]).toEqual(line[line.length - 1]);
  });
});

describe("freezeRoute", () => {
  const result = {
    coords: straightLine(500),
    meters: 4000,
    steps: [{ name: "Forest Rd 46", meters: 4000 }],
    usedTrail: true,
  };
  const meta = {
    id: "abc123",
    name: "North alternate",
    from: { lat: 45, lng: -120, label: "home" },
    to: { lat: 45, lng: -119.95, label: "cabin" },
    pack: "OR",
    appVersion: "1.1.8",
    now: 1_700_000_000_000,
  };

  it("records what it was computed against", () => {
    const f = freezeRoute(result, meta);
    expect(f.pack).toBe("OR");
    expect(f.appVersion).toBe("1.1.8");
    expect(f.computedAt).toBe(1_700_000_000_000);
    expect(f.id).toBe("abc123");
    expect(f.name).toBe("North alternate");
  });

  it("carries the distance, turn list and trail flag through", () => {
    const f = freezeRoute(result, meta);
    expect(f.meters).toBe(4000);
    expect(f.steps).toEqual([{ name: "Forest Rd 46", meters: 4000 }]);
    expect(f.usedTrail).toBe(true);
  });

  it("keeps the endpoints the user asked for", () => {
    const f = freezeRoute(result, meta);
    expect(f.from).toEqual({ lat: 45, lng: -120, label: "home" });
    expect(f.to).toEqual({ lat: 45, lng: -119.95, label: "cabin" });
  });

  it("simplifies the geometry without moving its ends", () => {
    const f = freezeRoute(result, meta);
    expect(f.coords.length).toBeLessThan(result.coords.length);
    expect(f.coords[0]).toEqual(result.coords[0]);
    expect(f.coords[f.coords.length - 1]).toEqual(
      result.coords[result.coords.length - 1]
    );
  });
});

describe("planSummary", () => {
  it("reports the primary distance and how many alternates there are", () => {
    const s = planSummary(
      plan({
        routes: [
          route({ id: "r1", meters: 12000 }),
          route({ id: "r2", name: "South alternate", meters: 15000 }),
        ],
      })
    );
    expect(s.primaryMeters).toBe(12000);
    expect(s.alternates).toBe(1);
  });

  it("counts stops by kind", () => {
    const s = planSummary(
      plan({
        stops: [
          { id: "s1", name: "Trailhead", lat: 45, lng: -120, kind: "rally" },
          { id: "s2", name: "Barn", lat: 45, lng: -120, kind: "cache" },
          { id: "s3", name: "Bridge", lat: 45, lng: -120, kind: "avoid" },
          { id: "s4", name: "Second barn", lat: 45, lng: -120, kind: "cache" },
        ],
      })
    );
    expect(s.stops).toBe(4);
    expect(s.byKind.cache).toBe(2);
    expect(s.byKind.rally).toBe(1);
  });

  it("has no primary distance when the plan has no route yet", () => {
    expect(planSummary(plan({ routes: [] })).primaryMeters).toBeNull();
  });
});

describe("planIssues", () => {
  const now = 1_700_000_000_000;
  const installed = ["OR", "WA"];

  it("flags a route whose map pack is not installed", () => {
    const issues = planIssues(plan({ routes: [route({ pack: "ID" })] }), {
      installedPacks: installed,
      now,
    });
    const hit = issues.find((i) => /ID/.test(i.detail));
    expect(hit).toBeDefined();
    expect(hit!.fix).toMatch(/download|map pack/i);
  });

  it("flags a route computed more than a year ago", () => {
    const old = now - 400 * 86400_000;
    const issues = planIssues(plan({ routes: [route({ computedAt: old })] }), {
      installedPacks: installed,
      now,
    });
    expect(issues.some((i) => /recompute/i.test(i.fix))).toBe(true);
  });

  it("flags a plan with no alternate route", () => {
    const issues = planIssues(plan(), { installedPacks: installed, now });
    expect(issues.some((i) => /alternate/i.test(i.detail))).toBe(true);
  });

  it("is quiet about a fresh plan with an alternate and its pack installed", () => {
    const p = plan({
      routes: [route({ id: "r1" }), route({ id: "r2", name: "South alternate" })],
    });
    expect(planIssues(p, { installedPacks: installed, now })).toEqual([]);
  });

  it("says a plan with no route at all is not yet a plan", () => {
    const issues = planIssues(plan({ routes: [] }), {
      installedPacks: installed,
      now,
    });
    expect(issues.some((i) => i.level === "bad")).toBe(true);
  });
});

/**
 * Where a freshly computed route goes. Saving one into the wrong plan is a
 * quiet error — you find out when you open the plan expecting a way out and the
 * route in it goes somewhere else — so the rule is that whenever there is more
 * than one plan, it gets asked.
 */
describe("routeSaveTarget", () => {
  const p1 = plan({ id: "p1" });
  const p2 = plan({ id: "p2" });

  it("has nothing to ask about when there are no plans yet", () => {
    expect(routeSaveTarget([], null)).toEqual({ kind: "create" });
  });

  it("asks whenever there is more than one plan", () => {
    expect(routeSaveTarget([p1, p2], null)).toEqual({ kind: "ask" });
  });

  it("still asks when there is more than one plan, even coming from one", () => {
    // Pressing "Add a route" on a plan says which plan you meant, but the
    // route panel is a long way from that tap and saving to the wrong one is
    // silent. Confirming costs a single button.
    expect(routeSaveTarget([p1, p2], "p1")).toEqual({ kind: "ask" });
  });

  it("does not ask when the only plan is the one that sent you", () => {
    expect(routeSaveTarget([p1], "p1")).toEqual({ kind: "use", planId: "p1" });
  });

  it("asks with one plan when you did not come from it, so a new plan is reachable", () => {
    expect(routeSaveTarget([p1], null)).toEqual({ kind: "ask" });
  });

  it("ignores a stale origin whose plan has since been deleted", () => {
    expect(routeSaveTarget([p1], "gone")).toEqual({ kind: "ask" });
    expect(routeSaveTarget([], "gone")).toEqual({ kind: "create" });
  });
});

describe("makePrimary", () => {
  it("moves the chosen route to the front, keeping the others in order", () => {
    const p = plan({
      routes: [route({ id: "a" }), route({ id: "b" }), route({ id: "c" })],
    });
    expect(makePrimary(p, "c").routes.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("leaves the plan alone when the route isn't in it", () => {
    const p = plan({ routes: [route({ id: "a" }), route({ id: "b" })] });
    expect(makePrimary(p, "zzz").routes.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the plan it was given", () => {
    const p = plan({ routes: [route({ id: "a" }), route({ id: "b" })] });
    makePrimary(p, "b");
    expect(p.routes.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("planBounds", () => {
  it("covers every route and every stop", () => {
    const p = plan({
      routes: [
        route({
          coords: [
            [-120, 45],
            [-119, 46],
          ],
        }),
      ],
      stops: [
        { id: "s1", name: "Cache", lat: 44, lng: -121, kind: "cache" },
      ],
    });
    const b = planBounds(p)!;
    expect(b).toEqual([
      [-121, 44],
      [-119, 46],
    ]);
  });

  it("is null when there is nothing to show", () => {
    expect(planBounds(plan({ routes: [], stops: [] }))).toBeNull();
  });

  it("works from stops alone, before any route is saved", () => {
    const b = planBounds(
      plan({
        routes: [],
        stops: [
          { id: "s1", name: "A", lat: 45, lng: -120, kind: "rally" },
          { id: "s2", name: "B", lat: 46, lng: -119, kind: "rally" },
        ],
      })
    )!;
    expect(b).toEqual([
      [-120, 45],
      [-119, 46],
    ]);
  });
});

describe("isPlan", () => {
  it("accepts a well-formed plan", () => {
    expect(isPlan(plan())).toBe(true);
  });

  it("rejects an id that could break out of an HTML attribute", () => {
    expect(isPlan(plan({ id: 'p1" onload="x' }))).toBe(false);
  });

  it("rejects a route carrying non-finite coordinates", () => {
    const bad = plan({
      routes: [route({ coords: [[NaN, 45], [-119, 45]] as [number, number][] })],
    });
    expect(isPlan(bad)).toBe(false);
  });

  it("rejects a stop outside the world", () => {
    const bad = plan({
      stops: [{ id: "s1", name: "nowhere", lat: 300, lng: -120, kind: "rally" }],
    });
    expect(isPlan(bad)).toBe(false);
  });

  it("rejects a name that is not a string", () => {
    expect(isPlan(plan({ name: 42 as unknown as string }))).toBe(false);
  });

  it("rejects triggers that are not strings", () => {
    expect(isPlan(plan({ triggers: [{} as unknown as string] }))).toBe(false);
  });
});
