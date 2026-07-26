import { describe, it, expect } from "vitest";
import {
  instantiate,
  kitProgress,
  expiryState,
  kitIssues,
  supplyTargets,
  supplyCoverage,
  isKit,
  WATER_L_PER_DAY,
  type Kit,
  type KitItem,
  type KitTemplate,
} from "../src/kit";

// 2026-07-01T00:00:00Z, so the date arithmetic below is readable.
const NOW = Date.UTC(2026, 6, 1);
const DAY = 86400_000;

const template: KitTemplate = {
  key: "go-bag-72h",
  name: "Go bag — 72 hours",
  blurb: "One person, on foot, for three days.",
  sections: [
    {
      title: "Water",
      items: [
        { name: "Bottles", qty: 3, unit: "L", grams: 3000, supply: "water" },
        { name: "Purification tablets", rotateMonths: 24, grams: 20 },
      ],
    },
    { title: "Fire", items: [{ name: "Lighter", grams: 15 }] },
  ],
};

function item(over: Partial<KitItem> = {}): KitItem {
  return { id: "i1", name: "Thing", have: false, ...over };
}

function kit(items: KitItem[]): Kit {
  return {
    id: "k1",
    name: "Go bag",
    sections: [{ title: "All", items }],
    t: NOW,
  };
}

describe("instantiate", () => {
  it("copies the template's structure", () => {
    const k = instantiate(template, { id: "k1", now: NOW });
    expect(k.name).toBe("Go bag — 72 hours");
    expect(k.template).toBe("go-bag-72h");
    expect(k.sections.map((s) => s.title)).toEqual(["Water", "Fire"]);
    expect(k.sections[0].items.map((i) => i.name)).toEqual([
      "Bottles",
      "Purification tablets",
    ]);
  });

  it("starts with nothing packed", () => {
    const k = instantiate(template, { id: "k1", now: NOW });
    expect(k.sections.flatMap((s) => s.items).every((i) => !i.have)).toBe(true);
  });

  it("turns a shelf life into a real date", () => {
    const k = instantiate(template, { id: "k1", now: NOW });
    // 24 months from 2026-07-01.
    expect(k.sections[0].items[1].expires).toBe("2028-07-01");
  });

  it("leaves items with no shelf life undated", () => {
    const k = instantiate(template, { id: "k1", now: NOW });
    expect(k.sections[0].items[0].expires).toBeUndefined();
  });

  it("gives every item an id that survives the store's guards", () => {
    const k = instantiate(template, { id: "k1", now: NOW });
    const ids = k.sections.flatMap((s) => s.items).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

/**
 * Household scaling. A go bag is written for one person and the home list for
 * four; neither is the number of people actually standing in your hallway, and
 * a checklist that says "9 L of water" when there are five of you is not a
 * checklist, it is a wrong answer with tickboxes.
 */
describe("instantiate — household size", () => {
  const household: KitTemplate = {
    key: "home",
    name: "Home",
    blurb: "For four, for thirty days.",
    basePeople: 4,
    sections: [
      {
        title: "Water",
        items: [
          { name: "Stored water", qty: 360, unit: "L", supply: "water", perPerson: true },
          { name: "Gravity filter", qty: 1, unit: "unit" },
        ],
      },
    ],
  };

  it("scales a per-person quantity to the household you gave it", () => {
    const k = instantiate(household, { id: "k1", now: NOW, people: 2 });
    expect(k.sections[0].items[0].qty).toBe(180);
  });

  it("leaves shared equipment alone — two people do not need two filters", () => {
    const k = instantiate(household, { id: "k1", now: NOW, people: 8 });
    expect(k.sections[0].items[1].qty).toBe(1);
  });

  it("scales up as well as down", () => {
    expect(
      instantiate(household, { id: "k1", now: NOW, people: 6 }).sections[0].items[0].qty
    ).toBe(540);
  });

  it("rounds a fraction UP, because being short is the failure that matters", () => {
    const t: KitTemplate = {
      key: "t", name: "T", blurb: "", basePeople: 4,
      sections: [{ title: "Food", items: [{ name: "Tins", qty: 10, unit: "cans", perPerson: true }] }],
    };
    // 10 × 3/4 = 7.5 → 8, not 7.
    expect(instantiate(t, { id: "k1", now: NOW, people: 3 }).sections[0].items[0].qty).toBe(8);
  });

  it("remembers who the kit is for", () => {
    expect(instantiate(household, { id: "k1", now: NOW, people: 3 }).people).toBe(3);
  });

  it("uses the template's own baseline when not told otherwise", () => {
    const k = instantiate(household, { id: "k1", now: NOW });
    expect(k.people).toBe(4);
    expect(k.sections[0].items[0].qty).toBe(360);
  });

  it("treats a household of one as one, not as nothing", () => {
    const k = instantiate(household, { id: "k1", now: NOW, people: 1 });
    expect(k.people).toBe(1);
    expect(k.sections[0].items[0].qty).toBe(90);
  });

  it("refuses a nonsense household rather than producing nonsense quantities", () => {
    for (const bad of [0, -3, Number.NaN]) {
      const k = instantiate(household, { id: "k1", now: NOW, people: bad });
      expect(k.people).toBe(4);
      expect(k.sections[0].items[0].qty).toBe(360);
    }
  });
});

describe("kitProgress", () => {
  it("counts what is packed and what it weighs", () => {
    const p = kitProgress(
      kit([
        item({ id: "a", have: true, grams: 1000 }),
        item({ id: "b", have: true, grams: 500 }),
        item({ id: "c", have: false, grams: 9000 }),
      ])
    );
    expect(p.have).toBe(2);
    expect(p.total).toBe(3);
    expect(p.pct).toBe(67);
    // Only what you actually have can weigh anything.
    expect(p.grams).toBe(1500);
  });

  it("calls an empty kit zero rather than dividing by nothing", () => {
    expect(kitProgress(kit([])).pct).toBe(0);
  });
});

describe("expiryState", () => {
  it("says nothing about an item with no date", () => {
    expect(expiryState(item(), NOW)).toBe("none");
  });

  it("flags a date already past", () => {
    expect(expiryState(item({ expires: "2026-06-30" }), NOW)).toBe("expired");
  });

  it("warns about one coming up inside two months", () => {
    expect(expiryState(item({ expires: "2026-08-01" }), NOW)).toBe("soon");
  });

  it("is quiet about a date comfortably ahead", () => {
    expect(expiryState(item({ expires: "2027-08-01" }), NOW)).toBe("ok");
  });

  it("treats an unparseable date as no date rather than as expired", () => {
    // Otherwise a typo turns into a permanent red warning nobody can clear.
    expect(expiryState(item({ expires: "soon-ish" }), NOW)).toBe("none");
  });
});

describe("kitIssues", () => {
  it("counts expired and nearly-expired items", () => {
    const i = kitIssues(
      kit([
        item({ id: "a", have: true, expires: "2025-01-01" }),
        item({ id: "b", have: true, expires: "2026-07-20" }),
        item({ id: "c", have: true, expires: "2030-01-01" }),
        item({ id: "d", have: false }),
      ]),
      NOW
    );
    expect(i.expired).toBe(1);
    expect(i.soon).toBe(1);
  });

  it("reports the next date to come round", () => {
    const i = kitIssues(
      kit([
        item({ id: "a", have: true, expires: "2030-01-01" }),
        item({ id: "b", have: true, expires: "2027-03-04" }),
      ]),
      NOW
    );
    expect(i.nextExpiry).toBe("2027-03-04");
  });

  it("ignores the shelf life of something you do not have", () => {
    const i = kitIssues(kit([item({ id: "a", have: false, expires: "2020-01-01" })]), NOW);
    expect(i.expired).toBe(0);
  });
});

describe("supplyTargets", () => {
  it("works out water and calories for a household", () => {
    const t = supplyTargets(4, 14);
    expect(t.waterL).toBe(4 * 14 * WATER_L_PER_DAY);
    expect(t.kcal).toBeGreaterThan(0);
  });
});

describe("supplyCoverage", () => {
  it("turns litres you have into days for the household", () => {
    const c = supplyCoverage(
      kit([
        item({ id: "a", have: true, qty: 60, unit: "L", supply: "water" }),
        item({ id: "b", have: true, qty: 30, unit: "L", supply: "water" }),
      ]),
      3
    );
    expect(c.waterL).toBe(90);
    expect(c.waterDays).toBeCloseTo(90 / (3 * WATER_L_PER_DAY), 5);
  });

  it("counts only water you actually have", () => {
    const c = supplyCoverage(
      kit([
        item({ id: "a", have: true, qty: 30, unit: "L", supply: "water" }),
        item({ id: "b", have: false, qty: 500, unit: "L", supply: "water" }),
      ]),
      1
    );
    expect(c.waterL).toBe(30);
  });

  it("reads food stated in days", () => {
    const c = supplyCoverage(
      kit([item({ id: "a", have: true, qty: 21, unit: "days", supply: "food" })]),
      2
    );
    expect(c.foodDays).toBe(21);
  });

  it("says it cannot tell rather than guessing", () => {
    // Tins with no stated days are real data the maths simply can't use.
    const c = supplyCoverage(
      kit([item({ id: "a", have: true, qty: 40, unit: "cans", supply: "food" })]),
      2
    );
    expect(c.foodDays).toBeNull();
    expect(c.waterDays).toBeNull();
  });
});

describe("isKit", () => {
  it("accepts a well-formed kit", () => {
    expect(isKit(instantiate(template, { id: "k1", now: NOW }))).toBe(true);
  });

  it("rejects an id that could break out of an HTML attribute", () => {
    expect(isKit({ ...kit([]), id: 'k1" onload="x' })).toBe(false);
  });

  it("rejects an item whose have flag is not a boolean", () => {
    const bad = kit([{ id: "a", name: "Thing", have: "yes" } as unknown as KitItem]);
    expect(isKit(bad)).toBe(false);
  });

  it("rejects a section that is not shaped like one", () => {
    expect(isKit({ ...kit([]), sections: [{ title: 5, items: [] }] })).toBe(false);
  });
});
