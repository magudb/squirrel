/**
 * GitHub reader/writer for the blog repository.
 *
 * Plain `fetch`, no SDK. The hard problem here is the non-fast-forward retry,
 * which needs the whole change set rebuilt from a freshly read head — something
 * a generic retry plugin cannot express — so a client library would buy nothing.
 *
 * Two APIs are used and their path handling is inverted: the Contents API takes
 * the path in the URL (encoded), the Git Data API takes it in the JSON body
 * (raw). The real draft filenames contain spaces and colons, so getting this
 * backwards produces files literally named with `%20`.
 *
 * Configuration is read inside each call rather than at module load so that
 * importing this module in a test does not require a token.
 */

import { githubConfig } from './env.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`GitHub ${status}: ${body}`);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }

  /**
   * A lost race for the branch tip. Verified live: GitHub answers 422 with
   * "Update is not a fast forward" here, not the 409 the reference implies.
   */
  get isConflict(): boolean {
    return this.status === 422 && /not a fast forward/i.test(this.body);
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

interface GhRequest {
  method?: string;
  /** Serialised as JSON; presence also sets the Content-Type. */
  body?: unknown;
  accept?: string;
  signal?: AbortSignal;
}

async function request(path: string, req: GhRequest = {}): Promise<Response> {
  const { token } = githubConfig();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: req.accept ?? 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    // GitHub rejects any request without a User-Agent with a 403.
    'User-Agent': 'squirrel-server',
  };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API}${path}`, {
    method: req.method ?? 'GET',
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: req.signal,
  });

  if (!res.ok) throw new GitHubError(res.status, await res.text());
  return res;
}

async function json<T>(path: string, req: GhRequest = {}): Promise<T> {
  const res = await request(path, req);
  return (await res.json()) as T;
}

function target(): { base: string; branch: string } {
  const { owner, repo, branch } = githubConfig();
  return { base: `/repos/${owner}/${repo}`, branch };
}

/** Contents API: the path lives in the URL, but its separators must survive. */
function urlPath(path: string): string {
  return encodeURIComponent(path).replace(/%2F/g, '/');
}

/**
 * The corpus contains Danish letters and emoji. `atob` alone yields a Latin-1
 * binary string and mangles both; GitHub also wraps its base64 at 60 columns,
 * which some decoders refuse.
 */
function decodeBase64Utf8(b64: string): string {
  return Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
}

interface ContentsFile {
  sha: string;
  size: number;
  content: string;
  encoding: string;
}

export async function readFile(
  path: string,
  signal?: AbortSignal,
): Promise<{ sha: string; size: number; text: string }> {
  const { base, branch } = target();
  const file = await json<ContentsFile>(
    `${base}/contents/${urlPath(path)}?ref=${encodeURIComponent(branch)}`,
    { signal },
  );

  // Our files are 5-40KB so the inline base64 always arrives, but above 1MB the
  // Contents API returns an empty `content` with the real size and expects the
  // caller to fall back to the blob itself.
  if (file.content.trim() === '' && file.size > 0) {
    const raw = await request(`${base}/git/blobs/${file.sha}`, {
      accept: 'application/vnd.github.raw',
      signal,
    });
    return { sha: file.sha, size: file.size, text: await raw.text() };
  }

  return { sha: file.sha, size: file.size, text: decodeBase64Utf8(file.content) };
}

/**
 * Gates overwriting a live post, so anything other than a clean 404 must
 * propagate — a 401 from an expired token read as "absent" would let a publish
 * clobber a published file.
 */
export async function fileExists(path: string, signal?: AbortSignal): Promise<boolean> {
  const { base, branch } = target();
  try {
    await request(`${base}/contents/${urlPath(path)}?ref=${encodeURIComponent(branch)}`, {
      signal,
    });
    return true;
  } catch (err) {
    if (err instanceof GitHubError && err.isNotFound) return false;
    throw err;
  }
}

/**
 * Create a file, atomically, only if it does not already exist.
 *
 * `commitChanges` cannot express this: a Git Data tree entry silently replaces
 * whatever sits at its path, so a check-then-commit still loses the race where
 * a competing commit lands between the read of the ref and the write — no 422,
 * no conflict, the other file is just gone. Omitting `sha` on the Contents API
 * means "create", and GitHub answers 422 if the path is taken, which closes the
 * window on GitHub's side instead of ours.
 *
 * Returns the new commit sha. Throws GitHubError with status 422 when the file
 * already exists.
 */
export async function createFileIfAbsent(
  path: string,
  content: string,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  const { base, branch } = target();
  const body = await json<{ commit: { sha: string } }>(
    `${base}/contents/${urlPath(path)}`,
    {
      method: 'PUT',
      signal,
      body: {
        message,
        // The Contents API takes base64, and the corpus contains Danish letters
        // and emoji, so this must go through UTF-8 rather than a byte cast.
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch,
      },
    },
  );
  return body.commit.sha;
}

interface ContentsEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: string;
}

/** Metadata only — a directory listing never carries file content. */
export async function listDir(
  path: string,
  signal?: AbortSignal,
): Promise<Array<{ name: string; path: string; sha: string; size: number }>> {
  const { base, branch } = target();
  let entries: ContentsEntry[];
  try {
    entries = await json<ContentsEntry[]>(
      `${base}/contents/${urlPath(path)}?ref=${encodeURIComponent(branch)}`,
      { signal },
    );
  } catch (err) {
    // A directory with no files does not exist in git at all.
    if (err instanceof GitHubError && err.isNotFound) return [];
    throw err;
  }
  return entries
    .filter((e) => e.type === 'file')
    .map((e) => ({ name: e.name, path: e.path, sha: e.sha, size: e.size }));
}

export type Change = { path: string; content: string } | { path: string; delete: true };

type TreeEntry =
  | { path: string; mode: '100644'; type: 'blob'; content: string }
  | { path: string; mode: '100644'; type: 'blob'; sha: null };

/**
 * One commit containing every change, applied atomically. Publishing is
 * therefore a single commit that both creates the post and removes the draft,
 * which is what the blog's announce job needs to see.
 */
export async function commitChanges(
  changes: Change[],
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  const { base, branch } = target();

  const ref = await json<{ object: { sha: string } }>(
    `${base}/git/ref/heads/${branch}`, // singular on read, plural on write
    { signal },
  );
  const baseCommitSha = ref.object.sha;

  const baseCommit = await json<{ tree: { sha: string } }>(
    `${base}/git/commits/${baseCommitSha}`,
    { signal },
  );

  // Paths are raw here. Inlining `content` skips a separate blob round trip;
  // a deletion must carry an explicit `sha: null`, because JSON.stringify drops
  // `undefined` and the entry would then silently leave the file in place.
  const tree: TreeEntry[] = changes.map((change) =>
    'delete' in change
      ? { path: change.path, mode: '100644', type: 'blob', sha: null }
      : { path: change.path, mode: '100644', type: 'blob', content: change.content },
  );

  const newTree = await json<{ sha: string }>(`${base}/git/trees`, {
    method: 'POST',
    // Without base_tree the commit would contain only these entries, i.e. it
    // would delete the rest of the repository.
    body: { base_tree: baseCommit.tree.sha, tree },
    signal,
  });

  const commit = await json<{ sha: string }>(`${base}/git/commits`, {
    method: 'POST',
    body: {
      message,
      tree: newTree.sha,
      parents: [baseCommitSha],
      author: { name: 'Squirrel', email: 'squirrel@users.noreply.github.com' },
    },
    signal,
  });

  // force stays false: it is free compare-and-swap against anything pushed
  // since the ref was read, and forcing would discard someone's real work.
  await request(`${base}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: { sha: commit.sha, force: false },
    signal,
  });

  return commit.sha;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Commit with a bounded retry on a lost ref race.
 *
 * `build` runs again from scratch on every attempt, because a conflict means
 * the commit's parent is stale: re-sending the same commit fails identically
 * forever. Rebuilding re-reads the file as it now stands and re-applies the
 * changes on top of whatever landed in the meantime.
 *
 * `build` returning null means there is nothing to do, and nothing is committed.
 */
export async function commitWithRetry(
  build: () => Promise<{ changes: Change[]; message: string } | null>,
  attempts = 3,
  signal?: AbortSignal,
): Promise<string | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const built = await build();
    if (built === null) return null;
    try {
      return await commitChanges(built.changes, built.message, signal);
    } catch (err) {
      if (!(err instanceof GitHubError) || !err.isConflict) throw err;
      lastError = err;
      await delay(150 * 2 ** attempt + Math.random() * 100, signal);
    }
  }
  throw lastError;
}

/**
 * Recent commits touching a path, newest first. Used to settle the one case the
 * rest of the design cannot: an ambiguous failure around the ref update, where
 * the flush id stamped in the commit message answers "did mine land?".
 */
export async function commitsTouching(
  path: string,
  perPage = 5,
  signal?: AbortSignal,
): Promise<Array<{ sha: string; message: string }>> {
  const { base, branch } = target();
  const query = new URLSearchParams({ path, sha: branch, per_page: String(perPage) });
  const commits = await json<Array<{ sha: string; commit: { message: string } }>>(
    `${base}/commits?${query.toString()}`,
    { signal },
  );
  return commits.map((c) => ({ sha: c.sha, message: c.commit.message }));
}
