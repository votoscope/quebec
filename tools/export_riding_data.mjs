/**
 * Export riding-effects training data to JSON for the XGBoost test.
 *
 * Exports the same X (features) and Y (targets) used by the GP Matérn model:
 *   - Training: 2014->2018 (prev residual) -> 2018->2022 (curr residual)
 *   - On the 2017 map, with demographics + previous residual as features.
 *
 * Also exports the 2022->2026 transition (2026 map) for inter-transition
 * validation (anti-transfer test).
 *
 * Run: node js/tools/export_riding_data.mjs   (from the repo root)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { buildFeatureMatrix, residualIlr, PARTIES, ilrMatrix } from "../src/ridingEffects.js";

const { ilr } = mva.composition;

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const ridingResults = load("../data/qc_riding_results.json");
const features2017 = load("../data/qc_riding_features_2017.json");
const features2026 = load("../data/qc_riding_features_2026.json");
const baseline26 = load("../data/qc_2022_baseline_2026map.json");
const dgeq = JSON.parse(readFileSync(new URL("../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));

const partyCodes = PARTIES;

// --- build training data (2017 map, 2014->2018 prev, 2018->2022 curr) ------
const prev = residualIlr(ridingResults, "2014-04-07", "2011", "2018-10-01", "2017", partyCodes);
const curr = residualIlr(ridingResults, "2018-10-01", "2017", "2022-10-03", "2017", partyCodes);

// Align features to residuals
const { X: Xdemo, ridings: codes } = buildFeatureMatrix(features2017);
const codeByName = new Map(features2017.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)]));
const rowByCode = new Map(codes.map((c, i) => [c, i]));

const prevByName = new Map(prev.ridings.map((r, i) => [String(r), prev.Y[i]]));

const X = [], Y = [], names = [];
curr.ridings.forEach((name, i) => {
  const code = codeByName.get(String(name)) ?? String(name);
  const row = rowByCode.get(code);
  if (row === undefined) return;
  const p = prevByName.get(String(name));
  if (!p) return;
  X.push([...Xdemo[row], ...p]); // demographics (14) + previous residual (5) = 19 features
  Y.push(curr.Y[i]);
  names.push(String(name));
});

console.log(`Training data (2017 map): ${X.length} ridings, ${X[0].length} features, ${Y[0].length} targets`);

// --- build inter-transition test data (2026 map, 2018->2022 prev, 2022->2026 curr) ---
// 2022->2026 on 2026 map
const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };
const rows2026 = [];
for (const c of dgeq.circonscriptions) {
  for (const cand of c.candidats) {
    rows2026.push({
      election_date: "2026-10-05", boundary_year: "2026", riding_code: c.nomCirconscription,
      party_code: MAP[cand.abreviationPartiPolitique] ?? "AUTRES", votes: cand.nbVoteTotal,
    });
  }
}
// 2018 on 2026 map
const rows2018on26 = ridingResults
  .filter((r) => r.election_date === "2018-10-01" && String(r.boundary_year) === "2026")
  .map((r) => ({ ...r }));
// 2022 on 2026 map (from baseline)
const rows2022on26 = baseline26.map((r) => ({
  election_date: "2022-10-03", boundary_year: "2026", riding_code: String(r.riding_code),
  party_code: r.party_code, votes: r.votes,
}));

// Need to map riding codes to names for 2026 map
const nameByCode2026 = new Map(features2026.filter((f) => f.riding_name).map((f) => [String(f.riding_code), f.riding_name]));
const rows2022Named = rows2022on26.map((r) => ({ ...r, riding_code: nameByCode2026.get(r.riding_code) ?? r.riding_code }));
const rows2018Named = rows2018on26.map((r) => ({ ...r, riding_code: nameByCode2026.get(r.riding_code) ?? r.riding_code }));

const prev26 = residualIlr([...rows2018Named, ...rows2022Named], "2018-10-01", "2026", "2022-10-03", "2026", partyCodes);
const curr26 = residualIlr([...rows2022Named, ...rows2026], "2022-10-03", "2026", "2026-10-05", "2026", partyCodes);

const { X: Xdemo26, ridings: codes26 } = buildFeatureMatrix(features2026);
const codeByName26 = new Map(features2026.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)]));
const rowByCode26 = new Map(codes26.map((c, i) => [c, i]));

const prev26ByName = new Map(prev26.ridings.map((r, i) => [String(r), prev26.Y[i]]));

const X26 = [], Y26 = [], names26 = [];
curr26.ridings.forEach((name, i) => {
  const code = codeByName26.get(String(name)) ?? String(name);
  const row = rowByCode26.get(code);
  if (row === undefined) return;
  const p = prev26ByName.get(String(name));
  if (!p) return;
  X26.push([...Xdemo26[row], ...p]);
  Y26.push(curr26.Y[i]);
  names26.push(String(name));
});

console.log(`Inter-transition test (2026 map): ${X26.length} ridings`);

// --- export to JSON ---------------------------------------------------------
const out = {
  train: { X, Y, names, nFeatures: X[0].length, nTargets: Y[0].length },
  test2026: { X: X26, Y: Y26, names: names26, nFeatures: X26[0].length, nTargets: Y26[0].length },
  metadata: {
    partyCodes,
    featureDim: X[0].length,
    targetDim: Y[0].length,
    description: "Training: 2014->2018 prev, 2018->2022 curr (2017 map). Test: 2018->2022 prev, 2022->2026 curr (2026 map). Features: demographics ILR (14) + previous residual ILR (5) = 19. Targets: current residual ILR (5).",
  },
};

writeFileSync(new URL("../data/riding_effects_data.json", import.meta.url), JSON.stringify(out), "utf-8");
console.log("Exported to js/data/riding_effects_data.json");
