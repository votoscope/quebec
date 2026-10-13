/**
 * Régionalisation fine du swing : le sondage régional Léger (14 groupes de
 * régions administratives, n = 9 235 décidés, 12 juin - 24 août 2026)
 * contre le bloc régional de production (GP conjoint à 3 régions,
 * MTL/QC/REG) et le report pur, couche nationale fixée.
 *
 * Toute variante ajuste la baseline 2022 de chaque circonscription en ILR
 * puis applique le swing uniforme de production (uniformClrSwing) vers la
 * couche nationale. Ajustement d'un groupe g :
 *   adj_g = [ilr(g) - ilr(province)]_sondage - [ilr(g) - ilr(province)]_2022
 * et celui d'une circonscription est le mélange de ceux des groupes, pondéré
 * par la population (js/data/qc_riding_regions_fine.json).
 *
 * Les déviations régionales portent sur la SOUS-COMPOSITION des cinq
 * partis principaux (ILR à 4 coordonnées) : AUTRES n'est pas ventilé par
 * région dans les sondages, et sa part de chaque circonscription est tenue
 * fixe. L'ajustement de production (base à 6 parties) est converti en son
 * effet sur la sous-composition de chaque circonscription.
 *
 * Bras :
 *   - report pur ;
 *   - régional 3 rég. : ajustement de production à la veille (sondages de
 *     campagne, GP conjoint) ;
 *   - méga 14 brut / méga 14 rétréci : le sondage régional seul, sans ou avec
 *     rétrécissement bayésien empirique vers 0 ;
 *   - hiérarchique : niveau des 3 régions par les sondages de campagne (à la
 *     veille), structure INTRA-région par le sondage régional, rétrécie :
 *       adj_r = prod_{R(r)} + sum_g w_rg [cbar_g + lambda_g (adj_g - cbar_g)] - c_r
 *     où c_r est l'ajustement 3 régions mesuré par le même sondage régional
 *     (rangées MTL/QC/REG du 2026-08-24) et cbar_g sa moyenne sur le groupe ;
 *   - ORACLE 14 : ajustement réel 2026 par groupe (borne supérieure).
 *
 * Rétrécissement : lambda_g = tau2 / (tau2 + s2_g) par coordonnée ILR, s2_g
 * la variance d'échantillonnage (tirages de Dirichlet à n effectif =
 * n / (1 + variance des poids), plus l'arrondi à l'entier des parts), tau2
 * estimé par la méthode des moments sur les 14 groupes, borné à 0 : tau2 = 0
 * (aucune structure fine) est sur la grille et l'évidence peut le choisir.
 *
 * Métriques : RMSE des parts par circonscription (pp), MAE par parti,
 * gagnants corrects, erreur absolue de sièges.
 *
 * Limite : un seul sondage régional fin existe (2026) ; le test porte sur
 * une seule élection. Le sondage est antérieur au scrutin (aucune fuite de
 * données), mais la spécification est évaluée après le résultat.
 *
 * Run: node js/tools/regional_fine_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { computeProjection } from "../src/computeProjection.js";
import { pivotPolls } from "../src/compositional.js";
import { ridingBaselineFromRows, provinceShareFromRows, uniformClrSwing, normalizeRidingCode } from "../src/swing.js";
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
const fine = load("../data/qc_riding_regions_fine.json").ridings;
const mega = load("../data/qc_regional_megapoll_2026.json");
const { partyCodes: pc } = pivotPolls(data.pollRows); // base ILR de production
const MAIN = ["CAQ", "LIB", "PCQ", "PQ", "QS"];
const K = MAIN.length - 1;
const mainIdx = MAIN.map((p) => pc.indexOf(p));
const ai = pc.indexOf("AUTRES");
const sub = (v6) => { const m = mainIdx.map((i) => v6[i]); const t = m.reduce((a, b) => a + b, 0); return m.map((x) => x / t); };
const subIlr = (v6) => ilrMatrix([sub(v6)])[0];
// Applique un ajustement de sous-composition en gardant AUTRES fixe.
const applySub = (v6, a) => {
  const m = ilrInv([ilrMatrix([sub(v6)])[0].map((v, j) => v + a[j])])[0];
  const out = new Array(pc.length).fill(0);
  // Plancher sur AUTRES : une part exactement nulle déclenche le remplacement
  // des zéros de la bibliothèque, qui soustrait delta aux autres parts.
  out[ai] = Math.max(v6[ai], 1e-6);
  mainIdx.forEach((i, k) => { out[i] = m[k] * (1 - v6[ai]); });
  return out;
};
const GROUPS = Object.keys(mega.groups);

// --- vérité 2026 et couches nationales ---------------------------------------
const rows2026 = loadAllRows().filter((r) => r.election_date === "2026-10-05");
const partyOf = (p) => (pc.includes(p) ? p : "AUTRES");
const truth = new Map();
const provVotes = Object.fromEntries(pc.map((p) => [p, 0]));
for (const r of rows2026) {
  if (!truth.has(r.riding_code)) truth.set(r.riding_code, Object.fromEntries(pc.map((p) => [p, 0])));
  truth.get(r.riding_code)[partyOf(r.party_code)] += r.votes;
  provVotes[partyOf(r.party_code)] += r.votes;
}
for (const v of truth.values()) { const t = pc.reduce((s, p) => s + v[p], 0); for (const p of pc) v[p] /= t; }
const provTot = pc.reduce((s, p) => s + provVotes[p], 0);
const NATIONAL = {
  veille: Object.fromEntries(pc.map((p) => [p, published.disproportion.voteShare[p] / 100])),
  connu: Object.fromEntries(pc.map((p) => [p, provVotes[p] / provTot])),
};
const winnerOf = (sh) => MAIN.reduce((b, p) => ((sh[p] ?? 0) > (sh[b] ?? 0) ? p : b), MAIN[0]);
const actualSeats = Object.fromEntries(MAIN.map((p) => [p, 0]));
for (const sh of truth.values()) actualSeats[winnerOf(sh)]++;

function score(forecast) {
  let se = 0, n = 0, correct = 0, nr = 0;
  const mae = Object.fromEntries(MAIN.map((p) => [p, 0]));
  const seats = Object.fromEntries(MAIN.map((p) => [p, 0]));
  for (const [code, fc] of Object.entries(forecast)) {
    const t = truth.get(String(code));
    if (!t) continue;
    nr++;
    for (const p of MAIN) { const d = ((fc[p] ?? 0) - t[p]) * 100; se += d * d; n++; mae[p] += Math.abs(d); }
    const w = winnerOf(fc); seats[w]++; if (w === winnerOf(t)) correct++;
  }
  for (const p of MAIN) mae[p] /= nr;
  return { rmse: Math.sqrt(se / n), mae, correct, nr, seatErr: MAIN.reduce((s, p) => s + Math.abs(seats[p] - actualSeats[p]), 0), seats };
}
const fmt = (r) =>
  `${r.rmse.toFixed(2).padStart(6)}  ${MAIN.map((p) => r.mae[p].toFixed(2).padStart(5)).join(" ")}  ` +
  `${String(r.correct).padStart(3)}/${r.nr}  ${String(r.seatErr).padStart(3)}  ${JSON.stringify(r.seats)}`;

// --- baseline 2022 et parts de groupes -------------------------------------------
const baselineMap = ridingBaselineFromRows(data.baselineRows, pc);
const prov2022 = provinceShareFromRows(data.baselineRows, pc);
const p22 = subIlr(pc.map((p) => prov2022[p]));
const region3 = new Map(data.ridingRegions.map((r) => [String(r.riding_code), r.region_code]));

function groupShares(rows, keyOf, weightsOf) {
  const acc = {};
  for (const r of rows) {
    const w = weightsOf(keyOf(r));
    if (!w) continue;
    for (const [g, x] of Object.entries(w)) {
      acc[g] ??= Object.fromEntries(pc.map((p) => [p, 0]));
      acc[g][partyOf(r.party_code)] += x * r.votes;
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([g, v]) => {
    const t = pc.reduce((s, p) => s + v[p], 0);
    return [g, pc.map((p) => v[p] / t)];
  }));
}
const fineOf = (code) => fine[code]?.ra ?? null;
const coarseOf = (code) => (region3.get(code) ? { [region3.get(code)]: 1 } : null);
const key22 = (r) => normalizeRidingCode(r.riding_code);
const key26 = (r) => String(r.riding_code);
const ilrOf = (v) => ilrMatrix([v])[0];
const dev = (shares, provIlr) => subIlr(shares).map((v, j) => v - provIlr[j]);

const D22 = Object.fromEntries(Object.entries(groupShares(data.baselineRows, key22, fineOf)).map(([g, s]) => [g, dev(s, p22)]));
const D22c = Object.fromEntries(Object.entries(groupShares(data.baselineRows, key22, coarseOf)).map(([g, s]) => [g, dev(s, p22)]));
const p26 = subIlr(pc.map((p) => NATIONAL.connu[p]));
const D26 = Object.fromEntries(Object.entries(groupShares(rows2026, key26, fineOf)).map(([g, s]) => [g, dev(s, p26)]));

// --- sondage régional : déviations et variances d'échantillonnage ---------------
const closeShares = (obj) => {
  const v = pc.map((p) => obj[p] ?? 0);
  const main = v.reduce((s, x, i) => s + (pc[i] === "AUTRES" ? 0 : x), 0);
  const ai = pc.indexOf("AUTRES");
  if (!obj.AUTRES) v[ai] = Math.max(0.5, 100 - main);
  const t = v.reduce((a, b) => a + b, 0);
  return v.map((x) => x / t);
};
const megaProv = closeShares(mega.province);
const mProvIlr = subIlr(megaProv);
const deff = 1 + mega.weightVariance;

function mulberry32(seed) {
  return () => { let t = (seed += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rng = mulberry32(7);
const randn = () => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
function randGamma(a) { // Marsaglia-Tsang, a >= 1 après boost
  if (a < 1) return randGamma(a + 1) * Math.pow(rng(), 1 / a);
  const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = randn(); v = 1 + c * x; } while (v <= 0); v = v ** 3; const u = rng(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
}
function samplingVar(shares, n) {
  const nEff = n / deff, B = 2000;
  const draws = [];
  for (let b = 0; b < B; b++) {
    const g = shares.map((s) => randGamma(Math.max(s * nEff, 0.5)));
    const t = g.reduce((a, x) => a + x, 0);
    // Arrondi à l'entier des parts publiées : U(-0,5 ; 0,5) pp.
    const r = g.map((x) => Math.max(1e-4, x / t + (rng() - 0.5) / 100));
    draws.push(subIlr(r));
  }
  return Array.from({ length: K }, (_, j) => {
    const m = draws.reduce((s, d) => s + d[j], 0) / B;
    return draws.reduce((s, d) => s + (d[j] - m) ** 2, 0) / (B - 1);
  });
}

const M = {}, S2 = {}, ADJ = {};
for (const g of GROUPS) {
  const sh = closeShares(mega.groups[g].shares);
  M[g] = dev(sh, mProvIlr);
  S2[g] = samplingVar(sh, mega.groups[g].n);
  ADJ[g] = M[g].map((v, j) => v - D22[g][j]);
}
// Rangées 3 régions du même sondage (qc_regional_polls, 2026-08-24).
const megaCoarseRows = data.regionalPollRows.filter((r) => r.poll_date === "2026-08-24" && r.firm === "Léger");
const MC = {};
for (const reg of ["MTL", "QC", "REG"]) {
  const obj = Object.fromEntries(megaCoarseRows.filter((r) => r.region_code === reg).map((r) => [r.party_code, r.pct_reported]));
  MC[reg] = dev(closeShares(obj), mProvIlr).map((v, j) => v - D22c[reg][j]);
}

// Rétrécissement bayésien empirique par coordonnée, vers une cible.
function shrink(adjByGroup, targetByGroup) {
  const tau2 = Array.from({ length: K }, (_, j) => {
    const ms = GROUPS.reduce((s, g) => s + (adjByGroup[g][j] - targetByGroup[g][j]) ** 2, 0) / GROUPS.length;
    const mv = GROUPS.reduce((s, g) => s + S2[g][j], 0) / GROUPS.length;
    return Math.max(0, ms - mv);
  });
  const out = {};
  for (const g of GROUPS) out[g] = adjByGroup[g].map((v, j) => targetByGroup[g][j] + (tau2[j] / (tau2[j] + S2[g][j])) * (v - targetByGroup[g][j]));
  return { out, tau2 };
}

// --- ajustement de production à la veille (3 régions) ----------------------------
const prod = computeProjection(data, {
  asOf: GOLDEN_AS_OF, pointOnly: true, nationalPoint: NATIONAL.connu,
  layers: { openSeat: false, leaders: false, regional: true, effects: false, byelections: false },
});
const PROD = prod.regionAdj;
if (prod.partyCodes.join() !== pc.join()) throw new Error("base ILR différente de celle de la production");

// --- construction des ajustements par circonscription ----------------------------
const codes = [...baselineMap.keys()].map(String);
// Effet de l'ajustement de production (base à 6 parties) sur la
// sous-composition de chaque circonscription.
const prodSub = new Map();
for (const [code, sh] of baselineMap) {
  const a6 = PROD[region3.get(String(code))];
  if (!a6) continue;
  const shifted = ilrInv([ilrOf(sh).map((v, j) => v + a6[j])])[0];
  prodSub.set(String(code), subIlr(shifted).map((v, j) => v - subIlr(sh)[j]));
}
const mix = (code, byGroup) => {
  const w = fine[code]?.ra; if (!w) return new Array(K).fill(0);
  const out = new Array(K).fill(0);
  for (const [g, x] of Object.entries(w)) if (byGroup[g]) byGroup[g].forEach((v, j) => { out[j] += x * v; });
  return out;
};
const zero = () => new Array(K).fill(0);
const ZERO = Object.fromEntries(GROUPS.map((g) => [g, zero()]));

// cbar_g : ajustement 3 régions (sondage régional) moyen sur les circonscriptions du groupe.
const cbar = {};
for (const g of GROUPS) {
  const acc = zero(); let W = 0;
  for (const code of codes) {
    const x = fine[code]?.ra?.[g]; const reg = region3.get(code);
    if (!x || !reg) continue;
    MC[reg].forEach((v, j) => { acc[j] += x * (fine[code].population) * v; });
    W += x * fine[code].population;
  }
  cbar[g] = acc.map((v) => v / W);
}
const shrunk0 = shrink(ADJ, ZERO);
const shrunkC = shrink(ADJ, cbar);
const ORACLE = Object.fromEntries(GROUPS.map((g) => [g, D26[g].map((v, j) => v - D22[g][j])]));

const ARMS = {
  "report pur": () => zero(),
  "régional 3 rég. (prod)": (c) => prodSub.get(c) ?? zero(),
  "méga 14 brut": (c) => mix(c, ADJ),
  "méga 14 rétréci": (c) => mix(c, shrunk0.out),
  "hiérarchique": (c) => {
    const reg = region3.get(c); if (!reg) return zero();
    const f = mix(c, shrunkC.out);
    return (prodSub.get(c) ?? zero()).map((v, j) => v + f[j] - MC[reg][j]);
  },
  "hiérarchique brut": (c) => {
    const reg = region3.get(c); if (!reg) return zero();
    const f = mix(c, ADJ);
    return (prodSub.get(c) ?? zero()).map((v, j) => v + f[j] - MC[reg][j]);
  },
  "ORACLE 14": (c) => mix(c, ORACLE),
};

function forecastWith(adjOf, national) {
  const shifted = new Map();
  for (const [code, sh] of baselineMap) {
    const a = adjOf(String(code));
    shifted.set(code, applySub(sh, a));
  }
  const fc = uniformClrSwing(shifted, prov2022, national, pc);
  return Object.fromEntries([...fc].map(([c, e]) => [c, e.shares]));
}

console.log(`tau2 (vers 0)            : [${shrunk0.tau2.map((v) => v.toFixed(4)).join(", ")}]`);
console.log(`tau2 (intra-région)      : [${shrunkC.tau2.map((v) => v.toFixed(4)).join(", ")}]`);
console.log(`s2 médian                : [${Array.from({ length: K }, (_, j) => GROUPS.map((g) => S2[g][j]).sort((a, b) => a - b)[7].toFixed(4)).join(", ")}]`);
for (const [natLabel, national] of Object.entries(NATIONAL)) {
  console.log(`\n=== Couche nationale : ${natLabel} ===`);
  console.log(`  bras                        RMSE   ${MAIN.map((p) => p.padStart(5)).join(" ")}  gagn.    err  sièges`);
  for (const [label, adjOf] of Object.entries(ARMS)) console.log(`  ${label.padEnd(26)} ${fmt(score(forecastWith(adjOf, national)))}`);
}

// Parts régionales : sondage régional vs réel, par groupe (pp, vote connu).
console.log("\n=== Déviation régionale 2026 (pp de part, à province réelle) : sondage régional / réel ===");
console.log(`  groupe    ${MAIN.map((p) => p.padStart(11)).join("")}`);
for (const g of GROUPS) {
  const toSh = (d) => ilrInv([p26.map((v, j) => v + d[j])])[0];
  const s = toSh(M[g]), t = toSh(D26[g]); // ordre MAIN
  console.log(`  ${g.padEnd(8)} ${MAIN.map((p, k) => { return `${(s[k] * 100).toFixed(0).padStart(4)}/${(t[k] * 100).toFixed(0).padEnd(4)}  `; }).join("")}`);
}
