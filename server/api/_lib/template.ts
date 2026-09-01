/**
 * The skeleton for a brand-new Curated Insights draft.
 *
 * Every byte here was read off the corpus — the live draft plus the two most
 * recent published quarters — and not one of the oddities is decorative:
 *
 * - SECTION ORDER is favorites, agile, development, ai, devops, tools. That is
 *   NOT the order of the `CATEGORIES` array (which runs ... devops, tools, ai),
 *   and the array must never be used to lay this file out. The array is a
 *   lookup table keyed by anchor; this is a transcription of the corpus.
 * - `favorites` is the h1 that opens the post; the other five are h2.
 * - A SPACE precedes `<a name=` on `development` and `tools` only. The corpus is
 *   inconsistent about it, and reproducing the inconsistency is what keeps the
 *   quarterly diff boring — anchors are what the flush matches on, so the
 *   surrounding whitespace is free to be ugly but must not be "fixed".
 * - `description` and `keywords` stay empty; the author fills them in at publish
 *   time. There is no `date:` field anywhere in this blog — the filename prefix
 *   is the only source of a post's date.
 * - The markdownlint comment is load-bearing: MD033 (inline HTML) and MD025
 *   (multiple h1) would otherwise flag every file in the repo.
 *
 * The flush routes a link by looking up `<a name="...">`, so a typo in an anchor
 * here would not fail loudly — it would create drafts that silently report every
 * link in that category as unroutable. `test/template.test.ts` therefore runs the
 * real markdown module over this output and asserts all six anchors accept a
 * bullet.
 */

import { escapeYamlDoubleQuoted } from './markdown.js';
import { HttpError } from './http.js';

/**
 * Long enough for the real titles (the longest in the corpus is 92 characters)
 * and short enough that the front matter stays one readable line. The slug is
 * capped at 80 by `slugify` regardless, so a longer title only affects display.
 */
const MAX_TITLE_LENGTH = 200;

/**
 * The publish-time fields. `description` is the one Jekyll renders into the
 * page's meta tag, where search engines truncate around 160 — 300 leaves room
 * to be a little long without letting an AI answer run to an essay. `keywords`
 * is a comma-separated list and stays on one readable line.
 */
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_KEYWORDS_LENGTH = 200;

/** Newlines, tabs, NUL and every other control byte. See `normalizeDraftTitle`. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const FRONT_MATTER_HEAD = ['---', 'layout: post'] as const;

const FRONT_MATTER_TAIL = [
  'description: ""',
  'comments: false',
  'category: "Curated Insights"',
  'keywords: ""',
  '---',
  '<!-- markdownlint-disable MD033 MD020 MD025-->',
] as const;

/**
 * Corpus order, corpus spelling, corpus whitespace. Written out as whole heading
 * lines rather than assembled from parts so that a diff against a real file is a
 * literal string comparison.
 */
const SECTIONS: ReadonlyArray<{ anchor: string; heading: string }> = Object.freeze([
  { anchor: 'favorites', heading: '# My favorites<a name="favorites"></a>' },
  { anchor: 'agile', heading: '## Agile, Leadership and Product<a name="agile"></a>' },
  {
    anchor: 'development',
    // Space before the anchor — deliberate, see the header comment.
    heading:
      '## Architecture, Development & Software development practices <a name="development"></a>',
  },
  { anchor: 'ai', heading: '## AI, LLM & Machine Learning<a name="ai"></a>' },
  { anchor: 'devops', heading: '## DevOps, Observability & Security<a name="devops"></a>' },
  // Space before the anchor here too.
  { anchor: 'tools', heading: '## Tools and things from Github <a name="tools"></a>' },
]);

/** The anchors this template emits, in file order. Exported for tests and callers
 *  that want to report which sections a new draft will accept links into. */
export const TEMPLATE_ANCHORS: readonly string[] = Object.freeze(SECTIONS.map((s) => s.anchor));

/**
 * THE YAML TRAP, and the decision: **escape**, not reject, for the two characters
 * that YAML itself defines an escape for — `\` and `"`. A double quote closes
 * `title: "..."` early and Jekyll then fails the build of the *whole site*, not
 * just this file.
 *
 * Escaping (rather than rejecting) is chosen because it round-trips: the reader
 * on the other side, `unquote()` in markdown.ts, reverses exactly `\"` and `\\`
 * and nothing else. So `frontMatterTitle(newDraftBody(t)) === t` holds, which is
 * what `GET /api/drafts` shows the user and what a later publish slugifies.
 *
 * `escapeYamlDoubleQuoted` itself lives in markdown.ts, next to the `unquote` it
 * is the inverse of — a publish rewrites these same scalars, and two copies of
 * an escaping rule is one copy too many.
 *
 * The characters that are NOT escaped are rejected instead, because escaping
 * them would not round-trip:
 *
 * - A newline or any other control character cannot survive a single-line
 *   double-quoted scalar. YAML spells one `\n`, but `unquote()` only reverses
 *   `\"` and `\\`, so the value would come back with a literal backslash-n in
 *   it — and a raw newline would end the scalar and inject an arbitrary line
 *   into the front matter.
 * - `<` and `>` are legal YAML, but Jekyll renders `page.title` into the layout
 *   unescaped, so they would be markup on the published page rather than text.
 *   `sanitizeText` in markdown.ts strips them from bullet text for the same
 *   reason; here a 400 is friendlier than silently editing the user's words.
 *
 * Ampersands, apostrophes, colons and commas are all fine inside a double-quoted
 * scalar and are left exactly as typed — real titles are full of them
 * ("Architecture, Development & Software development practices"), and so is a
 * keyword list.
 */
function normalizeScalar(
  raw: unknown,
  field: { label: string; code: string; maxLength: number; allowEmpty?: boolean },
): string {
  const Label = field.label[0].toUpperCase() + field.label.slice(1);
  const fail = (message: string): HttpError => new HttpError(400, message, field.code);

  if (typeof raw !== 'string') {
    throw fail(`A ${field.label} is required`);
  }
  // Trimmed first, so a value pasted with a trailing newline is accepted rather
  // than rejected by the control-character rule below.
  const value = raw.trim();
  if (value === '') {
    // Only a title is mandatory. Blanking a description is a real edit: the
    // template ships one empty, and a publish may legitimately put it back.
    if (field.allowEmpty === true) return '';
    throw fail(`A ${field.label} is required`);
  }
  if (value.length > field.maxLength) {
    throw fail(`${Label} must be at most ${field.maxLength} characters`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw fail(`${Label} must be a single line with no control characters`);
  }
  if (/[<>]/.test(value)) {
    throw fail(`${Label} must not contain < or >`);
  }
  return value;
}

export function normalizeDraftTitle(raw: unknown): string {
  return normalizeScalar(raw, { label: 'title', code: 'bad_title', maxLength: MAX_TITLE_LENGTH });
}

/**
 * The two scalars a publish may rewrite besides the title.
 *
 * They go through the same filter as a title because they land in the same
 * place — a double-quoted YAML scalar in a file whose malformed front matter
 * fails the build of the whole site — and because their text now arrives from
 * an AI reading a page, which is the least trusted input this service has.
 */
export function normalizeDescription(raw: unknown): string {
  return normalizeScalar(raw, {
    label: 'description',
    code: 'bad_description',
    maxLength: MAX_DESCRIPTION_LENGTH,
    allowEmpty: true,
  });
}

export function normalizeKeywords(raw: unknown): string {
  return normalizeScalar(raw, {
    label: 'keywords',
    code: 'bad_keywords',
    maxLength: MAX_KEYWORDS_LENGTH,
    allowEmpty: true,
  });
}

/**
 * The body of a new draft, byte-for-byte, ending in exactly one newline.
 *
 * Validation runs here too, not only in the route: this string is committed to a
 * repository whose build breaks on a malformed front matter, so it must not be
 * possible to reach a commit with a title that never passed the check.
 */
export function newDraftBody(title: string): string {
  const safe = escapeYamlDoubleQuoted(normalizeDraftTitle(title));
  return (
    [
      ...FRONT_MATTER_HEAD,
      `title: "${safe}"`,
      ...FRONT_MATTER_TAIL,
      // One blank line after each heading, and none between the markdownlint
      // comment and the h1.
      SECTIONS.map((section) => section.heading).join('\n\n'),
    ].join('\n') + '\n'
  );
}
