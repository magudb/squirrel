import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyFrontMatter,
  existingUrlKeys,
  formatLink,
  frontMatterTitle,
  hasSection,
  insertLink,
  isCuratedInsights,
  lastBulletIndex,
  normalizeTrailingNewline,
  parseSections,
  pruneEmptySections,
} from '../api/_lib/markdown.js';
import { normalizeUrl } from '../api/_lib/urlnorm.js';

const NEW_BULLET = '- [A brand new link](https://new.example/post){:target="_blank"}';

/** The line the insert displaced, so a single-line splice is provable. */
function insertedAt(before: string, after: string): number {
  const a = before.split('\n');
  const b = after.split('\n');
  const i = b.findIndex((line, idx) => line !== a[idx]);
  return i === -1 ? b.length - 1 : i;
}

function assertOnlyInsertion(before: string, after: string, bullet: string): number {
  const a = before.split('\n');
  const b = after.split('\n');
  expect(b).toHaveLength(a.length + 1);
  const at = insertedAt(before, after);
  expect(b[at]).toBe(bullet);
  expect([...b.slice(0, at), ...b.slice(at + 1)]).toEqual(a);
  return at;
}

describe('formatLink', () => {
  it('replaces pipes, which would otherwise turn the list item into a table', () => {
    expect(formatLink({ title: 't', description: 'a | b', url: 'https://a.example' })).toBe(
      '- [a - b](https://a.example){:target="_blank"}',
    );
  });

  it('strips angle brackets, which would break or inject HTML', () => {
    expect(
      formatLink({ title: 't', description: 'a <b>bold</b> c', url: 'https://a.example' }),
    ).toBe('- [a bbold/b c](https://a.example){:target="_blank"}');
  });

  it('escapes square brackets as a pair', () => {
    expect(
      formatLink({
        title: 't',
        description: 'Design And Reality [Pdf/ipad/kindle]',
        url: 'https://a.example',
      }),
    ).toBe('- [Design And Reality \\[Pdf/ipad/kindle\\]](https://a.example){:target="_blank"}');
  });

  it('escapes a lone opening bracket too, never half a pair', () => {
    const out = formatLink({ title: 'Title [oops', url: 'https://a.example' });
    expect(out).toBe('- [Title \\[oops](https://a.example){:target="_blank"}');
  });

  it('escapes a backslash before the brackets, so the text cannot close the link early', () => {
    const out = formatLink({
      title: String.raw`x\](http://evil.example)`,
      url: 'https://real.example/a',
    });
    expect(out).toBe(
      String.raw`- [x\\\](http://evil.example)](https://real.example/a){:target="_blank"}`,
    );
  });

  it('doubles a trailing backslash, which would otherwise escape the closing bracket', () => {
    expect(formatLink({ title: 'Ends with a backslash\\', url: 'https://a.example' })).toBe(
      String.raw`- [Ends with a backslash\\](https://a.example){:target="_blank"}`,
    );
  });

  it('leaves parentheses in the link text alone', () => {
    expect(
      formatLink({ title: 't', description: 'Ship JS (1-16KB) handy', url: 'https://a.example' }),
    ).toBe('- [Ship JS (1-16KB) handy](https://a.example){:target="_blank"}');
  });

  it('leaves a URL with balanced parens bare', () => {
    expect(
      formatLink({ title: 'T', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' }),
    ).toBe('- [T](https://en.wikipedia.org/wiki/Foo_(bar)){:target="_blank"}');
  });

  it('never percent-encodes parens', () => {
    const out = formatLink({ title: 'T', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' });
    expect(out).not.toContain('%28');
    expect(out).not.toContain('%29');
  });

  it('wraps a URL with unbalanced parens in the angle-bracket form', () => {
    expect(formatLink({ title: 'T', url: 'https://a.example/x)y' })).toBe(
      '- [T](<https://a.example/x)y>){:target="_blank"}',
    );
  });

  it('wraps a URL containing whitespace in the angle-bracket form', () => {
    expect(formatLink({ title: 'T', url: 'https://a.example/a b' })).toBe(
      '- [T](<https://a.example/a b>){:target="_blank"}',
    );
  });

  it('percent-encodes < and >, which kramdown would cut the angle form short at', () => {
    expect(formatLink({ title: 'T', url: 'https://a.example/search?q=a>b' })).toBe(
      '- [T](https://a.example/search?q=a%3Eb){:target="_blank"}',
    );
    expect(formatLink({ title: 'T', url: 'https://a.example/p<x' })).toBe(
      '- [T](https://a.example/p%3Cx){:target="_blank"}',
    );
  });

  it('still uses the angle form when an encoded URL also carries whitespace', () => {
    expect(formatLink({ title: 'T', url: 'https://a.example/a b>c' })).toBe(
      '- [T](<https://a.example/a b%3Ec>){:target="_blank"}',
    );
  });

  it('prefers description, then selectedText, then title', () => {
    const link = {
      title: 'the title',
      selectedText: 'the selection',
      description: 'the description',
      url: 'https://a.example',
    };
    expect(formatLink(link)).toContain('[the description]');
    expect(formatLink({ ...link, description: undefined })).toContain('[the selection]');
    expect(formatLink({ ...link, description: '   ', selectedText: '' })).toContain('[the title]');
  });

  it('collapses whitespace in the link text', () => {
    expect(
      formatLink({ title: 't', description: '  Multi\n  line\t\ttext  ', url: 'https://a.example' }),
    ).toBe('- [Multi line text](https://a.example){:target="_blank"}');
  });

  it('glues the IAL to the closing paren', () => {
    expect(formatLink({ title: 'T', url: 'https://a.example' })).toMatch(/\)\{:target="_blank"\}$/);
  });
});

describe('parseSections', () => {
  it('ends a section at any heading level, h1 included', () => {
    const doc = [
      '# My favorites<a name="favorites"></a>',
      '- [a](https://a.example){:target="_blank"}',
      '# Second H1 section<a name="second"></a>',
      '- [s](https://s.example){:target="_blank"}',
      '### NodeJs <a name="nodejs"></a> ###',
      '- [n](https://n.example){:target="_blank"}',
      '',
    ].join('\n');

    const { sections } = parseSections(doc);
    expect(sections.map((s) => s.anchor)).toEqual(['favorites', 'second', 'nodejs']);
    expect(sections.map((s) => s.level)).toEqual([1, 1, 3]);
    expect(sections[0].bodyEnd).toBe(2);

    const out = insertLink(doc, 'favorites', NEW_BULLET).split('\n');
    expect(out[2]).toBe(NEW_BULLET);
  });

  it('finds sections by anchor across every whitespace variant in the corpus', () => {
    const headings = [
      '# My favorites<a name="favorites"></a>',
      '## Architecture, Development & Software development practices <a name="development"></a>',
      '## Agile, Leadership and Product<a name="agile"></a> ',
      '## DevOps<a name="devops"></a> ##',
      '## Tools and things from Github <a name="tools"></a> utilitas, firmitas, venustas ##',
    ];
    const doc = headings.flatMap((h) => [h, '- [x](https://x.example){:target="_blank"}', '']).join('\n');

    for (const anchor of ['favorites', 'development', 'agile', 'devops', 'tools']) {
      expect(hasSection(doc, anchor)).toBe(true);
      const after = insertLink(doc, anchor, NEW_BULLET);
      const at = assertOnlyInsertion(doc, after, NEW_BULLET);
      const { lines, sections } = parseSections(after);
      const section = sections.find((s) => s.anchor === anchor)!;
      expect(lastBulletIndex(lines, section)).toBe(at);
    }
  });

  it('preserves a heading with a trailing space byte-for-byte', () => {
    const doc = [
      '## Agile, Leadership and Product<a name="agile"></a> ',
      '- [a](https://a.example){:target="_blank"}',
      '',
    ].join('\n');
    expect(insertLink(doc, 'agile', NEW_BULLET)).toContain(
      '## Agile, Leadership and Product<a name="agile"></a> \n',
    );
  });

  it('ignores headings and bullets inside a fenced code block', () => {
    const doc = [
      '# My favorites<a name="favorites"></a>',
      '- [a](https://a.example){:target="_blank"}',
      '',
      '```md',
      '- [example from docs](https://docs.example){:target="_blank"}',
      '## deploy',
      '```',
      '',
      '- [c](https://c.example){:target="_blank"}',
      '',
      '## Tools and things from Github <a name="tools"></a>',
      '- [t](https://t.example){:target="_blank"}',
      '',
    ].join('\n');

    const { lines, sections } = parseSections(doc);
    expect(sections.map((s) => s.anchor)).toEqual(['favorites', 'tools']);
    expect(lastBulletIndex(lines, sections[0])).toBe(8);

    const after = insertLink(doc, 'favorites', NEW_BULLET);
    expect(assertOnlyInsertion(doc, after, NEW_BULLET)).toBe(9);
    expect(after).toContain('```md\n- [example from docs](https://docs.example){:target="_blank"}\n## deploy\n```');
  });

  it('treats a tilde fence as a fence too', () => {
    const doc = ['# F<a name="favorites"></a>', '~~~', '- not a bullet', '~~~', ''].join('\n');
    const { lines, sections } = parseSections(doc);
    expect(lastBulletIndex(lines, sections[0])).toBe(-1);
  });
});

describe('insertLink', () => {
  it('appends after a list item whose text does not start with a bracket', () => {
    const smart =
      '- Smart AI integration with the Model Context Protocol [Part 1](https://a.example/1){:target="_blank"}, [Part 2](https://a.example/2){:target="_blank"}';
    const doc = [
      '## Architecture, Development & Software development practices <a name="development"></a>',
      '- [a](https://a.example){:target="_blank"}',
      smart,
      '',
      '## Tools and things from Github <a name="tools"></a>',
      '- [t](https://t.example){:target="_blank"}',
      '',
    ].join('\n');

    const after = insertLink(doc, 'development', NEW_BULLET);
    expect(assertOnlyInsertion(doc, after, NEW_BULLET)).toBe(3);
  });

  it('appends after a legacy asterisk bullet', () => {
    const doc = ['# F<a name="favorites"></a>', '* [a](https://a.example)', '', '## T<a name="tools"></a>', ''].join('\n');
    const after = insertLink(doc, 'favorites', NEW_BULLET);
    expect(assertOnlyInsertion(doc, after, NEW_BULLET)).toBe(2);
  });

  it('does not corrupt an empty section that ends a file with no trailing newline', () => {
    const heading = '## Tools and things from Github <a name="tools"></a>';
    const doc = [
      '---',
      'layout: post',
      'title: "T"',
      'category: "Curated Insights"',
      '---',
      '# My favorites<a name="favorites"></a>',
      '- [a](https://a.example){:target="_blank"}',
      '',
      heading,
    ].join('\n');
    expect(doc.endsWith('\n')).toBe(false);

    const after = insertLink(doc, 'tools', NEW_BULLET);
    expect(after.endsWith(`${heading}\n${NEW_BULLET}\n`)).toBe(true);
    const lines = after.split('\n');
    expect(lines[lines.length - 3]).toBe(heading);
    expect(hasSection(after, 'tools')).toBe(true);
  });

  it('normalises the body to exactly one trailing newline', () => {
    const doc = '# F<a name="favorites"></a>\n- [a](https://a.example)\n\n\n';
    expect(insertLink(doc, 'favorites', NEW_BULLET).endsWith(`${NEW_BULLET}\n`)).toBe(true);
  });

  it('never touches the front matter', () => {
    const head = ['---', 'layout: post', 'title: "Keep | me <as> is"', '---'].join('\n');
    const doc = `${head}\n# F<a name="favorites"></a>\n- [a](https://a.example)\n`;
    expect(insertLink(doc, 'favorites', NEW_BULLET).startsWith(`${head}\n`)).toBe(true);
  });

  it('throws when the anchor is not in the file', () => {
    const doc = '# F<a name="favorites"></a>\n- [a](https://a.example)\n';
    expect(() => insertLink(doc, 'devops', NEW_BULLET)).toThrow(/section not found: devops/);
    expect(hasSection(doc, 'devops')).toBe(false);
  });
});

describe('existingUrlKeys', () => {
  it('extracts bare, angle-bracketed and padded destinations', () => {
    const doc = [
      '- [a](https://a.example/one){:target="_blank"}',
      '- [b](<https://b.example/two>){:target="_blank"}',
      '- [c]( https://c.example/three ){:target="_blank"}',
      '- Prose with [d](https://d.example/four){:target="_blank"} inline',
    ].join('\n');

    expect(existingUrlKeys(doc, (u) => u)).toEqual(
      new Set([
        'https://a.example/one',
        'https://b.example/two',
        'https://c.example/three',
        'https://d.example/four',
      ]),
    );
  });

  it('reads a destination whole when the URL itself contains parentheses', () => {
    const doc =
      '- [OWASP XSS](https://www.owasp.org/index.php/Cross-site_Scripting_(XSS)){:target="_blank"}';
    expect(existingUrlKeys(doc, (u) => u)).toEqual(
      new Set(['https://www.owasp.org/index.php/Cross-site_Scripting_(XSS)']),
    );
  });

  it('reads the angle form whole, spaces and unbalanced parens included', () => {
    const doc = [
      '- [a](<https://a.example/a b>){:target="_blank"}',
      '- [b](<https://b.example/x)y>){:target="_blank"}',
    ].join('\n');
    expect(existingUrlKeys(doc, (u) => u)).toEqual(
      new Set(['https://a.example/a b', 'https://b.example/x)y']),
    );
  });

  it('maps every destination through the supplied normaliser', () => {
    const doc = '- [a](https://A.example/One?utm_source=x){:target="_blank"}';
    const keys = existingUrlKeys(doc, (u) => u.toLowerCase().split('?')[0]);
    expect(keys).toEqual(new Set(['https://a.example/one']));
  });
});

/**
 * The dedupe that makes a re-flush safe is only as good as this: whatever
 * `formatLink` writes, `existingUrlKeys` has to read back as the same key the
 * pending link yields. A truncated destination silently re-appends the bullet
 * on every retry.
 */
describe('formatLink and existingUrlKeys round trip', () => {
  const doc = [
    '---',
    'category: "Curated Insights"',
    '---',
    '# My favorites<a name="favorites"></a>',
    '- [seed](https://seed.example){:target="_blank"}',
    '',
  ].join('\n');

  const urls: Array<[string, string]> = [
    ['a plain URL', 'https://a.example/post?utm_source=x'],
    ['balanced parens', 'https://www.owasp.org/index.php/Cross-site_Scripting_(XSS)'],
    ['unbalanced parens', 'https://a.example/x)y'],
    ['whitespace', 'https://a.example/a b'],
    ['an angle bracket', 'https://a.example/search?q=a>b'],
  ];

  for (const [name, url] of urls) {
    it(`recognises its own bullet again for ${name}`, () => {
      const after = insertLink(doc, 'favorites', formatLink({ title: 'T', url }));
      expect(existingUrlKeys(after, normalizeUrl).has(normalizeUrl(url))).toBe(true);
    });
  }
});

describe('front matter', () => {
  it('reads a double-quoted title', () => {
    expect(frontMatterTitle('---\ntitle: "Fall 2026: Links"\n---\nbody\n')).toBe('Fall 2026: Links');
  });

  it('reads a single-quoted title', () => {
    expect(frontMatterTitle("---\ntitle: 'Fall 2026: Links'\n---\nbody\n")).toBe('Fall 2026: Links');
  });

  it('reads an unquoted title', () => {
    expect(frontMatterTitle('---\nlayout: post\ntitle: Fall 2026 Links\n---\n')).toBe('Fall 2026 Links');
  });

  it('returns null when there is no front matter at all', () => {
    expect(frontMatterTitle('# Just a heading\n\nprose\n')).toBeNull();
  });

  it('returns null when the front matter carries no title', () => {
    expect(frontMatterTitle('---\nlayout: post\n---\nbody\n')).toBeNull();
  });

  it('parses the category rather than substring-matching the file', () => {
    expect(isCuratedInsights('---\ncategory: "Curated Insights"\n---\n')).toBe(true);
    expect(isCuratedInsights("---\ncategory: 'Curated Insights'\n---\n")).toBe(true);
    expect(isCuratedInsights('---\ncategory: "Devops"\n---\n')).toBe(false);
    expect(isCuratedInsights('---\nlayout: post\n---\ncategory: "Curated Insights"\n')).toBe(false);
    expect(isCuratedInsights('# no front matter\ncategory: "Curated Insights"\n')).toBe(false);
  });
});

describe('normalizeTrailingNewline', () => {
  it('adds the missing newline', () => {
    expect(normalizeTrailingNewline('a')).toBe('a\n');
  });

  it('collapses several trailing newlines and blanks', () => {
    expect(normalizeTrailingNewline('a\n\n\n')).toBe('a\n');
    expect(normalizeTrailingNewline('a  \n   \n')).toBe('a  \n');
  });

  it('leaves a well-formed body alone', () => {
    expect(normalizeTrailingNewline('a\n')).toBe('a\n');
  });

  // A `\s*$` would reach past the newlines and strip the tab off this heading.
  // _posts/2018-04-10-A good plan… ends on exactly such a line, and rewriting a
  // line we did not add is the one thing this module must never do.
  it('preserves trailing whitespace on the last line that has content', () => {
    expect(normalizeTrailingNewline('## Non Techy<a name="x"></a> ##\t\n\n')).toBe(
      '## Non Techy<a name="x"></a> ##\t\n',
    );
    expect(normalizeTrailingNewline('- [a](b) \n')).toBe('- [a](b) \n');
  });
});

describe('pruneEmptySections', () => {
  const doc = [
    '---',
    'category: "Curated Insights"',
    '---',
    '# My favorites<a name="favorites"></a>',
    '',
    '## Agile<a name="agile"></a>',
    '- [a](https://a.example){:target="_blank"}',
    '',
    '## DevOps<a name="devops"></a>',
    '',
    '',
    '## AI<a name="ai"></a>',
    '<!-- nothing worth linking this time -->',
    '',
    '## Tools<a name="tools"></a>',
    'Some prose that is not a bullet.',
    '',
  ].join('\n');

  it('keeps favorites even when it is empty, and drops the empty sections', () => {
    const { content, pruned } = pruneEmptySections(doc);
    expect(pruned).toEqual(['devops', 'ai']);
    expect(content).toContain('<a name="favorites"></a>');
    expect(content).toContain('<a name="agile"></a>');
    expect(content).toContain('<a name="tools"></a>');
    expect(content).not.toContain('<a name="devops"></a>');
    expect(content).not.toContain('<a name="ai"></a>');
    expect(content).not.toContain('nothing worth linking');
  });

  it('honours an explicit keep set', () => {
    const { pruned } = pruneEmptySections(doc, new Set(['devops']));
    expect(pruned).toEqual(['favorites', 'ai']);
  });

  it('leaves the front matter and the trailing newline well formed', () => {
    const { content } = pruneEmptySections(doc);
    expect(content.startsWith('---\ncategory: "Curated Insights"\n---\n')).toBe(true);
    expect(content.endsWith('\n')).toBe(true);
    expect(content.endsWith('\n\n')).toBe(false);
  });

  it('leaves a blank-line run the author wrote elsewhere in the file intact', () => {
    const spaced = [
      '# My favorites<a name="favorites"></a>',
      '- [a](https://a.example){:target="_blank"}',
      '',
      '',
      '',
      '## Agile<a name="agile"></a>',
      '- [b](https://b.example){:target="_blank"}',
      '',
      '## DevOps<a name="devops"></a>',
      '',
      '## Tools<a name="tools"></a>',
      '- [c](https://c.example){:target="_blank"}',
      '',
    ].join('\n');

    const { content, pruned } = pruneEmptySections(spaced);
    expect(pruned).toEqual(['devops']);
    expect(content).toBe(
      [
        '# My favorites<a name="favorites"></a>',
        '- [a](https://a.example){:target="_blank"}',
        '',
        '',
        '',
        '## Agile<a name="agile"></a>',
        '- [b](https://b.example){:target="_blank"}',
        '',
        '## Tools<a name="tools"></a>',
        '- [c](https://c.example){:target="_blank"}',
        '',
      ].join('\n'),
    );
  });

  it('does not reflow blank lines inside a fenced code block', () => {
    const fenced = [
      '# F<a name="favorites"></a>',
      '```go',
      'func a() {}',
      '',
      '',
      'func b() {}',
      '```',
      '',
      '## DevOps<a name="devops"></a>',
      '',
    ].join('\n');

    const { content, pruned } = pruneEmptySections(fenced);
    expect(pruned).toEqual(['devops']);
    expect(content).toContain('func a() {}\n\n\nfunc b() {}');
  });

  it('returns a file with nothing to prune byte-for-byte', () => {
    const untouched = [
      '# F<a name="favorites"></a>',
      '- [a](https://a.example){:target="_blank"}',
      '',
      '',
      '## Tools<a name="tools"></a>',
      '- [t](https://t.example){:target="_blank"}',
      '',
    ].join('\n');

    const { content, pruned } = pruneEmptySections(untouched);
    expect(pruned).toEqual([]);
    expect(content).toBe(untouched);
  });

  it('does not count a bullet inside a code fence as content', () => {
    const fenced = [
      '# F<a name="favorites"></a>',
      '- [a](https://a.example)',
      '',
      '## DevOps<a name="devops"></a>',
      '```',
      '- [not real](https://x.example)',
      '```',
      '',
    ].join('\n');
    const { pruned } = pruneEmptySections(fenced);
    expect(pruned).toEqual([]);
  });
});

const DRAFT_PATH =
  '/home/mlu/Documents/project/magudb.github.io/_drafts/' +
  '2026-08-01-Tech Digest: Summer 2026 Tech Links: Architecture Engineering Leadership and Go Tooling copy.md';
const PROSE_DRAFT_PATH = '/home/mlu/Documents/project/magudb.github.io/_drafts/2025-06-20-on AI.md';

const draft = existsSync(DRAFT_PATH) ? readFileSync(DRAFT_PATH, 'utf8') : null;
const golden = draft === null ? describe.skip : describe;

golden('golden: the real curated draft', () => {
  const content = draft as string;

  it('inserts as the last bullet of a populated section and changes nothing else', () => {
    const after = insertLink(content, 'ai', NEW_BULLET);
    const at = assertOnlyInsertion(content, after, NEW_BULLET);

    const { lines, sections } = parseSections(after);
    const ai = sections.find((s) => s.anchor === 'ai')!;
    expect(lastBulletIndex(lines, ai)).toBe(at);
    expect(at).toBeGreaterThan(ai.bodyStart);
    expect(at).toBeLessThan(ai.bodyEnd);
  });

  it('inserts into the empty devops section without touching the headings', () => {
    const after = insertLink(content, 'devops', NEW_BULLET);
    const at = assertOnlyInsertion(content, after, NEW_BULLET);

    const { lines, sections } = parseSections(after);
    const devops = sections.find((s) => s.anchor === 'devops')!;
    expect(at).toBe(devops.bodyStart);
    expect(lastBulletIndex(lines, devops)).toBe(devops.bodyStart);
    expect(after).toContain('## DevOps, Observability & Security<a name="devops"></a>\n');
    expect(after).toContain('## Tools and things from Github <a name="tools"></a>\n');
  });

  it('exposes every section anchor in file order', () => {
    const { sections } = parseSections(content);
    expect(sections.map((s) => s.anchor)).toEqual([
      'favorites',
      'agile',
      'development',
      'ai',
      'devops',
      'tools',
    ]);
    expect(sections[0].level).toBe(1);
    expect(sections.slice(1).every((s) => s.level === 2)).toBe(true);
  });

  it('reads the front matter', () => {
    expect(frontMatterTitle(content)).toBe(
      'Fall 2026 Tech Links: Architecture, Engineering Leadership, AI Agents, and Go Tooling',
    );
    expect(isCuratedInsights(content)).toBe(true);
  });

  it('collects every existing destination', () => {
    const keys = existingUrlKeys(content, (u) => u);
    expect(keys.size).toBe(content.split('\n').filter((l) => l.startsWith('- [')).length);
    for (const key of keys) expect(key).toMatch(/^https?:\/\//);
  });

  it('prunes devops and keeps favorites', () => {
    const { content: pruned, pruned: anchors } = pruneEmptySections(content);
    expect(anchors).toEqual(['devops']);
    expect(pruned).toContain('<a name="favorites"></a>');
    expect(pruned).not.toContain('<a name="devops"></a>');
    expect(pruned).not.toContain('DevOps, Observability & Security');
    for (const line of content.split('\n').filter((l) => l.startsWith('- ['))) {
      expect(pruned).toContain(line);
    }
  });
});

(existsSync(PROSE_DRAFT_PATH) ? it : it.skip)('tolerates a draft with no front matter', () => {
  const prose = readFileSync(PROSE_DRAFT_PATH, 'utf8');
  expect(() => frontMatterTitle(prose)).not.toThrow();
  expect(frontMatterTitle(prose)).toBeNull();
  expect(isCuratedInsights(prose)).toBe(false);
});

/**
 * Writing the front matter back.
 *
 * `frontMatterTitle` is the reader; these cover the writer's side of the same
 * round trip, and the one rule the rest of this module lives by — a line we did
 * not name comes back byte for byte.
 */
describe('applyFrontMatter', () => {
  const FILE = ['---', 'layout: post', 'title: "Old"', 'description: ""', '---', '', '# Body'].join(
    '\n',
  );

  it('round-trips through the reader, escaping and all', () => {
    const written = applyFrontMatter(FILE, { title: 'Quarter "three" \\ 2026' });
    expect(frontMatterTitle(written ?? '')).toBe('Quarter "three" \\ 2026');
  });

  it('returns the file untouched when the patch names nothing', () => {
    expect(applyFrontMatter(FILE, {})).toBe(FILE);
  });

  it('is null for a file with no front matter, rather than inventing one', () => {
    expect(applyFrontMatter('# Just a heading\n', { title: 'X' })).toBeNull();
  });

  it('leaves the body alone', () => {
    const written = applyFrontMatter(FILE, { title: 'New' }) ?? '';
    expect(written.endsWith('---\n\n# Body')).toBe(true);
  });

  it('keeps a CRLF file on CRLF', () => {
    const crlf = FILE.replace(/\n/g, '\r\n');
    const written = applyFrontMatter(crlf, { title: 'New', keywords: 'a, b' }) ?? '';
    expect(written).toContain('title: "New"\r\n');
    // The appended key gets the file's line ending too, not the platform's.
    expect(written).toContain('keywords: "a, b"\r\n');
    expect(written).not.toMatch(/[^\r]\n/);
  });

  it('normalises the separator on a line it rewrites', () => {
    // `description:` with no value would otherwise become `description:"..."`,
    // which YAML reads as a plain scalar and Jekyll fails the build over.
    const written = applyFrontMatter('---\nlayout: post\ndescription:\n---\n', {
      description: 'Set',
    });
    expect(written).toContain('description: "Set"');
  });
});
