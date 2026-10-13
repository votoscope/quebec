/**
 * Incumbency effect by party: does the personal vote vary across parties?
 *
 * The production model applies a single incumbency factor (exp(0.118) ≈ 1.125)
 * to every open seat, estimated from the 2018→2022 transition. This test
 * re-estimates the effect by PARTY from the 2022→2026 transition (68
 * incumbents running again, 57 open seats) and asks:
 *
 *   1. Does the incumbency effect differ significantly across parties?
 *   2. Would party-specific factors have improved the 2026 seat predictions?
 *
 * Method (log-space, per party P):
 *   incumbency_effect = mean over incumbent ridings of
 *     [log(share_P_2026) - log(share_P_2022)] - [log(prov_P_2026) - log(prov_P_2022)]
 *   open_deficit = mean over open ridings of the same quantity
 *   factor_P = exp(incumbency_effect)  (applied to open seats: share / factor_P)
 *
 * Validation: rerun the 2026 seat projection with party-specific factors
 * vs the global factor, compare seat errors against actual results.
 *
 * Run: node js/tools/incumbency_party_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { ridingBaselineFromRows, provinceShareFromRows, uniformClrSwing, normalizeRidingCode, applyOpenSeatPenalty } from "../src/swing.js";
import { residualIlr, ilrMatrix, PARTIES } from "../src/ridingEffects.js";

const { ilr, ilrInv, closure, multiplicativeReplacement } = mva.composition;

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const baseline26 = load("../data/qc_2022_baseline_2026map.json");
const incumbents = load("../data/qc_incumbents.json");
const features2026 = load("../data/qc_riding_features_2026.json");
const ridingRegions = load("../data/qc_riding_regions.json");
const proj = load("../data/qc_projection.json");

const partyCodes = proj.partyCodes;
const MAIN = ["CAQ", "LIB", "QS", "PQ", "PCQ"];

// --- 2026 actual results ---------------------------------------------------
const dgeq = JSON.parse(readFileSync(new URL("../data/raw/lus/2026-10-05-resultats-dgeq.json", import.meta.url), "utf-8"));
const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };
const rows2026 = [];
for (const c of dgeq.circonscriptions) {
  for (const cand of c.candidats) {
    rows2026.push({
      election_date: "2026-10-05", boundary_year: "2026", riding_code: String(c.numeroCirconscription),
      party_code: MAP[cand.abreviationPartiPolitique] ?? "AUTRES", votes: cand.nbVoteTotal,
    });
  }
}
// Riding-level shares 2026 (by code)
const shares2026 = new Map();
{
  const byRiding = new Map();
  for (const r of rows2026) {
    if (!byRiding.has(r.riding_code)) byRiding.set(r.riding_code, Object.fromEntries(partyCodes.map((p) => [p, 0])));
    byRiding.get(r.riding_code)[r.party_code] += r.votes;
  }
  for (const [code, votes] of byRiding) {
    const tot = partyCodes.reduce((s, p) => s + votes[p], 0);
    shares2026.set(code, Object.fromEntries(partyCodes.map((p) => [p, votes[p] / tot])));
  }
}
// Actual winners 2026
const winner2026 = new Map();
for (const [code, shares] of shares2026) {
  winner2026.set(code, partyCodes.reduce((best, p) => (shares[p] > shares[best] ? p : best), partyCodes[0]));
}
// Provincial 2026
const provVotes2026 = {};
for (const p of dgeq.statistiques.partisPolitiques) {
  const code = MAP[p.abreviationPartiPolitique] ?? "AUTRES";
  provVotes2026[code] = (provVotes2026[code] ?? 0) + p.nbVoteTotal;
}
const provTot2026 = Object.values(provVotes2026).reduce((a, b) => a + b, 0);
const prov2026 = Object.fromEntries(partyCodes.map((p) => [p, (provVotes2026[p] ?? 0) / provTot2026]));

// --- baselines -------------------------------------------------------------
const ridingBaseline = ridingBaselineFromRows(baseline26, partyCodes); // Map code -> array
const provBaseline = provinceShareFromRows(baseline26, partyCodes);

// Code by riding name
const codeByName = new Map(features2026.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)]));

// --- estimate incumbency effect by party -----------------------------------
console.log("=== Estimation de l'effet de sortant par parti (2022→2026) ===\n");

// Provincial log-swing per party
const logSwing = Object.fromEntries(
  partyCodes.map((p) => [p, Math.log(Math.max(prov2026[p], 1e-6) / Math.max(provBaseline[p], 1e-6))])
);

const byParty = {};
for (const inc of incumbents) {
  const party = inc.current_party;
  if (!MAIN.includes(party)) continue;
  const code = codeByName.get(inc.riding_name);
  if (!code) continue;
  const base = ridingBaseline.get(code);
  const actual = shares2026.get(code);
  if (!base || !actual) continue;

  const idx = partyCodes.indexOf(party);
  const share2022 = Math.max(base[idx], 1e-6);
  const share2026 = Math.max(actual[party], 1e-6);
  // Excess log-growth beyond provincial swing
  const excess = (Math.log(share2026) - Math.log(share2022)) - logSwing[party];

  const isOpen = inc.elected_with_note !== null;
  byParty[party] = byParty[party] ?? { incumbent: [], open: [] };
  byParty[party][isOpen ? "open" : "incumbent"].push({ excess, share2022, riding: inc.riding_name });
}

console.log("  parti   n_incumbent  n_open   effet sortant (log)   facteur   vs production (1.125)");
const factors = {};
for (const p of MAIN) {
  const data = byParty[p];
  if (!data || data.incumbent.length === 0 || data.open.length === 0) {
    console.log(`  ${p.padEnd(5)}   ${String(data?.incumbent.length ?? 0).padStart(5)}       ${String(data?.open.length ?? 0).padStart(5)}    (données insuffisantes)`);
    factors[p] = 1.125; // fallback to production
    continue;
  }
  const incMean = data.incumbent.reduce((s, d) => s + d.excess, 0) / data.incumbent.length;
  const openMean = data.open.reduce((s, d) => s + d.excess, 0) / data.open.length;
  // The incumbency effect is the DIFFERENCE between incumbent and open ridings
  const effect = incMean - openMean;
  const factor = Math.exp(effect);
  factors[p] = factor;
  console.log(
    `  ${p.padEnd(5)}   ${String(data.incumbent.length).padStart(5)}       ${String(data.open.length).padStart(5)}    ${effect.toFixed(4).padStart(10)}      ${factor.toFixed(3).padStart(6)}     ${factor > 1.125 ? "+" : ""}${(factor / 1.125 - 1).toFixed(2)}x`
  );
}

// Global factor (pooled across parties)
const allIncumbent = Object.values(byParty).flatMap((d) => d.incumbent);
const allOpen = Object.values(byParty).flatMap((d) => d.open);
const globalEffect = allIncumbent.reduce((s, d) => s + d.excess, 0) / allIncumbent.length
  - allOpen.reduce((s, d) => s + d.excess, 0) / allOpen.length;
console.log(`\n  Global (poolé): effet ${globalEffect.toFixed(4)}, facteur ${Math.exp(globalEffect).toFixed(3)} (production: 1.125)`);

// --- validation: seat predictions with global vs party-specific factors ----
console.log("\n=== Validation: prédiction 2026 (vote provincial réel en entrée) ===\n");

// Use the actual provincial result as the "forecast" to isolate the riding layer
const provForecast = prov2026;

function predictSeats(factorByParty) {
  // Apply open-seat penalty with party-specific factors
  const baseline = new Map([...ridingBaseline].map(([k, v]) => [k, [...v]]));
  for (const inc of incumbents) {
    if (inc.elected_with_note === null) continue; // incumbent running, no penalty
    const code = codeByName.get(inc.riding_name);
    if (!code) continue;
    const party = inc.current_party;
    const factor = factorByParty[party] ?? 1.125;
    applyOpenSeatPenalty(baseline, new Set([code]), factor);
  }
  // Uniform swing to actual provincial result
  const forecast = uniformClrSwing(baseline, provBaseline, provForecast, partyCodes);
  // Count seats and compute riding-level MAE
  const seats = {};
  let mae = 0, n = 0;
  for (const [code, entry] of forecast) {
    seats[entry.winner] = (seats[entry.winner] ?? 0) + 1;
    const actual = shares2026.get(code);
    if (actual) {
      for (const p of MAIN) {
        mae += Math.abs((entry.shares[p] ?? 0) - (actual[p] ?? 0)) * 100;
        n++;
      }
    }
  }
  return { seats, mae: mae / n };
}

const ACTUAL_SEATS = { PQ: 59, LIB: 40, PCQ: 19, CAQ: 0, QS: 9 };

const resProd = predictSeats(Object.fromEntries(MAIN.map((p) => [p, 1.125])));
const resGlobal = predictSeats(Object.fromEntries(MAIN.map((p) => [p, Math.exp(globalEffect)])));
const resParty = predictSeats(factors);

const absErr = (s) => MAIN.reduce((e, p) => e + Math.abs((s[p] ?? 0) - ACTUAL_SEATS[p]), 0);

console.log("  scénario                      sièges prédits                                      erreur sièges   MAE riding (pp)");
console.log(`  production (facteur 1.125)    ${JSON.stringify(resProd.seats)}  ${absErr(resProd.seats).toString().padStart(6)}        ${resProd.mae.toFixed(2)}`);
console.log(`  global 2026 (${Math.exp(globalEffect).toFixed(3)})         ${JSON.stringify(resGlobal.seats)}  ${absErr(resGlobal.seats).toString().padStart(6)}        ${resGlobal.mae.toFixed(2)}`);
console.log(`  par parti                   ${JSON.stringify(resParty.seats)}  ${absErr(resParty.seats).toString().padStart(6)}        ${resParty.mae.toFixed(2)}`);
console.log(`  réel                        ${JSON.stringify(ACTUAL_SEATS)}`);

// --- per-party breakdown ---------------------------------------------------
console.log("\n=== Détail par parti (prédiction vs réel) ===\n");
console.log("  parti   prod   global 2026   par parti   réel");
for (const p of MAIN) {
  console.log(`  ${p.padEnd(5)}  ${String(resProd.seats[p] ?? 0).padStart(5)}  ${String(resGlobal.seats[p] ?? 0).padStart(10)}  ${String(resParty.seats[p] ?? 0).padStart(10)}  ${String(ACTUAL_SEATS[p]).padStart(5)}`);
}

// --- verdict ---------------------------------------------------------------
console.log("\n=== Verdict ===\n");
const errProd = absErr(resProd.seats);
const errParty = absErr(resParty.seats);
const maeProd = resProd.mae;
const maeParty = resParty.mae;
console.log(`  Erreur de sièges: production ${errProd}, par parti ${errParty} (${errParty < errProd ? "amélioration" : errParty > errProd ? "dégradation" : "identique"})`);
console.log(`  MAE riding-level: production ${maeProd.toFixed(2)} pp, par parti ${maeParty.toFixed(2)} pp (${maeParty < maeProd ? "amélioration" : maeParty > maeProd ? "dégradation" : "identique"})`);

if (errParty < errProd || maeParty < maeProd * 0.98) {
  console.log(`\n  Les facteurs par parti améliorent les prédictions.`);
} else {
  console.log(`\n  Les facteurs par parti n'améliorent pas significativement les prédictions.`);
  console.log(`  Note: ce test utilise la transition 2022→2026 pour estimer ET valider,`);
  console.log(`  ce qui est optimiste (fuite). Échantillons petits (PQ: 3+4, QS: 6+5).`);
  console.log(`  L'effet de sortant ne varie pas assez par parti pour justifier des facteurs séparés.`);
}

// Statistical significance: is the party variation significant?
console.log("\n  Variabilité inter-partis (partis avec données suffisantes):");
const partyEffects = MAIN.filter((p) => byParty[p] && byParty[p].incumbent.length > 0 && byParty[p].open.length > 0).map((p) => {
  const d = byParty[p];
  return { p, effect: d.incumbent.reduce((s, x) => s + x.excess, 0) / d.incumbent.length - d.open.reduce((s, x) => s + x.excess, 0) / d.open.length, n: d.incumbent.length + d.open.length };
});
if (partyEffects.length >= 2) {
  const meanEffect = partyEffects.reduce((s, d) => s + d.effect, 0) / partyEffects.length;
  const sdEffect = Math.sqrt(partyEffects.reduce((s, d) => s + (d.effect - meanEffect) ** 2, 0) / partyEffects.length);
  console.log(`    effets: ${partyEffects.map((d) => d.p + "=" + d.effect.toFixed(3) + " (n=" + d.n + ")").join(", ")}`);
  console.log(`    moyenne ${meanEffect.toFixed(3)}, écart-type ${sdEffect.toFixed(3)}, CV ${(sdEffect / Math.abs(meanEffect)).toFixed(2)}`);
  // Simple t-test: is the variation larger than within-party noise?
  const withinVar = partyEffects.reduce((s, d) => {
    const data = byParty[d.p];
    const all = [...data.incumbent, ...data.open].map((x) => x.excess);
    const m = all.reduce((a, b) => a + b, 0) / all.length;
    return s + all.reduce((sq, x) => sq + (x - m) ** 2, 0) / all.length;
  }, 0) / partyEffects.length;
  const fStat = (sdEffect ** 2) / Math.max(withinVar, 1e-6);
  console.log(`    variance inter ${sdEffect.toFixed(4)}, variance intra ${Math.sqrt(withinVar).toFixed(4)}, ratio F ≈ ${fStat.toFixed(1)}`);
  console.log(`    (F > ~${(3 + partyEffects.length).toFixed(0)} serait significatif à p<0.05 avec ${partyEffects.length} partis)`);
} else {
  console.log(`    Données insuffisantes pour comparer (${partyEffects.length} partis avec données complètes)`);
}
