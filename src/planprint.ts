import { forward as mgrsForward } from "mgrs";
import { PAPERS, fmtMgrs, textToPdf, type PdfBlock } from "./paper";
import { saveFile } from "./save";
import { toast } from "./toast";
import { kitIssues, type Kit } from "./kit";
import { medicalLine, type CommsPlan, type Person } from "./roster";
import type { FrozenRoute, Plan, PlanStop, StopKind } from "./plan";

// The plan, on paper.
//
// Every other copy of this depends on a battery. This one doesn't, and that is
// the entire argument for it: the day the plan matters is the day the phone is
// at 4% and there is nowhere to charge it. Print it, fold it, put a copy in each
// go bag and one in the glovebox, and the plan survives the device.
//
// It is deliberately a *document*, not a screenshot of the panel. Coordinates
// appear twice — decimal degrees and MGRS — because whoever reads this may be
// working from a paper quad sheet or reading a grid to somebody over a radio.

/** Where the last successful export happened. Readiness reads this: a plan that
 *  has never been printed is one device failure from being gone. */
export const PLAN_PDF_KEY = "griddown_last_plan_pdf";

const MI = 1609.344;
const miles = (m: number) => (m / MI < 10 ? (m / MI).toFixed(1) : String(Math.round(m / MI)));

const KIND_LABEL: Record<StopKind, string> = {
  rally: "RALLY",
  cache: "CACHE",
  fuel: "FUEL",
  water: "WATER",
  shelter: "SHELTER",
  medical: "MEDICAL",
  avoid: "AVOID",
};

/** Decimal degrees and a grid reference, on one line. */
function position(lat: number, lng: number): string {
  let grid = "";
  try {
    grid = fmtMgrs(mgrsForward([lng, lat]));
  } catch {
    // mgrs throws outside its valid latitude band. The decimal pair is still
    // usable, and half an answer beats refusing to print the page.
    grid = "";
  }
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}${grid ? `   ${grid}` : ""}`;
}

function stopBlocks(stops: PlanStop[]): PdfBlock[] {
  if (!stops.length) return [{ kind: "line", text: "None recorded." }];
  const out: PdfBlock[] = [];
  for (const s of stops) {
    out.push({ kind: "kv", label: `${KIND_LABEL[s.kind]}  ${s.name}`, value: "" });
    out.push({ kind: "line", text: position(s.lat, s.lng), indent: 2 });
    if (s.note) out.push({ kind: "line", text: s.note, indent: 2 });
  }
  return out;
}

function routeBlocks(r: FrozenRoute, i: number): PdfBlock[] {
  const out: PdfBlock[] = [
    { kind: "heading", text: `${i === 0 ? "PRIMARY" : "ALTERNATE"} — ${r.name}` },
    { kind: "kv", label: "Distance", value: `${miles(r.meters)} mi` },
    { kind: "kv", label: "From", value: r.from.label },
    { kind: "line", text: position(r.from.lat, r.from.lng), indent: 2 },
    { kind: "kv", label: "To", value: r.to.label },
    { kind: "line", text: position(r.to.lat, r.to.lng), indent: 2 },
    {
      kind: "line",
      text: `Frozen ${new Date(r.computedAt).toISOString().slice(0, 10)}${
        r.pack ? ` from the ${r.pack} map pack` : ""
      }, app v${r.appVersion}.`,
    },
  ];
  if (r.usedTrail) {
    out.push({
      kind: "line",
      text: "! Part of this route is a trail or track, not a road. It may not be passable by vehicle.",
    });
  }
  if (r.drawn) {
    out.push({
      kind: "line",
      text: "! Hand-drawn. Follows what was tapped on the map, not the road network, and has no turn list.",
    });
  } else if (r.steps.length) {
    out.push({ kind: "spacer" });
    for (const s of r.steps.filter((s) => s.meters > 40)) {
      out.push({ kind: "kv", label: s.name, value: `${miles(s.meters)} mi` });
    }
  }
  out.push({ kind: "spacer", pt: 10 });
  return out;
}

export interface PlanPrintContext {
  roster: Person[];
  comms: CommsPlan | null;
  kits: Kit[];
  /** Passed in rather than read, so the document is reproducible in a test. */
  now: number;
}

/** Build the document. Pure — separated from saving so it can be exercised. */
export function planDocument(p: Plan, ctx: PlanPrintContext): Uint8Array {
  const blocks: PdfBlock[] = [];
  const date = new Date(ctx.now).toISOString().slice(0, 10);

  blocks.push({ kind: "kv", label: "Destination", value: p.destination || "—" });
  blocks.push({ kind: "kv", label: "Routes", value: String(p.routes.length) });
  blocks.push({ kind: "rule" });

  // Order is deliberate: the things you act on before you move, first.
  blocks.push({ kind: "heading", text: "GO / NO-GO" });
  if (p.triggers.length) {
    for (const t of p.triggers) blocks.push({ kind: "line", text: `- ${t}`, indent: 2 });
  } else {
    blocks.push({ kind: "line", text: "No conditions written down." });
  }

  blocks.push({ kind: "heading", text: "IF YOU ARE APART" });
  blocks.push({ kind: "line", text: p.rally || "No rule agreed." });

  blocks.push({ kind: "heading", text: "STOPS" });
  blocks.push(...stopBlocks(p.stops));

  if (ctx.roster.length) {
    blocks.push({ kind: "heading", text: "WHO IS WITH YOU" });
    for (const person of ctx.roster) {
      blocks.push({
        kind: "kv",
        label: person.name,
        value: person.role || "",
      });
      const med = medicalLine(person);
      if (med) blocks.push({ kind: "line", text: med, indent: 2 });
      if (person.contact) blocks.push({ kind: "line", text: person.contact, indent: 2 });
    }
  }

  const c = ctx.comms;
  if (c && (c.channels.length || c.outOfArea || c.schedule)) {
    blocks.push({ kind: "heading", text: "COMMS" });
    for (const ch of c.channels) {
      blocks.push({
        kind: "kv",
        label: ch.label,
        value: [ch.freq, ch.mode].filter(Boolean).join("  "),
      });
      if (ch.note) blocks.push({ kind: "line", text: ch.note, indent: 2 });
    }
    for (const cs of c.callsigns) {
      blocks.push({ kind: "kv", label: `${cs.person} callsign`, value: cs.sign });
    }
    if (c.schedule) blocks.push({ kind: "kv", label: "Listening", value: c.schedule });
    if (c.meshChannel) blocks.push({ kind: "kv", label: "Mesh channel", value: c.meshChannel });
    if (c.outOfArea) blocks.push({ kind: "kv", label: "Out-of-area contact", value: c.outOfArea });
  }

  if (ctx.kits.length) {
    blocks.push({ kind: "heading", text: "KIT" });
    for (const k of ctx.kits) {
      const i = kitIssues(k, ctx.now);
      const flags = [
        i.expired ? `${i.expired} EXPIRED` : "",
        i.soon ? `${i.soon} due` : "",
      ]
        .filter(Boolean)
        .join(", ");
      blocks.push({
        kind: "kv",
        label: k.name,
        value: `${i.have}/${i.total} packed${flags ? ` — ${flags}` : ""}`,
      });
    }
  }

  if (p.notes) {
    blocks.push({ kind: "heading", text: "NOTES" });
    blocks.push({ kind: "line", text: p.notes });
  }

  // Routes get their own page: the turn list is what you read while moving, and
  // it should not be interleaved with the things you read before you leave.
  if (p.routes.length) {
    blocks.push({ kind: "pagebreak" });
    p.routes.forEach((r, i) => blocks.push(...routeBlocks(r, i)));
  }

  blocks.push({ kind: "rule" });
  blocks.push({
    kind: "line",
    text:
      "Route overview from map data only: no turn restrictions, gates, private-road " +
      "or seasonal-closure information. Check the ground before you commit.",
  });

  return textToPdf({
    title: p.name,
    subtitle: `GridDown plan — printed ${date}`,
    blocks,
    paper: PAPERS.letter,
    footer: `${p.name} — ${date}`,
  });
}

/** Build it and put it somewhere the user can find. */
export async function printPlan(p: Plan, ctx: PlanPrintContext): Promise<void> {
  try {
    const bytes = planDocument(p, ctx);
    const safe = p.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plan";
    const path = await saveFile(`griddown-${safe}.pdf`, bytes, "application/pdf");
    // Only count it if it actually landed somewhere — same rule the backup
    // button uses, for the same reason.
    if (path !== null || !("__TAURI_INTERNALS__" in window)) {
      try {
        localStorage.setItem(PLAN_PDF_KEY, String(ctx.now));
      } catch {
        /* storage unavailable; the PDF still saved, which is what mattered */
      }
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : "Couldn't build the PDF.", "error", 7000);
  }
}
