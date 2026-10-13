/**
 * Écrêtage des queues du bassin d'erreurs : chaque erreur (CLR des parties)
 * est bornée à ±c écarts-types de sa partie dans le bassin, c sur grille
 * (Infinity = bassin tel quel). Spécification de production (coefficients
 * de qc_language_swing.json, échelle de production), chaque transition prédite avec le
 * bassin des deux autres ; à vote connu et à la veille. Mesures : log-score
 * et Brier des gagnants, sièges du médoïde, fréquence réelle des probabilités
 * prédites entre 2 et 10 %.
 *
 * Run: node js/tools/winsor_test.mjs   (from the repo root)
 */
import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { buildData, drawShares, residualsOf, scaleResidual, evaluateDraws, nationalEve, pc } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const scale = JSON.parse(readFileSync(new URL("../data/qc_residual_scale.json", import.meta.url), "utf-8")).scale;
const sv = pc.map((p) => scale[p] ?? 1);
const DATA = await buildData();
const sw = JSON.parse(readFileSync(new URL("../data/qc_language_swing.json", import.meta.url), "utf-8"));
const means = (T) => T.obs.map((o) => o.a.map((x, j) => x + sw.kappa * o.L[j] + sw.kappaRegion * o.RP[j]));
const toClr = (e) => { const c = ilrInv([e])[0].map(Math.log); const m = c.reduce((a, b) => a + b, 0) / c.length; return c.map((x) => x - m); };
const fromClr = (z) => { const e = z.map(Math.exp); const t = e.reduce((a, b) => a + b, 0); return ilrMatrix([e.map((x) => x / t)])[0]; };
function winsorize(pool, c) {
  if (!Number.isFinite(c)) return pool;
  const Z = pool.map(toClr);
  const sd = Z[0].map((_, j) => Math.sqrt(Z.reduce((s, z) => s + z[j] ** 2, 0) / Z.length));
  return Z.map((z) => fromClr(z.map((x, j) => Math.max(-c * sd[j], Math.min(c * sd[j], x)))));
}
for (const national of ["connu", "veille"]) {
  console.log(`\n=== couche nationale : ${national} ===`);
  for (const c of (process.argv[2] ? process.argv[2].split(",").map(Number) : [Infinity, 3, 2.5, 2, 1.5])) {
    let ls = 0, br = 0, md = 0, pt = 0; const per = [];
    for (const [i, T] of DATA.entries()) {
      const pool = winsorize(DATA.filter((_, j) => j !== i).flatMap((Tr) => residualsOf(Tr, means(Tr))).map((e) => scaleResidual(e, sv)), c);
      const m = means(T);
      let r;
      if (national === "veille") {
        const nat = nationalEve(T, { nDraws: 3000 });
        r = evaluateDraws(T, drawShares(T, m, pool, { nDraws: 3000, seed: 3, targets: nat.draws }), { pointTarget: nat.point, means: m });
      } else r = evaluateDraws(T, drawShares(T, m, pool, { nDraws: 3000, seed: 3 }));
      ls += r.logScore; br += r.brier; md += r.medoid; pt += r.point; per.push(`${T.id} ls ${r.logScore.toFixed(3)} md ${r.medoid}`);
    }
    console.log(`  c=${c} : log ${ls.toFixed(3)} Brier ${br.toFixed(3)} point ${pt} médoïde ${md} | ${per.join(" | ")}`);
  }
}
