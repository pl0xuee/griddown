import maplibregl from "maplibre-gl";
import { forward as mgrsForward } from "mgrs";
import { toast } from "./toast";
import { saveFile } from "./save";
import { PAPERS, niceBar, scaleRatio, jpegToPdf } from "./paper";

// Printable map export — the paper backup.
//
// Paper is the only fallback that survives a dead battery. This renders the
// current view offscreen at print resolution (always in the light theme —
// dark maps waste ink and scan badly), composes it into a titled page with
// scale bars, north arrow and the center's MGRS grid, and saves a PDF built
// entirely offline (see paper.ts).

interface PrintDeps {
  /** The live map — we copy its center/zoom for the print view. */
  getMap: () => maplibregl.Map;
  /** Style builder for the print render (light theme, current source). */
  printStyle: () => maplibregl.StyleSpecification;
  /** Name shown under the title, e.g. the active region/state. */
  regionName: () => string;
}

/** Canvas pixels per PDF point — 3 ≈ 216 DPI on paper. */
const S = 3;
const MARGIN = 20; // pt, left/right
const HEADER = 46; // pt
const FOOTER = 58; // pt
const RENDER_TIMEOUT_MS = 45000;

function fmtMgrs(s: string): string {
  const m = s.match(/^(\d{1,2}[C-X])([A-Z]{2})(\d+)$/);
  if (!m) return s;
  const half = m[3].length / 2;
  return `${m[1]} ${m[2]} ${m[3].slice(0, half)} ${m[3].slice(half)}`;
}

/** Render the live map's view offscreen at print size; resolve with the JPEG + ground scale. */
function renderOffscreen(
  live: maplibregl.Map,
  style: maplibregl.StyleSpecification,
  cssW: number,
  cssH: number
): Promise<{ jpegUrl: string; pxW: number; pxH: number; mPerCssPx: number }> {
  return new Promise((resolve, reject) => {
    const holder = document.createElement("div");
    // Attached but invisible — MapLibre needs a laid-out element to render.
    holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${cssW}px;height:${cssH}px;`;
    document.body.appendChild(holder);

    let m: maplibregl.Map | null = null;
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      try {
        m?.remove();
      } catch {
        /* already gone */
      }
      holder.remove();
    };

    try {
      m = new maplibregl.Map({
        container: holder,
        style,
        center: live.getCenter(),
        zoom: live.getZoom(),
        bearing: 0, // paper maps are north-up
        pitch: 0,
        interactive: false,
        attributionControl: false,
        pixelRatio: S,
        // Required for toDataURL — the default drops the buffer after present.
        canvasContextAttributes: { preserveDrawingBuffer: true },
      });
    } catch (e) {
      cleanup();
      reject(e);
      return;
    }

    timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("map render timed out"));
    }, RENDER_TIMEOUT_MS);

    m.once("idle", () => {
      try {
        const mm = m!;
        // Ground meters per CSS pixel, measured (no zoom-formula assumptions).
        const y = cssH / 2;
        const a = mm.unproject([cssW / 2 - 50, y]);
        const b = mm.unproject([cssW / 2 + 50, y]);
        const mPerCssPx = a.distanceTo(b) / 100;
        const canvas = mm.getCanvas();
        const jpegUrl = canvas.toDataURL("image/jpeg", 0.92);
        const pxW = canvas.width;
        const pxH = canvas.height;
        cleanup();
        if (jpegUrl.length < 2000) {
          // A blank/failed capture encodes to almost nothing.
          reject(new Error("empty map capture"));
          return;
        }
        resolve({ jpegUrl, pxW, pxH, mPerCssPx });
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
    m.once("error", (e) => {
      cleanup();
      reject((e as any).error ?? new Error("map error"));
    });
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = url;
  });
}

function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  yTop: number,
  mPerPagePt: number,
  maxWidthPt: number
) {
  // Two bars sharing a left edge: imperial above, metric below.
  const bars = [
    niceBar(maxWidthPt * mPerPagePt, "imperial"),
    niceBar(maxWidthPt * mPerPagePt, "metric"),
  ];
  ctx.save();
  ctx.strokeStyle = "#222";
  ctx.fillStyle = "#222";
  ctx.lineWidth = S;
  ctx.font = `${9 * S}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  bars.forEach((bar, i) => {
    if (!bar.meters) return;
    const wPx = (bar.meters / mPerPagePt) * S;
    const y = (yTop + 6 + i * 14) * S;
    ctx.beginPath();
    // Bar with end ticks.
    ctx.moveTo(x * S, y - 4 * S);
    ctx.lineTo(x * S, y);
    ctx.lineTo(x * S + wPx, y);
    ctx.lineTo(x * S + wPx, y - 4 * S);
    ctx.stroke();
    ctx.fillText(bar.label, x * S + wPx + 5 * S, y - 2 * S);
  });
  ctx.restore();
}

function drawNorthArrow(ctx: CanvasRenderingContext2D, cxPt: number, cyPt: number) {
  const cx = cxPt * S;
  const cy = cyPt * S;
  const h = 14 * S;
  ctx.save();
  ctx.strokeStyle = "#222";
  ctx.fillStyle = "#222";
  ctx.lineWidth = S;
  ctx.beginPath();
  ctx.moveTo(cx, cy + h / 2);
  ctx.lineTo(cx, cy - h / 2 + 5 * S);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - h / 2);
  ctx.lineTo(cx - 3.5 * S, cy - h / 2 + 6 * S);
  ctx.lineTo(cx + 3.5 * S, cy - h / 2 + 6 * S);
  ctx.closePath();
  ctx.fill();
  ctx.font = `bold ${8 * S}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("N", cx, cy + h / 2 + 8 * S);
  ctx.restore();
}

function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function initPrint(deps: PrintDeps) {
  const panel = document.getElementById("print-panel");
  const btn = document.getElementById("print-export") as HTMLButtonElement | null;
  const status = document.getElementById("print-status");

  const setStatus = (s: string) => {
    if (status) status.textContent = s;
  };

  document.getElementById("print-open")?.addEventListener("click", () => {
    setStatus("");
    panel?.classList.remove("hidden");
  });
  document.getElementById("print-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });

  btn?.addEventListener("click", async () => {
    const paperKey =
      (document.getElementById("print-paper") as HTMLSelectElement | null)?.value ??
      "letter";
    const landscape =
      ((document.getElementById("print-orient") as HTMLSelectElement | null)?.value ??
        "landscape") === "landscape";
    const customTitle =
      (document.getElementById("print-title") as HTMLInputElement | null)?.value.trim() ??
      "";

    const paper = PAPERS[paperKey] ?? PAPERS.letter;
    const pageW = landscape ? paper.hPt : paper.wPt;
    const pageH = landscape ? paper.wPt : paper.hPt;
    const mapW = pageW - MARGIN * 2;
    const mapH = pageH - HEADER - FOOTER;

    btn.disabled = true;
    setStatus("Rendering map at print resolution…");
    try {
      const live = deps.getMap();
      const shot = await renderOffscreen(live, deps.printStyle(), mapW, mapH);

      setStatus("Composing page…");
      const img = await loadImage(shot.jpegUrl);

      const page = document.createElement("canvas");
      page.width = pageW * S;
      page.height = pageH * S;
      const ctx = page.getContext("2d");
      if (!ctx) throw new Error("no 2d canvas");

      // Page background + map image + frame.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, page.width, page.height);
      ctx.drawImage(img, MARGIN * S, HEADER * S, mapW * S, mapH * S);
      ctx.strokeStyle = "#222";
      ctx.lineWidth = S;
      ctx.strokeRect(MARGIN * S, HEADER * S, mapW * S, mapH * S);

      // Header: title left, date right.
      const c = live.getCenter();
      const title = customTitle || deps.regionName() || "GridDown map";
      ctx.fillStyle = "#111";
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.font = `bold ${16 * S}px system-ui, sans-serif`;
      ctx.fillText(title, MARGIN * S, 26 * S);
      ctx.font = `${9 * S}px system-ui, sans-serif`;
      ctx.fillStyle = "#444";
      ctx.fillText("GRIDDOWN · offline map", MARGIN * S, 38 * S);
      ctx.textAlign = "right";
      const date = new Date().toISOString().slice(0, 10);
      ctx.fillText(`printed ${date}`, (pageW - MARGIN) * S, 38 * S);

      // Footer: center coords left, scale bars middle, north arrow right.
      const fTop = pageH - FOOTER;
      ctx.textAlign = "left";
      ctx.fillStyle = "#222";
      ctx.font = `${9 * S}px ui-monospace, monospace`;
      let grid = "";
      try {
        grid = fmtMgrs(mgrsForward([c.lng, c.lat], 5));
      } catch {
        /* outside MGRS range */
      }
      const latlng = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
      ctx.fillText(`Center: ${grid || latlng}`, MARGIN * S, (fTop + 16) * S);
      ctx.font = `${8 * S}px ui-monospace, monospace`;
      ctx.fillStyle = "#555";
      if (grid) ctx.fillText(latlng, MARGIN * S, (fTop + 27) * S);

      // Scale: ground meters per point of paper inside the map frame.
      const mPerPagePt = shot.mPerCssPx; // rendered at 1 CSS px per pt
      drawScaleBar(ctx, pageW * 0.42, fTop + 6, mPerPagePt, pageW * 0.22);
      ctx.fillStyle = "#555";
      ctx.font = `${8 * S}px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(
        `Scale ${scaleRatio(mPerPagePt)} (approx., at center)`,
        pageW * 0.42 * S,
        (fTop + 44) * S
      );

      drawNorthArrow(ctx, pageW - MARGIN - 12, fTop + 18);

      // Attribution — required by OSM, and honest besides.
      ctx.fillStyle = "#777";
      ctx.font = `${7 * S}px system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.fillText(
        "Map data © OpenStreetMap contributors",
        (pageW - MARGIN - 26) * S,
        (fTop + 44) * S
      );

      setStatus("Writing PDF…");
      const jpeg = dataUrlToBytes(page.toDataURL("image/jpeg", 0.9));
      const pdf = jpegToPdf(jpeg, pageW, pageH, page.width, page.height, title);

      await saveFile(`griddown-map-${date}.pdf`, pdf, "application/pdf");

      setStatus("");
      panel?.classList.add("hidden");
    } catch (e) {
      console.error("[print]", e);
      setStatus("");
      toast(`Couldn't export: ${e instanceof Error ? e.message : e}`, "error");
    } finally {
      btn.disabled = false;
    }
  });
}
