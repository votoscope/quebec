/**
 * Modèle hiérarchique bayésien de la couche par circonscription, ajusté
 * conjointement (NUTS, @tangent.to/mc) sur des transitions générales, évalué
 * sur une transition laissée de côté, à vote provincial connu.
 *
 * Pour l'observation i (circonscription r, transition t, région g), en ILR
 * (K = 5 coordonnées, ordre des partis de la production) :
 *   y_i = a_i + s_t + kappa * L_i + R_{t,g} + P_i + e_i
 *   a_i   : résultat précédent ; s_t : swing de la transition (effet fixe) ;
 *   L_i   : swing par langue maternelle mesuré dans les ventilations Léger
 *           (kappa = 1), converti en déplacement ILR ;
 *   R_t,g : effet régional latent, R = tau * z, z ~ N(0, 1) ;
 *   P_i   : ajustement régional des sondages (2022 -> 2026 seulement) ;
 *   e_i   : Student multivariée (nu, Sigma = L L^T), nu et Sigma estimés.
 * A priori : kappa ~ N(0, 1) (0 = pas de swing linguistique), tau ~ HalfNormal,
 * nu ~ Gamma(2, 0.1).
 *
 * Prédiction de la transition laissée de côté, par tirage a posteriori :
 * R_new ~ N(0, tau), e ~ Student(nu, Sigma), s résolu pour que l'agrégat
 * pondéré par les votes égale le vote provincial réel. Comparé au modèle de
 * référence de production équivalent (swing additif + langue avec kappa
 * estimé sur les transitions d'entraînement + sondages régionaux + bootstrap
 * des écarts des transitions d'entraînement).
 *
 * Run: node js/tools/hierarchical_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import mcLib, { Model, Normal, HalfNormal, Gamma, NUTS } from "@tangent.to/mc";
import { mva } from "@tangent.to/ds";
import { pivotPolls } from "../src/compositional.js";
import { ilrMatrix } from "../src/ridingEffects.js";
import { languageAdjustments, applyLanguageAdjustment } from "../src/languageSwing.js";
import { medoidDraw } from "../src/simulate.js";
import { computeProjection } from "../src/computeProjection.js";
import { loadFixtures, GOLDEN_AS_OF } from "../test/golden_lib.mjs";
import { loadAllRows, electionState } from "./lib/harness.mjs";
import { disseminationAreas } from "./lib/geo.mjs";

const { ilrInv } = mva.composition;
const ops = mcLib.ops;
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

const data = loadFixtures(new URL("../test/fixtures/", import.meta.url));
const { partyCodes: pc } = pivotPolls(data.pollRows); // base ILR de production
const K = pc.length - 1;
const MAIN = ["CAQ", "LIB", "PCQ", "PQ", "QS"];
const rows = loadAllRows();
const crosstabs = load("../data/qc_leger_crosstabs.json");
const comp = load("../data/qc_riding_language_age.json");
const daRiding = load("../data/qc_da_riding.json");

// --- régions (RMR de Montréal / de Québec / reste) des deux cartes ----------
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
const regionOf = Object.fromEntries(Object.entries(popBy).map(([m, o]) => [m, Object.fromEntries(Object.entries(o).map(([r, v]) => [r, Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]]))]));
const prodRegion = new Map(data.ridingRegions.map((r) => [String(r.riding_code), r.region_code]));
const agree = Object.entries(regionOf["2026"]).filter(([c, g]) => prodRegion.get(c) === g).length;
console.log(`régions : accord avec la production sur la carte 2026 ${agree}/${Object.keys(regionOf["2026"]).length} (${elapsed()})`);
const GROUPS = ["MTL", "QC", "REG"];

// --- ajustement régional des sondages à la veille 2026 (production) ----------
const prod = computeProjection(data, { asOf: GOLDEN_AS_OF, pointOnly: true, layers: { openSeat: false, leaders: false, regional: true, language: false, byelections: false } });
if (prod.partyCodes.join() !== pc.join()) throw new Error("ordre des partis");
const POLL_ADJ = prod.regionAdj; // région -> vecteur ILR
console.log(`ajustement régional des sondages chargé (${elapsed()})`);

// --- observations par transition -----------------------------------------------
const TRANSITIONS = [
  { id: "T1", y0: "2014", y1: "2018", base: ["2014-04-07", "2011"], target: ["2018-10-01", "2017"], map: "2017", polls: false },
  { id: "T2", y0: "2018", y1: "2022", base: ["2018-10-01", "2017"], target: ["2022-10-03", "2017"], map: "2017", polls: false },
  { id: "T3", y0: "2022", y1: "2026", base: ["2022-10-03", "2026"], target: ["2026-10-05", "2026"], map: "2026", polls: true },
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
function buildTransition(t) {
  const base = electionState(rows, ...t.base, pc), tgt = electionState(rows, ...t.target, pc);
  const lang = languageAdjustments(crosstabs, comp[t.map], { previousYear: t.y0, currentYear: t.y1, asOf: t.target[0], kappa: 1 });
  const vb = votesBy(...t.base), vt = votesBy(...t.target);
  const obs = [];
  for (const key of base.keys) {
    const k = String(key);
    if (!tgt.ilr.has(key) || !comp[t.map][k] || !regionOf[t.map][k]) continue;
    const a = base.ilr.get(key);
    const prevShares = ilrInv([a])[0];
    const adj = lang.adj.get(k);
    const L = adj ? ilrMatrix([applyLanguageAdjustment(prevShares, pc, adj)])[0].map((v, j) => v - a[j]) : new Array(K).fill(0);
    const g = regionOf[t.map][k];
    obs.push({ key: k, a, y: tgt.ilr.get(key), L, g, P: t.polls ? POLL_ADJ[g] : new Array(K).fill(0), w: vb.total.get(k) ?? 1, yShares: ilrInv([tgt.ilr.get(key)])[0] });
  }
  return { ...t, obs, nationalTarget: vt.prov };
}
const DATA = TRANSITIONS.map(buildTransition);
for (const T of DATA) console.log(`${T.id} : ${T.obs.length} circonscriptions`);

// --- modèle hiérarchique ---------------------------------------------------------
const M = (K * (K - 1)) / 2;
// Matrices constantes : vecteur des hors-diagonales -> L aplati ; diagonale -> L aplati.
const B = Array.from({ length: K * K }, () => new Array(M).fill(0));
const D = Array.from({ length: K * K }, () => new Array(K).fill(0));
{ let m = 0; for (let i = 0; i < K; i++) for (let j = 0; j < i; j++) B[i * K + j][m++] = 1; for (let i = 0; i < K; i++) D[i * K + i][i] = 1; }

function fitHierarchical(train, { nSamples = 400, nWarmup = 400, chains = 2, seed = 7 } = {}) {
  const obs = train.flatMap((T, ti) => T.obs.map((o) => ({ ...o, ti })));
  const N = obs.length, NT = train.length, NR = NT * GROUPS.length;
  const Y = obs.map((o) => o.y), A = obs.map((o) => o.a), Lm = obs.map((o) => o.L), Pm = obs.map((o) => o.P);
  const Ot = obs.map((o) => Array.from({ length: NT }, (_, t) => (t === o.ti ? 1 : 0)));
  const Or = obs.map((o) => Array.from({ length: NR }, (_, r) => (r === o.ti * GROUPS.length + GROUPS.indexOf(o.g) ? 1 : 0)));
  const onesNR = Array.from({ length: NR }, () => [1]);
  const onesK = [new Array(K).fill(1)];
  const YmAP = Y.map((y, i) => y.map((v, j) => v - A[i][j] - Pm[i][j]));

  const model = new Model("hierarchique");
  model.addVariable("s", new Normal(0, 2));
  model.addVariable("kappa", new Normal(0, 1));
  model.addVariable("zR", new Normal(0, 1));
  model.addVariable("tau", new HalfNormal(0.5));
  model.addVariable("ld", new Normal(-1.5, 1));
  model.addVariable("off", new Normal(0, 0.3));
  model.addVariable("nu", new Gamma(2, 0.1));
  const lg = (x) => ops.lgamma(x);
  model.autoPotential("y", (v) => {
    const sMat = ops.reshape(v.s, [NT, K]);
    const zMat = ops.reshape(v.zR, [NR, K]);
    const tauRows = ops.matmul(onesNR, ops.reshape(v.tau, [1, K]));
    const R = ops.mul(zMat, tauRows);
    const mu = ops.add(ops.matmul(Ot, sMat), ops.mul(v.kappa, Lm), ops.matmul(Or, R));
    const E = ops.sub(YmAP, mu); // N x K
    const Lflat = ops.add(ops.matmul(B, ops.reshape(v.off, [M, 1])), ops.matmul(D, ops.reshape(ops.exp(v.ld), [K, 1])));
    const Lc = ops.reshape(Lflat, [K, K]);
    const Z = ops.triangularSolve(Lc, ops.transpose(E), { lower: true }); // K x N
    // Forme quadratique par observation (grad.sum ne réduit pas par axe).
    const q = ops.reshape(ops.matmul(onesK, ops.square(Z)), [N]);
    const nu = v.nu;
    const perObs = ops.mul(ops.div(ops.add(nu, K), -2), ops.log(ops.add(1, ops.div(q, nu))));
    const norm = ops.sub(ops.sub(lg(ops.div(ops.add(nu, K), 2)), lg(ops.div(nu, 2))), ops.mul(K / 2, ops.log(ops.mul(nu, Math.PI))));
    return ops.add(ops.sum(perObs), ops.mul(N, ops.sub(norm, ops.sum(v.ld))));
  });
  const init = {
    s: new Array(NT * K).fill(0), kappa: 0.5, zR: new Array(NR * K).fill(0), tau: new Array(K).fill(0.1),
    ld: new Array(K).fill(-1.2), off: new Array(M).fill(0), nu: 10,
  };
  return new NUTS({ targetAcceptance: 0.85, maxTreeDepth: 8 }).sample(model, init, { chains, nSamples, nWarmup, seed });
}

// --- prédiction d'une transition à partir de tirages des paramètres ------------
function solveSwing(base, target) {
  // s tel que l'agrégat pondéré des parts prédites égale le vote réel.
  const [tIlr] = ilrMatrix([target]);
  let s = new Array(K).fill(0);
  for (let it = 0; it < 30; it++) {
    const agg = new Array(K + 1).fill(0); let W = 0;
    for (const { v, w } of base) { const sh = ilrInv([v.map((x, j) => x + s[j])])[0]; sh.forEach((x, j) => { agg[j] += w * x; }); W += w; }
    const [aIlr] = ilrMatrix([agg.map((x) => x / W)]);
    const d = aIlr.map((x, j) => tIlr[j] - x);
    s = s.map((x, j) => x + d[j]);
    if (Math.max(...d.map(Math.abs)) < 1e-6) break;
  }
  return s;
}
function mulberry32(seed) { return () => { let t = (seed += 0x6d2b79f5); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rng = mulberry32(3);
const randn = () => Math.sqrt(-2 * Math.log(rng() || 1e-12)) * Math.cos(2 * Math.PI * rng());
function randGamma(a) { if (a < 1) return randGamma(a + 1) * Math.pow(rng(), 1 / a); const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d); for (;;) { let x, v; do { x = randn(); v = 1 + c * x; } while (v <= 0); v = v ** 3; const u = rng(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; } }

function evaluateDraws(T, drawShares) {
  // drawShares : tableau de tirages, chacun Map clé -> parts (ordre pc).
  const nD = drawShares.length;
  const seatsDraws = [], winCount = T.obs.map(() => Object.fromEntries(MAIN.map((p) => [p, 0])));
  const meanSh = T.obs.map(() => new Array(K + 1).fill(0));
  for (const ds of drawShares) {
    const seats = Object.fromEntries(pc.map((p) => [p, 0]));
    T.obs.forEach((o, i) => {
      const sh = ds[i]; sh.forEach((x, j) => { meanSh[i][j] += x / nD; });
      const w = MAIN.reduce((b, p) => (sh[pc.indexOf(p)] > sh[pc.indexOf(b)] ? p : b), MAIN[0]);
      seats[w]++; winCount[i][w]++;
    });
    seatsDraws.push(seats);
  }
  const actual = Object.fromEntries(pc.map((p) => [p, 0]));
  let ls = 0, br = 0, se = 0, n = 0, correct = 0;
  const pointSeats = Object.fromEntries(pc.map((p) => [p, 0]));
  T.obs.forEach((o, i) => {
    const t = o.yShares;
    const win = MAIN.reduce((b, p) => (t[pc.indexOf(p)] > t[pc.indexOf(b)] ? p : b), MAIN[0]);
    actual[win]++;
    const pr = Object.fromEntries(MAIN.map((p) => [p, winCount[i][p] / nD]));
    ls += -Math.log(Math.max(pr[win], 1 / nD)); for (const p of MAIN) br += (pr[p] - (p === win ? 1 : 0)) ** 2;
    for (const p of MAIN) { const j = pc.indexOf(p); se += ((meanSh[i][j] - t[j]) * 100) ** 2; n++; }
    const pw = MAIN.reduce((b, p) => (meanSh[i][pc.indexOf(p)] > meanSh[i][pc.indexOf(b)] ? p : b), MAIN[0]);
    pointSeats[pw]++; if (pw === win) correct++;
  });
  const med = medoidDraw(seatsDraws, pc);
  const err = (o) => MAIN.reduce((s, p) => s + Math.abs((o[p] ?? 0) - actual[p]), 0);
  const pit = MAIN.map((p) => { let b = 0, e = 0; for (const d of seatsDraws) { if (d[p] < actual[p]) b++; else if (d[p] === actual[p]) e++; } return (b + e / 2) / nD; });
  return { rmse: Math.sqrt(se / n), logScore: ls / T.obs.length, brier: br / T.obs.length, correct, n: T.obs.length, point: err(pointSeats), medoid: err(med), pit };
}

function predictHierarchical(T, trace, nDraws = 1000) {
  const draws = trace.length !== undefined ? trace : null;
  const get = (name, d) => trace[name][d];
  const nAvail = trace.kappa.length;
  const out = [];
  for (let d = 0; d < nDraws; d++) {
    const k = Math.floor((d * nAvail) / nDraws);
    const kappa = get("kappa", k), tau = get("tau", k), ld = get("ld", k), off = get("off", k), nu = get("nu", k);
    const L = Array.from({ length: K }, () => new Array(K).fill(0));
    let m = 0; for (let i = 0; i < K; i++) { for (let j = 0; j < i; j++) L[i][j] = off[m++]; L[i][i] = Math.exp(ld[i]); }
    const Rg = Object.fromEntries(GROUPS.map((g) => [g, tau.map((s) => s * randn())]));
    const base = T.obs.map((o) => {
      const z = Array.from({ length: K }, randn);
      const scale = Math.sqrt(nu / (2 * randGamma(nu / 2)));
      const e = L.map((row) => row.reduce((s, x, j) => s + x * z[j], 0) * scale);
      return { v: o.a.map((x, j) => x + kappa * o.L[j] + Rg[o.g][j] + o.P[j] + e[j]), w: o.w };
    });
    const s = solveSwing(base, T.nationalTarget);
    out.push(base.map(({ v }) => ilrInv([v.map((x, j) => x + s[j])])[0]));
  }
  return out;
}

function predictBaseline(T, train, nDraws = 1000, { language = true, polls = true } = {}) {
  // kappa par moindres carrés sur la grille, transitions d'entraînement.
  const GRID = language ? [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] : [0];
  const Pof = (o) => (polls ? o.P : o.P.map(() => 0));
  const sse = (kap) => train.reduce((acc, Tr) => {
    const base = Tr.obs.map((o) => ({ v: o.a.map((x, j) => x + kap * o.L[j] + Pof(o)[j]), w: o.w }));
    const s = solveSwing(base, Tr.nationalTarget);
    return acc + Tr.obs.reduce((a2, o, i) => { const sh = ilrInv([base[i].v.map((x, j) => x + s[j])])[0]; return a2 + MAIN.reduce((a3, p) => a3 + (sh[pc.indexOf(p)] - o.yShares[pc.indexOf(p)]) ** 2, 0); }, 0);
  }, 0);
  const kap = GRID.reduce((b, k) => (sse(k) < sse(b) ? k : b), 0);
  // Bassin : écarts des transitions d'entraînement au modèle (swing + langue), centrés.
  const pool = train.flatMap((Tr) => {
    const base = Tr.obs.map((o) => ({ v: o.a.map((x, j) => x + kap * o.L[j] + Pof(o)[j]), w: o.w }));
    const s = solveSwing(base, Tr.nationalTarget);
    const res = Tr.obs.map((o, i) => o.y.map((x, j) => x - base[i].v[j] - s[j]));
    const mean = Array.from({ length: K }, (_, j) => res.reduce((a, r) => a + r[j], 0) / res.length);
    return res.map((r) => r.map((x, j) => x - mean[j]));
  });
  const out = [];
  for (let d = 0; d < nDraws; d++) {
    const base = T.obs.map((o) => { const e = pool[Math.floor(rng() * pool.length)]; return { v: o.a.map((x, j) => x + kap * o.L[j] + Pof(o)[j] + e[j]), w: o.w }; });
    const s = solveSwing(base, T.nationalTarget);
    out.push(base.map(({ v }) => ilrInv([v.map((x, j) => x + s[j])])[0]));
  }
  return { draws: out, kappa: kap };
}

// --- validation : chaque transition prédite à partir des deux autres ------------
const fmt = (r) => `RMSE ${r.rmse.toFixed(2)}  log-score ${r.logScore.toFixed(3)}  Brier ${r.brier.toFixed(3)}  gagnants ${r.correct}/${r.n}  sièges point ${r.point} médoïde ${r.medoid}  PIT ${r.pit.map((x) => x.toFixed(2)).join("/")}`;
const only = process.argv[2];
const skipNuts = process.argv.includes("--sans-nuts");
for (const [i, T] of DATA.entries()) {
  if (only && T.id !== only) continue;
  const train = DATA.filter((_, j) => j !== i);
  const b0 = predictBaseline(T, train, 1000, { language: false, polls: false });
  const b = predictBaseline(T, train);
  console.log(`\n=== ${T.id} (${T.y0} -> ${T.y1}), entraînement ${train.map((x) => x.id).join("+")} ===`);
  console.log(`  report pur + bootstrap : ${fmt(evaluateDraws(T, b0.draws))}`);
  const bL = predictBaseline(T, train, 1000, { language: true, polls: false });
  console.log(`  langue seule (kappa ${bL.kappa}) : ${fmt(evaluateDraws(T, bL.draws))}`);
  if (T.polls) { const bP = predictBaseline(T, train, 1000, { language: false, polls: true }); console.log(`  sondages régionaux seuls : ${fmt(evaluateDraws(T, bP.draws))}`); }
  console.log(`  référence (kappa ${b.kappa}) : ${fmt(evaluateDraws(T, b.draws))}`);
  if (skipNuts) continue;
  const fit = await fitHierarchical(train);
  const tr = fit.trace;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  console.log(`  NUTS terminé (${elapsed()}) : kappa ${mean(tr.kappa).toFixed(2)}, nu ${mean(tr.nu).toFixed(1)}, tau [${tr.tau[0].map((_, j) => mean(tr.tau.map((t) => t[j])).toFixed(3)).join(", ")}]`);
  console.log(`  hiérarchique : ${fmt(evaluateDraws(T, predictHierarchical(T, tr)))}`);
}
console.log(`\ntotal ${elapsed()}`);
