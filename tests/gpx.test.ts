import { describe, expect, it } from "vitest";
import { buildGPX, parseGPX } from "../src/gpx";
import type { Track, Waypoint } from "../src/store";

const wp = (over: Partial<Waypoint> = {}): Waypoint => ({
  id: "a",
  name: "Camp",
  lat: 44.05,
  lng: -121.31,
  t: 0,
  ...over,
});

describe("parseGPX", () => {
  it("round-trips waypoints and tracks through buildGPX", () => {
    const wps: Waypoint[] = [wp({ note: "good water" }), wp({ id: "b", name: "Cache", lat: 43.9, lng: -121.5 })];
    const trks: Track[] = [
      { id: "t", name: "Ridge", pts: [[-121.3, 44.0, 1200], [-121.29, 44.01, 1250]], t: 0 },
    ];
    const out = parseGPX(buildGPX(wps, trks));

    expect(out.waypoints.map((w) => [w.name, w.lat, w.lng])).toEqual([
      ["Camp", 44.05, -121.31],
      ["Cache", 43.9, -121.5],
    ]);
    expect(out.waypoints[0].note).toBe("good water");
    expect(out.tracks).toHaveLength(1);
    expect(out.tracks[0].name).toBe("Ridge");
    expect(out.tracks[0].pts).toEqual([
      [-121.3, 44.0, 1200],
      [-121.29, 44.01, 1250],
    ]);
  });

  it("escapes and recovers names containing XML metacharacters", () => {
    const out = parseGPX(buildGPX([wp({ name: `Bob & "Sue" <camp>` })], []));
    expect(out.waypoints[0].name).toBe(`Bob & "Sue" <camp>`);
  });

  it("splits a multi-segment track so gaps aren't joined by a straight line", () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Loop</name>
      <trkseg><trkpt lat="44.0" lon="-121.0"/><trkpt lat="44.1" lon="-121.1"/></trkseg>
      <trkseg><trkpt lat="45.0" lon="-122.0"/><trkpt lat="45.1" lon="-122.1"/></trkseg>
    </trk></gpx>`;
    const out = parseGPX(xml);
    expect(out.tracks.map((t) => t.name)).toEqual(["Loop (1)", "Loop (2)"]);
  });

  it("imports routes as tracks", () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1"><rte><name>Plan</name>
      <rtept lat="44.0" lon="-121.0"/><rtept lat="44.1" lon="-121.1"/></rte></gpx>`;
    expect(parseGPX(xml).tracks[0].name).toBe("Plan");
  });

  it("skips malformed points instead of failing the whole import", () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1">
      <wpt lat="44.0" lon="-121.0"><name>Good</name></wpt>
      <wpt lat="not-a-number" lon="-121.0"><name>Bad</name></wpt>
      <wpt lat="99.9" lon="-121.0"><name>Out of range</name></wpt>
    </gpx>`;
    const out = parseGPX(xml);
    expect(out.waypoints.map((w) => w.name)).toEqual(["Good"]);
  });

  it("drops one-point tracks, which can't be drawn as a line", () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1"><trk><name>Stub</name>
      <trkseg><trkpt lat="44.0" lon="-121.0"/></trkseg></trk></gpx>`;
    expect(parseGPX(xml).tracks).toEqual([]);
  });

  /**
   * The Garmin shape: a route or track with no name of its own, whose points
   * are all named. A descendant search for <name> found the first *point's*
   * name and used it as the container's, so a whole route imported as
   * "Trailhead" — the name of one waypoint on it.
   */
  it("does not take a route's name from its first point", () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1"><rte>
      <rtept lat="44.0" lon="-121.0"><name>Trailhead</name></rtept>
      <rtept lat="44.1" lon="-121.1"><name>Summit</name></rtept>
    </rte></gpx>`;
    const t = parseGPX(xml).tracks;
    expect(t).toHaveLength(1);
    expect(t[0].name).toBe("Imported route");
    expect(t[0].name).not.toBe("Trailhead");
  });

  it("does not take a track's name from its first point", () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>
      <trkpt lat="44.0" lon="-121.0"><name>Trailhead</name></trkpt>
      <trkpt lat="44.1" lon="-121.1"><name>Summit</name></trkpt>
    </trkseg></trk></gpx>`;
    const t = parseGPX(xml).tracks;
    expect(t).toHaveLength(1);
    expect(t[0].name).toBe("Imported track");
    expect(t[0].name).not.toBe("Trailhead");
  });

  it("still prefers the container's own name over its points'", () => {
    const xml = `<?xml version="1.0"?><gpx version="1.1">
      <trk><name>Green Lakes</name><trkseg>
        <trkpt lat="44.0" lon="-121.0"><name>Trailhead</name></trkpt>
        <trkpt lat="44.1" lon="-121.1"><name>Summit</name></trkpt>
      </trkseg></trk>
      <rte><name>Bearing line</name>
        <rtept lat="43.0" lon="-120.0"><name>Start</name></rtept>
        <rtept lat="43.1" lon="-120.1"><name>End</name></rtept>
      </rte></gpx>`;
    expect(parseGPX(xml).tracks.map((t) => t.name)).toEqual(["Green Lakes", "Bearing line"]);
  });

  it("takes a waypoint's own name and note, not a nested element's", () => {
    // Same failure the other way round: an extension block carrying its own
    // <name>/<desc> must not be mistaken for the waypoint's.
    const xml = `<?xml version="1.0"?><gpx version="1.1">
      <wpt lat="44.0" lon="-121.0">
        <name>Spring</name><desc>runs year-round</desc>
        <extensions><thing><name>gaia:marker</name><desc>ignore me</desc></thing></extensions>
      </wpt></gpx>`;
    const w = parseGPX(xml).waypoints[0];
    expect(w.name).toBe("Spring");
    expect(w.note).toBe("runs year-round");
  });

  /**
   * Timestamps used to be dropped on write, so every export-and-reimport reset
   * the age of every pin and track to "just now" — the one thing a waypoint's
   * time is for.
   */
  describe("timestamps survive a round trip", () => {
    // 2020-01-02T03:04:05.000Z. A fixed literal, so a Date.now() fallback
    // cannot possibly pass.
    const T = 1577934245000;

    it("keeps a waypoint's time", () => {
      const out = parseGPX(buildGPX([wp({ t: T })], []));
      expect(out.waypoints[0].t).toBe(T);
    });

    it("keeps a track's time", () => {
      const trk: Track = {
        id: "t",
        name: "Ridge",
        pts: [[-121.3, 44.0], [-121.29, 44.01]],
        t: T,
      };
      const out = parseGPX(buildGPX([], [trk]));
      expect(out.tracks[0].t).toBe(T);
    });

    it("writes the waypoint's <time> before its <name>, per GPX 1.1's wptType", () => {
      // The sequence is fixed by the schema; out of order the file is invalid
      // and strict readers (Garmin BaseCamp) reject the whole thing.
      const xml = buildGPX([wp({ t: T })], []);
      expect(xml).toContain(`<time>2020-01-02T03:04:05.000Z</time><name>Camp</name>`);
    });

    it("hangs a track's time on its first point, the only legal place for it", () => {
      // trkType has no <time> child of its own.
      const trk: Track = {
        id: "t",
        name: "Ridge",
        pts: [[-121.3, 44.0], [-121.29, 44.01]],
        t: T,
      };
      const xml = buildGPX([], [trk]);
      expect(xml).not.toContain(`<trk><name>Ridge</name><time>`);
      const first = xml.indexOf("<trkpt");
      const second = xml.indexOf("<trkpt", first + 1);
      expect(xml.slice(first, second)).toContain("<time>2020-01-02T03:04:05.000Z</time>");
      expect(xml.slice(second)).not.toContain("<time>");
    });

    it("emits well-formed XML when a name carries & and <", () => {
      const trk: Track = {
        id: "t",
        name: `Bull & Bear < Ridge`,
        pts: [[-121.3, 44.0], [-121.29, 44.01]],
        t: T,
      };
      const xml = buildGPX([wp({ name: `Camp & "Cache" <2>`, note: "a & b", t: T })], [trk]);
      // Raw & or < inside the document body would make it unparseable.
      const doc = new DOMParser().parseFromString(xml, "application/xml");
      expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);

      const out = parseGPX(xml);
      expect(out.waypoints[0].name).toBe(`Camp & "Cache" <2>`);
      expect(out.waypoints[0].note).toBe("a & b");
      expect(out.waypoints[0].t).toBe(T);
      expect(out.tracks[0].name).toBe(`Bull & Bear < Ridge`);
      expect(out.tracks[0].t).toBe(T);
    });

    it("falls back to now rather than to 1970 when the file carries no time", () => {
      const before = Date.now();
      const xml = `<?xml version="1.0"?><gpx version="1.1">
        <wpt lat="44.0" lon="-121.0"><name>Undated</name></wpt>
        <trk><name>Undated</name><trkseg>
          <trkpt lat="44.0" lon="-121.0"/><trkpt lat="44.1" lon="-121.1"/>
        </trkseg></trk></gpx>`;
      const out = parseGPX(xml);
      expect(out.waypoints[0].t).toBeGreaterThanOrEqual(before);
      expect(out.tracks[0].t).toBeGreaterThanOrEqual(before);
    });
  });

  it("rejects files that aren't GPX", () => {
    expect(() => parseGPX(`<?xml version="1.0"?><kml><Placemark/></kml>`)).toThrow(/GPX/);
    expect(() => parseGPX(`this is not xml at all <<<`)).toThrow();
  });
});
