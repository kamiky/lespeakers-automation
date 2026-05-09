# Architecture simple et scalable (sans 50 outils)

## Commandes yarn — étapes déjà implémentées (`automation/`)

Les scripts **step 0 → 2** du pipeline agences sont exécutables depuis le dossier **`automation/`** :

```bash
yarn scrape:event-agencies:step0 --country=fr
yarn scrape:event-agencies:step0 --country=fr --prod
yarn scrape:event-agencies:step1
yarn scrape:event-agencies:step2
```

Docs détaillées : [`documentations/README.md`](./README.md), [`scrape_event_agencies_from_google_maps_step0.md`](./scrape_event_agencies_from_google_maps_step0.md), etc.

---

Vu ton profil technique, je ne partirais PAS sur PhantomBuster long terme.

Je ferais un pipeline Node.js propre :

```text
Google Maps Search
    ↓
Scraping agences
    ↓
Website extraction
    ↓
LinkedIn company discovery
    ↓
LinkedIn employees discovery
    ↓
Email extraction
    ↓
Spreadsheet / DB
```

Le tout :

- full auto
- pilotable avec Cursor
- scalable
- relançable
- sans SaaS partout

---

# Stack que je recommande

## Core

- Node.js
- TypeScript
- Playwright
- Cheerio
- Google Sheets API
  OU
- CSV simple

---

# APIs / libs

## Google Maps scraping

Je recommande :

### Option 1 — Apify Google Maps Scraper

Le plus simple.

[Apify Google Maps Scraper](https://apify.com/compass/google-maps-extractor?utm_source=chatgpt.com)

Pourquoi :

- extrêmement fiable
- pas besoin gérer captchas
- cheap
- scalable

Tu peux lancer :

```text
agence événementielle paris
```

et récupérer :

- nom
- site
- téléphone
- adresse
- reviews

via API JSON.

---

## LinkedIn company discovery

Simple Google search automatisé :

```text
site:linkedin.com/company "Deal4Event"
```

Puis extraction premier résultat.

PAS besoin de scraper LinkedIn directement au début.

---

## Employee discovery

Même logique :

```text
site:linkedin.com/in "Deal4Event"
```

Puis filtrage IA/code :

- founder
- CEO
- business
- partnerships
- event

---

## Email enrichment

Le plus intelligent :

### Dropcontact API

[Dropcontact](https://www.dropcontact.com?utm_source=chatgpt.com)

Parce que :

- France
- RGPD friendly
- très bon sur PME FR

Alternative :

- Hunter
- Apollo

Mais Dropcontact est probablement le meilleur fit pour ton cas.

---

# Pipeline recommandé

# STEP 1 — Cities list

Tu crées :

```ts
const cities = [
  "Paris",
  "Lyon",
  "Marseille",
  "Bordeaux",
  "Lille",
  "Nantes",
  "Toulouse",
  "Nice",
  "Cannes",
  "Monaco",
];
```

---

# STEP 2 — Search variants

```ts
const searches = [
  "agence événementielle",
  "communication événementielle",
  "event agency",
  "agence incentive",
  "corporate event agency",
];
```

---

# STEP 3 — Generate search queries

```ts
`${search} ${city}`;
```

Exemple :

```text
agence événementielle paris
```

---

# STEP 4 — Scrape Google Maps

Via Apify API.

Résultat :

```ts
{
  (name, website, phone, address, rating, category);
}
```

---

# STEP 5 — Clean & dedupe

Très important.

Normalise :

- URLs
- noms
- téléphones

Puis :

- déduplication par domaine

---

# STEP 6 — Find LinkedIn company

Google programmable search.

Query :

```text
site:linkedin.com/company "AGENCY_NAME"
```

Tu prends :

- premier résultat pertinent

Stocke :

```ts
linkedin_company_url;
```

---

# STEP 7 — Find employees

Google search :

```text
site:linkedin.com/in "AGENCY_NAME"
```

Puis filtre.

Tu peux même faire scorer par GPT :

```ts
["CEO", "Founder", "Directeur", "Partnership", "Business Development"];
```

---

# STEP 8 — Extract emails

Méthode hybride.

## 1. Scrape website

Cherche :

- mailto:
- regex emails
- contact page
- mentions légales

Très efficace sur PME françaises.

---

## 2. Dropcontact enrichment

Avec :

- prénom
- nom
- domaine

Tu récupères :

- email pro validé

---

# STEP 9 — Store

Je ferais :

## Option simple

CSV.

## Option propre

Supabase.

Vu ton stack :
→ Supabase évident.

Tables :

```sql
agencies
contacts
outreach
```

---

# STEP 10 — Export spreadsheet

Google Sheets API.

OU export CSV périodique.

---

# Structure finale

## agencies

```ts
{
  (id,
    name,
    city,
    website,
    linkedin_company_url,
    phone,
    email,
    category,
    google_rating);
}
```

---

## contacts

```ts
{
  (agency_id, first_name, last_name, role, linkedin_url, email, score);
}
```
