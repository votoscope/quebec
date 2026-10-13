/**
 * Données du cycle 2030 tirées des résultats officiels du 5 octobre 2026
 * (DGEQ, data/raw/lus/2026-10-05-resultats-dgeq.json) :
 *  - js/data/qc_2026_results_2026map.json : votes par circonscription et par
 *    parti (riding_code numérique, party_code, votes, election_date,
 *    boundary_year) ; sert de baseline du cycle et complète les résultats
 *    historiques pour le bassin de résidus (transition 2022 -> 2026) ;
 *  - js/data/qc_incumbents_2030.json : élus de 2026 (sortants du cycle), au
 *    format de qc_incumbents.json ; elected_with_note reste nul tant que
 *    personne n'a annoncé son départ ou changé de bannière.
 *
 * Run: node js/tools/build_cycle_2030.mjs   (from the repo root)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalName } from "./lib/harness.mjs";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const dgeq = load("../data/raw/lus/2026-10-05-resultats-dgeq.json");
const features2026 = load("../data/qc_riding_features_2026.json");
const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };

const rows = [], incumbents = [];
let unnamed = 0;
for (const c of dgeq.circonscriptions) {
  const code = String(c.numeroCirconscription);
  let best = null;
  for (const cand of c.candidats) {
    const party = MAP[cand.abreviationPartiPolitique] ?? `AUTRES:${cand.abreviationPartiPolitique}`;
    rows.push({ election_date: "2026-10-05", boundary_year: "2026", riding_code: code, party_code: party, votes: cand.nbVoteTotal });
    if (!best || cand.nbVoteTotal > best.nbVoteTotal) best = cand;
  }
  const name = canonicalName(c.nomCirconscription, features2026);
  if (!name) unnamed++;
  incumbents.push({
    riding_name: name ?? c.nomCirconscription,
    member_name: `${best.prenom} ${best.nom}`,
    current_party: MAP[best.abreviationPartiPolitique] ?? "AUTRES",
    elected_with_note: null,
  });
}
writeFileSync(new URL("../data/qc_2026_results_2026map.json", import.meta.url), JSON.stringify(rows));
writeFileSync(new URL("../data/qc_incumbents_2030.json", import.meta.url), JSON.stringify(incumbents, null, 1));
const seats = {}; for (const m of incumbents) seats[m.current_party] = (seats[m.current_party] ?? 0) + 1;
console.log(`${rows.length} lignes de résultats, ${incumbents.length} élus (${unnamed} noms non canoniques) ; sièges ${JSON.stringify(seats)}`);
