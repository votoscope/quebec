/**
 * Ajustement régional par les ventilations régionales des sondages.
 *
 * Les ventilations régionales publiées (RMR de Montréal, RMR de Québec,
 * reste du Québec), toutes firmes, postérieures à l'élection précédente et
 * antérieures à la date du calcul, sont regroupées par région avec le poids
 * n * exp(-âge / tau) (n : effectif régional). L'âge est mesuré sur
 * l'horloge du GP national : jours écoulés + (dilation - 1) * jours de
 * campagne écoulés. tau et dilation sont estimés par prévision un pas en
 * avant de l'écart région - province de chaque sondage, sondages 2018-2026
 * (tools/regional_decay_test.mjs). Pour
 * chaque région, l'écart région-province de ces sondages (log-ratios centrés
 * des cinq partis principaux) moins le même écart dans les résultats de
 * l'élection précédente, multiplié par kappa, déplace les circonscriptions
 * de la région. La province est la moyenne des régions pondérée par leurs
 * votes de l'élection précédente. kappa est estimé avec le coefficient du
 * swing par langue sur les transitions 2014->2018, 2018->2022 et
 * 2022->2026 (tools/regional_decay_test.mjs) ; kappa = 0 : aucun
 * ajustement.
 */

import { LANGUAGE_PARTIES } from "./languageSwing.js";

const REGIONS = ["MTL", "QC", "REG"];
const clr = (v) => { const l = v.map((x) => Math.log(Math.max(x, 1e-4))); const m = l.reduce((a, b) => a + b, 0) / l.length; return l.map((x) => x - m); };

/**
 * @param {Array} regionalPollRows lignes {poll_id, region_code, poll_date, sample_size, party_code, pct_reported}
 * @param {Map<string, number[]>} baselineMap circonscription -> parts (ordre partyCodes), élection précédente
 * @param {Map<string, number>} baselineVotes circonscription -> votes valides, élection précédente
 * @param {Map<string, string>} regionByCode circonscription -> MTL | QC | REG
 * @param {string[]} partyCodes
 * @param {{asOf: string, kappa: number, tau: number, dilation?: number, campaigns?: string[][], after?: string}} opts
 *   tau : constante de décroissance (jours de l'horloge dilatée) ;
 *   dilation : un jour de campagne compte pour `dilation` jours ;
 *   campaigns : fenêtres [déclenchement, scrutin] ;
 *   after : date de l'élection précédente ; seuls les sondages postérieurs
 *   comptent (ceux du cycle précédent sont déjà dans la baseline)
 * @returns {{adj: Object<string, number[]>, nPolls: number} | null} ajustement CLR par région (ordre LANGUAGE_PARTIES)
 */
export function regionalPollAdjustments(regionalPollRows, baselineMap, baselineVotes, regionByCode, partyCodes, { asOf, kappa, tau, dilation = 1, campaigns = [], after = null }) {
  if (!kappa || !tau || !regionalPollRows?.length) return null;
  const day = (d) => Date.parse(d) / 86_400_000;
  const campaignDays = (t) => campaigns.reduce((c, [a, b]) => c + Math.max(0, Math.min(t, day(b)) - day(a)), 0);
  const tNow = day(asOf), cNow = campaignDays(tNow);
  const byPoll = new Map();
  for (const r of regionalPollRows) {
    if (r.poll_date > asOf || (after && r.poll_date <= after) || !REGIONS.includes(r.region_code)) continue;
    const key = `${r.poll_id}|${r.region_code}`;
    if (!byPoll.has(key)) {
      const t = day(r.poll_date);
      const age = (tNow - t) + (dilation - 1) * (cNow - campaignDays(t));
      byPoll.set(key, { region: r.region_code, poll: `${r.firm}|${r.poll_date}`, n: (r.sample_size || 0) * Math.exp(-age / tau), shares: {} });
    }
    byPoll.get(key).shares[r.party_code] = r.pct_reported;
  }
  const pooled = {}; const polls = new Set();
  for (const reg of REGIONS) {
    const acc = Object.fromEntries(LANGUAGE_PARTIES.map((p) => [p, 0])); let N = 0;
    for (const [key, p] of byPoll) {
      if (p.region !== reg || !p.n) continue;
      for (const party of LANGUAGE_PARTIES) acc[party] += p.n * (p.shares[party] ?? 0);
      N += p.n; polls.add(p.poll);
    }
    if (!N) return null;
    pooled[reg] = LANGUAGE_PARTIES.map((p) => Math.max(acc[p] / N, 0.5));
  }
  // Votes et parts régionales de l'élection précédente.
  const idx = LANGUAGE_PARTIES.map((p) => partyCodes.indexOf(p));
  const prevVotes = {}, W = {};
  for (const [code, shares] of baselineMap) {
    const reg = regionByCode.get(String(code)); if (!reg) continue;
    const w = baselineVotes.get(String(code)) ?? 1;
    prevVotes[reg] ??= LANGUAGE_PARTIES.map(() => 0);
    idx.forEach((i, j) => { prevVotes[reg][j] += w * shares[i]; });
    W[reg] = (W[reg] ?? 0) + w;
  }
  const Wtot = REGIONS.reduce((s, r) => s + (W[r] ?? 0), 0);
  const prevProv = LANGUAGE_PARTIES.map((_, j) => REGIONS.reduce((s, r) => s + (prevVotes[r]?.[j] ?? 0), 0));
  const pollProv = LANGUAGE_PARTIES.map((_, j) => REGIONS.reduce((s, r) => s + ((W[r] ?? 0) / Wtot) * pooled[r][j], 0));
  const adj = {};
  for (const reg of REGIONS) {
    const devPoll = clr(pooled[reg]).map((v, j) => v - clr(pollProv)[j]);
    const devPrev = clr(prevVotes[reg]).map((v, j) => v - clr(prevProv)[j]);
    adj[reg] = devPoll.map((v, j) => kappa * (v - devPrev[j]));
  }
  return { adj, nPolls: polls.size };
}
