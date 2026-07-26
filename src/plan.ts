// Bug-out plans — the decisions you made while you still had power, signal and a
// clear head, kept so they survive losing all three.
//
// Pure: no DOM, no maplibre, no network, no clock. Times and ids are passed in,
// so every function here is deterministic and testable.
//
// The point of this module is *freezing*. Get there (route.ts) computes a route
// from the map pack and then forgets it — close the panel and it's gone. A plan
// stores the computed geometry, the turn list and the distance, so it redraws
// with the pack deleted, the app offline and the router never invoked. Recompute
// is offered; it is never required.

import { isId, isNum, isOptStr, isStr, isLatLng, isLngLat } from "./valid";

export type LL = [number, number]; // lng, lat

export type StopKind =
  | "rally"
  | "cache"
  | "fuel"
  | "water"
  | "shelter"
  | "medical"
  | "avoid";

export const STOP_KINDS: readonly StopKind[] = [
  "rally",
  "cache",
  "fuel",
  "water",
  "shelter",
  "medical",
  "avoid",
];

export interface PlanStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  kind: StopKind;
  note?: string;
  /**
   * Optional link to a Waypoint. The coordinates are embedded rather than
   * looked up, so deleting the pin can never damage the plan — the link only
   * exists so the panel can say "this one is on your map too".
   */
  wpId?: string;
}

export interface FrozenRoute {
  id: string;
  /** "Primary", "North alternate" — the user's own label. */
  name: string;
  /** Frozen geometry, simplified at freeze time. */
  coords: LL[];
  meters: number;
  steps: { name: string; meters: number }[];
  usedTrail: boolean;
  /** The endpoints as *asked for*, not as snapped to the road graph. */
  from: { lat: number; lng: number; label: string };
  to: { lat: number; lng: number; label: string };
  /** Provenance — what it was computed against, and when. */
  pack: string;
  computedAt: number;
  appVersion: string;
  /**
   * Hand-drawn rather than routed, so no turn list.
   *
   * Nothing creates these any more — routes come from Get there, which knows
   * about one-way streets, road classes and the Forest Service overlay, none of
   * which a fingertip does. The flag is still read so that a leg drawn before
   * that changed keeps saying what it is, rather than quietly presenting itself
   * as a routed line that happens to have no directions.
   */
  drawn?: boolean;
}

export interface Plan {
  id: string;
  name: string;
  destination: string;
  /** routes[0] is the primary; the rest are alternates. */
  routes: FrozenRoute[];
  stops: PlanStop[];
  /** The go/no-go conditions, written down while calm. */
  triggers: string[];
  /** "If not at the trailhead by 18:00, go to the cabin." */
  rally?: string;
  notes?: string;
  t: number;
}

/** Freeze tolerance, metres. Route geometry comes from z10–z14 rendering tiles,
 *  so it is already coarse; 8 m removes the tile-resolution stair-stepping
 *  without visibly moving the line. */
export const SIMPLIFY_M = 8;

/** Hard ceiling on stored points per route. marks.json is rewritten whole on
 *  every save, and a cross-state route can otherwise run to tens of thousands
 *  of coordinates — which makes saving a waypoint slow for reasons the user
 *  cannot see. */
export const MAX_POINTS = 4000;

/** Beyond this, a frozen route is old enough that the roads may have changed. */
export const STALE_DAYS = 365;

const M_PER_DEG = 111320;
const DAY_MS = 86400_000;

/**
 * Perpendicular distance from p to the segment a–b, in metres.
 *
 * Works in a local equirectangular plane — longitude scaled by cos(latitude) —
 * which is accurate to a fraction of a percent over the few kilometres any one
 * simplification decision spans, and avoids a haversine per candidate point on
 * lines that can be tens of thousands of points long.
 */
function perpDistance(p: LL, a: LL, b: LL, cosRef: number): number {
  const px = p[0] * cosRef * M_PER_DEG;
  const py = p[1] * M_PER_DEG;
  const ax = a[0] * cosRef * M_PER_DEG;
  const ay = a[1] * M_PER_DEG;
  const bx = b[0] * cosRef * M_PER_DEG;
  const by = b[1] * M_PER_DEG;

  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);

  // Clamped projection, so a point beyond an end measures to that end rather
  // than to the infinite line — otherwise a hairpin reads as "close to the
  // segment" and gets dropped.
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** One Douglas–Peucker pass at a fixed tolerance. Iterative, not recursive:
 *  a 40,000-point route would blow the stack. */
function douglasPeucker(coords: LL[], toleranceM: number, cosRef: number): LL[] {
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;

  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let worst = 0;
    let idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpDistance(coords[i], coords[first], coords[last], cosRef);
      if (d > worst) {
        worst = d;
        idx = i;
      }
    }
    if (idx !== -1 && worst > toleranceM) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }

  const out: LL[] = [];
  for (let i = 0; i < coords.length; i++) if (keep[i]) out.push(coords[i]);
  return out;
}

/**
 * Simplify a line to `toleranceM`, optionally under a hard point cap.
 *
 * The cap is honoured by loosening the tolerance rather than by truncating:
 * a route cut off at 4,000 points would draw as a line that stops in the middle
 * of nowhere, which is worse than a slightly coarser one that reaches the
 * destination.
 */
export function simplifyLine(
  coords: LL[],
  toleranceM: number,
  maxPoints?: number
): LL[] {
  if (coords.length <= 2) return coords.slice();

  // One reference latitude for the whole line: the scale factor only has to be
  // right to within a percent or so, and recomputing a cosine per point is the
  // most expensive thing in here.
  const cosRef = Math.cos(
    ((coords[0][1] + coords[coords.length - 1][1]) / 2) * (Math.PI / 180)
  );

  let out = douglasPeucker(coords, toleranceM, cosRef);
  if (!maxPoints || out.length <= maxPoints) return out;

  // Still over. Double the tolerance until it fits. Bounded: 40 doublings takes
  // 8 m past the circumference of the Earth, so this cannot spin.
  let tol = toleranceM;
  for (let i = 0; i < 40 && out.length > maxPoints; i++) {
    tol *= 2;
    out = douglasPeucker(coords, tol, cosRef);
  }

  // Pathological geometry (every point a spike) — decimate, keeping the ends.
  if (out.length > maxPoints) {
    const stride = Math.ceil(out.length / (maxPoints - 1));
    const dec: LL[] = [];
    for (let i = 0; i < out.length; i += stride) dec.push(out[i]);
    const last = out[out.length - 1];
    if (dec[dec.length - 1] !== last) dec.push(last);
    out = dec;
  }
  return out;
}

export interface FreezeMeta {
  id: string;
  name: string;
  from: { lat: number; lng: number; label: string };
  to: { lat: number; lng: number; label: string };
  pack: string;
  appVersion: string;
  now: number;
  drawn?: boolean;
}

/** Turn a freshly computed route into something that outlives the panel. */
export function freezeRoute(
  result: {
    coords: LL[];
    meters: number;
    steps: { name: string; meters: number }[];
    usedTrail: boolean;
  },
  meta: FreezeMeta
): FrozenRoute {
  return {
    id: meta.id,
    name: meta.name,
    coords: simplifyLine(result.coords, SIMPLIFY_M, MAX_POINTS),
    meters: result.meters,
    steps: result.steps.map((s) => ({ name: s.name, meters: s.meters })),
    usedTrail: result.usedTrail,
    from: { ...meta.from },
    to: { ...meta.to },
    pack: meta.pack,
    computedAt: meta.now,
    appVersion: meta.appVersion,
    ...(meta.drawn ? { drawn: true } : {}),
  };
}

export interface PlanSummary {
  routes: number;
  alternates: number;
  /** Null when no route has been saved yet. */
  primaryMeters: number | null;
  stops: number;
  byKind: Partial<Record<StopKind, number>>;
  /** Oldest route's freeze time, or null. */
  oldestComputedAt: number | null;
}

export function planSummary(p: Plan): PlanSummary {
  const byKind: Partial<Record<StopKind, number>> = {};
  for (const s of p.stops) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
  return {
    routes: p.routes.length,
    alternates: Math.max(0, p.routes.length - 1),
    primaryMeters: p.routes.length ? p.routes[0].meters : null,
    stops: p.stops.length,
    byKind,
    oldestComputedAt: p.routes.length
      ? Math.min(...p.routes.map((r) => r.computedAt))
      : null,
  };
}

export type SaveTarget =
  | { kind: "create" }
  | { kind: "use"; planId: string }
  | { kind: "ask" };

/**
 * Which plan a freshly computed route should go into.
 *
 * The rule is: whenever there is more than one plan, ask. Saving a route into
 * the wrong plan is a silent error — nothing looks broken, and you find out on
 * the day you open the plan expecting a way out and the route in it goes
 * somewhere else. Pressing "Add a route" on a plan does say which one you
 * meant, but the route panel is a long way from that tap, so it is treated as a
 * default to confirm rather than an answer to act on.
 *
 * The one case with nothing to ask: a single plan, which is also the one that
 * sent you.
 */
export function routeSaveTarget(plans: Plan[], sentFromId: string | null): SaveTarget {
  if (!plans.length) return { kind: "create" };
  if (plans.length === 1 && sentFromId && plans[0].id === sentFromId) {
    return { kind: "use", planId: plans[0].id };
  }
  return { kind: "ask" };
}

/**
 * Promote a route to primary.
 *
 * "Primary" is position, not a flag — routes[0] is the one the plan is about.
 * One source of truth beats a boolean that can be set on two routes at once.
 */
export function makePrimary(p: Plan, routeId: string): Plan {
  const i = p.routes.findIndex((r) => r.id === routeId);
  if (i <= 0) return p;
  const routes = p.routes.slice();
  const [r] = routes.splice(i, 1);
  routes.unshift(r);
  return { ...p, routes };
}

/** Bounding box over everything in the plan, as [[w, s], [e, n]] for fitBounds. */
export function planBounds(p: Plan): [[number, number], [number, number]] | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const see = (lng: number, lat: number) => {
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  };
  for (const r of p.routes) for (const c of r.coords) see(c[0], c[1]);
  // Stops count too: a cache off the route still has to fit on screen, and a
  // plan with stops but no route yet must still be showable.
  for (const st of p.stops) see(st.lng, st.lat);
  return Number.isFinite(w) ? [[w, s], [e, n]] : null;
}

export interface Issue {
  /** Matches readiness.ts's Check, so it can render these unchanged. */
  label: string;
  level: "warn" | "bad";
  detail: string;
  fix: string;
}

function ageText(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  if (days < 60) return `${days} days`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return `${(days / 365).toFixed(1)} years`;
}

/**
 * What is wrong with this plan *while there is still time to fix it*. Rendered
 * by the Readiness panel, which is the one place in the app that exists to be
 * read before the grid goes down rather than after.
 */
export function planIssues(
  p: Plan,
  opts: { installedPacks: string[]; now: number; staleDays?: number }
): Issue[] {
  const out: Issue[] = [];
  const staleMs = (opts.staleDays ?? STALE_DAYS) * DAY_MS;

  if (!p.routes.length) {
    out.push({
      label: p.name,
      level: "bad",
      detail: `"${p.name}" has no route saved — it is a destination, not yet a plan.`,
      fix: "Open Get there, work out the route, and press Save to plan while you still have data.",
    });
    return out;
  }

  const packs = new Set(opts.installedPacks.map((s) => s.toUpperCase()));
  for (const r of p.routes) {
    if (r.pack && !packs.has(r.pack.toUpperCase())) {
      out.push({
        label: p.name,
        level: "warn",
        detail: `"${r.name}" was built from the ${r.pack} map pack, which isn't downloaded.`,
        fix: `The route still draws from its stored shape, but you have no map under it. Download ${r.pack} in Map packs.`,
      });
    }
    const age = opts.now - r.computedAt;
    if (age > staleMs) {
      out.push({
        label: p.name,
        level: "warn",
        detail: `"${r.name}" was frozen ${ageText(age)} ago.`,
        fix: "Roads change, and closures don't announce themselves. Recompute it while you have data.",
      });
    }
  }

  if (p.routes.length < 2) {
    out.push({
      label: p.name,
      level: "warn",
      detail: `"${p.name}" has no alternate route.`,
      fix: "One blocked bridge and the plan is gone. Add a second route that doesn't share the failure.",
    });
  }

  return out;
}

// --- Guards -----------------------------------------------------------------
// Everything below runs on data read back from marks.json or a restored backup.

function isFrozenRoute(v: any): v is FrozenRoute {
  return (
    v &&
    isId(v.id) &&
    isStr(v.name) &&
    Array.isArray(v.coords) &&
    v.coords.every(isLngLat) &&
    isNum(v.meters) &&
    Array.isArray(v.steps) &&
    v.steps.every((s: any) => s && isStr(s.name) && isNum(s.meters)) &&
    typeof v.usedTrail === "boolean" &&
    v.from &&
    isLatLng(v.from.lat, v.from.lng) &&
    isStr(v.from.label) &&
    v.to &&
    isLatLng(v.to.lat, v.to.lng) &&
    isStr(v.to.label) &&
    isStr(v.pack) &&
    isNum(v.computedAt) &&
    isStr(v.appVersion)
  );
}

function isPlanStop(v: any): v is PlanStop {
  return (
    v &&
    isId(v.id) &&
    isStr(v.name) &&
    isLatLng(v.lat, v.lng) &&
    STOP_KINDS.includes(v.kind) &&
    isOptStr(v.note) &&
    (v.wpId === undefined || isId(v.wpId))
  );
}

export function isPlan(v: any): v is Plan {
  return (
    v &&
    isId(v.id) &&
    isStr(v.name) &&
    isStr(v.destination) &&
    Array.isArray(v.routes) &&
    v.routes.every(isFrozenRoute) &&
    Array.isArray(v.stops) &&
    v.stops.every(isPlanStop) &&
    Array.isArray(v.triggers) &&
    v.triggers.every(isStr) &&
    isOptStr(v.rally) &&
    isOptStr(v.notes) &&
    isNum(v.t)
  );
}
