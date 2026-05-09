/**
 * Optional Apify browser crawl for STEP 1 when plain HTTP is blocked (e.g. Cloudflare).
 * Uses actor apify/website-content-crawler (Playwright) — same APIFY_TOKEN as other steps.
 */

import { ApifyClient } from 'apify-client';

const WEBSITE_CONTENT_CRAWLER = 'apify/website-content-crawler';

export interface ApifyCrawledPageBlob {
  loadedUrl: string;
  markdown: string;
  text: string;
}

function dbg(debug: boolean | undefined, ...msg: unknown[]): void {
  if (debug) console.log('[website-scraper-apify]', ...msg);
}

/**
 * Fetch one URL via Website Content Crawler (max 1 page). Returns markdown+text for local parsing.
 */
export async function fetchOneUrlViaWebsiteContentCrawler(
  url: string,
  options: { debug?: boolean } = {},
): Promise<ApifyCrawledPageBlob | null> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) {
    dbg(options.debug, 'skip: APIFY_TOKEN is not set');
    return null;
  }

  const client = new ApifyClient({ token });

  const input = {
    startUrls: [{ url }],
    maxCrawlPages: 1,
    maxCrawlDepth: 0,
    crawlerType: 'playwright:firefox' as const,
  };

  dbg(options.debug, `actor=${WEBSITE_CONTENT_CRAWLER} startUrls[0]=${url}`);

  const run = await client.actor(WEBSITE_CONTENT_CRAWLER).call(input);

  dbg(options.debug, `run finished id=${run.id} status=${run.status}`);

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  const item = items[0] as Record<string, unknown> | undefined;
  if (!item) {
    dbg(options.debug, 'dataset empty');
    return null;
  }

  const text = typeof item.text === 'string' ? item.text : '';
  const markdown = typeof item.markdown === 'string' ? item.markdown : '';
  const crawl = item.crawl as Record<string, unknown> | undefined;
  const loadedUrl =
    (typeof item.url === 'string' && item.url) ||
    (typeof crawl?.loadedUrl === 'string' && crawl.loadedUrl) ||
    url;

  if (!text.trim() && !markdown.trim()) {
    dbg(options.debug, 'no text/markdown in first item');
    return null;
  }

  return { loadedUrl, markdown, text };
}
