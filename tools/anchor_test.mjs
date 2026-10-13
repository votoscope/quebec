/**
 * Résultats officiels comme observations de la tendance nationale.
 *
 * À des points de contrôle suivant chaque élection générale (lendemain,
 * +30, +90, +180, +365 jours), la tendance est ajustée sur les sondages
 * connus à cette date, avec ou sans les résultats des élections passées
 * comme observations (variance relative au meilleur sondage : 1, 0,1, 0,01 ;
 * null = sans résultat, hypothèse nulle). Elle prédit ensuite chaque
 * sondage publié jusqu'au point de contrôle suivant ; erreur absolue
 * moyenne des parts des cinq partis principaux (points), PCQ exclu des
 * sondages qui ne le mesurent pas.
 *
 * Run: node js/tools/anchor_test.mjs   (from the repo root)
 */
import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { fitTrend, toX } from "../src/gpTrend.js";
import { pivotPolls } from "../src/compositional.js";
import { loadAllRows } from "./lib/harness.mjs";
const { ilrInv } = mva.composition;

const { polls, partyCodes } = pivotPolls(JSON.parse(readFileSync(new URL("../data/qc_national_polls.json", import.meta.url), "utf-8")));
const rows = loadAllRows();
const ELECTIONS = [["2014-04-07", "2011"], ["2018-10-01", "2017"], ["2022-10-03", "2017"], ["2026-10-05", "2026"]];
const MAIN = ["CAQ", "LIB", "PCQ", "PQ", "QS"];
const anchorsAll = ELECTIONS.map(([date, map]) => {
  const v = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  for (const r of rows) if (r.election_date === date && String(r.boundary_year) === map) v[partyCodes.includes(r.party_code) ? r.party_code : "AUTRES"] += r.votes;
  const t = Object.values(v).reduce((a, b) => a + b, 0);
  return { date, shares: Object.fromEntries(Object.entries(v).map(([p, x]) => [p, (100 * x) / t])) };
});
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const OFFSETS = [1, 30, 90, 180, 365, 545];
const VARIANTS = [null, 1, 0.1, 0.01];

const tot = Object.fromEntries(VARIANTS.map((v) => [String(v), { err: 0, n: 0 }]));
for (const [E] of ELECTIONS.slice(0, 3)) {
  for (let k = 0; k < OFFSETS.length - 1; k++) {
    const c = addDays(E, OFFSETS[k]), next = addDays(E, OFFSETS[k + 1]);
    const train = polls.filter((p) => p.pollDate <= c), test = polls.filter((p) => p.pollDate > c && p.pollDate <= next);
    if (!test.length || train.length < 5) continue;
    const anchors = anchorsAll.filter((a) => a.date <= c);
    const line = [];
    for (const v of VARIANTS) {
      const model = fitTrend(train, partyCodes, { anchors, anchorVar: v });
      const X = toX(model.t0, test.map((p) => p.pollDate));
      const means = model.gps.map((gp) => gp.predict(X));
      let err = 0, n = 0;
      test.forEach((p, i) => {
        const sh = ilrInv([means.map((m) => m[i])])[0];
        for (const party of MAIN) { const obs = p.shares[party]; if (obs == null) continue; err += Math.abs(100 * (sh[partyCodes.indexOf(party)] - obs)); n++; }
      });
      tot[String(v)].err += err; tot[String(v)].n += n;
      line.push(`${String(v).padEnd(4)} ${(err / n).toFixed(2)}`);
    }
    console.log(`${E} +${String(OFFSETS[k]).padEnd(3)} j (${test.length} sondages) : ${line.join(" | ")}`);
  }
}
console.log("TOTAL : " + VARIANTS.map((v) => `${v} ${(tot[String(v)].err / tot[String(v)].n).toFixed(3)}`).join(" | "));
console.log("Résultats : " + anchorsAll.map((a) => `${a.date} ${MAIN.map((p) => `${p} ${a.shares[p].toFixed(1)}`).join(" ")}`).join(" ; "));
