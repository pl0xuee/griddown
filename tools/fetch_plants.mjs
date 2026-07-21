#!/usr/bin/env node
// Build public/plants.json from tools/plants-curated.json + USDA PLANTS.
//
//   node tools/fetch_plants.mjs            # data only, no image download
//   node tools/fetch_plants.mjs --images   # also fetch public-domain photos
//
// The split matters: the curated file is human judgement (is it edible, what
// kills you, what is it confused with) and this tool only adds facts (where it
// grows, what it looks like). Never hand-edit the output.
//
// Two things this tool will not do:
//
//   * It will not download a copyrighted image. USDA's image gallery mixes
//     public-domain USDA photographs with images whose photographers retain
//     copyright — of the ten pictures of water hemlock, six are copyrighted.
//     The API exposes a per-image `Copyright` boolean and we honour it, because
//     this app is redistributed as a binary.
//
//   * It will not take a Wikimedia image unless the licence is Public Domain,
//     CC0 or "No restrictions". Commons is mostly CC BY-SA, which is share-alike
//     and a different proposition for a bundled binary, so those are skipped
//     even though they are freely viewable. Used only for the six entries USDA
//     cannot supply: fungi are absent from PLANTS entirely, and every skunk
//     cabbage photograph there is copyrighted.
//
//   * It will not invent distribution. USDA's per-state export covers 18 states;
//     for the rest we record nothing rather than guessing, and the app treats an
//     empty range as "unknown, show it anyway" rather than "absent".
//
// Presence is matched at GENUS level on purpose. If any Cicuta grows in Oregon
// then water hemlock is a hazard in Oregon, and narrowing that to one species
// would drop real risk on a technicality.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const API = "https://plantsservices.sc.egov.usda.gov/api";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
/** Licences we will redistribute inside a shipped binary. Nothing share-alike. */
const FREE_LICENCES = /^(public domain|cc0|no restrictions)/i;
/**
 * Commons categories are not photo albums. A species category holds postage
 * stamps, Victorian engravings, spore diagrams, distribution maps and herbarium
 * sheets alongside the field photographs — the first pass pulled a Belarusian
 * postage stamp as a picture of a puffball, and an 1800s plate as a morel.
 * Neither is what somebody standing over a mushroom needs.
 */
const NOT_A_PHOTOGRAPH =
  /stamp|coin|banknote|illustration|drawing|engraving|lithograph|plate[ _.]|figure|diagram|chart|\bmap\b|herbarium|specimen|microscop|spore print|logo|coat of arms|sculpt|painting|artwork|\bt\._?\d|coloured figures|bhl\d|annual report|manual of|bilderatlas|atlas|flora danica|\bmenu\b|botany for students|edible mushrooms of|\bplates?\b|woodcut|watercolou?r/i;
const UA = "GridDown/1.1 (offline map app; plant safety reference)";
const IMG_HOST = "https://plants.sc.egov.usda.gov";
const OUT_JSON = "public/plants.json";
const OUT_IMG = "public/plantimg";
const WANT_IMAGES = process.argv.includes("--images");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(90_000) });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {
      /* retry */
    }
    await sleep(1000 * (i + 1));
  }
  return null;
}

/** USDA state name -> postal abbreviation, for the states GSAT covers. */
const ABBR = {
  Alabama: "AL", Arizona: "AZ", Idaho: "ID", Kansas: "KS", Louisiana: "LA",
  Minnesota: "MN", Missouri: "MO", Nebraska: "NE", Nevada: "NV",
  "New Mexico": "NM", "North Dakota": "ND", Oklahoma: "OK", Oregon: "OR",
  Pennsylvania: "PA", "South Carolina": "SC", Texas: "TX", Washington: "WA",
  Wyoming: "WY",
};

const curated = JSON.parse(readFileSync("tools/plants-curated.json", "utf8"));
const plants = curated.plants;
console.log(`curated: ${plants.length} plants`);

// ---- 1. State distribution, matched by genus -------------------------------
const states = await getJSON(`${API}/plantsDownload/GetGSATStateList`);
const covered = [];
/** genus (lowercase) -> Set of state abbreviations */
const genusStates = new Map();
/** genus (lowercase) -> Map of species symbol -> scientific name.
 *  Used to find a photograph when the curated entry is a genus: USDA hangs its
 *  images off SPECIES profiles, so a genus symbol like ZIGAD has none even
 *  though its species do. */
const genusSpecies = new Map();

for (const { State } of states ?? []) {
  const abbr = ABBR[State];
  if (!abbr) {
    console.warn(`  ! no abbreviation known for ${State} — skipped`);
    continue;
  }
  const rows = await getJSON(`${API}/plantsDownload/GetGSATByState?state=${encodeURIComponent(State)}`);
  if (!rows?.length) {
    console.warn(`  ! ${State}: no rows`);
    continue;
  }
  covered.push(abbr);
  for (const r of rows) {
    const genus = String(r.ScientificName || "").split(" ")[0].toLowerCase();
    if (!genus) continue;
    if (!genusStates.has(genus)) genusStates.set(genus, new Set());
    genusStates.get(genus).add(abbr);
    if (r.Symbol) {
      if (!genusSpecies.has(genus)) genusSpecies.set(genus, new Map());
      genusSpecies.get(genus).set(r.Symbol, r.ScientificName);
    }
  }
  console.log(`  ${abbr}: ${rows.length} species`);
}

// ---- 2. Profile + public-domain images per curated plant -------------------
if (WANT_IMAGES && !existsSync(OUT_IMG)) mkdirSync(OUT_IMG, { recursive: true });

let pdCount = 0, skippedCopyright = 0, commonsCount = 0, skippedShareAlike = 0, skippedNotPhoto = 0;
/** Symbols already queried, so a genus fallback never re-counts the same
 *  rejected images or re-fetches a profile it has seen. */
const seenSymbols = new Set();

/**
 * Freely-licensed photographs from Wikimedia Commons for one category.
 *
 * Strict on purpose: only Public Domain, CC0 and "No restrictions" survive. Most
 * of Commons is CC BY-SA — perfectly free to look at, but share-alike, which is
 * not something to bury inside a distributed binary without thought.
 */
async function commonsImages(category, want) {
  const q = new URLSearchParams({
    action: "query", generator: "categorymembers",
    gcmtitle: `Category:${category}`, gcmtype: "file", gcmlimit: "60",
    prop: "imageinfo", iiprop: "url|extmetadata|mime", iiurlwidth: "560", format: "json",
  });
  const d = await getJSON(`${COMMONS}?${q}`);
  const pages = Object.values(d?.query?.pages ?? {});
  const out = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii) continue;
    const em = ii.extmetadata ?? {};
    const licence = em.LicenseShortName?.value ?? "";
    if (!FREE_LICENCES.test(licence)) { skippedShareAlike++; continue; }
    // Photographs only, and JPEG only — the PNGs in these categories are almost
    // all scanned plates, and an 800 KB engraving is the worst of both worlds.
    if (NOT_A_PHOTOGRAPH.test(p.title)) { skippedNotPhoto++; continue; }
    if (ii.mime !== "image/jpeg") { skippedNotPhoto++; continue; }
    // Strip the HTML Commons puts in the artist field.
    const artist = String(em.Artist?.value ?? "")
      .replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    out.push({
      url: ii.thumburl || ii.url,
      credit: `${artist || "Unknown"} (${licence})`,
      file: p.title.replace(/^File:/, ""),
    });
    if (out.length >= want) break;
  }
  return out;
}

for (const p of plants) {
  // Genus entries carry a genus in `scientific` ("Zigadenus / Toxicoscordion
  // spp."); take every genus named before the slash.
  const genera = String(p.scientific)
    .split("/")
    .map((s) => s.trim().split(" ")[0].toLowerCase())
    .filter(Boolean);

  const found = new Set();
  for (const g of genera) for (const s of genusStates.get(g) ?? []) found.add(s);
  p.states = [...found].sort();

  p.images = [];

  /** Public-domain images for one USDA symbol, or [] if none. */
  async function pdFor(symbol) {
    if (seenSymbols.has(symbol)) return [];
    seenSymbols.add(symbol);
    const prof = await getJSON(`${API}/PlantProfile?symbol=${encodeURIComponent(symbol)}`);
    if (!prof?.Id) return [];
    const all = (await getJSON(`${API}/PlantImages?plantId=${prof.Id}`)) ?? [];
    const pd = all.filter((i) => i.Copyright === false);
    skippedCopyright += all.length - pd.length;
    return pd;
  }

  let pd = await pdFor(p.symbol);
  let via = "";

  // A genus entry (or a species whose own profile has only copyrighted photos)
  // borrows from a species in the same genus. Death camas, monkshood, baneberry,
  // foxglove and poison ivy all had no picture until this existed — and those
  // are exactly the ones a picture matters most for.
  if (!pd.length) {
    for (const g of genera) {
      for (const [sym, sci] of [...(genusSpecies.get(g) ?? new Map())].slice(0, 14)) {
        if (sym === p.symbol) continue;
        const alt = await pdFor(sym);
        if (alt.length) {
          pd = alt;
          via = sci.split(" ").slice(0, 2).join(" ");
          break;
        }
      }
      if (pd.length) break;
    }
  }

  // Wikimedia fallback for what USDA cannot supply at all.
  if (!pd.length && Array.isArray(p.commons)) {
    for (const cat of p.commons) {
      const got = await commonsImages(cat, 3 - p.images.length);
      for (const g of got) {
        const name = `${p.symbol.toLowerCase()}_${g.file.replace(/[^A-Za-z0-9._-]/g, "_")}`;
        if (WANT_IMAGES) {
          const dest = join(OUT_IMG, name);
          if (!existsSync(dest)) {
            try {
              const r = await fetch(g.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(90_000) });
              if (!r.ok) continue;
              writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
            } catch { continue; }
          }
        }
        p.images.push({ path: name, credit: `${g.credit} · Wikimedia Commons` });
        commonsCount++;
      }
      if (p.images.length >= 3) break;
    }
    if (p.images.length) {
      console.log(`  ${p.symbol.padEnd(6)} ${p.common.padEnd(28)} ` +
                  `${String(p.states.length).padStart(2)} states, ${p.images.length} photos (Wikimedia, free licence)`);
      continue;
    }
  }

  for (const i of pd.slice(0, 3)) {
    const src = i.StandardSizeImageLibraryPath || i.LargeSizeImageLibraryPath;
    if (!src) continue;
    const name = `${p.symbol.toLowerCase()}_${src.split("/").pop()}`;
    if (WANT_IMAGES) {
      const dest = join(OUT_IMG, name);
      if (!existsSync(dest)) {
        try {
          const r = await fetch(IMG_HOST + src, { signal: AbortSignal.timeout(90_000) });
          if (!r.ok) continue;
          writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
        } catch {
          continue;
        }
      }
    }
    p.images.push({
      path: name,
      credit: i.CommonName || "USDA NRCS PLANTS Database",
      // Honest about it when the photo is of a relative rather than this exact
      // entry — a picture of the wrong species is worse than none if unlabelled.
      ...(via ? { of: via } : {}),
    });
    pdCount++;
  }
  console.log(`  ${p.symbol.padEnd(6)} ${p.common.padEnd(28)} ` +
              `${String(p.states.length).padStart(2)} states, ${p.images.length} photos` +
              `${via ? ` (via ${via})` : pd.length ? "" : " — none public domain"}`);
}

// ---- 3. Write ---------------------------------------------------------------
delete curated._readme;
// `commons` tells THIS tool where to look; the app has no use for it.
for (const p of plants) delete p.commons;
writeFileSync(
  OUT_JSON,
  JSON.stringify(
    {
      _source:
        "Curated in tools/plants-curated.json; distribution and photographs from the " +
        "USDA NRCS PLANTS Database (public domain). Generated by tools/fetch_plants.mjs — do not hand-edit.",
      distributionStates: covered.sort(),
      plants,
    },
    null,
    1
  )
);

console.log(`\nwrote ${OUT_JSON}`);
console.log(`  distribution covers ${covered.length} states: ${covered.join(" ")}`);
console.log(`  ${pdCount} USDA public-domain images kept, ${skippedCopyright} copyrighted skipped`);
console.log(`  ${commonsCount} Wikimedia free-licence images kept, ${skippedShareAlike} share-alike/restricted skipped`);
console.log(`  ${skippedNotPhoto} Wikimedia files skipped as not photographs (stamps, plates, diagrams)`);
if (!WANT_IMAGES) console.log("  (re-run with --images to download the photos)");
