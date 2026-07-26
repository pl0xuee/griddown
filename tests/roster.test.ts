import { describe, it, expect } from "vitest";
import {
  emptyComms,
  isComms,
  isPerson,
  medicalLine,
  rosterIssues,
  type CommsPlan,
  type Person,
} from "../src/roster";

function person(over: Partial<Person> = {}): Person {
  return { id: "p1", name: "Sam", t: 1_700_000_000_000, ...over };
}

function comms(over: Partial<CommsPlan> = {}): CommsPlan {
  return { ...emptyComms(), ...over };
}

describe("medicalLine", () => {
  it("puts the things that change treatment first", () => {
    const line = medicalLine(
      person({ blood: "O+", allergies: "penicillin", meds: "insulin", conditions: "type 1 diabetes" })
    );
    expect(line.indexOf("penicillin")).toBeLessThan(line.indexOf("insulin"));
    expect(line).toMatch(/O\+/);
  });

  it("is empty when nothing medical is recorded", () => {
    expect(medicalLine(person())).toBe("");
  });

  it("says 'none recorded' only for the fields that were filled in", () => {
    const line = medicalLine(person({ allergies: "none known" }));
    expect(line).toMatch(/none known/);
    expect(line).not.toMatch(/blood/i);
  });
});

describe("rosterIssues", () => {
  it("is quiet about a household of one with no comms plan", () => {
    // One person has nobody to raise on the radio.
    expect(rosterIssues([person()], null)).toEqual([]);
  });

  it("wants a comms plan once there is more than one person", () => {
    const issues = rosterIssues([person(), person({ id: "p2", name: "Alex" })], null);
    expect(issues.some((i) => /comms|radio/i.test(i.detail))).toBe(true);
  });

  it("wants an out-of-area contact", () => {
    const issues = rosterIssues(
      [person(), person({ id: "p2" })],
      comms({ channels: [{ label: "Primary", freq: "146.520" }] })
    );
    const hit = issues.find((i) => /out-of-area|out of area/i.test(i.detail));
    expect(hit).toBeDefined();
    expect(hit!.fix).toBeTruthy();
  });

  it("wants a listening schedule once there are channels", () => {
    const issues = rosterIssues(
      [person(), person({ id: "p2" })],
      comms({ channels: [{ label: "Primary" }], outOfArea: "Aunt Ruth, 555-0100" })
    );
    expect(issues.some((i) => /schedule|listen/i.test(i.detail))).toBe(true);
  });

  it("is quiet about a complete plan", () => {
    const issues = rosterIssues(
      [person(), person({ id: "p2" })],
      comms({
        channels: [{ label: "Primary", freq: "146.520", mode: "FM simplex" }],
        outOfArea: "Aunt Ruth, 555-0100",
        schedule: "Listen at :00 and :30, transmit at :05",
      })
    );
    expect(issues).toEqual([]);
  });

  it("says nothing at all about an empty roster", () => {
    // Not everyone has a group, and nagging about it would be noise.
    expect(rosterIssues([], null)).toEqual([]);
  });
});

describe("isPerson", () => {
  it("accepts a well-formed person", () => {
    expect(isPerson(person({ blood: "A-", meds: "salbutamol" }))).toBe(true);
  });

  it("rejects an id that could break out of an HTML attribute", () => {
    expect(isPerson(person({ id: 'p1" onload="x' }))).toBe(false);
  });

  it("rejects a medical field that isn't text", () => {
    expect(isPerson({ ...person(), allergies: 42 })).toBe(false);
  });
});

describe("isComms", () => {
  it("accepts an empty plan", () => {
    expect(isComms(emptyComms())).toBe(true);
  });

  it("accepts a filled-in plan", () => {
    expect(
      isComms(
        comms({
          channels: [{ label: "Primary", freq: "146.520" }],
          callsigns: [{ person: "Sam", sign: "KJ7ABC" }],
        })
      )
    ).toBe(true);
  });

  it("rejects a channel with no label", () => {
    expect(isComms({ ...emptyComms(), channels: [{ freq: "146.520" }] })).toBe(false);
  });

  it("rejects channels that aren't a list", () => {
    expect(isComms({ ...emptyComms(), channels: "146.520" })).toBe(false);
  });
});
