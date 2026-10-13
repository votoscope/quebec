/**
 * Demi-chef (co-spokesperson) effect test.
 *
 * The 2026 evaluation showed Jean-Lesage as a major miss: the model
 * predicted PCQ p=0.66, but QS (Sol Zanetti, co-porte-parole) won with
 * only p=0.19 predicted. Zanetti received only his incumbency bonus
 * (he was the sitting MNA), not a leader effect — but as co-spokesperson
 * he may have a "demi-chef" effect, partial between the full leader
 * effect and no effect.
 *
 * This test estimates the demi-chef effect from historical QS
 * co-spokespersons who were députés:
 *   - Amir Khadir (Mercier, 2008-2012, co-porte-parole 2008-2013)
 *   - Manon Massé (Sainte-Marie-Saint-Jacques, 2018-2022, co-porte-parole 2017-2023)
 *   - Gabriel Nadeau-Dubois (Gouin, 2018-2022, co-porte-parole 2017-2023)
 *
 * For each case, the effect is measured as the excess log growth vs
 * the counterfactual uniform swing (same method as qc_leader_effect.json).
 * The demi-chef effect is compared with the production leader effects
 * (arrivée +0.60, continuation +0.27, départ -0.10 in log).
 *
 * Run: node js/tools/demi_chef_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { residualIlr, PARTIES } from "../src/ridingEffects.js";

const { ilr } = mva.composition;

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const ridingResults = load("../data/qc_riding_results.json");
const leaderEffect = load("../data/qc_leader_effect.json");
const proj = load("../data/qc_projection.json");
const baseline26 = load("../data/qc_2022_baseline_2026map.json");

const partyCodes = proj.partyCodes;

// --- helper: compute the leader-style effect for one riding/transition ---
// effect = ilr(share_actual) - ilr(share_baseline) - (ilr(prov_actual) - ilr(prov_baseline))
// measured on the QS share (or the party of the co-spokesperson)
function computeEffect(rows, ridingName, dateA, boundaryA, dateB, boundaryB, party, partyCodes) {
  // Riding shares
  const sharesByRiding = (rows, date, boundary) => {
    const by = new Map();
    for (const r of rows) {
      if (r.election_date !== date || String(r.boundary_year) !== String(boundary)) continue;
      const name = String(r.riding_code);
      const p = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
      if (!by.has(name)) by.set(name, Object.fromEntries(partyCodes.map((pp) => [pp, 0])));
      by.get(name)[p] += r.votes;
    }
    const out = new Map();
    for (const [n, v] of by) {
      const t = partyCodes.reduce((s, p) => s + v[p], 0);
      if (t > 0) out.set(n, Object.fromEntries(partyCodes.map((p) => [p, v[p] / t])));
    }
    return out;
  };

  const provShares = (rows, date, boundary) => {
    const v = Object.fromEntries(partyCodes.map((p) => [p, 0]));
    let t = 0;
    for (const r of rows) {
      if (r.election_date !== date || String(r.boundary_year) !== String(boundary)) continue;
      const p = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
      v[p] += r.votes;
      t += r.votes;
    }
    return Object.fromEntries(partyCodes.map((p) => [p, v[p] / t]));
  };

  const shA = sharesByRiding(rows, dateA, boundaryA).get(ridingName);
  const shB = sharesByRiding(rows, dateB, boundaryB).get(ridingName);
  const provA = provShares(rows, dateA, boundaryA);
  const provB = provShares(rows, dateB, boundaryB);

  if (!shA || !shB) return null;

  // ILR effect on the co-spokesperson's party
  const ilrShA = ilr([partyCodes.map((p) => Math.max(shA[p], 1e-6))])[0];
  const ilrShB = ilr([partyCodes.map((p) => Math.max(shB[p], 1e-6))])[0];
  const ilrProvA = ilr([partyCodes.map((p) => Math.max(provA[p], 1e-6))])[0];
  const ilrProvB = ilr([partyCodes.map((p) => Math.max(provB[p], 1e-6))])[0];

  // Effect vector (ILR): riding change minus provincial swing
  const effectVec = ilrShB.map((v, i) => v - ilrShA[i] - (ilrProvB[i] - ilrProvA[i]));

  // The "leader effect" is typically measured as the excess LOG share of the
  // leader's party. We approximate by taking the party's log-share change
  // minus the provincial log-share change.
  const idx = partyCodes.indexOf(party);
  const logEffect = Math.log(Math.max(shB[party], 1e-6) / Math.max(shA[party], 1e-6))
    - Math.log(Math.max(provB[party], 1e-6) / Math.max(provA[party], 1e-6));

  return {
    riding: ridingName,
    party,
    dateA, dateB,
    shareA: shA[party],
    shareB: shB[party],
    provA: provA[party],
    provB: provB[party],
    logEffect, // excess log growth vs provincial swing
    effectVec, // full ILR effect vector
  };
}

// --- historical co-spokesperson cases -------------------------------------
// Each case: riding, election transition, party, role
const CASES = [
  // Manon Massé — Sainte-Marie—Saint-Jacques, co-porte-parole QS 2017-2023
  { name: "Manon Massé", riding: "Sainte-Marie—Saint-Jacques", party: "QS", role: "co-porte-parole",
    transitions: [
      { a: "2014-04-07", ba: "2011", b: "2018-10-01", bb: "2017", note: "élue 2014 (arrivée), réélue 2018 (continuation)" },
      { a: "2018-10-01", ba: "2017", b: "2022-10-03", bb: "2017", note: "réélue 2022 (continuation)" },
    ]},
  // Gabriel Nadeau-Dubois — Gouin, co-porte-parole QS 2017-2023
  { name: "Gabriel Nadeau-Dubois", riding: "Gouin", party: "QS", role: "co-porte-parole",
    transitions: [
      { a: "2018-10-01", ba: "2017", b: "2022-10-03", bb: "2017", note: "élu 2017 (partielle), réélu 2018, réélu 2022" },
    ]},
  // Sol Zanetti — Jean-Lesage, co-porte-parole QS 2023-présent (2026)
  { name: "Sol Zanetti", riding: "Jean-Lesage", party: "QS", role: "co-porte-parole",
    transitions: [
      { a: "2022-10-03", ba: "2026", b: "2026-10-05", bb: "2026", note: "élu 2022 (arrivée), réélu 2026 (continuation)" },
    ]},
];

console.log("=== Test de l'effet « demi-chef » (co-porte-parole) ===\n");
console.log("Méthode: effet = log(share_riding) - log(share_prov) sur la transition,");
console.log("comparé aux effets leader de production (arrivée +0.60, continuation +0.27, départ -0.10)\n");

// Check which elections are available
const availableElections = new Set();
for (const r of ridingResults) {
  availableElections.add(`${r.election_date}|${r.boundary_year}`);
}
// Add 2026 (loaded separately from DGEQ)
availableElections.add("2026-10-05|2026");
console.log("Élections disponibles dans qc_riding_results.json:");
for (const e of [...availableElections].sort()) console.log("  ", e);
console.log();

// Compute effects for each case
const results = [];
for (const c of CASES) {
  console.log(`--- ${c.name} (${c.riding}, ${c.party}, ${c.role}) ---`);
  for (const tr of c.transitions) {
    const keyA = `${tr.a}|${tr.ba}`;
    const keyB = `${tr.b}|${tr.bb}`;
    const hasA = availableElections.has(keyA);
    const hasB = availableElections.has(keyB);
    if (!hasA || !hasB) {
      console.log(`  ${tr.a} → ${tr.b}: données manquantes (${keyA}: ${hasA}, ${keyB}: ${hasB})`);
      continue;
    }
    // For 2026, use the baseline26 + actual results
    let rows = ridingResults;
    if (tr.b === "2026-10-05") {
      // Load 2026 actual results
      const dgeq = JSON.parse(readFileSync(new URL("../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));
      const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };
      const rows2026 = [];
      for (const cir of dgeq.circonscriptions) {
        for (const cand of cir.candidats) {
          rows2026.push({
            election_date: "2026-10-05", boundary_year: "2026", riding_code: cir.nomCirconscription,
            party_code: MAP[cand.abreviationPartiPolitique] ?? "AUTRES", votes: cand.nbVoteTotal,
          });
        }
      }
      // 2022 baseline on 2026 map
      const rows2022 = baseline26.map((r) => ({
        election_date: "2022-10-03", boundary_year: "2026", riding_code: String(r.riding_code),
        party_code: r.party_code, votes: r.votes,
      }));
      // Need to map riding codes to names for 2022
      const features26 = load("../data/qc_riding_features_2026.json");
      const nameByCode = new Map(features26.filter((f) => f.riding_name).map((f) => [String(f.riding_code), f.riding_name]));
      const rows2022Named = rows2022.map((r) => ({ ...r, riding_code: nameByCode.get(r.riding_code) ?? r.riding_code }));
      rows = [...rows2022Named, ...rows2026];
    }

    const eff = computeEffect(rows, c.riding, tr.a, tr.ba, tr.b, tr.bb, c.party, partyCodes);
    if (!eff) {
      console.log(`  ${tr.a} → ${tr.b}: riding non trouvé`);
      continue;
    }
    console.log(`  ${tr.a} → ${tr.b} (${tr.note}):`);
    console.log(`    share ${c.party}: ${(eff.shareA * 100).toFixed(1)}% → ${(eff.shareB * 100).toFixed(1)}% (prov: ${(eff.provA * 100).toFixed(1)}% → ${(eff.provB * 100).toFixed(1)}%)`);
    console.log(`    effet log: ${eff.logEffect.toFixed(3)}  (positif = surperformance vs swing provincial)`);
    results.push({ ...c, ...tr, ...eff });
  }
  console.log();
}

// --- compare with production leader effects -------------------------------
console.log("=== Comparaison avec les effets leader de production ===\n");
console.log("  Catégorie          n    delta_2026 (log)   facteur (exp)");
console.log(`  Arrivée (leader)   ${leaderEffect.effects.arrivee.n}    ${leaderEffect.effects.arrivee.delta_2026.toFixed(3).padStart(10)}         ${Math.exp(leaderEffect.effects.arrivee.delta_2026).toFixed(2)}x`);
console.log(`  Continuation       ${leaderEffect.effects.continuation.n}    ${leaderEffect.effects.continuation.delta_2026.toFixed(3).padStart(10)}         ${Math.exp(leaderEffect.effects.continuation.delta_2026).toFixed(2)}x`);
console.log(`  Départ             ${leaderEffect.effects.depart.n}    ${leaderEffect.effects.depart.delta_2026.toFixed(3).padStart(10)}         ${Math.exp(leaderEffect.effects.depart.delta_2026).toFixed(2)}x`);

if (results.length > 0) {
  const demiChefEffects = results.map((r) => r.logEffect);
  const meanDemiChef = demiChefEffects.reduce((a, b) => a + b, 0) / demiChefEffects.length;
  console.log(`\n  Demi-chef (ce test) ${results.length}    ${meanDemiChef.toFixed(3).padStart(10)}         ${Math.exp(meanDemiChef).toFixed(2)}x`);
  console.log("\n  Cas individuels:");
  for (const r of results) {
    console.log(`    ${r.name.padEnd(22)} ${r.riding.padEnd(28)} ${r.a} → ${r.b}: effet ${r.logEffect.toFixed(3)}`);
  }
}

// --- apply to Jean-Lesage 2026 --------------------------------------------
console.log("\n=== Application à Jean-Lesage 2026 (Zanetti) ===\n");

// Current prediction (without demi-chef effect)
const jlCode = "757";
const jlForecast = proj.ridingForecast[jlCode];
const jlWinProbs = proj.ridingWinProbs[jlCode];
console.log("  Prédiction actuelle (sans effet demi-chef):");
console.log(`    shares: ${JSON.stringify(Object.fromEntries(Object.entries(jlForecast.shares).map(([k, v]) => [k, +(v * 100).toFixed(1)])))}`);
console.log(`    winner: ${jlForecast.winner}`);
console.log(`    winProbs: QS ${(jlWinProbs.QS * 100).toFixed(1)}%, PCQ ${(jlWinProbs.PCQ * 100).toFixed(1)}%`);

// Actual result
const dgeq = JSON.parse(readFileSync(new URL("../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));
const jlActual = dgeq.circonscriptions.find((c) => c.nomCirconscription === "Jean-Lesage" || String(c.numeroCirconscription) === jlCode);
if (jlActual) {
  const votes = {};
  for (const cand of jlActual.candidats) {
    const p = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" }[cand.abreviationPartiPolitique] ?? "AUTRES";
    votes[p] = (votes[p] ?? 0) + cand.nbVoteTotal;
  }
  const tot = Object.values(votes).reduce((a, b) => a + b, 0);
  console.log(`\n  Résultat réel 2026:`);
  console.log(`    shares: ${JSON.stringify(Object.fromEntries(Object.entries(votes).map(([k, v]) => [k, +(v / tot * 100).toFixed(1)])))}`);
  const winner = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  console.log(`    winner: ${winner}`);
}

// What would a demi-chef effect do?
if (results.length > 0) {
  const meanDemiChef = results.reduce((s, r) => s + r.logEffect, 0) / results.length;
  console.log(`\n  Si on appliquait un effet demi-chef de ${meanDemiChef.toFixed(3)} log (×${Math.exp(meanDemiChef).toFixed(2)}):`);
  console.log(`    QS share augmenterait d'environ ${((Math.exp(meanDemiChef) - 1) * jlForecast.shares.QS * 100).toFixed(1)} pp`);
  console.log(`    (estimation grossière — l'effet réel dépend de la structure ILR)`);
}

// --- verdict ---------------------------------------------------------------
console.log("\n=== Verdict ===\n");
if (results.length < 3) {
  console.log("  Données insuffisantes: moins de 3 cas historiques de co-porte-parole trouvés.");
  console.log("  L'effet demi-chef ne peut pas être estimé de manière fiable.");
} else {
  const meanDemiChef = results.reduce((s, r) => s + r.logEffect, 0) / results.length;
  const leaderContinuation = leaderEffect.effects.continuation.delta_2026;
  console.log(`  Effet demi-chef moyen: ${meanDemiChef.toFixed(3)} log (vs continuation leader: ${leaderContinuation.toFixed(3)})`);
  console.log(`  Ratio demi-chef/leader: ${(meanDemiChef / leaderContinuation).toFixed(2)}`);
  if (meanDemiChef > leaderContinuation * 0.3) {
    console.log("  L'effet demi-chef semble réel et non négligeable (> 30% de l'effet leader).");
  } else {
    console.log("  L'effet demi-chef semble faible (< 30% de l'effet leader).");
  }
}
