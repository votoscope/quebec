/**
 * Vote fédéral 2019 et 2021 par circonscription PROVINCIALE (cartes 2017 et
 * 2026), à partir des résultats par circonscription fédérale (Élections
 * Canada, table 12 des résultats officiels) : chaque aire de diffusion 2021
 * hérite des parts de sa circonscription fédérale (découpage de 2013, fichier
 * des attributs géographiques du recensement 2021, 92-151-X) ; une
 * circonscription provinciale reçoit la moyenne pondérée par la population de
 * ses aires (js/data/qc_da_riding.json, js/data/qc_census_da_2021.json).
 * Le vote fédéral 2025, déjà calculé par section de vote
 * (js/data/qc_federal_2025.json), est repris tel quel.
 *
 * Sortie : js/data/qc_federal_shares.json
 *   { "2019": { "2017": {riding: {BQ, PLC, PCC, NPD, AUTRES}}, "2026": {...} }, "2021": ..., "2025": ... }
 *
 * Entrées brutes (data/raw/non-lus/federal/) : table12_2019.csv,
 * table12_2021.csv, gaf2021.zip.
 *
 * Run: node js/tools/build_federal_ridings.mjs   (from the repo root)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const RAW = new URL("../data/raw/non-lus/federal/", import.meta.url);
const winPath = (u) => decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, "$1");
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const PARTIES = ["BQ", "PLC", "PCC", "NPD", "AUTRES"];
const partyOf = (cand) => (/Bloc Qu/.test(cand) ? "BQ" : /Liberal|Libéral/.test(cand) ? "PLC" : /Conservative|Conservateur/.test(cand) ? "PCC" : /NDP|NPD/.test(cand) ? "NPD" : "AUTRES");

function csvRows(text) {
  const rows = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!line) continue;
    const f = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === ",") { f.push(cur); cur = ""; } else cur += c; }
    f.push(cur); rows.push(f);
  }
  return rows;
}

// --- résultats par circonscription fédérale ---------------------------------------
function districtShares(year) {
  const rows = csvRows(readFileSync(new URL(`table12_${year}.csv`, RAW), "utf-8"));
  const votes = {};
  for (const r of rows.slice(1)) {
    const num = r[2]; if (!/^24\d{3}$/.test(num)) continue;
    const v = Number(r[6]); if (!Number.isFinite(v)) continue;
    const p = partyOf(r[3]);
    (votes[num] ??= Object.fromEntries(PARTIES.map((x) => [x, 0])))[p] += v;
  }
  return Object.fromEntries(Object.entries(votes).map(([k, o]) => { const t = PARTIES.reduce((s, p) => s + o[p], 0); return [k, Object.fromEntries(PARTIES.map((p) => [p, o[p] / t]))]; }));
}

// --- aire de diffusion -> circonscription fédérale (2013) -------------------------
const gaf = execFileSync("unzip", ["-p", winPath(new URL("gaf2021.zip", RAW))], { maxBuffer: 1 << 30 }).toString("latin1");
const lines = gaf.split(/\r?\n/);
const header = csvRows(lines[0])[0];
const iPR = header.indexOf("PRUID_PRIDU"), iFED = header.indexOf("FEDUID_CEFIDU"), iDA = header.findIndex((h) => h.startsWith("DAUID"));
const daFed = new Map();
for (let k = 1; k < lines.length; k++) {
  const l = lines[k]; if (!l.startsWith("24,")) continue;
  const f = csvRows(l)[0];
  if (f[iPR] !== "24") continue;
  if (!daFed.has(f[iDA])) daFed.set(f[iDA], f[iFED]);
}
console.log(`aires de diffusion du Québec rattachées à une circonscription fédérale : ${daFed.size}`);

const census = load("../data/qc_census_da_2021.json");
const daRiding = load("../data/qc_da_riding.json");
const out = {};
for (const year of [2019, 2021]) {
  const fed = districtShares(year);
  out[year] = {};
  for (const map of ["2017", "2026"]) {
    const acc = {};
    for (const [da, riding] of Object.entries(daRiding[map])) {
      const f = fed[daFed.get(da)]; const pop = census[da]?.pop ?? 0;
      if (!f || !pop) continue;
      const a = (acc[riding] ??= { w: 0, s: Object.fromEntries(PARTIES.map((p) => [p, 0])) });
      a.w += pop; for (const p of PARTIES) a.s[p] += pop * f[p];
    }
    out[year][map] = Object.fromEntries(Object.entries(acc).map(([r, a]) => [r, Object.fromEntries(PARTIES.map((p) => [p, +(a.s[p] / a.w).toFixed(5)]))]));
  }
  console.log(`${year} : ${Object.keys(fed).length} circonscriptions fédérales ; ${Object.keys(out[year]["2017"]).length} provinciales (2017), ${Object.keys(out[year]["2026"]).length} (2026)`);
}
const f25 = load("../data/qc_federal_2025.json");
out[2025] = { "2017": f25.map2017 ?? {}, "2026": f25.map2026 ?? {} };
writeFileSync(new URL("../data/qc_federal_shares.json", import.meta.url), JSON.stringify(out));
