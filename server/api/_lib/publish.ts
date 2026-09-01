/**
 * Moving a draft into `_posts/` — as exactly one commit.
 *
 * Two commits (flush, then move) would leave a window where the draft holds
 * links that no post contains, and the blog's announce job keys on files ADDED
 * under `_posts/`, so a move split across commits would also stop announcing.
 * So the buffered links are folded into the draft in memory and a single tree
 * both creates the post and deletes the draft.
 *
 * The destination is server-constructed. The caller names a draft by opaque id
 * and nothing else; that id is resolved against a freshly fetched `_drafts/`
 * listing, so no caller string can ever reach a tree path.
 */

import { TIMING } from './env.js';
import {
  FLUSH_LOCK_KEY,
  commitLanded,
  foldLinks,
  settleClaim,
  type FoldOutcome,
} from './flush.js';
import { commitWithRetry, fileExists, listDir, readFile } from './github.js';
import { HttpError } from './http.js';
import { withLock } from './lock.js';
import {
  applyFrontMatter,
  frontMatterTitle,
  hasFrontMatter,
  normalizeTrailingNewline,
  pruneEmptySections,
  type FrontMatterPatch,
} from './markdown.js';
import { DRAFTS_DIR, assertWritablePath, decodeDraftId, postPathFor } from './paths.js';
import {
  claimPending,
  getTarget,
  newFlushId,
  returnToPending,
  setLastFlush,
  setTarget,
  sweepOrphanClaims,
} from './store.js';
import type { PendingLink, PublishResult } from './types.js';

export interface PublishInput {
  draftId: string;
  slug?: string;
  date?: string;
  prune?: boolean;
  /**
   * Front-matter scalars to rewrite as part of the publishing commit.
   *
   * The draft template ships `description` and `keywords` empty for the author
   * to fill in at publish time, and a digest's title drifts from its content as
   * links accumulate over a quarter. Writing them here rather than in a second
   * commit keeps the one-commit property the rest of this module is built on:
   * the post is created with the metadata it will be read with, and the announce
   * job — which keys on files ADDED under `_posts/` — still fires exactly once.
   *
   * Values arrive already normalised by the route; nothing here re-validates the
   * text, but `applyFrontMatter` is the only thing that writes it.
   */
  meta?: FrontMatterPatch;
}

/** The keys of `meta` that actually carry a value. */
function metaFields(meta: FrontMatterPatch | undefined): string[] {
  if (meta === undefined) return [];
  return Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

/**
 * `YYYY-MM-DD`, and it has to be the date it claims to be: `Date.UTC` rolls
 * `2026-02-31` forward into March, and the post would then live at a URL the
 * user never asked for — renaming it later changes that URL again.
 */
function parseDate(raw: string | undefined): Date {
  if (raw === undefined) return new Date();
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (parts === null) {
    throw new HttpError(400, 'date must be formatted YYYY-MM-DD', 'bad_date');
  }
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new HttpError(400, `No such date: ${raw}`, 'bad_date');
  }
  return date;
}

/**
 * Last resort when a draft has no front matter — `_drafts/2025-06-20-on AI.md`
 * is plain prose. Both the extension and Jekyll's own date prefix would
 * otherwise survive into the slug, giving `_posts/2026-08-26-2025-06-20-on-ai-md`.
 */
function titleFromFilename(filename: string): string {
  return filename.replace(/\.(md|markdown)$/i, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

/**
 * Only when the target pointed at the draft we just removed. The target is
 * global, so clearing it unconditionally would silently stop flushes into a
 * draft that is still perfectly there.
 */
async function clearTargetFor(draftPath: string): Promise<void> {
  const target = await getTarget();
  if (target !== null && target.path === draftPath) await setTarget(null);
}

/** A publish drains the buffer exactly as a flush does, so `/api/status` must
 *  not keep reporting an older flush as the last thing that touched it. */
async function record(flushId: string, folded: FoldOutcome, commitSha: string): Promise<void> {
  try {
    await setLastFlush({
      at: Date.now(),
      flushId,
      reason: folded.committedIds.length > 0 ? 'ok' : 'nothing-new',
      committed: folded.committedIds.length,
      skipped: folded.skippedIds.length,
      unroutable: folded.unroutableIds.length,
      commitSha,
    });
  } catch (err) {
    console.warn('[squirrel] could not record the publish', err);
  }
}

async function publishLocked(
  input: PublishInput,
  filename: string,
  date: Date,
  flushId: string,
): Promise<PublishResult> {
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error(`GitHub did not answer within ${TIMING.githubDeadlineMs}ms`)),
    TIMING.githubDeadlineMs,
  );

  const updating = metaFields(input.meta);
  const state: { folded: FoldOutcome | null; pruned: string[] } = { folded: null, pruned: [] };
  let draftPath: string | null = null;
  let postPath: string | null = null;
  // Hoisted so the catch can tell "we are holding the buffer" from "nothing has
  // been claimed yet".
  let claimed: PendingLink[] = [];

  const finish = async (
    paths: { draftPath: string; postPath: string },
    folded: FoldOutcome,
    commitSha: string,
  ): Promise<PublishResult> => {
    await settleClaim(flushId, folded);
    await clearTargetFor(paths.draftPath);
    await record(flushId, folded, commitSha);
    return {
      ok: true,
      commitSha,
      postPath: paths.postPath,
      draftPath: paths.draftPath,
      linksIncluded: folded.committedIds.length,
      skipped: folded.skippedIds.length,
      unroutable: folded.unroutableIds.length,
      prunedSections: state.pruned,
      metaUpdated: updating,
    };
  };

  try {
    // The allowlist is the live listing, not anything the caller sent.
    const entries = await listDir(DRAFTS_DIR, controller.signal);
    const entry = entries.find((candidate) => candidate.name === filename);
    if (entry === undefined) {
      throw new HttpError(404, `No such draft: ${filename}`, 'draft_not_found');
    }
    draftPath = entry.path;

    const draft = await readFile(draftPath, controller.signal);

    // Refused before anything is claimed: a draft with no front matter has no
    // block to write into (`_drafts/2025-06-20-on AI.md` is plain prose), and
    // inventing one would put a header on a file whose author never had it.
    if (updating.length > 0 && !hasFrontMatter(draft.text)) {
      throw new HttpError(
        409,
        `${draftPath} has no front matter to write metadata into`,
        'no_front_matter',
      );
    }

    // `postPathFor` slugifies, so a caller-supplied slug goes through the same
    // filter as a front-matter title rather than being trusted as given. A new
    // title outranks the one in the file for the same reason it is being
    // rewritten: the file's is the one that no longer matches the content. An
    // explicit slug still wins, since it names the destination and nothing else.
    const title =
      input.slug ?? input.meta?.title ?? frontMatterTitle(draft.text) ?? titleFromFilename(filename);
    postPath = postPathFor(title, date);

    assertWritablePath(draftPath);
    assertWritablePath(postPath);

    // Overwriting a live post would also silence the announce job, which keys
    // on files added under `_posts/` rather than on files changed.
    if (await fileExists(postPath, controller.signal)) {
      throw new HttpError(409, `${postPath} already exists`, 'destination_exists');
    }

    // Claimed only once everything that can fail cheaply has passed, so a
    // rejected publish never leaves the buffer invisible.
    claimed = (await claimPending(flushId)) ?? [];
    const paths = { draftPath, postPath };

    const commitSha = await commitWithRetry(
      async () => {
        // Re-read on every attempt for the same reason the flush does: a 422
        // means the parent commit is stale.
        const current = await readFile(paths.draftPath, controller.signal);
        const folded = foldLinks(current.text, claimed);
        // Pruned after folding, so a section that was empty in the draft but
        // has just received a link survives.
        const tidied =
          input.prune === false
            ? { content: folded.content, pruned: [] }
            : pruneEmptySections(folded.content);
        // After folding and pruning, so the patch is applied to the bytes that
        // are about to be written rather than to a copy that pruning then
        // rebuilds. Re-read every attempt like everything else in this callback.
        const finalContent =
          updating.length > 0 ? applyFrontMatter(tidied.content, input.meta ?? {}) : tidied.content;
        if (finalContent === null) {
          // The draft lost its front matter between the check above and this
          // re-read. Vanishingly unlikely, and still not something to paper over
          // by writing a post without the metadata the caller asked for.
          throw new HttpError(
            409,
            `${paths.draftPath} has no front matter to write metadata into`,
            'no_front_matter',
          );
        }
        state.folded = folded;
        state.pruned = tidied.pruned;
        return {
          changes: [
            { path: paths.postPath, content: normalizeTrailingNewline(finalContent) },
            { path: paths.draftPath, delete: true },
          ],
          message: `squirrel: publish ${paths.postPath} (+${folded.committedIds.length} links, flush ${flushId})`,
        };
      },
      3,
      controller.signal,
    );

    const folded = state.folded;
    if (commitSha === null || folded === null) throw new Error('publish produced no change set');
    return await finish(paths, folded, commitSha);
  } catch (err) {
    const folded = state.folded;
    // Only the build callback assigns `folded`, and it runs to completion before
    // `commitChanges` is ever called — so a null one proves nothing was written
    // and there is nothing to ask GitHub about. Handing the claim back here is
    // what keeps a failed re-read out of the orphan sweep's three-minute window,
    // during which the buffer reads as empty and a retry would publish the post
    // without these links.
    if (folded === null) {
      if (claimed.length > 0) await returnToPending(flushId);
      throw err;
    }
    if (draftPath !== null && postPath !== null) {
      const landed = await commitLanded(postPath, flushId);
      if (typeof landed === 'object') {
        // The post is there; only the answer went missing.
        return await finish({ draftPath, postPath }, folded, landed.sha);
      }
      if (landed === 'absent') {
        // Confirmed nothing was written, so the buffer goes straight back —
        // the user's retry has to include these links, and the orphan sweep is
        // three minutes away.
        await returnToPending(flushId);
      }
      // 'unknown': leave the claim for the sweep. Returning links that may have
      // just been published would re-file them into a draft that is now gone.
    }
    throw err;
  } finally {
    clearTimeout(deadline);
  }
}

export async function publish(input: PublishInput): Promise<PublishResult> {
  // Rejected before anything is claimed or locked.
  const filename = decodeDraftId(input.draftId);
  const date = parseDate(input.date);
  const flushId = newFlushId();

  // A publish folds the buffer, so a claim left behind by a flush that died has
  // to be back in it first or those links miss the post they belong in.
  try {
    await sweepOrphanClaims(TIMING.orphanMs);
  } catch (err) {
    console.warn('[squirrel] orphan sweep failed', err);
  }

  // The same lock as the flush: a flush interleaving with this would write into
  // a draft that is about to stop existing.
  const outcome = await withLock(FLUSH_LOCK_KEY, TIMING.lockTtlMs, () =>
    publishLocked(input, filename, date, flushId),
  );
  if (outcome === 'locked') {
    throw new HttpError(409, 'A flush is already running; try again in a moment.', 'flush_running');
  }
  return outcome;
}
