/**
 * scrape_event_agencies_website_socials_and_contact_step1.ts
 *
 * EXAMPLES (run from the `automation/` directory — same cwd as `yarn`):
 *   yarn scrape:event-agencies:step1 --country=fr
 *   yarn scrape:event-agencies:step1 --country=fr --prod
 *   yarn scrape:event-agencies:step1 --country=fr --city=paris
 *   yarn scrape:event-agencies:step1 --country=fr --force --limit=20
 *   yarn scrape:event-agencies:step1 --debug-url=https://example.com/path
 *   yarn scrape:event-agencies:step1 --apify-when-block --limit=10
 *
 * STEP 1 — scrape agency websites for LinkedIn, emails, and social profiles (Facebook,
 * Instagram, X/Twitter, TikTok).
 * Rewrites canonical pipeline files under `output/<debug|prod>/`:
 *   scrape_event_agencies_<country>_<citySlug>.json
 *   scrape_event_agencies_<country>.csv
 *
 * --------------------------------------------------------------------------
 * PARAMETERS
 * --------------------------------------------------------------------------
 *   --country=<code>   (required except with --debug-url)  e.g. fr
 *   --city=<name>      (optional)  Only agencies for this city (case-insensitive).
 *   --prod             (optional)  Read/write `output/prod/` (default: `output/debug/`).
 *   --debug-url=<url>  (optional)  Scrape only this URL, verbose logs, JSON result to stdout;
 *                                  no pipeline files written.
 *   --input=<path>     (optional)  Single JSON instead of merged step0 inputs.
 *   --output=<dir>     (optional)  Output base directory (default: automation/output).
 *   --force            (optional)  Re-process every agency.
 *   --limit=<n>        (optional)  Cap agencies processed this run.
 *   --concurrency=<n>  (optional)  Parallel HTTP limit (default 5).
 *   --apify-when-block    (optional)  Fallback only: if direct HTTP gets no usable HTML (e.g. Cloudflare),
 *   --apify-when-blocked              fetch homepage via Apify Website Content Crawler (needs APIFY_TOKEN).
 *                                     Same effect; use either flag. Works for full pipeline runs and --debug-url.
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';

import citiesJson from '../../src/constants/cities.json' with { type: 'json' };
import variantsJson from '../../src/constants/event_agencies_variants.json' with { type: 'json' };
import { type Agency, effectiveProcessedStep } from '../../src/types/agency.js';
import {
  getBoolArg,
  getIntArg,
  getStringArg,
  parseCliArgs,
} from '../../src/utils/cli.js';
import { withConcurrency } from '../../src/utils/concurrency.js';
import {
  OUTPUT_DIR,
  buildSearchQueryToCitySlugMap,
  findLatestJsonOutput,
  getModeOutputDir,
  loadAgenciesFromJson,
  loadStep0PartitionMergedForCountry,
  mergeAgenciesByPlaceIdPreferOverlay,
  resolveCityFromCliArg,
  slugifyCityForFilename,
  writeCanonicalEventAgenciesOutputs,
} from '../../src/utils/output.js';
import { scrapeWebsiteForSocialsAndContact } from '../../src/utils/website_scraper.js';

const STEP0_OUTPUT_PREFIX = 'scrape_event_agencies';
const OUTPUT_PREFIX = 'scrape_event_agencies_with_website_data';
const STEP2_OUTPUT_PREFIX = 'scrape_event_agencies_with_linkedin_search';
const STEP3_OUTPUT_PREFIX = 'scrape_event_agencies_with_employees';
const DEFAULT_CONCURRENCY = 5;

function getApifyWhenBlockedFlag(args: ReturnType<typeof parseCliArgs>): boolean {
  return getBoolArg(args, 'apify-when-block') || getBoolArg(args, 'apify-when-blocked');
}

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

function applyScrapeToAgency(agency: Agency, result: Awaited<ReturnType<typeof scrapeWebsiteForSocialsAndContact>>): Agency {
  return {
    ...agency,
    processed_step: Math.max(1, effectiveProcessedStep(agency)),
    linkedin_company_url: result.linkedinCompanyUrl,
    linkedin_source: result.linkedinCompanyUrl ? 'website' : null,
    contact_emails: result.emails,
    website_facebook_url: result.socials.facebook,
    website_instagram_url: result.socials.instagram,
    website_twitter_url: result.socials.twitter,
    website_tiktok_url: result.socials.tiktok,
    website_scrape_status: result.status,
    website_scrape_error: result.error,
    website_scraped_url: result.scrapedUrl,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  const debugUrl = getStringArg(args, 'debug-url');
  if (debugUrl) {
    const resolved = debugUrl.startsWith('http') ? debugUrl : `https://${debugUrl}`;
    const apifyWhenBlocked = getApifyWhenBlockedFlag(args);
    console.log('[debug-url] Single-URL mode (no pipeline writes)\n');
    const result = await scrapeWebsiteForSocialsAndContact(resolved, {
      debug: true,
      apifyWhenBlocked,
    });
    console.log('\n[debug-url] Result JSON:');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const country = getStringArg(args, 'country')?.toLowerCase();
  if (!country) {
    throw new Error('Missing required parameter --country=<code>. Example: --country=fr');
  }

  const force = getBoolArg(args, 'force');
  const apifyWhenBlocked = getApifyWhenBlockedFlag(args);
  const limit = getIntArg(args, 'limit');
  const concurrency = getIntArg(args, 'concurrency') ?? DEFAULT_CONCURRENCY;
  const inputOverride = getStringArg(args, 'input');
  const outputOverride = getStringArg(args, 'output');
  const cityArg = getStringArg(args, 'city');
  const isProd = getBoolArg(args, 'prod');
  const mode = isProd ? 'prod' : 'debug';

  const outputBaseDir = outputOverride ? path.resolve(process.cwd(), outputOverride) : OUTPUT_DIR;
  if (!fs.existsSync(outputBaseDir)) {
    fs.mkdirSync(outputBaseDir, { recursive: true });
  }
  const modeOutputDir = getModeOutputDir(outputBaseDir, mode);

  const { cities: allCities, variants: allVariants } = loadCitiesAndVariants(country);
  const queryToSlug = buildSearchQueryToCitySlugMap(allCities, allVariants);
  const citySlugFilter = cityArg
    ? slugifyCityForFilename(resolveCityFromCliArg(allCities, cityArg))
    : undefined;

  let inputPath: string;
  let allAgencies: Agency[];

  if (inputOverride) {
    inputPath = path.resolve(process.cwd(), inputOverride);
    console.log(`[input] Loading agencies from ${inputPath}`);
    allAgencies = loadAgenciesFromJson(inputPath);
  } else {
    const merged = loadStep0PartitionMergedForCountry({
      outputBaseDir,
      country,
      mode,
    });
    if (merged.agencies.length > 0) {
      allAgencies = merged.agencies;
      inputPath = merged.representativePath ?? merged.sourcePaths[0] ?? '';
      console.log(
        `[input] Merged step0 partition ${country}/${mode} from ${merged.sourcePaths.length} file(s) -> ${allAgencies.length} agencies.`,
      );
      merged.sourcePaths.forEach((p) => console.log(`       ${p}`));
      const enrichPath = findLatestJsonOutput(
        [OUTPUT_PREFIX, STEP2_OUTPUT_PREFIX, STEP3_OUTPUT_PREFIX],
        { country, outputDir: outputBaseDir },
      );
      if (enrichPath) {
        const overlay = loadAgenciesFromJson(enrichPath);
        allAgencies = mergeAgenciesByPlaceIdPreferOverlay(allAgencies, overlay);
        const step0Mtime = inputPath && fs.existsSync(inputPath) ? fs.statSync(inputPath).mtimeMs : 0;
        if (fs.statSync(enrichPath).mtimeMs > step0Mtime) {
          inputPath = enrichPath;
        }
        console.log(`[input] Overlay legacy enrichments from ${enrichPath}`);
      }
    } else {
      const fallback = findLatestJsonOutput([STEP0_OUTPUT_PREFIX, OUTPUT_PREFIX], {
        country,
        outputDir: outputBaseDir,
      });
      if (!fallback) {
        throw new Error(
          `No input found for ${country}/${mode}. Pass --input=<path> or run scrape_event_agencies_step0 first.`,
        );
      }
      inputPath = fallback;
      console.log(`[input] Loading agencies from ${inputPath}`);
      allAgencies = loadAgenciesFromJson(inputPath);
    }
  }

  console.log(`[input] Loaded ${allAgencies.length} agencies.`);

  let pending = allAgencies.filter((a) => force || effectiveProcessedStep(a) < 1);
  if (citySlugFilter) {
    pending = pending.filter(
      (a) => queryToSlug.get(a.search_query?.trim() ?? '') === citySlugFilter,
    );
    console.log(
      `[city] Restricting work to slug "${citySlugFilter}" (${pending.length} pending of ${allAgencies.length} total).`,
    );
  }
  const skipped = allAgencies.length - pending.length;
  if (skipped > 0 && !citySlugFilter) {
    console.log(
      `[skip] ${skipped} agency(ies) already processed (use --force to re-run all).`,
    );
  }

  if (limit !== undefined && pending.length > limit) {
    pending = pending.slice(0, limit);
    console.log(`[limit] Hard cap to first ${pending.length} agencies for this run.`);
  }

  let finalAgencies: Agency[];

  if (pending.length === 0) {
    console.log('[done] Nothing to scrape; rewriting canonical outputs from current state.');
    finalAgencies = allAgencies.map((a) => ({
      ...a,
      processed_step: effectiveProcessedStep(a),
    }));
  } else {
    if (apifyWhenBlocked) {
      console.log(
        `[scrape] Apify fallback enabled: after failed HTTP, homepage will be fetched via Website Content Crawler when APIFY_TOKEN is set.`,
      );
    }
    console.log(`[scrape] Processing ${pending.length} agency(ies) with concurrency=${concurrency}...`);

    const enrichedPending = await withConcurrency(pending, concurrency, async (agency, i) => {
      const idx = `${i + 1}/${pending.length}`;
      if (!agency.website) {
        console.log(`[${idx}] ${agency.name} -> no website, skipping`);
        return {
          ...agency,
          processed_step: Math.max(1, effectiveProcessedStep(agency)),
          linkedin_company_url: null,
          linkedin_source: null,
          contact_emails: [],
          website_facebook_url: null,
          website_instagram_url: null,
          website_twitter_url: null,
          website_tiktok_url: null,
          website_scrape_status: 'no_website' as const,
          website_scrape_error: null,
          website_scraped_url: null,
        };
      }

      const result = await scrapeWebsiteForSocialsAndContact(agency.website, {
        apifyWhenBlocked,
      });
      const tag = result.linkedinCompanyUrl ? '✓' : '·';
      const mailTag = result.emails.length > 0 ? `mail:${result.emails.length}` : 'mail:0';
      const socN =
        [result.socials.facebook, result.socials.instagram, result.socials.twitter, result.socials.tiktok].filter(
          Boolean,
        ).length;
      console.log(
        `[${idx}] ${tag} ${agency.name} | linkedin=${result.linkedinCompanyUrl ?? '-'} | ${mailTag} | socials:${socN} | status=${result.status}`,
      );

      return applyScrapeToAgency(agency, result);
    });

    const enrichedById = new Map<string, Agency>();
    for (const a of enrichedPending) enrichedById.set(a.place_id, a);
    finalAgencies = allAgencies.map((a) => {
      const updated = enrichedById.get(a.place_id) ?? a;
      return {
        ...updated,
        processed_step: effectiveProcessedStep(updated),
      };
    });
  }

  const total = finalAgencies.length;
  const withLinkedin = finalAgencies.filter((a) => a.linkedin_company_url).length;
  const withEmails = finalAgencies.filter((a) => (a.contact_emails ?? []).length > 0).length;
  const withSocials = finalAgencies.filter(
    (a) =>
      a.website_facebook_url ||
      a.website_instagram_url ||
      a.website_twitter_url ||
      a.website_tiktok_url,
  ).length;
  const stillUnprocessed = finalAgencies.filter((a) => effectiveProcessedStep(a) < 1).length;
  console.log(
    `[stats] LinkedIn found: ${withLinkedin}/${total} (${pct(withLinkedin, total)})`,
  );
  console.log(
    `[stats] Emails found:   ${withEmails}/${total} (${pct(withEmails, total)})`,
  );
  console.log(`[stats] Social URLs:   ${withSocials}/${total}`);
  if (stillUnprocessed > 0) {
    console.log(`[stats] Still unprocessed: ${stillUnprocessed} (likely --limit'd; re-run to continue).`);
  }

  const { cityPaths, globalCsvPath } = await writeCanonicalEventAgenciesOutputs({
    modeOutputDir,
    country,
    cities: allCities,
    variants: allVariants,
    allAgencies: finalAgencies,
    writeCitySlugsOnly: citySlugFilter ? [citySlugFilter] : undefined,
  });

  console.log(`[csv]  ${globalCsvPath} (${finalAgencies.length} row(s))`);
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
