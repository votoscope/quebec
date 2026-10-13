/**
 * "Certains d'aller voter" (certain to vote) filter test.
 *
 * The 2026 post-mortem noted that Léger's "certains d'aller voter" filter
 * gave CAQ 14 (close to the actual 13.3%). This test extracts the
 * "certains d'aller voter" tables from the archived PDFs and compares
 * them with the top-line (decided voters) numbers.
 *
 * Finding: only 1 of the 6 Léger campaign PDFs (Oct 3) contains the
 * "certains d'aller voter" voting-intentions table (page 3/3). The other
 * 5 Léger PDFs and the Segma PDF do not have this breakdown.
 *
 * For the Oct 3 poll, the filter shifts support from PCQ to PQ
 * (PQ 29->31, PCQ 20->18), which makes the MAE WORSE against the actual
 * result (PQ 28.0, PCQ 20.7). CAQ is unchanged at 14% in both bases.
 *
 * Run: node js/tools/certain_voters_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";

const MAIN = ["PQ", "LIB", "PCQ", "CAQ", "QS"];

// Actual 2026 result
const ACTUAL = { PQ: 28.0189, LIB: 24.2157, PCQ: 20.6691, CAQ: 13.3453, QS: 12.4266 };

// Data extracted from PDFs (see data/raw/lus/*.pdf)
const POLLS = [
  {
    firm: "Léger",
    date: "2026-10-03",
    n: 1000,
    source: "Rapport intentions de vote - 3 octobre 2026.pdf, page 8 (3/3)",
    topLine: { PQ: 29, LIB: 25, PCQ: 20, CAQ: 14, QS: 11 }, // décidés n=892
    certains: { PQ: 31, LIB: 25, PCQ: 18, CAQ: 14, QS: 11 }, // certains d'aller voter n=804
  },
  {
    firm: "Segma",
    date: "2026-09-17",
    n: 5572,
    source: "segma_rapport_2026-09-17.pdf, pages 5-7",
    topLine: { PQ: 23, LIB: 16, PCQ: 14, CAQ: 18, QS: 10 }, // incluant indécis
    certains: null, // Segma n'a pas de table 'certains d'aller voter' séparée
    excludingUndecideds: { PQ: 29, LIB: 19, PCQ: 18, CAQ: 22, QS: 12 }, // excluant indécis n=4594
    notPlanningToVote: 3, // % qui ne prévoit pas aller voter
  },
];

const mae = (shares) => MAIN.reduce((s, p) => s + Math.abs((shares[p] ?? 0) - ACTUAL[p]), 0) / MAIN.length;

console.log("=== Test du filtre « certains d'aller voter » ===\n");
console.log("Résultat réel 2026:", JSON.stringify(Object.fromEntries(MAIN.map((p) => [p, ACTUAL[p].toFixed(1)]))), "\n");

for (const poll of POLLS) {
  console.log(`--- ${poll.firm} ${poll.date} (n=${poll.n}) ---`);
  console.log(`  Source: ${poll.source}\n`);

  console.log("  Base                    " + MAIN.map((p) => p.padStart(6)).join("") + "     MAE");
  console.log(`  ${"Top-line (décidés)".padEnd(24)}` + MAIN.map((p) => (poll.topLine[p] ?? 0).toFixed(0).padStart(6)).join("") + `  ${mae(poll.topLine).toFixed(2)} pp`);

  if (poll.certains) {
    console.log(`  ${"Certains d'aller voter".padEnd(24)}` + MAIN.map((p) => (poll.certains[p] ?? 0).toFixed(0).padStart(6)).join("") + `  ${mae(poll.certains).toFixed(2)} pp`);
    const diff = poll.certains.PQ - poll.topLine.PQ;
    console.log(`\n  Différence (certains - top-line): PQ ${diff > 0 ? "+" : ""}${diff}, PCQ ${poll.certains.PCQ - poll.topLine.PCQ > 0 ? "+" : ""}${poll.certains.PCQ - poll.topLine.PCQ}`);
  }

  if (poll.excludingUndecideds) {
    console.log(`  ${"Excluant indécis".padEnd(24)}` + MAIN.map((p) => (poll.excludingUndecideds[p] ?? 0).toFixed(0).padStart(6)).join("") + `  ${mae(poll.excludingUndecideds).toFixed(2)} pp`);
    console.log(`  (${poll.notPlanningToVote}% ne prévoit pas aller voter — pas de table « certains » séparée)`);
  }

  console.log(`  ${"RÉEL".padEnd(24)}` + MAIN.map((p) => ACTUAL[p].toFixed(1).padStart(6)).join("") + "   —");
  console.log();
}

// Verdict
console.log("=== Verdict ===\n");
console.log("1. Disponibilité des données:");
console.log("   - 1 seul PDF Léger (3 oct) contient la table « certains d'aller voter » (page 3/3)");
console.log("   - Les 5 autres PDFs Léger (31 août, 7 sept, 14 sept, 21 sept, 26 sept) n'ont PAS cette table");
console.log("   - Le PDF Segma a une structure différente (incluant/excluant indécis, pas de « certains »)");
console.log("   - Le TODO mentionnait 7 PDFs, mais seulement 1 contient réellement la table\n");

console.log("2. Qualité du filtre (Léger 3 oct, seul poll avec la table):");
const leger = POLLS[0];
const maeTop = mae(leger.topLine);
const maeCertain = mae(leger.certains);
console.log(`   - MAE top-line: ${maeTop.toFixed(2)} pp`);
console.log(`   - MAE certains d'aller voter: ${maeCertain.toFixed(2)} pp`);
console.log(`   - Le filtre DÉGRADE la MAE (+${(maeCertain - maeTop).toFixed(2)} pp)`);
console.log(`   - Le filtre décale PCQ -> PQ (PQ +2, PCQ -2), mais le réel était plus proche du top-line`);
console.log(`   - CAQ inchangé à 14% dans les deux bases (le post-mortem disait « exact », mais le top-line aussi donnait 14%)\n`);

console.log("3. Conclusion:");
if (maeCertain > maeTop) {
  console.log("   Le filtre « certains d'aller voter » ne améliore pas la précision sur le seul poll");
  console.log("   où la table est disponible. Avec n=1 poll, aucune conclusion statistique solide.");
  console.log("   La transcription prospective reste utile pour 2030 (plus de données), mais");
  console.log("   l ожидание d'amélioration n'est pas justifiée par les données 2026.");
} else {
  console.log("   Le filtre améliore la précision. À valider sur plus de sondages.");
}
