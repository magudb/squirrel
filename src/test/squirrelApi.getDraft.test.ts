import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SquirrelApi, SquirrelApiError } from '../utils/squirrelApi';

/**
 * `GET /api/drafts?id=` is newer than the service that answers `GET /api/drafts`,
 * and the two share a path. A deployment that predates the parameter ignores it
 * and returns the listing — a well-formed 200 with the wrong shape, which is the
 * one failure mode a status code cannot describe.
 *
 * It has to be caught on the wire. The caller destructures `content` out of the
 * answer, and everything downstream of that phrases its failure as a fact about
 * the draft ("this draft has no front matter") when the draft is fine.
 */
const ID = 'MjAyNi0wOC0wMS1UZWNoIERpZ2VzdC5tZA';

const DRAFT = {
  id: ID,
  filename: '2026-08-01-Tech Digest.md',
  path: '_drafts/2026-08-01-Tech Digest.md',
  title: 'Summer 2026 Tech Links',
  curated: true,
};

function answerWith(payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    }),
  );
}

beforeEach(() => {
  // @ts-expect-error - the shared setup mocks storage.local; this path reads sync
  chrome.storage.sync = {
    get: vi.fn().mockResolvedValue({
      squirrelConfig: { baseUrl: 'https://squirrel.example', token: 'test-token' },
    }),
  };
});

describe('getDraft', () => {
  it('returns the draft with its body', async () => {
    answerWith({ draft: DRAFT, content: '---\ntitle: "Summer 2026 Tech Links"\n---\n\nbody\n' });

    const result = await SquirrelApi.getDraft(ID);

    expect(result.content).toContain('title: "Summer 2026 Tech Links"');
    expect(result.draft.filename).toBe('2026-08-01-Tech Digest.md');
  });

  it('names the deployment when the service answers with the listing instead', async () => {
    answerWith([DRAFT]);

    await expect(SquirrelApi.getDraft(ID)).rejects.toMatchObject({
      name: 'SquirrelApiError',
      code: 'draft_content_missing',
    });
    await expect(SquirrelApi.getDraft(ID)).rejects.toThrow(/predates the metadata review/);
  });

  it('rejects a draft whose body is absent rather than empty', async () => {
    // An empty string is a real answer — a draft can be empty. A missing key is
    // not, and must not read as one.
    answerWith({ draft: DRAFT });

    await expect(SquirrelApi.getDraft(ID)).rejects.toBeInstanceOf(SquirrelApiError);

    answerWith({ draft: DRAFT, content: '' });
    await expect(SquirrelApi.getDraft(ID)).resolves.toMatchObject({ content: '' });
  });
});
