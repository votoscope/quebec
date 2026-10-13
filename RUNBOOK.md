# RUNBOOK : réveil et exploitation

Procédure pour reprendre le modèle après des mois d'inactivité (gouvernement
minoritaire : prochaines générales possibles dès 2028).

Le dépôt contient le modèle ; les données (sondages, résultats officiels,
recensement) viennent du dépôt `votoscope/data`, cloné à côté (`../data`).

## 1. Vérifier l'environnement

Versions attestées au 2026-10-13 : Deno 2.x, Node 26.x, @duckdb/node-api et
@tangent.to/ds 0.13.x figés par `package-lock.json` (`nodeModulesDir:
"manual"` dans `deno.json` : le lockfile npm fait foi pour les deux runtimes ;
`npm install` avant toute commande Deno).

```
npm install && npm test
```

Le test golden exécute `computeProjection` sur des intrants figés
(`test/fixtures/`) avec graines et date fixes. S'il passe, l'environnement est
sain ; s'il échoue sans changement de code volontaire, c'est la librairie ou
le runtime qui a bougé : diagnostiquer avant toute autre chose. Après un
changement de modèle voulu, régénérer l'attendu sur les fixtures
(`test/make_golden.mjs` recopie les fichiers de `data/` : ne l'utiliser que
pour un changement de cycle) ; le diff de `golden_expected.json` documente
l'effet.

## 2. Données

```
cd ../data && deno task vigile        # sondages : sources publiques -> csv/
cd ../quebec && npm run donnees       # csv/ -> data/*.json du modèle
npm run compute                       # projection (data/qc_projection.json)
```

`ingest/depuis_data.mjs` écrit les séries nationale et régionale, les
résultats par circonscription, la base de la dernière générale et les
partielles du cycle. Chefs, sortants et profils démographiques des
circonscriptions sont encore produits ici (`ingest/export_json.ts`,
`ingest/candidates.ts`, base locale `data/polls.duckdb`, non versionnée).

Les outils de validation qui utilisent les ventilations régionales
historiques non republiables les lisent dans `../data/prive/` (hors dépôt) ;
sans ce dossier, ils s'arrêtent ou retombent sur les ventilations Léger.

## 3. Runtimes

- `ingest/*.ts` : Deno (permissions explicites). `src/`, `tools/*.mjs` et
  `ingest/depuis_data.mjs` : Node.
- `tools/compute.mjs` est lancé par les deux (`deno task compute` /
  `npm run compute`).

## 4. Nouveau cycle électoral

Le cycle courant est 2030. Toutes les constantes et les intrants propres au
cycle sont déclarés dans `data/qc_cycles.json` ; `computeProjection` reçoit le
cycle avec les données (`data.cycle`, sinon ce fichier). Le test golden
épingle le cycle 2026 (`test/fixtures/qc_cycles_2026.json`).

Deux lecteurs du même fichier :
- Node : `src/cycles.js` (`computeProjection.js`, `gpTrend.js`) ;
- Deno : `ingest/cycles.ts` (`export_json.ts`).

Structure de `qc_cycles.json` :
- `cycle`, `electionDate` (premier lundi d'octobre), `previousElectionDate` ;
- `changepoints` : changements de régime documentés, cumulés sur tous les cycles ;
- `campaigns` : fenêtres [décret, scrutin] ; ajouter la fenêtre 2030 au déclenchement ;
- `cycleBoundaries` : [[date limite, année du cycle], ...] pour classer les sondages ;
- `leadersPrevious` : chefs et circonscriptions à la dernière générale ;
- `byelectionBounds` : {after, before} pour les partielles du cycle ;
- `residualTransitions` : transitions du bassin de résidus de la simulation ;
- `files` : intrants du cycle (`baseline`, `incumbents`, `leaders`, `extraResults`).

Procédure de bascule (faite pour 2030 par `tools/build_cycle_2030.mjs`) :
1. Résultats officiels de la dernière générale (dans `../data`, `sources/elections_quebec.ts`), puis `npm run donnees` : baseline et sortants.
2. `qc_cycles.json` : dates, frontière de cycle, partielles, transition ajoutée au bassin, fichiers.
3. Réestimer l'échelle des résidus (`tools/residual_scale_fit.mjs`).

Au fil du cycle 2030 :
- Chefs : `qc_leaders.json` contient les chefs de 2026 ; vérifier par `deno task candidates` dès qu'un chef change ou annonce sa circonscription.
- Effet de chef : `node tools/build_leader_effect.mjs --write` (cas 1976-2014 dans `qc_leader_cases_1970_2014.json`, cas 2018-2026 dans l'outil, `RECENT`). Après chaque générale : ajouter la transition à `TRANSITIONS` (`tools/lib/transitionEval.mjs`) et ses cas à `RECENT`.
- Sortants : marquer `elected_with_note` (départ, changement de bannière) dans `qc_incumbents_2030.json`.
- Sondages : page Wikipédia 2030 à ajouter dans `../data/sources/wikipedia_qc.ts` (`PAGES_QC`) dès sa création ; rapports des sondeurs (ventilations régionales et linguistiques) transcrits dans `../data/sources/rapports/qc/`.
- Ventilations par langue : `qc_leger_crosstabs.json` sous la clé « 2030 ». Ventilations régionales : pondérées par n·exp(−âge/τ) sur l'horloge dilatée (`qc_language_swing.json`, `regionDecay`) ; après chaque générale, réestimer τ, D et les κ (`tools/regional_decay_test.mjs`).
- Carte électorale : si elle change avant 2030, réagréger la baseline par sections de vote (`tools/make_federal.mjs`, `tools/lib/geo.mjs`).

## 5. État post-2026

- `data/qc_projection.json` : projection de veille du 5 octobre 2026 (archivée
  sous `qc_projection_veille_2026-10-05.json`). Un `npm run compute` l'écrase
  par la projection du cycle 2030.
- `data/raw/` : intrants bruts locaux, non versionnés.
