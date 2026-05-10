# scrape_event_agencies (STEP 0 — Google Maps via Apify)

## Exemples yarn (`automation/`)

```bash
yarn scrape:event-agencies:step0 --country=fr
yarn scrape:event-agencies:step0 --country=fr --prod
yarn scrape:event-agencies:step0:prod --country=fr
yarn scrape:event-agencies:step0 --country=fr --refresh-all
```

**STEP 0** du pipeline d'enrichissement des **agences événementielles** par pays.

Récupère la liste brute des agences depuis Google Maps via Apify (actor
`compass/google-maps-extractor`).

> Source du plan global : [`action_plan.md`](../action_plan.md)

---

## Pipeline complet

| Step | Script (`scripts/scrape_event_agencies/`)                            | Doc                                                                                                  | Tech                | Coût      | Statut       |
|------|-----------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|---------------------|-----------|--------------|
| 0    | `scrape_event_agencies_step0.ts`                                      | _ce fichier_                                                                                         | Apify Google Maps   | $$        | ✅ implémenté|
| 1    | `scrape_event_agencies_website_socials_and_contact_step1.ts`          | [doc](./scrape_event_agencies_website_socials_and_contact_step1.md)                                   | axios + cheerio     | gratuit   | ✅ implémenté|
| 2    | `scrape_event_agencies_linkedin_from_apify_step2.ts`                  | [doc](./scrape_event_agencies_linkedin_from_apify_step2.md)                                          | Apify Google Search | $         | ✅ implémenté|
| 3    | `scrape_event_agencies_employees_apify_step3.ts`                      | [doc](./scrape_event_agencies_employees_apify_step3.md)                                              | Apify Google Search | $         | ✅ implémenté|
| 4    | _à venir_ — email enrichment (Dropcontact)                            | -                                                                                                    | Dropcontact API     | $         | ⏳ à faire   |
| 5    | _à venir_ — stockage (Supabase)                                       | -                                                                                                    | -                   | -         | ⏳ à faire   |

**Format de pipeline** : les steps **0, 1 et 2** réécrivent les **mêmes fichiers canoniques** (pas de timestamp dans les noms) :

- **JSON par ville** : `output/scrape_event_agencies_<country>_<citySlug>_<mode>.json`
- **CSV global** (toutes villes, toutes colonnes enrichies) : `output/scrape_event_agencies_<country>_<mode>.csv`

Les anciens fichiers `scrape_event_agencies_with_website_data_*` / `*_with_linkedin_search_*` avec timestamp restent **lisibles** au merge (migration) mais ne sont plus produits par défaut.

**Fichiers monolithiques legacy (STEP 0)** : `output/scrape_event_agencies_<country>_<mode>_<timestamp>.json` (et variante `_<timestamp>_<citySlug>.json`) restent **lus** au merge et pour le skip par ville, puis la sortie est **normalisée** vers les noms canoniques ci-dessus.

---

## Inputs (constants)

- `src/constants/cities.json` — liste des villes par pays
- `src/constants/event_agencies_variants.json` — variantes de recherche par pays

Pour ajouter un nouveau pays, ajoutez simplement la clé (ex. `"es"`) dans
les deux fichiers.

---

## Ce que fait l'étape

1. Charge les villes et les variantes pour le pays passé en paramètre.
2. **Charge l'état existant** :
   - tous les JSON canoniques **par ville** pour ce `country` + `mode` ;
   - éventuellement des JSON monolithiques legacy (timestamp) ;
   - le dernier JSON step **1 ou 2** « avec timestamp » pour ce pays (si présent) → migration / enrichissements.
3. **Réécrit** tous les JSON par ville concernés + le **CSV global** (normalisation / migration).
4. Pour **chaque ville** planifiée :
   - **Skip** la ville si `scrape_event_agencies_<country>_<citySlug>_<mode>.json` existe déjà (sauf `--refresh-all`).
   - Sinon, si seul un **legacy monolithique** existe : skip la ville seulement si **toutes** les requêtes `${variant} ${city}` sont déjà dans les `search_query` chargées.
   - Sinon : un run Apify pour cette ville uniquement.
   - **Dédup par `place_id`** sur l’état mémoire.
   - **Réécrit** à nouveau les JSON par ville + le CSV global.

## Modes

- **Debug (défaut)** : 1 ville (Paris si dispo, sinon la première), 1 variante
  (la première), max 10 résultats. Utile pour valider la chaîne sans cramer
  de crédits.
- **Prod** (`--prod`) : toutes les villes × toutes les variantes du pays,
  max 50 résultats par recherche.

> **NB pour debug** : la 1re run debug écrit `scrape_event_agencies_fr_<parisSlug>_debug.json` + `scrape_event_agencies_fr_debug.csv`. Les runs suivants **skip** la ville si ce JSON existe — exit sans Apify. Pour re-scraper : `--refresh-all` ou supprimer ce fichier JSON.

## Paramètres CLI

| Paramètre         | Obligatoire | Défaut                                                          | Description                                                                                                                                |
|-------------------|-------------|-----------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `--country=<cc>`  | oui         | -                                                               | Code pays (`fr`, `en`, ...). Doit exister dans les deux JSON.                                                                              |
| `--prod`          | non         | `false` (debug)                                                 | Active le mode prod (toutes villes × toutes variantes).                                                                                    |
| `--refresh-all`   | non         | `false`                                                         | Re-lance Apify pour **chaque** ville, même si un JSON par ville existe déjà.                                                               |
| `--max=<n>`       | non         | `10` debug / `50` prod                                          | Override du nombre max de résultats par recherche.                                                                                         |
| `--output=<dir>`  | non         | `automation/output`                                             | Répertoire de sortie (les noms de fichiers suivent la convention ci-dessus).                                                              |

## Variables d'environnement

| Variable       | Obligatoire | Description                                                                 |
|----------------|-------------|-----------------------------------------------------------------------------|
| `APIFY_TOKEN`  | oui         | Token API Apify ([console.apify.com/account/integrations](https://console.apify.com/account/integrations)). |

```bash
cp .env.example .env
# puis éditer .env et coller votre APIFY_TOKEN
```

## Exécution

```bash
yarn install

# debug (1 ville, 1 variante, 10 résultats) — skip villes déjà couvertes
yarn scrape:event-agencies:step0 --country=fr

# prod (toutes villes x toutes variantes pour FR)
yarn scrape:event-agencies:step0 --country=fr --prod
yarn scrape:event-agencies:step0:prod --country=fr   # alias équivalent

# REFRESH : re-scraper toutes les villes (même si JSON par ville déjà présent)
yarn scrape:event-agencies:step0 --country=fr --prod --refresh-all

# override max et répertoire de sortie
yarn scrape:event-agencies:step0 --country=fr --max=25 --output=output/my_batch

# direct (sans alias yarn)
npx tsx scripts/scrape_event_agencies/scrape_event_agencies_step0.ts --country=fr --prod
```

## Format de sortie

### JSON (par ville)

`output/scrape_event_agencies_<country>_<citySlug>_<mode>.json`

Tableau d’agences dont la `search_query` correspond à l’une des requêtes Maps pour cette ville (enrichi par les steps 1/2).

### CSV global

`output/scrape_event_agencies_<country>_<mode>.csv`

Une seule table **toutes villes confondues** (colonnes complètes après step 1/2), réécrite à chaque flush.

Champs principaux du JSON (le CSV step 1+ inclut aussi LinkedIn / emails / scrape site) :

| Champ                | Description                                              |
|----------------------|----------------------------------------------------------|
| `processed_step`    | Avancement pipeline (voir types `Agency`)                |
| `search_query`       | Requête Google Maps utilisée (`${variant} ${city}`)     |
| `name`               | Nom de l'agence (titre Google Maps)                      |
| `company_name`       | Libellé court : `name` sans variantes de recherche, ville, pays ni répétition de la catégorie ; puis troncature au premier ` - ` / tiret long / `_` / `/` (tagline Maps) (réécrit à chaque export canonique) |
| `category`           | Catégorie principale (Google)                            |
| `address`            | Adresse complète                                         |
| `city`               | Ville extraite par Google                                |
| `postal_code`        | Code postal                                              |
| `country_code`       | Code pays (renvoyé par Google)                           |
| `website`            | Site web                                                 |
| `phone`              | Téléphone                                                |
| `google_maps_url`    | URL Google Maps de la fiche                              |
| `place_id`           | `placeId` Google (identifiant unique dans la pipeline)  |

## Optimisations de coût Apify

L'input passé à l'actor est volontairement minimal :

- `scrapePlaceDetailPage: false` → on ne fait PAS la 2ᵉ requête vers la fiche
  détail Google. On a déjà tout ce dont on a besoin (nom, adresse, téléphone,
  site, catégorie, place_id) depuis la liste de résultats. ~2× moins cher,
  bien plus rapide.
- `skipClosedPlaces: true` → on ne paie pas pour les fiches fermées
  définitivement.
- `scrapeReviewsPersonalData: false` → pas d'extraction des reviewers.

> Les emails ne sont **pas** extraits ici. C'est la STEP 1 qui s'en occupe
> via le scraping de site web (gratuit), avec un fallback Dropcontact prévu
> à la STEP 4.

## Re-runs : comment ça marche

Apify facture **par place retournée**. Le script limite les coûts ainsi :

### Skip par ville (défaut)

Si le fichier canonique **`scrape_event_agencies_<country>_<citySlug>_<mode>.json`** existe déjà, la ville est **ignorée** : pas d’appel Apify, pas de dépense.

Conséquence : si vous **ajoutez une nouvelle variante** de recherche dans `event_agencies_variants.json`, une ville déjà « figée » par son JSON ne prendra **pas** en compte la nouvelle variante tant que vous ne supprimez pas son JSON ou ne passez pas **`--refresh-all`**.

### Legacy monolithique

Tant qu’il reste d’anciens fichiers **`..._<ts>.json`** sans slug de ville, le script les charge au merge. Pour le skip d’une ville **sans** JSON dédié, on vérifie si **toutes** les combinaisons `(variante, ville)` attendues sont déjà présentes dans les `search_query` des données chargées.

### `--refresh-all` (override)

Re-lance Apify **ville par ville**, même si les JSON par ville existent déjà (utile pour capter de nouvelles fiches Google). Le dédup par `place_id` continue de préserver les enrichissements step 1/2.

### Dédup automatique par `place_id` (toujours actif)

Quand Apify renvoie une agence déjà connue (`place_id`), on garde la version déjà en mémoire (y compris enrichissements). Seules les nouvelles agences sont ajoutées.

### STEP 1 — lecture des JSON step 0

Sans `--input`, la step 1 **merge automatiquement** la partition step0 la plus récente (fichiers par ville + legacy) puis applique par-dessus le dernier JSON step 1/2 du même pays si besoin. Vous pouvez toujours pointer explicitement un seul JSON avec `--input=...`.

## Coûts Apify (ordre de grandeur)

L'actor `compass/google-maps-extractor` est facturé **au résultat** (~ 4 USD / 1000 places en mode "place only", à vérifier sur la page actor). En debug, on plafonne à 10 résultats donc le test coûte des centimes.

| Scénario                                                                    | Coût estimé      |
|-----------------------------------------------------------------------------|------------------|
| Premier run prod FR (N villes × V variantes × 50)                          | ~ variable       |
| Re-run : villes déjà couvertes par JSON dédié                               | **0 USD**        |
| Re-run avec `--refresh-all` (toutes les villes re-scrapées)                 | ~ coût « plein » |
