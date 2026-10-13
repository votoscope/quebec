/**
 * Notoriété des candidats (vues Wikipédia des 60 jours précédant le scrutin,
 * tools/wiki_notability.mjs) comme covariable locale, à vote provincial connu.
 *
 * Pour chaque circonscription, z_p = log(1 + vues du candidat du parti p),
 * centré sur la moyenne des cinq candidats principaux ; la part prévue du parti
 * est multipliée par exp(beta * z_p centré) avant le swing (beta = 0 : aucun
 * effet). Spécification de base : langue (0,5), sondages régionaux (0,5),
 * pénalité de siège ouvert (gamma, 0 ou 0,1). beta choisi sur deux
 * transitions (RMSE des parts), évalué sur la troisième ; candidats connus
 * pour 2018, 2022 et 2026, donc trois transitions.
 *
 * Run: node js/tools/notability_test.mjs   (from the repo root)
 */
import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { buildData, solveSwing, nationalEve, pc, MAIN } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const wiki = JSON.parse(readFileSync(new URL("../data/qc_candidate_wiki.json", import.meta.url), "utf-8"));
const DATA = await buildData();
const YEAR = { T1: "2018", T2: "2022", T3: "2026" };
for (const T of DATA) {
  const by = new Map();
  for (const c of wiki[YEAR[T.id]]) { if (!MAIN.includes(c.party)) continue; (by.get(c.riding) ?? by.set(c.riding, {}).get(c.riding))[c.party] = Math.log1p(c.views60); }
  let n = 0;
  for (const o of T.obs) {
    const z = by.get(o.key);
    if (!z) { o.zNot = null; continue; }
    const vals = MAIN.map((p) => z[p] ?? 0); const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    o.zNot = Object.fromEntries(MAIN.map((p, k) => [p, vals[k] - m])); n++;
  }
  console.log(`${T.id} : notoriété disponible pour ${n}/${T.obs.length} circonscriptions`);
}
function forecast(T, beta, gamma, target) {
  const m = T.obs.map((o) => {
    let sh = [...o.prevShares];
    const prevWin = MAIN.reduce((b, p) => (o.prevShares[pc.indexOf(p)] > o.prevShares[pc.indexOf(b)] ? p : b), MAIN[0]);
    if (gamma && o.inc !== undefined && !(o.inc && o.inc.sameParty && o.inc.party === prevWin)) sh = sh.map((x, j) => (pc[j] === prevWin ? x * Math.exp(-gamma) : x));
    if (beta && o.zNot) sh = sh.map((x, j) => (o.zNot[pc[j]] !== undefined ? x * Math.exp(beta * o.zNot[pc[j]]) : x));
    const t = sh.reduce((s, x) => s + x, 0);
    const a = ilrMatrix([sh.map((x) => Math.max(x / t, 1e-6))])[0];
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
const BETAS = [0, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1];
for (const gamma of [0, 0.1]) {
  console.log(`\n=== pénalité de siège ouvert γ=${gamma} ===`);
  for (const T of DATA) console.log(`  ${T.id} vote connu : ` + BETAS.map((b) => { const r = score(T, forecast(T, b, gamma, T.nationalTarget)); return `β${b} ${r.rmse.toFixed(2)}/${r.correct}/${r.seatErr}`; }).join(" | "));
  let tk = 0, tv = 0, tv0 = 0;
  for (const [i, T] of DATA.entries()) {
    const train = DATA.filter((_, j) => j !== i);
    const sse = (b) => train.reduce((s, Tr) => s + score(Tr, forecast(Tr, b, gamma, Tr.nationalTarget)).rmse ** 2, 0);
    const beta = BETAS.reduce((b, x) => (sse(x) < sse(b) ? x : b), 0);
    const k = score(T, forecast(T, beta, gamma, T.nationalTarget)), k0 = score(T, forecast(T, 0, gamma, T.nationalTarget));
    const nat = nationalEve(T, { nDraws: 10 }).point;
    const v = score(T, forecast(T, beta, gamma, nat)), v0 = score(T, forecast(T, 0, gamma, nat));
    tk += k.seatErr; tv += v.seatErr; tv0 += v0.seatErr;
    console.log(`  ${T.id} : β choisi ${beta} ; vote connu ${k.rmse.toFixed(2)}/${k.correct}/${k.seatErr} (β0 ${k0.rmse.toFixed(2)}/${k0.correct}/${k0.seatErr}) ; veille ${v.seatErr} ${JSON.stringify(v.seats)} (β0 ${v0.seatErr})`);
  }
  console.log(`  total sièges : vote connu ${tk} ; veille ${tv} (sans notoriété ${tv0})`);
}
