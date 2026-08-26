import { describe, expect, it } from 'vitest';
import { TRACKING_PARAMS, normalizeUrl, urlKey } from '../api/_lib/urlnorm.js';

/**
 * Every URL quoted here is a real one from magudb.github.io. The collision
 * cases are the ones that would silently swallow a link, so they are asserted
 * on the key rather than on the normalised string.
 */

function collides(a: string, b: string): boolean {
  return urlKey(a) === urlKey(b);
}

describe('normalizeUrl', () => {
  it('collapses scheme, www and a trailing slash', () => {
    expect(normalizeUrl('https://www.Example.com/foo/')).toBe('http://example.com/foo');
    expect(collides('http://example.com/foo', 'https://example.com/foo')).toBe(true);
    expect(collides('https://www.example.com/foo', 'https://example.com/foo')).toBe(true);
    expect(collides('https://example.com/foo/', 'https://example.com/foo')).toBe(true);
  });

  it('treats a bare host and a bare host with a slash as one', () => {
    expect(normalizeUrl('https://example.com')).toBe('http://example.com');
    expect(collides('https://example.com', 'https://example.com/')).toBe(true);
  });

  it('strips only ONE trailing slash', () => {
    expect(normalizeUrl('https://example.com/foo//')).toBe('http://example.com/foo/');
  });

  it('strips default ports', () => {
    expect(collides('https://example.com:443/foo', 'http://example.com/foo')).toBe(true);
    expect(collides('http://example.com:80/foo', 'https://example.com/foo')).toBe(true);
    expect(normalizeUrl('http://example.com:3001/foo')).toBe('http://example.com:3001/foo');
  });

  it('keeps the path case — only the host is lowercased', () => {
    expect(normalizeUrl('https://Example.com/Foo/Bar')).toBe('http://example.com/Foo/Bar');
  });
});

describe('tracking parameters', () => {
  it('collapses the same article with and without utm_ attribution', () => {
    // Both forms are in the corpus; the emitted URL keeps the utm_ params.
    const withUtm =
      'https://alifeengineered.substack.com/p/get-up-to-speed-unbelievably-fast-712?utm_source=bonobopress&utm_medium=newsletter&utm_campaign=2337';
    const without = 'https://alifeengineered.substack.com/p/get-up-to-speed-unbelievably-fast-712';
    expect(collides(withUtm, without)).toBe(true);
  });

  it('strips every name on the denylist', () => {
    for (const param of TRACKING_PARAMS) {
      expect(collides(`https://example.com/a?${param}=x`, 'https://example.com/a')).toBe(true);
    }
  });

  it('matches denylisted names case-insensitively', () => {
    expect(collides('https://example.com/a?FBCLID=x', 'https://example.com/a')).toBe(true);
    expect(collides('https://example.com/a?hsCtaTracking=x', 'https://example.com/a')).toBe(true);
    expect(collides('https://example.com/a?UTM_Source=x', 'https://example.com/a')).toBe(true);
  });

  it('preserves "source", which is load-bearing routing state', () => {
    expect(TRACKING_PARAMS).not.toContain('source');
    expect(normalizeUrl('https://example.com/a?source=rss')).toBe('http://example.com/a?source=rss');
    expect(collides('https://example.com/a?source=rss', 'https://example.com/a')).toBe(false);
  });

  it('never strips the whole query: distinct YouTube videos stay distinct', () => {
    const a = 'https://www.youtube.com/watch?v=0fpDlAEQio4';
    const b = 'https://www.youtube.com/watch?v=2nDNMB_wXcE';
    const c = 'https://www.youtube.com/watch?time_continue=2&v=jU_fq_VRS0w';
    expect(collides(a, b)).toBe(false);
    expect(collides(a, c)).toBe(false);
    expect(collides(b, c)).toBe(false);
  });

  it('still folds YouTube share tracking onto the video it points at', () => {
    // `feature` and `si` are share decorations, `v` is the identity.
    expect(
      collides(
        'https://www.youtube.com/watch?feature=youtu.be&v=pjKNx41Ubxw',
        'https://www.youtube.com/watch?v=pjKNx41Ubxw',
      ),
    ).toBe(true);
    expect(
      collides(
        'https://youtu.be/pjKNx41Ubxw?si=abcd1234',
        'https://youtu.be/pjKNx41Ubxw',
      ),
    ).toBe(true);
  });

  it('keeps every DotNetRocks episode separate', () => {
    expect(
      collides(
        'http://www.dotnetrocks.com/default.aspx?showNum=1000',
        'http://www.dotnetrocks.com/default.aspx?showNum=1001',
      ),
    ).toBe(false);
  });

  it('sorts remaining parameters so reordering is not a new link', () => {
    expect(collides('https://example.com/a?b=2&a=1', 'https://example.com/a?a=1&b=2')).toBe(true);
    expect(normalizeUrl('https://example.com/a?b=2&a=1')).toBe('http://example.com/a?a=1&b=2');
  });

  it('does not confuse a parameter value with its name', () => {
    expect(collides('https://example.com/a?x=1', 'https://example.com/a?x=2')).toBe(false);
  });
});

describe('fragments', () => {
  it('does NOT collapse the two love2dev hashbang articles', () => {
    const a = 'http://www.love2dev.com/#!article/Time-to-First-Byte-Why-It-is-Important-and-How-You-Can-Improve-Your-Time';
    const b = 'http://love2dev.com/#!article/Large-JavaScript-Frameworks-Are-Like-Fast-Food-Restaurants';
    expect(collides(a, b)).toBe(false);
    expect(normalizeUrl(a)).toContain('#!article/Time-to-First-Byte');
  });

  it('keeps a hash-router fragment', () => {
    expect(normalizeUrl('https://example.com/#/dashboard')).toBe('http://example.com#/dashboard');
    expect(collides('https://example.com/#/a', 'https://example.com/#/b')).toBe(false);
  });

  it('strips a plain fragment', () => {
    // Medium's `#.bgozig15l` and CIO's `#tk.rss_itstrategy` are pure noise.
    expect(collides('https://medium.com/p/abc#.bgozig15l', 'https://medium.com/p/abc')).toBe(true);
    expect(collides('https://example.com/a#section-2', 'https://example.com/a')).toBe(true);
  });

  it('leaves percent-encoding inside a kept fragment alone', () => {
    expect(normalizeUrl('http://www.love2dev.com/#!article/5%20Steps%20Toward%20Modern')).toBe(
      'http://love2dev.com#!article/5%20Steps%20Toward%20Modern',
    );
  });
});

describe('malformed input', () => {
  it('falls back instead of throwing', () => {
    expect(() => normalizeUrl('not a url at all')).not.toThrow();
    expect(normalizeUrl('  Not A URL At All  ')).toBe('not a url at all');
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('   ')).toBe('');
    expect(normalizeUrl('http://')).toBe('http://');
    expect(normalizeUrl('://///')).toBe('://///');
  });

  it('survives a non-string at runtime', () => {
    expect(normalizeUrl(undefined as unknown as string)).toBe('');
    expect(normalizeUrl(null as unknown as string)).toBe('');
  });

  it('leaves a non-http scheme alone', () => {
    expect(normalizeUrl('mailto:Someone@Example.com')).toBe('mailto:someone@example.com');
  });
});

describe('urlKey', () => {
  it('is a sha256 hex digest', () => {
    expect(urlKey('https://example.com/a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls', () => {
    expect(urlKey('https://example.com/a')).toBe(urlKey('https://example.com/a'));
  });

  it('never throws on garbage', () => {
    expect(() => urlKey('¯\\_(ツ)_/¯')).not.toThrow();
  });
});
