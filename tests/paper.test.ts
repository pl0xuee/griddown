import { describe, it, expect } from "vitest";
import { PAPERS, niceBar, scaleRatio, jpegToPdf } from "../src/paper";

const dec = new TextDecoder("latin1");

describe("niceBar", () => {
  it("picks round miles when there's room", () => {
    // ~3.7 mi of room -> a 2 mi bar
    const b = niceBar(6000, "imperial");
    expect(b.label).toBe("2 mi");
    expect(b.meters).toBeCloseTo(2 * 1609.344, 3);
  });

  it("drops to feet below a mile", () => {
    const b = niceBar(500, "imperial"); // ~1640 ft
    expect(b.label).toBe("1000 ft");
    expect(b.meters).toBeCloseTo(1000 / 3.28084, 2);
  });

  it("picks km and m for metric", () => {
    expect(niceBar(7800, "metric").label).toBe("5 km");
    expect(niceBar(900, "metric").label).toBe("500 m");
  });

  it("handles nonsense input without blowing up", () => {
    expect(niceBar(0, "metric").meters).toBe(0);
    expect(niceBar(NaN, "imperial").meters).toBe(0);
  });
});

describe("scaleRatio", () => {
  it("formats a classic quad scale", () => {
    // 1:24,000 -> ground meters per paper point
    const mPerPt = 24000 * (0.0254 / 72);
    expect(scaleRatio(mPerPt)).toBe("1:24,000");
  });

  it("rounds ugly ratios to something readable", () => {
    const mPerPt = 23731 * (0.0254 / 72);
    expect(scaleRatio(mPerPt)).toBe("1:24,000");
  });
});

describe("jpegToPdf", () => {
  // A tiny stand-in "JPEG" — the writer never parses it, just embeds it.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const pdf = jpegToPdf(jpeg, PAPERS.letter.hPt, PAPERS.letter.wPt, 2256, 1836, "Test (map)");
  const text = dec.decode(pdf);

  it("has a valid header and trailer", () => {
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("embeds the JPEG bytes verbatim with the right length", () => {
    expect(text).toContain(`/Filter /DCTDecode /Length ${jpeg.length} >>`);
    const at = text.indexOf("stream\n", text.indexOf("/DCTDecode")) + "stream\n".length;
    expect(Array.from(pdf.slice(at, at + jpeg.length))).toEqual(Array.from(jpeg));
  });

  it("sets the page size and image dimensions", () => {
    expect(text).toContain("/MediaBox [0 0 792 612]");
    expect(text).toContain("/Width 2256 /Height 1836");
  });

  it("escapes the title", () => {
    expect(text).toContain("/Title (Test \\(map\\))");
  });

  it("has an xref whose offsets point at the right objects", () => {
    const xrefAt = Number(text.match(/startxref\n(\d+)\n/)?.[1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const entries = text
      .slice(xrefAt)
      .match(/^\d{10} \d{5} n $/gm)!
      .map((l) => Number(l.slice(0, 10)));
    expect(entries).toHaveLength(6);
    entries.forEach((off, i) => {
      expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });
});
