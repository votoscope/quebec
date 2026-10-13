/**
 * Base de circonscription à historique : l'écart local (ILR centré) de la
 * dernière élection est mélangé à celui de l'avant-dernière,
 *   niveau' = (1 - omega) niveau(t-1) + omega niveau(t-2),
 * omega sur grille (0 = dernière élection seule). Transitions 2018->2022
 * (avant-dernière : 2014, carte 2011 jointe par nom) et 2022->2026
 * (avant-dernière : 2018 réagrégée sur la carte 2026). Langue, sondages
 * régionaux de fin de campagne et pénalité de siège ouvert (gamma = 0,1)
 * inclus ; vote provincial connu ; omega choisi sur une transition, évalué
 * sur l'autre.
 *
 * Run: node js/tools/history_baseline_test.mjs   (from the repo root)
 */
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { buildData, solveSwing, pc, MAIN } from "./lib/transitionEval.mjs";
import { loadAllRows, electionState } from "./lib/harness.mjs";
const { ilrInv } = mva.composition;
const rows = loadAllRows();
const DATA = (await buildData()).filter((T) => T.id !== "T1");
const PREV2 = { T2: ["2014-04-07", "2011"], T3: ["2018-10-01", "2026"] };
for (const T of DATA) {
  const st = electionState(rows, ...PREV2[T.id], pc);
  for (const o of T.obs) o.level2 = st.levels.get(o.key) ?? null;
  const n = T.obs.filter((o) => o.level2).length;
  console.log(`${T.id} : avant-dernière élection disponible pour ${n}/${T.obs.length} circonscriptions`);
}
const fc = (T, omega, gamma = 0.1, kL = 0.5, kR = 0.5) => {
  const m = T.obs.map((o) => {
    let a = o.level2 ? o.a.map((x, j) => x + omega * (o.level2[j] - o.level[j])) : o.a;
    const prevWin = MAIN.reduce((b, p) => (o.prevShares[pc.indexOf(p)] > o.prevShares[pc.indexOf(b)] ? p : b), MAIN[0]);
    const rerun = o.inc && o.inc.sameParty && o.inc.party === prevWin;
    if (!rerun && gamma) {
      const sh = ilrInv([a])[0].map((x, j) => (pc[j] === prevWin ? x * Math.exp(-gamma) : x));
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
const f = (r) => `${r.rmse.toFixed(2)}/${r.correct}/${r.n}/${r.seatErr}`;
const OM = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
for (const T of DATA) console.log(`  ${T.id} : ` + OM.map((w) => `ω${w} ${f(score(T, fc(T, w)))}`).join(" | "));
for (const [i, T] of DATA.entries()) {
  const O = DATA[1 - i];
  const w = OM.reduce((b, x) => (score(O, fc(O, x)).rmse < score(O, fc(O, b)).rmse ? x : b), 0);
  const r = score(T, fc(T, w));
  console.log(`  ${T.id} : ω choisi sur ${O.id} = ${w} -> ${f(r)} ${JSON.stringify(r.seats)}`);
}
