/**
 * Extraction, par aire de diffusion (AD), de la langue maternelle et des
 * groupes d'âge du profil du recensement 2021 de Statistique Canada
 * (98-401-X2021006, Québec, CSV de 6,4 Go dans data/raw/lus/statcan_da_qc.zip).
 *
 * Lu en flux sur l'entrée standard :
 *   unzip -p data/raw/lus/statcan_da_qc.zip 98-401-X2021006_English_CSV_data_Quebec.csv \
 *     | node js/tools/extract_census_da.mjs
 *
 * Caractéristiques retenues (identifiants du profil 2021) :
 *   - langue maternelle (population hors institutions) : 393 total,
 *     396 anglais, 397 français, 719 anglais et français, 720 anglais et
 *     langue non officielle, 721 français et langue non officielle,
 *     722 anglais, français et langue non officielle ;
 *   - âge : 14 (15-19) à 33 (100 et plus), groupes de 5 ans.
 * Réponses multiples réparties à parts égales entre les langues déclarées.
 * Francophone = langue maternelle française (définition des ventilations
 * « franco. / non-franco. » de Léger, pondérées sur la langue maternelle).
 * Âge adulte : 18-19 ans = 2/5 du groupe 15-19.
 *
 * Sortie : js/data/qc_census_da_2021.json  { DAUID: {pop, fr, en, other,
 *   a18_34, a35_54, a55p} }
 */

import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const KEEP = new Set([1, 393, 396, 397, 719, 720, 721, 722, ...Array.from({ length: 20 }, (_, i) => 14 + i)]);
const out = {};
let header = null, nRows = 0;

// CSV simple : les champs contenant des virgules sont entre guillemets.
function parseLine(line) {
  const f = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { f.push(cur); cur = ""; }
    else cur += c;
  }
  f.push(cur);
  return f;
}

const raw = {};
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!header) { header = parseLine(line.replace(/^﻿/, "")); continue; }
  nRows++;
  // Filtre rapide avant analyse complète.
  if (!line.includes("Dissemination area")) continue;
  const f = parseLine(line);
  const id = Number(f[8]);
  if (!KEEP.has(id)) continue;
  const dauid = f[2];
  const v = Number(f[11]);
  (raw[dauid] ??= {})[id] = Number.isFinite(v) ? v : 0;
}

for (const [dauid, r] of Object.entries(raw)) {
  const g = (k) => r[k] ?? 0;
  const fr = g(397) + g(719) / 2 + g(721) / 2 + g(722) / 3;
  const en = g(396) + g(719) / 2 + g(720) / 2 + g(722) / 3;
  const total = g(393);
  const age = (a, b) => { let s = 0; for (let k = a; k <= b; k++) s += g(k); return s; };
  out[dauid] = {
    pop: g(1),
    mt: total,
    fr: +fr.toFixed(1),
    en: +en.toFixed(1),
    other: +Math.max(0, total - fr - en).toFixed(1),
    a18_34: +(0.4 * g(14) + age(15, 17)).toFixed(1),
    a35_54: age(18, 21),
    a55p: age(22, 29),
  };
}

writeFileSync(new URL("../data/qc_census_da_2021.json", import.meta.url), JSON.stringify(out));
const tot = Object.values(out).reduce((s, d) => ({ pop: s.pop + d.pop, fr: s.fr + d.fr, mt: s.mt + d.mt }), { pop: 0, fr: 0, mt: 0 });
console.log(`${nRows} lignes lues, ${Object.keys(out).length} AD ; population ${tot.pop}, francophones (langue maternelle) ${(100 * tot.fr / tot.mt).toFixed(1)} %`);
