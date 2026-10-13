/**
 * Modèle de transition (flux de voix) contre swing proportionnel, à vote
 * provincial connu, sur les trois transitions.
 *
 * Partis en recul national : perte d'une fraction constante (1 - Y_p/X_p) de
 * leurs voix dans chaque circonscription. Bassin de voix perdues de la
 * circonscription redistribué aux partis en progression, au prorata de
 * c_g * G_g * x_rg^alpha (G_g : gain national ; c_g ajusté pour que
 * l'agrégat pondéré par les votes égale le vote réel ; alpha = 0 : transfert
 * pur depuis les perdants, alpha = 1 : au prorata de la force locale du
 * gagnant). Swing par langue maternelle (kappa) appliqué ensuite en CLR.
 * alpha et kappa choisis sur deux transitions (RMSE des parts), évalués sur
 * la troisième.
 *
 * Run: node js/tools/transition_model_test.mjs   (from the repo root)
 */
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { buildData, solveSwing, pc, K, MAIN } from "./lib/transitionEval.mjs";

const { ilrInv } = mva.composition;
const DATA = await buildData();
const P = pc.length;

function transitionShares(T, alpha) {
  const x = T.obs.map((o) => o.prevShares);
  const W = T.obs.reduce((s, o) => s + o.w, 0);
  const X = Array.from({ length: P }, (_, j) => x.reduce((s, r, i) => s + (T.obs[i].w * r[j]) / W, 0));
  const Y = T.nationalTarget;
  const losers = X.map((v, j) => Y[j] < v);
  const ret = X.map((v, j) => (losers[j] ? Y[j] / v : 1));
  const G = X.map((v, j) => (losers[j] ? 0 : Y[j] - v));
  let c = new Array(P).fill(1);
  let out = x;
  for (let it = 0; it < 200; it++) {
    out = x.map((r) => {
      const pool = r.reduce((s, v, j) => s + (losers[j] ? v * (1 - ret[j]) : 0), 0);
      const wts = r.map((v, j) => (losers[j] ? 0 : c[j] * G[j] * Math.pow(Math.max(v, 1e-4), alpha)));
      const tw = wts.reduce((a, b) => a + b, 0) || 1;
      return r.map((v, j) => (losers[j] ? v * ret[j] : v + (pool * wts[j]) / tw));
    });
    const agg = Array.from({ length: P }, (_, j) => out.reduce((s, r, i) => s + (T.obs[i].w * r[j]) / W, 0));
    let maxd = 0;
    for (let j = 0; j < P; j++) if (!losers[j] && G[j] > 0) { const gotGain = agg[j] - X[j]; c[j] *= Math.max(0.2, Math.min(5, G[j] / Math.max(gotGain, 1e-9))); maxd = Math.max(maxd, Math.abs(agg[j] - Y[j])); }
    if (maxd < 1e-7) break;
  }
  return out;
}
const withLanguage = (T, shares, kappa) => {
  if (!kappa) return shares;
  // L est un déplacement ILR calculé sur la composition précédente : appliqué tel quel.
  const m = ilrMatrix(shares.map((r) => r.map((v) => Math.max(v, 1e-6))));
  const moved = m.map((v, i) => v.map((x, j) => x + kappa * T.obs[i].L[j]));
  const s = solveSwing(moved.map((v, i) => ({ v, w: T.obs[i].w })), T.nationalTarget);
  return moved.map((v) => ilrInv([v.map((x, j) => x + s[j])])[0]);
};
const proportional = (T, kappa) => {
  const means = T.obs.map((o) => o.a.map((x, j) => x + kappa * o.L[j]));
  const s = solveSwing(means.map((v, i) => ({ v, w: T.obs[i].w })), T.nationalTarget);
  return means.map((v) => ilrInv([v.map((x, j) => x + s[j])])[0]);
};
function score(T, sh) {
  let se = 0, n = 0, correct = 0;
  const seats = Object.fromEntries(MAIN.map((p) => [p, 0])), actual = Object.fromEntries(MAIN.map((p) => [p, 0]));
  T.obs.forEach((o, i) => {
    for (const p of MAIN) { const j = pc.indexOf(p); se += ((sh[i][j] - o.yShares[j]) * 100) ** 2; n++; }
    const w = MAIN.reduce((b, p) => (sh[i][pc.indexOf(p)] > sh[i][pc.indexOf(b)] ? p : b), MAIN[0]);
    const t = MAIN.reduce((b, p) => (o.yShares[pc.indexOf(p)] > o.yShares[pc.indexOf(b)] ? p : b), MAIN[0]);
    seats[w]++; actual[t]++; if (w === t) correct++;
  });
  return { rmse: Math.sqrt(se / n), correct, seatErr: MAIN.reduce((s, p) => s + Math.abs(seats[p] - actual[p]), 0), n: T.obs.length };
}
const ALPHAS = [0, 0.25, 0.5, 0.75, 1];
const KAPPAS = [0, 0.5, 1];
console.log("par transition (RMSE / gagnants / sièges), vote connu :");
for (const T of DATA) {
  const row = [`prop κ0 ${fmt(score(T, proportional(T, 0)))}`, `prop κ1 ${fmt(score(T, proportional(T, 1)))}`];
  for (const a of ALPHAS) row.push(`flux α${a} ${fmt(score(T, transitionShares(T, a)))}`);
  console.log(`  ${T.id} : ${row.join(" | ")}`);
}
function fmt(r) { return `${r.rmse.toFixed(2)}/${r.correct}/${r.seatErr}`; }

console.log("\nvalidation croisée (alpha, kappa choisis sur les deux autres) :");
let totFlux = 0, totProp = 0, seatsFlux = 0, seatsProp = 0;
for (const [i, T] of DATA.entries()) {
  const train = DATA.filter((_, j) => j !== i);
  let best = null;
  for (const a of ALPHAS) for (const k of KAPPAS) {
    const e = train.reduce((s, Tr) => s + score(Tr, withLanguage(Tr, transitionShares(Tr, a), k)).rmse ** 2, 0);
    if (!best || e < best.e) best = { a, k, e };
  }
  let bestP = null;
  for (const k of KAPPAS) { const e = train.reduce((s, Tr) => s + score(Tr, proportional(Tr, k)).rmse ** 2, 0); if (!bestP || e < bestP.e) bestP = { k, e }; }
  const rf = score(T, withLanguage(T, transitionShares(T, best.a), best.k));
  const rp = score(T, proportional(T, bestP.k));
  totFlux += rf.rmse; totProp += rp.rmse; seatsFlux += rf.seatErr; seatsProp += rp.seatErr;
  console.log(`  ${T.id} : flux α${best.a} κ${best.k} ${fmt(rf)}   proportionnel κ${bestP.k} ${fmt(rp)}`);
}
console.log(`  moyenne RMSE flux ${(totFlux / 3).toFixed(2)} contre proportionnel ${(totProp / 3).toFixed(2)} ; sièges ${seatsFlux} contre ${seatsProp}`);
