/**
 * HTML scraper: LinkedIn, emails, social profiles (Facebook / Instagram / X / TikTok).
 *
 * Strategy:
 *   1. Fetch homepage (and on failure, still try common contact paths — some sites
 *      block `/` with 403 but allow `/contact`).
 *   2. Parse with cheerio; merge signals across all successful responses.
 */

import axios, { type AxiosError } from 'axios';
import * as cheerio from 'cheerio';

import type { WebsiteScrapeStatus } from '../types/agency.js';
import { fetchOneUrlViaWebsiteContentCrawler } from './website_scraper_apify.js';

const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const COMMON_CONTACT_PATHS = [
  '/contact',
  '/contact-us',
  '/contactez-nous',
  '/nous-contacter',
  '/mentions-legales',
  '/legal',
];

const EMAIL_REGEX =
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,10}/g;

const EMAIL_BLOCKLIST_DOMAINS = new Set([
  'sentry.io',
  'wixstatic.com',
  'wixpress.com',
  'cloudinary.com',
  'gravatar.com',
  'example.com',
  'example.org',
  'domain.com',
  'mail.com',
  'votre-domaine.com',
  'votredomaine.com',
  'yourdomain.com',
  'yoursite.com',
]);

const EMAIL_BLOCKLIST_LOCAL = new Set([
  'name',
  'your',
  'youremail',
  'votre',
  'votremail',
  'votre-email',
  'email',
  'noreply',
  'no-reply',
]);

const EMAIL_BLOCKLIST_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];

export interface WebsiteSocialUrls {
  facebook: string | null;
  instagram: string | null;
  twitter: string | null;
  tiktok: string | null;
}

export interface WebsiteScrapeResult {
  status: WebsiteScrapeStatus;
  scrapedUrl: string | null;
  linkedinCompanyUrl: string | null;
  emails: string[];
  socials: WebsiteSocialUrls;
  error: string | null;
}

export interface WebsiteScrapeOptions {
  /** Verbose logs (URLs, HTTP status, merge steps). */
  debug?: boolean;
  /**
   * When true (CLI `--apify-when-block` / `--apify-when-blocked` only): if all direct HTTP
   * fetches fail (e.g. Cloudflare) and `APIFY_TOKEN` is set, run `apify/website-content-crawler`
   * once for the homepage URL (Playwright).
   */
  apifyWhenBlocked?: boolean;
}

function emptySocials(): WebsiteSocialUrls {
  return { facebook: null, instagram: null, twitter: null, tiktok: null };
}

function emptyResult(
  status: WebsiteScrapeStatus,
  scrapedUrl: string | null,
  error: string | null = null,
): WebsiteScrapeResult {
  return {
    status,
    scrapedUrl,
    linkedinCompanyUrl: null,
    emails: [],
    socials: emptySocials(),
    error,
  };
}

function dbg(debug: boolean | undefined, ...msg: unknown[]): void {
  if (debug) console.log('[website-scraper]', ...msg);
}

function apifyWhenBlockedEnabled(options?: WebsiteScrapeOptions): boolean {
  return options?.apifyWhenBlocked === true;
}

/** Cloudflare (and similar) returns this HTML with HTTP 403 or occasionally 200. */
function isCloudflareInterstitial(html: string): boolean {
  if (!html || html.length < 80) return false;
  if (html.includes('cdn-cgi/challenge-platform') || html.includes('challenges.cloudflare.com')) {
    return true;
  }
  if (html.includes('_cf_chl_opt') && /challenge|cloudflare/i.test(html)) return true;
  if (/Just a moment/i.test(html) && html.includes('cloudflare')) return true;
  return false;
}

/**
 * Build HTML cheerio can parse from Apify markdown+text: markdown links become real anchors;
 * body text keeps mailto-like strings for regex passes.
 */
function syntheticHtmlFromMarkdownAndText(markdown: string, text: string): string {
  const hrefs: string[] = [];
  const mdLink = /\[[^\]]*]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLink.exec(markdown)) !== null) {
    hrefs.push(m[1]);
  }
  const anchors = [...new Set(hrefs)]
    .map((href) => {
      const safe = href.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return `<a href="${safe}">.</a>`;
    })
    .join('');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><body>${anchors}<div class="apify-blob">${esc(markdown)}\n${esc(text)}</div></body></html>`;
}

/** LinkedIn / social URLs embedded as plain text (footer, Apify text blobs, minified JS). */
function extractContactSignalsFromRawString(raw: string, baseUrl: string, debug?: boolean): ExtractedContactSignals {
  let linkedinUrl: string | null = null;
  const liRe = /https?:\/\/(?:[\w.-]+\.)?linkedin\.com\/(company|school)\/[a-zA-Z0-9_-]+/gi;
  let lm: RegExpExecArray | null;
  while ((lm = liRe.exec(raw)) !== null) {
    const n = normalizeLinkedinUrl(lm[0]);
    if (n) {
      linkedinUrl = n;
      break;
    }
  }

  const emailSet = new Set<string>();
  for (const em of raw.match(EMAIL_REGEX) ?? []) {
    emailSet.add(em);
  }
  const emails = [...emailSet]
    .map((e) => e.toLowerCase().trim())
    .filter(isLikelyValidEmail);
  emails.sort((a, b) => emailScore(b) - emailScore(a));

  let socials = emptySocials();
  const looseUrl = /https?:\/\/[^\s"'<>\])]+/gi;
  let um: RegExpExecArray | null;
  looseUrl.lastIndex = 0;
  while ((um = looseUrl.exec(raw)) !== null) {
    let u = um[0].replace(/[),.;]+$/g, '');
    u = u.replace(/&gt;$/g, '');
    if (u.length < 12) continue;
    socials = mergeSocials(socials, extractSocialFromHref(u, baseUrl));
  }

  dbg(
    debug,
    `extract raw-string: linkedin=${!!linkedinUrl} emails=${emails.length} socials=`,
    socials,
  );

  return { linkedinUrl, emails, socials };
}

function normalizeWebsite(rawUrl: string): string | null {
  if (!rawUrl) return null;
  let url = rawUrl.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  try {
    const parsed = new URL(url);
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeLinkedinUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl, 'https://example.com');
    if (!parsed.hostname.endsWith('linkedin.com')) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    const [section, slug] = segments;
    if (!['company', 'school'].includes(section)) return null;
    if (!slug || slug.length === 0) return null;
    return `https://www.linkedin.com/${section}/${slug}/`;
  } catch {
    return null;
  }
}

function cleanSocialUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

function normalizeFacebookUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl, 'https://example.com');
    const h = u.hostname.replace(/^www\./, '');
    if (h !== 'facebook.com' && h !== 'fb.com' && h !== 'm.facebook.com') return null;
    const path = u.pathname.toLowerCase();
    if (path.includes('/sharer') || path.includes('/share.php') || path.includes('/dialog/')) {
      return null;
    }
    return cleanSocialUrl(u.toString());
  } catch {
    return null;
  }
}

function normalizeInstagramUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl, 'https://example.com');
    const h = u.hostname.replace(/^www\./, '');
    if (h !== 'instagram.com' && h !== 'm.instagram.com') return null;
    if (u.pathname.includes('/embed/')) return null;
    return cleanSocialUrl(u.toString());
  } catch {
    return null;
  }
}

function normalizeTwitterUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl, 'https://example.com');
    const h = u.hostname.replace(/^www\./, '');
    if (h !== 'twitter.com' && h !== 'x.com' && h !== 'mobile.twitter.com') return null;
    const path = u.pathname.toLowerCase();
    if (
      path.includes('/intent/') ||
      path.includes('/share') ||
      path.includes('/search') ||
      path === '' ||
      path === '/'
    ) {
      return null;
    }
    if (h === 'twitter.com') {
      u.hostname = 'x.com';
    }
    return cleanSocialUrl(u.toString());
  } catch {
    return null;
  }
}

function normalizeTiktokUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl, 'https://example.com');
    const h = u.hostname.replace(/^www\./, '');
    if (h !== 'tiktok.com' && h !== 'vm.tiktok.com' && h !== 'www.tiktok.com') return null;
    if (u.pathname.includes('/share')) return null;
    return cleanSocialUrl(u.toString());
  } catch {
    return null;
  }
}

function isLikelyValidEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (lower.length < 6 || lower.length > 100) return false;
  if (EMAIL_BLOCKLIST_EXT.some((ext) => lower.endsWith(ext))) return false;

  const [local, domain] = lower.split('@');
  if (!local || !domain) return false;
  if (EMAIL_BLOCKLIST_LOCAL.has(local)) return false;
  if (EMAIL_BLOCKLIST_DOMAINS.has(domain)) return false;
  if (/^\d+$/.test(local)) return false;
  if (domain.startsWith('o') && /\d/.test(domain) && domain.endsWith('.ingest.sentry.io')) {
    return false;
  }
  return true;
}

/** Strip one or more leading `www.` labels (case-insensitive). */
function stripLeadingWww(hostname: string): string {
  let h = hostname.toLowerCase();
  while (h.startsWith('www.')) {
    h = h.slice(4);
  }
  return h;
}

/**
 * Keep only emails whose domain is the same "site" as the scraped website host:
 * exact match (after stripping `www.`), website is a subdomain of the email domain,
 * or email domain is a subdomain of the website host. Drops third-party scripts
 * (e.g. `@sentry*.wixpress.com`) when the site is `le-rideau.fr`.
 */
function emailDomainMatchesWebsite(emailDomain: string, websiteHostname: string): boolean {
  const e = stripLeadingWww(emailDomain.trim());
  const w = stripLeadingWww(websiteHostname.trim());
  if (!e || !w) return false;
  if (e === w) return true;
  if (w.endsWith(`.${e}`)) return true;
  if (e.endsWith(`.${w}`)) return true;
  return false;
}

function filterEmailsToWebsiteHost(emails: string[], websiteNormalizedUrl: string): string[] {
  let host: string;
  try {
    host = new URL(websiteNormalizedUrl).hostname;
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of emails) {
    const em = raw.toLowerCase().trim();
    const at = em.lastIndexOf('@');
    if (at <= 0 || at === em.length - 1) continue;
    const domain = em.slice(at + 1);
    if (!emailDomainMatchesWebsite(domain, host)) continue;
    if (seen.has(em)) continue;
    seen.add(em);
    out.push(em);
  }
  out.sort((a, b) => emailScore(b) - emailScore(a));
  return out;
}

function mergeSocials(
  a: WebsiteSocialUrls,
  b: Partial<WebsiteSocialUrls>,
): WebsiteSocialUrls {
  return {
    facebook: a.facebook ?? b.facebook ?? null,
    instagram: a.instagram ?? b.instagram ?? null,
    twitter: a.twitter ?? b.twitter ?? null,
    tiktok: a.tiktok ?? b.tiktok ?? null,
  };
}

function extractSocialFromHref(href: string, baseUrl: string): Partial<WebsiteSocialUrls> {
  let absolute: string;
  try {
    absolute = new URL(href, baseUrl).href;
  } catch {
    return {};
  }
  const out: Partial<WebsiteSocialUrls> = {};
  const fb = normalizeFacebookUrl(absolute);
  if (fb) out.facebook = fb;
  const ig = normalizeInstagramUrl(absolute);
  if (ig) out.instagram = ig;
  const tw = normalizeTwitterUrl(absolute);
  if (tw) out.twitter = tw;
  const tt = normalizeTiktokUrl(absolute);
  if (tt) out.tiktok = tt;
  return out;
}

export interface ExtractedContactSignals {
  linkedinUrl: string | null;
  emails: string[];
  socials: WebsiteSocialUrls;
}

function extractFromHtml(html: string, baseUrl: string, debug?: boolean): ExtractedContactSignals {
  const $ = cheerio.load(html);

  let linkedinUrl: string | null = null;
  $('a[href*="linkedin.com"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const normalized = normalizeLinkedinUrl(href);
    if (normalized) {
      linkedinUrl = normalized;
      return false;
    }
    return undefined;
  });

  const emailSet = new Set<string>();

  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const raw = href.replace(/^mailto:/i, '').split('?')[0];
    raw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .forEach((e) => emailSet.add(e));
  });

  const matches = html.match(EMAIL_REGEX) ?? [];
  for (const m of matches) emailSet.add(m);

  const cleaned = [...emailSet]
    .map((e) => e.toLowerCase().trim())
    .filter(isLikelyValidEmail);

  cleaned.sort((a, b) => emailScore(b) - emailScore(a));

  let socials = emptySocials();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const part = extractSocialFromHref(href, baseUrl);
    socials = mergeSocials(socials, part);
  });

  const loose = extractContactSignalsFromRawString(html, baseUrl, debug);
  const out: ExtractedContactSignals = {
    linkedinUrl: linkedinUrl ?? loose.linkedinUrl,
    emails: mergeEmailLists(cleaned, loose.emails),
    socials: mergeSocials(socials, loose.socials),
  };

  dbg(
    debug,
    `extract ${baseUrl}: linkedin=${!!out.linkedinUrl} emails=${out.emails.length} socials=`,
    out.socials,
  );

  return out;
}

function emailScore(email: string): number {
  const local = email.split('@')[0];
  const PREFERRED = ['contact', 'hello', 'bonjour', 'info', 'accueil', 'sales', 'commercial'];
  if (PREFERRED.includes(local)) return 10;
  if (PREFERRED.some((p) => local.startsWith(p))) return 5;
  return 0;
}

type SafeFetchResult =
  | { ok: true; data: string; httpStatus: number }
  | { ok: false; error: string; status: WebsiteScrapeStatus; httpStatus?: number };

function cfBlockedMessage(httpStatus: number): string {
  return (
    `Cloudflare/WAF blocked (HTTP ${httpStatus}). Node HTTP cannot pass this challenge. ` +
    `Retry with --apify-when-block (or --apify-when-blocked) and APIFY_TOKEN ` +
    `(Apify Website Content Crawler / Playwright).`
  );
}

async function safeFetch(url: string, debug?: boolean): Promise<SafeFetchResult> {
  dbg(debug, `GET ${url}`);
  try {
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return 'https://www.google.com';
      }
    })();

    const res = await axios.get<string>(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent': USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        Referer: `${origin}/`,
      },
      responseType: 'text',
      transformResponse: [(d) => d],
    });
    const data = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    dbg(debug, `  -> ${res.status}, body length=${data.length}`);
    if (res.status >= 200 && res.status < 300) {
      if (isCloudflareInterstitial(data)) {
        return { ok: false, status: 'http_error', httpStatus: res.status, error: cfBlockedMessage(res.status) };
      }
      return { ok: true, data, httpStatus: res.status };
    }
    if (isCloudflareInterstitial(data)) {
      return { ok: false, status: 'http_error', httpStatus: res.status, error: cfBlockedMessage(res.status) };
    }
    const snippet = data.replace(/\s+/g, ' ').trim().slice(0, 160);
    return {
      ok: false,
      status: 'http_error',
      httpStatus: res.status,
      error: snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`,
    };
  } catch (err) {
    const e = err as AxiosError;
    const status = e.response?.status;
    const body = e.response?.data;
    const bodyStr = typeof body === 'string' ? body : '';
    dbg(debug, `  -> error code=${e.code} httpStatus=${status ?? '-'} message=${e.message}`);
    if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
      return { ok: false, error: 'timeout', status: 'timeout' };
    }
    if (bodyStr && isCloudflareInterstitial(bodyStr) && status != null) {
      return { ok: false, status: 'http_error', httpStatus: status, error: cfBlockedMessage(status) };
    }
    const msg =
      status != null
        ? `HTTP ${status}: ${e.message ?? 'request failed'}`
        : (e.message ?? String(err));
    return {
      ok: false,
      error: msg,
      status: 'http_error',
      httpStatus: status,
    };
  }
}

function mergeEmailLists(a: string[], b: string[]): string[] {
  const s = new Set(
    [...a, ...b].map((e) => e.toLowerCase().trim()).filter(isLikelyValidEmail),
  );
  return [...s].sort((x, y) => emailScore(y) - emailScore(x));
}

function mergeSignals(acc: ExtractedContactSignals, part: ExtractedContactSignals): void {
  if (!acc.linkedinUrl && part.linkedinUrl) acc.linkedinUrl = part.linkedinUrl;
  acc.emails = mergeEmailLists(acc.emails, part.emails);
  acc.socials = mergeSocials(acc.socials, part.socials);
}

function hasAnyUsefulData(s: ExtractedContactSignals): boolean {
  return (
    !!s.linkedinUrl ||
    s.emails.length > 0 ||
    !!s.socials.facebook ||
    !!s.socials.instagram ||
    !!s.socials.twitter ||
    !!s.socials.tiktok
  );
}

/**
 * Scrape one website for LinkedIn, emails, and social URLs.
 */
export async function scrapeWebsiteForSocialsAndContact(
  rawWebsite: string,
  options?: WebsiteScrapeOptions,
): Promise<WebsiteScrapeResult> {
  const debug = options?.debug === true;

  const normalized = normalizeWebsite(rawWebsite);
  if (!normalized) {
    return emptyResult('no_website', null, 'invalid or missing website URL');
  }

  dbg(debug, 'normalized URL:', normalized);

  const pages: { url: string; html: string }[] = [];
  const httpErrors: { error: string; status: WebsiteScrapeStatus }[] = [];

  const tryPushPage = async (pageUrl: string): Promise<void> => {
    const res = await safeFetch(pageUrl, debug);
    if (!res.ok) {
      httpErrors.push({ error: res.error, status: res.status });
      return;
    }
    pages.push({ url: pageUrl, html: res.data });
  };

  await tryPushPage(normalized);

  const base = new URL(normalized);
  for (const subPath of COMMON_CONTACT_PATHS) {
    const target = new URL(subPath, base).toString();
    await tryPushPage(target);
  }

  if (pages.length === 0 && apifyWhenBlockedEnabled(options)) {
    dbg(debug, 'HTTP returned no usable HTML; trying Apify Website Content Crawler (homepage only)...');
    try {
      const crawled = await fetchOneUrlViaWebsiteContentCrawler(normalized, { debug });
      if (crawled) {
        const synth = syntheticHtmlFromMarkdownAndText(crawled.markdown, crawled.text);
        pages.push({ url: crawled.loadedUrl, html: synth });
      }
    } catch (err) {
      dbg(debug, 'Apify crawl error:', err);
      httpErrors.push({
        error: err instanceof Error ? err.message : String(err),
        status: 'http_error',
      });
    }
  }

  if (pages.length === 0) {
    const fe = httpErrors[0];
    const errStatus: WebsiteScrapeStatus = fe?.status ?? 'http_error';
    const errMsg = fe?.error ?? 'no HTML responses';
    return emptyResult(errStatus, normalized, errMsg);
  }

  const merged: ExtractedContactSignals = {
    linkedinUrl: null,
    emails: [],
    socials: emptySocials(),
  };

  for (const p of pages) {
    try {
      const part = extractFromHtml(p.html, p.url, debug);
      mergeSignals(merged, part);
    } catch (err) {
      dbg(debug, `parse error on ${p.url}:`, err);
    }
  }

  const emailsForSite = filterEmailsToWebsiteHost(merged.emails, normalized);

  if (!hasAnyUsefulData({ ...merged, emails: emailsForSite })) {
    const fe = httpErrors[0];
    return {
      status: 'no_data_found',
      scrapedUrl: pages[0]?.url ?? normalized,
      linkedinCompanyUrl: null,
      emails: [],
      socials: merged.socials,
      error: fe != null ? `homepage/other: ${fe.error}` : null,
    };
  }

  const primaryUrl = pages[0]?.url ?? normalized;

  return {
    status: 'success',
    scrapedUrl: primaryUrl,
    linkedinCompanyUrl: merged.linkedinUrl,
    emails: emailsForSite,
    socials: merged.socials,
    error: null,
  };
}

/** @deprecated use scrapeWebsiteForSocialsAndContact */
export async function scrapeWebsiteForLinkedinAndEmails(
  rawWebsite: string,
  options?: WebsiteScrapeOptions,
): Promise<WebsiteScrapeResult> {
  return scrapeWebsiteForSocialsAndContact(rawWebsite, options);
}
