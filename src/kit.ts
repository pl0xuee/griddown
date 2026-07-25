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
}

export interface KitTemplateSection {
  title: string;
  items: TemplateItem[];
}

export interface KitTemplate {
  key: string;
  name: string;
  blurb: string;
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

/** Build a working kit from a template. Nothing starts ticked — claiming you
 *  already own the contents is the one lie this feature must not tell. */
export function instantiate(
  t: KitTemplate,
  opts: { id: string; now: number }
): Kit {
  return {
    id: opts.id,
    name: t.name,
    template: t.key,
    t: opts.now,
    sections: t.sections.map((sec, si) => ({
      title: sec.title,
      items: sec.items.map((it, ii) => ({
        id: `s${si}-i${ii}`,
        name: it.name,
        have: false,
        ...(it.qty !== undefined ? { qty: it.qty } : {}),
        ...(it.unit !== undefined ? { unit: it.unit } : {}),
        ...(it.grams !== undefined ? { grams: it.grams } : {}),
        ...(it.note !== undefined ? { note: it.note } : {}),
        ...(it.supply !== undefined ? { supply: it.supply } : {}),
        ...(it.rotateMonths
          ? { expires: isoDate(addMonths(opts.now, it.rotateMonths)) }
          : {}),
      })),
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
      v.supply === "fuel")
  );
}

export function isKit(v: any): v is Kit {
  return (
    v &&
    isId(v.id) &&
    isStr(v.name) &&
    (v.template === undefined || isStr(v.template)) &&
    Array.isArray(v.sections) &&
    v.sections.every(
      (s: any) => s && isStr(s.title) && Array.isArray(s.items) && s.items.every(isKitItem)
    ) &&
    isNum(v.t)
  );
}
