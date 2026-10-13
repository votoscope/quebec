/**
 * Test and validation for the swing elasticity model.
 *
 * Estimates beta from historical transitions (2014→2018, 2018→2022),
 * then validates on the 2022→2026 transition (the production target):
 * does the elasticity model better capture the QS bastion concentration
 * (Mercier, Taschereau, SMSJ, etc.) than a uniform swing?
 *
 * Run: node js/tools/elasticity_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { estimateElasticity, elasticSwing, meanSharesFromBaseline, ridingElasticity } from "../src/swingElasticity.js";
import { ridingBaselineFromRows, provinceShareFromRows, uniformClrSwing } from "../src/swing.js";
import { PARTIES } from "../src/ridingEffects.js";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const ridingResults = load("../data/qc_riding_results.json");
const baseline2026 = load("../data/qc_2022_baseline_2026map.json");
const proj = load("../data/qc_projection.json");
const partyCodes = proj.partyCodes;

// --- estimate beta from historical transitions ---------------------------
console.log("=== Estimation de l'élasticité (transitions historiques) ===\n");

const { beta, nObs } = estimateElasticity(ridingResults, partyCodes, {
  transitions: [
    { dateA: "2014-04-07", boundaryA: "2011", dateB: "2018-10-01", boundaryB: "2017", label: "2014→2018" },
    { dateA: "2018-10-01", boundaryA: "2017", dateB: "2022-10-03", boundaryB: "2017", label: "2018→2022" },
  ],
  shrinkage: 10.0, // shrinkage modéré: beta reste dans une plage raisonnable
});

console.log(`  ${nObs} observations (ridings × partis × transitions)`);
console.log("  beta par parti (élasticité = 1 + beta * (share - mean)):\n");
for (const p of partyCodes) {
  const b = beta[p] ?? 0;
  const sign = b > 0 ? "+" : "";
  console.log(`    ${p.padEnd(6)} beta = ${sign}${b.toFixed(4)}  →  bastion (40%) élasticité = ${(1 + b * (0.40 - 0.15)).toFixed(2)},  faible (5%) = ${(1 + b * (0.05 - 0.15)).toFixed(2)}`);
}

// --- validate on 2022→2026 (the production target) -----------------------
console.log("\n=== Validation sur 2022→2026 (transition de production) ===\n");

// Load 2026 actual results
const dgeq = JSON.parse(readFileSync(new URL("../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));
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

// Build baselines
const ridingBaseline = ridingBaselineFromRows(baseline2026, partyCodes);
const provBaseline = provinceShareFromRows(baseline2026, partyCodes);

// Provincial forecast (use the projection's nowcast as the "forecast")
const lastTrend = proj.trendSeries[proj.trendSeries.length - 1];
const provForecast = Object.fromEntries(partyCodes.map((p) => [p, lastTrend[p].mean]));

// Actual 2026 provincial shares
const provVotes2026 = {};
for (const p of dgeq.statistiques.partisPolitiques) {
  const code = MAP[p.abreviationPartiPolitique] ?? "AUTRES";
  provVotes2026[code] = (provVotes2026[code] ?? 0) + p.nbVoteTotal;
}
const provTot2026 = Object.values(provVotes2026).reduce((a, b) => a + b, 0);
const provActual2026 = Object.fromEntries(partyCodes.map((p) => [p, (provVotes2026[p] ?? 0) / provTot2026]));

// Actual 2026 riding shares (by riding name on 2026 map)
const shares2026ByName = new Map();
for (const row of rows2026) {
  const name = row.riding_code;
  if (!shares2026ByName.has(name)) shares2026ByName.set(name, Object.fromEntries(partyCodes.map((p) => [p, 0])));
  shares2026ByName.get(name)[row.party_code] += row.votes;
}
for (const [name, votes] of shares2026ByName) {
  const tot = partyCodes.reduce((s, p) => s + votes[p], 0);
  for (const p of partyCodes) votes[p] /= tot;
}

// Mean shares for centering
const meanShare = meanSharesFromBaseline(ridingBaseline, partyCodes);

// --- compare uniform swing vs elastic swing on bastion ridings ----------
const QS_BASTIONS = ["Mercier", "Taschereau", "Sainte-Marie-Saint-Jacques", "Gouin", "Camille-Laurin", "Jean-Lesage"];

// Map riding names to codes via features
import { buildFeatureMatrix } from "../src/ridingEffects.js";
const features2026 = load("../data/qc_riding_features_2026.json");
const codeByName = new Map(features2026.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)]));

console.log("  Comparaison swing uniforme vs élastique sur les bastions QS (2022→2026):\n");
console.log("  circonscription      QS baseline  QS uniforme  QS élastique  QS réel  erreur uni  erreur éla");

const uniformForecast = uniformClrSwing(ridingBaseline, provBaseline, provActual2026, partyCodes);
// For elastic swing, use the ACTUAL provincial result (not the forecast) to isolate the riding-layer effect
const elasticForecast = elasticSwing(ridingBaseline, provBaseline, provActual2026, beta, meanShare, partyCodes);

let errUniform = 0, errElastic = 0, n = 0;
for (const name of QS_BASTIONS) {
  const code = codeByName.get(name);
  if (!code) { console.log(`  ${name.padEnd(20)} (non trouvée)`); continue; }
  const base = ridingBaseline.get(code);
  const uni = uniformForecast.get(code);
  const ela = elasticForecast.get(code);
  const act = shares2026ByName.get(name);
  if (!base || !uni || !ela || !act) continue;

  const qsBase = (base[partyCodes.indexOf("QS")] ?? 0) * 100;
  const qsUni = (uni.shares["QS"] ?? 0) * 100;
  const qsEla = (ela.shares["QS"] ?? 0) * 100;
  const qsAct = (act["QS"] ?? 0) * 100;
  const eU = Math.abs(qsUni - qsAct);
  const eE = Math.abs(qsEla - qsAct);
  errUniform += eU; errElastic += eE; n++;

  console.log(`  ${name.padEnd(20)} ${qsBase.toFixed(1).padStart(6)}     ${qsUni.toFixed(1).padStart(6)}       ${qsEla.toFixed(1).padStart(6)}      ${qsAct.toFixed(1).padStart(5)}    ${eU.toFixed(1).padStart(5)}      ${eE.toFixed(1).padStart(5)}`);
}
console.log(`\n  MAE moyenne sur bastions QS: uniforme ${(errUniform / n).toFixed(1)} pp, élastique ${(errElastic / n).toFixed(1)} pp`);

// --- global comparison across all ridings -------------------------------
console.log("\n=== Comparaison globale (toutes circonscriptions, QS) ===\n");
let globU = 0, globE = 0, globN = 0;
for (const [code, base] of ridingBaseline) {
  const uni = uniformForecast.get(code);
  const ela = elasticForecast.get(code);
  // Find actual by matching code to name
  const feat = features2026.find((f) => String(f.riding_code) === code);
  if (!feat || !feat.riding_name) continue;
  const act = shares2026ByName.get(feat.riding_name);
  if (!act || !uni || !ela) continue;
  globU += Math.abs((uni.shares["QS"] ?? 0) - (act["QS"] ?? 0)) * 100;
  globE += Math.abs((ela.shares["QS"] ?? 0) - (act["QS"] ?? 0)) * 100;
  globN++;
}
console.log(`  QS MAE sur ${globN} circonscriptions: uniforme ${(globU / globN).toFixed(2)} pp, élastique ${(globE / globN).toFixed(2)} pp`);

// --- all parties ----------------------------------------------------------
console.log("\n=== MAE par parti (toutes circonscriptions, vote provincial réel en entrée) ===\n");
console.log("  parti   MAE uniforme   MAE élastique   gain");
for (const p of partyCodes) {
  if (p === "AUTRES") continue;
  let u = 0, e = 0, cnt = 0;
  for (const [code, base] of ridingBaseline) {
    const uni = uniformForecast.get(code);
    const ela = elasticForecast.get(code);
    const feat = features2026.find((f) => String(f.riding_code) === code);
    if (!feat || !feat.riding_name) continue;
    const act = shares2026ByName.get(feat.riding_name);
    if (!act || !uni || !ela) continue;
    u += Math.abs((uni.shares[p] ?? 0) - (act[p] ?? 0)) * 100;
    e += Math.abs((ela.shares[p] ?? 0) - (act[p] ?? 0)) * 100;
    cnt++;
  }
  const gain = ((u - e) / u * 100);
  console.log(`  ${p.padEnd(5)}   ${u.toFixed(2).padStart(8)}       ${e.toFixed(2).padStart(8)}      ${gain > 0 ? "-" : "+"}${Math.abs(gain).toFixed(1)}%`);
}

// --- verdict --------------------------------------------------------------
console.log("\n=== Verdict ===\n");
const bastionGain = (errUniform - errElastic) / errUniform * 100;
console.log(`  Sur les bastions QS: ${bastionGain > 0 ? "amélioration" : "dégradation"} de ${Math.abs(bastionGain).toFixed(1)}%`);
console.log(`  Globalement (QS): ${globU > globE ? "amélioration" : "dégradation"} de ${Math.abs((globU - globE) / globU * 100).toFixed(1)}%`);
if (beta["QS"] > 0) {
  console.log(`\n  beta_QS = ${beta["QS"].toFixed(4)} > 0: les bastions QS amplifient le swing,`);
  console.log(`  capturant la concentration mesurée en 2026 (QS perd nationalement, gagne dans les bastions).`);
}
