# Plan — nettoyage des `employees` (post STEP 3)

Contexte : la [STEP 3](./scrape_event_agencies_employees_apify_step3.md) repose sur Google (`site:linkedin.com/in` + filtre titre/snippet). Ça laisse des **homonymes** et du **bruit** qu’on ne veut pas maintenir à la main pour des centaines d’agences.

Deux pistes complémentaires (non implémentées pour l’instant) :

---

## Option A — Filtrage par LLM (OpenAI ou équivalent)

**Idée** : après extraction des lignes `employees`, envoyer pour chaque candidat un court contexte et demander une décision structurée (`keep` / `reject` / `review`).

**Entrées utiles par ligne** : `company_name`, `website`, `linkedin_company_url`, titre + snippet Google utilisés (ou `name` / `job` enrichis), URL profil LinkedIn ; éventuellement `city` / `country_code` de l’agence.

**Sortie** : liste filtrée ou champ `employee_match_confidence` / `employee_match_reason` pour tri ultérieur.

**Optimisations** :
- Ne passer au modèle que les agences à « marque faible » (nom court, tokens génériques) ou les lignes au-dessus d’un seuil de risque.
- Batch JSON, modèle petit et bon marché, réponses strictement JSON.

**Limites** : coût et latence à l’échelle ; variabilité du modèle ; traitement des données personnelles (RGPD / politique OpenAI).

---

## Option B — Gate par domaine email (Dropcontact)

**Idée** : enrichir `contact_email` via Dropcontact ([STEP 4](./action_plan.md) prévue), puis **écarter** un employé si l’email trouvé n’est pas aligné avec le **domaine du site** de l’agence.

**Règle typique** :
- Extraire le domaine « registrable » de `website` (ex. `agence.fr`).
- Comparer au domaine de l’email personnel enrichi (ex. `prenom.nom@agence.fr` → OK ; `@gmail.com` ou `@autre-societe.com` → **exclude** ou flag `weak_match`).

**Cas limites** :
- Agences qui utilisent Gmail / Outlook pour les premiers contacts → faux négatifs si la règle est trop stricte.
- Holdings, SSO, sous-domaines multiples → prévoir allowlist ou correspondance sur **apex domain** / plusieurs domaines connus (`contact_emails` step 1 comme signal).

**Intérêt** : peu coûteux une fois Dropcontact en place, déterministe, bon signal « même organisation » quand le mail pro existe.

---

## Ordre suggéré (quand tu implémenteras)

1. **STEP 4** Dropcontact → remplir les emails là où c’est possible.  
2. **Gate domaine** (option B) sur les lignes enrichies ; décider quoi faire des lignes **sans** email (garder, LLM, ou exclure selon produit).  
3. **Pass LLM** (option A) en complément sur le résidu bruyant ou sur tout le fichier si budget OK.

---

## Références

- Pipeline employees : [STEP 3](./scrape_event_agencies_employees_apify_step3.md)  
- Vue d’ensemble : [action_plan.md](./action_plan.md)
