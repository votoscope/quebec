/**
 * Fiabilité des probabilités de victoire par circonscription (spécification
 * de production, vote provincial connu, chaque transition prédite avec le
 * bassin d'erreurs des deux autres, échelle de production) : fréquence réelle
 * de victoire par tranche de probabilité prédite, selon le rang prévu du parti.
 *
 * Run: node js/tools/reliability_diag.mjs   (from the repo root)
 */
import { readFileSync } from "node:fs";
import { buildData, drawShares, residualsOf, scaleResidual, pc, MAIN } from "./lib/transitionEval.mjs";
const scale = JSON.parse(readFileSync(new URL("../data/qc_residual_scale.json", import.meta.url), "utf-8")).scale;
const sv = pc.map((p) => scale[p] ?? 1);
const DATA = await buildData();
const means = (T) => T.obs.map((o) => o.a.map((x, j) => x + 0.5 * o.L[j] + 0.5 * o.RP[j]));
const BINS = [0, 0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98, 1.0001];
const acc = BINS.slice(1).map(() => ({ n: 0, p: 0, w: 0 }));
const byRank = [0, 1, 2].map(() => ({ n: 0, p: 0, w: 0 }));
for (const [i, T] of DATA.entries()) {
  const pool = DATA.filter((_, j) => j !== i).flatMap((Tr) => residualsOf(Tr, means(Tr))).map((e) => scaleResidual(e, sv));
  const m = means(T);
  const draws = drawShares(T, m, pool, { nDraws: 3000, seed: 3 });
  T.obs.forEach((o, k) => {
    const win = MAIN.reduce((b, p) => (o.yShares[pc.indexOf(p)] > o.yShares[pc.indexOf(b)] ? p : b), MAIN[0]);
    const counts = Object.fromEntries(MAIN.map((p) => [p, 0]));
    for (const d of draws) counts[MAIN.reduce((b, p) => (d[k][pc.indexOf(p)] > d[k][pc.indexOf(b)] ? p : b), MAIN[0])]++;
    const probs = MAIN.map((p) => [p, counts[p] / draws.length]).sort((a, b) => b[1] - a[1]);
    probs.forEach(([p, pr], rank) => {
      const b = BINS.findIndex((x, bi) => pr >= x && pr < BINS[bi + 1]);
      acc[b].n++; acc[b].p += pr; acc[b].w += p === win ? 1 : 0;
      if (rank < 3) { byRank[rank].n++; byRank[rank].p += pr; byRank[rank].w += p === win ? 1 : 0; }
    });
  });
}
console.log("tranche de probabilité prédite : n, probabilité moyenne, fréquence réelle");
acc.forEach((a, b) => a.n && console.log(`  [${BINS[b].toFixed(2)}, ${Math.min(1, BINS[b + 1]).toFixed(2)}) n=${a.n} prédit ${(a.p / a.n).toFixed(3)} réel ${(a.w / a.n).toFixed(3)}`));
console.log("par rang de probabilité dans la circonscription :");
byRank.forEach((a, r) => console.log(`  rang ${r + 1} : n=${a.n} prédit ${(a.p / a.n).toFixed(3)} réel ${(a.w / a.n).toFixed(3)}`));
