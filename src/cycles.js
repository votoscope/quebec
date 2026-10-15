/**
 * Cycle constants loader: reads js/data/qc_cycles.json and exports the
 * constants used across the pipeline.
 *
 * Before this module, cycle constants lived in SIX places (RUNBOOK §4):
 *   1. computeProjection.js : ELECTION_DATE, LEADERS_2022
 *   2. gpTrend.js : CHANGEPOINTS, CAMPAIGNS
 *   3. (ingestion, dépôt votovision/data) : CYCLE_BOUNDARIES
 *   4. export_json.ts : by-election bounds
 *   5. candidates/leaders loaders
 *   6. baseline (re-aggregation)
 *
 * Centralizing them here means the 2030 migration touches ONE file
 * instead of six. The golden test protects against behaviour changes.
 */

import { readFileSync } from "node:fs";

const CYCLES_PATH = new URL("../data/qc_cycles.json", import.meta.url);

let _cache = null;

/** Load and cache the cycle constants. */
export function loadCycles() {
  if (_cache) return _cache;
  _cache = JSON.parse(readFileSync(CYCLES_PATH, "utf-8"));
  return _cache;
}

/** Current cycle year (e.g. 2026). */
export const CYCLE = loadCycles().cycle;

/** Election date (ISO, e.g. "2026-10-05"). */
export const ELECTION_DATE = loadCycles().electionDate;

/** Previous general election date (ISO). */
export const PREVIOUS_ELECTION_DATE = loadCycles().previousElectionDate;

/** Documented regime changes (ISO dates): leader changes, etc. */
export const CHANGEPOINTS = loadCycles().changepoints;

/** Campaign windows [writ drop, election day] for all cycles (ISO dates). */
export const CAMPAIGNS = loadCycles().campaigns;

/** Cycle boundaries: [[boundaryDate, cycleYear], ...] for poll classification. */
export const CYCLE_BOUNDARIES = loadCycles().cycleBoundaries;

/** Leaders of the previous election: [{party, riding}, ...]. */
export const LEADERS_PREVIOUS = loadCycles().leadersPrevious;

/** Transitions whose swing departures form the simulation's residual pool
 * (all general-election transitions before the current cycle):
 * [[dateA, boundaryA, dateB, boundaryB], ...]. */
export const RESIDUAL_TRANSITIONS = loadCycles().residualTransitions ?? [];

/** By-election bounds: {after, before} ISO dates. */
export const BYELECTION_BOUNDS = loadCycles().byelectionBounds;

/**
 * Classify a poll date into its cycle year.
 * A poll taken after an election date belongs to the NEXT cycle.
 */
export function cycleOf(pollDate) {
  for (const [boundary, cycle] of CYCLE_BOUNDARIES) {
    if (pollDate <= boundary) return cycle;
  }
  return CYCLE;
}
