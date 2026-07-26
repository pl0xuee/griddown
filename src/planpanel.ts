import maplibregl from "maplibre-gl";
import { getVersion } from "@tauri-apps/api/app";
import {
  currentMarks,
  loadMarks,
  marksUnreadable,
  updateMarks,
  type Waypoint,
} from "./store";
import {
  freezeRoute,
  makePrimary,
  planBounds,
  planSummary,
  STOP_KINDS,
  type FrozenRoute,
  type LL,
  type Plan,
  type PlanStop,
  type StopKind,
} from "./plan";
import {
  emptyComms,
  medicalLine,
  type CommsPlan,
  type Person,
} from "./roster";
import { computePadding, safeAreaInsets, visibleBox } from "./fitmap";
import { printPlan } from "./planprint";
import { OVERPRINT, OVERPRINT_CASING, OVERPRINT_LIFT } from "./overprint";
import { chooseAction, confirmAction, promptAction } from "./dialog";
import { esc } from "./esc";
import { toast } from "./toast";

// The Plan panel — where the decisions live.
//
// Everything else in this app answers a question you ask while standing in the
// weather. This answers the one you should have asked at the kitchen table:
// where do we go, how do we get there, what if that way is shut, and where do we
// meet if we're apart. It is the only panel meant to be filled in on a day when
// nothing is wrong.
//
// The routes it holds are FROZEN (see plan.ts): the geometry and the turn list
// are stored, not recomputed. A plan therefore draws with the map pack deleted,
// with no signal, and without the router running at all — which is the whole
// point, because the day you need it is the day none of those are available.

const SRC = "gd-plan";
const CASING = "gd-plan-casing";
const ALT = "gd-plan-line-alt";
const LINE = "gd-plan-line";

interface Deps {
  map: () => maplibregl.Map;
  /** Which pack is active — recorded on a route so we can say what it came from. */
  activeAbbr?: () => string;
}

let deps: Deps | null = null;
let plans: Plan[] = [];
/** The plan whose detail view is showing; null means the list. */
let openId: string | null = null;
/** The plan currently drawn on the map. Survives closing the panel. */
let shownId: string | null = null;
let markers: maplibregl.Marker[] = [];
let appVersion = "dev";
/**
 * The plan that sent you to Get there, so the route you work out there comes
 * back here without being asked which plan it belonged to. Cleared once used —
 * a route computed later, off your own bat, should still ask.
 */
let awaitingRouteFor: string | null = null;
// The roster and comms plan belong to the household, not to any one plan — the
// same people and the same radio channel apply whichever way you leave.
let roster: Person[] = [];
let comms: CommsPlan | null = null;

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

const MI = 1609.344;
function miles(m: number): string {
  const mi = m / MI;
  return mi < 10 ? mi.toFixed(1) : String(Math.round(mi));
}

function dateText(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const KIND_LABEL: Record<StopKind, string> = {
  rally: "Rally point",
  cache: "Cache",
  fuel: "Fuel",
  water: "Water",
  shelter: "Shelter",
  medical: "Medical",
  avoid: "Avoid",
};

/** What each kind is for, shown under its name when you pick one. The words
 *  are the point: "cache" means nothing until you are told it is a thing you
 *  left behind on purpose. */
const KIND_DETAIL: Record<StopKind, string> = {
  rally: "Where you meet if you get separated.",
  cache: "Something you left here on purpose.",
  fuel: "Petrol, diesel, gas, charging.",
  water: "A source you have actually seen.",
  shelter: "Somewhere you could stop the night.",
  medical: "Clinic, pharmacy, someone who can help.",
  avoid: "Ground to stay off. Bridges, chokepoints, floodplain.",
};

/**
 * One monochrome glyph per kind.
 *
 * Every one of these is a plain geometric character with no emoji presentation.
 * U+26FD ⛽ is the obvious mark for fuel and is the one thing here that must not
 * be used: it is emoji-presentation by default, so it arrives as a red-and-white
 * colour pictograph in a chrome that is achromatic on purpose (see the top of
 * styles.css) — and colour in this app is reserved for things that mean
 * something. A hexagon says nothing on its own, which is the point; the colour
 * of the marker and the label beside it carry the meaning.
 */
const KIND_GLYPH: Record<StopKind, string> = {
  rally: "◎",
  cache: "▣",
  fuel: "⬢",
  water: "≈",
  shelter: "⌂",
  medical: "✚",
  avoid: "✕",
};

// --- Persistence -------------------------------------------------------------

async function persist(): Promise<void> {
  try {
    // A patch: this module owns plans, the roster and the comms plan — and
    // nothing else. See store.ts for why that matters.
    await updateMarks({ plans, roster, comms });
  } catch (e) {
    toast(e instanceof Error ? e.message : "Couldn't save your plans.", "error", 7000);
  }
}

function findPlan(id: string | null): Plan | undefined {
  return plans.find((p) => p.id === id);
}

function replacePlan(next: Plan) {
  plans = plans.map((p) => (p.id === next.id ? next : p));
}

// --- Map drawing -------------------------------------------------------------

function clearDrawn() {
  const map = deps?.map();
  if (!map) return;
  for (const id of [LINE, ALT, CASING]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SRC)) map.removeSource(SRC);
  for (const m of markers) m.remove();
  markers = [];
}

function stopMarker(map: maplibregl.Map, s: PlanStop) {
  const el = document.createElement("div");
  el.className = `plan-stop plan-stop--${s.kind}`;
  el.textContent = KIND_GLYPH[s.kind];
  el.title = `${KIND_LABEL[s.kind]}: ${s.name}`;
  const m = new maplibregl.Marker({ element: el, anchor: "center" })
    .setLngLat([s.lng, s.lat])
    .addTo(map);
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    toast(`${KIND_LABEL[s.kind]} — ${s.name}${s.note ? `: ${s.note}` : ""}`, "info", 6000);
  });
  markers.push(m);
}

/** Draw a plan: primary route solid, alternates dashed, stops as markers. */
function drawPlan(p: Plan) {
  const map = deps?.map();
  if (!map) return;
  clearDrawn();
  shownId = p.id;

  const features: GeoJSON.Feature[] = p.routes
    .filter((r) => r.coords.length > 1)
    .map((r, i) => ({
      type: "Feature",
      properties: { primary: i === 0, name: r.name },
      geometry: { type: "LineString", coordinates: r.coords },
    }));

  if (features.length) {
    map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features } });
    // Under the first symbol layer, so place labels stay readable over the line.
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    map.addLayer(
      {
        id: CASING,
        type: "line",
        source: SRC,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": OVERPRINT_CASING, "line-width": 8, "line-opacity": 0.85 },
      },
      firstSymbol
    );
    // Alternates are the lifted hue and dashed — the same distinction tracks
    // use against routes, so "the line I mean" is always the solid one.
    map.addLayer(
      {
        id: ALT,
        type: "line",
        source: SRC,
        filter: ["!=", ["get", "primary"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": OVERPRINT_LIFT,
          "line-width": 3,
          "line-dasharray": [2.5, 1.5],
        },
      },
      firstSymbol
    );
    map.addLayer(
      {
        id: LINE,
        type: "line",
        source: SRC,
        filter: ["==", ["get", "primary"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": OVERPRINT, "line-width": 4 },
      },
      firstSymbol
    );
  }

  for (const s of p.stops) stopMarker(map, s);
}

function fitPlan(p: Plan) {
  const map = deps?.map();
  const b = planBounds(p);
  if (!map || !b) return;
  const bounds = new maplibregl.LngLatBounds(b[0], b[1]);
  if (b[1][0] - b[0][0] < 1e-6 && b[1][1] - b[0][1] < 1e-6) {
    map.easeTo({ center: b[0], zoom: Math.max(map.getZoom(), 14), duration: 600 });
    return;
  }
  map.fitBounds(bounds, {
    padding: computePadding({
      canvas: map.getCanvas().getBoundingClientRect(),
      bottom: [
        visibleBox(document.getElementById("dock")),
        visibleBox(document.getElementById("route-recalc")),
        visibleBox(document.getElementById("map-legend")),
      ],
      panel: visibleBox(document.getElementById("plan-panel")),
      insets: safeAreaInsets(),
    }),
    duration: 600,
  });
}

// --- Rendering ---------------------------------------------------------------

function panelBody(): HTMLElement | null {
  return document.getElementById("plan-body");
}

function renderList() {
  const el = panelBody();
  if (!el) return;
  if (marksUnreadable()) {
    el.innerHTML = `<div class="pn-empty">Your saved data couldn't be read, so this
      list may be wrong. Restart the app before changing anything — see Readiness.</div>`;
    return;
  }
  const rows = plans
    .map((p) => {
      const s = planSummary(p);
      const dist = s.primaryMeters == null ? "no route yet" : `${miles(s.primaryMeters)} mi`;
      const alt = s.alternates ? ` · ${s.alternates} alternate${s.alternates > 1 ? "s" : ""}` : "";
      const stops = s.stops ? ` · ${s.stops} stop${s.stops > 1 ? "s" : ""}` : "";
      // The whole row opens the plan, as the Kit rows do — a target you can hit
      // with a cold thumb beats a button you have to aim at.
      return `<div class="pn-row pn-row--tap" data-open="${esc(p.id)}">
          <div class="pn-info">
            <div class="pn-name">◈ ${esc(p.name)}</div>
            <div class="pn-sub">${esc(p.destination || "no destination set")}</div>
            <div class="pn-sub">${dist}${alt}${stops}</div>
          </div>
          <div class="pn-chev">›</div>
        </div>`;
    })
    .join("");

  el.innerHTML = `
    <div class="pn-actions">
      <button id="pn-new" type="button">＋ New plan</button>
      ${shownId ? `<button id="pn-hide" type="button">Clear from map</button>` : ""}
    </div>
    ${
      rows ||
      `<div class="pn-empty">No plans yet.
        <p>A plan is where you are going, how you get there, what you do if that
        way is shut, and where you meet if you are apart — written down on a day
        when nothing is wrong.</p>
        <p>Work out a route in <b>Get there</b> and press <b>Save to plan</b>, or
        start one here and add the route later.</p></div>`
    }
    ${renderRoster()}
    ${renderComms()}
    <div class="pn-fine">Saved on this device only. Routes are stored as computed —
    they redraw with no signal and no map pack.</div>`;
}

function renderRoster(): string {
  const rows = roster
    .map((p) => {
      const med = medicalLine(p);
      return `<div class="pn-row">
        <div class="pn-info">
          <div class="pn-name">● ${esc(p.name)}${
            p.role ? ` <span class="pn-role">${esc(p.role)}</span>` : ""
          }</div>
          ${med ? `<div class="pn-med">${esc(med)}</div>` : ""}
          ${p.contact ? `<div class="pn-sub">${esc(p.contact)}</div>` : ""}
        </div>
        <button class="pn-btn" data-editperson="${esc(p.id)}" type="button">Edit</button>
        <button class="pn-del" data-delperson="${esc(p.id)}" type="button" aria-label="Remove">✕</button>
      </div>`;
    })
    .join("");
  return `<div class="pn-group">Who's with you</div>
    <div class="pn-actions"><button id="pn-addperson" type="button">＋ Add a person</button></div>
    ${
      rows ||
      `<div class="pn-empty">Names, roles, and the medical facts a stranger would
       need — blood group, allergies, medication, conditions. These are exactly
       the things nobody can look up on the day.</div>`
    }`;
}

function renderComms(): string {
  const c = comms;
  const channels = (c?.channels ?? [])
    .map(
      (ch, i) => `<div class="pn-row">
        <div class="pn-info">
          <div class="pn-name">${esc(ch.label)}</div>
          <div class="pn-freq">${esc(ch.freq || "—")}${ch.mode ? ` · ${esc(ch.mode)}` : ""}</div>
          ${ch.note ? `<div class="pn-sub">${esc(ch.note)}</div>` : ""}
        </div>
        <button class="pn-del" data-delchannel="${i}" type="button" aria-label="Remove">✕</button>
      </div>`
    )
    .join("");
  return `<div class="pn-group">Comms</div>
    <div class="pn-actions">
      <button id="pn-addchannel" type="button">＋ Add a channel</button>
      <button id="pn-schedule" type="button">Listening schedule</button>
      <button id="pn-outofarea" type="button">Out-of-area contact</button>
    </div>
    ${channels || `<div class="pn-empty">Channels and frequencies you agreed in advance.</div>`}
    ${
      c?.schedule
        ? `<div class="pn-note">Schedule: ${esc(c.schedule)}</div>`
        : `<div class="pn-empty">No listening schedule — two radios that are never
           on together never meet.</div>`
    }
    ${
      c?.outOfArea
        ? `<div class="pn-note">Out-of-area contact: ${esc(c.outOfArea)}</div>`
        : `<div class="pn-empty">No out-of-area contact. Local lines fail and
           congest together; one distant person everyone calls is how a scattered
           group finds itself again.</div>`
    }
    <div class="pn-fine">The Team mesh panel talks to a Meshtastic radio — set the
    same channel there.</div>`;
}

function routeCard(r: FrozenRoute, i: number): string {
  const steps = r.steps
    .filter((s) => s.meters > 40)
    .slice(0, 12)
    .map(
      (s) =>
        `<div class="pn-step"><span>${esc(s.name)}</span><span>${miles(s.meters)} mi</span></div>`
    )
    .join("");
  return `<div class="pn-route${i === 0 ? " primary" : ""}">
      <div class="pn-route-head">
        <div>
          <div class="pn-route-name">${i === 0 ? "▶ " : "⋯ "}${esc(r.name)}</div>
          <div class="pn-sub">${miles(r.meters)} mi${r.usedTrail ? " · uses a trail" : ""}${
            r.drawn ? " · drawn by hand" : ""
          }</div>
          <div class="pn-prov">frozen ${dateText(r.computedAt)}${
            r.pack ? ` from the ${esc(r.pack)} pack` : ""
          } · v${esc(r.appVersion)}</div>
        </div>
        <div class="pn-route-btns">
          ${i === 0 ? "" : `<button class="pn-btn" data-primary="${esc(r.id)}" type="button">Make primary</button>`}
          <button class="pn-del" data-delroute="${esc(r.id)}" type="button" aria-label="Delete route">✕</button>
        </div>
      </div>
      ${
        r.drawn
          ? `<div class="pn-note">Hand-drawn — no turn list. Follows what you tapped, not the road network.</div>`
          : `<div class="pn-steps">${steps || `<div class="pn-step"><span>Unnamed roads the whole way</span></div>`}</div>`
      }
    </div>`;
}

function renderDetail(p: Plan) {
  const el = panelBody();
  if (!el) return;
  const stops = p.stops
    .map(
      (s) => `<div class="pn-row" data-stop="${esc(s.id)}">
        <div class="pn-info">
          <div class="pn-name">${KIND_GLYPH[s.kind]} ${esc(s.name)}</div>
          <div class="pn-sub">${KIND_LABEL[s.kind]} · ${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}</div>
          ${s.note ? `<div class="pn-sub">${esc(s.note)}</div>` : ""}
        </div>
        <button class="pn-btn" data-gostop="${esc(s.id)}" type="button">Show</button>
        <button class="pn-del" data-delstop="${esc(s.id)}" type="button" aria-label="Delete stop">✕</button>
      </div>`
    )
    .join("");

  const triggers = p.triggers
    .map(
      (t, i) => `<div class="pn-trigger">
        <span>${esc(t)}</span>
        <button class="pn-del" data-deltrigger="${i}" type="button" aria-label="Delete trigger">✕</button>
      </div>`
    )
    .join("");

  el.innerHTML = `
    <button id="pn-back" class="pn-back" type="button">
      <span class="pn-back-chev" aria-hidden="true">‹</span> All plans
    </button>
    <div class="pn-title-row">
      <div>
        <div class="pn-name">◈ ${esc(p.name)}</div>
        <div class="pn-sub">to ${esc(p.destination || "—")}</div>
      </div>
      <button class="pn-btn" id="pn-rename" type="button">Rename</button>
    </div>

    <div class="pn-actions">
      <button id="pn-show" type="button">Show on map</button>
      <button id="pn-addroute" type="button">→ Add a route</button>
      <button id="pn-print" type="button">⎙ Print to paper</button>
    </div>

    <div class="pn-group">Routes</div>
    ${
      p.routes.length
        ? p.routes.map(routeCard).join("")
        : `<div class="pn-empty">No route yet. <b>Add a route</b> opens Get there;
           work out the way, then press <b>Save to plan</b> and it lands here.</div>`
    }
    ${
      p.routes.length === 1
        ? `<div class="pn-warn">⚠ No alternate. One blocked bridge and this plan is
           gone — add a second route that doesn't share the same failure.</div>`
        : ""
    }

    <div class="pn-group">Stops</div>
    <div class="pn-actions">
      <button id="pn-addstop" type="button">＋ Add at crosshair</button>
      <button id="pn-tomarks" type="button">Add stops to my marks</button>
    </div>
    ${stops || `<div class="pn-empty">Rally points, caches, fuel, water — the places
      the route is really about.</div>`}

    <div class="pn-group">If you're apart</div>
    <div class="pn-actions"><button id="pn-rally" type="button">${
      p.rally ? "Edit the rule" : "＋ Set the rule"
    }</button></div>
    ${
      p.rally
        ? `<div class="pn-note">${esc(p.rally)}</div>`
        : `<div class="pn-empty">One sentence, agreed in advance — "if you're not
           at the trailhead by 18:00, go on to the cabin and wait". A rule
           everybody knows beats a phone call nobody can make.</div>`
    }

    <div class="pn-group">Go / no-go</div>
    <div class="pn-actions"><button id="pn-addtrigger" type="button">＋ Add a condition</button></div>
    ${
      triggers ||
      `<div class="pn-empty">The conditions that mean you leave, decided now rather
       than at 3am — "power out more than 72 hours", "water off", "told to go".</div>`
    }

    <div class="pn-group">Notes</div>
    <div class="pn-actions"><button id="pn-notes" type="button">${
      p.notes ? "Edit notes" : "＋ Add notes"
    }</button></div>
    ${p.notes ? `<div class="pn-notes">${esc(p.notes)}</div>` : ""}

    <!-- Last, and on its own. Sharing the top row made deleting the plan the
         largest, most prominent control on the screen — which is precisely
         backwards for the one action here that cannot be undone. -->
    <div class="pn-danger-row">
      <button id="pn-delete" type="button" class="pn-danger">Delete this plan</button>
    </div>`;
}

/** Which screen was last drawn — see render(). */
let lastView = "";

/**
 * Redraw, keeping your place. Rebuilding innerHTML resets scrollTop, which on a
 * long plan throws you back to the top every time you add a trigger or delete a
 * stop. Same reasoning as kitpanel.ts.
 */
function render() {
  const el = panelBody();
  const p = findPlan(openId);
  const view = p ? `detail:${p.id}` : "list";
  const keep = view === lastView ? (el?.scrollTop ?? 0) : 0;

  if (p) renderDetail(p);
  else {
    openId = null;
    renderList();
  }

  lastView = view;
  if (el) el.scrollTop = keep;
}

// --- Actions -----------------------------------------------------------------

async function newPlan(): Promise<Plan | null> {
  const name = await promptAction("Name this plan", {
    placeholder: "Home → cabin",
    okLabel: "Create",
  });
  if (!name?.trim()) return null;
  const dest =
    (await promptAction("Where does it end up?", { placeholder: "the cabin" })) || "";
  const p: Plan = {
    id: rid(),
    name: name.trim(),
    destination: dest.trim(),
    routes: [],
    stops: [],
    triggers: [],
    t: Date.now(),
  };
  plans = plans.concat(p);
  await persist();
  return p;
}

async function addStopAtCrosshair(p: Plan) {
  const map = deps?.map();
  if (!map) return;
  const c = map.getCenter();
  const name = await promptAction("What is here?", { placeholder: "Trailhead" });
  if (!name?.trim()) return;
  const kind = await chooseAction(
    "What kind of stop?",
    STOP_KINDS.map((k) => ({
      label: `${KIND_GLYPH[k]}  ${KIND_LABEL[k]}`,
      value: k,
      detail: KIND_DETAIL[k],
    }))
  );
  if (!kind) return;
  const stop: PlanStop = {
    id: rid(),
    name: name.trim(),
    lat: c.lat,
    lng: c.lng,
    kind,
  };
  replacePlan({ ...p, stops: p.stops.concat(stop) });
  await persist();
  render();
  if (shownId === p.id) drawPlan(findPlan(p.id)!);
}

/** Copy the plan's stops into the Marks panel, so they draw with the pins and
 *  leave in a GPX export. The plan keeps its own copy either way. */
async function stopsToMarks(p: Plan) {
  if (!p.stops.length) {
    toast("No stops to add yet.");
    return;
  }
  const existing = currentMarks().waypoints;
  const fresh = p.stops.filter((s) => !s.wpId);
  if (!fresh.length) {
    toast("Those stops are already on your map.");
    return;
  }
  const added: Waypoint[] = fresh.map((s) => ({
    id: rid(),
    name: `${p.name}: ${s.name}`,
    lat: s.lat,
    lng: s.lng,
    note: `${KIND_LABEL[s.kind]}${s.note ? ` — ${s.note}` : ""}`,
    t: Date.now(),
  }));
  const stops = p.stops.map((s) => {
    const i = fresh.indexOf(s);
    return i === -1 ? s : { ...s, wpId: added[i].id };
  });
  replacePlan({ ...p, stops });
  try {
    // Two slices in one write: the plan (now carrying wpId links) and the
    // waypoints. Going through updateMarks keeps everyone else's data intact.
    await updateMarks({ plans, waypoints: existing.concat(added) });
    toast(`Added ${added.length} stop(s) to your marks.`, "success");
    // The Marks panel holds its own copy of the waypoints.
    document.dispatchEvent(new CustomEvent("griddown:marks-changed"));
  } catch (e) {
    toast(e instanceof Error ? e.message : "Couldn't save.", "error", 7000);
  }
  render();
}

/**
 * Add or edit a person. Asked field by field through the app's own dialog,
 * because window.prompt does nothing at all on iOS — see dialog.ts.
 */
async function editPerson(id: string | null) {
  const existing = id ? roster.find((x) => x.id === id) : undefined;
  const ask = (q: string, value?: string, placeholder?: string) =>
    promptAction(q, { value: value ?? "", placeholder });

  const name = await ask("Name", existing?.name, "Sam");
  if (!name?.trim()) return;
  const role = await ask("Role, if any", existing?.role, "driver, medic, has the dog");
  const blood = await ask("Blood group", existing?.blood, "O+");
  const allergies = await ask("Allergies", existing?.allergies, "penicillin — or 'none known'");
  const meds = await ask("Medication", existing?.meds, "what, and the dose");
  const conditions = await ask("Conditions", existing?.conditions, "asthma, diabetes");
  const contact = await ask("How to reach them", existing?.contact, "phone, callsign");

  const person: Person = {
    id: existing?.id ?? rid(),
    name: name.trim(),
    role: (role ?? "").trim() || undefined,
    blood: (blood ?? "").trim() || undefined,
    allergies: (allergies ?? "").trim() || undefined,
    meds: (meds ?? "").trim() || undefined,
    conditions: (conditions ?? "").trim() || undefined,
    contact: (contact ?? "").trim() || undefined,
    t: existing?.t ?? Date.now(),
  };
  roster = existing
    ? roster.map((x) => (x.id === person.id ? person : x))
    : roster.concat(person);
  await persist();
  render();
}

/**
 * Save a route computed by Get there into a plan.
 *
 * Called from route.ts, which owns the computation and knows nothing about
 * plans. Everything needed to redraw the line later is copied here and then
 * frozen — route.ts's own copy is discarded the moment the panel is cleared.
 */
export async function saveRouteToPlan(h: {
  result: {
    coords: LL[];
    meters: number;
    steps: { name: string; meters: number }[];
    usedTrail: boolean;
  };
  from: { lat: number; lng: number; label: string };
  to: { lat: number; lng: number; label: string };
  pack: string;
}): Promise<void> {
  let target: Plan | undefined;
  // Came here from a plan's "Add a route"? Then the question has already been
  // answered, and asking it again is just a button to press.
  const sentFrom = awaitingRouteFor ? findPlan(awaitingRouteFor) : undefined;
  awaitingRouteFor = null;
  if (sentFrom) {
    target = sentFrom;
  } else if (!plans.length) {
    // Nothing to choose between — go straight to making one.
    target = (await newPlan()) ?? undefined;
    if (!target) return;
  } else {
    const picked = await chooseAction<Plan | "new">("Add this route to which plan?", [
      ...plans.map((p) => ({
        label: p.name,
        value: p as Plan | "new",
        detail: p.routes.length
          ? `${p.routes.length} route${p.routes.length === 1 ? "" : "s"} already`
          : "no route yet",
      })),
      { label: "＋ New plan", value: "new" as const },
    ]);
    if (picked == null) return;
    target = picked === "new" ? ((await newPlan()) ?? undefined) : picked;
    if (!target) return;
  }
  const suggested = target.routes.length ? `Alternate ${target.routes.length}` : "Primary";
  const name = await promptAction("Name this route", { value: suggested, okLabel: "Save" });
  if (name == null) return;

  const r = freezeRoute(h.result, {
    id: rid(),
    name: name.trim() || suggested,
    from: h.from,
    to: h.to,
    pack: h.pack,
    appVersion,
    now: Date.now(),
  });
  replacePlan({ ...target, routes: target.routes.concat(r) });
  await persist();
  toast(`Saved to "${target.name}".`, "success");
  openId = target.id;
  render();
}

// --- Wiring ------------------------------------------------------------------

function onBodyClick(e: MouseEvent) {
  const t = (e.target as HTMLElement | null)?.closest?.(
    "button, [data-open]"
  ) as HTMLElement | null;
  if (!t) return;
  const p = findPlan(openId);

  if (t.id === "pn-new") {
    void newPlan().then((made) => {
      if (made) openId = made.id;
      render();
    });
    return;
  }
  if (t.id === "pn-hide") {
    clearDrawn();
    shownId = null;
    render();
    return;
  }
  const open = t.dataset.open;
  if (open) {
    openId = open;
    render();
    return;
  }

  // --- Roster and comms: household-level, so they live on the list view ---
  if (t.id === "pn-addperson") {
    void editPerson(null);
    return;
  }
  const editPersonId = t.dataset.editperson;
  if (editPersonId) {
    void editPerson(editPersonId);
    return;
  }
  const delPerson = t.dataset.delperson;
  if (delPerson) {
    void (async () => {
      const who = roster.find((x) => x.id === delPerson);
      if (!(await confirmAction(`Remove ${who?.name ?? "this person"} from the roster?`))) return;
      roster = roster.filter((x) => x.id !== delPerson);
      await persist();
      render();
    })();
    return;
  }
  if (t.id === "pn-addchannel") {
    void (async () => {
      const label = await promptAction("Name this channel", {
        placeholder: "Primary, or GMRS 15",
      });
      if (!label?.trim()) return;
      const freq = await promptAction("Frequency or channel number", {
        placeholder: "146.520",
      });
      const mode = await promptAction("Mode", { placeholder: "FM simplex" });
      comms = {
        ...(comms ?? emptyComms()),
        channels: (comms?.channels ?? []).concat({
          label: label.trim(),
          freq: (freq ?? "").trim() || undefined,
          mode: (mode ?? "").trim() || undefined,
        }),
      };
      await persist();
      render();
    })();
    return;
  }
  const delChannel = t.dataset.delchannel;
  if (delChannel != null && comms) {
    const i = Number(delChannel);
    comms = { ...comms, channels: comms.channels.filter((_, n) => n !== i) };
    void persist().then(render);
    return;
  }
  if (t.id === "pn-schedule") {
    void (async () => {
      const s = await promptAction("When is everyone listening?", {
        value: comms?.schedule ?? "",
        placeholder: "Listen at :00 and :30, transmit at :05",
      });
      if (s == null) return;
      comms = { ...(comms ?? emptyComms()), schedule: s.trim() || undefined };
      await persist();
      render();
    })();
    return;
  }
  if (t.id === "pn-outofarea") {
    void (async () => {
      const s = await promptAction("Who does everyone call, outside the area?", {
        value: comms?.outOfArea ?? "",
        placeholder: "Aunt Ruth — 555 0100",
      });
      if (s == null) return;
      comms = { ...(comms ?? emptyComms()), outOfArea: s.trim() || undefined };
      await persist();
      render();
    })();
    return;
  }

  if (!p) return;

  if (t.id === "pn-back") {
    openId = null;
    render();
    return;
  }
  if (t.id === "pn-show") {
    drawPlan(p);
    fitPlan(p);
    return;
  }
  if (t.id === "pn-addroute") {
    // Hand the job to the thing that already does it. Get there knows about
    // one-way streets, road classes and the Forest Service overlay; a line
    // drawn with a fingertip knows none of that and looks just as authoritative
    // on the map.
    awaitingRouteFor = p.id;
    document.getElementById("plan-panel")?.classList.add("hidden");
    document.getElementById("route-open")?.click();
    toast("Work out the route, then press Save to plan.", "info", 6000);
    return;
  }
  if (t.id === "pn-rename") {
    void (async () => {
      const name = await promptAction("Rename this plan", { value: p.name });
      if (!name?.trim()) return;
      const dest = await promptAction("Where does it end up?", { value: p.destination });
      replacePlan({ ...p, name: name.trim(), destination: (dest ?? p.destination).trim() });
      await persist();
      render();
    })();
    return;
  }
  if (t.id === "pn-delete") {
    void (async () => {
      const ok = await confirmAction(
        `Delete "${p.name}"? Its routes, stops and conditions go with it.`
      );
      if (!ok) return;
      plans = plans.filter((x) => x.id !== p.id);
      if (shownId === p.id) {
        clearDrawn();
        shownId = null;
      }
      openId = null;
      await persist();
      render();
    })();
    return;
  }
  if (t.id === "pn-addstop") {
    void addStopAtCrosshair(p);
    return;
  }
  if (t.id === "pn-tomarks") {
    void stopsToMarks(p);
    return;
  }
  if (t.id === "pn-print") {
    void printPlan(p, {
      roster,
      comms,
      kits: currentMarks().kits,
      now: Date.now(),
    });
    return;
  }
  if (t.id === "pn-rally") {
    void (async () => {
      const text = await promptAction("What happens if you're not together?", {
        value: p.rally ?? "",
        placeholder: "Not at the trailhead by 18:00 → go on to the cabin",
      });
      if (text == null) return;
      replacePlan({ ...p, rally: text.trim() || undefined });
      await persist();
      render();
    })();
    return;
  }
  if (t.id === "pn-addtrigger") {
    void (async () => {
      const text = await promptAction("What condition means you go?", {
        placeholder: "Power out more than 72 hours",
      });
      if (!text?.trim()) return;
      replacePlan({ ...p, triggers: p.triggers.concat(text.trim()) });
      await persist();
      render();
    })();
    return;
  }
  if (t.id === "pn-notes") {
    void (async () => {
      const text = await promptAction("Notes for this plan", { value: p.notes ?? "" });
      if (text == null) return;
      replacePlan({ ...p, notes: text.trim() || undefined });
      await persist();
      render();
    })();
    return;
  }

  const primary = t.dataset.primary;
  if (primary) {
    replacePlan(makePrimary(p, primary));
    void persist().then(() => {
      render();
      if (shownId === p.id) drawPlan(findPlan(p.id)!);
    });
    return;
  }
  const delRoute = t.dataset.delroute;
  if (delRoute) {
    void (async () => {
      const r = p.routes.find((x) => x.id === delRoute);
      const ok = await confirmAction(`Delete the route "${r?.name ?? ""}"?`);
      if (!ok) return;
      replacePlan({ ...p, routes: p.routes.filter((x) => x.id !== delRoute) });
      await persist();
      render();
      if (shownId === p.id) drawPlan(findPlan(p.id)!);
    })();
    return;
  }
  const goStop = t.dataset.gostop;
  if (goStop) {
    const s = p.stops.find((x) => x.id === goStop);
    if (s) deps?.map().easeTo({ center: [s.lng, s.lat], zoom: 14, duration: 600 });
    return;
  }
  const delStop = t.dataset.delstop;
  if (delStop) {
    replacePlan({ ...p, stops: p.stops.filter((x) => x.id !== delStop) });
    void persist().then(() => {
      render();
      if (shownId === p.id) drawPlan(findPlan(p.id)!);
    });
    return;
  }
  const delTrigger = t.dataset.deltrigger;
  if (delTrigger != null) {
    const i = Number(delTrigger);
    replacePlan({ ...p, triggers: p.triggers.filter((_, n) => n !== i) });
    void persist().then(render);
    return;
  }
}

export function initPlan(d: Deps) {
  deps = d;
  const panel = document.getElementById("plan-panel");

  void getVersion()
    .then((v) => {
      appVersion = v;
    })
    .catch(() => {
      /* browser dev — "dev" is honest */
    });

  void loadMarks().then((m) => {
    plans = m.plans;
    roster = m.roster;
    comms = m.comms;
    render();
  });

  document.getElementById("plan-open")?.addEventListener("click", () => {
    panel?.classList.remove("hidden");
    render();
  });
  document.getElementById("plan-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });
  panelBody()?.addEventListener("click", onBodyClick);

  // A restore replaces what's on disk under us — re-read rather than keep
  // showing plans that are no longer there.
  document.addEventListener("griddown:marks-changed", () => {
    const m = currentMarks();
    plans = m.plans;
    roster = m.roster;
    comms = m.comms;
    if (shownId && !findPlan(shownId)) {
      clearDrawn();
      shownId = null;
    }
    render();
  });

  // A theme switch rebuilds the style and drops the source and layers with it.
  d.map().on("style.load", () => {
    const p = findPlan(shownId);
    if (p) drawPlan(p);
  });
}
