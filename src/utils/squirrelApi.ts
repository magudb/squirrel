import type {
  Category,
  CreateDraftResponse,
  CreateLinkResponse,
  DraftContent,
  DraftRef,
  FlushResult,
  LinkPatch,
  NewDraft,
  NewLink,
  PendingLink,
  PublishMeta,
  PublishResult,
  SquirrelConfig,
  StatusResponse,
  TargetDraft,
} from '../types';

export type { SquirrelConfig };

/**
 * The client for the hosted Squirrel service.
 *
 * Two independent gates sit between this code and the service: the extension
 * page CSP (`connect-src`, enforced in the renderer) and the host permission
 * (enforced in the network stack). Only the second one is a security boundary,
 * and only the second one can be granted at runtime — hence `setConfig`, which
 * asks for it before it will store anything.
 */

const CONFIG_KEY = 'squirrelConfig';

const TIMEOUT_MS = 15_000;
/** Flush and publish both make GitHub round trips before they answer. */
const SLOW_TIMEOUT_MS = 20_000;

export class SquirrelApiError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'SquirrelApiError';
    this.status = status;
    this.code = code;
  }

  /**
   * Distinguishes "your token is wrong" from "the service is down" so the UI
   * can say which. Keyed on the code rather than the status because Vercel's
   * Deployment Protection also answers 401, and that has nothing to do with
   * the token the user typed.
   */
  get isUnauthorized(): boolean {
    return this.code === 'unauthorized';
  }
}

/**
 * A base URL is stored as a bare origin so that every request is built by
 * concatenation and can never end up with a doubled or missing slash. Parsing
 * is synchronous on purpose — see `setConfig`.
 */
function toOrigin(input: string): string {
  const raw = input.trim();
  if (raw === '') {
    throw new SquirrelApiError('A service URL is required', undefined, 'bad_config');
  }
  try {
    return new URL(raw).origin;
  } catch {
    throw new SquirrelApiError(
      `Not a valid service URL: ${raw}. It should look like https://squirrel.vercel.app`,
      undefined,
      'bad_config',
    );
  }
}

/** A host permission covers an origin and everything under it. */
function originPattern(baseUrl: string): string {
  return `${toOrigin(baseUrl)}/*`;
}

export async function getConfig(): Promise<SquirrelConfig | null> {
  const stored = await chrome.storage.sync.get([CONFIG_KEY]);
  const config = stored[CONFIG_KEY] as Partial<SquirrelConfig> | undefined;
  if (
    config === undefined ||
    typeof config.baseUrl !== 'string' ||
    typeof config.token !== 'string' ||
    config.baseUrl === '' ||
    config.token === ''
  ) {
    return null;
  }
  return { baseUrl: config.baseUrl, token: config.token };
}

/**
 * Grants first, storage second.
 *
 * `chrome.permissions.request` needs a live user gesture and loses it across an
 * await on some Chrome versions, so it is the *first* await here and this
 * function must be called as the first await of a click handler. Storing the
 * config before the grant would leave a configuration that silently cannot
 * reach anything.
 */
export async function setConfig(cfg: SquirrelConfig): Promise<void> {
  const origins = [originPattern(cfg.baseUrl)];
  const token = cfg.token.trim();
  if (token === '') {
    throw new SquirrelApiError('A token is required', undefined, 'bad_config');
  }

  let granted: boolean;
  try {
    granted = await chrome.permissions.request({ origins });
  } catch (error) {
    throw new SquirrelApiError(
      `Chrome refused the permission request for ${origins[0]}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      undefined,
      'permission_denied',
    );
  }
  if (!granted) {
    throw new SquirrelApiError(
      `Squirrel needs permission to reach ${origins[0]} and it was declined. Save again and choose Allow.`,
      undefined,
      'permission_denied',
    );
  }

  await chrome.storage.sync.set({
    [CONFIG_KEY]: { baseUrl: toOrigin(cfg.baseUrl), token } satisfies SquirrelConfig,
  });
}

export async function hasHostPermission(baseUrl: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [originPattern(baseUrl)] });
}

async function requireConfig(): Promise<SquirrelConfig> {
  const config = await getConfig();
  if (config === null) {
    throw new SquirrelApiError(
      'Squirrel is not configured yet — set the service URL and token first.',
      undefined,
      'not_configured',
    );
  }
  return config;
}

interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

async function send(config: SquirrelConfig, path: string, options: CallOptions): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${config.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new SquirrelApiError(
        `The service did not answer within ${Math.round(timeoutMs / 1000)}s.`,
        undefined,
        'timeout',
      );
    }
    // A rejected fetch here is a CSP block, a missing host permission or a DNS
    // failure, and the three are indistinguishable from this side.
    throw new SquirrelApiError(
      `Could not reach ${config.baseUrl}. Check the service URL and that the host permission is granted.`,
      undefined,
      'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vercel's Deployment Protection intercepts preview deployments with an HTML
 * login page, which arrives as a perfectly ordinary response whose body just
 * happens not to be JSON. Named explicitly, because the default symptom is an
 * unreadable parse error pointing at nothing.
 */
function nonJsonError(response: Response, body: string): SquirrelApiError {
  if (/^\s*<(?:!doctype|html)\b/i.test(body)) {
    return new SquirrelApiError(
      'The service returned an HTML page instead of JSON. Vercel Deployment Protection is most likely enabled — use the production URL, or turn protection off for the API.',
      response.status,
      'not_json',
    );
  }
  return new SquirrelApiError(
    `The service returned a non-JSON response (HTTP ${response.status}).`,
    response.status,
    'not_json',
  );
}

function failureFor(response: Response, body: unknown): SquirrelApiError {
  const shape = (body ?? {}) as { error?: unknown; code?: unknown };
  const code = typeof shape.code === 'string' ? shape.code : undefined;
  const message =
    typeof shape.error === 'string' && shape.error !== ''
      ? shape.error
      : `Request failed (HTTP ${response.status})`;
  if (response.status === 401) {
    return new SquirrelApiError(
      'Rejected by the service — check the token in Squirrel settings.',
      401,
      'unauthorized',
    );
  }
  return new SquirrelApiError(message, response.status, code);
}

async function call<T>(path: string, options: CallOptions = {}): Promise<T> {
  const config = await requireConfig();
  const response = await send(config, path, options);
  const text = await response.text();

  let body: unknown;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      throw nonJsonError(response, text);
    }
  }

  if (!response.ok) {
    throw failureFor(response, body);
  }
  // 204, as DELETE answers. Callers of an empty route type it as void.
  return body as T;
}

export const SquirrelApi = {
  /** Unauthenticated by design: it separates "wrong URL" from "wrong token". */
  async health(): Promise<boolean> {
    try {
      const { ok } = await call<{ ok: boolean }>('/api/health');
      return ok === true;
    } catch {
      return false;
    }
  },

  getCategories(): Promise<Category[]> {
    return call<Category[]>('/api/categories');
  },

  getStatus(): Promise<StatusResponse> {
    return call<StatusResponse>('/api/status');
  },

  /** One page of 500 — the server's own maximum, and its default of 100 would
   *  silently hide the tail of a buffer that grew while flushes were failing. */
  async listLinks(): Promise<PendingLink[]> {
    const { links } = await call<{ links: PendingLink[]; total: number }>('/api/links?limit=500');
    return links;
  },

  /** The key is the extension's local link id, so a queue retry cannot double-enqueue. */
  createLink(link: NewLink, idempotencyKey: string): Promise<CreateLinkResponse> {
    return call<CreateLinkResponse>('/api/links', {
      method: 'POST',
      body: link,
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  },

  async updateLink(id: string, patch: LinkPatch): Promise<PendingLink> {
    const { link } = await call<{ link: PendingLink }>(`/api/links/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    });
    return link;
  },

  async deleteLink(id: string): Promise<void> {
    await call<void>(`/api/links/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /** Always 200 when the request was well formed; read `ok` and `reason`. */
  flush(): Promise<FlushResult> {
    return call<FlushResult>('/api/flush', { method: 'POST', timeoutMs: SLOW_TIMEOUT_MS });
  },

  listDrafts(): Promise<DraftRef[]> {
    return call<DraftRef[]>('/api/drafts');
  },

  /**
   * One draft with its body.
   *
   * The listing carries no content — it would be a GitHub read per draft on
   * every popup open — so the metadata review fetches the one draft it is about
   * to publish. 404 arrives as a `SquirrelApiError` with that status when the
   * draft has been published or renamed since the listing was cached.
   */
  async getDraft(id: string): Promise<DraftContent> {
    const draft = await call<DraftContent>(`/api/drafts?id=${encodeURIComponent(id)}`);
    // A deployment older than `?id=` ignores the parameter and answers with the
    // listing — an array, from which `content` reads as undefined. Caught here
    // rather than downstream because every check further on phrases its failure
    // as a fact about the draft ("no front matter"), and the draft is fine.
    if (typeof draft?.content !== 'string') {
      throw new SquirrelApiError(
        'The service returned no draft body. This deployment predates the metadata review — ' +
          'deploy the service and try again.',
        undefined,
        'draft_content_missing',
      );
    }
    return draft;
  },

  /**
   * Creates the next draft file and commits it to master.
   *
   * Slow timeout for the same reason flush and publish use it: the service does
   * a GitHub write round trip before it answers. 409 (the destination already
   * exists) and 400 (a title with no usable slug) arrive as `SquirrelApiError`
   * with those statuses, and callers are expected to say which one happened —
   * "already there" is not a failure the user should read as breakage.
   */
  createDraft(draft: NewDraft): Promise<CreateDraftResponse> {
    return call<CreateDraftResponse>('/api/drafts', {
      method: 'POST',
      body: draft,
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  },

  async getTarget(): Promise<TargetDraft | null> {
    const { target } = await call<{ target: TargetDraft | null }>('/api/target');
    return target;
  },

  async setTarget(draftId: string): Promise<TargetDraft> {
    const { target } = await call<{ target: TargetDraft }>('/api/target', {
      method: 'PUT',
      body: { draftId },
    });
    return target;
  },

  /**
   * `meta` rewrites the post's front matter inside the same commit that creates
   * it. The service normalises and re-validates every value; a rejection there
   * is a 400 naming the field, not a half-written post.
   */
  publish(input: {
    draftId: string;
    slug?: string;
    prune?: boolean;
    meta?: PublishMeta;
  }): Promise<PublishResult> {
    return call<PublishResult>('/api/publish', {
      method: 'POST',
      body: input,
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  },
};
