/**
 * The markdown rules for the curated-links drafts.
 *
 * Ported from a reference implementation that was validated two ways: against
 * the whole 233-file blog corpus (952/954 bullets, 1861/1861 anchor headings)
 * and against kramdown 2.4.0, the renderer version pinned in the blog's
 * Gemfile.lock. Where the local backend (`src/blogBackend.js`) and this module
 * disagree, the backend has a verified bug — including one that tears the
 * anchor off a heading, whose preconditions both exist in the repo today.
 *
 * The governing constraint: a flush edits a file a human wrote and will read
 * again as a diff. So we splice exactly one line into a line array and rejoin,
 * and never reformat, re-wrap or "fix" a line we did not add. Trailing spaces
 * on headings, closed-ATX `##` suffixes and a stray `>>` typo are all
 * load-bearing by inertia.
 */

/** Any level. The first section of every post is an h1, so an `\n##` scan
 *  cannot see the next section and writes links into the wrong one. */
const HEADING_RE = /^(#{1,6})[ \t]*(.*?)[ \t]*$/;

/** Header text drifts — one section is spelled "Obeservability", another
 *  carries prose after the anchor. The anchor id is the only stable handle. */
const ANCHOR_RE = /<a\s+[^>]*\bname\s*=\s*(["'])([^"']+)\1[^>]*>/i;

/** `- [x]` misses a real corpus bullet that opens with prose, and misses the
 *  historic `* ` marker outright; both make an insert land one line too early. */
const LIST_ITEM_RE = /^[ \t]{0,3}[-*+][ \t]+/;

/** Mirrors `destination()`: either the angle form, or a bare destination that
 *  carries one level of balanced parens. A negated class would stop at the
 *  first `)` and read back a truncated key for the very URLs we emit bare. */
const LINK_URL_RE = /\]\(\s*(?:<([^<>]*)>|((?:[^()\s]|\([^()\s]*\))+))\s*\)/g;

const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const HTML_COMMENT_RE = /^<!--[\s\S]*-->$/;

export interface Section {
  headingLine: number;
  level: number;
  anchor: string | null;
  title: string;
  /** First line after the heading. */
  bodyStart: number;
  /** Exclusive: the next heading of any level, or end of body. */
  bodyEnd: number;
}

/**
 * kramdown verdicts, each established by rendering the case locally:
 * a `|` turns the whole `<li>` into a `<table>`; an unbalanced `<` or `>`
 * destroys the link and a balanced one injects raw HTML into the page; `\[`
 * renders as `[`, so escaping both brackets is output-identical to the corpus
 * and survives an unbalanced pair, while half-escaping breaks the link.
 * Parentheses need no escaping at all — 24 real link texts contain them.
 *
 * The backslash pass runs first and is not optional. This text is page-supplied
 * (a title, a selection, an AI description), so `x\]` would otherwise consume
 * our own escape, close the link text early and let the page choose the
 * destination of a link published under the author's byline.
 */
function sanitizeText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '-')
    .replace(/[<>]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/[\[\]]/g, '\\$&');
}

/**
 * kramdown handles balanced parens in a bare destination, and percent-encoding
 * them is not guaranteed equivalent per RFC 3986 §2.2 — it can 404 a working
 * link. The angle form is the escape hatch, used only when the bare form would
 * actually break: whitespace, or unbalanced parens.
 *
 * `<` and `>` cannot use that escape hatch, because kramdown ends an angle
 * destination at the first `>` — wrapping them makes the link worse, not
 * better. RFC 3986 excludes both from a URI outright, so unlike the parens
 * these are safe to percent-encode: `new URL()` emits the same two bytes, so
 * the dedupe key is unchanged either way.
 */
function destination(url: string): string {
  const trimmed = url.trim().replace(/</g, '%3C').replace(/>/g, '%3E');
  let depth = 0;
  let balanced = true;
  for (const ch of trimmed) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) balanced = false;
    }
  }
  if (depth !== 0) balanced = false;
  return /\s/.test(trimmed) || !balanced ? `<${trimmed}>` : trimmed;
}

/** The kramdown IAL must touch the closing paren: one space before `{:` and
 *  kramdown emits the literal `{:target="_blank"}` into the page. */
export function formatLink(link: {
  description?: string;
  selectedText?: string;
  title: string;
  url: string;
}): string {
  const text = sanitizeText(
    (link.description ?? '').trim() || (link.selectedText ?? '').trim() || link.title,
  );
  return `- [${text}](${destination(link.url)}){:target="_blank"}`;
}

function splitFrontMatter(content: string): { head: string; body: string } {
  const fm = FRONT_MATTER_RE.exec(content);
  return fm
    ? { head: content.slice(0, fm[0].length), body: content.slice(fm[0].length) }
    : { head: '', body: content };
}

/** Fence-aware split of a body (front matter already removed). */
export function parseSections(body: string): { lines: string[]; sections: Section[] } {
  const lines = body.split('\n');
  const heads: Array<Omit<Section, 'bodyStart' | 'bodyEnd'>> = [];
  let fence: string | null = null;

  lines.forEach((line, i) => {
    const f = FENCE_RE.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const h = HEADING_RE.exec(line);
    if (!h) return;
    const a = ANCHOR_RE.exec(h[2]);
    heads.push({
      headingLine: i,
      level: h[1].length,
      anchor: a ? a[2] : null,
      title: h[2].replace(ANCHOR_RE, '').replace(/\s*#+\s*$/, '').trim(),
    });
  });

  const sections: Section[] = heads.map((h, i) => ({
    ...h,
    bodyStart: h.headingLine + 1,
    bodyEnd: i + 1 < heads.length ? heads[i + 1].headingLine : lines.length,
  }));

  return { lines, sections };
}

/** Index of the section's last list item, or -1 when it has none. */
export function lastBulletIndex(lines: string[], s: Section): number {
  let fence: string | null = null;
  let last = -1;
  for (let i = s.bodyStart; i < s.bodyEnd; i++) {
    const f = FENCE_RE.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (LIST_ITEM_RE.test(lines[i])) last = i;
  }
  return last;
}

/**
 * Append after the section's last bullet, or directly under the heading when
 * the section is empty. Front matter is never touched.
 *
 * The body is normalised to exactly one trailing newline: an empty section at
 * EOF in a file that ends without one is precisely the shape that makes the
 * local backend splice the bullet into the middle of the heading.
 */
export function insertLink(content: string, anchor: string, bulletLine: string): string {
  const { head, body } = splitFrontMatter(content);
  const { lines, sections } = parseSections(body);
  const section = sections.find((s) => s.anchor === anchor);
  if (!section) throw new Error(`section not found: ${anchor}`);
  const last = lastBulletIndex(lines, section);
  lines.splice(last === -1 ? section.headingLine + 1 : last + 1, 0, bulletLine);
  return head + normalizeTrailingNewline(lines.join('\n'));
}

export function hasSection(content: string, anchor: string): boolean {
  const { body } = splitFrontMatter(content);
  return parseSections(body).sections.some((s) => s.anchor === anchor);
}

/**
 * Every link destination in the file, mapped through `normalize`.
 *
 * This is the authoritative dedupe: the buffer in Redis has never seen the
 * 15,374 bullets already in the corpus, and a raw `content.includes(url)` both
 * false-positives on prefix URLs and false-negatives on the same article
 * carrying different tracking params — the common case in this corpus.
 */
export function existingUrlKeys(content: string, normalize: (u: string) => string): Set<string> {
  const keys = new Set<string>();
  for (const m of content.matchAll(LINK_URL_RE)) {
    const url = m[1] ?? m[2];
    if (url) keys.add(normalize(url));
  }
  return keys;
}

/**
 * Publish-time tidy-up. A section is empty when it holds no list item and no
 * prose between its heading and the next heading of any level; blank-line
 * counts are never consulted, because the real files run 0-4 blanks before a
 * heading and 0-2 after. `favorites` is kept by default — it is the h1 that
 * opens the post.
 *
 * A removed span always runs from the heading to the next heading or EOF, so
 * the seam it leaves is the blank run the author already wrote in front of that
 * heading — never a longer one. There is nothing to reflow, and reflowing
 * anyway (a global `\n{3,}` collapse) rewrote deliberate spacing, and code
 * inside fences, in 44 corpus files where no section was pruned at all.
 */
export function pruneEmptySections(
  content: string,
  keep: Set<string> = new Set(['favorites']),
): { content: string; pruned: string[] } {
  const { head, body } = splitFrontMatter(content);
  const { lines, sections } = parseSections(body);
  const drop = new Set<number>();
  const pruned: string[] = [];

  for (const s of sections) {
    if (s.anchor !== null && keep.has(s.anchor)) continue;
    if (lastBulletIndex(lines, s) !== -1) continue;
    const hasProse = lines
      .slice(s.bodyStart, s.bodyEnd)
      .some((l) => l.trim() !== '' && !HTML_COMMENT_RE.test(l.trim()));
    if (hasProse) continue;
    for (let i = s.headingLine; i < s.bodyEnd; i++) drop.add(i);
    // An anchorless heading can only come from a hand-written draft; report
    // its text so the caller still has something to name in a commit message.
    pruned.push(s.anchor ?? s.title);
  }

  const kept = lines.filter((_, i) => !drop.has(i)).join('\n');
  return { content: head + normalizeTrailingNewline(kept), pruned };
}

function frontMatterScalar(content: string, key: string): string | null {
  const fm = FRONT_MATTER_RE.exec(content);
  if (!fm) return null;
  for (const line of fm[1].split('\n')) {
    const m = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*?)[ \t]*\r?$/.exec(line);
    if (!m || m[1] !== key) continue;
    return unquote(m[2]);
  }
  return null;
}

/** Titles in the corpus are double-quoted, but nothing enforces that. */
function unquote(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    return quote === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(["\\])/g, '$1');
  }
  return value;
}

/** Null when the file has no front matter at all — `_drafts/2025-06-20-on AI.md`
 *  is plain prose and any draft listing has to survive it. */
export function frontMatterTitle(content: string): string | null {
  return frontMatterScalar(content, 'title');
}

export function isCuratedInsights(content: string): boolean {
  return frontMatterScalar(content, 'category') === 'Curated Insights';
}

/**
 * Exactly one `\n` at EOF, no trailing blank lines. Applied to every body we
 * write, because an empty section at the end of a file with no final newline
 * gets a bullet spliced into its heading otherwise.
 *
 * Only newlines are stripped. A `\s*$` here would also eat trailing spaces or
 * tabs from the last content line — real headings in the corpus carry both, and
 * silently rewriting a line we did not add is the one thing this module must
 * never do.
 */
export function normalizeTrailingNewline(content: string): string {
  return content.replace(/(\n[ \t]*)+$/, '') + '\n';
}
