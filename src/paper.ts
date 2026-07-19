// Pure paper-map math + a minimal PDF writer. No DOM, no map — testable.
//
// The PDF side is deliberately hand-rolled: one page, one JPEG, ~100 lines.
// It keeps the export fully offline with zero dependencies, which is the
// whole point of this app.

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
  const chunks: Uint8Array[] = [];
  let length = 0;
  const offsets: number[] = [0]; // object 0 is the free-list head
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === "string" ? enc.encode(b) : b;
    chunks.push(bytes);
    length += bytes.length;
  };
  const beginObj = (n: number, body?: string) => {
    offsets[n] = length;
    if (body !== undefined) push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  // PDF strings need () and \ escaped; keep plain ASCII so the bytes written
  // by TextEncoder (UTF-8) match what a PDF literal string means.
  const pdfStr = (s: string) =>
    s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "");

  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"); // binary marker comment
  beginObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  beginObj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  beginObj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
  );

  // Image XObject (DCTDecode = raw JPEG passthrough).
  beginObj(4);
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${jpegW} /Height ${jpegH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
      `/Length ${jpeg.length} >>\nstream\n`
  );
  push(jpeg);
  push(`\nendstream\nendobj\n`);

  // Content stream: scale the unit image square up to the page.
  const content = `q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`;
  beginObj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  beginObj(
    6,
    `<< /Title (${pdfStr(title)}) /Producer (GridDown) /Creator (GridDown) >>`
  );

  const xrefAt = length;
  let xref = `xref\n0 7\n0000000000 65535 f \n`;
  for (let i = 1; i <= 6; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  push(
    xref +
      `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  );

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
