/**
 * HTTP plumbing shared by every route: CORS, bearer auth and the error funnel.
 *
 * Auth is a per-handler wrapper rather than a path prefix check because
 * Vercel's zero-config routing also exposes the raw source paths — both
 * `/api/links` and `/api/links/index.ts` are live URLs — so any rule keyed on
 * the request path has a second, unguarded spelling of every endpoint.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { allowedOrigins, apiTokens, cronSecret } from './env.js';
import { bumpAuthFailures } from './store.js';

export type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void> | void;

/** An error with a status the client is allowed to see. */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** The user agent Vercel Cron identifies itself with. */
const CRON_USER_AGENT = 'vercel-cron/1.0';

/** Failed auth attempts allowed per IP per minute before the answer becomes 429. */
const AUTH_FAILURE_LIMIT = 20;

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

/**
 * `Access-Control-Allow-Headers: *` does not cover `Authorization` — the
 * wildcard explicitly excludes it — so every header the extension sends has to
 * be named. `Idempotency-Key` rides along on `POST /api/links`.
 */
const ALLOWED_HEADERS = 'Authorization, Content-Type, Idempotency-Key';

/**
 * Chromium clamps the preflight cache to 7200s; anything larger is silently
 * reduced to it. With no header at all the cache is 5s, i.e. a preflight on
 * essentially every request.
 */
const PREFLIGHT_MAX_AGE = '7200';

/**
 * Exported for `/api/health`, which needs the headers without the auth.
 *
 * The wildcard origin is safe here only because nothing in this service reads
 * cookies: `fetch` defaults to `credentials: 'same-origin'`, and a hand-set
 * `Authorization` header is not a CORS credential. Setting
 * `Access-Control-Allow-Credentials` would both invalidate the wildcard and
 * force us to echo an unstable `chrome-extension://<id>` origin.
 */
export function applyCors(req: VercelRequest, res: VercelResponse): void {
  const origin = req.headers.origin;
  const configured = allowedOrigins();
  res.setHeader(
    'Access-Control-Allow-Origin',
    origin && configured.includes(origin) ? origin : '*',
  );
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
}

/** Answers a preflight. Returns true when the request is finished. */
function handlePreflight(req: VercelRequest, res: VercelResponse): boolean {
  if (req.method !== 'OPTIONS') return false;
  applyCors(req, res);
  res.status(204).end();
  return true;
}

/**
 * Compares SHA-256 digests rather than the raw tokens: `timingSafeEqual`
 * throws when its inputs differ in length, which would both leak the expected
 * token's length and turn a short guess into a 500 instead of a 401. Digests
 * are always 32 bytes.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The token is only ever read from the header — Vercel logs request URLs. */
function bearerToken(req: VercelRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1]! : null;
}

async function authenticateApi(req: VercelRequest): Promise<void> {
  const presented = bearerToken(req);
  // Every configured token is accepted so a rotation is not a flag day.
  if (presented && apiTokens().some((token) => tokenMatches(presented, token))) return;

  let failures = 0;
  try {
    failures = await bumpAuthFailures(clientIp(req));
  } catch (err) {
    // A counter outage must not upgrade a 401 into a 500.
    console.error('auth failure counter unavailable', err);
  }
  if (failures > AUTH_FAILURE_LIMIT) {
    throw new HttpError(429, 'Too many failed authentication attempts', 'rate_limited');
  }
  throw new HttpError(401, 'Unauthorized', 'unauthorized');
}

/** Anything carrying a numeric `status` came back from GitHub, not from us. */
function isUpstreamError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  );
}

function sendError(res: VercelResponse, err: unknown): void {
  if (res.headersSent || res.writableEnded) {
    // The handler already answered; all that is left is to make the failure
    // visible in the function log.
    console.error('error raised after the response was sent', err);
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json(err.code ? { error: err.message, code: err.code } : { error: err.message });
    return;
  }
  if (isUpstreamError(err)) {
    console.error('upstream GitHub failure', err);
    res.status(502).json({ error: 'Upstream GitHub request failed', code: 'upstream_error' });
    return;
  }
  // Generic on the wire, specific in the log — an internal message can carry a
  // path, a token fragment or a stack.
  console.error('unhandled error', err);
  res.status(500).json({ error: 'Internal server error', code: 'internal_error' });
}

async function guard(res: VercelResponse, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * CORS + preflight + bearer auth + error funnel.
 *
 * The preflight is answered before the auth check: a browser preflight carries
 * no `Authorization` header, so a 401 there kills the real request before it is
 * ever sent.
 */
export function withApiAuth(handler: Handler): Handler {
  return async (req, res) => {
    if (handlePreflight(req, res)) return;
    applyCors(req, res);
    await guard(res, async () => {
      await authenticateApi(req);
      await handler(req, res);
    });
  };
}

/**
 * CORS + preflight + `CRON_SECRET` auth + `vercel-cron/1.0` assert.
 *
 * Deliberately shares nothing with `withApiAuth`: both schemes travel in the
 * `Authorization` header, and a wrapper that accepted either would let an
 * extension token drive the flush cron (and would 401 the real cron forever,
 * silently, because Vercel never retries a cron and does not surface failures).
 */
export function withCronAuth(handler: Handler): Handler {
  return async (req, res) => {
    if (handlePreflight(req, res)) return;
    applyCors(req, res);
    await guard(res, async () => {
      const presented = bearerToken(req);
      const userAgent = req.headers['user-agent'];
      if (
        !presented ||
        userAgent !== CRON_USER_AGENT ||
        !tokenMatches(presented, cronSecret())
      ) {
        throw new HttpError(401, 'Unauthorized', 'unauthorized');
      }
      await handler(req, res);
    });
  };
}

/** Dispatch by method; responds 405 with an Allow header for anything unlisted. */
export function methods(
  map: Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', Handler>>,
): Handler {
  const allow = [...Object.keys(map), 'OPTIONS'].join(', ');
  return async (req, res) => {
    // Normally an auth wrapper has already answered the preflight; this branch
    // only fires on a route that opted out of one, such as /api/health.
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', allow);
      res.status(204).end();
      return;
    }
    const handler = map[req.method as keyof typeof map];
    if (!handler) {
      res.setHeader('Allow', allow);
      res.status(405).json({
        error: `Method ${req.method ?? 'unknown'} not allowed`,
        code: 'method_not_allowed',
      });
      return;
    }
    await handler(req, res);
  };
}

/**
 * `req.body` is a lazy getter that parses on first access and *throws* on
 * malformed JSON. Read untouched it produces an unhandled 500 for what is
 * plainly a client mistake.
 */
export function readJsonBody(req: VercelRequest): Record<string, unknown> {
  let body: unknown;
  try {
    body = req.body;
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON', 'invalid_json');
  }
  if (body === undefined || body === null || body === '') return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object', 'invalid_body');
  }
  return body as Record<string, unknown>;
}

/** Dynamic route segments and repeated query keys both arrive as arrays. */
export function firstQuery(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * `x-forwarded-for` is a client-to-proxy chain; the leftmost entry is the
 * original caller. Only used to key a rate-limit counter, never to authorise.
 */
export function clientIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(',')[0]?.trim();
  if (first) return first;
  return req.socket?.remoteAddress ?? 'unknown';
}
