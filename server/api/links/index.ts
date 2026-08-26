import type { VercelRequest, VercelResponse } from '@vercel/node';
import { DEFAULT_CATEGORY_ID, isValidCategoryId } from '../_lib/categories.js';
import { flushPolicy, type FlushPolicy } from '../_lib/env.js';
import { HttpError, firstQuery, methods, readJsonBody, withApiAuth } from '../_lib/http.js';
import {
  countPending,
  enqueue,
  getLink,
  getTarget,
  listPending,
  lookupIdempotency,
  lookupSeen,
  newLinkId,
  oldestPendingAgeMs,
  rememberIdempotency,
  rememberSeen,
} from '../_lib/store.js';
import type { PendingLink } from '../_lib/types.js';
import { normalizeUrl } from '../_lib/urlnorm.js';

/**
 * Bullet text ultimately comes from one of these three fields, so all three are
 * capped and cleaned here rather than in the formatter — this is the only place
 * the values cross from the network into storage.
 */
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 300;
const MAX_SELECTED_TEXT = 500;
const MAX_SOURCE = 40;

const DEFAULT_LIMIT = 100;
/** A 500-link page is ~150KB of JSON, comfortably under the 4.5MB body cap. */
const MAX_LIMIT = 500;

/** Bounded because the value is concatenated into a `squirrel:idem:` key. */
const MAX_IDEMPOTENCY_KEY = 200;

/**
 * The description reaching this handler is an AI summary of a page nobody in
 * this system wrote, and it lands verbatim in a markdown bullet in the blog.
 * Angle brackets go, whitespace collapses, length is bounded — a page that
 * prompt-injects its own summary then has nothing left to inject with.
 */
function sanitizeText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * Every character `new URL()` would silently rewrite rather than preserve:
 * it deletes tabs, newlines and CRs outright, percent-encodes the other
 * controls along with space, `<`, `>` and the quotes, and turns `\` into `/`
 * for a special scheme. What lands in the bullet is the raw string, so any of
 * these would reach the draft having never been seen by the validator — a
 * newline splits one bullet across several physical lines and `<script>` then
 * renders verbatim on the published page.
 */
const ILLEGAL_URL_CHAR = /[\s<>"'\\\u0000-\u001f\u007f]/;

/**
 * Shared by POST and PATCH so an edit cannot smuggle in what a create rejects.
 *
 * Rejects rather than canonicalising. Returning `parsed.href` would close the
 * same hole, but it rewrites innocent URLs too — a bare host grows a trailing
 * slash, the query comes back re-encoded — and this blog publishes the link the
 * user actually saw, tracking parameters and all. Rejecting keeps that promise
 * byte-for-byte and still guarantees the stored string is the one that was
 * validated.
 */
export function requireUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HttpError(400, 'A url is required', 'bad_url');
  }
  const url = raw.trim();
  // Before the parse, so the error names the real problem: `new URL()` would
  // strip these and then report a perfectly clean URL.
  if (ILLEGAL_URL_CHAR.test(url)) {
    throw new HttpError(400, 'url contains an illegal character', 'bad_url');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, 'url must be an absolute URL', 'bad_url');
  }
  // Anything else — javascript:, data:, file: — has no business in a bullet.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(400, 'url must be http or https', 'bad_url');
  }
  // Stored as given: newsletter attribution is part of the published link, and
  // normalisation happens only when deriving a dedupe key.
  return url;
}

export function requireTitle(raw: unknown): string {
  const title = sanitizeText(raw, MAX_TITLE);
  if (title === '') {
    throw new HttpError(400, 'A non-empty title is required', 'bad_title');
  }
  return title;
}

/**
 * An unknown category falls back rather than failing the request: the link is
 * already captured at this point, and losing it over a stale category id in an
 * extension that has not been reloaded is a worse outcome than filing it under
 * the default section, which the user can fix with a PATCH.
 */
export function resolveCategory(raw: unknown): string {
  return isValidCategoryId(raw) ? raw : DEFAULT_CATEGORY_ID;
}

export function optionalDescription(raw: unknown): string | undefined {
  return sanitizeText(raw, MAX_DESCRIPTION) || undefined;
}

function idempotencyKey(req: VercelRequest): string | undefined {
  const raw = firstQuery(req.headers['idempotency-key']);
  const key = raw === undefined ? '' : raw.trim();
  if (key === '') return undefined;
  if (key.length > MAX_IDEMPOTENCY_KEY || /[^\x21-\x7e]/.test(key)) {
    throw new HttpError(400, 'Idempotency-Key must be a short opaque token', 'bad_idempotency_key');
  }
  return key;
}

/**
 * The extension's service worker acts on this by issuing a separate
 * POST /api/flush. This route never calls GitHub itself — the popup that
 * triggers it is destroyed the moment it loses focus, taking any in-flight
 * request with it, so the save has to be over in one Redis round trip.
 *
 * Shared with GET /api/status so the two can never give the extension
 * contradictory advice about the same buffer.
 */
export function suggestsFlush(
  pendingCount: number,
  oldestAgeMs: number | null,
  policy: FlushPolicy,
): boolean {
  if (pendingCount === 0) return false;
  if (pendingCount >= policy.linkCount) return true;
  return oldestAgeMs !== null && oldestAgeMs >= policy.maxAgeMinutes * 60_000;
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new HttpError(400, `Expected an integer of at least ${min}, got: ${raw}`, 'bad_query');
  }
  return Math.min(parsed, max);
}

/**
 * Paginated because the platform truncates a response body over 4.5MB with a
 * platform error rather than anything this service can explain — a buffer that
 * ran away while a flush was failing would then be unreadable exactly when the
 * user needs to look at it.
 */
async function list(req: VercelRequest, res: VercelResponse): Promise<void> {
  const limit = boundedInt(firstQuery(req.query.limit), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = boundedInt(firstQuery(req.query.offset), 0, 0, Number.MAX_SAFE_INTEGER);
  const [links, total] = await Promise.all([listPending(limit, offset), countPending()]);
  res.status(200).json({ links, total });
}

async function create(req: VercelRequest, res: VercelResponse): Promise<void> {
  const body = readJsonBody(req);
  const url = requireUrl(body.url);
  const title = requireTitle(body.title);
  const key = idempotencyKey(req);
  const policy = flushPolicy();
  const normalized = normalizeUrl(url);

  const [existingId, seenId, target, oldestAgeMs] = await Promise.all([
    key === undefined ? Promise.resolve(null) : lookupIdempotency(key),
    lookupSeen(normalized),
    getTarget(),
    // Read before the enqueue on purpose: this link's own score is `now`, so it
    // can never become the oldest, which makes the pre-enqueue answer the same
    // as the post-enqueue one and saves a round trip on the save path.
    oldestPendingAgeMs(),
  ]);

  if (existingId !== null) {
    const [existing, pendingCount] = await Promise.all([getLink(existingId), countPending()]);
    // A key resolving to a link the buffer no longer holds means a flush has
    // already taken it. Falling through and enqueueing again is safe because
    // the flush dedupes against the draft's own content, and there is no
    // earlier link left to hand back.
    if (existing !== null) {
      res.status(202).json({
        link: existing,
        pendingCount,
        flushSuggested: suggestsFlush(pendingCount, oldestAgeMs, policy),
      });
      return;
    }
  }

  // Server-minted. A client-supplied id would name a `squirrel:link:` key and
  // could overwrite somebody else's buffered link; the client's own id travels
  // in the Idempotency-Key header instead.
  const link: PendingLink = {
    id: newLinkId(),
    url,
    title,
    category: resolveCategory(body.category),
    addedAt: Date.now(),
  };
  const description = optionalDescription(body.description);
  if (description !== undefined) link.description = description;
  const selectedText = sanitizeText(body.selectedText, MAX_SELECTED_TEXT);
  if (selectedText !== '') link.selectedText = selectedText;
  const source = sanitizeText(body.source, MAX_SOURCE);
  link.source = source !== '' ? source : 'extension';
  // Audit only. The flush resolves the destination from the global target, so a
  // draft published between the save and the flush cannot strand this link.
  if (target !== null) link.targetSnapshot = target.path;

  const pendingCount = await enqueue(link);

  // After the enqueue: a hint written for a link that failed to buffer would
  // report a duplicate that does not exist.
  await Promise.all([
    rememberSeen(normalized, link.id),
    key === undefined ? Promise.resolve() : rememberIdempotency(key, link.id),
  ]);

  const payload: {
    link: PendingLink;
    pendingCount: number;
    flushSuggested: boolean;
    duplicate?: boolean;
  } = {
    link,
    pendingCount,
    flushSuggested: suggestsFlush(pendingCount, oldestAgeMs, policy),
  };
  // A hint, never a gate: this cache has never seen the links already published
  // in the blog, and the user may well want the same URL in two digests.
  if (seenId !== null) payload.duplicate = true;

  res.status(202).json(payload);
}

export default withApiAuth(methods({ GET: list, POST: create }));
