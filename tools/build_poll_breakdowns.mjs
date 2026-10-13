/**
 * Ventilations de veille toutes firmes (jeu figé
 * ../data/prive/ventilations_regionales_qc.json, hors dépôt : firme, date de milieu de terrain,
 * effectif, parts par groupe), regroupées par élection : sondages du cycle
 * (après l'élection précédente, avant le scrutin), moyenne pondérée par
 * n * exp(-âge / tau) sur l'horloge dilatée, comme en production
 * (src/regionalPollShift.js ; tau, dilation : qc_language_swing.json
 * regionDecay). Groupes : total, rMTL (RMR de
 * Montréal), rQC (RMR de Québec), rREG (reste du Québec), franco, nonfranco.
 *
 * Sortie : ../data/prive/qc_poll_breakdowns.json (hors dépôt)
 *   { "2018": { window, polls: [...], groups: { total: {n, shares}, ... } }, ... }
 *
 * Run: node js/tools/build_poll_breakdowns.mjs   (from the repo root)
 */
import { readFileSync, writeFileSync } from "node:fs";
const raw = JSON.parse(readFileSync(new URL("../../data/prive/ventilations_regionales_qc.json", import.meta.url), "utf-8"));
const ELECTIONS = { 2018: "2018-10-01", 2022: "2022-10-03", 2026: "2026-10-05" };
const PREVIOUS = { 2018: "2014-04-07", 2022: "2018-10-01", 2026: "2022-10-03" };
const { tau, dilation } = JSON.parse(readFileSync(new URL("../data/qc_language_swing.json", import.meta.url), "utf-8")).regionDecay;
const CAMPAIGNS = JSON.parse(readFileSync(new URL("../data/qc_cycles.json", import.meta.url), "utf-8")).campaigns;
const day = (d) => Date.parse(d) / 86_400_000;
const campaignDays = (t) => CAMPAIGNS.reduce((c, [a, b]) => c + Math.max(0, Math.min(t, day(b)) - day(a)), 0);
const GROUPS = { total: "Quebec", rMTL: "Montreal CMA", rQC: "Quebec City CMA", rREG: "Rest of Quebec", franco: "Francophones", nonfranco: "Non francophones" };
const PARTY = { CAQ: "CAQ", LIB: "LIB", PLQ: "LIB", QS: "QS", PQ: "PQ", CPQ: "PCQ", PCQ: "PCQ" };
const out = {};
for (const [year, date] of Object.entries(ELECTIONS)) {
  const from = PREVIOUS[year];
  const tNow = day(date), cNow = campaignDays(tNow);
  const polls = raw.filter((r) => r.midDate && r.midDate > from && r.midDate < date && r.n)
    .map((r) => ({ ...r, wt: r.n * Math.exp(-((tNow - day(r.midDate)) + (dilation - 1) * (cNow - campaignDays(day(r.midDate)))) / tau) }));
  const groups = {};
  for (const [key, title] of Object.entries(GROUPS)) {
    const acc = { CAQ: 0, LIB: 0, PCQ: 0, PQ: 0, QS: 0, AUTRES: 0 }; let N = 0; const used = [];
    for (const r of polls) {
      const g = r.groups[title]; if (!g) continue;
      const sh = { CAQ: 0, LIB: 0, PCQ: 0, PQ: 0, QS: 0, AUTRES: 0 };
      for (const [p, v] of Object.entries(g)) sh[PARTY[p] ?? "AUTRES"] += v;
      const main = sh.CAQ + sh.LIB + sh.PCQ + sh.PQ + sh.QS;
      if (sh.AUTRES === 0) sh.AUTRES = Math.max(0, 100 - main);
      for (const p of Object.keys(acc)) acc[p] += r.wt * sh[p];
      N += r.wt; used.push(`${r.firm} ${r.midDate}`);
    }
    if (N) groups[key] = { n: N, polls: used.length, shares: Object.fromEntries(Object.entries(acc).map(([p, v]) => [p, +(v / N).toFixed(2)])) };
  }
  out[year] = { window: [from, date], polls: polls.map((r) => ({ firm: r.firm, midDate: r.midDate, n: r.n })), groups };
  console.log(`${year} : ${polls.length} sondages dans la fenêtre ; groupes ${Object.entries(groups).map(([k, g]) => `${k}(${g.polls})`).join(" ")}`);
}
writeFileSync(new URL("../../data/prive/qc_poll_breakdowns.json", import.meta.url), JSON.stringify(out, null, 1));
