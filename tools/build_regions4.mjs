/**
 * Build the 4-region riding map: ILE (île de Montréal), CRO (couronne de
 * Montréal), QC (RMR de Québec), REG (reste du Québec).
 *
 * The 3-region map (MTL/QC/REG) merges the island of Montréal with its
 * suburbs, diluting the CAQ's strength in the couronne (Synopsis: CAQ 32%
 * RMR-hors-île vs 15% sur l'île). The 2026 post-mortem measured the cost
 * of the coarse split at ~10 seats.
 *
 * Classification: the 25 ridings on the island of Montréal are ILE; the
 * remaining 31 MTL ridings (Laval, Laurentides, Lanaudière, Montérégie)
 * are CRO. QC and REG are unchanged.
 *
 * Run: node js/tools/build_regions4.mjs   (from the repo root)
 */

import { readFileSync, writeFileSync } from "node:fs";

const geo = JSON.parse(readFileSync(new URL("../data/qc_ridings_2026.geojson", import.meta.url), "utf-8"));
const regions3 = JSON.parse(readFileSync(new URL("../data/qc_riding_regions.json", import.meta.url), "utf-8"));
const region3ByCode = new Map(regions3.map((r) => [String(r.riding_code), r.region_code]));

// 25 ridings on the island of Montréal (2026 map)
const ILE_NAMES = new Set([
  "Acadie",
  "Anjou–Louis-Riel",
  "Bourassa-Sauvé",
  "Camille-Laurin",
  "D'Arcy-McGee",
  "Gouin",
  "Hochelaga-Maisonneuve",
  "Jeanne-Mance–Viger",
  "LaFontaine",
  "Laurier-Dorion",
  "Marguerite-Bourgeoys",
  "Marquette",
  "Maurice-Richard",
  "Mercier",
  "Mont-Royal–Outremont",
  "Nelligan",
  "Notre-Dame-de-Grâce",
  "Pointe-aux-Trembles",
  "Robert-Baldwin",
  "Rosemont",
  "Saint-Henri–Sainte-Anne",
  "Saint-Laurent",
  "Verdun",
  "Viau",
  "Westmount–Saint-Louis",
]);

const out = [];
for (const f of geo.features) {
  const code = String(f.properties.riding_code);
  const name = f.properties.riding_name;
  const r3 = region3ByCode.get(code);
  let r4;
  if (r3 === "MTL") {
    r4 = ILE_NAMES.has(name) ? "ILE" : "CRO";
  } else {
    r4 = r3;
  }
  out.push({ riding_code: code, region3: r3, region4: r4, riding_name: name });
}

// Electoral weights per 4-region (from 2022 baseline votes)
const baseline = JSON.parse(readFileSync(new URL("../data/qc_2022_baseline_2026map.json", import.meta.url), "utf-8"));
const w4 = { ILE: 0, CRO: 0, QC: 0, REG: 0 };
const r4ByCode = new Map(out.map((r) => [r.riding_code, r.region4]));
for (const row of baseline) {
  const r = r4ByCode.get(String(row.riding_code));
  if (r) w4[r] += row.votes;
}
const wTot = Object.values(w4).reduce((a, b) => a + b, 0);
for (const k of Object.keys(w4)) w4[k] /= wTot;

const counts = {};
for (const r of out) counts[r.region4] = (counts[r.region4] ?? 0) + 1;

writeFileSync(
  new URL("../data/qc_riding_regions4.json", import.meta.url),
  JSON.stringify({ regions: out, weights: w4 }, null, 2),
  "utf-8"
);

console.log("Distribution 4 régions:");
for (const [r, n] of Object.entries(counts)) {
  console.log(`  ${r}: ${n} circonscriptions (${(w4[r] * 100).toFixed(1)}% des votes)`);
}
console.log(`\nSauvegardé dans js/data/qc_riding_regions4.json`);
