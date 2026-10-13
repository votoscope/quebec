/**
 * Ablation des couches spatiales de la veille 2026, couche nationale fixée.
 *
 * Question : que vaut chaque couche par circonscription (circonscriptions
 * ouvertes, effet chef, bloc régional par sondages, effets GP Matérn par
 * démographie, partielles) une fois la couche nationale neutralisée ?
 *
 * Deux couches nationales :
 *   - « veille » : vote projeté publié le 2026-10-05 (participation incluse) ;
 *   - « connu »  : vote provincial réel 2026 (DGEQ), qui retire toute erreur
 *     de nowcast et isole la couche spatiale.
 * Intrants : fixtures figées du test golden (état du dépôt à la veille).
 *
 * Bras : report pur (tout éteint), chaque couche seule, production complète,
 * production moins chaque couche, et deux ORACLES régionaux qui appliquent le
 * swing régional RÉEL 2026 (3 régions MTL/QC/REG, puis 4 régions
 * ILE/CRO/QC/REG) : la borne supérieure de ce que des sondages régionaux
 * parfaits apporteraient.
 *
 * Métriques : RMSE des parts par circonscription (pp, 5 partis principaux),
 * MAE par parti, gagnants corrects, erreur absolue de sièges. La RMSE des
 * parts est la mesure principale : elle voit l'effet de chaque couche sur
 * les 127 circonscriptions, pas seulement sur les sièges qui basculent.
 *
 * Run: node js/tools/layer_ablation.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { computeProjection } from "../src/computeProjection.js";
import { ridingBaselineFromRows, provinceShareFromRows, uniformClrSwing } from "../src/swing.js";
import { ilrMatrix } from "../src/ridingEffects.js";
import { loadFixtures, GOLDEN_AS_OF } from "../test/golden_lib.mjs";
import { loadAllRows } from "./lib/harness.mjs";

const { ilrInv } = mva.composition;
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const data = loadFixtures(new URL("../test/fixtures/", import.meta.url));
// Ajustements (tendances, GP régional, effets) calculés une fois, réutilisés
// par tous les bras : seules les couches activées diffèrent.
const FIT_CACHE = {};
const published = load("../data/qc_projection_veille_2026-10-05.json");
const regions4 = load("../data/qc_riding_regions4.json").regions;
const MAIN = ["CAQ", "LIB", "PCQ", "PQ", "QS"];

// --- vérité 2026 ------------------------------------------------------------
const rows2026 = loadAllRows().filter((r) => r.election_date === "2026-10-05");
const truthVotes = new Map();
for (const r of rows2026) {
  if (!truthVotes.has(r.riding_code)) truthVotes.set(r.riding_code, {});
  const v = truthVotes.get(r.riding_code);
  v[r.party_code] = (v[r.party_code] ?? 0) + r.votes;
}
const truth = new Map([...truthVotes].map(([code, v]) => {
  const tot = Object.values(v).reduce((a, b) => a + b, 0);
  return [code, Object.fromEntries(Object.entries(v).map(([p, x]) => [p, x / tot]))];
}));
const provVotes = {};
for (const r of rows2026) provVotes[r.party_code] = (provVotes[r.party_code] ?? 0) + r.votes;
const provTot = Object.values(provVotes).reduce((a, b) => a + b, 0);
const winnerOf = (sh) => MAIN.reduce((b, p) => ((sh[p] ?? 0) > (sh[b] ?? 0) ? p : b), MAIN[0]);
const actualSeats = Object.fromEntries(MAIN.map((p) => [p, 0]));
for (const sh of truth.values()) actualSeats[winnerOf(sh)]++;

// --- métriques --------------------------------------------------------------
function score(forecast) {
  let se = 0, n = 0, correct = 0;
  const mae = Object.fromEntries(MAIN.map((p) => [p, 0]));
  const seats = Object.fromEntries(MAIN.map((p) => [p, 0]));
  let nr = 0;
  for (const [code, fc] of Object.entries(forecast)) {
    const t = truth.get(String(code));
    if (!t) continue;
    nr++;
    for (const p of MAIN) {
      const d = ((fc[p] ?? 0) - (t[p] ?? 0)) * 100;
      se += d * d; n++; mae[p] += Math.abs(d);
    }
    const w = winnerOf(fc);
    seats[w]++;
    if (w === winnerOf(t)) correct++;
  }
  for (const p of MAIN) mae[p] /= nr;
  const seatErr = MAIN.reduce((s, p) => s + Math.abs(seats[p] - actualSeats[p]), 0);
  return { rmse: Math.sqrt(se / n), mae, correct, nr, seatErr, seats };
}

// --- bras -------------------------------------------------------------------
const OFF = { openSeat: false, leaders: false, regional: false, language: false, effects: false, byelections: false };
const ARMS = [
  ["report pur", OFF],
  ["+ sièges ouverts", { ...OFF, openSeat: true }],
  ["+ effet chef", { ...OFF, leaders: true }],
  ["+ régional (sondages)", { ...OFF, regional: true }],
  ["+ langue (sondages)", { ...OFF, language: true }],
  ["+ régional + langue", { ...OFF, regional: true, language: true }],
  ["+ effets démographiques", { ...OFF, effects: true }],
  ["+ partielles", { ...OFF, byelections: true }],
  ["production complète", {}],
  ["complète − ouverts", { openSeat: false }],
  ["complète − chef", { leaders: false }],
  ["complète − régional", { regional: false }],
  ["complète − langue", { language: false }],
  ["complète + démographie", { effects: true }],
  ["complète − partielles", { byelections: false }],
];

const partyCodes = published.partyCodes;
const NATIONAL = {
  veille: Object.fromEntries(partyCodes.map((p) => [p, published.disproportion.voteShare[p] / 100])),
  connu: Object.fromEntries(partyCodes.map((p) => [p, (provVotes[p] ?? 0) / provTot])),
};

// Oracle régional : swing régional réel appliqué à la baseline, puis swing
// uniforme vers la couche nationale (même mécanique que la production).
const baselineMap = ridingBaselineFromRows(data.baselineRows, partyCodes);
const prov2022 = provinceShareFromRows(data.baselineRows, partyCodes);
function oracle(regionOf, national) {
  // Parts régionales pondérées par les votes : baseline 2022 et réel 2026.
  const votes = (rows, keyOf) => {
    const out = {};
    for (const r of rows) {
      const reg = regionOf.get(String(keyOf(r)));
      if (!reg) continue;
      out[reg] ??= Object.fromEntries(partyCodes.map((p) => [p, 0]));
      const p = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
      out[reg][p] += r.votes;
    }
    return out;
  };
  const toShares = (v) => {
    const tot = partyCodes.reduce((s, p) => s + v[p], 0);
    return partyCodes.map((p) => v[p] / tot);
  };
  const v22 = votes(data.baselineRows, (r) => String(Math.round(parseFloat(r.riding_code))));
  const v26 = votes(rows2026, (r) => r.riding_code);
  const regs = Object.keys(v26);
  const prov26 = partyCodes.map((p) => (provVotes[p] ?? 0) / provTot);
  const prov22 = partyCodes.map((p) => prov2022[p]);
  const M = ilrMatrix([...regs.map((r) => toShares(v22[r])), ...regs.map((r) => toShares(v26[r])), prov22, prov26]);
  const k = regs.length;
  const adj = new Map(regs.map((r, i) => [r, M[k + i].map((v, j) => v - M[2 * k + 1][j] - (M[i][j] - M[2 * k][j]))]));
  const shifted = new Map();
  for (const [code, sh] of baselineMap) {
    const a = adj.get(regionOf.get(String(code)));
    if (!a) { shifted.set(code, sh); continue; }
    shifted.set(code, ilrInv([ilrMatrix([sh])[0].map((v, j) => v + a[j])])[0]);
  }
  const fc = uniformClrSwing(shifted, prov2022, national, partyCodes);
  return Object.fromEntries([...fc].map(([c, e]) => [c, e.shares]));
}
const region3 = new Map(data.ridingRegions.map((r) => [String(r.riding_code), r.region_code]));
const region4 = new Map(regions4.map((r) => [String(r.riding_code), r.region4]));

// --- exécution ----------------------------------------------------------------
const fmt = (r) =>
  `${r.rmse.toFixed(2).padStart(6)}  ${MAIN.map((p) => r.mae[p].toFixed(2).padStart(5)).join(" ")}  ` +
  `${String(r.correct).padStart(3)}/${r.nr}  ${String(r.seatErr).padStart(3)}  ${JSON.stringify(r.seats)}`;

for (const [natLabel, national] of Object.entries(NATIONAL)) {
  console.log(`\n=== Couche nationale : ${natLabel} ===`);
  console.log(`  bras                        RMSE   ${MAIN.map((p) => p.padStart(5)).join(" ")}  gagn.    err  sièges`);
  for (const [label, layers] of ARMS) {
    const out = computeProjection(data, { asOf: GOLDEN_AS_OF, cache: FIT_CACHE, layers, nationalPoint: national, pointOnly: true });
    const fc = Object.fromEntries(Object.entries(out.ridingForecast).map(([c, e]) => [c, e.shares]));
    console.log(`  ${label.padEnd(26)} ${fmt(score(fc))}`);
  }
  console.log(`  ${"ORACLE régional 3 rég.".padEnd(26)} ${fmt(score(oracle(region3, national)))}`);
  console.log(`  ${"ORACLE régional 4 rég.".padEnd(26)} ${fmt(score(oracle(region4, national)))}`);
}

// --- le signal régional des sondages contre le réel ----------------------------
// Ajustement appliqué par la production (déviation régionale courante moins
// celle déjà dans la baseline 2022), comparé au même objet calculé sur les
// résultats réels : traduit en parts régionales à vote provincial réel.
const prod = computeProjection(data, { asOf: GOLDEN_AS_OF, cache: FIT_CACHE, nationalPoint: NATIONAL.connu, pointOnly: true });
// regionAdj est exprimé dans la base ILR de la production (ordre de
// pivotPolls, AUTRES en dernier), pas dans l'ordre de la veille archivée.
const pc = prod.partyCodes;
console.log("\n=== Ajustement régional : sondages (veille) contre réel, en pp de part régionale ===");
const v26 = {}, v22 = {};
for (const r of rows2026) {
  const reg = region3.get(r.riding_code); if (!reg) continue;
  v26[reg] ??= Object.fromEntries(pc.map((p) => [p, 0]));
  v26[reg][pc.includes(r.party_code) ? r.party_code : "AUTRES"] += r.votes;
}
for (const r of data.baselineRows) {
  const reg = region3.get(String(Math.round(parseFloat(r.riding_code)))); if (!reg) continue;
  v22[reg] ??= Object.fromEntries(pc.map((p) => [p, 0]));
  v22[reg][pc.includes(r.party_code) ? r.party_code : "AUTRES"] += r.votes;
}
const sh = (v) => { const t = pc.reduce((s, p) => s + v[p], 0); return pc.map((p) => v[p] / t); };
const prov22 = pc.map((p) => prov2022[p]);
const prov26 = pc.map((p) => NATIONAL.connu[p]);
for (const reg of ["MTL", "QC", "REG"]) {
  const [i22, i26, p22, p26] = ilrMatrix([sh(v22[reg]), sh(v26[reg]), prov22, prov26]);
  // Part régionale implicite = province réelle + déviation 2022 + ajustement.
  const implied = (adj) => ilrInv([p26.map((v, j) => v + (i22[j] - p22[j]) + adj[j])])[0];
  const adjTrue = i26.map((v, j) => v - p26[j] - (i22[j] - p22[j]));
  const fromPolls = implied(prod.regionAdj[reg]);
  const actual = implied(adjTrue);
  const uniform = implied(adjTrue.map(() => 0));
  const line = (vec) => MAIN.map((p) => (vec[pc.indexOf(p)] * 100).toFixed(1).padStart(5)).join(" ");
  console.log(`  ${reg.padEnd(4)} réel     ${line(actual)}`);
  console.log(`       sondages ${line(fromPolls)}`);
  console.log(`       uniforme ${line(uniform)}`);
}
console.log(`       (colonnes : ${MAIN.join(" ")})`);
