/**
 * Reading the three scalars a publish can rewrite out of a draft.
 *
 * A deliberate, minimal port of `frontMatterScalar` + `unquote` from
 * `server/api/_lib/markdown.ts`. The popup needs the values to show what the
 * file says today next to what the local AI proposes, and to hand the current
 * text to the review as its starting point — but it must never *write* front
 * matter. Only the service does that, in the commit that creates the post.
 *
 * Reading it here rather than having the service return the parsed fields keeps
 * the parse in one place on the wire: the endpoint answers with the file, and
 * the file is what the review reasons about.
 */

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Reverses exactly what `escapeYamlDoubleQuoted` writes, and nothing else. */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value === '') return '';
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    return quote === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(["\\])/g, '$1');
  }
  return value;
}

export interface FrontMatterFields {
  title: string;
  description: string;
  keywords: string;
}

const EMPTY: FrontMatterFields = { title: '', description: '', keywords: '' };

/**
 * Empty strings — not nulls — for a file with no front matter or a key it does
 * not carry. The caller is filling in a form, and the two cases produce the
 * same empty field; the service is the one that refuses to write into a draft
 * that has no block at all.
 */
export function readFrontMatter(content: string): FrontMatterFields {
  const match = FRONT_MATTER_RE.exec(content);
  if (match === null) return { ...EMPTY };

  const fields = { ...EMPTY };
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*?)[ \t]*\r?$/.exec(line);
    if (pair === null) continue;
    if (pair[1] === 'title' || pair[1] === 'description' || pair[1] === 'keywords') {
      fields[pair[1]] = unquote(pair[2]);
    }
  }
  return fields;
}

/** True when the draft has a block to write into at all. */
export function hasFrontMatter(content: string): boolean {
  return FRONT_MATTER_RE.test(content);
}
