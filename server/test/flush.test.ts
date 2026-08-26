import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GitHub and Redis are stubbed; markdown and urlnorm are the real modules,
 * because the behaviour under test *is* the interaction between them — a link
 * is skipped only if the URL normaliser and the bullet parser agree.
 *
 * `commitWithRetry` is stubbed too, but with a faithful stand-in rather than a
 * canned answer: the retry loop itself belongs to github.ts, while what matters
 * here is that the build callback re-reads the draft on every attempt.
 */
const gh = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDir: vi.fn(),
  fileExists: vi.fn(),
  commitChanges: vi.fn(),
  commitsTouching: vi.fn(),
}));

vi.mock('../api/_lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/_lib/github.js')>();
  return {
    ...actual,
    ...gh,
    commitWithRetry: async (
      build: () => Promise<{ changes: unknown[]; message: string } | null>,
      attempts = 3,
    ) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const built = await build();
        if (built === null) return null;
        try {
          return await gh.commitChanges(built.changes, built.message);
        } catch (err) {
          if (!(err instanceof actual.GitHubError) || !err.isConflict) throw err;
          lastError = err;
        }
      }
      throw lastError;
    },
  };
});

const store = vi.hoisted(() => ({
  sweepOrphanClaims: vi.fn(),
  claimPending: vi.fn(),
  returnToPending: vi.fn(),
  discardClaim: vi.fn(),
  getTarget: vi.fn(),
  setTarget: vi.fn(),
  setLastFlush: vi.fn(),
}));

vi.mock('../api/_lib/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/_lib/store.js')>();
  return { ...actual, ...store };
});

const lock = vi.hoisted(() => ({ held: false }));

vi.mock('../api/_lib/lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/_lib/lock.js')>();
  return {
    ...actual,
    withLock: async (_key: string, _ttlMs: number, fn: () => Promise<unknown>) =>
      lock.held ? 'locked' : fn(),
  };
});

import { runFlush } from '../api/_lib/flush.js';
import { GitHubError } from '../api/_lib/github.js';
import { HttpError } from '../api/_lib/http.js';
import { encodeDraftId } from '../api/_lib/paths.js';
import { publish } from '../api/_lib/publish.js';
import type { PendingLink, TargetDraft } from '../api/_lib/types.js';

const DRAFT_FILENAME = '2026-08-01-Tech Digest: Summer 2026 copy.md';
const DRAFT_PATH = `_drafts/${DRAFT_FILENAME}`;

const TARGET: TargetDraft = {
  draftId: encodeDraftId(DRAFT_FILENAME),
  path: DRAFT_PATH,
  setAt: 1_756_000_000_000,
};

/** `tools` is deliberately empty and there is no `devops` section at all. */
const DRAFT = `---
layout: post
title: "Tech Digest: Summer 2026"
category: "Curated Insights"
---

# <a name="favorites"></a>My favorites

- [An article everyone should read](https://example.com/article?utm_source=news){:target="_blank"}

## <a name="ai"></a>AI, LLM & Machine Learning

- [A model release](https://ai.example.com/model){:target="_blank"}

## <a name="tools"></a>Tools and things from Github
`;

function link(overrides: Partial<PendingLink> = {}): PendingLink {
  return {
    id: 'lnk_default',
    url: 'https://new.example.com/post',
    title: 'A new post',
    category: 'ai',
    addedAt: 1_756_000_000_000,
    ...overrides,
  };
}

function draftBlob(text: string) {
  return { sha: 'blob-sha', size: text.length, text };
}

/** The change set handed to `commitChanges` on its nth call. */
function changes(call = 0): Array<{ path: string; content?: string; delete?: true }> {
  return gh.commitChanges.mock.calls[call][0];
}

function writtenContent(path: string, call = 0): string {
  const change = changes(call).find((entry) => entry.path === path);
  return change?.content ?? '';
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function rejection(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (err) {
    return err as HttpError;
  }
  throw new Error('expected the call to reject');
}

beforeEach(() => {
  vi.clearAllMocks();
  lock.held = false;
  store.sweepOrphanClaims.mockResolvedValue(0);
  store.claimPending.mockResolvedValue(null);
  store.returnToPending.mockResolvedValue(undefined);
  store.discardClaim.mockResolvedValue(undefined);
  store.getTarget.mockResolvedValue(TARGET);
  store.setTarget.mockResolvedValue(undefined);
  store.setLastFlush.mockResolvedValue(undefined);
  gh.readFile.mockResolvedValue(draftBlob(DRAFT));
  gh.commitChanges.mockResolvedValue('commit-sha');
  gh.commitsTouching.mockResolvedValue([]);
  gh.listDir.mockResolvedValue([
    { name: DRAFT_FILENAME, path: DRAFT_PATH, sha: 'blob-sha', size: DRAFT.length },
  ]);
  gh.fileExists.mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runFlush', () => {
  it('writes a link into the section its category names', async () => {
    store.claimPending.mockResolvedValue([link({ id: 'lnk_a' })]);

    const flushed = await runFlush();

    expect(flushed).toMatchObject({ ok: true, reason: 'ok', committed: 1, commitSha: 'commit-sha' });
    const body = writtenContent(DRAFT_PATH);
    expect(body).toContain('- [A new post](https://new.example.com/post){:target="_blank"}');
    // Appended after the section's last bullet, not into `favorites`.
    expect(body.indexOf('new.example.com')).toBeGreaterThan(body.indexOf('ai.example.com'));
    expect(gh.commitChanges.mock.calls[0][1]).toBe(
      `squirrel: flush ${flushed.flushId} (+1 links)`,
    );
    expect(store.discardClaim).toHaveBeenCalledWith(flushed.flushId, ['lnk_a']);
  });

  it('skips a link the draft already holds under different tracking params', async () => {
    store.claimPending.mockResolvedValue([
      link({ id: 'lnk_dupe', url: 'https://www.example.com/article?utm_medium=email&fbclid=xyz' }),
    ]);

    const flushed = await runFlush();

    expect(flushed).toMatchObject({ ok: true, reason: 'nothing-new', committed: 0, skipped: 1 });
    // Nothing to write means nothing is committed: an empty commit still
    // redeploys the site.
    expect(gh.commitChanges).not.toHaveBeenCalled();
    // The payload still goes — the link is in the file, which is the point.
    expect(store.discardClaim).toHaveBeenCalledWith(flushed.flushId, ['lnk_dupe']);
    expect(store.returnToPending).toHaveBeenCalledWith(flushed.flushId, []);
  });

  it('drops a duplicate that appears twice within one batch', async () => {
    store.claimPending.mockResolvedValue([
      link({ id: 'lnk_1', url: 'https://new.example.com/post?utm_source=a' }),
      link({ id: 'lnk_2', url: 'https://new.example.com/post?utm_source=b' }),
    ]);

    const flushed = await runFlush();

    expect(flushed).toMatchObject({ committed: 1, skipped: 1 });
    expect(occurrences(writtenContent(DRAFT_PATH), 'new.example.com/post')).toBe(1);
  });

  it('returns a link whose category has no section to the buffer', async () => {
    store.claimPending.mockResolvedValue([
      link({ id: 'lnk_ops', category: 'devops', url: 'https://ops.example.com/x' }),
    ]);

    const flushed = await runFlush();

    expect(flushed).toMatchObject({ ok: true, reason: 'nothing-new', committed: 0, unroutable: 1 });
    expect(store.returnToPending).toHaveBeenCalledWith(flushed.flushId, ['lnk_ops']);
    // Never discarded — the link has not been written anywhere.
    expect(store.discardClaim).toHaveBeenCalledWith(flushed.flushId, []);
  });

  it('re-reads the draft after a 422 and lands the link exactly once', async () => {
    const meanwhile = DRAFT.replace(
      '- [A model release](https://ai.example.com/model){:target="_blank"}',
      '- [A model release](https://ai.example.com/model){:target="_blank"}\n- [Someone else was here](https://other.example.com/x){:target="_blank"}',
    );
    gh.readFile
      .mockResolvedValueOnce(draftBlob(DRAFT))
      .mockResolvedValueOnce(draftBlob(meanwhile));
    gh.commitChanges
      .mockRejectedValueOnce(new GitHubError(422, '{"message":"Update is not a fast forward"}'))
      .mockResolvedValueOnce('second-sha');
    store.claimPending.mockResolvedValue([link({ id: 'lnk_a' })]);

    const flushed = await runFlush();

    expect(flushed).toMatchObject({ ok: true, reason: 'ok', committed: 1, commitSha: 'second-sha' });
    expect(gh.readFile).toHaveBeenCalledTimes(2);
    const body = writtenContent(DRAFT_PATH, 1);
    // The rebuild is applied on top of what landed in the meantime, not on top
    // of the stale read.
    expect(body).toContain('https://other.example.com/x');
    expect(occurrences(body, 'https://new.example.com/post')).toBe(1);
  });

  it('leaves the claim intact and reports an error when the commit fails', async () => {
    gh.commitChanges.mockRejectedValue(new GitHubError(500, 'upstream exploded'));
    store.claimPending.mockResolvedValue([link({ id: 'lnk_a' })]);

    const flushed = await runFlush();

    expect(flushed).toMatchObject({ ok: false, reason: 'error', targetPath: DRAFT_PATH });
    expect(flushed.error).toContain('upstream exploded');
    expect(store.discardClaim).not.toHaveBeenCalled();
    expect(store.returnToPending).not.toHaveBeenCalled();
    expect(store.setLastFlush).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'error', flushId: flushed.flushId }),
    );
  });

  it('treats a commit it can find in the history as landed', async () => {
    gh.commitChanges.mockRejectedValue(new Error('socket hang up'));
    store.claimPending.mockResolvedValue([link({ id: 'lnk_a' })]);
    // The flush id is minted inside `runFlush`, so the stub answers with the
    // message the attempted commit actually carried.
    gh.commitsTouching.mockImplementation(async (path: string) => {
      expect(path).toBe(DRAFT_PATH);
      const message = gh.commitChanges.mock.calls[0][1] as string;
      return [{ sha: 'recovered-sha', message }];
    });

    const flushed = await runFlush();

    expect(flushed).toMatchObject({ ok: true, reason: 'ok', committed: 1, commitSha: 'recovered-sha' });
    expect(store.discardClaim).toHaveBeenCalledWith(flushed.flushId, ['lnk_a']);
  });

  it('fails loudly and hands the batch back when no target is set', async () => {
    store.getTarget.mockResolvedValue(null);
    store.claimPending.mockResolvedValue([link({ id: 'lnk_a' })]);

    const flushed = await runFlush();

    expect(flushed).toMatchObject({ ok: false, reason: 'no-target' });
    expect(store.returnToPending).toHaveBeenCalledWith(flushed.flushId);
    expect(gh.readFile).not.toHaveBeenCalled();
  });

  it('reports a held lock without touching the buffer or GitHub', async () => {
    lock.held = true;

    const flushed = await runFlush();

    expect(flushed).toMatchObject({ ok: false, reason: 'locked', committed: 0 });
    expect(store.claimPending).not.toHaveBeenCalled();
    expect(gh.readFile).not.toHaveBeenCalled();
    // A contended run must not overwrite the record of the last real batch.
    expect(store.setLastFlush).not.toHaveBeenCalled();
    // The sweep runs before the lock, so an abandoned claim is recovered even
    // while flushes are contending.
    expect(store.sweepOrphanClaims).toHaveBeenCalled();
  });

  it('reports an empty buffer without touching GitHub', async () => {
    store.claimPending.mockResolvedValue(null);

    const flushed = await runFlush();

    expect(flushed).toMatchObject({ ok: true, reason: 'empty', committed: 0 });
    expect(gh.readFile).not.toHaveBeenCalled();
    expect(store.setLastFlush).not.toHaveBeenCalled();
  });

  it('sweeps abandoned claims before taking the lock', async () => {
    const order: string[] = [];
    store.sweepOrphanClaims.mockImplementation(async () => {
      order.push('sweep');
      return 1;
    });
    store.claimPending.mockImplementation(async () => {
      order.push('claim');
      return null;
    });

    await runFlush();

    expect(order).toEqual(['sweep', 'claim']);
  });
});

describe('publish', () => {
  const draftId = encodeDraftId(DRAFT_FILENAME);

  it('creates the post and deletes the draft in one commit', async () => {
    store.claimPending.mockResolvedValue([link({ id: 'lnk_a' })]);

    const published = await publish({ draftId, date: '2026-08-26' });

    expect(gh.commitChanges).toHaveBeenCalledTimes(1);
    const postPath = '_posts/2026-08-26-tech-digest-summer-2026.md';
    expect(published).toMatchObject({
      ok: true,
      commitSha: 'commit-sha',
      postPath,
      draftPath: DRAFT_PATH,
      linksIncluded: 1,
      prunedSections: ['tools'],
    });
    expect(changes()).toEqual([
      { path: postPath, content: expect.any(String) },
      { path: DRAFT_PATH, delete: true },
    ]);
    expect(writtenContent(postPath)).toContain('https://new.example.com/post');
    // The target pointed at the draft that has just stopped existing.
    expect(store.setTarget).toHaveBeenCalledWith(null);
    expect(store.discardClaim).toHaveBeenCalledWith(expect.any(String), ['lnk_a']);
  });

  it('rejects a draft id that is not in the live listing', async () => {
    const err = await rejection(publish({ draftId: encodeDraftId('never-existed.md') }));

    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(gh.commitChanges).not.toHaveBeenCalled();
    // Nothing was claimed, so nothing has to be handed back.
    expect(store.claimPending).not.toHaveBeenCalled();
    expect(store.returnToPending).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an existing post', async () => {
    gh.fileExists.mockResolvedValue(true);

    const err = await rejection(publish({ draftId, date: '2026-08-26' }));

    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(gh.commitChanges).not.toHaveBeenCalled();
    expect(store.claimPending).not.toHaveBeenCalled();
  });

  it('rejects a date that is not a real day', async () => {
    const err = await rejection(publish({ draftId, date: '2026-02-31' }));

    expect(err.status).toBe(400);
    expect(gh.listDir).not.toHaveBeenCalled();
  });

  it('keeps a target that points at some other draft', async () => {
    store.getTarget.mockResolvedValue({ ...TARGET, path: '_drafts/something else.md' });

    await publish({ draftId, date: '2026-08-26' });

    expect(store.setTarget).not.toHaveBeenCalled();
  });

  it('hands the buffer back when the commit is confirmed not to have landed', async () => {
    gh.commitChanges.mockRejectedValue(new GitHubError(500, 'upstream exploded'));
    store.claimPending.mockResolvedValue([link({ id: 'lnk_a' })]);

    const err = await rejection(publish({ draftId, date: '2026-08-26' }));

    expect(err.message).toContain('upstream exploded');
    expect(store.returnToPending).toHaveBeenCalledWith(expect.any(String));
    expect(store.discardClaim).not.toHaveBeenCalled();
    expect(store.setTarget).not.toHaveBeenCalled();
  });

  it('hands the buffer back when the draft read dies before anything is built', async () => {
    store.claimPending.mockResolvedValue([link({ id: 'lnk_a' })]);
    // The pre-flight read lands; the re-read inside the build callback is the
    // one that hits the deadline, so no change set is ever built.
    gh.readFile
      .mockResolvedValueOnce(draftBlob(DRAFT))
      .mockRejectedValueOnce(new Error('GitHub did not answer within 40000ms'));

    const err = await rejection(publish({ draftId, date: '2026-08-26' }));

    expect(err.message).toContain('GitHub did not answer');
    expect(gh.commitChanges).not.toHaveBeenCalled();
    // The whole claim goes back, and it goes back now: leaving it for the orphan
    // sweep would report an empty buffer to a user who is about to retry.
    expect(store.returnToPending).toHaveBeenCalledWith(expect.stringMatching(/^flush_/));
    expect(store.discardClaim).not.toHaveBeenCalled();
  });

  it('keeps every section when prune is off', async () => {
    const published = await publish({ draftId, date: '2026-08-26', prune: false });

    expect(published.prunedSections).toEqual([]);
    expect(writtenContent('_posts/2026-08-26-tech-digest-summer-2026.md')).toContain(
      '<a name="tools">',
    );
  });
});
