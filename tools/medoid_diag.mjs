/**
 * Diagnostic de l'écart entre le point et le médoïde à la veille : pour chaque
 * élection, sièges au point (moyennes au point national de la tendance),
 * médoïde, médiane par parti des tirages, et composition nationale (point de
 * la tendance contre médiane des tirages nationaux, avec et sans choc
 * systémique). Spécification de production : langue 0,5, régions 0,5,
 * échelle des résidus de production.
 *
 * Run: node js/tools/medoid_diag.mjs   (from the repo root)
 */
import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { medoidDraw } from "../src/simulate.js";
import { buildData, solveSwing, nationalEve, drawShares, residualsOf, scaleResidual, pc, MAIN, K } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const scale = JSON.parse(readFileSync(new URL("../data/qc_residual_scale.json", import.meta.url), "utf-8")).scale;
const sv = pc.map((p) => scale[p] ?? 1);
const DATA = await buildData();
const means = (T) => T.obs.map((o) => o.a.map((x, j) => x + 0.5 * o.L[j] + 0.5 * o.RP[j]));
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
for (const [i, T] of DATA.entries()) {
  const train = DATA.filter((_, j) => j !== i);
  const pool = train.flatMap((Tr) => residualsOf(Tr, means(Tr))).map((e) => scaleResidual(e, sv));
  const nat = nationalEve(T, { nDraws: 2000 });
  const natNoShock = nationalEve(T, { nDraws: 2000, sigmaScale: 1e-9 });
  const m = means(T);
  const seatsOf = (sh) => { const s = Object.fromEntries(MAIN.map((p) => [p, 0])); sh.forEach((x) => { s[MAIN.reduce((b, p) => (x[pc.indexOf(p)] > x[pc.indexOf(b)] ? p : b), MAIN[0])]++; }); return s; };
  const sP = solveSwing(m.map((v, k) => ({ v, w: T.obs[k].w })), nat.point);
  const point = seatsOf(m.map((v) => ilrInv([v.map((x, j) => x + sP[j])])[0]));
  const draws = drawShares(T, m, pool, { nDraws: 2000, seed: 3, targets: nat.draws }).map(seatsOf);
  const drawsNoLocal = drawShares(T, m, [new Array(K).fill(0)], { nDraws: 2000, seed: 3, targets: nat.draws }).map(seatsOf);
  const actual = seatsOf(T.obs.map((o) => o.yShares));
  const err = (o) => MAIN.reduce((s, p) => s + Math.abs((o[p] ?? 0) - actual[p]), 0);
  const fmt = (o) => MAIN.map((p) => `${p}${o[p]}`).join(" ");
  const md = medoidDraw(draws, MAIN), mdN = medoidDraw(drawsNoLocal, MAIN);
  const medians = Object.fromEntries(MAIN.map((p) => [p, med(draws.map((d) => d[p]))]));
  console.log(`${T.id} réel ${fmt(actual)}`);
  console.log(`   point ${fmt(point)} (${err(point)}) | médoïde ${fmt(md)} (${err(md)}) | médianes ${fmt(medians)} | médoïde sans aléa local ${fmt(mdN)} (${err(mdN)})`);
  const pct = (v) => MAIN.map((p) => `${p} ${(v[pc.indexOf(p)] * 100).toFixed(1)}`).join(" ");
  const medShare = (ds) => pc.map((_, j) => med(ds.map((d) => d[j])));
  console.log(`   national : point ${pct(nat.point)} | médiane des tirages ${pct(medShare(nat.draws))} | sans choc ${pct(medShare(natNoShock.draws))}`);
}
