import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlogService } from '../utils/blogService';

describe('BlogService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  describe('formatLink', () => {
    it('should format link with selectedText when present', () => {
      const link = {
        id: '1',
        url: 'https://example.com',
        title: 'Example Title',
        selectedText: 'Selected text here',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      expect(result).toBe('- [Selected text here](https://example.com){:target="_blank"}');
    });

    it('should format link with title when selectedText is empty', () => {
      const link = {
        id: '1',
        url: 'https://example.com',
        title: 'Example Title',
        selectedText: '',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      expect(result).toBe('- [Example Title](https://example.com){:target="_blank"}');
    });

    it('should format link with title when selectedText is undefined', () => {
      const link = {
        id: '1',
        url: 'https://example.com',
        title: 'Example Title',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      expect(result).toBe('- [Example Title](https://example.com){:target="_blank"}');
    });

    // kramdown renders `\[` as `[`, so escaping the pair is output-identical to
    // the corpus and survives an unbalanced bracket. Parentheses render fine on
    // their own and appear unescaped in 24 real bullets — escaping them would
    // put a stray backslash into the published post.
    it('should escape brackets but leave parentheses alone', () => {
      const link = {
        id: '1',
        url: 'https://example.com',
        title: 'Title [with] (brackets)',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      expect(result).toBe('- [Title \\[with\\] (brackets)](https://example.com){:target="_blank"}');
    });

    it('should strip pipe characters from text to prevent markdown table issues', () => {
      const link = {
        id: '1',
        url: 'https://example.com',
        title: 'Title | with | pipes',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      expect(result).not.toContain('|');
      expect(result).toBe('- [Title - with - pipes](https://example.com){:target="_blank"}');
    });

    it('should strip angle brackets and collapse whitespace in text', () => {
      const link = {
        id: '1',
        url: 'https://example.com',
        title: '  A <script> tag\n  and   spaces  ',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      expect(result).toBe('- [A script tag and spaces](https://example.com){:target="_blank"}');
    });

    // Percent-encoding parens is not identity-preserving per RFC 3986 §2.2 and
    // can 404 a working link; kramdown handles a balanced pair unaided.
    it('should emit a URL with balanced parentheses verbatim', () => {
      const link = {
        id: '1',
        url: 'https://example.com/page_(test)',
        title: 'Example',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      expect(result).toBe('- [Example](https://example.com/page_(test)){:target="_blank"}');
      expect(result).not.toContain('%28');
      expect(result).not.toContain('%29');
    });

    it('should wrap a URL in angle brackets when the bare form would break', () => {
      const unbalanced = BlogService.formatLink({
        url: 'https://example.com/page_(test',
        title: 'Example',
      });
      expect(unbalanced).toBe('- [Example](<https://example.com/page_(test>){:target="_blank"}');

      const spaced = BlogService.formatLink({
        url: 'https://example.com/a b',
        title: 'Example',
      });
      expect(spaced).toBe('- [Example](<https://example.com/a b>){:target="_blank"}');
    });

    it('should use description as link text when present', () => {
      const link = {
        id: '1',
        url: 'https://example.com',
        title: 'Example Title',
        description: 'A concise summary of the article about testing',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      expect(result).toBe('- [A concise summary of the article about testing](https://example.com){:target="_blank"}');
    });

    it('should fall back to selectedText when description is absent', () => {
      const link = {
        id: '1',
        url: 'https://example.com',
        title: 'Example Title',
        selectedText: 'Selected text here',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      expect(result).toBe('- [Selected text here](https://example.com){:target="_blank"}');
    });

    it('should fall back to title when both description and selectedText are absent', () => {
      const link = {
        id: '1',
        url: 'https://example.com',
        title: 'Example Title',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      expect(result).toBe('- [Example Title](https://example.com){:target="_blank"}');
    });
  });

  describe('getSavedLinks', () => {
    it('should return empty array when no links saved', async () => {
      vi.mocked(chrome.storage.local.get).mockResolvedValue({} as { [key: string]: unknown });

      const result = await BlogService.getSavedLinks();
      expect(result).toEqual([]);
    });

    it('should return saved links from storage', async () => {
      const mockLinks = [
        { id: '1', url: 'https://test.com', title: 'Test', category: 'test', timestamp: 123 },
      ];
      vi.mocked(chrome.storage.local.get).mockResolvedValue({ savedLinks: mockLinks } as { [key: string]: unknown });

      const result = await BlogService.getSavedLinks();
      expect(result).toEqual(mockLinks);
    });
  });

  describe('saveLinkLocally', () => {
    it('should call storage.local.set with the new link', async () => {
      vi.mocked(chrome.storage.local.get).mockResolvedValue({ savedLinks: [] } as { [key: string]: unknown });

      const newLink = {
        id: '2',
        url: 'https://new.com',
        title: 'New Link',
        category: 'test',
        timestamp: 200,
      };

      await BlogService.saveLinkLocally(newLink);

      expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
      const setCall = vi.mocked(chrome.storage.local.set).mock.calls[0][0] as { savedLinks: unknown[] };
      expect(setCall.savedLinks).toContainEqual(newLink);
    });
  });

  describe('checkLocalAi', () => {
    it('should report the sidecar as available when it answers', async () => {
      vi.mocked(global.fetch).mockResolvedValue({ ok: true } as Response);

      await expect(BlogService.checkLocalAi()).resolves.toBe(true);
    });

    // The sidecar runs on one machine; everywhere else this has to be a quiet
    // false rather than an error the UI has to explain.
    it('should report false rather than throwing when the sidecar is absent', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(BlogService.checkLocalAi()).resolves.toBe(false);
    });
  });

  describe('analyzeLink', () => {
    it('should call backend analyze-link endpoint and return result', async () => {
      const mockResponse = { category: 'development', description: 'A guide to testing practices' };
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      const result = await BlogService.analyzeLink('https://example.com', 'Test Article', 'some selected text');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/analyze-link',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com', title: 'Test Article', selectedText: 'some selected text', forceRefresh: false }),
        })
      );
      expect(result).toEqual(mockResponse);
    });

    it('should pass forceRefresh through to the backend when regenerating', async () => {
      const mockResponse = { category: 'development', description: 'Regenerated description', cached: false };
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);

      await BlogService.analyzeLink('https://example.com', 'Test Article', 'some selected text', true);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/analyze-link',
        expect.objectContaining({
          body: JSON.stringify({ url: 'https://example.com', title: 'Test Article', selectedText: 'some selected text', forceRefresh: true }),
        })
      );
    });

    it('should return null when backend returns non-ok response', async () => {
      vi.mocked(global.fetch).mockResolvedValue({
        ok: false,
        status: 503,
      } as Response);

      const result = await BlogService.analyzeLink('https://example.com', 'Test');
      expect(result).toBeNull();
    });

    it('should return null when fetch throws', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));

      const result = await BlogService.analyzeLink('https://example.com', 'Test');
      expect(result).toBeNull();
    });
  });
});

describe('analyzeLink timeout budget', () => {
  // The sidecar takes ~13s on a URL it has not analysed before. A 3s budget
  // aborted every first-time analysis and returned null, which the form could
  // only read as "no suggestion" — links then published with the raw page
  // title. Pin the budget behaviourally, not by asserting the constant.
  it('waits out a slow first-time analysis instead of aborting it', async () => {
    vi.useFakeTimers();
    try {
      const payload = { category: 'ai', description: 'A real suggestion' };

      vi.mocked(global.fetch).mockImplementation((_url, init) =>
        new Promise((resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new DOMException('aborted', 'AbortError'))),
          );
          setTimeout(() => resolve({ ok: true, json: () => Promise.resolve(payload) } as Response), 12_700);
        }),
      );

      const pending = BlogService.analyzeLink('https://example.com/new', 'Fresh link');
      await vi.advanceTimersByTimeAsync(12_700);

      await expect(pending).resolves.toEqual(payload);
    } finally {
      vi.useRealTimers();
    }
  });
});
