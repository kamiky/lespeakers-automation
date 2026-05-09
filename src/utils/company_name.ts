/**
 * Derive a short display / search label from Google Maps `title` by stripping
 * known search variants, optional category echo, city, and country labels,
 * then dropping taglines after the first spaced `-` / en dash / `_` / `/`.
 */

import { primaryAgencyNameForLinkedinSearch } from './fuzzy_match.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function stripEdgeSeparators(s: string): string {
  return s.replace(/^[-–—|/,;\s]+|[-–—|/,;\s]+$/g, '').trim();
}

function stripTrailingEt(s: string): string {
  return s.replace(/\s+et\s*$/i, '').replace(/^\s*et\s+/i, '').trim();
}

function countryLabels(countryCode: string): string[] {
  const code = countryCode.trim().toUpperCase();
  if (!code) return [];
  const out = new Set<string>();
  try {
    const en = new Intl.DisplayNames(['en'], { type: 'region' }).of(code);
    const fr = new Intl.DisplayNames(['fr'], { type: 'region' }).of(code);
    if (en) out.add(en);
    if (fr) out.add(fr);
  } catch {
    /* ignore */
  }
  if (code === 'US') {
    out.add('USA');
    out.add('United States');
  }
  if (code === 'GB' || code === 'UK') {
    out.add('UK');
    out.add('United Kingdom');
    out.add('Royaume-Uni');
  }
  return [...out].filter((s) => s.length >= 2);
}

function cityBoundaryRegex(city: string): RegExp | null {
  const c = city.trim();
  if (c.length < 2) return null;
  const parts = c.split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`\\b${parts}\\b`, 'gi');
}

function removePhrase(work: string, re: RegExp | null): string {
  if (!re) return work;
  return work.replace(re, ' ');
}

/**
 * "Brand - descriptor" / "Brand / branch" patterns in Maps titles; keep the leading brand.
 * Uses spaced hyphens/dashes so hyphenated words like "Saint-Martin" stay intact.
 */
function truncateAfterFirstDescriptorSeparator(s: string): string {
  const re = /\s+[-–—]\s+|\s+_\s+|\//;
  const m = re.exec(s);
  if (!m) return s;
  return s.slice(0, m.index).trim();
}

export interface DeriveCompanyNameParams {
  name: string;
  city: string;
  country_code: string;
  /** Search variants for this country (e.g. event_agencies_variants.json). */
  variants: string[];
  /** Maps category; stripped if it appears verbatim in the title. */
  category?: string;
}

/**
 * Best-effort brand / company label for LinkedIn search and display.
 * Falls back to the first segment before ` - ` / ` | ` if stripping empties the string.
 */
export function deriveCompanyName(params: DeriveCompanyNameParams): string {
  let work = params.name.trim();
  if (!work) return '';

  const sortedVariants = [...params.variants].sort((a, b) => b.length - a.length);
  for (const v of sortedVariants) {
    const t = v.trim();
    if (t.length < 2) continue;
    work = work.replace(new RegExp(escapeRegExp(t), 'gi'), ' ');
  }

  const cat = params.category?.trim();
  if (cat && cat.length >= 3) {
    work = work.replace(new RegExp(escapeRegExp(cat), 'gi'), ' ');
  }

  const city = params.city.trim();
  if (city.length >= 2) {
    work = work.replace(new RegExp(`\\s+à\\s+${escapeRegExp(city)}\\b`, 'gi'), ' ');
    work = removePhrase(work, cityBoundaryRegex(city));
  }

  for (const label of countryLabels(params.country_code)) {
    const parts = label.split(/\s+/).map(escapeRegExp).join('\\s+');
    work = work.replace(new RegExp(`\\b${parts}\\b`, 'gi'), ' ');
  }

  work = stripTrailingEt(collapseSpaces(work));
  work = stripEdgeSeparators(work);
  work = collapseSpaces(stripTrailingEt(work));
  work = truncateAfterFirstDescriptorSeparator(work);
  work = collapseSpaces(stripEdgeSeparators(work));

  if (work.length < 2) {
    work = primaryAgencyNameForLinkedinSearch(params.name).trim();
    work = truncateAfterFirstDescriptorSeparator(work);
    work = collapseSpaces(stripEdgeSeparators(work));
  }

  return work;
}

/** Label for Apify Google / fuzzy match: persisted `company_name` or derived on the fly. */
export function agencyLabelForSearch(
  agency: {
    name: string;
    company_name?: string | null;
    city: string;
    country_code: string;
    category?: string;
  },
  variants: string[],
): string {
  const persisted = agency.company_name?.trim();
  if (persisted) return persisted;
  return deriveCompanyName({
    name: agency.name,
    city: agency.city,
    country_code: agency.country_code,
    variants,
    category: agency.category,
  });
}
