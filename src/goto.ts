import maplibregl from "maplibre-gl";
import { toPoint as mgrsToPoint } from "mgrs";
import { toast } from "./toast";

// Jump to a coordinate someone gives you — an MGRS grid ("18T VK 1234 5678")
// or a plain "lat, lng". The inverse of the coordinate readout. Fully offline.

// Returns [lng, lat] or null if unparseable.
function parseCoord(raw: string): [number, number] | null {
  const s = raw.trim();
  if (!s) return null;

  // "lat, lng" or "lat lng" (matches the readout's copy format order)
  const ll = s.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (ll) {
    const lat = parseFloat(ll[1]);
    const lng = parseFloat(ll[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return [lng, lat];
    return null;
  }

  // MGRS / USNG (spaces optional)
  try {
    const pt = mgrsToPoint(s.replace(/\s+/g, "").toUpperCase());
    if (pt && isFinite(pt[0]) && isFinite(pt[1])) return [pt[0], pt[1]];
  } catch {
    /* not MGRS */
  }
  return null;
}

export function initGoto(map: maplibregl.Map) {
  const box = document.getElementById("goto-box");
  const input = document.getElementById("goto-input") as HTMLInputElement | null;
  let marker: maplibregl.Marker | null = null;

  function open() {
    box?.classList.remove("hidden");
    input?.focus();
    input?.select();
  }
  function close() {
    box?.classList.add("hidden");
  }

  function go() {
    if (!input) return;
    const pt = parseCoord(input.value);
    if (!pt) {
      toast("Couldn't read that — try an MGRS grid or “lat, lng”.", "error");
      return;
    }
    marker?.remove();
    const el = document.createElement("div");
    el.className = "goto-marker";
    marker = new maplibregl.Marker({ element: el }).setLngLat(pt).addTo(map);
    map.flyTo({ center: pt, zoom: Math.max(map.getZoom(), 13) });
    toast(`Jumped to ${pt[1].toFixed(5)}, ${pt[0].toFixed(5)}`, "success");
    close();
  }

  document.getElementById("goto-open")?.addEventListener("click", open);
  document.getElementById("goto-close")?.addEventListener("click", close);
  document.getElementById("goto-go")?.addEventListener("click", go);
  document.getElementById("goto-clear")?.addEventListener("click", () => {
    marker?.remove();
    marker = null;
    if (input) input.value = "";
    close();
  });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
    if (e.key === "Escape") close();
  });
}
