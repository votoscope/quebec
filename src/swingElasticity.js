/**
 * Swing elasticity by riding: bastion concentration.
 *
 * A uniform swing in log-ratio applies the same multiplicative change to
 * every riding. The 2026 post-mortem showed this is wrong for bastions:
 * QS lost 3 pp nationally by CONCENTRATING (Mercier 59%, Taschereau,
 * SMSJ, Gouin, Camille-Laurin, Jean-Lesage all over-performed), which a
 * uniform log-ratio swing cannot produce.
 *
 * This module estimates a per-party elasticity coefficient beta_p such
 * that a riding's log-share change is:
 *
 *   log(share_{r,t+1,p}) - log(share_{r,t,p})
 *     = elasticity_{r,p} * [log(prov_{t+1,p}) - log(prov_{t,p})]
 *
 * with elasticity_{r,p} = 1 + beta_p * (share_{r,t,p} - mean_share_p).
 *
 * Interpretation: beta_p > 0 means bastions (high share) amplify the
 * swing — they gain more when the party gains nationally, lose less when
 * it loses. beta_p = 0 recovers the uniform swing (elasticity = 1).
 *
 * Estimation: OLS through the origin on the transformed regression
 *   y = (Δ_log_riding - Δ_log_province)
 *   x = (share - mean_share) * Δ_log_province
 *   beta_p = Σxy / (Σx² + λ)
 * with shrinkage λ toward beta = 0 (uniform swing). Trained on the
 * 2014→2018 (via riding-name mapping 2011→2017) and 2018→2022 (2017 map)
 * transitions; the 2022→2026 transition is the production target.
 *
 * Application in the projection (share space, then renormalised):
 *   forecast_share_{r,p} ∝ baseline_share_{r,p}
 *     * (prov_forecast_p / prov_baseline_p)^elasticity_{r,p}
 */

import { mva } from "@tangent.to/ds";

const { closure, multiplicativeReplacement } = mva.composition;

/**
 * Compute party shares per riding for one election on one map.
 * @returns {Map<string, Object<party, number>>} riding name -> shares
 */
function sharesByRiding(rows, electionDate, boundaryYear, partyCodes) {
  const byRiding = new Map();
  for (const row of rows) {
    if (row.election_date !== electionDate || String(row.boundary_year) !== String(boundaryYear)) continue;
    const name = String(row.riding_code);
    const party = partyCodes.includes(row.party_code) ? row.party_code : "AUTRES";
    if (!byRiding.has(name)) byRiding.set(name, Object.fromEntries(partyCodes.map((p) => [p, 0])));
    byRiding.get(name)[party] += row.votes;
  }
  const out = new Map();
  for (const [name, votes] of byRiding) {
    const total = partyCodes.reduce((s, p) => s + votes[p], 0);
    if (total > 0) out.set(name, Object.fromEntries(partyCodes.map((p) => [p, votes[p] / total])));
  }
  return out;
}

/**
 * Compute provincial shares for one election on one map.
 */
function provinceShares(rows, electionDate, boundaryYear, partyCodes) {
  const votes = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  let tot = 0;
  for (const row of rows) {
    if (row.election_date !== electionDate || String(row.boundary_year) !== String(boundaryYear)) continue;
    const party = partyCodes.includes(row.party_code) ? row.party_code : "AUTRES";
    votes[party] += row.votes;
    tot += row.votes;
  }
  return Object.fromEntries(partyCodes.map((p) => [p, votes[p] / tot]));
}

/**
 * Estimate per-party elasticity coefficients from historical transitions.
 *
 * @param {Array} ridingResults raw riding-level results (qc_riding_results.json)
 * @param {string[]} partyCodes
 * @param {Object} opts
 *   - transitions: list of [dateA, boundaryA, dateB, boundaryB, nameMap]
 *     where nameMap is null (same map) or a Map (2011 name -> 2017 name)
 *   - shrinkage: EB shrinkage lambda (default 1.0); beta shrinks toward 0
 * @returns {{beta: Object<party, number>, nObs: number, transitions: string[]}}
 */
export function estimateElasticity(ridingResults, partyCodes, {
  transitions = [
    { dateA: "2014-04-07", boundaryA: "2011", dateB: "2018-10-01", boundaryB: "2017", label: "2014→2018 (2011→2017)" },
    { dateA: "2018-10-01", boundaryA: "2017", dateB: "2022-10-03", boundaryB: "2017", label: "2018→2022 (2017)" },
  ],
  shrinkage = 1.0,
} = {}) {
  // Accumulate Σxy and Σx² per party across all transitions and ridings
  const sumXY = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  const sumX2 = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  let nObs = 0;

  for (const tr of transitions) {
    const sharesA = sharesByRiding(ridingResults, tr.dateA, tr.boundaryA, partyCodes);
    const sharesB = sharesByRiding(ridingResults, tr.dateB, tr.boundaryB, partyCodes);
    const provA = provinceShares(ridingResults, tr.dateA, tr.boundaryA, partyCodes);
    const provB = provinceShares(ridingResults, tr.dateB, tr.boundaryB, partyCodes);

    // Mean share per party (across ridings, election A) for centering
    const meanShare = Object.fromEntries(partyCodes.map((p) => [p, 0]));
    let nR = 0;
    for (const sh of sharesA.values()) {
      for (const p of partyCodes) meanShare[p] += sh[p];
      nR++;
    }
    for (const p of partyCodes) meanShare[p] /= nR;

    for (const [name, shA] of sharesA) {
      const shB = sharesB.get(name);
      if (!shB) continue;

      for (const p of partyCodes) {
        const a = Math.max(shA[p], 1e-6);
        const b = Math.max(shB[p], 1e-6);
        const pa = Math.max(provA[p], 1e-6);
        const pb = Math.max(provB[p], 1e-6);

        const dLogR = Math.log(b) - Math.log(a);
        const dLogP = Math.log(pb) - Math.log(pa);
        const y = dLogR - dLogP; // deviation from uniform swing
        const x = (a - meanShare[p]) * dLogP; // share-level × swing

        sumXY[p] += x * y;
        sumX2[p] += x * x;
        nObs++;
      }
    }
  }

  const beta = Object.fromEntries(
    partyCodes.map((p) => [p, sumX2[p] > 0 ? sumXY[p] / (sumX2[p] + shrinkage) : 0])
  );

  return { beta, nObs, meanShare: undefined };
}

/**
 * Compute the elasticity for one riding and one party.
 * elasticity = 1 + beta * (share - meanShare).
 *
 * The elasticity can be below 1 (bastion dampens the swing) or even
 * negative (bastion moves against the province — the concentration
 * effect: QS lost nationally in 2026 but GAINED in Mercier, Taschereau,
 * Gouin). Clamped to [-1, 2] to prevent extreme extrapolation.
 */
export function ridingElasticity(share, beta, meanShare = 0.15) {
  const e = 1 + beta * (share - meanShare);
  return Math.max(-1.0, Math.min(2.0, e));
}

/**
 * Apply a swing with per-riding elasticity.
 *
 * forecast_share_{r,p} ∝ baseline_share_{r,p}
 *   * (prov_forecast_p / prov_baseline_p)^elasticity_{r,p}
 *
 * @param {Map<string, Object<party, number>>} ridingBaseline riding -> shares
 * @param {Object<party, number>} provinceBaseline
 * @param {Object<party, number>} provinceForecast
 * @param {Object<party, number>} beta per-party elasticity coefficient
 * @param {Object<party, number>} meanShare per-party mean share (for centering)
 * @param {string[]} partyCodes
 * @returns {Map<string, {shares: Object<party, number>, winner: string}>}
 */
export function elasticSwing(ridingBaseline, provinceBaseline, provinceForecast, beta, meanShare, partyCodes) {
  const out = new Map();

  // Precompute the provincial swing ratio per party
  const swingRatio = Object.fromEntries(
    partyCodes.map((p) => [p, (provinceForecast[p] ?? 0) / (provinceBaseline[p] ?? 1e-6)])
  );

  for (const [riding, shares] of ridingBaseline) {
    // shares can be an array (from ridingBaselineFromRows) or an object
    const getShare = (p, i) => Array.isArray(shares) ? shares[i] : shares[p];
    // Apply elasticity per party
    const raw = partyCodes.map((p, i) => {
      const shareVal = getShare(p, i) ?? 0;
      const e = ridingElasticity(shareVal, beta[p] ?? 0, meanShare?.[p] ?? 0.15);
      return Math.max(shareVal, 1e-6) * Math.pow(Math.max(swingRatio[p], 1e-6), e);
    });
    // Renormalise (multiplicative replacement for zeros, then closure)
    const delta = (1 / partyCodes.length) ** 2;
    const closed = closure(multiplicativeReplacement([raw], delta))[0];
    const sharesObj = Object.fromEntries(partyCodes.map((p, i) => [p, closed[i]]));
    const winner = partyCodes.reduce((best, p) => (sharesObj[p] > sharesObj[best] ? p : best), partyCodes[0]);
    out.set(riding, { shares: sharesObj, winner });
  }

  return out;
}

/**
 * Estimate mean shares per party from the baseline (for elasticity centering).
 * Uses vote-weighted average across ridings. Handles both array and object
 * share representations.
 */
export function meanSharesFromBaseline(ridingBaseline, partyCodes) {
  const totals = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  for (const shares of ridingBaseline.values()) {
    partyCodes.forEach((p, i) => {
      const v = Array.isArray(shares) ? shares[i] : shares[p];
      totals[p] += v ?? 0;
    });
  }
  const n = ridingBaseline.size;
  return Object.fromEntries(partyCodes.map((p) => [p, totals[p] / n]));
}
