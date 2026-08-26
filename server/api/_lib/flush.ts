/**
 * Turning the Redis buffer into one commit in the target draft.
 *
 * The correctness argument is not the lock and not the claim protocol: it is
 * that every attempt re-reads the draft and drops any link whose normalised URL
 * already appears in it. That makes a flush idempotent against the file itself,
 * so a double cron fire, a lost Redis delete, a 422 rebuild and a ref update
 * that never answered all converge on the same content. The lock only saves
 * wasted work; the claim only stops links POSTed mid-flush from being dropped.
 *
 * Nothing here throws. A failed flush is reported as a `FlushResult` with
 * `ok: false`, because the route answers 200 either way — a 5xx would make the
 * extension's outbox re-enqueue links that are still safely buffered.
 */

import { anchorForCategory } from './categories.js';
import { TIMING } from './env.js';
import { commitWithRetry, commitsTouching, readFile } from './github.js';
import { withLock } from './lock.js';
import { existingUrlKeys, formatLink, hasSection, insertLink } from './markdown.js';
import { assertWritablePath } from './paths.js';
import {
  claimPending,
  discardClaim,
  getTarget,
  newFlushId,
  returnToPending,
  setLastFlush,
  sweepOrphanClaims,
} from './store.js';
import type { FlushReason, FlushResult, LastFlush, PendingLink } from './types.js';
import { normalizeUrl } from './urlnorm.js';

/** Shared with publish, so the two can never interleave on the same draft. */
export const FLUSH_LOCK_KEY = 'squirrel:lock:flush';

/** Budget for the "did my commit land?" question, which is asked after the main
 *  GitHub deadline has already been spent. */
const LANDED_CHECK_MS = 5_000;

export interface FoldOutcome {
  content: string;
  /** Links written into `content`. */
  committedIds: string[];
  /** Links the draft already contained. */
  skippedIds: string[];
  /** Links whose category has no section in the draft. */
  unroutableIds: string[];
}

/**
 * Apply buffered links to a draft in memory.
 *
 * `content` must be the file as it stands right now — this function is the
 * whole dedupe, and it is only worth anything against a fresh read.
 */
export function foldLinks(content: string, links: PendingLink[]): FoldOutcome {
  const seen = existingUrlKeys(content, normalizeUrl);
  const committedIds: string[] = [];
  const skippedIds: string[] = [];
  const unroutableIds: string[] = [];
  let next = content;

  for (const link of links) {
    const key = normalizeUrl(link.url);
    // `seen` grows as we go: one buffer can hold the same article twice, saved
    // from two newsletters carrying two different `utm_source` values.
    if (seen.has(key)) {
      skippedIds.push(link.id);
      continue;
    }
    const anchor = anchorForCategory(link.category);
    // A draft the user wrote by hand need not carry every section, and writing
    // the link into some other one would hide it.
    if (!hasSection(next, anchor)) {
      unroutableIds.push(link.id);
      continue;
    }
    next = insertLink(next, anchor, formatLink(link));
    seen.add(key);
    committedIds.push(link.id);
  }

  return { content: next, committedIds, skippedIds, unroutableIds };
}

export type LandedCommit = { sha: string } | 'absent' | 'unknown';

/**
 * Answer "did my commit land?" after a failure that could have gone either way.
 *
 * A ref update that never answered leaves no local evidence at all, which is
 * why the flush id is stamped into the commit message. `unknown` means GitHub
 * could not be reached to ask — the one case where the claim has to be left
 * alone rather than reasoned about.
 */
export async function commitLanded(path: string, flushId: string): Promise<LandedCommit> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error('landing check timed out')),
    LANDED_CHECK_MS,
  );
  try {
    const commits = await commitsTouching(path, 5, controller.signal);
    const landed = commits.find((commit) => commit.message.includes(flushId));
    return landed === undefined ? 'absent' : { sha: landed.sha };
  } catch (err) {
    console.warn('[squirrel] could not confirm whether the commit landed', err);
    return 'unknown';
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Release a claim once the commit is confirmed.
 *
 * Unroutable links go back to the buffer *before* the claim is discarded:
 * `discardClaim` deletes the claim key itself, and that key holds the scores
 * that are the links' original `addedAt`. The other order would, if we died
 * between the two calls, leave those payloads with no index entry at all —
 * links that still exist in Redis but that nothing can ever find again.
 */
export async function settleClaim(flushId: string, folded: FoldOutcome): Promise<void> {
  await returnToPending(flushId, folded.unroutableIds);
  await discardClaim(flushId, [...folded.committedIds, ...folded.skippedIds]);
}

function result(
  flushId: string,
  ok: boolean,
  reason: FlushReason,
  extra: Partial<FlushResult> = {},
): FlushResult {
  return { ok, reason, flushId, committed: 0, skipped: 0, unroutable: 0, ...extra };
}

function counts(folded: FoldOutcome): Partial<FlushResult> {
  return {
    committed: folded.committedIds.length,
    skipped: folded.skippedIds.length,
    unroutable: folded.unroutableIds.length,
  };
}

/**
 * `squirrel:lastflush` is observability only. It is written for anything that
 * actually took the buffer, and deliberately not for `locked` or `empty` — a
 * cron tick with nothing to do would otherwise erase the record of the last
 * real batch, which is the one someone wants to see on `/api/status`.
 */
async function record(entry: FlushResult): Promise<FlushResult> {
  const last: LastFlush = {
    at: Date.now(),
    flushId: entry.flushId,
    reason: entry.reason,
    committed: entry.committed,
    skipped: entry.skipped,
    unroutable: entry.unroutable,
    commitSha: entry.commitSha,
    error: entry.error,
  };
  try {
    await setLastFlush(last);
  } catch (err) {
    console.warn('[squirrel] could not record the last flush', err);
  }
  return entry;
}

async function flushClaimed(flushId: string): Promise<FlushResult> {
  const claimed = await claimPending(flushId);
  if (claimed === null) return result(flushId, true, 'empty');

  const target = await getTarget();
  if (target === null) {
    // Fail loudly with the buffer intact. Dropping the batch, or guessing at a
    // draft to write it into, are both worse than an error the user can act on.
    await returnToPending(flushId);
    return record(
      result(flushId, false, 'no-target', {
        error: 'No target draft is set. Choose one with PUT /api/target.',
      }),
    );
  }

  // One deadline across every GitHub call, so a slow GitHub fails on our own
  // error path — where the claim survives — instead of being killed mid-commit
  // by the platform.
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error(`GitHub did not answer within ${TIMING.githubDeadlineMs}ms`)),
    TIMING.githubDeadlineMs,
  );
  const state: { folded: FoldOutcome | null } = { folded: null };

  try {
    assertWritablePath(target.path);

    const commitSha = await commitWithRetry(
      async () => {
        // Re-read on every attempt: a 422 means our parent is stale, so the
        // links have to be re-applied to whatever landed in the meantime.
        const draft = await readFile(target.path, controller.signal);
        const folded = foldLinks(draft.text, claimed);
        state.folded = folded;
        // Nothing left to write — the draft already had every link. An empty
        // commit would still be a commit, and would still redeploy the site.
        if (folded.committedIds.length === 0) return null;
        return {
          changes: [{ path: target.path, content: folded.content }],
          message: `squirrel: flush ${flushId} (+${folded.committedIds.length} links)`,
        };
      },
      3,
      controller.signal,
    );

    const folded = state.folded;
    if (folded === null) throw new Error('flush produced no change set');

    await settleClaim(flushId, folded);
    return record(
      result(flushId, true, commitSha === null ? 'nothing-new' : 'ok', {
        ...counts(folded),
        commitSha: commitSha ?? undefined,
        targetPath: target.path,
      }),
    );
  } catch (err) {
    const folded = state.folded;
    const landed = folded === null ? 'unknown' : await commitLanded(target.path, flushId);
    if (typeof landed === 'object' && folded !== null) {
      // The ref did move; the failure was in hearing about it.
      await settleClaim(flushId, folded);
      return record(
        result(flushId, true, 'ok', {
          ...counts(folded),
          commitSha: landed.sha,
          targetPath: target.path,
        }),
      );
    }
    // The claim stays exactly where it is. The orphan sweep merges it back on a
    // later run, and the content-level dedupe drops anything that did land.
    return record(
      result(flushId, false, 'error', { error: message(err), targetPath: target.path }),
    );
  } finally {
    clearTimeout(deadline);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runFlush(): Promise<FlushResult> {
  const flushId = newFlushId();

  // Before the lock, so a claim abandoned by a flush that died is already back
  // in the buffer by the time this one takes it.
  try {
    await sweepOrphanClaims(TIMING.orphanMs);
  } catch (err) {
    // A failed sweep only delays recovery by one run; the flush in front of us
    // is still worth doing.
    console.warn('[squirrel] orphan sweep failed', err);
  }

  try {
    const outcome = await withLock(FLUSH_LOCK_KEY, TIMING.lockTtlMs, () => flushClaimed(flushId));
    // Not an error: another flush is already doing exactly this work.
    return outcome === 'locked' ? result(flushId, false, 'locked') : outcome;
  } catch (err) {
    // Only Redis itself can get us here — `flushClaimed` reports its own
    // failures — so there is no point trying to record this in Redis.
    return result(flushId, false, 'error', { error: message(err) });
  }
}
