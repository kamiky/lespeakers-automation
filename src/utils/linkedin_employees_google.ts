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

export function stripLinkedinTitleBoilerplate(title: string): string {
  return title
    .replace(/\s*\|\s*LinkedIn.*$/i, '')
    .replace(/\s+sur\s+LinkedIn.*$/i, '')
    .trim();
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

export function organicResultsToEmployees(
  results: OrganicPersonResult[],
  maxEmployees: number,
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

    const { name, job } = parsePersonNameAndJob(r.title, r.description);
    const role_bucket = classifyEmployeeRoleBucket(r.title, r.description);
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
