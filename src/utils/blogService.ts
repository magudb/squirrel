import { Category, Link, BlogPost, AnalyzeLinkResponse } from '../types';

const BACKEND_URL = 'http://localhost:3001';
const FETCH_TIMEOUT_MS = 5000;

// Custom error for backend connectivity issues
export class BackendError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'BackendError';
  }
}

async function fetchWithTimeout(url: string, options?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new BackendError('Backend not responding (timeout)');
    }
    throw new BackendError('Backend not reachable — is the service running?');
  } finally {
    clearTimeout(timeout);
  }
}

export class BlogService {
  static async checkHealth(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(`${BACKEND_URL}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  static async getCategories(): Promise<Category[]> {
    const response = await fetchWithTimeout(`${BACKEND_URL}/api/categories`);
    if (!response.ok) {
      throw new BackendError(`Failed to fetch categories (${response.status})`);
    }
    return await response.json();
  }

  static async analyzeLink(url: string, title: string, selectedText?: string): Promise<AnalyzeLinkResponse | null> {
    try {
      const response = await fetchWithTimeout(`${BACKEND_URL}/api/analyze-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, title, selectedText }),
      }, 30000);

      if (!response.ok) return null;
      const data = await response.json();
      // Backend returns { category: null, description: null } on analysis failure
      if (!data.category && !data.description) return null;
      return data;
    } catch {
      // AI analysis is non-critical, return null silently
      return null;
    }
  }

  static async findCuratedInsightsFiles(): Promise<BlogPost[]> {
    const response = await fetchWithTimeout(`${BACKEND_URL}/api/blog-files`);
    if (!response.ok) {
      throw new BackendError(`Failed to fetch blog files (${response.status})`);
    }
    return await response.json();
  }

  static formatLink(link: Link): string {
    const sanitizeMarkdown = (text: string): string => {
      return text.replace(/\|/g, '-').replace(/[\[\]()]/g, '\\$&');
    };
    const encodeUrlParens = (url: string): string => {
      return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
    };
    const displayText = sanitizeMarkdown(link.description?.trim() || link.selectedText?.trim() || link.title);
    const sanitizedUrl = encodeUrlParens(link.url);
    return `- [${displayText}](${sanitizedUrl}){:target="_blank"}`;
  }

  static async addLinkToBlog(link: Link, blogFile: BlogPost): Promise<void> {
    const response = await fetchWithTimeout(`${BACKEND_URL}/api/add-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link, blogFile }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new BackendError(body.error || `Failed to add link (${response.status})`, response.status);
    }

    const result = await response.json();
    if (!result.success) {
      throw new BackendError(result.error || 'Backend reported failure');
    }
  }

  static async saveLinkLocally(link: Link): Promise<void> {
    const links = await this.getSavedLinks();
    links.push(link);
    await chrome.storage.local.set({ savedLinks: links });
  }

  static async getSavedLinks(): Promise<Link[]> {
    const result = await chrome.storage.local.get(['savedLinks']);
    return result.savedLinks || [];
  }
}
