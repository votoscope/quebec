/**
 * Monte Carlo seat simulation.
 *
 * Four sources of uncertainty are propagated:
 *   1. the national vote share, drawn from the poll model's posterior
 *   2. a SYSTEMIC shock common to every riding: the polling industry's
 *      collective bias plus drift between today and election day, scaled to
 *      the historical final-polls-vs-result error (isotropic in ILR, sd
 *      sqrt(sigma_industry^2 + sigma_daily2 * days) -- see
 *      model/systemic_error.py). Without it, the simulation asserted that
 *      the polls are collectively unbiased and that nothing moves before the
 *      vote; both were several points wrong in 2018 and 2022, and because
 *      the miss is shared across ridings it does not average out over 127
 *      seats the way independent noise does.
 *   3. a REGIONAL factor: one shock per region (MTL/QC/REG) per draw.
 *      Riding departures are spatially correlated; resampling them i.i.d.
 *      lets them cancel across 127 ridings and thins the seat-count tails.
 *   4. each riding's own residual departure, resampled from held-out model
 *      prediction errors -- de-meaned by region so the regional factor isn't
 *      counted twice.
 *
 * Only propagating (1) -- treating each riding as deterministic once the
 * national numbers are drawn -- asserts that every riding moves exactly with
 * the province. That is measurably false (the SD of riding departures is
 * ~0.8x the size of the provincial swing itself) and it distorts more than
 * the interval widths: because seats are a nonlinear function of shares, a
 * party narrowly ahead everywhere sweeps EVERY riding under zero
 * heterogeneity. It manufactured landslides and put P(PQ majority) at 74%
 * where the corrected figure is ~35%. Terms (2) and (3) fix the same error
 * one level up and one level down: (2) was flagged by review as the dominant
 * remaining source of overconfidence.
 *
 * Residual vectors are resampled whole, preserving the cross-party
 * correlation within a riding; drawing each party independently would
 * produce incoherent compositions.
 */

import { mva } from "@tangent.to/ds";

const { closure, multiplicativeReplacement, ilr, ilrInv } = mva.composition;

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ilrRows(rows) {
  const delta = (1 / rows[0].length) ** 2;
  return ilr(closure(multiplicativeReplacement(rows, delta)));
}

function randn(rng) {
  const u1 = rng(), u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}

/** Region-mean residual vectors and the de-meaned residual pool.
 * regionOf: index -> region label (null when unknown). */
function regionalDecomposition(residuals, residualRegions) {
  const k = residuals[0].length;
  const sums = new Map(), counts = new Map();
  residuals.forEach((r, i) => {
    const region = residualRegions?.[i] ?? null;
    if (!region) return;
    if (!sums.has(region)) { sums.set(region, new Array(k).fill(0)); counts.set(region, 0); }
    const s = sums.get(region);
    r.forEach((v, j) => { s[j] += v; });
    counts.set(region, counts.get(region) + 1);
  });

  const means = new Map();
  for (const [region, s] of sums) means.set(region, s.map((v) => v / counts.get(region)));

  // sigma_region: RMS of the region-mean coordinates -- the scale of the
  // shared component the i.i.d. resampling was destroying.
  let sq = 0, n = 0;
  for (const m of means.values()) { m.forEach((v) => { sq += v * v; n++; }); }
  const sigmaRegion = n ? Math.sqrt(sq / n) : 0;

  const demeaned = residuals.map((r, i) => {
    const m = means.get(residualRegions?.[i] ?? null);
    return m ? r.map((v, j) => v - m[j]) : r;
  });
  return { sigmaRegion, demeaned };
}

/**
 * @param {Map<string, number[]>} ridingBaseline riding -> share vector
 * @param {Object} provinceBaseline {party: share}
 * @param {Array<Object>} provinceDraws posterior draws of {party: share}
 * @param {number[][]} residuals held-out model prediction errors, in ILR
 * @param {Object} opts
 *   - ridingEffects: Map riding -> predicted ILR departure
 *   - maxShift: clamp on the predicted departure, matching the point
 *     projection's clamp -- previously applied there but not here, so the
 *     simulation medians could drift from the point projection
 *   - systemic: {sigmaIndustry, sigmaDaily2, daysToElection} common shock
 *   - regionByRiding: Map riding -> region label (MTL/QC/REG)
 *   - residualRegions: region label per residual row (for decomposition)
 *   - noEffectScale: multiplier on the residual draw for ridings with no
 *     predicted effect -- their uncertainty is the RAW departure scale, not
 *     the (smaller) model-error scale; using the model's residuals for them
 *     understated uncertainty exactly on the least-known seats
 * @returns {{draws: Object[], totalSeats: number}} seat counts per draw
 */
export function simulateSeatCounts(
  ridingBaseline, provinceBaseline, provinceDraws, residuals, partyCodes,
  {
    seed = 1, ridingEffects = null, maxShift = 0.35,
    systemic = null, regionByRiding = null, residualRegions = null, noEffectScale = 1,
  } = {}
) {
  const rng = mulberry32(seed);
  const ridings = [...ridingBaseline.keys()];
  const baseIlr = ilrRows(ridings.map((r) => ridingBaseline.get(r)));
  const provBaseIlr = ilrRows([partyCodes.map((p) => provinceBaseline[p])])[0];
  const k = baseIlr[0].length;

  // Predicted riding-specific departure, where the model has one. Applied
  // once (it's a deterministic prediction), unlike the residual draw which
  // is resampled per simulation because it represents what the model can't
  // predict. Clamped like the point projection.
  const clamp = (v) => Math.max(-maxShift, Math.min(maxShift, v));
  const effects = ridings.map((r) => {
    const e = ridingEffects ? ridingEffects.get(String(r)) ?? null : null;
    return e ? e.map(clamp) : null;
  });

  const regions = ridings.map((r) => (regionByRiding ? regionByRiding.get(String(r)) ?? null : null));
  const regionLabels = [...new Set(regions.filter(Boolean))];

  const { sigmaRegion, demeaned } =
    regionLabels.length && residuals.length
      ? regionalDecomposition(residuals, residualRegions)
      : { sigmaRegion: 0, demeaned: residuals };

  // Systemic shock sd: industry bias + random-walk drift to election day.
  // Isotropic in ILR (invariant under orthonormal basis change, so the scale
  // estimated in Python's ILR basis applies unchanged here).
  const sysSd = systemic
    ? Math.sqrt(systemic.sigmaIndustry ** 2 + (systemic.sigmaDaily2 ?? 0) * Math.max(0, systemic.daysToElection ?? 0))
    : 0;

  // Per-riding win tally across draws. Its column sums are exact expected
  // seats (sum over ridings of P(win) = E[seats], by linearity), so this is
  // the one per-riding decomposition that adds up across the province.
  const winTally = ridings.map(() => new Array(partyCodes.length).fill(0));

  // National vote composition of each draw INCLUDING the common systemic
  // shock: the shock shifts every riding, so the vote total implied by a
  // draw's seats is provDraw + shock, not provDraw. The published joint
  // votes-seats distribution must pair seats with THIS composition --
  // pairing them with the raw provinceDraws mixed two different laws
  // (found by the 2026-10-06 review).
  const voteDraws = new Array(provinceDraws.length);

  const draws = provinceDraws.map((draw, di) => {
    const provDrawIlr = ilrRows([partyCodes.map((p) => draw[p])])[0];
    const delta = provDrawIlr.map((v, j) => v - provBaseIlr[j]);

    const shock = sysSd ? Array.from({ length: k }, () => randn(rng) * sysSd) : null;
    const effIlr = provDrawIlr.map((v, j) => v + (shock ? shock[j] : 0));
    const effShare = ilrInv([effIlr])[0];
    voteDraws[di] = Object.fromEntries(partyCodes.map((p, j) => [p, effShare[j]]));
    const regionShock = new Map(
      regionLabels.map((label) => [label, Array.from({ length: k }, () => randn(rng) * sigmaRegion)])
    );

    const shifted = baseIlr.map((row, i) => {
      const res = demeaned.length ? demeaned[Math.floor(rng() * demeaned.length)] : null;
      const eff = effects[i];
      const reg = regions[i] ? regionShock.get(regions[i]) : null;
      const resScale = eff ? 1 : noEffectScale;
      return row.map((v, j) =>
        v + delta[j]
        + (shock ? shock[j] : 0)
        + (reg ? reg[j] : 0)
        + (eff ? eff[j] : 0)
        + (res ? res[j] * resScale : 0)
      );
    });

    const shares = ilrInv(shifted);
    const counts = Object.fromEntries(partyCodes.map((p) => [p, 0]));
    shares.forEach((row, i) => {
      let best = 0;
      for (let j = 1; j < row.length; j++) if (row[j] > row[best]) best = j;
      counts[partyCodes[best]]++;
      winTally[i][best]++;
    });
    return counts;
  });

  const winProbs = Object.fromEntries(
    ridings.map((r, i) => [
      String(r),
      Object.fromEntries(partyCodes.map((p, j) => [p, winTally[i][j] / draws.length])),
    ]),
  );

  return { draws, voteDraws, totalSeats: ridings.length, winProbs };
}

/**
 * The medoid draw: the simulated scenario minimising the mean L1 distance in
 * seat space to every other draw -- the multivariate "most typical" outcome.
 * Component-wise medians are NOT jointly attainable (they need not sum to
 * the house size, since no draw realises every marginal median at once), and
 * the joint MODE is not estimable from a few thousand draws in 6 dimensions
 * (nearly every seat vector is unique). The medoid is the robust stand-in:
 * an ACTUAL draw, coherent across parties, summing to the house size by
 * construction. O(n^2) in the number of draws; fine at build time.
 */
export function medoidDraw(draws, partyCodes) {
  const M = draws.map((d) => partyCodes.map((p) => d[p]));
  let best = 0, bestSum = Infinity;
  for (let i = 0; i < M.length; i++) {
    let s = 0;
    for (let j = 0; j < M.length; j++) {
      for (let k = 0; k < partyCodes.length; k++) s += Math.abs(M[i][k] - M[j][k]);
    }
    if (s < bestSum) { bestSum = s; best = i; }
  }
  return { ...draws[best] };
}

/** Marginal seat distribution per party, for the posterior histograms. */
export function seatDistributions(draws, partyCodes) {
  const out = {};
  for (const party of partyCodes) {
    const values = draws.map((d) => d[party]).sort((a, b) => a - b);
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    const q = (p) => values[Math.floor((p / 100) * (values.length - 1))];
    const hist = [...counts.entries()]
      .map(([seats, n]) => ({ seats, prob: n / values.length }))
      .sort((a, b) => a.seats - b.seats);
    // Also carry a per-party normalised height. A party whose seats span 34-78
    // has a much flatter density than one pinned near zero, so on a shared
    // probability axis the wide (and more interesting) distributions render as
    // flat lines. Normalising each party to its own peak makes every shape
    // readable; the actual numbers are reported as median + interval instead.
    const peak = Math.max(...hist.map((h) => h.prob)) || 1;
    out[party] = {
      histogram: hist.map((h) => ({ ...h, height: h.prob / peak })),
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      p05: q(5), p50: q(50), p95: q(95),
    };
  }
  return out;
}

/**
 * Classify every draw into exactly one mutually exclusive government
 * scenario, so the reported probabilities partition to 1.
 *
 * For a minority, every party whose seats added to the plurality winner's
 * reach a majority is listed as a sufficient support (smallest first). No
 * single party need hold that position: several usually do, the official
 * opposition included. Arithmetic only: who actually supports whom is a
 * political choice this model can't see.
 */
export function governmentScenarios(draws, totalSeats, partyCodes) {
  const threshold = Math.floor(totalSeats / 2) + 1;
  const scenarios = new Map();

  for (const draw of draws) {
    const ranked = partyCodes
      .map((p) => ({ party: p, seats: draw[p] }))
      .filter((d) => d.seats > 0)
      .sort((a, b) => b.seats - a.seats);
    if (!ranked.length) continue;

    const leader = ranked[0];
    let key, detail;

    if (leader.seats >= threshold) {
      key = `maj:${leader.party}`;
      detail = { type: "majority", leader: leader.party, opposition: ranked[1]?.party ?? null };
    } else {
      const supports = ranked
        .slice(1)
        .filter((d) => leader.seats + d.seats >= threshold)
        .sort((a, b) => a.seats - b.seats)
        .map((d) => d.party);
      key = `min:${leader.party}:${supports.join("+")}`;
      detail = { type: "minority", leader: leader.party, supports, opposition: ranked[1]?.party ?? null };
    }

    if (!scenarios.has(key)) scenarios.set(key, { ...detail, count: 0 });
    scenarios.get(key).count++;
  }

  const total = draws.length;
  return [...scenarios.values()]
    .map((s) => ({ ...s, probability: s.count / total }))
    .sort((a, b) => b.probability - a.probability);
}

/**
 * Pivot power of each party: the normalised Banzhaf index of the seat
 * allocation in each draw, averaged over draws. In a draw, a party is a swing
 * member of a coalition (any subset of the parties holding seats) that
 * reaches the majority and falls short without it; its index is its number
 * of swings over the total number of swings of all parties. A party with a
 * majority alone has index 1. Also returned: the probability that the party
 * is a swing member of at least one winning coalition other than a majority
 * of its own (pPivotal).
 */
export function pivotPower(draws, totalSeats, partyCodes) {
  const threshold = Math.floor(totalSeats / 2) + 1;
  const mean = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  const pivotal = Object.fromEntries(partyCodes.map((p) => [p, 0]));
  for (const draw of draws) {
    const players = partyCodes.filter((p) => draw[p] > 0);
    const n = players.length;
    const swings = new Array(n).fill(0);
    for (let mask = 1; mask < 1 << n; mask++) {
      let seats = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) seats += draw[players[i]];
      if (seats < threshold) continue;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i) && seats - draw[players[i]] < threshold) swings[i]++;
      }
    }
    const tot = swings.reduce((a, b) => a + b, 0);
    const majority = players.some((p) => draw[p] >= threshold);
    players.forEach((p, i) => {
      if (tot > 0) mean[p] += swings[i] / tot;
      if (!majority && swings[i] > 0) pivotal[p]++;
    });
  }
  return Object.fromEntries(partyCodes.map((p) => [p, { banzhaf: mean[p] / draws.length, pPivotal: pivotal[p] / draws.length }]));
}

/**
 * Met à l'échelle des vecteurs de résidus ILR partie par partie, en CLR :
 * scaleByParty[p] multiplie la composante CLR du parti p (1 = inchangée).
 * Facteurs estimés hors échantillon (tools/residual_scale_fit.mjs).
 */
export function scaleResiduals(residuals, partyCodes, scaleByParty) {
  const s = partyCodes.map((p) => scaleByParty?.[p] ?? 1);
  return residuals.map((e) => {
    const comp = ilrInv([e])[0];
    const l = comp.map((x) => Math.log(x));
    const m = l.reduce((a, b) => a + b, 0) / l.length;
    const z = l.map((x, j) => (x - m) * s[j]);
    const mz = z.reduce((a, b) => a + b, 0) / z.length;
    const back = z.map((x) => Math.exp(x - mz));
    const t = back.reduce((a, b) => a + b, 0);
    return ilr([back.map((x) => x / t)])[0];
  });
}

/**
 * Écrête les résidus ILR partie par partie en CLR : chaque composante est
 * bornée à ±c fois l'écart-type de sa partie dans le bassin (c = Infinity :
 * inchangé). c estimé hors échantillon à la veille des trois scrutins
 * (tools/winsor_test.mjs).
 */
export function winsorizeResiduals(residuals, c) {
  if (!Number.isFinite(c) || !residuals.length) return residuals;
  const Z = residuals.map((e) => { const l = ilrInv([e])[0].map(Math.log); const m = l.reduce((a, b) => a + b, 0) / l.length; return l.map((x) => x - m); });
  const sd = Z[0].map((_, j) => Math.sqrt(Z.reduce((s, z) => s + z[j] ** 2, 0) / Z.length));
  return Z.map((z) => {
    const e = z.map((x, j) => Math.exp(Math.max(-c * sd[j], Math.min(c * sd[j], x))));
    const t = e.reduce((a, b) => a + b, 0);
    return ilr([e.map((x) => x / t)])[0];
  });
}
