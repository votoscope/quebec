/**
 * Où vit l'écart au report pur en 2026 ? Erreur de part par circonscription
 * du report pur à vote provincial connu (réel - prévu, pp), régressée sur
 * des blocs de prédicteurs : régions (3, 4, 14 groupes), langue maternelle
 * (part francophone), et leurs combinaisons. R² hors échantillon par
 * validation croisée « laisser-une-circonscription-de-côté » (formule du
 * levier de l'OLS), par parti.
 *
 * Lecture : la part de la carte du swing 2026 qu'un prédicteur aurait pu
 * expliquer S'IL avait été mesuré parfaitement (diagnostic de borne
 * supérieure, pas une prévision).
 *
 * Run: node js/tools/swing_geography.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { pivotPolls } from "../src/compositional.js";
import { ridingBaselineFromRows, provinceShareFromRows, uniformClrSwing } from "../src/swing.js";
import { loadFixtures } from "../test/golden_lib.mjs";
import { loadAllRows } from "./lib/harness.mjs";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const data = loadFixtures(new URL("../test/fixtures/", import.meta.url));
const fine = load("../data/qc_riding_regions_fine.json").ridings;
const r4 = new Map(load("../data/qc_riding_regions4.json").regions.map((r) => [String(r.riding_code), r.region4]));
const r3 = new Map(data.ridingRegions.map((r) => [String(r.riding_code), r.region_code]));
const feat = new Map(data.features2026.map((f) => [String(f.riding_code), f]));
const { partyCodes: pc } = pivotPolls(data.pollRows);
const MAIN = ["CAQ", "LIB", "PCQ", "PQ", "QS"];

const rows = loadAllRows().filter((r) => r.election_date === "2026-10-05");
const truth = new Map(), prov = Object.fromEntries(pc.map((p) => [p, 0]));
for (const r of rows) {
  const p = pc.includes(r.party_code) ? r.party_code : "AUTRES";
  if (!truth.has(r.riding_code)) truth.set(r.riding_code, Object.fromEntries(pc.map((q) => [q, 0])));
  truth.get(r.riding_code)[p] += r.votes; prov[p] += r.votes;
}
for (const v of truth.values()) { const t = pc.reduce((s, p) => s + v[p], 0); for (const p of pc) v[p] /= t; }
const tot = pc.reduce((s, p) => s + prov[p], 0);
for (const p of pc) prov[p] /= tot;

const fc = uniformClrSwing(ridingBaselineFromRows(data.baselineRows, pc), provinceShareFromRows(data.baselineRows, pc), prov, pc);
const codes = [...fc.keys()].map(String).filter((c) => truth.has(c) && feat.has(c) && fine[c]);
const err = Object.fromEntries(MAIN.map((p) => [p, codes.map((c) => (truth.get(c)[p] - fc.get(c).shares[p]) * 100)]));

const dummies = (labelOf) => {
  const labels = [...new Set(codes.map(labelOf))].sort().slice(1); // une modalité de référence
  return codes.map((c) => labels.map((l) => (labelOf(c) === l ? 1 : 0)));
};
const G14 = Object.keys(load("../data/qc_regional_megapoll_2026.json").groups);
const blocks = {
  "3 régions": dummies((c) => r3.get(c)),
  "4 régions": dummies((c) => r4.get(c) ?? r3.get(c)),
  "14 groupes": codes.map((c) => G14.slice(1).map((g) => fine[c].ra[g] ?? 0)),
  "francophones": codes.map((c) => [feat.get(c).language[0] / 100]),
};
blocks["3 rég. + franco."] = codes.map((c, i) => [...blocks["3 régions"][i], ...blocks.francophones[i]]);
blocks["14 gr. + franco."] = codes.map((c, i) => [...blocks["14 groupes"][i], ...blocks.francophones[i]]);

// OLS avec constante ; R² LOO par la formule du levier.
function looR2(X0, y) {
  const X = X0.map((r) => [1, ...r]);
  const p = X[0].length, n = X.length;
  const XtX = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? 1e-9 : 0)));
  const inv = invert(XtX);
  const Xty = Array.from({ length: p }, (_, i) => X.reduce((s, r, k) => s + r[i] * y[k], 0));
  const b = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const ybar = y.reduce((a, v) => a + v, 0) / n;
  let press = 0, sst = 0, sse = 0;
  X.forEach((r, k) => {
    const yhat = r.reduce((s, v, j) => s + v * b[j], 0);
    const h = r.reduce((s, v, i) => s + v * inv[i].reduce((t, w, j) => t + w * r[j], 0), 0);
    press += ((y[k] - yhat) / (1 - h)) ** 2; sse += (y[k] - yhat) ** 2; sst += (y[k] - ybar) ** 2;
  });
  return { loo: 1 - press / sst, ins: 1 - sse / sst };
}
function invert(M) {
  const n = M.length, A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let m = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
    [A[c], A[m]] = [A[m], A[c]];
    const piv = A[c][c]; for (let j = 0; j < 2 * n; j++) A[c][j] /= piv;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j]; }
  }
  return A.map((r) => r.slice(n));
}

console.log(`${codes.length} circonscriptions ; écart-type de l'erreur du report pur (pp) : ` +
  MAIN.map((p) => `${p} ${Math.sqrt(err[p].reduce((s, v) => s + v * v, 0) / codes.length).toFixed(2)}`).join(", "));
console.log(`\n  R² hors échantillon (LOO) [in-sample]   ${MAIN.map((p) => p.padStart(13)).join("")}`);
for (const [name, X] of Object.entries(blocks)) {
  console.log(`  ${name.padEnd(36)} ${MAIN.map((p) => { const r = looR2(X, err[p]); return `${r.loo.toFixed(2).padStart(6)} [${r.ins.toFixed(2)}]`; }).join("")}`);
}
