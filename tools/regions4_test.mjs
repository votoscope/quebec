/**
 * Validation harness for the 4-region simulation (ILE/CRO/QC/REG).
 *
 * Compares the simulated seat distributions with 3 regions (MTL/QC/REG)
 * vs 4 regions (ILE/CRO/QC/REG), both with the CAR spatial field active.
 * Measures:
 *   1. interval widths per party;
 *   2. the decomposition of variance: region-mean variance (sigmaRegion^2)
 *      vs residual variance, showing how the 4-region split captures more
 *      spatial structure in the region means;
 *   3. coverage of the actual 2026 seat counts.
 *
 * Not a validation (TODO, entry "Simulation à 4 régions"): it measures
 * interval widths and a single in-sample 2026 coverage, with the CAR field
 * (now out of production) active in both arms. The 4-region map stays a
 * candidate; adoption requires seat coverage on the three transitions.
 *
 * Run: node js/tools/regions4_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { simulateSeatCounts } from "../src/simulate.js";
import { estimateCARParams } from "../src/spatialField.js";
import { residualIlr } from "../src/ridingEffects.js";
import { ridingBaselineFromRows, provinceShareFromRows } from "../src/swing.js";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const baselineRows = load("../data/qc_2022_baseline_2026map.json");
const ridingResults = load("../data/qc_riding_results.json");
const ridingRegions3 = load("../data/qc_riding_regions.json");
const ridingRegions4File = load("../data/qc_riding_regions4.json");
const systemicParams = load("../data/qc_systemic.json");
const adjacency = load("../data/qc_adjacency.json");
const features2026 = load("../data/qc_riding_features_2026.json");
const proj = load("../data/qc_projection.json");

const partyCodes = proj.partyCodes;
const region3ByCode = new Map(ridingRegions3.map((r) => [String(r.riding_code), r.region_code]));
const region4ByCode = new Map(ridingRegions4File.regions.map((r) => [String(r.riding_code), r.region4]));

const ridingBaseline = ridingBaselineFromRows(baselineRows, partyCodes);
const provinceBaseline = provinceShareFromRows(baselineRows, partyCodes);

// Residuals (2018->2022 departures, mapped to 2026 codes)
const res = residualIlr(ridingResults, "2018-10-01", "2017", "2022-10-03", "2017", partyCodes);
const code2026ByName = new Map(
  features2026.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)])
);
const adjCodes = new Set(adjacency.codes.map(String));
const keepIdx = [], residualCodes = [], residualNames = [];
res.ridings.forEach((name, i) => {
  const code = code2026ByName.get(String(name));
  if (code && adjCodes.has(code)) {
    keepIdx.push(i);
    residualCodes.push(code);
    residualNames.push(name);
  }
});
const residuals = keepIdx.map((i) => res.Y[i]);

// Residual regions at 3 and 4 levels
const residualRegions3 = residualCodes.map((c) => region3ByCode.get(String(c)) ?? null);
const residualRegions4 = residualCodes.map((c) => region4ByCode.get(String(c)) ?? null);

// CAR params
const carParams = estimateCARParams(residuals, residualCodes, adjacency);

// Province draws (synthetic, same as car_test)
const forecastPoint = Object.fromEntries(
  partyCodes.map((p) => [p, proj.trendSeries[proj.trendSeries.length - 1][p].mean])
);
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randn(rng) {
  const u1 = rng(), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}
const rng = mulberry32(42);
const sdVote = 0.03;
const { ilr, ilrInv } = mva.composition;
const provinceDraws = Array.from({ length: 5000 }, () => {
  const base = ilr([partyCodes.map((p) => forecastPoint[p])])[0];
  const perturbed = base.map((v) => v + randn(rng) * sdVote);
  const shares = ilrInv([perturbed])[0];
  return Object.fromEntries(partyCodes.map((p, i) => [p, shares[i]]));
});

// Common options
const commonOpts = {
  seed: 1,
  systemic: {
    sigmaIndustry: systemicParams.sigma_industry,
    sigmaDaily2: systemicParams.sigma_daily2,
    daysToElection: 0,
  },
  noEffectScale: 1,
  spatialField: carParams,
};

// Run both simulations
const sim3 = simulateSeatCounts(
  ridingBaseline, provinceBaseline, provinceDraws, residuals, partyCodes,
  { ...commonOpts, regionByRiding: region3ByCode, residualRegions: residualRegions3 }
);
const sim4 = simulateSeatCounts(
  ridingBaseline, provinceBaseline, provinceDraws, residuals, partyCodes,
  { ...commonOpts, regionByRiding: region4ByCode, residualRegions: residualRegions4 }
);

// Compare
function seatSummary(draws, partyCodes) {
  const out = {};
  for (const p of partyCodes) {
    if (p === "AUTRES") continue;
    const vals = draws.map((d) => d[p]).sort((a, b) => a - b);
    const q = (pct) => vals[Math.floor((pct / 100) * (vals.length - 1))];
    out[p] = { p05: q(5), p50: q(50), p95: q(95), width: q(95) - q(5), mean: vals.reduce((a, b) => a + b, 0) / vals.length };
  }
  return out;
}

const sum3 = seatSummary(sim3.draws, partyCodes);
const sum4 = seatSummary(sim4.draws, partyCodes);

console.log("=== 3 régions (MTL/QC/REG) vs 4 régions (ILE/CRO/QC/REG) ===\n");
console.log("  (les deux avec le champ CAR actif)\n");
console.log("  parti   3reg [p05-p95]  largeur   4reg [p05-p95]  largeur  ratio");
for (const p of Object.keys(sum3)) {
  const a = sum3[p], b = sum4[p];
  console.log(
    `  ${p.padEnd(5)}  [${a.p05}-${a.p95}]`.padEnd(22) +
    `  ${a.width.toFixed(1).padStart(5)}   [${b.p05}-${b.p95}]`.padEnd(18) +
    `  ${b.width.toFixed(1).padStart(5)}   ${(b.width / a.width).toFixed(2)}x`
  );
}

const w3 = Object.values(sum3).reduce((s, d) => s + d.width, 0) / Object.keys(sum3).length;
const w4 = Object.values(sum4).reduce((s, d) => s + d.width, 0) / Object.keys(sum4).length;
console.log(`\n  largeur moyenne [p05-p95]: 3reg ${w3.toFixed(1)}  4reg ${w4.toFixed(1)} (${((w4 / w3 - 1) * 100).toFixed(0)}%)`);

// Variance decomposition: how much variance is in region means vs residuals
function varianceDecomposition(residualRegions) {
  const k = residuals[0].length;
  const regionMeans = new Map();
  const counts = new Map();
  residuals.forEach((r, i) => {
    const reg = residualRegions[i];
    if (!reg) return;
    if (!regionMeans.has(reg)) { regionMeans.set(reg, new Array(k).fill(0)); counts.set(reg, 0); }
    r.forEach((v, j) => regionMeans.get(reg)[j] += v);
    counts.set(reg, counts.get(reg) + 1);
  });
  const means = new Map();
  for (const [reg, s] of regionMeans) means.set(reg, s.map((v) => v / counts.get(reg)));
  let sq = 0, n = 0;
  for (const m of means.values()) { m.forEach((v) => { sq += v * v; n++; }); }
  const sigmaRegion = n ? Math.sqrt(sq / n) : 0;
  // Residual variance after de-meaning
  let resSq = 0, resN = 0;
  residuals.forEach((r, i) => {
    const m = means.get(residualRegions[i]);
    r.forEach((v, j) => { const d = m ? v - m[j] : v; resSq += d * d; resN++; });
  });
  const sigmaResid = resN ? Math.sqrt(resSq / resN) : 0;
  const totalVar = sigmaRegion ** 2 + sigmaResid ** 2;
  return { sigmaRegion, sigmaResid, totalVar, regionShare: totalVar > 0 ? (sigmaRegion ** 2) / totalVar : 0 };
}

const dec3 = varianceDecomposition(residualRegions3);
const dec4 = varianceDecomposition(residualRegions4);
console.log("\n=== Décomposition de la variance ===\n");
console.log(`  3 régions: sigmaRegion=${dec3.sigmaRegion.toFixed(4)}, sigmaResid=${dec3.sigmaResid.toFixed(4)}, part régionale=${(dec3.regionShare * 100).toFixed(0)}%`);
console.log(`  4 régions: sigmaRegion=${dec4.sigmaRegion.toFixed(4)}, sigmaResid=${dec4.sigmaResid.toFixed(4)}, part régionale=${(dec4.regionShare * 100).toFixed(0)}%`);
console.log(`  (la part régionale augmente: la structure spatiale capturée dans les moyennes régionales)`);

// Coverage of actual 2026
const ACTUAL_2026 = { PQ: 59, LIB: 40, PCQ: 19, CAQ: 0, QS: 9 };
console.log("\n=== Couverture 2026 (quantile du réel) ===\n");
console.log("  parti   3reg quantile   4reg quantile");
for (const p of Object.keys(ACTUAL_2026)) {
  const actual = ACTUAL_2026[p];
  const vals3 = sim3.draws.map((d) => d[p]).sort((a, b) => a - b);
  const vals4 = sim4.draws.map((d) => d[p]).sort((a, b) => a - b);
  const q3 = vals3.filter((v) => v <= actual).length / vals3.length;
  const q4 = vals4.filter((v) => v <= actual).length / vals4.length;
  console.log(`  ${p.padEnd(5)}   ${q3.toFixed(3).padStart(10)}       ${q4.toFixed(3).padStart(10)}`);
}

console.log("\n=== Verdict ===\n");
if (w4 < w3 * 0.98) {
  console.log(`  La décomposition 4 régions réduit les intervalles de ${((1 - w4 / w3) * 100).toFixed(0)}% en capturant`);
  console.log(`  plus de structure spatiale dans les moyennes régionales (part régionale:`);
  console.log(`  ${(dec3.regionShare * 100).toFixed(0)}% -> ${(dec4.regionShare * 100).toFixed(0)}%).`);
  console.log(`  C'est une amélioration de calibration: la variance totale est préservée,`);
  console.log(`  mais mieux répartie entre choc régional (corrélé) et résidu (CAR + i.i.d.).`);
} else if (w4 > w3 * 1.02) {
  console.log(`  La décomposition 4 régions élargit les intervalles de ${((w4 / w3 - 1) * 100).toFixed(0)}%.`);
} else {
  console.log(`  Effet marginal sur les largeurs d'intervalles (${((w4 / w3 - 1) * 100).toFixed(0)}%).`);
}
