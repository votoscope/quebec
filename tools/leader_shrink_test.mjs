/**
 * Correction du parti prévu en tête : après la prévision (langue, régions,
 * siège ouvert, swing résolu), la part du parti en tête de chaque
 * circonscription est multipliée par exp(-epsilon), puis le swing est résolu
 * de nouveau (epsilon = 0 : aucune correction). epsilon choisi sur deux
 * transitions (RMSE des parts), évalué sur la troisième, à vote connu et à
 * la veille (tendance GP sur les sondages antérieurs).
 *
 * Run: node js/tools/leader_shrink_test.mjs   (from the repo root)
 */
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { buildData, solveSwing, nationalEve, pc, MAIN } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const DATA = await buildData();
const SPEC = { kL: 0.5, kR: 0.5, g: 0.1 };
function forecast(T, eps, target) {
  const m = T.obs.map((o) => {
    let a = o.a;
    const prevWin = MAIN.reduce((b, p) => (o.prevShares[pc.indexOf(p)] > o.prevShares[pc.indexOf(b)] ? p : b), MAIN[0]);
    if (o.inc !== undefined && !(o.inc && o.inc.sameParty && o.inc.party === prevWin)) {
      const sh = o.prevShares.map((x, j) => (pc[j] === prevWin ? x * Math.exp(-SPEC.g) : x)); const t = sh.reduce((s, x) => s + x, 0);
      a = ilrMatrix([sh.map((x) => x / t)])[0];
    }
    return a.map((x, j) => x + SPEC.kL * o.L[j] + SPEC.kR * o.RP[j]);
  });
  let s = solveSwing(m.map((v, i) => ({ v, w: T.obs[i].w })), target);
  let sh = m.map((v) => ilrInv([v.map((x, j) => x + s[j])])[0]);
  if (!eps) return sh;
  const m2 = sh.map((x) => {
    const lead = MAIN.reduce((b, p) => (x[pc.indexOf(p)] > x[pc.indexOf(b)] ? p : b), MAIN[0]);
    const y = x.map((v, j) => (pc[j] === lead ? v * Math.exp(-eps) : v)); const t = y.reduce((a, b) => a + b, 0);
    return ilrMatrix([y.map((v) => v / t)])[0];
  });
  s = solveSwing(m2.map((v, i) => ({ v, w: T.obs[i].w })), target);
  return m2.map((v) => ilrInv([v.map((x, j) => x + s[j])])[0]);
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
const EPS = [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.15];
for (const T of DATA) console.log(`${T.id} vote connu : ` + EPS.map((e) => { const r = score(T, forecast(T, e, T.nationalTarget)); return `ε${e} ${r.rmse.toFixed(2)}/${r.correct}/${r.seatErr}`; }).join(" | "));
let totK = 0, totE = 0, totE0 = 0;
for (const [i, T] of DATA.entries()) {
  const train = DATA.filter((_, j) => j !== i);
  const eps = EPS.reduce((b, e) => (train.reduce((s, Tr) => s + score(Tr, forecast(Tr, e, Tr.nationalTarget)).rmse ** 2, 0) < train.reduce((s, Tr) => s + score(Tr, forecast(Tr, b, Tr.nationalTarget)).rmse ** 2, 0) ? e : b), 0);
  const k = score(T, forecast(T, eps, T.nationalTarget));
  const nat = nationalEve(T, { nDraws: 10 }).point;
  const v = score(T, forecast(T, eps, nat)), v0 = score(T, forecast(T, 0, nat));
  totK += k.seatErr; totE += v.seatErr; totE0 += v0.seatErr;
  console.log(`${T.id} : ε choisi ${eps} ; vote connu ${k.rmse.toFixed(2)}/${k.correct}/${k.seatErr} ; veille ${v.seatErr} ${JSON.stringify(v.seats)} (ε0 : ${v0.seatErr})`);
}
console.log(`total sièges : vote connu ${totK} ; veille ${totE} (sans correction ${totE0})`);
