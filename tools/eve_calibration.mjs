/**
 * Calibration de la projection de veille 2026 (fixtures du test golden) :
 * Brier et log-score des probabilités de victoire par circonscription, erreur
 * absolue de sièges du point et du médoïde, pour la production courante et
 * pour des variantes de couches. Ajustements partagés par cache.
 *
 * Run: node js/tools/eve_calibration.mjs   (from the repo root)
 */
import { computeProjection } from "../src/computeProjection.js";
import { loadFixtures, GOLDEN_AS_OF } from "../test/golden_lib.mjs";
import { loadAllRows } from "./lib/harness.mjs";

const data = loadFixtures(new URL("../test/fixtures/", import.meta.url));
const cache = {};
const rows = loadAllRows().filter((r) => r.election_date === "2026-10-05");
const v = {};
for (const r of rows) (v[r.riding_code] ??= {})[r.party_code] = (v[r.riding_code][r.party_code] ?? 0) + r.votes;
const MAIN = ["CAQ", "LIB", "PCQ", "PQ", "QS"];
const win = Object.fromEntries(Object.entries(v).map(([c, o]) => [c, MAIN.reduce((b, p) => ((o[p] ?? 0) > (o[b] ?? 0) ? p : b), MAIN[0])]));
const seats = Object.fromEntries(MAIN.map((p) => [p, Object.values(win).filter((w) => w === p).length]));

const VARIANTS = [
  ["production", {}],
  ["production sans échelle des résidus", {}, { residualScale: null }],
  ["production + régional", { regional: true }],
  ["origine (démographie + régional, sans langue)", { effects: true, regional: true, language: false, regionalPolls: false }, { residualScale: null }],
  ["production sans sondages régionaux", { regionalPolls: false }],
];
for (const [label, layers, patch = {}] of VARIANTS) {
  const t0 = Date.now();
  const pr = computeProjection({ ...data, ...patch }, { asOf: GOLDEN_AS_OF, layers, cache });
  let brier = 0, logs = 0, n = 0;
  for (const [c, w] of Object.entries(win)) {
    const wp = pr.ridingWinProbs[c]; if (!wp) continue; n++;
    for (const p of MAIN) brier += ((wp[p] ?? 0) - (p === w ? 1 : 0)) ** 2;
    logs += -Math.log(Math.max(wp[w] ?? 0, 1e-3));
  }
  const err = (o) => MAIN.reduce((s, p) => s + Math.abs((o[p] ?? 0) - seats[p]), 0);
  const strip = (o) => JSON.stringify(Object.fromEntries(MAIN.map((p) => [p, o[p] ?? 0])));
  console.log(`${label} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n   Brier ${(brier / n).toFixed(3)}  log-score ${(logs / n).toFixed(3)}  point ${err(pr.pointCounts)} ${strip(pr.pointCounts)}  médoïde ${err(pr.medoidCounts)} ${strip(pr.medoidCounts)}`);
}
console.log(`réel ${JSON.stringify(seats)}`);
