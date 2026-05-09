/**
 * scrape_event_agencies_step0.ts
 *
 * EXAMPLES (run from the `automation/` directory — same cwd as `yarn`):
 *   yarn scrape:event-agencies:step0 --country=fr
 *   yarn scrape:event-agencies:step0 --country=fr --prod
 *   yarn scrape:event-agencies:step0:prod --country=fr
 *   yarn scrape:event-agencies:step0 --country=fr --refresh-all
 *
 * STEP 0 of the event-agencies pipeline.
 *
 * Scrape event agencies from Google Maps via Apify (actor: compass/google-maps-extractor),
 * then rewrite **canonical files** (no timestamps):
 *   scrape_event_agencies_<country>_<citySlug>_<mode>.json  — one JSON per city
 *   scrape_event_agencies_<country>_<mode>.csv            — global CSV (all cities)
 *
 * --------------------------------------------------------------------------
 * COST OPTIMIZATIONS ON RE-RUNS
 * --------------------------------------------------------------------------
 *  - Loads existing canonical JSONs + legacy timestamped files + latest step 1/2
 *    monolithic JSON (migration) → merge by place_id.
 *  - **Skips entire cities** that already have a canonical per-city JSON (unless
 *    `--refresh-all`). Legacy monolithic JSON: skip city if every planned query exists.
 *  - Canonical files are **rewritten** after each successful Apify city run (and once
 *    after the initial merge to normalize / migrate filenames).
 *
 * --------------------------------------------------------------------------
 * PARAMETERS
 * --------------------------------------------------------------------------
 *   --country=<code>  (required)  Country code (lowercase, e.g. "fr", "en").
 *   --prod            (optional)  All cities × all variants.
 *   --refresh-all     (optional)  Re-run Apify for every city.
 *   --max=<number>    (optional)  Max results per search (default 10 debug / 50 prod).
 *   --output=<dir>    (optional)  Output directory (default: automation/output).
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ApifyClient } from 'apify-client';

import citiesJson from '../src/constants/cities.json' with { type: 'json' };
import variantsJson from '../src/constants/event_agencies_variants.json' with { type: 'json' };
import { type Agency, effectiveProcessedStep } from '../src/types/agency.js';
import {
  getBoolArg,
  getIntArg,
  getStringArg,
  parseCliArgs,
} from '../src/utils/cli.js';
import {
  OUTPUT_DIR,
  collectStep0JsonPathsForCountryMerge,
  findLatestJsonOutput,
  hasDedicatedStep0JsonForCity,
  loadAgenciesFromJson,
  slugifyCityForFilename,
  writeCanonicalEventAgenciesOutputs,
} from '../src/utils/output.js';

const APIFY_ACTOR_ID = 'compass/google-maps-extractor';
const STEP1_OUTPUT_PREFIX = 'scrape_event_agencies_with_website_data';
const STEP2_OUTPUT_PREFIX = 'scrape_event_agencies_with_linkedin_search';
const DEBUG_MAX_RESULTS = 10;
const PROD_MAX_RESULTS = 50;

interface CitiesByCountry {
  [country: string]: string[];
}
interface VariantsByCountry {
  [country: string]: string[];
}

interface ApifyPlace {
  title?: string;
  categoryName?: string;
  categories?: string[];
  address?: string;
  city?: string;
  postalCode?: string;
  countryCode?: string;
  website?: string;
  phone?: string;
  phoneUnformatted?: string;
  url?: string;
  placeId?: string;
  searchString?: string;
}

function loadCitiesAndVariants(country: string): {
  cities: string[];
  variants: string[];
} {
  const cities = (citiesJson as CitiesByCountry)[country];
  const variants = (variantsJson as VariantsByCountry)[country];

  if (!cities || cities.length === 0) {
    throw new Error(
      `No cities found for country "${country}" in src/constants/cities.json`,
    );
  }
  if (!variants || variants.length === 0) {
    throw new Error(
      `No variants found for country "${country}" in src/constants/event_agencies_variants.json`,
    );
  }
  return { cities, variants };
}

function buildSearchQueriesForCity(city: string, variants: string[]): string[] {
  return variants.map((variant) => `${variant} ${city}`);
}

function hasLegacyMonolithicStep0Json(outputDir: string, country: string, mode: string): boolean {
  if (!fs.existsSync(outputDir)) return false;
  const ts = String.raw`\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}`;
  const re = new RegExp(`^scrape_event_agencies_${country}_${mode}_(${ts})\\.json$`);
  return fs.readdirSync(outputDir).some((n) => re.test(n));
}

function cityQueriesSatisfied(
  city: string,
  variants: string[],
  knownQueries: Set<string>,
): boolean {
  return variants.every((v) => knownQueries.has(`${v} ${city}`));
}

async function runApifyGoogleMapsExtractor(params: {
  client: ApifyClient;
  searchQueries: string[];
  countryCode: string;
  language: string;
  maxResultsPerSearch: number;
}): Promise<ApifyPlace[]> {
  const { client, searchQueries, countryCode, language, maxResultsPerSearch } = params;

  const input = {
    searchStringsArray: searchQueries,
    maxCrawledPlacesPerSearch: maxResultsPerSearch,
    language,
    countryCode,
    skipClosedPlaces: true,
    scrapePlaceDetailPage: false,
    scrapeReviewsPersonalData: false,
  };

  console.log(
    `[apify] Starting actor "${APIFY_ACTOR_ID}" with ${searchQueries.length} search(es), max ${maxResultsPerSearch}/search...`,
  );

  const run = await client.actor(APIFY_ACTOR_ID).call(input);

  console.log(
    `[apify] Run finished (id=${run.id}, status=${run.status}). Fetching dataset items...`,
  );

  const { items } = await client.dataset<ApifyPlace>(run.defaultDatasetId).listItems();

  console.log(`[apify] Got ${items.length} item(s) from dataset.`);
  return items;
}

function placeToAgency(place: ApifyPlace, fallbackQuery: string): Agency {
  return {
    processed_step: 0,
    search_query: place.searchString ?? fallbackQuery,
    name: place.title ?? '',
    category: place.categoryName ?? (place.categories ?? []).join(' | '),
    address: place.address ?? '',
    city: place.city ?? '',
    postal_code: place.postalCode ?? '',
    country_code: place.countryCode ?? '',
    website: place.website ?? '',
    phone: place.phone ?? place.phoneUnformatted ?? '',
    google_maps_url: place.url ?? '',
    place_id: place.placeId ?? '',
  };
}

function mergeAgenciesIntoMap(map: Map<string, Agency>, rows: Agency[]): void {
  for (const agency of rows) {
    if (agency.place_id) map.set(agency.place_id, agency);
  }
}

function shouldSkipCity(params: {
  refreshAll: boolean;
  outputDir: string;
  country: string;
  mode: 'debug' | 'prod';
  city: string;
  citySlug: string;
  variants: string[];
  knownQueries: Set<string>;
}): boolean {
  const { refreshAll, outputDir, country, mode, city, citySlug, variants, knownQueries } =
    params;
  if (refreshAll) return false;
  if (hasDedicatedStep0JsonForCity({ outputDir, country, mode, citySlug })) {
    return true;
  }
  if (
    hasLegacyMonolithicStep0Json(outputDir, country, mode) &&
    cityQueriesSatisfied(city, variants, knownQueries)
  ) {
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  const country = getStringArg(args, 'country')?.toLowerCase();
  if (!country) {
    throw new Error(
      'Missing required parameter --country=<code>. Example: --country=fr',
    );
  }
  const isProd = getBoolArg(args, 'prod');
  const refreshAll = getBoolArg(args, 'refresh-all');
  const maxOverride = getIntArg(args, 'max');
  const outputOverride = getStringArg(args, 'output');

  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) {
    throw new Error(
      'Missing APIFY_TOKEN env var. Copy .env.example to .env and fill it in.',
    );
  }

  const { cities: allCities, variants: allVariants } = loadCitiesAndVariants(country);

  let cities: string[];
  let variants: string[];
  let maxResults: number;

  if (isProd) {
    cities = allCities;
    variants = allVariants;
    maxResults = maxOverride ?? PROD_MAX_RESULTS;
    console.log(
      `[mode] PROD - country=${country}, cities=${cities.length}, variants=${variants.length}, max/search=${maxResults}`,
    );
  } else {
    const debugCity =
      allCities.find((c) => c.toLowerCase() === 'paris') ?? allCities[0];
    cities = [debugCity];
    variants = [allVariants[0]];
    maxResults = maxOverride ?? DEBUG_MAX_RESULTS;
    console.log(
      `[mode] DEBUG - country=${country}, city="${cities[0]}", variant="${variants[0]}", max/search=${maxResults}`,
    );
    console.log('[mode] Pass --prod to run on every city x variant.');
  }

  const mode: 'debug' | 'prod' = isProd ? 'prod' : 'debug';
  const outputDir = outputOverride ? path.resolve(process.cwd(), outputOverride) : OUTPUT_DIR;
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const existingByPlaceId = new Map<string, Agency>();
  const knownQueries = new Set<string>();

  const step0Paths = collectStep0JsonPathsForCountryMerge({
    outputDir,
    country,
    mode,
  });
  for (const p of step0Paths) {
    console.log(`[merge] Loading step0 snapshot ${p}`);
    mergeAgenciesIntoMap(existingByPlaceId, loadAgenciesFromJson(p));
  }
  for (const a of existingByPlaceId.values()) {
    if (a.search_query) knownQueries.add(a.search_query);
  }

  const enrichedPath = findLatestJsonOutput(
    [STEP1_OUTPUT_PREFIX, STEP2_OUTPUT_PREFIX],
    { country, outputDir },
  );
  if (enrichedPath) {
    console.log(`[merge] Loading enrichments from ${enrichedPath}`);
    const enrichedRows = loadAgenciesFromJson(enrichedPath);
    mergeAgenciesIntoMap(existingByPlaceId, enrichedRows);
    for (const a of enrichedRows) {
      if (a.search_query) knownQueries.add(a.search_query);
    }
  }

  if (step0Paths.length === 0 && !enrichedPath) {
    console.log('[merge] No previous step0 / step1 / step2 output for this country, starting fresh.');
  } else {
    console.log(
      `[merge] Loaded ${existingByPlaceId.size} agencies (${step0Paths.length} step0 path(s)).`,
    );
  }

  const flushOutputs = async () => {
    const allAgencies = Array.from(existingByPlaceId.values());
    const { cityPaths, globalCsvPath } = await writeCanonicalEventAgenciesOutputs({
      outputDir,
      country,
      mode,
      cities: allCities,
      variants: allVariants,
      allAgencies,
    });
    console.log(`[csv]  Global -> ${globalCsvPath} (${allAgencies.length} row(s))`);
    if (cityPaths.length > 0) {
      console.log(`[json] Per-city (${cityPaths.length}):`);
      cityPaths.forEach((p) => console.log(`       ${p}`));
    }
  };

  await flushOutputs();

  const citiesToScrape: string[] = [];
  for (const city of cities) {
    const citySlug = slugifyCityForFilename(city);
    if (shouldSkipCity({ refreshAll, outputDir, country, mode, city, citySlug, variants, knownQueries })) {
      console.log(`[skip-city] "${city}" (${citySlug}) — already has data (pass --refresh-all to re-run).`);
      continue;
    }
    citiesToScrape.push(city);
  }

  if (citiesToScrape.length === 0) {
    console.log('[done] Every planned city is already covered; no Apify runs.');
    return;
  }

  console.log(`[cities] Will call Apify for ${citiesToScrape.length}/${cities.length} city(ies).`);

  const client = new ApifyClient({ token: apifyToken });

  for (const city of citiesToScrape) {
    const citySlug = slugifyCityForFilename(city);
    const queries = buildSearchQueriesForCity(city, variants);
    console.log(`[city] ---- ${city} (${citySlug}) — ${queries.length} search(es) ----`);
    queries.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));

    const items = await runApifyGoogleMapsExtractor({
      client,
      searchQueries: queries,
      countryCode: country,
      language: country,
      maxResultsPerSearch: maxResults,
    });

    const fallbackQuery = queries[0] ?? '';
    let newCount = 0;
    let dedupCount = 0;
    for (const place of items) {
      if (!place.placeId) continue;
      if (existingByPlaceId.has(place.placeId)) {
        dedupCount++;
        continue;
      }
      existingByPlaceId.set(place.placeId, placeToAgency(place, fallbackQuery));
      newCount++;
    }
    for (const q of queries) knownQueries.add(q);

    console.log(
      `[dedup] ${city}: ${dedupCount} already known by place_id, ${newCount} new.`,
    );

    await flushOutputs();
  }

  const total = existingByPlaceId.size;
  const withStep1 = Array.from(existingByPlaceId.values()).filter(
    (a) => effectiveProcessedStep(a) >= 1,
  ).length;
  console.log(`[stats] Total agencies: ${total} (${withStep1} at step≥1 enrichments)`);
  console.log('[done]');
}

main().catch((err) => {
  console.error('[error]', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
