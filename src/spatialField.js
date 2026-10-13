/**
 * Spatial CAR (Conditional Autoregressive) field on the riding adjacency
 * graph, for the seat simulation's residual draws.
 *
 * NOT IN PRODUCTION -- draft kept for the 2030 spatial-field work (TODO,
 * entry "Champ CAR"). Known defects, to fix before any adoption:
 *   1. with row-normalized W, sigma2 * (I - rho W)^{-1} is NOT symmetric
 *      (max |S - S^T| = 0.19 at rho = 0.27), so it is not a covariance and
 *      the Cholesky below silently reads only its lower triangle. A valid
 *      CAR uses Q = (D - rho A) / sigma2 with the binary adjacency A;
 *   2. rho is set to the empirical neighbour correlation, but a CAR's
 *      implied neighbour correlation is much smaller (0.065 at rho = 0.27);
 *      Var = sigma2 / (1 - rho^2) is the AR(1) identity, not the CAR one.
 *      rho must be estimated by likelihood;
 *   3. ILR coordinates are drawn independently and from a Gaussian, which
 *      loses the within-riding cross-party correlation and the empirical
 *      tails that whole-vector resampling preserves;
 *   4. validation must be seat coverage on the three transitions, not the
 *      change in interval width.
 *
 * The simulation previously resampled riding residuals i.i.d. after removing
 * regional means. The 2026-10-06 review measured a significant neighbour
 * correlation (0.216 pooled, p<0.01, up to 0.35 per ILR coordinate) in the
 * de-meaned residuals, refuting the i.i.d. assumption: adjacent ridings move
 * together, and letting them cancel across 127 seats thins the tails of the
 * seat-count distributions.
 *
 * This module replaces the i.i.d. resampling with a proper CAR field:
 *   y_c ~ N(0, sigma2_c * (I - rho_c * W)^{-1})
 * per ILR coordinate c, where W is the row-normalized adjacency matrix
 * (shared vertices in the DGEQ geojson) and rho_c, sigma2_c are estimated
 * from the held-out residuals by method of moments.
 *
 * The CAR precision is Q = (I - rho*W) / sigma2. Sampling uses the
 * Cholesky of the covariance Sigma = sigma2 * (I - rho*W)^{-1}, precomputed
 * once per coordinate at build time: y = L z with z ~ N(0, I) and
 * Sigma = L L^T. Cost O(n^3) once, O(n^2) per draw -- negligible next to the
 * 5000-draw Monte Carlo loop.
 */

/**
 * Build the row-normalized adjacency matrix from the DGEQ geojson.
 * Two ridings are adjacent when they share at least 2 polygon vertices
 * (the DGEQ boundaries share exact coordinates along common borders).
 *
 * @param {Object} geojson FeatureCollection with features[].properties.riding_code
 *   and features[].geometry (Polygon or MultiPolygon)
 * @returns {{codes: string[], W: number[][], nEdges: number}}
 *   codes: riding codes in matrix order; W: row-normalized adjacency
 */
export function buildAdjacencyMatrix(geojson) {
  const vertexOwners = new Map();
  const codeByFeature = [];

  for (const f of geojson.features) {
    const code = String(f.properties.riding_code);
    codeByFeature.push(code);
    const polys = f.geometry.type === "Polygon"
      ? [f.geometry.coordinates]
      : f.geometry.coordinates;
    for (const poly of polys) {
      for (const ring of poly) {
        for (const [x, y] of ring) {
          const key = `${x.toFixed(5)}|${y.toFixed(5)}`;
          if (!vertexOwners.has(key)) vertexOwners.set(key, new Set());
          vertexOwners.get(key).add(code);
        }
      }
    }
  }

  const codes = [...new Set(codeByFeature)].sort((a, b) => +a - +b);
  const idx = new Map(codes.map((c, i) => [c, i]));
  const n = codes.length;

  // Count shared vertices per pair; keep pairs with >= 1 shared vertex.
  // The DGEQ geojson boundaries share exact coordinates along common borders,
  // but small urban ridings may share only a single vertex due to polygon
  // simplification; requiring >= 2 would isolate them (degree 0). A single
  // shared vertex can also be a quadripoint, but for the CAR model a spurious
  // weak edge is preferable to no edge: the alternative is an independent
  // residual, which is exactly what the i.i.d. model already assumes.
  const sharedCount = new Map();
  for (const owners of vertexOwners.values()) {
    if (owners.size < 2) continue;
    const list = [...owners].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${list[i]}|${list[j]}`;
        sharedCount.set(key, (sharedCount.get(key) ?? 0) + 1);
      }
    }
  }

  const W = Array.from({ length: n }, () => new Array(n).fill(0));
  let nEdges = 0;
  for (const [key, count] of sharedCount.entries()) {
    if (count < 1) continue;
    const [ca, cb] = key.split("|");
    const a = idx.get(ca), b = idx.get(cb);
    if (a !== undefined && b !== undefined) {
      W[a][b] = 1;
      W[b][a] = 1;
      nEdges++;
    }
  }

  // Row-normalize (nEdges already counts unique undirected edges above)
  for (let i = 0; i < n; i++) {
    const deg = W[i].reduce((s, v) => s + v, 0);
    if (deg > 0) {
      for (let j = 0; j < n; j++) W[i][j] /= deg;
    }
  }

  return { codes, W, nEdges };
}

/**
 * Estimate CAR parameters per ILR coordinate from de-meaned residuals.
 * Method of moments: the correlation between adjacent ridings' residuals
 * estimates rho; the marginal variance fixes sigma2 via the CAR identity
 * Var(y_i) = sigma2 / (1 - rho^2) for row-normalized W (approximate on
 * irregular graphs, exact in the mean-field limit).
 *
 * @param {number[][]} residuals n x k matrix of de-meaned residuals (ILR)
 * @param {string[]} residualCodes riding code per residual row
 * @param {{codes: string[], W: number[][]}} adjacency from buildAdjacencyMatrix
 * @returns {{rho: number[], sigma2: number[], codes: string[], W: number[][]}}
 *   rho per coordinate (clamped to [0, 0.95]), sigma2 per coordinate,
 *   codes aligned with W rows, and the adjacency matrix itself
 */
export function estimateCARParams(residuals, residualCodes, adjacency) {
  const { codes, W } = adjacency;
  const idx = new Map(codes.map((c, i) => [c, i]));
  const k = residuals[0].length;
  const n = codes.length;

  // Map residuals to adjacency indices
  const Y = Array.from({ length: n }, () => null);
  let nMatched = 0;
  residualCodes.forEach((code, i) => {
    const j = idx.get(String(code));
    if (j !== undefined && residuals[i]) {
      Y[j] = residuals[i];
      nMatched++;
    }
  });

  if (nMatched < 10) {
    throw new Error(`estimateCARParams: only ${nMatched} residuals matched adjacency codes (need >= 10)`);
  }

  const rho = new Array(k).fill(0);
  const sigma2 = new Array(k).fill(0);

  for (let c = 0; c < k; c++) {
    // Collect values for ridings present in both
    const vals = [];
    for (let i = 0; i < n; i++) if (Y[i]) vals.push(Y[i][c]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const varY = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;

    // Neighbor correlation: average product of standardized adjacent values
    let num = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      if (!Y[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!Y[j]) continue;
        if (W[i][j] === 0) continue;
        // W is row-normalized; use the raw adjacency (un-normalized) for
        // the correlation estimate. Reconstruct: W[i][j] > 0 means adjacent.
        const sd = Math.sqrt(varY) || 1;
        num += ((Y[i][c] - mean) / sd) * ((Y[j][c] - mean) / sd);
        cnt++;
      }
    }
    const neighborCorr = cnt > 0 ? num / cnt : 0;
    // Clamp to [0, 0.95]: negative correlation is not meaningful for a CAR,
    // and rho >= 1 makes the precision matrix singular.
    rho[c] = Math.max(0, Math.min(0.95, neighborCorr));
    // sigma2 from the CAR marginal variance identity
    sigma2[c] = varY * (1 - rho[c] ** 2);
  }

  return { rho, sigma2, codes, W };
}

/**
 * Precompute the Cholesky factor of the CAR covariance for each coordinate.
 * Sigma_c = sigma2_c * (I - rho_c * W)^{-1}; we store L_c where
 * Sigma_c = L_c L_c^T so that a draw is y = L_c z with z ~ N(0, I).
 *
 * @param {{rho: number[], sigma2: number[], W: number[][]}} params
 * @returns {Array<Float64Array>} L per coordinate (lower-triangular, flattened)
 */
export function prepareCARSampler(params) {
  const { rho, sigma2, W } = params;
  const n = W.length;
  const k = rho.length;

  // Validate parameters: sigma2 must be finite and positive, rho in [0, 1)
  for (let c = 0; c < k; c++) {
    if (!Number.isFinite(sigma2[c]) || sigma2[c] <= 0) {
      throw new Error(`prepareCARSampler: invalid sigma2[${c}] = ${sigma2[c]}`);
    }
    if (!Number.isFinite(rho[c]) || rho[c] < 0 || rho[c] >= 1) {
      throw new Error(`prepareCARSampler: invalid rho[${c}] = ${rho[c]}`);
    }
  }

  const samplers = [];

  for (let c = 0; c < k; c++) {
    // M = I - rho * W
    const M = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0) - rho[c] * W[i][j])
    );

    // Sigma = sigma2 * M^{-1}. Compute M^{-1} via Gaussian elimination
    // (n=127, so O(n^3) ~ 2M ops per coordinate, done once at build time).
    const inv = invertMatrix(M);

    // Sigma = sigma2 * inv
    const Sigma = inv.map((row) => row.map((v) => v * sigma2[c]));

    // Cholesky: Sigma = L L^T (lower triangular)
    const L = cholesky(Sigma);
    samplers.push(Float64Array.from(L.flat()));
  }

  return { samplers, n, k };
}

/**
 * Sample one spatially-correlated residual field (n ridings x k coordinates).
 *
 * @param {{samplers: Array<Float64Array>, n: number, k: number}} prepared
 * @param {() => number} rng uniform [0,1) generator
 * @returns {number[][]} n x k matrix of residuals
 */
export function sampleCARField(prepared, rng) {
  const { samplers, n, k } = prepared;
  const out = Array.from({ length: n }, () => new Array(k).fill(0));

  for (let c = 0; c < k; c++) {
    const L = samplers[c];
    // z ~ N(0, I) via Box-Muller
    const z = new Array(n);
    for (let i = 0; i < n; i++) {
      const u1 = rng() || 1e-10, u2 = rng();
      z[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    // y = L z (L is lower-triangular, stored row-major flattened)
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j <= i; j++) s += L[i * n + j] * z[j];
      out[i][c] = s;
    }
  }

  return out;
}

// --- linear algebra helpers ------------------------------------------------

/** Invert a dense matrix via Gauss-Jordan elimination with partial pivoting. */
function invertMatrix(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);

  for (let col = 0; col < n; col++) {
    // Partial pivot
    let maxRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[maxRow][col])) maxRow = r;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];

    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-14) {
      // Singular (should not happen for valid CAR with rho < 1); add jitter
      A[col][col] += 1e-10;
    }
    const inv = 1 / A[col][col];
    for (let j = 0; j < 2 * n; j++) A[col][j] *= inv;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = A[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) A[r][j] -= factor * A[col][j];
    }
  }

  return A.map((row) => row.slice(n));
}

/** Cholesky decomposition: returns lower-triangular L where A = L L^T. */
function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        L[i][j] = Math.sqrt(Math.max(s, 1e-12));
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }

  return L;
}
