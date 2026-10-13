/**
 * Erreur au point à la veille (tendance GP ajustée sur les sondages
 * antérieurs au scrutin) de spécifications de la couche par circonscription,
 * sur les trois élections : sièges du gagnant de la part prévue.
 *
 * Run: node js/tools/eve_point_check.mjs   (from the repo root)
 */
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { buildData, solveSwing, nationalEve, pc, MAIN } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const DATA = await buildData();
const SPECS = [
  ["report pur", { kL: 0, kR: 0, g: 0 }],
  ["langue", { kL: 1, kR: 0, g: 0 }],
  ["langue + régions + siège ouvert", { kL: 0.5, kR: 0.5, g: 0.1 }],
];
const tot = Object.fromEntries(SPECS.map(([l]) => [l, 0]));
for (const T of DATA) {
  const nat = nationalEve(T, { nDraws: 10 });
  const actual = Object.fromEntries(MAIN.map((p) => [p, 0]));
  for (const o of T.obs) actual[MAIN.reduce((b, p) => (o.yShares[pc.indexOf(p)] > o.yShares[pc.indexOf(b)] ? p : b), MAIN[0])]++;
  const line = [];
  for (const [label, { kL, kR, g }] of SPECS) {
    const m = T.obs.map((o) => {
      let a = o.a;
      const prevWin = MAIN.reduce((b, p) => (o.prevShares[pc.indexOf(p)] > o.prevShares[pc.indexOf(b)] ? p : b), MAIN[0]);
      if (g && o.inc !== undefined && !(o.inc && o.inc.sameParty && o.inc.party === prevWin)) {
        const sh = o.prevShares.map((x, j) => (pc[j] === prevWin ? x * Math.exp(-g) : x)); const t = sh.reduce((s, x) => s + x, 0);
        a = ilrMatrix([sh.map((x) => x / t)])[0];
      }
      return a.map((x, j) => x + kL * o.L[j] + kR * o.RP[j]);
    });
    const s = solveSwing(m.map((v, i) => ({ v, w: T.obs[i].w })), nat.point);
    const seats = Object.fromEntries(MAIN.map((p) => [p, 0]));
    m.forEach((v) => { const sh = ilrInv([v.map((x, j) => x + s[j])])[0]; seats[MAIN.reduce((b, p) => (sh[pc.indexOf(p)] > sh[pc.indexOf(b)] ? p : b), MAIN[0])]++; });
    const err = MAIN.reduce((s2, p) => s2 + Math.abs(seats[p] - actual[p]), 0);
    tot[label] += err;
    line.push(`${label} ${err} ${JSON.stringify(seats)}`);
  }
  console.log(`${T.id} (${T.y1}) réel ${JSON.stringify(actual)} ; nowcast ${MAIN.map((p) => `${p} ${(nat.point[pc.indexOf(p)] * 100).toFixed(1)}`).join(" ")}\n   ${line.join("\n   ")}`);
}
console.log("total :", JSON.stringify(tot));
