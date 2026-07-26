// Pure paper-map math + a minimal PDF writer. No DOM, no map — testable.
//
// The PDF side is deliberately hand-rolled and has no dependencies at all,
// which is the whole point of this app: the export has to work with the network
// gone. It writes two kinds of document off one object-table/xref writer —
// `jpegToPdf` for a single-page printed map, and `textToPdf` for a paginated
// text document such as a plan. Base-14 fonts only, so there is nothing to
// embed and nothing to fetch.

export interface PaperSize {
  wPt: number;
  hPt: number;
}

/** Page sizes in PDF points (1 pt = 1/72 inch). */
export const PAPERS: Record<string, PaperSize> = {
  letter: { wPt: 612, hPt: 792 }, // 8.5 × 11 in
  a4: { wPt: 595, hPt: 842 }, // 210 × 297 mm
};

const FT_PER_M = 3.28084;
const M_PER_MI = 1609.344;

export interface BarSpec {
  /** Bar length in meters of ground distance. */
  meters: number;
  /** Human label, e.g. "2 mi" or "500 m". */
  label: string;
}

/** Round down to a 1/2/5×10ⁿ "nice" number. */
function nice125(v: number): number {
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const m = v / base;
  const step = m >= 5 ? 5 : m >= 2 ? 2 : 1;
  return step * base;
}

/**
 * Pick the longest round-number scale bar that fits in `maxMeters` of ground
 * distance, in the given unit system.
 */
export function niceBar(maxMeters: number, unit: "imperial" | "metric"): BarSpec {
  if (maxMeters <= 0 || !Number.isFinite(maxMeters)) return { meters: 0, label: "" };
  if (unit === "metric") {
    if (maxMeters >= 1000) {
      const km = nice125(maxMeters / 1000);
      return { meters: km * 1000, label: `${km} km` };
    }
    const m = nice125(maxMeters);
    return { meters: m, label: `${m} m` };
  }
  const miles = maxMeters / M_PER_MI;
  if (miles >= 1) {
    const mi = nice125(miles);
    return { meters: mi * M_PER_MI, label: `${mi} mi` };
  }
  const ft = nice125(maxMeters * FT_PER_M);
  return { meters: ft / FT_PER_M, label: `${ft} ft` };
}

/** "1:24,000"-style ratio for a paper scale of `mPerPt` ground meters per point. */
export function scaleRatio(mPerPt: number): string {
  const paperMPerPt = 0.0254 / 72; // one point of paper, in meters
  const ratio = mPerPt / paperMPerPt;
  // Round to 2 significant-ish figures so it reads like a map, not a float.
  const rounded = ratio >= 100
    ? Math.round(ratio / Math.pow(10, Math.floor(Math.log10(ratio)) - 1)) *
      Math.pow(10, Math.floor(Math.log10(ratio)) - 1)
    : Math.round(ratio);
  return `1:${Math.round(rounded).toLocaleString("en-US")}`;
}

// --- Minimal PDF writer ---------------------------------------------------

const enc = new TextEncoder();

/**
 * The characters WinAnsi keeps in 0x80–0x9F, where Latin-1 has only controls.
 *
 * Worth carrying explicitly: this is the curly-quote, em-dash and ellipsis
 * block, which is most of what arrives in a note typed on a phone or pasted
 * from a web page. Dropping it turns "don't" into "dont" and a dashed clause
 * into two run-together sentences.
 */
const WINANSI_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84,
  "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88,
  "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c,
  "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93,
  "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** The five slots WinAnsi leaves undefined. */
const WINANSI_HOLES = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

/** A character's WinAnsi byte, or null if the encoding has no room for it. */
function winAnsiByte(ch: string): number | null {
  const c = ch.codePointAt(0)!;
  if (c >= 0x20 && c <= 0x7e) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  // Bytes we already mapped pass straight through, which makes the whole
  // transform idempotent — layout folds text once to measure it, and the writer
  // folds it again on the way out. Without this the second pass would see 0x93
  // as unmappable and replace a quote that was already correct.
  if (c >= 0x80 && c <= 0x9f && !WINANSI_HOLES.has(c)) return c;
  return WINANSI_EXTRA[ch] ?? null;
}

/**
 * Symbols with an obvious ASCII spelling that WinAnsi has no byte for.
 *
 * The accent-stripping fallback below cannot help with any of these — there is
 * no "→" with a diacritic to remove — so without this table they all print as
 * "?". These are exactly the characters people type between two places: a rally
 * rule that comes out as "18:00 ? cabin" has lost the only word in the sentence
 * that mattered, on the copy that exists precisely because the screen is dead.
 */
const ASCII_FOR: Record<string, string> = {
  "→": "->",
  "←": "<-",
  "↔": "<->",
  "⇒": "=>",
  "⇐": "<=",
  "↑": "^",
  "↓": "v",
  "≈": "~",
  "≤": "<=",
  "≥": ">=",
  "≠": "!=",
  "≡": "==",
  "√": "sqrt",
  "∞": "inf",
  "−": "-",
  "‒": "-",
  "―": "-",
  "™": "(TM)",
  "℃": "degC",
  "℉": "degF",
};

/**
 * Fold arbitrary text down to what a base-14 font can print, one character per
 * byte. Newlines survive as hard breaks; other control characters do not.
 *
 * Text reaching here is user-entered place names and notes, so it is whatever
 * a keyboard, a phone or a paste buffer produced. Characters WinAnsi cannot
 * hold are decomposed and stripped of their accents first — "Ő" printing as "O"
 * is a legible place name, "?" is not — and only genuinely foreign scripts fall
 * through to a question mark, which at least shows something was there.
 */
function plainText(s: string): string {
  let out = "";
  for (const ch of s.replace(/\r\n?/g, "\n")) {
    const c = ch.codePointAt(0)!;
    if (c === 10) {
      out += "\n";
      continue;
    }
    if (c < 0x20 || c === 0x7f) continue;
    const b = winAnsiByte(ch);
    if (b !== null) {
      out += String.fromCharCode(b);
      continue;
    }
    const spelled = ASCII_FOR[ch];
    if (spelled !== undefined) {
      out += spelled;
      continue;
    }
    const bare = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let folded = "";
    for (const c2 of bare) {
      const b2 = winAnsiByte(c2);
      if (b2 !== null) folded += String.fromCharCode(b2);
    }
    out += folded || "?";
  }
  return out;
}

/**
 * A PDF literal string's body.
 *
 * `(`, `)` and `\` are escaped because an unescaped `)` ends the string early
 * and the rest of the note is then read as PDF syntax — one apostrophe in a
 * place name and the whole document fails to open. Everything outside printable
 * ASCII is written as an octal escape rather than as a raw byte, which keeps
 * the entire file ASCII: `/Length` can then be measured from the string, and
 * TextEncoder's UTF-8 output cannot disagree with what a PDF literal means.
 */
function pdfStr(s: string): string {
  let out = "";
  const folded = plainText(s);
  for (let i = 0; i < folded.length; i++) {
    const b = folded.charCodeAt(i);
    const ch = folded[i];
    if (b >= 0x20 && b <= 0x7e) out += ch === "\\" || ch === "(" || ch === ")" ? "\\" + ch : ch;
    else out += "\\" + b.toString(8).padStart(3, "0");
  }
  return out;
}

/**
 * A value for a document-information entry such as /Title, brackets included.
 *
 * Metadata does not go through a font, so it does not get the font's encoding:
 * a reader decodes a plain literal here as PDFDocEncoding, which disagrees with
 * WinAnsi over exactly the block the curly quotes and dashes live in — an em
 * dash in a plan name came back as "Š" in the title bar. Anything outside ASCII
 * is therefore written as a UTF-16BE hex string, the one form PDF defines
 * unambiguously. ASCII stays a literal because it is identical either way and
 * far easier to read in a hex dump.
 */
function pdfInfoStr(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${pdfStr(s)})`;
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) {
    hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  }
  return `<${hex}>`;
}

/**
 * The object table, xref and trailer — the bookkeeping every PDF needs and the
 * only part that gets harder as the document grows.
 *
 * Object numbers are handed out by `reserve()` *before* the bytes exist because
 * PDF cross-references run both ways: a Page names its Parent and the Pages
 * tree names its Kids, so whichever is written second still has to be named by
 * the first. Reserving up front is what lets an N-page document be emitted in
 * one pass instead of being buffered and renumbered.
 *
 * The xref table is a byte offset per object, so nothing may be written to the
 * output except through `push` — a stray write past an offset silently shifts
 * every later object and readers reject the file with no useful complaint.
 */
function pdfWriter() {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const offsets: number[] = [0]; // object 0 is the free-list head
  let next = 1;

  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === "string" ? enc.encode(b) : b;
    chunks.push(bytes);
    length += bytes.length;
  };

  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"); // binary marker comment

  return {
    /** Claim the next object number without writing it yet. */
    reserve: () => next++,

    /** Write a reserved object's body at the current offset. */
    put(n: number, body: string) {
      offsets[n] = length;
      push(`${n} 0 obj\n${body}\nendobj\n`);
    },

    /**
     * Write a reserved object as a stream. `/Length` is measured from the
     * encoded bytes rather than the string, because a JS string's `.length` is
     * UTF-16 units and would understate any non-ASCII payload.
     */
    putStream(n: number, dict: string, data: Uint8Array | string) {
      offsets[n] = length;
      const bytes = typeof data === "string" ? enc.encode(data) : data;
      push(
        `${n} 0 obj\n<<${dict ? ` ${dict}` : ""} /Length ${bytes.length} >>\nstream\n`
      );
      push(bytes);
      push(`\nendstream\nendobj\n`);
    },

    /** Emit the xref table and trailer, and flatten to one buffer. */
    finish(root: number, info: number): Uint8Array {
      const count = next - 1;
      const xrefAt = length;
      let xref = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
      for (let i = 1; i <= count; i++) {
        xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
      }
      push(
        xref +
          `trailer\n<< /Size ${count + 1} /Root ${root} 0 R /Info ${info} 0 R >>\n` +
          `startxref\n${xrefAt}\n%%EOF\n`
      );

      const out = new Uint8Array(length);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      return out;
    },
  };
}

/**
 * Wrap a JPEG in a single-page PDF of the given size, the image filling the
 * page. Returns the complete PDF bytes.
 */
export function jpegToPdf(
  jpeg: Uint8Array,
  wPt: number,
  hPt: number,
  jpegW: number,
  jpegH: number,
  title: string
): Uint8Array {
  const w = pdfWriter();
  const catalog = w.reserve();
  const pages = w.reserve();
  const page = w.reserve();
  const image = w.reserve();
  const content = w.reserve();
  const info = w.reserve();

  w.put(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
  w.put(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
  w.put(
    page,
    `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${wPt} ${hPt}] ` +
      `/Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`
  );

  // Image XObject (DCTDecode = raw JPEG passthrough).
  w.putStream(
    image,
    `/Type /XObject /Subtype /Image /Width ${jpegW} /Height ${jpegH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
    jpeg
  );

  // Content stream: scale the unit image square up to the page.
  w.putStream(content, "", `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`);

  w.put(info, `<< /Title ${pdfInfoStr(title)} /Producer (GridDown) /Creator (GridDown) >>`);

  return w.finish(catalog, info);
}

// --- Text documents -------------------------------------------------------
//
// A printed plan is the last copy that still works with a dead battery, so this
// writer aims at legibility under bad conditions rather than typography.
//
// The font is Courier, one of the base-14 fonts every PDF reader carries — no
// embedding, no assets, nothing to fetch. Courier is chosen over Helvetica for
// one concrete reason: every glyph is exactly 600/1000 em wide, so line width is
// `chars × 0.6 × size` *exactly*. Wrapping is then arithmetic rather than a
// guess. With a proportional font we would have to ship a width table or
// estimate, and an estimate is wrong in both directions — too wide and a grid
// reference runs off the edge of the sheet and is simply gone, too narrow and
// the page wastes a quarter of its width. A monospace document also columns up
// coordinates, bearings and distances for free, which is how a field reference
// is meant to read.

/** Width of one Courier glyph, in ems. Exact for all four Courier variants. */
const COURIER_EM = 0.6;

export type PdfBlock =
  /** A section title. Never left dangling at the foot of a page. */
  | { kind: "heading"; text: string }
  /** A line of body text; wraps to the page width. `\n` forces a break. */
  | { kind: "line"; text: string; indent?: number }
  /** A label/value row — value right-aligned, dot leaders across the gap. */
  | { kind: "kv"; label: string; value: string }
  /** A horizontal rule across the text column. */
  | { kind: "rule" }
  /** Vertical space, in points (default half a line). */
  | { kind: "spacer"; pt?: number }
  /** Start the next block on a fresh page. */
  | { kind: "pagebreak" };

export interface TextDocOpts {
  /** Big on page one, small in the running header on every page after. */
  title: string;
  subtitle?: string;
  blocks: PdfBlock[];
  /** Defaults to US letter. */
  paper?: PaperSize;
  /** Runs along the bottom of every page, left of the page number. */
  footer?: string;
}

const MARGIN_PT = 54; // 3/4 in — survives a hole punch and most printers' no-print edge
const BODY_PT = 10;
const LEAD_PT = 13.5;
const HEAD_PT = 11.5;
const TITLE_PT = 17;
const SMALL_PT = 8;
const FOOTER_H = 26; // reserved strip at the foot: rule + one small line
const RUNHEAD_H = 24; // running header on continuation pages

/** Trim float noise out of the content stream; PDF coordinates need no more. */
const n2 = (v: number) => String(Math.round(v * 100) / 100);

/** How many Courier glyphs of `size` fit across `wPt` points. */
const glyphCols = (wPt: number, size: number) => Math.max(1, Math.floor(wPt / (size * COURIER_EM)));

/**
 * Fit a one-line label to `n` glyphs.
 *
 * Only for the running header and footer, which are furniture: they have a
 * fixed strip to live in and cannot grow, so an over-long one is cut with an
 * ellipsis. Body text is never truncated — it wraps.
 */
const fitOneLine = (s: string, n: number) =>
  s.length <= n ? s : n < 2 ? s.slice(0, Math.max(0, n)) : s.slice(0, n - 1) + "…";

const textAt = (x: number, y: number, size: number, font: string, s: string) =>
  `BT /${font} ${size} Tf 1 0 0 1 ${n2(x)} ${n2(y)} Tm (${pdfStr(s)}) Tj ET\n`;

const ruleAt = (x1: number, y: number, x2: number, w: number) =>
  `${w} w ${n2(x1)} ${n2(y)} m ${n2(x2)} ${n2(y)} l S\n`;

/**
 * Break `s` into lines of at most `cols` characters, wrapping on spaces.
 *
 * `hang` indents every line after the first of a paragraph, so a wrapped note
 * reads as one item rather than as two entries in a list. The indent is written
 * as leading spaces rather than as a drawing offset, which is only honest
 * because the font is monospace — n spaces is exactly n glyph widths, so the
 * returned lines measure their own width and the caller draws them all at x.
 *
 * Exported because a caller composing a document usually needs to know how much
 * room it has before deciding what to write.
 */
export function wrapText(s: string, cols: number, hang = 0): string[] {
  const full = Math.max(1, Math.floor(cols));
  const pad = " ".repeat(Math.max(0, Math.min(hang, full - 1)));
  const out: string[] = [];
  // Split on the caller's own newlines first: those are hard breaks they meant,
  // and folding them into the flow would run a note's last line into the next.
  for (const para of s.split("\n")) {
    const words = para.split(/[ \t]+/).filter((w) => w !== "");
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    let wrapped = false; // past the first line of *this* paragraph
    const width = () => full - (wrapped ? pad.length : 0);
    const flush = () => {
      out.push((wrapped ? pad : "") + line);
      line = "";
      wrapped = true;
    };
    for (let w of words) {
      // A word wider than the column — a URL, an unspaced grid reference — is
      // cut rather than allowed to overrun, because text that overruns the page
      // is not shortened on paper, it is gone.
      while (w.length > width()) {
        if (line) flush();
        line = w.slice(0, width());
        w = w.slice(line.length);
        flush();
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width()) line += " " + w;
      else {
        flush();
        line = w;
      }
    }
    if (line) flush();
  }
  return out;
}

/** One laid-out row: how much vertical room it takes, and how to draw it. */
interface Row {
  height: number;
  /** `top` is the row's upper edge in PDF page coordinates (y up from bottom). */
  draw?: (top: number) => string;
  /** Force the next row onto a new page. */
  brk?: boolean;
  /** Whitespace, which evaporates rather than opening a page with a gap. */
  blank?: boolean;
  /** This row must not be the last on a page. */
  keepWithNext?: boolean;
}

function layoutBlocks(blocks: PdfBlock[], left: number, right: number): Row[] {
  const cols = glyphCols(right - left, BODY_PT);
  const rows: Row[] = [];

  /**
   * One row per wrapped line, all drawn at the left edge.
   *
   * `glued` marks *every* line as keep-with-next, which is what a heading wants
   * — all of its lines and the line under it travel together. Body text passes
   * false, and deliberately: a pasted note can be longer than a page, and if
   * its lines were glued the whole paragraph would be forced onto one sheet and
   * run off the bottom of it.
   */
  const body = (lines: string[], size: number, font: string, glued = false) =>
    lines.forEach((s) =>
      rows.push({
        height: LEAD_PT,
        keepWithNext: glued,
        draw: (top) => textAt(left, top - size, size, font, s),
      })
    );

  for (const b of blocks) {
    switch (b.kind) {
      case "pagebreak":
        rows.push({ height: 0, brk: true });
        break;

      case "spacer":
        rows.push({ height: b.pt ?? LEAD_PT / 2, blank: true });
        break;

      case "rule":
        rows.push({
          height: LEAD_PT,
          draw: (top) => ruleAt(left, top - LEAD_PT / 2, right, 0.5),
        });
        break;

      case "heading": {
        // Space above, not below: the gap belongs to the break between sections,
        // and putting it below would let a page end on it.
        rows.push({ height: LEAD_PT / 2, blank: true, keepWithNext: true });
        // The heading gets its own column count: it is set larger, so it fits
        // fewer characters than the body does on the same measure.
        const headCols = glyphCols(right - left, HEAD_PT);
        body(wrapText(plainText(b.text), headCols, 0), HEAD_PT, "F2", true);
        break;
      }

      case "line": {
        // Folded to printable characters *before* measuring: wrapping counts
        // glyphs, so it has to count the glyphs that will actually be drawn.
        const pad = " ".repeat(Math.max(0, b.indent ?? 0));
        body(
          wrapText(plainText(b.text), cols - pad.length, 2).map((s) => pad + s),
          BODY_PT,
          "F1"
        );
        break;
      }

      case "kv": {
        const label = plainText(b.label);
        const value = plainText(b.value);
        if (label.length + 1 + value.length <= cols) {
          // Dot leaders across the gap. On a full-width measure the eye has a
          // long way to travel from label to value, and on a bare gap it lands
          // a row out — which on this page means reading someone else's grid
          // reference.
          const fill = cols - label.length - value.length;
          const lead =
            fill >= 4 ? " " + ".".repeat(fill - 2) + " " : " ".repeat(Math.max(1, fill));
          body([label + lead + value], BODY_PT, "F1");
        } else {
          // Too long for one row. A wrapped value cannot be right-aligned
          // without a ragged left edge, so it drops to an indented block under
          // its label instead, and the label keeps with it.
          body([label], BODY_PT, "F1", true);
          body(
            wrapText(value, cols - 2, 0).map((s) => "  " + s),
            BODY_PT,
            "F1"
          );
        }
        break;
      }
    }
  }
  return rows;
}

interface Placed {
  row: Row;
  top: number;
}

/**
 * Fill pages with rows, top down, breaking when the next row will not fit.
 *
 * Pagination happens before any bytes are written, for one reason worth the
 * extra pass: the footer says "Page 2 of 5", and the 5 is only knowable once
 * every page exists. Loose printed sheets get separated, and the total is the
 * only thing on the page that reveals a missing one.
 */
function paginate(rows: Row[], hPt: number): Placed[][] {
  const bottom = MARGIN_PT + FOOTER_H;
  // Page one opens under the plain top margin; later pages give up a strip to
  // the running header, so their usable top is lower.
  const topOf = (page: number) => hPt - MARGIN_PT - (page > 0 ? RUNHEAD_H : 0);

  const pages: Placed[][] = [[]];
  let y = topOf(0);
  const newPage = () => {
    pages.push([]);
    y = topOf(pages.length - 1);
  };

  let pending = false; // a requested break, not yet taken
  // The tallest a keep-together run can be and still be worth honouring: a
  // continuation page, which is the shorter of the two kinds.
  const room = topOf(1) - bottom;

  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    let atTop = pages[pages.length - 1].length === 0;

    if (r.brk) {
      // Recorded rather than taken now. A break is only worth a sheet of paper
      // once something lands after it, so a trailing pagebreak, two in a row,
      // or one before any content all cost nothing instead of printing a blank
      // page — and a blank page in a field document reads as a printing fault,
      // or as a page someone removed.
      pending = !atTop;
      i++;
      continue;
    }
    // Space that would have opened a page is simply dropped, for the same
    // reason: a page starting with a gap looks like a fault.
    if (r.blank && (atTop || pending)) {
      i++;
      continue;
    }

    // The glued run starting here: the keep-with-next rows, plus the row they
    // are holding onto. Measuring the run rather than the row is what stops a
    // heading being the last thing on a page.
    let end = i;
    let need = 0;
    while (end < rows.length && rows[end].keepWithNext) need += rows[end++].height;
    need += rows[end]?.height ?? 0;

    if (pending) {
      if (!atTop) {
        newPage();
        atTop = true;
      }
      pending = false;
    } else if (need <= room && y - need < bottom && !atTop) {
      // Only move a run that would actually fit somewhere better. A run too
      // tall for any page is left where it is: breaking early would waste the
      // rest of this sheet and not help it fit the next one either.
      newPage();
      atTop = true;
    }

    // Place the run's glued rows now — the row they hold onto follows on the
    // next pass, and `need` already reserved room for it. Once the run has
    // started it is committed, so its interior rows break on ordinary
    // per-row fitting. Re-testing the whole run at every row inside it is what
    // turned an over-long heading into one line per sheet.
    const last = Math.max(i, end - 1);
    for (let k = i; k <= last; k++) {
      const rk = rows[k];
      const empty = pages[pages.length - 1].length === 0;
      if (rk.blank && empty) continue;
      if (!empty && y - rk.height < bottom) newPage();
      pages[pages.length - 1].push({ row: rk, top: y });
      y -= rk.height;
    }
    i = last + 1;
  }
  return pages;
}

/**
 * Render a paginated text document — headings, lines, label/value rows, rules
 * — as PDF bytes. Blocks flow onto as many pages as they need.
 */
export function textToPdf(opts: TextDocOpts): Uint8Array {
  const paper = opts.paper ?? PAPERS.letter;
  const { wPt, hPt } = paper;
  const left = MARGIN_PT;
  const right = wPt - MARGIN_PT;

  const rows = layoutBlocks(opts.blocks, left, right);

  // Page one carries the full title; later pages get a running header instead.
  // The title wraps like anything else: it is a user-entered plan name, so it
  // is exactly as likely to be too long as any other field on the sheet.
  const head: Row[] = wrapText(plainText(opts.title), glyphCols(right - left, TITLE_PT)).map(
    (s) => ({
      height: TITLE_PT * 1.3,
      keepWithNext: true,
      draw: (top: number) => textAt(left, top - TITLE_PT, TITLE_PT, "F2", s),
    })
  );
  if (opts.subtitle) {
    for (const s of wrapText(plainText(opts.subtitle), glyphCols(right - left, BODY_PT))) {
      head.push({
        height: LEAD_PT,
        keepWithNext: true,
        draw: (top) => textAt(left, top - BODY_PT, BODY_PT, "F1", s),
      });
    }
  }
  head.push({
    height: LEAD_PT,
    keepWithNext: true,
    draw: (top) => ruleAt(left, top - LEAD_PT / 2, right, 1),
  });

  const pages = paginate([...head, ...rows], hPt);

  const w = pdfWriter();
  const catalog = w.reserve();
  const pagesObj = w.reserve();
  const f1 = w.reserve();
  const f2 = w.reserve();
  const pageIds = pages.map(() => ({ page: w.reserve(), content: w.reserve() }));
  const info = w.reserve();

  w.put(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  w.put(
    pagesObj,
    `<< /Type /Pages /Kids [${pageIds.map((p) => `${p.page} 0 R`).join(" ")}] ` +
      `/Count ${pages.length} >>`
  );
  // WinAnsiEncoding rather than the font's built-in StandardEncoding, so the
  // byte values this file writes mean what Latin-1 says they mean.
  w.put(
    f1,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`
  );
  w.put(
    f2,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>`
  );

  pages.forEach((page, i) => {
    const { page: pageId, content } = pageIds[i];
    w.put(
      pageId,
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${wPt} ${hPt}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> ` +
        `/Contents ${content} 0 R >>`
    );

    let s = "";
    for (const p of page) if (p.row.draw) s += p.row.draw(p.top);
    s += pageFurniture(opts, hPt, left, right, i, pages.length);
    w.putStream(content, "", s);
  });

  w.put(
    info,
    `<< /Title ${pdfInfoStr(opts.title)} /Producer (GridDown) /Creator (GridDown) >>`
  );
  return w.finish(catalog, info);
}

/** The running header and footer — everything on a page that is not content. */
function pageFurniture(
  opts: TextDocOpts,
  hPt: number,
  left: number,
  right: number,
  index: number,
  total: number
): string {
  let s = "";
  const wide = glyphCols(right - left, SMALL_PT);
  // Continuation pages repeat the title small at the top. A printed plan is
  // read as loose sheets, and a sheet that does not say which document it
  // belongs to is a sheet you cannot file back.
  if (index > 0) {
    const hy = hPt - MARGIN_PT - SMALL_PT;
    s += textAt(left, hy, SMALL_PT, "F1", fitOneLine(plainText(opts.title), wide));
    s += ruleAt(left, hy - 5, right, 0.5);
  }
  // Footer rule, then the strip beneath it.
  const fy = MARGIN_PT + FOOTER_H - 10;
  s += ruleAt(left, fy, right, 0.5);
  // "Page 2 of 5" and not just "2": loose sheets get separated, and the total
  // is the only thing on the page that reveals a missing one. It is laid out
  // first because it is the part that must not be squeezed out.
  const num = `Page ${index + 1} of ${total}`;
  if (opts.footer) {
    s += textAt(
      left,
      MARGIN_PT + 4,
      SMALL_PT,
      "F1",
      fitOneLine(plainText(opts.footer), wide - num.length - 2)
    );
  }
  s += textAt(
    right - num.length * SMALL_PT * COURIER_EM,
    MARGIN_PT + 4,
    SMALL_PT,
    "F1",
    num
  );
  return s;
}

/**
 * Group an MGRS string the way it is written and read aloud.
 *
 * "10TER1234567890" is a wall of digits; "10T ER 12345 67890" is four things
 * you can read off a page and say over a radio without losing your place —
 * which is the only reason the grid reference is printed at all. Anything that
 * doesn't match the expected shape is passed through untouched rather than
 * chopped up on a guess.
 */
export function fmtMgrs(s: string): string {
  const m = s.match(/^(\d{1,2}[C-X])([A-Z]{2})(\d+)$/);
  // The digits are an easting and a northing of equal length, so an odd count
  // is not an MGRS reference. Splitting it anyway silently mis-pairs the two
  // halves — "10TER123" became "10T ER 1 23", which reads as a real location.
  if (!m || m[3].length % 2 !== 0) return s;
  const half = m[3].length / 2;
  return `${m[1]} ${m[2]} ${m[3].slice(0, half)} ${m[3].slice(half)}`;
}

/** The ground a printed map image covers. */
export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Web Mercator's y, the only non-linear part of projecting a north-up map. */
function mercatorY(latDeg: number): number {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latDeg));
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

/**
 * Ground position → position within a north-up Mercator image.
 *
 * Exact rather than approximate: Mercator is linear in longitude and in
 * mercatorY, so knowing the image's bounds is enough. Approximating with a
 * single metres-per-pixel figure would bend a grid line by metres at the top
 * of the page and none at the bottom, which is visible on paper.
 */
export function projectToImage(
  lng: number,
  lat: number,
  bounds: MapBounds,
  width: number,
  height: number
): [number, number] {
  const yTop = mercatorY(bounds.north);
  const yBottom = mercatorY(bounds.south);
  const x = ((lng - bounds.west) / (bounds.east - bounds.west)) * width;
  const y = ((yTop - mercatorY(lat)) / (yTop - yBottom)) * height;
  return [x, y];
}
