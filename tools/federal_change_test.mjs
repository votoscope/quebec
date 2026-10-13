/**
 * Variation du vote fédéral comme signal local : pour 2018 -> 2022, variation
 * 2019 -> 2021 ; pour 2022 -> 2026, variation 2021 -> 2025 (parts par
 * circonscription provinciale, js/data/qc_federal_shares.json). Variation
 * log-ratio (CLR des cinq formations fédérales), centrée sur les
 * circonscriptions, transposée au parti provincial correspondant (Bloc -> PQ,
 * PCC -> PCQ, PLC -> PLQ, NPD -> QS ; CAQ sans correspondant) et multipliée
 * par kF (0 = aucun effet). Base : langue 0,5, sondages régionaux 0,5, siège
 * ouvert 0,12. kF choisi sur une transition, évalué sur l'autre (aucune
 * variation fédérale antérieure à 2018 pour 2014 -> 2018).
 *
 * Run: node js/tools/federal_change_test.mjs   (from the repo root)
 */
import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { applyLanguageAdjustment, LANGUAGE_PARTIES } from "../src/languageSwing.js";
import { buildData, solveSwing, nationalEve, pc, MAIN } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const fed = JSON.parse(readFileSync(new URL("../data/qc_federal_shares.json", import.meta.url), "utf-8"));
const FP = ["BQ", "PLC", "PCC", "NPD", "AUTRES"];
const MAPF = { PQ: "BQ", PCQ: "PCC", LIB: "PLC", QS: "NPD" };
const clr = (v) => { const l = v.map((x) => Math.log(Math.max(x, 1e-4))); const m = l.reduce((a, b) => a + b, 0) / l.length; return l.map((x) => x - m); };
const DATA = (await buildData()).filter((T) => T.id !== "T1");
const YEARS = { T2: ["2019", "2021"], T3: ["2021", "2025"] };
for (const T of DATA) {
  const [y0, y1] = YEARS[T.id];
  const rows = T.obs.map((o) => { const a = fed[y0][T.map][o.key], b = fed[y1][T.map][o.key]; return a && b ? clr(FP.map((p) => b[p])).map((v, j) => v - clr(FP.map((p) => a[p]))[j]) : null; });
  const ok = rows.filter(Boolean);
  const mean = FP.map((_, j) => ok.reduce((s, r) => s + r[j], 0) / ok.length);
  T.obs.forEach((o, i) => { o.dF = rows[i] ? LANGUAGE_PARTIES.map((p) => (MAPF[p] ? rows[i][FP.indexOf(MAPF[p])] - mean[FP.indexOf(MAPF[p])] : 0)) : null; });
  console.log(`${T.id} : variation fédérale ${y0}->${y1} disponible pour ${ok.length}/${T.obs.length}`);
}
function forecast(T, kF, target) {
  const m = T.obs.map((o) => {
    let sh = [...o.prevShares];
    const prevWin = MAIN.reduce((b, p) => (o.prevShares[pc.indexOf(p)] > o.prevShares[pc.indexOf(b)] ? p : b), MAIN[0]);
    if (o.inc !== undefined && !(o.inc && o.inc.sameParty && o.inc.party === prevWin)) { sh = sh.map((x, j) => (pc[j] === prevWin ? x * Math.exp(-0.12) : x)); const t = sh.reduce((s, x) => s + x, 0); sh = sh.map((x) => x / t); }
    if (kF && o.dF) sh = applyLanguageAdjustment(sh, pc, o.dF.map((v) => kF * v));
    return ilrMatrix([sh])[0].map((x, j) => x + 0.5 * o.L[j] + 0.5 * o.RP[j]);
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
const KF = [0, 0.25, 0.5, 0.75, 1, 1.5];
for (const T of DATA) console.log(`  ${T.id} vote connu : ` + KF.map((k) => { const r = score(T, forecast(T, k, T.nationalTarget)); return `κF${k} ${r.rmse.toFixed(2)}/${r.correct}/${r.seatErr}`; }).join(" | "));
for (const [i, T] of DATA.entries()) {
  const O = DATA[1 - i];
  const kF = KF.reduce((b, k) => (score(O, forecast(O, k, O.nationalTarget)).rmse < score(O, forecast(O, b, O.nationalTarget)).rmse ? k : b), 0);
  const nat = nationalEve(T, { nDraws: 10 }).point;
  const k = score(T, forecast(T, kF, T.nationalTarget)), v = score(T, forecast(T, kF, nat)), v0 = score(T, forecast(T, 0, nat));
  console.log(`  ${T.id} : κF choisi sur ${O.id} = ${kF} ; vote connu ${k.rmse.toFixed(2)}/${k.correct}/${k.seatErr} ; veille ${v.seatErr} ${JSON.stringify(v.seats)} (sans ${v0.seatErr})`);
}
