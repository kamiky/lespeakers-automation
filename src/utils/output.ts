/**
 * Shared file-IO helpers for the automation pipeline.
 *
 * Event-agencies canonical files (no timestamps; scripts rewrite in place):
 *   output/<debug|prod>/scrape_event_agencies_<country>_<citySlug>.json  — one JSON per city
 *   output/<debug|prod>/scrape_event_agencies_<country>.csv             — one global CSV
 *
 * Legacy flat files (`scrape_event_agencies_*_*_debug.json` under `output/`, timestamped
 * JSONs) remain readable for migration merges.
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

/** `automation/output/debug` or `automation/output/prod` (plus optional custom base). */
export function getModeOutputDir(outputBaseDir: string, mode: Mode): string {
  return path.join(outputBaseDir, mode);
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

function collectJsonSearchRoots(outputBaseDir: string): string[] {
  const roots = new Set<string>();
  if (fs.existsSync(outputBaseDir)) roots.add(outputBaseDir);
  for (const m of ['debug', 'prod'] as const) {
    const d = path.join(outputBaseDir, m);
    if (fs.existsSync(d)) roots.add(d);
  }
  return [...roots];
}

/**
 * Find the most recent JSON under `output/` (root, `debug/`, `prod/`) matching
 * `<prefix>_<country>_<mode>_<ts>.json`.
 */
export function findLatestJsonOutput(
  prefixOrPrefixes: string | string[],
  options?: { country?: string; outputDir?: string },
): string | null {
  const prefixes = Array.isArray(prefixOrPrefixes)
    ? prefixOrPrefixes
    : [prefixOrPrefixes];
  const outputBaseDir = options?.outputDir ?? OUTPUT_DIR;
  const country = options?.country;
  const files: { full: string; mtime: number }[] = [];
  for (const dir of collectJsonSearchRoots(outputBaseDir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      if (!prefixes.some((p) => fileMatchesPrefix(name, p, country))) continue;
      const full = path.join(dir, name);
      files.push({ full, mtime: fs.statSync(full).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].full : null;
}

/** Timestamp segment in legacy step0 filenames. */
const STEP0_TS = String.raw`\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}`;

/** Canonical per-city JSON inside `output/<mode>/`. */
export function canonicalStep0CityJsonFilename(country: string, citySlug: string): string {
  return `scrape_event_agencies_${country}_${citySlug}.json`;
}

export function canonicalStep0GlobalCsvFilename(country: string): string {
  return `scrape_event_agencies_${country}.csv`;
}

export function getCanonicalStep0CityJsonPath(params: {
  modeOutputDir: string;
  country: string;
  citySlug: string;
}): string {
  return path.join(
    params.modeOutputDir,
    canonicalStep0CityJsonFilename(params.country, params.citySlug),
  );
}

export function getCanonicalStep0GlobalCsvPath(params: {
  modeOutputDir: string;
  country: string;
}): string {
  return path.join(params.modeOutputDir, canonicalStep0GlobalCsvFilename(params.country));
}

/**
 * Infer country + mode from a path (prefers parent folder `debug` / `prod` for new layout).
 */
export function inferCountryAndModeFromPath(filePath: string): {
  country: string | null;
  mode: Mode | null;
} {
  const base = path.basename(filePath, '.json');
  const parent = path.basename(path.dirname(filePath));

  if (parent === 'debug' || parent === 'prod') {
    const mode = parent as Mode;
    const mNew = base.match(/^scrape_event_agencies_([a-z]{2,3})_([a-z0-9_-]+)$/);
    if (mNew) return { country: mNew[1], mode };
  }

  const oldFixed = /^scrape_event_agencies_([a-z]{2,3})_([a-z0-9_-]+)_(debug|prod)$/;
  const mf = base.match(oldFixed);
  if (mf) return { country: mf[1], mode: mf[3] as Mode };

  const legacy = new RegExp(`_([a-z]{2,3})_(debug|prod)_(${STEP0_TS})(?:_[a-z0-9_-]+)?$`);
  const ml = base.match(legacy);
  if (ml) return { country: ml[1], mode: ml[2] as Mode };

  return { country: null, mode: null };
}

/** @deprecated Use inferCountryAndModeFromPath (same behavior: accepts full path). */
export function inferCountryAndModeFromFilename(filePath: string): {
  country: string | null;
  mode: Mode | null;
} {
  return inferCountryAndModeFromPath(filePath);
}

/** URL-safe slug from a config city label (used in per-city JSON names). */
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
 * Match CLI `--city=paris` to `cities.json` when possible.
 * If not found, keep the user-provided city (free-form city override).
 */
export function resolveCityFromCliArg(cities: string[], cityArg: string): string {
  const trimmed = cityArg.trim();
  if (!trimmed) {
    throw new Error('Empty --city value.');
  }
  const lower = trimmed.toLowerCase();
  const slugArg = slugifyCityForFilename(trimmed);
  for (const c of cities) {
    if (c.toLowerCase() === lower) return c;
    if (slugifyCityForFilename(c) === slugArg) return c;
  }
  return trimmed;
}

/**
 * All step0 JSON paths to merge for a country/mode: canonical per-city files under
 * `output/<mode>/`, legacy flat old names + timestamped files under `output/`.
 */
export function collectStep0JsonPathsForCountryMerge(params: {
  outputBaseDir: string;
  country: string;
  mode: Mode;
}): string[] {
  const { outputBaseDir, country, mode } = params;
  const out: string[] = [];

  const modeDir = getModeOutputDir(outputBaseDir, mode);
  if (fs.existsSync(modeDir)) {
    const fixedRe = new RegExp(
      `^scrape_event_agencies_${escapeRegex(country)}_([a-z0-9_-]+)\\.json$`,
    );
    for (const name of fs.readdirSync(modeDir)) {
      if (!name.endsWith('.json')) continue;
      if (name.startsWith('scrape_event_agencies_with_')) continue;
      if (fixedRe.test(name)) {
        out.push(path.join(modeDir, name));
      }
    }
  }

  if (!fs.existsSync(outputBaseDir)) return out;

  const legacyOldCanonical = new RegExp(
    `^scrape_event_agencies_${escapeRegex(country)}_([a-z0-9_-]+)_${mode}\\.json$`,
  );
  for (const name of fs.readdirSync(outputBaseDir)) {
    if (!name.endsWith('.json')) continue;
    if (legacyOldCanonical.test(name)) {
      out.push(path.join(outputBaseDir, name));
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

  for (const name of fs.readdirSync(outputBaseDir)) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(outputBaseDir, name);
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
  outputBaseDir: string;
  modeOutputDir: string;
  country: string;
  mode: Mode;
  citySlug: string;
}): boolean {
  const newPath = getCanonicalStep0CityJsonPath({
    modeOutputDir: params.modeOutputDir,
    country: params.country,
    citySlug: params.citySlug,
  });
  if (fs.existsSync(newPath)) return true;
  const legacyFlat = path.join(
    params.outputBaseDir,
    `scrape_event_agencies_${params.country}_${params.citySlug}_${params.mode}.json`,
  );
  return fs.existsSync(legacyFlat);
}

function parseNewLayoutStep0Partition(fullPath: string): {
  key: string;
  country: string;
  mode: Mode;
} | null {
  const parent = path.basename(path.dirname(fullPath));
  if (parent !== 'debug' && parent !== 'prod') return null;
  const name = path.basename(fullPath);
  const m = name.match(/^scrape_event_agencies_([a-z]{2,3})_([a-z0-9_-]+)\.json$/);
  if (!m) return null;
  const mode = parent as Mode;
  return { key: `${m[1]}/${mode}`, country: m[1], mode };
}

function parseLegacyFlatStep0Partition(filename: string): {
  key: string;
  country: string;
  mode: Mode;
} | null {
  const oldFixed = /^scrape_event_agencies_([a-z]{2,3})_([a-z0-9_-]+)_(debug|prod)\.json$/;
  const mf = filename.match(oldFixed);
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
  const outputBaseDir = params?.outputDir ?? OUTPUT_DIR;
  if (!fs.existsSync(outputBaseDir)) {
    return { agencies: [], sourcePaths: [], representativePath: null, country: null, mode: null };
  }

  const partitionFiles = new Map<string, { paths: string[]; maxMtime: number }>();

  for (const mode of ['debug', 'prod'] as const) {
    const d = path.join(outputBaseDir, mode);
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      if (!name.endsWith('.json')) continue;
      if (!name.startsWith('scrape_event_agencies_')) continue;
      if (name.startsWith('scrape_event_agencies_with_')) continue;
      const full = path.join(d, name);
      const parsed = parseNewLayoutStep0Partition(full);
      if (!parsed) continue;
      const mt = fs.statSync(full).mtimeMs;
      const g = partitionFiles.get(parsed.key);
      if (!g) {
        partitionFiles.set(parsed.key, { paths: [full], maxMtime: mt });
      } else {
        g.paths.push(full);
        if (mt > g.maxMtime) g.maxMtime = mt;
      }
    }
  }

  if (fs.existsSync(outputBaseDir)) {
    for (const name of fs.readdirSync(outputBaseDir)) {
      if (!name.endsWith('.json')) continue;
      if (!name.startsWith('scrape_event_agencies_')) continue;
      if (name.startsWith('scrape_event_agencies_with_')) continue;
      const parsed = parseLegacyFlatStep0Partition(name);
      if (!parsed) continue;
      const full = path.join(outputBaseDir, name);
      const mt = fs.statSync(full).mtimeMs;
      const g = partitionFiles.get(parsed.key);
      if (!g) {
        partitionFiles.set(parsed.key, { paths: [full], maxMtime: mt });
      } else {
        g.paths.push(full);
        if (mt > g.maxMtime) g.maxMtime = mt;
      }
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
    outputBaseDir,
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

/** Merge all step0 JSON for a given country/mode (under `output/<mode>/` + legacy flat). */
export function loadStep0PartitionMergedForCountry(params: {
  outputBaseDir: string;
  country: string;
  mode: Mode;
}): {
  agencies: Agency[];
  sourcePaths: string[];
  representativePath: string | null;
} {
  const sourcePaths = collectStep0JsonPathsForCountryMerge(params);
  const agencies = mergeAgencyArraysFromPaths(sourcePaths);
  const representativePath =
    sourcePaths.length > 0
      ? sourcePaths.reduce((a, b) =>
          fs.statSync(a).mtimeMs >= fs.statSync(b).mtimeMs ? a : b,
        )
      : null;
  return { agencies, sourcePaths, representativePath };
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
    let slug = queryToCitySlug.get(q);
    if (!slug) {
      const cityFromRow = a.city?.trim() ?? '';
      if (cityFromRow) slug = slugifyCityForFilename(cityFromRow);
    }
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
  { id: 'employees_json', title: 'employees_json' },
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
    employees_json:
      a.employees && a.employees.length > 0 ? JSON.stringify(a.employees) : '',
  };
}

/**
 * Rewrite canonical per-city JSONs (only slugs with ≥1 row) + global CSV.
 * Pass `writeCitySlugsOnly` to touch only those city JSON files (CSV is always full `allAgencies`).
 */
export async function writeCanonicalEventAgenciesOutputs(params: {
  modeOutputDir: string;
  country: string;
  cities: string[];
  variants: string[];
  allAgencies: Agency[];
  writeCitySlugsOnly?: string[];
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
  const restrict = params.writeCitySlugsOnly;
  const cityPaths: string[] = [];
  for (const [slug, rows] of bySlug) {
    if (rows.length === 0) continue;
    if (restrict && !restrict.includes(slug)) continue;
    const p = getCanonicalStep0CityJsonPath({
      modeOutputDir: params.modeOutputDir,
      country: params.country,
      citySlug: slug,
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
    modeOutputDir: params.modeOutputDir,
    country: params.country,
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
