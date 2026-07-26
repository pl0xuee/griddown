// Kit checklists — what you have, how much of it, and when it stops working.
//
// Pure: no DOM, no clock. `now` is passed in, so every function here is
// deterministic and testable.
//
// The reason this is not just a list of tickboxes is **rotation**. A go bag
// assembled once and never opened is not a go bag; it is a bag of expired water
// tablets, dead batteries and medication that stopped working two years ago. The
// tickbox says you are ready. The date says whether that is still true. So every
// item can carry a shelf life, the templates in kitdata.ts set realistic ones,
// and the Readiness panel counts what has lapsed — because Readiness is the one
// screen in this app designed to be read *before* the day it matters.

import { isId, isNum, isOptStr, isStr } from "./valid";

export type Supply = "water" | "food" | "fuel";

export interface KitItem {
  id: string;
  name: string;
  have: boolean;
  qty?: number;
  unit?: string;
  /** Dry weight, for the go-bag rollup. A bag you can't carry isn't a plan. */
  grams?: number;
  /** ISO yyyy-mm-dd. */
  expires?: string;
  note?: string;
  /** Marks the item as counting toward days-of-supply. */
  supply?: Supply;
  /**
   * This quantity is per head. Copied from the template so a later rescale can
   * tell a sleeping bag from a stove — without it, resizing the household would
   * have to multiply everything or nothing, and both are wrong.
   */
  perPerson?: boolean;
}

export interface KitSection {
  title: string;
  items: KitItem[];
}

export interface Kit {
  id: string;
  name: string;
  /** Which template it came from, if any. */
  template?: string;
  /** How many people this kit is for. The quantities are scaled to it. */
  people?: number;
  sections: KitSection[];
  t: number;
}

// --- Templates (authored in kitdata.ts) --------------------------------------

export interface TemplateItem {
  name: string;
  qty?: number;
  unit?: string;
  grams?: number;
  note?: string;
  supply?: Supply;
  /** Shelf life in months, turned into a real date when the kit is created. */
  rotateMonths?: number;
  /**
   * This quantity is per head, so it scales with the household.
   *
   * Implied by `supply` — water, food and fuel are consumed by people and
   * always scale. Set it by hand for the rest: four people need four sleeping
   * bags but one stove, and a checklist that scales the stove is as wrong as
   * one that doesn't scale the water.
   */
  perPerson?: boolean;
}

export interface KitTemplateSection {
  title: string;
  items: TemplateItem[];
}

export interface KitTemplate {
  key: string;
  name: string;
  blurb: string;
  /** How many people the quantities as written are for. Defaults to 1. */
  basePeople?: number;
  sections: KitTemplateSection[];
}

/**
 * Planning water, litres per person per day.
 *
 * Covers drinking and cooking in a temperate climate at rest. Heat, exertion,
 * illness or a nursing mother all push it up — which is why the panel states the
 * figure rather than only showing the answer it produced.
 */
export const WATER_L_PER_DAY = 3;

/** Planning calories per person per day. Maintenance for an adult doing real
 *  physical work; sedentary shelter-in-place needs less. */
export const KCAL_PER_DAY = 2000;

/** How near an expiry has to be before it is worth acting on. Two months is
 *  enough time to actually buy the replacement. */
export const SOON_DAYS = 60;

const DAY_MS = 86400_000;

/** yyyy-mm-dd for a UTC timestamp. UTC throughout, so a kit doesn't change its
 *  expiry dates when you cross a timezone. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parse yyyy-mm-dd to a UTC timestamp, or null if it isn't one. */
function parseDate(s: string | undefined): number | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)
  );
  // Clamp to the end of the target month: 31 Jan + 1 month is 28 Feb, not 3 Mar.
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}

/**
 * Scale a per-head quantity, rounding UP.
 *
 * Up, always: three people out of a list written for four need 7.5 tins, and
 * the failure that matters is being short. The toFixed first is float hygiene —
 * without it a quantity that lands on 180.00000000000003 becomes 181.
 */
function scaleQty(qty: number, factor: number): number {
  const scaled = Number((qty * factor).toFixed(6));
  return Number.isInteger(qty) ? Math.ceil(scaled) : Math.ceil(scaled * 10) / 10;
}

/** Build a working kit from a template. Nothing starts ticked — claiming you
 *  already own the contents is the one lie this feature must not tell. */
export function instantiate(
  t: KitTemplate,
  opts: { id: string; now: number; people?: number }
): Kit {
  const base = t.basePeople && t.basePeople > 0 ? t.basePeople : 1;
  // A household of zero, or of NaN, is a typo rather than an answer. Fall back
  // to what the template was written for instead of producing 0 L of water.
  const people =
    typeof opts.people === "number" && Number.isFinite(opts.people) && opts.people >= 1
      ? Math.floor(opts.people)
      : base;
  const factor = people / base;

  return {
    id: opts.id,
    name: t.name,
    template: t.key,
    people,
    t: opts.now,
    sections: t.sections.map((sec, si) => {
      return {
        title: sec.title,
        items: sec.items.map((it, ii) => {
          // supply implies per-person: water, food and fuel are consumed by
          // people. Everything else scales only if it says so.
          const scales = Boolean(it.perPerson || it.supply);
          const qty =
            it.qty !== undefined && scales ? scaleQty(it.qty, factor) : it.qty;
          return {
            id: `s${si}-i${ii}`,
            name: it.name,
            have: false,
            ...(qty !== undefined ? { qty } : {}),
            ...(it.unit !== undefined ? { unit: it.unit } : {}),
            ...(it.grams !== undefined
              ? { grams: scaleGrams(it.grams, it.qty, qty, scales ? factor : 1) }
              : {}),
            ...(it.note !== undefined ? { note: it.note } : {}),
            ...(it.supply !== undefined ? { supply: it.supply } : {}),
            ...(it.perPerson ? { perPerson: true } : {}),
            ...(it.rotateMonths
              ? { expires: isoDate(addMonths(opts.now, it.rotateMonths)) }
              : {}),
          };
        }),
      };
    }),
  };
}

/**
 * Weight of a scaled quantity.
 *
 * `grams` in a template is the weight of the quantity written next to it — "2 ×
 * 1 L bottles, 2100 g" — not the weight of one unit. So it has to move with the
 * quantity, and it has to move by the SAME ratio the quantity actually took,
 * not by the raw household factor: qty rounds up to whole units, and a bag that
 * says 5 tins but weighs 4.7 is a number nobody can check against a scale.
 */
function scaleGrams(
  grams: number,
  fromQty: number | undefined,
  toQty: number | undefined,
  factor: number
): number {
  if (fromQty !== undefined && toQty !== undefined && fromQty > 0) {
    return Math.round(grams * (toQty / fromQty));
  }
  return factor === 1 ? grams : Math.round(grams * factor);
}

/**
 * Resize a kit to a different household.
 *
 * The household is not fixed — someone moves in, a child arrives — and a
 * checklist built for two that still says two is quietly wrong from that day
 * on, in the direction of not having enough.
 *
 * Scales from what the kit currently says rather than re-deriving from the
 * template, so items you added or edited yourself are carried along. The cost
 * is that repeated resizing can drift upward by a unit here and there, because
 * every step rounds up; that is the right direction to drift.
 */
export function rescale(k: Kit, people: number): Kit {
  const from = k.people && k.people >= 1 ? k.people : 1;
  const to =
    Number.isFinite(people) && people >= 1 ? Math.floor(people) : from;
  if (to === from) return k;
  const factor = to / from;
  return {
    ...k,
    people: to,
    sections: k.sections.map((s) => ({
      ...s,
      items: s.items.map((i) => {
        if (!(i.perPerson || i.supply)) return i;
        if (i.qty === undefined) {
          return i.grams === undefined
            ? i
            : { ...i, grams: scaleGrams(i.grams, undefined, undefined, factor) };
        }
        const qty = scaleQty(i.qty, factor);
        return {
          ...i,
          qty,
          ...(i.grams === undefined
            ? {}
            : { grams: scaleGrams(i.grams, i.qty, qty, factor) }),
        };
      }),
    })),
  };
}

function allItems(k: Kit): KitItem[] {
  return k.sections.flatMap((s) => s.items);
}

export interface KitProgress {
  have: number;
  total: number;
  /** Whole percent, 0–100. */
  pct: number;
  /** Weight of what you actually have. */
  grams: number;
}

export function kitProgress(k: Kit): KitProgress {
  const items = allItems(k);
  const have = items.filter((i) => i.have);
  return {
    have: have.length,
    total: items.length,
    pct: items.length ? Math.round((have.length / items.length) * 100) : 0,
    grams: have.reduce((n, i) => n + (i.grams ?? 0), 0),
  };
}

export type ExpiryState = "expired" | "soon" | "ok" | "none";

export function expiryState(i: KitItem, now: number): ExpiryState {
  const t = parseDate(i.expires);
  // An unparseable date is treated as no date. The alternative — calling it
  // expired — turns one typo into a red warning that can never be cleared.
  if (t == null) return "none";
  if (t < now) return "expired";
  return t - now <= SOON_DAYS * DAY_MS ? "soon" : "ok";
}

/** Everything Readiness needs in one shape: the packing numbers plus what has
 *  lapsed. Extends KitProgress because the panel always wants both — "84%
 *  packed" and "4 expired" are the same sentence. */
export interface KitIssues extends KitProgress {
  expired: number;
  soon: number;
  /** The next date that comes round, or null. */
  nextExpiry: string | null;
}

/** What Readiness needs to know about a kit. Only items you HAVE can lapse —
 *  a shelf life on something you never bought is not a problem, it's a
 *  shopping list. */
export function kitIssues(k: Kit, now: number): KitIssues {
  const held = allItems(k).filter((i) => i.have);
  let expired = 0;
  let soon = 0;
  let next: number | null = null;
  for (const i of held) {
    const state = expiryState(i, now);
    if (state === "expired") expired++;
    else if (state === "soon") soon++;
    const t = parseDate(i.expires);
    if (t != null && t >= now && (next == null || t < next)) next = t;
  }
  return { ...kitProgress(k), expired, soon, nextExpiry: next == null ? null : isoDate(next) };
}

export interface SupplyTarget {
  people: number;
  days: number;
  waterL: number;
  kcal: number;
}

export function supplyTargets(people: number, days: number): SupplyTarget {
  return {
    people,
    days,
    waterL: people * days * WATER_L_PER_DAY,
    kcal: people * days * KCAL_PER_DAY,
  };
}

export interface Coverage {
  /** Litres of water you have. */
  waterL: number;
  /** Days that lasts the household, or null when nothing says. */
  waterDays: number | null;
  /** Days of food, only when the kit states food in days. */
  foodDays: number | null;
}

const LITRES = /^(l|litres?|liters?)$/i;
const DAYS = /^days?$/i;

/**
 * How long what you actually hold would last.
 *
 * Deliberately narrow. Water converts because litres are litres. Food does not:
 * forty tins is not a number of days without knowing what is in them, and the
 * honest answer to "how long will this feed us" is sometimes "you haven't
 * written down enough to say". Inventing a figure there would be worse than
 * useless — it would be a number someone plans around.
 */
export function supplyCoverage(k: Kit, people: number): Coverage {
  const held = allItems(k).filter((i) => i.have);
  let waterL = 0;
  let foodDays = 0;
  let sawFoodDays = false;
  for (const i of held) {
    if (i.supply === "water" && i.qty && LITRES.test(i.unit ?? "")) waterL += i.qty;
    if (i.supply === "food" && i.qty && DAYS.test(i.unit ?? "")) {
      foodDays += i.qty;
      sawFoodDays = true;
    }
  }
  return {
    waterL,
    waterDays:
      people > 0 && waterL > 0 ? waterL / (people * WATER_L_PER_DAY) : null,
    foodDays: sawFoodDays ? foodDays : null,
  };
}

// --- Guards ------------------------------------------------------------------

function isKitItem(v: any): v is KitItem {
  return (
    v &&
    isId(v.id) &&
    isStr(v.name) &&
    typeof v.have === "boolean" &&
    (v.qty === undefined || isNum(v.qty)) &&
    isOptStr(v.unit) &&
    (v.grams === undefined || isNum(v.grams)) &&
    isOptStr(v.expires) &&
    isOptStr(v.note) &&
    (v.supply === undefined ||
      v.supply === "water" ||
      v.supply === "food" ||
      v.supply === "fuel") &&
    (v.perPerson === undefined || typeof v.perPerson === "boolean")
  );
}

export function isKit(v: any): v is Kit {
  return (
    v &&
    isId(v.id) &&
    isStr(v.name) &&
    (v.template === undefined || isStr(v.template)) &&
    (v.people === undefined || isNum(v.people)) &&
    Array.isArray(v.sections) &&
    v.sections.every(
      (s: any) => s && isStr(s.title) && Array.isArray(s.items) && s.items.every(isKitItem)
    ) &&
    isNum(v.t)
  );
}
