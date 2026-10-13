/**
 * Veilles archivées 2018, 2022 et 2026 (modèle allégé) : projeter la veille de chaque scrutin
 * avec les pieces de production et les conventions de validation, pour
 * etoffer le benchmark officiel (TODO, backlog 2026-10-07).
 *
 * Contrainte structurale, mesuree en construisant cet outil : le swing
 * uniforme CLR de production (uniformClrSwing) est multiplicatif en
 * espace log. Sur une baseline ou un parti n'a pas presente de candidat
 * (PCQ 2014 : 1 circonscription sur 124 ; PCQ 2018 : 12 sur 124), le
 * remplacement des zeros ((1/k)^2) puis le delta log provincial font
 * exploser la part du parti dans exactement les circonscriptions ou il
 * etait absent : swing 2018->resultat 2022 reel = PCQ 124/124. La
 * production 2026 n'est pas concernee (PCQ present partout, part minimale
 * 1,1 % sur la carte 2026). Les veilles utilisent donc le shift ILR
 * additif calcule sur la moyenne inter-circonscriptions (la convention de
 * l'arbitrage du 2026-10-06 et de tools/architecture_2030.mjs), qui
 * borne le mouvement : meme circonscription, PCQ 0 -> 10 % (reel 13 %).
 *
 * Composition de la veille :
 *   - nowcast : GP de tendance de production sur les sondages
 *     poll_date <= scrutin (aucune fuite) ;
 *   - swing : shift ILR additif de la baseline vers le nowcast ;
 *   - couches absentes, documentees : effets par circonscription (aucune
 *     transition anterieure a 2014->2018 ; la veille 2022 ne peut pas
 *     entraîner sur 2018->2022 sans fuite), ajustements de base (chefs,
 *     sortants, effet chef : intrants scopes 2026), sondages regionaux
 *     (serie ingeree 2026 seulement), partielles (aucune pre-2023), CAR
 *     et regions de simulation (carte 2026 seulement) ;
 *   - sigma industriel : estime sur les finales 2018+2022, fuite mineure
 *     constatee dans la sortie ;
 *   - simulation de production (simulateSeatCounts) pour les intervalles
 *     de sieges, en mode degrade (i.i.d., pas de choc regional). Le bassin
 *     de residus est celui des ECARTS AU SWING (residualIlr) des transitions
 *     anterieures a l'election visee : 2022 <- 2014->2018 ; 2026 <- 2014->2018
 *     et 2018->2022. Aucune transition anterieure n'existe pour 2018 : son
 *     bassin est 2018->2022 (fuite declaree, meta.residualPoolLeak). Les
 *     niveaux de la baseline ne sont PAS un bassin de residus : ils sont deja
 *     dans la baseline, les retirer au hasard double l'heterogeneite ;
 *   - 2026 : la couche nationale est celle de la veille PUBLIEE (vote
 *     projete de qc_projection_veille_2026-10-05.json, correction de
 *     participation incluse, 285 sondages) et les tirages du GP actuel sont
 *     recentres sur ce point. Refaire le nowcast avec le code actuel
 *     injecterait des choix poses apres le scrutin (retrait de la
 *     participation, base ILR AUTRES-dernier, sondages ingeres apres coup) :
 *     la comparaison avec le pipeline complet n'isolerait plus la couche
 *     spatiale. Pour 2018/2022, le GP courant est employe (la base ILR a ete
 *     choisie en regardant aussi ces veilles : fuite mineure).
 *
 * Run: node js/tools/veille_archive.mjs   (from the repo root)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { pivotPolls } from "../src/compositional.js";
import { fitTrend, predictTrend, sampleTrendDraws } from "../src/gpTrend.js";
import { ilrMatrix, residualIlr } from "../src/ridingEffects.js";
import { simulateSeatCounts, seatDistributions, medoidDraw } from "../src/simulate.js";
import { absSeatError, electionState, loadAllRows, provincialDelta, seatsOf } from "./lib/harness.mjs";

const { ilrInv } = mva.composition;

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const pollsAll = load("../data/qc_national_polls.json");
const ridingResults = loadAllRows();
const systemic = load("../data/qc_systemic.json");
const published2026 = load("../data/qc_projection_veille_2026-10-05.json");

// Swing departures of one transition (centred, ILR), production convention.
const T1 = ["2014-04-07", "2011", "2018-10-01", "2017"];
const T2 = ["2018-10-01", "2017", "2022-10-03", "2017"];

const ELECTIONS = [
  { label: "2018", date: "2018-10-01", map: "2017", baselineDate: "2014-04-07", baselineBoundary: "2011", pool: [T2], poolLeak: true },
  { label: "2022", date: "2022-10-03", map: "2017", baselineDate: "2018-10-01", baselineBoundary: "2017", pool: [T1], poolLeak: false },
  { label: "2026", date: "2026-10-05", map: "2026", baselineDate: "2022-10-03", baselineBoundary: "2026", truthBoundary: "2026", pool: [T1, T2], poolLeak: false, publishedNational: true },
];

console.log("=== Veilles archivées 2018/2022/2026 (nowcast GP + swing ILR additif) ===\n");

const summary = [];
for (const election of ELECTIONS) {
  const t0 = Date.now();

  // Nowcast: production trend GP on polls up to election day.
  const pollRows = pollsAll.filter((p) => p.poll_date <= election.date);
  const { polls, partyCodes } = pivotPolls(pollRows);
  const model = fitTrend(polls, partyCodes);
  const gpPoint = Object.fromEntries(
    partyCodes.map((p) => [p, predictTrend(model, election.date, { seed: 42 })[p].mean]),
  );
  // 2026: national layer of the published eve projection (vote share used
  // for the seats, turnout correction included).
  const forecastPoint = election.publishedNational
    ? Object.fromEntries(partyCodes.map((p) => [p, published2026.disproportion.voteShare[p] / 100]))
    : gpPoint;

  // Baseline state and additive ILR shift (harness conventions).
  const rows = ridingResults.filter(
    (r) => r.election_date === election.baselineDate && String(r.boundary_year) === String(election.baselineBoundary),
  );
  const baseState = electionState(rows, election.baselineDate, election.baselineBoundary, partyCodes);

  // The shift moves every riding from the baseline's cross-riding mean to
  // the nowcast: exactly the uniform additive swing in ILR space.
  const meanIlr = Array.from({ length: partyCodes.length - 1 }, (_, j) => {
    let s = 0; for (const key of baseState.keys) s += baseState.ilr.get(key)[j];
    return s / baseState.keys.length;
  });
  // The provincial swing is the national layer estimated by the GP: it is
  // NOT clamped. The +/-0.35 clamp of production applies to per-riding
  // PREDICTED departures (a different object); clamping the provincial
  // shift itself freezes an collapse mid-way (CAQ 65 seats in 2026 with a
  // 1.5-ILR drop needed) -- the architecture harness convention.
  const [fcstIlr] = ilrMatrix([partyCodes.map((p) => forecastPoint[p])]);
  const shift = fcstIlr.map((v, j) => v - meanIlr[j]);

  // Baseline shares per riding (vectors, sharesByRiding convention).
  const { sharesByRiding } = await import("../src/ridingEffects.js");
  const sh = sharesByRiding(rows, election.baselineDate, election.baselineBoundary, partyCodes);
  const baselineRows = baseState.keys.map((key) => sh.get(key));
  const baseIlr = ilrMatrix(baselineRows);
  const forecastShares = ilrInv(baseIlr.map((row) => row.map((v, j) => v + shift[j])));

  // Winners under the shifted composition.
  const pointCounts = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  forecastShares.forEach((row) => {
    let best = 0;
    for (let j = 1; j < row.length; j++) if (row[j] > row[best]) best = j;
    pointCounts[partyCodes[best]]++;
  });

  // Simulation: production simulateSeatCounts in its degraded mode. The
  // residual pool is the swing departures of the transitions listed in
  // election.pool (see header).
  const residuals = election.pool.flatMap((t) => residualIlr(ridingResults, ...t, partyCodes).Y);
  // GP posterior draws, recentred in ILR on forecastPoint (a no-op up to
  // Monte Carlo error when forecastPoint is the GP mean).
  const [gpIlr] = ilrMatrix([partyCodes.map((p) => gpPoint[p])]);
  const recentre = fcstIlr.map((v, j) => v - gpIlr[j]);
  const provinceDraws = sampleTrendDraws(model, election.date, 5000, 1).map((d) => {
    const [x] = ilrMatrix([partyCodes.map((p) => d[p] ?? 0)]);
    const [sh] = ilrInv([x.map((v, j) => v + recentre[j])]);
    return Object.fromEntries(partyCodes.map((p, i) => [p, sh[i]]));
  });
  // The baseline's provincial composition implied by the additive-shift
  // convention: the inverse ILR of the cross-riding mean ILR. The mean of
  // raw shares is NOT the right anchor: with a structurally absent party
  // (PCQ 2014 mean 0.02 %) its ILR is extreme, so the simulation's
  // delta would push that party by +4 ILR in every riding.
  const provMeanShare = ilrInv([meanIlr])[0];
  const provBaseline = Object.fromEntries(partyCodes.map((p, i) => [p, provMeanShare[i]]));
  const simulation = simulateSeatCounts(
    new Map(baseState.keys.map((key, i) => [key, baselineRows[i]])),
    provBaseline,
    provinceDraws,
    residuals,
    partyCodes,
    { seed: 1, systemic: {
      sigmaIndustry: systemic.sigma_industry,
      sigmaDaily2: systemic.sigma_daily2,
      daysToElection: 0,
    }, noEffectScale: 1 },
  );

  const actual = seatsOf(ridingResults, election.date, election.truthBoundary ?? election.map);
  const errPoint = absSeatError(pointCounts, actual, partyCodes);
  const medoidCounts = medoidDraw(simulation.draws, partyCodes);
  const errMedoid = absSeatError(medoidCounts, actual, partyCodes);

  const projection = {
    meta: {
      generatedAt: new Date().toISOString(),
      asOf: election.date,
      electionDate: election.date,
      nPolls: polls.length,
      nRidings: baseState.keys.length,
      variant: election.label === "2026" ? "veille-archive-leger" : "veille-archive",
      nationalLayer: election.publishedNational ? "veille publiee 2026-10-05" : "GP courant",
      residualPool: election.pool.map((t) => `${t[0].slice(0, 4)}->${t[2].slice(0, 4)}`),
      residualPoolLeak: election.poolLeak,
      note: "swing ILR additif (uniformClrSwing multiplicatif inapplicable: parti absent de la baseline; voir en-tete de tools/veille_archive.mjs)",
    },
    partyCodes,
    nowcast: forecastPoint,
    pointCounts,
    medoidCounts,
    seatDistributions: seatDistributions(simulation.draws, partyCodes),
    ridingWinProbs: simulation.winProbs,
    ridingForecast: Object.fromEntries(
      baseState.keys.map((key, i) => [key, {
        shares: Object.fromEntries(partyCodes.map((p, j) => [p, forecastShares[i][j]])),
        winner: partyCodes[forecastShares[i].indexOf(Math.max(...forecastShares[i]))],
      }]),
    ),
    totalSeats: simulation.totalSeats,
  };
  const file = election.label === "2026"
    ? "../data/qc_projection_veille_2026_leger.json"
    : `../data/qc_projection_veille_${election.label}.json`;
  writeFileSync(new URL(file, import.meta.url), JSON.stringify(projection), "utf-8");

  console.log(`--- Veille ${election.label} (${election.date}) ---`);
  console.log(`  ${polls.length} sondages, ${baseState.keys.length} circonscriptions, swing ILR additif`);
  console.log(`  Couche nationale : ${election.publishedNational ? "veille publiee" : "GP courant"} ; residus : ${residuals.length} ecarts au swing${election.poolLeak ? " (FUITE : transition posterieure)" : ""}`);
  console.log(`  Point     : ${JSON.stringify(pointCounts)}  erreur ${errPoint}`);
  console.log(`  Medoide   : ${JSON.stringify(medoidCounts)}  erreur ${errMedoid}`);
  console.log(`  Reel      : ${JSON.stringify(actual)}`);
  console.log(`  Ecrit     : ${file} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  summary.push({ label: election.label, errPoint, errMedoid });
}

console.log("=== Résumé (erreur absolue de sièges, veille) ===");
for (const s of summary) console.log(`  ${s.label}: point ${s.errPoint}, medoide ${s.errMedoid}`);