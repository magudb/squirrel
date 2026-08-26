import { Link, AnalyzeLinkResponse } from '../types';

/**
 * What is left of the local Express backend.
 *
 * Links are owned by the hosted service now (`squirrelApi.ts`); this module is
 * an optional AI sidecar plus the local clipboard history. Nothing here may be
 * load-bearing: the sidecar runs on exactly one machine, and the extension has
 * to work on every other one. So both network calls give up fast and fail to
 * `null`/`false` rather than throwing.
 */

const BACKEND_URL = 'http://localhost:3001';
const FETCH_TIMEOUT_MS = 3000;

/**
 * The sidecar shells out to the `claude` CLI, which takes ~13s on a URL it has
 * not seen and ~5ms on one it has (30-day cache). The 3s default aborts every
 * first-time analysis, which looks exactly like "the AI returned nothing" and
 * silently publishes the raw page title instead of a description.
 */
export const ANALYZE_TIMEOUT_MS = 30_000;

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
      throw new BackendError('Local AI sidecar not responding (timeout)');
    }
    throw new BackendError('Local AI sidecar not reachable — is it running?');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * kramdown verdicts, ported from `server/api/_lib/markdown.ts` so the bullet the
 * user copies to the clipboard is byte-identical to the one a flush writes.
 * A `|` turns the whole list item into a table; an unbalanced `<` or `>`
 * destroys the link; `\[` renders as `[`, so escaping the pair is output-
 * identical to the 15k bullets already in the corpus. Parentheses need no
 * escaping at all — 24 real link texts contain them.
 */
function sanitizeText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '-')
    .replace(/[<>]/g, '')
    .replace(/[\[\]]/g, '\\$&');
}

/**
 * kramdown handles balanced parens in a bare destination, and percent-encoding
 * them is not guaranteed equivalent per RFC 3986 §2.2 — it can 404 a working
 * link. The angle form is the escape hatch, used only when the bare form would
 * actually break.
 */
function destination(url: string): string {
  const trimmed = url.trim();
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
  return /[\s<>]/.test(trimmed) || !balanced ? `<${trimmed}>` : trimmed;
}

export class BlogService {
  /** Cheap probe so the UI can offer AI suggestions only when they can arrive. */
  static async checkLocalAi(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(`${BACKEND_URL}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  static async analyzeLink(url: string, title: string, selectedText?: string, forceRefresh = false): Promise<AnalyzeLinkResponse | null> {
    try {
      const response = await fetchWithTimeout(
        `${BACKEND_URL}/api/analyze-link`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, title, selectedText, forceRefresh }),
        },
        ANALYZE_TIMEOUT_MS,
      );

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

  /** The kramdown IAL must touch the closing paren: one space before `{:` and
   *  kramdown emits the literal `{:target="_blank"}` into the page. */
  static formatLink(link: { description?: string; selectedText?: string; title: string; url: string }): string {
    const text = sanitizeText(
      (link.description ?? '').trim() || (link.selectedText ?? '').trim() || link.title,
    );
    return `- [${text}](${destination(link.url)}){:target="_blank"}`;
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
