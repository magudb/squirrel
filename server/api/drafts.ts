import { GitHubError, createFileIfAbsent, fileExists, listDir, readFile } from './_lib/github.js';
import { HttpError, methods, readJsonBody, withApiAuth } from './_lib/http.js';
import {
  DRAFTS_DIR,
  assertWritablePath,
  decodeDraftId,
  draftPathFor,
  draftRefFromFile,
  parseIsoDate,
} from './_lib/paths.js';
import { setTarget } from './_lib/store.js';
import { newDraftBody, normalizeDraftTitle } from './_lib/template.js';
import type { DraftRef, TargetDraft } from './_lib/types.js';

/** A directory listing carries no content, so the front matter costs one read per file. */
const READ_CONCURRENCY = 6;

/** Both extensions are in use: the legacy drafts in this repo are `.markdown`. */
const MARKDOWN = /\.(md|markdown)$/i;

/**
 * Bounded rather than a bare `Promise.all` over the listing: the reads all go to
 * the same host under one PAT, and a directory that grows to fifty drafts would
 * otherwise open fifty sockets at once and earn a secondary rate limit.
 */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Curated drafts first, then newest by filename — every draft is date-prefixed,
 * so a plain descending string compare is the date order. Compared by code unit
 * rather than by locale so two deployments cannot disagree about the order.
 */
function byCuratedThenNewest(a: DraftRef, b: DraftRef): number {
  if (a.curated !== b.curated) return a.curated ? -1 : 1;
  if (a.filename === b.filename) return 0;
  return a.filename < b.filename ? 1 : -1;
}

interface DraftContent {
  draft: DraftRef;
  /** The file exactly as it sits on master, front matter included. */
  content: string;
}

/**
 * One draft with its body — what a pre-publish metadata review reads.
 *
 * The listing deliberately carries no content (a directory listing does not
 * include it, and fetching every body to render a picker would be one GitHub
 * read per draft on every popup open), so a client that needs the actual links
 * asks for one draft by id.
 *
 * The id is resolved the same way `POST /api/publish` resolves it: decoded to a
 * bare filename, then matched against a freshly fetched listing. The listing is
 * the allowlist, so no caller string ever reaches a read path.
 */
async function readDraft(rawId: unknown): Promise<DraftContent> {
  if (typeof rawId !== 'string') {
    // Vercel hands a repeated query parameter over as an array.
    throw new HttpError(400, 'id must be a single draft id', 'bad_draft_id');
  }
  const filename = decodeDraftId(rawId);
  const entry = (await listDir(DRAFTS_DIR)).find((candidate) => candidate.name === filename);
  if (entry === undefined) {
    throw new HttpError(404, `No such draft: ${filename}`, 'draft_not_found');
  }
  const file = await readFile(entry.path);
  return { draft: draftRefFromFile(entry.name, file.text), content: file.text };
}

interface CreateDraftResponse {
  draft: DraftRef;
  commitSha: string;
  target?: TargetDraft;
}

/**
 * The draft picker for the extension, and the one write that creates a draft.
 *
 * Clients only ever see the opaque `id` — `PUT /api/target` and
 * `POST /api/publish` both resolve it back against a fresh listing, so no
 * caller-supplied string ever reaches a commit as a path. `POST` is the same
 * deal in reverse: the caller sends a title and a date, never a path, and the
 * filename is built server-side and pushed through `assertWritablePath` before
 * anything is committed.
 */
export default withApiAuth(
  methods({
    GET: async (req, res) => {
      // `?id=` asks for one draft and its body; no id at all is the picker.
      // Optional-chained because the picker is the hottest endpoint here and a
      // request object without a `query` at all should not turn it into a 500.
      const id = req.query?.id;
      if (id !== undefined) {
        res.status(200).json(await readDraft(id));
        return;
      }

      const entries = (await listDir(DRAFTS_DIR)).filter((entry) => MARKDOWN.test(entry.name));
      const drafts = await mapBounded(entries, READ_CONCURRENCY, async (entry) => {
        // A draft with no front matter at all is a real case in this repo
        // (`_drafts/2025-06-20-on AI.md`); it lists with the filename as its
        // title and `curated: false` rather than failing the whole picker.
        const file = await readFile(entry.path);
        return draftRefFromFile(entry.name, file.text);
      });

      res.status(200).json(drafts.sort(byCuratedThenNewest));
    },

    /**
     * Create the next Curated Insights draft.
     *
     * This exists so a quarter rollover does not require a checkout of the blog
     * repo: hand-creating the file is the one step that still tied the service
     * to a particular machine.
     *
     * No flush lock is taken. The commit writes a path that by construction does
     * not exist yet, so it cannot collide with a flush editing the target draft;
     * the worst interleaving is a stale-ref 422, which `commitWithRetry` already
     * handles.
     */
    POST: async (req, res) => {
      const body = readJsonBody(req);

      // Everything cheap and local first, so a bad request never reaches GitHub.
      const title = normalizeDraftTitle(body.title);
      if (body.date !== undefined && typeof body.date !== 'string') {
        throw new HttpError(400, 'date must be formatted YYYY-MM-DD', 'bad_date');
      }
      if (body.setAsTarget !== undefined && typeof body.setAsTarget !== 'boolean') {
        throw new HttpError(400, 'setAsTarget must be a boolean', 'bad_request');
      }

      const path = draftPathFor(title, parseIsoDate(body.date));
      // The path is server-built, so this can only fail if `draftPathFor` ever
      // regresses — which is exactly when a gate in front of a commit earns its
      // keep, since a Git Data tree entry takes its path raw.
      assertWritablePath(path);
      const filename = path.slice(DRAFTS_DIR.length + 1);

      if (await fileExists(path)) {
        throw new HttpError(409, `${path} already exists`, 'destination_exists');
      }

      const content = newDraftBody(title);
      // Create-if-absent rather than a Git Data tree entry. A tree entry
      // replaces whatever sits at its path, so check-then-commit still loses
      // the race where a competing commit lands between our ref read and our
      // write: no conflict is raised and the other draft is simply gone. The
      // Contents API refuses the write itself, so the window closes on
      // GitHub's side. The fileExists check above stays as the cheap path that
      // gives a clean 409 without a wasted write attempt.
      let commitSha: string;
      try {
        commitSha = await createFileIfAbsent(
          path,
          content,
          `squirrel: create draft ${filename}`,
        );
      } catch (err) {
        if (err instanceof GitHubError && err.status === 422) {
          throw new HttpError(409, `${path} already exists`, 'destination_exists');
        }
        throw err;
      }

      // Parsed back out of the body we just wrote rather than assembled by hand:
      // the title the client gets back is the one that survived YAML escaping,
      // and `curated` is proof the front matter this template emits still reads
      // as Curated Insights.
      const draft = draftRefFromFile(filename, content);
      const response: CreateDraftResponse = { draft, commitSha };

      if (body.setAsTarget === true) {
        const target: TargetDraft = { draftId: draft.id, path, setAt: Date.now() };
        try {
          // Only after the commit landed. A target pointing at a file that does
          // not exist makes every flush fail its write, and the buffer then sits
          // there filling up against a path that never appears.
          await setTarget(target);
          response.target = target;
        } catch (err) {
          // The draft is committed. Failing the whole request would tell the
          // client it was not, and its retry would 409 forever — so report the
          // draft without a target and let the client re-point with PUT /api/target.
          console.error('[squirrel] draft created but the target could not be set', err);
        }
      }

      res.status(201).json(response);
    },
  }),
);
