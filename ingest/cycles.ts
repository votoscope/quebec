/**
 * Cycle constants loader for Deno (ingest side).
 *
 * Reads js/data/qc_cycles.json and exports the constants used by the
 * ingestion pipeline (export_json.ts). This is the Deno
 * counterpart of js/src/cycles.js (Node side).
 *
 * Both loaders read the SAME qc_cycles.json file, so the 2030 migration
 * touches ONE file for both runtimes.
 */

const CYCLES_PATH = new URL("../data/qc_cycles.json", import.meta.url);

let _cache: CycleConfig | null = null;

export interface CycleConfig {
  cycle: number;
  electionDate: string;
  previousElectionDate: string;
  changepoints: string[];
  campaigns: [string, string][];
  cycleBoundaries: [string, number][];
  leadersPrevious: { party: string; riding: string }[];
  byelectionBounds: { after: string; before: string };
}

/** Load and cache the cycle constants. */
export async function loadCycles(): Promise<CycleConfig> {
  if (_cache) return _cache;
  const text = await Deno.readTextFile(CYCLES_PATH);
  _cache = JSON.parse(text) as CycleConfig;
  return _cache;
}

/** Synchronous variant for use in non-async contexts (cached after first load). */
export function loadCyclesSync(): CycleConfig {
  if (!_cache) {
    throw new Error("loadCyclesSync called before loadCycles; use await loadCycles() first");
  }
  return _cache;
}

/**
 * Classify a poll date into its cycle year.
 * A poll taken after an election date belongs to the NEXT cycle.
 */
export function cycleOf(pollDate: string, boundaries: [string, number][], currentCycle: number): number {
  for (const [boundary, cycle] of boundaries) {
    if (pollDate <= boundary) return cycle;
  }
  return currentCycle;
}
