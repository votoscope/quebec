/**
 * Choc systémique commun de la simulation (data/qc_systemic.json) : écart
 * entre l'agrégat des sondages finaux et le résultat provincial (biais de
 * l'industrie), et dérive de l'opinion avec le temps. Les deux sont des
 * écarts-types scalaires (isotropes) en ILR, invariants par changement de
 * base orthonormée.
 *
 *  - Biais de l'industrie : moyenne des sondages des FENETRE jours précédant
 *    chaque scrutin (poids √n), contre le résultat provincial, sur la
 *    sous-composition des quatre partis principaux de toute la période
 *    (CAQ, PLQ, QS, PQ ; les petites parts dominent l'erreur en log-ratio
 *    sans déplacer de sièges) ; sigma_industry = moyenne quadratique sur les
 *    coordonnées et les scrutins.
 *  - Dérive : pour les paires de sondages d'un même cycle séparées de 7 à
 *    120 jours, var(ilr_a − ilr_b) = 2σ²_bruit + σ²_jour·Δt ; la pente d'un
 *    ajustement linéaire par classes de Δt donne σ²_jour (plancher à zéro).
 *
 * Run: node tools/build_systemic.mjs [--elections 2018-10-01,2022-10-03] [--write]
 * Prints the estimate; writes data/qc_systemic.json only with --write.
 */
import { readFileSync, writeFileSync } from "node:fs";

const DATA = new URL("../data/", import.meta.url);
const lire = (f) => JSON.parse(readFileSync(new URL(f, DATA), "utf-8"));
const arg = process.argv.indexOf("--elections");
const ELECTIONS = arg > 0 ? process.argv[arg + 1].split(",") : ["2018-10-01", "2022-10-03", "2026-10-05"];
const SORTIE = process.argv.includes("--write") ? "qc_systemic.json" : null;
const MAJEURS = ["CAQ", "LIB", "QS", "PQ"];
const FENETRE = 12;
const JOUR = 86_400_000;

/** ILR (base de Helmert) d'une composition, zéros remplacés multiplicativement. */
function ilr(parts) {
  const D = parts.length, delta = (1 / D) ** 2;
  const s = parts.reduce((a, b) => a + b, 0);
  const x = parts.map((v) => v / s);
  const nz = x.filter((v) => v === 0).length;
  const y = x.map((v) => (v === 0 ? delta : v * (1 - nz * delta)));
  const l = y.map(Math.log);
  return Array.from({ length: D - 1 }, (_, i) => {
    const k = i + 1, moy = l.slice(0, k).reduce((a, b) => a + b, 0) / k;
    return Math.sqrt(k / (k + 1)) * (moy - l[k]);
  });
}

// Sondages provinciaux, une ligne par sondage.
const parSondage = new Map();
for (const r of lire("qc_national_polls.json")) {
  if (!parSondage.has(r.poll_id)) parSondage.set(r.poll_id, { date: new Date(r.poll_date), n: r.sample_size, parts: {} });
  parSondage.get(r.poll_id).parts[r.party_code] = r.pct_reported;
}
const sondages = [...parSondage.values()]
  .filter((s) => MAJEURS.every((p) => s.parts[p] != null))
  .map((s) => ({ ...s, w: Math.sqrt(Math.max(s.n ?? 800, 1)), z: ilr(MAJEURS.map((p) => s.parts[p])) }))
  .sort((a, b) => a.date - b.date);

// Résultats provinciaux de chaque scrutin, sur sa carte d'origine.
const resultats = [...lire("qc_riding_results.json"), ...lire("qc_2026_results_2026map.json")];
const carte = { "2014-04-07": "2011", "2018-10-01": "2017", "2022-10-03": "2017", "2026-10-05": "2026" };
function provincial(election) {
  const v = Object.fromEntries(MAJEURS.map((p) => [p, 0]));
  for (const r of resultats) {
    if (r.election_date === election && r.boundary_year === carte[election] && v[r.party_code] != null) v[r.party_code] += r.votes;
  }
  return MAJEURS.map((p) => v[p]);
}

const parElection = [], carres = [];
for (const e of ELECTIONS) {
  const fin = new Date(e), debut = new Date(+fin - FENETRE * JOUR);
  const fen = sondages.filter((s) => s.date <= fin && s.date >= debut);
  if (fen.length < 2) continue;
  const W = fen.reduce((a, s) => a + s.w, 0);
  const agg = fen[0].z.map((_, c) => fen.reduce((a, s) => a + s.w * s.z[c], 0) / W);
  const err = ilr(provincial(e)).map((v, c) => v - agg[c]);
  carres.push(...err.map((x) => x * x));
  parElection.push({ election: e, n_final_polls: fen.length, rms_ilr: Math.sqrt(err.reduce((a, x) => a + x * x, 0) / err.length) });
}
const sigmaIndustry = Math.sqrt(carres.reduce((a, b) => a + b, 0) / carres.length);

// Dérive : paires d'un même cycle (frontières = scrutins retenus).
const bornes = ELECTIONS.map((e) => new Date(e));
const cycle = (d) => { const i = bornes.findIndex((b) => d <= b); return i < 0 ? bornes.length : i; };
const lags = [], ecarts = [];
for (let i = 0; i < sondages.length; i++) {
  for (let j = i + 1; j < sondages.length; j++) {
    const a = sondages[i], b = sondages[j];
    const dt = Math.round((b.date - a.date) / JOUR);
    if (dt > 120) break;
    if (dt < 7 || cycle(a.date) !== cycle(b.date)) continue;
    lags.push(dt);
    ecarts.push(a.z.reduce((s, v, c) => s + (b.z[c] - v) ** 2, 0) / a.z.length);
  }
}
const classes = [7, 14, 21, 30, 45, 60, 90, 120], bx = [], by = [];
for (let k = 0; k < classes.length - 1; k++) {
  const idx = lags.map((l, i) => (l >= classes[k] && l < classes[k + 1] ? i : -1)).filter((i) => i >= 0);
  if (idx.length >= 5) {
    bx.push(idx.reduce((a, i) => a + lags[i], 0) / idx.length);
    by.push(idx.reduce((a, i) => a + ecarts[i], 0) / idx.length);
  }
}
const mx = bx.reduce((a, b) => a + b, 0) / bx.length, my = by.reduce((a, b) => a + b, 0) / by.length;
const pente = bx.reduce((a, x, i) => a + (x - mx) * (by[i] - my), 0) / bx.reduce((a, x) => a + (x - mx) ** 2, 0);
const ordonnee = my - pente * mx;

const sortie = {
  sigma_industry: sigmaIndustry,
  sigma_daily2: Math.max(pente, 0),
  estimated_from: {
    industry: parElection,
    drift: { n_pairs: lags.length, noise_floor_ilr2: Math.max(ordonnee, 0), bins_used: bx.length },
    note: `isotropic ILR; industry RMS over ${parElection.length} elections`,
  },
};
console.log(JSON.stringify(sortie, null, 1));
if (SORTIE) writeFileSync(new URL(SORTIE, DATA), JSON.stringify(sortie, null, 2), "utf-8");
