/**
 * Pondération temporelle des ventilations régionales des sondages (RMR de
 * Montréal, RMR de Québec, reste du Québec ; toutes firmes, jeu figé
 * ../data/prive/ventilations_regionales_qc.json, hors dépôt, 2018-2026).
 *
 * Poids d'un sondage j vu à la date t : n_j * exp(-âge / tau), l'âge étant
 * mesuré sur l'horloge du GP national : âge = jours écoulés + (D - 1) *
 * jours de campagne écoulés (campagnes de qc_cycles.json). D = 1 : aucune
 * dilatation ; tau = infini : aucune décroissance. Référence : fenêtre fixe
 * de 14 jours (production actuelle).
 *
 * Étape A, identification de (tau, D, m) : prévision un pas en avant de
 * l'écart région - province (CLR des cinq partis) de chaque sondage à partir
 * des sondages antérieurs du même cycle, rétrécie vers l'écart de l'élection
 * précédente avec un pseudo-effectif m (m = infini : aucun sondage régional,
 * hypothèse nulle). Perte : somme des carrés pondérée par l'effectif du
 * sondage prédit.
 *
 * Étape B, validation à la veille : ventilations de veille agrégées avec
 * (tau, D) ; kappa_R choisi sur deux transitions, évalué sur la troisième
 * (kappa langue 0,5, siège ouvert 0,118) ; RMSE des parts au vote provincial
 * connu et erreur de sièges au point avec la tendance nationale de veille.
 *
 * Run: node js/tools/regional_decay_test.mjs   (from the repo root)
 */
import { readFileSync } from "node:fs";
import { mva } from "@tangent.to/ds";
import { ilrMatrix } from "../src/ridingEffects.js";
import { buildData, setBreakdowns, solveSwing, nationalEve, pc, MAIN } from "./lib/transitionEval.mjs";
const { ilrInv } = mva.composition;
const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf-8"));

const raw = load("../../data/prive/ventilations_regionales_qc.json");
const CAMPAIGNS = load("../data/qc_cycles.json").campaigns;
const GP = ["CAQ", "LIB", "PCQ", "PQ", "QS"];
const PARTY = { CAQ: "CAQ", LIB: "LIB", PLQ: "LIB", QS: "QS", PQ: "PQ", CPQ: "PCQ", PCQ: "PCQ" };
const TITLES = { MTL: "Montreal CMA", QC: "Quebec City CMA", REG: "Rest of Quebec", total: "Quebec" };
const REGIONS = ["MTL", "QC", "REG"];
const CYCLES = [{ y: "2018", from: "2014-04-07", to: "2018-10-01", T: "T1" }, { y: "2022", from: "2018-10-01", to: "2022-10-03", T: "T2" }, { y: "2026", from: "2022-10-03", to: "2026-10-05", T: "T3" }];
const clr = (v) => { const l = v.map((x) => Math.log(Math.max(x, 0.5))); const m = l.reduce((a, b) => a + b, 0) / l.length; return l.map((x) => x - m); };
const day = (d) => Date.parse(d) / 86_400_000;
const campDays = (t) => CAMPAIGNS.reduce((c, [a, b]) => c + Math.max(0, Math.min(t, day(b)) - day(a)), 0);

const sharesOf = (g) => { const sh = Object.fromEntries(GP.map((p) => [p, 0])); for (const [p, v] of Object.entries(g)) if (PARTY[p]) sh[PARTY[p]] += v; return GP.map((p) => sh[p]); };
const polls = raw.filter((r) => r.midDate && r.n && REGIONS.every((g) => r.groups[TITLES[g]]) && r.groups.Quebec).map((r) => {
  const reg = Object.fromEntries(REGIONS.map((g) => [g, sharesOf(r.groups[TITLES[g]])]));
  const tot = clr(sharesOf(r.groups.Quebec));
  return { date: r.midDate, t: day(r.midDate), c: campDays(day(r.midDate)), n: r.n, reg, dev: Object.fromEntries(REGIONS.map((g) => [g, clr(reg[g]).map((v, j) => v - tot[j])])) };
}).sort((a, b) => a.t - b.t);

// Écart région - province de l'élection précédente (votes, carte de la transition).
const DATA = await buildData();
const devPrev = {};
for (const cy of CYCLES) {
  const T = DATA.find((x) => x.id === cy.T);
  const agg = (os) => { const W = os.reduce((s, o) => s + o.w, 0); return GP.map((p) => 100 * os.reduce((s, o) => s + o.w * o.prevShares[pc.indexOf(p)], 0) / W); };
  const prov = clr(agg(T.obs));
  devPrev[cy.y] = Object.fromEntries(REGIONS.map((g) => [g, clr(agg(T.obs.filter((o) => o.g === g))).map((v, j) => v - prov[j])]));
}
const cycleOf = (d) => CYCLES.find((cy) => d > cy.from && d <= cy.to);

const weight = (p, t, c, { tau, D, window }) => {
  if (window) return t - p.t <= window ? p.n : 0;
  const age = (t - p.t) + (D - 1) * (c - p.c);
  return p.n * (tau === Infinity ? 1 : Math.exp(-age / tau));
};

// --- Étape A -----------------------------------------------------------------
function lossA(spec, m) {
  let L = 0, N = 0;
  for (const p of polls) {
    const cy = cycleOf(p.date); if (!cy) continue;
    const prior = polls.filter((q) => q.t < p.t && cycleOf(q.date) === cy);
    for (const g of REGIONS) {
      let W = m === Infinity ? 0 : 0, acc = devPrev[cy.y][g].map((v) => (m === Infinity ? v : m * v)), wsum = m === Infinity ? 1 : m;
      if (m !== Infinity) for (const q of prior) { const w = weight(q, p.t, p.c, spec); if (!w) continue; acc = acc.map((v, j) => v + w * q.dev[g][j]); wsum += w; }
      const pred = wsum > 0 ? acc.map((v) => v / wsum) : devPrev[cy.y][g];
      L += p.n * pred.reduce((s, v, j) => s + (v - p.dev[g][j]) ** 2, 0); N += p.n;
    }
  }
  return L / N;
}
const TAUS = [3, 7, 14, 30, 60, 120, 240, 480, 960, 1920, Infinity], DS = [1, 2, 4, 8, 16, 32, 64], MS = [0, 250, 1000, 4000, 16000];
const nullLoss = lossA({ tau: Infinity, D: 1 }, Infinity);
console.log(`Étape A : ${polls.length} sondages à trois régions ; perte de l'hypothèse nulle (écart de l'élection précédente) ${nullLoss.toFixed(4)}`);
const resA = [];
for (const m of MS) {
  resA.push({ label: `fenêtre 14 j, m=${m}`, spec: { window: 14 }, m, loss: lossA({ window: 14 }, m) });
  for (const tau of TAUS) for (const D of tau === Infinity ? [1] : DS) resA.push({ label: `tau=${tau} D=${D} m=${m}`, spec: { tau, D }, m, loss: lossA({ tau, D }, m) });
}
resA.sort((a, b) => a.loss - b.loss);
for (const r of resA.slice(0, 12)) console.log(`  ${r.label.padEnd(28)} ${r.loss.toFixed(4)}`);
for (const m of MS) { const w = resA.find((r) => r.spec.window && r.m === m); console.log(`  référence ${w.label.padEnd(18)} ${w.loss.toFixed(4)}`); }
const bestByD = DS.map((D) => resA.filter((r) => r.spec.D === D)[0]);
console.log("  meilleur par D : " + bestByD.map((r) => `${r.label} ${r.loss.toFixed(4)}`).join(" | "));

// --- Étape B -----------------------------------------------------------------
function eveBreakdowns(spec) {
  const out = {};
  for (const cy of CYCLES) {
    const t = day(cy.to), c = campDays(t);
    const prior = polls.filter((q) => q.date < cy.to && cycleOf(q.date) === cy);
    const groups = {};
    for (const [key, g] of [["rMTL", "MTL"], ["rQC", "QC"], ["rREG", "REG"], ["total", "total"]]) {
      let N = 0; const acc = GP.map(() => 0);
      for (const q of prior) {
        const w = weight(q, t, c, spec); if (!w) continue;
        const sh = g === "total" ? sharesOf(raw.find((r) => r.midDate === q.date && r.n === q.n).groups.Quebec) : q.reg[g];
        sh.forEach((v, j) => (acc[j] += w * v)); N += w;
      }
      if (N) groups[key] = { n: N, shares: Object.fromEntries(GP.map((p, j) => [p, acc[j] / N])) };
    }
    out[cy.y] = { groups };
  }
  return out;
}
const G_OPEN = 0.118, KL = 0.5, KR_GRID = [0, 0.25, 0.5, 0.75, 1];
function means(T, kR, kL = KL) {
  return T.obs.map((o) => {
    let a = o.a;
    const prevWin = MAIN.reduce((b, p) => (o.prevShares[pc.indexOf(p)] > o.prevShares[pc.indexOf(b)] ? p : b), MAIN[0]);
    if (o.inc !== undefined && !(o.inc && o.inc.sameParty && o.inc.party === prevWin)) {
      const sh = o.prevShares.map((x, j) => (pc[j] === prevWin ? x * Math.exp(-G_OPEN) : x)); const t = sh.reduce((s, x) => s + x, 0);
      a = ilrMatrix([sh.map((x) => x / t)])[0];
    }
    return a.map((x, j) => x + kL * o.L[j] + kR * o.RP[j]);
  });
}
function evalT(T, kR, nat, kL = KL) {
  const m = means(T, kR, kL);
  const s = solveSwing(m.map((v, i) => ({ v, w: T.obs[i].w })), nat);
  let se = 0, n = 0; const seats = Object.fromEntries(MAIN.map((p) => [p, 0])), actual = Object.fromEntries(MAIN.map((p) => [p, 0]));
  m.forEach((v, i) => {
    const sh = ilrInv([v.map((x, j) => x + s[j])])[0], y = T.obs[i].yShares;
    for (const p of MAIN) { se += ((sh[pc.indexOf(p)] - y[pc.indexOf(p)]) * 100) ** 2; n++; }
    seats[MAIN.reduce((b, p) => (sh[pc.indexOf(p)] > sh[pc.indexOf(b)] ? p : b), MAIN[0])]++;
    actual[MAIN.reduce((b, p) => (y[pc.indexOf(p)] > y[pc.indexOf(b)] ? p : b), MAIN[0])]++;
  });
  return { sse: se, n, seatErr: MAIN.reduce((t, p) => t + Math.abs(seats[p] - actual[p]), 0) };
}
const eve = Object.fromEntries(DATA.map((T) => [T.id, nationalEve(T, { nDraws: 10 }).point]));
const pick = (r) => r.label;
const candidatesB = [
  { label: "fenêtre 14 j (production)", spec: { window: 14 } },
  ...[...new Map(resA.filter((r) => !r.spec.window && r.m !== Infinity).slice(0, 40).map((r) => [`${r.spec.tau}|${r.spec.D}`, r])).values()].slice(0, 4).map((r) => ({ label: `tau=${r.spec.tau} D=${r.spec.D} (A)`, spec: r.spec })),
  { label: "tau=14 D=1", spec: { tau: 14, D: 1 } }, { label: "tau=30 D=1", spec: { tau: 30, D: 1 } }, { label: "tau=60 D=4", spec: { tau: 60, D: 4 } },
];
console.log("\nÉtape B : kappa_R choisi sur deux transitions, évalué sur la troisième");
for (const cand of candidatesB) {
  setBreakdowns(eveBreakdowns(cand.spec));
  const D2 = await buildData();
  let rmseNum = 0, rmseN = 0, seatKnown = 0, seatEve = 0; const ks = [];
  for (const T of D2) {
    const train = D2.filter((x) => x !== T);
    const kR = KR_GRID.reduce((b, k) => (train.reduce((s, X) => s + evalT(X, k, X.nationalTarget).sse, 0) < train.reduce((s, X) => s + evalT(X, b, X.nationalTarget).sse, 0) ? k : b), 0);
    const known = evalT(T, kR, T.nationalTarget), atEve = evalT(T, kR, eve[T.id]);
    rmseNum += known.sse; rmseN += known.n; seatKnown += known.seatErr; seatEve += atEve.seatErr; ks.push(`${T.id}:${kR}/${atEve.seatErr}`);
  }
  console.log(`  ${cand.label.padEnd(28)} RMSE ${Math.sqrt(rmseNum / rmseN).toFixed(3)} ; sièges vote connu ${seatKnown} ; sièges veille ${seatEve} (${ks.join(" ")})`);
}

// --- Coefficients sur les trois transitions (grille de production) -------------
import { fitKappa } from "./lib/transitionEval.mjs";
for (const cand of [{ label: "fenêtre 14 j", spec: { window: 14 } }, { label: "tau=240 D=16", spec: { tau: 240, D: 16 } }]) {
  setBreakdowns(eveBreakdowns(cand.spec));
  const k = fitKappa(await buildData(), undefined, true);
  console.log(`kappa conjoints (${cand.label}) : langue ${k.L}, régions ${k.R}`);
}

// --- Validation croisée avec (kappa langue, kappa régions) conjoints par pli ------
console.log("\nÉtape C : (kappa_L, kappa_R) conjoints choisis sur deux transitions, évalués sur la troisième");
const GRID2 = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];
for (const cand of candidatesB) {
  setBreakdowns(eveBreakdowns(cand.spec));
  const D3 = await buildData();
  let num = 0, n = 0, sk = 0, se = 0; const ks = [];
  for (const T of D3) {
    const train = D3.filter((x) => x !== T);
    let best = null;
    for (const kL of GRID2) for (const kR of GRID2) { const e = train.reduce((s, X) => s + evalT(X, kR, X.nationalTarget, kL).sse, 0); if (!best || e < best.e) best = { kL, kR, e }; }
    const known = evalT(T, best.kR, T.nationalTarget, best.kL), atEve = evalT(T, best.kR, eve[T.id], best.kL);
    num += known.sse; n += known.n; sk += known.seatErr; se += atEve.seatErr; ks.push(`${T.id}:L${best.kL}/R${best.kR}/${atEve.seatErr}`);
  }
  console.log(`  ${cand.label.padEnd(28)} RMSE ${Math.sqrt(num / n).toFixed(3)} ; sièges vote connu ${sk} ; sièges veille ${se} (${ks.join(" ")})`);
}

// --- Coefficients sur les trois transitions, grille fine ------------------------
for (const cand of [{ label: "fenêtre 14 j", spec: { window: 14 } }, { label: "tau=240 D=16", spec: { tau: 240, D: 16 } }]) {
  setBreakdowns(eveBreakdowns(cand.spec));
  const D4 = await buildData();
  let best = null;
  for (const kL of GRID2) for (const kR of GRID2) { const e = D4.reduce((s, X) => s + evalT(X, kR, X.nationalTarget, kL).sse, 0); if (!best || e < best.e) best = { kL, kR, e }; }
  const per = D4.map((T) => `${T.id} ${evalT(T, best.kR, eve[T.id], best.kL).seatErr}`).join(" ");
  const ref = D4.map((T) => `${T.id} ${evalT(T, 0.5, eve[T.id], 0.5).seatErr}`).join(" ");
  console.log(`${cand.label} : kappa_L ${best.kL}, kappa_R ${best.kR} ; sièges veille ${per} (avec 0,5/0,5 : ${ref})`);
}
