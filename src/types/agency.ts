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

/** Step 3 — LinkedIn people from Google; `contact_email` filled in Step 4. */
export type EmployeeRoleBucket =
  | 'founder'
  | 'leadership'
  | 'commercial'
  | 'partnerships'
  | 'event'
  | 'other';

export interface AgencyEmployee {
  linkedin_url: string;
  contact_email: string | null;
  name: string | null;
  job: string | null;
  role_bucket: EmployeeRoleBucket;
  /** Raw Google organic title for this `/in/` hit (STEP 3). */
  metadata_title: string;
  /** Raw Google organic description/snippet for this hit (STEP 3). */
  metadata_description: string;

  // ---------------------------------------------------------------------------
  // From scripts/open_agencies_linkedin (manual LinkedIn outreach loop)
  // ---------------------------------------------------------------------------
  /** `opened` = URL was opened in browser ; `skipped` = user explicitly skipped. */
  linkedin_outreach_status?: LinkedinOutreachStatus;
  /** ISO timestamp of the last outreach interaction recorded for this profile. */
  linkedin_outreach_at?: string;
  /** Did the user send a LinkedIn connect request (set after `opened`). */
  linkedin_connected?: boolean;
  /** Did the user send a first message to that profile (set after `opened`). */
  linkedin_first_message?: boolean;
}

export type LinkedinOutreachStatus = 'opened' | 'skipped';

export interface Agency {
  /**
   * Highest pipeline step completed for this row: 0 = Maps, 1 = website, 2 = company LinkedIn,
   * 3 = employee discovery (Google), 4+ reserved (e.g. Dropcontact).
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

  // ---------------------------------------------------------------------------
  // From scrape_event_agencies_employees_apify_step3.ts (Apify Google → /in/)
  // ---------------------------------------------------------------------------
  /** People rows; `contact_email` null until Step 4 enrichment. */
  employees?: AgencyEmployee[];

  // ---------------------------------------------------------------------------
  // From scripts/open_agencies_linkedin (manual LinkedIn outreach loop)
  // Tracks the interaction with the COMPANY LinkedIn page (employees track
  // their own state in `AgencyEmployee`).
  // ---------------------------------------------------------------------------
  /** `opened` = URL was opened in browser ; `skipped` = user explicitly skipped. */
  linkedin_outreach_status?: LinkedinOutreachStatus;
  /** ISO timestamp of the last outreach interaction recorded for the company page. */
  linkedin_outreach_at?: string;
  /** Did the user follow / send a connect request from the company page. */
  linkedin_connected?: boolean;
  /** Did the user send a first message from the company page. */
  linkedin_first_message?: boolean;
}

/** Implied step from legacy rows (no or stale `processed_step`). */
function inferredProcessedStepFromFields(a: Agency): number {
  if (Array.isArray(a.employees)) {
    return 3;
  }
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
