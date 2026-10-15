/**
 * Entrées du modèle tirées du dépôt de données votovision/data (clone voisin
 * ../data, ou chemin donné en argument) : tables csv/sondages.csv,
 * csv/parts.csv et csv/resultats.csv réécrites aux formats JSON lus par le
 * modèle.
 *
 *  - data/qc_national_polls.json : sondages de la population entière ;
 *  - data/qc_regional_polls.json : RMR de Montréal, RMR de Québec, reste du
 *    Québec (codes MTL, QC, REG) ;
 *  - data/qc_riding_results.json : générales 2014, 2018, 2022 (toutes cartes) ;
 *  - data/qc_2022_baseline_2026map.json : 2022 sur la carte de 2026 ;
 *  - data/qc_2026_results_2026map.json : générale 2026 ;
 *  - data/qc_byelections.json : partielles du cycle (qc_cycles.json).
 *
 * Run: node ingest/depuis_data.mjs [chemin du dépôt data]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ICI = fileURLToPath(new URL(".", import.meta.url));
const DATA = resolve(process.argv[2] ?? join(ICI, "..", "..", "data"));
const OUT = new URL("../data/", import.meta.url);

function lireCsv(chemin) {
  const texte = readFileSync(chemin, "utf-8").replace(/^﻿/, "");
  const lignes = []; let ligne = [], champ = "", q = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (q) { if (c === '"' && texte[i + 1] === '"') { champ += '"'; i++; } else if (c === '"') q = false; else champ += c; }
    else if (c === '"') q = true;
    else if (c === ",") { ligne.push(champ); champ = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && texte[i + 1] === "\n") i++; ligne.push(champ); lignes.push(ligne); ligne = []; champ = ""; }
    else champ += c;
  }
  if (champ || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  const [h, ...r] = lignes.filter((l) => l.length > 1);
  return r.map((l) => Object.fromEntries(h.map((k, j) => [k, l[j] ?? ""])));
}
const ecrire = (nom, rows) => { writeFileSync(new URL(nom, OUT), JSON.stringify(rows)); console.log(`${nom} : ${rows.length} lignes`); };
const num = (v) => (v === "" || v === undefined ? null : Number(v));

const sondages = lireCsv(join(DATA, "csv", "sondages.csv")).filter((s) => s.juridiction === "qc-provincial");
const parts = new Map();
for (const p of lireCsv(join(DATA, "csv", "parts.csv"))) { if (!parts.has(p.id)) parts.set(p.id, []); parts.get(p.id).push(p); }
const lignesSondage = (s, region) => (parts.get(s.id) ?? []).map((p) => ({
  poll_id: s.id, region_code: region, firm: s.firme, poll_date: s.date_fin, sample_size: num(s.n), firm_rating: null,
  party_code: p.parti, pct_reported: Number(p.pct), n_decided: num(s.n_decides), field_start: s.date_debut || null, field_end: null,
}));
const REGIONS = { "RMR-MTL": "MTL", "RMR-QC": "QC", "RESTE-QC": "REG" };
const parDate = (a, b) => a.poll_date.localeCompare(b.poll_date);
ecrire("qc_national_polls.json", sondages.filter((s) => s.region === "National").flatMap((s) => lignesSondage(s, "National")).sort(parDate));
ecrire("qc_regional_polls.json", sondages.filter((s) => REGIONS[s.region]).flatMap((s) => lignesSondage(s, REGIONS[s.region])).sort(parDate));

const resultats = lireCsv(join(DATA, "csv", "resultats.csv")).filter((r) => r.juridiction === "qc-provincial");
const code = (c) => (/^\d+(\.0)?$/.test(c) ? String(Number(c)) : c);
const ligneRes = (r) => ({ election_date: r.election, boundary_year: r.carte, riding_code: code(r.circonscription), party_code: r.parti, votes: Number(r.votes) });
ecrire("qc_riding_results.json", resultats.filter((r) => ["2014-04-07", "2018-10-01", "2022-10-03"].includes(r.election)).map(ligneRes));
ecrire("qc_2022_baseline_2026map.json", resultats.filter((r) => r.election === "2022-10-03" && r.carte === "2026").map((r) => ({ riding_code: code(r.circonscription), party_code: r.parti, votes: Number(r.votes) })));
ecrire("qc_2026_results_2026map.json", resultats.filter((r) => r.election === "2026-10-05" && r.carte === "2026").map(ligneRes));
const { byelectionBounds: { after, before } } = JSON.parse(readFileSync(new URL("qc_cycles.json", OUT), "utf-8"));
ecrire("qc_byelections.json", resultats.filter((r) => r.election > after && r.election < before).map(ligneRes));
