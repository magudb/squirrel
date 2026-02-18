import { Category, Link, BlogPost } from '../types';

const BACKEND_URL = 'http://localhost:3001';

export class BlogService {
  static async getCategories(): Promise<Category[]> {
    try {
      const response = await fetch(`${BACKEND_URL}/api/categories`);
      if (!response.ok) throw new Error('Failed to fetch categories');
      return await response.json();
    } catch (error) {
      console.error('Error fetching categories, using fallback:', error);
      // Fallback categories if backend is not available
      return [
        { id: "favorites", name: "My favorites", anchor: "favorites" },
        { id: "agile", name: "Agile, Leadership and Product", anchor: "agile" },
        { id: "development", name: "Architecture, Development & Software development practices", anchor: "development" },
        { id: "devops", name: "DevOps, Observability & Security", anchor: "devops" },
        { id: "tools", name: "Tools and things from Github", anchor: "tools" },
        { id: "ai", name: "AI, LLM & Machine Learning", anchor: "ai" }
      ];
    }
  }

  static async findCuratedInsightsFiles(): Promise<BlogPost[]> {
    try {
      const response = await fetch(`${BACKEND_URL}/api/blog-files`);
      if (!response.ok) throw new Error('Failed to fetch blog files');
      return await response.json();
    } catch (error) {
      console.error('Error fetching blog files, using fallback:', error);
      // Fallback files if backend is not available
      return [
        {
          path: '/home/mlu/Documents/project/magudb.github.io/_drafts/2025-06-20-on AI.md',
          filename: '2025-06-20-on AI.md',
          title: 'The Paradox of AI Coding Assistants'
        },
        {
          path: '/home/mlu/Documents/project/magudb.github.io/_drafts/2025-08-31-Tech Digest: Fall 2025 Essential Reads for Tech Professionals.md',
          filename: '2025-08-31-Tech Digest: Fall 2025 Essential Reads for Tech Professionals.md',
          title: 'Tech Digest: Fall 2025 Essential Reads for Tech Professionals'
        }
      ];
    }
  }

  static formatLink(link: Link): string {
    // Sanitize markdown special characters to prevent injection
    const sanitizeMarkdown = (text: string): string => {
      return text.replace(/\|/g, '-').replace(/[\[\]()]/g, '\\$&');
    };
    // Encode parentheses in URLs to prevent markdown from breaking
    const encodeUrlParens = (url: string): string => {
      return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
    };
    const displayText = sanitizeMarkdown(link.description?.trim() || link.selectedText?.trim() || link.title);
    const sanitizedUrl = encodeUrlParens(link.url);
    return `- [${displayText}](${sanitizedUrl}){:target="_blank"}`;
  }

  static async addLinkToBlog(link: Link, blogFile: BlogPost): Promise<boolean> {
    try {
      // Try to use backend API first
      const response = await fetch(`${BACKEND_URL}/api/add-link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ link, blogFile })
      });

      if (response.ok) {
        const result = await response.json();
        return result.success;
      } else {
        console.warn('Backend API failed, falling back to background script');
        // Fallback to background script
        const bgResponse = await chrome.runtime.sendMessage({
          action: 'addLinkToBlog',
          link,
          blogFile
        });
        return bgResponse.success;
      }
    } catch (error) {
      console.error('Error adding link to blog:', error);
      try {
        // Final fallback to background script
        const bgResponse = await chrome.runtime.sendMessage({
          action: 'addLinkToBlog',
          link,
          blogFile
        });
        return bgResponse.success;
      } catch (bgError) {
        console.error('Background script also failed:', bgError);
        return false;
      }
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