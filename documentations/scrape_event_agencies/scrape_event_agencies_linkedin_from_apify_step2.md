# scrape_event_agencies_linkedin_from_apify (STEP 2 — LinkedIn fallback via Apify)

## Exemples yarn (`automation/`)

```bash
yarn scrape:event-agencies:step2 --country=fr
yarn scrape:event-agencies:step2 --country=fr --prod
yarn scrape:event-agencies:step2 --country=fr --city=paris
yarn scrape:event-agencies:step2 --country=fr --force --limit=20
yarn scrape:event-agencies:step2 --input=./output/debug/scrape_event_agencies_fr_paris.json
```

**STEP 2** du pipeline. Lit le JSON produit par la
[STEP 1](./scrape_event_agencies_website_socials_and_contact_step1.md) et
**complète les `linkedin_company_url` manquants** via une recherche Google
faite par l'actor Apify [`apify/google-search-scraper`](https://apify.com/apify/google-search-scraper).

La [STEP 3](./scrape_event_agencies_employees_apify_step3.md) réutilise le même actor pour les profils personne (`linkedin.com/in/...`).

> Cette étape ne touche **que** les agences pour lesquelles la STEP 1 n'a rien trouvé.
> Les agences qui ont déjà `linkedin_company_url != null` sont gardées telles quelles.

---

## Idempotent par défaut

Cette étape est **resumable** :

- L'auto-input merge la **partition STEP 0** pour `--country` + `output/debug|prod/`, avec overlay du **JSON timestampé le plus récent** step 1/2/3 du même pays si présent.
- Une agence est **skippée** si :
  - Elle a déjà un `linkedin_company_url` (trouvé en STEP 1 ou STEP 2 précédente).
  - Son `linkedin_source === 'not_found'` (STEP 2 précédente a essayé sans succès).
- **`--prod`** aligne lecture/écriture sur `output/prod/` (sinon `output/debug/`).

`--force` pour retenter aussi les `not_found` (utile si on a tweaké
`--threshold`). **Les URLs LinkedIn déjà trouvées ne sont jamais écrasées.**

---

## Ce que fait le script

Pour chaque agence "à traiter" :

1. Construit une query :

   ```text
   site:linkedin.com/company "COMPANY_NAME" CITY
   ```

   - `COMPANY_NAME` = champ **`company_name`** (STEP 0) : nom Maps nettoyé des variantes de recherche, ville, pays et écho éventuel de la catégorie. S’il manque sur d’anciens JSON, il est recalculé comme à l’écriture canonique.
   - Quotes autour du nom = exact phrase Google operator.
   - `CITY` ajoutée pour désambiguïser les noms communs (`"Agence Moderne"`).

2. **Toutes les queries sont envoyées en un seul run Apify** (queries séparées par `\n`),
   5 résultats organiques par query. C'est plus économique qu'un run par agence.

3. Pour chaque query, parmi les résultats :
   - On garde uniquement les URLs `linkedin.com/(company|school)/<slug>`.
   - On normalise en `https://www.linkedin.com/company/<slug>/` (sans tracking).
   - On calcule un **score de similarité** (Jaccard sur tokens normalisés ≥3 chars)
     entre le titre du résultat et le libellé **`company_name`** (même base que la
     query ; le titre LinkedIn est nettoyé du suffixe `| LinkedIn`).
   - Le meilleur score qui passe le seuil (`--threshold`, défaut **0.4**)
     est retenu.

4. Les agences enrichies récupèrent :

   ```jsonc
   {
     "linkedin_company_url": "https://www.linkedin.com/company/elyzee-events/",
     "linkedin_source": "apify_google_search",
     "linkedin_match_score": 0.67
   }
   ```

5. Les agences toujours sans match passent à `linkedin_source: "not_found"`.

## Paramètres CLI

| Paramètre          | Obligatoire | Défaut                                                                                | Description                                                                  |
|--------------------|-------------|---------------------------------------------------------------------------------------|------------------------------------------------------------------------------|
| `--country=<cc>`   | oui         | -                                                                                     | Pays, ex. `fr`.                                                             |
| `--city=<nom>`     | non         | toutes les villes                                                                     | Casse ignorée ; ne traite / ne réécrit que le JSON de cette ville.           |
| `--prod`           | non         | `false`                                                                               | `output/prod/` au lieu de `output/debug/`.                                   |
| `--input=<path>`   | non         | merge STEP 0 canonique                                                                | JSON d’entrée explicite.                                                     |
| `--force`          | non         | `false`                                                                               | Retente aussi les agences marquées `not_found` par un run précédent.         |
| `--limit=<n>`      | non         | -                                                                                     | Cap dur sur le nombre d'agences traitées dans ce run.                        |
| `--threshold=<f>`  | non         | `0.4`                                                                                 | Seuil Jaccard de validation (0..1). Plus haut = plus strict.                 |
| `--output=<dir>`   | non         | `automation/output`                                                                   | Racine ; canoniques sous `<dir>/debug|prod/`.                                |

## Variables d'environnement

| Variable      | Obligatoire | Description                                                                 |
|---------------|-------------|-----------------------------------------------------------------------------|
| `APIFY_TOKEN` | oui         | Même token que la STEP 0.                                                   |

## Exécution

```bash
yarn scrape:event-agencies:step2 --country=fr

# retenter aussi les "not_found"
yarn scrape:event-agencies:step2 --country=fr --force

# input explicite
yarn scrape:event-agencies:step2 --country=fr \
  --input=./output/debug/scrape_event_agencies_fr_paris.json

# threshold plus strict (moins de faux positifs, mais moins de matches)
yarn scrape:event-agencies:step2 --country=fr --threshold=0.5
```

## Format de sortie

Les steps 0–3 **réécrivent les fichiers canoniques** (voir [STEP 0](./scrape_event_agencies_from_google_maps_step0.md)) :

- `output/<debug|prod>/scrape_event_agencies_<country>_<citySlug>.json`
- `output/<debug|prod>/scrape_event_agencies_<country>.csv`

Champs : tous ceux de la STEP 1, plus :

| Champ                  | Description                                                                                            |
|------------------------|--------------------------------------------------------------------------------------------------------|
| `linkedin_match_score` | Score Jaccard du match (`null` si trouvé en STEP 1 ou pas trouvé du tout).                             |
| `linkedin_source`      | Mis à `"apify_google_search"` pour les nouveaux matches, `"not_found"` pour les agences sans match. Reste `"website"` pour celles déjà résolues en STEP 1. |

## Stats imprimées en fin de run

```text
[skip] 7 agency(ies) already resolved or already attempted (use --force to retry "not_found").
[stats] LinkedIn total: 9/10 (90%)
[stats]   from website : 7
[stats]   from apify   : 2
[stats]   not_found    : 1
```

## Coûts Apify (ordre de grandeur)

- Actor `apify/google-search-scraper` : **~3,50 USD / 1000 résultats organiques**.
- Une query = 5 résultats demandés. Donc **~5 résultats par agence non résolue**.
- 100 agences à compléter = ~500 résultats = **~1,75 USD**.
- 1000 agences à compléter = **~17,50 USD**.

Très cheap par rapport à la STEP 0. Et avec l'idempotence, on ne paie jamais
deux fois pour la même agence (sauf `--force`).

## Pièges connus

- **Faux positifs** : si une grosse boîte a un nom proche d'une petite agence,
  Google peut renvoyer la grosse en premier. Le filtre Jaccard limite, mais
  pas à 100%. Augmenter `--threshold` à 0.5 ou 0.6 si tu vois trop de bruit,
  puis relancer avec `--force` pour réévaluer les `not_found`.
- **Pas de match** : certaines agences n'ont juste pas de page LinkedIn company.
  C'est OK, elles auront `linkedin_source: "not_found"`.
- **Multi-établissements** : "Innov'events Paris" vs "Innov'events Lyon" — la
  page LinkedIn corporate est unique. La query inclut la ville mais le matcher
  ne pénalise pas si la ville n'est pas dans le titre. Solution si problème :
  désambigüer plus tard (étape 3+).
