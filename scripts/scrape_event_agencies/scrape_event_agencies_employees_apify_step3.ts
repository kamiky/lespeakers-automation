/**
 * scrape_event_agencies_employees_apify_step3.ts
 *
 * EXAMPLES (from `automation/`):
 *   yarn scrape:event-agencies:step3
 *   yarn scrape:event-agencies:step3 --force --limit=5
 *   yarn scrape:event-agencies:step3 --input=./output/scrape_event_agencies_fr_paris_debug.json
 *
 * STEP 3 — Apify Google search for LinkedIn **people** (`/in/`) per agency.
 * Writes `employees[]` with { linkedin_url, contact_email, name, job, role_bucket,
 * metadata_title, metadata_description };
 * `contact_email` stays null until Step 4 (Dropcontact).
 *
 * Rewrites canonical pipeline JSON + CSV (same as steps 1–2).
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ApifyClient } from 'apify-client';

import citiesJson from '../../src/constants/cities.json' with { type: 'json' };
import variantsJson from '../../src/constants/event_agencies_variants.json' with { type: 'json' };
import { type Agency, effectiveProcessedStep } from '../../src/types/agency.js';
import {
  getBoolArg,
  getIntArg,
  getStringArg,
  parseCliArgs,
} from '../../src/utils/cli.js';
import { agencyLabelForSearch } from '../../src/utils/company_name.js';
import { organicResultsToEmployees } from '../../src/utils/linkedin_employees_google.js';
import {
  OUTPUT_DIR,
  findLatestJsonOutput,
  inferCountryAndModeFromFilename,
  loadAgenciesFromJson,
  loadLatestStep0PartitionMerged,
  mergeAgenciesByPlaceIdPreferOverlay,
  writeCanonicalEventAgenciesOutputs,
} from '../../src/utils/output.js';

const APIFY_ACTOR_ID = 'apify/google-search-scraper';
const STEP1_OUTPUT_PREFIX = 'scrape_event_agencies_with_website_data';
const STEP2_OUTPUT_PREFIX = 'scrape_event_agencies_with_linkedin_search';
const STEP3_OUTPUT_PREFIX = 'scrape_event_agencies_with_employees';
const RESULTS_PER_QUERY = 10;
const DEFAULT_MAX_EMPLOYEES = 8;

interface CitiesByCountry {
  [country: string]: string[];
}
interface VariantsByCountry {
  [country: string]: string[];
}

function loadCitiesAndVariants(country: string): { cities: string[]; variants: string[] } {
  const cities = (citiesJson as CitiesByCountry)[country];
  const variants = (variantsJson as VariantsByCountry)[country];
  if (!cities?.length) {
    throw new Error(`No cities for country "${country}" in cities.json`);
  }
  if (!variants?.length) {
    throw new Error(`No variants for country "${country}" in event_agencies_variants.json`);
  }
  return { cities, variants };
}

interface OrganicResult {
  url?: string;
  title?: string;
  description?: string;
}

interface SearchItem {
  searchQuery?: { term?: string };
  organicResults?: OrganicResult[];
}

/** Single broad query; filter keeps rows whose SERP title contains the company label (accent-folded). */
function buildEmployeeQueryFor(agency: Agency, variants: string[]): string {
  const label =
    agencyLabelForSearch(agency, variants).replace(/"/g, '').trim() ||
    agency.name.replace(/"/g, '').trim();
  if (!label) {
    throw new Error(`Empty company label and name for place_id=${agency.place_id}`);
  }
  return `site:linkedin.com/in ${label}`;
}

async function runApifyGoogleSearch(params: {
  client: ApifyClient;
  queries: string[];
  countryCode: string;
}): Promise<SearchItem[]> {
  const { client, queries, countryCode } = params;

  const input = {
    queries: queries.join('\n'),
    resultsPerPage: RESULTS_PER_QUERY,
    maxPagesPerQuery: 1,
    countryCode,
    languageCode: countryCode,
    saveHtml: false,
    mobileResults: false,
    csvFriendlyOutput: false,
  };

  console.log(
    `[apify] Starting actor "${APIFY_ACTOR_ID}" with ${queries.length} query(ies), ${RESULTS_PER_QUERY} result(s)/query...`,
  );

  const run = await client.actor(APIFY_ACTOR_ID).call(input);
  console.log(
    `[apify] Run finished (id=${run.id}, status=${run.status}). Fetching dataset items...`,
  );

  const { items } = await client.dataset<SearchItem>(run.defaultDatasetId).listItems();
  console.log(`[apify] Got ${items.length} dataset item(s).`);
  return items;
}

function shouldProcess(agency: Agency, force: boolean): boolean {
  if (force) return true;
  return effectiveProcessedStep(agency) < 3;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  const force = getBoolArg(args, 'force');
  const limit = getIntArg(args, 'limit');
  const maxEmployees = getIntArg(args, 'max-employees') ?? DEFAULT_MAX_EMPLOYEES;
  if (maxEmployees < 1 || maxEmployees > 50) {
    throw new Error(`--max-employees must be between 1 and 50 (got ${maxEmployees})`);
  }
  const inputOverride = getStringArg(args, 'input');
  const outputOverride = getStringArg(args, 'output');

  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) {
    throw new Error('Missing APIFY_TOKEN env var. Copy .env.example to .env and fill it in.');
  }

  const outputDir = outputOverride ? path.resolve(process.cwd(), outputOverride) : OUTPUT_DIR;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  let inputPath: string;
  let allAgencies: Agency[];

  if (inputOverride) {
    inputPath = path.resolve(process.cwd(), inputOverride);
    console.log(`[input] Loading agencies from ${inputPath}`);
    allAgencies = loadAgenciesFromJson(inputPath);
  } else {
    const merged = loadLatestStep0PartitionMerged({ outputDir });
    if (merged.agencies.length > 0) {
      allAgencies = merged.agencies;
      inputPath = merged.representativePath ?? merged.sourcePaths[0] ?? '';
      console.log(
        `[input] Merged canonical partition ${merged.country}/${merged.mode} (${merged.sourcePaths.length} file(s)) -> ${allAgencies.length} agencies.`,
      );
      merged.sourcePaths.forEach((p) => console.log(`       ${p}`));
      if (merged.country) {
        const legacy = findLatestJsonOutput(
          [STEP1_OUTPUT_PREFIX, STEP2_OUTPUT_PREFIX, STEP3_OUTPUT_PREFIX],
          { country: merged.country, outputDir },
        );
        if (legacy) {
          allAgencies = mergeAgenciesByPlaceIdPreferOverlay(allAgencies, loadAgenciesFromJson(legacy));
          console.log(`[input] Overlay legacy file ${legacy}`);
        }
      }
    } else {
      const fallback = findLatestJsonOutput(
        [STEP1_OUTPUT_PREFIX, STEP2_OUTPUT_PREFIX, STEP3_OUTPUT_PREFIX],
        { outputDir },
      );
      if (!fallback) {
        throw new Error(`No input found. Pass --input=<path> or run step 0–2 first.`);
      }
      inputPath = fallback;
      allAgencies = loadAgenciesFromJson(fallback);
      console.log(`[input] Loading agencies from ${inputPath}`);
    }
  }

  console.log(`[input] Loaded ${allAgencies.length} agencies.`);

  let pending = allAgencies.filter((a) => shouldProcess(a, force));
  const skipped = allAgencies.length - pending.length;
  if (skipped > 0) {
    console.log(
      `[skip] ${skipped} agency(ies) already at step ≥3 (use --force to re-run Apify employee search).`,
    );
  }

  if (limit !== undefined && pending.length > limit) {
    pending = pending.slice(0, limit);
    console.log(`[limit] Hard cap to first ${pending.length} for this run.`);
  }

  let enriched: Agency[];

  if (pending.length === 0) {
    console.log('[done] Nothing to call Apify for; rewriting canonical outputs.');
    enriched = allAgencies.map((a) => ({
      ...a,
      processed_step: effectiveProcessedStep(a),
    }));
  } else {
    const inferred = inferCountryAndModeFromFilename(inputPath);
    const country =
      inferred.country ?? (allAgencies[0]?.country_code ?? 'fr').toLowerCase().slice(0, 2);

    const { variants: allVariants } = loadCitiesAndVariants(country);
    const queries = pending.map((a) => buildEmployeeQueryFor(a, allVariants));

    const client = new ApifyClient({ token: apifyToken });
    const searchItems = await runApifyGoogleSearch({
      client,
      queries,
      countryCode: country,
    });

    const resultsByQuery = new Map<string, OrganicResult[]>();
    for (const item of searchItems) {
      const term = item.searchQuery?.term ?? '';
      if (!term) continue;
      resultsByQuery.set(term, item.organicResults ?? []);
    }

    const updatesByPlaceId = new Map<string, Agency['employees']>();

    pending.forEach((agency, i) => {
      const query = queries[i];
      const results = resultsByQuery.get(query) ?? [];
      const agencySearchLabel = agencyLabelForSearch(agency, allVariants);
      const employees = organicResultsToEmployees(results, maxEmployees, {
        agencySearchLabel,
      });
      const idx = `${i + 1}/${pending.length}`;
      console.log(
        `[${idx}] ${agency.name} -> ${employees.length} employee(s) (${results.length} organic row(s))`,
      );
      updatesByPlaceId.set(agency.place_id, employees);
    });

    enriched = allAgencies.map((agency) => {
      const em = updatesByPlaceId.get(agency.place_id);
      if (em === undefined) {
        return {
          ...agency,
          processed_step: effectiveProcessedStep(agency),
        };
      }
      return {
        ...agency,
        processed_step: 3,
        employees: em,
      };
    });
  }

  const total = enriched.length;
  const withAny = enriched.filter((a) => (a.employees?.length ?? 0) > 0).length;
  const headcount = enriched.reduce((s, a) => s + (a.employees?.length ?? 0), 0);
  console.log(`[stats] Agencies with ≥1 employee: ${withAny}/${total}`);
  console.log(`[stats] Total employee rows: ${headcount}`);

  const inferred = inferCountryAndModeFromFilename(inputPath);
  const country =
    inferred.country ?? (enriched[0]?.country_code ?? 'fr').toLowerCase().slice(0, 2);
  const mode = inferred.mode ?? 'debug';

  const { cities: allCities, variants: allVariants } = loadCitiesAndVariants(country);
  const { cityPaths, globalCsvPath } = await writeCanonicalEventAgenciesOutputs({
    outputDir,
    country,
    mode,
    cities: allCities,
    variants: allVariants,
    allAgencies: enriched,
  });

  console.log(`[csv]  ${globalCsvPath} (${enriched.length} row(s))`);
  cityPaths.forEach((p) => console.log(`[json] ${p}`));
  console.log('[done]');
}

main().catch((err) => {
  console.error('[error]', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
