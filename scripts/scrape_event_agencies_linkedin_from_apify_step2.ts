/**
 * scrape_event_agencies_linkedin_from_apify_step2.ts
 *
 * EXAMPLES (run from the `automation/` directory — same cwd as `yarn`):
 *   yarn scrape:event-agencies:step2
 *   yarn scrape:event-agencies:step2 --force --limit=20
 *   yarn scrape:event-agencies:step2 --input=./output/scrape_event_agencies_fr_paris_debug.json
 *
 * STEP 2 — Apify Google search for LinkedIn company URLs.
 * Rewrites **canonical** pipeline files (same as step 1):
 *   scrape_event_agencies_<country>_<citySlug>_<mode>.json
 *   scrape_event_agencies_<country>_<mode>.csv
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
import { agencyLabelForSearch } from '../src/utils/company_name.js';
import { nameMatchScore } from '../src/utils/fuzzy_match.js';
import {
  OUTPUT_DIR,
  findLatestJsonOutput,
  inferCountryAndModeFromFilename,
  loadAgenciesFromJson,
  loadLatestStep0PartitionMerged,
  mergeAgenciesByPlaceIdPreferOverlay,
  writeCanonicalEventAgenciesOutputs,
} from '../src/utils/output.js';

const APIFY_ACTOR_ID = 'apify/google-search-scraper';
const STEP1_OUTPUT_PREFIX = 'scrape_event_agencies_with_website_data';
const OUTPUT_PREFIX = 'scrape_event_agencies_with_linkedin_search';
const DEFAULT_THRESHOLD = 0.4;
const RESULTS_PER_QUERY = 5;

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

function buildQueryFor(agency: Agency, variants: string[]): string {
  const quoted = agencyLabelForSearch(agency, variants).replace(/"/g, '');
  const safeCity = agency.city || '';
  return `site:linkedin.com/company "${quoted}" ${safeCity}`.trim();
}

function normalizeLinkedinCompanyUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (!u.hostname.endsWith('linkedin.com')) return null;
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const [section, slug] = segments;
    if (!['company', 'school'].includes(section)) return null;
    if (!slug) return null;
    return `https://www.linkedin.com/${section}/${slug}/`;
  } catch {
    return null;
  }
}

interface BestMatch {
  url: string;
  score: number;
}

function pickBestMatch(
  agency: Agency,
  results: OrganicResult[],
  threshold: number,
  variants: string[],
): BestMatch | null {
  const label = agencyLabelForSearch(agency, variants);
  let best: BestMatch | null = null;
  for (const r of results) {
    if (!r.url || !r.title) continue;
    const normalizedUrl = normalizeLinkedinCompanyUrl(r.url);
    if (!normalizedUrl) continue;
    const score = nameMatchScore(label, r.title);
    if (!best || score > best.score) {
      best = { url: normalizedUrl, score };
    }
  }
  if (!best) return null;
  if (best.score < threshold) return null;
  return best;
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
  if (agency.linkedin_company_url) return false;
  if (force) return true;
  return agency.linkedin_source == null;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  const force = getBoolArg(args, 'force');
  const limit = getIntArg(args, 'limit');
  const inputOverride = getStringArg(args, 'input');
  const outputOverride = getStringArg(args, 'output');
  const thresholdRaw = getStringArg(args, 'threshold');
  const threshold = thresholdRaw !== undefined ? Number(thresholdRaw) : DEFAULT_THRESHOLD;
  if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`Invalid --threshold value: "${thresholdRaw}" (must be in [0,1])`);
  }

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
        const legacy = findLatestJsonOutput([STEP1_OUTPUT_PREFIX, OUTPUT_PREFIX], {
          country: merged.country,
          outputDir,
        });
        if (legacy) {
          allAgencies = mergeAgenciesByPlaceIdPreferOverlay(
            allAgencies,
            loadAgenciesFromJson(legacy),
          );
          console.log(`[input] Overlay legacy file ${legacy}`);
        }
      }
    } else {
      const fallback = findLatestJsonOutput([STEP1_OUTPUT_PREFIX, OUTPUT_PREFIX], {
        outputDir,
      });
      if (!fallback) {
        throw new Error(
          `No input found. Pass --input=<path> or run step 0 / step 1 first.`,
        );
      }
      inputPath = fallback;
      allAgencies = loadAgenciesFromJson(fallback);
      console.log(`[input] Loading agencies from ${inputPath}`);
    }
  }

  console.log(`[input] Loaded ${allAgencies.length} total agencies.`);

  let pending = allAgencies.filter((a) => shouldProcess(a, force));
  const skipped = allAgencies.length - pending.length;
  if (skipped > 0) {
    console.log(
      `[skip] ${skipped} agency(ies) already resolved or already attempted (use --force to retry "not_found").`,
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
    const queries = pending.map((a) => buildQueryFor(a, allVariants));

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

    const updatesByPlaceId = new Map<
      string,
      { url: string | null; score: number | null }
    >();

    pending.forEach((agency, i) => {
      const query = queries[i];
      const results = resultsByQuery.get(query) ?? [];
      const best = pickBestMatch(agency, results, threshold, allVariants);
      const idx = `${i + 1}/${pending.length}`;
      if (best) {
        console.log(
          `[${idx}] ✓ ${agency.name} -> ${best.url} (score=${best.score.toFixed(2)})`,
        );
        updatesByPlaceId.set(agency.place_id, { url: best.url, score: best.score });
      } else {
        console.log(
          `[${idx}] · ${agency.name} -> no match (${results.length} candidate(s))`,
        );
        updatesByPlaceId.set(agency.place_id, { url: null, score: null });
      }
    });

    enriched = allAgencies.map((agency) => {
      const update = updatesByPlaceId.get(agency.place_id);
      if (!update) {
        return {
          ...agency,
          processed_step: effectiveProcessedStep(agency),
        };
      }
      if (update.url) {
        return {
          ...agency,
          processed_step: 2,
          linkedin_company_url: update.url,
          linkedin_source: 'apify_google_search',
          linkedin_match_score: update.score,
        };
      }
      return {
        ...agency,
        processed_step: 2,
        linkedin_source: 'not_found',
        linkedin_match_score: null,
      };
    });
  }

  const total = enriched.length;
  const withLinkedin = enriched.filter((a) => a.linkedin_company_url).length;
  const fromWebsite = enriched.filter((a) => a.linkedin_source === 'website').length;
  const fromApify = enriched.filter((a) => a.linkedin_source === 'apify_google_search').length;
  const notFound = enriched.filter((a) => a.linkedin_source === 'not_found').length;
  console.log(`[stats] LinkedIn total: ${withLinkedin}/${total} (${pct(withLinkedin, total)})`);
  console.log(`[stats]   from website : ${fromWebsite}`);
  console.log(`[stats]   from apify   : ${fromApify}`);
  console.log(`[stats]   not_found    : ${notFound}`);

  const inferred = inferCountryAndModeFromFilename(inputPath);
  const country =
    inferred.country ??
    (enriched[0]?.country_code ?? 'fr').toLowerCase().slice(0, 2);
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

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

main().catch((err) => {
  console.error('[error]', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
