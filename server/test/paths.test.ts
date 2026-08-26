import { describe, expect, it } from 'vitest';
import { HttpError } from '../api/_lib/http.js';
import {
  assertWritablePath,
  decodeDraftId,
  draftRefFromFile,
  encodeDraftId,
  postPathFor,
  slugify,
} from '../api/_lib/paths.js';

/** Both real files in `_drafts/`. Spaces and colons are the whole point. */
const REAL_DRAFTS = [
  '2025-06-20-on AI.md',
  '2026-08-01-Tech Digest: Summer 2026 Tech Links: Architecture Engineering Leadership and Go Tooling copy.md',
];

function expectBadRequest(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, 'expected a 400 to be thrown').toBeInstanceOf(HttpError);
  expect((thrown as HttpError).status).toBe(400);
}

describe('draft ids', () => {
  it('round-trips the real filenames, spaces and colons included', () => {
    for (const filename of REAL_DRAFTS) {
      const id = encodeDraftId(filename);
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeDraftId(id)).toBe(filename);
      expect(() => assertWritablePath(`_drafts/${filename}`)).not.toThrow();
    }
  });

  it('produces url-safe ids with no padding', () => {
    // A filename whose length is not a multiple of 3 would pad under base64.
    expect(encodeDraftId('ab.md')).not.toContain('=');
    expect(encodeDraftId('ab.md')).not.toContain('+');
    expect(encodeDraftId('ab.md')).not.toContain('/');
  });

  it('rejects an id that decodes to a traversal', () => {
    const attempts = [
      '../_config.yml',
      '../../etc/passwd',
      '/etc/passwd',
      '/_posts/x.md',
      '_drafts/x.md',
      '..\\_config.yml',
      '..',
      '.',
      'a\u0000.md',
      'a\nb.md',
      '%2e%2e%2fx.md',
      '..%2f_config.yml',
      'x%20y.md',
      '....//x.md',
    ];
    for (const filename of attempts) {
      expectBadRequest(() => decodeDraftId(encodeDraftId(filename)));
    }
  });

  it('rejects an id for a file that is not markdown', () => {
    for (const filename of ['notes.txt', 'Gemfile', '_config.yml', 'x.md.txt', 'x.mdx']) {
      expectBadRequest(() => decodeDraftId(encodeDraftId(filename)));
    }
  });

  it('rejects anything that is not canonical base64url', () => {
    for (const id of [
      '',
      'not base64',
      'a!b',
      'YS5tZA==', // padded
      'YS5tZ+8', // standard-base64 alphabet
      'YS5tZ/8',
      '../etc',
      'YS5tZA=', // truncated padding
    ]) {
      expectBadRequest(() => decodeDraftId(id));
    }
  });

  it('rejects a non-string id at runtime', () => {
    expectBadRequest(() => decodeDraftId(undefined as unknown as string));
    expectBadRequest(() => decodeDraftId(null as unknown as string));
  });
});

describe('assertWritablePath', () => {
  it('accepts the two directories it is allowed to write', () => {
    expect(() => assertWritablePath('_posts/2026-08-01-tech-links.md')).not.toThrow();
    expect(() => assertWritablePath('_drafts/2026-08-01-tech-links.md')).not.toThrow();
    expect(() => assertWritablePath('_drafts/legacy.markdown')).not.toThrow();
  });

  it('refuses the files that would take over the site', () => {
    const attempts = [
      '.github/workflows/build-and-deploy.yml',
      '.github/workflows/x.md',
      '_config.yml',
      '_config_dev.yml',
      'Gemfile',
      'Gemfile.lock',
      '_layouts/post.html',
      '_layouts/x.md',
      '_includes/head.html',
      'assets/js/app.js',
      'assets/x.md',
      'scripts/deploy.sh',
      'scripts/x.md',
    ];
    for (const path of attempts) {
      expectBadRequest(() => assertWritablePath(path));
    }
  });

  it('refuses every traversal shape', () => {
    const attempts = [
      '../_config.yml',
      '../../_config.yml',
      '_posts/../_config.yml',
      '_drafts/../../etc/passwd',
      '_drafts/..%2f_config.yml',
      '_posts/%2e%2e/_config.yml',
      '_drafts\\..\\_config.yml',
      '_posts\\x.md',
      '_drafts/sub\\x.md',
      '/_posts/x.md',
      '/etc/passwd',
      '_posts/x\u0000.md',
      '_posts/x\n.md',
      '_drafts/nested/x.md',
      './_posts/x.md',
    ];
    for (const path of attempts) {
      expectBadRequest(() => assertWritablePath(path));
    }
  });

  it('refuses a bare filename with no directory', () => {
    expectBadRequest(() => assertWritablePath('2026-08-01-tech-links.md'));
    expectBadRequest(() => assertWritablePath('2025-06-20-on AI.md'));
  });

  it('refuses a path that only looks like an allowed one', () => {
    expectBadRequest(() => assertWritablePath('_postsx/x.md'));
    expectBadRequest(() => assertWritablePath('x_posts/x.md'));
    expectBadRequest(() => assertWritablePath('_posts'));
    expectBadRequest(() => assertWritablePath('_posts/'));
    expectBadRequest(() => assertWritablePath('_drafts/'));
    expectBadRequest(() => assertWritablePath(''));
  });

  it('refuses the wrong extension', () => {
    expectBadRequest(() => assertWritablePath('_drafts/x.txt'));
    expectBadRequest(() => assertWritablePath('_drafts/x.yml'));
    // Posts are generated by postPathFor, which only ever emits .md.
    expectBadRequest(() => assertWritablePath('_posts/x.markdown'));
  });

  it('refuses a percent sign rather than decoding it', () => {
    expectBadRequest(() => assertWritablePath('_posts/100%25.md'));
  });

  it('refuses a non-string path at runtime', () => {
    expectBadRequest(() => assertWritablePath(undefined as unknown as string));
  });
});

describe('slugify', () => {
  it('kebabs the real draft title', () => {
    const slug = slugify(
      'Fall 2026 Tech Links: Architecture, Engineering Leadership, AI Agents, and Go Tooling',
    );
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(slug).not.toMatch(/-$/);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).toBe(
      'fall-2026-tech-links-architecture-engineering-leadership-ai-agents-and-go-toolin',
    );
  });

  it('reproduces a slug the author already published by hand', () => {
    expect(slugify("AI doesn't fix a team, it amplifies what’s there")).toBe(
      'ai-doesnt-fix-a-team-it-amplifies-whats-there',
    );
  });

  it('drops apostrophes rather than splitting the word', () => {
    expect(slugify("Don't Panic")).toBe('dont-panic');
    expect(slugify('Don’t Panic')).toBe('dont-panic');
    expect(slugify('Don‘t Panic')).toBe('dont-panic');
  });

  it('folds accents to ASCII', () => {
    expect(slugify('Café Déjà Vu')).toBe('cafe-deja-vu');
  });

  it('collapses runs and trims the ends', () => {
    expect(slugify('  --Hello,   World!!  ')).toBe('hello-world');
    expect(slugify('a & b / c')).toBe('a-b-c');
  });

  it('caps at 80 without leaving a trailing hyphen', () => {
    const slug = slugify('x '.repeat(50).trim());
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug).not.toMatch(/-$/);
    expect(slug).toBe('x-'.repeat(39) + 'x');
  });

  it('throws when nothing survives', () => {
    expectBadRequest(() => slugify('!!! ??? ---'));
    expectBadRequest(() => slugify('   '));
    expectBadRequest(() => slugify(''));
    expectBadRequest(() => slugify('日本語'));
    expectBadRequest(() => slugify(undefined as unknown as string));
  });
});

describe('postPathFor', () => {
  it('builds a path the write allowlist accepts', () => {
    const path = postPathFor('Winter 2026 Tech Links', new Date('2026-01-09T12:00:00Z'));
    expect(path).toBe('_posts/2026-01-09-winter-2026-tech-links.md');
    expect(() => assertWritablePath(path)).not.toThrow();
  });

  it('zero-pads month and day', () => {
    expect(postPathFor('X Y', new Date('2026-03-05T12:00:00Z'))).toBe('_posts/2026-03-05-x-y.md');
  });

  it('uses UTC date parts, not the runner timezone', () => {
    // Late UTC evening is already the next day east of Greenwich...
    expect(postPathFor('A B', new Date('2026-08-01T23:30:00Z'))).toBe('_posts/2026-08-01-a-b.md');
    // ...and just past UTC midnight is still the previous day to the west.
    expect(postPathFor('A B', new Date('2026-01-01T00:30:00Z'))).toBe('_posts/2026-01-01-a-b.md');
  });

  it('rejects an unusable date', () => {
    expectBadRequest(() => postPathFor('A B', new Date('nonsense')));
    expectBadRequest(() => postPathFor('A B', undefined as unknown as Date));
  });

  it('rejects a title with no slug in it', () => {
    expectBadRequest(() => postPathFor('***', new Date('2026-01-09T12:00:00Z')));
  });
});

describe('draftRefFromFile', () => {
  const CURATED = [
    '---',
    'layout: post',
    'title: "Fall 2026 Tech Links: Architecture, Engineering Leadership, AI Agents, and Go Tooling"',
    'description: ""',
    'comments: false',
    'category: "Curated Insights"',
    'keywords: ""',
    '---',
    '',
  ].join('\n');

  it('reads the title and category out of the front matter', () => {
    const ref = draftRefFromFile(REAL_DRAFTS[1], CURATED);
    expect(ref.title).toBe(
      'Fall 2026 Tech Links: Architecture, Engineering Leadership, AI Agents, and Go Tooling',
    );
    expect(ref.curated).toBe(true);
    expect(ref.path).toBe(`_drafts/${REAL_DRAFTS[1]}`);
    expect(decodeDraftId(ref.id)).toBe(REAL_DRAFTS[1]);
  });

  it('falls back to the filename when the body was not fetched', () => {
    const ref = draftRefFromFile(REAL_DRAFTS[0], null);
    expect(ref.title).toBe(REAL_DRAFTS[0]);
    expect(ref.curated).toBe(false);
    expect(ref.id).toBe(encodeDraftId(REAL_DRAFTS[0]));
  });

  it('tolerates a draft with no front matter at all', () => {
    // `_drafts/2025-06-20-on AI.md` really is plain prose.
    const ref = draftRefFromFile(REAL_DRAFTS[0], '# on AI\n\nsome prose\n');
    expect(ref.title).toBe(REAL_DRAFTS[0]);
    expect(ref.curated).toBe(false);
  });

  it('falls back when the front-matter title is blank', () => {
    const ref = draftRefFromFile('x.md', '---\nlayout: post\ntitle: ""\n---\n');
    expect(ref.title).toBe('x.md');
  });
});
