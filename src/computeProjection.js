/**
 * The full modelling pipeline, headless: poll trend GP, regional joint GP,
 * baseline adjustments (open seats, leader effects), riding-effects GP,
 * Monte Carlo seat simulation. Returns one plain serializable object.
 *
 * This used to run in the browser on every page load (~20s). It now runs
 * once, in Node, when the poll vigil detects new data (js/tools/compute.mjs
 * -> data/qc_projection.json), and the page only renders the result. Same
 * code, same library (@tangent.to/ds), different moment of execution -- the
 * page displays results instead of modelling.
 */

import { mva } from "@tangent.to/ds";
import { pivotPolls } from "./compositional.js";
import { fitTrend, predictTrendSeries, predictTrend, sampleTrendDraws } from "./gpTrend.js";
import {
  ridingBaselineFromRows,
  provinceShareFromRows,
  uniformClrSwing,
  normalizeRidingCode,
  applyOpenSeatPenalty,
  applyCompositionFactor,
} from "./swing.js";
import { simulateSeatCounts, seatDistributions, governmentScenarios, pivotPower, medoidDraw, scaleResiduals, winsorizeResiduals } from "./simulate.js";
import { fitRegionalTrend, REGIONS } from "./regionalTrend.js";
import { residualIlr, ilrMatrix } from "./ridingEffects.js";
import { trainRidingEffects, predictRidingEffects } from "./ridingProjection.js";
import { byelectionDeviations, blendByelectionEffects } from "./byelections.js";
// Cycle constants (election date, previous leaders) live in
// data/qc_cycles.json (RUNBOOK §4).
import { loadCycles } from "./cycles.js";
import { languageAdjustments, applyLanguageAdjustment, languageResiduals } from "./languageSwing.js";
import { regionalPollAdjustments } from "./regionalPollShift.js";

function applyEffectsToForecast(ridingForecast, effects, partyCodes) {
  if (!effects || effects.size === 0) return;
  const codes = [...ridingForecast.keys()].filter((c) => effects.has(String(c)));
  if (!codes.length) return;

  const shifted = ilrMatrix(codes.map((c) => partyCodes.map((p) => ridingForecast.get(c).shares[p])))
    .map((row, i) => {
      const eff = effects.get(String(codes[i]));
      return row.map((v, j) => v + Math.max(-0.35, Math.min(0.35, eff[j])));
    });
  const shares = mva.composition.ilrInv(shifted);
  codes.forEach((code, i) => {
    const entry = ridingForecast.get(code);
    partyCodes.forEach((p, j) => { entry.shares[p] = shares[i][j]; });
    entry.winner = partyCodes.reduce((best, p) => (entry.shares[p] > entry.shares[best] ? p : best), partyCodes[0]);
  });
}

/**
 * @param {Object} data every input JSON, keyed by short name
 * @param {Object} opts {asOf} -- defaults to today; {trendCorr} optional
 *        k-1 x k-1 correlation matrix for the national draws (see
 *        sampleTrendDraws) — null keeps the independent-coordinate draws;
 *        {effectsTransform} optional (Map) -> Map applied to the riding-
 *        effects before the by-election blend (test hook).
 * @returns serializable projection object
 */
export function computeProjection(data, {
  asOf = new Date().toISOString().slice(0, 10), trendCorr = null, effectsTransform = null,
  // Optional object reused across calls on the SAME data and asOf (ablations):
  // memoizes the national trend, regional trend and riding-effects fits.
  cache = null,
  // Test hooks (tools/layer_ablation.mjs): switch individual spatial layers
  // off, replace the national point, stop before the simulation.
  layers = {}, nationalPoint = null, pointOnly = false,
} = {}) {
  // Cycle constants (qc_cycles.json), or the cycle given with the data (the
  // golden test pins the 2026 cycle whatever the current one is).
  const cycle = data.cycle ?? loadCycles();
  const ELECTION_DATE = cycle.electionDate;
  const PREVIOUS_ELECTION_DATE = cycle.previousElectionDate;
  const LEADERS_PREVIOUS = cycle.leadersPrevious;
  const RESIDUAL_TRANSITIONS = cycle.residualTransitions ?? [];
  const L = { openSeat: true, leaders: true, regional: false, regionalPolls: true, language: true, effects: false, byelections: true, ...layers };
  const {
    pollRows, baselineRows, leaders, ridingResults, features2017, features2026,
    systemicParams, ridingRegions, incumbents, leaderEffect, regionalPollRows,
    byelectionRows = [], turnout = null,
    languageCrosstabs = null, languageComposition = null, languageSwing = null, residualScale = null,
  } = data;

  const { polls, partyCodes } = pivotPolls(pollRows);

  // Differential-turnout correction: polls describe the adult population,
  // seats are decided by the electorate, which skews older. Per party, the
  // topline is scaled by (sum_a wVote_a e^{g_pa}) / (sum_a wPop_a e^{g_pa}),
  // where g is the pooled 2026 age gradient (log band/topline) and wVote is
  // the population mix reweighted by official turnout; the ratio is
  // level-free, so it is one fixed factor per party. Validated on the 2022
  // final polls (tools/turnout_test.ts); parameters in qc_turnout.json.
  // Applied to the PROJECTION and the SIMULATION draws, never to the trend
  // series, which keeps describing opinion in the adult population.
  let turnoutFactor = null;
  if (turnout) {
    const wSum = turnout.wPop.reduce((a, b) => a + b, 0);
    const vRaw = turnout.wPop.map((w, a) => w * turnout.tau[a]);
    const vSum = vRaw.reduce((a, b) => a + b, 0);
    turnoutFactor = Object.fromEntries(partyCodes.map((p) => {
      const g = turnout.gradient[p] ?? turnout.bands.map(() => 0);
      let mixP = 0, mixV = 0;
      for (let a = 0; a < g.length; a++) {
        mixP += (turnout.wPop[a] / wSum) * Math.exp(g[a]);
        mixV += (vRaw[a] / vSum) * Math.exp(g[a]);
      }
      return [p, mixV / mixP];
    }));
  }
  const toElectorate = (shares) => {
    if (!turnoutFactor) return shares;
    const scaled = partyCodes.map((p) => (shares[p] ?? 0) * turnoutFactor[p]);
    const s = scaled.reduce((a, b) => a + b, 0);
    return Object.fromEntries(partyCodes.map((p, i) => [p, scaled[i] / s]));
  };

  const model = cache?.model ?? fitTrend(polls, partyCodes);
  if (cache) cache.model = model;
  const daysToElection = Math.max(0, (new Date(ELECTION_DATE) - new Date(asOf)) / 86_400_000);

  const provinceBaseline2022 = provinceShareFromRows(baselineRows, partyCodes);
  const ridingBaselineMap = ridingBaselineFromRows(baselineRows, partyCodes);

  // Two baselines: the ACTUAL 2022 result for display and win/hold
  // semantics, and the projection baseline carrying the open-seat / leader /
  // regional adjustments. See the individual sections for rationale.
  const projectionBaselineMap = new Map([...ridingBaselineMap].map(([k, v]) => [k, [...v]]));

  const codeByRidingName = new Map(
    features2026.filter((f) => f.riding_name).map((f) => [f.riding_name, normalizeRidingCode(f.riding_code)])
  );
  const openSeatCodes = new Set(
    incumbents.filter((r) => r.elected_with_note).map((r) => codeByRidingName.get(r.riding_name)).filter(Boolean)
  );
  if (L.openSeat) applyOpenSeatPenalty(projectionBaselineMap, openSeatCodes);

  // Leader effects: mean log excess per case type, general elections
  // 1976-2026 (tools/build_leader_effect.mjs -> qc_leader_effect.json).
  const dKey = `delta_${leaderEffect.target_year ?? 2026}`;
  const arriveeFactor = Math.exp(leaderEffect.effects.arrivee[dKey]);
  const continuationFactor = Math.exp(leaderEffect.effects.continuation[dKey]);
  const departFactor = Math.exp(leaderEffect.effects.depart[dKey]);
  const ridingOf2022Leader = new Map(LEADERS_PREVIOUS.map((l) => [l.party, l.riding]));
  const baselineWinner = (code) => {
    const shares = ridingBaselineMap.get(code);
    return shares ? partyCodes[shares.indexOf(Math.max(...shares))] : null;
  };
  const nameKey = (n) => String(n ?? "").normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const memberKeyByRiding = new Map(incumbents.map((r) => [r.riding_name, nameKey(r.member_name)]));

  // A party whose previous leader is gone and has no successor yet is a
  // departure case in the previous leader's riding, like any other.
  const leaderless = LEADERS_PREVIOUS
    .filter((l) => !leaders.some((x) => x.party_code === l.party))
    .map((l) => ({ party_code: l.party, leader_name: null, riding_name: null }));
  for (const leader of L.leaders ? [...leaders, ...leaderless] : []) {
    const party = leader.party_code;
    const partyIdx = partyCodes.indexOf(party);
    if (partyIdx < 0) continue;
    const prev = ridingOf2022Leader.get(party);
    const curr = leader.riding_name;

    if (curr === prev) {
      const code = codeByRidingName.get(curr);
      if (code) applyCompositionFactor(projectionBaselineMap, code, partyIdx, continuationFactor);
      continue;
    }
    if (curr) {
      const code = codeByRidingName.get(curr);
      const isOwnSeat = memberKeyByRiding.get(curr) === nameKey(leader.leader_name);
      if (code && !isOwnSeat) applyCompositionFactor(projectionBaselineMap, code, partyIdx, arriveeFactor);
    }
    if (prev) {
      const code = codeByRidingName.get(prev);
      const wonIt = baselineWinner(code) === party;
      const leaderGone = code && (openSeatCodes.has(code) || !wonIt);
      if (leaderGone) {
        const alreadyPenalized = openSeatCodes.has(code) && wonIt;
        applyCompositionFactor(
          projectionBaselineMap, code, partyIdx,
          alreadyPenalized ? departFactor * Math.exp(0.118) : departFactor
        );
      }
    }
  }

  // Regional joint GP: regional polls as observations of the same latent
  // object; per-riding adjustment = current regional deviation minus the
  // 2022 deviation already in the baseline. Validated on 2022 (MAE 3.06 vs
  // 3.61pp for uniform swing).
  let regionalInfo = null;
  let regionAdj = null; // region -> ILR vector of the adjustment applied below
  const regionByCode = new Map(ridingRegions.map((r) => [String(r.riding_code), r.region_code]));
  try {
    const w = { MTL: 0, QC: 0, REG: 0 };
    const votesByRegionParty = {};
    for (const r of baselineRows) {
      const reg = regionByCode.get(normalizeRidingCode(r.riding_code));
      if (!reg) continue;
      w[reg] += r.votes;
      votesByRegionParty[reg] ??= Object.fromEntries(partyCodes.map((p) => [p, 0]));
      const party = partyCodes.includes(r.party_code) ? r.party_code : "AUTRES";
      votesByRegionParty[reg][party] += r.votes;
    }
    const wTot = REGIONS.reduce((s, r) => s + w[r], 0);
    for (const r of REGIONS) w[r] /= wTot;

    const natHyper = model.gps.map((g) => g.chosenHyperparams);
    const regionalModel = cache?.regionalModel ?? fitRegionalTrend(polls, regionalPollRows, partyCodes, natHyper, w);
    if (cache) cache.regionalModel = regionalModel;
    if (L.regional && regionalModel.nRegionalPolls >= 3) {
      const devNow = regionalModel.predictDeviation(asOf);
      const regShares2022 = REGIONS.map((r) => {
        const v = votesByRegionParty[r];
        const tot = partyCodes.reduce((s, p) => s + v[p], 0);
        return partyCodes.map((p) => v[p] / tot);
      });
      const provShares2022 = partyCodes.map((p) => provinceBaseline2022[p]);
      const allIlr = ilrMatrix([...regShares2022, provShares2022]);
      const provIlr2022 = allIlr[allIlr.length - 1];

      // One adjustment vector per region: current regional deviation minus
      // the 2022 deviation already in the baseline. Kept per region (not
      // per riding) so the by-election signal can subtract exactly what the
      // regional block applies to every riding of that region.
      regionAdj = new Map(
        REGIONS.map((reg, ri) => [
          reg,
          devNow[reg].map((v, j) => v - (allIlr[ri][j] - provIlr2022[j])),
        ])
      );

      for (const [code, shares] of projectionBaselineMap) {
        const reg = regionByCode.get(String(code));
        if (!reg) continue;
        const adj = regionAdj.get(reg);
        const shifted = ilrMatrix([shares])[0].map((v, j) => v + adj[j]);
        projectionBaselineMap.set(code, mva.composition.ilrInv([shifted])[0]);
      }
      regionalInfo = { n: regionalModel.nRegionalPolls };
    }
  } catch (err) {
    console.error("[compute] regional trend failed, national swing only:", err.message);
  }

  // Swing by mother tongue measured in the polls (languageSwing.js):
  // francophone / non-francophone change since the previous election's
  // final polls, mixed by each riding's census language composition,
  // scaled by kappa (estimated on two transitions; kappa = 0 is no
  // adjustment). Applied to the projection baseline so the point forecast
  // and the simulation both carry it. When the regional block is active the
  // adjustment is centred within each region (no double count).
  let languageInfo = null;
  if (L.language && languageCrosstabs && languageComposition && languageSwing?.kappa) {
    const mapKeys = Object.keys(languageComposition).sort();
    const composition = languageComposition[ELECTION_DATE.slice(0, 4)] ?? languageComposition[mapKeys[mapKeys.length - 1]];
    const res = languageAdjustments(languageCrosstabs, composition, {
      previousYear: PREVIOUS_ELECTION_DATE.slice(0, 4), currentYear: ELECTION_DATE.slice(0, 4),
      asOf, kappa: languageSwing.kappa,
      // The regional block already sets each region's level from regional
      // polls; the language swing then carries only within-region structure.
      regionOf: regionAdj ? (c) => regionByCode.get(String(c)) ?? null : null,
    });
    if (res) {
      for (const [code, shares] of projectionBaselineMap) {
        const a = res.adj.get(String(code));
        if (a) projectionBaselineMap.set(code, applyLanguageAdjustment(shares, partyCodes, a));
      }
      languageInfo = { kappa: languageSwing.kappa, waves: res.waves };
    }
  }

  // Regional adjustment from the regional poll breakdowns of the cycle, all
  // firms, weighted by n * exp(-age / tau) on the campaign-dilated clock
  // (regionalPollShift.js): the poll region-minus-province deviation less the
  // same deviation in the previous results, scaled by kappaRegion (estimated
  // jointly with the language kappa on three transitions).
  let regionalPollInfo = null;
  if (L.regionalPolls && languageSwing?.kappaRegion) {
    const baselineVotes = new Map();
    for (const r of baselineRows) {
      const code = normalizeRidingCode(r.riding_code);
      baselineVotes.set(code, (baselineVotes.get(code) ?? 0) + r.votes);
    }
    const res = regionalPollAdjustments(regionalPollRows, ridingBaselineMap, baselineVotes, regionByCode, partyCodes, {
      asOf, kappa: languageSwing.kappaRegion, after: PREVIOUS_ELECTION_DATE,
      tau: languageSwing.regionDecay?.tau, dilation: languageSwing.regionDecay?.dilation, campaigns: cycle.campaigns ?? [],
    });
    if (res) {
      for (const [code, shares] of projectionBaselineMap) {
        const a = res.adj[regionByCode.get(String(code))];
        if (a) projectionBaselineMap.set(code, applyLanguageAdjustment(shares, partyCodes, a));
      }
      regionalPollInfo = { kappa: languageSwing.kappaRegion, nPolls: res.nPolls };
    }
  }

  const forecastPoint = nationalPoint ?? toElectorate(
    Object.fromEntries(partyCodes.map((p) => [p, predictTrend(model, asOf, { seed: 42 })[p].mean])),
  );
  const ridingForecast = uniformClrSwing(projectionBaselineMap, provinceBaseline2022, forecastPoint, partyCodes);

  // Riding-effects GP (Matérn) on demographic features, trained on 2017-map
  // transitions. OFF by default: it learns the demographics -> change
  // relation of past transitions, which does not transfer (three-transition
  // seat test, tools/architecture_2030.mjs; 2026 ablation,
  // tools/layer_ablation.mjs). Kept callable (layers.effects) for analysis.
  let effectsInfo = null, ridingEffects = new Map(), byelectionInfo = null;
  if (L.effects) {
    try {
      const trained = cache?.trained ?? trainRidingEffects(features2017, ridingResults, partyCodes);
      if (cache) cache.trained = trained;
      if (trained) {
        ridingEffects = predictRidingEffects(trained, features2026, ridingResults, partyCodes);
        effectsInfo = trained;
      }
    } catch (err) {
      console.error("[compute] riding-effects model failed, national swing only:", err.message);
    }
  }
  if (typeof effectsTransform === "function") ridingEffects = effectsTransform(ridingEffects);

  // By-election signal: each partielle since 2022 is a direct, recent
  // measurement of that riding's departure from the provincial swing.
  // Blended with shrinkage; the regional component is subtracted so it is
  // not counted twice (see byelections.js for the limits: low turnout,
  // protest dynamics, map mismatch, no historical validation -- lambda is a
  // documented prior, not a fitted parameter).
  if (L.byelections) {
    try {
      const { byCode } = byelectionDeviations({
        // Only the current cycle's by-elections: earlier ones are already in the
        // baseline (the previous general election's results).
        byRows: byelectionRows.filter((r) => !cycle.byelectionBounds || (String(r.election_date) > cycle.byelectionBounds.after && String(r.election_date) < cycle.byelectionBounds.before)),
        ridingResults, features2017, features2026,
        model, partyCodes, regionAdj, regionByCode,
      });
      if (byCode.size) {
        ridingEffects = blendByelectionEffects(ridingEffects, byCode);
        byelectionInfo = [...byCode.values()].map(({ name, date }) => ({ name, date }));
      }
    } catch (err) {
      console.error("[compute] by-election signal failed:", err.message);
    }
  }
  applyEffectsToForecast(ridingForecast, ridingEffects, partyCodes);

  if (pointOnly) {
    return {
      partyCodes,
      ridingForecast: Object.fromEntries([...ridingForecast].map(([code, e]) => [code, { shares: e.shares, winner: e.winner }])),
      regionAdj: regionAdj ? Object.fromEntries(regionAdj) : null,
    };
  }

  // Trend series for the chart.
  const dates = [];
  for (let d = new Date(polls[0].pollDate); d <= new Date(asOf); d.setDate(d.getDate() + 14)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  // The 14-day stride rarely lands on asOf itself; without this the curve
  // stops up to 13 days short of the nowcast the projection actually uses.
  if (dates[dates.length - 1] !== asOf) dates.push(asOf);
  const trendSeries = predictTrendSeries(model, dates, { nSamples: 300, seed: 1 });

  // Simulation.
  const provinceDraws = sampleTrendDraws(model, asOf, 5000, 1, { corr: trendCorr }).map(toElectorate);
  // Residual pool: the effects model's held-out errors when that layer is
  // on; otherwise the errors of the swing (+ language, when on) model on
  // every general-election transition before the current cycle, pooled
  // (qc_cycles.json residualTransitions; tools/hierarchical_test.mjs).
  const rawDepartures = effectsInfo ? null : (() => {
    const kappa = languageInfo ? languageSwing.kappa : 0;
    const parts = RESIDUAL_TRANSITIONS.map((t) => (kappa
      ? languageResiduals(ridingResults, t, partyCodes, languageCrosstabs, languageComposition, kappa)
      : residualIlr(ridingResults, ...t, partyCodes)));
    return { Y: parts.flatMap((r) => r.Y), ridings: parts.flatMap((r) => r.ridings) };
  })();
  // Per-party scale of the pool, estimated out of sample (qc_residual_scale.json).
  const residuals = effectsInfo?.modelResiduals
    ?? winsorizeResiduals(residualScale?.scale ? scaleResiduals(rawDepartures.Y, partyCodes, residualScale.scale) : rawDepartures.Y, residualScale?.clip ?? Infinity);
  const codeByName = new Map(features2026.filter((f) => f.riding_name).map((f) => [f.riding_name, String(f.riding_code)]));
  const residualRegions = (effectsInfo?.residualNames ?? rawDepartures.ridings).map((name) => {
    const code = codeByName.get(name);
    return code ? regionByCode.get(code) ?? null : null;
  });

  const simulation = simulateSeatCounts(
    projectionBaselineMap, provinceBaseline2022, provinceDraws, residuals, partyCodes,
    {
      seed: 1,
      ridingEffects,
      systemic: {
        sigmaIndustry: systemicParams.sigma_industry,
        sigmaDaily2: systemicParams.sigma_daily2,
        daysToElection,
      },
      regionByRiding: regionByCode,
      residualRegions,
      noEffectScale: effectsInfo?.noEffectScale ?? 1,
    }
  );

  const pointCounts = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  for (const entry of ridingForecast.values()) pointCounts[entry.winner]++;

  // Vote-vs-seat disproportion. Each draw i carries BOTH a national vote
  // composition and a seat allocation (same index by construction), so the
  // distortion of the electoral system is a joint distribution obtained for
  // free: per-party gaps (seat share minus vote share) and the Gallagher
  // least-squares index sqrt(1/2 sum (v-s)^2), summarised over draws. The
  // vote side is simulation.voteDraws -- the draw's composition INCLUDING
  // the common systemic shock its seats were computed under; pairing seats
  // with the raw provinceDraws mixed two different laws.
  const voteDraws = simulation.voteDraws ?? provinceDraws;
  const nDraws = Math.min(voteDraws.length, simulation.draws.length);
  const gallagherDraws = new Array(nDraws);
  const gapDraws = Object.fromEntries(partyCodes.map((p) => [p, new Array(nDraws)]));
  const voteMean = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  const seatMean = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  for (let i = 0; i < nDraws; i++) {
    let sq = 0;
    for (const p of partyCodes) {
      const v = (voteDraws[i][p] ?? 0) * 100;
      const s = ((simulation.draws[i][p] ?? 0) / simulation.totalSeats) * 100;
      sq += (v - s) ** 2;
      gapDraws[p][i] = s - v;
      voteMean[p] += v / nDraws;
      seatMean[p] += s / nDraws;
    }
    gallagherDraws[i] = Math.sqrt(sq / 2);
  }
  const q = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor((p / 100) * (s.length - 1))];
  };
  const disproportion = {
    voteShare: voteMean,
    seatShare: seatMean,
    gaps: Object.fromEntries(partyCodes.map((p) => [p, {
      p05: q(gapDraws[p], 5), p50: q(gapDraws[p], 50), p95: q(gapDraws[p], 95),
    }])),
    gallagher: { p05: q(gallagherDraws, 5), p50: q(gallagherDraws, 50), p95: q(gallagherDraws, 95) },
  };

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      asOf,
      electionDate: ELECTION_DATE,
      nPolls: polls.length,
      nRidings: ridingBaselineMap.size,
      effectsR2: effectsInfo ? effectsInfo.r2 : null,
      effectsCount: ridingEffects ? ridingEffects.size : 0,
      nRegionalPolls: regionalInfo ? regionalInfo.n : 0,
      languageSwing: languageInfo,
      regionalPolls: regionalPollInfo,
      turnoutFactor: turnoutFactor,
      nByelections: byelectionInfo ? byelectionInfo.length : 0,
      byelections: byelectionInfo ?? [],
      // Per-coordinate top ensemble member, exported so analysis tools
      // read the production reference instead of hand-copying it (the
      // production prediction marginalizes the grid; this is its top
      // cell, refreshed at every compute).
      trendHyper: model.gps.map((g) => g.chosenHyperparams ?? null),
    },
    partyCodes,
    trendSeries,
    ridingForecast: Object.fromEntries(
      [...ridingForecast].map(([code, e]) => [code, { shares: e.shares, winner: e.winner }])
    ),
    ridingBaseline2022: Object.fromEntries(
      [...ridingBaselineMap].map(([code, arr]) => [code, Object.fromEntries(partyCodes.map((p, i) => [p, arr[i]]))])
    ),
    seatDistributions: seatDistributions(simulation.draws, partyCodes),
    pointCounts,
    // The most TYPICAL joint scenario: the draw minimising mean L1 distance
    // to all others. Unlike per-party medians it is jointly coherent and
    // sums to the house size; unlike pointCounts it centres the simulated
    // OUTCOMES rather than the model inputs.
    medoidCounts: medoidDraw(simulation.draws, partyCodes),
    disproportion,
    // P(victory) per riding per party, tallied over the draws. Column sums
    // are exact expected seats, the one additive per-riding decomposition.
    ridingWinProbs: simulation.winProbs,
    totalSeats: simulation.totalSeats,
    scenarios: governmentScenarios(simulation.draws, simulation.totalSeats, partyCodes),
    pivotPower: pivotPower(simulation.draws, simulation.totalSeats, partyCodes),
  };
}
