/**
 * Effet de chef (arrivée, continuation, départ) estimé sur les élections
 * générales 1976-2026 et écrit dans js/data/qc_leader_effect.json pour le
 * cycle courant (qc_cycles.json).
 *
 * Cas : 1976-2014 dans js/data/qc_leader_cases_1970_2014.json (Atlas, une
 * carte par paire d'élections) ; 2018, 2022 et 2026 recalculés ici sur les
 * paires de transition de tools/lib/transitionEval.mjs (2014 carte 2011 ->
 * 2018 carte 2017, 2018 -> 2022 carte 2017, 2022 -> 2026 carte 2026),
 * appariées par circonscription. Excès = log(part réelle / part prévue par le swing
 * provincial uniforme ILR) du parti du chef. Définitions identiques à celles
 * que computeProjection applique (voir le fichier des cas).
 *
 * Deux spécifications par type : moyenne plate (hypothèse nulle) et GP
 * (Matérn 3/2 + bruit blanc) sur l'année centrée-réduite. Comparaison par
 * validation croisée par élection et par prévision séquentielle (chaque
 * élection prédite avec les seules élections antérieures), log-densité
 * prédictive. La spécification retenue est celle de la meilleure prévision
 * séquentielle, l'usage réel étant une extrapolation.
 *
 * Run: node js/tools/build_leader_effect.mjs [--write]   (from the repo root)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ml, mva } from "@tangent.to/ds";
import { pc, TRANSITIONS } from "./lib/transitionEval.mjs";
import { loadAllRows } from "./lib/harness.mjs";
import { sharesByRiding, ilrMatrix } from "../src/ridingEffects.js";
const { ilrInv } = mva.composition;
const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf-8"));

const MIN_BASE_SHARE = 0.04;
// Chefs des élections 2018, 2022, 2026 (classement selon les définitions du
// fichier des cas ; nouveaux chefs dans leur propre siège exclus : Lisée
// 2018, Massé et Nadeau-Dubois 2018, Anglade 2022, Ghazal 2026 ; PCQ 2018 et
// 2022 exclu, sous 4 % à l'élection précédente).
const RECENT = {
  T1: [["continuation", "CAQ", "L'Assomption", "François Legault"], ["continuation", "LIB", "Roberval", "Philippe Couillard"],
    ["depart", "PQ", "Charlevoix-Côte-de-Beaupré", "Pauline Marois"]],
  T2: [["continuation", "CAQ", "L'Assomption", "François Legault"], ["continuation", "QS", "Gouin", "Gabriel Nadeau-Dubois"],
    ["arrivee", "PQ", "Camille-Laurin", "Paul St-Pierre Plamondon"],
    ["depart", "LIB", "Roberval", "Philippe Couillard"], ["depart", "PQ", "Rosemont", "Jean-François Lisée"]],
  T3: [["arrivee", "CAQ", "Trois-Rivières", "Christine Fréchette"], ["arrivee", "LIB", "Orford", "Charles Milliard"], ["arrivee", "PCQ", "Bellechasse", "Éric Duhaime"],
    ["continuation", "PQ", "Camille-Laurin", "Paul St-Pierre Plamondon"],
    ["depart", "CAQ", "L'Assomption", "François Legault"], ["depart", "LIB", "Saint-Henri–Sainte-Anne", "Dominique Anglade"],
    ["depart", "QS", "Gouin", "Gabriel Nadeau-Dubois"], ["depart", "PCQ", "Chauveau", "Éric Duhaime"]],
};
// Circonscription renommée sans changement de limites (carte 2017).
const RENAMED = { "Camille-Laurin": ["Bourget"] };
const nk = (s) => String(s).normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
const codeByName = (map) => new Map(load(`qc_riding_features_${map}.json`).filter((f) => f.riding_name).map((f) => [nk(f.riding_name), String(Number(f.riding_code))]));

const rows = loadAllRows();
const provShares = (date, boundary) => {
  const v = pc.map(() => 0);
  for (const r of rows) if (r.election_date === date && String(r.boundary_year) === boundary) v[pc.includes(r.party_code) ? pc.indexOf(r.party_code) : pc.indexOf("AUTRES")] += r.votes;
  const t = v.reduce((a, b) => a + b, 0); return v.map((x) => x / t);
};
const cases = load("qc_leader_cases_1970_2014.json").cases.map((c) => ({ ...c }));
for (const T of TRANSITIONS) {
  const A = sharesByRiding(rows, ...T.base, pc), B = sharesByRiding(rows, ...T.target, pc);
  const p0 = provShares(...T.base), p1 = provShares(...T.target);
  const [i0, i1] = ilrMatrix([p0, p1]); const sProv = i1.map((v, k) => v - i0[k]);
  const byName = codeByName(T.map);
  const keyIn = (M, riding) => [...M.keys()].find((k) => [riding, ...(RENAMED[riding] ?? [])].some((r) => nk(k) === nk(r) || String(k) === byName.get(nk(r))));
  for (const [type, party, riding, chef] of RECENT[T.id]) {
    const j = pc.indexOf(party);
    if (p0[j] < MIN_BASE_SHARE) continue;
    const ka = keyIn(A, riding), kb = keyIn(B, riding);
    if (!ka || !kb) throw new Error(`${T.id} : circonscription introuvable ${riding}`);
    const pred = ilrInv([ilrMatrix([A.get(ka)])[0].map((v, k) => v + sProv[k])])[0][j];
    cases.push({ annee: Number(T.y1), annee_precedente: Number(T.y0), chef, parti: party, circonscription: riding, type, exces_log: Math.log(B.get(kb)[j] / pred) });
  }
}
for (const c of cases.filter((c) => c.annee >= 2018)) console.log(`${c.annee} ${c.type.padEnd(12)} ${c.parti.padEnd(4)} ${c.circonscription.padEnd(28)} ${c.exces_log.toFixed(3)}`);

const TYPES = ["arrivee", "continuation", "depart"];
const years = cases.map((c) => c.annee), mu = years.reduce((a, b) => a + b, 0) / years.length;
const sd = Math.sqrt(years.reduce((s, y) => s + (y - mu) ** 2, 0) / (years.length - 1));
const z = (y) => (y - mu) / sd;
const lpd = (y, m, s) => -0.5 * Math.log(2 * Math.PI * s * s) - ((y - m) ** 2) / (2 * s * s);

function flat(train) {
  const y = train.map((c) => c.exces_log), n = y.length, m = y.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? y.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1) : 0.25;
  return (yr) => ({ mean: m, sd: Math.sqrt(v * (1 + 1 / n)) });
}
function gp(train) {
  const y = train.map((c) => c.exces_log);
  if (train.length < 4) return flat(train);
  const model = new ml.GaussianProcessRegressor({
    kernel: new ml.SumKernel({ kernels: [new ml.Matern({ lengthScale: 1, nu: 1.5, amplitude: 1 }), new ml.WhiteKernel(1)] }),
    normalizeY: true, optimize: true, nRestarts: 4, randomState: 0,
  });
  model.fit(train.map((c) => [z(c.annee)]), y);
  return (yr) => { const r = model.predict([[z(yr)]], { returnStd: true }); return { mean: r.mean[0], sd: r.std[0] }; };
}
const SPECS = { plate: flat, gp };

const score = {};
for (const type of TYPES) {
  const cs = cases.filter((c) => c.type === type), ys = [...new Set(cs.map((c) => c.annee))].sort();
  for (const [name, fit] of Object.entries(SPECS)) {
    let loeo = 0, seq = 0, nSeq = 0;
    for (const y of ys) {
      const test = cs.filter((c) => c.annee === y);
      const f1 = fit(cs.filter((c) => c.annee !== y));
      for (const c of test) { const p = f1(y); loeo += lpd(c.exces_log, p.mean, p.sd); }
      const past = cs.filter((c) => c.annee < y);
      if (past.length >= 3) { const f2 = fit(past); for (const c of test) { const p = f2(y); seq += lpd(c.exces_log, p.mean, p.sd); nSeq++; } }
    }
    score[type] ??= {}; score[type][name] = { loeo, seq, nSeq };
  }
  console.log(`${type.padEnd(12)} n=${cs.length}  ` + Object.entries(score[type]).map(([k, s]) => `${k} : LOEO ${s.loeo.toFixed(2)}, séquentiel ${s.seq.toFixed(2)} (${s.nSeq} cas)`).join(" | "));
}

const cycle = load("qc_cycles.json").cycle;
const effects = {};
for (const type of TYPES) {
  const cs = cases.filter((c) => c.type === type);
  const best = score[type].gp.seq > score[type].plate.seq ? "gp" : "plate";
  const p = SPECS[best](cs)(cycle);
  effects[type] = { n: cs.length, specification: best, [`delta_${cycle}`]: p.mean, [`sd_${cycle}`]: p.sd, flat_mean: flat(cs)(cycle).mean };
  console.log(`${type.padEnd(12)} retenu ${best} : delta_${cycle} ${p.mean.toFixed(3)} ± ${p.sd.toFixed(3)} (facteur ${Math.exp(p.mean).toFixed(3)})`);
}
if (process.argv.includes("--write")) {
  writeFileSync(new URL("../data/qc_leader_effect.json", import.meta.url), JSON.stringify({
    target_year: cycle, effects,
    note: "exces log vs contrefactuel de swing uniforme ILR, 1976-2026 ; moyenne plate ou GP Matern sur l annee selon la prevision sequentielle (tools/build_leader_effect.mjs)",
  }, null, 2));
  console.log("-> js/data/qc_leader_effect.json");
}
