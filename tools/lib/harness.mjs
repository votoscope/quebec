/**
 * Module commun des harnais de validation (TODO, backlog 2026-10-07).
 *
 * Toute évaluation qui compte des sièges ou joint des élections entre elles
 * répète les mêmes opérations -- chargement des résultats, jointure du
 * scrutin 2026 aux élections précédentes, compte des gagnants, vérités
 * officielles. Ce module est l'endroit unique où ces conventions vivent.
 *
 * Conventions de clés (celles de la production) :
 *  - carte 2017 : les circonscriptions sont clés par NOM
 *    (qc_riding_results.json, boundary 2011/2017) ;
 *  - carte 2026 : clés par CODE NUMÉRIQUE (qc_riding_results.json
 *    contient déjà 2018|2026 et 2022|2026 ré-agrégés par sections de
 *    vote ; le DGEQ fournit numeroCirconscription). Le scrutin 2026 est
 *    donc ajouté en codes numériques, qui joignent directement les
 *    ré-agrégations ;
 *  - nameKey() : NFKD puis alphanumériques, pour jointurer des noms
 *    entre eux quand un outil traverse les deux cartes
 *    (features 2017 ↔ noms 2017), jamais pour les codes.
 *
 * sharesByRiding (src/ridingEffects.js) renvoie des VECTEURS dans l'ordre
 * de partyCodes (AUTRES en dernier) : les compteurs de sièges doivent
 * indexer par position, jamais par nom de parti.
 *
 * Usage : import depuis tools/*.mjs.
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { sharesByRiding, ilrMatrix, PARTIES } from "../../src/ridingEffects.js";

const { ilrInv } = mva.composition;

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

/**
 * Toutes les rangées de résultats : 2014/2018/2022 (cartes 2011/2017, noms),
 * 2018/2022 ré-agrégés sur la carte 2026 (codes) déjà dans
 * qc_riding_results.json, plus le scrutin 2026 (DGEQ, codes numériques).
 */
export function loadAllRows() {
  const results = load("../../data/qc_riding_results.json");
  const dgeq = load("../../data/raw/lus/2026-10-05-resultats-dgeq.json");

  const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };
  const rows2026 = [];
  for (const c of dgeq.circonscriptions) {
    for (const cand of c.candidats) {
      rows2026.push({
        election_date: "2026-10-05", boundary_year: "2026",
        riding_code: String(c.numeroCirconscription),
        party_code: MAP[cand.abreviationPartiPolitique] ?? "AUTRES",
        votes: cand.nbVoteTotal,
      });
    }
  }
  return [...results, ...rows2026];
}

// ---------------------------------------------------------------------------
// Jointure des noms
// ---------------------------------------------------------------------------

/** NFKD + alphanumériques, minuscules (production : byelections.js). */
export function nameKey(n) {
  return String(n ?? "").normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** features2026 code -> canonical name. */
export function nameByCode(features2026) {
  return new Map(features2026.filter((f) => f.riding_name).map((f) => [String(f.riding_code), f.riding_name]));
}

/** DGEQ name -> canonical features2026 spelling (null si inconnu). */
export function canonicalName(dgeqName, features2026) {
  const byKey = new Map(features2026.filter((f) => f.riding_name).map((f) => [nameKey(f.riding_name), f.riding_name]));
  return byKey.get(nameKey(dgeqName)) ?? null;
}

// ---------------------------------------------------------------------------
// État d'une élection (parts, ILR, niveaux centrés)
// ---------------------------------------------------------------------------

/**
 * Parts et ILR centrés par circonscription pour une élection.
 * sharesByRiding renvoie des VECTEURS dans l'ordre de partyCodes.
 */
export function electionState(rows, date, boundary, partyCodes = PARTIES) {
  const sh = sharesByRiding(rows, date, boundary, partyCodes);
  const keys = [...sh.keys()];
  const M = ilrMatrix(keys.map((k) => sh.get(k)));
  const k = M[0].length;
  const mean = Array.from({ length: k }, (_, j) => M.reduce((s, r) => s + r[j], 0) / M.length);
  return {
    keys,
    ilr: new Map(keys.map((key, i) => [key, M[i]])),
    levels: new Map(keys.map((key, i) => [key, M[i].map((v, j) => v - mean[j])])),
  };
}

// ---------------------------------------------------------------------------
// Sièges
// ---------------------------------------------------------------------------

/** Index du gagnant d'un vecteur de parts (AUTRES exclus). */
export function winnerOf(sharesArr) {
  let best = -1;
  for (let j = 0; j < sharesArr.length; j++) {
    if (sharesArr[j] === undefined) {
      throw new Error("winnerOf: vecteur de parts avec undefined (probable parts en objets au lieu de tableaux)");
    }
    if (PARTIES[j] === "AUTRES") continue;
    if (best === -1 || sharesArr[j] > sharesArr[best]) best = j;
  }
  return best === -1 ? 0 : best;
}

/** Sièges depuis des rangées ILR, avec garde contre le double comptage. */
export function seatsFromIlr(ilrRows, partyCodes = PARTIES) {
  const seats = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  const shares = ilrInv(ilrRows);
  shares.forEach((row) => { seats[partyCodes[winnerOf(row)]]++; });
  const total = Object.values(seats).reduce((a, b) => a + b, 0);
  if (total !== ilrRows.length) {
    throw new Error(`seatsFromIlr: ${total} sieges pour ${ilrRows.length} ridings (jointure de noms cassee)`);
  }
  return seats;
}

/** Sièges réels d'une élection depuis les rangées de résultats. */
export function seatsOf(rows, date, boundary, partyCodes = PARTIES) {
  return seatsFromIlr(ilrMatrix([...sharesByRiding(rows, date, boundary, partyCodes).values()]), partyCodes);
}

/** Erreur absolue de sièges entre deux décomptes. */
export function absSeatError(pred, actual, partyCodes = PARTIES) {
  return partyCodes.reduce((e, p) => e + Math.abs((pred?.[p] ?? 0) - (actual?.[p] ?? 0)), 0);
}

// ---------------------------------------------------------------------------
// Transitions et vérités officielles
// ---------------------------------------------------------------------------

export const TRANSITIONS = [
  { id: "T1", label: "2014->2018", map: "2017", base: ["2014-04-07", "2011"], target: ["2018-10-01", "2017"] },
  { id: "T2", label: "2018->2022", map: "2017", base: ["2018-10-01", "2017"], target: ["2022-10-03", "2017"] },
  { id: "T3", label: "2022->2026", map: "2026", base: ["2022-10-03", "2026"], target: ["2026-10-05", "2026"] },
];

/**
 * Swing provincial observé entre deux élections : la différence des moyennes
 * ILR inter-circonscriptions (les niveaux centrés s'annulent à zéro par
 * construction et ne portent aucune information provinciale).
 */
export function provincialDelta(baseState, targetState, partyCodes = PARTIES) {
  const dim = partyCodes.length - 1;
  const meanOf = (state) => {
    const out = new Array(dim).fill(0);
    let n = 0;
    for (const key of state.keys) {
      const row = state.ilr.get(key);
      for (let j = 0; j < dim; j++) out[j] += row[j];
      n++;
    }
    for (let j = 0; j < dim; j++) out[j] /= Math.max(n, 1);
    return out;
  };
  const b = meanOf(baseState);
  const t = meanOf(targetState);
  return t.map((v, j) => v - b[j]);
}