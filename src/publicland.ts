// Public land — which unit you are standing in, who runs it, and what that
// lets you do.
//
// The question this answers is the one that matters off-grid: may I camp here,
// may I light a fire, may I hunt, and am I about to walk into somewhere I will
// be arrested for entering.
//
// Two facts about the map data shape everything below:
//
//   1. The basemap's `landuse` POLYGONS carry only `kind` and `sort_rank`.
//      They have no name at all. So the polygon can tell you "this is a nature
//      reserve" and nothing more.
//   2. The names live in the `pois` layer as separate POINTS — the same problem
//      lakes have, solved the same way (see landName() in main.ts).
//
// That name is worth recovering twice over, because in the US the *name* is the
// designation: "Three Sisters Wilderness" and "Deschutes National Forest" are
// both `kind=nature_reserve` or `kind=forest` to the extract, but they are run
// by different rules. So the name, when we have one, refines the polygon's
// coarse kind into something you can actually act on.
//
// The caveat is permanent and never softened. Designations in the OSM extract
// are coarse, unit rules change season to season, and "national forest" covers
// ground where dispersed camping is a right and ground where it is banned
// outright. Pure and offline; tested in tests/publicland.test.ts.

export type LandClass =
  | "national_park"
  | "protected_area"
  | "nature_reserve"
  | "park"
  | "forest"
  | "military";

/** What the unit's name tells us that its polygon kind cannot. */
export type Designation =
  | "wilderness"
  | "national_forest"
  | "national_park"
  | "national_monument"
  | "national_scenic"
  | "wildlife_refuge"
  | "state_park"
  | "state_forest"
  | "blm"
  | "local_park";

export type Access = "open" | "limited" | "permit" | "closed";

export interface LandInfo {
  /** What kind of public land this is — "Wilderness area", "National forest". */
  title: string;
  /** The unit itself — "Three Sisters Wilderness" — when the extract has it. */
  name: string;
  /** Who runs it, when the name makes that knowable. */
  manager: string;
  designation: Designation | null;
  access: Access;
  /** One line on what access means here. */
  accessNote: string;
  /** Short verdicts, keyed by the thing you want to do. */
  rules: { label: string; value: string; ok: boolean | null }[];
  /** What is worth knowing before you rely on the ground. */
  notes: string[];
  /** Always present. Never suppressed, never softened. */
  caveat: string;
}

const CAVEAT =
  "Land status comes from the offline map extract and can be coarse or out of " +
  "date. Boundaries, closures and permit rules change — verify with the managing " +
  "agency before you rely on this.";

/** Normalise the basemap's landuse `kind` onto the classes we can advise on. */
export function classify(kind: string): LandClass | null {
  const k = (kind || "").toLowerCase();
  if (k === "military" || k === "naval_base" || k === "airfield") return "military";
  if (k === "national_park") return "national_park";
  if (k === "protected_area") return "protected_area";
  if (k === "nature_reserve") return "nature_reserve";
  if (k === "park") return "park";
  if (k === "forest" || k === "wood") return "forest";
  return null;
}

/**
 * Read the designation out of the unit's name.
 *
 * In the US the name IS the legal status, and it is far more specific than the
 * polygon kind: "…Wilderness" means no vehicles and no bicycles, "…National
 * Forest" means dispersed camping is usually a right, "…State Park" means it
 * usually is not. Order matters — Wilderness is checked first because a
 * wilderness area sits inside a national forest and the inner rules are the
 * stricter ones.
 */
export function designationOf(name: string): Designation | null {
  const n = (name || "").toLowerCase();
  if (!n) return null;
  if (/\bwilderness\b/.test(n)) return "wilderness";
  if (/national wildlife refuge|\bwildlife refuge\b|\bwildlife area\b/.test(n)) return "wildlife_refuge";
  if (/national forest|\bnational grassland\b/.test(n)) return "national_forest";
  // NPS runs plenty of units that are not called "National Park" — historical
  // parks, historic sites, preserves. "Lewis and Clark National Historical Park"
  // is a real one from the Oregon extract, and it used to fall through to the
  // local-park rule below and be reported as a city park that closes at dusk.
  if (/national park\b|national historical park|national historic (park|site)|national preserve/.test(n))
    return "national_park";
  if (/national scenic area|national recreation area/.test(n)) return "national_scenic";
  if (/national monument|national seashore/.test(n)) return "national_monument";
  if (/state park|state recreation/.test(n)) return "state_park";
  if (/state forest/.test(n)) return "state_forest";
  if (/\bblm\b|bureau of land management|national conservation area/.test(n)) return "blm";
  // Last, and never for a federal or state unit: everything above has had its
  // chance, so a bare trailing "…Park" here really is a municipal one.
  if (!/\bnational\b|\bstate\b/.test(n) &&
      /\b(city|county|municipal|community|memorial|neighborhood)\b.*\bpark\b|\bpark\b$/.test(n))
    return "local_park";
  return null;
}

interface Profile {
  title: string;
  manager: string;
  access: Access;
  accessNote: string;
  rules: LandInfo["rules"];
  notes: string[];
}

const r = (label: string, value: string, ok: boolean | null) => ({ label, value, ok });

/** Guidance keyed on the designation — used whenever the name gives us one. */
const BY_DESIGNATION: Record<Designation, Profile> = {
  wilderness: {
    title: "Wilderness area",
    manager: "Federally designated wilderness",
    access: "limited",
    accessNote: "Open on foot. Nothing with a wheel or a motor, and often a permit.",
    rules: [
      r("Enter", "On foot", null),
      r("Camp", "Usually yes", null),
      r("Hunt", "Often, in season", null),
      r("Fire", "Check bans", null),
    ],
    notes: [
      "No vehicles, no bicycles, no carts, no motors or chainsaws of any kind — this is the rule people most often break by accident.",
      "Permits and group-size limits are common, and quotas apply on popular units in summer.",
      "Dispersed camping is normally allowed well away from trails and water — commonly 100–200 ft.",
      "No maintained facilities. Assume no water caches, no bridges, and no signage past the boundary.",
    ],
  },
  national_forest: {
    title: "National forest",
    manager: "US Forest Service",
    access: "open",
    accessNote: "Generally open, and dispersed camping is usually allowed.",
    rules: [
      r("Enter", "Yes", true),
      r("Camp", "Usually yes", null),
      r("Hunt", "In season", null),
      r("Fire", "Check bans", null),
    ],
    notes: [
      "Dispersed camping is typically allowed away from roads and water — commonly 100–200 ft — with a 14-day stay limit.",
      "Fire restrictions are seasonal and can be a total ban in late summer.",
      "Check the Forest roads overlay for which roads you may actually drive.",
    ],
  },
  national_park: {
    title: "National park",
    manager: "National Park Service",
    access: "permit",
    accessNote: "Open to visit, but backcountry use is regulated — camping normally needs a permit.",
    rules: [
      r("Enter", "Yes", true),
      r("Camp", "Permit", null),
      r("Hunt", "No", false),
      r("Fire", "Designated only", null),
    ],
    notes: [
      "Camping is confined to designated sites or permitted zones.",
      "Collecting plants, wood and antlers is prohibited.",
      "Hunting is banned in almost every national park.",
    ],
  },
  national_monument: {
    title: "National monument",
    manager: "Federal — NPS, BLM or Forest Service",
    access: "limited",
    accessNote: "Federally protected, but which agency runs it decides the rules.",
    rules: [
      r("Enter", "Yes", true),
      r("Camp", "Varies", null),
      r("Hunt", "Varies", null),
      r("Fire", "Check bans", null),
    ],
    notes: [
      "BLM-run monuments often allow dispersed camping; NPS-run ones usually do not.",
      "Collecting artefacts is a federal offence on all of them.",
    ],
  },
  national_scenic: {
    title: "National scenic area",
    manager: "Usually US Forest Service",
    access: "limited",
    accessNote:
      "Federally managed for its landscape, and usually more restrictive than the forest around it.",
    rules: [
      r("Enter", "Yes", true),
      r("Camp", "Designated areas", null),
      r("Hunt", "In season", null),
      r("Fire", "Check bans", null),
    ],
    notes: [
      "Dispersed camping is often restricted here even where the surrounding national forest allows it.",
      "Much of the land inside the boundary is privately owned — the designation is not a right of access.",
    ],
  },
  wildlife_refuge: {
    title: "Wildlife refuge",
    manager: "US Fish & Wildlife Service",
    access: "limited",
    accessNote: "Managed for wildlife first. Day use mostly, and seasonal closures are normal.",
    rules: [
      r("Enter", "Day use", null),
      r("Camp", "Usually no", false),
      r("Hunt", "Sometimes, in season", null),
      r("Fire", "No", false),
    ],
    notes: [
      "Closures for nesting, calving and migration shut large areas at short notice.",
      "Some refuges run managed hunts by permit — it is not a blanket ban.",
      "Good ground for water and game sign even where taking them is not allowed.",
    ],
  },
  state_park: {
    title: "State park",
    manager: "State parks agency",
    access: "open",
    accessNote: "Open to the public, but camping means a campground, not wherever you like.",
    rules: [
      r("Enter", "Yes", true),
      r("Camp", "Campground only", null),
      r("Hunt", "Usually no", false),
      r("Fire", "Rings only", null),
    ],
    notes: [
      "Drinking water and toilets are more likely here than anywhere else on the map.",
      "Day-use areas often close at dusk and are gated overnight.",
    ],
  },
  state_forest: {
    title: "State forest",
    manager: "State forestry agency",
    access: "open",
    accessNote: "Usually open, with rules closer to national forest than to a state park.",
    rules: [
      r("Enter", "Yes", true),
      r("Camp", "Often yes", null),
      r("Hunt", "In season", null),
      r("Fire", "Check bans", null),
    ],
    notes: [
      "Dispersed camping is often allowed but is more restricted than on national forest.",
      "Active logging areas may close roads without notice.",
    ],
  },
  blm: {
    title: "BLM land",
    manager: "Bureau of Land Management",
    access: "open",
    accessNote: "The most permissive public land there is — dispersed camping is generally allowed.",
    rules: [
      r("Enter", "Yes", true),
      r("Camp", "Usually yes", null),
      r("Hunt", "In season", null),
      r("Fire", "Check bans", null),
    ],
    notes: [
      "Dispersed camping is generally allowed for up to 14 days in one spot.",
      "Water is the limiting factor on most BLM ground — plan to carry it.",
      "Roads are often unmaintained and impassable when wet.",
    ],
  },
  local_park: {
    title: "Local park",
    manager: "City or county",
    access: "open",
    accessNote: "Open to the public, and almost always day use only.",
    rules: [
      r("Enter", "Yes", true),
      r("Camp", "No", false),
      r("Hunt", "No", false),
      r("Fire", "Grills only", null),
    ],
    notes: [
      "Drinking water and toilets are likely, which is the reason to come here.",
      "Usually closes at dusk and is often patrolled overnight.",
    ],
  },
};

/** Fallback guidance from the polygon kind alone, when there is no name. */
const BY_CLASS: Record<LandClass, Profile> = {
  military: {
    title: "Military land",
    manager: "Department of Defense",
    access: "closed",
    accessNote: "Keep out. Entry is prohibited and often enforced.",
    rules: [
      r("Enter", "No", false),
      r("Camp", "No", false),
      r("Hunt", "No", false),
      r("Fire", "No", false),
    ],
    notes: [
      "Live-fire and impact areas may be unmarked on the ground.",
      "Do not pick up ordnance or debris — unexploded munitions are a real hazard on old ranges.",
      "Route around the whole boundary, not to the edge of it.",
    ],
  },
  national_park: BY_DESIGNATION.national_park,
  forest: {
    title: "Forest",
    manager: "Ownership varies — could be federal, state or private",
    access: "limited",
    accessNote:
      "Unnamed on the map, so ownership is unknown. National forest is usually open; private forest is not.",
    rules: [
      r("Enter", "Unknown", null),
      r("Camp", "Unknown", null),
      r("Hunt", "Unknown", null),
      r("Fire", "Check bans", null),
    ],
    notes: [
      "The map extract carries no name for this polygon, so who owns it cannot be determined offline.",
      "Treat unknown forest as private until you have reason to think otherwise.",
      "Check the Forest roads overlay — a road with an MVUM designation means Forest Service ground.",
    ],
  },
  nature_reserve: {
    title: "Nature reserve",
    manager: "Protected area — manager unknown",
    access: "limited",
    accessNote: "Protected for habitat. Access is often day-use only and may be seasonal.",
    rules: [
      r("Enter", "Usually", null),
      r("Camp", "Usually no", false),
      r("Hunt", "Usually no", false),
      r("Fire", "No", false),
    ],
    notes: [
      "Seasonal closures for nesting or calving are common.",
      "Staying on trail matters more here than anywhere else.",
    ],
  },
  protected_area: {
    title: "Protected area",
    manager: "Manager unknown",
    access: "limited",
    accessNote: "A broad designation — could be wilderness, conservation land, or a state unit.",
    rules: [
      r("Enter", "Usually", null),
      r("Camp", "Varies", null),
      r("Hunt", "Varies", null),
      r("Fire", "Check bans", null),
    ],
    notes: [
      "If this turns out to be designated wilderness, expect no vehicles, bikes or motors of any kind.",
      "Group-size limits and permit quotas are common on popular units.",
    ],
  },
  park: {
    title: "Park",
    manager: "Usually city or county",
    access: "open",
    accessNote: "Open to the public, but usually day use — most parks close overnight.",
    rules: [
      r("Enter", "Yes", true),
      r("Camp", "Usually no", false),
      r("Hunt", "No", false),
      r("Fire", "Grills only", null),
    ],
    notes: [
      "Drinking water and toilets are more likely here than anywhere else on the map.",
      "City and county parks are often patrolled overnight.",
    ],
  },
};

/**
 * What is this ground, and what does it let me do?
 *
 * @param kind the landuse polygon's `kind` — all the polygon itself carries
 * @param name the unit name recovered from the `pois` layer, when there is one
 */
export function landInfo(kind: string, name = ""): LandInfo | null {
  const cls = classify(kind);
  if (!cls) return null;
  const clean = (name || "").trim();

  // Military is decided by the polygon and never softened by a friendly name.
  const desig = cls === "military" ? null : designationOf(clean);
  const p = desig ? BY_DESIGNATION[desig] : BY_CLASS[cls];

  return {
    title: p.title,
    name: clean,
    manager: p.manager,
    designation: desig,
    access: p.access,
    accessNote: p.accessNote,
    rules: p.rules,
    notes: p.notes,
    caveat: CAVEAT,
  };
}
