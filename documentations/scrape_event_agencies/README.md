# Pipeline `scrape_event_agencies` — overview

## Exemples yarn (`automation/`)

Toutes les commandes ci-dessous supposent le répertoire **`automation/`** (où se trouve `package.json`).

```bash
yarn scrape:event-agencies:step0 --country=fr
yarn scrape:event-agencies:step0 --country=fr --prod
yarn scrape:event-agencies:step0:prod --country=fr
yarn scrape:event-agencies:step0 --country=fr --city=paris
yarn scrape:event-agencies:step1 --country=fr
yarn scrape:event-agencies:step1 --debug-url=https://example.com/ --apify-when-block
yarn scrape:event-agencies:step2 --country=fr --force --limit=20
yarn scrape:event-agencies:step3 --country=fr --force --limit=10
```

Pipeline d'enrichissement de la base d'**agences événementielles** par pays.
Chaque step lit le **JSON** produit par la précédente, l'enrichit, et écrit
un **JSON par ville** + **CSV pays** dans `output/debug/` ou `output/prod/`. Les outputs sont chaînés via
l'identifiant unique `place_id` (Google).

> Plan d'origine : [`action_plan.md`](../action_plan.md) · nettoyage employees : [`employees_cleanup_action_plan.md`](./employees_cleanup_action_plan.md)

---

## Scripts (dans l'ordre du pipeline)

| Step | Script (`scripts/scrape_event_agencies/`)                    | En 1 ligne                                                                                                     | Tech                | Coût    | Doc                                                                 |
| ---- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------- | ------- | ------------------------------------------------------------------- |
| 0    | `scrape_event_agencies_step0.ts`                             | Scrape la liste des agences depuis Google Maps via Apify (`compass/google-maps-extractor`).                    | Apify Google Maps   | $$      | [doc](./scrape_event_agencies_from_google_maps_step0.md)            |
| 1    | `scrape_event_agencies_website_socials_and_contact_step1.ts` | Scrape site : LinkedIn, emails, réseaux sociaux.                                                               | axios + cheerio     | gratuit | [doc](./scrape_event_agencies_website_socials_and_contact_step1.md) |
| 2    | `scrape_event_agencies_linkedin_from_apify_step2.ts`         | Pour les agences sans LinkedIn après step 1, fallback Google search via Apify (`apify/google-search-scraper`). | Apify Google Search | $       | [doc](./scrape_event_agencies_linkedin_from_apify_step2.md)         |
| 3    | `scrape_event_agencies_employees_apify_step3.ts`             | Google `site:linkedin.com/in` + Apify : URLs profils, rôles ; `contact_email` en step 4.                       | Apify Google Search | $       | [doc](./scrape_event_agencies_employees_apify_step3.md)             |
| 4    | _à venir_                                                    | Enrichissement emails pro via Dropcontact (prénom + nom + domaine).                                            | Dropcontact API     | $       | -                                                                   |
| 5    | _à venir_                                                    | Stockage en base (Supabase ou autre).                                                                          | -                   | -       | -                                                                   |

## Quick-start

Voir aussi **§ Exemples yarn** en tête de ce fichier pour la liste condensée des commandes.

```bash
yarn install
cp .env.example .env   # puis ajouter APIFY_TOKEN

yarn scrape:event-agencies:step0 --country=fr     # output/debug/ — toutes les villes, 1 variante, max 10 résultats/recherche
yarn scrape:event-agencies:step1 --country=fr     # lit output/debug/, réécrit les mêmes fichiers canoniques
yarn scrape:event-agencies:step2 --country=fr
```

En prod :

```bash
yarn scrape:event-agencies:step0 --country=fr --prod    # output/prod/ — toutes villes × toutes variantes, max 50/recherche
yarn scrape:event-agencies:step1 --country=fr --prod
yarn scrape:event-agencies:step2 --country=fr --prod
```

> Chaque step prend **`--prod`** (ou pas) pour choisir le dossier `output/prod/`
> vs `output/debug/`. **`--country`** est obligatoire sur les steps 0–3 (sauf
> `--debug-url` sur la step 1). **`--city=paris`** (insensible à la casse) ne
> traite / ne réécrit que le JSON de cette ville (+ le CSV pays complet).

## Idempotent / resumable

**Toutes les steps sont idempotentes** : on peut relancer sans peur de payer ou bosser deux fois.

### Step 0 (Apify Google Maps)

- L'output est **cumulatif** : on auto-charge le dernier output existant pour ce pays (enrichissements step 1/2 préservés) et on ajoute uniquement les nouvelles agences.
- **Skip par défaut** les requêtes `(city, variant)` déjà lancées avant pour ce pays. Si tout est déjà fait → script exit early, **0 USD payé**.
- Dédup par `place_id` contre l'existant.
- `--force` : re-lance TOUTES les requêtes même les déjà-connues (utile pour capter les nouvelles agences indexées par Google).

### Step 1 et step 2

- **Skippent par défaut** les agences déjà traitées.
- **Reprennent automatiquement** depuis le dernier output (step 0/1 pour step 1, step 1/2 pour step 2).
- Step 2 ne paie jamais Apify deux fois pour la même agence (sauf `--force`).

Flags utiles :

| Flag        | Step 0                         | Step 1 / 2 / 3                                              |
| ----------- | ------------------------------ | ----------------------------------------------------------- |
| `--country` | obligatoire                    | obligatoire (sauf `--debug-url` step 1)                     |
| `--city`    | optionnel (une ville)          | optionnel : ne traite / ne réécrit que le JSON de la ville |
| `--prod`    | `output/prod/` + caps / variantes | idem : dossier prod vs debug                             |
| `--force`   | Re-lance Apify ville par ville | Retraite les agences concernées                             |
| `--limit`   | -                              | Cap sur le nb d'agences traitées dans CE run               |
| `--input`   | -                              | Override le fichier d'entrée                               |

## Naming des fichiers de sortie

Fichiers **canoniques** (réécrits par les steps 0 → 3, sans timestamp) :

```text
output/debug/scrape_event_agencies_<country>_<citySlug>.json   # ou output/prod/… si --prod
output/debug/scrape_event_agencies_<country>.csv
```

Anciens fichiers avec timestamp (`scrape_event_agencies_with_website_data_*`, step0 monolithiques, etc.)
restent **lisibles** au merge quand ils sont encore dans `output/` (racine ou sous-dossiers).
