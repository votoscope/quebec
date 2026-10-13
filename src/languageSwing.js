/**
 * Swing par langue maternelle mesuré dans les sondages.
 *
 * Les ventilations francophones / non-francophones de Léger donnent, pour
 * chaque groupe, la variation log-ratio (CLR de la sous-composition des
 * cinq partis principaux) entre la fin de campagne de l'élection précédente
 * et les deux dernières vagues disponibles à la date du calcul (moyenne
 * pondérée par n). Chaque circonscription reçoit le mélange de ces
 * variations selon sa composition linguistique (recensement 2021), centré
 * sur la moyenne des circonscriptions, multiplié par kappa. kappa est
 * estimé conjointement sur les transitions 2014->2018, 2018->2022 et
 * 2022->2026 (tools/group_swing_test.mjs -> data/qc_language_swing.json) ;
 * kappa = 0 redonne le report sans ajustement.
 */

import { mva } from "@tangent.to/ds";
import { sharesByRiding } from "./ridingEffects.js";

// ILR après remplacement multiplicatif des zéros (Martín-Fernández et al.,
// 2003) : zéro -> delta, part non nulle x -> x (1 - nz delta). Identique au
// calcul de ridingEffects.ilrMatrix pour une composition sans zéro.
function ilrRows(rows) {
  const k = rows[0].length, delta = (1 / k) ** 2;
  const fixed = rows.map((r) => {
    const t = r.reduce((a, b) => a + b, 0), c = r.map((x) => x / t);
    const nz = c.filter((x) => x <= 0).length;
    return c.map((x) => (x <= 0 ? delta : x * (1 - nz * delta)));
  });
  return mva.composition.ilr(fixed);
}

export const LANGUAGE_PARTIES = ["CAQ", "LIB", "PCQ", "PQ", "QS"];
const GROUPS = [["franco", (c) => c.franco], ["nonfranco", (c) => 1 - c.franco]];

const clr = (v) => { const l = v.map((x) => Math.log(Math.max(x, 1e-4))); const m = l.reduce((a, b) => a + b, 0) / l.length; return l.map((x) => x - m); };
const clrInv = (z) => { const e = z.map(Math.exp); const t = e.reduce((a, b) => a + b, 0); return e.map((x) => x / t); };

function pooledShares(waves, group) {
  const acc = Object.fromEntries(LANGUAGE_PARTIES.map((p) => [p, 0])); let N = 0;
  for (const w of waves) {
    const x = w.groups[group]; if (!x) continue;
    for (const p of LANGUAGE_PARTIES) acc[p] += x.n * (x.shares[p] ?? 0);
    N += x.n;
  }
  if (!N) return null;
  const v = LANGUAGE_PARTIES.map((p) => Math.max(acc[p] / N, 0.5));
  const t = v.reduce((a, b) => a + b, 0);
  return v.map((x) => x / t);
}

/**
 * @param {Object} crosstabs qc_leger_crosstabs.json
 * @param {Object} composition {riding_code: {franco, ...}} (carte courante)
 * @param {{previousYear: string, currentYear: string, asOf: string, kappa: number, nWaves?: number,
 *   regionOf?: (code: string) => string|null}} opts  regionOf : quand le niveau de
 *   chaque région est fixé par ailleurs (sondages régionaux), l'ajustement est
 *   centré sur la moyenne de sa région et ne porte que la structure intra-région
 * @returns {{adj: Map<string, number[]>, waves: string[]} | null} ajustement CLR
 *   par circonscription, ordre LANGUAGE_PARTIES ; null si les ventilations manquent
 */
export function languageAdjustments(crosstabs, composition, { previousYear, currentYear, asOf, kappa, nWaves = 2, regionOf = null }) {
  const prev = crosstabs?.[previousYear]?.waves;
  const curr = (crosstabs?.[currentYear]?.waves ?? []).filter((w) => w.date <= asOf).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-nWaves);
  if (!prev?.length || !curr.length || !kappa) return null;
  const prevFinal = prev.slice(-nWaves);
  const D = GROUPS.map(([g]) => {
    const a = pooledShares(prevFinal, g), b = pooledShares(curr, g);
    return a && b ? clr(b).map((v, j) => v - clr(a)[j]) : null;
  });
  if (D.some((d) => !d)) return null;
  const codes = Object.keys(composition);
  const mean = GROUPS.map(([, f]) => codes.reduce((s, c) => s + f(composition[c]), 0) / codes.length);
  const Dbar = LANGUAGE_PARTIES.map((_, j) => D.reduce((s, d, i) => s + mean[i] * d[j], 0));
  const adj = new Map(codes.map((c) => [String(c), LANGUAGE_PARTIES.map((_, j) =>
    kappa * GROUPS.reduce((s, [, f], i) => s + f(composition[c]) * (D[i][j] - Dbar[j]), 0))]));
  if (regionOf) {
    const sums = new Map();
    for (const [c, a] of adj) {
      const reg = regionOf(c); if (!reg) continue;
      const s0 = sums.get(reg) ?? { n: 0, v: LANGUAGE_PARTIES.map(() => 0) };
      s0.n++; a.forEach((x, j) => { s0.v[j] += x; }); sums.set(reg, s0);
    }
    for (const [c, a] of adj) {
      const s0 = sums.get(regionOf(c)); if (!s0) continue;
      adj.set(c, a.map((x, j) => x - s0.v[j] / s0.n));
    }
  }
  return { adj, waves: curr.map((w) => w.date) };
}

/** Applique un ajustement CLR à la sous-composition des cinq partis d'un
 * vecteur de parts (ordre partyCodes), les autres parties tenues fixes. */
export function applyLanguageAdjustment(shares, partyCodes, adj) {
  // Seules les parties présentes sont ajustées : une part nulle (parti sans
  // candidat) reste nulle, le traitement des zéros en aval restant inchangé.
  const idx = LANGUAGE_PARTIES.map((p) => partyCodes.indexOf(p)).filter((i) => i >= 0);
  const live = idx.map((i, j) => [i, j]).filter(([i]) => shares[i] > 0);
  if (live.length < 2) return shares;
  const tot = live.reduce((s, [i]) => s + shares[i], 0);
  const z = clr(live.map(([i]) => shares[i] / tot)).map((v, k) => v + adj[live[k][1]]);
  const moved = clrInv(z.map((v, k, a) => v - a.reduce((s, x) => s + x, 0) / a.length));
  const out = [...shares];
  live.forEach(([i], k) => { out[i] = moved[k] * tot; });
  return out;
}

/**
 * Erreurs du modèle « swing + langue » sur une transition passée, en ILR,
 * centrées : ilr(B) - ilr(A ajusté de la langue) - moyenne. Elles forment le
 * bassin des déviations idiosyncrasiques de la simulation quand ce modèle
 * fournit la moyenne (les écarts bruts au swing compteraient deux fois la
 * part linguistique).
 * @param {Array} rows résultats (election_date, boundary_year, riding_code, party_code, votes)
 * @param {[string, string, string, string]} transition [dateA, carteA, dateB, carteB]
 * @returns {{ridings: string[], Y: number[][]}}
 */
export function languageResiduals(rows, [dA, bA, dB, bB], partyCodes, crosstabs, compositionMap, kappa) {
  const a = sharesByRiding(rows, dA, bA, partyCodes), b = sharesByRiding(rows, dB, bB, partyCodes);
  const keys = [...a.keys()].filter((k) => b.has(k));
  const lang = compositionMap?.[bB] && kappa
    ? languageAdjustments(crosstabs, compositionMap[bB], { previousYear: dA.slice(0, 4), currentYear: dB.slice(0, 4), asOf: dB, kappa })
    : null;
  const adjA = keys.map((k) => { const adj = lang?.adj.get(String(k)); return adj ? applyLanguageAdjustment(a.get(k), partyCodes, adj) : a.get(k); });
  const ia = ilrRows(adjA), ib = ilrRows(keys.map((k) => b.get(k)));
  const d = ib.map((row, i) => row.map((v, j) => v - ia[i][j]));
  const m = d[0].map((_, j) => d.reduce((s, r) => s + r[j], 0) / d.length);
  return { ridings: keys, Y: d.map((r) => r.map((v, j) => v - m[j])) };
}
