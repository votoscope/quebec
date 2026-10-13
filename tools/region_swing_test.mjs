/**
 * Swing régional mesuré dans les ventilations Léger (RMR de Montréal, RMR de
 * Québec, reste), veille contre veille, combiné au swing par langue, à vote
 * provincial connu, sur les trois transitions : y = a + kL L + kR R + s.
 * kL, kR sur grille (0 = absent), choisis sur deux transitions (RMSE des
 * parts), évalués sur la troisième.
 *
 * Run: node js/tools/region_swing_test.mjs   (from the repo root)
 */
import { mva } from "@tangent.to/ds";
import { buildData, solveSwing, pc, MAIN, setRegionSource } from "./lib/transitionEval.mjs";
if (process.argv.includes("--leger")) setRegionSource("leger");
const { ilrInv } = mva.composition;
const DATA = await buildData();
const FIELD = process.argv.includes("--sondages-regionaux") ? "RP" : "R";
console.log(FIELD === "RP" ? "construction : écart régional des sondages à la veille moins écart régional des résultats précédents" : "construction : swing régional Léger veille contre veille");
const fc = (T, kL, kR) => {
  const m = T.obs.map((o) => o.a.map((x, j) => x + kL * o.L[j] + kR * o[FIELD][j]));
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
  return { rmse: Math.sqrt(se / n), correct, seatErr: MAIN.reduce((s, p) => s + Math.abs(seats[p] - actual[p]), 0), n: T.obs.length };
}
const f = (r) => `${r.rmse.toFixed(2)}/${r.correct}/${r.n}/${r.seatErr}`;
const G = [0, 0.5, 1, 1.5];
console.log("RMSE/gagnants/n/sièges à vote connu :");
for (const T of DATA) console.log(`  ${T.id} : report ${f(score(T, fc(T, 0, 0)))} | langue ${f(score(T, fc(T, 1, 0)))} | région ${f(score(T, fc(T, 0, 1)))} | les deux ${f(score(T, fc(T, 1, 1)))}`);
console.log("validation croisée :");
const tot = { r: 0, s: 0, g: 0 };
for (const [i, T] of DATA.entries()) {
  const train = DATA.filter((_, j) => j !== i);
  let b = null;
  for (const kL of G) for (const kR of G) { const e = train.reduce((s, Tr) => s + score(Tr, fc(Tr, kL, kR)).rmse ** 2, 0); if (!b || e < b.e) b = { kL, kR, e }; }
  const r = score(T, fc(T, b.kL, b.kR));
  tot.r += r.rmse / 3; tot.s += r.seatErr; tot.g += r.correct;
  console.log(`  ${T.id} : kL ${b.kL} kR ${b.kR} -> ${f(r)}`);
}
console.log(`  moyenne RMSE ${tot.r.toFixed(2)}, sièges ${tot.s}, gagnants ${tot.g}`);
