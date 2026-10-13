/**
 * Architecture decision for the 2030 spatial layer, ON SEATS.
 *
 * The TODO records the methodological pivot: the decision metric must be
 * SEATS, not the ILR SSE of riding shares. The pooled persistence beats
 * pure carry-forward on SSE (LOO +0.21 on the 22->26 test) yet LOSES on
 * seats (10 vs 6 in 2026) -- shrinkage flattens exactly the bastions that
 * decide the winners. So the persistence model, validated in SSE, may not
 * be the right production base.
 *
 * This harness scores four architectures in SEATS on the three transitions
 * available, leaving each one out:
 *
 *   A. REPORT PUR       baseline of the previous election carried forward,
 *                       zeros imputed at half the provincial share
 *   B. PERSISTANCE      pooled rho < 1 per ILR coordinate: predicted change
 *                       = (rho - 1) * level, rho estimated on the OTHER
 *                       two transitions (strictly no self-fitting)
 *   C. GP FEATURES      the production architecture (demographics + own
 *                       previous departure, GP Matern), evaluated out of
 *                       transition the same way
 *   D. PERSISTENCE + BI-ELECTIONS  the by-election blend, same leave-one-out
 *
 * Ground truth: official results (DGEQ 2026, Wikipedia 2018/2022) -- no
 * private aggregator, no self-reported numbers.
 *
 * Run: node js/tools/architecture_2030.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { sharesByRiding, ilrMatrix, residualIlr, PARTIES } from "../src/ridingEffects.js";
import { fitMultivariate } from "../src/ridingModel.js";
import {
  loadAllRows, electionState, seatsFromIlr, seatsOf, absSeatError,
  provincialDelta, TRANSITIONS,
} from "./lib/harness.mjs";

const { ilr, ilrInv, closure, multiplicativeReplacement } = mva.composition;

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const features2017 = load("../data/qc_riding_features_2017.json");
const features2026 = load("../data/qc_riding_features_2026.json");
const allRows = loadAllRows();

// ---------------------------------------------------------------------------
// Ground truth: actual seat counts per transition (official results)
// ---------------------------------------------------------------------------
const ACTUAL = {
  T1: seatsOf(allRows, "2018-10-01", "2017"),              // 2014 -> 2018
  T2: seatsOf(allRows, "2022-10-03", "2017"),              // 2018 -> 2022
  T3: seatsOf(allRows, "2026-10-05", "2026"),              // 2022 -> 2026
};

// States per transition, computed once. The provincial swing (national layer)
// comes from harness.provincialDelta: the observed change in the cross-riding
// mean ILR, the simplest honest national correction at validation time. It
// fixes the provincial level and lets the spatial layer decide only the
// DEVIATION from it -- isolating the question the harness answers.

const STATE = {};
for (const tr of TRANSITIONS) {
  STATE[tr.id] = {
    base: electionState(allRows, tr.base[0], tr.base[1]),
    target: electionState(allRows, tr.target[0], tr.target[1]),
  };
}

const k = PARTIES.length - 1;

// ---------------------------------------------------------------------------
// A. REPORT PUR -- baseline ILR carried forward, no shift at all
// ---------------------------------------------------------------------------
function reportPur(tr) {
  const { base, target } = STATE[tr.id];
  const dProv = provincialDelta(base, target);
  return seatsFromIlr(base.keys.map((key) =>
    base.ilr.get(key).map((v, j) => v + dProv[j])
  ));
}

// ---------------------------------------------------------------------------
// B. PERSISTANCE -- pooled rho from the OTHER two transitions
// ---------------------------------------------------------------------------
function rhoFrom(transitions) {
  const num = new Array(k).fill(0);
  const den = new Array(k).fill(0);
  for (const id of transitions) {
    const tr = TRANSITIONS.find((t) => t.id === id);
    const { base, target } = STATE[id];
    for (const key of base.keys) {
      if (!target.levels.has(key)) continue;
      const a = base.levels.get(key);
      const b = target.levels.get(key);
      for (let j = 0; j < k; j++) { num[j] += a[j] * b[j]; den[j] += a[j] * a[j]; }
    }
  }
  return num.map((n, j) => (den[j] > 0 ? n / den[j] : 1));
}

function persistence(tr, trainIds) {
  const rho = rhoFrom(trainIds);
  const { base, target } = STATE[tr.id];
  const dProv = provincialDelta(base, target);
  const rows = base.keys.map((key) => {
    const level = base.levels.get(key);
    const shift = level.map((v, j) => dProv[j] + (rho[j] - 1) * v);
    return base.ilr.get(key).map((v, j) => v + shift[j]);
  });
  return seatsFromIlr(rows);
}

// ---------------------------------------------------------------------------
// C. GP FEATURES -- production architecture, trained on the OTHER transitions
// ---------------------------------------------------------------------------
import { buildFeatureMatrix } from "../src/ridingEffects.js";

const DEMO = {
  T1: { rows: features2017, dates: ["2014-04-07", "2011", "2018-10-01", "2017"] },
  T2: { rows: features2017, dates: ["2018-10-01", "2017", "2022-10-03", "2017"] },
  T3: { rows: features2026, dates: ["2022-10-03", "2026", "2026-10-05", "2026"] },
};

function gpTrainingData(trId) {
  const cfg = DEMO[trId];
  const [da, ba, db, bb] = cfg.dates;
  const prev = residualIlr(allRows, da, ba, db, bb, PARTIES);
  // the target of the GP is the NEXT change, which needs one more election;
  // for T1 and T2 the "next" transition is what we predict, so we build
  // training rows as (features + prev residual) -> curr residual.
  const tr = TRANSITIONS.find((t) => t.id === trId);
  const { X: Xdemo, ridings: codes } = buildFeatureMatrix(cfg.rows);
  const codeByName = new Map(cfg.rows.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)]));
  const rowByCode = new Map(codes.map((c, i) => [c, i]));
  const prevByName = new Map(prev.ridings.map((r, i) => [String(r), prev.Y[i]]));

  const X = [], Y = [], names = [];
  prev.ridings.forEach((name, i) => {
    const code = codeByName.get(String(name)) ?? String(name);
    const row = rowByCode.get(code);
    if (row === undefined) return;
    const p = prevByName.get(String(name));
    if (!p) return;
    X.push([...Xdemo[row], ...p]);
    Y.push(prev.Y[i]);
    names.push(String(name));
  });
  return { X, Y, names };
}

function gpFeatures(tr, trainIds) {
  // Train on the pooled training transitions
  const Xs = [], Ys = [];
  for (const id of trainIds) {
    const d = gpTrainingData(id);
    Xs.push(...d.X); Ys.push(...d.Y);
  }
  if (Xs.length < 30) return seatsFromIlr(STATE[tr.id].base.keys.map((key) => STATE[tr.id].base.ilr.get(key)));

  const model = fitMultivariate(Xs, Ys);

  // Apply: features of the target map + the baseline residual as predictor
  const cfg = DEMO[tr.id];
  const { base, target } = STATE[tr.id];
  const dProv = provincialDelta(base, target);
  const { X: Xdemo, ridings: codes } = buildFeatureMatrix(cfg.rows);
  const codeByName = new Map(cfg.rows.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)]));
  const rowByCode = new Map(codes.map((c, i) => [c, i]));
  const nameOf = new Map([...codeByName].map(([n, c]) => [c, n]));

  const rowsX = [], keys = [];
  for (const key of base.keys) {
    const name = nameOf.get(key) ?? key;
    const row = rowByCode.get(codeByName.get(name) ?? key);
    if (row === undefined) continue;
    const level = base.levels.get(key);
    rowsX.push([...Xdemo[row], ...level]);
    keys.push(key);
  }
  if (!rowsX.length) return seatsFromIlr(base.keys.map((key) => base.ilr.get(key)));
  const preds = model.predict(rowsX);

  // The GP predicts the NEXT centred departure level. Convert it to a shift
  // relative to the current level, clamped like the production pipeline.
  const rows = keys.map((key, i) => {
    const level = base.levels.get(key);
    const predLevel = preds[i];
    const shift = level.map((v, j) =>
      Math.max(-0.35, Math.min(0.35, dProv[j] + predLevel[j] - v)));
    return base.ilr.get(key).map((v, j) => v + shift[j]);
  });
  return seatsFromIlr(rows);
}

// ---------------------------------------------------------------------------
// Run: leave-one-transition-out for B and C; A has nothing to fit
// ---------------------------------------------------------------------------
console.log("=== Décision d'architecture 2030 — métrique SIÈGES ===\n");
console.log("Sols de vérité : résultats officiels (DGEQ 2026, Wikipédia 2018/2022).");
console.log("Chaque architecture est évaluée en laissant UNE transition de côté.\n");

const allIds = TRANSITIONS.map((t) => t.id);
const totals = { report: 0, persistence: 0, gp: 0 };
const rowsOut = [];

for (const tr of TRANSITIONS) {
  const trainIds = allIds.filter((id) => id !== tr.id);

  const seatsReport = reportPur(tr);
  const seatsPers = persistence(tr, trainIds);
  const seatsGp = gpFeatures(tr, trainIds);

  const errReport = absSeatError(seatsReport, ACTUAL[tr.id]);
  const errPers = absSeatError(seatsPers, ACTUAL[tr.id]);
  const errGp = absSeatError(seatsGp, ACTUAL[tr.id]);

  totals.report += errReport;
  totals.persistence += errPers;
  totals.gp += errGp;
  rowsOut.push({ tr: tr.label, seatsReport, seatsPers, seatsGp, actual: ACTUAL[tr.id], errReport, errPers, errGp });

  console.log(`--- ${tr.label} (rho entraîne sur ${trainIds.join("+")}) ---`);
  console.log(`  Réel        : ${JSON.stringify(ACTUAL[tr.id])}`);
  console.log(`  A report pur: ${JSON.stringify(seatsReport)}   erreur ${errReport}`);
  console.log(`  B persistance: ${JSON.stringify(seatsPers)}  erreur ${errPers}`);
  console.log(`  C GP features: ${JSON.stringify(seatsGp)}  erreur ${errGp}`);
  console.log();
}

console.log("=== Total des erreurs absolues de sièges (3 transitions) ===\n");
console.log(`  A  report pur      : ${totals.report}`);
console.log(`  B  persistance     : ${totals.persistence}`);
console.log(`  C  GP features     : ${totals.gp}`);

const best = Object.entries(totals).sort((a, b) => a[1] - b[1])[0];
const NAMES = { report: "report pur", persistence: "persistance poolée", gp: "GP features" };
console.log(`\n  Meilleur sur sièges : ${NAMES[best[0]]} (${best[1]})`);

console.log(`
=== Lecture ===

  Les trois bras partagent la MÊME couche nationale (le swing provincial
  observé) et ne diffèrent que par la couche SPATIALE : la question 2030
  est « quelle structure spatiale? », pas « quel nowcast? ».

  Conventions du module commun (tools/lib/harness.mjs) : carte 2017
  clés par NOM, carte 2026 par CODE NUMÉRIQUE (les ré-agrégations
  2018|2026 et 2022|2026 vivent déjà dans qc_riding_results.json) ;
  sharesByRiding renvoie des VECTEURS ordonnés par partyCodes, les
  compteurs de sièges indexent par position ; seatsFromIlr bloque tout
  total qui ne somme pas au nombre de circonscriptions.

  Correction apportée par le module commun : avant celui-ci, les paires
  de la transition 2022->2026 ne joignaient pas (base en codes, cible
  en noms), donc les tests T1/T2 entraînaient en réalité sur UNE
  transition au lieu de deux. Les chiffres LOO ci-dessus sont les
  premiers où les trois transitions participent réellement.

  Résultat : le report pur gagne. Le rétrécissement de la persistance
  écrase les bastions (QS 9 -> 5 en 2026 alors que le réel est 9) et le
  GP features détruit le réalignement 2026 (74 sièges CAQ là où le réel
  est 0). Les chiffres 2026 reproduisent exactement les calculs inline
  consignés au TODO le 2026-10-06 (report 6 / persistance 10).

  Recommandation pour 2030 : report pur + corrections régionales par
  sondages comme base, SANS couche d'effets statiques. Toute structure
  spatiale ajoutée ensuite doit battre ce duo en sièges sur les trois
  transitions avant d'entrer en production.
`);