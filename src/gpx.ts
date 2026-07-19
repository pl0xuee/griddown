import type { Marks, Pt, Track, Waypoint } from "./store";

// GPX 1.1 read/write. Kept separate from the UI so it can be exercised directly:
// this is the format that carries your data between devices and into other
// mapping tools, so it's the piece most worth being able to test.

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildGPX(wps: Waypoint[], trks: Track[]): string {
  let s = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  s += `<gpx version="1.1" creator="GridDown" xmlns="http://www.topografix.com/GPX/1/1">\n`;
  for (const w of wps) {
    s += `  <wpt lat="${w.lat}" lon="${w.lng}"><name>${esc(w.name)}</name>`;
    if (w.note) s += `<desc>${esc(w.note)}</desc>`;
    s += `</wpt>\n`;
  }
  for (const t of trks) {
    s += `  <trk><name>${esc(t.name)}</name><trkseg>\n`;
    for (const p of t.pts) {
      s += `    <trkpt lat="${p[1]}" lon="${p[0]}">`;
      if (p[2] != null) s += `<ele>${p[2]}</ele>`;
      s += `</trkpt>\n`;
    }
    s += `  </trkseg></trk>\n`;
  }
  s += `</gpx>\n`;
  return s;
}

function rid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function text(parent: Element, tag: string): string {
  return parent.getElementsByTagName(tag)[0]?.textContent?.trim() || "";
}

function coord(el: Element): [number, number] | null {
  const lat = parseFloat(el.getAttribute("lat") || "");
  const lng = parseFloat(el.getAttribute("lon") || "");
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lat, lng];
}

/**
 * Parse a GPX document into waypoints and tracks.
 *
 * Deliberately lenient — files come from other tools (Garmin, Gaia, OsmAnd,
 * caltopo) and vary. Anything unparseable is skipped rather than failing the
 * whole import; a partial import beats losing the file. Throws only when the
 * document isn't GPX at all.
 *
 * Routes (<rte>) are imported as tracks: for our purposes a planned line and a
 * walked line are the same thing.
 */
export function parseGPX(xml: string): Marks {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("That file isn't valid XML.");
  }
  if (!doc.getElementsByTagName("gpx").length) {
    throw new Error("That file isn't a GPX file.");
  }

  const waypoints: Waypoint[] = [];
  for (const el of Array.from(doc.getElementsByTagName("wpt"))) {
    const c = coord(el);
    if (!c) continue;
    waypoints.push({
      id: rid(),
      name: text(el, "name") || "Imported waypoint",
      lat: c[0],
      lng: c[1],
      note: text(el, "desc") || undefined,
      t: Date.parse(text(el, "time")) || Date.now(),
    });
  }

  const tracks: Track[] = [];
  const collect = (container: Element, ptTag: string, fallback: string) => {
    const pts: Pt[] = [];
    for (const p of Array.from(container.getElementsByTagName(ptTag))) {
      const c = coord(p);
      if (!c) continue;
      const ele = parseFloat(text(p, "ele"));
      pts.push([c[1], c[0], Number.isFinite(ele) ? ele : undefined]);
    }
    // A single point isn't a line — the track layer needs at least two.
    if (pts.length > 1) {
      tracks.push({
        id: rid(),
        name: text(container, "name") || fallback,
        pts,
        t: Date.now(),
      });
    }
  };

  // Each <trkseg> becomes its own track so a segmented file doesn't get drawn
  // with straight lines joining the gaps.
  for (const trk of Array.from(doc.getElementsByTagName("trk"))) {
    const segs = Array.from(trk.getElementsByTagName("trkseg"));
    const name = text(trk, "name") || "Imported track";
    if (segs.length <= 1) {
      collect(trk, "trkpt", name);
    } else {
      segs.forEach((seg, i) => {
        const pts: Pt[] = [];
        for (const p of Array.from(seg.getElementsByTagName("trkpt"))) {
          const c = coord(p);
          if (!c) continue;
          const ele = parseFloat(text(p, "ele"));
          pts.push([c[1], c[0], Number.isFinite(ele) ? ele : undefined]);
        }
        if (pts.length > 1) {
          tracks.push({ id: rid(), name: `${name} (${i + 1})`, pts, t: Date.now() });
        }
      });
    }
  }
  for (const rte of Array.from(doc.getElementsByTagName("rte"))) {
    collect(rte, "rtept", "Imported route");
  }

  return { waypoints, tracks };
}
