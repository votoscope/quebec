/**
 * Erreur moyenne de la référence (swing + langue, vote provincial connu) selon
 * le rang prévu du parti dans la circonscription, par transition : test d'une
 * consolidation locale (vote stratégique) que le swing uniforme ignore.
 *
 * Run: node js/tools/rank_bias_check.mjs   (from the repo root)
 */
import { mva } from "@tangent.to/ds";
import { buildData, solveSwing, pc, MAIN } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const DATA = await buildData();
for (const T of DATA) {
  const means = T.obs.map((o) => o.a.map((x, j) => x + o.L[j]));
  const s = solveSwing(means.map((v, i) => ({ v, w: T.obs[i].w })), T.nationalTarget);
  const acc = Array.from({ length: 5 }, () => ({ n: 0, err: 0, fc: 0 }));
  for (const [i, o] of T.obs.entries()) {
    const f = ilrInv([means[i].map((x, j) => x + s[j])])[0];
    const order = MAIN.map((p) => [p, f[pc.indexOf(p)]]).sort((a, b) => b[1] - a[1]);
    order.forEach(([p, v], rank) => { const j = pc.indexOf(p); acc[rank].n++; acc[rank].err += (o.yShares[j] - v) * 100; acc[rank].fc += v * 100; });
  }
  console.log(`${T.id} ${T.y0}->${T.y1} : erreur moyenne (réel - prévu, pp) par rang prévu : ` + acc.map((a, r) => `${r + 1}e ${(a.err / a.n).toFixed(2)} (prévu ${(a.fc / a.n).toFixed(1)})`).join("  "));
}
