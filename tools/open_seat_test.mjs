/**
 * Pénalité de siège ouvert, à vote provincial connu : dans une circonscription
 * dont le député sortant ne se représente pas sous la même bannière, la part
 * du parti gagnant précédent est multipliée par exp(-gamma) avant le swing
 * (gamma = 0 : aucune pénalité). gamma choisi sur une transition (RMSE des
 * parts), évalué sur l'autre (2018 -> 2022 et 2022 -> 2026 ; noms des
 * candidats absents pour 2014). Langue (kappa) et sondages régionaux de fin
 * de campagne (toutes firmes) inclus.
 *
 * Run: node js/tools/open_seat_test.mjs   (from the repo root)
 */
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { buildData, solveSwing, pc, MAIN } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const DATA = (await buildData()).filter((T) => T.id !== "T1");
const fc = (T, gamma, kL, kR) => {
  const m = T.obs.map((o) => {
    const prevWin = MAIN.reduce((b, p) => (o.prevShares[pc.indexOf(p)] > o.prevShares[pc.indexOf(b)] ? p : b), MAIN[0]);
    const rerun = o.inc && o.inc.sameParty && o.inc.party === prevWin;
    let a = o.a;
    if (!rerun && gamma) {
      const sh = o.prevShares.map((x, j) => (pc[j] === prevWin ? x * Math.exp(-gamma) : x));
      const t = sh.reduce((s, x) => s + x, 0);
      a = ilrMatrix([sh.map((x) => x / t)])[0];
    }
    return a.map((x, j) => x + kL * o.L[j] + kR * o.RP[j]);
  });
  const s = solveSwing(m.map((v, i) => ({ v, w: T.obs[i].w })), T.nationalTarget);
  return m.map((v) => ilrInv([v.map((x, j) => x + s[j])])[0]);
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
  return { rmse: Math.sqrt(se / n), correct, seatErr: MAIN.reduce((s, p) => s + Math.abs(seats[p] - actual[p]), 0), n: T.obs.length, seats };
}
const f = (r) => `${r.rmse.toFixed(2)}/${r.correct}/${r.n}/${r.seatErr} ${JSON.stringify(r.seats)}`;
const GAMMAS = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4];
for (const [kL, kR] of [[0, 0], [0.5, 0.5]]) {
  console.log(`\nlangue κ${kL}, régions κ${kR} — RMSE/gagnants/n/sièges :`);
  for (const T of DATA) console.log(`  ${T.id} : ` + GAMMAS.map((g) => `γ${g} ${f(score(T, fc(T, g, kL, kR))).split(" ")[0]}`).join(" | "));
  for (const [i, T] of DATA.entries()) {
    const O = DATA[1 - i];
    const g = GAMMAS.reduce((b, x) => (score(O, fc(O, x, kL, kR)).rmse < score(O, fc(O, b, kL, kR)).rmse ? x : b), 0);
    console.log(`  ${T.id} : γ choisi sur ${O.id} = ${g} -> ${f(score(T, fc(T, g, kL, kR)))}   (γ0 : ${f(score(T, fc(T, 0, kL, kR)))})`);
  }
}
