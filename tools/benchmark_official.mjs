/**
 * Benchmark officiel: évaluation du modèle sur les résultats officiels
 * (DGEQ 2026 + Wikipédia 2018/2022) avec des métriques cohérentes.
 *
 * Sources de vérité (officielles et vérifiables):
 *   - 2026: DGEQ (data/raw/lus/2026-10-05-resultats-dgeq.json)
 *   - 2018/2022: Wikipédia via qc_riding_results.json (résultats officiels)
 *
 * Métriques calculées:
 *   - Précision par circonscription (bon vainqueur)
 *   - Erreur absolue de sièges
 *   - Brier score (2026, avec probabilités de victoire)
 *   - MAE vote national
 *
 * Pour 2026: la projection archivée de la veille du scrutin
 *   (qc_projection_veille_2026-10-05.json, pipeline complet) et le modèle
 *   allégé sur la MÊME couche nationale (tools/veille_archive.mjs) : l'écart
 *   entre les deux mesure la seule couche par circonscription.
 * Pour 2018/2022: modèle allégé (nowcast GP courant + swing ILR additif).
 *
 * Run: node js/tools/benchmark_official.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { ridingBaselineFromRows, provinceShareFromRows, uniformClrSwing } from "../src/swing.js";
import { absSeatError } from "./lib/harness.mjs";

const { ilr } = mva.composition;

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const ridingResults = load("../data/qc_riding_results.json");
const baseline26 = load("../data/qc_2022_baseline_2026map.json");
const projVeille = load("../data/qc_projection_veille_2026-10-05.json");
const projVeille2018 = load("../data/qc_projection_veille_2018.json");
const projVeille2022 = load("../data/qc_projection_veille_2022.json");
const projVeille2026Leger = load("../data/qc_projection_veille_2026_leger.json");
const partyCodes = projVeille.partyCodes;
const MAIN = ["CAQ", "LIB", "QS", "PQ", "PCQ"];

const SEATS = {
  2018: { CAQ: 73, LIB: 31, QS: 10, PQ: 10, PCQ: 0 },
  2022: { CAQ: 89, LIB: 21, QS: 11, PQ: 3, PCQ: 0 },
  2026: { PQ: 59, LIB: 40, PCQ: 19, CAQ: 0, QS: 9 },
};

// --- résultats officiels ---------------------------------------------------

// 2026: DGEQ
const dgeq = JSON.parse(readFileSync(new URL("../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));
const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };

// Résultats 2026 par circonscription (code -> {shares, winner})
const actual2026 = {};
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
const seats2026 = { PQ: 59, LIB: 40, PCQ: 19, CAQ: 0, QS: 9 };

// 2018/2022: depuis qc_riding_results.json (résultats officiels Wikipédia)
function resultsByElection(date, boundary) {
  const byRiding = new Map();
  const provVotes = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  let provTot = 0;
  for (const r of ridingResults) {
    if (r.election_date !== date || String(r.boundary_year) !== String(boundary)) continue;
    const name = String(r.riding_code);
    const p = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
    if (!byRiding.has(name)) byRiding.set(name, { shares: Object.fromEntries(partyCodes.map((pp) => [pp, 0])), votes: 0 });
    byRiding.get(name).shares[p] += r.votes;
    byRiding.get(name).votes += r.votes;
    provVotes[p] += r.votes;
    provTot += r.votes;
  }
  const out = {};
  for (const [name, data] of byRiding) {
    for (const p of partyCodes) data.shares[p] /= data.votes;
    data.winner = partyCodes.reduce((best, p) => (data.shares[p] > data.shares[best] ? p : best), partyCodes[0]);
    out[name] = data;
  }
  const prov = Object.fromEntries(partyCodes.map((p) => [p, provVotes[p] / provTot]));
  return { byRiding: out, provincial: prov };
}

const res2018 = resultsByElection("2018-10-01", "2017");
const res2022 = resultsByElection("2022-10-03", "2017");

// --- évaluation générique (projection de veille vs résultats officiels) ----
// Les trois élections utilisent le même code: la projection archivée de la
// veille (nowcast GP + shift ILR additif pour 2018/2022, pipeline complet
// pour 2026) contre la vérité officielle.
function evaluateVeille(proj, actualByRiding, actualProv, seats, mainParties, brierParties) {
  let correct = 0, total = 0;
  let brierSum = 0, brierN = 0;
  const pointCounts = {};
  const medoidCounts = proj.medoidCounts ?? null;

  for (const [code, fc] of Object.entries(proj.ridingForecast)) {
    const actual = actualByRiding[code];
    if (!actual) continue;
    total++;
    if (fc.winner === actual.winner) correct++;
    pointCounts[fc.winner] = (pointCounts[fc.winner] ?? 0) + 1;

    const wp = proj.ridingWinProbs?.[code];
    if (wp && brierParties) {
      let brier = 0;
      for (const p of brierParties) {
        const prob = wp[p] ?? 0;
        const outcome = actual.winner === p ? 1 : 0;
        brier += (prob - outcome) ** 2;
      }
      brierSum += brier;
      brierN++;
    }
  }

  const seatError = absSeatError(pointCounts, seats, mainParties);
  const medoidError = medoidCounts ? absSeatError(medoidCounts, seats, mainParties) : null;

  // MAE vote national (nowcast vs réel)
  const nowcast = proj.nowcast
    ?? Object.fromEntries(partyCodes.map((p) => [p, proj.trendSeries[proj.trendSeries.length - 1][p].mean]));
  const mae = mainParties.reduce((s, p) => s + Math.abs((nowcast[p] ?? 0) * 100 - actualProv[p] * 100), 0) / mainParties.length;

  return {
    ridingAccuracy: correct / total,
    correct,
    total,
    pointCounts,
    medoidCounts,
    seatError,
    medoidError,
    brier: brierN ? brierSum / brierN : null,
    mae,
  };
}

// 2018/2022: vérité Wikipédia (noms = clés des veilles), nowcast dans la projection.
function actualsFromWikipedia(date, boundary, mainParties) {
  const byRiding = {};
  const provVotes = {};
  for (const r of ridingResults) {
    if (r.election_date !== date || String(r.boundary_year) !== String(boundary)) continue;
    const name = String(r.riding_code);
    const p = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
    if (!byRiding[name]) byRiding[name] = { votes: {} };
    byRiding[name].votes[p] = (byRiding[name].votes[p] ?? 0) + r.votes;
    provVotes[p] = (provVotes[p] ?? 0) + r.votes;
  }
  const provTot = Object.values(provVotes).reduce((a, b) => a + b, 0);
  const prov = Object.fromEntries(partyCodes.map((p) => [p, (provVotes[p] ?? 0) / provTot]));
  for (const [name, d] of Object.entries(byRiding)) {
    const tot = Object.values(d.votes).reduce((a, b) => a + b, 0);
    const shares = Object.fromEntries(partyCodes.map((p) => [p, (d.votes[p] ?? 0) / tot]));
    const winner = partyCodes.reduce((best, p) => (shares[p] > shares[best] ? p : best), partyCodes[0]);
    byRiding[name] = { shares, winner };
  }
  return { byRiding, prov };
}

const actuals2018 = actualsFromWikipedia("2018-10-01", "2017", MAIN);
const actuals2022 = actualsFromWikipedia("2022-10-03", "2017", MAIN);
const eval2018 = evaluateVeille(projVeille2018, actuals2018.byRiding, actuals2018.prov, SEATS[2018], MAIN, MAIN);
const eval2022 = evaluateVeille(projVeille2022, actuals2022.byRiding, actuals2022.prov, SEATS[2022], MAIN, MAIN);

// 2026 évalué DEUX fois sur la même couche nationale (vote projeté de la
// veille publiée): pipeline complet et modèle allégé (swing ILR additif,
// sans couche par circonscription).
function evaluate2026() {
  const pred = projVeille;
  const actualByRiding = {};
  for (const [code, a] of Object.entries(actual2026)) actualByRiding[code] = { shares: a.shares, winner: a.winner };

  const r = evaluateVeille(pred, actualByRiding, prov2026, SEATS[2026], MAIN, MAIN);
  r.nowcast = Object.fromEntries(MAIN.map((p) => [p, +((r.mae !== null ? (pred.trendSeries[pred.trendSeries.length - 1][p].mean) : 0) * 100).toFixed(1)]));
  r.actual = Object.fromEntries(MAIN.map((p) => [p, +(prov2026[p] * 100).toFixed(1)]));
  return r;
}

function evaluate2026Leger() {
  const actualByRiding = {};
  for (const [code, a] of Object.entries(actual2026)) actualByRiding[code] = { shares: a.shares, winner: a.winner };
  return evaluateVeille(projVeille2026Leger, actualByRiding, prov2026, SEATS[2026], MAIN, MAIN);
}

const eval2026 = evaluate2026();
const eval2026Leger = evaluate2026Leger();

// --- affichage -------------------------------------------------------------
console.log("=== Benchmark officiel (résultats DGEQ/Wikipédia) ===\n");
console.log("Sources de vérité: DGEQ 2026, Wikipédia 2018/2022 (résultats officiels)\n");

console.log("=== 1. Précision par circonscription (bon vainqueur) ===\n");
console.log("  Élection   Modèle                        Précision    Détails");
console.log("  ─────────────────────────────────────────────────────────────────────");
console.log(`  2018       allégé (nowcast+swing)       ${(eval2018.ridingAccuracy * 100).toFixed(1)}%        ${eval2018.correct}/${eval2018.total} (projection archivée, Wikipédia)`);
console.log(`  2022       allégé (nowcast+swing)       ${(eval2022.ridingAccuracy * 100).toFixed(1)}%        ${eval2022.correct}/${eval2022.total} (projection archivée, Wikipédia)`);
console.log(`  2026       allégé (veille+swing)        ${(eval2026Leger.ridingAccuracy * 100).toFixed(1)}%        ${eval2026Leger.correct}/${eval2026Leger.total} (projection archivée, DGEQ)`);
console.log(`  2026       pipeline complet              ${(eval2026.ridingAccuracy * 100).toFixed(1)}%        ${eval2026.correct}/${eval2026.total} (veille publiée, DGEQ)`);
console.log("\n  2018/2022 : nowcast GP courant. 2026 : couche nationale de la veille publiée,");
console.log("  commune aux deux lignes 2026 (l'écart isole la couche par circonscription).");

console.log("\n=== 2. Erreur absolue de sièges (point / médoïde) ===\n");
console.log("  Élection   Point (erreur)          Médoïde (erreur)         Réel");
console.log("  ─────────────────────────────────────────────────────────────────────");
for (const [label, ev, seats] of [["2018", eval2018, SEATS[2018]], ["2022", eval2022, SEATS[2022]], ["2026 allégé", eval2026Leger, SEATS[2026]], ["2026 complet", eval2026, SEATS[2026]]]) {
  const pt = JSON.stringify(Object.fromEntries(MAIN.map((p) => [p, ev.pointCounts[p] ?? 0])));
  const md = ev.medoidCounts ? JSON.stringify(Object.fromEntries(MAIN.map((p) => [p, ev.medoidCounts[p] ?? 0]))) : "—";
  console.log(`  ${label.padEnd(12)} ${pt} (${ev.seatError})  ${md} (${ev.medoidError})`);
  console.log(`             Réel: ${JSON.stringify(seats)}`);
}
console.log(`\n  Note 2026 pipeline complet: l'erreur de 18 sièges (point) se décompose en`);
console.log(`  10 nowcast + 8 couche circonscriptions (contrefactuel, tools/counterfactual_2026.mjs).`);

console.log("\n=== 3. Vote national (MAE, pp) ===\n");
console.log("  Élection   MAE nowcast vs réel");
console.log("  ─────────────────────────────────────");
console.log(`  2018       ${eval2018.mae.toFixed(2)} pp`);
console.log(`  2022       ${eval2022.mae.toFixed(2)} pp`);
console.log(`  2026       ${eval2026.mae.toFixed(2)} pp (tendance publiée, population adulte) / ${eval2026Leger.mae.toFixed(2)} pp (vote projeté, participation incluse)`);
console.log(`\n  Nowcast 2026 (complet): ${JSON.stringify(eval2026.nowcast)}   Réel (DGEQ): ${JSON.stringify(eval2026.actual)}`);

console.log("\n=== 4. Brier score (par circonscription) ===\n");
console.log("  Élection   Brier moyen (0 = parfait, 2 = pire cas théorique pour 5 partis)");
console.log("  ─────────────────────────────────────────────");
console.log(`  2018       ${eval2018.brier !== null ? eval2018.brier.toFixed(3) : "—"}`);
console.log(`  2022       ${eval2022.brier !== null ? eval2022.brier.toFixed(3) : "—"}`);
console.log(`  2026       ${eval2026Leger.brier !== null ? eval2026Leger.brier.toFixed(3) : "—"} (allégé) / ${eval2026.brier !== null ? eval2026.brier.toFixed(3) : "—"} (complet)`);

console.log("\n=== 5. Calibration des sièges (2026) ===\n");
// Vérifier si les sièges réels tombent dans les intervalles simulés
console.log("  Parti   Réel   Médiane simulée   [p05-p95]   Dans l'intervalle?   Quantile du réel");
for (const p of MAIN) {
  const dist = projVeille.seatDistributions[p];
  const actual = seats2026[p];
  const inInterval = actual >= dist.p05 && actual <= dist.p95;
  // Quantile du réel dans la distribution simulée
  const hist = dist.histogram;
  let cumProb = 0, quantile = null;
  for (const h of hist) {
    cumProb += h.prob;
    if (h.seats >= actual && quantile === null) { quantile = cumProb; break; }
  }
  console.log(`  ${p.padEnd(5)}   ${String(actual).padStart(3)}    ${String(Math.round(dist.p50)).padStart(5)}          [${String(dist.p05).padStart(2)}-${String(dist.p95).padStart(2)}]   ${inInterval ? "oui" : "NON"}              ${quantile !== null ? (quantile * 100).toFixed(0) + "%" : "—"}`);
}

console.log("\n=== 6. Sources et reproductibilité ===\n");
console.log("  Résultats officiels:");
console.log("    - 2026: DGEQ (data/raw/lus/2026-10-05-resultats-dgeq.json)");
console.log("    - 2018/2022: Wikipédia (qc_riding_results.json, tableaux officiels)");
console.log("  Projections (toutes archivées dans le dépôt):");
console.log("    - 2026: qc_projection_veille_2026-10-05.json (pipeline complet)");
console.log("    - 2018/2022: qc_projection_veille_{2018,2022}.json (nowcast GP + swing ILR additif)");
console.log("    - 2026 allégé: qc_projection_veille_2026_leger.json (veille publiée + swing ILR additif)");
console.log("  Ce benchmark est entièrement reproductible depuis les données du dépôt.");

console.log("\n=== Résumé ===\n");
console.log("  Modèle allégé (swing ILR additif; 2026 sur la couche nationale publiée):");
console.log(`  - Précision circonscriptions: ${(eval2018.ridingAccuracy * 100).toFixed(1)}% (2018), ${(eval2022.ridingAccuracy * 100).toFixed(1)}% (2022), ${(eval2026Leger.ridingAccuracy * 100).toFixed(1)}% (2026)`);
console.log(`  - Erreur sièges (point/médoïde): 2018 ${eval2018.seatError}/${eval2018.medoidError}, 2022 ${eval2022.seatError}/${eval2022.medoidError}, 2026 ${eval2026Leger.seatError}/${eval2026Leger.medoidError}`);
console.log(`  - MAE vote national: 2018 ${eval2018.mae.toFixed(2)} pp, 2022 ${eval2022.mae.toFixed(2)} pp, 2026 ${eval2026Leger.mae.toFixed(2)} pp`);
console.log(`  - Brier: 2018 ${eval2018.brier.toFixed(3)}, 2022 ${eval2022.brier.toFixed(3)}, 2026 ${eval2026Leger.brier.toFixed(3)}`);
console.log("\n  Pipeline complet 2026 (pour comparaison, couches 2026-scopées incluses):");
console.log(`  - Précision ${(eval2026.ridingAccuracy * 100).toFixed(1)}%, erreur sièges ${eval2026.seatError}/${eval2026.medoidError} (point/médoïde), Brier ${eval2026.brier.toFixed(3)}`);
const inside = MAIN.filter((p) => seats2026[p] >= projVeille.seatDistributions[p].p05 && seats2026[p] <= projVeille.seatDistributions[p].p95).length;
const pCaq0 = projVeille.seatDistributions.CAQ.histogram.find((h) => h.seats === 0)?.prob ?? 0;
console.log(`  - Calibration sièges: ${inside}/${MAIN.length} partis dans [p05-p95]`);
console.log(`    (CAQ à 0 siège : probabilité simulée ${(pCaq0 * 100).toFixed(1)} %)`);
console.log("\n  Note 2018: 119/124 circonscriptions évaluées (5 renommées 2011->2017 sans");
console.log("  prédécesseur dans la baseline 2014|2011, jointure documentée au harnais).");
