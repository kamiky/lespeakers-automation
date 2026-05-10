# Automation — documentation

Documentation du pipeline **scraping agences événementielles** :

- **[`scrape_event_agencies/README.md`](./scrape_event_agencies/README.md)** — vue d’ensemble, commandes `yarn scrape:event-agencies:*`, liens vers les steps 0–3.
- **[`open_agencies_linkedin/README.md`](./open_agencies_linkedin/README.md)** — boucle interactive `yarn outreach:linkedin` : ouvre les LinkedIn entreprise + employés un par un dans Chrome et track `linkedin_connected` / `linkedin_first_message` dans le JSON.
- **[`action_plan.md`](./action_plan.md)** — plan / architecture plus large.

Les scripts correspondants sont sous **`scripts/scrape_event_agencies/`** et
**`scripts/open_agencies_linkedin/`**.
