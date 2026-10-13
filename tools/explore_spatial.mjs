/**
 * Exploration de la couche par circonscription : candidats d'apprentissage
 * (ds 0.15, nn) qui prédisent la déviation au modèle de référence
 * (swing + langue), évalués par tools/lib/transitionEval.mjs (trois plis,
 * vote provincial connu, rétrécissement hors échantillon, bassin d'erreurs
 * hors échantillon). Résultats ajoutés à js/data/exploration_results.json.
 *
 * Run: node js/tools/explore_spatial.mjs [motif de candidats]   (from the repo root)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import * as ds from "ds015";
import nn from "@tangent.to/nn";
import { buildData, crossValidate, referenceTargets, printResult, K } from "./lib/transitionEval.mjs";

const RESULTS = new URL("../data/exploration_results.json", import.meta.url);
const DATA = await buildData();

// --- jeux de variables -------------------------------------------------------
const FEATURES = {
  composition: (o) => [...o.level, ...o.L],
  // Interactions avec le swing provincial : trois valeurs distinctes de
  // T.sProv seulement, extrapolation hors plage en 2026 (RMSE 9,1).
  interaction: (o, T) => [...T.sProv, ...o.level.map((v, j) => v * T.sProv[j])],
  profil: (o) => [...o.prof, o.franco, ...o.age],
  region: (o) => [o.g === "MTL" ? 1 : 0, o.g === "QC" ? 1 : 0],
};
const featureSet = (names) => (o, T) => names.flatMap((n) => FEATURES[n](o, T));

function standardizer(X) {
  const d = X[0].length;
  const m = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j], 0) / X.length);
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - m[j]) ** 2, 0) / X.length) || 1);
  return (r) => r.map((v, j) => (v - m[j]) / sd[j]);
}
function trainingSet(train, kappa, fx) {
  const rows = referenceTargets(train, kappa);
  const Xraw = rows.map(({ o, T }) => fx(o, T));
  const z = standardizer(Xraw);
  return { X: Xraw.map(z), Y: rows.map(({ r }) => r), z };
}

// --- modèles -------------------------------------------------------------------
function ridgeFit(X, Y) {
  // Ridge multi-sorties, lambda choisi par LOO (formule du levier) sur une grille.
  const n = X.length, d = X[0].length;
  const XtX = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const XtY = Array.from({ length: d }, (_, i) => Array.from({ length: K }, (_, j) => X.reduce((s, r, k) => s + r[i] * Y[k][j], 0)));
  const ym = Array.from({ length: K }, (_, j) => Y.reduce((s, r) => s + r[j], 0) / n);
  let best = null;
  for (const lam of [0.1, 1, 10, 30, 100, 300, 1000, 1e4, 1e6]) {
    const A = XtX.map((r, i) => r.map((v, j) => v + (i === j ? lam : 0)));
    const inv = invert(A);
    const B = inv.map((r) => Array.from({ length: K }, (_, j) => r.reduce((s, v, k) => s + v * XtY[k][j], 0)));
    let press = 0;
    X.forEach((x, k) => {
      const h = x.reduce((s, v, i) => s + v * inv[i].reduce((t, w, j) => t + w * x[j], 0), 0);
      for (let j = 0; j < K; j++) { const yhat = x.reduce((s, v, i) => s + v * B[i][j], 0); press += ((Y[k][j] - yhat) / (1 - h)) ** 2; }
    });
    if (!best || press < best.press) best = { press, B, lam };
  }
  return (x) => Array.from({ length: K }, (_, j) => x.reduce((s, v, i) => s + v * best.B[i][j], 0));
}
function invert(M) {
  const n = M.length, A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let m = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
    [A[c], A[m]] = [A[m], A[c]];
    const p = A[c][c]; for (let j = 0; j < 2 * n; j++) A[c][j] /= p;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; if (f) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; }
  }
  return A.map((r) => r.slice(n));
}
// Un estimateur ds par coordonnée ILR.
function perCoordinate(make) {
  return (X, Y) => {
    const models = Array.from({ length: K }, (_, j) => { const m = make(); m.fit(X, Y.map((y) => y[j])); return m; });
    return (x) => models.map((m) => { const p = m.predict([x]); return Array.isArray(p) ? (Array.isArray(p[0]) ? p[0][0] : p[0]) : p; });
  };
}
async function nnFit(X, Y, { hidden = 8, dropout = 0.1, members = 5, epochs = 400, seed0 = 101, loss = "mse" } = {}) {
  const x = nn.input(X[0].length);
  let h = nn.dense(hidden, { activation: "tanh" })(x);
  if (dropout) h = nn.dropout(dropout)(h);
  const out = nn.dense(K)(h);
  const template = nn.model(x, out, { loss, normalizeY: true, seed: seed0 % 97 });
  const ens = await nn.ensemble(template, X, Y, {
    members, seeds: Array.from({ length: members }, (_, i) => seed0 + i),
    fit: { optimizer: "adam", learningRate: 3e-3, epochs, batchSize: 32, validationSplit: 0.2, callbacks: [nn.callbacks.earlyStopping({ patience: 30 })] },
  });
  return (xr) => { const p = ens.predict([xr]).mean; return Array.isArray(p[0]) ? p[0] : p; };
}

function candidateFrom(fitter, fx) {
  return async (train, T, { kappa }) => {
    const { X, Y, z } = trainingSet(train, kappa, fx);
    const predict = await fitter(X, Y);
    return T.obs.map((o) => predict(z(fx(o, T))));
  };
}

// Vote personnel : la part du parti du sortant qui se représente sous la même
// bannière est multipliée par exp(beta) ; beta par moindres carrés sur les
// transitions d'entraînement qui ont les données (2018->22, 2022->26).
import { ilrMatrix as ilrM } from "../src/ridingEffects.js";
import { mva as mvaI } from "@tangent.to/ds";
import { pc as PC } from "./lib/transitionEval.mjs";
function incumbencyDelta(o) {
  if (!o.inc || !o.inc.sameParty) return new Array(K).fill(0);
  const j = PC.indexOf(o.inc.party); if (j < 0) return new Array(K).fill(0);
  const sh = mvaI.composition.ilrInv([o.a])[0].map((x, i) => (i === j ? x * Math.E : x));
  const tot = sh.reduce((a, b) => a + b, 0);
  return ilrM([sh.map((x) => x / tot)])[0].map((v, i) => v - o.a[i]);
}
const incumbencyCandidate = () => async (train, T, { kappa }) => {
  const rows = referenceTargets(train.filter((Tr) => Tr.obs.some((o) => o.inc !== undefined)), kappa);
  let num = 0, den = 0;
  for (const { o, r } of rows) { const d = incumbencyDelta(o); d.forEach((x, j) => { num += x * r[j]; den += x * x; }); }
  const beta = den > 0 ? num / den : 0;
  console.log(`    sortant : beta ${beta.toFixed(3)} (entraînement ${train.map((x) => x.id).join("+")})`);
  return T.obs.map((o) => incumbencyDelta(o).map((x) => beta * x));
};

const CANDIDATES = {
  "sortant": incumbencyCandidate,
  "reference": () => async () => null,
  "ridge:composition": () => candidateFrom(ridgeFit, featureSet(["composition"])),
  "ridge:profil": () => candidateFrom(ridgeFit, featureSet(["profil"])),
  "ridge:tout": () => candidateFrom(ridgeFit, featureSet(["composition", "profil", "region"])),
  "foret:tout": () => candidateFrom(perCoordinate(() => new ds.ml.RandomForestRegressor({ nEstimators: 100, maxDepth: 4, minSamplesLeaf: 10, seed: 7 })), featureSet(["composition", "profil", "region"])),
  "boosting:tout": () => candidateFrom(perCoordinate(() => new ds.ml.GradientBoostingRegressor({ nEstimators: 100, learningRate: 0.05, maxDepth: 2, minSamplesLeaf: 10 })), featureSet(["composition", "profil", "region"])),
  "knn:profil": () => candidateFrom(perCoordinate(() => new ds.ml.KNNRegressor({ k: 15 })), featureSet(["profil"])),
  "nn:composition": () => candidateFrom((X, Y) => nnFit(X, Y), featureSet(["composition"])),
  "nn:tout": () => candidateFrom((X, Y) => nnFit(X, Y), featureSet(["composition", "profil", "region"])),
  // Stabilité et variantes du MLP.
  "nn:tout:graine2": () => candidateFrom((X, Y) => nnFit(X, Y, { seed0: 211 }), featureSet(["composition", "profil", "region"])),
  "nn:tout:graine3": () => candidateFrom((X, Y) => nnFit(X, Y, { seed0: 307 }), featureSet(["composition", "profil", "region"])),
  "nn:tout:h4": () => candidateFrom((X, Y) => nnFit(X, Y, { hidden: 4 }), featureSet(["composition", "profil", "region"])),
  "nn:tout:h16d3": () => candidateFrom((X, Y) => nnFit(X, Y, { hidden: 16, dropout: 0.3 }), featureSet(["composition", "profil", "region"])),
  "nn:tout:m10": () => candidateFrom((X, Y) => nnFit(X, Y, { members: 10 }), featureSet(["composition", "profil", "region"])),
  "nn:tout:m10g2": () => candidateFrom((X, Y) => nnFit(X, Y, { members: 10, seed0: 503 }), featureSet(["composition", "profil", "region"])),
  "nn:composition+region:m10": () => candidateFrom((X, Y) => nnFit(X, Y, { members: 10 }), featureSet(["composition", "region"])),
  "nn:profil+region": () => candidateFrom((X, Y) => nnFit(X, Y), featureSet(["profil", "region"])),
};

const pattern = process.argv[2] ? new RegExp(process.argv[2]) : /./;
const argVal = (name, def) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split("=")[1]) : def; };
const TAU = argVal("tau", 0), SEED = argVal("seed", 3), REG = argVal("regional", 0) === 1, CAL = argVal("calibre", 0) === 1, EVE = argVal("veille", 0) === 1, SIG = argVal("sigma", 1), RPOLL = argVal("regsondages", 0) === 1;
const FIXED = argVal("echelleprod", 0) === 1 ? JSON.parse(readFileSync(new URL("../data/qc_residual_scale.json", import.meta.url), "utf-8")).scale : null;
const store = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, "utf-8")) : [];
for (const [name, make] of Object.entries(CANDIDATES)) {
  if (!pattern.test(name)) continue;
  const t0 = Date.now();
  try {
    const R = await crossValidate(DATA, make(), { label: `${name} τ${TAU}${REG ? " R" : ""}${CAL ? " C" : ""}${FIXED ? " E" : ""}${EVE ? ` V σ${SIG}` : ""}${RPOLL ? " RS" : ""} s${SEED}`, tau: TAU, seed: SEED, regionalShock: REG, calibrateScale: CAL, national: EVE ? "veille" : "connu", fixedScale: FIXED, sigmaScale: SIG, regionPolls: RPOLL });
    R.seconds = Math.round((Date.now() - t0) / 1000);
    R.date = new Date().toISOString();
    printResult(R);
    store.push(R);
    writeFileSync(RESULTS, JSON.stringify(store, null, 1));
  } catch (err) {
    console.log(`${name.padEnd(34)} ÉCHEC : ${err.message.split("\n")[0]}`);
  }
}
