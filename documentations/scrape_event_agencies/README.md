# Pipeline `scrape_event_agencies` — overview

## Exemples yarn (`automation/`)

Toutes les commandes ci-dessous supposent le répertoire **`automation/`** (où se trouve `package.json`).

```bash
yarn scrape:event-agencies:step0 --country=fr
yarn scrape:event-agencies:step0 --country=fr --prod
yarn scrape:event-agencies:step0:prod --country=fr
yarn scrape:event-agencies:step1
yarn scrape:event-agencies:step1 --debug-url=https://example.com/ --apify-when-block
yarn scrape:event-agencies:step2
yarn scrape:event-agencies:step2 --force --limit=20
yarn scrape:event-agencies:step3
yarn scrape:event-agencies:step3 --force --limit=10
```

Pipeline d'enrichissement de la base d'**agences événementielles** par pays.
Chaque step lit le **JSON** produit par la précédente, l'enrichit, et écrit
un nouveau **JSON + CSV** dans `output/`. Les outputs sont chaînés via
l'identifiant unique `place_id` (Google).

> Plan d'origine : [`action_plan.md`](../action_plan.md) · nettoyage employees : [`employees_cleanup_action_plan.md`](./employees_cleanup_action_plan.md)

---

## Scripts (dans l'ordre du pipeline)

| Step | Script (`scripts/scrape_event_agencies/`)                            | En 1 ligne                                                                                            | Tech                | Coût      | Doc                                                                                                  |
|------|----------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|---------------------|-----------|------------------------------------------------------------------------------------------------------|
| 0    | `scrape_event_agencies_step0.ts`                                     | Scrape la liste des agences depuis Google Maps via Apify (`compass/google-maps-extractor`).           | Apify Google Maps   | $$        | [doc](./scrape_event_agencies_from_google_maps_step0.md)                                             |
| 1    | `scrape_event_agencies_website_socials_and_contact_step1.ts`         | Scrape site : LinkedIn, emails, réseaux sociaux.                                                    | axios + cheerio     | gratuit   | [doc](./scrape_event_agencies_website_socials_and_contact_step1.md)                                  |
| 2    | `scrape_event_agencies_linkedin_from_apify_step2.ts`                 | Pour les agences sans LinkedIn après step 1, fallback Google search via Apify (`apify/google-search-scraper`). | Apify Google Search | $         | [doc](./scrape_event_agencies_linkedin_from_apify_step2.md)                                          |
| 3    | `scrape_event_agencies_employees_apify_step3.ts`                     | Google `site:linkedin.com/in` + Apify : URLs profils, rôles ; `contact_email` en step 4.              | Apify Google Search | $         | [doc](./scrape_event_agencies_employees_apify_step3.md)                                              |
| 4    | _à venir_                                                            | Enrichissement emails pro via Dropcontact (prénom + nom + domaine).                                   | Dropcontact API     | $         | -                                                                                                    |
| 5    | _à venir_                                                            | Stockage en base (Supabase ou autre).                                                                 | -                   | -         | -                                                                                                    |

## Quick-start

Voir aussi **§ Exemples yarn** en tête de ce fichier pour la liste condensée des commandes.

```bash
yarn install
cp .env.example .env   # puis ajouter APIFY_TOKEN

yarn scrape:event-agencies:step0 --country=fr     # debug (1 ville, 1 variante, 10 résultats)
yarn scrape:event-agencies:step1                  # traite ce que step 0 a sorti
yarn scrape:event-agencies:step2                  # traite ce que step 1 a sorti
```

En prod :

```bash
yarn scrape:event-agencies:step0 --country=fr --prod    # toutes villes x toutes variantes
yarn scrape:event-agencies:step1                        # idem qu'en debug, traite tout l'input
yarn scrape:event-agencies:step2                        # idem qu'en debug, traite tout l'input
```

> Le scope **debug / prod est choisi UNE SEULE fois à la step 0**. Les step 1
> et 2 traitent simplement ce qu'il y a dans leur input.

## Idempotent / resumable

**Toutes les steps sont idempotentes** : on peut relancer sans peur de payer ou bosser deux fois.

### Step 0 (Apify Google Maps)

- L'output est **cumulatif** : on auto-charge le dernier output existant pour ce pays (enrichissements step 1/2 préservés) et on ajoute uniquement les nouvelles agences.
- **Skip par défaut** les requêtes `(city, variant)` déjà lancées avant pour ce pays. Si tout est déjà fait → script exit early, **0 USD payé**.
- Dédup par `place_id` contre l'existant.
- `--refresh-all` : re-lance TOUTES les requêtes même les déjà-connues (utile pour capter les nouvelles agences indexées par Google).

### Step 1 et step 2

- **Skippent par défaut** les agences déjà traitées.
- **Reprennent automatiquement** depuis le dernier output (step 0/1 pour step 1, step 1/2 pour step 2).
- Step 2 ne paie jamais Apify deux fois pour la même agence (sauf `--force`).

Flags utiles :

| Flag            | Step 0                                                                   | Step 1                                                 | Step 2                                                             |
|-----------------|--------------------------------------------------------------------------|--------------------------------------------------------|--------------------------------------------------------------------|
| `--refresh-all` | Re-lance toutes les requêtes (même les déjà-connues)                    | -                                                      | -                                                                  |
| `--force`       | -                                                                        | Retraite tout (utile pour retenter http_error/timeout) | Retente aussi les `not_found` (utile après tweak de `--threshold`) |
| `--limit`       | -                                                                        | Cap sur le nb d'agences traitées dans CE run           | Cap sur le nb d'agences traitées dans CE run                       |
| `--input`       | -                                                                        | Override le fichier d'entrée                           | Override le fichier d'entrée                                       |

## Naming des fichiers de sortie

```text
output/scrape_event_agencies_<country>_<mode>_<ts>.{json,csv}                          # STEP 0
output/scrape_event_agencies_with_website_data_<country>_<mode>_<ts>.{json,csv}        # STEP 1
output/scrape_event_agencies_with_linkedin_search_<country>_<mode>_<ts>.{json,csv}     # STEP 2
```

`<country>` et `<mode>` sont décidés à la STEP 0 et **propagés** par les steps suivantes
(inférés depuis le nom du fichier d'input).
