/**
 * Forme du swing : famille de Box-Cox entre le swing proportionnel (tau = 0,
 * uniforme en log des parts, équivalent au déplacement ILR de la référence)
 * et le swing additif en points (tau = 1). Pour chaque transition, à vote
 * provincial connu :
 *   x'_rj = B_tau^{-1}( B_tau(x_rj) + c_j ), renormalisé ; c résolu pour que
 *   l'agrégat pondéré par les votes égale le vote réel,
 * x étant la composition précédente ajustée du swing par langue (kappa).
 * tau commun ou par parti, sur grille de -1 à 1 (tau = 0 = référence ;
 * tau < 0 : déplacement plus que proportionnel dans les bastions) ; choisi sur deux
 * transitions, évalué sur la troisième (tools/lib/transitionEval.mjs pour
 * les mesures ; bassin d'erreurs = erreurs ILR de la forme choisie sur les
 * transitions d'entraînement).
 *
 * Run: node js/tools/swing_form_test.mjs   (from the repo root)
 */

import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { buildData, fitKappa, drawShares, evaluateDraws, printResult, pc, K, MAIN } from "./lib/transitionEval.mjs";

const { ilrInv } = mva.composition;
const DATA = await buildData();
const P = pc.length;

const bc = (x, t) => (t === 0 ? Math.log(x) : (Math.pow(x, t) - 1) / t);
const bcInv = (y, t) => (t === 0 ? Math.exp(y) : Math.pow(Math.max(t * y + 1, 1e-12), 1 / t));

/** Prévision déterministe (parts) d'une transition sous tau (vecteur par partie). */
function forecast(T, kappa, tau) {
  const start = T.obs.map((o) => ilrInv([o.a.map((x, j) => x + kappa * o.L[j])])[0]);
  const W = T.obs.reduce((s, o) => s + o.w, 0);
  let c = new Array(P).fill(0);
  let out = start;
  for (let it = 0; it < 200; it++) {
    out = start.map((x) => {
      const v = x.map((xi, j) => Math.max(bcInv(bc(Math.max(xi, 1e-6), tau[j]) + c[j], tau[j]), 1e-6));
      const s = v.reduce((a, b) => a + b, 0);
      return v.map((vi) => vi / s);
    });
    const agg = new Array(P).fill(0);
    out.forEach((x, i) => x.forEach((xi, j) => { agg[j] += (T.obs[i].w * xi) / W; }));
    const d = agg.map((g, j) => bc(Math.max(T.nationalTarget[j], 1e-6), tau[j]) - bc(Math.max(g, 1e-6), tau[j]));
    c = c.map((cj, j) => cj + d[j]);
    if (Math.max(...agg.map((g, j) => Math.abs(g - T.nationalTarget[j]))) < 1e-7) break;
  }
  return out;
}
const sse = (T, sh) => T.obs.reduce((a, o, i) => a + MAIN.reduce((b, p) => b + (sh[i][pc.indexOf(p)] - o.yShares[pc.indexOf(p)]) ** 2, 0), 0);
function residuals(T, sh) {
  const f = ilrMatrix(sh);
  const r = T.obs.map((o, i) => o.y.map((x, j) => x - f[i][j]));
  const m = Array.from({ length: K }, (_, j) => r.reduce((a, x) => a + x[j], 0) / r.length);
  return r.map((x) => x.map((v, j) => v - m[j]));
}

const GRID = [-1, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
const vec = (t) => new Array(P).fill(t);
function fitTau(train, kappa, perParty) {
  const loss = (tau) => train.reduce((s, T) => s + sse(T, forecast(T, kappa, tau)), 0);
  if (!perParty) return GRID.reduce((b, t) => (loss(vec(t)) < loss(vec(b)) ? t : b), 0);
  const tau = vec(0);
  for (let it = 0; it < 3; it++) for (const p of MAIN) {
    const j = pc.indexOf(p);
    let best = null;
    for (const g of GRID) { const tt = [...tau]; tt[j] = g; const l = loss(tt); if (!best || l < best.l) best = { g, l }; }
    tau[j] = best.g;
  }
  return tau;
}

for (const perParty of [false, true]) {
  const folds = [];
  for (const [i, T] of DATA.entries()) {
    const train = DATA.filter((_, j) => j !== i);
    const kappa = fitKappa(train);
    const t = fitTau(train, kappa, perParty);
    const tau = Array.isArray(t) ? t : vec(t);
    const pool = train.flatMap((Tr) => residuals(Tr, forecast(Tr, kappa, tau)));
    const means = ilrMatrix(forecast(T, kappa, tau));
    const draws = drawShares(T, means, pool);
    folds.push({ id: T.id, tauStr: Array.isArray(t) ? `[${MAIN.map((p) => t[pc.indexOf(p)]).join(",")}]` : String(t), ...evaluateDraws(T, draws) });
  }
  const tot = (k) => folds.reduce((s, r) => s + r[k], 0);
  const label = perParty ? "Box-Cox tau par parti" : "Box-Cox tau commun";
  printResult({ label, folds: folds.map((f) => ({ ...f, id: `${f.id} τ${f.tauStr}` })), total: { logScore: tot("logScore"), brier: tot("brier"), rmse: tot("rmse") / 3, point: tot("point"), medoid: tot("medoid") } });
}
