/**
 * Build the riding adjacency graph from the DGEQ 2026 geojson and save it
 * as js/data/qc_adjacency.json for the simulation's CAR field.
 *
 * Two ridings are adjacent when they share at least 2 polygon vertices
 * (DGEQ boundaries share exact coordinates along common borders; a single
 * shared vertex is a quadripoint and does not count as a border).
 *
 * Output: { codes: string[], W: number[][], nEdges: number, builtAt: string }
 *   codes: riding codes in matrix order (sorted numerically)
 *   W: row-normalized adjacency matrix (W[i][j] = 1/deg(i) if i,j adjacent)
 *
 * Run: node js/tools/build_adjacency.mjs   (from the repo root)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { buildAdjacencyMatrix } from "../src/spatialField.js";

const geo = JSON.parse(readFileSync(new URL("../data/qc_ridings_2026.geojson", import.meta.url), "utf-8"));
const { codes, W, nEdges } = buildAdjacencyMatrix(geo);

const out = {
  codes,
  W,
  nEdges,
  nRidings: codes.length,
  builtAt: new Date().toISOString(),
};

writeFileSync(
  new URL("../data/qc_adjacency.json", import.meta.url),
  JSON.stringify(out),
  "utf-8"
);

const degs = W.map((row) => row.reduce((s, v) => s + (v > 0 ? 1 : 0), 0));
const avgDeg = degs.reduce((a, b) => a + b, 0) / degs.length;
console.log(`adjacence construite : ${codes.length} circonscriptions, ${nEdges} aretes, degre moyen ${avgDeg.toFixed(1)}`);
console.log(`degre min=${Math.min(...degs)}, max=${Math.max(...degs)}`);
console.log(`sauvegarde dans js/data/qc_adjacency.json`);
