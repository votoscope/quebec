/**
 * Composition régionale fine des circonscriptions 2026, pondérée par la
 * population : la part de chaque circonscription dans chacune des régions
 * de ventilation des sondages régionaux de Léger (14 groupes de régions
 * administratives), plus les sous-régions métropolitaines (île de Montréal,
 * « 450 » = RMR de Montréal hors île, ville de Québec, RMR de Québec hors
 * ville).
 *
 * Source : aires de diffusion 2021 de l'ISQ (CO_RA, RMRIDU, CO_MUN,
 * Population), centroïde de chaque aire projeté de l'Albers Québec vers
 * WGS84, rattaché à la circonscription 2026 par point-dans-polygone
 * (data/qc_ridings_2026.geojson).
 *
 * Sortie : js/data/qc_riding_regions_fine.json
 *   { groups: {code: label}, ridings: {riding_code: {ra: {group: w},
 *     metro: {group: w}, population}} }   (poids sommant à 1)
 *
 * Run: node js/tools/build_regions_fine.mjs   (from the repo root)
 */

import { readFileSync, writeFileSync } from "node:fs";
import shapefile from "shapefile";
import proj4 from "proj4";

const SHP = new URL("../data/raw/lus/isq_geo/AD_2021_QC_LimCarto_harmo.shp", import.meta.url);
const DBF = new URL("../data/raw/lus/isq_geo/AD_2021_QC_LimCarto_harmo.dbf", import.meta.url);
const ALBERS = "+proj=aea +lat_0=44 +lon_0=-68.5 +lat_1=46 +lat_2=60 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs";
const toWgs = proj4(ALBERS, "EPSG:4326");

// Groupes de régions administratives tels que ventilés par Léger.
const RA_GROUP = {
  "01": "BSL_GIM", "11": "BSL_GIM", "02": "SAG_CN", "09": "SAG_CN", "03": "CN", "04": "MAU",
  "05": "EST", "06": "MTL", "07": "OUT", "08": "AT_NQ", "10": "AT_NQ", "12": "CA",
  "13": "LAV", "14": "LAN", "15": "LAU", "16": "MON", "17": "CDQ",
};
const GROUPS = {
  BSL_GIM: "Bas-Saint-Laurent, Gaspésie et Îles-de-la-Madeleine",
  SAG_CN: "Saguenay-Lac-Saint-Jean et Côte-Nord", CN: "Capitale-Nationale", MAU: "Mauricie",
  EST: "Estrie", MTL: "Île de Montréal", OUT: "Outaouais", AT_NQ: "Abitibi-Témiscamingue et Nord-du-Québec",
  CA: "Chaudière-Appalaches", LAV: "Laval", LAN: "Lanaudière", LAU: "Laurentides", MON: "Montérégie",
  CDQ: "Centre-du-Québec",
};

const geo = JSON.parse(readFileSync(new URL("../data/qc_ridings_2026.geojson", import.meta.url), "utf-8"));
const ridings = geo.features.map((f) => ({
  code: String(f.properties.riding_code),
  polys: f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates,
}));
for (const r of ridings) {
  const xs = r.polys.flatMap((p) => p[0].map((c) => c[0]));
  const ys = r.polys.flatMap((p) => p[0].map((c) => c[1]));
  r.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (x, y, poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((h) => inRing(x, y, h));
function ridingOf(x, y) {
  for (const r of ridings) {
    const [a, b, c, d] = r.bbox;
    if (x < a || x > c || y < b || y > d) continue;
    if (r.polys.some((p) => inPoly(x, y, p))) return r.code;
  }
  return null;
}
// Centroïde de surface de l'anneau extérieur le plus grand.
function centroid(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let best = null, bestA = -1;
  for (const p of polys) {
    const ring = p[0];
    let A = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      A += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (Math.abs(A) > bestA) { bestA = Math.abs(A); best = A ? [cx / (3 * A), cy / (3 * A)] : ring[0]; }
  }
  return best;
}

const acc = new Map();
let nDa = 0, popTot = 0, popMiss = 0;
const source = await shapefile.open(SHP.pathname.replace(/^\/([A-Z]:)/, "$1"), DBF.pathname.replace(/^\/([A-Z]:)/, "$1"), { encoding: "utf-8" });
for (;;) {
  const { done, value } = await source.read();
  if (done) break;
  const p = value.properties;
  const pop = Number(p.Population) || 0;
  if (pop <= 0 || !value.geometry) continue;
  nDa++; popTot += pop;
  const [lon, lat] = toWgs.forward(centroid(value.geometry));
  const code = ridingOf(lon, lat);
  if (!code) { popMiss += pop; continue; }
  const ra = String(p.CO_RA).padStart(2, "0");
  const group = RA_GROUP[ra];
  const rmr = String(p.RMRIDU ?? "").trim();
  const metro = rmr === "462" ? (ra === "06" ? "ILE" : "450")
    : rmr === "421" ? (String(p.CO_MUN) === "23027" ? "VQC" : "AQC")
    : "HORS";
  if (!acc.has(code)) acc.set(code, { ra: {}, metro: {}, population: 0 });
  const a = acc.get(code);
  a.ra[group] = (a.ra[group] ?? 0) + pop;
  a.metro[metro] = (a.metro[metro] ?? 0) + pop;
  a.population += pop;
}

const out = { groups: GROUPS, metro: { ILE: "Île de Montréal", 450: "RMR de Montréal hors île", VQC: "Ville de Québec", AQC: "RMR de Québec hors ville", HORS: "Hors RMR" }, ridings: {} };
for (const [code, a] of [...acc].sort((x, y) => +x[0] - +y[0])) {
  const norm = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +(v / a.population).toFixed(4)]));
  out.ridings[code] = { ra: norm(a.ra), metro: norm(a.metro), population: a.population };
}
writeFileSync(new URL("../data/qc_riding_regions_fine.json", import.meta.url), JSON.stringify(out, null, 1));

const mixed = Object.values(out.ridings).filter((r) => Math.max(...Object.values(r.ra)) < 0.95).length;
console.log(`${nDa} aires de diffusion, population ${popTot}, non rattachée ${popMiss} (${((popMiss / popTot) * 100).toFixed(2)} %)`);
console.log(`${Object.keys(out.ridings).length} circonscriptions couvertes, ${mixed} à cheval sur deux groupes (part max < 95 %)`);
const count = {};
for (const r of Object.values(out.ridings)) {
  const g = Object.entries(r.ra).sort((a, b) => b[1] - a[1])[0][0];
  count[g] = (count[g] ?? 0) + 1;
}
console.log(count);
