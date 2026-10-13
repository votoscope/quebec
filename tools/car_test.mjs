/**
 * Validation harness for the CAR spatial field in the seat simulation.
 *
 * OBSOLETE, kept as a record (TODO, entry "Champ CAR"): simulateSeatCounts
 * no longer accepts `spatialField`, so both arms below are identical. The
 * design was also invalid as a validation: the verdict only checks that the
 * intervals widen (circular), and the "coverage" section scores a 2026-input
 * simulation against hand-typed, incorrect 2018/2022 seat counts.
 *
 * Compares the simulated seat distributions with and without the CAR field
 * on the adjacency graph, measuring:
 *   1. interval widths (p05-p95) per party -- the CAR field should widen
 *      them, since correlated ridings no longer cancel across the province;
 *   2. coverage of the actual seat counts (2018, 2022, 2026) -- the actual
 *      counts should fall inside the 90% interval at least as often as the
 *      nominal rate, and the quantile of the actual in the simulated
 *      distribution should be more uniform (less pile-up at the extremes);
 *   3. the estimated CAR parameters (rho per ILR coordinate).
 *
 * Design: the simulation is run twice on the SAME inputs (same province
 * draws, same residuals, same seed) so the only difference is the residual
 * sampling mechanism (i.i.d. resampling vs CAR field). This isolates the
 * effect of the spatial correlation structure.
 *
 * Run: node js/tools/car_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { simulateSeatCounts } from "../src/simulate.js";
import { estimateCARParams, buildAdjacencyMatrix } from "../src/spatialField.js";
import { residualIlr, PARTIES } from "../src/ridingEffects.js";
import { ridingBaselineFromRows, provinceShareFromRows } from "../src/swing.js";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const baselineRows = load("../data/qc_2022_baseline_2026map.json");
const ridingResults = load("../data/qc_riding_results.json");
const ridingRegions = load("../data/qc_riding_regions.json");
const systemicParams = load("../data/qc_systemic.json");
const geo = load("../data/qc_ridings_2026.geojson");
const adjacencyFile = load("../data/qc_adjacency.json");
const features2017 = load("../data/qc_riding_features_2017.json");
const features2026 = load("../data/qc_riding_features_2026.json");
const proj = load("../data/qc_projection.json");

const partyCodes = proj.partyCodes;
const regionByCode = new Map(ridingRegions.map((r) => [String(r.riding_code), r.region_code]));

// --- baselines ------------------------------------------------------------
const ridingBaseline = ridingBaselineFromRows(baselineRows, partyCodes);
const provinceBaseline = provinceShareFromRows(baselineRows, partyCodes);

// --- residuals (held-out model errors, as in production) ------------------
// The production simulation uses the riding-effects model's held-out
// residuals. For this test we use the raw 2018->2022 departures on the
// 2017 map (keyed by riding NAME in qc_riding_results.json), then map the
// names to 2026 numeric codes via features2026 for the CAR adjacency.
const res = residualIlr(ridingResults, "2018-10-01", "2017", "2022-10-03", "2017", partyCodes);
const residuals = res.Y;
const residualNames = res.ridings; // riding names (e.g. "Rosemont")

// Map riding names -> 2026 numeric codes
const code2026ByName = new Map(
  features2026.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)])
);
const residualCodes = residualNames.map((name) => code2026ByName.get(String(name)) ?? null).filter(Boolean);

// Keep only residuals whose riding code is in the adjacency graph
const adjCodes = new Set(adjacencyFile.codes);
const keepIdx = [];
const residualCodesKept = [];
residualNames.forEach((name, i) => {
  const code = code2026ByName.get(String(name));
  if (code && adjCodes.has(code)) {
    keepIdx.push(i);
    residualCodesKept.push(code);
  }
});
const residualsKept = keepIdx.map((i) => residuals[i]);

console.log(`  residus 2018->2022 (carte 2017) : ${residuals.length}`);
console.log(`  apres mapping sur codes 2026     : ${residualsKept.length}`);

// Residual regions (for the regional decomposition in the simulation)
const residualRegions = residualCodesKept.map((code) => regionByCode.get(String(code)) ?? null);

// --- adjacency and CAR params ---------------------------------------------
const adjacency = adjacencyFile.codes && adjacencyFile.W
  ? adjacencyFile
  : buildAdjacencyMatrix(geo);

console.log("=== Champ CAR : parametres estimes ===\n");
const carParams = estimateCARParams(residualsKept, residualCodesKept, adjacency);
console.log(`  rho par coordonnee ILR : [${carParams.rho.map((r) => r.toFixed(3)).join(", ")}]`);
console.log(`  sigma2 par coord.      : [${carParams.sigma2.map((s) => s.toFixed(4)).join(", ")}]`);
console.log(`  rho moyen              : ${(carParams.rho.reduce((a, b) => a + b, 0) / carParams.rho.length).toFixed(3)}`);
console.log(`  circonscriptions dans le graphe : ${carParams.codes.length}`);
console.log(`  residus avec code 2026 valide  : ${residualsKept.length}`);

// --- province draws (reuse the production projection's vote draws) --------
// We re-run the simulation with synthetic province draws centred on the
// production point forecast, so the comparison isolates the residual
// mechanism. Use a fixed seed for reproducibility.
const forecastPoint = Object.fromEntries(
  partyCodes.map((p) => [p, proj.trendSeries[proj.trendSeries.length - 1][p].mean])
);

// Generate 5000 province draws around the forecast point (approximate the
// GP posterior with a simple multivariate normal in share space, then
// renormalise). This is NOT the production trend posterior -- it is a
// controlled input so the i.i.d. vs CAR comparison is apples-to-apples.
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
const sdVote = 0.03; // ~3pp national uncertainty, typical of the GP posterior
const provinceDraws = Array.from({ length: 5000 }, () => {
  // Sample in ILR space to keep the composition valid (all parts positive),
  // then inverse-ILR back to the simplex.
  const { ilr, ilrInv } = mva.composition;
  const base = ilr([partyCodes.map((p) => forecastPoint[p])])[0];
  const perturbed = base.map((v) => v + randn(rng) * sdVote);
  const shares = ilrInv([perturbed])[0];
  return Object.fromEntries(partyCodes.map((p, i) => [p, shares[i]]));
});

// --- run both simulations -------------------------------------------------
const commonOpts = {
  seed: 1,
  systemic: {
    sigmaIndustry: systemicParams.sigma_industry,
    sigmaDaily2: systemicParams.sigma_daily2,
    daysToElection: 0,
  },
  regionByRiding: regionByCode,
  residualRegions,
  noEffectScale: 1,
};

const t0 = Date.now();
const simIID = simulateSeatCounts(
  ridingBaseline, provinceBaseline, provinceDraws, residualsKept, partyCodes,
  { ...commonOpts, spatialField: null }
);
const tIID = Date.now() - t0;

const t1 = Date.now();
const simCAR = simulateSeatCounts(
  ridingBaseline, provinceBaseline, provinceDraws, residualsKept, partyCodes,
  { ...commonOpts, spatialField: carParams }
);
const tCAR = Date.now() - t1;

// --- compare seat distributions -------------------------------------------
function seatSummary(draws, partyCodes) {
  const out = {};
  for (const p of partyCodes) {
    const vals = draws.map((d) => d[p]).sort((a, b) => a - b);
    const q = (pct) => vals[Math.floor((pct / 100) * (vals.length - 1))];
    out[p] = {
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      p05: q(5), p50: q(50), p95: q(95),
      width: q(95) - q(5),
    };
  }
  return out;
}

const sumIID = seatSummary(simIID.draws, partyCodes);
const sumCAR = seatSummary(simCAR.draws, partyCodes);

console.log("\n=== Distributions de sieges : i.i.d. vs CAR ===\n");
console.log("  parti   iid [p05-p95]     largeur    CAR [p05-p95]     largeur   ratio");
for (const p of partyCodes) {
  const a = sumIID[p], b = sumCAR[p];
  const ri = `[${a.p05}-${a.p95}]`;
  const rc = `[${b.p05}-${b.p95}]`;
  console.log(
    `  ${p.padEnd(5)}  ${ri.padEnd(16)}  ${a.width.toFixed(1).padStart(5)}    ${rc.padEnd(16)}  ${b.width.toFixed(1).padStart(5)}   ${(b.width / a.width).toFixed(2)}x`
  );
}
console.log(`\n  temps : i.i.d. ${tIID}ms, CAR ${tCAR}ms`);

// --- coverage of actual results -------------------------------------------
// Actual seat counts (2018, 2022, 2026) -- the CAR field should improve
// coverage (the actual counts should fall less often in the extreme tails).
const ACTUAL = {
  "2018": { PQ: 54, LIB: 36, CAQ: 65, QS: 10 },  // approximate 2018 results
  "2022": { PQ: 5, LIB: 21, CAQ: 90, QS: 11 },   // approximate 2022 results
  "2026": { PQ: 59, LIB: 40, PCQ: 19, CAQ: 0, QS: 9 },
};

console.log("\n=== Couverture des resultats reels (quantile du reel dans la distribution simulee) ===\n");
console.log("  (une couverture honnete aurait les quantiles repartis uniformement dans [0,1])\n");
console.log("  election  parti   i.i.d. quantile    CAR quantile");
for (const [year, seats] of Object.entries(ACTUAL)) {
  for (const p of partyCodes) {
    if (!(p in seats)) continue;
    const actual = seats[p];
    const valsIID = simIID.draws.map((d) => d[p]).sort((a, b) => a - b);
    const valsCAR = simCAR.draws.map((d) => d[p]).sort((a, b) => a - b);
    const qIID = valsIID.filter((v) => v <= actual).length / valsIID.length;
    const qCAR = valsCAR.filter((v) => v <= actual).length / valsCAR.length;
    const flagIID = (qIID < 0.05 || qIID > 0.95) ? "  <-- queue" : "";
    const flagCAR = (qCAR < 0.05 || qCAR > 0.95) ? "  <-- queue" : "";
    console.log(
      `  ${year}     ${p.padEnd(5)}  ${qIID.toFixed(3).padStart(10)}        ${qCAR.toFixed(3).padStart(10)}${flagCAR || flagIID}`
    );
  }
}

// --- medoid and scenario comparison ---------------------------------------
console.log("\n=== Comparaison des scenarios (medoide) ===\n");
console.log(`  i.i.d. medoide : ${JSON.stringify(simIID.draws[0])}`);
// (medoidDraw is O(n^2), skip for the test -- just report the point counts)
const pointCounts = {};
for (const entry of Object.values(proj.ridingForecast)) {
  pointCounts[entry.winner] = (pointCounts[entry.winner] ?? 0) + 1;
}
console.log(`  point projection : ${JSON.stringify(pointCounts)}`);

// --- verdict ---------------------------------------------------------------
const avgWidthIID = partyCodes.reduce((s, p) => s + sumIID[p].width, 0) / partyCodes.length;
const avgWidthCAR = partyCodes.reduce((s, p) => s + sumCAR[p].width, 0) / partyCodes.length;
console.log("\n=== Verdict ===\n");
console.log(`  largeur moyenne [p05-p95] : i.i.d. ${avgWidthIID.toFixed(1)} sieges, CAR ${avgWidthCAR.toFixed(1)} sieges (+${((avgWidthCAR / avgWidthIID - 1) * 100).toFixed(0)}%)`);
console.log(`  rho CAR moyen              : ${(carParams.rho.reduce((a, b) => a + b, 0) / carParams.rho.length).toFixed(3)}`);
console.log(`  cout calcul                : +${(tCAR - tIID)}ms sur 5000 tirages`);

if (avgWidthCAR > avgWidthIID * 1.05) {
  console.log("\n  => Le champ CAR elargit les intervalles de sieges comme attendu.");
  console.log("     La corrélation spatiale des residus (0,216 pooled, p<0,01) est maintenant propagée.");
} else if (avgWidthCAR < avgWidthIID * 0.95) {
  console.log("\n  => ATTENTION : le champ CAR retrecit les intervalles, inattendu.");
} else {
  console.log("\n  => Le champ CAR a un effet marginal sur les largeurs d'intervalles.");
}
