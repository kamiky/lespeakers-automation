# open_agencies_linkedin — manual LinkedIn outreach loop

Boucle interactive **post-pipeline** : on prend le JSON enrichi par
[`scrape_event_agencies` (steps 0→3)](../scrape_event_agencies/README.md) et,
pour chaque agence, on **ouvre le LinkedIn entreprise** puis chaque
**LinkedIn employé** dans Chrome — avec à chaque fois une confirmation
**YES/NO** pour pouvoir skipper.

Après chaque ouverture, le script demande :

- **Did you CONNECT on LinkedIn?** (Y/N)
- **Did you send the FIRST MESSAGE?** (Y/N)

…et écrit la réponse **dans le même fichier JSON** (in-place) afin de tracker
ton outreach et de pouvoir reprendre là où tu t'étais arrêté.

> Pas d'API LinkedIn, pas d'Apify. Le script ne fait qu'**ouvrir des URLs**
> et **enregistrer tes réponses** — toutes les actions LinkedIn (connect,
> message) restent manuelles.

---

## Exemples yarn (`automation/`)

```bash
# Cas standard : on bosse sur le fichier produit par step 3.
yarn outreach:linkedin --input=./output/scrape_event_agencies_fr_paris_debug.json

# Reprendre à partir de la 10e agence (1-indexed).
yarn outreach:linkedin --input=./output/scrape_event_agencies_fr_paris_debug.json --start=10

# Ne traiter que les 5 prochaines agences.
yarn outreach:linkedin --input=./output/scrape_event_agencies_fr_paris_debug.json --limit=5

# Re-poser la question pour les rows déjà traitées.
yarn outreach:linkedin --input=./output/scrape_event_agencies_fr_paris_debug.json --force

# Re-poser uniquement pour les rows que j'avais skipped.
yarn outreach:linkedin --input=./output/scrape_event_agencies_fr_paris_debug.json --include-skipped

# Ouvrir avec mon navigateur par défaut au lieu de Chrome.
yarn outreach:linkedin --input=./output/...json --use-default-browser

# Ne traiter que les pages entreprise (skipper tous les profils employés).
yarn outreach:linkedin --input=./output/...json --no-employees

# Ne traiter que les profils employés (skipper toutes les pages entreprise).
yarn outreach:linkedin --input=./output/...json --no-companies

# Écrire la sortie dans un autre fichier (laisse l'input intouché).
yarn outreach:linkedin --input=./output/...json --output=./output/...outreach.json
```

---

## Flux interactif

Pour chaque agence :

1. Le script affiche un encart avec :
   - `company_name` / `name`
   - ville, pays, site web, téléphone, contact emails
   - `linkedin_company_url`
   - éventuel statut précédent (`opened` / `skipped`, connected, 1st message)
2. Prompt **`Open COMPANY LinkedIn in browser? [Y/n/q]`**
   - `y` (défaut) : ouvre l'URL → enchaîne sur les 2 questions
   - `n` : marque l'agence comme `skipped` (sans ouvrir)
   - `q` : quitte le script (l'avancement est déjà persisté)
3. Si on a ouvert :
   - `Did you CONNECT on LinkedIn? [y/N/q]`
   - `Did you send the FIRST MESSAGE? [y/N/q]`
4. Puis itération sur `employees[]` :
   - encart par profil avec `name`, `role_bucket`, `job`, `metadata_description`, `linkedin_url`
   - prompt **`Open EMPLOYEE LinkedIn in browser? [Y/n/s/q]`**
     - `s` : skipper tous les employés restants de cette agence (passe à l'agence suivante)
     - sinon, mêmes 2 questions de suivi qu'au-dessus
5. **Persistance après CHAQUE réponse** : le JSON est réécrit immédiatement,
   donc un `Ctrl+C` n'efface jamais ton avancement.

> Tu peux quitter à tout moment en tapant `q` à n'importe quel prompt.

---

## Champs ajoutés au JSON

Sont ajoutés en **option** sur chaque agence ET sur chaque entrée
`employees[]` :

| Champ                       | Type                       | Quand                                          |
|-----------------------------|----------------------------|------------------------------------------------|
| `linkedin_outreach_status`  | `'opened'` \| `'skipped'`  | dès qu'on a répondu Y ou N au prompt d'ouverture |
| `linkedin_outreach_at`      | ISO timestamp              | mis à jour à chaque interaction               |
| `linkedin_connected`        | `boolean`                  | uniquement si `status === 'opened'`           |
| `linkedin_first_message`    | `boolean`                  | uniquement si `status === 'opened'`           |

Définition canonique : [`src/types/agency.ts`](../../src/types/agency.ts)
(`Agency` + `AgencyEmployee`).

Exemple, après un passage :

```json
{
  "company_name": "Le Rideau",
  "linkedin_company_url": "https://www.linkedin.com/company/lerideau/",
  "linkedin_outreach_status": "opened",
  "linkedin_outreach_at": "2026-05-10T13:24:01.234Z",
  "linkedin_connected": true,
  "linkedin_first_message": false,
  "employees": [
    {
      "linkedin_url": "https://www.linkedin.com/in/coralie-christin-032528354/",
      "name": "Coralie CHRISTIN",
      "linkedin_outreach_status": "opened",
      "linkedin_outreach_at": "2026-05-10T13:24:42.987Z",
      "linkedin_connected": true,
      "linkedin_first_message": true
    }
  ]
}
```

---

## Idempotence / reprise

Au redémarrage, le script **skippe par défaut** toute row déjà annotée
(`linkedin_outreach_status` défini), pour ne te faire perdre aucun temps :

| Statut existant | Comportement par défaut | `--include-skipped` | `--force` |
|------------------|-------------------------|---------------------|-----------|
| absent           | prompt                  | prompt              | prompt    |
| `skipped`        | skip silencieux         | re-prompt           | re-prompt |
| `opened`         | skip silencieux         | skip silencieux     | re-prompt |

---

## Paramètres CLI

| Paramètre                  | Description                                                                  |
|----------------------------|------------------------------------------------------------------------------|
| `--input=<path>` *(req)*   | JSON d'agences (généralement la sortie de step 3).                          |
| `--output=<path>`          | Écrit ailleurs au lieu de mettre à jour `--input` in-place.                 |
| `--start=<n>`              | Démarre à l'agence n° **n** (1-indexed).                                    |
| `--limit=<n>`              | Plafonne à **n** agences pour ce run.                                       |
| `--force`                  | Re-pose les questions même pour les rows déjà `opened` ou `skipped`.        |
| `--include-skipped`        | Re-pose les questions uniquement pour les rows déjà `skipped`.              |
| `--no-employees`           | Ne traite QUE la page LinkedIn entreprise.                                  |
| `--no-companies`           | Ne traite QUE les profils employés.                                         |
| `--use-default-browser`    | Utilise le navigateur par défaut au lieu de Google Chrome.                  |

**Aucun token requis** (pas d'API externe).

---

## Comment l'URL est ouverte

- **macOS** : `open -a "Google Chrome" <url>` (ou `open <url>` avec `--use-default-browser`)
- **Linux** : `google-chrome <url>` (ou `xdg-open <url>`)
- **Windows** : `start chrome <url>` (ou `start "" <url>`)

Le child process est **détaché** : ouvrir l'URL ne bloque pas le prompt
suivant. Si tu n'as pas Chrome installé, passe `--use-default-browser`.

---

## Tips

- Garde Chrome déjà ouvert avec ta session LinkedIn loggée → les URLs ouvrent
  un nouvel onglet propre.
- Réponds rapidement Y/N : la persistence est instantanée, donc même un crash
  (ou un `q`) ne perd rien.
- Si tu veux rebrasser un batch « connectés mais pas encore messagés », filtre
  ton JSON manuellement (jq) ou ouvre un follow-up script à part : on
  n'override jamais une `boolean` déjà à `true` sans `--force`.

---

## Step suivante

Ce script est complémentaire du pipeline d'enrichissement : il ne touche pas
aux étapes Apify / Google Maps. Si tu veux automatiser la suite (Dropcontact,
puis envoi de messages), voir [`action_plan.md`](../action_plan.md).
