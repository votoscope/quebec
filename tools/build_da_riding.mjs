/**
 * Rattachement des aires de diffusion 2021 (ISQ) aux circonscriptions des
 * cartes 2017 et 2026, par point-dans-polygone du centroïde.
 *
 * Sortie : js/data/qc_da_riding.json
 *   { "2026": {ADIDU: code numérique}, "2017": {ADIDU: nom de
 *     circonscription tel que dans qc_riding_results.json} }
 *
 * Run: node js/tools/build_da_riding.mjs   (from the repo root)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { disseminationAreas, ridingLocator } from "./lib/geo.mjs";
import { nameKey } from "./lib/harness.mjs";

const results = JSON.parse(readFileSync(new URL("../data/qc_riding_results.json", import.meta.url), "utf-8"));
const names2017 = new Map(
  [...new Set(results.filter((r) => String(r.boundary_year) === "2017").map((r) => r.riding_code))].map((n) => [nameKey(n), n]),
);

const locate2026 = ridingLocator(new URL("../data/qc_ridings_2026.geojson", import.meta.url), (p) => String(p.riding_code));
const locate2017 = ridingLocator(new URL("../data/raw/lus/qc_ridings_2017.geojson", import.meta.url), (p) => names2017.get(nameKey(p.riding_name)) ?? `?${p.riding_name}`);

const out = { 2026: {}, 2017: {} };
let n = 0, miss = { 2026: 0, 2017: 0 };
const unknown = new Set();
for await (const { props, lon, lat } of disseminationAreas()) {
  const id = String(props.ADIDU ?? "").trim();
  if (!id || !(Number(props.Population) > 0)) continue;
  n++;
  const a = locate2026(lon, lat), b = locate2017(lon, lat);
  if (a) out[2026][id] = a; else miss[2026]++;
  if (b && !b.startsWith("?")) out[2017][id] = b; else { miss[2017]++; if (b) unknown.add(b); }
}
writeFileSync(new URL("../data/qc_da_riding.json", import.meta.url), JSON.stringify(out));
console.log(`${n} AD peuplées ; non rattachées : 2026 ${miss[2026]}, 2017 ${miss[2017]}`);
console.log(`circonscriptions : 2026 ${new Set(Object.values(out[2026])).size}, 2017 ${new Set(Object.values(out[2017])).size}`);
if (unknown.size) console.log("noms 2017 sans correspondance :", [...unknown].join(", "));
