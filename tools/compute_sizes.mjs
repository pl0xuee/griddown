// Compute accurate per-state basemap sizes via `pmtiles extract --dry-run`
// and update public/states.json in place. Requires internet.
import { readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";

const PM = new URL("./pmtiles", import.meta.url).pathname;
const STATES = new URL("../public/states.json", import.meta.url).pathname;

function findBuild() {
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const s = d.toISOString().slice(0, 10).replace(/-/g, "");
    const url = `https://build.protomaps.com/${s}.pmtiles`;
    const r = spawnSync(PM, ["show", url], { encoding: "utf8" });
    if ((r.stdout || "").includes("spec version")) return url;
  }
  throw new Error("no recent build");
}

const planet = findBuild();
console.log("planet:", planet);
const states = JSON.parse(readFileSync(STATES, "utf8"));

for (const st of states) {
  const r = spawnSync(
    PM,
    ["extract", planet, "/tmp/_sz.pmtiles", `--bbox=${st.bbox.join(",")}`, "--maxzoom=15", "--dry-run"],
    { encoding: "utf8" }
  );
  const text = (r.stdout || "") + (r.stderr || "");
  const m = text.match(/archive size of ([\d.]+)\s*(MB|GB|KB)/i);
  if (m) {
    let mb = parseFloat(m[1]);
    if (/GB/i.test(m[2])) mb *= 1024;
    if (/KB/i.test(m[2])) mb /= 1024;
    st.estMB = Math.max(1, Math.round(mb));
    console.log(`${st.abbr} ${st.name}: ${st.estMB} MB`);
  } else {
    console.log(`${st.abbr}: (no size parsed)`);
  }
}

writeFileSync(STATES, "[\n " + states.map((o) => JSON.stringify(o)).join(",\n ") + "\n]\n");
console.log("updated states.json");
