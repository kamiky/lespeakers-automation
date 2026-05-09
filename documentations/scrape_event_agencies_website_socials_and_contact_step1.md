# scrape_event_agencies_website_socials_and_contact_step1 (STEP 1)

## Exemples yarn (`automation/`)

```bash
yarn scrape:event-agencies:step1
yarn scrape:event-agencies:step1 --force --limit=20
yarn scrape:event-agencies:step1 --debug-url=https://example.com/contact
yarn scrape:event-agencies:step1 --apify-when-block --limit=10
```

**STEP 1** du pipeline. Lit les JSON canoniques produits par la
[STEP 0](./scrape_event_agencies_from_google_maps_step0.md) et **réécrit les mêmes fichiers** :

- `output/scrape_event_agencies_<country>_<citySlug>_<mode>.json`
- `output/scrape_event_agencies_<country>_<mode>.csv`

Pour chaque agence à traiter, le script **scrape le site web** (axios + cheerio) et enrichit :

| Champ | Description |
|--------|-------------|
| `linkedin_company_url` | Lien `linkedin.com/company/…` ou `…/school/…` |
| `linkedin_source` | `"website"` si trouvé, sinon `null` |
| `contact_emails[]` | `mailto:` + regex sur le HTML ; **conservés uniquement** si le domaine de l’email correspond au hostname du `website` (ex. `*@le-rideau.fr` pour `www.le-rideau.fr`), après filtre anti-bruit |
| `website_facebook_url` | Lien Facebook / `fb.com` (hors share / dialog) |
| `website_instagram_url` | Profil Instagram |
| `website_twitter_url` | Profil X / Twitter (`x.com` canonique) |
| `website_tiktok_url` | Profil TikTok |
| `website_scrape_status` | `success` \| `no_website` \| `http_error` \| `timeout` \| `parse_error` \| `no_data_found` |
| `website_scrape_error` | Message d’erreur éventuel |
| `website_scraped_url` | URL de la première page HTML utile |

Étape **gratuite** (pas d’API). Si le LinkedIn n’est pas trouvé ici, la
[STEP 2](./scrape_event_agencies_linkedin_from_apify_step2.md) peut compléter.

---

## Comportement HTTP

1. **Homepage** puis, **même si la homepage échoue** (ex. 403), les pages
   `/contact`, `/contact-us`, etc. sont essayées : certaines configurations WAF
   bloquent `/` mais laissent `/contact` en 200.
2. Les signaux (emails, LinkedIn, réseaux) sont **fusionnés** sur
   toutes les pages qui ont renvoyé du HTML.
3. **Cloudflare / WAF « managed challenge »** : beaucoup de sites renvoient **HTTP 403**
   (page « Just a moment… ») aux clients Node/axios. Ce n’est pas un bug de
   header : le blocage vient du **challenge navigateur**. Le script détecte ce
   cas et remonte un message explicite. **Contournement optionnel (uniquement si
   le flag CLI est passé)** : avec `APIFY_TOKEN`, ajouter **`--apify-when-block`**
   ou **`--apify-when-blocked`** (équivalent) sur la commande — y compris sur un
   run pipeline normal sans `--debug-url`. Le fallback charge alors **uniquement
   la homepage** via l’actor Apify
   [`apify/website-content-crawler`](https://apify.com/apify/website-content-crawler)
   (Playwright), seulement lorsque **toutes** les requêtes HTTP directes n’ont
   renvoyé aucun HTML exploitable. Coût Apify par agence concernée.

---

## Idempotence

- Auto-input : merge des JSON canoniques + overlay optionnel d’anciens fichiers
  `scrape_event_agencies_with_website_data_*` / `*_with_linkedin_search_*` (migration).
- Skip des agences déjà à `processed_step >= 1` (ou legacy : `website_scrape_status` défini), sauf `--force`.

---

## Paramètres CLI

| Paramètre | Obligatoire | Description |
|-----------|-------------|---------------|
| `--debug-url=<url>` | non | Scrape **une seule** URL, logs détaillés (`[website-scraper]`), résultat JSON sur stdout ; **aucune** écriture pipeline. Préfixe `https://` ajouté si absent. |
| `--input=<path>` | non | JSON d’entrée explicite. |
| `--output=<dir>` | non | Répertoire des fichiers canoniques (défaut : `automation/output`). |
| `--force` | non | Retraiter toutes les agences. |
| `--limit=<n>` | non | Plafond d’agences traitées. |
| `--concurrency=<n>` | non | Parallélisme HTTP (défaut `5`). |
| `--apify-when-block` | non | Fallback **uniquement** si ce flag est présent : si **aucune** page n’est lisible en HTTP (ex. Cloudflare), tente la homepage via Apify (`APIFY_TOKEN` requis). Fonctionne en run pipeline normal et avec `--debug-url`. |
| `--apify-when-blocked` | non | Alias de `--apify-when-block`. |

### Variable d’environnement (fallback Apify)

| Variable | Description |
|----------|-------------|
| `APIFY_TOKEN` | Obligatoire pour que le fallback Apify s’exécute lorsque le flag `--apify-when-block` / `--apify-when-blocked` est passé (même token que STEP 0 / STEP 2). |

---

## Exécution

```bash
yarn scrape:event-agencies:step1

# Déboguer une URL précise (ex. site qui renvoie 403 sur la home)
yarn scrape:event-agencies:step1 --debug-url=https://www.agence-evenementielle-innovevents.fr/reseau-evenementiel/paris/

# Même URL, avec contournement Cloudflare via Apify (Playwright)
yarn scrape:event-agencies:step1 --debug-url=https://www.agence-evenementielle-innovevents.fr/reseau-evenementiel/paris/ --apify-when-block

# Run pipeline normal : même fallback pour chaque agence si besoin
yarn scrape:event-agencies:step1 --apify-when-block --limit=20

yarn scrape:event-agencies:step1 --force --limit=20
```

---

## Fichiers legacy

Les anciens outputs `scrape_event_agencies_with_website_data_<country>_<mode>_<timestamp>.json`
restent utilisables comme **overlay** de migration ; les nouvelles runs écrivent
uniquement les **fichiers canoniques** ci-dessus.
