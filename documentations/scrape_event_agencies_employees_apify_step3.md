# scrape_event_agencies_employees_apify_step3 (STEP 3)

## Exemples yarn (`automation/`)

```bash
yarn scrape:event-agencies:step3
yarn scrape:event-agencies:step3 --force --limit=10
yarn scrape:event-agencies:step3 --input=./output/scrape_event_agencies_fr_paris_debug.json
yarn scrape:event-agencies:step3 --max-employees=5
```

**STEP 3** du pipeline. Lit les JSON canoniques (même mécanisme que la
[STEP 2](./scrape_event_agencies_linkedin_from_apify_step2.md)) et enrichit chaque agence avec :

`employees: Array<{ linkedin_url, contact_email, name, job, role_bucket }>`

- **`linkedin_url`** : profil `linkedin.com/in/...` normalisé (`https://www.linkedin.com/in/<slug>/`).
- **`contact_email`** : toujours `null` ici — **STEP 4** (ex. Dropcontact).
- **`name`** / **`job`** : dérivés du titre (et parfois de la description) Google.
- **`role_bucket`** : heuristique sur le texte : `founder` \| `leadership` \| `partnerships` \| `commercial` \| `event` \| `other` (tri prioritaire avant plafond).

Requête Apify (`apify/google-search-scraper`) :

```text
site:linkedin.com/in "COMPANY_NAME" CITY
```

`COMPANY_NAME` = **`company_name`** (ou dérivé comme à l’écriture canonique), `CITY` = ville Maps.

---

## Idempotence

- Auto-input : merge partition STEP 0 + overlay optionnel des derniers JSON timestampés
  `scrape_event_agencies_with_website_data_*` / `*_with_linkedin_search_*` / `*_with_employees_*`.
- Skip des agences déjà à **`effectiveProcessedStep >= 3`** (sauf `--force`).
- Après cette step, **`processed_step`** est au moins **3** pour les agences traitées.

---

## Paramètres CLI

| Paramètre | Description |
|-------------|-------------|
| `--force` | Retraiter toutes les agences (y compris déjà en step 3). |
| `--limit=<n>` | Plafond d’agences pour ce run. |
| `--max-employees=<n>` | Max de lignes `employees` par agence (défaut **8**, max **50**). |
| `--input` / `--output` | Comme les autres steps. |

**Prérequis** : `APIFY_TOKEN` dans `.env`.

---

## CSV

Colonne **`employees_json`** : JSON compact des `employees` (vide si aucune ligne).

---

## Step suivante

[STEP 4](./action_plan.md) (à venir) : enrichir `contact_email` via Dropcontact ou équivalent.
