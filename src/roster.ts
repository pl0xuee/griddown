// Who is in the group, what a medic would need to know about them, and how you
// raise each other when the phones stop.
//
// Pure: no DOM, no clock. Guards included, because this comes back out of
// marks.json like everything else.
//
// This is the most sensitive data the app holds, and it is held for one reason:
// the moment it is needed, nobody can look it up. A blood type, an allergy and
// a dose are exactly the facts that vanish when the person who knows them is
// the person on the ground. It stays on the device — never in a GPX export,
// never over the network, never in a crash log — and it goes on the printed
// one-pager, which is the copy that survives a dead battery.

import { isId, isNum, isOptStr, isStr } from "./valid";
import type { Issue } from "./plan";

export interface Person {
  id: string;
  name: string;
  /** "Driver", "medic", "has the dog" — whatever the group actually needs. */
  role?: string;
  blood?: string;
  allergies?: string;
  meds?: string;
  conditions?: string;
  /** Their own number, or how else to reach them. */
  contact?: string;
  t: number;
}

export interface CommsChannel {
  label: string;
  freq?: string;
  mode?: string;
  note?: string;
}

export interface Callsign {
  person: string;
  sign: string;
}

export interface CommsPlan {
  channels: CommsChannel[];
  callsigns: Callsign[];
  /** "Listen at :00 and :30, transmit at :05." */
  schedule?: string;
  /** The Meshtastic channel the Team mesh panel is set to. */
  meshChannel?: string;
  /**
   * The contact everybody calls who is NOT local.
   *
   * Local lines and local towers fail together and are congested first; a
   * distant relative can often still be reached when nobody in the affected
   * area can reach anybody else. Everyone calling one distant number turns
   * "we're all scattered" into "we all know where each other are".
   */
  outOfArea?: string;
}

export const emptyComms = (): CommsPlan => ({ channels: [], callsigns: [] });

/**
 * One line of medical facts, ordered by what changes treatment soonest.
 *
 * Allergies first: the fastest way to hurt someone in a hurry is the drug they
 * react to. Then what they already have wrong, then what they take for it, then
 * blood group — which matters least in the field, because nobody is transfusing
 * anyone there.
 */
export function medicalLine(p: Person): string {
  const parts: string[] = [];
  if (p.allergies?.trim()) parts.push(`Allergies: ${p.allergies.trim()}`);
  if (p.conditions?.trim()) parts.push(`Conditions: ${p.conditions.trim()}`);
  if (p.meds?.trim()) parts.push(`Meds: ${p.meds.trim()}`);
  if (p.blood?.trim()) parts.push(`Blood: ${p.blood.trim()}`);
  return parts.join(" · ");
}

/**
 * What is missing from the comms side of the plan.
 *
 * Silent for a household of one, deliberately: a comms plan is an agreement
 * between people, and nagging someone who has nobody to agree with is noise
 * that teaches them to ignore the whole panel.
 */
export function rosterIssues(roster: Person[], comms: CommsPlan | null): Issue[] {
  const out: Issue[] = [];
  if (roster.length < 2) return out;

  if (!comms || (!comms.channels.length && !comms.outOfArea)) {
    out.push({
      label: "Comms plan",
      level: "warn",
      detail: "No comms plan — nothing written down about how you reach each other by radio.",
      fix: "Plan → Comms. Agree a channel, a listening schedule and one out-of-area contact while you can still talk about it.",
    });
    return out;
  }

  if (!comms.outOfArea?.trim()) {
    out.push({
      label: "Comms plan",
      level: "warn",
      detail: "No out-of-area contact.",
      fix: "Local lines fail and congest together. Pick one distant person everyone calls, and write their number on the printed plan.",
    });
  }

  if (comms.channels.length && !comms.schedule?.trim()) {
    out.push({
      label: "Comms plan",
      level: "warn",
      detail: "Channels, but no listening schedule.",
      fix: "Two radios that are never on at the same time never meet. Agree the minutes past the hour you all listen.",
    });
  }

  return out;
}

// --- Guards ------------------------------------------------------------------

export function isPerson(v: any): v is Person {
  return (
    v &&
    isId(v.id) &&
    isStr(v.name) &&
    isOptStr(v.role) &&
    isOptStr(v.blood) &&
    isOptStr(v.allergies) &&
    isOptStr(v.meds) &&
    isOptStr(v.conditions) &&
    isOptStr(v.contact) &&
    isNum(v.t)
  );
}

export function isComms(v: any): v is CommsPlan {
  return (
    v &&
    Array.isArray(v.channels) &&
    v.channels.every(
      (c: any) =>
        c && isStr(c.label) && isOptStr(c.freq) && isOptStr(c.mode) && isOptStr(c.note)
    ) &&
    Array.isArray(v.callsigns) &&
    v.callsigns.every((c: any) => c && isStr(c.person) && isStr(c.sign)) &&
    isOptStr(v.schedule) &&
    isOptStr(v.meshChannel) &&
    isOptStr(v.outOfArea)
  );
}
