/**
 * Run the full modelling pipeline once and write data/qc_projection.json for
 * the dashboard to display. Shared by the CLI (tools/compute.mjs) and the
 * data refresh (votoscope/data, then ingest/depuis_data.mjs), which imports it directly instead of
 * spawning a subprocess.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { computeProjection } from "./computeProjection.js";

export function writeProjection(dataDir = new URL("../data/", import.meta.url)) {
  const load = (f) => JSON.parse(readFileSync(new URL(f, dataDir), "utf-8"));
  const loadOptional = (f) => {
    try { return load(f); } catch { return []; } // by-elections: absent = none
  };

  // Cycle-specific inputs are named in qc_cycles.json (files).
  const cycleFiles = load("qc_cycles.json").files ?? {};

  const t0 = Date.now();
  const projection = computeProjection({
    pollRows: load("qc_national_polls.json"),
    baselineRows: load(cycleFiles.baseline ?? "qc_2022_baseline_2026map.json"),
    leaders: load(cycleFiles.leaders ?? "qc_leaders.json"),
    ridingResults: [...load("qc_riding_results.json"), ...(cycleFiles.extraResults ? load(cycleFiles.extraResults) : [])],
    features2017: load("qc_riding_features_2017.json"),
    features2026: load("qc_riding_features_2026.json"),
    systemicParams: load("qc_systemic.json"),
    ridingRegions: load("qc_riding_regions.json"),
    incumbents: load(cycleFiles.incumbents ?? "qc_incumbents.json"),
    leaderEffect: load("qc_leader_effect.json"),
    regionalPollRows: load("qc_regional_polls.json"),
    byelectionRows: loadOptional("qc_byelections.json"),
    // Swing by mother tongue: Léger crosstabs, census composition, kappa.
    languageCrosstabs: loadOptional("qc_leger_crosstabs.json"),
    languageComposition: loadOptional("qc_riding_language_age.json"),
    languageSwing: loadOptional("qc_language_swing.json"),
    residualScale: loadOptional("qc_residual_scale.json"),
    // Turnout correction retired (post-mortem 2026-10-06): the shrinkage
    // weight w=0 is optimal over the 2022+2026 backtests combined
    // (tools/turnout_test_2026.mjs). qc_turnout.json and its generator
    // stay for the record; computeProjection's null path applies no
    // correction.
    turnout: null,
  });

  writeFileSync(new URL("qc_projection.json", dataDir), JSON.stringify(projection), "utf-8");
  const m = projection.meta;
  return (
    `qc_projection.json ecrit en ${((Date.now() - t0) / 1000).toFixed(1)}s : ` +
    `${m.nPolls} sondages, ${m.nRidings} circonscriptions, R2 effets=${m.effectsR2?.toFixed(2)}, ` +
    `${m.nRegionalPolls} sondages regionaux, sieges point=${JSON.stringify(projection.pointCounts)}`
  );
}
