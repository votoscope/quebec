/**
 * Protocole commun d'évaluation de la couche par circonscription, à vote
 * provincial connu, sur les transitions générales 2014->2018, 2018->2022 et
 * 2022->2026 : chaque transition est prédite par un modèle ajusté sur les
 * deux autres.
 *
 * Modèle de référence (production) : y = a + s + kappa * L + e, où a est la
 * composition précédente (ILR, base de production), L le swing par langue
 * maternelle mesuré dans les ventilations Léger, s le swing provincial résolu
 * pour que l'agrégat pondéré par les votes égale le vote réel, e tiré du
 * bassin des erreurs du modèle sur les transitions d'entraînement.
 *
 * Un candidat ajoute une déviation f(x) apprise : y = a + s + kappa L + f(x) + e.
 * Son bassin d'erreurs est HORS ÉCHANTILLON : sur les deux transitions
 * d'entraînement, f ajusté sur l'une prédit l'autre.
 *
 * Mesures : log-score et Brier des probabilités de victoire, RMSE des parts
 * (pp, 5 partis), gagnants corrects, erreur absolue de sièges (point =
 * gagnants de la moyenne a posteriori ; médoïde), PIT des sièges.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { pivotPolls } from "../../src/compositional.js";
import { ilrMatrix } from "../../src/ridingEffects.js";
import { languageAdjustments, applyLanguageAdjustment } from "../../src/languageSwing.js";
import { medoidDraw } from "../../src/simulate.js";
import { loadFixtures } from "../../test/golden_lib.mjs";
import { fitTrend, predictTrend, sampleTrendDraws } from "../../src/gpTrend.js";
import { loadAllRows, electionState } from "./harness.mjs";

const { ilrInv } = mva.composition;
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const data = loadFixtures(new URL("../../test/fixtures/", import.meta.url));
export const pc = pivotPolls(data.pollRows).partyCodes; // base ILR de production
export const K = pc.length - 1;
export const MAIN = ["CAQ", "LIB", "PCQ", "PQ", "QS"];
const rows = loadAllRows();
const crosstabs = load("../../data/qc_leger_crosstabs.json");
const comp = load("../../data/qc_riding_language_age.json");
const incumbency = existsSync(new URL("../../data/qc_incumbency.json", import.meta.url)) ? load("../../data/qc_incumbency.json") : {};
const feat = { 2017: load("../../data/qc_riding_features_2017.json"), 2026: load("../../data/qc_riding_features_2026.json") };

// --- régions (RMR de Montréal / de Québec / reste), deux cartes, en cache ------
const REGION_FILE = new URL("../../data/qc_riding_region3_maps.json", import.meta.url);
export async function regionMaps() {
  if (existsSync(REGION_FILE)) return JSON.parse(readFileSync(REGION_FILE, "utf-8"));
  const { disseminationAreas } = await import("./geo.mjs");
  const daRiding = load("../../data/qc_da_riding.json");
  const popBy = { 2017: {}, 2026: {} };
  for await (const { props } of disseminationAreas()) {
    const id = String(props.ADIDU ?? "").trim(), pop = Number(props.Population) || 0;
    if (!pop) continue;
    const rmr = String(props.RMRIDU ?? "").trim();
    const reg = rmr === "462" ? "MTL" : rmr === "421" ? "QC" : "REG";
    for (const map of ["2017", "2026"]) {
      const r = daRiding[map][id]; if (!r) continue;
      (popBy[map][r] ??= { MTL: 0, QC: 0, REG: 0 })[reg] += pop;
    }
  }
  const out = Object.fromEntries(Object.entries(popBy).map(([m, o]) => [m, Object.fromEntries(Object.entries(o).map(([r, v]) => [r, Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]]))]));
  writeFileSync(REGION_FILE, JSON.stringify(out));
  return out;
}

// --- caractéristiques d'une circonscription (carte cible) ----------------------
const ilrOf = (v) => (v.length > 1 ? ilrMatrix([v.map((x) => Math.max(x, 1e-6))])[0] : []);
function profile(map, key) {
  const f = map === "2026" ? feat[2026].find((x) => String(x.riding_code) === key) : feat[2017].find((x) => x.riding_name === key);
  if (!f) return null;
  return [
    ...ilrOf(f.language), ...ilrOf(f.education), ...ilrOf(f.immigration), ...ilrOf(f.industry),
    Math.log(f.median_age), Math.log(f.median_household_income), Math.log(f.population_density + 1),
  ];
}
export const PROFILE_NAMES = ["lang1", "lang2", "lang3", "educ1", "educ2", "immi1", "ind1", "ind2", "ind3", "ind4", "ind5", "logAge", "logRevenu", "logDensite"];

export const TRANSITIONS = [
  { id: "T1", y0: "2014", y1: "2018", base: ["2014-04-07", "2011"], target: ["2018-10-01", "2017"], map: "2017" },
  { id: "T2", y0: "2018", y1: "2022", base: ["2018-10-01", "2017"], target: ["2022-10-03", "2017"], map: "2017" },
  { id: "T3", y0: "2022", y1: "2026", base: ["2022-10-03", "2026"], target: ["2026-10-05", "2026"], map: "2026" },
];

function votesBy(date, boundary) {
  const out = new Map(), prov = Object.fromEntries(pc.map((p) => [p, 0]));
  for (const r of rows) {
    if (r.election_date !== date || String(r.boundary_year) !== boundary) continue;
    const p = pc.includes(r.party_code) ? r.party_code : "AUTRES";
    out.set(String(r.riding_code), (out.get(String(r.riding_code)) ?? 0) + r.votes);
    prov[p] += r.votes;
  }
  const tot = pc.reduce((s, p) => s + prov[p], 0);
  return { total: out, prov: pc.map((p) => prov[p] / tot) };
}

// Swing d'un ensemble de groupes mesuré dans les ventilations Léger (deux
// dernières vagues de chaque veille, moyenne pondérée), en CLR des cinq
// partis, mélangé selon l'appartenance de chaque circonscription et centré.
const GP = ["CAQ", "LIB", "PCQ", "PQ", "QS"];
const clr5 = (v) => { const l = v.map((x) => Math.log(Math.max(x, 1e-4))); const m = l.reduce((a, b) => a + b, 0) / l.length; return l.map((x) => x - m); };
function pooledGroup(waves, g) {
  const acc = Object.fromEntries(GP.map((p) => [p, 0])); let N = 0;
  for (const w of waves) { const x = w.groups[g]; if (!x) continue; for (const p of GP) acc[p] += x.n * (x.shares[p] ?? 0); N += x.n; }
  if (!N) return null;
  const v = GP.map((p) => Math.max(acc[p] / N, 0.5)); const t = v.reduce((a, b) => a + b, 0);
  return v.map((x) => x / t);
}
export function groupShiftILR(obs, y0, y1, groups) {
  const prev = crosstabs[y0].waves.slice(-2), curr = crosstabs[y1].waves.slice(-2);
  const D = groups.map(([g]) => { const a = pooledGroup(prev, g), b = pooledGroup(curr, g); return a && b ? clr5(b).map((v, j) => v - clr5(a)[j]) : null; });
  if (D.some((d) => !d)) return obs.map(() => new Array(K).fill(0));
  const mean = groups.map(([, f]) => obs.reduce((s, o) => s + f(o), 0) / obs.length);
  const Dbar = GP.map((_, j) => D.reduce((s, d, i) => s + mean[i] * d[j], 0));
  return obs.map((o) => {
    const adj = GP.map((_, j) => groups.reduce((s, [, f], i) => s + f(o) * (D[i][j] - Dbar[j]), 0));
    return ilrMatrix([applyLanguageAdjustment(o.prevShares, pc, adj)])[0].map((v, j) => v - o.a[j]);
  });
}

/**
 * Ajustement régional de production : écart région-province mesuré
 * dans les sondages de veille (Léger, deux dernières vagues, colonnes
 * régionales contre total) moins l'écart région-province dans les résultats
 * de l'élection précédente (CLR des cinq partis).
 */
let breakdowns = existsSync(new URL("../../../data/prive/qc_poll_breakdowns.json", import.meta.url)) ? load("../../../data/prive/qc_poll_breakdowns.json") : {};
/** Remplace les ventilations de veille (même format que qc_poll_breakdowns.json). */
export function setBreakdowns(b) { breakdowns = b; }
export let REGION_SOURCE = "toutes";
export function setRegionSource(v) { REGION_SOURCE = v; }
export function regionalPollAdj(obs, y1) {
  // Source : ventilations toutes firmes de fin de campagne (../data/prive/qc_poll_breakdowns.json, hors dépôt) quand
  // elles existent, sinon colonnes régionales de Léger.
  const all = breakdowns[y1]?.groups;
  const curr = REGION_SOURCE === "toutes" && all?.rMTL ? [{ groups: all }] : crosstabs[y1].waves.slice(-2);
  const tot = pooledGroup(curr, "total"); if (!tot) return obs.map(() => new Array(K).fill(0));
  const W = obs.reduce((s, o) => s + o.w, 0);
  const prov = GP.map((p) => obs.reduce((s, o) => s + (o.w * o.prevShares[pc.indexOf(p)]) / W, 0));
  const out = {};
  for (const [g, key] of [["MTL", "rMTL"], ["QC", "rQC"], ["REG", "rREG"]]) {
    const pollG = pooledGroup(curr, key); if (!pollG) return obs.map(() => new Array(K).fill(0));
    const os = obs.filter((o) => o.g === g); const Wg = os.reduce((s, o) => s + o.w, 0);
    const resG = GP.map((p) => os.reduce((s, o) => s + (o.w * o.prevShares[pc.indexOf(p)]) / Wg, 0));
    const devPoll = clr5(pollG).map((v, j) => v - clr5(tot)[j]);
    const devPrev = clr5(resG).map((v, j) => v - clr5(prov)[j]);
    out[g] = devPoll.map((v, j) => v - devPrev[j]);
  }
  return obs.map((o) => ilrMatrix([applyLanguageAdjustment(o.prevShares, pc, out[o.g])])[0].map((v, j) => v - o.a[j]));
}

/** Observations de chaque transition. */
export async function buildData() {
  const regions = await regionMaps();
  return TRANSITIONS.map((t) => {
    const base = electionState(rows, ...t.base, pc), tgt = electionState(rows, ...t.target, pc);
    const lang = languageAdjustments(crosstabs, comp[t.map], { previousYear: t.y0, currentYear: t.y1, asOf: t.target[0], kappa: 1 });
    const vb = votesBy(...t.base), vt = votesBy(...t.target);
    const provIlr0 = ilrMatrix([vb.prov])[0], provIlr1 = ilrMatrix([vt.prov])[0];
    const sProv = provIlr1.map((v, j) => v - provIlr0[j]); // swing provincial (ILR)
    const obs = [];
    for (const key of base.keys) {
      const k = String(key);
      if (!tgt.ilr.has(key) || !comp[t.map][k] || !regions[t.map][k]) continue;
      const prof = profile(t.map, k); if (!prof) continue;
      const a = base.ilr.get(key);
      const prevShares = ilrInv([a])[0];
      const adj = lang.adj.get(k);
      const L = adj ? ilrMatrix([applyLanguageAdjustment(prevShares, pc, adj)])[0].map((v, j) => v - a[j]) : new Array(K).fill(0);
      const c = comp[t.map][k];
      obs.push({
        key: k, a, y: tgt.ilr.get(key), yShares: ilrInv([tgt.ilr.get(key)])[0], L, g: regions[t.map][k],
        w: vb.total.get(k) ?? 1, prof, franco: c.franco, age: [c.a18_34, c.a35_54, c.a55p], prevShares,
        inc: incumbency[t.id] ? (incumbency[t.id][k] ?? null) : undefined,
      });
    }
    const meanA = Array.from({ length: K }, (_, j) => obs.reduce((s, o) => s + o.a[j], 0) / obs.length);
    for (const o of obs) o.level = o.a.map((v, j) => v - meanA[j]);
    const R = groupShiftILR(obs, t.y0, t.y1, [["rMTL", (o) => (o.g === "MTL" ? 1 : 0)], ["rQC", (o) => (o.g === "QC" ? 1 : 0)], ["rREG", (o) => (o.g === "REG" ? 1 : 0)]]);
    obs.forEach((o, i) => { o.R = R[i]; });
    const RP = regionalPollAdj(obs, t.y1);
    obs.forEach((o, i) => { o.RP = RP[i]; });
    return { ...t, obs, nationalTarget: vt.prov, sProv };
  });
}

// --- swing résolu sur le vote réel ------------------------------------------------
export function solveSwing(base, target) {
  const [tIlr] = ilrMatrix([target]);
  let s = new Array(K).fill(0);
  for (let it = 0; it < 40; it++) {
    const agg = new Array(K + 1).fill(0); let W = 0;
    for (const { v, w } of base) { const sh = ilrInv([v.map((x, j) => x + s[j])])[0]; sh.forEach((x, j) => { agg[j] += w * x; }); W += w; }
    const [aIlr] = ilrMatrix([agg.map((x) => x / W)]);
    const d = aIlr.map((x, j) => tIlr[j] - x);
    s = s.map((x, j) => x + d[j]);
    if (Math.max(...d.map(Math.abs)) < 1e-7) break;
  }
  return s;
}

function mulberry32(seed) { return () => { let t = (seed += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// --- forme du swing (Box-Cox) ---------------------------------------------------
const bc = (x, t) => (t === 0 ? Math.log(x) : (Math.pow(x, t) - 1) / t);
const bcInv = (y, t) => (t === 0 ? Math.exp(y) : Math.pow(Math.max(t * y + 1, 1e-12), 1 / t));
const boxCoxCache = new Map();
/**
 * Prévision (ILR) d'une transition au swing de Box-Cox tau (tau = 0 : swing
 * proportionnel, identique au déplacement ILR) à partir de la composition
 * précédente ajustée de la langue, à vote provincial réel.
 */
export function boxCoxMeans(T, kappa, tau) {
  const key = `${T.id}|${kappa}|${tau}`;
  if (boxCoxCache.has(key)) return boxCoxCache.get(key);
  const start = T.obs.map((o) => ilrInv([o.a.map((x, j) => x + kappa * o.L[j])])[0]);
  const P = start[0].length, W = T.obs.reduce((s, o) => s + o.w, 0);
  let c = new Array(P).fill(0), out = start;
  for (let it = 0; it < 300; it++) {
    out = start.map((x) => {
      const v = x.map((xi, j) => Math.max(bcInv(bc(Math.max(xi, 1e-6), tau) + c[j], tau), 1e-6));
      const s = v.reduce((a, b) => a + b, 0);
      return v.map((vi) => vi / s);
    });
    const agg = new Array(P).fill(0);
    out.forEach((x, i) => x.forEach((xi, j) => { agg[j] += (T.obs[i].w * xi) / W; }));
    c = c.map((cj, j) => cj + bc(Math.max(T.nationalTarget[j], 1e-6), tau) - bc(Math.max(agg[j], 1e-6), tau));
    if (Math.max(...agg.map((g, j) => Math.abs(g - T.nationalTarget[j]))) < 1e-8) break;
  }
  const m = ilrMatrix(out);
  boxCoxCache.set(key, m);
  return m;
}

/** Moyennes (ILR, avant swing) d'une transition sous kappa, tau et une déviation f. */
let TAU = 0;
// kappa : nombre (langue seule) ou { L, R } (langue + sondages régionaux de veille).
const kL = (k) => (typeof k === "number" ? k : k.L);
const kR = (k) => (typeof k === "number" ? 0 : k.R);
const meansOf = (T, kappa, dev) => {
  const base = TAU === 0 ? T.obs.map((o) => o.a.map((x, j) => x + kL(kappa) * o.L[j] + kR(kappa) * (o.RP?.[j] ?? 0))) : boxCoxMeans(T, kL(kappa), TAU);
  return base.map((v, i) => v.map((x, j) => x + (dev ? dev[i][j] : 0)));
};

/** Met à l'échelle une erreur ILR partie par partie, en CLR (s : une valeur par partie de pc). */
export function scaleResidual(e, s) {
  const comp = ilrInv([e])[0];
  const l = comp.map((x) => Math.log(x)); const m = l.reduce((a, b) => a + b, 0) / l.length;
  const z = l.map((x, j) => (x - m) * s[j]); const mz = z.reduce((a, b) => a + b, 0) / z.length;
  const back = z.map((x) => Math.exp(x - mz)); const t = back.reduce((a, b) => a + b, 0);
  return ilrMatrix([back.map((x) => x / t)])[0];
}

/** Erreurs centrées (ILR) d'un jeu de moyennes contre la vérité d'une transition. */
export function residualsOf(T, means) {
  const s = solveSwing(means.map((v, i) => ({ v, w: T.obs[i].w })), T.nationalTarget);
  const r = T.obs.map((o, i) => o.y.map((x, j) => x - means[i][j] - s[j]));
  const m = Array.from({ length: K }, (_, j) => r.reduce((a, x) => a + x[j], 0) / r.length);
  return r.map((x) => x.map((v, j) => v - m[j]));
}

/** kappa par moindres carrés des parts sur une grille, transitions données. */
export function fitKappa(train, GRID = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2], withRegion = false) {
  if (withRegion) {
    const sseK = (k) => train.reduce((acc, T) => {
      const means = meansOf(T, k, null);
      const s = solveSwing(means.map((v, i) => ({ v, w: T.obs[i].w })), T.nationalTarget);
      return acc + T.obs.reduce((a2, o, i) => { const sh = ilrInv([means[i].map((x, j) => x + s[j])])[0]; return a2 + MAIN.reduce((a3, p) => a3 + (sh[pc.indexOf(p)] - o.yShares[pc.indexOf(p)]) ** 2, 0); }, 0);
    }, 0);
    let best = null;
    for (const L of [0, 0.5, 1, 1.5]) for (const R of [0, 0.5, 1, 1.5]) { const e = sseK({ L, R }); if (!best || e < best.e) best = { L, R, e }; }
    return { L: best.L, R: best.R };
  }
  const sse = (kap) => train.reduce((acc, T) => {
    const means = meansOf(T, kap, null);
    const s = solveSwing(means.map((v, i) => ({ v, w: T.obs[i].w })), T.nationalTarget);
    return acc + T.obs.reduce((a2, o, i) => { const sh = ilrInv([means[i].map((x, j) => x + s[j])])[0]; return a2 + MAIN.reduce((a3, p) => a3 + (sh[pc.indexOf(p)] - o.yShares[pc.indexOf(p)]) ** 2, 0); }, 0);
  }, 0);
  return GRID.reduce((b, k) => (sse(k) < sse(b) ? k : b), 0);
}

/**
 * Tirages de parts : moyennes + erreur tirée du bassin + swing résolu.
 * pool : vecteurs d'erreur, ou { residuals, regions } pour le choc régional :
 * les erreurs sont alors nettes de leur moyenne régionale (par transition)
 * et un choc commun par région, d'écart-type estimé sur ces moyennes, est
 * ajouté à chaque tirage.
 */
export function drawShares(T, means, pool, { nDraws = 1000, seed = 3, targets = null } = {}) {
  const rng = mulberry32(seed);
  const randn = () => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
  const regional = !Array.isArray(pool);
  const vecs = regional ? pool.residuals : pool;
  const sigmaR = regional ? pool.sigmaRegion : null;
  const out = [];
  for (let d = 0; d < nDraws; d++) {
    const shock = regional ? Object.fromEntries(["MTL", "QC", "REG"].map((g) => [g, sigmaR.map((sd) => sd * randn())])) : null;
    const base = means.map((v, i) => {
      const e = vecs[Math.floor(rng() * vecs.length)];
      const sh = shock ? shock[T.obs[i].g] : null;
      return { v: v.map((x, j) => x + e[j] + (sh ? sh[j] : 0)), w: T.obs[i].w };
    });
    const s = solveSwing(base, targets ? targets[d % targets.length] : T.nationalTarget);
    out.push(base.map(({ v }) => ilrInv([v.map((x, j) => x + s[j])])[0]));
  }
  return out;
}

// --- couche nationale de veille (hors échantillon) ------------------------------
const systemic = load("../../data/qc_systemic.json");
const eveCache = new Map();
/**
 * Couche nationale à la veille d'une transition : tendance GP de production
 * ajustée sur les seuls sondages antérieurs au scrutin ; tirages a posteriori
 * plus choc systémique isotrope en ILR (écart-type calibré sur les finales
 * de 2018 et 2022 : fuite mineure pour ces deux plis).
 */
export function nationalEve(T, { nDraws = 4000, seed = 9, sigmaScale = 1 } = {}) {
  const key = `${T.id}|${nDraws}|${seed}|${sigmaScale}`;
  if (eveCache.has(key)) return eveCache.get(key);
  const date = T.target[0];
  const rowsBefore = data.pollRows.filter((r) => r.poll_date < date);
  const { polls, partyCodes } = pivotPolls(rowsBefore);
  const model = fitTrend(polls, partyCodes);
  const toPc = (o) => { const v = pc.map((p) => Math.max(o[p] ?? 0, 1e-4)); const t = v.reduce((a, b) => a + b, 0); return v.map((x) => x / t); };
  const pt = predictTrend(model, date, { seed: 42 });
  const point = toPc(Object.fromEntries(partyCodes.map((p) => [p, pt[p].mean])));
  const rng = mulberry32(seed);
  const randn = () => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
  const sd = systemic.sigma_industry * sigmaScale;
  const draws = sampleTrendDraws(model, date, nDraws, seed).map((d) => {
    const [x] = ilrMatrix([toPc(d)]);
    return ilrInv([x.map((v) => v + sd * randn())])[0];
  });
  const out = { point, draws, nPolls: polls.length };
  eveCache.set(key, out);
  return out;
}

export function evaluateDraws(T, draws, { pointTarget = null, means = null } = {}) {
  const nD = draws.length;
  const seatsDraws = [], winCount = T.obs.map(() => Object.fromEntries(MAIN.map((p) => [p, 0])));
  const meanSh = T.obs.map(() => new Array(K + 1).fill(0));
  for (const ds of draws) {
    const seats = Object.fromEntries(pc.map((p) => [p, 0]));
    T.obs.forEach((o, i) => {
      const sh = ds[i]; sh.forEach((x, j) => { meanSh[i][j] += x / nD; });
      const w = MAIN.reduce((b, p) => (sh[pc.indexOf(p)] > sh[pc.indexOf(b)] ? p : b), MAIN[0]);
      seats[w]++; winCount[i][w]++;
    });
    seatsDraws.push(seats);
  }
  const actual = Object.fromEntries(pc.map((p) => [p, 0]));
  const pointSeats = Object.fromEntries(pc.map((p) => [p, 0]));
  let ls = 0, br = 0, se = 0, n = 0, correct = 0;
  T.obs.forEach((o, i) => {
    const t = o.yShares;
    const win = MAIN.reduce((b, p) => (t[pc.indexOf(p)] > t[pc.indexOf(b)] ? p : b), MAIN[0]);
    actual[win]++;
    ls += -Math.log(Math.max(winCount[i][win] / nD, 1 / nD));
    for (const p of MAIN) br += (winCount[i][p] / nD - (p === win ? 1 : 0)) ** 2;
    for (const p of MAIN) { const j = pc.indexOf(p); se += ((meanSh[i][j] - t[j]) * 100) ** 2; n++; }
    const pw = MAIN.reduce((b, p) => (meanSh[i][pc.indexOf(p)] > meanSh[i][pc.indexOf(b)] ? p : b), MAIN[0]);
    pointSeats[pw]++; if (pw === win) correct++;
  });
  if (pointTarget && means) {
    // Point de veille : moyennes déterministes au point national de la tendance.
    const sP = solveSwing(means.map((v, i) => ({ v, w: T.obs[i].w })), pointTarget);
    for (const p of pc) pointSeats[p] = 0;
    let se2 = 0, c2 = 0;
    T.obs.forEach((o, i) => {
      const sh = ilrInv([means[i].map((x, j) => x + sP[j])])[0];
      const pw = MAIN.reduce((b, p) => (sh[pc.indexOf(p)] > sh[pc.indexOf(b)] ? p : b), MAIN[0]);
      pointSeats[pw]++;
      const t = o.yShares; const win = MAIN.reduce((b, p) => (t[pc.indexOf(p)] > t[pc.indexOf(b)] ? p : b), MAIN[0]);
      if (pw === win) c2++;
      for (const p of MAIN) { const j = pc.indexOf(p); se2 += ((sh[j] - t[j]) * 100) ** 2; }
    });
    correct = c2; se = se2;
  }
  const err = (o) => MAIN.reduce((s, p) => s + Math.abs((o[p] ?? 0) - actual[p]), 0);
  // Espérance des sièges (somme des probabilités de victoire), arrondie au
  // plus fort reste pour totaliser le nombre de circonscriptions.
  const expect = Object.fromEntries(MAIN.map((p) => [p, T.obs.reduce((s, o, i) => s + winCount[i][p] / nD, 0)]));
  const floorS = Object.fromEntries(MAIN.map((p) => [p, Math.floor(expect[p])]));
  let left = T.obs.length - MAIN.reduce((s, p) => s + floorS[p], 0);
  for (const p of [...MAIN].sort((x, y) => (expect[y] - floorS[y]) - (expect[x] - floorS[x]))) { if (left <= 0) break; floorS[p]++; left--; }
  const pit = MAIN.map((p) => { let b = 0, e = 0; for (const d of seatsDraws) { if (d[p] < actual[p]) b++; else if (d[p] === actual[p]) e++; } return (b + e / 2) / nD; });
  return {
    pit,
    expected: err(floorS),
    logScore: ls / T.obs.length, brier: br / T.obs.length, rmse: Math.sqrt(se / n), correct, n: T.obs.length,
    point: err(pointSeats), medoid: err(medoidDraw(seatsDraws, pc)),
  };
}

/**
 * Évalue un candidat sur les trois plis.
 * candidate(train, T, ctx) -> déviation f (tableau N x K, ILR) pour les
 * observations de T ; null = aucune déviation (référence).
 * ctx.kappa : kappa ajusté sur train ; ctx.target(train, kappa) : cible
 * d'apprentissage (résidus de la référence sur train).
 */
export async function crossValidate(DATA, candidate, { label = "candidat", nDraws = 4000, shrink = true, tau = 0, seed = 3, regionalShock = false, calibrateScale = false, national = "connu", fixedScale = null, sigmaScale = 1, regionPolls = false } = {}) {
  TAU = tau;
  const res = [];
  for (const [i, T] of DATA.entries()) {
    const train = DATA.filter((_, j) => j !== i);
    const kappa = fitKappa(train, undefined, regionPolls);
    let dev = await candidate(train, T, { kappa });
    // Prédictions hors échantillon sur train : chaque transition prédite par
    // l'autre. Elles fixent le facteur de rétrécissement lambda (moindres
    // carrés contre les résidus de la référence, borné à [0, 1] : 0 = la
    // référence) et le bassin d'erreurs.
    const inner = [];
    for (const [a, Ta] of train.entries()) {
      const devIn = dev === null ? null : await candidate([train[1 - a]], Ta, { kappa });
      inner.push({ Ta, devIn, ref: residualsOf(Ta, meansOf(Ta, kappa, null)) });
    }
    let lambda = dev === null ? 0 : 1;
    if (dev !== null && shrink) {
      let num = 0, den = 0;
      for (const { devIn, ref } of inner) devIn.forEach((f, i) => f.forEach((x, j) => { num += x * ref[i][j]; den += x * x; }));
      lambda = den > 0 ? Math.max(0, Math.min(1, num / den)) : 0;
      dev = dev.map((f) => f.map((x) => lambda * x));
    }
    const innerRes = inner.map(({ Ta, devIn }) => ({ Ta, r: residualsOf(Ta, meansOf(Ta, kappa, devIn ? devIn.map((f) => f.map((x) => lambda * x)) : null)) }));
    let pool = innerRes.flatMap(({ r }) => r);
    let scale = null;
    if (calibrateScale) {
      // Échelle par parti choisie hors échantillon : les erreurs d'une
      // transition d'entraînement prédisent l'autre ; log-score des gagnants.
      const P = K + 1, GRID = [0.5, 0.75, 1, 1.25, 1.5];
      const score = (sv) => innerRes.reduce((acc, { Ta }, a) => {
        const other = innerRes[1 - a].r.map((e) => scaleResidual(e, sv));
        const devA = inner[a].devIn ? inner[a].devIn.map((f) => f.map((x) => lambda * x)) : null;
        return acc + evaluateDraws(Ta, drawShares(Ta, meansOf(Ta, kappa, devA), other, { nDraws: 800, seed: 5 })).logScore;
      }, 0);
      scale = new Array(P).fill(1);
      let best = score(scale);
      for (let it = 0; it < 2; it++) for (const pName of MAIN) {
        const j = pc.indexOf(pName);
        for (const g of GRID) { if (g === scale[j]) continue; const sv = [...scale]; sv[j] = g; const v = score(sv); if (v < best) { best = v; scale = sv; } }
      }
      pool = pool.map((e) => scaleResidual(e, scale));
      // Le choc régional, s'il est demandé, se décompose sur les erreurs mises à l'échelle.
      for (const x of innerRes) x.r = x.r.map((e) => scaleResidual(e, scale));
    }
    if (regionalShock) {
      // Moyennes régionales des erreurs, par transition : leur dispersion
      // donne l'écart-type du choc ; les erreurs en sont nettes.
      const means = [], resid = [];
      for (const { Ta, r } of innerRes) {
        for (const g of ["MTL", "QC", "REG"]) {
          const idx = Ta.obs.map((o, i) => (o.g === g ? i : -1)).filter((i) => i >= 0);
          if (!idx.length) continue;
          const m = Array.from({ length: K }, (_, j) => idx.reduce((s, i) => s + r[i][j], 0) / idx.length);
          means.push(m);
          for (const i of idx) resid.push(r[i].map((v, j) => v - m[j]));
        }
      }
      const sigmaRegion = Array.from({ length: K }, (_, j) => Math.sqrt(means.reduce((s, m) => s + m[j] ** 2, 0) / means.length));
      pool = { residuals: resid, sigmaRegion };
    }
    if (fixedScale) {
      const sv = pc.map((p) => fixedScale[p] ?? 1);
      if (Array.isArray(pool)) pool = pool.map((e) => scaleResidual(e, sv));
      else pool = { ...pool, residuals: pool.residuals.map((e) => scaleResidual(e, sv)) };
    }
    let draws;
    if (national === "veille") {
      // Point : moyenne de la tendance ; tirages : un tirage national par tirage local.
      const nat = nationalEve(T, { nDraws, sigmaScale });
      const Tp = { ...T, nationalTarget: nat.point };
      draws = drawShares(T, meansOf(T, kappa, dev), pool, { nDraws, seed, targets: nat.draws });
      res.push({ id: T.id, kappa, lambda, scale, ...evaluateDraws(T, draws, { pointTarget: Tp.nationalTarget, means: meansOf(T, kappa, dev) }) });
      continue;
    }
    draws = drawShares(T, meansOf(T, kappa, dev), pool, { nDraws, seed });
    res.push({ id: T.id, kappa, lambda, scale, ...evaluateDraws(T, draws) });
  }
  const tot = (k) => res.reduce((s, r) => s + r[k], 0);
  return { label, folds: res, total: { logScore: tot("logScore"), brier: tot("brier"), rmse: tot("rmse") / res.length, point: tot("point"), medoid: tot("medoid"), expected: tot("expected") } };
}

/** Résidus de la référence (cible d'apprentissage), centrés par transition. */
export function referenceTargets(train, kappa) {
  // Cible : résidus de la référence courante (tau fixé par crossValidate).
  return train.flatMap((T) => residualsOf(T, meansOf(T, kappa, null)).map((r, i) => ({ o: T.obs[i], T, r })));
}

export function printResult(R) {
  const f = (r) => `${r.id}${typeof r.kappa === "object" ? ` κL${r.kappa.L} κR${r.kappa.R}` : ""}${r.lambda !== undefined && r.lambda !== 0 ? ` λ${r.lambda.toFixed(2)}` : ""}${r.scale ? ` s[${MAIN.map((p) => r.scale[pc.indexOf(p)]).join(",")}]` : ""} ls ${r.logScore.toFixed(3)} br ${r.brier.toFixed(3)} rmse ${r.rmse.toFixed(2)} g ${r.correct}/${r.n} pt ${r.point} md ${r.medoid} esp ${r.expected} pit ${r.pit.map((x) => x.toFixed(2)).join("/")}`;
  console.log(`${R.label.padEnd(34)} TOTAL ls ${R.total.logScore.toFixed(3)} br ${R.total.brier.toFixed(3)} rmse ${R.total.rmse.toFixed(2)} pt ${R.total.point} md ${R.total.medoid} esp ${R.total.expected} | ${R.folds.map(f).join(" | ")}`);
}

/**
 * Échelle des erreurs par parti pour la production : sur les transitions
 * données (bassin de résidus), les erreurs de chaque transition prédisent
 * chacune des autres ; facteurs (grille contenant 1) maximisant le log-score
 * des gagnants, par descente par coordonnées.
 */
export function fitResidualScale(trs, kappa, { GRID = [0.5, 0.75, 1, 1.25, 1.5], nDraws = 800 } = {}) {
  TAU = 0;
  const res = trs.map((T) => residualsOf(T, meansOf(T, kappa, null)));
  const score = (sv) => trs.reduce((acc, T, a) => {
    const other = res.filter((_, b) => b !== a).flat().map((e) => scaleResidual(e, sv));
    return acc + evaluateDraws(T, drawShares(T, meansOf(T, kappa, null), other, { nDraws, seed: 5 })).logScore;
  }, 0);
  let scale = new Array(K + 1).fill(1), best = score(scale);
  const base = best;
  for (let it = 0; it < 2; it++) for (const p of MAIN) {
    const j = pc.indexOf(p);
    for (const g of GRID) { if (g === scale[j]) continue; const sv = [...scale]; sv[j] = g; const v = score(sv); if (v < best) { best = v; scale = sv; } }
  }
  return { scale: Object.fromEntries(pc.map((p, j) => [p, scale[j]])), logScore: best, logScoreUnscaled: base };
}
