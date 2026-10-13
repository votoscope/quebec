/**
 * Export the pieces the modelling side needs, as plain JSON — port of
 * the retired Python exporter (tag `python-archive`). Kept deliberately dumb (no modelling logic) so
 * the projection code does the compositional/GP work itself rather than
 * displaying someone else's transform.
 *
 * One divergence from the Python original: riding code -> name used to come
 * from the boundary shapefiles via geopandas. The mapping is static (it only
 * changes with a redistricting), so it was materialised once into
 * data/riding_names_{2017,2026}.json and read from there.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DuckDBConnection } from "@duckdb/node-api";
import { all, connect } from "./db.ts";
import { loadCycles } from "./cycles.ts";

const OUT_DIR = new URL("../data/", import.meta.url);
const NAMES_DIR = new URL("../data/", import.meta.url);

/** "197.0", 197 and "197" all mean the same riding; riding NAMES pass
 * through untouched. */
const normalizeRidingCode = (code: unknown): string => {
  const text = String(code);
  const num = Number.parseFloat(text);
  return Number.isFinite(num) && /^\d+(\.\d+)?$/.test(text) ? String(Math.trunc(num)) : text;
};

const write = (name: string, records: unknown[], label: string) => {
  writeFileSync(new URL(name, OUT_DIR), JSON.stringify(records), "utf-8");
  console.log(`exported ${records.length} ${label} -> ${name}`);
};

const exportLeaders = (con: DuckDBConnection) =>
  all(
    con,
    `SELECT l.party_code, l.leader_name, l.riding_name, l.riding_source, i.current_party
     FROM party_leaders l
     LEFT JOIN incumbents i
       ON i.jurisdiction_code = l.jurisdiction_code AND i.riding_name = l.riding_name
     WHERE l.jurisdiction_code = 'qc-provincial'
     ORDER BY l.party_code`,
  );

const exportIncumbents = (con: DuckDBConnection) =>
  all(
    con,
    `SELECT riding_name, member_name, current_party, elected_with_note
     FROM incumbents WHERE jurisdiction_code = 'qc-provincial'`,
  );

/** Riding demographics as RAW PARTS, grouped so the modelling side can
 * ILR-transform each composition itself; each group gets a closing residual
 * so it sums to a whole. median_age / income / density are genuine scalars. */
async function exportRidingFeatures(
  con: DuckDBConnection, boundaryYear: string,
): Promise<Record<string, unknown>[]> {
  const rows = await all(
    con,
    `SELECT riding_code,
            pct_french_home_lang, pct_english_home_lang, pct_allophone_home_lang,
            pct_university_degree, pct_no_diploma,
            pct_immigrant,
            pct_ind_agriculture, pct_ind_manufacturing, pct_ind_retail,
            pct_ind_professional, pct_ind_health_social,
            median_age, median_household_income, population_density
     FROM riding_demographics
     WHERE jurisdiction_code = 'qc-provincial' AND boundary_year = ?`,
    [boundaryYear],
  );

  const nameByCode: Record<string, string> = JSON.parse(
    readFileSync(new URL(`riding_names_${boundaryYear}.json`, NAMES_DIR), "utf-8"),
  );

  const close = (parts: (number | null)[], total = 100): number[] | null => {
    if (parts.some((p) => p === null || p === undefined)) return null;
    const rest = total - (parts as number[]).reduce((s, p) => s + p, 0);
    return [...(parts as number[]), Math.max(rest, 1e-6)];
  };
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

  return rows.map((row) => {
    const code = normalizeRidingCode(row.riding_code);
    return {
      riding_code: code,
      riding_name: nameByCode[code] ?? null,
      language: close([num(row.pct_french_home_lang), num(row.pct_english_home_lang), num(row.pct_allophone_home_lang)]),
      education: close([num(row.pct_university_degree), num(row.pct_no_diploma)]),
      immigration: close([num(row.pct_immigrant)]),
      industry: close([
        num(row.pct_ind_agriculture), num(row.pct_ind_manufacturing), num(row.pct_ind_retail),
        num(row.pct_ind_professional), num(row.pct_ind_health_social),
      ]),
      median_age: num(row.median_age),
      median_household_income: num(row.median_household_income),
      population_density: num(row.population_density),
    };
  });
}

export async function exportAll(): Promise<void> {
  mkdirSync(fileURLToPath(OUT_DIR), { recursive: true });
  const con = await connect();
  // Sondages et résultats : dépôt votoscope/data (ingest/depuis_data.mjs).
  write("qc_leaders.json", await exportLeaders(con), "party leaders");
  write("qc_incumbents.json", await exportIncumbents(con), "incumbents");
  // 2017-map features train the riding-effects model (the map the
  // 2014->2018->2022 transitions live on); 2026-map features are what it
  // gets applied to.
  for (const year of ["2017", "2026"]) {
    write(`qc_riding_features_${year}.json`, await exportRidingFeatures(con, year), `riding feature rows (${year} map)`);
  }
  con.closeSync();
}

if (import.meta.main) await exportAll();
