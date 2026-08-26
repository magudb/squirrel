/**
 * A best-effort mutex over a Redis key.
 *
 * The lock exists to stop two flushes building a git tree from the same base
 * commit and burning a 422 rebuild against each other. It is explicitly NOT
 * load-bearing for correctness: the claim protocol in `store.ts` plus the
 * content-level dedupe at flush time already make a duplicated flush harmless.
 * That is why there is no renewal heartbeat here — the TTL simply has to outlive
 * the function (see `TIMING.lockTtlMs` vs `maxDuration`), and if a holder dies
 * the next invocation picks up after the key expires.
 */

import { randomUUID } from 'node:crypto';
import { getRedis } from './redis.js';

/**
 * Compare-and-delete. A plain DEL would eventually free a lock that a *different*
 * invocation acquired in the window after ours expired — which is exactly what a
 * cron flush racing an extension-triggered flush produces.
 */
const RELEASE_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';

export async function acquireLock(key: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID();
  // SET NX answers with the string "OK" on success and null on contention. Test
  // for "OK" rather than truthiness — `set` can legitimately resolve to stored
  // data when other options are in play.
  const result = await getRedis().set(key, token, { nx: true, px: ttlMs });
  return result === 'OK' ? token : null;
}

export async function releaseLock(key: string, token: string): Promise<boolean> {
  const freed = await getRedis().eval<[string], number>(RELEASE_SCRIPT, [key], [token]);
  return freed === 1;
}

export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | 'locked'> {
  const token = await acquireLock(key, ttlMs);
  if (token === null) return 'locked';
  try {
    return await fn();
  } finally {
    // Swallowed on purpose: a throw here would replace whatever `fn` was doing
    // with a lock-keeping error, and the TTL frees the key anyway.
    try {
      await releaseLock(key, token);
    } catch (err) {
      console.warn(`[squirrel] failed to release lock ${key}`, err);
    }
  }
}
