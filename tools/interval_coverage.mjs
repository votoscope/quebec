/**
 * Couverture des intervalles de sièges publiés (90 % : quantiles 5 et 95 des
 * tirages) à la veille des trois scrutins, spécification de production
 * (langue 0,5, régions 0,5, siège ouvert 0,12, échelle et écrêtage des
 * résidus de production, choc régional), chaque scrutin simulé avec le bassin
 * d'erreurs des deux autres. Rapporte, par parti, l'intervalle, le résultat
 * et sa position (quantile).
 *
 * Run: node js/tools/interval_coverage.mjs   (from the repo root)
 */
import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { winsorizeResiduals } from "../src/simulate.js";
import { buildData, drawShares, residualsOf, scaleResidual, nationalEve, pc, MAIN } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const rs = JSON.parse(readFileSync(new URL("../data/qc_residual_scale.json", import.meta.url), "utf-8"));
const sv = pc.map((p) => rs.scale[p] ?? 1);
const sw = JSON.parse(readFileSync(new URL("../data/qc_language_swing.json", import.meta.url), "utf-8"));
const DATA = await buildData();
const means = (T) => T.obs.map((o) => {
  let sh = [...o.prevShares];
  const prevWin = MAIN.reduce((b, p) => (o.prevShares[pc.indexOf(p)] > o.prevShares[pc.indexOf(b)] ? p : b), MAIN[0]);
  if (o.inc !== undefined && !(o.inc && o.inc.sameParty && o.inc.party === prevWin)) { sh = sh.map((x, j) => (pc[j] === prevWin ? x * Math.exp(-0.12) : x)); const t = sh.reduce((s, x) => s + x, 0); sh = sh.map((x) => x / t); }
  return ilrMatrix([sh])[0].map((x, j) => x + sw.kappa * o.L[j] + sw.kappaRegion * o.RP[j]);
});
let inside = 0, total = 0;
const qs = [];
for (const [i, T] of DATA.entries()) {
  const pool = winsorizeResiduals(DATA.filter((_, j) => j !== i).flatMap((Tr) => residualsOf(Tr, means(Tr))).map((e) => scaleResidual(e, sv)), rs.clip ?? Infinity);
  const nat = nationalEve(T, { nDraws: 4000 });
  const draws = drawShares(T, means(T), pool, { nDraws: 4000, seed: 3, targets: nat.draws });
  const seats = draws.map((d) => { const s = Object.fromEntries(MAIN.map((p) => [p, 0])); d.forEach((x) => { s[MAIN.reduce((b, p) => (x[pc.indexOf(p)] > x[pc.indexOf(b)] ? p : b), MAIN[0])]++; }); return s; });
  const actual = Object.fromEntries(MAIN.map((p) => [p, 0]));
  T.obs.forEach((o) => { actual[MAIN.reduce((b, p) => (o.yShares[pc.indexOf(p)] > o.yShares[pc.indexOf(b)] ? p : b), MAIN[0])]++; });
  const parts = [];
  for (const p of MAIN) {
    const v = seats.map((s) => s[p]).sort((a, b) => a - b);
    const lo = v[Math.floor(0.05 * (v.length - 1))], hi = v[Math.floor(0.95 * (v.length - 1))];
    const q = (v.filter((x) => x < actual[p]).length + v.filter((x) => x === actual[p]).length / 2) / v.length;
    const ok = actual[p] >= lo && actual[p] <= hi;
    if (actual[p] > 0 || hi > 0) { total++; if (ok) inside++; qs.push(q); }
    parts.push(`${p} [${lo}-${hi}] réel ${actual[p]} q${q.toFixed(2)}${ok ? "" : " HORS"}`);
  }
  console.log(`${T.id} (${T.y1}) : ${parts.join(" | ")}`);
}
console.log(`couverture des intervalles à 90 % : ${inside}/${total} (${((100 * inside) / total).toFixed(0)} %) ; quantiles du réel : ${qs.map((q) => q.toFixed(2)).join(" ")}`);
