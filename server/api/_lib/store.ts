/**
 * The Redis buffer — everything that has to outlive a single request.
 *
 * Two rules run through this whole file and are easy to undo by accident:
 *
 * 1. Never `JSON.stringify` on the way in and never `JSON.parse` on the way out.
 *    The client serialises objects itself and parses every value it reads back,
 *    so a pre-stringified write is a silent no-op and `JSON.parse(await get(k))`
 *    throws on an object it was handed already-parsed.
 * 2. ZSET members are plain string ids; payloads live in their own keys. `zrem`
 *    matches on exact serialised bytes, so a member added as an object `{id, url}`
 *    can never be removed as `{url, id}` — same data, different key order.
 */

import { createHash, randomBytes } from 'node:crypto';
import { TIMING } from './env.js';
import { getRedis } from './redis.js';
import type { LastFlush, PendingLink, TargetDraft } from './types.js';

const PENDING_KEY = 'squirrel:pending';
const TARGET_KEY = 'squirrel:target';
const LAST_FLUSH_KEY = 'squirrel:lastflush';
const CLAIM_PREFIX = 'squirrel:inflight:';

/** Window the per-IP auth failure counter is measured over. */
const AUTH_FAIL_WINDOW_SECONDS = 60;

const linkKey = (id: string): string => `squirrel:link:${id}`;
const claimKey = (flushId: string): string => `${CLAIM_PREFIX}${flushId}`;
const idemKey = (key: string): string => `squirrel:idem:${key}`;
const authFailKey = (ip: string): string => `squirrel:authfail:${ip}`;
const seenKey = (normalizedUrl: string): string =>
  `squirrel:seen:${createHash('sha256').update(normalizedUrl).digest('hex')}`;

/**
 * Ids are prefixed because the client JSON.parses everything it reads: an id of
 * `"1756200000000"` would come back from `get` or `zrange` as a *number* and
 * quietly falsify every `typeof id === 'string'` check downstream.
 */
export function newLinkId(): string {
  return `lnk_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

/** The timestamp is parsed back out by the orphan sweep, so this shape is load-bearing. */
export function newFlushId(): string {
  return `flush_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function flushIdStartedAt(flushId: string): number | null {
  const match = /^flush_([0-9a-z]+)_[0-9a-f]{8}$/.exec(flushId);
  if (match === null) return null;
  const startedAt = Number.parseInt(match[1], 36);
  return Number.isSafeInteger(startedAt) && startedAt > 0 ? startedAt : null;
}

/** Coerces members back to strings; see the id-prefix note above. */
function memberIds(members: (string | number)[]): string[] {
  return members.map((member) => String(member));
}

/** `mget` answers with already-parsed objects. Dropping the nulls also drops any
 *  member whose payload has been deleted out from under it. */
async function hydrate(ids: string[]): Promise<PendingLink[]> {
  if (ids.length === 0) return [];
  const rows = await getRedis().mget<(PendingLink | null)[]>(...ids.map(linkKey));
  return rows.filter((row): row is PendingLink => row !== null);
}

export async function enqueue(link: PendingLink): Promise<number> {
  // Payload before index entry: a half-applied write then leaves an unreferenced
  // payload (inert) rather than an index member with no payload, whose score
  // would satisfy the age trigger forever.
  const results = await getRedis()
    .multi()
    .set(linkKey(link.id), link)
    .zadd(PENDING_KEY, { score: link.addedAt, member: link.id })
    .zcard(PENDING_KEY)
    .exec<['OK', number | null, number]>();
  return results[2];
}

export async function listPending(limit = 100, offset = 0): Promise<PendingLink[]> {
  const members = await getRedis().zrange<(string | number)[]>(PENDING_KEY, '-inf', '+inf', {
    byScore: true,
    offset,
    count: limit,
  });
  return hydrate(memberIds(members));
}

export async function countPending(): Promise<number> {
  return getRedis().zcard(PENDING_KEY);
}

export async function oldestPendingAgeMs(): Promise<number | null> {
  const oldest = await getRedis().zrange<(string | number)[]>(PENDING_KEY, '-inf', '+inf', {
    byScore: true,
    offset: 0,
    count: 1,
    withScores: true,
  });
  // `withScores` answers with a flat [member, score, ...] array, not with pairs.
  if (oldest.length < 2) return null;
  return Date.now() - Number(oldest[1]);
}

export async function getLink(id: string): Promise<PendingLink | null> {
  return getRedis().get<PendingLink>(linkKey(id));
}

/** Rewrites the payload only. The index is untouched, so an edit cannot reorder
 *  the buffer or reset the age that drives the flush trigger. */
export async function putLink(link: PendingLink): Promise<void> {
  await getRedis().set(linkKey(link.id), link);
}

export async function removeLinks(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // Index member first. The other order leaves a member whose payload is gone —
  // a permanent tombstone whose score keeps answering "the oldest link is older
  // than the max age", i.e. a flush loop that can never make progress.
  await getRedis()
    .multi()
    .zrem(PENDING_KEY, ...ids)
    .del(...ids.map(linkKey))
    .exec();
}

/** RENAME on a missing key is Redis saying "nothing to flush", not a fault. */
function isNoSuchKey(err: unknown): boolean {
  return err instanceof Error && /no such key/i.test(err.message);
}

/**
 * Takes the whole buffer in one atomic step.
 *
 * RENAME leaves a fresh, empty `squirrel:pending` behind, so a link POSTed while
 * the flush is running lands in the new buffer. Draining with ZRANGE and then
 * ZREM instead would delete exactly those links without ever committing them —
 * silent loss, and only under the bursty saving the whole system is built for.
 */
export async function claimPending(flushId: string): Promise<PendingLink[] | null> {
  const redis = getRedis();
  const claim = claimKey(flushId);

  try {
    await redis.rename(PENDING_KEY, claim);
  } catch (err) {
    if (isNoSuchKey(err)) return null;
    throw err;
  }

  const ids = memberIds(
    await redis.zrange<(string | number)[]>(claim, '-inf', '+inf', { byScore: true }),
  );
  const rows =
    ids.length === 0
      ? []
      : await redis.mget<(PendingLink | null)[]>(...ids.map(linkKey));

  const orphaned = ids.filter((_, index) => rows[index] === null);
  if (orphaned.length > 0) {
    // Drop payload-less members here, or `returnToPending` merges them back into
    // the buffer as tombstones that nothing can ever clear.
    await redis.zrem(claim, ...orphaned);
  }

  const links = rows.filter((row): row is PendingLink => row !== null);
  if (links.length === 0) {
    await redis.del(claim);
    return null;
  }
  return links;
}

/**
 * Merges a claim — or a named subset of it — back into the buffer.
 *
 * Called when a flush fails outright, when individual links turn out to be
 * unroutable, and by the orphan sweep. Re-merging links that did in fact commit
 * is safe: the flush dedupes against the draft's own content, not against Redis.
 */
export async function returnToPending(flushId: string, ids?: string[]): Promise<void> {
  const redis = getRedis();
  const claim = claimKey(flushId);

  if (ids === undefined) {
    // AGGREGATE MIN keeps each member's original addedAt. A link re-POSTed while
    // we held the claim already sits in pending under a newer score, and the
    // older one is the honest answer for the age trigger.
    await redis.zunionstore(PENDING_KEY, 2, [PENDING_KEY, claim], { aggregate: 'min' });
    await redis.del(claim);
    return;
  }
  if (ids.length === 0) return;

  const scoreQuery = redis.pipeline();
  for (const id of ids) scoreQuery.zscore(claim, id);
  const [scores, payloads] = await Promise.all([
    scoreQuery.exec<(number | null)[]>(),
    redis.mget<(PendingLink | null)[]>(...ids.map(linkKey)),
  ]);

  // A member we cannot date lost its score with the claim; treating it as new
  // only delays its age trigger, whereas dropping it would lose the link. One we
  // have no payload for is a different matter — putting that back would seed the
  // buffer with a tombstone nothing can clear.
  const now = Date.now();
  const restored = ids
    .map((id, index) => ({ score: scores[index] ?? now, member: id }))
    .filter((_, index) => payloads[index] !== null);

  if (restored.length === 0) {
    await redis.zrem(claim, ...ids);
    return;
  }

  const [first, ...rest] = restored;
  // Buffer first, claim second: dying in between leaves the ids in both, and the
  // sweep's MIN merge then resolves to the same score.
  await redis
    .multi()
    .zadd(PENDING_KEY, first, ...rest)
    .zrem(claim, ...ids)
    .exec();
}

/** The success path: the links are in the commit, so both they and the claim go. */
export async function discardClaim(flushId: string, ids: string[]): Promise<void> {
  // A single DEL, so the claim can never outlive the payloads it names. Deleting
  // payloads first and dying would leave the sweep a claim full of tombstones.
  await getRedis().del(claimKey(flushId), ...ids.map(linkKey));
}

/**
 * Returns claims abandoned by a flush that died — the timeout case, and the case
 * where the GitHub ref PATCH never answered so nobody knows whether it landed.
 * Answers with the number of claims recovered.
 */
export async function sweepOrphanClaims(olderThanMs: number): Promise<number> {
  const redis = getRedis();
  const cutoff = Date.now() - olderThanMs;
  const visited = new Set<string>();
  let cursor = '0';
  let recovered = 0;

  do {
    // SCAN, never KEYS: KEYS blocks the server for the length of the key space.
    const [next, keys] = await redis.scan(cursor, { match: `${CLAIM_PREFIX}*`, count: 100 });
    cursor = String(next);

    for (const key of keys) {
      // SCAN can hand back the same key on more than one iteration.
      if (visited.has(key)) continue;
      visited.add(key);

      const flushId = key.slice(CLAIM_PREFIX.length);
      const startedAt = flushIdStartedAt(flushId);
      // A claim we cannot date is treated as abandoned: stranding it loses its
      // links permanently, while re-merging them is idempotent.
      if (startedAt !== null && startedAt > cutoff) continue;

      await returnToPending(flushId);
      recovered += 1;
    }
  } while (cursor !== '0');

  return recovered;
}

export async function getTarget(): Promise<TargetDraft | null> {
  return getRedis().get<TargetDraft>(TARGET_KEY);
}

export async function setTarget(t: TargetDraft | null): Promise<void> {
  if (t === null) {
    await getRedis().del(TARGET_KEY);
    return;
  }
  await getRedis().set(TARGET_KEY, t);
}

export async function getLastFlush(): Promise<LastFlush | null> {
  return getRedis().get<LastFlush>(LAST_FLUSH_KEY);
}

export async function setLastFlush(f: LastFlush): Promise<void> {
  await getRedis().set(LAST_FLUSH_KEY, f);
}

/** A UX hint ("you saved this before"), never a correctness gate: this cache has
 *  never seen the links already published in the blog, and it is evictable. */
export async function rememberSeen(normalizedUrl: string, linkId: string): Promise<void> {
  await getRedis().set(seenKey(normalizedUrl), linkId, { ex: TIMING.seenTtlSeconds });
}

export async function lookupSeen(normalizedUrl: string): Promise<string | null> {
  const id = await getRedis().get<string>(seenKey(normalizedUrl));
  return id === null ? null : String(id);
}

export async function lookupIdempotency(key: string): Promise<string | null> {
  const id = await getRedis().get<string>(idemKey(key));
  return id === null ? null : String(id);
}

/** NX so the first writer wins: a client replaying its outbox has to keep
 *  resolving to the link id it was given the first time. */
export async function rememberIdempotency(key: string, linkId: string): Promise<void> {
  await getRedis().set(idemKey(key), linkId, { ex: TIMING.idempotencyTtlSeconds, nx: true });
}

export async function bumpAuthFailures(ip: string): Promise<number> {
  const key = authFailKey(ip);
  // The TTL is re-armed on every failure, so a caller that keeps hammering stays
  // counted; the window clears only once it stops for a minute.
  const [failures] = await getRedis()
    .multi()
    .incr(key)
    .expire(key, AUTH_FAIL_WINDOW_SECONDS)
    .exec<[number, 0 | 1]>();
  return failures;
}
