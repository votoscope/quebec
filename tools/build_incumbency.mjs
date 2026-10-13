/**
 * Députés sortants qui se représentent, par transition : 2018 -> 2022 (carte
 * 2017, candidats de candidate_notability exportés dans
 * js/data/qc_candidates_2018_2022.json) et 2022 -> 2026 (gagnants 2022 sur la
 * carte 2017, candidats 2026 du DGEQ sur la carte 2026). Le gagnant est le
 * candidat du parti arrivé premier ; il « se représente » si son nom
 * (nameKey de « Nom Prénom ») figure parmi les candidats de l'élection
 * suivante, n'importe où sur la carte.
 *
 * 2014 -> 2018 : élus de 2014 (js/data/qc_mna_elected_2014.json, Wikipédia)
 * contre candidats de 2018 ; noms appariés sur l'ensemble des mots
 * normalisés (« Prénom Nom » contre « Nom Prénom »).
 *
 * Sortie : js/data/qc_incumbency.json
 *   { T1: {riding: ...}, T2: {riding: {party, sameParty}}, T3: {code: {party, sameParty}} }
 *
 * Run: node js/tools/build_incumbency.mjs   (from the repo root)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { nameKey } from "./lib/harness.mjs";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const cands = load("../data/qc_candidates_2018_2022.json");
const results = load("../data/qc_riding_results.json");
const dgeq = load("../data/raw/lus/2026-10-05-resultats-dgeq.json");
const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };

function winners(date) {
  const v = {};
  for (const r of results) if (r.election_date === date && String(r.boundary_year) === "2017") (v[r.riding_code] ??= {})[r.party_code] = r.votes;
  return Object.fromEntries(Object.entries(v).map(([k, o]) => [k, Object.entries(o).sort((a, b) => b[1] - a[1])[0][0]]));
}
function winnerNames(date) {
  const w = winners(date), out = {};
  for (const c of cands) if (c.d === date && w[c.riding_name] === c.party_code) out[c.riding_name] = { name: nameKey(c.candidate_name), party: c.party_code };
  return out;
}
const out = { T1: {}, T2: {}, T3: {} };
// 2014 -> 2018 : mots normalisés, ordre indifférent.
const wordsKey = (n) => String(n).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join(" ");
const mna14 = load("../data/qc_mna_elected_2014.json").members;
const next18 = new Map(cands.filter((c) => c.d === "2018-10-01").map((c) => [wordsKey(c.candidate_name), c]));
for (const m of mna14) {
  const c = next18.get(wordsKey(m.name));
  if (c) out.T1[c.riding_name] = { party: c.party_code, sameParty: c.party_code === m.party, previousParty: m.party };
}
// 2018 -> 2022 (même carte)
const w18 = winnerNames("2018-10-01");
const next22 = new Map(cands.filter((c) => c.d === "2022-10-03").map((c) => [nameKey(c.candidate_name), c]));
for (const [riding, w] of Object.entries(w18)) {
  const c = next22.get(w.name);
  if (c && c.riding_name === riding) out.T2[riding] = { party: c.party_code, sameParty: c.party_code === w.party, previousParty: w.party };
}
// 2022 -> 2026 (carte 2026)
const w22 = winnerNames("2022-10-03");
const next26 = new Map();
for (const circ of dgeq.circonscriptions) for (const c of circ.candidats) next26.set(nameKey(`${c.nom} ${c.prenom}`), { code: String(circ.numeroCirconscription), party: MAP[c.abreviationPartiPolitique] ?? "AUTRES" });
for (const w of Object.values(w22)) {
  const c = next26.get(w.name);
  if (c) out.T3[c.code] = { party: c.party, sameParty: c.party === w.party, previousParty: w.party };
}
writeFileSync(new URL("../data/qc_incumbency.json", import.meta.url), JSON.stringify(out, null, 1));
const summ = (o) => { const v = Object.values(o); return `${v.length} sortants se représentent, ${v.filter((x) => x.sameParty).length} sous la même bannière`; };
console.log(`2014->2018 : 125 élus ; ${summ(out.T1)}`);
console.log(`2018->2022 : ${Object.keys(w18).length} gagnants identifiés ; ${summ(out.T2)}`);
console.log(`2022->2026 : ${Object.keys(w22).length} gagnants identifiés ; ${summ(out.T3)}`);
