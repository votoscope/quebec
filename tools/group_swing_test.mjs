/**
 * Swing par groupe démographique MESURÉ dans les sondages : langue
 * maternelle (francophones / non-francophones) et âge (18-34, 35-54, 55+).
 *
 * Pour une transition E0 -> E1, les ventilations Léger de fin de campagne
 * (js/data/qc_leger_crosstabs.json ; vagues d'une même élection regroupées
 * en moyenne pondérée par n, ou dernière vague seule) donnent, pour chaque
 * groupe g, la variation log-ratio (CLR de la sous-composition des cinq
 * partis principaux) : Delta_g = clr(C1_g) - clr(C0_g). Une circonscription
 * r reçoit l'écart de son mélange de groupes à la moyenne des
 * circonscriptions, partie par partie :
 *   adj_rp = kL_p * sum_{g in langue} pi_rg (Delta_gp - Dbar_Lp)
 *          + kA   * sum_{g in âge}    pi_rg (Delta_gp - Dbar_Ap)
 * (pi_rg : recensement 2021, js/data/qc_riding_language_age.json), appliqué
 * en CLR à la sous-composition de la circonscription (part d'AUTRES tenue
 * fixe) après le swing provincial RÉEL en convention additive ILR
 * (tools/lib/harness.mjs provincialDelta) : la couche nationale est
 * neutralisée, seule la répartition spatiale est évaluée. Le swing CLR
 * multiplicatif de production est inapplicable à 2018 -> 2022 (PCQ absent
 * de la baseline, voir tools/veille_archive.mjs).
 *
 * Coefficients sur grille contenant 0 (report pur, hypothèse nulle) :
 * kL commun ou un kL par parti (descente par coordonnées sur la grille),
 * kA commun. Validation en laissant une transition de côté : coefficients
 * choisis sur les autres (RMSE des parts), évalués sur celle-ci. Transitions :
 * 2014 -> 2018, 2018 -> 2022 (carte 2017 ; la baseline 2014 est sur la
 * carte 2011, jointe par nom) et 2022 -> 2026 (carte 2026).
 *
 * Run: node js/tools/group_swing_test.mjs   (from the repo root)
 */

import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { ilrMatrix, PARTIES } from "../src/ridingEffects.js";
import { loadAllRows, electionState, provincialDelta } from "./lib/harness.mjs";

const { ilrInv } = mva.composition;
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const cross = load("../data/qc_leger_crosstabs.json");
const comp = load("../data/qc_riding_language_age.json");
const rows = loadAllRows();

const pc = PARTIES;
const MAIN = ["CAQ", "LIB", "PCQ", "PQ", "QS"];
const P = MAIN.length;
const mainIdx = MAIN.map((p) => pc.indexOf(p));
const ai = pc.indexOf("AUTRES");

const clr = (v) => { const l = v.map((x) => Math.log(Math.max(x, 1e-4))); const m = l.reduce((a, b) => a + b, 0) / l.length; return l.map((x) => x - m); };
const clrInv = (z) => { const e = z.map(Math.exp); const t = e.reduce((a, b) => a + b, 0); return e.map((x) => x / t); };
const sub = (v6) => { const m = mainIdx.map((i) => v6[i]); const t = m.reduce((a, b) => a + b, 0); return m.map((x) => x / t); };
const withSub = (v6, m) => {
  const out = new Array(pc.length).fill(0);
  out[ai] = Math.max(v6[ai], 1e-6);
  mainIdx.forEach((i, k) => { out[i] = m[k] * (1 - out[ai]); });
  return out;
};

// Parts d'un groupe pour une élection : moyenne pondérée des vagues, ou dernière vague.
function groupShares(year, g, mode) {
  const waves = mode === "dernière" ? cross[year].waves.slice(-1) : cross[year].waves;
  const acc = Object.fromEntries(MAIN.map((p) => [p, 0])); let N = 0;
  for (const w of waves) { const x = w.groups[g]; for (const p of MAIN) acc[p] += x.n * x.shares[p]; N += x.n; }
  const v = MAIN.map((p) => Math.max(acc[p] / N, 0.5));
  const t = v.reduce((a, b) => a + b, 0);
  return v.map((x) => x / t);
}

const LANG = [["franco", (c) => c.franco], ["nonfranco", (c) => 1 - c.franco]];
const AGE = [["a18_34", (c) => c.a18_34], ["a35_54", (c) => c.a35_54], ["a55p", (c) => c.a55p]];
const TRANSITIONS = [
  { label: "2014->2018", y0: "2014", y1: "2018", base: ["2014-04-07", "2011"], target: ["2018-10-01", "2017"], map: "2017" },
  { label: "2018->2022", y0: "2018", y1: "2022", base: ["2018-10-01", "2017"], target: ["2022-10-03", "2017"], map: "2017" },
  { label: "2022->2026", y0: "2022", y1: "2026", base: ["2022-10-03", "2026"], target: ["2026-10-05", "2026"], map: "2026" },
];

function truthShares(date, boundary) {
  const out = new Map();
  for (const r of rows) {
    if (r.election_date !== date || String(r.boundary_year) !== boundary) continue;
    const p = pc.includes(r.party_code) ? r.party_code : "AUTRES";
    const k = String(r.riding_code);
    if (!out.has(k)) out.set(k, Object.fromEntries(pc.map((q) => [q, 0])));
    out.get(k)[p] += r.votes;
  }
  for (const v of out.values()) { const t = pc.reduce((s, p) => s + v[p], 0); for (const p of pc) v[p] /= t; }
  return out;
}
const winnerOf = (sh) => MAIN.reduce((b, p) => ((sh[p] ?? 0) > (sh[b] ?? 0) ? p : b), MAIN[0]);

function prepare(t, mode) {
  const baseState = electionState(rows, ...t.base, pc);
  const shift = provincialDelta(baseState, electionState(rows, ...t.target, pc), pc);
  const swung = new Map(baseState.keys.map((k) => [String(k), ilrInv([baseState.ilr.get(k).map((v, j) => v + shift[j])])[0]]));
  const truth = truthShares(...t.target);
  const C = comp[t.map];
  const codes = [...swung.keys()].filter((c) => truth.has(c) && C[c]);
  const dimAdj = (groups) => {
    const D = groups.map(([g]) => { const a = clr(groupShares(t.y0, g, mode)), b = clr(groupShares(t.y1, g, mode)); return b.map((v, j) => v - a[j]); });
    const mean = groups.map(([, f]) => codes.reduce((s, c) => s + f(C[c]), 0) / codes.length);
    const Dbar = Array.from({ length: P }, (_, j) => D.reduce((s, d, i) => s + mean[i] * d[j], 0));
    return new Map(codes.map((c) => [c, Array.from({ length: P }, (_, j) => groups.reduce((s, [, f], i) => s + f(C[c]) * (D[i][j] - Dbar[j]), 0))]));
  };
  const actualSeats = Object.fromEntries(MAIN.map((p) => [p, 0]));
  for (const c of codes) actualSeats[winnerOf(truth.get(c))]++;
  return { ...t, swung, truth, codes, adjL: dimAdj(LANG), adjA: dimAdj(AGE), actualSeats };
}

/** kL : nombre (commun) ou tableau par parti (ordre MAIN). */
function evaluate(T, kL, kA) {
  const kv = Array.isArray(kL) ? kL : new Array(P).fill(kL);
  let se = 0, n = 0, correct = 0;
  const mae = Object.fromEntries(MAIN.map((p) => [p, 0])), seats = Object.fromEntries(MAIN.map((p) => [p, 0]));
  for (const c of T.codes) {
    const v6 = T.swung.get(c);
    const z = clr(sub(v6)).map((v, j) => v + kv[j] * T.adjL.get(c)[j] + kA * T.adjA.get(c)[j]);
    const sh6 = withSub(v6, clrInv(z));
    const f = Object.fromEntries(pc.map((p, i) => [p, sh6[i]])), t = T.truth.get(c);
    for (const p of MAIN) { const d = (f[p] - t[p]) * 100; se += d * d; n++; mae[p] += Math.abs(d) / T.codes.length; }
    const w = winnerOf(f); seats[w]++; if (w === winnerOf(t)) correct++;
  }
  return { rmse: Math.sqrt(se / n), mae, correct, seatErr: MAIN.reduce((s, p) => s + Math.abs(seats[p] - T.actualSeats[p]), 0) };
}

const GRID = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
// Ts : une ou plusieurs transitions (somme des erreurs quadratiques).
const sseOf = (Ts, kL, kA) => Ts.reduce((s, T) => s + evaluate(T, kL, kA).rmse ** 2 * T.codes.length, 0);
function fitCommon(Ts, withAge) {
  Ts = [].concat(Ts);
  let b = null;
  for (const kL of GRID) for (const kA of withAge ? GRID : [0]) { const e = sseOf(Ts, kL, kA); if (!b || e < b.e) b = { kL, kA, e }; }
  return { ...b, rmse: Math.sqrt(b.e / Ts.reduce((s, T) => s + T.codes.length, 0)) };
}
// Descente par coordonnées sur la grille ; Ts : une ou plusieurs transitions
// (somme des erreurs quadratiques).
function fitPerParty(Ts) {
  Ts = [].concat(Ts);
  const sse = (k) => Ts.reduce((s, T) => s + evaluate(T, k, 0).rmse ** 2 * T.codes.length, 0);
  let k = new Array(P).fill(0);
  for (let it = 0; it < 4; it++) for (let j = 0; j < P; j++) {
    let best = null;
    for (const g of GRID) { const kk = [...k]; kk[j] = g; const e = sse(kk); if (!best || e < best.e) best = { g, e }; }
    k[j] = best.g;
  }
  return { kL: k, kA: 0, rmse: Math.sqrt(sse(k) / Ts.reduce((s, T) => s + T.codes.length, 0)) };
}

const fmt = (r, n) => `${r.rmse.toFixed(2).padStart(6)}  ${MAIN.map((p) => r.mae[p].toFixed(2).padStart(5)).join(" ")}  ${String(r.correct).padStart(3)}/${n}  ${String(r.seatErr).padStart(3)}`;
const kStr = (k) => (Array.isArray(k) ? `[${k.join(",")}]` : String(k));

for (const mode of ["moyenne des vagues", "dernière"]) {
  const Ts = TRANSITIONS.map((t) => prepare(t, mode));
  console.log(`\n##### Ventilations : ${mode} #####`);
  console.log(`  transition   variante            coefficients (choisis sur les autres)   RMSE   ${MAIN.map((p) => p.padStart(5)).join(" ")}  gagn.   err`);
  for (const [i, T] of Ts.entries()) {
    const O = Ts.filter((_, j) => j !== i);
    const arms = [
      ["report pur", { kL: 0, kA: 0 }],
      ["langue commune", fitCommon(O, false)],
      ["langue + âge", fitCommon(O, true)],
      ["langue par parti", fitPerParty(O)],
    ];
    for (const [label, k] of arms) {
      console.log(`  ${T.label}  ${label.padEnd(18)}  kL=${kStr(k.kL).padEnd(22)} kA=${String(k.kA).padEnd(5)}  ${fmt(evaluate(T, k.kL, k.kA), T.codes.length)}`);
    }
  }
  const pooled = fitPerParty(Ts);
  console.log(`  par parti, estimation conjointe sur toutes les transitions : ${MAIN.map((p, j) => `${p} ${pooled.kL[j]}`).join(", ")}`);
  for (const T of Ts) console.log(`    ${T.label} : ${fmt(evaluate(T, pooled.kL, 0), T.codes.length)}`);
  console.log("  coefficients in-sample :");
  for (const T of Ts) {
    const c = fitCommon(T, true), pp = fitPerParty(T);
    console.log(`    ${T.label} : commun kL=${c.kL} kA=${c.kA} (RMSE ${c.rmse.toFixed(2)}) ; par parti ${MAIN.map((p, j) => `${p} ${pp.kL[j]}`).join(", ")} (RMSE ${pp.rmse.toFixed(2)})`);
  }
}

// --- Paramètre de production : kL commun, estimé conjointement ---------------
// Ventilations en moyenne des vagues, âge exclu (gain nul en validation
// croisée), un seul coefficient commun aux partis (le coefficient par parti
// bute sur la grille et dégrade la part du parti qu'il ajuste).
{
  const { writeFileSync } = await import("node:fs");
  const Ts = TRANSITIONS.map((t) => prepare(t, "moyenne des vagues"));
  let best = null;
  for (const kL of GRID) {
    const sse = sseOf(Ts, kL, 0);
    if (!best || sse < best.sse) best = { kL, sse };
  }
  const loto = Ts.map((T, i) => {
    const k = fitCommon(Ts.filter((_, j) => j !== i), false).kL;
    return { transition: T.label, kChoisiSurLesAutres: k, rmseReportPur: +evaluate(T, 0, 0).rmse.toFixed(3), rmseLangue: +evaluate(T, k, 0).rmse.toFixed(3) };
  });
  const out = {
    note: "Coefficient du swing par langue maternelle (tools/group_swing_test.mjs) : variation CLR des intentions francophones et non-francophones entre les veilles Léger, appliquée selon la composition linguistique du recensement 2021, centrée sur la moyenne des circonscriptions. kappa = 0 : report pur.",
    kappa: best.kL,
    estimatedOn: Ts.map((T) => T.label),
    grid: GRID,
    validation: loto,
  };
  writeFileSync(new URL("../data/qc_language_swing.json", import.meta.url), JSON.stringify(out, null, 1));
  console.log(`\nkappa commun conjoint : ${best.kL} ; validation croisée : ${JSON.stringify(loto)}`);
}
