# quebec

Modèle de projection des élections générales québécoises (Votovision).

## Organisation

| Dossier | Contenu |
|---|---|
| `src/` | Moteur et modèle : tendance des sondages par processus gaussien en log-ratios isométriques (`gpTrend.js`, `compositional.js`), effets de maison, swing régional et linguistique, effets de circonscription (sortants, chefs, champ spatial), simulation des sièges, `computeProjection.js`. |
| `ingest/` | Entrées du modèle. `depuis_data.mjs` (Node) lit le dépôt de données `votovision/data` ; `export_json.ts`, `candidates.ts` et `cycles.ts` (Deno) produisent chefs, sortants et profils des circonscriptions depuis la base locale `data/polls.duckdb` (non versionnée, `schema.sql`). |
| `tools/` | Projection courante (`compute.mjs`), construction des intrants (`build_*.mjs`, `make_*.mjs`) et validation du modèle sur les élections passées (`*_test.mjs`). |
| `test/` | Test golden : `computeProjection` sur des intrants figés (`fixtures/`), graines et date fixes. |
| `data/` | Intrants et sorties du modèle (JSON). `qc_cycles.json` déclare les constantes de chaque cycle électoral ; `qc_projection.json` est la projection publiée, lue par le site. |

## Utilisation

Le dépôt de données `votovision/data` est cloné à côté (`../data`). Node 26 et Deno 2 ; le
`package-lock.json` fait foi pour les deux runtimes (`nodeModulesDir: "manual"` dans `deno.json`).

```
npm install && npm test             # environnement sain si le test golden passe
cd ../data && deno task vigile      # sondages : sources publiques -> csv/
cd ../quebec && npm run donnees     # ../data/csv -> data/*.json du modèle
npm run compute                     # projection courante -> data/qc_projection.json
deno task candidates                # chefs et candidatures (Wikipédia)
deno task export                    # intrants tirés de la base locale
```

Le cycle courant est 2030. La procédure de reprise après une pause, la bascule de cycle et
l'entretien au fil du cycle sont décrits dans `RUNBOOK.md`.

Les outils de validation qui utilisent les ventilations régionales historiques non republiables
les lisent dans `../data/prive/` lorsqu'il existe.

## Licence

GNU GPL v3 (`LICENSE`).
