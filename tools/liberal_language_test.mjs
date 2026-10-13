/**
 * Coefficient de langue propre au PLQ. Le swing par langue est un
 * déplacement CLR des cinq partis ; sa composante PLQ est multipliée par
 * kLIB / kL, les autres gardent kL (kLIB = kL : forme commune). Spécification
 * de base : langue kL = 0,5, sondages régionaux 0,5, siège ouvert gamma = 0,12.
 * kLIB choisi sur deux transitions (RMSE des parts), évalué sur la troisième,
 * à vote connu et à la veille.
 *
 * Run: node js/tools/liberal_language_test.mjs   (from the repo root)
 */
import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { applyLanguageAdjustment, LANGUAGE_PARTIES } from "../src/languageSwing.js";
import { buildData, solveSwing, nationalEve, pc, MAIN } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const cross = JSON.parse(readFileSync(new URL("../data/qc_leger_crosstabs.json", import.meta.url), "utf-8"));
const DATA = await buildData();
const clr = (v) => { const l = v.map((x) => Math.log(Math.max(x, 1e-4))); const m = l.reduce((a, b) => a + b, 0) / l.length; return l.map((x) => x - m); };
const pooled = (waves, g) => { const acc = Object.fromEntries(LANGUAGE_PARTIES.map((p) => [p, 0])); let N = 0; for (const w of waves) { const x = w.groups[g]; for (const p of LANGUAGE_PARTIES) acc[p] += x.n * (x.shares[p] ?? 0); N += x.n; } const v = LANGUAGE_PARTIES.map((p) => Math.max(acc[p] / N, 0.5)); const t = v.reduce((a, b) => a + b, 0); return v.map((x) => x / t); };
// Ajustement CLR de langue par circonscription (kappa = 1), recalculé ici pour pouvoir le moduler par parti.
for (const T of DATA) {
  const prev = cross[T.y0].waves.slice(-2), curr = cross[T.y1].waves.slice(-2);
  const D = ["franco", "nonfranco"].map((g) => clr(pooled(curr, g)).map((v, j) => v - clr(pooled(prev, g))[j]));
  const mean = T.obs.reduce((s, o) => s + o.franco, 0) / T.obs.length;
  const Dbar = LANGUAGE_PARTIES.map((_, j) => mean * D[0][j] + (1 - mean) * D[1][j]);
  for (const o of T.obs) o.clrL = LANGUAGE_PARTIES.map((_, j) => o.franco * D[0][j] + (1 - o.franco) * D[1][j] - Dbar[j]);
}
const iLIB = LANGUAGE_PARTIES.indexOf("LIB");
function forecast(T, kL, kLIB, target) {
  const m = T.obs.map((o) => {
    let sh = [...o.prevShares];
    const prevWin = MAIN.reduce((b, p) => (o.prevShares[pc.indexOf(p)] > o.prevShares[pc.indexOf(b)] ? p : b), MAIN[0]);
    if (o.inc !== undefined && !(o.inc && o.inc.sameParty && o.inc.party === prevWin)) { sh = sh.map((x, j) => (pc[j] === prevWin ? x * Math.exp(-0.12) : x)); const t = sh.reduce((s, x) => s + x, 0); sh = sh.map((x) => x / t); }
    const adj = o.clrL.map((v, j) => v * (j === iLIB ? kLIB : kL));
    const a = ilrMatrix([applyLanguageAdjustment(sh, pc, adj)])[0];
    return a.map((x, j) => x + 0.5 * o.RP[j]);
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
const KL = [0.5, 1, 1.5, 2, 2.5, 3];
for (const T of DATA) console.log(`  ${T.id} vote connu : ` + KL.map((k) => { const r = score(T, forecast(T, 0.5, k, T.nationalTarget)); return `κPLQ${k} ${r.rmse.toFixed(2)}/${r.correct}/${r.seatErr}`; }).join(" | "));
let tk = 0, tv = 0, tk0 = 0, tv0 = 0;
for (const [i, T] of DATA.entries()) {
  const train = DATA.filter((_, j) => j !== i);
  const kLIB = KL.reduce((b, k) => (train.reduce((s, Tr) => s + score(Tr, forecast(Tr, 0.5, k, Tr.nationalTarget)).rmse ** 2, 0) < train.reduce((s, Tr) => s + score(Tr, forecast(Tr, 0.5, b, Tr.nationalTarget)).rmse ** 2, 0) ? k : b), 0.5);
  const nat = nationalEve(T, { nDraws: 10 }).point;
  const k = score(T, forecast(T, 0.5, kLIB, T.nationalTarget)), k0 = score(T, forecast(T, 0.5, 0.5, T.nationalTarget));
  const v = score(T, forecast(T, 0.5, kLIB, nat)), v0 = score(T, forecast(T, 0.5, 0.5, nat));
  tk += k.seatErr; tv += v.seatErr; tk0 += k0.seatErr; tv0 += v0.seatErr;
  console.log(`  ${T.id} : κPLQ choisi ${kLIB} ; vote connu ${k.rmse.toFixed(2)}/${k.correct}/${k.seatErr} (commun ${k0.rmse.toFixed(2)}/${k0.correct}/${k0.seatErr}) ; veille ${v.seatErr} ${JSON.stringify(v.seats)} (commun ${v0.seatErr})`);
}
console.log(`  total sièges : vote connu ${tk} (commun ${tk0}) ; veille ${tv} (commun ${tv0})`);
