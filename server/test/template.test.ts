import type { VercelRequest, VercelResponse } from '@vercel/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GitHub and Redis are stubbed; markdown, categories and paths are the real
 * modules, because the property under test *is* the interaction between them:
 * a generated draft is only useful if the flush's own parser finds every
 * section the category list can route a link to. A hand-written expectation of
 * "the anchors are probably fine" would pass with a typo in one of them and
 * produce drafts that silently reject every link in that category.
 *
 * Creation goes through `createFileIfAbsent`, which is a single Contents API
 * write that GitHub itself refuses with a 422 when the path is taken. That is
 * what makes the "already exists" case a property of the request rather than
 * of a check we perform beforehand, so the stub only has to model the 422.
 */
const gh = vi.hoisted(() => ({
  readFile: vi.fn(),
  listDir: vi.fn(),
  fileExists: vi.fn(),
  createFileIfAbsent: vi.fn(),
}));

vi.mock('../api/_lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/_lib/github.js')>();
  return { ...actual, ...gh };
});

const store = vi.hoisted(() => ({
  setTarget: vi.fn(),
  getTarget: vi.fn(),
  bumpAuthFailures: vi.fn(),
}));

vi.mock('../api/_lib/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/_lib/store.js')>();
  return { ...actual, ...store };
});

import { CATEGORIES } from '../api/_lib/categories.js';
import { GitHubError } from '../api/_lib/github.js';
import { HttpError } from '../api/_lib/http.js';
import {
  formatLink,
  frontMatterTitle,
  hasSection,
  insertLink,
  isCuratedInsights,
  parseSections,
} from '../api/_lib/markdown.js';
import { assertWritablePath, draftPathFor, encodeDraftId } from '../api/_lib/paths.js';
import { TEMPLATE_ANCHORS, newDraftBody, normalizeDraftTitle } from '../api/_lib/template.js';
import draftsRoute from '../api/drafts.js';

const TITLE = 'Autumn 2026 Tech Links';

/**
 * The whole point of the exercise: this is transcribed from the live draft and
 * the two most recent published quarters. Section order, heading levels and the
 * single space before the `development` and `tools` anchors are all corpus
 * facts, not preferences — the flush matches on anchors, and the quarterly diff
 * has to stay boring.
 */
const GOLDEN = `---
layout: post
title: "Autumn 2026 Tech Links"
description: ""
comments: false
category: "Curated Insights"
keywords: ""
---
<!-- markdownlint-disable MD033 MD020 MD025-->
# My favorites<a name="favorites"></a>

## Agile, Leadership and Product<a name="agile"></a>

## Architecture, Development & Software development practices <a name="development"></a>

## AI, LLM & Machine Learning<a name="ai"></a>

## DevOps, Observability & Security<a name="devops"></a>

## Tools and things from Github <a name="tools"></a>
`;

/** Everything above the first heading. Nothing an insert does may touch it. */
const HEAD = GOLDEN.slice(0, GOLDEN.indexOf('# My favorites'));

function anchorsOf(content: string): string[] {
  return parseSections(content)
    .sections.map((section) => section.anchor)
    .filter((anchor): anchor is string => anchor !== null);
}

function thrown(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (err) {
    return err as HttpError;
  }
  throw new Error('expected the call to throw');
}

describe('newDraftBody', () => {
  it('reproduces the corpus skeleton byte for byte', () => {
    expect(newDraftBody(TITLE)).toBe(GOLDEN);
  });

  it('ends in exactly one newline', () => {
    const body = newDraftBody(TITLE);
    expect(body.endsWith('\n')).toBe(true);
    expect(body.endsWith('\n\n')).toBe(false);
  });

  it('uses the corpus section order, which is NOT the CATEGORIES order', () => {
    const anchors = anchorsOf(newDraftBody(TITLE));

    expect(anchors).toEqual(['favorites', 'agile', 'development', 'ai', 'devops', 'tools']);
    expect(anchors).toEqual([...TEMPLATE_ANCHORS]);
    // Same six sections as the category list, deliberately in a different order.
    const listed = CATEGORIES.map((category) => category.anchor);
    expect([...anchors].sort()).toEqual([...listed].sort());
    expect(anchors).not.toEqual(listed);
  });

  it('reproduces the anchor spacing quirk on development and tools only', () => {
    const body = newDraftBody(TITLE);

    expect(body).toContain('practices <a name="development"></a>');
    expect(body).toContain('Github <a name="tools"></a>');
    expect(body).toContain('My favorites<a name="favorites"></a>');
    expect(body).toContain('Product<a name="agile"></a>');
    expect(body).toContain('Learning<a name="ai"></a>');
    expect(body).toContain('Security<a name="devops"></a>');
  });

  it('opens with the h1 and continues in h2', () => {
    const levels = parseSections(newDraftBody(TITLE)).sections.map((section) => section.level);
    expect(levels).toEqual([1, 2, 2, 2, 2, 2]);
  });

  it('leaves the front matter fields the author fills in at publish time empty', () => {
    const body = newDraftBody(TITLE);
    expect(body).toContain('description: ""');
    expect(body).toContain('keywords: ""');
    // No file in this blog carries a `date:`; the filename prefix is the date.
    expect(body).not.toMatch(/^date:/m);
    expect(isCuratedInsights(body)).toBe(true);
  });
});

describe('newDraftBody title handling', () => {
  it('passes an apostrophe and an ampersand through untouched', () => {
    // Both appear in real section headings and real post titles.
    const title = "Architecture, Development & Kubernetes' practices";
    const body = newDraftBody(title);

    expect(body).toContain(`title: "${title}"`);
    expect(frontMatterTitle(body)).toBe(title);
  });

  it('escapes a double quote instead of letting it close the scalar', () => {
    const title = 'The "Curated" Insights';
    const body = newDraftBody(title);

    expect(body).toContain('title: "The \\"Curated\\" Insights"');
    // The round trip is the reason escaping was chosen over rejecting: the
    // reader on the other side is `unquote()` in markdown.ts.
    expect(frontMatterTitle(body)).toBe(title);
    // ...and the rest of the file is still a parseable Jekyll document.
    expect(isCuratedInsights(body)).toBe(true);
    expect(anchorsOf(body)).toEqual([...TEMPLATE_ANCHORS]);
  });

  it('escapes a backslash, including one that would eat the closing quote', () => {
    const title = 'C:\\Users and a trailing slash\\';
    const body = newDraftBody(title);

    expect(body).toContain('title: "C:\\\\Users and a trailing slash\\\\"');
    expect(frontMatterTitle(body)).toBe(title);
    expect(isCuratedInsights(body)).toBe(true);
  });

  it('escapes a quote/backslash combination in the right order', () => {
    const title = 'a\\"b';
    const body = newDraftBody(title);

    expect(body).toContain('title: "a\\\\\\"b"');
    expect(frontMatterTitle(body)).toBe(title);
  });

  it('rejects a newline rather than escaping one YAML would not give back', () => {
    // A raw newline ends the scalar and injects a line into the front matter;
    // `\n` would survive as literal backslash-n once read back.
    const err = thrown(() => newDraftBody('Autumn\nlayout: evil'));
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('bad_title');
  });

  it('rejects other control characters, and trims the harmless outer ones', () => {
    expect(thrown(() => newDraftBody('Autumn\tLinks')).status).toBe(400);
    expect(thrown(() => newDraftBody('Autumn\r\nLinks')).status).toBe(400);
    // Trimmed, not rejected: a title pasted with a trailing newline is fine.
    expect(newDraftBody('  Autumn 2026 Tech Links\n')).toBe(GOLDEN);
  });

  it('rejects markup Jekyll would render into the page unescaped', () => {
    expect(thrown(() => newDraftBody('<script>alert(1)</script>')).status).toBe(400);
  });

  it('rejects an empty, blank, absent or oversized title', () => {
    expect(thrown(() => newDraftBody('')).code).toBe('bad_title');
    expect(thrown(() => newDraftBody('   ')).code).toBe('bad_title');
    expect(thrown(() => newDraftBody(undefined as unknown as string)).code).toBe('bad_title');
    expect(thrown(() => newDraftBody(42 as unknown as string)).code).toBe('bad_title');
    expect(thrown(() => newDraftBody('x'.repeat(201))).code).toBe('bad_title');
    expect(normalizeDraftTitle('x'.repeat(200))).toBe('x'.repeat(200));
  });
});

/**
 * The property that actually matters. A created draft has to be usable as a
 * flush target the moment it exists, and "usable" means the real markdown module
 * — not a re-implementation of it here — finds every anchor the real category
 * list can name, and accepts a bullet into each.
 */
describe('a new draft is immediately usable as a flush target', () => {
  it('exposes a section for every category the extension can send', () => {
    const body = newDraftBody(TITLE);
    for (const category of CATEGORIES) {
      expect(hasSection(body, category.anchor), `missing section: ${category.anchor}`).toBe(true);
    }
  });

  it('accepts a bullet into each of the six sections', () => {
    const body = newDraftBody(TITLE);

    for (const category of CATEGORIES) {
      const bullet = formatLink({
        title: `A ${category.id} link`,
        url: `https://example.com/${category.id}`,
      });
      expect(bullet).toBe(
        `- [A ${category.id} link](https://example.com/${category.id}){:target="_blank"}`,
      );

      const updated = insertLink(body, category.anchor, bullet);
      const { lines, sections } = parseSections(updated);
      const section = sections.find((candidate) => candidate.anchor === category.anchor);
      expect(section, `missing section: ${category.anchor}`).toBeDefined();

      // On its own physical line, inside the section its category names, and
      // never spliced into the heading itself — the failure the local backend
      // produced against an empty section at EOF.
      const at = lines.indexOf(bullet);
      expect(at).toBeGreaterThanOrEqual(section!.bodyStart);
      expect(at).toBeLessThan(section!.bodyEnd);
      expect(lines[section!.headingLine]).toContain(`<a name="${category.anchor}">`);
      expect(updated.startsWith(HEAD)).toBe(true);
      expect(updated.endsWith('\n')).toBe(true);
      expect(updated.endsWith('\n\n')).toBe(false);
    }
  });

  it('holds one link per section at once', () => {
    let document = newDraftBody(TITLE);
    const bullets = new Map<string, string>();

    for (const category of CATEGORIES) {
      const bullet = formatLink({
        title: `${category.name} pick`,
        url: `https://example.com/${category.id}/1`,
      });
      bullets.set(category.anchor, bullet);
      document = insertLink(document, category.anchor, bullet);
    }

    const { lines, sections } = parseSections(document);
    for (const [anchor, bullet] of bullets) {
      const section = sections.find((candidate) => candidate.anchor === anchor)!;
      const at = lines.indexOf(bullet);
      expect(at).toBeGreaterThanOrEqual(section.bodyStart);
      expect(at).toBeLessThan(section.bodyEnd);
    }
    // Six inserts, six bullets, front matter untouched.
    expect(lines.filter((line) => line.startsWith('- [')).length).toBe(6);
    expect(document.startsWith(HEAD)).toBe(true);
    expect(frontMatterTitle(document)).toBe(TITLE);
  });

  it('still routes every category when the title is full of YAML metacharacters', () => {
    const body = newDraftBody('He said "no": C:\\temp & co.');
    for (const category of CATEGORIES) {
      expect(hasSection(body, category.anchor)).toBe(true);
      const bullet = formatLink({ title: 'x', url: 'https://example.com/x' });
      expect(insertLink(body, category.anchor, bullet)).toContain(bullet);
    }
  });
});

describe('draftPathFor', () => {
  it('builds a path the write allowlist accepts', () => {
    const path = draftPathFor(TITLE, new Date('2026-10-01T12:00:00Z'));
    expect(path).toBe('_drafts/2026-10-01-autumn-2026-tech-links.md');
    expect(() => assertWritablePath(path)).not.toThrow();
  });

  it('emits a kebab slug where the existing drafts carry spaces and colons', () => {
    const path = draftPathFor(
      'Tech Digest: Summer 2026 Tech Links: Architecture, Engineering Leadership',
      new Date('2026-08-01T00:00:00Z'),
    );
    expect(path).toBe(
      '_drafts/2026-08-01-tech-digest-summer-2026-tech-links-architecture-engineering-leadership.md',
    );
    // Jekyll's own slugify keeps the commas, the colons and the case; that is
    // what produced the eight fix-up renames in the blog's history.
    expect(path).not.toMatch(/[ :,]/);
    // The slug itself is capped, so an essay-length title cannot grow the path.
    const slugOf = (p: string): string =>
      p.replace(/^_drafts\/\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    expect(slugOf(path).length).toBeLessThanOrEqual(80);
    const capped = draftPathFor('word '.repeat(60), new Date('2026-08-01T00:00:00Z'));
    expect(slugOf(capped).length).toBeLessThanOrEqual(80);
    expect(capped.endsWith('-.md')).toBe(false);
  });

  it('uses UTC date parts, not the runner timezone', () => {
    expect(draftPathFor('A B', new Date('2026-08-01T23:30:00Z'))).toBe('_drafts/2026-08-01-a-b.md');
    expect(draftPathFor('A B', new Date('2026-01-01T00:30:00Z'))).toBe('_drafts/2026-01-01-a-b.md');
  });

  it('rejects an unusable date or a title with no slug in it', () => {
    expect(thrown(() => draftPathFor('A B', new Date('nonsense'))).status).toBe(400);
    expect(thrown(() => draftPathFor('***', new Date('2026-10-01T12:00:00Z'))).code).toBe(
      'bad_title',
    );
  });
});

/* --------------------------------------------------------------------------
 * POST /api/drafts
 * ------------------------------------------------------------------------ */

const TOKEN = 'test-token';
const PATH = '_drafts/2026-10-01-autumn-2026-tech-links.md';
const FILENAME = '2026-10-01-autumn-2026-tech-links.md';

interface Captured {
  status: number | null;
  body: unknown;
  headers: Record<string, string>;
}

interface FakeRes {
  setHeader(name: string, value: string | number): FakeRes;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  end(): FakeRes;
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
}

function fakeRes(): { res: VercelResponse; captured: Captured } {
  const captured: Captured = { status: null, body: undefined, headers: {} };
  let sent = false;
  const res: FakeRes = {
    setHeader(name, value) {
      captured.headers[name] = String(value);
      return res;
    },
    status(code) {
      captured.status = code;
      return res;
    },
    json(payload) {
      captured.body = payload;
      sent = true;
      return res;
    },
    end() {
      sent = true;
      return res;
    },
    get headersSent() {
      return sent;
    },
    get writableEnded() {
      return sent;
    },
  };
  return { res: res as unknown as VercelResponse, captured };
}

async function call(method: string, body?: unknown): Promise<Captured> {
  const req = {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
    body,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as VercelRequest;
  const { res, captured } = fakeRes();
  await draftsRoute(req, res);
  return captured;
}

/** The nth create, shaped like a change set so the assertions read the same. */
function changes(index = 0): Array<{ path: string; content: string }> {
  const [path, content] = gh.createFileIfAbsent.mock.calls[index];
  return [{ path, content }];
}

function commitMessage(index = 0): string {
  return gh.createFileIfAbsent.mock.calls[index][2];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SQUIRREL_TOKEN = TOKEN;
  gh.fileExists.mockResolvedValue(false);
  gh.createFileIfAbsent.mockResolvedValue('commit-sha');
  gh.listDir.mockResolvedValue([]);
  gh.readFile.mockResolvedValue({ sha: 'blob-sha', size: 0, text: '' });
  store.setTarget.mockResolvedValue(undefined);
  store.getTarget.mockResolvedValue(null);
  store.bumpAuthFailures.mockResolvedValue(1);
});

afterEach(() => {
  delete process.env.SQUIRREL_TOKEN;
  vi.restoreAllMocks();
});

describe('POST /api/drafts', () => {
  it('commits the skeleton and answers 201 with the draft ref', async () => {
    const captured = await call('POST', { title: TITLE, date: '2026-10-01' });

    expect(captured.status).toBe(201);
    expect(changes()).toEqual([{ path: PATH, content: GOLDEN }]);
    expect(commitMessage()).toBe(`squirrel: create draft ${FILENAME}`);
    expect(captured.body).toEqual({
      draft: {
        id: encodeDraftId(FILENAME),
        filename: FILENAME,
        path: PATH,
        title: TITLE,
        curated: true,
      },
      commitSha: 'commit-sha',
    });
    // No target was asked for, so the flush destination is left alone.
    expect(store.setTarget).not.toHaveBeenCalled();
  });

  it('defaults the date to today in UTC', async () => {
    const now = new Date();
    const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

    await call('POST', { title: TITLE });

    expect(changes()[0].path).toBe(`_drafts/${today}-autumn-2026-tech-links.md`);
  });

  it('points the target at the new draft only after the commit lands', async () => {
    const captured = await call('POST', { title: TITLE, date: '2026-10-01', setAsTarget: true });

    expect(captured.status).toBe(201);
    expect(store.setTarget).toHaveBeenCalledTimes(1);
    const target = store.setTarget.mock.calls[0][0];
    expect(target).toMatchObject({ draftId: encodeDraftId(FILENAME), path: PATH });
    expect(typeof target.setAt).toBe('number');
    expect((captured.body as { target?: unknown }).target).toEqual(target);
    // Ordering is the whole point: a target set first would name a file that
    // does not exist yet, and every flush against it would fail its write.
    expect(store.setTarget.mock.invocationCallOrder[0]).toBeGreaterThan(
      gh.createFileIfAbsent.mock.invocationCallOrder[0],
    );
  });

  it('never sets a target when the commit fails', async () => {
    // The error funnel logs the upstream failure; the log is not the assertion.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    gh.createFileIfAbsent.mockRejectedValue(new GitHubError(500, 'upstream exploded'));

    const captured = await call('POST', { title: TITLE, setAsTarget: true });

    expect(captured.status).toBe(502);
    expect(store.setTarget).not.toHaveBeenCalled();
  });

  it('still reports the draft when the target could not be stored', async () => {
    store.setTarget.mockRejectedValue(new Error('redis is down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const captured = await call('POST', { title: TITLE, date: '2026-10-01', setAsTarget: true });

    // The commit landed; telling the client otherwise would send it into a
    // retry that 409s forever.
    expect(captured.status).toBe(201);
    expect((captured.body as { target?: unknown }).target).toBeUndefined();
  });

  it('refuses to overwrite an existing draft', async () => {
    gh.fileExists.mockResolvedValue(true);

    const captured = await call('POST', { title: TITLE, date: '2026-10-01' });

    expect(captured.status).toBe(409);
    expect(captured.body).toEqual({ error: `${PATH} already exists`, code: 'destination_exists' });
    expect(gh.createFileIfAbsent).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a draft that appears during a lost ref race', async () => {
    // The window the pre-check cannot see: `fileExists` answered false, then a
    // competing commit landed before our write. A Git Data tree entry would
    // have replaced that file without raising anything, which is why creation
    // goes through the Contents API instead — GitHub refuses it with a 422 and
    // we report the conflict rather than discovering it later in the blog.
    gh.fileExists.mockResolvedValueOnce(false).mockResolvedValue(true);
    gh.createFileIfAbsent.mockRejectedValueOnce(
      new GitHubError(422, '{"message":"Update is not a fast forward"}'),
    );

    const captured = await call('POST', { title: TITLE, date: '2026-10-01' });

    expect(captured.status).toBe(409);
    expect(gh.createFileIfAbsent).toHaveBeenCalledTimes(1);
  });

  it('never retries a refused create, and leaves the target alone when it loses', async () => {
    // There is no rebuild path any more: a 422 here means the path is taken,
    // and re-sending the same create would either fail identically or, worse,
    // succeed against a file someone else is now using. Retrying is the bug.
    gh.createFileIfAbsent.mockRejectedValue(
      new GitHubError(422, '{"message":"Invalid request.\\n\\n\\"sha\\" wasn\'t supplied."}'),
    );

    const captured = await call('POST', {
      title: TITLE,
      date: '2026-10-01',
      setAsTarget: true,
    });

    expect(captured.status).toBe(409);
    expect(gh.createFileIfAbsent).toHaveBeenCalledTimes(1);
    // Repointing the target at a draft this request did not create would send
    // every later flush at someone else's file.
    expect(store.setTarget).not.toHaveBeenCalled();
  });

  it('rejects a bad title or a bad date before it touches GitHub', async () => {
    for (const body of [
      {},
      { title: '' },
      { title: '   ' },
      { title: 42 },
      { title: 'Autumn\nlayout: evil' },
      { title: '<b>Autumn</b>' },
      { title: '***' },
    ]) {
      const captured = await call('POST', body);
      expect(captured.status, JSON.stringify(body)).toBe(400);
      expect((captured.body as { code: string }).code).toBe('bad_title');
    }

    for (const date of ['20261001', '2026-13-01', '2026-02-31', 'today', 20261001]) {
      const captured = await call('POST', { title: TITLE, date });
      expect(captured.status, String(date)).toBe(400);
      expect((captured.body as { code: string }).code).toBe('bad_date');
    }

    const captured = await call('POST', { title: TITLE, setAsTarget: 'yes' });
    expect(captured.status).toBe(400);

    expect(gh.createFileIfAbsent).not.toHaveBeenCalled();
    expect(gh.fileExists).not.toHaveBeenCalled();
  });

  it('leaves the draft picker working', async () => {
    gh.listDir.mockResolvedValue([{ name: FILENAME, path: PATH, sha: 'blob-sha', size: 1 }]);
    gh.readFile.mockResolvedValue({ sha: 'blob-sha', size: GOLDEN.length, text: GOLDEN });

    const captured = await call('GET');

    expect(captured.status).toBe(200);
    expect(captured.body).toEqual([
      {
        id: encodeDraftId(FILENAME),
        filename: FILENAME,
        path: PATH,
        title: TITLE,
        curated: true,
      },
    ]);
  });

  it('answers 405 with an Allow header for a method it does not serve', async () => {
    const captured = await call('DELETE');
    expect(captured.status).toBe(405);
    expect(captured.headers.Allow).toBe('GET, POST, OPTIONS');
  });
});
