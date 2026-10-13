/**
 * Notoriété des candidats sur Wikipédia (fr), mesurée avant le scrutin, de
 * façon reproductible par les API publiques de Wikimedia.
 *
 * Candidats : 2018 et 2022 (js/data/qc_candidates_2018_2022.json, noms au
 * format « Nom Prénom »), 2026 (DGEQ, prénom et nom séparés). Pour chacun :
 *   - titres candidats « Prénom Nom » (toutes les coupures possibles du nom
 *     composé), plus le titre d'article déjà relevé s'il existe ;
 *   - page retenue si elle existe, n'est pas une page d'homonymie et porte une
 *     catégorie politique (député, ministre, maire, candidat, personnalité
 *     politique, parti) ;
 *   - date de création (première révision) ;
 *   - vues quotidiennes (utilisateurs, tous accès) cumulées sur les 60 jours
 *     précédant le scrutin. Un article créé après le scrutin n'a aucune vue
 *     dans cette fenêtre : la mesure ne contient aucune information postérieure.
 *
 * Sortie : js/data/qc_candidate_wiki.json
 *   { "2018": [{ riding, party, name, title, created, views60 }], ... }
 *
 * Run: node js/tools/wiki_notability.mjs   (from the repo root)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const UA = { "User-Agent": "silatendancesemaintient/1.0 (https://github.com/essicolo/silatendancesemaintient)" };
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));
const OUT = new URL("../data/qc_candidate_wiki.json", import.meta.url);
const ELECTION = { 2018: "2018-10-01", 2022: "2022-10-03", 2026: "2026-10-05" };
const MAP = { "PQ": "PQ", "PLQ/QLP": "LIB", "PCOQ": "PCQ", "ÉCF-CAQ": "CAQ", "QS": "QS" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, tries = 4) {
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { headers: UA });
      // 4xx hors 429 : pas de données (article absent de la fenêtre, titre invalide).
      if (r.status >= 400 && r.status < 500 && r.status !== 429) return null;
      if (r.ok) return await r.json();
      await sleep(1000 * (k + 1));
    } catch { await sleep(1000 * (k + 1)); }
  }
  throw new Error(`échec ${url}`);
}

// --- candidats -------------------------------------------------------------------
const cands = { 2018: [], 2022: [], 2026: [] };
for (const c of load("../data/qc_candidates_2018_2022.json")) {
  const y = c.d.slice(0, 4);
  const tokens = c.candidate_name.trim().split(/\s+/);
  const titles = [];
  for (let i = 1; i < tokens.length; i++) titles.push(`${tokens.slice(i).join(" ")} ${tokens.slice(0, i).join(" ")}`);
  cands[y].push({ riding: c.riding_name, party: c.party_code, name: c.candidate_name, titles });
}
// Titres déjà relevés dans la base (candidate_notability), en complément.
try {
  const prev = load("../data/qc_candidate_titles_2018_2022.json");
  for (const p of prev) { const x = cands[p.d.slice(0, 4)].find((c) => c.name === p.candidate_name && c.riding === p.riding_name); if (x && p.article) x.titles.unshift(p.article); }
} catch { /* facultatif */ }
for (const circ of load("../data/raw/lus/2026-10-05-resultats-dgeq.json").circonscriptions) {
  for (const c of circ.candidats) cands[2026].push({ riding: String(circ.numeroCirconscription), party: MAP[c.abreviationPartiPolitique] ?? "AUTRES", name: `${c.prenom} ${c.nom}`, titles: [`${c.prenom} ${c.nom}`] });
}

// --- résolution des titres (lots de 50) ------------------------------------------
const POLITICAL = /politi|député|ministre|maire|candidat|parti |conseill|assemblée nationale|syndical|chef/i;
const allTitles = [...new Set(Object.values(cands).flat().flatMap((c) => c.titles))];
const resolved = new Map(); // titre demandé -> titre final valide ou null
for (let i = 0; i < allTitles.length; i += 50) {
  const batch = allTitles.slice(i, i + 50);
  const url = `https://fr.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=categories|pageprops&cllimit=max&ppprop=disambiguation&titles=${encodeURIComponent(batch.join("|"))}`;
  const j = await getJSON(url);
  const norm = new Map((j.query.normalized ?? []).map((n) => [n.from, n.to]));
  const redir = new Map((j.query.redirects ?? []).map((n) => [n.from, n.to]));
  const pages = new Map(Object.values(j.query.pages).map((p) => [p.title, p]));
  for (const t of batch) {
    let tt = norm.get(t) ?? t; tt = redir.get(tt) ?? tt;
    const p = pages.get(tt);
    const ok = p && p.missing === undefined && !p.pageprops?.disambiguation && (p.categories ?? []).some((c) => POLITICAL.test(c.title));
    resolved.set(t, ok ? tt : null);
  }
  await sleep(150);
}

// --- création et vues ------------------------------------------------------------
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const created = new Map(), views = new Map();
const out = {};
for (const [year, list] of Object.entries(cands)) {
  const E = new Date(ELECTION[year]);
  const start = new Date(E); start.setDate(start.getDate() - 60);
  const end = new Date(E); end.setDate(end.getDate() - 1);
  out[year] = [];
  for (const c of list) {
    const title = c.titles.map((t) => resolved.get(t)).find(Boolean) ?? null;
    let cr = null, v = 0;
    if (title) {
      if (!created.has(title)) {
        const j = await getJSON(`https://fr.wikipedia.org/w/api.php?action=query&format=json&prop=revisions&rvlimit=1&rvdir=newer&rvprop=timestamp&titles=${encodeURIComponent(title)}`);
        created.set(title, Object.values(j.query.pages)[0]?.revisions?.[0]?.timestamp ?? null);
        await sleep(100);
      }
      cr = created.get(title);
      const key = `${title}|${year}`;
      if (!views.has(key)) {
        const j = await getJSON(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/fr.wikipedia.org/all-access/user/${encodeURIComponent(title.replace(/ /g, "_"))}/daily/${ymd(start)}00/${ymd(end)}00`);
        views.set(key, j ? j.items.reduce((s, it) => s + it.views, 0) : 0);
        await sleep(100);
      }
      v = views.get(key);
    }
    out[year].push({ riding: c.riding, party: c.party, name: c.name, title, created: cr, views60: v });
  }
  const withT = out[year].filter((c) => c.title);
  console.log(`${year} : ${list.length} candidats, ${withT.length} articles trouvés, ${withT.filter((c) => c.views60 > 0).length} avec des vues avant le scrutin, ${withT.filter((c) => c.created && c.created.slice(0, 10) >= ELECTION[year]).length} articles créés après le scrutin`);
}
writeFileSync(OUT, JSON.stringify(out, null, 1));
