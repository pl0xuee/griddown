import maplibregl from "maplibre-gl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { esc } from "./esc";
import { toast } from "./toast";
import {
  displayName,
  formatAge,
  formatBattery,
  freshness,
  relativeTo,
  sortNodes,
  type MeshNode,
} from "./meshnode";
import type { LL } from "./geo";

// Teammate positions over Meshtastic — where your group is, with no internet
// and no cell coverage.
//
// The radio does the hard part: LoRa nodes gossip their positions across a mesh
// that needs no infrastructure at all. This plots what arrives, and is careful
// about how old each position is (see meshnode.ts) because a mesh fix is always
// some minutes behind reality and a stale one looks identical to a fresh one.
//
// The transport lives behind MeshFeed so the map and panel can be exercised
// without a radio — see the simulated feed below, which is how this was
// developed and is the only way it has been run so far.

const SRC = "gd-mesh";
const LAYER_FUZZ = "gd-mesh-fuzz";
const LAYER_HALO = "gd-mesh-halo";
const LAYER_DOT = "gd-mesh-dot";
const LAYER_LABEL = "gd-mesh-label";

/** Colour by how recent the fix is — the same grading meshnode.ts defines. */
const FRESH_COLOR: Record<string, string> = {
  live: "#4ade4a",
  recent: "#ffd54f",
  stale: "#ff9f45",
  old: "#8d8d8d",
};

export interface MeshFeed {
  readonly name: string;
  start(onNodes: (nodes: MeshNode[]) => void, onStatus: (s: string) => void): Promise<void>;
  stop(): void;
}

/**
 * A fake mesh, for developing and demonstrating without hardware.
 *
 * It is deliberately not a perfect mesh: one node goes quiet partway through,
 * because "a teammate stopped reporting" is the case the display most needs to
 * handle honestly, and a simulator that only ever produces fresh positions
 * would hide exactly the bug worth catching.
 */
export function simulatedFeed(center: () => LL): MeshFeed {
  let timer = 0;
  return {
    name: "Simulation",
    async start(onNodes, onStatus) {
      onStatus("Simulated mesh — no radio connected");
      const [lng, lat] = center();
      const started = Math.floor(Date.now() / 1000);
      const seeds = [
        { num: 0x7c3f0a1b, longName: "Dad's truck", shortName: "DAD", dx: 0.03, dy: 0.02, battery: 84 },
        { num: 0x51ba22c9, longName: "Camp", shortName: "CAMP", dx: -0.05, dy: 0.01, battery: 101 },
        { num: 0x2f9d4471, longName: "Scout", shortName: "SCT", dx: 0.01, dy: -0.04, battery: 37 },
        { num: 0x9a10ee02, longName: "Ridge relay", shortName: "RDG", dx: -0.02, dy: -0.03, battery: 62 },
      ];
      let tick = 0;
      const emit = () => {
        const now = Math.floor(Date.now() / 1000);
        tick++;
        const nodes: MeshNode[] = seeds.map((s, i) => {
          // The scout wanders; the others sit still. After a while the ridge
          // relay stops reporting, so its fix ages on screen.
          const drift = s.shortName === "SCT" ? tick * 0.0016 : 0;
          const quiet = s.shortName === "RDG" && tick > 3;
          return {
            num: s.num,
            id: `!${(s.num >>> 0).toString(16).padStart(8, "0")}`,
            longName: s.longName,
            shortName: s.shortName,
            lat: lat + s.dy + drift,
            lng: lng + s.dx + drift * 0.5,
            altitude: 300 + i * 120,
            posTime: quiet ? started : now,
            lastHeard: quiet ? started : now,
            battery: s.battery,
            snr: [8.5, 4.25, -2.5, 1.75][i],
            hops: [0, 0, 1, 2][i],
          };
        });
        onNodes(nodes);
      };
      emit();
      timer = window.setInterval(emit, 5000);
    },
    stop() {
      window.clearInterval(timer);
      timer = 0;
    },
  };
}

/** Default host for a WiFi-connected radio; Meshtastic advertises this name. */
export const DEFAULT_HOST = "meshtastic.local";
export const DEFAULT_PORT = 4403;
export const MESH_HOST_KEY = "griddown_mesh_host";

/**
 * A real radio over TCP — the Stream API on port 4403.
 *
 * TCP rather than USB serial because it is the one transport that works the
 * same on Linux, Windows and iOS: no drivers, no pairing, no MFi problem. The
 * radio has to be in WiFi mode and reachable on the network.
 */
export function radioFeed(host: string, port: number): MeshFeed {
  let unlistenNodes: UnlistenFn | null = null;
  let unlistenStatus: UnlistenFn | null = null;
  return {
    name: `${host}:${port}`,
    async start(onNodes, onStatus) {
      unlistenNodes = await listen<MeshNode[]>("mesh-nodes", (e) => onNodes(e.payload));
      unlistenStatus = await listen<string>("mesh-status", (e) => onStatus(e.payload));
      onStatus(`Connecting to ${host}:${port}…`);
      try {
        await invoke("mesh_connect", { host, port });
      } catch (err) {
        onStatus(String(err));
        throw err;
      }
    },
    stop() {
      unlistenNodes?.();
      unlistenStatus?.();
      unlistenNodes = null;
      unlistenStatus = null;
      void invoke("mesh_disconnect").catch(() => {});
    },
  };
}

export function initMesh(deps: {
  map: () => maplibregl.Map;
  /** Where "you" are, for distance and bearing — map centre if there's no fix. */
  here: () => LL;
  /** The real radio transport, when one is available. */
  radioFeed?: () => MeshFeed;
}) {
  const panel = document.getElementById("mesh-panel");
  const body = document.getElementById("mesh-body");
  const statusEl = document.getElementById("mesh-status");

  let nodes: MeshNode[] = [];
  let feed: MeshFeed | null = null;
  let status = "Not connected";

  function toGeoJson(): any {
    const now = Math.floor(Date.now() / 1000);
    return {
      type: "FeatureCollection",
      features: nodes
        .filter((n) => n.lat != null && n.lng != null)
        .map((n) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [n.lng, n.lat] },
          properties: {
            id: n.id,
            label: n.shortName?.trim() || displayName(n).slice(0, 8),
            color: FRESH_COLOR[freshness(n.posTime, now)],
            // Deliberately-fuzzed positions draw as a circle of their real
            // uncertainty. A pin would claim precision the sender chose to
            // discard — at 16 bits that is a third of a mile of slack.
            uncertainty: n.uncertaintyM ?? 0,
            // Old fixes draw smaller and dimmer: a week-old position should not
            // sit on the map with the same weight as one from a minute ago.
            fade: freshness(n.posTime, now) === "old" ? 0.45 : 1,
          },
        })),
    };
  }

  function refreshMap() {
    const map = deps.map();
    const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    if (src) {
      src.setData(toGeoJson());
      return;
    }
    if (!nodes.length) return;
    map.addSource(SRC, { type: "geojson", data: toGeoJson() });
    // Uncertainty first, underneath everything: it is context, not the fix.
    map.addLayer({
      id: LAYER_FUZZ,
      type: "circle",
      source: SRC,
      filter: [">", ["get", "uncertainty"], 0],
      paint: {
        // metres → pixels, which is zoom- and latitude-dependent.
        "circle-radius": [
          "interpolate",
          ["exponential", 2],
          ["zoom"],
          8,
          ["/", ["get", "uncertainty"], 611],
          16,
          ["/", ["get", "uncertainty"], 2.39],
        ],
        "circle-color": ["get", "color"],
        "circle-opacity": 0.1,
        "circle-stroke-width": 1,
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-opacity": 0.35,
      },
    });
    map.addLayer({
      id: LAYER_HALO,
      type: "circle",
      source: SRC,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 8, 14, 18],
        "circle-color": ["get", "color"],
        "circle-opacity": ["*", 0.18, ["get", "fade"]],
        "circle-stroke-width": 1,
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-opacity": ["*", 0.5, ["get", "fade"]],
      },
    });
    map.addLayer({
      id: LAYER_DOT,
      type: "circle",
      source: SRC,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 3.5, 14, 6.5],
        "circle-color": ["get", "color"],
        "circle-opacity": ["get", "fade"],
        "circle-stroke-width": 1.5,
        "circle-stroke-color": "#0b0f0b",
      },
    });
    map.addLayer({
      id: LAYER_LABEL,
      type: "symbol",
      source: SRC,
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11,
        "text-font": ["Noto Sans Regular"],
        "text-offset": [0, 1.3],
        "text-anchor": "top",
      },
      paint: {
        "text-color": "#eafcea",
        "text-halo-color": "#0b0f0b",
        "text-halo-width": 1.6,
        "text-opacity": ["get", "fade"],
      },
    });
  }

  function removeMap() {
    const map = deps.map();
    for (const id of [LAYER_LABEL, LAYER_DOT, LAYER_HALO, LAYER_FUZZ]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(SRC)) map.removeSource(SRC);
  }

  function render() {
    if (statusEl) statusEl.textContent = status;
    if (!body) return;

    if (!feed) {
      const host = localStorage.getItem(MESH_HOST_KEY) || DEFAULT_HOST;
      body.innerHTML = `
        <div class="mesh-intro">Plot where your group is over LoRa mesh radio —
        no internet, no cell towers. Each node broadcasts its position to every
        other node in range, and hops onward through the mesh.</div>
        <label class="mesh-label">Radio address
          <input id="mesh-host" type="text" value="${esc(host)}"
                 placeholder="${DEFAULT_HOST}" autocomplete="off" spellcheck="false" />
        </label>
        <button id="mesh-connect" type="button" class="mesh-go">Connect</button>
        <button id="mesh-sim" type="button" class="mesh-alt">Show a simulated mesh</button>
        <div class="mesh-fine">Needs the radio in WiFi mode on the same network,
        listening on port ${DEFAULT_PORT}. No radio has ever been connected to
        this build — it has only been run against the simulation, so treat the
        first real connection as the test.</div>`;
      wire();
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const from = deps.here();
    const sorted = sortNodes(nodes, from);
    const rows = sorted.length
      ? sorted
          .map((n) => {
            const rel = relativeTo(from, n);
            const fresh = freshness(n.posTime, now);
            const bits = [
              rel ? esc(rel.text) : "no position",
              formatAge(n.posTime, now),
              formatBattery(n.battery),
              n.hops != null ? (n.hops === 0 ? "direct" : `${n.hops} hop${n.hops > 1 ? "s" : ""}`) : "",
            ].filter(Boolean);
            return `<div class="mesh-node mesh-${fresh}" data-go="${esc(n.id)}">
                <div class="mesh-dot"></div>
                <div class="mesh-n">
                  <div class="mesh-name">${esc(displayName(n))}</div>
                  <div class="mesh-meta">${bits.map(esc).join(" · ")}</div>
                </div>
              </div>`;
          })
          .join("")
      : `<div class="mesh-empty">No nodes heard yet. They appear as they report in.</div>`;

    body.innerHTML = `${rows}
      <button id="mesh-stop" type="button" class="mesh-alt">Disconnect</button>
      <div class="mesh-fine">Positions are as old as the last broadcast — the
      age beside each name is the truth, not the dot on the map.</div>`;
    wire();
  }

  function wire() {
    document.getElementById("mesh-sim")?.addEventListener("click", () => {
      void connect(simulatedFeed(() => deps.here()));
    });
    document.getElementById("mesh-connect")?.addEventListener("click", () => {
      const input = document.getElementById("mesh-host") as HTMLInputElement | null;
      const raw = (input?.value || "").trim() || DEFAULT_HOST;
      // Accept "host", "host:port" and a pasted "tcp://host:port".
      const cleaned = raw.replace(/^\w+:\/\//, "");
      const [host, portText] = cleaned.split(":");
      const port = Number(portText) || DEFAULT_PORT;
      if (!host) {
        toast("Enter the radio's address.", "error");
        return;
      }
      localStorage.setItem(MESH_HOST_KEY, raw);
      void connect(deps.radioFeed ? deps.radioFeed() : radioFeed(host, port)).catch(() => {
        // connect() already surfaced the reason on the status line.
        disconnect();
      });
    });
    document.getElementById("mesh-stop")?.addEventListener("click", disconnect);
    document.querySelectorAll<HTMLElement>("[data-go]").forEach((el) => {
      el.addEventListener("click", () => {
        const n = nodes.find((x) => x.id === el.dataset.go);
        if (n?.lat != null && n?.lng != null) {
          deps.map().flyTo({ center: [n.lng, n.lat], zoom: Math.max(deps.map().getZoom(), 12) });
        }
      });
    });
  }

  async function connect(f: MeshFeed) {
    disconnect();
    feed = f;
    status = `Connecting via ${f.name}…`;
    render();
    await f.start(
      (list) => {
        nodes = list;
        refreshMap();
        render();
      },
      (s) => {
        status = s;
        render();
      }
    );
  }

  function disconnect() {
    feed?.stop();
    feed = null;
    nodes = [];
    status = "Not connected";
    removeMap();
    render();
  }

  document.getElementById("mesh-open")?.addEventListener("click", () => {
    render();
    panel?.classList.remove("hidden");
  });
  document.getElementById("mesh-close")?.addEventListener("click", () => {
    panel?.classList.add("hidden");
  });

  // A style rebuild drops custom sources — put the nodes back.
  deps.map().on("style.load", () => {
    if (feed && nodes.length) refreshMap();
  });

  // Ages tick over even when nothing new arrives, and a position going stale is
  // itself information — so the list re-renders on a timer, not only on packets.
  window.setInterval(() => {
    if (feed && !panel?.classList.contains("hidden")) {
      refreshMap();
      render();
    }
  }, 30000);
}
