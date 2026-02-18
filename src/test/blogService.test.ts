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

    it('should sanitize markdown special characters in text', () => {
      const link = {
        id: '1',
        url: 'https://example.com',
        title: 'Title [with] (brackets)',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      expect(result).toContain('\\[');
      expect(result).toContain('\\]');
      expect(result).toContain('\\(');
      expect(result).toContain('\\)');
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

    it('should handle URLs with parentheses by encoding them', () => {
      const link = {
        id: '1',
        url: 'https://example.com/page_(test)',
        title: 'Example',
        category: 'test',
        timestamp: Date.now(),
      };

      const result = BlogService.formatLink(link);
      // URL parentheses should be encoded to prevent markdown breaking
      expect(result).toContain('https://example.com/page_%28test%29');
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

  describe('getCategories', () => {
    it('should fetch categories from backend when available', async () => {
      const mockCategories = [{ id: 'test', name: 'Test Category', anchor: 'test' }];
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockCategories),
      } as Response);

      const result = await BlogService.getCategories();
      expect(result).toEqual(mockCategories);
    });

    it('should return fallback categories when backend fails', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));

      const result = await BlogService.getCategories();
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('name');
    });
  });
});
