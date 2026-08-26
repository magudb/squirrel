import { describe, expect, it } from 'vitest';

import { HttpError } from '../api/_lib/http.js';
import { requireUrl } from '../api/links/index.js';

/**
 * `requireUrl` validates with `new URL()` but hands back the raw string, so the
 * two have to agree character for character: whatever the parser quietly drops
 * or rewrites still reaches the draft, where the bullet is assembled by string
 * splice and a newline is a new physical line.
 */
function rejected(raw: unknown): HttpError {
  try {
    requireUrl(raw);
  } catch (err) {
    return err as HttpError;
  }
  throw new Error(`expected requireUrl to reject: ${String(raw)}`);
}

describe('requireUrl', () => {
  it('returns a normal url byte-for-byte, tracking parameters and all', () => {
    const url = 'https://example.com/a/b?utm_source=news&utm_medium=email&fbclid=xyz#top';
    expect(requireUrl(url)).toBe(url);
  });

  it('leaves a bare host alone rather than canonicalising it', () => {
    // `new URL(…).href` would answer `https://example.com/`; the published link
    // is the one the user saw.
    expect(requireUrl('https://Example.com')).toBe('https://Example.com');
  });

  it('trims surrounding whitespace instead of rejecting it', () => {
    expect(requireUrl('  https://example.com/a\n')).toBe('https://example.com/a');
  });

  it('rejects a newline the parser would have deleted', () => {
    const smuggled =
      'https://evil.example.com/a\n<script>alert(document.cookie)</script>\n[x](y';
    // The parser is perfectly happy with it — that is the whole problem.
    expect(new URL(smuggled).protocol).toBe('https:');

    const err = rejected(smuggled);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('bad_url');
  });

  it('rejects a tab', () => {
    expect(rejected('https://example.com/a\tb?x=1').status).toBe(400);
  });

  it('rejects angle brackets, which kramdown would read as markup', () => {
    expect(rejected('https://example.com/<script>alert(1)</script>').status).toBe(400);
  });

  it('rejects a quote', () => {
    expect(rejected('https://example.com/a"onmouseover="alert(1)').status).toBe(400);
  });

  it('rejects a backslash, which the parser turns into a path separator', () => {
    // Reads as `https://good.example.com/@evil.example.com` once parsed, so the
    // host that was validated is not the host the raw string displays.
    expect(rejected('https://good.example.com\\@evil.example.com').status).toBe(400);
  });

  it('rejects a control character the parser would percent-encode', () => {
    expect(rejected('https://example.com/a\u0007b').status).toBe(400);
  });

  it('still rejects what it always rejected', () => {
    expect(rejected('javascript:alert(1)').status).toBe(400);
    expect(rejected('/relative/path').status).toBe(400);
    expect(rejected('').status).toBe(400);
    expect(rejected(42).status).toBe(400);
  });
});
