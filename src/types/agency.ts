/**
 * Canonical Agency type, shared across every step of the pipeline.
 *
 * Each step reads a JSON file with `Agency[]` and writes a new JSON file
 * with the same array, enriched with the new fields.
 *
 * Optional fields are only set by the step responsible for them.
 */

export type LinkedinSource =
  | 'website'
  | 'apify_google_search'
  | 'not_found';

export type WebsiteScrapeStatus =
  | 'success'
  | 'no_website'
  | 'http_error'
  | 'timeout'
  | 'parse_error'
  | 'no_data_found';

export interface Agency {
  /**
   * Highest pipeline step completed for this row: 0 = step0 (Maps) only,
   * 1 = website scrape (step1) done, 2 = LinkedIn Apify search (step2) done.
   * Older JSON may omit this; use `effectiveProcessedStep()` when deciding skips.
   */
  processed_step?: number;

  // ---------------------------------------------------------------------------
  // From scrape_event_agencies.ts (Apify Google Maps)
  // ---------------------------------------------------------------------------
  search_query: string;
  name: string;
  /** Short brand label: `name` stripped of search variants, city, country (step 0 / canonical write). */
  company_name?: string;
  category: string;
  address: string;
  city: string;
  postal_code: string;
  country_code: string;
  website: string;
  phone: string;
  google_maps_url: string;
  place_id: string;

  // ---------------------------------------------------------------------------
  // From scrape_event_agencies_website_socials_and_contact_step1.ts
  // ---------------------------------------------------------------------------
  linkedin_company_url?: string | null;
  linkedin_source?: LinkedinSource | null;
  contact_emails?: string[];
  website_facebook_url?: string | null;
  website_instagram_url?: string | null;
  website_twitter_url?: string | null;
  website_tiktok_url?: string | null;
  website_scrape_status?: WebsiteScrapeStatus | null;
  website_scrape_error?: string | null;
  website_scraped_url?: string | null;

  // ---------------------------------------------------------------------------
  // From scrape_event_agencies_linkedin_from_apify.ts
  // (only updates linkedin_company_url + linkedin_source for those still null)
  // ---------------------------------------------------------------------------
  linkedin_match_score?: number | null;
}

/** Implied step from legacy rows (no or stale `processed_step`). */
function inferredProcessedStepFromFields(a: Agency): number {
  if (a.linkedin_source === 'apify_google_search' || a.linkedin_source === 'not_found') {
    return 2;
  }
  if (a.website_scrape_status != null) {
    return 1;
  }
  return 0;
}

/**
 * Step used for skip logic and normalizing output. Uses explicit `processed_step`
 * when present, but never below what scrape fields imply (legacy / hand-edited JSON).
 */
export function effectiveProcessedStep(a: Agency): number {
  const inferred = inferredProcessedStepFromFields(a);
  if (typeof a.processed_step === 'number' && !Number.isNaN(a.processed_step)) {
    return Math.max(0, Math.floor(a.processed_step), inferred);
  }
  return inferred;
}
