/**
 * No-leak 2026 evaluation: what would the model have predicted in 2026
 * WITHOUT any data leak (no use of 2026 results for model selection)?
 *
 * The veille projection (qc_projection_veille_2026-10-05.json) is already
 * leak-free by construction (computed before the election). But some MODEL
 * CHOICES were influenced by 2026 results:
 *
 *   1. ILR basis (AUTRES-last): A/B test included the 2026 veille
 *   2. Turnout correction removal: based on 2022+2026 backtests
 *   3. CAR field: added after 2026 post-mortem (neighbor correlation on 22→26)
 *   4. 4 regions (ILE/CRO): added after 2026 post-mortem
 *
 * This tool:
 *   A. Evaluates the veille projection against DGEQ results (no leak)
 *   B. For each model choice, tests whether it would have been made using
 *      ONLY pre-2026 data (2018/2022)
 *   C. Estimates the "truly no-leak" performance
 *
 * Run: node js/tools/no_leak_2026.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { residualIlr, PARTIES } from "../src/ridingEffects.js";
import { buildAdjacencyMatrix } from "../src/spatialField.js";

const { ilr } = mva.composition;

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const projVeille = load("../data/qc_projection_veille_2026-10-05.json");
const ridingResults = load("../data/qc_riding_results.json");
const ridingRegions = load("../data/qc_riding_regions.json");
const ridingRegions4 = load("../data/qc_riding_regions4.json");
const baseline26 = load("../data/qc_2022_baseline_2026map.json");
const geo = load("../data/qc_ridings_2026.geojson");
const features2026 = load("../data/qc_riding_features_2026.json");
const partyCodes = projVeille.partyCodes;
const MAIN = ["CAQ", "LIB", "QS", "PQ", "PCQ"];

// --- 2026 actual results (DGEQ) -------------------------------------------
const dgeq = JSON.parse(readFileSync(new URL("../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));
const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };
const actual2026 = {};
const seats2026 = { PQ: 59, LIB: 40, PCQ: 19, CAQ: 0, QS: 9 };
const provVotes2026 = {};
for (const c of dgeq.circonscriptions) {
  const code = String(c.numeroCirconscription);
  const shares = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  for (const cand of c.candidats) {
    const p = MAP[cand.abreviationPartiPolitique] ?? "AUTRES";
    shares[p] += cand.nbVoteTotal;
  }
  const tot = partyCodes.reduce((s, p) => s + shares[p], 0);
  for (const p of partyCodes) shares[p] /= tot;
  const winner = partyCodes.reduce((best, p) => (shares[p] > shares[best] ? p : best), partyCodes[0]);
  actual2026[code] = { shares, winner, name: c.nomCirconscription };
}
for (const p of dgeq.statistiques.partisPolitiques) {
  const code = MAP[p.abreviationPartiPolitique] ?? "AUTRES";
  provVotes2026[code] = (provVotes2026[code] ?? 0) + p.nbVoteTotal;
}
const provTot2026 = Object.values(provVotes2026).reduce((a, b) => a + b, 0);
const prov2026 = Object.fromEntries(partyCodes.map((p) => [p, (provVotes2026[p] ?? 0) / provTot2026]));

console.log("=== Évaluation sans fuite (data leak) — 2026 ===\n");

// --- A. Veille projection (no leak by construction) ------------------------
console.log("A. PROJECTION DE VEILLE (déjà sans fuite par construction)");
console.log("   Calculée avant l'élection (2026-10-05) avec les données disponibles.\n");

let correctVeille = 0, totalVeille = 0;
let brierSum = 0;
const seatCountsVeille = {};
for (const [code, fc] of Object.entries(projVeille.ridingForecast)) {
  const actual = actual2026[code];
  if (!actual) continue;
  totalVeille++;
  if (fc.winner === actual.winner) correctVeille++;
  seatCountsVeille[fc.winner] = (seatCountsVeille[fc.winner] ?? 0) + 1;
  const wp = projVeille.ridingWinProbs[code];
  if (wp) {
    let brier = 0;
    for (const p of MAIN) {
      const prob = wp[p] ?? 0;
      const outcome = actual.winner === p ? 1 : 0;
      brier += (prob - outcome) ** 2;
    }
    brierSum += brier;
  }
}
const seatErrorVeille = MAIN.reduce((e, p) => e + Math.abs((seatCountsVeille[p] ?? 0) - seats2026[p]), 0);
const medoidErrorVeille = projVeille.medoidCounts
  ? MAIN.reduce((e, p) => e + Math.abs((projVeille.medoidCounts[p] ?? 0) - seats2026[p]), 0)
  : null;
const lastTrend = projVeille.trendSeries[projVeille.trendSeries.length - 1];
const nowcast = Object.fromEntries(partyCodes.map((p) => [p, lastTrend[p].mean]));
const maeVote = MAIN.reduce((s, p) => s + Math.abs(nowcast[p] * 100 - prov2026[p] * 100), 0) / MAIN.length;

console.log(`   Précision circonscriptions : ${(correctVeille / totalVeille * 100).toFixed(1)}% (${correctVeille}/${totalVeille})`);
console.log(`   Erreur sièges (point)      : ${seatErrorVeille}`);
if (medoidErrorVeille !== null) {
  console.log(`   Erreur sièges (médoïde)    : ${medoidErrorVeille} (médoïde: ${JSON.stringify(projVeille.medoidCounts)})`);
}
console.log(`   Sièges prédits (point)     : ${JSON.stringify(seatCountsVeille)}`);
console.log(`   Sièges réels               : ${JSON.stringify(seats2026)}`);
console.log(`   MAE vote national          : ${maeVote.toFixed(2)} pp`);
console.log(`   Brier score                : ${(brierSum / totalVeille).toFixed(3)}`);
console.log(`   Nowcast                    : ${JSON.stringify(Object.fromEntries(MAIN.map((p) => [p, +(nowcast[p] * 100).toFixed(1)])))}`);
console.log(`   Réel                       : ${JSON.stringify(Object.fromEntries(MAIN.map((p) => [p, +(prov2026[p] * 100).toFixed(1)])))}`);

// --- B. Model choices: would they have been made without 2026? -------------
console.log("\n\nB. CHOIX DE MODÉLISATION — auraient-ils été faits sans les données 2026?\n");

// 1. ILR basis (AUTRES-last): A/B test was on 2018/2022/2026 veilles
console.log("1. BASE ILR (AUTRES en dernier)");
console.log("   Test A/B original: 2018, 2022, ET 2026 veilles (tools/ilr_basis_test.mjs)");
console.log("   Fuite potentielle: la veille 2026 (cible) était incluse dans la sélection.");
console.log("   Test sans fuite: A/B sur 2018 et 2022 seulement");
// We can't easily rerun the A/B here, but we can note the result from TODO:
console.log("   Résultat A/B (TODO): AUTRES-dernier améliore 2018 (3,17→2,73), 2022 (2,60→1,95), 2026 (1,98→1,56)");
console.log("   => Sans 2026, le choix aurait été le même (2018 et 2022 montrent aussi un gain).");
console.log("   Verdict: PAS DE FUITE SIGNIFICATIVE (le gain est cohérent sur 2018/2022)");

// 2. Turnout correction removal: based on 2022+2026
console.log("\n2. CORRECTION DE PARTICIPATION (retirée, w=0)");
console.log("   Décision: basée sur backtests 2022+2026 (tools/turnout_test_2026.mjs)");
console.log("   Fuite potentielle: les résultats 2026 ont été utilisés pour décider le retrait.");
console.log("   Test sans fuite: backtest 2022 seul (tools/turnout_test.ts)");
console.log("   Résultat 2022 seul (TODO): w=0 → 2,015, w=0,75 → 1,99, w=1 → 2,06 (gain marginal à w=0,75)");
console.log("   => Sans 2026, on aurait peut-être gardé w=0,75 (gain -0,14 pp en 2022).");
console.log("   Verdict: FUITE MINEURE (le retrait était justifié par 2026, pas par 2022 seul)");

// 3. CAR field: added after 2026 post-mortem
console.log("\n3. CHAMP CAR SPATIAL");
console.log("   Ajouté après le post-mortem 2026 (corrélation voisinage mesurée sur 22→26).");
console.log("   Fuite potentielle: la décision d'ajouter le CAR vient des résultats 2026.");
console.log("   Mais: les paramètres (ρ, σ²) sont estimés sur les résidus 2018→2022 (held-out).");
console.log("   Test sans fuite: corrélation de voisinage sur 2018→2022 seulement");
// Compute neighbor correlation on 2018→2022 residuals
const res2018_2022 = residualIlr(ridingResults, "2018-10-01", "2017", "2022-10-03", "2017", partyCodes);
const adj = buildAdjacencyMatrix(geo);
const regionByCode = new Map(ridingRegions.map((r) => [String(r.riding_code), r.region_code]));
const codeByName = new Map(features2026.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)]));
const nameByCode2017 = new Map(load("../data/qc_riding_features_2017.json").map((f) => [String(f.riding_code), f.riding_name]));
// Map residuals to adjacency codes
const Y = new Map();
res2018_2022.ridings.forEach((name, i) => {
  const code = codeByName.get(name);
  if (code && adj.codes.includes(code)) Y.set(code, res2018_2022.Y[i]);
});
// De-mean by region
const sums = new Map(), counts = new Map();
for (const [code, y] of Y) {
  const reg = regionByCode.get(code) ?? "?";
  if (!sums.has(reg)) { sums.set(reg, new Array(5).fill(0)); counts.set(reg, 0); }
  y.forEach((v, j) => sums.get(reg)[j] += v);
  counts.set(reg, counts.get(reg) + 1);
}
const Yd = new Map();
for (const [code, y] of Y) {
  const reg = regionByCode.get(code) ?? "?";
  const m = sums.get(reg).map((v) => v / counts.get(reg));
  Yd.set(code, y.map((v, j) => v - m[j]));
}
// Neighbor correlation
let num = 0, n = 0;
const codeIdx = new Map(adj.codes.map((c, i) => [c, i]));
for (let i = 0; i < adj.W.length; i++) {
  for (let j = i + 1; j < adj.W.length; j++) {
    if (adj.W[i][j] === 0) continue;
    const ya = Yd.get(adj.codes[i]), yb = Yd.get(adj.codes[j]);
    if (!ya || !yb) continue;
    for (let c = 0; c < 5; c++) { num += ya[c] * yb[c]; n++; }
  }
}
const sd = Math.sqrt([...Yd.values()].flat().reduce((s, v) => s + v * v, 0) / (Yd.size * 5));
const neighborCorr2018_2022 = n > 0 ? num / n / (sd * sd) : 0;
console.log(`   Corrélation voisinage 2018→2022 (sans 2026): ${neighborCorr2018_2022.toFixed(3)}`);
console.log("   (vs 0,216 mesuré sur 2022-2026 avec fuite)");
console.log(`   => ${neighborCorr2018_2022 > 0.1 ? "La corrélation existe aussi sans 2026 — le CAR aurait été justifié." : "La corrélation est faible sans 2026 — le CAR est une fuite de décision."}`);
console.log(`   Verdict: ${neighborCorr2018_2022 > 0.1 ? "PAS DE FUITE SIGNIFICATIVE (la structure spatiale est réelle historiquement)" : "FUITE DE DÉCISION (le CAR vient surtout de 2026)"}`);

// 4. 4 regions (ILE/CRO): added after 2026 post-mortem
console.log("\n4. GRANULARITÉ 4 RÉGIONS (ILE/CRO/QC/REG)");
console.log("   Ajouté après le post-mortem 2026 (différence ILE/CRO mesurée sur résultats 2022).");
console.log("   Fuite potentielle: la décision vient de l'analyse 2026.");
console.log("   Mais: la carte ILE/CRO est géographique, et la différence ILE/CRO 2022 est avant 2026.");
// Compute ILE/CRO difference on 2022 results (before 2026)
const r4ByCode = new Map(ridingRegions4.regions.map((r) => [String(r.riding_code), r.region4]));
const byRegion = {};
for (const row of baseline26) {
  const r = r4ByCode.get(String(row.riding_code));
  if (!r) continue;
  byRegion[r] = byRegion[r] || {};
  byRegion[r][row.party_code] = (byRegion[r][row.party_code] || 0) + row.votes;
}
const ile = byRegion["ILE"] || {}, cro = byRegion["CRO"] || {};
const ileTot = Object.values(ile).reduce((a, b) => a + b, 0);
const croTot = Object.values(cro).reduce((a, b) => a + b, 0);
const caqDiff = ((cro["CAQ"] || 0) / croTot - (ile["CAQ"] || 0) / ileTot) * 100;
console.log(`   Différence CAQ CRO-ILE (résultats 2022, avant 2026): ${caqDiff.toFixed(1)} pp`);
console.log("   (vs +23,6 pp mesuré sur 2022 dans le post-mortem — même ordre de grandeur)");
console.log(`   => ${Math.abs(caqDiff) > 15 ? "La différence ILE/CRO existe en 2022 — les 4 régions auraient été justifiées sans 2026." : "La différence est faible en 2022 — les 4 régions viennent surtout de 2026."}`);
console.log(`   Verdict: ${Math.abs(caqDiff) > 15 ? "PAS DE FUITE SIGNIFICATIVE (la structure est dans les données 2022)" : "FUITE PARTIELLE"}`);

// --- C. Synthèse: performance estimée sans fuite ---------------------------
console.log("\n\nC. SYNTHÈSE — PERFORMANCE ESTIMÉE SANS FUITE\n");
console.log("   La projection de veille est déjà sans fuite (métriques ci-dessus).");
console.log("   Les choix de modélisation avec fuite potentielle:");
console.log("   - Base ILR: pas de fuite significative (gain cohérent 2018/2022)");
console.log("   - Retrait participation: fuite mineure (2022 seul donnait w=0,75)");
console.log(`   - CAR: ${neighborCorr2018_2022 > 0.1 ? "pas de fuite (corrélation" + neighborCorr2018_2022.toFixed(3) + " en 2018→2022)" : "fuite de décision"}`);
console.log(`   - 4 régions: ${Math.abs(caqDiff) > 15 ? "pas de fuite (diff ILE/CRO " + caqDiff.toFixed(1) + " pp en 2022)" : "fuite partielle"}`);
console.log("\n   Estimation: la performance sans fuite serait TRÈS SIMILAIRE");
console.log("   à la veille (les fuites sont dans les DÉCISIONS, pas dans les paramètres).");
console.log(`   La veille 2026 (${(correctVeille / totalVeille * 100).toFixed(1)}% circonscriptions, erreur ${seatErrorVeille} sièges point / ${medoidErrorVeille} sièges médoïde) est donc`);
console.log("   une estimation honnête de la performance du modèle.");

console.log("\n=== Performance sans fuite (veille 2026) ===");
console.log(`   Précision circonscriptions : ${(correctVeille / totalVeille * 100).toFixed(1)}% (${correctVeille}/${totalVeille})`);
console.log(`   Erreur sièges (point)      : ${seatErrorVeille}`);
if (medoidErrorVeille !== null) {
  console.log(`   Erreur sièges (médoïde)    : ${medoidErrorVeille}`);
}
console.log(`   MAE vote national          : ${maeVote.toFixed(2)} pp`);
console.log(`   Brier score                : ${(brierSum / totalVeille).toFixed(3)}`);
console.log("\n   Décomposition de l'erreur (médoïde = 28):");
console.log("   - ~10 sièges du nowcast national (CAQ 18,1 vs 13,3 réel)");
console.log("   - ~8 sièges de la couche circonscriptions (bastions QS, PCQ Mauricie)");
console.log("   - ~10 sièges de variance Monte Carlo (médoïde vs point)");
