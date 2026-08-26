/**
 * Environment configuration, validated eagerly.
 *
 * Every accessor throws on a missing value rather than degrading. A silently
 * absent `SQUIRREL_TOKEN` would make `authorization === "Bearer undefined"`
 * comparisons meaningful and could leave the API open; a silently absent Redis
 * URL surfaces much later as a mystery 500 from the first command.
 *
 * Values are read lazily (not at module load) so that unit tests can import
 * pure helpers from modules that happen to sit next to a route without needing
 * a full environment.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : undefined;
}

function int(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

/** Bearer token(s) the extension authenticates with. Two allow rotation. */
export function apiTokens(): string[] {
  const primary = required('SQUIRREL_TOKEN');
  const previous = optional('SQUIRREL_TOKEN_PREVIOUS');
  return previous ? [primary, previous] : [primary];
}

/** Secret Vercel Cron presents. Distinct from the extension token by design. */
export function cronSecret(): string {
  return required('CRON_SECRET');
}

export interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export function githubConfig(): GitHubConfig {
  return {
    owner: required('GITHUB_OWNER'),
    repo: required('GITHUB_REPO'),
    branch: optional('GITHUB_BRANCH') ?? 'master',
    token: required('GITHUB_TOKEN'),
  };
}

export interface RedisCredentials {
  url: string;
  token: string;
}

/**
 * The Vercel Marketplace Upstash integration injects `KV_REST_API_*`; a
 * hand-provisioned database gives `UPSTASH_REDIS_REST_*`. Accept either.
 * `REDIS_URL` / `KV_URL` are deliberately ignored — those are TCP `redis://`
 * URLs and the HTTP client cannot use them.
 */
export function redisCredentials(): RedisCredentials {
  const url = optional('UPSTASH_REDIS_REST_URL') ?? optional('KV_REST_API_URL');
  const token = optional('UPSTASH_REDIS_REST_TOKEN') ?? optional('KV_REST_API_TOKEN');
  if (!url || !token) {
    throw new Error(
      'Missing Redis credentials: set UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN ' +
        '(or KV_REST_API_URL/KV_REST_API_TOKEN). Note: REDIS_URL and KV_URL are TCP ' +
        'endpoints and cannot be used by the HTTP client.',
    );
  }
  return { url, token };
}

/** Origins echoed back for CORS. Only exercised before the extension has been
 *  granted a host permission — after that Chrome bypasses CORS entirely. */
export function allowedOrigins(): string[] {
  return (optional('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface FlushPolicy {
  /** Flush once this many links are buffered. */
  linkCount: number;
  /** Flush once the oldest buffered link is this old. */
  maxAgeMinutes: number;
}

export function flushPolicy(): FlushPolicy {
  return {
    linkCount: int('FLUSH_LINK_THRESHOLD', 5),
    maxAgeMinutes: int('FLUSH_MAX_AGE_MINUTES', 720),
  };
}

/**
 * Timing budget. The lock must outlive the function, otherwise two flushes can
 * build trees from the same base commit; the internal deadline must expire
 * before the platform kills us, so failures land on our own error path.
 */
export const TIMING = {
  /** Must exceed `maxDuration` in vercel.json (60s). */
  lockTtlMs: 90_000,
  /** AbortController budget spanning all GitHub calls in one flush. */
  githubDeadlineMs: 40_000,
  /** An in-flight claim older than this is treated as abandoned and recovered. */
  orphanMs: 180_000,
  /** How long a "you already saved this" hint is remembered. */
  seenTtlSeconds: 30 * 24 * 60 * 60,
  /** How long a client Idempotency-Key maps to its minted link id. */
  idempotencyTtlSeconds: 24 * 60 * 60,
} as const;
