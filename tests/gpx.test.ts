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

  it("rejects files that aren't GPX", () => {
    expect(() => parseGPX(`<?xml version="1.0"?><kml><Placemark/></kml>`)).toThrow(/GPX/);
    expect(() => parseGPX(`this is not xml at all <<<`)).toThrow();
  });
});
