/**
 * Lightweight string similarity helpers for matching an agency name against
 * a search-result title (e.g. "Agence Paloma | LinkedIn").
 *
 * Approach: normalize both strings (lowercase + strip accents/punctuation),
 * tokenize, then compute a Jaccard similarity over tokens >=3 chars.
 */

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(s: string, minLen = 3): Set<string> {
  return new Set(
    normalizeForMatch(s)
      .split(' ')
      .filter((t) => t.length >= minLen),
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * First segment before a spaced separator (` - `, ` | `, en/em dash).
 * Maps listings often use "Brand - tagline…" while LinkedIn titles are just "Brand".
 */
export function primaryAgencyNameForLinkedinSearch(agencyName: string): string {
  const primary = agencyName.split(/\s+[-–—|]\s+/)[0]?.trim() ?? agencyName;
  return primary.length >= 2 ? primary : agencyName;
}

/**
 * Returns a similarity score in [0,1] between an agency name and a candidate
 * search-result title. Strips obvious LinkedIn boilerplate from the title.
 * Uses both the full Maps name and the primary segment so short LinkedIn titles
 * still match long Google Maps names.
 */
export function nameMatchScore(agencyName: string, candidateTitle: string): number {
  const cleanedTitle = candidateTitle
    .replace(/\s*[|·–-]\s*linkedin.*$/i, '')
    .replace(/\s+sur\s+linkedin.*$/i, '');
  const titleTokens = tokenize(cleanedTitle);
  const primary = primaryAgencyNameForLinkedinSearch(agencyName);
  const variants =
    primary === agencyName.trim()
      ? [agencyName]
      : [...new Set([agencyName.trim(), primary])].filter((v) => v.length > 0);
  let best = 0;
  for (const v of variants) {
    const s = jaccardSimilarity(tokenize(v), titleTokens);
    if (s > best) best = s;
  }
  return best;
}
