/**
 * Primitives géographiques communes : lecture des aires de diffusion ISQ
 * 2021 (centroïde projeté en WGS84) et localisation d'un point dans une
 * carte de circonscriptions (GeoJSON).
 */

import { readFileSync } from "node:fs";
import shapefile from "shapefile";
import proj4 from "proj4";

const ALBERS = "+proj=aea +lat_0=44 +lon_0=-68.5 +lat_1=46 +lat_2=60 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs";
const toWgs = proj4(ALBERS, "EPSG:4326");
const DA_BASE = new URL("../../data/raw/lus/isq_geo/AD_2021_QC_LimCarto_harmo", import.meta.url);
const winPath = (u) => decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, "$1");

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (x, y, poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((h) => inRing(x, y, h));

/** Centroïde de surface de l'anneau extérieur le plus grand. */
export function centroid(geom) {
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

/** Localisateur point -> clé de circonscription pour un GeoJSON WGS84. */
export function ridingLocator(geojsonUrl, keyOf) {
  const geo = JSON.parse(readFileSync(geojsonUrl, "utf-8"));
  const ridings = geo.features.map((f) => {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const xs = polys.flatMap((p) => p[0].map((c) => c[0]));
    const ys = polys.flatMap((p) => p[0].map((c) => c[1]));
    return { key: keyOf(f.properties), polys, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
  return (lon, lat) => {
    for (const r of ridings) {
      const [a, b, c, d] = r.bbox;
      if (lon < a || lon > c || lat < b || lat > d) continue;
      if (r.polys.some((p) => inPoly(lon, lat, p))) return r.key;
    }
    return null;
  };
}

/** Itère les aires de diffusion ISQ 2021 : {props, lon, lat}. */
export async function* disseminationAreas() {
  const src = await shapefile.open(winPath(new URL(DA_BASE.href + ".shp")), winPath(new URL(DA_BASE.href + ".dbf")), { encoding: "utf-8" });
  for (;;) {
    const { done, value } = await src.read();
    if (done) return;
    if (!value.geometry) continue;
    const [lon, lat] = toWgs.forward(centroid(value.geometry));
    yield { props: value.properties, lon, lat };
  }
}
