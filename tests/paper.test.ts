import { describe, it, expect } from "vitest";
import { PAPERS, niceBar, scaleRatio, jpegToPdf, textToPdf, type PdfBlock } from "../src/paper";

const dec = new TextDecoder("latin1");

/** Leaf page objects — `/Type /Pages` is the tree node and must not count. */
const pageObjects = (t: string) => (t.match(/\/Type \/Page(?!s)/g) ?? []).length;

/** What the page tree *claims*, which must agree with what was written. */
const declaredCount = (t: string) => Number(t.match(/\/Count (\d+)/)![1]);

/**
 * Every string the content streams draw, unescaped, with where and how big.
 * `right` is the far edge of the set text — Courier is 0.6 em per glyph, so
 * that is exact rather than an estimate.
 */
function drawn(t: string) {
  const re = /BT \/(F\d) ([\d.]+) Tf 1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm \((.*?)\) Tj ET/g;
  return [...t.matchAll(re)].map((m) => {
    const size = Number(m[2]);
    const x = Number(m[3]);
    const text = m[5]
      .replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
      .replace(/\\(.)/g, "$1");
    return { font: m[1], size, x, y: Number(m[4]), text, right: x + text.length * size * 0.6 };
  });
}

const drawnStrings = (t: string) => drawn(t).map((d) => d.text);

/** Each page's content stream, in page order. */
const contentStreams = (t: string) =>
  [...t.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]);

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

describe("textToPdf", () => {
  it("writes a valid one-page PDF for a short document", () => {
    const pdf = textToPdf({
      title: "Bug-out plan",
      subtitle: "Cabin, north route",
      blocks: [
        { kind: "heading", text: "Triggers" },
        { kind: "line", text: "Grid down more than 24 h." },
      ],
    });
    const t = dec.decode(pdf);

    expect(t.startsWith("%PDF-1.4\n")).toBe(true);
    expect(t.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(declaredCount(t)).toBe(1);
    expect(pageObjects(t)).toBe(1);
    expect(t).toContain("/MediaBox [0 0 612 792]");
    expect(drawnStrings(t)).toContain("Bug-out plan");
    expect(drawnStrings(t)).toContain("Grid down more than 24 h.");
  });
});

describe("textToPdf pagination", () => {
  const many: PdfBlock[] = Array.from({ length: 200 }, (_, i) => ({
    kind: "line" as const,
    text: `Waypoint ${i} - check fuel`,
  }));

  it("flows a long document onto as many pages as it needs", () => {
    const t = dec.decode(textToPdf({ title: "Long list", blocks: many }));
    expect(pageObjects(t)).toBeGreaterThan(3);
  });

  it("declares a /Count matching the pages actually written", () => {
    const t = dec.decode(textToPdf({ title: "Long list", blocks: many }));
    expect(declaredCount(t)).toBe(pageObjects(t));
  });

  it("loses no content off the end of a page", () => {
    const t = dec.decode(textToPdf({ title: "Long list", blocks: many }));
    const strings = drawnStrings(t);
    for (let i = 0; i < 200; i++) {
      expect(strings).toContain(`Waypoint ${i} - check fuel`);
    }
  });

  it("keeps body text out of the margins and the footer strip", () => {
    const t = dec.decode(textToPdf({ title: "Long list", blocks: many, footer: "GridDown" }));
    for (const d of drawn(t)) {
      if (d.text === "GridDown" || /^Page \d+ of \d+$/.test(d.text)) continue;
      expect(d.y).toBeGreaterThanOrEqual(78);
      expect(d.y).toBeLessThanOrEqual(792 - 54);
      expect(d.x).toBeGreaterThanOrEqual(54);
    }
  });

  it("footers and numbers every page", () => {
    const t = dec.decode(textToPdf({ title: "Long list", blocks: many, footer: "GridDown" }));
    const pages = pageObjects(t);
    const nums = drawnStrings(t).filter((s) => /^Page \d+ of \d+$/.test(s));
    expect(nums).toHaveLength(pages);
    expect(nums[0]).toBe(`Page 1 of ${pages}`);
    expect(nums[pages - 1]).toBe(`Page ${pages} of ${pages}`);
    expect(drawnStrings(t).filter((s) => s === "GridDown")).toHaveLength(pages);
  });
});

describe("textToPdf text encoding", () => {
  const nasty = "Cache (north) \\ spur ) dangling (";

  // A rally rule that prints as "18:00 ? cabin" has lost the only word in the
  // sentence that mattered. Accent-stripping cannot rescue a symbol.
  it("spells out symbols WinAnsi has no byte for", () => {
    const t = dec.decode(
      textToPdf({
        title: "x",
        blocks: [
          { kind: "line", text: "18:00 → cabin" },
          { kind: "line", text: "≈ 12 mi, ≤ 3 hrs" },
        ],
      })
    );
    expect(drawnStrings(t)).toContain("18:00 -> cabin");
    expect(drawnStrings(t)).toContain("~ 12 mi, <= 3 hrs");
    expect(drawnStrings(t).join(" ")).not.toContain("?");
  });

  it("escapes parens and backslashes without corrupting the document", () => {
    const pdf = textToPdf({ title: nasty, blocks: [{ kind: "line", text: nasty }] });
    const t = dec.decode(pdf);
    expect(t).toContain("Cache \\(north\\) \\\\ spur \\) dangling \\(");
    expect(t).toContain("/Title (Cache \\(north\\)");
    expect(declaredCount(t)).toBe(1);
    expect(pageObjects(t)).toBe(1);
    expect(t.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(drawnStrings(t)).toContain(nasty);
  });

  it("keeps accented Latin text instead of dropping it", () => {
    const t = dec.decode(
      textToPdf({ title: "x", blocks: [{ kind: "line", text: "Café Åsgård naïve" }] })
    );
    expect(drawnStrings(t)).toContain("Café Åsgård naïve");
  });

  it("maps smart punctuation into the WinAnsi range", () => {
    const t = dec.decode(
      textToPdf({ title: "x", blocks: [{ kind: "line", text: "“go” — now…" }] })
    );
    // 0x93/0x94/0x97/0x85 are the cp1252 slots WinAnsi gives curly quotes, the
    // em dash and the ellipsis. Notes pasted from a phone are full of them,
    // and plain Latin-1 has nowhere to put them.
    expect(drawnStrings(t)).toContain("\u0093go\u0094 \u0097 now\u0085");
  });

  it("substitutes characters no base-14 font can show", () => {
    const t = dec.decode(
      textToPdf({ title: "x", blocks: [{ kind: "line", text: "水 route" }] })
    );
    expect(drawnStrings(t)).toContain("? route");
  });

  it("treats a pasted CRLF as a line break, not a stray glyph", () => {
    const t = dec.decode(
      textToPdf({ title: "x", blocks: [{ kind: "line", text: "line one\r\nline two" }] })
    );
    expect(drawnStrings(t)).toContain("line one");
    expect(drawnStrings(t)).toContain("line two");
  });

  it("writes every stream as ASCII, so /Length matches the bytes exactly", () => {
    const pdf = textToPdf({
      title: "Réf (1) \\ 水",
      blocks: [{ kind: "line", text: "“é” — 水 (x) \\" }],
      footer: "Ünicode",
    });
    const t = dec.decode(pdf);
    const re = /\/Length (\d+) >>\nstream\n/g;
    let m: RegExpExecArray | null;
    let seen = 0;
    while ((m = re.exec(t))) {
      const at = m.index + m[0].length;
      const len = Number(m[1]);
      expect(dec.decode(pdf.slice(at + len, at + len + 11))).toBe("\nendstream\n");
      expect(pdf.slice(at, at + len).every((b) => b < 0x80)).toBe(true);
      seen++;
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe("textToPdf wrapping", () => {
  const long =
    "The rally point is the second gate on the fire road above the creek " +
    "crossing, roughly four hundred metres past the cattle grid, and there is " +
    "no signal anywhere along it.";

  it("wraps a long line onto several rows", () => {
    const t = dec.decode(textToPdf({ title: "x", blocks: [{ kind: "line", text: long }] }));
    const rows = drawnStrings(t).filter((s) => s.trim() && !/^Page /.test(s) && s !== "x");
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.join(" ").replace(/\s+/g, " ")).toContain("second gate on the fire road");
  });

  it("hangs the continuation lines of a wrapped line", () => {
    const t = dec.decode(textToPdf({ title: "x", blocks: [{ kind: "line", text: long }] }));
    const rows = drawn(t).filter((d) => d.size === 10);
    expect(rows[0].text.startsWith(" ")).toBe(false);
    expect(rows.slice(1).every((d) => d.text.startsWith("  "))).toBe(true);
  });

  it("lets a single over-long block break across pages instead of overflowing", () => {
    // One block, not many: a pasted note can easily be longer than a page, and
    // it must paginate like anything else rather than run off the bottom.
    const note = Array.from({ length: 400 }, (_, i) => `sentence number ${i} here`).join(", ");
    const t = dec.decode(textToPdf({ title: "Notes", blocks: [{ kind: "line", text: note }] }));
    const perPage = contentStreams(t).map((s) => drawn(s).filter((d) => d.size === 10).length);
    expect(perPage.length).toBeGreaterThan(1);
    // Nothing off the bottom, and the pages are actually filled — a block that
    // refuses to break gets either overrun or one line per sheet.
    for (const d of drawn(t).filter((r) => r.size === 10)) {
      expect(d.y).toBeGreaterThanOrEqual(78);
    }
    for (const count of perPage.slice(0, -1)) expect(count).toBeGreaterThan(30);
  });

  it("hard-breaks a word too long to ever fit", () => {
    const word = "10TER".repeat(40);
    const t = dec.decode(textToPdf({ title: "x", blocks: [{ kind: "line", text: word }] }));
    const rows = drawn(t).filter((d) => d.size === 10);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((d) => d.text.trim()).join("")).toBe(word);
  });

  it("never sets a glyph past the right margin, headings and titles included", () => {
    const t = dec.decode(
      textToPdf({
        title: long, // a title long enough to overrun if it is not wrapped
        subtitle: long,
        blocks: [
          { kind: "heading", text: long },
          { kind: "line", text: long },
          { kind: "kv", label: "Bearing to the second rally point", value: long },
          { kind: "kv", label: "Distance", value: "12.4 mi" },
        ],
        footer: long,
      })
    );
    for (const d of drawn(t)) {
      expect(d.right).toBeLessThanOrEqual(612 - 54 + 0.01);
      expect(d.x).toBeGreaterThanOrEqual(54);
    }
  });
});

describe("textToPdf page breaks", () => {
  it("starts a new page on a pagebreak block", () => {
    const t = dec.decode(
      textToPdf({
        title: "x",
        blocks: [
          { kind: "line", text: "before" },
          { kind: "pagebreak" },
          { kind: "line", text: "after" },
        ],
      })
    );
    expect(pageObjects(t)).toBe(2);
    expect(declaredCount(t)).toBe(2);
    const streams = contentStreams(t);
    expect(streams[0]).toContain("(before)");
    expect(streams[0]).not.toContain("(after)");
    expect(streams[1]).toContain("(after)");
  });

  it("does not leave a blank page after a trailing pagebreak", () => {
    const t = dec.decode(
      textToPdf({ title: "x", blocks: [{ kind: "line", text: "only" }, { kind: "pagebreak" }] })
    );
    expect(pageObjects(t)).toBe(1);
    expect(declaredCount(t)).toBe(1);
  });

  it("collapses consecutive pagebreaks into one", () => {
    const t = dec.decode(
      textToPdf({
        title: "x",
        blocks: [
          { kind: "line", text: "a" },
          { kind: "pagebreak" },
          { kind: "pagebreak" },
          { kind: "line", text: "b" },
        ],
      })
    );
    expect(pageObjects(t)).toBe(2);
  });

  it("still writes one page for an empty document", () => {
    const t = dec.decode(textToPdf({ title: "Empty", blocks: [] }));
    expect(pageObjects(t)).toBe(1);
    expect(declaredCount(t)).toBe(1);
    expect(drawnStrings(t)).toContain("Empty");
  });
});

describe("textToPdf widow control", () => {
  // A heading alone at the foot of a page sends the reader over the fold to
  // find out what it was heading. Sweep the fill length so the heading lands
  // at every possible distance from the bottom.
  it("never leaves a heading as the last thing on a page", () => {
    for (let n = 30; n <= 75; n++) {
      const blocks: PdfBlock[] = [
        ...Array.from({ length: n }, (_, i) => ({
          kind: "line" as const,
          text: `filler ${i}`,
        })),
        { kind: "heading", text: "Rally points" },
        { kind: "line", text: "Gate on the fire road" },
      ];
      const t = dec.decode(textToPdf({ title: "Plan", blocks }));
      for (const stream of contentStreams(t)) {
        const items = drawn(stream).filter((d) => d.size !== 8); // drop furniture
        if (!items.length) continue;
        const lowest = items.reduce((a, b) => (b.y < a.y ? b : a));
        expect({ n, text: lowest.text, font: lowest.font }).toMatchObject({
          font: "F1",
        });
      }
    }
  });

  it("gives up keeping a heading whole when it is taller than a page", () => {
    // Absurd, but reachable: the heading is a user-entered section name. Held
    // together at all costs it would take one line per sheet forever, so the
    // rule has to yield to the page rather than the other way round.
    const huge = Array.from({ length: 400 }, (_, i) => `part ${i}`).join(" ");
    const t = dec.decode(
      textToPdf({
        title: "Plan",
        blocks: [{ kind: "heading", text: huge }, { kind: "line", text: "after" }],
      })
    );
    const perPage = contentStreams(t).map((s) => drawn(s).filter((d) => d.size === 11.5).length);
    expect(perPage.length).toBeGreaterThan(1);
    for (const count of perPage.slice(0, -1)) expect(count).toBeGreaterThan(30);
    for (const d of drawn(t).filter((r) => r.size === 11.5)) {
      expect(d.y).toBeGreaterThanOrEqual(78);
    }
  });

  it("keeps a wrapped heading whole, on one page, with its first line", () => {
    const heading =
      "Rally points, their alternates, and the order to try them in if the " +
      "first two are already burning or occupied";
    for (let n = 30; n <= 75; n++) {
      const blocks: PdfBlock[] = [
        ...Array.from({ length: n }, (_, i) => ({
          kind: "line" as const,
          text: `filler ${i}`,
        })),
        { kind: "heading", text: heading },
        { kind: "line", text: "Gate on the fire road" },
      ];
      const t = dec.decode(textToPdf({ title: "Plan", blocks }));
      const perPage = contentStreams(t).map(
        (s) => drawn(s).filter((d) => d.font === "F2" && d.size === 11.5).length
      );
      // The heading wraps, and every one of its lines lands on the same page.
      expect(perPage.filter((c) => c > 0)).toHaveLength(1);
      expect(Math.max(...perPage)).toBeGreaterThan(1);
    }
  });
});

describe("textToPdf blocks", () => {
  it("right-aligns a kv value to the right margin, with dot leaders", () => {
    const t = dec.decode(
      textToPdf({ title: "x", blocks: [{ kind: "kv", label: "Distance", value: "12.4 mi" }] })
    );
    const row = drawn(t).find((d) => d.text.startsWith("Distance"))!;
    expect(row.text).toMatch(/^Distance \.+ 12\.4 mi$/);
    expect(row.right).toBeCloseTo(612 - 54, 6);
  });

  it("drops an over-long kv value under its label rather than overrunning", () => {
    const value =
      "the second gate on the fire road above the creek crossing, four hundred " +
      "metres past the cattle grid";
    const t = dec.decode(
      textToPdf({ title: "x", blocks: [{ kind: "kv", label: "Rally point", value }] })
    );
    const rows = drawn(t).filter((d) => d.size === 10);
    expect(rows[0].text).toBe("Rally point");
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.slice(1).every((d) => d.text.startsWith("  "))).toBe(true);
    expect(rows.map((d) => d.text.trim()).slice(1).join(" ")).toBe(value);
  });

  it("draws a rule the full width of the text column, between its neighbours", () => {
    const t = dec.decode(
      textToPdf({
        title: "x",
        blocks: [{ kind: "line", text: "above" }, { kind: "rule" }, { kind: "line", text: "below" }],
      })
    );
    const above = drawn(t).find((d) => d.text === "above")!.y;
    const below = drawn(t).find((d) => d.text === "below")!.y;
    const strokes = [
      ...contentStreams(t)[0].matchAll(/[\d.]+ w (-?[\d.]+) (-?[\d.]+) m (-?[\d.]+) [\d.-]+ l S/g),
    ].map((m) => ({ x1: Number(m[1]), y: Number(m[2]), x2: Number(m[3]) }));
    const between = strokes.filter((s) => s.y < above && s.y > below);
    expect(between).toHaveLength(1);
    expect(between[0].x1).toBe(54);
    expect(between[0].x2).toBe(612 - 54);
  });

  it("opens up the requested amount of space for a spacer", () => {
    const gap = (blocks: PdfBlock[]) => {
      const d = drawn(dec.decode(textToPdf({ title: "x", blocks })));
      return d.find((r) => r.text === "a")!.y - d.find((r) => r.text === "b")!.y;
    };
    const plain = gap([
      { kind: "line", text: "a" },
      { kind: "line", text: "b" },
    ]);
    const spaced = gap([
      { kind: "line", text: "a" },
      { kind: "spacer", pt: 40 },
      { kind: "line", text: "b" },
    ]);
    expect(spaced - plain).toBeCloseTo(40, 6);
  });

  it("indents a line by the requested number of characters", () => {
    const t = dec.decode(
      textToPdf({
        title: "x",
        blocks: [
          { kind: "line", text: "Primary" },
          { kind: "line", text: "via the fire road", indent: 4 },
        ],
      })
    );
    const rows = drawn(t).filter((d) => d.size === 10);
    expect(rows.map((d) => d.text)).toEqual(["Primary", "    via the fire road"]);
    // Indented with spaces, not a shifted origin, so every row shares one x.
    expect(new Set(rows.map((d) => d.x)).size).toBe(1);
  });

  it("honours the paper size", () => {
    const t = dec.decode(
      textToPdf({ title: "x", blocks: [{ kind: "line", text: "a" }], paper: PAPERS.a4 })
    );
    expect(t).toContain("/MediaBox [0 0 595 842]");
  });

  it("uses only base-14 fonts, with no embedded font files", () => {
    const t = dec.decode(textToPdf({ title: "x", blocks: [{ kind: "heading", text: "h" }] }));
    expect(t).toContain("/BaseFont /Courier /Encoding /WinAnsiEncoding");
    expect(t).toContain("/BaseFont /Courier-Bold /Encoding /WinAnsiEncoding");
    expect(t).not.toContain("/FontFile");
  });

  it("writes a non-ASCII document title as UTF-16, which is what readers decode", () => {
    // The page body goes through the font, so it is WinAnsi. /Title does not:
    // a reader decodes it as PDFDocEncoding, where the same bytes mean other
    // characters entirely — an em dash came back as a caron-S in the title bar.
    const t = dec.decode(textToPdf({ title: "Café 水", blocks: [] }));
    expect(t).toContain("/Title <FEFF00430061006600E900206C34>");
  });

  it("leaves an ASCII document title as a plain escaped literal", () => {
    const t = dec.decode(textToPdf({ title: "Plan (north)", blocks: [] }));
    expect(t).toContain("/Title (Plan \\(north\\))");
  });

  it("has an xref whose offsets point at the right objects", () => {
    const pdf = textToPdf({
      title: "Plan",
      blocks: Array.from({ length: 120 }, (_, i) => ({ kind: "line" as const, text: `x ${i}` })),
    });
    const t = dec.decode(pdf);
    const xrefAt = Number(t.match(/startxref\n(\d+)\n/)![1]);
    expect(t.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const entries = t
      .slice(xrefAt)
      .match(/^\d{10} \d{5} n $/gm)!
      .map((l) => Number(l.slice(0, 10)));
    expect(t).toContain(`/Size ${entries.length + 1} `);
    entries.forEach((off, i) => {
      expect(t.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });
});
