/**
 * Facteurs d'échelle par parti du bassin de résidus de la simulation
 * (tools/lib/transitionEval.mjs fitResidualScale) sur les transitions du
 * bassin de production (qc_cycles.json residualTransitions), au kappa de
 * production (qc_language_swing.json). Écrit js/data/qc_residual_scale.json.
 * Validation : tools/explore_spatial.mjs --calibre=1 (trois plis).
 *
 * Run: node js/tools/residual_scale_fit.mjs   (from the repo root)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildData, fitResidualScale } from "./lib/transitionEval.mjs";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const cycles = load("../data/qc_cycles.json");
const sw = load("../data/qc_language_swing.json");
const kappa = { L: sw.kappa, R: sw.kappaRegion }; // moyennes de production : langue et régions
const DATA = await buildData();
const trs = DATA.filter((T) => cycles.residualTransitions.some((t) => t[0] === T.base[0] && t[2] === T.target[0]));
const fit = fitResidualScale(trs, kappa);
// L écrêtage (clip), choisi séparément par tools/winsor_test.mjs, est conservé.
let previous = {};
try { previous = load("../data/qc_residual_scale.json"); } catch { /* premier calcul */ }
const out = {
  note: "Facteurs d'échelle par parti (CLR) appliqués au bassin de résidus de la simulation ; 1 = bassin tel quel. Estimés hors échantillon : les erreurs de chaque transition du bassin prédisent les autres, log-score des gagnants à vote provincial connu (tools/residual_scale_fit.mjs).",
  estimatedOn: trs.map((T) => T.id), kappa, ...fit,
  ...(previous.clip !== undefined ? { clip: previous.clip, clipNote: previous.clipNote } : {}),
};
writeFileSync(new URL("../data/qc_residual_scale.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
