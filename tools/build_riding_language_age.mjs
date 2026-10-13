/**
 * Composition linguistique (langue maternelle) et par âge (adultes) des
 * circonscriptions des cartes 2017 et 2026, agrégée des aires de diffusion
 * du recensement 2021 (js/data/qc_census_da_2021.json, extrait par
 * tools/extract_census_da.mjs) selon leur rattachement
 * (js/data/qc_da_riding.json, tools/build_da_riding.mjs).
 *
 * Sortie : js/data/qc_riding_language_age.json
 *   { "2026": {code: {fr, en, other, franco, a18_34, a35_54, a55p,
 *     adults}}, "2017": {nom: {...}} }
 *   franco = part de langue maternelle française ; a* = parts des adultes.
 *
 * Run: node js/tools/build_riding_language_age.mjs   (from the repo root)
 */

import { readFileSync, writeFileSync } from "node:fs";

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const census = load("../data/qc_census_da_2021.json");
const daRiding = load("../data/qc_da_riding.json");

const out = {};
for (const map of ["2017", "2026"]) {
  const acc = {};
  let miss = 0;
  for (const [da, riding] of Object.entries(daRiding[map])) {
    const c = census[da];
    if (!c) { miss++; continue; }
    const a = (acc[riding] ??= { fr: 0, en: 0, other: 0, a18_34: 0, a35_54: 0, a55p: 0 });
    for (const k of Object.keys(a)) a[k] += c[k];
  }
  out[map] = Object.fromEntries(Object.entries(acc).map(([r, a]) => {
    const mt = a.fr + a.en + a.other, ad = a.a18_34 + a.a35_54 + a.a55p;
    return [r, {
      franco: +(a.fr / mt).toFixed(4), en: +(a.en / mt).toFixed(4), other: +(a.other / mt).toFixed(4),
      a18_34: +(a.a18_34 / ad).toFixed(4), a35_54: +(a.a35_54 / ad).toFixed(4), a55p: +(a.a55p / ad).toFixed(4),
      adults: Math.round(ad),
    }];
  }));
  const vals = Object.values(out[map]);
  const rng = (k) => `${Math.min(...vals.map((v) => v[k])).toFixed(2)}-${Math.max(...vals.map((v) => v[k])).toFixed(2)}`;
  const sd = (k) => { const m = vals.reduce((s, v) => s + v[k], 0) / vals.length; return Math.sqrt(vals.reduce((s, v) => s + (v[k] - m) ** 2, 0) / vals.length).toFixed(3); };
  console.log(`carte ${map} : ${vals.length} circonscriptions (${miss} AD sans profil) ; franco ${rng("franco")} (é.-t. ${sd("franco")}), 18-34 ${rng("a18_34")} (é.-t. ${sd("a18_34")}), 55+ ${rng("a55p")} (é.-t. ${sd("a55p")})`);
}
writeFileSync(new URL("../data/qc_riding_language_age.json", import.meta.url), JSON.stringify(out, null, 1));
