// How a teammate's position is described once it has arrived.
//
// Kept apart from the radio transport on purpose: this is the part that decides
// what the user is told, and it must be testable without a radio, which is just
// as well because there isn't one.
//
// The governing idea is that a mesh position is ALWAYS old. LoRa nodes report
// every few minutes at best, packets are dropped, and a node that has walked
// into a canyon simply stops reporting while its last position sits on the map
// looking exactly as authoritative as a fresh one. So age is never optional
// here: every position is presented with how old it is, and old ones are
// visibly degraded rather than quietly shown.

import { haversine, bearing, cardinal, type LL } from "./geo";

export interface MeshNode {
  /** Numeric node number from the radio. */
  num: number;
  /** "!7c3f0a1b" — how Meshtastic writes node ids. */
  id: string;
  longName: string;
  shortName: string;
  lat?: number;
  lng?: number;
  /** Metres above sea level, when reported. */
  altitude?: number;
  /** Unix seconds of the position fix. */
  posTime?: number;
  /** 0-100, or >100 meaning plugged in (the radio's convention). */
  battery?: number;
  /** Signal-to-noise of the last packet, dB. */
  snr?: number;
  /** How many mesh hops away, 0 = heard directly. */
  hops?: number;
  /** Unix seconds we last heard anything at all from this node. */
  lastHeard?: number;
  /**
   * Metres of deliberate fuzzing, when the sender reduced its position
   * precision. Present means "somewhere in this circle", not "here".
   */
  uncertaintyM?: number;
}

/** Node ids are written as "!" plus eight lowercase hex digits. */
export function formatNodeId(num: number): string {
  // >>> 0 keeps it unsigned: node numbers routinely exceed 2^31 and would
  // otherwise print with a minus sign.
  return `!${(num >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * A position is only as good as it is recent.
 *
 * Thresholds chosen against how Meshtastic actually behaves: nodes broadcast
 * position on the order of every few minutes, so under 5 minutes is current,
 * under 30 is usable with care, and beyond an hour it is history, not a
 * location. A rescue decision made on a two-hour-old fix is a search in the
 * wrong place.
 */
export type Freshness = "live" | "recent" | "stale" | "old";

export function freshness(posTime: number | undefined, nowSec: number): Freshness {
  if (!posTime) return "old";
  const age = nowSec - posTime;
  if (age < 300) return "live";
  if (age < 1800) return "recent";
  if (age < 3600) return "stale";
  return "old";
}

/** "just now", "4 min ago", "2 h 10 min ago", "3 days ago". */
export function formatAge(posTime: number | undefined, nowSec: number): string {
  if (!posTime) return "never";
  const age = Math.max(0, nowSec - posTime);
  if (age < 45) return "just now";
  const min = Math.round(age / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(age / 3600);
  if (h < 24) {
    const rem = Math.round((age - h * 3600) / 60);
    return rem ? `${h} h ${rem} min ago` : `${h} h ago`;
  }
  const d = Math.round(age / 86400);
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

/** Distance and heading from you to a node, in the units the app uses. */
export function relativeTo(from: LL, node: MeshNode): { miles: number; brg: number; text: string } | null {
  if (node.lat == null || node.lng == null) return null;
  const metres = haversine(from, [node.lng, node.lat]);
  const brg = bearing(from, [node.lng, node.lat]);
  const miles = metres / 1609.344;
  const dist =
    miles < 0.1 ? `${Math.round(metres * 3.28084)} ft` : `${miles.toFixed(miles < 10 ? 2 : 1)} mi`;
  return { miles, brg, text: `${dist} ${cardinal(brg)}` };
}

/**
 * Battery as the radio reports it: 0-100, or over 100 meaning it is on
 * external power. Anything else is unknown rather than zero — showing "0%"
 * for a node that never sent a battery reading would read as "about to die".
 */
export function formatBattery(level: number | undefined): string {
  if (level == null) return "";
  if (level > 100) return "plugged in";
  if (level < 0) return "";
  return `${Math.round(level)}%`;
}

/** Sort: closest first, but anything without a position sinks to the bottom. */
export function sortNodes(nodes: MeshNode[], from: LL | null): MeshNode[] {
  return [...nodes].sort((a, b) => {
    const ap = a.lat != null && a.lng != null;
    const bp = b.lat != null && b.lng != null;
    if (ap !== bp) return ap ? -1 : 1;
    if (ap && bp && from) {
      return haversine(from, [a.lng!, a.lat!]) - haversine(from, [b.lng!, b.lat!]);
    }
    return (b.lastHeard ?? 0) - (a.lastHeard ?? 0);
  });
}

/** Name to show: the long name, falling back through short name to the id. */
export function displayName(n: MeshNode): string {
  return n.longName?.trim() || n.shortName?.trim() || n.id;
}
