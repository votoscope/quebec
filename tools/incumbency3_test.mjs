/**
 * Siège ouvert sur les trois transitions (sortants de 2014, 2018 et 2022 ;
 * tools/build_incumbency.mjs). Dans une circonscription dont le député ne se
 * représente pas sous la même bannière, la part du parti gagnant précédent
 * est multipliée par exp(-g), avec
 *   A : g = gamma ;
 *   B : g = gamma (1 + eta * recul), recul = max(0, log(X_p / Y_p)), X_p et
 *       Y_p les parts provinciales précédente et visée du parti (à la veille :
 *       tendance au point).
 * gamma = 0 : aucune pénalité ; eta = 0 : forme A. Spécification de base :
 * langue 0,5, sondages régionaux 0,5. Paramètres choisis sur deux transitions
 * (RMSE des parts à vote connu), évalués sur la troisième, à vote connu et à
 * la veille (sièges au point).
 *
 * Run: node js/tools/incumbency3_test.mjs   (from the repo root)
 */
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { buildData, solveSwing, nationalEve, pc, MAIN } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const DATA = await buildData();
for (const T of DATA) {
  const W = T.obs.reduce((s, o) => s + o.w, 0);
  T.prevProv = pc.map((_, j) => T.obs.reduce((s, o) => s + (o.w * o.prevShares[j]) / W, 0));
  console.log(`${T.id} : sortants connus pour ${T.obs.filter((o) => o.inc !== undefined).length}/${T.obs.length}, se représentant ${T.obs.filter((o) => o.inc && o.inc.sameParty).length}`);
}
function forecast(T, gamma, eta, target) {
  const m = T.obs.map((o) => {
    let a = o.a;
    const prevWin = MAIN.reduce((b, p) => (o.prevShares[pc.indexOf(p)] > o.prevShares[pc.indexOf(b)] ? p : b), MAIN[0]);
    const rerun = o.inc && o.inc.sameParty && o.inc.party === prevWin;
    if (gamma && o.inc !== undefined && !rerun) {
      const j = pc.indexOf(prevWin);
      const decline = Math.max(0, Math.log(T.prevProv[j] / Math.max(target[j], 1e-4)));
      const g = gamma * (1 + eta * decline);
      const sh = o.prevShares.map((x, k) => (k === j ? x * Math.exp(-g) : x)); const t = sh.reduce((s, x) => s + x, 0);
      a = ilrMatrix([sh.map((x) => x / t)])[0];
    }
    return a.map((x, j) => x + 0.5 * o.L[j] + 0.5 * o.RP[j]);
  });
  const s = solveSwing(m.map((v, i) => ({ v, w: T.obs[i].w })), target);
  return m.map((v) => ilrInv([v.map((x, j) => x + s[j])])[0]);
}
function score(T, sh) {
  let se = 0, n = 0, correct = 0;
  const seats = Object.fromEntries(MAIN.map((p) => [p, 0])), actual = Object.fromEntries(MAIN.map((p) => [p, 0]));
  T.obs.forEach((o, i) => {
    for (const p of MAIN) { const j = pc.indexOf(p); se += ((sh[i][j] - o.yShares[j]) * 100) ** 2; n++; }
    const w = MAIN.reduce((b, p) => (sh[i][pc.indexOf(p)] > sh[i][pc.indexOf(b)] ? p : b), MAIN[0]);
    const t = MAIN.reduce((b, p) => (o.yShares[pc.indexOf(p)] > o.yShares[pc.indexOf(b)] ? p : b), MAIN[0]);
    seats[w]++; actual[t]++; if (w === t) correct++;
  });
  return { rmse: Math.sqrt(se / n), correct, seatErr: MAIN.reduce((s, p) => s + Math.abs(seats[p] - actual[p]), 0), seats };
}
const GAMMAS = [0, 0.05, 0.1, 0.15, 0.2, 0.3];
const ETAS = [0, 1, 2, 5];
for (const T of DATA) console.log(`  ${T.id} forme A, vote connu : ` + GAMMAS.map((g) => { const r = score(T, forecast(T, g, 0, T.nationalTarget)); return `γ${g} ${r.rmse.toFixed(2)}/${r.correct}/${r.seatErr}`; }).join(" | "));
for (const [label, etas] of [["A (eta = 0)", [0]], ["B (eta sur grille)", ETAS]]) {
  let tk = 0, tv = 0, tk0 = 0, tv0 = 0;
  console.log(`\nforme ${label} :`);
  for (const [i, T] of DATA.entries()) {
    const train = DATA.filter((_, j) => j !== i);
    let best = null;
    for (const g of GAMMAS) for (const e of etas) {
      const sse = train.reduce((s, Tr) => s + score(Tr, forecast(Tr, g, e, Tr.nationalTarget)).rmse ** 2, 0);
      if (!best || sse < best.sse) best = { g, e, sse };
    }
    const nat = nationalEve(T, { nDraws: 10 }).point;
    const k = score(T, forecast(T, best.g, best.e, T.nationalTarget)), k0 = score(T, forecast(T, 0, 0, T.nationalTarget));
    const v = score(T, forecast(T, best.g, best.e, nat)), v0 = score(T, forecast(T, 0, 0, nat));
    tk += k.seatErr; tv += v.seatErr; tk0 += k0.seatErr; tv0 += v0.seatErr;
    console.log(`  ${T.id} : γ ${best.g} η ${best.e} ; vote connu ${k.rmse.toFixed(2)}/${k.correct}/${k.seatErr} (sans ${k0.rmse.toFixed(2)}/${k0.correct}/${k0.seatErr}) ; veille ${v.seatErr} ${JSON.stringify(v.seats)} (sans ${v0.seatErr})`);
  }
  console.log(`  total sièges : vote connu ${tk} (sans ${tk0}) ; veille ${tv} (sans ${tv0})`);
}
