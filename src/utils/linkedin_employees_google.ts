/**
 * Helpers for Step 3 — Google organic results → LinkedIn /in/ profiles (employees).
 */

import type { AgencyEmployee, EmployeeRoleBucket } from '../types/agency.js';

export type { AgencyEmployee, EmployeeRoleBucket };

const ROLE_ORDER: Record<EmployeeRoleBucket, number> = {
  founder: 0,
  leadership: 1,
  partnerships: 2,
  commercial: 3,
  event: 4,
  other: 5,
};

export function normalizeLinkedinProfileUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!u.hostname.toLowerCase().endsWith('linkedin.com')) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (seg.length < 2 || seg[0]?.toLowerCase() !== 'in') return null;
    const slug = seg[1];
    if (!slug || /^(feed|pub|learning|jobs|school|company)$/i.test(slug)) return null;
    return `https://www.linkedin.com/in/${slug}/`;
  } catch {
    return null;
  }
}

/** `/company/foo-bar/` → `foo-bar` */
export function extractLinkedinCompanySlug(url: string | null | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    const u = new URL(url.trim());
    if (!u.hostname.toLowerCase().endsWith('linkedin.com')) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    const idx = seg.findIndex((s) => s.toLowerCase() === 'company');
    if (idx < 0 || !seg[idx + 1]) return null;
    const slug = seg[idx + 1];
    if (!slug || /[^\w-]/i.test(slug)) return null;
    return slug.toLowerCase();
  } catch {
    return null;
  }
}

export function stripLinkedinTitleBoilerplate(title: string): string {
  return title
    .replace(/\s*\|\s*LinkedIn.*$/i, '')
    .replace(/\s+sur\s+LinkedIn.*$/i, '')
    .trim();
}

/**
 * Lowercase, strip combining marks (é è ê → e), unify hyphens / punctuation to spaces.
 * Used for comparing Google SERP title vs company label.
 */
export function normalizeForCompanyMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/-/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True if accent-normalized `companyLabel` appears in the organic **title** (after stripping `| LinkedIn`)
 * or in the organic **description** (Google snippet).
 */
export function serpOrganicContainsCompanyLabel(
  title: string,
  description: string,
  companyLabel: string,
): boolean {
  const lab = normalizeForCompanyMatch(companyLabel);
  if (lab.length < 2) return false;
  const t = normalizeForCompanyMatch(stripLinkedinTitleBoilerplate(title));
  const d = normalizeForCompanyMatch(description);
  return t.includes(lab) || d.includes(lab);
}

function isInteractionSpam(title: string, description: string): boolean {
  const blob = `${title}\n${description}`.toLowerCase();
  return (
    /\b(commented on|commentaire sur|a commenté|liked this|a aimé|likes this)\b/i.test(blob) ||
    /\b(reposted|a republié|shared (?:this )?post|a partagé)\b/i.test(blob) ||
    /\b(reply to|répond \|)\b/i.test(blob)
  );
}

function isStudentOrThinMetaSnippet(description: string): boolean {
  const d = description.trim();
  if (!d) return false;
  const lower = d.toLowerCase();
  if (/formation\s*:/i.test(d) && /lieu\s*:/i.test(d)) return true;
  if (/\b\d+\s+relations?\s+sur\s+linkedin\b/i.test(lower)) return true;
  if (/consultez le profil de\b/i.test(lower)) return true;
  if (/view .{3,120}'?s? profile on linkedin\b/i.test(lower)) return true;
  if (
    d.length > 140 &&
    /\b(université|university|école|etudiant|étudiant|student)\b/i.test(lower) &&
    !/\b(chef|directeur|directrice|manager|fondateur|cofondateur|founder|ceo|commercial)\b/i.test(lower)
  ) {
    return true;
  }
  return false;
}

export function parsePersonNameAndJob(title: string, description?: string): {
  name: string | null;
  job: string | null;
} {
  const t = stripLinkedinTitleBoilerplate(title);
  const desc = (description ?? '').trim();
  const descShort = desc ? desc.slice(0, 240) : '';

  if (!t) {
    return { name: null, job: descShort || null };
  }

  const parts = t.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const name = parts[0] ?? null;
    const jobHead = parts.slice(1).join(' - ').trim();
    const job =
      jobHead && descShort && !descShort.toLowerCase().includes(jobHead.toLowerCase().slice(0, 24))
        ? `${jobHead} — ${descShort}`
        : jobHead || descShort || null;
    return { name, job };
  }

  return { name: t, job: descShort || null };
}

export function classifyEmployeeRoleBucket(title: string, description?: string): EmployeeRoleBucket {
  const text = `${title} ${description ?? ''}`.toLowerCase();
  if (/\b(co[- ]?founder|founder|cofondateur|fondateur|fondatrice)\b/i.test(text)) {
    return 'founder';
  }
  if (
    /\b(ceo|c\.e\.o\.|chief executive|directeur général|directrice générale|\bdg\b|président|presidente|gérant|gérante|managing director|pdg)\b/i.test(
      text,
    )
  ) {
    return 'leadership';
  }
  if (/\b(partnership|partenariat|alliances?)\b/i.test(text)) {
    return 'partnerships';
  }
  if (/\b(sales|commercial|business development|développement|account executive|ventes)\b/i.test(text)) {
    return 'commercial';
  }
  if (
    /\b(event|événement|evenement|production|chef de projet|project manager|chargé de projet)\b/i.test(
      text,
    )
  ) {
    return 'event';
  }
  return 'other';
}

export interface OrganicPersonResult {
  url?: string;
  title?: string;
  description?: string;
}

export interface OrganicResultsEmployeeContext {
  agencySearchLabel: string;
}

export function organicResultsToEmployees(
  results: OrganicPersonResult[],
  maxEmployees: number,
  context: OrganicResultsEmployeeContext,
): AgencyEmployee[] {
  const bySlug = new Map<string, AgencyEmployee>();

  for (const r of results) {
    if (!r.url || !r.title) continue;
    const linkedin = normalizeLinkedinProfileUrl(r.url);
    if (!linkedin) continue;
    let slug: string;
    try {
      slug = new URL(linkedin).pathname.split('/').filter(Boolean)[1] ?? '';
    } catch {
      continue;
    }
    if (!slug || bySlug.has(slug)) continue;

    const title = r.title;
    const description = r.description ?? '';

    if (!serpOrganicContainsCompanyLabel(title, description, context.agencySearchLabel)) continue;
    if (isInteractionSpam(title, description)) continue;
    if (isStudentOrThinMetaSnippet(description)) continue;

    const { name, job } = parsePersonNameAndJob(title, description);
    const role_bucket = classifyEmployeeRoleBucket(title, description);

    bySlug.set(slug, {
      linkedin_url: linkedin,
      contact_email: null,
      name,
      job,
      role_bucket,
    });
  }

  const list = [...bySlug.values()];
  list.sort((a, b) => ROLE_ORDER[a.role_bucket] - ROLE_ORDER[b.role_bucket]);
  return list.slice(0, Math.max(0, maxEmployees));
}
