/**
 * Échelle du bassin de résidus de la simulation (écarts idiosyncrasiques
 * des circonscriptions), sans couche de déviation locale prédite.
 *
 * Pour chaque transition cible, la simulation de production
 * (simulateSeatCounts, 5 000 tirages) part de la baseline de l'élection
 * précédente, ancrée à la moyenne ILR inter-circonscriptions, vers le vote
 * provincial RÉEL (aucun choc national : seule la dispersion locale est
 * évaluée). Les résidus sont tirés de bassins d'écarts au swing
 * (residualIlr, centrés) d'AUTRES transitions : chacune seule, ou poolées,
 * éventuellement mis à l'échelle par un facteur s sur grille.
 *
 * Métriques : log-score et Brier des probabilités de victoire par
 * circonscription, PIT des sièges réels par parti (fraction des tirages
 * sous le réel + moitié des égalités).
 *
 * Run: node js/tools/residual_pool_test.mjs   (from the repo root)
 */

import { mva } from "@tangent.to/ds";
import { simulateSeatCounts } from "../src/simulate.js";
import { residualIlr, PARTIES } from "../src/ridingEffects.js";
import { loadAllRows, electionState, provincialDelta } from "./lib/harness.mjs";

const { ilrInv } = mva.composition;
const rows = loadAllRows();
const pc = PARTIES;
const MAIN = ["CAQ", "LIB", "PCQ", "PQ", "QS"];

const TR = {
  T1: ["2014-04-07", "2011", "2018-10-01", "2017"],
  T2: ["2018-10-01", "2017", "2022-10-03", "2017"],
  T3: ["2022-10-03", "2026", "2026-10-05", "2026"],
};
const POOL = Object.fromEntries(Object.entries(TR).map(([k, t]) => [k, residualIlr(rows, ...t, pc).Y]));
const sdOf = (Y) => Array.from({ length: Y[0].length }, (_, j) => Math.sqrt(Y.reduce((s, r) => s + r[j] ** 2, 0) / Y.length));
for (const [k, Y] of Object.entries(POOL)) console.log(`bassin ${k} : n=${Y.length}, é.-t. ILR [${sdOf(Y).map((v) => v.toFixed(3)).join(", ")}]`);

function run(targetKey, poolKeys, scale) {
  const [d0, b0, d1, b1] = TR[targetKey];
  const base = electionState(rows, d0, b0, pc), tgt = electionState(rows, d1, b1, pc);
  const shift = provincialDelta(base, tgt, pc);
  const meanIlr = Array.from({ length: pc.length - 1 }, (_, j) => base.keys.reduce((s, k) => s + base.ilr.get(k)[j], 0) / base.keys.length);
  const provBase = Object.fromEntries(pc.map((p, i) => [p, ilrInv([meanIlr])[0][i]]));
  const provTgt = ilrInv([meanIlr.map((v, j) => v + shift[j])])[0];
  const draws = Array.from({ length: 5000 }, () => Object.fromEntries(pc.map((p, i) => [p, provTgt[i]])));
  const baseline = new Map(base.keys.map((k) => [k, ilrInv([base.ilr.get(k)])[0]]));
  const residuals = poolKeys.flatMap((k) => POOL[k]).map((r) => r.map((v) => v * scale));
  const sim = simulateSeatCounts(baseline, provBase, draws, residuals, pc, { seed: 11, noEffectScale: 1 });

  // Vérité
  const truth = new Map();
  for (const r of rows) {
    if (r.election_date !== d1 || String(r.boundary_year) !== b1) continue;
    const p = pc.includes(r.party_code) ? r.party_code : "AUTRES";
    if (!truth.has(String(r.riding_code))) truth.set(String(r.riding_code), {});
    const v = truth.get(String(r.riding_code)); v[p] = (v[p] ?? 0) + r.votes;
  }
  const win = new Map([...truth].map(([c, v]) => [c, MAIN.reduce((b, p) => ((v[p] ?? 0) > (v[b] ?? 0) ? p : b), MAIN[0])]));
  let ls = 0, br = 0, n = 0;
  for (const [c, w] of win) {
    const wp = sim.winProbs[c]; if (!wp) continue; n++;
    ls += -Math.log(Math.max(wp[w] ?? 0, 1 / 5000));
    for (const p of MAIN) br += ((wp[p] ?? 0) - (p === w ? 1 : 0)) ** 2;
  }
  const seatsReal = Object.fromEntries(MAIN.map((p) => [p, 0]));
  for (const [c, w] of win) if (sim.winProbs[c]) seatsReal[w]++;
  const pit = MAIN.map((p) => {
    let below = 0, eq = 0;
    for (const d of sim.draws) { if (d[p] < seatsReal[p]) below++; else if (d[p] === seatsReal[p]) eq++; }
    return (below + eq / 2) / sim.draws.length;
  });
  return { ls: ls / n, br: br / n, pit, n };
}

const SCALES = [0.5, 0.75, 1, 1.25];
const DESIGN = { T2: [["T1"], ["T3"], ["T1", "T3"]], T3: [["T1"], ["T2"], ["T1", "T2"]] };
for (const [target, pools] of Object.entries(DESIGN)) {
  console.log(`\n=== cible ${target} (${TR[target][0].slice(0, 4)} -> ${TR[target][2].slice(0, 4)}) ===`);
  console.log(`  bassin     échelle  log-score  Brier   PIT ${MAIN.join("/")}`);
  for (const pool of pools) for (const s of SCALES) {
    const r = run(target, pool, s);
    console.log(`  ${pool.join("+").padEnd(9)}  ${s.toFixed(2)}     ${r.ls.toFixed(3)}     ${r.br.toFixed(3)}   ${r.pit.map((x) => x.toFixed(2)).join(" ")}`);
  }
}
