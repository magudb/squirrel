/**
 * The Upstash client, built once per warm instance.
 *
 * `Redis.fromEnv()` is deliberately not used. It only `console.warn`s when the
 * credentials are absent and then fails at the first command with a message that
 * reads like an outage rather than a misconfiguration; it also cannot see a
 * Vercel Custom Prefix, which renames the injected variables. `redisCredentials()`
 * throws instead, so a bad deploy fails on its first request with an actionable
 * error.
 *
 * Construction is lazy for the same reason the accessors in `env.ts` are: a unit
 * test importing a pure helper from a module that happens to also touch Redis
 * should not need a live database in its environment.
 */

import { Redis } from '@upstash/redis';
import { redisCredentials } from './env.js';

let client: Redis | undefined;

export function getRedis(): Redis {
  if (!client) {
    const { url, token } = redisCredentials();
    client = new Redis({
      url,
      token,
      // The default of 5 retries with exp(n)*50ms backoff sleeps ~11.7s before
      // giving up, which on its own can exceed the function's `maxDuration` and
      // turn a transient blip into a platform kill. Fail fast; the caller (or the
      // next cron tick) retries with the buffer still intact.
      retry: { retries: 2, backoff: (n) => Math.min(1000, 50 * 2 ** n) },
    });
  }
  return client;
}
