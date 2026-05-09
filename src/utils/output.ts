/**
 * Shared file-IO helpers for the automation pipeline.
 *
 * Event-agencies canonical files (no timestamps; scripts rewrite in place):
 *   scrape_event_agencies_<country>_<citySlug>_<mode>.json   — one JSON per city
 *   scrape_event_agencies_<country>_<mode>.csv              — one global CSV (all cities)
 *
 * Legacy timestamped step0 / step1 / step2 files may still be read for migration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createObjectCsvWriter } from 'csv-writer';

import { type Agency, effectiveProcessedStep } from '../types/agency.js';
import { deriveCompanyName } from './company_name.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '..', '..');
export const OUTPUT_DIR = path.join(ROOT_DIR, 'output');

export type Mode = 'debug' | 'prod';

export interface CsvHeaderEntry {
  id: string;
  title: string;
}

export function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

export function buildTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
}

/**
 * Returns the base path (no extension) for a new output file.
 */
export function buildOutputBase(params: {
  prefix: string;
  country: string;
  mode: Mode;
}): string {
  return path.join(
    OUTPUT_DIR,
    `${params.prefix}_${params.country}_${params.mode}_${buildTimestamp()}`,
  );
}

/**
 * Returns true if `filename` matches our `<prefix>_<country>_<mode>_<ts>.json`
 * naming convention for the given prefix and (optional) country.
 *
 * This is stricter than a plain `startsWith(prefix + '_')` because step
 * prefixes are sub-prefixes of each other (e.g. "scrape_event_agencies" is
 * a prefix of "scrape_event_agencies_with_website_data").
 */
function fileMatchesPrefix(
  filename: string,
  prefix: string,
  country?: string,
): boolean {
  const countryPart = country ? escapeRegex(country) : '[a-z]{2,3}';
  const re = new RegExp(`^${escapeRegex(prefix)}_${countryPart}_(debug|prod)_`);
  return re.test(filename);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the most recent JSON file in /output matching one of the given prefixes
 * (using our `<prefix>_<country>_<mode>_<ts>.json` naming convention).
 *
 * Useful for "find the latest step 0 OR step 1 output" so a re-run picks the
 * freshest data automatically.
 *
 * If `options.country` is provided, only files for that country are considered.
 */
export function findLatestJsonOutput(
  prefixOrPrefixes: string | string[],
  options?: { country?: string; outputDir?: string },
): string | null {
  const prefixes = Array.isArray(prefixOrPrefixes)
    ? prefixOrPrefixes
    : [prefixOrPrefixes];
  const dir = options?.outputDir ?? OUTPUT_DIR;
  if (!fs.existsSync(dir)) return null;
  const country = options?.country;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => prefixes.some((p) => fileMatchesPrefix(f, p, country)))
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

/** Timestamp segment in legacy step0 filenames. */
const STEP0_TS = String.raw`\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}`;

/** Canonical per-city JSON: `scrape_event_agencies_<country>_<citySlug>_<mode>.json` */
export function canonicalStep0CityJsonFilename(
  country: string,
  citySlug: string,
  mode: Mode,
): string {
  return `scrape_event_agencies_${country}_${citySlug}_${mode}.json`;
}

export function canonicalStep0GlobalCsvFilename(country: string, mode: Mode): string {
  return `scrape_event_agencies_${country}_${mode}.csv`;
}

export function getCanonicalStep0CityJsonPath(params: {
  outputDir: string;
  country: string;
  citySlug: string;
  mode: Mode;
}): string {
  return path.join(
    params.outputDir,
    canonicalStep0CityJsonFilename(params.country, params.citySlug, params.mode),
  );
}

export function getCanonicalStep0GlobalCsvPath(params: {
  outputDir: string;
  country: string;
  mode: Mode;
}): string {
  return path.join(params.outputDir, canonicalStep0GlobalCsvFilename(params.country, params.mode));
}

/**
 * Try to read country + mode from a filename (canonical city JSON, legacy timestamp JSON,
 * or other pipeline JSONs that end with `_<country>_<mode>_...`).
 */
export function inferCountryAndModeFromFilename(filePath: string): {
  country: string | null;
  mode: Mode | null;
} {
  const base = path.basename(filePath, '.json');
  const fixed = /^scrape_event_agencies_([a-z]{2,3})_([a-z0-9_-]+)_(debug|prod)$/;
  const mf = base.match(fixed);
  if (mf) return { country: mf[1], mode: mf[3] as Mode };

  const legacy = new RegExp(`_([a-z]{2,3})_(debug|prod)_(${STEP0_TS})(?:_[a-z0-9_-]+)?$`);
  const ml = base.match(legacy);
  if (ml) return { country: ml[1], mode: ml[2] as Mode };

  return { country: null, mode: null };
}

/** URL-safe slug from a config city label (used in step0 per-city JSON names). */
export function slugifyCityForFilename(city: string): string {
  const s = city
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return s.length > 0 ? s : 'city';
}

/**
 * All step0 JSON paths to merge for a country/mode: canonical per-city files,
 * plus legacy timestamped monolithic / per-city (newest per slug only).
 */
export function collectStep0JsonPathsForCountryMerge(params: {
  outputDir: string;
  country: string;
  mode: Mode;
}): string[] {
  const { outputDir, country, mode } = params;
  if (!fs.existsSync(outputDir)) return [];

  const out: string[] = [];
  const fixedRe = new RegExp(
    `^scrape_event_agencies_${escapeRegex(country)}_([a-z0-9_-]+)_${mode}\\.json$`,
  );
  for (const name of fs.readdirSync(outputDir)) {
    if (!name.endsWith('.json')) continue;
    if (fixedRe.test(name)) {
      out.push(path.join(outputDir, name));
    }
  }

  const legacyMonoRe = new RegExp(
    `^scrape_event_agencies_${escapeRegex(country)}_${mode}_(${STEP0_TS})\\.json$`,
  );
  const legacyCityRe = new RegExp(
    `^scrape_event_agencies_${escapeRegex(country)}_${mode}_(${STEP0_TS})_([a-z0-9_-]+)\\.json$`,
  );

  const legacyCityBySlug = new Map<string, { path: string; mtime: number }>();
  let legacyMonoBest: { path: string; mtime: number } | null = null;

  for (const name of fs.readdirSync(outputDir)) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(outputDir, name);
    const st = fs.statSync(full);
    const mc = name.match(legacyCityRe);
    if (mc) {
      const slug = mc[2];
      const cur = legacyCityBySlug.get(slug);
      if (!cur || st.mtimeMs > cur.mtime) {
        legacyCityBySlug.set(slug, { path: full, mtime: st.mtimeMs });
      }
      continue;
    }
    if (legacyMonoRe.test(name)) {
      if (!legacyMonoBest || st.mtimeMs > legacyMonoBest.mtime) {
        legacyMonoBest = { path: full, mtime: st.mtimeMs };
      }
    }
  }

  for (const x of legacyCityBySlug.values()) {
    out.push(x.path);
  }
  if (legacyMonoBest) out.push(legacyMonoBest.path);

  return out;
}

export function hasDedicatedStep0JsonForCity(params: {
  outputDir: string;
  country: string;
  mode: Mode;
  citySlug: string;
}): boolean {
  return fs.existsSync(
    getCanonicalStep0CityJsonPath({
      outputDir: params.outputDir,
      country: params.country,
      citySlug: params.citySlug,
      mode: params.mode,
    }),
  );
}

function parseStep0JsonPartitionKey(
  filename: string,
): { key: string; country: string; mode: Mode } | null {
  const fixed = /^scrape_event_agencies_([a-z]{2,3})_([a-z0-9_-]+)_(debug|prod)\.json$/;
  const mf = filename.match(fixed);
  if (mf) {
    return { key: `${mf[1]}/${mf[3]}`, country: mf[1], mode: mf[3] as Mode };
  }
  const legacy = new RegExp(
    `^scrape_event_agencies_([a-z]{2,3})_(debug|prod)_(${STEP0_TS})(?:_([a-z0-9_-]+))?\\.json$`,
  );
  const ml = filename.match(legacy);
  if (ml) {
    return { key: `${ml[1]}/${ml[2]}`, country: ml[1], mode: ml[2] as Mode };
  }
  return null;
}

/**
 * Discover (country, mode) groups from plain `scrape_event_agencies_*.json` (not `..._with_...`),
 * pick the group whose newest file is most recent, merge agencies.
 */
export function loadLatestStep0PartitionMerged(params?: {
  outputDir?: string;
}): {
  agencies: Agency[];
  sourcePaths: string[];
  representativePath: string | null;
  country: string | null;
  mode: Mode | null;
} {
  const outputDir = params?.outputDir ?? OUTPUT_DIR;
  if (!fs.existsSync(outputDir)) {
    return { agencies: [], sourcePaths: [], representativePath: null, country: null, mode: null };
  }

  const partitionFiles = new Map<string, { paths: string[]; maxMtime: number }>();

  for (const name of fs.readdirSync(outputDir)) {
    if (!name.endsWith('.json')) continue;
    if (!name.startsWith('scrape_event_agencies_')) continue;
    if (name.startsWith('scrape_event_agencies_with_')) continue;
    const parsed = parseStep0JsonPartitionKey(name);
    if (!parsed) continue;
    const full = path.join(outputDir, name);
    const mt = fs.statSync(full).mtimeMs;
    const g = partitionFiles.get(parsed.key);
    if (!g) {
      partitionFiles.set(parsed.key, { paths: [full], maxMtime: mt });
    } else {
      g.paths.push(full);
      if (mt > g.maxMtime) g.maxMtime = mt;
    }
  }

  let bestKey: string | null = null;
  let bestScore = -1;
  for (const [key, g] of partitionFiles) {
    if (g.maxMtime > bestScore) {
      bestScore = g.maxMtime;
      bestKey = key;
    }
  }

  if (!bestKey) {
    return { agencies: [], sourcePaths: [], representativePath: null, country: null, mode: null };
  }

  const [country, mode] = bestKey.split('/') as [string, Mode];
  const sourcePaths = collectStep0JsonPathsForCountryMerge({
    outputDir,
    country,
    mode,
  });

  const agencies = mergeAgencyArraysFromPaths(sourcePaths);
  const representativePath =
    sourcePaths.length > 0
      ? sourcePaths.reduce((a, b) =>
          fs.statSync(a).mtimeMs >= fs.statSync(b).mtimeMs ? a : b,
        )
      : null;

  return { agencies, sourcePaths, representativePath, country, mode };
}

export function loadAgenciesFromJson(filePath: string): Agency[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array of agencies in "${filePath}"`);
  }
  return parsed as Agency[];
}

export function buildSearchQueryToCitySlugMap(
  cities: string[],
  variants: string[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const city of cities) {
    const slug = slugifyCityForFilename(city);
    for (const v of variants) {
      m.set(`${v} ${city}`, slug);
    }
  }
  return m;
}

export function partitionAgenciesByCitySlug(
  agencies: Agency[],
  queryToCitySlug: Map<string, string>,
): Map<string, Agency[]> {
  const bySlug = new Map<string, Agency[]>();
  for (const a of agencies) {
    const q = a.search_query?.trim() ?? '';
    const slug = queryToCitySlug.get(q);
    if (!slug) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug)!.push(a);
  }
  return bySlug;
}

export const EVENT_AGENCIES_PIPELINE_CSV_HEADER: CsvHeaderEntry[] = [
  { id: 'processed_step', title: 'processed_step' },
  { id: 'search_query', title: 'search_query' },
  { id: 'name', title: 'name' },
  { id: 'company_name', title: 'company_name' },
  { id: 'category', title: 'category' },
  { id: 'address', title: 'address' },
  { id: 'city', title: 'city' },
  { id: 'postal_code', title: 'postal_code' },
  { id: 'country_code', title: 'country_code' },
  { id: 'website', title: 'website' },
  { id: 'phone', title: 'phone' },
  { id: 'google_maps_url', title: 'google_maps_url' },
  { id: 'place_id', title: 'place_id' },
  { id: 'linkedin_company_url', title: 'linkedin_company_url' },
  { id: 'linkedin_source', title: 'linkedin_source' },
  { id: 'linkedin_match_score', title: 'linkedin_match_score' },
  { id: 'contact_emails', title: 'contact_emails' },
  { id: 'website_facebook_url', title: 'website_facebook_url' },
  { id: 'website_instagram_url', title: 'website_instagram_url' },
  { id: 'website_twitter_url', title: 'website_twitter_url' },
  { id: 'website_tiktok_url', title: 'website_tiktok_url' },
  { id: 'website_scrape_status', title: 'website_scrape_status' },
  { id: 'website_scrape_error', title: 'website_scrape_error' },
  { id: 'website_scraped_url', title: 'website_scraped_url' },
];

export function agencyToPipelineCsvRow(a: Agency): Record<string, unknown> {
  return {
    processed_step: a.processed_step ?? effectiveProcessedStep(a),
    search_query: a.search_query,
    name: a.name,
    company_name: a.company_name ?? '',
    category: a.category,
    address: a.address,
    city: a.city,
    postal_code: a.postal_code,
    country_code: a.country_code,
    website: a.website,
    phone: a.phone,
    google_maps_url: a.google_maps_url,
    place_id: a.place_id,
    linkedin_company_url: a.linkedin_company_url ?? '',
    linkedin_source: a.linkedin_source ?? '',
    linkedin_match_score:
      a.linkedin_match_score != null ? a.linkedin_match_score.toFixed(2) : '',
    contact_emails: (a.contact_emails ?? []).join(' | '),
    website_facebook_url: a.website_facebook_url ?? '',
    website_instagram_url: a.website_instagram_url ?? '',
    website_twitter_url: a.website_twitter_url ?? '',
    website_tiktok_url: a.website_tiktok_url ?? '',
    website_scrape_status: a.website_scrape_status ?? '',
    website_scrape_error: a.website_scrape_error ?? '',
    website_scraped_url: a.website_scraped_url ?? '',
  };
}

/**
 * Rewrite canonical per-city JSONs (only slugs with ≥1 row) + global CSV.
 */
export async function writeCanonicalEventAgenciesOutputs(params: {
  outputDir: string;
  country: string;
  mode: Mode;
  cities: string[];
  variants: string[];
  allAgencies: Agency[];
}): Promise<{ cityPaths: string[]; globalCsvPath: string }> {
  const withCompany = (a: Agency): Agency => ({
    ...a,
    company_name: deriveCompanyName({
      name: a.name,
      city: a.city,
      country_code: a.country_code,
      variants: params.variants,
      category: a.category,
    }),
  });
  const queryMap = buildSearchQueryToCitySlugMap(params.cities, params.variants);
  const bySlug = partitionAgenciesByCitySlug(params.allAgencies, queryMap);
  const cityPaths: string[] = [];
  for (const [slug, rows] of bySlug) {
    if (rows.length === 0) continue;
    const p = getCanonicalStep0CityJsonPath({
      outputDir: params.outputDir,
      country: params.country,
      citySlug: slug,
      mode: params.mode,
    });
    writeJson(
      p,
      rows.map((r) => ({
        ...withCompany(r),
        processed_step: effectiveProcessedStep(r),
      })),
    );
    cityPaths.push(p);
  }
  const globalCsvPath = getCanonicalStep0GlobalCsvPath({
    outputDir: params.outputDir,
    country: params.country,
    mode: params.mode,
  });
  const rows = params.allAgencies.map((a) => ({
    ...withCompany(a),
    processed_step: effectiveProcessedStep(a),
  }));
  await writeAgenciesCsvOnly({
    csvPath: globalCsvPath,
    csvHeader: [...EVENT_AGENCIES_PIPELINE_CSV_HEADER],
    rows,
    toCsvRow: agencyToPipelineCsvRow,
  });
  return { cityPaths, globalCsvPath };
}

/** Merge by `place_id`; when both sides have a row, overlay fields win (spread after base). */
export function mergeAgenciesByPlaceIdPreferOverlay(base: Agency[], overlay: Agency[]): Agency[] {
  const map = new Map<string, Agency>();
  for (const a of base) {
    if (a.place_id) map.set(a.place_id, { ...a });
  }
  for (const a of overlay) {
    if (!a.place_id) continue;
    const prev = map.get(a.place_id);
    map.set(a.place_id, prev ? { ...prev, ...a } : { ...a });
  }
  return Array.from(map.values());
}

function mergeAgencyArraysFromPaths(paths: string[]): Agency[] {
  const sorted = [...paths].sort(
    (a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs,
  );
  const byPlace = new Map<string, Agency>();
  for (const p of sorted) {
    for (const row of loadAgenciesFromJson(p)) {
      if (row.place_id) byPlace.set(row.place_id, row);
    }
  }
  return Array.from(byPlace.values());
}

export async function writeAgenciesCsvOnly<TRow extends Record<string, unknown>>(params: {
  csvPath: string;
  csvHeader: CsvHeaderEntry[];
  rows: Agency[];
  toCsvRow: (agency: Agency) => TRow;
}): Promise<void> {
  ensureOutputDir();
  const dir = path.dirname(params.csvPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const csvWriter = createObjectCsvWriter({
    path: params.csvPath,
    header: params.csvHeader,
  });
  await csvWriter.writeRecords(params.rows.map(params.toCsvRow));
}

export function writeJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export async function writeJsonAndCsv<TRow extends Record<string, unknown>>(params: {
  basePath: string;
  rows: Agency[];
  csvHeader: CsvHeaderEntry[];
  toCsvRow: (agency: Agency) => TRow;
}): Promise<{ jsonPath: string; csvPath: string }> {
  ensureOutputDir();
  const jsonPath = `${params.basePath}.json`;
  const csvPath = `${params.basePath}.csv`;

  writeJson(jsonPath, params.rows);

  const csvWriter = createObjectCsvWriter({
    path: csvPath,
    header: params.csvHeader,
  });
  await csvWriter.writeRecords(params.rows.map(params.toCsvRow));

  return { jsonPath, csvPath };
}
