/**
 * URL normalisation for dedupe keys.
 *
 * The normalised form is a comparison key and nothing else. The URL written
 * into the blog is always the byte-for-byte original: 291 URLs in the corpus
 * carry newsletter attribution (`utm_source=bonobopress&...`) that the author
 * has deliberately preserved across years of posts, and RFC 3986 §2.2 gives no
 * guarantee that dropping a query parameter is identity-preserving anyway.
 *
 * Two rules here are load-bearing and both are backed by URLs already in the
 * corpus:
 *
 *   - Only a denylist of tracking parameters is stripped, never the whole
 *     query. Dropping the query collapses 12+ distinct `youtube.com/watch`
 *     URLs — plus every DotNetRocks episode — into a single key.
 *   - `#foo` is dropped but `#!foo` and `#/foo` are kept. Two different
 *     love2dev.com articles are distinguished only by their hashbang and would
 *     otherwise both normalise to `love2dev.com`.
 */

import { createHash } from 'node:crypto';

/**
 * Exact parameter names stripped from the dedupe key. Any `utm_`-prefixed
 * parameter is stripped as well; see `isTrackingParam`.
 *
 * `source` is deliberately absent — it is load-bearing routing state on
 * several sites in the corpus.
 */
export const TRACKING_PARAMS: readonly string[] = [
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ck_subscriber_id',
  '_hsenc',
  '_hsmi',
  'hsCtaTracking',
  'at_medium',
  'at_campaign',
  'ref_src',
  'ref_url',
  'spm',
  'si',
  'feature',
];

const TRACKING_SET = new Set(TRACKING_PARAMS.map((p) => p.toLowerCase()));

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_SET.has(lower);
}

/** Dedupe key ONLY. The emitted URL is always the byte-for-byte original. */
export function normalizeUrl(raw: string): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed === '') return '';

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Callers hand us whatever the page gave them; a dedupe key is never worth
    // failing a request over.
    return trimmed.toLowerCase();
  }

  // Only http(s) get structural treatment. Anything else (mailto:, chrome:)
  // has no host/path/query shape worth canonicalising.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return trimmed.toLowerCase();
  }

  // http and https are the same document as far as dedupe is concerned; the
  // corpus has the same domains under both schemes across years.
  const scheme = 'http';

  const host = parsed.hostname.replace(/^www\./, '');

  // The scheme is collapsed, so both default ports have to go with it.
  const port = parsed.port === '80' || parsed.port === '443' ? '' : parsed.port;

  const path = parsed.pathname.replace(/\/$/, '');

  const params: Array<[string, string]> = [];
  for (const [key, value] of parsed.searchParams) {
    if (isTrackingParam(key)) continue;
    params.push([key, value]);
  }
  params.sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));
  const search = params.length
    ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';

  // `#!` is a hashbang route and `#/` a hash router: both address content.
  // A plain `#section` (or the `#.bgozig15l` Medium tracking noise) does not.
  const hash =
    parsed.hash.startsWith('#!') || parsed.hash.startsWith('#/') ? parsed.hash : '';

  return `${scheme}://${host}${port ? `:${port}` : ''}${path}${search}${hash}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** sha256 hex of the normalised form. Used as the `squirrel:seen:` key suffix. */
export function urlKey(raw: string): string {
  return createHash('sha256').update(normalizeUrl(raw), 'utf8').digest('hex');
}
